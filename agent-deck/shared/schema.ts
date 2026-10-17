import { z } from "zod";

/* ------------------------------------------------------------------ */
/*  Switchyard — shared domain model (frontend + backend)             */
/* ------------------------------------------------------------------ */

export type AgentKind = "opencode" | "cline";
export type AgentMode = "plan" | "act";
/** live = talk to a real Cline CLI / OpenCode server; demo = built-in simulator that edits the real worktree */
export type RunMode = "live" | "demo";

export interface Project {
  id: string;
  name: string;
  repoPath: string;
  worktreePath: string;
  branch: string;
  agent: AgentKind;
  runMode: RunMode;
  /** OpenCode server base URL, e.g. http://127.0.0.1:4096 (one `opencode serve` per worktree) */
  opencodeUrl?: string;
  /** Path to the cline binary (defaults to `cline` on PATH) */
  clineBin?: string;
  /** Model override passed to the agent */
  model?: string;
  typecheckCmd: string;
  lintCmd: string;
  color: string;
  origin: "manual" | "schedule";
  createdAt: number;
}

export type SessionStatus = "idle" | "busy" | "awaiting" | "error" | "done";

export interface AgentMessage {
  id: string;
  role: "user" | "assistant" | "tool" | "system";
  kind?: string; // e.g. text | reasoning | tool:edit | tool:bash | plan
  text: string;
  ts: number;
}

export interface AgentSession {
  id: string;
  projectId: string;
  agent: AgentKind;
  externalId?: string; // OpenCode session id or Cline task id
  title: string;
  status: SessionStatus;
  mode: AgentMode;
  model?: string;
  startedAt: number;
  updatedAt: number;
  tokens: number;
  cost: number;
  messages: AgentMessage[];
}

export type CheckpointKind = "plan" | "permission" | "review";
export type CheckpointStatus = "pending" | "approved" | "rejected" | "revised";

export interface Checkpoint {
  id: string;
  projectId: string;
  sessionId: string;
  kind: CheckpointKind;
  /** for permission: edit | bash | webfetch | mcp ... */
  tool?: string;
  title: string;
  body: string; // markdown plan, command, or summary
  diff?: string; // unified diff (edits / review)
  createdAt: number;
  status: CheckpointStatus;
  resolvedAt?: number;
  response?: string;
  feedback?: string;
  source: AgentKind;
  externalRef?: string; // OpenCode permission id etc.
}

export interface Diagnostic {
  file: string;
  line: number;
  col: number;
  severity: "error" | "warning";
  code: string;
  message: string;
  source: "tsc" | "eslint";
}

export interface DiagState {
  projectId: string;
  running: boolean;
  lastRun?: number;
  durationMs?: number;
  tscErrors: number;
  lintErrors: number;
  lintWarnings: number;
  items: Diagnostic[];
  history: { ts: number; errors: number; warnings: number }[];
  status: "pass" | "warn" | "fail" | "unknown";
  cmdError?: string;
}

export interface GitState {
  branch: string;
  head: string;
  headMsg: string;
  dirty: number;
  files: { status: string; path: string }[];
  ahead: number;
  commits: number;
  ok: boolean;
  error?: string;
}

export interface ConnectionState {
  projectId: string;
  state: "connected" | "connecting" | "disconnected" | "simulated";
  detail: string;
  version?: string;
  checkedAt: number;
}

export interface ScheduleRun {
  ts: number;
  status: "ok" | "error";
  detail: string;
  projectId?: string;
}

export interface Schedule {
  id: string;
  name: string;
  cron: string; // 5-field cron, local server time
  enabled: boolean;
  repoPath: string;
  baseBranch: string;
  /** supports {date} {time} {n} {slug} */
  branchTemplate: string;
  nameTemplate: string;
  agent: AgentKind;
  runMode: RunMode;
  mode: AgentMode;
  prompt: string;
  scaffoldCmd?: string;
  maxConcurrent: number;
  lastRun?: number;
  nextRun?: number;
  runs: ScheduleRun[];
}

export interface Activity {
  id: string;
  ts: number;
  projectId?: string;
  level: "info" | "warn" | "error" | "success";
  text: string;
}

export interface Snapshot {
  now: number;
  version: number;
  projects: Project[];
  sessions: AgentSession[];
  checkpoints: Checkpoint[];
  diagnostics: Record<string, DiagState>;
  git: Record<string, GitState>;
  connections: Record<string, ConnectionState>;
  schedules: Schedule[];
  activity: Activity[];
}

/* --------------------------- API inputs --------------------------- */

export const insertProjectSchema = z.object({
  name: z.string().min(1),
  repoPath: z.string().min(1),
  worktreePath: z.string().min(1),
  branch: z.string().min(1),
  createWorktree: z.boolean().default(false),
  baseBranch: z.string().default("main"),
  agent: z.enum(["opencode", "cline"]),
  runMode: z.enum(["live", "demo"]),
  opencodeUrl: z.string().optional(),
  clineBin: z.string().optional(),
  model: z.string().optional(),
  typecheckCmd: z.string().default(""),
  lintCmd: z.string().default(""),
});
export type InsertProject = z.infer<typeof insertProjectSchema>;

export const startSessionSchema = z.object({
  prompt: z.string().min(1),
  mode: z.enum(["plan", "act"]),
  title: z.string().optional(),
});
export type StartSession = z.infer<typeof startSessionSchema>;

export const sendMessageSchema = z.object({
  text: z.string().min(1),
  mode: z.enum(["plan", "act"]).optional(),
});

export const resolveCheckpointSchema = z.object({
  decision: z.enum(["approve", "approve_always", "reject", "revise"]),
  feedback: z.string().optional(),
});
export type ResolveCheckpoint = z.infer<typeof resolveCheckpointSchema>;

export const insertScheduleSchema = z.object({
  name: z.string().min(1),
  cron: z.string().min(9),
  enabled: z.boolean().default(true),
  repoPath: z.string().min(1),
  baseBranch: z.string().min(1),
  branchTemplate: z.string().min(1),
  nameTemplate: z.string().min(1),
  agent: z.enum(["opencode", "cline"]),
  runMode: z.enum(["live", "demo"]),
  mode: z.enum(["plan", "act"]),
  prompt: z.string().min(1),
  scaffoldCmd: z.string().optional(),
  maxConcurrent: z.number().int().min(1).max(8).default(4),
});
export type InsertSchedule = z.infer<typeof insertScheduleSchema>;
