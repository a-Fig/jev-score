#!/usr/bin/env node

import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { databaseIdentity, databasePath, loadEnv } from "../src/config.mjs";
import { inTransaction, openDatabase } from "../src/db.mjs";
import { startServer } from "../src/server.mjs";
import {
  addDocument, attachGroup, createGroup, createWorkspace, deleteGroup, deleteWorkspace,
  documentDetail, evaluateDocument, listDocuments, listGroups, listWorkspaces, ranking, renameGroup,
  resolveGroup, updateWorkspace, usageSummary, workspaceDetail,
} from "../src/service.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const out = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);

function help() {
  process.stdout.write(`Jev Score ${version} — local document evaluation for coding agents

Usage:
  jev-score workspace create --name <name> --context <file> [--context-title <title>] [--group <group>]
  jev-score workspace list | show <workspace> | delete <workspace> --yes
  jev-score workspace primary <workspace> <group>
  jev-score workspace mode <workspace> <max|median>
  jev-score group create --name <name> --questions <file> [--description <text>] [--scorer <file.mjs>]
  jev-score group list | show <group> | rename <group> <name> | delete <group> --yes
  jev-score group attach <workspace> <group>
  jev-score document add <workspace> <file> [--title <title>] [--summary <text>] [--parent <document>] [--original]
  jev-score document list <workspace>
  jev-score document get <workspace> <document> [--out <file>]
  jev-score score <workspace> <document-or-file> [--group <group>] [--title <title>] [--summary <text>]
  jev-score rank <workspace> [--group <group>] [--question <key>] [--mode <max|median>]
  jev-score usage                     Show locally recorded Jev tokens and costs
  jev-score ui [--port <port>]      Start the app and open it in your browser
  jev-score serve [--port <port>]   Run the local app without opening a browser
  jev-score db path | reset --yes

Question files may be a JSON array or one question per line. Prefix a line with [lower]
when a lower score is better; all other questions default to higher-is-better.
Names or IDs work as references.
The CLI loads .env and .env.local from the current directory. Set OPENROUTER_API_KEY to evaluate.
`);
}

function parse(tokens) {
  const positional = [];
  const flags = {};
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token.startsWith("--")) { positional.push(token); continue; }
    const key = token.slice(2);
    if (["yes", "original"].includes(key)) { flags[key] = true; continue; }
    const value = tokens[++index];
    if (!value || value.startsWith("--")) throw new Error(`Missing value for --${key}`);
    flags[key] = value;
  }
  return { positional, flags };
}

function requireFlag(flags, key) {
  if (!flags[key]) throw new Error(`--${key} is required.`);
  return flags[key];
}

async function questionsFrom(path) {
  const text = await readFile(resolve(path), "utf8");
  if (extname(path).toLowerCase() === ".json") {
    const value = JSON.parse(text);
    if (!Array.isArray(value)) throw new Error("Question JSON must be an array.");
    return value;
  }
  return text.split(/\r?\n/).map((line) => line.replace(/^\s*[-*]\s*/, "").trim()).filter(Boolean).map((line) => {
    const lower = line.match(/^\[(?:lower|low)\]\s*(.+)$/i);
    return { text: lower ? lower[1].trim() : line, direction: lower ? "lower" : "higher" };
  });
}

async function openBrowser(url) {
  const command = process.platform === "win32" ? "cmd" : process.platform === "darwin" ? "open" : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  spawn(command, args, { detached: true, stdio: "ignore", windowsHide: true }).unref();
}

async function health(url) {
  const response = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(750) });
  if (!response.ok) return null;
  return response.json();
}

async function waitForServer(url, instanceId) {
  for (let tries = 0; tries < 40; tries += 1) {
    try { const status = await health(url); if (status?.app === "jev-score" && status.databaseId === instanceId) return; } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error("The local UI did not start.");
}

async function main() {
  loadEnv();
  const args = process.argv.slice(2);
  if (!args.length || args.includes("--help") || args[0] === "help") return help();
  if (args.includes("--version")) return process.stdout.write(`${version}\n`);
  const [area, action, ...rest] = args;
  const { positional, flags } = parse(rest);

  if (["serve", "ui"].includes(area)) {
    const parsed = parse(args.slice(1));
    const port = Number(parsed.flags.port || 4317);
    const url = `http://127.0.0.1:${port}`;
    const instanceId = databaseIdentity();
    if (area === "ui") {
      let status = null;
      try { status = await health(url); } catch {}
      if (status && (status.app !== "jev-score" || status.databaseId !== instanceId)) throw new Error(`Port ${port} is already serving a different application or Jev Score database. Choose another port with --port.`);
      if (!status) {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "serve", "--port", String(port)], { detached: true, stdio: "ignore", windowsHide: true, cwd: process.cwd(), env: process.env });
        child.unref();
        await waitForServer(url, instanceId);
      }
      await openBrowser(url);
      return out({ opened: url });
    }
    const running = await startServer({ port });
    process.stdout.write(`Jev Score is running at ${running.url}\n`);
    return;
  }

  if (area === "db" && action === "path") return out({ path: databasePath() });
  if (area === "db" && action === "reset") {
    if (!flags.yes) throw new Error("Database reset is permanent. Re-run with --yes.");
    const path = databasePath();
    const resetDb = openDatabase(path);
    try {
      inTransaction(resetDb, () => { resetDb.exec("DELETE FROM workspaces; DELETE FROM evaluation_groups;"); });
      resetDb.exec("VACUUM");
    } finally { resetDb.close(); }
    return out({ reset: path });
  }

  const db = openDatabase();
  try {
    if (area === "usage") return out(usageSummary(db));
    if (area === "workspace") {
      if (action === "list") return out(listWorkspaces(db));
      if (action === "show") return out(workspaceDetail(db, positional[0]));
      if (action === "create") return out(createWorkspace(db, { name: requireFlag(flags, "name"), contextTitle: flags["context-title"], contextContent: await readFile(resolve(requireFlag(flags, "context")), "utf8"), primaryGroup: flags.group }));
      if (action === "delete") { if (!flags.yes) throw new Error("Workspace deletion is permanent. Re-run with --yes."); return out(deleteWorkspace(db, positional[0])); }
      if (action === "primary") return out(updateWorkspace(db, positional[0], { primaryGroup: positional[1] }));
      if (action === "mode") return out(updateWorkspace(db, positional[0], { rankingMode: positional[1] }));
    }
    if (area === "group") {
      if (action === "list") return out(listGroups(db));
      if (action === "show") return out(resolveGroup(db, positional[0]));
      if (action === "create") return out(createGroup(db, { name: requireFlag(flags, "name"), description: flags.description, questions: await questionsFrom(requireFlag(flags, "questions")), scorerSource: flags.scorer ? await readFile(resolve(flags.scorer), "utf8") : null }));
      if (action === "rename") return out(renameGroup(db, positional[0], positional[1]));
      if (action === "delete") { if (!flags.yes) throw new Error("Group deletion also deletes its scores. Re-run with --yes."); return out(deleteGroup(db, positional[0])); }
      if (action === "attach") return out(attachGroup(db, positional[0], positional[1]));
    }
    if (area === "document") {
      if (action === "list") return out(listDocuments(db, positional[0]));
      if (action === "add") {
        const path = resolve(positional[1]);
        return out(addDocument(db, positional[0], { content: await readFile(path, "utf8"), title: flags.title || path.split(/[\\/]/).pop(), changeSummary: flags.summary, parentDocument: flags.parent, original: flags.original, metadata: flags.metadata ? JSON.parse(flags.metadata) : {} }));
      }
      if (action === "get") {
        const document = documentDetail(db, positional[0], positional[1]);
        if (flags.out) { await writeFile(resolve(flags.out), document.content, "utf8"); return out({ written: resolve(flags.out), documentId: document.id }); }
        return out(document);
      }
    }
    if (area === "score") {
      let documentRef = positional[0];
      if (existsSync(resolve(documentRef))) {
        const path = resolve(documentRef);
        const saved = addDocument(db, action, { content: await readFile(path, "utf8"), title: flags.title || path.split(/[\\/]/).pop(), changeSummary: flags.summary, parentDocument: flags.parent, metadata: flags.metadata ? JSON.parse(flags.metadata) : {} });
        documentRef = saved.id;
      }
      return out(await evaluateDocument(db, action, documentRef, { group: flags.group, note: flags.note, metadata: flags.metadata ? JSON.parse(flags.metadata) : {} }));
    }
    if (area === "rank") return out(ranking(db, action, { group: flags.group, question: flags.question, mode: flags.mode }));
    throw new Error("Unknown command. Run jev-score --help.");
  } finally { db.close(); }
}

main().catch((error) => {
  process.stderr.write(`jev-score: ${error instanceof Error ? error.message : String(error)}${error.runId ? ` (run ${error.runId})` : ""}\n`);
  process.exitCode = 1;
});
