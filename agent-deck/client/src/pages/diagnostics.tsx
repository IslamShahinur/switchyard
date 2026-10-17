import { useMemo, useState } from "react";
import { Link } from "wouter";
import { Bot, Loader2, RefreshCw, Search } from "lucide-react";
import { ProblemRow, useFixWithAgent } from "@/components/workbench";
import { Page } from "@/components/shell";
import { Empty, Spark } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ago, useLive, useNow } from "@/lib/live";
import { cn } from "@/lib/utils";

export default function Diagnostics() {
  const { snap, act } = useLive();
  const now = useNow(2000);
  const [q, setQ] = useState("");
  const [sev, setSev] = useState<"all" | "error" | "warning">("all");
  const [src, setSrc] = useState<"all" | "tsc" | "eslint">("all");
  const { fix, busy } = useFixWithAgent();

  const rows = useMemo(() => {
    if (!snap) return [];
    return snap.projects.flatMap((p) =>
      (snap.diagnostics[p.id]?.items ?? []).map((i) => ({ ...i, project: p })),
    ).filter((r) => (sev === "all" || r.severity === sev) && (src === "all" || r.source === src) && (!q || `${r.file} ${r.message} ${r.code} ${r.project.name}`.toLowerCase().includes(q.toLowerCase())));
  }, [snap, q, sev, src]);

  if (!snap) return null;

  return (
    <Page
      title="Diagnostics"
      sub="TypeScript compiler and ESLint status per worktree — re-runs on every file change"
      actions={<Button size="sm" variant="outline" data-testid="button-recheck-all" onClick={() => Promise.all(snap.projects.map((p) => act("POST", `/api/projects/${p.id}/diagnostics`)))}><RefreshCw />Re-run all</Button>}
    >
      <div className="overflow-x-auto rounded-lg border border-card-border bg-card">
        <table className="w-full text-[13px]">
          <thead className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Project</th>
              <th className="px-3 py-2.5 font-medium">Status</th>
              <th className="px-3 py-2.5 text-right font-medium">tsc errors</th>
              <th className="px-3 py-2.5 text-right font-medium">lint errors</th>
              <th className="px-3 py-2.5 text-right font-medium">warnings</th>
              <th className="px-3 py-2.5 font-medium">Trend</th>
              <th className="px-3 py-2.5 font-medium">Last run</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody className="tnum">
            {snap.projects.map((p) => {
              const d = snap.diagnostics[p.id];
              const st = d?.status ?? "unknown";
              return (
                <tr key={p.id} className="border-b border-border/60 last:border-0" data-testid={`row-diag-${p.id}`}>
                  <td className="px-4 py-2.5"><Link href={`/p/${p.id}`} className="flex items-center gap-2 font-medium hover:underline"><span className="h-3 w-1 rounded-full" style={{ background: p.color }} />{p.name}</Link></td>
                  <td className="px-3 py-2.5">
                    <span className={cn("rounded px-1.5 py-0.5 font-mono text-[11px] uppercase", st === "pass" ? "bg-ok/10 text-ok" : st === "warn" ? "bg-warn/10 text-warn" : st === "fail" ? "bg-err/10 text-err" : "bg-muted text-muted-foreground")}>
                      {d?.running ? "running" : st}
                    </span>
                  </td>
                  <td className={cn("px-3 py-2.5 text-right font-mono", d?.tscErrors ? "text-err" : "text-muted-foreground")}>{d?.tscErrors ?? "–"}</td>
                  <td className={cn("px-3 py-2.5 text-right font-mono", d?.lintErrors ? "text-err" : "text-muted-foreground")}>{d?.lintErrors ?? "–"}</td>
                  <td className={cn("px-3 py-2.5 text-right font-mono", d?.lintWarnings ? "text-warn" : "text-muted-foreground")}>{d?.lintWarnings ?? "–"}</td>
                  <td className="px-3 py-2.5"><Spark data={d?.history ?? []} w={110} /></td>
                  <td className="px-3 py-2.5 text-xs text-muted-foreground">{ago(d?.lastRun, now)}{d?.durationMs ? ` · ${(d.durationMs / 1000).toFixed(1)}s` : ""}</td>
                  <td className="px-3 py-2.5 text-right">
                    {!!d?.items.length && (
                      <Button size="sm" variant="outline" className="h-7 px-2 text-[11px]" disabled={busy === p.id} onClick={() => fix(p, undefined, p.id)} data-testid={`button-fix-${p.id}`}>
                        {busy === p.id ? <Loader2 className="animate-spin" /> : <Bot />}Fix with agent
                      </Button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-6 flex flex-wrap items-center gap-2">
        <div className="relative w-full max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter file, rule, message" className="h-8 pl-8 text-[13px]" data-testid="input-filter" />
        </div>
        {(["all", "error", "warning"] as const).map((s) => (
          <button key={s} onClick={() => setSev(s)} data-testid={`filter-sev-${s}`} className={cn("rounded-full border px-2.5 py-0.5 text-[11px] capitalize", sev === s ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{s}</button>
        ))}
        <span className="mx-1 h-4 w-px bg-border" />
        {(["all", "tsc", "eslint"] as const).map((s) => (
          <button key={s} onClick={() => setSrc(s)} data-testid={`filter-src-${s}`} className={cn("rounded-full border px-2.5 py-0.5 font-mono text-[11px]", src === s ? "border-primary/50 bg-primary/10 text-primary" : "border-border text-muted-foreground")}>{s}</button>
        ))}
        <span className="ml-auto text-xs text-muted-foreground tnum">{rows.length} problems</span>
      </div>

      <div className="mt-3 rounded-lg border border-card-border bg-card">
        {rows.length === 0 ? (
          <div className="p-6"><Empty title="No problems match" sub="All worktrees are clean for this filter." /></div>
        ) : (
          <div>
            {rows.map((r) => {
              const key = `${r.project.id}:${r.file}:${r.line}:${r.code}`;
              return <ProblemRow key={key} d={r} project={r.project} showProject onFix={() => fix(r.project, [r], key)} fixing={busy === key} />;
            })}
          </div>
        )}
      </div>
    </Page>
  );
}
