/**
 * OpenCode server-mode driver.
 *
 * Start one server per worktree:   cd <worktree> && opencode serve --port 4096 --hostname 127.0.0.1
 * Docs: https://opencode.ai/docs/server/
 *
 * Endpoints used
 *   GET  /global/health                         -> { healthy, version }
 *   GET  /event                                 -> SSE bus (session.status, session.idle, message.part.updated, permission.*)
 *   GET  /session, /session/status              -> list + busy/idle map
 *   POST /session                               -> create
 *   POST /session/:id/prompt_async              -> send prompt (agent: "plan" | "build")
 *   GET  /session/:id/message                   -> transcript (used to extract a finished plan)
 *   POST /session/:id/abort
 *   POST /session/:id/permissions/:permissionID -> { response: "once" | "always" | "reject" }
 */
import type { AgentMode, AgentSession, Checkpoint, Project, ResolveCheckpoint } from "@shared/schema";
import { store } from "../storage";
import { APPROVE_PLAN_PROMPT, REVISE_PLAN_PROMPT, hooks, newSession, titleFrom, type AgentDriver } from "./base";

interface Conn {
  abort: AbortController;
  retry?: NodeJS.Timeout;
  poll?: NodeJS.Timeout;
}
const conns = new Map<string, Conn>();

const base = (p: Project) => (p.opencodeUrl || "http://127.0.0.1:4096").replace(/\/$/, "");

async function oc<T = any>(p: Project, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(base(p) + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${await res.text().catch(() => "")}`.slice(0, 300));
  if (res.status === 204) return undefined as T;
  const txt = await res.text();
  return (txt ? JSON.parse(txt) : undefined) as T;
}

function setConn(p: Project, state: "connected" | "connecting" | "disconnected", detail: string, version?: string) {
  const prev = store.connections[p.id];
  store.connections[p.id] = { projectId: p.id, state, detail, version: version ?? prev?.version, checkedAt: Date.now() };
  if (prev?.state !== state) {
    if (state === "connected") store.log("success", `${p.name}: OpenCode server connected (${base(p)})`, p.id);
    if (state === "disconnected" && prev?.state === "connected") store.log("warn", `${p.name}: OpenCode server lost — ${detail}`, p.id);
  }
  store.changed(false);
}

/** map an OpenCode session id to our session (create one if the session was started elsewhere, e.g. from the TUI) */
function sessionFor(p: Project, ocId: string, title?: string): AgentSession {
  let s = store.sessions.find((x) => x.projectId === p.id && x.externalId === ocId);
  if (!s) {
    s = newSession(p, title || "OpenCode session", "act", ocId);
    s.status = "idle";
  }
  return s;
}

function modelArg(p: Project) {
  if (!p.model || !p.model.includes("/")) return undefined;
  const [providerID, ...rest] = p.model.split("/");
  return { providerID, modelID: rest.join("/") };
}

async function prompt(p: Project, s: AgentSession, text: string, mode: AgentMode) {
  s.mode = mode;
  store.patchSession(s.id, { status: "busy", mode });
  store.pushMessage(s.id, { role: "user", text, kind: mode });
  await oc(p, "POST", `/session/${s.externalId}/prompt_async`, {
    agent: mode === "plan" ? "plan" : "build",
    model: modelArg(p),
    parts: [{ type: "text", text }],
  });
}

async function lastAssistantText(p: Project, s: AgentSession) {
  const msgs = await oc<any[]>(p, "GET", `/session/${s.externalId}/message?limit=20`);
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i];
    if (m.info?.role === "assistant") {
      const t = (m.parts ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("\n").trim();
      if (t) return t;
    }
  }
  return "";
}

async function onIdle(p: Project, s: AgentSession) {
  if (s.status === "awaiting") return;
  if (s.mode === "plan") {
    const plan = await lastAssistantText(p, s).catch(() => "");
    store.patchSession(s.id, { status: "awaiting" });
    store.addCheckpoint({ projectId: p.id, sessionId: s.id, kind: "plan", title: `Plan ready: ${s.title}`, body: plan || "(empty plan)", source: "opencode" });
    store.log("warn", `${p.name}: plan awaiting approval`, p.id);
  } else {
    store.patchSession(s.id, { status: "idle" });
    await hooks.onActFinished(p, s);
  }
}

function handleEvent(p: Project, ev: { type: string; properties: any }) {
  const pr = ev.properties ?? {};
  switch (ev.type) {
    case "server.connected":
      setConn(p, "connected", "event stream open");
      break;
    case "session.created":
    case "session.updated": {
      const info = pr.info ?? pr;
      if (info?.id) {
        const s = sessionFor(p, info.id, info.title);
        if (info.title && s.title !== info.title) store.patchSession(s.id, { title: info.title });
      }
      break;
    }
    case "session.status": {
      const s = sessionFor(p, pr.sessionID);
      const t = pr.status?.type;
      if (t === "busy" || t === "retry") store.patchSession(s.id, { status: "busy" });
      if (t === "idle") onIdle(p, s);
      break;
    }
    case "session.idle":
      onIdle(p, sessionFor(p, pr.sessionID));
      break;
    case "session.error": {
      const s = pr.sessionID ? sessionFor(p, pr.sessionID) : undefined;
      if (s) {
        store.patchSession(s.id, { status: "error" });
        store.pushMessage(s.id, { role: "system", kind: "error", text: pr.error?.data?.message ?? pr.error?.name ?? "session error" });
      }
      store.log("error", `${p.name}: OpenCode session error`, p.id);
      break;
    }
    case "message.updated": {
      const info = pr.info;
      if (info?.role === "assistant" && info.sessionID) {
        const s = sessionFor(p, info.sessionID);
        const tok = info.tokens ? (info.tokens.input ?? 0) + (info.tokens.output ?? 0) + (info.tokens.reasoning ?? 0) : 0;
        if (tok || info.cost) store.patchSession(s.id, { tokens: Math.max(s.tokens, tok), cost: Math.max(s.cost, info.cost ?? 0), model: info.modelID ?? s.model });
      }
      break;
    }
    case "message.part.updated": {
      const part = pr.part;
      if (!part?.sessionID) break;
      const s = sessionFor(p, part.sessionID);
      if (part.type === "text" && part.text) {
        // user parts echo our own prompt; skip synthetic ones
        if (part.synthetic) break;
        store.pushMessage(s.id, { id: part.id, role: "assistant", kind: "text", text: part.text });
      } else if (part.type === "reasoning" && part.text) {
        store.pushMessage(s.id, { id: part.id, role: "assistant", kind: "reasoning", text: part.text });
      } else if (part.type === "tool") {
        const st = part.state ?? {};
        const label = st.title || JSON.stringify(st.input ?? {}).slice(0, 160);
        store.pushMessage(s.id, { id: part.id, role: "tool", kind: `tool:${part.tool}`, text: `${part.tool} · ${st.status ?? ""} · ${label}` });
      }
      break;
    }
    case "permission.updated":
    case "permission.asked": {
      const s = sessionFor(p, pr.sessionID);
      if (store.checkpoints.some((c) => c.externalRef === pr.id)) break;
      const tool = pr.type ?? pr.permission ?? "tool";
      const meta = pr.metadata ?? {};
      store.patchSession(s.id, { status: "awaiting" });
      store.addCheckpoint({
        projectId: p.id,
        sessionId: s.id,
        kind: "permission",
        tool,
        title: pr.title ?? `Allow ${tool}?`,
        body: meta.command ?? (Array.isArray(pr.patterns) ? pr.patterns.join("\n") : pr.pattern ?? meta.filePath ?? ""),
        diff: meta.diff,
        source: "opencode",
        externalRef: pr.id,
      });
      store.log("warn", `${p.name}: permission requested — ${tool}`, p.id);
      break;
    }
    case "permission.replied": {
      const cp = store.checkpoints.find((c) => c.externalRef === (pr.permissionID ?? pr.requestID ?? pr.id));
      if (cp && cp.status === "pending") {
        cp.status = pr.response === "reject" || pr.reply === "reject" ? "rejected" : "approved";
        cp.resolvedAt = Date.now();
        cp.response = "answered in another client";
        store.changed();
      }
      break;
    }
  }
}

async function streamEvents(p: Project, c: Conn) {
  const res = await fetch(base(p) + "/event", { signal: c.abort.signal, headers: { accept: "text/event-stream" } });
  if (!res.ok || !res.body) throw new Error(`event stream ${res.status}`);
  setConn(p, "connected", "event stream open");
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trim())
        .join("\n");
      if (!data) continue;
      try {
        const ev = JSON.parse(data);
        handleEvent(p, ev.payload ?? ev);
      } catch {
        /* ignore malformed */
      }
    }
  }
  throw new Error("event stream closed");
}

async function syncSessions(p: Project) {
  const [list, status] = await Promise.all([
    oc<any[]>(p, "GET", "/session"),
    oc<Record<string, { type: string }>>(p, "GET", "/session/status").catch(() => ({}) as Record<string, { type: string }>),
  ]);
  for (const info of (list ?? []).slice(0, 25)) {
    const s = sessionFor(p, info.id, info.title);
    const st = status[info.id]?.type;
    if (st === "busy" && s.status !== "busy" && s.status !== "awaiting") store.patchSession(s.id, { status: "busy" });
  }
}

export const opencodeDriver: AgentDriver = {
  async connect(p) {
    this.disconnect(p);
    const c: Conn = { abort: new AbortController() };
    conns.set(p.id, c);
    const loop = async () => {
      if (c.abort.signal.aborted) return;
      setConn(p, "connecting", `probing ${base(p)}`);
      try {
        const h = await oc<{ healthy: boolean; version: string }>(p, "GET", "/global/health").catch(() => oc(p, "GET", "/config").then(() => ({ healthy: true, version: "?" })));
        setConn(p, "connected", "healthy", h?.version);
        await syncSessions(p).catch(() => {});
        await streamEvents(p, c);
      } catch (e: any) {
        if (c.abort.signal.aborted) return;
        setConn(p, "disconnected", e?.cause?.code ?? e.message ?? "unreachable");
      }
      c.retry = setTimeout(loop, 5000);
    };
    loop();
    c.poll = setInterval(() => {
      if (store.connections[p.id]?.state === "connected") syncSessions(p).catch(() => {});
    }, 15000);
  },

  disconnect(p) {
    const c = conns.get(p.id);
    if (!c) return;
    c.abort.abort();
    clearTimeout(c.retry);
    clearInterval(c.poll);
    conns.delete(p.id);
  },

  async startSession(p, text, mode, title) {
    const info = await oc<{ id: string; title: string }>(p, "POST", "/session", { title: title ?? titleFrom(text) });
    const s = sessionFor(p, info.id, title ?? titleFrom(text));
    s.title = title ?? titleFrom(text);
    await prompt(p, s, text, mode);
    store.log("info", `${p.name}: started OpenCode ${mode} session`, p.id);
    return s;
  },

  async sendMessage(p, s, text, mode) {
    await prompt(p, s, text, mode ?? s.mode);
  },

  async abort(p, s) {
    await oc(p, "POST", `/session/${s.externalId}/abort`);
    store.patchSession(s.id, { status: "idle" });
  },

  async resolve(p, cp, d) {
    const s = store.session(cp.sessionId);
    if (!s) throw new Error("session not found");
    if (cp.kind === "permission") {
      const response = d.decision === "approve_always" ? "always" : d.decision === "approve" ? "once" : "reject";
      try {
        await oc(p, "POST", `/session/${s.externalId}/permissions/${cp.externalRef}`, { response });
      } catch {
        // newer servers: POST /permission/:id/reply
        await oc(p, "POST", `/permission/${cp.externalRef}/reply`, { reply: response, message: d.feedback });
      }
      store.patchSession(s.id, { status: "busy" });
      return;
    }
    if (cp.kind === "plan") {
      if (d.decision === "approve" || d.decision === "approve_always") await prompt(p, s, APPROVE_PLAN_PROMPT(cp.body, d.feedback), "act");
      else if (d.decision === "revise") await prompt(p, s, REVISE_PLAN_PROMPT(d.feedback || "Please reconsider the approach."), "plan");
      else store.patchSession(s.id, { status: "done" });
    }
  },
};
