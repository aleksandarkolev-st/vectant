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

function sourceEvidenceId(evidence, artifact, record, kind) {
  if (typeof evidence?.evidenceId === 'string' && evidence.evidenceId.trim()) {
    return evidence.evidenceId.trim();
  }
  return `${artifact?.proofId ?? record?.proofArtifactPath ?? 'gpu-hmr-proof-artifact'}:${kind}`;
}

function sourceStageFromArtifact(artifact, stageId) {
  const stages = Array.isArray(artifact?.stageResults) ? artifact.stageResults : [];
  return stages.find((stage) => String(stage?.stageId ?? '').trim().toLowerCase() === stageId);
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

function nonEmptyString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function nonEmptyStringArray(value) {
  return Array.isArray(value)
    ? uniqueStrings(value)
    : [];
}

function artifactSha256Digest(value) {
  return typeof value === 'string'
    ? value.trim().match(/^artifact:sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null
    : null;
}

function sha256Digest(value) {
  return typeof value === 'string'
    ? value.trim().match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null
    : null;
}

function stageEvidenceRefs(stage) {
  return new Set(nonEmptyStringArray(stage?.evidenceRefs));
}

function stagePassed(stage) {
  const status = String(stage?.status ?? '').trim().toLowerCase();
  return status === 'passed' || status === 'pass' || status === 'accepted';
}

function nonEmptyStringOrArray(value) {
  if (typeof value === 'string' && value.trim()) return true;
  return Array.isArray(value) && nonEmptyStringArray(value).length > 0;
}

function compileProvenanceComplete(metadata) {
  const provenance = metadata?.compileProvenance;
  if (!provenance || typeof provenance !== 'object' || Array.isArray(provenance)) return false;
  const requiredStringFields = [
    'compilerExecutable',
    'compilerIdentity',
    'deviceCompiler',
    'gpuVendor',
    'targetTriple',
    'sdkVersion',
    'sourceFilename',
    'compileCommandHash',
    'dependencyHash',
    'dependencyMethod',
    'artifactCacheKey',
  ];
  return requiredStringFields.every((field) => nonEmptyString(provenance[field]))
    && nonEmptyStringOrArray(provenance.gpuArch);
}

function finiteNonNegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function proofArtifactPath(record) {
  return nonEmptyString(record?.proofArtifactPath) ?? nonEmptyString(record?.containerPath);
}

export function sourceProofFromProofArtifacts(records, fallbackProof = null) {
  const proofArtifactPaths = [];
  const evidenceRefs = [];
  const compileEvidenceRefs = [];
  const symbolEvidenceRefs = [];
  const artifactIds = [];
  const selectedArtifactKinds = [];
  const requestedArtifactKinds = [];
  const degradedReasons = [];
  let compileProven = false;
  let symbolBindingProven = false;
  let compileEvidenceObserved = false;
  let symbolBindingEvidenceObserved = false;
  let partialArtifactReplacement = fallbackProof?.partialArtifactReplacement === true
    || fallbackProof?.partialModule === true;

  for (const record of Array.isArray(records) ? records : []) {
    const artifact = record?.artifact;
    if (!artifact || typeof artifact !== 'object') continue;
    const path = proofArtifactPath(record);
    if (path) proofArtifactPaths.push(path);

    const artifactEvidenceRefs = Array.isArray(artifact.evidenceRefs) ? artifact.evidenceRefs : [];
    const deviceArtifact = artifactEvidenceRefs.find((evidence) => evidence?.kind === 'device-artifact');
    const compilerOutput = artifactEvidenceRefs.find((evidence) => evidence?.kind === 'device-compiler-output');
    const symbolSet = artifactEvidenceRefs.find((evidence) => evidence?.kind === 'device-symbol-set');
    const deviceArtifactEvidenceId = sourceEvidenceId(deviceArtifact, artifact, record, 'device-artifact');
    const compilerEvidenceId = sourceEvidenceId(compilerOutput, artifact, record, 'device-compiler-output');
    const symbolEvidenceId = sourceEvidenceId(symbolSet, artifact, record, 'device-symbol-set');
    const compileStage = sourceStageFromArtifact(artifact, 'device-compile');
    const symbolStage = sourceStageFromArtifact(artifact, 'symbol-binding');
    const compileStageRefs = stageEvidenceRefs(compileStage);
    const symbolStageRefs = stageEvidenceRefs(symbolStage);

    const artifactDigest = artifactSha256Digest(deviceArtifact?.artifactUri);
    const artifactContentDigest = sha256Digest(deviceArtifact?.contentHash);
    const compilerContentDigest = sha256Digest(compilerOutput?.contentHash);
    const symbolArtifactDigest = artifactSha256Digest(symbolSet?.artifactUri);
    const symbolContentDigest = sha256Digest(symbolSet?.contentHash);
    const artifactBytes = deviceArtifact?.metadata?.artifactBytes;
    const compileMetadata = compilerOutput?.metadata;
    const symbolMetadata = symbolSet?.metadata;

    const artifactEvidenceValid =
      Boolean(deviceArtifact)
      && artifactDigest !== null
      && artifactDigest === artifactContentDigest
      && Number.isInteger(artifactBytes)
      && artifactBytes > 0;
    const compilerEvidenceValid =
      Boolean(compilerOutput)
      && compilerContentDigest !== null
      && finiteNonNegative(compileMetadata?.compilerElapsedMs)
      && finiteNonNegative(compileMetadata?.stderrBytes)
      && compileProvenanceComplete(compileMetadata);
    const compileStageLinked =
      stagePassed(compileStage)
      && compileStageRefs.has(deviceArtifactEvidenceId)
      && compileStageRefs.has(compilerEvidenceId)
      && Array.isArray(compileStage?.outputArtifactIds)
      && compileStage.outputArtifactIds.includes(deviceArtifact?.artifactUri);
    const compileRecordProven = artifactEvidenceValid && compilerEvidenceValid && compileStageLinked;

    if (deviceArtifact || compilerOutput || compileStage) compileEvidenceObserved = true;
    if (compileRecordProven) {
      compileProven = true;
      compileEvidenceRefs.push(deviceArtifactEvidenceId, compilerEvidenceId);
      evidenceRefs.push(deviceArtifactEvidenceId, compilerEvidenceId);
      artifactIds.push(deviceArtifact.artifactUri);
    } else if (!compileProven) {
      if (!artifactEvidenceValid) degradedReasons.push('device_artifact_evidence_unverified');
      if (!compilerEvidenceValid) degradedReasons.push('device_compiler_evidence_unverified');
      if (!compileStageLinked) degradedReasons.push('device_compile_stage_not_linked');
    }

    if (deviceArtifact?.metadata?.partialModule === true) {
      partialArtifactReplacement = true;
    }
    selectedArtifactKinds.push(...uniqueStrings([deviceArtifact?.metadata?.selectedArtifactKind]));
    requestedArtifactKinds.push(...uniqueStrings([deviceArtifact?.metadata?.requestedArtifactKind]));

    const targetSymbols = nonEmptyStringArray(symbolMetadata?.targetSymbols);
    const exportedSymbols = nonEmptyStringArray(symbolMetadata?.artifactExportedSymbols);
    const symbolEvidenceValid =
      Boolean(symbolSet)
      && symbolArtifactDigest !== null
      && artifactDigest !== null
      && symbolArtifactDigest === artifactDigest
      && symbolContentDigest !== null
      && symbolMetadata?.symbolBound === true
      && targetSymbols.length > 0
      && exportedSymbols.length > 0;
    const symbolStageLinked =
      stagePassed(symbolStage)
      && symbolStageRefs.has(symbolEvidenceId)
      && Array.isArray(symbolStage?.outputArtifactIds)
      && symbolStage.outputArtifactIds.includes(symbolSet?.artifactUri);
    const symbolRecordProven = compileRecordProven && symbolEvidenceValid && symbolStageLinked;

    if (symbolSet || symbolStage) symbolBindingEvidenceObserved = true;
    if (symbolRecordProven) {
      symbolBindingProven = true;
      symbolEvidenceRefs.push(symbolEvidenceId);
      evidenceRefs.push(symbolEvidenceId);
    } else if (compileRecordProven && !symbolBindingProven) {
      if (!symbolEvidenceValid) degradedReasons.push('device_symbol_evidence_unverified');
      if (!symbolStageLinked) degradedReasons.push('symbol_binding_stage_not_linked');
    }
  }

  const fallbackLabel = nonEmptyString(fallbackProof?.label ?? fallbackProof?.resultLabel);
  const fallbackSelectedKind = nonEmptyString(
    fallbackProof?.selectedArtifactKind ?? fallbackProof?.artifactKind,
  );
  const fallbackRequestedKind = nonEmptyString(fallbackProof?.requestedArtifactKind);
  if (fallbackSelectedKind) selectedArtifactKinds.push(fallbackSelectedKind);
  if (fallbackRequestedKind) requestedArtifactKinds.push(fallbackRequestedKind);

  const resultState = symbolBindingProven
    ? 'gpu-hmr-symbol-bound'
    : compileProven
      ? 'gpu-hmr-compile-proven'
      : null;
  const degradedReason = resultState
    ? symbolBindingProven
      ? null
      : uniqueStrings(degradedReasons)[0] ?? 'symbol_binding_evidence_not_collected'
    : uniqueStrings(degradedReasons)[0] ?? (compileEvidenceObserved
      ? 'compile_evidence_unverified'
      : 'compile_evidence_not_collected');

  return {
    schemaVersion: 'synthi.gpu.hmr.source_proof.v1',
    resultState,
    degradedState: null,
    degradedReason,
    compileEvidenceObserved,
    compileProven,
    symbolBindingEvidenceObserved,
    symbolBindingProven,
    sourceProofProven: symbolBindingProven,
    proofArtifactPaths: uniqueStrings(proofArtifactPaths),
    artifactIds: uniqueStrings(artifactIds),
    evidenceRefs: uniqueStrings(evidenceRefs),
    compileEvidenceRefs: uniqueStrings(compileEvidenceRefs),
    symbolEvidenceRefs: uniqueStrings(symbolEvidenceRefs),
    partialArtifactReplacement,
    partialModule: partialArtifactReplacement,
    label: fallbackLabel,
    selectedArtifactKind: uniqueStrings(selectedArtifactKinds)[0] ?? null,
    requestedArtifactKind: uniqueStrings(requestedArtifactKinds)[0] ?? null,
  };
}

export function summarizeGpuHmrSourceProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_source_proof=missing';
  const state = proof.resultState ?? 'unproven';
  const compile = proof.compileProven ? 'compile=proven' : 'compile=unproven';
  const symbol = proof.symbolBindingProven ? 'symbol=proven' : 'symbol=unproven';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const refs = Array.isArray(proof.evidenceRefs) ? ` evidence_refs=${proof.evidenceRefs.length}` : '';
  return `gpu_source_proof=${state} ${compile} ${symbol}${reason}${refs}`;
}

function fissionReportPassIntegrity(metadata) {
  if (!metadata || typeof metadata !== 'object') {
    return { proven: false, reason: 'fission_verifier_report_missing' };
  }
  if (metadata.schemaVersion !== 'synthi.gpu.fission_verifier.v1') {
    return { proven: false, reason: 'fission_verifier_schema_unverified' };
  }
  const status = String(metadata.status ?? '').trim().toLowerCase();
  if (status !== 'pass' && status !== 'passed' && status !== 'accepted') {
    return { proven: false, reason: 'fission_candidate_verifier_rejected' };
  }
  const acceptedCount = Number.isInteger(metadata.acceptedCount) ? metadata.acceptedCount : null;
  const candidateCount = Number.isInteger(metadata.candidateCount) ? metadata.candidateCount : null;
  if (acceptedCount === null || acceptedCount <= 0 || candidateCount === null || candidateCount < acceptedCount) {
    return { proven: false, reason: 'fission_accepted_candidate_count_unverified' };
  }
  const selectedIslandId = nonEmptyString(metadata.selectedIslandId);
  if (!selectedIslandId || selectedIslandId.toLowerCase() === 'none') {
    return { proven: false, reason: 'fission_selected_island_unverified' };
  }
  if (!Number.isInteger(metadata.selectedCandidateIndex) || metadata.selectedCandidateIndex < 0) {
    return { proven: false, reason: 'fission_selected_candidate_index_unverified' };
  }
  const candidates = Array.isArray(metadata.candidates) ? metadata.candidates : [];
  const selectedCandidate = candidates[metadata.selectedCandidateIndex];
  if (!selectedCandidate || typeof selectedCandidate !== 'object') {
    return { proven: false, reason: 'fission_selected_candidate_missing' };
  }
  const candidateStatus = String(selectedCandidate.status ?? '').trim().toLowerCase();
  if (candidateStatus !== 'pass' && candidateStatus !== 'passed' && candidateStatus !== 'accepted') {
    return { proven: false, reason: 'fission_selected_candidate_not_verified' };
  }
  if (selectedCandidate.selected !== true) {
    return { proven: false, reason: 'fission_selected_candidate_marker_missing' };
  }
  if (nonEmptyString(selectedCandidate.islandId) !== selectedIslandId) {
    return { proven: false, reason: 'fission_selected_candidate_identity_mismatch' };
  }
  if (!nonEmptyString(selectedCandidate.verifierEvidenceId)) {
    return { proven: false, reason: 'fission_selected_candidate_verifier_evidence_missing' };
  }
  if (nonEmptyStringArray(selectedCandidate.deterministicVerifierEvidenceIds).length === 0) {
    return { proven: false, reason: 'fission_selected_candidate_deterministic_evidence_missing' };
  }
  const coverage = selectedCandidate.verificationEvidenceCoverage;
  const missingCategories = Array.isArray(coverage?.missingCategories)
    ? coverage.missingCategories
    : null;
  if (!Array.isArray(missingCategories) || missingCategories.length > 0) {
    return { proven: false, reason: 'fission_selected_candidate_evidence_coverage_incomplete' };
  }
  const narrowerCoverage = selectedCandidate.narrowerRejectionCoverage;
  const missingRanks = Array.isArray(narrowerCoverage?.missingRanks)
    ? narrowerCoverage.missingRanks
    : null;
  if (!Array.isArray(missingRanks) || missingRanks.length > 0) {
    return { proven: false, reason: 'fission_selected_candidate_narrower_coverage_incomplete' };
  }
  const reasonCodes = nonEmptyStringArray(selectedCandidate.reasonCodes);
  if (!reasonCodes.includes('fission.candidate_verified')) {
    return { proven: false, reason: 'fission_selected_candidate_verified_code_missing' };
  }
  return { proven: true, reason: null };
}

export function abiProofFromProofArtifacts(records) {
  const evidenceRefs = [];
  const acceptedExtractorEvidenceRefs = [];
  const acceptedExtractorSources = [];
  const extractorProvenance = [];
  const kernelAbiFingerprintHashes = [];
  const constantGlobalLayoutHashes = [];
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
      kernelAbiFingerprintHashes.push(...uniqueStrings([
        metadata.kernelAbiFingerprintHash,
        ...(Array.isArray(metadata.kernelAbiFingerprintHashes)
          ? metadata.kernelAbiFingerprintHashes
          : []),
      ]));
      constantGlobalLayoutHashes.push(...uniqueStrings([
        metadata.constantGlobalLayoutHash,
        ...(Array.isArray(metadata.constantGlobalLayoutHashes)
          ? metadata.constantGlobalLayoutHashes
          : []),
      ]));
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
    kernelAbiFingerprintHashes: uniqueStrings(kernelAbiFingerprintHashes),
    constantGlobalLayoutHashes: uniqueStrings(constantGlobalLayoutHashes),
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
  let structuredPassObserved = false;

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
        const integrity = fissionReportPassIntegrity(metadata);
        if (integrity.proven) {
          structuredPassObserved = true;
          passed = true;
        } else {
          rejected = true;
          if (!degradedReason) degradedReason = integrity.reason;
        }
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
        if (!structuredPassObserved) {
          rejected = true;
          if (!degradedReason) {
            degradedReason = 'fission_structured_verifier_report_not_proven';
          }
        }
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
    passed: observed && structuredPassObserved && passed && !rejected,
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
