export const GPU_HMR_PROOF_SCHEMA_VERSION = 'synthi.gpu.hmr.proof.v1';

export const GPU_HMR_PROOF_STATES = [
  'gpu-hmr-compile-proven',
  'gpu-hmr-symbol-bound',
  'gpu-hmr-abi-proven',
  'gpu-hmr-epoch-swap-proven',
  'gpu-hmr-dispatch-observed',
  'gpu-hmr-dispatch-safe-proven',
  'gpu-hmr-output-oracle-proven',
  'gpu-hmr-host-preservation-proven',
  'gpu-hmr-full-runtime-proven',
];

const GPU_HMR_PROOF_STATE_RANKS = new Map(
  GPU_HMR_PROOF_STATES.map((state, index) => [state, index + 1]),
);

const GPU_HMR_DEGRADED_STATE_RANK_CAPS = new Map([
  ['gpu-hmr-fake-launch-path', proofStateRank('gpu-hmr-symbol-bound')],
  ['gpu-hmr-unknown-arg-provenance', proofStateRank('gpu-hmr-dispatch-observed')],
  ['gpu-hmr-abi-unverified', proofStateRank('gpu-hmr-symbol-bound')],
  ['gpu-hmr-dispatch-unobserved', proofStateRank('gpu-hmr-epoch-swap-proven')],
  ['gpu-hmr-output-unobserved', proofStateRank('gpu-hmr-dispatch-safe-proven')],
  ['gpu-hmr-host-replaced', proofStateRank('gpu-hmr-output-oracle-proven')],
  ['gpu-hmr-epoch-retirement-pending', proofStateRank('gpu-hmr-abi-proven')],
  ['gpu-hmr-epoch-swap-unverified', proofStateRank('gpu-hmr-abi-proven')],
  ['gpu-hmr-ram-io-unavailable', proofStateRank('gpu-hmr-epoch-swap-proven')],
  ['gpu-hmr-visual-only', proofStateRank('gpu-hmr-dispatch-safe-proven')],
]);

const ACCEPTED_ABI_EXTRACTOR_KINDS = new Set([
  'clang_ast',
  'clang_record_layout',
  'compiled_artifact_symbol_table',
  'compiler_invocation_metadata',
  'runtime_wrapper_instrumentation',
]);

function proofStateRank(state) {
  return typeof state === 'string' ? GPU_HMR_PROOF_STATE_RANKS.get(state) ?? 0 : 0;
}

function degradedStateRankCap(state) {
  if (state === null || state === undefined || state === '') return null;
  return typeof state === 'string' ? GPU_HMR_DEGRADED_STATE_RANK_CAPS.get(state) ?? 0 : 0;
}

function effectiveProofRank(proof) {
  const resultRank = proofStateRank(proof?.resultState);
  const cap = degradedStateRankCap(proof?.degradedState);
  return cap === null ? resultRank : Math.min(resultRank, cap);
}

function highestEffectiveProof(proofs) {
  let best = null;
  for (const proof of proofs) {
    const effectiveRank = effectiveProofRank(proof);
    if (effectiveRank > (best?.effectiveRank ?? 0)) {
      best = { proof, effectiveRank };
    }
  }
  return best ?? { proof: null, effectiveRank: 0 };
}

function proofMeets(proof, requiredState) {
  return effectiveProofRank(proof) >= proofStateRank(requiredState);
}

function compactStringList(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
    : [];
}

function runtimeSessionIdsFromObservation(observation = {}) {
  return compactStringList([
    observation.runtimeSessionId,
    observation.currentRuntimeSessionId,
    ...(Array.isArray(observation.runtimeSessionIds) ? observation.runtimeSessionIds : []),
    ...(Array.isArray(observation.currentRuntimeSessionIds) ? observation.currentRuntimeSessionIds : []),
  ]);
}

function acceptedAbiExtractorEvidence(observation = {}) {
  const explicitRefs = compactStringList(observation.acceptedExtractorEvidenceRefs);
  if (explicitRefs.length > 0) {
    return {
      accepted: true,
      refs: explicitRefs,
      sources: compactStringList(observation.acceptedExtractorSources),
    };
  }

  const extractorRecords = Array.isArray(observation.extractorProvenance)
    ? observation.extractorProvenance.filter((record) => record && typeof record === 'object')
    : [];
  const acceptedRecords = extractorRecords.filter((record) => {
    const kind = String(record.kind ?? record.extractorKind ?? '').trim();
    const evidenceId = String(record.evidenceId ?? '').trim();
    const explicitlyRejected = record.acceptedByRuntimeCorrectnessPlan === false;
    return ACCEPTED_ABI_EXTRACTOR_KINDS.has(kind) && evidenceId && !explicitlyRejected;
  });

  return {
    accepted: acceptedRecords.length > 0,
    refs: acceptedRecords.map((record) => String(record.evidenceId).trim()),
    sources: acceptedRecords.map((record) => String(record.kind ?? record.extractorKind).trim()),
  };
}

function stageResult(stageId, requiredState, evidenceRank, evidenceProof, degradedState, degradedReason) {
  const requiredRank = proofStateRank(requiredState);
  const passed = evidenceRank >= requiredRank;
  return {
    stageId,
    requiredState,
    status: passed ? 'passed' : 'blocked',
    observedState: evidenceProof?.resultState ?? null,
    effectiveRank: evidenceRank,
    degradedState: passed ? null : degradedState ?? evidenceProof?.degradedState ?? null,
    degradedReason: passed ? null : degradedReason ?? evidenceProof?.degradedReason ?? null,
  };
}

export function classifyGpuHmrOutputProof(observation = {}) {
  const dispatchProof = observation.dispatchProof && typeof observation.dispatchProof === 'object'
    ? observation.dispatchProof
    : null;
  const dispatchUsable = dispatchProof
    ? proofMeets(dispatchProof, 'gpu-hmr-dispatch-safe-proven')
    : observation.dispatchSafeProven === true;
  const rawOracle = observation.outputOracle && typeof observation.outputOracle === 'object'
    ? observation.outputOracle
    : {};
  const hasExpected = Object.prototype.hasOwnProperty.call(rawOracle, 'expected');
  const hasActual = Object.prototype.hasOwnProperty.call(rawOracle, 'actual');
  const oracleKind = typeof rawOracle.kind === 'string' && rawOracle.kind.trim()
    ? rawOracle.kind.trim()
    : null;
  const oracleEvidenceRefs = Array.isArray(rawOracle.evidenceRefs)
    ? rawOracle.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const deterministicOutputObserved = observation.deterministicOutputObserved === true && hasActual;
  const deterministicOracleProvided = observation.deterministicOracleProvided === true && oracleKind !== null && hasExpected;
  const deterministicOraclePassed =
    deterministicOutputObserved && deterministicOracleProvided && observation.deterministicOraclePassed === true;
  const outputOracle = {
    provided: deterministicOracleProvided,
    observed: deterministicOutputObserved,
    passed: deterministicOraclePassed,
    kind: oracleKind,
    expected: hasExpected ? rawOracle.expected : null,
    actual: hasActual ? rawOracle.actual : null,
    tolerance: Object.prototype.hasOwnProperty.call(rawOracle, 'tolerance') ? rawOracle.tolerance : null,
    evidenceRefs: oracleEvidenceRefs,
  };
  const visualFrameObserved = observation.visualFrameObserved === true;
  const evidenceRefs = Array.isArray(observation.evidenceRefs)
    ? observation.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const visualEvidenceRefs = Array.isArray(observation.visualEvidenceRefs)
    ? observation.visualEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];

  if (!dispatchUsable) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: dispatchProof?.resultState ?? null,
      degradedState: dispatchProof?.degradedState ?? 'gpu-hmr-dispatch-unobserved',
      degradedReason: dispatchProof?.degradedReason ?? 'runtime_dispatch_not_observed',
      outputOracle: { ...outputOracle, passed: false },
      visualFrameObserved,
      evidenceRefs,
      visualEvidenceRefs,
      dispatchProof,
    };
  }

  if (deterministicOraclePassed) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-output-oracle-proven',
      degradedState: null,
      degradedReason: null,
      outputOracle,
      visualFrameObserved,
      evidenceRefs,
      visualEvidenceRefs,
      dispatchProof,
    };
  }

  const degradedState = visualFrameObserved
    ? 'gpu-hmr-visual-only'
    : 'gpu-hmr-output-unobserved';
  const degradedReason = visualFrameObserved
    ? 'visual_frame_without_deterministic_output_oracle'
    : 'output_oracle_not_collected';

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: dispatchProof?.resultState ?? 'gpu-hmr-dispatch-safe-proven',
    degradedState,
    degradedReason,
    outputOracle: { ...outputOracle, passed: false },
    visualFrameObserved,
    evidenceRefs,
    visualEvidenceRefs,
    dispatchProof,
  };
}

export function summarizeGpuHmrOutputProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_output_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const oracle = proof.outputOracle
    ? ` oracle=${proof.outputOracle.passed ? 'passed' : proof.outputOracle.provided ? 'failed' : 'missing'}`
    : '';
  const visual = proof.visualFrameObserved ? ' visual=fresh-frame' : ' visual=none';
  return `gpu_output_proof=${result}${degraded}${reason}${oracle}${visual}`;
}

export function classifyGpuHmrDispatchProof(observation = {}) {
  const dispatchObserved = observation.dispatchObserved === true;
  const dispatchFailureObserved = observation.dispatchFailureObserved === true;
  const requestedSessionScoped =
    observation.sessionScoped === true
    || observation.currentSessionScoped === true
    || observation.runtimeSessionScoped === true;
  const runtimeSessionIds = runtimeSessionIdsFromObservation(observation);
  const runtimeSessionObserved = observation.runtimeSessionObserved === true || runtimeSessionIds.length > 0;
  const sessionScoped = requestedSessionScoped && runtimeSessionObserved;
  const runtimeSessionConsistent =
    observation.runtimeSessionConsistent !== false && runtimeSessionIds.length <= 1;
  const argProvenanceObserved = observation.argProvenanceObserved === true;
  const argProvenanceComplete = observation.argProvenanceComplete === true;
  const unknownArgCount = Number.isFinite(observation.unknownArgCount)
    ? Math.max(0, Number(observation.unknownArgCount))
    : 0;
  const abiProof = observation.abiProof && typeof observation.abiProof === 'object'
    ? observation.abiProof
    : null;
  const epochProof = observation.epochProof && typeof observation.epochProof === 'object'
    ? observation.epochProof
    : null;
  const abiProven = observation.abiProven === true || proofMeets(abiProof, 'gpu-hmr-abi-proven');
  const epochSwapProven =
    observation.epochSwapProven === true || proofMeets(epochProof, 'gpu-hmr-epoch-swap-proven');
  const streamOrderingProven = observation.streamOrderingProven === true;
  const replacementScopeProven = observation.replacementScopeProven === true;
  const runtimeTouchedSymbolsMatch = observation.runtimeTouchedSymbolsMatch !== false;
  const runtimeArtifactMatchesSelected = observation.runtimeArtifactMatchesSelected !== false;

  if (!dispatchObserved || dispatchFailureObserved || !sessionScoped || !runtimeSessionConsistent) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: null,
      degradedState: 'gpu-hmr-dispatch-unobserved',
      degradedReason: dispatchFailureObserved
        ? 'current_session_dispatch_failed'
        : !sessionScoped
          ? requestedSessionScoped && !runtimeSessionObserved
            ? 'runtime_session_identity_not_collected'
            : 'current_session_dispatch_not_proven'
          : !runtimeSessionConsistent
            ? 'runtime_session_identity_inconsistent'
            : 'runtime_dispatch_not_observed',
      dispatchObserved: false,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved,
      argProvenanceComplete: false,
      unknownArgCount,
    };
  }

  if (!argProvenanceObserved || !argProvenanceComplete || unknownArgCount > 0) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-unknown-arg-provenance',
      degradedReason: argProvenanceObserved
        ? 'launch_argument_provenance_incomplete'
        : 'launch_argument_provenance_not_collected',
      dispatchObserved: true,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved,
      argProvenanceComplete: false,
      unknownArgCount,
    };
  }

  if (!abiProven) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-abi-unverified',
      degradedReason: abiProof?.degradedReason ?? 'dispatch_abi_proof_not_collected',
      dispatchObserved: true,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
      abiProven: false,
      epochSwapProven,
      streamOrderingProven,
      replacementScopeProven,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
    };
  }

  if (!epochSwapProven || !streamOrderingProven || !replacementScopeProven) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-epoch-swap-unverified',
      degradedReason: !epochSwapProven
        ? 'dispatch_epoch_swap_proof_not_collected'
        : !streamOrderingProven
          ? 'dispatch_stream_ordering_proof_not_collected'
          : 'dispatch_replacement_scope_proof_not_collected',
      dispatchObserved: true,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
      abiProven: true,
      epochSwapProven,
      streamOrderingProven,
      replacementScopeProven,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
    };
  }

  if (!runtimeTouchedSymbolsMatch || !runtimeArtifactMatchesSelected) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-epoch-swap-unverified',
      degradedReason: !runtimeTouchedSymbolsMatch
        ? 'runtime_touched_symbols_do_not_match_selected_artifact'
        : 'runtime_artifact_does_not_match_selected_artifact',
      dispatchObserved: true,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      unknownArgCount: 0,
      abiProven: true,
      epochSwapProven: true,
      streamOrderingProven: true,
      replacementScopeProven: true,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: 'gpu-hmr-dispatch-safe-proven',
    degradedState: null,
    degradedReason: null,
    dispatchObserved: true,
    sessionScoped,
    runtimeSessionObserved,
    runtimeSessionIds,
    runtimeSessionConsistent,
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    unknownArgCount: 0,
    abiProven: true,
    epochSwapProven: true,
    streamOrderingProven: true,
    replacementScopeProven: true,
    runtimeTouchedSymbolsMatch: true,
    runtimeArtifactMatchesSelected: true,
  };
}

export function summarizeGpuHmrDispatchProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_dispatch_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const dispatch = proof.dispatchObserved ? ' dispatch=observed' : ' dispatch=missing';
  const session = proof.sessionScoped ? ' session=current' : ' session=unproven';
  const provenance = proof.argProvenanceObserved
    ? ` provenance=${proof.argProvenanceComplete ? 'complete' : 'incomplete'}`
    : ' provenance=missing';
  const gates = proof.resultState === 'gpu-hmr-dispatch-safe-proven'
    ? ' safety=passed'
    : ` safety=blocked abi=${proof.abiProven === true ? 'passed' : 'missing'} epoch=${proof.epochSwapProven === true ? 'passed' : 'missing'} stream=${proof.streamOrderingProven === true ? 'passed' : 'missing'} scope=${proof.replacementScopeProven === true ? 'passed' : 'missing'}`;
  const unknown = Number.isFinite(proof.unknownArgCount) ? ` unknown_args=${proof.unknownArgCount}` : '';
  return `gpu_dispatch_proof=${result}${degraded}${reason}${dispatch}${session}${provenance}${gates}${unknown}`;
}

export function classifyGpuHmrAbiProof(observation = {}) {
  const evidenceRefs = Array.isArray(observation.evidenceRefs)
    ? observation.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const metadataObserved = observation.metadataObserved === true || evidenceRefs.length > 0;
  const layoutSizeAlignmentVerified = observation.layoutSizeAlignmentVerified === true;
  const acceptedExtractor = acceptedAbiExtractorEvidence(observation);
  const acceptedExtractorProvenanceObserved = acceptedExtractor.accepted;
  const extractorProvenanceComplete = observation.extractorProvenanceComplete !== false;

  if (layoutSizeAlignmentVerified && acceptedExtractorProvenanceObserved && extractorProvenanceComplete) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-abi-proven',
      degradedState: null,
      degradedReason: null,
      layoutSizeAlignmentVerified: true,
      metadataObserved,
      acceptedExtractorProvenanceObserved: true,
      acceptedExtractorEvidenceRefs: acceptedExtractor.refs,
      acceptedExtractorSources: acceptedExtractor.sources,
      evidenceRefs,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: metadataObserved ? 'gpu-hmr-symbol-bound' : null,
    degradedState: 'gpu-hmr-abi-unverified',
    degradedReason: metadataObserved
      ? (typeof observation.degradedReason === 'string' && observation.degradedReason.trim()
        ? observation.degradedReason.trim()
        : !layoutSizeAlignmentVerified
          ? 'abi_layout_size_alignment_unverified'
          : !acceptedExtractorProvenanceObserved
            ? 'abi_extractor_provenance_unverified'
            : 'abi_extractor_provenance_incomplete')
      : 'abi_evidence_not_collected',
    layoutSizeAlignmentVerified,
    metadataObserved,
    acceptedExtractorProvenanceObserved,
    acceptedExtractorEvidenceRefs: acceptedExtractor.refs,
    acceptedExtractorSources: acceptedExtractor.sources,
    evidenceRefs,
  };
}

export function summarizeGpuHmrAbiProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_abi_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const metadata = proof.metadataObserved ? ' metadata=observed' : ' metadata=missing';
  const layout = proof.layoutSizeAlignmentVerified ? ' layout=verified' : ' layout=unverified';
  const extractor = proof.acceptedExtractorProvenanceObserved ? ' extractor=accepted' : ' extractor=unverified';
  return `gpu_abi_proof=${result}${degraded}${reason}${metadata}${layout}${extractor}`;
}

export function classifyGpuHmrEpochSwapProof(observation = {}) {
  const published = observation.published === true || observation.epochPublished === true;
  const generationLineageObserved = observation.generationLineageObserved === true;
  const dispatchTableHashObserved = observation.dispatchTableHashObserved === true;
  const changedEntriesObserved = observation.changedEntriesObserved === true;
  const retirementTracked = observation.retirementTracked === true;
  const oldGenerationRetired = observation.oldGenerationRetired === true;
  const evidenceRefs = compactStringList(observation.evidenceRefs);

  if (
    published
    && generationLineageObserved
    && dispatchTableHashObserved
    && changedEntriesObserved
    && retirementTracked
    && oldGenerationRetired
  ) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-epoch-swap-proven',
      degradedState: null,
      degradedReason: null,
      published: true,
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      changedEntriesObserved: true,
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs,
    };
  }

  const partialEpochObserved =
    published && generationLineageObserved && dispatchTableHashObserved && changedEntriesObserved && retirementTracked;
  if (partialEpochObserved && !oldGenerationRetired) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-epoch-swap-proven',
      degradedState: 'gpu-hmr-epoch-retirement-pending',
      degradedReason: 'old_generation_retirement_not_completed',
      published: true,
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      changedEntriesObserved: true,
      retirementTracked: true,
      oldGenerationRetired: false,
      evidenceRefs,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: published ? 'gpu-hmr-abi-proven' : null,
    degradedState: 'gpu-hmr-epoch-swap-unverified',
    degradedReason: !published
      ? 'epoch_publication_not_observed'
      : !generationLineageObserved
        ? 'epoch_generation_lineage_not_collected'
        : !dispatchTableHashObserved
          ? 'epoch_dispatch_table_hash_not_collected'
          : !changedEntriesObserved
            ? 'epoch_changed_entries_not_collected'
            : 'epoch_retirement_tracking_not_collected',
    published,
    generationLineageObserved,
    dispatchTableHashObserved,
    changedEntriesObserved,
    retirementTracked,
    oldGenerationRetired,
    evidenceRefs,
  };
}

export function summarizeGpuHmrEpochSwapProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_epoch_swap_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const publication = proof.published ? ' published=yes' : ' published=no';
  const retired = proof.oldGenerationRetired ? ' retired=yes' : ' retired=no';
  return `gpu_epoch_swap_proof=${result}${degraded}${reason}${publication}${retired}`;
}

export function classifyGpuHmrHostPreservationProof(observation = {}) {
  const hostReplacementObserved =
    observation.hostReplacementObserved === true || observation.hostRestartObserved === true;
  const identityChecksPassed = observation.identityChecksPassed === true;
  const identityEvidenceRefs = Array.isArray(observation.identityEvidenceRefs)
    ? observation.identityEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];

  if (hostReplacementObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: null,
      degradedState: 'gpu-hmr-host-replaced',
      degradedReason: 'host_runtime_replaced_or_restarted',
      identityChecksPassed: false,
      identityEvidenceRefs,
    };
  }

  if (identityChecksPassed) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-host-preservation-proven',
      degradedState: null,
      degradedReason: null,
      identityChecksPassed: true,
      identityEvidenceRefs,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: null,
    degradedState: null,
    degradedReason: 'host_identity_checks_not_collected',
    identityChecksPassed: false,
    identityEvidenceRefs,
  };
}

export function summarizeGpuHmrHostPreservationProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_host_preservation_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const identity = proof.identityChecksPassed ? ' identity=passed' : ' identity=missing';
  return `gpu_host_preservation_proof=${result}${degraded}${reason}${identity}`;
}

export function classifyGpuHmrFullRuntimeProof(observation = {}) {
  const sourceProofs = Array.isArray(observation.sourceProofs)
    ? observation.sourceProofs.filter((proof) => proof && typeof proof === 'object')
    : observation.sourceProof && typeof observation.sourceProof === 'object'
      ? [observation.sourceProof]
      : [];
  const source = highestEffectiveProof(sourceProofs);
  const outputProof = observation.outputProof && typeof observation.outputProof === 'object'
    ? observation.outputProof
    : null;
  const hostPreservationProof =
    observation.hostPreservationProof && typeof observation.hostPreservationProof === 'object'
      ? observation.hostPreservationProof
      : null;
  const abiProof = observation.abiProof && typeof observation.abiProof === 'object'
    ? observation.abiProof
    : classifyGpuHmrAbiProof({});
  const epochProof = observation.epochProof && typeof observation.epochProof === 'object'
    ? observation.epochProof
    : classifyGpuHmrEpochSwapProof({});
  const outputRank = effectiveProofRank(outputProof);
  const hostRank = effectiveProofRank(hostPreservationProof);
  const abiRank = effectiveProofRank(abiProof);
  const epochRank = effectiveProofRank(epochProof);
  const embeddedDispatchProof =
    outputProof?.dispatchProof && typeof outputProof.dispatchProof === 'object'
      ? outputProof.dispatchProof
      : null;
  const dispatchProof = observation.dispatchProof && typeof observation.dispatchProof === 'object'
    ? observation.dispatchProof
    : embeddedDispatchProof ?? classifyGpuHmrDispatchProof({});
  const dispatchRank = effectiveProofRank(dispatchProof);
  const stages = [
    stageResult(
      'compile',
      'gpu-hmr-compile-proven',
      source.effectiveRank,
      source.proof,
      null,
      'compile_evidence_not_collected',
    ),
    stageResult(
      'symbol-binding',
      'gpu-hmr-symbol-bound',
      source.effectiveRank,
      source.proof,
      null,
      'symbol_binding_evidence_not_collected',
    ),
    stageResult(
      'abi',
      'gpu-hmr-abi-proven',
      abiRank,
      abiProof,
      abiProof?.degradedState ?? 'gpu-hmr-abi-unverified',
      abiProof?.degradedReason ?? 'abi_evidence_not_collected',
    ),
    stageResult(
      'epoch-swap',
      'gpu-hmr-epoch-swap-proven',
      epochRank,
      epochProof,
      epochProof?.degradedState ?? 'gpu-hmr-epoch-swap-unverified',
      epochProof?.degradedReason ?? 'epoch_swap_evidence_not_collected',
    ),
    stageResult(
      'dispatch-observed',
      'gpu-hmr-dispatch-observed',
      dispatchRank,
      dispatchProof,
      dispatchProof?.degradedState ?? 'gpu-hmr-dispatch-unobserved',
      dispatchProof?.degradedReason ?? 'runtime_dispatch_not_observed',
    ),
    stageResult(
      'dispatch-safe',
      'gpu-hmr-dispatch-safe-proven',
      dispatchRank,
      dispatchProof,
      dispatchProof?.degradedState ?? 'gpu-hmr-unknown-arg-provenance',
      dispatchProof?.degradedReason ?? 'dispatch_safety_evidence_not_collected',
    ),
    stageResult(
      'output',
      'gpu-hmr-output-oracle-proven',
      outputRank,
      outputProof,
      'gpu-hmr-output-unobserved',
      'output_oracle_not_collected',
    ),
    stageResult(
      'host-preservation',
      'gpu-hmr-host-preservation-proven',
      hostRank,
      hostPreservationProof,
      hostPreservationProof?.degradedState ?? null,
      'host_identity_checks_not_collected',
    ),
  ];

  let resultState = null;
  for (const stage of stages) {
    if (stage.status !== 'passed') break;
    resultState = stage.requiredState;
  }
  const firstBlocked = stages.find((stage) => stage.status !== 'passed') ?? null;
  const fullRuntimeProven = firstBlocked === null;
  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : resultState,
    degradedState: firstBlocked?.degradedState ?? null,
    degradedReason: firstBlocked?.degradedReason ?? null,
    fullRuntimeProven,
    stages,
    componentStates: {
      sourceEffectiveRank: source.effectiveRank,
      sourceResultState: source.proof?.resultState ?? null,
      abiEffectiveRank: abiRank,
      abiResultState: abiProof?.resultState ?? null,
      epochEffectiveRank: epochRank,
      epochResultState: epochProof?.resultState ?? null,
      dispatchEffectiveRank: dispatchRank,
      dispatchResultState: dispatchProof?.resultState ?? null,
      outputEffectiveRank: outputRank,
      outputResultState: outputProof?.resultState ?? null,
      hostEffectiveRank: hostRank,
      hostResultState: hostPreservationProof?.resultState ?? null,
    },
  };
}

export function summarizeGpuHmrFullRuntimeProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_full_runtime_proof=missing';
  const result = proof.resultState ? proof.resultState : 'missing';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const blocked = Array.isArray(proof.stages)
    ? proof.stages.filter((stage) => stage.status !== 'passed').map((stage) => stage.stageId)
    : [];
  const blockedSummary = blocked.length ? ` blocked=${blocked.join(',')}` : '';
  return `gpu_full_runtime_proof=${result}${degraded}${reason} full_runtime=${proof.fullRuntimeProven ? 'proven' : 'unproven'}${blockedSummary}`;
}
