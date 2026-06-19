function finiteNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function nonNegativeInteger(value) {
  if (!finiteNumber(value)) return null;
  return Math.max(0, Math.floor(value));
}

function numberOrNull(value) {
  return finiteNumber(value) ? value : null;
}

export function captureSoakMemorySample({ at = Date.now(), memoryUsage = process.memoryUsage() } = {}) {
  return {
    at,
    source: "node_process_memory_usage",
    rss_bytes: nonNegativeInteger(memoryUsage.rss),
    heap_total_bytes: nonNegativeInteger(memoryUsage.heapTotal),
    heap_used_bytes: nonNegativeInteger(memoryUsage.heapUsed),
    external_bytes: nonNegativeInteger(memoryUsage.external),
    array_buffer_bytes: nonNegativeInteger(memoryUsage.arrayBuffers),
  };
}

export function summarizeSoakMemorySamples(samples = []) {
  const valid = samples
    .map((sample) => ({
      at: numberOrNull(sample?.at),
      rss_bytes: numberOrNull(sample?.rss_bytes),
      heap_total_bytes: numberOrNull(sample?.heap_total_bytes),
      heap_used_bytes: numberOrNull(sample?.heap_used_bytes),
      external_bytes: numberOrNull(sample?.external_bytes),
      array_buffer_bytes: numberOrNull(sample?.array_buffer_bytes),
    }))
    .filter((sample) => sample.rss_bytes !== null);
  const first = valid[0] || null;
  const last = valid.at(-1) || null;
  return {
    source: "node_process_memory_usage",
    sample_count: valid.length,
    rss_start_bytes: first?.rss_bytes ?? null,
    rss_end_bytes: last?.rss_bytes ?? null,
    rss_max_bytes: maxMetric(valid, "rss_bytes"),
    rss_growth_bytes: first && last ? last.rss_bytes - first.rss_bytes : null,
    heap_used_start_bytes: first?.heap_used_bytes ?? null,
    heap_used_end_bytes: last?.heap_used_bytes ?? null,
    heap_used_max_bytes: maxMetric(valid, "heap_used_bytes"),
    heap_used_growth_bytes: first && last && first.heap_used_bytes !== null && last.heap_used_bytes !== null
      ? last.heap_used_bytes - first.heap_used_bytes
      : null,
    external_max_bytes: maxMetric(valid, "external_bytes"),
    array_buffer_max_bytes: maxMetric(valid, "array_buffer_bytes"),
  };
}

export function extractNumericUsageCounters(payload) {
  const source = payload?.counters && typeof payload.counters === "object" ? payload.counters : {};
  const counters = {};
  for (const [key, value] of Object.entries(source)) {
    const numeric = Number(value);
    if (Number.isFinite(numeric)) counters[key] = numeric;
  }
  return counters;
}

export function extractRuntimeResourceCounters(payload) {
  const diagnostics = payload?.runtime_session_diagnostics && typeof payload.runtime_session_diagnostics === "object"
    ? payload.runtime_session_diagnostics
    : payload && typeof payload === "object"
      ? payload
      : {};
  return {
    session_state: typeof diagnostics.session_state === "string" ? diagnostics.session_state : null,
    active_session_count: nonNegativeInteger(diagnostics.active_session_count),
    active_frame_sink_count: nonNegativeInteger(diagnostics.active_frame_sink_count),
    attached_session_id: typeof diagnostics.attached_session_id === "string" ? diagnostics.attached_session_id : null,
  };
}

export function summarizeUsageCounterSamples(samples = []) {
  const valid = samples
    .map((sample) => ({
      at: numberOrNull(sample?.at),
      phase: typeof sample?.phase === "string" ? sample.phase : "unknown",
      counters: normalizeCounterMap(sample?.counters),
    }))
    .filter((sample) => Object.keys(sample.counters).length > 0);
  const first = valid[0] || null;
  const last = valid.at(-1) || null;
  const names = new Set([
    ...Object.keys(first?.counters || {}),
    ...Object.keys(last?.counters || {}),
  ]);
  const delta = {};
  for (const name of names) {
    const start = first?.counters?.[name] ?? 0;
    const end = last?.counters?.[name] ?? 0;
    delta[name] = end - start;
  }
  return {
    sample_count: valid.length,
    first_phase: first?.phase ?? null,
    last_phase: last?.phase ?? null,
    first_counters: first?.counters ?? {},
    last_counters: last?.counters ?? {},
    delta,
    counter_names: [...names].sort(),
  };
}

export function summarizeRuntimeResourceSamples(samples = []) {
  const valid = samples
    .map((sample) => ({
      at: numberOrNull(sample?.at),
      phase: typeof sample?.phase === "string" ? sample.phase : "unknown",
      ...extractRuntimeResourceCounters(sample?.payload || sample),
    }))
    .filter((sample) => sample.active_session_count !== null || sample.active_frame_sink_count !== null);
  const first = valid[0] || null;
  const last = valid.at(-1) || null;
  const postDetach = [...valid].reverse().find((sample) => sample.phase === "post_detach") || null;
  const leakSource = postDetach ? "post_detach_runtime_session_diagnostics" : "runtime_session_diagnostics_without_post_detach";
  const leakBasis = postDetach || last;
  return {
    source: "synthi_get_usage.runtime_session_diagnostics",
    sample_count: valid.length,
    post_detach_observed: Boolean(postDetach),
    first_phase: first?.phase ?? null,
    last_phase: last?.phase ?? null,
    active_session_count_start: first?.active_session_count ?? null,
    active_session_count_end: last?.active_session_count ?? null,
    active_session_count_max: maxMetric(valid, "active_session_count"),
    active_frame_sink_count_start: first?.active_frame_sink_count ?? null,
    active_frame_sink_count_end: last?.active_frame_sink_count ?? null,
    active_frame_sink_count_max: maxMetric(valid, "active_frame_sink_count"),
    browser_session_leak_count: leakBasis?.active_session_count ?? null,
    frame_sink_leak_count: leakBasis?.active_frame_sink_count ?? null,
    leak_count_source: leakSource,
  };
}

function normalizeCounterMap(value) {
  const counters = value && typeof value === "object" ? value : {};
  const normalized = {};
  for (const [key, raw] of Object.entries(counters)) {
    const numeric = Number(raw);
    if (Number.isFinite(numeric)) normalized[key] = numeric;
  }
  return normalized;
}

function maxMetric(samples, field) {
  const values = samples
    .map((sample) => sample?.[field])
    .filter((value) => value !== null && value !== undefined && Number.isFinite(Number(value)))
    .map(Number);
  return values.length ? Math.max(...values) : null;
}
