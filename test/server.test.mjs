import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { openDatabase } from "../src/db.mjs";
import { startServer } from "../src/server.mjs";
import { addDocument, createWorkspace } from "../src/service.mjs";

const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const json = (body, method = "POST") => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const fakeEvaluate = async ({ questions }) => ({ model: "fake", provider: "test", usage: { input_tokens: 10, output_tokens: 2, cost: 0.001 }, scores: questions.map((question, index) => ({ questionId: question.id, key: question.key, text: question.text, rawScore: 3, score: 60 + index * 10, confidence: 1, probabilities: null })) });

async function server(context, options = {}) {
  const db = options.db || openDatabase(":memory:");
  const running = await startServer({ port: 0, db, instanceId: "test-database", evaluate: fakeEvaluate, ...options });
  context.after(() => { running.server.close(); db.close(); });
  return { ...running, db };
}

// Reads server-sent events until `count` events named `name` arrive.
function listen(url, name, count = 1) {
  const controller = new AbortController();
  const events = [];
  const done = (async () => {
    const response = await fetch(`${url}/api/events`, { signal: controller.signal });
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      for (const block of buffer.split("\n\n").slice(0, -1)) {
        const event = block.match(/^event: (.+)$/m)?.[1];
        if (event === name) events.push(JSON.parse(block.match(/^data: (.+)$/m)[1]));
      }
      buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      if (events.length >= count) break;
    }
    controller.abort();
    return events;
  })().catch((error) => { if (error.name !== "AbortError") throw error; return events; });
  return { done, stop: () => controller.abort() };
}

test("local server exposes health, the app shell, and workspace CRUD", async (context) => {
  const { url } = await server(context);
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true, app: "jev-score", version, databaseId: "test-database" });
  const shell = await fetch(url);
  assert.match(await shell.text(), /<title>Jev Score<\/title>/);
  assert.match(shell.headers.get("content-security-policy"), /script-src 'self'/);
  assert.equal(shell.headers.get("x-content-type-options"), "nosniff");
  const deepLink = await fetch(`${url}/w/ws_123/d/doc_456`);
  assert.match(await deepLink.text(), /<main id="main"/, "client routes fall back to the app shell");
  const script = await fetch(`${url}/views/editor.js`);
  assert.match(script.headers.get("content-type"), /text\/javascript/);
  const font = await fetch(`${url}/fonts/newsreader-latin-opsz-normal.woff2`);
  assert.equal(font.headers.get("content-type"), "font/woff2");
  assert.match(font.headers.get("cache-control"), /immutable/);
  const created = await fetch(`${url}/api/workspaces`, json({ name: "Essay", contextContent: "Prompt" }));
  assert.equal(created.status, 201);
  assert.equal((await created.json()).name, "Essay");
  const duplicate = await fetch(`${url}/api/workspaces`, json({ name: "essay", contextContent: "Prompt" }));
  assert.equal(duplicate.status, 409);
  assert.equal((await fetch(`${url}/api/workspaces/nope`)).status, 404);
  const dashboard = await (await fetch(`${url}/api/dashboard`)).json();
  assert.equal(dashboard.workspaces.length, 1);
  assert.deepEqual(dashboard.activity, []);
  const usage = await (await fetch(`${url}/api/usage`)).json();
  assert.deepEqual(usage.total, { runs: 0, reportedRuns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: null, costRuns: 0 });
  const templates = await (await fetch(`${url}/api/templates`)).json();
  assert.ok(Array.isArray(templates) && templates.some((template) => template.id === "resume"));
});

test("drafts are saved, scored, reported, and exported over the API", async (context) => {
  const { url } = await server(context);
  const group = await (await fetch(`${url}/api/groups`, json({ template: "cold-email" }))).json();
  assert.equal(group.name, "Cold email review");
  const workspace = await (await fetch(`${url}/api/workspaces`, json({ name: "Outreach", contextContent: "Dana leads DevRel.", primaryGroup: group.id }))).json();
  const base = `${url}/api/workspaces/${workspace.id}`;
  const draft = await (await fetch(`${base}/documents`, json({ title: "First", content: "Hi Dana" }))).json();
  const second = await (await fetch(`${base}/documents`, json({ title: "Second", content: "Hi Dana, one question.", parentDocument: "#0" }))).json();
  const scored = await fetch(`${base}/documents/${second.id}/evaluate`, json({ runs: 2 }));
  assert.equal(scored.status, 201);
  const feedback = await scored.json();
  assert.deepEqual([feedback.runs, feedback.documentVersion, feedback.parent.version, feedback.weakest.length], [2, 1, 0, 3]);
  const detail = await (await fetch(base)).json();
  assert.equal(detail.matrix.rows.find((row) => row.id === second.id).runs, 2);
  assert.equal(detail.contexts.length, 1);
  const renamed = await (await fetch(`${base}/documents/${draft.id}`, json({ title: "Opening" }, "PATCH"))).json();
  assert.equal(renamed.title, "Opening");
  const html = await fetch(`${base}/report`);
  assert.match(html.headers.get("content-type"), /text\/html/);
  assert.match(html.headers.get("content-security-policy"), /default-src 'none'/);
  assert.match(await html.text(), /Outreach/);
  const markdown = await fetch(`${base}/report?format=md&download`);
  assert.match(markdown.headers.get("content-disposition"), /attachment; filename="Outreach-report.md"/);
  const csv = await fetch(`${base}/export?format=csv`);
  assert.match(await csv.text(), /^version,title,original,best,runs,overall/);
  const bundle = await (await fetch(`${base}/export`)).json();
  const imported = await fetch(`${url}/api/workspaces/import?name=Copy`, json(bundle));
  assert.equal(imported.status, 201);
  assert.equal((await imported.json()).name, "Copy");
  bundle.groups[0].scorerSource = "export default () => 50";
  assert.equal((await fetch(`${url}/api/workspaces/import`, json(bundle))).status, 400);
  const deleted = await (await fetch(`${base}/documents/${draft.id}`, { method: "DELETE" })).json();
  assert.equal(deleted.version, 0);
});

test("settings set and clear the spend limit", async (context) => {
  const { url } = await server(context);
  const settings = await (await fetch(`${url}/api/settings`)).json();
  assert.equal(settings.version, version);
  assert.equal(settings.spend.limit, null);
  const limited = await (await fetch(`${url}/api/settings`, json({ spendLimit: 2.5 }, "PATCH"))).json();
  assert.equal(limited.spend.limit, 2.5);
  assert.equal((await fetch(`${url}/api/settings`, json({ spendLimit: -3 }, "PATCH"))).status, 400);
  const reset = await (await fetch(`${url}/api/settings/spend-reset`, json({}))).json();
  assert.ok(reset.spend.since);
  assert.equal((await (await fetch(`${url}/api/settings`, json({ spendLimit: null }, "PATCH"))).json()).spend.limit, null);
});

test("mutations over the API broadcast a live change event", async (context) => {
  const { url } = await server(context);
  const events = listen(url, "change");
  await new Promise((resolve) => setTimeout(resolve, 50));
  await fetch(`${url}/api/workspaces`, json({ name: "Live", contextContent: "Context" }));
  const [event] = await events.done;
  assert.match(event.reason, /POST \/api\/workspaces/);
});

test("writes from another process reach open pages through the database watcher", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "jev-live-"));
  const path = join(directory, "data.db");
  const db = openDatabase(path);
  const { url } = await server(context, { db, dbPath: path, watchIntervalMs: 50 });
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const events = listen(url, "change");
  await new Promise((resolve) => setTimeout(resolve, 100));
  // A separate connection stands in for the CLI or MCP server.
  const other = openDatabase(path);
  const workspace = createWorkspace(other, { name: "From the CLI", contextContent: "Context" });
  addDocument(other, workspace.id, { title: "Draft", content: "Text" });
  other.close();
  const [event] = await events.done;
  assert.equal(event.reason, "database");
});

test("local server rejects cross-origin and non-JSON mutations", async (context) => {
  const { url } = await server(context);
  const input = JSON.stringify({ name: "Hostile", questions: ["Question"], scorerSource: "export default () => 100" });
  const crossOrigin = await fetch(`${url}/api/groups`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: input });
  assert.equal(crossOrigin.status, 403);
  const plainText = await fetch(`${url}/api/groups`, { method: "POST", headers: { "Content-Type": "text/plain", Origin: new URL(url).origin }, body: input });
  assert.equal(plainText.status, 415);
  const customCode = await fetch(`${url}/api/groups`, { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(url).origin }, body: input });
  assert.equal(customCode.status, 400);
  const badHostStatus = await new Promise((resolve, reject) => {
    const target = new URL(`${url}/api/health`);
    const call = request({ hostname: target.hostname, port: target.port, path: target.pathname, headers: { Host: "evil.example" } }, (response) => { response.resume(); resolve(response.statusCode); });
    call.on("error", reject); call.end();
  });
  assert.equal(badHostStatus, 403);
  const traversal = await new Promise((resolve, reject) => {
    const target = new URL(url);
    const call = request({ hostname: target.hostname, port: target.port, path: "/..%2f..%2fpackage.json" }, (response) => { let body = ""; response.on("data", (chunk) => { body += chunk; }); response.on("end", () => resolve(body)); });
    call.on("error", reject); call.end();
  });
  assert.doesNotMatch(traversal, /"name": "jev-score"/, "static files never escape web/");
});

test("database reset remains consistent while the server connection is open", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "jev-reset-"));
  const path = join(directory, "data.db");
  const db = openDatabase(path);
  const { url } = await server(context, { db });
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  await fetch(`${url}/api/workspaces`, json({ name: "Temporary", contextContent: "Context" }));
  const result = spawnSync(process.execPath, ["./bin/jev-score.mjs", "db", "reset", "--yes"], { cwd: new URL("..", import.meta.url), env: { ...process.env, JEV_SCORE_DB: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const dashboard = await (await fetch(`${url}/api/dashboard`)).json();
  assert.equal(dashboard.workspaces.length, 0);
});
