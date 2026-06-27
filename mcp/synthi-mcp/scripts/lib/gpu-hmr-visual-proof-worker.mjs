import { Worker } from 'node:worker_threads';

export const GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION =
  'synthi.gpu_hmr.async_visual_proof_worker.v1';

export const GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY =
  'async_visual_metrics_only';

export async function computeAsyncVisualProof(input = {}, options = {}) {
  const timeoutMs = finitePositiveInteger(options.timeoutMs, 30000);
  const workerUrl = new URL('./gpu-hmr-visual-proof-worker-thread.mjs', import.meta.url);
  const startedAt = Date.now();
  const request = {
    ...input,
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    clientStartedAtMs: startedAt,
  };

  return new Promise((resolve) => {
    let settled = false;
    let worker = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(normalizeWorkerResult(result, startedAt));
    };

    const timeout = setTimeout(() => {
      const timeoutResult = failClosedWorkerResult('visual_worker_timeout', {
        startedAtMs: startedAt,
        durationMs: Date.now() - startedAt,
        timeoutMs,
      });
      if (worker) {
        worker.terminate().catch(() => {});
      }
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

function normalizeWorkerResult(result, startedAtMs) {
  const normalized = result && typeof result === 'object'
    ? result
    : failClosedWorkerResult('visual_worker_invalid_result');
  const accepted = normalized.accepted === true;
  return {
    ...normalized,
    schemaVersion: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
    eventType: 'proof_ready',
    accepted,
    acceptedAsAsyncVisualMetrics: accepted && normalized.acceptedAsAsyncVisualMetrics !== false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_AUTHORITY,
    durationMs: Number.isFinite(normalized.durationMs)
      ? normalized.durationMs
      : Math.max(0, Date.now() - startedAtMs),
  };
}

function finitePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function finiteNonnegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 ? number : fallback;
}
