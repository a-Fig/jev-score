import { api, connectLive } from "./lib/api.js";
import { score, versionTitle } from "./lib/format.js";
import { $, $$, closeMenus, debounce, e, icons, toast } from "./lib/ui.js";
import { newWorkspaceDialog } from "./views/dialogs.js";

// ---------------------------------------------------------------------------
// App state shared by every view

export const app = {
  dashboard: { workspaces: [], groups: [], activity: [] },
  live: false,
  controller: null,
  compare: { workspaceId: null, ids: [] },
  paletteItems: [],
  scoring: new Set(),
};

const main = $("#main");
let navToken = 0;
let pendingRefresh = false;

const routes = [
  { pattern: /^\/$/, keys: [], load: () => import("./views/home.js") },
  { pattern: /^\/w\/([^/]+)\/?$/, keys: ["workspace"], load: () => import("./views/workspace.js") },
  { pattern: /^\/w\/([^/]+)\/d\/([^/]+)\/?$/, keys: ["workspace", "document"], load: () => import("./views/document.js") },
  { pattern: /^\/w\/([^/]+)\/edit(?:\/([^/]+))?\/?$/, keys: ["workspace", "document"], load: () => import("./views/editor.js") },
  { pattern: /^\/w\/([^/]+)\/compare\/([^/]+)\/([^/]+)\/?$/, keys: ["workspace", "left", "right"], load: () => import("./views/compare.js") },
  { pattern: /^\/groups\/?$/, keys: [], load: () => import("./views/groups.js") },
  { pattern: /^\/settings\/?$/, keys: [], load: () => import("./views/settings.js") },
];

export function navigate(path, { replace = false } = {}) {
  if (path === location.pathname + location.search) return render({ keepScroll: true });
  history[replace ? "replaceState" : "pushState"]({}, "", path);
  return render();
}

export function setTitle(title) {
  document.title = title ? `${title} · Jev Score` : "Jev Score";
}

async function render({ keepScroll = false } = {}) {
  const token = ++navToken;
  document.body.classList.remove("nav-open");
  $("#open-nav")?.setAttribute("aria-expanded", "false");
  closeMenus();
  const route = routes.find((candidate) => candidate.pattern.test(location.pathname)) || routes[0];
  const match = location.pathname.match(route.pattern) || [];
  const params = Object.fromEntries(route.keys.map((key, index) => [key, match[index + 1] ? decodeURIComponent(match[index + 1]) : null]));
  const query = new URLSearchParams(location.search);
  const root = document.createElement("div");
  const ctx = {
    root, params, query, app, navigate, setTitle, refreshShell,
    isCurrent: () => token === navToken,
    setQuery(changes) {
      const next = new URLSearchParams(location.search);
      Object.entries(changes).forEach(([key, value]) => value == null || value === "" ? next.delete(key) : next.set(key, value));
      const search = next.toString();
      history.replaceState({}, "", `${location.pathname}${search ? `?${search}` : ""}`);
    },
  };
  try {
    const module = await route.load();
    const controller = await module.mount(ctx);
    if (token !== navToken) { controller?.unmount?.(); return; }
    app.controller?.unmount?.();
    app.controller = controller || {};
    app.controller.workspaceId = params.workspace || null;
    main.replaceChildren(root);
    if (!keepScroll) window.scrollTo(0, 0);
    if (!keepScroll && document.activeElement === document.body) main.focus({ preventScroll: true });
  } catch (error) {
    if (token !== navToken) return;
    app.controller?.unmount?.();
    app.controller = {};
    setTitle("Not found");
    main.innerHTML = `<section class="page narrow"><p class="eyebrow">${error.status === 404 ? "Not found" : "Something went wrong"}</p><h1 style="font-size:40px">${e(error.status === 404 ? "That page isn't here." : "This page could not load.")}</h1><p class="muted" style="margin:14px 0 22px">${e(error.message)}</p><a class="btn primary" href="/" data-link>Go to workspaces</a></section>`;
  }
  renderSidebar();
  renderTray();
}

// ---------------------------------------------------------------------------
// Sidebar

export async function refreshShell() {
  try { app.dashboard = await api("/api/dashboard"); } catch {}
  renderSidebar();
  renderTray();
}

function currentTheme() {
  try { return localStorage.getItem("jev-theme") || "system"; } catch { return "system"; }
}

function themeLabel() {
  const theme = currentTheme();
  return { system: [icons.system, "Theme: match the system"], light: [icons.light, "Theme: light"], dark: [icons.dark, "Theme: dark"] }[theme] || [icons.system, "Theme: match the system"];
}

function cycleTheme() {
  const order = ["system", "light", "dark"];
  const next = order[(order.indexOf(currentTheme()) + 1) % order.length];
  try { if (next === "system") localStorage.removeItem("jev-theme"); else localStorage.setItem("jev-theme", next); } catch {}
  if (next === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = next;
  renderSidebar();
  toast(themeLabel()[1]);
}

function renderSidebar() {
  const { workspaces, activity } = app.dashboard;
  const current = location.pathname;
  const activeWorkspace = current.match(/^\/w\/([^/]+)/)?.[1];
  const busy = new Set(activity.map((item) => item.workspaceId));
  const [themeIcon, themeText] = themeLabel();
  const scoring = activity[0];
  $("#sidebar").innerHTML = `
    <a class="brand" href="/" data-link aria-label="Jev Score home"><span class="caret" aria-hidden="true">‸</span><em>Jev</em>&nbsp;Score</a>
    <button class="btn primary" id="new-workspace">New workspace</button>
    <div class="nav-label"><span>Workspaces</span><span>${workspaces.length || ""}</span></div>
    <nav class="nav-scroll" aria-label="Workspaces">
      ${workspaces.map((workspace) => `<a class="nav-item" href="/w/${encodeURIComponent(workspace.id)}" data-link ${activeWorkspace === workspace.id ? `aria-current="page"` : ""}>${busy.has(workspace.id) ? `<span class="pulse" title="Scoring now"></span>` : ""}<span class="name">${e(workspace.name)}</span><span class="value">${workspace.best ? score(workspace.best.score) : ""}</span></a>`).join("") || `<p class="nav-empty">None yet.</p>`}
    </nav>
    <div class="nav-footer">
      ${scoring ? `<div class="activity-note"><span class="pulse"></span><span>Scoring ${e(`#${scoring.documentVersion}`)} in ${e(scoring.workspaceName)}${activity.length > 1 ? ` and ${activity.length - 1} more` : ""}</span></div>` : ""}
      <a class="nav-item" href="/groups" data-link ${current.startsWith("/groups") ? `aria-current="page"` : ""}><span class="name">Evaluation groups</span><span class="value">${app.dashboard.groups.length || ""}</span></a>
      <a class="nav-item" href="/settings" data-link ${current.startsWith("/settings") ? `aria-current="page"` : ""}><span class="name">Settings &amp; usage</span></a>
      <div class="row">
        <span class="live-status ${app.live ? "on" : ""}" title="${app.live ? "Updates from agents appear here as they happen." : "Reconnecting to the local server…"}"><span class="dot"></span>${app.live ? "Live" : "Offline"}</span>
        <span>
          <button class="btn icon small quiet" id="open-palette" title="Search (Ctrl K)" aria-label="Search and commands">${icons.search}</button>
          <button class="btn icon small quiet" id="theme-toggle" title="${themeText}" aria-label="${themeText}">${themeIcon}</button>
        </span>
      </div>
    </div>`;
  $("#new-workspace").onclick = () => newWorkspaceDialog(app, navigate);
  $("#theme-toggle").onclick = cycleTheme;
  $("#open-palette").onclick = openPalette;
}

// ---------------------------------------------------------------------------
// Compare tray: pick two drafts anywhere in a workspace, then compare them.

export function toggleCompare(workspaceId, documentId) {
  if (app.compare.workspaceId !== workspaceId) app.compare = { workspaceId, ids: [] };
  const ids = app.compare.ids;
  if (ids.includes(documentId)) app.compare.ids = ids.filter((id) => id !== documentId);
  else if (ids.length < 2) ids.push(documentId);
  else { app.compare.ids = [ids[1], documentId]; }
  renderTray();
  return app.compare.ids.includes(documentId);
}

export const isComparing = (workspaceId, documentId) => app.compare.workspaceId === workspaceId && app.compare.ids.includes(documentId);

export function renderTray() {
  const slot = $("#tray-slot");
  const workspaceId = location.pathname.match(/^\/w\/([^/]+)/)?.[1];
  const documents = app.controller?.documents || [];
  if (!workspaceId || app.compare.workspaceId !== workspaceId || !app.compare.ids.length || location.pathname.includes("/compare/") || location.pathname.includes("/edit")) { slot.innerHTML = ""; return; }
  const chosen = app.compare.ids.map((id) => documents.find((document) => document.id === id)).filter(Boolean);
  if (!chosen.length) { slot.innerHTML = ""; return; }
  slot.innerHTML = `<div class="compare-tray" role="region" aria-label="Compare drafts"><span style="font-weight:650">Compare</span>${chosen.map((document) => `<span class="chip">${e(versionTitle(document))}<button data-uncompare="${e(document.id)}" aria-label="Remove ${e(document.title)}">×</button></span>`).join("")}${chosen.length < 2 ? `<span style="opacity:.7;font-size:12.5px">Pick one more draft</span>` : ""}<button class="btn quiet small" id="tray-clear">Clear</button><button class="btn accent small" id="tray-open" ${chosen.length < 2 ? "disabled" : ""}>Compare</button></div>`;
  $$("[data-uncompare]", slot).forEach((button) => button.onclick = () => { toggleCompare(workspaceId, button.dataset.uncompare); app.controller?.onCompareChange?.(); });
  $("#tray-clear", slot).onclick = () => { app.compare.ids = []; renderTray(); app.controller?.onCompareChange?.(); };
  $("#tray-open", slot).onclick = () => {
    const [left, right] = [...chosen].sort((a, b) => a.version - b.version);
    navigate(`/w/${encodeURIComponent(workspaceId)}/compare/${encodeURIComponent(left.id)}/${encodeURIComponent(right.id)}`);
  };
}

// ---------------------------------------------------------------------------
// Command palette (Ctrl/Cmd + K)

function paletteEntries() {
  const entries = [
    ...app.dashboard.workspaces.map((workspace) => ({ label: workspace.name, kind: "Workspace", run: () => navigate(`/w/${encodeURIComponent(workspace.id)}`) })),
    ...(app.controller?.paletteItems?.() || []),
    { label: "New workspace", kind: "Action", run: () => newWorkspaceDialog(app, navigate) },
    { label: "Evaluation groups", kind: "Page", run: () => navigate("/groups") },
    { label: "Settings and usage", kind: "Page", run: () => navigate("/settings") },
    { label: "Switch theme", kind: "Action", run: cycleTheme },
  ];
  return entries;
}

function openPalette() {
  const dialog = $("#palette");
  if (dialog.open) return;
  dialog.innerHTML = `<div class="palette-box"><input type="search" placeholder="Jump to a workspace, draft, or action…" aria-label="Search" autocomplete="off"><div class="palette-list" role="listbox"></div></div>`;
  const input = $("input", dialog);
  const list = $(".palette-list", dialog);
  let selected = 0;
  let items = [];
  const draw = () => {
    const query = input.value.trim().toLowerCase();
    items = paletteEntries().filter((item) => !query || `${item.label} ${item.kind}`.toLowerCase().includes(query)).slice(0, 40);
    selected = Math.min(selected, Math.max(0, items.length - 1));
    list.innerHTML = items.length ? items.map((item, index) => `<button class="palette-item" role="option" data-index="${index}" aria-selected="${index === selected}"><span>${e(item.label)}</span><span class="kind">${e(item.kind)}</span></button>`).join("") : `<div class="palette-empty">No matches.</div>`;
    $$(".palette-item", list).forEach((button) => button.onclick = () => choose(Number(button.dataset.index)));
    $(`[data-index="${selected}"]`, list)?.scrollIntoView({ block: "nearest" });
  };
  const choose = (index) => { const item = items[index]; dialog.close(); item?.run(); };
  input.oninput = () => { selected = 0; draw(); };
  input.onkeydown = (event) => {
    if (event.key === "ArrowDown") { event.preventDefault(); selected = Math.min(items.length - 1, selected + 1); draw(); }
    else if (event.key === "ArrowUp") { event.preventDefault(); selected = Math.max(0, selected - 1); draw(); }
    else if (event.key === "Enter") { event.preventDefault(); choose(selected); }
  };
  dialog.onclick = (event) => { if (event.target === dialog) dialog.close(); };
  draw();
  dialog.showModal();
  input.focus();
}

// ---------------------------------------------------------------------------
// Live updates

$("#open-nav").innerHTML = icons.menu;
$("#open-palette-mobile").innerHTML = icons.search;

const liveRefresh = debounce(async () => {
  // Re-rendering would close an open menu or pull a view out from under a dialog.
  if ($("details.menu[open]") || $("#modal").open || $("#palette").open) { pendingRefresh = true; return; }
  const active = document.activeElement;
  if (active && main.contains(active) && active.matches("input, textarea, select") && !app.controller?.refreshWhileTyping) {
    pendingRefresh = true;
    return;
  }
  pendingRefresh = false;
  await refreshShell();
  try { await app.controller?.refresh?.(); } catch {}
}, 250);

main.addEventListener("focusout", () => { if (pendingRefresh) setTimeout(liveRefresh, 50); });
document.addEventListener("toggle", (event) => { if (pendingRefresh && event.target.matches?.("details.menu") && !event.target.open) liveRefresh(); }, true);
for (const id of ["#modal", "#palette"]) $(id).addEventListener("close", () => { if (pendingRefresh) setTimeout(liveRefresh, 50); });

connectLive({
  onChange: () => liveRefresh(),
  onStatus: (on) => { if (app.live !== on) { app.live = on; renderSidebar(); } },
});

// ---------------------------------------------------------------------------
// Global events

document.addEventListener("click", (event) => {
  const anchor = event.target.closest("a[data-link]");
  if (!anchor || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  event.preventDefault();
  navigate(anchor.getAttribute("href"));
});
window.addEventListener("popstate", () => render());
document.addEventListener("keydown", (event) => {
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); openPalette(); }
});
$("#open-nav").onclick = () => { const open = document.body.classList.toggle("nav-open"); $("#open-nav").setAttribute("aria-expanded", String(open)); };
$("#open-palette-mobile").onclick = openPalette;
$("#scrim").onclick = () => { document.body.classList.remove("nav-open"); $("#open-nav").setAttribute("aria-expanded", "false"); };

refreshShell().then(() => render({ keepScroll: true }));
