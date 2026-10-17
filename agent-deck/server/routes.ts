import type { Express, Request, Response } from "express";
import type { Server } from "node:http";
import { insertProjectSchema, insertScheduleSchema, resolveCheckpointSchema, sendMessageSchema, startSessionSchema } from "@shared/schema";
import { store } from "./storage";
import { gitDiff, listWorktrees, nextCron, readSnippet, refreshGit, runDiagnostics } from "./monitors";
import {
  boot,
  createProject,
  driverFor,
  fixWithAgent,
  removeProject,
  resetDemo,
  resolveCheckpoint,
  runSchedule,
  updateProject,
  upsertSchedule,
} from "./hub";

const wrap =
  (fn: (req: Request, res: Response) => Promise<unknown> | unknown) =>
  async (req: Request, res: Response) => {
    try {
      const out = await fn(req, res);
      if (!res.headersSent) res.json(out ?? { ok: true });
    } catch (e: any) {
      res.status(e?.issues ? 400 : 500).json({ message: e?.issues ? e.issues.map((i: any) => `${i.path.join(".")}: ${i.message}`).join("; ") : e.message });
    }
  };

export async function registerRoutes(httpServer: Server, app: Express): Promise<Server> {
  await boot();

  /* -------- live state -------- */
  app.get("/api/snapshot", (_req, res) => res.json(store.snapshot()));

  // Server-sent events: pushes a full snapshot on every change (throttled)
  app.get("/api/stream", (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    let timer: NodeJS.Timeout | undefined;
    const send = () => {
      timer = undefined;
      res.write(`data: ${JSON.stringify(store.snapshot())}\n\n`);
    };
    const onChange = () => {
      if (!timer) timer = setTimeout(send, 250);
    };
    send();
    store.on("change", onChange);
    const ping = setInterval(() => res.write(": ping\n\n"), 15000);
    req.on("close", () => {
      store.off("change", onChange);
      clearInterval(ping);
      clearTimeout(timer);
    });
  });

  /* -------- projects / worktrees -------- */
  app.get("/api/worktrees", wrap((req) => listWorktrees(String(req.query.repo ?? ""))));
  app.post("/api/projects", wrap((req) => createProject(insertProjectSchema.parse(req.body))));
  app.patch("/api/projects/:id", wrap((req) => updateProject(String(req.params.id), req.body)));
  app.delete("/api/projects/:id", wrap((req) => removeProject(String(req.params.id), req.query.worktree === "1")));
  app.post(
    "/api/projects/:id/diagnostics",
    wrap(async (req) => {
      const p = store.project(String(req.params.id));
      if (!p) throw new Error("project not found");
      await Promise.all([runDiagnostics(p), refreshGit(p)]);
    }),
  );
  app.post(
    "/api/projects/:id/reconnect",
    wrap(async (req) => {
      const p = store.project(String(req.params.id));
      if (!p) throw new Error("project not found");
      await driverFor(p).connect(p);
    }),
  );

  app.get(
    "/api/projects/:id/diff",
    wrap(async (req) => {
      const p = store.project(String(req.params.id));
      if (!p) throw new Error("project not found");
      return { diff: await gitDiff(p) };
    }),
  );
  app.get(
    "/api/projects/:id/snippet",
    wrap((req) => {
      const p = store.project(String(req.params.id));
      if (!p) throw new Error("project not found");
      return readSnippet(p, String(req.query.file ?? ""), Number(req.query.line ?? 1));
    }),
  );
  app.post(
    "/api/projects/:id/fix",
    wrap((req) => fixWithAgent(String(req.params.id), req.body?.items, req.body?.mode === "plan" ? "plan" : "act")),
  );

  /* -------- sessions -------- */
  app.post(
    "/api/projects/:id/sessions",
    wrap(async (req) => {
      const p = store.project(String(req.params.id));
      if (!p) throw new Error("project not found");
      const b = startSessionSchema.parse(req.body);
      return driverFor(p).startSession(p, b.prompt, b.mode, b.title);
    }),
  );
  app.post(
    "/api/sessions/:id/message",
    wrap(async (req) => {
      const s = store.session(String(req.params.id));
      const p = s && store.project(s.projectId);
      if (!s || !p) throw new Error("session not found");
      const b = sendMessageSchema.parse(req.body);
      await driverFor(p).sendMessage(p, s, b.text, b.mode);
    }),
  );
  app.post(
    "/api/sessions/:id/abort",
    wrap(async (req) => {
      const s = store.session(String(req.params.id));
      const p = s && store.project(s.projectId);
      if (!s || !p) throw new Error("session not found");
      await driverFor(p).abort(p, s);
    }),
  );

  /* -------- checkpoints -------- */
  app.post("/api/checkpoints/:id/resolve", wrap((req) => resolveCheckpoint(String(req.params.id), resolveCheckpointSchema.parse(req.body))));

  /* -------- schedules -------- */
  app.post("/api/schedules", wrap((req) => upsertSchedule(insertScheduleSchema.parse(req.body))));
  app.put("/api/schedules/:id", wrap((req) => upsertSchedule(insertScheduleSchema.parse(req.body), String(req.params.id))));
  app.patch(
    "/api/schedules/:id",
    wrap((req) => {
      const s = store.schedules.find((x) => x.id === req.params.id);
      if (!s) throw new Error("schedule not found");
      if (typeof req.body.enabled === "boolean") s.enabled = req.body.enabled;
      s.nextRun = s.enabled ? nextCron(s.cron) : undefined;
      store.changed();
      return s;
    }),
  );
  app.delete(
    "/api/schedules/:id",
    wrap((req) => {
      store.schedules = store.schedules.filter((x) => x.id !== req.params.id);
      store.changed();
    }),
  );
  app.post("/api/schedules/:id/run", wrap((req) => runSchedule(String(req.params.id))));
  app.get(
    "/api/cron/preview",
    wrap((req) => {
      const out: number[] = [];
      let t = Date.now();
      for (let i = 0; i < 3; i++) {
        const n = nextCron(String(req.query.expr ?? ""), t);
        if (!n) break;
        out.push(n);
        t = n;
      }
      return out;
    }),
  );

  /* -------- demo -------- */
  app.post("/api/demo/reset", wrap(() => resetDemo()));

  return httpServer;
}
