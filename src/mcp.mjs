import { createInterface } from "node:readline";
import { openDatabase } from "./db.mjs";
import {
  addDocument, createGroup, createWorkspace, documentDetail, listGroups, listWorkspaces, ranking,
  scoreDocument, workspaceDetail, workspaceSummary,
} from "./service.mjs";
import { TEMPLATES } from "./templates.mjs";

// A dependency-free Model Context Protocol server over stdio. Each message is
// one line of JSON-RPC 2.0. Only protocol messages go to stdout.

export const PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

const INSTRUCTIONS = `Jev Score stores drafts of a document and scores them with TypeSafe's Jev model against a workspace's context (a job posting, an essay prompt, a brief) and an evaluation group of questions. Every score is 0-100; each question is either higher-is-better or lower-is-better, and every "vs" delta is signed so that positive means better.

Loop: read the workspace with get_workspace, write a substantially better draft, then call score_document with the full text, a short title, a one-line summary of what changed, and parent set to the draft you revised. Read weakest and vsParent to choose the next revision. Make bold, meaningful changes rather than small word swaps: a gap of one or two points is within Jev's run-to-run variation. Keep runs at 1; use runs 3 only to decide between the top two drafts when they are within about two points. Preserve the author's facts and voice. Stop when the user's goal is met or scores stop improving.`;

const text = (value) => ({ type: "string", description: value });
const TOOLS = [
  {
    name: "list_workspaces",
    title: "List workspaces",
    description: "List every workspace with its best draft, change from the original, and draft count.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: (db) => listWorkspaces(db).map((workspace) => {
      const summary = workspaceSummary(db, workspace.id);
      return { id: summary.id, name: summary.name, contextTitle: summary.contextTitle, group: summary.groupName, drafts: summary.documentCount, scored: summary.evaluated, best: summary.best, changeFromOriginal: summary.delta, lastActivityAt: summary.lastActivityAt };
    }),
  },
  {
    name: "get_workspace",
    title: "Get workspace",
    description: "Read a workspace: its context, evaluation group questions, and every draft ranked by score, with per-question scores. Call this before revising.",
    inputSchema: { type: "object", properties: { workspace: text("Workspace name or ID.") }, required: ["workspace"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: (db, { workspace }) => {
      const detail = workspaceDetail(db, workspace);
      const group = detail.groups.find((item) => item.id === detail.matrix?.group.id);
      return {
        name: detail.workspace.name, id: detail.workspace.id,
        context: { title: detail.workspace.contextTitle, content: detail.workspace.contextContent },
        group: group ? { name: group.name, questions: group.questions.map(({ key, text: question, direction }) => ({ key, text: question, direction })) } : null,
        rankingMode: detail.workspace.rankingMode,
        drafts: (detail.matrix?.rows || detail.documents).map((row) => ({ version: row.version, id: row.id, title: row.title, changeSummary: row.changeSummary, parentId: row.parentDocumentId, isOriginal: row.isOriginal, isBest: row.isBest ?? false, runs: row.runs ?? 0, overallScore: row.overallScore ?? null, scores: row.scores ?? null })),
      };
    },
  },
  {
    name: "get_document",
    title: "Get draft",
    description: "Read one draft's full text and its evaluation history. Reference a draft by ID, title, or version such as \"#3\".",
    inputSchema: { type: "object", properties: { workspace: text("Workspace name or ID."), document: text("Draft ID, title, or version like \"#3\".") }, required: ["workspace", "document"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: (db, { workspace, document }) => {
      const detail = documentDetail(db, workspace, document);
      return { id: detail.id, version: detail.version, title: detail.title, changeSummary: detail.changeSummary, parentId: detail.parentDocumentId, isOriginal: detail.isOriginal, content: detail.content, runs: detail.runs.slice(0, 5).map((run) => ({ status: run.status, overallScore: run.overallScore, stale: run.stale, createdAt: run.createdAt, scores: run.scores.map(({ key, score, direction }) => ({ key, score, direction })) })) };
    },
  },
  {
    name: "score_document",
    title: "Save and score a draft",
    description: "Save a new draft (pass content) or pick an existing one (pass document), score it with Jev, and get feedback: overall score, rank, change vs the parent draft and the current best, per-question scores, and the three weakest questions. Positive deltas are always better. Costs one Jev call per run.",
    inputSchema: {
      type: "object",
      properties: {
        workspace: text("Workspace name or ID."),
        content: text("Full text of a new draft in Markdown or plain text. Omit to re-score an existing draft."),
        document: text("Existing draft ID, title, or version like \"#3\". Used when content is omitted."),
        title: text("Short title for a new draft, such as \"Quantified outcomes\"."),
        summary: text("One line describing what changed from the parent."),
        parent: text("The draft this revision is based on: ID, title, or version like \"#3\"."),
        runs: { type: "integer", minimum: 1, maximum: 5, default: 1, description: "Scoring runs. Keep 1; use 3 only to separate two close top drafts." },
        note: text("Optional note stored with the run."),
      },
      required: ["workspace"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    run: async (db, input, { evaluate }) => {
      let reference = input.document;
      let saved = null;
      if (input.content) {
        saved = addDocument(db, input.workspace, { content: input.content, title: input.title || "Untitled draft", changeSummary: input.summary || "", parentDocument: input.parent || null, metadata: { source: "mcp" } });
        reference = saved.id;
      }
      if (!reference) throw new Error("Pass content for a new draft or document for an existing one.");
      const feedback = await scoreDocument(db, input.workspace, reference, { runs: input.runs ?? 1, note: input.note || "", source: "mcp", ...(evaluate ? { evaluate } : {}) });
      return saved?.deduplicated ? { ...feedback, note: `This text matches existing draft #${saved.version}; it was scored again instead of saved twice.` } : feedback;
    },
  },
  {
    name: "add_document",
    title: "Save a draft",
    description: "Save a draft without scoring it. The first draft in a workspace becomes the original, the baseline for every comparison.",
    inputSchema: {
      type: "object",
      properties: { workspace: text("Workspace name or ID."), content: text("Full text in Markdown or plain text."), title: text("Short title."), summary: text("One line describing what changed."), parent: text("Draft this is based on."), original: { type: "boolean", description: "Make this the original (baseline) draft." } },
      required: ["workspace", "content", "title"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (db, input) => {
      const document = addDocument(db, input.workspace, { content: input.content, title: input.title, changeSummary: input.summary || "", parentDocument: input.parent || null, original: Boolean(input.original), metadata: { source: "mcp" } });
      delete document.content;
      return document;
    },
  },
  {
    name: "rank_documents",
    title: "Rank drafts",
    description: "Rank every draft by overall score or by one question, with run counts, ranges, and change from the original.",
    inputSchema: { type: "object", properties: { workspace: text("Workspace name or ID."), question: text("Optional question key to rank by one question."), mode: { type: "string", enum: ["max", "median"], description: "max uses each draft's best run; median uses the middle run." } }, required: ["workspace"], additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: (db, { workspace, question, mode }) => {
      const result = ranking(db, workspace, { question, mode });
      return { group: result.group.name, question: result.question?.key || null, mode: result.mode, drafts: result.items.map((item) => ({ rank: item.rank, version: item.version, title: item.title, score: item.rankScore, median: item.median, runs: item.runs, spread: item.spread, changeFromOriginal: item.delta, isBest: item.isBest, isOriginal: item.isOriginal })) };
    },
  },
  {
    name: "list_groups",
    title: "List evaluation groups",
    description: "List evaluation groups (reusable question sets) and the starter templates available for new ones.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: true },
    run: (db) => ({
      groups: listGroups(db).map((group) => ({ name: group.name, id: group.id, description: group.description, locked: group.locked, questions: group.questions.map(({ key, text: question, direction }) => ({ key, text: question, direction })) })),
      templates: TEMPLATES.map(({ id, name, description, contextTitle }) => ({ id, name, description, contextTitle })),
    }),
  },
  {
    name: "create_group",
    title: "Create evaluation group",
    description: "Create an evaluation group from a template ID or from your own questions. Phrase each question as a criterion; mark ones where a lower score is better with direction \"lower\".",
    inputSchema: {
      type: "object",
      properties: {
        name: text("Group name. Defaults to the template's name."),
        template: text("Template ID from list_groups, such as \"resume\"."),
        description: text("Optional description."),
        questions: { type: "array", items: { type: "object", properties: { text: text("The criterion."), key: text("Optional stable key."), direction: { type: "string", enum: ["higher", "lower"] } }, required: ["text"], additionalProperties: false } },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (db, input) => createGroup(db, { name: input.name, template: input.template, description: input.description, questions: input.questions }),
  },
  {
    name: "create_workspace",
    title: "Create workspace",
    description: "Create a workspace around one context (job posting, prompt, brief) with an evaluation group.",
    inputSchema: {
      type: "object",
      properties: { name: text("Workspace name."), context: text("The full context text."), context_title: text("What the context is, such as \"Job posting\"."), group: text("Existing evaluation group name or ID."), template: text("Template ID to create a new group from, when group is omitted.") },
      required: ["name", "context"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, destructiveHint: false },
    run: (db, input) => createWorkspace(db, { name: input.name, contextContent: input.context, contextTitle: input.context_title, primaryGroup: input.group, template: input.template }),
  },
];

const publicTool = ({ run, ...tool }) => tool;

export function createMcpHandler(db, { version = null, evaluate = null } = {}) {
  return async function handle(message) {
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      const id = message && typeof message === "object" && ["string", "number"].includes(typeof message.id) ? message.id : null;
      return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid request" } };
    }
    const reply = (result) => message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, result };
    const failure = (code, text) => message.id === undefined ? null : { jsonrpc: "2.0", id: message.id, error: { code, message: text } };
    switch (message.method) {
      case "initialize": {
        const requested = message.params?.protocolVersion;
        return reply({
          protocolVersion: PROTOCOL_VERSIONS.includes(requested) ? requested : PROTOCOL_VERSIONS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "jev-score", title: "Jev Score", version: version || "0.0.0" },
          instructions: INSTRUCTIONS,
        });
      }
      case "ping": return reply({});
      case "tools/list": return reply({ tools: TOOLS.map(publicTool) });
      case "tools/call": {
        const tool = TOOLS.find((item) => item.name === message.params?.name);
        if (!tool) return failure(-32602, `Unknown tool: ${message.params?.name}`);
        try {
          const result = await tool.run(db, message.params?.arguments || {}, { evaluate });
          return reply({ content: [{ type: "text", text: JSON.stringify(result, null, 2) }] });
        } catch (error) {
          return reply({ content: [{ type: "text", text: `Error: ${error?.message || error}` }], isError: true });
        }
      }
      default:
        // Notifications never get a reply; a request always does.
        return failure(-32601, `Method not found: ${message.method}`);
    }
  };
}

export function runMcpServer({ db = openDatabase(), version = null, evaluate = null, input = process.stdin, output = process.stdout } = {}) {
  const handle = createMcpHandler(db, { version, evaluate });
  const lines = createInterface({ input, crlfDelay: Infinity });
  const write = (message) => { if (message) output.write(`${JSON.stringify(message)}\n`); };
  // Requests run concurrently so a ping is answered during a long scoring
  // call; JSON-RPC matches replies to requests by id, not by order.
  const pending = new Set();
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { write({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
    const task = (Array.isArray(message)
      ? (message.length ? Promise.all(message.map(handle)).then((replies) => { const answered = replies.filter(Boolean); if (answered.length) write(answered); }) : Promise.resolve(write({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid request" } })))
      : handle(message).then(write))
      .catch((error) => write({ jsonrpc: "2.0", id: message?.id ?? null, error: { code: -32603, message: error?.message || String(error) } }))
      .finally(() => pending.delete(task));
    pending.add(task);
  });
  return new Promise((resolve) => lines.once("close", async () => { await Promise.all(pending); db.close(); resolve(); }));
}
