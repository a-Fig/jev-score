const RUBRIC = [
  "Does not satisfy the criterion",
  "Satisfies the criterion weakly",
  "Satisfies the criterion adequately",
  "Satisfies the criterion strongly",
  "Satisfies the criterion exceptionally well",
];

// Rate limits, timeouts, and provider hiccups are retried; bad keys, missing
// credits, and malformed requests fail immediately with a readable message.
const RETRYABLE = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const round = (value) => Math.round(value * 10) / 10;
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const DEFAULT_MODEL = "typesafe/jev-1.13";

function providerMessage(status, body) {
  const detail = body.slice(0, 240);
  if (status === 401) return `OpenRouter rejected the API key (401). Check OPENROUTER_API_KEY or run jev-score doctor. ${detail}`.trim();
  if (status === 402) return `OpenRouter reports insufficient credits (402). Add credits or raise the key's limit on openrouter.ai. ${detail}`.trim();
  if (status === 404) return `OpenRouter could not find the Jev endpoint or model (404). Check OPENROUTER_JEV_MODEL. ${detail}`.trim();
  return `OpenRouter Jev request failed (${status}): ${detail}`;
}

function retryDelay(attempt, retryAfter = null) {
  if (retryAfter != null && String(retryAfter).trim() !== "") {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) return Math.min(Math.max(0, date - Date.now()), 30_000);
  }
  return Math.min(1000 * 2 ** attempt, 8000) * (0.75 + Math.random() * 0.5);
}

export async function evaluateWithJev({
  document,
  context,
  questions,
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.OPENROUTER_JEV_MODEL || DEFAULT_MODEL,
  endpoint = process.env.OPENROUTER_DECISIONS_ENDPOINT || "https://openrouter.ai/api/alpha/decisions",
  fetchImpl = globalThis.fetch,
  retries = Number(process.env.JEV_SCORE_RETRIES ?? 3),
  timeoutMs = Number(process.env.JEV_SCORE_TIMEOUT_MS || 45_000),
  sleep = wait,
}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required to run an evaluation. Put it in .env.local or your shell, then run jev-score doctor.");
  const requestQuestions = Object.fromEntries(questions.map((question) => [
    question.key,
    {
      type: "score",
      instructions: `How well does the document satisfy this criterion, considering the context when relevant: ${question.text}`,
      criteria: RUBRIC,
    },
  ]));
  const body = JSON.stringify({
    model,
    state: { document, context: context || "No additional context supplied." },
    questions: requestQuestions,
  });
  let payload;
  for (let attempt = 0; ; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "X-Title": "Jev Score",
        },
        signal: AbortSignal.timeout(timeoutMs),
        body,
      });
    } catch (error) {
      if (attempt < retries) { await sleep(retryDelay(attempt)); continue; }
      const reason = error?.name === "TimeoutError" ? `timed out after ${timeoutMs}ms` : error?.message || String(error);
      throw new Error(`OpenRouter Jev request failed after ${attempt + 1} attempt${attempt ? "s" : ""}: ${reason}`);
    }
    if (response.ok) { payload = await response.json(); break; }
    const text = await response.text();
    if (RETRYABLE.has(response.status) && attempt < retries) { await sleep(retryDelay(attempt, response.headers.get("retry-after"))); continue; }
    throw new Error(providerMessage(response.status, text));
  }
  const scores = questions.map((question) => {
    const answer = payload.answers?.[question.key];
    // The call was billed even when an answer is unusable, so keep its usage.
    if (!Number.isFinite(answer?.score) || answer.score < 0 || answer.score > RUBRIC.length - 1) throw Object.assign(new Error(`Jev returned an invalid score for ${question.key}.`), { usage: payload.usage || null, model: payload.model || model, provider: payload.provider || "TypeSafe" });
    return {
      questionId: question.id,
      key: question.key,
      text: question.text,
      rawScore: answer.score,
      score: round((answer.score / (RUBRIC.length - 1)) * 100),
      confidence: answer.confidence ?? null,
      probabilities: answer.probabilities ?? null,
    };
  });
  return {
    model: payload.model || model,
    provider: payload.provider || "TypeSafe",
    usage: payload.usage || null,
    scores,
  };
}

// Checks the key without spending credits. Returns null when OpenRouter's key
// endpoint is unavailable so callers can report "unknown" instead of failing.
export async function checkOpenRouterKey({ apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = globalThis.fetch, timeoutMs = 8000 } = {}) {
  if (!apiKey) return { ok: false, reason: "OPENROUTER_API_KEY is not set." };
  let response;
  try {
    response = await fetchImpl("https://openrouter.ai/api/v1/key", { headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    return { ok: false, reason: `Could not reach OpenRouter: ${error?.message || error}` };
  }
  if (response.status === 401 || response.status === 403) return { ok: false, reason: `OpenRouter rejected the key (${response.status}).` };
  if (!response.ok) return { ok: null, reason: `OpenRouter key check returned ${response.status}.` };
  const data = (await response.json().catch(() => ({})))?.data || {};
  return { ok: true, label: data.label ?? null, usage: data.usage ?? null, limit: data.limit ?? null, limitRemaining: data.limit_remaining ?? null };
}
