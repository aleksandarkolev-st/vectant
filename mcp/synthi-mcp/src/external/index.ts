import crypto from "node:crypto";
import { listTools, callTool, type McpToolConfig, type McpTool } from "@synthi/mcp-hub";
import { readExternalConfig, type ExternalConfig } from "./config.js";
import { jsonResponse, errorResponse, type ToolResponse } from "../tools/shared.js";

export interface ExternalToolDescriptor { name: string; description: string; inputSchema: unknown; }
export interface AliasEntry { connId: string; connName: string; toolName: string; config: McpToolConfig; }
export interface ExternalTools { descriptors: ExternalToolDescriptor[]; aliasMap: Record<string, AliasEntry>; }

interface AuditRow {
  alias?: string; connId?: string; serverName?: string; toolName?: string;
  outcome: "ok" | "error" | "blocked"; errorCode?: string;
  durationMs?: number; argsHash?: string; argsBytes?: number; resultBytes?: number | null;
}

const ALIAS_RE = /^ext_\d+$/;
const MAX_TOOLS_PER_CONN = Number(process.env["SYNTHI_MCP_MAX_TOOLS_PER_CONN"]) || 64;
const MAX_LISTTOOLS_CONCURRENCY = Number(process.env["SYNTHI_MCP_LISTTOOLS_CONCURRENCY"]) || 5;
const EXTCALL_WINDOW_MS = 60_000;

let extWindow = { count: 0, resetAt: 0 };
function extCallAllowed(now = Date.now()): boolean {
  const limit = Number(process.env["SYNTHI_MCP_EXTCALL_LIMIT"]) || 60;
  if (now >= extWindow.resetAt) extWindow = { count: 0, resetAt: now + EXTCALL_WINDOW_MS };
  if (extWindow.count >= limit) return false;
  extWindow.count += 1;
  return true;
}
/** Test-only: reset the per-process extcall window. */
export function __resetExtCall(): void { extWindow = { count: 0, resetAt: 0 }; }

export function isExternalToolName(name: string): boolean { return ALIAS_RE.test(name); }

function sha256Hex(s: string): string { return crypto.createHash("sha256").update(s).digest("hex"); }

async function fetchConfigs(cfg: ExternalConfig): Promise<McpToolConfig[]> {
  const url = new URL(`${cfg.apiUrl}/api/integrations/mcp/resolve`);
  if (cfg.workspaceSlug) url.searchParams.set("workspaceSlug", cfg.workspaceSlug);
  const res = await fetch(url, { headers: { authorization: `Bearer ${cfg.pat}` } });
  if (!res.ok) throw new Error(`resolve_failed_${res.status}`);
  const body = (await res.json()) as { configs?: McpToolConfig[] };
  return body.configs ?? [];
}

/** POST a redacted audit row. Never throws — audit failures must not break a tool call. */
export async function postAudit(env: NodeJS.ProcessEnv, row: AuditRow): Promise<void> {
  const cfg = readExternalConfig(env);
  if (!cfg) return;
  try {
    await fetch(`${cfg.apiUrl}/api/integrations/mcp/audit`, {
      method: "POST",
      headers: { authorization: `Bearer ${cfg.pat}`, "content-type": "application/json" },
      body: JSON.stringify({ ...row, ...(cfg.workspaceSlug ? { workspaceSlug: cfg.workspaceSlug } : {}) }),
    });
  } catch { /* swallow */ }
}

async function mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx] as T);
    }
  }
  const n = Math.min(limit, items.length);
  if (n <= 0) return results;
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

export async function resolveExternalTools(
  env: NodeJS.ProcessEnv = process.env,
  deps: {
    readExternalConfig: typeof readExternalConfig;
    listTools: typeof listTools;
    fetchConfigs: typeof fetchConfigs;
  } = { readExternalConfig, listTools, fetchConfigs },
): Promise<ExternalTools> {
  const cfg = deps.readExternalConfig(env);
  if (!cfg) return { descriptors: [], aliasMap: {} };

  let configs: McpToolConfig[];
  try {
    configs = await deps.fetchConfigs(cfg);
  } catch (e) {
    process.stderr.write(`synthi-mcp external: resolve failed: ${(e as Error).message}\n`);
    return { descriptors: [], aliasMap: {} };
  }

  const listed = await mapWithConcurrency(configs, MAX_LISTTOOLS_CONCURRENCY, async (config) => {
    try { return { config, res: await deps.listTools(config) }; }
    catch (e) { return { config, res: { ok: false as const, error: { code: "protocol_error", message: (e as Error).message } } }; }
  });

  const descriptors: ExternalToolDescriptor[] = [];
  const aliasMap: Record<string, AliasEntry> = {};
  let i = 0;
  for (const { config, res } of listed) {
    if (!res.ok) {
      process.stderr.write(`synthi-mcp external: listTools failed for "${config.name}": ${res.error.code}\n`);
      continue;
    }
    const allow = new Set(config.allowlist ?? []);
    let perConn = 0;
    for (const tool of (res.tools ?? []) as McpTool[]) {
      if (!allow.has(tool.name)) continue;
      if (perConn >= MAX_TOOLS_PER_CONN) break;
      const alias = `ext_${i++}`;
      perConn += 1;
      descriptors.push({
        name: alias,
        description: `[${config.name}] ${tool.description ?? tool.name}`,
        inputSchema: tool.inputSchema ?? { type: "object", properties: {} },
      });
      aliasMap[alias] = { connId: config.id, connName: config.name, toolName: tool.name, config };
    }
  }
  return { descriptors, aliasMap };
}

export async function callExternalTool(
  alias: string,
  args: Record<string, unknown> | undefined,
  aliasMap: Record<string, AliasEntry>,
  env: NodeJS.ProcessEnv = process.env,
  deps: { callTool: typeof callTool; postAudit: typeof postAudit } = { callTool, postAudit },
): Promise<ToolResponse> {
  const argsJson = (() => { try { return JSON.stringify(args ?? {}); } catch { return "{}"; } })();
  const argsBytes = Buffer.byteLength(argsJson);
  const argsHash = sha256Hex(argsJson);
  const entry = aliasMap[alias];

  if (!entry) {
    await deps.postAudit(env, { alias, outcome: "error", errorCode: "unknown_alias", argsHash, argsBytes });
    return errorResponse("unknown_tool", { tool: alias, hint: "It may have been disabled. Do not retry." });
  }
  const base = { alias, connId: entry.connId, serverName: entry.connName, toolName: entry.toolName, argsHash, argsBytes };

  if (!extCallAllowed()) {
    await deps.postAudit(env, { ...base, outcome: "blocked", errorCode: "rate_limited" });
    return errorResponse("rate_limited", { detail: "External tool call rate limit reached. Slow down and retry shortly." });
  }

  const started = Date.now();
  let res: Awaited<ReturnType<typeof callTool>>;
  try { res = await deps.callTool(entry.config, entry.toolName, args ?? {}); }
  catch (e) { res = { ok: false, error: { code: "protocol_error", message: (e as Error).message } }; }
  const durationMs = Date.now() - started;

  if (!res.ok) {
    await deps.postAudit(env, { ...base, outcome: "error", errorCode: res.error.code, durationMs });
    return errorResponse("external_tool_failed", { tool: entry.toolName, code: res.error.code, message: res.error.message });
  }

  let resultBytes: number | null = null;
  try { resultBytes = Buffer.byteLength(JSON.stringify(res.data ?? null)); } catch { /* leave null */ }
  await deps.postAudit(env, { ...base, outcome: "ok", durationMs, resultBytes });
  return jsonResponse((res.data ?? {}) as Record<string, unknown>);
}
