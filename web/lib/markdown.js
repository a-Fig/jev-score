import { escapeHtml } from "./format.js";

// A small, safe Markdown renderer for drafts: headings, paragraphs, nested
// lists, task lists, quotes, code, tables, rules, links, images, and emphasis.
// Every block carries data-line (its first source line) so the editor can
// keep the source and the preview scrolled to the same place. Raw HTML in a
// draft is always shown as text.

function safeUrl(value, image = false) {
  const decoded = value.replaceAll("&amp;", "&").replaceAll("&#39;", "'").replaceAll("&quot;", '"');
  if (/^\s*(javascript|data|vbscript):/i.test(decoded)) return null;
  try {
    const url = new URL(decoded, "http://localhost/");
    if (["http:", "https:"].includes(url.protocol) || (!image && url.protocol === "mailto:")) return value;
  } catch {}
  return null;
}

export function markdownInline(value) {
  const tokens = [];
  const stash = (html) => { const token = `\u0000${tokens.length}\u0000`; tokens.push(html); return token; };
  let output = String(value).replace(/`([^`\n]+)`/g, (_, code) => stash(`<code>${escapeHtml(code)}</code>`));
  output = escapeHtml(output);
  output = output.replace(/!\[([^\]]*)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, alt, url) => {
    const safe = safeUrl(url, true);
    return safe ? stash(`<img src="${safe}" alt="${alt}" loading="lazy">`) : alt;
  });
  output = output.replace(/\[([^\]]+)\]\(([^\s)]+)(?:\s+&quot;[^&]*&quot;)?\)/g, (match, label, url) => {
    const safe = safeUrl(url);
    return safe ? stash(`<a href="${safe}" target="_blank" rel="noreferrer noopener">${label}</a>`) : label;
  });
  output = output.replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;:!?'"])/g, (match, lead, url) => `${lead}${stash(`<a href="${url}" target="_blank" rel="noreferrer noopener">${url}</a>`)}`);
  output = output.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>").replace(/__([^_]+)__/g, "<strong>$1</strong>");
  output = output.replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>").replace(/(^|[^_\w])_([^_\n]+)_(?!\w)/g, "$1<em>$2</em>");
  output = output.replace(/~~([^~]+)~~/g, "<del>$1</del>");
  // Stashed pieces can contain other stashed pieces, such as code in a link label.
  for (let depth = 0; depth < 4 && output.includes("\u0000"); depth += 1) output = output.replace(/\u0000(\d+)\u0000/g, (_, index) => tokens[Number(index)]);
  return output;
}

const tableRow = (line) => line.trim().replace(/^\||\|$/g, "").split("|").map((cell) => cell.trim());
const isTableDivider = (line) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);

export function markdownToHtml(markdown) {
  const lines = String(markdown ?? "").replace(/\r\n?/g, "\n").split("\n");
  const output = [];
  let paragraph = null;
  let quote = null;
  let lists = [];
  const flushParagraph = () => { if (paragraph) output.push(`<p data-line="${paragraph.line}">${markdownInline(paragraph.text.join(" "))}</p>`); paragraph = null; };
  const flushQuote = () => { if (quote) output.push(`<blockquote data-line="${quote.line}">${markdownToHtml(quote.text.join("\n")).replace(/ data-line="\d+"/g, "")}</blockquote>`); quote = null; };
  const closeLists = (depth = 0) => { while (lists.length > depth) { const list = lists.pop(); output.push(`</li></${list.type}>`); } };
  const flush = () => { flushParagraph(); flushQuote(); closeLists(); };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const number = index + 1;
    const fence = line.match(/^\s*(```|~~~)\s*([^\s`]*)/);
    if (fence) {
      flush();
      const code = [];
      let end = index + 1;
      while (end < lines.length && !lines[end].trim().startsWith(fence[1])) code.push(lines[end++]);
      output.push(`<pre data-line="${number}"><code${fence[2] ? ` class="language-${escapeHtml(fence[2])}"` : ""}>${escapeHtml(code.join("\n"))}</code></pre>`);
      index = end;
      continue;
    }
    if (!line.trim()) { flushParagraph(); flushQuote(); if (!/^\s*([-*+]|\d+[.)])\s+/.test(lines[index + 1] || "")) closeLists(); continue; }
    const quoteLine = line.match(/^\s*>\s?(.*)$/);
    if (quoteLine) { flushParagraph(); closeLists(); quote ||= { line: number, text: [] }; quote.text.push(quoteLine[1]); continue; }
    flushQuote();
    // A closing run of # needs a space before it, so "C#" survives.
    const heading = line.match(/^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/);
    if (heading) { flush(); output.push(`<h${heading[1].length} data-line="${number}">${markdownInline(heading[2])}</h${heading[1].length}>`); continue; }
    if (/^\s*(?:---+|___+|\*\*\*+)\s*$/.test(line)) { flush(); output.push(`<hr data-line="${number}">`); continue; }
    const divider = lines[index + 1] || "";
    if (line.includes("|") && divider.includes("|") && isTableDivider(divider) && tableRow(divider).length === tableRow(line).length) {
      flush();
      const head = tableRow(line);
      const align = tableRow(lines[index + 1]).map((cell) => cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "");
      const body = [];
      let end = index + 2;
      while (end < lines.length && lines[end].includes("|") && lines[end].trim()) body.push(tableRow(lines[end++]));
      const cell = (tag, value, column) => `<${tag}${align[column] ? ` style="text-align:${align[column]}"` : ""}>${markdownInline(value)}</${tag}>`;
      output.push(`<div class="table-wrap" data-line="${number}"><table><thead><tr>${head.map((value, column) => cell("th", value, column)).join("")}</tr></thead><tbody>${body.map((row) => `<tr>${head.map((_, column) => cell("td", row[column] ?? "", column)).join("")}</tr>`).join("")}</tbody></table></div>`);
      index = end - 1;
      continue;
    }
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    if (item) {
      flushParagraph();
      const depth = Math.min(Math.floor(item[1].replace(/\t/g, "    ").length / 2), 6) + 1;
      const type = /\d/.test(item[2]) ? "ol" : "ul";
      if (lists.length > depth) closeLists(depth);
      if (lists.length === depth && lists[depth - 1].type !== type) closeLists(depth - 1);
      if (lists.length === depth) output.push("</li>");
      while (lists.length < depth) {
        const start = type === "ol" && lists.length === depth - 1 ? Number.parseInt(item[2], 10) : 1;
        output.push(`<${type} data-line="${number}"${start > 1 ? ` start="${start}"` : ""}>`);
        lists.push({ type });
      }
      const task = item[3].match(/^\[([ xX])\]\s+(.*)$/);
      output.push(task ? `<li class="task" data-line="${number}"><span class="check ${task[1] === " " ? "" : "done"}" aria-hidden="true"></span>${markdownInline(task[2])}` : `<li data-line="${number}">${markdownInline(item[3])}`);
      continue;
    }
    if (lists.length && /^\s{2,}\S/.test(line)) { output.push(` ${markdownInline(line.trim())}`); continue; }
    closeLists();
    paragraph ||= { line: number, text: [] };
    paragraph.text.push(line.trim());
  }
  flush();
  return output.join("\n");
}
