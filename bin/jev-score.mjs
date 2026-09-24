#!/usr/bin/env node

import { accessSync, constants, existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { databaseIdentity, databasePath, loadEnv } from "../src/config.mjs";
import { SCHEMA_VERSION, inTransaction, openDatabase } from "../src/db.mjs";
import { DEFAULT_MODEL, checkOpenRouterKey } from "../src/jev.mjs";
import { runMcpServer } from "../src/mcp.mjs";
import { renderReport } from "../src/report.mjs";
import { startServer } from "../src/server.mjs";
import {
  addDocument, attachGroup, contextHistory, createGroup, createWorkspace, deleteDocument, deleteGroup, deleteWorkspace,
  detachGroup, documentDetail, exportWorkspace, forkGroup, importWorkspace, listDocuments, listGroups, listWorkspaces,
  matrixCsv, ranking, resetSpendCounter, resolveGroup, scoreDocument, setSpendLimit, spendStatus, updateDocument,
  updateGroup, updateWorkspace, usageSummary, workspaceDetail, workspaceSummary,
} from "../src/service.mjs";
import { TEMPLATES, findTemplate } from "../src/templates.mjs";
import { delta, one, palette, plural, table } from "../src/terminal.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const BOOLEAN_FLAGS = ["yes", "original", "json", "human", "offline", "no-open"];

function help() {
  process.stdout.write(`Jev Score ${version}: score drafts against context with Jev, locally.

Workspaces
  workspace create --name <name> --context <file> [--context-title <title>] [--group <group> | --template <id>]
  workspace list | show <ws> | rename <ws> <name> | delete <ws> --yes
  workspace context <ws> --file <file> [--title <title>]   Replace the context (older runs become stale)
  workspace contexts <ws>                                  Context history
  workspace primary <ws> <group> | mode <ws> <max|median>
  workspace export <ws> [--format json|csv] [--out <file>]
  workspace import <file> [--name <name>]

Evaluation groups
  group templates                                          Starter question sets
  group create --template <id> [--name <name>]
  group create --name <name> --questions <file> [--description <text>] [--scorer <file.mjs>]
  group list | show <group> | rename <group> <name> | delete <group> --yes
  group update <group> [--name <name>] [--description <text>] [--questions <file>]
  group fork <group> [--name <name>]                       Copy a locked group to change its questions
  group attach <ws> <group> | detach <ws> <group>

Drafts
  document add <ws> <file> [--title <title>] [--summary <text>] [--parent <doc>] [--original]
  document list <ws> | get <ws> <doc> [--out <file>] | delete <ws> <doc> --yes
  document update <ws> <doc> [--title <title>] [--summary <text>] [--original]

Scoring
  score <ws> <doc-or-file> [--runs <1-10>] [--title <title>] [--summary <text>] [--parent <doc>] [--group <group>] [--note <text>]
  rank <ws> [--group <group>] [--question <key>] [--mode <max|median>]
  report <ws> [--format html|md] [--out <file>] [--group <group>] [--mode <max|median>]

App
  ui [--port <port>]              Start the app and open it in your browser
  serve [--port <port>]           Run the app without opening a browser
  mcp                             Run the MCP server on stdio for Claude Desktop, Claude Code, or Codex
  doctor [--offline]              Check Node, the database, your key, and OpenRouter
  usage                           Jev tokens and costs recorded locally
  config show | spend-limit <usd|off> | reset-spend
  db path | reset --yes

A draft reference is its ID, title, or version ("#3"). Names or IDs work for workspaces and groups.
Question files are a JSON array or one question per line; prefix a line with [lower] when a lower
score is better. Output is JSON when piped or with --json, and tables at a terminal (--human forces them).
The CLI loads .env and .env.local from the current directory. Set OPENROUTER_API_KEY to score.
`);
}

function parse(tokens) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const [key, inline] = token.slice(2).split(/=(.*)/s);
    if (BOOLEAN_FLAGS.includes(key)) { flags[key] = true; continue; }
    const value = inline ?? tokens[++index];
    if (value == null || (inline == null && value.startsWith("--"))) throw new Error(`Missing value for --${key}`);
    flags[key] = value;
  }
  return { positional, flags };
}

function requireFlag(flags, key) {
  if (!flags[key]) throw new Error(`--${key} is required.`);
  return flags[key];
}

function requireArg(positional, index, name) {
  if (!positional[index]) throw new Error(`Missing ${name}. Run jev-score --help.`);
  return positional[index];
}

async function questionsFrom(path) {
  const text = await readFile(resolve(path), "utf8");
  if (extname(path).toLowerCase() === ".json") {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error("Question JSON must be an array.");
    return value;
  }
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).map((line) => {
    const lower = line.match(/^\[(?:lower|low)\]\s*(.+)$/i);
    const higher = line.match(/^\[(?:higher|high)\]\s*(.+)$/i);
    return { text: (lower || higher)?.[1].trim() ?? line, direction: lower ? "lower" : "higher" };
  });
}

function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

async function health(url) {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(750) });
  if (!response.ok) return null;
  return response.json();
}

async function waitForServer(url, instanceId) {
  for (let tries = 0; tries < 50; tries += 1) {
    try { const status = await health(url); if (status?.app === "jev-score" && status.databaseId === instanceId) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("The local UI did not start.");
}

const maskKey = (key) => key ? `${key.slice(0, 6)}…${key.slice(-4)}` : null;
const metadataFlag = (flags) => flags.metadata ? JSON.parse(flags.metadata) : {};

// ---------------------------------------------------------------------------
// Human-readable views. Each takes the JSON result and a color palette.

const views = {
  workspaces: (items, c) => items.length ? table(items, [
    { label: "Workspace", value: (item) => c.bold(item.name), flex: true },
    { label: "Context", value: (item) => item.contextTitle },
    { label: "Drafts", value: (item) => item.documentCount, align: "right" },
    { label: "Best", value: (item) => one(item.best?.score), align: "right" },
    { label: "vs original", value: (item) => delta(item.delta, c), align: "right" },
    { label: "Group", value: (item) => item.groupName || c.gray("none") },
  ]) : "No workspaces yet. Create one with: jev-score workspace create --name <name> --context <file> --template resume",
  groups: (items, c) => items.length ? table(items, [
    { label: "Group", value: (item) => c.bold(item.name), flex: true },
    { label: "Questions", value: (item) => item.questions.length, align: "right" },
    { label: "Overall", value: (item) => item.scorerKind === "mean-v1" ? "mean" : "custom" },
    { label: "Runs", value: (item) => item.runCount, align: "right" },
    { label: "State", value: (item) => item.locked ? c.gray("locked") : "editable" },
  ]) : "No evaluation groups yet. Start from a template: jev-score group create --template resume",
  group: (group, c) => [
    `${c.bold(group.name)}${group.locked ? c.gray("  (locked: it has runs; fork it to change questions)") : ""}`,
    group.description ? c.dim(group.description) : null,
    "",
    table(group.questions, [
      { label: "Key", value: (question) => question.key },
      { label: "Better", value: (question) => question.direction === "lower" ? c.yellow("lower") : "higher" },
      { label: "Question", value: (question) => question.text, flex: true },
    ]),
  ].filter((line) => line !== null).join("\n"),
  templates: (items, c) => items.map((template) => `${c.bold(template.id.padEnd(14))} ${template.name}, ${template.questions.length} questions\n${" ".repeat(15)}${c.dim(template.description)}`).join("\n"),
  workspace: (detail, c) => [
    `${c.bold(detail.workspace.name)} · ${detail.workspace.contextTitle} · ${plural(detail.workspace.documentCount, "draft")} · ${plural(detail.workspace.runCount, "run")}${detail.workspace.staleRunCount ? c.yellow(` · ${detail.workspace.staleRunCount} stale runs from an older context`) : ""}`,
    detail.ranking ? `${detail.ranking.group.name} · ${detail.ranking.mode === "max" ? "best run" : "median"}` : c.gray("No evaluation group attached. Attach one with: jev-score group attach <ws> <group>"),
    ...(detail.ranking ? ["", views.rank(detail.ranking, c).split("\n").slice(2).join("\n")] : []),
  ].join("\n"),
  documents: (items, c) => items.length ? table(items, [
    { label: "#", value: (item) => item.version, align: "right" },
    { label: "Title", value: (item) => `${item.title}${item.isOriginal ? c.gray(" (original)") : ""}`, flex: true },
    { label: "Summary", value: (item) => c.dim(item.changeSummary || "") },
    { label: "Created", value: (item) => item.createdAt.slice(0, 16).replace("T", " ") },
  ]) : "No drafts yet.",
  rank: (result, c) => [
    `${c.bold(result.workspace.name)} · ${result.group.name}${result.question ? ` · ${result.question.key} (${result.question.direction} is better)` : ""} · ${result.mode === "max" ? "best run" : "median"}`,
    "",
    table(result.items, [
      { label: "Rank", value: (item) => item.rank ?? "—", align: "right" },
      { label: "#", value: (item) => item.version, align: "right" },
      { label: "Title", value: (item) => `${item.title}${item.isBest ? c.green(" ★") : ""}${item.isOriginal ? c.gray(" (original)") : ""}`, flex: true },
      { label: "Score", value: (item) => c.bold(one(item.rankScore)), align: "right" },
      { label: "Median", value: (item) => one(item.median), align: "right" },
      { label: "Runs", value: (item) => item.runs, align: "right" },
      { label: "Spread", value: (item) => item.runs > 1 ? one(item.spread) : "—", align: "right" },
      { label: "vs original", value: (item) => delta(item.delta, c), align: "right" },
    ]),
  ].join("\n"),
  score: (result, c) => [
    `${c.bold(`#${result.documentVersion} ${result.documentTitle}`)} · ${result.group}${result.rank ? `  ${c.gray(`rank ${result.rank} of ${result.evaluatedDocuments}`)}` : ""}${result.isBest ? c.green("  ★ new best") : ""}`,
    `Overall ${c.bold(one(result.overallScore))}${result.range ? c.gray(` (${one(result.range.min)}–${one(result.range.max)} over ${result.runs} runs)`) : ""}` +
      [result.parent && `  ${delta(result.vsParent, c)} vs parent #${result.parent.version}`, result.best && `  ${delta(result.vsBest, c)} vs best #${result.best.version}`, result.original && `  ${delta(result.vsOriginal, c)} vs original`].filter(Boolean).join(""),
    "",
    table(result.scores, [
      { label: "", value: (item) => item.direction === "lower" ? c.yellow("↓") : "↑" },
      { label: "Question", value: (item) => item.text, flex: true },
      { label: "Score", value: (item) => c.bold(one(item.score)), align: "right" },
      { label: "vs parent", value: (item) => delta(item.vsParent, c), align: "right" },
      { label: "vs best", value: (item) => delta(item.vsBest, c), align: "right" },
    ]),
    "",
    `Weakest: ${result.weakest.map((item) => `${item.key} ${one(item.score)}${item.direction === "lower" ? " (lower is better)" : ""}`).join(", ")}`,
    ...result.errors.map((item) => c.red(`Run ${item.runId || ""} failed: ${item.error}`)),
  ].join("\n"),
  usage: (usage, c) => [
    `${c.bold("Recorded spend")} ${usage.total.cost == null ? "—" : `$${usage.total.cost.toFixed(4)}`} across ${usage.total.runs} runs (${usage.total.totalTokens.toLocaleString("en-US")} tokens)`,
    usage.spend.limit != null ? `Spend limit $${usage.spend.limit.toFixed(2)}: $${usage.spend.spent.toFixed(4)} used${usage.spend.since ? ` since ${usage.spend.since.slice(0, 10)}` : ""}${usage.spend.exceeded ? c.red(" (limit reached)") : ""}` : c.gray("No spend limit. Set one with: jev-score config spend-limit 5"),
    "",
    table(usage.workspaces, [
      { label: "Workspace", value: (item) => item.name, flex: true },
      { label: "Runs", value: (item) => item.runs, align: "right" },
      { label: "Tokens", value: (item) => item.totalTokens.toLocaleString("en-US"), align: "right" },
      { label: "Cost", value: (item) => item.cost == null ? "—" : `$${item.cost.toFixed(4)}`, align: "right" },
    ]),
  ].join("\n"),
  doctor: (report, c) => [
    ...report.checks.map((check) => `${check.ok === true ? c.green("✓") : check.ok === false ? c.red("✗") : c.gray("·")} ${check.name.padEnd(18)} ${check.detail}${check.fix ? `\n  ${c.dim(check.fix)}` : ""}`),
    "",
    report.ok ? c.green("Ready to score.") : c.red("Fix the items marked ✗ before scoring."),
  ].join("\n"),
};

function summarizeResult(value, c) {
  if (value?.deleted) return `Deleted ${value.name || value.title || value.deleted}.`;
  if (value?.written) return `Wrote ${value.written}`;
  if (value?.opened) return `Opened ${value.opened}`;
  if (value?.path) return value.path;
  if (value?.reset) return `Reset ${value.reset}`;
  if (value?.spend) return `Spend limit: ${value.spend.limit == null ? "off" : `$${value.spend.limit.toFixed(2)}`}; $${value.spend.spent.toFixed(4)} recorded${value.spend.since ? ` since ${value.spend.since.slice(0, 16).replace("T", " ")}` : ""}.`;
  if (value?.contentHash && value?.version != null) return `${value.deduplicated ? "Already saved as" : "Saved"} ${c.bold(`#${value.version} ${value.title}`)}${value.isOriginal ? " (original)" : ""}`;
  if (value?.contextContent !== undefined && value?.name) return `${c.bold(value.name)} · ${value.contextTitle} · ${plural(value.documentCount, "draft")} · ${plural(value.runCount, "run")}${value.staleRunCount ? ` · ${value.staleRunCount} stale` : ""}`;
  return JSON.stringify(value, null, 2);
}

// ---------------------------------------------------------------------------

async function doctor({ offline }) {
  const checks = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ name: "Node.js", ok: major > 22 || (major === 22 && minor >= 13), detail: `v${process.versions.node}`, fix: "Install Node.js 22.13 or newer." });
  const path = databasePath();
  let db = null;
  try {
    db = openDatabase(path);
    accessSync(path, constants.W_OK);
    const counts = db.prepare("SELECT (SELECT count(*) FROM workspaces) workspaces, (SELECT count(*) FROM documents) documents, (SELECT count(*) FROM evaluation_runs) runs").get();
    checks.push({ name: "Database", ok: true, detail: `${path} (schema v${SCHEMA_VERSION}; ${counts.workspaces} workspaces, ${counts.documents} drafts, ${counts.runs} runs)` });
  } catch (error) {
    checks.push({ name: "Database", ok: false, detail: `${path}: ${error.message}`, fix: "Set JEV_SCORE_DB or JEV_SCORE_DATA_DIR to a writable location." });
  }
  const key = process.env.OPENROUTER_API_KEY;
  const localEnv = existsSync(resolve(".env.local")) ? ".env.local" : existsSync(resolve(".env")) ? ".env" : null;
  checks.push({ name: "API key", ok: Boolean(key), detail: key ? `${maskKey(key)}${localEnv ? ` (loaded from ${localEnv} or the environment)` : " (from the environment)"}` : "OPENROUTER_API_KEY is not set", fix: key ? null : "Put OPENROUTER_API_KEY=… in .env.local in this directory, or export it in your shell." });
  checks.push({ name: "Model", ok: true, detail: process.env.OPENROUTER_JEV_MODEL || `${DEFAULT_MODEL} (default)` });
  if (key && !offline) {
    const status = await checkOpenRouterKey({ apiKey: key });
    const remaining = status.limitRemaining != null ? `; $${Number(status.limitRemaining).toFixed(2)} left on the key` : status.limit == null && status.ok ? "; no key limit" : "";
    checks.push({ name: "OpenRouter", ok: status.ok, detail: status.ok ? `key accepted${status.label ? ` (${status.label})` : ""}${status.usage != null ? `; $${Number(status.usage).toFixed(4)} used` : ""}${remaining}` : status.reason, fix: status.ok === false ? "Check the key at openrouter.ai/settings/keys." : null });
  } else if (key) {
    checks.push({ name: "OpenRouter", ok: null, detail: "skipped (--offline)" });
  }
  if (db) {
    const spend = spendStatus(db);
    checks.push({ name: "Spend limit", ok: spend.exceeded ? false : null, detail: spend.limit == null ? "off" : `$${spend.spent.toFixed(4)} of $${spend.limit.toFixed(2)}${spend.source === "env" ? " (JEV_SCORE_SPEND_LIMIT)" : ""}`, fix: spend.exceeded ? "Raise it with jev-score config spend-limit <usd> or reset with jev-score config reset-spend." : null });
    db.close();
  }
  try {
    const status = await health("http://127.0.0.1:4317");
    checks.push({ name: "App", ok: null, detail: status?.app === "jev-score" ? `running at http://127.0.0.1:4317 (v${status.version || "?"})` : "not running on port 4317; start it with jev-score ui" });
  } catch {
    checks.push({ name: "App", ok: null, detail: "not running on port 4317; start it with jev-score ui" });
  }
  return { ok: checks.every((check) => check.ok !== false), checks: checks.map(({ fix, ...check }) => (fix && check.ok !== true ? { ...check, fix } : check)) };
}

async function run(area, action, positional, flags, db) {
  if (area === "usage") return { value: usageSummary(db), view: "usage" };
  if (area === "workspace") {
    if (action === "list") return { value: listWorkspaces(db).map((workspace) => workspaceSummary(db, workspace.id)), view: "workspaces" };
    if (action === "show") return { value: workspaceDetail(db, requireArg(positional, 0, "workspace")), view: "workspace" };
    if (action === "create") {
      let group = flags.group;
      const starter = flags.template ? findTemplate(flags.template) : null;
      if (flags.template && !starter) throw new Error(`Template not found: ${flags.template}. Run jev-score group templates.`);
      if (!group && starter) group = createGroup(db, { template: starter.id }).id;
      return { value: createWorkspace(db, { name: requireFlag(flags, "name"), contextTitle: flags["context-title"] || starter?.contextTitle, contextContent: await readFile(resolve(requireFlag(flags, "context")), "utf8"), primaryGroup: group }) };
    }
    if (action === "rename") return { value: updateWorkspace(db, requireArg(positional, 0, "workspace"), { name: requireArg(positional, 1, "new name") }) };
    if (action === "context") return { value: updateWorkspace(db, requireArg(positional, 0, "workspace"), { contextContent: await readFile(resolve(requireFlag(flags, "file")), "utf8"), ...(flags.title ? { contextTitle: flags.title } : {}) }) };
    if (action === "contexts") return { value: contextHistory(db, requireArg(positional, 0, "workspace")).map(({ content, ...context }) => ({ ...context, preview: content.slice(0, 120) })) };
    if (action === "delete") { if (!flags.yes) throw new Error("Workspace deletion is permanent. Re-run with --yes."); return { value: deleteWorkspace(db, requireArg(positional, 0, "workspace")) }; }
    if (action === "primary") return { value: updateWorkspace(db, requireArg(positional, 0, "workspace"), { primaryGroup: requireArg(positional, 1, "group") }) };
    if (action === "mode") return { value: updateWorkspace(db, requireArg(positional, 0, "workspace"), { rankingMode: requireArg(positional, 1, "mode") }) };
    if (action === "export") {
      const workspace = requireArg(positional, 0, "workspace");
      const format = flags.format || "json";
      if (!["json", "csv"].includes(format)) throw new Error("Export format must be json or csv.");
      const content = format === "csv" ? matrixCsv(db, workspace, { group: flags.group, mode: flags.mode }) : `${JSON.stringify(exportWorkspace(db, workspace, { appVersion: version }), null, 2)}\n`;
      if (!flags.out) return { raw: content };
      await writeFile(resolve(flags.out), content, "utf8");
      return { value: { written: resolve(flags.out), format } };
    }
    if (action === "import") {
      const bundle = JSON.parse(await readFile(resolve(requireArg(positional, 0, "file")), "utf8"));
      return { value: importWorkspace(db, bundle, { name: flags.name, allowScorer: true }) };
    }
  }
  if (area === "group") {
    if (action === "list") return { value: listGroups(db), view: "groups" };
    if (action === "templates") return { value: TEMPLATES, view: "templates" };
    if (action === "show") return { value: resolveGroup(db, requireArg(positional, 0, "group")), view: "group" };
    if (action === "create") {
      if (flags.template) return { value: createGroup(db, { template: flags.template, name: flags.name, description: flags.description }), view: "group" };
      return { value: createGroup(db, { name: requireFlag(flags, "name"), description: flags.description, questions: await questionsFrom(requireFlag(flags, "questions")), scorerSource: flags.scorer ? await readFile(resolve(flags.scorer), "utf8") : null }), view: "group" };
    }
    if (action === "update") return { value: updateGroup(db, requireArg(positional, 0, "group"), { name: flags.name, description: flags.description, questions: flags.questions ? await questionsFrom(flags.questions) : undefined }), view: "group" };
    if (action === "rename") return { value: updateGroup(db, requireArg(positional, 0, "group"), { name: requireArg(positional, 1, "new name") }), view: "group" };
    if (action === "fork") return { value: forkGroup(db, requireArg(positional, 0, "group"), { name: flags.name }), view: "group" };
    if (action === "delete") { if (!flags.yes) throw new Error("Group deletion also deletes its scores. Re-run with --yes."); return { value: deleteGroup(db, requireArg(positional, 0, "group")) }; }
    if (action === "attach") return { value: attachGroup(db, requireArg(positional, 0, "workspace"), requireArg(positional, 1, "group")) };
    if (action === "detach") return { value: detachGroup(db, requireArg(positional, 0, "workspace"), requireArg(positional, 1, "group")) };
  }
  if (area === "document") {
    if (action === "list") return { value: listDocuments(db, requireArg(positional, 0, "workspace")), view: "documents" };
    if (action === "add") {
      const path = resolve(requireArg(positional, 1, "file"));
      return { value: addDocument(db, requireArg(positional, 0, "workspace"), { content: await readFile(path, "utf8"), title: flags.title || path.split(/[\\/]/).pop(), changeSummary: flags.summary, parentDocument: flags.parent, original: flags.original, metadata: metadataFlag(flags) }) };
    }
    if (action === "get") {
      const document = documentDetail(db, requireArg(positional, 0, "workspace"), requireArg(positional, 1, "document"));
      if (flags.out) { await writeFile(resolve(flags.out), document.content, "utf8"); return { value: { written: resolve(flags.out), documentId: document.id } }; }
      return { value: document };
    }
    if (action === "update") return { value: updateDocument(db, requireArg(positional, 0, "workspace"), requireArg(positional, 1, "document"), { title: flags.title, changeSummary: flags.summary, original: flags.original || undefined }) };
    if (action === "delete") { if (!flags.yes) throw new Error("Deleting a draft also deletes its runs. Re-run with --yes."); return { value: deleteDocument(db, requireArg(positional, 0, "workspace"), requireArg(positional, 1, "document")) }; }
  }
  if (area === "score") {
    const workspace = requireArg([action], 0, "workspace");
    let documentRef = requireArg(positional, 0, "document or file");
    const path = resolve(documentRef);
    if (existsSync(path)) {
      const saved = addDocument(db, workspace, { content: await readFile(path, "utf8"), title: flags.title || path.split(/[\\/]/).pop(), changeSummary: flags.summary, parentDocument: flags.parent, metadata: metadataFlag(flags) });
      documentRef = saved.id;
    }
    return { value: await scoreDocument(db, workspace, documentRef, { group: flags.group, runs: flags.runs ? Number(flags.runs) : 1, note: flags.note, metadata: metadataFlag(flags) }), view: "score" };
  }
  if (area === "rank") return { value: ranking(db, requireArg([action], 0, "workspace"), { group: flags.group, question: flags.question, mode: flags.mode }), view: "rank" };
  if (area === "report") {
    const format = flags.format || (flags.out && extname(flags.out).toLowerCase() === ".md" ? "md" : "html");
    const report = renderReport(db, requireArg([action], 0, "workspace"), { format, group: flags.group, mode: flags.mode, appVersion: version });
    if (!flags.out) return { raw: report.content };
    await writeFile(resolve(flags.out), report.content, "utf8");
    return { value: { written: resolve(flags.out), format } };
  }
  if (area === "config") {
    if (action === "show" || !action) return { value: { database: databasePath(), model: process.env.OPENROUTER_JEV_MODEL || DEFAULT_MODEL, apiKey: maskKey(process.env.OPENROUTER_API_KEY), spend: spendStatus(db) } };
    if (action === "spend-limit") {
      const value = requireArg(positional, 0, "amount in USD or off");
      return { value: { spend: setSpendLimit(db, ["off", "none"].includes(value.toLowerCase()) ? null : value) } };
    }
    if (action === "reset-spend") return { value: { spend: resetSpendCounter(db) } };
  }
  throw new Error("Unknown command. Run jev-score --help.");
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args.includes("-h") || args[0] === "help") return help();
  if (args.includes("--version") || args[0] === "version") return process.stdout.write(`${version}\n`);
  const [area, action, ...rest] = args;
  const { positional, flags } = parse(["serve", "ui", "mcp", "doctor", "usage"].includes(area) ? args.slice(1) : rest);
  const human = flags.human || (!flags.json && process.stdout.isTTY);
  const color = palette(human && process.stdout.isTTY && !process.env.NO_COLOR);
  const print = (value, view) => process.stdout.write(`${human ? (view ? views[view](value, color) : summarizeResult(value, color)) : JSON.stringify(value, null, 2)}\n`);

  if (area === "mcp") return runMcpServer({ version });
  if (area === "serve" || area === "ui") {
    const port = Number(flags.port || 4317);
    if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error("--port must be a number from 0 to 65535.");
    const url = `http://127.0.0.1:${port}`;
    const instanceId = databaseIdentity();
    if (area === "ui") {
      let status = null;
      try { status = await health(url); } catch {}
      if (status && (status.app !== "jev-score" || status.databaseId !== instanceId)) throw new Error(`Port ${port} is already serving a different application or Jev Score database. Choose another port with --port.`);
      if (!status) {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--port", String(port)], { detached: true, stdio: "ignore", windowsHide: true, cwd: process.cwd(), env: process.env });
        child.unref();
        await waitForServer(url, instanceId);
      }
      if (!flags["no-open"]) openBrowser(url);
      return print({ opened: url });
    }
    const running = await startServer({ port, dbPath: databasePath() });
    process.stdout.write(`Jev Score is running at ${running.url}\n`);
    return;
  }
  if (area === "doctor") {
    const report = await doctor(flags);
    print(report, "doctor");
    if (!report.ok) process.exitCode = 1;
    return;
  }
  if (area === "db" && action === "path") return print({ path: databasePath() });
  if (area === "db" && action === "reset") {
    if (!flags.yes) throw new Error("Database reset is permanent. Re-run with --yes.");
    const path = databasePath();
    const resetDb = openDatabase(path);
    try {
      inTransaction(resetDb, () => { resetDb.exec("DELETE FROM workspaces; DELETE FROM evaluation_groups; DELETE FROM usage_ledger; DELETE FROM settings;"); });
      resetDb.exec("VACUUM");
    } finally { resetDb.close(); }
    return print({ reset: path });
  }

  const db = openDatabase();
  try {
    const result = await run(area, action, positional, flags, db);
    if (result.raw !== undefined) process.stdout.write(result.raw);
    else print(result.value, result.view);
  } finally { db.close(); }
}

main().catch((error) => {
  const runs = error.runIds?.length ? ` (runs ${error.runIds.join(", ")})` : error.runId ? ` (run ${error.runId})` : "";
  process.stderr.write(`jev-score: ${error instanceof Error ? error.message : String(error)}${runs}\n`);
  process.exitCode = 1;
});
