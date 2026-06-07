import {
  classifyGpuHmrEpochSwapProof,
  classifyGpuHmrHostPreservationProof,
  classifyGpuHmrOriginalHostPathProof,
  gpuHmrOutputOracleKindAccepted,
  gpuHmrOracleValuesCompatible,
} from './gpu-hmr-runtime-proof.mjs';

function parseRuntimeKeyValues(line) {
  const out = {};
  const re = /\b([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|[^\s]+)/g;
  let match;
  while ((match = re.exec(String(line ?? ''))) !== null) {
    const raw = match[2];
    out[match[1]] = raw.startsWith('"') && raw.endsWith('"')
      ? raw.slice(1, -1)
      : raw;
  }
  return out;
}

function runtimeBoundaryEventLine(line, eventPattern) {
  const text = String(line ?? '');
  return /\[gpu-runtime-boundary\]/i.test(text) && eventPattern.test(text);
}

function boolValue(value) {
  if (value === true || value === 'true') return true;
  if (value === false || value === 'false') return false;
  return null;
}

function integerValue(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const parsed = Number.parseInt(String(value), 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function compactStringList(values) {
  return Array.isArray(values)
    ? [...new Set(values.filter((value) => typeof value === 'string' && value.trim()).map((value) => value.trim()))]
    : [];
}

function observedEvidenceList(values) {
  const raw = typeof values === 'string' ? values.split(',') : values;
  return compactStringList(raw).filter((value) => value.toLowerCase() !== 'none');
}

function metadataString(value, ...keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) {
    if (typeof value[key] === 'string' && value[key].trim()) return value[key].trim();
  }
  return null;
}

function metadataValue(value, ...keys) {
  if (!value || typeof value !== 'object') return null;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  return null;
}

function commaList(value) {
  if (typeof value !== 'string') return [];
  return compactStringList(value.split(','));
}

function tokenOrNull(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== 'none' ? trimmed : null;
}

function sha256Digest(value) {
  if (typeof value !== 'string') return null;
  return value.trim().match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
}

function artifactIdDigest(value) {
  if (typeof value !== 'string') return null;
  return value.trim().match(/^artifact:sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null;
}

function evidenceRefToken(value) {
  const token = String(value ?? '')
    .trim()
    .replace(/[^A-Za-z0-9_.:-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return token || 'unknown';
}

function processIdFromRuntimeSession(value) {
  const session = String(value ?? '').trim();
  const match = session.match(/^pid(\d+)(?:[-:]|$)/i);
  return match ? `pid:${match[1]}` : null;
}

function processIdsFromRuntimeSessions(values) {
  return compactStringList((Array.isArray(values) ? values : [])
    .map(processIdFromRuntimeSession)
    .filter(Boolean));
}

function consistentProcessIdFromRuntimeSessions(values) {
  const ids = processIdsFromRuntimeSessions(values);
  return ids.length === 1 ? ids[0] : null;
}

function keyValueTokenMap(value) {
  return commaList(value).reduce((out, item) => {
    const index = item.lastIndexOf(':');
    if (index <= 0 || index >= item.length - 1) return out;
    const key = item.slice(0, index).trim();
    const parsed = integerValue(item.slice(index + 1));
    if (!key || parsed === null) return out;
    out[key] = parsed;
    return out;
  }, {});
}

function streamScopeSupported(streamScope, streamIds) {
  if (streamScope === 'none') {
    return streamIds.length === 1 && streamIds[0] === 'none';
  }
  if (streamScope !== 'stream' && streamScope !== 'affected') return false;
  return streamIds.length > 0 && !streamIds.includes('none');
}

function epochRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    event: fields.event ?? null,
    runtimeSession: fields.runtime_session ?? null,
    publishTimestampMs: integerValue(fields.publish_timestamp_ms ?? fields.publish_timestamp),
    previousGeneration: integerValue(fields.previous_generation),
    activeGeneration: integerValue(fields.active_generation),
    oldArtifactId: fields.old_artifact_id ?? fields.previous_artifact_id ?? null,
    newArtifactId: fields.new_artifact_id ?? fields.active_artifact_id ?? null,
    newArtifactHash: fields.new_artifact_hash ?? fields.artifact_hash ?? null,
    capsuleId: tokenOrNull(fields.capsule_id),
    fissionIslandId: tokenOrNull(fields.fission_island_id),
    abiMembraneHash: tokenOrNull(fields.abi_membrane_hash),
    dependencyClosureHash: tokenOrNull(fields.dependency_closure_hash),
    proofHash: tokenOrNull(fields.proof_hash),
    changedSymbols: commaList(fields.changed_symbols),
    functionHandleIds: commaList(fields.function_handle_ids),
    streamEpochCounters: keyValueTokenMap(fields.stream_epoch_counters),
    dispatchTableHashBefore: fields.dispatch_table_hash_before ?? null,
    dispatchTableHashAfter: fields.dispatch_table_hash_after ?? null,
    dispatchTableHash: fields.dispatch_table_hash ?? null,
    changedEntries: integerValue(fields.changed_entries),
    retiredModules: integerValue(fields.retired_modules),
    retirementTracked: boolValue(fields.retirement_tracked),
    oldGenerationRetired: boolValue(fields.old_generation_retired),
    streamScope: fields.stream_scope ?? null,
    streamIds: commaList(fields.stream_ids),
    streamOrderingProven: boolValue(fields.stream_ordering_proven),
    retirementFenceIds: observedEvidenceList(
      fields.retirement_fence_ids ?? fields.retirementFenceIds,
    ),
    delayedUnloadResult: fields.delayed_unload_result ?? fields.delayedUnloadResult ?? null,
    retirementStrategy: fields.retirement_strategy ?? fields.retirementStrategy ?? null,
    drainResult: fields.drain_result ?? null,
  };
}

function epochGenerationGraphRecord(line) {
  if (!runtimeBoundaryEventLine(line, /\bepoch_generation_graph\b/i)) return null;
  const fields = parseRuntimeKeyValues(line);
  const rawGraph = fields.json ?? fields.graph ?? fields.epoch_generation_graph ?? null;
  if (typeof rawGraph !== 'string' || rawGraph.trim() === '') {
    return { line, graph: null, reason: 'epoch_generation_graph_json_missing' };
  }
  try {
    return { line, graph: JSON.parse(rawGraph), reason: null };
  } catch {
    return { line, graph: null, reason: 'epoch_generation_graph_json_invalid' };
  }
}

function epochGraphLineage(graph) {
  const latest = graph?.latestPublication ?? graph?.latest_publication ?? graph?.publication ?? graph;
  const previousGeneration = integerValue(latest?.previousGeneration ?? latest?.previous_generation);
  const activeGeneration = integerValue(latest?.activeGeneration ?? latest?.active_generation);
  return Number.isFinite(previousGeneration) && Number.isFinite(activeGeneration)
    ? `${previousGeneration}->${activeGeneration}`
    : 'unknown';
}

function matchingRetirement(publication, retirements) {
  return retirements.find((record) =>
    record.previousGeneration === publication.previousGeneration
    && record.activeGeneration === publication.activeGeneration
    && record.oldGenerationRetired === true
  ) ?? null;
}

function epochEvidenceRefs(publication, retirement) {
  if (!publication) return [];
  const lineage = `${publication.previousGeneration}->${publication.activeGeneration}`;
  const refs = [`worker-log:dispatcher_epoch:published:${lineage}`];
  if (retirement) refs.push(`worker-log:dispatcher_epoch:retired:${lineage}`);
  for (const fenceId of compactStringList([
    ...(Array.isArray(publication.retirementFenceIds) ? publication.retirementFenceIds : []),
    ...(Array.isArray(retirement?.retirementFenceIds) ? retirement.retirementFenceIds : []),
  ]).filter((id) => id.toLowerCase() !== 'none')) {
    refs.push(`worker-log:dispatcher_epoch:retirement_fence:${lineage}:${evidenceRefToken(fenceId)}`);
  }
  return refs;
}

function epochGraphNodeId(generation) {
  return Number.isFinite(generation) ? `generation:${generation}` : null;
}

function addEpochGraphNode(nodes, generation, state) {
  const id = epochGraphNodeId(generation);
  if (!id) return;
  const existing = nodes.get(id);
  if (existing) {
    if (state && existing.state !== 'retired') existing.state = state;
    return;
  }
  nodes.set(id, {
    id,
    generation,
    state: state ?? 'observed',
  });
}

function buildEpochGenerationGraph(records, latestPublication, retirement, publicationRetirementComplete) {
  if (!latestPublication) return null;
  const nodes = new Map();
  const edges = [];
  const finalRetirementFenceIds = compactStringList([
    ...(Array.isArray(latestPublication.retirementFenceIds) ? latestPublication.retirementFenceIds : []),
    ...(Array.isArray(retirement?.retirementFenceIds) ? retirement.retirementFenceIds : []),
  ]).filter((id) => id.toLowerCase() !== 'none');
  const finalDelayedUnloadResult =
    retirement?.delayedUnloadResult
    ?? latestPublication.delayedUnloadResult
    ?? null;
  const finalRetirementStrategy =
    retirement?.retirementStrategy
    ?? latestPublication.retirementStrategy
    ?? null;
  for (const record of records) {
    if (!Number.isFinite(record.previousGeneration) || !Number.isFinite(record.activeGeneration)) {
      continue;
    }
    const from = epochGraphNodeId(record.previousGeneration);
    const to = epochGraphNodeId(record.activeGeneration);
    if (!from || !to) continue;
    if (record.event === 'published') {
      addEpochGraphNode(nodes, record.previousGeneration, 'superseded');
      addEpochGraphNode(nodes, record.activeGeneration, 'published');
      edges.push({
        kind: 'publish',
        from,
        to,
        previousGeneration: record.previousGeneration,
        activeGeneration: record.activeGeneration,
        runtimeSession: record.runtimeSession,
        publishTimestampMs: record.publishTimestampMs,
        oldArtifactId: record.oldArtifactId,
        newArtifactId: record.newArtifactId,
        newArtifactHash: record.newArtifactHash,
        capsuleId: record.capsuleId,
        fissionIslandId: record.fissionIslandId,
        abiMembraneHash: record.abiMembraneHash,
        dependencyClosureHash: record.dependencyClosureHash,
        proofHash: record.proofHash,
        changedSymbols: record.changedSymbols,
        functionHandleIds: record.functionHandleIds,
        streamEpochCounters: record.streamEpochCounters,
        dispatchTableHashBefore: record.dispatchTableHashBefore,
        dispatchTableHashAfter: record.dispatchTableHashAfter,
        dispatchTableHash: record.dispatchTableHash,
        changedEntries: record.changedEntries,
        retirementFenceIds: record.retirementFenceIds,
        delayedUnloadResult: record.delayedUnloadResult,
        retirementStrategy: record.retirementStrategy,
        evidenceRef: `worker-log:dispatcher_epoch:published:${record.previousGeneration}->${record.activeGeneration}`,
      });
    } else if (record.event === 'retired') {
      addEpochGraphNode(nodes, record.previousGeneration, 'retired');
      addEpochGraphNode(nodes, record.activeGeneration, 'published');
      edges.push({
        kind: 'retire',
        from,
        to,
        previousGeneration: record.previousGeneration,
        activeGeneration: record.activeGeneration,
        runtimeSession: record.runtimeSession,
        retirementFenceIds: record.retirementFenceIds,
        delayedUnloadResult: record.delayedUnloadResult,
        retirementStrategy: record.retirementStrategy,
        evidenceRef: `worker-log:dispatcher_epoch:retired:${record.previousGeneration}->${record.activeGeneration}`,
      });
    }
  }

  const latestPreviousId = epochGraphNodeId(latestPublication.previousGeneration);
  if (latestPreviousId && nodes.has(latestPreviousId)) {
    nodes.get(latestPreviousId).state = publicationRetirementComplete
      ? 'not-required'
      : retirement
        ? 'retired'
        : 'pending-retirement';
  }

  return {
    schemaVersion: 'synthi.gpu.epoch_graph.v1',
    runtimeSessionIds: compactStringList(records.map((record) => record.runtimeSession)),
    latestPublication: {
      previousGeneration: latestPublication.previousGeneration,
      activeGeneration: latestPublication.activeGeneration,
      publishTimestampMs: latestPublication.publishTimestampMs,
      oldArtifactId: latestPublication.oldArtifactId,
      newArtifactId: latestPublication.newArtifactId,
      newArtifactHash: latestPublication.newArtifactHash,
      capsuleId: latestPublication.capsuleId,
      fissionIslandId: latestPublication.fissionIslandId,
      abiMembraneHash: latestPublication.abiMembraneHash,
      dependencyClosureHash: latestPublication.dependencyClosureHash,
      proofHash: latestPublication.proofHash,
      changedSymbols: latestPublication.changedSymbols,
      functionHandleIds: latestPublication.functionHandleIds,
      streamEpochCounters: latestPublication.streamEpochCounters,
      dispatchTableHashBefore: latestPublication.dispatchTableHashBefore,
      dispatchTableHashAfter: latestPublication.dispatchTableHashAfter,
      dispatchTableHash: latestPublication.dispatchTableHash,
      changedEntries: latestPublication.changedEntries,
      retirementFenceIds: finalRetirementFenceIds,
      delayedUnloadResult: finalDelayedUnloadResult,
      retirementStrategy: finalRetirementStrategy,
    },
    retirementState: publicationRetirementComplete
      ? 'not-required'
      : retirement
        ? 'retired'
        : 'pending',
    retirementRequired: !publicationRetirementComplete,
    matchingRetirementObserved: retirement !== null,
    nodes: [...nodes.values()].sort((left, right) => left.generation - right.generation),
    edges,
  };
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
  publicationRetirementComplete,
  retirementFenceIds,
  delayedUnloadResult,
}) {
  const explicit = normalizedRetirementStrategy(explicitStrategy);
  if (explicit) return explicit;
  const delayed = String(delayedUnloadResult ?? '').trim().toLowerCase();
  if (
    publicationRetirementComplete
    || delayed === 'not_required'
    || delayed === 'no_old_generation'
  ) {
    return 'no_retirement_required';
  }
  if (Array.isArray(retirementFenceIds) && retirementFenceIds.length > 0) {
    return 'epoch_fence';
  }
  return null;
}

function oldArtifactReferenceObserved(publication) {
  const oldArtifactId = String(metadataString(publication, 'oldArtifactId', 'old_artifact_id') ?? '').trim();
  if (/^artifact:sha256:[0-9a-f]{64}$/i.test(oldArtifactId)) return true;
  if (oldArtifactId.toLowerCase() !== 'none') return false;
  const previousGeneration = integerValue(
    metadataValue(publication, 'previousGeneration', 'previous_generation'),
  );
  return previousGeneration !== null && previousGeneration <= 1;
}

export function runtimeEpochSwapEvidence(lines) {
  const records = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bdispatcher_epoch\b/i))
    .map(epochRecord);
  const graphRecords = (Array.isArray(lines) ? lines : [])
    .map(epochGenerationGraphRecord)
    .filter((record) => record !== null);
  const acceptedGraphRecords = graphRecords.filter((record) => record.graph && typeof record.graph === 'object');
  const latestExplicitGraphRecord = acceptedGraphRecords.at(-1) ?? null;
  const publications = records.filter((record) => record.event === 'published');
  const retirements = records.filter((record) => record.event === 'retired');
  const latestPublication = publications.at(-1) ?? null;
  const retirement = latestPublication ? matchingRetirement(latestPublication, retirements) : null;
  const runtimeSessionIds = compactStringList(records.map((record) => record.runtimeSession));
  const processIds = processIdsFromRuntimeSessions(runtimeSessionIds);
  const runtimeSessionObserved = runtimeSessionIds.length > 0;
  const runtimeSessionConsistent = runtimeSessionIds.length <= 1;
  const generationLineageObserved = latestPublication
    ? Number.isFinite(latestPublication.previousGeneration)
      && Number.isFinite(latestPublication.activeGeneration)
      && latestPublication.activeGeneration > latestPublication.previousGeneration
    : false;
  const dispatchTableHashBeforeObserved = typeof latestPublication?.dispatchTableHashBefore === 'string'
    && /^0x[0-9a-f]+$/i.test(latestPublication.dispatchTableHashBefore);
  const dispatchTableHashAfterObserved = typeof latestPublication?.dispatchTableHashAfter === 'string'
    && /^0x[0-9a-f]+$/i.test(latestPublication.dispatchTableHashAfter);
  const dispatchTableHashChanged =
    dispatchTableHashBeforeObserved
    && dispatchTableHashAfterObserved
    && latestPublication.dispatchTableHashBefore !== latestPublication.dispatchTableHashAfter;
  const dispatchTableHashObserved =
    dispatchTableHashBeforeObserved && dispatchTableHashAfterObserved && dispatchTableHashChanged;
  const changedEntriesObserved = Number.isFinite(latestPublication?.changedEntries)
    && latestPublication.changedEntries > 0;
  const retirementTracked = latestPublication?.retirementTracked === true;
  const publicationRetirementComplete =
    latestPublication?.oldGenerationRetired === true
    && latestPublication?.retiredModules === 0;
  const oldGenerationRetired = publicationRetirementComplete || retirement !== null;
  const reconstructedEpochGenerationGraph = buildEpochGenerationGraph(
    records,
    latestPublication,
    retirement,
    publicationRetirementComplete,
  );
  const epochGenerationGraph = latestExplicitGraphRecord?.graph ?? reconstructedEpochGenerationGraph;
  const graphLatestPublication =
    latestExplicitGraphRecord?.graph?.latestPublication
    ?? latestExplicitGraphRecord?.graph?.latest_publication
    ?? null;
  const capsuleMetadataPublication = graphLatestPublication ?? latestPublication;
  const streamScope = latestPublication?.streamScope ?? null;
  const streamIds = latestPublication?.streamIds ?? [];
  const streamScopeEvidenceSupported = streamScopeSupported(streamScope, streamIds);
  const retirementFenceIds = compactStringList([
    ...(Array.isArray(latestPublication?.retirementFenceIds) ? latestPublication.retirementFenceIds : []),
    ...(Array.isArray(retirement?.retirementFenceIds) ? retirement.retirementFenceIds : []),
  ]).filter((id) => id.toLowerCase() !== 'none');
  const retirementFenceEvidenceRequired = streamScope !== 'none';
  const retirementFenceEvidenceObserved =
    !retirementFenceEvidenceRequired || retirementFenceIds.length > 0;
  const delayedUnloadResult =
    retirement?.delayedUnloadResult
    ?? latestPublication?.delayedUnloadResult
    ?? null;
  const explicitRetirementStrategy =
    retirement?.retirementStrategy
    ?? latestPublication?.retirementStrategy
    ?? null;
  const retirementStrategy = inferredRetirementStrategy({
    explicitStrategy: explicitRetirementStrategy,
    publicationRetirementComplete,
    retirementFenceIds,
    delayedUnloadResult,
  });
  const streamOrderingRequested =
    latestPublication?.streamOrderingProven === true
    && latestPublication?.drainResult === 'synced';
  const streamOrderingProven =
    streamOrderingRequested
    && streamScopeEvidenceSupported;
  const metadataNewArtifactId = metadataString(capsuleMetadataPublication, 'newArtifactId', 'new_artifact_id');
  const metadataNewArtifactHash = metadataString(capsuleMetadataPublication, 'newArtifactHash', 'new_artifact_hash');
  const metadataCapsuleId = metadataString(capsuleMetadataPublication, 'capsuleId', 'capsule_id');
  const metadataAbiMembraneHash = metadataString(capsuleMetadataPublication, 'abiMembraneHash', 'abi_membrane_hash');
  const metadataDependencyClosureHash = metadataString(capsuleMetadataPublication, 'dependencyClosureHash', 'dependency_closure_hash');
  const metadataProofHash = metadataString(capsuleMetadataPublication, 'proofHash', 'proof_hash');
  const newArtifactIdHash = typeof metadataNewArtifactId === 'string'
    ? metadataNewArtifactId.match(/^artifact:sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null
    : null;
  const newArtifactHashDigest = typeof metadataNewArtifactHash === 'string'
    ? metadataNewArtifactHash.match(/^sha256:([0-9a-f]{64})$/i)?.[1]?.toLowerCase() ?? null
    : null;
  const capsuleMetadataObserved =
    oldArtifactReferenceObserved(capsuleMetadataPublication)
    && /^artifact:sha256:[0-9a-f]{64}$/i.test(metadataNewArtifactId ?? '')
    && /^sha256:[0-9a-f]{64}$/i.test(metadataNewArtifactHash ?? '')
    && newArtifactIdHash === newArtifactHashDigest
    && /^capsule:sha256:[0-9a-f]{64}$/i.test(metadataCapsuleId ?? '')
    && /^sha256:[0-9a-f]{64}$/i.test(metadataAbiMembraneHash ?? '')
    && /^sha256:[0-9a-f]{64}$/i.test(metadataDependencyClosureHash ?? '')
    && /^sha256:[0-9a-f]{64}$/i.test(metadataProofHash ?? '')
    && observedEvidenceList(metadataValue(capsuleMetadataPublication, 'changedSymbols', 'changed_symbols')).length > 0
    && observedEvidenceList(metadataValue(capsuleMetadataPublication, 'functionHandleIds', 'function_handle_ids')).length > 0
    && Object.keys(metadataValue(capsuleMetadataPublication, 'streamEpochCounters', 'stream_epoch_counters') ?? {}).length > 0;

  return {
    total_count: records.length,
    epoch_generation_graph_line_count: graphRecords.length,
    epoch_generation_graph_explicit: latestExplicitGraphRecord !== null,
    epoch_generation_graph_parse_failures: graphRecords
      .filter((record) => record.reason)
      .map((record) => record.reason),
    published_count: publications.length,
    retired_count: retirements.length,
    published: latestPublication !== null,
    process_id: processIds.length === 1 ? processIds[0] : null,
    process_ids: processIds,
    runtime_session_observed: runtimeSessionObserved,
    runtime_session_ids: runtimeSessionIds,
    runtime_session_consistent: runtimeSessionConsistent,
    generation_lineage_observed: generationLineageObserved,
    epoch_generation_graph: epochGenerationGraph,
    epoch_generation_graph_observed: epochGenerationGraph !== null,
    dispatch_table_hash_observed: dispatchTableHashObserved,
    dispatch_table_hash_before_observed: dispatchTableHashBeforeObserved,
    dispatch_table_hash_after_observed: dispatchTableHashAfterObserved,
    dispatch_table_hash_changed: dispatchTableHashChanged,
    changed_entries_observed: changedEntriesObserved,
    retirement_tracked: retirementTracked,
    retirement_not_required: publicationRetirementComplete,
    old_generation_retired: oldGenerationRetired,
    stream_ordering_requested: streamOrderingRequested,
    stream_ordering_proven: streamOrderingProven,
    stream_scope: streamScope,
    stream_scope_supported: streamScopeEvidenceSupported,
    stream_ids: streamIds,
    retirement_fence_ids: retirementFenceIds,
    retirement_fence_evidence_required: retirementFenceEvidenceRequired,
    retirement_fence_evidence_observed: retirementFenceEvidenceObserved,
    delayed_unload_result: delayedUnloadResult,
    retirement_strategy: retirementStrategy,
    retirement_strategy_explicit: normalizedRetirementStrategy(explicitRetirementStrategy) !== null,
    capsule_metadata_observed: capsuleMetadataObserved,
    drain_result: latestPublication?.drainResult ?? null,
    latest_publication: latestPublication,
    matching_retirement: retirement,
    evidence_refs: [
      ...epochEvidenceRefs(latestPublication, retirement),
      ...(latestExplicitGraphRecord
        ? [`worker-log:epoch_generation_graph:${epochGraphLineage(latestExplicitGraphRecord.graph)}`]
        : []),
    ],
    lines: records.map((record) => record.line).slice(-20),
  };
}

export function epochSwapProofFromRuntimeEvidence(lines) {
  const evidence = runtimeEpochSwapEvidence(lines);
  const proof = classifyGpuHmrEpochSwapProof({
    published: evidence.published,
    generationLineageObserved: evidence.generation_lineage_observed,
    epochGenerationGraph: evidence.epoch_generation_graph,
    dispatchTableHashObserved: evidence.dispatch_table_hash_observed,
    dispatchTableHashBeforeObserved: evidence.dispatch_table_hash_before_observed,
    dispatchTableHashAfterObserved: evidence.dispatch_table_hash_after_observed,
    dispatchTableHashChanged: evidence.dispatch_table_hash_changed,
    changedEntriesObserved: evidence.changed_entries_observed,
    capsuleMetadataObserved: evidence.capsule_metadata_observed,
    runtimeSessionObserved: evidence.runtime_session_observed,
    runtimeSessionIds: evidence.runtime_session_ids,
    processId: evidence.process_id,
    runtimeSessionConsistent: evidence.runtime_session_consistent,
    streamOrderingRequested: evidence.stream_ordering_requested,
    streamOrderingProven: evidence.stream_ordering_proven,
    streamScope: evidence.stream_scope,
    streamIds: evidence.stream_ids,
    retirementFenceIds: evidence.retirement_fence_ids,
    delayedUnloadResult: evidence.delayed_unload_result,
    retirementStrategy: evidence.retirement_strategy,
    retirementTracked: evidence.retirement_tracked,
    oldGenerationRetired: evidence.old_generation_retired,
    evidenceRefs: evidence.evidence_refs,
  });
  return { evidence, proof };
}

function hostIdentityRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    role: fields.role ?? null,
    ptr: fields.ptr ?? null,
    aux: fields.aux ?? null,
    generation: integerValue(fields.generation),
    runtimeSession: fields.runtime_session ?? null,
  };
}

function hostIdentityRejectionReason(record, expectedSessions = []) {
  if (typeof record.role !== 'string' || !record.role.trim()) return 'role_missing';
  if (typeof record.ptr !== 'string' || !/^0x[0-9a-f]+$/i.test(record.ptr)) return 'ptr_invalid';
  if (record.ptr === '0x0') return 'ptr_null';
  if (!Number.isFinite(record.generation)) return 'generation_missing';
  if (typeof record.runtimeSession !== 'string' || !record.runtimeSession.trim()) {
    return 'runtime_session_missing';
  }
  if (expectedSessions.length > 0 && !expectedSessions.includes(record.runtimeSession)) {
    return 'runtime_session_unexpected';
  }
  return null;
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

function generationLineageFromValue(value) {
  if (!value || typeof value !== 'object') return null;
  if (Array.isArray(value)) {
    if (value.length < 2) return null;
    const previousGeneration = integerValue(value[0]);
    const activeGeneration = integerValue(value[1]);
    return previousGeneration !== null && activeGeneration !== null && activeGeneration > previousGeneration
      ? { previousGeneration, activeGeneration }
      : null;
  }
  const nested =
    value.latestPublication
    ?? value.latest_publication
    ?? value.epochGenerationGraph
    ?? value.epoch_generation_graph
    ?? value.generationGraph
    ?? value.generation_graph
    ?? null;
  const previousGeneration = integerValue(
    value.previousGeneration
    ?? value.previous_generation
    ?? value.fromGeneration
    ?? value.from_generation
  );
  const activeGeneration = integerValue(
    value.activeGeneration
    ?? value.active_generation
    ?? value.toGeneration
    ?? value.to_generation
  );
  if (previousGeneration !== null && activeGeneration !== null && activeGeneration > previousGeneration) {
    return { previousGeneration, activeGeneration };
  }
  return generationLineageFromValue(nested);
}

function expectedHostIdentityGenerationLineage(observation = {}) {
  return generationLineageFromValue(observation.expectedGenerationLineage)
    ?? generationLineageFromValue(observation.expected_generation_lineage)
    ?? generationLineageFromValue(observation.epochGenerationGraph)
    ?? generationLineageFromValue(observation.epoch_generation_graph)
    ?? generationLineageFromValue(observation.generationGraph)
    ?? generationLineageFromValue(observation.generation_graph)
    ?? generationLineageFromValue(observation.epochProof?.epochGenerationGraph)
    ?? generationLineageFromValue(observation.epochProof?.epoch_generation_graph)
    ?? generationLineageFromValue(observation.epochProof?.generationGraph)
    ?? generationLineageFromValue(observation.epochProof)
    ?? null;
}

export function runtimeHostIdentityEvidence(lines, observation = {}) {
  const expectedSessions = expectedRuntimeSessionIds(observation);
  const expectedGenerationLineage = expectedHostIdentityGenerationLineage(observation);
  const lineageRequired = observation.requireGenerationLineage !== false;
  const rawRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bhost_identity\b/i))
    .map(hostIdentityRecord);
  const rejectedReasons = [];
  const records = [];
  for (const record of rawRecords) {
    const reason = hostIdentityRejectionReason(record, expectedSessions);
    if (reason) {
      rejectedReasons.push(reason);
    } else {
      records.push(record);
    }
  }
  const runtimeSessionIds = compactStringList(records.map((record) => record.runtimeSession));
  const processIds = processIdsFromRuntimeSessions(runtimeSessionIds);
  const runtimeSessionConsistent = runtimeSessionIds.length <= 1;
  const byRole = new Map();
  for (const record of records) {
    if (!byRole.has(record.role)) byRole.set(record.role, []);
    byRole.get(record.role).push(record);
  }

  const preservedRoles = [];
  const changedRoles = [];
  const lineageMissingRoles = [];
  const optionalLineageMissingRoles = [];
  for (const [role, roleRecords] of byRole) {
    const relevantRecords = expectedGenerationLineage
      ? roleRecords.filter((record) =>
        record.generation === expectedGenerationLineage.previousGeneration
        || record.generation === expectedGenerationLineage.activeGeneration)
      : roleRecords;
    const identities = new Set(relevantRecords.map((record) => `${record.ptr}:${record.aux ?? ''}`));
    const generations = new Set(relevantRecords.map((record) => record.generation));
    const roleCategory = hostIdentityRoleCategory(role);
    const lineageComplete = expectedGenerationLineage
      ? generations.has(expectedGenerationLineage.previousGeneration)
        && generations.has(expectedGenerationLineage.activeGeneration)
      : generations.size >= 2;
    if (identities.size === 1 && lineageComplete) {
      preservedRoles.push(role);
    } else if (identities.size > 1) {
      changedRoles.push(role);
    } else if (expectedGenerationLineage && relevantRecords.length > 0 && !lineageComplete) {
      if (roleCategory === null) {
        optionalLineageMissingRoles.push(role);
      } else {
        lineageMissingRoles.push(role);
      }
    }
  }
  preservedRoles.sort();
  changedRoles.sort();
  lineageMissingRoles.sort();
  optionalLineageMissingRoles.sort();
  const preservedRoleCategories = compactStringList(
    preservedRoles.map((role) => hostIdentityRoleCategory(role)),
  );
  const requiredRolesObserved =
    preservedRoleCategories.includes('runner_process')
    && preservedRoleCategories.includes('host_state')
    && preservedRoleCategories.includes('runtime_resource');
  const expectedGenerationLineageObserved =
    expectedGenerationLineage !== null
    && preservedRoles.length > 0
    && changedRoles.length === 0
    && lineageMissingRoles.length === 0;
  const snapshotEvidenceRefs =
    expectedGenerationLineageObserved
    && runtimeSessionConsistent
    && runtimeSessionIds.length === 1
      ? preservedRoles.map((role) =>
        `worker-log:host_identity_snapshot:${evidenceRefToken(runtimeSessionIds[0])}:${evidenceRefToken(role)}:${expectedGenerationLineage.previousGeneration}->${expectedGenerationLineage.activeGeneration}`
      )
      : [];

  return {
    raw_count: rawRecords.length,
    total_count: records.length,
    rejected_count: rawRecords.length - records.length,
    rejected_reasons: compactStringList(rejectedReasons),
    role_count: byRole.size,
    process_id: processIds.length === 1 ? processIds[0] : null,
    process_ids: processIds,
    expected_runtime_session_ids: expectedSessions,
    runtime_session_ids: runtimeSessionIds,
    runtime_session_observed: records.length > 0,
    runtime_session_consistent: runtimeSessionConsistent,
    expected_generation_lineage: expectedGenerationLineage,
    expected_generation_lineage_observed: expectedGenerationLineageObserved,
    identity_snapshot_lineage_required: lineageRequired,
    identity_snapshot_lineage_observed: expectedGenerationLineageObserved,
    lineage_identity_roles_observed: expectedGenerationLineage ? preservedRoles : [],
    lineage_identity_roles_missing: lineageMissingRoles,
    optional_lineage_identity_roles_missing: optionalLineageMissingRoles,
    preserved_roles: preservedRoles,
    changed_roles: changedRoles,
    preserved_role_categories: preservedRoleCategories,
    required_roles_observed: requiredRolesObserved,
    identity_snapshot_observed: preservedRoles.length > 0,
    identity_checks_passed:
      records.length > 0
      && runtimeSessionConsistent
      && (!lineageRequired || expectedGenerationLineageObserved)
      && changedRoles.length === 0
      && lineageMissingRoles.length === 0
      && preservedRoles.length > 0
      && requiredRolesObserved,
    evidence_refs: preservedRoles.map((role) => `worker-log:host_identity:${role}`),
    snapshot_evidence_refs: snapshotEvidenceRefs,
    lines: records.map((record) => record.line).slice(-20),
  };
}

export function hostPreservationProofFromRuntimeEvidence(lines, observation = {}) {
  const evidence = runtimeHostIdentityEvidence(lines, observation);
  const externalIdentityEvidenceRefs = Array.isArray(observation.identityEvidenceRefs)
    ? observation.identityEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const externalIdentitySnapshotEvidenceRefs = Array.isArray(observation.identitySnapshotEvidenceRefs)
    ? observation.identitySnapshotEvidenceRefs.filter((ref) => typeof ref === 'string' && ref.trim())
    : [];
  const proof = classifyGpuHmrHostPreservationProof({
    hostRestartObserved: observation.hostRestartObserved === true,
    hostReplacementObserved: observation.hostReplacementObserved === true,
    identityChecksPassed: evidence.identity_checks_passed,
    identitySnapshotObserved: evidence.identity_snapshot_observed,
    identitySnapshotLineageObserved: evidence.identity_snapshot_lineage_observed,
    requiredIdentityRolesObserved: evidence.required_roles_observed,
    processId: evidence.process_id,
    identityEvidenceRefs: [...evidence.evidence_refs, ...externalIdentityEvidenceRefs],
    identitySnapshotEvidenceRefs: [
      ...evidence.snapshot_evidence_refs,
      ...externalIdentitySnapshotEvidenceRefs,
    ],
  });
  return { evidence, proof };
}

function outputOracleRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    oracleId: fields.id ?? fields.oracle_id ?? null,
    requiredOracleId:
      fields.required_oracle_id
      ?? fields.requiredOracleId
      ?? fields.required_oracle
      ?? fields.required_id
      ?? null,
    kind: fields.kind ?? null,
    producer: fields.producer ?? fields.producer_id ?? null,
    expected: Object.prototype.hasOwnProperty.call(fields, 'expected') ? fields.expected : null,
    actual: Object.prototype.hasOwnProperty.call(fields, 'actual') ? fields.actual : null,
    tolerance: fields.tolerance ?? fields.absolute_tolerance ?? fields.abs_tolerance ?? null,
    passed: boolValue(fields.passed),
    generation: integerValue(fields.generation),
    runtimeSession: fields.runtime_session ?? null,
    outputTargetId: fields.output_target_id ?? fields.output_target ?? fields.target ?? null,
    readbackTimestamp:
      fields.readback_timestamp
      ?? fields.readback_ts
      ?? fields.readback_elapsed_ms
      ?? null,
    artifactId: fields.artifact_id ?? fields.artifact ?? null,
    visualEvidenceRef: fields.visual_evidence_ref ?? fields.visual_ref ?? null,
    probeMode: fields.probe_mode ?? fields.deterministic_probe_mode ?? null,
    probeConfigHash:
      fields.probe_config_hash
      ?? fields.deterministic_probe_config_hash
      ?? fields.probe_hash
      ?? null,
    probeEvidenceRef: fields.probe_evidence_ref ?? fields.probe_ref ?? null,
    readbackBytes: integerValue(fields.readback_bytes),
    readbackSampleStride: integerValue(fields.readback_sample_stride),
    readbackSampleSha256: fields.readback_sample_sha256 ?? null,
    readbackSampleHex: fields.readback_sample_hex ?? null,
  };
}

function normalizeOracleContract(contract) {
  if (!contract || typeof contract !== 'object') return null;
  const stringAlias = (aliases) => {
    for (const field of aliases) {
      if (typeof contract[field] === 'string' && contract[field].trim()) {
        return contract[field].trim();
      }
    }
    return null;
  };
  const oracleId = stringAlias(['id', 'oracleId', 'oracle_id']);
  const requiredOracleId = stringAlias([
    'requiredOracleId',
    'required_oracle_id',
    'requiredOracle',
    'required_oracle',
    'requiredId',
    'required_id',
  ]);
  const kind = stringAlias(['kind']);
  const expected = stringAlias(['expected', 'expectedValue', 'expected_value', 'expectedHash', 'expected_hash']);
  const producer = stringAlias(['producer', 'producerId', 'producer_id', 'producerSubsystem', 'producer_subsystem']);
  const outputTargetId = stringAlias([
    'outputTargetId',
    'output_target_id',
    'outputTarget',
    'output_target',
    'target',
  ]);
  const artifactId = stringAlias(['artifactId', 'artifact_id', 'artifact']);
  const runtimeSessionId = stringAlias([
    'runtimeSessionId',
    'runtime_session_id',
    'runtimeSession',
    'runtime_session',
    'sessionId',
    'session_id',
  ]);
  if (
    oracleId === null
    && requiredOracleId === null
    && kind === null
    && expected === null
    && producer === null
    && outputTargetId === null
    && artifactId === null
    && runtimeSessionId === null
  ) {
    return null;
  }
  return {
    oracleId,
    requiredOracleId,
    kind,
    expected,
    producer,
    outputTargetId,
    artifactId,
    runtimeSessionId,
  };
}

function oracleMatchesContract(record, contract) {
  if (!contract) return true;
  if (contract.oracleId !== null && record.oracleId !== contract.oracleId) return false;
  if (contract.requiredOracleId !== null && record.requiredOracleId !== contract.requiredOracleId) return false;
  if (contract.kind !== null && record.kind !== contract.kind) return false;
  if (contract.expected !== null && record.expected !== contract.expected) return false;
  if (contract.producer !== null && record.producer !== contract.producer) return false;
  if (contract.outputTargetId !== null && record.outputTargetId !== contract.outputTargetId) return false;
  if (contract.artifactId !== null && record.artifactId !== contract.artifactId) return false;
  if (contract.runtimeSessionId !== null && record.runtimeSession !== contract.runtimeSessionId) return false;
  return true;
}

function expectedRuntimeSessionIds(observation = {}) {
  const explicit = Array.isArray(observation.expectedRuntimeSessionIds)
    ? observation.expectedRuntimeSessionIds
    : Array.isArray(observation.runtimeSessionIds)
      ? observation.runtimeSessionIds
      : [];
  return compactStringList(explicit);
}

function originalHostPathRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    event: fields.event ?? null,
    runtimeSession: fields.runtime_session ?? null,
    attached: boolValue(fields.attached ?? fields.attachment_proven),
    dispatchBoundaryObserved: boolValue(fields.dispatch_boundary_observed),
    attachmentProvenance:
      fields.attachment_provenance
      ?? fields.attachmentProvenance
      ?? fields.provenance
      ?? null,
    hostPathId: fields.host_path_id ?? fields.hostPathId ?? null,
    dispatchTableEntryId: fields.dispatch_table_entry_id ?? fields.dispatchTableEntryId ?? null,
    runtimeDispatchTableEntryId:
      fields.runtime_dispatch_table_entry_id
      ?? fields.runtimeDispatchTableEntryId
      ?? null,
    dispatchEntryRuntimeVerified: boolValue(
      fields.dispatch_entry_runtime_verified
      ?? fields.dispatchEntryRuntimeVerified
      ?? fields.dispatch_entry_matches_runtime
      ?? fields.dispatchEntryMatchesRuntime,
    ),
    generation: integerValue(fields.generation),
    functionPtr: fields.function_ptr ?? fields.functionPtr ?? null,
    kernelSymbol:
      fields.kernel_symbol
      ?? fields.kernelSymbol
      ?? fields.kernel
      ?? null,
  };
}

function originalHostPathCandidateRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    event: fields.event ?? null,
    runtimeSession: fields.runtime_session ?? null,
    attachmentProvenance:
      fields.attachment_provenance
      ?? fields.attachmentProvenance
      ?? fields.provenance
      ?? null,
    hostPathId: fields.host_path_id ?? fields.hostPathId ?? null,
    launchSequence: integerValue(fields.launch_sequence ?? fields.sequence),
    frameIndex: integerValue(fields.frame_index ?? fields.frame),
    module: fields.module ?? null,
    symbol: fields.symbol ?? null,
    address: fields.address ?? null,
    functionPtr: fields.function_ptr ?? fields.functionPtr ?? null,
    kernelSymbol:
      fields.kernel_symbol
      ?? fields.kernelSymbol
      ?? fields.kernel
      ?? null,
  };
}

const ACCEPTED_ORIGINAL_HOST_PATH_ATTACHMENT_PROVENANCE = new Set([
  'runtime_explicit',
  'host_runtime_explicit',
]);

function originalHostPathAttachmentProvenanceAccepted(provenance) {
  return typeof provenance === 'string'
    && ACCEPTED_ORIGINAL_HOST_PATH_ATTACHMENT_PROVENANCE.has(provenance.trim().toLowerCase());
}

function originalHostDispatchEntryMatchesRuntime(record) {
  const declaredEntry = typeof record?.dispatchTableEntryId === 'string'
    ? record.dispatchTableEntryId.trim()
    : '';
  const runtimeEntry = typeof record?.runtimeDispatchTableEntryId === 'string'
    ? record.runtimeDispatchTableEntryId.trim()
    : '';
  return declaredEntry.length > 0
    && runtimeEntry.length > 0
    && runtimeEntry !== 'none'
    && declaredEntry === runtimeEntry;
}

function launchBoundaryRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    runtimeSession: fields.runtime_session ?? null,
    generation: integerValue(fields.generation),
    dispatchTableEntryId: fields.dispatch_table_entry_id ?? fields.dispatchTableEntryId ?? null,
    dispatchTimestamp: integerValue(fields.dispatch_timestamp ?? fields.dispatchTimestamp),
    complete: boolValue(fields.complete),
  };
}

function dispatchBoundaryRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  return {
    line,
    runtimeSession: fields.runtime_session ?? null,
    dispatch: fields.dispatch ?? null,
    dispatchTableEntryId: fields.dispatch_table_entry_id ?? fields.dispatchTableEntryId ?? null,
  };
}

function runtimeErrorRecord(line) {
  const text = String(line ?? '').trim();
  if (!text) return null;
  if (
    !/\[(?:ERR|ERROR)\s*\]/i.test(text)
    && !/\bgpu_runtime_error\b/i.test(text)
    && !/\bruntime error\b/i.test(text)
    && !/\bfatal\b/i.test(text)
  ) {
    return null;
  }
  const sourceMatch = /\bon line\s+(\d+)\s+in\s+['"]([^'"]+)['"]/i.exec(text);
  const bracketMatch = /\[(?:ERR|ERROR)\s*\]\s*(.+)$/i.exec(text);
  const sourceFile = sourceMatch?.[2] ?? null;
  const sourceFileName = sourceFile
    ? sourceFile.replace(/\\/g, '/').split('/').filter(Boolean).at(-1) ?? null
    : null;
  const sourceLine = sourceMatch ? integerValue(sourceMatch[1]) : null;
  const evidenceRef = [
    'worker-log:runtime_error',
    evidenceRefToken(sourceFileName ?? 'unknown-source'),
    Number.isFinite(sourceLine) ? sourceLine : 'unknown-line',
  ].join(':');
  return {
    line: text,
    message: bracketMatch?.[1] ?? text,
    source_file: sourceFile,
    source_file_name: sourceFileName,
    source_line: sourceLine,
    evidence_ref: evidenceRef,
  };
}

export function runtimeOriginalHostPathEvidence(lines, observation = {}) {
  const expectedSessions = expectedRuntimeSessionIds(observation);
  const nativeLaunchObserverReadyRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bnative_launch_observer_ready\b/i))
    .map((line) => {
      const fields = parseRuntimeKeyValues(line);
      return {
        line,
        runtimeSession: fields.runtime_session ?? null,
        pid: integerValue(fields.pid),
        mode: fields.mode ?? null,
        apis: compactStringList(String(fields.apis ?? '').split(',')),
        functionResolutionApis: compactStringList(
          String(fields.function_resolution_apis ?? fields.functionResolutionApis ?? '').split(','),
        ),
        textureObjectApis: compactStringList(
          String(fields.texture_object_apis ?? fields.textureObjectApis ?? '').split(','),
        ),
        arrayAllocationApis: compactStringList(
          String(fields.array_allocation_apis ?? fields.arrayAllocationApis ?? '').split(','),
        ),
        attachmentProvenance:
          fields.attachment_provenance
          ?? fields.attachmentProvenance
          ?? fields.provenance
          ?? null,
      };
    })
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && String(record.attachmentProvenance ?? '').trim().toLowerCase() === 'native_runtime_intercept'
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const nativeFunctionResolutionRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bnative_function_resolution\b/i))
    .map((line) => {
      const fields = parseRuntimeKeyValues(line);
      return {
        line,
        runtimeSession: fields.runtime_session ?? null,
        api: fields.api ?? null,
        module: fields.module ?? null,
        symbol: fields.symbol ?? null,
        functionPtr: fields.function_ptr ?? fields.functionPtr ?? null,
        result: integerValue(fields.result),
        resolution: fields.resolution ?? null,
        realResolverResolved: boolValue(
          fields.real_resolver_resolved
          ?? fields.realResolverResolved
          ?? fields.real_function_resolver_resolved
          ?? fields.realFunctionResolverResolved,
        ),
        attachmentProvenance:
          fields.attachment_provenance
          ?? fields.attachmentProvenance
          ?? fields.provenance
          ?? null,
      };
    })
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && typeof record.api === 'string'
      && record.api.trim()
      && typeof record.symbol === 'string'
      && record.symbol.trim()
      && typeof record.functionPtr === 'string'
      && record.functionPtr.trim()
      && record.functionPtr !== '0x0'
      && String(record.attachmentProvenance ?? '').trim().toLowerCase() === 'native_runtime_intercept'
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const nativeTextureObjectRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bnative_texture_object_create\b/i))
    .map((line) => {
      const fields = parseRuntimeKeyValues(line);
      return {
        line,
        runtimeSession: fields.runtime_session ?? null,
        api: fields.api ?? null,
        sequence: integerValue(fields.sequence),
        texture: fields.texture ?? null,
        textureOutPtr: fields.texture_out_ptr ?? fields.textureOutPtr ?? null,
        resourceDescPtr: fields.resource_desc_ptr ?? fields.resourceDescPtr ?? null,
        textureDescPtr: fields.texture_desc_ptr ?? fields.textureDescPtr ?? null,
        resourceViewDescPtr: fields.resource_view_desc_ptr ?? fields.resourceViewDescPtr ?? null,
        result: integerValue(fields.result),
        creation: fields.creation ?? null,
        realResolverResolved: boolValue(
          fields.real_resolver_resolved
          ?? fields.realResolverResolved
          ?? fields.real_function_resolver_resolved
          ?? fields.realFunctionResolverResolved,
        ),
        attachmentProvenance:
          fields.attachment_provenance
          ?? fields.attachmentProvenance
          ?? fields.provenance
          ?? null,
      };
    })
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && typeof record.api === 'string'
      && record.api.trim()
      && Number.isFinite(record.sequence)
      && String(record.attachmentProvenance ?? '').trim().toLowerCase() === 'native_runtime_intercept'
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const nativeArrayAllocationRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bnative_array_allocation\b/i))
    .map((line) => {
      const fields = parseRuntimeKeyValues(line);
      return {
        line,
        runtimeSession: fields.runtime_session ?? null,
        api: fields.api ?? null,
        sequence: integerValue(fields.sequence),
        array: fields.array ?? null,
        arrayOutPtr: fields.array_out_ptr ?? fields.arrayOutPtr ?? null,
        descriptorPtr: fields.descriptor_ptr ?? fields.descriptorPtr ?? null,
        descriptorKind: fields.descriptor_kind ?? fields.descriptorKind ?? null,
        channelX: integerValue(fields.channel_x ?? fields.channelX),
        channelY: integerValue(fields.channel_y ?? fields.channelY),
        channelZ: integerValue(fields.channel_z ?? fields.channelZ),
        channelW: integerValue(fields.channel_w ?? fields.channelW),
        channelFormatKind: integerValue(fields.channel_format_kind ?? fields.channelFormatKind),
        width: integerValue(fields.width),
        height: integerValue(fields.height),
        flags: integerValue(fields.flags),
        result: integerValue(fields.result),
        allocation: fields.allocation ?? null,
        realResolverResolved: boolValue(
          fields.real_resolver_resolved
          ?? fields.realResolverResolved
          ?? fields.real_function_resolver_resolved
          ?? fields.realFunctionResolverResolved,
        ),
        attachmentProvenance:
          fields.attachment_provenance
          ?? fields.attachmentProvenance
          ?? fields.provenance
          ?? null,
      };
    })
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && typeof record.api === 'string'
      && record.api.trim()
      && Number.isFinite(record.sequence)
      && String(record.attachmentProvenance ?? '').trim().toLowerCase() === 'native_runtime_intercept'
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const runtimeErrorRecords = (Array.isArray(lines) ? lines : [])
    .map(runtimeErrorRecord)
    .filter(Boolean)
    .slice(-20);
  const nativeLaunchAttemptRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bnative_launch_attempt\b/i))
    .map((line) => {
      const fields = parseRuntimeKeyValues(line);
      return {
        line,
        runtimeSession: fields.runtime_session ?? null,
        sequence: integerValue(fields.sequence),
        api: fields.api ?? null,
        functionPtr: fields.function_ptr ?? fields.functionPtr ?? null,
        kernelSymbol:
          fields.kernel_symbol
          ?? fields.kernelSymbol
          ?? fields.kernel
          ?? fields.symbol
          ?? null,
        realLaunchResolved: boolValue(fields.real_launch_resolved ?? fields.realLaunchResolved),
      };
    })
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const nativeLaunchRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bnative_launch_observed\b/i))
    .map((line) => {
      const fields = parseRuntimeKeyValues(line);
      return {
        line,
        runtimeSession: fields.runtime_session ?? null,
        sequence: integerValue(fields.sequence),
        api: fields.api ?? null,
        functionPtr: fields.function_ptr ?? fields.functionPtr ?? null,
        kernelSymbol:
          fields.kernel_symbol
          ?? fields.kernelSymbol
          ?? fields.kernel
          ?? fields.symbol
          ?? null,
      };
    })
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const candidateRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\boriginal_host_path_candidate\b/i))
    .map(originalHostPathCandidateRecord)
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && typeof record.hostPathId === 'string'
      && record.hostPathId.trim()
      && record.event === 'candidate'
      && String(record.attachmentProvenance ?? '').trim().toLowerCase() === 'native_runtime_intercept'
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const launchBoundaryRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\blaunch_arg_provenance\b/i))
    .map(launchBoundaryRecord)
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && Number.isFinite(record.generation)
      && typeof record.dispatchTableEntryId === 'string'
      && record.dispatchTableEntryId.trim()
      && record.dispatchTableEntryId !== 'none'
      && record.complete === true
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const dispatchBoundaryRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bsynthi_gpu_launch\b/i))
    .map(dispatchBoundaryRecord)
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && String(record.dispatch ?? '').trim().toLowerCase() === 'ok'
      && typeof record.dispatchTableEntryId === 'string'
      && record.dispatchTableEntryId.trim()
      && record.dispatchTableEntryId !== 'none'
      && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    );
  const rawRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) =>
      runtimeBoundaryEventLine(line, /\b(original_host_path|host_path_attachment|launch_attachment)\b/i)
    )
    .map(originalHostPathRecord);
  const records = rawRecords.filter((record) =>
    typeof record.runtimeSession === 'string'
    && record.runtimeSession.trim()
    && record.attached === true
    && record.dispatchBoundaryObserved === true
    && originalHostPathAttachmentProvenanceAccepted(record.attachmentProvenance)
    && typeof record.hostPathId === 'string'
    && record.hostPathId.trim()
    && originalHostDispatchEntryMatchesRuntime(record)
    && record.dispatchEntryRuntimeVerified === true
    && Number.isFinite(record.generation)
    && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
    && launchBoundaryRecords.some((launchRecord) =>
      launchRecord.runtimeSession === record.runtimeSession
      && launchRecord.generation === record.generation
      && launchRecord.dispatchTableEntryId === record.runtimeDispatchTableEntryId
    )
    && dispatchBoundaryRecords.some((dispatchRecord) =>
      dispatchRecord.runtimeSession === record.runtimeSession
      && dispatchRecord.dispatchTableEntryId === record.runtimeDispatchTableEntryId
    )
  );
  const runtimeSessionIds = compactStringList(records.map((record) => record.runtimeSession));
  const runtimeSessionConsistent = runtimeSessionIds.length <= 1;
  const latest = records.at(-1) ?? null;
  const matchingLaunchBoundary = latest
    ? launchBoundaryRecords.find((record) =>
        record.runtimeSession === latest.runtimeSession
        && record.generation === latest.generation
        && record.dispatchTableEntryId === latest.runtimeDispatchTableEntryId
      ) ?? null
    : null;
  const matchingDispatchBoundary = latest
    ? dispatchBoundaryRecords.find((record) =>
        record.runtimeSession === latest.runtimeSession
        && record.dispatchTableEntryId === latest.runtimeDispatchTableEntryId
      ) ?? null
    : null;
  const evidenceRefs = latest
    ? [
        `worker-log:original_host_path:${latest.hostPathId}:${latest.generation}`,
        `worker-log:launch_arg_provenance:${latest.runtimeSession}:${latest.generation}:${latest.runtimeDispatchTableEntryId}`,
        `worker-log:synthi_gpu_launch:${latest.runtimeSession}:${latest.runtimeDispatchTableEntryId}`,
      ]
    : [];
  const candidateEvidenceRefs = candidateRecords.slice(-20).map((record) => [
    'worker-log:original_host_path_candidate',
    evidenceRefToken(record.runtimeSession),
    evidenceRefToken(record.hostPathId),
    Number.isFinite(record.launchSequence) ? record.launchSequence : 'unknown',
    Number.isFinite(record.frameIndex) ? record.frameIndex : 'unknown',
  ].join(':'));
  const nativeLaunchObserverReadyEvidenceRefs = nativeLaunchObserverReadyRecords.slice(-20).map((record) => [
    'worker-log:native_launch_observer_ready',
    evidenceRefToken(record.runtimeSession),
    Number.isFinite(record.pid) ? record.pid : 'unknown',
  ].join(':'));
  const nativeFunctionResolutionEvidenceRefs = nativeFunctionResolutionRecords.slice(-20).map((record) => [
    'worker-log:native_function_resolution',
    evidenceRefToken(record.runtimeSession),
    evidenceRefToken(record.symbol),
    evidenceRefToken(record.functionPtr),
  ].join(':'));
  const nativeTextureObjectEvidenceRefs = nativeTextureObjectRecords.slice(-20).map((record) => [
    'worker-log:native_texture_object_create',
    evidenceRefToken(record.runtimeSession),
    evidenceRefToken(record.api),
    Number.isFinite(record.sequence) ? record.sequence : 'unknown',
  ].join(':'));
  const nativeArrayAllocationEvidenceRefs = nativeArrayAllocationRecords.slice(-20).map((record) => [
    'worker-log:native_array_allocation',
    evidenceRefToken(record.runtimeSession),
    evidenceRefToken(record.api),
    Number.isFinite(record.sequence) ? record.sequence : 'unknown',
  ].join(':'));
  const runtimeErrorEvidenceRefs = compactStringList(
    runtimeErrorRecords.map((record) => record.evidence_ref),
  );
  const nativeLaunchObserverEnabled = observation.nativeLaunchObserverEnabled === true;
  const upstreamRunAttempted = observation.upstreamRunAttempted === true;
  const upstreamRunExitCode = Number.isInteger(observation.upstreamRunExitCode)
    ? observation.upstreamRunExitCode
    : null;
  const nativeLaunchObserved = nativeLaunchRecords.length > 0;
  const nativeLaunchAttemptObserved = nativeLaunchAttemptRecords.length > 0;
  const nativeTextureObjectFailureObserved = nativeTextureObjectRecords.some((record) =>
    String(record.creation ?? '').trim().toLowerCase() === 'failed'
    || (Number.isFinite(record.result) && record.result !== 0)
  );
  const nativeTextureObjectFailureBeforeLaunch =
    nativeTextureObjectFailureObserved
    && !nativeLaunchAttemptObserved
    && !nativeLaunchObserved;
  const nativeArrayAllocationFailureObserved = nativeArrayAllocationRecords.some((record) =>
    String(record.allocation ?? '').trim().toLowerCase() === 'failed'
    || (Number.isFinite(record.result) && record.result !== 0)
  );
  const nativeArrayAllocationFailureBeforeLaunch =
    nativeArrayAllocationFailureObserved
    && !nativeLaunchAttemptObserved
    && !nativeLaunchObserved;
  const nativeLaunchAttemptWithoutResult =
    nativeLaunchAttemptObserved
    && !nativeLaunchObserved;
  const nativeLaunchObserverSawNoLaunch =
    nativeLaunchObserverEnabled
    && upstreamRunAttempted
    && !nativeLaunchAttemptObserved
    && !nativeLaunchObserved;
  const upstreamRunFailedBeforeObservedLaunch =
    nativeLaunchObserverSawNoLaunch
    && upstreamRunExitCode !== null
    && upstreamRunExitCode !== 0;
  return {
    raw_count: rawRecords.length,
    total_count: records.length,
    native_launch_observer_ready_count: nativeLaunchObserverReadyRecords.length,
    native_launch_observer_ready: nativeLaunchObserverReadyRecords.length > 0,
    native_launch_observer_ready_runtime_session_ids: compactStringList(
      nativeLaunchObserverReadyRecords.map((record) => record.runtimeSession),
    ),
    native_launch_observer_api_coverage: compactStringList(
      nativeLaunchObserverReadyRecords.flatMap((record) => record.apis),
    ),
    native_function_resolution_api_coverage: compactStringList(
      nativeLaunchObserverReadyRecords.flatMap((record) => record.functionResolutionApis),
    ),
    native_texture_object_api_coverage: compactStringList(
      nativeLaunchObserverReadyRecords.flatMap((record) => record.textureObjectApis),
    ),
    native_array_allocation_api_coverage: compactStringList(
      nativeLaunchObserverReadyRecords.flatMap((record) => record.arrayAllocationApis),
    ),
    native_launch_observer_ready_evidence_refs: nativeLaunchObserverReadyEvidenceRefs,
    native_function_resolution_count: nativeFunctionResolutionRecords.length,
    native_function_resolution_observed: nativeFunctionResolutionRecords.length > 0,
    native_function_resolution_symbols: compactStringList(
      nativeFunctionResolutionRecords.map((record) => record.symbol),
    ),
    native_function_resolution_function_ptrs: compactStringList(
      nativeFunctionResolutionRecords.map((record) => record.functionPtr),
    ),
    native_function_resolution_evidence_refs: nativeFunctionResolutionEvidenceRefs,
    native_function_resolutions: nativeFunctionResolutionRecords.slice(-20).map((record) => ({
      runtime_session: record.runtimeSession,
      api: record.api,
      module: record.module,
      symbol: record.symbol,
      function_ptr: record.functionPtr,
      result: record.result,
      resolution: record.resolution,
      real_resolver_resolved: record.realResolverResolved,
      evidence_ref: [
        'worker-log:native_function_resolution',
        evidenceRefToken(record.runtimeSession),
        evidenceRefToken(record.symbol),
        evidenceRefToken(record.functionPtr),
      ].join(':'),
    })),
    native_texture_object_create_count: nativeTextureObjectRecords.length,
    native_texture_object_failure_count: nativeTextureObjectRecords.filter((record) =>
      String(record.creation ?? '').trim().toLowerCase() === 'failed'
      || (Number.isFinite(record.result) && record.result !== 0)
    ).length,
    native_texture_object_failure_observed: nativeTextureObjectFailureObserved,
    native_texture_object_failure_before_launch: nativeTextureObjectFailureBeforeLaunch,
    native_texture_object_apis: compactStringList(
      nativeTextureObjectRecords.map((record) => record.api),
    ),
    native_texture_object_evidence_refs: nativeTextureObjectEvidenceRefs,
    native_texture_object_records: nativeTextureObjectRecords.slice(-20).map((record) => ({
      runtime_session: record.runtimeSession,
      api: record.api,
      sequence: record.sequence,
      texture: record.texture,
      texture_out_ptr: record.textureOutPtr,
      resource_desc_ptr: record.resourceDescPtr,
      texture_desc_ptr: record.textureDescPtr,
      resource_view_desc_ptr: record.resourceViewDescPtr,
      result: record.result,
      creation: record.creation,
      real_resolver_resolved: record.realResolverResolved,
      evidence_ref: [
        'worker-log:native_texture_object_create',
        evidenceRefToken(record.runtimeSession),
        evidenceRefToken(record.api),
        Number.isFinite(record.sequence) ? record.sequence : 'unknown',
      ].join(':'),
    })),
    native_array_allocation_count: nativeArrayAllocationRecords.length,
    native_array_allocation_failure_count: nativeArrayAllocationRecords.filter((record) =>
      String(record.allocation ?? '').trim().toLowerCase() === 'failed'
      || (Number.isFinite(record.result) && record.result !== 0)
    ).length,
    native_array_allocation_failure_observed: nativeArrayAllocationFailureObserved,
    native_array_allocation_failure_before_launch: nativeArrayAllocationFailureBeforeLaunch,
    native_array_allocation_apis: compactStringList(
      nativeArrayAllocationRecords.map((record) => record.api),
    ),
    native_array_allocation_evidence_refs: nativeArrayAllocationEvidenceRefs,
    runtime_error_count: runtimeErrorRecords.length,
    runtime_error_evidence_refs: runtimeErrorEvidenceRefs,
    runtime_error_records: runtimeErrorRecords,
    runtime_error_source_locations: runtimeErrorRecords
      .filter((record) => record.source_file || Number.isFinite(record.source_line))
      .map((record) => ({
        source_file: record.source_file,
        source_file_name: record.source_file_name,
        source_line: record.source_line,
        evidence_ref: record.evidence_ref,
      })),
    native_array_allocation_records: nativeArrayAllocationRecords.slice(-20).map((record) => ({
      runtime_session: record.runtimeSession,
      api: record.api,
      sequence: record.sequence,
      array: record.array,
      array_out_ptr: record.arrayOutPtr,
      descriptor_ptr: record.descriptorPtr,
      descriptor_kind: record.descriptorKind,
      channel_x: record.channelX,
      channel_y: record.channelY,
      channel_z: record.channelZ,
      channel_w: record.channelW,
      channel_format_kind: record.channelFormatKind,
      width: record.width,
      height: record.height,
      flags: record.flags,
      result: record.result,
      allocation: record.allocation,
      real_resolver_resolved: record.realResolverResolved,
      evidence_ref: [
        'worker-log:native_array_allocation',
        evidenceRefToken(record.runtimeSession),
        evidenceRefToken(record.api),
        Number.isFinite(record.sequence) ? record.sequence : 'unknown',
      ].join(':'),
    })),
    native_launch_attempt_count: nativeLaunchAttemptRecords.length,
    native_launch_attempt_observed: nativeLaunchAttemptObserved,
    native_launch_attempt_without_result: nativeLaunchAttemptWithoutResult,
    native_launch_count: nativeLaunchRecords.length,
    native_launch_observed: nativeLaunchObserved,
    native_launch_symbols: compactStringList(
      [...nativeLaunchAttemptRecords, ...nativeLaunchRecords].map((record) => record.kernelSymbol),
    ),
    native_launch_function_ptrs: compactStringList(
      [...nativeLaunchAttemptRecords, ...nativeLaunchRecords].map((record) => record.functionPtr),
    ),
    native_launch_attempt_records: nativeLaunchAttemptRecords.slice(-20).map((record) => ({
      runtime_session: record.runtimeSession,
      sequence: record.sequence,
      api: record.api,
      function_ptr: record.functionPtr,
      kernel_symbol: record.kernelSymbol,
      real_launch_resolved: record.realLaunchResolved,
    })),
    native_launch_records: nativeLaunchRecords.slice(-20).map((record) => ({
      runtime_session: record.runtimeSession,
      sequence: record.sequence,
      api: record.api,
      function_ptr: record.functionPtr,
      kernel_symbol: record.kernelSymbol,
    })),
    native_launch_observer_enabled: nativeLaunchObserverEnabled,
    native_launch_observer_saw_no_launch: nativeLaunchObserverSawNoLaunch,
    upstream_run_attempted: upstreamRunAttempted,
    upstream_run_exit_code: upstreamRunExitCode,
    upstream_run_failed_before_observed_launch: upstreamRunFailedBeforeObservedLaunch,
    candidate_count: candidateRecords.length,
    attachment_candidate_observed: candidateRecords.length > 0,
    candidate_runtime_session_ids: compactStringList(
      candidateRecords.map((record) => record.runtimeSession),
    ),
    candidate_evidence_refs: candidateEvidenceRefs,
    attachment_candidates: candidateRecords.slice(-20).map((record) => ({
      runtime_session: record.runtimeSession,
      host_path_id: record.hostPathId,
      launch_sequence: record.launchSequence,
      frame_index: record.frameIndex,
      module: record.module,
      symbol: record.symbol,
      address: record.address,
      function_ptr: record.functionPtr,
      kernel_symbol: record.kernelSymbol,
      evidence_ref: [
        'worker-log:original_host_path_candidate',
        evidenceRefToken(record.runtimeSession),
        evidenceRefToken(record.hostPathId),
        Number.isFinite(record.launchSequence) ? record.launchSequence : 'unknown',
        Number.isFinite(record.frameIndex) ? record.frameIndex : 'unknown',
      ].join(':'),
    })),
    launch_boundary_count: launchBoundaryRecords.length,
    matching_launch_boundary_observed: matchingLaunchBoundary !== null,
    dispatch_boundary_count: dispatchBoundaryRecords.length,
    matching_dispatch_boundary_observed: matchingDispatchBoundary !== null,
    latest,
    expected_runtime_session_ids: expectedSessions,
    runtime_session_ids: runtimeSessionIds,
    runtime_session_observed: records.length > 0,
    runtime_session_consistent: runtimeSessionConsistent,
    attached_to_original_host_path: latest !== null,
    dispatch_boundary_observed: latest?.dispatchBoundaryObserved === true,
    runtime_evidence_observed:
      latest !== null
      && runtimeSessionConsistent
      && matchingLaunchBoundary !== null
      && matchingDispatchBoundary !== null,
    dispatch_entry_runtime_verified: latest?.dispatchEntryRuntimeVerified === true,
    runtime_dispatch_table_entry_id: latest?.runtimeDispatchTableEntryId ?? null,
    evidence_refs: evidenceRefs,
    lines: records.map((record) => record.line).slice(-20),
  };
}

export function originalHostPathProofFromRuntimeEvidence(lines, observation = {}) {
  const evidence = runtimeOriginalHostPathEvidence(lines, observation);
  const proof = classifyGpuHmrOriginalHostPathProof({
    required: observation.required === true,
    attachedToOriginalHostPath: evidence.attached_to_original_host_path,
    runtimeEvidenceObserved: evidence.runtime_evidence_observed,
    dispatchBoundaryObserved: evidence.dispatch_boundary_observed,
    dispatchEntryRuntimeVerified: evidence.dispatch_entry_runtime_verified,
    sessionScoped: evidence.runtime_session_observed && evidence.runtime_session_consistent,
    runtimeSessionIds: evidence.runtime_session_ids,
    runtimeSessionConsistent: evidence.runtime_session_consistent,
    evidenceRefs: evidence.evidence_refs,
    attachmentCandidateObserved: evidence.attachment_candidate_observed,
    candidateEvidenceRefs: evidence.candidate_evidence_refs,
    nativeFunctionResolutionObserved: evidence.native_function_resolution_observed,
    nativeLaunchObserved: evidence.native_launch_observed,
    nativeLaunchAttemptObserved: evidence.native_launch_attempt_observed,
    nativeLaunchAttemptWithoutResult: evidence.native_launch_attempt_without_result,
    nativeLaunchObserverEnabled: evidence.native_launch_observer_enabled,
    nativeLaunchObserverReady: evidence.native_launch_observer_ready,
    nativeTextureObjectFailureObserved: evidence.native_texture_object_failure_observed,
    nativeTextureObjectFailureBeforeLaunch: evidence.native_texture_object_failure_before_launch,
    nativeArrayAllocationFailureObserved: evidence.native_array_allocation_failure_observed,
    nativeArrayAllocationFailureBeforeLaunch: evidence.native_array_allocation_failure_before_launch,
    nativeLaunchObserverReadyEvidenceRefs: evidence.native_launch_observer_ready_evidence_refs,
    nativeFunctionResolutionEvidenceRefs: evidence.native_function_resolution_evidence_refs,
    nativeTextureObjectEvidenceRefs: evidence.native_texture_object_evidence_refs,
    nativeArrayAllocationEvidenceRefs: evidence.native_array_allocation_evidence_refs,
    nativeArrayAllocationRecords: evidence.native_array_allocation_records,
    runtimeErrorEvidenceRefs: evidence.runtime_error_evidence_refs,
    runtimeErrorRecords: evidence.runtime_error_records,
    runtimeErrorSourceLocations: evidence.runtime_error_source_locations,
    runtimeCapabilityPreflight:
      observation.runtimeCapabilityPreflight ?? observation.runtime_capability_preflight,
    nativeLaunchObserverSawNoLaunch: evidence.native_launch_observer_saw_no_launch,
    upstreamRunAttempted: evidence.upstream_run_attempted,
    upstreamRunExitCode: evidence.upstream_run_exit_code,
    upstreamRunFailedBeforeObservedLaunch: evidence.upstream_run_failed_before_observed_launch,
  });
  return { evidence, proof };
}

function artifactTransportRecord(line) {
  const fields = parseRuntimeKeyValues(line);
  const degradedState = fields.degraded_state ?? fields.degradedState ?? null;
  const degradedReason = fields.degraded_reason ?? fields.degradedReason ?? null;
  return {
    line,
    runtimeSession: fields.runtime_session ?? null,
    generation: integerValue(fields.generation),
    artifactHash: fields.artifact_hash ?? null,
    artifactBytes: integerValue(fields.artifact_bytes),
    reloadRequestTransport: fields.reload_request_transport ?? fields.reloadRequestTransport ?? null,
    selectedLoaderTransport: fields.selected_loader_transport ?? fields.selectedLoaderTransport ?? null,
    loaderApi: fields.loader_api ?? fields.loaderApi ?? null,
    ramReference: boolValue(fields.ram_reference ?? fields.ramArtifactReferenceProvided),
    ramBlobId: fields.ram_blob_id ?? fields.ramBlobId ?? null,
    ramTransportProven: boolValue(fields.ram_transport_proven ?? fields.ramTransportProven),
    degradedState: degradedState === 'none' ? null : degradedState,
    degradedReason: degradedReason === 'none' ? null : degradedReason,
    loadResult: fields.load_result ?? fields.loadResult ?? null,
  };
}

export function runtimeArtifactTransportEvidence(lines, observation = {}) {
  const expectedSessions = expectedRuntimeSessionIds(observation);
  const rawRecords = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\bartifact_transport\b/i))
    .map(artifactTransportRecord)
    .filter((record) =>
      typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
      && typeof record.selectedLoaderTransport === 'string'
      && record.selectedLoaderTransport.trim()
      && typeof record.reloadRequestTransport === 'string'
      && record.reloadRequestTransport.trim()
      && typeof record.artifactHash === 'string'
      && /^sha256:[0-9a-f]{64}$/i.test(record.artifactHash)
      && Number.isFinite(record.artifactBytes)
      && record.artifactBytes >= 0
    );
  const records = rawRecords.filter((record) =>
    expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession)
  );
  const latest = records.at(-1) ?? null;
  const runtimeSessionIds = compactStringList(records.map((record) => record.runtimeSession));
  const processIds = processIdsFromRuntimeSessions(runtimeSessionIds);
  const runtimeSessionConsistent = runtimeSessionIds.length <= 1;
  const loaderTransports = compactStringList(records.map((record) => record.selectedLoaderTransport));
  const reloadRequestTransports = compactStringList(records.flatMap((record) =>
    String(record.reloadRequestTransport ?? '').split(','),
  ));
  const ramArtifactReferenceProvided = records.some((record) => record.ramReference === true);
  const ramBlobIds = compactStringList(records.map((record) => record.ramBlobId));
  const artifactHashes = compactStringList(records.map((record) => record.artifactHash));
  const ramBlobIdentityForRecord = (record) => {
    if (record.ramReference !== true) return false;
    const artifactDigest = sha256Digest(record.artifactHash);
    const ramBlobDigest = artifactIdDigest(record.ramBlobId);
    return artifactDigest !== null && ramBlobDigest !== null && artifactDigest === ramBlobDigest;
  };
  const ramBlobIdentityProven = records.some(ramBlobIdentityForRecord);
  const ramTransportProven = records.some((record) =>
    (
      record.ramTransportProven === true
      || (
        record.ramReference === true
        && ['ram_bytes', 'ram_blob'].includes(String(record.selectedLoaderTransport ?? '').trim())
        && record.loadResult === 'ok'
      )
    )
    && ramBlobIdentityForRecord(record)
  );
  const effectiveRamTransportProven = ramTransportProven && runtimeSessionConsistent;
  const evidenceRefs = records.map((record) =>
    `worker-log:artifact_transport:${record.artifactHash ?? record.runtimeSession}`
  );
  const latestRamIdentityMissing =
    latest?.ramReference === true
    && (
      sha256Digest(latest.artifactHash) === null
      || artifactIdDigest(latest.ramBlobId) === null
      || sha256Digest(latest.artifactHash) !== artifactIdDigest(latest.ramBlobId)
    );

  return {
    total_count: rawRecords.length,
    matched_count: records.length,
    latest,
    process_id: processIds.length === 1 ? processIds[0] : null,
    process_ids: processIds,
    expected_runtime_session_ids: expectedSessions,
    runtime_session_ids: runtimeSessionIds,
    runtime_session_observed: records.length > 0,
    runtime_session_consistent: runtimeSessionConsistent,
    transport_evidence_observed: records.length > 0,
    ram_artifact_reference_provided: ramArtifactReferenceProvided,
    ram_blob_identity_proven: ramBlobIdentityProven,
    ram_blob_ids: ramBlobIds,
    artifact_hashes: artifactHashes,
    ram_transport_proven: effectiveRamTransportProven,
    loader_transports: loaderTransports,
    reload_request_transports: reloadRequestTransports,
    degraded_state: effectiveRamTransportProven ? null : latest?.degradedState ?? null,
    degraded_reason: effectiveRamTransportProven
      ? null
      : latestRamIdentityMissing
        ? 'ram_blob_identity_not_proven'
        : latest?.degradedReason ?? null,
    evidence_refs: compactStringList(evidenceRefs),
    lines: records.map((record) => record.line).slice(-20),
  };
}

export function runtimeOutputOracleEvidence(lines, observation = {}) {
  const records = (Array.isArray(lines) ? lines : [])
    .filter((line) => runtimeBoundaryEventLine(line, /\boutput_oracle\b/i))
    .map(outputOracleRecord)
    .filter((record) =>
      typeof record.oracleId === 'string'
      && record.oracleId.trim()
      && typeof record.kind === 'string'
      && record.kind.trim()
      && record.expected !== null
      && record.actual !== null
      && record.passed !== null
      && typeof record.runtimeSession === 'string'
      && record.runtimeSession.trim()
    );
  const expectedContract = normalizeOracleContract(observation.expectedOracle ?? observation.outputOracleContract);
  const expectedSessions = expectedRuntimeSessionIds(observation);
  const matchingRecords = records.filter((record) =>
    oracleMatchesContract(record, expectedContract)
    && (expectedSessions.length === 0 || expectedSessions.includes(record.runtimeSession))
  );
  const latest = matchingRecords.at(-1) ?? null;
  const passedRecords = matchingRecords.filter((record) => record.passed === true);
  const runtimeSessionIds = compactStringList(matchingRecords.map((record) => record.runtimeSession));
  const processIds = processIdsFromRuntimeSessions(runtimeSessionIds);
  const runtimeSessionConsistent = runtimeSessionIds.length <= 1;
  const evidenceRefs = latest ? [`worker-log:output_oracle:${latest.oracleId}`] : [];
  const expectedActualMatch = latest !== null && Object.is(latest.expected, latest.actual);
  const oracleKindAccepted = latest !== null && gpuHmrOutputOracleKindAccepted(latest.kind);
  const valueCompatibility = latest !== null
    ? gpuHmrOracleValuesCompatible(latest.expected, latest.actual, latest.tolerance)
    : {
        compatible: false,
        exact: false,
        toleranceApplied: false,
        toleranceValid: false,
      };

  return {
    total_count: records.length,
    matched_count: matchingRecords.length,
    passed_count: passedRecords.length,
    failed_count: matchingRecords.length - passedRecords.length,
    latest,
    expected_contract: expectedContract,
    process_id: processIds.length === 1 ? processIds[0] : null,
    process_ids: processIds,
    expected_runtime_session_ids: expectedSessions,
    runtime_session_ids: runtimeSessionIds,
    runtime_session_observed: latest !== null,
    runtime_session_consistent: runtimeSessionConsistent,
    deterministic_output_observed: latest !== null && latest.actual !== null && runtimeSessionConsistent,
    deterministic_oracle_provided:
      latest !== null && latest.expected !== null && oracleKindAccepted,
    deterministic_oracle_passed:
      latest?.passed === true && runtimeSessionConsistent && oracleKindAccepted && valueCompatibility.compatible,
    oracle_kind_accepted: oracleKindAccepted,
    expected_actual_match: expectedActualMatch,
    expected_actual_compatible: valueCompatibility.compatible,
    tolerance_applied: valueCompatibility.toleranceApplied,
    tolerance_valid: valueCompatibility.toleranceValid,
    output_oracle: latest
      ? {
          oracleId: latest.oracleId,
          requiredOracleId: latest.requiredOracleId,
          kind: latest.kind,
          producer: latest.producer,
          expected: latest.expected,
          actual: latest.actual,
          passed: latest.passed,
          tolerance: latest.tolerance,
          runtimeSession: latest.runtimeSession,
          processId: processIdFromRuntimeSession(latest.runtimeSession),
          outputTargetId: latest.outputTargetId,
          readbackTimestamp: latest.readbackTimestamp,
          artifactId: latest.artifactId,
          visualEvidenceRef: latest.visualEvidenceRef,
          probeMode: latest.probeMode,
          probeConfigHash: latest.probeConfigHash,
          readbackBytes: latest.readbackBytes,
          readbackSampleStride: latest.readbackSampleStride,
          readbackSampleSha256: latest.readbackSampleSha256,
          readbackSampleHex: latest.readbackSampleHex,
          probeEvidenceRefs: compactStringList([
            latest.probeEvidenceRef,
            ...evidenceRefs,
          ]),
          kindAccepted: oracleKindAccepted,
          evidenceRefs,
        }
      : null,
    evidence_refs: evidenceRefs,
    lines: records.map((record) => record.line).slice(-20),
  };
}
