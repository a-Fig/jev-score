const RUBRIC = [
  "Does not satisfy the criterion",
  "Satisfies the criterion weakly",
  "Satisfies the criterion adequately",
  "Satisfies the criterion strongly",
  "Satisfies the criterion exceptionally well",
];

const round = (value) => Math.round(value * 10) / 10;

export async function evaluateWithJev({
  document,
  context,
  questions,
  apiKey = process.env.OPENROUTER_API_KEY,
  model = process.env.OPENROUTER_JEV_MODEL || "typesafe/jev-1.13",
  endpoint = process.env.OPENROUTER_DECISIONS_ENDPOINT || "https://openrouter.ai/api/alpha/decisions",
  fetchImpl = globalThis.fetch,
}) {
  if (!apiKey) throw new Error("OPENROUTER_API_KEY is required to run an evaluation.");
  const requestQuestions = Object.fromEntries(questions.map((question) => [
    question.key,
    {
      type: "score",
      instructions: `How well does the document satisfy this criterion, considering the context when relevant: ${question.text}`,
      criteria: RUBRIC,
    },
  ]));
  const response = await fetchImpl(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "X-Title": "Jev Score",
    },
    signal: AbortSignal.timeout(30_000),
    body: JSON.stringify({
      model,
      state: { document, context: context || "No additional context supplied." },
      questions: requestQuestions,
    }),
  });
  if (!response.ok) throw new Error(`OpenRouter Jev request failed (${response.status}): ${(await response.text()).slice(0, 240)}`);
  const payload = await response.json();
  const scores = questions.map((question) => {
    const answer = payload.answers?.[question.key];
    if (!Number.isFinite(answer?.score) || answer.score < 0 || answer.score > RUBRIC.length - 1) throw new Error(`Jev returned an invalid score for ${question.key}.`);
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
