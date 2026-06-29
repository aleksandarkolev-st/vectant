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
  codeSiteContextFromRequest,
  evaluateCodeSiteWrite,
  isCodeSiteDeniedError,
  normalizeRepoRelativePath,
};
