// Formatting helpers shared by the browser app and the server-rendered report.
// Nothing here touches the DOM.

export function escapeHtml(value = "") {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

export const score = (value) => value == null || !Number.isFinite(Number(value)) ? "—" : Number(value).toFixed(1);
export const signed = (value) => value == null ? "—" : `${value > 0 ? "+" : value < 0 ? "−" : "±"}${Math.abs(Number(value)).toFixed(1)}`;
export const count = (value) => new Intl.NumberFormat("en-US").format(Number(value || 0));
export const plural = (value, word, pluralWord = `${word}s`) => `${count(value)} ${Number(value) === 1 ? word : pluralWord}`;

export function money(value) {
  if (value == null) return "—";
  if (value === 0) return "$0.00";
  const digits = value >= 1 ? 2 : value >= 0.01 ? 4 : 6;
  return new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

export function date(value) {
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }).format(new Date(value));
}

export function longDate(value) {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(new Date(value));
}

export function ago(value, now = Date.now()) {
  if (!value) return "";
  const seconds = Math.round((now - new Date(value).getTime()) / 1000);
  if (seconds < 45) return "just now";
  const units = [[60, "minute"], [3600, "hour"], [86400, "day"], [604800, "week"]];
  for (let index = units.length - 1; index >= 0; index -= 1) {
    const [size, unit] = units[index];
    if (seconds >= size) {
      const amount = Math.round(seconds / size);
      if (unit === "week" && amount > 8) return date(value);
      return `${amount} ${unit}${amount === 1 ? "" : "s"} ago`;
    }
  }
  return date(value);
}

export const versionLabel = (document) => `#${document.version}`;
export const versionTitle = (document) => `${versionLabel(document)} · ${document.title}`;
export const directionLabel = (direction) => direction === "lower" ? "lower is better" : "higher is better";
export const wordCount = (text) => (String(text).match(/\S+/g) || []).length;
