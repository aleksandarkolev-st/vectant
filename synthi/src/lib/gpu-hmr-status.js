'use client';

const initialState = Object.freeze({
  reloadPlan: null,
  reloadReason: null,
  snapshotTier: null,
  snapshotMs: null,
  snapshotBytes: null,
  snapshotBudgetMs: null,
  ptxas: null,
  runtimeError: null,
  lastEvent: null,
  lastUpdatedAt: null,
});

let currentState = { ...initialState };
const listeners = new Set();
let installed = false;

function emit(next) {
  currentState = {
    ...currentState,
    ...next,
    lastUpdatedAt: Date.now(),
  };
  listeners.forEach((listener) => {
    try {
      listener(currentState);
    } catch (_) {
      // keep notification fan-out best-effort
    }
  });
}

function parseKeyValueLine(line) {
  const out = {};
  for (const [, key, value] of line.matchAll(/\b([a-zA-Z_][a-zA-Z0-9_]*)=([^\s]+)/g)) {
    out[key] = value;
  }
  return out;
}

function toNumber(value) {
  if (value == null) return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function parseJsonLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith('{')) return null;

  try {
    return JSON.parse(trimmed);
  } catch (_) {
    return null;
  }
}

export function parseGpuHmrLine(line) {
  if (!line || typeof line !== 'string') return null;
  const parsedJson = parseJsonLine(line);
  if (parsedJson?.line) {
    return parseGpuHmrLine(parsedJson.line);
  }

  if (parsedJson?.type === 'gpu_snapshot_telemetry') {
    return {
      snapshotTier: parsedJson.snapshot_tier || parsedJson.snapshotTier || null,
      snapshotMs: toNumber(parsedJson.snapshot_ms ?? parsedJson.snapshotMs),
      snapshotBytes: toNumber(parsedJson.snapshot_bytes ?? parsedJson.snapshotBytes),
      snapshotBudgetMs: toNumber(parsedJson.budget_ms ?? parsedJson.snapshotBudgetMs),
      runtimeError: null,
      lastEvent: 'snapshot',
    };
  }

  if (parsedJson?.type === 'gpu_runtime_error') {
    return {
      runtimeError: {
        kind: parsedJson.kind || parsedJson.error_kind || 'unknown',
        raw: line,
      },
      lastEvent: 'runtime',
    };
  }

  if (line.includes('gpu_snapshot_telemetry')) {
    const fields = parseKeyValueLine(line);
    return {
      snapshotTier: fields.snapshot_tier || null,
      snapshotMs: toNumber(fields.snapshot_ms),
      snapshotBytes: toNumber(fields.snapshot_bytes),
      snapshotBudgetMs: toNumber(fields.budget_ms),
      runtimeError: null,
      lastEvent: 'snapshot',
    };
  }

  if (line.includes('[gpu-reload]') && line.includes('plan=')) {
    const fields = parseKeyValueLine(line);
    return {
      reloadPlan: fields.plan || null,
      reloadReason: fields.reason || null,
      runtimeError: null,
      lastEvent: 'reload',
    };
  }

  if (line.includes('[ptxas]')) {
    const regs = line.match(/Used\s+(\d+)\s+registers/i);
    const spill = line.match(/(\d+)\s+bytes\s+spill/i);
    return {
      ptxas: {
        registers: regs ? Number(regs[1]) : null,
        spillBytes: spill ? Number(spill[1]) : null,
        raw: line,
      },
      runtimeError: null,
      lastEvent: 'ptxas',
    };
  }

  if (line.includes('gpu_runtime_error')) {
    const fields = parseKeyValueLine(line);
    return {
      runtimeError: {
        kind: fields.kind || fields.error_kind || 'unknown',
        raw: line,
      },
      lastEvent: 'runtime',
    };
  }

  return null;
}

export function handleGpuHmrStatusNotification(detail) {
  if (!detail) return;
  if (typeof detail === 'string') {
    const parsed = parseGpuHmrLine(detail);
    if (parsed) emit(parsed);
    return;
  }

  if (detail.type === 'gpu-hmr-status') {
    emit(detail.data || {});
    return;
  }

  if (detail.line && typeof detail.line === 'string') {
    const parsed = parseGpuHmrLine(detail.line);
    if (parsed) emit(parsed);
  }
}

export function getGpuHmrStatus() {
  return currentState;
}

export function subscribeGpuHmrStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function installGpuHmrStatusListener() {
  if (typeof window === 'undefined' || installed) return () => {};
  installed = true;

  const handler = (event) => {
    const detail = event?.detail;
    if (detail?.line) {
      handleGpuHmrStatusNotification(detail.line);
    } else {
      handleGpuHmrStatusNotification(detail);
    }
  };

  window.addEventListener('synthi:gpu-hmr-status', handler);
  window.addEventListener('synthi:build-stream', handler);

  return () => {
    window.removeEventListener('synthi:gpu-hmr-status', handler);
    window.removeEventListener('synthi:build-stream', handler);
    installed = false;
  };
}
