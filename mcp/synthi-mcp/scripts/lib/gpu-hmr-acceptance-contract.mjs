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
const COMPUTE_BACKENDS = new Set(['hip', 'opencl', 'cuda', 'sycl']);
const VISUAL_OR_ENGINE_BACKENDS = new Set(['hiprt', 'vulkan', 'webgpu', 'bevy_wgsl']);

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

function nonEmptyValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === 'object') return Object.keys(value).length > 0;
  return typeof value === 'string' && value.trim().length > 0;
}

const AI_AUTHORITY_MARKERS = new Set([
  'ai',
  'ai_hint',
  'ai_inference',
  'llm',
  'llm_hint',
  'model_hint',
]);

const AUTHORITY_KEY_RE = /(^|_)(source|sources|provenance|authority|verified_by|verification|extractor_sources|metadata_sources)($|_)/i;

function normalizedMarker(value) {
  return String(value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function valueContainsAiAuthorityMarker(value) {
  if (typeof value === 'string') return AI_AUTHORITY_MARKERS.has(normalizedMarker(value));
  if (Array.isArray(value)) return value.some(valueContainsAiAuthorityMarker);
  if (value && typeof value === 'object') {
    return Object.values(value).some(valueContainsAiAuthorityMarker);
  }
  return false;
}

function collectAiAuthorityMarkers(value, path = []) {
  if (!value || typeof value !== 'object') return [];
  const failures = [];
  const visit = (node, nodePath) => {
    if (nodePath[0] === 'ai_hints' || nodePath[0] === 'aiHints') return;
    if (Array.isArray(node)) {
      node.forEach((item, index) => visit(item, [...nodePath, String(index)]));
      return;
    }
    if (!node || typeof node !== 'object') return;
    for (const [key, child] of Object.entries(node)) {
      const childPath = [...nodePath, key];
      if (AUTHORITY_KEY_RE.test(key) && valueContainsAiAuthorityMarker(child)) {
        failures.push({
          path: childPath.join('.'),
          value: child,
        });
      }
      visit(child, childPath);
    }
  };
  visit(value, path);
  const seen = new Set();
  return failures.filter((failure) => {
    const key = `${failure.path}:${stableJson(failure.value)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function firstObject(...values) {
  for (const value of values) {
    const obj = asObject(value);
    if (Object.keys(obj).length > 0) return obj;
  }
  return {};
}

function firstText(...values) {
  for (const value of values) {
    const normalized = text(value);
    if (normalized) return normalized;
  }
  return null;
}

function uniqueObjectsByPath(values) {
  const seen = new Set();
  return asArray(values)
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value))
    .filter((value) => {
      const key = text(value.path) ?? stableJson(value);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
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
  const rawContract = asObject(input);
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
  for (const marker of collectAiAuthorityMarkers(rawContract)) {
    addFailure(failures, 'ai_hint_used_as_authoritative_contract_field', marker);
  }
  const abi = contract.abi_compatibility_class;
  if (!['compatible', 'additive'].includes(abi.value) && !abi.backend_specific_adapter_safety_proven) {
    addFailure(failures, 'abi_compatibility_not_proven', { abi: abi.value });
  }
  if (!abi.evidence_refs.length) addFailure(failures, 'abi_evidence_refs_missing');
  const abiMetadata = contract.abi_metadata;
  if (
    ['compatible', 'additive'].includes(abi.value)
    && !nonEmptyValue(abiMetadata.args)
    && !nonEmptyValue(abiMetadata.kernel_abi_fingerprint_hashes)
    && !nonEmptyValue(abiMetadata.descriptor_or_binding_layout)
  ) {
    addFailure(failures, 'abi_metadata_missing');
  }
  if (
    ['compatible', 'additive'].includes(abi.value)
    && !nonEmptyValue(abiMetadata.extractor_sources)
    && !nonEmptyValue(abiMetadata.extractor_provenance)
    && !nonEmptyValue(abiMetadata.metadata_sources)
  ) {
    addFailure(failures, 'abi_metadata_extractor_provenance_missing');
  }
  if (contract.reload_mechanism === 'unsupported') addFailure(failures, 'reload_mechanism_unsupported');
  if (contract.adapter_outcome === 'adapter_impossible_requires_app_hook') {
    addFailure(failures, 'adapter_impossible_requires_app_hook');
  }
  if (!contract.reload_evidence_refs.length) addFailure(failures, 'reload_evidence_refs_missing');
  const state = contract.state_preservation_checks;
  if (!nonEmptyValue(state.process_id)) addFailure(failures, 'state_process_id_missing');
  if (!nonEmptyValue(state.device_uuid)) addFailure(failures, 'state_device_uuid_missing');
  if (!nonEmptyValue(state.context_or_device_handle)) addFailure(failures, 'state_context_or_device_handle_missing');
  if (!nonEmptyValue(state.queue_or_stream_handle)) addFailure(failures, 'state_queue_or_stream_handle_missing');
  if (COMPUTE_BACKENDS.has(contract.backend) && !nonEmptyValue(state.persistent_gpu_allocations)) {
    addFailure(failures, 'state_persistent_gpu_allocations_missing');
  }
  if (VISUAL_OR_ENGINE_BACKENDS.has(contract.backend)) {
    if (!nonEmptyValue(state.camera_state_hash)) addFailure(failures, 'state_camera_hash_missing');
    if (!nonEmptyValue(state.swapchain_or_framebuffer_identity)) {
      addFailure(failures, 'state_swapchain_or_framebuffer_identity_missing');
    }
  }
  if (contract.backend === 'hiprt' && !nonEmptyValue(state.engine_scene_handles)) {
    addFailure(failures, 'state_engine_scene_handles_missing');
  }
  const epochPolicy = contract.epoch_policy;
  if (!nonEmptyValue(epochPolicy.publish_mechanism)) addFailure(failures, 'epoch_publish_mechanism_missing');
  if (!nonEmptyValue(epochPolicy.dispatch_binding)) addFailure(failures, 'epoch_dispatch_binding_missing');
  const retirementValue = enumValue(contract.epoch_retirement_proof.value, RETIREMENT_PROOFS, 'unproven');
  if (retirementValue === 'unproven') addFailure(failures, 'epoch_retirement_unproven');
  const fission = contract.fission_report;
  if (!nonEmptyValue(fission.selected_island)) addFailure(failures, 'fission_selected_island_missing');
  if (!nonEmptyValue(fission.selected_reason)) addFailure(failures, 'fission_selected_reason_missing');
  if (fission.artifact_hash_before && fission.artifact_hash_before !== contract.artifact_hash_before) {
    addFailure(failures, 'fission_artifact_before_hash_mismatch', {
      expected: contract.artifact_hash_before,
      actual: fission.artifact_hash_before,
    });
  }
  if (fission.artifact_hash_after && fission.artifact_hash_after !== contract.artifact_hash_after) {
    addFailure(failures, 'fission_artifact_after_hash_mismatch', {
      expected: contract.artifact_hash_after,
      actual: fission.artifact_hash_after,
    });
  }
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

function backendFromVerifiedContext(input, validationContext) {
  const raw = firstText(
    input.backend,
    input.gpuBackend,
    input.gpu_backend,
    validationContext.backend,
    validationContext.gpuBackend,
    validationContext.gpu_backend,
    validationContext.gpu_vendor,
    validationContext.gpuVendor,
    input.gpuVendor,
    input.gpu_vendor,
  )?.toLowerCase();
  if (!raw) return 'unknown';
  if (raw === 'rocm' || raw === 'amd' || raw === 'hip') return 'hip';
  if (raw === 'hiprt') return 'hiprt';
  if (raw === 'cuda' || raw === 'nvidia') return 'cuda';
  if (raw === 'opencl' || raw === 'vulkan' || raw === 'webgpu' || raw === 'bevy_wgsl' || raw === 'sycl') {
    return raw;
  }
  return 'unknown';
}

function selectedIslandContractFromProof(fissionProof) {
  const contracts = asArray(fissionProof?.selectedIslandContracts)
    .filter((contract) => contract && typeof contract === 'object' && !Array.isArray(contract));
  return contracts[0] ?? {};
}

function selectedIslandKind(contract, backend) {
  const kind = firstText(contract.artifactKind, contract.artifact_kind)?.toLowerCase();
  if (!kind) return 'unknown';
  if (ARTIFACT_KINDS.has(kind)) return kind;
  if ((backend === 'hip' || backend === 'hiprt') && /source[_-]?include|source[_-]?bridge/.test(kind)) {
    return 'hip_source_bridge';
  }
  if (/spirv|spv/.test(kind)) return 'spirv';
  if (/wgsl/.test(kind)) return 'wgsl';
  if (/glsl/.test(kind)) return 'glsl';
  if (/opencl/.test(kind)) return 'opencl_program';
  if (/cubin/.test(kind)) return 'cuda_cubin';
  if (/ptx/.test(kind)) return 'cuda_ptx';
  if (/sycl/.test(kind)) return 'sycl_bundle';
  if (/hsaco|code[_-]?object/.test(kind)) return 'hsaco';
  return 'unknown';
}

function latestEpochPublication(epochProof) {
  const graph = firstObject(
    epochProof?.epochGenerationGraph,
    epochProof?.epoch_generation_graph,
    epochProof?.generationGraph,
    epochProof?.generation_graph,
  );
  return firstObject(graph.latestPublication, graph.latest_publication);
}

function artifactHashAfterFromProofs(input, artifactTransportProof, epochProof, dispatchProof, outputProof) {
  const publication = latestEpochPublication(epochProof);
  return firstText(
    input.artifactHashAfter,
    input.artifact_hash_after,
    input.changedGpuArtifactHash,
    input.changed_gpu_artifact_hash,
    ...asArray(artifactTransportProof?.selectedArtifactIds),
    ...asArray(artifactTransportProof?.selected_artifact_ids),
    ...asArray(artifactTransportProof?.ramBlobIds),
    ...asArray(artifactTransportProof?.ram_blob_ids),
    ...asArray(dispatchProof?.selectedArtifactIds),
    ...asArray(dispatchProof?.selected_artifact_ids),
    ...asArray(dispatchProof?.runtimeArtifactIds),
    ...asArray(dispatchProof?.runtime_artifact_ids),
    outputProof?.outputOracle?.artifactId,
    outputProof?.outputOracle?.artifact_id,
    publication.newArtifactId,
    publication.new_artifact_id,
    publication.newArtifactHash,
    publication.new_artifact_hash,
  );
}

function artifactHashBeforeFromProofs(input, epochProof) {
  const publication = latestEpochPublication(epochProof);
  return firstText(
    input.artifactHashBefore,
    input.artifact_hash_before,
    publication.oldArtifactId,
    publication.old_artifact_id,
    publication.oldArtifactHash,
    publication.old_artifact_hash,
  );
}

function evidenceRefsFromProofs(...proofs) {
  return compactStringList(proofs.flatMap((proof) => [
    ...(asArray(proof?.evidenceRefs)),
    ...(asArray(proof?.evidence_refs)),
    ...(asArray(proof?.proofArtifactPaths)),
    ...(asArray(proof?.proof_artifact_paths)),
  ]));
}

function blockingGapsFromVerifiedProofs({
  backend,
  sourceProofs,
  fissionProof,
  abiProof,
  artifactTransportProof,
  epochProof,
  dispatchProof,
  outputProof,
  hostPreservationProof,
  fullRuntimeProof,
  selectedIsland,
}) {
  const gaps = [];
  if (backend === 'unknown') gaps.push('backend_unknown');
  if (!sourceProofs.some((proof) => proof?.resultState === 'gpu-hmr-symbol-bound')) {
    gaps.push('source_proof_not_verified');
  }
  if (fissionProof?.fissionProven !== true) gaps.push('fission_not_verified');
  if (!selectedIsland?.sourcePaths?.length) gaps.push('selected_island_source_paths_missing');
  if (!selectedIsland?.targetSymbols?.length && !selectedIsland?.exportedSymbolsExpected?.length) {
    gaps.push('selected_island_entry_points_missing');
  }
  if (abiProof?.resultState !== 'gpu-hmr-abi-proven') gaps.push('abi_not_verified');
  if (artifactTransportProof?.resultState !== 'gpu-hmr-artifact-transport-proven'
    && artifactTransportProof?.ramTransportProven !== true) {
    gaps.push('artifact_transport_not_verified');
  }
  if (epochProof?.resultState !== 'gpu-hmr-epoch-swap-proven') gaps.push('epoch_not_verified');
  if (dispatchProof?.resultState !== 'gpu-hmr-dispatch-safe-proven') gaps.push('dispatch_not_verified');
  if (outputProof?.resultState !== 'gpu-hmr-output-oracle-proven') gaps.push('output_oracle_not_verified');
  if (hostPreservationProof?.resultState !== 'gpu-hmr-host-preservation-proven') {
    gaps.push('host_preservation_not_verified');
  }
  if (fullRuntimeProof?.fullRuntimeProven !== true) gaps.push('full_runtime_not_verified');
  return compactStringList(gaps);
}

export function deriveGpuHmrAcceptanceContractFromVerifiedProofs(input = {}) {
  const validationContext = asObject(input.validationContext ?? input.validation_context);
  const sourceProofs = asArray(input.sourceProofs ?? input.source_proofs ?? (
    input.sourceProof ? [input.sourceProof] : []
  )).filter((proof) => proof && typeof proof === 'object');
  const fissionProof = asObject(input.fissionProof ?? input.fission_proof);
  const abiProof = asObject(input.abiProof ?? input.abi_proof);
  const artifactTransportProof = asObject(input.artifactTransportProof ?? input.artifact_transport_proof);
  const epochProof = asObject(input.epochProof ?? input.epoch_proof ?? input.epochSwapProof ?? input.epoch_swap_proof);
  const dispatchProof = asObject(input.dispatchProof ?? input.dispatch_proof);
  const outputProof = asObject(input.outputProof ?? input.output_proof);
  const hostPreservationProof = asObject(input.hostPreservationProof ?? input.host_preservation_proof);
  const fullRuntimeProof = asObject(input.fullRuntimeProof ?? input.full_runtime_proof);
  const selectedIsland = selectedIslandContractFromProof(fissionProof);
  const backend = backendFromVerifiedContext(input, validationContext);
  const artifactHashAfter = artifactHashAfterFromProofs(
    input,
    artifactTransportProof,
    epochProof,
    dispatchProof,
    outputProof,
  );
  const artifactHashBefore = artifactHashBeforeFromProofs(input, epochProof);
  const sourcePaths = compactStringList([
    ...asArray(selectedIsland.sourcePaths),
    ...asArray(selectedIsland.source_paths),
  ]);
  const entryPoints = compactStringList([
    ...asArray(selectedIsland.targetSymbols),
    ...asArray(selectedIsland.target_symbols),
    ...asArray(selectedIsland.exportedSymbolsExpected),
    ...asArray(selectedIsland.exported_symbols_expected),
    ...asArray(dispatchProof.dispatchTableEntryIds).map((entry) => String(entry).split(':')[0]),
    ...asArray(dispatchProof.dispatch_table_entry_ids).map((entry) => String(entry).split(':')[0]),
  ]);
  const evidenceRefs = evidenceRefsFromProofs(
    ...sourceProofs,
    fissionProof,
    abiProof,
    artifactTransportProof,
    epochProof,
    dispatchProof,
    outputProof,
    hostPreservationProof,
  );
  const blockingGaps = blockingGapsFromVerifiedProofs({
    backend,
    sourceProofs,
    fissionProof,
    abiProof,
    artifactTransportProof,
    epochProof,
    dispatchProof,
    outputProof,
    hostPreservationProof,
    fullRuntimeProof,
    selectedIsland,
  });
  const gpuRouteAccepted = blockingGaps.length === 0;
  const artifactKind = selectedIslandKind(selectedIsland, backend);
  const fullDeviceFallback = /full[_-]?device|device[_-]?module/.test(
    String(selectedIsland.artifactKind ?? selectedIsland.artifact_kind ?? ''),
  );
  const contract = normalizeGpuHmrAcceptanceContract({
    contract_version: GPU_HMR_ACCEPTANCE_CONTRACT_SCHEMA_VERSION,
    project_id: firstText(input.projectId, input.project_id, input.workspaceSlug, validationContext.workspaceSlug),
    edit_id: firstText(input.editId, input.edit_id, input.sourceEditId, validationContext.sourceEditId),
    backend,
    confidence: gpuRouteAccepted ? 0.95 : 0.25,
    evidence_refs: evidenceRefs,
    ai_hints: asArray(input.aiHints ?? input.ai_hints),
    unsupported_reasons: gpuRouteAccepted ? [] : blockingGaps,
    failure_mode: gpuRouteAccepted ? 'reject' : 'gpu_hmr_unsupported',
    classification: {
      project_kind: backend === 'unknown' ? 'unknown' : 'gpu_project',
      edit_kind: sourcePaths.length > 0 || entryPoints.length > 0 ? 'gpu_artifact_edit' : 'unknown',
      route: gpuRouteAccepted ? 'gpu_hmr' : 'reject',
      confidence: gpuRouteAccepted ? 0.95 : 0.25,
      blocking_gaps: blockingGaps,
    },
    artifact_identity: {
      source_paths: sourcePaths,
      artifact_kind: artifactKind,
      entry_points: entryPoints,
      compile_target: firstText(input.gpuArch, input.gpu_arch, validationContext.gpuArch, validationContext.gpu_arch),
      compiler: firstText(selectedIsland.compiler, selectedIsland.compilerName, input.compiler),
      compiler_args_hash: firstText(
        selectedIsland.compileCommandHash,
        selectedIsland.compile_command_hash,
        selectedIsland.compileRecipeHash,
        selectedIsland.compile_recipe_hash,
      ),
    },
    artifact_hash_before: artifactHashBefore,
    artifact_hash_after: artifactHashAfter,
    unaffected_artifacts_hash_unchanged: fissionProof?.fissionProven === true && !fullDeviceFallback,
    abi_compatibility_class: {
      value: abiProof?.resultState === 'gpu-hmr-abi-proven' ? 'compatible' : 'unknown',
      evidence_refs: compactStringList(abiProof.evidenceRefs ?? abiProof.evidence_refs),
    },
    abi_metadata: {
      kernel_abi_fingerprint_hashes: compactStringList(abiProof.kernelAbiFingerprintHashes),
      constant_global_layout_hashes: compactStringList(abiProof.constantGlobalLayoutHashes),
      extractor_sources: compactStringList(abiProof.acceptedExtractorSources),
      extractor_provenance: asArray(abiProof.extractorProvenance ?? abiProof.extractor_provenance),
    },
    reload_mechanism: artifactTransportProof?.resultState === 'gpu-hmr-artifact-transport-proven'
      || artifactTransportProof?.ramTransportProven === true
      ? 'generated_adapter'
      : 'unsupported',
    adapter_outcome: artifactTransportProof?.resultState === 'gpu-hmr-artifact-transport-proven'
      || artifactTransportProof?.ramTransportProven === true
      ? 'adapter_generated'
      : 'adapter_impossible_requires_app_hook',
    reload_evidence_refs: compactStringList(artifactTransportProof.evidenceRefs ?? artifactTransportProof.evidence_refs),
    dispatch_trace_required: true,
    oracle_trace_required: true,
    state_preservation_checks: {
      process_id: firstText(
        hostPreservationProof.processId,
        hostPreservationProof.process_id,
        input.processId,
        input.process_id,
        validationContext.processId,
        validationContext.process_id,
      ),
      device_uuid: firstText(
        input.deviceUuid,
        input.device_uuid,
        validationContext.deviceUuid,
        validationContext.device_uuid,
        validationContext.deviceIdentity?.device_uuid,
        validationContext.deviceIdentity?.deviceUuid,
        validationContext.device_identity?.device_uuid,
        validationContext.device_identity?.deviceUuid,
      ),
      context_or_device_handle: firstText(
        input.contextHandle,
        input.context_handle,
        input.contextOrDeviceHandle,
        input.context_or_device_handle,
        validationContext.contextHandle,
        validationContext.context_handle,
        validationContext.contextOrDeviceHandle,
        validationContext.context_or_device_handle,
      ),
      queue_or_stream_handle: firstText(dispatchProof.dispatchStreamIds?.[0], epochProof.streamIds?.[0]),
      persistent_gpu_allocations: asArray(dispatchProof.argProvenanceRecords)
        .filter((record) => record?.category === 'device_allocation')
        .map((record) => record.allocationId ?? record.allocation_id)
        .filter(Boolean),
      engine_scene_handles: compactStringList(input.engineSceneHandles ?? input.engine_scene_handles),
      camera_state_hash: firstText(input.cameraStateHash, input.camera_state_hash, validationContext.cameraStateHash),
      swapchain_or_framebuffer_identity: firstText(
        input.swapchainOrFramebufferIdentity,
        input.swapchain_or_framebuffer_identity,
        validationContext.swapchainOrFramebufferIdentity,
        validationContext.swapchain_or_framebuffer_identity,
      ),
    },
    epoch_policy: {
      publish_mechanism: epochProof?.published === true ? 'runtime_epoch_publish' : null,
      dispatch_binding: dispatchProof?.resultState === 'gpu-hmr-dispatch-safe-proven'
        ? 'dispatch_table_epoch_binding'
        : null,
      retirement_mechanism: firstText(epochProof.retirementStrategy, epochProof.retirement_strategy),
    },
    epoch_retirement_proof: {
      value: epochProof?.oldGenerationRetired === true && epochProof?.streamOrderingProven === true
        ? 'stream_event_proven'
        : 'unproven',
      evidence_refs: compactStringList([
        ...(asArray(epochProof.evidenceRefs)),
        ...(asArray(epochProof.retirementFenceIds)),
      ]),
    },
    fission_report: {
      selected_island: firstText(selectedIsland.islandId, selectedIsland.island_id),
      selected_reason: fissionProof?.fissionProven === true ? 'verified_fission_contract' : null,
      changed_sources: sourcePaths,
      included_dependencies: uniqueObjectsByPath(selectedIsland.includeClosure ?? selectedIsland.include_closure),
      excluded_host_sources: [],
      artifact_hash_before: artifactHashBefore,
      artifact_hash_after: artifactHashAfter,
      abi_compatibility_class: abiProof?.resultState === 'gpu-hmr-abi-proven' ? 'compatible' : 'unknown',
      full_device_fallback: fullDeviceFallback,
      host_relinked: input.hostRelinked === true || input.host_relinked === true,
      process_restarted: input.processRestarted === true || input.process_restarted === true,
      full_rebuild_used: input.fullRebuildUsed === true || input.full_rebuild_used === true,
      evidence_refs: evidenceRefs,
    },
  });
  return contract;
}
