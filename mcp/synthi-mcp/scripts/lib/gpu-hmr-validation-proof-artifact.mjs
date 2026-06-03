import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

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

function artifactIdsFromSha256Hashes(values) {
  return compactStringList(values)
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

function evidenceKind(ref) {
  if (/\.png$/i.test(ref) || /\.jpe?g$/i.test(ref) || /\.webp$/i.test(ref)) return 'visual-artifact';
  if (/^worker-log:/i.test(ref)) return 'worker-log';
  if (/^validation:/i.test(ref)) return 'validation-evidence';
  if (/^gpu-proof:/i.test(ref) || /\.synthi[\\/]gpu-hmr[\\/]proofs[\\/]/i.test(ref)) return 'proof-artifact';
  if (/^evidence:/i.test(ref)) return 'proof-evidence';
  return 'runtime-evidence';
}

function evidenceRefObject(ref, createdAt, sessionId) {
  const hash = sha256Hex(ref);
  const kind = evidenceKind(ref);
  return {
    evidenceId: ref.startsWith('evidence:') || ref.startsWith('worker-log:') || ref.startsWith('validation:')
      ? ref
      : `evidence:${kind}:sha256:${hash}`,
    kind,
    contentHash: `sha256:${hash}`,
    producerSubsystem: 'mcp.gpu_hmr_validation',
    timestamp: createdAt,
    sessionId,
    filePath: kind === 'visual-artifact' || kind === 'proof-artifact' ? ref : null,
    artifactUri: ref.startsWith('gpu-proof:') ? ref : null,
    summary: ref,
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

export function buildValidationRuntimeProofArtifact(input = {}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const fullRuntimeProof = input.fullRuntimeProof && typeof input.fullRuntimeProof === 'object'
    ? input.fullRuntimeProof
    : null;
  const sessionId = runtimeSessionId(input);
  const runtimeEvidence = runtimeEvidenceSnapshot(input);
  const validationContext = validationContextSnapshot(input);
  const targetProgression = targetProgressionSnapshot(input, validationContext);
  const targetProgressionLedger = targetProgressionLedgerSnapshot(input, validationContext);
  const visualEvidenceRefs = compactStringList(input.visualEvidenceRefs);
  const stages = Array.isArray(fullRuntimeProof?.stages)
    ? fullRuntimeProof.stages.map((stage) => proofStageResult(stage, input, createdAt))
    : [];
  const limitations = proofLimitations(stages, fullRuntimeProof);
  const evidenceStrings = compactStringList([
    ...stages.flatMap((stage) => stage.evidenceRefs),
    ...visualEvidenceRefs,
    ...evidenceStringsFromValue(fullRuntimeProof),
    ...evidenceStringsFromValue(runtimeEvidence),
    ...evidenceStringsFromValue(targetProgressionLedger),
  ]);
  const evidenceRefs = evidenceStrings.map((ref) => evidenceRefObject(ref, createdAt, sessionId));
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
    validationContext,
    targetProgression,
    targetProgressionLedger,
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
    runtimeEvidence,
    validationContext,
    targetProgression,
    target_progression: targetProgression,
    targetProgressionLedger,
    target_progression_ledger: targetProgressionLedger,
    validationContextHash,
    createdAt,
    proofMaterial,
  };
}

export async function writeValidationRuntimeProofArtifact(outputDir, input = {}) {
  const artifact = buildValidationRuntimeProofArtifact(input);
  await mkdir(outputDir, { recursive: true });
  const workspace = safeToken(input.workspaceSlug);
  const label = safeToken(input.label ?? input.name ?? artifact.resultState ?? 'runtime-proof');
  const hash = artifact.proofId.split(':').pop();
  const filePath = path.join(outputDir, `${workspace}-${label}-${hash}.json`);
  await writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`);
  return { path: filePath, artifact };
}
