import { api } from "../lib/api.js";
import { sparkline } from "../lib/chart.js";
import { ago, plural, score } from "../lib/format.js";
import { $, deltaHtml, e } from "../lib/ui.js";
import { importDialog, newWorkspaceDialog } from "./dialogs.js";

export async function mount(ctx) {
  const { root, app, navigate, setTitle } = ctx;
  setTitle("");

  function card(workspace, busy) {
    const spark = sparkline(workspace.timeline);
    return `<a class="card ws-card" href="/w/${encodeURIComponent(workspace.id)}" data-link>
      ${busy ? `<span class="badge scoring scoring">Scoring</span>` : ""}
      <div><p class="eyebrow">${e(workspace.contextTitle)}</p><h2>${e(workspace.name)}</h2></div>
      ${workspace.best ? `<div class="figure"><strong>${score(workspace.best.score)}</strong>${workspace.delta != null ? `${deltaHtml(workspace.delta)}<span class="faint" style="font-size:12.5px">vs original</span>` : ""}</div><p class="best-line">Best: #${workspace.best.version} ${e(workspace.best.title)}</p>` : `<div class="figure"><strong class="faint">—</strong></div><p class="best-line">${workspace.groupName ? "No scores yet" : "No evaluation group attached"}</p>`}
      ${spark || `<div class="spark-empty">${workspace.evaluated ? "Score a second draft to see progress" : "Progress appears after a few scores"}</div>`}
      <div class="foot"><span>${plural(workspace.documentCount, "draft")} · ${plural(workspace.runCount, "run")}</span><span>${e(ago(workspace.lastActivityAt))}</span></div>
    </a>`;
  }

  function welcome() {
    return `<section class="page welcome">
      <div>
        <p class="eyebrow">Jev Score</p>
        <h1>Every draft, <em>measured.</em></h1>
        <p class="lede">Score each version of a resume, essay, or pitch against what it has to satisfy. See which changes helped, keep the best draft, and let your coding agent iterate while you watch.</p>
        <ol>
          <li><span><strong>Paste the context.</strong> A job posting, an essay prompt, a brief.</span></li>
          <li><span><strong>Pick a rubric.</strong> Start from a template or write your own questions.</span></li>
          <li><span><strong>Add your draft and revise.</strong> Edit here, or have Claude Code or Codex do it through the CLI or MCP server.</span></li>
        </ol>
        <div class="row"><button class="btn primary" id="welcome-new">Create your first workspace</button><button class="btn quiet" id="welcome-import">Import a workspace</button></div>
        <p class="agent-note">Agents: <code>jev-score --help</code> for the CLI, <code>jev-score mcp</code> for the MCP server.</p>
      </div>
      <div class="welcome-art" aria-hidden="true">${sampleSheet()}</div>
    </section>`;
  }

  function render() {
    const { workspaces, activity } = app.dashboard;
    if (!workspaces.length) {
      root.innerHTML = welcome();
      $("#welcome-new", root).onclick = () => newWorkspaceDialog(app, navigate);
      $("#welcome-import", root).onclick = () => importDialog(navigate);
      return;
    }
    const busy = new Set(activity.map((item) => item.workspaceId));
    const best = workspaces.filter((workspace) => workspace.delta != null).sort((a, b) => b.delta - a.delta)[0];
    root.innerHTML = `<section class="page">
      <div class="page-head">
        <div><p class="eyebrow">Your desk</p><h1>Workspaces</h1><p class="meta">${plural(workspaces.length, "workspace")}${best ? ` · biggest gain: ${e(best.name)} ${deltaHtml(best.delta)}` : ""}</p></div>
        <div class="actions"><button class="btn quiet" id="import">Import</button><button class="btn primary" id="new">New workspace</button></div>
      </div>
      <div class="home-grid">${workspaces.map((workspace) => card(workspace, busy.has(workspace.id))).join("")}<button class="new-card" id="new-card"><span>+</span>New workspace</button></div>
    </section>`;
    $("#new", root).onclick = () => newWorkspaceDialog(app, navigate);
    $("#new-card", root).onclick = () => newWorkspaceDialog(app, navigate);
    $("#import", root).onclick = () => importDialog(navigate);
  }

  render();
  return {
    async refresh() { app.dashboard = await api("/api/dashboard"); render(); },
  };
}

// A static illustration of the idea: a draft with red-pen margin notes.
function sampleSheet() {
  return `<div class="card" style="padding:34px 30px 28px;transform:rotate(-1.2deg);box-shadow:var(--shadow-lg)">
    <div style="display:grid;grid-template-columns:1fr 92px;gap:22px">
      <div class="manuscript" style="font-size:15px;line-height:1.65">
        <h3 style="margin-top:0">Avery Stone</h3>
        <p>Product writer who makes technical tools easier to understand.</p>
        <p><del style="text-decoration-color:var(--vermilion);text-decoration-thickness:1.6px;color:var(--graphite)">Responsible for documentation.</del> <ins style="text-decoration:underline;text-decoration-color:var(--blue-pencil);text-decoration-thickness:1.6px;text-underline-offset:3px;background:var(--blue-wash)">Rebuilt onboarding docs, cutting setup tickets 28%.</ins></p>
        <p style="color:var(--graphite)">Owned release notes for three product teams…</p>
      </div>
      <div style="border-left:1px solid var(--rule);padding-left:14px;display:grid;gap:14px;align-content:start;font-size:11px;color:var(--graphite)">
        <div>Fit<br><strong style="font-size:18px;color:var(--ink)">91.0</strong></div>
        <div style="color:var(--vermilion-ink)">Evidence<br><strong style="font-size:18px">76.0</strong></div>
        <div>Scan<br><strong style="font-size:18px;color:var(--ink)">88.5</strong></div>
      </div>
    </div>
  </div>`;
}
