import fs from "node:fs";
import path from "node:path";
import type { DiagState, Diagnostic, GitState, Project } from "@shared/schema";
import { git, sh, store } from "./storage";

/* ================================================================== */
/*  Git worktree monitor                                               */
/* ================================================================== */

export async function readGit(p: Project): Promise<GitState> {
  const wt = p.worktreePath;
  if (!fs.existsSync(wt)) {
    return { branch: p.branch, head: "", headMsg: "", dirty: 0, files: [], ahead: 0, commits: 0, ok: false, error: "worktree path not found" };
  }
  const [br, head, status, base] = await Promise.all([
    git(["rev-parse", "--abbrev-ref", "HEAD"], wt),
    git(["log", "-1", "--format=%h%x09%s"], wt),
    git(["status", "--porcelain"], wt),
    git(["merge-base", "HEAD", "main"], wt),
  ]);
  if (br.code !== 0) return { branch: p.branch, head: "", headMsg: "", dirty: 0, files: [], ahead: 0, commits: 0, ok: false, error: br.stderr.trim() };
  const [h, ...msg] = head.stdout.trim().split("\t");
  const files = status.stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => ({ status: l.slice(0, 2).trim(), path: l.slice(3) }));
  let ahead = 0;
  if (base.code === 0) {
    const r = await git(["rev-list", "--count", `${base.stdout.trim()}..HEAD`], wt);
    ahead = parseInt(r.stdout.trim() || "0", 10);
  }
  return { branch: br.stdout.trim(), head: h ?? "", headMsg: msg.join("\t"), dirty: files.length, files, ahead, commits: ahead, ok: true };
}

/** tracked changes vs HEAD + untracked files, without touching the index */
export async function gitDiff(p: Project): Promise<string> {
  const wt = p.worktreePath;
  const [tracked, untracked] = await Promise.all([
    git(["diff", "--no-color", "HEAD"], wt),
    git(["ls-files", "--others", "--exclude-standard"], wt),
  ]);
  let out = tracked.stdout;
  for (const f of untracked.stdout.split("\n").filter(Boolean).slice(0, 40)) {
    const r = await git(["diff", "--no-color", "--no-index", "/dev/null", f], wt);
    out += (out && !out.endsWith("\n") ? "\n" : "") + r.stdout;
  }
  return out.slice(0, 120_000);
}

export function readSnippet(p: Project, file: string, line: number, radius = 4) {
  const abs = path.resolve(p.worktreePath, file);
  if (!abs.startsWith(path.resolve(p.worktreePath) + path.sep)) throw new Error("path outside worktree");
  const lines = fs.readFileSync(abs, "utf8").split("\n");
  const start = Math.max(1, line - radius);
  const end = Math.min(lines.length, line + radius);
  return { file, start, focus: line, lines: lines.slice(start - 1, end) };
}

export async function listWorktrees(repoPath: string) {
  const r = await git(["worktree", "list", "--porcelain"], repoPath);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "not a git repository");
  const out: { path: string; head: string; branch: string }[] = [];
  let cur: any = {};
  for (const line of r.stdout.split("\n")) {
    if (line.startsWith("worktree ")) cur = { path: line.slice(9), head: "", branch: "" };
    else if (line.startsWith("HEAD ")) cur.head = line.slice(5, 12);
    else if (line.startsWith("branch ")) cur.branch = line.slice(7).replace("refs/heads/", "");
    else if (line === "" && cur.path) {
      out.push(cur);
      cur = {};
    }
  }
  if (cur.path) out.push(cur);
  return out;
}

export async function addWorktree(repoPath: string, worktreePath: string, branch: string, base: string) {
  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
  const r = await git(["worktree", "add", "-b", branch, worktreePath, base], repoPath);
  if (r.code !== 0) {
    // branch may already exist
    const r2 = await git(["worktree", "add", worktreePath, branch], repoPath);
    if (r2.code !== 0) throw new Error(r.stderr.trim() || r2.stderr.trim());
  }
}

/* ================================================================== */
/*  Diagnostics: tsc + eslint, re-run on file change                   */
/* ================================================================== */

const TSC_RE = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.*)$/;

export function parseTsc(out: string, root: string): Diagnostic[] {
  const items: Diagnostic[] = [];
  for (const line of out.split("\n")) {
    const m = line.match(TSC_RE);
    if (m) {
      items.push({
        file: path.relative(root, path.resolve(root, m[1])),
        line: +m[2],
        col: +m[3],
        severity: m[4] === "error" ? "error" : "warning",
        code: m[5],
        message: m[6],
        source: "tsc",
      });
    }
  }
  return items;
}

export function parseEslint(out: string, root: string): Diagnostic[] {
  const start = out.indexOf("[");
  if (start < 0) return [];
  try {
    const files = JSON.parse(out.slice(start)) as any[];
    return files.flatMap((f) =>
      (f.messages ?? []).map((m: any) => ({
        file: path.relative(root, f.filePath),
        line: m.line ?? 0,
        col: m.column ?? 0,
        severity: m.severity === 2 ? "error" : "warning",
        code: m.ruleId ?? "eslint",
        message: m.message,
        source: "eslint",
      })),
    );
  } catch {
    return [];
  }
}

const running = new Set<string>();
const pending = new Set<string>();

/** wait for any in-flight diagnostics run, then run a fresh one */
export async function runDiagnosticsFresh(p: Project) {
  for (let i = 0; i < 100 && running.has(p.id); i++) await new Promise((r) => setTimeout(r, 200));
  await runDiagnostics(p);
}

export async function runDiagnostics(p: Project) {
  if (running.has(p.id)) {
    pending.add(p.id);
    return;
  }
  running.add(p.id);
  const prev: DiagState =
    store.diagnostics[p.id] ?? { projectId: p.id, running: false, tscErrors: 0, lintErrors: 0, lintWarnings: 0, items: [], history: [], status: "unknown" };
  store.diagnostics[p.id] = { ...prev, running: true };
  store.changed(false);
  const t0 = Date.now();
  let items: Diagnostic[] = [];
  let cmdError: string | undefined;
  try {
    if (!fs.existsSync(p.worktreePath)) throw new Error("worktree path not found");
    const [tsc, lint] = await Promise.all([
      p.typecheckCmd ? sh(p.typecheckCmd, p.worktreePath) : Promise.resolve(null),
      p.lintCmd ? sh(p.lintCmd, p.worktreePath) : Promise.resolve(null),
    ]);
    if (tsc) {
      const t = parseTsc(tsc.stdout + "\n" + tsc.stderr, p.worktreePath);
      items.push(...t);
      if (tsc.code !== 0 && t.length === 0) cmdError = `typecheck: ${(tsc.stderr || tsc.stdout).trim().slice(0, 300)}`;
    }
    if (lint) {
      const l = parseEslint(lint.stdout, p.worktreePath);
      items.push(...l);
      if (lint.code !== 0 && l.length === 0 && !lint.stdout.trim().startsWith("[")) cmdError = `lint: ${(lint.stderr || lint.stdout).trim().slice(0, 300)}`;
    }
  } catch (e: any) {
    cmdError = e.message;
  }
  const tscErrors = items.filter((i) => i.source === "tsc" && i.severity === "error").length;
  const lintErrors = items.filter((i) => i.source === "eslint" && i.severity === "error").length;
  const lintWarnings = items.filter((i) => i.severity === "warning").length;
  const errors = tscErrors + lintErrors;
  const status: DiagState["status"] = cmdError && !items.length ? "unknown" : errors ? "fail" : lintWarnings ? "warn" : "pass";
  const history = [...prev.history, { ts: Date.now(), errors, warnings: lintWarnings }].slice(-40);

  if (prev.status !== "unknown" && prev.lastRun) {
    const prevErr = prev.tscErrors + prev.lintErrors;
    if (errors > prevErr) store.log("error", `${p.name}: ${errors - prevErr} new error${errors - prevErr > 1 ? "s" : ""} (${errors} total)`, p.id);
    else if (errors < prevErr && errors === 0) store.log("success", `${p.name}: build clean — 0 errors`, p.id);
    else if (errors < prevErr) store.log("info", `${p.name}: errors down to ${errors}`, p.id);
  }

  store.diagnostics[p.id] = {
    projectId: p.id,
    running: false,
    lastRun: Date.now(),
    durationMs: Date.now() - t0,
    tscErrors,
    lintErrors,
    lintWarnings,
    items: items.slice(0, 500),
    history,
    status,
    cmdError,
  };
  running.delete(p.id);
  store.changed(false);
  if (pending.delete(p.id)) runDiagnostics(p);
}

/* ------------------------- file watching -------------------------- */

const watchers = new Map<string, fs.FSWatcher>();
const debounce = new Map<string, NodeJS.Timeout>();

export function watchProject(p: Project) {
  unwatchProject(p.id);
  if (!fs.existsSync(p.worktreePath)) return;
  try {
    const w = fs.watch(p.worktreePath, { recursive: true }, (_evt, file) => {
      const f = String(file ?? "");
      if (!f || f.includes("node_modules") || f.startsWith(".git") || f.includes("/.git/") || f.endsWith(".tsbuildinfo")) return;
      clearTimeout(debounce.get(p.id));
      debounce.set(
        p.id,
        setTimeout(() => {
          const cur = store.project(p.id);
          if (cur) {
            runDiagnostics(cur);
            refreshGit(cur);
          }
        }, 700),
      );
    });
    watchers.set(p.id, w);
  } catch (e) {
    console.warn("watch failed", p.worktreePath, e);
  }
}

export function unwatchProject(id: string) {
  watchers.get(id)?.close();
  watchers.delete(id);
}

export async function refreshGit(p: Project) {
  const g = await readGit(p);
  const before = JSON.stringify(store.git[p.id] ?? {});
  store.git[p.id] = g;
  if (JSON.stringify(g) !== before) store.changed(false);
}

/* ================================================================== */
/*  Cron (5-field) — minute hour day-of-month month day-of-week        */
/* ================================================================== */

function field(expr: string, min: number, max: number): Set<number> {
  const out = new Set<number>();
  for (const part of expr.split(",")) {
    const [rangeRaw, stepRaw] = part.split("/");
    const step = stepRaw ? parseInt(stepRaw, 10) : 1;
    let lo = min,
      hi = max;
    if (rangeRaw !== "*") {
      const [a, b] = rangeRaw.split("-").map((n) => parseInt(n, 10));
      if (Number.isNaN(a)) throw new Error(`bad cron field "${expr}"`);
      lo = a;
      hi = b ?? (stepRaw ? max : a);
    }
    if (lo < min || hi > max || step < 1) throw new Error(`cron field out of range "${expr}"`);
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string) {
  const f = expr.trim().split(/\s+/);
  if (f.length !== 5) throw new Error("cron must have 5 fields");
  return {
    min: field(f[0], 0, 59),
    hour: field(f[1], 0, 23),
    dom: field(f[2], 1, 31),
    mon: field(f[3], 1, 12),
    dow: field(f[4].replace("7", "0"), 0, 6),
    domStar: f[2] === "*",
    dowStar: f[4] === "*",
  };
}

export function nextCron(expr: string, from = Date.now()): number | undefined {
  const c = parseCron(expr);
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  for (let i = 0; i < 60 * 24 * 370; i++) {
    const domOk = c.dom.has(d.getDate());
    const dowOk = c.dow.has(d.getDay());
    const dayOk = c.domStar && c.dowStar ? true : c.domStar ? dowOk : c.dowStar ? domOk : domOk || dowOk;
    if (c.min.has(d.getMinutes()) && c.hour.has(d.getHours()) && c.mon.has(d.getMonth() + 1) && dayOk) return d.getTime();
    d.setMinutes(d.getMinutes() + 1);
  }
  return undefined;
}
