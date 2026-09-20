import { Worker } from "node:worker_threads";

const round = (value) => Math.round(value * 10) / 10;

export async function aggregateScores(group, scores, timeoutMs = 3_000) {
  if (!scores.length || scores.some((item) => !Number.isFinite(item.score) || item.score < 0 || item.score > 100)) throw new Error("Question scores must be finite numbers from 0 to 100.");
  if (group.scorerKind === "mean-v1") {
    return round(scores.reduce((sum, item) => sum + item.score, 0) / scores.length);
  }
  if (group.scorerKind !== "javascript-v1" || !group.scorerSource) throw new Error(`Unsupported scorer: ${group.scorerKind}`);
  const scoreMap = Object.fromEntries(scores.map((item) => [item.key, item.score]));
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(new URL("./scorer-worker.mjs", import.meta.url), {
      workerData: { source: group.scorerSource, scores: scoreMap },
    });
    const timeout = setTimeout(() => {
      worker.terminate();
      reject(new Error(`Custom scorer exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    worker.once("message", (message) => {
      clearTimeout(timeout);
      worker.terminate();
      if (message.error) reject(new Error(message.error));
      else resolve(message.result);
    });
    worker.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
  if (!Number.isFinite(result) || result < 0 || result > 100) {
    throw new Error("Custom scorer must return a finite number from 0 to 100.");
  }
  return round(result);
}
