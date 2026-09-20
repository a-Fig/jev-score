import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, platform } from "node:os";
import { join, resolve } from "node:path";

export function loadEnv(cwd = process.cwd()) {
  for (const name of [".env", ".env.local"]) {
    const path = resolve(cwd, name);
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
      if (!match || !match[2]) continue;
      process.env[match[1]] ??= match[2].replace(/^(['"])(.*)\1$/, "$2");
    }
  }
}

export function dataDirectory(env = process.env) {
  if (env.JEV_SCORE_DATA_DIR) return resolve(env.JEV_SCORE_DATA_DIR);
  if (platform() === "win32") return join(env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "jev-score");
  if (platform() === "darwin") return join(homedir(), "Library", "Application Support", "jev-score");
  return join(env.XDG_DATA_HOME || join(homedir(), ".local", "share"), "jev-score");
}

export function databasePath(env = process.env) {
  return env.JEV_SCORE_DB ? resolve(env.JEV_SCORE_DB) : join(dataDirectory(env), "jev-score.db");
}

export function databaseIdentity(env = process.env) {
  return createHash("sha256").update(databasePath(env)).digest("hex").slice(0, 16);
}
