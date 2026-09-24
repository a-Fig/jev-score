import { createReadStream, existsSync, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { pipeline } from "node:stream";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseIdentity, databasePath } from "./config.mjs";
import { openDatabase, openWatcher } from "./db.mjs";
import { DEFAULT_MODEL, checkOpenRouterKey } from "./jev.mjs";
import { renderReport } from "./report.mjs";
import {
  activity, addDocument, attachGroup, contextHistory, createGroup, createWorkspace, dashboard, deleteDocument, deleteGroup,
  deleteWorkspace, detachGroup, documentDetail, documentFeedback, exportWorkspace, forkGroup, importWorkspace, listDocuments,
  matrixCsv, ranking, resetSpendCounter, resolveGroup, scoreDocument, setSpendLimit, spendStatus, updateDocument,
  updateGroup, updateWorkspace, usageSummary, workspaceDetail,
} from "./service.mjs";
import { TEMPLATES } from "./templates.mjs";

const publicDirectory = resolve(fileURLToPath(new URL("../web/", import.meta.url)));
const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const mime = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml", ".json": "application/json", ".woff2": "font/woff2", ".png": "image/png", ".ico": "image/x-icon",
  ".webmanifest": "application/manifest+json", ".txt": "text/plain; charset=utf-8",
};
const securityHeaders = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Frame-Options": "DENY",
};
const appPolicy = "default-src 'self'; img-src 'self' data: https: http:; style-src 'self' 'unsafe-inline'; script-src 'self'; font-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
const reportPolicy = "default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline'; frame-ancestors 'none'";
const safeFilename = (value, fallback = "document") => String(value).replace(/[^a-z0-9._-]+/gi, "-").replace(/^-+|-+$/g, "") || fallback;

function send(response, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data), "Cache-Control": "no-store", ...securityHeaders, ...headers });
  response.end(data);
}

async function readBody(request, limit = 10 * 1024 * 1024) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > limit) throw Object.assign(new Error(`Request body exceeds ${Math.round(limit / 1024 / 1024)} MB.`), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  let value;
  try { value = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw Object.assign(new Error("Request body must be a JSON object."), { status: 400 });
  return value;
}

const CREATED = Symbol("created");
const created = (value) => ({ [CREATED]: value });
const file = (content, type, filename) => ({ raw: content, headers: { "Content-Type": type, "Content-Disposition": `attachment; filename="${filename}"` } });

function route(method, pattern, handler) {
  const keys = [];
  const regex = new RegExp(`^${pattern.replace(/:(\w+)/g, (_, key) => { keys.push(key); return "([^/]+)"; })}/?$`);
  return { method, regex, keys, handler };
}

const routes = [
  route("GET", "/api/health", ({ instanceId }) => ({ ok: true, app: "jev-score", version, databaseId: instanceId })),
  route("GET", "/api/dashboard", ({ db }) => dashboard(db)),
  route("GET", "/api/usage", ({ db }) => usageSummary(db)),
  route("GET", "/api/activity", ({ db }) => activity(db)),
  route("GET", "/api/templates", () => TEMPLATES),
  route("GET", "/api/settings", ({ db, dbPath }) => ({
    version, node: process.versions.node, database: dbPath || null,
    apiKey: { present: Boolean(process.env.OPENROUTER_API_KEY), model: process.env.OPENROUTER_JEV_MODEL || DEFAULT_MODEL },
    spend: spendStatus(db),
  })),
  route("PATCH", "/api/settings", async ({ db, body }) => {
    const input = await body();
    if (input.spendLimit !== undefined) return { spend: setSpendLimit(db, input.spendLimit) };
    return { spend: spendStatus(db) };
  }),
  route("POST", "/api/settings/spend-reset", ({ db }) => ({ spend: resetSpendCounter(db) })),
  route("GET", "/api/settings/check", async () => checkOpenRouterKey()),

  route("POST", "/api/groups", async ({ db, body }) => {
    const input = await body();
    if (input.scorerSource) throw Object.assign(new Error("Custom scorer code can only be added through the local CLI."), { status: 400 });
    return created(createGroup(db, { name: input.name, description: input.description, questions: input.questions, template: input.template }));
  }),
  route("GET", "/api/groups/:group", ({ db, params }) => resolveGroup(db, params.group)),
  route("PATCH", "/api/groups/:group", async ({ db, params, body }) => {
    const { name, description, questions } = await body();
    return updateGroup(db, params.group, { name, description, questions });
  }),
  route("DELETE", "/api/groups/:group", ({ db, params }) => deleteGroup(db, params.group)),
  route("POST", "/api/groups/:group/fork", async ({ db, params, body }) => created(forkGroup(db, params.group, { name: (await body()).name }))),

  route("POST", "/api/workspaces", async ({ db, body }) => {
    const { name, contextTitle, contextContent, primaryGroup, template } = await body();
    return created(createWorkspace(db, { name, contextTitle, contextContent, primaryGroup, template }));
  }),
  route("POST", "/api/workspaces/import", async ({ db, body, query }) => created(importWorkspace(db, await body(50 * 1024 * 1024), { name: query.get("name") }))),
  route("GET", "/api/workspaces/:ws", ({ db, params, query }) => workspaceDetail(db, params.ws, { group: query.get("group"), question: query.get("question"), mode: query.get("mode") })),
  route("PATCH", "/api/workspaces/:ws", async ({ db, params, body }) => {
    const { name, contextTitle, contextContent, primaryGroup, rankingMode } = await body();
    return updateWorkspace(db, params.ws, { name, contextTitle, contextContent, primaryGroup, rankingMode });
  }),
  route("DELETE", "/api/workspaces/:ws", ({ db, params }) => deleteWorkspace(db, params.ws)),
  route("POST", "/api/workspaces/:ws/groups", async ({ db, params, body }) => attachGroup(db, params.ws, (await body()).group)),
  route("DELETE", "/api/workspaces/:ws/groups/:group", ({ db, params }) => detachGroup(db, params.ws, params.group)),
  route("GET", "/api/workspaces/:ws/ranking", ({ db, params, query }) => ranking(db, params.ws, { group: query.get("group"), question: query.get("question"), mode: query.get("mode") })),
  route("GET", "/api/workspaces/:ws/contexts", ({ db, params }) => contextHistory(db, params.ws)),
  route("GET", "/api/workspaces/:ws/export", ({ db, params, query }) => {
    const format = query.get("format") || "json";
    if (format === "csv") {
      const csv = matrixCsv(db, params.ws, { group: query.get("group"), mode: query.get("mode") });
      return file(csv, "text/csv; charset=utf-8", `${safeFilename(params.ws, "workspace")}-scores.csv`);
    }
    if (format !== "json") throw Object.assign(new Error("Export format must be json or csv."), { status: 400 });
    const bundle = exportWorkspace(db, params.ws, { appVersion: version });
    return file(JSON.stringify(bundle, null, 2), "application/json; charset=utf-8", `${safeFilename(bundle.workspace.name, "workspace")}.jev.json`);
  }),
  route("GET", "/api/workspaces/:ws/report", ({ db, params, query }) => {
    const format = query.get("format") || "html";
    const report = renderReport(db, params.ws, { format, group: query.get("group"), mode: query.get("mode"), appVersion: version });
    const type = format === "md" ? "text/markdown; charset=utf-8" : "text/html; charset=utf-8";
    const headers = { "Content-Type": type, "Content-Security-Policy": reportPolicy };
    if (query.has("download")) headers["Content-Disposition"] = `attachment; filename="${safeFilename(report.name, "report")}-report.${format === "md" ? "md" : "html"}"`;
    return { raw: report.content, headers };
  }),
  route("GET", "/api/workspaces/:ws/documents", ({ db, params }) => listDocuments(db, params.ws)),
  route("POST", "/api/workspaces/:ws/documents", async ({ db, params, body }) => created(addDocument(db, params.ws, await body()))),
  route("GET", "/api/workspaces/:ws/documents/:doc", ({ db, params, query }) => {
    const document = documentDetail(db, params.ws, params.doc);
    if (query.has("download")) return file(document.content, "text/markdown; charset=utf-8", `${safeFilename(document.title)}.md`);
    return document;
  }),
  route("PATCH", "/api/workspaces/:ws/documents/:doc", async ({ db, params, body }) => {
    const { title, changeSummary, original } = await body();
    return updateDocument(db, params.ws, params.doc, { title, changeSummary, original });
  }),
  route("DELETE", "/api/workspaces/:ws/documents/:doc", ({ db, params }) => deleteDocument(db, params.ws, params.doc)),
  route("GET", "/api/workspaces/:ws/documents/:doc/feedback", ({ db, params, query }) => documentFeedback(db, params.ws, params.doc, { group: query.get("group") })),
  route("POST", "/api/workspaces/:ws/documents/:doc/evaluate", async ({ db, params, body, evaluate }) => {
    const input = await body();
    return created(await scoreDocument(db, params.ws, params.doc, { group: input.group, runs: input.runs ?? 1, note: input.note, metadata: input.metadata, source: "ui", ...(evaluate ? { evaluate } : {}) }));
  }),
];

async function api(context) {
  const { request, response, url } = context;
  if (request.method === "GET" && url.pathname === "/api/events") return events(context);
  for (const candidate of routes) {
    if (candidate.method !== request.method) continue;
    const match = url.pathname.match(candidate.regex);
    if (!match) continue;
    const params = Object.fromEntries(candidate.keys.map((key, index) => [key, decodeURIComponent(match[index + 1])]));
    const result = await candidate.handler({ ...context, params, query: url.searchParams, body: (limit) => readBody(request, limit) });
    if (request.method !== "GET") context.broadcast("change", { reason: `${request.method} ${url.pathname}` });
    if (result?.raw !== undefined) return send(response, 200, result.raw, result.headers);
    if (result && Object.hasOwn(result, CREATED)) return send(response, 201, result[CREATED]);
    return send(response, 200, result);
  }
  send(response, 404, { error: "Not found" });
}

function events({ request, response, clients }) {
  response.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", Connection: "keep-alive", ...securityHeaders });
  response.write(`retry: 2000\nevent: ready\ndata: {}\n\n`);
  clients.add(response);
  request.on("close", () => clients.delete(response));
}

async function staticFile(response, pathname) {
  const relative = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
  const candidate = resolve(publicDirectory, relative);
  if (!(candidate === publicDirectory || candidate.startsWith(`${publicDirectory}${sep}`)) || !existsSync(candidate)) return false;
  const info = await stat(candidate);
  if (!info.isFile()) return false;
  const extension = extname(candidate);
  response.writeHead(200, {
    "Content-Type": mime[extension] || "application/octet-stream", "Content-Length": info.size,
    "Cache-Control": extension === ".woff2" ? "public, max-age=31536000, immutable" : "no-cache",
    ...securityHeaders, ...(extension === ".html" ? { "Content-Security-Policy": appPolicy } : {}),
  });
  // pipeline closes the file when the client disconnects early.
  pipeline(createReadStream(candidate), response, () => {});
  return true;
}

export function startServer({ port = 4317, host = "127.0.0.1", db = null, dbPath = null, instanceId = databaseIdentity(), evaluate = null, watchIntervalMs = 400 } = {}) {
  if (!db) { dbPath ||= databasePath(); db = openDatabase(dbPath); }
  const clients = new Set();
  let pending = null;
  // Coalesce bursts (an agent saving and scoring) into one event per tick.
  const broadcast = (event = "change", data = {}) => {
    if (pending) return;
    pending = setTimeout(() => {
      pending = null;
      const payload = `event: ${event}\ndata: ${JSON.stringify({ ...data, at: Date.now() })}\n\n`;
      for (const client of clients) client.write(payload);
    }, 60);
  };
  // A second connection sees commits from every process, including the CLI
  // and MCP server, through SQLite's data_version counter.
  const watcher = dbPath && dbPath !== ":memory:" ? openWatcher(dbPath) : null;
  let lastVersion = watcher?.version();
  const poll = watcher ? setInterval(() => {
    try {
      const current = watcher.version();
      if (current !== lastVersion) { lastVersion = current; broadcast("change", { reason: "database" }); }
    } catch {}
  }, watchIntervalMs) : null;
  poll?.unref();
  const heartbeat = setInterval(() => { for (const client of clients) client.write(": ping\n\n"); }, 25_000);
  heartbeat.unref();

  const server = createServer(async (request, response) => {
    try {
      const requestHost = request.headers.host || "";
      if (!/^(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?$/i.test(requestHost)) throw Object.assign(new Error("Invalid host."), { status: 403 });
      const url = new URL(request.url, `http://${requestHost}`);
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${requestHost}`) throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
        if (["POST", "PATCH", "PUT"].includes(request.method) && !String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("Mutating requests must use application/json."), { status: 415 });
        }
      }
      if (url.pathname.startsWith("/api/")) await api({ db, dbPath, request, response, url, instanceId, clients, broadcast, evaluate });
      else if (!(await staticFile(response, url.pathname)) && !(await staticFile(response, "/"))) send(response, 404, { error: "UI assets not found." });
    } catch (error) {
      const constraint = /constraint failed/i.test(error?.message || "");
      const status = error.status || (error instanceof URIError ? 400 : constraint ? 409 : 500);
      if (!response.headersSent) send(response, status, { error: error instanceof URIError ? "The address is not valid." : error.message || String(error), runId: error.runId || null, runIds: error.runIds || null });
      else response.end();
    }
  });
  const close = server.close.bind(server);
  server.close = (callback) => {
    clearInterval(poll); clearInterval(heartbeat); clearTimeout(pending);
    for (const client of clients) client.end();
    clients.clear();
    try { watcher?.close(); } catch {}
    const result = close(callback);
    server.closeAllConnections?.();
    return result;
  };
  return new Promise((resolvePromise, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolvePromise({ server, db, url: `http://${host}:${server.address().port}`, broadcast }));
  });
}
