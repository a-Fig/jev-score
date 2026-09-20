import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregateScores } from "../src/aggregate.mjs";
import { evaluateWithJev } from "../src/jev.mjs";

test("invalid provider and aggregate scores are rejected", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ answers: { clarity: { score: 999 } } }), { status: 200, headers: { "Content-Type": "application/json" } });
  await assert.rejects(evaluateWithJev({ document: "Text", context: "Context", questions: [{ id: "q1", key: "clarity", text: "Clear?" }], apiKey: "test", fetchImpl }), /invalid score/i);
  await assert.rejects(aggregateScores({ scorerKind: "mean-v1" }, [{ key: "clarity", score: Infinity }]), /0 to 100/i);
});
