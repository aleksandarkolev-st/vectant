import { createHash } from 'node:crypto';

export const GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION = 'synthi.gpu_hmr.contract.v1';

const BACKENDS = new Set(['hip', 'hiprt', 'opencl', 'vulkan', 'webgpu', 'bevy_wgsl', 'cuda', 'sycl', 'unknown']);
const PROJECT_KINDS = new Set(['cpu_project', 'gpu_project', 'mixed_project', 'unknown']);
const EDIT_KINDS = new Set(['gpu_artifact_edit', 'host_only', 'mixed_host_gpu', 'build_system', 'config', 'unknown']);
const ROUTES = new Set(['gpu_hmr', 'cpu_hmr_or_host_reload', 'full_rebuild_required', 'reject']);
const ABI_CLASSES = new Set(['compatible', 'additive', 'layout_changed', 'unknown']);
const RELOAD_MECHANISMS = new Set(['built_in', 'generated_adapter', 'api_interpose', 'engine_asset_reload', 'unsupported']);
const ADAPTER_OUTCOMES = new Set([
  'adapter_generated',
  'adapter_not_needed_builtin_reload',
  'adapter_impossible_requires_app_hook',
]);
const FAILURE_MODES = new Set(['reject', 'gpu_hmr_unsupported', 'full_rebuild_required']);
const ARTIFACT_KINDS = new Set([
  'hsaco',
  'hip_source_bridge',
  'spirv',
  'wgsl',
  'glsl',
  'opencl_program',
  'cuda_cubin',
  'cuda_ptx',
  'sycl_bundle',
  'unknown',
]);
const RETIREMENT_PROOFS = new Set([
  'stream_event_proven',
  'queue_idle_proven',
  'frame_boundary_proven',
  'no_retirement_required',
  'unproven',
]);

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function enumValue(value, allowed, fallback) {
  const normalized = text(value);
  return normalized && allowed.has(normalized) ? normalized : fallback;
}

function compactStringList(values) {
  return [...new Set(asArray(values).map(text).filter(Boolean))];
}

function boolValue(value, fallback = false) {
  return typeof value === 'boolean' ? value : fallback;
}

function addFailure(failures, code, detail = {}) {
  failures.push({ code, ...detail });
}

function normalizeClassification(value = {}) {
  const c = asObject(value);
  return {
    project_kind: enumValue(c.project_kind ?? c.projectKind, PROJECT_KINDS, 'unknown'),
    edit_kind: enumValue(c.edit_kind ?? c.editKind, EDIT_KINDS, 'unknown'),
    route: enumValue(c.route, ROUTES, 'reject'),
    confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : null,
    blocking_gaps: compactStringList(c.blocking_gaps ?? c.blockingGaps),
  };
}

function normalizeAbi(value = {}) {
  const abi = asObject(value);
  return {
    value: enumValue(abi.value ?? abi.class ?? abi.abi_compatibility_class, ABI_CLASSES, 'unknown'),
    evidence_refs: compactStringList(abi.evidence_refs ?? abi.evidenceRefs),
    notes: text(abi.notes),
    backend_specific_adapter_safety_proven:
      boolValue(abi.backend_specific_adapter_safety_proven ?? abi.backendSpecificAdapterSafetyProven),
  };
}

function normalizeArtifactIdentity(value = {}) {
  const artifact = asObject(value);
  return {
    source_paths: compactStringList(artifact.source_paths ?? artifact.sourcePaths),
    artifact_kind: enumValue(
      asObject(artifact.artifact_kind).value ?? artifact.artifact_kind ?? artifact.artifactKind,
      ARTIFACT_KINDS,
      'unknown',
    ),
    entry_points: compactStringList(artifact.entry_points ?? artifact.entryPoints),
    compile_target: text(artifact.compile_target ?? artifact.compileTarget),
    compiler: text(artifact.compiler),
    compiler_args_hash: text(artifact.compiler_args_hash ?? artifact.compilerArgsHash),
  };
}

function normalizeReloadMechanism(value) {
  if (typeof value === 'string') return enumValue(value, RELOAD_MECHANISMS, 'unsupported');
  const obj = asObject(value);
  return enumValue(obj.value ?? obj.mechanism, RELOAD_MECHANISMS, 'unsupported');
}

function normalizeAdapterOutcome(value) {
  if (typeof value === 'string') return enumValue(value, ADAPTER_OUTCOMES, 'adapter_impossible_requires_app_hook');
  const obj = asObject(value);
  return enumValue(obj.value ?? obj.outcome, ADAPTER_OUTCOMES, 'adapter_impossible_requires_app_hook');
}

export function normalizeGpuHmrAcceptanceContract(input = {}) {
  const c = asObject(input);
  const classification = normalizeClassification(c.classification);
  const abi = normalizeAbi(c.abi_compatibility_class ?? c.abiCompatibilityClass);
  const normalized = {
    contract_version: text(c.contract_version ?? c.contractVersion)
      ?? GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    contract_id: text(c.contract_id ?? c.contractId),
    contract_hash: text(c.contract_hash ?? c.contractHash),
    project_id: text(c.project_id ?? c.projectId),
    edit_id: text(c.edit_id ?? c.editId),
    backend: enumValue(asObject(c.backend).value ?? c.backend, BACKENDS, 'unknown'),
    confidence: Number.isFinite(Number(c.confidence)) ? Number(c.confidence) : null,
    evidence_refs: compactStringList(c.evidence_refs ?? c.evidenceRefs),
    ai_hints: asArray(c.ai_hints ?? c.aiHints),
    unsupported_reasons: compactStringList(c.unsupported_reasons ?? c.unsupportedReasons),
    failure_mode: enumValue(asObject(c.failure_mode).value ?? c.failure_mode ?? c.failureMode, FAILURE_MODES, 'reject'),
    classification,
    artifact_identity: normalizeArtifactIdentity(c.artifact_identity ?? c.artifactIdentity),
    artifact_hash_before: text(c.artifact_hash_before ?? c.artifactHashBefore),
    artifact_hash_after: text(c.artifact_hash_after ?? c.artifactHashAfter),
    unaffected_artifacts_hash_unchanged:
      boolValue(c.unaffected_artifacts_hash_unchanged ?? c.unaffectedArtifactsHashUnchanged),
    abi_compatibility_class: abi,
    abi_metadata: asObject(c.abi_metadata ?? c.abiMetadata),
    reload_mechanism: normalizeReloadMechanism(c.reload_mechanism ?? c.reloadMechanism),
    adapter_outcome: normalizeAdapterOutcome(c.adapter_outcome ?? c.adapterOutcome),
    reload_evidence_refs: compactStringList(c.reload_evidence_refs ?? c.reloadEvidenceRefs),
    dispatch_trace_required: c.dispatch_trace_required !== false && c.dispatchTraceRequired !== false,
    oracle_trace_required: c.oracle_trace_required !== false && c.oracleTraceRequired !== false,
    state_preservation_checks: asObject(c.state_preservation_checks ?? c.statePreservationChecks),
    epoch_policy: asObject(c.epoch_policy ?? c.epochPolicy),
    epoch_retirement_proof: asObject(c.epoch_retirement_proof ?? c.epochRetirementProof),
    fission_report: asObject(c.fission_report ?? c.fissionReport),
  };
  normalized.contract_hash ??= `sha256:${sha256Hex(stableJson({
    contract_version: normalized.contract_version,
    project_id: normalized.project_id,
    edit_id: normalized.edit_id,
    backend: normalized.backend,
    classification: normalized.classification,
    artifact_identity: normalized.artifact_identity,
    artifact_hash_before: normalized.artifact_hash_before,
    artifact_hash_after: normalized.artifact_hash_after,
    abi_compatibility_class: normalized.abi_compatibility_class,
    reload_mechanism: normalized.reload_mechanism,
    adapter_outcome: normalized.adapter_outcome,
  }))}`;
  normalized.contract_id ??= `gpu-hmr-contract:${normalized.contract_hash}`;
  return normalized;
}

export function evaluateGpuHmrAcceptanceContract(input = {}) {
  const contract = normalizeGpuHmrAcceptanceContract(input);
  const failures = [];
  const warnings = [];
  const c = contract.classification;

  if (contract.contract_version !== GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION) {
    addFailure(failures, 'contract_version_unsupported', {
      expected: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
      actual: contract.contract_version,
    });
  }
  if (contract.backend === 'unknown') addFailure(failures, 'backend_unknown');
  if (c.project_kind === 'cpu_project') addFailure(failures, 'cpu_project_not_gpu_hmr');
  if (c.project_kind === 'unknown') addFailure(failures, 'project_kind_unknown');
  if (c.edit_kind === 'host_only') addFailure(failures, 'host_only_edit_not_gpu_hmr');
  if (c.edit_kind === 'unknown') addFailure(failures, 'edit_kind_unknown');
  if (c.route !== 'gpu_hmr') addFailure(failures, 'route_not_gpu_hmr', { route: c.route });
  if (!contract.dispatch_trace_required) addFailure(failures, 'dispatch_trace_not_required');
  if (!contract.oracle_trace_required) addFailure(failures, 'oracle_trace_not_required');
  if (!contract.artifact_hash_before) addFailure(failures, 'artifact_hash_before_missing');
  if (!contract.artifact_hash_after) addFailure(failures, 'artifact_hash_after_missing');
  if (contract.artifact_hash_before && contract.artifact_hash_after
    && contract.artifact_hash_before === contract.artifact_hash_after) {
    addFailure(failures, 'artifact_hash_unchanged');
  }
  if (!contract.unaffected_artifacts_hash_unchanged) {
    addFailure(failures, 'unaffected_artifacts_hash_not_proven');
  }
  if (!contract.artifact_identity.source_paths.length) addFailure(failures, 'artifact_source_paths_missing');
  if (!contract.artifact_identity.entry_points.length) addFailure(failures, 'artifact_entry_points_missing');
  if (contract.artifact_identity.artifact_kind === 'unknown') addFailure(failures, 'artifact_kind_unknown');
  if (!contract.evidence_refs.length) warnings.push({ code: 'contract_evidence_refs_missing' });
  if (contract.evidence_refs.length === 0 && contract.ai_hints.length > 0) {
    addFailure(failures, 'ai_hints_without_verified_evidence');
  }
  const abi = contract.abi_compatibility_class;
  if (!['compatible', 'additive'].includes(abi.value) && !abi.backend_specific_adapter_safety_proven) {
    addFailure(failures, 'abi_compatibility_not_proven', { abi: abi.value });
  }
  if (!abi.evidence_refs.length) addFailure(failures, 'abi_evidence_refs_missing');
  if (contract.reload_mechanism === 'unsupported') addFailure(failures, 'reload_mechanism_unsupported');
  if (contract.adapter_outcome === 'adapter_impossible_requires_app_hook') {
    addFailure(failures, 'adapter_impossible_requires_app_hook');
  }
  if (!contract.reload_evidence_refs.length) addFailure(failures, 'reload_evidence_refs_missing');
  const retirementValue = enumValue(contract.epoch_retirement_proof.value, RETIREMENT_PROOFS, 'unproven');
  if (retirementValue === 'unproven') addFailure(failures, 'epoch_retirement_unproven');
  const fission = contract.fission_report;
  if (fission.full_device_fallback === true) addFailure(failures, 'fission_full_device_fallback_used');
  if (fission.host_relinked === true) addFailure(failures, 'fission_host_relinked');
  if (fission.process_restarted === true) addFailure(failures, 'fission_process_restarted');
  if (fission.full_rebuild_used === true) addFailure(failures, 'fission_full_rebuild_used');
  if (c.blocking_gaps.length > 0) {
    addFailure(failures, 'classification_blocking_gaps_present', { blocking_gaps: c.blocking_gaps });
  }
  if (contract.unsupported_reasons.length > 0) {
    addFailure(failures, 'unsupported_reasons_present', { unsupported_reasons: contract.unsupported_reasons });
  }

  return {
    schemaVersion: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    contract,
    accepted: failures.length === 0,
    gpuHmrCandidate: failures.length === 0,
    failureMode: failures.length === 0 ? null : contract.failure_mode,
    failedGates: failures,
    warnings,
  };
}
