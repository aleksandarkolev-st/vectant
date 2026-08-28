import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export const GPU_HMR_RUNTIME_BOUNDARY_APP_HOOK_SCHEMA_VERSION =
  'synthi.gpu_hmr.runtime_boundary_app_hook.v1';
export const GPU_HMR_RUNTIME_BOUNDARY_APP_HOOK_AUTHORITY =
  'declared_runtime_boundary_app_hook_only_not_gpu_hmr_success';

const DEFAULT_RUN_WHEN = 'after_upstream_run';
const ALLOWED_RUN_WHEN = new Set([
  'after_upstream_run',
  'after_configure_success',
  'after_build_attempt',
  'after_lifecycle_attempt',
]);
const AUTHORITY_BOOLEAN_KEYS = new Set([
  'acceptedforgpuhmr',
  'gpuhmrsuccess',
  'cansatisfyruntimeproof',
  'cansatisfydispatchproof',
  'runtimeauthority',
  'dispatchauthority',
]);
const AUTHORITY_STRING_KEYS = new Set([
  'proofauthority',
  'evidenceauthority',
  'authority',
]);

function sha256Bytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function optionalObject(value, field, errorPrefix) {
  if (value === undefined || value === null) return {};
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${errorPrefix} ${field}: expected object`);
  }
  return value;
}

function optionalString(value, field, errorPrefix) {
  if (value === undefined || value === null || String(value).trim() === '') return '';
  if (typeof value !== 'string') {
    throw new Error(`${errorPrefix} ${field}: expected string`);
  }
  return value.trim();
}

function optionalBoolean(value, field, errorPrefix) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'boolean') {
    throw new Error(`${errorPrefix} ${field}: expected boolean`);
  }
  return value;
}

function optionalNumber(value, field, errorPrefix) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${errorPrefix} ${field}: expected finite number`);
  }
  return parsed;
}

function optionalStringList(value, field, errorPrefix) {
  if (value === undefined || value === null) return [];
  if (typeof value === 'string') {
    const normalized = optionalString(value, field, errorPrefix);
    if (!normalized) {
      throw new Error(`${errorPrefix} ${field}: expected non-empty string`);
    }
    return [normalized];
  }
  const values = value;
  if (!Array.isArray(values)) {
    throw new Error(`${errorPrefix} ${field}: expected array`);
  }
  return values.map((entry, index) => {
    const normalized = optionalString(entry, `${field}[${index}]`, errorPrefix);
    if (!normalized) {
      throw new Error(`${errorPrefix} ${field}[${index}]: expected non-empty string`);
    }
    return normalized;
  });
}

function normalizedAuthorityKey(key) {
  return String(key ?? '').replace(/[^a-z0-9]/gi, '').toLowerCase();
}

function stringClaimsAuthority(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (!normalized) return false;
  const supportOnly = /(?:not_(?:gpu_hmr_success|runtime_authority|dispatch_authority)|(?:evidence|support|transport|declaration|declared)_only)/.test(
    normalized,
  );
  if (supportOnly) return false;
  return /(?:gpu_hmr_success|runtime_authority|dispatch_authority|authoritative_runtime|authoritative_dispatch)/.test(
    normalized,
  );
}

function pathIsInside(parentPath, childPath) {
  const parent = path.resolve(parentPath);
  const child = path.resolve(childPath);
  const relative = path.relative(parent, child);
  return relative === ''
    || Boolean(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

async function nearestExistingAncestor(candidate) {
  let current = path.resolve(candidate);
  while (true) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

async function canonicalAllowedRoots(roots) {
  const output = [];
  for (const root of roots) {
    const resolved = path.resolve(root);
    try {
      output.push(await realpath(resolved));
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      output.push(resolved);
    }
  }
  return output;
}

async function hostPathIsCanonicallyContained(candidate, allowedRoots) {
  const ancestor = await nearestExistingAncestor(candidate);
  if (!ancestor) return false;
  const canonicalAncestor = await realpath(ancestor);
  const canonicalRoots = await canonicalAllowedRoots(allowedRoots);
  return canonicalRoots.some((root) => pathIsInside(root, canonicalAncestor));
}

function shellQuote(value) {
  return `'${String(value ?? '').replace(/'/g, `'"'"'`)}'`;
}

function metricValue(timings, key) {
  const escaped = String(key ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}=([^\\s]+)\\b`).exec(String(timings ?? ''))?.[1] ?? null;
}

function failedExecutionTimings(reason, exitCode = 'not-run') {
  return [
    'runtime_adapter_status=failed',
    `runtime_adapter_exit_code=${exitCode}`,
    `runtime_adapter_skip_reason=${reason}`,
    'runtime_adapter_ms=0',
  ].join('\n');
}

export function normalizeRuntimeBoundaryAppHookRelativePath(
  value,
  field = 'runtimeAdapter.path',
  errorPrefix = 'invalid runtime boundary app hook',
) {
  const supplied = optionalString(value, field, errorPrefix).replace(/\\/g, '/');
  if (/^(?:\/|[a-z]:\/)/i.test(supplied)) {
    throw new Error(`${errorPrefix} ${field}: expected relative path without traversal`);
  }
  const raw = supplied.replace(/\/+$/g, '');
  if (!raw || raw === '.') return '';
  const parts = raw.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`${errorPrefix} ${field}: expected relative path without traversal`);
  }
  return raw;
}

export function normalizeRuntimeBoundaryAppHook(rawAdapter, options = {}) {
  const errorPrefix = options.errorPrefix ?? 'invalid runtime boundary app hook';
  const fieldPrefix = options.fieldPrefix ?? 'runtimeAdapter';
  const declared = options.declared ?? (rawAdapter !== undefined && rawAdapter !== null);
  const adapter = optionalObject(rawAdapter, fieldPrefix, errorPrefix);
  const enabled = declared
    ? optionalBoolean(adapter.enabled, `${fieldPrefix}.enabled`, errorPrefix) ?? true
    : false;
  const template = optionalString(
    adapter.template ?? adapter.adapterTemplate ?? adapter.adapter_template,
    `${fieldPrefix}.template`,
    errorPrefix,
  );
  const command = optionalString(
    adapter.command ?? adapter.shellCommand ?? adapter.shell_command ?? options.defaultCommand,
    `${fieldPrefix}.command`,
    errorPrefix,
  );
  if (enabled && !command) {
    throw new Error(
      options.missingCommandMessage
        ?? `${errorPrefix} ${fieldPrefix}.enabled=true requires ${fieldPrefix}.command`,
    );
  }
  const workingDirectory = normalizeRuntimeBoundaryAppHookRelativePath(
    adapter.workingDirectory ?? adapter.working_directory ?? adapter.cwd,
    `${fieldPrefix}.workingDirectory`,
    errorPrefix,
  );
  const resultPath = normalizeRuntimeBoundaryAppHookRelativePath(
    adapter.resultPath
      ?? adapter.result_path
      ?? adapter.adapterResultPath
      ?? adapter.adapter_result_path,
    `${fieldPrefix}.resultPath`,
    errorPrefix,
  );
  const eventManifestPath = normalizeRuntimeBoundaryAppHookRelativePath(
    adapter.eventManifestPath
      ?? adapter.event_manifest_path
      ?? adapter.runtimeBoundaryEventManifestPath
      ?? adapter.runtime_boundary_event_manifest_path
      ?? adapter.boundaryEventManifestPath
      ?? adapter.boundary_event_manifest_path,
    `${fieldPrefix}.eventManifestPath`,
    errorPrefix,
  );
  const timeout = optionalNumber(
    adapter.timeoutMs ?? adapter.timeout_ms,
    `${fieldPrefix}.timeoutMs`,
    errorPrefix,
  );
  const timeoutMs = timeout === null
    ? Math.max(1000, Math.trunc(options.defaultTimeoutMs ?? 300000))
    : Math.max(1000, Math.trunc(timeout));
  const runWhen = optionalString(
    adapter.runWhen ?? adapter.run_when,
    `${fieldPrefix}.runWhen`,
    errorPrefix,
  ) || options.defaultRunWhen || DEFAULT_RUN_WHEN;
  const allowedRunWhen = options.allowedRunWhen ?? ALLOWED_RUN_WHEN;
  if (!allowedRunWhen.has(runWhen)) {
    throw new Error(
      options.unsupportedRunWhenMessage?.(runWhen)
        ?? `${errorPrefix} ${fieldPrefix}.runWhen: unsupported value ${runWhen}`,
    );
  }
  const requiresSuccessfulBuild = optionalBoolean(
    adapter.requiresSuccessfulBuild ?? adapter.requires_successful_build,
    `${fieldPrefix}.requiresSuccessfulBuild`,
    errorPrefix,
  ) ?? (runWhen === DEFAULT_RUN_WHEN);
  const requiresSuccessfulRun = optionalBoolean(
    adapter.requiresSuccessfulRun ?? adapter.requires_successful_run,
    `${fieldPrefix}.requiresSuccessfulRun`,
    errorPrefix,
  ) ?? false;
  const appendRunLog = optionalBoolean(
    adapter.appendRunLog ?? adapter.append_run_log,
    `${fieldPrefix}.appendRunLog`,
    errorPrefix,
  ) ?? true;
  const evidenceRefs = optionalStringList(
    adapter.evidenceRefs ?? adapter.evidence_refs ?? adapter.evidenceRef ?? adapter.evidence_ref,
    `${fieldPrefix}.evidenceRefs`,
    errorPrefix,
  );
  const commandHash = command ? sha256Bytes(Buffer.from(command, 'utf8')) : null;
  const schemaVersion = options.schemaVersion ?? GPU_HMR_RUNTIME_BOUNDARY_APP_HOOK_SCHEMA_VERSION;
  const proofAuthority = options.proofAuthority ?? GPU_HMR_RUNTIME_BOUNDARY_APP_HOOK_AUTHORITY;

  return {
    schemaVersion,
    schema_version: schemaVersion,
    declared,
    enabled,
    proofAuthority,
    proof_authority: proofAuthority,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    command,
    commandHash,
    command_hash: commandHash,
    template: template || null,
    adapterTemplate: template || null,
    adapter_template: template || null,
    workingDirectory,
    working_directory: workingDirectory,
    resultPath,
    result_path: resultPath,
    eventManifestPath,
    event_manifest_path: eventManifestPath,
    timeoutMs,
    timeout_ms: timeoutMs,
    runWhen,
    run_when: runWhen,
    requiresSuccessfulBuild,
    requires_successful_build: requiresSuccessfulBuild,
    requiresSuccessfulRun,
    requires_successful_run: requiresSuccessfulRun,
    appendRunLog,
    append_run_log: appendRunLog,
    evidenceRefs,
    evidence_refs: evidenceRefs,
  };
}

export function runtimeBoundaryAppHookDeclaredResultPath(adapter = {}, overridePath = '') {
  return normalizeRuntimeBoundaryAppHookRelativePath(
    overridePath || adapter?.resultPath || adapter?.result_path || '',
    'runtimeAdapter.resultPath',
  );
}

export function runtimeBoundaryAppHookDeclaredEventManifestPath(
  adapter = {},
  overrideResultPath = '',
) {
  const explicit = normalizeRuntimeBoundaryAppHookRelativePath(
    adapter?.eventManifestPath ?? adapter?.event_manifest_path ?? '',
    'runtimeAdapter.eventManifestPath',
  );
  if (explicit) return explicit;
  const resultPath = runtimeBoundaryAppHookDeclaredResultPath(adapter, overrideResultPath);
  if (!resultPath) return '';
  const parts = resultPath.split('/');
  const fileName = parts.pop();
  const dot = fileName.lastIndexOf('.');
  const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
  const extension = dot > 0 ? fileName.slice(dot) : '.json';
  return [...parts, `${stem}-runtime-boundary-events${extension}`].join('/');
}

export function runtimeBoundaryAppHookEventManifestPathSource(
  adapter = {},
  overrideResultPath = '',
) {
  const explicit = normalizeRuntimeBoundaryAppHookRelativePath(
    adapter?.eventManifestPath ?? adapter?.event_manifest_path ?? '',
    'runtimeAdapter.eventManifestPath',
  );
  if (explicit) return 'declared';
  return runtimeBoundaryAppHookDeclaredEventManifestPath(adapter, overrideResultPath)
    ? 'derived_from_result_path'
    : 'none';
}

export function runtimeBoundaryAppHookWorkerPath(workerRepoRoot, relativePath) {
  const root = String(workerRepoRoot ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  const relative = normalizeRuntimeBoundaryAppHookRelativePath(relativePath);
  if (!root || !relative) return '';
  const resolved = path.posix.normalize(`${root}/${relative}`);
  return resolved === root || resolved.startsWith(`${root}/`) ? resolved : '';
}

export function runtimeBoundaryAppHookWorkerDirectory(
  adapter,
  workerRepoRoot,
  defaultWorkingDirectory = '',
) {
  const relative = adapter?.workingDirectory || adapter?.working_directory || defaultWorkingDirectory;
  if (!relative) return String(workerRepoRoot ?? '').trim().replace(/\\/g, '/').replace(/\/+$/g, '');
  return runtimeBoundaryAppHookWorkerPath(workerRepoRoot, relative);
}

export function runtimeBoundaryAppHookAuthorityClaimPaths(value) {
  const claims = [];
  const visit = (entry, location, seen) => {
    if (!entry || typeof entry !== 'object') return;
    if (seen.has(entry)) return;
    seen.add(entry);
    if (Array.isArray(entry)) {
      entry.forEach((item, index) => visit(item, `${location}[${index}]`, seen));
      return;
    }
    for (const [key, nested] of Object.entries(entry)) {
      const normalizedKey = normalizedAuthorityKey(key);
      const nestedLocation = location ? `${location}.${key}` : key;
      if (AUTHORITY_BOOLEAN_KEYS.has(normalizedKey) && nested === true) {
        claims.push(nestedLocation);
      }
      if (
        AUTHORITY_STRING_KEYS.has(normalizedKey)
        && typeof nested === 'string'
        && stringClaimsAuthority(nested)
      ) {
        claims.push(nestedLocation);
      }
      visit(nested, nestedLocation, seen);
    }
  };
  visit(value, '', new Set());
  return [...new Set(claims)].sort();
}

export function runtimeBoundaryAppHookClaimsAuthority(value) {
  return runtimeBoundaryAppHookAuthorityClaimPaths(value).length > 0;
}

export function buildRuntimeBoundaryAppHookExecutionScript(options = {}) {
  const adapter = options.adapter ?? {};
  const workingDirectory = options.workingDirectory;
  const workerTempDir = options.workerTempDir;
  const runLogPath = options.runLogPath ?? `${workerTempDir}/run.log`;
  const adapterLogPath = options.adapterLogPath ?? runLogPath;
  const identity = options.identity ?? 'runtime-boundary-app-hook';
  const commandHash = adapter.commandHash || adapter.command_hash || sha256Bytes(
    Buffer.from(String(adapter.command ?? ''), 'utf8'),
  );
  const sessionSuffix = options.sessionSuffix ?? 'runtime-boundary-app-hook';
  const timeoutSeconds = Math.max(1, Math.ceil(Number(adapter.timeoutMs ?? 300000) / 1000));
  const resultPath = options.resultPath ?? '';
  const eventManifestPath = options.eventManifestPath ?? '';
  const displayResultPath = options.displayResultPath ?? adapter.resultPath ?? 'none';
  const environment = {
    SYNTHI_GPU_HMR_RUNTIME_ADAPTER: '1',
    SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_ID: identity,
    SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_COMMAND_HASH: commandHash,
    ...options.environment,
    SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_RESULT_PATH: resultPath,
    SYNTHI_GPU_HMR_RUNTIME_ADAPTER_RESULT_PATH: resultPath,
    SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH: eventManifestPath,
    SYNTHI_GPU_HMR_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH: eventManifestPath,
  };
  const exports = Object.entries(environment)
    .map(([key, value]) => `    export ${key}=${shellQuote(value)}`)
    .join('\n');
  const directoryPrep = [resultPath, eventManifestPath]
    .filter(Boolean)
    .map((target) => `    mkdir -p "$(dirname ${shellQuote(target)})"`)
    .join('\n');

  return `
set +e
runtime_session="pid$$-${sessionSuffix}"
adapter_started=$(date +%s%3N)
adapter_status=started
adapter_exit_code=0
adapter_skip_reason=none
mkdir -p ${shellQuote(workerTempDir)}
touch ${shellQuote(runLogPath)}
printf '\\n[synthi-runtime-adapter] id=%s status=started command_hash=%s cwd=%s runtime_session=%s result_path=%s\\n' ${shellQuote(identity)} ${shellQuote(commandHash)} ${shellQuote(workingDirectory)} "$runtime_session" ${shellQuote(displayResultPath || 'none')} >> ${shellQuote(adapterLogPath)}
if [ ! -d ${shellQuote(workingDirectory)} ]; then
  adapter_status=failed
  adapter_exit_code=127
  adapter_skip_reason=runtime_adapter_working_directory_missing
  printf '[synthi-runtime-adapter] id=%s status=failed exit_code=127 reason=runtime_adapter_working_directory_missing cwd=%s\\n' ${shellQuote(identity)} ${shellQuote(workingDirectory)} >> ${shellQuote(adapterLogPath)}
else
  (
    cd ${shellQuote(workingDirectory)}
    export SYNTHI_REAL_ROCM_RUNTIME_SESSION="$runtime_session"
${exports}
${directoryPrep}
    if command -v timeout >/dev/null 2>&1; then
      timeout ${timeoutSeconds} sh -lc ${shellQuote(adapter.command)}
    else
      sh -lc ${shellQuote(adapter.command)}
    fi
  ) >> ${shellQuote(adapterLogPath)} 2>&1
  adapter_exit_code=$?
  if [ "$adapter_exit_code" = "0" ]; then
    adapter_status=pass
  else
    adapter_status=failed
    adapter_skip_reason=runtime_adapter_command_failed
  fi
fi
adapter_finished=$(date +%s%3N)
adapter_elapsed_ms=$((adapter_finished-adapter_started))
printf '[synthi-runtime-adapter] id=%s status=%s exit_code=%s skip_reason=%s elapsed_ms=%s command_hash=%s\\n' ${shellQuote(identity)} "$adapter_status" "$adapter_exit_code" "$adapter_skip_reason" "$adapter_elapsed_ms" ${shellQuote(commandHash)} >> ${shellQuote(adapterLogPath)}
printf 'runtime_adapter_status=%s\\nruntime_adapter_exit_code=%s\\nruntime_adapter_skip_reason=%s\\nruntime_adapter_ms=%s\\n' "$adapter_status" "$adapter_exit_code" "$adapter_skip_reason" "$adapter_elapsed_ms"
exit 0
`;
}

export async function executeRuntimeBoundaryAppHookCommand(options = {}) {
  const adapter = options.adapter ?? {};
  const workerContext = options.workerContext ?? {};
  const blockingGaps = [];
  let timings = '';
  let script = '';
  let attempted = false;
  const declared = adapter.declared === true;
  const enabled = adapter.enabled === true;
  const resultPath = runtimeBoundaryAppHookDeclaredResultPath(
    adapter,
    options.resultPathOverride ?? '',
  );
  const eventManifestPath = runtimeBoundaryAppHookDeclaredEventManifestPath(
    adapter,
    options.resultPathOverride ?? '',
  );
  const workerResultPath = runtimeBoundaryAppHookWorkerPath(options.workerRepoRoot, resultPath);
  const workerEventManifestPath = runtimeBoundaryAppHookWorkerPath(
    options.workerRepoRoot,
    eventManifestPath,
  );
  const workingDirectory = runtimeBoundaryAppHookWorkerDirectory(
    adapter,
    options.workerRepoRoot,
    options.defaultWorkingDirectory ?? '',
  );

  if (!declared) {
    blockingGaps.push('runtime_boundary_app_hook_missing');
    timings = failedExecutionTimings('runtime_boundary_app_hook_missing');
  } else if (!enabled) {
    blockingGaps.push('runtime_boundary_app_hook_disabled');
    timings = failedExecutionTimings('runtime_boundary_app_hook_disabled');
  } else if (!adapter.command) {
    blockingGaps.push('runtime_boundary_app_hook_command_missing');
    timings = failedExecutionTimings('runtime_boundary_app_hook_command_missing');
  } else if (!resultPath || !workerResultPath) {
    blockingGaps.push('runtime_boundary_app_hook_result_path_missing');
    timings = failedExecutionTimings('runtime_boundary_app_hook_result_path_missing');
  } else if (!workingDirectory) {
    blockingGaps.push('runtime_boundary_app_hook_working_directory_invalid');
    timings = failedExecutionTimings('runtime_boundary_app_hook_working_directory_invalid');
  } else if (workerContext.available !== true || typeof workerContext.executeShell !== 'function') {
    blockingGaps.push('runtime_boundary_app_hook_worker_unavailable');
    timings = failedExecutionTimings('runtime_boundary_app_hook_worker_unavailable', '127');
  } else {
    script = buildRuntimeBoundaryAppHookExecutionScript({
      adapter,
      workingDirectory,
      workerTempDir: options.workerTempDir,
      runLogPath: options.runLogPath,
      adapterLogPath: options.adapterLogPath,
      identity: options.identity,
      sessionSuffix: options.sessionSuffix,
      environment: options.environment,
      resultPath: workerResultPath,
      eventManifestPath: workerEventManifestPath,
      displayResultPath: resultPath,
    });
    attempted = true;
    try {
      timings = await workerContext.executeShell(
        script,
        Number(adapter.timeoutMs ?? 300000) + 30000,
      );
    } catch {
      timings = '';
    }
    if (!String(timings ?? '').trim()) {
      timings = failedExecutionTimings('runtime_adapter_execution_unavailable', 'timeout');
    }
  }

  const rawStatus = metricValue(timings, 'runtime_adapter_status');
  if (rawStatus !== 'pass') {
    blockingGaps.push(
      rawStatus === 'failed'
        ? 'runtime_boundary_app_hook_command_failed'
        : 'runtime_boundary_app_hook_execution_not_observed',
    );
  }
  const runLogPath = options.runLogPath ?? `${options.workerTempDir}/run.log`;
  const adapterLogPath = options.adapterLogPath ?? runLogPath;
  const readText = typeof workerContext.readText === 'function'
    ? workerContext.readText.bind(workerContext)
    : async () => '';
  const runLog = attempted ? String(await readText(runLogPath, 30000) ?? '') : '';
  const adapterOnlyLog = attempted && adapter.appendRunLog === false
    ? String(await readText(adapterLogPath, 30000) ?? '')
    : '';
  const uniqueGaps = [...new Set(blockingGaps)];
  return {
    schemaVersion: 'synthi.gpu_hmr.runtime_boundary_app_hook_execution_attempt.v1',
    schema_version: 'synthi.gpu_hmr.runtime_boundary_app_hook_execution_attempt.v1',
    proofAuthority: 'app_hook_execution_attempt_only_not_gpu_hmr_success',
    proof_authority: 'app_hook_execution_attempt_only_not_gpu_hmr_success',
    declared,
    enabled,
    attempted,
    status: rawStatus === 'pass' ? 'runtime_boundary_app_hook_executed' : 'runtime_boundary_app_hook_failed',
    rawStatus,
    raw_status: rawStatus,
    timings,
    runLog,
    run_log: runLog,
    adapterOnlyLog,
    adapter_only_log: adapterOnlyLog,
    script,
    workingDirectory,
    working_directory: workingDirectory,
    declaredResultPath: resultPath || null,
    declared_result_path: resultPath || null,
    workerResultPath: workerResultPath || null,
    worker_result_path: workerResultPath || null,
    declaredEventManifestPath: eventManifestPath || null,
    declared_event_manifest_path: eventManifestPath || null,
    workerEventManifestPath: workerEventManifestPath || null,
    worker_event_manifest_path: workerEventManifestPath || null,
    acceptedAsSupportEvidence: rawStatus === 'pass' && uniqueGaps.length === 0,
    accepted_as_support_evidence: rawStatus === 'pass' && uniqueGaps.length === 0,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    blockingGaps: uniqueGaps,
    blocking_gaps: uniqueGaps,
  };
}

export async function transportRuntimeBoundaryAppHookArtifact(options = {}) {
  const adapter = options.adapter ?? {};
  const workerContext = options.workerContext ?? {};
  const kind = options.kind === 'event_manifest' ? 'event_manifest' : 'result';
  const prefix = options.gapPrefix
    ?? (kind === 'result'
      ? 'runtime_boundary_app_hook_result_transport'
      : 'runtime_boundary_app_hook_event_manifest_transport');
  const declaredPath = normalizeRuntimeBoundaryAppHookRelativePath(
    options.declaredPath ?? '',
    kind === 'result' ? 'runtimeAdapter.resultPath' : 'runtimeAdapter.eventManifestPath',
  );
  const hostRepoRoot = path.resolve(options.hostRepoRoot ?? '');
  const allowedHostRoots = (options.allowedHostRoots?.length
    ? options.allowedHostRoots
    : [hostRepoRoot]).map((root) => path.resolve(root));
  const hostPath = declaredPath ? path.resolve(hostRepoRoot, declaredPath) : null;
  const hostPathAllowed = Boolean(
    hostPath
    && pathIsInside(hostRepoRoot, hostPath)
    && allowedHostRoots.some((root) => pathIsInside(root, hostPath)),
  );
  const workerPath = runtimeBoundaryAppHookWorkerPath(options.workerRepoRoot, declaredPath);
  const statusNames = {
    notDeclared: `${prefix}_not_declared`,
    refused: `${prefix}_refused`,
    missing: `${prefix}_${kind === 'result' ? 'refused' : 'missing'}`,
    copied: `${prefix}_copied`,
    ...(options.statusNames ?? {}),
  };
  const gapNames = {
    pathMissing: `${prefix}_path_missing`,
    pathOutside: `${prefix}_path_outside_allowed_roots`,
    workerPathInvalid: `${prefix}_worker_path_invalid`,
    workerUnavailable: `${prefix}_worker_unavailable`,
    workerFileMissing: `${prefix}_worker_file_missing`,
    copiedBytesMissing: `${prefix}_copied_bytes_missing`,
    payloadInvalid: `${prefix}_payload_invalid`,
    authorityClaimed: `${prefix}_payload_claimed_authority`,
    ...(options.gapNames ?? {}),
  };
  const schemaVersion = options.schemaVersion
    ?? `synthi.gpu_hmr.runtime_boundary_app_hook_${kind}_transport.v1`;
  const proofAuthority = options.proofAuthority
    ?? `runtime_boundary_app_hook_${kind}_transport_only_not_gpu_hmr_success`;
  const facet = {
    schemaVersion,
    schema_version: schemaVersion,
    proofAuthority,
    proof_authority: proofAuthority,
    declared: Boolean(declaredPath),
    adapterTemplate: adapter.template ?? adapter.adapterTemplate ?? null,
    adapter_template: adapter.template ?? adapter.adapterTemplate ?? null,
    adapterCommandHash: adapter.commandHash ?? adapter.command_hash ?? null,
    adapter_command_hash: adapter.commandHash ?? adapter.command_hash ?? null,
    declaredPath: declaredPath || null,
    declared_path: declaredPath || null,
    hostPath: hostPathAllowed
      ? path.relative(hostRepoRoot, hostPath).replace(/\\/g, '/')
      : null,
    host_path: hostPathAllowed
      ? path.relative(hostRepoRoot, hostPath).replace(/\\/g, '/')
      : null,
    workerPath: workerPath || null,
    worker_path: workerPath || null,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    copied: false,
    payloadValidated: false,
    payload_validated: false,
    authorityClaimPaths: [],
    authority_claim_paths: [],
    byteLength: 0,
    byte_length: 0,
    rawSha256: null,
    raw_sha256: null,
    blockingGaps: [],
    blocking_gaps: [],
    evidenceRefs: [],
    evidence_refs: [],
  };

  if (!declaredPath) {
    facet.status = statusNames.notDeclared;
    if (options.required === true) facet.blockingGaps.push(gapNames.pathMissing);
  } else if (!hostPathAllowed || !await hostPathIsCanonicallyContained(hostPath, allowedHostRoots)) {
    facet.status = statusNames.refused;
    facet.blockingGaps.push(gapNames.pathOutside);
  } else if (!workerPath) {
    facet.status = statusNames.refused;
    facet.blockingGaps.push(gapNames.workerPathInvalid);
  } else if (
    workerContext.available !== true
    || typeof workerContext.existsNonEmpty !== 'function'
    || typeof workerContext.copyToHost !== 'function'
  ) {
    facet.status = statusNames.refused;
    facet.blockingGaps.push(gapNames.workerUnavailable);
  } else if (!await workerContext.existsNonEmpty(workerPath, 30000)) {
    facet.status = statusNames.missing;
    facet.blockingGaps.push(gapNames.workerFileMissing);
  } else {
    await mkdir(path.dirname(hostPath), { recursive: true });
    if (!await hostPathIsCanonicallyContained(hostPath, allowedHostRoots)) {
      facet.status = statusNames.refused;
      facet.blockingGaps.push(gapNames.pathOutside);
    } else {
      await workerContext.copyToHost(workerPath, hostPath, 120000);
      const canonicalHostPath = await realpath(hostPath).catch(() => null);
      if (
        !canonicalHostPath
        || !(await canonicalAllowedRoots(allowedHostRoots)).some((root) =>
          pathIsInside(root, canonicalHostPath)
        )
      ) {
        facet.status = statusNames.refused;
        facet.blockingGaps.push(gapNames.pathOutside);
      } else {
        const bytes = await readFile(canonicalHostPath);
        facet.copied = true;
        facet.byteLength = bytes.length;
        facet.byte_length = bytes.length;
        facet.rawSha256 = sha256Bytes(bytes);
        facet.raw_sha256 = facet.rawSha256;
        facet.evidenceRefs.push(facet.rawSha256);
        if (bytes.length === 0) {
          facet.blockingGaps.push(gapNames.copiedBytesMissing);
        } else {
          let parsed = null;
          try {
            parsed = JSON.parse(bytes.toString('utf8'));
          } catch {
            parsed = null;
          }
          const validShape = kind === 'event_manifest'
            ? Boolean(parsed && (Array.isArray(parsed) || typeof parsed === 'object'))
            : Boolean(parsed && typeof parsed === 'object' && !Array.isArray(parsed));
          if (!validShape) {
            facet.blockingGaps.push(gapNames.payloadInvalid);
          } else {
            facet.payloadValidated = true;
            facet.payload_validated = true;
            facet.authorityClaimPaths = runtimeBoundaryAppHookAuthorityClaimPaths(parsed);
            facet.authority_claim_paths = facet.authorityClaimPaths;
            if (facet.authorityClaimPaths.length > 0) {
              facet.blockingGaps.push(gapNames.authorityClaimed);
            }
          }
        }
        if (adapter.template) {
          facet.evidenceRefs.push(`runtime-adapter-template:${adapter.template}`);
        }
        if (adapter.commandHash) {
          facet.evidenceRefs.push(`runtime-adapter-command:${adapter.commandHash}`);
        }
        facet.status = facet.blockingGaps.length === 0 ? statusNames.copied : statusNames.refused;
      }
    }
  }

  facet.blockingGaps = [...new Set(facet.blockingGaps)];
  facet.blocking_gaps = facet.blockingGaps;
  facet.evidenceRefs = [...new Set(facet.evidenceRefs)];
  facet.evidence_refs = facet.evidenceRefs;
  facet.accepted = facet.declared !== true
    ? options.required !== true
    : facet.copied === true
      && facet.payloadValidated === true
      && facet.blockingGaps.length === 0;
  return facet;
}
