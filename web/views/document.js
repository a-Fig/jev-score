import { isComparing, toggleCompare } from "../app.js";
import { api, doc, ws } from "../lib/api.js";
import { alignDiffChanges, diffLines, trackedChanges } from "../lib/diff.js";
import { ago, date, plural, score, versionLabel, versionTitle, wordCount } from "../lib/format.js";
import { marginHtml } from "../lib/margin.js";
import { markdownToHtml } from "../lib/markdown.js";
import { $, $$, confirmAction, copyText, dirHtml, download, e, promptText, storage, toast } from "../lib/ui.js";

// Tracked changes in one column: unchanged lines as-is, rewritten lines with
// word-level marks, and long unchanged stretches folded.
export function changesHtml(before, after, { expanded = false } = {}) {
  const rows = alignDiffChanges(diffLines(before, after));
  if (!rows.some((row) => row.leftType !== "same")) return `<p class="none">No changes from the parent draft.</p>`;
  const lines = rows.map((row) => {
    if (row.leftType === "same") return { type: "same", html: e(row.left) };
    if (row.leftType === "removed" && row.rightType === "added") return { type: "changed", html: trackedChanges(row.left, row.right) };
    if (row.leftType === "removed") return { type: "removed", html: `<del>${e(row.left)}</del>` };
    return { type: "added", html: `<ins>${e(row.right)}</ins>` };
  });
  const output = [];
  for (let index = 0; index < lines.length;) {
    if (lines[index].type !== "same") { output.push(`<div class="line ${lines[index].type}">${lines[index].html || " "}</div>`); index += 1; continue; }
    let end = index;
    while (end < lines.length && lines[end].type === "same") end += 1;
    const run = lines.slice(index, end);
    const keep = 2;
    if (!expanded && run.length > keep * 2 + 2) {
      output.push(...run.slice(0, index === 0 ? 0 : keep).map((line) => `<div class="line">${line.html || " "}</div>`));
      output.push(`<button class="fold" data-unfold>${plural(run.length - (index === 0 ? 0 : keep) - (end === lines.length ? 0 : keep), "unchanged line")}</button>`);
      if (end !== lines.length) output.push(...run.slice(-keep).map((line) => `<div class="line">${line.html || " "}</div>`));
    } else output.push(...run.map((line) => `<div class="line">${line.html || " "}</div>`));
    index = end;
  }
  return output.join("");
}

export async function mount(ctx) {
  const { root, params, app, navigate, setTitle, refreshShell } = ctx;
  const workspaceId = params.workspace;
  let mode = storage.get("jev-doc-mode", "rendered");
  let expanded = false;
  let detail, document, parent = null;

  async function load() {
    [detail, document] = await Promise.all([api(ws(workspaceId)), api(doc(workspaceId, params.document))]);
    parent = document.parentDocumentId ? await api(doc(workspaceId, document.parentDocumentId)).catch(() => null) : null;
    controller.documents = detail.documents;
  }

  const href = (path = "") => `/w/${encodeURIComponent(workspaceId)}${path}`;
  const busy = () => detail.activity.some((item) => item.documentId === document.id) || app.scoring.has(document.id);

  async function scoreIt(runs = 1) {
    if (!detail.matrix) { toast("Attach an evaluation group to this workspace first.", { error: true }); return; }
    app.scoring.add(document.id);
    render();
    try {
      const result = await api(`${doc(workspaceId, document.id)}/evaluate`, { method: "POST", body: { group: detail.matrix.group.id, runs } });
      toast(`Scored ${score(result.overallScore)}${result.range ? ` (${score(result.range.min)}–${score(result.range.max)} over ${result.runs} runs)` : ""}${result.isBest ? " · the new best" : ""}`);
    } catch (error) { toast(error.message, { error: true }); }
    finally { app.scoring.delete(document.id); await refresh(); }
  }

  function body() {
    if (mode === "source") return `<pre class="source">${e(document.content)}</pre>`;
    if (mode === "changes") return parent ? `<div class="changes">${changesHtml(parent.content, document.content, { expanded })}</div>` : `<p class="faint">This draft has no parent to compare against.</p>`;
    return `<div class="manuscript">${markdownToHtml(document.content)}</div>`;
  }

  function render() {
    const { workspace, matrix } = detail;
    setTitle(`${versionLabel(document)} ${document.title}`);
    const rows = new Map((matrix?.rows || []).map((row) => [row.id, row]));
    const row = rows.get(document.id);
    const parentRow = parent ? rows.get(parent.id) : null;
    const best = matrix?.rows.find((item) => item.isBest && item.id !== document.id);
    const original = matrix?.rows.find((item) => item.isOriginal && item.id !== document.id);
    const baseline = parentRow || original || null;
    const scoring = busy();
    const comparing = isComparing(workspaceId, document.id);
    const currentRuns = document.runs.filter((run) => !run.stale);
    root.innerHTML = `<section class="page">
      <a class="back" href="${href()}" data-link>← ${e(workspace.name)}</a>
      <div class="page-head">
        <div>
          <p class="eyebrow"><span class="version" style="font-size:12px">${versionLabel(document)}</span><span>${document.isOriginal ? "Original" : "Revision"}</span>${parent ? `<span aria-hidden="true">·</span><span>based on <a href="${href(`/d/${encodeURIComponent(parent.id)}`)}" data-link>${e(versionTitle(parent))}</a></span>` : ""}${row?.isBest ? `<span class="badge best">Best</span>` : ""}${scoring ? `<span class="badge scoring">Scoring</span>` : ""}</p>
          <h1><button class="title-edit" id="rename" title="Rename">${e(document.title)}</button></h1>
          <div class="meta"><button class="link" id="edit-summary" style="color:var(--graphite)">${document.changeSummary ? e(document.changeSummary) : "Add a note about what changed"}</button><span class="faint">${e(date(document.createdAt))} · ${plural(wordCount(document.content), "word")} · ${plural(currentRuns.length, "run")}</span></div>
        </div>
        <div class="actions">
          <a class="btn primary" href="${href(`/edit/${encodeURIComponent(document.id)}`)}" data-link>Revise this draft</a>
          <button class="btn" id="score" ${scoring || !matrix ? "disabled" : ""}>${scoring ? `<span class="spinner"></span>Scoring…` : row?.evaluated ? "Score again" : "Score"}</button>
          <details class="menu"><summary class="btn icon" aria-label="More draft actions">⋯</summary><div class="menu-list">
            ${parent ? `<a href="${href(`/compare/${encodeURIComponent(parent.id)}/${encodeURIComponent(document.id)}`)}" data-link>Compare with parent</a>` : ""}
            ${best ? `<a href="${href(`/compare/${encodeURIComponent(best.id)}/${encodeURIComponent(document.id)}`)}" data-link>Compare with the best</a>` : ""}
            <button id="compare-toggle">${comparing ? "Remove from comparison" : "Add to comparison"}</button>
            <button id="score-3" ${scoring || !matrix ? "disabled" : ""}>Score 3 times<span class="hint">tie-breaks</span></button>
            <hr>
            <button id="copy">Copy text</button>
            <button id="download">Download .md</button>
            ${document.isOriginal ? "" : `<button id="make-original">Make this the original</button>`}
            <hr>
            <button class="danger" id="delete">Delete draft</button>
          </div></details>
        </div>
      </div>
      <div class="doc-layout">
        <div>
          <div class="row" style="margin-bottom:10px"><div class="seg" role="group" aria-label="Show"><button data-mode="rendered" aria-pressed="${mode === "rendered"}">Read</button><button data-mode="source" aria-pressed="${mode === "source"}">Source</button>${parent ? `<button data-mode="changes" aria-pressed="${mode === "changes"}">Changes</button>` : ""}</div>${mode === "changes" && parent ? `<span class="faint" style="font-size:12.5px">Struck through: removed from ${e(versionLabel(parent))}. Underlined: added.</span>` : ""}</div>
          <article class="sheet alone" style="padding:clamp(24px,5vw,60px) clamp(20px,5vw,68px)">${body()}</article>
        </div>
        ${marginHtml({
          title: "Margin notes", subtitle: matrix ? `${matrix.group.name} · ${matrix.mode === "max" ? "best run" : "median"}` : "",
          questions: matrix?.questions || [], current: row?.evaluated ? row : null,
          baseline: row?.evaluated ? baseline : null, baselineLabel: baseline ? (parentRow ? `parent ${versionLabel(baseline)}` : `original ${versionLabel(baseline)}`) : "",
          best: row?.evaluated ? best : null,
          empty: matrix ? `${row?.staleRuns ? "Its runs were scored against an earlier context. " : ""}Score this draft to see how it reads against each question.` : "",
        })}
      </div>
      <section class="history">
        <h2>Evaluation history</h2>
        <div class="card">${document.runs.length ? document.runs.map((run) => `<div class="run ${run.stale ? "stale" : ""}"><div><strong>${e(run.groupName)}</strong> <span class="when">· ${e(ago(run.createdAt))} · ${e(run.model || run.status)}</span>${run.stale ? ` <span class="badge stale" title="Scored against an earlier context">Stale</span>` : ""}${run.note ? `<div class="faint" style="font-size:12.5px">${e(run.note)}</div>` : ""}</div><span class="overall">${score(run.overallScore)}</span>${run.error || run.aggregationError ? `<p class="error">${e(run.error || run.aggregationError)}</p>` : ""}${run.scores.length ? `<details><summary>${plural(run.scores.length, "question")}</summary><div class="scores">${run.scores.map((item) => `<div><span>${e(item.text)} ${dirHtml(item.direction)}</span><strong class="num">${score(item.score)}</strong></div>`).join("")}</div></details>` : ""}</div>`).join("") : `<p class="muted" style="padding:18px">No runs yet.</p>`}</div>
      </section>
    </section>`;
    wire();
  }

  function wire() {
    const on = (selector, handler) => { const element = $(selector, root); if (element) element.onclick = handler; };
    on("#score", () => scoreIt(1));
    on("#score-3", () => scoreIt(3));
    on("#compare-toggle", () => { const added = toggleCompare(workspaceId, document.id); toast(added ? "Added to comparison. Pick one more draft." : "Removed from comparison"); render(); });
    on("#copy", async () => toast(await copyText(document.content) ? "Copied the draft" : "Could not copy", { error: false }));
    on("#download", () => download(`${doc(workspaceId, document.id)}?download`));
    on("#rename", async () => {
      const title = await promptText({ title: "Rename draft", label: "Title", value: document.title });
      if (title) { await api(doc(workspaceId, document.id), { method: "PATCH", body: { title } }); await refresh(); }
    });
    on("#edit-summary", async () => {
      const changeSummary = await promptText({ title: "What changed?", label: "Summary", value: document.changeSummary, hint: "One line on how this draft differs from its parent." });
      if (changeSummary != null) { await api(doc(workspaceId, document.id), { method: "PATCH", body: { changeSummary } }); await refresh(); }
    });
    on("#make-original", async () => {
      const ok = await confirmAction({ title: "Make this the original?", message: `Every “vs original” comparison will use ${e(versionTitle(document))} as the baseline.`, confirmLabel: "Make original" });
      if (ok) { await api(doc(workspaceId, document.id), { method: "PATCH", body: { original: true } }); toast("Baseline updated"); await refresh(); }
    });
    on("#delete", async () => {
      const ok = await confirmAction({ title: `Delete ${versionTitle(document)}?`, message: `This deletes the draft and its ${plural(document.runs.length, "run")}. Other drafts keep their numbers.`, confirmLabel: "Delete draft", danger: true });
      if (!ok) return;
      await api(doc(workspaceId, document.id), { method: "DELETE" });
      toast(`Deleted ${versionTitle(document)}`);
      await refreshShell();
      navigate(href());
    });
    $$("[data-mode]", root).forEach((button) => button.onclick = () => { mode = button.dataset.mode; storage.set("jev-doc-mode", mode); render(); });
    $$("[data-unfold]", root).forEach((button) => button.onclick = () => { expanded = true; render(); });
  }

  async function refresh() {
    try { await load(); } catch (error) { if (error.status === 404) { navigate(href(), { replace: true }); return; } throw error; }
    if (ctx.isCurrent()) render();
  }

  const controller = {
    documents: [],
    refresh,
    onCompareChange: () => render(),
    paletteItems: () => detail.documents.map((item) => ({ label: versionTitle(item), kind: "Draft", run: () => navigate(href(`/d/${encodeURIComponent(item.id)}`)) })),
  };
  await load();
  render();
  return controller;
}
