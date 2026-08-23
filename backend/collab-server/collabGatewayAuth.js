'use strict';

const crypto = require('crypto');

const COMMAND_SCOPES = Object.freeze({
  EXEC: 'collab:exec',
  TERMINAL: 'collab:terminal',
  ALL: 'collab:*',
});

const SESSION_ID_RE = /^[a-f0-9]{8,64}$/i;
const USER_ID_RE = /^[A-Za-z0-9._:@-]{1,128}$/;
const AGENT_PROJECT_ID_RE = /^[A-Za-z0-9._:@-]{1,256}$/;
const AGENT_PROVIDER_RE = /^[a-z0-9][a-z0-9_.-]{0,63}$/;
const AGENT_PROVIDER_SESSION_RE = /^[\x21-\x7e]{1,256}$/;

function header(req, name) {
  const value = req?.headers?.[String(name || '').toLowerCase()];
  if (Array.isArray(value)) return String(value[0] || '');
  return typeof value === 'string' ? value : '';
}

function requestUrl(req) {
  try {
    return new URL(req?.url || '/', `http://${header(req, 'host') || 'localhost'}`);
  } catch (_) {
    return new URL('/', 'http://localhost');
  }
}

function query(req, name) {
  return requestUrl(req).searchParams.get(name) || '';
}

function bodyField(body, name) {
  const value = body && typeof body === 'object' ? body[name] : '';
  return typeof value === 'string' ? value : '';
}

function timingSafeEqualText(left, right) {
  if (!left || !right) return false;
  const a = Buffer.from(String(left));
  const b = Buffer.from(String(right));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function bearerToken(req) {
  const auth = header(req, 'authorization');
  const match = auth.match(/^Bearer\s+(.+)$/i);
  return match ? match[1].trim() : '';
}

function requestGatewayToken(req) {
  return bearerToken(req) || query(req, 'token') || '';
}

function configuredAiToken(config = {}, env = process.env) {
  return config.AI_BACKEND_AUTH_TOKEN || env.AI_BACKEND_AUTH_TOKEN || env.AI_ENGINE_AUTH_TOKEN || '';
}

function hasTrustedInternalToken(req, { config = {}, env = process.env } = {}) {
  const aiToken = configuredAiToken(config, env);
  const collabToken = env.COLLAB_INTERNAL_TOKEN || '';
  const bearer = bearerToken(req);

  if (aiToken && (
    timingSafeEqualText(header(req, 'x-synthi-internal-token'), aiToken) ||
    timingSafeEqualText(bearer, aiToken)
  )) {
    return true;
  }

  if (collabToken && (
    timingSafeEqualText(header(req, 'x-collab-internal-token'), collabToken) ||
    timingSafeEqualText(bearer, collabToken)
  )) {
    return true;
  }

  return false;
}

function isLocalAuthBypass(config = {}, env = process.env) {
  return Boolean(
    config.SYNTHI_WORKSPACE_AUTH_BYPASS &&
    !env.KUBERNETES_SERVICE_HOST &&
    env.NODE_ENV !== 'production'
  );
}

function base64UrlDecode(value) {
  const normalized = String(value || '').replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function verifyGatewayJwt(token, secret, { nowSeconds = Math.floor(Date.now() / 1000) } = {}) {
  if (!token || !secret) {
    const error = new Error(!secret ? 'gateway_auth_unconfigured' : 'gateway_token_required');
    error.code = error.message;
    throw error;
  }

  const parts = String(token).split('.');
  if (parts.length !== 3) {
    const error = new Error('gateway_token_malformed');
    error.code = error.message;
    throw error;
  }

  let headerJson;
  let payload;
  try {
    headerJson = JSON.parse(base64UrlDecode(parts[0]).toString('utf8'));
    payload = JSON.parse(base64UrlDecode(parts[1]).toString('utf8'));
  } catch (_) {
    const error = new Error('gateway_token_malformed');
    error.code = error.message;
    throw error;
  }

  if (headerJson.alg !== 'HS256') {
    const error = new Error('gateway_token_alg_rejected');
    error.code = error.message;
    throw error;
  }

  const signingInput = `${parts[0]}.${parts[1]}`;
  const expectedSig = base64UrlEncode(
    crypto.createHmac('sha256', secret).update(signingInput).digest()
  );
  if (!timingSafeEqualText(parts[2], expectedSig)) {
    const error = new Error('gateway_token_invalid');
    error.code = error.message;
    throw error;
  }

  if (payload.exp && Number(payload.exp) <= nowSeconds) {
    const error = new Error('gateway_token_expired');
    error.code = error.message;
    throw error;
  }
  if (payload.nbf && Number(payload.nbf) > nowSeconds) {
    const error = new Error('gateway_token_not_yet_valid');
    error.code = error.message;
    throw error;
  }

  const aud = payload.aud;
  const audienceOk = Array.isArray(aud)
    ? aud.includes('synthi-gateway')
    : aud === 'synthi-gateway';
  if (!audienceOk) {
    const error = new Error('gateway_token_audience_rejected');
    error.code = error.message;
    throw error;
  }

  if (payload.typ !== 'collab-gateway') {
    const error = new Error('gateway_token_type_rejected');
    error.code = error.message;
    throw error;
  }

  return payload;
}

function normalizeScopes(value) {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  if (typeof value === 'string') {
    return value.split(/[,\s]+/).map((scope) => scope.trim()).filter(Boolean);
  }
  return [];
}

function hasScope(payload, requiredScope) {
  const scopes = normalizeScopes(payload.scopes || payload.scope);
  return scopes.includes(COMMAND_SCOPES.ALL) || scopes.includes(requiredScope);
}

function requestedUserIds(req, parsed) {
  return [
    header(req, 'x-user-id'),
    query(req, 'userId'),
    bodyField(parsed, 'userId'),
  ].map(String).map((value) => value.trim()).filter(Boolean);
}

function requestedFilesystemIds(req, parsed) {
  return [
    header(req, 'x-runtime-fs-user-id'),
    query(req, 'filesystemUserId'),
    query(req, 'fsUserId'),
    bodyField(parsed, 'filesystemUserId'),
  ].map(String).map((value) => value.trim()).filter(Boolean);
}

function requestedRuntimeScopes(req, parsed) {
  return [
    header(req, 'x-runtime-scope'),
    query(req, 'runtimeScope'),
    bodyField(parsed, 'runtimeScope'),
  ].map(String).map((value) => value.trim()).filter(Boolean);
}

function requestedCollabSessionId(req, parsed, payload) {
  return (
    header(req, 'x-session-id') ||
    query(req, 'collabSessionId') ||
    bodyField(parsed, 'collabSessionId') ||
    (payload && typeof payload.collabSessionId === 'string' ? payload.collabSessionId : '')
  ).trim();
}

function normalizeAgentBindingClaim(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const projectId = String(value.projectId || '').trim();
  const provider = String(value.provider || '').trim().toLowerCase();
  const providerSessionRef = String(value.providerSessionRef || '').trim();
  if (
    !AGENT_PROJECT_ID_RE.test(projectId)
    || !AGENT_PROVIDER_RE.test(provider)
    || !AGENT_PROVIDER_SESSION_RE.test(providerSessionRef)
  ) {
    return false;
  }
  return Object.freeze({ projectId, provider, providerSessionRef });
}

function requestedAgentBinding(req, parsed) {
  const projectId = String(query(req, 'codeSiteProjectId') || bodyField(parsed, 'codeSiteProjectId') || '').trim();
  const provider = String(query(req, 'agentProvider') || bodyField(parsed, 'agentProvider') || '').trim().toLowerCase();
  const providerSessionRef = String(query(req, 'providerSessionRef') || bodyField(parsed, 'providerSessionRef') || '').trim();
  const supplied = [projectId, provider, providerSessionRef].filter(Boolean).length;
  if (supplied === 0) return null;
  if (supplied !== 3) return false;
  return normalizeAgentBindingClaim({ projectId, provider, providerSessionRef });
}

function identityMismatch(req, parsed, payload) {
  const allowedUsers = new Set([
    payload.sub,
    payload.actorUserId,
    payload.workspaceUserId,
  ].filter(Boolean).map(String));
  for (const requested of requestedUserIds(req, parsed)) {
    if (allowedUsers.size > 0 && !allowedUsers.has(requested)) {
      return { field: 'userId', requested };
    }
  }

  if (payload.filesystemUserId) {
    for (const requested of requestedFilesystemIds(req, parsed)) {
      if (requested !== String(payload.filesystemUserId)) {
        return { field: 'filesystemUserId', requested };
      }
    }
  }

  if (payload.runtimeScope) {
    for (const requested of requestedRuntimeScopes(req, parsed)) {
      if (requested !== String(payload.runtimeScope)) {
        return { field: 'runtimeScope', requested };
      }
    }
  }

  const claimedAgentBinding = normalizeAgentBindingClaim(payload.agentBinding);
  const requestAgentBinding = requestedAgentBinding(req, parsed);
  if (payload.agentBinding != null && !claimedAgentBinding) {
    return { field: 'agentBinding', requested: null };
  }
  if (requestAgentBinding === false) {
    return { field: 'agentBinding', requested: null };
  }
  if (Boolean(requestAgentBinding) !== Boolean(claimedAgentBinding)) {
    return { field: 'agentBinding', requested: requestAgentBinding };
  }
  if (requestAgentBinding && claimedAgentBinding && (
    requestAgentBinding.projectId !== claimedAgentBinding.projectId
    || requestAgentBinding.provider !== claimedAgentBinding.provider
    || requestAgentBinding.providerSessionRef !== claimedAgentBinding.providerSessionRef
  )) {
    return { field: 'agentBinding', requested: requestAgentBinding };
  }

  return null;
}

function verifyCollabSessionPermission({ req, parsed, payload, slug, sessionManager }) {
  const collabSessionId = requestedCollabSessionId(req, parsed, payload);
  if (!collabSessionId) return { ok: true, collabSessionId: null };

  if (!SESSION_ID_RE.test(collabSessionId)) {
    return { ok: false, status: 403, error: 'collab_session_invalid' };
  }

  const session = sessionManager?.getSession?.(collabSessionId);
  if (!session || session.status !== 'active') {
    return { ok: false, status: 403, error: 'collab_session_invalid' };
  }

  if (session.slug !== slug) {
    return { ok: false, status: 403, error: 'collab_session_workspace_mismatch' };
  }

  const actor = String(payload.workspaceUserId || payload.sub || '');
  if (!actor || !USER_ID_RE.test(actor)) {
    return { ok: false, status: 403, error: 'collab_actor_invalid' };
  }

  if (!sessionManager.checkPermission(collabSessionId, actor, 'canTerminal')) {
    return { ok: false, status: 403, error: 'terminal_permission_denied' };
  }

  return { ok: true, collabSessionId };
}

function authSecret(env = process.env) {
  return env.AUTH_SECRET || env.NEXTAUTH_SECRET || '';
}

function authorizeCollabGatewayRequest({
  req,
  parsed = null,
  slug,
  requiredScope = COMMAND_SCOPES.EXEC,
  config = {},
  sessionManager = null,
  env = process.env,
} = {}) {
  if (!slug) {
    return { ok: false, status: 400, error: 'workspace_required' };
  }

  if (hasTrustedInternalToken(req, { config, env })) {
    return { ok: true, source: 'internal' };
  }

  if (isLocalAuthBypass(config, env)) {
    return { ok: true, source: 'local_dev_bypass' };
  }

  const rawToken = requestGatewayToken(req);
  if (!rawToken) {
    return { ok: false, status: 401, error: 'collab_gateway_token_required' };
  }

  let payload;
  try {
    payload = verifyGatewayJwt(rawToken, authSecret(env));
  } catch (error) {
    return {
      ok: false,
      status: error.code === 'gateway_auth_unconfigured' ? 503 : 401,
      error: error.code || 'gateway_token_invalid',
    };
  }

  if (payload.workspaceSlug !== slug) {
    return { ok: false, status: 403, error: 'gateway_workspace_mismatch' };
  }

  if (!hasScope(payload, requiredScope)) {
    return { ok: false, status: 403, error: 'gateway_scope_denied' };
  }

  const mismatch = identityMismatch(req, parsed, payload);
  if (mismatch) {
    return {
      ok: false,
      status: 403,
      error: 'gateway_identity_mismatch',
      field: mismatch.field,
    };
  }

  const collabSession = verifyCollabSessionPermission({
    req,
    parsed,
    payload,
    slug,
    sessionManager,
  });
  if (!collabSession.ok) return collabSession;

  return {
    ok: true,
    source: 'gateway',
    payload,
    actorUserId: String(payload.actorUserId || payload.sub || ''),
    workspaceUserId: String(payload.workspaceUserId || payload.sub || ''),
    filesystemUserId: payload.filesystemUserId ? String(payload.filesystemUserId) : '',
    runtimeScope: payload.runtimeScope ? String(payload.runtimeScope) : '',
    collabSessionId: collabSession.collabSessionId || null,
    agentBinding: normalizeAgentBindingClaim(payload.agentBinding) || null,
  };
}

function terminalGatewayAuthProjection(result, workspaceSlug) {
  const isGateway = result?.source === 'gateway';
  return Object.freeze({
    source: result?.source || '',
    workspaceSlug: String(workspaceSlug || ''),
    actorUserId: isGateway ? String(result.actorUserId || '') : '',
    workspaceUserId: isGateway ? String(result.workspaceUserId || '') : '',
    filesystemUserId: isGateway ? String(result.filesystemUserId || '') : '',
    runtimeScope: isGateway ? String(result.runtimeScope || '') : '',
    collabSessionId: isGateway ? result.collabSessionId || null : null,
    agentBinding: isGateway ? normalizeAgentBindingClaim(result.agentBinding) || null : null,
  });
}

function authorizeTerminalGatewayRequest(options = {}) {
  const result = authorizeCollabGatewayRequest({
    ...options,
    requiredScope: COMMAND_SCOPES.TERMINAL,
  });
  if (!result.ok) return result;
  if (options.req) {
    options.req.collabGatewayAuth = terminalGatewayAuthProjection(result, options.slug);
  }
  return result;
}

function writeCollabGatewayAuthError(res, result) {
  const status = result?.status || 401;
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    error: result?.error || 'collab_gateway_auth_failed',
  }));
}

function requireCollabGatewayAuth(req, res, options = {}) {
  const result = authorizeCollabGatewayRequest({ req, ...options });
  if (result.ok) {
    req.collabGatewayAuth = result;
    return result;
  }
  writeCollabGatewayAuthError(res, result);
  return null;
}

module.exports = {
  COMMAND_SCOPES,
  authorizeCollabGatewayRequest,
  authorizeTerminalGatewayRequest,
  hasTrustedInternalToken,
  normalizeAgentBindingClaim,
  requireCollabGatewayAuth,
  terminalGatewayAuthProjection,
  verifyGatewayJwt,
  writeCollabGatewayAuthError,
};
