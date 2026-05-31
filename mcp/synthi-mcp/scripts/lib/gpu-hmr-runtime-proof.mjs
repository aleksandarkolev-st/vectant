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
  ['gpu-hmr-visual-evidence-missing', proofStateRank('gpu-hmr-dispatch-safe-proven')],
  ['gpu-hmr-original-host-path-unattached', proofStateRank('gpu-hmr-host-preservation-proven')],
  ['gpu-hmr-fission-unverified', 0],
]);

const ACCEPTED_ABI_EXTRACTOR_KINDS = new Set([
  'clang_ast',
  'clang_record_layout',
  'compiled_artifact_symbol_table',
  'compiler_invocation_metadata',
  'runtime_wrapper_instrumentation',
]);

const ACCEPTED_OUTPUT_ORACLE_KINDS = new Set([
  'edit_contract',
  'sentinel_buffer_value',
  'kernel_checksum',
  'kernel_side_checksum',
  'render_target_hash',
  'accumulation_buffer_hash',
  'selected_pixels',
  'selected_pixel_values',
  'per_pass_checksum',
  'dispatch_counter',
  'buffer_checksum',
]);

export function gpuHmrOutputOracleKindAccepted(kind) {
  return typeof kind === 'string'
    && ACCEPTED_OUTPUT_ORACLE_KINDS.has(kind.trim().toLowerCase());
}

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

function streamScopeObserved(streamScope, streamIds) {
  if (streamScope === 'none') {
    return streamIds.length === 1 && streamIds[0] === 'none';
  }
  if (streamScope !== 'stream' && streamScope !== 'affected') return false;
  return streamIds.length > 0 && !streamIds.includes('none');
}

function integerValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && String(parsed) === value.trim() ? parsed : null;
}

function epochGraphGenerationId(generation) {
  return Number.isInteger(generation) && generation >= 0 ? `generation:${generation}` : null;
}

function epochGraphEndpointGeneration(value) {
  if (Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const prefixed = /^generation:(\d+)$/i.exec(trimmed);
  if (prefixed) return integerValue(prefixed[1]);
  return integerValue(trimmed);
}

function epochGraphNodeGeneration(node) {
  if (!node || typeof node !== 'object') return null;
  return epochGraphEndpointGeneration(node.generation ?? node.id);
}

function epochGraphEdgeGeneration(edge, endpoint) {
  if (!edge || typeof edge !== 'object') return null;
  const generationField = endpoint === 'from' ? 'fromGeneration' : 'toGeneration';
  return epochGraphEndpointGeneration(edge[generationField] ?? edge[endpoint]);
}

function epochGraphEdgeKind(edge) {
  const raw = String(edge?.kind ?? edge?.event ?? '').trim().toLowerCase();
  if (raw === 'published' || raw === 'publish' || raw === 'publication') return 'publish';
  if (raw === 'retired' || raw === 'retire' || raw === 'retirement') return 'retire';
  return raw || null;
}

function epochGenerationGraphStatus(graph) {
  if (!graph || typeof graph !== 'object') {
    return {
      observed: false,
      valid: false,
      reason: 'epoch_generation_graph_not_collected',
      graph: null,
      runtimeSessionIds: [],
      runtimeSessionConsistent: true,
    };
  }

  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter((node) => node && typeof node === 'object') : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter((edge) => edge && typeof edge === 'object') : [];
  const nodeGenerations = new Set(nodes.map(epochGraphNodeGeneration).filter((generation) => generation !== null));
  const latest = graph.latestPublication && typeof graph.latestPublication === 'object'
    ? graph.latestPublication
    : graph.publication && typeof graph.publication === 'object'
      ? graph.publication
      : graph;
  const previousGeneration = integerValue(latest.previousGeneration ?? latest.previous_generation);
  const activeGeneration = integerValue(latest.activeGeneration ?? latest.active_generation);
  const previousGenerationId = epochGraphGenerationId(previousGeneration);
  const activeGenerationId = epochGraphGenerationId(activeGeneration);
  const lineageValid =
    previousGeneration !== null
    && activeGeneration !== null
    && activeGeneration > previousGeneration;
  const publicationEdgeObserved = edges.some((edge) =>
    epochGraphEdgeKind(edge) === 'publish'
    && epochGraphEdgeGeneration(edge, 'from') === previousGeneration
    && epochGraphEdgeGeneration(edge, 'to') === activeGeneration
  );
  const retirementState = typeof graph.retirementState === 'string'
    ? graph.retirementState.trim()
    : typeof graph.retirement_state === 'string'
      ? graph.retirement_state.trim()
      : null;
  const retirementStateObserved =
    retirementState === 'retired'
    || retirementState === 'pending'
    || retirementState === 'not-required';
  const retirementEdgeObserved = retirementState !== 'retired' || edges.some((edge) =>
    epochGraphEdgeKind(edge) === 'retire'
    && epochGraphEdgeGeneration(edge, 'from') === previousGeneration
    && epochGraphEdgeGeneration(edge, 'to') === activeGeneration
  );
  const graphRuntimeSessionIds = compactStringList([
    ...(Array.isArray(graph.runtimeSessionIds) ? graph.runtimeSessionIds : []),
    ...(Array.isArray(graph.runtime_session_ids) ? graph.runtime_session_ids : []),
    ...edges.map((edge) => edge.runtimeSession ?? edge.runtime_session),
  ]);
  const runtimeSessionConsistent = graphRuntimeSessionIds.length === 1;
  const observed = nodes.length > 0 || edges.length > 0;
  const valid =
    observed
    && lineageValid
    && previousGenerationId !== null
    && activeGenerationId !== null
    && nodeGenerations.has(previousGeneration)
    && nodeGenerations.has(activeGeneration)
    && publicationEdgeObserved
    && retirementStateObserved
    && retirementEdgeObserved
    && runtimeSessionConsistent;
  const reason = valid
    ? null
    : !observed
      ? 'epoch_generation_graph_not_collected'
      : !runtimeSessionConsistent
        ? 'epoch_generation_graph_session_unscoped'
        : !lineageValid
          ? 'epoch_generation_graph_lineage_invalid'
          : !nodeGenerations.has(previousGeneration) || !nodeGenerations.has(activeGeneration)
            ? 'epoch_generation_graph_node_missing'
            : !publicationEdgeObserved
              ? 'epoch_generation_graph_publication_edge_missing'
              : !retirementStateObserved
                ? 'epoch_generation_graph_retirement_state_missing'
                : !retirementEdgeObserved
                  ? 'epoch_generation_graph_retirement_edge_missing'
                  : 'epoch_generation_graph_invalid';

  return {
    observed,
    valid,
    reason,
    graph,
    previousGeneration,
    activeGeneration,
    runtimeSessionIds: graphRuntimeSessionIds,
    runtimeSessionConsistent,
    retirementState,
    retirementEdgeObserved,
  };
}

function runtimeHostIdentityEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) => /^worker-log:host_identity:/i.test(ref));
}

function runtimeLaunchArgProvenanceEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) => /^worker-log:launch_arg_provenance:/i.test(ref));
}

function runtimeOriginalHostPathEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) =>
    /^worker-log:(original_host_path|host_path_attachment|launch_attachment):/i.test(ref)
  );
}

function hostPreservationProofUsable(proof) {
  if (!proof || typeof proof !== 'object') return false;
  return proof.resultState === 'gpu-hmr-host-preservation-proven'
    && proof.identityChecksPassed === true
    && proof.identitySnapshotObserved === true
    && proof.identitySnapshotLineageObserved === true
    && proof.requiredIdentityRolesObserved === true
    && runtimeHostIdentityEvidenceRefs(proof.identityEvidenceRefs).length > 0;
}

function originalHostPathProofUsable(proof) {
  if (!proof || typeof proof !== 'object') return false;
  return proof.attachmentProven === true
    && proof.runtimeEvidenceObserved === true
    && proof.dispatchBoundaryObserved === true
    && proof.sessionScoped === true
    && proof.runtimeSessionConsistent !== false
    && runtimeOriginalHostPathEvidenceRefs(proof.evidenceRefs).length > 0;
}

function acceptedAbiExtractorEvidence(observation = {}) {
  const explicitRefs = compactStringList(observation.acceptedExtractorEvidenceRefs);
  const explicitSources = compactStringList(observation.acceptedExtractorSources);
  const extractorRecords = Array.isArray(observation.extractorProvenance)
    ? observation.extractorProvenance.filter((record) => record && typeof record === 'object')
    : [];
  const acceptedRecords = extractorRecords.filter((record) => {
    const kind = String(record.kind ?? record.extractorKind ?? '').trim();
    const evidenceId = String(record.evidenceId ?? '').trim();
    const extractorName = String(record.extractorName ?? '').trim();
    const extractorVersion = String(record.extractorVersion ?? '').trim();
    const inputHash = String(record.inputHash ?? '').trim();
    const explicitlyRejected = record.acceptedByRuntimeCorrectnessPlan === false;
    return ACCEPTED_ABI_EXTRACTOR_KINDS.has(kind)
      && evidenceId
      && extractorName
      && extractorVersion
      && inputHash
      && !explicitlyRejected;
  });
  const refs = compactStringList(acceptedRecords.map((record) => String(record.evidenceId).trim()));
  const sources = compactStringList(
    acceptedRecords.map((record) => String(record.kind ?? record.extractorKind).trim()),
  );
  const explicitRefsMatched = explicitRefs.length === 0
    || explicitRefs.every((ref) => refs.includes(ref));
  const explicitSourcesMatched = explicitSources.length === 0
    || explicitSources.every((source) => sources.includes(source));

  return {
    accepted: refs.length > 0 && explicitRefsMatched && explicitSourcesMatched,
    refs,
    sources,
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

function normalizedStatus(value) {
  return typeof value === 'string' && value.trim() ? value.trim().toLowerCase() : null;
}

function fissionProofUsable(proof) {
  if (!proof || typeof proof !== 'object') return false;
  return proof.fissionProven === true
    && proof.observed === true
    && proof.evidenceObserved === true
    && compactStringList(proof.evidenceRefs).length > 0;
}

function sourceProofRequiresFission(sourceProofs) {
  return sourceProofs.some((proof) => {
    if (!proof || typeof proof !== 'object') return false;
    if (proof.partialArtifactReplacement === true || proof.partialModule === true) return true;
    const label = String(proof.label ?? proof.resultLabel ?? '').trim().toLowerCase();
    const artifactKind = String(
      proof.selectedArtifactKind ?? proof.requestedArtifactKind ?? proof.artifactKind ?? '',
    ).trim().toLowerCase();
    return label === 'gpu-hmr-partial'
      || artifactKind.includes('partial')
      || artifactKind.includes('source_include')
      || artifactKind.includes('kernel_region');
  });
}

function artifactTransportProofUsable(proof) {
  if (!proof || typeof proof !== 'object') return false;
  const evidenceRefs = compactStringList([
    ...(Array.isArray(proof.evidenceRefs) ? proof.evidenceRefs : []),
    ...(Array.isArray(proof.evidence_refs) ? proof.evidence_refs : []),
  ]);
  return (proof.ramTransportProven === true || proof.ram_transport_proven === true)
    && (proof.transportEvidenceObserved === true || proof.transport_evidence_observed === true)
    && (proof.ramArtifactReferenceProvided === true || proof.ram_artifact_reference_provided === true)
    && evidenceRefs.length > 0;
}

export function classifyGpuHmrFissionProof(observation = {}) {
  const stageStatuses = compactStringList([
    observation.status,
    observation.stageStatus,
    ...(Array.isArray(observation.stageStatuses) ? observation.stageStatuses : []),
  ]).map(normalizedStatus).filter(Boolean);
  const rejectedStatusObserved = stageStatuses.some((status) =>
    ['blocked', 'failed', 'fail', 'reject', 'rejected'].includes(status)
  ) || observation.rejected === true;
  const passedStatusObserved = stageStatuses.some((status) =>
    ['passed', 'pass', 'accepted'].includes(status)
  );
  const evidenceRefs = compactStringList([
    ...(Array.isArray(observation.evidenceRefs) ? observation.evidenceRefs : []),
    ...(Array.isArray(observation.verifierEvidenceRefs) ? observation.verifierEvidenceRefs : []),
  ]);
  const evidenceObserved = observation.evidenceObserved === true || evidenceRefs.length > 0;
  const observed = observation.observed === true
    || evidenceObserved
    || stageStatuses.length > 0
    || observation.passed === true
    || observation.verified === true
    || observation.accepted === true
    || observation.rejected === true;
  const required = observation.required === true || observed;
  const fissionProven = observed
    && evidenceObserved
    && !rejectedStatusObserved
    && (
      observation.passed === true
      || observation.verified === true
      || observation.accepted === true
      || passedStatusObserved
    );
  const degradedReason = fissionProven || !required
    ? null
    : typeof observation.degradedReason === 'string' && observation.degradedReason.trim()
      ? observation.degradedReason.trim()
      : !observed
        ? 'fission_candidate_verification_not_observed'
        : !evidenceObserved
          ? 'fission_verifier_evidence_not_collected'
          : rejectedStatusObserved
            ? 'fission_candidate_verifier_rejected'
            : 'fission_candidate_verification_not_proven';

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    required,
    observed,
    evidenceObserved,
    fissionProven,
    resultState: fissionProven ? 'gpu-hmr-fission-candidate-proven' : null,
    degradedState: fissionProven || !required ? null : 'gpu-hmr-fission-unverified',
    degradedReason,
    evidenceRefs,
    stageStatuses,
  };
}

export function summarizeGpuHmrFissionProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_fission_proof=missing';
  const state = proof.fissionProven ? 'proven' : proof.required ? 'unproven' : 'not-required';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const evidence = Array.isArray(proof.evidenceRefs) ? ` evidence_refs=${proof.evidenceRefs.length}` : '';
  return `gpu_fission_proof=${state}${degraded}${reason}${evidence}`;
}

function stageIndex(stages, stageId) {
  return stages.findIndex((stage) => stage.stageId === stageId);
}

function gpuHmrPostPublicationDecision(stages, fullRuntimeProven) {
  const epochIndex = stageIndex(stages, 'epoch-swap');
  const epochStage = epochIndex >= 0 ? stages[epochIndex] : null;
  const epochPublished = epochStage?.status === 'passed';
  const blockedStages = stages.filter((stage) => stage.status !== 'passed');

  if (fullRuntimeProven) {
    return {
      disposition: 'accepted',
      epochPublished,
      quarantineRequired: false,
      rollbackRequired: false,
      aiBlessingAllowed: true,
      reason: null,
      blockedStageIds: [],
    };
  }

  if (!epochPublished) {
    return {
      disposition: 'not-published-or-unverified',
      epochPublished: false,
      quarantineRequired: false,
      rollbackRequired: false,
      aiBlessingAllowed: false,
      reason: epochStage?.degradedReason ?? blockedStages[0]?.degradedReason ?? 'epoch_publication_not_proven',
      blockedStageIds: blockedStages.map((stage) => stage.stageId),
    };
  }

  const postPublicationBlockedStages = blockedStages.filter((stage) => {
    const index = stageIndex(stages, stage.stageId);
    return index > epochIndex;
  });
  const firstPostPublicationBlock = postPublicationBlockedStages[0] ?? blockedStages[0] ?? null;
  return {
    disposition: postPublicationBlockedStages.length > 0 ? 'quarantined' : 'not-published-or-unverified',
    epochPublished: true,
    quarantineRequired: postPublicationBlockedStages.length > 0,
    rollbackRequired: postPublicationBlockedStages.length > 0,
    aiBlessingAllowed: false,
    reason: firstPostPublicationBlock?.degradedReason ?? 'post_publication_runtime_proof_failed',
    blockedStageIds: postPublicationBlockedStages.map((stage) => stage.stageId),
  };
}

function finiteNumericValue(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || !/^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i.test(trimmed)) return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : null;
}

function finiteNumericVector(value) {
  if (Array.isArray(value)) {
    const values = value.map(finiteNumericValue);
    return values.length > 0 && values.every((item) => item !== null) ? values : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed.includes(',')) {
    const scalar = finiteNumericValue(trimmed);
    return scalar === null ? null : [scalar];
  }
  const values = trimmed.split(',').map((part) => finiteNumericValue(part));
  return values.length > 0 && values.every((item) => item !== null) ? values : null;
}

function absoluteToleranceValue(tolerance) {
  if (tolerance && typeof tolerance === 'object' && !Array.isArray(tolerance)) {
    return finiteNumericValue(tolerance.absolute ?? tolerance.abs ?? tolerance.value);
  }
  return finiteNumericValue(tolerance);
}

export function gpuHmrOracleValuesCompatible(expected, actual, tolerance = null) {
  if (Object.is(expected, actual)) {
    return {
      compatible: true,
      exact: true,
      toleranceApplied: false,
      toleranceValid: tolerance === null || tolerance === undefined || absoluteToleranceValue(tolerance) !== null,
    };
  }

  const absoluteTolerance = absoluteToleranceValue(tolerance);
  if (absoluteTolerance === null || absoluteTolerance < 0) {
    return {
      compatible: false,
      exact: false,
      toleranceApplied: false,
      toleranceValid: false,
    };
  }

  const expectedVector = finiteNumericVector(expected);
  const actualVector = finiteNumericVector(actual);
  const compatible =
    expectedVector !== null
    && actualVector !== null
    && expectedVector.length === actualVector.length
    && expectedVector.every((value, index) => Math.abs(value - actualVector[index]) <= absoluteTolerance);

  return {
    compatible,
    exact: false,
    toleranceApplied: compatible,
    toleranceValid: true,
    tolerance: absoluteTolerance,
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
  const oracleKindAccepted = gpuHmrOutputOracleKindAccepted(oracleKind);
  const oracleEvidenceRefs = Array.isArray(rawOracle.evidenceRefs)
    ? rawOracle.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const oracleEvidenceObserved = oracleEvidenceRefs.length > 0;
  const oracleProducer = typeof rawOracle.producer === 'string' && rawOracle.producer.trim()
    ? rawOracle.producer.trim()
    : null;
  const oracleOutputTargetId = typeof rawOracle.outputTargetId === 'string' && rawOracle.outputTargetId.trim()
    ? rawOracle.outputTargetId.trim()
    : typeof rawOracle.outputTarget === 'string' && rawOracle.outputTarget.trim()
      ? rawOracle.outputTarget.trim()
      : null;
  const oracleReadbackTimestamp =
    rawOracle.readbackTimestamp ?? rawOracle.readback_timestamp ?? rawOracle.readbackTs ?? rawOracle.readback_ts ?? null;
  const oracleReadbackTimestampObserved =
    (typeof oracleReadbackTimestamp === 'string' && oracleReadbackTimestamp.trim().length > 0)
    || Number.isFinite(oracleReadbackTimestamp);
  const oracleRuntimeSessionId =
    typeof rawOracle.runtimeSessionId === 'string' && rawOracle.runtimeSessionId.trim()
      ? rawOracle.runtimeSessionId.trim()
      : typeof rawOracle.runtimeSession === 'string' && rawOracle.runtimeSession.trim()
        ? rawOracle.runtimeSession.trim()
        : typeof rawOracle.runtime_session === 'string' && rawOracle.runtime_session.trim()
          ? rawOracle.runtime_session.trim()
          : typeof rawOracle.sessionId === 'string' && rawOracle.sessionId.trim()
            ? rawOracle.sessionId.trim()
            : typeof rawOracle.session_id === 'string' && rawOracle.session_id.trim()
              ? rawOracle.session_id.trim()
              : null;
  const oracleArtifactId = typeof rawOracle.artifactId === 'string' && rawOracle.artifactId.trim()
    ? rawOracle.artifactId.trim()
    : typeof rawOracle.artifact_id === 'string' && rawOracle.artifact_id.trim()
      ? rawOracle.artifact_id.trim()
      : null;
  const oracleProvenanceComplete =
    oracleProducer !== null
    && oracleOutputTargetId !== null
    && oracleReadbackTimestampObserved
    && oracleRuntimeSessionId !== null
    && oracleArtifactId !== null;
  const hasTolerance = Object.prototype.hasOwnProperty.call(rawOracle, 'tolerance')
    && rawOracle.tolerance !== null
    && rawOracle.tolerance !== undefined;
  const valueCompatibility = hasExpected && hasActual
    ? gpuHmrOracleValuesCompatible(
        rawOracle.expected,
        rawOracle.actual,
        hasTolerance ? rawOracle.tolerance : null,
      )
    : {
        compatible: false,
        exact: false,
        toleranceApplied: false,
        toleranceValid: !hasTolerance,
      };
  const oracleValuesCompatible =
    hasExpected
    && hasActual
    && valueCompatibility.compatible;
  const deterministicOutputObserved = observation.deterministicOutputObserved === true && hasActual;
  const deterministicOracleProvided =
    observation.deterministicOracleProvided === true
    && oracleKind !== null
    && oracleKindAccepted
    && hasExpected;
  const deterministicOraclePassed =
    deterministicOutputObserved
    && deterministicOracleProvided
    && oracleEvidenceObserved
    && oracleProvenanceComplete
    && oracleValuesCompatible
    && observation.deterministicOraclePassed === true;
  const outputOracle = {
    provided: deterministicOracleProvided,
    observed: deterministicOutputObserved,
    passed: deterministicOraclePassed,
    evidenceObserved: oracleEvidenceObserved,
    provenanceComplete: oracleProvenanceComplete,
    producer: oracleProducer,
    outputTargetId: oracleOutputTargetId,
    readbackTimestamp: oracleReadbackTimestampObserved ? oracleReadbackTimestamp : null,
    runtimeSessionId: oracleRuntimeSessionId,
    artifactId: oracleArtifactId,
    valuesCompatible: oracleValuesCompatible,
    kind: oracleKind,
    kindAccepted: oracleKindAccepted,
    expected: hasExpected ? rawOracle.expected : null,
    actual: hasActual ? rawOracle.actual : null,
    tolerance: Object.prototype.hasOwnProperty.call(rawOracle, 'tolerance') ? rawOracle.tolerance : null,
    exactValueMatch: valueCompatibility.exact,
    toleranceApplied: valueCompatibility.toleranceApplied,
    toleranceValid: valueCompatibility.toleranceValid,
    evidenceRefs: oracleEvidenceRefs,
  };
  const visualFrameObserved = observation.visualFrameObserved === true;
  const evidenceRefs = Array.isArray(observation.evidenceRefs)
    ? observation.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const visualEvidenceRefs = Array.isArray(observation.visualEvidenceRefs)
    ? observation.visualEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const visualEvidenceRequired = observation.visualEvidenceRequired === true;
  const visualEvidenceComplete = !visualEvidenceRequired
    || (visualFrameObserved && visualEvidenceRefs.length > 0);

  if (!dispatchUsable) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: dispatchProof?.resultState ?? null,
      degradedState: dispatchProof?.degradedState ?? 'gpu-hmr-dispatch-unobserved',
      degradedReason: dispatchProof?.degradedReason ?? 'runtime_dispatch_not_observed',
      outputOracle: { ...outputOracle, passed: false },
      visualFrameObserved,
      visualEvidenceRequired,
      visualEvidenceComplete,
      evidenceRefs,
      visualEvidenceRefs,
      dispatchProof,
    };
  }

  if (deterministicOraclePassed) {
    if (!visualEvidenceComplete) {
      return {
        schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
        resultState: dispatchProof?.resultState ?? 'gpu-hmr-dispatch-safe-proven',
        degradedState: 'gpu-hmr-visual-evidence-missing',
        degradedReason: visualFrameObserved
          ? 'visual_evidence_refs_missing'
          : 'visual_frame_not_observed',
        outputOracle,
        visualFrameObserved,
        visualEvidenceRequired,
        visualEvidenceComplete,
        evidenceRefs,
        visualEvidenceRefs,
        dispatchProof,
      };
    }

    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-output-oracle-proven',
      degradedState: null,
      degradedReason: null,
      outputOracle,
      visualFrameObserved,
      visualEvidenceRequired,
      visualEvidenceComplete,
      evidenceRefs,
      visualEvidenceRefs,
      dispatchProof,
    };
  }

  const oracleOtherwisePassed =
    deterministicOutputObserved
    && deterministicOracleProvided
    && oracleEvidenceObserved
    && oracleValuesCompatible
    && observation.deterministicOraclePassed === true;
  const degradedState = visualFrameObserved
    ? 'gpu-hmr-visual-only'
    : 'gpu-hmr-output-unobserved';
  const degradedReason = oracleKind !== null && !oracleKindAccepted
    ? 'output_oracle_kind_unaccepted'
    : oracleOtherwisePassed && !oracleProvenanceComplete
      ? 'output_oracle_provenance_incomplete'
      : visualFrameObserved
        ? 'visual_frame_without_deterministic_output_oracle'
        : 'output_oracle_not_collected';

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: dispatchProof?.resultState ?? 'gpu-hmr-dispatch-safe-proven',
    degradedState,
    degradedReason,
    outputOracle: { ...outputOracle, passed: false },
    visualFrameObserved,
    visualEvidenceRequired,
    visualEvidenceComplete,
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
  const argProvenanceEvidenceRefs = runtimeLaunchArgProvenanceEvidenceRefs([
    ...(Array.isArray(observation.argProvenanceEvidenceRefs) ? observation.argProvenanceEvidenceRefs : []),
    ...(Array.isArray(observation.argumentProvenanceEvidenceRefs) ? observation.argumentProvenanceEvidenceRefs : []),
  ]);
  const argProvenanceEvidenceObserved = argProvenanceEvidenceRefs.length > 0;
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
      argProvenanceEvidenceObserved,
      argProvenanceEvidenceRefs,
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
      argProvenanceEvidenceObserved,
      argProvenanceEvidenceRefs,
      unknownArgCount,
    };
  }

  if (!argProvenanceEvidenceObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-unknown-arg-provenance',
      degradedReason: 'launch_argument_provenance_evidence_refs_not_collected',
      dispatchObserved: true,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: false,
      argProvenanceEvidenceObserved: false,
      argProvenanceEvidenceRefs,
      unknownArgCount: 0,
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
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
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
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
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
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
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
    argProvenanceEvidenceObserved: true,
    argProvenanceEvidenceRefs,
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
  const epochGraph = epochGenerationGraphStatus(
    observation.epochGenerationGraph ?? observation.generationGraph,
  );
  const runtimeSessionIds = compactStringList([
    ...runtimeSessionIdsFromObservation(observation),
    ...epochGraph.runtimeSessionIds,
  ]);
  const runtimeSessionObserved = observation.runtimeSessionObserved === true || runtimeSessionIds.length > 0;
  const runtimeSessionConsistent =
    observation.runtimeSessionConsistent !== false
    && runtimeSessionIds.length <= 1
    && epochGraph.runtimeSessionConsistent !== false;
  const generationGraphObserved = epochGraph.observed;
  const generationGraphValid = epochGraph.valid;
  const generationLineageObserved = generationGraphValid;
  const dispatchTableHashBeforeObserved = observation.dispatchTableHashBeforeObserved === true;
  const dispatchTableHashAfterObserved = observation.dispatchTableHashAfterObserved === true;
  const dispatchTableHashChanged = observation.dispatchTableHashChanged === true;
  const dispatchTableHashObserved =
    observation.dispatchTableHashObserved === true
    && dispatchTableHashBeforeObserved
    && dispatchTableHashAfterObserved
    && dispatchTableHashChanged;
  const changedEntriesObserved = observation.changedEntriesObserved === true;
  const streamScope = typeof observation.streamScope === 'string' && observation.streamScope.trim()
    ? observation.streamScope.trim()
    : null;
  const streamIds = compactStringList(observation.streamIds);
  const streamScopeEvidenceObserved = streamScopeObserved(streamScope, streamIds);
  const streamOrderingRequested =
    observation.streamOrderingRequested === true || observation.streamOrderingProven === true;
  const streamOrderingProven = streamOrderingRequested && streamScopeEvidenceObserved;
  const retirementTracked = observation.retirementTracked === true;
  const oldGenerationRetired = observation.oldGenerationRetired === true;
  const evidenceRefs = compactStringList(observation.evidenceRefs);
  const evidenceObserved = evidenceRefs.length > 0;

  if (
    published
    && runtimeSessionObserved
    && runtimeSessionConsistent
    && generationLineageObserved
    && dispatchTableHashObserved
    && changedEntriesObserved
    && streamOrderingProven
    && retirementTracked
    && oldGenerationRetired
    && evidenceObserved
  ) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-epoch-swap-proven',
      degradedState: null,
      degradedReason: null,
      published: true,
      runtimeSessionObserved: true,
      runtimeSessionIds,
      runtimeSessionConsistent: true,
      generationGraphObserved: true,
      generationGraphValid: true,
      epochGenerationGraph: epochGraph.graph,
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope,
      streamIds,
      retirementTracked: true,
      oldGenerationRetired: true,
      evidenceRefs,
    };
  }

  const partialEpochObserved =
    published
    && runtimeSessionObserved
    && runtimeSessionConsistent
    && generationLineageObserved
    && dispatchTableHashObserved
    && changedEntriesObserved
    && streamOrderingProven
    && retirementTracked
    && evidenceObserved;
  if (partialEpochObserved && !oldGenerationRetired) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-epoch-swap-proven',
      degradedState: 'gpu-hmr-epoch-retirement-pending',
      degradedReason: 'old_generation_retirement_not_completed',
      published: true,
      runtimeSessionObserved: true,
      runtimeSessionIds,
      runtimeSessionConsistent: true,
      generationGraphObserved: true,
      generationGraphValid: true,
      epochGenerationGraph: epochGraph.graph,
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      streamOrderingProven: true,
      streamScope,
      streamIds,
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
      : !runtimeSessionObserved
        ? 'epoch_runtime_session_not_collected'
        : !runtimeSessionConsistent
          ? 'epoch_runtime_session_inconsistent'
          : !generationGraphObserved
            ? 'epoch_generation_graph_not_collected'
            : !generationGraphValid
              ? epochGraph.reason
              : !dispatchTableHashObserved
            ? !dispatchTableHashBeforeObserved || !dispatchTableHashAfterObserved
              ? 'epoch_dispatch_table_hash_not_collected'
              : 'epoch_dispatch_table_hash_unchanged'
            : !changedEntriesObserved
              ? 'epoch_changed_entries_not_collected'
              : !streamOrderingRequested
                ? 'epoch_stream_ordering_not_collected'
                : !streamScopeEvidenceObserved
                  ? 'epoch_stream_scope_not_collected'
                  : !evidenceObserved
                    ? 'epoch_evidence_refs_not_collected'
                    : 'epoch_retirement_tracking_not_collected',
    published,
    runtimeSessionObserved,
    runtimeSessionIds,
    runtimeSessionConsistent,
    generationGraphObserved,
    generationGraphValid,
    epochGenerationGraph: epochGraph.graph,
    generationLineageObserved,
    dispatchTableHashObserved,
    dispatchTableHashBeforeObserved,
    dispatchTableHashAfterObserved,
    dispatchTableHashChanged,
    changedEntriesObserved,
    streamOrderingProven,
    streamScope,
    streamIds,
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
  const session = proof.runtimeSessionObserved ? ' session=observed' : ' session=missing';
  const graph = proof.generationGraphValid
    ? ' graph=valid'
    : proof.generationGraphObserved
      ? ' graph=invalid'
      : ' graph=missing';
  const stream = proof.streamOrderingProven ? ' stream_ordering=proven' : ' stream_ordering=unproven';
  const retired = proof.oldGenerationRetired ? ' retired=yes' : ' retired=no';
  return `gpu_epoch_swap_proof=${result}${degraded}${reason}${publication}${session}${graph}${stream}${retired}`;
}

export function classifyGpuHmrHostPreservationProof(observation = {}) {
  const hostReplacementObserved =
    observation.hostReplacementObserved === true || observation.hostRestartObserved === true;
  const identityChecksPassed = observation.identityChecksPassed === true;
  const identitySnapshotObserved = observation.identitySnapshotObserved === true;
  const identitySnapshotLineageObserved =
    observation.identitySnapshotLineageObserved === true
    || observation.expectedGenerationLineageObserved === true;
  const requiredIdentityRolesObserved = observation.requiredIdentityRolesObserved === true;
  const identityEvidenceRefs = Array.isArray(observation.identityEvidenceRefs)
    ? observation.identityEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const identityEvidenceObserved = identityEvidenceRefs.length > 0;
  const runtimeIdentityEvidenceRefs = runtimeHostIdentityEvidenceRefs(identityEvidenceRefs);
  const runtimeIdentityEvidenceObserved = runtimeIdentityEvidenceRefs.length > 0;

  if (hostReplacementObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: null,
      degradedState: 'gpu-hmr-host-replaced',
      degradedReason: 'host_runtime_replaced_or_restarted',
      identityChecksPassed: false,
      identitySnapshotObserved,
      identitySnapshotLineageObserved,
      requiredIdentityRolesObserved,
      identityEvidenceObserved,
      identityEvidenceRefs,
      runtimeIdentityEvidenceRefs,
    };
  }

  if (
    identityChecksPassed
    && identitySnapshotObserved
    && identitySnapshotLineageObserved
    && requiredIdentityRolesObserved
    && runtimeIdentityEvidenceObserved
  ) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-host-preservation-proven',
      degradedState: null,
      degradedReason: null,
      identityChecksPassed: true,
      identitySnapshotObserved: true,
      identitySnapshotLineageObserved: true,
      requiredIdentityRolesObserved: true,
      identityEvidenceObserved: true,
      identityEvidenceRefs,
      runtimeIdentityEvidenceRefs,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: null,
    degradedState: null,
    degradedReason: identityChecksPassed
      ? !identitySnapshotObserved
        ? 'host_identity_snapshots_not_collected'
        : !runtimeIdentityEvidenceObserved
          ? 'host_identity_evidence_refs_not_collected'
          : !identitySnapshotLineageObserved
            ? 'host_identity_epoch_lineage_not_collected'
            : !requiredIdentityRolesObserved
              ? 'host_identity_required_roles_not_collected'
              : 'host_identity_checks_not_collected'
      : 'host_identity_checks_not_collected',
    identityChecksPassed: false,
    identitySnapshotObserved,
    identitySnapshotLineageObserved,
    requiredIdentityRolesObserved,
    identityEvidenceObserved,
    identityEvidenceRefs,
    runtimeIdentityEvidenceRefs,
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

export function classifyGpuHmrOriginalHostPathProof(observation = {}) {
  const required = observation.required === true;
  const runtimeSessionIds = runtimeSessionIdsFromObservation(observation);
  const runtimeSessionObserved = observation.runtimeSessionObserved === true || runtimeSessionIds.length > 0;
  const runtimeSessionConsistent =
    observation.runtimeSessionConsistent !== false && runtimeSessionIds.length <= 1;
  const sessionScoped = observation.sessionScoped === true && runtimeSessionObserved && runtimeSessionConsistent;
  const dispatchBoundaryObserved = observation.dispatchBoundaryObserved === true;
  const attachedToOriginalHostPath = observation.attachedToOriginalHostPath === true;
  const evidenceRefs = compactStringList(observation.evidenceRefs);
  const runtimeEvidenceRefs = runtimeOriginalHostPathEvidenceRefs(evidenceRefs);
  const runtimeEvidenceObserved = observation.runtimeEvidenceObserved === true && runtimeEvidenceRefs.length > 0;
  const attachmentProven =
    attachedToOriginalHostPath
    && runtimeEvidenceObserved
    && dispatchBoundaryObserved
    && sessionScoped;

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    required,
    attachmentProven,
    degradedState: attachmentProven || !required ? null : 'gpu-hmr-original-host-path-unattached',
    degradedReason: attachmentProven || !required
      ? null
      : !attachedToOriginalHostPath
        ? 'original_host_path_attachment_not_observed'
        : !runtimeEvidenceObserved
          ? 'original_host_path_runtime_evidence_not_collected'
          : !dispatchBoundaryObserved
            ? 'original_host_path_dispatch_boundary_not_observed'
            : !sessionScoped
              ? 'original_host_path_session_scope_not_proven'
              : 'original_host_path_attachment_not_proven',
    attachedToOriginalHostPath,
    runtimeEvidenceObserved,
    runtimeEvidenceRefs,
    dispatchBoundaryObserved,
    sessionScoped,
    runtimeSessionObserved,
    runtimeSessionIds,
    runtimeSessionConsistent,
    evidenceRefs,
  };
}

export function summarizeGpuHmrOriginalHostPathProof(proof) {
  if (!proof || typeof proof !== 'object') return 'gpu_original_host_path_proof=missing';
  const result = proof.attachmentProven ? 'attached' : proof.required ? 'missing' : 'not-required';
  const degraded = proof.degradedState ? ` degraded=${proof.degradedState}` : '';
  const reason = proof.degradedReason ? ` reason=${proof.degradedReason}` : '';
  const evidence = proof.runtimeEvidenceObserved ? ' evidence=runtime' : ' evidence=missing';
  const session = proof.sessionScoped ? ' session=current' : ' session=unproven';
  return `gpu_original_host_path_proof=${result}${degraded}${reason}${evidence}${session}`;
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
  const hostProofAccepted = hostPreservationProofUsable(hostPreservationProof);
  const hostRank = hostProofAccepted ? effectiveProofRank(hostPreservationProof) : 0;
  const hostProofDegradedReason =
    hostPreservationProof?.resultState === 'gpu-hmr-host-preservation-proven' && !hostProofAccepted
      ? 'host_identity_snapshot_provenance_unverified'
      : hostPreservationProof?.degradedReason ?? 'host_identity_checks_not_collected';
  const originalHostPathProof =
    observation.originalHostPathProof && typeof observation.originalHostPathProof === 'object'
      ? observation.originalHostPathProof
      : classifyGpuHmrOriginalHostPathProof({ required: observation.originalHostPathRequired === true });
  const originalHostPathRequired =
    observation.originalHostPathRequired === true || originalHostPathProof.required === true;
  const originalHostPathAccepted =
    !originalHostPathRequired || originalHostPathProofUsable(originalHostPathProof);
  const partialArtifactReplacementRequiresFission =
    observation.partialArtifactReplacement === true || sourceProofRequiresFission(sourceProofs);
  const fissionProofRequiredByObservation =
    observation.fissionProofRequired === true || partialArtifactReplacementRequiresFission;
  const fissionProof = observation.fissionProof && typeof observation.fissionProof === 'object'
    ? observation.fissionProof
    : classifyGpuHmrFissionProof({ required: fissionProofRequiredByObservation });
  const fissionProofRequired =
    fissionProofRequiredByObservation || fissionProof.required === true;
  const fissionProofAccepted = !fissionProofRequired || fissionProofUsable(fissionProof);
  const artifactTransportProof =
    observation.artifactTransportProof && typeof observation.artifactTransportProof === 'object'
      ? observation.artifactTransportProof
      : null;
  const artifactTransportAccepted = artifactTransportProofUsable(artifactTransportProof);
  const artifactTransportEvidenceObserved =
    artifactTransportProof?.transportEvidenceObserved === true
    || artifactTransportProof?.transport_evidence_observed === true;
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
    {
      stageId: 'artifact-transport',
      requiredState: 'gpu-hmr-epoch-swap-proven',
      status: artifactTransportAccepted ? 'passed' : 'blocked',
      observedState: artifactTransportAccepted
        ? 'gpu-hmr-artifact-transport-proven'
        : artifactTransportProof?.degradedState ?? null,
      effectiveRank: artifactTransportAccepted ? proofStateRank('gpu-hmr-epoch-swap-proven') : 0,
      degradedState: artifactTransportAccepted
        ? null
        : artifactTransportProof?.degradedState ?? 'gpu-hmr-ram-io-unavailable',
      degradedReason: artifactTransportAccepted
        ? null
        : artifactTransportProof?.degradedReason ?? (artifactTransportEvidenceObserved
          ? 'ram_artifact_transport_not_proven'
          : 'artifact_transport_evidence_not_collected'),
    },
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
      outputProof?.degradedState ?? 'gpu-hmr-output-unobserved',
      outputProof?.degradedReason ?? 'output_oracle_not_collected',
    ),
    stageResult(
      'host-preservation',
      'gpu-hmr-host-preservation-proven',
      hostRank,
      hostPreservationProof,
      hostPreservationProof?.degradedState ?? null,
      hostProofDegradedReason,
    ),
  ];
  if (fissionProofRequired) {
    stages.unshift({
      stageId: 'fission-candidate-verification',
      requiredState: 'gpu-hmr-full-runtime-proven',
      status: fissionProofAccepted ? 'passed' : 'blocked',
      observedState: fissionProof?.resultState ?? null,
      effectiveRank: fissionProofAccepted ? proofStateRank('gpu-hmr-full-runtime-proven') : 0,
      degradedState: fissionProofAccepted
        ? null
        : fissionProof?.degradedState ?? 'gpu-hmr-fission-unverified',
      degradedReason: fissionProofAccepted
        ? null
        : fissionProof?.degradedReason ?? (fissionProof?.observed === true
          ? 'fission_candidate_verification_not_proven'
          : 'fission_candidate_verification_not_observed'),
    });
  }
  if (originalHostPathRequired) {
    stages.push({
      stageId: 'original-host-path',
      requiredState: 'gpu-hmr-full-runtime-proven',
      status: originalHostPathAccepted ? 'passed' : 'blocked',
      observedState: originalHostPathProof?.attachmentProven ? 'original-host-path-attached' : null,
      effectiveRank: originalHostPathAccepted
        ? proofStateRank('gpu-hmr-full-runtime-proven')
        : proofStateRank('gpu-hmr-host-preservation-proven'),
      degradedState: originalHostPathAccepted
        ? null
        : originalHostPathProof?.degradedState ?? 'gpu-hmr-original-host-path-unattached',
      degradedReason: originalHostPathAccepted
        ? null
        : originalHostPathProof?.degradedReason ?? 'original_host_path_attachment_not_observed',
    });
  }

  let resultState = null;
  for (const stage of stages) {
    if (stage.status !== 'passed') break;
    if (stage.requiredState !== 'gpu-hmr-full-runtime-proven') {
      resultState = stage.requiredState;
    }
  }
  const firstBlocked = stages.find((stage) => stage.status !== 'passed') ?? null;
  const fullRuntimeProven = firstBlocked === null;
  const postPublicationDecision = gpuHmrPostPublicationDecision(stages, fullRuntimeProven);
  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: fullRuntimeProven ? 'gpu-hmr-full-runtime-proven' : resultState,
    degradedState: firstBlocked?.degradedState ?? null,
    degradedReason: firstBlocked?.degradedReason ?? null,
    fullRuntimeProven,
    stages,
    postPublicationDecision,
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
      originalHostPathRequired,
      originalHostPathProven: originalHostPathAccepted,
      fissionProofRequired,
      partialArtifactReplacementRequiresFission,
      fissionProofObserved: fissionProof.observed === true,
      fissionProofProven: fissionProofUsable(fissionProof),
      artifactTransportProven: artifactTransportAccepted,
      artifactTransportObserved: artifactTransportEvidenceObserved,
      artifactTransportDegradedState: artifactTransportProof?.degradedState ?? null,
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
  const capsule = proof.postPublicationDecision?.disposition
    ? ` capsule=${proof.postPublicationDecision.disposition}`
    : '';
  return `gpu_full_runtime_proof=${result}${degraded}${reason} full_runtime=${proof.fullRuntimeProven ? 'proven' : 'unproven'}${blockedSummary}${capsule}`;
}
