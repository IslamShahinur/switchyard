# Switchyard — multi-project AI coding agent control

A web dashboard (plus a VS Code companion extension) for running 3–4+ AI coding agents in parallel, one per **git worktree**, on **Cline CLI** or **OpenCode server mode**.

- **Tracks overview**: each worktree's branch, HEAD, dirty files, agent connection, and current session status.
- **Live sessions**: transcripts streamed from OpenCode's `/event` SSE bus or Cline's `--json` NDJSON output. You can send follow-ups in plan or act mode, or abort.
- **Real-time diagnostics**: `tsc --noEmit` and `eslint -f json` re-run whenever a file changes in a worktree (recursive `fs.watch`, debounced), with an error/warning trend per project.
- **Checkpoints**:
  - **Plan → Act**: the agent plans read-only. You approve (with notes), ask for revisions, or reject.
  - **Permission**: OpenCode tool requests (edit/bash/…) with the proposed diff. Allow once, always, or deny.
  - **Diff review**: when an act run finishes, approving commits to the worktree branch and rejecting discards the changes.
- **Scheduled project creation**: 5-field cron. Each run does `git worktree add -b <template>`, an optional scaffold command, registers the project, and starts an agent session. It skips the run when the concurrency limit is reached.
- **Demo simulator**: a scripted agent that makes **real edits** in the demo worktrees, so diagnostics, git status, and diffs are all real.

## Run

```bash
npm ci
./script/setup-demo.sh          # optional: creates ../demo-env (repo + 4 worktrees)
npm run dev                     # http://localhost:5000
```

State persists to `data/switchyard.json`. Env vars: `SWITCHYARD_DATA`, `SWITCHYARD_DEMO_ROOT`.

## Connect real agents

**OpenCode** (one server per worktree):
```bash
cd ../worktrees/checkout-v2 && opencode serve --port 4096 --hostname 127.0.0.1
```
Add the project with Agent = OpenCode, Runtime = Live, URL = `http://127.0.0.1:4096`.
Endpoints used: `GET /global/health`, `GET /event` (SSE), `GET /session`, `GET /session/status`, `POST /session`,
`POST /session/:id/prompt_async` (`agent: "plan" | "build"`), `GET /session/:id/message`, `POST /session/:id/abort`,
`POST /session/:id/permissions/:permissionID` (falls back to `POST /permission/:id/reply`).

**Cline CLI** (headless):
```bash
npm i -g cline && cline auth
```
Plan runs use `cline --json -p -c <worktree> "<task>"`. Once you approve, the act run uses `cline --json -c <worktree> --auto-approve true "<approved plan>"`.
Headless Cline runs are one-shot, so the dashboard handles the plan → act gate and the final diff review itself.

## VS Code extension

```bash
cd vscode-extension && npx @vscode/vsce package && code --install-extension switchyard-0.1.0.vsix
```
The status bar shows running sessions, pending approvals, and errors. Click it to approve, reject, or revise from the command palette, or run **Switchyard: Open Dashboard** to embed the UI.

## Layout

```
server/drivers/opencode.ts   REST + SSE client
server/drivers/cline.ts      child-process NDJSON driver
server/drivers/simulator.ts  demo agent (real file edits)
server/monitors.ts           git worktrees, tsc/eslint runner + watcher, cron
server/hub.ts                checkpoints, review/commit, scheduler, boot
client/src/pages/*           Overview, Approvals, Project, Diagnostics, Schedules, Setup
vscode-extension/            companion extension
```
