import { progressChart } from "./chart.js";
import { score, signed } from "./format.js";

let observer = null;
let observed = null;

// Renders the progress chart into `host` and adds the hover layer: a crosshair
// that snaps to the nearest draft, a tooltip listing both series, arrow-key
// navigation, and click to open the draft.
export function mountProgressChart(host, timeline, options = {}) {
  const { onOpen = null, metricLabel = "Overall" } = options;
  // Draw at the host's real width so axis text stays legible on phones.
  const available = host.clientWidth || 760;
  const width = Math.round(Math.max(320, Math.min(900, available)));
  const chart = progressChart(timeline, { width, height: Math.round(Math.max(230, Math.min(320, width * 0.38))), label: `${metricLabel}: change from the original draft, in points` });
  if (!chart) return false;
  // One chart is on screen at a time; re-rendering a view creates a new host.
  if (typeof ResizeObserver === "function" && observed !== host) {
    observer?.disconnect();
    observed = host;
    observer = new ResizeObserver(() => {
      if (host.clientWidth && Math.abs(host.clientWidth - host._chartWidth) > 40) mountProgressChart(host, host._chartTimeline, host._chartOptions);
    });
    observer.observe(host);
  }
  host._chartWidth = available; host._chartTimeline = timeline; host._chartOptions = options;
  host.innerHTML = `<div class="chart-wrap">${chart.svg}<div class="chart-overlay" tabindex="0" role="application" aria-label="Progress chart. Use the left and right arrow keys to move between drafts and Enter to open one."></div><div class="chart-tip" aria-hidden="true"></div><div class="visually-hidden" aria-live="polite"></div></div>`;
  const svg = host.querySelector("svg");
  const overlay = host.querySelector(".chart-overlay");
  const tip = host.querySelector(".chart-tip");
  const announcer = host.querySelector("[aria-live]");
  const crosshair = svg.querySelector(".chart-crosshair");
  const dots = [...svg.querySelectorAll(".chart-dot")];
  let index = -1;

  const row = (label, value, keyClass = "") => {
    const line = document.createElement("div");
    line.className = "tip-row";
    const name = document.createElement("span");
    if (keyClass !== null) { const key = document.createElement("i"); key.className = `key ${keyClass}`; name.append(key); }
    name.append(label);
    const strong = document.createElement("strong");
    strong.textContent = value;
    line.append(name, strong);
    return line;
  };

  function show(next) {
    if (next < 0 || next >= chart.positions.length) return;
    index = next;
    const { x, y, point } = chart.positions[index];
    const bounds = svg.getBoundingClientRect();
    const scale = bounds.width / chart.width;
    crosshair.setAttribute("x1", x); crosshair.setAttribute("x2", x); crosshair.classList.add("on");
    dots.forEach((dot, dotIndex) => dot.classList.toggle("active", dotIndex === index));
    const title = document.createElement("div");
    title.className = "tip-title";
    title.textContent = `#${point.documentVersion} · ${point.documentTitle}`;
    const rows = [
      row("This draft", signed(point.delta), ""),
      row("Best so far", signed(point.frontier), "frontier"),
      row("Score", score(point.score), null),
    ];
    if (point.runs > 1) rows.push(row(`Range over ${point.runs} runs`, `${signed(point.minDelta)} to ${signed(point.maxDelta)}`, null));
    tip.replaceChildren(title, ...rows);
    tip.classList.add("on");
    const tipWidth = tip.offsetWidth || 220;
    const left = Math.min(Math.max(0, x * scale - tipWidth / 2), bounds.width - tipWidth);
    const top = y * scale - tip.offsetHeight - 16;
    tip.style.left = `${left}px`;
    tip.style.top = `${top < 0 ? y * scale + 16 : top}px`;
    announcer.textContent = `${title.textContent}. ${signed(point.delta)} points from the original. Score ${score(point.score)}.`;
  }

  function hide() {
    tip.classList.remove("on");
    crosshair.classList.remove("on");
    dots.forEach((dot) => dot.classList.remove("active"));
  }

  function nearest(clientX) {
    const bounds = svg.getBoundingClientRect();
    const x = ((clientX - bounds.left) / bounds.width) * chart.width;
    let best = 0;
    chart.positions.forEach((position, positionIndex) => { if (Math.abs(position.x - x) < Math.abs(chart.positions[best].x - x)) best = positionIndex; });
    return best;
  }

  overlay.addEventListener("pointermove", (event) => show(nearest(event.clientX)));
  overlay.addEventListener("pointerleave", () => { if (document.activeElement !== overlay) hide(); });
  overlay.addEventListener("click", (event) => { const target = nearest(event.clientX); if (onOpen) onOpen(chart.positions[target].point); });
  overlay.addEventListener("focus", () => show(index < 0 ? chart.positions.length - 1 : index));
  overlay.addEventListener("blur", hide);
  overlay.addEventListener("keydown", (event) => {
    if (event.key === "ArrowRight") { event.preventDefault(); show(Math.min(chart.positions.length - 1, index + 1)); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); show(Math.max(0, index - 1)); }
    else if (event.key === "Home") { event.preventDefault(); show(0); }
    else if (event.key === "End") { event.preventDefault(); show(chart.positions.length - 1); }
    else if (event.key === "Enter" && index >= 0 && onOpen) onOpen(chart.positions[index].point);
    else if (event.key === "Escape") { overlay.blur(); }
  });
  return true;
}
