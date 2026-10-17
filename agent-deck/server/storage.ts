import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import type {
  Activity,
  AgentMessage,
  AgentSession,
  Checkpoint,
  ConnectionState,
  DiagState,
  GitState,
  Project,
  Schedule,
  Snapshot,
} from "@shared/schema";

/* ------------------------------------------------------------------ */
/*  Small utilities                                                    */
/* ------------------------------------------------------------------ */

export const uid = (p = "") => p + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export function sh(cmd: string, cwd: string, timeoutMs = 120_000): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      ["-lc", cmd],
      { cwd, timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env: process.env },
      (err: any, stdout, stderr) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

export function git(args: string[], cwd: string): Promise<ExecResult> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, maxBuffer: 20 * 1024 * 1024 }, (err: any, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

/* ------------------------------------------------------------------ */
/*  Store — in-memory state + JSON persistence + change events         */
/* ------------------------------------------------------------------ */

const DATA_FILE = path.resolve(process.env.SWITCHYARD_DATA ?? "data/switchyard.json");

interface Persisted {
  projects: Project[];
  schedules: Schedule[];
  checkpoints: Checkpoint[];
  sessions: AgentSession[];
  activity: Activity[];
}

class Store extends EventEmitter {
  version = 0;
  projects: Project[] = [];
  sessions: AgentSession[] = [];
  checkpoints: Checkpoint[] = [];
  schedules: Schedule[] = [];
  activity: Activity[] = [];
  diagnostics: Record<string, DiagState> = {};
  git: Record<string, GitState> = {};
  connections: Record<string, ConnectionState> = {};
  private saveTimer?: NodeJS.Timeout;

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")) as Persisted;
      this.projects = raw.projects ?? [];
      this.schedules = raw.schedules ?? [];
      this.checkpoints = raw.checkpoints ?? [];
      this.sessions = (raw.sessions ?? []).map((s) =>
        s.status === "busy" ? { ...s, status: "error" as const } : s,
      );
      this.activity = raw.activity ?? [];
      return true;
    } catch {
      return false;
    }
  }

  private persist() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      const data: Persisted = {
        projects: this.projects,
        schedules: this.schedules,
        checkpoints: this.checkpoints.slice(-300),
        sessions: this.sessions.slice(-100).map((s) => ({ ...s, messages: s.messages.slice(-80) })),
        activity: this.activity.slice(-300),
      };
      fs.mkdirSync(path.dirname(DATA_FILE), { recursive: true });
      fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2));
    }, 500);
  }

  changed(persist = true) {
    this.version++;
    if (persist) this.persist();
    this.emit("change", this.version);
  }

  snapshot(): Snapshot {
    return {
      now: Date.now(),
      version: this.version,
      projects: this.projects,
      sessions: this.sessions.map((s) => ({ ...s, messages: s.messages.slice(-60) })),
      checkpoints: this.checkpoints.slice(-200),
      diagnostics: this.diagnostics,
      git: this.git,
      connections: this.connections,
      schedules: this.schedules,
      activity: this.activity.slice(-120),
    };
  }

  /* ---- helpers ---- */
  project(id: string) {
    return this.projects.find((p) => p.id === id);
  }
  session(id: string) {
    return this.sessions.find((s) => s.id === id);
  }
  checkpoint(id: string) {
    return this.checkpoints.find((c) => c.id === id);
  }

  log(level: Activity["level"], text: string, projectId?: string) {
    this.activity.push({ id: uid("a_"), ts: Date.now(), level, text, projectId });
    if (this.activity.length > 400) this.activity.splice(0, this.activity.length - 400);
    this.changed();
  }

  patchSession(id: string, patch: Partial<AgentSession>) {
    const s = this.session(id);
    if (!s) return;
    Object.assign(s, patch, { updatedAt: Date.now() });
    this.changed();
  }

  /** upsert a message by id (streaming parts update the same id) */
  pushMessage(sessionId: string, msg: Omit<AgentMessage, "id" | "ts"> & { id?: string; ts?: number }) {
    const s = this.session(sessionId);
    if (!s) return;
    const id = msg.id ?? uid("m_");
    const existing = s.messages.find((m) => m.id === id);
    if (existing) Object.assign(existing, msg, { id });
    else s.messages.push({ ts: Date.now(), ...msg, id } as AgentMessage);
    if (s.messages.length > 200) s.messages.splice(0, s.messages.length - 200);
    s.updatedAt = Date.now();
    this.changed(false);
  }

  addCheckpoint(cp: Omit<Checkpoint, "id" | "createdAt" | "status">) {
    const c: Checkpoint = { ...cp, id: uid("cp_"), createdAt: Date.now(), status: "pending" };
    this.checkpoints.push(c);
    this.changed();
    return c;
  }
}

export const store = new Store();
