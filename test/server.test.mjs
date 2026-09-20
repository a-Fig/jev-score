import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { request } from "node:http";
import { openDatabase } from "../src/db.mjs";
import { startServer } from "../src/server.mjs";

test("local server exposes health and workspace CRUD", async (context) => {
  const db = openDatabase(":memory:");
  const { server, url } = await startServer({ port: 0, db, instanceId: "test-database" });
  context.after(() => { server.close(); db.close(); });
  assert.deepEqual(await (await fetch(`${url}/api/health`)).json(), { ok: true, app: "jev-score", databaseId: "test-database" });
  assert.match(await (await fetch(url)).text(), /Jev Score/);
  assert.match(await (await fetch(`${url}/app.js`)).text(), /loadDashboard/);
  const created = await (await fetch(`${url}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Essay", contextContent: "Prompt" }) })).json();
  assert.equal(created.name, "Essay");
  const dashboard = await (await fetch(`${url}/api/dashboard`)).json();
  assert.equal(dashboard.workspaces.length, 1);
});

test("local server rejects cross-origin and non-JSON mutations", async (context) => {
  const db = openDatabase(":memory:");
  const { server, url } = await startServer({ port: 0, db, instanceId: "security-test" });
  context.after(() => { server.close(); db.close(); });
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
});

test("database reset remains consistent while the server connection is open", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "jev-reset-"));
  const path = join(directory, "data.db");
  const db = openDatabase(path);
  const { server, url } = await startServer({ port: 0, db, instanceId: "reset-test" });
  context.after(() => { server.close(); db.close(); rmSync(directory, { recursive: true, force: true }); });
  await fetch(`${url}/api/workspaces`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: "Temporary", contextContent: "Context" }) });
  const result = spawnSync(process.execPath, ["./bin/jev-score.mjs", "db", "reset", "--yes"], { cwd: new URL("..", import.meta.url), env: { ...process.env, JEV_SCORE_DB: path }, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const dashboard = await (await fetch(`${url}/api/dashboard`)).json();
  assert.equal(dashboard.workspaces.length, 0);
});
