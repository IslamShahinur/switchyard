/**
 * Demo simulator — behaves like an OpenCode/Cline agent but is scripted.
 * It performs REAL edits inside the project's git worktree (after approval), so
 * tsc/eslint diagnostics, git status and review diffs all reflect actual changes.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { AgentMode, AgentSession, Checkpoint, Diagnostic, Project, ResolveCheckpoint } from "@shared/schema";
import { git, sh, store } from "../storage";
import { hooks, newSession, titleFrom, type AgentDriver } from "./base";

type Step =
  | { t: "say"; text: string }
  | { t: "think"; text: string }
  | { t: "tool"; text: string }
  | { t: "edit"; file: string; title: string; apply: (old: string) => string }
  | { t: "bash"; command: string; output?: string; real?: boolean };

interface Scenario {
  think: string[];
  plan: string;
  steps: Step[];
  summary: string;
}

const scenarios: Record<string, Scenario> = {
  "checkout-v2": {
    think: ["Reading src/cart.ts and src/money.ts", "applyDiscount returns a string from toFixed — that breaks the Cents contract", "Checking callers of subtotal()"],
    plan: `## Plan — Checkout v2 discount & tax pipeline

1. **Fix \`applyDiscount\`** in \`src/cart.ts\` — it returns \`string\` (from \`toFixed\`) where \`Cents\` (number) is expected. Use \`Math.round\` and \`const\`.
2. **Add \`src/tax.ts\`** with \`computeTax(subtotal, rateBps)\` working in integer cents (basis points, no floats).
3. **Compose \`checkoutTotal()\`** = subtotal → discount → tax.
4. Run \`tsc --noEmit\` and eslint; expect 0 errors.

Files touched: \`src/cart.ts\`, \`src/tax.ts\` (new). No API changes for existing callers.`,
    steps: [
      { t: "say", text: "Starting implementation. First fixing the type error in applyDiscount." },
      {
        t: "edit",
        file: "src/cart.ts",
        title: "Fix applyDiscount return type",
        apply: (o) => o.replace(/export function applyDiscount[\s\S]*?\n}\n?/, `export function applyDiscount(total: Cents, pct: number): Cents {\n  const result = total - total * pct;\n  return Math.round(result);\n}\n`),
      },
      {
        t: "edit",
        file: "src/tax.ts",
        title: "Create src/tax.ts",
        apply: () => `import { Cents } from "./money";\nimport { LineItem, applyDiscount, subtotal } from "./cart";\n\n/** rate in basis points, e.g. 825 = 8.25% */\nexport function computeTax(amount: Cents, rateBps: number): Cents {\n  return Math.round((amount * rateBps) / 10_000);\n}\n\nexport function checkoutTotal(items: LineItem[], discountPct: number, rateBps: number): Cents {\n  const discounted = applyDiscount(subtotal(items), discountPct);\n  return discounted + computeTax(discounted, rateBps);\n}\n`,
      },
      { t: "bash", command: "tsc --noEmit && eslint src", real: true },
      { t: "say", text: "Typecheck and lint are clean." },
    ],
    summary: "Fixed the applyDiscount Cents contract and added an integer-cents tax pipeline (src/tax.ts).",
  },
  "auth-passkeys": {
    think: ["Inspecting src/auth.ts session model", "Passkeys need a challenge store + assertion verifier"],
    plan: `## Plan — Passkey (WebAuthn) login

1. Add \`src/passkey.ts\`: challenge generation, \`verifyAssertion()\` stub with origin + rpId checks.
2. Extend \`Session\` with \`method: "password" | "passkey"\`.
3. Typecheck after each step.`,
    steps: [
      { t: "tool", text: "read · src/auth.ts" },
      {
        t: "edit",
        file: "src/passkey.ts",
        title: "Create src/passkey.ts",
        apply: () => `export interface Assertion { origin: string; rpId: string; signature: string }\n\nexport function newChallenge(bytes = 32): string {\n  return Array.from({ length: bytes }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("");\n}\n\nexport function verifyAssertion(a: Assertion, expectedOrigin: string): boolean {\n  if (a.origin !== expectedOrigin) return "origin mismatch";\n  return a.signature.length > 0;\n}\n`,
      },
      { t: "bash", command: "tsc --noEmit", real: true },
      { t: "say", text: "tsc flags TS2322 in verifyAssertion — returning a string from a boolean function. Fixing." },
      {
        t: "edit",
        file: "src/passkey.ts",
        title: "Fix verifyAssertion return type",
        apply: (o) => o.replace(`return "origin mismatch";`, "return false;"),
      },
      {
        t: "edit",
        file: "src/auth.ts",
        title: "Add login method to Session",
        apply: (o) => o.replace("export interface Session { userId: string; expiresAt: number }", `export interface Session { userId: string; expiresAt: number; method?: "password" | "passkey" }`),
      },
      { t: "bash", command: "tsc --noEmit", real: true },
    ],
    summary: "Added passkey challenge/assertion module and a login method on Session.",
  },
  "search-ranking": {
    think: ["Reading src/search.ts", "score() takes `any` and logs to console — both flagged by lint", "Planning a typed BM25-lite scorer"],
    plan: `## Plan — Search ranking v2

1. Introduce \`SearchDoc\` type; remove \`any\` from \`score()\`.
2. Drop the debug \`console.log\`.
3. Add term-frequency weighting with title boost (×2).
4. Lint must be warning-free.`,
    steps: [
      {
        t: "edit",
        file: "src/search.ts",
        title: "Typed, weighted scorer",
        apply: (o) =>
          o.replace(
            /export function score[\s\S]*?\n}\n?/,
            `export interface SearchDoc { id: string; title: string; body: string }\n\nexport function score(doc: SearchDoc, terms: string[]): number {\n  const body = doc.body.toLowerCase();\n  const title = doc.title.toLowerCase();\n  return terms.reduce((s, t) => s + body.split(t).length - 1 + (title.includes(t) ? 2 : 0), 0);\n}\n`,
          ),
      },
      { t: "bash", command: "eslint src", real: true },
    ],
    summary: "Replaced the untyped scorer with a typed TF + title-boost ranking function.",
  },
  "billing-webhooks": {
    think: ["Reading src/billing.ts", "Webhook handler must verify HMAC signatures and be idempotent"],
    plan: `## Plan — Billing webhook hardening

1. Add \`src/webhooks.ts\` with HMAC-SHA256 signature verification (timing-safe compare).
2. Idempotency: ignore replayed event ids.
3. Mark invoices paid on \`invoice.paid\`.`,
    steps: [
      {
        t: "edit",
        file: "src/webhooks.ts",
        title: "Create src/webhooks.ts",
        apply: () => `import { createHmac, timingSafeEqual } from "node:crypto";\nimport type { Invoice } from "./billing";\n\nconst seen = new Set<string>();\n\nexport function verify(payload: string, sig: string, secret: string): boolean {\n  const mac = createHmac("sha256", secret).update(payload).digest("hex");\n  return mac.length === sig.length && timingSafeEqual(Buffer.from(mac), Buffer.from(sig));\n}\n\nexport function handle(evt: { id: string; type: string; invoiceId: string }, invoices: Invoice[]): boolean {\n  if (seen.has(evt.id)) return false;\n  seen.add(evt.id);\n  if (evt.type === "invoice.paid") {\n    const inv = invoices.find((i) => i.id === evt.invoiceId);\n    if (inv) inv.paid = true;\n  }\n  return true;\n}\n`,
      },
      { t: "bash", command: "tsc --noEmit && eslint src", real: true },
    ],
    summary: "Added signed, idempotent billing webhook handling.",
  },
};

function genericScenario(p: Project, prompt: string): Scenario {
  const slug = path.basename(p.worktreePath).replace(/[^a-z0-9]+/gi, "-").toLowerCase();
  const fn = slug.replace(/-([a-z0-9])/g, (_m, c) => c.toUpperCase()).replace(/^[0-9]+/, "");
  return {
    think: ["Scanning repository layout", `Task: ${titleFrom(prompt)}`],
    plan: `## Plan — ${p.name}\n\n1. Scaffold \`src/${slug}.ts\` with a typed entry point.\n2. Wire a health check export.\n3. Typecheck + lint.\n\n> Task: ${prompt}`,
    steps: [
      {
        t: "edit",
        file: `src/${slug}.ts`,
        title: `Create src/${slug}.ts`,
        apply: () => `export interface ${fn[0]?.toUpperCase() ?? "M"}${fn.slice(1)}Config { enabled: boolean }\n\nexport function health(): { ok: boolean; at: number } {\n  return { ok: true, at: Date.now() };\n}\n`,
      },
      { t: "bash", command: "tsc --noEmit", real: true },
    ],
    summary: `Scaffolded ${slug} module.`,
  };
}

/** line-level fixers for the problems the demo repo can produce */
function fixLine(line: string, d: Diagnostic): string | null | undefined {
  if (d.code === "prefer-const") return line.replace(/\blet\b/, "const");
  if (d.code === "no-console") return null; // delete line
  if (d.code === "@typescript-eslint/no-explicit-any") return line.replace(/:\s*any\b/, ": { [key: string]: string }");
  if (d.code === "TS2322" && /'string' is not assignable to type 'number'/.test(d.message)) return line.replace(/return (.+);/, "return Number($1);");
  if (d.code === "TS2322" && /'string' is not assignable to type 'boolean'/.test(d.message)) return line.replace(/return (["'`]).*?\1;/, "return false;");
  return undefined; // unknown
}

function fixScenario(p: Project, items: Diagnostic[]): Scenario {
  const byFile = new Map<string, Diagnostic[]>();
  items.forEach((d) => byFile.set(d.file, [...(byFile.get(d.file) ?? []), d]));
  const steps: Step[] = [];
  const skipped: Diagnostic[] = [];
  byFile.forEach((ds, file) => {
    const known = ds.filter((d) => fixLine("", d) !== undefined || d.code === "no-console");
    skipped.push(...ds.filter((d) => !known.includes(d)));
    if (!known.length) return;
    steps.push({ t: "tool", text: `read · ${file}` });
    steps.push({
      t: "edit",
      file,
      title: `Fix ${known.length} problem${known.length > 1 ? "s" : ""} in ${file}`,
      apply: (old) => {
        const lines = old.split("\n");
        // apply bottom-up so deletions don't shift earlier line numbers
        [...known].sort((a, b) => b.line - a.line).forEach((d) => {
          const i = d.line - 1;
          if (i < 0 || i >= lines.length) return;
          const r = fixLine(lines[i], d);
          if (r === null) lines.splice(i, 1);
          else if (typeof r === "string") lines[i] = r;
        });
        return lines.join("\n");
      },
    });
  });
  if (skipped.length) steps.push({ t: "say", text: `I couldn't safely auto-fix ${skipped.length} problem(s): ${skipped.map((d) => d.code).join(", ")}. Flagging for a human.` });
  steps.push({ t: "bash", command: "tsc --noEmit && eslint src", real: true });
  return {
    think: [`Reading ${byFile.size} file(s) with reported problems`, "Choosing minimal fixes per rule"],
    plan: `## Plan — fix ${items.length} problem(s)\n\n${Array.from(byFile.entries()).map(([f, ds], i) => `${i + 1}. \`${f}\` — ${ds.map((d: Diagnostic) => d.code).join(", ")}`).join("\n")}\n${byFile.size + 1}. Re-run tsc and eslint.`,
    steps,
    summary: `Applied fixes for ${items.length - skipped.length} of ${items.length} problem(s).`,
  };
}

/* ------------------------------------------------------------------ */

interface Run {
  scenario: Scenario;
  prompt: string;
  phase: AgentMode;
  idx: number;
  timer?: NodeJS.Timeout;
  waiting?: { cp: Checkpoint; step: Step };
  autoApprove: Set<string>;
  revisions: number;
}
const runs = new Map<string, Run>();
const delay = () => 1100 + Math.random() * 1700;

function say(s: AgentSession, kind: string, text: string, role: "assistant" | "tool" | "system" = "assistant") {
  store.pushMessage(s.id, { role, kind, text });
  store.patchSession(s.id, { tokens: s.tokens + 180 + Math.floor(Math.random() * 900), cost: +(s.cost + 0.002 + Math.random() * 0.01).toFixed(4) });
}

async function proposedDiff(p: Project, file: string, next: string) {
  const abs = path.join(p.worktreePath, file);
  const tmp = path.join(os.tmpdir(), `sy-${Date.now()}-${path.basename(file)}`);
  fs.writeFileSync(tmp, next);
  const old = fs.existsSync(abs) ? abs : "/dev/null";
  const r = await git(["diff", "--no-index", "--no-color", old, tmp], p.worktreePath);
  fs.unlinkSync(tmp);
  return r.stdout.split(tmp).join("/" + file).split(abs).join("/" + file);
}

async function execStep(p: Project, s: AgentSession, step: Step) {
  if (step.t === "edit") {
    const abs = path.join(p.worktreePath, step.file);
    const old = fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : "";
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, step.apply(old));
    say(s, "tool:edit", `edit · ${step.file} · applied`, "tool");
  } else if (step.t === "bash") {
    if (step.real) {
      const cmds = step.command
        .split("&&")
        .map((c) => c.trim())
        .map((c) => (c.startsWith("tsc") ? p.typecheckCmd : c.startsWith("eslint") ? p.lintCmd.replace(" -f json", "") : c))
        .filter(Boolean);
      const r = await sh(cmds.join(" && "), p.worktreePath);
      const out = (r.stdout + r.stderr).trim().slice(0, 1500) || "(no output)";
      say(s, "tool:bash", `$ ${step.command}\nexit ${r.code}\n${out}`, "tool");
    } else say(s, "tool:bash", `$ ${step.command}\n${step.output ?? ""}`, "tool");
  }
}

async function tick(p: Project, s: AgentSession) {
  const r = runs.get(s.id);
  if (!r || r.waiting) return;
  const cur = store.session(s.id);
  if (!cur || cur.status === "done" || cur.status === "idle") return;

  if (r.phase === "plan") {
    if (r.idx < r.scenario.think.length) {
      say(s, r.idx % 2 ? "reasoning" : "tool:read", r.scenario.think[r.idx], r.idx % 2 ? "assistant" : "tool");
      r.idx++;
    } else {
      const plan = r.revisions ? `${r.scenario.plan}\n\n### Revision ${r.revisions}\nIncorporated reviewer feedback: ${r.prompt}` : r.scenario.plan;
      say(s, "plan", plan);
      store.patchSession(s.id, { status: "awaiting" });
      const cp = store.addCheckpoint({ projectId: p.id, sessionId: s.id, kind: "plan", title: `Plan ready: ${s.title}`, body: plan, source: p.agent });
      r.waiting = { cp, step: { t: "say", text: "" } };
      store.log("warn", `${p.name}: plan awaiting approval`, p.id);
      return;
    }
  } else {
    if (r.idx >= r.scenario.steps.length) {
      say(s, "text", r.scenario.summary);
      store.patchSession(s.id, { status: "idle" });
      runs.delete(s.id);
      await hooks.onActFinished(p, s);
      return;
    }
    const step = r.scenario.steps[r.idx];
    const needsPermission = (step.t === "edit" || step.t === "bash") && p.agent === "opencode" && !r.autoApprove.has(step.t);
    if (needsPermission) {
      const tool = step.t;
      let diff: string | undefined;
      if (step.t === "edit") {
        const abs = path.join(p.worktreePath, step.file);
        diff = await proposedDiff(p, step.file, step.apply(fs.existsSync(abs) ? fs.readFileSync(abs, "utf8") : ""));
      }
      store.patchSession(s.id, { status: "awaiting" });
      const cp = store.addCheckpoint({
        projectId: p.id,
        sessionId: s.id,
        kind: "permission",
        tool,
        title: step.t === "edit" ? step.title : `Run: ${step.command}`,
        body: step.t === "edit" ? step.file : step.command,
        diff,
        source: p.agent,
        externalRef: `sim-${r.idx}`,
      });
      r.waiting = { cp, step };
      store.log("warn", `${p.name}: permission requested — ${tool}`, p.id);
      return;
    }
    if (step.t === "say") say(s, "text", step.text);
    else if (step.t === "think") say(s, "reasoning", step.text);
    else if (step.t === "tool") say(s, "tool:read", step.text, "tool");
    else await execStep(p, s, step);
    r.idx++;
  }
  r.timer = setTimeout(() => tick(p, s), delay());
}

function begin(p: Project, s: AgentSession, prompt: string, mode: AgentMode, scenario?: Scenario) {
  const prev = runs.get(s.id);
  if (prev?.timer) clearTimeout(prev.timer);
  const sc = scenario ?? prev?.scenario ?? scenarios[path.basename(p.worktreePath)] ?? genericScenario(p, prompt);
  const r: Run = { scenario: sc, prompt, phase: mode, idx: 0, autoApprove: prev?.autoApprove ?? new Set(), revisions: prev?.revisions ?? 0 };
  runs.set(s.id, r);
  store.patchSession(s.id, { status: "busy", mode });
  r.timer = setTimeout(() => tick(p, s), delay());
}

export const simulatorDriver: AgentDriver = {
  async connect(p) {
    store.connections[p.id] = { projectId: p.id, state: "simulated", detail: `demo ${p.agent === "opencode" ? "OpenCode" : "Cline"} agent`, version: "sim", checkedAt: Date.now() };
    store.changed(false);
  },
  disconnect() {},

  async startSession(p, prompt, mode, title, ctx) {
    const s = newSession(p, title ?? titleFrom(prompt), mode, `sim_${Date.now().toString(36)}`);
    store.pushMessage(s.id, { role: "user", kind: mode, text: prompt });
    begin(p, s, prompt, mode, ctx?.diagnostics?.length ? fixScenario(p, ctx.diagnostics) : undefined);
    store.log("info", `${p.name}: started ${mode} session`, p.id);
    return s;
  },

  async sendMessage(p, s, text, mode) {
    store.pushMessage(s.id, { role: "user", kind: mode ?? s.mode, text });
    const r = runs.get(s.id);
    if (r?.waiting) {
      say(s, "text", `Noted — I'll factor that in. Still waiting on: ${r.waiting.cp.title}`);
      return;
    }
    if ((mode ?? s.mode) === "plan") {
      const rr = runs.get(s.id);
      if (rr) rr.revisions++;
      begin(p, s, text, "plan");
    } else {
      say(s, "text", `Acknowledged: ${titleFrom(text)}`);
      if (s.status !== "busy") store.patchSession(s.id, { status: "idle" });
    }
  },

  async abort(_p, s) {
    const r = runs.get(s.id);
    if (r?.timer) clearTimeout(r.timer);
    runs.delete(s.id);
    store.pushMessage(s.id, { role: "system", kind: "abort", text: "Session aborted from dashboard" });
    store.patchSession(s.id, { status: "idle" });
  },

  async resolve(p, cp, d) {
    const s = store.session(cp.sessionId);
    if (!s) throw new Error("session not found");
    const r = runs.get(s.id);
    if (!r) throw new Error("session is no longer running");
    r.waiting = undefined;
    if (cp.kind === "plan") {
      if (d.decision === "approve" || d.decision === "approve_always") {
        say(s, "text", d.feedback ? `Plan approved with notes: "${d.feedback}". Switching to act mode.` : "Plan approved. Switching to act mode.");
        r.phase = "act";
        r.idx = 0;
        store.patchSession(s.id, { status: "busy", mode: "act" });
      } else if (d.decision === "revise") {
        r.revisions++;
        r.prompt = d.feedback || "reconsider approach";
        r.phase = "plan";
        r.idx = Math.max(0, r.scenario.think.length - 1);
        store.patchSession(s.id, { status: "busy", mode: "plan" });
      } else {
        say(s, "text", "Plan rejected. Stopping.", "system");
        store.patchSession(s.id, { status: "done" });
        runs.delete(s.id);
        return;
      }
    } else if (cp.kind === "permission") {
      const step = r.scenario.steps[r.idx];
      store.patchSession(s.id, { status: "busy" });
      if (d.decision === "reject") {
        say(s, "text", `Permission denied for "${cp.title}". ${d.feedback ? `Reviewer: ${d.feedback}. ` : ""}Skipping this step.`);
      } else {
        if (d.decision === "approve_always") r.autoApprove.add(cp.tool ?? "");
        await execStep(p, s, step);
      }
      r.idx++;
    }
    r.timer = setTimeout(() => tick(p, s), delay());
  },
};

/** restore demo worktrees to their seeded state */
export async function resetDemoWorktree(p: Project) {
  for (const [id, r] of Array.from(runs.entries())) {
    const s = store.session(id);
    if (s?.projectId === p.id) {
      if (r.timer) clearTimeout(r.timer);
      runs.delete(id);
    }
  }
  const tag = `seed/${path.basename(p.worktreePath)}`;
  const hasTag = (await git(["rev-parse", "-q", "--verify", tag], p.worktreePath)).code === 0;
  if (hasTag) await git(["reset", "--hard", tag], p.worktreePath);
  else await git(["checkout", "--", "."], p.worktreePath);
  await git(["clean", "-fd"], p.worktreePath);
}
