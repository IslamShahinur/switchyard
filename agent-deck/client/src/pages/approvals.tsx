import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useParams } from "wouter";
import { Check, CheckCheck, FileDiff as FileDiffIcon, GitCommitHorizontal, ListChecks, MessageSquareWarning, ShieldQuestion, TerminalSquare, Trash2, X } from "lucide-react";
import type { Checkpoint, ResolveCheckpoint, Snapshot } from "@shared/schema";
import { Page } from "@/components/shell";
import { AgentBadge, DiagChips, Empty, Markdown, ModeTag } from "@/components/bits";
import { FileDiff } from "@/components/workbench";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { ago, useLive, useNow } from "@/lib/live";
import { cn } from "@/lib/utils";

const kindIcon = { plan: ListChecks, permission: ShieldQuestion, review: FileDiffIcon } as const;
const kindLabel = { plan: "Plan → Act", permission: "Permission", review: "Diff review" } as const;

export default function Approvals() {
  const { snap } = useLive();
  const params = useParams<{ id?: string }>();
  const [, nav] = useLocation();
  const [tab, setTab] = useState<"pending" | "history">("pending");
  const [kind, setKind] = useState<"all" | Checkpoint["kind"]>("all");
  const now = useNow(1000);

  const list = useMemo(() => {
    if (!snap) return [];
    return snap.checkpoints
      .filter((c) => (tab === "pending" ? c.status === "pending" : c.status !== "pending"))
      .filter((c) => kind === "all" || c.kind === kind)
      .sort((a, b) => (tab === "pending" ? a.createdAt - b.createdAt : (b.resolvedAt ?? 0) - (a.resolvedAt ?? 0)));
  }, [snap, tab, kind]);

  const selected = snap?.checkpoints.find((c) => c.id === params.id) ?? list[0];

  // keyboard: j/k navigate
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("textarea,input")) return;
      const i = list.findIndex((c) => c.id === selected?.id);
      if (e.key === "j" && list[i + 1]) nav(`/approvals/${list[i + 1].id}`);
      if (e.key === "k" && list[i - 1]) nav(`/approvals/${list[i - 1].id}`);
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [list, selected, nav]);

  if (!snap) return null;
  const pendingCount = snap.checkpoints.filter((c) => c.status === "pending").length;

  return (
    <Page title="Approvals" sub="Plan/act checkpoints, tool permissions and diff reviews from every worktree" actions={<span className="hidden text-[11px] text-muted-foreground md:block">j / k to move · a approve · r reject</span>}>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[340px_minmax(0,1fr)]">
        <div>
          <div className="mb-2 flex items-center gap-1 rounded-lg border border-border bg-card p-1">
            {(["pending", "history"] as const).map((t) => (
              <button key={t} data-testid={`tab-${t}`} onClick={() => setTab(t)} className={cn("flex-1 rounded-md px-3 py-1.5 text-xs font-medium capitalize", tab === t ? "bg-accent text-foreground" : "text-muted-foreground hover:text-foreground")}>
                {t} {t === "pending" && <span className="tnum">({pendingCount})</span>}
              </button>
            ))}
          </div>
          <div className="mb-3 flex flex-wrap gap-1">
            {(["all", "plan", "permission", "review"] as const).map((k) => (
              <button key={k} data-testid={`filter-${k}`} onClick={() => setKind(k)} className={cn("rounded-full border px-2.5 py-0.5 text-[11px]", kind === k ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:text-foreground")}>
                {k === "all" ? "All" : kindLabel[k]}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            {list.length === 0 && <Empty icon={<CheckCheck className="size-5" />} title={tab === "pending" ? "Queue clear" : "No history yet"} sub={tab === "pending" ? "Agents will park here when they need a decision." : undefined} />}
            {list.map((c) => {
              const p = snap.projects.find((x) => x.id === c.projectId);
              const Icon = kindIcon[c.kind];
              return (
                <Link key={c.id} href={`/approvals/${c.id}`} data-testid={`row-checkpoint-${c.id}`}>
                  <div className={cn("cursor-pointer rounded-lg border px-3 py-2.5 transition-colors", selected?.id === c.id ? "border-primary/50 bg-primary/5" : "border-card-border bg-card hover:border-border")}>
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <span className="h-2.5 w-1 rounded-full" style={{ background: p?.color }} />
                      <span className="truncate">{p?.name}</span>
                      <span className="ml-auto flex items-center gap-1"><Icon className="size-3" />{c.kind === "permission" ? c.tool : kindLabel[c.kind]}</span>
                    </div>
                    <div className="mt-1 line-clamp-2 text-[13px] font-medium leading-snug">{c.title}</div>
                    <div className="mt-1 text-[11px] text-muted-foreground tnum">
                      {c.status === "pending" ? `waiting ${ago(c.createdAt, now).replace(" ago", "")}` : <span className={c.status === "rejected" ? "text-err" : c.status === "revised" ? "text-chart-3" : "text-ok"}>{c.status} · {ago(c.resolvedAt, now)}</span>}
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </div>
        <div className="min-w-0">{selected ? <Detail key={selected.id} cp={selected} snap={snap} next={() => {
          const rest = list.filter((c) => c.id !== selected.id && c.status === "pending");
          nav(rest[0] ? `/approvals/${rest[0].id}` : "/approvals");
        }} /> : <Empty title="Select a checkpoint" />}</div>
      </div>
    </Page>
  );
}

function Detail({ cp, snap, next }: { cp: Checkpoint; snap: Snapshot; next: () => void }) {
  const { act } = useLive();
  const { toast } = useToast();
  const [feedback, setFeedback] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const p = snap.projects.find((x) => x.id === cp.projectId)!;
  const s = snap.sessions.find((x) => x.id === cp.sessionId);
  const d = snap.diagnostics[cp.projectId];
  const pending = cp.status === "pending";
  const now = useNow(1000);

  const resolve = async (decision: ResolveCheckpoint["decision"]) => {
    if (decision === "revise" && !feedback.trim()) {
      toast({ title: "Add feedback first", description: "Tell the agent what to change." });
      return;
    }
    setBusy(decision);
    try {
      await act("POST", `/api/checkpoints/${cp.id}/resolve`, { decision, feedback: feedback.trim() || undefined });
      toast({ title: decision === "reject" ? "Rejected" : decision === "revise" ? "Sent back for changes" : "Approved", description: `${p.name} · ${cp.title}` });
      next();
    } catch (e: any) {
      toast({ title: "Could not resolve", description: e.message, variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };

  useEffect(() => {
    if (!pending) return;
    const h = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement)?.closest("textarea,input") || e.metaKey || e.ctrlKey) return;
      if (e.key === "a") resolve("approve");
      if (e.key === "r") cp.kind === "review" ? setConfirmDiscard(true) : resolve("reject");
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  });

  const labels =
    cp.kind === "plan"
      ? { approve: "Approve & switch to Act", always: null, revise: "Request plan changes", reject: "Reject plan" }
      : cp.kind === "permission"
        ? { approve: "Allow once", always: `Always allow ${cp.tool}`, revise: null, reject: "Deny" }
        : { approve: "Approve & commit", always: null, revise: "Request changes", reject: "Discard changes" };

  return (
    <div className="rounded-lg border border-card-border bg-card" data-testid="panel-checkpoint">
      <div className="border-b border-border p-4">
        <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
          <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5">
            <span className="size-2 rounded-full" style={{ background: p.color }} />
            {p.name}
          </span>
          <span className="font-mono">{p.branch}</span>
          <AgentBadge agent={cp.source} />
          {s && <ModeTag mode={s.mode} />}
          <span className="ml-auto tnum">{pending ? `raised ${ago(cp.createdAt, now)}` : `${cp.status} ${ago(cp.resolvedAt, now)}`}</span>
        </div>
        <h2 className="mt-2 text-[15px] font-semibold">{cp.title}</h2>
        {s && <div className="mt-0.5 text-xs text-muted-foreground">Session: <Link href={`/p/${p.id}`} className="hover:underline">{s.title}</Link></div>}
      </div>

      <div className="space-y-4 p-4">
        {cp.kind === "plan" && (
          <div className="rounded-md border border-chart-3/25 bg-chart-3/5 p-4">
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-chart-3"><ListChecks className="size-3.5" />Proposed plan</div>
            <Markdown text={cp.body} />
          </div>
        )}
        {cp.kind === "permission" && (
          <div>
            <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-warn">
              {cp.tool === "bash" ? <TerminalSquare className="size-3.5" /> : <ShieldQuestion className="size-3.5" />}
              Agent wants to run <span className="font-mono normal-case">{cp.tool}</span>
            </div>
            {cp.body && <pre className="rounded-md border border-border bg-background/60 px-3 py-2 font-mono text-[12.5px]">{cp.tool === "bash" ? `$ ${cp.body}` : cp.body}</pre>}
          </div>
        )}
        {cp.kind === "review" && (
          <div className="space-y-3">
            <Markdown text={cp.body} />
            <div className="flex items-center gap-3 rounded-md border border-border bg-background/50 px-3 py-2 text-xs">
              <span className="text-muted-foreground">Current diagnostics</span>
              <DiagChips d={d} />
            </div>
          </div>
        )}
        {cp.diff && (
          <div>
            <div className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground"><FileDiffIcon className="size-3.5" />{cp.kind === "review" ? "Worktree diff vs HEAD" : "Proposed change"}</div>
            <FileDiff diff={cp.diff} maxHeight={420} />
          </div>
        )}

        {s && s.messages.length > 0 && (
          <details className="rounded-md border border-border">
            <summary className="cursor-pointer select-none px-3 py-2 text-xs text-muted-foreground">Recent session context ({Math.min(6, s.messages.length)} messages)</summary>
            <div className="space-y-1.5 border-t border-border px-3 py-2">
              {s.messages.slice(-6).map((m) => (
                <div key={m.id} className="font-mono text-[11.5px] leading-snug text-muted-foreground"><span className="text-foreground/70">{m.role}</span> {m.text.slice(0, 220)}</div>
              ))}
            </div>
          </details>
        )}

        {pending ? (
          <div className="space-y-3 border-t border-border pt-4">
            <Textarea
              value={feedback}
              onChange={(e) => setFeedback(e.target.value)}
              placeholder={cp.kind === "plan" ? "Notes for the agent (sent with approval or revision request)…" : cp.kind === "review" ? "Commit notes or requested changes…" : "Reason (optional, sent to the agent on deny)…"}
              className="min-h-[72px] resize-y text-[13px]"
              data-testid="input-feedback"
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button onClick={() => resolve("approve")} disabled={!!busy} data-testid="button-approve">
                {cp.kind === "review" ? <GitCommitHorizontal /> : <Check />}
                {busy === "approve" ? "Working…" : labels.approve}
                <kbd className="ml-1 rounded bg-primary-foreground/15 px-1 font-mono text-[10px]">A</kbd>
              </Button>
              {labels.always && (
                <Button variant="secondary" onClick={() => resolve("approve_always")} disabled={!!busy} data-testid="button-approve-always">
                  <CheckCheck />
                  {labels.always}
                </Button>
              )}
              {labels.revise && (
                <Button variant="secondary" onClick={() => resolve("revise")} disabled={!!busy} data-testid="button-revise">
                  <MessageSquareWarning />
                  {labels.revise}
                </Button>
              )}
              <Button
                variant="outline"
                className="ml-auto border-err/40 text-err hover:bg-err/10 hover:text-err"
                onClick={() => (cp.kind === "review" ? setConfirmDiscard(true) : resolve("reject"))}
                disabled={!!busy}
                data-testid="button-reject"
              >
                {cp.kind === "review" ? <Trash2 /> : <X />}
                {labels.reject}
              </Button>
            </div>
          </div>
        ) : (
          <div className="rounded-md border border-border bg-muted/40 px-3 py-2 text-xs text-muted-foreground">
            Resolved: <span className="font-medium text-foreground">{cp.response}</span>
            {cp.feedback && <> · “{cp.feedback}”</>}
          </div>
        )}
      </div>

      <AlertDialog open={confirmDiscard} onOpenChange={setConfirmDiscard}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard all uncommitted changes?</AlertDialogTitle>
            <AlertDialogDescription>
              This runs <code className="font-mono">git checkout -- . && git clean -fd</code> in <code className="font-mono">{p.worktreePath}</code>. It can’t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel data-testid="button-cancel-discard">Keep changes</AlertDialogCancel>
            <AlertDialogAction data-testid="button-confirm-discard" className="bg-err text-white hover:bg-err/90" onClick={() => resolve("reject")}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
