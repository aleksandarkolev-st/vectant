import {
  classifyGpuHmrVisualEvidenceStats,
  evaluateGpuHmrDeterministicVisualMode,
  screenshotQualifiesAsVisualEvidence,
  visualEvidenceAcceptedAsRuntimeProof,
  visualEvidenceIsSupplementalOnly,
  visualEvidenceRow,
} from './gpu-hmr-visual-evidence.mjs';
import { queryGpuHmrLedgerInvariants } from './gpu-hmr-proof-ledger.mjs';
import {
  deriveGpuHmrAcceptanceContractFromVerifiedProofs,
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
} from './gpu-hmr-acceptance-contract.mjs';

export const GPU_HMR_VALIDATION_PROOF_SUMMARY_SCHEMA_VERSION =
  'synthi.gpu.hmr.validation-proof-summary.v1';

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function compactObjects(values) {
  return (Array.isArray(values) ? values : [])
    .filter(isObject);
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function directProofArtifactPaths(proof) {
  if (!isObject(proof)) return [];
  return compactStringList([
    proof.proofArtifactPath,
    proof.proof_artifact_path,
    ...(Array.isArray(proof.proofArtifactPaths) ? proof.proofArtifactPaths : []),
    ...(Array.isArray(proof.proof_artifact_paths) ? proof.proof_artifact_paths : []),
  ]);
}

function proofRecordPaths(records) {
  return compactObjects(records).flatMap((record) => directProofArtifactPaths(record).concat([
    record.path,
    record.filePath,
    record.file_path,
  ]));
}

function dockerContainerMap(validationContext, dockerMetadata) {
  const docker = isObject(dockerMetadata)
    ? dockerMetadata
    : isObject(validationContext?.docker)
      ? validationContext.docker
      : null;
  if (isObject(docker?.containers)) return docker.containers;
  if (
    isObject(docker)
    && Object.values(docker).some((container) => isObject(container) && (
      typeof container.image_id === 'string'
      || typeof container.imageId === 'string'
      || typeof container.image === 'string'
    ))
  ) {
    return docker;
  }
  return {};
}

function dockerImageIds(validationContext, dockerMetadata) {
  const images = {};
  for (const [role, container] of Object.entries(dockerContainerMap(validationContext, dockerMetadata))) {
    if (!isObject(container)) continue;
    const imageId = firstString(container.image_id, container.imageId, container.image);
    if (imageId) images[role] = imageId;
  }
  return images;
}

function dockerContainerStates(validationContext, dockerMetadata) {
  const states = {};
  for (const [role, container] of Object.entries(dockerContainerMap(validationContext, dockerMetadata))) {
    if (!isObject(container)) continue;
    states[role] = {
      container: firstString(container.container, container.name) ?? role,
      status: firstString(container.status, container.state) ?? null,
      image_id: firstString(container.image_id, container.imageId, container.image) ?? null,
      restart_count: Number.isFinite(container.restart_count) ? container.restart_count : null,
      exit_code: Number.isFinite(container.exit_code) ? container.exit_code : null,
      available: container.available === true,
    };
  }
  return states;
}

function blockedStagesFromProof(proof) {
  if (!Array.isArray(proof?.stages)) return [];
  return proof.stages
    .filter((stage) => isObject(stage))
    .filter((stage) => stage.status !== 'passed' || stage.degradedState || stage.degradedReason)
    .map((stage) => ({
      stage_id: stage.stageId ?? null,
      status: stage.status ?? null,
      required_state: stage.requiredState ?? null,
      observed_state: stage.observedState ?? null,
      degraded_state: stage.degradedState ?? null,
      degraded_reason: stage.degradedReason ?? null,
    }));
}

function proofState(proof) {
  if (!isObject(proof)) return null;
  const state = {
    result_state: proof.resultState ?? null,
    degraded_state: proof.degradedState ?? null,
    degraded_reason: proof.degradedReason ?? null,
  };
  const proofId = firstString(proof.proofId, proof.proof_id);
  if (proofId) state.proof_id = proofId;
  const artifactPaths = directProofArtifactPaths(proof);
  if (artifactPaths.length) state.proof_artifact_paths = artifactPaths;
  if (Object.prototype.hasOwnProperty.call(proof, 'fullRuntimeProven')) {
    state.full_runtime_proven = proof.fullRuntimeProven === true;
  }
  const runtimeSessionIds = compactStringList([
    proof.runtimeSessionId,
    proof.runtime_session_id,
    ...(Array.isArray(proof.runtimeSessionIds) ? proof.runtimeSessionIds : []),
    ...(Array.isArray(proof.runtime_session_ids) ? proof.runtime_session_ids : []),
  ]);
  if (runtimeSessionIds.length) state.runtime_session_ids = runtimeSessionIds;
  const blockedStages = blockedStagesFromProof(proof);
  if (blockedStages.length) state.blocked_stages = blockedStages;
  return state;
}

function proofArrayStates(entries, proofField = 'proof') {
  return compactObjects(entries)
    .map((entry) => {
      const proof = isObject(entry[proofField]) ? entry[proofField] : entry;
      const state = proofState(proof);
      if (!state) return null;
      return {
        phase: entry.phase ?? null,
        name: entry.name ?? null,
        ...state,
      };
    })
    .filter(Boolean);
}

function limitationFromProof(stageId, proof) {
  if (!isObject(proof)) return null;
  if (!proof.degradedState && !proof.degradedReason) return null;
  return {
    stage_id: stageId,
    status: proof.resultState ? 'degraded' : 'blocked',
    required_state: null,
    observed_state: proof.resultState ?? null,
    degraded_state: proof.degradedState ?? null,
    degraded_reason: proof.degradedReason ?? null,
  };
}

function limitationsFromRuntimeArtifacts(records) {
  return compactObjects(records)
    .flatMap((record) => compactObjects(record.limitations).map((limitation) => ({
      stage_id: limitation.stageId ?? limitation.stage_id ?? null,
      status: limitation.status ?? null,
      required_state: limitation.requiredState ?? limitation.required_state ?? null,
      observed_state: limitation.observedState ?? limitation.observed_state ?? null,
      degraded_state: limitation.degradedState ?? limitation.degraded_state ?? null,
      degraded_reason: limitation.degradedReason ?? limitation.degraded_reason ?? null,
      proof_artifact_path: record.path ?? null,
      phase: record.phase ?? null,
      name: record.name ?? null,
    })));
}

function realRocmMissingDependencyProbeLimitations(probe) {
  if (!isObject(probe)) return [];
  const acceptedForGpuHmr =
    probe.acceptedForGpuHmr === true || probe.accepted_for_gpu_hmr === true;
  const gpuHmrSuccess =
    probe.gpuHmrSuccess === true || probe.gpu_hmr_success === true;
  const canSatisfyRuntimeProof =
    probe.canSatisfyRuntimeProof === true || probe.can_satisfy_runtime_proof === true;
  const failedGates = compactStringList([
    ...(Array.isArray(probe.failedGates) ? probe.failedGates : []),
    ...(Array.isArray(probe.failed_gates) ? probe.failed_gates : []),
    acceptedForGpuHmr ? 'missing_dependency_probe_claimed_gpu_hmr_acceptance' : null,
    gpuHmrSuccess ? 'missing_dependency_probe_claimed_gpu_hmr_success' : null,
    canSatisfyRuntimeProof ? 'missing_dependency_probe_claimed_runtime_authority' : null,
  ]);
  const blockingGaps = compactStringList([
    ...(Array.isArray(probe.blockingGaps) ? probe.blockingGaps : []),
    ...(Array.isArray(probe.blocking_gaps) ? probe.blocking_gaps : []),
    ...failedGates,
    failedGates.length === 0 ? 'real_rocm_missing_dependency_probe_present' : null,
  ]);
  const observedState = firstString(
    probe.status,
    probe.reason,
    failedGates[0],
    'real_rocm_missing_dependency_probe_present',
  );
  return [{
    stage_id: 'real-rocm-missing-dependency-probe',
    status: 'blocked',
    required_state: 'gpu-hmr-real-rocm-dependencies-satisfied',
    observed_state: observedState,
    degraded_state: 'gpu-hmr-real-rocm-build-prerequisite-missing',
    degraded_reason: observedState,
    blocking_gaps: blockingGaps,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function uniqueLimitations(limitations) {
  const seen = new Set();
  return limitations.filter((limitation) => {
    if (!isObject(limitation)) return false;
    const key = [
      limitation.stage_id,
      limitation.status,
      limitation.observed_state,
      limitation.degraded_state,
      limitation.degraded_reason,
      limitation.phase,
      limitation.name,
    ].map((value) => value ?? '').join('\0');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function screenshotPaths(input) {
  return compactStringList([
    ...(Array.isArray(input.visualArtifactPaths) ? input.visualArtifactPaths : []),
    ...(Array.isArray(input.visual_artifact_paths) ? input.visual_artifact_paths : []),
    ...(Array.isArray(input.screenshotArtifactPaths) ? input.screenshotArtifactPaths : []),
    ...(Array.isArray(input.screenshot_artifact_paths) ? input.screenshot_artifact_paths : []),
    ...compactObjects(input.screenshots).map((shot) => shot.path),
    ...compactObjects(input.screenshots).map((shot) => shot.filePath),
    ...compactObjects(input.screenshots).map((shot) => shot.file_path),
  ]);
}

function visualArtifactPaths(input) {
  const artifacts = compactObjects([
    ...(Array.isArray(input.visualEvidenceArtifacts) ? input.visualEvidenceArtifacts : []),
    ...(Array.isArray(input.visual_evidence_artifacts) ? input.visual_evidence_artifacts : []),
  ]);
  const supplementalArtifactKeys = new Set(compactStringList(artifacts
    .filter(visualEvidenceIsSupplementalOnly)
    .flatMap((artifact) => [
      artifact.path,
      artifact.filePath,
      artifact.file_path,
      artifact.evidenceId,
      artifact.evidence_id,
      artifact.contentHash,
      artifact.content_hash,
    ])));
  const explicit = compactStringList([
    ...(Array.isArray(input.visualArtifactPaths) ? input.visualArtifactPaths : []),
    ...(Array.isArray(input.visual_artifact_paths) ? input.visual_artifact_paths : []),
  ]).filter((artifactPath) => !supplementalArtifactKeys.has(artifactPath));
  const artifactPaths = artifacts
    .filter((artifact) => visualEvidenceAcceptedAsRuntimeProof(artifact))
    .flatMap((artifact) => [artifact.path, artifact.filePath, artifact.file_path]);
  const screenshots = compactObjects(input.screenshots)
    .map((shot) => visualEvidenceRow(shot))
    .filter((shot) => visualEvidenceAcceptedAsRuntimeProof(shot))
    .flatMap((shot) => [shot.path, shot.filePath, shot.file_path]);
  return compactStringList([...explicit, ...artifactPaths, ...screenshots]);
}

function visualEvidenceQuality(input) {
  const explicitPaths = compactStringList([
    ...(Array.isArray(input.visualArtifactPaths) ? input.visualArtifactPaths : []),
    ...(Array.isArray(input.visual_artifact_paths) ? input.visual_artifact_paths : []),
  ]);
  const measured = compactObjects(input.screenshots).map((shot) => {
    const row = visualEvidenceRow(shot);
    return {
      label: row.label ?? null,
      path: firstString(row.path, row.filePath, row.file_path),
      width: row.width,
      height: row.height,
      visible_pixels: row.visible_pixels,
      mean_luma: row.mean_luma,
      luma_stddev: row.luma_stddev,
      rgb_span_mean: row.rgb_span_mean,
      unique_color_sample_count: row.unique_color_sample_count,
      visual_quality: row.visual_quality,
      accepted_as_visual_evidence: row.accepted_as_visual_evidence,
      accepted_as_image_evidence: row.accepted_as_image_evidence,
      accepted_as_runtime_visual_proof: row.accepted_as_runtime_visual_proof,
      runtime_visual_proof_binding: row.runtime_visual_proof_binding ?? row.runtimeVisualProofBinding ?? null,
      visual_evidence_supplemental_only:
        row.visualEvidenceSupplementalOnly === true
        || row.visual_evidence_supplemental_only === true,
    };
  });
  const measuredPaths = new Set(measured.map((row) => row.path).filter(Boolean));
  const unmeasured = explicitPaths
    .filter((artifactPath) => !measuredPaths.has(artifactPath))
    .map((artifactPath) => ({
      label: null,
      path: artifactPath,
      width: null,
      height: null,
      visible_pixels: null,
      mean_luma: null,
      luma_stddev: null,
      rgb_span_mean: null,
      unique_color_sample_count: null,
      visual_quality: 'gpu-hmr-visual-unmeasured',
      accepted_as_visual_evidence: false,
      accepted_as_image_evidence: false,
      accepted_as_runtime_visual_proof: false,
      runtime_visual_proof_binding: null,
      visual_evidence_supplemental_only: false,
    }));
  return [...measured, ...unmeasured];
}

function visualEvidenceLimitations(qualityRows) {
  return compactObjects(qualityRows)
    .filter((row) => {
      const quality = row.visual_quality ?? classifyGpuHmrVisualEvidenceStats(row);
      return quality === 'gpu-hmr-visual-flat-frame'
        || quality === 'gpu-hmr-visual-low-visible-pixels'
        || quality === 'gpu-hmr-visual-too-small';
    })
    .map((row) => ({
      stage_id: 'visual-evidence',
      status: 'diagnostic',
      required_state: 'gpu-hmr-visual-varied-frame',
      observed_state: row.visual_quality ?? classifyGpuHmrVisualEvidenceStats(row),
      degraded_state: row.visual_quality ?? classifyGpuHmrVisualEvidenceStats(row),
      degraded_reason: 'visual_evidence_low_variance',
      proof_artifact_path: null,
      phase: row.label ?? null,
      name: null,
    }));
}

function visualEvidenceExpected(input) {
  return input.visualEvidenceExpected === true
    || input.visual_evidence_expected === true
    || input.visualEvidenceRequired === true
    || input.visual_evidence_required === true;
}

function targetProgression(input, validationContext) {
  if (isObject(input.targetProgression)) return input.targetProgression;
  if (isObject(input.target_progression)) return input.target_progression;
  if (isObject(validationContext?.target_progression)) return validationContext.target_progression;
  if (isObject(validationContext?.targetProgression)) return validationContext.targetProgression;
  return null;
}

function targetProgressionLedger(input, validationContext) {
  if (isObject(input.targetProgressionLedger)) return input.targetProgressionLedger;
  if (isObject(input.target_progression_ledger)) return input.target_progression_ledger;
  if (isObject(validationContext?.target_progression_ledger)) {
    return validationContext.target_progression_ledger;
  }
  if (isObject(validationContext?.targetProgressionLedger)) {
    return validationContext.targetProgressionLedger;
  }
  return null;
}

function targetProgressionLedgerEntry(input, validationContext) {
  if (isObject(input.targetProgressionLedgerEntry)) return input.targetProgressionLedgerEntry;
  if (isObject(input.target_progression_ledger_entry)) return input.target_progression_ledger_entry;
  if (isObject(validationContext?.target_progression_ledger_entry)) {
    return validationContext.target_progression_ledger_entry;
  }
  if (isObject(validationContext?.targetProgressionLedgerEntry)) {
    return validationContext.targetProgressionLedgerEntry;
  }
  return null;
}

function targetProgressionLedgerArtifact(input, validationContext) {
  if (isObject(input.targetProgressionLedgerArtifact)) return input.targetProgressionLedgerArtifact;
  if (isObject(input.target_progression_ledger_artifact)) {
    return input.target_progression_ledger_artifact;
  }
  if (isObject(validationContext?.target_progression_ledger_artifact)) {
    return validationContext.target_progression_ledger_artifact;
  }
  if (isObject(validationContext?.targetProgressionLedgerArtifact)) {
    return validationContext.targetProgressionLedgerArtifact;
  }
  return null;
}

function targetProgressionGates(input, validationContext) {
  const gates = input.targetProgressionGates
    ?? input.target_progression_gates
    ?? validationContext?.targetProgressionGates
    ?? validationContext?.target_progression_gates
    ?? [];
  return Array.isArray(gates) ? compactObjects(gates) : [];
}

function realRocmAppHookMaterialization(input, validationContext) {
  if (isObject(input.realRocmAppHookMaterialization)) return input.realRocmAppHookMaterialization;
  if (isObject(input.real_rocm_app_hook_materialization)) return input.real_rocm_app_hook_materialization;
  if (isObject(input.appHookMaterialization)) return input.appHookMaterialization;
  if (isObject(input.app_hook_materialization)) return input.app_hook_materialization;
  if (isObject(validationContext?.realRocmAppHookMaterialization)) {
    return validationContext.realRocmAppHookMaterialization;
  }
  if (isObject(validationContext?.real_rocm_app_hook_materialization)) {
    return validationContext.real_rocm_app_hook_materialization;
  }
  if (isObject(validationContext?.appHookMaterialization)) return validationContext.appHookMaterialization;
  if (isObject(validationContext?.app_hook_materialization)) return validationContext.app_hook_materialization;
  return null;
}

function realRocmRuntimeProfileAdapterResult(input, validationContext) {
  if (isObject(input.realRocmRuntimeProfileAdapterResult)) return input.realRocmRuntimeProfileAdapterResult;
  if (isObject(input.real_rocm_runtime_profile_adapter_result)) {
    return input.real_rocm_runtime_profile_adapter_result;
  }
  if (isObject(input.runtimeProfileAdapterResult)) return input.runtimeProfileAdapterResult;
  if (isObject(input.runtime_profile_adapter_result)) return input.runtime_profile_adapter_result;
  if (isObject(validationContext?.realRocmRuntimeProfileAdapterResult)) {
    return validationContext.realRocmRuntimeProfileAdapterResult;
  }
  if (isObject(validationContext?.real_rocm_runtime_profile_adapter_result)) {
    return validationContext.real_rocm_runtime_profile_adapter_result;
  }
  if (isObject(validationContext?.runtimeProfileAdapterResult)) {
    return validationContext.runtimeProfileAdapterResult;
  }
  if (isObject(validationContext?.runtime_profile_adapter_result)) {
    return validationContext.runtime_profile_adapter_result;
  }
  return null;
}

function realRocmMissingDependencyProbe(input, validationContext) {
  if (isObject(input.realRocmMissingDependencyProbe)) return input.realRocmMissingDependencyProbe;
  if (isObject(input.real_rocm_missing_dependency_probe)) return input.real_rocm_missing_dependency_probe;
  if (isObject(input.missingDependencyProbe)) return input.missingDependencyProbe;
  if (isObject(input.missing_dependency_probe)) return input.missing_dependency_probe;
  if (isObject(validationContext?.realRocmMissingDependencyProbe)) {
    return validationContext.realRocmMissingDependencyProbe;
  }
  if (isObject(validationContext?.real_rocm_missing_dependency_probe)) {
    return validationContext.real_rocm_missing_dependency_probe;
  }
  if (isObject(validationContext?.missingDependencyProbe)) return validationContext.missingDependencyProbe;
  if (isObject(validationContext?.missing_dependency_probe)) return validationContext.missing_dependency_probe;
  return null;
}

function targetProgressionGateLimitations(input, validationContext) {
  return targetProgressionGates(input, validationContext)
    .filter((gate) => gate.status === 'fail')
    .map((gate) => ({
      stage_id: 'target-progression',
      status: 'blocked',
      required_state: 'gpu-hmr-target-progression-proven',
      observed_state: null,
      degraded_state: 'gpu-hmr-target-progression-unverified',
      degraded_reason: gate.detail ?? gate.name ?? 'target progression gate failed',
      proof_artifact_path: null,
      phase: null,
      name: gate.name ?? null,
    }));
}

function missingVisualEvidenceLimitation(input, qualityRows) {
  if (!visualEvidenceExpected(input)) return [];
  if (compactObjects(qualityRows).some((row) => visualEvidenceAcceptedAsRuntimeProof(row))) {
    return [];
  }
  return [{
    stage_id: 'visual-evidence',
    status: 'blocked',
    required_state: 'gpu-hmr-visual-varied-frame',
    observed_state: null,
    degraded_state: 'gpu-hmr-visual-evidence-missing',
    degraded_reason: qualityRows.length > 0
      ? 'visual_evidence_not_accepted'
      : 'visual_evidence_not_collected',
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function proofLedgerFromRecord(record) {
  if (!isObject(record)) return null;
  if (isObject(record.proofLedger)) return record.proofLedger;
  if (isObject(record.proof_ledger)) return record.proof_ledger;
  if (isObject(record.artifact?.proofLedger)) return record.artifact.proofLedger;
  if (isObject(record.artifact?.proof_ledger)) return record.artifact.proof_ledger;
  return null;
}

function proofLedgerQueryFromRecord(record) {
  if (!isObject(record)) return null;
  if (isObject(record.proofLedgerQuery)) return record.proofLedgerQuery;
  if (isObject(record.proof_ledger_query)) return record.proof_ledger_query;
  if (isObject(record.artifact?.proofLedgerQuery)) return record.artifact.proofLedgerQuery;
  if (isObject(record.artifact?.proof_ledger_query)) return record.artifact.proof_ledger_query;
  return null;
}

function acceptanceContractFromRecord(record) {
  if (!isObject(record)) return null;
  if (isObject(record.acceptanceContract)) return record.acceptanceContract;
  if (isObject(record.acceptance_contract)) return record.acceptance_contract;
  if (isObject(record.artifact?.acceptanceContract)) return record.artifact.acceptanceContract;
  if (isObject(record.artifact?.acceptance_contract)) return record.artifact.acceptance_contract;
  return null;
}

function acceptanceContractEvaluationFromRecord(record) {
  if (!isObject(record)) return null;
  if (isObject(record.acceptanceContractEvaluation)) return record.acceptanceContractEvaluation;
  if (isObject(record.acceptance_contract_evaluation)) return record.acceptance_contract_evaluation;
  if (isObject(record.artifact?.acceptanceContractEvaluation)) {
    return record.artifact.acceptanceContractEvaluation;
  }
  if (isObject(record.artifact?.acceptance_contract_evaluation)) {
    return record.artifact.acceptance_contract_evaluation;
  }
  return null;
}

function derivedAcceptanceContractFromRecord(record, validationContext) {
  if (!isObject(record)) return null;
  if (isObject(record.derivedAcceptanceContract)) return record.derivedAcceptanceContract;
  if (isObject(record.derived_acceptance_contract)) return record.derived_acceptance_contract;
  if (isObject(record.artifact?.derivedAcceptanceContract)) {
    return record.artifact.derivedAcceptanceContract;
  }
  if (isObject(record.artifact?.derived_acceptance_contract)) {
    return record.artifact.derived_acceptance_contract;
  }
  const material = isObject(record.proofMaterial)
    ? record.proofMaterial
    : isObject(record.proof_material)
      ? record.proof_material
      : isObject(record.artifact?.proofMaterial)
        ? record.artifact.proofMaterial
        : isObject(record.artifact?.proof_material)
          ? record.artifact.proof_material
          : {};
  const materialContext = isObject(material.validationContext)
    ? material.validationContext
    : isObject(material.validation_context)
      ? material.validation_context
      : validationContext;
  return deriveGpuHmrAcceptanceContractFromVerifiedProofs({
    ...record,
    ...material,
    validationContext: materialContext,
    workspaceSlug:
      material.workspaceSlug
      ?? material.workspace_slug
      ?? record.workspaceSlug
      ?? record.workspace_slug,
    backend:
      material.backend
      ?? material.gpuBackend
      ?? material.gpu_backend
      ?? record.backend
      ?? record.gpuBackend
      ?? record.gpu_backend,
  });
}

function acceptanceContractConsistencyFromRecord(record, validationContext) {
  const explicitContract = acceptanceContractFromRecord(record);
  const derivedContract = derivedAcceptanceContractFromRecord(record, validationContext);
  const derivedEvaluation = evaluateGpuHmrAcceptanceContract(derivedContract ?? {});
  return evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract,
    derivedContract,
    derivedEvaluation,
  });
}

function deterministicVisualModeFromRecord(record) {
  if (!isObject(record)) return null;
  if (isObject(record.deterministicVisualMode)) return record.deterministicVisualMode;
  if (isObject(record.deterministic_visual_mode)) return record.deterministic_visual_mode;
  if (isObject(record.artifact?.deterministicVisualMode)) return record.artifact.deterministicVisualMode;
  if (isObject(record.artifact?.deterministic_visual_mode)) {
    return record.artifact.deterministic_visual_mode;
  }
  return null;
}

function deterministicVisualModeEvaluationFromRecord(record) {
  if (!isObject(record)) return null;
  if (isObject(record.deterministicVisualModeEvaluation)) return record.deterministicVisualModeEvaluation;
  if (isObject(record.deterministic_visual_mode_evaluation)) {
    return record.deterministic_visual_mode_evaluation;
  }
  if (isObject(record.artifact?.deterministicVisualModeEvaluation)) {
    return record.artifact.deterministicVisualModeEvaluation;
  }
  if (isObject(record.artifact?.deterministic_visual_mode_evaluation)) {
    return record.artifact.deterministic_visual_mode_evaluation;
  }
  return null;
}

function acceptanceContractLimitations(evaluations) {
  return compactObjects(evaluations)
    .filter((evaluation) => evaluation.accepted !== true)
    .flatMap((evaluation) => compactObjects(evaluation.failedGates).map((gate) => ({
      stage_id: 'acceptance-contract',
      status: 'blocked',
      required_state: 'gpu-hmr-acceptance-contract-verified',
      observed_state: null,
      degraded_state: 'gpu-hmr-acceptance-contract-rejected',
      degraded_reason: gate.code ?? 'acceptance_contract_gate_failed',
      proof_artifact_path: null,
      phase: null,
      name: null,
    })));
}

function acceptanceContractConsistencyLimitations(evaluations) {
  return compactObjects(evaluations)
    .filter((evaluation) => evaluation.accepted !== true)
    .flatMap((evaluation) => compactObjects(evaluation.failedGates).map((gate) => ({
      stage_id: 'acceptance-contract-consistency',
      status: 'blocked',
      required_state: 'gpu-hmr-acceptance-contract-backed-by-verified-proofs',
      observed_state: null,
      degraded_state: 'gpu-hmr-acceptance-contract-mismatch',
      degraded_reason: gate.code ?? 'acceptance_contract_consistency_failed',
      proof_artifact_path: null,
      phase: null,
      name: null,
      field: gate.field ?? null,
      explicit_value: gate.explicit_value ?? gate.explicitValue ?? null,
      derived_value: gate.derived_value ?? gate.derivedValue ?? null,
    })));
}

function deterministicVisualModeLimitations(evaluations) {
  return compactObjects(evaluations)
    .filter((evaluation) => evaluation.accepted !== true)
    .flatMap((evaluation) => compactObjects(evaluation.failedGates).map((gate) => ({
      stage_id: 'deterministic-visual-mode',
      status: 'blocked',
      required_state: 'gpu-hmr-deterministic-visual-mode-proven',
      observed_state: null,
      degraded_state: 'gpu-hmr-deterministic-visual-mode-rejected',
      degraded_reason: gate.code ?? 'deterministic_visual_mode_gate_failed',
      proof_artifact_path: null,
      phase: null,
      name: null,
    })));
}

function proofLedgerLimitations(queries) {
  return compactObjects(queries)
    .filter((query) => query.gpuHmrSuccess !== true)
    .flatMap((query) => compactObjects(query.failedInvariants).map((failure) => ({
      stage_id: 'proof-ledger',
      status: 'blocked',
      required_state: 'gpu-hmr-ledger-invariants-proven',
      observed_state: null,
      degraded_state: 'gpu-hmr-ledger-invariants-failed',
      degraded_reason: failure.code ?? 'proof_ledger_invariant_failed',
      proof_artifact_path: null,
      phase: null,
      name: null,
    })));
}

export function buildGpuHmrValidationProofSummary(input = {}) {
  const validationContext = isObject(input.validationContext)
    ? input.validationContext
    : isObject(input.validation_context)
      ? input.validation_context
      : {};
  const dockerMetadata = isObject(input.docker) ? input.docker : validationContext.docker;
  const runtimeArtifactRecords = compactObjects(input.runtimeProofArtifactRecords)
    .concat(compactObjects(input.runtime_proof_artifacts));
  const proofLedgers = compactObjects([
    input.proofLedger,
    input.proof_ledger,
    ...runtimeArtifactRecords.map(proofLedgerFromRecord),
  ]);
  const suppliedProofLedgerQueries = compactObjects([
    input.proofLedgerQuery,
    input.proof_ledger_query,
    ...runtimeArtifactRecords.map(proofLedgerQueryFromRecord),
  ]);
  const proofLedgerQueries = proofLedgers.length > 0
    ? proofLedgers.map((ledger) => queryGpuHmrLedgerInvariants(ledger))
    : suppliedProofLedgerQueries.map((query) => queryGpuHmrLedgerInvariants(query));
  const proofLedgerQuery = proofLedgerQueries[proofLedgerQueries.length - 1] ?? null;
  const topLevelDerivedAcceptanceContract = deriveGpuHmrAcceptanceContractFromVerifiedProofs({
    ...input,
    validationContext,
  });
  const topLevelDerivedAcceptanceContractEvaluation =
    evaluateGpuHmrAcceptanceContract(topLevelDerivedAcceptanceContract);
  const runtimeDerivedAcceptanceContracts = runtimeArtifactRecords
    .map((record) => derivedAcceptanceContractFromRecord(record, validationContext))
    .filter(isObject);
  const runtimeDerivedAcceptanceContractEvaluations = runtimeDerivedAcceptanceContracts
    .map((contract) => evaluateGpuHmrAcceptanceContract(contract));
  const acceptanceContracts = compactObjects([
    input.acceptanceContract,
    input.acceptance_contract,
    validationContext.acceptanceContract,
    validationContext.acceptance_contract,
    ...runtimeArtifactRecords.map(acceptanceContractFromRecord),
  ]);
  const derivedAcceptanceContract = runtimeDerivedAcceptanceContracts.at(-1)
    ?? topLevelDerivedAcceptanceContract
    ?? null;
  const derivedAcceptanceContractEvaluation = runtimeDerivedAcceptanceContractEvaluations.at(-1)
    ?? topLevelDerivedAcceptanceContractEvaluation
    ?? null;
  if (acceptanceContracts.length === 0 && derivedAcceptanceContract) {
    acceptanceContracts.push(derivedAcceptanceContract);
  }
  const acceptanceContractConsistencyEvaluations = compactObjects([
    input.acceptanceContract || input.acceptance_contract || validationContext.acceptanceContract
      || validationContext.acceptance_contract
      ? evaluateGpuHmrAcceptanceContractConsistency({
          explicitContract: input.acceptanceContract
            ?? input.acceptance_contract
            ?? validationContext.acceptanceContract
            ?? validationContext.acceptance_contract,
          derivedContract: derivedAcceptanceContract,
          derivedEvaluation: derivedAcceptanceContractEvaluation,
        })
      : null,
    ...runtimeArtifactRecords.map((record) =>
      acceptanceContractConsistencyFromRecord(record, validationContext)
    ),
  ]);
  const suppliedAcceptanceEvaluations = compactObjects([
    input.acceptanceContractEvaluation,
    input.acceptance_contract_evaluation,
    validationContext.acceptanceContractEvaluation,
    validationContext.acceptance_contract_evaluation,
    ...runtimeArtifactRecords.map(acceptanceContractEvaluationFromRecord),
  ]);
  const acceptanceContractEvaluations = acceptanceContracts.length > 0
    ? acceptanceContracts.map((contract) => evaluateGpuHmrAcceptanceContract(contract))
    : suppliedAcceptanceEvaluations.length > 0
      ? suppliedAcceptanceEvaluations.map((evaluation) =>
          evaluateGpuHmrAcceptanceContract(evaluation.contract ?? evaluation.acceptanceContract ?? evaluation)
        )
      : [evaluateGpuHmrAcceptanceContract({
          classification: input.classification ?? validationContext.classification ?? {},
        })];
  const acceptanceContractEvaluation =
    acceptanceContractEvaluations[acceptanceContractEvaluations.length - 1] ?? null;
  const acceptanceContract =
    acceptanceContractEvaluation?.contract
      ?? acceptanceContracts[acceptanceContracts.length - 1]
      ?? null;
  const deterministicVisualModes = compactObjects([
    input.deterministicVisualMode,
    input.deterministic_visual_mode,
    validationContext.deterministicVisualMode,
    validationContext.deterministic_visual_mode,
    ...runtimeArtifactRecords.map(deterministicVisualModeFromRecord),
  ]);
  const suppliedDeterministicVisualModeEvaluations = compactObjects([
    input.deterministicVisualModeEvaluation,
    input.deterministic_visual_mode_evaluation,
    validationContext.deterministicVisualModeEvaluation,
    validationContext.deterministic_visual_mode_evaluation,
    ...runtimeArtifactRecords.map(deterministicVisualModeEvaluationFromRecord),
  ]);
  const deterministicVisualModeEvaluations = deterministicVisualModes.length > 0
    ? deterministicVisualModes.map((mode) => evaluateGpuHmrDeterministicVisualMode(mode))
    : suppliedDeterministicVisualModeEvaluations.map((evaluation) =>
        evaluateGpuHmrDeterministicVisualMode(evaluation.mode ?? evaluation.deterministicVisualMode ?? evaluation)
      );
  const deterministicVisualModeEvaluation =
    deterministicVisualModeEvaluations[deterministicVisualModeEvaluations.length - 1] ?? null;
  const deterministicVisualMode =
    deterministicVisualModeEvaluation?.mode
      ?? deterministicVisualModes[deterministicVisualModes.length - 1]
      ?? null;
  const proofArtifactPaths = compactStringList([
    ...(Array.isArray(input.proofArtifactPaths) ? input.proofArtifactPaths : []),
    ...(Array.isArray(input.proof_artifact_paths) ? input.proof_artifact_paths : []),
    ...proofRecordPaths(input.proofArtifacts),
    ...proofRecordPaths(input.proof_artifacts),
    ...proofRecordPaths(runtimeArtifactRecords),
    ...directProofArtifactPaths(input.sourceProof),
    ...compactObjects(input.sourceProofs).flatMap(directProofArtifactPaths),
    ...directProofArtifactPaths(input.fissionProof),
    ...directProofArtifactPaths(input.abiProof),
    ...directProofArtifactPaths(input.artifactTransportProof),
    ...directProofArtifactPaths(input.epochProof),
    ...directProofArtifactPaths(input.dispatchProof),
    ...directProofArtifactPaths(input.outputProof),
    ...directProofArtifactPaths(input.hostPreservationProof),
    ...directProofArtifactPaths(input.originalHostPathProof),
    ...directProofArtifactPaths(input.fullRuntimeProof),
  ]);
  const runtimeProofArtifactPaths = compactStringList([
    ...(Array.isArray(input.runtimeProofArtifactPaths) ? input.runtimeProofArtifactPaths : []),
    ...(Array.isArray(input.runtime_proof_artifact_paths) ? input.runtime_proof_artifact_paths : []),
    ...proofRecordPaths(runtimeArtifactRecords),
  ]);
  const fullRuntimeStates = proofArrayStates(input.runtimeFullProofs);
  const qualityRows = visualEvidenceQuality(input);
  const progressionGates = targetProgressionGates(input, validationContext);
  const appHookMaterialization = compactObjects([
    realRocmAppHookMaterialization(input, validationContext),
    ...runtimeArtifactRecords.map((record) =>
      record.realRocmAppHookMaterialization
      ?? record.real_rocm_app_hook_materialization
      ?? record.appHookMaterialization
      ?? record.app_hook_materialization
      ?? null
    ),
  ]).at(-1) ?? null;
  const runtimeProfileAdapterResult = compactObjects([
    realRocmRuntimeProfileAdapterResult(input, validationContext),
    ...runtimeArtifactRecords.map((record) =>
      record.realRocmRuntimeProfileAdapterResult
      ?? record.real_rocm_runtime_profile_adapter_result
      ?? record.runtimeProfileAdapterResult
      ?? record.runtime_profile_adapter_result
      ?? null
    ),
  ]).at(-1) ?? null;
  const missingDependencyProbe = compactObjects([
    realRocmMissingDependencyProbe(input, validationContext),
    ...runtimeArtifactRecords.map((record) =>
      record.realRocmMissingDependencyProbe
      ?? record.real_rocm_missing_dependency_probe
      ?? record.missingDependencyProbe
      ?? record.missing_dependency_probe
      ?? null
    ),
  ]).at(-1) ?? null;
  const limitations = uniqueLimitations([
    ...limitationsFromRuntimeArtifacts(runtimeArtifactRecords),
    ...realRocmMissingDependencyProbeLimitations(missingDependencyProbe),
    ...acceptanceContractLimitations(acceptanceContractEvaluations),
    ...acceptanceContractConsistencyLimitations(acceptanceContractConsistencyEvaluations),
    ...deterministicVisualModeLimitations(deterministicVisualModeEvaluations),
    ...proofLedgerLimitations(proofLedgerQueries),
    ...targetProgressionGateLimitations(input, validationContext),
    ...visualEvidenceLimitations(qualityRows),
    ...missingVisualEvidenceLimitation(input, qualityRows),
    ...blockedStagesFromProof(input.fullRuntimeProof).map((stage) => ({
      ...stage,
      proof_artifact_path: input.runtimeProofArtifactPath ?? input.runtime_proof_artifact_path ?? null,
    })),
    ...compactObjects(input.runtimeFullProofs).flatMap((entry) =>
      blockedStagesFromProof(entry.proof).map((stage) => ({
        ...stage,
        phase: entry.phase ?? null,
        name: entry.name ?? null,
      }))
    ),
    limitationFromProof('source', input.sourceProof),
    limitationFromProof('fission', input.fissionProof),
    limitationFromProof('abi', input.abiProof),
    limitationFromProof('artifact-transport', input.artifactTransportProof),
    limitationFromProof('epoch-swap', input.epochProof),
    limitationFromProof('dispatch', input.dispatchProof),
    limitationFromProof('output', input.outputProof),
    limitationFromProof('host-preservation', input.hostPreservationProof),
    limitationFromProof('original-host-path', input.originalHostPathProof),
    limitationFromProof('full-runtime', input.fullRuntimeProof),
  ]);
  const directFullRuntimeProven = input.fullRuntimeProof
    ? input.fullRuntimeProof.fullRuntimeProven === true
    : null;
  const runtimeArtifactsFullRuntimeProven = runtimeArtifactRecords.length > 0
    ? runtimeArtifactRecords.every((record) =>
        record.fullRuntimeProven === true
        && (record.gpuHmrSuccess === true || record.gpu_hmr_success === true)
      )
    : null;
  const fullRuntimeProven = directFullRuntimeProven
    ?? runtimeArtifactsFullRuntimeProven
    ?? (fullRuntimeStates.length > 0 && fullRuntimeStates.every((state) => state.full_runtime_proven === true));
  const acceptanceContractConsistencyAccepted = acceptanceContractConsistencyEvaluations.length > 0
    && acceptanceContractConsistencyEvaluations.every((evaluation) => evaluation.accepted === true);
  const gpuHmrSuccess = fullRuntimeProven === true
    && limitations.length === 0
    && proofLedgerQuery?.gpuHmrSuccess === true
    && acceptanceContractEvaluation?.accepted === true
    && acceptanceContractConsistencyAccepted
    && (
      deterministicVisualModeEvaluation
        ? deterministicVisualModeEvaluation.accepted === true
        : true
    );

  return {
    schema_version: GPU_HMR_VALIDATION_PROOF_SUMMARY_SCHEMA_VERSION,
    workspace_slug: input.workspaceSlug ?? input.workspace_slug ?? null,
    model: input.model ?? validationContext.model ?? null,
    gpu_vendor: input.gpuVendor ?? input.gpu_vendor ?? validationContext.gpu_vendor ?? null,
    gpu_arch: input.gpuArch ?? input.gpu_arch ?? validationContext.gpu_arch ?? null,
    timings: isObject(input.timings)
      ? input.timings
      : isObject(validationContext.timings)
        ? validationContext.timings
        : null,
    docker_image_ids: dockerImageIds(validationContext, dockerMetadata),
    docker_container_states: dockerContainerStates(validationContext, dockerMetadata),
    screenshot_artifact_paths: screenshotPaths(input),
    visual_artifact_paths: visualArtifactPaths(input),
    visual_evidence_quality: qualityRows,
    proof_artifact_paths: proofArtifactPaths,
    runtime_proof_artifact_paths: runtimeProofArtifactPaths,
    target_progression: targetProgression(input, validationContext),
    target_progression_ledger: targetProgressionLedger(input, validationContext),
    target_progression_ledger_entry: targetProgressionLedgerEntry(input, validationContext),
    target_progression_ledger_artifact: targetProgressionLedgerArtifact(input, validationContext),
    target_progression_gates: progressionGates,
    proof_states: {
      source: proofArrayStates(input.sourceProofs ?? (input.sourceProof ? [input.sourceProof] : [])),
      fission: proofState(input.fissionProof),
      abi: proofState(input.abiProof),
      artifact_transport: proofState(input.artifactTransportProof),
      epoch_swap: proofState(input.epochProof),
      dispatch: proofState(input.dispatchProof),
      output: proofState(input.outputProof),
      host_preservation: proofState(input.hostPreservationProof),
      original_host_path: proofState(input.originalHostPathProof),
      full_runtime: proofState(input.fullRuntimeProof),
      runtime_full: fullRuntimeStates,
      proof_ledger: proofLedgerQuery
        ? {
            gpu_hmr_success: proofLedgerQuery.gpuHmrSuccess === true,
            failed_invariant_count: compactObjects(proofLedgerQuery.failedInvariants).length,
            warning_count: compactObjects(proofLedgerQuery.warnings).length,
          }
        : null,
      acceptance_contract: acceptanceContractEvaluation
        ? {
            accepted: acceptanceContractEvaluation.accepted === true,
            failed_gate_count: compactObjects(acceptanceContractEvaluation.failedGates).length,
            warning_count: compactObjects(acceptanceContractEvaluation.warnings).length,
            contract_hash: acceptanceContractEvaluation.contract?.contract_hash ?? null,
        }
        : null,
      acceptance_contract_consistency: acceptanceContractConsistencyEvaluations.length > 0
        ? {
            accepted: acceptanceContractConsistencyEvaluations.every((evaluation) =>
              evaluation.accepted === true
            ),
            checked_count: acceptanceContractConsistencyEvaluations.filter((evaluation) =>
              evaluation.checked === true
            ).length,
            failed_gate_count: acceptanceContractConsistencyEvaluations
              .flatMap((evaluation) => compactObjects(evaluation.failedGates))
              .length,
          }
        : null,
      deterministic_visual_mode: deterministicVisualModeEvaluation
        ? {
            accepted: deterministicVisualModeEvaluation.accepted === true,
            failed_gate_count: compactObjects(deterministicVisualModeEvaluation.failedGates).length,
            warning_count: compactObjects(deterministicVisualModeEvaluation.warnings).length,
            proof_mode: deterministicVisualModeEvaluation.proofMode ?? null,
          }
        : null,
      real_rocm_app_hook_materialization: appHookMaterialization
        ? {
            required: appHookMaterialization.required === true,
            accepted_as_refusal_evidence:
              appHookMaterialization.acceptedAsRefusalEvidence === true
              || appHookMaterialization.accepted_as_refusal_evidence === true,
            accepted_for_gpu_hmr:
              appHookMaterialization.acceptedForGpuHmr === true
              || appHookMaterialization.accepted_for_gpu_hmr === true,
            gpu_hmr_success:
              appHookMaterialization.gpuHmrSuccess === true
              || appHookMaterialization.gpu_hmr_success === true,
            can_satisfy_runtime_proof:
              appHookMaterialization.canSatisfyRuntimeProof === true
              || appHookMaterialization.can_satisfy_runtime_proof === true,
            materialization_complete:
              appHookMaterialization.materializationComplete === true
              || appHookMaterialization.materialization_complete === true,
            blocking_gap_count: compactStringList([
              ...(Array.isArray(appHookMaterialization.blockingGaps)
                ? appHookMaterialization.blockingGaps
                : []),
              ...(Array.isArray(appHookMaterialization.blocking_gaps)
                ? appHookMaterialization.blocking_gaps
                : []),
            ]).length,
            status: appHookMaterialization.status ?? null,
          }
        : null,
      real_rocm_runtime_profile_adapter_result: runtimeProfileAdapterResult
        ? {
            declared: runtimeProfileAdapterResult.declared === true,
            present: runtimeProfileAdapterResult.present === true,
            accepted_as_refusal_evidence:
              runtimeProfileAdapterResult.acceptedAsRefusalEvidence === true
              || runtimeProfileAdapterResult.accepted_as_refusal_evidence === true,
            accepted_for_gpu_hmr:
              runtimeProfileAdapterResult.acceptedForGpuHmr === true
              || runtimeProfileAdapterResult.accepted_for_gpu_hmr === true,
            gpu_hmr_success:
              runtimeProfileAdapterResult.gpuHmrSuccess === true
              || runtimeProfileAdapterResult.gpu_hmr_success === true,
            can_satisfy_runtime_proof:
              runtimeProfileAdapterResult.canSatisfyRuntimeProof === true
              || runtimeProfileAdapterResult.can_satisfy_runtime_proof === true,
            strict_runtime_proof_accepted:
              runtimeProfileAdapterResult.strictRuntimeProofAccepted === true
              || runtimeProfileAdapterResult.strict_runtime_proof_accepted === true,
            strict_runtime_proof_id:
              runtimeProfileAdapterResult.strictRuntimeProofId
              ?? runtimeProfileAdapterResult.strict_runtime_proof_id
              ?? null,
            adapter_result_hash:
              runtimeProfileAdapterResult.adapterResultHash
              ?? runtimeProfileAdapterResult.adapter_result_hash
              ?? null,
            blocking_gap_count: compactStringList([
              ...(Array.isArray(runtimeProfileAdapterResult.blockingGaps)
                ? runtimeProfileAdapterResult.blockingGaps
                : []),
              ...(Array.isArray(runtimeProfileAdapterResult.blocking_gaps)
                ? runtimeProfileAdapterResult.blocking_gaps
                : []),
            ]).length,
            status: runtimeProfileAdapterResult.status ?? null,
          }
        : null,
      real_rocm_missing_dependency_probe: missingDependencyProbe
        ? {
            accepted_as_refusal_evidence:
              missingDependencyProbe.acceptedAsRefusalEvidence === true
              || missingDependencyProbe.accepted_as_refusal_evidence === true,
            accepted_for_gpu_hmr:
              missingDependencyProbe.acceptedForGpuHmr === true
              || missingDependencyProbe.accepted_for_gpu_hmr === true,
            gpu_hmr_success:
              missingDependencyProbe.gpuHmrSuccess === true
              || missingDependencyProbe.gpu_hmr_success === true,
            can_satisfy_runtime_proof:
              missingDependencyProbe.canSatisfyRuntimeProof === true
              || missingDependencyProbe.can_satisfy_runtime_proof === true,
            dependency_count:
              missingDependencyProbe.dependencyCount
              ?? missingDependencyProbe.dependency_count
              ?? null,
            header_dependency_count:
              missingDependencyProbe.headerDependencyCount
              ?? missingDependencyProbe.header_dependency_count
              ?? null,
            missing_header_count:
              missingDependencyProbe.missingHeaderCount
              ?? missingDependencyProbe.missing_header_count
              ?? null,
            present_header_count:
              missingDependencyProbe.presentHeaderCount
              ?? missingDependencyProbe.present_header_count
              ?? null,
            blocking_gap_count: compactStringList([
              ...(Array.isArray(missingDependencyProbe.blockingGaps)
                ? missingDependencyProbe.blockingGaps
                : []),
              ...(Array.isArray(missingDependencyProbe.blocking_gaps)
                ? missingDependencyProbe.blocking_gaps
                : []),
            ]).length,
            status: missingDependencyProbe.status ?? null,
          }
        : null,
      runtime_artifacts: runtimeArtifactRecords.map((record) => ({
        phase: record.phase ?? null,
        name: record.name ?? null,
        path: record.path ?? null,
        proof_id: record.proofId ?? record.proof_id ?? null,
        result_state: record.resultState ?? record.result_state ?? null,
        degraded_state: record.degradedState ?? record.degraded_state ?? null,
        degraded_reason: record.degradedReason ?? record.degraded_reason ?? null,
        full_runtime_proven: record.fullRuntimeProven === true,
      })),
    },
    limitations,
    proof_ledger: proofLedgers[proofLedgers.length - 1] ?? null,
    proof_ledger_query: proofLedgerQuery,
    proof_ledger_queries: proofLedgerQueries,
    acceptance_contract: acceptanceContract,
    acceptance_contract_evaluation: acceptanceContractEvaluation,
    acceptance_contract_evaluations: acceptanceContractEvaluations,
    derived_acceptance_contract: derivedAcceptanceContract,
    derived_acceptance_contract_evaluation: derivedAcceptanceContractEvaluation,
    acceptance_contract_consistency_evaluations: acceptanceContractConsistencyEvaluations,
    deterministic_visual_mode: deterministicVisualMode,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluations: deterministicVisualModeEvaluations,
    realRocmAppHookMaterialization: appHookMaterialization,
    real_rocm_app_hook_materialization: appHookMaterialization,
    appHookMaterialization,
    app_hook_materialization: appHookMaterialization,
    realRocmRuntimeProfileAdapterResult: runtimeProfileAdapterResult,
    real_rocm_runtime_profile_adapter_result: runtimeProfileAdapterResult,
    runtimeProfileAdapterResult,
    runtime_profile_adapter_result: runtimeProfileAdapterResult,
    realRocmMissingDependencyProbe: missingDependencyProbe,
    real_rocm_missing_dependency_probe: missingDependencyProbe,
    missingDependencyProbe,
    missing_dependency_probe: missingDependencyProbe,
    gpu_hmr_success: gpuHmrSuccess,
    visual_evidence_is_supplemental: true,
    output_correctness_requires_deterministic_oracle: true,
    full_runtime_proven: fullRuntimeProven,
  };
}
