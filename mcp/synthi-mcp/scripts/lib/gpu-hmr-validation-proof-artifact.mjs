import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  buildGpuHmrProofLedger,
  normalizeGpuHmrProofLedgerRecord,
  queryGpuHmrLedgerInvariants,
} from './gpu-hmr-proof-ledger.mjs';
import {
  deriveGpuHmrAcceptanceContractFromVerifiedProofs,
  evaluateGpuHmrAcceptanceContract,
  evaluateGpuHmrAcceptanceContractConsistency,
  normalizeGpuHmrAcceptanceContract,
} from './gpu-hmr-acceptance-contract.mjs';
import {
  analyzeGpuHmrImageEvidence,
  evaluateGpuHmrDeterministicVisualMode,
  screenshotQualifiesAsVisualEvidence,
} from './gpu-hmr-visual-evidence.mjs';

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

const REQUIRED_RUNTIME_STAGE_IDS = [
  'fission-candidate-verification',
  'compile',
  'symbol-binding',
  'abi',
  'artifact-transport',
  'epoch-swap',
  'dispatch-safe',
  'output',
  'artifact-identity',
  'host-preservation',
];

function fullRuntimeStructuralLimitations(stages, fullRuntimeProof) {
  const limitations = [];
  if (!fullRuntimeProof || typeof fullRuntimeProof !== 'object') {
    limitations.push({
      stageId: 'full-runtime',
      stage_id: 'full-runtime',
      status: 'blocked',
      requiredState: 'gpu-hmr-full-runtime-proven',
      required_state: 'gpu-hmr-full-runtime-proven',
      observedState: null,
      observed_state: null,
      degradedState: 'gpu-hmr-full-runtime-unverified',
      degraded_state: 'gpu-hmr-full-runtime-unverified',
      degradedReason: 'full_runtime_proof_missing',
      degraded_reason: 'full_runtime_proof_missing',
      proofArtifactPath: null,
      proof_artifact_path: null,
      phase: null,
      name: null,
    });
    return limitations;
  }
  if (fullRuntimeProof.fullRuntimeProven !== true) {
    limitations.push({
      stageId: 'full-runtime',
      stage_id: 'full-runtime',
      status: 'blocked',
      requiredState: 'gpu-hmr-full-runtime-proven',
      required_state: 'gpu-hmr-full-runtime-proven',
      observedState: fullRuntimeProof.resultState ?? null,
      observed_state: fullRuntimeProof.resultState ?? null,
      degradedState: fullRuntimeProof.degradedState ?? 'gpu-hmr-full-runtime-unverified',
      degraded_state: fullRuntimeProof.degradedState ?? 'gpu-hmr-full-runtime-unverified',
      degradedReason: fullRuntimeProof.degradedReason ?? 'full_runtime_proof_not_proven',
      degraded_reason: fullRuntimeProof.degradedReason ?? 'full_runtime_proof_not_proven',
      proofArtifactPath: null,
      proof_artifact_path: null,
      phase: null,
      name: null,
    });
  }
  const stageById = new Map((Array.isArray(stages) ? stages : []).map((stage) => [stage.stageId, stage]));
  for (const stageId of REQUIRED_RUNTIME_STAGE_IDS) {
    const stage = stageById.get(stageId);
    if (!stage || stage.status !== 'passed') {
      limitations.push({
        stageId: 'full-runtime',
        stage_id: 'full-runtime',
        status: 'blocked',
        requiredState: 'gpu-hmr-full-runtime-proven',
        required_state: 'gpu-hmr-full-runtime-proven',
        observedState: stage?.observedState ?? null,
        observed_state: stage?.observedState ?? null,
        degradedState: stage?.degradedState ?? 'gpu-hmr-full-runtime-stage-missing',
        degraded_state: stage?.degradedState ?? 'gpu-hmr-full-runtime-stage-missing',
        degradedReason: stage ? `required_stage_not_passed:${stageId}` : `required_stage_missing:${stageId}`,
        degraded_reason: stage ? `required_stage_not_passed:${stageId}` : `required_stage_missing:${stageId}`,
        proofArtifactPath: stage?.proofArtifactPath ?? null,
        proof_artifact_path: stage?.proof_artifact_path ?? null,
        phase: stage?.phase ?? null,
        name: stage?.name ?? null,
      });
    }
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

function acceptanceContractConsistencyLimitations(evaluation) {
  if (!objectOrNull(evaluation) || evaluation.accepted === true) return [];
  return compactObjects(evaluation.failedGates).map((gate) => ({
    stageId: 'acceptance-contract-consistency',
    stage_id: 'acceptance-contract-consistency',
    status: 'blocked',
    requiredState: 'gpu-hmr-acceptance-contract-backed-by-verified-proofs',
    required_state: 'gpu-hmr-acceptance-contract-backed-by-verified-proofs',
    observedState: null,
    observed_state: null,
    degradedState: 'gpu-hmr-acceptance-contract-mismatch',
    degraded_state: 'gpu-hmr-acceptance-contract-mismatch',
    degradedReason: gate.code ?? 'acceptance_contract_consistency_failed',
    degraded_reason: gate.code ?? 'acceptance_contract_consistency_failed',
    field: gate.field ?? null,
    explicitValue: gate.explicitValue ?? null,
    explicit_value: gate.explicit_value ?? null,
    derivedValue: gate.derivedValue ?? null,
    derived_value: gate.derived_value ?? null,
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

const VISUAL_ORACLE_ARTIFACT_HINT_FIELDS = [
  'before_image',
  'beforeImage',
  'after_image',
  'afterImage',
  'diff_image',
  'diffImage',
  'changed_pixel_ratio',
  'changedPixelRatio',
  'visible_pixel_count',
  'visiblePixelCount',
];

const COMPUTE_ORACLE_ARTIFACT_HINT_FIELDS = [
  'raw_readback_bin',
  'rawReadbackBin',
  'readback_schema_json',
  'readbackSchemaJson',
  'checksum_before',
  'checksumBefore',
  'checksum_after',
  'checksumAfter',
  'deterministic_slice',
  'deterministicSlice',
];

function objectHasAnyRecordedField(object, keys) {
  const source = objectOrNull(object);
  if (!source) return false;
  return keys.some((key) => {
    if (!Object.prototype.hasOwnProperty.call(source, key)) return false;
    const value = source[key];
    if (typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    return value && typeof value === 'object' && Object.keys(value).length > 0;
  });
}

function firstOracleArtifactObject(candidates, hintFields) {
  for (const candidate of candidates) {
    const object = objectOrNull(candidate);
    if (object && objectHasAnyRecordedField(object, hintFields)) return object;
  }
  return null;
}

function visualOracleArtifactsFromOutputProof(outputProof) {
  const proof = objectOrNull(outputProof) ?? {};
  const oracle = objectOrNull(proof.outputOracle) ?? objectOrNull(proof.output_oracle) ?? {};
  const proofOracleArtifacts = objectOrNull(proof.oracleArtifacts) ?? objectOrNull(proof.oracle_artifacts) ?? {};
  const nestedOracleArtifacts = objectOrNull(oracle.oracleArtifacts) ?? objectOrNull(oracle.oracle_artifacts) ?? {};
  return firstOracleArtifactObject([
    proof.visualOracleArtifacts,
    proof.visual_oracle_artifacts,
    proofOracleArtifacts.visualOracleArtifacts,
    proofOracleArtifacts.visual_oracle_artifacts,
    oracle.visualOracleArtifacts,
    oracle.visual_oracle_artifacts,
    nestedOracleArtifacts.visualOracleArtifacts,
    nestedOracleArtifacts.visual_oracle_artifacts,
    proofOracleArtifacts,
    nestedOracleArtifacts,
    proof,
    oracle,
  ], VISUAL_ORACLE_ARTIFACT_HINT_FIELDS);
}

function computeOracleArtifactsFromOutputProof(outputProof) {
  const proof = objectOrNull(outputProof) ?? {};
  const oracle = objectOrNull(proof.outputOracle) ?? objectOrNull(proof.output_oracle) ?? {};
  const proofOracleArtifacts = objectOrNull(proof.oracleArtifacts) ?? objectOrNull(proof.oracle_artifacts) ?? {};
  const nestedOracleArtifacts = objectOrNull(oracle.oracleArtifacts) ?? objectOrNull(oracle.oracle_artifacts) ?? {};
  return firstOracleArtifactObject([
    proof.computeOracleArtifacts,
    proof.compute_oracle_artifacts,
    proofOracleArtifacts.computeOracleArtifacts,
    proofOracleArtifacts.compute_oracle_artifacts,
    oracle.computeOracleArtifacts,
    oracle.compute_oracle_artifacts,
    nestedOracleArtifacts.computeOracleArtifacts,
    nestedOracleArtifacts.compute_oracle_artifacts,
    proofOracleArtifacts,
    nestedOracleArtifacts,
    proof,
    oracle,
  ], COMPUTE_ORACLE_ARTIFACT_HINT_FIELDS);
}

function oracleArtifactsFromOutputProof(outputProof) {
  const proof = objectOrNull(outputProof) ?? {};
  const direct = objectOrNull(proof.oracleArtifacts) ?? objectOrNull(proof.oracle_artifacts) ?? {};
  const visual = visualOracleArtifactsFromOutputProof(proof);
  const compute = computeOracleArtifactsFromOutputProof(proof);
  const artifacts = { ...direct };
  if (visual) artifacts.visual_oracle_artifacts = visual;
  if (compute) artifacts.compute_oracle_artifacts = compute;
  return artifacts;
}

function proofOutputKind(outputProof) {
  const proof = objectOrNull(outputProof) ?? {};
  const oracle = objectOrNull(proof.outputOracle) ?? objectOrNull(proof.output_oracle) ?? {};
  return String(firstString(
    proof.kind,
    proof.oracleKind,
    proof.oracle_kind,
    oracle.kind,
    oracle.oracleKind,
    oracle.oracle_kind,
  ) ?? '').toLowerCase();
}

function outputProofRequiresVisualEvidence(outputProof, visualEvidenceRefs, visualEvidenceArtifacts) {
  const proof = objectOrNull(outputProof) ?? {};
  const kind = proofOutputKind(proof);
  return proof.visualEvidenceRequired === true
    || proof.visual_evidence_required === true
    || proof.renderVisualEvidenceRequired === true
    || proof.render_visual_evidence_required === true
    || proof.visualFrameObserved === true
    || proof.visual_frame_observed === true
    || kind.includes('visual')
    || kind.includes('render')
    || kind.includes('frame')
    || kind.includes('pixel')
    || visualOracleArtifactsFromOutputProof(proof) !== null
    || compactStringList(visualEvidenceRefs).length > 0
    || compactObjects(visualEvidenceArtifacts).length > 0;
}

function visualArtifactPath(artifact) {
  return firstString(artifact.path, artifact.filePath, artifact.file_path);
}

function visualArtifactHash(artifact) {
  return firstString(artifact.contentHash, artifact.content_hash);
}

function visualArtifactAccepted(artifact) {
  return artifact.acceptedAsVisualEvidence === true
    || artifact.accepted_as_visual_evidence === true;
}

function visualArtifactQuality(artifact) {
  return firstString(artifact.visualQuality, artifact.visual_quality);
}

function visualProofArtifactLimitations({ outputProof, visualEvidenceRefs, visualEvidenceArtifacts }) {
  const artifacts = compactObjects(visualEvidenceArtifacts);
  const refs = compactStringList(visualEvidenceRefs);
  if (!outputProofRequiresVisualEvidence(outputProof, refs, artifacts)) return [];

  const limitations = [];
  if (refs.length === 0 && artifacts.length === 0) {
    limitations.push({
      degradedReason: 'visual_evidence_artifacts_missing',
      observedState: 'missing',
    });
  }

  for (const artifact of artifacts) {
    const readError = firstString(artifact.readError, artifact.read_error);
    const visualAnalysisError = firstString(
      artifact.visualAnalysisError,
      artifact.visual_analysis_error,
    );
    if (readError) {
      limitations.push({
        degradedReason: 'visual_artifact_read_error',
        observedState: readError,
        proofArtifactPath: visualArtifactPath(artifact),
      });
    }
    if (visualAnalysisError) {
      limitations.push({
        degradedReason: 'visual_artifact_analysis_error',
        observedState: visualAnalysisError,
        proofArtifactPath: visualArtifactPath(artifact),
      });
    }
    if (!visualArtifactAccepted(artifact)) {
      limitations.push({
        degradedReason: 'visual_artifact_not_accepted',
        observedState: visualArtifactQuality(artifact) ?? 'gpu-hmr-visual-unaccepted',
        proofArtifactPath: visualArtifactPath(artifact),
      });
    }
  }

  const acceptedArtifacts = artifacts.filter(visualArtifactAccepted);
  if (acceptedArtifacts.length === 0) {
    limitations.push({
      degradedReason: 'accepted_visual_artifact_missing',
      observedState: artifacts.length > 0 ? 'all_visual_artifacts_rejected' : 'missing',
    });
  }

  const oracleArtifacts = visualOracleArtifactsFromOutputProof(outputProof);
  const beforePath = firstString(oracleArtifacts?.before_image, oracleArtifacts?.beforeImage);
  const afterPath = firstString(oracleArtifacts?.after_image, oracleArtifacts?.afterImage);
  if (beforePath && afterPath) {
    const artifactsByPath = new Map(artifacts.map((artifact) => [visualArtifactPath(artifact), artifact]));
    const before = artifactsByPath.get(beforePath);
    const after = artifactsByPath.get(afterPath);
    if (!before || !after) {
      limitations.push({
        degradedReason: 'visual_before_after_artifacts_missing',
        observedState: 'missing_before_or_after_image',
      });
    } else if (!visualArtifactAccepted(before) || !visualArtifactAccepted(after)) {
      limitations.push({
        degradedReason: 'visual_before_after_artifacts_not_accepted',
        observedState: 'before_or_after_rejected',
      });
    } else {
      const beforeHash = visualArtifactHash(before);
      const afterHash = visualArtifactHash(after);
      if (beforeHash && afterHash && beforeHash === afterHash) {
        limitations.push({
          degradedReason: 'visual_before_after_same_frame',
          observedState: beforeHash,
          proofArtifactPath: afterPath,
        });
      }
    }
  }

  return limitations.map((limitation) => ({
    stageId: 'visual-evidence',
    stage_id: 'visual-evidence',
    status: 'blocked',
    requiredState: 'gpu-hmr-visual-evidence-accepted',
    required_state: 'gpu-hmr-visual-evidence-accepted',
    observedState: limitation.observedState ?? null,
    observed_state: limitation.observedState ?? null,
    degradedState: 'gpu-hmr-visual-evidence-rejected',
    degraded_state: 'gpu-hmr-visual-evidence-rejected',
    degradedReason: limitation.degradedReason,
    degraded_reason: limitation.degradedReason,
    proofArtifactPath: limitation.proofArtifactPath ?? null,
    proof_artifact_path: limitation.proofArtifactPath ?? null,
    phase: null,
    name: null,
  }));
}

function proofLedgerLimitations(query) {
  if (!objectOrNull(query) || query.gpuHmrSuccess === true) return [];
  return compactObjects(query.failedInvariants).map((failure) => ({
    stageId: 'proof-ledger',
    stage_id: 'proof-ledger',
    status: 'blocked',
    requiredState: 'gpu-hmr-ledger-invariants-proven',
    required_state: 'gpu-hmr-ledger-invariants-proven',
    observedState: null,
    observed_state: null,
    degradedState: 'gpu-hmr-ledger-invariants-failed',
    degraded_state: 'gpu-hmr-ledger-invariants-failed',
    degradedReason: failure.code ?? 'proof_ledger_invariant_failed',
    degraded_reason: failure.code ?? 'proof_ledger_invariant_failed',
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }));
}

function objectOrNull(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function hasOwn(object, key) {
  return object && typeof object === 'object' && Object.prototype.hasOwnProperty.call(object, key);
}

function firstPresent(...entries) {
  for (const [object, key] of entries) {
    if (hasOwn(object, key)) return { present: true, value: object[key] };
  }
  return { present: false, value: undefined };
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function firstStringOrFiniteNumber(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (Number.isFinite(value)) return String(value);
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
  return firstStringOrFiniteNumber(
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

function explicitProofLedgerRecordFromInput(input = {}) {
  return objectOrNull(input.proofLedgerRecord)
    ?? objectOrNull(input.proof_ledger_record)
    ?? objectOrNull(input.proofLedger?.record)
    ?? objectOrNull(input.proof_ledger?.record)
    ?? null;
}

function hasLedgerPath(object, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (!objectOrNull(current) || !hasOwn(current, part)) return false;
    current = current[part];
  }
  return true;
}

function ledgerPathValue(object, pathParts) {
  let current = object;
  for (const part of pathParts) {
    if (!objectOrNull(current) || !hasOwn(current, part)) return undefined;
    current = current[part];
  }
  return current;
}

function ledgerFirstPathValue(record, paths) {
  for (const pathParts of paths) {
    if (hasLedgerPath(record, pathParts)) {
      const value = ledgerPathValue(record, pathParts);
      if (value !== undefined && value !== null && value !== '') return value;
    }
  }
  return undefined;
}

function proofLedgerSourceConsistencyFailureCode(label, suffix) {
  return `proof_ledger_source_${String(label).replace(/[^A-Za-z0-9]+/g, '_').toLowerCase()}_${suffix}`;
}

function canonicalProofLedgerComparableValue(label, value) {
  if (
    value !== undefined
    && value !== null
    && /(?:^|_)artifact_(?:after_|before_)?hash$|artifact_hash$/.test(label)
    && typeof value === 'string'
  ) {
    return firstArtifactId(value) ?? value;
  }
  return value;
}

function compareProofLedgerField(failures, label, explicitRecord, derivedRecord, paths) {
  const explicitValue = canonicalProofLedgerComparableValue(
    label,
    ledgerFirstPathValue(explicitRecord, paths),
  );
  const derivedValue = canonicalProofLedgerComparableValue(
    label,
    ledgerFirstPathValue(derivedRecord, paths),
  );
  if (explicitValue === undefined) return;
  if (derivedValue === undefined) {
    failures.push({
      code: proofLedgerSourceConsistencyFailureCode(label, 'unverified'),
      field: label,
      explicit: explicitValue,
      derived: null,
    });
    return;
  }
  if (stableJson(explicitValue) !== stableJson(derivedValue)) {
    failures.push({
      code: proofLedgerSourceConsistencyFailureCode(label, 'mismatch'),
      field: label,
      explicit: explicitValue,
      derived: derivedValue,
    });
  }
}

function evaluateProofLedgerSourceConsistency(explicitRecord, derivedRecord) {
  if (!explicitRecord) {
    return {
      accepted: true,
      mode: 'derived_only',
      failures: [],
    };
  }
  const normalizedExplicit = normalizeGpuHmrProofLedgerRecord(explicitRecord);
  const normalizedDerived = normalizeGpuHmrProofLedgerRecord(derivedRecord ?? {});
  const failures = [];
  const fieldSpecs = [
    ['classification_project_kind', [['classification', 'project_kind'], ['classification', 'projectKind']]],
    ['classification_edit_kind', [['classification', 'edit_kind'], ['classification', 'editKind']]],
    ['classification_route', [['classification', 'route']]],
    ['contract_hash', [['contractHash']]],
    ['artifact_before_hash', [['artifactBeforeHash']]],
    ['artifact_after_hash', [['artifactAfterHash']]],
    ['loader_event_id', [['loaderEvent', 'id']]],
    ['loader_event_artifact_hash', [['loaderEvent', 'artifact_hash'], ['loaderEvent', 'artifactHash']]],
    ['loader_event_process_id', [['loaderEvent', 'process_id'], ['loaderEvent', 'processId']]],
    ['epoch_publish_event_id', [['epochPublishEvent', 'id']]],
    ['epoch_publish_event_artifact_hash', [['epochPublishEvent', 'artifact_hash'], ['epochPublishEvent', 'artifactHash']]],
    ['epoch_publish_event_epoch', [['epochPublishEvent', 'epoch']]],
    ['epoch_publish_event_process_id', [['epochPublishEvent', 'process_id'], ['epochPublishEvent', 'processId']]],
    ['dispatch_event_id', [['dispatchEvent', 'id']]],
    ['dispatch_event_artifact_hash', [['dispatchEvent', 'artifact_hash'], ['dispatchEvent', 'artifactHash']]],
    ['dispatch_event_epoch', [['dispatchEvent', 'epoch']]],
    ['dispatch_event_process_id', [['dispatchEvent', 'process_id'], ['dispatchEvent', 'processId']]],
    ['output_event_after_dispatch_id', [['outputEvent', 'after_dispatch_id'], ['outputEvent', 'afterDispatchId']]],
    ['output_event_artifact_hash', [['outputEvent', 'artifact_hash'], ['outputEvent', 'artifactHash']]],
    ['output_event_epoch', [['outputEvent', 'epoch']]],
    ['output_event_process_id', [['outputEvent', 'process_id'], ['outputEvent', 'processId']]],
    ['output_event_passed', [['outputEvent', 'passed']]],
    ['process_identity_process_id', [['processIdentity', 'process_id'], ['processIdentity', 'processId']]],
    ['device_identity_device_uuid', [['deviceIdentity', 'device_uuid'], ['deviceIdentity', 'deviceUuid']]],
    ['cpu_hmr_used', [['cpuHmrUsed']]],
    ['full_rebuild_used', [['fullRebuildUsed']]],
    ['process_restarted', [['processRestarted']]],
  ];
  for (const [label, paths] of fieldSpecs) {
    compareProofLedgerField(failures, label, normalizedExplicit, normalizedDerived, paths);
  }
  return {
    accepted: failures.length === 0,
    mode: 'explicit_vs_derived',
    failures,
    explicitProofId: normalizedExplicit.proofId,
    derivedProofId: normalizedDerived.proofId,
  };
}

function proofLedgerSourceConsistencyLimitations(consistency) {
  if (!objectOrNull(consistency) || consistency.accepted === true) return [];
  return compactObjects(consistency.failures).map((failure) => ({
    stageId: 'proof-ledger-source-consistency',
    stage_id: 'proof-ledger-source-consistency',
    status: 'blocked',
    requiredState: 'gpu-hmr-ledger-source-consistent',
    required_state: 'gpu-hmr-ledger-source-consistent',
    observedState: failure.field ?? null,
    observed_state: failure.field ?? null,
    degradedState: 'gpu-hmr-ledger-source-inconsistent',
    degraded_state: 'gpu-hmr-ledger-source-inconsistent',
    degradedReason: failure.code ?? 'proof_ledger_source_inconsistent',
    degraded_reason: failure.code ?? 'proof_ledger_source_inconsistent',
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }));
}

function buildProofLedgerRecordFromInput(input, validationContext, options = {}) {
  const acceptanceContract = objectOrNull(input.acceptanceContract)
    ?? objectOrNull(input.acceptance_contract)
    ?? objectOrNull(validationContext?.acceptanceContract)
    ?? objectOrNull(validationContext?.acceptance_contract);
  const explicit = explicitProofLedgerRecordFromInput(input);
  if (explicit && options.allowExplicit !== false) return explicit;

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
  const firewallEvidence = objectOrNull(input.firewallEvidence)
    ?? objectOrNull(input.firewall_evidence)
    ?? objectOrNull(validationContext?.firewallEvidence)
    ?? objectOrNull(validationContext?.firewall_evidence)
    ?? null;
  const cpuHmrUsed = firstPresent(
    [input, 'cpuHmrUsed'],
    [input, 'cpu_hmr_used'],
    [validationContext, 'cpuHmrUsed'],
    [validationContext, 'cpu_hmr_used'],
    [firewallEvidence, 'cpuHmrUsed'],
    [firewallEvidence, 'cpu_hmr_used'],
  );
  const fullRebuildUsed = firstPresent(
    [input, 'fullRebuildUsed'],
    [input, 'full_rebuild_used'],
    [validationContext, 'fullRebuildUsed'],
    [validationContext, 'full_rebuild_used'],
    [firewallEvidence, 'fullRebuildUsed'],
    [firewallEvidence, 'full_rebuild_used'],
  );
  const processRestarted = firstPresent(
    [input, 'processRestarted'],
    [input, 'process_restarted'],
    [validationContext, 'processRestarted'],
    [validationContext, 'process_restarted'],
    [firewallEvidence, 'processRestarted'],
    [firewallEvidence, 'process_restarted'],
  );
  const publication = latestPublicationFromEpochProof(epochProof) ?? {};
  const artifactAfterHash = firstArtifactId(
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
    acceptanceContract?.artifact_hash_after,
    acceptanceContract?.artifactHashAfter,
    input.artifactAfterHash,
    input.artifact_after_hash,
    input.changedGpuArtifactHash,
    input.changed_gpu_artifact_hash,
  );
  const artifactBeforeHash = firstArtifactId(
    publication.oldArtifactId,
    publication.old_artifact_id,
    publication.oldArtifactHash,
    publication.old_artifact_hash,
    sourceProof?.artifactBeforeId,
    sourceProof?.artifact_before_id,
    sourceProof?.artifactBeforeHash,
    sourceProof?.artifact_before_hash,
    acceptanceContract?.artifact_hash_before,
    acceptanceContract?.artifactHashBefore,
    input.artifactBeforeHash,
    input.artifact_before_hash,
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

  const record = {
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
      process_id: firstString(
        epochProof?.processId,
        epochProof?.process_id,
        publication.processId,
        publication.process_id,
      ),
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
      process_id: firstString(
        outputProof?.processId,
        outputProof?.process_id,
        outputOracle.processId,
        outputOracle.process_id,
      ),
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
    device_identity: input.deviceIdentity
      ?? input.device_identity
      ?? validationContext?.deviceIdentity
      ?? validationContext?.device_identity
      ?? (firstString(input.deviceUuid, input.device_uuid, validationContext?.deviceUuid, validationContext?.device_uuid)
        ? {
            device_uuid: firstString(
              input.deviceUuid,
              input.device_uuid,
              validationContext?.deviceUuid,
              validationContext?.device_uuid,
            ),
          }
        : {}),
    firewall_evidence: firewallEvidence ?? {},
    oracle_artifacts: oracleArtifactsFromOutputProof(outputProof),
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
    metric_clock:
      input.metricClock
      ?? input.metric_clock
      ?? validationContext?.metricClock
      ?? validationContext?.metric_clock
      ?? input.timings?.metricClock
      ?? input.timings?.metric_clock
      ?? validationContext?.timings?.metricClock
      ?? validationContext?.timings?.metric_clock,
    metric_scope:
      input.metricScope
      ?? input.metric_scope
      ?? validationContext?.metricScope
      ?? validationContext?.metric_scope
      ?? input.timings?.metricScope
      ?? input.timings?.metric_scope
      ?? validationContext?.timings?.metricScope
      ?? validationContext?.timings?.metric_scope,
    cache_state:
      input.cacheState
      ?? input.cache_state
      ?? validationContext?.cacheState
      ?? validationContext?.cache_state
      ?? input.timings?.cacheState
      ?? input.timings?.cache_state
      ?? validationContext?.timings?.cacheState
      ?? validationContext?.timings?.cache_state,
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
  if (cpuHmrUsed.present) record.cpu_hmr_used = cpuHmrUsed.value === true;
  if (fullRebuildUsed.present) record.full_rebuild_used = fullRebuildUsed.value === true;
  if (processRestarted.present) record.process_restarted = processRestarted.value === true;
  return record;
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
  const derivedAcceptanceContract = deriveGpuHmrAcceptanceContractFromVerifiedProofs({
    ...input,
    validationContext,
  });
  const derivedAcceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(
    derivedAcceptanceContract ?? {
      classification: input.classification ?? validationContext?.classification ?? {},
    },
  );
  const acceptanceContract = explicitAcceptanceContract
    ?? derivedAcceptanceContract;
  const acceptanceContractEvaluation = evaluateGpuHmrAcceptanceContract(
    acceptanceContract ?? {
      classification: input.classification ?? validationContext?.classification ?? {},
    },
  );
  const acceptanceContractConsistency = evaluateGpuHmrAcceptanceContractConsistency({
    explicitContract: explicitAcceptanceContract,
    derivedContract: derivedAcceptanceContract,
    derivedEvaluation: derivedAcceptanceContractEvaluation,
  });
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
  const proofLedgerRecordInput = {
    ...input,
    acceptanceContract,
  };
  const explicitProofLedgerRecord = explicitProofLedgerRecordFromInput(proofLedgerRecordInput);
  const derivedProofLedgerRecord = buildProofLedgerRecordFromInput(
    proofLedgerRecordInput,
    validationContext,
    { allowExplicit: false },
  );
  const proofLedgerSourceConsistency = evaluateProofLedgerSourceConsistency(
    explicitProofLedgerRecord,
    derivedProofLedgerRecord,
  );
  const proofLedgerRecord = explicitProofLedgerRecord ?? derivedProofLedgerRecord;
  const proofLedger = buildGpuHmrProofLedger(proofLedgerRecord);
  const proofLedgerQuery = queryGpuHmrLedgerInvariants(proofLedger);
  const visualEvidenceRefs = compactStringList(input.visualEvidenceRefs);
  const visualEvidenceArtifacts = compactObjects(input.visualEvidenceArtifacts);
  const visualArtifactsByPath = visualArtifactMap(visualEvidenceArtifacts);
  const stages = Array.isArray(fullRuntimeProof?.stages)
    ? fullRuntimeProof.stages.map((stage) => proofStageResult(stage, input, createdAt))
    : [];
  const limitations = [
    ...fullRuntimeStructuralLimitations(stages, fullRuntimeProof),
    ...proofLimitations(stages, fullRuntimeProof),
    ...acceptanceContractLimitations(acceptanceContractEvaluation),
    ...acceptanceContractConsistencyLimitations(acceptanceContractConsistency),
    ...deterministicVisualModeLimitations(deterministicVisualModeEvaluation),
    ...visualProofArtifactLimitations({ outputProof, visualEvidenceRefs, visualEvidenceArtifacts }),
    ...proofLedgerSourceConsistencyLimitations(proofLedgerSourceConsistency),
    ...proofLedgerLimitations(proofLedgerQuery),
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
    workspaceSlug: input.workspaceSlug ?? null,
    sourceEditId: input.sourceEditId ?? null,
    backend: input.backend ?? null,
    gpuBackend: input.gpuBackend ?? input.gpu_backend ?? null,
    gpuVendor: input.gpuVendor ?? input.gpu_vendor ?? null,
    gpuArch: input.gpuArch ?? input.gpu_arch ?? null,
    processId: input.processId ?? input.process_id ?? null,
    deviceUuid: input.deviceUuid ?? input.device_uuid ?? null,
    contextHandle: input.contextHandle ?? input.context_handle ?? null,
    contextOrDeviceHandle: input.contextOrDeviceHandle ?? input.context_or_device_handle ?? null,
    cameraStateHash: input.cameraStateHash ?? input.camera_state_hash ?? null,
    swapchainOrFramebufferIdentity:
      input.swapchainOrFramebufferIdentity ?? input.swapchain_or_framebuffer_identity ?? null,
    engineSceneHandles: input.engineSceneHandles ?? input.engine_scene_handles ?? null,
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
    derivedAcceptanceContract,
    derivedAcceptanceContractEvaluation,
    acceptanceContractConsistency,
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
    derivedProofLedgerRecord,
    explicitProofLedgerRecord,
    proofLedgerSourceConsistency,
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
    derivedAcceptanceContract,
    derivedAcceptanceContractEvaluation,
    acceptanceContractConsistency,
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
    derivedProofLedgerRecord,
    explicitProofLedgerRecord,
    proofLedgerSourceConsistency,
    proofLedger,
    proofLedgerQuery,
    visualEvidenceArtifacts,
  }));
  const validationContextHash = validationContext
    ? `sha256:${sha256Hex(stableJson(validationContext))}`
    : null;
  const gpuHmrSuccess = fullRuntimeProof?.fullRuntimeProven === true
    && stages.length > 0
    && stages.every((stage) => stage.status === 'passed')
    && limitations.length === 0
    && proofLedgerQuery.gpuHmrSuccess === true
    && acceptanceContractEvaluation.accepted === true
    && acceptanceContractConsistency.accepted === true
    && (
      deterministicVisualModeEvaluation
        ? deterministicVisualModeEvaluation.accepted === true
        : true
    );

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
    derivedAcceptanceContract,
    derived_acceptance_contract: derivedAcceptanceContract,
    derivedAcceptanceContractEvaluation,
    derived_acceptance_contract_evaluation: derivedAcceptanceContractEvaluation,
    acceptanceContractConsistency,
    acceptance_contract_consistency: acceptanceContractConsistency,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    deterministicVisualModeEvaluation,
    deterministic_visual_mode_evaluation: deterministicVisualModeEvaluation,
    proofLedger,
    proof_ledger: proofLedger,
    proofLedgerQuery,
    proof_ledger_query: proofLedgerQuery,
    derivedProofLedgerRecord,
    derived_proof_ledger_record: derivedProofLedgerRecord,
    explicitProofLedgerRecord,
    explicit_proof_ledger_record: explicitProofLedgerRecord,
    proofLedgerSourceConsistency,
    proof_ledger_source_consistency: proofLedgerSourceConsistency,
    gpuHmrSuccess,
    gpu_hmr_success: gpuHmrSuccess,
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
    let imageEvidence = null;
    let visualAnalysisError = null;
    try {
      const bytes = await readFile(artifactPath);
      const digest = createHash('sha256').update(bytes).digest('hex');
      try {
        imageEvidence = await analyzeGpuHmrImageEvidence(artifactPath);
      } catch (error) {
        visualAnalysisError = error?.message ? String(error.message) : String(error);
      }
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
    const imageRecord = imageEvidence ? {
      width: imageEvidence.width,
      height: imageEvidence.height,
      visiblePixels: imageEvidence.visible_pixels,
      visible_pixels: imageEvidence.visible_pixels,
      meanLuma: imageEvidence.mean_luma,
      mean_luma: imageEvidence.mean_luma,
      lumaStddev: imageEvidence.luma_stddev,
      luma_stddev: imageEvidence.luma_stddev,
      rgbSpanMean: imageEvidence.rgb_span_mean,
      rgb_span_mean: imageEvidence.rgb_span_mean,
      uniqueColorSampleCount: imageEvidence.unique_color_sample_count,
      unique_color_sample_count: imageEvidence.unique_color_sample_count,
      visualQuality: imageEvidence.visual_quality,
      visual_quality: imageEvidence.visual_quality,
      acceptedAsVisualEvidence: screenshotQualifiesAsVisualEvidence({
        path: artifactPath,
        ...imageEvidence,
      }),
      accepted_as_visual_evidence: screenshotQualifiesAsVisualEvidence({
        path: artifactPath,
        ...imageEvidence,
      }),
    } : {};
    records.push({
      ...existing,
      ...fileRecord,
      ...imageRecord,
      visualAnalysisError,
      visual_analysis_error: visualAnalysisError,
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
