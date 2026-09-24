import assert from "node:assert/strict";
import { test } from "node:test";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = new URL("..", import.meta.url);

// A stand-in for OpenRouter's decisions endpoint, so the real CLI path runs
// end to end: HTTP, retries, storage, and feedback.
async function fakeOpenRouter(context) {
  let calls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    calls += 1;
    if (calls === 1) { response.writeHead(503, { "Retry-After": "0" }); response.end("warming up"); return; }
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const length = body.state.document.length;
    const answers = Object.fromEntries(Object.keys(body.questions).map((key, index) => [key, { score: Math.min(4, 2 + (length % 7) / 10 + index / 10), confidence: 0.9 }]));
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ model: body.model, provider: "TypeSafe", usage: { input_tokens: 500, output_tokens: 20, cost: 0.002 }, answers }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  return { url: `http://127.0.0.1:${server.address().port}/decisions`, calls: () => calls };
}

function cli(args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["./bin/jev-score.mjs", ...args], { cwd: root, env });
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr, json: () => JSON.parse(stdout) }));
  });
}

test("the CLI runs the whole loop against a Jev endpoint and prints JSON when piped", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "jev-cli-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const provider = await fakeOpenRouter(context);
  const env = { ...process.env, JEV_SCORE_DB: join(directory, "cli.db"), OPENROUTER_API_KEY: "test-key", OPENROUTER_DECISIONS_ENDPOINT: provider.url, NO_COLOR: "1" };
  const templates = await cli(["group", "templates"], env);
  assert.equal(templates.code, 0, templates.stderr);
  assert.ok(templates.json().some((template) => template.id === "resume"));
  assert.doesNotMatch(templates.stderr, /ExperimentalWarning/, "the SQLite warning is filtered");

  const workspace = await cli(["workspace", "create", "--name", "Product writer", "--context", "examples/resume/job-posting.md", "--template", "resume"], env);
  assert.equal(workspace.code, 0, workspace.stderr);
  assert.equal(workspace.json().contextTitle, "Job posting");

  const first = await cli(["score", "Product writer", "examples/resume/resume.md", "--title", "Original resume"], env);
  assert.equal(first.code, 0, first.stderr);
  const original = first.json();
  assert.equal(original.documentTitle, "Original resume");
  assert.equal(original.status, "success");
  assert.equal(original.scores.length, 8);
  assert.equal(provider.calls(), 2, "the first 503 was retried");

  const revisionPath = join(directory, "revision.md");
  writeFileSync(revisionPath, `${readFileSync(new URL("../examples/resume/resume.md", import.meta.url), "utf8")}\n- Cut review time 40% with a docs linter.\n`);
  const second = await cli(["score", "Product writer", revisionPath, "--title", "Linter bullet", "--summary", "Added a quantified bullet", "--parent", "#0", "--runs", "2"], env);
  assert.equal(second.code, 0, second.stderr);
  const feedback = second.json();
  assert.deepEqual([feedback.documentVersion, feedback.runs, feedback.parent.version], [1, 2, 0]);
  assert.equal(typeof feedback.vsParent, "number");
  assert.equal(feedback.weakest.length, 3);

  const ranked = await cli(["rank", "Product writer"], env);
  assert.equal(ranked.json().items.length, 2);
  const human = await cli(["rank", "Product writer", "--human"], env);
  assert.match(human.stdout, /Rank\s+#\s+Title\s+Score/);
  assert.match(human.stdout, /Original resume \(original\)/);

  const reportPath = join(directory, "report.md");
  const report = await cli(["report", "Product writer", "--out", reportPath], env);
  assert.equal(report.json().format, "md");
  assert.match(readFileSync(reportPath, "utf8"), /# Product writer: Jev Score report/);

  const exportPath = join(directory, "export.json");
  await cli(["workspace", "export", "Product writer", "--out", exportPath], env);
  const imported = await cli(["workspace", "import", exportPath, "--name", "Copy"], env);
  assert.equal(imported.json().documentCount, 2);

  const limit = await cli(["config", "spend-limit", "0.001"], env);
  assert.equal(limit.json().spend.limit, 0.001);
  const blocked = await cli(["score", "Product writer", "#1"], env);
  assert.equal(blocked.code, 1);
  assert.match(blocked.stderr, /Spend limit reached/);

  const usage = await cli(["usage"], env);
  assert.equal(usage.json().spend.exceeded, true);
});

test("doctor checks the setup without spending anything", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "jev-doctor-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const base = { ...process.env, JEV_SCORE_DB: join(directory, "doctor.db"), NO_COLOR: "1" };
  delete base.OPENROUTER_API_KEY;
  const missing = await cli(["doctor", "--offline"], base);
  assert.equal(missing.code, 1);
  const report = missing.json();
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.name === "API key").ok, false);
  assert.equal(report.checks.find((check) => check.name === "Database").ok, true);
  const ready = await cli(["doctor", "--offline", "--human"], { ...base, OPENROUTER_API_KEY: "sk-or-test-1234" });
  assert.equal(ready.code, 0, ready.stdout);
  assert.match(ready.stdout, /✓ API key\s+sk-or-…1234/);
  assert.match(ready.stdout, /Ready to score\./);
});

test("errors are short, readable, and exit non-zero", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "jev-errors-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const env = { ...process.env, JEV_SCORE_DB: join(directory, "errors.db") };
  const unknown = await cli(["frobnicate"], env);
  assert.equal(unknown.code, 1);
  assert.equal(unknown.stderr, "jev-score: Unknown command. Run jev-score --help.\n");
  const missing = await cli(["workspace", "show", "Nope"], env);
  assert.match(missing.stderr, /Workspace not found: Nope/);
  const help = await cli(["--help"], env);
  assert.match(help.stdout, /jev-score mcp|mcp\s+Run the MCP server/);
});
