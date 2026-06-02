import crypto from 'node:crypto';
import prisma from '@/lib/prisma';
import { resolveToolConfigs } from '@/lib/integrations/connectionStore';
import { listTools, callTool } from '@synthi/mcp-hub';
import { jsonSchemaToGemini } from '@synthi/mcp-hub/helpers';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { canReadScope } from '@/lib/integrations/scope';

const ALIAS_RE = /^ext_\d+$/;
// R1-7 aggregate guards: skip a tool whose converted schema is too large, and cap
// the number of tools offered per connection.
const MAX_TOOLS_PER_CONNECTION = Number(process.env.SYNTHI_MCP_MAX_TOOLS_PER_CONN) || 64;
const MAX_SCHEMA_BYTES = Number(process.env.SYNTHI_MCP_MAX_SCHEMA_BYTES) || 8192;
// R1-11: bounded fan-out for discovery + a per-chat-turn execution cap.
const MAX_LISTTOOLS_CONCURRENCY = Number(process.env.SYNTHI_MCP_LISTTOOLS_CONCURRENCY) || 5;
const MAX_CALLS_PER_TURN = Number(process.env.SYNTHI_MCP_MAX_CALLS_PER_TURN) || 8;

/** True if a function name is an external-tool alias. */
export function isExternalToolName(name) {
  return ALIAS_RE.test(String(name || ''));
}

/** Run `fn` over `items` with bounded concurrency, preserving input order in results. */
async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const idx = next++;
      results[idx] = await fn(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  if (n <= 0) return results;
  await Promise.all(Array.from({ length: n }, worker));
  return results;
}

function sha256Hex(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

/**
 * Build Gemini function declarations for all external tools the scope may call.
 * Aliases (`ext_<i>`) avoid Gemini name-length/charset limits and hide internal IDs
 * (R1-2). A failing connection — or a tool with an unconvertible/oversized schema —
 * is skipped so the chat turn never aborts (R1-7). Tool discovery runs with bounded
 * concurrency; the per-call timeout is enforced inside the hub (R1-11).
 * @param {{userId:string, workspaceSlug:string|null}} scope
 * @returns {Promise<{declarations:Array, aliasMap:Record<string,object>}>}
 */
export async function buildExternalTools(scope) {
  // R1-9 defense-in-depth: only expose a workspace's tools to a member of that
  // workspace. The chat route does not itself authorize `workspacePath`, so a
  // forged/non-member slug must never enumerate or invoke another workspace's
  // connections (which hold secrets). Non-members fall back to personal-only.
  let effectiveScope = scope;
  if (scope?.workspaceSlug) {
    let isMember = false;
    try {
      isMember = await canReadScope({ userId: scope.userId }, { scope: 'workspace', workspaceSlug: scope.workspaceSlug });
    } catch {
      isMember = false;
    }
    if (!isMember) effectiveScope = { userId: scope.userId, workspaceSlug: null };
  }

  let configs = [];
  try {
    configs = await resolveToolConfigs(effectiveScope);
  } catch (e) {
    console.warn('[externalTools] resolveToolConfigs failed:', e?.message);
    return { declarations: [], aliasMap: {} };
  }

  const listResults = await mapWithConcurrency(configs, MAX_LISTTOOLS_CONCURRENCY, async (config) => {
    try {
      return { config, res: await listTools(config) };
    } catch (e) {
      return { config, res: { ok: false, error: { code: 'protocol_error', message: e?.message } } };
    }
  });

  const declarations = [];
  const aliasMap = {};
  let i = 0;

  // Assign aliases in config order so they're deterministic regardless of which
  // listTools call finished first.
  for (const { config, res } of listResults) {
    if (!res.ok) {
      console.warn(`[externalTools] listTools failed for "${config.name}": ${res.error?.code}`);
      continue;
    }
    const allow = new Set(config.allowlist || []);
    let perConn = 0;
    for (const tool of res.tools || []) {
      if (!allow.has(tool.name)) continue;
      if (perConn >= MAX_TOOLS_PER_CONNECTION) {
        console.warn(`[externalTools] per-connection tool cap (${MAX_TOOLS_PER_CONNECTION}) reached for "${config.name}"`);
        break;
      }
      let parameters;
      try {
        parameters = jsonSchemaToGemini(tool.inputSchema);
        if (JSON.stringify(parameters).length > MAX_SCHEMA_BYTES) {
          console.warn(`[externalTools] schema too large, skipping "${config.name}:${tool.name}"`);
          continue;
        }
      } catch (e) {
        console.warn(`[externalTools] schema conversion failed, skipping "${config.name}:${tool.name}": ${e?.message}`);
        continue;
      }
      const alias = `ext_${i++}`;
      perConn += 1;
      declarations.push({
        name: alias,
        description: `[${config.name}] ${tool.description || tool.name}`,
        parameters,
      });
      // R1-10: identity is (connId, toolName); never keyed by user-facing name.
      aliasMap[alias] = { connId: config.id, connName: config.name, toolName: tool.name, config };
    }
  }
  return { declarations, aliasMap };
}

/**
 * Write an audit row. Never stores raw secrets or full payloads — only a sha256 of
 * the args and byte sizes (R1-8). Audit failures are swallowed (never break a call).
 */
async function writeAudit(row) {
  try {
    await prisma.mcpCallAudit.create({
      data: {
        connectionId: row.connId || null,
        serverName: row.connName || 'unknown',
        toolName: row.toolName || 'unknown',
        userId: row.scope?.userId || null,
        workspaceSlug: row.scope?.workspaceSlug || null,
        outcome: row.outcome,
        errorCode: row.errorCode || null,
        alias: row.alias || null,
        callerType: 'chat',
        durationMs: row.durationMs ?? null,
        argsHash: row.argsHash || null,
        argsBytes: row.argsBytes ?? null,
        resultBytes: row.resultBytes ?? null,
      },
    });
  } catch (e) {
    console.warn('[externalTools] audit write failed:', e?.message);
  }
}

/**
 * Execute an external tool call by alias. ALWAYS returns a JSON-serializable object
 * suitable as a Gemini functionResponse (`{ ...result }` or `{ error }`); never throws,
 * so a single bad tool can't break the chat turn.
 *
 * Enforces a per-turn execution cap (R1-11) and a per-user rate limit (R1-A); both
 * return a structured `rate_limited` result without calling out. Records a rich audit
 * row (R1-8) on every outcome.
 *
 * @param {string} alias e.g. "ext_0"
 * @param {object} args
 * @param {Record<string,object>} aliasMap from buildExternalTools
 * @param {{userId:string, workspaceSlug?:string|null}} scope
 * @param {{count:number, max?:number}} [turnState] per-turn counter (mutated)
 */
export async function callExternalTool(alias, args, aliasMap, scope, turnState) {
  const argsJson = (() => { try { return JSON.stringify(args ?? {}); } catch { return '{}'; } })();
  const argsBytes = Buffer.byteLength(argsJson);
  const argsHash = sha256Hex(argsJson);
  const entry = aliasMap[alias];

  if (!entry) {
    await writeAudit({ scope, alias, outcome: 'error', errorCode: 'unknown_alias', argsHash, argsBytes });
    return { error: `Unknown tool "${alias}". It may have been disabled. Do not retry.` };
  }

  const auditBase = { connId: entry.connId, connName: entry.connName, toolName: entry.toolName, scope, alias, argsHash, argsBytes };

  // R1-11: per-turn execution cap.
  if (turnState && typeof turnState.count === 'number') {
    const max = turnState.max ?? MAX_CALLS_PER_TURN;
    if (turnState.count >= max) {
      await writeAudit({ ...auditBase, outcome: 'blocked', errorCode: 'turn_cap' });
      return { error: 'rate_limited', detail: `Per-turn external tool limit (${max}) reached. Do not retry this turn.` };
    }
  }

  // R1-A: per-user external-call rate limit.
  if (scope?.userId) {
    const rl = checkLimit(`user:${scope.userId}:extcall`, RATE_LIMITS.extcall);
    if (!rl.ok) {
      await writeAudit({ ...auditBase, outcome: 'blocked', errorCode: 'rate_limited' });
      return { error: 'rate_limited', retryAfterMs: rl.retryAfterMs, detail: 'External tool call rate limit reached. Slow down and try again shortly.' };
    }
  }

  if (turnState && typeof turnState.count === 'number') turnState.count += 1;

  const started = Date.now();
  let res;
  try {
    res = await callTool(entry.config, entry.toolName, args || {});
  } catch (e) {
    res = { ok: false, error: { code: 'protocol_error', message: e?.message } };
  }
  const durationMs = Date.now() - started;

  if (!res.ok) {
    await writeAudit({ ...auditBase, outcome: 'error', errorCode: res.error?.code, durationMs });
    return { error: `Tool "${entry.toolName}" failed (${res.error?.code}): ${res.error?.message}. You may report this to the user.` };
  }

  let resultBytes = null;
  try { resultBytes = Buffer.byteLength(JSON.stringify(res.data ?? null)); } catch { /* non-serializable; leave null */ }
  await writeAudit({ ...auditBase, outcome: 'ok', durationMs, resultBytes });
  // Always return a JSON-serializable object for the Gemini functionResponse
  // (a tool may legitimately return no data).
  return res.data ?? {};
}
