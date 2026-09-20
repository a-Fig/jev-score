import { parentPort, workerData } from "node:worker_threads";

try {
  const encoded = Buffer.from(workerData.source, "utf8").toString("base64");
  const module = await import(`data:text/javascript;base64,${encoded}`);
  if (typeof module.default !== "function") throw new Error("Custom scorer must export a default function.");
  const result = module.default(Object.freeze({ ...workerData.scores }));
  if (result && typeof result.then === "function") throw new Error("Custom scorer must be synchronous.");
  parentPort.postMessage({ result });
} catch (error) {
  parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) });
}
