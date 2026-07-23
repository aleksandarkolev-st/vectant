import { createHash } from "node:crypto";

export const GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION = "synthi.gpu.hmr.proof_ledger.v1";
export const GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE =
  "synthi.gpu_hmr.proof_ledger.portable.v2";

const GPU_PROJECT_KINDS = new Set(["gpu_project", "mixed_project"]);
const GPU_ARTIFACT_EDIT_KINDS = new Set(["gpu_artifact_edit"]);
const METRIC_CLOCKS = new Set(["monotonic_ns"]);
const METRIC_SCOPES = new Set(["cold", "warm", "hot_delta_1", "hot_delta_2"]);
const CACHE_STATES = new Set(["clean", "compiler_cache_warm", "pipeline_cache_warm"]);
const RECOGNIZED_RETIREMENT_PROOFS = new Set([
  "stream_event_proven",
  "queue_idle_proven",
  "frame_boundary_proven",
  "no_retirement_required",
]);
const RECOGNIZED_RETIREMENT_RESULTS = new Set(["retired_after_quiescent"]);
const MODEL_PROVIDER_STATUSES = new Set(["available", "deprecated", "private_alias"]);
const MODEL_AVAILABILITY_BASES = new Set([
  "static_registry",
  "static_registry+live_model_list",
  "live_model_list",
  "live_model_list_registry_override",
  "private_alias_env",
]);
export const DEFAULT_GPU_HMR_MODEL_POLICY = {
  roles: {
    split: { provider: "google_gemini", model: "gemini-3.5-flash" },
    gpu_delta: { provider: "google_gemini", model: "gemini-3.1-flash-lite" },
  },
  providerAliases: {
    google_gemini: ["gemini", "gemini_api", "google_gemini"],
  },
} as const;
const ACCEPTED_COMPUTE_RAW_READBACK_SOURCES = new Set([
  "runtime_readback",
  "runtime_readback_sample",
  "runtime_raw_readback",
  "device_readback",
]);
const DIGEST_DERIVED_COMPUTE_RAW_READBACK_SOURCES = new Set([
  "runtime_checksum_digest",
  "sha256_digest_bytes",
  "checksum_digest",
  "digest_bytes",
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
  ["timestamp_after_dispatch", "timestampAfterDispatch"],
  ["perceptual_diff", "perceptualDiff"],
  ["changed_pixel_ratio", "changedPixelRatio"],
  ["visible_pixel_count", "visiblePixelCount"],
] as const;
const VISUAL_ORACLE_ARTIFACT_ANCHOR_FIELDS = VISUAL_ORACLE_ARTIFACT_FIELDS
  .filter((keys) =>
    !keys.some((key) => key === "timestamp_after_dispatch" || key === "timestampAfterDispatch")
  );
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
  ["model_availability_source", "modelAvailabilitySource", "model_availability_source_missing"],
  ["model_availability_basis", "modelAvailabilityBasis", "model_availability_basis_missing"],
  ["model_availability_check_time_ms", "modelAvailabilityCheckTimeMs", "model_availability_check_time_ms_missing"],
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

function identifierText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return text(value);
}

function firstIdentifierText(...values: unknown[]): string | null {
  for (const value of values) {
    const normalized = identifierText(value);
    if (normalized) return normalized;
  }
  return null;
}

function compactStringList(values: unknown): string[] {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(text)
    .filter((value): value is string => value !== null))];
}

type ModelRole = "split" | "gpu_delta";
type ModelPolicy = {
  roles: Record<ModelRole, { provider: string; model: string }>;
  providerAliases: Record<string, readonly string[]>;
};

function modelPolicyRoleFromValue(value: unknown): { provider: string; model: string } | null {
  const object = asObject(value);
  const provider = firstText(object.provider, object.model_provider, object.modelProvider);
  const model = firstText(object.model, object.required_model, object.requiredModel);
  return provider && model ? { provider, model } : null;
}

function modelPolicyAliasesFromValue(value: unknown): Record<string, string[]> {
  const object = asObject(value);
  const aliases: Record<string, string[]> = {};
  for (const [provider, rawAliases] of Object.entries(object)) {
    const canonicalProvider = text(provider);
    if (!canonicalProvider) continue;
    const values = compactStringList(Array.isArray(rawAliases) ? rawAliases : [rawAliases]);
    aliases[canonicalProvider] = values.length > 0 ? values : [canonicalProvider];
  }
  return aliases;
}

function resolveGpuHmrModelPolicy(...candidates: unknown[]): ModelPolicy {
  const policy: ModelPolicy = {
    roles: {
      split: { ...DEFAULT_GPU_HMR_MODEL_POLICY.roles.split },
      gpu_delta: { ...DEFAULT_GPU_HMR_MODEL_POLICY.roles.gpu_delta },
    },
    providerAliases: Object.fromEntries(
      Object.entries(DEFAULT_GPU_HMR_MODEL_POLICY.providerAliases)
        .map(([provider, aliases]) => [provider, [...aliases]])
    ),
  };
  for (const candidate of candidates) {
    const object = asObject(candidate);
    if (Object.keys(object).length === 0) continue;
    const roles = asObject(object.roles ?? object.model_roles ?? object.modelRoles);
    for (const role of ["split", "gpu_delta"] as const) {
      const roleValue = modelPolicyRoleFromValue(
        roles[role]
        ?? object[role]
        ?? object[role === "gpu_delta" ? "gpuDelta" : role]
      );
      if (roleValue) policy.roles[role] = roleValue;
    }
    const providerAliases = modelPolicyAliasesFromValue(
      object.providerAliases
      ?? object.provider_aliases
      ?? object.aliases
      ?? object.provider_alias_map
    );
    for (const [provider, aliases] of Object.entries(providerAliases)) {
      policy.providerAliases[provider] = compactStringList([provider, ...aliases]);
    }
  }
  return policy;
}

function normalizeModelProvider(value: unknown, policy: ModelPolicy = DEFAULT_GPU_HMR_MODEL_POLICY): string | null {
  const provider = firstText(value);
  if (!provider) return null;
  for (const [canonical, rawAliases] of Object.entries(policy.providerAliases)) {
    const canonicalProvider = text(canonical);
    if (!canonicalProvider) continue;
    const values = compactStringList([canonicalProvider, ...rawAliases]);
    if (values.includes(provider)) return canonicalProvider;
  }
  return provider;
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

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(object[key])}`
  ).join(",")}}`;
}

function objectAliasMismatch(
  object: Record<string, unknown>,
  leftKey: string,
  rightKey: string
): boolean {
  return hasOwn(object, leftKey)
    && hasOwn(object, rightKey)
    && stableJson(object[leftKey]) !== stableJson(object[rightKey]);
}

function aliasGroupMismatch(object: Record<string, unknown>, keys: readonly string[]): boolean {
  const values = keys
    .filter((key) => hasOwn(object, key))
    .map((key) => stableJson(object[key]));
  return new Set(values).size > 1;
}

function aliasGroupValues(
  sources: ReadonlyArray<[Record<string, unknown>, readonly string[]]>
): unknown[] {
  const values: unknown[] = [];
  for (const [object, keys] of sources) {
    for (const key of keys) {
      if (hasOwn(object, key)) values.push(object[key]);
    }
  }
  return values;
}

function aliasValuesMismatch(values: readonly unknown[]): boolean {
  return new Set(values.map(stableJson)).size > 1;
}

function canonicalDecimalEpoch(value: unknown): string | null {
  return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/.test(value) ? value : null;
}

function exactSchemaVersion(
  object: Record<string, unknown>
): { present: boolean; aliasMismatch: boolean; exact: boolean; value: string | null } {
  const values = ["schema_version", "schemaVersion"]
    .filter((key) => hasOwn(object, key))
    .map((key) => object[key]);
  return {
    present: values.length > 0,
    aliasMismatch: objectAliasMismatch(object, "schemaVersion", "schema_version"),
    exact: values.length > 0
      && values.every((value) => value === GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION),
    value: firstText(object.schema_version, object.schemaVersion),
  };
}

function deepSnakeCamelAliasMismatch(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(deepSnakeCamelAliasMismatch);
  if (!isObject(value)) return false;
  for (const key of Object.keys(value)) {
    if (key.includes("_")) {
      const camelKey = key.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
      if (
        camelKey !== key
        && hasOwn(value, camelKey)
        && stableJson(value[key]) !== stableJson(value[camelKey])
      ) {
        return true;
      }
    }
    if (deepSnakeCamelAliasMismatch(value[key])) return true;
  }
  return false;
}

function eventFieldAliasMismatch(
  event: Record<string, unknown>,
  mode: "standard" | "dispatch" | "output" | "retirement" = "standard"
): boolean {
  const eventIdAliases = ["id", "event_id", "eventId", "proof_id", "proofId"];
  if (mode === "dispatch") eventIdAliases.push("dispatch_id", "dispatchId");
  const aliasGroups = [
    eventIdAliases,
    ["event", "event_kind", "eventKind", "kind"],
    ["epoch", "epoch_id", "epochId", "generation"],
    [
      "artifact_hash", "artifactHash", "artifact_id", "artifactId",
      "loaded_artifact_hash", "loadedArtifactHash", "loaded_artifact_id",
      "loadedArtifactId", "published_artifact_hash", "publishedArtifactHash",
      "published_artifact_id", "publishedArtifactId", "runtime_artifact_id", "runtimeArtifactId",
      "selected_artifact_id", "selectedArtifactId", "new_artifact_hash",
      "newArtifactHash", "hash",
    ],
    ["process_id", "processId", "pid"],
    ["publication_id", "publicationId"],
    ["candidate_registration_id", "candidateRegistrationId"],
    ["dispatcher_registration_id", "dispatcherRegistrationId"],
    ["previous_epoch", "previousEpoch"],
    ["device_uuid", "deviceUuid", "device_id", "deviceId"],
    ["timestamp_monotonic_ns", "timestampMonotonicNs", "timestamp_ms", "timestampMs", "ts"],
    ["passed", "success", "succeeded", "accepted", "gpu_hmr_success", "gpuHmrSuccess"],
  ];
  if (mode === "output") {
    aliasGroups.push(["after_dispatch_id", "afterDispatchId", "dispatch_id", "dispatchId"]);
    const outputTargetIds = [
      event.output_target,
      event.outputTarget,
      event.output_target_id,
      event.outputTargetId,
      event.target_id,
      event.targetId,
    ].flatMap((value) => {
      if (isObject(value)) {
        return compactStringList([value.id, value.target_id, value.targetId]);
      }
      return compactStringList([value]);
    });
    if (new Set(outputTargetIds).size > 1) return true;
  }
  if (mode === "retirement") {
    aliasGroups.push(
      ["status", "result", "retirement_result", "retirementResult"],
      ["proof", "retirement_proof", "retirementProof"]
    );
  }
  return aliasGroups.some((keys) => {
    const values = keys
      .filter((key) => hasOwn(event, key))
      .map((key) => stableJson(event[key]));
    return new Set(values).size > 1;
  });
}

function portableMonotonicTimestamp(event: Record<string, unknown>): number | null {
  const value = event.timestamp_monotonic_ns ?? event.timestampMonotonicNs;
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function portableCanonicalJsonNumbersSupported(value: unknown): boolean {
  if (typeof value === "number") return Number.isSafeInteger(value);
  if (Array.isArray(value)) return value.every(portableCanonicalJsonNumbersSupported);
  if (isObject(value)) {
    return Object.values(value).every(portableCanonicalJsonNumbersSupported);
  }
  return true;
}

function sha256Hex(value: unknown): string {
  return createHash("sha256").update(String(value ?? "")).digest("hex");
}

function canonicalLedgerProofId(input: Record<string, unknown>): string {
  return `gpu-ledger-proof:sha256:${sha256Hex(stableJson(input))}`;
}

function canonicalLedgerRootProofId(recordProofIds: Array<string | null>): string | null {
  if (recordProofIds.length === 0 || recordProofIds.some((proofId) => !proofId)) {
    return null;
  }
  if (recordProofIds.length === 1) return recordProofIds[0]!;
  return canonicalLedgerProofId({
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    records: recordProofIds,
  });
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
    event.loaded_artifact_id,
    event.loadedArtifactId,
    event.published_artifact_hash,
    event.publishedArtifactHash,
    event.published_artifact_id,
    event.publishedArtifactId,
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
  return firstIdentifierText(event.process_id, event.processId, event.pid);
}

function firewallProcessIdBefore(evidence: Record<string, unknown>): string | null {
  return firstIdentifierText(
    evidence.process_id_before,
    evidence.processIdBefore,
    evidence.firewall_process_id_before,
    evidence.firewallProcessIdBefore
  );
}

function firewallProcessIdAfter(evidence: Record<string, unknown>): string | null {
  return firstIdentifierText(
    evidence.process_id_after,
    evidence.processIdAfter,
    evidence.firewall_process_id_after,
    evidence.firewallProcessIdAfter
  );
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

function outputOracleTargetForRecord(
  input: Record<string, unknown>,
  outputEvent: Record<string, unknown>
): Record<string, unknown> {
  const outputOracle = outputOracleObject(outputEvent);
  return asObject(
    input.output_oracle_target
    ?? input.outputOracleTarget
    ?? outputEvent.output_oracle_target
    ?? outputEvent.outputOracleTarget
    ?? outputOracle.output_oracle_target
    ?? outputOracle.outputOracleTarget
  );
}

function outputOracleTargetModalityValues(target: Record<string, unknown>): string[] {
  const kind = target.kind;
  return compactStringList([
    isObject(kind) ? asObject(kind).value : kind,
    target.target_kind,
    target.targetKind,
  ]).map((value) => value.toLowerCase());
}

function outputOracleTargetIdValues(target: Record<string, unknown>): string[] {
  return compactStringList([target.id, target.target_id, target.targetId]);
}

function outputOracleTargetEvidenceRefSets(target: Record<string, unknown>): string[] {
  return [target.evidence_refs, target.evidenceRefs]
    .filter((value) => value !== undefined)
    .map((value) => stableJson(compactStringList(value).sort()));
}

function outputOracleTargetInternalMismatch(target: Record<string, unknown>): boolean {
  return new Set(outputOracleTargetModalityValues(target)).size > 1
    || new Set(outputOracleTargetIdValues(target)).size > 1
    || new Set(outputOracleTargetEvidenceRefSets(target)).size > 1;
}

function outputOracleTargetDeclarationProjections(input: Record<string, unknown>): string[] {
  const outputEvent = asObject(input.output_event ?? input.outputEvent);
  const outputOracle = outputOracleObject(outputEvent);
  return [
    input.output_oracle_target,
    input.outputOracleTarget,
    outputEvent.output_oracle_target,
    outputEvent.outputOracleTarget,
    outputOracle.output_oracle_target,
    outputOracle.outputOracleTarget,
  ]
    .filter(isObject)
    .map((candidate) => stableJson({
      modality: outputOracleTargetModality(candidate),
      targetId: outputOracleTargetId(candidate),
      evidenceRefs: outputOracleTargetEvidenceRefs(candidate).sort(),
    }));
}

function outputOracleTargetDeclarationMismatch(input: Record<string, unknown>): boolean {
  const outputEvent = asObject(input.output_event ?? input.outputEvent);
  const outputOracle = outputOracleObject(outputEvent);
  const declarations = [
    input.output_oracle_target,
    input.outputOracleTarget,
    outputEvent.output_oracle_target,
    outputEvent.outputOracleTarget,
    outputOracle.output_oracle_target,
    outputOracle.outputOracleTarget,
  ].filter(isObject);
  return declarations.some(outputOracleTargetInternalMismatch)
    || new Set(outputOracleTargetDeclarationProjections(input)).size > 1;
}

function outputOracleTargetModality(target: Record<string, unknown>): string | null {
  return outputOracleTargetModalityValues(target)[0] ?? null;
}

function outputOracleTargetId(target: Record<string, unknown>): string | null {
  return outputOracleTargetIdValues(target)[0] ?? null;
}

function outputEventTargetId(outputEvent: Record<string, unknown>): string | null {
  const eventTarget = asObject(outputEvent.output_target ?? outputEvent.outputTarget);
  return firstText(
    typeof outputEvent.output_target === "string" ? outputEvent.output_target : null,
    typeof outputEvent.outputTarget === "string" ? outputEvent.outputTarget : null,
    outputEvent.output_target_id,
    outputEvent.outputTargetId,
    outputEvent.target_id,
    outputEvent.targetId,
    eventTarget.id,
    eventTarget.target_id,
    eventTarget.targetId
  );
}

function outputOracleTargetEvidenceRefs(target: Record<string, unknown>): string[] {
  return compactStringList(target.evidence_refs ?? target.evidenceRefs);
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

function computeRawReadbackSource(artifacts: Record<string, unknown>): string | null {
  const source = artifactText(
    artifacts,
    "raw_readback_source",
    "rawReadbackSource",
    "readback_source",
    "readbackSource",
    "encoding"
  );
  if (source) return source;
  const deterministicSlice = asObject(objectFieldValue(artifacts, [
    "deterministic_slice",
    "deterministicSlice",
  ]));
  return artifactText(deterministicSlice, "source");
}

function computeRawReadbackHash(artifacts: Record<string, unknown>): string | null {
  return artifactText(
    artifacts,
    "raw_readback_hash",
    "rawReadbackHash",
    "readback_sample_sha256",
    "readbackSampleSha256"
  );
}

function computeByteVerification(artifacts: Record<string, unknown>): Record<string, unknown> {
  return asObject(
    artifacts.raw_readback_verification
    ?? artifacts.rawReadbackVerification
    ?? artifacts.byte_verification
    ?? artifacts.byteVerification
  );
}

function computeVerifiedBool(
  artifacts: Record<string, unknown>,
  verification: Record<string, unknown>,
  artifactKeys: string[],
  verificationKeys: string[]
): boolean {
  return artifactKeys.some((key) => artifacts[key] === true)
    || verificationKeys.some((key) => verification[key] === true);
}

function computeReadbackByteLength(
  artifacts: Record<string, unknown>,
  verification: Record<string, unknown>
): number | null {
  return artifactNumber(
    { ...verification, ...artifacts },
    "raw_readback_byte_length",
    "rawReadbackByteLength",
    "byte_length",
    "byteLength",
    "bytes",
    "size"
  );
}

function computeDeterministicSlice(artifacts: Record<string, unknown>): Record<string, unknown> {
  return asObject(objectFieldValue(artifacts, [
    "deterministic_slice",
    "deterministicSlice",
  ]));
}

function computeDeterministicSliceHash(
  artifacts: Record<string, unknown>,
  slice: Record<string, unknown>,
  verification: Record<string, unknown>
): string | null {
  return firstText(
    artifacts.deterministic_slice_hash,
    artifacts.deterministicSliceHash,
    slice.hash,
    slice.sha256,
    slice.slice_hash,
    slice.sliceHash,
    verification.deterministic_slice_hash,
    verification.deterministicSliceHash
  );
}

function computeSha256Digest(value: string | null): string | null {
  return value?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
}

function canonicalSha256(value: unknown): string | null {
  const digest = computeSha256Digest(firstText(value));
  return digest ? `sha256:${digest}` : null;
}

function visualOracleArtifacts(
  recordOracleArtifacts: Record<string, unknown>,
  outputEvent: Record<string, unknown>
): Record<string, unknown> | null {
  const { ledgerArtifacts, outputArtifacts, outputOracle, outputOracleArtifacts } =
    oracleArtifactSources(recordOracleArtifacts, outputEvent);
  const explicitVisualArtifacts = firstArtifactObject([
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
  ], VISUAL_ORACLE_ARTIFACT_FIELDS);
  if (explicitVisualArtifacts !== null) return explicitVisualArtifacts;

  return firstArtifactObject([
    ledgerArtifacts,
    outputArtifacts,
    outputOracleArtifacts,
    outputOracle,
  ], VISUAL_ORACLE_ARTIFACT_ANCHOR_FIELDS);
}

function visualPixelVerification(artifacts: Record<string, unknown>): Record<string, unknown> {
  return asObject(
    artifacts.visual_pixel_verification
    ?? artifacts.visualPixelVerification
    ?? artifacts.pixel_verification
    ?? artifacts.pixelVerification
  );
}

function visualVerifiedBool(
  artifacts: Record<string, unknown>,
  verification: Record<string, unknown>,
  artifactKeys: string[],
  verificationKeys: string[]
): boolean {
  return artifactKeys.some((key) => artifacts[key] === true)
    || verificationKeys.some((key) => verification[key] === true);
}

function visualArtifactHash(
  artifacts: Record<string, unknown>,
  verification: Record<string, unknown>,
  artifactKeys: string[],
  verificationKeys: string[]
): string | null {
  return firstText(...artifactKeys.map((key) => artifacts[key]), ...verificationKeys.map((key) => verification[key]));
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

function consensusBoolField(
  object: Record<string, unknown>,
  ...keys: string[]
): { value: boolean | null; conflict: boolean } {
  const observed = keys
    .map((key) => object[key])
    .filter((value): value is boolean => typeof value === "boolean");
  const distinct = new Set(observed);
  return {
    value: distinct.size === 1 ? (observed[0] ?? null) : null,
    conflict: distinct.size > 1,
  };
}

function convergenceWindowDeclared(window: Record<string, unknown>): boolean {
  const arrayHasEntries = (...keys: string[]): boolean => keys.some(
    (key) => Array.isArray(window[key]) && (window[key] as unknown[]).length > 0
  );
  return finiteNumber(
    window.sample_start
    ?? window.sampleStart
    ?? window.observation_start
    ?? window.observationStart
    ?? window.frame_start
    ?? window.frameStart
  ) !== null
    || finiteNumber(
      window.sample_end
      ?? window.sampleEnd
      ?? window.observation_end
      ?? window.observationEnd
      ?? window.frame_end
      ?? window.frameEnd
    ) !== null
    || finiteNumber(window.sample_count ?? window.sampleCount) !== null
    || arrayHasEntries(
      "samples",
      "sample_hashes",
      "sampleHashes",
      "observation_hashes",
      "observationHashes",
      "frame_hashes",
      "frameHashes",
      "pre_dispatch_sample_hashes",
      "preDispatchSampleHashes",
      "pre_epoch_frame_hashes",
      "preEpochFrameHashes",
      "post_dispatch_sample_hashes",
      "postDispatchSampleHashes",
      "post_epoch_frame_hashes",
      "postEpochFrameHashes",
      "artifact_hashes",
      "artifactHashes"
    )
    || firstText(window.artifact_hash, window.artifactHash) !== null
    || firstText(asObject(window.metric).value, window.metric) !== null
    || finiteNumber(window.metric_value ?? window.metricValue) !== null
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
    || typeof (window.convergence_proven ?? window.convergenceProven ?? window.proven) === "boolean"
    || compactStringList(window.evidence_refs ?? window.evidenceRefs).length > 0;
}

function deterministicVisualFailures(modeInput: unknown): GpuHmrLedgerFailure[] {
  const mode = asObject(modeInput);
  const failures: GpuHmrLedgerFailure[] = [];
  const outputObservedAfterDispatch = consensusBoolField(
    mode,
    "output_observation_after_dispatch",
    "outputObservationAfterDispatch",
    "output_capture_after_dispatch",
    "outputCaptureAfterDispatch",
    "frame_capture_after_epoch_dispatch",
    "frameCaptureAfterEpochDispatch"
  );
  const outputObservationOrdering = consensusBoolField(
    mode,
    "output_observation_ordering_proven",
    "outputObservationOrderingProven",
    "output_completion_observed",
    "outputCompletionObserved",
    "completion_boundary_proven",
    "completionBoundaryProven",
    "presentation_fence_or_frame_boundary",
    "presentationFenceOrFrameBoundary",
    "presentation_boundary_proven",
    "presentationBoundaryProven"
  );
  const aliasConflictFields = compactStringList([
    outputObservedAfterDispatch.conflict ? "output_observation_after_dispatch" : null,
    outputObservationOrdering.conflict ? "output_observation_ordering_proven" : null,
  ]);
  if (aliasConflictFields.length > 0) {
    failures.push({
      code: "output_observation_alias_conflict",
      fields: aliasConflictFields,
    });
  }
  if (outputObservedAfterDispatch.value !== true) {
    failures.push({ code: "output_observation_after_dispatch_unproven" });
  }
  if (outputObservationOrdering.value !== true) {
    failures.push({ code: "output_observation_ordering_unproven" });
  }

  const window = asObject(mode.convergence_window ?? mode.convergenceWindow);
  const convergenceDeclared = convergenceWindowDeclared(window);
  if (convergenceDeclared) {
    const metric = text(asObject(window.metric).value ?? window.metric);
    const sampleStart = finiteNumber(
      window.sample_start
      ?? window.sampleStart
      ?? window.observation_start
      ?? window.observationStart
      ?? window.frame_start
      ?? window.frameStart
    );
    const sampleEnd = finiteNumber(
      window.sample_end
      ?? window.sampleEnd
      ?? window.observation_end
      ?? window.observationEnd
      ?? window.frame_end
      ?? window.frameEnd
    );
    const samples = Array.isArray(window.samples) ? window.samples : [];
    const rawSampleHashes = [
      ...(Array.isArray(window.sample_hashes) ? window.sample_hashes : []),
      ...(Array.isArray(window.sampleHashes) ? window.sampleHashes : []),
      ...(Array.isArray(window.observation_hashes) ? window.observation_hashes : []),
      ...(Array.isArray(window.observationHashes) ? window.observationHashes : []),
      ...(Array.isArray(window.frame_hashes) ? window.frame_hashes : []),
      ...(Array.isArray(window.frameHashes) ? window.frameHashes : []),
      ...(Array.isArray(window.post_dispatch_sample_hashes)
        ? window.post_dispatch_sample_hashes
        : []),
      ...(Array.isArray(window.postDispatchSampleHashes)
        ? window.postDispatchSampleHashes
        : []),
      ...(Array.isArray(window.post_epoch_frame_hashes)
        ? window.post_epoch_frame_hashes
        : []),
      ...(Array.isArray(window.postEpochFrameHashes)
        ? window.postEpochFrameHashes
        : []),
      ...samples.map((sample) => firstText(
        asObject(sample).sample_hash,
        asObject(sample).sampleHash,
        asObject(sample).observation_hash,
        asObject(sample).observationHash,
        asObject(sample).frame_hash,
        asObject(sample).frameHash,
        asObject(sample).image_hash,
        asObject(sample).imageHash,
        asObject(sample).source_frame_hash,
        asObject(sample).sourceFrameHash
      )),
    ].map((value) => firstText(value)).filter((value): value is string => value !== null);
    const sampleHashes = compactStringList(rawSampleHashes);
    const canonicalSampleHashes = rawSampleHashes
      .map((hash) => canonicalSha256(hash))
      .filter((hash): hash is string => hash !== null);
    const uniqueCanonicalSampleHashes = compactStringList(canonicalSampleHashes);
    const invalidSampleHashes = compactStringList(
      rawSampleHashes.filter((hash) => canonicalSha256(hash) === null)
    );
    const duplicateSampleHashes = compactStringList(
      canonicalSampleHashes.filter(
        (hash, index) => canonicalSampleHashes.indexOf(hash) !== index
      )
    );
    const postDispatchHashes = compactStringList([
      ...(Array.isArray(window.post_dispatch_sample_hashes)
        ? window.post_dispatch_sample_hashes
        : []),
      ...(Array.isArray(window.postDispatchSampleHashes)
        ? window.postDispatchSampleHashes
        : []),
      ...(Array.isArray(window.post_epoch_frame_hashes)
        ? window.post_epoch_frame_hashes
        : []),
      ...(Array.isArray(window.postEpochFrameHashes)
        ? window.postEpochFrameHashes
        : []),
      ...samples
        .filter((sample) => {
          const item = asObject(sample);
          return (
            item.after_dispatch
            ?? item.afterDispatch
            ?? item.after_epoch_dispatch
            ?? item.afterEpochDispatch
          ) === true;
        })
        .map((sample) => firstText(
          asObject(sample).sample_hash,
          asObject(sample).sampleHash,
          asObject(sample).observation_hash,
          asObject(sample).observationHash,
          asObject(sample).frame_hash,
          asObject(sample).frameHash,
          asObject(sample).image_hash,
          asObject(sample).imageHash,
          asObject(sample).source_frame_hash,
          asObject(sample).sourceFrameHash
        )),
    ].map((value) => canonicalSha256(value)).filter((value): value is string => value !== null));
    const sampleCount = finiteNumber(window.sample_count ?? window.sampleCount)
      ?? (samples.length > 0 ? samples.length : null)
      ?? (sampleHashes.length > 0 ? sampleHashes.length : null);
    const minSamples = Math.max(2, finiteNumber(
      window.min_samples
      ?? window.minSamples
      ?? window.min_frames
      ?? window.minFrames
    ) ?? (
      sampleStart !== null && sampleEnd !== null && sampleEnd >= sampleStart
        ? sampleEnd - sampleStart + 1
        : 2
    ));
    const artifactHashes = compactStringList([
      ...(Array.isArray(window.artifact_hashes) ? window.artifact_hashes : []),
      ...(Array.isArray(window.artifactHashes) ? window.artifactHashes : []),
      window.artifact_hash,
      window.artifactHash,
      ...samples.map((sample) => firstText(
        asObject(sample).artifact_hash,
        asObject(sample).artifactHash
      )),
    ]);
    const runtimeArtifactHashes = compactStringList([
      mode.artifact_hash,
      mode.artifactHash,
      mode.artifact_hash_after,
      mode.artifactHashAfter,
      mode.changed_artifact_hash,
      mode.changedArtifactHash,
      mode.gpu_artifact_hash,
      mode.gpuArtifactHash,
    ]);
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
      || samples.some((sample) => finiteNumber(
        asObject(sample).metric_value
        ?? asObject(sample).metricValue
        ?? asObject(sample).value
      ) !== null);
    const evidenceRefs = compactStringList(window.evidence_refs ?? window.evidenceRefs);

    if (sampleStart === null || sampleEnd === null || sampleEnd < sampleStart) {
      failures.push({ code: "convergence_sample_range_invalid" });
    }
    if (!metric) failures.push({ code: "convergence_metric_identifier_missing" });
    if (sampleHashes.length < minSamples) {
      failures.push({ code: "convergence_sample_evidence_missing" });
    }
    if (invalidSampleHashes.length > 0) {
      failures.push({ code: "convergence_sample_hash_invalid", hashes: invalidSampleHashes.slice(0, 3) });
    }
    if (duplicateSampleHashes.length > 0) {
      failures.push({
        code: "convergence_sample_hash_duplicate",
        hashes: duplicateSampleHashes.slice(0, 3),
      });
    }
    if (sampleCount !== null && sampleCount !== uniqueCanonicalSampleHashes.length) {
      failures.push({
        code: "convergence_sample_count_mismatch",
        declaredSampleCount: sampleCount,
        uniqueSampleCount: uniqueCanonicalSampleHashes.length,
      });
    }
    if (postDispatchHashes.length < minSamples) {
      failures.push({
        code: "convergence_post_dispatch_sample_evidence_missing",
        requiredSamples: minSamples,
        observedSamples: postDispatchHashes.length,
      });
    }
    if (samples.some((sample) => {
      const item = asObject(sample);
      return (
        item.after_dispatch
        ?? item.afterDispatch
        ?? item.after_epoch_dispatch
        ?? item.afterEpochDispatch
      ) !== true;
    })) {
      failures.push({ code: "convergence_sample_ordering_unproven" });
    }
    if (artifactHashes.length > 0) {
      failures.push({ code: "convergence_artifact_hash_not_sample_evidence" });
    }
    if (runtimeArtifactHashes.some((hash) => sampleHashes.includes(hash))) {
      failures.push({ code: "convergence_sample_hash_matches_gpu_artifact_hash" });
    }
    if (!hasMetricEvidence) failures.push({ code: "convergence_metric_evidence_missing" });
    if (
      window.convergence_proven !== true
      && window.convergenceProven !== true
      && window.proven !== true
    ) {
      failures.push({ code: "convergence_proof_missing" });
    }
    if (evidenceRefs.length === 0) {
      failures.push({ code: "convergence_evidence_refs_missing" });
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

function modelFieldText(
  record: Record<string, unknown>,
  snakeKey: string,
  camelKey: string,
  modelPolicy: ModelPolicy = DEFAULT_GPU_HMR_MODEL_POLICY
): string | null {
  const value = firstText(modelField(record, snakeKey, camelKey));
  if (snakeKey === "provider") return normalizeModelProvider(value, modelPolicy);
  return value;
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

function modelAliasResolvedTo(record: Record<string, unknown>): string | null {
  return modelFieldText(
    record,
    "provider_model_alias_resolved_to",
    "providerModelAliasResolvedTo"
  );
}

function modelShutdownOrDeprecationDetected(record: Record<string, unknown>): boolean {
  return modelField(
    record,
    "provider_shutdown_or_deprecation_detected",
    "providerShutdownOrDeprecationDetected"
  ) === true;
}

function modelAvailabilitySource(record: Record<string, unknown>): string | null {
  return modelFieldText(record, "model_availability_source", "modelAvailabilitySource");
}

function modelAvailabilityBasis(record: Record<string, unknown>): string | null {
  return modelFieldText(record, "model_availability_basis", "modelAvailabilityBasis");
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

function requiredModelRole(entry: [string, Record<string, unknown>]): "split" | "gpu_delta" | null {
  if (modelRoleIsSplit(entry)) return "split";
  if (modelRoleIsGpuDelta(entry)) return "gpu_delta";
  return null;
}

function modelMatchesRequiredModel(
  record: Record<string, unknown>,
  expectedModel: string
): {
  requestedModel: string | null;
  actualModel: string | null;
  aliasResolvedTo: string | null;
  status: string | null;
  requestedMatches: boolean;
  actualMatches: boolean;
} {
  const requestedModel = modelFieldText(record, "requested_model", "requestedModel");
  const actualModel = modelFieldText(record, "actual_model", "actualModel");
  const aliasResolvedTo = modelAliasResolvedTo(record);
  const status = modelStatus(record);
  const requestedMatches =
    requestedModel === expectedModel
    || (status === "private_alias" && aliasResolvedTo === expectedModel);
  const actualMatches =
    actualModel === expectedModel
    || (status === "private_alias" && aliasResolvedTo === expectedModel);
  return {
    requestedModel,
    actualModel,
    aliasResolvedTo,
    status,
    requestedMatches,
    actualMatches,
  };
}

function validateRecord(input: Record<string, unknown>): GpuHmrLedgerValidation {
  const failures: GpuHmrLedgerFailure[] = [];
  if (outputOracleTargetDeclarationMismatch(input)) {
    failures.push({ code: "output_oracle_target_declaration_mismatch" });
  }
  const recordSchema = exactSchemaVersion(input);
  if (recordSchema.aliasMismatch) failures.push({ code: "record_schema_alias_mismatch" });
  if (!recordSchema.present || !recordSchema.value) {
    failures.push({ code: "record_schema_version_missing" });
  } else if (!recordSchema.exact) {
    failures.push({
      code: "record_schema_version_mismatch",
      suppliedSchemaVersion: recordSchema.value,
      expectedSchemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    });
  }
  const classification = asObject(input.classification);
  const loaderEvent = asObject(input.loader_event ?? input.loaderEvent);
  const epochPublishEventAliasMismatch =
    objectAliasMismatch(input, "epoch_publish_event", "epochPublishEvent");
  const epochPublishEvent = asObject(input.epoch_publish_event ?? input.epochPublishEvent);
  const epochCommitEventSnakePresent = hasOwn(input, "epoch_commit_event");
  const epochCommitEventCamelPresent = hasOwn(input, "epochCommitEvent");
  const epochCommitEventPresent = epochCommitEventSnakePresent || epochCommitEventCamelPresent;
  const epochCommitEvent = asObject(
    epochCommitEventSnakePresent ? input.epoch_commit_event : input.epochCommitEvent
  );
  const epochCommitEventAliasMismatch =
    (
      epochCommitEventSnakePresent
      && epochCommitEventCamelPresent
      && stableJson(input.epoch_commit_event) !== stableJson(input.epochCommitEvent)
    );
  const dispatchEventAliasMismatch =
    objectAliasMismatch(input, "dispatch_event", "dispatchEvent");
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
  const modelPolicy = resolveGpuHmrModelPolicy(
    input.modelPolicy,
    input.model_policy,
    modelProvenance.modelPolicy,
    modelProvenance.model_policy
  );
  const projectId = firstText(input.project_id, input.projectId);
  const canonicalProfileSnake = firstText(input.proof_canonical_profile);
  const canonicalProfileCamel = firstText(input.proofCanonicalProfile);
  const proofCanonicalProfile = canonicalProfileSnake ?? canonicalProfileCamel;
  const proofCanonicalProfileAliasMismatch =
    objectAliasMismatch(input, "proof_canonical_profile", "proofCanonicalProfile");
  const editId = firstText(input.edit_id, input.editId);
  const backend = firstText(input.backend, input.gpu_backend, input.gpuBackend);
  const outputOracleTarget = outputOracleTargetForRecord(input, outputEvent);
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
  const loaderId = eventId(loaderEvent);
  const epochPublishId = eventId(epochPublishEvent);
  const outputId = eventId(outputEvent);
  const retirementId = eventId(retirementEvent);
  const loaderTs = eventTimestamp(loaderEvent);
  const publishTs = eventTimestamp(epochPublishEvent);
  const dispatchTs = eventTimestamp(dispatchEvent);
  const outputTs = eventTimestamp(outputEvent);
  const retirementTs = eventTimestamp(retirementEvent);
  const identityPid = eventProcessId(processIdentity);
  const firewallPidBefore = firewallProcessIdBefore(firewallEvidence);
  const firewallPidAfter = firewallProcessIdAfter(firewallEvidence);
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
  const topLevelMetricClock = firstText(input.metric_clock, input.metricClock);
  const metricClock = topLevelMetricClock;
  const metricScope = firstText(input.metric_scope, input.metricScope, timings.metric_scope, timings.metricScope, timingMetrics.metric_scope, timingMetrics.metricScope);
  const cacheState = firstText(input.cache_state, input.cacheState, timings.cache_state, timings.cacheState, timingMetrics.cache_state, timingMetrics.cacheState);
  const proofMaterial: Record<string, unknown> = {
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    projectId,
    editId,
    backend,
    classification,
    contractHash,
    artifactBeforeHash,
    artifactAfterHash,
    loaderEvent,
    epochPublishEvent,
    dispatchEvent,
    outputEvent,
    retirementEvent,
    processIdentity,
    deviceIdentity,
    oracleArtifacts,
    deterministicVisualMode,
    outputOracleTarget,
    metricClock,
    metricScope,
    cacheState,
    timings,
    timingMetrics,
    modelProvenance,
    evidenceRefs,
    cpuHmrUsed: cpuHmrUsed.value === true,
    fullRebuildUsed: fullRebuildUsed.value === true,
    processRestarted: processRestarted.value === true,
    firewallEvidence: {
      cpuHmrUsedEvidencePresent: cpuHmrUsed.present,
      fullRebuildUsedEvidencePresent: fullRebuildUsed.present,
      processRestartedEvidencePresent: processRestarted.present,
      processIdBefore: firewallPidBefore,
      processIdAfter: firewallPidAfter,
    },
  };
  if (proofCanonicalProfile === GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE) {
    proofMaterial.proofCanonicalProfile = proofCanonicalProfile;
    if (epochCommitEventPresent) proofMaterial.epochCommitEvent = epochCommitEvent;
  }
  const recomputedProofId = canonicalLedgerProofId(proofMaterial);
  const suppliedRecordProofId = firstText(input.proof_id, input.proofId);
  if (objectAliasMismatch(input, "proof_id", "proofId")) {
    failures.push({ code: "record_proof_id_alias_mismatch" });
  }
  if (suppliedRecordProofId && suppliedRecordProofId !== recomputedProofId) {
    failures.push({
      code: "record_proof_id_mismatch",
      suppliedProofId: suppliedRecordProofId,
      recomputedProofId,
    });
  }

  for (const [code, keys] of [
    ["project_id_alias_mismatch", ["project_id", "projectId"]],
    ["edit_id_alias_mismatch", ["edit_id", "editId"]],
    ["backend_alias_mismatch", ["backend", "gpu_backend", "gpuBackend"]],
    ["contract_hash_alias_mismatch", ["contract_hash", "contractHash"]],
    [
      "artifact_before_hash_alias_mismatch",
      ["artifact_before_hash", "artifactBeforeHash"],
    ],
    [
      "artifact_after_hash_alias_mismatch",
      [
        "artifact_after_hash",
        "artifactAfterHash",
        "changed_gpu_artifact_hash",
        "changedGpuArtifactHash",
      ],
    ],
    ["metric_clock_alias_mismatch", ["metric_clock", "metricClock"]],
    ["metric_scope_alias_mismatch", ["metric_scope", "metricScope"]],
    ["cache_state_alias_mismatch", ["cache_state", "cacheState"]],
    ["cpu_hmr_used_alias_mismatch", ["cpu_hmr_used", "cpuHmrUsed"]],
    ["full_rebuild_used_alias_mismatch", ["full_rebuild_used", "fullRebuildUsed"]],
    ["process_restarted_alias_mismatch", ["process_restarted", "processRestarted"]],
    ["record_success_alias_mismatch", ["gpu_hmr_success", "gpuHmrSuccess"]],
  ] as const) {
    if (aliasGroupMismatch(input, keys)) failures.push({ code });
  }
  for (const [code, leftKey, rightKey] of [
    ["loader_event_alias_mismatch", "loader_event", "loaderEvent"],
    ["output_event_alias_mismatch", "output_event", "outputEvent"],
    ["retirement_event_alias_mismatch", "retirement_event", "retirementEvent"],
    ["process_identity_alias_mismatch", "process_identity", "processIdentity"],
    ["device_identity_alias_mismatch", "device_identity", "deviceIdentity"],
    ["firewall_evidence_alias_mismatch", "firewall_evidence", "firewallEvidence"],
    ["oracle_artifacts_alias_mismatch", "oracle_artifacts", "oracleArtifacts"],
    [
      "deterministic_visual_mode_alias_mismatch",
      "deterministic_visual_mode",
      "deterministicVisualMode",
    ],
    ["output_oracle_target_alias_mismatch", "output_oracle_target", "outputOracleTarget"],
    ["timing_metrics_alias_mismatch", "timing_metrics", "timingMetrics"],
    ["model_provenance_alias_mismatch", "model_provenance", "modelProvenance"],
    ["evidence_refs_alias_mismatch", "evidence_refs", "evidenceRefs"],
  ] as const) {
    if (objectAliasMismatch(input, leftKey, rightKey)) failures.push({ code });
  }

  const nestedMetricClocks = [
    timings.metric_clock,
    timings.metricClock,
    timingMetrics.metric_clock,
    timingMetrics.metricClock,
    asObject(timings.clock_evidence).metric_clock,
    asObject(timings.clockEvidence).metricClock,
    asObject(timingMetrics.clock_evidence).metric_clock,
    asObject(timingMetrics.clockEvidence).metricClock,
  ].map(text).filter((clock): clock is string => clock !== null);
  if (
    topLevelMetricClock !== null
    && nestedMetricClocks.some((clock) => clock !== topLevelMetricClock)
  ) {
    failures.push({ code: "metric_clock_nested_contradiction" });
  }

  for (const [field, snakeKey, camelKey, invalidCode] of [
    ["cpu_hmr_used", "cpu_hmr_used", "cpuHmrUsed", "cpu_hmr_firewall_evidence_invalid"],
    [
      "full_rebuild_used",
      "full_rebuild_used",
      "fullRebuildUsed",
      "full_rebuild_firewall_evidence_invalid",
    ],
    [
      "process_restarted",
      "process_restarted",
      "processRestarted",
      "process_restart_firewall_evidence_invalid",
    ],
  ] as const) {
    const topValues = aliasGroupValues([[input, [snakeKey, camelKey]]]);
    const nestedValues = aliasGroupValues([[firewallEvidence, [snakeKey, camelKey]]]);
    if (aliasValuesMismatch(nestedValues)) {
      failures.push({ code: `firewall_${field}_alias_mismatch` });
    }
    if (
      topValues.length > 0
      && nestedValues.length > 0
      && stableJson(topValues[0]) !== stableJson(nestedValues[0])
    ) {
      failures.push({ code: `firewall_${field}_contradiction` });
    }
    if ([...topValues, ...nestedValues].some((value) => typeof value !== "boolean")) {
      failures.push({ code: invalidCode });
    }
  }
  if (eventFieldAliasMismatch(firewallEvidence)) {
    failures.push({ code: "firewall_evidence_field_alias_mismatch" });
  }
  for (const [code, keys] of [
    [
      "firewall_process_id_before_alias_mismatch",
      ["process_id_before", "processIdBefore", "firewall_process_id_before", "firewallProcessIdBefore"],
    ],
    [
      "firewall_process_id_after_alias_mismatch",
      ["process_id_after", "processIdAfter", "firewall_process_id_after", "firewallProcessIdAfter"],
    ],
  ] as const) {
    if (aliasGroupMismatch(firewallEvidence, keys)) failures.push({ code });
  }

  const outputOracle = outputOracleObject(outputEvent);
  const outputSuccessKeys = [
    "passed", "success", "succeeded", "accepted", "gpu_hmr_success", "gpuHmrSuccess",
  ];
  const outputSuccessValues = aliasGroupValues([[outputEvent, outputSuccessKeys]]);
  const oracleSuccessValues = aliasGroupValues([[outputOracle, outputSuccessKeys]]);
  if (
    outputSuccessValues.length > 0
    && oracleSuccessValues.length > 0
    && stableJson(outputSuccessValues[0]) !== stableJson(oracleSuccessValues[0])
  ) {
    failures.push({ code: "output_event_success_contradiction" });
  }

  if (proofCanonicalProfileAliasMismatch) {
    failures.push({ code: "proof_canonical_profile_alias_mismatch" });
  }
  if (epochCommitEventAliasMismatch) {
    failures.push({ code: "epoch_commit_event_alias_mismatch" });
  }
  if (epochPublishEventAliasMismatch) {
    failures.push({ code: "epoch_publish_event_alias_mismatch" });
  }
  if (dispatchEventAliasMismatch) {
    failures.push({ code: "dispatch_event_alias_mismatch" });
  }

  const publishEventKind = firstText(
    epochPublishEvent.event,
    epochPublishEvent.event_kind,
    epochPublishEvent.eventKind,
    epochPublishEvent.kind
  );
  const commitEventKind = firstText(
    epochCommitEvent.event,
    epochCommitEvent.event_kind,
    epochCommitEvent.eventKind,
    epochCommitEvent.kind
  );
  const publicationId = firstText(
    epochPublishEvent.publication_id,
    epochPublishEvent.publicationId
  );
  const commitPublicationId = firstText(
    epochCommitEvent.publication_id,
    epochCommitEvent.publicationId
  );
  const dispatchPublicationId = firstText(
    dispatchEvent.publication_id,
    dispatchEvent.publicationId
  );
  const candidateRegistrationId = firstText(
    epochPublishEvent.candidate_registration_id,
    epochPublishEvent.candidateRegistrationId
  );
  const commitCandidateRegistrationId = firstText(
    epochCommitEvent.candidate_registration_id,
    epochCommitEvent.candidateRegistrationId
  );
  const dispatchRegistrationId = firstText(
    dispatchEvent.dispatcher_registration_id,
    dispatchEvent.dispatcherRegistrationId
  );
  const commitEraRecord =
    proofCanonicalProfile !== null
    || epochCommitEventPresent
    || publishEventKind === "provisional_install"
    || publicationId !== null
    || candidateRegistrationId !== null
    || dispatchPublicationId !== null
    || dispatchRegistrationId !== null;
  if (
    proofCanonicalProfile !== null
    && proofCanonicalProfile !== GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE
  ) {
    failures.push({
      code: "proof_canonical_profile_unsupported",
      proofCanonicalProfile,
    });
  }
  if (commitEraRecord) {
    if (!portableCanonicalJsonNumbersSupported(input)) {
      failures.push({ code: "portable_canonical_number_unsupported" });
    }
    if (deepSnakeCamelAliasMismatch(input)) {
      failures.push({ code: "portable_canonical_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(loaderEvent)) {
      failures.push({ code: "loader_event_field_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(epochPublishEvent)) {
      failures.push({ code: "epoch_publish_event_field_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(epochCommitEvent)) {
      failures.push({ code: "epoch_commit_event_field_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(dispatchEvent, "dispatch")) {
      failures.push({ code: "dispatch_event_field_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(outputEvent, "output")) {
      failures.push({ code: "output_event_field_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(retirementEvent, "retirement")) {
      failures.push({ code: "retirement_event_field_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(processIdentity)) {
      failures.push({ code: "process_identity_field_alias_mismatch" });
    }
    if (eventFieldAliasMismatch(deviceIdentity)) {
      failures.push({ code: "device_identity_field_alias_mismatch" });
    }
    const portableTimestampEvents = [
      ["loader", loaderEvent],
      ["epoch_publish", epochPublishEvent],
      ["dispatch", dispatchEvent],
      ["output", outputEvent],
      ["epoch_commit", epochCommitEvent],
      ["retirement", retirementEvent],
    ] as const;
    const invalidPortableTimestampEvents = portableTimestampEvents
      .filter(([, event]) => portableMonotonicTimestamp(event) === null)
      .map(([name]) => name);
    if (invalidPortableTimestampEvents.length > 0) {
      failures.push({
        code: "portable_event_timestamp_invalid",
        events: invalidPortableTimestampEvents,
      });
    }
    if (proofCanonicalProfile !== GPU_HMR_PROOF_LEDGER_PORTABLE_CANONICAL_PROFILE) {
      failures.push({ code: "epoch_commit_canonical_profile_missing" });
    }
    if (!epochCommitEventPresent || Object.keys(epochCommitEvent).length === 0) {
      failures.push({ code: "epoch_commit_event_missing" });
    }
    if (publishEventKind !== "provisional_install") {
      failures.push({ code: "epoch_publish_event_not_provisional" });
    }
    if (commitEventKind !== "unrestricted_visibility_commit") {
      failures.push({ code: "epoch_commit_event_kind_invalid" });
    }
    if (!eventId(epochCommitEvent)) failures.push({ code: "epoch_commit_event_id_missing" });
    if (!publicationId) failures.push({ code: "epoch_publication_id_missing" });
    if (!candidateRegistrationId) {
      failures.push({ code: "epoch_candidate_registration_id_missing" });
    }
    if (publicationId && commitPublicationId !== publicationId) {
      failures.push({ code: "epoch_commit_publication_id_mismatch" });
    }
    if (publicationId && dispatchPublicationId !== publicationId) {
      failures.push({ code: "dispatch_publication_id_mismatch" });
    }
    if (
      candidateRegistrationId
      && commitCandidateRegistrationId !== candidateRegistrationId
    ) {
      failures.push({ code: "epoch_commit_candidate_registration_id_mismatch" });
    }
    if (candidateRegistrationId && dispatchRegistrationId !== candidateRegistrationId) {
      failures.push({ code: "dispatch_registration_id_mismatch" });
    }
    const commitArtifactHash = eventArtifactHash(epochCommitEvent);
    if (!commitArtifactHash) {
      failures.push({ code: "epoch_commit_artifact_hash_missing" });
    } else if (artifactAfterHash && commitArtifactHash !== artifactAfterHash) {
      failures.push({ code: "epoch_commit_artifact_hash_mismatch" });
    }
    const rawCandidateEpoch = epochPublishEvent.epoch
      ?? epochPublishEvent.epoch_id
      ?? epochPublishEvent.epochId
      ?? epochPublishEvent.generation;
    const rawPreviousEpoch = epochPublishEvent.previous_epoch ?? epochPublishEvent.previousEpoch;
    const rawCommitEpoch = epochCommitEvent.epoch
      ?? epochCommitEvent.epoch_id
      ?? epochCommitEvent.epochId
      ?? epochCommitEvent.generation;
    const rawCommitPreviousEpoch =
      epochCommitEvent.previous_epoch ?? epochCommitEvent.previousEpoch;
    const rawDispatchEpoch = dispatchEvent.epoch
      ?? dispatchEvent.epoch_id
      ?? dispatchEvent.epochId
      ?? dispatchEvent.generation;
    const rawOutputEpoch = outputEvent.epoch
      ?? outputEvent.epoch_id
      ?? outputEvent.epochId
      ?? outputEvent.generation;
    const rawRetirementEpoch = retirementEvent.epoch
      ?? retirementEvent.epoch_id
      ?? retirementEvent.epochId
      ?? retirementEvent.generation;
    const candidateEpoch = canonicalDecimalEpoch(rawCandidateEpoch);
    const canonicalPreviousEpoch = canonicalDecimalEpoch(rawPreviousEpoch);
    const commitEpoch = canonicalDecimalEpoch(rawCommitEpoch);
    const canonicalCommitPreviousEpoch = canonicalDecimalEpoch(rawCommitPreviousEpoch);
    const canonicalDispatchEpoch = canonicalDecimalEpoch(rawDispatchEpoch);
    const canonicalOutputEpoch = canonicalDecimalEpoch(rawOutputEpoch);
    const retirementEpoch = canonicalDecimalEpoch(rawRetirementEpoch);
    const nonCanonicalEpochs = [
      ["previous_epoch", rawPreviousEpoch],
      ["published_epoch", rawCandidateEpoch],
      ["commit_epoch", rawCommitEpoch],
      ["commit_previous_epoch", rawCommitPreviousEpoch],
      ["dispatch_epoch", rawDispatchEpoch],
      ["output_epoch", rawOutputEpoch],
      ["retirement_epoch", rawRetirementEpoch],
    ].filter(([, epoch]) => epoch !== undefined && epoch !== null
      && canonicalDecimalEpoch(epoch) === null)
      .map(([field, epoch]) => ({ field, epoch }));
    if (nonCanonicalEpochs.length > 0) {
      failures.push({ code: "epoch_generation_not_canonical_decimal", fields: nonCanonicalEpochs });
    }
    if (commitEpoch && candidateEpoch && commitEpoch !== candidateEpoch) {
      failures.push({ code: "epoch_commit_epoch_mismatch" });
    }
    if (
      rawPreviousEpoch !== undefined
      && rawCandidateEpoch !== undefined
      && (
        canonicalPreviousEpoch === null
        || candidateEpoch === null
        || BigInt(candidateEpoch) <= BigInt(canonicalPreviousEpoch)
      )
    ) {
      failures.push({
        code: "epoch_generation_transition_not_forward",
        previousEpoch: rawPreviousEpoch,
        candidateEpoch: rawCandidateEpoch,
      });
    }
    if (
      canonicalPreviousEpoch
      && canonicalCommitPreviousEpoch !== canonicalPreviousEpoch
    ) {
      failures.push({ code: "epoch_commit_previous_epoch_mismatch" });
    }
    if (candidateEpoch && canonicalDispatchEpoch !== candidateEpoch) {
      failures.push({ code: "dispatch_epoch_mismatch" });
    }
    if (candidateEpoch && canonicalOutputEpoch !== candidateEpoch) {
      failures.push({ code: "output_epoch_mismatch" });
    }
    if (canonicalPreviousEpoch && retirementEpoch !== canonicalPreviousEpoch) {
      failures.push({ code: "retirement_epoch_mismatch" });
    }
    const retirementArtifactHash = eventArtifactHash(retirementEvent);
    if (!retirementArtifactHash) {
      failures.push({ code: "retirement_artifact_hash_missing" });
    } else if (artifactBeforeHash && retirementArtifactHash !== artifactBeforeHash) {
      failures.push({ code: "retirement_artifact_hash_mismatch" });
    }
    const retirementStatus = firstText(
      retirementEvent.status,
      retirementEvent.result,
      retirementEvent.retirement_result,
      retirementEvent.retirementResult
    );
    const retirementProof = firstText(
      retirementEvent.proof,
      retirementEvent.retirement_proof,
      retirementEvent.retirementProof
    );
    if (!RECOGNIZED_RETIREMENT_PROOFS.has(retirementProof ?? "")) {
      failures.push({ code: "retirement_proof_not_successful", retirementProof });
    }
    if (!RECOGNIZED_RETIREMENT_RESULTS.has(retirementStatus ?? "")) {
      failures.push({ code: "retirement_result_not_successful", retirementResult: retirementStatus });
    }
    const commitPid = eventProcessId(epochCommitEvent);
    const retirementPid = eventProcessId(retirementEvent);
    if (!commitPid) failures.push({ code: "epoch_commit_process_identity_missing" });
    else if (identityPid && commitPid !== identityPid) {
      failures.push({ code: "epoch_commit_process_identity_mismatch" });
    }
    if (!retirementPid) failures.push({ code: "retirement_process_identity_missing" });
    else if (identityPid && retirementPid !== identityPid) {
      failures.push({ code: "retirement_process_identity_mismatch" });
    }
    const commitTs = eventTimestamp(epochCommitEvent);
    if (commitTs === null) failures.push({ code: "epoch_commit_timestamp_missing" });
    if (outputTs !== null && commitTs !== null && commitTs < outputTs) {
      failures.push({ code: "epoch_commit_precedes_output" });
    }
    if (commitTs !== null && retirementTs !== null && retirementTs < commitTs) {
      failures.push({ code: "retirement_precedes_epoch_commit" });
    }
    if (publicationId && !evidenceRefs.includes(`dispatcher-publication:${publicationId}`)) {
      failures.push({ code: "epoch_publication_evidence_ref_missing" });
    }
    if (
      candidateRegistrationId
      && !evidenceRefs.includes(`dispatcher-registration:${candidateRegistrationId}`)
    ) {
      failures.push({ code: "epoch_registration_evidence_ref_missing" });
    }
  }

  if (!projectId) failures.push({ code: "project_id_missing" });
  if (!editId) failures.push({ code: "edit_id_missing" });
  if (!backend) failures.push({ code: "backend_missing" });
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
  if (firewallPidBefore && firewallPidAfter && firewallPidBefore !== firewallPidAfter) {
    failures.push({
      code: "firewall_process_identity_contradiction",
      processIdBefore: firewallPidBefore,
      processIdAfter: firewallPidAfter,
    });
  }
  if (identityPid) {
    if (firewallPidBefore && firewallPidBefore !== identityPid) {
      failures.push({
        code: "firewall_process_identity_before_mismatch",
        processIdBefore: firewallPidBefore,
        processIdentity: identityPid,
      });
    }
    if (firewallPidAfter && firewallPidAfter !== identityPid) {
      failures.push({
        code: "firewall_process_identity_after_mismatch",
        processIdAfter: firewallPidAfter,
        processIdentity: identityPid,
      });
    }
  }
  if (!contractHash) failures.push({ code: "contract_hash_missing" });
  if (!artifactBeforeHash) failures.push({ code: "artifact_before_hash_missing" });
  if (!artifactAfterHash) failures.push({ code: "artifact_after_hash_missing" });
  if (artifactBeforeHash && artifactAfterHash && artifactBeforeHash === artifactAfterHash) {
    failures.push({ code: "artifact_hash_unchanged" });
  }
  if (!loadedArtifactHash || (artifactAfterHash && loadedArtifactHash !== artifactAfterHash)) {
    failures.push({ code: loadedArtifactHash ? "loader_artifact_hash_mismatch" : "loader_artifact_hash_missing" });
  }
  if (!loaderId) failures.push({ code: "loader_event_id_missing" });
  if (loaderTs === null) failures.push({ code: "loader_timestamp_missing" });
  if (!publishedArtifactHash || (artifactAfterHash && publishedArtifactHash !== artifactAfterHash)) {
    failures.push({ code: publishedArtifactHash ? "epoch_publish_artifact_hash_mismatch" : "epoch_publish_artifact_hash_missing" });
  }
  if (!epochPublishId) failures.push({ code: "epoch_publish_event_id_missing" });
  if (!publishedEpoch) failures.push({ code: "epoch_publish_id_missing" });
  if (publishTs === null) failures.push({ code: "epoch_publish_timestamp_missing" });
  if (loaderTs !== null && publishTs !== null && publishTs < loaderTs) {
    failures.push({ code: "epoch_publish_precedes_loader" });
  }
  if (!dispatchEpoch || (publishedEpoch && dispatchEpoch !== publishedEpoch)) {
    failures.push({ code: dispatchEpoch ? "dispatch_epoch_mismatch" : "dispatch_epoch_missing" });
  }
  if (!dispatchId) failures.push({ code: "dispatch_id_missing" });
  if (!dispatchArtifactHash || (artifactAfterHash && dispatchArtifactHash !== artifactAfterHash)) {
    failures.push({ code: dispatchArtifactHash ? "dispatch_artifact_hash_mismatch" : "dispatch_artifact_hash_missing" });
  }
  if (dispatchTs === null) failures.push({ code: "dispatch_timestamp_missing" });
  if (publishTs !== null && dispatchTs !== null && dispatchTs < publishTs) {
    failures.push({ code: "dispatch_precedes_epoch_publish" });
  }
  if (!outputDispatchId || (dispatchId && outputDispatchId !== dispatchId)) {
    failures.push({ code: outputDispatchId ? "output_after_dispatch_id_mismatch" : "output_after_dispatch_id_missing" });
  }
  if (!outputId) failures.push({ code: "output_event_id_missing" });
  if (outputEvent.passed !== true) failures.push({ code: "output_oracle_not_passed" });
  const outputOracleKind = outputKind(outputEvent);
  if (!outputOracleKind) failures.push({ code: "output_oracle_kind_missing" });
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
  else {
    if (!retirementId) failures.push({ code: "retirement_event_id_missing" });
    if (retirementTs === null) failures.push({ code: "retirement_timestamp_missing" });
    if (outputTs !== null && retirementTs !== null && retirementTs < outputTs) {
      failures.push({ code: "retirement_precedes_output" });
    }
    if (!firstText(retirementEvent.status, retirementEvent.proof, retirementEvent.retirement_proof, retirementEvent.retirementProof)) {
      failures.push({ code: "retirement_proof_missing" });
    }
  }
  const visualArtifacts = visualOracleArtifacts(oracleArtifacts, outputEvent);
  const computeArtifacts = computeOracleArtifacts(oracleArtifacts, outputEvent);
  const targetModality = outputOracleTargetModality(outputOracleTarget);
  const targetId = outputOracleTargetId(outputOracleTarget);
  const observedTargetId = outputEventTargetId(outputEvent);
  const targetEvidenceRefs = outputOracleTargetEvidenceRefs(outputOracleTarget);
  const unresolvedTargetEvidenceRefs = targetEvidenceRefs.filter(
    (evidenceRef) => !evidenceRefs.includes(evidenceRef)
  );
  const verifierAvailable = targetModality === "visual" || targetModality === "compute";
  const visualOutput = targetModality === "visual";
  if (!targetModality) {
    failures.push({ code: "output_oracle_target_modality_missing" });
  } else {
    if (!verifierAvailable) {
      failures.push({ code: "output_oracle_target_verifier_missing", targetModality });
    } else if (targetModality === "visual" && visualArtifacts === null) {
      failures.push({ code: "visual_output_target_requires_visual_oracle" });
    } else if (targetModality === "compute" && computeArtifacts === null) {
      failures.push({ code: "compute_output_target_requires_compute_oracle" });
    }
  }
  if (!targetId) failures.push({ code: "output_oracle_target_id_missing" });
  if (!observedTargetId) {
    failures.push({ code: "output_event_target_id_missing" });
  } else if (targetId && observedTargetId !== targetId) {
    failures.push({
      code: "output_oracle_target_id_mismatch",
      expected: targetId,
      actual: observedTargetId,
    });
  }
  if (targetEvidenceRefs.length === 0) {
    failures.push({ code: "output_oracle_target_evidence_refs_missing" });
  } else if (unresolvedTargetEvidenceRefs.length > 0) {
    failures.push({
      code: "output_oracle_target_evidence_refs_unresolved",
      unresolvedEvidenceRefs: unresolvedTargetEvidenceRefs,
    });
  }
  if (visualOutput) {
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
      const pixelVerification = visualPixelVerification(visualArtifacts);
      const pixelMetricsVerified = visualVerifiedBool(
        visualArtifacts,
        pixelVerification,
        ["pixel_metrics_verified", "pixelMetricsVerified"],
        ["metrics_verified", "metricsVerified", "pixel_metrics_verified", "pixelMetricsVerified"]
      );
      if (!pixelMetricsVerified) {
        failures.push({ code: "visual_pixel_metrics_unverified" });
      }
      const beforeHash = visualArtifactHash(
        visualArtifacts,
        pixelVerification,
        ["before_image_hash", "beforeImageHash"],
        ["before_image_hash", "beforeImageHash"]
      );
      const afterHash = visualArtifactHash(
        visualArtifacts,
        pixelVerification,
        ["after_image_hash", "afterImageHash"],
        ["after_image_hash", "afterImageHash"]
      );
      const diffHash = visualArtifactHash(
        visualArtifacts,
        pixelVerification,
        ["diff_image_hash", "diffImageHash"],
        ["diff_image_hash", "diffImageHash"]
      );
      if (!beforeHash) failures.push({ code: "visual_before_image_hash_missing" });
      else if (!computeSha256Digest(beforeHash)) failures.push({ code: "visual_before_image_hash_invalid" });
      if (!afterHash) failures.push({ code: "visual_after_image_hash_missing" });
      else if (!computeSha256Digest(afterHash)) failures.push({ code: "visual_after_image_hash_invalid" });
      if (!diffHash) failures.push({ code: "visual_diff_image_hash_missing" });
      else if (!computeSha256Digest(diffHash)) failures.push({ code: "visual_diff_image_hash_invalid" });
      if (beforeHash && afterHash && beforeHash === afterHash) {
        failures.push({ code: "visual_before_after_same_frame_hash" });
      }
      if (!visualVerifiedBool(
        visualArtifacts,
        pixelVerification,
        ["before_image_hash_verified", "beforeImageHashVerified"],
        ["before_image_hash_verified", "beforeImageHashVerified"]
      )) {
        failures.push({ code: "visual_before_image_hash_unverified" });
      }
      if (!visualVerifiedBool(
        visualArtifacts,
        pixelVerification,
        ["after_image_hash_verified", "afterImageHashVerified"],
        ["after_image_hash_verified", "afterImageHashVerified"]
      )) {
        failures.push({ code: "visual_after_image_hash_unverified" });
      }
      if (!visualVerifiedBool(
        visualArtifacts,
        pixelVerification,
        ["diff_image_hash_verified", "diffImageHashVerified"],
        ["diff_image_hash_verified", "diffImageHashVerified"]
      )) {
        failures.push({ code: "visual_diff_image_hash_unverified" });
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
    const deterministicFailures = deterministicVisualFailures({
      ...deterministicVisualMode,
      artifact_hash_after: artifactAfterHash,
    });
    if (deterministicFailures.length > 0) {
      failures.push({ code: "visual_output_without_deterministic_mode" }, ...deterministicFailures);
    }
    failures.push({ code: "verifier_owned_output_observation_receipt_missing" });
    failures.push({ code: "verifier_owned_visual_output_state_receipt_missing" });
  } else {
    if (computeArtifacts === null) {
      failures.push({ code: "compute_oracle_artifacts_missing" });
    } else {
      const missingFields = missingArtifactFields(computeArtifacts, COMPUTE_ORACLE_ARTIFACT_FIELDS);
      if (missingFields.length > 0) {
        failures.push({ code: "compute_oracle_artifacts_incomplete", missingFields });
      }
      const checksumBefore = artifactText(computeArtifacts, "checksum_before", "checksumBefore");
      const checksumAfter = artifactText(computeArtifacts, "checksum_after", "checksumAfter");
      const rawReadbackSource = (computeRawReadbackSource(computeArtifacts) ?? "").trim().toLowerCase();
      const rawReadbackHash = computeRawReadbackHash(computeArtifacts);
      const byteVerification = computeByteVerification(computeArtifacts);
      const rawReadbackByteLength = computeReadbackByteLength(computeArtifacts, byteVerification);
      const rawReadbackHashVerified = computeVerifiedBool(
        computeArtifacts,
        byteVerification,
        ["raw_readback_hash_verified", "rawReadbackHashVerified"],
        ["hash_verified", "hashVerified", "raw_readback_hash_verified", "rawReadbackHashVerified"]
      );
      const deterministicSlice = computeDeterministicSlice(computeArtifacts);
      const deterministicSliceOffset = artifactNumber(deterministicSlice, "offset", "byte_offset", "byteOffset");
      const deterministicSliceLength = artifactNumber(deterministicSlice, "length", "byte_length", "byteLength");
      const deterministicSliceHash = computeDeterministicSliceHash(
        computeArtifacts,
        deterministicSlice,
        byteVerification
      );
      const deterministicSliceHashVerified = computeVerifiedBool(
        computeArtifacts,
        byteVerification,
        ["deterministic_slice_hash_verified", "deterministicSliceHashVerified"],
        ["deterministic_slice_hash_verified", "deterministicSliceHashVerified", "slice_hash_verified", "sliceHashVerified"]
      );
      if (!rawReadbackHash) {
        failures.push({ code: "compute_oracle_raw_readback_unproven" });
      } else if (!computeSha256Digest(rawReadbackHash)) {
        failures.push({ code: "compute_oracle_raw_readback_hash_invalid" });
      }
      if (!rawReadbackHashVerified) {
        failures.push({ code: "compute_oracle_raw_readback_hash_unverified" });
      }
      if (rawReadbackByteLength === null || rawReadbackByteLength <= 0) {
        failures.push({ code: "compute_oracle_raw_readback_bytes_missing" });
      }
      if (deterministicSliceOffset === null || deterministicSliceLength === null || deterministicSliceLength <= 0) {
        failures.push({ code: "compute_oracle_deterministic_slice_bounds_missing" });
      } else if (
        rawReadbackByteLength !== null
        && rawReadbackByteLength > 0
        && deterministicSliceOffset + deterministicSliceLength > rawReadbackByteLength
      ) {
        failures.push({ code: "compute_oracle_deterministic_slice_out_of_bounds" });
      }
      if (!deterministicSliceHash) {
        failures.push({ code: "compute_oracle_deterministic_slice_hash_missing" });
      } else if (!computeSha256Digest(deterministicSliceHash)) {
        failures.push({ code: "compute_oracle_deterministic_slice_hash_invalid" });
      }
      if (!deterministicSliceHashVerified) {
        failures.push({ code: "compute_oracle_deterministic_slice_hash_unverified" });
      }
      if (
        DIGEST_DERIVED_COMPUTE_RAW_READBACK_SOURCES.has(rawReadbackSource)
        || /digest/.test(rawReadbackSource)
      ) {
        failures.push({ code: "compute_oracle_raw_readback_digest_derived" });
      } else if (!ACCEPTED_COMPUTE_RAW_READBACK_SOURCES.has(rawReadbackSource)) {
        failures.push({ code: "compute_oracle_raw_readback_source_unaccepted" });
      }
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
    const availabilitySource = modelAvailabilitySource(model);
    if (!availabilitySource || availabilitySource === "provider_not_checked") {
      failures.push({
        code: "model_availability_source_untrusted",
        record: prefix,
        model_availability_source: availabilitySource,
      });
    }
    const availabilityBasis = modelAvailabilityBasis(model);
    if (!MODEL_AVAILABILITY_BASES.has(availabilityBasis ?? "")) {
      failures.push({
        code: "model_availability_basis_not_accepted",
        record: prefix,
        model_availability_basis: availabilityBasis,
      });
    }
    if (status === "private_alias" && !["private_alias_env", "live_model_list_registry_override"].includes(availabilityBasis ?? "")) {
      failures.push({
        code: "model_private_alias_basis_unproven",
        record: prefix,
        model_availability_basis: availabilityBasis,
      });
    }
    const role = requiredModelRole(models[index]!);
    if (role) {
      const expected = modelPolicy.roles[role];
      const provider = modelFieldText(model, "provider", "provider", modelPolicy);
      if (!expected?.provider || !expected?.model) {
        failures.push({
          code: "model_role_policy_missing",
          record: prefix,
          request_mode: role,
        });
        continue;
      }
      if (provider !== expected.provider) {
        failures.push({
          code: "model_provider_not_allowed",
          record: prefix,
          request_mode: role,
          provider,
          expected_provider: expected.provider,
        });
      }
      const expectedModel = expected.model;
      const modelMatch = modelMatchesRequiredModel(model, expectedModel);
      if (modelMatch.status === "private_alias" && !modelMatch.aliasResolvedTo) {
        failures.push({
          code: "model_private_alias_unresolved",
          record: prefix,
          request_mode: role,
          expected_model: expectedModel,
        });
      }
      if (!modelMatch.requestedMatches) {
        failures.push({
          code: "model_requested_model_unexpected",
          record: prefix,
          request_mode: role,
          requested_model: modelMatch.requestedModel,
          provider_model_alias_resolved_to: modelMatch.aliasResolvedTo,
          expected_model: expectedModel,
        });
      }
      if (!modelMatch.actualMatches) {
        failures.push({
          code: "model_actual_model_unexpected",
          record: prefix,
          request_mode: role,
          actual_model: modelMatch.actualModel,
          provider_model_alias_resolved_to: modelMatch.aliasResolvedTo,
          expected_model: expectedModel,
        });
      }
    }
    if (modelHardInfraFailure(model)) failures.push({ code: "model_hard_infra_failure", record: prefix });
    if (modelRoleIsGpuDelta(models[index]!) && modelFallbackUsed(model)) {
      failures.push({ code: "gpu_delta_model_fallback_used", record: prefix });
    }
    if (modelFallbackUsed(model)) {
      for (const [snakeKey, camelKey, code] of [
        ["actual_provider_model_status", "actualProviderModelStatus", "actual_provider_model_status_missing"],
        ["actual_model_availability_checked_at", "actualModelAvailabilityCheckedAt", "actual_model_availability_checked_at_missing"],
        ["actual_model_availability_basis", "actualModelAvailabilityBasis", "actual_model_availability_basis_missing"],
        ["fallback_provider_model_status", "fallbackProviderModelStatus", "fallback_provider_model_status_missing"],
        ["fallback_model_availability_checked_at", "fallbackModelAvailabilityCheckedAt", "fallback_model_availability_checked_at_missing"],
        ["fallback_model_availability_basis", "fallbackModelAvailabilityBasis", "fallback_model_availability_basis_missing"],
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
    proofId: recomputedProofId,
    gpuHmrSuccess: failures.length === 0,
    failedInvariants: failures,
  };
}

export function queryGpuHmrLedgerInvariants(input: unknown): GpuHmrLedgerValidation {
  const ledger = asObject(input);
  const ledgerModelPolicy = resolveGpuHmrModelPolicy(ledger.modelPolicy, ledger.model_policy);
  const recordsFieldPresent = hasOwn(ledger, "records");
  const records = Array.isArray(ledger.records) ? ledger.records : null;
  const ledgerSchema = exactSchemaVersion(ledger);
  const invalidRecordValidation = (code: string): GpuHmrLedgerValidation => ({
    schemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    proofId: null,
    gpuHmrSuccess: false,
    failedInvariants: [{ code }],
  });
  const validations = recordsFieldPresent
    ? records && records.length > 0
      ? records.map((record, index) => ({
          index,
          result: isObject(record)
            ? validateRecord(
                {
                  modelPolicy: ledgerModelPolicy,
                  ...record,
                }
              )
            : invalidRecordValidation("ledger_record_not_object"),
        }))
      : [{ index: 0, result: invalidRecordValidation("ledger_record_unavailable") }]
    : [{
        index: 0,
        result: validateRecord({ modelPolicy: ledgerModelPolicy, ...ledger }),
      }];
  const recomputed = validations[validations.length - 1]!.result;
  const proofId = recordsFieldPresent && records && records.length > 0
    ? canonicalLedgerRootProofId(validations.map(({ result }) => result.proofId))
    : recomputed.proofId;
  const failures: GpuHmrLedgerFailure[] = validations.flatMap(({ index, result }) =>
    result.failedInvariants.map((failure) => ({
      ...failure,
      record_index: failure.record_index ?? index,
    }))
  );
  if (recordsFieldPresent) {
    if (ledgerSchema.aliasMismatch) failures.push({ code: "ledger_schema_alias_mismatch" });
    if (!ledgerSchema.present || !ledgerSchema.value) {
      failures.push({ code: "ledger_schema_version_missing" });
    } else if (!ledgerSchema.exact) {
      failures.push({
        code: "ledger_schema_version_mismatch",
        suppliedSchemaVersion: ledgerSchema.value,
        expectedSchemaVersion: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
      });
    }
  }
  if (recordsFieldPresent && records === null) {
    failures.push({ code: "ledger_records_not_array" });
  } else if (records && records.length === 0) {
    failures.push({ code: "ledger_records_empty" });
  }
  if (records && records.length > 1) {
    const proofIdIndexes = new Map<string, number[]>();
    for (const { index, result } of validations) {
      if (!result.proofId) continue;
      const indexes = proofIdIndexes.get(result.proofId) ?? [];
      indexes.push(index);
      proofIdIndexes.set(result.proofId, indexes);
    }
    const duplicates = [...proofIdIndexes.entries()]
      .filter(([, indexes]) => indexes.length > 1)
      .map(([recordProofId, recordIndexes]) => ({ recordProofId, recordIndexes }));
    if (duplicates.length > 0) {
      failures.push({ code: "ledger_record_proof_ids_duplicate", duplicates });
    }
  }
  if (objectAliasMismatch(ledger, "proof_id", "proofId")) {
    failures.push({ code: "ledger_proof_id_alias_mismatch" });
  }
  const topLevelProofId = firstText(ledger.proofId, ledger.proof_id);
  if (topLevelProofId && topLevelProofId !== proofId) {
    failures.push({ code: "ledger_proof_id_mismatch", suppliedProofId: topLevelProofId, recomputedProofId: proofId });
  }
  const recordSuccess = failures.length === 0;
  if (objectAliasMismatch(ledger, "gpu_hmr_success", "gpuHmrSuccess")) {
    failures.push({ code: "ledger_success_flag_alias_mismatch" });
  }
  const successFlag = firstPresent([ledger, "gpuHmrSuccess"], [ledger, "gpu_hmr_success"]);
  if (
    successFlag.present
    && (typeof successFlag.value !== "boolean" || successFlag.value !== recordSuccess)
  ) {
    failures.push({ code: "ledger_success_flag_mismatch" });
  }
  const suppliedQuery = asObject(ledger.query);
  if (Object.keys(suppliedQuery).length > 0) {
    if (objectAliasMismatch(suppliedQuery, "proof_id", "proofId")) {
      failures.push({ code: "supplied_ledger_query_proof_id_alias_mismatch" });
    }
    const suppliedQuerySchema = exactSchemaVersion(suppliedQuery);
    if (suppliedQuerySchema.aliasMismatch) {
      failures.push({ code: "supplied_ledger_query_schema_alias_mismatch" });
    }
    if (objectAliasMismatch(suppliedQuery, "gpu_hmr_success", "gpuHmrSuccess")) {
      failures.push({ code: "supplied_ledger_query_success_alias_mismatch" });
    }
    if (!suppliedQuerySchema.exact) {
      failures.push({ code: "supplied_ledger_query_schema_mismatch" });
    } else {
      const suppliedFailures = compactStringList(
        Array.isArray(suppliedQuery.failedInvariants)
          ? suppliedQuery.failedInvariants.map((failure) => isObject(failure) ? failure.code : null)
          : []
      ).sort();
      const recomputedFailures = failures.map((failure) => failure.code).sort();
      const suppliedQuerySuccess = firstPresent(
        [suppliedQuery, "gpuHmrSuccess"],
        [suppliedQuery, "gpu_hmr_success"]
      );
      if (
        !suppliedQuerySuccess.present
        || typeof suppliedQuerySuccess.value !== "boolean"
        || suppliedQuerySuccess.value !== recordSuccess
        || firstText(suppliedQuery.proofId, suppliedQuery.proof_id) !== proofId
        || suppliedFailures.join("|") !== recomputedFailures.join("|")
      ) {
        failures.push({ code: "supplied_ledger_query_mismatch" });
      }
    }
  }
  return {
    ...recomputed,
    proofId,
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
