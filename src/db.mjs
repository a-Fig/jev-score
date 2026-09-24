import { mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { databasePath } from "./config.mjs";

// node:sqlite prints an ExperimentalWarning on every CLI call. Filter only that
// warning, then load the module dynamically so the filter is installed first.
const emitWarning = process.emitWarning;
process.emitWarning = function filteredWarning(warning, ...args) {
  const type = typeof args[0] === "string" ? args[0] : args[0]?.type;
  const message = typeof warning === "string" ? warning : warning?.message;
  if (type === "ExperimentalWarning" && /sqlite/i.test(String(message))) return;
  return emitWarning.call(this, warning, ...args);
};
const { DatabaseSync } = await import("node:sqlite");

export const SCHEMA_VERSION = 3;
export const contentHash = (text) => createHash("sha256").update(String(text).replace(/\r\n?/g, "\n")).digest("hex");

const schema = `
CREATE TABLE IF NOT EXISTS evaluation_groups (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  scorer_kind TEXT NOT NULL DEFAULT 'mean-v1' CHECK (scorer_kind IN ('mean-v1', 'javascript-v1')),
  scorer_source TEXT,
  scorer_hash TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_group_name
ON evaluation_groups(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS evaluation_questions (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL REFERENCES evaluation_groups(id) ON DELETE CASCADE,
  question_key TEXT NOT NULL,
  text TEXT NOT NULL,
  direction TEXT NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher', 'lower')),
  position INTEGER NOT NULL,
  UNIQUE (group_id, question_key)
);

CREATE TABLE IF NOT EXISTS workspaces (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  context_title TEXT NOT NULL DEFAULT 'Context',
  context_content TEXT NOT NULL,
  context_hash TEXT,
  next_document_version INTEGER NOT NULL DEFAULT 0,
  primary_group_id TEXT REFERENCES evaluation_groups(id) ON DELETE SET NULL,
  ranking_mode TEXT NOT NULL DEFAULT 'max' CHECK (ranking_mode IN ('max', 'median')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_workspace_name
ON workspaces(name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS workspace_contexts (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  activated_at TEXT NOT NULL,
  UNIQUE (workspace_id, content_hash)
);

CREATE TABLE IF NOT EXISTS workspace_groups (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES evaluation_groups(id) ON DELETE CASCADE,
  attached_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, group_id)
);

CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  content_hash TEXT NOT NULL,
  content TEXT NOT NULL,
  title TEXT NOT NULL,
  change_summary TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  parent_document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
  is_original INTEGER NOT NULL DEFAULT 0 CHECK (is_original IN (0, 1)),
  version INTEGER,
  created_at TEXT NOT NULL,
  UNIQUE (workspace_id, content_hash)
);

CREATE UNIQUE INDEX IF NOT EXISTS one_original_per_workspace
ON documents(workspace_id) WHERE is_original = 1;

CREATE TABLE IF NOT EXISTS evaluation_runs (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  group_id TEXT NOT NULL REFERENCES evaluation_groups(id) ON DELETE CASCADE,
  status TEXT NOT NULL CHECK (status IN ('success', 'aggregation_error', 'jev_error')),
  overall_score REAL,
  model TEXT,
  provider TEXT,
  note TEXT NOT NULL DEFAULT '',
  metadata_json TEXT NOT NULL DEFAULT '{}',
  usage_json TEXT,
  aggregation_error TEXT,
  error TEXT,
  context_hash TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS runs_lookup
ON evaluation_runs(workspace_id, group_id, document_id, created_at);

CREATE TABLE IF NOT EXISTS evaluation_scores (
  run_id TEXT NOT NULL REFERENCES evaluation_runs(id) ON DELETE CASCADE,
  question_id TEXT NOT NULL REFERENCES evaluation_questions(id) ON DELETE CASCADE,
  raw_score REAL NOT NULL,
  normalized_score REAL NOT NULL,
  confidence REAL,
  probabilities_json TEXT,
  PRIMARY KEY (run_id, question_id)
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Append-only record of provider spend. It has no foreign keys, so deleting a
-- workspace never lowers the spend that counts toward the global limit.
CREATE TABLE IF NOT EXISTS usage_ledger (
  run_id TEXT PRIMARY KEY,
  workspace_id TEXT,
  model TEXT,
  provider TEXT,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  total_tokens INTEGER NOT NULL DEFAULT 0,
  cost REAL,
  created_at TEXT NOT NULL
);

-- Evaluations in progress, so every open UI can show what an agent is scoring.
CREATE TABLE IF NOT EXISTS evaluation_activity (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  group_id TEXT,
  source TEXT NOT NULL DEFAULT 'cli',
  started_at TEXT NOT NULL
);
`;

const columns = (db, table) => new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((column) => column.name));

export function usageNumbers(usage) {
  const number = (...values) => values.find(Number.isFinite) ?? 0;
  if (!usage) return null;
  const input = number(usage.input_tokens, usage.prompt_tokens, usage.inputTokens);
  const output = number(usage.output_tokens, usage.completion_tokens, usage.outputTokens);
  return { input, output, total: number(usage.total_tokens, usage.totalTokens) || input + output, cost: Number.isFinite(usage.cost) ? usage.cost : null };
}

function migrate(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!columns(db, "evaluation_questions").has("direction")) {
      db.exec("ALTER TABLE evaluation_questions ADD COLUMN direction TEXT NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher', 'lower'))");
    }
    // v3: stable document versions, context versions, spend ledger.
    if (!columns(db, "documents").has("version")) db.exec("ALTER TABLE documents ADD COLUMN version INTEGER");
    if (!columns(db, "workspaces").has("context_hash")) db.exec("ALTER TABLE workspaces ADD COLUMN context_hash TEXT");
    if (!columns(db, "workspaces").has("next_document_version")) db.exec("ALTER TABLE workspaces ADD COLUMN next_document_version INTEGER NOT NULL DEFAULT 0");
    if (!columns(db, "evaluation_runs").has("context_hash")) db.exec("ALTER TABLE evaluation_runs ADD COLUMN context_hash TEXT");
    db.exec(`UPDATE documents SET version = (SELECT n FROM (SELECT id, row_number() OVER (PARTITION BY workspace_id ORDER BY rowid) - 1 n FROM documents) numbered WHERE numbered.id = documents.id) WHERE version IS NULL`);
    db.exec("CREATE UNIQUE INDEX IF NOT EXISTS unique_document_version ON documents(workspace_id, version)");
    // Version numbers are never reused, even after the newest draft is deleted.
    db.exec("UPDATE workspaces SET next_document_version = (SELECT coalesce(max(version), -1) + 1 FROM documents WHERE workspace_id = workspaces.id) WHERE next_document_version < (SELECT coalesce(max(version), -1) + 1 FROM documents WHERE workspace_id = workspaces.id)");
    const setHash = db.prepare("UPDATE workspaces SET context_hash = ? WHERE id = ?");
    const saveContext = db.prepare("INSERT OR IGNORE INTO workspace_contexts (id, workspace_id, content_hash, title, content, created_at, activated_at) VALUES (?,?,?,?,?,?,?)");
    for (const workspace of db.prepare("SELECT * FROM workspaces WHERE context_hash IS NULL").all()) {
      const hash = contentHash(workspace.context_content);
      setHash.run(hash, workspace.id);
      saveContext.run(`ctx_${hash.slice(0, 12)}_${workspace.id.slice(-8)}`, workspace.id, hash, workspace.context_title, workspace.context_content, workspace.created_at, workspace.created_at);
    }
    db.exec("UPDATE evaluation_runs SET context_hash = (SELECT context_hash FROM workspaces WHERE workspaces.id = evaluation_runs.workspace_id) WHERE context_hash IS NULL");
    const ledger = db.prepare("INSERT OR IGNORE INTO usage_ledger (run_id, workspace_id, model, provider, input_tokens, output_tokens, total_tokens, cost, created_at) VALUES (?,?,?,?,?,?,?,?,?)");
    if ((db.prepare("PRAGMA user_version").get().user_version || 0) < 3) {
      for (const run of db.prepare("SELECT id, workspace_id, model, provider, usage_json, created_at FROM evaluation_runs WHERE usage_json IS NOT NULL").all()) {
        let usage = null;
        try { usage = usageNumbers(JSON.parse(run.usage_json)); } catch {}
        if (usage) ledger.run(run.id, run.workspace_id, run.model, run.provider, usage.input, usage.output, usage.total, usage.cost, run.created_at);
      }
    }
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}; COMMIT`);
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function openDatabase(path = databasePath()) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  db.exec(schema);
  migrate(db);
  return db;
}

// A lightweight second connection whose data_version changes whenever any
// other connection, in this process or another, commits to the database.
export function openWatcher(path) {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA busy_timeout = 1000;");
  const statement = db.prepare("PRAGMA data_version");
  return { version: () => statement.get().data_version, close: () => db.close() };
}

export function inTransaction(db, operation) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
