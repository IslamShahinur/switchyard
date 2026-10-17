import fs from "node:fs";
import path from "node:path";
import type { AgentMode, AgentSession, Diagnostic, InsertProject, InsertSchedule, Project, ResolveCheckpoint, Schedule } from "@shared/schema";
import { git, sh, store, uid } from "./storage";
import { addWorktree, gitDiff, nextCron, refreshGit, runDiagnostics, runDiagnosticsFresh, unwatchProject, watchProject } from "./monitors";
import { fixPrompt, hooks, type AgentDriver } from "./drivers/base";
import { opencodeDriver } from "./drivers/opencode";
import { clineDriver } from "./drivers/cline";
import { resetDemoWorktree, simulatorDriver } from "./drivers/simulator";

const PALETTE = ["#2dd4bf", "#f59e0b", "#a78bfa", "#f472b6", "#60a5fa", "#a3e635", "#fb7185", "#38bdf8"];

export const DEMO_ROOT = path.resolve(process.env.SWITCHYARD_DEMO_ROOT ?? path.join(process.cwd(), "..", "demo-env"));
const DEMO_BIN = path.join(DEMO_ROOT, "node_modules", ".bin");

export function driverFor(p: Project): AgentDriver {
  if (p.runMode === "demo") return simulatorDriver;
  return p.agent === "opencode" ? opencodeDriver : clineDriver;
}

function defaultCmds(p: { runMode: string; typecheckCmd?: string; lintCmd?: string }) {
  const demo = p.runMode === "demo";
  return {
    typecheckCmd: p.typecheckCmd || (demo ? `${DEMO_BIN}/tsc --noEmit --pretty false -p .` : "npx --no-install tsc --noEmit --pretty false"),
    lintCmd: p.lintCmd || (demo ? `${DEMO_BIN}/eslint -f json src` : "npx --no-install eslint -f json ."),
  };
}

/* ------------------------- review checkpoint ------------------------ */

hooks.onActFinished = async (p: Project, s: AgentSession) => {
  await refreshGit(p);
  await runDiagnosticsFresh(p);
  const diff = await gitDiff(p);
  const d = store.diagnostics[p.id];
  const errs = d ? d.tscErrors + d.lintErrors : 0;
  if (!diff.trim()) {
    store.log("info", `${p.name}: act run finished with no changes`, p.id);
    return;
  }
  store.patchSession(s.id, { status: "awaiting" });
  store.addCheckpoint({
    projectId: p.id,
    sessionId: s.id,
    kind: "review",
    title: `Review changes: ${s.title}`,
    body: `Act run finished on \`${p.branch}\`. ${store.git[p.id]?.dirty ?? 0} file(s) changed. Diagnostics: ${errs} error(s), ${d?.lintWarnings ?? 0} warning(s).\n\nApprove to commit to the worktree branch; reject to discard all uncommitted changes.`,
    diff,
    source: p.agent,
  });
  store.log("warn", `${p.name}: changes ready for review`, p.id);
};

/* ----------------------------- projects ----------------------------- */

export async function activateProject(p: Project) {
  watchProject(p);
  await driverFor(p).connect(p).catch((e) => store.log("error", `${p.name}: connect failed — ${e.message}`, p.id));
  refreshGit(p);
  runDiagnostics(p);
}

export async function createProject(input: InsertProject, origin: Project["origin"] = "manual") {
  if (input.createWorktree) await addWorktree(input.repoPath, input.worktreePath, input.branch, input.baseBranch || "main");
  if (!fs.existsSync(input.worktreePath)) throw new Error(`worktree not found: ${input.worktreePath}`);
  const p: Project = {
    id: uid("p_"),
    name: input.name,
    repoPath: input.repoPath,
    worktreePath: input.worktreePath,
    branch: input.branch,
    agent: input.agent,
    runMode: input.runMode,
    opencodeUrl: input.opencodeUrl || undefined,
    clineBin: input.clineBin || undefined,
    model: input.model || undefined,
    ...defaultCmds(input),
    color: PALETTE[store.projects.length % PALETTE.length],
    origin,
    createdAt: Date.now(),
  };
  store.projects.push(p);
  store.changed();
  store.log("success", `Project added: ${p.name} (${p.branch})`, p.id);
  await activateProject(p);
  return p;
}

export async function updateProject(id: string, patch: Partial<Project>) {
  const p = store.project(id);
  if (!p) throw new Error("project not found");
  driverFor(p).disconnect(p);
  Object.assign(p, patch);
  store.changed();
  await activateProject(p);
  return p;
}

export async function removeProject(id: string, removeWorktree: boolean) {
  const p = store.project(id);
  if (!p) return;
  driverFor(p).disconnect(p);
  unwatchProject(id);
  if (removeWorktree) await git(["worktree", "remove", "--force", p.worktreePath], p.repoPath);
  store.projects = store.projects.filter((x) => x.id !== id);
  store.sessions = store.sessions.filter((s) => s.projectId !== id);
  store.checkpoints = store.checkpoints.filter((c) => c.projectId !== id);
  delete store.diagnostics[id];
  delete store.git[id];
  delete store.connections[id];
  store.log("info", `Project removed: ${p.name}${removeWorktree ? " (worktree deleted)" : ""}`);
}

/* --------------------------- fix with agent --------------------------- */

export async function fixWithAgent(projectId: string, items: Diagnostic[] | undefined, mode: AgentMode) {
  const p = store.project(projectId);
  if (!p) throw new Error("project not found");
  const all = store.diagnostics[p.id]?.items ?? [];
  const list = items?.length ? items : all.filter((d) => d.severity === "error").length ? all.filter((d) => d.severity === "error") : all;
  if (!list.length) throw new Error("no problems to fix");
  const busy = store.sessions.find((s) => s.projectId === p.id && (s.status === "busy" || s.status === "awaiting"));
  if (busy) throw new Error(`agent is ${busy.status === "busy" ? "running" : "waiting on a checkpoint"} in "${busy.title}" — resolve that first`);
  const title = list.length === 1 ? `Fix ${list[0].code} in ${list[0].file}:${list[0].line}` : `Fix ${list.length} problems`;
  const s = await driverFor(p).startSession(p, fixPrompt(list), mode, title, { diagnostics: list });
  store.log("info", `${p.name}: sent ${list.length} problem${list.length > 1 ? "s" : ""} to the agent`, p.id);
  return s;
}

/* ---------------------------- checkpoints ---------------------------- */

export async function resolveCheckpoint(id: string, d: ResolveCheckpoint) {
  const cp = store.checkpoint(id);
  if (!cp) throw new Error("checkpoint not found");
  if (cp.status !== "pending") throw new Error(`checkpoint already ${cp.status}`);
  const p = store.project(cp.projectId);
  if (!p) throw new Error("project not found");

  if (cp.kind === "review") {
    const s = store.session(cp.sessionId);
    if (d.decision === "approve" || d.decision === "approve_always") {
      await git(["add", "-A"], p.worktreePath);
      const msg = `${s?.title ?? "agent changes"}\n\nApproved in Switchyard (${p.agent} session ${s?.id ?? ""})${d.feedback ? `\nNotes: ${d.feedback}` : ""}`;
      const r = await git(["commit", "-m", msg], p.worktreePath);
      if (r.code !== 0) throw new Error(r.stderr || r.stdout);
      store.log("success", `${p.name}: changes committed to ${p.branch}`, p.id);
      if (s) store.patchSession(s.id, { status: "done" });
    } else if (d.decision === "reject") {
      await git(["checkout", "--", "."], p.worktreePath);
      await git(["clean", "-fd"], p.worktreePath);
      store.log("warn", `${p.name}: changes discarded`, p.id);
      if (s) store.patchSession(s.id, { status: "done" });
    } else if (d.decision === "revise" && s) {
      await driverFor(p).sendMessage(p, s, `Reviewer requested changes before commit:\n${d.feedback ?? ""}`, "act");
    }
    refreshGit(p);
    runDiagnostics(p);
  } else {
    await driverFor(p).resolve(p, cp, d);
  }
  cp.status = d.decision === "reject" ? "rejected" : d.decision === "revise" ? "revised" : "approved";
  cp.resolvedAt = Date.now();
  cp.response = d.decision;
  cp.feedback = d.feedback;
  store.changed();
  store.log(d.decision === "reject" ? "warn" : "info", `${p.name}: ${cp.kind} checkpoint ${cp.status}`, p.id);
  return cp;
}

/* ------------------------------ scheduler ---------------------------- */

const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40);

function fill(tpl: string, sch: Schedule, n: number) {
  const d = new Date();
  const pad = (x: number) => String(x).padStart(2, "0");
  return tpl
    .replaceAll("{date}", `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}`)
    .replaceAll("{time}", `${pad(d.getHours())}${pad(d.getMinutes())}`)
    .replaceAll("{n}", String(n))
    .replaceAll("{slug}", slugify(sch.name));
}

export async function runSchedule(id: string) {
  const sch = store.schedules.find((s) => s.id === id);
  if (!sch) throw new Error("schedule not found");
  sch.lastRun = Date.now();
  try {
    const active = store.projects.filter((p) => store.sessions.some((s) => s.projectId === p.id && (s.status === "busy" || s.status === "awaiting"))).length;
    if (active >= sch.maxConcurrent) throw new Error(`skipped — ${active} projects already active (limit ${sch.maxConcurrent})`);
    const n = sch.runs.filter((r) => r.status === "ok").length + 1;
    const branch = fill(sch.branchTemplate, sch, n);
    const name = fill(sch.nameTemplate, sch, n);
    const worktreePath = path.join(path.dirname(sch.repoPath), "worktrees", slugify(branch.replace(/\//g, "-")));
    const p = await createProject(
      { name, repoPath: sch.repoPath, worktreePath, branch, createWorktree: true, baseBranch: sch.baseBranch, agent: sch.agent, runMode: sch.runMode, typecheckCmd: "", lintCmd: "" },
      "schedule",
    );
    if (sch.scaffoldCmd) {
      const r = await sh(sch.scaffoldCmd, worktreePath, 300_000);
      if (r.code !== 0) store.log("warn", `${name}: scaffold command exited ${r.code}`, p.id);
    }
    await driverFor(p).startSession(p, sch.prompt, sch.mode, name);
    sch.runs.unshift({ ts: Date.now(), status: "ok", detail: `created ${branch}`, projectId: p.id });
    store.log("success", `Schedule "${sch.name}" created project ${name}`, p.id);
  } catch (e: any) {
    sch.runs.unshift({ ts: Date.now(), status: "error", detail: e.message });
    store.log("error", `Schedule "${sch.name}" failed: ${e.message}`);
  }
  sch.runs = sch.runs.slice(0, 30);
  sch.nextRun = sch.enabled ? nextCron(sch.cron) : undefined;
  store.changed();
}

export function upsertSchedule(input: InsertSchedule, id?: string) {
  nextCron(input.cron); // validates
  let sch = id ? store.schedules.find((s) => s.id === id) : undefined;
  if (sch) Object.assign(sch, input);
  else {
    sch = { ...input, id: uid("sch_"), runs: [] };
    store.schedules.push(sch);
  }
  sch.nextRun = sch.enabled ? nextCron(sch.cron) : undefined;
  store.changed();
  return sch;
}

function startScheduler() {
  setInterval(() => {
    const now = Date.now();
    for (const s of store.schedules) {
      if (s.enabled && !s.nextRun) s.nextRun = nextCron(s.cron);
      if (s.enabled && s.nextRun && s.nextRun <= now) runSchedule(s.id);
    }
  }, 15_000);
}

/* -------------------------------- boot -------------------------------- */

async function seedDemo() {
  const wt = path.join(DEMO_ROOT, "worktrees");
  const repo = path.join(DEMO_ROOT, "acme");
  if (!fs.existsSync(wt)) return;
  const defs: [string, string, "opencode" | "cline"][] = [
    ["Checkout v2", "checkout-v2", "opencode"],
    ["Auth · Passkeys", "auth-passkeys", "opencode"],
    ["Search ranking", "search-ranking", "cline"],
    ["Billing webhooks", "billing-webhooks", "cline"],
  ];
  for (const [name, dir, agent] of defs) {
    const branch = (await git(["rev-parse", "--abbrev-ref", "HEAD"], path.join(wt, dir))).stdout.trim();
    const p: Project = {
      id: uid("p_"),
      name,
      repoPath: repo,
      worktreePath: path.join(wt, dir),
      branch,
      agent,
      runMode: "demo",
      opencodeUrl: agent === "opencode" ? `http://127.0.0.1:${4096 + store.projects.length}` : undefined,
      ...defaultCmds({ runMode: "demo" }),
      color: PALETTE[store.projects.length],
      origin: "manual",
      createdAt: Date.now(),
    };
    store.projects.push(p);
  }
  store.schedules.push({
    id: uid("sch_"),
    name: "Nightly feature spike",
    cron: "0 2 * * 1-5",
    enabled: true,
    repoPath: repo,
    baseBranch: "main",
    branchTemplate: "spike/{date}-{n}",
    nameTemplate: "Spike {date} #{n}",
    agent: "cline",
    runMode: "demo",
    mode: "plan",
    prompt: "Create a new feature module scaffold with typed config and a health check, then propose tests.",
    maxConcurrent: 5,
    runs: [],
  });
  store.schedules.push({
    id: uid("sch_"),
    name: "Hourly dependency audit",
    cron: "15 * * * *",
    enabled: false,
    repoPath: repo,
    baseBranch: "main",
    branchTemplate: "chore/deps-{date}{time}",
    nameTemplate: "Deps audit {time}",
    agent: "opencode",
    runMode: "demo",
    mode: "plan",
    prompt: "Audit dependencies for outdated or vulnerable packages and propose an upgrade plan.",
    maxConcurrent: 4,
    runs: [],
  });
  store.changed();
}

export async function startDemoSessions() {
  const prompts: Record<string, [string, "plan" | "act", number]> = {
    "checkout-v2": ["Fix the discount type bug and add a tax pipeline for checkout v2", "plan", 600],
    "auth-passkeys": ["Implement passkey (WebAuthn) login alongside passwords", "act", 2500],
    "search-ranking": ["Improve search ranking: typed docs, TF weighting, title boost", "plan", 4500],
    "billing-webhooks": ["Harden billing webhooks: signature verification + idempotency", "plan", 14000],
  };
  for (const p of store.projects.filter((x) => x.runMode === "demo")) {
    const def = prompts[path.basename(p.worktreePath)];
    if (!def) continue;
    setTimeout(() => driverFor(p).startSession(p, def[0], def[1]).catch(() => {}), def[2]);
  }
}

export async function resetDemo() {
  for (const p of store.projects.filter((x) => x.runMode === "demo")) {
    await resetDemoWorktree(p);
    store.sessions = store.sessions.filter((s) => s.projectId !== p.id);
    store.checkpoints = store.checkpoints.filter((c) => c.projectId !== p.id);
    refreshGit(p);
    runDiagnostics(p);
  }
  store.log("info", "Demo reset — worktrees restored to seed commits");
  await startDemoSessions();
}

export async function boot() {
  const loaded = store.load();
  if (!loaded || store.projects.length === 0) {
    await seedDemo();
    for (const p of store.projects) await activateProject(p);
    await startDemoSessions();
  } else {
    for (const p of store.projects) await activateProject(p);
    // simulator runs don't survive restarts — restart demo choreography cleanly
    if (store.projects.some((p) => p.runMode === "demo")) await resetDemo();
  }
  for (const s of store.schedules) s.nextRun = s.enabled ? nextCron(s.cron) : undefined;
  startScheduler();
  setInterval(() => store.projects.forEach((p) => refreshGit(p)), 5000);
  setInterval(() => store.projects.forEach((p) => runDiagnostics(p)), 60_000);
  store.log("info", `Switchyard online — ${store.projects.length} projects`);
}
