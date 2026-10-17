import { useEffect, useState } from "react";
import { Link } from "wouter";
import { CalendarClock, Pencil, Play, Plus, Trash2 } from "lucide-react";
import type { InsertSchedule, Schedule } from "@shared/schema";
import { Page } from "@/components/shell";
import { AgentBadge, Empty, ModeTag } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { ago, dateTime, describeCron, until, useLive, useNow } from "@/lib/live";
import { cn } from "@/lib/utils";

export default function Schedules() {
  const { snap, act } = useLive();
  const { toast } = useToast();
  const now = useNow(1000);
  const [edit, setEdit] = useState<Schedule | "new" | null>(null);
  const [running, setRunning] = useState<string | null>(null);
  if (!snap) return null;

  const runNow = async (s: Schedule) => {
    setRunning(s.id);
    try {
      await act("POST", `/api/schedules/${s.id}/run`);
      toast({ title: `Ran "${s.name}"`, description: "New worktree + agent session created." });
    } catch (e: any) {
      toast({ title: "Run failed", description: e.message, variant: "destructive" });
    } finally {
      setRunning(null);
    }
  };

  return (
    <Page
      title="Scheduled project creation"
      sub="Cron jobs that cut a new git worktree, optionally scaffold it, and start an agent session"
      actions={<Button size="sm" onClick={() => setEdit("new")} data-testid="button-new-schedule"><Plus />New schedule</Button>}
    >
      {snap.schedules.length === 0 && <Empty icon={<CalendarClock className="size-5" />} title="No schedules" sub="Create one to spin up projects automatically." />}
      <div className="grid gap-3 xl:grid-cols-2">
        {snap.schedules.map((s) => (
          <article key={s.id} className="rounded-lg border border-card-border bg-card" data-testid={`card-schedule-${s.id}`}>
            <div className="flex items-start gap-3 border-b border-border p-4">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h3 className="truncate text-[15px] font-semibold">{s.name}</h3>
                  <AgentBadge agent={s.agent} />
                  <ModeTag mode={s.mode} />
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 text-[11.5px] text-muted-foreground">
                  <span className="font-mono">{s.cron}</span>
                  <span>{describeCron(s.cron)}</span>
                  <span className="font-mono">{s.branchTemplate}</span>
                </div>
              </div>
              <Switch
                checked={s.enabled}
                onCheckedChange={(v) => act("PATCH", `/api/schedules/${s.id}`, { enabled: v })}
                data-testid={`switch-schedule-${s.id}`}
                aria-label="Enabled"
              />
            </div>
            <div className="grid grid-cols-3 gap-px bg-border text-[12px]">
              <div className="bg-card px-4 py-2.5"><div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Next run</div><div className={cn("mt-0.5 font-medium tnum", s.enabled ? "text-foreground" : "text-muted-foreground")}>{s.enabled ? until(s.nextRun, now) : "paused"}</div><div className="text-[11px] text-muted-foreground">{s.enabled ? dateTime(s.nextRun) : ""}</div></div>
              <div className="bg-card px-4 py-2.5"><div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Last run</div><div className="mt-0.5 font-medium tnum">{ago(s.lastRun, now)}</div><div className="text-[11px] text-muted-foreground">{s.runs.filter((r) => r.status === "ok").length} project{s.runs.filter((r) => r.status === "ok").length === 1 ? "" : "s"} created</div></div>
              <div className="bg-card px-4 py-2.5"><div className="text-[10.5px] uppercase tracking-wider text-muted-foreground">Limit</div><div className="mt-0.5 font-medium tnum">{s.maxConcurrent} active</div><div className="text-[11px] text-muted-foreground">base {s.baseBranch}</div></div>
            </div>
            <div className="p-4">
              <div className="line-clamp-2 text-[12.5px] text-muted-foreground">{s.prompt}</div>
              {s.runs.length > 0 && (
                <div className="mt-3 space-y-1">
                  {s.runs.slice(0, 3).map((r, i) => (
                    <div key={i} className="flex items-center gap-2 font-mono text-[11px]">
                      <span className={cn("size-1.5 rounded-full", r.status === "ok" ? "bg-ok" : "bg-err")} />
                      <span className="text-muted-foreground tnum">{ago(r.ts, now)}</span>
                      {r.projectId && snap.projects.some((p) => p.id === r.projectId) ? (
                        <Link href={`/p/${r.projectId}`} className="truncate hover:underline">{r.detail}</Link>
                      ) : (
                        <span className={cn("truncate", r.status === "error" && "text-err")}>{r.detail}</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-4 flex items-center gap-2">
                <Button size="sm" onClick={() => runNow(s)} disabled={running === s.id} data-testid={`button-run-${s.id}`}><Play />{running === s.id ? "Creating…" : "Run now"}</Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(s)} data-testid={`button-edit-${s.id}`}><Pencil />Edit</Button>
                <Button size="sm" variant="ghost" className="ml-auto text-muted-foreground hover:text-err" onClick={() => act("DELETE", `/api/schedules/${s.id}`)} data-testid={`button-delete-${s.id}`}><Trash2 /></Button>
              </div>
            </div>
          </article>
        ))}
      </div>
      {edit && <ScheduleDialog schedule={edit === "new" ? undefined : edit} onClose={() => setEdit(null)} defaultRepo={snap.projects[0]?.repoPath ?? ""} />}
    </Page>
  );
}

function ScheduleDialog({ schedule, onClose, defaultRepo }: { schedule?: Schedule; onClose: () => void; defaultRepo: string }) {
  const { act } = useLive();
  const { toast } = useToast();
  const [f, setF] = useState<InsertSchedule>(
    schedule
      ? { ...schedule }
      : {
          name: "Weekly prototype",
          cron: "0 9 * * 1",
          enabled: true,
          repoPath: defaultRepo,
          baseBranch: "main",
          branchTemplate: "proto/{slug}-{date}",
          nameTemplate: "Prototype {date}",
          agent: "cline",
          runMode: "demo",
          mode: "plan",
          prompt: "",
          scaffoldCmd: "",
          maxConcurrent: 4,
        },
  );
  const [preview, setPreview] = useState<number[] | string>([]);
  const set = <K extends keyof InsertSchedule>(k: K, v: InsertSchedule[K]) => setF((x) => ({ ...x, [k]: v }));

  useEffect(() => {
    const t = setTimeout(async () => {
      try {
        const r = await apiRequest("GET", `/api/cron/preview?expr=${encodeURIComponent(f.cron)}`);
        setPreview(await r.json());
      } catch {
        setPreview("invalid cron expression");
      }
    }, 250);
    return () => clearTimeout(t);
  }, [f.cron]);

  const save = async () => {
    try {
      await act(schedule ? "PUT" : "POST", schedule ? `/api/schedules/${schedule.id}` : "/api/schedules", { ...f, scaffoldCmd: f.scaffoldCmd || undefined });
      toast({ title: schedule ? "Schedule updated" : "Schedule created" });
      onClose();
    } catch (e: any) {
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{schedule ? "Edit schedule" : "New schedule"}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} data-testid="input-sch-name" /></Field>
          <Field label="Cron (min hour dom mon dow)" hint={typeof preview === "string" ? <span className="text-err">{preview}</span> : preview.map((t) => dateTime(t)).join(" · ")}>
            <Input value={f.cron} onChange={(e) => set("cron", e.target.value)} className="font-mono" data-testid="input-sch-cron" />
          </Field>
          <Field label="Repository (main checkout)"><Input value={f.repoPath} onChange={(e) => set("repoPath", e.target.value)} className="font-mono text-xs" data-testid="input-sch-repo" /></Field>
          <Field label="Base branch"><Input value={f.baseBranch} onChange={(e) => set("baseBranch", e.target.value)} className="font-mono" data-testid="input-sch-base" /></Field>
          <Field label="Branch template" hint="{date} {time} {n} {slug}"><Input value={f.branchTemplate} onChange={(e) => set("branchTemplate", e.target.value)} className="font-mono" data-testid="input-sch-branch" /></Field>
          <Field label="Project name template"><Input value={f.nameTemplate} onChange={(e) => set("nameTemplate", e.target.value)} data-testid="input-sch-pname" /></Field>
          <Field label="Agent">
            <Select value={f.agent} onValueChange={(v) => set("agent", v as any)}>
              <SelectTrigger data-testid="select-sch-agent"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="cline">Cline CLI</SelectItem><SelectItem value="opencode">OpenCode server</SelectItem></SelectContent>
            </Select>
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Start in">
              <Select value={f.mode} onValueChange={(v) => set("mode", v as any)}>
                <SelectTrigger data-testid="select-sch-mode"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="plan">Plan</SelectItem><SelectItem value="act">Act</SelectItem></SelectContent>
              </Select>
            </Field>
            <Field label="Runtime">
              <Select value={f.runMode} onValueChange={(v) => set("runMode", v as any)}>
                <SelectTrigger data-testid="select-sch-runmode"><SelectValue /></SelectTrigger>
                <SelectContent><SelectItem value="live">Live agent</SelectItem><SelectItem value="demo">Simulator</SelectItem></SelectContent>
              </Select>
            </Field>
          </div>
          <Field label="Scaffold command (optional, runs in new worktree)" className="sm:col-span-2"><Input value={f.scaffoldCmd ?? ""} onChange={(e) => set("scaffoldCmd", e.target.value)} placeholder="npm ci && npm run codegen" className="font-mono text-xs" data-testid="input-sch-scaffold" /></Field>
          <Field label="Agent prompt" className="sm:col-span-2"><Textarea value={f.prompt} onChange={(e) => set("prompt", e.target.value)} className="min-h-[90px]" data-testid="input-sch-prompt" /></Field>
          <Field label="Skip if active projects ≥"><Input type="number" min={1} max={8} value={f.maxConcurrent} onChange={(e) => set("maxConcurrent", +e.target.value || 1)} data-testid="input-sch-max" /></Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!f.prompt.trim() || typeof preview === "string"} data-testid="button-save-schedule">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function Field({ label, hint, children, className }: { label: string; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("space-y-1.5", className)}>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      {children}
      {hint && <div className="text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}
