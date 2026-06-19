import crypto from 'crypto';
import { NextResponse } from 'next/server';
import { requireWorkspaceAccess } from '@/lib/workspaceAccess';

export const runtime = 'nodejs';

const DEFAULT_LOCAL_BRIDGE_URL = 'http://127.0.0.1:9466';
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const COLLAB_URL_ENV_VARS = [
  'COLLAB_SERVER_URL',
  'SYNTHI_COLLAB_SERVER_URL',
  'NEXT_PUBLIC_COLLAB_SERVER_URL',
  'COLLAB_URL',
];

function resolveServerUrl(name) {
  const value = process.env[name];
  return typeof value === 'string' && value.trim() ? value.trim().replace(/\/+$/, '') : '';
}

function resolveCollabServerUrl() {
  for (const name of COLLAB_URL_ENV_VARS) {
    const value = resolveServerUrl(name);
    if (value) return value;
  }
  return '';
}

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

function sanitizeErrorDetail(value) {
  if (!value) return '';
  const text = String(value);
  return text.length > 2048 ? `${text.slice(0, 2040)}…` : text;
}

function isThenable(value) {
  return typeof value?.then === 'function';
}

function collectProxyHeaders(request) {
  const headers = {
    'accept': request.headers.get('accept') || 'application/json',
  };
  const serverToken = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN;
  const browserToken = request.headers.get('x-synthi-workflow-token');
  if (serverToken) {
    headers['x-synthi-workflow-token'] = serverToken;
  } else if (browserToken) {
    headers['x-synthi-workflow-token'] = browserToken;
  }

  [
    'x-synthi-runtime-scope',
    'x-synthi-workspace-slug',
    'x-synthi-runtime-kind',
    'x-synthi-filesystem-user-id',
    'x-synthi-actor-user-id',
    'x-synthi-collab-session-id',
  ].forEach((headerName) => {
    const value = request.headers.get(headerName);
    if (value) headers[headerName] = value;
  });

  return headers;
}

async function readStateFromUpstreamBridge(baseUrl, request) {
  if (!baseUrl) return null;
  let target;
  try {
    target = new URL('/browser-workflows/state', baseUrl);
    const headers = collectProxyHeaders(request);
    const response = await fetch(target.href, {
      method: 'GET',
      headers,
    });
    const details = await upstreamErrorPayload(response);
    const payload = details.payload || {};
    return payload && typeof payload === 'object' && payload.state && typeof payload.state === 'object'
      ? payload.state
      : null;
  } catch (err) {
    console.warn('[Workflow Proxy] Failed to fetch fallback state', err);
    return null;
  }
}

function workflowPanelErrorState(detail, code = 'workflow_bridge_error') {
  const text = sanitizeErrorDetail(detail);
  const message = text || 'Workflow panel state is temporarily unavailable.';
  return {
    bridge: {
      status: 'error',
      detail: message,
      label: 'Workflow bridge unavailable',
    },
    runtime: {
      status: 'notConfigured',
      detail: message,
      label: 'Runtime unavailable',
      readiness: 'notConfigured',
    },
    observe: {
      status: 'needsRuntime',
      label: 'Runtime reconnect required',
      detail: message,
      lastScreenshotAt: null,
      selectedTabId: null,
      consent: null,
    },
    teach: {
      state: 'idle',
      label: 'Ready after reconnect',
      detail: message,
      tabId: null,
    },
    blockers: [
      {
        id: code,
        label: 'Workflow bridge unavailable',
        detail: message,
      },
    ],
  };
}

function statefulWorkflowErrorResponse(payload, stateDetail, code, status = 200) {
  return NextResponse.json(
    {
      ...payload,
      ok: false,
      state: workflowPanelErrorState(stateDetail, code),
    },
    {
      status,
      headers: {
        'cache-control': 'no-store',
      },
    },
  );
}

function asStringArrayPath(rawPath) {
  if (Array.isArray(rawPath)) {
    return rawPath
      .filter((segment) => typeof segment === 'string' && segment.trim().length > 0)
      .map((segment) => segment.trim());
  }

  if (typeof rawPath === 'string') {
    return rawPath
      .split('/')
      .map((segment) => segment.trim())
      .filter((segment) => segment.length > 0);
  }

  return [];
}

function inferWorkflowPathFromUrl(request) {
  const normalizedPath = new URL(request.url).pathname;
  const marker = '/browser-workflows/';
  const markerIndex = normalizedPath.indexOf(marker);
  if (markerIndex === -1) return '';

  return normalizedPath
    .slice(markerIndex + marker.length)
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0)
    .join('/');
}

async function resolveWorkflowPath(routeContext, request) {
  const rawParams = routeContext?.params;
  const params = isThenable(rawParams) ? await rawParams : rawParams;
  const fromParams = asStringArrayPath(params?.path).join('/');
  if (fromParams) return fromParams;

  const fromUrl = inferWorkflowPathFromUrl(request);
  return fromUrl;
}

async function upstreamErrorPayload(upstream) {
  try {
    const clone = upstream.clone();
    const contentType = clone.headers.get('content-type') || '';
    const raw = await clone.text();
    const trimmed = raw.trim();
    if (!trimmed) {
      return { contentType, detail: '' };
    }
    if (contentType.includes('application/json') || contentType.includes('+json')) {
      try {
        return { contentType, payload: JSON.parse(trimmed) };
      } catch (_) {
        return { contentType, detail: sanitizeErrorDetail(trimmed) };
      }
    }
    return { contentType, detail: sanitizeErrorDetail(trimmed) };
  } catch (_) {
    return { contentType: upstream.headers.get('content-type') || '', detail: '' };
  }
}

async function ensureRuntimeBridge(context) {
  const runtimeScope = context.runtimeScope;
  if (!runtimeScope) return { ok: true };

  const collabUrl = resolveCollabServerUrl();
  if (!collabUrl) return { ok: true };

  const userId = context.actorUserId || context.filesystemUserId || runtimeScope;
  try {
    const res = await fetch(`${collabUrl}/api/spawner/ensure`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        session_id: runtimeScope,
        user_id: userId,
        workspace_slug: context.workspaceSlug || '',
        workspaceKind: context.runtimeKind || '',
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
  } catch (err) {
    return {
      ok: false,
      status: 502,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function forwardToBridge(upstreamUrl, request) {
  const init = {
    method: request.method,
    headers: new Headers(),
    cache: 'no-store',
  };

  const contentType = request.headers.get('content-type');
  if (contentType) init.headers.set('content-type', contentType);
  const accept = request.headers.get('accept');
  if (accept) init.headers.set('accept', accept);

  const serverToken = process.env.SYNTHI_BROWSER_WORKFLOW_BRIDGE_TOKEN;
  const browserToken = request.headers.get('x-synthi-workflow-token');
  if (serverToken) {
    init.headers.set('x-synthi-workflow-token', serverToken);
  } else if (browserToken) {
    init.headers.set('x-synthi-workflow-token', browserToken);
  }

  [
    'x-synthi-runtime-scope',
    'x-synthi-workspace-slug',
    'x-synthi-runtime-kind',
    'x-synthi-filesystem-user-id',
    'x-synthi-actor-user-id',
    'x-synthi-collab-session-id',
  ].forEach((headerName) => {
    const value = request.headers.get(headerName);
    if (value) init.headers.set(headerName, value);
  });

  const propagatedHeaders = Object.fromEntries(init.headers.entries());
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    init.body = await request.arrayBuffer();
    init.headers.set('content-length', `${(init.body?.byteLength || 0)}`);
    propagatedHeaders['content-length'] = `${(init.body?.byteLength || 0)}`;
  }

  const upstream = await fetch(upstreamUrl, init);
  return { upstream, propagatedHeaders };
}

export async function proxyWorkflowBridge(request, routeContext) {
  try {
    let authorized;
    try {
      authorized = await authorizeRuntimeContext(parseRuntimeContext(request));
    } catch (err) {
      return NextResponse.json(
        {
          error: 'workflow_access_check_failed',
          detail: err instanceof Error ? err.message : String(err),
        },
        { status: 503 },
      );
    }
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

    const path = await resolveWorkflowPath(routeContext, request);
    if (!path) {
      return NextResponse.json(
        {
          error: 'workflow_unknown_path',
          path,
        },
        { status: 400 },
      );
    }
    const isStatePath = path === 'state' || path === 'state/';
    const isToolPath = path === 'tool' || path === 'tool/';
    const isStatefulPath = isStatePath || isToolPath;
    if (!isStatePath) {
      const ensure = await ensureRuntimeBridge(runtimeContext);
      if (!ensure.ok) {
        if (isToolPath) {
          return statefulWorkflowErrorResponse(
            {
              error: 'workflow_runtime_unavailable',
              status: ensure.status || 503,
              detail: ensure.detail,
              action: `${request.method || 'GET'}:${path}`,
              path,
            },
            `workflow_runtime_unavailable: ${ensure.detail || 'runtime could not be prepared'}`,
            'workflow_runtime_unavailable',
          );
        }
        return NextResponse.json(
          { error: 'workflow_runtime_unavailable', detail: ensure.detail },
          { status: ensure.status || 503 },
        );
      }
    }

    const incomingUrl = new URL(request.url);
    let upstreamUrl;
    try {
      upstreamUrl = new URL(`/browser-workflows/${path}`, baseUrl);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      if (isStatefulPath) {
        return statefulWorkflowErrorResponse(
          {
            error: 'workflow_bridge_url_invalid',
            status: 502,
            detail,
            action: `${request.method || 'GET'}:${path}`,
            path,
          },
          `workflow_bridge_url_invalid: ${detail}`,
          'workflow_bridge_url_invalid',
        );
      }
      return NextResponse.json(
        {
          error: 'workflow_bridge_url_invalid',
          detail,
          action: `${request.method || 'GET'}:${path}`,
          path,
        },
        {
          status: 502,
          headers: {
            'cache-control': 'no-store',
          },
        },
      );
    }
    upstreamUrl.search = incomingUrl.search;

    let upstream;
    let propagatedHeaders;
    try {
      ({ upstream, propagatedHeaders } = await forwardToBridge(upstreamUrl, request));
    } catch (err) {
      let fallbackState;
      if (isStatefulPath) {
        fallbackState = await readStateFromUpstreamBridge(baseUrl, request);
      }

      if (fallbackState) {
        return NextResponse.json(
          {
            error: 'workflow_bridge_unreachable',
            status: 502,
            detail: err instanceof Error ? err.message : String(err),
            action: `${request.method || 'GET'}:${path}`,
            path,
            upstream_url: upstreamUrl.toString(),
            headers: propagatedHeaders,
            state: fallbackState,
            ok: false,
          },
          {
            status: 200,
            headers: {
              'cache-control': 'no-store',
            },
          },
        );
      }

      if (isStatefulPath) {
        return statefulWorkflowErrorResponse(
          {
            error: 'workflow_bridge_unreachable',
            status: 502,
            detail: err instanceof Error ? err.message : String(err),
            action: `${request.method || 'GET'}:${path}`,
            path,
            upstream_url: upstreamUrl.toString(),
            headers: propagatedHeaders,
          },
          `workflow_bridge_unreachable: ${err instanceof Error ? err.message : String(err)}`,
          'workflow_bridge_unreachable',
        );
      }

      return NextResponse.json(
        {
          error: 'workflow_bridge_unreachable',
          detail: err instanceof Error ? err.message : String(err),
          action: `${request.method || 'GET'}:${path}`,
          path,
          upstream_url: upstreamUrl.toString(),
          headers: propagatedHeaders,
        },
        {
          status: 502,
          headers: {
            'cache-control': 'no-store',
          },
        },
      );
    }

    if (!upstream.ok) {
      const details = await upstreamErrorPayload(upstream);
      const sourcePayload = details.payload && typeof details.payload === 'object' && !Array.isArray(details.payload)
        ? details.payload
        : {};
      const isToolPath = path === 'tool' || path === 'tool/';
      const merged = {
        error: details.payload?.error || 'workflow_bridge_upstream_error',
        status: upstream.status,
        upstream_status: upstream.status,
        upstream_content_type: details.contentType || undefined,
        ...(sourcePayload || {}),
      };
      if (!Object.prototype.hasOwnProperty.call(merged, 'detail') && typeof details.detail === 'string' && details.detail) {
        merged.detail = details.detail;
      }

      const hasWorkflowState = merged.state && typeof merged.state === 'object';
      const shouldFallbackState = path === 'tool' || path === 'tool/' || isStatePath;
      if ((isToolPath || isStatePath) && hasWorkflowState) {
        if (!Object.prototype.hasOwnProperty.call(merged, 'ok')) {
          merged.ok = false;
        }
        return NextResponse.json(merged, {
          status: 200,
          headers: {
            'cache-control': 'no-store',
          },
        });
      }

      if (shouldFallbackState) {
        const fallbackState = await readStateFromUpstreamBridge(baseUrl, request);
        if (fallbackState) {
          return NextResponse.json({
            ...merged,
            ok: false,
            state: {
              ...(merged.state || {}),
              ...fallbackState,
            },
          }, {
            status: 200,
            headers: {
              'cache-control': 'no-store',
            },
          });
        }

        return statefulWorkflowErrorResponse(
          {
            ...merged,
          },
          `${merged.error}: ${merged.detail || 'workflow bridge returned a non-state response.'}`,
          merged.error || 'workflow_bridge_upstream_error',
        );
      }

      return NextResponse.json(merged, {
        status: upstream.status,
        headers: {
          'cache-control': 'no-store',
        },
      });
    }

    return new NextResponse(upstream.body, {
      status: upstream.status,
      headers: responseHeaders(upstream),
    });
  } catch (err) {
    return NextResponse.json(
      {
        error: 'workflow_internal_error',
        detail: err instanceof Error ? err.message : String(err),
      },
      { status: 500 },
    );
  }
}

export async function GET(request, routeContext) {
  try {
    return await proxyWorkflowBridge(request, routeContext);
  } catch (err) {
    return NextResponse.json(
      { error: 'workflow_internal_error', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
    );
  }
}

export async function POST(request, routeContext) {
  try {
    return await proxyWorkflowBridge(request, routeContext);
  } catch (err) {
    return NextResponse.json(
      { error: 'workflow_internal_error', detail: err instanceof Error ? err.message : String(err) },
      { status: 500 },
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
