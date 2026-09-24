import { api, doc, ws } from "../lib/api.js";
import { alignDiffChanges, collapseDiffContext, diffLines, inlineDiff } from "../lib/diff.js";
import { score, versionLabel, versionTitle } from "../lib/format.js";
import { markdownToHtml } from "../lib/markdown.js";
import { $, $$, deltaHtml, dirHtml, e, storage, toast } from "../lib/ui.js";
import { changesHtml } from "./document.js";

const CLOSE_GAP = 2.5;

export async function mount(ctx) {
  const { root, params, navigate, setTitle } = ctx;
  const workspaceId = params.workspace;
  let view = storage.get("jev-compare-view", "tracked");
  let mode = null;
  let expanded = false;
  let settling = false;
  let detail, left, right;
  const href = (path = "") => `/w/${encodeURIComponent(workspaceId)}${path}`;

  async function load() {
    const search = mode ? `?mode=${mode}` : "";
    [detail, left, right] = await Promise.all([api(`${ws(workspaceId)}${search}`), api(doc(workspaceId, params.left)), api(doc(workspaceId, params.right))]);
    mode ||= detail.matrix?.mode || "max";
  }

  function lineDiff() {
    const rows = alignDiffChanges(diffLines(left.content, right.content));
    const visible = expanded ? rows : collapseDiffContext(rows);
    const cell = (text, number, type, marked) => `<div class="diff-cell ${type}"><span class="n">${number ?? ""}</span><code>${text == null ? "" : marked ?? (e(text) || " ")}</code></div>`;
    return `<div class="diff"><div class="diff-head"><div><span class="version">${versionLabel(left)}</span><strong>${e(left.title)}</strong></div><div><span class="version">${versionLabel(right)}</span><strong>${e(right.title)}</strong></div></div>${visible.map((row) => {
      if (row.collapsed) return `<div class="diff-fold"><button data-expand>${row.collapsed} unchanged lines</button></div>`;
      const marks = row.leftType === "removed" && row.rightType === "added" ? inlineDiff(row.left, row.right).map((html, index) => html.replaceAll("<mark>", `<mark class="${index ? "ins" : "del"}">`)) : [null, null];
      return `<div class="diff-row">${cell(row.left, row.leftNumber, row.leftType, marks[0])}${cell(row.right, row.rightNumber, row.rightType, marks[1])}</div>`;
    }).join("")}</div>`;
  }

  function documentsHtml() {
    if (view === "side") return `<div class="compare-docs">${[left, right].map((item) => `<article class="sheet alone"><header><span><span class="version">${versionLabel(item)}</span> <a href="${href(`/d/${encodeURIComponent(item.id)}`)}" data-link>${e(item.title)}</a></span><a class="faint" href="${href(`/edit/${encodeURIComponent(item.id)}`)}" data-link>Revise</a></header><div class="manuscript" style="font-size:16.5px">${markdownToHtml(item.content)}</div></article>`).join("")}</div>`;
    if (view === "lines") return lineDiff();
    return `<article class="sheet alone" style="padding:clamp(22px,4vw,52px) clamp(18px,5vw,64px)"><p class="faint" style="font:13px var(--sans);margin-bottom:18px">Changes from ${e(versionTitle(left))} to ${e(versionTitle(right))}. Struck through: removed. Underlined: added.</p><div class="changes">${changesHtml(left.content, right.content, { expanded })}</div></article>`;
  }

  function render() {
    const { matrix, workspace } = detail;
    setTitle(`${versionLabel(left)} vs ${versionLabel(right)}`);
    const rows = new Map((matrix?.rows || []).map((row) => [row.id, row]));
    const a = rows.get(left.id), b = rows.get(right.id);
    const options = (selected) => [...detail.documents].reverse().map((item) => `<option value="${e(item.id)}" ${item.id === selected ? "selected" : ""}>${e(versionTitle(item))}</option>`).join("");
    const change = (va, vb, direction) => va == null || vb == null ? null : Math.round((direction === "lower" ? va - vb : vb - va) * 10) / 10;
    const winner = (va, vb, direction) => va == null || vb == null || va === vb ? [false, false] : direction === "lower" ? [va < vb, vb < va] : [va > vb, vb > va];
    const line = (label, va, vb, direction, overall = false) => {
      const [wa, wb] = winner(va, vb, direction);
      return `<tr class="${overall ? "strong" : ""}"><td>${label}</td><td class="num ${wa ? "win" : ""}"><span>${score(va)}</span></td><td class="num ${wb ? "win" : ""}"><span>${score(vb)}</span></td><td class="num">${deltaHtml(change(va, vb, direction))}</td></tr>`;
    };
    const gap = a?.overallScore != null && b?.overallScore != null ? Math.abs(a.overallScore - b.overallScore) : null;
    root.innerHTML = `<section class="page">
      <a class="back" href="${href()}" data-link>← ${e(workspace.name)}</a>
      <div class="page-head"><div><p class="eyebrow">Compare drafts</p><h1>${e(versionLabel(left))} <span class="faint" style="font-style:italic;font-weight:400">vs</span> ${e(versionLabel(right))}</h1></div>
        <div class="actions"><a class="btn primary" href="${href(`/edit/${encodeURIComponent(right.id)}`)}" data-link>Revise ${e(versionLabel(right))}</a></div></div>
      <div class="compare-pick">
        <label class="field">From<select data-pick="left">${options(left.id)}</select></label>
        <button class="btn icon swap" id="swap" title="Swap" aria-label="Swap drafts">⇄</button>
        <label class="field">To<select data-pick="right">${options(right.id)}</select></label>
      </div>
      ${matrix ? `<article class="card" style="overflow:hidden">
        <div class="row" style="padding:14px 18px;border-bottom:1px solid var(--rule);justify-content:space-between"><strong>${e(matrix.group.name)}</strong><div class="seg" role="group" aria-label="Scores use"><button data-mode="max" aria-pressed="${mode === "max"}">Best run</button><button data-mode="median" aria-pressed="${mode === "median"}">Median</button></div></div>
        <div class="table-scroll"><table class="table compare-scores"><thead><tr><th>Question</th><th class="num">${e(versionLabel(left))}</th><th class="num">${e(versionLabel(right))}</th><th class="num">Change</th></tr></thead><tbody>
          ${line("Overall", a?.overallScore, b?.overallScore, "higher", true)}
          ${matrix.questions.map((question) => line(`${e(question.text)} ${dirHtml(question.direction)}`, a?.scores[question.key], b?.scores[question.key], question.direction)).join("")}
          <tr><td class="faint">Runs</td><td class="num faint">${a?.runs ?? 0}</td><td class="num faint">${b?.runs ?? 0}</td><td></td></tr>
        </tbody></table></div>
      </article>` : ""}
      ${gap != null && gap < CLOSE_GAP ? `<div class="settle"><p><strong>Too close to call.</strong> These drafts are ${gap.toFixed(1)} points apart, within Jev's run-to-run variation. Score each three more times and compare medians to separate them.</p><button class="btn primary" id="settle" ${settling ? "disabled" : ""}>${settling ? `<span class="spinner"></span>Scoring 6 runs…` : "Score each 3 more times"}</button></div>` : ""}
      <div class="row" style="margin:22px 0 12px;justify-content:space-between"><h2 style="font-size:22px">The text</h2><div class="seg" role="group" aria-label="Show"><button data-view="tracked" aria-pressed="${view === "tracked"}">Tracked changes</button><button data-view="side" aria-pressed="${view === "side"}">Side by side</button><button data-view="lines" aria-pressed="${view === "lines"}">Line diff</button></div></div>
      ${documentsHtml()}
    </section>`;
    wire();
  }

  function wire() {
    $$("[data-pick]", root).forEach((select) => select.onchange = () => {
      const next = { left: left.id, right: right.id, [select.dataset.pick]: select.value };
      if (next.left === next.right) { toast("Pick two different drafts."); select.value = select.dataset.pick === "left" ? left.id : right.id; return; }
      navigate(href(`/compare/${encodeURIComponent(next.left)}/${encodeURIComponent(next.right)}`), { replace: true });
    });
    $("#swap", root).onclick = () => navigate(href(`/compare/${encodeURIComponent(right.id)}/${encodeURIComponent(left.id)}`), { replace: true });
    $$("[data-view]", root).forEach((button) => button.onclick = () => { view = button.dataset.view; storage.set("jev-compare-view", view); expanded = false; render(); });
    $$("[data-mode]", root).forEach((button) => button.onclick = async () => { mode = button.dataset.mode; await refresh(); });
    $$("[data-expand], [data-unfold]", root).forEach((button) => button.onclick = () => { expanded = true; render(); });
    const settle = $("#settle", root);
    if (settle) settle.onclick = async () => {
      settling = true; render();
      try {
        await Promise.all([left, right].map((item) => api(`${doc(workspaceId, item.id)}/evaluate`, { method: "POST", body: { group: detail.matrix.group.id, runs: 3 } })));
        mode = "median";
        toast("Scored 6 more runs. Showing medians.");
      } catch (error) { toast(error.message, { error: true }); }
      finally { settling = false; await refresh(); }
    };
  }

  async function refresh() {
    await load();
    if (ctx.isCurrent()) render();
  }

  await load();
  render();
  return { documents: detail.documents, refresh };
}
