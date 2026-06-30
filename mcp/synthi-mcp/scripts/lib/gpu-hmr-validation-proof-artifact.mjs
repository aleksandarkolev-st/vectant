import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
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
  visualEvidenceAcceptedAsRuntimeProof,
  visualEvidenceIsSupplementalOnly,
} from './gpu-hmr-visual-evidence.mjs';
import {
  adversarialPreflightStrictGate,
} from './gpu-hmr-proof-strict-gates.mjs';
import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  collectArtifactLocators,
  defaultCasRootFromEnv,
  validateArtifactCasManifest,
} from './gpu-hmr-artifact-cas.mjs';

export const GPU_HMR_VALIDATION_PROOF_SCHEMA_VERSION = 'synthi.gpu.hmr.proof.v1';

const VISUAL_OR_ENGINE_BACKENDS = new Set(['hiprt', 'vulkan', 'webgpu', 'bevy_wgsl']);
const REAL_ROCM_RUNTIME_BOUNDARY_TARGET_ENVIRONMENT_SCHEMA_VERSION =
  'synthi.real_rocm.runtime_boundary_target_environment.v1';
const REAL_ROCM_RUNTIME_BOUNDARY_TARGET_ENVIRONMENT_AUTHORITY =
  'target_environment_exposure_only_not_gpu_hmr_success';
const REAL_ROCM_RUNTIME_BOUNDARY_TARGET_PROCESS_PROVENANCE_SCHEMA_VERSION =
  'synthi.real_rocm.runtime_boundary_target_process_provenance.v1';
const REAL_ROCM_RUNTIME_BOUNDARY_TARGET_PROCESS_PROVENANCE_AUTHORITY =
  'runtime_boundary_target_process_provenance_only_not_gpu_hmr_success';

function sha256Hex(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

function sha256BufferHash(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
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

function adversarialPreflightFacet(preflight) {
  if (!preflight || typeof preflight !== 'object' || Array.isArray(preflight)) return null;
  const strictGate = adversarialPreflightStrictGate(preflight);
  return {
    schemaVersion: preflight.schemaVersion ?? null,
    ok: preflight.ok === true,
    skipped: preflight.skipped === true,
    scriptPath: typeof preflight.scriptPath === 'string' ? preflight.scriptPath : null,
    exitCode: Number.isFinite(preflight.exitCode) ? preflight.exitCode : null,
    elapsedMs: Number.isFinite(preflight.elapsedMs) ? preflight.elapsedMs : null,
    stdoutHash: typeof preflight.stdoutHash === 'string' ? preflight.stdoutHash : null,
    stderrHash: typeof preflight.stderrHash === 'string' ? preflight.stderrHash : null,
    error: preflight.error ?? null,
    reason: preflight.reason ?? null,
    strictGate,
    strict_gate: strictGate,
    accepted: strictGate.accepted === true,
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
    visualEvidenceSupplementalOnly:
      visualArtifact?.visualEvidenceSupplementalOnly
      ?? visualArtifact?.visual_evidence_supplemental_only
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
    visualEvidenceSupplementalOnly:
      artifact.visualEvidenceSupplementalOnly
      ?? artifact.visual_evidence_supplemental_only
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
        visualEvidenceAcceptedAsRuntimeProof(artifact)
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

function realRocmAppHookContractSnapshot(input = {}, validationContext = null) {
  return objectOrNull(input.realRocmAppHookContract)
    ?? objectOrNull(input.real_rocm_app_hook_contract)
    ?? objectOrNull(input.appHookContract)
    ?? objectOrNull(input.app_hook_contract)
    ?? objectOrNull(validationContext?.realRocmAppHookContract)
    ?? objectOrNull(validationContext?.real_rocm_app_hook_contract)
    ?? objectOrNull(validationContext?.appHookContract)
    ?? objectOrNull(validationContext?.app_hook_contract)
    ?? null;
}

function realRocmAppHookMaterializationSnapshot(input = {}, validationContext = null) {
  return objectOrNull(input.realRocmAppHookMaterialization)
    ?? objectOrNull(input.real_rocm_app_hook_materialization)
    ?? objectOrNull(input.appHookMaterialization)
    ?? objectOrNull(input.app_hook_materialization)
    ?? objectOrNull(validationContext?.realRocmAppHookMaterialization)
    ?? objectOrNull(validationContext?.real_rocm_app_hook_materialization)
    ?? objectOrNull(validationContext?.appHookMaterialization)
    ?? objectOrNull(validationContext?.app_hook_materialization)
    ?? null;
}

function realRocmRuntimeProfileAdapterResultSnapshot(input = {}, validationContext = null) {
  return objectOrNull(input.realRocmRuntimeProfileAdapterResult)
    ?? objectOrNull(input.real_rocm_runtime_profile_adapter_result)
    ?? objectOrNull(input.runtimeProfileAdapterResult)
    ?? objectOrNull(input.runtime_profile_adapter_result)
    ?? objectOrNull(validationContext?.realRocmRuntimeProfileAdapterResult)
    ?? objectOrNull(validationContext?.real_rocm_runtime_profile_adapter_result)
    ?? objectOrNull(validationContext?.runtimeProfileAdapterResult)
    ?? objectOrNull(validationContext?.runtime_profile_adapter_result)
    ?? null;
}

function realRocmRuntimeBoundaryTargetEnvironmentSnapshot(input = {}, validationContext = null) {
  return objectOrNull(input.realRocmRuntimeBoundaryTargetEnvironment)
    ?? objectOrNull(input.real_rocm_runtime_boundary_target_environment)
    ?? objectOrNull(input.runtimeBoundaryTargetEnvironment)
    ?? objectOrNull(input.runtime_boundary_target_environment)
    ?? objectOrNull(validationContext?.realRocmRuntimeBoundaryTargetEnvironment)
    ?? objectOrNull(validationContext?.real_rocm_runtime_boundary_target_environment)
    ?? objectOrNull(validationContext?.runtimeBoundaryTargetEnvironment)
    ?? objectOrNull(validationContext?.runtime_boundary_target_environment)
    ?? null;
}

function realRocmRuntimeBoundaryTargetProcessProvenanceSnapshot(
  input = {},
  validationContext = null,
) {
  return objectOrNull(input.realRocmRuntimeBoundaryTargetProcessProvenance)
    ?? objectOrNull(input.real_rocm_runtime_boundary_target_process_provenance)
    ?? objectOrNull(input.runtimeBoundaryTargetProcessProvenance)
    ?? objectOrNull(input.runtime_boundary_target_process_provenance)
    ?? objectOrNull(validationContext?.realRocmRuntimeBoundaryTargetProcessProvenance)
    ?? objectOrNull(validationContext?.real_rocm_runtime_boundary_target_process_provenance)
    ?? objectOrNull(validationContext?.runtimeBoundaryTargetProcessProvenance)
    ?? objectOrNull(validationContext?.runtime_boundary_target_process_provenance)
    ?? null;
}

function realRocmSameProcessRuntimeOracleSnapshot(input = {}, validationContext = null) {
  return objectOrNull(input.realRocmSameProcessRuntimeOracle)
    ?? objectOrNull(input.real_rocm_same_process_runtime_oracle)
    ?? objectOrNull(input.sameProcessRuntimeOracle)
    ?? objectOrNull(input.same_process_runtime_oracle)
    ?? objectOrNull(validationContext?.realRocmSameProcessRuntimeOracle)
    ?? objectOrNull(validationContext?.real_rocm_same_process_runtime_oracle)
    ?? objectOrNull(validationContext?.sameProcessRuntimeOracle)
    ?? objectOrNull(validationContext?.same_process_runtime_oracle)
    ?? null;
}

function realRocmMissingDependencyProbeSnapshot(input = {}, validationContext = null) {
  return objectOrNull(input.realRocmMissingDependencyProbe)
    ?? objectOrNull(input.real_rocm_missing_dependency_probe)
    ?? objectOrNull(input.missingDependencyProbe)
    ?? objectOrNull(input.missing_dependency_probe)
    ?? objectOrNull(validationContext?.realRocmMissingDependencyProbe)
    ?? objectOrNull(validationContext?.real_rocm_missing_dependency_probe)
    ?? objectOrNull(validationContext?.missingDependencyProbe)
    ?? objectOrNull(validationContext?.missing_dependency_probe)
    ?? null;
}

function realRocmRuntimeProfileAdapterResultLimitations(result) {
  if (!objectOrNull(result)) return [];
  if (result.declared !== true) return [];
  const strictAccepted =
    result.strictRuntimeProofAccepted === true
    || result.strict_runtime_proof_accepted === true;
  const blockingGaps = compactStringList([
    ...(Array.isArray(result.blockingGaps) ? result.blockingGaps : []),
    ...(Array.isArray(result.blocking_gaps) ? result.blocking_gaps : []),
  ]);
  const claimedRuntimeAuthority =
    result.acceptedForGpuHmr === true
    || result.accepted_for_gpu_hmr === true
    || result.gpuHmrSuccess === true
    || result.gpu_hmr_success === true
    || result.canSatisfyRuntimeProof === true
    || result.can_satisfy_runtime_proof === true
    || result.canSatisfyDispatchProof === true
    || result.can_satisfy_dispatch_proof === true;
  const status = firstString(
    result.status,
    result.reason,
    'real_rocm_runtime_profile_adapter_result_unproven',
  );
  if (
    strictAccepted
    && status === 'runtime_profile_adapter_result_imported'
    && blockingGaps.length === 0
    && !claimedRuntimeAuthority
  ) {
    return [];
  }
  const evidenceRefs = compactStringList([
    ...(Array.isArray(result.evidenceRefs) ? result.evidenceRefs : []),
    ...(Array.isArray(result.evidence_refs) ? result.evidence_refs : []),
  ]);
  const observedState = status;
  const normalizedBlockingGaps = compactStringList([
    ...blockingGaps,
    strictAccepted ? null : 'runtime_profile_adapter_strict_runtime_proof_not_accepted',
    claimedRuntimeAuthority ? 'runtime_profile_adapter_result_claimed_runtime_authority' : null,
    status === 'runtime_profile_adapter_result_imported'
      ? null
      : 'runtime_profile_adapter_result_not_imported',
  ]);
  return [{
    stageId: 'real-rocm-runtime-profile-adapter-result',
    stage_id: 'real-rocm-runtime-profile-adapter-result',
    status: 'blocked',
    requiredState: 'gpu-hmr-runtime-profile-adapter-result-proven',
    required_state: 'gpu-hmr-runtime-profile-adapter-result-proven',
    observedState,
    observed_state: observedState,
    degradedState: 'gpu-hmr-runtime-profile-adapter-result-unproven',
    degraded_state: 'gpu-hmr-runtime-profile-adapter-result-unproven',
    degradedReason: observedState,
    degraded_reason: observedState,
    blockingGaps: normalizedBlockingGaps,
    blocking_gaps: normalizedBlockingGaps,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function realRocmRuntimeBoundaryTargetEnvironmentLimitations(facet) {
  if (!objectOrNull(facet)) return [];
  const schemaVersion = firstString(facet.schemaVersion, facet.schema_version, facet.schema);
  const proofAuthority = firstString(facet.proofAuthority, facet.proof_authority);
  const acceptedForGpuHmr =
    facet.acceptedForGpuHmr === true || facet.accepted_for_gpu_hmr === true;
  const gpuHmrSuccess =
    facet.gpuHmrSuccess === true || facet.gpu_hmr_success === true;
  const canSatisfyRuntimeProof =
    facet.canSatisfyRuntimeProof === true || facet.can_satisfy_runtime_proof === true;
  const canSatisfyDispatchProof =
    facet.canSatisfyDispatchProof === true || facet.can_satisfy_dispatch_proof === true;
  const serializedFailedGates = compactStringList([
    ...(Array.isArray(facet.failedGates) ? facet.failedGates : []),
    ...(Array.isArray(facet.failed_gates) ? facet.failed_gates : []),
  ]);
  const serializedBlockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
  ]);
  const blockingGaps = compactStringList([
    schemaVersion === REAL_ROCM_RUNTIME_BOUNDARY_TARGET_ENVIRONMENT_SCHEMA_VERSION
      ? null
      : 'real_rocm_runtime_boundary_target_environment_schema_unknown',
    proofAuthority === REAL_ROCM_RUNTIME_BOUNDARY_TARGET_ENVIRONMENT_AUTHORITY
      ? null
      : 'real_rocm_runtime_boundary_target_environment_authority_unknown',
    acceptedForGpuHmr
      ? 'real_rocm_runtime_boundary_target_environment_claimed_gpu_hmr_acceptance'
      : null,
    gpuHmrSuccess
      ? 'real_rocm_runtime_boundary_target_environment_claimed_gpu_hmr_success'
      : null,
    canSatisfyRuntimeProof
      ? 'real_rocm_runtime_boundary_target_environment_claimed_runtime_authority'
      : null,
    canSatisfyDispatchProof
      ? 'real_rocm_runtime_boundary_target_environment_claimed_dispatch_authority'
      : null,
    ...serializedFailedGates,
    ...serializedBlockingGaps,
  ]);
  if (blockingGaps.length === 0) return [];
  const evidenceRefs = compactStringList([
    ...(Array.isArray(facet.evidenceRefs) ? facet.evidenceRefs : []),
    ...(Array.isArray(facet.evidence_refs) ? facet.evidence_refs : []),
    facet.environmentHash,
    facet.environment_hash,
  ]);
  const observedState = firstString(
    facet.status,
    facet.reason,
    blockingGaps[0],
    'real_rocm_runtime_boundary_target_environment_unproven',
  );
  return [{
    stageId: 'real-rocm-runtime-boundary-target-environment',
    stage_id: 'real-rocm-runtime-boundary-target-environment',
    status: 'blocked',
    requiredState: 'gpu-hmr-runtime-boundary-target-environment-support-only',
    required_state: 'gpu-hmr-runtime-boundary-target-environment-support-only',
    observedState,
    observed_state: observedState,
    degradedState: 'gpu-hmr-runtime-boundary-target-environment-rejected',
    degraded_state: 'gpu-hmr-runtime-boundary-target-environment-rejected',
    degradedReason: observedState,
    degraded_reason: observedState,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function realRocmRuntimeBoundaryTargetProcessProvenanceLimitations(facet) {
  if (!objectOrNull(facet)) return [];
  const present = facet.present === true;
  const schemaVersion = firstString(facet.schemaVersion, facet.schema_version, facet.schema);
  const proofAuthority = firstString(facet.proofAuthority, facet.proof_authority);
  const acceptedAsSupportEvidence =
    facet.acceptedAsSupportEvidence === true || facet.accepted_as_support_evidence === true;
  const acceptedForGpuHmr =
    facet.acceptedForGpuHmr === true || facet.accepted_for_gpu_hmr === true;
  const gpuHmrSuccess =
    facet.gpuHmrSuccess === true || facet.gpu_hmr_success === true;
  const canSatisfyRuntimeProof =
    facet.canSatisfyRuntimeProof === true || facet.can_satisfy_runtime_proof === true;
  const canSatisfyDispatchProof =
    facet.canSatisfyDispatchProof === true || facet.can_satisfy_dispatch_proof === true;
  const boundaryLineCount = Number.isFinite(facet.boundaryLineCount)
    ? Number(facet.boundaryLineCount)
    : (Number.isFinite(facet.boundary_line_count) ? Number(facet.boundary_line_count) : 0);
  const boundaryLineHashes = compactStringList([
    ...(Array.isArray(facet.boundaryLineHashes) ? facet.boundaryLineHashes : []),
    ...(Array.isArray(facet.boundary_line_hashes) ? facet.boundary_line_hashes : []),
  ]);
  const sourceBoundaryLinesProven =
    facet.sourceBoundaryLinesProven === true
    || facet.source_boundary_lines_proven === true;
  const runtimeSessions = compactStringList([
    ...(Array.isArray(facet.runtimeSessions) ? facet.runtimeSessions : []),
    ...(Array.isArray(facet.runtime_sessions) ? facet.runtime_sessions : []),
  ]);
  const processIds = compactStringList([
    ...(Array.isArray(facet.processIds) ? facet.processIds : []),
    ...(Array.isArray(facet.process_ids) ? facet.process_ids : []),
  ]);
  const missingProcessLineHashes = compactStringList([
    ...(Array.isArray(facet.missingProcessLineHashes) ? facet.missingProcessLineHashes : []),
    ...(Array.isArray(facet.missing_process_line_hashes) ? facet.missing_process_line_hashes : []),
  ]);
  const processSessionMismatchHashes = compactStringList([
    ...(Array.isArray(facet.processSessionMismatchHashes)
      ? facet.processSessionMismatchHashes
      : []),
    ...(Array.isArray(facet.process_session_mismatch_hashes)
      ? facet.process_session_mismatch_hashes
      : []),
  ]);
  const coverage = objectOrNull(facet.coverage);
  const coverageMissingEventKinds = compactStringList([
    ...(Array.isArray(coverage?.missingEventKinds) ? coverage.missingEventKinds : []),
    ...(Array.isArray(coverage?.missing_event_kinds) ? coverage.missing_event_kinds : []),
  ]);
  const targetEnvironmentAccepted =
    facet.targetEnvironmentAccepted === true || facet.target_environment_accepted === true;
  const targetEnvironmentSession = firstString(
    facet.targetEnvironmentSession,
    facet.target_environment_session,
  );
  const targetEnvironmentSessionMatched =
    facet.targetEnvironmentSessionMatched === true
    || facet.target_environment_session_matched === true;
  const resultTransportCopied =
    facet.resultTransportCopied !== false && facet.result_transport_copied !== false;
  const serializedFailedGates = compactStringList([
    ...(Array.isArray(facet.failedGates) ? facet.failedGates : []),
    ...(Array.isArray(facet.failed_gates) ? facet.failed_gates : []),
  ]);
  const serializedBlockingGaps = compactStringList([
    ...(Array.isArray(facet.blockingGaps) ? facet.blockingGaps : []),
    ...(Array.isArray(facet.blocking_gaps) ? facet.blocking_gaps : []),
  ]);
  const claimedAuthority =
    acceptedForGpuHmr || gpuHmrSuccess || canSatisfyRuntimeProof || canSatisfyDispatchProof;
  const active =
    present || acceptedAsSupportEvidence || boundaryLineCount > 0 || boundaryLineHashes.length > 0
    || claimedAuthority;
  if (!active) return [];
  const blockingGaps = compactStringList([
    schemaVersion === REAL_ROCM_RUNTIME_BOUNDARY_TARGET_PROCESS_PROVENANCE_SCHEMA_VERSION
      ? null
      : 'real_rocm_runtime_boundary_target_process_provenance_schema_unknown',
    proofAuthority === REAL_ROCM_RUNTIME_BOUNDARY_TARGET_PROCESS_PROVENANCE_AUTHORITY
      ? null
      : 'real_rocm_runtime_boundary_target_process_provenance_authority_unknown',
    acceptedForGpuHmr
      ? 'real_rocm_runtime_boundary_target_process_provenance_claimed_gpu_hmr_acceptance'
      : null,
    gpuHmrSuccess
      ? 'real_rocm_runtime_boundary_target_process_provenance_claimed_gpu_hmr_success'
      : null,
    canSatisfyRuntimeProof
      ? 'real_rocm_runtime_boundary_target_process_provenance_claimed_runtime_authority'
      : null,
    canSatisfyDispatchProof
      ? 'real_rocm_runtime_boundary_target_process_provenance_claimed_dispatch_authority'
      : null,
    present ? null : 'real_rocm_runtime_boundary_target_process_provenance_absent',
    acceptedAsSupportEvidence
      ? null
      : 'real_rocm_runtime_boundary_target_process_provenance_unaccepted',
    boundaryLineHashes.length > 0
      ? null
      : 'real_rocm_runtime_boundary_target_process_boundary_hashes_missing',
    sourceBoundaryLinesProven
      ? null
      : 'real_rocm_runtime_boundary_target_process_source_lines_missing',
    runtimeSessions.length === 1
      ? null
      : 'real_rocm_runtime_boundary_target_process_session_not_unique',
    processIds.length === 1
      ? null
      : 'real_rocm_runtime_boundary_target_process_id_not_unique',
    missingProcessLineHashes.length === 0
      ? null
      : 'real_rocm_runtime_boundary_target_process_identity_fields_missing',
    processSessionMismatchHashes.length === 0
      ? null
      : 'real_rocm_runtime_boundary_target_process_session_process_mismatch',
    coverageMissingEventKinds.length === 0
      ? null
      : 'real_rocm_runtime_boundary_target_process_required_events_incomplete',
    targetEnvironmentAccepted
      ? null
      : 'real_rocm_runtime_boundary_target_process_target_environment_not_accepted',
    targetEnvironmentSession
      ? null
      : 'real_rocm_runtime_boundary_target_process_target_environment_session_missing',
    targetEnvironmentSessionMatched
      ? null
      : 'real_rocm_runtime_boundary_target_process_target_environment_session_mismatch',
    resultTransportCopied
      ? null
      : 'real_rocm_runtime_boundary_target_process_result_transport_not_copied',
    ...serializedFailedGates,
    ...serializedBlockingGaps,
  ]);
  if (blockingGaps.length === 0) return [];
  const evidenceRefs = compactStringList([
    ...(Array.isArray(facet.evidenceRefs) ? facet.evidenceRefs : []),
    ...(Array.isArray(facet.evidence_refs) ? facet.evidence_refs : []),
    facet.facetHash,
    facet.facet_hash,
    ...boundaryLineHashes,
  ]);
  const observedState = firstString(
    facet.status,
    facet.reason,
    blockingGaps[0],
    'real_rocm_runtime_boundary_target_process_provenance_unproven',
  );
  return [{
    stageId: 'real-rocm-runtime-boundary-target-process-provenance',
    stage_id: 'real-rocm-runtime-boundary-target-process-provenance',
    status: 'blocked',
    requiredState: 'gpu-hmr-runtime-boundary-target-process-provenance-support-only',
    required_state: 'gpu-hmr-runtime-boundary-target-process-provenance-support-only',
    observedState,
    observed_state: observedState,
    degradedState: 'gpu-hmr-runtime-boundary-target-process-provenance-rejected',
    degraded_state: 'gpu-hmr-runtime-boundary-target-process-provenance-rejected',
    degradedReason: observedState,
    degraded_reason: observedState,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function realRocmAppHookContractLimitations(contract) {
  if (!objectOrNull(contract)) return [];
  const required = contract.required === true
    || contract.appHookRequired === true
    || contract.app_hook_required === true;
  const proven = contract.canSatisfyRuntimeProof === true
    || contract.can_satisfy_runtime_proof === true;
  if (!required || proven) return [];
  const blockingGaps = compactStringList([
    ...(Array.isArray(contract.blockingGaps) ? contract.blockingGaps : []),
    ...(Array.isArray(contract.blocking_gaps) ? contract.blocking_gaps : []),
  ]);
  const evidenceRefs = compactStringList([
    ...(Array.isArray(contract.evidenceRefs) ? contract.evidenceRefs : []),
    ...(Array.isArray(contract.evidence_refs) ? contract.evidence_refs : []),
  ]);
  const observedState = firstString(
    contract.status,
    contract.reason,
    'real_rocm_app_hook_contract_unproven',
  );
  return [{
    stageId: 'real-rocm-app-hook-contract',
    stage_id: 'real-rocm-app-hook-contract',
    status: 'blocked',
    requiredState: 'gpu-hmr-real-rocm-app-hook-contract-proven',
    required_state: 'gpu-hmr-real-rocm-app-hook-contract-proven',
    observedState,
    observed_state: observedState,
    degradedState: 'gpu-hmr-real-rocm-app-hook-contract-unproven',
    degraded_state: 'gpu-hmr-real-rocm-app-hook-contract-unproven',
    degradedReason: observedState,
    degraded_reason: observedState,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function realRocmAppHookMaterializationLimitations(materialization) {
  if (!objectOrNull(materialization)) return [];
  const required = materialization.required === true;
  const complete = materialization.materializationComplete === true
    || materialization.materialization_complete === true;
  const blockingGaps = compactStringList([
    ...(Array.isArray(materialization.blockingGaps) ? materialization.blockingGaps : []),
    ...(Array.isArray(materialization.blocking_gaps) ? materialization.blocking_gaps : []),
  ]);
  if (!required || complete) return [];
  const evidenceRefs = compactStringList([
    ...(Array.isArray(materialization.evidenceRefs) ? materialization.evidenceRefs : []),
    ...(Array.isArray(materialization.evidence_refs) ? materialization.evidence_refs : []),
  ]);
  const observedState = firstString(
    materialization.status,
    materialization.reason,
    'real_rocm_app_hook_materialization_incomplete',
  );
  return [{
    stageId: 'real-rocm-app-hook-materialization',
    stage_id: 'real-rocm-app-hook-materialization',
    status: 'blocked',
    requiredState: 'gpu-hmr-real-rocm-app-hook-materialized',
    required_state: 'gpu-hmr-real-rocm-app-hook-materialized',
    observedState,
    observed_state: observedState,
    degradedState: 'gpu-hmr-real-rocm-app-hook-materialization-incomplete',
    degraded_state: 'gpu-hmr-real-rocm-app-hook-materialization-incomplete',
    degradedReason: observedState,
    degraded_reason: observedState,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function realRocmSameProcessRuntimeOracleLimitations(contract) {
  if (!objectOrNull(contract)) return [];
  const required = contract.required === true
    || contract.declared === true
    || contract.appHookRequired === true
    || contract.app_hook_required === true;
  const proven = contract.accepted === true
    || contract.canSatisfyRuntimeProof === true
    || contract.can_satisfy_runtime_proof === true;
  if (!required || proven) return [];
  const blockingGaps = compactStringList([
    ...(Array.isArray(contract.blockingGaps) ? contract.blockingGaps : []),
    ...(Array.isArray(contract.blocking_gaps) ? contract.blocking_gaps : []),
  ]);
  const evidenceRefs = compactStringList([
    ...(Array.isArray(contract.evidenceRefs) ? contract.evidenceRefs : []),
    ...(Array.isArray(contract.evidence_refs) ? contract.evidence_refs : []),
  ]);
  const observedState = firstString(
    contract.status,
    contract.reason,
    'same_process_runtime_oracle_contract_unproven',
  );
  return [{
    stageId: 'real-rocm-same-process-runtime-oracle',
    stage_id: 'real-rocm-same-process-runtime-oracle',
    status: 'blocked',
    requiredState: 'gpu-hmr-same-process-runtime-oracle-proven',
    required_state: 'gpu-hmr-same-process-runtime-oracle-proven',
    observedState,
    observed_state: observedState,
    degradedState: 'gpu-hmr-same-process-runtime-oracle-unproven',
    degraded_state: 'gpu-hmr-same-process-runtime-oracle-unproven',
    degradedReason: observedState,
    degraded_reason: observedState,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
}

function realRocmMissingDependencyProbeLimitations(probe) {
  if (!objectOrNull(probe)) return [];
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
  const evidenceRefs = compactStringList([
    ...(Array.isArray(probe.evidenceRefs) ? probe.evidenceRefs : []),
    ...(Array.isArray(probe.evidence_refs) ? probe.evidence_refs : []),
  ]);
  const observedState = firstString(
    probe.status,
    probe.reason,
    failedGates[0],
    'real_rocm_missing_dependency_probe_present',
  );
  return [{
    stageId: 'real-rocm-missing-dependency-probe',
    stage_id: 'real-rocm-missing-dependency-probe',
    status: 'blocked',
    requiredState: 'gpu-hmr-real-rocm-dependencies-satisfied',
    required_state: 'gpu-hmr-real-rocm-dependencies-satisfied',
    observedState,
    observed_state: observedState,
    degradedState: 'gpu-hmr-real-rocm-build-prerequisite-missing',
    degraded_state: 'gpu-hmr-real-rocm-build-prerequisite-missing',
    degradedReason: observedState,
    degraded_reason: observedState,
    blockingGaps,
    blocking_gaps: blockingGaps,
    evidenceRefs,
    evidence_refs: evidenceRefs,
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
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

function deterministicVisualModeLimitations(evaluation, { required = false } = {}) {
  if (!objectOrNull(evaluation)) {
    if (!required) return [];
    return [{
      stageId: 'deterministic-visual-mode',
      stage_id: 'deterministic-visual-mode',
      status: 'blocked',
      requiredState: 'gpu-hmr-deterministic-visual-mode-proven',
      required_state: 'gpu-hmr-deterministic-visual-mode-proven',
      observedState: 'missing',
      observed_state: 'missing',
      degradedState: 'gpu-hmr-deterministic-visual-mode-missing',
      degraded_state: 'gpu-hmr-deterministic-visual-mode-missing',
      degradedReason: 'deterministic_visual_mode_missing',
      degraded_reason: 'deterministic_visual_mode_missing',
      proofArtifactPath: null,
      proof_artifact_path: null,
      phase: null,
      name: null,
    }];
  }
  if (evaluation.accepted === true) return [];
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
  'pixel_metrics_verified',
  'pixelMetricsVerified',
  'visual_pixel_verification',
  'visualPixelVerification',
  'before_image_hash',
  'beforeImageHash',
  'after_image_hash',
  'afterImageHash',
  'diff_image_hash',
  'diffImageHash',
];

const COMPUTE_ORACLE_ARTIFACT_HINT_FIELDS = [
  'raw_readback_bin',
  'rawReadbackBin',
  'raw_readback_cas_manifest',
  'rawReadbackCasManifest',
  'raw_readback_locator',
  'rawReadbackLocator',
  'readback_schema_json',
  'readbackSchemaJson',
  'readback_schema_cas_manifest',
  'readbackSchemaCasManifest',
  'readback_schema_locator',
  'readbackSchemaLocator',
  'schema_cas_manifest',
  'schemaCasManifest',
  'rendered_card_png',
  'renderedCardPng',
  'rendered_card_cas_manifest',
  'renderedCardCasManifest',
  'rendered_card_locator',
  'renderedCardLocator',
  'proof_card_png',
  'proofCardPng',
  'proof_card_cas_manifest',
  'proofCardCasManifest',
  'artifact_cas_locators',
  'artifactCasLocators',
  'artifact_cas_locator',
  'artifactCasLocator',
  'checksum_before',
  'checksumBefore',
  'checksum_after',
  'checksumAfter',
  'deterministic_slice',
  'deterministicSlice',
  'raw_readback_hash',
  'rawReadbackHash',
  'raw_readback_verification',
  'rawReadbackVerification',
  'raw_readback_byte_length',
  'rawReadbackByteLength',
  'deterministic_slice_hash',
  'deterministicSliceHash',
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

function oracleArtifactsFromSources(input, outputProof) {
  const inputArtifacts = objectOrNull(input.oracleArtifacts) ?? objectOrNull(input.oracle_artifacts) ?? {};
  const artifacts = {
    ...oracleArtifactsFromOutputProof(outputProof),
    ...inputArtifacts,
  };
  const inputVisual = firstOracleArtifactObject([
    input.visualOracleArtifacts,
    input.visual_oracle_artifacts,
    inputArtifacts.visualOracleArtifacts,
    inputArtifacts.visual_oracle_artifacts,
  ], VISUAL_ORACLE_ARTIFACT_HINT_FIELDS);
  const inputCompute = firstOracleArtifactObject([
    input.computeOracleArtifacts,
    input.compute_oracle_artifacts,
    inputArtifacts.computeOracleArtifacts,
    inputArtifacts.compute_oracle_artifacts,
  ], COMPUTE_ORACLE_ARTIFACT_HINT_FIELDS);
  if (inputVisual) artifacts.visual_oracle_artifacts = inputVisual;
  if (inputCompute) artifacts.compute_oracle_artifacts = inputCompute;
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
  const artifacts = compactObjects(visualEvidenceArtifacts);
  const supplementalVisualArtifactKeys = new Set(compactStringList(artifacts
    .filter((artifact) =>
      artifact.visualEvidenceSupplementalOnly === true
      || artifact.visual_evidence_supplemental_only === true)
    .flatMap((artifact) => [
      artifact.path,
      artifact.filePath,
      artifact.file_path,
      artifact.evidenceId,
      artifact.evidence_id,
      artifact.contentHash,
      artifact.content_hash,
    ])));
  const primaryVisualRefs = compactStringList(visualEvidenceRefs)
    .filter((ref) => !supplementalVisualArtifactKeys.has(ref));
  const primaryVisualArtifacts = artifacts.filter(
    (artifact) =>
      artifact.visualEvidenceSupplementalOnly !== true
      && artifact.visual_evidence_supplemental_only !== true,
  );
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
    || primaryVisualRefs.length > 0
    || primaryVisualArtifacts.length > 0;
}

function outputOracleTargetFromSources(...sources) {
  for (const source of sources) {
    const object = objectOrNull(source);
    if (!object) continue;
    const outputOracle = objectOrNull(object.outputOracle)
      ?? objectOrNull(object.output_oracle)
      ?? {};
    const target = objectOrNull(object.outputOracleTarget)
      ?? objectOrNull(object.output_oracle_target)
      ?? objectOrNull(outputOracle.outputOracleTarget)
      ?? objectOrNull(outputOracle.output_oracle_target);
    if (target) return target;
  }
  return null;
}

function outputOracleTargetKind(target) {
  const object = objectOrNull(target) ?? {};
  return firstString(object.kind?.value, object.kind, object.target_kind, object.targetKind);
}

function computeOnlyOutputTargetVerified(target) {
  const object = objectOrNull(target) ?? {};
  return outputOracleTargetKind(object) === 'compute'
    && (object.compute_only_target_verified === true || object.computeOnlyTargetVerified === true)
    && compactStringList(object.evidence_refs ?? object.evidenceRefs).length > 0;
}

function visualBackendRequiresVisualEvidence({
  input,
  validationContext,
  acceptanceContract,
  outputProof,
}) {
  const backend = firstString(
    input?.backend,
    input?.gpuBackend,
    input?.gpu_backend,
    validationContext?.backend,
    validationContext?.gpuBackend,
    validationContext?.gpu_backend,
    acceptanceContract?.backend?.value,
    acceptanceContract?.backend,
  );
  if (!VISUAL_OR_ENGINE_BACKENDS.has(backend)) return false;
  const target = outputOracleTargetFromSources(
    input,
    validationContext,
    acceptanceContract,
    outputProof,
    outputProof?.outputOracle,
    outputProof?.output_oracle,
  );
  return !computeOnlyOutputTargetVerified(target);
}

function visualArtifactPath(artifact) {
  return firstString(artifact.path, artifact.filePath, artifact.file_path);
}

function visualArtifactHash(artifact) {
  return firstString(artifact.contentHash, artifact.content_hash);
}

function visualArtifactAccepted(artifact) {
  return visualEvidenceAcceptedAsRuntimeProof(artifact);
}

function visualArtifactQuality(artifact) {
  return firstString(artifact.visualQuality, artifact.visual_quality);
}

function visualProofArtifactLimitations({
  outputProof,
  visualEvidenceRefs,
  visualEvidenceArtifacts,
  visualEvidenceRequired,
}) {
  const artifacts = compactObjects(visualEvidenceArtifacts);
  const refs = compactStringList(visualEvidenceRefs);
  if (visualEvidenceRequired !== true && !outputProofRequiresVisualEvidence(outputProof, refs, artifacts)) {
    return [];
  }

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
        degradedReason: visualEvidenceIsSupplementalOnly(artifact)
          ? 'visual_artifact_supplemental_only'
          : 'visual_artifact_not_accepted',
        observedState: visualEvidenceIsSupplementalOnly(artifact)
          ? 'diagnostic_visual_not_runtime_proof'
          : visualArtifactQuality(artifact) ?? 'gpu-hmr-visual-unaccepted',
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

function visualOracleArtifactsFromLedgerRecord(record) {
  const ledgerRecord = objectOrNull(record) ?? {};
  const recordArtifacts = objectOrNull(ledgerRecord.oracle_artifacts)
    ?? objectOrNull(ledgerRecord.oracleArtifacts)
    ?? {};
  const outputEvent = objectOrNull(ledgerRecord.output_event)
    ?? objectOrNull(ledgerRecord.outputEvent)
    ?? {};
  const outputArtifacts = objectOrNull(outputEvent.oracle_artifacts)
    ?? objectOrNull(outputEvent.oracleArtifacts)
    ?? {};
  const outputOracle = objectOrNull(outputEvent.output_oracle)
    ?? objectOrNull(outputEvent.outputOracle)
    ?? {};
  const outputOracleArtifacts = objectOrNull(outputOracle.oracle_artifacts)
    ?? objectOrNull(outputOracle.oracleArtifacts)
    ?? {};
  return firstOracleArtifactObject([
    recordArtifacts.visual_oracle_artifacts,
    recordArtifacts.visualOracleArtifacts,
    outputArtifacts.visual_oracle_artifacts,
    outputArtifacts.visualOracleArtifacts,
    outputEvent.visual_oracle_artifacts,
    outputEvent.visualOracleArtifacts,
    outputOracle.visual_oracle_artifacts,
    outputOracle.visualOracleArtifacts,
    outputOracleArtifacts.visual_oracle_artifacts,
    outputOracleArtifacts.visualOracleArtifacts,
  ], VISUAL_ORACLE_ARTIFACT_HINT_FIELDS);
}

function visualLedgerOracleLimitations({
  visualEvidenceRequired,
  derivedProofLedgerRecord,
}) {
  if (visualEvidenceRequired !== true) return [];
  if (visualOracleArtifactsFromLedgerRecord(derivedProofLedgerRecord)) return [];
  return [{
    stageId: 'proof-ledger-visual-oracle',
    stage_id: 'proof-ledger-visual-oracle',
    status: 'blocked',
    requiredState: 'gpu-hmr-visual-oracle-backed-by-ledger-record',
    required_state: 'gpu-hmr-visual-oracle-backed-by-ledger-record',
    observedState: 'missing_visual_oracle_artifacts',
    observed_state: 'missing_visual_oracle_artifacts',
    degradedState: 'gpu-hmr-visual-oracle-ledger-missing',
    degraded_state: 'gpu-hmr-visual-oracle-ledger-missing',
    degradedReason: 'visual_oracle_ledger_record_missing',
    degraded_reason: 'visual_oracle_ledger_record_missing',
    proofArtifactPath: null,
    proof_artifact_path: null,
    phase: null,
    name: null,
  }];
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

function adversarialPreflightFromInput(input = {}, validationContext = null) {
  return objectOrNull(input.adversarialPreflight)
    ?? objectOrNull(input.adversarial_preflight)
    ?? objectOrNull(validationContext?.adversarialPreflight)
    ?? objectOrNull(validationContext?.adversarial_preflight)
    ?? null;
}

function adversarialPreflightLimitations(facet) {
  if (facet?.accepted === true) return [];
  const failures = compactStringList(
    facet?.strictGate?.failures
      ?? facet?.strict_gate?.failures
      ?? ['adversarial_preflight_missing'],
  );
  return (failures.length ? failures : ['adversarial_preflight_missing']).map((failure) => ({
    stageId: 'adversarial-refusal-preflight',
    stage_id: 'adversarial-refusal-preflight',
    status: 'blocked',
    requiredState: 'gpu-hmr-false-positive-refusal-preflight-passed',
    required_state: 'gpu-hmr-false-positive-refusal-preflight-passed',
    observedState: facet?.strictGate?.status ?? facet?.strict_gate?.status ?? null,
    observed_state: facet?.strictGate?.status ?? facet?.strict_gate?.status ?? null,
    degradedState: 'gpu-hmr-adversarial-preflight-rejected',
    degraded_state: 'gpu-hmr-adversarial-preflight-rejected',
    degradedReason: failure,
    degraded_reason: failure,
    proofArtifactPath: facet?.scriptPath ?? null,
    proof_artifact_path: facet?.scriptPath ?? null,
    phase: null,
    name: null,
  }));
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

function proofArtifactIds(proof, extraFields = []) {
  const p = objectOrNull(proof) ?? {};
  const oracle = objectOrNull(p.outputOracle) ?? objectOrNull(p.output_oracle) ?? {};
  const flattened = [
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
  ];
  const visit = (value, out) => {
    if (Array.isArray(value)) {
      value.forEach((item) => visit(item, out));
      return;
    }
    if (typeof value === 'string') out.push(value);
  };
  const strings = [];
  flattened.forEach((value) => visit(value, strings));
  return compactStringList([
    ...contentAddressedArtifactIds(strings),
    ...artifactIdsFromSha256Hashes(strings),
  ]);
}

function proofArtifactId(proof, extraFields = []) {
  return proofArtifactIds(proof, extraFields)[0] ?? null;
}

function proofArtifactIdMatching(proof, preferredArtifactId, extraFields = []) {
  const ids = proofArtifactIds(proof, extraFields);
  if (preferredArtifactId && ids.includes(preferredArtifactId)) return preferredArtifactId;
  return ids[0] ?? null;
}

function proofEvidenceObjects(input = {}, validationContext = null) {
  const sources = [
    input.proofArtifacts,
    input.proof_artifacts,
    validationContext?.proofArtifacts,
    validationContext?.proof_artifacts,
    input.runtimeEvidence?.proofArtifacts,
    input.runtimeEvidence?.proof_artifacts,
    input.runtime_evidence?.proofArtifacts,
    input.runtime_evidence?.proof_artifacts,
  ];
  const objects = [];
  for (const source of sources) {
    for (const record of Array.isArray(source) ? source : []) {
      const artifact = objectOrNull(record?.artifact) ?? objectOrNull(record) ?? {};
      for (const evidence of Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : []) {
        if (objectOrNull(evidence)) objects.push(evidence);
      }
      for (const evidence of Array.isArray(artifact.evidence_refs) ? artifact.evidence_refs : []) {
        if (objectOrNull(evidence)) objects.push(evidence);
      }
    }
  }
  return objects;
}

function evidenceObjectByRef(evidenceObjects, refs, artifactId = null) {
  const wanted = new Set(compactStringList(refs));
  return evidenceObjects.find((evidence) => {
    const evidenceId = firstString(evidence.evidenceId, evidence.evidence_id);
    if (!evidenceId || !wanted.has(evidenceId)) return false;
    if (!artifactId) return true;
    const evidenceArtifactId = firstArtifactId(
      evidence.artifactUri,
      evidence.artifact_uri,
      evidence.metadata?.selectedArtifactId,
      evidence.metadata?.selected_artifact_id,
      evidence.metadata?.ramBlobId,
      evidence.metadata?.ram_blob_id,
      evidence.metadata?.artifactContentHash,
      evidence.metadata?.artifact_content_hash,
      evidence.metadata?.ramBytesHash,
      evidence.metadata?.ram_bytes_hash,
    );
    return !evidenceArtifactId || evidenceArtifactId === artifactId;
  }) ?? null;
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

function latestRetirementFromEpochProof(proof) {
  const graph = epochGraphFromProof(proof);
  if (!graph) return null;
  const retireEdges = firstArray(graph.edges)
    .filter((edge) => objectOrNull(edge) && String(edge.kind ?? '').toLowerCase() === 'retire');
  return retireEdges[retireEdges.length - 1] ?? null;
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
  if (typeof value === 'string' && value.trim()) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric >= 0) return numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
    return null;
  }
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
  if (label === 'evidence_refs') {
    const explicitRefs = compactStringList(explicitValue);
    const derivedRefs = new Set(compactStringList(derivedValue));
    const missingRefs = explicitRefs.filter((ref) => !derivedRefs.has(ref));
    if (missingRefs.length > 0) {
      failures.push({
        code: proofLedgerSourceConsistencyFailureCode(label, 'mismatch'),
        field: label,
        explicit: explicitRefs,
        derived: compactStringList(derivedValue),
        missingRefs,
      });
    }
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
    ['backend', [['backend']]],
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
    ['output_oracle_target', [['outputOracleTarget']]],
    ['process_identity_process_id', [['processIdentity', 'process_id'], ['processIdentity', 'processId']]],
    ['device_identity_device_uuid', [['deviceIdentity', 'device_uuid'], ['deviceIdentity', 'deviceUuid']]],
    ['cpu_hmr_used', [['cpuHmrUsed']]],
    ['full_rebuild_used', [['fullRebuildUsed']]],
    ['process_restarted', [['processRestarted']]],
    ['output_oracle_target', [['outputOracleTarget']]],
    ['compute_oracle_raw_readback_hash', [
      ['oracleArtifacts', 'compute_oracle_artifacts', 'raw_readback_hash'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackHash'],
      ['outputEvent', 'oracle_artifacts', 'compute_oracle_artifacts', 'raw_readback_hash'],
      ['outputEvent', 'oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackHash'],
    ]],
    ['compute_oracle_raw_readback_hash_verified', [
      ['oracleArtifacts', 'compute_oracle_artifacts', 'raw_readback_hash_verified'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackHashVerified'],
      ['oracleArtifacts', 'compute_oracle_artifacts', 'raw_readback_verification', 'hash_verified'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackVerification', 'hashVerified'],
    ]],
    ['compute_oracle_raw_readback_byte_length', [
      ['oracleArtifacts', 'compute_oracle_artifacts', 'raw_readback_byte_length'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackByteLength'],
      ['oracleArtifacts', 'compute_oracle_artifacts', 'raw_readback_verification', 'byte_length'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackVerification', 'byteLength'],
    ]],
    ['compute_oracle_raw_readback_source', [
      ['oracleArtifacts', 'compute_oracle_artifacts', 'raw_readback_source'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackSource'],
    ]],
    ['compute_oracle_deterministic_slice', [
      ['oracleArtifacts', 'compute_oracle_artifacts', 'deterministic_slice'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'deterministicSlice'],
    ]],
    ['compute_oracle_deterministic_slice_hash', [
      ['oracleArtifacts', 'compute_oracle_artifacts', 'deterministic_slice_hash'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'deterministicSliceHash'],
      ['oracleArtifacts', 'compute_oracle_artifacts', 'raw_readback_verification', 'deterministic_slice_hash'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'rawReadbackVerification', 'deterministicSliceHash'],
    ]],
    ['compute_oracle_checksum_before', [[
      'oracleArtifacts',
      'compute_oracle_artifacts',
      'checksum_before',
    ], [
      'oracleArtifacts',
      'computeOracleArtifacts',
      'checksumBefore',
    ]]],
    ['compute_oracle_checksum_after', [
      ['oracleArtifacts', 'compute_oracle_artifacts', 'checksum_after'],
      ['oracleArtifacts', 'computeOracleArtifacts', 'checksumAfter'],
    ]],
    ['visual_oracle_before_image_hash', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'before_image_hash'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'beforeImageHash'],
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visual_pixel_verification', 'before_image_hash'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visualPixelVerification', 'beforeImageHash'],
    ]],
    ['visual_oracle_after_image_hash', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'after_image_hash'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'afterImageHash'],
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visual_pixel_verification', 'after_image_hash'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visualPixelVerification', 'afterImageHash'],
    ]],
    ['visual_oracle_diff_image_hash', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'diff_image_hash'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'diffImageHash'],
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visual_pixel_verification', 'diff_image_hash'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visualPixelVerification', 'diffImageHash'],
    ]],
    ['visual_oracle_pixel_metrics_verified', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'pixel_metrics_verified'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'pixelMetricsVerified'],
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visual_pixel_verification', 'metrics_verified'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visualPixelVerification', 'metricsVerified'],
    ]],
    ['visual_oracle_changed_pixel_ratio', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'changed_pixel_ratio'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'changedPixelRatio'],
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visual_pixel_verification', 'changed_pixel_ratio'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visualPixelVerification', 'changedPixelRatio'],
    ]],
    ['visual_oracle_perceptual_diff', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'perceptual_diff'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'perceptualDiff'],
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visual_pixel_verification', 'perceptual_diff'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visualPixelVerification', 'perceptualDiff'],
    ]],
    ['visual_oracle_visible_pixel_count', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visible_pixel_count'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visiblePixelCount'],
      ['oracleArtifacts', 'visual_oracle_artifacts', 'visual_pixel_verification', 'visible_pixel_count'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'visualPixelVerification', 'visiblePixelCount'],
    ]],
    ['visual_oracle_blank_frame_rejection', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'blank_frame_rejection'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'blankFrameRejection'],
    ]],
    ['visual_oracle_same_frame_rejection', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'same_frame_rejection'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'sameFrameRejection'],
    ]],
    ['visual_oracle_epoch_trace', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'new_epoch_watermark_or_trace'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'newEpochWatermarkOrTrace'],
    ]],
    ['visual_oracle_camera_state_hash', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'camera_state_hash'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'cameraStateHash'],
    ]],
    ['visual_oracle_swapchain_size', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'swapchain_size'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'swapchainSize'],
    ]],
    ['visual_oracle_frame_number', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'frame_number'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'frameNumber'],
    ]],
    ['visual_oracle_timestamp_after_dispatch', [
      ['oracleArtifacts', 'visual_oracle_artifacts', 'timestamp_after_dispatch'],
      ['oracleArtifacts', 'visualOracleArtifacts', 'timestampAfterDispatch'],
    ]],
    ['deterministic_visual_mode', [['deterministicVisualMode']]],
    ['metric_clock', [['metricClock']]],
    ['metric_scope', [['metricScope']]],
    ['cache_state', [['cacheState']]],
    ['timings', [['timings']]],
    ['model_provenance', [['modelProvenance']]],
    ['evidence_refs', [['evidenceRefs']]],
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
  const evidenceObjects = proofEvidenceObjects(input, validationContext);
  const outputOracleTarget = outputOracleTargetFromSources(
    input,
    validationContext,
    acceptanceContract,
    outputProof,
    outputOracle,
  );
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
  const retirement = latestRetirementFromEpochProof(epochProof) ?? {};
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
  const dispatchEpoch = firstStringOrFiniteNumber(
    dispatchProof?.epoch,
    dispatchProof?.epoch_id,
    dispatchProof?.dispatchEpoch,
    dispatchProof?.dispatch_epoch,
    dispatchProof?.dispatchGeneration,
    dispatchProof?.dispatch_generation,
    dispatchProof?.generation,
    dispatchProof?.activeEpoch,
    dispatchProof?.active_epoch,
    dispatchProof?.activeGeneration,
    dispatchProof?.active_generation,
  );
  const outputTimestamp = latestTimestamp(
    outputOracle.readbackTimestamp,
    outputOracle.readback_timestamp,
    outputOracle.timestampMonotonicNs,
    outputOracle.timestamp_monotonic_ns,
    outputProof?.outputTimestamp,
    outputProof?.output_timestamp,
  );
  const outputEpoch = firstStringOrFiniteNumber(
    outputProof?.epoch,
    outputProof?.epoch_id,
    outputProof?.outputEpoch,
    outputProof?.output_epoch,
    outputProof?.outputGeneration,
    outputProof?.output_generation,
    outputProof?.generation,
    outputProof?.activeEpoch,
    outputProof?.active_epoch,
    outputProof?.activeGeneration,
    outputProof?.active_generation,
    outputOracle.epoch,
    outputOracle.epoch_id,
    outputOracle.outputEpoch,
    outputOracle.output_epoch,
    outputOracle.outputGeneration,
    outputOracle.output_generation,
    outputOracle.generation,
  );
  const publishTimestamp = latestTimestamp(
    publication.timestampMonotonicNs,
    publication.timestamp_monotonic_ns,
    publication.publishTimestampMonotonicNs,
    publication.publish_timestamp_monotonic_ns,
    publication.publishTimestampMs,
    publication.publish_timestamp_ms,
    publication.publishTimestamp,
    publication.publish_timestamp,
    publication.timestamp,
    publication.timestamp_monotonic_ns,
  );
  const publishedArtifactHash = proofArtifactId(epochProof, [
    publication.newArtifactId,
    publication.new_artifact_id,
    publication.newArtifactHash,
    publication.new_artifact_hash,
  ]);
  const dispatchArtifactHash = proofArtifactId(dispatchProof);
  const outputArtifactHash = proofArtifactId(outputProof);
  const loadedArtifactHash = proofArtifactIdMatching(artifactTransportProof, outputArtifactHash ?? dispatchArtifactHash ?? publishedArtifactHash);
  const artifactTransportEvidence = evidenceObjectByRef(
    evidenceObjects,
    artifactTransportProof?.evidenceRefs ?? artifactTransportProof?.evidence_refs,
    loadedArtifactHash,
  );
  const loaderTimestamp = latestTimestamp(
    artifactTransportProof?.timestampMonotonicNs,
    artifactTransportProof?.timestamp_monotonic_ns,
    artifactTransportProof?.transportTimestamp,
    artifactTransportProof?.transport_timestamp,
    artifactTransportEvidence?.timestamp,
  );
  const outputArtifacts = oracleArtifactsFromSources(input, outputProof);
  const outputComputeArtifacts = objectOrNull(outputArtifacts.compute_oracle_artifacts)
    ?? objectOrNull(outputArtifacts.computeOracleArtifacts)
    ?? {};
  const timingMetrics = objectOrNull(input.timingMetrics)
    ?? objectOrNull(input.timing_metrics)
    ?? objectOrNull(input.timings?.timingMetrics)
    ?? objectOrNull(input.timings?.timing_metrics)
    ?? objectOrNull(validationContext?.timingMetrics)
    ?? objectOrNull(validationContext?.timing_metrics)
    ?? objectOrNull(validationContext?.timings?.timingMetrics)
    ?? objectOrNull(validationContext?.timings?.timing_metrics)
    ?? null;
  const ledgerTimings = objectOrNull(input.timings)
    ?? objectOrNull(validationContext?.timings)
    ?? timingMetrics
    ?? {};

  const record = {
    project_id: input.workspaceSlug
      ?? validationContext?.workspaceSlug
      ?? validationContext?.workspace_slug
      ?? acceptanceContract?.project_id
      ?? acceptanceContract?.projectId
      ?? null,
    edit_id: input.sourceEditId
      ?? input.source_edit_id
      ?? validationContext?.sourceEditId
      ?? validationContext?.source_edit_id
      ?? acceptanceContract?.edit_id
      ?? acceptanceContract?.editId
      ?? null,
    backend: firstString(
      input.backend,
      input.gpuBackend,
      input.gpu_backend,
      validationContext?.backend,
      validationContext?.gpuBackend,
      validationContext?.gpu_backend,
      acceptanceContract?.backend?.value,
      acceptanceContract?.backend,
    ),
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
      id: firstString(
        artifactTransportProof?.eventId,
        artifactTransportProof?.event_id,
        artifactTransportEvidence?.evidenceId,
        artifactTransportEvidence?.evidence_id,
      ),
      artifact_hash: loadedArtifactHash,
      process_id: firstString(artifactTransportProof?.processId, artifactTransportProof?.process_id),
      timestamp_monotonic_ns: loaderTimestamp,
    },
    epoch_publish_event: {
      id: firstString(
        epochProof?.eventId,
        epochProof?.event_id,
        publication.id,
        publication.eventId,
        publication.event_id,
        ...(Array.isArray(epochProof?.evidenceRefs) ? epochProof.evidenceRefs : []),
        ...(Array.isArray(epochProof?.evidence_refs) ? epochProof.evidence_refs : []),
      ),
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
      epoch: dispatchEpoch,
      process_id: firstString(dispatchProof?.processId, dispatchProof?.process_id),
      timestamp_monotonic_ns: dispatchTimestamp,
    },
    output_event: {
      id: firstString(outputProof?.eventId, outputProof?.event_id, outputOracle.id, outputOracle.oracleId),
      kind: firstString(outputOracle.kind, outputProof?.kind, outputProof?.oracleKind),
      artifact_hash: outputArtifactHash,
      epoch: firstStringOrFiniteNumber(outputEpoch, dispatchEpoch, outputComputeArtifacts.epoch),
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
      passed: outputProof?.resultState === 'gpu-hmr-output-oracle-proven' || outputOracle.passed === true,
    },
    retirement_event: {
      id: firstString(
        epochProof?.retirementEventId,
        epochProof?.retirement_event_id,
        ...(Array.isArray(epochProof?.retirementFenceIds) ? epochProof.retirementFenceIds : []),
        ...(Array.isArray(epochProof?.retirement_fence_ids) ? epochProof.retirement_fence_ids : []),
        retirement.id,
        retirement.eventId,
        retirement.event_id,
        retirement.retirementEventId,
        retirement.retirement_event_id,
      ),
      epoch,
      status: epochProof?.oldGenerationRetired === true
        ? firstString(
            epochProof?.delayedUnloadResult,
            epochProof?.delayed_unload_result,
            retirement.status,
            'retired',
          )
        : null,
      timestamp_monotonic_ns: latestTimestamp(
        epochProof?.retirementTimestamp,
        epochProof?.retirement_timestamp,
        epochProof?.retirementTimestampMonotonicNs,
        epochProof?.retirement_timestamp_monotonic_ns,
        epochProof?.retirementEventTimestamp,
        epochProof?.retirement_event_timestamp,
        epochProof?.retirementEventTimestampMonotonicNs,
        epochProof?.retirement_event_timestamp_monotonic_ns,
        epochProof?.retirementFenceTimestamp,
        epochProof?.retirement_fence_timestamp,
        retirement.timestampMonotonicNs,
        retirement.timestamp_monotonic_ns,
        retirement.retirementTimestampMonotonicNs,
        retirement.retirement_timestamp_monotonic_ns,
        retirement.retirementEventTimestampMonotonicNs,
        retirement.retirement_event_timestamp_monotonic_ns,
        outputTimestamp && (
          epochProof?.oldGenerationRetired === true
          && String(epochProof?.delayedUnloadResult ?? epochProof?.delayed_unload_result ?? '')
            .toLowerCase() === 'not_required'
        )
          ? outputTimestamp
          : null,
      ),
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
    output_oracle_target: outputOracleTarget ?? {},
    oracle_artifacts: oracleArtifactsFromSources(input, outputProof),
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
      ?? timingMetrics?.metricClock
      ?? timingMetrics?.metric_clock
      ?? ledgerTimings?.metricClock
      ?? ledgerTimings?.metric_clock,
    metric_scope:
      input.metricScope
      ?? input.metric_scope
      ?? validationContext?.metricScope
      ?? validationContext?.metric_scope
      ?? timingMetrics?.metricScope
      ?? timingMetrics?.metric_scope
      ?? ledgerTimings?.metricScope
      ?? ledgerTimings?.metric_scope,
    cache_state:
      input.cacheState
      ?? input.cache_state
      ?? validationContext?.cacheState
      ?? validationContext?.cache_state
      ?? timingMetrics?.cacheState
      ?? timingMetrics?.cache_state
      ?? ledgerTimings?.cacheState
      ?? ledgerTimings?.cache_state,
    timings: ledgerTimings,
    timing_metrics: timingMetrics ?? {},
    model_provenance: input.modelProvenance ?? input.model_provenance ?? validationContext?.modelProvenance ?? {},
    evidence_refs: compactStringList([
      ...(Array.isArray(input.evidenceRefs) ? input.evidenceRefs : []),
      ...(Array.isArray(input.evidence_refs) ? input.evidence_refs : []),
      ...(Array.isArray(validationContext?.evidenceRefs) ? validationContext.evidenceRefs : []),
      ...(Array.isArray(validationContext?.evidence_refs) ? validationContext.evidence_refs : []),
      ...(Array.isArray(acceptanceContract?.evidence_refs) ? acceptanceContract.evidence_refs : []),
      ...(Array.isArray(acceptanceContract?.evidenceRefs) ? acceptanceContract.evidenceRefs : []),
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
  const realRocmAppHookContract = realRocmAppHookContractSnapshot(input, validationContext);
  const realRocmAppHookMaterialization =
    realRocmAppHookMaterializationSnapshot(input, validationContext);
  const realRocmRuntimeProfileAdapterResult =
    realRocmRuntimeProfileAdapterResultSnapshot(input, validationContext);
  const realRocmRuntimeBoundaryTargetEnvironment =
    realRocmRuntimeBoundaryTargetEnvironmentSnapshot(input, validationContext);
  const realRocmRuntimeBoundaryTargetProcessProvenance =
    realRocmRuntimeBoundaryTargetProcessProvenanceSnapshot(input, validationContext);
  const realRocmSameProcessRuntimeOracle =
    realRocmSameProcessRuntimeOracleSnapshot(input, validationContext);
  const realRocmMissingDependencyProbe =
    realRocmMissingDependencyProbeSnapshot(input, validationContext);
  const adversarialPreflight = adversarialPreflightFacet(
    adversarialPreflightFromInput(input, validationContext),
  );
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
  const visualEvidenceRequired =
    outputProofRequiresVisualEvidence(
      outputProof,
      visualEvidenceRefs,
      visualEvidenceArtifacts,
    )
    || visualBackendRequiresVisualEvidence({
      input,
      validationContext,
      acceptanceContract,
      outputProof,
    });
  const visualArtifactsByPath = visualArtifactMap(visualEvidenceArtifacts);
  const stages = Array.isArray(fullRuntimeProof?.stages)
    ? fullRuntimeProof.stages.map((stage) => proofStageResult(stage, input, createdAt))
    : [];
  const limitations = [
    ...fullRuntimeStructuralLimitations(stages, fullRuntimeProof),
    ...proofLimitations(stages, fullRuntimeProof),
    ...acceptanceContractLimitations(acceptanceContractEvaluation),
    ...acceptanceContractConsistencyLimitations(acceptanceContractConsistency),
    ...deterministicVisualModeLimitations(deterministicVisualModeEvaluation, {
      required: visualEvidenceRequired,
    }),
    ...visualProofArtifactLimitations({
      outputProof,
      visualEvidenceRefs,
      visualEvidenceArtifacts,
      visualEvidenceRequired,
    }),
    ...visualLedgerOracleLimitations({
      visualEvidenceRequired,
      derivedProofLedgerRecord,
    }),
    ...adversarialPreflightLimitations(adversarialPreflight),
    ...proofLedgerSourceConsistencyLimitations(proofLedgerSourceConsistency),
    ...proofLedgerLimitations(proofLedgerQuery),
    ...realRocmAppHookContractLimitations(realRocmAppHookContract),
    ...realRocmAppHookMaterializationLimitations(realRocmAppHookMaterialization),
    ...realRocmRuntimeProfileAdapterResultLimitations(realRocmRuntimeProfileAdapterResult),
    ...realRocmRuntimeBoundaryTargetEnvironmentLimitations(
      realRocmRuntimeBoundaryTargetEnvironment,
    ),
    ...realRocmRuntimeBoundaryTargetProcessProvenanceLimitations(
      realRocmRuntimeBoundaryTargetProcessProvenance,
    ),
    ...realRocmSameProcessRuntimeOracleLimitations(realRocmSameProcessRuntimeOracle),
    ...realRocmMissingDependencyProbeLimitations(realRocmMissingDependencyProbe),
    ...targetProgressionGateLimitations(targetProgressionGates),
  ];
  const proofFacets = proofFacetsSnapshot(input, visualEvidenceArtifacts);
  const evidenceStrings = compactStringList([
    ...stages.flatMap((stage) => stage.evidenceRefs),
    ...visualEvidenceRefs,
    ...evidenceStringsFromValue(fullRuntimeProof),
    ...evidenceStringsFromValue(runtimeEvidence),
    ...evidenceStringsFromValue(targetProgressionLedger),
    ...evidenceStringsFromValue(adversarialPreflight),
    ...evidenceStringsFromValue(realRocmAppHookContract),
    ...evidenceStringsFromValue(realRocmAppHookMaterialization),
    ...evidenceStringsFromValue(realRocmRuntimeProfileAdapterResult),
    ...evidenceStringsFromValue(realRocmRuntimeBoundaryTargetEnvironment),
    ...evidenceStringsFromValue(realRocmRuntimeBoundaryTargetProcessProvenance),
    ...evidenceStringsFromValue(realRocmSameProcessRuntimeOracle),
    ...evidenceStringsFromValue(realRocmMissingDependencyProbe),
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
    realRocmAppHookContract,
    real_rocm_app_hook_contract: realRocmAppHookContract,
    realRocmAppHookMaterialization,
    real_rocm_app_hook_materialization: realRocmAppHookMaterialization,
    appHookMaterialization: realRocmAppHookMaterialization,
    app_hook_materialization: realRocmAppHookMaterialization,
    realRocmRuntimeProfileAdapterResult,
    real_rocm_runtime_profile_adapter_result: realRocmRuntimeProfileAdapterResult,
    runtimeProfileAdapterResult: realRocmRuntimeProfileAdapterResult,
    runtime_profile_adapter_result: realRocmRuntimeProfileAdapterResult,
    realRocmRuntimeBoundaryTargetEnvironment,
    real_rocm_runtime_boundary_target_environment:
      realRocmRuntimeBoundaryTargetEnvironment,
    runtimeBoundaryTargetEnvironment: realRocmRuntimeBoundaryTargetEnvironment,
    runtime_boundary_target_environment: realRocmRuntimeBoundaryTargetEnvironment,
    realRocmRuntimeBoundaryTargetProcessProvenance,
    real_rocm_runtime_boundary_target_process_provenance:
      realRocmRuntimeBoundaryTargetProcessProvenance,
    runtimeBoundaryTargetProcessProvenance:
      realRocmRuntimeBoundaryTargetProcessProvenance,
    runtime_boundary_target_process_provenance:
      realRocmRuntimeBoundaryTargetProcessProvenance,
    realRocmSameProcessRuntimeOracle,
    real_rocm_same_process_runtime_oracle: realRocmSameProcessRuntimeOracle,
    sameProcessRuntimeOracle: realRocmSameProcessRuntimeOracle,
    same_process_runtime_oracle: realRocmSameProcessRuntimeOracle,
    realRocmMissingDependencyProbe,
    real_rocm_missing_dependency_probe: realRocmMissingDependencyProbe,
    missingDependencyProbe: realRocmMissingDependencyProbe,
    missing_dependency_probe: realRocmMissingDependencyProbe,
    adversarialPreflight,
    acceptanceContract,
    acceptanceContractEvaluation,
    derivedAcceptanceContract,
    derivedAcceptanceContractEvaluation,
    acceptanceContractConsistency,
    deterministicVisualMode,
    deterministicVisualModeEvaluation,
    visualEvidenceRequired,
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
    realRocmAppHookContract,
    realRocmAppHookMaterialization,
    realRocmRuntimeProfileAdapterResult,
    realRocmRuntimeBoundaryTargetEnvironment,
    realRocmRuntimeBoundaryTargetProcessProvenance,
    realRocmSameProcessRuntimeOracle,
    realRocmMissingDependencyProbe,
    adversarialPreflight,
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
    && adversarialPreflight?.accepted === true
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
    realRocmAppHookContract,
    real_rocm_app_hook_contract: realRocmAppHookContract,
    realRocmAppHookMaterialization,
    real_rocm_app_hook_materialization: realRocmAppHookMaterialization,
    appHookMaterialization: realRocmAppHookMaterialization,
    app_hook_materialization: realRocmAppHookMaterialization,
    realRocmRuntimeProfileAdapterResult,
    real_rocm_runtime_profile_adapter_result: realRocmRuntimeProfileAdapterResult,
    runtimeProfileAdapterResult: realRocmRuntimeProfileAdapterResult,
    runtime_profile_adapter_result: realRocmRuntimeProfileAdapterResult,
    realRocmRuntimeBoundaryTargetEnvironment,
    real_rocm_runtime_boundary_target_environment:
      realRocmRuntimeBoundaryTargetEnvironment,
    runtimeBoundaryTargetEnvironment: realRocmRuntimeBoundaryTargetEnvironment,
    runtime_boundary_target_environment: realRocmRuntimeBoundaryTargetEnvironment,
    realRocmRuntimeBoundaryTargetProcessProvenance,
    real_rocm_runtime_boundary_target_process_provenance:
      realRocmRuntimeBoundaryTargetProcessProvenance,
    runtimeBoundaryTargetProcessProvenance:
      realRocmRuntimeBoundaryTargetProcessProvenance,
    runtime_boundary_target_process_provenance:
      realRocmRuntimeBoundaryTargetProcessProvenance,
    realRocmSameProcessRuntimeOracle,
    real_rocm_same_process_runtime_oracle: realRocmSameProcessRuntimeOracle,
    sameProcessRuntimeOracle: realRocmSameProcessRuntimeOracle,
    same_process_runtime_oracle: realRocmSameProcessRuntimeOracle,
    realRocmMissingDependencyProbe,
    real_rocm_missing_dependency_probe: realRocmMissingDependencyProbe,
    missingDependencyProbe: realRocmMissingDependencyProbe,
    missing_dependency_probe: realRocmMissingDependencyProbe,
    adversarialPreflight,
    adversarial_preflight: adversarialPreflight,
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
    const acceptedAsVisualEvidence = imageEvidence
      ? screenshotQualifiesAsVisualEvidence({
        path: artifactPath,
        ...imageEvidence,
      })
      : false;
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
      acceptedAsVisualEvidence,
      accepted_as_visual_evidence: acceptedAsVisualEvidence,
    } : {
      visualQuality: fileRecord.readError
        ? 'gpu-hmr-visual-unreadable-artifact'
        : 'gpu-hmr-visual-unanalyzable-artifact',
      visual_quality: fileRecord.readError
        ? 'gpu-hmr-visual-unreadable-artifact'
        : 'gpu-hmr-visual-unanalyzable-artifact',
      acceptedAsVisualEvidence: false,
      accepted_as_visual_evidence: false,
    };
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

function fileArtifactPath(value) {
  const ref = firstString(value);
  if (!ref) return null;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(ref) && !ref.toLowerCase().startsWith('file://')) return null;
  if (ref.toLowerCase().startsWith('file://')) {
    return new URL(ref);
  }
  return ref;
}

function finiteOffset(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.trunc(n) : null;
}

function normalizeOptionalSha256(value) {
  const ref = firstString(value);
  if (!ref) return null;
  const artifactMatch = ref.match(/^artifact:sha256:([0-9a-f]{64})$/i);
  if (artifactMatch) return `sha256:${artifactMatch[1].toLowerCase()}`;
  const hashMatch = ref.match(/^sha256:([0-9a-f]{64})$/i) ?? ref.match(/^([0-9a-f]{64})$/i);
  return hashMatch ? `sha256:${hashMatch[1].toLowerCase()}` : null;
}

function normalizedComputeArtifactRole(value) {
  const role = firstString(value)?.toLowerCase().replace(/[\s-]+/g, '_');
  if (!role) return null;
  if ([
    'raw',
    'raw_readback',
    'raw_readback_bin',
    'readback',
    'readback_bin',
    'compute_readback',
    'compute_raw_readback',
    'runtime_compute_raw_readback',
  ].includes(role)) {
    return 'raw_readback';
  }
  if ([
    'schema',
    'readback_schema',
    'readback_schema_json',
    'compute_schema',
    'compute_readback_schema',
    'runtime_compute_readback_schema',
  ].includes(role)) {
    return 'readback_schema';
  }
  if ([
    'card',
    'proof_card',
    'proof_card_png',
    'rendered_card',
    'rendered_card_png',
    'compute_card',
    'compute_proof_card',
    'runtime_compute_proof_card',
  ].includes(role)) {
    return 'rendered_card';
  }
  return null;
}

function computeArtifactLocatorRole(locator) {
  return normalizedComputeArtifactRole(
    locator?.role
    ?? locator?.artifactRole
    ?? locator?.artifact_role
    ?? locator?.artifactKind
    ?? locator?.artifact_kind,
  );
}

function computeArtifactLocatorHash(locator) {
  return normalizeOptionalSha256(
    locator?.contentHash
    ?? locator?.content_hash
    ?? locator?.artifactHash
    ?? locator?.artifact_hash
    ?? locator?.artifactId
    ?? locator?.artifact_id,
  );
}

function computeArtifactCasLocators(source) {
  const locators = collectArtifactLocators(source).filter((locator) => {
    if ((locator.schemaVersion ?? locator.schema_version) !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) return false;
    return computeArtifactLocatorRole(locator) !== null;
  });
  const seen = new Set();
  return locators.filter((locator) => {
    const role = computeArtifactLocatorRole(locator) ?? 'artifact';
    const hash = computeArtifactLocatorHash(locator) ?? 'unknown';
    const manifestHash = firstString(locator.manifestHash, locator.manifest_hash) ?? 'no-manifest';
    const key = `${role}:${hash}:${manifestHash}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function computeArtifactCasExpectedHash(source, role) {
  if (role === 'raw_readback') {
    return normalizeOptionalSha256(
      firstString(
        source.raw_readback_hash,
        source.rawReadbackHash,
        source.readback_hash,
        source.readbackHash,
      ),
    );
  }
  if (role === 'readback_schema') {
    return normalizeOptionalSha256(
      firstString(
        source.readback_schema_hash,
        source.readbackSchemaHash,
        source.schema_hash,
        source.schemaHash,
      ),
    );
  }
  if (role === 'rendered_card') {
    return normalizeOptionalSha256(
      firstString(
        source.rendered_card_hash,
        source.renderedCardHash,
        source.rendered_card_png_hash,
        source.renderedCardPngHash,
        source.proof_card_hash,
        source.proofCardHash,
        source.card_hash,
        source.cardHash,
      ),
    );
  }
  return null;
}

function computeArtifactCasAllowedRoots(source = {}, options = {}) {
  const envRoot = defaultCasRootFromEnv();
  const trustedRoots = compactStringList([
    ...(Array.isArray(options.allowedRoots) ? options.allowedRoots : []),
    ...(Array.isArray(options.allowedArtifactRoots) ? options.allowedArtifactRoots : []),
    ...(Array.isArray(options.allowedCasRoots) ? options.allowedCasRoots : []),
    options.artifactRoot,
    options.artifactCasRoot,
    options.casRoot,
    envRoot,
  ]).map((root) => path.resolve(root));
  if (trustedRoots.length === 0) return [];

  const sourceRoots = compactStringList([
    ...(Array.isArray(source.artifactCasRoots) ? source.artifactCasRoots : []),
    ...(Array.isArray(source.artifact_cas_roots) ? source.artifact_cas_roots : []),
    ...(Array.isArray(source.allowedCasRoots) ? source.allowedCasRoots : []),
    ...(Array.isArray(source.allowed_cas_roots) ? source.allowed_cas_roots : []),
    source.artifactCasRoot,
    source.artifact_cas_root,
    source.casRoot,
    source.cas_root,
    source.artifactRoot,
    source.artifact_root,
  ]).map((root) => path.resolve(root));
  const trusted = new Set(trustedRoots);
  for (const sourceRoot of sourceRoots) {
    if (trustedRoots.some((trustedRoot) => isPathInsideOrSame(sourceRoot, trustedRoot))) {
      trusted.add(sourceRoot);
    }
  }
  return [...trusted];
}

function computeArtifactTrustedCasRoot(options = {}) {
  return compactStringList([
    options.artifactRoot,
    options.artifactCasRoot,
    options.casRoot,
    ...(Array.isArray(options.allowedArtifactRoots) ? options.allowedArtifactRoots : []),
    ...(Array.isArray(options.allowedCasRoots) ? options.allowedCasRoots : []),
    defaultCasRootFromEnv(),
  ]).map((root) => path.resolve(root))[0] ?? null;
}

function isPathInsideOrSame(child, root) {
  const resolvedChild = path.resolve(child);
  const resolvedRoot = path.resolve(root);
  const relative = path.relative(resolvedRoot, resolvedChild);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

async function readComputeArtifactCasManifest(value, role) {
  const direct = objectOrNull(value);
  if (direct) {
    return {
      manifest: { role, ...direct, role: direct.role ?? direct.artifactRole ?? direct.artifact_role ?? role },
      readError: null,
    };
  }
  const manifestPath = fileArtifactPath(value);
  if (!manifestPath) return { manifest: null, readError: null };
  try {
    const parsed = JSON.parse(await readFile(manifestPath, 'utf8'));
    return {
      manifest: { role, ...parsed, role: parsed.role ?? parsed.artifactRole ?? parsed.artifact_role ?? role },
      readError: null,
      manifestPath,
    };
  } catch (error) {
    return {
      manifest: null,
      readError: error?.message ? String(error.message) : String(error),
      manifestPath,
    };
  }
}

function computeArtifactCasLocatorForRole(locators, role, expectedHash) {
  const normalizedRole = normalizedComputeArtifactRole(role);
  const normalizedHash = normalizeOptionalSha256(expectedHash);
  const roleMatches = locators.filter((locator) => {
    const locatorRole = computeArtifactLocatorRole(locator);
    return !normalizedRole || !locatorRole || locatorRole === normalizedRole;
  });
  return roleMatches.find((locator) => {
    const locatorHash = computeArtifactLocatorHash(locator);
    return !normalizedHash || !locatorHash || locatorHash === normalizedHash;
  }) ?? roleMatches[0] ?? null;
}

async function validateComputeArtifactCasLocator(locator, source, options) {
  try {
    return await validateArtifactCasManifest(locator, {
      allowedRoots: computeArtifactCasAllowedRoots(source, options),
      artifactRoot: computeArtifactTrustedCasRoot(options),
      requireReadableBytes: true,
    });
  } catch (error) {
    return {
      accepted: false,
      acceptedAsTransportEvidence: false,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      proofAuthority: 'transport_integrity_only',
      localPath: null,
      local_path: null,
      contentHash: computeArtifactLocatorHash(locator),
      manifestHash: firstString(locator?.manifestHash, locator?.manifest_hash),
      reasons: ['artifact_cas_validation_exception'],
      gaps: [],
      details: {
        message: error?.message ? String(error.message) : String(error),
      },
    };
  }
}

async function resolveComputeArtifactCasPaths(source, options = {}) {
  const out = { ...source };
  const embeddedLocators = computeArtifactCasLocators(source);
  const entries = [];
  const roleFields = [
    {
      role: 'raw_readback',
      snakeName: 'raw_readback_bin',
      camelName: 'rawReadbackBin',
      manifestFields: ['raw_readback_cas_manifest', 'rawReadbackCasManifest', 'raw_readback_locator', 'rawReadbackLocator'],
    },
    {
      role: 'readback_schema',
      snakeName: 'readback_schema_json',
      camelName: 'readbackSchemaJson',
      manifestFields: [
        'readback_schema_cas_manifest',
        'readbackSchemaCasManifest',
        'schema_cas_manifest',
        'schemaCasManifest',
        'readback_schema_locator',
        'readbackSchemaLocator',
      ],
    },
    {
      role: 'rendered_card',
      snakeName: 'rendered_card_png',
      camelName: 'renderedCardPng',
      manifestFields: [
        'rendered_card_cas_manifest',
        'renderedCardCasManifest',
        'proof_card_cas_manifest',
        'proofCardCasManifest',
        'rendered_card_locator',
        'renderedCardLocator',
      ],
    },
  ];
  for (const { role, snakeName, camelName, manifestFields } of roleFields) {
    let locator = null;
    const manifestValue = manifestFields.map((field) => out[field]).find((value) => value !== null && value !== undefined);
    if (manifestValue !== undefined) {
      const loaded = await readComputeArtifactCasManifest(manifestValue, role);
      if (loaded.readError) {
        entries.push({
          role,
          accepted: false,
          path: null,
          contentHash: null,
          content_hash: null,
          manifestHash: null,
          manifest_hash: null,
          manifestPath: loaded.manifestPath ?? null,
          manifest_path: loaded.manifestPath ?? null,
          reasons: ['compute_oracle_artifact_cas_manifest_unreadable'],
          gaps: [],
        });
        delete out[snakeName];
        delete out[camelName];
        continue;
      }
      locator = loaded.manifest;
    }
    if (!locator) {
      locator = computeArtifactCasLocatorForRole(
        embeddedLocators,
        role,
        computeArtifactCasExpectedHash(source, role),
      );
    }
    if (!locator) continue;
    const locatorRole = computeArtifactLocatorRole(locator);
    if (locatorRole !== role) {
      entries.push({
        role,
        accepted: false,
        path: null,
        contentHash: computeArtifactLocatorHash(locator),
        content_hash: computeArtifactLocatorHash(locator),
        manifestHash: firstString(locator?.manifestHash, locator?.manifest_hash),
        manifest_hash: firstString(locator?.manifestHash, locator?.manifest_hash),
        reasons: ['compute_oracle_artifact_cas_role_mismatch'],
        gaps: [],
      });
      delete out[snakeName];
      delete out[camelName];
      continue;
    }
    const validation = await validateComputeArtifactCasLocator(locator, source, options);
    const pathValue = validation?.accepted === true
      ? firstString(validation.localPath, validation.local_path)
      : null;
    entries.push({
      role,
      accepted: Boolean(pathValue),
      path: pathValue,
      contentHash: validation?.contentHash ?? null,
      content_hash: validation?.contentHash ?? null,
      manifestHash: validation?.manifestHash ?? null,
      manifest_hash: validation?.manifestHash ?? null,
      reasons: validation?.reasons ?? [],
      gaps: validation?.gaps ?? [],
    });
    if (pathValue) {
      out[snakeName] = pathValue;
      out[camelName] = pathValue;
    } else {
      delete out[snakeName];
      delete out[camelName];
    }
  }
  const locatorCount = entries.length;
  const acceptedCount = entries.filter((entry) => entry.accepted === true).length;
  if (locatorCount > 0) {
    out.compute_artifact_cas_resolution = {
      schemaVersion: 'synthi.gpu_hmr.compute_artifact_cas_resolution.v1',
      schema_version: 'synthi.gpu_hmr.compute_artifact_cas_resolution.v1',
      proofAuthority: 'compute_artifact_transport_integrity_only',
      proof_authority: 'compute_artifact_transport_integrity_only',
      acceptedForGpuHmr: false,
      accepted_for_gpu_hmr: false,
      gpuHmrSuccess: false,
      gpu_hmr_success: false,
      locatorCount,
      locator_count: locatorCount,
      acceptedCount,
      accepted_count: acceptedCount,
      accepted: acceptedCount === locatorCount,
      entries,
      failedGates: acceptedCount === locatorCount
        ? []
        : ['compute_oracle_artifact_cas_locator_validation_failed'],
      failed_gates: acceptedCount === locatorCount
        ? []
        : ['compute_oracle_artifact_cas_locator_validation_failed'],
    };
    out.computeArtifactCasResolution = out.compute_artifact_cas_resolution;
  }
  return out;
}

export async function computeOracleArtifactsFromFiles(computeArtifacts = null, options = {}) {
  const source = objectOrNull(computeArtifacts);
  if (!source) return null;
  const resolvedSource = await resolveComputeArtifactCasPaths(source, options);
  const rawPath = fileArtifactPath(firstString(resolvedSource.raw_readback_bin, resolvedSource.rawReadbackBin));
  const schemaPath = fileArtifactPath(firstString(resolvedSource.readback_schema_json, resolvedSource.readbackSchemaJson));
  const enriched = { ...resolvedSource };
  const verification = {
    ...objectOrNull(resolvedSource.raw_readback_verification),
    ...objectOrNull(resolvedSource.rawReadbackVerification),
    ...objectOrNull(resolvedSource.byte_verification),
    ...objectOrNull(resolvedSource.byteVerification),
  };

  if (schemaPath) {
    try {
      const schemaBytes = await readFile(schemaPath);
      const schemaHash = sha256BufferHash(schemaBytes);
      enriched.readback_schema_hash = schemaHash;
      verification.readback_schema_hash = schemaHash;
      verification.readback_schema_byte_length = schemaBytes.length;
    } catch (error) {
      verification.readback_schema_read_error = error?.message ? String(error.message) : String(error);
    }
  }

  if (rawPath) {
    try {
      const rawBytes = await readFile(rawPath);
      const actualHash = sha256BufferHash(rawBytes);
      const declaredHash = firstString(source.raw_readback_hash, source.rawReadbackHash);
      enriched.raw_readback_hash = declaredHash ?? actualHash;
      enriched.raw_readback_byte_length = rawBytes.length;
      verification.byte_length = rawBytes.length;
      verification.raw_readback_hash = actualHash;
      verification.hash_verified = !declaredHash || declaredHash.toLowerCase() === actualHash.toLowerCase();
      const slice = objectOrNull(source.deterministic_slice ?? source.deterministicSlice);
      const offset = finiteOffset(slice.offset ?? slice.byte_offset ?? slice.byteOffset);
      const length = finiteOffset(slice.length ?? slice.byte_length ?? slice.byteLength);
      if (offset !== null && length !== null && length > 0 && offset + length <= rawBytes.length) {
        const sliceHash = sha256BufferHash(rawBytes.subarray(offset, offset + length));
        enriched.deterministic_slice = {
          ...slice,
          offset,
          length,
          hash: firstString(slice.hash, slice.sha256, slice.slice_hash, slice.sliceHash) ?? sliceHash,
        };
        enriched.deterministic_slice_hash = enriched.deterministic_slice.hash;
        verification.deterministic_slice_hash = sliceHash;
        verification.deterministic_slice_hash_verified =
          String(enriched.deterministic_slice.hash).toLowerCase() === sliceHash.toLowerCase();
        verification.slice_bounds_verified = true;
      } else {
        verification.slice_bounds_verified = false;
      }
    } catch (error) {
      verification.raw_readback_read_error = error?.message ? String(error.message) : String(error);
    }
  }

  if (Object.keys(verification).length > 0) {
    enriched.raw_readback_verification = verification;
    if (verification.hash_verified === true) enriched.raw_readback_hash_verified = true;
    if (verification.deterministic_slice_hash_verified === true) {
      enriched.deterministic_slice_hash_verified = true;
    }
  }

  return enriched;
}

async function imageRawRgb(imagePath) {
  const { data, info } = await sharp(imagePath).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, width: info.width, height: info.height, channels: info.channels };
}

function visiblePixelCount(raw) {
  let visible = 0;
  for (let i = 0; i < raw.data.length; i += raw.channels) {
    const r = raw.data[i] ?? 0;
    const g = raw.data[i + 1] ?? 0;
    const b = raw.data[i + 2] ?? 0;
    const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (luma > 24 || Math.max(r, g, b) - Math.min(r, g, b) > 30) visible += 1;
  }
  return visible;
}

export async function visualOracleArtifactsFromFiles(visualArtifacts = null) {
  const source = objectOrNull(visualArtifacts);
  if (!source) return null;
  const beforePath = fileArtifactPath(firstString(source.before_image, source.beforeImage));
  const afterPath = fileArtifactPath(firstString(source.after_image, source.afterImage));
  const diffPath = fileArtifactPath(firstString(source.diff_image, source.diffImage));
  const enriched = { ...source };
  const verification = {
    ...objectOrNull(source.visual_pixel_verification),
    ...objectOrNull(source.visualPixelVerification),
    ...objectOrNull(source.pixel_verification),
    ...objectOrNull(source.pixelVerification),
  };

  try {
    if (beforePath) {
      const beforeBytes = await readFile(beforePath);
      enriched.before_image_hash = sha256BufferHash(beforeBytes);
      verification.before_image_hash = enriched.before_image_hash;
      verification.before_image_hash_verified = true;
    }
    if (afterPath) {
      const afterBytes = await readFile(afterPath);
      enriched.after_image_hash = sha256BufferHash(afterBytes);
      verification.after_image_hash = enriched.after_image_hash;
      verification.after_image_hash_verified = true;
    }
    if (diffPath) {
      const diffBytes = await readFile(diffPath);
      enriched.diff_image_hash = sha256BufferHash(diffBytes);
      verification.diff_image_hash = enriched.diff_image_hash;
      verification.diff_image_hash_verified = true;
    }
    if (beforePath && afterPath) {
      const before = await imageRawRgb(beforePath);
      const after = await imageRawRgb(afterPath);
      if (before.width !== after.width || before.height !== after.height) {
        verification.pixel_metric_error = 'visual_dimensions_mismatch';
      } else {
        let changedPixels = 0;
        let absoluteDelta = 0;
        const pixels = Math.max(1, before.width * before.height);
        const length = Math.min(before.data.length, after.data.length);
        for (let i = 0; i < length; i += before.channels) {
          const dr = Math.abs((before.data[i] ?? 0) - (after.data[i] ?? 0));
          const dg = Math.abs((before.data[i + 1] ?? 0) - (after.data[i + 1] ?? 0));
          const db = Math.abs((before.data[i + 2] ?? 0) - (after.data[i + 2] ?? 0));
          if (dr + dg + db > 0) changedPixels += 1;
          absoluteDelta += dr + dg + db;
        }
        const changedPixelRatio = changedPixels / pixels;
        const perceptualDiff = absoluteDelta / (pixels * 3 * 255);
        const visiblePixels = visiblePixelCount(after);
        enriched.changed_pixel_ratio = changedPixelRatio;
        enriched.perceptual_diff = perceptualDiff;
        enriched.visible_pixel_count = visiblePixels;
        enriched.swapchain_size = enriched.swapchain_size ?? [after.width, after.height];
        enriched.pixel_metrics_verified = true;
        verification.metrics_verified = true;
        verification.changed_pixel_ratio_recomputed = changedPixelRatio;
        verification.perceptual_diff_recomputed = perceptualDiff;
        verification.visible_pixel_count_recomputed = visiblePixels;
        verification.width = after.width;
        verification.height = after.height;
      }
    }
  } catch (error) {
    verification.pixel_metric_error = error?.message ? String(error.message) : String(error);
  }

  if (Object.keys(verification).length > 0) {
    enriched.visual_pixel_verification = verification;
  }
  return enriched;
}

export async function writeValidationRuntimeProofArtifact(outputDir, input = {}) {
  const visualEvidenceArtifacts = await visualEvidenceArtifactsFromFiles(
    input.visualEvidenceRefs,
    input.visualEvidenceArtifacts,
  );
  const visualOracleArtifacts = await visualOracleArtifactsFromFiles(
    input.visualOracleArtifacts
    ?? input.visual_oracle_artifacts
    ?? objectOrNull(input.oracleArtifacts)?.visualOracleArtifacts
    ?? objectOrNull(input.oracleArtifacts)?.visual_oracle_artifacts
    ?? objectOrNull(input.oracle_artifacts)?.visualOracleArtifacts
    ?? objectOrNull(input.oracle_artifacts)?.visual_oracle_artifacts
    ?? visualOracleArtifactsFromOutputProof(input.outputProof),
  );
  const computeOracleArtifacts = await computeOracleArtifactsFromFiles(
    input.computeOracleArtifacts
    ?? input.compute_oracle_artifacts
    ?? objectOrNull(input.oracleArtifacts)?.computeOracleArtifacts
    ?? objectOrNull(input.oracleArtifacts)?.compute_oracle_artifacts
    ?? objectOrNull(input.oracle_artifacts)?.computeOracleArtifacts
    ?? objectOrNull(input.oracle_artifacts)?.compute_oracle_artifacts
    ?? computeOracleArtifactsFromOutputProof(input.outputProof),
  );
  const artifact = buildValidationRuntimeProofArtifact({
    ...input,
    visualEvidenceArtifacts,
    visualOracleArtifacts,
    computeOracleArtifacts,
  });
  await mkdir(outputDir, { recursive: true });
  const workspace = safeToken(input.workspaceSlug);
  const label = safeToken(input.label ?? input.name ?? artifact.resultState ?? 'runtime-proof');
  const hash = artifact.proofId.split(':').pop();
  const filePath = path.join(outputDir, `${workspace}-${label}-${hash}.json`);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return { path: filePath, artifact };
}
