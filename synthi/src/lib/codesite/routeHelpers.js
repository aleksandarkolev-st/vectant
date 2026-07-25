import crypto from 'crypto';
import { NextResponse } from 'next/server';
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

function safeSecretEqual(presented, secret) {
  // Hash both to a fixed length before the constant-time compare so the
  // comparison never leaks the secret's length via an early-exit branch.
  const a = crypto.createHash('sha256').update(String(presented)).digest();
  const b = crypto.createHash('sha256').update(String(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

/**
 * Trusted internal-service authentication for server-to-server callers — namely
 * the collab-server's CodeSite control-plane probe, which presents the shared
 * secret `SYNTHI_CODESITE_TOKEN` as a Bearer token (see
 * codesiteActivityRegistry.controlPlaneHeaders). `x-synthi-internal-token` is
 * accepted too, matching the convention used by other internal routes.
 *
 * This is strictly ADDITIVE: it is inert unless the server-only secret is
 * configured, never weakens the NextAuth-session or NODE_ENV bypass guards, and
 * grants a distinct, auditable `internalService` identity rather than
 * impersonating a real user.
 */
function internalServiceActor(request) {
  const secret = process.env.SYNTHI_CODESITE_TOKEN;
  if (!secret || !request?.headers?.get) return null;
  const authHeader = request.headers.get('authorization') || '';
  const bearer = /^bearer\s+/i.test(authHeader) ? authHeader.replace(/^bearer\s+/i, '').trim() : '';
  const presented = bearer || (request.headers.get('x-synthi-internal-token') || '').trim();
  if (!presented || !safeSecretEqual(presented, secret)) return null;
  return {
    userId: 'codesite-internal-service',
    email: 'internal-service@synthi.local',
    workspaceUserId: 'internal-service',
    internalService: true,
  };
}

export async function requireCodesiteAccess(slug, mode = 'read', request = null) {
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

  const internal = internalServiceActor(request);
  if (internal) return { ok: true, actor: internal };

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
