'use strict';

const fs = require('fs');
const path = require('path');
const config = require('./config');
const {
  configuredControlPlaneBaseUrl,
  trustedControlPlaneBaseUrl,
} = require('./codesiteControlPlaneTrust');

const configuredActiveTtlMs = Number(process.env.SYNTHI_CODESITE_ACTIVE_TTL_MS || 30 * 60 * 1000);
const DEFAULT_ACTIVE_TTL_MS = Number.isFinite(configuredActiveTtlMs)
  ? Math.max(60_000, configuredActiveTtlMs)
  : 30 * 60 * 1000;
const configuredRefreshTimeoutMs = Number(process.env.SYNTHI_CODESITE_ACTIVE_REFRESH_TIMEOUT_MS || 1500);
const DEFAULT_REFRESH_TIMEOUT_MS = Number.isFinite(configuredRefreshTimeoutMs)
  ? Math.max(250, configuredRefreshTimeoutMs)
  : 1500;
const STATE_SCHEMA_VERSION = 1;
const DEFAULT_STATE_FILE = path.join(config.CODESITE_ACTIVITY_STATE_DIR, 'active-transactions.json');
const STATE_LOCK_WAIT_MS = 2_000;
const STATE_LOCK_STALE_MS = 30_000;

const activeByWorkspace = new Map();
let persistence = {
  enabled: String(process.env.SYNTHI_CODESITE_ACTIVITY_PERSISTENCE || 'true').toLowerCase() !== 'false',
  filePath: process.env.SYNTHI_CODESITE_ACTIVITY_STATE_FILE || DEFAULT_STATE_FILE,
  loadedMtimeMs: null,
};
let stateLockDepth = 0;

function normalize(value) {
  return String(value || '').trim();
}

function normalizeWorkspaceSlug(input = {}) {
  return normalize(input.workspaceSlug || input.workspace_slug || input.slug);
}

function normalizeTransactionId(input = {}) {
  return normalize(input.transactionId || input.transaction_id || input.id);
}

function isWritableTransactionStatus(status) {
  return ['open', 'running', 'active', 'pending', 'validating', 'validated', 'committing', 'blocked'].includes(String(status || 'open').toLowerCase());
}

function isAuthoritativeSource(source) {
  const normalized = normalize(source).toLowerCase();
  return normalized === 'next_codesite_route'
    || normalized === 'codesite_route_activity'
    || normalized === 'control_plane_transaction'
    || normalized === 'control_plane_transaction_read';
}

function transactionKey(transactionId) {
  return normalize(transactionId) || `unknown:${Date.now()}:${Math.random().toString(36).slice(2)}`;
}

function workspaceRecords(slug) {
  const normalizedSlug = normalize(slug);
  if (!normalizedSlug) return null;
  if (!activeByWorkspace.has(normalizedSlug)) {
    activeByWorkspace.set(normalizedSlug, new Map());
  }
  return activeByWorkspace.get(normalizedSlug);
}

function sanitizeRecord(input = {}, fallback = {}) {
  const workspaceSlug = normalizeWorkspaceSlug(input) || normalizeWorkspaceSlug(fallback);
  const transactionId = normalizeTransactionId(input) || normalizeTransactionId(fallback);
  if (!workspaceSlug || !transactionId) return null;
  const source = normalize(input.source || fallback.source) || 'codesite';
  const now = Number(fallback.now || Date.now());
  const createdAt = Number(input.createdAt || fallback.createdAt || now);
  const lastSeenAt = Number(input.lastSeenAt || fallback.lastSeenAt || now);
  const expiresAt = Number(input.expiresAt || fallback.expiresAt || now + DEFAULT_ACTIVE_TTL_MS);
  return {
    workspaceSlug,
    transactionId,
    mutationLeaseId: normalize(input.mutationLeaseId || input.mutation_lease_id || input.leaseId || input.lease_id) || null,
    agentSessionId: normalize(input.agentSessionId || input.agent_session_id) || null,
    actorUserId: normalize(input.actorUserId || input.actor_user_id || input.userId || input.user_id) || null,
    effectiveUserId: normalize(input.effectiveUserId || input.effective_user_id || input.filesystemUserId || input.filesystem_user_id) || null,
    controlPlaneUrl: normalize(input.controlPlaneUrl || input.control_plane_url) || null,
    controlPlaneTrusted: Boolean(input.controlPlaneTrusted || input.control_plane_trusted || fallback.controlPlaneTrusted),
    status: normalize(input.status) || 'open',
    source,
    authoritative: Boolean(input.authoritative || fallback.authoritative || isAuthoritativeSource(source)),
    createdAt: Number.isFinite(createdAt) ? createdAt : now,
    lastSeenAt: Number.isFinite(lastSeenAt) ? lastSeenAt : now,
    expiresAt: Number.isFinite(expiresAt) ? expiresAt : now + DEFAULT_ACTIVE_TTL_MS,
  };
}

function replaceRecords(records = [], options = {}) {
  const now = Number(options.now || Date.now());
  activeByWorkspace.clear();
  for (const item of records) {
    const record = sanitizeRecord(item);
    if (!record) continue;
    if (record.expiresAt <= now || !isWritableTransactionStatus(record.status)) continue;
    workspaceRecords(record.workspaceSlug).set(transactionKey(record.transactionId), record);
  }
}

function allRecords() {
  return [...activeByWorkspace.values()]
    .flatMap((records) => [...records.values()])
    .map((record) => ({ ...record }));
}

function stateFilePath() {
  return persistence.filePath;
}

function persistenceEnabled() {
  return Boolean(persistence.enabled && persistence.filePath);
}

function resolveControlPlaneBaseUrl(workspaceSlug, options = {}) {
  const explicit = options.controlPlaneUrl || options.control_plane_url;
  if (explicit) {
    const trusted = trustedControlPlaneBaseUrl(explicit, workspaceSlug, {
      controlPlaneTrusted: options.controlPlaneTrusted || options.authenticatedInternal,
    });
    if (trusted) return trusted;
    throw controlPlaneUnavailableError('CodeSite active transaction authority URL is not trusted', null, {
      workspaceSlug: normalize(workspaceSlug),
      controlPlaneUrl: normalize(explicit),
      reason: 'untrusted_control_plane_url',
    });
  }
  const records = activeByWorkspace.get(normalize(workspaceSlug));
  if (records) {
    for (const record of records.values()) {
      if (!record.controlPlaneUrl) continue;
      const trusted = trustedControlPlaneBaseUrl(record.controlPlaneUrl, workspaceSlug, {
        controlPlaneTrusted: record.controlPlaneTrusted,
      });
      if (trusted) return trusted;
    }
  }
  return configuredControlPlaneBaseUrl(workspaceSlug);
}

function fetchTimeoutSignal(ms) {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
    return AbortSignal.timeout(ms);
  }
  return undefined;
}

function controlPlaneHeaders(options = {}) {
  const headers = { accept: 'application/json' };
  const token = options.authToken || options.auth_token || process.env.SYNTHI_CODESITE_TOKEN;
  const cookie = options.cookie || process.env.SYNTHI_CODESITE_COOKIE;
  if (token) headers.authorization = `Bearer ${token}`;
  if (cookie) headers.cookie = cookie;
  return headers;
}

function stateUnavailableError(message, cause = null) {
  const error = new Error(message);
  error.code = 'CODESITE_ACTIVITY_STATE_UNAVAILABLE';
  error.status = 503;
  if (cause) error.cause = cause;
  error.details = {
    stateFile: stateFilePath(),
  };
  return error;
}

function controlPlaneUnavailableError(message, cause = null, details = {}) {
  const error = new Error(message);
  error.code = 'CODESITE_ACTIVITY_CONTROL_PLANE_UNAVAILABLE';
  error.status = 503;
  if (cause) error.cause = cause;
  error.details = details;
  return error;
}

function sleepSync(ms) {
  if (ms <= 0) return;
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, ms);
}

function stateLockFilePath() {
  return `${stateFilePath()}.lock`;
}

function acquireStateFileLock() {
  const lockPath = stateLockFilePath();
  const deadline = Date.now() + STATE_LOCK_WAIT_MS;
  fs.mkdirSync(path.dirname(lockPath), { recursive: true });
  while (true) {
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(fd, JSON.stringify({
        pid: process.pid,
        acquiredAt: new Date().toISOString(),
      }));
      return { fd, lockPath };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw stateUnavailableError(`CodeSite activity state lock unavailable at ${lockPath}: ${error.message}`, error);
      }
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > STATE_LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw stateUnavailableError(`CodeSite activity state lock unreadable at ${lockPath}: ${statError.message}`, statError);
      }
      if (Date.now() >= deadline) {
        throw stateUnavailableError(`CodeSite activity state lock timed out at ${lockPath}`, error);
      }
      sleepSync(25);
    }
  }
}

function releaseStateFileLock(lock) {
  if (!lock) return;
  try { fs.closeSync(lock.fd); } catch (_) {}
  try { fs.rmSync(lock.lockPath, { force: true }); } catch (_) {}
}

function withStateFileLock(fn, options = {}) {
  if (!persistenceEnabled() || stateLockDepth > 0) return fn();
  const lock = acquireStateFileLock();
  stateLockDepth += 1;
  try {
    if (options.loadBefore) loadStateFromDisk({ ...(options.loadOptions || {}), force: true });
    return fn();
  } finally {
    stateLockDepth -= 1;
    releaseStateFileLock(lock);
  }
}

function withPersistedStateMutation(fn, options = {}) {
  return withStateFileLock(fn, { loadBefore: true, loadOptions: options });
}

function loadStateFromDisk(options = {}) {
  if (!persistenceEnabled()) return false;
  const filePath = stateFilePath();
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      if (options.force) replaceRecords([], options);
      persistence.loadedMtimeMs = null;
      return false;
    }
    throw stateUnavailableError(`CodeSite activity state unavailable at ${filePath}: ${error.message}`, error);
  }
  if (!options.force && persistence.loadedMtimeMs === stat.mtimeMs) return false;
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw stateUnavailableError(`CodeSite activity state is unreadable at ${filePath}: ${error.message}`, error);
  }
  if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.records)) {
    throw stateUnavailableError(`CodeSite activity state has invalid schema at ${filePath}`);
  }
  replaceRecords(parsed.records, options);
  persistence.loadedMtimeMs = stat.mtimeMs;
  return true;
}

function persistStateToDisk() {
  if (!persistenceEnabled()) return false;
  if (stateLockDepth === 0) {
    return withStateFileLock(() => persistStateToDisk(), { loadBefore: false });
  }
  const filePath = stateFilePath();
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = {
    schemaVersion: STATE_SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    records: allRecords(),
  };
  const tmpPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmpPath, filePath);
    try {
      persistence.loadedMtimeMs = fs.statSync(filePath).mtimeMs;
    } catch (_) {
      persistence.loadedMtimeMs = null;
    }
    return true;
  } catch (error) {
    try { fs.rmSync(tmpPath, { force: true }); } catch (_) {}
    throw stateUnavailableError(`CodeSite activity state could not be persisted at ${filePath}: ${error.message}`, error);
  }
}

function loadLatestState(options = {}) {
  return loadStateFromDisk(options);
}

function pruneWorkspace(slug, now = Date.now()) {
  const normalizedSlug = normalize(slug);
  const records = activeByWorkspace.get(normalizedSlug);
  if (!records) return [];
  let pruned = false;
  for (const [key, record] of records) {
    if (record.expiresAt <= now || !isWritableTransactionStatus(record.status)) {
      records.delete(key);
      pruned = true;
    }
  }
  if (records.size === 0) activeByWorkspace.delete(normalizedSlug);
  if (pruned) persistStateToDisk();
  return records ? [...records.values()] : [];
}

function markTransactionActive(input = {}, options = {}) {
  return withPersistedStateMutation(() => {
    const workspaceSlug = normalizeWorkspaceSlug(input);
    const transactionId = normalizeTransactionId(input);
    if (!workspaceSlug || !transactionId) return null;
    const now = Number(options.now || Date.now());
    const requestedTtlMs = Number(input.ttlMs || input.ttl_ms || options.ttlMs || DEFAULT_ACTIVE_TTL_MS);
    const ttlMs = Number.isFinite(requestedTtlMs)
      ? Math.max(1_000, requestedTtlMs)
      : DEFAULT_ACTIVE_TTL_MS;
    const records = workspaceRecords(workspaceSlug);
    const key = transactionKey(transactionId);
    const previous = records.get(key) || {};
    const record = sanitizeRecord(input, {
      ...previous,
      workspaceSlug,
      transactionId,
      status: normalize(input.status) || 'open',
      source: normalize(input.source || options.source) || previous.source || 'codesite',
      authoritative: input.authoritative ?? options.authoritative ?? previous.authoritative,
      createdAt: previous.createdAt || now,
      lastSeenAt: now,
      expiresAt: now + ttlMs,
      now,
    });
    records.set(key, record);
    persistStateToDisk();
    return { ...record };
  }, options);
}

function replaceWorkspaceActiveTransactions(workspaceSlug, records = [], options = {}) {
  return withPersistedStateMutation(() => {
    const slug = normalize(workspaceSlug);
    if (!slug) return [];
    activeByWorkspace.delete(slug);
    const now = Number(options.now || Date.now());
    for (const item of records) {
      const transactionId = normalizeTransactionId(item);
      if (!transactionId) continue;
      const record = sanitizeRecord({
        ...item,
        workspaceSlug: slug,
        transactionId,
        mutationLeaseId: item.mutationLeaseId || item.mutation_lease_id,
        agentSessionId: item.agentSessionId || item.agent_session_id,
        actorUserId: item.actorUserId || item.actor_user_id,
        effectiveUserId: item.effectiveUserId || item.effective_user_id,
        controlPlaneUrl: options.controlPlaneUrl || item.controlPlaneUrl || item.control_plane_url,
        controlPlaneTrusted: true,
        source: options.source || item.source || 'control_plane_active_list',
        authoritative: true,
        lastSeenAt: now,
        expiresAt: now + Number(options.ttlMs || DEFAULT_ACTIVE_TTL_MS),
      }, { now, authoritative: true });
      if (!record || !isWritableTransactionStatus(record.status)) continue;
      workspaceRecords(slug).set(transactionKey(record.transactionId), record);
    }
    persistStateToDisk();
    return pruneWorkspace(slug, now).map((record) => ({ ...record }));
  }, options);
}

async function refreshWorkspaceFromControlPlane(workspaceSlug, options = {}) {
  const slug = normalize(workspaceSlug);
  if (!slug) return [];
  loadLatestState();
  const baseUrl = resolveControlPlaneBaseUrl(slug, options);
  if (!baseUrl) {
    if (options.requireAuthority) {
      throw controlPlaneUnavailableError('CodeSite active transaction authority URL is not configured', null, {
        workspaceSlug: slug,
        reason: 'missing_control_plane_url',
      });
    }
    return activeTransactionsForWorkspace(slug, options);
  }
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw controlPlaneUnavailableError('CodeSite active transaction authority fetch is unavailable', null, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'fetch_unavailable',
    });
  }
  const url = `${baseUrl}/transactions/active`;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: controlPlaneHeaders(options),
      signal: fetchTimeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw controlPlaneUnavailableError(`CodeSite active transaction authority request failed for ${slug}: ${error.message}`, error, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'fetch_failed',
    });
  }
  if (!response || !response.ok) {
    throw controlPlaneUnavailableError(`CodeSite active transaction authority returned ${response?.status || 'no_response'} for ${slug}`, null, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'bad_status',
      status: response?.status || null,
    });
  }
  const body = await response.json().catch((error) => {
    throw controlPlaneUnavailableError(`CodeSite active transaction authority returned invalid JSON for ${slug}: ${error.message}`, error, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'invalid_json',
    });
  });
  const activeTransactions = Array.isArray(body?.activeTransactions)
    ? body.activeTransactions
    : (Array.isArray(body?.transactions) ? body.transactions : []);
  return replaceWorkspaceActiveTransactions(slug, activeTransactions, {
    ...options,
    controlPlaneUrl: baseUrl,
    source: 'control_plane_active_list',
  });
}

async function refreshWorkspaceActiveStateFromControlPlane(workspaceSlug, options = {}) {
  const slug = normalize(workspaceSlug);
  if (!slug) {
    return {
      active: false,
      workspaceSlug: '',
      activeTransactions: [],
    };
  }
  loadLatestState();
  const baseUrl = resolveControlPlaneBaseUrl(slug, options);
  if (!baseUrl) {
    if (options.requireAuthority) {
      throw controlPlaneUnavailableError('CodeSite workspace active-state authority URL is not configured', null, {
        workspaceSlug: slug,
        reason: 'missing_control_plane_url',
      });
    }
    const activeTransactions = activeTransactionsForWorkspace(slug, options);
    return {
      active: activeTransactions.length > 0,
      workspaceSlug: slug,
      generatedAt: new Date(Number(options.now || Date.now())).toISOString(),
      activeTransactions,
    };
  }
  const fetchImpl = options.fetch || global.fetch;
  if (typeof fetchImpl !== 'function') {
    throw controlPlaneUnavailableError('CodeSite workspace active-state authority fetch is unavailable', null, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'fetch_unavailable',
    });
  }
  const url = `${baseUrl}/active-state`;
  const timeoutMs = Number(options.timeoutMs || DEFAULT_REFRESH_TIMEOUT_MS);
  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: controlPlaneHeaders(options),
      signal: fetchTimeoutSignal(timeoutMs),
    });
  } catch (error) {
    throw controlPlaneUnavailableError(`CodeSite workspace active-state request failed for ${slug}: ${error.message}`, error, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'fetch_failed',
    });
  }
  if (!response || !response.ok) {
    throw controlPlaneUnavailableError(`CodeSite workspace active-state authority returned ${response?.status || 'no_response'} for ${slug}`, null, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'bad_status',
      status: response?.status || null,
    });
  }
  const body = await response.json().catch((error) => {
    throw controlPlaneUnavailableError(`CodeSite workspace active-state authority returned invalid JSON for ${slug}: ${error.message}`, error, {
      workspaceSlug: slug,
      controlPlaneUrl: baseUrl,
      reason: 'invalid_json',
    });
  });
  const activeTransactions = Array.isArray(body?.activeTransactions)
    ? body.activeTransactions
    : (Array.isArray(body?.transactions) ? body.transactions : []);
  const storedActiveTransactions = replaceWorkspaceActiveTransactions(slug, activeTransactions, {
    ...options,
    controlPlaneUrl: baseUrl,
    source: 'control_plane_active_state',
  });
  return {
    workspaceSlug: slug,
    ...body,
    activeTransactions: storedActiveTransactions,
    active: Boolean(body?.active ?? storedActiveTransactions.length > 0),
  };
}

function recordCodeSiteContext(context = {}, options = {}) {
  if (!context?.active || !context.transactionId) return null;
  const workspaceSlug = normalizeWorkspaceSlug(context);
  if (!workspaceSlug) return null;
  const controlPlaneTrusted = Boolean(context.controlPlaneTrusted)
    || Boolean(trustedControlPlaneBaseUrl(context.controlPlaneUrl, workspaceSlug));
  return markTransactionActive({
    workspaceSlug,
    transactionId: context.transactionId,
    mutationLeaseId: context.mutationLeaseId,
    agentSessionId: context.agentSessionId,
    actorUserId: context.actorUserId,
    effectiveUserId: context.effectiveUserId,
    controlPlaneUrl: context.controlPlaneUrl,
    controlPlaneTrusted,
    status: context.authoritativeTransactionStatus || context.status || 'open',
    source: options.source || context.authoritativeSource || 'codesite-context',
    authoritative: Boolean(context.authoritative) || isAuthoritativeSource(options.source || context.authoritativeSource),
    ttlMs: options.ttlMs,
  }, options);
}

function markTransactionClosed(input = {}, options = {}) {
  return withPersistedStateMutation(() => {
    const workspaceSlug = normalizeWorkspaceSlug(input);
    const transactionId = normalizeTransactionId(input);
    if (!workspaceSlug) return null;
    const records = activeByWorkspace.get(workspaceSlug);
    if (!records) return null;
    if (transactionId) {
      const previous = records.get(transactionId) || null;
      records.delete(transactionId);
      if (records.size === 0) activeByWorkspace.delete(workspaceSlug);
      persistStateToDisk();
      return previous ? {
        ...previous,
        status: normalize(input.status) || 'closed',
        closedAt: Number(options.now || Date.now()),
        closeSource: normalize(input.source || options.source) || 'codesite',
      } : null;
    }
    const closed = [...records.values()];
    activeByWorkspace.delete(workspaceSlug);
    persistStateToDisk();
    return closed;
  }, options);
}

function activeTransactionsForWorkspace(slug, options = {}) {
  return withStateFileLock(() => {
    loadLatestState({ ...options, force: true });
    const now = Number(options.now || Date.now());
    return pruneWorkspace(slug, now).map((record) => ({ ...record }));
  }, { loadBefore: false });
}

function isWorkspaceActive(slug, options = {}) {
  return activeTransactionsForWorkspace(slug, options).length > 0;
}

function activeWorkspaceError(slug, reason = 'workspace_mutation') {
  const activeTransactions = activeTransactionsForWorkspace(slug);
  const error = new Error(`CodeSite active transaction blocks ${reason} for workspace ${slug}`);
  error.code = 'CODESITE_WORKSPACE_ACTIVE';
  error.status = 409;
  error.details = {
    reason,
    workspaceSlug: normalize(slug),
    activeTransactions,
  };
  return error;
}

function assertWorkspaceInactive(slug, options = {}) {
  const reason = options.reason || 'workspace_mutation';
  if (isWorkspaceActive(slug, options)) {
    throw activeWorkspaceError(slug, reason);
  }
}

function resetRegistry(options = {}) {
  return withStateFileLock(() => {
    activeByWorkspace.clear();
    if (options.persist === false) {
      persistence.loadedMtimeMs = null;
      return;
    }
    persistStateToDisk();
  }, { loadBefore: false });
}

function configurePersistence(options = {}) {
  const previous = { ...persistence };
  persistence = {
    enabled: options.enabled !== undefined ? Boolean(options.enabled) : persistence.enabled,
    filePath: options.filePath || persistence.filePath,
    loadedMtimeMs: null,
  };
  activeByWorkspace.clear();
  loadLatestState({ force: true });
  return previous;
}

loadLatestState({ force: true });

module.exports = {
  DEFAULT_ACTIVE_TTL_MS,
  DEFAULT_REFRESH_TIMEOUT_MS,
  activeTransactionsForWorkspace,
  assertWorkspaceInactive,
  configurePersistence,
  isWorkspaceActive,
  isWritableTransactionStatus,
  loadStateFromDisk,
  markTransactionActive,
  markTransactionClosed,
  recordCodeSiteContext,
  refreshWorkspaceActiveStateFromControlPlane,
  refreshWorkspaceFromControlPlane,
  replaceWorkspaceActiveTransactions,
  resetRegistry,
  resolveControlPlaneBaseUrl,
  stateFilePath,
};
