import { createHash, randomUUID } from "node:crypto";
import { aggregateScores } from "./aggregate.mjs";
import { evaluateWithJev } from "./jev.mjs";
import { inTransaction } from "./db.mjs";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const json = (value, fallback = {}) => {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") return JSON.parse(value);
  return value;
};
const parseJson = (value) => value ? JSON.parse(value) : null;
const normalize = (text) => String(text).replace(/\r\n?/g, "\n");
const hash = (text) => createHash("sha256").update(normalize(text)).digest("hex");
const median = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const round = (value) => Math.round(value * 10) / 10;

function uniqueKeys(questions) {
  const used = new Set();
  return questions.map((entry, index) => {
    if (typeof entry !== "string" && (typeof entry !== "object" || entry === null || typeof entry.text !== "string")) throw new Error(`Question ${index + 1} must be text or an object with text.`);
    const text = typeof entry === "string" ? entry.trim() : entry.text.trim();
    if (!text) throw new Error(`Question ${index + 1} is empty.`);
    let key = typeof entry === "object" && entry.key
      ? String(entry.key).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
      : text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42);
    if (!key) key = `question-${index + 1}`;
    const base = key;
    let suffix = 2;
    while (used.has(key)) key = `${base}-${suffix++}`;
    used.add(key);
    return { key, text };
  });
}

function groupFromRow(db, row) {
  if (!row) return null;
  const questions = db.prepare(`SELECT id, question_key AS key, text, position FROM evaluation_questions WHERE group_id = ? ORDER BY position`).all(row.id);
  return {
    id: row.id, name: row.name, description: row.description,
    scorerKind: row.scorer_kind, scorerSource: row.scorer_source, scorerHash: row.scorer_hash,
    createdAt: row.created_at, updatedAt: row.updated_at, questions,
    locked: Boolean(db.prepare(`SELECT 1 FROM evaluation_runs WHERE group_id = ? LIMIT 1`).get(row.id)),
  };
}

export function resolveGroup(db, reference) {
  const row = db.prepare(`SELECT * FROM evaluation_groups WHERE id = ? OR lower(name) = lower(?) ORDER BY id = ? DESC LIMIT 1`).get(reference, reference, reference);
  if (!row) throw new Error(`Evaluation group not found: ${reference}`);
  return groupFromRow(db, row);
}

export function listGroups(db) {
  return db.prepare(`SELECT * FROM evaluation_groups ORDER BY lower(name)`).all().map((row) => groupFromRow(db, row));
}

export function createGroup(db, { name, description = "", questions, scorerSource = null }) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Group name is required.");
  if (!Array.isArray(questions) || !questions.length) throw new Error("At least one question is required.");
  const cleanQuestions = uniqueKeys(questions);
  const groupId = id("grp");
  const timestamp = now();
  const source = scorerSource ? String(scorerSource) : null;
  inTransaction(db, () => {
    db.prepare(`INSERT INTO evaluation_groups (id,name,description,scorer_kind,scorer_source,scorer_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(groupId, String(name).trim(), String(description), source ? "javascript-v1" : "mean-v1", source, source ? hash(source) : null, timestamp, timestamp);
    const insert = db.prepare(`INSERT INTO evaluation_questions (id,group_id,question_key,text,position) VALUES (?,?,?,?,?)`);
    cleanQuestions.forEach((question, index) => insert.run(id("q"), groupId, question.key, question.text, index));
  });
  return resolveGroup(db, groupId);
}

export function renameGroup(db, reference, name) {
  const group = resolveGroup(db, reference);
  if (typeof name !== "string" || !name.trim()) throw new Error("Group name is required.");
  db.prepare(`UPDATE evaluation_groups SET name = ?, updated_at = ? WHERE id = ?`).run(String(name).trim(), now(), group.id);
  return resolveGroup(db, group.id);
}

export function deleteGroup(db, reference) {
  const group = resolveGroup(db, reference);
  db.prepare(`DELETE FROM evaluation_groups WHERE id = ?`).run(group.id);
  return { deleted: group.id, name: group.name };
}

function workspaceFromRow(db, row) {
  if (!row) return null;
  const groups = db.prepare(`SELECT g.id, g.name FROM workspace_groups wg JOIN evaluation_groups g ON g.id=wg.group_id WHERE wg.workspace_id=? ORDER BY lower(g.name)`).all(row.id);
  const counts = db.prepare(`SELECT (SELECT count(*) FROM documents WHERE workspace_id=?) documents, (SELECT count(*) FROM evaluation_runs WHERE workspace_id=?) runs`).get(row.id, row.id);
  return {
    id: row.id, name: row.name, contextTitle: row.context_title, contextContent: row.context_content,
    primaryGroupId: row.primary_group_id, rankingMode: row.ranking_mode,
    createdAt: row.created_at, updatedAt: row.updated_at, groups,
    documentCount: counts.documents, runCount: counts.runs,
  };
}

export function resolveWorkspace(db, reference) {
  const row = db.prepare(`SELECT * FROM workspaces WHERE id = ? OR lower(name) = lower(?) ORDER BY id = ? DESC LIMIT 1`).get(reference, reference, reference);
  if (!row) throw new Error(`Workspace not found: ${reference}`);
  return workspaceFromRow(db, row);
}

export function listWorkspaces(db) {
  return db.prepare(`SELECT * FROM workspaces ORDER BY updated_at DESC`).all().map((row) => workspaceFromRow(db, row));
}

export function createWorkspace(db, { name, contextTitle = "Context", contextContent, primaryGroup = null }) {
  if (typeof name !== "string" || !name.trim()) throw new Error("Workspace name is required.");
  if (typeof contextContent !== "string" || !contextContent.trim()) throw new Error("Workspace context is required.");
  const group = primaryGroup ? resolveGroup(db, primaryGroup) : null;
  const workspaceId = id("ws");
  const timestamp = now();
  inTransaction(db, () => {
    db.prepare(`INSERT INTO workspaces (id,name,context_title,context_content,primary_group_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)`)
      .run(workspaceId, String(name).trim(), String(contextTitle || "Context").trim(), normalize(contextContent), group?.id || null, timestamp, timestamp);
    if (group) db.prepare(`INSERT INTO workspace_groups (workspace_id,group_id,attached_at) VALUES (?,?,?)`).run(workspaceId, group.id, timestamp);
  });
  return resolveWorkspace(db, workspaceId);
}

export function updateWorkspace(db, reference, changes) {
  const workspace = resolveWorkspace(db, reference);
  if (changes.primaryGroup !== undefined) {
    const group = changes.primaryGroup ? resolveGroup(db, changes.primaryGroup) : null;
    if (group) db.prepare(`INSERT OR IGNORE INTO workspace_groups VALUES (?,?,?)`).run(workspace.id, group.id, now());
    db.prepare(`UPDATE workspaces SET primary_group_id=?, updated_at=? WHERE id=?`).run(group?.id || null, now(), workspace.id);
  }
  if (changes.rankingMode !== undefined) {
    if (!["max", "median"].includes(changes.rankingMode)) throw new Error("Ranking mode must be max or median.");
    db.prepare(`UPDATE workspaces SET ranking_mode=?, updated_at=? WHERE id=?`).run(changes.rankingMode, now(), workspace.id);
  }
  if (changes.name !== undefined) db.prepare(`UPDATE workspaces SET name=?, updated_at=? WHERE id=?`).run(String(changes.name).trim(), now(), workspace.id);
  return resolveWorkspace(db, workspace.id);
}

export function attachGroup(db, workspaceRef, groupRef) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const group = resolveGroup(db, groupRef);
  db.prepare(`INSERT OR IGNORE INTO workspace_groups VALUES (?,?,?)`).run(workspace.id, group.id, now());
  return resolveWorkspace(db, workspace.id);
}

export function deleteWorkspace(db, reference) {
  const workspace = resolveWorkspace(db, reference);
  db.prepare(`DELETE FROM workspaces WHERE id=?`).run(workspace.id);
  return { deleted: workspace.id, name: workspace.name };
}

function documentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, contentHash: row.content_hash, content: row.content,
    title: row.title, changeSummary: row.change_summary, metadata: parseJson(row.metadata_json) || {},
    parentDocumentId: row.parent_document_id, isOriginal: Boolean(row.is_original), version: Number(row.version_number), createdAt: row.created_at,
  };
}

export function resolveDocument(db, workspaceRef, reference) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const row = db.prepare(`SELECT * FROM (SELECT d.*,row_number() OVER (ORDER BY d.rowid)-1 version_number FROM documents d WHERE workspace_id=?) WHERE id=? OR lower(title)=lower(?) ORDER BY id=? DESC LIMIT 1`).get(workspace.id, reference, reference, reference);
  if (!row) throw new Error(`Document not found in ${workspace.name}: ${reference}`);
  return documentFromRow(row);
}

export function addDocument(db, workspaceRef, { content, title = "Untitled", changeSummary = "", metadata = {}, parentDocument = null, original = false }) {
  const workspace = resolveWorkspace(db, workspaceRef);
  if (typeof content !== "string" || !content.trim()) throw new Error("Document content is required.");
  if (typeof title !== "string" || !title.trim()) throw new Error("Document title is required.");
  const cleanContent = normalize(content);
  const contentHash = hash(cleanContent);
  const parent = parentDocument ? resolveDocument(db, workspace.id, parentDocument) : null;
  return inTransaction(db, () => {
    const existing = db.prepare(`SELECT * FROM documents WHERE workspace_id=? AND content_hash=?`).get(workspace.id, contentHash);
    if (existing) return { ...resolveDocument(db, workspace.id, existing.id), deduplicated: true };
    const count = db.prepare(`SELECT count(*) count FROM documents WHERE workspace_id=?`).get(workspace.id).count;
    const isOriginal = original || count === 0;
    const documentId = id("doc");
    db.prepare(`INSERT INTO documents (id,workspace_id,content_hash,content,title,change_summary,metadata_json,parent_document_id,is_original,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(documentId, workspace.id, contentHash, cleanContent, title.trim(), String(changeSummary), JSON.stringify(json(metadata)), parent?.id || null, isOriginal ? 1 : 0, now());
    return { ...resolveDocument(db, workspace.id, documentId), deduplicated: false };
  });
}

export function listDocuments(db, workspaceRef, { includeContent = false } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  return db.prepare(`SELECT * FROM (SELECT d.*,row_number() OVER (ORDER BY d.rowid)-1 version_number FROM documents d WHERE workspace_id=?) ORDER BY version_number`).all(workspace.id).map((row) => {
    const item = documentFromRow(row);
    if (!includeContent) delete item.content;
    return item;
  });
}

export function documentDetail(db, workspaceRef, documentRef) {
  const document = resolveDocument(db, workspaceRef, documentRef);
  const runs = db.prepare(`SELECT id FROM evaluation_runs WHERE document_id=? ORDER BY created_at DESC`).all(document.id).map(({ id }) => getRun(db, id));
  return { ...document, runs };
}

export async function evaluateDocument(db, workspaceRef, documentRef, { group: groupRef = null, note = "", metadata = {}, evaluate = evaluateWithJev } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const document = resolveDocument(db, workspace.id, documentRef);
  const group = resolveGroup(db, groupRef || workspace.primaryGroupId || "");
  db.prepare(`INSERT OR IGNORE INTO workspace_groups VALUES (?,?,?)`).run(workspace.id, group.id, now());
  const runId = id("run");
  let result;
  try {
    result = await evaluate({ document: document.content, context: workspace.contextContent, questions: group.questions });
  } catch (error) {
    db.prepare(`INSERT INTO evaluation_runs (id,workspace_id,document_id,group_id,status,note,metadata_json,error,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(runId, workspace.id, document.id, group.id, "jev_error", String(note), JSON.stringify(json(metadata)), error.message, now());
    error.runId = runId;
    throw error;
  }
  let overall = null;
  let aggregationError = null;
  try { overall = await aggregateScores(group, result.scores); }
  catch (error) { aggregationError = error.message; }
  inTransaction(db, () => {
    db.prepare(`INSERT INTO evaluation_runs (id,workspace_id,document_id,group_id,status,overall_score,model,provider,note,metadata_json,usage_json,aggregation_error,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(runId, workspace.id, document.id, group.id, aggregationError ? "aggregation_error" : "success", overall, result.model || null, result.provider || null, String(note), JSON.stringify(json(metadata)), result.usage ? JSON.stringify(result.usage) : null, aggregationError, now());
    const insert = db.prepare(`INSERT INTO evaluation_scores (run_id,question_id,raw_score,normalized_score,confidence,probabilities_json) VALUES (?,?,?,?,?,?)`);
    result.scores.forEach((score) => insert.run(runId, score.questionId, score.rawScore, score.score, score.confidence, score.probabilities ? JSON.stringify(score.probabilities) : null));
  });
  return getRun(db, runId);
}

export function getRun(db, runId) {
  const row = db.prepare(`SELECT r.*, d.title document_title, g.name group_name FROM evaluation_runs r JOIN documents d ON d.id=r.document_id JOIN evaluation_groups g ON g.id=r.group_id WHERE r.id=?`).get(runId);
  if (!row) throw new Error(`Evaluation run not found: ${runId}`);
  const scores = db.prepare(`SELECT q.question_key key,q.text,s.raw_score rawScore,s.normalized_score score,s.confidence,s.probabilities_json probabilities FROM evaluation_scores s JOIN evaluation_questions q ON q.id=s.question_id WHERE s.run_id=? ORDER BY q.position`).all(runId)
    .map((score) => ({ ...score, probabilities: parseJson(score.probabilities) }));
  return {
    id: row.id, workspaceId: row.workspace_id, documentId: row.document_id, documentTitle: row.document_title,
    groupId: row.group_id, groupName: row.group_name, status: row.status, overallScore: row.overall_score,
    model: row.model, provider: row.provider, note: row.note, metadata: parseJson(row.metadata_json) || {},
    usage: parseJson(row.usage_json), aggregationError: row.aggregation_error, error: row.error,
    createdAt: row.created_at, scores,
  };
}

export function ranking(db, workspaceRef, { group: groupRef = null, question = null, mode = null } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const group = resolveGroup(db, groupRef || workspace.primaryGroupId || "");
  const rankingMode = mode || workspace.rankingMode;
  if (!["max", "median"].includes(rankingMode)) throw new Error("Ranking mode must be max or median.");
  let questionInfo = null;
  if (question) {
    questionInfo = group.questions.find((item) => item.id === question || item.key === question || item.text.toLowerCase() === String(question).toLowerCase());
    if (!questionInfo) throw new Error(`Question not found in ${group.name}: ${question}`);
  }
  const rows = questionInfo
    ? db.prepare(`SELECT r.id run_id,r.document_id,r.created_at,s.normalized_score value FROM evaluation_runs r JOIN evaluation_scores s ON s.run_id=r.id WHERE r.workspace_id=? AND r.group_id=? AND s.question_id=?`).all(workspace.id, group.id, questionInfo.id)
    : db.prepare(`SELECT id run_id,document_id,created_at,overall_score value FROM evaluation_runs WHERE workspace_id=? AND group_id=? AND status='success' AND overall_score IS NOT NULL`).all(workspace.id, group.id);
  const documents = listDocuments(db, workspace.id);
  const byDocument = new Map();
  rows.forEach((row) => {
    if (!byDocument.has(row.document_id)) byDocument.set(row.document_id, []);
    byDocument.get(row.document_id).push(Number(row.value));
  });
  const items = documents.map((document) => {
    const values = byDocument.get(document.id) || [];
    if (!values.length) return { ...document, runs: 0, min: null, max: null, median: null, spread: null, rankScore: null };
    const min = Math.min(...values);
    const max = Math.max(...values);
    const middle = median(values);
    return { ...document, runs: values.length, min: round(min), max: round(max), median: round(middle), spread: round(max - min), rankScore: round(rankingMode === "max" ? max : middle) };
  }).sort((a, b) => (b.rankScore ?? -Infinity) - (a.rankScore ?? -Infinity) || a.createdAt.localeCompare(b.createdAt));
  const best = items.find((item) => item.rankScore != null);
  const original = items.find((item) => item.isOriginal);
  items.forEach((item, index) => { item.rank = item.rankScore == null ? null : index + 1; item.isBest = item.id === best?.id; item.delta = item.rankScore == null || original?.rankScore == null ? null : round(item.rankScore - original.rankScore); });
  const originalBaseline = original?.rankScore ?? null;
  let frontier = -Infinity;
  const timeline = [...items]
    .filter((item) => item.rankScore != null)
    .sort((a, b) => a.version - b.version)
    .map((item) => {
      const delta = originalBaseline == null ? null : round(item.rankScore - originalBaseline);
      const minDelta = originalBaseline == null ? null : round(item.min - originalBaseline);
      const maxDelta = originalBaseline == null ? null : round(item.max - originalBaseline);
      frontier = Math.max(frontier, delta ?? item.rankScore);
      return {
        documentId: item.id, documentVersion: item.version, documentTitle: item.title,
        runs: item.runs, delta, minDelta, maxDelta, frontier: round(frontier),
      };
    });
  return { workspace: { id: workspace.id, name: workspace.name }, group: { id: group.id, name: group.name }, question: questionInfo, mode: rankingMode, items, timeline };
}

export function scoreMatrix(db, workspaceRef, { group: groupRef = null, mode = null } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const group = resolveGroup(db, groupRef || workspace.primaryGroupId || "");
  const rankingMode = mode || workspace.rankingMode;
  if (!["max", "median"].includes(rankingMode)) throw new Error("Ranking mode must be max or median.");
  const documents = listDocuments(db, workspace.id);
  const values = new Map(documents.map((document) => [document.id, { overall: [], questions: new Map(), runs: 0 }]));
  db.prepare(`SELECT document_id, overall_score FROM evaluation_runs WHERE workspace_id=? AND group_id=?`).all(workspace.id, group.id).forEach((run) => {
    const entry = values.get(run.document_id);
    entry.runs += 1;
    if (Number.isFinite(run.overall_score)) entry.overall.push(Number(run.overall_score));
  });
  db.prepare(`SELECT r.document_id,q.question_key,s.normalized_score FROM evaluation_scores s JOIN evaluation_runs r ON r.id=s.run_id JOIN evaluation_questions q ON q.id=s.question_id WHERE r.workspace_id=? AND r.group_id=?`).all(workspace.id, group.id).forEach((row) => {
    const questions = values.get(row.document_id).questions;
    if (!questions.has(row.question_key)) questions.set(row.question_key, []);
    questions.get(row.question_key).push(Number(row.normalized_score));
  });
  const pick = (items) => items.length ? round(rankingMode === "max" ? Math.max(...items) : median(items)) : null;
  const rows = documents.map((document) => {
    const entry = values.get(document.id);
    return {
      ...document,
      runs: entry.runs,
      overallScore: pick(entry.overall),
      scores: Object.fromEntries(group.questions.map((question) => [question.key, pick(entry.questions.get(question.key) || [])])),
    };
  }).sort((a, b) => (b.overallScore ?? -Infinity) - (a.overallScore ?? -Infinity) || a.createdAt.localeCompare(b.createdAt));
  const best = rows.find((row) => row.overallScore != null);
  rows.forEach((row) => { row.isBest = row.id === best?.id; });
  return { group: { id: group.id, name: group.name }, mode: rankingMode, questions: group.questions, rows };
}

export function workspaceDetail(db, workspaceRef, options = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const attachedGroups = workspace.groups.map(({ id }) => resolveGroup(db, id));
  let currentRanking = null;
  let matrix = null;
  if (workspace.primaryGroupId || options.group) {
    currentRanking = ranking(db, workspace.id, options);
    matrix = scoreMatrix(db, workspace.id, options);
  }
  return { workspace, groups: attachedGroups, documents: listDocuments(db, workspace.id), ranking: currentRanking, matrix };
}

export function dashboard(db) {
  return { workspaces: listWorkspaces(db), groups: listGroups(db) };
}
