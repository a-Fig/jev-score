import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { openDatabase } from "../src/db.mjs";
import {
  activity, addDocument, contextHistory, createGroup, createWorkspace, deleteDocument, deleteWorkspace, documentDetail,
  evaluateDocument, exportWorkspace, forkGroup, importWorkspace, listDocuments, matrixCsv, ranking, resetSpendCounter,
  resolveDocument, resolveGroup, resolveWorkspace, scoreDocument, scoreMatrix, setSpendLimit, spendStatus, updateDocument,
  updateGroup, updateWorkspace, usageSummary,
} from "../src/service.mjs";
import { TEMPLATES } from "../src/templates.mjs";

const temporary = [];
afterEach(() => { while (temporary.length) rmSync(temporary.pop(), { recursive: true, force: true }); });
function database() { const directory = mkdtempSync(join(tmpdir(), "jev-score-")); temporary.push(directory); return openDatabase(join(directory, "test.db")); }
// Scores each question from a list, one list per call, so a test controls every run.
function sequence(...runs) {
  let call = 0;
  return async ({ questions }) => {
    const values = runs[Math.min(call++, runs.length - 1)];
    return { model: "fake", provider: "test", usage: { input_tokens: 100, output_tokens: 10, cost: 0.01 }, scores: questions.map((question, index) => ({ questionId: question.id, key: question.key, text: question.text, rawScore: values[index] / 25, score: values[index], confidence: 1, probabilities: null })) };
  };
}

function setup(db, questions = [{ key: "fit", text: "Fit" }, { key: "evidence", text: "Evidence" }, { key: "flags", text: "Red flags", direction: "lower" }]) {
  const group = createGroup(db, { name: "Review", questions });
  const workspace = createWorkspace(db, { name: "Role", contextContent: "Job posting", primaryGroup: group.id });
  return { group, workspace };
}

test("versions stay stable after deletion and drafts resolve by #version", () => {
  const db = database();
  const { workspace } = setup(db);
  const [a, b, c] = ["One", "Two", "Three"].map((title) => addDocument(db, workspace.id, { title, content: title }));
  assert.deepEqual([a.version, b.version, c.version], [0, 1, 2]);
  assert.equal(resolveDocument(db, workspace.id, "#2").id, c.id);
  assert.equal(resolveDocument(db, workspace.id, "1").id, b.id);
  deleteDocument(db, workspace.id, a.id);
  assert.equal(resolveDocument(db, workspace.id, c.id).version, 2);
  assert.equal(resolveDocument(db, workspace.id, b.id).isOriginal, true, "the oldest remaining draft becomes the original");
  assert.equal(addDocument(db, workspace.id, { title: "Four", content: "Four" }).version, 3);
  deleteDocument(db, workspace.id, "#3");
  assert.equal(addDocument(db, workspace.id, { title: "Five", content: "Five" }).version, 4, "a deleted newest number is not reused");
  addDocument(db, workspace.id, { title: "Four", content: "Four again" });
  updateDocument(db, workspace.id, "#5", { original: true, title: "Fourth", changeSummary: "Renamed" });
  assert.deepEqual(listDocuments(db, workspace.id).filter((item) => item.isOriginal).map((item) => item.title), ["Fourth"]);
  assert.throws(() => resolveDocument(db, workspace.id, "#9"), (error) => error.status === 404);
  db.close();
});

test("editing the context marks earlier runs stale, and restoring it brings them back", async () => {
  const db = database();
  const { workspace } = setup(db);
  const draft = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  await evaluateDocument(db, workspace.id, draft.id, { evaluate: sequence([80, 70, 20]) });
  let updated = updateWorkspace(db, workspace.id, { contextContent: "A different posting", contextTitle: "New posting" });
  assert.deepEqual([updated.runCount, updated.staleRunCount, updated.contextVersions], [0, 1, 2]);
  assert.equal(ranking(db, workspace.id).items[0].rankScore, null);
  assert.equal(scoreMatrix(db, workspace.id).rows[0].evaluated, false);
  assert.equal(scoreMatrix(db, workspace.id).rows[0].staleRuns, 1);
  assert.equal(documentDetail(db, workspace.id, draft.id).runs[0].stale, true);
  await evaluateDocument(db, workspace.id, draft.id, { evaluate: sequence([90, 90, 10]) });
  assert.equal(ranking(db, workspace.id).items[0].rankScore, 90);
  const old = contextHistory(db, workspace.id).find((context) => !context.current);
  updated = updateWorkspace(db, workspace.id, { contextContent: old.content, contextTitle: old.title });
  assert.deepEqual([updated.runCount, updated.staleRunCount, updated.contextVersions], [1, 1, 2]);
  assert.equal(ranking(db, workspace.id).items[0].rankScore, 76.7);
  db.close();
});

test("questions are editable until a scored run exists; forks copy everything", async () => {
  const db = database();
  const { group, workspace } = setup(db);
  const edited = updateGroup(db, group.id, { questions: [{ key: "fit", text: "Strong fit" }], description: "Short" });
  assert.deepEqual(edited.questions.map((question) => question.text), ["Strong fit"]);
  const draft = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  await assert.rejects(evaluateDocument(db, workspace.id, draft.id, { evaluate: async () => { throw new Error("Provider down"); } }));
  assert.equal(resolveGroup(db, group.id).locked, false, "a failed call stores no scores, so it does not lock");
  await evaluateDocument(db, workspace.id, draft.id, { evaluate: sequence([80]) });
  assert.equal(resolveGroup(db, group.id).locked, true);
  assert.throws(() => updateGroup(db, group.id, { questions: ["Other"] }), /locked. Fork it/);
  assert.equal(updateGroup(db, group.id, { name: "Renamed" }).name, "Renamed");
  const fork = forkGroup(db, group.id);
  assert.equal(fork.name, "Renamed (fork)");
  assert.equal(fork.locked, false);
  assert.deepEqual(fork.questions.map(({ key, text }) => ({ key, text })), [{ key: "fit", text: "Strong fit" }]);
  assert.throws(() => createGroup(db, { name: "renamed", questions: ["X"] }), (error) => error.status === 409);
  db.close();
});

test("templates create editable groups with stable keys and unique names", () => {
  const db = database();
  assert.ok(TEMPLATES.length >= 8);
  for (const template of TEMPLATES) {
    assert.ok(template.questions.some((question) => question.direction === "lower"), `${template.id} has a lower-is-better question`);
    assert.equal(new Set(template.questions.map((question) => question.key)).size, template.questions.length);
  }
  const first = createGroup(db, { template: "resume" });
  const second = createGroup(db, { template: "resume" });
  assert.deepEqual([first.name, second.name], ["Resume review", "Resume review (2)"]);
  assert.equal(first.questions[0].key, "role_fit");
  assert.throws(() => createGroup(db, { template: "sonnet" }), /Template not found/);
  db.close();
});

test("scoring returns deltas against the parent and best, and the weakest questions", async () => {
  const db = database();
  const { workspace } = setup(db);
  const original = addDocument(db, workspace.id, { title: "Original", content: "A" });
  await evaluateDocument(db, workspace.id, original.id, { evaluate: sequence([60, 50, 40]) });
  const revision = addDocument(db, workspace.id, { title: "Revision", content: "B", parentDocument: "#0", changeSummary: "More evidence" });
  const feedback = await scoreDocument(db, workspace.id, revision.id, { runs: 3, evaluate: sequence([70, 80, 30], [74, 70, 20], [90, 90, 10]) });
  assert.equal(feedback.runs, 3);
  assert.equal(feedback.status, "success");
  assert.deepEqual(feedback.range, { min: 73.3, max: 90 });
  assert.equal(feedback.overallScore, 74.7);
  assert.equal(feedback.isBest, true);
  assert.equal(feedback.parent.version, 0);
  assert.equal(feedback.vsParent, 18);
  assert.equal(feedback.best.version, 0, "best compares against the best other draft");
  assert.equal(feedback.rank, 1);
  const flags = feedback.scores.find((item) => item.key === "flags");
  assert.deepEqual({ score: flags.score, vsParent: flags.vsParent }, { score: 20, vsParent: 20 }, "lower-is-better deltas are positive when the score falls");
  assert.deepEqual(feedback.weakest.map((item) => item.key), ["fit", "evidence", "flags"]);
  await assert.rejects(scoreDocument(db, workspace.id, revision.id, { runs: 11 }), /1 to 10/);
  db.close();
});

test("partial failures keep successful runs and report the errors", async () => {
  const db = database();
  const { workspace } = setup(db, ["Fit"]);
  const draft = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  let call = 0;
  const flaky = async (input) => { call += 1; if (call === 2) throw new Error("Provider hiccup"); return sequence([80])(input); };
  const feedback = await scoreDocument(db, workspace.id, draft.id, { runs: 3, concurrency: 1, evaluate: flaky });
  assert.equal(feedback.status, "partial");
  assert.equal(feedback.runs, 3);
  assert.equal(feedback.errors.length, 1);
  assert.match(feedback.errors[0].error, /hiccup/);
  assert.equal(feedback.overallScore, 80);
  await assert.rejects(scoreDocument(db, workspace.id, draft.id, { evaluate: async () => { throw new Error("All down"); } }), (error) => error.runIds?.length === 1);
  db.close();
});

test("the spend limit stops scoring and survives workspace deletion", async () => {
  const db = database();
  const { workspace } = setup(db, ["Fit"]);
  const draft = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  setSpendLimit(db, 0.015);
  await evaluateDocument(db, workspace.id, draft.id, { evaluate: sequence([80]) });
  await evaluateDocument(db, workspace.id, draft.id, { evaluate: sequence([80]) });
  assert.equal(spendStatus(db).exceeded, true);
  await assert.rejects(evaluateDocument(db, workspace.id, draft.id, { evaluate: sequence([80]) }), (error) => error.status === 402 && /Spend limit reached/.test(error.message));
  assert.equal(activity(db).length, 0, "a refused run leaves no activity behind");
  deleteWorkspace(db, workspace.id);
  assert.equal(spendStatus(db).spent, 0.02, "the ledger keeps spend after deletion");
  assert.equal(usageSummary(db).lifetime.cost, 0.02);
  resetSpendCounter(db);
  assert.equal(spendStatus(db).exceeded, false);
  assert.equal(spendStatus(db, { JEV_SCORE_SPEND_LIMIT: "0" }).source, "env");
  assert.throws(() => setSpendLimit(db, -1), /0 or more/);
  assert.equal(setSpendLimit(db, null).limit, null);
  db.close();
});

test("activity shows evaluations in progress and clears when they finish", async () => {
  const db = database();
  const { workspace } = setup(db, ["Fit"]);
  const draft = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  let during = null;
  await evaluateDocument(db, workspace.id, draft.id, { source: "mcp", evaluate: async (input) => { during = activity(db, workspace.id); return sequence([70])(input); } });
  assert.deepEqual(during.map(({ documentVersion, source, workspaceName }) => ({ documentVersion, source, workspaceName })), [{ documentVersion: 0, source: "mcp", workspaceName: "Role" }]);
  assert.equal(activity(db).length, 0);
  db.close();
});

test("scoring without an API key fails before recording a run", async () => {
  const db = database();
  const { workspace } = setup(db, ["Fit"]);
  const draft = addDocument(db, workspace.id, { title: "Draft", content: "Text" });
  const saved = process.env.OPENROUTER_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  try { await assert.rejects(evaluateDocument(db, workspace.id, draft.id), /OPENROUTER_API_KEY is required/); }
  finally { if (saved !== undefined) process.env.OPENROUTER_API_KEY = saved; }
  assert.equal(resolveWorkspace(db, workspace.id).runCount, 0);
  db.close();
});

test("export and import round-trip drafts, lineage, contexts, and runs", async () => {
  const db = database();
  const { workspace } = setup(db);
  const a = addDocument(db, workspace.id, { title: "A", content: "Alpha" });
  const b = addDocument(db, workspace.id, { title: "B", content: "Beta", parentDocument: a.id, changeSummary: "Rewrote it" });
  deleteDocument(db, workspace.id, addDocument(db, workspace.id, { title: "Gone", content: "Gone" }).id);
  const c = addDocument(db, workspace.id, { title: "C", content: "Gamma", parentDocument: b.id });
  await evaluateDocument(db, workspace.id, a.id, { evaluate: sequence([50, 50, 50]) });
  updateWorkspace(db, workspace.id, { contextContent: "Second posting" });
  await evaluateDocument(db, workspace.id, c.id, { evaluate: sequence([90, 80, 10]) });
  const bundle = JSON.parse(JSON.stringify(exportWorkspace(db, workspace.id, { appVersion: "test" })));
  const copy = importWorkspace(db, bundle);
  assert.equal(copy.name, "Role (2)");
  assert.deepEqual([copy.documentCount, copy.runCount, copy.staleRunCount, copy.contextVersions], [3, 1, 1, 2]);
  assert.deepEqual(listDocuments(db, copy.id).map((item) => item.version), [0, 1, 3]);
  const importedC = resolveDocument(db, copy.id, "#3");
  assert.equal(resolveDocument(db, copy.id, importedC.parentDocumentId).title, "B");
  assert.equal(copy.groups.length, 1, "an identical group is reused rather than duplicated");
  assert.deepEqual(ranking(db, copy.id).items.map((item) => item.rankScore), ranking(db, workspace.id).items.map((item) => item.rankScore));
  assert.throws(() => importWorkspace(db, { format: "other" }), /not a Jev Score workspace export/);
  bundle.groups[0].scorerSource = "export default () => 1";
  assert.throws(() => importWorkspace(db, bundle), /custom scorer code/);
  assert.equal(importWorkspace(db, bundle, { allowScorer: true, name: "With scorer" }).name, "With scorer");
  db.close();
});

test("CSV export escapes commas, quotes, and newlines", async () => {
  const db = database();
  const { workspace } = setup(db, ["Fit"]);
  const draft = addDocument(db, workspace.id, { title: 'Draft, "quoted"', content: "Text", changeSummary: "Line one\nline two" });
  await evaluateDocument(db, workspace.id, draft.id, { evaluate: sequence([80]) });
  const csv = matrixCsv(db, workspace.id);
  const [header, row] = csv.trim().split("\n", 2);
  assert.equal(header, "version,title,original,best,runs,overall,fit (higher),change_summary,created_at");
  assert.ok(row.startsWith('0,"Draft, ""quoted""",true,true,1,80,80,"Line one'));
  db.close();
});
