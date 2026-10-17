// Switchyard VS Code companion — plain JS, no build step. Requires VS Code >= 1.85 (global fetch).
const vscode = require("vscode");

const cfg = () => vscode.workspace.getConfiguration("switchyard");
const base = () => String(cfg().get("url") || "http://localhost:5000").replace(/\/$/, "");

async function api(method, path, body) {
  const res = await fetch(base() + path, {
    method,
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`${res.status} ${await res.text()}`);
  const t = await res.text();
  return t ? JSON.parse(t) : undefined;
}

let panel;
async function openDashboard(route = "/") {
  const uri = await vscode.env.asExternalUri(vscode.Uri.parse(base()));
  const url = uri.toString().replace(/\/$/, "") + "/#" + route;
  if (!panel) {
    panel = vscode.window.createWebviewPanel("switchyard", "Switchyard", vscode.ViewColumn.Active, { enableScripts: true, retainContextWhenHidden: true });
    panel.onDidDispose(() => (panel = undefined));
  }
  panel.webview.html = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; frame-src ${uri.scheme}://${uri.authority}; style-src 'unsafe-inline';"></head>
  <body style="margin:0;padding:0;height:100vh;overflow:hidden"><iframe src="${url}" style="border:0;width:100%;height:100%"></iframe></body></html>`;
  panel.reveal();
}

async function review() {
  const snap = await api("GET", "/api/snapshot");
  const pending = snap.checkpoints.filter((c) => c.status === "pending");
  if (!pending.length) return vscode.window.showInformationMessage("Switchyard: nothing awaiting review");
  const pick = await vscode.window.showQuickPick(
    pending.map((c) => {
      const p = snap.projects.find((x) => x.id === c.projectId);
      return { label: c.title, description: `${p ? p.name : ""} · ${c.kind === "permission" ? c.tool : c.kind}`, detail: (c.body || "").split("\n").slice(0, 2).join(" "), c };
    }),
    { placeHolder: "Select a checkpoint" },
  );
  if (!pick) return;
  const c = pick.c;
  const actions = c.kind === "plan" ? ["Approve & Act", "Request changes", "Reject", "Open in dashboard"]
    : c.kind === "permission" ? ["Allow once", "Always allow", "Deny", "Open in dashboard"]
    : ["Approve & commit", "Request changes", "Discard changes", "Open in dashboard"];
  const a = await vscode.window.showQuickPick(actions, { placeHolder: c.title });
  if (!a) return;
  if (a === "Open in dashboard") return openDashboard(`/approvals/${c.id}`);
  const decision = a.startsWith("Approve") || a === "Allow once" ? "approve" : a === "Always allow" ? "approve_always" : a === "Request changes" ? "revise" : "reject";
  let feedback;
  if (decision === "revise") {
    feedback = await vscode.window.showInputBox({ prompt: "What should the agent change?" });
    if (!feedback) return;
  }
  if (decision === "reject" && c.kind === "review") {
    const ok = await vscode.window.showWarningMessage("Discard all uncommitted changes in this worktree?", { modal: true }, "Discard");
    if (ok !== "Discard") return;
  }
  await api("POST", `/api/checkpoints/${c.id}/resolve`, { decision, feedback });
  vscode.window.showInformationMessage(`Switchyard: ${a} — ${c.title}`);
}

function activate(context) {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  item.command = "switchyard.review";
  item.text = "$(git-branch) Switchyard";
  item.show();

  const tick = async () => {
    try {
      const s = await api("GET", "/api/snapshot");
      const pending = s.checkpoints.filter((c) => c.status === "pending").length;
      const errors = Object.values(s.diagnostics).reduce((a, d) => a + d.tscErrors + d.lintErrors, 0);
      const running = s.sessions.filter((x) => x.status === "busy").length;
      item.text = `$(git-branch) ${running} running  $(bell) ${pending}  $(error) ${errors}`;
      item.tooltip = `${s.projects.length} worktrees · ${pending} awaiting review · ${errors} errors`;
      item.backgroundColor = pending ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
    } catch {
      item.text = "$(debug-disconnect) Switchyard offline";
      item.backgroundColor = undefined;
    }
  };
  tick();
  const timer = setInterval(tick, Math.max(2, Number(cfg().get("pollSeconds")) || 5) * 1000);

  context.subscriptions.push(
    item,
    { dispose: () => clearInterval(timer) },
    vscode.commands.registerCommand("switchyard.open", () => openDashboard("/")),
    vscode.commands.registerCommand("switchyard.review", () => review().catch((e) => vscode.window.showErrorMessage(`Switchyard: ${e.message}`))),
  );
}

module.exports = { activate, deactivate() {} };
