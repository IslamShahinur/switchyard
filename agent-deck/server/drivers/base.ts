import type { AgentMode, AgentSession, Checkpoint, Diagnostic, Project, ResolveCheckpoint } from "@shared/schema";
import { store, uid } from "../storage";

export interface AgentDriver {
  /** health check + subscribe to events */
  connect(p: Project): Promise<void>;
  disconnect(p: Project): void;
  startSession(p: Project, prompt: string, mode: AgentMode, title?: string, ctx?: { diagnostics?: Diagnostic[] }): Promise<AgentSession>;
  sendMessage(p: Project, s: AgentSession, text: string, mode?: AgentMode): Promise<void>;
  abort(p: Project, s: AgentSession): Promise<void>;
  /** plan + permission checkpoints are agent specific; review checkpoints are handled by the hub */
  resolve(p: Project, cp: Checkpoint, d: ResolveCheckpoint): Promise<void>;
}

/** Hub callbacks used by drivers (set by hub.ts, avoids import cycles) */
export const hooks = {
  /** called when an act-mode run finishes and the worktree should be reviewed */
  onActFinished: async (_p: Project, _s: AgentSession) => {},
};

export function newSession(p: Project, title: string, mode: AgentMode, externalId?: string): AgentSession {
  const s: AgentSession = {
    id: uid("s_"),
    projectId: p.id,
    agent: p.agent,
    externalId,
    title,
    status: "busy",
    mode,
    model: p.model,
    startedAt: Date.now(),
    updatedAt: Date.now(),
    tokens: 0,
    cost: 0,
    messages: [],
  };
  store.sessions.push(s);
  store.changed();
  return s;
}

export function titleFrom(prompt: string) {
  const t = prompt.replace(/\s+/g, " ").trim();
  return t.length > 64 ? t.slice(0, 61) + "…" : t;
}

export const APPROVE_PLAN_PROMPT = (plan: string, feedback?: string) =>
  `The plan below has been reviewed and APPROVED in the Switchyard control dashboard. Switch to act mode and implement it now.\n\n${plan}${
    feedback ? `\n\nReviewer notes to apply while implementing:\n${feedback}` : ""
  }`;

export const REVISE_PLAN_PROMPT = (feedback: string) =>
  `The reviewer requested changes to your plan. Stay in plan mode and produce a revised plan.\n\nReviewer feedback:\n${feedback}`;

export function fixPrompt(items: Diagnostic[]) {
  const list = items
    .slice(0, 40)
    .map((d) => `- ${d.file}:${d.line}:${d.col} [${d.source} ${d.code}] ${d.message}`)
    .join("\n");
  return `Fix the following ${items.length} compiler/lint problem${items.length === 1 ? "" : "s"} reported by the Switchyard dashboard. Make the smallest correct change, do not disable rules, then re-run the typecheck and linter.\n\n${list}`;
}
