import { useState } from "react";
import { Link } from "wouter";
import { FolderSearch, Pencil, Plus, RotateCcw, Trash2 } from "lucide-react";
import type { InsertProject, Project } from "@shared/schema";
import { Page } from "@/components/shell";
import { AgentBadge, ConnDot, SectionTitle } from "@/components/bits";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { useToast } from "@/hooks/use-toast";
import { apiRequest } from "@/lib/queryClient";
import { useLive } from "@/lib/live";
import { Field } from "./schedules";

export default function Settings() {
  const { snap, act } = useLive();
  const { toast } = useToast();
  const [edit, setEdit] = useState<Project | "new" | null>(null);
  const [del, setDel] = useState<Project | null>(null);
  const [delWt, setDelWt] = useState(false);
  const [resetting, setResetting] = useState(false);
  if (!snap) return null;
  const hasDemo = snap.projects.some((p) => p.runMode === "demo");

  return (
    <Page
      title="Projects & setup"
      sub="Register git worktrees and point each one at a Cline CLI or OpenCode server"
      actions={
        <>
          {hasDemo && (
            <Button size="sm" variant="outline" disabled={resetting} data-testid="button-reset-demo" onClick={async () => {
              setResetting(true);
              try { await act("POST", "/api/demo/reset"); toast({ title: "Demo reset", description: "Worktrees restored, sessions restarted." }); } finally { setResetting(false); }
            }}><RotateCcw />{resetting ? "Resetting…" : "Reset demo"}</Button>
          )}
          <Button size="sm" onClick={() => setEdit("new")} data-testid="button-add-project"><Plus />Add project</Button>
        </>
      }
    >
      <div className="overflow-x-auto rounded-lg border border-card-border bg-card">
        <table className="w-full text-[13px]">
          <thead className="border-b border-border text-left text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-2.5 font-medium">Project</th>
              <th className="px-3 py-2.5 font-medium">Agent</th>
              <th className="px-3 py-2.5 font-medium">Connection</th>
              <th className="px-3 py-2.5 font-medium">Worktree</th>
              <th className="px-3 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {snap.projects.map((p) => {
              const c = snap.connections[p.id];
              return (
                <tr key={p.id} className="border-b border-border/60 last:border-0" data-testid={`row-project-${p.id}`}>
                  <td className="px-4 py-2.5">
                    <Link href={`/p/${p.id}`} className="flex items-center gap-2 font-medium hover:underline"><span className="h-3 w-1 rounded-full" style={{ background: p.color }} />{p.name}</Link>
                    <div className="ml-3 font-mono text-[11px] text-muted-foreground">{p.branch}{p.origin === "schedule" && " · scheduled"}</div>
                  </td>
                  <td className="px-3 py-2.5"><div className="flex items-center gap-1.5"><AgentBadge agent={p.agent} />{p.runMode === "demo" && <span className="rounded border border-chart-3/40 px-1.5 py-px text-[10px] text-chart-3">simulator</span>}</div></td>
                  <td className="px-3 py-2.5"><span className="flex items-center gap-2 text-xs"><ConnDot c={c} /><span className="max-w-[260px] truncate text-muted-foreground" title={c?.detail}>{c?.state}{c?.detail ? ` — ${c.detail}` : ""}</span></span></td>
                  <td className="max-w-[320px] truncate px-3 py-2.5 font-mono text-[11px] text-muted-foreground" title={p.worktreePath}>{p.worktreePath}</td>
                  <td className="whitespace-nowrap px-3 py-2.5 text-right">
                    <Button size="icon" variant="ghost" onClick={() => setEdit(p)} aria-label="Edit" data-testid={`button-edit-project-${p.id}`}><Pencil /></Button>
                    <Button size="icon" variant="ghost" className="hover:text-err" onClick={() => { setDel(p); setDelWt(false); }} aria-label="Remove" data-testid={`button-remove-project-${p.id}`}><Trash2 /></Button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <div className="mt-8 grid gap-4 lg:grid-cols-3">
        <SetupCard title="OpenCode server mode" lines={["# one headless server per worktree", "cd ../worktrees/checkout-v2", "opencode serve --port 4096 --hostname 127.0.0.1", "", "# dashboard uses /global/health, /event (SSE),", "# /session/*/prompt_async, /permissions/:id"]} note="Plan checkpoints use the plan agent; approval re-prompts the build agent. Tool permission requests surface live." />
        <SetupCard title="Cline CLI (headless)" lines={["npm i -g cline && cline auth", "", "# plan run (read-only):", "cline --json -p -c <worktree> \"<task>\"", "# act run after approval:", "cline --json -c <worktree> --auto-approve true \"<plan>\""]} note="NDJSON output is parsed into the transcript. The dashboard gates plan → act, then reviews the diff before commit." />
        <SetupCard title="VS Code extension" lines={["cd vscode-extension", "npx @vscode/vsce package", "code --install-extension switchyard-*.vsix", "", "# Command palette → Switchyard: Open Dashboard", "# status bar shows pending approvals"]} note="Set switchyard.url to wherever this server runs (default http://localhost:5000)." />
      </div>

      {edit && <ProjectDialog project={edit === "new" ? undefined : edit} defaults={snap.projects[0]} onClose={() => setEdit(null)} />}

      <AlertDialog open={!!del} onOpenChange={(v) => !v && setDel(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {del?.name}?</AlertDialogTitle>
            <AlertDialogDescription>Stops monitoring and drops its sessions and checkpoints from the dashboard.</AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm"><Switch checked={delWt} onCheckedChange={setDelWt} data-testid="switch-delete-worktree" />Also run <code className="font-mono text-xs">git worktree remove --force</code></label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction className="bg-err text-white hover:bg-err/90" data-testid="button-confirm-remove" onClick={() => del && act("DELETE", `/api/projects/${del.id}${delWt ? "?worktree=1" : ""}`)}>Remove</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Page>
  );
}

function SetupCard({ title, lines, note }: { title: string; lines: string[]; note: string }) {
  return (
    <div className="rounded-lg border border-card-border bg-card p-4">
      <SectionTitle>{title}</SectionTitle>
      <pre className="overflow-x-auto rounded-md bg-background/70 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
        {lines.map((l, i) => <div key={i} className={l.startsWith("#") ? "opacity-60" : "text-foreground/85"}>{l || " "}</div>)}
      </pre>
      <p className="mt-2 text-xs text-muted-foreground">{note}</p>
    </div>
  );
}

function ProjectDialog({ project, defaults, onClose }: { project?: Project; defaults?: Project; onClose: () => void }) {
  const { act } = useLive();
  const { toast } = useToast();
  const [f, setF] = useState<InsertProject>({
    name: project?.name ?? "",
    repoPath: project?.repoPath ?? defaults?.repoPath ?? "",
    worktreePath: project?.worktreePath ?? "",
    branch: project?.branch ?? "",
    createWorktree: false,
    baseBranch: "main",
    agent: project?.agent ?? "opencode",
    runMode: project?.runMode ?? "live",
    opencodeUrl: project?.opencodeUrl ?? "http://127.0.0.1:4096",
    clineBin: project?.clineBin ?? "",
    model: project?.model ?? "",
    typecheckCmd: project?.typecheckCmd ?? "",
    lintCmd: project?.lintCmd ?? "",
  });
  const [wts, setWts] = useState<{ path: string; branch: string; head: string }[]>([]);
  const set = <K extends keyof InsertProject>(k: K, v: InsertProject[K]) => setF((x) => ({ ...x, [k]: v }));

  const discover = async () => {
    try {
      const r = await apiRequest("GET", `/api/worktrees?repo=${encodeURIComponent(f.repoPath)}`);
      setWts(await r.json());
    } catch (e: any) {
      toast({ title: "Not a git repo", description: e.message, variant: "destructive" });
    }
  };

  const save = async () => {
    try {
      if (project) await act("PATCH", `/api/projects/${project.id}`, f);
      else await act("POST", "/api/projects", f);
      toast({ title: project ? "Project updated" : "Project added" });
      onClose();
    } catch (e: any) {
      toast({ title: "Could not save", description: e.message, variant: "destructive" });
    }
  };

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader><DialogTitle>{project ? `Edit ${project.name}` : "Add project"}</DialogTitle></DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Name"><Input value={f.name} onChange={(e) => set("name", e.target.value)} data-testid="input-p-name" /></Field>
          <Field label="Repository (main checkout)">
            <div className="flex gap-1.5">
              <Input value={f.repoPath} onChange={(e) => set("repoPath", e.target.value)} className="font-mono text-xs" data-testid="input-p-repo" />
              <Button type="button" size="icon" variant="outline" onClick={discover} aria-label="Discover worktrees" data-testid="button-discover"><FolderSearch /></Button>
            </div>
          </Field>
          {wts.length > 0 && !project && (
            <div className="sm:col-span-2 space-y-1 rounded-md border border-border p-2">
              <div className="px-1 text-[11px] text-muted-foreground">git worktree list</div>
              {wts.map((w) => (
                <button key={w.path} type="button" onClick={() => setF((x) => ({ ...x, worktreePath: w.path, branch: w.branch, createWorktree: false, name: x.name || w.branch.split("/").pop() || "" }))} className="flex w-full items-center gap-2 rounded px-2 py-1 text-left font-mono text-[11.5px] hover:bg-accent" data-testid={`button-wt-${w.branch}`}>
                  <span className="text-primary">{w.branch || "(detached)"}</span><span className="truncate text-muted-foreground">{w.path}</span><span className="ml-auto opacity-60">{w.head}</span>
                </button>
              ))}
            </div>
          )}
          {!project && (
            <label className="flex items-center gap-2 text-sm sm:col-span-2"><Switch checked={f.createWorktree} onCheckedChange={(v) => set("createWorktree", v)} data-testid="switch-create-wt" />Create a new worktree (<code className="font-mono text-xs">git worktree add -b</code>)</label>
          )}
          <Field label="Worktree path"><Input value={f.worktreePath} onChange={(e) => set("worktreePath", e.target.value)} className="font-mono text-xs" disabled={!!project} data-testid="input-p-wt" /></Field>
          <Field label="Branch"><Input value={f.branch} onChange={(e) => set("branch", e.target.value)} className="font-mono" disabled={!!project} data-testid="input-p-branch" /></Field>
          {f.createWorktree && <Field label="Base branch"><Input value={f.baseBranch} onChange={(e) => set("baseBranch", e.target.value)} className="font-mono" /></Field>}
          <Field label="Agent">
            <Select value={f.agent} onValueChange={(v) => set("agent", v as any)}>
              <SelectTrigger data-testid="select-p-agent"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="opencode">OpenCode server</SelectItem><SelectItem value="cline">Cline CLI</SelectItem></SelectContent>
            </Select>
          </Field>
          <Field label="Runtime">
            <Select value={f.runMode} onValueChange={(v) => set("runMode", v as any)}>
              <SelectTrigger data-testid="select-p-runmode"><SelectValue /></SelectTrigger>
              <SelectContent><SelectItem value="live">Live agent</SelectItem><SelectItem value="demo">Simulator (demo)</SelectItem></SelectContent>
            </Select>
          </Field>
          {f.agent === "opencode" ? (
            <Field label="OpenCode server URL"><Input value={f.opencodeUrl ?? ""} onChange={(e) => set("opencodeUrl", e.target.value)} className="font-mono text-xs" data-testid="input-p-ocurl" /></Field>
          ) : (
            <Field label="Cline binary"><Input value={f.clineBin ?? ""} onChange={(e) => set("clineBin", e.target.value)} placeholder="cline" className="font-mono text-xs" data-testid="input-p-clinebin" /></Field>
          )}
          <Field label="Model override" hint={f.agent === "opencode" ? "provider/model, e.g. anthropic/claude-sonnet-4" : "passed as -m"}><Input value={f.model ?? ""} onChange={(e) => set("model", e.target.value)} className="font-mono text-xs" data-testid="input-p-model" /></Field>
          <Field label="Typecheck command" hint="leave blank for npx tsc --noEmit" className="sm:col-span-2"><Input value={f.typecheckCmd} onChange={(e) => set("typecheckCmd", e.target.value)} className="font-mono text-xs" data-testid="input-p-tsc" /></Field>
          <Field label="Lint command (ESLint JSON)" hint="leave blank for npx eslint -f json ." className="sm:col-span-2"><Input value={f.lintCmd} onChange={(e) => set("lintCmd", e.target.value)} className="font-mono text-xs" data-testid="input-p-lint" /></Field>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={!f.name || !f.worktreePath || !f.branch} data-testid="button-save-project">Save</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
