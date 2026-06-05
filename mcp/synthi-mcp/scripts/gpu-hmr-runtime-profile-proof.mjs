#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_HIPRT_RUNTIME_PROFILE,
  GPU_HMR_RUNTIME_PROFILE_SCHEMA_VERSION,
  loadRuntimeProofProfileFromEnv,
  normalizeRuntimeProofProfile,
  runtimeProfileToHiprtWarmEnv,
} from './lib/gpu-hmr-runtime-profile.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '../../..');

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

async function selfCheck() {
  const checks = [];
  const packagedProfiles = [
    'mcp/synthi-mcp/scripts/profiles/hiprt-megakernel-direct-light-zero.json',
    'mcp/synthi-mcp/scripts/profiles/hiprt-camera-rays-horizontal-mirror.json',
  ];
  const defaultProfile = normalizeRuntimeProofProfile(DEFAULT_HIPRT_RUNTIME_PROFILE);
  checks.push({
    name: 'default-profile-normalizes',
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
  const unsupported = normalizeRuntimeProofProfile({
    ...DEFAULT_HIPRT_RUNTIME_PROFILE,
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
    ...DEFAULT_HIPRT_RUNTIME_PROFILE,
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
  const failed = checks.filter((check) => !check.ok);
  console.log(JSON.stringify({
    schemaVersion: 'synthi.gpu.hmr.runtime_profile.self_check.v1',
    ok: failed.length === 0,
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
  const profile = loadRuntimeProofProfileFromEnv(envForLoad, REPO_ROOT, DEFAULT_HIPRT_RUNTIME_PROFILE);
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
