import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { openDatabase } from "../src/db.mjs";
import { addDocument, createGroup, createWorkspace, deleteGroup, documentDetail, evaluateDocument, listDocuments, ranking, resolveGroup, scoreMatrix, usageSummary } from "../src/service.mjs";

const temporary = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true }); });
function database() { const directory = mkdtempSync(join(tmpdir(), "jev-score-")); temporary.push(directory); return openDatabase(join(directory, "test.db")); }
function evaluator(values) { return async ({ questions }) => ({ model: "fake", provider: "test", usage: null, scores: questions.map((question, index) => ({ questionId: question.id, key: question.key, text: question.text, rawScore: values[index] / 25, score: values[index], confidence: 1, probabilities: null })) }); }

test("existing databases migrate questions to higher-is-better", () => {
  const directory = mkdtempSync(join(tmpdir(), "jev-score-legacy-"));
  temporary.push(directory);
  const path = join(directory, "legacy.db");
  const legacy = new DatabaseSync(path);
  legacy.exec(`CREATE TABLE evaluation_questions (id TEXT PRIMARY KEY, group_id TEXT NOT NULL, question_key TEXT NOT NULL, text TEXT NOT NULL, position INTEGER NOT NULL, UNIQUE (group_id, question_key)); INSERT INTO evaluation_questions VALUES ('q_1','g_1','clarity','Clarity',0); PRAGMA user_version = 1;`);
  legacy.close();
  const db = openDatabase(path);
  assert.equal(db.prepare("SELECT direction FROM evaluation_questions").get().direction, "higher");
  assert.equal(db.prepare("PRAGMA user_version").get().user_version, 3);
  db.close();
});

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
  assert.deepEqual({ runs: matrix.rows[0].runs, completedRuns: matrix.rows[0].completedRuns, evaluated: matrix.rows[0].evaluated }, { runs: 2, completedRuns: 2, evaluated: true });
  assert.deepEqual(Object.values(matrix.rows[0].scores), [62.5, 100]);
  assert.equal(documentDetail(db, workspace.id, first.id).runs[0].scores.length, 2);
  assert.equal(resolveGroup(db, group.id).locked, true); db.close();
});

test("failed Jev attempts remain unevaluated for batch evaluation", async () => {
  const db = database();
  const group = createGroup(db, { name: "Quality", questions: ["Clear"] });
  const workspace = createWorkspace(db, { name: "Draft", contextContent: "Prompt", primaryGroup: group.id });
  const document = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  await assert.rejects(evaluateDocument(db, workspace.id, document.id, { evaluate: async () => { throw new Error("Provider unavailable"); } }), /provider unavailable/i);
  let row = scoreMatrix(db, workspace.id).rows[0];
  assert.deepEqual({ runs: row.runs, completedRuns: row.completedRuns, evaluated: row.evaluated }, { runs: 1, completedRuns: 0, evaluated: false });
  await evaluateDocument(db, workspace.id, document.id, { evaluate: evaluator([80]) });
  row = scoreMatrix(db, workspace.id).rows[0];
  assert.deepEqual({ runs: row.runs, completedRuns: row.completedRuns, evaluated: row.evaluated }, { runs: 2, completedRuns: 1, evaluated: true });
  db.close();
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
  const maximum = ranking(db, workspace.id, { mode: "max" });
  assert.equal(maximum.items[0].title, "Volatile");
  assert.deepEqual(maximum.timeline, [
    { documentId: volatile.id, documentVersion: 0, documentTitle: "Volatile", parentDocumentId: null, runs: 2, score: 100, delta: 0, minDelta: -80, maxDelta: 0, frontier: 0 },
    { documentId: steady.id, documentVersion: 1, documentTitle: "Steady", parentDocumentId: null, runs: 1, score: 70, delta: -30, minDelta: -30, maxDelta: -30, frontier: 0 },
  ]);
  const middle = ranking(db, workspace.id, { mode: "median" });
  assert.equal(middle.items[0].title, "Steady");
  assert.deepEqual(middle.timeline, [
    { documentId: volatile.id, documentVersion: 0, documentTitle: "Volatile", parentDocumentId: null, runs: 2, score: 60, delta: 0, minDelta: -40, maxDelta: 40, frontier: 0 },
    { documentId: steady.id, documentVersion: 1, documentTitle: "Steady", parentDocumentId: null, runs: 1, score: 70, delta: 10, minDelta: 10, maxDelta: 10, frontier: 10 },
  ]); db.close();
});

test("lower-is-better questions invert the default mean and ranking direction", async () => {
  const db = database();
  assert.throws(() => createGroup(db, { name: "Invalid", questions: [{ text: "Risk", direction: "sideways" }] }), /direction must be higher or lower/i);
  const group = createGroup(db, { name: "Balanced", questions: [{ key: "clarity", text: "Clarity", direction: "higher" }, { key: "risk", text: "Red flags", direction: "lower" }] });
  assert.deepEqual(group.questions.map(({ key, direction }) => ({ key, direction })), [{ key: "clarity", direction: "higher" }, { key: "risk", direction: "lower" }]);
  const workspace = createWorkspace(db, { name: "Role", contextContent: "Context", primaryGroup: group.id });
  const original = addDocument(db, workspace.id, { title: "Original", content: "A" });
  const revision = addDocument(db, workspace.id, { title: "Revision", content: "B" });
  assert.equal((await evaluateDocument(db, workspace.id, original.id, { evaluate: evaluator([80, 40]) })).overallScore, 70);
  assert.equal((await evaluateDocument(db, workspace.id, revision.id, { evaluate: evaluator([75, 10]) })).overallScore, 82.5);
  await evaluateDocument(db, workspace.id, revision.id, { evaluate: evaluator([75, 20]) });
  const result = ranking(db, workspace.id, { question: "risk", mode: "max" });
  assert.equal(result.items[0].title, "Revision");
  assert.equal(result.items[0].rankScore, 10);
  assert.equal(result.items[0].delta, 30);
  assert.deepEqual(result.timeline[1], { documentId: revision.id, documentVersion: 1, documentTitle: "Revision", parentDocumentId: null, runs: 2, score: 10, delta: 30, minDelta: 20, maxDelta: 30, frontier: 30 });
  assert.equal(scoreMatrix(db, workspace.id, { mode: "max" }).rows.find((row) => row.id === revision.id).scores.risk, 10);
  db.close();
});

test("custom scorers can invert lower-is-better questions and group deletion cascades runs", async () => {
  const db = database();
  const source = `export default function score(scores) { return (scores.fit + (100 - scores.red_flags)) / 2; }`;
  const group = createGroup(db, { name: "Hiring", questions: [{ key: "fit", text: "Fit", direction: "higher" }, { key: "red_flags", text: "Red flags", direction: "lower" }], scorerSource: source });
  const workspace = createWorkspace(db, { name: "Job", contextContent: "Context", primaryGroup: group.id });
  const document = addDocument(db, workspace.id, { title: "Resume", content: "Text" });
  const run = await evaluateDocument(db, workspace.id, document.id, { evaluate: evaluator([80, 10]) });
  assert.equal(run.overallScore, 85);
  deleteGroup(db, group.id);
  assert.equal(db.prepare("SELECT count(*) count FROM evaluation_runs").get().count, 0); db.close();
});

test("usage summary totals reported Jev tokens and costs by workspace and model", async () => {
  const db = database();
  const group = createGroup(db, { name: "Quality", questions: ["Clear"] });
  const workspace = createWorkspace(db, { name: "Essay", contextContent: "Prompt", primaryGroup: group.id });
  const document = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  const measured = evaluator([75]);
  await evaluateDocument(db, workspace.id, document.id, { evaluate: async (input) => ({ ...(await measured(input)), model: "typesafe/jev-test", provider: "TypeSafe", usage: { input_tokens: 120, output_tokens: 30, cost: 0.00125 } }) });
  await evaluateDocument(db, workspace.id, document.id, { evaluate: evaluator([80]) });
  const usage = usageSummary(db);
  assert.deepEqual(usage.total, { runs: 2, reportedRuns: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0.00125, costRuns: 1 });
  assert.deepEqual(usage.workspaces[0], { id: workspace.id, name: "Essay", runs: 2, reportedRuns: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0.00125, costRuns: 1 });
  assert.deepEqual(usage.models.find((model) => model.model === "typesafe/jev-test"), { model: "typesafe/jev-test", provider: "TypeSafe", runs: 1, reportedRuns: 1, inputTokens: 120, outputTokens: 30, totalTokens: 150, cost: 0.00125, costRuns: 1 });
  db.close();
});
