import { api, doc, ws } from "../lib/api.js";
import { diffStats } from "../lib/diff.js";
import { ago, plural, score, versionLabel, versionTitle, wordCount } from "../lib/format.js";
import { marginHtml } from "../lib/margin.js";
import { markdownToHtml } from "../lib/markdown.js";
import { $, $$, confirmAction, debounce, e, storage, toast } from "../lib/ui.js";
import { changesHtml } from "./document.js";

const isMac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const mod = isMac ? "⌘" : "Ctrl";

export async function mount(ctx) {
  const { root, params, navigate, setTitle } = ctx;
  const workspaceId = params.workspace;
  let detail = null;
  let base = null;          // the draft this one revises (full detail), or null for a fresh draft
  let mode = storage.get("jev-editor-mode", "write");
  let busy = null;          // "saving" | "scoring"
  let restoredAt = null;
  let lastSaved = null;
  const href = (path = "") => `/w/${encodeURIComponent(workspaceId)}${path}`;
  const draftKey = () => `jev-draft:${workspaceId}:${base?.id || "new"}`;

  async function loadDetail() { detail = await api(ws(workspaceId)); }
  await loadDetail();
  if (params.document) base = await api(doc(workspaceId, params.document));

  const saved = storage.get(draftKey());
  const initial = saved && saved.content !== (base?.content ?? "") ? saved : null;
  if (initial) restoredAt = initial.at;
  const state = { content: initial?.content ?? base?.content ?? "", title: initial?.title ?? "", summary: initial?.summary ?? "" };

  const dirty = () => state.content !== (base?.content ?? "") || state.title || state.summary;
  const persist = debounce(() => {
    if (dirty()) storage.set(draftKey(), { ...state, at: new Date().toISOString() });
    else storage.remove(draftKey());
    renderStatus();
  }, 350);

  // ------------------------------------------------------------------ layout

  function renderShell() {
    const { workspace } = detail;
    setTitle(base ? `Revising ${versionLabel(base)}` : `New draft · ${workspace.name}`);
    root.innerHTML = `<section class="editor-page">
      <div class="editor-top">
        <nav class="crumbs" aria-label="Breadcrumb"><a href="${href()}" data-link>← ${e(workspace.name)}</a><span aria-hidden="true">/</span>
          <label class="visually-hidden" for="start-from">Start from</label>
          <select id="start-from" style="width:auto;height:30px;padding-top:0;padding-bottom:0;font-size:13px">
            <option value="">Blank page</option>
            ${[...detail.documents].reverse().map((document) => `<option value="${e(document.id)}" ${base?.id === document.id ? "selected" : ""}>Revise ${e(versionTitle(document))}</option>`).join("")}
          </select>
        </nav>
        <span class="save-state" id="save-state"></span>
      </div>
      <div id="restore-slot"></div>
      <div class="editor-grid">
        <div>
          <div class="editor-meta">
            <input class="title-input" id="title" placeholder="${e(base ? `Revision of ${base.title}` : detail.documents.length ? "Untitled draft" : "Original")}" value="${e(state.title)}" aria-label="Draft title" maxlength="200">
            <input class="summary-input" id="summary" placeholder="${base ? "What are you changing? For example: Lead with outcomes and cut the objective" : "A note about this draft (optional)"}" value="${e(state.summary)}" aria-label="What changed">
          </div>
          <div class="editor-bar" role="toolbar" aria-label="Formatting">
            <button class="tool" data-wrap="**" title="Bold (${mod} B)" aria-label="Bold">B</button>
            <button class="tool i" data-wrap="*" title="Italic (${mod} I)" aria-label="Italic">i</button>
            <span class="sep"></span>
            <button class="tool" data-prefix="## " title="Heading" aria-label="Heading">H</button>
            <button class="tool" data-prefix="- " title="Bulleted list" aria-label="Bulleted list">•</button>
            <button class="tool" data-prefix="1. " title="Numbered list" aria-label="Numbered list">1.</button>
            <button class="tool" data-prefix="> " title="Quote" aria-label="Quote">“</button>
            <button class="tool" data-insert-link title="Link" aria-label="Link">↗</button>
            <div class="seg" role="group" aria-label="View"><button data-view="write" aria-pressed="${mode === "write"}">Write</button><button data-view="preview" aria-pressed="${mode === "preview"}">Preview</button>${base ? `<button data-view="changes" aria-pressed="${mode === "changes"}">Changes</button>` : ""}</div>
          </div>
          <div class="sheet">
            <textarea class="writing" id="writing" spellcheck="true" aria-label="Draft text" placeholder="${e(base ? "" : `Write or paste the draft for ${detail.workspace.contextTitle.toLowerCase()}…`)}" ${mode === "write" ? "" : "hidden"}></textarea>
            <div id="pane" ${mode === "write" ? "hidden" : ""}></div>
          </div>
        </div>
        <div id="margin"></div>
      </div>
      <div class="editor-status" id="status"></div>
    </section>`;
    const textarea = $("#writing", root);
    textarea.value = state.content;
    autosize();
    renderRestore();
    renderPane();
    renderMargin();
    renderStatus();
    wire();
  }

  function renderRestore() {
    $("#restore-slot", root).innerHTML = restoredAt ? `<div class="restore"><span>Restored unsaved changes from ${e(ago(restoredAt))}. They were kept in this browser.</span><button class="btn small quiet" id="discard-restore">Discard them</button></div>` : "";
    const discard = $("#discard-restore", root);
    if (discard) discard.onclick = () => { restoredAt = null; resetTo(base); };
  }

  function renderPane() {
    const pane = $("#pane", root);
    if (mode === "preview") pane.innerHTML = `<div class="preview"><div class="manuscript">${state.content.trim() ? markdownToHtml(state.content) : `<p class="faint">Nothing to preview yet.</p>`}</div></div>`;
    else if (mode === "changes" && base) pane.innerHTML = `<div class="changes">${changesHtml(base.content, state.content, { expanded: true })}</div>`;
    else pane.innerHTML = "";
  }

  function renderMargin() {
    const matrix = detail.matrix;
    const rows = new Map((matrix?.rows || []).map((row) => [row.id, row]));
    const current = base ? rows.get(base.id) : null;
    const baseline = current && base?.parentDocumentId ? rows.get(base.parentDocumentId) : null;
    const best = matrix?.rows.find((row) => row.isBest && row.id !== base?.id);
    $("#margin", root).innerHTML = marginHtml({
      title: base ? (lastSaved?.id === base.id ? "Your new draft" : "Aim here") : "Margin notes",
      subtitle: base ? `${versionLabel(base)} · ${matrix?.group.name || ""}` : "",
      questions: matrix?.questions || [],
      current: current?.evaluated ? current : null,
      baseline: current?.evaluated ? baseline : null,
      baselineLabel: baseline ? `parent ${versionLabel(baseline)}` : "",
      best: current?.evaluated ? best : null,
      empty: !matrix ? "" : base ? (busy === "scoring" ? `<span class="row"><span class="spinner"></span>Scoring ${e(versionLabel(base))}…</span>` : `${e(versionLabel(base))} has no scores yet. Save and score to see where it stands.`) : "Save and score your draft to see a score for every question here.",
    });
  }

  function renderStatus() {
    const words = wordCount(state.content);
    const stats = base ? diffStats(base.content, state.content) : null;
    const status = $("#status", root);
    if (!status) return;
    const changed = base ? state.content !== base.content : Boolean(state.content.trim());
    status.innerHTML = `<div class="counts"><span>${plural(words, "word")}</span><span>${Math.max(1, Math.round(words / 230))} min read</span>${stats ? `<span title="Lines changed from ${e(versionLabel(base))}"><span class="add">+${stats.added}</span> <span class="del">−${stats.removed}</span> lines vs ${e(versionLabel(base))}</span>` : ""}</div>
      <div class="actions">
        ${changed ? `<button class="btn quiet" id="discard">Discard changes</button>` : ""}
        <button class="btn" id="save" ${busy || !changed ? "disabled" : ""} title="${mod} S">${busy === "saving" ? `<span class="spinner"></span>` : ""}Save draft</button>
        <button class="btn accent" id="save-score" ${busy || !changed || !detail.matrix ? "disabled" : ""} title="${mod} Enter">${busy === "scoring" ? `<span class="spinner"></span>Scoring…` : `Save &amp; score <span class="kbd" style="background:transparent;color:inherit;border-color:rgb(255 255 255 / .45)">${mod}↵</span>`}</button>
      </div>`;
    $("#save-state", root).innerHTML = busy === "saving" ? "Saving…" : busy === "scoring" ? `<span class="pulse"></span>Scoring ${e(versionLabel(base))}` : lastSaved && !dirty() ? `Saved as ${e(versionTitle(lastSaved))}` : dirty() ? "Unsaved changes are kept in this browser" : "";
    const on = (selector, handler) => { const element = $(selector, status); if (element) element.onclick = handler; };
    on("#save", () => save(false));
    on("#save-score", () => save(true));
    on("#discard", async () => {
      if (await confirmAction({ title: "Discard changes?", message: base ? `Go back to the text of ${e(versionTitle(base))}.` : "Clear the page.", confirmLabel: "Discard" })) resetTo(base);
    });
  }

  function autosize() {
    const textarea = $("#writing", root);
    if (!textarea || textarea.hidden) return;
    const scroll = window.scrollY;
    textarea.style.height = "auto";
    textarea.style.height = `${textarea.scrollHeight + 2}px`;
    window.scrollTo(0, scroll);
  }

  function resetTo(document) {
    storage.remove(draftKey());
    state.content = document?.content ?? "";
    state.title = ""; state.summary = "";
    restoredAt = null;
    renderShell();
  }

  // ------------------------------------------------------------------ editing

  function edit(transform) {
    const textarea = $("#writing", root);
    if (textarea.hidden) return;
    const { selectionStart: start, selectionEnd: end, value } = textarea;
    const { text, from, to, selectFrom, selectTo } = transform(value, start, end);
    textarea.focus();
    textarea.setSelectionRange(from, to);
    // insertText keeps the browser's undo history; fall back when unsupported.
    if (!document.execCommand?.("insertText", false, text)) textarea.setRangeText(text, from, to, "end");
    textarea.setSelectionRange(selectFrom, selectTo);
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  }

  const wrap = (marker) => edit((value, start, end) => {
    const selected = value.slice(start, end) || "text";
    return { text: `${marker}${selected}${marker}`, from: start, to: end, selectFrom: start + marker.length, selectTo: start + marker.length + selected.length };
  });

  const prefix = (marker) => edit((value, start, end) => {
    const lineStart = value.lastIndexOf("\n", start - 1) + 1;
    const lineEnd = value.indexOf("\n", end) === -1 ? value.length : value.indexOf("\n", end);
    const lines = value.slice(lineStart, lineEnd).split("\n");
    const all = lines.every((line) => line.startsWith(marker));
    const text = lines.map((line) => all ? line.slice(marker.length) : `${marker}${line.replace(/^(#{1,6} |- |\d+\. |> )/, "")}`).join("\n");
    return { text, from: lineStart, to: lineEnd, selectFrom: lineStart, selectTo: lineStart + text.length };
  });

  const link = () => edit((value, start, end) => {
    const label = value.slice(start, end) || "link text";
    const text = `[${label}](https://)`;
    return { text, from: start, to: end, selectFrom: start + label.length + 3, selectTo: start + text.length - 1 };
  });

  // Re-renders the editor chrome while keeping the text, focus, and selection.
  function rerender() {
    const active = document.activeElement?.id;
    const textarea = $("#writing", root);
    const selection = textarea ? [textarea.selectionStart, textarea.selectionEnd] : null;
    const scroll = window.scrollY;
    renderShell();
    const target = active && $(`#${active}`, root);
    if (target) {
      target.focus({ preventScroll: true });
      if (active === "writing" && selection) target.setSelectionRange(...selection);
    }
    window.scrollTo(0, scroll);
  }

  async function save(andScore) {
    if (busy) return;
    const snapshot = { ...state };
    const content = snapshot.content;
    if (!content.trim()) { toast("Write something first."); return; }
    if (base && content === base.content) { toast(`No changes from ${versionLabel(base)} yet.`); return; }
    if (andScore && !detail.matrix) { toast("This workspace has no evaluation group yet, so the draft is saved without a score."); andScore = false; }
    busy = "saving";
    renderStatus();
    const previous = base;
    try {
      const savedDraft = await api(`${ws(workspaceId)}/documents`, { method: "POST", body: {
        content,
        title: snapshot.title.trim() || (previous ? `Revision of ${previous.title}` : detail.documents.length ? "Untitled draft" : "Original"),
        changeSummary: snapshot.summary.trim(),
        parentDocument: previous?.id || null,
        original: !detail.documents.length,
      } });
      if (savedDraft.deduplicated) {
        toast(`This text matches ${versionTitle(savedDraft)}, so nothing new was saved.`, { action: { label: "Open it", onClick: () => navigate(href(`/d/${encodeURIComponent(savedDraft.id)}`)) } });
        return;
      }
      storage.remove(draftKey());
      lastSaved = savedDraft;
      base = await api(doc(workspaceId, savedDraft.id));
      // Anything typed while saving becomes the start of the next draft.
      if (state.title === snapshot.title) state.title = "";
      if (state.summary === snapshot.summary) state.summary = "";
      restoredAt = null;
      await loadDetail();
      if (!ctx.isCurrent()) return;
      history.replaceState({}, "", href(`/edit/${encodeURIComponent(base.id)}`));
      if (state.content !== base.content) persist();
      if (!andScore) {
        busy = null;
        rerender();
        toast(`Saved ${versionTitle(savedDraft)}. Keep editing to write the next draft.`);
        return;
      }
      busy = "scoring";
      rerender();
      const result = await api(`${doc(workspaceId, savedDraft.id)}/evaluate`, { method: "POST", body: { group: detail.matrix.group.id, runs: 1 } });
      const pieces = [`${versionLabel(savedDraft)} scored ${score(result.overallScore)}`];
      if (result.vsParent != null) pieces.push(`${result.vsParent >= 0 ? "+" : "−"}${Math.abs(result.vsParent).toFixed(1)} vs ${versionLabel(previous)}`);
      if (result.isBest) pieces.push("new best");
      toast(pieces.join(" · "));
    } catch (error) {
      toast(error.message, { error: true });
    } finally {
      busy = null;
      if (ctx.isCurrent()) { await loadDetail().catch(() => {}); if (ctx.isCurrent()) { renderMargin(); renderStatus(); } }
    }
  }

  function wire() {
    const textarea = $("#writing", root);
    textarea.addEventListener("input", () => { state.content = textarea.value; autosize(); persist(); renderStatus(); });
    $("#title", root).addEventListener("input", (event) => { state.title = event.target.value; persist(); });
    $("#summary", root).addEventListener("input", (event) => { state.summary = event.target.value; persist(); });
    $$("[data-wrap]", root).forEach((button) => button.onclick = () => wrap(button.dataset.wrap));
    $$("[data-prefix]", root).forEach((button) => button.onclick = () => prefix(button.dataset.prefix));
    $("[data-insert-link]", root).onclick = link;
    $$("[data-view]", root).forEach((button) => button.onclick = () => {
      mode = button.dataset.view;
      storage.set("jev-editor-mode", mode);
      $$("[data-view]", root).forEach((item) => item.setAttribute("aria-pressed", String(item === button)));
      textarea.hidden = mode !== "write";
      $("#pane", root).hidden = mode === "write";
      $$(".tool", root).forEach((tool) => { tool.disabled = mode !== "write"; });
      renderPane();
      if (mode === "write") { autosize(); textarea.focus(); }
    });
    $$(".tool", root).forEach((tool) => { tool.disabled = mode !== "write"; });
    $("#start-from", root).onchange = async (event) => {
      if (dirty() && !(await confirmAction({ title: "Switch drafts?", message: "Your unsaved changes stay in this browser and come back when you return to this draft.", confirmLabel: "Switch" }))) { event.target.value = base?.id || ""; return; }
      navigate(href(`/edit${event.target.value ? `/${encodeURIComponent(event.target.value)}` : ""}`), { replace: true });
    };
  }

  function onKey(event) {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === "s") { event.preventDefault(); save(false); }
    else if (key === "enter") { event.preventDefault(); save(true); }
    else if (key === "b" && document.activeElement?.id === "writing") { event.preventDefault(); wrap("**"); }
    else if (key === "i" && document.activeElement?.id === "writing") { event.preventDefault(); wrap("*"); }
  }
  document.addEventListener("keydown", onKey);
  window.addEventListener("resize", autosize);
  document.body.classList.add("has-status");

  renderShell();
  if (!base) setTimeout(() => $("#writing", root)?.focus(), 50);

  return {
    documents: detail.documents,
    refreshWhileTyping: true,
    // Live updates refresh the margin and counts but never touch the text.
    async refresh() {
      if (busy) return;
      await loadDetail();
      if (!ctx.isCurrent()) return;
      renderMargin();
      renderStatus();
    },
    unmount() {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", autosize);
      document.body.classList.remove("has-status");
    },
    paletteItems: () => [
      { label: "Save draft", kind: `${mod} S`, run: () => save(false) },
      { label: "Save and score", kind: `${mod} Enter`, run: () => save(true) },
    ],
  };
}
