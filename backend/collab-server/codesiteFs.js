const path = require('path');

class CodeSiteFSDeniedError extends Error {
  constructor(event) {
    super(event.details?.reason || 'codesite_write_denied');
    this.name = 'CodeSiteFSDeniedError';
    this.code = 'CODESITE_WRITE_DENIED';
    this.status = 403;
    this.event = event;
  }
}

function normalizeRepoRelativePath(input) {
  if (!input || typeof input !== 'string') {
    throw new Error('path_required');
  }
  if (input.includes('\0')) {
    throw new Error('path_null_byte');
  }
  const normalized = path.posix.normalize(input.replace(/\\/g, '/')).replace(/^\/+/, '');
  if (!normalized || normalized === '.') {
    throw new Error('path_required');
  }
  if (normalized.startsWith('..') || normalized.includes('/../') || path.isAbsolute(normalized)) {
    throw new Error('path_escape');
  }
  return normalized;
}

function codeSiteContextFromRequest(req, data = {}, extra = {}) {
  const payload = data.codesite || data.codeSite || {};
  const header = (name) => req?.headers?.[name] || req?.headers?.[name.toLowerCase()];
  const context = {
    active: false,
    mode: value(payload.mode, header('x-codesite-mode')) || 'enforce',
    workspaceSlug: extra.workspaceSlug || data.workspaceSlug || data.slug || null,
    actorUserId: extra.actorUserId || data.userId || data.actorUserId || header('x-user-id') || null,
    effectiveUserId: extra.effectiveUserId || null,
    displayCallsign: value(payload.displayCallsign, payload.callsign, header('x-codesite-callsign')),
    mutationLeaseId: value(payload.mutationLeaseId, payload.leaseId, header('x-codesite-lease-id')),
    transactionId: value(payload.transactionId, header('x-codesite-transaction-id')),
    allowedPaths: parsePatternList(value(payload.allowedPaths, header('x-codesite-allowed-paths'))),
    blockedPaths: parsePatternList(value(payload.blockedPaths, payload.noFlyZones, header('x-codesite-blocked-paths'))),
    allowedTools: parsePatternList(value(payload.allowedTools, header('x-codesite-allowed-tools'))),
    evidenceRefs: parsePatternList(value(payload.evidenceRefs, header('x-codesite-evidence-refs'))),
    processAncestry: parsePatternList(value(payload.processAncestry, header('x-codesite-process-ancestry'))),
    controlPlaneUrl: value(payload.controlPlaneUrl, payload.control_plane_url, header('x-codesite-control-plane-url')),
    authToken: value(payload.authToken, payload.auth_token, header('x-codesite-token')),
    cookie: value(payload.cookie, header('cookie')),
  };
  context.active = Boolean(
    context.transactionId ||
    context.mutationLeaseId ||
    context.allowedPaths.length ||
    context.blockedPaths.length ||
    payload.enforce === true,
  );
  return context;
}

function codeSiteCommitMessage(message, data = {}) {
  const payload = data.codesite || data.codeSite || data;
  const trailers = codeSiteCommitTrailers(payload);
  if (!trailers.length) return String(message || '');
  const base = String(message || '').trimEnd();
  const existing = new Set(
    base
      .split(/\r?\n/)
      .map((line) => line.match(/^(CodeSite-[A-Za-z-]+):/)?.[1])
      .filter(Boolean)
  );
  const nextTrailers = trailers.filter(([key]) => !existing.has(key));
  if (!nextTrailers.length) return base;
  return `${base}\n\n${nextTrailers.map(([key, trailerValue]) => `${key}: ${trailerValue}`).join('\n')}`;
}

function codeSiteCommitTrailers(payload = {}) {
  const proof = payload.proofBundle || payload.proof_bundle || {};
  const invariants = value(payload.invariants, proof.invariants);
  const blackBox = value(
    payload.blackBoxDigest,
    payload.black_box_digest,
    payload.blackBox,
    payload.black_box,
    proof.incidentReplayDigest,
    proof.bundleDigest,
    proof.portableDigest,
  );
  return [
    ['CodeSite-Project', value(payload.projectId, payload.project_id, proof.projectId)],
    ['CodeSite-Flight', value(payload.displayCallsign, payload.callsign, payload.flight, proof.displayCallsign)],
    ['CodeSite-Transaction', value(payload.transactionId, payload.transaction_id, proof.transactionId)],
    ['CodeSite-Lease', value(payload.mutationLeaseId, payload.mutation_lease_id, payload.leaseId, payload.clearance, proof.mutationLeaseId)],
    ['CodeSite-Read-Set', value(payload.readSetDigest, payload.read_set_digest, proof.readSetDigest)],
    ['CodeSite-Write-Set', value(payload.writeSetDigest, payload.write_set_digest, proof.writeSetDigest)],
    ['CodeSite-Invariants', Array.isArray(invariants) ? invariants.join(',') : invariants],
    ['CodeSite-Landing', value(payload.landingStatus, payload.landing_status, payload.landing)],
    ['CodeSite-Black-Box', blackBox],
  ].filter(([, trailerValue]) => trailerValue !== undefined && trailerValue !== null && trailerValue !== '');
}

function value(...values) {
  return values.find((item) => item !== undefined && item !== null && item !== '');
}

function parsePatternList(input) {
  if (Array.isArray(input)) return input.map(String).map(cleanPattern).filter(Boolean);
  if (!input) return [];
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (!trimmed) return [];
    if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('"') && trimmed.endsWith('"'))) {
      try {
        return parsePatternList(JSON.parse(trimmed));
      } catch (_) {
        return trimmed.split(',').map(cleanPattern).filter(Boolean);
      }
    }
    return trimmed.split(',').map(cleanPattern).filter(Boolean);
  }
  return [cleanPattern(String(input))].filter(Boolean);
}

function cleanPattern(pattern) {
  return String(pattern || '').replace(/\\/g, '/').replace(/^\/+/, '').trim();
}

function assertCodeSiteWriteAllowed(context, attempt) {
  const result = evaluateCodeSiteWrite(context, attempt);
  if (!result.ok && context?.mode !== 'monitor') {
    throw new CodeSiteFSDeniedError(result.event);
  }
  return result;
}

function assertCodeSiteWritesAllowed(context, attempts) {
  return attempts.map((attempt) => assertCodeSiteWriteAllowed(context, attempt));
}

async function enforceCodeSiteWriteAllowed(context, attempt, options = {}) {
  const result = assertCodeSiteWriteAllowed(context, attempt);
  if (result.ok) {
    await recordCodeSiteWriteAttempt(context, result, options);
  }
  return result;
}

async function enforceCodeSiteWritesAllowed(context, attempts, options = {}) {
  const results = [];
  for (const attempt of attempts) {
    results.push(await enforceCodeSiteWriteAllowed(context, attempt, options));
  }
  return results;
}

async function recordCodeSiteWriteAttempt(context, result, options = {}) {
  if (!context?.active || !context.transactionId) return null;
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('codesite_control_plane_fetch_unavailable');
  }
  const baseUrl = resolveControlPlaneBaseUrl(context);
  if (!baseUrl) {
    throw new Error('codesite_control_plane_url_required');
  }
  const url = `${baseUrl}/transactions/${encodeURIComponent(context.transactionId)}/record-write`;
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const token = context.authToken || process.env.SYNTHI_CODESITE_TOKEN;
  const cookie = context.cookie || process.env.SYNTHI_CODESITE_COOKIE;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      path: result.path,
      tool: result.tool,
      evidenceRefs: context.evidenceRefs || [],
      processAncestry: context.processAncestry || [],
      codesiteFsEvent: result.event,
    }),
  });
  const body = await readJsonBody(response);
  if (!response.ok || body?.ok === false) {
    throw new CodeSiteFSDeniedError({
      ...result.event,
      type: 'write_denied',
      details: {
        ...result.event.details,
        reason: 'codesite_control_plane_denied_write',
        reason_codes: [
          'control_plane_denied_write',
          ...asArray(body?.policyDecision?.reasonCodes || body?.decision?.reasonCodes),
        ],
        control_plane_status: response.status,
        control_plane_response: body,
      },
    });
  }
  return body;
}

function resolveControlPlaneBaseUrl(context) {
  const explicit = context.controlPlaneUrl || process.env.SYNTHI_CODESITE_API_BASE_URL;
  if (explicit) {
    return trimTrailingSlash(String(explicit).replace('{workspace_slug}', encodeURIComponent(context.workspaceSlug || '')));
  }
  const appBase = process.env.SYNTHI_CODESITE_BASE_URL || process.env.SYNTHI_APP_URL;
  if (!appBase || !context.workspaceSlug) return null;
  return `${trimTrailingSlash(appBase)}/api/workspace/${encodeURIComponent(context.workspaceSlug)}/codesite`;
}

async function readJsonBody(response) {
  const text = await response.text().catch(() => '');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch (_) {
    return { text };
  }
}

function trimTrailingSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function evaluateCodeSiteWrite(context, attempt = {}) {
  const relPath = normalizeRepoRelativePath(attempt.path || attempt.filePath || attempt.newPath || attempt.oldPath);
  const tool = attempt.tool || attempt.kind || 'file_write';
  const active = Boolean(context?.active);
  const base = {
    ok: true,
    path: relPath,
    tool,
    event: buildEvent(context, attempt, relPath, 'write_allowed', ['inside_clearance_route']),
  };
  if (!active) return base;

  if (context.allowedTools?.length && !context.allowedTools.includes(tool)) {
    return denied(context, attempt, relPath, ['tool_not_in_clearance']);
  }
  if (context.blockedPaths?.some((pattern) => matchPathPattern(relPath, pattern))) {
    return denied(context, attempt, relPath, ['entered_no_fly_zone']);
  }
  if (context.allowedPaths?.length && !context.allowedPaths.some((pattern) => matchPathPattern(relPath, pattern))) {
    return denied(context, attempt, relPath, ['outside_clearance_route']);
  }
  return base;
}

function denied(context, attempt, relPath, reasonCodes) {
  const reason = `${attempt.kind || 'write'} denied for ${relPath}: ${reasonCodes.join(',')}`;
  return {
    ok: false,
    path: relPath,
    tool: attempt.tool || attempt.kind || 'file_write',
    reasonCodes,
    event: buildEvent(context, attempt, relPath, 'write_denied', reasonCodes, reason),
  };
}

function buildEvent(context = {}, attempt = {}, relPath, type, reasonCodes, reason = null) {
  return {
    type,
    transaction_id: context.transactionId || null,
    mutation_lease_id: context.mutationLeaseId || null,
    display_callsign: context.displayCallsign || null,
    workspace_slug: context.workspaceSlug || null,
    actor_user_id: context.actorUserId || null,
    effective_user_id: context.effectiveUserId || null,
    path: relPath,
    tool: attempt.tool || attempt.kind || 'file_write',
    wall_time: new Date().toISOString(),
    evidence_refs: context.evidenceRefs || [],
    details: {
      reason: reason || reasonCodes.join(','),
      reason_codes: reasonCodes,
      process_ancestry: context.processAncestry || [],
      operation: attempt.kind || 'write',
    },
  };
}

function matchPathPattern(relPath, patternValue) {
  const pattern = cleanPattern(patternValue);
  if (!pattern) return false;
  if (pattern === '*' || pattern === '**') return true;
  return globToRegex(pattern).test(relPath);
}

function globToRegex(pattern) {
  let source = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];
    if (char === '*' && next === '*') {
      source += '.*';
      index += 1;
      continue;
    }
    if (char === '*') {
      source += '[^/]*';
      continue;
    }
    source += /[\\^$+?.()|[\]{}]/.test(char) ? `\\${char}` : char;
  }
  return new RegExp(`^${source}$`);
}

function isCodeSiteDeniedError(error) {
  return error?.code === 'CODESITE_WRITE_DENIED';
}

module.exports = {
  CodeSiteFSDeniedError,
  assertCodeSiteWriteAllowed,
  assertCodeSiteWritesAllowed,
  codeSiteCommitMessage,
  codeSiteCommitTrailers,
  codeSiteContextFromRequest,
  enforceCodeSiteWriteAllowed,
  enforceCodeSiteWritesAllowed,
  evaluateCodeSiteWrite,
  isCodeSiteDeniedError,
  normalizeRepoRelativePath,
};
