// Human-readable CLI output. Agents get JSON (stdout is not a terminal, or
// --json); people at a terminal get aligned tables and color.

const codes = { bold: [1, 22], dim: [2, 22], red: [31, 39], green: [32, 39], yellow: [33, 39], blue: [34, 39], gray: [90, 39] };

export function palette(enabled) {
  return Object.fromEntries(Object.entries(codes).map(([name, [open, close]]) => [name, (text) => enabled ? `\u001b[${open}m${text}\u001b[${close}m` : String(text)]));
}

const visible = (text) => String(text).replace(/\u001b\[\d+m/g, "");

export function table(rows, columns, { width = process.stdout.columns || 100 } = {}) {
  if (!rows.length) return "";
  const cells = rows.map((row) => columns.map((column) => String(column.value(row) ?? "")));
  const widths = columns.map((column, index) => Math.max(visible(column.label).length, ...cells.map((line) => visible(line[index]).length)));
  // Shrink the one flexible column (usually a title) to fit the terminal.
  const flex = columns.findIndex((column) => column.flex);
  const total = widths.reduce((sum, value) => sum + value, 0) + (columns.length - 1) * 2;
  if (flex >= 0 && total > width) widths[flex] = Math.max(12, widths[flex] - (total - width));
  const fit = (text, index) => {
    const plain = visible(text);
    if (plain.length <= widths[index]) return columns[index].align === "right" ? `${" ".repeat(widths[index] - plain.length)}${text}` : `${text}${" ".repeat(widths[index] - plain.length)}`;
    return `${plain.slice(0, widths[index] - 1)}…`;
  };
  const header = columns.map((column, index) => fit(column.label, index)).join("  ").trimEnd();
  return [header, ...cells.map((line) => line.map(fit).join("  ").trimEnd())].join("\n");
}

export const plural = (value, word) => `${value} ${value === 1 ? word : `${word}s`}`;
export const one = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(1);
export const delta = (value, color) => {
  if (value == null) return "—";
  const text = `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(value).toFixed(1)}`;
  return value > 0 ? color.green(text) : value < 0 ? color.red(text) : text;
};
