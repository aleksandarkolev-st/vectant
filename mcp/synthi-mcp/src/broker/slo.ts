export type BrokerSloMetricName =
  | "broker_fanout_latency_p95"
  | "screenshot_age_p95"
  | "input_ack_timeout_rate"
  | "input_postcondition_success_rate"
  | "duplicate_inference_reduction"
  | "locate_cache_hit_latency_p95"
  | "subscriber_frame_drop_rate"
  | "broker_recovery_time_p95";

export type BrokerSloAggregation = "p95" | "ratio";
export type BrokerSloComparison = "lte" | "gte";

export interface BrokerSloDefinition {
  name: BrokerSloMetricName;
  numerator: string;
  denominator: string;
  start_ts: string;
  end_ts: string;
  exclusions: string[];
  window: string;
  owner: string;
  alert_threshold: string;
  aggregation: BrokerSloAggregation;
  comparison: BrokerSloComparison;
  target: number;
  unit: "ms" | "rate";
}

export interface BrokerSloSample {
  name: BrokerSloMetricName;
  ts: number;
  value: number;
  denominator?: number;
  excluded?: boolean;
  labels?: Record<string, string>;
}

export interface BrokerSloGate {
  name: BrokerSloMetricName;
  status: "pass" | "fail" | "unknown";
  observed: number | null;
  target: number;
  comparison: BrokerSloComparison;
  sample_count: number;
  window_ms: number;
}

export interface BrokerSloAcceptance {
  ok: boolean;
  evaluated_at: number;
  gates: BrokerSloGate[];
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const BROKER_SLO_DEFINITIONS: readonly BrokerSloDefinition[] = [
  {
    name: "broker_fanout_latency_p95",
    numerator: "subscriber_emit_ts - ingest_ts per delivered control/frame metadata event",
    denominator: "total delivered events in window",
    start_ts: "ingest_ts",
    end_ts: "subscriber_emit_ts",
    exclusions: ["sessions in BROKER_RECOVERING state"],
    window: "5m rolling",
    owner: "Broker team",
    alert_threshold: "p95 > 150ms for 3 windows",
    aggregation: "p95",
    comparison: "lte",
    target: 150,
    unit: "ms",
  },
  {
    name: "screenshot_age_p95",
    numerator: "tool_response_ts - frame_ts_of_returned_image",
    denominator: "successful screenshot responses",
    start_ts: "frame_ts_of_returned_image",
    end_ts: "tool_response_ts",
    exclusions: ["explicit stale-test scenarios in canary suites"],
    window: "5m",
    owner: "Broker team",
    alert_threshold: "p95 > 750ms",
    aggregation: "p95",
    comparison: "lte",
    target: 750,
    unit: "ms",
  },
  {
    name: "input_ack_timeout_rate",
    numerator: "input calls lacking browser_ack within SLA",
    denominator: "total state-changing input calls",
    start_ts: "received_at",
    end_ts: "browser_ack_deadline_ts",
    exclusions: [],
    window: "15m",
    owner: "Broker team",
    alert_threshold: ">0.5%",
    aggregation: "ratio",
    comparison: "lte",
    target: 0.005,
    unit: "rate",
  },
  {
    name: "input_postcondition_success_rate",
    numerator: "state-changing calls with effect_verified=true",
    denominator: "state-changing calls that supplied a supported postcondition",
    start_ts: "browser_acked_at",
    end_ts: "verified_at",
    exclusions: ["known app-bug-tagged runs tracked separately"],
    window: "1h",
    owner: "Broker team",
    alert_threshold: "<98%",
    aggregation: "ratio",
    comparison: "gte",
    target: 0.98,
    unit: "rate",
  },
  {
    name: "duplicate_inference_reduction",
    numerator: "baseline direct-attach calls - broker calls",
    denominator: "baseline direct-attach 3-agent canary median inference calls per minute",
    start_ts: "canary_window_start",
    end_ts: "canary_window_end",
    exclusions: [],
    window: "daily canary comparison",
    owner: "Broker team",
    alert_threshold: "<60% reduction",
    aggregation: "ratio",
    comparison: "gte",
    target: 0.6,
    unit: "rate",
  },
  {
    name: "locate_cache_hit_latency_p95",
    numerator: "locate_response_ts - locate_request_ts for cache-hit locate responses",
    denominator: "total cache-hit locate responses",
    start_ts: "locate_request_ts",
    end_ts: "locate_response_ts",
    exclusions: ["cache-disabled experiments"],
    window: "5m",
    owner: "Broker team",
    alert_threshold: "p95 > 300ms",
    aggregation: "p95",
    comparison: "lte",
    target: 300,
    unit: "ms",
  },
  {
    name: "subscriber_frame_drop_rate",
    numerator: "dropped frames per subscriber in window",
    denominator: "frames offered to that subscriber in window",
    start_ts: "frame_offer_ts",
    end_ts: "frame_drop_accounted_ts",
    exclusions: ["subscribers explicitly marked paused"],
    window: "5m",
    owner: "Broker team",
    alert_threshold: ">5% for 5m",
    aggregation: "ratio",
    comparison: "lte",
    target: 0.05,
    unit: "rate",
  },
  {
    name: "broker_recovery_time_p95",
    numerator: "broker_ready_ts - recovery_start_ts per recovery incident",
    denominator: "recovery incidents in window",
    start_ts: "recovery_start_ts",
    end_ts: "broker_ready_ts",
    exclusions: ["planned maintenance windows with approved override"],
    window: "daily",
    owner: "Broker team",
    alert_threshold: "p95 > 30s",
    aggregation: "p95",
    comparison: "lte",
    target: 30_000,
    unit: "ms",
  },
] as const;

const WINDOW_MS: Record<BrokerSloMetricName, number> = {
  broker_fanout_latency_p95: 5 * MINUTE_MS,
  screenshot_age_p95: 5 * MINUTE_MS,
  input_ack_timeout_rate: 15 * MINUTE_MS,
  input_postcondition_success_rate: HOUR_MS,
  duplicate_inference_reduction: DAY_MS,
  locate_cache_hit_latency_p95: 5 * MINUTE_MS,
  subscriber_frame_drop_rate: 5 * MINUTE_MS,
  broker_recovery_time_p95: DAY_MS,
};

const DEFINITIONS_BY_NAME = new Map(BROKER_SLO_DEFINITIONS.map((definition) => [definition.name, definition]));

export class BrokerSloRecorder {
  private readonly samples = new Map<BrokerSloMetricName, BrokerSloSample[]>();

  record(sample: BrokerSloSample): void {
    if (!Number.isFinite(sample.value)) return;
    const bucket = this.samples.get(sample.name) ?? [];
    bucket.push({
      ...sample,
      denominator: sample.denominator === undefined ? undefined : Math.max(0, sample.denominator),
    });
    this.samples.set(sample.name, bucket);
    this.prune(sample.name, sample.ts);
  }

  recordDuration(name: BrokerSloMetricName, valueMs: number, ts: number = Date.now(), labels?: Record<string, string>): void {
    this.record({ name, value: Math.max(0, valueMs), ts, labels });
  }

  recordRatio(
    name: BrokerSloMetricName,
    numerator: number,
    denominator: number,
    ts: number = Date.now(),
    labels?: Record<string, string>
  ): void {
    this.record({
      name,
      value: Math.max(0, numerator),
      denominator: Math.max(0, denominator),
      ts,
      labels,
    });
  }

  evaluate(
    names: readonly BrokerSloMetricName[] = BROKER_SLO_DEFINITIONS.map((definition) => definition.name),
    now: number = Date.now()
  ): BrokerSloAcceptance {
    const gates = names.map((name) => this.evaluateOne(name, now));
    return {
      ok: gates.length > 0 && gates.every((gate) => gate.status === "pass"),
      evaluated_at: now,
      gates,
    };
  }

  snapshot(name?: BrokerSloMetricName): BrokerSloSample[] {
    if (name) return [...(this.samples.get(name) ?? [])];
    return [...this.samples.values()].flat().map((sample) => ({ ...sample, labels: sample.labels ? { ...sample.labels } : undefined }));
  }

  clear(): void {
    this.samples.clear();
  }

  private evaluateOne(name: BrokerSloMetricName, now: number): BrokerSloGate {
    const definition = DEFINITIONS_BY_NAME.get(name);
    if (!definition) {
      throw new Error(`unknown_broker_slo (${name})`);
    }
    this.prune(name, now);
    const windowMs = WINDOW_MS[name];
    const samples = (this.samples.get(name) ?? []).filter((sample) => !sample.excluded && sample.ts >= now - windowMs);
    const observed = definition.aggregation === "p95" ? percentile(samples.map((sample) => sample.value), 0.95) : ratio(samples);
    const status = observed === null
      ? "unknown"
      : definition.comparison === "lte"
        ? observed <= definition.target ? "pass" : "fail"
        : observed >= definition.target ? "pass" : "fail";
    return {
      name,
      status,
      observed,
      target: definition.target,
      comparison: definition.comparison,
      sample_count: samples.length,
      window_ms: windowMs,
    };
  }

  private prune(name: BrokerSloMetricName, now: number): void {
    const windowMs = WINDOW_MS[name] ?? DAY_MS;
    const keepAfter = now - Math.max(windowMs * 2, DAY_MS);
    const bucket = this.samples.get(name);
    if (!bucket) return;
    const kept = bucket.filter((sample) => sample.ts >= keepAfter);
    if (kept.length === 0) this.samples.delete(name);
    else this.samples.set(name, kept);
  }
}

function percentile(values: number[], quantile: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[idx] ?? null;
}

function ratio(samples: BrokerSloSample[]): number | null {
  if (samples.length === 0) return null;
  let numerator = 0;
  let denominator = 0;
  for (const sample of samples) {
    numerator += sample.value;
    denominator += sample.denominator ?? 1;
  }
  if (denominator <= 0) return null;
  return numerator / denominator;
}

export const brokerSloRecorder = new BrokerSloRecorder();

export function brokerSloDefinitions(): BrokerSloDefinition[] {
  return BROKER_SLO_DEFINITIONS.map((definition) => ({
    ...definition,
    exclusions: [...definition.exclusions],
  }));
}
