import assert from "node:assert/strict";
import { test } from "node:test";
import { progressChart, sparkline } from "../web/lib/chart.js";
import { alignDiffChanges, diffLines, diffStats, trackedChanges, wordDiff } from "../web/lib/diff.js";
import { ago, signed } from "../web/lib/format.js";
import { markdownToHtml } from "../web/lib/markdown.js";

test("markdown renders common structure and never passes raw HTML or script URLs", () => {
  const html = markdownToHtml("# Title\n\nText with **bold**, *em*, `code`, and ~~gone~~.\n\n- one\n  - nested\n- [x] done\n\n| A | B |\n|---|--:|\n| 1 | 2 |\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1)) [good](https://example.com) ![img](data:image/png;base64,xx)");
  assert.match(html, /<h1 data-line="1">Title<\/h1>/);
  assert.match(html, /<strong>bold<\/strong>, <em>em<\/em>, <code>code<\/code>, and <del>gone<\/del>/);
  assert.match(html, /<ul data-line="5">\n<li data-line="5">one\n<ul data-line="6">/);
  assert.match(html, /class="check done"/);
  assert.match(html, /<th style="text-align:right">B<\/th>/);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(html, /href="javascript/);
  assert.doesNotMatch(html, /src="data:/);
  assert.match(html, /<a href="https:\/\/example.com" target="_blank" rel="noreferrer noopener">good<\/a>/);
  assert.doesNotMatch(markdownToHtml("snake_case_name stays"), /<em>/);
  assert.match(markdownToHtml("## Senior engineer, C#"), />Senior engineer, C#</);
  assert.match(markdownToHtml("[`npm i`](https://example.com)"), /<a [^>]+><code>npm i<\/code><\/a>/);
  assert.doesNotMatch(markdownToHtml("a | b\n---"), /<table>/);
});

test("diffs pair rewritten lines and mark word-level changes", () => {
  const rows = alignDiffChanges(diffLines("a\nThe quick fox\nc", "a\nThe slow fox\nc\nd"));
  assert.deepEqual(rows.map((row) => [row.leftType, row.rightType]), [["same", "same"], ["removed", "added"], ["same", "same"], ["empty", "added"]]);
  assert.equal(trackedChanges("The quick fox", "The slow fox"), "The <del>quick</del><ins>slow</ins> fox");
  assert.equal(trackedChanges("<b>", "<i>"), "&lt;<del>b</del><ins>i</ins>&gt;");
  assert.deepEqual(wordDiff("same", "same"), [{ type: "same", text: "same" }]);
  assert.deepEqual(diffStats("a\nb", "a\nc\nd"), { added: 2, removed: 1 });
});

test("the progress chart plots change from the original and labels the best", () => {
  assert.equal(progressChart([]), null);
  assert.equal(sparkline([{ delta: 1 }]), "");
  const chart = progressChart([
    { documentVersion: 0, documentTitle: "Original", delta: 0, frontier: 0, runs: 1 },
    { documentVersion: 2, documentTitle: "Better <b>", delta: 6.5, frontier: 6.5, runs: 3, minDelta: 4, maxDelta: 7 },
    { documentVersion: 3, documentTitle: "Worse", delta: -2, frontier: 6.5, runs: 1 },
  ], { width: 600, height: 260 });
  assert.equal(chart.positions.length, 3);
  assert.ok(chart.positions[1].x > chart.positions[0].x && chart.positions[1].y < chart.positions[0].y);
  assert.match(chart.svg, /class="chart-range"/);
  assert.match(chart.svg, /Best \+6\.5/);
  assert.match(chart.svg, /Better &lt;b&gt;/);
  assert.match(sparkline([{ delta: 0 }, { delta: 3 }]), /class="spark-line"/);
});

test("formatting uses real minus signs and relative times", () => {
  assert.equal(signed(2.34), "+2.3");
  assert.equal(signed(-1), "−1.0");
  assert.equal(signed(null), "—");
  const now = Date.parse("2026-01-10T12:00:00Z");
  assert.equal(ago("2026-01-10T11:59:50Z", now), "just now");
  assert.equal(ago("2026-01-10T09:00:00Z", now), "3 hours ago");
  assert.equal(ago("2026-01-09T12:00:00Z", now), "1 day ago");
});
