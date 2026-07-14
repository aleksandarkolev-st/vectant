import { createHash } from "node:crypto";
import {
  gpuHmrFullRuntimeProofMaterials,
  validateGpuHmrProofState,
  type GpuHmrProofTelemetry,
} from "./gpu_proof.js";
import { queryGpuHmrLedgerInvariants } from "./gpu_proof_ledger.js";

export const GPU_HMR_FRAME_GATE_RUNTIME_BINDING_SCHEMA_VERSION =
  "synthi.gpu_hmr.frame_gate_runtime_binding.v1";
export const GPU_HMR_FRAME_GATE_RUNTIME_BINDING_AUTHORITY =
  "validated_runtime_tuple_for_visual_capture_gate_only_not_gpu_hmr_success";

export interface GpuHmrFrameGateBindingFailure {
  code: string;
  [key: string]: unknown;
}

export interface GpuHmrFrameGateBindingResult {
  accepted: boolean;
  binding: Readonly<Record<string, unknown>> | null;
  failures: GpuHmrFrameGateBindingFailure[];
}

export interface BuildGpuHmrFrameGateBindingInput {
  proof: GpuHmrProofTelemetry | null;
  hmrObservedAtMs: number;
  proofMatchScope?: Readonly<Record<string, unknown>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate = text(value);
    if (candidate !== null) return candidate;
  }
  return null;
}

function identifier(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

function firstIdentifier(...values: unknown[]): string | null {
  for (const value of values) {
    const candidate = identifier(value);
    if (candidate !== null) return candidate;
  }
  return null;
}

function finiteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => stableJson(entry)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

function sha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function canonicalSha256(value: unknown): string | null {
  const candidate = firstText(value)?.replace(/^artifact:/i, "") ?? null;
  const digest = candidate?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
  return digest === null ? null : `sha256:${digest}`;
}

function eventId(event: Record<string, unknown>): string | null {
  return firstText(
    event["id"],
    event["event_id"],
    event["dispatch_id"],
    event["proof_id"],
    event["proofId"],
  );
}

function eventEpoch(event: Record<string, unknown>): string | null {
  return firstText(event["epoch"], event["epoch_id"], event["epochId"], event["generation"]);
}

function eventArtifactHash(event: Record<string, unknown>): string | null {
  return canonicalSha256(firstText(
    event["artifact_hash"],
    event["artifactHash"],
    event["artifact_id"],
    event["artifactId"],
    event["loaded_artifact_hash"],
    event["loadedArtifactHash"],
    event["published_artifact_hash"],
    event["publishedArtifactHash"],
    event["runtime_artifact_id"],
    event["runtimeArtifactId"],
  ));
}

function eventProcessId(event: Record<string, unknown>): string | null {
  return firstIdentifier(event["process_id"], event["processId"], event["pid"]);
}

function eventRuntimeSession(event: Record<string, unknown>): string | null {
  return firstText(
    event["runtime_session_id"],
    event["runtimeSessionId"],
    event["runtime_session"],
    event["runtimeSession"],
  );
}

function eventDeviceId(event: Record<string, unknown>): string | null {
  return firstIdentifier(
    event["device_uuid"],
    event["deviceUuid"],
    event["device_id"],
    event["deviceId"],
  );
}

function eventTimestampBinding(
  event: Record<string, unknown>,
  metricClock: string | null,
): { clock: string; value: number } | null {
  const monotonicNs = finiteNumber(
    event["timestamp_monotonic_ns"] ?? event["timestampMonotonicNs"],
  );
  if (monotonicNs !== null) return { clock: "monotonic_ns", value: monotonicNs };
  const timestampMs = finiteNumber(event["timestamp_ms"] ?? event["timestampMs"]);
  if (timestampMs !== null) return { clock: "unix_epoch_ms", value: timestampMs };
  const generic = finiteNumber(event["ts"]);
  return generic === null || metricClock === null
    ? null
    : { clock: metricClock, value: generic };
}

function outputAfterDispatchId(outputEvent: Record<string, unknown>): string | null {
  return firstText(
    outputEvent["after_dispatch_id"],
    outputEvent["afterDispatchId"],
    outputEvent["dispatch_id"],
    outputEvent["dispatchId"],
  );
}

function outputTarget(record: Record<string, unknown>): unknown {
  const outputEvent = asObject(record["output_event"] ?? record["outputEvent"]);
  const outputOracle = asObject(outputEvent["output_oracle"] ?? outputEvent["outputOracle"]);
  return outputEvent["output_target"]
    ?? outputEvent["outputTarget"]
    ?? outputEvent["output_oracle_target"]
    ?? outputEvent["outputOracleTarget"]
    ?? record["output_oracle_target"]
    ?? record["outputOracleTarget"]
    ?? outputOracle["output_oracle_target"]
    ?? outputOracle["outputOracleTarget"]
    ?? null;
}

function outputTargetId(record: Record<string, unknown>): string | null {
  const outputEvent = asObject(record["output_event"] ?? record["outputEvent"]);
  const target = outputTarget(record);
  const targetObject = asObject(target);
  return firstText(
    typeof target === "string" ? target : null,
    record["output_target_id"],
    record["outputTargetId"],
    outputEvent["output_target_id"],
    outputEvent["outputTargetId"],
    outputEvent["target_id"],
    outputEvent["targetId"],
    targetObject["id"],
    targetObject["target_id"],
    targetObject["targetId"],
  );
}

function uniqueNonNull(values: Array<string | null>): string[] {
  return [...new Set(values.filter((value): value is string => value !== null))];
}

function latestLedgerRecord(ledger: Record<string, unknown>): Record<string, unknown> | null {
  const records = Array.isArray(ledger["records"]) ? ledger["records"] : null;
  if (records === null) return ledger;
  for (let index = records.length - 1; index >= 0; index -= 1) {
    if (isObject(records[index])) return records[index];
  }
  return null;
}

function proofScopeProjection(scope: Readonly<Record<string, unknown>> | undefined): Record<string, unknown> {
  const source = asObject(scope);
  return {
    module: firstText(source["module"]),
    preview_id: firstText(source["preview_id"], source["previewId"]),
    proof_since_ts_ms: finiteNumber(source["proof_since_ts_ms"] ?? source["proofSinceTsMs"]),
  };
}

function deepFreeze<T>(value: T): Readonly<T> {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
  }
  return value;
}

export function buildGpuHmrFrameGateEvidenceBinding(
  input: BuildGpuHmrFrameGateBindingInput,
): GpuHmrFrameGateBindingResult {
  const failures: GpuHmrFrameGateBindingFailure[] = [];
  const proof = input.proof;
  if (proof === null) {
    return { accepted: false, binding: null, failures: [{ code: "gpu_proof_missing" }] };
  }
  const validation = validateGpuHmrProofState(proof, "gpu-hmr-full-runtime-proven");
  if (
    validation.requiredState !== "gpu-hmr-full-runtime-proven"
    || proof.resultState !== "gpu-hmr-full-runtime-proven"
    || validation.satisfied !== true
  ) {
    failures.push({ code: "full_runtime_proof_not_accepted" });
  }
  if (validation.proofLedgerValidation?.gpuHmrSuccess !== true) {
    failures.push({ code: "proof_ledger_not_accepted" });
  }
  if (validation.runtimeProofArtifactValidation?.accepted !== true) {
    failures.push({ code: "runtime_proof_artifact_not_accepted" });
  }

  const materials = gpuHmrFullRuntimeProofMaterials(proof);
  const ledger = asObject(materials.proofLedger);
  const runtimeProofArtifact = asObject(materials.runtimeProofArtifact);
  const runtimeArtifactLedger = asObject(
    runtimeProofArtifact["proofLedger"] ?? runtimeProofArtifact["proof_ledger"],
  );
  const record = latestLedgerRecord(ledger);
  if (Object.keys(ledger).length === 0) failures.push({ code: "proof_ledger_missing" });
  if (Object.keys(runtimeProofArtifact).length === 0) {
    failures.push({ code: "runtime_proof_artifact_missing" });
  }
  if (Object.keys(runtimeArtifactLedger).length === 0) {
    failures.push({ code: "runtime_artifact_proof_ledger_missing" });
  }
  if (record === null) failures.push({ code: "proof_ledger_record_missing" });
  if (record === null) return { accepted: false, binding: null, failures };

  const loaderEvent = asObject(record["loader_event"] ?? record["loaderEvent"]);
  const epochPublishEvent = asObject(
    record["epoch_publish_event"] ?? record["epochPublishEvent"],
  );
  const dispatchEvent = asObject(record["dispatch_event"] ?? record["dispatchEvent"]);
  const outputEvent = asObject(record["output_event"] ?? record["outputEvent"]);
  const processIdentity = asObject(record["process_identity"] ?? record["processIdentity"]);
  const deviceIdentity = asObject(record["device_identity"] ?? record["deviceIdentity"]);
  const timings = asObject(record["timings"]);
  const metricClock = firstText(
    record["metric_clock"],
    record["metricClock"],
    timings["metric_clock"],
    timings["metricClock"],
  );
  const processIdentityLocations = {
    process_identity: eventProcessId(processIdentity),
    loader_event: eventProcessId(loaderEvent),
    epoch_publish_event: eventProcessId(epochPublishEvent),
    dispatch_event: eventProcessId(dispatchEvent),
    output_event: eventProcessId(outputEvent),
  };
  const runtimeSessionLocations = {
    record: firstText(record["runtime_session_id"], record["runtimeSessionId"]),
    process_identity: eventRuntimeSession(processIdentity),
    loader_event: eventRuntimeSession(loaderEvent),
    epoch_publish_event: eventRuntimeSession(epochPublishEvent),
    dispatch_event: eventRuntimeSession(dispatchEvent),
    output_event: eventRuntimeSession(outputEvent),
  };
  const processIds = uniqueNonNull(Object.values(processIdentityLocations));
  const runtimeSessions = uniqueNonNull(Object.values(runtimeSessionLocations));
  const missingProcessIdentityLocations = Object.entries(processIdentityLocations)
    .filter(([, value]) => value === null)
    .map(([location]) => location);
  const missingRuntimeSessionLocations = Object.entries(runtimeSessionLocations)
    .filter(([, value]) => value === null)
    .map(([location]) => location);
  if (missingProcessIdentityLocations.length > 0) {
    failures.push({
      code: "runtime_process_identity_material_incomplete",
      missingLocations: missingProcessIdentityLocations,
    });
  }
  if (missingRuntimeSessionLocations.length > 0) {
    failures.push({
      code: "runtime_session_identity_material_incomplete",
      missingLocations: missingRuntimeSessionLocations,
    });
  }
  if (processIds.length !== 1) {
    failures.push({ code: "runtime_process_identity_not_unique", processIds });
  }
  if (runtimeSessions.length !== 1) {
    failures.push({ code: "runtime_session_identity_not_unique", runtimeSessions });
  }

  const runtimeProofId = firstText(
    runtimeProofArtifact["proofId"],
    runtimeProofArtifact["proof_id"],
    proof.proofId,
  );
  const proofLedgerId = firstText(validation.proofLedgerValidation?.proofId);
  const runtimeArtifactLedgerValidation = Object.keys(runtimeArtifactLedger).length > 0
    ? queryGpuHmrLedgerInvariants(runtimeArtifactLedger)
    : null;
  if (runtimeArtifactLedgerValidation?.gpuHmrSuccess !== true) {
    failures.push({ code: "runtime_artifact_proof_ledger_not_accepted" });
  }
  if (
    proofLedgerId !== null
    && runtimeArtifactLedgerValidation?.proofId !== proofLedgerId
  ) {
    failures.push({
      code: "runtime_artifact_proof_ledger_binding_mismatch",
      telemetryProofLedgerId: proofLedgerId,
      runtimeArtifactProofLedgerId: runtimeArtifactLedgerValidation?.proofId ?? null,
    });
  }
  const artifactAfterHash = canonicalSha256(
    record["artifact_after_hash"] ?? record["artifactAfterHash"],
  );
  const epochPublishEventId = eventId(epochPublishEvent);
  const publishedEpoch = eventEpoch(epochPublishEvent);
  const dispatchId = eventId(dispatchEvent);
  const dispatchEpoch = eventEpoch(dispatchEvent);
  const dispatchArtifactHash = eventArtifactHash(dispatchEvent);
  const dispatchTimestamp = eventTimestampBinding(dispatchEvent, metricClock);
  const outputEventId = eventId(outputEvent);
  const outputDispatchId = outputAfterDispatchId(outputEvent);
  const outputEpoch = eventEpoch(outputEvent);
  const outputArtifactHash = eventArtifactHash(outputEvent);
  const target = outputTarget(record);
  const targetId = outputTargetId(record);
  const outputTimestamp = eventTimestampBinding(outputEvent, metricClock);
  const deviceIds = uniqueNonNull([
    eventDeviceId(deviceIdentity),
    eventDeviceId(loaderEvent),
    eventDeviceId(epochPublishEvent),
    eventDeviceId(dispatchEvent),
    eventDeviceId(outputEvent),
  ]);
  if (deviceIds.length !== 1) {
    failures.push({ code: "runtime_device_identity_not_unique", deviceIds });
  }
  const deviceId = deviceIds[0] ?? null;
  const proofObservedAtMs = finiteNumber(proof.observedAt);
  const hmrObservedAtMs = finiteNumber(input.hmrObservedAtMs);

  const requiredValues: Array<[string, unknown]> = [
    ["runtime_proof_id", runtimeProofId],
    ["proof_ledger_id", proofLedgerId],
    ["artifact_after_hash", artifactAfterHash],
    ["epoch_publish_event_id", epochPublishEventId],
    ["published_epoch", publishedEpoch],
    ["dispatch_id", dispatchId],
    ["dispatch_epoch", dispatchEpoch],
    ["dispatch_artifact_hash", dispatchArtifactHash],
    ["dispatch_timestamp", dispatchTimestamp],
    ["output_event_id", outputEventId],
    ["output_after_dispatch_id", outputDispatchId],
    ["output_epoch", outputEpoch],
    ["output_artifact_hash", outputArtifactHash],
    ["output_target_id", targetId],
    ["output_timestamp", outputTimestamp],
    ["process_id", processIds[0]],
    ["runtime_session_id", runtimeSessions[0]],
    ["device_id", deviceId],
    ["metric_clock", metricClock],
    ["runtime_proof_observed_at_ms", proofObservedAtMs],
    ["hmr_observed_at_ms", hmrObservedAtMs],
  ];
  const missingFields = requiredValues
    .filter(([, value]) => value === null || value === undefined || value === "")
    .map(([field]) => field);
  if (missingFields.length > 0) {
    failures.push({ code: "runtime_binding_material_incomplete", missingFields });
  }
  if (
    artifactAfterHash !== eventArtifactHash(loaderEvent)
    || artifactAfterHash !== eventArtifactHash(epochPublishEvent)
    || artifactAfterHash !== dispatchArtifactHash
    || artifactAfterHash !== outputArtifactHash
  ) {
    failures.push({ code: "runtime_binding_artifact_chain_mismatch" });
  }
  if (publishedEpoch !== dispatchEpoch || publishedEpoch !== outputEpoch) {
    failures.push({ code: "runtime_binding_epoch_chain_mismatch" });
  }
  if (dispatchId !== outputDispatchId) {
    failures.push({ code: "runtime_binding_dispatch_output_mismatch" });
  }
  if (
    metricClock !== "monotonic_ns"
    || dispatchTimestamp?.clock !== "monotonic_ns"
    || outputTimestamp?.clock !== "monotonic_ns"
    || dispatchTimestamp.value < 0
    || outputTimestamp.value < 0
    || dispatchTimestamp.value > outputTimestamp.value
  ) {
    failures.push({ code: "runtime_binding_clock_domain_invalid" });
  }
  if (
    proofObservedAtMs === null
    || hmrObservedAtMs === null
    || proofObservedAtMs < 0
    || hmrObservedAtMs < 0
    || proofObservedAtMs < hmrObservedAtMs
  ) {
    failures.push({ code: "runtime_binding_proof_observation_order_invalid" });
  }
  if (
    runtimeProofArtifact["fullRuntimeProven"] !== true
    && runtimeProofArtifact["full_runtime_proven"] !== true
  ) {
    failures.push({ code: "runtime_proof_artifact_full_runtime_missing" });
  }
  if (
    runtimeProofArtifact["gpuHmrSuccess"] !== true
    && runtimeProofArtifact["gpu_hmr_success"] !== true
  ) {
    failures.push({ code: "runtime_proof_artifact_success_missing" });
  }
  if (failures.length > 0) return { accepted: false, binding: null, failures };

  const binding = deepFreeze({
    schema_version: GPU_HMR_FRAME_GATE_RUNTIME_BINDING_SCHEMA_VERSION,
    proof_authority: GPU_HMR_FRAME_GATE_RUNTIME_BINDING_AUTHORITY,
    runtime_proof_id: runtimeProofId,
    proof_ledger_id: proofLedgerId,
    runtime_proof_state: proof.resultState,
    runtime_proof_accepted: true,
    runtime_proof_observed_at_ms: proofObservedAtMs,
    hmr_observed_at_ms: hmrObservedAtMs,
    artifact_after_hash: artifactAfterHash,
    epoch_publish_event_id: epochPublishEventId,
    published_epoch: publishedEpoch,
    dispatch_id: dispatchId,
    dispatch_epoch: dispatchEpoch,
    dispatch_artifact_hash: dispatchArtifactHash,
    dispatch_timestamp: dispatchTimestamp,
    output_event_id: outputEventId,
    output_after_dispatch_id: outputDispatchId,
    output_epoch: outputEpoch,
    output_artifact_hash: outputArtifactHash,
    output_target_id: targetId,
    output_target_hash: sha256(target),
    output_timestamp: outputTimestamp,
    process_id: processIds[0],
    process_identity_hash: sha256(processIdentity),
    runtime_session_id: runtimeSessions[0],
    device_id: deviceId,
    metric_clock: metricClock,
    proof_match_scope: proofScopeProjection(input.proofMatchScope),
    accepted_for_gpu_hmr: false,
    gpu_hmr_success: false,
    can_satisfy_runtime_proof: false,
    can_satisfy_dispatch_proof: false,
  });
  return { accepted: true, binding, failures: [] };
}
