#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION,
  loadRuntimeProofProfileFromEnv,
  normalizeRuntimeProofProfile,
  runtimeProfileToHiprtWarmEnv,
} from './lib/gpu-hmr-runtime-profile.mjs';
import { runtimeProofArtifactStrictGate } from './lib/gpu-hmr-proof-strict-gates.mjs';
import {
  buildRuntimeBoundaryProofAdapter,
  materializeRuntimeBoundaryEventLines,
} from './lib/gpu-hmr-runtime-boundary-proof-adapter.mjs';
import {
  GPU_HMR_TEST_TIMING_PHASE_KEYS,
  GPU_HMR_TEST_TIMING_SCHEMA,
  GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS,
  GpuHmrTestTimingRecorder,
  validateGpuHmrTestTiming,
} from './lib/gpu-hmr-test-timing-v2.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROFILE_DIR = path.resolve(REPO_ROOT, 'mcp/synthi-mcp/scripts/profiles');
const RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA =
  'synthi.gpu_hmr.runtime_boundary_event_manifest.v1';
const RUNTIME_BOUNDARY_PROFILE_ADAPTER_PROOF_SCHEMA =
  'synthi.gpu_hmr.runtime_profile_boundary_adapter_proof.v1';
const RUNTIME_BOUNDARY_PROFILE_ADAPTER_PROOF_AUTHORITY =
  'runtime_profile_generic_runtime_boundary_adapter_not_success_authority';
const RUNTIME_PROFILE_FAILURE_SCHEMA = 'synthi.gpu_hmr.runtime_profile_failure.v1';
const RUNTIME_PROFILE_FAILURE_AUTHORITY =
  'runtime_profile_failure_diagnostics_only_not_gpu_hmr_success';
const RUNTIME_PROFILE_TIMING_CHILD_PHASE_UNAVAILABLE =
  'runtime_profile_child_phase_boundary_not_observed_by_parent';
const RUNTIME_PROFILE_TIMING_RESULT_ONLY_PHASE_UNAVAILABLE =
  'runtime_profile_parent_phase_boundary_not_observed_by_result_writer';
const RUNTIME_PROFILE_TIMING_VISUAL_UNAVAILABLE =
  'runtime_profile_causal_child_visual_boundary_not_observed_by_parent';
const RUNTIME_PROFILE_TIMING_VISUAL_NOT_APPLICABLE =
  'runtime_profile_has_no_visual_oracle_contract_or_evidence';
const RUNTIME_PROFILE_TIMING_SPLIT_NOT_APPLICABLE =
  'runtime_profile_runner_does_not_perform_source_split';
const RUNTIME_PROFILE_TIMING_PERSISTENCE_CHECKPOINT_SCHEMA =
  'synthi.gpu_hmr.runtime_profile_timing_persistence_checkpoint.v1';
const RUNTIME_PROFILE_TIMING_PERSISTENCE_CHECKPOINT_AUTHORITY =
  'result_persistence_checkpoint_only_not_gpu_hmr_success';
const RUNTIME_PROFILE_TIMING_SCOPES = new WeakMap();

const ADAPTERS = new Map([
  ['hiprt-path-tracer', {
    runner: path.resolve(__dirname, 'hiprt-light-math-warm-proof.mjs'),
    runnerKind: 'node-script',
    envKind: 'hiprt-warm',
  }],
]);

function parseArgs(argv) {
  const parsed = {
    selfCheck: false,
    profilePath: '',
    profileJson: '',
    mode: '',
    resultPath: '',
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--self-check') {
      parsed.selfCheck = true;
      continue;
    }
    if (arg === '--profile' || arg === '--profile-path') {
      parsed.profilePath = argv[++index] ?? '';
      continue;
    }
    if (arg === '--profile-json') {
      parsed.profileJson = argv[++index] ?? '';
      continue;
    }
    if (arg === '--mode') {
      parsed.mode = argv[++index] ?? '';
      continue;
    }
    if (arg === '--result-path') {
      parsed.resultPath = argv[++index] ?? '';
      continue;
    }
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map((item) => stableJson(item)).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function sha256Text(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

function sha256Buffer(value) {
  return createHash('sha256').update(value).digest('hex');
}

function compactString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function firstString(...values) {
  for (const value of values) {
    const normalized = compactString(value);
    if (normalized) return normalized;
  }
  return null;
}

function firstBool(...values) {
  for (const value of values) {
    if (typeof value === 'boolean') return value;
  }
  return null;
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstObject(...values) {
  for (const value of values) {
    const object = objectOrNull(value);
    if (object) return object;
  }
  return null;
}

function firstArray(...values) {
  for (const value of values) {
    if (Array.isArray(value)) return value;
  }
  return [];
}

function firstStringArray(...values) {
  return firstArray(...values)
    .map((value) => compactString(value))
    .filter(Boolean);
}

function claimsGpuHmrAuthority(value) {
  const object = objectOrNull(value) ?? {};
  return firstBool(object.acceptedForGpuHmr, object.accepted_for_gpu_hmr) === true
    || firstBool(object.gpuHmrSuccess, object.gpu_hmr_success) === true
    || firstBool(object.canSatisfyRuntimeProof, object.can_satisfy_runtime_proof) === true
    || firstBool(object.canSatisfyDispatchProof, object.can_satisfy_dispatch_proof) === true;
}

function timingAlias(source, camelKey, snakeKey, scope, { required = false } = {}) {
  const object = objectOrNull(source);
  const hasCamel = object ? Object.hasOwn(object, camelKey) : false;
  const hasSnake = object ? Object.hasOwn(object, snakeKey) : false;
  if (!hasCamel && !hasSnake && !required) return null;
  if (
    !hasCamel
    || !hasSnake
    || stableJson(object[camelKey]) !== stableJson(object[snakeKey])
  ) {
    throw new Error(`${scope}_aliases_invalid`);
  }
  return object[camelKey];
}

function assertSupportOnlyTestTiming(testTiming, scope = 'runtime_profile_test_timing') {
  const validation = validateGpuHmrTestTiming(testTiming);
  if (
    testTiming?.schema !== GPU_HMR_TEST_TIMING_SCHEMA
    || validation.valid !== true
    || testTiming.authority !== 'timing_only'
    || testTiming.timingOnly !== true
    || testTiming.acceptedForGpuHmr !== false
    || testTiming.gpuHmrSuccess !== false
  ) {
    throw new Error(`${scope}_invalid`);
  }
  return testTiming;
}

function createRuntimeProfileTimingRecorder({
  clock = () => process.hrtime.bigint(),
  scope = 'run',
} = {}) {
  if (!['run', 'result_only', 'top_level'].includes(scope)) {
    throw new TypeError('runtime_profile_timing_scope_invalid');
  }
  const recorder = new GpuHmrTestTimingRecorder({ clock });
  const parentObserved = new Set(
    scope === 'run'
      ? ['cold_intake', 'discovery', 'proof_finalization']
      : ['proof_finalization'],
  );
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    if (
      phaseKey === 'total_wall'
      || parentObserved.has(phaseKey)
      || GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.includes(phaseKey)
    ) {
      continue;
    }
    if (phaseKey === 'split') {
      recorder.notApplicable(phaseKey, RUNTIME_PROFILE_TIMING_SPLIT_NOT_APPLICABLE);
    } else {
      recorder.unavailable(
        phaseKey,
        scope === 'run'
          ? RUNTIME_PROFILE_TIMING_CHILD_PHASE_UNAVAILABLE
          : RUNTIME_PROFILE_TIMING_RESULT_ONLY_PHASE_UNAVAILABLE,
      );
    }
  }
  RUNTIME_PROFILE_TIMING_SCOPES.set(recorder, scope);
  return recorder;
}

function proofVisualEvidencePresent(proof) {
  const source = objectOrNull(proof) ?? {};
  const runtimeProofArtifact = firstObject(
    source.runtimeProofArtifact,
    source.runtime_proof_artifact,
    source.strictRuntimeProofArtifact,
    source.strict_runtime_proof_artifact,
  ) ?? {};
  return Boolean(firstObject(
    source.visualOracleArtifacts,
    source.visual_oracle_artifacts,
    runtimeProofArtifact.visualOracleArtifacts,
    runtimeProofArtifact.visual_oracle_artifacts,
  )) || firstArray(
    source.visualEvidenceArtifacts,
    source.visual_evidence_artifacts,
    runtimeProofArtifact.visualEvidenceArtifacts,
    runtimeProofArtifact.visual_evidence_artifacts,
  ).length > 0;
}

function runtimeProfileVisualCapable(profile, proof, childTestTiming = null) {
  return Boolean(
    objectOrNull(profile?.deterministicVisualMode)
    || proofVisualEvidencePresent(proof)
    || childTestTiming?.visualCapable === true
  );
}

function childTestTimingFromProof(proof) {
  const source = objectOrNull(proof) ?? {};
  const runtimeProofArtifact = firstObject(
    source.runtimeProofArtifact,
    source.runtime_proof_artifact,
    source.strictRuntimeProofArtifact,
    source.strict_runtime_proof_artifact,
  );
  const carriers = [
    ['proof', source],
    ['runtime_proof_artifact', runtimeProofArtifact],
  ];
  const acceptedRecords = [];
  const blockingGaps = [];
  let present = false;
  for (const [carrierName, carrier] of carriers) {
    if (!carrier) continue;
    const hasCamel = Object.hasOwn(carrier, 'testTiming');
    const hasSnake = Object.hasOwn(carrier, 'test_timing');
    if (!hasCamel && !hasSnake) continue;
    present = true;
    if (!hasCamel || !hasSnake) {
      blockingGaps.push(`runtime_profile_child_timing_alias_missing:${carrierName}`);
      continue;
    }
    if (stableJson(carrier.testTiming) !== stableJson(carrier.test_timing)) {
      blockingGaps.push(`runtime_profile_child_timing_alias_conflict:${carrierName}`);
      continue;
    }
    const validation = validateGpuHmrTestTiming(carrier.testTiming);
    if (
      validation.valid !== true
      || carrier.testTiming?.schema !== GPU_HMR_TEST_TIMING_SCHEMA
      || carrier.testTiming?.authority !== 'timing_only'
      || carrier.testTiming?.timingOnly !== true
      || carrier.testTiming?.acceptedForGpuHmr !== false
      || carrier.testTiming?.gpuHmrSuccess !== false
    ) {
      blockingGaps.push(`runtime_profile_child_timing_invalid:${carrierName}`);
      continue;
    }
    acceptedRecords.push(carrier.testTiming);
  }
  if (
    acceptedRecords.length > 1
    && acceptedRecords.some((record) => stableJson(record) !== stableJson(acceptedRecords[0]))
  ) {
    blockingGaps.push('runtime_profile_child_timing_carrier_conflict');
  }
  const accepted = present && blockingGaps.length === 0 && acceptedRecords.length > 0;
  return {
    present,
    accepted,
    testTiming: accepted ? acceptedRecords[0] : null,
    blockingGaps: [...new Set(blockingGaps)],
  };
}

function timingOutcome({
  runnerSucceeded,
  strictRuntimeProofAccepted,
  blockingGaps,
  persistenceFailed = false,
}) {
  if (!runnerSucceeded || persistenceFailed) return 'failed';
  if (strictRuntimeProofAccepted && blockingGaps.length === 0) return 'pass';
  return 'refused';
}

function finalizeRuntimeProfileTiming(recorder, {
  outcome,
  visualCapable,
  terminalReason,
}) {
  if (!RUNTIME_PROFILE_TIMING_SCOPES.has(recorder) || recorder.isFinalized) {
    throw new Error('runtime_profile_timing_recorder_invalid');
  }
  if (visualCapable) {
    for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
      recorder.unavailable(phaseKey, RUNTIME_PROFILE_TIMING_VISUAL_UNAVAILABLE);
    }
  }
  const testTiming = recorder.finalize({
    outcome,
    visualCapable,
    terminalReason,
    notApplicableReason: RUNTIME_PROFILE_TIMING_VISUAL_NOT_APPLICABLE,
  });
  return assertSupportOnlyTestTiming(testTiming);
}

function ensureRuntimeProfilePhaseStarted(recorder, phaseKey) {
  try {
    recorder.startPhase(phaseKey);
    return 'started';
  } catch (error) {
    if (
      error?.code === 'timing_phase_transition_invalid'
      && ['started', 'finished'].includes(error?.details?.actualTransition)
    ) {
      return error.details.actualTransition;
    }
    throw error;
  }
}

function attachRuntimeProfileTiming(target, testTiming, childTestTiming = null) {
  if (!objectOrNull(target)) throw new TypeError('runtime_profile_timing_target_invalid');
  assertSupportOnlyTestTiming(testTiming);
  const existing = timingAlias(
    target,
    'testTiming',
    'test_timing',
    'runtime_profile_test_timing',
  );
  if (existing && stableJson(existing) !== stableJson(testTiming)) {
    throw new Error('runtime_profile_test_timing_aliases_invalid');
  }
  target.testTiming = testTiming;
  target.test_timing = testTiming;
  if (childTestTiming !== null) {
    assertSupportOnlyTestTiming(childTestTiming, 'runtime_profile_child_test_timing');
    const existingChild = timingAlias(
      target,
      'childTestTiming',
      'child_test_timing',
      'runtime_profile_child_test_timing',
    );
    if (existingChild && stableJson(existingChild) !== stableJson(childTestTiming)) {
      throw new Error('runtime_profile_child_test_timing_aliases_invalid');
    }
    target.childTestTiming = childTestTiming;
    target.child_test_timing = childTestTiming;
  }
  return target;
}

function syntheticSupportOnlyTestTiming({
  outcome = 'pass',
  visualCapable = false,
} = {}) {
  let nowNs = 0n;
  const recorder = new GpuHmrTestTimingRecorder({
    clock: () => {
      nowNs += 10n;
      return nowNs;
    },
  });
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    if (phaseKey === 'total_wall') continue;
    if (!visualCapable && GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.includes(phaseKey)) {
      recorder.notApplicable(phaseKey, RUNTIME_PROFILE_TIMING_VISUAL_NOT_APPLICABLE);
    } else {
      recorder.unavailable(phaseKey, 'synthetic_child_phase_not_observed');
    }
  }
  return assertSupportOnlyTestTiming(recorder.finalize({
    outcome,
    visualCapable,
    terminalReason: `synthetic_child_${outcome}`,
    notApplicableReason: RUNTIME_PROFILE_TIMING_VISUAL_NOT_APPLICABLE,
  }));
}

function adapterForProfile(profile) {
  if (
    profile.adapter.proofRunner === 'runtime-boundary-proof-adapter'
    || profile.adapter.runnerKind === 'runtime-boundary-proof-adapter'
  ) {
    return {
      runner: path.resolve(__dirname, 'lib/gpu-hmr-runtime-boundary-proof-adapter.mjs'),
      runnerKind: 'runtime-boundary-proof-adapter',
      runnerArgs: [],
      envKind: 'generic-profile',
    };
  }
  const adapter = ADAPTERS.get(profile.adapter.family);
  if (adapter) return adapter;
  if (profile.adapter.runnerPath) {
    const runnerKind = profile.adapter.runnerKind ?? 'process';
    if (!['node-script', 'process'].includes(runnerKind)) {
      throw new Error(`unsupported profile adapter runner kind: ${runnerKind}`);
    }
    return {
      runner: resolveProfileRunnerPath(profile.adapter.runnerPath),
      runnerKind,
      runnerArgs: profile.adapter.runnerArgs ?? [],
      envKind: 'generic-profile',
    };
  }
  const supported = Array.from(ADAPTERS.keys()).sort();
  throw new Error(
    `unsupported runtime adapter family "${profile.adapter.family}". `
    + 'Add a built-in adapter or provide adapter.runnerPath in the profile instead of hardcoding project behavior. '
    + `supported=${supported.join(',')}`,
  );
}

function isInsideDirectory(baseDir, targetPath) {
  const relative = path.relative(baseDir, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveProfileRunnerPath(runnerPath) {
  const raw = String(runnerPath);
  if (path.isAbsolute(raw)) {
    if (process.env.SYNTHI_GPU_HMR_RUNTIME_ALLOW_ABSOLUTE_ADAPTER_RUNNER !== '1') {
      throw new Error(
        'absolute adapter.runnerPath is disabled by default; set '
        + 'SYNTHI_GPU_HMR_RUNTIME_ALLOW_ABSOLUTE_ADAPTER_RUNNER=1 to opt in',
      );
    }
    return raw;
  }
  const resolved = path.resolve(REPO_ROOT, raw);
  if (!isInsideDirectory(REPO_ROOT, resolved)) {
    throw new Error(`adapter.runnerPath must stay inside the repo: ${runnerPath}`);
  }
  return resolved;
}

function spawnWithCapturedOutput(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stdout += text;
      process.stdout.write(text);
    });
    child.stderr?.on('data', (chunk) => {
      const text = chunk.toString('utf8');
      stderr += text;
      process.stderr.write(text);
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve({ exitCode: 128, signal, stdout, stderr });
        return;
      }
      resolve({ exitCode: code ?? 1, signal: null, stdout, stderr });
    });
  });
}

function spawnNodeScript(scriptPath, env, runnerArgs = []) {
  return spawnWithCapturedOutput(process.execPath, [scriptPath, ...runnerArgs], env);
}

function spawnProcess(command, args, env) {
  return spawnWithCapturedOutput(command, args, env);
}

function envForAdapter(profile, adapter) {
  const env = {
    ...process.env,
    SYNTHI_GPU_HMR_RUNTIME_PROFILE_ID: profile.id,
    SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON: JSON.stringify(profile),
  };
  if (profile.runtime.mode) env.SYNTHI_GPU_HMR_RUNTIME_MODE = profile.runtime.mode;
  if (adapter.envKind === 'hiprt-warm') {
    Object.assign(env, runtimeProfileToHiprtWarmEnv(profile));
  }
  return env;
}

function resolveResultPath(rawPath) {
  const raw = compactString(rawPath);
  if (!raw) return null;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(REPO_ROOT, raw);
  if (!isInsideDirectory(REPO_ROOT, resolved)) {
    throw new Error(`runtime profile result path must stay inside the repo: ${rawPath}`);
  }
  return resolved;
}

function resolveRuntimeBoundaryManifestPath(rawPath) {
  const raw = compactString(rawPath);
  if (!raw) return { path: null, relativePath: null, error: null };
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(REPO_ROOT, raw);
  if (!isInsideDirectory(REPO_ROOT, resolved)) {
    return {
      path: null,
      relativePath: null,
      error: `runtime boundary event manifest path must stay inside the repo: ${rawPath}`,
    };
  }
  return {
    path: resolved,
    relativePath: path.relative(REPO_ROOT, resolved).replace(/\\/g, '/'),
    error: null,
  };
}

function resolveProofPath(rawPath) {
  const raw = compactString(rawPath);
  if (!raw) return null;
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(REPO_ROOT, raw);
  if (!isInsideDirectory(REPO_ROOT, resolved)) return null;
  return resolved;
}

function parseJsonLine(line) {
  const trimmed = String(line ?? '').trim();
  if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function proofPathFromRunnerOutput(output) {
  const lines = String(output ?? '').split(/\r?\n/);
  for (const line of [...lines].reverse()) {
    const match = /^\s*(proof_json|proofPath|proof_path|proof)\s*[:=]\s*(.+?)\s*$/.exec(line);
    if (match?.[2]) return match[2].replace(/^["']|["']$/g, '');
    const parsed = parseJsonLine(line);
    const candidate = firstString(
      parsed?.proofPath,
      parsed?.proof_path,
      parsed?.proofJson,
      parsed?.proof_json,
      parsed?.artifactPath,
      parsed?.artifact_path,
    );
    if (candidate) return candidate;
  }
  return null;
}

async function readJsonIfPresent(filePath) {
  if (!filePath) return { present: false, value: null, error: null };
  try {
    const text = await fs.readFile(filePath, 'utf8');
    return {
      present: true,
      value: JSON.parse(text),
      rawSha256: `sha256:${sha256Text(text)}`,
      byteLength: Buffer.byteLength(text, 'utf8'),
      error: null,
    };
  } catch (err) {
    return {
      present: false,
      value: null,
      rawSha256: null,
      byteLength: 0,
      error: err?.message ?? String(err),
    };
  }
}

function runtimeBoundaryEventsFromManifest(object = {}) {
  const source = objectOrNull(object) ?? {};
  return [
    ...firstArray(source.runtimeBoundaryEvents),
    ...firstArray(source.runtime_boundary_events),
    ...firstArray(source.adapterRuntimeBoundaryEvents),
    ...firstArray(source.adapter_runtime_boundary_events),
    ...firstArray(source.events),
  ];
}

async function readRuntimeBoundaryEventManifest(profile) {
  const inlineEvents = firstArray(profile.adapter.runtimeBoundaryEvents);
  if (inlineEvents.length > 0) {
    const failedGates = [
      claimsGpuHmrAuthority(profile.adapter) ? 'runtime_boundary_profile_adapter_claims_gpu_hmr_authority' : null,
      inlineEvents.some((event) => claimsGpuHmrAuthority(event))
        ? 'runtime_boundary_event_manifest_event_claims_gpu_hmr_authority'
        : null,
    ].filter(Boolean);
    return {
      present: true,
      accepted: failedGates.length === 0,
      source: 'profile_inline_runtime_boundary_events',
      manifestPath: null,
      manifest_path: null,
      manifestSha256: `sha256:${sha256Text(stableJson(inlineEvents))}`,
      manifest_sha256: `sha256:${sha256Text(stableJson(inlineEvents))}`,
      manifestByteLength: Buffer.byteLength(stableJson(inlineEvents), 'utf8'),
      manifest_byte_length: Buffer.byteLength(stableJson(inlineEvents), 'utf8'),
      manifestSchemaVersion: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
      manifest_schema_version: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
      events: inlineEvents,
      metadata: profile.adapter.runtimeBoundaryAppHook ?? {},
      failedGates,
      failed_gates: failedGates,
    };
  }

  const resolved = resolveRuntimeBoundaryManifestPath(profile.adapter.runtimeBoundaryEventManifestPath);
  if (resolved.error) {
    return {
      present: true,
      accepted: false,
      source: 'profile_runtime_boundary_event_manifest_path',
      manifestPath: null,
      manifest_path: null,
      manifestSha256: null,
      manifest_sha256: null,
      manifestByteLength: 0,
      manifest_byte_length: 0,
      manifestSchemaVersion: null,
      manifest_schema_version: null,
      events: [],
      metadata: {},
      failedGates: ['runtime_boundary_event_manifest_path_outside_repo'],
      failed_gates: ['runtime_boundary_event_manifest_path_outside_repo'],
      readError: resolved.error,
      read_error: resolved.error,
    };
  }
  if (!resolved.path) {
    return {
      present: false,
      accepted: false,
      source: 'none',
      manifestPath: null,
      manifest_path: null,
      manifestSha256: null,
      manifest_sha256: null,
      manifestByteLength: 0,
      manifest_byte_length: 0,
      manifestSchemaVersion: null,
      manifest_schema_version: null,
      events: [],
      metadata: {},
      failedGates: ['runtime_boundary_event_manifest_missing'],
      failed_gates: ['runtime_boundary_event_manifest_missing'],
      readError: null,
      read_error: null,
    };
  }

  try {
    const text = await fs.readFile(resolved.path, 'utf8');
    const manifest = JSON.parse(text);
    const manifestObject = objectOrNull(manifest);
    const schemaVersion = firstString(
      manifestObject?.schemaVersion,
      manifestObject?.schema_version,
      manifestObject?.schema,
    );
    const events = runtimeBoundaryEventsFromManifest(manifestObject);
    const failedGates = [
      manifestObject ? null : 'runtime_boundary_event_manifest_not_object',
      schemaVersion === RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA
        ? null
        : 'runtime_boundary_event_manifest_schema_unsupported',
      claimsGpuHmrAuthority(manifestObject)
        ? 'runtime_boundary_event_manifest_claims_gpu_hmr_authority'
        : null,
      events.length > 0 ? null : 'runtime_boundary_event_manifest_events_missing',
      events.some((event) => claimsGpuHmrAuthority(event))
        ? 'runtime_boundary_event_manifest_event_claims_gpu_hmr_authority'
        : null,
    ].filter(Boolean);
    return {
      present: true,
      accepted: failedGates.length === 0,
      source: 'profile_runtime_boundary_event_manifest_path',
      manifestPath: resolved.relativePath,
      manifest_path: resolved.relativePath,
      manifestSha256: `sha256:${sha256Text(text)}`,
      manifest_sha256: `sha256:${sha256Text(text)}`,
      manifestByteLength: Buffer.byteLength(text, 'utf8'),
      manifest_byte_length: Buffer.byteLength(text, 'utf8'),
      manifestSchemaVersion: schemaVersion,
      manifest_schema_version: schemaVersion,
      events,
      metadata: manifestObject ?? {},
      failedGates,
      failed_gates: failedGates,
      readError: null,
      read_error: null,
    };
  } catch (error) {
    return {
      present: true,
      accepted: false,
      source: 'profile_runtime_boundary_event_manifest_path',
      manifestPath: resolved.relativePath,
      manifest_path: resolved.relativePath,
      manifestSha256: null,
      manifest_sha256: null,
      manifestByteLength: 0,
      manifest_byte_length: 0,
      manifestSchemaVersion: null,
      manifest_schema_version: null,
      events: [],
      metadata: {},
      failedGates: ['runtime_boundary_event_manifest_unreadable'],
      failed_gates: ['runtime_boundary_event_manifest_unreadable'],
      readError: error?.message ?? String(error),
      read_error: error?.message ?? String(error),
    };
  }
}

function runtimeBoundaryAdapterInputFromProfileAndManifest(profile, manifest) {
  const metadata = objectOrNull(manifest.metadata) ?? {};
  const adapterInput = firstObject(
    manifest.runtimeBoundaryAdapterInput,
    manifest.runtime_boundary_adapter_input,
    manifest.adapterInput,
    manifest.adapter_input,
    metadata.runtimeBoundaryAdapterInput,
    metadata.runtime_boundary_adapter_input,
    metadata.adapterInput,
    metadata.adapter_input,
  ) ?? {};
  const source = {
    ...metadata,
    ...manifest,
    ...adapterInput,
  };
  const sourcePaths = firstStringArray(source.sourcePaths, source.source_paths, [profile.source.file]);
  const sourceManifestHash = firstString(
    source.sourceManifestHash,
    source.source_manifest_hash,
    source.sourceTreeManifestHash,
    source.source_tree_manifest_hash,
    source.sourceIdentityHash,
    source.source_identity_hash,
  );
  const sourceManifestHashVerified =
    source.sourceManifestHashVerified === true
    || source.source_manifest_hash_verified === true
    || source.sourceTreeManifestHashVerified === true
    || source.source_tree_manifest_hash_verified === true
    || source.sourceIdentityHashVerified === true
    || source.source_identity_hash_verified === true;
  const sourceIdentityEvidenceRefs = firstStringArray(
    source.sourceIdentityEvidenceRefs,
    source.source_identity_evidence_refs,
    source.sourceManifestEvidenceRefs,
    source.source_manifest_evidence_refs,
  );
  return {
    backend: firstString(
      source.backend,
      source.gpuBackend,
      source.gpu_backend,
      profile.runtime.backend.orochiApi,
      'hip',
    ),
    projectId: firstString(source.projectId, source.project_id, source.workspaceSlug, source.workspace_slug, profile.id),
    editId: firstString(source.editId, source.edit_id, source.sourceEditId, source.source_edit_id),
    targetId: firstString(source.targetId, source.target_id, source.validationTargetId, source.validation_target_id, profile.runtime.targetName),
    sourcePaths,
    sourceManifestHash,
    source_manifest_hash: sourceManifestHash,
    sourceManifestHashVerified,
    source_manifest_hash_verified: sourceManifestHashVerified,
    sourceIdentityEvidenceRefs,
    source_identity_evidence_refs: sourceIdentityEvidenceRefs,
    entryPoint: firstString(
      source.entryPoint,
      source.entry_point,
      source.kernelName,
      source.kernel_name,
      profile.runtime.reload.kernelSymbol,
    ),
    compileTarget: firstString(source.compileTarget, source.compile_target, source.gpuArch, source.gpu_arch),
    compiler: firstString(source.compiler),
    compilerArgsHash: firstString(source.compilerArgsHash, source.compiler_args_hash),
    artifactHashBefore: firstString(source.artifactHashBefore, source.artifact_hash_before),
    artifactHashAfter: firstString(source.artifactHashAfter, source.artifact_hash_after),
    contractHash: firstString(source.contractHash, source.contract_hash),
    runtimeBoundaryEvents: manifest.events,
    runtime_boundary_events: manifest.events,
    computeOracleArtifacts: firstObject(source.computeOracleArtifacts, source.compute_oracle_artifacts),
    compute_oracle_artifacts: firstObject(source.computeOracleArtifacts, source.compute_oracle_artifacts),
    computeOracleByteEvidence: firstObject(source.computeOracleByteEvidence, source.compute_oracle_byte_evidence),
    compute_oracle_byte_evidence: firstObject(source.computeOracleByteEvidence, source.compute_oracle_byte_evidence),
    visualOracleArtifacts: firstObject(source.visualOracleArtifacts, source.visual_oracle_artifacts),
    visual_oracle_artifacts: firstObject(source.visualOracleArtifacts, source.visual_oracle_artifacts),
    visualEvidenceArtifacts: firstArray(source.visualEvidenceArtifacts, source.visual_evidence_artifacts),
    visual_evidence_artifacts: firstArray(source.visualEvidenceArtifacts, source.visual_evidence_artifacts),
    deterministicVisualMode: firstObject(
      source.deterministicVisualMode,
      source.deterministic_visual_mode,
      profile.deterministicVisualMode,
    ),
    deterministic_visual_mode: firstObject(
      source.deterministicVisualMode,
      source.deterministic_visual_mode,
      profile.deterministicVisualMode,
    ),
    metricScope: firstString(source.metricScope, source.metric_scope, profile.runMode.metricScope),
    metric_scope: firstString(source.metricScope, source.metric_scope, profile.runMode.metricScope),
    cacheState: firstString(source.cacheState, source.cache_state, profile.runMode.cacheState),
    cache_state: firstString(source.cacheState, source.cache_state, profile.runMode.cacheState),
    timings: firstObject(source.timings),
    modelProvenance: firstObject(source.modelProvenance, source.model_provenance),
  };
}

function runtimeBoundaryProofAdapterSummary(adapterProof = {}) {
  return {
    schemaVersion: adapterProof.schemaVersion ?? adapterProof.schema_version ?? null,
    schema_version: adapterProof.schema_version ?? adapterProof.schemaVersion ?? null,
    proofAuthority: adapterProof.proofAuthority ?? adapterProof.proof_authority ?? null,
    proof_authority: adapterProof.proof_authority ?? adapterProof.proofAuthority ?? null,
    accepted: adapterProof.accepted === true,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    adapterProofCanSatisfyRuntimeProof:
      adapterProof.canSatisfyRuntimeProof === true
      || adapterProof.can_satisfy_runtime_proof === true,
    adapter_proof_can_satisfy_runtime_proof:
      adapterProof.canSatisfyRuntimeProof === true
      || adapterProof.can_satisfy_runtime_proof === true,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    stageEvidence: adapterProof.stageEvidence ?? adapterProof.stage_evidence ?? null,
    stage_evidence: adapterProof.stage_evidence ?? adapterProof.stageEvidence ?? null,
    inputEvidence: adapterProof.inputEvidence ?? adapterProof.input_evidence ?? null,
    input_evidence: adapterProof.input_evidence ?? adapterProof.inputEvidence ?? null,
    inputStageBindingEvidence:
      adapterProof.inputStageBindingEvidence
      ?? adapterProof.input_stage_binding_evidence
      ?? null,
    input_stage_binding_evidence:
      adapterProof.input_stage_binding_evidence
      ?? adapterProof.inputStageBindingEvidence
      ?? null,
    strictGate: adapterProof.strictGate ?? adapterProof.strict_gate ?? null,
    strict_gate: adapterProof.strict_gate ?? adapterProof.strictGate ?? null,
    fullRuntimeProof: adapterProof.fullRuntimeProof ?? adapterProof.full_runtime_proof ?? null,
    full_runtime_proof: adapterProof.full_runtime_proof ?? adapterProof.fullRuntimeProof ?? null,
    runtimeProofArtifactId:
      adapterProof.runtimeProofArtifact?.proofId
      ?? adapterProof.runtimeProofArtifact?.proof_id
      ?? adapterProof.runtime_proof_artifact?.proof_id
      ?? null,
    runtime_proof_artifact_id:
      adapterProof.runtimeProofArtifact?.proofId
      ?? adapterProof.runtimeProofArtifact?.proof_id
      ?? adapterProof.runtime_proof_artifact?.proof_id
      ?? null,
    proofId: adapterProof.proofId ?? adapterProof.proof_id ?? null,
    proof_id: adapterProof.proof_id ?? adapterProof.proofId ?? null,
    failedGates: firstArray(adapterProof.failedGates, adapterProof.failed_gates),
    failed_gates: firstArray(adapterProof.failed_gates, adapterProof.failedGates),
  };
}

async function runRuntimeBoundaryProofAdapterProfile(profile, { resultPath = null } = {}) {
  const manifest = await readRuntimeBoundaryEventManifest(profile);
  const adapterInput = runtimeBoundaryAdapterInputFromProfileAndManifest(profile, manifest);
  const adapterProof = buildRuntimeBoundaryProofAdapter(adapterInput);
  const boundaryLineMaterialization = materializeRuntimeBoundaryEventLines(manifest.events);
  const adapterProofSummary = runtimeBoundaryProofAdapterSummary(adapterProof);
  const accepted =
    manifest.accepted === true
    && boundaryLineMaterialization.accepted === true
    && adapterProof.accepted === true;
  const runtimeProofArtifact = accepted ? adapterProof.runtimeProofArtifact : null;
  const proofLedger = runtimeProofArtifact?.proofLedger ?? runtimeProofArtifact?.proof_ledger ?? null;
  const failedGates = [
    ...firstArray(manifest.failedGates, manifest.failed_gates),
    ...firstArray(boundaryLineMaterialization.failedGates, boundaryLineMaterialization.failed_gates),
    ...firstArray(adapterProof.failedGates, adapterProof.failed_gates),
  ];
  const runModeProofSummary = {
    schemaVersion: 'synthi.gpu.hmr.runtime_run_mode_proof.summary.v1',
    schema_version: 'synthi.gpu.hmr.runtime_run_mode_proof.summary.v1',
    proofAuthority: 'runtime_boundary_run_mode_summary_only_not_success_authority',
    proof_authority: 'runtime_boundary_run_mode_summary_only_not_success_authority',
    accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    fullRuntimeProven: runtimeProofArtifact?.fullRuntimeProven === true,
    full_runtime_proven: runtimeProofArtifact?.fullRuntimeProven === true,
    strictRuntimeProofId: runtimeProofArtifact?.proofId ?? runtimeProofArtifact?.proof_id ?? null,
    strict_runtime_proof_id: runtimeProofArtifact?.proofId ?? runtimeProofArtifact?.proof_id ?? null,
    proofLedgerId: proofLedger?.proofId ?? proofLedger?.proof_id ?? null,
    proof_ledger_id: proofLedger?.proofId ?? proofLedger?.proof_id ?? null,
    runtimeBoundaryProofAdapterProofId: adapterProof.proofId ?? adapterProof.proof_id ?? null,
    runtime_boundary_proof_adapter_proof_id: adapterProof.proofId ?? adapterProof.proof_id ?? null,
    failedGates: [...new Set(failedGates)],
    failed_gates: [...new Set(failedGates)],
  };
  const proof = {
    schemaVersion: RUNTIME_BOUNDARY_PROFILE_ADAPTER_PROOF_SCHEMA,
    schema_version: RUNTIME_BOUNDARY_PROFILE_ADAPTER_PROOF_SCHEMA,
    proofAuthority: RUNTIME_BOUNDARY_PROFILE_ADAPTER_PROOF_AUTHORITY,
    proof_authority: RUNTIME_BOUNDARY_PROFILE_ADAPTER_PROOF_AUTHORITY,
    accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    strictRuntimeArtifactProduced: accepted,
    strict_runtime_artifact_produced: accepted,
    profileId: profile.id,
    profile_id: profile.id,
    adapterFamily: profile.adapter.family,
    adapter_family: profile.adapter.family,
    proofRunner: profile.adapter.proofRunner,
    proof_runner: profile.adapter.proofRunner,
    runtimeBoundaryEventManifest: manifest,
    runtime_boundary_event_manifest: manifest,
    runtimeBoundaryLineMaterialization: boundaryLineMaterialization,
    runtime_boundary_line_materialization: boundaryLineMaterialization,
    runtimeBoundaryLines: boundaryLineMaterialization.runtimeBoundaryLines,
    runtime_boundary_lines: boundaryLineMaterialization.runtime_boundary_lines,
    adapterRuntimeBoundaryLines: boundaryLineMaterialization.adapterRuntimeBoundaryLines,
    adapter_runtime_boundary_lines: boundaryLineMaterialization.adapter_runtime_boundary_lines,
    runtimeBoundaryLineHashes: boundaryLineMaterialization.runtimeBoundaryLineHashes,
    runtime_boundary_line_hashes: boundaryLineMaterialization.runtime_boundary_line_hashes,
    adapterRuntimeBoundaryLineHashes: boundaryLineMaterialization.adapterRuntimeBoundaryLineHashes,
    adapter_runtime_boundary_line_hashes: boundaryLineMaterialization.adapter_runtime_boundary_line_hashes,
    runtimeBoundaryLineMaterializationHash: boundaryLineMaterialization.bindingHash,
    runtime_boundary_line_materialization_hash: boundaryLineMaterialization.binding_hash,
    runtimeBoundaryAdapterInputEvidence: adapterProof.inputEvidence ?? null,
    runtime_boundary_adapter_input_evidence: adapterProof.input_evidence ?? null,
    runtimeBoundaryProofAdapter: adapterProofSummary,
    runtime_boundary_proof_adapter: adapterProofSummary,
    runtimeBoundaryRunModeProofSummary: runModeProofSummary,
    runtime_boundary_run_mode_proof_summary: runModeProofSummary,
    runtimeProofArtifact,
    runtime_proof_artifact: runtimeProofArtifact,
    proofLedger,
    proof_ledger: proofLedger,
    failedGates: [...new Set(failedGates)],
    failed_gates: [...new Set(failedGates)],
  };
  const proofHash = `sha256:${sha256Text(stableJson(proof))}`;
  proof.proofHash = proofHash;
  proof.proof_hash = proofHash;

  const baseDir = resultPath
    ? path.dirname(resultPath)
    : path.join(REPO_ROOT, 'mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-profile-results');
  await fs.mkdir(baseDir, { recursive: true });
  const proofPath = path.join(baseDir, `${profile.id}-runtime-boundary-adapter-proof.json`);
  await fs.writeFile(proofPath, `${JSON.stringify(proof, null, 2)}\n`);
  return {
    exitCode: 0,
    signal: null,
    stdout: `proof_path=${proofPath}\n`,
    stderr: '',
    proof,
    proofPath,
  };
}

function summarizeProofArtifact(proof) {
  const runtimeProofArtifact =
    proof?.runtimeProofArtifact
    ?? proof?.runtime_proof_artifact
    ?? proof?.strictRuntimeProofArtifact
    ?? proof?.strict_runtime_proof_artifact
    ?? null;
  const proofLedger =
    proof?.proofLedger
    ?? proof?.proof_ledger
    ?? proof?.ledger
    ?? runtimeProofArtifact?.proofLedger
    ?? runtimeProofArtifact?.proof_ledger
    ?? null;
  const strictRuntimeProofId = firstString(
    runtimeProofArtifact?.proofId,
    runtimeProofArtifact?.proof_id,
    proof?.strictRuntimeProofId,
    proof?.strict_runtime_proof_id,
    proof?.runtimeProofId,
    proof?.runtime_proof_id,
  );
  const proofLedgerId = firstString(
    proofLedger?.proofId,
    proofLedger?.proof_id,
    proof?.ledgerId,
    proof?.ledger_id,
    proof?.proofLedgerId,
    proof?.proof_ledger_id,
  );
  const gpuHmrSuccess = firstBool(
    runtimeProofArtifact?.gpuHmrSuccess,
    runtimeProofArtifact?.gpu_hmr_success,
    proof?.gpuHmrSuccess,
    proof?.gpu_hmr_success,
  );
  const fullRuntimeProven = firstBool(
    runtimeProofArtifact?.fullRuntimeProven,
    runtimeProofArtifact?.full_runtime_proven,
    proof?.fullRuntimeProven,
    proof?.full_runtime_proven,
  );
  const limitations = [
    ...(Array.isArray(runtimeProofArtifact?.limitations) ? runtimeProofArtifact.limitations : []),
    ...(Array.isArray(proof?.limitations) ? proof.limitations : []),
  ];
  const strictRuntimeProofGate = runtimeProofArtifact
    ? runtimeProofArtifactStrictGate(runtimeProofArtifact, {
      name: 'runtime profile adapter declared proof strict gate',
    })
    : null;
  const strictRuntimeProofGateFailures = Array.isArray(strictRuntimeProofGate?.failures)
    ? strictRuntimeProofGate.failures
    : [];
  return {
    strictRuntimeProofArtifactPresent: Boolean(runtimeProofArtifact),
    strict_runtime_proof_artifact_present: Boolean(runtimeProofArtifact),
    strictRuntimeProofId,
    strict_runtime_proof_id: strictRuntimeProofId,
    proofLedgerPresent: Boolean(proofLedger),
    proof_ledger_present: Boolean(proofLedger),
    proofLedgerId,
    proof_ledger_id: proofLedgerId,
    gpuHmrSuccess,
    gpu_hmr_success: gpuHmrSuccess,
    fullRuntimeProven,
    full_runtime_proven: fullRuntimeProven,
    limitationsPresent: limitations.length > 0,
    limitations_present: limitations.length > 0,
    limitationCount: limitations.length,
    limitation_count: limitations.length,
    strictRuntimeProofGate,
    strict_runtime_proof_gate: strictRuntimeProofGate,
    strictRuntimeProofGateAccepted: strictRuntimeProofGate?.accepted === true,
    strict_runtime_proof_gate_accepted: strictRuntimeProofGate?.accepted === true,
    strictRuntimeProofGateStatus: strictRuntimeProofGate?.status ?? null,
    strict_runtime_proof_gate_status: strictRuntimeProofGate?.status ?? null,
    strictRuntimeProofGateFailures,
    strict_runtime_proof_gate_failures: strictRuntimeProofGateFailures,
  };
}

async function writeRuntimeProfileAdapterResult({
  profile,
  adapter,
  resultPath,
  startedAt,
  finishedAt,
  spawnResult,
  timingRecorder = null,
}) {
  const recorder = timingRecorder ?? createRuntimeProfileTimingRecorder({ scope: 'result_only' });
  if (!RUNTIME_PROFILE_TIMING_SCOPES.has(recorder) || recorder.isFinalized) {
    throw new TypeError('runtime_profile_result_timing_recorder_invalid');
  }
  recorder.startPhase('proof_finalization');
  const combinedOutput = `${spawnResult.stdout ?? ''}\n${spawnResult.stderr ?? ''}`;
  const rawProofPath = proofPathFromRunnerOutput(combinedOutput);
  const proofPath = resolveProofPath(rawProofPath);
  const proofRead = await readJsonIfPresent(proofPath);
  const childTiming = childTestTimingFromProof(proofRead.value);
  const proofSummary = summarizeProofArtifact(proofRead.value ?? {});
  const lineMaterialization =
    proofRead.value?.runtimeBoundaryLineMaterialization
    ?? proofRead.value?.runtime_boundary_line_materialization
    ?? null;
  const runtimeBoundaryLines = firstArray(
    proofRead.value?.runtimeBoundaryLines,
    proofRead.value?.runtime_boundary_lines,
    lineMaterialization?.runtimeBoundaryLines,
    lineMaterialization?.runtime_boundary_lines,
  );
  const runtimeBoundaryLineHashes = firstArray(
    proofRead.value?.runtimeBoundaryLineHashes,
    proofRead.value?.runtime_boundary_line_hashes,
    lineMaterialization?.runtimeBoundaryLineHashes,
    lineMaterialization?.runtime_boundary_line_hashes,
  );
  const runnerSucceeded = spawnResult.exitCode === 0;
  let strictRuntimeProofAccepted =
    proofSummary.strictRuntimeProofArtifactPresent === true
    && proofSummary.gpuHmrSuccess === true
    && proofSummary.fullRuntimeProven === true
    && proofSummary.strictRuntimeProofGateAccepted === true
    && proofSummary.limitationsPresent !== true
    && childTiming.blockingGaps.length === 0;
  const blockingGaps = [
    runnerSucceeded ? null : 'runtime_profile_adapter_runner_failed',
    rawProofPath ? null : 'runtime_profile_adapter_proof_path_missing',
    rawProofPath && !proofPath ? 'runtime_profile_adapter_proof_path_outside_repo' : null,
    proofPath && !proofRead.present ? 'runtime_profile_adapter_proof_json_unreadable' : null,
    proofRead.present && !proofSummary.strictRuntimeProofArtifactPresent
      ? 'runtime_profile_adapter_strict_runtime_proof_artifact_missing'
      : null,
    lineMaterialization && lineMaterialization.accepted !== true
      ? 'runtime_profile_adapter_boundary_line_materialization_failed'
      : null,
    proofSummary.strictRuntimeProofArtifactPresent && proofSummary.gpuHmrSuccess !== true
      ? 'runtime_profile_adapter_gpu_hmr_success_false'
      : null,
    proofSummary.strictRuntimeProofArtifactPresent && proofSummary.fullRuntimeProven !== true
      ? 'runtime_profile_adapter_full_runtime_not_proven'
      : null,
    proofSummary.strictRuntimeProofArtifactPresent && proofSummary.strictRuntimeProofGateAccepted !== true
      ? 'runtime_profile_adapter_strict_gate_rejected'
      : null,
    proofSummary.limitationsPresent ? 'runtime_profile_adapter_limitations_present' : null,
    ...childTiming.blockingGaps,
  ].filter(Boolean);
  const result = {
    schemaVersion: 'synthi.gpu_hmr.runtime_profile_adapter_result.v1',
    schema_version: 'synthi.gpu_hmr.runtime_profile_adapter_result.v1',
    proofAuthority: 'adapter_result_manifest_not_matrix_authority',
    proof_authority: 'adapter_result_manifest_not_matrix_authority',
    profileId: profile.id,
    profile_id: profile.id,
    adapterFamily: profile.adapter.family,
    adapter_family: profile.adapter.family,
    proofRunner: profile.adapter.proofRunner,
    proof_runner: profile.adapter.proofRunner,
    runnerKind: adapter.runnerKind,
    runner_kind: adapter.runnerKind,
    runnerPath: path.relative(REPO_ROOT, adapter.runner).replace(/\\/g, '/'),
    runner_path: path.relative(REPO_ROOT, adapter.runner).replace(/\\/g, '/'),
    startedAt,
    started_at: startedAt,
    finishedAt,
    finished_at: finishedAt,
    exitCode: spawnResult.exitCode,
    exit_code: spawnResult.exitCode,
    signal: spawnResult.signal,
    runnerSucceeded,
    runner_succeeded: runnerSucceeded,
    rawProofPath: rawProofPath ?? null,
    raw_proof_path: rawProofPath ?? null,
    proofPath: proofPath ? path.relative(REPO_ROOT, proofPath).replace(/\\/g, '/') : null,
    proof_path: proofPath ? path.relative(REPO_ROOT, proofPath).replace(/\\/g, '/') : null,
    proofJsonPresent: proofRead.present,
    proof_json_present: proofRead.present,
    proofJsonSha256: proofRead.rawSha256 ?? null,
    proof_json_sha256: proofRead.rawSha256 ?? null,
    proofJsonByteLength: proofRead.byteLength ?? 0,
    proof_json_byte_length: proofRead.byteLength ?? 0,
    proofReadError: proofRead.error,
    proof_read_error: proofRead.error,
    runtimeBoundaryEventManifestPath:
      proofRead.value?.runtimeBoundaryEventManifest?.manifestPath
      ?? proofRead.value?.runtime_boundary_event_manifest?.manifest_path
      ?? null,
    runtime_boundary_event_manifest_path:
      proofRead.value?.runtimeBoundaryEventManifest?.manifestPath
      ?? proofRead.value?.runtime_boundary_event_manifest?.manifest_path
      ?? null,
    runtimeBoundaryEventManifestSha256:
      proofRead.value?.runtimeBoundaryEventManifest?.manifestSha256
      ?? proofRead.value?.runtime_boundary_event_manifest?.manifest_sha256
      ?? null,
    runtime_boundary_event_manifest_sha256:
      proofRead.value?.runtimeBoundaryEventManifest?.manifestSha256
      ?? proofRead.value?.runtime_boundary_event_manifest?.manifest_sha256
      ?? null,
    runtimeBoundaryLineMaterialization: lineMaterialization,
    runtime_boundary_line_materialization: lineMaterialization,
    runtimeBoundaryLineMaterializationAccepted: lineMaterialization?.accepted === true,
    runtime_boundary_line_materialization_accepted: lineMaterialization?.accepted === true,
    runtimeBoundaryLineMaterializationHash:
      lineMaterialization?.bindingHash
      ?? lineMaterialization?.binding_hash
      ?? proofRead.value?.runtimeBoundaryLineMaterializationHash
      ?? proofRead.value?.runtime_boundary_line_materialization_hash
      ?? null,
    runtime_boundary_line_materialization_hash:
      lineMaterialization?.bindingHash
      ?? lineMaterialization?.binding_hash
      ?? proofRead.value?.runtimeBoundaryLineMaterializationHash
      ?? proofRead.value?.runtime_boundary_line_materialization_hash
      ?? null,
    runtimeBoundaryLines,
    runtime_boundary_lines: runtimeBoundaryLines,
    adapterRuntimeBoundaryLines: runtimeBoundaryLines,
    adapter_runtime_boundary_lines: runtimeBoundaryLines,
    runtimeBoundaryLineHashes,
    runtime_boundary_line_hashes: runtimeBoundaryLineHashes,
    adapterRuntimeBoundaryLineHashes: runtimeBoundaryLineHashes,
    adapter_runtime_boundary_line_hashes: runtimeBoundaryLineHashes,
    runtimeBoundaryProofAdapterAccepted:
      proofRead.value?.runtimeBoundaryProofAdapter?.accepted === true
      || proofRead.value?.runtime_boundary_proof_adapter?.accepted === true,
    runtime_boundary_proof_adapter_accepted:
      proofRead.value?.runtimeBoundaryProofAdapter?.accepted === true
      || proofRead.value?.runtime_boundary_proof_adapter?.accepted === true,
    runtimeBoundaryProofAdapterProofId:
      proofRead.value?.runtimeBoundaryProofAdapter?.proofId
      ?? proofRead.value?.runtime_boundary_proof_adapter?.proof_id
      ?? null,
    runtime_boundary_proof_adapter_proof_id:
      proofRead.value?.runtimeBoundaryProofAdapter?.proofId
      ?? proofRead.value?.runtime_boundary_proof_adapter?.proof_id
      ?? null,
    ...proofSummary,
    strictRuntimeProofAccepted,
    strict_runtime_proof_accepted: strictRuntimeProofAccepted,
    childTestTimingPresent: childTiming.present,
    child_test_timing_present: childTiming.present,
    childTestTimingAccepted: childTiming.accepted,
    child_test_timing_accepted: childTiming.accepted,
    childTestTimingBlockingGaps: childTiming.blockingGaps,
    child_test_timing_blocking_gaps: childTiming.blockingGaps,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    blockingGaps,
    blocking_gaps: blockingGaps,
    stdoutSha256: `sha256:${sha256Text(spawnResult.stdout ?? '')}`,
    stdout_sha256: `sha256:${sha256Text(spawnResult.stdout ?? '')}`,
    stderrSha256: `sha256:${sha256Text(spawnResult.stderr ?? '')}`,
    stderr_sha256: `sha256:${sha256Text(spawnResult.stderr ?? '')}`,
    stdoutTail: String(spawnResult.stdout ?? '').slice(-4000),
    stdout_tail: String(spawnResult.stdout ?? '').slice(-4000),
    stderrTail: String(spawnResult.stderr ?? '').slice(-4000),
    stderr_tail: String(spawnResult.stderr ?? '').slice(-4000),
    timingPersistenceCheckpoint: {
      schemaVersion: RUNTIME_PROFILE_TIMING_PERSISTENCE_CHECKPOINT_SCHEMA,
      proofAuthority: RUNTIME_PROFILE_TIMING_PERSISTENCE_CHECKPOINT_AUTHORITY,
      attempted: Boolean(resultPath),
      persistedBeforeTimingFinalization: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    },
  };
  result.timing_persistence_checkpoint = result.timingPersistenceCheckpoint;
  let persistenceError = null;
  if (resultPath) {
    try {
      await fs.mkdir(path.dirname(resultPath), { recursive: true });
      await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      result.timingPersistenceCheckpoint.persistedBeforeTimingFinalization = true;
    } catch (error) {
      persistenceError = error;
      blockingGaps.push('runtime_profile_result_persistence_failed');
      strictRuntimeProofAccepted = false;
      result.strictRuntimeProofAccepted = false;
      result.strict_runtime_proof_accepted = false;
    }
  }
  recorder.finishPhase('proof_finalization');
  const outcome = timingOutcome({
    runnerSucceeded,
    strictRuntimeProofAccepted,
    blockingGaps,
    persistenceFailed: persistenceError !== null,
  });
  const visualCapable = runtimeProfileVisualCapable(
    profile,
    proofRead.value,
    childTiming.accepted ? childTiming.testTiming : null,
  );
  const testTiming = finalizeRuntimeProfileTiming(recorder, {
    outcome,
    visualCapable,
    terminalReason: `runtime_profile_${outcome}`,
  });
  attachRuntimeProfileTiming(
    result,
    testTiming,
    childTiming.accepted ? childTiming.testTiming : null,
  );
  result.timingOutcome = outcome;
  result.timing_outcome = outcome;
  result.resultPersistenceError = persistenceError
    ? (persistenceError?.message ?? String(persistenceError))
    : null;
  result.result_persistence_error = result.resultPersistenceError;
  const resultHash = `sha256:${sha256Text(stableJson(result))}`;
  result.resultHash = resultHash;
  result.result_hash = resultHash;
  if (resultPath && persistenceError === null) {
    try {
      await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
      console.log(`runtime_profile_result=${resultPath}`);
    } catch (error) {
      console.error(`runtime_profile_result_final_persistence_failed=${error?.message ?? String(error)}`);
    }
  }
  return result;
}

async function loadPackagedProfile(profilePath) {
  return JSON.parse(await fs.readFile(path.resolve(REPO_ROOT, profilePath), 'utf8'));
}

async function discoverPackagedRuntimeProfiles() {
  const entries = await fs.readdir(PROFILE_DIR, { withFileTypes: true });
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    const absolutePath = path.join(PROFILE_DIR, entry.name);
    let parsed;
    try {
      parsed = JSON.parse(await fs.readFile(absolutePath, 'utf8'));
    } catch {
      continue;
    }
    if (parsed?.schemaVersion !== GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION) continue;
    profiles.push(path.relative(REPO_ROOT, absolutePath).replace(/\\/g, '/'));
  }
  profiles.sort();
  return profiles;
}

async function defaultPackagedRuntimeProfilePath() {
  const profilePaths = await discoverPackagedRuntimeProfiles();
  const defaultId = process.env.SYNTHI_GPU_HMR_RUNTIME_DEFAULT_PROFILE_ID?.trim();
  if (defaultId) {
    for (const profilePath of profilePaths) {
      const profile = normalizeRuntimeProofProfile(await loadPackagedProfile(profilePath));
      if (profile.id === defaultId) return profilePath;
    }
    throw new Error(`runtime default profile id was not found: ${defaultId}`);
  }
  const [first] = profilePaths;
  if (!first) throw new Error(`no packaged runtime profiles found in ${PROFILE_DIR}`);
  return first;
}

function rawResultPathHint(argv, env = process.env) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--result-path') return argv[index + 1] ?? '';
  }
  return env.SYNTHI_GPU_HMR_RUNTIME_RESULT_PATH
    || env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_RESULT_PATH
    || '';
}

function safeFailureResultPath(rawPath) {
  try {
    return resolveResultPath(rawPath);
  } catch {
    return null;
  }
}

async function createRuntimeProfileTopLevelFailure(error, {
  timingRecorder = null,
  resultPath = null,
  profile = null,
} = {}) {
  const recorder = timingRecorder ?? createRuntimeProfileTimingRecorder({ scope: 'top_level' });
  if (!RUNTIME_PROFILE_TIMING_SCOPES.has(recorder) || recorder.isFinalized) {
    throw new TypeError('runtime_profile_failure_timing_recorder_invalid');
  }
  const proofFinalizationState = ensureRuntimeProfilePhaseStarted(
    recorder,
    'proof_finalization',
  );
  const failure = {
    schemaVersion: RUNTIME_PROFILE_FAILURE_SCHEMA,
    schema_version: RUNTIME_PROFILE_FAILURE_SCHEMA,
    proofAuthority: RUNTIME_PROFILE_FAILURE_AUTHORITY,
    proof_authority: RUNTIME_PROFILE_FAILURE_AUTHORITY,
    failureCode: 'runtime_profile_top_level_exception',
    failure_code: 'runtime_profile_top_level_exception',
    errorName: compactString(error?.name) ?? 'Error',
    error_name: compactString(error?.name) ?? 'Error',
    profileId: compactString(profile?.id),
    profile_id: compactString(profile?.id),
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    blockingGaps: ['runtime_profile_top_level_exception'],
    blocking_gaps: ['runtime_profile_top_level_exception'],
    timingPersistenceCheckpoint: {
      schemaVersion: RUNTIME_PROFILE_TIMING_PERSISTENCE_CHECKPOINT_SCHEMA,
      proofAuthority: RUNTIME_PROFILE_TIMING_PERSISTENCE_CHECKPOINT_AUTHORITY,
      attempted: Boolean(resultPath),
      persistedBeforeTimingFinalization: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    },
  };
  failure.timing_persistence_checkpoint = failure.timingPersistenceCheckpoint;
  let persistenceError = null;
  if (resultPath) {
    try {
      await fs.mkdir(path.dirname(resultPath), { recursive: true });
      await fs.writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`);
      failure.timingPersistenceCheckpoint.persistedBeforeTimingFinalization = true;
    } catch (writeError) {
      persistenceError = writeError;
      failure.blockingGaps.push('runtime_profile_failure_persistence_failed');
      failure.blocking_gaps = failure.blockingGaps;
    }
  }
  if (proofFinalizationState !== 'finished') recorder.finishPhase('proof_finalization');
  const testTiming = finalizeRuntimeProfileTiming(recorder, {
    outcome: 'failed',
    visualCapable: runtimeProfileVisualCapable(profile, null),
    terminalReason: 'runtime_profile_failed',
  });
  attachRuntimeProfileTiming(failure, testTiming);
  failure.resultPersistenceError = persistenceError
    ? (persistenceError?.message ?? String(persistenceError))
    : null;
  failure.result_persistence_error = failure.resultPersistenceError;
  const evidenceHash = `sha256:${sha256Text(stableJson(failure))}`;
  failure.evidenceHash = evidenceHash;
  failure.evidence_hash = evidenceHash;
  if (resultPath && persistenceError === null) {
    try {
      await fs.writeFile(resultPath, `${JSON.stringify(failure, null, 2)}\n`);
    } catch (writeError) {
      console.error(
        `runtime_profile_failure_final_persistence_failed=${writeError?.message ?? String(writeError)}`,
      );
    }
  }
  return failure;
}

function explicitRuntimeProfileSource(env) {
  if (env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON?.trim()) return 'explicit_profile_json';
  if (env.SYNTHI_HIPRT_WARM_PROFILE_JSON?.trim()) return 'explicit_hiprt_profile_json';
  if (env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH?.trim()) return 'explicit_profile_path';
  if (env.SYNTHI_HIPRT_WARM_PROFILE_PATH?.trim()) return 'explicit_hiprt_profile_path';
  return null;
}

async function selfCheck() {
  const checks = [];
  const passTimingRecorder = createRuntimeProfileTimingRecorder({ scope: 'result_only' });
  passTimingRecorder.startPhase('proof_finalization');
  passTimingRecorder.finishPhase('proof_finalization');
  const passTiming = finalizeRuntimeProfileTiming(passTimingRecorder, {
    outcome: 'pass',
    visualCapable: false,
    terminalReason: 'runtime_profile_pass',
  });
  const passTimingValidation = validateGpuHmrTestTiming(passTiming);
  checks.push({
    name: 'runtime-profile-pass-timing-is-canonical-support-only',
    ok:
      passTimingValidation.valid === true
      && passTiming.outcome === 'pass'
      && passTiming.clock === 'monotonic_ns'
      && passTiming.authority === 'timing_only'
      && passTiming.acceptedForGpuHmr === false
      && passTiming.gpuHmrSuccess === false
      && passTiming.phases.proof_finalization.state === 'measured'
      && GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.every((phaseKey) =>
        passTiming.phases[phaseKey].state === 'not_applicable'),
  });
  const packagedProfiles = await discoverPackagedRuntimeProfiles();
  const defaultProfile = normalizeRuntimeProofProfile(await loadPackagedProfile(await defaultPackagedRuntimeProfilePath()));
  checks.push({
    name: 'default-packaged-profile-normalizes',
    ok: defaultProfile.schemaVersion === GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION,
    adapter: defaultProfile.adapter.family,
  });
  for (const profilePath of packagedProfiles) {
    const profile = normalizeRuntimeProofProfile(await loadPackagedProfile(profilePath));
    checks.push({
      name: `packaged-profile:${path.basename(profilePath)}`,
      ok:
        profile.schemaVersion === GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION
        && Boolean(adapterForProfile(profile))
        && profile.source.before !== profile.source.after,
      adapter: profile.adapter.family,
      target: profile.runtime.targetName,
      source: profile.source.file,
    });
  }
  const baseProfile = defaultProfile;
  const unsupported = normalizeRuntimeProofProfile({
    ...baseProfile,
    adapter: { family: 'unknown-renderer-runtime', proofRunner: 'custom' },
  });
  let unsupportedRejected = false;
  try {
    adapterForProfile(unsupported);
  } catch {
    unsupportedRejected = true;
  }
  checks.push({
    name: 'unsupported-adapter-fails-closed',
    ok: unsupportedRejected,
  });
  checks.push({
    name: 'runtime-profile-selection-requires-explicit-source',
    ok: explicitRuntimeProfileSource({}) === null,
  });
  const external = normalizeRuntimeProofProfile({
    ...baseProfile,
    id: 'external-adapter-smoke',
    adapter: {
      family: 'external-adapter-smoke',
      proofRunner: 'profile-runner',
      runnerKind: 'node-script',
      runnerPath: 'mcp/synthi-mcp/scripts/fixtures/runtime-profile-external-adapter-smoke.mjs',
    },
  });
  const externalAdapter = adapterForProfile(external);
  checks.push({
    name: 'profile-declared-adapter-resolves',
    ok:
      externalAdapter.runnerKind === 'node-script'
      && externalAdapter.envKind === 'generic-profile'
      && isInsideDirectory(REPO_ROOT, externalAdapter.runner),
    adapter: external.adapter.family,
    runner: path.relative(REPO_ROOT, externalAdapter.runner).replace(/\\/g, '/'),
  });
  const resultSmokeDir = path.join(
    REPO_ROOT,
    'mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-profile-self-check',
    `adapter-result-${Date.now()}`,
  );
  const resultSmokeProofPath = path.join(resultSmokeDir, 'adapter-proof.json');
  const resultSmokePath = path.join(resultSmokeDir, 'adapter-result.json');
  const resultSmoke = normalizeRuntimeProofProfile({
    ...baseProfile,
    id: 'external-adapter-result-smoke',
    adapter: {
      family: 'external-adapter-result-smoke',
      proofRunner: 'profile-runner',
      runnerKind: 'node-script',
      runnerPath: 'mcp/synthi-mcp/scripts/fixtures/runtime-profile-external-adapter-result-smoke.mjs',
    },
  });
  const resultSmokeAdapter = adapterForProfile(resultSmoke);
  const resultSmokeEnv = {
    ...envForAdapter(resultSmoke, resultSmokeAdapter),
    SYNTHI_GPU_HMR_RUNTIME_RESULT_SMOKE_PROOF_PATH: resultSmokeProofPath,
  };
  const resultSmokeStartedAt = new Date().toISOString();
  const resultSmokeSpawn = await spawnNodeScript(
    resultSmokeAdapter.runner,
    resultSmokeEnv,
    resultSmokeAdapter.runnerArgs ?? [],
  );
  const retainedChildTiming = syntheticSupportOnlyTestTiming({
    outcome: 'pass',
    visualCapable: false,
  });
  const resultSmokeProof = JSON.parse(await fs.readFile(resultSmokeProofPath, 'utf8'));
  resultSmokeProof.testTiming = retainedChildTiming;
  resultSmokeProof.test_timing = retainedChildTiming;
  await fs.writeFile(resultSmokeProofPath, `${JSON.stringify(resultSmokeProof, null, 2)}\n`);
  const resultSmokeFinishedAt = new Date().toISOString();
  const resultSmokeArtifact = await writeRuntimeProfileAdapterResult({
    profile: resultSmoke,
    adapter: resultSmokeAdapter,
    resultPath: resultSmokePath,
    startedAt: resultSmokeStartedAt,
    finishedAt: resultSmokeFinishedAt,
    spawnResult: resultSmokeSpawn,
  });
  const resultSmokeTimingValidation = validateGpuHmrTestTiming(resultSmokeArtifact.testTiming);
  checks.push({
    name: 'runtime-profile-refusal-retains-parent-and-child-timing',
    ok:
      resultSmokeTimingValidation.valid === true
      && resultSmokeArtifact.testTiming === resultSmokeArtifact.test_timing
      && resultSmokeArtifact.testTiming.outcome === 'refused'
      && resultSmokeArtifact.testTiming.visualCapable === true
      && GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.every((phaseKey) =>
        resultSmokeArtifact.testTiming.phases[phaseKey].state === 'unavailable')
      && resultSmokeArtifact.childTestTimingAccepted === true
      && resultSmokeArtifact.childTestTiming === resultSmokeArtifact.child_test_timing
      && stableJson(resultSmokeArtifact.childTestTiming) === stableJson(retainedChildTiming)
      && resultSmokeArtifact.timingPersistenceCheckpoint.persistedBeforeTimingFinalization === true
      && BigInt(resultSmokeArtifact.testTiming.phases.total_wall.endNs)
        >= BigInt(resultSmokeArtifact.testTiming.phases.proof_finalization.endNs),
    resultPath: path.relative(REPO_ROOT, resultSmokePath).replace(/\\/g, '/'),
  });

  const nonvisualFailureProfile = normalizeRuntimeProofProfile({
    ...resultSmoke,
    id: 'runtime-profile-timing-nonvisual-failure',
    deterministicVisualMode: null,
  });
  const nonvisualFailureAdapter = adapterForProfile(nonvisualFailureProfile);
  const childFailureResultPath = path.join(resultSmokeDir, 'child-failure-result.json');
  const childFailureResult = await writeRuntimeProfileAdapterResult({
    profile: nonvisualFailureProfile,
    adapter: nonvisualFailureAdapter,
    resultPath: childFailureResultPath,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    spawnResult: {
      exitCode: 7,
      signal: null,
      stdout: '',
      stderr: 'synthetic child failure without proof artifact',
    },
  });
  checks.push({
    name: 'runtime-profile-child-failure-retains-failed-timing',
    ok:
      validateGpuHmrTestTiming(childFailureResult.testTiming).valid === true
      && childFailureResult.testTiming === childFailureResult.test_timing
      && childFailureResult.testTiming.outcome === 'failed'
      && childFailureResult.testTiming.visualCapable === false
      && childFailureResult.blockingGaps.includes('runtime_profile_adapter_runner_failed')
      && GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.every((phaseKey) =>
        childFailureResult.testTiming.phases[phaseKey].state === 'not_applicable'),
    resultPath: path.relative(REPO_ROOT, childFailureResultPath).replace(/\\/g, '/'),
  });

  const forgedTimingProofPath = path.join(resultSmokeDir, 'forged-child-timing-proof.json');
  const forgedChildTiming = structuredClone(retainedChildTiming);
  forgedChildTiming.authority = 'gpu_hmr_success_authority';
  await fs.writeFile(forgedTimingProofPath, `${JSON.stringify({
    schemaVersion: 'synthi.gpu_hmr.runtime_profile_timing_alias_forgery.v1',
    testTiming: retainedChildTiming,
    test_timing: forgedChildTiming,
  }, null, 2)}\n`);
  const forgedTimingResultPath = path.join(resultSmokeDir, 'forged-child-timing-result.json');
  const forgedTimingResult = await writeRuntimeProfileAdapterResult({
    profile: nonvisualFailureProfile,
    adapter: nonvisualFailureAdapter,
    resultPath: forgedTimingResultPath,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    spawnResult: {
      exitCode: 0,
      signal: null,
      stdout: `proof_json=${forgedTimingProofPath}\n`,
      stderr: '',
    },
  });
  checks.push({
    name: 'runtime-profile-forged-child-timing-alias-refuses',
    ok:
      validateGpuHmrTestTiming(forgedTimingResult.testTiming).valid === true
      && forgedTimingResult.testTiming.outcome === 'refused'
      && forgedTimingResult.childTestTimingPresent === true
      && forgedTimingResult.childTestTimingAccepted === false
      && !Object.hasOwn(forgedTimingResult, 'childTestTiming')
      && forgedTimingResult.blockingGaps.includes(
        'runtime_profile_child_timing_alias_conflict:proof',
      ),
    resultPath: path.relative(REPO_ROOT, forgedTimingResultPath).replace(/\\/g, '/'),
  });

  const authorityTimingProofPath = path.join(resultSmokeDir, 'authority-child-timing-proof.json');
  await fs.writeFile(authorityTimingProofPath, `${JSON.stringify({
    schemaVersion: 'synthi.gpu_hmr.runtime_profile_timing_authority_forgery.v1',
    testTiming: forgedChildTiming,
    test_timing: forgedChildTiming,
  }, null, 2)}\n`);
  const authorityTimingResultPath = path.join(resultSmokeDir, 'authority-child-timing-result.json');
  const authorityTimingResult = await writeRuntimeProfileAdapterResult({
    profile: nonvisualFailureProfile,
    adapter: nonvisualFailureAdapter,
    resultPath: authorityTimingResultPath,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    spawnResult: {
      exitCode: 0,
      signal: null,
      stdout: `proof_json=${authorityTimingProofPath}\n`,
      stderr: '',
    },
  });
  checks.push({
    name: 'runtime-profile-authority-claiming-child-timing-refuses',
    ok:
      authorityTimingResult.testTiming.outcome === 'refused'
      && authorityTimingResult.childTestTimingPresent === true
      && authorityTimingResult.childTestTimingAccepted === false
      && authorityTimingResult.blockingGaps.includes(
        'runtime_profile_child_timing_invalid:proof',
      ),
    resultPath: path.relative(REPO_ROOT, authorityTimingResultPath).replace(/\\/g, '/'),
  });

  const topLevelFailurePath = path.join(resultSmokeDir, 'top-level-failure-result.json');
  const interruptedTopLevelRecorder = createRuntimeProfileTimingRecorder({
    scope: 'top_level',
  });
  interruptedTopLevelRecorder.startPhase('proof_finalization');
  const topLevelFailure = await createRuntimeProfileTopLevelFailure(
    new Error('synthetic runtime profile top-level failure'),
    {
      timingRecorder: interruptedTopLevelRecorder,
      resultPath: topLevelFailurePath,
      profile: nonvisualFailureProfile,
    },
  );
  checks.push({
    name: 'runtime-profile-top-level-exception-retains-failed-timing',
    ok:
      validateGpuHmrTestTiming(topLevelFailure.testTiming).valid === true
      && topLevelFailure.testTiming === topLevelFailure.test_timing
      && topLevelFailure.testTiming.outcome === 'failed'
      && topLevelFailure.testTiming.visualCapable === false
      && topLevelFailure.timingPersistenceCheckpoint.persistedBeforeTimingFinalization === true
      && GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS.every((phaseKey) =>
        topLevelFailure.testTiming.phases[phaseKey].state === 'not_applicable'),
    resultPath: path.relative(REPO_ROOT, topLevelFailurePath).replace(/\\/g, '/'),
  });
  const runtimeBoundaryDir = path.join(
    REPO_ROOT,
    'mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-profile-self-check',
    `runtime-boundary-${Date.now()}`,
  );
  await fs.mkdir(runtimeBoundaryDir, { recursive: true });
  const rawReadbackPath = path.join(runtimeBoundaryDir, 'raw-readback.bin');
  const readbackSchemaPath = path.join(runtimeBoundaryDir, 'readback-schema.json');
  const renderedCardPath = path.join(runtimeBoundaryDir, 'compute-proof-card.png');
  const rawReadbackBytes = Buffer.from(Array.from({ length: 128 }, (_, index) => (index * 17 + 11) % 256));
  await fs.writeFile(rawReadbackPath, rawReadbackBytes);
  await fs.writeFile(readbackSchemaPath, `${JSON.stringify({
    schemaVersion: 'synthi.gpu_hmr.compute_readback_schema.v1',
    byteLength: rawReadbackBytes.length,
    elementType: 'u8',
    shape: [rawReadbackBytes.length],
  }, null, 2)}\n`);
  await fs.writeFile(renderedCardPath, Buffer.from('runtime-boundary-compute-proof-card\n', 'utf8'));
  const hashA = `sha256:${sha256Text('runtime-boundary-before-artifact')}`;
  const hashB = `sha256:${sha256Buffer(rawReadbackBytes)}`;
  const hashC = `sha256:${sha256Buffer(rawReadbackBytes.subarray(0, 64))}`;
  const hashD = `sha256:${sha256Text('runtime-boundary-dispatch-table-before')}`;
  const hashE = `sha256:${sha256Text('runtime-boundary-dispatch-table-after')}`;
  const runtimeBoundaryEvents = [
    {
      kind: 'artifact_transport',
      eventId: 'load-1',
      artifactHash: hashB,
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      timestampMonotonicNs: 100,
      evidenceRefs: ['runtime-boundary:artifact-transport'],
    },
    {
      kind: 'epoch_publication',
      eventId: 'publish-1',
      artifactHash: hashB,
      epoch: 'epoch-7',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      timestampMonotonicNs: 200,
      dispatchTableHashBefore: hashD,
      dispatchTableHashAfter: hashE,
      hostIdentityPreviousGeneration: 1,
      host_identity_previous_generation: 1,
      hostIdentityActiveGeneration: 2,
      host_identity_active_generation: 2,
      evidenceRefs: ['runtime-boundary:epoch-publication'],
    },
    {
      kind: 'synthi_gpu_launch',
      eventId: 'dispatch-1',
      artifactHash: hashB,
      epoch: 'epoch-7',
      dispatchId: 'dispatch-1',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      stream: 'stream-1',
      dispatchTableEntry: 'generic_kernel:epoch-7',
      timestampMonotonicNs: 300,
      evidenceRefs: [
        'worker-log:synthi_gpu_launch:runtime-session-1:dispatch-1',
        'worker-log:launch_arg_provenance:runtime-session-1:dispatch-1:output',
      ],
    },
    {
      kind: 'host_identity',
      eventId: 'host-1',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      deviceUuid: 'device-1',
      contextId: 'ctx-1',
      stream: 'stream-1',
      timestampMonotonicNs: 310,
      evidenceRefs: [
        'worker-log:host_identity:runner_process',
        'worker-log:host_identity:host_state',
        'worker-log:host_identity:stream_context',
        'worker-log:host_identity_snapshot:runtime-session-1:runner_process:1->2',
        'worker-log:host_identity_snapshot:runtime-session-1:host_state:1->2',
        'worker-log:host_identity_snapshot:runtime-session-1:stream_context:1->2',
      ],
    },
    {
      kind: 'output_oracle',
      eventId: 'output-1',
      artifactHash: hashB,
      epoch: 'epoch-7',
      afterDispatchId: 'dispatch-1',
      processId: 'pid-1',
      runtimeSession: 'runtime-session-1',
      outputTargetId: 'allocation-1',
      oracleKind: 'buffer_checksum',
      timestampMonotonicNs: 400,
      evidenceRefs: ['worker-log:output_oracle:runtime-session-1:dispatch-1'],
    },
  ];
  const runtimeBoundaryManifestPath = path.join(runtimeBoundaryDir, 'runtime-boundary-events.json');
  await fs.writeFile(runtimeBoundaryManifestPath, `${JSON.stringify({
    schemaVersion: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    proofAuthority: 'runtime_boundary_event_manifest_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    backend: 'hip',
    projectId: 'generic-runtime-boundary-project',
    editId: 'gpu-artifact-edit',
    targetId: 'generic-runtime-boundary-target',
    sourcePaths: ['src/kernels/generic.hip'],
    sourceManifestHash: hashD,
    sourceManifestHashVerified: true,
    sourceIdentityEvidenceRefs: ['runtime-boundary:source-manifest:generic-runtime-boundary-project'],
    entryPoint: 'generic_kernel',
    compileTarget: 'gfx1201',
    compiler: 'hipcc',
    compilerArgsHash: hashC,
    artifactHashBefore: hashA,
    artifactHashAfter: hashB,
    contractHash: hashC,
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    runtimeBoundaryEvents,
    computeOracleArtifacts: {
      raw_readback_bin: rawReadbackPath,
      readback_schema_json: readbackSchemaPath,
      checksum_before: hashA,
      checksum_after: hashB,
      expected_output_change: true,
      expected_output_verified: true,
      expected_output_hash: hashB,
      deterministic_slice: {
        offset: 0,
        length: 64,
        format: 'bytes',
        hash: hashC,
      },
      raw_readback_hash: hashB,
      raw_readback_hash_verified: true,
      raw_readback_byte_length: 128,
      raw_readback_source: 'runtime_raw_readback',
      deterministic_slice_hash: hashC,
      deterministic_slice_hash_verified: true,
      raw_readback_verification: {
        hash_verified: true,
        byte_length: 128,
        deterministic_slice_hash: hashC,
        deterministic_slice_hash_verified: true,
        expected_output_verified: true,
        slice_bounds_verified: true,
      },
      oracle_code_hash: hashC,
      rendered_card_png: renderedCardPath,
      producer: 'runtime_boundary_profile_self_check',
      timestamp_after_dispatch: 400,
      epoch: 'epoch-7',
      evidenceRefs: ['compute-oracle:raw-readback-bytes'],
    },
  }, null, 2)}\n`);
  const runtimeBoundaryProfile = normalizeRuntimeProofProfile({
    ...baseProfile,
    id: 'generic-runtime-boundary-adapter-smoke',
    adapter: {
      family: 'generic-runtime-boundary-adapter-smoke',
      proofRunner: 'runtime-boundary-proof-adapter',
      runtimeBoundaryEventManifestPath: path.relative(REPO_ROOT, runtimeBoundaryManifestPath).replace(/\\/g, '/'),
    },
    runtime: {
      ...baseProfile.runtime,
      targetName: 'generic-runtime-boundary-target',
      requiredKernels: ['generic_kernel'],
      reload: {
        kernelName: 'generic_kernel',
        kernelSymbol: 'generic_kernel',
      },
    },
    source: {
      file: 'src/kernels/generic.hip',
      before: 'return 1;',
      after: 'return 2;',
    },
  });
  const runtimeBoundaryAdapter = adapterForProfile(runtimeBoundaryProfile);
  const runtimeBoundaryResultPath = path.join(runtimeBoundaryDir, 'runtime-boundary-result.json');
  const runtimeBoundaryStartedAt = new Date().toISOString();
  const runtimeBoundarySpawn = await runRuntimeBoundaryProofAdapterProfile(
    runtimeBoundaryProfile,
    { resultPath: runtimeBoundaryResultPath },
  );
  const runtimeBoundaryFinishedAt = new Date().toISOString();
  const runtimeBoundaryResult = await writeRuntimeProfileAdapterResult({
    profile: runtimeBoundaryProfile,
    adapter: runtimeBoundaryAdapter,
    resultPath: runtimeBoundaryResultPath,
    startedAt: runtimeBoundaryStartedAt,
    finishedAt: runtimeBoundaryFinishedAt,
    spawnResult: runtimeBoundarySpawn,
  });
  checks.push({
    name: 'generic-runtime-boundary-profile-adapter-accepts-strict-proof',
    ok:
      runtimeBoundaryAdapter.runnerKind === 'runtime-boundary-proof-adapter'
      && runtimeBoundaryResult.strictRuntimeProofAccepted === true
      && runtimeBoundaryResult.proofLedgerId
      && runtimeBoundaryResult.runtimeBoundaryProofAdapterAccepted === true
      && runtimeBoundaryResult.runtimeBoundaryLineMaterializationAccepted === true
      && runtimeBoundaryResult.runtimeBoundaryLineMaterializationHash?.startsWith('sha256:')
      && runtimeBoundaryResult.runtimeBoundaryLines?.length === 5
      && runtimeBoundaryResult.adapterRuntimeBoundaryLines?.length === 5
      && runtimeBoundarySpawn.proof?.strictRuntimeArtifactProduced === true
      && runtimeBoundarySpawn.proof?.canSatisfyRuntimeProof === false
      && runtimeBoundarySpawn.proof?.runtimeBoundaryProofAdapter?.adapterProofCanSatisfyRuntimeProof === true
      && runtimeBoundarySpawn.proof?.runtimeBoundaryProofAdapter?.canSatisfyRuntimeProof === false
      && runtimeBoundaryResult.runtimeBoundaryLines.some((line) =>
        line.includes('[gpu-runtime-boundary] dispatcher_epoch ')
        && line.includes('host_identity_previous_generation=1')
      )
      && runtimeBoundaryResult.acceptedForGpuHmr === false
      && runtimeBoundaryResult.canSatisfyRuntimeProof === false
      && runtimeBoundaryResult.gpuHmrSuccess === false
      && runtimeBoundaryResult.blockingGaps.length === 0,
    resultPath: path.relative(REPO_ROOT, runtimeBoundaryResultPath).replace(/\\/g, '/'),
  });
  const forgedManifestPath = path.join(runtimeBoundaryDir, 'runtime-boundary-events-forged.json');
  await fs.writeFile(forgedManifestPath, `${JSON.stringify({
    schemaVersion: RUNTIME_BOUNDARY_EVENT_MANIFEST_SCHEMA,
    proofAuthority: 'runtime_boundary_event_manifest_only_not_gpu_hmr_success',
    gpuHmrSuccess: true,
    runtimeBoundaryEvents,
  }, null, 2)}\n`);
  const forgedBoundaryProfile = normalizeRuntimeProofProfile({
    ...runtimeBoundaryProfile,
    id: 'generic-runtime-boundary-adapter-forged',
    adapter: {
      family: 'generic-runtime-boundary-adapter-forged',
      proofRunner: 'runtime-boundary-proof-adapter',
      runtimeBoundaryEventManifestPath: path.relative(REPO_ROOT, forgedManifestPath).replace(/\\/g, '/'),
    },
  });
  const forgedBoundaryResultPath = path.join(runtimeBoundaryDir, 'runtime-boundary-forged-result.json');
  const forgedBoundarySpawn = await runRuntimeBoundaryProofAdapterProfile(
    forgedBoundaryProfile,
    { resultPath: forgedBoundaryResultPath },
  );
  const forgedBoundaryResult = await writeRuntimeProfileAdapterResult({
    profile: forgedBoundaryProfile,
    adapter: adapterForProfile(forgedBoundaryProfile),
    resultPath: forgedBoundaryResultPath,
    startedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
    spawnResult: forgedBoundarySpawn,
  });
  checks.push({
    name: 'generic-runtime-boundary-profile-adapter-rejects-forged-manifest-authority',
    ok:
      forgedBoundaryResult.strictRuntimeProofAccepted === false
      && forgedBoundaryResult.runtimeBoundaryProofAdapterAccepted === false
      && forgedBoundaryResult.acceptedForGpuHmr === false
      && forgedBoundaryResult.gpuHmrSuccess === false
      && forgedBoundaryResult.blockingGaps.includes('runtime_profile_adapter_strict_runtime_proof_artifact_missing'),
    resultPath: path.relative(REPO_ROOT, forgedBoundaryResultPath).replace(/\\/g, '/'),
  });
  checks.push({
    name: 'profile-declared-adapter-result-contract',
    ok:
      resultSmokeSpawn.exitCode === 0
      && resultSmokeArtifact.schemaVersion === 'synthi.gpu_hmr.runtime_profile_adapter_result.v1'
      && resultSmokeArtifact.proofJsonPresent === true
      && resultSmokeArtifact.strictRuntimeProofAccepted === false
      && resultSmokeArtifact.strictRuntimeProofGateAccepted === false
      && resultSmokeArtifact.blockingGaps.includes('runtime_profile_adapter_strict_gate_rejected')
      && resultSmokeArtifact.acceptedForGpuHmr === false
      && resultSmokeArtifact.canSatisfyRuntimeProof === false
      && resultSmokeArtifact.gpuHmrSuccess === false,
    adapter: resultSmoke.adapter.family,
    resultPath: path.relative(REPO_ROOT, resultSmokePath).replace(/\\/g, '/'),
  });
  const controlled = normalizeRuntimeProofProfile({
    ...baseProfile,
    id: 'profile-controls-smoke',
    build: {
      cmakeArgs: ['-DSYNTHI_DEMO_CACHE=ON'],
      env: { SYNTHI_BUILD_CACHE_ROOT: '/tmp/synthi-cache' },
    },
    runtime: {
      ...baseProfile.runtime,
      env: { SYNTHI_RENDER_DETERMINISTIC: '1' },
    },
    deterministicVisualMode: {
      fixedSeed: '42',
      frozenCamera: true,
      temporalAccumulationDisabled: true,
      denoiserDisabled: true,
      fixedResolution: true,
      presentationFenceOrFrameBoundary: 'framebuffer-capture-after-dispatch',
      warmupFrames: 1,
      convergenceWindow: {
        frameStart: 1,
        frameEnd: 1,
        metric: 'per_frame_delta',
      },
    },
  });
  const controlledEnv = runtimeProfileToHiprtWarmEnv(controlled);
  checks.push({
    name: 'profile-controls-export-to-hiprt-env',
    ok:
      controlled.build.cmakeArgs[0] === '-DSYNTHI_DEMO_CACHE=ON'
      && controlled.runtime.env.SYNTHI_RENDER_DETERMINISTIC === '1'
      && controlled.deterministicVisualMode?.denoiserDisabled === true
      && Boolean(controlledEnv.SYNTHI_HIPRT_WARM_CMAKE_ARGS_JSON)
      && Boolean(controlledEnv.SYNTHI_HIPRT_WARM_RUNTIME_ENV_JSON)
      && Boolean(controlledEnv.SYNTHI_HIPRT_WARM_DETERMINISTIC_VISUAL_MODE_JSON),
    cmakeArgs: controlled.build.cmakeArgs,
    runtimeEnvKeys: Object.keys(controlled.runtime.env).sort(),
  });
  const defaultProfileEnv = runtimeProfileToHiprtWarmEnv(defaultProfile);
  checks.push({
    name: 'runtime-source-tree-and-assets-export-generic-aliases',
    ok:
      defaultProfile.runtime.sourceTree?.proofAuthority === 'runtime_source_tree_prerequisite_only_not_gpu_hmr_success'
      && defaultProfile.runtime.requiredAssets.length > 0
      && Boolean(defaultProfileEnv.SYNTHI_HIPRT_WARM_SOURCE_TREE_JSON)
      && defaultProfileEnv.SYNTHI_GPU_HMR_RUNTIME_SOURCE_TREE_JSON === defaultProfileEnv.SYNTHI_HIPRT_WARM_SOURCE_TREE_JSON
      && Boolean(defaultProfileEnv.SYNTHI_HIPRT_WARM_REQUIRED_ASSETS_JSON)
      && defaultProfileEnv.SYNTHI_GPU_HMR_RUNTIME_REQUIRED_ASSETS_JSON === defaultProfileEnv.SYNTHI_HIPRT_WARM_REQUIRED_ASSETS_JSON,
    requiredAssetCount: defaultProfile.runtime.requiredAssets.length,
  });
  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    schemaVersion: 'synthi.gpu.hmr.runtime_profile.self_check.v1',
    ok: failed.length === 0,
    profileDirectory: path.relative(REPO_ROOT, PROFILE_DIR).replace(/\\/g, '/'),
    discoveredProfileCount: packagedProfiles.length,
    checks,
  }, null, 2));
  if (failed.length > 0) process.exitCode = 1;
}

async function main({
  argv = process.argv.slice(2),
  timingRecorder = null,
  executionContext = {},
} = {}) {
  const args = parseArgs(argv);
  if (args.selfCheck) {
    await selfCheck();
    return;
  }

  const recorder = timingRecorder ?? createRuntimeProfileTimingRecorder({ scope: 'run' });
  if (RUNTIME_PROFILE_TIMING_SCOPES.get(recorder) !== 'run' || recorder.isFinalized) {
    throw new TypeError('runtime_profile_main_timing_recorder_invalid');
  }
  recorder.startPhase('cold_intake');

  const envForLoad = { ...process.env };
  if (args.profilePath) envForLoad.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH = args.profilePath;
  if (args.profileJson) envForLoad.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON = args.profileJson;
  let profileSelectionSource = explicitRuntimeProfileSource(envForLoad);
  if (!profileSelectionSource) {
    if (envForLoad.SYNTHI_GPU_HMR_RUNTIME_ALLOW_PACKAGED_DEFAULT_PROFILE !== '1') {
      throw new Error(
        'runtime profile must be selected explicitly with --profile, --profile-json, '
        + 'SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH, or SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON; '
        + 'set SYNTHI_GPU_HMR_RUNTIME_ALLOW_PACKAGED_DEFAULT_PROFILE=1 only for diagnostic packaged-profile runs',
      );
    }
    envForLoad.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH = await defaultPackagedRuntimeProfilePath();
    profileSelectionSource = 'packaged_default_opt_in';
  }
  const profile = loadRuntimeProofProfileFromEnv(envForLoad, REPO_ROOT);
  executionContext.profile = profile;
  profile.profileSelection = {
    schemaVersion: 'synthi.gpu_hmr.runtime_profile_selection.v1',
    source: profileSelectionSource,
    profilePath: envForLoad.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH
      ?? envForLoad.SYNTHI_HIPRT_WARM_PROFILE_PATH
      ?? null,
    explicit: profileSelectionSource !== 'packaged_default_opt_in',
  };
  if (args.mode) {
    profile.runtime.mode = args.mode;
  } else if (process.env.SYNTHI_GPU_HMR_RUNTIME_MODE) {
    profile.runtime.mode = process.env.SYNTHI_GPU_HMR_RUNTIME_MODE;
  }
  recorder.finishPhase('cold_intake');
  recorder.startPhase('discovery');
  const adapter = adapterForProfile(profile);
  const env = envForAdapter(profile, adapter);
  const resultPath = resolveResultPath(
    args.resultPath
      || process.env.SYNTHI_GPU_HMR_RUNTIME_RESULT_PATH
      || process.env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_RESULT_PATH,
  );
  executionContext.resultPath = resultPath;
  recorder.finishPhase('discovery');

  const startedAt = new Date().toISOString();
  let spawnResult;
  if (adapter.runnerKind === 'runtime-boundary-proof-adapter') {
    spawnResult = await runRuntimeBoundaryProofAdapterProfile(profile, { resultPath });
  } else if (adapter.runnerKind === 'node-script') {
    spawnResult = await spawnNodeScript(adapter.runner, env, adapter.runnerArgs ?? []);
  } else if (adapter.runnerKind === 'process') {
    spawnResult = await spawnProcess(adapter.runner, adapter.runnerArgs ?? [], env);
  } else {
    throw new Error(`unsupported adapter runner kind: ${adapter.runnerKind}`);
  }
  const finishedAt = new Date().toISOString();
  const result = await writeRuntimeProfileAdapterResult({
    profile,
    adapter,
    resultPath,
    startedAt,
    finishedAt,
    spawnResult,
    timingRecorder: recorder,
  });
  process.exitCode = spawnResult.exitCode;
  return result;
}

const directInvocation = process.argv[1]
  && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (directInvocation) {
  const argv = process.argv.slice(2);
  const executionContext = {
    profile: null,
    resultPath: safeFailureResultPath(rawResultPathHint(argv)),
  };
  const timingRecorder = createRuntimeProfileTimingRecorder({ scope: 'run' });
  try {
    await main({ argv, timingRecorder, executionContext });
  } catch (err) {
    console.error(err?.stack ?? err?.message ?? String(err));
    try {
      const failure = await createRuntimeProfileTopLevelFailure(err, {
        timingRecorder,
        resultPath: executionContext.resultPath,
        profile: executionContext.profile,
      });
      console.error(JSON.stringify(failure, null, 2));
    } catch (failureError) {
      console.error(failureError?.stack ?? failureError?.message ?? String(failureError));
    }
    process.exitCode = 1;
  }
}
