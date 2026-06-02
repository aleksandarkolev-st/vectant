import {
  classifyGpuHmrVisualEvidenceStats,
  screenshotQualifiesAsVisualEvidence,
  visualEvidenceRow,
} from './gpu-hmr-visual-evidence.mjs';

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
  const explicit = compactStringList([
    ...(Array.isArray(input.visualArtifactPaths) ? input.visualArtifactPaths : []),
    ...(Array.isArray(input.visual_artifact_paths) ? input.visual_artifact_paths : []),
  ]);
  const screenshots = compactObjects(input.screenshots)
    .filter((shot) => !Number.isFinite(shot.visible_pixels) || shot.visible_pixels > 0)
    .flatMap((shot) => [shot.path, shot.filePath, shot.file_path]);
  return compactStringList([...explicit, ...screenshots]);
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
      accepted_as_visual_evidence: true,
    }));
  return [...measured, ...unmeasured];
}

function visualEvidenceLimitations(qualityRows) {
  return compactObjects(qualityRows)
    .filter((row) => {
      const quality = row.visual_quality ?? classifyGpuHmrVisualEvidenceStats(row);
      return screenshotQualifiesAsVisualEvidence(row)
        && quality !== 'gpu-hmr-visual-varied-frame'
        && quality !== 'gpu-hmr-visual-unmeasured';
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

export function buildGpuHmrValidationProofSummary(input = {}) {
  const validationContext = isObject(input.validationContext)
    ? input.validationContext
    : isObject(input.validation_context)
      ? input.validation_context
      : {};
  const dockerMetadata = isObject(input.docker) ? input.docker : validationContext.docker;
  const runtimeArtifactRecords = compactObjects(input.runtimeProofArtifactRecords)
    .concat(compactObjects(input.runtime_proof_artifacts));
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
  const limitations = uniqueLimitations([
    ...limitationsFromRuntimeArtifacts(runtimeArtifactRecords),
    ...visualEvidenceLimitations(qualityRows),
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
    visual_evidence_is_supplemental: true,
    output_correctness_requires_deterministic_oracle: true,
    full_runtime_proven: input.fullRuntimeProof
      ? input.fullRuntimeProof.fullRuntimeProven === true
      : fullRuntimeStates.length > 0 && fullRuntimeStates.every((state) => state.full_runtime_proven === true),
  };
}
