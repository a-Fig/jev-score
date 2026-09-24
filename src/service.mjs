import { randomUUID } from "node:crypto";
import { aggregateScores } from "./aggregate.mjs";
import { evaluateWithJev } from "./jev.mjs";
import { contentHash, inTransaction, usageNumbers } from "./db.mjs";
import { findTemplate } from "./templates.mjs";

const now = () => new Date().toISOString();
const id = (prefix) => `${prefix}_${randomUUID()}`;
const json = (value, fallback = {}) => {
  if (value == null || value === "") return fallback;
  if (typeof value === "string") return JSON.parse(value);
  return value;
};
const parseJson = (value) => value ? JSON.parse(value) : null;
const normalize = (text) => String(text).replace(/\r\n?/g, "\n");
const hash = contentHash;
const median = (values) => {
  const ordered = [...values].sort((a, b) => a - b);
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 ? ordered[middle] : (ordered[middle - 1] + ordered[middle]) / 2;
};
const round = (value) => Math.round(value * 10) / 10;
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const exists = (db, table, name, exceptId = null) => Boolean(db.prepare(`SELECT 1 FROM ${table} WHERE lower(name) = lower(?) AND id IS NOT ?`).get(String(name).trim(), exceptId));
const improvement = (value, baseline, direction = "higher") => value == null || baseline == null ? null : round(direction === "lower" ? baseline - value : value - baseline);
const RANKING_MODES = ["max", "median"];
const ACTIVITY_TTL_MS = 10 * 60 * 1000;

function uniqueName(db, table, base) {
  let name = String(base).trim();
  for (let suffix = 2; exists(db, table, name); suffix += 1) name = `${String(base).trim()} (${suffix})`;
  return name;
}

// ---------------------------------------------------------------------------
// Settings

export function getSetting(db, key, fallback = null) {
  return db.prepare("SELECT value FROM settings WHERE key = ?").get(key)?.value ?? fallback;
}

export function setSetting(db, key, value) {
  if (value == null) db.prepare("DELETE FROM settings WHERE key = ?").run(key);
  else db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
}

// ---------------------------------------------------------------------------
// Evaluation groups

function uniqueKeys(questions) {
  const used = new Set();
  return questions.map((entry, index) => {
    if (typeof entry !== "string" && (typeof entry !== "object" || entry === null || typeof entry.text !== "string")) throw fail(`Question ${index + 1} must be text or an object with text.`);
    const text = typeof entry === "string" ? entry.trim() : entry.text.trim();
    if (!text) throw fail(`Question ${index + 1} is empty.`);
    const direction = typeof entry === "object" && entry.direction != null ? String(entry.direction).trim().toLowerCase() : "higher";
    if (!["higher", "lower"].includes(direction)) throw fail(`Question ${index + 1} direction must be higher or lower.`);
    let key = typeof entry === "object" && entry.key
      ? String(entry.key).trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-")
      : text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 42);
    if (!key) key = `question-${index + 1}`;
    const base = key;
    let suffix = 2;
    while (used.has(key)) key = `${base}-${suffix++}`;
    used.add(key);
    return { key, text, direction };
  });
}

function groupFromRow(db, row) {
  if (!row) return null;
  const questions = db.prepare(`SELECT id, question_key AS key, text, direction, position FROM evaluation_questions WHERE group_id = ? ORDER BY position`).all(row.id);
  const counts = db.prepare(`SELECT (SELECT count(*) FROM evaluation_runs WHERE group_id = ?) runs, (SELECT count(*) FROM evaluation_runs WHERE group_id = ? AND status != 'jev_error') scored, (SELECT count(*) FROM workspace_groups WHERE group_id = ?) workspaces`).get(row.id, row.id, row.id);
  return {
    id: row.id, name: row.name, description: row.description,
    scorerKind: row.scorer_kind, scorerSource: row.scorer_source, scorerHash: row.scorer_hash,
    createdAt: row.created_at, updatedAt: row.updated_at, questions,
    // Failed provider calls store no scores, so only scored runs lock questions.
    runCount: counts.runs, workspaceCount: counts.workspaces, locked: counts.scored > 0,
  };
}

export function resolveGroup(db, reference) {
  const row = db.prepare(`SELECT * FROM evaluation_groups WHERE id = ? OR lower(name) = lower(?) ORDER BY id = ? DESC LIMIT 1`).get(reference, reference, reference);
  if (!row) throw fail(reference ? `Evaluation group not found: ${reference}` : "This workspace has no primary evaluation group. Attach one first.", 404);
  return groupFromRow(db, row);
}

export function listGroups(db) {
  return db.prepare(`SELECT * FROM evaluation_groups ORDER BY lower(name)`).all().map((row) => groupFromRow(db, row));
}

export function createGroup(db, { name, description = "", questions, scorerSource = null, template = null }) {
  const starter = template ? findTemplate(template) : null;
  if (template && !starter) throw fail(`Template not found: ${template}. Run jev-score group templates.`, 404);
  const groupName = typeof name === "string" && name.trim() ? name.trim() : starter ? uniqueName(db, "evaluation_groups", starter.name) : "";
  if (!groupName) throw fail("Group name is required.");
  if (exists(db, "evaluation_groups", groupName)) throw fail(`An evaluation group named “${groupName}” already exists.`, 409);
  const items = Array.isArray(questions) && questions.length ? questions : starter?.questions;
  if (!Array.isArray(items) || !items.length) throw fail("At least one question is required.");
  const cleanQuestions = uniqueKeys(items);
  const groupId = id("grp");
  const timestamp = now();
  const source = scorerSource ? String(scorerSource) : null;
  inTransaction(db, () => {
    db.prepare(`INSERT INTO evaluation_groups (id,name,description,scorer_kind,scorer_source,scorer_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(groupId, groupName, String(description || starter?.description || ""), source ? "javascript-v1" : "mean-v1", source, source ? hash(source) : null, timestamp, timestamp);
    const insert = db.prepare(`INSERT INTO evaluation_questions (id,group_id,question_key,text,direction,position) VALUES (?,?,?,?,?,?)`);
    cleanQuestions.forEach((question, index) => insert.run(id("q"), groupId, question.key, question.text, question.direction, index));
  });
  return resolveGroup(db, groupId);
}

// Names and descriptions can always change. Questions only change before the
// first run, so every stored score keeps meaning what it meant when recorded.
export function updateGroup(db, reference, { name, description, questions } = {}) {
  const group = resolveGroup(db, reference);
  if (name !== undefined) {
    if (typeof name !== "string" || !name.trim()) throw fail("Group name is required.");
    if (exists(db, "evaluation_groups", name, group.id)) throw fail(`An evaluation group named “${name.trim()}” already exists.`, 409);
  }
  if (questions !== undefined) {
    if (group.locked) throw fail(`“${group.name}” has evaluation runs, so its questions are locked. Fork it to change the questions.`, 409);
    if (!Array.isArray(questions) || !questions.length) throw fail("At least one question is required.");
  }
  inTransaction(db, () => {
    if (name !== undefined) db.prepare(`UPDATE evaluation_groups SET name = ?, updated_at = ? WHERE id = ?`).run(name.trim(), now(), group.id);
    if (description !== undefined) db.prepare(`UPDATE evaluation_groups SET description = ?, updated_at = ? WHERE id = ?`).run(String(description ?? ""), now(), group.id);
    if (questions !== undefined) {
      db.prepare(`DELETE FROM evaluation_questions WHERE group_id = ?`).run(group.id);
      const insert = db.prepare(`INSERT INTO evaluation_questions (id,group_id,question_key,text,direction,position) VALUES (?,?,?,?,?,?)`);
      uniqueKeys(questions).forEach((question, index) => insert.run(id("q"), group.id, question.key, question.text, question.direction, index));
      db.prepare(`UPDATE evaluation_groups SET updated_at = ? WHERE id = ?`).run(now(), group.id);
    }
  });
  return resolveGroup(db, group.id);
}

export function renameGroup(db, reference, name) {
  return updateGroup(db, reference, { name });
}

export function forkGroup(db, reference, { name = null } = {}) {
  const group = resolveGroup(db, reference);
  return createGroup(db, {
    name: name?.trim() || uniqueName(db, "evaluation_groups", `${group.name} (fork)`),
    description: group.description,
    questions: group.questions.map(({ key, text, direction }) => ({ key, text, direction })),
    scorerSource: group.scorerSource,
  });
}

export function deleteGroup(db, reference) {
  const group = resolveGroup(db, reference);
  db.prepare(`DELETE FROM evaluation_groups WHERE id = ?`).run(group.id);
  return { deleted: group.id, name: group.name };
}

// ---------------------------------------------------------------------------
// Workspaces

function workspaceFromRow(db, row) {
  if (!row) return null;
  const groups = db.prepare(`SELECT g.id, g.name FROM workspace_groups wg JOIN evaluation_groups g ON g.id=wg.group_id WHERE wg.workspace_id=? ORDER BY lower(g.name)`).all(row.id);
  const counts = db.prepare(`SELECT
      (SELECT count(*) FROM documents WHERE workspace_id=?) documents,
      (SELECT count(*) FROM evaluation_runs WHERE workspace_id=? AND context_hash IS ?) runs,
      (SELECT count(*) FROM evaluation_runs WHERE workspace_id=? AND context_hash IS NOT ?) stale_runs,
      (SELECT count(*) FROM workspace_contexts WHERE workspace_id=?) contexts,
      max(?, coalesce((SELECT max(created_at) FROM documents WHERE workspace_id=?), ''), coalesce((SELECT max(created_at) FROM evaluation_runs WHERE workspace_id=?), '')) last_activity`)
    .get(row.id, row.id, row.context_hash, row.id, row.context_hash, row.id, row.updated_at, row.id, row.id);
  return {
    id: row.id, name: row.name, contextTitle: row.context_title, contextContent: row.context_content, contextHash: row.context_hash,
    primaryGroupId: row.primary_group_id, rankingMode: row.ranking_mode,
    createdAt: row.created_at, updatedAt: row.updated_at, lastActivityAt: counts.last_activity, groups,
    documentCount: counts.documents, runCount: counts.runs, staleRunCount: counts.stale_runs, contextVersions: counts.contexts,
  };
}

export function resolveWorkspace(db, reference) {
  const row = db.prepare(`SELECT * FROM workspaces WHERE id = ? OR lower(name) = lower(?) ORDER BY id = ? DESC LIMIT 1`).get(reference, reference, reference);
  if (!row) throw fail(`Workspace not found: ${reference}`, 404);
  return workspaceFromRow(db, row);
}

export function listWorkspaces(db) {
  return db.prepare(`SELECT * FROM workspaces`).all().map((row) => workspaceFromRow(db, row))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt) || a.name.localeCompare(b.name));
}

function saveContextVersion(db, workspaceId, { title, content, hash: contextHash, timestamp }) {
  const existing = db.prepare(`SELECT id FROM workspace_contexts WHERE workspace_id=? AND content_hash=?`).get(workspaceId, contextHash);
  if (existing) db.prepare(`UPDATE workspace_contexts SET title=?, activated_at=? WHERE id=?`).run(title, timestamp, existing.id);
  else db.prepare(`INSERT INTO workspace_contexts (id,workspace_id,content_hash,title,content,created_at,activated_at) VALUES (?,?,?,?,?,?,?)`).run(id("ctx"), workspaceId, contextHash, title, content, timestamp, timestamp);
}

export function createWorkspace(db, { name, contextTitle = "Context", contextContent, primaryGroup = null }) {
  if (typeof name !== "string" || !name.trim()) throw fail("Workspace name is required.");
  if (typeof contextContent !== "string" || !contextContent.trim()) throw fail("Workspace context is required.");
  if (exists(db, "workspaces", name)) throw fail(`A workspace named “${name.trim()}” already exists.`, 409);
  const group = primaryGroup ? resolveGroup(db, primaryGroup) : null;
  const workspaceId = id("ws");
  const timestamp = now();
  const content = normalize(contextContent);
  const title = String(contextTitle || "Context").trim() || "Context";
  inTransaction(db, () => {
    db.prepare(`INSERT INTO workspaces (id,name,context_title,context_content,context_hash,primary_group_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
      .run(workspaceId, name.trim(), title, content, hash(content), group?.id || null, timestamp, timestamp);
    saveContextVersion(db, workspaceId, { title, content, hash: hash(content), timestamp });
    if (group) db.prepare(`INSERT INTO workspace_groups (workspace_id,group_id,attached_at) VALUES (?,?,?)`).run(workspaceId, group.id, timestamp);
  });
  return resolveWorkspace(db, workspaceId);
}

// Editing the context never deletes scores. Runs keep the hash of the context
// they were scored against; rankings only count runs for the current context.
export function updateWorkspace(db, reference, changes = {}) {
  const workspace = resolveWorkspace(db, reference);
  const group = changes.primaryGroup ? resolveGroup(db, changes.primaryGroup) : null;
  if (changes.rankingMode !== undefined && !RANKING_MODES.includes(changes.rankingMode)) throw fail("Ranking mode must be max or median.");
  if (changes.name !== undefined) {
    if (typeof changes.name !== "string" || !changes.name.trim()) throw fail("Workspace name is required.");
    if (exists(db, "workspaces", changes.name, workspace.id)) throw fail(`A workspace named “${changes.name.trim()}” already exists.`, 409);
  }
  if (changes.contextContent !== undefined && (typeof changes.contextContent !== "string" || !changes.contextContent.trim())) throw fail("Workspace context is required.");
  const timestamp = now();
  inTransaction(db, () => {
    if (changes.primaryGroup !== undefined) {
      if (group) db.prepare(`INSERT OR IGNORE INTO workspace_groups VALUES (?,?,?)`).run(workspace.id, group.id, timestamp);
      db.prepare(`UPDATE workspaces SET primary_group_id=?, updated_at=? WHERE id=?`).run(group?.id || null, timestamp, workspace.id);
    }
    if (changes.rankingMode !== undefined) db.prepare(`UPDATE workspaces SET ranking_mode=?, updated_at=? WHERE id=?`).run(changes.rankingMode, timestamp, workspace.id);
    if (changes.name !== undefined) db.prepare(`UPDATE workspaces SET name=?, updated_at=? WHERE id=?`).run(changes.name.trim(), timestamp, workspace.id);
    if (changes.contextTitle !== undefined || changes.contextContent !== undefined) {
      const title = String(changes.contextTitle ?? workspace.contextTitle).trim() || "Context";
      const content = changes.contextContent !== undefined ? normalize(changes.contextContent) : workspace.contextContent;
      db.prepare(`UPDATE workspaces SET context_title=?, context_content=?, context_hash=?, updated_at=? WHERE id=?`).run(title, content, hash(content), timestamp, workspace.id);
      saveContextVersion(db, workspace.id, { title, content, hash: hash(content), timestamp });
    }
  });
  return resolveWorkspace(db, workspace.id);
}

export function contextHistory(db, reference) {
  const workspace = resolveWorkspace(db, reference);
  return db.prepare(`SELECT c.*, (SELECT count(*) FROM evaluation_runs r WHERE r.workspace_id=c.workspace_id AND r.context_hash=c.content_hash) runs FROM workspace_contexts c WHERE workspace_id=? ORDER BY activated_at DESC`).all(workspace.id)
    .map((row) => ({ id: row.id, hash: row.content_hash, title: row.title, content: row.content, createdAt: row.created_at, activatedAt: row.activated_at, runs: row.runs, current: row.content_hash === workspace.contextHash }));
}

export function attachGroup(db, workspaceRef, groupRef) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const group = resolveGroup(db, groupRef);
  db.prepare(`INSERT OR IGNORE INTO workspace_groups VALUES (?,?,?)`).run(workspace.id, group.id, now());
  if (!workspace.primaryGroupId) db.prepare(`UPDATE workspaces SET primary_group_id=? WHERE id=?`).run(group.id, workspace.id);
  return resolveWorkspace(db, workspace.id);
}

export function detachGroup(db, workspaceRef, groupRef) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const group = resolveGroup(db, groupRef);
  inTransaction(db, () => {
    db.prepare(`DELETE FROM workspace_groups WHERE workspace_id=? AND group_id=?`).run(workspace.id, group.id);
    if (workspace.primaryGroupId === group.id) {
      const next = db.prepare(`SELECT group_id FROM workspace_groups WHERE workspace_id=? ORDER BY attached_at LIMIT 1`).get(workspace.id);
      db.prepare(`UPDATE workspaces SET primary_group_id=?, updated_at=? WHERE id=?`).run(next?.group_id || null, now(), workspace.id);
    }
  });
  return resolveWorkspace(db, workspace.id);
}

export function deleteWorkspace(db, reference) {
  const workspace = resolveWorkspace(db, reference);
  db.prepare(`DELETE FROM workspaces WHERE id=?`).run(workspace.id);
  return { deleted: workspace.id, name: workspace.name };
}

// ---------------------------------------------------------------------------
// Documents

function documentFromRow(row) {
  if (!row) return null;
  return {
    id: row.id, workspaceId: row.workspace_id, contentHash: row.content_hash, content: row.content,
    title: row.title, changeSummary: row.change_summary, metadata: parseJson(row.metadata_json) || {},
    parentDocumentId: row.parent_document_id, isOriginal: Boolean(row.is_original), version: Number(row.version), createdAt: row.created_at,
    words: row.content ? (row.content.match(/\S+/g) || []).length : undefined,
  };
}

// A document reference is its ID, its title, or its version number ("#3" or "3").
export function resolveDocument(db, workspaceRef, reference) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const text = String(reference ?? "").trim();
  const version = /^#?\d+$/.test(text) ? Number(text.replace("#", "")) : -1;
  const row = db.prepare(`SELECT * FROM documents WHERE workspace_id=? AND (id=? OR lower(title)=lower(?) OR version=?) ORDER BY id=? DESC, lower(title)=lower(?) DESC, version DESC LIMIT 1`)
    .get(workspace.id, text, text, version, text, text);
  if (!row) throw fail(`Document not found in ${workspace.name}: ${reference}`, 404);
  return documentFromRow(row);
}

export function addDocument(db, workspaceRef, { content, title = "Untitled", changeSummary = "", metadata = {}, parentDocument = null, original = false }) {
  const workspace = resolveWorkspace(db, workspaceRef);
  if (typeof content !== "string" || !content.trim()) throw fail("Document content is required.");
  if (typeof title !== "string" || !title.trim()) throw fail("Document title is required.");
  const cleanContent = normalize(content);
  const contentHash = hash(cleanContent);
  const parent = parentDocument ? resolveDocument(db, workspace.id, parentDocument) : null;
  return inTransaction(db, () => {
    const existing = db.prepare(`SELECT * FROM documents WHERE workspace_id=? AND content_hash=?`).get(workspace.id, contentHash);
    if (existing) return { ...documentFromRow(existing), deduplicated: true };
    const { count, next } = db.prepare(`SELECT count(*) count, max(coalesce(max(version), -1) + 1, (SELECT next_document_version FROM workspaces WHERE id=?)) next FROM documents WHERE workspace_id=?`).get(workspace.id, workspace.id);
    db.prepare(`UPDATE workspaces SET next_document_version=? WHERE id=?`).run(next + 1, workspace.id);
    const isOriginal = original || count === 0;
    if (isOriginal) db.prepare(`UPDATE documents SET is_original=0 WHERE workspace_id=?`).run(workspace.id);
    const documentId = id("doc");
    db.prepare(`INSERT INTO documents (id,workspace_id,content_hash,content,title,change_summary,metadata_json,parent_document_id,is_original,version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`)
      .run(documentId, workspace.id, contentHash, cleanContent, title.trim(), String(changeSummary || ""), JSON.stringify(json(metadata)), parent?.id || null, isOriginal ? 1 : 0, next, now());
    return { ...documentFromRow(db.prepare(`SELECT * FROM documents WHERE id=?`).get(documentId)), deduplicated: false };
  });
}

export function updateDocument(db, workspaceRef, documentRef, { title, changeSummary, original } = {}) {
  const document = resolveDocument(db, workspaceRef, documentRef);
  if (title !== undefined && (typeof title !== "string" || !title.trim())) throw fail("Document title is required.");
  inTransaction(db, () => {
    if (title !== undefined) db.prepare(`UPDATE documents SET title=? WHERE id=?`).run(title.trim(), document.id);
    if (changeSummary !== undefined) db.prepare(`UPDATE documents SET change_summary=? WHERE id=?`).run(String(changeSummary ?? ""), document.id);
    if (original === true) {
      db.prepare(`UPDATE documents SET is_original=0 WHERE workspace_id=?`).run(document.workspaceId);
      db.prepare(`UPDATE documents SET is_original=1 WHERE id=?`).run(document.id);
    }
  });
  return resolveDocument(db, document.workspaceId, document.id);
}

// Versions are never renumbered or reused, so "#4" keeps meaning the same
// draft after a deletion. Deleting the original promotes the oldest draft.
export function deleteDocument(db, workspaceRef, documentRef) {
  const document = resolveDocument(db, workspaceRef, documentRef);
  inTransaction(db, () => {
    db.prepare(`DELETE FROM documents WHERE id=?`).run(document.id);
    if (document.isOriginal) db.prepare(`UPDATE documents SET is_original=1 WHERE id=(SELECT id FROM documents WHERE workspace_id=? ORDER BY version LIMIT 1)`).run(document.workspaceId);
  });
  return { deleted: document.id, title: document.title, version: document.version };
}

export function listDocuments(db, workspaceRef, { includeContent = false } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  return db.prepare(`SELECT * FROM documents WHERE workspace_id=? ORDER BY version`).all(workspace.id).map((row) => {
    const item = documentFromRow(row);
    if (!includeContent) delete item.content;
    return item;
  });
}

export function documentDetail(db, workspaceRef, documentRef) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const document = resolveDocument(db, workspace.id, documentRef);
  const runs = db.prepare(`SELECT id FROM evaluation_runs WHERE document_id=? ORDER BY created_at DESC`).all(document.id)
    .map(({ id }) => { const run = getRun(db, id); return { ...run, stale: run.contextHash !== workspace.contextHash }; });
  return { ...document, runs };
}

// ---------------------------------------------------------------------------
// Spend limit and live activity

export function spendStatus(db, env = process.env) {
  const envLimit = env.JEV_SCORE_SPEND_LIMIT != null && env.JEV_SCORE_SPEND_LIMIT !== "" ? Number(env.JEV_SCORE_SPEND_LIMIT) : null;
  const storedLimit = getSetting(db, "spend_limit_usd");
  const limit = Number.isFinite(envLimit) ? envLimit : storedLimit != null ? Number(storedLimit) : null;
  const since = getSetting(db, "spend_since");
  const totals = db.prepare(`SELECT coalesce(sum(cost), 0) spent, count(*) runs, count(cost) cost_runs FROM usage_ledger WHERE created_at >= ?`).get(since || "");
  const spent = Number(totals.spent);
  return {
    limit: Number.isFinite(limit) ? limit : null, source: Number.isFinite(envLimit) ? "env" : storedLimit != null ? "settings" : null,
    since, spent, runs: totals.runs, reportedCostRuns: totals.cost_runs,
    remaining: Number.isFinite(limit) ? Math.max(0, limit - spent) : null,
    exceeded: Number.isFinite(limit) && spent >= limit,
  };
}

export function setSpendLimit(db, limit) {
  if (limit == null || limit === "") { setSetting(db, "spend_limit_usd", null); return spendStatus(db); }
  const value = Number(limit);
  if (!Number.isFinite(value) || value < 0) throw fail("Spend limit must be a number of US dollars, 0 or more.");
  setSetting(db, "spend_limit_usd", value);
  return spendStatus(db);
}

export function resetSpendCounter(db) {
  setSetting(db, "spend_since", now());
  return spendStatus(db);
}

export function activity(db, workspaceRef = null) {
  db.prepare(`DELETE FROM evaluation_activity WHERE started_at < ?`).run(new Date(Date.now() - ACTIVITY_TTL_MS).toISOString());
  const workspace = workspaceRef ? resolveWorkspace(db, workspaceRef) : null;
  return db.prepare(`SELECT a.*, d.title, d.version, w.name workspace_name FROM evaluation_activity a JOIN documents d ON d.id=a.document_id JOIN workspaces w ON w.id=a.workspace_id WHERE ? IS NULL OR a.workspace_id=? ORDER BY a.started_at`)
    .all(workspace?.id ?? null, workspace?.id ?? null)
    .map((row) => ({ id: row.id, workspaceId: row.workspace_id, workspaceName: row.workspace_name, documentId: row.document_id, documentTitle: row.title, documentVersion: row.version, groupId: row.group_id, source: row.source, startedAt: row.started_at }));
}

// ---------------------------------------------------------------------------
// Evaluation

export async function evaluateDocument(db, workspaceRef, documentRef, { group: groupRef = null, note = "", metadata = {}, evaluate = evaluateWithJev, source = "cli" } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const document = resolveDocument(db, workspace.id, documentRef);
  const group = resolveGroup(db, groupRef || workspace.primaryGroupId || "");
  if (evaluate === evaluateWithJev && !process.env.OPENROUTER_API_KEY) throw fail("OPENROUTER_API_KEY is required to run an evaluation. Put it in .env.local or your shell, then run jev-score doctor.");
  const spend = spendStatus(db);
  if (spend.exceeded) throw fail(`Spend limit reached: $${spend.spent.toFixed(4)} recorded against a $${spend.limit.toFixed(2)} limit. Raise it with jev-score config spend-limit <usd> or in Settings.`, 402);
  db.prepare(`INSERT OR IGNORE INTO workspace_groups VALUES (?,?,?)`).run(workspace.id, group.id, now());
  const runId = id("run");
  db.prepare(`INSERT INTO evaluation_activity (id,workspace_id,document_id,group_id,source,started_at) VALUES (?,?,?,?,?,?)`).run(runId, workspace.id, document.id, group.id, source, now());
  try {
    let result;
    try {
      result = await evaluate({ document: document.content, context: workspace.contextContent, questions: group.questions });
    } catch (error) {
      db.prepare(`INSERT INTO evaluation_runs (id,workspace_id,document_id,group_id,status,note,metadata_json,error,context_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, workspace.id, document.id, group.id, "jev_error", String(note || ""), JSON.stringify(json(metadata)), error.message, workspace.contextHash, now());
      error.runId = runId;
      throw error;
    }
    let overall = null;
    let aggregationError = null;
    try { overall = await aggregateScores(group, result.scores); }
    catch (error) { aggregationError = error.message; }
    const usage = usageNumbers(result.usage);
    inTransaction(db, () => {
      const timestamp = now();
      db.prepare(`INSERT INTO evaluation_runs (id,workspace_id,document_id,group_id,status,overall_score,model,provider,note,metadata_json,usage_json,aggregation_error,context_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, workspace.id, document.id, group.id, aggregationError ? "aggregation_error" : "success", overall, result.model || null, result.provider || null, String(note || ""), JSON.stringify(json(metadata)), result.usage ? JSON.stringify(result.usage) : null, aggregationError, workspace.contextHash, timestamp);
      const insert = db.prepare(`INSERT INTO evaluation_scores (run_id,question_id,raw_score,normalized_score,confidence,probabilities_json) VALUES (?,?,?,?,?,?)`);
      result.scores.forEach((score) => insert.run(runId, score.questionId, score.rawScore, score.score, score.confidence, score.probabilities ? JSON.stringify(score.probabilities) : null));
      if (usage) db.prepare(`INSERT OR IGNORE INTO usage_ledger (run_id,workspace_id,model,provider,input_tokens,output_tokens,total_tokens,cost,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
        .run(runId, workspace.id, result.model || null, result.provider || null, usage.input, usage.output, usage.total, usage.cost, timestamp);
    });
    return getRun(db, runId);
  } finally {
    db.prepare(`DELETE FROM evaluation_activity WHERE id=?`).run(runId);
  }
}

async function pool(count, limit, task) {
  const results = new Array(count);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, count) }, async () => {
    while (next < count) {
      const index = next++;
      try { results[index] = { value: await task(index) }; }
      catch (error) { results[index] = { error }; }
    }
  }));
  return results;
}

// Scores a document one or more times and returns what an agent needs to pick
// its next edit: the result, how it compares with the parent and the current
// best, and the weakest questions.
export async function scoreDocument(db, workspaceRef, documentRef, { runs = 1, concurrency = 3, ...options } = {}) {
  const count = Number(runs);
  if (!Number.isInteger(count) || count < 1 || count > 10) throw fail("Runs must be a whole number from 1 to 10.");
  const workspace = resolveWorkspace(db, workspaceRef);
  const document = resolveDocument(db, workspace.id, documentRef);
  const group = resolveGroup(db, options.group || workspace.primaryGroupId || "");
  const results = await pool(count, Math.max(1, concurrency), () => evaluateDocument(db, workspace.id, document.id, { ...options, group: group.id }));
  const runIds = results.map((result) => result.value?.id || result.error?.runId).filter(Boolean);
  if (results.every((result) => result.error)) {
    const error = results[0].error;
    if (runIds.length) error.runIds = runIds;
    throw error;
  }
  const feedback = documentFeedback(db, workspace.id, document.id, { group: group.id, runIds });
  const spendError = results.find((result) => result.error?.status === 402)?.error;
  if (spendError) feedback.errors.push({ runId: null, error: spendError.message });
  return feedback;
}

export function documentFeedback(db, workspaceRef, documentRef, { group: groupRef = null, runIds = null } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const document = resolveDocument(db, workspace.id, documentRef);
  const group = resolveGroup(db, groupRef || workspace.primaryGroupId || "");
  const matrix = scoreMatrix(db, workspace.id, { group: group.id });
  const rows = new Map(matrix.rows.map((row) => [row.id, row]));
  const ids = runIds || db.prepare(`SELECT id FROM evaluation_runs WHERE document_id=? AND group_id=? AND context_hash IS ? ORDER BY created_at`).all(document.id, group.id, workspace.contextHash).map((row) => row.id);
  const runs = ids.map((runId) => getRun(db, runId));
  const scored = runs.filter((run) => run.status !== "jev_error");
  const summarize = (values) => values.length ? { value: round(median(values)), min: round(Math.min(...values)), max: round(Math.max(...values)) } : null;
  const overall = summarize(scored.map((run) => run.overallScore).filter(Number.isFinite));
  const parent = document.parentDocumentId ? rows.get(document.parentDocumentId) : null;
  const original = matrix.rows.find((row) => row.isOriginal && row.id !== document.id) || null;
  const best = matrix.rows.filter((row) => row.id !== document.id && row.overallScore != null).sort((a, b) => b.overallScore - a.overallScore)[0] || null;
  const reference = (row) => row ? { id: row.id, version: row.version, title: row.title, overallScore: row.overallScore } : null;
  const scores = group.questions.map((question) => {
    const summary = summarize(scored.flatMap((run) => run.scores.filter((item) => item.key === question.key).map((item) => item.score)));
    return {
      key: question.key, text: question.text, direction: question.direction, score: summary?.value ?? null,
      ...(scored.length > 1 && summary ? { min: summary.min, max: summary.max } : {}),
      vsParent: improvement(summary?.value, parent?.scores[question.key], question.direction),
      vsBest: improvement(summary?.value, best?.scores[question.key], question.direction),
    };
  });
  const goodness = (item) => item.direction === "lower" ? 100 - item.score : item.score;
  const weakest = scores.filter((item) => item.score != null).sort((a, b) => goodness(a) - goodness(b)).slice(0, 3)
    .map(({ key, text, direction, score, vsParent }) => ({ key, text, direction, score, vsParent }));
  const ranked = matrix.rows.filter((row) => row.overallScore != null);
  const position = ranked.findIndex((row) => row.id === document.id);
  const statuses = new Set(runs.map((run) => run.status));
  return {
    workspace: workspace.name, group: group.name,
    documentId: document.id, documentVersion: document.version, documentTitle: document.title,
    status: !runs.length ? "not_evaluated" : statuses.size === 1 ? runs[0].status : overall ? "partial" : [...statuses].find((status) => status !== "success"),
    runs: runs.length, runIds: runs.map((run) => run.id),
    errors: runs.filter((run) => run.error || run.aggregationError).map((run) => ({ runId: run.id, error: run.error || run.aggregationError })),
    overallScore: overall?.value ?? null,
    ...(scored.length > 1 && overall ? { range: { min: overall.min, max: overall.max } } : {}),
    rank: position >= 0 ? position + 1 : null, evaluatedDocuments: ranked.length, isBest: Boolean(rows.get(document.id)?.isBest),
    vsParent: improvement(overall?.value, parent?.overallScore), vsBest: improvement(overall?.value, best?.overallScore), vsOriginal: improvement(overall?.value, original?.overallScore),
    parent: reference(parent), best: reference(best), original: reference(original),
    scores, weakest,
  };
}

export function getRun(db, runId) {
  const row = db.prepare(`SELECT r.*, d.title document_title, d.version document_version, g.name group_name FROM evaluation_runs r JOIN documents d ON d.id=r.document_id JOIN evaluation_groups g ON g.id=r.group_id WHERE r.id=?`).get(runId);
  if (!row) throw fail(`Evaluation run not found: ${runId}`, 404);
  const scores = db.prepare(`SELECT q.question_key key,q.text,q.direction,s.raw_score rawScore,s.normalized_score score,s.confidence,s.probabilities_json probabilities FROM evaluation_scores s JOIN evaluation_questions q ON q.id=s.question_id WHERE s.run_id=? ORDER BY q.position`).all(runId)
    .map((score) => ({ ...score, probabilities: parseJson(score.probabilities) }));
  return {
    id: row.id, workspaceId: row.workspace_id, documentId: row.document_id, documentTitle: row.document_title, documentVersion: row.document_version,
    groupId: row.group_id, groupName: row.group_name, status: row.status, overallScore: row.overall_score,
    model: row.model, provider: row.provider, note: row.note, metadata: parseJson(row.metadata_json) || {},
    usage: parseJson(row.usage_json), aggregationError: row.aggregation_error, error: row.error,
    contextHash: row.context_hash, createdAt: row.created_at, scores,
  };
}

// ---------------------------------------------------------------------------
// Rankings

export function ranking(db, workspaceRef, { group: groupRef = null, question = null, mode = null } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const group = resolveGroup(db, groupRef || workspace.primaryGroupId || "");
  const rankingMode = mode || workspace.rankingMode;
  if (!RANKING_MODES.includes(rankingMode)) throw fail("Ranking mode must be max or median.");
  let questionInfo = null;
  if (question) {
    questionInfo = group.questions.find((item) => item.id === question || item.key === question || item.text.toLowerCase() === String(question).toLowerCase());
    if (!questionInfo) throw fail(`Question not found in ${group.name}: ${question}`, 404);
  }
  const rows = questionInfo
    ? db.prepare(`SELECT r.id run_id,r.document_id,r.created_at,s.normalized_score value FROM evaluation_runs r JOIN evaluation_scores s ON s.run_id=r.id WHERE r.workspace_id=? AND r.group_id=? AND s.question_id=? AND r.context_hash IS ?`).all(workspace.id, group.id, questionInfo.id, workspace.contextHash)
    : db.prepare(`SELECT id run_id,document_id,created_at,overall_score value FROM evaluation_runs WHERE workspace_id=? AND group_id=? AND status='success' AND overall_score IS NOT NULL AND context_hash IS ?`).all(workspace.id, group.id, workspace.contextHash);
  const documents = listDocuments(db, workspace.id);
  const lowerIsBetter = questionInfo?.direction === "lower";
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
    return { ...document, runs: values.length, min: round(min), max: round(max), median: round(middle), spread: round(max - min), rankScore: round(rankingMode === "max" ? (lowerIsBetter ? min : max) : middle) };
  }).sort((a, b) => lowerIsBetter
    ? (a.rankScore ?? Infinity) - (b.rankScore ?? Infinity) || a.createdAt.localeCompare(b.createdAt)
    : (b.rankScore ?? -Infinity) - (a.rankScore ?? -Infinity) || a.createdAt.localeCompare(b.createdAt));
  const best = items.find((item) => item.rankScore != null);
  const original = items.find((item) => item.isOriginal);
  items.forEach((item, index) => { item.rank = item.rankScore == null ? null : index + 1; item.isBest = item.id === best?.id; item.delta = item.rankScore == null || original?.rankScore == null ? null : improvement(item.rankScore, original.rankScore, lowerIsBetter ? "lower" : "higher"); });
  const originalBaseline = original?.rankScore ?? null;
  const change = (value) => originalBaseline == null ? null : improvement(value, originalBaseline, lowerIsBetter ? "lower" : "higher");
  let frontier = -Infinity;
  const timeline = [...items]
    .filter((item) => item.rankScore != null)
    .sort((a, b) => a.version - b.version)
    .map((item) => {
      const delta = change(item.rankScore);
      frontier = Math.max(frontier, delta ?? item.rankScore);
      return {
        documentId: item.id, documentVersion: item.version, documentTitle: item.title, parentDocumentId: item.parentDocumentId,
        runs: item.runs, score: item.rankScore, delta, minDelta: change(lowerIsBetter ? item.max : item.min), maxDelta: change(lowerIsBetter ? item.min : item.max), frontier: round(frontier),
      };
    });
  return { workspace: { id: workspace.id, name: workspace.name }, group: { id: group.id, name: group.name }, question: questionInfo, mode: rankingMode, items, timeline };
}

export function scoreMatrix(db, workspaceRef, { group: groupRef = null, mode = null } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const group = resolveGroup(db, groupRef || workspace.primaryGroupId || "");
  const rankingMode = mode || workspace.rankingMode;
  if (!RANKING_MODES.includes(rankingMode)) throw fail("Ranking mode must be max or median.");
  const documents = listDocuments(db, workspace.id);
  const values = new Map(documents.map((document) => [document.id, { overall: [], questions: new Map(), runs: 0, completedRuns: 0, staleRuns: 0 }]));
  db.prepare(`SELECT document_id, status, overall_score, context_hash IS ? is_current FROM evaluation_runs WHERE workspace_id=? AND group_id=?`).all(workspace.contextHash, workspace.id, group.id).forEach((run) => {
    const entry = values.get(run.document_id);
    if (!run.is_current) { entry.staleRuns += 1; return; }
    entry.runs += 1;
    if (run.status !== "jev_error") entry.completedRuns += 1;
    if (Number.isFinite(run.overall_score)) entry.overall.push(Number(run.overall_score));
  });
  db.prepare(`SELECT r.document_id,q.question_key,s.normalized_score FROM evaluation_scores s JOIN evaluation_runs r ON r.id=s.run_id JOIN evaluation_questions q ON q.id=s.question_id WHERE r.workspace_id=? AND r.group_id=? AND r.context_hash IS ?`).all(workspace.id, group.id, workspace.contextHash).forEach((row) => {
    const questions = values.get(row.document_id).questions;
    if (!questions.has(row.question_key)) questions.set(row.question_key, []);
    questions.get(row.question_key).push(Number(row.normalized_score));
  });
  const pick = (items, direction = "higher") => items.length ? round(rankingMode === "max" ? (direction === "lower" ? Math.min(...items) : Math.max(...items)) : median(items)) : null;
  const rows = documents.map((document) => {
    const entry = values.get(document.id);
    return {
      ...document,
      runs: entry.runs,
      completedRuns: entry.completedRuns,
      staleRuns: entry.staleRuns,
      evaluated: entry.completedRuns > 0,
      overallScore: pick(entry.overall),
      scores: Object.fromEntries(group.questions.map((question) => [question.key, pick(entry.questions.get(question.key) || [], question.direction)])),
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
  return { workspace, groups: attachedGroups, documents: listDocuments(db, workspace.id), ranking: currentRanking, matrix, contexts: contextHistory(db, workspace.id), activity: activity(db, workspace.id) };
}

// One card per workspace for the home screen: best draft, gain over the
// original, and a sparkline of each version's change.
export function workspaceSummary(db, workspaceRef) {
  const workspace = resolveWorkspace(db, workspaceRef);
  if (!workspace.primaryGroupId) return { ...workspace, groupName: null, best: null, original: null, delta: null, evaluated: 0, timeline: [] };
  const result = ranking(db, workspace.id);
  const best = result.items.find((item) => item.rankScore != null) || null;
  const original = result.items.find((item) => item.isOriginal) || null;
  return {
    ...workspace, groupName: result.group.name, evaluated: result.timeline.length,
    best: best && { id: best.id, version: best.version, title: best.title, score: best.rankScore },
    original: original && { id: original.id, version: original.version, title: original.title, score: original.rankScore },
    delta: best?.delta ?? null,
    timeline: result.timeline.map(({ documentVersion, delta, frontier }) => ({ version: documentVersion, delta, frontier })),
  };
}

export function dashboard(db) {
  return { workspaces: listWorkspaces(db).map((workspace) => workspaceSummary(db, workspace.id)), groups: listGroups(db), activity: activity(db) };
}

export function usageSummary(db) {
  const workspaces = listWorkspaces(db).map((workspace) => ({
    id: workspace.id, name: workspace.name, runs: 0, reportedRuns: 0,
    inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, costRuns: 0,
  }));
  const byWorkspace = new Map(workspaces.map((workspace) => [workspace.id, workspace]));
  const models = new Map();
  const total = { runs: 0, reportedRuns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, costRuns: 0 };
  const add = (target, raw) => {
    target.runs += 1;
    const usage = usageNumbers(raw);
    if (!usage) return;
    target.reportedRuns += 1;
    target.inputTokens += usage.input;
    target.outputTokens += usage.output;
    target.totalTokens += usage.total;
    if (usage.cost != null) { target.cost += usage.cost; target.costRuns += 1; }
  };
  db.prepare(`SELECT r.workspace_id,r.model,r.provider,r.usage_json FROM evaluation_runs r ORDER BY r.created_at`).all().forEach((row) => {
    let usage = null;
    try { usage = parseJson(row.usage_json); } catch {}
    add(total, usage);
    const workspace = byWorkspace.get(row.workspace_id);
    if (workspace) add(workspace, usage);
    if (row.model) {
      const key = `${row.provider || ""}\u0000${row.model}`;
      if (!models.has(key)) models.set(key, { model: row.model, provider: row.provider || "Unknown", runs: 0, reportedRuns: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0, cost: 0, costRuns: 0 });
      add(models.get(key), usage);
    }
  });
  const finish = (item) => ({ ...item, cost: item.costRuns ? item.cost : null });
  const lifetime = db.prepare(`SELECT count(*) runs, coalesce(sum(total_tokens), 0) tokens, sum(cost) cost FROM usage_ledger`).get();
  return {
    total: finish(total),
    workspaces: workspaces.map(finish).sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1) || b.runs - a.runs || a.name.localeCompare(b.name)),
    models: [...models.values()].map(finish).sort((a, b) => b.runs - a.runs || a.model.localeCompare(b.model)),
    lifetime: { runs: lifetime.runs, totalTokens: lifetime.tokens, cost: lifetime.cost },
    spend: spendStatus(db),
  };
}

// ---------------------------------------------------------------------------
// Export and import

export const BUNDLE_FORMAT = "jev-score.workspace";

export function exportWorkspace(db, workspaceRef, { appVersion = null } = {}) {
  const workspace = resolveWorkspace(db, workspaceRef);
  const groupIds = new Set(workspace.groups.map((group) => group.id));
  db.prepare(`SELECT DISTINCT group_id FROM evaluation_runs WHERE workspace_id=?`).all(workspace.id).forEach((row) => groupIds.add(row.group_id));
  const groups = [...groupIds].map((groupId) => resolveGroup(db, groupId));
  const documents = db.prepare(`SELECT * FROM documents WHERE workspace_id=? ORDER BY version`).all(workspace.id).map(documentFromRow);
  const runs = db.prepare(`SELECT id FROM evaluation_runs WHERE workspace_id=? ORDER BY created_at`).all(workspace.id).map(({ id }) => getRun(db, id));
  return {
    format: BUNDLE_FORMAT, formatVersion: 1, exportedAt: now(), app: { name: "jev-score", version: appVersion },
    workspace: { name: workspace.name, contextTitle: workspace.contextTitle, contextContent: workspace.contextContent, rankingMode: workspace.rankingMode, primaryGroup: workspace.primaryGroupId, groups: workspace.groups.map((group) => group.id), createdAt: workspace.createdAt },
    contexts: contextHistory(db, workspace.id).map(({ hash: contextHash, title, content, createdAt, activatedAt }) => ({ hash: contextHash, title, content, createdAt, activatedAt })),
    groups: groups.map((group) => ({ ref: group.id, name: group.name, description: group.description, scorerSource: group.scorerSource, questions: group.questions.map(({ key, text, direction }) => ({ key, text, direction })) })),
    documents: documents.map((document) => ({ ref: document.id, version: document.version, title: document.title, content: document.content, changeSummary: document.changeSummary, metadata: document.metadata, parent: document.parentDocumentId, isOriginal: document.isOriginal, createdAt: document.createdAt })),
    runs: runs.map((run) => ({ document: run.documentId, group: run.groupId, contextHash: run.contextHash, status: run.status, overallScore: run.overallScore, model: run.model, provider: run.provider, note: run.note, metadata: run.metadata, usage: run.usage, aggregationError: run.aggregationError, error: run.error, createdAt: run.createdAt, scores: run.scores.map(({ key, rawScore, score, confidence, probabilities }) => ({ key, rawScore, score, confidence, probabilities })) })),
  };
}

const sameQuestions = (group, questions) => group.questions.length === questions.length && group.questions.every((question, index) => question.key === questions[index].key && question.text === questions[index].text && question.direction === (questions[index].direction || "higher"));

export function importWorkspace(db, bundle, { name = null, allowScorer = false } = {}) {
  if (bundle?.format !== BUNDLE_FORMAT || bundle.formatVersion !== 1) throw fail("This file is not a Jev Score workspace export.");
  if (!Array.isArray(bundle.groups) || !Array.isArray(bundle.documents) || !Array.isArray(bundle.runs) || !bundle.workspace) throw fail("The workspace export is incomplete.");
  if (!allowScorer && bundle.groups.some((group) => group.scorerSource)) throw fail("This export contains custom scorer code. Import it with the local CLI: jev-score workspace import <file>.");
  // Reuse identical groups; otherwise create a copy under a free name.
  const groupMap = new Map();
  for (const group of bundle.groups) {
    const match = listGroups(db).find((candidate) => candidate.name.toLowerCase() === String(group.name).toLowerCase() && sameQuestions(candidate, group.questions) && (candidate.scorerSource || null) === (group.scorerSource || null));
    groupMap.set(group.ref, match || createGroup(db, { name: uniqueName(db, "evaluation_groups", group.name), description: group.description, questions: group.questions, scorerSource: group.scorerSource }));
  }
  const workspaceName = uniqueName(db, "workspaces", name || bundle.workspace.name);
  const workspaceId = id("ws");
  const timestamp = now();
  const content = normalize(bundle.workspace.contextContent);
  inTransaction(db, () => {
    db.prepare(`INSERT INTO workspaces (id,name,context_title,context_content,context_hash,primary_group_id,ranking_mode,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(workspaceId, workspaceName, bundle.workspace.contextTitle || "Context", content, hash(content), groupMap.get(bundle.workspace.primaryGroup)?.id || null, RANKING_MODES.includes(bundle.workspace.rankingMode) ? bundle.workspace.rankingMode : "max", bundle.workspace.createdAt || timestamp, timestamp);
    for (const context of bundle.contexts || []) {
      db.prepare(`INSERT OR IGNORE INTO workspace_contexts (id,workspace_id,content_hash,title,content,created_at,activated_at) VALUES (?,?,?,?,?,?,?)`).run(id("ctx"), workspaceId, hash(normalize(context.content)), context.title || "Context", normalize(context.content), context.createdAt || timestamp, context.activatedAt || timestamp);
    }
    saveContextVersion(db, workspaceId, { title: bundle.workspace.contextTitle || "Context", content, hash: hash(content), timestamp });
    for (const groupRef of new Set([...(bundle.workspace.groups || []), bundle.workspace.primaryGroup].filter(Boolean))) {
      if (groupMap.has(groupRef)) db.prepare(`INSERT OR IGNORE INTO workspace_groups VALUES (?,?,?)`).run(workspaceId, groupMap.get(groupRef).id, timestamp);
    }
    const documentMap = new Map();
    for (const document of bundle.documents) {
      const documentId = id("doc");
      const documentContent = normalize(document.content);
      if ([...documentMap.values()].some((item) => item.hash === hash(documentContent))) continue;
      documentMap.set(document.ref, { id: documentId, hash: hash(documentContent), parent: document.parent });
      db.prepare(`INSERT INTO documents (id,workspace_id,content_hash,content,title,change_summary,metadata_json,is_original,version,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)`)
        .run(documentId, workspaceId, hash(documentContent), documentContent, document.title || "Untitled", document.changeSummary || "", JSON.stringify(document.metadata || {}), document.isOriginal ? 1 : 0, Number.isInteger(document.version) ? document.version : documentMap.size - 1, document.createdAt || timestamp);
    }
    db.prepare(`UPDATE workspaces SET next_document_version=(SELECT coalesce(max(version), -1) + 1 FROM documents WHERE workspace_id=?) WHERE id=?`).run(workspaceId, workspaceId);
    for (const item of documentMap.values()) {
      if (item.parent && documentMap.has(item.parent)) db.prepare(`UPDATE documents SET parent_document_id=? WHERE id=?`).run(documentMap.get(item.parent).id, item.id);
    }
    for (const run of bundle.runs) {
      const document = documentMap.get(run.document);
      const group = groupMap.get(run.group);
      if (!document || !group) continue;
      const runId = id("run");
      db.prepare(`INSERT INTO evaluation_runs (id,workspace_id,document_id,group_id,status,overall_score,model,provider,note,metadata_json,usage_json,aggregation_error,error,context_hash,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
        .run(runId, workspaceId, document.id, group.id, run.status, run.overallScore ?? null, run.model ?? null, run.provider ?? null, run.note || "", JSON.stringify(run.metadata || {}), run.usage ? JSON.stringify(run.usage) : null, run.aggregationError ?? null, run.error ?? null, run.contextHash ?? hash(content), run.createdAt || timestamp);
      const questions = new Map(group.questions.map((question) => [question.key, question.id]));
      const insert = db.prepare(`INSERT OR IGNORE INTO evaluation_scores (run_id,question_id,raw_score,normalized_score,confidence,probabilities_json) VALUES (?,?,?,?,?,?)`);
      for (const score of run.scores || []) if (questions.has(score.key)) insert.run(runId, questions.get(score.key), score.rawScore, score.score, score.confidence ?? null, score.probabilities ? JSON.stringify(score.probabilities) : null);
    }
  });
  return resolveWorkspace(db, workspaceId);
}

export function matrixCsv(db, workspaceRef, options = {}) {
  const matrix = scoreMatrix(db, workspaceRef, options);
  const cell = (value) => {
    const text = value == null ? "" : String(value);
    return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const rows = [...matrix.rows].sort((a, b) => a.version - b.version);
  const header = ["version", "title", "original", "best", "runs", "overall", ...matrix.questions.map((question) => `${question.key} (${question.direction})`), "change_summary", "created_at"];
  const body = rows.map((row) => [row.version, row.title, row.isOriginal, row.isBest, row.runs, row.overallScore, ...matrix.questions.map((question) => row.scores[question.key]), row.changeSummary, row.createdAt]);
  return `${[header, ...body].map((line) => line.map(cell).join(",")).join("\n")}\n`;
}
