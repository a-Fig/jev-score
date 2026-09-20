import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { databasePath } from "./config.mjs";

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
  primary_group_id TEXT REFERENCES evaluation_groups(id) ON DELETE SET NULL,
  ranking_mode TEXT NOT NULL DEFAULT 'max' CHECK (ranking_mode IN ('max', 'median')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS unique_workspace_name
ON workspaces(name COLLATE NOCASE);

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

`;

function migrate(db) {
  db.exec("BEGIN IMMEDIATE");
  try {
    const questionColumns = db.prepare("PRAGMA table_info(evaluation_questions)").all();
    if (!questionColumns.some((column) => column.name === "direction")) {
      db.exec("ALTER TABLE evaluation_questions ADD COLUMN direction TEXT NOT NULL DEFAULT 'higher' CHECK (direction IN ('higher', 'lower'))");
    }
    db.exec("PRAGMA user_version = 2; COMMIT");
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
