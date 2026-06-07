import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildGpuHmrProofLedger,
  queryGpuHmrLedgerInvariants,
} from './gpu-hmr-proof-ledger.mjs';
import {
  deriveGpuHmrAcceptanceContractFromVerifiedProofs,
  evaluateGpuHmrAcceptanceContract,
} from './gpu-hmr-acceptance-contract.mjs';
import { evaluateGpuHmrDeterministicVisualMode } from './gpu-hmr-visual-evidence.mjs';

export const GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION = 'synthi.gpu.hmr.proof.v1';

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function compactStringList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function contentAddressedArtifactIds(values) {
  return compactStringList(values).filter((id) => /^artifact:sha256:[0-9a-f]{64}$/i.test(id));
}

function compactObjects(values) {
  return (Array.isArray(values) ? values : [])
    .filter((value) => value && typeof value === 'object' && !Array.isArray(value));
}

function compactTrailingObjects(values, limit = 20) {
  const objects = compactObjects(values);
  const boundedLimit = Number.isFinite(limit) && limit > 0 ? Math.trunc(limit) : 20;
  return objects.slice(Math.max(0, objects.length - boundedLimit));
}

function runtimeCapabilityPreflightFacet(preflight) {
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) return null;
  return {
    schemaVersion: preflight.schemaVersion ?? null,
    backend: preflight.backend ?? null,
    api: preflight.api ?? null,
    probe: preflight.probe ?? null,
    skipped: preflight.skipped === true,
    observed: preflight.observed === true,
    allocationAvailable: preflight.allocationAvailable ?? null,
    allocationUnavailable: preflight.allocationUnavailable ?? null,
    allocationResult: Number.isFinite(preflight.allocationResult)
      ? preflight.allocationResult
      : null,
    allocationError: preflight.allocationError ?? null,
    anyAllocationAvailable: preflight.anyAllocationAvailable ?? null,
    allocationMatrixTotal: Number.isFinite(preflight.allocationMatrixTotal)
      ? preflight.allocationMatrixTotal
      : null,
    allocationMatrixAvailableCount: Number.isFinite(preflight.allocationMatrixAvailableCount)
      ? preflight.allocationMatrixAvailableCount
      : null,
    allocationMatrixFailureCount: Number.isFinite(preflight.allocationMatrixFailureCount)
      ? preflight.allocationMatrixFailureCount
      : null,
    allocationMatrix: compactTrailingObjects(preflight.allocationMatrix),
    textureResourceFallbackAvailable: preflight.textureResourceFallbackAvailable ?? null,
    textureResourceMatrixTotal: Number.isFinite(preflight.textureResourceMatrixTotal)
      ? preflight.textureResourceMatrixTotal
      : null,
    textureResourceMatrixAvailableCount: Number.isFinite(preflight.textureResourceMatrixAvailableCount)
      ? preflight.textureResourceMatrixAvailableCount
      : null,
    textureResourceMatrixFailureCount: Number.isFinite(preflight.textureResourceMatrixFailureCount)
      ? preflight.textureResourceMatrixFailureCount
      : null,
    textureResourceMatrix: compactTrailingObjects(preflight.textureResourceMatrix),
    deviceCountResult: Number.isFinite(preflight.deviceCountResult)
      ? preflight.deviceCountResult
      : null,
    deviceCountError: preflight.deviceCountError ?? null,
    deviceCount: Number.isFinite(preflight.deviceCount) ? preflight.deviceCount : null,
    exitCode: Number.isFinite(preflight.exitCode) ? preflight.exitCode : null,
    degradedState: preflight.degradedState ?? null,
    degradedReason: preflight.degradedReason ?? null,
  };
}

function artifactIdsFromSha256Hashes(values) {
  const flattened = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string') flattened.push(value);
  };
  visit(values);
  return compactStringList(flattened)
    .map((value) => value.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null)
    .filter(Boolean)
    .map((digest) => `artifact:sha256:${digest}`);
}

function safeToken(value) {
  const token = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || 'runtime-proof';
}

const ARTIFACT_ID_FIELD_NAMES = new Set([
  'artifactId',
  'artifact_id',
  'selectedArtifactId',
  'selected_artifact_id',
  'runtimeArtifactId',
  'runtime_artifact_id',
  'oldArtifactId',
  'old_artifact_id',
  'newArtifactId',
  'new_artifact_id',
  'activeArtifactId',
  'active_artifact_id',
  'publishedArtifactId',
  'published_artifact_id',
  'ramBlobId',
  'ram_blob_id',
]);

const ARTIFACT_ID_ARRAY_FIELD_NAMES = new Set([
  'artifactIds',
  'artifact_ids',
  'selectedArtifactIds',
  'selected_artifact_ids',
  'runtimeArtifactIds',
  'runtime_artifact_ids',
  'dispatchArtifactIds',
  'dispatch_artifact_ids',
  'ramBlobIds',
  'ram_blob_ids',
]);

const ARTIFACT_HASH_FIELD_NAMES = new Set([
  'artifactHash',
  'artifact_hash',
  'artifactContentHash',
  'artifact_content_hash',
  'artifactBytesHash',
  'artifact_bytes_hash',
  'ramBytesHash',
  'ram_bytes_hash',
  'oldHash',
  'old_hash',
  'newHash',
  'new_hash',
  'oldArtifactHash',
  'old_artifact_hash',
  'newArtifactHash',
  'new_artifact_hash',
]);

const ARTIFACT_HASH_ARRAY_FIELD_NAMES = new Set([
  'artifactHashes',
  'artifact_hashes',
  'artifactContentHashes',
  'artifact_content_hashes',
  'artifactBytesHashes',
  'artifact_bytes_hashes',
  'ramBytesHashes',
  'ram_bytes_hashes',
]);

function artifactIdsFromValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const ids = [];
  for (const [key, child] of Object.entries(value)) {
    if (ARTIFACT_ID_FIELD_NAMES.has(key)) {
      ids.push(child);
    } else if (ARTIFACT_ID_ARRAY_FIELD_NAMES.has(key) && Array.isArray(child)) {
      ids.push(...child);
    } else if (ARTIFACT_HASH_FIELD_NAMES.has(key)) {
      ids.push(...artifactIdsFromSha256Hashes([child]));
    } else if (ARTIFACT_HASH_ARRAY_FIELD_NAMES.has(key) && Array.isArray(child)) {
      ids.push(...artifactIdsFromSha256Hashes(child));
    }
    if (child && typeof child === 'object') {
      ids.push(...artifactIdsFromValue(child, seen));
    }
  }
  return contentAddressedArtifactIds(ids);
}

function artifactIdentityComponentStates(input = {}) {
  const proof = input.fullRuntimeProof && typeof input.fullRuntimeProof === 'object'
    ? input.fullRuntimeProof
    : null;
  const states = proof?.componentStates;
  return states && typeof states === 'object' ? states : null;
}

function artifactIdentityIdsByStage(input = {}) {
  const idsByStage = artifactIdentityComponentStates(input)?.artifactIdentityIdsByStage;
  return idsByStage && typeof idsByStage === 'object' ? idsByStage : {};
}

function artifactIdentityCommonIds(input = {}) {
  return contentAddressedArtifactIds(
    artifactIdentityComponentStates(input)?.artifactIdentityCommonArtifactIds,
  );
}

function unionArtifactIds(values) {
  return contentAddressedArtifactIds(values.flatMap((value) => (
    Array.isArray(value) ? value : [value]
  )));
}

function artifactIdentityIdsForStage(stageId, input = {}) {
  const idsByStage = artifactIdentityIdsByStage(input);
  const stageMap = {
    compile: 'source',
    'symbol-binding': 'source',
    abi: 'source',
    'artifact-transport': 'transport',
    'epoch-swap': 'epoch',
    'dispatch-observed': 'dispatch',
    'dispatch-safe': 'dispatch',
    output: 'output',
  };
  if (stageId === 'artifact-identity') {
    return unionArtifactIds(Object.values(idsByStage));
  }
  const proofStage = stageMap[stageId];
  return proofStage ? contentAddressedArtifactIds(idsByStage[proofStage]) : [];
}

function artifactIdentityDetailsForStage(stageId, input = {}) {
  if (stageId !== 'artifact-identity') return null;
  const states = artifactIdentityComponentStates(input);
  if (!states || states.artifactIdentityRequired !== true) return null;
  return {
    required: true,
    proven: states.artifactIdentityProven === true,
    commonArtifactIds: artifactIdentityCommonIds(input),
    idsByStage: artifactIdentityIdsByStage(input),
    missingStages: compactStringList(states.artifactIdentityMissingStages),
  };
}

function runtimeSessionId(input = {}) {
  const ids = compactStringList(input.runtimeSessionIds);
  const first = ids[0] ?? input.runtimeSessionId ?? input.runtime_session_id ?? input.workspaceSlug;
  return first ? `runtime-session:${String(first).replace(/^runtime-session:/, '')}` : null;
}

function proofArtifactRefs(proof) {
  if (!proof || typeof proof !== 'object') return [];
  return compactStringList([
    proof.proofArtifactPath,
    proof.proof_artifact_path,
    proof.proofId,
    proof.proof_id,
    ...(Array.isArray(proof.proofArtifactPaths) ? proof.proofArtifactPaths : []),
    ...(Array.isArray(proof.proof_artifact_paths) ? proof.proof_artifact_paths : []),
  ]);
}

function evidenceStringsFromValue(value, seen = new Set()) {
  if (!value || typeof value !== 'object' || seen.has(value)) return [];
  seen.add(value);
  const refs = [];
  for (const key of [
    'evidenceRefs',
    'evidence_refs',
    'identityEvidenceRefs',
    'runtimeIdentityEvidenceRefs',
    'identitySnapshotEvidenceRefs',
    'runtimeIdentitySnapshotEvidenceRefs',
    'snapshot_evidence_refs',
    'identity_snapshot_evidence_refs',
    'argProvenanceEvidenceRefs',
    'diagnosticEvidenceRefs',
    'diagnostic_evidence_refs',
    'runtimeCapabilityEvidenceRefs',
    'runtime_capability_evidence_refs',
    'nativeLaunchObserverReadyEvidenceRefs',
    'native_launch_observer_ready_evidence_refs',
    'nativeFunctionResolutionEvidenceRefs',
    'native_function_resolution_evidence_refs',
    'nativeTextureObjectEvidenceRefs',
    'native_texture_object_evidence_refs',
    'nativeArrayAllocationEvidenceRefs',
    'native_array_allocation_evidence_refs',
    'runtimeErrorEvidenceRefs',
    'runtime_error_evidence_refs',
    'visualEvidenceRefs',
    'runtimeEvidenceRefs',
  ]) {
    refs.push(...compactStringList(value[key]));
  }
  refs.push(...proofArtifactRefs(value));
  const childValues = Array.isArray(value) ? value : Object.values(value);
  for (const childValue of childValues) {
    refs.push(...evidenceStringsFromValue(childValue, seen));
  }
  return compactStringList(refs);
}

function runtimeEvidenceSnapshot(input = {}) {
  const evidence = input.runtimeEvidence ?? input.runtime_evidence ?? null;
  return evidence && typeof evidence === 'object' ? evidence : null;
}

function validationContextSnapshot(input = {}) {
  const context = input.validationContext ?? input.validation_context ?? null;
  return context && typeof context === 'object' ? context : null;
}

function targetProgressionSnapshot(input = {}, validationContext = null) {
  const progression =
    input.targetProgression
    ?? input.target_progression
    ?? validationContext?.targetProgression
    ?? validationContext?.target_progression
    ?? null;
  return progression && typeof progression === 'object' ? progression : null;
}

function targetProgressionLedgerSnapshot(input = {}, validationContext = null) {
  const ledger =
    input.targetProgressionLedger
    ?? input.target_progression_ledger
    ?? validationContext?.targetProgressionLedger
    ?? validationContext?.target_progression_ledger
    ?? null;
  return ledger && typeof ledger === 'object' ? ledger : null;
}

function targetProgressionGatesSnapshot(input = {}, validationContext = null) {
  const gates =
    input.targetProgressionGates
    ?? input.target_progression_gates
    ?? validationContext?.targetProgressionGates
    ?? validationContext?.target_progression_gates
    ?? [];
  return Array.isArray(gates) ? gates.filter((gate) => gate && typeof gate === 'object') : [];
}

function evidenceKind(ref) {
  if (/\.png$/i.test(ref) || /\.jpe?g$/i.test(ref) || /\.webp$/i.test(ref)) return 'visual-artifact';
  if (/^worker-log:/i.test(ref)) return 'worker-log';
  if (/^validation:/i.test(ref)) return 'validation-evidence';
  if (/^gpu-proof:/i.test(ref) || /\.synthi[\\/]gpu-hmr[\\/]proofs[\\/]/i.test(ref)) return 'proof-artifact';
  if (/^evidence:/i.test(ref)) return 'proof-evidence';
  return 'runtime-evidence';
}

function visualArtifactMap(artifacts) {
  const out = new Map();
  for (const artifact of compactObjects(artifacts)) {
    const artifactPath = typeof artifact.path === 'string'
      ? artifact.path.trim()
      : typeof artifact.filePath === 'string'
        ? artifact.filePath.trim()
        : typeof artifact.file_path === 'string'
          ? artifact.file_path.trim()
          : '';
    if (artifactPath) out.set(artifactPath, artifact);
  }
  return out;
}

function evidenceRefObject(ref, createdAt, sessionId, visualArtifactsByPath = new Map()) {
  const kind = evidenceKind(ref);
  const visualArtifact = kind === 'visual-artifact' ? visualArtifactsByPath.get(ref) : null;
  const visualContentHash = typeof visualArtifact?.contentHash === 'string'
    ? visualArtifact.contentHash
    : typeof visualArtifact?.content_hash === 'string'
      ? visualArtifact.content_hash
      : null;
  const visualDigest = visualContentHash?.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
  const hash = visualDigest ?? sha256Hex(ref);
  const evidenceId = typeof visualArtifact?.evidenceId === 'string' && visualArtifact.evidenceId.trim()
    ? visualArtifact.evidenceId.trim()
    : typeof visualArtifact?.evidence_id === 'string' && visualArtifact.evidence_id.trim()
      ? visualArtifact.evidence_id.trim()
      : null;
  return {
    evidenceId: evidenceId
      ?? (ref.startsWith('evidence:') || ref.startsWith('worker-log:') || ref.startsWith('validation:')
      ? ref
      : `evidence:${kind}:sha256:${hash}`),
    kind,
    contentHash: kind === 'visual-artifact' && visualArtifact
      ? (visualDigest ? `sha256:${visualDigest}` : null)
      : `sha256:${hash}`,
    producerSubsystem: 'mcp.gpu_hmr_validation',
    timestamp: createdAt,
    sessionId,
    filePath: kind === 'visual-artifact' || kind === 'proof-artifact' ? ref : null,
    artifactUri: ref.startsWith('gpu-proof:') ? ref : null,
    bytes: Number.isFinite(visualArtifact?.bytes) ? visualArtifact.bytes : null,
    visualQuality: visualArtifact?.visualQuality ?? visualArtifact?.visual_quality ?? null,
    acceptedAsVisualEvidence: visualArtifact?.acceptedAsVisualEvidence
      ?? visualArtifact?.accepted_as_visual_evidence
      ?? null,
    readError: visualArtifact?.readError ?? visualArtifact?.read_error ?? null,
    summary: visualArtifact?.summary ?? ref,
  };
}

function stageProofs(input = {}) {
  return {
    'fission-candidate-verification': [input.fissionProof],
    compile: input.sourceProofs ?? [input.sourceProof],
    'symbol-binding': input.sourceProofs ?? [input.sourceProof],
    abi: [input.abiProof],
    'artifact-transport': [input.artifactTransportProof],
    'epoch-swap': [input.epochProof],
    'dispatch-observed': [input.dispatchProof],
    'dispatch-safe': [input.dispatchProof],
    output: [input.outputProof],
    'artifact-identity': [input.fullRuntimeProof?.componentStates],
    'host-preservation': [input.hostPreservationProof],
    'original-host-path': [input.originalHostPathProof],
  };
}

function sourceProofStageEvidenceRefs(stageId, proof) {
  if (!proof || typeof proof !== 'object') return [];
  const refs = [
    ...proofArtifactRefs(proof),
    ...(Array.isArray(proof.artifactIds) ? proof.artifactIds : []),
    ...(Array.isArray(proof.artifact_ids) ? proof.artifact_ids : []),
  ];
  if (stageId === 'compile') {
    refs.push(
      ...(Array.isArray(proof.compileEvidenceRefs) ? proof.compileEvidenceRefs : []),
      ...(Array.isArray(proof.compile_evidence_refs) ? proof.compile_evidence_refs : []),
    );
  } else if (stageId === 'symbol-binding') {
    refs.push(
      ...(Array.isArray(proof.symbolEvidenceRefs) ? proof.symbolEvidenceRefs : []),
      ...(Array.isArray(proof.symbol_evidence_refs) ? proof.symbol_evidence_refs : []),
    );
  }
  return compactStringList(refs);
}

function stageEvidenceRefs(stageId, input = {}) {
  if (stageId === 'artifact-identity') {
    return compactStringList([
      ...stageEvidenceRefs('compile', input),
      ...stageEvidenceRefs('symbol-binding', input),
      ...stageEvidenceRefs('artifact-transport', input),
      ...stageEvidenceRefs('epoch-swap', input),
      ...stageEvidenceRefs('dispatch-observed', input),
      ...stageEvidenceRefs('output', input),
    ]);
  }
  const proofs = stageProofs(input)[stageId] ?? [];
  if (stageId === 'compile' || stageId === 'symbol-binding') {
    return compactStringList(proofs.flatMap((proof) => sourceProofStageEvidenceRefs(stageId, proof)));
  }
  return compactStringList(proofs.flatMap((proof) => evidenceStringsFromValue(proof)));
}

function stageArtifactIds(stageId, input = {}) {
  const identityIds = artifactIdentityIdsForStage(stageId, input);
  const proofIds = contentAddressedArtifactIds(
    (stageProofs(input)[stageId] ?? []).flatMap((proof) => artifactIdsFromValue(proof)),
  );
  const baseIds = identityIds.length ? identityIds : proofIds;
  if (stageId === 'artifact-identity') {
    const commonIds = artifactIdentityCommonIds(input);
    return {
      inputArtifactIds: baseIds,
      outputArtifactIds: commonIds,
    };
  }
  return {
    inputArtifactIds: baseIds,
    outputArtifactIds: baseIds,
  };
}

function proofStageResult(stage, input, createdAt) {
  const evidenceRefs = stageEvidenceRefs(stage.stageId, input);
  const derivedArtifactIds = stageArtifactIds(stage.stageId, input);
  const artifactIdentity = artifactIdentityDetailsForStage(stage.stageId, input);
  return {
    stageId: stage.stageId,
    stageName: stage.stageName ?? stage.stageId,
    status: stage.status,
    startedAt: createdAt,
    completedAt: createdAt,
    inputArtifactIds: contentAddressedArtifactIds([
      ...(Array.isArray(stage.inputArtifactIds) ? stage.inputArtifactIds : []),
      ...derivedArtifactIds.inputArtifactIds,
    ]),
    outputArtifactIds: contentAddressedArtifactIds([
      ...(Array.isArray(stage.outputArtifactIds) ? stage.outputArtifactIds : []),
      ...derivedArtifactIds.outputArtifactIds,
    ]),
    evidenceRefs,
    degradedState: stage.degradedState ?? null,
    degradedReason: stage.degradedReason ?? null,
    requiredState: stage.requiredState ?? null,
    observedState: stage.observedState ?? null,
    ...(artifactIdentity ? { artifactIdentity } : {}),
  };
}

function proofLimitations(stages, fullRuntimeProof) {
  const limitations = [];
  for (const stage of Array.isArray(stages) ? stages : []) {
    if (stage.status === 'passed' && !stage.degradedState && !stage.degradedReason) continue;
    limitations.push({
      stageId: stage.stageId,
      status: stage.status,
      requiredState: stage.requiredState ?? null,
      observedState: stage.observedState ?? null,
      degradedState: stage.degradedState ?? null,
      degradedReason: stage.degradedReason ?? null,
    });
  }
  if (
    limitations.length === 0
    && fullRuntimeProof
    && fullRuntimeProof.fullRuntimeProven !== true
    && (fullRuntimeProof.degradedState || fullRuntimeProof.degradedReason)
  ) {
    limitations.push({
      stageId: 'full-runtime',
      status: 'blocked',
      requiredState: 'gpu-hmr-full-runtime-proven',
      observedState: fullRuntimeProof.resultState ?? null,
      degradedState: fullRuntimeProof.degradedState ?? null,
      degradedReason: fullRuntimeProof.degradedReason ?? null,
    });
  }
  return limitations;
}

function proofFacetsSnapshot(input = {}, visualEvidenceArtifacts = []) {
  const fissionProof = input.fissionProof && typeof input.fissionProof === 'object'
    ? input.fissionProof
    : null;
  const epochProof = input.epochProof && typeof input.epochProof === 'object'
    ? input.epochProof
    : null;
  const outputProof = input.outputProof && typeof input.outputProof === 'object'
    ? input.outputProof
    : null;
  const hostPreservationProof =
    input.hostPreservationProof && typeof input.hostPreservationProof === 'object'
      ? input.hostPreservationProof
      : null;
  const originalHostPathProof =
    input.originalHostPathProof && typeof input.originalHostPathProof === 'object'
      ? input.originalHostPathProof
      : null;
  const selectedIslandContracts = compactObjects(fissionProof?.selectedIslandContracts);
  const selectedIslandNarrowerRejections = selectedIslandContracts.flatMap((contract) =>
    compactObjects(contract.narrowerCandidateRejections)
  );
  const epochGenerationGraph =
    epochProof?.epochGenerationGraph
    && typeof epochProof.epochGenerationGraph === 'object'
    && !Array.isArray(epochProof.epochGenerationGraph)
      ? epochProof.epochGenerationGraph
      : null;
  const epochGenerationGraphObserved =
    epochProof?.epochGenerationGraphObserved === true
    || epochProof?.generationGraphObserved === true
    || epochGenerationGraph !== null;
  const epochGenerationGraphValid =
    epochProof?.epochGenerationGraphValid === true
    || epochProof?.generationGraphValid === true;
  const visualArtifacts = compactObjects(visualEvidenceArtifacts).map((artifact) => ({
    path: artifact.path ?? artifact.filePath ?? artifact.file_path ?? null,
    label: artifact.label ?? null,
    contentHash: artifact.contentHash ?? artifact.content_hash ?? null,
    evidenceId: artifact.evidenceId ?? artifact.evidence_id ?? null,
    width: Number.isFinite(artifact.width) ? artifact.width : null,
    height: Number.isFinite(artifact.height) ? artifact.height : null,
    visiblePixels:
      Number.isFinite(artifact.visiblePixels)
        ? artifact.visiblePixels
        : Number.isFinite(artifact.visible_pixels)
          ? artifact.visible_pixels
          : null,
    meanLuma:
      Number.isFinite(artifact.meanLuma)
        ? artifact.meanLuma
        : Number.isFinite(artifact.mean_luma)
          ? artifact.mean_luma
          : null,
    lumaStddev:
      Number.isFinite(artifact.lumaStddev)
        ? artifact.lumaStddev
        : Number.isFinite(artifact.luma_stddev)
          ? artifact.luma_stddev
          : null,
    rgbSpanMean:
      Number.isFinite(artifact.rgbSpanMean)
        ? artifact.rgbSpanMean
        : Number.isFinite(artifact.rgb_span_mean)
          ? artifact.rgb_span_mean
          : null,
    uniqueColorSampleCount:
      Number.isFinite(artifact.uniqueColorSampleCount)
        ? artifact.uniqueColorSampleCount
        : Number.isFinite(artifact.unique_color_sample_count)
          ? artifact.unique_color_sample_count
          : null,
    acceptedAsVisualEvidence:
      artifact.acceptedAsVisualEvidence
      ?? artifact.accepted_as_visual_evidence
      ?? null,
    visualQuality: artifact.visualQuality ?? artifact.visual_quality ?? null,
    bytes: Number.isFinite(artifact.bytes) ? artifact.bytes : null,
    readError: artifact.readError ?? artifact.read_error ?? null,
    summary: artifact.summary ?? null,
  }));
  return {
    fission: fissionProof ? {
      schemaVersion: fissionProof.schemaVersion ?? null,
      resultState: fissionProof.resultState ?? null,
      degradedState: fissionProof.degradedState ?? null,
      degradedReason: fissionProof.degradedReason ?? null,
      required: fissionProof.required === true,
      observed: fissionProof.observed === true,
      proven: fissionProof.fissionProven === true,
      selectedIslandIds: compactStringList(fissionProof.selectedIslandIds),
      selectedIslandContracts,
      selectedIslandContractCount: selectedIslandContracts.length,
      selectedIslandNarrowerRejectionCount: selectedIslandNarrowerRejections.length,
      selectedIslandNarrowerRejections,
      evidenceRefs: compactStringList(fissionProof.evidenceRefs),
      verifierEvidenceRefs: compactStringList(fissionProof.verifierEvidenceRefs),
      deterministicVerifierEvidenceRefs: compactStringList(
        fissionProof.deterministicVerifierEvidenceRefs,
      ),
      aiProposalIds: compactStringList(fissionProof.aiProposalIds),
      nonAuthoritativeEvidenceRefs: compactStringList(fissionProof.nonAuthoritativeEvidenceRefs),
    } : null,
    epoch: epochProof ? {
      schemaVersion: epochProof.schemaVersion ?? null,
      resultState: epochProof.resultState ?? null,
      degradedState: epochProof.degradedState ?? null,
      degradedReason: epochProof.degradedReason ?? null,
      epochSwapProven:
        epochProof.epochSwapProven === true
        || epochProof.resultState === 'gpu-hmr-epoch-swap-proven',
      generationLineageObserved: epochProof.generationLineageObserved === true,
      generationGraphObserved: epochGenerationGraphObserved,
      generationGraphValid: epochGenerationGraphValid,
      generationGraphRuntimeSessionScoped:
        epochProof.generationGraphRuntimeSessionScoped === true,
      epochGenerationGraphObserved,
      epochGenerationGraphValid,
      epochGenerationGraph,
      capsuleMetadataObserved: epochProof.capsuleMetadataObserved === true,
      capsuleId: epochProof.capsuleId ?? null,
      fissionIslandId: epochProof.fissionIslandId ?? null,
      retirementStrategy: epochProof.retirementStrategy ?? null,
      oldGenerationRetired: epochProof.oldGenerationRetired === true,
      retirementFenceIds: compactStringList(epochProof.retirementFenceIds),
      evidenceRefs: compactStringList(epochProof.evidenceRefs),
    } : null,
    output: outputProof ? {
      schemaVersion: outputProof.schemaVersion ?? null,
      resultState: outputProof.resultState ?? null,
      degradedState: outputProof.degradedState ?? null,
      degradedReason: outputProof.degradedReason ?? null,
      outputOracleProven:
        outputProof.outputOracleProven === true
        || outputProof.resultState === 'gpu-hmr-output-oracle-proven',
      outputOracle: outputProof.outputOracle ?? null,
      visualFrameObserved: outputProof.visualFrameObserved === true,
      visualEvidenceRefs: compactStringList(outputProof.visualEvidenceRefs),
      evidenceRefs: compactStringList(outputProof.evidenceRefs),
    } : null,
    hostPreservation: hostPreservationProof ? {
      schemaVersion: hostPreservationProof.schemaVersion ?? null,
      resultState: hostPreservationProof.resultState ?? null,
      degradedState: hostPreservationProof.degradedState ?? null,
      degradedReason: hostPreservationProof.degradedReason ?? null,
      hostPreservationProven:
        hostPreservationProof.hostPreservationProven === true
        || hostPreservationProof.resultState === 'gpu-hmr-host-preservation-proven',
      preservedRoles: compactStringList(hostPreservationProof.preservedRoles),
      requiredRoles: compactStringList(hostPreservationProof.requiredRoles),
      evidenceRefs: compactStringList(hostPreservationProof.evidenceRefs),
      identitySnapshotEvidenceRefs: compactStringList(
        hostPreservationProof.identitySnapshotEvidenceRefs,
      ),
    } : null,
    originalHostPath: originalHostPathProof ? {
      schemaVersion: originalHostPathProof.schemaVersion ?? null,
      resultState: originalHostPathProof.resultState ?? null,
      degradedState: originalHostPathProof.degradedState ?? null,
      degradedReason: originalHostPathProof.degradedReason ?? null,
      originalHostPathProven:
        originalHostPathProof.originalHostPathProven === true
        || originalHostPathProof.attachmentProven === true
        || originalHostPathProof.resultState === 'gpu-hmr-original-host-path-proven',
      attachmentProven: originalHostPathProof.attachmentProven === true,
      nativeLaunchObserved: originalHostPathProof.nativeLaunchObserved === true,
      nativeLaunchAttemptObserved: originalHostPathProof.nativeLaunchAttemptObserved === true,
      nativeLaunchObserverSawNoLaunch: originalHostPathProof.nativeLaunchObserverSawNoLaunch === true,
      nativeLaunchObserverEnabled: originalHostPathProof.nativeLaunchObserverEnabled === true,
      nativeLaunchObserverReady: originalHostPathProof.nativeLaunchObserverReady === true,
      nativeTextureObjectFailureObserved:
        originalHostPathProof.nativeTextureObjectFailureObserved === true,
      nativeTextureObjectFailureBeforeLaunch:
        originalHostPathProof.nativeTextureObjectFailureBeforeLaunch === true,
      nativeArrayAllocationFailureObserved:
        originalHostPathProof.nativeArrayAllocationFailureObserved === true,
      nativeArrayAllocationFailureBeforeLaunch:
        originalHostPathProof.nativeArrayAllocationFailureBeforeLaunch === true,
      runtimeArrayAllocationCapabilityAvailable:
        originalHostPathProof.runtimeArrayAllocationCapabilityAvailable ?? null,
      runtimeArrayAllocationCapabilityUnavailable:
        originalHostPathProof.runtimeArrayAllocationCapabilityUnavailable ?? null,
      runtimeCapabilityPreflightObserved:
        originalHostPathProof.runtimeCapabilityPreflightObserved === true,
      runtimeCapabilityPreflight: runtimeCapabilityPreflightFacet(
        originalHostPathProof.runtimeCapabilityPreflight,
      ),
      nativeLaunchSymbols: compactStringList(originalHostPathProof.nativeLaunchSymbols),
      nativeLaunchFunctionPtrs: compactStringList(originalHostPathProof.nativeLaunchFunctionPtrs),
      nativeArrayAllocationRecords: compactTrailingObjects(
        originalHostPathProof.nativeArrayAllocationRecords,
      ),
      runtimeErrorRecords: compactTrailingObjects(originalHostPathProof.runtimeErrorRecords),
      runtimeErrorSourceLocations: compactTrailingObjects(
        originalHostPathProof.runtimeErrorSourceLocations,
      ),
      nativeLaunchObserverReadyEvidenceRefs: compactStringList(
        originalHostPathProof.nativeLaunchObserverReadyEvidenceRefs,
      ),
      nativeFunctionResolutionEvidenceRefs: compactStringList(
        originalHostPathProof.nativeFunctionResolutionEvidenceRefs,
      ),
      nativeTextureObjectEvidenceRefs: compactStringList(
        originalHostPathProof.nativeTextureObjectEvidenceRefs,
      ),
      nativeArrayAllocationEvidenceRefs: compactStringList(
        originalHostPathProof.nativeArrayAllocationEvidenceRefs,
      ),
      runtimeErrorEvidenceRefs: compactStringList(originalHostPathProof.runtimeErrorEvidenceRefs),
      runtimeCapabilityEvidenceRefs: compactStringList(
        originalHostPathProof.runtimeCapabilityEvidenceRefs,
      ),
      diagnosticEvidenceRefs: compactStringList(originalHostPathProof.diagnosticEvidenceRefs),
      evidenceRefs: compactStringList(originalHostPathProof.evidenceRefs),
    } : null,
    visual: {
      visualEvidenceRefs: compactStringList(input.visualEvidenceRefs),
      artifactCount: visualArtifacts.length,
      acceptedArtifactCount: visualArtifacts.filter((artifact) =>
        artifact.acceptedAsVisualEvidence === true
      ).length,
      artifacts: visualArtifacts,
    },
  };
}

function targetProgressionGateLimitations(gates) {
  return (Array.isArray(gates) ? gates : [])
    .filter((gate) => gate?.status === 'fail')
    .map((gate) => ({
      stageId: 'target-progression',
      status: 'blocked',
      requiredState: 'gpu-hmr-target-progression-proven',
      observedState: null,
      degradedState: 'gpu-hmr-target-progression-unverified',
      degradedReason: gate.detail ?? gate.name ?? 'target progression gate failed',
      gateName: gate.name ?? null,
    }));
}

function acceptanceContractLimitations(evaluation) {
  if (!objectOrNull(evaluation) || evaluation.accepted === true) return [];
  return compactObjects(evaluation.failedGates).map((gate) => ({
    stageId: 'acceptance-contract',
    stage_id: 'acceptance-contract',
    status: 'blocked',
    requiredState: 'gpu-hmr-acceptance-contract-verified',
    required_state: 'gpu-hmr-acceptance-contract-verified',
    observedState: null,
    observed_state: null,
    degradedState: 'gpu-hmr-acceptance-contract-rejected',
    degraded_state: 'gpu-hmr-acceptance-contract-rejected',
    degradedReason: gate.code ?? 'acceptance_contract_gate_failed',
    degraded_reason: gate.code ?? 'acceptance_contract_gate_failed',
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }));
}

function deterministicVisualModeLimitations(evaluation) {
  if (!objectOrNull(evaluation) || evaluation.accepted === true) return [];
  return compactObjects(evaluation.failedGates).map((gate) => ({
    stageId: 'deterministic-visual-mode',
    stage_id: 'deterministic-visual-mode',
    status: 'blocked',
    requiredState: 'gpu-hmr-deterministic-visual-mode-proven',
    required_state: 'gpu-hmr-deterministic-visual-mode-proven',
    observedState: null,
    observed_state: null,
    degradedState: 'gpu-hmr-deterministic-visual-mode-rejected',
    degraded_state: 'gpu-hmr-deterministic-visual-mode-rejected',
    degradedReason: gate.code ?? 'deterministic_visual_mode_gate_failed',
    degraded_reason: gate.code ?? 'deterministic_visual_mode_gate_failed',
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }));
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstArray(value) {
  return Array.isArray(value) ? value : [];
}

function firstArtifactId(...values) {
  const flattened = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    if (typeof value === 'string') flattened.push(value);
  };
  values.forEach(visit);
  return contentAddressedArtifactIds(flattened)[0]
    ?? artifactIdsFromSha256Hashes(flattened)[0]
    ?? null;
}

function proofArtifactId(proof, extraFields = []) {
  const p = objectOrNull(proof) ?? {};
  const oracle = objectOrNull(p.outputOracle) ?? objectOrNull(p.output_oracle) ?? {};
  return firstArtifactId(
    p.artifactId,
    p.artifact_id,
    p.selectedArtifactId,
    p.selected_artifact_id,
    p.runtimeArtifactId,
    p.runtime_artifact_id,
    p.newArtifactId,
    p.new_artifact_id,
    p.publishedArtifactId,
    p.published_artifact_id,
    p.activeArtifactId,
    p.active_artifact_id,
    p.ramBlobId,
    p.ram_blob_id,
    oracle.artifactId,
    oracle.artifact_id,
    firstArray(p.artifactIds),
    firstArray(p.artifact_ids),
    firstArray(p.selectedArtifactIds),
    firstArray(p.selected_artifact_ids),
    firstArray(p.runtimeArtifactIds),
    firstArray(p.runtime_artifact_ids),
    firstArray(p.ramBlobIds),
    firstArray(p.ram_blob_ids),
    artifactIdsFromSha256Hashes([
      p.artifactContentHash,
      p.artifact_content_hash,
      p.newArtifactHash,
      p.new_artifact_hash,
      p.ramBytesHash,
      p.ram_bytes_hash,
      firstArray(p.artifactContentHashes),
      firstArray(p.artifact_content_hashes),
      firstArray(p.ramBytesHashes),
      firstArray(p.ram_bytes_hashes),
    ]),
    extraFields,
  );
}

function epochGraphFromProof(proof) {
  const p = objectOrNull(proof) ?? {};
  return objectOrNull(p.epochGenerationGraph)
    ?? objectOrNull(p.epoch_generation_graph)
    ?? objectOrNull(p.generationGraph)
    ?? objectOrNull(p.generation_graph)
    ?? null;
}

function latestPublicationFromEpochProof(proof) {
  const graph = epochGraphFromProof(proof);
  if (!graph) return null;
  const latest = objectOrNull(graph.latestPublication) ?? objectOrNull(graph.latest_publication);
  if (latest) return latest;
  const publishEdges = firstArray(graph.edges)
    .filter((edge) => objectOrNull(edge) && String(edge.kind ?? '').toLowerCase() === 'publish');
  return publishEdges[publishEdges.length - 1] ?? null;
}

function epochIdFromProof(proof) {
  const p = objectOrNull(proof) ?? {};
  const publication = latestPublicationFromEpochProof(proof) ?? {};
  return firstString(
    p.epoch,
    p.epoch_id,
    p.activeEpoch,
    p.active_epoch,
    p.activeGeneration,
    p.active_generation,
    publication.epoch,
    publication.epoch_id,
    publication.activeEpoch,
    publication.active_epoch,
    publication.activeGeneration,
    publication.active_generation,
    publication.to,
  );
}

function timestampFromValue(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function latestTimestamp(...values) {
  const timestamps = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const timestamp = timestampFromValue(value);
    if (timestamp !== null) timestamps.push(timestamp);
  };
  values.forEach(visit);
  return timestamps.length ? Math.max(...timestamps) : null;
}

function buildProofLedgerRecordFromInput(input, validationContext) {
  const acceptanceContract = objectOrNull(input.acceptanceContract)
    ?? objectOrNull(input.acceptance_contract)
    ?? objectOrNull(validationContext?.acceptanceContract)
    ?? objectOrNull(validationContext?.acceptance_contract);
  const explicit = objectOrNull(input.proofLedgerRecord)
    ?? objectOrNull(input.proof_ledger_record)
    ?? objectOrNull(input.proofLedger?.record)
    ?? objectOrNull(input.proof_ledger?.record);
  if (explicit) return explicit;

  const sourceProof = compactObjects(input.sourceProofs)[0] ?? objectOrNull(input.sourceProof);
  const fissionProof = objectOrNull(input.fissionProof);
  const artifactTransportProof = objectOrNull(input.artifactTransportProof);
  const epochProof = objectOrNull(input.epochProof);
  const dispatchProof = objectOrNull(input.dispatchProof);
  const outputProof = objectOrNull(input.outputProof);
  const outputOracle = objectOrNull(outputProof?.outputOracle)
    ?? objectOrNull(outputProof?.output_oracle)
    ?? {};
  const hostPreservationProof = objectOrNull(input.hostPreservationProof);
  const publication = latestPublicationFromEpochProof(epochProof) ?? {};
  const artifactAfterHash = firstArtifactId(
    input.artifactAfterHash,
    input.artifact_after_hash,
    input.changedGpuArtifactHash,
    input.changed_gpu_artifact_hash,
    proofArtifactId(outputProof),
    proofArtifactId(dispatchProof),
    proofArtifactId(epochProof, [
      publication.newArtifactId,
      publication.new_artifact_id,
      publication.newArtifactHash,
      publication.new_artifact_hash,
    ]),
    proofArtifactId(artifactTransportProof),
    proofArtifactId(sourceProof),
  );
  const artifactBeforeHash = firstArtifactId(
    input.artifactBeforeHash,
    input.artifact_before_hash,
    sourceProof?.artifactBeforeId,
    sourceProof?.artifact_before_id,
    sourceProof?.artifactBeforeHash,
    sourceProof?.artifact_before_hash,
  );
  const epoch = epochIdFromProof(epochProof);
  const dispatchId = firstString(
    dispatchProof?.dispatchId,
    dispatchProof?.dispatch_id,
    dispatchProof?.kernelDispatchId,
    dispatchProof?.kernel_dispatch_id,
  );
  const dispatchTimestamp = latestTimestamp(
    dispatchProof?.dispatchTimestamps,
    dispatchProof?.dispatch_timestamps,
    dispatchProof?.dispatchTimestamp,
    dispatchProof?.dispatch_timestamp,
  );
  const outputTimestamp = latestTimestamp(
    outputOracle.readbackTimestamp,
    outputOracle.readback_timestamp,
    outputOracle.timestampMonotonicNs,
    outputOracle.timestamp_monotonic_ns,
    outputProof?.outputTimestamp,
    outputProof?.output_timestamp,
  );
  const publishTimestamp = latestTimestamp(
    publication.publishTimestamp,
    publication.publish_timestamp,
    publication.timestamp,
    publication.timestamp_monotonic_ns,
  );
  const loadedArtifactHash = proofArtifactId(artifactTransportProof);
  const publishedArtifactHash = proofArtifactId(epochProof, [
    publication.newArtifactId,
    publication.new_artifact_id,
    publication.newArtifactHash,
    publication.new_artifact_hash,
  ]);
  const dispatchArtifactHash = proofArtifactId(dispatchProof);
  const outputArtifactHash = proofArtifactId(outputProof);

  return {
    project_id: input.workspaceSlug ?? validationContext?.workspaceSlug ?? validationContext?.workspace_slug ?? null,
    edit_id: input.sourceEditId ?? input.source_edit_id ?? validationContext?.sourceEditId ?? null,
    classification: input.classification ?? validationContext?.classification ?? acceptanceContract?.classification ?? {},
    contract_hash: firstString(
      input.contractHash,
      input.contract_hash,
      validationContext?.contractHash,
      validationContext?.contract_hash,
      acceptanceContract?.contract_hash,
      acceptanceContract?.contractHash,
      fissionProof?.contractHash,
      fissionProof?.contract_hash,
    ),
    artifact_before_hash: artifactBeforeHash,
    artifact_after_hash: artifactAfterHash,
    loader_event: {
      id: firstString(artifactTransportProof?.eventId, artifactTransportProof?.event_id),
      artifact_hash: loadedArtifactHash,
      process_id: firstString(artifactTransportProof?.processId, artifactTransportProof?.process_id),
      timestamp_monotonic_ns: latestTimestamp(
        artifactTransportProof?.timestampMonotonicNs,
        artifactTransportProof?.timestamp_monotonic_ns,
        artifactTransportProof?.transportTimestamp,
        artifactTransportProof?.transport_timestamp,
      ),
    },
    epoch_publish_event: {
      id: firstString(epochProof?.eventId, epochProof?.event_id, publication.id, publication.event_id),
      artifact_hash: publishedArtifactHash,
      epoch,
      timestamp_monotonic_ns: publishTimestamp,
    },
    dispatch_event: {
      id: dispatchId,
      artifact_hash: dispatchArtifactHash,
      epoch: firstString(dispatchProof?.epoch, dispatchProof?.epoch_id, dispatchProof?.activeEpoch, epoch),
      process_id: firstString(dispatchProof?.processId, dispatchProof?.process_id),
      timestamp_monotonic_ns: dispatchTimestamp,
    },
    output_event: {
      id: firstString(outputProof?.eventId, outputProof?.event_id, outputOracle.id, outputOracle.oracleId),
      kind: firstString(outputOracle.kind, outputProof?.kind, outputProof?.oracleKind),
      artifact_hash: outputArtifactHash,
      epoch: firstString(outputProof?.epoch, outputProof?.epoch_id, outputOracle.epoch, epoch),
      after_dispatch_id: firstString(
        outputProof?.afterDispatchId,
        outputProof?.after_dispatch_id,
        outputOracle.afterDispatchId,
        outputOracle.after_dispatch_id,
        outputOracle.dispatchId,
        outputOracle.dispatch_id,
      ),
      timestamp_monotonic_ns: outputTimestamp,
      passed: outputProof?.resultState === 'gpu-hmr-output-proven' || outputOracle.passed === true,
    },
    retirement_event: {
      id: firstString(epochProof?.retirementEventId, epochProof?.retirement_event_id),
      epoch,
      status: epochProof?.oldGenerationRetired === true ? 'retired' : null,
    },
    process_identity: {
      process_id: firstString(
        hostPreservationProof?.processId,
        hostPreservationProof?.process_id,
        validationContext?.processId,
        validationContext?.process_id,
      ),
    },
    device_identity: input.deviceIdentity ?? input.device_identity ?? validationContext?.deviceIdentity ?? {},
    cpu_hmr_used: input.cpuHmrUsed === true || input.cpu_hmr_used === true,
    full_rebuild_used: input.fullRebuildUsed === true || input.full_rebuild_used === true,
    process_restarted: input.processRestarted === true || input.process_restarted === true,
    oracle_artifacts: outputProof?.oracleArtifacts ?? outputProof?.oracle_artifacts ?? {},
    deterministic_visual_mode:
      input.deterministicVisualMode
      ?? input.deterministic_visual_mode
      ?? validationContext?.deterministicVisualMode
      ?? validationContext?.deterministic_visual_mode
      ?? outputProof?.deterministicVisualMode
      ?? outputProof?.deterministic_visual_mode
      ?? outputProof?.outputOracle?.deterministicVisualMode
      ?? outputProof?.outputOracle?.deterministic_visual_mode
      ?? {},
    timings: input.timings ?? validationContext?.timings ?? {},
    model_provenance: input.modelProvenance ?? input.model_provenance ?? validationContext?.modelProvenance ?? {},
    evidence_refs: compactStringList([
      ...(Array.isArray(artifactTransportProof?.evidenceRefs) ? artifactTransportProof.evidenceRefs : []),
      ...(Array.isArray(epochProof?.evidenceRefs) ? epochProof.evidenceRefs : []),
      ...(Array.isArray(dispatchProof?.evidenceRefs) ? dispatchProof.evidenceRefs : []),
      ...(Array.isArray(outputProof?.evidenceRefs) ? outputProof.evidenceRefs : []),
      ...(Array.isArray(hostPreservationProof?.evidenceRefs) ? hostPreservationProof.evidenceRefs : []),
    ]),
  };
}

export function buildValidationRuntimeProofArtifact(input = {}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const fullRuntimeProof = input.fullRuntimeProof && typeof input.fullRuntimeProof === 'object'
    ? input.fullRuntimeProof
    : null;
  const outputProof = objectOrNull(input.outputProof);
  const sessionId = runtimeSessionId(input);
  const runtimeEvidence = runtimeEvidenceSnapshot(input);
  const validationContext = validationContextSnapshot(input);
  const targetProgression = targetProgressionSnapshot(input, validationContext);
  const targetProgressionLedger = targetProgressionLedgerSnapshot(input, validationContext);
  const targetProgressionGates = targetProgressionGatesSnapshot(input, validationContext);
  const explicitAcceptanceContract = objectOrNull(input.acceptanceContract)
    ?? objectOrNull(input.acceptance_contract)
    ?? objectOrNull(validationContext?.acceptanceContract)
    ?? objectOrNull(validationContext?.acceptance_contract)
    ?? null;
  const acceptanceContract = explicitAcceptanceContract
    ?? deriveGpuHmrAcceptanceContractFromVerifiedProofs({
      ...input,
      validationContext,
    });
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(
    acceptanceContract ?? {
      classification: input.classification ?? validationContext?.classification ?? {},
    },
  );
  const deterministicVisualMode = objectOrNull(input.deterministicVisualMode)
    ?? objectOrNull(input.deterministic_visual_mode)
    ?? objectOrNull(validationContext?.deterministicVisualMode)
    ?? objectOrNull(validationContext?.deterministic_visual_mode)
    ?? objectOrNull(outputProof?.deterministicVisualMode)
    ?? objectOrNull(outputProof?.deterministic_visual_mode)
    ?? objectOrNull(outputProof?.outputOracle?.deterministicVisualMode)
    ?? objectOrNull(outputProof?.outputOracle?.deterministic_visual_mode)
    ?? null;
  const deterministicVisualModeEvaluation = deterministicVisualMode
    ? evaluateGpuHmrDeterministicVisualMode(deterministicVisualMode)
    : null;
  const proofLedgerRecord = buildProofLedgerRecordFromInput(input, validationContext);
  const proofLedger = buildGpuHmrProofLedger(proofLedgerRecord);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  const visualEvidenceRefs = compactStringList(input.visualEvidenceRefs);
  const visualEvidenceArtifacts = compactObjects(input.visualEvidenceArtifacts);
  const visualArtifactsByPath = visualArtifactMap(visualEvidenceArtifacts);
  const stages = Array.isArray(fullRuntimeProof?.stages)
    ? fullRuntimeProof.stages.map((stage) => proofStageResult(stage, input, createdAt))
    : [];
  const limitations = [
    ...proofLimitations(stages, fullRuntimeProof),
    ...acceptanceContractLimitations(acceptanceContractEvaluation),
    ...deterministicVisualModeLimitations(deterministicVisualModeEvaluation),
    ...targetProgressionGateLimitations(targetProgressionGates),
  ];
  const proofFacets = proofFacetsSnapshot(input, visualEvidenceArtifacts);
  const evidenceStrings = compactStringList([
    ...stages.flatMap((stage) => stage.evidenceRefs),
    ...visualEvidenceRefs,
    ...evidenceStringsFromValue(fullRuntimeProof),
    ...evidenceStringsFromValue(runtimeEvidence),
    ...evidenceStringsFromValue(targetProgressionLedger),
  ]);
  const evidenceRefs = evidenceStrings.map((ref) =>
    evidenceRefObject(ref, createdAt, sessionId, visualArtifactsByPath)
  );
  const proofMaterial = {
    fullRuntimeProof,
    sourceProofs: input.sourceProofs ?? (input.sourceProof ? [input.sourceProof] : []),
    fissionProof: input.fissionProof ?? null,
    abiProof: input.abiProof ?? null,
    artifactTransportProof: input.artifactTransportProof ?? null,
    epochProof: input.epochProof ?? null,
    dispatchProof: input.dispatchProof ?? null,
    outputProof: input.outputProof ?? null,
    hostPreservationProof: input.hostPreservationProof ?? null,
    originalHostPathProof: input.originalHostPathProof ?? null,
    runtimeEvidence,
    validationContext,
    targetProgression,
    targetProgressionLedger,
    targetProgressionGates,
    acceptanceContract,
    acceptanceContractEvaluation,
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
    proofLedger,
    proofLedgerQuery,
    visualEvidenceArtifacts,
  };
  const materialHash = sha256Hex(stableJson({
    workspaceSlug: input.workspaceSlug ?? null,
    runtimeSessionId: sessionId,
    resultState: fullRuntimeProof?.resultState ?? null,
    degradedState: fullRuntimeProof?.degradedState ?? null,
    degradedReason: fullRuntimeProof?.degradedReason ?? null,
    stages,
    limitations,
    evidenceStrings,
    proofMaterial,
    proofFacets,
    validationContext,
    targetProgression,
    targetProgressionLedger,
    targetProgressionGates,
    acceptanceContract,
    acceptanceContractEvaluation,
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
    proofLedger,
    proofLedgerQuery,
    visualEvidenceArtifacts,
  }));
  const validationContextHash = validationContext
    ? `sha256:${sha256Hex(stableJson(validationContext))}`
    : null;

  return {
    schemaVersion: GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION,
    proofId: `gpu-runtime-proof:sha256:${materialHash}`,
    workspaceSlug: input.workspaceSlug ?? null,
    runtimeSessionId: sessionId,
    sourceEditId: input.sourceEditId ?? null,
    selectedArtifactId: input.selectedArtifactId ?? null,
    resultState: fullRuntimeProof?.resultState ?? null,
    degradedState: fullRuntimeProof?.degradedState ?? null,
    degradedReason: fullRuntimeProof?.degradedReason ?? null,
    fullRuntimeProven: fullRuntimeProof?.fullRuntimeProven === true,
    componentStates: fullRuntimeProof?.componentStates ?? null,
    stageResults: stages,
    limitations,
    evidenceRefs,
    visualEvidenceRefs,
    visualEvidenceArtifacts,
    proofFacets,
    runtimeEvidence,
    validationContext,
    targetProgression,
    target_progression: targetProgression,
    targetProgressionLedger,
    target_progression_ledger: targetProgressionLedger,
    targetProgressionGates,
    target_progression_gates: targetProgressionGates,
    acceptanceContract,
    acceptance_contract: acceptanceContract,
    acceptanceContractEvaluation,
    acceptance_contract_evaluation: acceptanceContractEvaluation,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery,
    proof_ledger_query: proofLedgerQuery,
    gpuHmrSuccess: proofLedgerQuery.gpuHmrSuccess === true && acceptanceContractEvaluation.accepted === true,
    gpu_hmr_success: proofLedgerQuery.gpuHmrSuccess === true && acceptanceContractEvaluation.accepted === true,
    validationContextHash,
    createdAt,
    proofMaterial,
  };
}

export async function visualEvidenceArtifactsFromFiles(paths, existingArtifacts = []) {
  const existingByPath = visualArtifactMap(existingArtifacts);
  const records = [];
  for (const artifactPath of compactStringList(paths)) {
    const existing = existingByPath.get(artifactPath) ?? {};
    let fileRecord = null;
    try {
      const bytes = await readFile(artifactPath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      fileRecord = {
        path: artifactPath,
        bytes: bytes.length,
        contentHash: `sha256:${digest}`,
        evidenceId: `evidence:visual-artifact:sha256:${digest}`,
        readError: null,
      };
    } catch (error) {
      fileRecord = {
        path: artifactPath,
        bytes: null,
        contentHash: null,
        evidenceId: null,
        readError: error?.message ? String(error.message) : String(error),
      };
    }
    records.push({
      ...existing,
      ...fileRecord,
      kind: 'visual-artifact',
      producerSubsystem: 'mcp.gpu_hmr_validation',
      summary: existing.summary ?? artifactPath,
    });
  }
  return records;
}

export async function writeValidationRuntimeProofArtifact(outputDir, input = {}) {
  const visualEvidenceArtifacts = await visualEvidenceArtifactsFromFiles(
    input.visualEvidenceRefs,
    input.visualEvidenceArtifacts,
  );
  const artifact = buildValidationRuntimeProofArtifact({
    ...input,
    visualEvidenceArtifacts,
  });
  await mkdir(outputDir, { recursive: true });
  const workspace = safeToken(input.workspaceSlug);
  const label = safeToken(input.label ?? input.name ?? artifact.resultState ?? 'runtime-proof');
  const hash = artifact.proofId.split(':').pop();
  const filePath = path.join(outputDir, `${workspace}-${label}-${hash}.json`);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return { path: filePath, artifact };
}
