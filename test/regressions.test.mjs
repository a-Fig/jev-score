import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.mjs";
import { evaluateWithJev } from "../src/jev.mjs";
import { createMcpHandler } from "../src/mcp.mjs";
import { startServer } from "../src/server.mjs";
import {
  addDocument, createGroup, createWorkspace, deleteDocument, evaluateDocument, exportWorkspace, importWorkspace, listGroups,
  ranking, resolveDocument, scoreDocument, setSpendLimit, spendStatus, updateGroup,
} from "../src/service.mjs";

const temporary = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true }); });
function directory() { const path = mkdtempSync(join(tmpdir(), "jev-regress-")); temporary.push(path); return path; }
function database() { return openDatabase(join(directory(), "test.db")); }
const scores = (values, usage = { input_tokens: 10, output_tokens: 1, cost: 0.04 }) => async ({ questions }) => ({ model: "fake", provider: "test", usage, scores: questions.map((question, index) => ({ questionId: question.id, key: question.key, text: question.text, rawScore: 3, score: values[index] ?? values[0], confidence: 1, probabilities: null })) });
const ledger = (db) => ({ ...db.prepare("SELECT count(*) count, coalesce(sum(cost), 0) cost FROM usage_ledger").get() });

test("a paid run whose draft is deleted mid-call is refused but its cost is recorded", async () => {
  const db = database();
  const group = createGroup(db, { name: "G", questions: ["Fit"] });
  const workspace = createWorkspace(db, { name: "W", contextContent: "C", primaryGroup: group.id });
  const draft = addDocument(db, workspace.id, { title: "D", content: "Text" });
  const evaluate = async (input) => { deleteDocument(db, workspace.id, draft.id); return scores([80])(input); };
  await assert.rejects(evaluateDocument(db, workspace.id, draft.id, { evaluate }), (error) => error.status === 409 && /Its cost was recorded/.test(error.message));
  assert.deepEqual(ledger(db), { count: 1, cost: 0.04 });
  db.close();
});

test("bad metadata fails before the provider is called, and questions can't change mid-run", async () => {
  const db = database();
  const group = createGroup(db, { name: "G", questions: ["Fit"] });
  const workspace = createWorkspace(db, { name: "W", contextContent: "C", primaryGroup: group.id });
  const draft = addDocument(db, workspace.id, { title: "D", content: "Text" });
  let called = false;
  await assert.rejects(evaluateDocument(db, workspace.id, draft.id, { metadata: "{not json", evaluate: async () => { called = true; } }), /Metadata must be a JSON object/);
  assert.equal(called, false);
  const evaluate = async (input) => { assert.throws(() => updateGroup(db, group.id, { questions: ["Other"] }), /being used to score/); return scores([70])(input); };
  await evaluateDocument(db, workspace.id, draft.id, { evaluate });
  db.close();
});

test("a billed response with an unusable answer still counts toward spend", async () => {
  const db = database();
  const group = createGroup(db, { name: "G", questions: [{ key: "fit", text: "Fit" }] });
  const workspace = createWorkspace(db, { name: "W", contextContent: "C", primaryGroup: group.id });
  const draft = addDocument(db, workspace.id, { title: "D", content: "Text" });
  const fetchImpl = async () => new Response(JSON.stringify({ usage: { input_tokens: 50, output_tokens: 5, cost: 0.03 }, answers: { fit: { score: "high" } } }), { status: 200 });
  const evaluate = (input) => evaluateWithJev({ ...input, apiKey: "test", fetchImpl });
  await assert.rejects(evaluateDocument(db, workspace.id, draft.id, { evaluate }), /invalid score/);
  assert.deepEqual(ledger(db), { count: 1, cost: 0.03 });
  db.close();
});

test("with a spend limit, repeat runs go one at a time and stop at the limit", async () => {
  const db = database();
  const group = createGroup(db, { name: "G", questions: ["Fit"] });
  const workspace = createWorkspace(db, { name: "W", contextContent: "C", primaryGroup: group.id });
  const draft = addDocument(db, workspace.id, { title: "D", content: "Text" });
  setSpendLimit(db, 0.05);
  let calls = 0;
  const feedback = await scoreDocument(db, workspace.id, draft.id, { runs: 10, evaluate: async (input) => { calls += 1; return scores([80])(input); } });
  assert.equal(calls, 2, "stops once the recorded spend reaches the limit");
  assert.equal(spendStatus(db).spent, 0.08);
  assert.match(feedback.errors.at(-1).error, /Spend limit reached/);
  db.close();
});

test("drafts written without a number by an older server get fresh numbers on the next open", () => {
  const path = join(directory(), "mixed.db");
  let db = openDatabase(path);
  const workspace = createWorkspace(db, { name: "W", contextContent: "C" });
  ["A", "B", "C"].forEach((title) => addDocument(db, workspace.id, { title, content: title }));
  deleteDocument(db, workspace.id, "#1");
  deleteDocument(db, workspace.id, "#2");
  // What a 1.x server still running against this file would insert.
  db.prepare("INSERT INTO documents (id,workspace_id,content_hash,content,title,change_summary,metadata_json,is_original,created_at) VALUES ('doc_legacy',?,'h','Legacy','Legacy','','{}',0,?)").run(workspace.id, new Date().toISOString());
  db.close();
  db = openDatabase(path);
  assert.equal(resolveDocument(db, workspace.id, "doc_legacy").version, 3, "numbers 1 and 2 stay retired");
  assert.equal(addDocument(db, workspace.id, { title: "Next", content: "Next" }).version, 4);
  db.close();
});

test("imports are all-or-nothing and keep retired draft numbers retired", async () => {
  const db = database();
  const group = createGroup(db, { name: "Rubric", questions: ["Fit"] });
  const workspace = createWorkspace(db, { name: "W", contextContent: "C", primaryGroup: group.id });
  addDocument(db, workspace.id, { title: "A", content: "A" });
  deleteDocument(db, workspace.id, addDocument(db, workspace.id, { title: "B", content: "B" }).id);
  const bundle = JSON.parse(JSON.stringify(exportWorkspace(db, workspace.id)));
  const copy = importWorkspace(db, bundle, { name: "Copy" });
  assert.equal(addDocument(db, copy.id, { title: "C", content: "C" }).version, 2);
  const groupsBefore = listGroups(db).length;
  const broken = JSON.parse(JSON.stringify(bundle));
  broken.groups[0].name = "Different rubric";
  broken.runs.push({ document: broken.documents[0].ref, group: broken.groups[0].ref, status: "exploded", scores: [] });
  assert.throws(() => importWorkspace(db, broken), /unknown status/);
  assert.equal(listGroups(db).length, groupsBefore, "no group is left behind");
  assert.throws(() => importWorkspace(db, { ...bundle, groups: [null] }), /malformed/);
  assert.throws(() => importWorkspace(db, { ...bundle, documents: [{ ref: "x" }] }), /has no text/);
  db.close();
});

test("a template workspace that can't be created leaves no group behind", () => {
  const db = database();
  createWorkspace(db, { name: "Taken", contextContent: "C" });
  assert.throws(() => createWorkspace(db, { name: "taken", contextContent: "C", template: "resume" }), (error) => error.status === 409);
  assert.equal(listGroups(db).length, 0);
  const created = createWorkspace(db, { name: "Fresh", contextContent: "C", template: "resume" });
  assert.deepEqual([created.contextTitle, created.groups[0].name], ["Job posting", "Resume review"]);
  db.close();
});

test("best so far without a baseline follows the question's direction", async () => {
  const db = database();
  const group = createGroup(db, { name: "G", questions: [{ key: "fit", text: "Fit" }, { key: "flags", text: "Flags", direction: "lower" }] });
  const workspace = createWorkspace(db, { name: "W", contextContent: "C", primaryGroup: group.id });
  addDocument(db, workspace.id, { title: "Original, unscored", content: "O" });
  const a = addDocument(db, workspace.id, { title: "A", content: "A" });
  const b = addDocument(db, workspace.id, { title: "B", content: "B" });
  await evaluateDocument(db, workspace.id, a.id, { evaluate: scores([70, 20]) });
  await evaluateDocument(db, workspace.id, b.id, { evaluate: scores([70, 40]) });
  assert.deepEqual(ranking(db, workspace.id, { question: "flags" }).timeline.map((point) => point.frontier), [20, 20]);
  db.close();
});

test("the server answers malformed input with 400, not 500", async (context) => {
  const db = openDatabase(":memory:");
  const { server, url } = await startServer({ port: 0, db, instanceId: "t" });
  context.after(() => { server.close(); db.close(); });
  assert.equal((await fetch(`${url}/api/workspaces/%E0%A4%A`)).status, 400);
  assert.equal((await fetch(`${url}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "null" })).status, 400);
  assert.equal((await fetch(`${url}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "[1]" })).status, 400);
});

test("malformed MCP messages always get an error reply", async () => {
  const db = openDatabase(":memory:");
  const handle = createMcpHandler(db);
  for (const message of [null, 5, { foo: 1 }, { jsonrpc: "2.0", id: 3 }]) {
    const reply = await handle(message);
    assert.equal(reply.error.code, -32600);
  }
  assert.equal((await handle({ jsonrpc: "2.0", id: 9, method: "notifications/initialized" })).error.code, -32601, "a request with an id always gets an answer");
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  db.close();
});

test("the CLI accepts flags before positionals and keeps scorer output off stdout", async (context) => {
  const path = directory();
  const provider = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ answers: Object.fromEntries(Object.keys(body.questions).map((key) => [key, { score: 3 }])) }));
  });
  await new Promise((resolve) => provider.listen(0, "127.0.0.1", resolve));
  context.after(() => provider.close());
  const env = { ...process.env, JEV_SCORE_DB: join(path, "cli.db"), OPENROUTER_API_KEY: "test", OPENROUTER_DECISIONS_ENDPOINT: `http://127.0.0.1:${provider.address().port}/d` };
  const run = (args) => new Promise((resolve) => {
    const child = spawn(process.execPath, ["./bin/jev-score.mjs", ...args], { cwd: new URL("..", import.meta.url), env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
  writeFileSync(join(path, "q.txt"), "Fit\n");
  writeFileSync(join(path, "scorer.mjs"), "export default function score(s) { console.log('debugging', s.fit); return s.fit; }\n");
  writeFileSync(join(path, "context.md"), "Context");
  writeFileSync(join(path, "draft.md"), "Draft");
  assert.equal((await run(["group", "create", "--name", "Logged", "--questions", join(path, "q.txt"), "--scorer", join(path, "scorer.mjs")])).code, 0);
  assert.equal((await run(["--json", "workspace", "create", "--name", "W", "--context", join(path, "context.md"), "--group", "Logged"])).code, 0);
  const scored = await run(["score", "--title", "First", "W", join(path, "draft.md")]);
  assert.equal(scored.code, 0, scored.stderr);
  assert.equal(JSON.parse(scored.stdout).overallScore, 75, "stdout is pure JSON");
  assert.match(scored.stderr, /debugging 75/);
  const ranked = await run(["rank", "--mode", "median", "W"]);
  assert.equal(JSON.parse(ranked.stdout).mode, "median");
  const port = await run(["ui", "--port", "0"]);
  assert.match(port.stderr, /--port must be a number from 1/);
});
