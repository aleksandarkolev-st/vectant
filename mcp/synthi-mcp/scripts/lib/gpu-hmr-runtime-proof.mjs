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

const RENDER_OUTPUT_ORACLE_KINDS = new Set([
  'render_target_hash',
  'accumulation_buffer_hash',
  'selected_pixels',
  'selected_pixel_values',
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

function sourceCompileProofUsable(proof) {
  if (!proof || typeof proof !== 'object') return false;
  return proof.schemaVersion === 'synthi.gpu.hmr.source_proof.v1'
    && proof.compileEvidenceObserved === true
    && proof.compileProven === true
    && compactStringList(proof.compileEvidenceRefs).length >= 2
    && compactStringList(proof.evidenceRefs).length >= 2
    && compactStringList(proof.proofArtifactPaths).length > 0;
}

function sourceSymbolProofUsable(proof) {
  if (!sourceCompileProofUsable(proof)) return false;
  return proof.symbolBindingEvidenceObserved === true
    && proof.symbolBindingProven === true
    && proof.sourceProofProven === true
    && compactStringList(proof.symbolEvidenceRefs).length > 0;
}

function effectiveSourceProofRank(proof) {
  const rawRank = Math.min(effectiveProofRank(proof), proofStateRank('gpu-hmr-symbol-bound'));
  if (rawRank >= proofStateRank('gpu-hmr-symbol-bound') && sourceSymbolProofUsable(proof)) {
    return proofStateRank('gpu-hmr-symbol-bound');
  }
  if (rawRank >= proofStateRank('gpu-hmr-compile-proven') && sourceCompileProofUsable(proof)) {
    return proofStateRank('gpu-hmr-compile-proven');
  }
  return 0;
}

function highestEffectiveSourceProof(proofs) {
  let best = null;
  for (const proof of proofs) {
    const effectiveRank = effectiveSourceProofRank(proof);
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

function runtimeOutputOracleEvidenceRefs(values) {
  return compactStringList(values).filter((ref) =>
    /^worker-log:output_oracle:/i.test(ref)
    || /^evidence:output-oracle:/i.test(ref)
    || /^validation:output-oracle:/i.test(ref)
    || /(^|[\\/])runtime-output-oracles[\\/][^\\/]+\.json$/i.test(ref)
  );
}

function observedEvidenceList(values) {
  const raw = typeof values === 'string' ? values.split(',') : values;
  return compactStringList(raw).filter((value) => value.toLowerCase() !== 'none');
}

function runtimeSessionIdsFromObservation(observation = {}) {
  return compactStringList([
    observation.runtimeSessionId,
    observation.currentRuntimeSessionId,
    ...(Array.isArray(observation.runtimeSessionIds) ? observation.runtimeSessionIds : []),
    ...(Array.isArray(observation.currentRuntimeSessionIds) ? observation.currentRuntimeSessionIds : []),
  ]);
}

function dispatchRuntimeArtifactIdsFromProof(dispatchProof) {
  return contentAddressedArtifactIds(dispatchProof?.runtimeArtifactIds);
}

function contentAddressedArtifactIds(values) {
  return compactStringList(values).filter((id) => /^artifact:sha256:[0-9a-f]{64}$/i.test(id));
}

function firstArrayField(object, keys) {
  for (const key of keys) {
    if (Array.isArray(object?.[key])) return object[key];
  }
  return [];
}

function normalizeArgProvenanceRecords(values) {
  const records = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    if (!value || typeof value !== 'object') continue;
    const index = Number.isInteger(value.argIndex)
      ? value.argIndex
      : Number.isInteger(value.index)
        ? value.index
        : null;
    const rawCategory = stringField(value.category, value.sourceCategory, value.kind);
    const category = rawCategory ? rawCategory.replace(/-/g, '_').toLowerCase() : null;
    if (index === null || index < 0 || !category) continue;
    const record = {
      argIndex: index,
      category,
      provenance: stringField(value.provenance) ?? null,
      confidence: stringField(value.confidence) ?? null,
      kernelName: stringField(value.kernelName, value.kernel) ?? null,
      runtimeSessionId: stringField(value.runtimeSessionId, value.runtimeSession) ?? null,
      generation: stringField(value.generation) ?? null,
      launchKey: stringField(value.launchKey, value.launch_key) ?? null,
      expectedArgCount: integerValue(
        value.expectedArgCount
        ?? value.expected_arg_count
        ?? value.knownArgCount
        ?? value.known_arg_count,
      ),
      allocationId: stringField(value.allocationId, value.allocationName) ?? null,
      allocationSize: finiteNonNegativeNumber(value.allocationSize ?? value.allocationBytes),
      valueSize: finiteNonNegativeNumber(value.valueSize),
    };
    const key = [
      record.argIndex,
      record.category,
      record.provenance,
      record.confidence,
      record.kernelName,
      record.runtimeSessionId,
      record.generation,
      record.launchKey,
      record.expectedArgCount,
      record.allocationId,
      record.allocationSize,
      record.valueSize,
    ].join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    records.push(record);
  }
  return records;
}

function argRecordRuntimeProven(record) {
  if (!record || typeof record !== 'object') return false;
  if (record.category === 'literal' || record.category === 'scalar_value') return true;
  if (record.category !== 'device_allocation') return false;
  return Boolean(record.allocationId) && record.allocationSize !== null;
}

function argProvenanceRecordsComplete(observation, records) {
  const knownArgCount = integerValue(
    observation.knownArgCount
    ?? observation.known_arg_count
    ?? observation.argProvenanceKnownArgCount
    ?? observation.arg_provenance_known_arg_count,
  );
  if (knownArgCount === 0) return true;
  if (!records.length || !records.every(argRecordRuntimeProven)) return false;
  const launchGroups = new Map();
  for (const record of records) {
    if (!record.launchKey || record.expectedArgCount === null) continue;
    const existing = launchGroups.get(record.launchKey) ?? { expected: 0, records: 0 };
    existing.expected = Math.max(existing.expected, record.expectedArgCount);
    existing.records += 1;
    launchGroups.set(record.launchKey, existing);
  }
  if (launchGroups.size > 0) {
    for (const group of launchGroups.values()) {
      if (group.expected > 0 && group.records < group.expected) return false;
    }
    return true;
  }
  if (knownArgCount !== null && records.length < knownArgCount) return false;
  return true;
}

function argProvenanceRecordsHaveLaunchGroupCounts(records) {
  return records.some((record) => record.launchKey && record.expectedArgCount !== null);
}

function streamScopeObserved(streamScope, streamIds) {
  if (streamScope === 'none') {
    return streamIds.length === 1 && streamIds[0] === 'none';
  }
  if (streamScope !== 'stream' && streamScope !== 'affected') return false;
  return streamIds.length > 0 && !streamIds.includes('none');
}

function streamEpochCounterEntries(counters) {
  if (!counters || typeof counters !== 'object' || Array.isArray(counters)) return [];
  return Object.entries(counters)
    .map(([streamId, epoch]) => [String(streamId).trim(), integerValue(epoch)])
    .filter(([streamId, epoch]) => streamId && epoch !== null && epoch >= 0);
}

function streamEpochCountersCoverScope(streamScope, streamIds, counters) {
  const counterIds = new Set(streamEpochCounterEntries(counters).map(([streamId]) => streamId));
  if (streamScope === 'none') {
    return streamIds.length === 1 && streamIds[0] === 'none' && counterIds.has('none');
  }
  if (streamScope !== 'stream' && streamScope !== 'affected') return false;
  return streamIds.length > 0
    && !streamIds.includes('none')
    && streamIds.every((streamId) => counterIds.has(streamId));
}

function normalizedRetirementStrategy(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return [
    'epoch_fence',
    'no_retirement_required',
    'conservative_drain_fallback',
  ].includes(normalized)
    ? normalized
    : null;
}

function inferredRetirementStrategy({
  explicitStrategy,
  streamScope,
  retirementFenceIds,
  delayedUnloadResult,
}) {
  const explicit = normalizedRetirementStrategy(explicitStrategy);
  if (explicit) return explicit;
  const delayed = String(delayedUnloadResult ?? '').trim().toLowerCase();
  if (
    streamScope === 'none'
    || delayed === 'not_required'
    || delayed === 'no_old_generation'
  ) {
    return 'no_retirement_required';
  }
  return Array.isArray(retirementFenceIds) && retirementFenceIds.length > 0
    ? 'epoch_fence'
    : null;
}

function oldArtifactReferenceObserved(oldArtifactId, previousGeneration) {
  const normalized = String(oldArtifactId ?? '').trim();
  if (/^artifact:sha256:[0-9a-f]{64}$/i.test(normalized)) return true;
  if (normalized.toLowerCase() !== 'none') return false;
  return Number.isFinite(previousGeneration) && previousGeneration <= 1;
}

function integerValue(value) {
  if (typeof value === 'number' && Number.isInteger(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && String(parsed) === value.trim() ? parsed : null;
}

function finiteNonNegativeNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : null;
  }
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function finiteNonNegativeNumberList(values) {
  const raw = Array.isArray(values) ? values : [values];
  return raw
    .map((value) => finiteNonNegativeNumber(value))
    .filter((value) => value !== null);
}

function dispatchTableHashValue(...values) {
  for (const value of values) {
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (/^0x[0-9a-f]+$/i.test(trimmed)) return trimmed.toLowerCase();
    if (/^sha256:[0-9a-f]{64}$/i.test(trimmed)) return trimmed.toLowerCase();
  }
  return null;
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

function epochGraphEdgesAcyclic(edgeStatuses) {
  const adjacency = new Map();
  for (const edge of edgeStatuses) {
    if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
    adjacency.get(edge.from).push(edge.to);
  }
  const visiting = new Set();
  const visited = new Set();
  const visit = (generation) => {
    if (visiting.has(generation)) return false;
    if (visited.has(generation)) return true;
    visiting.add(generation);
    for (const next of adjacency.get(generation) ?? []) {
      if (!visit(next)) return false;
    }
    visiting.delete(generation);
    visited.add(generation);
    return true;
  };
  return [...adjacency.keys()].every(visit);
}

function epochGenerationGraphStatus(graph) {
  if (!graph || typeof graph !== 'object') {
    return {
      observed: false,
      valid: false,
      reason: 'epoch_generation_graph_not_collected',
      graph: null,
      capsuleMetadataObserved: false,
      schemaVersionValid: false,
      publishTimestampObserved: false,
      runtimeSessionIds: [],
      runtimeSessionScoped: false,
      runtimeSessionConsistent: true,
    };
  }

  const schemaVersionValid = graph.schemaVersion === 'synthi.gpu.epoch_graph.v1';
  const nodes = Array.isArray(graph.nodes) ? graph.nodes.filter((node) => node && typeof node === 'object') : [];
  const edges = Array.isArray(graph.edges) ? graph.edges.filter((edge) => edge && typeof edge === 'object') : [];
  const nodeGenerations = new Set(nodes.map(epochGraphNodeGeneration).filter((generation) => generation !== null));
  const nodeIdentitiesValid = nodes.every((node) => {
    const generation = epochGraphNodeGeneration(node);
    const idGeneration = typeof node.id === 'undefined' ? generation : epochGraphEndpointGeneration(node.id);
    return generation !== null && idGeneration === generation;
  });
  const edgeStatuses = edges.map((edge) => ({
    kind: epochGraphEdgeKind(edge),
    from: epochGraphEdgeGeneration(edge, 'from'),
    to: epochGraphEdgeGeneration(edge, 'to'),
  }));
  const edgeClosureValid = edgeStatuses.every((edge) =>
    (edge.kind === 'publish' || edge.kind === 'retire')
    && edge.from !== null
    && edge.to !== null
    && edge.to > edge.from
    && nodeGenerations.has(edge.from)
    && nodeGenerations.has(edge.to)
  );
  const graphAcyclic = edgeClosureValid && epochGraphEdgesAcyclic(edgeStatuses);
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
  const publicationEdge = edges.find((edge) =>
    epochGraphEdgeKind(edge) === 'publish'
    && epochGraphEdgeGeneration(edge, 'from') === previousGeneration
    && epochGraphEdgeGeneration(edge, 'to') === activeGeneration
  ) ?? null;
  const publishTimestamp = latest.publishTimestampMs
    ?? latest.publish_timestamp_ms
    ?? latest.publishTimestamp
    ?? latest.publish_timestamp
    ?? publicationEdge?.publishTimestampMs
    ?? publicationEdge?.publish_timestamp_ms
    ?? publicationEdge?.publishTimestamp
    ?? publicationEdge?.publish_timestamp;
  const publishTimestampObserved = finiteNonNegativeNumber(publishTimestamp) !== null;
  const oldArtifactId = String(latest.oldArtifactId ?? latest.old_artifact_id ?? publicationEdge?.oldArtifactId ?? publicationEdge?.old_artifact_id ?? '').trim();
  const newArtifactId = String(latest.newArtifactId ?? latest.new_artifact_id ?? publicationEdge?.newArtifactId ?? publicationEdge?.new_artifact_id ?? '').trim();
  const newArtifactHash = String(latest.newArtifactHash ?? latest.new_artifact_hash ?? publicationEdge?.newArtifactHash ?? publicationEdge?.new_artifact_hash ?? '').trim();
  const newArtifactIdHash = newArtifactId.match(/^artifact:sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
  const newArtifactHashDigest = newArtifactHash.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
  const capsuleId = String(latest.capsuleId ?? latest.capsule_id ?? publicationEdge?.capsuleId ?? publicationEdge?.capsule_id ?? '').trim();
  const fissionIslandId = String(latest.fissionIslandId ?? latest.fission_island_id ?? publicationEdge?.fissionIslandId ?? publicationEdge?.fission_island_id ?? '').trim();
  const abiMembraneHash = String(latest.abiMembraneHash ?? latest.abi_membrane_hash ?? publicationEdge?.abiMembraneHash ?? publicationEdge?.abi_membrane_hash ?? '').trim();
  const dependencyClosureHash = String(latest.dependencyClosureHash ?? latest.dependency_closure_hash ?? publicationEdge?.dependencyClosureHash ?? publicationEdge?.dependency_closure_hash ?? '').trim();
  const proofHash = String(latest.proofHash ?? latest.proof_hash ?? publicationEdge?.proofHash ?? publicationEdge?.proof_hash ?? '').trim();
  const changedSymbols = observedEvidenceList(latest.changedSymbols ?? latest.changed_symbols ?? publicationEdge?.changedSymbols ?? publicationEdge?.changed_symbols);
  const functionHandleIds = observedEvidenceList(latest.functionHandleIds ?? latest.function_handle_ids ?? publicationEdge?.functionHandleIds ?? publicationEdge?.function_handle_ids);
  const streamEpochCounters = latest.streamEpochCounters ?? latest.stream_epoch_counters ?? publicationEdge?.streamEpochCounters ?? publicationEdge?.stream_epoch_counters;
  const streamEpochCounterIds = streamEpochCounterEntries(streamEpochCounters).map(([streamId]) => streamId);
  const streamEpochCountersValid = streamEpochCounterIds.length > 0;
  const dispatchTableHashBefore = dispatchTableHashValue(
    latest.dispatchTableHashBefore,
    latest.dispatch_table_hash_before,
    publicationEdge?.dispatchTableHashBefore,
    publicationEdge?.dispatch_table_hash_before,
  );
  const dispatchTableHashAfter = dispatchTableHashValue(
    latest.dispatchTableHashAfter,
    latest.dispatch_table_hash_after,
    publicationEdge?.dispatchTableHashAfter,
    publicationEdge?.dispatch_table_hash_after,
  );
  const dispatchTableHash = dispatchTableHashValue(
    latest.dispatchTableHash,
    latest.dispatch_table_hash,
    publicationEdge?.dispatchTableHash,
    publicationEdge?.dispatch_table_hash,
  );
  const changedEntries = integerValue(
    latest.changedEntries
    ?? latest.changed_entries
    ?? publicationEdge?.changedEntries
    ?? publicationEdge?.changed_entries,
  );
  const dispatchTableHashBeforeObserved = dispatchTableHashBefore !== null;
  const dispatchTableHashAfterObserved = dispatchTableHashAfter !== null;
  const dispatchTableHashChanged =
    dispatchTableHashBeforeObserved
    && dispatchTableHashAfterObserved
    && dispatchTableHashBefore !== dispatchTableHashAfter;
  const dispatchTableHashMatchesAfter =
    dispatchTableHash === null || dispatchTableHash === dispatchTableHashAfter;
  const changedEntriesObserved = changedEntries !== null && changedEntries > 0;
  const dispatchTableMutationObserved =
    dispatchTableHashBeforeObserved
    && dispatchTableHashAfterObserved
    && dispatchTableHashChanged
    && dispatchTableHashMatchesAfter
    && changedEntriesObserved;
  const retirementFenceIds = compactStringList([
    ...(Array.isArray(latest.retirementFenceIds) ? latest.retirementFenceIds : []),
    ...(Array.isArray(latest.retirement_fence_ids) ? latest.retirement_fence_ids : []),
    ...(Array.isArray(publicationEdge?.retirementFenceIds) ? publicationEdge.retirementFenceIds : []),
    ...(Array.isArray(publicationEdge?.retirement_fence_ids) ? publicationEdge.retirement_fence_ids : []),
  ]).filter((id) => id.toLowerCase() !== 'none');
  const delayedUnloadResult = stringField(
    latest.delayedUnloadResult,
    latest.delayed_unload_result,
    publicationEdge?.delayedUnloadResult,
    publicationEdge?.delayed_unload_result,
  );
  const retirementStrategy = normalizedRetirementStrategy(stringField(
    latest.retirementStrategy,
    latest.retirement_strategy,
    publicationEdge?.retirementStrategy,
    publicationEdge?.retirement_strategy,
  ));
  const capsuleMetadataObserved =
    oldArtifactReferenceObserved(oldArtifactId, previousGeneration)
    && /^artifact:sha256:[0-9a-f]{64}$/i.test(newArtifactId)
    && /^sha256:[0-9a-f]{64}$/i.test(newArtifactHash)
    && newArtifactIdHash === newArtifactHashDigest
    && /^capsule:sha256:[0-9a-f]{64}$/i.test(capsuleId)
    && /^sha256:[0-9a-f]{64}$/i.test(abiMembraneHash)
    && /^sha256:[0-9a-f]{64}$/i.test(dependencyClosureHash)
    && /^sha256:[0-9a-f]{64}$/i.test(proofHash)
    && changedSymbols.length > 0
    && functionHandleIds.length > 0
    && streamEpochCountersValid;
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
  const runtimeSessionScoped = graphRuntimeSessionIds.length > 0;
  const runtimeSessionConsistent = graphRuntimeSessionIds.length === 1;
  const observed = nodes.length > 0 || edges.length > 0;
  const valid =
    observed
    && schemaVersionValid
    && runtimeSessionScoped
    && runtimeSessionConsistent
    && lineageValid
    && publishTimestampObserved
    && dispatchTableMutationObserved
    && previousGenerationId !== null
    && activeGenerationId !== null
    && nodeIdentitiesValid
    && nodeGenerations.has(previousGeneration)
    && nodeGenerations.has(activeGeneration)
    && edgeClosureValid
    && graphAcyclic
    && publicationEdgeObserved
    && retirementStateObserved
    && retirementEdgeObserved;
  const reason = valid
    ? null
    : !observed
      ? 'epoch_generation_graph_not_collected'
      : !schemaVersionValid
        ? 'epoch_generation_graph_schema_unverified'
        : !runtimeSessionScoped
          ? 'epoch_generation_graph_session_not_collected'
          : !runtimeSessionConsistent
          ? 'epoch_generation_graph_session_unscoped'
          : !lineageValid
            ? 'epoch_generation_graph_lineage_invalid'
            : !publishTimestampObserved
              ? 'epoch_generation_graph_publish_timestamp_missing'
              : !dispatchTableHashBeforeObserved || !dispatchTableHashAfterObserved
                ? 'epoch_generation_graph_dispatch_table_hash_missing'
                : !dispatchTableHashChanged
                  ? 'epoch_generation_graph_dispatch_table_hash_unchanged'
                  : !dispatchTableHashMatchesAfter
                    ? 'epoch_generation_graph_dispatch_table_hash_mismatch'
                    : !changedEntriesObserved
                      ? 'epoch_generation_graph_changed_entries_missing'
                      : !nodeIdentitiesValid
                        ? 'epoch_generation_graph_node_invalid'
                        : !nodeGenerations.has(previousGeneration) || !nodeGenerations.has(activeGeneration)
                          ? 'epoch_generation_graph_node_missing'
                          : !edgeClosureValid
                            ? 'epoch_generation_graph_edge_invalid'
                            : !graphAcyclic
                              ? 'epoch_generation_graph_cycle_detected'
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
    publishTimestamp,
    publishTimestampObserved,
    capsuleMetadataObserved,
    schemaVersionValid,
    nodeIdentitiesValid,
    edgeClosureValid,
    graphAcyclic,
    oldArtifactId,
    newArtifactId,
    newArtifactHash,
    capsuleId,
    fissionIslandId,
    abiMembraneHash,
    dependencyClosureHash,
    proofHash,
    streamEpochCounters,
    streamEpochCounterIds,
    streamEpochCountersValid,
    dispatchTableHashBefore,
    dispatchTableHashAfter,
    dispatchTableHash,
    changedEntries,
    dispatchTableHashBeforeObserved,
    dispatchTableHashAfterObserved,
    dispatchTableHashChanged,
    dispatchTableHashMatchesAfter,
    changedEntriesObserved,
    dispatchTableMutationObserved,
    retirementFenceIds,
    delayedUnloadResult,
    retirementStrategy,
    runtimeSessionIds: graphRuntimeSessionIds,
    runtimeSessionScoped,
    runtimeSessionConsistent,
    retirementState,
    retirementEdgeObserved,
  };
}

function runtimeHostIdentityEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) => /^worker-log:host_identity:/i.test(ref));
}

function runtimeHostIdentitySnapshotEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) => /^worker-log:host_identity_snapshot:/i.test(ref));
}

function hostIdentityRoleCategory(role) {
  const normalized = String(role ?? '').trim().toLowerCase();
  if (!normalized) return null;
  if (normalized.startsWith('launch_')) return null;
  if (
    normalized.includes('runner')
    || normalized.includes('process')
    || normalized.includes('runtime_session')
  ) {
    return 'runner_process';
  }
  if (
    normalized.includes('core')
    || normalized.includes('gui')
    || normalized.includes('renderer')
    || normalized.includes('module')
    || normalized.includes('host')
    || normalized.includes('state')
  ) {
    return 'host_state';
  }
  if (
    normalized.includes('allocation')
    || normalized.includes('buffer')
    || normalized.includes('stream')
    || normalized.includes('context')
    || normalized.includes('event')
  ) {
    return 'runtime_resource';
  }
  return null;
}

function hostIdentityRoleFromEvidenceRef(ref) {
  const value = String(ref ?? '');
  const direct = value.match(/^worker-log:host_identity:([^:]+)$/i);
  if (direct) return direct[1];
  const snapshotPrefix = 'worker-log:host_identity_snapshot:';
  if (!value.toLowerCase().startsWith(snapshotPrefix)) return null;
  const parts = value.slice(snapshotPrefix.length).split(':');
  return parts.length >= 2 ? parts.at(-2) : null;
}

function hostIdentityRoleCategoriesFromRefs(refs) {
  return [...new Set(
    compactStringList(refs)
      .map(hostIdentityRoleFromEvidenceRef)
      .map(hostIdentityRoleCategory)
      .filter(Boolean),
  )].sort();
}

function hostIdentityMissingRequiredCategories(identityRefs, snapshotRefs) {
  const required = ['host_state', 'runner_process', 'runtime_resource'];
  const identityCategories = hostIdentityRoleCategoriesFromRefs(identityRefs);
  const snapshotCategories = hostIdentityRoleCategoriesFromRefs(snapshotRefs);
  return required.filter(
    (category) => !identityCategories.includes(category) || !snapshotCategories.includes(category),
  );
}

function runtimeLaunchArgProvenanceEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) => /^worker-log:launch_arg_provenance:/i.test(ref));
}

function runtimeDispatchEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) => /^worker-log:synthi_gpu_launch:/i.test(ref));
}

function runtimeDispatchEvidenceRefSession(ref) {
  const prefix = 'worker-log:synthi_gpu_launch:';
  const value = String(ref ?? '');
  if (!value.toLowerCase().startsWith(prefix)) return null;
  const suffix = value.slice(prefix.length);
  const separator = suffix.lastIndexOf(':');
  if (separator <= 0) return null;
  const session = suffix.slice(0, separator).trim();
  return session || null;
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
    && runtimeHostIdentityEvidenceRefs(proof.identityEvidenceRefs).length > 0
    && runtimeHostIdentitySnapshotEvidenceRefs(proof.identitySnapshotEvidenceRefs).length > 0
    && hostIdentityMissingRequiredCategories(
      proof.runtimeIdentityEvidenceRefs ?? proof.identityEvidenceRefs,
      proof.runtimeIdentitySnapshotEvidenceRefs ?? proof.identitySnapshotEvidenceRefs,
    ).length === 0;
}

function originalHostPathProofUsable(proof) {
  if (!proof || typeof proof !== 'object') return false;
  return proof.attachmentProven === true
    && proof.runtimeEvidenceObserved === true
    && proof.dispatchBoundaryObserved === true
    && proof.dispatchEntryRuntimeVerified === true
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
    const command = String(record.command ?? record.extractorCommand ?? record.extractor_command ?? '').trim();
    const inputHash = String(record.inputHash ?? '').trim();
    const inputHashAccepted = /^sha256:[0-9a-f]{64}$/i.test(inputHash);
    const explicitlyRejected = record.acceptedByRuntimeCorrectnessPlan === false;
    return ACCEPTED_ABI_EXTRACTOR_KINDS.has(kind)
      && evidenceId
      && extractorName
      && extractorVersion
      && command
      && inputHashAccepted
      && !explicitlyRejected;
  });
  const refs = compactStringList(acceptedRecords.map((record) => String(record.evidenceId).trim()));
  const sources = compactStringList(
    acceptedRecords.map((record) => String(record.kind ?? record.extractorKind).trim()),
  );
  const commands = compactStringList(
    acceptedRecords.map((record) =>
      String(record.command ?? record.extractorCommand ?? record.extractor_command).trim()
    ),
  );
  const inputHashes = compactStringList(
    acceptedRecords.map((record) => String(record.inputHash).trim()),
  );
  const explicitRefsMatched = explicitRefs.length === 0
    || explicitRefs.every((ref) => refs.includes(ref));
  const explicitSourcesMatched = explicitSources.length === 0
    || explicitSources.every((source) => sources.includes(source));

  return {
    accepted: refs.length > 0 && explicitRefsMatched && explicitSourcesMatched,
    refs,
    sources,
    commands,
    inputHashes,
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
    && proof.verifierEvidenceObserved === true
    && proof.deterministicVerifierEvidenceObserved === true
    && proof.selectedIslandObserved === true
    && proof.selectedIslandContractObserved === true
    && proof.selectedIslandContractCoverageComplete === true
    && compactStringList(proof.evidenceRefs).length > 0;
}

const REQUIRED_FISSION_VERIFICATION_CATEGORIES = [
  'source_mapping',
  'include_closure',
  'symbol_ownership',
  'dependency_closure',
  'abi_membrane',
  'compile_recipe',
  'loader_capability',
  'output_oracle',
];

function selectedFissionContractCoverage(contract) {
  if (!contract || typeof contract !== 'object') {
    return { observed: false, complete: false };
  }
  const coverage = contract.verificationEvidenceCoverage;
  if (!coverage || typeof coverage !== 'object' || Array.isArray(coverage)) {
    return { observed: false, complete: false };
  }
  const missingCategories = Array.isArray(coverage.missingCategories)
    ? compactStringList(coverage.missingCategories)
    : null;
  const requiredCategories = compactStringList(coverage.requiredCategories);
  const categories = Array.isArray(coverage.categories) ? coverage.categories : null;
  const evidenceByCategory = new Map();
  if (categories) {
    for (const item of categories) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const category = compactStringList([item.category])[0];
      if (!category) continue;
      evidenceByCategory.set(category, compactStringList(item.evidenceIds));
    }
  }
  const requiredCategoriesComplete = REQUIRED_FISSION_VERIFICATION_CATEGORIES
    .every((category) => requiredCategories.includes(category));
  const categoryEvidenceComplete = REQUIRED_FISSION_VERIFICATION_CATEGORIES
    .every((category) => (evidenceByCategory.get(category) ?? []).length > 0);
  return {
    observed: true,
    complete:
      Array.isArray(missingCategories)
      && missingCategories.length === 0
      && requiredCategoriesComplete
      && categoryEvidenceComplete,
  };
}

function selectedFissionContractsCoverage(contracts) {
  if (!Array.isArray(contracts) || contracts.length === 0) {
    return { observed: false, complete: false };
  }
  const coverage = contracts.map(selectedFissionContractCoverage);
  return {
    observed: coverage.every((item) => item.observed),
    complete: coverage.every((item) => item.complete),
  };
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
    && (proof.ramBlobIdentityProven === true || proof.ram_blob_identity_proven === true)
    && evidenceRefs.length > 0;
}

function artifactIdsFromSha256Hashes(values) {
  return compactStringList(values)
    .map((value) => value.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null)
    .filter(Boolean)
    .map((digest) => `artifact:sha256:${digest}`);
}

function artifactIdsFromTransportProof(proof) {
  if (!proof || typeof proof !== 'object') return [];
  return contentAddressedArtifactIds([
    ...(Array.isArray(proof.selectedArtifactIds) ? proof.selectedArtifactIds : []),
    ...(Array.isArray(proof.selected_artifact_ids) ? proof.selected_artifact_ids : []),
    ...(Array.isArray(proof.ramBlobIds) ? proof.ramBlobIds : []),
    ...(Array.isArray(proof.ram_blob_ids) ? proof.ram_blob_ids : []),
    ...artifactIdsFromSha256Hashes([
      ...(Array.isArray(proof.artifactContentHashes) ? proof.artifactContentHashes : []),
      ...(Array.isArray(proof.artifact_content_hashes) ? proof.artifact_content_hashes : []),
      ...(Array.isArray(proof.ramBytesHashes) ? proof.ramBytesHashes : []),
      ...(Array.isArray(proof.ram_bytes_hashes) ? proof.ram_bytes_hashes : []),
    ]),
  ]);
}

function artifactIdsFromSourceProof(proof) {
  if (!proof || typeof proof !== 'object') return [];
  return contentAddressedArtifactIds([
    ...(Array.isArray(proof.artifactIds) ? proof.artifactIds : []),
    ...(Array.isArray(proof.artifact_ids) ? proof.artifact_ids : []),
    ...(Array.isArray(proof.selectedArtifactIds) ? proof.selectedArtifactIds : []),
    ...(Array.isArray(proof.selected_artifact_ids) ? proof.selected_artifact_ids : []),
    proof.artifactId,
    proof.artifact_id,
    proof.selectedArtifactId,
    proof.selected_artifact_id,
  ]);
}

function artifactIdsFromEpochProof(proof) {
  if (!proof || typeof proof !== 'object') return [];
  const graph = proof.epochGenerationGraph && typeof proof.epochGenerationGraph === 'object'
    ? proof.epochGenerationGraph
    : proof.generationGraph && typeof proof.generationGraph === 'object'
      ? proof.generationGraph
      : {};
  const publication = graph.latestPublication && typeof graph.latestPublication === 'object'
    ? graph.latestPublication
    : {};
  const publishEdges = Array.isArray(graph.edges)
    ? graph.edges.filter((edge) => edge && typeof edge === 'object' && String(edge.kind ?? '').toLowerCase() === 'publish')
    : [];
  return contentAddressedArtifactIds([
    proof.newArtifactId,
    proof.new_artifact_id,
    proof.activeArtifactId,
    proof.active_artifact_id,
    proof.publishedArtifactId,
    proof.published_artifact_id,
    publication.newArtifactId,
    publication.new_artifact_id,
    publication.activeArtifactId,
    publication.active_artifact_id,
    publication.publishedArtifactId,
    publication.published_artifact_id,
    ...publishEdges.flatMap((edge) => [
      edge.newArtifactId,
      edge.new_artifact_id,
      edge.activeArtifactId,
      edge.active_artifact_id,
      edge.publishedArtifactId,
      edge.published_artifact_id,
    ]),
    ...artifactIdsFromSha256Hashes([
      proof.newArtifactHash,
      proof.new_artifact_hash,
      proof.newHash,
      proof.new_hash,
      publication.newArtifactHash,
      publication.new_artifact_hash,
      publication.newHash,
      publication.new_hash,
      ...publishEdges.flatMap((edge) => [
        edge.newArtifactHash,
        edge.new_artifact_hash,
        edge.newHash,
        edge.new_hash,
      ]),
    ]),
  ]);
}

function artifactIdsFromDispatchProof(proof) {
  if (!proof || typeof proof !== 'object') return [];
  return contentAddressedArtifactIds([
    ...(Array.isArray(proof.selectedArtifactIds) ? proof.selectedArtifactIds : []),
    ...(Array.isArray(proof.selected_artifact_ids) ? proof.selected_artifact_ids : []),
    ...(Array.isArray(proof.runtimeArtifactIds) ? proof.runtimeArtifactIds : []),
    ...(Array.isArray(proof.runtime_artifact_ids) ? proof.runtime_artifact_ids : []),
    proof.selectedArtifactId,
    proof.selected_artifact_id,
    proof.runtimeArtifactId,
    proof.runtime_artifact_id,
  ]);
}

function artifactIdsFromOutputProof(proof) {
  if (!proof || typeof proof !== 'object') return [];
  const oracle = proof.outputOracle && typeof proof.outputOracle === 'object' ? proof.outputOracle : {};
  return contentAddressedArtifactIds([
    proof.artifactId,
    proof.artifact_id,
    oracle.artifactId,
    oracle.artifact_id,
  ]);
}

function fullRuntimeArtifactIdentityProof({
  sourceProof,
  artifactTransportProof,
  epochProof,
  dispatchProof,
  outputProof,
  required,
}) {
  const artifactIdsByStage = {
    source: artifactIdsFromSourceProof(sourceProof),
    transport: artifactIdsFromTransportProof(artifactTransportProof),
    epoch: artifactIdsFromEpochProof(epochProof),
    dispatch: artifactIdsFromDispatchProof(dispatchProof),
    output: artifactIdsFromOutputProof(outputProof),
  };
  if (!required) {
    return {
      required: false,
      proven: true,
      degradedReason: null,
      artifactIdsByStage,
      commonArtifactIds: [],
      missingStages: [],
    };
  }
  const missingStages = Object.entries(artifactIdsByStage)
    .filter(([, ids]) => ids.length === 0)
    .map(([stage]) => stage);
  const stageSets = Object.values(artifactIdsByStage).map((ids) => new Set(ids));
  const [firstSet, ...remainingSets] = stageSets;
  const commonArtifactIds = [...(firstSet ?? new Set())]
    .filter((artifactId) => remainingSets.every((set) => set.has(artifactId)));
  const proven = missingStages.length === 0 && commonArtifactIds.length > 0;
  return {
    required: true,
    proven,
    degradedReason: proven
      ? null
      : missingStages.length > 0
        ? 'artifact_identity_evidence_not_collected'
        : 'artifact_identity_cross_stage_mismatch',
    artifactIdsByStage,
    commonArtifactIds,
    missingStages,
  };
}

export function classifyGpuHmrFissionProof(observation = {}) {
  const verifierEvidenceRefs = compactStringList([
    ...(Array.isArray(observation.verifierEvidenceRefs) ? observation.verifierEvidenceRefs : []),
  ]);
  const deterministicVerifierEvidenceRefs = compactStringList([
    ...(Array.isArray(observation.deterministicVerifierEvidenceRefs)
      ? observation.deterministicVerifierEvidenceRefs
      : []),
    ...(Array.isArray(observation.deterministicEvidenceRefs)
      ? observation.deterministicEvidenceRefs
      : []),
  ]);
  const aiProposalIds = compactStringList([
    observation.aiProposalId,
    ...(Array.isArray(observation.aiProposalIds) ? observation.aiProposalIds : []),
  ]);
  const aiProposalDeterministicPromotionEvidenceRefs = compactStringList([
    ...(Array.isArray(observation.aiProposalDeterministicPromotionEvidenceRefs)
      ? observation.aiProposalDeterministicPromotionEvidenceRefs
      : []),
    ...(Array.isArray(observation.aiProposalPromotionEvidenceRefs)
      ? observation.aiProposalPromotionEvidenceRefs
      : []),
  ]);
  const nonAuthoritativeEvidenceRefs = compactStringList([
    ...(Array.isArray(observation.nonAuthoritativeEvidenceRefs)
      ? observation.nonAuthoritativeEvidenceRefs
      : []),
  ]);
  const selectedIslandIds = compactStringList([
    observation.selectedIslandId,
    ...(Array.isArray(observation.selectedIslandIds) ? observation.selectedIslandIds : []),
  ]);
  const selectedIslandObserved = selectedIslandIds.length > 0;
  const selectedIslandContracts = Array.isArray(observation.selectedIslandContracts)
    ? observation.selectedIslandContracts.filter((contract) => contract && typeof contract === 'object')
    : [];
  const selectedIslandContractObserved = selectedIslandContracts.length > 0;
  const selectedIslandContractCoverage = selectedFissionContractsCoverage(selectedIslandContracts);
  const selectedIslandContractCoverageObserved = selectedIslandContractCoverage.observed;
  const selectedIslandContractCoverageComplete = selectedIslandContractCoverage.complete;
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
    ...verifierEvidenceRefs,
  ]);
  const evidenceObserved = observation.evidenceObserved === true || evidenceRefs.length > 0;
  const verifierEvidenceObserved = verifierEvidenceRefs.length > 0;
  const deterministicVerifierEvidenceObserved = deterministicVerifierEvidenceRefs.length > 0;
  const aiProposalPromotionRequired =
    observation.aiProposalIdRequired === true || aiProposalIds.length > 0;
  const aiProposalPromotionObserved =
    !aiProposalPromotionRequired || aiProposalDeterministicPromotionEvidenceRefs.length > 0;
  const observed = observation.observed === true
    || evidenceObserved
    || selectedIslandIds.length > 0
    || stageStatuses.length > 0
    || observation.passed === true
    || observation.verified === true
    || observation.accepted === true
    || observation.rejected === true;
  const required = observation.required === true || observed;
  const fissionProven = observed
    && evidenceObserved
    && verifierEvidenceObserved
    && deterministicVerifierEvidenceObserved
    && selectedIslandObserved
    && selectedIslandContractObserved
    && selectedIslandContractCoverageComplete
    && !rejectedStatusObserved
    && aiProposalPromotionObserved
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
          : !verifierEvidenceObserved
            ? 'fission_verifier_identity_not_collected'
            : !deterministicVerifierEvidenceObserved
              ? 'fission_deterministic_verifier_evidence_not_collected'
              : !selectedIslandObserved
                ? 'fission_selected_island_not_collected'
                : rejectedStatusObserved
                  ? 'fission_candidate_verifier_rejected'
                  : !selectedIslandContractObserved
                    ? 'fission_selected_island_contract_not_collected'
                    : !selectedIslandContractCoverageObserved
                      ? 'fission_selected_island_contract_coverage_not_collected'
                      : !selectedIslandContractCoverageComplete
                        ? 'fission_selected_island_contract_evidence_coverage_incomplete'
                    : !aiProposalPromotionObserved
                      ? 'fission_ai_proposal_deterministic_promotion_missing'
                      : 'fission_candidate_verification_not_proven';

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    required,
    observed,
    evidenceObserved,
    verifierEvidenceObserved,
    deterministicVerifierEvidenceObserved,
    selectedIslandObserved,
    selectedIslandContractObserved,
    selectedIslandContractCoverageObserved,
    selectedIslandContractCoverageComplete,
    fissionProven,
    resultState: fissionProven ? 'gpu-hmr-fission-candidate-proven' : null,
    degradedState: fissionProven || !required ? null : 'gpu-hmr-fission-unverified',
    degradedReason,
    evidenceRefs,
    verifierEvidenceRefs,
    deterministicVerifierEvidenceRefs,
    nonAuthoritativeEvidenceRefs,
    aiProposalIds,
    aiProposalPromotionRequired,
    aiProposalDeterministicPromotionEvidenceRefs,
    selectedIslandIds,
    selectedIslandContracts,
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
      aiBlessingAllowed: false,
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

function oraclePassedValue(rawOracle = {}) {
  const raw = rawOracle.passed ?? rawOracle.pass ?? rawOracle.ok ?? null;
  if (raw === true || raw === 'true') return true;
  if (raw === false || raw === 'false') return false;
  const status = typeof rawOracle.status === 'string' && rawOracle.status.trim()
    ? rawOracle.status.trim().toLowerCase()
    : null;
  if (['pass', 'passed', 'accepted', 'ok'].includes(status)) return true;
  if (['fail', 'failed', 'rejected', 'error'].includes(status)) return false;
  return null;
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
  const dispatchRuntimeSessionIds = compactStringList(dispatchProof?.runtimeSessionIds);
  const dispatchTimestamps = finiteNonNegativeNumberList(
    dispatchProof?.dispatchTimestamps
    ?? dispatchProof?.dispatch_timestamps
    ?? dispatchProof?.dispatchTimestamp
    ?? dispatchProof?.dispatch_timestamp
    ?? dispatchProof?.dispatchTimestampMs
    ?? dispatchProof?.dispatch_timestamp_ms
    ?? [],
  );
  const latestDispatchTimestamp = dispatchTimestamps.length ? Math.max(...dispatchTimestamps) : null;
  const dispatchTimestampObserved = latestDispatchTimestamp !== null;
  const rawOracle = observation.outputOracle && typeof observation.outputOracle === 'object'
    ? observation.outputOracle
    : {};
  const hasExpected = Object.prototype.hasOwnProperty.call(rawOracle, 'expected');
  const hasActual = Object.prototype.hasOwnProperty.call(rawOracle, 'actual');
  const oracleId = stringField(
    rawOracle.oracleId,
    rawOracle.oracle_id,
    rawOracle.id,
    rawOracle.editContractId,
    rawOracle.edit_contract_id,
  );
  const requiredOracleId = stringField(
    rawOracle.requiredOracleId,
    rawOracle.required_oracle_id,
    rawOracle.requiredOracle,
    rawOracle.required_oracle,
    observation.requiredOracleId,
    observation.required_oracle_id,
  );
  const oracleContractIdObserved = oracleId !== null;
  const oracleRequiredContractObserved = requiredOracleId !== null;
  const oracleRequiredContractMatched =
    oracleRequiredContractObserved
    && oracleId !== null
    && oracleId === requiredOracleId;
  const oracleReportedPassed = oraclePassedValue(rawOracle);
  const oraclePassStatusObserved = oracleReportedPassed !== null;
  const oraclePassStatusPassed = oracleReportedPassed === true;
  const oracleKind = typeof rawOracle.kind === 'string' && rawOracle.kind.trim()
    ? rawOracle.kind.trim()
    : null;
  const oracleKindAccepted = gpuHmrOutputOracleKindAccepted(oracleKind);
  const rawOracleEvidenceRefs = compactStringList(rawOracle.evidenceRefs);
  const oracleEvidenceRefs = runtimeOutputOracleEvidenceRefs(rawOracleEvidenceRefs);
  const rejectedOracleEvidenceRefs = rawOracleEvidenceRefs.filter((ref) => !oracleEvidenceRefs.includes(ref));
  const oracleEvidenceObserved = oracleEvidenceRefs.length > 0;
  const probeContract = gpuHmrProbeContract(rawOracle, observation, oracleEvidenceRefs);
  const probeContractComplete = probeContract.complete;
  const oracleProducer = typeof rawOracle.producer === 'string' && rawOracle.producer.trim()
    ? rawOracle.producer.trim()
    : null;
  const oracleOutputTargetId = typeof rawOracle.outputTargetId === 'string' && rawOracle.outputTargetId.trim()
    ? rawOracle.outputTargetId.trim()
    : typeof rawOracle.outputTarget === 'string' && rawOracle.outputTarget.trim()
      ? rawOracle.outputTarget.trim()
      : null;
  const rawOracleReadbackTimestamp =
    rawOracle.readbackTimestamp ?? rawOracle.readback_timestamp ?? rawOracle.readbackTs ?? rawOracle.readback_ts ?? null;
  const oracleReadbackTimestamp = finiteNonNegativeNumber(rawOracleReadbackTimestamp);
  const oracleReadbackTimestampObserved = oracleReadbackTimestamp !== null;
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
  const dispatchArtifactIds = dispatchRuntimeArtifactIdsFromProof(dispatchProof);
  const oracleArtifactMatchesDispatch =
    oracleArtifactId !== null
    && dispatchArtifactIds.length > 0
    && dispatchArtifactIds.includes(oracleArtifactId);
  const oracleProvenanceComplete =
    oracleProducer !== null
    && oracleOutputTargetId !== null
    && oracleReadbackTimestampObserved
    && oracleRuntimeSessionId !== null
    && oracleArtifactId !== null;
  const oracleRuntimeSessionMatchesDispatch =
    oracleRuntimeSessionId !== null
    && (dispatchRuntimeSessionIds.length === 0 || dispatchRuntimeSessionIds.includes(oracleRuntimeSessionId));
  const oracleReadbackAfterDispatch =
    dispatchTimestampObserved
    && oracleReadbackTimestampObserved
    && oracleReadbackTimestamp >= latestDispatchTimestamp;
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
    && oracleRuntimeSessionMatchesDispatch
    && oracleArtifactMatchesDispatch
    && oracleReadbackAfterDispatch
    && probeContractComplete
    && oracleValuesCompatible
    && oracleContractIdObserved
    && oracleRequiredContractObserved
    && oracleRequiredContractMatched
    && oraclePassStatusPassed
    && observation.deterministicOraclePassed === true;
  const outputOracle = {
    provided: deterministicOracleProvided,
    observed: deterministicOutputObserved,
    passed: deterministicOraclePassed,
    evidenceObserved: oracleEvidenceObserved,
    provenanceComplete: oracleProvenanceComplete,
    runtimeSessionMatchesDispatch: oracleRuntimeSessionMatchesDispatch,
    dispatchTimestampObserved,
    dispatchTimestamps,
    latestDispatchTimestamp,
    readbackAfterDispatch: oracleReadbackAfterDispatch,
    producer: oracleProducer,
    outputTargetId: oracleOutputTargetId,
    readbackTimestamp: oracleReadbackTimestampObserved ? oracleReadbackTimestamp : null,
    runtimeSessionId: oracleRuntimeSessionId,
    artifactId: oracleArtifactId,
    artifactMatchesDispatch: oracleArtifactMatchesDispatch,
    dispatchArtifactIds,
    valuesCompatible: oracleValuesCompatible,
    oracleId,
    requiredOracleId,
    contractIdObserved: oracleContractIdObserved,
    requiredContractObserved: oracleRequiredContractObserved,
    requiredContractMatched: oracleRequiredContractMatched,
    passStatusObserved: oraclePassStatusObserved,
    reportedPassed: oracleReportedPassed,
    kind: oracleKind,
    kindAccepted: oracleKindAccepted,
    expected: hasExpected ? rawOracle.expected : null,
    actual: hasActual ? rawOracle.actual : null,
    tolerance: Object.prototype.hasOwnProperty.call(rawOracle, 'tolerance') ? rawOracle.tolerance : null,
    exactValueMatch: valueCompatibility.exact,
    toleranceApplied: valueCompatibility.toleranceApplied,
    toleranceValid: valueCompatibility.toleranceValid,
    evidenceRefs: oracleEvidenceRefs,
    rejectedEvidenceRefs: rejectedOracleEvidenceRefs,
    probeContract,
    probeContractComplete,
  };
  const visualFrameObserved = observation.visualFrameObserved === true;
  const evidenceRefs = Array.isArray(observation.evidenceRefs)
    ? observation.evidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const visualEvidenceRefs = compactStringList([
    ...(Array.isArray(observation.visualEvidenceRefs) ? observation.visualEvidenceRefs : []),
    ...(Array.isArray(rawOracle.visualEvidenceRefs) ? rawOracle.visualEvidenceRefs : []),
    ...(Array.isArray(rawOracle.visual_evidence_refs) ? rawOracle.visual_evidence_refs : []),
    rawOracle.visualEvidenceRef,
    rawOracle.visual_evidence_ref,
    rawOracle.visualRef,
    rawOracle.visual_ref,
  ]);
  const renderVisualEvidenceRequired =
    oracleKind !== null
    && RENDER_OUTPUT_ORACLE_KINDS.has(oracleKind.trim().toLowerCase());
  const visualEvidenceRequired =
    observation.visualEvidenceRequired === true || renderVisualEvidenceRequired;
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
      renderVisualEvidenceRequired,
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
        renderVisualEvidenceRequired,
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
      renderVisualEvidenceRequired,
      visualEvidenceComplete,
      evidenceRefs,
      visualEvidenceRefs,
      dispatchProof,
    };
  }

  const oraclePayloadOtherwisePassed =
    deterministicOutputObserved
    && deterministicOracleProvided
    && oracleValuesCompatible
    && observation.deterministicOraclePassed === true;
  const degradedState = visualFrameObserved
    ? 'gpu-hmr-visual-only'
    : 'gpu-hmr-output-unobserved';
  const degradedReason = oracleKind !== null && !oracleKindAccepted
    ? 'output_oracle_kind_unaccepted'
    : oraclePayloadOtherwisePassed && rawOracleEvidenceRefs.length > 0 && !oracleEvidenceObserved
      ? 'output_oracle_evidence_unaccepted'
      : oraclePayloadOtherwisePassed && !oracleEvidenceObserved
        ? 'output_oracle_evidence_missing'
          : oraclePayloadOtherwisePassed && !oracleProvenanceComplete
            ? 'output_oracle_provenance_incomplete'
            : oraclePayloadOtherwisePassed && !oracleRuntimeSessionMatchesDispatch
              ? 'output_oracle_session_mismatch'
              : oraclePayloadOtherwisePassed && !oracleArtifactMatchesDispatch
                ? 'output_oracle_artifact_mismatch'
                : oraclePayloadOtherwisePassed && !dispatchTimestampObserved
                  ? 'output_oracle_dispatch_timestamp_missing'
                  : oraclePayloadOtherwisePassed && !oracleReadbackAfterDispatch
                    ? 'output_oracle_precedes_dispatch'
                    : oraclePayloadOtherwisePassed && !probeContractComplete
                      ? 'output_oracle_probe_contract_missing'
                      : oraclePayloadOtherwisePassed && !oracleContractIdObserved
                        ? 'output_oracle_contract_id_missing'
                        : oraclePayloadOtherwisePassed && !oracleRequiredContractObserved
                          ? 'output_oracle_required_contract_id_missing'
                          : oraclePayloadOtherwisePassed && !oracleRequiredContractMatched
                            ? 'output_oracle_contract_mismatch'
                            : oraclePayloadOtherwisePassed && !oraclePassStatusObserved
                              ? 'output_oracle_pass_status_missing'
                              : oraclePayloadOtherwisePassed && !oraclePassStatusPassed
                                ? 'output_oracle_reported_failed'
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
    renderVisualEvidenceRequired,
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
  const probe = proof.outputOracle?.probeContractComplete
    ? ` probe=${proof.outputOracle.probeContract?.mode ?? 'declared'}`
    : '';
  const visual = proof.visualFrameObserved ? ' visual=fresh-frame' : ' visual=none';
  return `gpu_output_proof=${result}${degraded}${reason}${oracle}${probe}${visual}`;
}

function gpuHmrProbeContract(rawOracle = {}, observation = {}, acceptedOracleEvidenceRefs = []) {
  const mode = stringField(
    rawOracle.probeMode,
    rawOracle.probe_mode,
    rawOracle.deterministicProbeMode,
    rawOracle.deterministic_probe_mode,
    observation.probeMode,
    observation.probe_mode,
  );
  const config = objectField(
    rawOracle.probeConfig,
    rawOracle.probe_config,
    rawOracle.deterministicProbeConfig,
    rawOracle.deterministic_probe_config,
    observation.probeConfig,
    observation.probe_config,
  );
  const configHash = stringField(
    rawOracle.probeConfigHash,
    rawOracle.probe_config_hash,
    rawOracle.deterministicProbeConfigHash,
    rawOracle.deterministic_probe_config_hash,
    observation.probeConfigHash,
    observation.probe_config_hash,
  );
  const rawEvidenceRefs = compactStringList([
    ...(Array.isArray(rawOracle.probeEvidenceRefs) ? rawOracle.probeEvidenceRefs : []),
    ...(Array.isArray(rawOracle.probe_evidence_refs) ? rawOracle.probe_evidence_refs : []),
    rawOracle.probeEvidenceRef,
    rawOracle.probe_evidence_ref,
    ...(Array.isArray(observation.probeEvidenceRefs) ? observation.probeEvidenceRefs : []),
    ...(Array.isArray(observation.probe_evidence_refs) ? observation.probe_evidence_refs : []),
    observation.probeEvidenceRef,
    observation.probe_evidence_ref,
  ]);
  const acceptedProbeEvidenceRefs = runtimeOutputOracleEvidenceRefs(rawEvidenceRefs);
  const evidenceRefs = acceptedProbeEvidenceRefs.length
    ? acceptedProbeEvidenceRefs
    : acceptedOracleEvidenceRefs;
  const configHashValid = sha256DigestString(configHash);
  const configPresent = config !== null && Object.keys(config).length > 0;
  const complete = mode !== null
    && (configPresent || configHashValid)
    && evidenceRefs.length > 0;
  return {
    mode,
    configPresent,
    configHash: configHashValid ? configHash : null,
    configHashValid,
    evidenceRefs,
    complete,
  };
}

function stringField(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return null;
}

function objectField(...values) {
  for (const value of values) {
    if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length > 0) {
      return value;
    }
  }
  return null;
}

function sha256DigestString(value) {
  if (typeof value !== 'string') return false;
  const digest = value.trim().replace(/^sha256:/i, '');
  return /^[0-9a-f]{64}$/i.test(digest);
}

function abiHashTokenString(value) {
  if (typeof value !== 'string') return null;
  const token = value.trim();
  if (!token) return null;
  const lower = token.toLowerCase();
  if (
    ['unknown', 'unavailable', 'missing', 'none', 'null', 'undefined', 'n/a'].includes(lower)
    || /^0+$/.test(token)
  ) {
    return null;
  }
  if (sha256DigestString(token)) return token;
  if (/^[0-9]{16,20}$/.test(token)) return token;
  if (/^[0-9a-f]{16,63}$/i.test(token) && /[a-f]/i.test(token)) return token;
  if (/^[a-z0-9][a-z0-9:+._-]{15,}$/i.test(token) && /[0-9]/.test(token)) return token;
  return null;
}

function abiHashList(...values) {
  const hashes = [];
  const visit = (value) => {
    if (Array.isArray(value)) {
      value.forEach(visit);
      return;
    }
    const token = abiHashTokenString(value);
    if (token) hashes.push(token);
  };
  values.forEach(visit);
  return [...new Set(hashes)];
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
  const rawDispatchEvidenceRefs = runtimeDispatchEvidenceRefs([
    ...(Array.isArray(observation.dispatchEvidenceRefs) ? observation.dispatchEvidenceRefs : []),
    ...(Array.isArray(observation.runtimeDispatchEvidenceRefs) ? observation.runtimeDispatchEvidenceRefs : []),
    ...(Array.isArray(observation.evidenceRefs) ? observation.evidenceRefs : []),
  ]);
  const dispatchEvidenceRefs = runtimeSessionIds.length > 0
    ? rawDispatchEvidenceRefs.filter((ref) => runtimeSessionIds.includes(runtimeDispatchEvidenceRefSession(ref)))
    : [];
  const dispatchEvidenceSessionMismatch =
    rawDispatchEvidenceRefs.length > 0 && dispatchEvidenceRefs.length === 0 && runtimeSessionIds.length > 0;
  const dispatchEvidenceObserved = dispatchEvidenceRefs.length > 0;
  const argProvenanceObserved = observation.argProvenanceObserved === true;
  const unknownArgCount = Number.isFinite(observation.unknownArgCount)
    ? Math.max(0, Number(observation.unknownArgCount))
    : 0;
  const argProvenanceEvidenceRefs = runtimeLaunchArgProvenanceEvidenceRefs([
    ...(Array.isArray(observation.argProvenanceEvidenceRefs) ? observation.argProvenanceEvidenceRefs : []),
    ...(Array.isArray(observation.argumentProvenanceEvidenceRefs) ? observation.argumentProvenanceEvidenceRefs : []),
  ]);
  const argProvenanceEvidenceObserved = argProvenanceEvidenceRefs.length > 0;
  const argProvenanceRecords = normalizeArgProvenanceRecords(firstArrayField(observation, [
    'argProvenanceRecords',
    'argumentProvenanceRecords',
    'arg_provenance_records',
    'argument_provenance_records',
  ]));
  const argProvenanceKnownArgCount = integerValue(
    observation.knownArgCount
    ?? observation.known_arg_count
    ?? observation.argProvenanceKnownArgCount
    ?? observation.arg_provenance_known_arg_count,
  );
  const argProvenanceRecordIntegrityComplete =
    argProvenanceRecords.length > 0 && argProvenanceRecords.every(argRecordRuntimeProven);
  const argProvenanceRecordComplete = argProvenanceRecordsComplete(observation, argProvenanceRecords);
  const argProvenanceRecordCoverageRequired =
    argProvenanceKnownArgCount !== null
    && argProvenanceKnownArgCount > 0
    && !argProvenanceRecordsHaveLaunchGroupCounts(argProvenanceRecords);
  const argProvenanceKnownArgCoverageComplete =
    !argProvenanceRecordCoverageRequired
    || argProvenanceRecords.length >= argProvenanceKnownArgCount;
  const argProvenanceRecordCoverageComplete =
    !argProvenanceRecordCoverageRequired
    || (argProvenanceRecordIntegrityComplete && argProvenanceKnownArgCoverageComplete);
  const argProvenanceComplete =
    (
      observation.argProvenanceComplete === true
      || observation.argumentProvenanceComplete === true
      || argProvenanceRecordComplete
    )
    && argProvenanceRecordCoverageComplete;
  const abiProof = observation.abiProof && typeof observation.abiProof === 'object'
    ? observation.abiProof
    : null;
  const epochProof = observation.epochProof && typeof observation.epochProof === 'object'
    ? observation.epochProof
    : null;
  const abiProven = observation.abiProven === true || proofMeets(abiProof, 'gpu-hmr-abi-proven');
  const epochSwapProven =
    observation.epochSwapProven === true || proofMeets(epochProof, 'gpu-hmr-epoch-swap-proven');
  const abiProofEvidenceRefs = compactStringList([
    ...(Array.isArray(observation.abiProofEvidenceRefs) ? observation.abiProofEvidenceRefs : []),
    ...(Array.isArray(abiProof?.evidenceRefs) ? abiProof.evidenceRefs : []),
  ]);
  const epochProofEvidenceRefs = compactStringList([
    ...(Array.isArray(observation.epochProofEvidenceRefs) ? observation.epochProofEvidenceRefs : []),
    ...(Array.isArray(epochProof?.evidenceRefs) ? epochProof.evidenceRefs : []),
  ]);
  const abiProofEvidenceObserved = abiProofEvidenceRefs.length > 0;
  const epochProofEvidenceObserved = epochProofEvidenceRefs.length > 0;
  const evidenceRefs = compactStringList([
    ...dispatchEvidenceRefs,
    ...argProvenanceEvidenceRefs,
    ...abiProofEvidenceRefs,
    ...epochProofEvidenceRefs,
  ]);
  const streamOrderingProven = observation.streamOrderingProven === true;
  const replacementScopeProven = observation.replacementScopeProven === true;
  const runtimeTouchedSymbolsMatch = observation.runtimeTouchedSymbolsMatch !== false;
  const runtimeArtifactMatchesSelected = observation.runtimeArtifactMatchesSelected === true;
  const selectedArtifactIds = contentAddressedArtifactIds(observation.selectedArtifactIds);
  const runtimeArtifactIds = contentAddressedArtifactIds(observation.runtimeArtifactIds);
  const dispatcherRegistrationIds = compactStringList(observation.dispatcherRegistrationIds);
  const dispatchTableEntryIds = compactStringList(observation.dispatchTableEntryIds);
  const dispatchTableHashes = compactStringList(observation.dispatchTableHashes);
  const dispatchStreamIds = compactStringList(firstArrayField(observation, [
    'dispatchStreamIds',
    'dispatch_stream_ids',
    'streamIds',
    'stream_ids',
  ]));
  const gridDimensions = compactStringList(firstArrayField(observation, [
    'gridDimensions',
    'grid_dimensions',
    'dispatchGridDimensions',
    'dispatch_grid_dimensions',
  ]));
  const blockDimensions = compactStringList(firstArrayField(observation, [
    'blockDimensions',
    'block_dimensions',
    'dispatchBlockDimensions',
    'dispatch_block_dimensions',
  ]));
  const sharedMemoryBytes = finiteNonNegativeNumberList(
    observation.sharedMemoryBytes
    ?? observation.shared_memory_bytes
    ?? observation.dispatchSharedMemoryBytes
    ?? observation.dispatch_shared_memory_bytes
    ?? [],
  );
  const dispatchTimestamps = finiteNonNegativeNumberList(
    observation.dispatchTimestamps
    ?? observation.dispatch_timestamps
    ?? observation.dispatchTimestamp
    ?? observation.dispatch_timestamp
    ?? observation.dispatchTimestampMs
    ?? observation.dispatch_timestamp_ms
    ?? [],
  );

  if (
    !dispatchObserved
    || dispatchFailureObserved
    || !sessionScoped
    || !runtimeSessionConsistent
    || !dispatchEvidenceObserved
  ) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: null,
      degradedState: 'gpu-hmr-dispatch-unobserved',
      degradedReason: !dispatchObserved
        ? 'runtime_dispatch_not_observed'
        : dispatchFailureObserved
          ? 'current_session_dispatch_failed'
        : !sessionScoped
          ? requestedSessionScoped && !runtimeSessionObserved
            ? 'runtime_session_identity_not_collected'
            : 'current_session_dispatch_not_proven'
          : !runtimeSessionConsistent
            ? 'runtime_session_identity_inconsistent'
            : dispatchEvidenceSessionMismatch
              ? 'runtime_dispatch_evidence_session_mismatch'
              : 'runtime_dispatch_evidence_refs_not_collected',
      dispatchObserved: false,
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      rejectedDispatchEvidenceRefs: rawDispatchEvidenceRefs.filter((ref) => !dispatchEvidenceRefs.includes(ref)),
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved,
      argProvenanceComplete: false,
      argProvenanceEvidenceObserved,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete: false,
      argProvenanceRecords,
      unknownArgCount,
    };
  }

  if (!argProvenanceObserved || !argProvenanceComplete || unknownArgCount > 0) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-unknown-arg-provenance',
      degradedReason: argProvenanceObserved
        ? argProvenanceRecordCoverageRequired && !argProvenanceRecordIntegrityComplete
          ? 'launch_argument_provenance_records_incomplete'
          : argProvenanceRecordCoverageRequired && !argProvenanceKnownArgCoverageComplete
          ? 'launch_argument_provenance_record_coverage_incomplete'
          : 'launch_argument_provenance_incomplete'
        : 'launch_argument_provenance_not_collected',
      dispatchObserved: true,
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved,
      argProvenanceComplete: false,
      argProvenanceEvidenceObserved,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete: false,
      argProvenanceRecords,
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
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: false,
      argProvenanceEvidenceObserved: false,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete: false,
      argProvenanceRecords,
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
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete,
      argProvenanceRecords,
      unknownArgCount: 0,
      abiProven: false,
      abiProofEvidenceObserved,
      abiProofEvidenceRefs,
      epochSwapProven,
      epochProofEvidenceObserved,
      epochProofEvidenceRefs,
      streamOrderingProven,
      replacementScopeProven,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
      selectedArtifactIds,
      runtimeArtifactIds,
      dispatcherRegistrationIds,
      dispatchTableEntryIds,
      dispatchTableHashes,
      dispatchStreamIds,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes,
    };
  }

  if (!abiProofEvidenceObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-abi-unverified',
      degradedReason: 'dispatch_abi_proof_evidence_refs_not_collected',
      dispatchObserved: true,
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete,
      argProvenanceRecords,
      unknownArgCount: 0,
      abiProven: true,
      abiProofEvidenceObserved: false,
      abiProofEvidenceRefs,
      epochSwapProven,
      epochProofEvidenceObserved,
      epochProofEvidenceRefs,
      streamOrderingProven,
      replacementScopeProven,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
      selectedArtifactIds,
      runtimeArtifactIds,
      dispatcherRegistrationIds,
      dispatchTableEntryIds,
      dispatchTableHashes,
      dispatchStreamIds,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes,
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
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete,
      argProvenanceRecords,
      unknownArgCount: 0,
      abiProven: true,
      abiProofEvidenceObserved: true,
      abiProofEvidenceRefs,
      epochSwapProven,
      epochProofEvidenceObserved,
      epochProofEvidenceRefs,
      streamOrderingProven,
      replacementScopeProven,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
      selectedArtifactIds,
      runtimeArtifactIds,
      dispatcherRegistrationIds,
      dispatchTableEntryIds,
      dispatchTableHashes,
      dispatchStreamIds,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes,
    };
  }

  if (!epochProofEvidenceObserved) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-epoch-swap-unverified',
      degradedReason: 'dispatch_epoch_proof_evidence_refs_not_collected',
      dispatchObserved: true,
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete,
      argProvenanceRecords,
      unknownArgCount: 0,
      abiProven: true,
      abiProofEvidenceObserved: true,
      abiProofEvidenceRefs,
      epochSwapProven: true,
      epochProofEvidenceObserved: false,
      epochProofEvidenceRefs,
      streamOrderingProven: true,
      replacementScopeProven: true,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
      selectedArtifactIds,
      runtimeArtifactIds,
      dispatcherRegistrationIds,
      dispatchTableEntryIds,
      dispatchTableHashes,
      dispatchStreamIds,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes,
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
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete,
      argProvenanceRecords,
      unknownArgCount: 0,
      abiProven: true,
      abiProofEvidenceObserved: true,
      abiProofEvidenceRefs,
      epochSwapProven: true,
      epochProofEvidenceObserved: true,
      epochProofEvidenceRefs,
      streamOrderingProven: true,
      replacementScopeProven: true,
      runtimeTouchedSymbolsMatch,
      runtimeArtifactMatchesSelected,
      selectedArtifactIds,
      runtimeArtifactIds,
      dispatcherRegistrationIds,
      dispatchTableEntryIds,
      dispatchTableHashes,
      dispatchStreamIds,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes,
      dispatchTimestamps,
    };
  }

  if (!argProvenanceRecordComplete) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-unknown-arg-provenance',
      degradedReason: 'launch_argument_provenance_records_incomplete',
      dispatchObserved: true,
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: false,
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete: false,
      argProvenanceRecords,
      unknownArgCount: 0,
      abiProven: true,
      abiProofEvidenceObserved: true,
      abiProofEvidenceRefs,
      epochSwapProven: true,
      epochProofEvidenceObserved: true,
      epochProofEvidenceRefs,
      streamOrderingProven: true,
      replacementScopeProven: true,
      runtimeTouchedSymbolsMatch: true,
      runtimeArtifactMatchesSelected: true,
      selectedArtifactIds,
      runtimeArtifactIds,
      dispatcherRegistrationIds,
      dispatchTableEntryIds,
      dispatchTableHashes,
      dispatchStreamIds,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes,
      dispatchTimestamps,
    };
  }

  const dispatchIdentityDegradedReason = (() => {
    if (!selectedArtifactIds.length) return 'selected_artifact_identity_not_observed';
    if (!runtimeArtifactIds.length) return 'runtime_artifact_identity_not_observed';
    if (!dispatcherRegistrationIds.length) return 'dispatcher_registration_identity_not_observed';
    if (!dispatchTableEntryIds.length) return 'dispatch_table_entry_identity_not_observed';
    if (!dispatchTableHashes.length) return 'dispatch_table_hash_not_observed';
    if (!dispatchTimestamps.length) return 'dispatch_timestamp_not_observed';
    if (!dispatchStreamIds.length) return 'dispatch_stream_identity_not_observed';
    if (!gridDimensions.length) return 'dispatch_grid_dimensions_not_observed';
    if (!blockDimensions.length) return 'dispatch_block_dimensions_not_observed';
    if (!sharedMemoryBytes.length) return 'dispatch_shared_memory_bytes_not_observed';
    return null;
  })();

  if (dispatchIdentityDegradedReason) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-dispatch-observed',
      degradedState: 'gpu-hmr-dispatch-unobserved',
      degradedReason: dispatchIdentityDegradedReason,
      dispatchObserved: true,
      dispatchEvidenceObserved,
      dispatchEvidenceRefs,
      evidenceRefs,
      sessionScoped,
      runtimeSessionObserved,
      runtimeSessionIds,
      runtimeSessionConsistent,
      argProvenanceObserved: true,
      argProvenanceComplete: true,
      argProvenanceEvidenceObserved: true,
      argProvenanceEvidenceRefs,
      argProvenanceRecordComplete: true,
      argProvenanceRecords,
      unknownArgCount: 0,
      abiProven: true,
      abiProofEvidenceObserved: true,
      abiProofEvidenceRefs,
      epochSwapProven: true,
      epochProofEvidenceObserved: true,
      epochProofEvidenceRefs,
      streamOrderingProven: true,
      replacementScopeProven: true,
      runtimeTouchedSymbolsMatch: true,
      runtimeArtifactMatchesSelected: true,
      selectedArtifactIds,
      runtimeArtifactIds,
      dispatcherRegistrationIds,
      dispatchTableEntryIds,
      dispatchTableHashes,
      dispatchStreamIds,
      gridDimensions,
      blockDimensions,
      sharedMemoryBytes,
      dispatchTimestamps,
    };
  }

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    resultState: 'gpu-hmr-dispatch-safe-proven',
    degradedState: null,
    degradedReason: null,
    dispatchObserved: true,
    dispatchEvidenceObserved,
    dispatchEvidenceRefs,
    evidenceRefs,
    sessionScoped,
    runtimeSessionObserved,
    runtimeSessionIds,
    runtimeSessionConsistent,
    argProvenanceObserved: true,
    argProvenanceComplete: true,
    argProvenanceEvidenceObserved: true,
    argProvenanceEvidenceRefs,
    argProvenanceRecordComplete: true,
    argProvenanceRecords,
    unknownArgCount: 0,
    abiProven: true,
    abiProofEvidenceObserved: true,
    abiProofEvidenceRefs,
    epochSwapProven: true,
    epochProofEvidenceObserved: true,
    epochProofEvidenceRefs,
    streamOrderingProven: true,
    replacementScopeProven: true,
    runtimeTouchedSymbolsMatch: true,
    runtimeArtifactMatchesSelected: true,
    selectedArtifactIds,
    runtimeArtifactIds,
    dispatcherRegistrationIds,
    dispatchTableEntryIds,
    dispatchTableHashes,
    dispatchStreamIds,
    gridDimensions,
    blockDimensions,
    sharedMemoryBytes,
    dispatchTimestamps,
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
    : ` safety=blocked abi=${proof.abiProven === true ? 'passed' : 'missing'} epoch=${proof.epochSwapProven === true ? 'passed' : 'missing'} stream=${proof.streamOrderingProven === true ? 'passed' : 'missing'} scope=${proof.replacementScopeProven === true ? 'passed' : 'missing'} artifact=${proof.runtimeArtifactMatchesSelected === true ? 'matched' : 'missing'}`;
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
  const kernelAbiFingerprintHashes = abiHashList(
    observation.kernelAbiFingerprintHash,
    observation.kernelAbiFingerprintHashes,
    observation.kernelAbiHash,
    observation.kernelAbiHashes,
  );
  const constantGlobalLayoutHashes = abiHashList(
    observation.constantGlobalLayoutHash,
    observation.constantGlobalLayoutHashes,
    observation.constantGlobalAbiHash,
    observation.constantGlobalAbiHashes,
  );
  const abiFingerprintHashesObserved =
    kernelAbiFingerprintHashes.length > 0 && constantGlobalLayoutHashes.length > 0;

  if (
    layoutSizeAlignmentVerified
    && acceptedExtractorProvenanceObserved
    && extractorProvenanceComplete
    && abiFingerprintHashesObserved
  ) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: 'gpu-hmr-abi-proven',
      degradedState: null,
      degradedReason: null,
      layoutSizeAlignmentVerified: true,
      abiFingerprintHashesObserved: true,
      kernelAbiFingerprintHashes,
      constantGlobalLayoutHashes,
      metadataObserved,
      acceptedExtractorProvenanceObserved: true,
      acceptedExtractorEvidenceRefs: acceptedExtractor.refs,
      acceptedExtractorSources: acceptedExtractor.sources,
      acceptedExtractorCommands: acceptedExtractor.commands,
      acceptedExtractorInputHashes: acceptedExtractor.inputHashes,
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
            : !extractorProvenanceComplete
              ? 'abi_extractor_provenance_incomplete'
              : 'abi_fingerprint_hashes_unverified')
      : 'abi_evidence_not_collected',
    layoutSizeAlignmentVerified,
    abiFingerprintHashesObserved,
    kernelAbiFingerprintHashes,
    constantGlobalLayoutHashes,
    metadataObserved,
    acceptedExtractorProvenanceObserved,
    acceptedExtractorEvidenceRefs: acceptedExtractor.refs,
    acceptedExtractorSources: acceptedExtractor.sources,
    acceptedExtractorCommands: acceptedExtractor.commands,
    acceptedExtractorInputHashes: acceptedExtractor.inputHashes,
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
  const hashes = proof.abiFingerprintHashesObserved ? ' hashes=observed' : ' hashes=unverified';
  return `gpu_abi_proof=${result}${degraded}${reason}${metadata}${layout}${extractor}${hashes}`;
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
    && runtimeSessionIds.length <= 1;
  const generationGraphObserved = epochGraph.observed;
  const generationGraphValid = epochGraph.valid;
  const generationGraphRuntimeSessionIds = epochGraph.runtimeSessionIds;
  const generationGraphRuntimeSessionScoped = epochGraph.runtimeSessionScoped === true;
  const schemaVersionValid = epochGraph.schemaVersionValid === true;
  const publishTimestampObserved = epochGraph.publishTimestampObserved === true;
  const nodeIdentitiesValid = epochGraph.nodeIdentitiesValid === true;
  const edgeClosureValid = epochGraph.edgeClosureValid === true;
  const graphAcyclic = epochGraph.graphAcyclic === true;
  const generationLineageObserved = generationGraphValid;
  const dispatchTableHashBeforeObserved = epochGraph.dispatchTableHashBefore !== null;
  const dispatchTableHashAfterObserved = epochGraph.dispatchTableHashAfter !== null;
  const dispatchTableHashChanged =
    dispatchTableHashBeforeObserved
    && dispatchTableHashAfterObserved
    && epochGraph.dispatchTableHashBefore !== epochGraph.dispatchTableHashAfter;
  const dispatchTableHashObserved =
    epochGraph.dispatchTableMutationObserved === true
    && dispatchTableHashBeforeObserved
    && dispatchTableHashAfterObserved
    && dispatchTableHashChanged;
  const changedEntriesObserved = epochGraph.changedEntries !== null && epochGraph.changedEntries > 0;
  const capsuleMetadataObserved =
    observation.capsuleMetadataObserved === true || epochGraph.capsuleMetadataObserved === true;
  const streamScope = typeof observation.streamScope === 'string' && observation.streamScope.trim()
    ? observation.streamScope.trim()
    : null;
  const streamIds = compactStringList(observation.streamIds);
  const streamScopeEvidenceObserved = streamScopeObserved(streamScope, streamIds);
  const streamOrderingRequested =
    observation.streamOrderingRequested === true || observation.streamOrderingProven === true;
  const streamEpochCountersMatchScope = streamEpochCountersCoverScope(
    streamScope,
    streamIds,
    epochGraph.streamEpochCounters,
  );
  const streamOrderingProven =
    streamOrderingRequested && streamScopeEvidenceObserved && streamEpochCountersMatchScope;
  const retirementFenceIds = compactStringList([
    ...(Array.isArray(observation.retirementFenceIds) ? observation.retirementFenceIds : []),
    ...(Array.isArray(observation.retirement_fence_ids) ? observation.retirement_fence_ids : []),
    ...(Array.isArray(epochGraph.retirementFenceIds) ? epochGraph.retirementFenceIds : []),
  ]).filter((id) => id.toLowerCase() !== 'none');
  const delayedUnloadResult = stringField(
    observation.delayedUnloadResult,
    observation.delayed_unload_result,
    epochGraph.delayedUnloadResult,
  );
  const retirementStrategy = inferredRetirementStrategy({
    explicitStrategy: stringField(
      observation.retirementStrategy,
      observation.retirement_strategy,
      epochGraph.retirementStrategy,
    ),
    streamScope,
    retirementFenceIds,
    delayedUnloadResult,
  });
  const conservativeDrainFallback = retirementStrategy === 'conservative_drain_fallback';
  const retirementFenceEvidenceRequired = streamScope !== 'none' && !conservativeDrainFallback;
  const retirementFenceEvidenceObserved =
    !retirementFenceEvidenceRequired || retirementFenceIds.length > 0;
  const delayedUnloadResultObserved = delayedUnloadResult !== null;
  const delayedUnloadResultTerminal = [
    'not_required',
    'no_old_generation',
    'unloaded',
    'retired',
  ].includes(String(delayedUnloadResult ?? '').trim().toLowerCase());
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
    && capsuleMetadataObserved
    && streamOrderingProven
    && retirementFenceEvidenceObserved
    && retirementTracked
    && oldGenerationRetired
    && delayedUnloadResultTerminal
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
      generationGraphRuntimeSessionIds,
      generationGraphRuntimeSessionScoped,
      schemaVersionValid,
      publishTimestampObserved,
      nodeIdentitiesValid,
      edgeClosureValid,
      graphAcyclic,
      epochGenerationGraph: epochGraph.graph,
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      capsuleMetadataObserved,
      streamOrderingProven: true,
      streamScope,
      streamIds,
      streamEpochCounterIds: epochGraph.streamEpochCounterIds,
      streamEpochCountersCoverScope: true,
      retirementFenceIds,
      retirementFenceEvidenceObserved,
      retirementFenceEvidenceRequired,
      delayedUnloadResult,
      retirementStrategy,
      conservativeDrainFallback,
      delayedUnloadResultObserved,
      delayedUnloadResultTerminal: true,
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
    && capsuleMetadataObserved
    && streamOrderingProven
    && retirementFenceEvidenceObserved
    && retirementTracked
    && delayedUnloadResultObserved
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
      generationGraphRuntimeSessionIds,
      generationGraphRuntimeSessionScoped,
      schemaVersionValid,
      publishTimestampObserved,
      nodeIdentitiesValid,
      edgeClosureValid,
      graphAcyclic,
      epochGenerationGraph: epochGraph.graph,
      generationLineageObserved: true,
      dispatchTableHashObserved: true,
      dispatchTableHashBeforeObserved: true,
      dispatchTableHashAfterObserved: true,
      dispatchTableHashChanged: true,
      changedEntriesObserved: true,
      capsuleMetadataObserved,
      streamOrderingProven: true,
      streamScope,
      streamIds,
      streamEpochCounterIds: epochGraph.streamEpochCounterIds,
      streamEpochCountersCoverScope: true,
      retirementFenceIds,
      retirementFenceEvidenceObserved,
      retirementFenceEvidenceRequired,
      delayedUnloadResult,
      retirementStrategy,
      conservativeDrainFallback,
      delayedUnloadResultObserved,
      delayedUnloadResultTerminal: false,
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
                    : !capsuleMetadataObserved
                      ? 'epoch_capsule_metadata_not_collected'
                      : !streamEpochCountersMatchScope
                        ? 'epoch_stream_epoch_counter_unverified'
                        : !retirementFenceEvidenceObserved
                          ? 'epoch_retirement_fence_ids_not_collected'
                          : !delayedUnloadResultObserved
                            ? 'epoch_delayed_unload_result_not_collected'
                            : oldGenerationRetired && !delayedUnloadResultTerminal
                              ? 'epoch_delayed_unload_result_unverified'
                              : 'epoch_retirement_tracking_not_collected',
    published,
    runtimeSessionObserved,
    runtimeSessionIds,
    runtimeSessionConsistent,
    generationGraphObserved,
    generationGraphValid,
    generationGraphRuntimeSessionIds,
    generationGraphRuntimeSessionScoped,
    schemaVersionValid: epochGraph.schemaVersionValid === true,
    publishTimestampObserved,
    nodeIdentitiesValid,
    edgeClosureValid,
    graphAcyclic,
    epochGenerationGraph: epochGraph.graph,
    generationLineageObserved,
    dispatchTableHashObserved,
    dispatchTableHashBeforeObserved,
    dispatchTableHashAfterObserved,
    dispatchTableHashChanged,
    changedEntriesObserved,
    capsuleMetadataObserved,
    streamOrderingProven,
    streamScope,
    streamIds,
    streamEpochCounterIds: epochGraph.streamEpochCounterIds,
    streamEpochCountersCoverScope: streamEpochCountersMatchScope,
    retirementFenceIds,
    retirementFenceEvidenceObserved,
    retirementFenceEvidenceRequired,
    delayedUnloadResult,
    retirementStrategy,
    conservativeDrainFallback,
    delayedUnloadResultObserved,
    delayedUnloadResultTerminal,
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
  const retirement = proof.retirementStrategy ? ` retirement=${proof.retirementStrategy}` : ' retirement=unverified';
  const retired = proof.oldGenerationRetired ? ' retired=yes' : ' retired=no';
  const capsule = proof.capsuleMetadataObserved ? ' capsule=observed' : ' capsule=missing';
  return `gpu_epoch_swap_proof=${result}${degraded}${reason}${publication}${session}${graph}${stream}${retirement}${retired}${capsule}`;
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
  const identitySnapshotEvidenceRefs = Array.isArray(observation.identitySnapshotEvidenceRefs)
    ? observation.identitySnapshotEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const identityEvidenceObserved = identityEvidenceRefs.length > 0;
  const runtimeIdentityEvidenceRefs = runtimeHostIdentityEvidenceRefs(identityEvidenceRefs);
  const runtimeIdentityEvidenceObserved = runtimeIdentityEvidenceRefs.length > 0;
  const identitySnapshotEvidenceObserved = identitySnapshotEvidenceRefs.length > 0;
  const runtimeIdentitySnapshotEvidenceRefs =
    runtimeHostIdentitySnapshotEvidenceRefs(identitySnapshotEvidenceRefs);
  const runtimeIdentitySnapshotEvidenceObserved = runtimeIdentitySnapshotEvidenceRefs.length > 0;
  const identityRoleCategories = hostIdentityRoleCategoriesFromRefs(runtimeIdentityEvidenceRefs);
  const identitySnapshotRoleCategories =
    hostIdentityRoleCategoriesFromRefs(runtimeIdentitySnapshotEvidenceRefs);
  const missingRequiredIdentityRoleCategories =
    hostIdentityMissingRequiredCategories(runtimeIdentityEvidenceRefs, runtimeIdentitySnapshotEvidenceRefs);
  const requiredIdentityRoleEvidenceRefsComplete =
    missingRequiredIdentityRoleCategories.length === 0;

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
      identitySnapshotEvidenceObserved,
      identitySnapshotEvidenceRefs,
      runtimeIdentitySnapshotEvidenceRefs,
      runtimeIdentitySnapshotEvidenceObserved,
      identityRoleCategories,
      identitySnapshotRoleCategories,
      missingRequiredIdentityRoleCategories,
      requiredIdentityRoleEvidenceRefsComplete,
    };
  }

  if (
    identityChecksPassed
    && identitySnapshotObserved
    && identitySnapshotLineageObserved
    && requiredIdentityRolesObserved
    && runtimeIdentityEvidenceObserved
    && runtimeIdentitySnapshotEvidenceObserved
    && requiredIdentityRoleEvidenceRefsComplete
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
      identitySnapshotEvidenceObserved: true,
      identitySnapshotEvidenceRefs,
      runtimeIdentitySnapshotEvidenceRefs,
      runtimeIdentitySnapshotEvidenceObserved: true,
      identityRoleCategories,
      identitySnapshotRoleCategories,
      missingRequiredIdentityRoleCategories,
      requiredIdentityRoleEvidenceRefsComplete: true,
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
            : !runtimeIdentitySnapshotEvidenceObserved
              ? 'host_identity_snapshot_evidence_refs_not_collected'
              : !requiredIdentityRolesObserved
                ? 'host_identity_required_roles_not_collected'
                : !requiredIdentityRoleEvidenceRefsComplete
                  ? 'host_identity_required_role_evidence_refs_incomplete'
                  : 'host_identity_checks_not_collected'
      : 'host_identity_checks_not_collected',
    identityChecksPassed: false,
    identitySnapshotObserved,
    identitySnapshotLineageObserved,
    requiredIdentityRolesObserved,
    identityEvidenceObserved,
    identityEvidenceRefs,
    runtimeIdentityEvidenceRefs,
    identitySnapshotEvidenceObserved,
    identitySnapshotEvidenceRefs,
    runtimeIdentitySnapshotEvidenceRefs,
    runtimeIdentitySnapshotEvidenceObserved,
    identityRoleCategories,
    identitySnapshotRoleCategories,
    missingRequiredIdentityRoleCategories,
    requiredIdentityRoleEvidenceRefsComplete,
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

function normalizeRuntimeCapabilityPreflight(value) {
  const raw = objectField(value);
  if (!raw) return null;
  const allocationAvailable = raw.allocationAvailable === true || raw.allocation_available === true
    ? true
    : raw.allocationAvailable === false || raw.allocation_available === false
      ? false
      : null;
  const skipped = raw.skipped === true || raw.skipped === 'true';
  const degradedState = stringField(raw.degradedState, raw.degraded_state);
  const degradedReason = stringField(raw.degradedReason, raw.degraded_reason, raw.reason);
  const allocationResult = integerValue(raw.allocationResult ?? raw.allocation_result);
  const deviceCountResult = integerValue(raw.deviceCountResult ?? raw.device_count_result);
  const deviceCount = integerValue(raw.deviceCount ?? raw.device_count);
  const exitCode = integerValue(raw.exitCode ?? raw.exit_code);
  const observed = !skipped && (
    allocationAvailable !== null
    || allocationResult !== null
    || degradedState !== null
    || stringField(raw.allocationError, raw.allocation_error) !== null
  );
  return {
    schemaVersion: stringField(raw.schemaVersion, raw.schema_version) ?? null,
    backend: stringField(raw.backend) ?? null,
    api: stringField(raw.api) ?? null,
    probe: stringField(raw.probe) ?? null,
    skipped,
    observed,
    allocationAvailable,
    allocationUnavailable:
      observed
      && (
        allocationAvailable === false
        || degradedState === 'gpu-runtime-array-allocation-unavailable'
      ),
    allocationResult,
    allocationError: stringField(raw.allocationError, raw.allocation_error) ?? null,
    deviceCountResult,
    deviceCountError: stringField(raw.deviceCountError, raw.device_count_error) ?? null,
    deviceCount,
    exitCode,
    degradedState,
    degradedReason,
  };
}

export function classifyGpuHmrOriginalHostPathProof(observation = {}) {
  const required = observation.required === true;
  const runtimeSessionIds = runtimeSessionIdsFromObservation(observation);
  const runtimeSessionObserved = observation.runtimeSessionObserved === true || runtimeSessionIds.length > 0;
  const runtimeSessionConsistent =
    observation.runtimeSessionConsistent !== false && runtimeSessionIds.length <= 1;
  const sessionScoped = observation.sessionScoped === true && runtimeSessionObserved && runtimeSessionConsistent;
  const dispatchBoundaryObserved = observation.dispatchBoundaryObserved === true;
  const dispatchEntryRuntimeVerified = observation.dispatchEntryRuntimeVerified === true;
  const attachedToOriginalHostPath = observation.attachedToOriginalHostPath === true;
  const evidenceRefs = compactStringList(observation.evidenceRefs);
  const candidateEvidenceRefs = compactStringList(observation.candidateEvidenceRefs);
  const attachmentCandidateObserved =
    observation.attachmentCandidateObserved === true || candidateEvidenceRefs.length > 0;
  const nativeFunctionResolutionObserved = observation.nativeFunctionResolutionObserved === true;
  const nativeLaunchObserved = observation.nativeLaunchObserved === true;
  const nativeLaunchAttemptObserved = observation.nativeLaunchAttemptObserved === true;
  const nativeLaunchAttemptWithoutResult = observation.nativeLaunchAttemptWithoutResult === true;
  const nativeLaunchObserverEnabled = observation.nativeLaunchObserverEnabled === true;
  const nativeLaunchObserverReady = observation.nativeLaunchObserverReady === true;
  const nativeTextureObjectFailureObserved = observation.nativeTextureObjectFailureObserved === true;
  const nativeTextureObjectFailureBeforeLaunch = observation.nativeTextureObjectFailureBeforeLaunch === true;
  const nativeArrayAllocationFailureObserved = observation.nativeArrayAllocationFailureObserved === true;
  const nativeArrayAllocationFailureBeforeLaunch = observation.nativeArrayAllocationFailureBeforeLaunch === true;
  const runtimeCapabilityPreflight = normalizeRuntimeCapabilityPreflight(
    observation.runtimeCapabilityPreflight ?? observation.runtime_capability_preflight,
  );
  const runtimeCapabilityPreflightObserved = runtimeCapabilityPreflight?.observed === true;
  const runtimeArrayAllocationCapabilityAvailable =
    runtimeCapabilityPreflightObserved ? runtimeCapabilityPreflight.allocationAvailable === true : null;
  const runtimeArrayAllocationCapabilityUnavailable =
    runtimeCapabilityPreflightObserved && runtimeCapabilityPreflight.allocationUnavailable === true;
  const runtimeCapabilityEvidenceRefs = runtimeCapabilityPreflightObserved
    ? compactStringList([
      [
        'runtime-capability-preflight',
        runtimeCapabilityPreflight.backend ?? 'unknown-backend',
        runtimeCapabilityPreflight.probe ?? 'unknown-probe',
        runtimeCapabilityPreflight.api ?? 'unknown-api',
        runtimeCapabilityPreflight.allocationResult === null
          ? 'result:unknown'
          : `result:${runtimeCapabilityPreflight.allocationResult}`,
      ].join(':'),
    ])
    : [];
  const nativeLaunchObserverSawNoLaunch = observation.nativeLaunchObserverSawNoLaunch === true;
  const upstreamRunAttempted = observation.upstreamRunAttempted === true;
  const upstreamRunExitCode = Number.isInteger(observation.upstreamRunExitCode)
    ? observation.upstreamRunExitCode
    : null;
  const upstreamRunFailedBeforeObservedLaunch =
    observation.upstreamRunFailedBeforeObservedLaunch === true
    || (
      nativeLaunchObserverSawNoLaunch
      && upstreamRunExitCode !== null
      && upstreamRunExitCode !== 0
    );
  const runtimeEvidenceRefs = runtimeOriginalHostPathEvidenceRefs(evidenceRefs);
  const runtimeEvidenceObserved = observation.runtimeEvidenceObserved === true && runtimeEvidenceRefs.length > 0;
  const attachmentProven =
    attachedToOriginalHostPath
    && runtimeEvidenceObserved
    && dispatchBoundaryObserved
    && dispatchEntryRuntimeVerified
    && sessionScoped;
  const degradedReason = attachmentProven || !required
    ? null
    : runtimeArrayAllocationCapabilityUnavailable
      ? 'original_host_path_runtime_array_allocation_capability_unavailable'
    : nativeArrayAllocationFailureBeforeLaunch
      ? 'original_host_path_array_allocation_failed_before_launch'
      : nativeTextureObjectFailureBeforeLaunch
      ? 'original_host_path_texture_object_creation_failed_before_launch'
      : upstreamRunFailedBeforeObservedLaunch
      ? 'original_host_path_upstream_run_failed_before_launch_observed'
      : nativeLaunchAttemptWithoutResult
        ? 'original_host_path_native_launch_attempt_without_result'
      : nativeLaunchObserverSawNoLaunch
        ? 'original_host_path_native_launch_not_observed'
        : attachmentCandidateObserved
          ? 'original_host_path_candidate_only_no_runtime_attachment'
          : !attachedToOriginalHostPath
            ? 'original_host_path_attachment_not_observed'
            : !runtimeEvidenceObserved
              ? 'original_host_path_runtime_evidence_not_collected'
              : !dispatchBoundaryObserved
                ? 'original_host_path_dispatch_boundary_not_observed'
                : !dispatchEntryRuntimeVerified
                  ? 'original_host_path_dispatch_entry_not_runtime_verified'
                  : !sessionScoped
                    ? 'original_host_path_session_scope_not_proven'
                    : 'original_host_path_attachment_not_proven';

  return {
    schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
    required,
    attachmentProven,
    degradedState: attachmentProven || !required ? null : 'gpu-hmr-original-host-path-unattached',
    degradedReason,
    attachedToOriginalHostPath,
    runtimeEvidenceObserved,
    runtimeEvidenceRefs,
    attachmentCandidateObserved,
    nativeFunctionResolutionObserved,
    candidateEvidenceRefs,
    nativeLaunchObserved,
    nativeLaunchAttemptObserved,
    nativeLaunchAttemptWithoutResult,
    nativeLaunchObserverEnabled,
    nativeLaunchObserverReady,
    nativeTextureObjectFailureObserved,
    nativeTextureObjectFailureBeforeLaunch,
    nativeArrayAllocationFailureObserved,
    nativeArrayAllocationFailureBeforeLaunch,
    runtimeCapabilityPreflightObserved,
    runtimeCapabilityPreflight,
    runtimeCapabilityEvidenceRefs,
    runtimeArrayAllocationCapabilityAvailable,
    runtimeArrayAllocationCapabilityUnavailable,
    nativeLaunchObserverSawNoLaunch,
    upstreamRunAttempted,
    upstreamRunExitCode,
    upstreamRunFailedBeforeObservedLaunch,
    dispatchBoundaryObserved,
    dispatchEntryRuntimeVerified,
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
  const entry = proof.dispatchEntryRuntimeVerified ? ' entry=runtime' : ' entry=unverified';
  const candidate = proof.attachmentCandidateObserved ? ' candidate=observed' : ' candidate=missing';
  const observer = proof.nativeLaunchObserverReady ? ' observer=ready' : '';
  const resolver = proof.nativeFunctionResolutionObserved ? ' resolver=observed' : '';
  const texture = proof.nativeTextureObjectFailureObserved ? ' texture=failure' : '';
  const arrayAllocation = proof.nativeArrayAllocationFailureObserved ? ' array_alloc=failure' : '';
  const runtimeArrayCapability = proof.runtimeCapabilityPreflightObserved
    ? proof.runtimeArrayAllocationCapabilityAvailable
      ? ' array_capability=available'
      : proof.runtimeArrayAllocationCapabilityUnavailable
        ? ' array_capability=unavailable'
        : ' array_capability=unknown'
    : '';
  const nativeAttempt = proof.nativeLaunchAttemptObserved ? ' native_attempt=observed' : '';
  const upstreamExit = Number.isInteger(proof.upstreamRunExitCode)
    ? ` upstream_exit=${proof.upstreamRunExitCode}`
    : '';
  return `gpu_original_host_path_proof=${result}${degraded}${reason}${evidence}${session}${entry}${candidate}${observer}${resolver}${texture}${arrayAllocation}${runtimeArrayCapability}${nativeAttempt}${upstreamExit}`;
}

export function classifyGpuHmrFullRuntimeProof(observation = {}) {
  const sourceProofs = Array.isArray(observation.sourceProofs)
    ? observation.sourceProofs.filter((proof) => proof && typeof proof === 'object')
    : observation.sourceProof && typeof observation.sourceProof === 'object'
      ? [observation.sourceProof]
      : [];
  const source = highestEffectiveSourceProof(sourceProofs);
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
  const artifactIdentityProof = fullRuntimeArtifactIdentityProof({
    sourceProof: source.proof,
    artifactTransportProof,
    epochProof,
    dispatchProof,
    outputProof,
    required:
      source.effectiveRank >= proofStateRank('gpu-hmr-symbol-bound')
      && artifactTransportAccepted
      && epochRank >= proofStateRank('gpu-hmr-epoch-swap-proven')
      && dispatchRank >= proofStateRank('gpu-hmr-dispatch-safe-proven')
      && outputRank >= proofStateRank('gpu-hmr-output-oracle-proven'),
  });
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
    ...(artifactIdentityProof.required
      ? [{
          stageId: 'artifact-identity',
          requiredState: 'gpu-hmr-full-runtime-proven',
          status: artifactIdentityProof.proven ? 'passed' : 'blocked',
          observedState: artifactIdentityProof.proven ? 'gpu-hmr-artifact-identity-proven' : null,
          effectiveRank: artifactIdentityProof.proven ? proofStateRank('gpu-hmr-full-runtime-proven') : 0,
          degradedState: artifactIdentityProof.proven ? null : 'gpu-hmr-artifact-identity-unverified',
          degradedReason: artifactIdentityProof.degradedReason,
        }]
      : []),
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
      artifactIdentityRequired: artifactIdentityProof.required,
      artifactIdentityProven: artifactIdentityProof.proven,
      artifactIdentityCommonArtifactIds: artifactIdentityProof.commonArtifactIds,
      artifactIdentityIdsByStage: artifactIdentityProof.artifactIdsByStage,
      artifactIdentityMissingStages: artifactIdentityProof.missingStages,
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
