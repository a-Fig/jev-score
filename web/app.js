const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const main = $("#main");
const state = { dashboard: null, workspace: null, group: null, question: "", mode: null, tableView: "metrics", compare: [], comparisonView: "rendered", diffExpanded: false };

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
function versionLabel(document) { return `#${document.version}`; }
function versionTitle(document) { return `${versionLabel(document)} · ${document.title}`; }

function safeMarkdownUrl(value, image = false) {
  const decoded = value.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
  try {
    const url = new URL(decoded, window.location.origin);
    if (["http:", "https:"].includes(url.protocol) || (!image && url.protocol === "mailto:")) return value;
  } catch {}
  return null;
}

function markdownInline(value) {
  const tokens = [];
  const stash = (html) => { const token = `\u0000${tokens.length}\u0000`; tokens.push(html); return token; };
  let output = String(value).replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  output = escapeHtml(output);
  output = output.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, alt, url) => {
    const safe = safeMarkdownUrl(url, true);
    return safe ? stash(`<img src="${safe}" alt="${alt}" loading="lazy">`) : alt;
  });
  output = output.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, url) => {
    const safe = safeMarkdownUrl(url);
    return safe ? stash(`<a href="${safe}" target="_blank" rel="noreferrer">${label}</a>`) : label;
  });
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
  return output.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
}

function markdownToHtml(markdown) {
  const lines = String(markdown).replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = [];
  let list = null;
  let inCode = false;
  let codeLanguage = "";
  let codeLines = [];
  const flushParagraph = () => { if (paragraph.length) output.push(`<p>${markdownInline(paragraph.join(" "))}</p>`); paragraph = []; };
  const flushList = () => { if (list) output.push(`<${list.type}>${list.items.map((item) => `<li>${markdownInline(item)}</li>`).join("")}</${list.type}>`); list = null; };
  for (const line of lines) {
    const fence = line.match(/^\s*```\s*([^\s`]*)/);
    if (fence) {
      flushParagraph(); flushList();
      if (inCode) { output.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`); codeLines = []; codeLanguage = ""; inCode = false; }
      else { inCode = true; codeLanguage = fence[1] || ""; }
      continue;
    }
    if (inCode) { codeLines.push(line); continue; }
    if (!line.trim()) { flushParagraph(); flushList(); continue; }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
    const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
    const quote = line.match(/^>\s?(.*)$/);
    if (heading) { flushParagraph(); flushList(); const level = heading[1].length; output.push(`<h${level}>${markdownInline(heading[2])}</h${level}>`); }
    else if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { flushParagraph(); flushList(); output.push("<hr>"); }
    else if (unordered || ordered) {
      flushParagraph();
      const type = unordered ? "ul" : "ol";
      if (list && list.type !== type) flushList();
      if (!list) list = { type, items: [] };
      list.items.push((unordered || ordered)[1]);
    } else if (quote) { flushParagraph(); flushList(); output.push(`<blockquote>${markdownInline(quote[1])}</blockquote>`); }
    else { flushList(); paragraph.push(line.trim()); }
  }
  if (inCode) output.push(`<pre><code${codeLanguage ? ` class="language-${escapeHtml(codeLanguage)}"` : ""}>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  flushParagraph(); flushList();
  return output.join("\n");
}

function diffLines(leftText, rightText) {
  const left = String(leftText).replace(/\r\n?/g, "\n").split("\n");
  const right = String(rightText).replace(/\r\n?/g, "\n").split("\n");
  if (left.length * right.length > 2_000_000) {
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => ({
      left: left[index] ?? null, right: right[index] ?? null,
      leftNumber: index < left.length ? index + 1 : null, rightNumber: index < right.length ? index + 1 : null,
      leftType: index >= left.length ? "empty" : left[index] === right[index] ? "same" : "removed",
      rightType: index >= right.length ? "empty" : left[index] === right[index] ? "same" : "added",
    }));
  }
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { rows.push({ left: left[i], right: right[j], leftNumber: i + 1, rightNumber: j + 1, leftType: "same", rightType: "same" }); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { rows.push({ left: left[i], right: null, leftNumber: i + 1, rightNumber: null, leftType: "removed", rightType: "empty" }); i += 1; }
    else { rows.push({ left: null, right: right[j], leftNumber: null, rightNumber: j + 1, leftType: "empty", rightType: "added" }); j += 1; }
  }
  while (i < left.length) { rows.push({ left: left[i], right: null, leftNumber: i + 1, rightNumber: null, leftType: "removed", rightType: "empty" }); i += 1; }
  while (j < right.length) { rows.push({ left: null, right: right[j], leftNumber: null, rightNumber: j + 1, leftType: "empty", rightType: "added" }); j += 1; }
  return rows;
}

function alignDiffChanges(rows) {
  const aligned = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].leftType === "same") { aligned.push(rows[index]); index += 1; continue; }
    const removed = [], added = [];
    while (index < rows.length && rows[index].leftType !== "same") {
      if (rows[index].leftType === "removed") removed.push(rows[index]);
      if (rows[index].rightType === "added") added.push(rows[index]);
      index += 1;
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) {
      aligned.push({
        left: removed[offset]?.left ?? null, right: added[offset]?.right ?? null,
        leftNumber: removed[offset]?.leftNumber ?? null, rightNumber: added[offset]?.rightNumber ?? null,
        leftType: removed[offset] ? "removed" : "empty", rightType: added[offset] ? "added" : "empty",
      });
    }
  }
  return aligned;
}

function collapseDiffContext(rows, context = 3) {
  const compact = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].leftType !== "same") { compact.push(rows[index]); index += 1; continue; }
    let end = index;
    while (end < rows.length && rows[end].leftType === "same") end += 1;
    const run = rows.slice(index, end);
    if (run.length > context * 2 + 3) compact.push(...run.slice(0, context), { collapsed: run.length - context * 2 }, ...run.slice(-context));
    else compact.push(...run);
    index = end;
  }
  return compact;
}

function renderDiffCell(content, number, type) {
  const marker = type === "removed" ? "−" : type === "added" ? "+" : "";
  return `<div class="diff-cell ${type}"><span class="diff-number">${number ?? ""}</span><span class="diff-marker">${marker}</span><code>${content == null ? "" : escapeHtml(content) || " "}</code></div>`;
}

function comparisonDocuments(left, right, workspaceId, mode) {
  const header = (document) => `<header><strong>${escapeHtml(versionTitle(document))}</strong><a href="/api/workspaces/${workspaceId}/documents/${document.id}?download">Download</a></header>`;
  if (mode === "diff") {
    const rows = alignDiffChanges(diffLines(left.content, right.content));
    const visibleRows = state.diffExpanded ? rows : collapseDiffContext(rows);
    const removals = rows.filter((row) => row.leftType === "removed").length;
    const additions = rows.filter((row) => row.rightType === "added").length;
    const diffHeader = (document, role, count, kind) => `<header><div><span class="diff-role">${role}</span><strong>${escapeHtml(versionTitle(document))}</strong></div><div class="diff-header-actions"><span class="diff-count ${kind}">${kind === "removed" ? "−" : "+"}${count}</span><a href="/api/workspaces/${workspaceId}/documents/${document.id}?download">Download</a></div></header>`;
    return `<div class="diff-view"><div class="diff-headings"><div>${diffHeader(left, "Original", removals, "removed")}</div><div>${diffHeader(right, "Changed", additions, "added")}</div></div><div class="diff-rows">${visibleRows.map((row) => row.collapsed ? `<div class="diff-collapse"><button data-expand-diff>⋯ ${row.collapsed} unchanged lines</button></div>` : `<div class="diff-row">${renderDiffCell(row.left, row.leftNumber, row.leftType)}${renderDiffCell(row.right, row.rightNumber, row.rightType)}</div>`).join("")}</div></div>`;
  }
  return `<div class="compare-documents"><article>${header(left)}<div class="markdown-body">${markdownToHtml(left.content)}</div></article><article>${header(right)}<div class="markdown-body">${markdownToHtml(right.content)}</div></article></div>`;
}

async function loadDashboard() {
  state.dashboard = await api("/api/dashboard");
  $("#workspace-list").innerHTML = state.dashboard.workspaces.map((workspace) => `<button class="workspace-link ${state.workspace?.workspace.id === workspace.id ? "active" : ""}" data-id="${workspace.id}">${escapeHtml(workspace.name)}</button>`).join("");
  $$(".workspace-link").forEach((button) => button.onclick = () => { state.group = null; state.question = ""; state.mode = null; openWorkspace(button.dataset.id); });
  const groupOptions = state.dashboard.groups.map((group) => `<option value="${group.id}">${escapeHtml(group.name)}</option>`).join("");
  $("#workspace-form select[name=primaryGroup]").innerHTML = `<option value="">Choose later</option>${groupOptions}`;
}

async function openWorkspace(id, overrides = {}) {
  if (state.workspace?.workspace.id !== id) state.compare = [];
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
  state.compare = []; renderCompareTray();
  main.innerHTML = `<section class="empty"><p class="eyebrow">Local evaluation workspace</p><h1>Make every revision measurable.</h1><p>Keep context, drafts, Jev evaluations, and progress together. Your documents stay in a local SQLite database.</p><button class="primary" id="empty-new">Create your first workspace</button><div class="empty-card"><strong>Built for you and your coding agent</strong><span class="subtle">Everything in this interface is also available through the CLI.</span><p><code>jev-score ui</code> · <code>jev-score --help</code></p></div></section>`;
  $("#empty-new").onclick = () => $("#workspace-dialog").showModal();
}

function chartSvg(points) {
  if (!points.length || points.every((point) => point.delta == null)) return `<div class="chart-empty">Run a few evaluations to see progress.</div>`;
  const usable = points.filter((point) => point.delta != null);
  const width = 700, height = 210, side = 28, top = 16, bottom = 34;
  let min = Math.min(0, ...usable.flatMap((point) => [point.delta, point.frontier, point.minDelta ?? point.delta]));
  let max = Math.max(0, ...usable.flatMap((point) => [point.delta, point.frontier, point.maxDelta ?? point.delta]));
  if (min === max) { min -= 1; max += 1; }
  const versions = usable.map((point) => point.documentVersion);
  const firstVersion = Math.min(...versions), lastVersion = Math.max(...versions);
  const x = (version) => side + (firstVersion === lastVersion ? (width - side * 2) / 2 : ((version - firstVersion) / (lastVersion - firstVersion)) * (width - side * 2));
  const y = (value) => height - bottom - ((value - min) / (max - min)) * (height - top - bottom);
  const line = (key) => usable.map((point, index) => `${index ? "L" : "M"}${x(point.documentVersion)},${y(point[key])}`).join(" ");
  const signed = (value) => `${value > 0 ? "+" : ""}${score(value)}`;
  const ranges = usable.filter((point) => point.runs > 1).map((point) => {
    const center = x(point.documentVersion), low = y(point.minDelta ?? point.delta), high = y(point.maxDelta ?? point.delta);
    return `<g class="score-range"><title>#${point.documentVersion} · ${escapeHtml(point.documentTitle)}: ${signed(point.minDelta ?? point.delta)} to ${signed(point.maxDelta ?? point.delta)} across ${point.runs} runs</title><line x1="${center}" x2="${center}" y1="${high}" y2="${low}"/><line x1="${center - 5}" x2="${center + 5}" y1="${high}" y2="${high}"/><line x1="${center - 5}" x2="${center + 5}" y1="${low}" y2="${low}"/></g>`;
  }).join("");
  const labels = usable.map((point) => `<text class="x-label" x="${x(point.documentVersion)}" y="${height - 8}">#${point.documentVersion}</text>`).join("");
  const dots = usable.map((point) => `<circle class="dot" cx="${x(point.documentVersion)}" cy="${y(point.delta)}" r="4"><title>#${point.documentVersion} · ${escapeHtml(point.documentTitle)}: ${signed(point.delta)}</title></circle>`).join("");
  return `<svg id="chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="Score change by document version"><line class="axis" x1="${side}" x2="${width-side}" y1="${y(0)}" y2="${y(0)}"/>${ranges}<path class="frontier-line" d="${line("frontier")}"/><path class="chart-line" d="${line("delta")}"/>${dots}${labels}</svg>`;
}

function documentName(document) {
  return `<div class="doc-title"><span class="version-tag">${versionLabel(document)}</span>${escapeHtml(document.title)} ${document.isOriginal ? `<span class="badge original">Original</span>` : ""} ${document.isBest ? `<span class="badge best">Best</span>` : ""}</div><div class="doc-summary">${escapeHtml(document.changeSummary || date(document.createdAt))}</div>`;
}

function compareButton(document, className = "") {
  const selected = state.compare.includes(document.id);
  return `<button data-compare="${document.id}" class="${className} ${selected ? "selected" : ""}">${selected ? "Selected" : "Compare"}</button>`;
}

function documentActions(workspace, document, canEvaluate, includeCompare = true) {
  return `<div class="row-actions"><button data-view="${document.id}">View</button>${includeCompare ? compareButton(document) : ""}<a href="/api/workspaces/${workspace.id}/documents/${document.id}?download">Download</a>${canEvaluate ? `<button data-evaluate="${document.id}">Evaluate</button>` : ""}</div>`;
}

function toggleCompare(documentId) {
  if (state.compare.includes(documentId)) state.compare = state.compare.filter((id) => id !== documentId);
  else if (state.compare.length < 2) state.compare.push(documentId);
  else { toast("Comparison already has two documents"); return; }
  state.diffExpanded = false;
  if (state.workspace) renderWorkspace();
  else renderCompareTray();
}

function renderCompareTray() {
  const tray = $("#compare-tray");
  const documents = state.workspace?.documents || [];
  state.compare = state.compare.filter((id) => documents.some((document) => document.id === id));
  if (!state.compare.length) { tray.innerHTML = ""; tray.className = ""; return; }
  const selected = state.compare.map((id) => documents.find((document) => document.id === id)).filter(Boolean);
  tray.className = "show";
  tray.innerHTML = `<div class="compare-selection"><span class="compare-label">Compare</span>${selected.map((document) => `<span class="compare-chip">${escapeHtml(versionTitle(document))}<button data-remove-compare="${document.id}" aria-label="Remove ${escapeHtml(versionTitle(document))}">×</button></span>`).join("")}${selected.length === 1 ? `<span class="compare-hint">Choose one more</span>` : ""}</div><div class="compare-tray-actions"><button class="ghost" id="clear-compare">Clear</button><button class="primary" id="open-compare" ${selected.length < 2 ? "disabled" : ""}>Compare ${selected.length}/2</button></div>`;
  $$('[data-remove-compare]', tray).forEach((button) => button.onclick = () => toggleCompare(button.dataset.removeCompare));
  $("#clear-compare", tray).onclick = () => { state.compare = []; renderWorkspace(); };
  $("#open-compare", tray).onclick = openComparison;
}

function rankingTable(workspace, documents, canEvaluate) {
  if (!documents.length) return `<div class="chart-empty">Add the original document to begin.</div>`;
  return `<div class="table-scroll"><table><thead><tr><th>Document</th><th>Rank score</th><th>Median</th><th>Range</th><th>Runs</th><th>Change</th><th></th></tr></thead><tbody>${documents.map((document) => `<tr><td>${documentName(document)}</td><td class="score">${score(document.rankScore)}</td><td>${score(document.median)}</td><td>${document.runs < 2 ? "—" : `${score(document.min)}–${score(document.max)} <span class="subtle">(${score(document.spread)})</span>`}</td><td>${document.runs}</td><td class="${document.delta > 0 ? "delta" : ""}">${document.delta == null ? "—" : `${document.delta > 0 ? "+" : ""}${score(document.delta)}`}</td><td>${documentActions(workspace, document, canEvaluate)}</td></tr>`).join("")}</tbody></table></div>`;
}

function metricsTable(workspace, matrix, canEvaluate) {
  if (!matrix?.rows.length) return `<div class="chart-empty">Add the original document to begin.</div>`;
  const orderedRows = matrix.rows.map((document, index) => ({ document, index })).sort((left, right) => {
    const priority = (item) => item.document.isOriginal ? 0 : item.document.isBest ? 1 : 2;
    return priority(left) - priority(right) || left.index - right.index;
  }).map(({ document }) => document);
  const documentHeader = (document) => `<th class="matrix-document" aria-label="${escapeHtml(versionTitle(document))}"><div class="matrix-document-title" data-document-title="${escapeHtml(document.title)}" tabindex="0">${versionLabel(document)}</div><div class="matrix-badges">${document.isOriginal ? `<span class="badge original">Original</span>` : ""}${document.isBest ? `<span class="badge best">Best</span>` : ""}</div><div class="matrix-actions"><button data-view="${document.id}" title="View ${escapeHtml(document.title)}">View</button>${compareButton(document)}${canEvaluate ? `<button data-evaluate="${document.id}" title="Evaluate ${escapeHtml(document.title)}">Run</button>` : ""}</div></th>`;
  const metricLabel = (label) => `<span class="metric-label">${escapeHtml(label)}</span>`;
  const scoreCells = (values) => {
    const finite = values.filter(Number.isFinite);
    const best = finite.length ? Math.max(...finite) : null;
    return values.map((value) => `<td class="matrix-score ${value != null && value === best ? "row-best" : ""}">${score(value)}</td>`).join("");
  };
  return `<div class="table-scroll"><table class="matrix-table transposed" style="--matrix-min-width:${360 + orderedRows.length * 124}px"><colgroup><col class="metric-width">${orderedRows.map(() => `<col class="document-width">`).join("")}</colgroup><thead><tr><th class="metric-column">Metric</th>${orderedRows.map(documentHeader).join("")}</tr></thead><tbody><tr class="overall-row"><td class="metric-column">${metricLabel("Overall")}</td>${scoreCells(orderedRows.map((document) => document.overallScore))}</tr>${matrix.questions.map((question) => `<tr><td class="metric-column">${metricLabel(question.text)}</td>${scoreCells(orderedRows.map((document) => document.scores[question.key]))}</tr>`).join("")}<tr class="runs-row"><td class="metric-column">${metricLabel("Runs")}</td>${orderedRows.map((document) => `<td class="matrix-score">${document.runs}</td>`).join("")}</tr></tbody></table></div>`;
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
      <article class="chart-card"><div class="card-head"><div><h2>Progress from original</h2><p>Document score (solid) · best so far (dotted) · run range (I)</p></div><span class="metric-note">${escapeHtml(result.question?.text || "Overall")} · percentage points</span></div>${chartSvg(result.timeline)}</article>
      <article class="chart-card"><div class="card-head"><div><h2>Current leader</h2><p>${result.mode === "max" ? "Highest score ever" : "Median across runs"}</p></div>${best ? `<span class="badge best">Best</span>` : ""}</div>${best ? `<h3 style="font-size:22px;margin:24px 0 4px"><span class="version-tag">${versionLabel(best)}</span>${escapeHtml(best.title)}</h3><div class="stats"><div class="stat"><strong>${score(best.rankScore)}</strong><span>rank score</span></div><div class="stat"><strong>${best.runs}</strong><span>runs</span></div><div class="stat"><strong>${best.runs > 1 ? score(best.spread) : "—"}</strong><span>spread</span></div></div>` : `<div class="chart-empty">No scores yet.</div>`}</article>
    </div>` : ""}
    <article class="table-card" style="margin-top:16px"><div class="table-title"><div><h2>Documents</h2>${active ? `<span class="subtle">${escapeHtml(active.name)} · ${result.mode === "max" ? "highest" : "median"}</span>` : ""}</div>${matrix ? `<div class="segmented table-toggle"><button data-table-view="metrics" class="${state.tableView === "metrics" ? "active" : ""}">All metrics</button><button data-table-view="ranking" class="${state.tableView === "ranking" ? "active" : ""}">Ranking</button></div>` : ""}</div>
      ${state.tableView === "metrics" && matrix ? metricsTable(workspace, matrix, Boolean(active)) : rankingTable(workspace, ranked, Boolean(active))}</article>
  </section>`;
  $("#upload").onclick = () => openUpload(documents);
  $("#delete-workspace").onclick = async () => { if (confirm(`Delete “${workspace.name}” and every document and score inside it?`)) { await api(`/api/workspaces/${workspace.id}`, { method: "DELETE" }); state.workspace = null; state.group = null; state.question = ""; state.mode = null; state.compare = []; await loadDashboard(); state.dashboard.workspaces.length ? openWorkspace(state.dashboard.workspaces[0].id) : renderEmpty(); } };
  $("#workspace-new-group")?.addEventListener("click", () => $("#group-dialog").showModal());
  $("#group-select")?.addEventListener("change", async (event) => { state.question = ""; await api(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ primaryGroup: event.target.value }) }); openWorkspace(workspace.id, { group: event.target.value }); });
  $("#metric-select")?.addEventListener("change", (event) => openWorkspace(workspace.id, { question: event.target.value }));
  $$("[data-mode]").forEach((button) => button.onclick = async () => { await api(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ rankingMode: button.dataset.mode }) }); openWorkspace(workspace.id, { mode: button.dataset.mode }); });
  $("#attach-select")?.addEventListener("change", async (event) => { if (!event.target.value) return; await api(`/api/workspaces/${workspace.id}/groups`, { method: "POST", body: JSON.stringify({ group: event.target.value }) }); await api(`/api/workspaces/${workspace.id}`, { method: "PATCH", body: JSON.stringify({ primaryGroup: event.target.value }) }); state.question = ""; openWorkspace(workspace.id, { group: event.target.value }); });
  $$('[data-view]').forEach((button) => button.onclick = () => viewDocument(workspace.id, button.dataset.view));
  $$('[data-compare]').forEach((button) => button.onclick = () => toggleCompare(button.dataset.compare));
  $$('[data-evaluate]').forEach((button) => button.onclick = () => evaluate(workspace.id, button.dataset.evaluate, button));
  $$('[data-table-view]').forEach((button) => button.onclick = () => { state.tableView = button.dataset.tableView; renderWorkspace(); });
  renderCompareTray();
}

async function evaluate(workspaceId, documentId, button) {
  const old = button.innerHTML; button.disabled = true; button.innerHTML = `<span class="spinner"></span>`;
  try { const run = await api(`/api/workspaces/${workspaceId}/documents/${documentId}/evaluate`, { method: "POST", body: JSON.stringify({ group: state.group }) }); toast(run.status === "success" ? "Evaluation complete" : "Question scores saved; the overall scorer failed", run.status !== "success"); await openWorkspace(workspaceId); }
  catch (error) { toast(error.message, true); await openWorkspace(workspaceId); }
  finally { button.disabled = false; button.innerHTML = old; }
}

function openUpload(documents) {
  const form = $("#document-form"); form.reset();
  form.elements.parentDocument.innerHTML = `<option value="">No parent</option>${documents.map((document) => `<option value="${document.id}">${escapeHtml(versionTitle(document))}</option>`).join("")}`;
  $("#document-dialog").showModal();
}

function comparisonScoreRows(leftId, rightId) {
  const matrix = state.workspace?.matrix;
  if (!matrix) return `<div class="chart-empty compare-empty">Attach an evaluation group to compare scores.</div>`;
  const left = matrix.rows.find((row) => row.id === leftId);
  const right = matrix.rows.find((row) => row.id === rightId);
  const rows = [
    { label: "Overall", left: left?.overallScore, right: right?.overallScore, overall: true },
    ...matrix.questions.map((question) => ({ label: question.text, left: left?.scores[question.key], right: right?.scores[question.key] })),
  ];
  return `<div class="comparison-score-table"><table><thead><tr><th>Metric</th><th title="${escapeHtml(left?.title || "Left document")}">${left ? versionLabel(left) : "Left"}</th><th title="${escapeHtml(right?.title || "Right document")}">${right ? versionLabel(right) : "Right"}</th></tr></thead><tbody>${rows.map((row) => `<tr class="${row.overall ? "overall-row" : ""}"><td>${escapeHtml(row.label)}</td><td>${score(row.left)}</td><td>${score(row.right)}</td></tr>`).join("")}</tbody></table></div>`;
}

async function openComparison() {
  if (state.compare.length !== 2 || !state.workspace) return;
  const workspace = state.workspace.workspace;
  try {
    state.compare.sort((leftId, rightId) => {
      const left = state.workspace.documents.find((document) => document.id === leftId);
      const right = state.workspace.documents.find((document) => document.id === rightId);
      return left.version - right.version;
    });
    renderCompareTray();
    const [left, right] = await Promise.all(state.compare.map((id) => api(`/api/workspaces/${workspace.id}/documents/${id}`)));
    const options = (selectedId) => state.workspace.documents.map((document) => `<option value="${document.id}" ${document.id === selectedId ? "selected" : ""}>${escapeHtml(versionTitle(document))}</option>`).join("");
    $("#comparison").innerHTML = `<div class="comparison-shell">
      <div class="comparison-top"><div><p class="eyebrow">Document comparison</p><h2>Compare drafts</h2><p class="subtle">${escapeHtml(state.workspace.matrix?.group.name || "Scores unavailable")} · ${state.mode === "median" ? "median" : "highest"} scores</p></div><button class="icon" id="close-comparison" aria-label="Close">×</button></div>
      <div class="compare-pickers"><label>Original document<select data-compare-picker="0">${options(left.id)}</select></label><label>Changed document<select data-compare-picker="1">${options(right.id)}</select></label></div>
      <section class="comparison-section"><div class="comparison-section-title"><h3>Scores</h3></div>${comparisonScoreRows(left.id, right.id)}</section>
      <section class="comparison-section"><div class="comparison-section-title"><h3>Documents</h3><div class="segmented compare-view-toggle"><button data-comparison-view="rendered" class="${state.comparisonView === "rendered" ? "active" : ""}">Rendered</button><button data-comparison-view="diff" class="${state.comparisonView === "diff" ? "active" : ""}">Diff</button></div></div><div id="comparison-documents">${comparisonDocuments(left, right, workspace.id, state.comparisonView)}</div></section>
    </div>`;
    $("#close-comparison").onclick = () => { state.diffExpanded = false; $("#compare-dialog").close(); };
    $$('[data-comparison-view]', $("#comparison")).forEach((button) => button.onclick = () => { state.comparisonView = button.dataset.comparisonView; openComparison(); });
    $$('[data-expand-diff]', $("#comparison")).forEach((button) => button.onclick = () => { state.diffExpanded = true; openComparison(); });
    $$('[data-compare-picker]', $("#comparison")).forEach((select) => select.onchange = () => {
      const index = Number(select.dataset.comparePicker);
      if (state.compare[1 - index] === select.value) { toast("Choose two different documents"); select.value = state.compare[index]; return; }
      state.compare[index] = select.value; state.diffExpanded = false; openComparison(); renderWorkspace();
    });
    if (!$("#compare-dialog").open) $("#compare-dialog").showModal();
  } catch (error) { toast(error.message, true); }
}

async function viewDocument(workspaceId, documentId) {
  const document = await api(`/api/workspaces/${workspaceId}/documents/${documentId}`);
  const history = document.runs.length ? document.runs.map((run) => `<article class="run-card"><div class="run-head"><div><strong>${escapeHtml(run.groupName)}</strong><span class="subtle">${date(run.createdAt)} · ${escapeHtml(run.model || run.status)}</span></div><span class="score">${score(run.overallScore)}</span></div>${run.error || run.aggregationError ? `<p class="run-error">${escapeHtml(run.error || run.aggregationError)}</p>` : ""}${run.scores.length ? `<div class="score-list">${run.scores.map((item)=>`<div><span>${escapeHtml(item.text)}</span><strong>${score(item.score)}</strong></div>`).join("")}</div>` : ""}</article>`).join("") : `<p class="subtle">No evaluation runs yet.</p>`;
  const renderDocument = (mode) => {
    const content = $("#document-content");
    content.className = mode === "rendered" ? "document-body markdown-body" : "document-body source-body";
    content.innerHTML = mode === "rendered" ? markdownToHtml(document.content) : `<pre>${escapeHtml(document.content)}</pre>`;
    $$('[data-document-mode]', $("#viewer")).forEach((button) => button.classList.toggle("active", button.dataset.documentMode === mode));
  };
  const selected = state.compare.includes(documentId);
  $("#viewer").innerHTML = `<div class="viewer-shell"><div class="viewer-top"><div><p class="eyebrow">${document.isOriginal ? "Original" : "Revision"} · ${versionLabel(document)}</p><h2>${escapeHtml(document.title)}</h2><p class="subtle">${escapeHtml(document.changeSummary || date(document.createdAt))}</p></div><div class="viewer-actions"><button class="ghost ${selected ? "selected" : ""}" id="viewer-compare">${selected ? "Selected" : "Compare"}</button><a class="ghost" href="/api/workspaces/${workspaceId}/documents/${documentId}?download">Download</a><button class="icon" id="close-viewer">×</button></div></div><div class="document-mode"><div class="segmented"><button data-document-mode="rendered" class="active">Rendered</button><button data-document-mode="source">Source</button></div></div><div id="document-content"></div><h3 class="history-title">Evaluation history</h3><div class="run-list">${history}</div></div>`;
  renderDocument("rendered");
  $$('[data-document-mode]', $("#viewer")).forEach((button) => button.onclick = () => renderDocument(button.dataset.documentMode));
  $("#viewer-compare").onclick = () => { toggleCompare(documentId); const isSelected = state.compare.includes(documentId); $("#viewer-compare").textContent = isSelected ? "Selected" : "Compare"; $("#viewer-compare").classList.toggle("selected", isSelected); };
  $("#close-viewer").onclick = () => $("#viewer-dialog").close(); $("#viewer-dialog").showModal();
}

function renderGroups() {
  state.workspace = null; state.compare = []; renderCompareTray(); loadDashboard().then(() => {
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
