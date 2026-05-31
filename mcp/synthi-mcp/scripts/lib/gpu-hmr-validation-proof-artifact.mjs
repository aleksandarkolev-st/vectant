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

function safeToken(value) {
  const token = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || 'runtime-proof';
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
    'host-preservation': [input.hostPreservationProof],
    'original-host-path': [input.originalHostPathProof],
  };
}

function stageEvidenceRefs(stageId, input = {}) {
  return compactStringList((stageProofs(input)[stageId] ?? [])
    .flatMap((proof) => evidenceStringsFromValue(proof)));
}

function proofStageResult(stage, input, createdAt) {
  const evidenceRefs = stageEvidenceRefs(stage.stageId, input);
  return {
    stageId: stage.stageId,
    stageName: stage.stageName ?? stage.stageId,
    status: stage.status,
    startedAt: createdAt,
    completedAt: createdAt,
    inputArtifactIds: compactStringList(stage.inputArtifactIds),
    outputArtifactIds: compactStringList(stage.outputArtifactIds),
    evidenceRefs,
    degradedState: stage.degradedState ?? null,
    degradedReason: stage.degradedReason ?? null,
    requiredState: stage.requiredState ?? null,
    observedState: stage.observedState ?? null,
  };
}

export function buildValidationRuntimeProofArtifact(input = {}) {
  const createdAt = input.createdAt ?? new Date().toISOString();
  const fullRuntimeProof = input.fullRuntimeProof && typeof input.fullRuntimeProof === 'object'
    ? input.fullRuntimeProof
    : null;
  const sessionId = runtimeSessionId(input);
  const runtimeEvidence = runtimeEvidenceSnapshot(input);
  const validationContext = validationContextSnapshot(input);
  const visualEvidenceRefs = compactStringList(input.visualEvidenceRefs);
  const stages = Array.isArray(fullRuntimeProof?.stages)
    ? fullRuntimeProof.stages.map((stage) => proofStageResult(stage, input, createdAt))
    : [];
  const evidenceStrings = compactStringList([
    ...stages.flatMap((stage) => stage.evidenceRefs),
    ...visualEvidenceRefs,
    ...evidenceStringsFromValue(fullRuntimeProof),
    ...evidenceStringsFromValue(runtimeEvidence),
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
  };
  const materialHash = sha256Hex(stableJson({
    workspaceSlug: input.workspaceSlug ?? null,
    runtimeSessionId: sessionId,
    resultState: fullRuntimeProof?.resultState ?? null,
    degradedState: fullRuntimeProof?.degradedState ?? null,
    degradedReason: fullRuntimeProof?.degradedReason ?? null,
    stages,
    evidenceStrings,
    proofMaterial,
    validationContext,
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
    stageResults: stages,
    evidenceRefs,
    visualEvidenceRefs,
    runtimeEvidence,
    validationContext,
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
