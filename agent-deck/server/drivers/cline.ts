/**
 * Cline CLI driver (headless).
 * Docs: https://docs.cline.bot/cline-cli/overview
 *
 *   Plan run:  cline --json -p -c <worktree> [-m model] "<prompt>"
 *   Act run:   cline --json -c <worktree> --auto-approve true [-m model] "<prompt>"
 *
 * `--json` emits newline-delimited JSON: { type: "say"|"ask", say?, ask?, text, ts, partial?, reasoning? }.
 * Headless runs are one-shot, so the dashboard enforces the plan → act checkpoint itself:
 *   plan run exits  → "plan" checkpoint with the final plan text
 *   approve         → act run seeded with the approved plan
 *   act run exits   → "review" checkpoint with the worktree diff (hub)
 */
import { spawn, type ChildProcess } from "node:child_process";
import type { AgentMode, AgentSession, Project } from "@shared/schema";
import { sh, store } from "../storage";
import { APPROVE_PLAN_PROMPT, hooks, newSession, titleFrom, type AgentDriver } from "./base";

const procs = new Map<string, ChildProcess>(); // sessionId -> running process
const bin = (p: Project) => p.clineBin || "cline";

function run(p: Project, s: AgentSession, text: string, mode: AgentMode) {
  const args = ["--json", "-c", p.worktreePath];
  if (mode === "plan") args.push("-p");
  else args.push("--auto-approve", "true");
  if (p.model) args.push("-m", p.model);
  args.push(text);

  store.patchSession(s.id, { status: "busy", mode });
  store.pushMessage(s.id, { role: "user", kind: mode, text });
  store.pushMessage(s.id, { role: "system", kind: "cmd", text: `$ ${bin(p)} ${args.slice(0, -1).join(" ")} "…"` });

  const child = spawn(bin(p), args, { cwd: p.worktreePath, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  procs.set(s.id, child);
  let buf = "";
  let lastText = "";
  let plan = "";
  let stderr = "";

  child.stdout.on("data", (d) => {
    buf += d.toString();
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("{")) continue;
      let m: any;
      try {
        m = JSON.parse(line);
      } catch {
        continue;
      }
      const id = `cl_${m.ts ?? Date.now()}`;
      const sub = m.say ?? m.ask ?? "";
      if (sub === "api_req_started" && m.text) {
        try {
          const info = JSON.parse(m.text);
          const tok = (info.tokensIn ?? 0) + (info.tokensOut ?? 0);
          store.patchSession(s.id, { tokens: s.tokens + tok, cost: s.cost + (info.cost ?? 0) });
        } catch {}
        continue;
      }
      if (m.reasoning) store.pushMessage(s.id, { id: id + "_r", role: "assistant", kind: "reasoning", text: m.reasoning });
      if (!m.text) continue;
      if (sub === "plan_mode_respond") {
        let t = m.text;
        try {
          t = JSON.parse(m.text).response ?? t;
        } catch {}
        plan = t;
        store.pushMessage(s.id, { id, role: "assistant", kind: "plan", text: t });
      } else if (sub === "tool" || sub === "command" || sub === "command_output" || sub === "use_mcp_server") {
        store.pushMessage(s.id, { id, role: "tool", kind: `tool:${sub}`, text: m.text.slice(0, 2000) });
      } else {
        lastText = m.text;
        store.pushMessage(s.id, { id, role: "assistant", kind: sub || "text", text: m.text });
      }
    }
  });
  child.stderr.on("data", (d) => (stderr += d.toString()));

  child.on("error", (e) => {
    procs.delete(s.id);
    store.patchSession(s.id, { status: "error" });
    store.pushMessage(s.id, { role: "system", kind: "error", text: `failed to start ${bin(p)}: ${e.message}` });
    store.log("error", `${p.name}: Cline CLI failed to start — ${e.message}`, p.id);
  });

  child.on("close", async (code) => {
    procs.delete(s.id);
    const cur = store.session(s.id);
    if (!cur || cur.status === "done") return;
    if (code !== 0 && code !== null) {
      store.patchSession(s.id, { status: "error" });
      store.pushMessage(s.id, { role: "system", kind: "error", text: `cline exited ${code}\n${stderr.slice(-1500)}` });
      store.log("error", `${p.name}: Cline exited with code ${code}`, p.id);
      return;
    }
    if (mode === "plan") {
      store.patchSession(s.id, { status: "awaiting" });
      store.addCheckpoint({ projectId: p.id, sessionId: s.id, kind: "plan", title: `Plan ready: ${s.title}`, body: plan || lastText || "(no plan text)", source: "cline" });
      store.log("warn", `${p.name}: Cline plan awaiting approval`, p.id);
    } else {
      store.patchSession(s.id, { status: "idle" });
      await hooks.onActFinished(p, cur);
    }
  });
}

export const clineDriver: AgentDriver = {
  async connect(p) {
    store.connections[p.id] = { projectId: p.id, state: "connecting", detail: `checking ${bin(p)}`, checkedAt: Date.now() };
    const r = await sh(`${bin(p)} --version`, p.worktreePath, 10_000);
    store.connections[p.id] =
      r.code === 0
        ? { projectId: p.id, state: "connected", detail: "CLI available", version: r.stdout.trim().split("\n")[0], checkedAt: Date.now() }
        : { projectId: p.id, state: "disconnected", detail: `${bin(p)} not found — npm i -g cline`, checkedAt: Date.now() };
    store.changed(false);
  },
  disconnect() {},

  async startSession(p, text, mode, title) {
    const s = newSession(p, title ?? titleFrom(text), mode);
    run(p, s, text, mode);
    store.log("info", `${p.name}: started Cline ${mode} run`, p.id);
    return s;
  },

  async sendMessage(p, s, text, mode) {
    if (procs.has(s.id)) throw new Error("Cline is still running — abort first or wait");
    const context = s.messages.filter((m) => m.role === "assistant" && m.kind !== "reasoning").slice(-3).map((m) => m.text).join("\n\n");
    run(p, s, `Continue the previous task. Context from the last run:\n${context}\n\nNew instruction:\n${text}`, mode ?? s.mode);
  },

  async abort(_p, s) {
    procs.get(s.id)?.kill("SIGINT");
    store.patchSession(s.id, { status: "idle" });
  },

  async resolve(p, cp, d) {
    const s = store.session(cp.sessionId);
    if (!s) throw new Error("session not found");
    if (cp.kind === "plan") {
      if (d.decision === "approve" || d.decision === "approve_always") run(p, s, APPROVE_PLAN_PROMPT(cp.body, d.feedback), "act");
      else if (d.decision === "revise")
        run(p, s, `Revise this plan based on reviewer feedback.\n\nPrevious plan:\n${cp.body}\n\nFeedback:\n${d.feedback ?? ""}`, "plan");
      else store.patchSession(s.id, { status: "done" });
    }
    // headless act runs are auto-approved after the plan gate; no per-tool permission prompts
  },
};
