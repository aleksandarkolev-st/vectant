export const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION = "synthi.gpu.hmr.proof_ledger.v1";

const GPU_PROJECT_KINDS = new Set(["gpu_project", "mixed_project"]);
const GPU_ARTIFACT_EDIT_KINDS = new Set(["gpu_artifact_edit"]);
const METRIC_CLOCKS = new Set(["monotonic_ns"]);
const METRIC_SCOPES = new Set(["cold", "warm", "hot_delta_1", "hot_delta_2"]);
const CACHE_STATES = new Set(["clean", "compiler_cache_warm", "pipeline_cache_warm"]);
const REQUIRED_TIMING_FIELDS = [
  ["static_discovery_time", "staticDiscoveryTime"],
  ["ai_contract_synthesis_time", "aiContractSynthesisTime"],
  ["model_availability_check_time", "modelAvailabilityCheckTime"],
  ["artifact_hash_time", "artifactHashTime"],
  ["adapter_generation_time", "adapterGenerationTime"],
  ["device_compile_wall_time", "deviceCompileWallTime"],
  ["artifact_load_time", "artifactLoadTime"],
  ["epoch_publish_time", "epochPublishTime"],
  ["dispatch_trace_time", "dispatchTraceTime"],
  ["runtime_probe_time", "runtimeProbeTime"],
  ["oracle_analysis_time", "oracleAnalysisTime"],
  ["trigger_to_visible_time", "triggerToVisibleTime"],
  ["screenshot_capture_time", "screenshotCaptureTime"],
  ["dispatch_to_output_proof_time", "dispatchToOutputProofTime"],
  ["total_validator_wall_time", "totalValidatorWallTime"],
] as const;

export interface GpuHmrLedgerFailure {
  code: string;
  [key: string]: unknown;
}

export interface GpuHmrLedgerValidation {
  schemaVersion: string;
  proofId: string | null;
  gpuHmrSuccess: boolean;
  failedInvariants: GpuHmrLedgerFailure[];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}

function hasOwn(object: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function compactStringList(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(text)
    .filter((value): value is string => value !== null))];
}

function firstPresent(...entries: Array<[Record<string, unknown>, string]>): { present: boolean; value: unknown } {
  for (const [object, key] of entries) {
    if (hasOwn(object, key)) return { present: true, value: object[key] };
  }
  return { present: false, value: undefined };
}

function finiteNumber(value: unknown): number | null {
  if (value === undefined || value === null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
  const n = finiteNumber(value);
  return n !== null && n >= 0 ? n : null;
}

function eventId(event: Record<string, unknown>): string | null {
  return firstText(event.id, event.event_id, event.dispatch_id, event.proof_id, event.proofId);
}

function eventEpoch(event: Record<string, unknown>): string | null {
  return firstText(event.epoch, event.epoch_id, event.epochId, event.generation);
}

function eventArtifactHash(event: Record<string, unknown>): string | null {
  return firstText(
    event.artifact_hash,
    event.artifactHash,
    event.artifact_id,
    event.artifactId,
    event.loaded_artifact_hash,
    event.loadedArtifactHash,
    event.published_artifact_hash,
    event.publishedArtifactHash,
    event.runtime_artifact_id,
    event.runtimeArtifactId,
    event.selected_artifact_id,
    event.selectedArtifactId,
    event.new_artifact_hash,
    event.newArtifactHash,
    event.hash
  );
}

function eventProcessId(event: Record<string, unknown>): string | null {
  return firstText(event.process_id, event.processId, event.pid);
}

function eventTimestamp(event: Record<string, unknown>): number | null {
  return finiteNumber(
    event.timestamp_monotonic_ns
    ?? event.timestampMonotonicNs
    ?? event.timestamp_ms
    ?? event.timestampMs
    ?? event.ts
  );
}

function outputAfterDispatchId(outputEvent: Record<string, unknown>): string | null {
  return firstText(
    outputEvent.after_dispatch_id,
    outputEvent.afterDispatchId,
    outputEvent.dispatch_id,
    outputEvent.dispatchId
  );
}

function timingCandidates(timings: Record<string, unknown>, timingMetrics: Record<string, unknown>): Record<string, unknown>[] {
  const nested = asObject(timings.timing_metrics ?? timings.timingMetrics);
  return [
    timings,
    timingMetrics,
    nested,
    asObject(timings.normalized_timings),
    asObject(timings.normalizedTimings),
    asObject(timingMetrics.normalized_timings),
    asObject(timingMetrics.normalizedTimings),
    asObject(nested.normalized_timings),
    asObject(nested.normalizedTimings),
    asObject(timings.snake_case),
    asObject(asObject(timings.normalizedTimings).snake_case),
    asObject(asObject(timingMetrics.normalizedTimings).snake_case),
    asObject(asObject(nested.normalizedTimings).snake_case),
  ];
}

function timingValue(
  timings: Record<string, unknown>,
  timingMetrics: Record<string, unknown>,
  snakeKey: string,
  camelKey: string
): number | null {
  for (const candidate of timingCandidates(timings, timingMetrics)) {
    for (const key of [snakeKey, `${snakeKey}_ms`, camelKey, `${camelKey}Ms`]) {
      if (!hasOwn(candidate, key)) continue;
      const value = finiteNonNegativeNumber(candidate[key]);
      if (value !== null) return value;
    }
  }
  return null;
}

function modelEntries(modelProvenance: Record<string, unknown>): Array<[string, Record<string, unknown>]> {
  return Object.entries(modelProvenance)
    .filter(([, value]) => isObject(value)) as Array<[string, Record<string, unknown>]>;
}

function modelRequestMode(entry: [string, Record<string, unknown>]): string | null {
  const [key, record] = entry;
  return firstText(record.request_mode, record.requestMode, key);
}

function validateRecord(input: Record<string, unknown>): GpuHmrLedgerValidation {
  const failures: GpuHmrLedgerFailure[] = [];
  const classification = asObject(input.classification);
  const loaderEvent = asObject(input.loader_event ?? input.loaderEvent);
  const epochPublishEvent = asObject(input.epoch_publish_event ?? input.epochPublishEvent);
  const dispatchEvent = asObject(input.dispatch_event ?? input.dispatchEvent);
  const outputEvent = asObject(input.output_event ?? input.outputEvent);
  const retirementEvent = asObject(input.retirement_event ?? input.retirementEvent);
  const processIdentity = asObject(input.process_identity ?? input.processIdentity);
  const deviceIdentity = asObject(input.device_identity ?? input.deviceIdentity);
  const firewallEvidence = asObject(input.firewall_evidence ?? input.firewallEvidence);
  const timings = asObject(input.timings);
  const timingMetrics = asObject(input.timing_metrics ?? input.timingMetrics ?? timings.timing_metrics ?? timings.timingMetrics);
  const modelProvenance = asObject(input.model_provenance ?? input.modelProvenance);
  const projectId = firstText(input.project_id, input.projectId);
  const editId = firstText(input.edit_id, input.editId);
  const evidenceRefs = compactStringList(input.evidence_refs ?? input.evidenceRefs);
  const contractHash = firstText(input.contract_hash, input.contractHash);
  const artifactBeforeHash = firstText(input.artifact_before_hash, input.artifactBeforeHash);
  const artifactAfterHash = firstText(input.artifact_after_hash, input.artifactAfterHash, input.changed_gpu_artifact_hash, input.changedGpuArtifactHash);
  const loadedArtifactHash = eventArtifactHash(loaderEvent);
  const publishedArtifactHash = eventArtifactHash(epochPublishEvent);
  const publishedEpoch = eventEpoch(epochPublishEvent);
  const dispatchEpoch = eventEpoch(dispatchEvent);
  const dispatchId = eventId(dispatchEvent);
  const dispatchArtifactHash = eventArtifactHash(dispatchEvent);
  const outputDispatchId = outputAfterDispatchId(outputEvent);
  const outputArtifactHash = eventArtifactHash(outputEvent);
  const outputEpoch = eventEpoch(outputEvent);
  const dispatchTs = eventTimestamp(dispatchEvent);
  const outputTs = eventTimestamp(outputEvent);
  const identityPid = eventProcessId(processIdentity);
  const cpuHmrUsed = firstPresent(
    [input, "cpu_hmr_used"],
    [input, "cpuHmrUsed"],
    [firewallEvidence, "cpu_hmr_used"],
    [firewallEvidence, "cpuHmrUsed"]
  );
  const fullRebuildUsed = firstPresent(
    [input, "full_rebuild_used"],
    [input, "fullRebuildUsed"],
    [firewallEvidence, "full_rebuild_used"],
    [firewallEvidence, "fullRebuildUsed"]
  );
  const processRestarted = firstPresent(
    [input, "process_restarted"],
    [input, "processRestarted"],
    [firewallEvidence, "process_restarted"],
    [firewallEvidence, "processRestarted"]
  );
  const metricClock = firstText(input.metric_clock, input.metricClock, timings.metric_clock, timings.metricClock, timingMetrics.metric_clock, timingMetrics.metricClock);
  const metricScope = firstText(input.metric_scope, input.metricScope, timings.metric_scope, timings.metricScope, timingMetrics.metric_scope, timingMetrics.metricScope);
  const cacheState = firstText(input.cache_state, input.cacheState, timings.cache_state, timings.cacheState, timingMetrics.cache_state, timingMetrics.cacheState);

  if (!projectId) failures.push({ code: "project_id_missing" });
  if (!editId) failures.push({ code: "edit_id_missing" });
  if (evidenceRefs.length === 0) failures.push({ code: "evidence_refs_missing" });
  const projectKind = firstText(classification.project_kind, classification.projectKind);
  const editKind = firstText(classification.edit_kind, classification.editKind);
  const route = firstText(classification.route);
  if (!projectKind) failures.push({ code: "classification_project_kind_missing" });
  else if (!GPU_PROJECT_KINDS.has(projectKind)) failures.push({ code: "classification_project_kind_not_gpu_hmr", projectKind });
  if (!editKind) failures.push({ code: "classification_edit_kind_missing" });
  else if (!GPU_ARTIFACT_EDIT_KINDS.has(editKind)) failures.push({ code: "classification_edit_kind_not_gpu_artifact", editKind });
  if (route !== "gpu_hmr") failures.push({ code: route ? "classification_route_not_gpu_hmr" : "classification_route_missing", route });
  if (!cpuHmrUsed.present) failures.push({ code: "cpu_hmr_absence_evidence_missing" });
  if (!fullRebuildUsed.present) failures.push({ code: "full_rebuild_absence_evidence_missing" });
  if (!processRestarted.present) failures.push({ code: "process_restart_absence_evidence_missing" });
  if (cpuHmrUsed.value === true) failures.push({ code: "cpu_hmr_used" });
  if (fullRebuildUsed.value === true) failures.push({ code: "full_rebuild_used" });
  if (processRestarted.value === true) failures.push({ code: "process_restarted" });
  if (!contractHash) failures.push({ code: "contract_hash_missing" });
  if (!artifactBeforeHash) failures.push({ code: "artifact_before_hash_missing" });
  if (!artifactAfterHash) failures.push({ code: "artifact_after_hash_missing" });
  if (artifactBeforeHash && artifactAfterHash && artifactBeforeHash === artifactAfterHash) {
    failures.push({ code: "artifact_hash_unchanged" });
  }
  if (!loadedArtifactHash || (artifactAfterHash && loadedArtifactHash !== artifactAfterHash)) {
    failures.push({ code: loadedArtifactHash ? "loader_artifact_hash_mismatch" : "loader_artifact_hash_missing" });
  }
  if (!publishedArtifactHash || (artifactAfterHash && publishedArtifactHash !== artifactAfterHash)) {
    failures.push({ code: publishedArtifactHash ? "epoch_publish_artifact_hash_mismatch" : "epoch_publish_artifact_hash_missing" });
  }
  if (!publishedEpoch) failures.push({ code: "epoch_publish_id_missing" });
  if (!dispatchEpoch || (publishedEpoch && dispatchEpoch !== publishedEpoch)) {
    failures.push({ code: dispatchEpoch ? "dispatch_epoch_mismatch" : "dispatch_epoch_missing" });
  }
  if (!dispatchId) failures.push({ code: "dispatch_id_missing" });
  if (!dispatchArtifactHash || (artifactAfterHash && dispatchArtifactHash !== artifactAfterHash)) {
    failures.push({ code: dispatchArtifactHash ? "dispatch_artifact_hash_mismatch" : "dispatch_artifact_hash_missing" });
  }
  if (dispatchTs === null) failures.push({ code: "dispatch_timestamp_missing" });
  if (!outputDispatchId || (dispatchId && outputDispatchId !== dispatchId)) {
    failures.push({ code: outputDispatchId ? "output_after_dispatch_id_mismatch" : "output_after_dispatch_id_missing" });
  }
  if (outputEvent.passed !== true) failures.push({ code: "output_oracle_not_passed" });
  if (!outputArtifactHash || (artifactAfterHash && outputArtifactHash !== artifactAfterHash)) {
    failures.push({ code: outputArtifactHash ? "output_artifact_hash_mismatch" : "output_artifact_hash_missing" });
  }
  if (!outputEpoch || (publishedEpoch && outputEpoch !== publishedEpoch)) {
    failures.push({ code: outputEpoch ? "output_epoch_mismatch" : "output_epoch_missing" });
  }
  if (outputTs === null) failures.push({ code: "output_timestamp_missing" });
  if (dispatchTs !== null && outputTs !== null && outputTs < dispatchTs) failures.push({ code: "output_precedes_dispatch" });
  for (const [event, code] of [
    [loaderEvent, "loader_process_identity_missing"],
    [epochPublishEvent, "epoch_publish_process_identity_missing"],
    [dispatchEvent, "dispatch_process_identity_missing"],
    [outputEvent, "output_process_identity_missing"],
  ] as const) {
    const pid = eventProcessId(event);
    if (!pid) failures.push({ code });
    else if (identityPid && pid !== identityPid) failures.push({ code: code.replace("_missing", "_mismatch") });
  }
  if (!identityPid) failures.push({ code: "process_identity_missing" });
  if (Object.keys(deviceIdentity).length === 0) failures.push({ code: "device_identity_missing" });
  if (Object.keys(retirementEvent).length === 0) failures.push({ code: "retirement_event_missing" });
  else if (!firstText(retirementEvent.status, retirementEvent.proof, retirementEvent.retirement_proof, retirementEvent.retirementProof)) {
    failures.push({ code: "retirement_proof_missing" });
  }
  if (!metricClock) failures.push({ code: "metric_clock_missing" });
  else if (!METRIC_CLOCKS.has(metricClock)) failures.push({ code: "metric_clock_not_monotonic_ns" });
  if (!metricScope) failures.push({ code: "metric_scope_missing" });
  else if (!METRIC_SCOPES.has(metricScope)) failures.push({ code: "metric_scope_unsupported" });
  if (!cacheState) failures.push({ code: "cache_state_missing" });
  else if (!CACHE_STATES.has(cacheState)) failures.push({ code: "cache_state_unsupported" });
  if (Object.keys(timings).length === 0 && Object.keys(timingMetrics).length === 0) failures.push({ code: "timings_missing" });
  for (const [snakeKey, camelKey] of REQUIRED_TIMING_FIELDS) {
    if (timingValue(timings, timingMetrics, snakeKey, camelKey) === null) {
      failures.push({ code: `timing_${snakeKey}_missing` });
    }
  }
  const models = modelEntries(modelProvenance);
  if (models.length === 0) failures.push({ code: "model_provenance_missing" });
  if (!models.some((entry) => modelRequestMode(entry) === "split")) failures.push({ code: "model_provenance_split_missing" });
  if (!models.some((entry) => modelRequestMode(entry) === "gpu_delta")) failures.push({ code: "model_provenance_gpu_delta_missing" });

  return {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: firstText(input.proof_id, input.proofId),
    gpuHmrSuccess: failures.length === 0,
    failedInvariants: failures,
  };
}

export function queryGpuHmrLedgerInvariants(input: unknown): GpuHmrLedgerValidation {
  const ledger = asObject(input);
  const records = Array.isArray(ledger.records) ? ledger.records.filter(isObject) : [];
  const recomputed = validateRecord(records.length > 0 ? records[records.length - 1]! : ledger);
  const failures = [...recomputed.failedInvariants];
  const topLevelProofId = firstText(ledger.proofId, ledger.proof_id);
  if (topLevelProofId && topLevelProofId !== recomputed.proofId) {
    failures.push({ code: "ledger_proof_id_mismatch", suppliedProofId: topLevelProofId, recomputedProofId: recomputed.proofId });
  }
  const successFlag = firstPresent([ledger, "gpuHmrSuccess"], [ledger, "gpu_hmr_success"]);
  if (successFlag.present && successFlag.value !== recomputed.gpuHmrSuccess) {
    failures.push({ code: "ledger_success_flag_mismatch" });
  }
  const suppliedQuery = asObject(ledger.query);
  if (Object.keys(suppliedQuery).length > 0) {
    if (firstText(suppliedQuery.schemaVersion, suppliedQuery.schema_version) !== GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION) {
      failures.push({ code: "supplied_ledger_query_schema_mismatch" });
    } else {
      const suppliedFailures = compactStringList(
        Array.isArray(suppliedQuery.failedInvariants)
          ? suppliedQuery.failedInvariants.map((failure) => isObject(failure) ? failure.code : null)
          : []
      ).sort();
      const recomputedFailures = recomputed.failedInvariants.map((failure) => failure.code).sort();
      if (
        suppliedQuery.gpuHmrSuccess !== recomputed.gpuHmrSuccess
        || firstText(suppliedQuery.proofId, suppliedQuery.proof_id) !== recomputed.proofId
        || suppliedFailures.join("|") !== recomputedFailures.join("|")
      ) {
        failures.push({ code: "supplied_ledger_query_mismatch" });
      }
    }
  }
  return {
    ...recomputed,
    gpuHmrSuccess: failures.length === 0,
    failedInvariants: failures,
  };
}

export function embeddedGpuHmrProofLedger(raw: Record<string, unknown>): Record<string, unknown> | null {
  const direct = raw.proofLedger ?? raw.proof_ledger;
  if (isObject(direct)) return direct;
  for (const key of ["data", "detail", "proofMaterial", "proof_material"]) {
    const nested = asObject(raw[key]);
    const ledger = nested.proofLedger ?? nested.proof_ledger;
    if (isObject(ledger)) return ledger;
  }
  return null;
}
