import { progressChart } from "../web/lib/chart.js";
import { escapeHtml, longDate, plural, score, signed } from "../web/lib/format.js";
import { markdownToHtml } from "../web/lib/markdown.js";
import { ranking, resolveDocument, resolveWorkspace, scoreMatrix, usageSummary } from "./service.mjs";

const improvement = (value, baseline, direction = "higher") => value == null || baseline == null ? null : Math.round((direction === "lower" ? baseline - value : value - baseline) * 10) / 10;

export function reportData(db, workspaceRef, { group = null, mode = null, appVersion = null } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const result = ranking(db, workspace.id, { group, mode });
  const matrix = scoreMatrix(db, workspace.id, { group, mode });
  const rows = [...matrix.rows].sort((a, b) => a.version - b.version);
  const original = rows.find((row) => row.isOriginal) || null;
  const best = matrix.rows.find((row) => row.isBest) || null;
  const questions = matrix.questions.map((question) => ({
    key: question.key, text: question.text, direction: question.direction,
    original: original?.scores[question.key] ?? null, best: best?.scores[question.key] ?? null,
    change: improvement(best?.scores[question.key], original?.scores[question.key], question.direction),
  }));
  const usage = usageSummary(db).workspaces.find((item) => item.id === workspace.id) || null;
  const models = db.prepare(`SELECT DISTINCT model FROM evaluation_runs WHERE workspace_id=? AND model IS NOT NULL ORDER BY model`).all(workspace.id).map((row) => row.model);
  return {
    workspace, group: result.group, mode: result.mode, questions, timeline: result.timeline, models, usage, appVersion,
    generatedAt: new Date().toISOString(),
    documents: rows.map((row) => ({ ...row, delta: improvement(row.overallScore, original?.overallScore) })),
    original, best, bestContent: best ? resolveDocument(db, workspace.id, best.id).content : null,
    evaluated: rows.filter((row) => row.overallScore != null).length,
  };
}

const fence = (content) => {
  const longest = Math.max(2, ...[...String(content).matchAll(/`{3,}/g)].map((match) => match[0].length));
  return "`".repeat(longest + 1);
};
const cell = (value) => String(value ?? "").replace(/\|/g, "\\|").replace(/\n/g, " ");
const modeLabel = (mode) => mode === "median" ? "median of runs" : "best observed run";

export function markdownReport(data) {
  const lines = [
    `# ${data.workspace.name}: Jev Score report`,
    "",
    `Scored with the **${data.group.name}** evaluation group against the workspace's ${data.workspace.contextTitle.toLowerCase()}. Scores use the ${modeLabel(data.mode)} for each draft. Generated ${longDate(data.generatedAt)}${data.appVersion ? ` by Jev Score ${data.appVersion}` : ""}.`,
    "",
  ];
  if (data.best && data.original) {
    lines.push(`**Best draft:** #${data.best.version} ${data.best.title}, ${score(data.best.overallScore)} overall (${signed(improvement(data.best.overallScore, data.original.overallScore))} vs the original #${data.original.version} at ${score(data.original.overallScore)}).`, "");
  } else if (data.best) {
    lines.push(`**Best draft:** #${data.best.version} ${data.best.title}, ${score(data.best.overallScore)} overall.`, "");
  }
  lines.push(`${plural(data.documents.length, "draft")}, ${data.evaluated} scored.${data.models.length ? ` Model: ${data.models.join(", ")}.` : ""}`, "");
  lines.push("## Questions", "", "| Question | Better when | Original | Best draft | Change |", "| --- | --- | ---: | ---: | ---: |");
  data.questions.forEach((question) => lines.push(`| ${cell(question.text)} | ${question.direction} | ${score(question.original)} | ${score(question.best)} | ${signed(question.change)} |`));
  lines.push("", "## Drafts", "", "| # | Title | Overall | vs original | Runs | What changed |", "| ---: | --- | ---: | ---: | ---: | --- |");
  data.documents.forEach((document) => lines.push(`| ${document.version} | ${cell(document.title)}${document.isOriginal ? " (original)" : ""}${document.isBest ? " **(best)**" : ""} | ${score(document.overallScore)} | ${signed(document.delta)} | ${document.runs} | ${cell(document.changeSummary)} |`));
  if (data.bestContent) {
    const marker = fence(data.bestContent);
    lines.push("", `## Best draft: #${data.best.version} ${data.best.title}`, "", `${marker}markdown`, data.bestContent.replace(/\n$/, ""), marker);
  }
  lines.push("", "---", "", "Jev is probabilistic: a gap of one or two points between drafts is within normal run-to-run variation.", "");
  return lines.join("\n");
}

const reportStyles = `
:root{--paper:#f4f0e6;--leaf:#fdfbf7;--ink:#1b1916;--graphite:#5a544b;--pencil:#8e877b;--rule:#e3ddd0;--series-1:#d4402a;--series-2:#2d62c4;--good:#1e7a4a;--bad:#b3361f;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--paper:#14120f;--leaf:#1d1b17;--ink:#f1ece2;--graphite:#c2baac;--pencil:#8e877b;--rule:#2e2a24;--series-1:#e5563d;--series-2:#5b8ae0;--good:#5dbb82;--bad:#f07a62;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.55 "Libre Franklin","Franklin Gothic Book","Segoe UI",system-ui,sans-serif}
main{max-width:980px;margin:0 auto;padding:56px 32px 80px}
.eyebrow{font-size:11px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:var(--pencil);margin:0 0 10px}
h1,h2,h3{font-family:Newsreader,"Iowan Old Style",Charter,Georgia,serif;font-weight:500;letter-spacing:-.01em;margin:0}
h1{font-size:44px;line-height:1.05}h2{font-size:26px;margin:44px 0 14px}
.lede{font-size:17px;color:var(--graphite);max-width:62ch;margin:14px 0 0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:1px;background:var(--rule);border:1px solid var(--rule);border-radius:10px;overflow:hidden;margin:32px 0 8px}
.stat{background:var(--leaf);padding:16px 18px}.stat span{display:block;font-size:12px;color:var(--pencil)}.stat strong{display:block;font-size:28px;font-weight:600;letter-spacing:-.02em;margin-top:2px}.stat small{color:var(--graphite)}
.good{color:var(--good)}.bad{color:var(--bad)}
.card{background:var(--leaf);border:1px solid var(--rule);border-radius:10px;padding:18px 20px}
table{width:100%;border-collapse:collapse;font-size:13.5px}th,td{padding:9px 10px;border-bottom:1px solid var(--rule);text-align:left;vertical-align:top}th{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--pencil);font-weight:700}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}tr:last-child td{border-bottom:0}
.tag{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 6px;border-radius:99px;margin-left:6px;vertical-align:1px}.tag.best{background:color-mix(in srgb,var(--series-1) 14%,transparent);color:var(--series-1)}.tag.original{background:color-mix(in srgb,var(--pencil) 18%,transparent);color:var(--graphite)}
.progress-chart{width:100%;height:auto;display:block;overflow:visible}.chart-tick line{stroke:var(--rule)}.chart-tick.zero line{stroke:var(--pencil)}.chart-tick text,.chart-x{fill:var(--pencil);font:10px ui-monospace,Menlo,Consolas,monospace}.chart-tick text{text-anchor:end}.chart-x{text-anchor:middle}.chart-axis{stroke:var(--rule)}
.chart-line{fill:none;stroke:var(--series-1);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}.chart-frontier{fill:none;stroke:var(--series-2);stroke-width:2;stroke-linejoin:round}.chart-range{stroke:var(--series-1);stroke-width:1.5;opacity:.45}
.chart-dot{fill:var(--series-1);stroke:var(--leaf);stroke-width:2}.chart-label{font:600 11px "Libre Franklin",system-ui,sans-serif;fill:var(--ink)}.chart-crosshair{display:none}
.legend{display:flex;gap:18px;font-size:12px;color:var(--graphite);margin:0 0 8px}.legend i{display:inline-block;width:16px;border-top:2px solid var(--series-1);vertical-align:middle;margin-right:6px}.legend i.frontier{border-color:var(--series-2)}
.manuscript{font:18px/1.7 Newsreader,"Iowan Old Style",Charter,Georgia,serif;max-width:68ch}.manuscript h1{font-size:30px}.manuscript h2{font-size:23px;margin:28px 0 8px}.manuscript h3{font-size:19px;margin:22px 0 6px}
.manuscript code{font:13px ui-monospace,Menlo,Consolas,monospace}.manuscript pre{background:var(--paper);padding:12px;border-radius:8px;overflow:auto}.manuscript blockquote{margin:0;padding-left:16px;border-left:2px solid var(--rule);color:var(--graphite)}
footer{margin-top:56px;padding-top:18px;border-top:1px solid var(--rule);font-size:12.5px;color:var(--pencil)}
`;

export function htmlReport(data) {
  const chart = progressChart(data.timeline);
  const gain = data.best && data.original ? improvement(data.best.overallScore, data.original.overallScore) : null;
  const tone = (value) => value > 0 ? "good" : value < 0 ? "bad" : "";
  const stat = (label, value, note = "", className = "") => `<div class="stat"><span>${escapeHtml(label)}</span><strong class="${className}">${escapeHtml(value)}</strong>${note ? `<small>${escapeHtml(note)}</small>` : ""}</div>`;
  const questionRows = data.questions.map((question) => `<tr><td>${escapeHtml(question.text)}</td><td>${question.direction === "lower" ? "lower" : "higher"}</td><td class="num">${score(question.original)}</td><td class="num">${score(question.best)}</td><td class="num ${tone(question.change)}">${signed(question.change)}</td></tr>`).join("");
  const documentRows = data.documents.map((document) => `<tr><td class="num">#${document.version}</td><td>${escapeHtml(document.title)}${document.isOriginal ? `<span class="tag original">Original</span>` : ""}${document.isBest ? `<span class="tag best">Best</span>` : ""}${document.changeSummary ? `<br><small style="color:var(--graphite)">${escapeHtml(document.changeSummary)}</small>` : ""}</td><td class="num">${score(document.overallScore)}</td><td class="num ${tone(document.delta)}">${signed(document.delta)}</td><td class="num">${document.runs}</td></tr>`).join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(data.workspace.name)} · Jev Score report</title>
<style>${reportStyles}</style>
</head>
<body>
<main>
<p class="eyebrow">Jev Score report · ${escapeHtml(data.workspace.contextTitle)}</p>
<h1>${escapeHtml(data.workspace.name)}</h1>
<p class="lede">Scored with the ${escapeHtml(data.group.name)} evaluation group. Each draft uses its ${modeLabel(data.mode)}.</p>
<div class="stats">
${stat("Best draft", data.best ? score(data.best.overallScore) : "—", data.best ? `#${data.best.version} ${data.best.title}` : "No scores yet")}
${stat("Change from the original", gain == null ? "—" : signed(gain), data.original ? `Original #${data.original.version} scored ${score(data.original.overallScore)}` : "", tone(gain))}
${stat("Drafts scored", `${data.evaluated} of ${data.documents.length}`, data.usage ? plural(data.usage.runs, "evaluation run") : "")}
</div>
${chart ? `<h2>Progress</h2><div class="card"><div class="legend"><span><i></i>Each draft's change from the original</span><span><i class="frontier"></i>Best so far</span></div>${chart.svg}</div>` : ""}
<h2>Questions</h2>
<div class="card"><table><thead><tr><th>Question</th><th>Better when</th><th class="num">Original</th><th class="num">Best draft</th><th class="num">Change</th></tr></thead><tbody>${questionRows}</tbody></table></div>
<h2>Drafts</h2>
<div class="card"><table><thead><tr><th class="num">#</th><th>Title</th><th class="num">Overall</th><th class="num">vs original</th><th class="num">Runs</th></tr></thead><tbody>${documentRows}</tbody></table></div>
${data.bestContent ? `<h2>Best draft: #${data.best.version} ${escapeHtml(data.best.title)}</h2><div class="card manuscript">${markdownToHtml(data.bestContent)}</div>` : ""}
<footer>Generated ${escapeHtml(longDate(data.generatedAt))}${data.appVersion ? ` by Jev Score ${escapeHtml(data.appVersion)}` : ""}${data.models.length ? ` · ${escapeHtml(data.models.join(", "))}` : ""}. Jev is probabilistic: a gap of one or two points between drafts is within normal run-to-run variation.</footer>
</main>
</body>
</html>
`;
}

export function renderReport(db, workspaceRef, { format = "html", ...options } = {}) {
  if (!["html", "md"].includes(format)) throw Object.assign(new Error("Report format must be html or md."), { status: 400 });
  const data = reportData(db, workspaceRef, options);
  return { name: data.workspace.name, format, content: format === "md" ? markdownReport(data) : htmlReport(data) };
}
