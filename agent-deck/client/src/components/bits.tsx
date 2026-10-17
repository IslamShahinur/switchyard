import type { ReactNode } from "react";
import type { AgentKind, AgentSession, ConnectionState, DiagState, SessionStatus } from "@shared/schema";
import { cn } from "@/lib/utils";

/* ----------------------------- Logo ----------------------------- */
export function Logo({ className }: { className?: string }) {
  // Switchyard: one trunk line diverging into parallel tracks (worktrees)
  return (
    <svg viewBox="0 0 32 32" fill="none" aria-label="Switchyard" className={className}>
      <g stroke="currentColor" strokeWidth="2.6" strokeLinecap="round">
        <path d="M7 26V6" />
        <path d="M7 20c0-5 4-6.5 9-6.5S25 12 25 7" />
        <path d="M7 14c0 4 3 5.5 7.5 5.5" />
      </g>
      <circle cx="25" cy="7" r="2.6" fill="hsl(var(--warn))" />
    </svg>
  );
}

/* --------------------------- status meta --------------------------- */
export const statusMeta: Record<SessionStatus, { label: string; cls: string; dot: string }> = {
  busy: { label: "Running", cls: "text-run bg-run/10 border-run/25", dot: "bg-run sy-pulse" },
  awaiting: { label: "Needs approval", cls: "text-warn bg-warn/10 border-warn/30", dot: "bg-warn sy-pulse" },
  idle: { label: "Idle", cls: "text-muted-foreground bg-muted border-border", dot: "bg-muted-foreground/60" },
  done: { label: "Done", cls: "text-ok bg-ok/10 border-ok/25", dot: "bg-ok" },
  error: { label: "Error", cls: "text-err bg-err/10 border-err/30", dot: "bg-err" },
};

export function StatusPill({ status, className }: { status: SessionStatus; className?: string }) {
  const m = statusMeta[status];
  return (
    <span data-testid={`status-${status}`} className={cn("inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] font-medium whitespace-nowrap", m.cls, className)}>
      <span className={cn("size-1.5 rounded-full", m.dot)} />
      {m.label}
    </span>
  );
}

export function ModeTag({ mode }: { mode: "plan" | "act" }) {
  return (
    <span className={cn("rounded px-1.5 py-px font-mono text-[10px] uppercase tracking-wider border", mode === "plan" ? "border-chart-3/40 text-chart-3" : "border-primary/40 text-primary")}>
      {mode}
    </span>
  );
}

export function AgentBadge({ agent, className }: { agent: AgentKind; className?: string }) {
  return (
    <span className={cn("inline-flex items-center gap-1 rounded border border-border bg-muted/60 px-1.5 py-px font-mono text-[10px] text-muted-foreground", className)}>
      {agent === "opencode" ? (
        <svg viewBox="0 0 12 12" className="size-2.5"><rect x="1.5" y="1.5" width="9" height="9" rx="1" fill="none" stroke="currentColor" strokeWidth="1.6" /></svg>
      ) : (
        <svg viewBox="0 0 12 12" className="size-2.5"><path d="M2 3l3 3-3 3M6.5 9H10" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" /></svg>
      )}
      {agent === "opencode" ? "OpenCode" : "Cline CLI"}
    </span>
  );
}

export function ConnDot({ c }: { c?: ConnectionState }) {
  const state = c?.state ?? "disconnected";
  const cls = state === "connected" ? "bg-ok" : state === "simulated" ? "bg-chart-3" : state === "connecting" ? "bg-warn sy-pulse" : "bg-err";
  return <span title={`${state}${c?.detail ? ` — ${c.detail}` : ""}`} className={cn("inline-block size-2 rounded-full", cls)} />;
}

/* ------------------------------ sparkline ------------------------------ */
export function Spark({ data, className, w = 96, h = 24 }: { data: { errors: number; warnings: number }[]; className?: string; w?: number; h?: number }) {
  if (data.length < 2) return <div style={{ width: w, height: h }} className={cn("rounded bg-muted/40", className)} />;
  const max = Math.max(1, ...data.map((d) => d.errors + d.warnings));
  const step = w / (data.length - 1);
  const path = (k: (d: { errors: number; warnings: number }) => number) =>
    data.map((d, i) => `${i ? "L" : "M"}${(i * step).toFixed(1)},${(h - 2 - (k(d) / max) * (h - 4)).toFixed(1)}`).join(" ");
  const last = data[data.length - 1];
  return (
    <svg width={w} height={h} className={className} aria-label={`trend: ${last.errors} errors, ${last.warnings} warnings`}>
      <path d={path((d) => d.errors + d.warnings)} fill="none" stroke="hsl(var(--warn))" strokeWidth="1.2" opacity=".55" />
      <path d={path((d) => d.errors)} fill="none" stroke="hsl(var(--err))" strokeWidth="1.6" />
    </svg>
  );
}

/* ------------------------------ diag chip ------------------------------ */
export function DiagChips({ d, compact }: { d?: DiagState; compact?: boolean }) {
  if (!d || d.status === "unknown")
    return <span className="text-xs text-muted-foreground">{d?.running ? "checking…" : d?.cmdError ? "checks failed to run" : "no data"}</span>;
  const errs = d.tscErrors + d.lintErrors;
  return (
    <div className="flex items-center gap-1.5 tnum">
      <span data-testid="text-errors" className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]", errs ? "bg-err/12 text-err" : "bg-ok/10 text-ok")}>
        <svg viewBox="0 0 10 10" className="size-2"><circle cx="5" cy="5" r="4" fill="currentColor" /></svg>
        {errs}
        {!compact && <span className="opacity-70">err</span>}
      </span>
      <span data-testid="text-warnings" className={cn("inline-flex items-center gap-1 rounded px-1.5 py-0.5 font-mono text-[11px]", d.lintWarnings ? "bg-warn/12 text-warn" : "bg-muted text-muted-foreground")}>
        <svg viewBox="0 0 10 10" className="size-2"><path d="M5 1l4 8H1z" fill="currentColor" /></svg>
        {d.lintWarnings}
        {!compact && <span className="opacity-70">warn</span>}
      </span>
      {d.running && <span className="size-1.5 rounded-full bg-run sy-pulse" title="re-checking" />}
    </div>
  );
}

/* ------------------------------ diff view ------------------------------ */
export function DiffView({ diff, className }: { diff: string; className?: string }) {
  const lines = diff.split("\n");
  return (
    <pre className={cn("scroll-x overflow-x-auto rounded-md border border-border bg-background/60 py-2 font-mono text-[12px] leading-[1.55]", className)}>
      {lines.map((l, i) => {
        const cls = l.startsWith("+++") || l.startsWith("---")
          ? "text-muted-foreground font-semibold"
          : l.startsWith("diff --git")
            ? "text-foreground font-semibold border-t border-border mt-1 pt-1 first:border-0 first:mt-0 first:pt-0"
            : l.startsWith("@@")
              ? "text-chart-4 bg-chart-4/5"
              : l.startsWith("+")
                ? "text-ok bg-ok/10"
                : l.startsWith("-")
                  ? "text-err bg-err/10"
                  : "text-muted-foreground";
        return (
          <div key={i} className={cn("px-3 whitespace-pre", cls)}>
            {l || " "}
          </div>
        );
      })}
    </pre>
  );
}

/* --------------------------- tiny markdown --------------------------- */
function inline(t: string): ReactNode[] {
  const parts = t.split(/(`[^`]+`|\*\*[^*]+\*\*)/g);
  return parts.map((p, i) =>
    p.startsWith("`") && p.endsWith("`") ? (
      <code key={i} className="rounded bg-muted px-1 py-px font-mono text-[0.85em]">{p.slice(1, -1)}</code>
    ) : p.startsWith("**") && p.endsWith("**") ? (
      <strong key={i} className="font-semibold text-foreground">{inline(p.slice(2, -2))}</strong>
    ) : (
      p
    ),
  );
}

export function Markdown({ text, className }: { text: string; className?: string }) {
  const out: ReactNode[] = [];
  const lines = text.split("\n");
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    if (l.startsWith("```")) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) buf.push(lines[i++]);
      out.push(<pre key={i} className="my-2 rounded-md bg-muted p-3 font-mono text-xs overflow-x-auto">{buf.join("\n")}</pre>);
    } else if (/^#{1,3} /.test(l)) {
      const lvl = l.match(/^#+/)![0].length;
      out.push(<div key={i} className={cn("font-semibold text-foreground", lvl === 1 || lvl === 2 ? "text-sm mt-1 mb-2" : "text-[13px] mt-3 mb-1")}>{inline(l.replace(/^#+ /, ""))}</div>);
    } else if (/^\s*(\d+\.|-|\*) /.test(l)) {
      const items: { n?: string; t: string }[] = [];
      while (i < lines.length && /^\s*(\d+\.|-|\*) /.test(lines[i])) {
        const m = lines[i].match(/^\s*(\d+\.|-|\*) (.*)$/)!;
        items.push({ n: /\d/.test(m[1]) ? m[1] : undefined, t: m[2] });
        i++;
      }
      out.push(
        <ol key={i} className="my-1.5 space-y-1">
          {items.map((it, k) => (
            <li key={k} className="flex gap-2">
              <span className="w-4 shrink-0 text-right font-mono text-[11px] leading-5 text-muted-foreground">{it.n ?? "•"}</span>
              <span>{inline(it.t)}</span>
            </li>
          ))}
        </ol>,
      );
      continue;
    } else if (l.startsWith("> ")) {
      out.push(<div key={i} className="my-2 border-l-2 border-border pl-3 text-muted-foreground">{inline(l.slice(2))}</div>);
    } else if (l.trim()) {
      out.push(<p key={i} className="my-1.5">{inline(l)}</p>);
    }
    i++;
  }
  return <div className={cn("text-[13px] leading-relaxed text-foreground/85", className)}>{out}</div>;
}

/* ------------------------------ misc ------------------------------ */
export function Kpi({ label, value, sub, tone, testid }: { label: string; value: ReactNode; sub?: ReactNode; tone?: "warn" | "err" | "ok" | "run"; testid: string }) {
  const toneCls = tone === "warn" ? "text-warn" : tone === "err" ? "text-err" : tone === "ok" ? "text-ok" : tone === "run" ? "text-run" : "text-foreground";
  return (
    <div className="rounded-lg border border-card-border bg-card px-4 py-3" data-testid={testid}>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</div>
      <div className={cn("mt-1 text-xl font-semibold tnum", toneCls)}>{value}</div>
      {sub && <div className="mt-0.5 text-xs text-muted-foreground truncate">{sub}</div>}
    </div>
  );
}

export function lastLine(s?: AgentSession) {
  if (!s) return "";
  const m = [...s.messages].reverse().find((x) => x.role !== "user");
  return m ? m.text.split("\n").find((l) => l.trim() && !l.startsWith("#")) ?? m.text : "";
}

export function SectionTitle({ children, right }: { children: ReactNode; right?: ReactNode }) {
  return (
    <div className="mb-3 flex items-center justify-between gap-3">
      <h2 className="text-sm font-semibold">{children}</h2>
      {right}
    </div>
  );
}

export function Empty({ icon, title, sub }: { icon?: ReactNode; title: string; sub?: string }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed border-border px-6 py-10 text-center">
      {icon && <div className="text-muted-foreground">{icon}</div>}
      <div className="text-sm font-medium">{title}</div>
      {sub && <div className="max-w-xs text-xs text-muted-foreground">{sub}</div>}
    </div>
  );
}
