import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/db.mjs";
import { PROTOCOL_VERSIONS, createMcpHandler } from "../src/mcp.mjs";

const fakeEvaluate = async ({ questions }) => ({ model: "fake", provider: "test", usage: null, scores: questions.map((question, index) => ({ questionId: question.id, key: question.key, text: question.text, rawScore: 3, score: 90 - index * 10, confidence: 1, probabilities: null })) });
const call = (handle, id, name, args = {}) => handle({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });
const parse = (reply) => JSON.parse(reply.result.content[0].text);

test("the MCP handler negotiates a version and lists tools with schemas", async () => {
  const db = openDatabase(":memory:");
  const handle = createMcpHandler(db, { version: "9.9.9" });
  const init = await handle({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
  assert.equal(init.result.protocolVersion, "2025-03-26");
  assert.equal(init.result.serverInfo.version, "9.9.9");
  assert.match(init.result.instructions, /bold, meaningful changes/);
  const future = await handle({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } });
  assert.equal(future.result.protocolVersion, PROTOCOL_VERSIONS[0]);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  const { result } = await handle({ jsonrpc: "2.0", id: 3, method: "tools/list" });
  const names = result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["list_workspaces", "get_workspace", "get_document", "score_document", "add_document", "rank_documents", "list_groups", "create_group", "create_workspace"]);
  for (const tool of result.tools) {
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(typeof tool.description, "string");
    assert.equal("run" in tool, false);
  }
  assert.deepEqual((await handle({ jsonrpc: "2.0", id: 4, method: "ping" })).result, {});
  assert.equal((await handle({ jsonrpc: "2.0", id: 5, method: "resources/list" })).error.code, -32601);
  assert.equal((await call(handle, 6, "nope")).error.code, -32602);
  db.close();
});

test("an agent can set up a workspace, score drafts, and read feedback over MCP", async () => {
  const db = openDatabase(":memory:");
  const handle = createMcpHandler(db, { evaluate: fakeEvaluate });
  const workspace = parse(await call(handle, 1, "create_workspace", { name: "Essay", context: "Write about a challenge.", template: "college-essay" }));
  assert.equal(workspace.contextTitle, "Essay prompt");
  assert.equal(workspace.groups[0].name, "College essay review");
  const first = parse(await call(handle, 2, "score_document", { workspace: "Essay", content: "# Draft\n\nA story.", title: "First draft" }));
  assert.equal(first.documentVersion, 0);
  assert.equal(first.status, "success");
  const second = parse(await call(handle, 3, "score_document", { workspace: "Essay", content: "# Draft\n\nA sharper story.", title: "Sharper", summary: "Opened with a scene", parent: "#0" }));
  assert.equal(second.parent.version, 0);
  assert.equal(second.vsParent, 0);
  assert.equal(second.weakest.length, 3);
  const again = parse(await call(handle, 4, "score_document", { workspace: "Essay", content: "# Draft\n\nA sharper story." }));
  assert.match(again.note, /matches existing draft #1/);
  const read = parse(await call(handle, 5, "get_workspace", { workspace: "Essay" }));
  assert.equal(read.drafts.length, 2);
  assert.equal(read.group.questions.length, 8);
  const document = parse(await call(handle, 6, "get_document", { workspace: "Essay", document: "Sharper" }));
  assert.equal(document.content, "# Draft\n\nA sharper story.");
  const ranked = parse(await call(handle, 7, "rank_documents", { workspace: "Essay" }));
  assert.equal(ranked.drafts[0].rank, 1);
  const groups = parse(await call(handle, 8, "list_groups"));
  assert.ok(groups.templates.length >= 8);
  const failed = await call(handle, 9, "score_document", { workspace: "Missing", content: "x" });
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /Workspace not found/);
  db.close();
});

test("jev-score mcp speaks newline-delimited JSON-RPC on stdio and nothing else", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "jev-mcp-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const child = spawn(process.execPath, ["./bin/jev-score.mjs", "mcp"], { cwd: new URL("..", import.meta.url), env: { ...process.env, JEV_SCORE_DB: join(directory, "mcp.db") } });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })}\n`);
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
  child.stdin.write("not json\n");
  child.stdin.write(`${JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "ping" }, { jsonrpc: "2.0", id: 3, method: "tools/list" }])}\n`);
  child.stdin.end();
  const code = await new Promise((resolve) => child.on("close", resolve));
  assert.equal(code, 0, stderr);
  assert.equal(stderr, "", "no warnings or logs on stderr");
  const messages = stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages.find((message) => message.id === 1).result.protocolVersion, "2025-06-18");
  assert.ok(messages.some((message) => message.error?.code === -32700));
  const batch = messages.find(Array.isArray);
  assert.deepEqual(batch.map((message) => message.id).sort(), [2, 3]);
});
