/**
 * Tiny built-in dotenv loader — zero dependency.
 *
 * Why inline: the MCP bootstrap needs env vars BEFORE any module reads them
 * (e.g., GEMINI_API_KEY, SYNTHI_VISION_BACKEND). Adding `dotenv` as a
 * dependency would be the 273rd transitive package; a 25-line parser
 * covers the small, stable subset we need.
 *
 * Search order (first match wins, values in process.env are never overwritten):
 *   1. Path passed via `--env-file=<path>` CLI arg (mirrors Node 20.12+ flag).
 *   2. `SYNTHI_ENV_FILE` env var.
 *   3. `<packageRoot>/.env` (walks up from this file to find package.json).
 *
 * Format: `KEY=value` per line. `#` starts a line comment. Values may be
 * wrapped in single or double quotes (stripped). Lines without `=` or
 * starting with `#` are ignored. Blank lines are fine.
 *
 * We deliberately do NOT override already-set env vars — the host's MCP
 * registration (e.g. `claude mcp add -e ...`) still wins over a local
 * `.env` so production deployments don't get silently rewritten.
 */

import { readFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function packageRoot(): string {
  // src/util/env.ts → up to src → up to package root
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..");
}

function findCliEnvFile(argv: readonly string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--env-file") {
      const next = argv[i + 1];
      if (next && !next.startsWith("--")) return next;
    } else if (a?.startsWith("--env-file=")) {
      return a.slice("--env-file=".length);
    }
  }
  return undefined;
}

export function parseDotEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let val = line.slice(eq + 1).trim();
    // Strip inline comments only when unquoted.
    const quoted =
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"));
    if (quoted) val = val.slice(1, -1);
    else {
      const hash = val.indexOf(" #");
      if (hash >= 0) val = val.slice(0, hash).trim();
    }
    out[key] = val;
  }
  return out;
}

export interface LoadEnvResult {
  path?: string;
  loaded: number;
  skipped_existing: number;
}

/**
 * Load env vars from a dotenv file, without overriding already-set vars.
 * Returns a small summary so callers can log what happened.
 */
export function loadEnvFile(
  argv: readonly string[] = process.argv.slice(2),
  env: Record<string, string | undefined> = process.env as Record<string, string | undefined>
): LoadEnvResult {
  const candidates: string[] = [];
  const fromCli = findCliEnvFile(argv);
  if (fromCli) candidates.push(fromCli);
  const fromEnv = env["SYNTHI_ENV_FILE"];
  if (fromEnv) candidates.push(fromEnv);
  candidates.push(path.join(packageRoot(), ".env"));

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    const text = readFileSync(p, "utf8");
    const parsed = parseDotEnv(text);
    let loaded = 0;
    let skipped = 0;
    for (const [k, v] of Object.entries(parsed)) {
      if (env[k] !== undefined && env[k] !== "") { skipped++; continue; }
      (env as Record<string, string>)[k] = v;
      loaded++;
    }
    return { path: p, loaded, skipped_existing: skipped };
  }
  return { loaded: 0, skipped_existing: 0 };
}
