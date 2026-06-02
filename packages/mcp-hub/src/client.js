import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { assertSafeUrl } from './ssrfGuard.js';
import { buildAuthHeaders } from './helpers.js';
import { createGuardedFetch } from './guardedFetch.js';

const DEFAULT_TIMEOUT_MS = Number(process.env.SYNTHI_MCP_CALL_TIMEOUT_MS) || 20000;

/** Normalized error envelope. */
function err(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Build a transport for the resolved config, injecting auth headers and the
 * guarded fetch (re-validates every hop to defeat DNS rebinding / redirect SSRF).
 * The SDK transports accept a top-level `fetch` (FetchLike) used for ALL network
 * requests, alongside `requestInit` for headers — confirmed in the installed
 * @modelcontextprotocol/sdk type defs (R1-5 wiring).
 */
function makeTransport(config, guardedFetchFn) {
  const headers = buildAuthHeaders(config);
  const url = new URL(config.url);
  const opts = { requestInit: { headers } };
  if (guardedFetchFn) opts.fetch = guardedFetchFn;
  if (config.transport === 'sse') {
    return new SSEClientTransport(url, opts);
  }
  return new StreamableHTTPClientTransport(url, opts);
}

async function withSession(config, opts, fn) {
  const { lookup } = opts || {};
  try {
    await assertSafeUrl(config.url, { allowlist: ssrfAllowlist(), lookup });
  } catch (e) {
    return err('ssrf_blocked', e.message);
  }

  const client = new Client({ name: 'synthi-mcp-hub', version: '1.0.0' }, { capabilities: {} });
  const guardedFetchFn = createGuardedFetch({ allowlist: ssrfAllowlist(), lookup });
  const transport = makeTransport(config, guardedFetchFn);
  let timer;
  try {
    const timeout = new Promise((_, rej) => {
      timer = setTimeout(() => rej(new Error('timeout')), DEFAULT_TIMEOUT_MS);
    });
    await Promise.race([client.connect(transport), timeout]);
    const result = await Promise.race([fn(client), timeout]);
    return { ok: true, ...result };
  } catch (e) {
    return err(e._code || classify(e), e.message);
  } finally {
    clearTimeout(timer);
    try { await client.close(); } catch { /* ignore close errors */ }
  }
}

function ssrfAllowlist() {
  return (process.env.SYNTHI_MCP_SSRF_ALLOWLIST || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

function classify(e) {
  const m = String(e?.message || '').toLowerCase();
  if (m.includes('timeout')) return 'timeout';
  if (m.includes('401') || m.includes('403') || m.includes('unauthorized')) return 'auth_failed';
  if (m.includes('certificate') || m.includes('tls') || m.includes('ssl')) return 'tls_error';
  return 'protocol_error';
}

export async function listTools(config, opts) {
  return withSession(config, opts, async (client) => {
    const { tools } = await client.listTools();
    return { tools };
  });
}

export async function callTool(config, toolName, args, opts) {
  return withSession(config, opts, async (client) => {
    try {
      const data = await client.callTool({ name: toolName, arguments: args || {} });
      return { data };
    } catch (e) {
      throw Object.assign(new Error(e.message), { _code: 'tool_error' });
    }
  });
}

export async function testConnection(config, opts) {
  return withSession(config, opts, async (client) => {
    const { tools } = await client.listTools();
    const info = client.getServerVersion?.() || {};
    return { serverInfo: info, toolCount: (tools || []).length };
  });
}
