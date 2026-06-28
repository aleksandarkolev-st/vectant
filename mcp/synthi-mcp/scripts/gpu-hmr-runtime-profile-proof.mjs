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

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');
const PROFILE_DIR = path.resolve(REPO_ROOT, 'mcp/synthi-mcp/scripts/profiles');

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

function adapterForProfile(profile) {
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
  };
}

async function writeRuntimeProfileAdapterResult({
  profile,
  adapter,
  resultPath,
  startedAt,
  finishedAt,
  spawnResult,
}) {
  const combinedOutput = `${spawnResult.stdout ?? ''}\n${spawnResult.stderr ?? ''}`;
  const rawProofPath = proofPathFromRunnerOutput(combinedOutput);
  const proofPath = resolveProofPath(rawProofPath);
  const proofRead = await readJsonIfPresent(proofPath);
  const proofSummary = summarizeProofArtifact(proofRead.value ?? {});
  const runnerSucceeded = spawnResult.exitCode === 0;
  const strictRuntimeProofAccepted =
    proofSummary.strictRuntimeProofArtifactPresent === true
    && proofSummary.gpuHmrSuccess === true
    && proofSummary.fullRuntimeProven === true
    && proofSummary.limitationsPresent !== true;
  const blockingGaps = [
    runnerSucceeded ? null : 'runtime_profile_adapter_runner_failed',
    rawProofPath ? null : 'runtime_profile_adapter_proof_path_missing',
    rawProofPath && !proofPath ? 'runtime_profile_adapter_proof_path_outside_repo' : null,
    proofPath && !proofRead.present ? 'runtime_profile_adapter_proof_json_unreadable' : null,
    proofRead.present && !proofSummary.strictRuntimeProofArtifactPresent
      ? 'runtime_profile_adapter_strict_runtime_proof_artifact_missing'
      : null,
    proofSummary.strictRuntimeProofArtifactPresent && proofSummary.gpuHmrSuccess !== true
      ? 'runtime_profile_adapter_gpu_hmr_success_false'
      : null,
    proofSummary.strictRuntimeProofArtifactPresent && proofSummary.fullRuntimeProven !== true
      ? 'runtime_profile_adapter_full_runtime_not_proven'
      : null,
    proofSummary.limitationsPresent ? 'runtime_profile_adapter_limitations_present' : null,
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
    ...proofSummary,
    strictRuntimeProofAccepted,
    strict_runtime_proof_accepted: strictRuntimeProofAccepted,
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
  };
  const resultHash = `sha256:${sha256Text(stableJson(result))}`;
  result.resultHash = resultHash;
  result.result_hash = resultHash;
  if (resultPath) {
    await fs.mkdir(path.dirname(resultPath), { recursive: true });
    await fs.writeFile(resultPath, `${JSON.stringify(result, null, 2)}\n`);
    console.log(`runtime_profile_result=${resultPath}`);
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

function explicitRuntimeProfileSource(env) {
  if (env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON?.trim()) return 'explicit_profile_json';
  if (env.SYNTHI_HIPRT_WARM_PROFILE_JSON?.trim()) return 'explicit_hiprt_profile_json';
  if (env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH?.trim()) return 'explicit_profile_path';
  if (env.SYNTHI_HIPRT_WARM_PROFILE_PATH?.trim()) return 'explicit_hiprt_profile_path';
  return null;
}

async function selfCheck() {
  const checks = [];
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
  const resultSmokeFinishedAt = new Date().toISOString();
  const resultSmokeArtifact = await writeRuntimeProfileAdapterResult({
    profile: resultSmoke,
    adapter: resultSmokeAdapter,
    resultPath: resultSmokePath,
    startedAt: resultSmokeStartedAt,
    finishedAt: resultSmokeFinishedAt,
    spawnResult: resultSmokeSpawn,
  });
  checks.push({
    name: 'profile-declared-adapter-result-contract',
    ok:
      resultSmokeSpawn.exitCode === 0
      && resultSmokeArtifact.schemaVersion === 'synthi.gpu_hmr.runtime_profile_adapter_result.v1'
      && resultSmokeArtifact.proofJsonPresent === true
      && resultSmokeArtifact.strictRuntimeProofAccepted === true
      && resultSmokeArtifact.acceptedForGpuHmr === false
      && resultSmokeArtifact.canSatisfyRuntimeProof === false
      && resultSmokeArtifact.blockingGaps.length === 0,
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfCheck) {
    await selfCheck();
    return;
  }

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
  const adapter = adapterForProfile(profile);
  const env = envForAdapter(profile, adapter);
  const resultPath = resolveResultPath(
    args.resultPath
      || process.env.SYNTHI_GPU_HMR_RUNTIME_RESULT_PATH
      || process.env.SYNTHI_GPU_HMR_RUNTIME_PROFILE_RESULT_PATH,
  );

  const startedAt = new Date().toISOString();
  let spawnResult;
  if (adapter.runnerKind === 'node-script') {
    spawnResult = await spawnNodeScript(adapter.runner, env, adapter.runnerArgs ?? []);
  } else if (adapter.runnerKind === 'process') {
    spawnResult = await spawnProcess(adapter.runner, adapter.runnerArgs ?? [], env);
  } else {
    throw new Error(`unsupported adapter runner kind: ${adapter.runnerKind}`);
  }
  const finishedAt = new Date().toISOString();
  await writeRuntimeProfileAdapterResult({
    profile,
    adapter,
    resultPath,
    startedAt,
    finishedAt,
    spawnResult,
  });
  process.exitCode = spawnResult.exitCode;
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err));
  process.exitCode = 1;
});
