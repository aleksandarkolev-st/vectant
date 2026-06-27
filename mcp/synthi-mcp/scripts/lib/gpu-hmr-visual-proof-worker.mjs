import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export const GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION =
  'synthi.gpu_hmr.async_visual_proof_worker.v1';

export const GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY =
  'async_visual_metrics_only';

export const GPU_HMR_VISUAL_WORKER_EXECUTABLE_MANIFEST_SCHEMA_VERSION =
  'synthi.gpu_hmr.visual_worker_executable_manifest.v1';

export async function computeAsyncVisualProof(input = {}, options = {}) {
  const timeoutMs = finitePositiveInteger(options.timeoutMs, 30000);
  const workerUrl = new URL('./gpu-hmr-visual-proof-worker-thread.mjs', import.meta.url);
  const expectedWorkerIdentity = await computeVisualWorkerExecutableIdentity();
  const expectedWorkerExecutableHash =
    normalizeSha256Hash(options.expectedWorkerExecutableHash)
    ?? expectedWorkerIdentity.executableHash;
  const startedAt = Date.now();
  const request = {
    ...input,
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    clientStartedAtMs: startedAt,
    expectedWorkerExecutableHash,
    expected_worker_executable_hash: expectedWorkerExecutableHash,
  };

  return new Promise((resolve) => {
    let settled = false;
    let worker = null;
    const cleanupWorker = async () => {
      const currentWorker = worker;
      worker = null;
      if (currentWorker) {
        currentWorker.removeAllListeners('message');
        currentWorker.removeAllListeners('error');
        currentWorker.removeAllListeners('exit');
        try {
          await currentWorker.terminate();
        } catch {
          // The result is already fail-closed or accepted; cleanup must not mask it.
        }
      }
    };
    const finish = async (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      await cleanupWorker();
      resolve(normalizeWorkerResult(result, startedAt, {
        expectedWorkerExecutableHash,
      }));
    };

    const timeout = setTimeout(() => {
      const timeoutResult = failClosedWorkerResult('visual_worker_timeout', {
        startedAtMs: startedAt,
        durationMs: Date.now() - startedAt,
        timeoutMs,
      });
      finish(timeoutResult);
    }, timeoutMs);

    try {
      worker = new Worker(workerUrl, {
        workerData: {
          request,
          options: {
            allowedRoots: Array.isArray(options.allowedRoots) ? options.allowedRoots : [],
            allowedOutputRoots: Array.isArray(options.allowedOutputRoots) ? options.allowedOutputRoots : [],
            diagnosticDelayMs: finiteNonnegativeInteger(options.diagnosticDelayMs, 0),
            expectedWorkerExecutableHash,
          },
        },
      });
    } catch (error) {
      finish(failClosedWorkerResult('visual_worker_start_failed', {
        startedAtMs: startedAt,
        durationMs: Date.now() - startedAt,
        message: error?.message ?? String(error),
      }));
      return;
    }

    worker.once('message', (message) => finish(message));
    worker.once('error', (error) => finish(failClosedWorkerResult('visual_worker_error', {
      startedAtMs: startedAt,
      durationMs: Date.now() - startedAt,
      message: error?.message ?? String(error),
    })));
    worker.once('exit', (code) => {
      if (!settled && code !== 0) {
        finish(failClosedWorkerResult('visual_worker_exited_nonzero', {
          startedAtMs: startedAt,
          durationMs: Date.now() - startedAt,
          exitCode: code,
        }));
      }
    });
  });
}

export function failClosedWorkerResult(reason, details = {}) {
  const reasons = [String(reason || 'visual_worker_failed')];
  return {
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    eventType: 'proof_ready',
    accepted: false,
    acceptedAsAsyncVisualMetrics: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    worker: {
      kind: 'node_worker_threads',
      offMainThread: true,
      failedBeforeWorkerCompletion: true,
    },
    incremental: {
      roiEvaluated: false,
      tileHashing: false,
      fullFrameDiffComputed: false,
      deepDiffSkipped: false,
      skipReason: null,
    },
    reasons,
    gaps: reasons,
    details,
  };
}

export async function computeVisualWorkerExecutableIdentity() {
  const modules = [];
  for (const moduleEntry of visualWorkerExecutableModules()) {
    const bytes = await readFile(moduleEntry.url);
    const contentHash = hashBytes(bytes);
    modules.push({
      role: moduleEntry.role,
      fileName: path.basename(moduleEntry.url.pathname),
      file_name: path.basename(moduleEntry.url.pathname),
      byteLength: bytes.byteLength,
      byte_length: bytes.byteLength,
      contentHash,
      content_hash: contentHash,
    });
  }
  const manifest = {
    schemaVersion: GPU_HMR_VISUAL_WORKER_EXECUTABLE_MANIFEST_SCHEMA_VERSION,
    schema_version: GPU_HMR_VISUAL_WORKER_EXECUTABLE_MANIFEST_SCHEMA_VERSION,
    hashMode: 'ordered_local_module_graph',
    hash_mode: 'ordered_local_module_graph',
    modules,
  };
  const executableHash = hashText(stableJson(manifest));
  return {
    executableHash,
    executable_hash: executableHash,
    executableManifestHash: executableHash,
    executable_manifest_hash: executableHash,
    executableManifestSchemaVersion: GPU_HMR_VISUAL_WORKER_EXECUTABLE_MANIFEST_SCHEMA_VERSION,
    executable_manifest_schema_version: GPU_HMR_VISUAL_WORKER_EXECUTABLE_MANIFEST_SCHEMA_VERSION,
    executableModuleCount: modules.length,
    executable_module_count: modules.length,
    executableManifest: manifest,
    executable_manifest: manifest,
  };
}

function normalizeWorkerResult(result, startedAtMs, context = {}) {
  const normalized = result && typeof result === 'object'
    ? result
    : failClosedWorkerResult('visual_worker_invalid_result');
  const identityReasons = workerIdentityRejectionReasons(normalized, context);
  const reasons = [
    ...(Array.isArray(normalized.reasons) ? normalized.reasons : []),
    ...identityReasons,
  ];
  const gaps = [
    ...(Array.isArray(normalized.gaps) ? normalized.gaps : []),
    ...identityReasons,
  ];
  const accepted = normalized.accepted === true && identityReasons.length === 0;
  return {
    ...normalized,
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    eventType: 'proof_ready',
    rawEventType: normalized.eventType ?? null,
    raw_event_type: normalized.eventType ?? null,
    accepted,
    acceptedAsAsyncVisualMetrics: accepted && normalized.acceptedAsAsyncVisualMetrics !== false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    reasons,
    gaps,
    durationMs: Number.isFinite(normalized.durationMs)
      ? normalized.durationMs
      : Math.max(0, Date.now() - startedAtMs),
  };
}

function workerIdentityRejectionReasons(result, context = {}) {
  if (!result || typeof result !== 'object' || result.accepted !== true) return [];
  const reasons = [];
  if (result.eventType !== 'proof_ready') reasons.push('visual_worker_proof_ready_event_missing');
  const worker = result.worker && typeof result.worker === 'object' ? result.worker : null;
  if (!worker) {
    reasons.push('visual_worker_identity_missing');
    return reasons;
  }
  if (worker.offMainThread !== true && worker.off_main_thread !== true) {
    reasons.push('visual_worker_off_main_thread_unproven');
  }
  const executableHash = normalizeSha256Hash(
    worker.executableHash
    ?? worker.executable_hash
    ?? worker.workerExecutableHash
    ?? worker.worker_executable_hash,
  );
  if (!executableHash) {
    reasons.push('visual_worker_executable_hash_missing');
  } else if (
    context.expectedWorkerExecutableHash
    && executableHash !== context.expectedWorkerExecutableHash
  ) {
    reasons.push('visual_worker_executable_hash_mismatch');
  }
  return reasons;
}

function visualWorkerExecutableModules() {
  return [
    { role: 'visual_worker_entry', url: new URL('./gpu-hmr-visual-proof-worker-thread.mjs', import.meta.url) },
    { role: 'visual_worker_client', url: new URL('./gpu-hmr-visual-proof-worker.mjs', import.meta.url) },
    { role: 'artifact_cas_helper', url: new URL('./gpu-hmr-artifact-cas.mjs', import.meta.url) },
  ];
}

function hashBytes(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashText(value) {
  return hashBytes(Buffer.from(String(value ?? ''), 'utf8'));
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function normalizeSha256Hash(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  const digest = trimmed.startsWith('sha256:') ? trimmed.slice('sha256:'.length) : trimmed;
  return /^[a-f0-9]{64}$/.test(digest) ? `sha256:${digest}` : null;
}

function finitePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function finiteNonnegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
