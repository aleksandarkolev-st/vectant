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

class CodeSiteFSDeniedError extends Error {
  constructor(event) {
    super(event.details?.reason || 'codesite_write_denied');
    this.name = 'CodeSiteFSDeniedError';
    this.code = 'CODESITE_WRITE_DENIED';
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

function codeSiteContextFromRequest(req, data = {}, extra = {}) {
  const hasCodeSitePayload = Object.prototype.hasOwnProperty.call(data, 'codesite')
    || Object.prototype.hasOwnProperty.call(data, 'codeSite');
  const payload = data.codesite || data.codeSite || {};
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
  const context = {
    active: false,
    required,
    mode: explicitMode || 'enforce',
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
    required ||
    explicitMode ||
    hasCodeSitePayload ||
    Object.keys(payload).length > 0,
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

async function enforceCodeSiteWriteAllowed(context, attempt, options = {}) {
  const result = evaluateCodeSiteWrite(context, attempt);
  const durableFailure = evaluateCodeSiteDurableContext(context, options);
  if (durableFailure && context?.mode !== 'monitor') {
    throw new CodeSiteFSDeniedError({
      ...result.event,
      type: 'write_denied',
      details: {
        ...result.event.details,
        reason: `CodeSite write requires durable control-plane context: ${durableFailure.reasonCodes.join(',')}`,
        reason_codes: [
          ...durableFailure.reasonCodes,
          ...asArray(result.event.details?.reason_codes),
        ],
      },
    });
  }
  if (context?.active && context.transactionId) {
    try {
      await recordCodeSiteWriteAttempt(context, result, {
        ...options,
        acceptDenied: options.acceptDenied || !result.ok || context.mode === 'monitor',
      });
    } catch (error) {
      if (result.ok) throw error;
      result.event.details.persistence_error = error?.message || 'codesite_denied_write_persistence_failed';
    }
  }
  if (!result.ok && context?.mode !== 'monitor') {
    throw new CodeSiteFSDeniedError(result.event);
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

function evaluateCodeSiteDurableContext(context, options = {}) {
  if (!context?.active || context.mode === 'monitor') return null;
  const reasonCodes = [];
  if (!context.transactionId) reasonCodes.push('codesite_transaction_required');
  if (!resolveControlPlaneBaseUrl(context)) reasonCodes.push('codesite_control_plane_url_required');
  if (typeof (options.fetch || global.fetch) !== 'function') reasonCodes.push('codesite_control_plane_fetch_unavailable');
  return reasonCodes.length ? { reasonCodes } : null;
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
    gitOutput(root, ['rev-parse', 'HEAD']),
    gitOutput(root, ['diff', '--cached', '--binary', '--', ...exactPaths]),
    gitOutput(root, ['diff', '--binary', '--', ...exactPaths]),
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

async function gitOutput(repoRoot, args) {
  try {
    const result = await execFileAsync('git', ['-C', repoRoot, ...args], {
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true,
    });
    return String(result.stdout || '').trimEnd();
  } catch (_) {
    return '';
  }
}

async function fileDigestForRepoPath(repoRoot, relPath) {
  const normalized = normalizeRepoRelativePath(relPath);
  const fullPath = path.resolve(repoRoot, normalized);
  const rel = path.relative(repoRoot, fullPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    throw new Error('codesite_repo_state_path_escape');
  }
  try {
    const stat = await fsp.stat(fullPath);
    return {
      path: normalized,
      digest: await digestFile(fullPath),
      size: stat.size,
      exists: true,
    };
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        path: normalized,
        digest: null,
        size: null,
        exists: false,
      };
    }
    throw error;
  }
}

async function createCodeSiteQuarantineWorkspace(context, cwd, options = {}) {
  if (!context?.active || !context.transactionId || !cwd) return null;
  const root = path.join(
    options.baseDir || path.join(os.tmpdir(), 'synthi-codesitefs-quarantine'),
    safeSegment(context.workspaceSlug || 'workspace'),
    safeSegment(context.transactionId),
    `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`,
  );
  await fsp.mkdir(root, { recursive: true });
  await fsp.cp(cwd, root, {
    recursive: true,
    dereference: false,
    filter: (src) => !shouldSkipQuarantinePath(src, cwd),
  });
  return {
    cwd: root,
    originalCwd: cwd,
    root,
    operation: options.operation || 'raw_terminal',
    before: await snapshotTree(root),
  };
}

async function finalizeCodeSiteQuarantineWorkspace(context, quarantine, options = {}) {
  if (!context?.active || !quarantine?.root) return { changes: [], recorded: [] };
  const after = await snapshotTree(quarantine.root);
  const changes = diffSnapshots(quarantine.before || new Map(), after);
  const recorded = [];
  for (const change of changes) {
    const beforeEntry = (quarantine.before || new Map()).get(change.path) || null;
    const afterEntry = after.get(change.path) || null;
    const quarantineEvidence = buildQuarantineChangeEvidence(change, beforeEntry, afterEntry);
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
      recorded.push({ ...change, ok: true, response });
    } catch (error) {
      recorded.push({ ...change, ok: false, error: error?.message || 'record_failed' });
    }
  }
  if (options.cleanup !== false) {
    await fsp.rm(quarantine.root, { recursive: true, force: true }).catch(() => {});
  }
  if (options.resetBaseline === true && options.cleanup === false) {
    quarantine.before = after;
  }
  return { changes, recorded };
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
    beforeDigest: beforeEntry?.digest || null,
    afterDigest: afterEntry?.digest || null,
    beforeSize: beforeEntry?.size ?? null,
    afterSize: afterEntry?.size ?? null,
    evidenceDigest: digestJson({
      path: relPath,
      kind,
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
    beforeDigest: change.beforeDigest || beforeEntry?.digest || null,
    afterDigest: change.afterDigest || afterEntry?.digest || null,
    beforeSize: change.beforeSize ?? beforeEntry?.size ?? null,
    afterSize: change.afterSize ?? afterEntry?.size ?? null,
  };
  const textDiff = buildSmallTextDiff(beforeEntry?.text, afterEntry?.text);
  if (textDiff) {
    evidence.textDiff = textDiff;
  }
  evidence.digest = digestJson(evidence);
  evidence.evidenceRef = `codesitefs:quarantine:${evidence.digest}`;
  return evidence;
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
  return error?.code === 'CODESITE_WRITE_DENIED';
}

function isCodeSiteCommitBlockedError(error) {
  return error?.code === 'CODESITE_COMMIT_BLOCKED';
}

module.exports = {
  CodeSiteCommitBlockedError,
  CodeSiteFSDeniedError,
  assertCodeSiteWriteAllowed,
  assertCodeSiteWritesAllowed,
  codeSiteCommitMessage,
  codeSiteCommitTrailers,
  codeSiteContextFromRequest,
  codeSiteRuntimeEnv,
  codeSiteRuntimeMetadata,
  collectCodeSiteRepoState,
  completeCodeSiteCommitProof,
  createCodeSiteQuarantineWorkspace,
  enforceCodeSiteWriteAllowed,
  enforceCodeSiteWritesAllowed,
  evaluateCodeSiteWrite,
  finalizeCodeSiteQuarantineWorkspace,
  isCodeSiteCommitBlockedError,
  isCodeSiteDeniedError,
  normalizeRepoRelativePath,
};
