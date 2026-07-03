const path = require('path');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);

const MAX_INLINE_SNAPSHOT_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_DIFF_BYTES = 64 * 1024;
const MAX_TEXT_DIFF_LINES = 160;
const QUARANTINE_MANIFEST_SCHEMA_VERSION = 'synthi.codesitefs.quarantineManifest.v1';
const DEFAULT_QUARANTINE_BASE_DIR = path.join(os.tmpdir(), 'synthi-codesitefs-quarantine');

class CodeSiteFSDeniedError extends Error {
  constructor(event) {
    const isReadDenied = event?.type === 'read_denied';
    super(event.details?.reason || (isReadDenied ? 'codesite_read_denied' : 'codesite_write_denied'));
    this.name = 'CodeSiteFSDeniedError';
    this.code = isReadDenied ? 'CODESITE_READ_DENIED' : 'CODESITE_WRITE_DENIED';
    this.status = 403;
    this.event = event;
  }
}

class CodeSiteCommitBlockedError extends Error {
  constructor(message, details = {}) {
    super(message || 'codesite_commit_blocked');
    this.name = 'CodeSiteCommitBlockedError';
    this.code = 'CODESITE_COMMIT_BLOCKED';
    this.status = 409;
    this.details = details;
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

async function resolveCodeSiteRepoPath(repoRoot, input) {
  if (!repoRoot || typeof repoRoot !== 'string') {
    throw codeSitePathError('repo_root_required', 'CodeSiteFS repo root is required for path containment');
  }
  const normalized = normalizeRepoRelativePath(input);
  const repoRealPath = await fsp.realpath(repoRoot).catch((error) => {
    throw codeSitePathError('repo_root_unavailable', error?.message || 'CodeSiteFS repo root is unavailable');
  });
  const absolutePath = path.resolve(repoRealPath, normalized);
  assertPathInsideRepo(repoRealPath, absolutePath, 'repo_path_escape');

  try {
    const stat = await fsp.lstat(absolutePath);
    const realPath = await fsp.realpath(absolutePath).catch((error) => {
      throw codeSitePathError('repo_path_symlink_unresolved', error?.message || 'CodeSiteFS path symlink could not be resolved');
    });
    assertPathInsideRepo(repoRealPath, realPath, 'repo_path_symlink_escape');
    assertCanonicalRepoPath(repoRealPath, normalized, realPath);
    const targetStat = stat.isSymbolicLink()
      ? await fsp.stat(realPath)
      : stat;
    return {
      path: normalized,
      repoRealPath,
      absolutePath,
      realPath,
      exists: true,
      kind: fileKind(targetStat),
      isSymlink: stat.isSymbolicLink(),
      parentRealPath: path.dirname(realPath),
      canonicalPath: normalized,
    };
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const { parentRealPath, canonicalAbsolutePath } = await nearestExistingParentRealPath(repoRealPath, absolutePath);
  assertPathInsideRepo(repoRealPath, parentRealPath, 'repo_parent_symlink_escape');
  assertPathInsideRepo(repoRealPath, canonicalAbsolutePath, 'repo_parent_symlink_escape');
  assertCanonicalRepoPath(repoRealPath, normalized, canonicalAbsolutePath);
  return {
    path: normalized,
    repoRealPath,
    absolutePath,
    realPath: null,
    exists: false,
    kind: 'missing',
    isSymlink: false,
    parentRealPath,
    canonicalPath: normalized,
  };
}

async function nearestExistingParentRealPath(repoRealPath, absolutePath) {
  let current = path.dirname(absolutePath);
  while (true) {
    assertPathInsideRepo(repoRealPath, current, 'repo_path_escape');
    try {
      const parentRealPath = await fsp.realpath(current);
      const missingRel = path.relative(current, absolutePath);
      return {
        parentRealPath,
        canonicalAbsolutePath: path.resolve(parentRealPath, missingRel),
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw codeSitePathError('repo_parent_unavailable', error?.message || 'CodeSiteFS parent path is unavailable');
      }
    }
    const next = path.dirname(current);
    if (next === current) {
      throw codeSitePathError('repo_parent_unavailable', 'CodeSiteFS could not find an existing parent path');
    }
    current = next;
  }
}

function assertCanonicalRepoPath(repoRealPath, normalizedPath, canonicalAbsolutePath) {
  const canonicalPath = repoRelativePath(repoRealPath, canonicalAbsolutePath);
  if (canonicalPath !== normalizedPath) {
    throw codeSitePathError(
      'repo_path_symlink_alias',
      `CodeSiteFS path resolves through a symlink alias: ${normalizedPath} -> ${canonicalPath}`,
    );
  }
}

function repoRelativePath(repoRealPath, candidatePath) {
  const rel = path.relative(repoRealPath, candidatePath);
  return rel.replace(/\\/g, '/');
}

function assertPathInsideRepo(repoRealPath, candidatePath, code) {
  const rel = path.relative(repoRealPath, candidatePath);
  if (rel && (rel.startsWith('..') || path.isAbsolute(rel))) {
    throw codeSitePathError(code, `CodeSiteFS path escapes repo root: ${candidatePath}`);
  }
}

function fileKind(stat) {
  if (stat.isDirectory()) return 'directory';
  if (stat.isFile()) return 'file';
  if (stat.isSymbolicLink()) return 'symlink';
  return 'other';
}

function codeSitePathError(code, message) {
  const error = new Error(message || code);
  error.code = code;
  return error;
}

function codeSiteContextFromRequest(req, data = {}, extra = {}) {
  const hasCodeSitePayload = Object.prototype.hasOwnProperty.call(data, 'codesite')
    || Object.prototype.hasOwnProperty.call(data, 'codeSite')
    || Object.prototype.hasOwnProperty.call(data, 'codesiteContext')
    || Object.prototype.hasOwnProperty.call(data, 'codeSiteContext')
    || Object.prototype.hasOwnProperty.call(data, 'code_site_context');
  const payload = data.codesite || data.codeSite || data.codesiteContext || data.codeSiteContext || data.code_site_context || {};
  const header = (name) => req?.headers?.[name] || req?.headers?.[name.toLowerCase()];
  const explicitMode = value(payload.mode, header('x-codesite-mode'));
  const required = truthy(value(
    payload.required,
    payload.require,
    payload.enforce,
    payload.active,
    data.codesiteRequired,
    data.codeSiteRequired,
    header('x-codesite-required'),
    header('x-codesite-active'),
  ));
  const agentSessionId = value(
    payload.agentSessionId,
    payload.agent_session_id,
    data.agentSessionId,
    data.agent_session_id,
    data.synthiAgentSessionId,
    data.synthi_agent_session_id,
    header('x-codesite-agent-session-id'),
    header('x-agent-session-id'),
    header('x-synthi-agent-session-id'),
  );
  const agentProvider = value(
    payload.agentProvider,
    payload.agent_provider,
    data.agentProvider,
    data.agent_provider,
    data.synthiAgentProvider,
    data.synthi_agent_provider,
    header('x-codesite-agent-provider'),
    header('x-agent-provider'),
    header('x-synthi-agent-provider'),
  );
  const agentRuntime = value(
    payload.agentRuntime,
    payload.agent_runtime,
    data.agentRuntime,
    data.agent_runtime,
    data.synthiAgentRuntime,
    data.synthi_agent_runtime,
    header('x-codesite-agent-runtime'),
    header('x-agent-runtime'),
    header('x-synthi-agent-runtime'),
  );
  const processAncestry = parsePatternList(value(
    payload.processAncestry,
    payload.process_ancestry,
    data.processAncestry,
    data.process_ancestry,
    header('x-codesite-process-ancestry'),
    header('x-process-ancestry'),
    header('x-synthi-process-ancestry'),
  ));
  const explicitManagedAgent = truthy(value(
    payload.managedAgent,
    payload.managed_agent,
    data.managedAgent,
    data.managed_agent,
    data.codesiteManagedAgent,
    data.codeSiteManagedAgent,
    extra.managedAgent,
    extra.forceManagedAgent,
    header('x-codesite-managed-agent'),
    header('x-managed-agent'),
    header('x-synthi-managed-agent'),
  ));
  const managedAgent = explicitManagedAgent || hasManagedAgentSignal({
    agentSessionId,
    agentProvider,
    agentRuntime,
    processAncestry,
    data,
    header,
  });
  const requestedMode = explicitMode || 'enforce';
  const context = {
    active: false,
    required,
    managedAgent,
    mode: managedAgent && requestedMode === 'monitor' ? 'enforce' : requestedMode,
    workspaceSlug: extra.workspaceSlug || data.workspaceSlug || data.slug || null,
    actorUserId: extra.actorUserId || data.userId || data.actorUserId || header('x-user-id') || null,
    effectiveUserId: extra.effectiveUserId || null,
    agentSessionId,
    agentProvider,
    agentRuntime,
    displayCallsign: value(payload.displayCallsign, payload.callsign, header('x-codesite-callsign')),
    mutationLeaseId: value(payload.mutationLeaseId, payload.leaseId, header('x-codesite-lease-id')),
    transactionId: value(payload.transactionId, header('x-codesite-transaction-id')),
    allowedPaths: parsePatternList(value(payload.allowedPaths, header('x-codesite-allowed-paths'))),
    blockedPaths: parsePatternList(value(payload.blockedPaths, payload.noFlyZones, header('x-codesite-blocked-paths'))),
    allowedTools: parsePatternList(value(payload.allowedTools, header('x-codesite-allowed-tools'))),
    evidenceRefs: parsePatternList(value(payload.evidenceRefs, header('x-codesite-evidence-refs'))),
    processAncestry,
    controlPlaneUrl: value(payload.controlPlaneUrl, payload.control_plane_url, header('x-codesite-control-plane-url')),
    authToken: value(payload.authToken, payload.auth_token, header('x-codesite-token')),
    cookie: value(payload.cookie, header('cookie')),
  };
  context.active = Boolean(
    context.transactionId ||
    context.mutationLeaseId ||
    context.agentSessionId ||
    context.managedAgent ||
    context.allowedPaths.length ||
    context.blockedPaths.length ||
    required ||
    explicitMode ||
    hasCodeSitePayload ||
    Object.keys(payload).length > 0,
  );
  return context;
}

function hasManagedAgentSignal({ agentSessionId, agentProvider, agentRuntime, processAncestry, data = {}, header = () => undefined }) {
  if (agentSessionId || agentProvider || agentRuntime) return true;
  if (value(data.agentId, data.agent_id, data.synthiAgentId, data.synthi_agent_id, header('x-agent-id'), header('x-synthi-agent-id'))) {
    return true;
  }
  if (value(data.workflowAgentId, data.workflow_agent_id, header('x-synthi-workflow-agent-id'))) {
    return true;
  }
  return asArray(processAncestry).some((entry) => {
    const item = String(entry || '').toLowerCase();
    return item.includes('agent')
      || item.includes('codex')
      || item.includes('browser-workflow')
      || item.includes('synthi_codesite')
      || item.startsWith('mcp:');
  });
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
    ['CodeSite-Clearance', value(payload.mutationLeaseId, payload.mutation_lease_id, payload.leaseId, payload.clearance, proof.mutationLeaseId)],
    ['CodeSite-Transaction', value(payload.transactionId, payload.transaction_id, proof.transactionId)],
    ['CodeSite-Lease', value(payload.mutationLeaseId, payload.mutation_lease_id, payload.leaseId, payload.clearance, proof.mutationLeaseId)],
    ['CodeSite-Read-Set', value(payload.readSetDigest, payload.read_set_digest, proof.readSetDigest)],
    ['CodeSite-Write-Set', value(payload.writeSetDigest, payload.write_set_digest, proof.writeSetDigest)],
    ['CodeSite-Invariants', Array.isArray(invariants) ? invariants.join(',') : invariants],
    ['CodeSite-Landing', value(payload.landingStatus, payload.landing_status, payload.landing)],
    ['CodeSite-Black-Box', blackBox],
    ['CodeSite-Proof-Digest', value(payload.proofDigest, payload.proof_digest, proof.portableDigest, proof.proofDigest, proof.proof_digest)],
    ['CodeSite-Proof-Authority', value(payload.proofAuthority, payload.proof_authority, proof.proofSignature?.keyId, proof.proofSignature?.key_id)],
    ['CodeSite-Proof-Signature', value(payload.proofSignatureValue, payload.proof_signature_value, proof.proofSignature?.signature, proof.proofSignature?.value)],
  ].filter(([, trailerValue]) => trailerValue !== undefined && trailerValue !== null && trailerValue !== '');
}

function codeSiteRuntimeEnv(context = {}, extra = {}) {
  if (!context?.active) return {};
  const ancestry = [
    ...asArray(context.processAncestry),
    ...asArray(extra.processAncestry),
  ].filter(Boolean);
  const env = {
    CODESITE_ACTIVE: '1',
    SYNTHI_CODESITE_ACTIVE: '1',
  };
  setEnv(env, 'CODESITE_WORKSPACE_SLUG', context.workspaceSlug);
  setEnv(env, 'SYNTHI_CODESITE_WORKSPACE', context.workspaceSlug);
  setEnv(env, 'CODESITE_TRANSACTION_ID', context.transactionId);
  setEnv(env, 'SYNTHI_CODESITE_TRANSACTION_ID', context.transactionId);
  setEnv(env, 'CODESITE_MUTATION_LEASE_ID', context.mutationLeaseId);
  setEnv(env, 'SYNTHI_CODESITE_MUTATION_LEASE_ID', context.mutationLeaseId);
  setEnv(env, 'CODESITE_CALLSIGN', context.displayCallsign);
  setEnv(env, 'SYNTHI_CODESITE_CALLSIGN', context.displayCallsign);
  setEnv(env, 'CODESITE_ACTOR_USER_ID', context.actorUserId);
  setEnv(env, 'CODESITE_EFFECTIVE_USER_ID', context.effectiveUserId);
  setEnv(env, 'CODESITE_AGENT_SESSION_ID', context.agentSessionId);
  setEnv(env, 'CODESITE_AGENT_PROVIDER', context.agentProvider);
  setEnv(env, 'CODESITE_AGENT_RUNTIME', context.agentRuntime);
  setEnv(env, 'CODESITE_ALLOWED_PATHS', jsonEnv(context.allowedPaths));
  setEnv(env, 'CODESITE_BLOCKED_PATHS', jsonEnv(context.blockedPaths));
  setEnv(env, 'CODESITE_ALLOWED_TOOLS', jsonEnv(context.allowedTools));
  setEnv(env, 'CODESITE_EVIDENCE_REFS', jsonEnv(context.evidenceRefs));
  setEnv(env, 'CODESITE_PROCESS_ANCESTRY', jsonEnv(ancestry));
  setEnv(env, 'SYNTHI_CODESITE_API_BASE_URL', resolveControlPlaneBaseUrl(context));
  return env;
}

function codeSiteRuntimeMetadata(context = {}) {
  if (!context?.active) return null;
  return {
    active: true,
    workspaceSlug: context.workspaceSlug || null,
    transactionId: context.transactionId || null,
    mutationLeaseId: context.mutationLeaseId || null,
    displayCallsign: context.displayCallsign || null,
    agentSessionId: context.agentSessionId || null,
    agentProvider: context.agentProvider || null,
    agentRuntime: context.agentRuntime || null,
    managedAgent: Boolean(context.managedAgent),
    allowedPaths: context.allowedPaths || [],
    blockedPaths: context.blockedPaths || [],
    allowedTools: context.allowedTools || [],
    evidenceRefs: context.evidenceRefs || [],
    processAncestry: context.processAncestry || [],
  };
}

function setEnv(env, key, envValue) {
  if (envValue === undefined || envValue === null || envValue === '') return;
  env[key] = String(envValue);
}

function jsonEnv(envValue) {
  const values = asArray(envValue);
  return values.length ? JSON.stringify(values) : '';
}

function value(...values) {
  return values.find((item) => item !== undefined && item !== null && item !== '');
}

function truthy(input) {
  if (input === true || input === 1) return true;
  if (typeof input !== 'string') return false;
  return ['1', 'true', 'yes', 'on', 'enforce', 'required'].includes(input.trim().toLowerCase());
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

class CodeSiteFS {
  constructor(context = {}, options = {}) {
    this.context = context || {};
    this.options = options || {};
  }

  async prepare(attempt = {}) {
    const effectiveContext = await authoritativeCodeSiteContext(this.context, this.options);
    const result = evaluateCodeSiteWrite(effectiveContext, attempt);
    const durableFailure = evaluateCodeSiteDurableContext(effectiveContext, this.options);
    let pathResolution = null;
    let pathFailure = null;
    if (this.options.repoRoot && result.path) {
      try {
        pathResolution = await resolveCodeSiteRepoPath(this.options.repoRoot, result.path);
      } catch (error) {
        pathFailure = error;
      }
    }
    const durableResult = durableFailure
      ? deniedWithDurableFailure(result, durableFailure)
      : result;
    const preparedResult = pathFailure
      ? deniedWithPathFailure(durableResult, pathFailure)
      : durableResult;
    const prepared = {
      phase: 'prepared',
      ok: preparedResult.ok,
      disposition: preparedResult.event.type,
      path: preparedResult.path,
      tool: preparedResult.tool,
      context: effectiveContext,
      attempt,
      result: preparedResult,
      event: preparedResult.event,
      durableFailure,
      pathResolution,
      pathFailure,
    };
    prepared.rollbackHint = this.rollbackHint(prepared);
    return prepared;
  }

  async validate(preparedOrAttempt = {}) {
    const prepared = isCodeSiteFSPrepared(preparedOrAttempt)
      ? preparedOrAttempt
      : await this.prepare(preparedOrAttempt);
    if (!prepared.ok && prepared.context?.mode !== 'monitor') {
      throw new CodeSiteFSDeniedError(prepared.event);
    }
    return { ...prepared, phase: 'validated' };
  }

  async emitEvent(preparedOrAttempt = {}, options = {}) {
    const prepared = isCodeSiteFSPrepared(preparedOrAttempt)
      ? preparedOrAttempt
      : await this.prepare(preparedOrAttempt);
    if (!prepared.context?.active || !prepared.context.transactionId) {
      return { ...prepared, phase: 'event_skipped', eventRecord: null };
    }
    const emitOptions = {
      ...this.options,
      ...options,
      acceptDenied: options.acceptDenied ?? !prepared.ok,
    };
    try {
      const eventRecord = await recordCodeSiteWriteAttempt(prepared.context, prepared.result, emitOptions);
      return { ...prepared, phase: 'event_emitted', eventRecord };
    } catch (error) {
      if (prepared.ok) throw error;
      prepared.event.details.persistence_error = error?.message || 'codesite_denied_write_persistence_failed';
      return {
        ...prepared,
        phase: 'event_failed',
        eventRecord: null,
        eventRecordError: error?.message || 'codesite_denied_write_persistence_failed',
      };
    }
  }

  async prepareRead(attempt = {}) {
    const effectiveContext = await authoritativeCodeSiteReadContext(this.context, this.options);
    const result = evaluateCodeSiteRead(effectiveContext, attempt);
    const durableFailure = evaluateCodeSiteDurableContext(effectiveContext, this.options);
    let pathResolution = null;
    let pathFailure = null;
    if (this.options.repoRoot && result.path) {
      try {
        pathResolution = await resolveCodeSiteRepoPath(this.options.repoRoot, result.path);
      } catch (error) {
        pathFailure = error;
      }
    }
    const durableResult = durableFailure
      ? deniedWithDurableFailure(result, durableFailure)
      : result;
    const preparedResult = pathFailure
      ? deniedWithPathFailure(durableResult, pathFailure)
      : durableResult;
    return {
      phase: 'read_prepared',
      ok: preparedResult.ok,
      disposition: preparedResult.event.type,
      path: preparedResult.path,
      tool: preparedResult.tool,
      context: effectiveContext,
      attempt,
      result: preparedResult,
      event: preparedResult.event,
      durableFailure,
      pathResolution,
      pathFailure,
    };
  }

  async emitReadEvent(preparedOrAttempt = {}, options = {}) {
    const prepared = isCodeSiteFSPrepared(preparedOrAttempt)
      ? preparedOrAttempt
      : await this.prepareRead(preparedOrAttempt);
    if (!prepared.context?.active || !prepared.context.transactionId) {
      return { ...prepared, phase: 'read_event_skipped', eventRecord: null };
    }
    const emitOptions = {
      ...this.options,
      ...options,
      acceptDenied: options.acceptDenied ?? !prepared.ok,
    };
    try {
      const eventRecord = await recordCodeSiteReadAttempt(prepared.context, prepared.result, emitOptions);
      return { ...prepared, phase: 'read_event_emitted', eventRecord };
    } catch (error) {
      if (prepared.ok) throw error;
      prepared.event.details.persistence_error = error?.message || 'codesite_denied_read_persistence_failed';
      return {
        ...prepared,
        phase: 'read_event_failed',
        eventRecord: null,
        eventRecordError: error?.message || 'codesite_denied_read_persistence_failed',
      };
    }
  }

  async read(preparedOrAttempt = {}, readFn = null, options = {}) {
    const prepared = isCodeSiteFSPrepared(preparedOrAttempt)
      ? preparedOrAttempt
      : await this.prepareRead(preparedOrAttempt);
    if (!prepared.ok) {
      await this.emitReadEvent(prepared, { ...options, acceptDenied: true });
      if (prepared.context?.mode !== 'monitor') {
        throw new CodeSiteFSDeniedError(prepared.event);
      }
    }
    const emitted = await this.emitReadEvent(prepared, options);
    const readResult = typeof readFn === 'function'
      ? await readFn(emitted)
      : null;
    const verification = await this.verify(emitted, options);
    return {
      ...emitted,
      phase: 'read',
      readResult,
      verification,
    };
  }

  async apply(preparedOrAttempt = {}, applyFn = null, options = {}) {
    const prepared = isCodeSiteFSPrepared(preparedOrAttempt)
      ? preparedOrAttempt
      : await this.prepare(preparedOrAttempt);
    if (!prepared.ok) {
      await this.emitEvent(prepared, { ...options, acceptDenied: true });
      await this.validate(prepared);
    }
    const validated = await this.validate(prepared);
    const emitted = await this.emitEvent(validated, options);
    const applyResult = typeof applyFn === 'function'
      ? await applyFn(emitted)
      : null;
    const verification = await this.verify(emitted, options);
    return {
      ...emitted,
      phase: 'applied',
      applyResult,
      verification,
    };
  }

  async run(operation = {}, applyFn = null, options = {}) {
    const attempts = codeSiteFSOperationAttempts(operation);
    if (!attempts.length) {
      if (this.context?.active && this.context?.mode !== 'monitor') {
        const effectiveContext = await authoritativeCodeSiteContext(this.context, this.options);
        const durableFailure = evaluateCodeSiteDurableContext(effectiveContext, this.options);
        const reasonCodes = unique([
          'codesite_write_attempt_required',
          ...asArray(durableFailure?.reasonCodes),
        ]);
        const event = buildEvent(
          effectiveContext,
          {
            kind: operation.kind || operation.operation || 'write',
            tool: operation.tool || 'file_write',
            evidenceRefs: operation.evidenceRefs || operation.evidence_refs,
            processAncestry: operation.processAncestry || operation.process_ancestry,
          },
          null,
          'write_denied',
          reasonCodes,
          'CodeSiteFS refused to apply an active operation with no normalized write attempts.',
        );
        throw new CodeSiteFSDeniedError(event);
      }
      const applyResult = typeof applyFn === 'function'
        ? await applyFn({ operation, attempts: [] })
        : null;
      return {
        phase: 'applied',
        operation,
        attempts: [],
        applyResult,
        verification: [],
        rollbackHints: [],
      };
    }

    const prepared = [];
    for (const attempt of attempts) {
      prepared.push(await this.prepare(attempt));
    }

    const denied = prepared.find((item) => !item.ok);
    if (denied) {
      await this.emitEvent(denied, { ...options, acceptDenied: true });
      await this.validate(denied);
    }

    const validated = [];
    for (const item of prepared) {
      validated.push(await this.validate(item));
    }

    const emitted = [];
    for (const item of validated) {
      emitted.push(await this.emitEvent(item, options));
    }

    const applyResult = typeof applyFn === 'function'
      ? await applyFn({ operation, attempts: emitted })
      : null;
    const verification = [];
    for (const item of emitted) {
      verification.push(await this.verify(item, options));
    }
    return {
      phase: 'applied',
      operation,
      attempts: emitted,
      applyResult,
      verification,
      rollbackHints: emitted.map((item) => this.rollbackHint(item)),
    };
  }

  async verify(preparedOrAttempt = {}, options = {}) {
    const prepared = isCodeSiteFSPrepared(preparedOrAttempt)
      ? preparedOrAttempt
      : await this.prepare(preparedOrAttempt);
    const repoRoot = options.repoRoot || this.options.repoRoot;
    if (!repoRoot || !prepared.path) {
      return {
        ok: true,
        skipped: true,
        reason: repoRoot ? 'path_unavailable' : 'repo_root_unavailable',
      };
    }
    try {
      const digest = await fileDigestForRepoPath(repoRoot, prepared.path);
      return {
        ok: true,
        skipped: false,
        path: prepared.path,
        digest,
      };
    } catch (error) {
      return {
        ok: false,
        skipped: false,
        path: prepared.path,
        error: error?.message || 'codesitefs_verify_failed',
      };
    }
  }

  rollbackHint(preparedOrResult = {}) {
    const result = preparedOrResult.result || preparedOrResult;
    const event = preparedOrResult.event || result.event || {};
    const eventType = event.type || preparedOrResult.disposition || result.disposition || 'write_allowed';
    const pathHint = result.path || event.path || preparedOrResult.path || null;
    if (eventType === 'write_denied') {
      return {
        strategy: 'no_repo_mutation',
        path: pathHint,
        reasonCodes: asArray(event.details?.reason_codes),
        instruction: 'The write was blocked before the real repo changed. Request or adjust clearance before retrying.',
      };
    }
    if (eventType === 'write_quarantined') {
      return {
        strategy: 'review_quarantine',
        path: pathHint,
        quarantineRoot: event.details?.quarantine_root || null,
        instruction: 'Review the quarantined overlay and replay through an approved transaction before landing.',
      };
    }
    return {
      strategy: 'transaction_abort_or_revert',
      path: pathHint,
      transactionId: event.transaction_id || preparedOrResult.context?.transactionId || null,
      instruction: 'If verification fails, abort the transaction or revert this path before commit.',
    };
  }
}

function createCodeSiteFS(context = {}, options = {}) {
  return new CodeSiteFS(context, options);
}

function isCodeSiteFSPrepared(value) {
  return Boolean(value && typeof value === 'object' && value.phase && value.result && value.event);
}

function codeSiteFSOperationAttempts(operation = {}) {
  const operationBase = {
    kind: operation.operation || operation.kind,
    tool: operation.tool,
    evidenceRefs: operation.evidenceRefs || operation.evidence_refs,
    processAncestry: operation.processAncestry || operation.process_ancestry,
    lineProvenance: operation.lineProvenance || operation.line_provenance,
  };
  if (Array.isArray(operation.attempts)) {
    return operation.attempts.map((attempt) => ({
      ...operationBase,
      ...attempt,
      kind: attempt.kind || operationBase.kind,
      tool: attempt.tool || operationBase.tool,
    }));
  }
  const pathValue = operation.path || operation.filePath || operation.newPath || operation.oldPath;
  if (!pathValue) return [];
  return [{
    ...operationBase,
    path: pathValue,
  }];
}

function deniedWithDurableFailure(result, durableFailure) {
  const deniedType = String(result.event?.type || '').startsWith('read') ? 'read_denied' : 'write_denied';
  return {
    ...result,
    ok: false,
    event: {
      ...result.event,
      type: deniedType,
      details: {
        ...result.event.details,
        reason: `CodeSite filesystem access requires durable control-plane context: ${durableFailure.reasonCodes.join(',')}`,
        reason_codes: [
          ...durableFailure.reasonCodes,
          ...asArray(result.event.details?.reason_codes),
        ],
      },
    },
  };
}

function deniedWithPathFailure(result, pathFailure) {
  const reasonCode = pathFailure?.code || 'repo_path_containment_failed';
  const deniedType = String(result.event?.type || '').startsWith('read') ? 'read_denied' : 'write_denied';
  return {
    ...result,
    ok: false,
    event: {
      ...result.event,
      type: deniedType,
      details: {
        ...result.event.details,
        reason: pathFailure?.message || 'CodeSiteFS path failed containment validation',
        reason_codes: unique([
          reasonCode,
          ...asArray(result.event.details?.reason_codes).filter((code) => code !== 'inside_clearance_route'),
        ]),
      },
    },
  };
}

async function enforceCodeSiteWriteAllowed(context, attempt, options = {}) {
  const codesiteFs = createCodeSiteFS(context, options);
  const prepared = await codesiteFs.prepare(attempt);
  if (prepared.durableFailure && prepared.context?.mode !== 'monitor') {
    throw new CodeSiteFSDeniedError(prepared.event);
  }
  const emitted = await codesiteFs.emitEvent(prepared, {
    acceptDenied: options.acceptDenied || !prepared.ok || prepared.context?.mode === 'monitor',
  });
  if (!emitted.ok && emitted.context?.mode !== 'monitor') {
    throw new CodeSiteFSDeniedError(emitted.event);
  }
  return emitted.result;
}

async function enforceCodeSiteWritesAllowed(context, attempts, options = {}) {
  const results = [];
  for (const attempt of attempts) {
    results.push(await enforceCodeSiteWriteAllowed(context, attempt, options));
  }
  return results;
}

function evaluateCodeSiteDurableContext(context, options = {}) {
  if (!context?.active || context.mode === 'monitor') return null;
  const reasonCodes = [];
  reasonCodes.push(...asArray(context.hydrationFailure?.reasonCodes));
  if (!context.transactionId) reasonCodes.push('codesite_transaction_required');
  if (!resolveControlPlaneBaseUrl(context)) reasonCodes.push('codesite_control_plane_url_required');
  if (typeof (options.fetch || global.fetch) !== 'function') reasonCodes.push('codesite_control_plane_fetch_unavailable');
  if (requiresAuthoritativeContext(context, options) && !context.authoritative) {
    reasonCodes.push('codesite_authoritative_context_required');
  }
  return reasonCodes.length ? { reasonCodes } : null;
}

async function authoritativeCodeSiteContext(context, options = {}) {
  if (!requiresAuthoritativeContext(context, options) || context?.mode === 'monitor') {
    return context;
  }
  const base = { ...(context || {}), active: true, mode: context?.mode || 'enforce' };
  if (options.requireAuthoritativeContext && !context?.active) {
    return withHydrationFailure(base, ['codesite_context_required']);
  }
  if (!base.transactionId) {
    return withHydrationFailure(base, ['codesite_transaction_required']);
  }
  const fetchImpl = options.fetch || global.fetch;
  const baseUrl = resolveControlPlaneBaseUrl(base);
  const reasonCodes = [];
  if (!baseUrl) reasonCodes.push('codesite_control_plane_url_required');
  if (typeof fetchImpl !== 'function') reasonCodes.push('codesite_control_plane_fetch_unavailable');
  if (reasonCodes.length) return withHydrationFailure(base, reasonCodes);

  try {
    const transaction = await loadCodeSiteTransaction(base, {
      fetch: fetchImpl,
      baseUrl,
      headers: codeSiteControlPlaneHeaders(base),
    });
    if (!transaction) return withHydrationFailure(base, ['codesite_transaction_not_found']);
    if (!isWritableTransactionStatus(transaction.status)) {
      return withHydrationFailure(base, ['codesite_transaction_not_open'], { transactionStatus: transaction.status });
    }
    const allowedPaths = parsePatternList([
      ...asArray(transaction.writeSet),
      ...asArray(transaction.observedWriteSet),
    ]);
    if (allowedPaths.length === 0) {
      return withHydrationFailure(base, ['codesite_transaction_write_set_required'], { transactionStatus: transaction.status });
    }
    return {
      ...base,
      authoritative: true,
      authoritativeSource: 'control_plane_transaction',
      authoritativeTransactionStatus: transaction.status || null,
      mutationLeaseId: transaction.mutationLeaseId || base.mutationLeaseId || null,
      agentSessionId: transaction.agentSessionId || base.agentSessionId || null,
      allowedPaths,
      blockedPaths: [],
    };
  } catch (error) {
    return withHydrationFailure(base, ['codesite_transaction_load_failed'], { error: error?.message || String(error) });
  }
}

async function authoritativeCodeSiteReadContext(context, options = {}) {
  if (!requiresAuthoritativeContext(context, options) || context?.mode === 'monitor') {
    return context;
  }
  const base = { ...(context || {}), active: true, mode: context?.mode || 'enforce' };
  if (options.requireAuthoritativeContext && !context?.active) {
    return withHydrationFailure(base, ['codesite_context_required']);
  }
  if (!base.transactionId) {
    return withHydrationFailure(base, ['codesite_transaction_required']);
  }
  const fetchImpl = options.fetch || global.fetch;
  const baseUrl = resolveControlPlaneBaseUrl(base);
  const reasonCodes = [];
  if (!baseUrl) reasonCodes.push('codesite_control_plane_url_required');
  if (typeof fetchImpl !== 'function') reasonCodes.push('codesite_control_plane_fetch_unavailable');
  if (reasonCodes.length) return withHydrationFailure(base, reasonCodes);

  try {
    const transaction = await loadCodeSiteTransaction(base, {
      fetch: fetchImpl,
      baseUrl,
      headers: codeSiteControlPlaneHeaders(base),
    });
    if (!transaction) return withHydrationFailure(base, ['codesite_transaction_not_found']);
    if (!isWritableTransactionStatus(transaction.status)) {
      return withHydrationFailure(base, ['codesite_transaction_not_open'], { transactionStatus: transaction.status });
    }
    return {
      ...base,
      authoritative: true,
      authoritativeSource: 'control_plane_transaction_read',
      authoritativeTransactionStatus: transaction.status || null,
      mutationLeaseId: transaction.mutationLeaseId || base.mutationLeaseId || null,
      agentSessionId: transaction.agentSessionId || base.agentSessionId || null,
      blockedPaths: parsePatternList(base.blockedPaths),
    };
  } catch (error) {
    return withHydrationFailure(base, ['codesite_transaction_load_failed'], { error: error?.message || String(error) });
  }
}

function requiresAuthoritativeContext(context = {}, options = {}) {
  return Boolean(options.requireAuthoritativeContext || context.required || context.managedAgent);
}

function withHydrationFailure(context, reasonCodes, extra = {}) {
  return {
    ...context,
    active: true,
    authoritative: false,
    hydrationFailure: {
      reasonCodes: unique(reasonCodes),
      ...extra,
    },
  };
}

function isWritableTransactionStatus(status) {
  return ['open'].includes(String(status || '').toLowerCase());
}

function codeSiteControlPlaneHeaders(context) {
  const headers = { accept: 'application/json' };
  const token = context.authToken || process.env.SYNTHI_CODESITE_TOKEN;
  const cookie = context.cookie || process.env.SYNTHI_CODESITE_COOKIE;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  return headers;
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
      evidenceRefs: unique([
        ...asArray(context.evidenceRefs),
        ...asArray(result.event.evidence_refs || result.event.evidenceRefs),
      ]),
      processAncestry: unique([
        ...asArray(context.processAncestry),
        ...asArray(result.event.details?.process_ancestry || result.event.details?.processAncestry),
      ]),
      lineProvenance: result.event.details?.lineProvenance || result.event.details?.line_provenance || [],
      codesiteFsEvent: result.event,
    }),
  });
  const body = await readJsonBody(response);
  if ((!response.ok || body?.ok === false) && !(options.acceptDenied && body?.ok === false)) {
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

async function recordCodeSiteReadAttempt(context, result, options = {}) {
  if (!context?.active || !context.transactionId) return null;
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('codesite_control_plane_fetch_unavailable');
  }
  const baseUrl = resolveControlPlaneBaseUrl(context);
  if (!baseUrl) {
    throw new Error('codesite_control_plane_url_required');
  }
  const url = `${baseUrl}/transactions/${encodeURIComponent(context.transactionId)}/record-read`;
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
      evidenceRefs: unique([
        ...asArray(context.evidenceRefs),
        ...asArray(result.event.evidence_refs || result.event.evidenceRefs),
      ]),
      processAncestry: unique([
        ...asArray(context.processAncestry),
        ...asArray(result.event.details?.process_ancestry || result.event.details?.processAncestry),
      ]),
      codesiteFsEvent: result.event,
    }),
  });
  const body = await readJsonBody(response);
  if ((!response.ok || body?.ok === false) && !(options.acceptDenied && body?.ok === false)) {
    throw new CodeSiteFSDeniedError({
      ...result.event,
      type: 'read_denied',
      details: {
        ...result.event.details,
        reason: 'codesite_control_plane_denied_read',
        reason_codes: [
          'control_plane_denied_read',
          ...asArray(body?.policyDecision?.reasonCodes || body?.decision?.reasonCodes),
        ],
        control_plane_status: response.status,
        control_plane_response: body,
      },
    });
  }
  return body;
}

async function completeCodeSiteCommitProof(context, data = {}, options = {}) {
  if (!context?.active || !context.transactionId) return null;
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw new Error('codesite_control_plane_fetch_unavailable');
  }
  const baseUrl = resolveControlPlaneBaseUrl(context);
  if (!baseUrl) {
    throw new Error('codesite_control_plane_url_required');
  }
  const url = `${baseUrl}/transactions/${encodeURIComponent(context.transactionId)}/commit`;
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
  };
  const token = context.authToken || process.env.SYNTHI_CODESITE_TOKEN;
  const cookie = context.cookie || process.env.SYNTHI_CODESITE_COOKIE;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  const codesite = data.codesite || data.codeSite || {};
  const repoState = value(
    data.repoState,
    data.repo_state,
    codesite.repoState,
    codesite.repo_state,
    options.repoState,
    options.repo_state,
  ) || await collectRepoStateForCommit(context, {
    fetch: fetchImpl,
    baseUrl,
    headers,
    repoRoot: options.repoRoot,
  });
  const response = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      evidenceRefs: value(data.evidenceRefs, data.evidence_refs, codesite.evidenceRefs, codesite.evidence_refs, []),
      dojoEvidenceRefs: value(data.dojoEvidenceRefs, data.dojo_evidence_refs, codesite.dojoEvidenceRefs, codesite.dojo_evidence_refs, []),
      repoState,
      incidentReplayDigest: value(data.incidentReplayDigest, data.incident_replay_digest, codesite.incidentReplayDigest, codesite.incident_replay_digest),
      commitSha: value(data.commitSha, data.commit_sha, codesite.commitSha, codesite.commit_sha),
    }),
  });
  const body = await readJsonBody(response);
  if (!response.ok) {
    throw new CodeSiteCommitBlockedError('codesite_commit_proof_failed', {
      status: response.status,
      response: body,
    });
  }
  if (body?.decision && body.decision.ok === false) {
    throw new CodeSiteCommitBlockedError('codesite_transaction_not_committable', body.decision);
  }
  if (!body?.proofBundle) {
    throw new CodeSiteCommitBlockedError('codesite_proof_bundle_missing', body);
  }
  return body;
}

async function collectRepoStateForCommit(context, options = {}) {
  if (!options.repoRoot) return null;
  const transaction = await loadCodeSiteTransaction(context, options);
  const writePaths = [
    ...asArray(transaction?.writeSet),
    ...asArray(transaction?.observedWriteSet),
  ];
  return collectCodeSiteRepoState(options.repoRoot, {
    workspaceSlug: context.workspaceSlug,
    transactionId: context.transactionId,
    baseSnapshot: transaction?.baseSnapshot || null,
    writePaths,
    env: options.gitEnv || options.env,
  });
}

async function loadCodeSiteTransaction(context, options = {}) {
  if (!context?.transactionId || !options.baseUrl || typeof options.fetch !== 'function') return null;
  const response = await options.fetch(`${options.baseUrl}/transactions/${encodeURIComponent(context.transactionId)}`, {
    method: 'GET',
    headers: options.headers || { accept: 'application/json' },
  });
  if (!response.ok) return null;
  const body = await readJsonBody(response);
  return body?.transaction || null;
}

async function collectCodeSiteRepoState(repoRoot, input = {}) {
  const root = path.resolve(repoRoot);
  const writePaths = [...new Set(asArray(input.writePaths).map(cleanPattern).filter(Boolean))];
  const exactPaths = writePaths.filter((item) => !item.includes('*'));
  const [gitHead, stagedDiff, worktreeDiff, writeFileDigests] = await Promise.all([
    gitOutput(root, ['rev-parse', 'HEAD'], input.env),
    gitOutput(root, ['diff', '--cached', '--binary', '--', ...exactPaths], input.env),
    gitOutput(root, ['diff', '--binary', '--', ...exactPaths], input.env),
    Promise.all(exactPaths.map((relPath) => fileDigestForRepoPath(root, relPath))),
  ]);
  const evidence = {
    schemaVersion: 'synthi.codesite.repoStateEvidence.v1',
    workspaceSlug: input.workspaceSlug || null,
    transactionId: input.transactionId || null,
    baseSnapshot: input.baseSnapshot || null,
    gitHead: gitHead || null,
    stagedDiffDigest: digestBuffer(Buffer.from(stagedDiff || '')),
    worktreeDiffDigest: digestBuffer(Buffer.from(worktreeDiff || '')),
    writeFileDigests,
    generatedAt: new Date().toISOString(),
    source: 'collab-server',
  };
  evidence.evidenceDigest = digestJson(evidence);
  return evidence;
}

async function gitOutput(repoRoot, args, env) {
  try {
    const result = await execFileAsync('git', ['-C', repoRoot, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
      env,
    });
    return String(result.stdout || '').trimEnd();
  } catch (_) {
    return '';
  }
}

async function fileDigestForRepoPath(repoRoot, relPath) {
  const resolved = await resolveCodeSiteRepoPath(repoRoot, relPath);
  if (!resolved.exists) {
    return {
      path: resolved.path,
      digest: null,
      size: null,
      exists: false,
    };
  }
  if (resolved.kind === 'directory') {
    return {
      path: resolved.path,
      digest: null,
      size: null,
      exists: true,
      kind: 'directory',
    };
  }
  const stat = await fsp.stat(resolved.realPath || resolved.absolutePath);
  return {
    path: resolved.path,
    digest: await digestFile(resolved.realPath || resolved.absolutePath),
    size: stat.size,
    exists: true,
  };
}

async function createCodeSiteQuarantineWorkspace(context, cwd, options = {}) {
  if (!context?.active || !context.transactionId || !cwd) return null;
  const baseDir = options.baseDir || DEFAULT_QUARANTINE_BASE_DIR;
  const quarantineId = options.quarantineId || `qtn-${safeSegment(context.transactionId)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const root = path.join(
    baseDir,
    safeSegment(context.workspaceSlug || 'workspace'),
    safeSegment(context.transactionId),
    quarantineId,
  );
  await fsp.mkdir(root, { recursive: true });
  await fsp.cp(cwd, root, {
    recursive: true,
    dereference: false,
    filter: (src) => !shouldSkipQuarantinePath(src, cwd),
  });
  const symlinkSanitization = await sanitizeCodeSiteQuarantineSymlinks(root);
  const quarantine = {
    quarantineId,
    cwd: root,
    originalCwd: cwd,
    root,
    baseDir,
    manifestPath: codeSiteQuarantineManifestPath(baseDir, context.workspaceSlug, quarantineId),
    operation: options.operation || 'raw_terminal',
    symlinkSanitization,
    before: await snapshotTree(root),
  };
  await writeCodeSiteQuarantineManifest(quarantine, {
    schemaVersion: QUARANTINE_MANIFEST_SCHEMA_VERSION,
    quarantineId,
    workspaceSlug: context.workspaceSlug || null,
    transactionId: context.transactionId || null,
    mutationLeaseId: context.mutationLeaseId || null,
    displayCallsign: context.displayCallsign || null,
    actorUserId: context.actorUserId || null,
    effectiveUserId: context.effectiveUserId || null,
    operation: quarantine.operation,
    status: 'open',
    root,
    originalCwd: cwd,
    createdAt: new Date().toISOString(),
    finalizedAt: null,
    cleanup: null,
    changes: [],
    recorded: [],
    symlinkSanitization,
    evidenceRefs: asArray(context.evidenceRefs),
    processAncestry: asArray(context.processAncestry),
  });
  return quarantine;
}

async function createCodeSiteOverlayWorkspace(context, cwd, options = {}) {
  if (!context?.active || !context.transactionId || !cwd) return null;
  const baseDir = options.baseDir || DEFAULT_QUARANTINE_BASE_DIR;
  const overlayId = options.overlayId || `ovl-${safeSegment(context.transactionId)}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const root = path.join(
    baseDir,
    safeSegment(context.workspaceSlug || 'workspace'),
    safeSegment(context.transactionId),
    overlayId,
  );
  const upperRoot = path.join(root, 'upper');
  const workRoot = path.join(root, 'work');
  const mergedRoot = path.join(root, 'workspace');
  await fsp.mkdir(upperRoot, { recursive: true });
  await fsp.mkdir(workRoot, { recursive: true });
  await fsp.mkdir(mergedRoot, { recursive: true });
  const overlay = {
    quarantineId: overlayId,
    overlayId,
    mountMode: 'docker-overlay',
    cwd: mergedRoot,
    originalCwd: cwd,
    baseRoot: cwd,
    upperRoot,
    workRoot,
    root,
    baseDir,
    manifestPath: codeSiteQuarantineManifestPath(baseDir, context.workspaceSlug, overlayId),
    operation: options.operation || 'managed-runtime',
    symlinkSanitization: { sanitized: [], preserved: [] },
    before: await snapshotTree(cwd),
  };
  await writeCodeSiteQuarantineManifest(overlay, {
    schemaVersion: QUARANTINE_MANIFEST_SCHEMA_VERSION,
    quarantineId: overlayId,
    overlayId,
    mountMode: 'docker-overlay',
    workspaceSlug: context.workspaceSlug || null,
    transactionId: context.transactionId || null,
    mutationLeaseId: context.mutationLeaseId || null,
    displayCallsign: context.displayCallsign || null,
    actorUserId: context.actorUserId || null,
    effectiveUserId: context.effectiveUserId || null,
    operation: overlay.operation,
    status: 'open',
    root,
    originalCwd: cwd,
    baseRoot: cwd,
    upperRoot,
    workRoot,
    mergedRoot,
    createdAt: new Date().toISOString(),
    finalizedAt: null,
    cleanup: null,
    changes: [],
    recorded: [],
    symlinkSanitization: overlay.symlinkSanitization,
    evidenceRefs: asArray(context.evidenceRefs),
    processAncestry: asArray(context.processAncestry),
  });
  return overlay;
}

async function sanitizeCodeSiteQuarantineSymlinks(root) {
  const rootRealPath = await fsp.realpath(root).catch(() => path.resolve(root));
  const sanitized = [];
  const preserved = [];

  async function walk(current) {
    let entries = [];
    try {
      entries = await fsp.readdir(current, { withFileTypes: true });
    } catch (_) {
      return;
    }
    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      const relPath = path.relative(root, fullPath).replace(/\\/g, '/');
      if (entry.isSymbolicLink()) {
        let target = '';
        try {
          target = await fsp.readlink(fullPath);
        } catch (_) {
          target = '';
        }
        const lexicalTarget = path.resolve(path.dirname(fullPath), target);
        const realTarget = await fsp.realpath(fullPath).catch(() => null);
        const targetForContainment = realTarget || lexicalTarget;
        if (realTarget && isPathWithin(rootRealPath, realTarget)) {
          preserved.push({ path: relPath, target });
          continue;
        }
        await fsp.rm(fullPath, { force: true }).catch(() => {});
        await fsp.writeFile(
          fullPath,
          [
            'CodeSite quarantine replaced an unsafe symlink before command execution.',
            `path: ${relPath}`,
            `target: ${target}`,
            `resolvedTarget: ${targetForContainment}`,
            '',
          ].join('\n'),
          'utf8',
        );
        sanitized.push({
          path: relPath,
          target,
          resolvedTarget: targetForContainment,
          reason: 'quarantine_symlink_escape_replaced',
        });
        continue;
      }
      if (entry.isDirectory()) {
        await walk(fullPath);
      }
    }
  }

  await walk(root);
  return { sanitized, preserved };
}

function isPathWithin(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function finalizeCodeSiteQuarantineWorkspace(context, quarantine, options = {}) {
  if (!context?.active || !quarantine?.root) return { changes: [], recorded: [] };
  const after = quarantine.mountMode === 'docker-overlay'
    ? await snapshotCodeSiteOverlayView(quarantine)
    : await snapshotTree(quarantine.root);
  const changes = diffSnapshots(quarantine.before || new Map(), after);
  const recorded = [];
  const changesWithEvidence = [];
  for (const change of changes) {
    const beforeEntry = (quarantine.before || new Map()).get(change.path) || null;
    const afterEntry = after.get(change.path) || null;
    const quarantineEvidence = buildQuarantineChangeEvidence(change, beforeEntry, afterEntry);
    quarantineEvidence.quarantineId = quarantine.quarantineId || null;
    const changeWithEvidence = { ...change, quarantineId: quarantine.quarantineId || null, quarantineEvidence };
    changesWithEvidence.push(changeWithEvidence);
    const result = {
      ok: false,
      path: change.path,
      tool: options.tool || 'raw_terminal',
      event: buildEvent(
        context,
        { kind: quarantine.operation || 'raw_terminal', tool: options.tool || 'raw_terminal' },
        change.path,
        'write_quarantined',
        ['raw_terminal_quarantine'],
        `Raw terminal ${change.kind} quarantined for ${change.path}`,
      ),
    };
    result.event.details.quarantine_id = quarantine.quarantineId || null;
    result.event.details.quarantine_root = quarantine.root;
    result.event.details.original_cwd = quarantine.originalCwd;
    result.event.details.change_kind = change.kind;
    result.event.details.quarantine_evidence = quarantineEvidence;
    if (quarantineEvidence.evidenceRef) {
      result.event.evidence_refs = [...new Set([
        ...(Array.isArray(result.event.evidence_refs) ? result.event.evidence_refs : []),
        quarantineEvidence.evidenceRef,
      ])];
    }
    try {
      const response = await recordCodeSiteWriteAttempt(context, result, {
        ...options,
        acceptDenied: true,
      });
      recorded.push({ ...changeWithEvidence, ok: true, response });
    } catch (error) {
      recorded.push({ ...changeWithEvidence, ok: false, error: error?.message || 'record_failed' });
    }
  }
  const previousManifest = await readCodeSiteQuarantineManifestByPath(quarantine.manifestPath).catch(() => null);
  const manifestChanges = [...asArray(previousManifest?.changes), ...changesWithEvidence];
  const manifestRecorded = [...asArray(previousManifest?.recorded), ...recorded];
  if (options.cleanup !== false) {
    await fsp.rm(quarantine.root, { recursive: true, force: true }).catch(() => {});
  }
  if (options.resetBaseline === true && options.cleanup === false) {
    quarantine.before = after;
  }
  if (quarantine.manifestPath) {
    await writeCodeSiteQuarantineManifest(quarantine, {
      ...(previousManifest || {}),
      schemaVersion: QUARANTINE_MANIFEST_SCHEMA_VERSION,
      quarantineId: quarantine.quarantineId || previousManifest?.quarantineId || null,
      workspaceSlug: context.workspaceSlug || previousManifest?.workspaceSlug || null,
      transactionId: context.transactionId || previousManifest?.transactionId || null,
      mutationLeaseId: context.mutationLeaseId || previousManifest?.mutationLeaseId || null,
      displayCallsign: context.displayCallsign || previousManifest?.displayCallsign || null,
      actorUserId: context.actorUserId || previousManifest?.actorUserId || null,
      effectiveUserId: context.effectiveUserId || previousManifest?.effectiveUserId || null,
      operation: quarantine.operation || previousManifest?.operation || 'raw_terminal',
      status: manifestChanges.length ? 'reviewable' : (previousManifest?.status || 'empty'),
      root: quarantine.root,
      originalCwd: quarantine.originalCwd,
      mountMode: quarantine.mountMode || previousManifest?.mountMode || 'copy',
      baseRoot: quarantine.baseRoot || previousManifest?.baseRoot || null,
      upperRoot: quarantine.upperRoot || previousManifest?.upperRoot || null,
      workRoot: quarantine.workRoot || previousManifest?.workRoot || null,
      finalizedAt: new Date().toISOString(),
      cleanup: {
        overlayRemoved: options.cleanup !== false,
        resetBaseline: options.resetBaseline === true,
      },
      symlinkSanitization: quarantine.symlinkSanitization || previousManifest?.symlinkSanitization || { sanitized: [], preserved: [] },
      changes: manifestChanges,
      recorded: manifestRecorded,
      evidenceRefs: unique([
        ...asArray(previousManifest?.evidenceRefs),
        ...asArray(context.evidenceRefs),
        ...manifestChanges.flatMap((item) => [
          item.quarantineEvidence?.evidenceRef,
          ...(asArray(item.quarantineEvidence?.evidenceRefs)),
        ]),
      ]),
      processAncestry: unique([
        ...asArray(previousManifest?.processAncestry),
        ...asArray(context.processAncestry),
      ]),
    });
  }
  return { changes: changesWithEvidence, recorded };
}

async function snapshotCodeSiteOverlayView(quarantine) {
  const before = quarantine.before instanceof Map ? new Map(quarantine.before) : new Map();
  if (!quarantine.upperRoot) return before;
  await applyOverlayUpperSnapshot(quarantine.upperRoot, quarantine.upperRoot, before);
  return before;
}

async function applyOverlayUpperSnapshot(root, current, snapshot) {
  let entries = [];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    const parentRel = path.relative(root, current).replace(/\\/g, '/');
    if (entry.name === '.wh..wh..opq') continue;
    if (entry.name.startsWith('.wh.')) {
      const deletedName = entry.name.slice(4);
      const deletedRel = parentRel ? `${parentRel}/${deletedName}` : deletedName;
      snapshot.delete(deletedRel);
      continue;
    }
    if (shouldSkipQuarantinePath(fullPath, root)) continue;
    if (entry.isDirectory()) {
      await applyOverlayUpperSnapshot(root, fullPath, snapshot);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, fullPath).replace(/\\/g, '/');
    try {
      const stat = await fsp.stat(fullPath);
      const content = stat.size <= MAX_INLINE_SNAPSHOT_BYTES
        ? await fsp.readFile(fullPath)
        : null;
      snapshot.set(rel, {
        size: stat.size,
        digest: content ? digestBuffer(content) : await digestFile(fullPath),
        text: content && stat.size <= MAX_TEXT_DIFF_BYTES && isLikelyText(content)
          ? content.toString('utf8')
          : undefined,
        base64: content && !isLikelyText(content)
          ? content.toString('base64')
          : undefined,
        contentEncoding: content && !isLikelyText(content) ? 'base64' : undefined,
      });
    } catch (_) {}
  }
}

function codeSiteQuarantineManifestPath(baseDir, workspaceSlug, quarantineId) {
  const safeWorkspace = safeSegment(workspaceSlug || 'workspace');
  const safeId = safeSegment(quarantineId || 'unknown');
  return path.join(baseDir || DEFAULT_QUARANTINE_BASE_DIR, safeWorkspace, '_records', `${safeId}.json`);
}

async function writeCodeSiteQuarantineManifest(quarantine, record) {
  if (!quarantine?.manifestPath) return null;
  const next = {
    ...record,
    updatedAt: new Date().toISOString(),
  };
  await fsp.mkdir(path.dirname(quarantine.manifestPath), { recursive: true });
  await fsp.writeFile(quarantine.manifestPath, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
  return next;
}

async function readCodeSiteQuarantineManifestByPath(manifestPath) {
  const text = await fsp.readFile(manifestPath, 'utf8');
  return JSON.parse(text);
}

async function readCodeSiteQuarantineManifest(baseDir, workspaceSlug, quarantineId) {
  return readCodeSiteQuarantineManifestByPath(codeSiteQuarantineManifestPath(baseDir, workspaceSlug, quarantineId));
}

async function listCodeSiteQuarantineManifests(baseDir, workspaceSlug, filters = {}) {
  const dir = path.dirname(codeSiteQuarantineManifestPath(baseDir, workspaceSlug, 'placeholder'));
  let entries = [];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const records = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    try {
      const record = await readCodeSiteQuarantineManifestByPath(path.join(dir, entry.name));
      if (filters.transactionId && record.transactionId !== filters.transactionId) continue;
      if (filters.status && record.status !== filters.status) continue;
      records.push(record);
    } catch (_) {
      // Ignore partial records written by interrupted processes.
    }
  }
  return records.sort((a, b) => String(b.updatedAt || b.finalizedAt || b.createdAt || '')
    .localeCompare(String(a.updatedAt || a.finalizedAt || a.createdAt || '')));
}

function shouldSkipQuarantinePath(src, root) {
  const rel = path.relative(root, src).replace(/\\/g, '/');
  if (!rel) return false;
  const parts = rel.split('/');
  return parts.some((part) => [
    '.git',
    'node_modules',
    '.next',
    'dist',
    'build',
    'coverage',
    '.synthi',
  ].includes(part));
}

async function snapshotTree(root) {
  const snapshot = new Map();
  await walkSnapshot(root, root, snapshot);
  return snapshot;
}

async function walkSnapshot(root, current, snapshot) {
  let entries = [];
  try {
    entries = await fsp.readdir(current, { withFileTypes: true });
  } catch (_) {
    return;
  }
  for (const entry of entries) {
    const fullPath = path.join(current, entry.name);
    if (shouldSkipQuarantinePath(fullPath, root)) continue;
    if (entry.isDirectory()) {
      await walkSnapshot(root, fullPath, snapshot);
      continue;
    }
    if (!entry.isFile()) continue;
    const rel = path.relative(root, fullPath).replace(/\\/g, '/');
    try {
      const stat = await fsp.stat(fullPath);
      const content = stat.size <= MAX_INLINE_SNAPSHOT_BYTES
        ? await fsp.readFile(fullPath)
        : null;
      snapshot.set(rel, {
        size: stat.size,
        digest: content ? digestBuffer(content) : await digestFile(fullPath),
        text: content && stat.size <= MAX_TEXT_DIFF_BYTES && isLikelyText(content)
          ? content.toString('utf8')
          : undefined,
        base64: content && !isLikelyText(content)
          ? content.toString('base64')
          : undefined,
        contentEncoding: content && !isLikelyText(content) ? 'base64' : undefined,
      });
    } catch (_) {
      // File changed while snapshotting; ignore and let the next scan catch it.
    }
  }
}

function digestBuffer(buffer) {
  return `sha256:${crypto.createHash('sha256').update(buffer).digest('hex')}`;
}

function digestJson(value) {
  return digestBuffer(Buffer.from(JSON.stringify(value)));
}

async function digestFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

function isLikelyText(buffer) {
  if (!buffer || buffer.length === 0) return true;
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096));
  if (sample.includes(0)) return false;
  let suspicious = 0;
  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) continue;
    if (byte >= 32 && byte <= 126) continue;
    if (byte >= 128) continue;
    suspicious += 1;
  }
  return suspicious / sample.length < 0.05;
}

function diffSnapshots(before, after) {
  const changes = [];
  const paths = new Set([...before.keys(), ...after.keys()]);
  for (const relPath of paths) {
    const oldEntry = before.get(relPath);
    const newEntry = after.get(relPath);
    if (!oldEntry && newEntry) {
      changes.push(enrichQuarantineChange(relPath, 'created', oldEntry, newEntry));
    } else if (oldEntry && !newEntry) {
      changes.push(enrichQuarantineChange(relPath, 'deleted', oldEntry, newEntry));
    } else if (oldEntry.digest !== newEntry.digest || oldEntry.size !== newEntry.size) {
      changes.push(enrichQuarantineChange(relPath, 'modified', oldEntry, newEntry));
    }
  }
  return changes.sort((a, b) => a.path.localeCompare(b.path));
}

function enrichQuarantineChange(relPath, kind, beforeEntry, afterEntry) {
  return {
    path: relPath,
    kind,
    beforeExists: Boolean(beforeEntry),
    afterExists: Boolean(afterEntry),
    beforeDigest: beforeEntry?.digest || null,
    afterDigest: afterEntry?.digest || null,
    beforeSize: beforeEntry?.size ?? null,
    afterSize: afterEntry?.size ?? null,
    evidenceDigest: digestJson({
      path: relPath,
      kind,
      beforeExists: Boolean(beforeEntry),
      afterExists: Boolean(afterEntry),
      beforeDigest: beforeEntry?.digest || null,
      afterDigest: afterEntry?.digest || null,
      beforeSize: beforeEntry?.size ?? null,
      afterSize: afterEntry?.size ?? null,
    }),
  };
}

function buildQuarantineChangeEvidence(change, beforeEntry, afterEntry) {
  const evidence = {
    path: change.path,
    kind: change.kind,
    beforeExists: change.beforeExists ?? Boolean(beforeEntry),
    afterExists: change.afterExists ?? Boolean(afterEntry),
    beforeDigest: change.beforeDigest || beforeEntry?.digest || null,
    afterDigest: change.afterDigest || afterEntry?.digest || null,
    beforeSize: change.beforeSize ?? beforeEntry?.size ?? null,
    afterSize: change.afterSize ?? afterEntry?.size ?? null,
  };
  if (typeof beforeEntry?.text === 'string') {
    evidence.beforeText = beforeEntry.text;
  }
  if (typeof afterEntry?.text === 'string') {
    evidence.afterText = afterEntry.text;
  }
  if (typeof beforeEntry?.base64 === 'string') {
    evidence.beforeBase64 = beforeEntry.base64;
    evidence.beforeContentEncoding = beforeEntry.contentEncoding || 'base64';
  }
  if (typeof afterEntry?.base64 === 'string') {
    evidence.afterBase64 = afterEntry.base64;
    evidence.afterContentEncoding = afterEntry.contentEncoding || 'base64';
  }
  const textDiff = buildSmallTextDiff(beforeEntry?.text, afterEntry?.text);
  if (textDiff) {
    evidence.textDiff = textDiff;
  }
  evidence.digest = digestJson(evidence);
  evidence.evidenceRef = `codesitefs:quarantine:${evidence.digest}`;
  return evidence;
}

function codeSiteQuarantineReplayPlan(changes = []) {
  const planned = [];
  const rejected = [];
  for (const [index, raw] of asArray(changes).entries()) {
    try {
      const change = codeSiteQuarantineReplayChange(raw, index);
      if (change.ok) planned.push(change);
      else rejected.push(change);
    } catch (error) {
      rejected.push({
        ok: false,
        index,
        path: raw?.path || raw?.quarantineEvidence?.path || raw?.quarantine_evidence?.path || null,
        reasonCodes: [error?.code || 'quarantine_replay_change_invalid'],
        error: error?.message || 'quarantine_replay_change_invalid',
      });
    }
  }
  return {
    ok: planned.length > 0 && rejected.length === 0,
    changes: planned,
    rejected,
  };
}

function codeSiteQuarantineReplayChange(raw = {}, index = 0) {
  const evidence = raw.quarantineEvidence
    || raw.quarantine_evidence
    || raw.evidence
    || {};
  const relPath = normalizeRepoRelativePath(raw.path || evidence.path);
  const kind = String(raw.kind || evidence.kind || 'modified').toLowerCase();
  const afterText = firstString(raw.afterText, raw.after_text, raw.content, evidence.afterText, evidence.after_text);
  const beforeText = firstStringOrNull(raw.beforeText, raw.before_text, evidence.beforeText, evidence.before_text);
  const afterBase64 = firstString(raw.afterBase64, raw.after_base64, raw.contentBase64, raw.content_base64, evidence.afterBase64, evidence.after_base64);
  const beforeBase64 = firstStringOrNull(raw.beforeBase64, raw.before_base64, evidence.beforeBase64, evidence.before_base64);
  const afterContentEncoding = firstString(raw.afterContentEncoding, raw.after_content_encoding, raw.contentEncoding, raw.content_encoding, evidence.afterContentEncoding, evidence.after_content_encoding);
  const beforeContentEncoding = firstString(raw.beforeContentEncoding, raw.before_content_encoding, evidence.beforeContentEncoding, evidence.before_content_encoding);
  const beforeExists = optionalBoolean(raw.beforeExists, raw.before_exists, evidence.beforeExists, evidence.before_exists);
  const afterExists = optionalBoolean(raw.afterExists, raw.after_exists, evidence.afterExists, evidence.after_exists);
  const quarantineId = raw.quarantineId || raw.quarantine_id || evidence.quarantineId || evidence.quarantine_id || null;
  const evidenceRef = raw.evidenceRef || raw.evidence_ref || evidence.evidenceRef || evidence.evidence_ref || null;
  const evidenceDigest = raw.evidenceDigest || raw.evidence_digest || evidence.digest || null;
  const evidenceRefs = unique([
    evidenceRef,
    ...(evidenceDigest ? [`codesitefs:quarantine:${evidenceDigest}`] : []),
    ...asArray(raw.evidenceRefs || raw.evidence_refs),
  ]);
  const deleteReplay = kind === 'deleted' || afterExists === false;
  const binaryReplay = !deleteReplay && typeof afterBase64 === 'string';
  const textReplay = !deleteReplay && typeof afterText === 'string';
  if (!deleteReplay && !textReplay && !binaryReplay) {
    return {
      ok: false,
      index,
      path: relPath,
      kind,
      reasonCodes: ['quarantine_after_content_required'],
    };
  }
  if (binaryReplay && !isValidBase64(afterBase64)) {
    return {
      ok: false,
      index,
      path: relPath,
      kind,
      reasonCodes: ['quarantine_after_base64_invalid'],
    };
  }
  if (typeof beforeBase64 === 'string' && !isValidBase64(beforeBase64)) {
    return {
      ok: false,
      index,
      path: relPath,
      kind,
      reasonCodes: ['quarantine_before_base64_invalid'],
    };
  }
  return {
    ok: true,
    index,
    path: relPath,
    kind,
    replayOperation: deleteReplay ? 'delete' : (binaryReplay ? 'write_binary' : 'write_text'),
    beforeExists: beforeExists ?? (kind === 'created' ? false : null),
    afterExists: deleteReplay ? false : (afterExists ?? true),
    quarantineId,
    beforeText,
    afterText,
    beforeBase64,
    afterBase64,
    beforeContentEncoding: beforeContentEncoding || (beforeBase64 ? 'base64' : null),
    afterContentEncoding: afterContentEncoding || (afterBase64 ? 'base64' : null),
    beforeDigest: raw.beforeDigest || raw.before_digest || evidence.beforeDigest || evidence.before_digest || null,
    afterDigest: raw.afterDigest || raw.after_digest || evidence.afterDigest || evidence.after_digest || null,
    evidenceRef,
    evidenceDigest,
    evidenceRefs,
    textDiff: raw.textDiff || raw.text_diff || evidence.textDiff || evidence.text_diff || null,
  };
}

function firstString(...values) {
  return values.find((value) => typeof value === 'string');
}

function firstStringOrNull(...values) {
  const found = firstString(...values);
  return typeof found === 'string' ? found : null;
}

function optionalBoolean(...values) {
  for (const value of values) {
    if (value === true || value === false) return value;
    if (typeof value === 'string') {
      const normalized = value.trim().toLowerCase();
      if (normalized === 'true') return true;
      if (normalized === 'false') return false;
    }
  }
  return null;
}

function isValidBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return Buffer.from(value, 'base64').toString('base64').replace(/=+$/, '') === value.replace(/=+$/, '');
  } catch (_) {
    return false;
  }
}

function buildSmallTextDiff(beforeText, afterText) {
  if (typeof beforeText !== 'string' && typeof afterText !== 'string') return null;
  const before = typeof beforeText === 'string' ? beforeText : '';
  const after = typeof afterText === 'string' ? afterText : '';
  if (Buffer.byteLength(before) + Buffer.byteLength(after) > MAX_TEXT_DIFF_BYTES) return null;

  const beforeLines = before.split(/\r?\n/);
  const afterLines = after.split(/\r?\n/);
  let prefix = 0;
  while (prefix < beforeLines.length && prefix < afterLines.length && beforeLines[prefix] === afterLines[prefix]) {
    prefix += 1;
  }
  let beforeSuffix = beforeLines.length - 1;
  let afterSuffix = afterLines.length - 1;
  while (
    beforeSuffix >= prefix
    && afterSuffix >= prefix
    && beforeLines[beforeSuffix] === afterLines[afterSuffix]
  ) {
    beforeSuffix -= 1;
    afterSuffix -= 1;
  }

  const contextStart = Math.max(0, prefix - 3);
  const contextEndBefore = Math.min(beforeLines.length - 1, beforeSuffix + 3);
  const contextEndAfter = Math.min(afterLines.length - 1, afterSuffix + 3);
  const lines = [];
  for (const line of beforeLines.slice(contextStart, prefix)) {
    lines.push(` ${line}`);
  }
  for (const line of beforeLines.slice(prefix, beforeSuffix + 1)) {
    lines.push(`-${line}`);
  }
  for (const line of afterLines.slice(prefix, afterSuffix + 1)) {
    lines.push(`+${line}`);
  }
  for (const line of afterLines.slice(afterSuffix + 1, contextEndAfter + 1)) {
    lines.push(` ${line}`);
  }
  const truncated = lines.length > MAX_TEXT_DIFF_LINES;
  return {
    format: 'line-window-v1',
    startLine: contextStart + 1,
    beforeLineCount: Math.max(0, contextEndBefore - contextStart + 1),
    afterLineCount: Math.max(0, contextEndAfter - contextStart + 1),
    truncated,
    lines: truncated ? lines.slice(0, MAX_TEXT_DIFF_LINES) : lines,
  };
}

function safeSegment(value) {
  return String(value || 'unknown').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'unknown';
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
  const repoScopedTool = isRepoScopedCodeSiteTool(tool);
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
  if (!repoScopedTool && context.allowedPaths?.length && !context.allowedPaths.some((pattern) => matchPathPattern(relPath, pattern))) {
    return denied(context, attempt, relPath, ['outside_clearance_route']);
  }
  return base;
}

function isRepoScopedCodeSiteTool(tool) {
  return ['git_refs', 'git_config', 'git_provisioning'].includes(String(tool || ''));
}

function evaluateCodeSiteRead(context, attempt = {}) {
  const relPath = normalizeRepoRelativePath(attempt.path || attempt.filePath);
  const tool = attempt.tool || attempt.kind || 'file_read';
  const active = Boolean(context?.active);
  const readAttempt = { ...attempt, kind: attempt.kind || 'read' };
  const base = {
    ok: true,
    path: relPath,
    tool,
    event: buildEvent(context, readAttempt, relPath, 'read_observed', ['inside_repo_boundary']),
  };
  if (!active) return base;

  if (context.blockedPaths?.some((pattern) => matchPathPattern(relPath, pattern))) {
    return deniedRead(context, readAttempt, relPath, ['entered_no_fly_zone']);
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

function deniedRead(context, attempt, relPath, reasonCodes) {
  const reason = `${attempt.kind || 'read'} denied for ${relPath}: ${reasonCodes.join(',')}`;
  return {
    ok: false,
    path: relPath,
    tool: attempt.tool || attempt.kind || 'file_read',
    reasonCodes,
    event: buildEvent(context, attempt, relPath, 'read_denied', reasonCodes, reason),
  };
}

function buildEvent(context = {}, attempt = {}, relPath, type, reasonCodes, reason = null) {
  const attemptEvidenceRefs = asArray(attempt.evidenceRefs || attempt.evidence_refs);
  const attemptProcessAncestry = asArray(attempt.processAncestry || attempt.process_ancestry);
  const lineProvenance = asArray(attempt.lineProvenance || attempt.line_provenance || attempt.hunks || attempt.lineAnchors || attempt.line_anchors);
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
    evidence_refs: unique([...asArray(context.evidenceRefs), ...attemptEvidenceRefs]),
    details: {
      reason: reason || reasonCodes.join(','),
      reason_codes: reasonCodes,
      process_ancestry: unique([...asArray(context.processAncestry), ...attemptProcessAncestry]),
      operation: attempt.kind || 'write',
      ...(lineProvenance.length ? { lineProvenance } : {}),
    },
  };
}

function deriveLineProvenanceFromContentChange(filePath, before, after, options = {}) {
  const relPath = normalizeRepoRelativePath(filePath);
  const ranges = diffLineRanges(String(before ?? ''), String(after ?? ''));
  return ranges.map((range, index) => {
    const hunkDigest = crypto
      .createHash('sha256')
      .update(JSON.stringify({
        path: relPath,
        index: index + 1,
        range,
        beforeHash: crypto.createHash('sha256').update(String(before ?? '')).digest('hex'),
        afterHash: crypto.createHash('sha256').update(String(after ?? '')).digest('hex'),
      }))
      .digest('hex');
    return {
      filePath: relPath,
      startLine: range.startLine,
      endLine: range.endLine,
      lineAnchor: `${relPath}#L${range.startLine}-L${range.endLine}`,
      reasonRef: options.reasonRef || `content-diff:${relPath}:hunk:${index + 1}`,
      evidenceRefs: unique([`hunk:sha256:${hunkDigest}`, ...asArray(options.evidenceRefs)]),
      processAncestry: asArray(options.processAncestry),
      promptSummary: options.promptSummary || 'Derived from content diff',
    };
  });
}

function diffLineRanges(before, after) {
  if (before === after) return [];
  const sourceLines = contentLines(before);
  const targetLines = contentLines(after);
  const maxLcsLines = 2000;
  if (sourceLines.length > maxLcsLines || targetLines.length > maxLcsLines) {
    return [coarseLineRange(sourceLines, targetLines)];
  }

  const m = sourceLines.length;
  const n = targetLines.length;
  const dp = new Array(m + 1);
  for (let row = 0; row <= m; row += 1) dp[row] = new Int32Array(n + 1);
  for (let row = m - 1; row >= 0; row -= 1) {
    for (let col = n - 1; col >= 0; col -= 1) {
      dp[row][col] = sourceLines[row] === targetLines[col]
        ? dp[row + 1][col + 1] + 1
        : Math.max(dp[row + 1][col], dp[row][col + 1]);
    }
  }

  const ranges = [];
  let sourceIndex = 0;
  let targetIndex = 0;
  let pending = null;
  const ensurePending = () => {
    if (!pending) {
      pending = { startLine: Math.max(1, targetIndex + 1), deletedLines: 0, insertedLines: 0 };
    }
  };
  const flush = () => {
    if (!pending) return;
    const span = Math.max(pending.deletedLines, pending.insertedLines, 1);
    ranges.push({
      startLine: pending.startLine,
      endLine: pending.startLine + span - 1,
    });
    pending = null;
  };

  while (sourceIndex < m || targetIndex < n) {
    if (
      sourceIndex < m
      && targetIndex < n
      && sourceLines[sourceIndex] === targetLines[targetIndex]
    ) {
      flush();
      sourceIndex += 1;
      targetIndex += 1;
    } else if (
      sourceIndex < m
      && (targetIndex >= n || dp[sourceIndex + 1][targetIndex] >= dp[sourceIndex][targetIndex + 1])
    ) {
      ensurePending();
      pending.deletedLines += 1;
      sourceIndex += 1;
    } else {
      ensurePending();
      pending.insertedLines += 1;
      targetIndex += 1;
    }
  }
  flush();
  return ranges;
}

function coarseLineRange(sourceLines, targetLines) {
  let prefix = 0;
  const prefixMax = Math.min(sourceLines.length, targetLines.length);
  while (prefix < prefixMax && sourceLines[prefix] === targetLines[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < Math.min(sourceLines.length, targetLines.length) - prefix
    && sourceLines[sourceLines.length - 1 - suffix] === targetLines[targetLines.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const sourceSpan = sourceLines.length - prefix - suffix;
  const targetSpan = targetLines.length - prefix - suffix;
  const startLine = Math.max(1, prefix + 1);
  return {
    startLine,
    endLine: startLine + Math.max(sourceSpan, targetSpan, 1) - 1,
  };
}

function contentLines(value) {
  if (!value) return [];
  const lines = String(value).split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
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
  return error?.code === 'CODESITE_WRITE_DENIED' || error?.code === 'CODESITE_READ_DENIED';
}

function isCodeSiteCommitBlockedError(error) {
  return error?.code === 'CODESITE_COMMIT_BLOCKED';
}

module.exports = {
  CodeSiteFS,
  CodeSiteCommitBlockedError,
  CodeSiteFSDeniedError,
  assertCodeSiteWriteAllowed,
  assertCodeSiteWritesAllowed,
  codeSiteCommitMessage,
  codeSiteCommitTrailers,
  codeSiteContextFromRequest,
  codeSiteQuarantineReplayPlan,
  codeSiteRuntimeEnv,
  codeSiteRuntimeMetadata,
  collectCodeSiteRepoState,
  completeCodeSiteCommitProof,
  createCodeSiteFS,
  createCodeSiteOverlayWorkspace,
  createCodeSiteQuarantineWorkspace,
  deriveLineProvenanceFromContentChange,
  enforceCodeSiteWriteAllowed,
  enforceCodeSiteWritesAllowed,
  evaluateCodeSiteWrite,
  finalizeCodeSiteQuarantineWorkspace,
  isCodeSiteCommitBlockedError,
  isCodeSiteDeniedError,
  listCodeSiteQuarantineManifests,
  normalizeRepoRelativePath,
  readCodeSiteQuarantineManifest,
  resolveCodeSiteRepoPath,
};
