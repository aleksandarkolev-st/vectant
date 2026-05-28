import {
  classifyGpuHmrAbiProof,
  classifyGpuHmrFissionProof,
} from './gpu-hmr-runtime-proof.mjs';

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

function artifactTransportEvidenceId(evidence, artifact, record) {
  if (typeof evidence?.evidenceId === 'string' && evidence.evidenceId.trim()) {
    return evidence.evidenceId.trim();
  }
  return `${artifact?.proofId ?? record?.proofArtifactPath ?? 'gpu-hmr-proof-artifact'}:device-artifact-transport`;
}

function artifactTransportStageFromArtifact(artifact) {
  const stages = Array.isArray(artifact?.stageResults) ? artifact.stageResults : [];
  return stages.find((stage) => {
    const stageId = String(stage?.stageId ?? '').toLowerCase();
    return stageId === 'artifact-transport' || stageId.includes('artifact-transport');
  });
}

function fissionVerifierEvidenceId(evidence, artifact, record) {
  if (typeof evidence?.evidenceId === 'string' && evidence.evidenceId.trim()) {
    return evidence.evidenceId.trim();
  }
  return `${artifact?.proofId ?? record?.proofArtifactPath ?? 'gpu-hmr-proof-artifact'}:fission-verifier-report`;
}

function fissionStagesFromArtifact(artifact) {
  const stages = Array.isArray(artifact?.stageResults) ? artifact.stageResults : [];
  return stages.filter((stage) => {
    const stageId = String(stage?.stageId ?? '').toLowerCase();
    return stageId === 'fission-candidate-verification' || stageId.includes('fission');
  });
}

function fissionVerifierReasonCodes(metadata) {
  const codes = [];
  if (Array.isArray(metadata?.reasonCodes)) {
    codes.push(...metadata.reasonCodes.filter((value) => typeof value === 'string' && value.trim()));
  }
  if (Array.isArray(metadata?.candidates)) {
    for (const candidate of metadata.candidates) {
      const status = String(candidate?.status ?? '').trim().toLowerCase();
      if (status === 'pass' || status === 'passed' || status === 'accepted') continue;
      if (Array.isArray(candidate?.reasonCodes)) {
        codes.push(...candidate.reasonCodes.filter((value) => typeof value === 'string' && value.trim()));
      }
    }
  }
  return codes.map((value) => value.trim()).filter(Boolean);
}

function fissionVerifierDegradedReason(metadata) {
  const codes = fissionVerifierReasonCodes(metadata);
  return codes.find((code) => code !== 'fission.no_accepted_candidate')
    ?? codes[0]
    ?? null;
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

export function fissionProofFromProofArtifacts(records) {
  const evidenceRefs = [];
  const stageStatuses = [];
  let observed = false;
  let passed = false;
  let rejected = false;
  let degradedReason = null;

  for (const record of Array.isArray(records) ? records : []) {
    const artifact = record?.artifact;
    if (!artifact || typeof artifact !== 'object') continue;

    const artifactEvidenceRefs = Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : [];
    for (const evidence of artifactEvidenceRefs) {
      if (evidence?.kind !== 'fission-verifier-report') continue;

      observed = true;
      evidenceRefs.push(fissionVerifierEvidenceId(evidence, artifact, record));
      const metadata = evidence?.metadata && typeof evidence.metadata === 'object' ? evidence.metadata : {};
      const status = String(metadata.status ?? '').trim().toLowerCase();
      if (status === 'pass' || status === 'passed' || status === 'accepted') {
        passed = true;
      } else if (status === 'reject' || status === 'rejected' || status === 'fail' || status === 'failed') {
        rejected = true;
      }
      const reason = fissionVerifierDegradedReason(metadata);
      if (!degradedReason && reason) {
        degradedReason = reason;
      }
    }

    for (const stage of fissionStagesFromArtifact(artifact)) {
      observed = true;
      const status = typeof stage?.status === 'string' ? stage.status.trim().toLowerCase() : '';
      if (status) stageStatuses.push(status);
      if (status === 'passed' || status === 'pass' || status === 'accepted') {
        passed = true;
      } else if (status === 'blocked' || status === 'failed' || status === 'fail' || status === 'rejected') {
        rejected = true;
      }
      evidenceRefs.push(...uniqueStrings(stage?.evidenceRefs));
      if (!degradedReason && typeof stage?.degradedReason === 'string' && stage.degradedReason.trim()) {
        degradedReason = stage.degradedReason.trim();
      }
    }
  }

  return classifyGpuHmrFissionProof({
    required: observed,
    observed,
    passed: observed && passed && !rejected,
    rejected,
    degradedReason,
    evidenceRefs: uniqueStrings(evidenceRefs),
    stageStatuses: uniqueStrings(stageStatuses),
  });
}

function runtimeTransportValues(runtimeEvidence, camelName, snakeName) {
  const values = runtimeEvidence?.[camelName] ?? runtimeEvidence?.[snakeName];
  return Array.isArray(values) ? values : [];
}

export function artifactTransportProofFromProofArtifacts(records, runtimeEvidence = null) {
  const evidenceRefs = [];
  const loaderTransports = [];
  const reloadRequestTransports = [];
  let transportEvidenceObserved = false;
  let ramArtifactReferenceProvided = false;
  let ramTransportProven = false;
  let degradedState = null;
  let degradedReason = null;

  for (const record of Array.isArray(records) ? records : []) {
    const artifact = record?.artifact;
    if (!artifact || typeof artifact !== 'object') continue;

    const artifactEvidenceRefs = Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : [];
    for (const evidence of artifactEvidenceRefs) {
      if (evidence?.kind !== 'device-artifact-transport') continue;
      const metadata = evidence?.metadata;
      if (metadata?.schemaVersion !== 'synthi.gpu.hmr.artifact_transport.v1') continue;

      transportEvidenceObserved = true;
      evidenceRefs.push(artifactTransportEvidenceId(evidence, artifact, record));
      loaderTransports.push(...uniqueStrings([metadata.selectedLoaderTransport]));
      reloadRequestTransports.push(...uniqueStrings(metadata.reloadRequestTransports));
      if (metadata.ramArtifactReferenceProvided === true) {
        ramArtifactReferenceProvided = true;
      }
      if (
        metadata.ramArtifactReferenceProvided === true
        && ['ram_bytes', 'ram_blob'].includes(String(metadata.selectedLoaderTransport ?? '').trim())
      ) {
        ramTransportProven = true;
      }
      if (!degradedState && typeof metadata.degradedState === 'string' && metadata.degradedState.trim()) {
        degradedState = metadata.degradedState.trim();
      }
      if (!degradedReason && typeof metadata.degradedReason === 'string' && metadata.degradedReason.trim()) {
        degradedReason = metadata.degradedReason.trim();
      }
    }

    const transportStage = artifactTransportStageFromArtifact(artifact);
    if (!degradedState && typeof transportStage?.degradedState === 'string' && transportStage.degradedState.trim()) {
      degradedState = transportStage.degradedState.trim();
    }
    if (!degradedReason && typeof transportStage?.degradedReason === 'string' && transportStage.degradedReason.trim()) {
      degradedReason = transportStage.degradedReason.trim();
    }
  }

  if (runtimeEvidence && typeof runtimeEvidence === 'object') {
    if (runtimeEvidence.transport_evidence_observed === true || runtimeEvidence.transportEvidenceObserved === true) {
      transportEvidenceObserved = true;
    }
    evidenceRefs.push(...uniqueStrings(runtimeTransportValues(runtimeEvidence, 'evidenceRefs', 'evidence_refs')));
    loaderTransports.push(...uniqueStrings(runtimeTransportValues(runtimeEvidence, 'loaderTransports', 'loader_transports')));
    reloadRequestTransports.push(...uniqueStrings(
      runtimeTransportValues(runtimeEvidence, 'reloadRequestTransports', 'reload_request_transports'),
    ));
    if (
      runtimeEvidence.ram_artifact_reference_provided === true
      || runtimeEvidence.ramArtifactReferenceProvided === true
    ) {
      ramArtifactReferenceProvided = true;
    }
    if (
      (runtimeEvidence.ram_transport_proven === true || runtimeEvidence.ramTransportProven === true)
      && (runtimeEvidence.ram_artifact_reference_provided === true
        || runtimeEvidence.ramArtifactReferenceProvided === true)
    ) {
      ramTransportProven = true;
    }
    const runtimeDegradedState = runtimeEvidence.degraded_state ?? runtimeEvidence.degradedState;
    const runtimeDegradedReason = runtimeEvidence.degraded_reason ?? runtimeEvidence.degradedReason;
    if (!ramTransportProven) {
      if (typeof runtimeDegradedState === 'string' && runtimeDegradedState.trim() && runtimeDegradedState !== 'none') {
        degradedState = runtimeDegradedState.trim();
      }
      if (typeof runtimeDegradedReason === 'string' && runtimeDegradedReason.trim() && runtimeDegradedReason !== 'none') {
        degradedReason = runtimeDegradedReason.trim();
      }
    }
  }

  return {
    schemaVersion: 'synthi.gpu.hmr.artifact_transport_proof.v1',
    transportEvidenceObserved,
    ramTransportProven,
    ramArtifactReferenceProvided,
    loaderTransports: uniqueStrings(loaderTransports),
    reloadRequestTransports: uniqueStrings(reloadRequestTransports),
    evidenceRefs: uniqueStrings(evidenceRefs),
    degradedState: ramTransportProven ? null : degradedState ?? 'gpu-hmr-ram-io-unavailable',
    degradedReason: ramTransportProven
      ? null
      : degradedReason ?? (transportEvidenceObserved
        ? 'ram_artifact_transport_not_proven'
        : 'artifact_transport_evidence_not_collected'),
  };
}

export function summarizeGpuHmrArtifactTransportProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_artifact_transport=missing';
  const state = proof.ramTransportProven ? 'ram-proven' : 'ram-unproven';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const loader = Array.isArray(proof.loaderTransports) && proof.loaderTransports.length
    ? ` loader=${proof.loaderTransports.join(',')}`
    : ' loader=unknown';
  const refs = Array.isArray(proof.evidenceRefs) ? ` evidence_refs=${proof.evidenceRefs.length}` : '';
  return `gpu_artifact_transport=${state}${degraded}${reason}${loader}${refs}`;
}
