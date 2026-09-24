import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateScores } from "../src/aggregate.mjs";
import { checkOpenRouterKey, evaluateWithJev } from "../src/jev.mjs";

const questions = [{ id: "q1", key: "clarity", text: "Clear?" }];
const ok = (answers) => new Response(JSON.stringify({ model: "typesafe/jev-test", answers }), { status: 200, headers: { "Content-Type": "application/json" } });
const noSleep = async () => {};

test("invalid provider and aggregate scores are rejected", async () => {
  const fetchImpl = async () => ok({ clarity: { score: 999 } });
  await assert.rejects(evaluateWithJev({ document: "Text", context: "Context", questions, apiKey: "test", fetchImpl }), /invalid score/i);
  await assert.rejects(aggregateScores({ scorerKind: "mean-v1" }, [{ key: "clarity", score: Infinity }]), /0 to 100/i);
});

test("rate limits and server errors are retried, honoring Retry-After", async () => {
  const delays = [];
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    if (calls === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } });
    if (calls === 2) return new Response("busy", { status: 503 });
    return ok({ clarity: { score: 3 } });
  };
  const result = await evaluateWithJev({ document: "Text", questions, apiKey: "test", fetchImpl, sleep: async (ms) => { delays.push(ms); } });
  assert.equal(calls, 3);
  assert.equal(delays[0], 2000);
  assert.ok(delays[1] > 0 && delays[1] <= 8000);
  assert.equal(result.scores[0].score, 75);
});

test("network failures are retried and then reported with the attempt count", async () => {
  let calls = 0;
  const fetchImpl = async () => { calls += 1; throw new TypeError("fetch failed"); };
  await assert.rejects(evaluateWithJev({ document: "Text", questions, apiKey: "test", fetchImpl, retries: 2, sleep: noSleep }), /after 3 attempts: fetch failed/);
  assert.equal(calls, 3);
});

test("bad keys and missing credits fail at once with a readable message", async () => {
  let calls = 0;
  const unauthorized = async () => { calls += 1; return new Response("no auth", { status: 401 }); };
  await assert.rejects(evaluateWithJev({ document: "Text", questions, apiKey: "test", fetchImpl: unauthorized, sleep: noSleep }), /rejected the API key \(401\)/);
  assert.equal(calls, 1);
  const broke = async () => new Response("pay up", { status: 402 });
  await assert.rejects(evaluateWithJev({ document: "Text", questions, apiKey: "test", fetchImpl: broke, sleep: noSleep }), /insufficient credits \(402\)/);
  await assert.rejects(evaluateWithJev({ document: "Text", questions, apiKey: "", fetchImpl: broke }), /OPENROUTER_API_KEY is required/);
});

test("the key check reports usage without running an evaluation", async () => {
  const seen = [];
  const fetchImpl = async (url, options) => { seen.push([url, options.headers.Authorization]); return new Response(JSON.stringify({ data: { label: "laptop", usage: 1.25, limit: 10, limit_remaining: 8.75 } }), { status: 200 }); };
  assert.deepEqual(await checkOpenRouterKey({ apiKey: "sk-test", fetchImpl }), { ok: true, label: "laptop", usage: 1.25, limit: 10, limitRemaining: 8.75 });
  assert.deepEqual(seen, [["https://openrouter.ai/api/v1/key", "Bearer sk-test"]]);
  assert.equal((await checkOpenRouterKey({ apiKey: "bad", fetchImpl: async () => new Response("", { status: 401 }) })).ok, false);
  assert.equal((await checkOpenRouterKey({ apiKey: "" })).ok, false);
});
