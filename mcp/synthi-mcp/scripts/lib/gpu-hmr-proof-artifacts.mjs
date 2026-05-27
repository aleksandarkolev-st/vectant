import { classifyGpuHmrAbiProof } from './gpu-hmr-runtime-proof.mjs';

function uniqueStrings(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
    : [];
}

function abiEvidenceId(evidence, artifact, record) {
  if (typeof evidence?.evidenceId === 'string' && evidence.evidenceId.trim()) {
    return evidence.evidenceId.trim();
  }
  return `${artifact?.proofId ?? record?.proofArtifactPath ?? 'gpu-hmr-proof-artifact'}:device-abi-metadata`;
}

function abiStageFromArtifact(artifact) {
  const stages = Array.isArray(artifact?.stageResults) ? artifact.stageResults : [];
  return stages.find((stage) => {
    const stageId = String(stage?.stageId ?? '').toLowerCase();
    return stageId === 'abi' || stageId.includes('abi-');
  });
}

export function abiProofFromProofArtifacts(records) {
  const evidenceRefs = [];
  const acceptedExtractorEvidenceRefs = [];
  const acceptedExtractorSources = [];
  const extractorProvenance = [];
  let extractorProvenanceComplete = true;
  let layoutSizeAlignmentVerified = false;
  let degradedReason = null;

  for (const record of Array.isArray(records) ? records : []) {
    const artifact = record?.artifact;
    if (!artifact || typeof artifact !== 'object') continue;

    const artifactEvidenceRefs = Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : [];
    for (const evidence of artifactEvidenceRefs) {
      if (evidence?.kind !== 'device-abi-metadata') continue;
      const metadata = evidence?.metadata;
      if (metadata?.schemaVersion !== 'synthi.gpu.hmr.abi_metadata.v1') continue;

      evidenceRefs.push(abiEvidenceId(evidence, artifact, record));
      if (metadata.layoutSizeAlignmentVerified === true) {
        layoutSizeAlignmentVerified = true;
      }
      acceptedExtractorEvidenceRefs.push(...uniqueStrings(metadata.acceptedExtractorEvidenceRefs ?? []));
      acceptedExtractorSources.push(...uniqueStrings(metadata.acceptedExtractorSources ?? []));
      if (Array.isArray(metadata.extractorProvenance)) {
        extractorProvenance.push(...metadata.extractorProvenance.filter((item) => item && typeof item === 'object'));
      }
      if (metadata.extractorProvenanceComplete === false) {
        extractorProvenanceComplete = false;
      }
      if (!degradedReason && typeof metadata.degradedReason === 'string' && metadata.degradedReason.trim()) {
        degradedReason = metadata.degradedReason.trim();
      }
    }

    const abiStage = abiStageFromArtifact(artifact);
    if (abiStage?.status === 'passed' && !abiStage?.degradedState) {
      layoutSizeAlignmentVerified = true;
    }
    if (!degradedReason && typeof abiStage?.degradedReason === 'string' && abiStage.degradedReason.trim()) {
      degradedReason = abiStage.degradedReason.trim();
    }
  }

  return classifyGpuHmrAbiProof({
    metadataObserved: evidenceRefs.length > 0,
    layoutSizeAlignmentVerified,
    degradedReason,
    evidenceRefs: uniqueStrings(evidenceRefs),
    acceptedExtractorEvidenceRefs: uniqueStrings(acceptedExtractorEvidenceRefs),
    acceptedExtractorSources: uniqueStrings(acceptedExtractorSources),
    extractorProvenance,
    extractorProvenanceComplete,
  });
}
