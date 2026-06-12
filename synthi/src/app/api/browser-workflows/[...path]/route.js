import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/workspaceAccess';

export const runtime = 'nodejs';

const DEFAULT_LOCAL_BRIDGE_URL = 'http://127.0.0.1:9466';
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

function hashRuntimeScopePart(value) {
  const text = String(value || 'unknown');
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function scopedRuntimePart(prefix, value) {
  return `${prefix}-${hashRuntimeScopePart(value)}`;
}

function normalizeBaseUrl(value) {
  return typeof value === 'string' && value.trim()
    ? value.trim().replace(/\/+$/, '')
    : '';
}

function normalizeTemplate(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function runtimeIdSecret() {
  return (
    process.env.SYNTHI_RUNTIME_ID_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.AI_BACKEND_AUTH_TOKEN ||
    'synthi-local-runtime-id-secret'
  );
}

function base32NoPadding(buffer) {
  let bits = 0;
  let value = 0;
  let output = '';

  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }

  return output;
}

function hmacBase32(value, length = 20) {
  const digest = crypto
    .createHmac('sha256', runtimeIdSecret())
    .update(String(value || 'unknown'))
    .digest();
  return base32NoPadding(digest).slice(0, length);
}

function runtimeResourceId(runtimeScope) {
  return `rt-${hmacBase32(runtimeScope, 20)}`;
}

function headerValue(headers, name) {
  const value = headers.get(name);
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

function parseRuntimeContext(request) {
  const headers = request.headers;
  return {
    runtimeScope: headerValue(headers, 'x-synthi-runtime-scope'),
    workspaceSlug: headerValue(headers, 'x-synthi-workspace-slug'),
    runtimeKind: headerValue(headers, 'x-synthi-runtime-kind'),
    filesystemUserId: headerValue(headers, 'x-synthi-filesystem-user-id'),
    actorUserId: headerValue(headers, 'x-synthi-actor-user-id'),
    collabSessionId: headerValue(headers, 'x-synthi-collab-session-id'),
  };
}

function expectedRuntimeContext(workspaceSlug, userId, context) {
  const workspacePart = scopedRuntimePart('ws', workspaceSlug);
  const collabSessionId = context.collabSessionId;
  if (context.runtimeKind === 'collab' || collabSessionId) {
    if (!collabSessionId) {
      return { ok: false, status: 400, error: 'workflow_collab_session_required' };
    }
    return {
      ok: true,
      runtimeScope: `${workspacePart}-collab-${hashRuntimeScopePart(collabSessionId)}`,
      runtimeKind: 'collab',
      filesystemUserId: scopedRuntimePart('collab', collabSessionId),
      actorUserId: userId,
      collabSessionId,
    };
  }

  return {
    ok: true,
    runtimeScope: `${workspacePart}-user-${hashRuntimeScopePart(userId)}`,
    runtimeKind: 'private',
    filesystemUserId: userId,
    actorUserId: userId,
  };
}

async function authorizeRuntimeContext(context) {
  if (!context.workspaceSlug) {
    if (process.env.NODE_ENV === 'production') {
      return { ok: false, status: 400, error: 'workflow_workspace_required' };
    }
    return { ok: true, context };
  }

  const access = await requireWorkspaceAccess(context.workspaceSlug);
  if (!access.ok) {
    return { ok: false, status: access.status || 403, error: access.error || 'workspace_access_denied' };
  }

  const userId = access.session?.user?.id || access.email;
  const expected = expectedRuntimeContext(context.workspaceSlug, userId, context);
  if (!expected.ok) return expected;

  if (context.runtimeScope && context.runtimeScope !== expected.runtimeScope) {
    return { ok: false, status: 403, error: 'workflow_runtime_scope_forbidden' };
  }

  return {
    ok: true,
    context: {
      ...context,
      runtimeScope: expected.runtimeScope,
      runtimeKind: expected.runtimeKind,
      filesystemUserId: expected.filesystemUserId,
      actorUserId: expected.actorUserId,
      collabSessionId: expected.collabSessionId || '',
    },
  };
}

function runtimeBridgeBaseUrl(runtimeScope) {
  if (!runtimeScope) return '';

  const runtimeId = runtimeResourceId(runtimeScope);
  const port = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT || '9466';
  const template = normalizeTemplate(process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_TARGET_TEMPLATE);
  if (template) {
    return normalizeBaseUrl(
      template
        .replaceAll('{runtimeId}', runtimeId)
        .replaceAll('{runtimeScope}', encodeURIComponent(runtimeScope))
        .replaceAll('{bridgePort}', String(port)),
    );
  }

  if (process.env.NODE_ENV === 'production') {
    return `http://${runtimeId}.synthi.svc.cluster.local:${port}`;
  }

  return '';
}

function workflowBridgeBaseUrl(runtimeScope) {
  const runtimeScoped = runtimeBridgeBaseUrl(runtimeScope);
  if (runtimeScoped) return runtimeScoped;

  const configured = normalizeBaseUrl(process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_URL);
  if (configured) return configured;

  const port = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_PORT;
  if (port) {
    const host = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_HOST || '127.0.0.1';
    return `http://${host}:${port}`;
  }

  return process.env.NODE_ENV === 'production' ? '' : DEFAULT_LOCAL_BRIDGE_URL;
}

function responseHeaders(upstream) {
  const headers = new Headers();
  const contentType = upstream.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  headers.set('cache-control', 'no-store');
  return headers;
}

async function ensureRuntimeBridge(context) {
  const runtimeScope = context.runtimeScope;
  if (!runtimeScope) return { ok: true };

  const collabUrl = normalizeBaseUrl(process.env.COLLAB_SERVER_URL);
  if (!collabUrl) return { ok: true };

  const userId = context.actorUserId || context.filesystemUserId || runtimeScope;
  const res = await fetch(`${collabUrl}/api/spawner/ensure`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({
      session_id: runtimeScope,
      user_id: userId,
      workspaceSlug: context.workspaceSlug || '',
      runtimeKind: context.runtimeKind || '',
      filesystemUserId: context.filesystemUserId || userId,
    }),
  });

  if (res.ok) return { ok: true };
  let detail = `HTTP ${res.status}`;
  try {
    const data = await res.json();
    detail = data?.error || data?.message || detail;
  } catch (_) {
    // ignore non-JSON errors
  }
  return { ok: false, status: res.status, detail };
}

export async function proxyWorkflowBridge(request, routeContext) {
  const authorized = await authorizeRuntimeContext(parseRuntimeContext(request));
  if (!authorized.ok) {
    return NextResponse.json(
      { error: authorized.error },
      { status: authorized.status || 403 },
    );
  }

  const runtimeContext = authorized.context;
  const baseUrl = workflowBridgeBaseUrl(runtimeContext.runtimeScope);
  if (!baseUrl) {
    return NextResponse.json(
      {
        error: runtimeContext.runtimeScope
          ? 'workflow_bridge_route_not_configured'
          : 'workflow_runtime_scope_required',
      },
      { status: 503 },
    );
  }

  const ensure = await ensureRuntimeBridge(runtimeContext);
  if (!ensure.ok) {
    return NextResponse.json(
      { error: 'workflow_runtime_unavailable', detail: ensure.detail },
      { status: ensure.status || 503 },
    );
  }

  const params = await routeContext.params;
  const path = Array.isArray(params?.path) ? params.path.join('/') : '';
  const incomingUrl = new URL(request.url);
  const upstreamUrl = new URL(`/browser-workflows/${path}`, baseUrl);
  upstreamUrl.search = incomingUrl.search;

  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const accept = request.headers.get('accept');
  if (accept) headers.set('accept', accept);

  const serverToken = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN;
  const browserToken = request.headers.get('x-synthi-workflow-token');
  if (serverToken) {
    headers.set('x-synthi-workflow-token', serverToken);
  } else if (browserToken) {
    headers.set('x-synthi-workflow-token', browserToken);
  }

  const init = {
    method: request.method,
    headers,
    cache: 'no-store',
  };
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
  }

  try {
    const upstream = await fetch(upstreamUrl, init);
    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch (err) {
    return NextResponse.json(
      { error: 'workflow_bridge_unreachable', detail: err?.message || String(err) },
      { status: 502 },
    );
  }
}

export function OPTIONS() {
  return new NextResponse(null, {
    status: 204,
    headers: {
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': [
        'Content-Type',
        'X-Synthi-Workflow-Token',
        'X-Synthi-Runtime-Scope',
        'X-Synthi-Workspace-Slug',
        'X-Synthi-Runtime-Kind',
        'X-Synthi-Filesystem-User-Id',
        'X-Synthi-Actor-User-Id',
        'X-Synthi-Collab-Session-Id',
      ].join(', '),
      'access-control-max-age': '600',
    },
  });
}

export const GET = proxyWorkflowBridge;
export const POST = proxyWorkflowBridge;
