export function monotonicNowNs() {
  return process.hrtime.bigint().toString();
}

export function monotonicDurationNs(startNs, endNs = monotonicNowNs()) {
  const start = BigInt(String(startNs));
  const end = BigInt(String(endNs));
  return (end - start).toString();
}

export function monotonicNsToMs(durationNs) {
  const ns = Number(BigInt(String(durationNs)));
  return ns / 1_000_000;
}

export function monotonicElapsedMs(startNs, endNs = monotonicNowNs()) {
  return monotonicNsToMs(monotonicDurationNs(startNs, endNs));
}

export function monotonicTimingFields(startNs, endNs = monotonicNowNs()) {
  const durationNs = monotonicDurationNs(startNs, endNs);
  return {
    metric_clock: 'monotonic_ns',
    metricClock: 'monotonic_ns',
    started_monotonic_ns: String(startNs),
    startedMonotonicNs: String(startNs),
    finished_monotonic_ns: String(endNs),
    finishedMonotonicNs: String(endNs),
    duration_monotonic_ns: durationNs,
    durationMonotonicNs: durationNs,
    duration_ms: monotonicNsToMs(durationNs),
    durationMs: monotonicNsToMs(durationNs),
  };
}
