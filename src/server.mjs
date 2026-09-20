import { createReadStream, existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { databaseIdentity } from "./config.mjs";
import { openDatabase } from "./db.mjs";
import {
  addDocument, attachGroup, createGroup, createWorkspace, dashboard, deleteGroup, deleteWorkspace,
  documentDetail, evaluateDocument, listDocuments, ranking, renameGroup, resolveDocument, resolveGroup,
  updateWorkspace, usageSummary, workspaceDetail,
} from "./service.mjs";

const publicDirectory = resolve(fileURLToPath(new URL("../web/", import.meta.url)));
const mime = { ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json" };

function send(response, status, body, headers = {}) {
  const data = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Content-Length": Buffer.byteLength(data), ...headers });
  response.end(data);
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 10 * 1024 * 1024) throw Object.assign(new Error("Request body exceeds 10 MB."), { status: 413 });
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw Object.assign(new Error("Request body must be valid JSON."), { status: 400 }); }
}

function parts(pathname) { return pathname.split("/").filter(Boolean).map(decodeURIComponent); }

async function api(db, request, response, url, instanceId) {
  const path = parts(url.pathname);
  const method = request.method;
  if (method === "GET" && url.pathname === "/api/health") return send(response, 200, { ok: true, app: "jev-score", databaseId: instanceId });
  if (method === "GET" && url.pathname === "/api/dashboard") return send(response, 200, dashboard(db));
  if (method === "GET" && url.pathname === "/api/usage") return send(response, 200, usageSummary(db));
  if (path[1] === "groups") {
    if (method === "POST" && path.length === 2) {
      const input = await body(request);
      if (input.scorerSource) throw Object.assign(new Error("Custom scorer code can only be added through the local CLI."), { status: 400 });
      return send(response, 201, createGroup(db, input));
    }
    if (method === "GET" && path.length === 3) return send(response, 200, resolveGroup(db, path[2]));
    if (method === "PATCH" && path.length === 3) return send(response, 200, renameGroup(db, path[2], (await body(request)).name));
    if (method === "DELETE" && path.length === 3) return send(response, 200, deleteGroup(db, path[2]));
  }
  if (path[1] === "workspaces") {
    if (method === "POST" && path.length === 2) return send(response, 201, createWorkspace(db, await body(request)));
    if (path.length >= 3) {
      const workspace = path[2];
      if (method === "GET" && path.length === 3) return send(response, 200, workspaceDetail(db, workspace, { group: url.searchParams.get("group"), question: url.searchParams.get("question"), mode: url.searchParams.get("mode") }));
      if (method === "PATCH" && path.length === 3) return send(response, 200, updateWorkspace(db, workspace, await body(request)));
      if (method === "DELETE" && path.length === 3) return send(response, 200, deleteWorkspace(db, workspace));
      if (method === "POST" && path[3] === "groups") return send(response, 200, attachGroup(db, workspace, (await body(request)).group));
      if (method === "GET" && path[3] === "ranking") return send(response, 200, ranking(db, workspace, { group: url.searchParams.get("group"), question: url.searchParams.get("question"), mode: url.searchParams.get("mode") }));
      if (path[3] === "documents") {
        if (method === "GET" && path.length === 4) return send(response, 200, listDocuments(db, workspace));
        if (method === "POST" && path.length === 4) return send(response, 201, addDocument(db, workspace, await body(request)));
        if (method === "GET" && path.length === 5) {
          const document = documentDetail(db, workspace, path[4]);
          if (url.searchParams.has("download")) {
            const safe = document.title.replace(/[^a-z0-9._-]+/gi, "-") || "document";
            return send(response, 200, document.content, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename="${safe}.md"` });
          }
          return send(response, 200, document);
        }
        if (method === "POST" && path.length === 6 && path[5] === "evaluate") {
          return send(response, 201, await evaluateDocument(db, workspace, path[4], await body(request)));
        }
      }
    }
  }
  send(response, 404, { error: "Not found" });
}

async function staticFile(response, pathname) {
  const relative = pathname === "/" ? "index.html" : pathname.slice(1);
  const candidate = resolve(publicDirectory, relative);
  if (!(candidate === publicDirectory || candidate.startsWith(`${publicDirectory}${sep}`)) || !existsSync(candidate) || !(await stat(candidate)).isFile()) return false;
  const info = await stat(candidate);
  response.writeHead(200, { "Content-Type": mime[extname(candidate)] || "application/octet-stream", "Content-Length": info.size, "Cache-Control": "no-cache" });
  createReadStream(candidate).pipe(response);
  return true;
}

export function startServer({ port = 4317, host = "127.0.0.1", db = openDatabase(), instanceId = databaseIdentity() } = {}) {
  const server = createServer(async (request, response) => {
    try {
      const requestHost = request.headers.host || "";
      if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(requestHost)) throw Object.assign(new Error("Invalid host."), { status: 403 });
      const url = new URL(request.url, `http://${request.headers.host || `${host}:${port}`}`);
      if (["POST", "PATCH", "PUT", "DELETE"].includes(request.method)) {
        const origin = request.headers.origin;
        if (origin && origin !== `http://${requestHost}`) throw Object.assign(new Error("Cross-origin requests are not allowed."), { status: 403 });
        if (["POST", "PATCH", "PUT"].includes(request.method) && !String(request.headers["content-type"] || "").toLowerCase().startsWith("application/json")) {
          throw Object.assign(new Error("Mutating requests must use application/json."), { status: 415 });
        }
      }
      if (url.pathname.startsWith("/api/")) await api(db, request, response, url, instanceId);
      else if (!(await staticFile(response, url.pathname)) && !(await staticFile(response, "/"))) send(response, 404, { error: "UI assets not found." });
    } catch (error) {
      send(response, error.status || 500, { error: error.message || String(error), runId: error.runId || null });
    }
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => resolve({ server, db, url: `http://${host}:${server.address().port}` }));
  });
}
