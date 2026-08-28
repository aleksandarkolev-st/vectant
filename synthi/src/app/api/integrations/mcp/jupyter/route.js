import { NextResponse } from 'next/server';
import { authenticatePat } from '@/lib/integrations/patAuth';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';
import { listJupyterServers, resolveJupyterServer } from '@/lib/jupyter/registry';
import { JupyterClient } from '@/lib/jupyter/client';
import { normalizeNotebook, revisionOf, serializeNotebook } from '@/lib/jupyter/notebook';
import { recordJupyterAudit } from '@/lib/jupyter/audit';

export const runtime = 'nodejs';

const READ_OPERATIONS = new Set(['list', 'snapshot', 'test']);
const WRITE_OPERATIONS = new Set(['execute', 'save', 'interrupt', 'restart']);
const MAX_CODE_CHARS = 100_000;
const MAX_NOTEBOOK_CHARS = 2_000_000;

function error(error, status, extra = {}) {
  return NextResponse.json({ error, ...extra }, { status });
}

function workspaceSlug(value) {
  return String(value || '').trim();
}

function notebookPath(value) {
  const path = String(value || '').trim();
  return path.endsWith('.ipynb') ? path : null;
}

async function authorize(req, slug, operation) {
  const actor = await authenticatePat(req);
  if (!actor) return { response: error('unauthenticated', 401) };
  if (!slug) return { response: error('workspace_required', 400) };
  if (!READ_OPERATIONS.has(operation) && !WRITE_OPERATIONS.has(operation)) {
    return { response: error('unsupported_operation', 400) };
  }

  const limit = checkLimit(`cli:${actor.userId}:mcp-jupyter:${operation}`, RATE_LIMITS.extcall);
  if (!limit.ok) return { response: error('rate_limited', 429, { retryAfterMs: limit.retryAfterMs }) };

  const canAccess = READ_OPERATIONS.has(operation) ? canReadScope : canWriteScope;
  if (!(await canAccess({ userId: actor.userId }, { scope: 'workspace', workspaceSlug: slug }))) {
    return { response: error('forbidden', 403) };
  }
  return { actor };
}

async function serverFor(serverId, slug) {
  const server = await resolveJupyterServer(String(serverId || '').trim(), slug);
  return server || null;
}

function jupyterError(exception) {
  return error(exception?.code || 'jupyter_error', exception?.status || 502, {
    detail: String(exception?.message || 'Jupyter operation failed').slice(0, 512),
  });
}

async function listServers(slug) {
  // `listJupyterServers` deliberately strips encrypted connection tokens.
  return NextResponse.json({ servers: await listJupyterServers(slug) });
}

async function snapshot(req, slug, actor, query) {
  const path = notebookPath(query.get('path'));
  const server = await serverFor(query.get('serverId'), slug);
  if (!server || !path) return error('not_found', 404);
  try {
    const result = await new JupyterClient(server).getNotebook(path, req.signal);
    const content = serializeNotebook(normalizeNotebook(result.content));
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'notebook_read', notebookPath: path, details: { bytes: content.length, via: 'mcp' } });
    return NextResponse.json({ notebook: JSON.parse(content), revision: revisionOf(content), serverRevision: result.last_modified || null });
  } catch (exception) {
    return jupyterError(exception);
  }
}

async function testServer(req, slug, actor, body) {
  const server = await serverFor(body.serverId, slug);
  if (!server) return error('not_found', 404);
  try {
    const status = await new JupyterClient(server).status(req.signal);
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'connection_tested', details: { via: 'mcp' } });
    return NextResponse.json({ ok: true, status: { started: status.started || null, lastActivity: status.last_activity || null } });
  } catch (exception) {
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'connection_test_failed', details: { code: exception?.code || 'unknown', via: 'mcp' } });
    return NextResponse.json({ ok: false, error: exception?.code || 'unavailable' }, { status: exception?.status || 502 });
  }
}

async function execute(req, slug, actor, body) {
  const path = notebookPath(body.path);
  const code = typeof body.code === 'string' ? body.code.trim() : '';
  const server = await serverFor(body.serverId, slug);
  if (!server || !path || !code) return error('serverId_path_and_code_required', 400);
  if (code.length > MAX_CODE_CHARS) return error('code_too_large', 413);
  try {
    const client = new JupyterClient(server);
    const session = await client.connectKernel({ path, kernelName: body.kernelName, signal: req.signal });
    const result = await client.execute({ kernelId: session.kernel?.id, code, signal: req.signal });
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'cell_executed', notebookPath: path, kernelId: session.kernel?.id, details: { codeBytes: Buffer.byteLength(code), outputCount: result.outputs.length, via: 'mcp' } });
    return NextResponse.json({ kernelId: session.kernel?.id, ...result });
  } catch (exception) {
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'cell_execution_failed', notebookPath: path, details: { code: exception?.code || 'unknown', via: 'mcp' } });
    return jupyterError(exception);
  }
}

async function save(req, slug, actor, body) {
  const path = notebookPath(body.path);
  const server = await serverFor(body.serverId, slug);
  if (!server || !path || !body.notebook || typeof body.notebook !== 'object') return error('serverId_path_and_notebook_required', 400);
  if (JSON.stringify(body.notebook).length > MAX_NOTEBOOK_CHARS) return error('notebook_too_large', 413);
  try {
    const client = new JupyterClient(server);
    const current = await client.getNotebook(path, req.signal);
    if (body.expectedServerRevision && current.last_modified !== body.expectedServerRevision) {
      return error('server_newer', 409, { revision: current.last_modified });
    }
    const normalized = normalizeNotebook(body.notebook);
    const saved = await client.saveNotebook(path, normalized, req.signal);
    const content = serializeNotebook(normalized);
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'notebook_saved', notebookPath: path, details: { bytes: content.length, via: 'mcp' } });
    return NextResponse.json({ revision: revisionOf(content), serverRevision: saved.last_modified || null });
  } catch (exception) {
    return jupyterError(exception);
  }
}

async function manageKernel(req, slug, actor, body, operation) {
  const kernelId = String(body.kernelId || '').trim();
  const server = await serverFor(body.serverId, slug);
  if (!server || !kernelId) return error('not_found', 404);
  try {
    const client = new JupyterClient(server);
    if (operation === 'interrupt') {
      await client.interruptKernel(kernelId, req.signal);
      void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'kernel_interrupted', notebookPath: body.path || null, kernelId, details: { via: 'mcp' } });
      return NextResponse.json({ ok: true, kernelId });
    }
    const kernel = await client.restartKernel(kernelId, req.signal);
    void recordJupyterAudit({ workspaceSlug: slug, serverId: server.id, actorUserId: actor.userId, eventType: 'kernel_restarted', notebookPath: body.path || null, kernelId, details: { via: 'mcp' } });
    return NextResponse.json({ ok: true, kernelId: kernel.id || kernelId });
  } catch (exception) {
    return jupyterError(exception);
  }
}

/**
 * PAT-gated bridge for MCP Jupyter control. Connection registration remains a
 * browser/UI-only operation so a tool call can never add or disclose a token.
 */
export async function GET(req) {
  const query = new URL(req.url).searchParams;
  const operation = query.get('operation') || 'list';
  const slug = workspaceSlug(query.get('workspaceSlug'));
  const authorization = await authorize(req, slug, operation);
  if (authorization.response) return authorization.response;
  if (operation === 'list') return listServers(slug);
  return snapshot(req, slug, authorization.actor, query);
}

export async function POST(req) {
  const body = await req.json().catch(() => ({}));
  const operation = String(body.operation || '').trim();
  const slug = workspaceSlug(body.workspaceSlug);
  const authorization = await authorize(req, slug, operation);
  if (authorization.response) return authorization.response;
  if (operation === 'test') return testServer(req, slug, authorization.actor, body);
  if (operation === 'execute') return execute(req, slug, authorization.actor, body);
  if (operation === 'save') return save(req, slug, authorization.actor, body);
  return manageKernel(req, slug, authorization.actor, body, operation);
}
