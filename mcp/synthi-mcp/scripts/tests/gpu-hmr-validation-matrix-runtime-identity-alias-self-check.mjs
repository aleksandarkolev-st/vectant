#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  buildGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
  queryGpuHmrValidationMatrixLedger,
  recomputeGpuHmrValidationMatrixRowId,
  recomputeGpuHmrValidationMatrixRuntimeTargetIdentityHash,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';
import {
  buildGpuHmrProofLedger,
  GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
  queryGpuHmrLedgerInvariants,
} from '../lib/gpu-hmr-proof-ledger.mjs';

function sha256(value) {
  return `sha256:${createHash('sha256').update(String(value)).digest('hex')}`;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function modelProvenance(requestMode, model) {
  return {
    provider: 'google_gemini',
    requested_model: model,
    provider_model_status: 'available',
    provider_model_alias_resolved_to: model,
    provider_shutdown_or_deprecation_detected: false,
    model_availability_checked_at: '2026-07-17T00:00:00.000Z',
    model_availability_source: 'provider_model_registry',
    model_availability_basis: 'static_registry',
    model_availability_check_time_ms: 1,
    actual_model: model,
    fallback_model: 'not_used',
    fallback_used: false,
    request_mode: requestMode,
    hard_infra_failure: false,
  };
}

function scopedGeneralityClaim(acceptanceScope) {
  const unsupported = [
    'arbitrary_library_hmr_not_proven',
    'arbitrary_target_runtime_not_proven',
  ];
  return {
    schemaVersion: 'synthi.gpu_hmr.generality_claim.v1',
    authority: 'matrix_computed_from_acceptance_scope',
    acceptanceScope,
    acceptance_scope: acceptanceScope,
    claimScope: 'scoped_profile',
    claim_scope: 'scoped_profile',
    profileScopedOnly: true,
    profile_scoped_only: true,
    broadLibraryAgnosticAccepted: false,
    broad_library_agnostic_accepted: false,
    arbitraryLibraryAccepted: false,
    arbitrary_library_accepted: false,
    arbitraryTargetRuntimeAccepted: false,
    arbitrary_target_runtime_accepted: false,
    unsupportedWithoutEvidence: unsupported,
    unsupported_without_evidence: unsupported,
    openGaps: ['broad_library_agnostic_proof_not_present'],
    open_gaps: ['broad_library_agnostic_proof_not_present'],
    failedGates: [],
    failed_gates: [],
  };
}

function strictLedger(runtimeIdentity) {
  const scope = 'runtime-identity-alias-self-check';
  const artifactBeforeHash = sha256(`${scope}:artifact-before`);
  const artifactAfterHash = sha256(`${scope}:artifact-after`);
  const contractHash = sha256(`${scope}:contract`);
  const editHash = sha256(`${scope}:source-edit`);
  const processId = 'pid:runtime-identity-alias-self-check';
  const runtimeSessionId = 'session:runtime-identity-alias-self-check';
  const outputTargetId = 'output:runtime-identity-alias-self-check';
  const evidenceRef = 'evidence:runtime-identity-alias-self-check';
  const visualArtifacts = {
    before_image: 'runtime-evidence/before.png',
    before_image_hash: sha256(`${scope}:before-image`),
    before_image_hash_verified: true,
    after_image: 'runtime-evidence/after.png',
    after_image_hash: sha256(`${scope}:after-image`),
    after_image_hash_verified: true,
    diff_image: 'runtime-evidence/diff.png',
    diff_image_hash: sha256(`${scope}:diff-image`),
    diff_image_hash_verified: true,
    blank_frame_rejection: true,
    same_frame_rejection: true,
    new_epoch_watermark_or_trace:
      `epoch=epoch:${scope} dispatch=dispatch:${scope} artifact=${artifactAfterHash}`,
    camera_state_hash: sha256(`${scope}:camera`),
    swapchain_size: [64, 64],
    capture_backend: 'mcp_decoded_frame',
    frame_number: 2,
    timestamp_after_dispatch: 4000,
    perceptual_diff: 4.5,
    changed_pixel_ratio: 0.1,
    visible_pixel_count: 128,
    pixel_metrics_verified: true,
  };
  const timings = {
    static_discovery_time: 1,
    ai_contract_synthesis_time: 1,
    model_availability_check_time: 1,
    artifact_hash_time: 1,
    adapter_generation_time: 1,
    device_compile_wall_time: 2,
    artifact_load_time: 1,
    epoch_publish_time: 1,
    dispatch_trace_time: 1,
    runtime_probe_time: 2,
    oracle_analysis_time: 1,
    trigger_to_visible_time: 3,
    screenshot_capture_time: 1,
    dispatch_to_output_proof_time: 1,
    total_validator_wall_time: 4,
  };
  const deterministicVisualMode = {
    schemaVersion: 'synthi.gpu_hmr.deterministic_visual_mode.v1',
    fixed_seed: true,
    seed_policy_fixed: true,
    seed_policy_hash: sha256(`${scope}:seed`),
    camera_state_hash: sha256(`${scope}:camera`),
    frozen_camera: true,
    temporal_accumulation_not_applicable: true,
    taa_not_applicable: true,
    denoiser_not_applicable: true,
    fixed_resolution: true,
    fixed_swapchain_image_count: true,
    frame_capture_after_epoch_dispatch: true,
    presentation_fence_or_frame_boundary: true,
    warmup_frames: 1,
  };
  const ledger = buildGpuHmrProofLedger({
    schema_version: GPU_HMR_PROOF_LEDGER_SCHEMA_VERSION,
    project_id: runtimeIdentity,
    edit_id: editHash,
    backend: 'hip',
    classification: {
      project_kind: 'gpu_project',
      edit_kind: 'gpu_artifact_edit',
      route: 'gpu_hmr',
    },
    contract_hash: contractHash,
    artifact_before_hash: artifactBeforeHash,
    artifact_after_hash: artifactAfterHash,
    loader_event: {
      id: `loader:${scope}`,
      artifact_hash: artifactAfterHash,
      runtime_session_id: runtimeSessionId,
      selected_loader_transport: 'ram_bytes',
      artifact_transport: {
        selected_loader_transport: 'ram_bytes',
        artifact_hash: artifactAfterHash,
        blob_digest: artifactAfterHash,
      },
      timestamp_monotonic_ns: 1000,
      process_id: processId,
    },
    epoch_publish_event: {
      id: `epoch-publish:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: artifactAfterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: `dispatch-table-entry:${scope}`,
      timestamp_monotonic_ns: 2000,
      process_id: processId,
    },
    dispatch_event: {
      id: `dispatch:${scope}`,
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: artifactAfterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: `dispatch-table-entry:${scope}`,
      output_target_id: outputTargetId,
      timestamp_monotonic_ns: 3000,
      process_id: processId,
    },
    output_event: {
      id: `output:${scope}`,
      kind: 'visual_frame',
      epoch: `epoch:${scope}`,
      generation: `generation:${scope}`,
      artifact_hash: artifactAfterHash,
      runtime_session_id: runtimeSessionId,
      dispatch_table_entry_id: `dispatch-table-entry:${scope}`,
      output_target_id: outputTargetId,
      after_dispatch_id: `dispatch:${scope}`,
      timestamp_monotonic_ns: 4000,
      process_id: processId,
      passed: true,
      visual_oracle_artifacts: visualArtifacts,
    },
    retirement_event: {
      id: `retire:${scope}`,
      epoch: `epoch:${scope}`,
      timestamp_monotonic_ns: 5000,
      process_id: processId,
      proof: 'stream_event_proven',
    },
    process_identity: {
      process_id: processId,
      runtime_session_id: runtimeSessionId,
    },
    device_identity: { device_uuid: 'gpu:runtime-identity-self-check', backend: 'hip' },
    oracle_artifacts: { visual_oracle_artifacts: visualArtifacts },
    deterministic_visual_mode: deterministicVisualMode,
    metric_clock: 'monotonic_ns',
    metric_scope: 'hot_delta_1',
    cache_state: 'compiler_cache_warm',
    timings,
    model_provenance: {
      split: modelProvenance('split', 'gemini-3.5-flash'),
      gpu_delta: modelProvenance('gpu_delta', 'gemini-3.1-flash-lite'),
    },
    evidence_refs: [evidenceRef],
    cpu_hmr_used: false,
    full_rebuild_used: false,
    process_restarted: false,
    cpu_hmr_used_evidence_present: true,
    full_rebuild_used_evidence_present: true,
    process_restarted_evidence_present: true,
    firewall_process_id_before: processId,
    firewall_process_id_after: processId,
  });
  const query = queryGpuHmrLedgerInvariants(ledger);
  assert.deepEqual(query.failedInvariants, []);
  assert.equal(query.gpuHmrSuccess, true);
  return {
    query,
    artifactAfterHash,
    editHash,
    evidenceRef,
    processId,
    outputTargetId,
  };
}

function acceptedRow(runtimeIdentity) {
  const materials = strictLedger(runtimeIdentity);
  const record = materials.query.record;
  const ledgerProofId = materials.query.proofId;
  const runtimeProofId = `gpu-runtime-proof:${sha256('runtime-identity-proof').slice('sha256:'.length)}`;
  const acceptanceScope = 'rocm_hip_declared_runtime_profile';
  const runtimeTrace = {
    loaderEvents: [{
      source: 'hipModuleLoadData',
      artifactHash: materials.artifactAfterHash,
      evidenceRefs: [materials.evidenceRef],
    }],
    dispatchEvents: [{
      command: 'hipModuleLaunchKernel',
      dispatchId: record.dispatchEvent.id,
      epoch: record.dispatchEvent.epoch,
      artifactHash: materials.artifactAfterHash,
      evidenceRefs: [materials.evidenceRef],
    }],
    outputEvents: [{
      afterDispatchId: record.outputEvent.afterDispatchId,
      outputTargetId: materials.outputTargetId,
      epoch: record.outputEvent.epoch,
      artifactHash: materials.artifactAfterHash,
      evidenceRefs: [materials.evidenceRef],
    }],
  };
  const runtimeTargetIdentity = {
    schemaVersion: 'synthi.gpu_hmr.runtime_target_identity.v1',
    proofAuthority: 'ledger_or_contract_project_identity_preferred_not_target_label',
    targetId: runtimeIdentity,
    target_id: runtimeIdentity,
    authoritativeRuntimeIdentity: runtimeIdentity,
    authoritative_runtime_identity: runtimeIdentity,
    identitySource: 'ledger_project_id',
    identity_source: 'ledger_project_id',
    projectIdentityAlias: runtimeIdentity,
    project_identity_alias: runtimeIdentity,
    ledgerProjectId: runtimeIdentity,
    ledger_project_id: runtimeIdentity,
    accepted: true,
    acceptedAsRuntimeTargetIdentity: true,
    accepted_as_runtime_target_identity: true,
    failedGates: [],
    failed_gates: [],
  };
  const sourceFirstIngestion = {
    accepted: true,
    targetId: runtimeIdentity,
    target_id: runtimeIdentity,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  };
  const validationProfileEvidence = {
    accepted: true,
    profileId: runtimeIdentity,
    profile_id: runtimeIdentity,
    proofIds: [ledgerProofId, runtimeProofId],
    proof_ids: [ledgerProofId, runtimeProofId],
    evidenceRefs: [runtimeIdentity, materials.evidenceRef],
    evidence_refs: [runtimeIdentity, materials.evidenceRef],
  };
  return {
    schemaVersion: GPU_HMR_VALIDATION_MATRIX_ROW_SCHEMA_VERSION,
    backend: 'hip',
    targetId: runtimeIdentity,
    target_id: runtimeIdentity,
    profileId: runtimeIdentity,
    profile_id: runtimeIdentity,
    fixtureId: runtimeIdentity,
    fixture_id: runtimeIdentity,
    proofMode: 'strict_runtime_ledger',
    matrixOutcome: 'full_runtime_gpu_hmr',
    acceptedForGpuHmr: true,
    gpuHmrSuccess: true,
    refusalProven: false,
    proofChainAccepted: true,
    acceptanceScope,
    acceptance_scope: acceptanceScope,
    claimScope: 'scoped_profile',
    claim_scope: 'scoped_profile',
    generalityClaim: scopedGeneralityClaim(acceptanceScope),
    proofIds: [ledgerProofId, runtimeProofId],
    proof_ids: [ledgerProofId, runtimeProofId],
    ledger: {
      present: true,
      source: 'recomputed_ledger',
      proofId: ledgerProofId,
      proof_id: ledgerProofId,
      gpuHmrSuccess: true,
      gpu_hmr_success: true,
      failedInvariants: [],
      failed_invariants: [],
      record,
    },
    runtimeProofArtifact: {
      present: true,
      proofId: runtimeProofId,
      accepted: true,
      failedGates: [],
    },
    runtimeTargetIdentity,
    runtime_target_identity: runtimeTargetIdentity,
    sourceFirstIngestion,
    source_first_ingestion: sourceFirstIngestion,
    validationProfileEvidence,
    validation_profile_evidence: validationProfileEvidence,
    runtimeTrace,
    runtime_trace: runtimeTrace,
    outputOracleFacet: { accepted: true, kind: 'visual_oracle' },
    output_oracle_facet: { accepted: true, kind: 'visual_oracle' },
    visual: { present: true, required: false, accepted: true },
    runMode: { editHash: materials.editHash, edit_hash: materials.editHash },
    artifactAfterHash: materials.artifactAfterHash,
    artifact_after_hash: materials.artifactAfterHash,
    cpuHmrUsed: false,
    fullRebuildUsed: false,
    processRestarted: false,
  };
}

function withRecomputedRowId(row) {
  const next = clone(row);
  delete next.rowId;
  delete next.row_id;
  next.rowId = recomputeGpuHmrValidationMatrixRowId(next);
  return next;
}

const authoritativeId = 'runtime-identity:authoritative';
const baseline = withRecomputedRowId(acceptedRow(authoritativeId));
const baselineQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [baseline],
});
assert.equal(baselineQuery.accepted, true, JSON.stringify(baselineQuery.failedGates, null, 2));
assert.equal(baselineQuery.summary.acceptedFullRuntimeGpuHmrRows, 1);

const builtBaseline = buildGpuHmrValidationMatrixLedger([baseline], {
  includeInvalidated: true,
  includeUnproven: true,
  latestPerTarget: false,
});
const acceptedBaseline = builtBaseline.rows[0];
assert.equal(acceptedBaseline.safety.accepted, true);
const authoritativeHash =
  recomputeGpuHmrValidationMatrixRuntimeTargetIdentityHash(acceptedBaseline);
assert.match(authoritativeHash, /^sha256:[a-f0-9]{64}$/);

const diagnosticRelabel = clone(acceptedBaseline);
diagnosticRelabel.profileId = 'diagnostic-profile-alias';
diagnosticRelabel.profile_id = 'diagnostic-profile-alias';
diagnosticRelabel.fixtureId = 'diagnostic-fixture-label';
diagnosticRelabel.fixture_id = 'diagnostic-fixture-label';
diagnosticRelabel.validationProfileEvidence.profileId = 'diagnostic-profile-alias';
diagnosticRelabel.validationProfileEvidence.profile_id = 'diagnostic-profile-alias';
diagnosticRelabel.validation_profile_evidence = diagnosticRelabel.validationProfileEvidence;
assert.equal(
  recomputeGpuHmrValidationMatrixRuntimeTargetIdentityHash(diagnosticRelabel),
  authoritativeHash,
);

const replayTarget = 'runtime-identity:retargeted-diagnostic';
const replay = clone(acceptedBaseline);
replay.targetId = replayTarget;
replay.target_id = replayTarget;
replay.profileId = replayTarget;
replay.profile_id = replayTarget;
replay.fixtureId = replayTarget;
replay.fixture_id = replayTarget;
replay.sourceFirstIngestion.targetId = replayTarget;
replay.sourceFirstIngestion.target_id = replayTarget;
replay.source_first_ingestion = replay.sourceFirstIngestion;
replay.validationProfileEvidence.accepted = true;
replay.validationProfileEvidence.profileId = replayTarget;
replay.validationProfileEvidence.profile_id = replayTarget;
replay.validationProfileEvidence.proofIds = [...acceptedBaseline.proofIds];
replay.validationProfileEvidence.proof_ids = [...acceptedBaseline.proofIds];
replay.validationProfileEvidence.evidenceRefs = [
  replayTarget,
  ...acceptedBaseline.validationProfileEvidence.evidenceRefs,
];
replay.validationProfileEvidence.evidence_refs =
  replay.validationProfileEvidence.evidenceRefs;
replay.validation_profile_evidence = replay.validationProfileEvidence;
replay.runtimeTargetIdentity.targetId = replayTarget;
replay.runtimeTargetIdentity.target_id = replayTarget;
replay.runtimeTargetIdentity.authoritativeRuntimeIdentity = replayTarget;
replay.runtimeTargetIdentity.authoritative_runtime_identity = replayTarget;
replay.runtimeTargetIdentity.projectIdentityAlias = replayTarget;
replay.runtimeTargetIdentity.project_identity_alias = replayTarget;
replay.runtimeTargetIdentity.ledgerProjectId = replayTarget;
replay.runtimeTargetIdentity.ledger_project_id = replayTarget;
replay.runtimeTargetIdentity.accepted = true;
replay.runtimeTargetIdentity.acceptedAsRuntimeTargetIdentity = true;
replay.runtimeTargetIdentity.accepted_as_runtime_target_identity = true;
replay.runtime_target_identity = replay.runtimeTargetIdentity;
delete replay.fullRuntimeRowIdentityBinding;
delete replay.full_runtime_row_identity_binding;
delete replay.safety;
const replayWithId = withRecomputedRowId(replay);
const replayQuery = queryGpuHmrValidationMatrixLedger({
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  rows: [replayWithId],
});
assert.equal(replayQuery.accepted, false);
assert.equal(replayQuery.summary.acceptedFullRuntimeGpuHmrRows, 0);
assert.equal(
  recomputeGpuHmrValidationMatrixRuntimeTargetIdentityHash({
    ...replayWithId,
    safety: { accepted: true, failedGates: [] },
  }),
  null,
);
const replayFailureCodes = new Set(replayQuery.failedGates.map((gate) => gate.code));
assert.ok(replayFailureCodes.has('gpu_hmr_success_requires_row_target_bound_to_ledger_record'));
assert.ok(replayFailureCodes.has(
  'gpu_hmr_success_requires_source_first_target_bound_to_authoritative_runtime_identity',
));
assert.ok(replayFailureCodes.has(
  'gpu_hmr_success_requires_runtime_target_identity_bound_to_authoritative_runtime_identity',
));
assert.deepEqual(replayWithId.proofIds, acceptedBaseline.proofIds);
assert.equal(replayWithId.ledger.proofId, acceptedBaseline.ledger.proofId);
assert.equal(
  replayWithId.runtimeProofArtifact.proofId,
  acceptedBaseline.runtimeProofArtifact.proofId,
);

console.log('gpu hmr validation matrix runtime identity alias self-check: ok');
