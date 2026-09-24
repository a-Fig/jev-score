import { api, doc, ws } from "../lib/api.js";
import { ago, plural, versionTitle } from "../lib/format.js";
import { $, $$, confirmAction, dirHtml, e, modal, toast } from "../lib/ui.js";

let templatesCache = null;
export async function templates() {
  templatesCache ||= await api("/api/templates");
  return templatesCache;
}

const readFile = (file) => file && file.size ? file.text() : Promise.resolve("");

// ---------------------------------------------------------------- workspace

export async function newWorkspaceDialog(app, navigate) {
  const starters = await templates();
  const groups = app.dashboard.groups;
  const body = `
    <div class="field-row">
      <label class="field">Name<input name="name" required placeholder="Senior product writer at Northstar" autofocus></label>
      <label class="field">Scored with
        <select name="group">
          <optgroup label="Templates">${starters.map((template) => `<option value="template:${e(template.id)}">${e(template.name)}</option>`).join("")}</optgroup>
          ${groups.length ? `<optgroup label="Your evaluation groups">${groups.map((group) => `<option value="group:${e(group.id)}">${e(group.name)}</option>`).join("")}</optgroup>` : ""}
          <option value="">Choose later</option>
        </select>
      </label>
    </div>
    <div class="field-row">
      <label class="field">What the drafts must satisfy<input name="contextTitle" placeholder="Job posting" value="${e(starters[0].contextTitle)}"></label>
      <label class="field">Load it from a file <span class="hint">optional</span><input type="file" name="contextFile" accept=".txt,.md,.markdown,text/plain,text/markdown"></label>
    </div>
    <label class="field">The context itself <span class="hint" data-hint>${e(starters[0].contextHint)}</span>
      <textarea name="contextContent" rows="8" required placeholder="Paste the job posting, prompt, brief, or requirements…"></textarea>
    </label>
    <details>
      <summary class="link" style="width:max-content">Add the first draft now <span class="faint">(optional)</span></summary>
      <div class="stack" style="margin-top:12px">
        <label class="field">Draft title<input name="draftTitle" placeholder="Original"></label>
        <label class="field">Draft text<textarea name="draftContent" rows="6" placeholder="Paste your current draft. It becomes the original, the baseline for every comparison."></textarea></label>
        <label class="field">Or load it from a file<input type="file" name="draftFile" accept=".txt,.md,.markdown,text/plain,text/markdown"></label>
      </div>
    </details>`;
  return modal({
    title: "New workspace", subtitle: "A workspace holds one context, every draft written for it, and every score.", body, wide: true,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: "Create workspace", kind: "primary", submit: true }],
    onMount(dialog) {
      const select = $("select[name=group]", dialog);
      const title = $("input[name=contextTitle]", dialog);
      let titleTouched = false;
      title.oninput = () => { titleTouched = true; };
      select.onchange = () => {
        const template = starters.find((item) => `template:${item.id}` === select.value);
        $("[data-hint]", dialog).textContent = template?.contextHint || "";
        if (template && !titleTouched) title.value = template.contextTitle;
      };
      $("input[name=contextFile]", dialog).onchange = async (event) => { const text = await readFile(event.target.files[0]); if (text) $("textarea[name=contextContent]", dialog).value = text; };
      $("input[name=draftFile]", dialog).onchange = async (event) => {
        const file = event.target.files[0];
        const text = await readFile(file);
        if (text) { $("textarea[name=draftContent]", dialog).value = text; const draftTitle = $("input[name=draftTitle]", dialog); if (!draftTitle.value) draftTitle.value = file.name.replace(/\.(md|markdown|txt)$/i, ""); }
      };
    },
    async onSubmit(form) {
      const choice = String(form.get("group") || "");
      const workspace = await api("/api/workspaces", { method: "POST", body: {
        name: form.get("name"), contextTitle: form.get("contextTitle") || "Context", contextContent: form.get("contextContent"),
        primaryGroup: choice.startsWith("group:") ? choice.slice(6) : null,
        template: choice.startsWith("template:") ? choice.slice(9) : null,
      } });
      const draft = String(form.get("draftContent") || "");
      if (draft.trim()) await api(`${ws(workspace.id)}/documents`, { method: "POST", body: { content: draft, title: String(form.get("draftTitle") || "").trim() || "Original", original: true } });
      navigate(`/w/${encodeURIComponent(workspace.id)}`);
      toast(`Created ${workspace.name}`);
      return workspace;
    },
  });
}

export async function editContextDialog(detail) {
  const { workspace, contexts } = detail;
  const older = contexts.filter((context) => !context.current);
  const body = `
    <p class="muted">Runs scored against an earlier version stay saved, marked stale, and stop counting toward rankings. Switching back to an earlier version makes its runs count again.</p>
    <label class="field">Title<input name="contextTitle" value="${e(workspace.contextTitle)}" required></label>
    <label class="field">Context<textarea name="contextContent" rows="14" required>${e(workspace.contextContent)}</textarea></label>
    ${older.length ? `<div class="field">Earlier versions<div class="stack" style="gap:6px">${older.map((context) => `<div class="row" style="justify-content:space-between;border:1px solid var(--rule);border-radius:8px;padding:8px 12px"><span><strong>${e(context.title)}</strong> <span class="faint">· used ${e(ago(context.activatedAt))} · ${plural(context.runs, "run")}</span></span><button type="button" class="btn small" data-restore="${e(context.id)}">Load this version</button></div>`).join("")}</div></div>` : ""}`;
  return modal({
    title: "Edit context", body, wide: true,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: "Save context", kind: "primary", submit: true }],
    onMount(dialog) {
      $$("[data-restore]", dialog).forEach((button) => button.onclick = () => {
        const context = older.find((item) => item.id === button.dataset.restore);
        $("textarea[name=contextContent]", dialog).value = context.content;
        $("input[name=contextTitle]", dialog).value = context.title;
        toast("Loaded. Save to switch back to this version.");
      });
    },
    async onSubmit(form) {
      const updated = await api(ws(workspace.id), { method: "PATCH", body: { contextTitle: form.get("contextTitle"), contextContent: form.get("contextContent") } });
      toast(updated.staleRunCount && updated.contextHash !== workspace.contextHash ? `Context saved. ${plural(updated.staleRunCount, "earlier run")} no longer count.` : "Context saved");
      return updated;
    },
  });
}

export async function renameWorkspaceDialog(workspace) {
  return modal({
    title: "Rename workspace",
    body: `<label class="field">Name<input name="name" value="${e(workspace.name)}" required></label>`,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: "Rename", kind: "primary", submit: true }],
    onSubmit: async (form) => api(ws(workspace.id), { method: "PATCH", body: { name: form.get("name") } }),
  });
}

export async function manageGroupsDialog(detail, app) {
  const attached = new Set(detail.groups.map((group) => group.id));
  const rows = app.dashboard.groups.map((group) => `<div class="row" style="justify-content:space-between;border:1px solid var(--rule);border-radius:8px;padding:10px 12px"><label class="check-row" style="gap:10px"><input type="checkbox" name="group" value="${e(group.id)}" ${attached.has(group.id) ? "checked" : ""}> <span><strong>${e(group.name)}</strong><br><span class="faint" style="font-weight:400;font-size:12.5px">${plural(group.questions.length, "question")}</span></span></label><label class="check-row" style="gap:6px;font-weight:400;font-size:12.5px"><input type="radio" name="primary" value="${e(group.id)}" ${detail.workspace.primaryGroupId === group.id ? "checked" : ""}> Primary</label></div>`).join("");
  return modal({
    title: "Evaluation groups for this workspace",
    subtitle: "Attach any group to score drafts with it. The primary group drives rankings and charts.",
    body: rows ? `<div class="stack" style="gap:8px">${rows}</div>` : `<p class="muted">No evaluation groups yet. Create one from Evaluation groups.</p>`,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: "Save", kind: "primary", submit: true }],
    async onSubmit(form) {
      // Unchecking a group detaches it, even the primary one; the radio only
      // counts for a group that stays attached.
      const chosen = new Set(form.getAll("group"));
      const picked = form.get("primary");
      const primary = picked && chosen.has(picked) ? picked : null;
      for (const id of chosen) if (!attached.has(id)) await api(`${ws(detail.workspace.id)}/groups`, { method: "POST", body: { group: id } });
      if (primary && primary !== detail.workspace.primaryGroupId) await api(ws(detail.workspace.id), { method: "PATCH", body: { primaryGroup: primary } });
      for (const id of attached) if (!chosen.has(id)) await api(`${ws(detail.workspace.id)}/groups/${encodeURIComponent(id)}`, { method: "DELETE" });
      return true;
    },
  });
}

export async function uploadDialog(detail, navigate) {
  const documents = detail.documents;
  const best = detail.matrix?.rows.find((row) => row.isBest);
  const body = `
    <label class="field">Text or Markdown file<input type="file" name="file" accept=".txt,.md,.markdown,text/plain,text/markdown" required></label>
    <div class="field-row">
      <label class="field">Title<input name="title" placeholder="From the file name"></label>
      <label class="field">Based on<select name="parent"><option value="">Nothing (a fresh start)</option>${[...documents].reverse().map((document) => `<option value="${e(document.id)}" ${best?.id === document.id ? "selected" : ""}>${e(versionTitle(document))}</option>`).join("")}</select></label>
    </div>
    <label class="field">What changed? <span class="hint">optional</span><input name="summary" placeholder="Led with outcomes; cut the objective statement"></label>
    <label class="check-row"><input type="checkbox" name="score" checked> Score it right away</label>`;
  return modal({
    title: "Add a draft from a file", body,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: "Add draft", kind: "primary", submit: true }],
    async onSubmit(form) {
      const file = form.get("file");
      const content = await readFile(file);
      if (!content.trim()) throw new Error("That file is empty.");
      const saved = await api(`${ws(detail.workspace.id)}/documents`, { method: "POST", body: { content, title: String(form.get("title") || "").trim() || file.name.replace(/\.(md|markdown|txt)$/i, ""), changeSummary: form.get("summary") || "", parentDocument: form.get("parent") || null } });
      if (saved.deduplicated) toast(`That text matches ${versionTitle(saved)}, so nothing new was saved.`);
      else toast(`Saved ${versionTitle(saved)}`);
      if (form.get("score") && !saved.deduplicated && detail.workspace.primaryGroupId) {
        api(`${doc(detail.workspace.id, saved.id)}/evaluate`, { method: "POST", body: { runs: 1 } })
          .then((result) => toast(`${versionTitle(saved)} scored ${result.overallScore?.toFixed(1) ?? "—"}`))
          .catch((error) => toast(error.message, { error: true }));
      }
      return saved;
    },
  });
}

export async function importDialog(navigate) {
  return modal({
    title: "Import a workspace",
    subtitle: "Load a workspace exported from Jev Score, with its drafts, context history, and scores.",
    body: `<label class="field">Export file<input type="file" name="file" accept=".json,application/json" required></label><label class="field">Name <span class="hint">optional, defaults to the exported name</span><input name="name"></label><p class="faint" style="font-size:12.5px">Exports that contain custom scorer code must be imported with the CLI: <code>jev-score workspace import &lt;file&gt;</code>.</p>`,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: "Import", kind: "primary", submit: true }],
    async onSubmit(form) {
      let bundle;
      try { bundle = JSON.parse(await readFile(form.get("file"))); } catch { throw new Error("That file is not valid JSON."); }
      const name = String(form.get("name") || "").trim();
      const workspace = await api(`/api/workspaces/import${name ? `?name=${encodeURIComponent(name)}` : ""}`, { method: "POST", body: bundle });
      toast(`Imported ${workspace.name}`);
      navigate(`/w/${encodeURIComponent(workspace.id)}`);
      return workspace;
    },
  });
}

// ---------------------------------------------------------------- groups

function questionRow(question = { text: "", direction: "higher" }) {
  return `<div class="q-row"><input name="q-text" value="${e(question.text)}" placeholder="The draft makes a clear, specific case for…" aria-label="Question"><div class="seg" role="group" aria-label="Better when"><button type="button" data-dir="higher" aria-pressed="${question.direction !== "lower"}">↑ Higher</button><button type="button" data-dir="lower" aria-pressed="${question.direction === "lower"}">↓ Lower</button></div><button type="button" class="btn icon small quiet" data-remove aria-label="Remove question">✕</button></div>`;
}

function wireQuestions(dialog) {
  const host = $(".q-editor", dialog);
  const wire = () => {
    $$(".q-row", host).forEach((row) => {
      $$("[data-dir]", row).forEach((button) => button.onclick = () => $$("[data-dir]", row).forEach((item) => item.setAttribute("aria-pressed", String(item === button))));
      $("[data-remove]", row).onclick = () => { row.remove(); if (!$(".q-row", host)) addRow(); };
      // Pasting several lines splits them into one question each.
      $("input", row).onpaste = (event) => {
        const lines = event.clipboardData.getData("text").split(/\r?\n/).map((line) => line.replace(/^\s*[-*\d.)]+\s+/, "").trim()).filter(Boolean);
        if (lines.length < 2) return;
        event.preventDefault();
        $("input", row).value = lines[0];
        let anchor = row;
        lines.slice(1).forEach((line) => { anchor.insertAdjacentHTML("afterend", questionRow({ text: line, direction: "higher" })); anchor = anchor.nextElementSibling; });
        wire();
      };
    });
  };
  const addRow = () => { $("[data-add-question]", dialog).insertAdjacentHTML("beforebegin", questionRow()); wire(); $$(".q-row input", host).at(-1).focus(); };
  $("[data-add-question]", dialog).onclick = addRow;
  wire();
}

const readQuestions = (dialog) => $$(".q-row", dialog).map((row) => ({ text: $("input", row).value.trim(), direction: $("[data-dir][aria-pressed=true]", row)?.dataset.dir || "higher" })).filter((question) => question.text);

export async function groupDialog({ group = null } = {}) {
  const editing = Boolean(group);
  const starters = editing ? [] : await templates();
  const editor = (questions) => `<div class="field">Questions <span class="hint">Phrase each as a criterion. Mark the ones where a lower score is better, such as red flags.</span><div class="q-editor">${questions.map(questionRow).join("")}<button type="button" class="btn small" data-add-question style="justify-self:start">Add question</button></div></div>`;
  const body = editing
    ? `<div class="field-row"><label class="field">Name<input name="name" value="${e(group.name)}" required></label><label class="field">Description<input name="description" value="${e(group.description)}"></label></div>${group.locked ? `<p class="notice" style="margin:0">This group has scored runs, so its questions are locked. Fork it to change them.</p><ol class="questions">${group.questions.map((question) => `<li><span>${e(question.text)}</span>${dirHtml(question.direction)}</li>`).join("")}</ol>` : editor(group.questions)}`
    : `<div class="field-row"><label class="field">Name<input name="name" placeholder="${e(starters[0].name)}"></label><label class="field">Description <span class="hint">optional</span><input name="description"></label></div>
       <div class="tabs" role="tablist"><button type="button" role="tab" aria-selected="true" data-tab="template">Start from a template</button><button type="button" role="tab" aria-selected="false" data-tab="custom">Write your own</button></div>
       <div data-panel="template"><div class="template-grid">${starters.map((template, index) => `<button type="button" class="template" data-template="${e(template.id)}" aria-pressed="${index === 0}"><strong>${e(template.name)}</strong><span>${e(template.description)}</span><small>${plural(template.questions.length, "question")} · ${e(template.contextTitle)}</small></button>`).join("")}</div><div data-preview style="margin-top:14px"></div></div>
       <div data-panel="custom" hidden>${editor([{ text: "", direction: "higher" }])}</div>`;
  return modal({
    title: editing ? `Edit ${group.name}` : "New evaluation group",
    subtitle: editing ? "" : "A reusable set of questions. Attach it to any workspace.",
    body, wide: true,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: editing ? "Save group" : "Create group", kind: "primary", submit: true }],
    onMount(dialog) {
      if (!editing || !group.locked) wireQuestions(dialog);
      if (editing) return;
      let tab = "template";
      let template = starters[0];
      const preview = () => { $("[data-preview]", dialog).innerHTML = `<ol class="questions">${template.questions.map((question) => `<li><span>${e(question.text)}<span class="key">${e(question.key)}</span></span>${dirHtml(question.direction)}</li>`).join("")}</ol>`; $("input[name=name]", dialog).placeholder = template.name; };
      $$("[data-tab]", dialog).forEach((button) => button.onclick = () => {
        tab = button.dataset.tab;
        $$("[data-tab]", dialog).forEach((item) => item.setAttribute("aria-selected", String(item === button)));
        $$("[data-panel]", dialog).forEach((panel) => { panel.hidden = panel.dataset.panel !== tab; });
        $("input[name=name]", dialog).placeholder = tab === "template" ? template.name : "Resume review";
      });
      $$("[data-template]", dialog).forEach((button) => button.onclick = () => {
        template = starters.find((item) => item.id === button.dataset.template);
        $$("[data-template]", dialog).forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
        preview();
      });
      dialog.dataset.mode = "template";
      dialog._state = () => ({ tab, template });
      preview();
    },
    async onSubmit(form, dialog) {
      const name = String(form.get("name") || "").trim();
      const description = String(form.get("description") || "").trim();
      if (editing) {
        const changes = { name, description };
        if (!group.locked) {
          const questions = readQuestions(dialog);
          if (!questions.length) throw new Error("Add at least one question.");
          changes.questions = questions.map((question, index) => ({ ...question, key: group.questions.find((item) => item.text === question.text)?.key || undefined, index }));
        }
        const saved = await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: "PATCH", body: changes });
        toast(`Saved ${saved.name}`);
        return saved;
      }
      const { tab, template } = dialog._state();
      if (tab === "template") {
        const created = await api("/api/groups", { method: "POST", body: { template: template.id, name: name || undefined, description: description || undefined } });
        toast(`Created ${created.name}`);
        return created;
      }
      const questions = readQuestions(dialog);
      if (!name) throw new Error("Give the group a name.");
      if (!questions.length) throw new Error("Add at least one question.");
      const created = await api("/api/groups", { method: "POST", body: { name, description, questions } });
      toast(`Created ${created.name}`);
      return created;
    },
  });
}

export async function deleteGroupFlow(group) {
  const ok = await confirmAction({ title: `Delete ${group.name}?`, message: `This deletes the group and all ${plural(group.runCount, "evaluation run")} scored with it, in every workspace. Drafts are kept.`, confirmLabel: "Delete group", danger: true });
  if (!ok) return false;
  await api(`/api/groups/${encodeURIComponent(group.id)}`, { method: "DELETE" });
  toast(`Deleted ${group.name}`);
  return true;
}
