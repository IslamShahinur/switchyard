import { useEffect, useMemo, useState } from "react";
import { Bot, ChevronDown, ChevronRight, FileCode2, FilePlus2, FileMinus2, Loader2 } from "lucide-react";
import type { Diagnostic, Project } from "@shared/schema";
import { apiRequest } from "@/lib/queryClient";
import { useLive } from "@/lib/live";
import { useToast } from "@/hooks/use-toast";
import { cn } from "@/lib/utils";

/* ================================================================== */
/*  File-grouped diff                                                  */
/* ================================================================== */

interface DiffFile {
  path: string;
  kind: "added" | "deleted" | "modified";
  add: number;
  del: number;
  lines: string[];
}

export function parseDiff(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  let cur: DiffFile | null = null;
  for (const l of diff.split("\n")) {
    if (l.startsWith("diff --git")) {
      const m = l.match(/ b\/(.+)$/);
      cur = { path: m?.[1] ?? l, kind: "modified", add: 0, del: 0, lines: [] };
      files.push(cur);
      continue;
    }
    if (!cur) continue;
    if (l.startsWith("new file")) cur.kind = "added";
    else if (l.startsWith("deleted file")) cur.kind = "deleted";
    else if (l.startsWith("index ") || l.startsWith("--- ") || l.startsWith("+++ ") || l.startsWith("similarity") || l.startsWith("rename ")) continue;
    else {
      if (l.startsWith("+")) cur.add++;
      else if (l.startsWith("-")) cur.del++;
      cur.lines.push(l);
    }
  }
  return files;
}

function Bar({ add, del }: { add: number; del: number }) {
  const total = add + del || 1;
  const blocks = 5;
  const a = Math.round((add / total) * blocks);
  return (
    <span className="flex gap-px" aria-hidden>
      {Array.from({ length: blocks }, (_, i) => (
        <span key={i} className={cn("size-[7px] rounded-[1px]", i < a ? "bg-ok" : i < blocks && del ? "bg-err" : "bg-muted")} />
      ))}
    </span>
  );
}

export function FileDiff({ diff, className, defaultOpen = true, maxHeight = 480 }: { diff: string; className?: string; defaultOpen?: boolean; maxHeight?: number }) {
  const files = useMemo(() => parseDiff(diff), [diff]);
  const [closed, setClosed] = useState<Record<string, boolean>>({});
  const add = files.reduce((a, f) => a + f.add, 0);
  const del = files.reduce((a, f) => a + f.del, 0);
  if (!files.length) return <div className={cn("rounded-md border border-dashed border-border px-4 py-6 text-center text-xs text-muted-foreground", className)}>No changes vs HEAD</div>;

  return (
    <div className={cn("space-y-2", className)}>
      <div className="flex items-center gap-3 text-xs text-muted-foreground tnum">
        <span>{files.length} file{files.length > 1 ? "s" : ""} changed</span>
        <span className="font-mono text-ok">+{add}</span>
        <span className="font-mono text-err">−{del}</span>
        <button className="ml-auto hover:text-foreground" onClick={() => setClosed(Object.fromEntries(files.map((f) => [f.path, !Object.values(closed).some((v) => v) ? true : false])))} data-testid="button-toggle-all-files">
          {Object.values(closed).some((v) => v) ? "Expand all" : "Collapse all"}
        </button>
      </div>
      {files.map((f) => {
        const isOpen = closed[f.path] === undefined ? defaultOpen : !closed[f.path];
        const Icon = f.kind === "added" ? FilePlus2 : f.kind === "deleted" ? FileMinus2 : FileCode2;
        return (
          <div key={f.path} className="overflow-hidden rounded-md border border-border" data-testid={`diff-file-${f.path}`}>
            <button onClick={() => setClosed((c) => ({ ...c, [f.path]: isOpen }))} className="flex w-full items-center gap-2 bg-muted/40 px-3 py-1.5 text-left hover:bg-muted/70">
              {isOpen ? <ChevronDown className="size-3.5 text-muted-foreground" /> : <ChevronRight className="size-3.5 text-muted-foreground" />}
              <Icon className={cn("size-3.5", f.kind === "added" ? "text-ok" : f.kind === "deleted" ? "text-err" : "text-muted-foreground")} />
              <span className="truncate font-mono text-[12px]">{f.path}</span>
              {f.kind !== "modified" && <span className={cn("rounded px-1 text-[10px] uppercase", f.kind === "added" ? "bg-ok/10 text-ok" : "bg-err/10 text-err")}>{f.kind}</span>}
              <span className="ml-auto flex items-center gap-2 font-mono text-[11px] tnum">
                <span className="text-ok">+{f.add}</span>
                <span className="text-err">−{f.del}</span>
                <Bar add={f.add} del={f.del} />
              </span>
            </button>
            {isOpen && (
              <pre className="scroll-y overflow-x-auto bg-background/60 py-1 font-mono text-[12px] leading-[1.55]" style={{ maxHeight }}>
                {f.lines.map((l, i) => (
                  <div
                    key={i}
                    className={cn(
                      "whitespace-pre px-3",
                      l.startsWith("@@") ? "bg-chart-4/5 text-chart-4" : l.startsWith("+") ? "bg-ok/10 text-ok" : l.startsWith("-") ? "bg-err/10 text-err" : l.startsWith("\\") ? "text-muted-foreground/60" : "text-muted-foreground",
                    )}
                  >
                    {l || " "}
                  </div>
                ))}
              </pre>
            )}
          </div>
        );
      })}
    </div>
  );
}

/** live worktree diff that refetches whenever git state changes */
export function LiveDiff({ project }: { project: Project }) {
  const { snap } = useLive();
  const g = snap?.git[project.id];
  const key = `${g?.head}|${g?.files.map((f) => f.status + f.path).join(",")}`;
  const [diff, setDiff] = useState<string | null>(null);
  const [mtimeTick, setTick] = useState(0);
  useEffect(() => {
    let off = false;
    apiRequest("GET", `/api/projects/${project.id}/diff`)
      .then((r) => r.json())
      .then((d) => !off && setDiff(d.diff))
      .catch(() => !off && setDiff(""));
    return () => {
      off = true;
    };
  }, [project.id, key, mtimeTick]);
  // file contents can change without changing porcelain status — refresh periodically
  useEffect(() => {
    const t = setInterval(() => setTick((x) => x + 1), 4000);
    return () => clearInterval(t);
  }, []);
  if (diff === null) return <div className="flex items-center gap-2 p-4 text-xs text-muted-foreground"><Loader2 className="size-3.5 animate-spin" />Loading diff…</div>;
  return <FileDiff diff={diff} />;
}

/* ================================================================== */
/*  Problems with code context + send-to-agent                         */
/* ================================================================== */

export function useFixWithAgent() {
  const { act } = useLive();
  const { toast } = useToast();
  const [busy, setBusy] = useState<string | null>(null);
  const fix = async (project: Project, items?: Diagnostic[], key = "all") => {
    setBusy(key);
    try {
      await act("POST", `/api/projects/${project.id}/fix`, { items, mode: "act" });
      toast({ title: "Sent to agent", description: `${project.name}: ${items?.length === 1 ? `${items[0].code} in ${items[0].file}` : `${items?.length ?? "all"} problems`}` });
    } catch (e: any) {
      toast({ title: "Agent unavailable", description: e.message.replace(/^\d+: /, "").replace(/^\{"message":"|"\}$/g, ""), variant: "destructive" });
    } finally {
      setBusy(null);
    }
  };
  return { fix, busy };
}

interface Snip {
  start: number;
  focus: number;
  lines: string[];
}

export function ProblemRow({ d, project, showProject, onFix, fixing }: { d: Diagnostic; project: Project; showProject?: boolean; onFix: () => void; fixing: boolean }) {
  const [open, setOpen] = useState(false);
  const [snip, setSnip] = useState<Snip | null | "err">(null);
  useEffect(() => {
    if (!open) return;
    apiRequest("GET", `/api/projects/${project.id}/snippet?file=${encodeURIComponent(d.file)}&line=${d.line}`)
      .then((r) => r.json())
      .then(setSnip)
      .catch(() => setSnip("err"));
  }, [open, project.id, d.file, d.line, d.message]);

  return (
    <div className="border-b border-border/60 last:border-0" data-testid={`row-problem-${d.file}-${d.line}-${d.code}`}>
      <div className="group flex items-start gap-2.5 px-3 py-2">
        <button onClick={() => setOpen((o) => !o)} className="mt-0.5 text-muted-foreground hover:text-foreground" aria-label={open ? "Hide code" : "Show code"} aria-expanded={open} data-testid="button-expand-problem">
          {open ? <ChevronDown className="size-3.5" /> : <ChevronRight className="size-3.5" />}
        </button>
        <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", d.severity === "error" ? "bg-err" : "bg-warn")} />
        <button onClick={() => setOpen((o) => !o)} className="min-w-0 flex-1 text-left">
          <div className="flex flex-wrap items-center gap-x-2 font-mono text-[11px]">
            <span className="text-foreground/80">{d.file}:{d.line}:{d.col}</span>
            <span className="text-muted-foreground">{d.source} · {d.code}</span>
            {showProject && <span className="flex items-center gap-1 font-sans text-muted-foreground"><span className="h-2.5 w-0.5 rounded-full" style={{ background: project.color }} />{project.name}</span>}
          </div>
          <div className="mt-0.5 text-[12.5px] leading-snug">{d.message}</div>
        </button>
        <button
          onClick={onFix}
          disabled={fixing}
          className="flex shrink-0 items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] text-muted-foreground opacity-70 transition-opacity hover:border-primary/50 hover:text-primary group-hover:opacity-100 disabled:opacity-50"
          data-testid="button-fix-problem"
          title="Send this problem to the project's agent"
        >
          {fixing ? <Loader2 className="size-3 animate-spin" /> : <Bot className="size-3" />}
          Fix
        </button>
      </div>
      {open && (
        <div className="px-3 pb-2.5 pl-9">
          {snip === null ? (
            <div className="h-24 animate-pulse rounded-md bg-muted/50" />
          ) : snip === "err" ? (
            <div className="text-xs text-muted-foreground">File no longer exists.</div>
          ) : (
            <pre className="overflow-x-auto rounded-md border border-border bg-background/60 py-1.5 font-mono text-[11.5px] leading-[1.6]">
              {snip.lines.map((l, i) => {
                const n = snip.start + i;
                const hit = n === snip.focus;
                const tone = d.severity === "error" ? "text-err" : "text-warn";
                return (
                  <div key={n}>
                    <div className={cn("flex whitespace-pre", hit && (d.severity === "error" ? "bg-err/10" : "bg-warn/10"))}>
                      <span className={cn("w-10 shrink-0 select-none pr-3 text-right", hit ? tone : "text-muted-foreground/50")}>{n}</span>
                      <span className={hit ? "text-foreground" : "text-muted-foreground"}>{l || " "}</span>
                    </div>
                    {hit && (
                      <div className="flex whitespace-pre">
                        <span className="w-10 shrink-0" />
                        <span className={tone}>{" ".repeat(Math.max(0, d.col - 1))}^ {d.code}</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </pre>
          )}
        </div>
      )}
    </div>
  );
}
