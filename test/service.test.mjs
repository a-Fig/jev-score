import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db.mjs";
import { addDocument, createGroup, createWorkspace, deleteGroup, documentDetail, evaluateDocument, listDocuments, ranking, resolveGroup, scoreMatrix } from "../src/service.mjs";

const temporary = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true }); });
function database() { const directory = mkdtempSync(join(tmpdir(), "jev-score-")); temporary.push(directory); return openDatabase(join(directory, "test.db")); }
function evaluator(values) { return async ({ questions }) => ({ model: "fake", provider: "test", usage: null, scores: questions.map((question, index) => ({ questionId: question.id, key: question.key, text: question.text, rawScore: values[index] / 25, score: values[index], confidence: 1, probabilities: null })) }); }

test("documents deduplicate by normalized content while every evaluation is retained", async () => {
  const db = database();
  const group = createGroup(db, { name: "Quality", questions: ["Clear", "Specific"] });
  const workspace = createWorkspace(db, { name: "Application", contextContent: "Job", primaryGroup: group.id });
  assert.throws(() => addDocument(db, workspace.id, {}), /content is required/i);
  const first = addDocument(db, workspace.id, { title: "Original", content: "Hello\r\nworld" });
  const duplicate = addDocument(db, workspace.id, { title: "Copy", content: "Hello\nworld" });
  assert.equal(first.version, 0); assert.equal(duplicate.id, first.id); assert.equal(duplicate.version, 0); assert.equal(duplicate.deduplicated, true);
  await evaluateDocument(db, workspace.id, first.id, { evaluate: evaluator([50, 100]) });
  await evaluateDocument(db, workspace.id, first.id, { evaluate: evaluator([75, 100]) });
  const result = ranking(db, workspace.id);
  assert.equal(listDocuments(db, workspace.id).length, 1);
  assert.deepEqual({ runs: result.items[0].runs, min: result.items[0].min, max: result.items[0].max, median: result.items[0].median }, { runs: 2, min: 75, max: 87.5, median: 81.3 });
  const matrix = scoreMatrix(db, workspace.id, { mode: "median" });
  assert.equal(matrix.rows[0].overallScore, 81.3);
  assert.deepEqual(Object.values(matrix.rows[0].scores), [62.5, 100]);
  assert.equal(documentDetail(db, workspace.id, first.id).runs[0].scores.length, 2);
  assert.equal(resolveGroup(db, group.id).locked, true); db.close();
});

test("max and median modes select different best documents", async () => {
  const db = database();
  const group = createGroup(db, { name: "Fit", questions: ["Strong fit"] });
  const workspace = createWorkspace(db, { name: "Role", contextContent: "Context", primaryGroup: group.id });
  const volatile = addDocument(db, workspace.id, { title: "Volatile", content: "A" });
  const steady = addDocument(db, workspace.id, { title: "Steady", content: "B" });
  assert.deepEqual([volatile.version, steady.version], [0, 1]);
  await evaluateDocument(db, workspace.id, volatile.id, { evaluate: evaluator([100]) });
  await evaluateDocument(db, workspace.id, volatile.id, { evaluate: evaluator([20]) });
  await evaluateDocument(db, workspace.id, steady.id, { evaluate: evaluator([70]) });
  assert.equal(ranking(db, workspace.id, { mode: "max" }).items[0].title, "Volatile");
  assert.equal(ranking(db, workspace.id, { mode: "median" }).items[0].title, "Steady"); db.close();
});

test("custom scorers can invert lower-is-better questions and group deletion cascades runs", async () => {
  const db = database();
  const source = `export default function score(scores) { return (scores.fit + (100 - scores.red_flags)) / 2; }`;
  const group = createGroup(db, { name: "Hiring", questions: [{ key: "fit", text: "Fit" }, { key: "red_flags", text: "Red flags" }], scorerSource: source });
  const workspace = createWorkspace(db, { name: "Job", contextContent: "Context", primaryGroup: group.id });
  const document = addDocument(db, workspace.id, { title: "Resume", content: "Text" });
  const run = await evaluateDocument(db, workspace.id, document.id, { evaluate: evaluator([80, 10]) });
  assert.equal(run.overallScore, 85);
  deleteGroup(db, group.id);
  assert.equal(db.prepare("SELECT count(*) count FROM evaluation_runs").get().count, 0); db.close();
});
