const ENABLED = (() => {
  try {
    const v = process.env.NEXT_PUBLIC_PERF_MARKERS;
    return v === '1' || v === 'true' || v === 'yes';
  } catch (_) {
    return false;
  }
})();

const once = new Set();

export function perfEnabled() {
  return ENABLED;
}

export function perfMark(name) {
  if (!ENABLED) return;
  try {
    performance.mark(name);
  } catch (_) {}
}

export function perfMeasure(name, startMark, endMark) {
  if (!ENABLED) return;
  try {
    performance.measure(name, startMark, endMark);
  } catch (_) {}
}

export function perfMeasureToConsole(name, startTimeMs, extra = {}) {
  if (!ENABLED) return;
  try {
    const dur = Math.max(0, performance.now() - startTimeMs);
    // Non-blocking; can be removed behind flag.
    queueMicrotask(() => {
      try {
        // eslint-disable-next-line no-console
        console.debug(`[perf] ${name}: ${dur.toFixed(1)}ms`, extra);
      } catch (_) {}
    });
  } catch (_) {}
}

export function perfOnce(key, fn) {
  if (!ENABLED) return;
  if (once.has(key)) return;
  once.add(key);
  try { fn(); } catch (_) {}
}
