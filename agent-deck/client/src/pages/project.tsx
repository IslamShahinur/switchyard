import { useEffect, useRef, useState } from "react";
import { Link, useParams } from "wouter";
import { Bot, CircleStop, FolderOpen, GitBranch, Loader2, Play, PlugZap, RefreshCw, Send, Wrench } from "lucide-react";
import { LiveDiff, ProblemRow, useFixWithAgent } from "@/components/workbench";
import type { AgentMessage, AgentMode, AgentSession } from "@shared/schema";
import { Page } from "@/components/shell";
import { AgentBadge, DiagChips, Empty, ModeTag, SectionTitle, Spark, StatusPill } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import { ago, useLive, useNow } from "@/lib/live";
import { cn } from "@/lib/utils";

export default function ProjectPage() {
  const { id } = useParams<{ id: string }>();
  const { snap, act } = useLive();
  const { toast } = useToast();
  const now = useNow(1000);
  const [sel, setSel] = useState<string | null>(null);
  const [newOpen, setNewOpen] = useState(false);
  const [view, setView] = useState<"session" | "changes">("session");
  const { fix, busy: fixing } = useFixWithAgent();

  const p = snap?.projects.find((x) => x.id === id);
  if (!snap) return null;
  if (!p) return <Page title="Project not found"><Empty title="This project was removed" /></Page>;

  const sessions = snap.sessions.filter((s) => s.projectId === p.id).sort((a, b) => b.startedAt - a.startedAt);
  const s = sessions.find((x) => x.id === sel) ?? sessions[0];
  const d = snap.diagnostics[p.id];
  const g = snap.git[p.id];
  const c = snap.connections[p.id];
  const pend = snap.checkpoints.filter((x) => x.projectId === p.id && x.status === "pending");

  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      if (ok) toast({ title: ok });
    } catch (e: any) {
      toast({ title: "Request failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Page
      title={
        <span className="flex items-center gap-2.5">
          <span className="h-4 w-1.5 rounded-full" style={{ background: p.color }} />
          {p.name}
        </span>
      }
      sub={
        <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-1 font-mono text-xs"><GitBranch className="size-3" />{g?.branch ?? p.branch}{g?.head && <span className="opacity-60">@{g.head}</span>}</span>
          <span className="flex items-center gap-1 font-mono text-xs"><FolderOpen className="size-3" />{p.worktreePath}</span>
          <AgentBadge agent={p.agent} />
          <span className="text-xs">{c?.state === "simulated" ? "demo simulator" : c?.state}{c?.version && c.version !== "sim" ? ` · v${c.version}` : ""}{p.agent === "opencode" && p.runMode === "live" ? ` · ${p.opencodeUrl}` : ""}</span>
        </span>
      }
      actions={
        <>
          <Button variant="outline" size="sm" onClick={() => run(() => act("POST", `/api/projects/${p.id}/reconnect`), "Reconnected")} data-testid="button-reconnect"><PlugZap />Reconnect</Button>
          <Button variant="outline" size="sm" onClick={() => run(() => act("POST", `/api/projects/${p.id}/diagnostics`))} data-testid="button-run-checks"><RefreshCw className={cn(d?.running && "animate-spin")} />Run checks</Button>
          <Button size="sm" onClick={() => setNewOpen(true)} data-testid="button-new-session"><Play />New session</Button>
        </>
      }
    >
      {pend.length > 0 && (
        <Link href={`/approvals/${pend[0].id}`}>
          <div className="mb-4 flex cursor-pointer items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-4 py-2.5 text-[13px] text-warn hover:bg-warn/15" data-testid="banner-pending">
            <span className="size-2 rounded-full bg-warn sy-pulse" />
            <span className="font-medium">{pend.length} checkpoint{pend.length > 1 ? "s" : ""} waiting:</span> <span className="truncate">{pend[0].title}</span>
            <span className="ml-auto text-xs underline">Review</span>
          </div>
        </Link>
      )}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[240px_minmax(0,1fr)_340px]">
        {/* sessions */}
        <section>
          <SectionTitle right={<span className="text-[11px] text-muted-foreground tnum">{sessions.length}</span>}>Sessions</SectionTitle>
          <div className="space-y-1.5">
            {sessions.length === 0 && <Empty title="No sessions" sub="Start a plan or act session." />}
            {sessions.map((x) => (
              <button key={x.id} onClick={() => setSel(x.id)} data-testid={`button-session-${x.id}`} className={cn("w-full rounded-lg border px-3 py-2 text-left", s?.id === x.id ? "border-primary/50 bg-primary/5" : "border-card-border bg-card hover:border-border")}>
                <div className="flex items-center gap-1.5"><StatusPill status={x.status} /><ModeTag mode={x.mode} /></div>
                <div className="mt-1.5 line-clamp-2 text-[12.5px] font-medium leading-snug">{x.title}</div>
                <div className="mt-1 text-[10.5px] text-muted-foreground tnum">{ago(x.startedAt, now)} · {(x.tokens / 1000).toFixed(1)}k tok · ${x.cost.toFixed(3)}</div>
              </button>
            ))}
          </div>
        </section>

        {/* transcript */}
        <section className="min-w-0">
          <div className="mb-3 flex items-center gap-1">
            {(["session", "changes"] as const).map((v) => (
              <button key={v} onClick={() => setView(v)} data-testid={`tab-${v}`} className={cn("rounded-md px-3 py-1 text-[13px] font-medium", view === v ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {v === "session" ? "Session" : "Changes"}
                {v === "changes" && !!g?.dirty && <span className="ml-1.5 rounded-full bg-warn/15 px-1.5 text-[10px] text-warn tnum">{g.dirty}</span>}
              </button>
            ))}
          </div>
          {view === "session" ? (
            s ? <Transcript s={s} /> : <Empty title="No session selected" />
          ) : (
            <div className="h-[calc(100dvh-260px)] min-h-[420px] rounded-lg border border-card-border bg-card p-3 scroll-y" data-testid="panel-changes">
              <LiveDiff project={p} />
            </div>
          )}
        </section>

        {/* right column */}
        <section className="space-y-5">
          <div>
            <SectionTitle right={<span className="text-[11px] text-muted-foreground tnum">{d?.lastRun ? `${ago(d.lastRun, now)} · ${d.durationMs}ms` : ""}</span>}>Problems</SectionTitle>
            <div className="rounded-lg border border-card-border bg-card">
              <div className="flex items-center gap-3 border-b border-border px-3 py-2">
                <DiagChips d={d} />
                <Spark data={d?.history ?? []} className="ml-auto" w={64} />
                {!!d?.items.length && (
                  <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" onClick={() => fix(p, undefined, "all")} disabled={fixing === "all"} data-testid="button-fix-all">
                    {fixing === "all" ? <Loader2 className="animate-spin" /> : <Bot />}Fix all
                  </Button>
                )}
              </div>
              {d?.cmdError && <div className="border-b border-border px-3 py-2 font-mono text-[11px] text-err">{d.cmdError}</div>}
              <div className="max-h-[360px] scroll-y">
                {d?.items.length === 0 && <div className="px-3 py-4 text-center text-xs text-ok">tsc and eslint are clean</div>}
                {d?.items.map((i) => {
                  const key = `${i.file}:${i.line}:${i.code}`;
                  return <ProblemRow key={key} d={i} project={p} onFix={() => fix(p, [i], key)} fixing={fixing === key} />;
                })}
              </div>
            </div>
          </div>
          <div>
            <SectionTitle right={g?.ok ? <span className="text-[11px] text-muted-foreground">↑{g.ahead} vs main</span> : null}>Working tree</SectionTitle>
            <div className="rounded-lg border border-card-border bg-card px-3 py-2">
              {g?.ok ? (
                <>
                  <div className="truncate font-mono text-[11.5px] text-muted-foreground"><span className="text-foreground/80">{g.head}</span> {g.headMsg}</div>
                  {g.files.length === 0 ? <div className="py-2 text-xs text-muted-foreground">clean</div> : (
                    <div className="mt-1.5 space-y-0.5">
                      {g.files.map((f) => (
                        <div key={f.path} className="flex gap-2 font-mono text-[11.5px]">
                          <span className={cn("w-5", f.status.includes("?") || f.status.includes("A") ? "text-ok" : f.status.includes("D") ? "text-err" : "text-warn")}>{f.status}</span>
                          <span className="truncate">{f.path}</span>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="py-2 text-xs text-err">{g?.error ?? "loading…"}</div>
              )}
            </div>
          </div>
          <div className="rounded-lg border border-border px-3 py-2.5 font-mono text-[10.5px] leading-relaxed text-muted-foreground">
            <div className="mb-1 flex items-center gap-1.5 font-sans text-[11px] font-medium text-foreground/80"><Wrench className="size-3" />Checks</div>
            <div className="truncate" title={p.typecheckCmd}>tsc: {p.typecheckCmd.replace(/^.*\/(tsc)/, "$1")}</div>
            <div className="truncate" title={p.lintCmd}>lint: {p.lintCmd.replace(/^.*\/(eslint)/, "$1")}</div>
          </div>
        </section>
      </div>

      <NewSessionDialog open={newOpen} onOpenChange={setNewOpen} projectId={p.id} onCreated={(sid) => setSel(sid)} />
    </Page>
  );
}

function Transcript({ s }: { s: AgentSession }) {
  const { act } = useLive();
  const { toast } = useToast();
  const [text, setText] = useState("");
  const [mode, setMode] = useState<AgentMode>(s.mode);
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => end.current?.scrollIntoView({ block: "nearest" }), [s.messages.length]);
  useEffect(() => setMode(s.mode), [s.id, s.mode]);

  const send = async () => {
    if (!text.trim()) return;
    try {
      await act("POST", `/api/sessions/${s.id}/message`, { text, mode });
      setText("");
    } catch (e: any) {
      toast({ title: "Send failed", description: e.message, variant: "destructive" });
    }
  };

  return (
    <div className="flex h-[calc(100dvh-260px)] min-h-[420px] flex-col rounded-lg border border-card-border bg-card">
      <div className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <StatusPill status={s.status} />
        <ModeTag mode={s.mode} />
        <div className="min-w-0 flex-1 truncate text-[13px] font-medium">{s.title}</div>
        {s.status === "busy" && (
          <Button size="sm" variant="ghost" className="text-err hover:text-err" onClick={() => act("POST", `/api/sessions/${s.id}/abort`)} data-testid="button-abort"><CircleStop />Abort</Button>
        )}
      </div>
      <div className="flex-1 space-y-2 px-4 py-3 scroll-y" data-testid="list-transcript">
        {s.messages.map((m) => <Msg key={m.id} m={m} />)}
        {s.status === "busy" && <div className="flex items-center gap-2 pl-1 text-xs text-run"><span className="size-1.5 rounded-full bg-run sy-pulse" />working…</div>}
        <div ref={end} />
      </div>
      <div className="border-t border-border p-3">
        <Textarea value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) send(); }} placeholder="Message the agent… (⌘/Ctrl + Enter)" className="min-h-[60px] resize-none text-[13px]" data-testid="input-message" />
        <div className="mt-2 flex items-center gap-2">
          <ModeSwitch mode={mode} onChange={setMode} />
          <Button size="sm" className="ml-auto" onClick={send} disabled={!text.trim()} data-testid="button-send"><Send />Send</Button>
        </div>
      </div>
    </div>
  );
}

function Msg({ m }: { m: AgentMessage }) {
  if (m.role === "user")
    return (
      <div className="ml-auto w-fit max-w-[85%] rounded-lg rounded-br-sm bg-primary/12 px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap">
        {m.text.length > 600 ? m.text.slice(0, 600) + "…" : m.text}
      </div>
    );
  if (m.role === "tool")
    return <pre className="rounded-md border border-border bg-background/60 px-3 py-1.5 font-mono text-[11.5px] leading-snug text-muted-foreground whitespace-pre-wrap">{m.text}</pre>;
  if (m.role === "system") return <div className="font-mono text-[11px] text-muted-foreground whitespace-pre-wrap">— {m.text}</div>;
  if (m.kind === "reasoning") return <div className="border-l-2 border-border pl-3 text-[12.5px] text-muted-foreground">{m.text}</div>;
  return (
    <div className={cn("max-w-[92%] text-[13px] leading-relaxed whitespace-pre-wrap", m.kind === "plan" && "rounded-md border border-chart-3/25 bg-chart-3/5 p-3")}>
      {m.text}
    </div>
  );
}

function ModeSwitch({ mode, onChange }: { mode: AgentMode; onChange: (m: AgentMode) => void }) {
  return (
    <div className="flex rounded-md border border-border p-0.5" role="radiogroup" aria-label="Agent mode">
      {(["plan", "act"] as const).map((m) => (
        <button key={m} role="radio" aria-checked={mode === m} onClick={() => onChange(m)} data-testid={`toggle-mode-${m}`} className={cn("rounded px-2.5 py-1 font-mono text-[11px] uppercase tracking-wider", mode === m ? (m === "plan" ? "bg-chart-3/15 text-chart-3" : "bg-primary/15 text-primary") : "text-muted-foreground")}>
          {m}
        </button>
      ))}
    </div>
  );
}

export function NewSessionDialog({ open, onOpenChange, projectId, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; projectId: string; onCreated?: (id: string) => void }) {
  const { act } = useLive();
  const { toast } = useToast();
  const [prompt, setPrompt] = useState("");
  const [title, setTitle] = useState("");
  const [mode, setMode] = useState<AgentMode>("plan");
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      const s = await act<AgentSession>("POST", `/api/projects/${projectId}/sessions`, { prompt, mode, title: title || undefined });
      onCreated?.(s.id);
      onOpenChange(false);
      setPrompt("");
      setTitle("");
    } catch (e: any) {
      toast({ title: "Could not start session", description: e.message, variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>New agent session</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Title (optional)" data-testid="input-session-title" />
          <Textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What should the agent do?" className="min-h-[120px]" data-testid="input-session-prompt" />
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <ModeSwitch mode={mode} onChange={setMode} />
            {mode === "plan" ? "Agent proposes a plan; you approve before it edits." : "Agent edits immediately; diff review at the end."}
          </div>
        </div>
        <DialogFooter>
          <Button onClick={submit} disabled={!prompt.trim() || busy} data-testid="button-create-session"><Play />{busy ? "Starting…" : "Start"}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
