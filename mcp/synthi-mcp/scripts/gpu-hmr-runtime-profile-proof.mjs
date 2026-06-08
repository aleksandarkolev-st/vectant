#!/usr/bin/env node
import { spawn } from 'node:child_process';
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
    throw new Error(`unknown argument: ${arg}`);
  }
  return parsed;
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

function spawnNodeScript(scriptPath, env, runnerArgs = []) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, ...runnerArgs], {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(128);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

function spawnProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
      windowsHide: true,
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (signal) {
        resolve(128);
        return;
      }
      resolve(code ?? 1);
    });
  });
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
  const controlled = normalizeRuntimeProofProfile({
    ...DEFAULT_HIPRT_RUNTIME_PROFILE,
    id: 'profile-controls-smoke',
    build: {
      cmakeArgs: ['-DSYNTHI_DEMO_CACHE=ON'],
      env: { SYNTHI_BUILD_CACHE_ROOT: '/tmp/synthi-cache' },
    },
    runtime: {
      ...DEFAULT_HIPRT_RUNTIME_PROFILE.runtime,
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
  if (!envForLoad.SYNTHI_GPU_HMR_RUNTIME_PROFILE_JSON?.trim()
    && !envForLoad.SYNTHI_HIPRT_WARM_PROFILE_JSON?.trim()
    && !envForLoad.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH?.trim()
    && !envForLoad.SYNTHI_HIPRT_WARM_PROFILE_PATH?.trim()) {
    envForLoad.SYNTHI_GPU_HMR_RUNTIME_PROFILE_PATH = await defaultPackagedRuntimeProfilePath();
  }
  const profile = loadRuntimeProofProfileFromEnv(envForLoad, REPO_ROOT);
  if (args.mode) {
    profile.runtime.mode = args.mode;
  } else if (process.env.SYNTHI_GPU_HMR_RUNTIME_MODE) {
    profile.runtime.mode = process.env.SYNTHI_GPU_HMR_RUNTIME_MODE;
  }
  const adapter = adapterForProfile(profile);
  const env = envForAdapter(profile, adapter);

  let exitCode;
  if (adapter.runnerKind === 'node-script') {
    exitCode = await spawnNodeScript(adapter.runner, env, adapter.runnerArgs ?? []);
  } else if (adapter.runnerKind === 'process') {
    exitCode = await spawnProcess(adapter.runner, adapter.runnerArgs ?? [], env);
  } else {
    throw new Error(`unsupported adapter runner kind: ${adapter.runnerKind}`);
  }
  process.exitCode = exitCode;
}

main().catch((err) => {
  console.error(err?.stack ?? err?.message ?? String(err));
  process.exitCode = 1;
});
