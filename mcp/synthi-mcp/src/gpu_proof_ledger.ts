export const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION = "synthi.gpu.hmr.proof_ledger.v1";

const GPU_PROJECT_KINDS = new Set(["gpu_project", "mixed_project"]);
const GPU_ARTIFACT_EDIT_KINDS = new Set(["gpu_artifact_edit"]);
const METRIC_CLOCKS = new Set(["monotonic_ns"]);
const METRIC_SCOPES = new Set(["cold", "warm", "hot_delta_1", "hot_delta_2"]);
const CACHE_STATES = new Set(["clean", "compiler_cache_warm", "pipeline_cache_warm"]);
const MODEL_PROVIDER_STATUSES = new Set(["available", "deprecated", "private_alias"]);
const CONVERGENCE_METRICS = new Set([
  "per_frame_delta",
  "window_mean_delta",
  "stable_histogram_delta",
  "oracle_region_delta",
]);
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
const COMPUTE_ORACLE_ARTIFACT_FIELDS = [
  ["raw_readback_bin", "rawReadbackBin"],
  ["readback_schema_json", "readbackSchemaJson"],
  ["checksum_before", "checksumBefore"],
  ["checksum_after", "checksumAfter"],
  ["deterministic_slice", "deterministicSlice"],
  ["oracle_code_hash", "oracleCodeHash"],
  ["rendered_card_png", "renderedCardPng"],
  ["producer", "producer"],
  ["timestamp_after_dispatch", "timestampAfterDispatch"],
  ["epoch", "epoch"],
] as const;
const VISUAL_ORACLE_ARTIFACT_FIELDS = [
  ["before_image", "beforeImage"],
  ["after_image", "afterImage"],
  ["diff_image", "diffImage"],
  ["blank_frame_rejection", "blankFrameRejection"],
  ["same_frame_rejection", "sameFrameRejection"],
  ["new_epoch_watermark_or_trace", "newEpochWatermarkOrTrace", "epoch_trace", "epochTrace"],
  ["camera_state_hash", "cameraStateHash"],
  ["swapchain_size", "swapchainSize"],
  ["capture_backend", "captureBackend"],
  ["frame_number", "frameNumber"],
  ["timestamp_after_dispatch", "timestampAfterDispatch"],
  ["perceptual_diff", "perceptualDiff"],
  ["changed_pixel_ratio", "changedPixelRatio"],
  ["visible_pixel_count", "visiblePixelCount"],
] as const;
const REQUIRED_MODEL_FIELDS = [
  ["provider", "provider", "provider_missing"],
  ["requested_model", "requestedModel", "requested_model_missing"],
  ["provider_model_status", "providerModelStatus", "provider_model_status_missing"],
  ["provider_model_alias_resolved_to", "providerModelAliasResolvedTo", "provider_model_alias_resolved_to_missing"],
  [
    "provider_shutdown_or_deprecation_detected",
    "providerShutdownOrDeprecationDetected",
    "provider_shutdown_or_deprecation_detected_missing",
  ],
  ["model_availability_checked_at", "modelAvailabilityCheckedAt", "model_availability_checked_at_missing"],
  ["actual_model", "actualModel", "actual_model_missing"],
  ["fallback_model", "fallbackModel", "fallback_model_missing"],
  ["fallback_used", "fallbackUsed", "fallback_used_missing"],
  ["request_mode", "requestMode", "request_mode_missing"],
  ["hard_infra_failure", "hardInfraFailure", "hard_infra_failure_missing"],
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

function hasOwnDeep(object: unknown, key: string): boolean {
  return isObject(object) && hasOwn(object, key);
}

function valueRecorded(object: Record<string, unknown>, key: string): boolean {
  if (!hasOwn(object, key)) return false;
  const value = object[key];
  if (value === null) return true;
  if (typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value === "string") return value.trim().length > 0;
  if (Array.isArray(value)) return value.length > 0;
  if (isObject(value)) return Object.keys(value).length > 0;
  return false;
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

function outputKind(outputEvent: Record<string, unknown>): string {
  return String(firstText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind) ?? "")
    .trim()
    .toLowerCase();
}

function isVisualOutput(outputEvent: Record<string, unknown>): boolean {
  const kind = outputKind(outputEvent);
  return kind.includes("visual")
    || kind.includes("render")
    || kind.includes("frame")
    || kind.includes("pixel")
    || hasOwnDeep(asObject(outputEvent.visual_oracle_artifacts ?? outputEvent.visualOracleArtifacts), "after_image")
    || hasOwnDeep(asObject(outputEvent.visual_oracle_artifacts ?? outputEvent.visualOracleArtifacts), "afterImage");
}

function outputOracleObject(outputEvent: Record<string, unknown>): Record<string, unknown> {
  return asObject(outputEvent.output_oracle ?? outputEvent.outputOracle);
}

function artifactFieldRecorded(object: Record<string, unknown>, keys: readonly string[]): boolean {
  return keys.some((key) => valueRecorded(object, key));
}

function artifactHasAnyField(
  object: Record<string, unknown>,
  fields: ReadonlyArray<readonly string[]>
): boolean {
  return fields.some((keys) => artifactFieldRecorded(object, keys));
}

function firstArtifactObject(
  candidates: unknown[],
  fields: ReadonlyArray<readonly string[]>
): Record<string, unknown> | null {
  for (const candidate of candidates) {
    const object = asObject(candidate);
    if (Object.keys(object).length > 0 && artifactHasAnyField(object, fields)) {
      return object;
    }
  }
  return null;
}

function oracleArtifactSources(
  recordOracleArtifacts: Record<string, unknown>,
  outputEvent: Record<string, unknown>
): {
  ledgerArtifacts: Record<string, unknown>;
  outputArtifacts: Record<string, unknown>;
  outputOracle: Record<string, unknown>;
  outputOracleArtifacts: Record<string, unknown>;
} {
  const outputArtifacts = asObject(outputEvent.oracle_artifacts ?? outputEvent.oracleArtifacts);
  const outputOracle = outputOracleObject(outputEvent);
  const outputOracleArtifacts = asObject(outputOracle.oracle_artifacts ?? outputOracle.oracleArtifacts);
  return {
    ledgerArtifacts: recordOracleArtifacts,
    outputArtifacts,
    outputOracle,
    outputOracleArtifacts,
  };
}

function computeOracleArtifacts(
  recordOracleArtifacts: Record<string, unknown>,
  outputEvent: Record<string, unknown>
): Record<string, unknown> | null {
  const { ledgerArtifacts, outputArtifacts, outputOracle, outputOracleArtifacts } =
    oracleArtifactSources(recordOracleArtifacts, outputEvent);
  return firstArtifactObject([
    ledgerArtifacts.compute_oracle_artifacts,
    ledgerArtifacts.computeOracleArtifacts,
    outputArtifacts.compute_oracle_artifacts,
    outputArtifacts.computeOracleArtifacts,
    outputEvent.compute_oracle_artifacts,
    outputEvent.computeOracleArtifacts,
    outputOracle.compute_oracle_artifacts,
    outputOracle.computeOracleArtifacts,
    outputOracleArtifacts.compute_oracle_artifacts,
    outputOracleArtifacts.computeOracleArtifacts,
    ledgerArtifacts,
    outputArtifacts,
    outputOracleArtifacts,
    outputOracle,
  ], COMPUTE_ORACLE_ARTIFACT_FIELDS);
}

function visualOracleArtifacts(
  recordOracleArtifacts: Record<string, unknown>,
  outputEvent: Record<string, unknown>
): Record<string, unknown> | null {
  const { ledgerArtifacts, outputArtifacts, outputOracle, outputOracleArtifacts } =
    oracleArtifactSources(recordOracleArtifacts, outputEvent);
  return firstArtifactObject([
    ledgerArtifacts.visual_oracle_artifacts,
    ledgerArtifacts.visualOracleArtifacts,
    outputArtifacts.visual_oracle_artifacts,
    outputArtifacts.visualOracleArtifacts,
    outputEvent.visual_oracle_artifacts,
    outputEvent.visualOracleArtifacts,
    outputOracle.visual_oracle_artifacts,
    outputOracle.visualOracleArtifacts,
    outputOracleArtifacts.visual_oracle_artifacts,
    outputOracleArtifacts.visualOracleArtifacts,
    ledgerArtifacts,
    outputArtifacts,
    outputOracleArtifacts,
    outputOracle,
  ], VISUAL_ORACLE_ARTIFACT_FIELDS);
}

function missingArtifactFields(
  artifact: Record<string, unknown>,
  fields: ReadonlyArray<readonly string[]>
): string[] {
  return fields
    .filter((keys) => !artifactFieldRecorded(artifact, keys))
    .map((keys) => keys[0] ?? "unknown");
}

function objectFieldValue(object: Record<string, unknown>, keys: readonly string[]): unknown {
  for (const key of keys) {
    if (hasOwn(object, key)) return object[key];
  }
  return undefined;
}

function artifactText(artifact: Record<string, unknown>, ...keys: string[]): string | null {
  return firstText(...keys.map((key) => artifact[key]));
}

function artifactNumber(artifact: Record<string, unknown>, ...keys: string[]): number | null {
  for (const key of keys) {
    const value = finiteNumber(artifact[key]);
    if (value !== null) return value;
  }
  return null;
}

function artifactArray(artifact: Record<string, unknown>, ...keys: string[]): unknown[] {
  for (const key of keys) {
    const value = artifact[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

function visualTraceCorrelates(trace: unknown, identifiers: unknown[]): boolean {
  const normalizedTrace = text(trace);
  if (!normalizedTrace) return false;
  for (const identifier of compactStringList(identifiers)) {
    if (normalizedTrace === identifier) return true;
    if (identifier.length >= 6 && normalizedTrace.includes(identifier)) return true;
  }
  return false;
}

function boolField(object: Record<string, unknown>, ...keys: string[]): boolean | null {
  for (const key of keys) {
    if (typeof object[key] === "boolean") return object[key] as boolean;
  }
  return null;
}

function deterministicVisualFailures(modeInput: unknown): GpuHmrLedgerFailure[] {
  const mode = asObject(modeInput);
  const failures: GpuHmrLedgerFailure[] = [];
  const fixedSeed =
    mode.fixed_seed === true
    || mode.seed_policy_fixed === true
    || Boolean(text(mode.seed_policy_hash));
  if (!fixedSeed) failures.push({ code: "seed_policy_unproven" });
  if (mode.frozen_camera !== true && mode.camera_frozen !== true) {
    failures.push({ code: "frozen_camera_unproven" });
  }
  if (mode.fixed_resolution !== true) failures.push({ code: "fixed_resolution_unproven" });
  if (mode.frame_capture_after_epoch_dispatch !== true && mode.frameCaptureAfterEpochDispatch !== true) {
    failures.push({ code: "frame_capture_after_epoch_dispatch_unproven" });
  }
  if (
    mode.presentation_fence_or_frame_boundary !== true
    && mode.presentationFenceOrFrameBoundary !== true
    && mode.presentation_boundary_proven !== true
    && mode.presentationBoundaryProven !== true
  ) {
    failures.push({ code: "presentation_boundary_unproven" });
  }
  if (mode.fixed_swapchain_image_count !== true && mode.fixedSwapchainImageCount !== true) {
    failures.push({ code: "fixed_swapchain_image_count_unproven" });
  }
  const temporalDisabled =
    mode.temporal_accumulation_disabled === true
    || mode.temporalAccumulationDisabled === true
    || mode.temporal_accumulation_present === false
    || mode.temporalAccumulationPresent === false
    || mode.temporal_accumulation_not_applicable === true
    || mode.temporalAccumulationNotApplicable === true;
  const taaSatisfied =
    mode.taa_disabled === true
    || mode.taaDisabled === true
    || mode.taa_present === false
    || mode.taaPresent === false
    || mode.taa_not_applicable === true
    || mode.taaNotApplicable === true;
  const denoiserSatisfied =
    mode.denoiser_disabled === true
    || mode.denoiserDisabled === true
    || mode.denoiser_present === false
    || mode.denoiserPresent === false
    || mode.denoiser_not_applicable === true
    || mode.denoiserNotApplicable === true;
  if (!taaSatisfied) failures.push({ code: "taa_control_unproven" });
  if (!denoiserSatisfied) failures.push({ code: "denoiser_control_unproven" });
  if (!temporalDisabled) {
    const window = asObject(mode.convergence_window ?? mode.convergenceWindow);
    const metric = text(asObject(window.metric).value ?? window.metric);
    const frameStart = finiteNumber(window.frame_start ?? window.frameStart);
    const frameEnd = finiteNumber(window.frame_end ?? window.frameEnd);
    const samples = Array.isArray(window.samples) ? window.samples : [];
    const frameHashes = compactStringList(window.frame_hashes ?? window.frameHashes);
    const postEpochFrameHashes = compactStringList(
      window.post_epoch_frame_hashes ?? window.postEpochFrameHashes
    );
    const sampleCount = finiteNumber(window.sample_count ?? window.sampleCount)
      ?? (samples.length > 0 ? samples.length : null)
      ?? (frameHashes.length > 0 ? frameHashes.length : null)
      ?? (postEpochFrameHashes.length > 0 ? postEpochFrameHashes.length : null);
    const hasMetricEvidence =
      finiteNumber(window.metric_value ?? window.metricValue) !== null
      || finiteNumber(
        window.metric_delta
        ?? window.metricDelta
        ?? window.observed_delta
        ?? window.observedDelta
        ?? window.window_delta
        ?? window.windowDelta
        ?? window.mean_delta
        ?? window.meanDelta
      ) !== null
      || samples.some((sample) => finiteNumber(asObject(sample).metric_value ?? asObject(sample).metricValue) !== null);
    const evidenceRefs = compactStringList(window.evidence_refs ?? window.evidenceRefs);
    const minFrames = Math.max(2, finiteNumber(window.min_frames ?? window.minFrames) ?? 2);
    const convergenceAccepted =
      frameStart !== null
      && frameEnd !== null
      && frameEnd >= frameStart
      && metric !== null
      && CONVERGENCE_METRICS.has(metric)
      && (sampleCount ?? 0) >= minFrames
      && hasMetricEvidence
      && (window.convergence_proven === true || window.convergenceProven === true || window.proven === true)
      && evidenceRefs.length > 0;
    if (!convergenceAccepted) {
      failures.push({ code: "temporal_visual_requires_convergence_window" });
      if ((sampleCount ?? 0) < minFrames) {
        failures.push({ code: "convergence_window_sample_evidence_missing" });
      }
    }
  }
  return failures;
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

function modelField(record: Record<string, unknown>, snakeKey: string, camelKey: string): unknown {
  return record[snakeKey] ?? record[camelKey];
}

function modelFieldRecorded(record: Record<string, unknown>, snakeKey: string, camelKey: string): boolean {
  return valueRecorded(record, snakeKey) || valueRecorded(record, camelKey);
}

function modelFieldText(record: Record<string, unknown>, snakeKey: string, camelKey: string): string | null {
  return firstText(modelField(record, snakeKey, camelKey));
}

function modelStatus(record: Record<string, unknown>): string | null {
  return modelFieldText(record, "provider_model_status", "providerModelStatus");
}

function prefixedModelStatus(record: Record<string, unknown>, prefix: "actual" | "fallback"): string | null {
  const pascal = `${prefix.charAt(0).toUpperCase()}${prefix.slice(1)}`;
  return firstText(
    modelField(record, `${prefix}_provider_model_status`, `${prefix}ProviderModelStatus`),
    modelField(record, `${prefix}_model_provider_status`, `${pascal}ModelProviderStatus`)
  );
}

function modelHardInfraFailure(record: Record<string, unknown>): boolean {
  return modelField(record, "hard_infra_failure", "hardInfraFailure") === true;
}

function modelFallbackUsed(record: Record<string, unknown>): boolean {
  return modelField(record, "fallback_used", "fallbackUsed") === true;
}

function modelShutdownOrDeprecationDetected(record: Record<string, unknown>): boolean {
  return modelField(
    record,
    "provider_shutdown_or_deprecation_detected",
    "providerShutdownOrDeprecationDetected"
  ) === true;
}

function modelRequestMode(entry: [string, Record<string, unknown>]): string | null {
  const [key, record] = entry;
  return firstText(record.request_mode, record.requestMode, key);
}

function modelRoleIsSplit(entry: [string, Record<string, unknown>]): boolean {
  const [key] = entry;
  return ["split", "gpu_split", "gpuSplit"].includes(key) || modelRequestMode(entry) === "split";
}

function modelRoleIsGpuDelta(entry: [string, Record<string, unknown>]): boolean {
  const [key] = entry;
  return ["last_gpu_delta", "lastGpuDelta", "gpu_delta", "gpuDelta", "delta"].includes(key)
    || modelRequestMode(entry) === "gpu_delta";
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
  const oracleArtifacts = asObject(
    input.oracle_artifacts
    ?? input.oracleArtifacts
    ?? outputEvent.oracle_artifacts
    ?? outputEvent.oracleArtifacts
  );
  const deterministicVisualMode = asObject(
    input.deterministic_visual_mode
    ?? input.deterministicVisualMode
    ?? outputEvent.deterministic_visual_mode
    ?? outputEvent.deterministicVisualMode
  );
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
  const visualArtifacts = visualOracleArtifacts(oracleArtifacts, outputEvent);
  if (isVisualOutput(outputEvent) || visualArtifacts !== null) {
    if (visualArtifacts === null) {
      failures.push({ code: "visual_oracle_artifacts_missing" });
    } else {
      const missingFields = missingArtifactFields(visualArtifacts, VISUAL_ORACLE_ARTIFACT_FIELDS);
      if (missingFields.length > 0) {
        failures.push({ code: "visual_oracle_artifacts_incomplete", missingFields });
      }
      if (objectFieldValue(visualArtifacts, ["blank_frame_rejection", "blankFrameRejection"]) !== true) {
        failures.push({ code: "visual_blank_frame_rejection_not_proven" });
      }
      if (objectFieldValue(visualArtifacts, ["same_frame_rejection", "sameFrameRejection"]) !== true) {
        failures.push({ code: "visual_same_frame_rejection_not_proven" });
      }
      const beforeImage = artifactText(visualArtifacts, "before_image", "beforeImage");
      const afterImage = artifactText(visualArtifacts, "after_image", "afterImage");
      const diffImage = artifactText(visualArtifacts, "diff_image", "diffImage");
      if (beforeImage && afterImage && beforeImage === afterImage) {
        failures.push({ code: "visual_before_after_same_artifact" });
      }
      if (diffImage && (diffImage === beforeImage || diffImage === afterImage)) {
        failures.push({ code: "visual_diff_artifact_not_independent" });
      }
      const changedPixelRatio = artifactNumber(visualArtifacts, "changed_pixel_ratio", "changedPixelRatio");
      if (changedPixelRatio !== null && changedPixelRatio <= 0) {
        failures.push({ code: "visual_changed_pixel_ratio_zero" });
      }
      const perceptualDiff = artifactNumber(visualArtifacts, "perceptual_diff", "perceptualDiff");
      if (perceptualDiff !== null && perceptualDiff <= 0) {
        failures.push({ code: "visual_perceptual_diff_zero" });
      }
      const visiblePixelCount = artifactNumber(
        visualArtifacts,
        "visible_pixel_count",
        "visiblePixelCount"
      );
      if (visiblePixelCount !== null && visiblePixelCount <= 0) {
        failures.push({ code: "visual_visible_pixel_count_zero" });
      }
      const swapchainSize = artifactArray(visualArtifacts, "swapchain_size", "swapchainSize");
      if (
        swapchainSize.length !== 2
        || !swapchainSize.every((value) => Number.isFinite(Number(value)) && Number(value) > 0)
      ) {
        failures.push({ code: "visual_swapchain_size_invalid" });
      }
      const visualTimestamp = artifactNumber(
        visualArtifacts,
        "timestamp_after_dispatch",
        "timestampAfterDispatch"
      );
      if (dispatchTs !== null && visualTimestamp !== null && visualTimestamp < dispatchTs) {
        failures.push({ code: "visual_artifact_precedes_dispatch" });
      }
      const visualTrace = objectFieldValue(visualArtifacts, [
        "new_epoch_watermark_or_trace",
        "newEpochWatermarkOrTrace",
        "epoch_trace",
        "epochTrace",
      ]);
      if (!visualTraceCorrelates(visualTrace, [publishedEpoch, dispatchEpoch, artifactAfterHash, dispatchId])) {
        failures.push({ code: "visual_epoch_trace_not_correlated" });
      }
    }
    const deterministicFailures = deterministicVisualFailures(deterministicVisualMode);
    if (deterministicFailures.length > 0) {
      failures.push({ code: "visual_output_without_deterministic_mode" }, ...deterministicFailures);
    }
  } else {
    const computeArtifacts = computeOracleArtifacts(oracleArtifacts, outputEvent);
    if (computeArtifacts === null) {
      failures.push({ code: "compute_oracle_artifacts_missing" });
    } else {
      const missingFields = missingArtifactFields(computeArtifacts, COMPUTE_ORACLE_ARTIFACT_FIELDS);
      if (missingFields.length > 0) {
        failures.push({ code: "compute_oracle_artifacts_incomplete", missingFields });
      }
      const checksumBefore = artifactText(computeArtifacts, "checksum_before", "checksumBefore");
      const checksumAfter = artifactText(computeArtifacts, "checksum_after", "checksumAfter");
      const outputChangeExpected =
        objectFieldValue(computeArtifacts, [
          "output_change_expected",
          "outputChangeExpected",
          "expected_output_change",
          "expectedOutputChange",
        ]) === true;
      if (outputChangeExpected && checksumBefore && checksumAfter && checksumBefore === checksumAfter) {
        failures.push({ code: "compute_oracle_checksum_unchanged" });
      }
    }
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
  if (!models.some(modelRoleIsSplit)) failures.push({ code: "model_provenance_split_missing" });
  if (!models.some(modelRoleIsGpuDelta)) failures.push({ code: "model_provenance_gpu_delta_missing" });
  for (const [index, entry] of models.entries()) {
    const model = entry[1];
    const prefix = `model_provenance_${index}`;
    for (const [snakeKey, camelKey, code] of REQUIRED_MODEL_FIELDS) {
      if (!modelFieldRecorded(model, snakeKey, camelKey)) {
        failures.push({ code, record: prefix });
      }
    }
    const status = modelStatus(model);
    if (status === "shutdown") {
      failures.push({
        code: "model_provider_status_shutdown",
        record: prefix,
        requested_model: modelFieldText(model, "requested_model", "requestedModel"),
      });
    } else if (!MODEL_PROVIDER_STATUSES.has(status ?? "")) {
      failures.push({
        code: "model_provider_status_not_accepted",
        record: prefix,
        provider_model_status: status,
      });
    }
    if (modelHardInfraFailure(model)) failures.push({ code: "model_hard_infra_failure", record: prefix });
    if (modelRoleIsGpuDelta(models[index]!) && modelFallbackUsed(model)) {
      failures.push({ code: "gpu_delta_model_fallback_used", record: prefix });
    }
    if (modelFallbackUsed(model)) {
      for (const [snakeKey, camelKey, code] of [
        ["actual_provider_model_status", "actualProviderModelStatus", "actual_provider_model_status_missing"],
        ["actual_model_availability_checked_at", "actualModelAvailabilityCheckedAt", "actual_model_availability_checked_at_missing"],
        ["fallback_provider_model_status", "fallbackProviderModelStatus", "fallback_provider_model_status_missing"],
        ["fallback_model_availability_checked_at", "fallbackModelAvailabilityCheckedAt", "fallback_model_availability_checked_at_missing"],
      ] as const) {
        if (!modelFieldRecorded(model, snakeKey, camelKey)) {
          failures.push({ code, record: prefix });
        }
      }
      const actualStatus = prefixedModelStatus(model, "actual");
      if (actualStatus === "shutdown") {
        failures.push({ code: "actual_model_provider_status_shutdown", record: prefix });
      } else if (!MODEL_PROVIDER_STATUSES.has(actualStatus ?? "")) {
        failures.push({
          code: "actual_provider_model_status_not_accepted",
          record: prefix,
          provider_model_status: actualStatus,
        });
      }
      const fallbackStatus = prefixedModelStatus(model, "fallback");
      if (fallbackStatus === "shutdown") {
        failures.push({ code: "fallback_model_provider_status_shutdown", record: prefix });
      } else if (!MODEL_PROVIDER_STATUSES.has(fallbackStatus ?? "")) {
        failures.push({
          code: "fallback_provider_model_status_not_accepted",
          record: prefix,
          provider_model_status: fallbackStatus,
        });
      }
    }
    if (status === "deprecated" && !modelShutdownOrDeprecationDetected(model)) {
      failures.push({ code: "model_deprecation_not_recorded", record: prefix });
    }
  }

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
