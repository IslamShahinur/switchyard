import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { CalendarClock, CheckCheck, FileDiff, LayoutGrid, ListChecks, Play, RefreshCw, RotateCcw, Settings2, ShieldQuestion, TriangleAlert } from "lucide-react";
import { CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut } from "@/components/ui/command";
import { useToast } from "@/hooks/use-toast";
import { useLive } from "@/lib/live";

/** ⌘K / Ctrl+K command palette */
export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [, nav] = useLocation();
  const { snap, act } = useLive();

  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((o) => !o);
      }
    };
    const show = () => setOpen(true);
    window.addEventListener("keydown", h);
    window.addEventListener("switchyard:palette", show);
    return () => {
      window.removeEventListener("keydown", h);
      window.removeEventListener("switchyard:palette", show);
    };
  }, []);

  const go = (path: string) => {
    setOpen(false);
    nav(path);
  };
  const run = async (fn: () => Promise<unknown>) => {
    setOpen(false);
    await fn().catch(() => {});
  };
  const pending = snap?.checkpoints.filter((c) => c.status === "pending") ?? [];
  const kindIcon = { plan: ListChecks, permission: ShieldQuestion, review: FileDiff } as const;

  return (
    <CommandDialog open={open} onOpenChange={setOpen}>
      <CommandInput placeholder="Jump to a project, checkpoint, or action…" data-testid="input-palette" />
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {pending.length > 0 && (
          <CommandGroup heading={`Awaiting review (${pending.length})`}>
            {pending.map((c) => {
              const p = snap?.projects.find((x) => x.id === c.projectId);
              const Icon = kindIcon[c.kind];
              return (
                <CommandItem key={c.id} value={`review ${c.title} ${p?.name} ${c.kind} ${c.tool ?? ""}`} onSelect={() => go(`/approvals/${c.id}`)} data-testid={`palette-checkpoint-${c.id}`}>
                  <Icon className="text-warn" />
                  <span className="truncate">{c.title}</span>
                  <CommandShortcut className="whitespace-nowrap">{p?.name}</CommandShortcut>
                </CommandItem>
              );
            })}
          </CommandGroup>
        )}
        <CommandGroup heading="Projects">
          {snap?.projects.map((p) => {
            const d = snap.diagnostics[p.id];
            const errs = d ? d.tscErrors + d.lintErrors : 0;
            return (
              <CommandItem key={p.id} value={`project ${p.name} ${p.branch}`} onSelect={() => go(`/p/${p.id}`)} data-testid={`palette-project-${p.id}`}>
                <span className="h-3 w-1 rounded-full" style={{ background: p.color }} />
                <span>{p.name}</span>
                <span className="font-mono text-[11px] text-muted-foreground">{p.branch}</span>
                <CommandShortcut className="whitespace-nowrap">{errs ? `${errs} err` : "clean"}</CommandShortcut>
              </CommandItem>
            );
          })}
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Go to">
          <CommandItem value="overview" onSelect={() => go("/")}><LayoutGrid />Overview</CommandItem>
          <CommandItem value="approvals queue" onSelect={() => go("/approvals")}><CheckCheck />Approvals</CommandItem>
          <CommandItem value="diagnostics problems errors" onSelect={() => go("/diagnostics")}><TriangleAlert />Diagnostics</CommandItem>
          <CommandItem value="schedules cron" onSelect={() => go("/schedules")}><CalendarClock />Schedules</CommandItem>
          <CommandItem value="settings projects setup" onSelect={() => go("/settings")}><Settings2 />Projects & setup</CommandItem>
        </CommandGroup>
        <CommandGroup heading="Actions">
          <CommandItem value="re-run all checks diagnostics" onSelect={() => run(() => Promise.all((snap?.projects ?? []).map((p) => act("POST", `/api/projects/${p.id}/diagnostics`))))} data-testid="palette-recheck"><RefreshCw />Re-run all checks</CommandItem>
          {snap?.schedules.map((s) => (
            <CommandItem key={s.id} value={`run schedule ${s.name}`} onSelect={() => run(() => act("POST", `/api/schedules/${s.id}/run`))}><Play />Run schedule: {s.name}</CommandItem>
          ))}
          {snap?.projects.some((p) => p.runMode === "demo") && (
            <CommandItem value="reset demo" onSelect={() => run(() => act("POST", "/api/demo/reset"))}><RotateCcw />Reset demo</CommandItem>
          )}
        </CommandGroup>
      </CommandList>
    </CommandDialog>
  );
}

/** toast + tab title when new checkpoints arrive */
export function CheckpointAlerts() {
  const { snap } = useLive();
  const { toast } = useToast();
  const [, nav] = useLocation();
  const seen = useRef<Set<string> | null>(null);

  useEffect(() => {
    if (!snap) return;
    const pending = snap.checkpoints.filter((c) => c.status === "pending");
    document.title = pending.length ? `(${pending.length}) Switchyard — Agent Control` : "Switchyard — Agent Control";
    if (!seen.current) {
      seen.current = new Set(snap.checkpoints.map((c) => c.id));
      return;
    }
    const fresh = pending.filter((c) => !seen.current!.has(c.id));
    snap.checkpoints.forEach((c) => seen.current!.add(c.id));
    fresh.slice(0, 2).forEach((c) => {
      const p = snap.projects.find((x) => x.id === c.projectId);
      toast({
        title: `${p?.name ?? "Agent"} needs a decision`,
        description: (
          <button className="text-left underline-offset-2 hover:underline" onClick={() => nav(`/approvals/${c.id}`)} data-testid={`toast-open-${c.id}`}>
            {c.kind === "permission" ? `Permission (${c.tool}): ${c.title}` : c.title}
          </button>
        ) as any,
      });
    });
  }, [snap, toast, nav]);
  return null;
}
