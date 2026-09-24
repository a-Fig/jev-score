import { escapeHtml, signed } from "./format.js";

export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
export const e = escapeHtml;

// ------------------------------------------------------------------ toasts

export function toast(message, { error = false, action = null, duration = error ? 7000 : 4200 } = {}) {
  const host = $("#toasts");
  const item = document.createElement("div");
  item.className = `toast${error ? " error" : ""}`;
  item.setAttribute("role", error ? "alert" : "status");
  const text = document.createElement("span");
  text.textContent = message;
  item.append(text);
  if (action) {
    const button = document.createElement("button");
    button.textContent = action.label;
    button.onclick = () => { action.onClick(); dismiss(); };
    item.append(button);
  }
  host.append(item);
  const dismiss = () => { item.classList.add("leaving"); setTimeout(() => item.remove(), 200); };
  setTimeout(dismiss, duration);
  while (host.children.length > 3) host.firstElementChild.remove();
}

// ------------------------------------------------------------------ dialogs

let activeResolve = null;
let modalToken = 0;

// Opens the shared modal. `body` is trusted HTML built with escaped values.
// Resolves with the clicked action's value (or the submit handler's result),
// or null when dismissed.
export function modal({ title, subtitle = "", body = "", actions = [], wide = false, onMount = null, onSubmit = null }) {
  const dialog = $("#modal");
  if (dialog.open) { activeResolve?.(null); dialog.close(); }
  dialog.classList.toggle("wide", wide);
  dialog.innerHTML = `<form class="modal" method="dialog" novalidate>
    <header><div><h2 id="modal-title">${e(title)}</h2>${subtitle ? `<p>${subtitle}</p>` : ""}</div><button type="button" class="btn icon quiet" data-dismiss aria-label="Close">✕</button></header>
    ${body ? `<div class="body">${body}</div>` : ""}
    ${actions.length ? `<footer>${actions.map((action, index) => action === "spacer" ? `<span class="spacer"></span>` : `<button type="${action.submit ? "submit" : "button"}" class="btn ${action.kind || ""}" data-action="${index}" ${action.disabled ? "disabled" : ""}>${e(action.label)}</button>`).join("")}</footer>` : ""}
  </form>`;
  const token = ++modalToken;
  return new Promise((resolve) => {
    activeResolve = resolve;
    let settled = false;
    const finish = (value) => { if (settled) return; settled = true; activeResolve = null; if (dialog.open) dialog.close(); resolve(value); };
    const form = $("form", dialog);
    $$("[data-dismiss]", dialog).forEach((button) => button.onclick = () => finish(null));
    $$("[data-action]", dialog).forEach((button) => {
      const action = actions[Number(button.dataset.action)];
      if (action.submit) return;
      button.onclick = async () => {
        if (action.onClick) {
          const result = await action.onClick(dialog);
          if (result === false) return;
          finish(result ?? action.value ?? true);
        } else finish(action.value ?? null);
      };
    });
    form.onsubmit = async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;
      const submit = $("button[type=submit]", form);
      if (!onSubmit) return finish(true);
      submit.disabled = true;
      const label = submit.innerHTML;
      submit.innerHTML = `<span class="spinner"></span>${label}`;
      try {
        const result = await onSubmit(new FormData(form), dialog);
        if (result !== false) finish(result ?? true);
      } catch (error) {
        toast(error.message, { error: true });
      } finally {
        if (submit.isConnected) { submit.disabled = false; submit.innerHTML = label; }
      }
    };
    // A close event queued by the previous modal must not close this one.
    dialog.onclose = () => { if (token === modalToken && !dialog.open) finish(null); };
    // Close on a backdrop click only; a text selection dragged out of a field must not.
    let pressedBackdrop = false;
    dialog.onpointerdown = (event) => { pressedBackdrop = event.target === dialog; };
    dialog.onclick = (event) => { if (event.target === dialog && pressedBackdrop) finish(null); pressedBackdrop = false; };
    dialog.showModal();
    onMount?.(dialog);
    const focusTarget = $("[autofocus]", dialog) || $("input:not([type=hidden]), textarea, select", dialog) || $("footer .btn:last-child", dialog);
    focusTarget?.focus();
  });
}

export async function confirmAction({ title, message, confirmLabel = "Confirm", danger = false }) {
  const result = await modal({ title, body: `<p class="muted">${message}</p>`, actions: [{ label: "Cancel", kind: "quiet", value: false }, { label: confirmLabel, kind: danger ? "accent" : "primary", value: true }] });
  return result === true;
}

export async function promptText({ title, label, value = "", confirmLabel = "Save", multiline = false, hint = "", allowEmpty = false }) {
  const required = allowEmpty ? "" : "required";
  const field = multiline ? `<textarea name="value" rows="10" ${required}>${e(value)}</textarea>` : `<input name="value" value="${e(value)}" ${required} autofocus>`;
  const result = await modal({
    title,
    body: `<label class="field">${e(label)}${hint ? ` <span class="hint">${e(hint)}</span>` : ""}${field}</label>`,
    actions: [{ label: "Cancel", kind: "quiet", value: null }, { label: confirmLabel, kind: "primary", submit: true }],
    onSubmit: (form) => { const text = String(form.get("value")).trim(); return allowEmpty ? text : text || false; },
  });
  return typeof result === "string" ? result : null;
}

// ------------------------------------------------------------------ menus

export function closeMenus(except = null) {
  $$("details.menu[open]").forEach((menu) => { if (menu !== except) menu.removeAttribute("open"); });
}

document.addEventListener("click", (event) => {
  const menu = event.target.closest("details.menu");
  closeMenus(menu);
  if (menu && event.target.closest(".menu-list button, .menu-list a")) menu.removeAttribute("open");
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") closeMenus();
});

// ------------------------------------------------------------------ bits

export function deltaHtml(value, { suffix = "" } = {}) {
  if (value == null) return `<span class="delta flat">—</span>`;
  const tone = value > 0 ? "good" : value < 0 ? "bad" : "flat";
  const arrow = value > 0 ? "▲" : value < 0 ? "▼" : "";
  return `<span class="delta ${tone}"><span aria-hidden="true">${arrow}</span>${signed(value)}${suffix}</span>`;
}

export const dirHtml = (direction, long = false) => direction === "lower"
  ? `<span class="dir lower" title="Lower is better">↓${long ? " lower is better" : " lower"}</span>`
  : `<span class="dir" title="Higher is better">↑${long ? " higher is better" : " higher"}</span>`;

export async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    const area = document.createElement("textarea");
    area.value = text; document.body.append(area); area.select();
    const ok = document.execCommand("copy"); area.remove(); return ok;
  }
}

export function download(url) {
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = ""; document.body.append(anchor); anchor.click(); anchor.remove();
}

// A red-pen circle around a weak score. The wobble is seeded by the text so
// each circle looks hand-drawn but stays the same between renders.
export function penCircle(seedText = "") {
  let seed = [...String(seedText)].reduce((sum, character) => (sum * 31 + character.charCodeAt(0)) >>> 0, 7);
  const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const points = [];
  const steps = 26;
  for (let index = 0; index <= steps + 3; index += 1) {
    const angle = (index / steps) * Math.PI * 2 - 2.2;
    const wobble = 1 + (random() - .5) * .12;
    points.push([50 + Math.cos(angle) * 47 * wobble, 21 + Math.sin(angle) * 17 * wobble]);
  }
  const path = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  return `<svg viewBox="0 0 100 42" preserveAspectRatio="none" aria-hidden="true"><path d="${path}" vector-effect="non-scaling-stroke"/></svg>`;
}

const svg = (body) => `<svg class="icon-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
export const icons = {
  search: svg(`<circle cx="11" cy="11" r="6.5"/><path d="M20 20l-4.2-4.2"/>`),
  menu: svg(`<path d="M4 7h16M4 12h16M4 17h16"/>`),
  system: svg(`<circle cx="12" cy="12" r="8"/><path d="M12 4a8 8 0 0 1 0 16z" fill="currentColor" stroke="none"/>`),
  light: svg(`<circle cx="12" cy="12" r="4"/><path d="M12 2.5v2.2M12 19.3v2.2M4.6 4.6l1.6 1.6M17.8 17.8l1.6 1.6M2.5 12h2.2M19.3 12h2.2M4.6 19.4l1.6-1.6M17.8 6.2l1.6-1.6"/>`),
  dark: svg(`<path d="M19.5 14.5A8 8 0 0 1 9.5 4.5a8 8 0 1 0 10 10z"/>`),
};

export function debounce(fn, wait) {
  let timer = null;
  return (...args) => { clearTimeout(timer); timer = setTimeout(() => fn(...args), wait); };
}

export const storage = {
  get(key, fallback = null) { try { const value = localStorage.getItem(key); return value == null ? fallback : JSON.parse(value); } catch { return fallback; } },
  set(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} },
  remove(key) { try { localStorage.removeItem(key); } catch {} },
};
