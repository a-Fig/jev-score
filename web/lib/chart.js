import { escapeHtml, signed } from "./format.js";

// The progress chart plots every scored draft's change from the original
// (series 1) and the best result reached so far (series 2) on one axis of
// points. It returns SVG plus each draft's position so the app can add a
// crosshair and tooltip; the report embeds the same SVG without them.

function niceScale(low, high, ticks = 4) {
  if (low === high) { low -= 1; high += 1; }
  const padding = (high - low) * 0.08;
  const paddedLow = low < 0 ? low - padding : 0;
  const paddedHigh = high > 0 ? high + padding : 0;
  const raw = (paddedHigh - paddedLow) / ticks;
  const magnitude = 10 ** Math.floor(Math.log10(raw || 1));
  const normalized = raw / magnitude;
  const step = (normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10) * magnitude;
  const min = Math.floor(paddedLow / step) * step;
  const max = Math.ceil(paddedHigh / step) * step;
  const values = [];
  for (let value = min; value <= max + step / 2; value += step) values.push(Number(value.toFixed(8)));
  return { min, max, step, values };
}

export function progressChart(points, { width = 760, height = 300, label = "Change from the original, in points" } = {}) {
  const usable = (points || []).filter((point) => point.delta != null);
  if (!usable.length) return null;
  const left = 46, right = 92, top = 20, bottom = 34;
  const scale = niceScale(
    Math.min(0, ...usable.flatMap((point) => [point.delta, point.frontier, point.minDelta ?? point.delta])),
    Math.max(0, ...usable.flatMap((point) => [point.delta, point.frontier, point.maxDelta ?? point.delta])),
  );
  const versions = usable.map((point) => point.documentVersion);
  const first = Math.min(...versions), last = Math.max(...versions);
  const plotWidth = width - left - right;
  const x = (version) => left + (first === last ? plotWidth / 2 : ((version - first) / (last - first)) * plotWidth);
  const y = (value) => height - bottom - ((value - scale.min) / (scale.max - scale.min)) * (height - top - bottom);
  const precision = Math.max(0, Math.ceil(-Math.log10(scale.step)));
  const grid = scale.values.map((tick) => `<g class="chart-tick${tick === 0 ? " zero" : ""}"><line x1="${left}" x2="${width - right}" y1="${y(tick)}" y2="${y(tick)}"/><text x="${left - 8}" y="${y(tick) + 3.5}">${tick > 0 ? "+" : tick < 0 ? "−" : ""}${Math.abs(Number(tick.toFixed(precision)))}</text></g>`).join("");
  const draftLine = usable.map((point, index) => `${index ? "L" : "M"}${x(point.documentVersion).toFixed(1)},${y(point.delta).toFixed(1)}`).join(" ");
  // "Best so far" only ever steps up, so it is drawn as a step line.
  const bestLine = usable.map((point, index) => index ? `H${x(point.documentVersion).toFixed(1)} V${y(point.frontier).toFixed(1)}` : `M${x(point.documentVersion).toFixed(1)},${y(point.frontier).toFixed(1)}`).join(" ");
  const ranges = usable.filter((point) => point.runs > 1 && point.minDelta !== point.maxDelta).map((point) => {
    const center = x(point.documentVersion);
    return `<line class="chart-range" x1="${center}" x2="${center}" y1="${y(point.maxDelta)}" y2="${y(point.minDelta)}"/>`;
  }).join("");
  const labelEvery = Math.max(1, Math.ceil(usable.length / 12));
  const xLabels = usable.map((point, index) => index % labelEvery === 0 || index === usable.length - 1 ? `<text class="chart-x" x="${x(point.documentVersion)}" y="${height - 12}">#${point.documentVersion}</text>` : "").join("");
  const bestPoint = usable.reduce((best, point) => point.delta > best.delta ? point : best, usable[0]);
  const markers = usable.map((point) => `<circle class="chart-dot${point === bestPoint ? " best" : ""}" cx="${x(point.documentVersion)}" cy="${y(point.delta)}" r="4.5"><title>${escapeHtml(`#${point.documentVersion} · ${point.documentTitle}: ${signed(point.delta)}`)}</title></circle>`).join("");
  const end = usable.at(-1);
  // Selective direct labels: the best draft and where "best so far" ends.
  // The best draft gets its own label only when the line doesn't already end there.
  const directLabels = [
    bestPoint !== end && bestPoint.delta !== 0 ? `<text class="chart-label best-label" x="${x(bestPoint.documentVersion)}" y="${y(bestPoint.delta) - 11}" text-anchor="middle">${escapeHtml(signed(bestPoint.delta))}</text>` : "",
    `<text class="chart-label frontier-label" x="${width - right + 8}" y="${y(end.frontier) + 3.5}">Best ${escapeHtml(signed(end.frontier))}</text>`,
  ].join("");
  const svg = `<svg class="progress-chart" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHtml(label)}"><g class="chart-grid">${grid}</g><line class="chart-axis" x1="${left}" x2="${width - right}" y1="${height - bottom}" y2="${height - bottom}"/>${xLabels}<path class="chart-frontier" d="${bestLine}"/>${ranges}<path class="chart-line" d="${draftLine}"/>${markers}${directLabels}<line class="chart-crosshair" x1="0" x2="0" y1="${top}" y2="${height - bottom}"/></svg>`;
  return { svg, width, height, positions: usable.map((point) => ({ x: x(point.documentVersion), y: y(point.delta), point })) };
}

export function sparkline(points, { width = 220, height = 44 } = {}) {
  const usable = (points || []).filter((point) => point.delta != null);
  if (usable.length < 2) return "";
  const values = usable.flatMap((point) => [point.delta, point.frontier ?? point.delta]);
  const low = Math.min(0, ...values), high = Math.max(0, ...values);
  const span = high - low || 1;
  const x = (index) => 3 + (index / (usable.length - 1)) * (width - 6);
  const y = (value) => height - 4 - ((value - low) / span) * (height - 8);
  const path = usable.map((point, index) => `${index ? "L" : "M"}${x(index).toFixed(1)},${y(point.delta).toFixed(1)}`).join(" ");
  const endPoint = usable.at(-1);
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" aria-hidden="true"><line class="spark-zero" x1="0" x2="${width}" y1="${y(0)}" y2="${y(0)}"/><path class="spark-line" d="${path}"/><circle class="spark-dot" cx="${x(usable.length - 1)}" cy="${y(endPoint.delta)}" r="3"/></svg>`;
}
