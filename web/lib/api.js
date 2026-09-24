export async function api(path, { method = "GET", body, signal } = {}) {
  const mutating = method !== "GET" && method !== "DELETE";
  const response = await fetch(path, {
    method, signal,
    headers: mutating ? { "Content-Type": "application/json" } : {},
    body: mutating ? JSON.stringify(body ?? {}) : undefined,
  });
  const text = await response.text();
  let payload = null;
  try { payload = text ? JSON.parse(text) : null; } catch { payload = { error: text }; }
  if (!response.ok) throw Object.assign(new Error(payload?.error || `Request failed (${response.status})`), { status: response.status, payload });
  return payload;
}

export const ws = (id) => `/api/workspaces/${encodeURIComponent(id)}`;
export const doc = (workspaceId, documentId) => `${ws(workspaceId)}/documents/${encodeURIComponent(documentId)}`;

// Server-sent events: "change" fires whenever anything writes to the database,
// including an agent running the CLI or MCP server in another process.
export function connectLive({ onChange, onStatus }) {
  let source = null;
  let retry = null;
  const open = () => {
    source = new EventSource("/api/events");
    source.addEventListener("ready", () => { onStatus(true); onChange({ reason: "reconnect" }); });
    source.addEventListener("change", (event) => { try { onChange(JSON.parse(event.data)); } catch { onChange({}); } });
    source.onerror = () => {
      onStatus(false);
      if (source.readyState === EventSource.CLOSED) { clearTimeout(retry); retry = setTimeout(open, 3000); }
    };
  };
  open();
  return () => { clearTimeout(retry); source?.close(); };
}
