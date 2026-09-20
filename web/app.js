const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const main = $("#main");
const state = { dashboard: null, workspace: null, group: null, question: "", mode: null, tableView: "metrics" };

async function api(path, options = {}) {
  const response = await fetch(path, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

function toast(message, error = false) {
  const element = $("#toast"); element.textContent = message; element.className = error ? "show error" : "show";
  clearTimeout(toast.timer); toast.timer = setTimeout(() => element.className = "", 3500);
}

function escapeHtml(value = "") { return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]); }
function score(value) { return value == null ? "—" : Number(value).toFixed(1); }
function date(value) { return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value)); }

async function loadDashboard() {
  state.dashboard = await api("/api/dashboard");
  $("#workspace-list").innerHTML = state.dashboard.workspaces.map((workspace) => `<button class="workspace-link ${state.workspace?.workspace.id === workspace.id ? "active" : ""}" data-id="${workspace.id}">${escapeHtml(workspace.name)}</button>`).join("");
  $$(".workspace-link").forEach((button) => button.onclick = () => { state.group = null; state.question = ""; state.mode = null; openWorkspace(button.dataset.id); });
  const groupOptions = state.dashboard.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  $("#workspace-form select[name=primaryGroup]").innerHTML = `<option value="">Choose later</option>${groupOptions}`;
}

async function openWorkspace(id, overrides = {}) {
  state.group = overrides.group ?? state.group;
  state.question = overrides.question ?? state.question;
  state.mode = overrides.mode ?? state.mode;
  const params = new URLSearchParams();
  if (state.group) params.set("group", state.group);
  if (state.question) params.set("question", state.question);
  if (state.mode) params.set("mode", state.mode);
  state.workspace = await api(`/api/workspaces/${encodeURIComponent(id)}?${params}`);
  state.group = state.workspace.ranking?.group.id || state.workspace.workspace.primaryGroupId;
  state.mode = state.workspace.ranking?.mode || state.workspace.workspace.rankingMode;
  await loadDashboard(); renderWorkspace();
}

function renderEmpty() {
  main.innerHTML = `<section class="empty"><p class="eyebrow">Local evaluation workspace</p><h1>Make every revision measurable.</h1><p>Keep context, drafts, Jev evaluations, and progress together. Your documents stay in a local SQLite database.</p><button class="primary" id="empty-new">Create your first workspace</button><div class="empty-card"><strong>Built for you and your coding agent</strong><span class="subtle">Everything in this interface is also available through the CLI.</span><p><code>jev-score ui</code> · <code>jev-score --help</code></p></div></section>`;
  $("#empty-new").onclick = () => $("#workspace-dialog").showModal();
}

function chartSvg(points) {
  if (!points.length || points.every((point) => point.delta == null)) return `<div class="chart-empty">Run a few evaluations to see progress.</div>`;
  const usable = points.filter((point) => point.delta != null);
  const width = 700, height = 210, pad = 24;
  let min = Math.min(0, ...usable.map((point) => Math.min(point.delta, point.frontier)));
  let max = Math.max(0, ...usable.map((point) => Math.max(point.delta, point.frontier)));
  if (min === max) { min -= 1; max += 1; }
  const x = (index) => pad + (usable.length === 1 ? (width - pad * 2) / 2 : index * (width - pad * 2) / (usable.length - 1));
  const y = (value) => height - pad - ((value - min) / (max - min)) * (height - pad * 2);
  const line = (key) => usable.map((point, index) => `${index ? "L" : "M"}${x(index)},${y(point[key])}`).join(" ");
  return `<svg id="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Score change over evaluation runs"><line class="axis" x1="${pad}" x2="${width-pad}" y1="${y(0)}" y2="${y(0)}"/><path class="frontier-line" d="${line("frontier")}"/><path class="chart-line" d="${line("delta")}"/>${usable.map((point,index)=>`<circle class="dot" cx="${x(index)}" cy="${y(point.delta)}" r="4"><title>${escapeHtml(point.documentTitle)}: ${point.delta > 0 ? "+" : ""}${point.delta}</title></circle>`).join("")}</svg>`;
}

function documentName(document) {
  return `<div class="doc-title">${escapeHtml(document.title)} ${document.isOriginal ? `<span class="badge original">Original</span>` : ""} ${document.isBest ? `<span class="badge best">Best</span>` : ""}</div><div class="doc-summary">${escapeHtml(document.changeSummary || date(document.createdAt))}</div>`;
}

function documentActions(workspace, document, canEvaluate) {
  return `<div class="row-actions"><button data-view="${document.id}">View</button><a href="/api/workspaces/${workspace.id}/documents/${document.id}?download">Download</a>${canEvaluate ? `<button data-evaluate="${document.id}">Evaluate</button>` : ""}</div>`;
}

function rankingTable(workspace, documents, canEvaluate) {
  if (!documents.length) return `<div class="chart-empty">Add the original document to begin.</div>`;
  return `<div class="table-scroll"><table><thead><tr><th>Document</th><th>Rank score</th><th>Median</th><th>Range</th><th>Runs</th><th>Change</th><th></th></tr></thead><tbody>${documents.map((document) => `<tr><td>${documentName(document)}</td><td class="score">${score(document.rankScore)}</td><td>${score(document.median)}</td><td>${document.runs < 2 ? "—" : `${score(document.min)}–${score(document.max)} <span class="subtle">(${score(document.spread)})</span>`}</td><td>${document.runs}</td><td class="${document.delta > 0 ? "delta" : ""}">${document.delta == null ? "—" : `${document.delta > 0 ? "+" : ""}${score(document.delta)}`}</td><td>${documentActions(workspace, document, canEvaluate)}</td></tr>`).join("")}</tbody></table></div>`;
}

function metricsTable(workspace, matrix, canEvaluate) {
  if (!matrix?.rows.length) return `<div class="chart-empty">Add the original document to begin.</div>`;
  return `<div class="table-scroll"><table class="matrix-table"><thead><tr><th>Document</th><th>Overall</th>${matrix.questions.map((question) => `<th title="${escapeHtml(question.text)}">${escapeHtml(question.text)}</th>`).join("")}<th>Runs</th><th></th></tr></thead><tbody>${matrix.rows.map((document) => `<tr><td>${documentName(document)}</td><td class="score">${score(document.overallScore)}</td>${matrix.questions.map((question) => `<td>${score(document.scores[question.key])}</td>`).join("")}<td>${document.runs}</td><td>${documentActions(workspace, document, canEvaluate)}</td></tr>`).join("")}</tbody></table></div>`;
}

function renderWorkspace() {
  const { workspace, groups, documents, ranking: result, matrix } = state.workspace;
  const allGroups = state.dashboard.groups;
  const active = groups.find((group) => group.id === result?.group.id);
  const options = groups.map((group) => `<option value="${group.id}" ${group.id === result?.group.id ? "selected" : ""}>${escapeHtml(group.name)}</option>`).join("");
  const attachable = allGroups.filter((group) => !groups.some((item) => item.id === group.id));
  const questionOptions = active?.questions.map((question) => `<option value="${question.key}" ${state.question === question.key ? "selected" : ""}>${escapeHtml(question.text)}</option>`).join("") || "";
  const ranked = result?.items || documents.map((document) => ({ ...document, runs: 0 }));
  const evaluated = ranked.filter((item) => item.rankScore != null);
  const best = evaluated[0];
  main.innerHTML = `<section>
    <div class="topbar"><div><p class="eyebrow">Workspace</p><h1>${escapeHtml(workspace.name)}</h1><p class="subtle">${documents.length} document${documents.length === 1 ? "" : "s"} · ${workspace.runCount} evaluation${workspace.runCount === 1 ? "" : "s"}</p></div>
      <div class="toolbar"><button class="ghost" id="upload">＋ Add document</button><button class="ghost" id="delete-workspace">•••</button></div></div>
    <details class="context-card"><summary><span>${escapeHtml(workspace.contextTitle)}</span><span class="subtle">View context</span></summary><pre>${escapeHtml(workspace.contextContent)}</pre></details>
    ${groups.length ? `<div class="toolbar" style="justify-content:flex-start;margin:16px 0"><select id="group-select">${options}</select><select id="metric-select"><option value="">Overall score</option>${questionOptions}</select><div class="segmented"><button data-mode="max" class="${result?.mode === "max" ? "active" : ""}">Highest</button><button data-mode="median" class="${result?.mode === "median" ? "active" : ""}">Median</button></div>${attachable.length ? `<select id="attach-select"><option value="">＋ Attach group…</option>${attachable.map((g)=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}</select>` : ""}</div>` : `<div class="empty-card"><strong>No evaluation group attached</strong><p class="subtle">Create a reusable group or attach one from the group library.</p><button class="primary" id="workspace-new-group">Create group</button>${allGroups.length ? `<select id="attach-select" style="margin-top:10px"><option value="">Attach existing…</option>${allGroups.map((g)=>`<option value="${g.id}">${escapeHtml(g.name)}</option>`).join("")}</select>` : ""}</div>`}
    ${result ? `<div class="grid">
      <article class="chart-card"><div class="card-head"><div><h2>Progress from original</h2><p>Each run and the best-so-far frontier · percentage points</p></div><span class="metric-note">${escapeHtml(result.question?.text || "Overall")}</span></div>${chartSvg(result.timeline)}</article>
      <article class="chart-card"><div class="card-head"><div><h2>Current leader</h2><p>${result.mode === "max" ? "Highest score ever" : "Median across runs"}</p></div>${best ? `<span class="badge best">Best</span>` : ""}</div>${best ? `<h3 style="font-size:22px;margin:24px 0 4px">${escapeHtml(best.title)}</h3><div class="stats"><div class="stat"><strong>${score(best.rankScore)}</strong><span>rank score</span></div><div class="stat"><strong>${best.runs}</strong><span>runs</span></div><div class="stat"><strong>${best.runs > 1 ? score(best.spread) : "—"}</strong><span>spread</span></div></div>` : `<div class="chart-empty">No scores yet.</div>`}</article>
    </div>` : ""}
    <article class="table-card" style="margin-top:16px"><div class="table-title"><div><h2>Documents</h2>${active ? `<span class="subtle">${escapeHtml(active.name)} · ${result.mode === "max" ? "highest" : "median"}</span>` : ""}</div>${matrix ? `<div class="segmented table-toggle"><button data-table-view="metrics" class="${state.tableView === "metrics" ? "active" : ""}">All metrics</button><button data-table-view="ranking" class="${state.tableView === "ranking" ? "active" : ""}">Ranking</button></div>` : ""}</div>
      ${state.tableView === "metrics" && matrix ? metricsTable(workspace, matrix, Boolean(active)) : rankingTable(workspace, ranked, Boolean(active))}</article>
  </section>`;
  $("#upload").onclick = () => openUpload(documents);
  $("#delete-workspace").onclick = async () => { if (confirm(`Delete “${workspace.name}” and every document and score inside it?`)) { await api(`/api/workspaces/${workspace.id}`, { method: "DELETE" }); state.workspace = null; state.group = null; state.question = ""; state.mode = null; await loadDashboard(); state.dashboard.workspaces.length ? openWorkspace(state.dashboard.workspaces[0].id) : renderEmpty(); } };
  $("#workspace-new-group")?.addEventListener("click", () => $("#group-dialog").showModal());
  $("#group-select")?.addEventListener("change", async (event) => { state.question = ""; await api(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ primaryGroup: event.target.value }) }); openWorkspace(workspace.id, { group: event.target.value }); });
  $("#metric-select")?.addEventListener("change", (event) => openWorkspace(workspace.id, { question: event.target.value }));
  $$("[data-mode]").forEach((button) => button.onclick = async () => { await api(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ rankingMode: button.dataset.mode }) }); openWorkspace(workspace.id, { mode: button.dataset.mode }); });
  $("#attach-select")?.addEventListener("change", async (event) => { if (!event.target.value) return; await api(`/api/workspaces/${workspace.id}/groups`, { method: "POST", body: JSON.stringify({ group: event.target.value }) }); await api(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ primaryGroup: event.target.value }) }); state.question = ""; openWorkspace(workspace.id, { group: event.target.value }); });
  $$('[data-view]').forEach((button) => button.onclick = () => viewDocument(workspace.id, button.dataset.view));
  $$('[data-evaluate]').forEach((button) => button.onclick = () => evaluate(workspace.id, button.dataset.evaluate, button));
  $$('[data-table-view]').forEach((button) => button.onclick = () => { state.tableView = button.dataset.tableView; renderWorkspace(); });
}

async function evaluate(workspaceId, documentId, button) {
  const old = button.innerHTML; button.disabled = true; button.innerHTML = `<span class="spinner"></span>`;
  try { const run = await api(`/api/workspaces/${workspaceId}/documents/${documentId}/evaluate`, { method: "POST", body: JSON.stringify({ group: state.group }) }); toast(run.status === "success" ? "Evaluation complete" : "Question scores saved; the overall scorer failed", run.status !== "success"); await openWorkspace(workspaceId); }
  catch (error) { toast(error.message, true); await openWorkspace(workspaceId); }
  finally { button.disabled = false; button.innerHTML = old; }
}

function openUpload(documents) {
  const form = $("#document-form"); form.reset();
  form.elements.parentDocument.innerHTML = `<option value="">No parent</option>${documents.map((document) => `<option value="${document.id}">${escapeHtml(document.title)}</option>`).join("")}`;
  $("#document-dialog").showModal();
}

async function viewDocument(workspaceId, documentId) {
  const document = await api(`/api/workspaces/${workspaceId}/documents/${documentId}`);
  const history = document.runs.length ? document.runs.map((run) => `<article class="run-card"><div class="run-head"><div><strong>${escapeHtml(run.groupName)}</strong><span class="subtle">${date(run.createdAt)} · ${escapeHtml(run.model || run.status)}</span></div><span class="score">${score(run.overallScore)}</span></div>${run.error || run.aggregationError ? `<p class="run-error">${escapeHtml(run.error || run.aggregationError)}</p>` : ""}${run.scores.length ? `<div class="score-list">${run.scores.map((item)=>`<div><span>${escapeHtml(item.text)}</span><strong>${score(item.score)}</strong></div>`).join("")}</div>` : ""}</article>`).join("") : `<p class="subtle">No evaluation runs yet.</p>`;
  $("#viewer").innerHTML = `<div class="viewer-shell"><div class="viewer-top"><div><p class="eyebrow">${document.isOriginal ? "Original" : "Revision"}</p><h2>${escapeHtml(document.title)}</h2><p class="subtle">${escapeHtml(document.changeSummary || date(document.createdAt))}</p></div><div class="viewer-actions"><a class="ghost" href="/api/workspaces/${workspaceId}/documents/${documentId}?download">Download</a><button class="icon" id="close-viewer">×</button></div></div><pre class="viewer-content">${escapeHtml(document.content)}</pre><h3 class="history-title">Evaluation history</h3><div class="run-list">${history}</div></div>`;
  $("#close-viewer").onclick = () => $("#viewer-dialog").close(); $("#viewer-dialog").showModal();
}

function renderGroups() {
  state.workspace = null; loadDashboard().then(() => {
    main.innerHTML = `<section class="groups-page"><div class="topbar"><div><p class="eyebrow">Library</p><h1>Evaluation groups</h1><p class="subtle">Reusable questions that can be attached to any workspace.</p></div><button class="primary" id="new-group">＋ New group</button></div><div class="groups-list">${state.dashboard.groups.map((group)=>`<article class="group-card"><header><div><h3>${escapeHtml(group.name)}</h3><span class="subtle">${group.questions.length} question${group.questions.length === 1 ? "" : "s"} · ${group.scorerKind === "mean-v1" ? "Arithmetic mean" : "Custom JavaScript scorer"}${group.locked ? " · Locked after first run" : ""}</span></div><div class="row-actions"><button data-rename-group="${group.id}">Rename</button><button class="danger" data-delete-group="${group.id}">Delete</button></div></header>${group.description ? `<p>${escapeHtml(group.description)}</p>` : ""}<ol class="questions">${group.questions.map((question)=>`<li>${escapeHtml(question.text)} <span class="subtle">${question.key}</span></li>`).join("")}</ol></article>`).join("") || `<div class="empty-card">No groups yet.</div>`}</div></section>`;
    $("#new-group").onclick = () => $("#group-dialog").showModal();
    $$('[data-rename-group]').forEach((button)=>button.onclick=async()=>{ const group=state.dashboard.groups.find((g)=>g.id===button.dataset.renameGroup); const name=prompt("Evaluation group name",group.name); if(name?.trim() && name.trim() !== group.name){ await api(`/api/groups/${group.id}`,{method:"PATCH",body:JSON.stringify({name:name.trim()})}); toast("Evaluation group renamed"); renderGroups(); }});
    $$('[data-delete-group]').forEach((button)=>button.onclick=async()=>{ const group=state.dashboard.groups.find((g)=>g.id===button.dataset.deleteGroup); if(confirm(`Delete “${group.name}” and all of its evaluation runs?`)){ await api(`/api/groups/${group.id}`,{method:"DELETE"}); toast("Evaluation group deleted"); renderGroups(); }});
  });
}

$("#new-workspace").onclick = () => $("#workspace-dialog").showModal();
$("#manage-groups").onclick = renderGroups;
$$('[data-close]').forEach((button) => button.onclick = () => button.closest("dialog").close());
$("#workspace-form").addEventListener("submit", async (event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); try { const workspace = await api("/api/workspaces", { method: "POST", body: JSON.stringify(Object.fromEntries(form)) }); formElement.reset(); $("#workspace-dialog").close(); state.group = null; state.question = ""; state.mode = null; await openWorkspace(workspace.id); } catch (error) { toast(error.message, true); } });
$("#group-form").addEventListener("submit", async (event) => { event.preventDefault(); const formElement = event.currentTarget; const form = new FormData(formElement); const data = Object.fromEntries(form); data.questions = data.questions.split(/\r?\n/).map((line)=>line.trim()).filter(Boolean); try { const group = await api("/api/groups", { method: "POST", body: JSON.stringify(data) }); formElement.reset(); $("#group-dialog").close(); toast(`Created ${group.name}`); if (state.workspace) { await api(`/api/workspaces/${state.workspace.workspace.id}/groups`, { method: "POST", body: JSON.stringify({ group: group.id }) }); await api(`/api/workspaces/${state.workspace.workspace.id}`, { method: "PATCH", body: JSON.stringify({ primaryGroup: group.id }) }); openWorkspace(state.workspace.workspace.id, { group: group.id, question: "" }); } else renderGroups(); } catch (error) { toast(error.message, true); } });
$("#document-form").addEventListener("submit", async (event) => { event.preventDefault(); const form = new FormData(event.currentTarget); const file = form.get("file"); try { const document = await api(`/api/workspaces/${state.workspace.workspace.id}/documents`, { method: "POST", body: JSON.stringify({ content: await file.text(), title: form.get("title") || file.name, changeSummary: form.get("changeSummary"), parentDocument: form.get("parentDocument") || null }) }); $("#document-dialog").close(); toast(document.deduplicated ? "This exact document was already saved" : "Document added"); openWorkspace(state.workspace.workspace.id); } catch (error) { toast(error.message, true); } });

loadDashboard().then(() => state.dashboard.workspaces.length ? openWorkspace(state.dashboard.workspaces[0].id) : renderEmpty()).catch((error) => { main.innerHTML = `<section class="empty"><h1>Could not load Jev Score</h1><p>${escapeHtml(error.message)}</p></section>`; });
