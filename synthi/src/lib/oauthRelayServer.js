import crypto from 'crypto';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const CALLBACK_PARAM_RE = /(redirect|callback|return|continue|next|url|uri)/i;
const DEFAULT_TTL_MS = 5 * 60 * 1000;
const MAX_TTL_MS = 15 * 60 * 1000;
const SESSION_PREFIX = 'relay_';
const SIGNING_ALGORITHM = 'sha256';

const consumedRelaySessions = new Map();

function base64UrlEncode(value) {
  const buffer = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return buffer
    .toString('base64')
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/g, '');
}

function base64UrlDecode(value) {
  const padded = String(value || '').replaceAll('-', '+').replaceAll('_', '/');
  const padding = padded.length % 4 ? '='.repeat(4 - (padded.length % 4)) : '';
  return Buffer.from(`${padded}${padding}`, 'base64').toString('utf8');
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left || ''));
  const rightBuffer = Buffer.from(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) return false;
  return crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function oauthRelaySecret() {
  return (
    process.env.SYNTHI_OAUTH_RELAY_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.AI_BACKEND_AUTH_TOKEN ||
    ''
  );
}

export function oauthRelayAvailable() {
  return Boolean(oauthRelaySecret());
}

function signPayload(encodedPayload) {
  const secret = oauthRelaySecret();
  if (!secret) {
    throw new Error('oauth_relay_secret_not_configured');
  }
  return base64UrlEncode(
    crypto
      .createHmac(SIGNING_ALGORITHM, secret)
      .update(encodedPayload)
      .digest(),
  );
}

function signRelayPayload(payload) {
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signature = signPayload(encodedPayload);
  return `${SESSION_PREFIX}${encodedPayload}.${signature}`;
}

export function verifyRelaySessionToken(sessionId) {
  const raw = String(sessionId || '').trim();
  if (!raw.startsWith(SESSION_PREFIX)) {
    return { ok: false, status: 400, error: 'invalid_relay_session' };
  }

  const token = raw.slice(SESSION_PREFIX.length);
  const dot = token.lastIndexOf('.');
  if (dot <= 0) {
    return { ok: false, status: 400, error: 'invalid_relay_session' };
  }

  const encodedPayload = token.slice(0, dot);
  const signature = token.slice(dot + 1);
  let expectedSignature;
  try {
    expectedSignature = signPayload(encodedPayload);
  } catch (err) {
    return { ok: false, status: 500, error: err.message || 'oauth_relay_unavailable' };
  }

  if (!timingSafeEqualString(signature, expectedSignature)) {
    return { ok: false, status: 403, error: 'relay_session_signature_invalid' };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecode(encodedPayload));
  } catch {
    return { ok: false, status: 400, error: 'invalid_relay_session' };
  }

  const now = Date.now();
  if (!payload?.sid || !payload?.expiresAt || Number(payload.expiresAt) <= now) {
    return { ok: false, status: 410, error: 'relay_session_expired' };
  }

  return { ok: true, payload };
}

export function markRelaySessionConsumed(sessionId, now = Date.now()) {
  const verified = verifyRelaySessionToken(sessionId);
  if (!verified.ok) return verified;
  consumedRelaySessions.set(verified.payload.sid, Number(verified.payload.expiresAt) || now);
  return { ok: true, payload: verified.payload };
}

export function relaySessionConsumed(sessionId, now = Date.now()) {
  pruneConsumedSessions(now);
  const verified = verifyRelaySessionToken(sessionId);
  if (!verified.ok) return verified;
  if (consumedRelaySessions.has(verified.payload.sid)) {
    return { ok: false, status: 409, error: 'relay_session_consumed' };
  }
  return { ok: true, payload: verified.payload };
}

function pruneConsumedSessions(now = Date.now()) {
  for (const [sid, expiresAt] of consumedRelaySessions.entries()) {
    if (Number(expiresAt) <= now) consumedRelaySessions.delete(sid);
  }
}

function parseInteger(value) {
  const numeric = Number(value);
  return Number.isInteger(numeric) ? numeric : null;
}

export function relayTtlMs() {
  const configured = parseInteger(process.env.SYNTHI_OAUTH_RELAY_TTL_MS);
  if (!configured || configured < 1000) return DEFAULT_TTL_MS;
  return Math.min(configured, MAX_TTL_MS);
}

export function normalizeLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host === '[::1]' ? '::1' : host;
}

export function parseUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

export function parseLoopbackCallbackUrl(callbackUrl) {
  const parsed = parseUrl(callbackUrl);
  if (!parsed) return { ok: false, status: 400, error: 'invalid_callback_url' };

  const host = normalizeLoopbackHost(parsed.hostname);
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { ok: false, status: 400, error: 'unsupported_callback_protocol' };
  }
  if (!LOOPBACK_HOSTS.has(host) || !Number.isInteger(port) || port < 1 || port > 65535) {
    return { ok: false, status: 400, error: 'callback_must_target_loopback_port' };
  }

  return {
    ok: true,
    protocol: parsed.protocol.replace(':', ''),
    host,
    port,
    path: parsed.pathname || '/',
  };
}

export function findExpectedLoopbackCallback(authUrl) {
  const parsed = parseUrl(authUrl);
  if (!parsed) return null;

  const inspectParams = (params) => {
    for (const [key, value] of params) {
      if (!CALLBACK_PARAM_RE.test(key)) continue;
      const callback = parseLoopbackCallbackUrl(value);
      if (callback.ok) {
        return {
          host: callback.host,
          port: callback.port,
          pathPrefix: callback.path || '/',
        };
      }
    }
    return null;
  };

  const fromSearch = inspectParams(parsed.searchParams);
  if (fromSearch) return fromSearch;

  const hash = parsed.hash ? parsed.hash.slice(1) : '';
  if (!hash.includes('=')) return null;
  return inspectParams(new URLSearchParams(hash.startsWith('?') ? hash.slice(1) : hash));
}

function normalizeExpectedCallback(value) {
  const expected = value && typeof value === 'object' ? value : {};
  const port = Number(expected.port);
  const host = normalizeLoopbackHost(expected.host);
  const pathPrefix = String(expected.pathPrefix || expected.path || '').trim();

  return {
    ...(LOOPBACK_HOSTS.has(host) ? { host } : {}),
    ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}),
    ...(pathPrefix ? { pathPrefix: pathPrefix.startsWith('/') ? pathPrefix : `/${pathPrefix}` } : {}),
  };
}

function pathMatchesPrefix(path, prefix) {
  if (!prefix || prefix === '/') return true;
  if (path === prefix) return true;
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalized);
}

export function validateCallbackAgainstExpected(callbackUrl, expectedCallback) {
  const callback = parseLoopbackCallbackUrl(callbackUrl);
  if (!callback.ok) return callback;

  const expected = normalizeExpectedCallback(expectedCallback);
  if (expected.host && callback.host !== expected.host) {
    return { ok: false, status: 400, error: 'callback_host_mismatch' };
  }
  if (expected.port && callback.port !== expected.port) {
    return { ok: false, status: 400, error: 'callback_port_mismatch' };
  }
  if (expected.pathPrefix && !pathMatchesPrefix(callback.path, expected.pathPrefix)) {
    return { ok: false, status: 400, error: 'callback_path_mismatch' };
  }

  return { ok: true, callback, expected };
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

export function expectedRuntimeContext(workspaceSlug, userId, context = {}) {
  const workspacePart = scopedRuntimePart('ws', workspaceSlug);
  const collabSessionId = String(context.collabSessionId || '').trim();
  if (context.runtimeKind === 'collab' || collabSessionId) {
    if (!collabSessionId) {
      return { ok: false, status: 400, error: 'relay_collab_session_required' };
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

export function createRelaySessionPayload({ access, requestBody }) {
  const body = requestBody && typeof requestBody === 'object' ? requestBody : {};
  const workspaceSlug = String(body.workspaceSlug || '').trim();
  const runtimeScope = String(body.runtimeScope || '').trim();
  const terminalId = String(body.terminalId || '').trim();
  const runtimeKind = String(body.runtimeKind || '').trim() || 'private';
  const collabSessionId = String(body.collabSessionId || '').trim();
  const actorUserId = access.session?.user?.id || access.email;

  if (!workspaceSlug || workspaceSlug !== access.workspace.slug) {
    return { ok: false, status: 403, error: 'workspace_scope_mismatch' };
  }

  const expectedRuntime = expectedRuntimeContext(workspaceSlug, actorUserId, {
    runtimeKind,
    collabSessionId,
  });
  if (!expectedRuntime.ok) return expectedRuntime;
  if (!runtimeScope || runtimeScope !== expectedRuntime.runtimeScope) {
    return { ok: false, status: 403, error: 'runtime_scope_forbidden' };
  }

  const expectedFromAuthUrl = findExpectedLoopbackCallback(body.authUrl);
  const expectedCallback = {
    ...expectedFromAuthUrl,
    ...normalizeExpectedCallback(body.expectedCallback),
  };

  const now = Date.now();
  const expiresAt = now + relayTtlMs();
  const secret = oauthRelaySecret();
  if (!secret) {
    return { ok: false, status: 500, error: 'oauth_relay_secret_not_configured' };
  }

  const payload = {
    sid: crypto.randomBytes(16).toString('hex'),
    workspaceSlug,
    workspaceId: access.workspace.id,
    runtimeScope,
    runtimeKind: expectedRuntime.runtimeKind,
    filesystemUserId: expectedRuntime.filesystemUserId,
    actorUserIdHash: crypto
      .createHmac('sha256', secret)
      .update(String(actorUserId || 'unknown'))
      .digest('hex')
      .slice(0, 24),
    terminalId,
    collabSessionId: expectedRuntime.collabSessionId || '',
    expectedCallback,
    providerOrigin: parseUrl(body.authUrl)?.origin || '',
    createdAt: now,
    expiresAt,
  };

  return {
    ok: true,
    payload,
    sessionId: signRelayPayload(payload),
    expiresAt: new Date(expiresAt).toISOString(),
    expectedCallback,
  };
}

export async function forwardRuntimeCallback({ runtimeScope, callbackUrl }) {
  const collabUrl = String(
    process.env.COLLAB_SERVER_URL ||
    process.env.NEXT_PUBLIC_COLLAB_SERVER_URL ||
    'http://localhost:1234',
  ).replace(/\/+$/, '');

  const response = await fetch(`${collabUrl}/runtime-callback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify({ runtimeScope, callbackUrl }),
  });

  const data = await response.json().catch(() => ({}));
  return {
    ok: response.ok && data?.ok !== false,
    statusCode: data?.statusCode || response.status,
    error: data?.error || null,
  };
}

