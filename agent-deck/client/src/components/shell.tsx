import { useEffect, useState, type ReactNode } from "react";
import { Link, useLocation } from "wouter";
import { CalendarClock, CheckCheck, Command, FolderGit2, LayoutGrid, Moon, Settings2, Sun, TriangleAlert } from "lucide-react";
import { useLive } from "@/lib/live";
import { cn } from "@/lib/utils";
import { ConnDot, Logo, statusMeta } from "./bits";
import { CheckpointAlerts, CommandPalette } from "./palette";

function useTheme() {
  // dark-first: agent consoles live next to terminals
  const [dark, setDark] = useState(true);
  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);
  return { dark, toggle: () => setDark((d) => !d) };
}

export function Shell({ children }: { children: ReactNode }) {
  const { snap, transport } = useLive();
  const [loc] = useLocation();
  const theme = useTheme();
  const pending = snap?.checkpoints.filter((c) => c.status === "pending").length ?? 0;
  const errors = snap ? Object.values(snap.diagnostics).reduce((a, d) => a + d.tscErrors + d.lintErrors, 0) : 0;

  const nav = [
    { href: "/", label: "Overview", icon: LayoutGrid, badge: null as ReactNode },
    { href: "/approvals", label: "Approvals", icon: CheckCheck, badge: pending ? <span className="rounded-full bg-warn px-1.5 text-[10px] font-semibold text-background tnum">{pending}</span> : null },
    { href: "/diagnostics", label: "Diagnostics", icon: TriangleAlert, badge: errors ? <span className="rounded-full bg-err/15 px-1.5 text-[10px] font-semibold text-err tnum">{errors}</span> : null },
    { href: "/schedules", label: "Schedules", icon: CalendarClock, badge: null },
    { href: "/settings", label: "Projects & setup", icon: Settings2, badge: null },
  ];
  const isActive = (h: string) => (h === "/" ? loc === "/" : loc.startsWith(h));

  return (
    <div className="grid h-[100dvh] grid-cols-[232px_1fr] grid-rows-[48px_1fr] max-md:grid-cols-[56px_1fr]">
      {/* sidebar */}
      <aside className="row-span-2 flex flex-col border-r border-sidebar-border bg-sidebar scroll-y">
        <div className="flex h-12 items-center gap-2.5 px-4 max-md:justify-center max-md:px-0">
          <Logo className="size-6 text-primary" />
          <div className="max-md:hidden">
            <div className="text-[13px] font-semibold leading-none tracking-tight">Switchyard</div>
            <div className="mt-0.5 text-[10px] leading-none text-muted-foreground">agent control</div>
          </div>
        </div>
        <nav className="mt-2 space-y-0.5 px-2">
          {nav.map((n) => (
            <Link key={n.href} href={n.href} data-testid={`link-nav-${n.label.split(" ")[0].toLowerCase()}`}>
              <span
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] transition-colors max-md:justify-center",
                  isActive(n.href) ? "bg-sidebar-accent font-medium text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                )}
              >
                <n.icon className="size-4 shrink-0" />
                <span className="flex-1 max-md:hidden">{n.label}</span>
                <span className="max-md:hidden">{n.badge}</span>
              </span>
            </Link>
          ))}
        </nav>

        <div className="mt-6 px-4 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground max-md:hidden">Worktrees</div>
        <div className="mt-1.5 space-y-0.5 px-2 max-md:mt-4">
          {snap?.projects.map((p) => {
            const active = snap.sessions.filter((s) => s.projectId === p.id).sort((a, b) => b.updatedAt - a.updatedAt)[0];
            return (
              <Link key={p.id} href={`/p/${p.id}`} data-testid={`link-project-${p.id}`}>
                <span
                  className={cn(
                    "flex h-8 cursor-pointer items-center gap-2.5 rounded-md px-2.5 text-[13px] max-md:justify-center",
                    loc === `/p/${p.id}` ? "bg-sidebar-accent text-foreground" : "text-muted-foreground hover:bg-sidebar-accent/60 hover:text-foreground",
                  )}
                  title={p.name}
                >
                  <span className="h-3.5 w-1 shrink-0 rounded-full" style={{ background: p.color }} />
                  <span className="flex-1 truncate max-md:hidden">{p.name}</span>
                  {active && <span className={cn("size-1.5 rounded-full max-md:hidden", statusMeta[active.status].dot)} />}
                </span>
              </Link>
            );
          })}
          {!snap && [0, 1, 2, 3].map((i) => <div key={i} className="mx-2.5 my-2 h-4 animate-pulse rounded bg-muted" />)}
        </div>

        <div className="mt-auto border-t border-sidebar-border p-3 text-[11px] text-muted-foreground max-md:hidden">
          <div className="flex items-center gap-2">
            <FolderGit2 className="size-3.5" />
            <span>{snap?.projects.length ?? 0} worktrees · {snap?.sessions.filter((s) => s.status === "busy" || s.status === "awaiting").length ?? 0} live sessions</span>
          </div>
        </div>
      </aside>

      {/* top bar */}
      <header className="flex items-center gap-3 border-b border-border bg-background/80 px-5 backdrop-blur">
        <div className="flex items-center gap-2 text-xs text-muted-foreground" data-testid="status-transport">
          <span className={cn("size-2 rounded-full", transport === "sse" ? "bg-ok sy-pulse" : transport === "poll" ? "bg-warn" : "bg-err")} />
          {transport === "sse" ? "Live stream" : transport === "poll" ? "Polling 1.5s" : "Offline"}
        </div>
        <div className="hidden items-center gap-3 md:flex">
          {snap?.projects.map((p) => (
            <span key={p.id} className="flex items-center gap-1.5 text-[11px] text-muted-foreground" title={snap.connections[p.id]?.detail}>
              <ConnDot c={snap.connections[p.id]} />
              <span className="max-w-[110px] truncate">{p.name}</span>
            </span>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => window.dispatchEvent(new Event("switchyard:palette"))} data-testid="button-palette" className="hidden items-center gap-2 rounded-md border border-border px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground sm:flex">
            <Command className="size-3.5" />Jump to…<kbd className="rounded bg-muted px-1 font-mono text-[10px]">⌘K</kbd>
          </button>
          {pending > 0 && (
            <Link href="/approvals" data-testid="link-pending">
              <span className="flex cursor-pointer items-center gap-1.5 rounded-md border border-warn/30 bg-warn/10 px-2.5 py-1 text-xs font-medium text-warn">
                <span className="size-1.5 rounded-full bg-warn sy-pulse" />
                {pending} awaiting review
              </span>
            </Link>
          )}
          <button onClick={theme.toggle} aria-label="Toggle theme" data-testid="button-theme" className="grid size-8 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground">
            {theme.dark ? <Sun className="size-4" /> : <Moon className="size-4" />}
          </button>
        </div>
      </header>

      <main className="scroll-y min-w-0">{children}</main>
      <CommandPalette />
      <CheckpointAlerts />
    </div>
  );
}

export function Page({ title, sub, actions, children }: { title: ReactNode; sub?: ReactNode; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="mx-auto max-w-[1440px] px-5 py-5 md:px-7">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
          {sub && <div className="mt-0.5 text-[13px] text-muted-foreground">{sub}</div>}
        </div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
