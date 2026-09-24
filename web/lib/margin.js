import { score, versionLabel } from "./format.js";
import { deltaHtml, dirHtml, e, penCircle } from "./ui.js";

const improvement = (value, baseline, direction = "higher") => value == null || baseline == null ? null : Math.round((direction === "lower" ? baseline - value : value - baseline) * 10) / 10;
const goodness = (value, direction) => direction === "lower" ? 100 - value : value;

// The margin: an editor's notes beside the manuscript. Each question's score
// sits next to the text, with its change from a baseline draft; the weakest
// questions are circled in red pen as the ones to revise next.
export function weakestKeys(questions, scores, count = 3) {
  return new Set(questions.filter((question) => scores?.[question.key] != null)
    .sort((a, b) => goodness(scores[a.key], a.direction) - goodness(scores[b.key], b.direction))
    .slice(0, count).map((question) => question.key));
}

export function marginHtml({ title = "Margin notes", subtitle = "", questions = [], current = null, baseline = null, baselineLabel = "", best = null, original = null, empty = "" }) {
  if (!questions.length) return `<aside class="margin" aria-label="Scores"><div class="margin-head"><h2>${e(title)}</h2></div><div class="margin-empty">${empty || "Attach an evaluation group to see scores here."}</div></aside>`;
  const scores = current?.scores || null;
  const hasScores = scores && Object.values(scores).some((value) => value != null);
  const weak = hasScores ? weakestKeys(questions, scores) : new Set();
  const deltaLine = [
    baseline && current?.overallScore != null && baseline.overallScore != null ? `<span>${deltaHtml(improvement(current.overallScore, baseline.overallScore))} vs ${e(baselineLabel || versionLabel(baseline))}</span>` : "",
    best && current?.overallScore != null && best.overallScore != null ? `<span>${deltaHtml(improvement(current.overallScore, best.overallScore))} vs best ${e(versionLabel(best))}</span>` : "",
    original && current?.overallScore != null && original.overallScore != null ? `<span>${deltaHtml(improvement(current.overallScore, original.overallScore))} vs original</span>` : "",
  ].filter(Boolean).join("");
  return `<aside class="margin" aria-label="Scores">
    <div class="margin-head"><h2>${e(title)}</h2>${subtitle ? `<span class="faint">${e(subtitle)}</span>` : ""}</div>
    ${hasScores ? `<div class="margin-overall"><span class="label">Overall</span><span></span><strong>${score(current.overallScore)}</strong><span></span>${deltaLine ? `<div class="deltas">${deltaLine}</div>` : ""}</div>` : `<div class="margin-empty">${empty || "Not scored yet."}</div>`}
    ${questions.map((question) => {
      const value = scores?.[question.key] ?? null;
      const change = baseline ? improvement(value, baseline.scores?.[question.key], question.direction) : null;
      const isWeak = weak.has(question.key);
      return `<div class="m-note${isWeak ? " weak" : ""}"><div class="q">${e(question.text)}${question.direction === "lower" ? `<span class="dir-line">${dirHtml("lower", true)}</span>` : ""}</div><div class="s">${isWeak ? penCircle(question.key) : ""}${score(value)}</div>${baseline && value != null ? `<div class="d">${deltaHtml(change)}</div>` : ""}</div>`;
    }).join("")}
    ${hasScores && weak.size ? `<p class="margin-foot">Circled: the weakest ${weak.size === 1 ? "question" : `${weak.size} questions`}. Aim the next revision there, and make it a real change.</p>` : ""}
  </aside>`;
}
