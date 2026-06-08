import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const GPU_HMR_ADVERSARIAL_PREFLIGHT_SCHEMA_VERSION =
  'synthi.gpu_hmr.adversarial_preflight.v1';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_SELF_CHECK = path.resolve(
  __dirname,
  '../gpu-hmr-adversarial-proof-ledger-self-check.mjs',
);

function tail(value, max = 4000) {
  const text = String(value ?? '');
  return text.length <= max ? text : text.slice(text.length - max);
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function skippedByEnv(env) {
  const raw = String(env.SYNTHI_GPU_HMR_SKIP_ADVERSARIAL_PREFLIGHT ?? '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
}

export async function runGpuHmrAdversarialPreflight(options = {}) {
  const env = options.env ?? process.env;
  const scriptPath = path.resolve(options.scriptPath ?? DEFAULT_SELF_CHECK);
  const startedNs = process.hrtime.bigint();
  if (skippedByEnv(env)) {
    return {
      schemaVersion: GPU_HMR_ADVERSARIAL_PREFLIGHT_SCHEMA_VERSION,
      ok: false,
      skipped: true,
      reason: 'SYNTHI_GPU_HMR_SKIP_ADVERSARIAL_PREFLIGHT',
      scriptPath,
      elapsedMs: 0,
    };
  }
  const result = await new Promise((resolve) => {
    const child = spawn(process.execPath, [scriptPath], {
      cwd: options.cwd ?? process.cwd(),
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', (error) => {
      resolve({ code: null, error, stdout, stderr });
    });
    child.on('close', (code) => {
      resolve({ code, error: null, stdout, stderr });
    });
  });
  const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1_000_000;
  const record = {
    schemaVersion: GPU_HMR_ADVERSARIAL_PREFLIGHT_SCHEMA_VERSION,
    ok: result.code === 0 && !result.error,
    skipped: false,
    scriptPath,
    exitCode: result.code,
    elapsedMs,
    stdoutHash: `sha256:${sha256Hex(result.stdout)}`,
    stderrHash: `sha256:${sha256Hex(result.stderr)}`,
    stdoutTail: tail(result.stdout),
    stderrTail: tail(result.stderr),
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
  if (!record.ok) {
    throw new Error(
      `GPU HMR adversarial preflight failed: exit=${record.exitCode} `
      + `error=${record.error ?? 'none'} stderr=${record.stderrTail}`,
    );
  }
  return record;
}
