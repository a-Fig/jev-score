import { isComparing, toggleCompare } from "../app.js";
import { api, doc, ws } from "../lib/api.js";
import { mountProgressChart } from "../lib/chart-ui.js";
import { ago, plural, score, signed, versionLabel, versionTitle } from "../lib/format.js";
import { $, $$, confirmAction, deltaHtml, dirHtml, download, e, storage, toast } from "../lib/ui.js";
import { editContextDialog, manageGroupsDialog, renameWorkspaceDialog, uploadDialog } from "./dialogs.js";

export async function mount(ctx) {
  const { root, params, query, app, navigate, setTitle, refreshShell } = ctx;
  const workspaceId = params.workspace;
  const view = { tab: query.get("view") || storage.get("jev-docs-tab", "scores"), batch: null };
  let detail = null;

  async function load() {
    const search = new URLSearchParams();
    for (const key of ["group", "question", "mode"]) if (query.get(key)) search.set(key, query.get(key));
    detail = await api(`${ws(workspaceId)}?${search}`);
    controller.documents = detail.documents;
  }

  const scoringIds = () => new Set([...detail.activity.map((item) => item.documentId), ...app.scoring]);
  const href = (path = "") => `/w/${encodeURIComponent(workspaceId)}${path}`;
  const docHref = (document) => href(`/d/${encodeURIComponent(document.id)}`);

  async function scoreDocument(document, runs = 1) {
    if (!detail.ranking) { toast("Attach an evaluation group before scoring.", { error: true }); return; }
    app.scoring.add(document.id);
    render();
    try {
      const result = await api(`${doc(workspaceId, document.id)}/evaluate`, { method: "POST", body: { group: detail.ranking.group.id, runs } });
      const parts = [`${versionTitle(document)} scored ${score(result.overallScore)}`];
      if (result.vsParent != null) parts.push(`${result.vsParent >= 0 ? "+" : ""}${result.vsParent.toFixed(1)} vs parent`);
      if (result.isBest) parts.push("new best");
      toast(parts.join(" · "), { error: result.status !== "success" && result.status !== "partial" });
    } catch (error) {
      toast(error.message, { error: true });
    } finally {
      app.scoring.delete(document.id);
      await refresh();
    }
  }

  async function scoreUnscored() {
    const pending = detail.matrix.rows.filter((row) => !row.evaluated && !scoringIds().has(row.id)).sort((a, b) => a.version - b.version);
    if (!pending.length) return;
    view.batch = { done: 0, total: pending.length, failed: 0 };
    render();
    for (const document of pending) {
      if (!ctx.isCurrent()) break;
      app.scoring.add(document.id);
      try { await api(`${doc(workspaceId, document.id)}/evaluate`, { method: "POST", body: { group: detail.ranking.group.id, runs: 1 } }); }
      catch (error) { view.batch.failed += 1; view.batch.error = error.message; if (error.status === 402) { app.scoring.delete(document.id); break; } }
      app.scoring.delete(document.id);
      view.batch.done += 1;
      await load();
      render();
    }
    const { done, failed, error } = view.batch;
    view.batch = null;
    toast(failed ? `${done - failed} scored, ${failed} failed: ${error}` : `Scored ${plural(done, "draft")}`, { error: failed > 0 });
    await refresh();
  }

  // --------------------------------------------------------------- tables

  function scoreButton(document, compact = false) {
    const busy = scoringIds().has(document.id);
    if (busy) return `<span class="badge scoring">Scoring</span>`;
    return detail.ranking ? `<button data-score="${e(document.id)}" title="Score ${e(document.title)} once">${compact ? "Score" : "Score"}</button>` : "";
  }

  function compareButton(document) {
    const on = isComparing(workspaceId, document.id);
    return `<button data-compare="${e(document.id)}" aria-pressed="${on}" title="${on ? "Remove from comparison" : "Add to comparison"}">${on ? "Picked" : "Compare"}</button>`;
  }

  function matrixTable() {
    const { matrix } = detail;
    const rows = matrix.rows;
    const ordered = [...rows].sort((a, b) => (b.isOriginal - a.isOriginal) || ((b.overallScore ?? -1) - (a.overallScore ?? -1)) || b.version - a.version);
    const busy = scoringIds();
    const head = ordered.map((row) => `<th class="col"><div class="col-head"><a href="${docHref(row)}" data-link title="${e(row.title)}">${versionLabel(row)}</a><span class="t" title="${e(row.title)}">${e(row.title)}</span><span class="badges">${row.isOriginal ? `<span class="badge original">Orig</span>` : ""}${row.isBest ? `<span class="badge best">Best</span>` : ""}${busy.has(row.id) ? `<span class="badge scoring" title="Scoring now"></span>` : ""}</span><span class="cell-actions">${busy.has(row.id) ? "" : scoreButton(row, true)}${compareButton(row)}</span></div></th>`).join("");
    const line = (label, values, direction = "higher", className = "") => {
      const finite = values.filter(Number.isFinite);
      const top = finite.length > 1 ? (direction === "lower" ? Math.min(...finite) : Math.max(...finite)) : null;
      return `<tr class="${className}"><td class="metric">${label}</td>${values.map((value) => `<td class="cell ${value != null && value === top ? "top" : ""}"><span>${score(value)}</span></td>`).join("")}</tr>`;
    };
    return `<div class="table-scroll"><table class="matrix"><thead><tr><th class="metric">Question</th>${head}</tr></thead><tbody>
      ${line(`Overall ${dirHtml("higher")}`, ordered.map((row) => row.overallScore), "higher", "overall")}
      ${matrix.questions.map((question) => line(`${e(question.text)} ${dirHtml(question.direction)}`, ordered.map((row) => row.scores[question.key]), question.direction)).join("")}
      <tr class="runs"><td class="metric">Runs</td>${ordered.map((row) => `<td class="cell">${row.runs}${row.staleRuns ? `<span class="faint" title="Runs against an earlier context"> +${row.staleRuns} stale</span>` : ""}</td>`).join("")}</tr>
    </tbody></table></div>`;
  }

  function rankingTable() {
    const items = detail.ranking.items;
    const busy = scoringIds();
    return `<div class="table-scroll"><table class="table"><thead><tr><th class="num">Rank</th><th>Draft</th><th class="num">Score</th><th class="num">Median</th><th class="num">Range</th><th class="num">Runs</th><th class="num">vs original</th><th></th></tr></thead><tbody>
      ${items.map((item) => `<tr class="clickable" data-open="${e(item.id)}"><td class="num faint">${item.rank ?? "—"}</td><td><div class="doc-cell"><div class="title"><span class="version">${versionLabel(item)}</span><a href="${docHref(item)}" data-link>${e(item.title)}</a>${item.isOriginal ? `<span class="badge original">Original</span>` : ""}${item.isBest ? `<span class="badge best">Best</span>` : ""}${busy.has(item.id) ? `<span class="badge scoring">Scoring</span>` : ""}</div>${item.changeSummary ? `<div class="summary">${e(item.changeSummary)}</div>` : ""}</div></td><td class="num strong">${score(item.rankScore)}</td><td class="num">${score(item.median)}</td><td class="num faint">${item.runs > 1 ? `${score(item.min)}–${score(item.max)}` : "—"}</td><td class="num">${item.runs}</td><td class="num">${deltaHtml(item.delta)}</td><td><span class="matrix cell-actions" style="display:flex;gap:2px;justify-content:flex-end">${scoreButton(item)}${compareButton(item)}</span></td></tr>`).join("")}
    </tbody></table></div>`;
  }

  function lineageTree() {
    const rows = new Map((detail.matrix?.rows || detail.documents).map((row) => [row.id, row]));
    const documents = detail.documents.map((document) => rows.get(document.id) || document);
    const children = new Map();
    documents.forEach((document) => {
      const parent = document.parentDocumentId && rows.has(document.parentDocumentId) ? document.parentDocumentId : null;
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(document);
    });
    const node = (document, parent) => {
      const change = parent && document.overallScore != null && parent.overallScore != null ? Math.round((document.overallScore - parent.overallScore) * 10) / 10 : null;
      const kids = (children.get(document.id) || []).sort((a, b) => a.version - b.version);
      return `<li><a class="node" href="${docHref(document)}" data-link><span class="version">${versionLabel(document)}</span><span class="title">${e(document.title)}</span>${document.isOriginal ? `<span class="badge original">Original</span>` : ""}${document.isBest ? `<span class="badge best">Best</span>` : ""}<span class="summary">${e(document.changeSummary || "")}</span>${change != null ? deltaHtml(change) : ""}<span class="score">${score(document.overallScore)}</span></a>${kids.length ? `<ul>${kids.map((kid) => node(kid, document)).join("")}</ul>` : ""}</li>`;
    };
    const roots = (children.get(null) || []).sort((a, b) => a.version - b.version);
    return `<div class="lineage"><p class="faint" style="font-size:12.5px;margin:6px 0 10px">Each draft sits under the draft it was based on. Changes are overall points versus that parent.</p><ul>${roots.map((root) => node(root, null)).join("")}</ul></div>`;
  }

  // --------------------------------------------------------------- render

  function render() {
    const { workspace, groups, documents, ranking, matrix, activity } = detail;
    setTitle(workspace.name);
    const group = groups.find((item) => item.id === ranking?.group.id);
    const best = ranking?.items.find((item) => item.isBest && item.rankScore != null);
    const original = ranking?.items.find((item) => item.isOriginal);
    const scored = matrix?.rows.filter((row) => row.evaluated).length ?? 0;
    const unscored = matrix?.rows.filter((row) => !row.evaluated) ?? [];
    const busy = scoringIds();
    const startFrom = best || [...documents].sort((a, b) => b.version - a.version)[0];
    const questionLabel = ranking?.question ? ranking.question.text : "Overall";
    const latest = [...documents].sort((a, b) => b.version - a.version)[0];
    const latestRow = matrix?.rows.find((row) => row.id === latest?.id);
    const lower = ranking?.question?.direction === "lower";
    const staleNeedsScore = workspace.staleRunCount > 0 && unscored.length > 0;
    const batchLabel = view.batch ? `Scoring ${Math.min(view.batch.done + 1, view.batch.total)} of ${view.batch.total}…` : `Score unscored (${unscored.filter((row) => !busy.has(row.id)).length})`;

    root.innerHTML = `<section class="page">
      <div class="page-head">
        <div>
          <p class="eyebrow"><span>${e(workspace.contextTitle)}</span>${group ? `<span aria-hidden="true">·</span><span>${e(group.name)}</span>` : ""}</p>
          <h1>${e(workspace.name)}</h1>
          <div class="meta"><span>${plural(documents.length, "draft")}</span><span>${plural(workspace.runCount, "run")}</span>${workspace.staleRunCount ? `<span class="badge stale" title="Runs scored against an earlier context">${workspace.staleRunCount} stale</span>` : ""}<span class="faint">Updated ${e(ago(workspace.lastActivityAt))}</span>${activity.length ? `<span class="badge scoring">Scoring #${activity[0].documentVersion}${activity.length > 1 ? ` +${activity.length - 1}` : ""}</span>` : ""}</div>
        </div>
        <div class="actions">
          ${documents.length ? `<a class="btn primary" href="${href(`/edit/${encodeURIComponent(startFrom.id)}`)}" data-link title="Opens the editor starting from ${e(versionTitle(startFrom))}">New draft</a>` : `<a class="btn primary" href="${href("/edit")}" data-link>Write the first draft</a>`}
          <button class="btn" id="upload">Add file</button>
          <details class="menu"><summary class="btn icon" aria-label="More workspace actions">⋯</summary><div class="menu-list">
            <button id="rename">Rename</button>
            <button id="edit-context">Edit context</button>
            <button id="groups">Evaluation groups…</button>
            <hr>
            <a href="${ws(workspaceId)}/report" target="_blank" rel="noopener">Open report<span class="hint">HTML</span></a>
            <button id="report-md">Download report<span class="hint">Markdown</span></button>
            <button id="export-csv">Export scores<span class="hint">CSV</span></button>
            <button id="export-json">Export workspace<span class="hint">JSON</span></button>
            <hr>
            <button class="danger" id="delete">Delete workspace</button>
          </div></details>
        </div>
      </div>

      ${staleNeedsScore ? `<div class="notice"><span><strong>The context changed.</strong> ${plural(workspace.staleRunCount, "earlier run")} scored against the previous version no longer count. Score the drafts again to rank them against the new context.</span><button class="btn small" data-score-unscored>${batchLabel}</button></div>` : ""}
      ${!ranking ? `<div class="notice"><span><strong>No evaluation group yet.</strong> Attach one to start scoring drafts.</span><button class="btn small primary" id="attach">Choose a group</button></div>` : ""}

      ${ranking ? `<div class="stats">
        <div class="stat"><span class="label">Best draft</span><span class="value"><strong>${score(best?.rankScore)}</strong></span><span class="sub">${best ? `<a href="${docHref(best)}" data-link>${e(versionTitle(best))}</a>` : "No scores yet"}</span></div>
        <div class="stat"><span class="label">Change from the original</span><span class="value"><strong class="${best?.delta > 0 ? "delta good" : best?.delta < 0 ? "delta bad" : ""}">${best?.delta != null ? signed(best.delta) : "—"}</strong></span><span class="sub">${original?.rankScore != null ? `Original scored ${score(original.rankScore)}` : "Score the original to set a baseline"}</span></div>
        <div class="stat"><span class="label">Drafts scored</span><span class="value"><strong>${scored}</strong><span class="faint">of ${documents.length}</span></span><span class="sub">${unscored.length ? `${plural(unscored.length, "draft")} waiting` : "All scored"}</span></div>
        <div class="stat"><span class="label">Latest draft</span><span class="value"><strong>${latest ? score(latestRow?.overallScore) : "—"}</strong>${latest && busy.has(latest.id) ? `<span class="badge scoring">Scoring</span>` : latest && !latestRow?.evaluated ? `<span class="faint">not scored</span>` : ""}</span><span class="sub">${latest ? `<a href="${docHref(latest)}" data-link>${e(versionTitle(latest))}</a> · ${e(ago(latest.createdAt))}` : "No drafts yet"}</span></div>
      </div>

      <div class="controls">
        ${groups.length > 1 ? `<select id="group-select" aria-label="Evaluation group">${groups.map((item) => `<option value="${e(item.id)}" ${item.id === ranking.group.id ? "selected" : ""}>${e(item.name)}</option>`).join("")}</select>` : ""}
        <select id="metric-select" aria-label="Metric"><option value="">Overall score</option>${group?.questions.map((question) => `<option value="${e(question.key)}" ${ranking.question?.key === question.key ? "selected" : ""}>${question.direction === "lower" ? "↓" : "↑"} ${e(question.text)}</option>`).join("") || ""}</select>
        <div class="seg" role="group" aria-label="Ranking mode"><button data-mode="max" aria-pressed="${ranking.mode === "max"}">${lower ? "Lowest" : "Best"} run</button><button data-mode="median" aria-pressed="${ranking.mode === "median"}">Median</button></div>
        <span class="spacer"></span>
        ${unscored.length && !staleNeedsScore ? `<button class="btn" data-score-unscored ${view.batch ? "disabled" : ""}>${view.batch ? `<span class="spinner"></span>` : ""}${batchLabel}</button>` : ""}
      </div>

      <article class="card chart-card">
        <div class="card-head"><div><h2>Progress from the original</h2><p>${e(questionLabel)}${lower ? " (lower is better; the chart shows improvement)" : ""}, in points above or below draft #${original?.version ?? 0}. Click a point to open that draft.</p></div><div class="chart-legend"><span><i></i>Each draft</span><span><i class="frontier"></i>Best so far</span><span><i class="range"></i>Run range</span></div></div>
        <div id="chart"></div>
      </article>` : ""}

      <details class="card context-card" ${documents.length ? "" : "open"}><summary><span class="title">${e(workspace.contextTitle)}</span><span class="preview">${e(workspace.contextContent.replace(/[#>*_`|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 180))}</span></summary>
        <div class="context-body"><div class="context-text">${e(workspace.contextContent)}</div><div class="row"><button class="btn small" id="edit-context-2">Edit context</button>${workspace.contextVersions > 1 ? `<span class="faint" style="font-size:12.5px">${plural(workspace.contextVersions, "version")} saved</span>` : ""}</div></div>
      </details>

      <article class="card docs-card" style="margin-top:16px">
        ${documents.length ? `<div class="docs-head"><div class="tabs" role="tablist" aria-label="Draft views">
          ${matrix ? `<button role="tab" data-tab="scores" aria-selected="${view.tab === "scores"}">Scores<span class="count">${documents.length}</span></button><button role="tab" data-tab="ranking" aria-selected="${view.tab === "ranking"}">Ranking</button>` : ""}
          <button role="tab" data-tab="lineage" aria-selected="${view.tab === "lineage" || !matrix}">Lineage</button>
        </div><span class="faint hint" style="font-size:12.5px">Pick two drafts to compare</span></div>
        <div id="docs-body">${!matrix || view.tab === "lineage" ? lineageTree() : view.tab === "ranking" ? rankingTable() : matrixTable()}</div>`
        : `<div class="docs-empty"><h3>No drafts yet</h3><p>Write the first draft here, add a file, or ask your agent to run <code>jev-score score "${e(workspace.name)}" draft.md</code>.</p><div class="row"><a class="btn primary" href="${href("/edit")}" data-link>Write the first draft</a><button class="btn" id="upload-2">Add a file</button></div></div>`}
      </article>
    </section>`;

    if (ranking && !mountProgressChart($("#chart", root), ranking.timeline, { metricLabel: questionLabel, onOpen: (point) => navigate(href(`/d/${encodeURIComponent(point.documentId)}`)) })) {
      $("#chart", root).innerHTML = `<div class="chart-empty"><div><strong>No progress to chart yet.</strong><br>${original?.rankScore == null ? "Score the original draft to set the baseline." : "Score another draft to see how it compares."}</div></div>`;
    }
    wire();
  }

  function wire() {
    const on = (selector, handler) => { const element = $(selector, root); if (element) element.onclick = handler; };
    on("#upload", () => uploadDialog(detail, navigate).then((saved) => saved && refresh()));
    on("#upload-2", () => uploadDialog(detail, navigate).then((saved) => saved && refresh()));
    on("#rename", async () => { const updated = await renameWorkspaceDialog(detail.workspace); if (updated) { await refreshShell(); await refresh(); } });
    on("#edit-context", async () => { if (await editContextDialog(detail)) await refresh(); });
    on("#edit-context-2", async () => { if (await editContextDialog(detail)) await refresh(); });
    on("#groups", async () => { if (await manageGroupsDialog(detail, app)) { ctx.setQuery({ group: null, question: null }); query.delete("group"); query.delete("question"); await refreshShell(); await refresh(); } });
    on("#attach", async () => { if (await manageGroupsDialog(detail, app)) { await refreshShell(); await refresh(); } });
    on("#report-md", () => download(`${ws(workspaceId)}/report?format=md&download`));
    on("#export-csv", () => download(`${ws(workspaceId)}/export?format=csv`));
    on("#export-json", () => download(`${ws(workspaceId)}/export?format=json`));
    on("#delete", async () => {
      const ok = await confirmAction({ title: `Delete ${detail.workspace.name}?`, message: `This permanently deletes ${plural(detail.documents.length, "draft")} and ${plural(detail.workspace.runCount + detail.workspace.staleRunCount, "evaluation run")}. Export it first if you might want it back.`, confirmLabel: "Delete workspace", danger: true });
      if (!ok) return;
      await api(ws(workspaceId), { method: "DELETE" });
      toast(`Deleted ${detail.workspace.name}`);
      await refreshShell();
      navigate("/");
    });
    $$("[data-score-unscored]", root).forEach((button) => button.onclick = scoreUnscored);
    $("#group-select", root)?.addEventListener("change", async (event) => {
      await api(ws(workspaceId), { method: "PATCH", body: { primaryGroup: event.target.value } });
      ctx.setQuery({ group: null, question: null }); query.delete("group"); query.delete("question");
      await refresh();
    });
    $("#metric-select", root)?.addEventListener("change", async (event) => {
      ctx.setQuery({ question: event.target.value || null });
      if (event.target.value) query.set("question", event.target.value); else query.delete("question");
      await refresh();
    });
    $$("[data-mode]", root).forEach((button) => button.onclick = async () => {
      await api(ws(workspaceId), { method: "PATCH", body: { rankingMode: button.dataset.mode } });
      await refresh();
    });
    $$("[data-tab]", root).forEach((button) => button.onclick = () => { view.tab = button.dataset.tab; storage.set("jev-docs-tab", view.tab); ctx.setQuery({ view: view.tab }); render(); });
    $$("[data-score]", root).forEach((button) => button.onclick = (event) => { event.stopPropagation(); scoreDocument(detail.documents.find((item) => item.id === button.dataset.score)); });
    $$("[data-compare]", root).forEach((button) => button.onclick = (event) => { event.stopPropagation(); toggleCompare(workspaceId, button.dataset.compare); render(); });
    $$("tr[data-open]", root).forEach((row) => row.onclick = (event) => { if (!event.target.closest("a, button")) navigate(href(`/d/${encodeURIComponent(row.dataset.open)}`)); });
  }

  async function refresh() {
    await load();
    if (ctx.isCurrent()) render();
  }

  const controller = {
    documents: [],
    refresh,
    onCompareChange: () => render(),
    paletteItems: () => [
      ...detail.documents.map((document) => ({ label: `${versionTitle(document)}`, kind: "Draft", run: () => navigate(docHref(document)) })),
      ...(detail.documents.length ? [{ label: "New draft from the best", kind: "Action", run: () => $("a.btn.primary", root)?.click() }] : []),
      { label: "Edit context", kind: "Action", run: () => editContextDialog(detail).then((saved) => saved && refresh()) },
      { label: "Open report", kind: "Action", run: () => window.open(`${ws(workspaceId)}/report`, "_blank", "noopener") },
    ],
  };
  await load();
  render();
  return controller;
}
