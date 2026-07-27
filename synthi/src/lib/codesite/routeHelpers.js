import { NextResponse } from 'next/server';
import { timingSafeEqual } from 'node:crypto';
import { resolveActor } from '@/lib/integrations/session';
import { canReadScope, canWriteScope } from '@/lib/integrations/scope';
import { checkLimit, RATE_LIMITS } from '@/lib/integrations/rateLimit';

export async function readJson(request) {
  try {
    return await request.json();
  } catch (_) {
    return {};
  }
}

export function okJson(payload, init = {}) {
  return NextResponse.json(payload, init);
}

export function errorJson(status, error, detail) {
  return NextResponse.json({ error, ...(detail ? { detail } : {}) }, { status });
}

function workspaceAuthBypassEnabled() {
  if (process.env.NODE_ENV === 'production') return false;
  return process.env.SYNTHI_WORKSPACE_AUTH_BYPASS === '1'
    || process.env.NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS === '1';
}

function hasTrustedInternalCodeSiteToken(request) {
  const configured = String(process.env.SYNTHI_CODESITE_TOKEN || '').trim();
  const authorization = String(request.headers.get('authorization') || '').trim();
  const prefix = 'Bearer ';
  if (!configured || !authorization.startsWith(prefix)) return false;
  const provided = authorization.slice(prefix.length);
  const expectedBytes = Buffer.from(configured);
  const providedBytes = Buffer.from(provided);
  return expectedBytes.length === providedBytes.length
    && timingSafeEqual(expectedBytes, providedBytes);
}

export async function requireCodesiteAccess(slug, mode = 'read', request = null) {
  if (request && hasTrustedInternalCodeSiteToken(request)) {
    return {
      ok: true,
      actor: {
        userId: 'codesite-control-plane',
        email: 'codesite-control-plane@synthi.local',
        workspaceUserId: 'codesite-control-plane',
        internal: true,
      },
    };
  }
  if (workspaceAuthBypassEnabled()) {
    return {
      ok: true,
      actor: {
        userId: 'codesite-dev-bypass',
        email: 'dev-bypass@synthi.local',
        workspaceUserId: 'dev-bypass',
        bypass: true,
      },
    };
  }

  const actor = await resolveActor();
  if (!actor) return { ok: false, status: 401, error: 'Authentication required' };
  const target = { scope: 'workspace', workspaceSlug: slug };
  const allowed = mode === 'write'
    ? await canWriteScope(actor, target)
    : await canReadScope(actor, target);
  if (!allowed) {
    return { ok: false, status: mode === 'write' ? 403 : 404, error: 'Workspace not found' };
  }
  return { ok: true, actor };
}

export function enforceRateLimit(actor, key, group = 'crud') {
  const limit = RATE_LIMITS[group] || RATE_LIMITS.crud;
  const result = checkLimit(`codesite:${group}:${actor?.userId || 'anonymous'}:${key}`, limit);
  if (result.ok) return null;
  return errorJson(429, 'rate_limited', { retryAfterMs: result.retryAfterMs || 0 });
}

export function parsePath(paramsPath) {
  if (!Array.isArray(paramsPath)) return [];
  return paramsPath.map((segment) => decodeURIComponent(String(segment || ''))).filter(Boolean);
}

export function requireBodyFields(body, fields) {
  const missing = fields.filter((field) => body?.[field] == null || body[field] === '');
  if (missing.length > 0) {
    return errorJson(400, 'missing_required_fields', { missing });
  }
  return null;
}

export function routeNotFound(path) {
  return errorJson(404, 'codesite_route_not_found', { path });
}

export function methodNotAllowed(method) {
  return errorJson(405, 'method_not_allowed', { method });
}

export function handleCodesiteError(error) {
  const status = Number(error?.status || error?.statusCode || 500);
  if (status >= 500) {
    console.error('[CodeSite]', error);
  }
  return errorJson(status, error?.code || error?.message || 'codesite_error', error?.detail);
}

export function assertFound(value, code = 'not_found') {
  if (!value) {
    const error = new Error(code);
    error.status = 404;
    error.code = code;
    throw error;
  }
  return value;
}
