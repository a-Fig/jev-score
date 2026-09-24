import { api } from "../lib/api.js";
import { count, date, money } from "../lib/format.js";
import { $, $$, copyText, e, toast } from "../lib/ui.js";
import { importDialog } from "./dialogs.js";

const snippets = {
  claudeCode: "claude mcp add --scope user -e OPENROUTER_API_KEY=your_key jev-score -- jev-score mcp",
  claudeDesktop: JSON.stringify({ mcpServers: { "jev-score": { command: "jev-score", args: ["mcp"], env: { OPENROUTER_API_KEY: "your_key" } } } }, null, 2),
  codex: `[mcp_servers.jev-score]\ncommand = "jev-score"\nargs = ["mcp"]\nenv = { OPENROUTER_API_KEY = "your_key" }`,
};

export async function mount(ctx) {
  const { root, navigate, setTitle } = ctx;
  setTitle("Settings");
  let settings, usage, check = null, checking = false;

  async function load() { [settings, usage] = await Promise.all([api("/api/settings"), api("/api/usage")]); }

  function spendCard() {
    const spend = settings.spend;
    const percent = spend.limit ? Math.min(100, (spend.spent / spend.limit) * 100) : 0;
    return `<article class="card card-pad">
      <div class="card-head"><div><h2>Spend limit</h2><p>Stops scoring once recorded Jev spend reaches the limit, so an unattended agent can't run up a bill. Applies to the CLI, the MCP server, and this app.</p></div></div>
      <div class="row" style="align-items:baseline;gap:8px"><span class="big-figure">${money(spend.spent)}</span><span class="muted">${spend.limit != null ? `of ${money(spend.limit)}` : "recorded"}${spend.since ? ` since ${e(date(spend.since))}` : ""}</span></div>
      ${spend.limit != null ? `<div class="meter ${percent < 80 ? "ok" : ""}" role="meter" aria-valuemin="0" aria-valuemax="${spend.limit}" aria-valuenow="${spend.spent}" aria-label="Spend against limit"><span style="width:${percent.toFixed(1)}%"></span></div><p class="faint" style="font-size:12.5px">${spend.exceeded ? `<strong style="color:var(--bad)">Limit reached.</strong> Scoring is paused until you raise the limit or reset the counter.` : `${money(spend.remaining)} left.`}</p>` : ""}
      ${spend.source === "env" ? `<p class="notice" style="margin:14px 0 0">The limit comes from the <code>JEV_SCORE_SPEND_LIMIT</code> environment variable, which overrides this setting.</p>` : `<form class="row" id="limit-form" style="margin-top:16px;align-items:flex-end">
        <label class="field" style="flex:1;min-width:160px">Limit in US dollars<input type="number" name="limit" min="0" step="0.5" inputmode="decimal" value="${spend.limit ?? ""}" placeholder="No limit"></label>
        <button class="btn primary" type="submit">Save limit</button>${spend.limit != null ? `<button class="btn quiet" type="button" id="remove-limit">Remove</button>` : ""}
      </form>`}
      <div class="row" style="margin-top:12px"><button class="btn small quiet" id="reset-spend">Reset the counter to zero</button><span class="faint" style="font-size:12.5px">Counts runs from now on. Your usage history stays.</span></div>
    </article>`;
  }

  function connectionCard() {
    const key = settings.apiKey;
    return `<article class="card card-pad">
      <div class="card-head"><div><h2>Jev connection</h2><p>Scores come from TypeSafe's Jev model through OpenRouter.</p></div></div>
      <dl class="kv">
        <dt>API key</dt><dd>${key.present ? "Set" : `<strong style="color:var(--bad)">Not set.</strong> Add <code>OPENROUTER_API_KEY</code> to <code>.env.local</code> where you run <code>jev-score</code>, then restart the app.`}</dd>
        <dt>Model</dt><dd class="mono" style="font-size:12.5px">${e(key.model)}</dd>
        <dt>Version</dt><dd>Jev Score ${e(settings.version)} on Node ${e(settings.node)}</dd>
        ${check ? `<dt>Check</dt><dd>${check.ok ? `<span class="delta good">Key accepted</span>${check.label ? ` (${e(check.label)})` : ""}${check.limitRemaining != null ? ` · ${money(Number(check.limitRemaining))} left on the key` : ""}` : `<span class="delta bad">${e(check.reason || "Check failed")}</span>`}</dd>` : ""}
      </dl>
      <div class="row" style="margin-top:16px"><button class="btn" id="check" ${!key.present || checking ? "disabled" : ""}>${checking ? `<span class="spinner"></span>Checking…` : "Check the key"}</button><span class="faint" style="font-size:12.5px">Free. It doesn't run a Jev evaluation.</span></div>
    </article>`;
  }

  function usageCard() {
    const total = usage.total;
    const rows = usage.workspaces.map((item) => `<tr><td><a href="/w/${encodeURIComponent(item.id)}" data-link>${e(item.name)}</a></td><td class="num">${count(item.runs)}</td><td class="num">${count(item.totalTokens)}</td><td class="num strong">${money(item.cost)}</td></tr>`).join("");
    const models = usage.models.map((item) => `<tr><td><span class="mono" style="font-size:12.5px">${e(item.model)}</span> <span class="faint">${e(item.provider)}</span></td><td class="num">${count(item.runs)}</td><td class="num">${count(item.totalTokens)}</td><td class="num strong">${money(item.cost)}</td></tr>`).join("");
    return `<article class="card span" style="overflow:hidden">
      <div class="card-pad" style="padding-bottom:6px"><div class="card-head"><div><h2>Usage</h2><p>${total.runs ? `${count(total.reportedRuns)} of ${count(total.runs)} stored runs reported usage. Lifetime spend, including deleted workspaces: ${money(usage.lifetime.cost)}.` : "Usage appears after the first Jev evaluation."}</p></div></div>
      <div class="stats" style="margin-bottom:6px"><div class="stat"><span class="label">Reported cost</span><span class="value"><strong>${money(total.cost)}</strong></span></div><div class="stat"><span class="label">Evaluation runs</span><span class="value"><strong>${count(total.runs)}</strong></span></div><div class="stat"><span class="label">Input tokens</span><span class="value"><strong>${count(total.inputTokens)}</strong></span></div><div class="stat"><span class="label">Output tokens</span><span class="value"><strong>${count(total.outputTokens)}</strong></span></div></div></div>
      ${rows ? `<div class="table-scroll"><table class="table"><thead><tr><th>Workspace</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${rows}</tbody></table></div>` : ""}
      ${models ? `<div class="table-scroll" style="border-top:1px solid var(--rule)"><table class="table"><thead><tr><th>Model</th><th class="num">Runs</th><th class="num">Tokens</th><th class="num">Cost</th></tr></thead><tbody>${models}</tbody></table></div>` : ""}
    </article>`;
  }

  function agentsCard() {
    const block = (id, label, text) => `<div class="field">${e(label)}<div class="snippet"><pre>${e(text)}</pre><button class="btn small" data-copy="${id}">Copy</button></div></div>`;
    return `<article class="card card-pad span">
      <div class="card-head"><div><h2>Connect an agent</h2><p>Claude Code and Codex can use the CLI directly: point them at <code>jev-score --help</code> or the skill in <code>.agents/skills/jev-score</code>. The MCP server adds Jev Score as tools, which also works in Claude Desktop. Whatever the agent scores shows up here live.</p></div></div>
      <div class="stack">
        ${block("claudeCode", "Claude Code", snippets.claudeCode)}
        ${block("claudeDesktop", "Claude Desktop (claude_desktop_config.json)", snippets.claudeDesktop)}
        ${block("codex", "Codex (~/.codex/config.toml)", snippets.codex)}
      </div>
    </article>`;
  }

  function dataCard() {
    return `<article class="card card-pad span">
      <div class="card-head"><div><h2>Your data</h2><p>Everything stays in one local SQLite file. Only a draft, its context, and the questions are sent to OpenRouter, and only when a draft is scored.</p></div></div>
      <dl class="kv"><dt>Database</dt><dd class="mono" style="font-size:12.5px">${e(settings.database || "In memory")}</dd></dl>
      <div class="row" style="margin-top:16px"><button class="btn" id="import">Import a workspace</button><span class="faint" style="font-size:12.5px">Export one from its ⋯ menu to back it up or move it to another computer.</span></div>
    </article>`;
  }

  function render() {
    root.innerHTML = `<section class="page">
      <div class="page-head"><div><p class="eyebrow">This computer</p><h1>Settings &amp; usage</h1></div></div>
      <div class="settings-grid">${spendCard()}${connectionCard()}${usageCard()}${agentsCard()}${dataCard()}</div>
    </section>`;
    wire();
  }

  function wire() {
    const form = $("#limit-form", root);
    if (form) form.onsubmit = async (event) => {
      event.preventDefault();
      const value = new FormData(form).get("limit");
      const result = await api("/api/settings", { method: "PATCH", body: { spendLimit: value === "" ? null : Number(value) } }).catch((error) => { toast(error.message, { error: true }); return null; });
      if (result) { toast(result.spend.limit == null ? "Spend limit removed" : `Spend limit set to ${money(result.spend.limit)}`); await refresh(); }
    };
    const remove = $("#remove-limit", root);
    if (remove) remove.onclick = async () => { await api("/api/settings", { method: "PATCH", body: { spendLimit: null } }); toast("Spend limit removed"); await refresh(); };
    $("#reset-spend", root).onclick = async () => { await api("/api/settings/spend-reset", { method: "POST" }); toast("Spend counter reset"); await refresh(); };
    $("#check", root).onclick = async () => {
      checking = true; render();
      try { check = await api("/api/settings/check"); } catch (error) { check = { ok: false, reason: error.message }; }
      checking = false; render();
    };
    $("#import", root).onclick = () => importDialog(navigate);
    $$("[data-copy]", root).forEach((button) => button.onclick = async () => { await copyText(snippets[button.dataset.copy]); toast("Copied"); });
  }

  async function refresh() { await load(); if (ctx.isCurrent()) render(); }

  await load();
  render();
  return { refresh };
}
