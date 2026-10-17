import { Link } from "wouter";
import { ArrowUpRight, GitBranch, GitCommitHorizontal, Play, RefreshCw } from "lucide-react";
import type { Activity, Project, Snapshot } from "@shared/schema";
import { Page } from "@/components/shell";
import { AgentBadge, ConnDot, DiagChips, Empty, Kpi, ModeTag, SectionTitle, Spark, StatusPill, lastLine } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { ago, clock, describeCron, until, useLive, useNow } from "@/lib/live";
import { cn } from "@/lib/utils";

export default function Overview() {
  const { snap } = useLive();
  const now = useNow(1000);
  if (!snap) return <OverviewSkeleton />;

  const live = snap.sessions.filter((s) => s.status === "busy" || s.status === "awaiting");
  const pending = snap.checkpoints.filter((c) => c.status === "pending");
  const diag = Object.values(snap.diagnostics);
  const errors = diag.reduce((a, d) => a + d.tscErrors + d.lintErrors, 0);
  const warnings = diag.reduce((a, d) => a + d.lintWarnings, 0);
  const clean = diag.filter((d) => d.status === "pass").length;
  const nextSch = snap.schedules.filter((s) => s.enabled && s.nextRun).sort((a, b) => a.nextRun! - b.nextRun!)[0];
  const cost = snap.sessions.reduce((a, s) => a + s.cost, 0);

  return (
    <Page title="Overview" sub={`${snap.projects.length} projects across git worktrees · updated ${ago(snap.now, now)}`}>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-5">
        <Kpi testid="kpi-sessions" label="Active sessions" value={live.length} tone={live.length ? "run" : undefined} sub={`${snap.sessions.filter((s) => s.status === "busy").length} running · ${snap.sessions.length} total`} />
        <Kpi testid="kpi-approvals" label="Awaiting review" value={pending.length} tone={pending.length ? "warn" : "ok"} sub={pending.length ? [["plan", "plans"], ["permission", "permissions"], ["review", "diffs"]].map(([k, l]) => [pending.filter((p) => p.kind === k).length, l] as const).filter(([n]) => n).map(([n, l]) => `${n} ${n === 1 ? l.replace(/s$/, "") : l}`).join(" · ") : "queue clear"} />
        <Kpi testid="kpi-errors" label="Build errors" value={errors} tone={errors ? "err" : "ok"} sub={`${warnings} lint warnings · ${clean}/${snap.projects.length} clean`} />
        <Kpi testid="kpi-cost" label="Session spend" value={`$${cost.toFixed(2)}`} sub={`${(snap.sessions.reduce((a, s) => a + s.tokens, 0) / 1000).toFixed(1)}k tokens`} />
        <Kpi testid="kpi-schedule" label="Next scheduled" value={nextSch ? until(nextSch.nextRun, now) : "—"} sub={nextSch ? `${nextSch.name} · ${describeCron(nextSch.cron)}` : "no active schedules"} />
      </div>

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <section className="min-w-0">
          <SectionTitle right={<span className="text-xs text-muted-foreground">one agent per worktree</span>}>Tracks</SectionTitle>
          {snap.projects.length === 0 ? (
            <Empty title="No projects yet" sub="Add a git worktree in Projects & setup." />
          ) : (
            <div className="grid grid-cols-1 gap-3 lg:grid-cols-2">
              {snap.projects.map((p) => (
                <ProjectCard key={p.id} p={p} snap={snap} now={now} />
              ))}
            </div>
          )}
        </section>

        <aside className="min-w-0 space-y-6">
          <section>
            <SectionTitle right={<Link href="/approvals" className="text-xs text-primary hover:underline" data-testid="link-all-approvals">Open queue</Link>}>Review queue</SectionTitle>
            <div className="space-y-2">
              {pending.length === 0 && <Empty title="Nothing to review" sub="Plan and act checkpoints show up here." />}
              {pending.slice(0, 5).map((c) => {
                const p = snap.projects.find((x) => x.id === c.projectId);
                return (
                  <Link key={c.id} href={`/approvals/${c.id}`} data-testid={`link-checkpoint-${c.id}`}>
                    <div className="group cursor-pointer rounded-lg border border-card-border bg-card px-3 py-2.5 hover:border-warn/40">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <span className="h-2.5 w-1 rounded-full" style={{ background: p?.color }} />
                        <span className="truncate">{p?.name}</span>
                        <span className="ml-auto font-mono uppercase tracking-wider text-warn">{c.kind === "permission" ? c.tool : c.kind}</span>
                      </div>
                      <div className="mt-1 truncate text-[13px] font-medium">{c.title}</div>
                      <div className="mt-0.5 text-[11px] text-muted-foreground">waiting {ago(c.createdAt, now).replace(" ago", "")}</div>
                    </div>
                  </Link>
                );
              })}
            </div>
          </section>
          <section>
            <SectionTitle>Activity</SectionTitle>
            <ActivityFeed items={snap.activity} projects={snap.projects} />
          </section>
        </aside>
      </div>
    </Page>
  );
}

function ProjectCard({ p, snap, now }: { p: Project; snap: Snapshot; now: number }) {
  const { act } = useLive();
  const sessions = snap.sessions.filter((s) => s.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt);
  const s = sessions[0];
  const d = snap.diagnostics[p.id];
  const g = snap.git[p.id];
  const c = snap.connections[p.id];
  const pend = snap.checkpoints.filter((x) => x.projectId === p.id && x.status === "pending");
  const busy = s?.status === "busy";

  return (
    <article data-testid={`card-project-${p.id}`} className={cn("relative min-w-0 overflow-hidden rounded-lg border bg-card", pend.length ? "border-warn/35" : "border-card-border")}>
      {/* track line */}
      <div className="absolute inset-x-0 top-0 h-[3px]" style={{ background: p.color, opacity: 0.85 }} />
      {busy && <div className="sy-flow absolute inset-x-0 top-0 h-[3px] opacity-60" style={{ color: "hsl(var(--background))" }} />}

      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <Link href={`/p/${p.id}`} className="truncate text-[15px] font-semibold hover:underline" data-testid={`link-open-${p.id}`}>{p.name}</Link>
              <ConnDot c={c} />
            </div>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
              <span className="flex items-center gap-1 font-mono"><GitBranch className="size-3" />{g?.branch ?? p.branch}</span>
              {g?.ok && <span className="flex items-center gap-1 font-mono"><GitCommitHorizontal className="size-3" />{g.head}</span>}
              {g && g.dirty > 0 && <span className="font-mono text-warn">{g.dirty} changed</span>}
              {g && g.ahead > 0 && <span className="font-mono">↑{g.ahead}</span>}
            </div>
          </div>
          <AgentBadge agent={p.agent} />
        </div>

        <div className="mt-4 rounded-md border border-border bg-background/50 p-3">
          {s ? (
            <>
              <div className="flex items-center gap-2">
                <StatusPill status={s.status} />
                <ModeTag mode={s.mode} />
                <span className="ml-auto text-[11px] text-muted-foreground tnum">{ago(s.updatedAt, now)}</span>
              </div>
              <div className="mt-2 truncate text-[13px] font-medium" title={s.title}>{s.title}</div>
              <div className="mt-1 line-clamp-2 min-h-[2.5em] font-mono text-[11.5px] leading-snug text-muted-foreground">{lastLine(s) || "…"}</div>
            </>
          ) : (
            <div className="flex items-center justify-between gap-2 text-[13px] text-muted-foreground">
              No session yet
              <Link href={`/p/${p.id}`}><Button size="sm" variant="secondary" data-testid={`button-start-${p.id}`}><Play className="size-3.5" />Start</Button></Link>
            </div>
          )}
        </div>

        <div className="mt-3 flex items-center gap-3">
          <DiagChips d={d} />
          <Spark data={d?.history ?? []} className="ml-auto" />
          <button
            onClick={() => act("POST", `/api/projects/${p.id}/diagnostics`)}
            data-testid={`button-recheck-${p.id}`}
            className="grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            aria-label="Re-run checks"
          >
            <RefreshCw className={cn("size-3.5", d?.running && "animate-spin")} />
          </button>
        </div>
        {d?.items.filter((i) => i.severity === "error").slice(0, 1).map((i, k) => (
          <div key={k} className="mt-2 truncate font-mono text-[11px] text-err/90" title={i.message}>
            {i.file}:{i.line} {i.code} {i.message}
          </div>
        ))}

        {pend.length > 0 && (
          <Link href={`/approvals/${pend[0].id}`} data-testid={`link-review-${p.id}`}>
            <div className="mt-3 flex cursor-pointer items-center gap-2 rounded-md bg-warn/10 px-3 py-2 text-xs font-medium text-warn hover:bg-warn/15">
              <span className="size-1.5 rounded-full bg-warn sy-pulse" />
              {pend.length === 1 ? pend[0].title : `${pend.length} checkpoints waiting`}
              <ArrowUpRight className="ml-auto size-3.5" />
            </div>
          </Link>
        )}
      </div>
    </article>
  );
}

export function ActivityFeed({ items, projects, limit = 18 }: { items: Activity[]; projects: Project[]; limit?: number }) {
  const list = [...items].reverse().slice(0, limit);
  const tone = { info: "bg-muted-foreground/50", warn: "bg-warn", error: "bg-err", success: "bg-ok" } as const;
  return (
    <ol className="relative space-y-0 border-l border-border pl-4">
      {list.map((a) => {
        const p = projects.find((x) => x.id === a.projectId);
        return (
          <li key={a.id} className="relative pb-3" data-testid={`row-activity-${a.id}`}>
            <span className={cn("absolute -left-[20.5px] top-1.5 size-2 rounded-full ring-4 ring-background", tone[a.level])} />
            <div className="text-[12.5px] leading-snug">{a.text}</div>
            <div className="mt-0.5 flex items-center gap-1.5 text-[10.5px] text-muted-foreground tnum">
              {clock(a.ts)}
              {p && <span className="h-2 w-0.5 rounded-full" style={{ background: p.color }} />}
            </div>
          </li>
        );
      })}
    </ol>
  );
}

function OverviewSkeleton() {
  return (
    <div className="mx-auto max-w-[1440px] px-7 py-5">
      <Skeleton className="h-6 w-40" />
      <div className="mt-6 grid grid-cols-5 gap-3">{[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-[76px]" />)}</div>
      <div className="mt-8 grid grid-cols-2 gap-3">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[250px]" />)}</div>
    </div>
  );
}
