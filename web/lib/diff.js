import { escapeHtml } from "./format.js";

// Line diff with a longest-common-subsequence table, falling back to a
// positional comparison when the table would be too large to build quickly.
export function diffLines(leftText, rightText) {
  const left = String(leftText ?? "").replace(/\r\n?/g, "\n").split("\n");
  const right = String(rightText ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (left.length * right.length > 4_000_000) {
    return Array.from({ length: Math.max(left.length, right.length) }, (_, index) => ({
      left: left[index] ?? null, right: right[index] ?? null,
      leftNumber: index < left.length ? index + 1 : null, rightNumber: index < right.length ? index + 1 : null,
      leftType: index >= left.length ? "empty" : left[index] === right[index] ? "same" : "removed",
      rightType: index >= right.length ? "empty" : left[index] === right[index] ? "same" : "added",
    }));
  }
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint32Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const rows = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { rows.push({ left: left[i], right: right[j], leftNumber: i + 1, rightNumber: j + 1, leftType: "same", rightType: "same" }); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) { rows.push({ left: left[i], right: null, leftNumber: i + 1, rightNumber: null, leftType: "removed", rightType: "empty" }); i += 1; }
    else { rows.push({ left: null, right: right[j], leftNumber: null, rightNumber: j + 1, leftType: "empty", rightType: "added" }); j += 1; }
  }
  while (i < left.length) { rows.push({ left: left[i], right: null, leftNumber: i + 1, rightNumber: null, leftType: "removed", rightType: "empty" }); i += 1; }
  while (j < right.length) { rows.push({ left: null, right: right[j], leftNumber: null, rightNumber: j + 1, leftType: "empty", rightType: "added" }); j += 1; }
  return rows;
}

// Pairs each run of removals with the following run of additions so a
// rewritten line shows up as one changed row instead of two.
export function alignDiffChanges(rows) {
  const aligned = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].leftType === "same") { aligned.push(rows[index]); index += 1; continue; }
    const removed = [], added = [];
    while (index < rows.length && rows[index].leftType !== "same") {
      if (rows[index].leftType === "removed") removed.push(rows[index]);
      if (rows[index].rightType === "added") added.push(rows[index]);
      index += 1;
    }
    for (let offset = 0; offset < Math.max(removed.length, added.length); offset += 1) {
      aligned.push({
        left: removed[offset]?.left ?? null, right: added[offset]?.right ?? null,
        leftNumber: removed[offset]?.leftNumber ?? null, rightNumber: added[offset]?.rightNumber ?? null,
        leftType: removed[offset] ? "removed" : "empty", rightType: added[offset] ? "added" : "empty",
      });
    }
  }
  return aligned;
}

export function collapseDiffContext(rows, context = 3) {
  const compact = [];
  for (let index = 0; index < rows.length;) {
    if (rows[index].leftType !== "same") { compact.push(rows[index]); index += 1; continue; }
    let end = index;
    while (end < rows.length && rows[end].leftType === "same") end += 1;
    const run = rows.slice(index, end);
    if (run.length > context * 2 + 3) compact.push(...run.slice(0, context), { collapsed: run.length - context * 2, from: index + context }, ...run.slice(-context));
    else compact.push(...run);
    index = end;
  }
  return compact;
}

const tokenize = (value) => String(value ?? "").match(/\s+|[\p{L}\p{N}_'’-]+|[^\s\p{L}\p{N}_]/gu) || [];

// Word-level diff of two lines as [{ type: "same" | "removed" | "added", text }].
export function wordDiff(leftText, rightText) {
  const left = tokenize(leftText), right = tokenize(rightText);
  if (left.length * right.length > 250_000) return [{ type: "removed", text: String(leftText ?? "") }, { type: "added", text: String(rightText ?? "") }];
  const lengths = Array.from({ length: left.length + 1 }, () => new Uint16Array(right.length + 1));
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) lengths[i][j] = left[i] === right[j] ? lengths[i + 1][j + 1] + 1 : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
  }
  const parts = [];
  const push = (type, text) => { const last = parts.at(-1); if (last?.type === type) last.text += text; else parts.push({ type, text }); };
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { push("same", left[i]); i += 1; j += 1; }
    else if (lengths[i + 1][j] >= lengths[i][j + 1]) push("removed", left[i++]);
    else push("added", right[j++]);
  }
  while (i < left.length) push("removed", left[i++]);
  while (j < right.length) push("added", right[j++]);
  return parts;
}

// Side-by-side cells: the left keeps removals, the right keeps additions.
export function inlineDiff(leftText, rightText) {
  const parts = wordDiff(leftText, rightText);
  const side = (keep) => parts.filter((part) => part.type === "same" || part.type === keep).map((part) => part.type === "same" ? escapeHtml(part.text) : `<mark>${escapeHtml(part.text)}</mark>`).join("");
  return [side("removed"), side("added")];
}

// Tracked-changes markup for a single column: deletions struck through and
// insertions underlined, the way an editor marks a manuscript.
export function trackedChanges(leftText, rightText) {
  return wordDiff(leftText, rightText).map((part) => part.type === "same" ? escapeHtml(part.text) : part.type === "removed" ? `<del>${escapeHtml(part.text)}</del>` : `<ins>${escapeHtml(part.text)}</ins>`).join("");
}

export function diffStats(leftText, rightText) {
  const rows = diffLines(leftText, rightText);
  return { added: rows.filter((row) => row.rightType === "added").length, removed: rows.filter((row) => row.leftType === "removed").length };
}
