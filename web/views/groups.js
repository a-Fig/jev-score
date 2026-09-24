import { api } from "../lib/api.js";
import { plural } from "../lib/format.js";
import { $$, dirHtml, e, toast } from "../lib/ui.js";
import { deleteGroupFlow, groupDialog } from "./dialogs.js";

export async function mount(ctx) {
  const { root, app, setTitle, refreshShell } = ctx;
  setTitle("Evaluation groups");
  let groups = await api("/api/dashboard").then((dashboard) => dashboard.groups);

  function render() {
    root.innerHTML = `<section class="page">
      <div class="page-head">
        <div><p class="eyebrow">Library</p><h1>Evaluation groups</h1><p class="meta">Reusable sets of questions. Attach one to any workspace, and every draft there is scored against it.</p></div>
        <div class="actions"><button class="btn primary" id="new-group">New group</button></div>
      </div>
      ${groups.length ? `<div class="group-grid">${groups.map((group) => `<article class="card group-card" id="group-${e(group.id)}">
        <div class="row" style="justify-content:space-between;align-items:flex-start;flex-wrap:nowrap">
          <div><h2>${e(group.name)}</h2>${group.description ? `<p class="muted" style="margin-top:4px">${e(group.description)}</p>` : ""}</div>
          <details class="menu"><summary class="btn icon small quiet" aria-label="Actions for ${e(group.name)}">⋯</summary><div class="menu-list">
            <button data-edit="${e(group.id)}">${group.locked ? "Rename or describe" : "Edit questions"}</button>
            <button data-fork="${e(group.id)}">Fork<span class="hint">copy to change</span></button>
            <hr><button class="danger" data-delete="${e(group.id)}">Delete</button>
          </div></details>
        </div>
        <div class="meta"><span>${plural(group.questions.length, "question")}</span><span>${group.scorerKind === "mean-v1" ? "Overall: direction-aware mean" : "Overall: custom scorer"}</span><span>${plural(group.workspaceCount, "workspace")}</span><span>${plural(group.runCount, "run")}</span>${group.locked ? `<span class="badge locked" title="Questions can't change once drafts are scored. Fork to change them.">Locked</span>` : ""}</div>
        <ol class="questions">${group.questions.map((question) => `<li><span>${e(question.text)}<span class="key">${e(question.key)}</span></span>${dirHtml(question.direction)}</li>`).join("")}</ol>
      </article>`).join("")}</div>` : `<div class="card docs-empty"><h3>No evaluation groups yet</h3><p>Start from a template for resumes, cover letters, essays, emails, READMEs, landing pages, specs, or blog posts, or write your own questions.</p><button class="btn primary" id="new-group-2">Create a group</button></div>`}
    </section>`;
    const create = async () => { if (await groupDialog()) await refresh(); };
    for (const id of ["new-group", "new-group-2"]) { const button = root.querySelector(`#${id}`); if (button) button.onclick = create; }
    $$("[data-edit]", root).forEach((button) => button.onclick = async () => { if (await groupDialog({ group: groups.find((group) => group.id === button.dataset.edit) })) await refresh(); });
    $$("[data-fork]", root).forEach((button) => button.onclick = async () => {
      const fork = await api(`/api/groups/${encodeURIComponent(button.dataset.fork)}/fork`, { method: "POST", body: {} });
      toast(`Created ${fork.name}. Its questions are editable.`);
      await refresh();
      const edited = await groupDialog({ group: groups.find((group) => group.id === fork.id) });
      if (edited) await refresh();
    });
    $$("[data-delete]", root).forEach((button) => button.onclick = async () => { if (await deleteGroupFlow(groups.find((group) => group.id === button.dataset.delete))) await refresh(); });
  }

  async function refresh() {
    groups = (await api("/api/dashboard")).groups;
    app.dashboard.groups = groups;
    if (ctx.isCurrent()) render();
    refreshShell();
  }

  render();
  return { refresh: async () => { groups = (await api("/api/dashboard")).groups; if (ctx.isCurrent()) render(); } };
}
