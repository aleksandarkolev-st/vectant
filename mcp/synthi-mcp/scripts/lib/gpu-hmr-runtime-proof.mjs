import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual, types as utilTypes } from 'node:util';
import sharp from 'sharp';

import {
  classifyGpuHmrVisualEvidenceStats,
  evaluateRuntimeVisualControlObservationPair,
  materializeRuntimeVisualControlObservation,
  screenshotQualifiesAsVisualEvidence,
} from './gpu-hmr-visual-evidence.mjs';
import {
  sha256Bytes,
  sha256Text,
  validateArtifactLocator,
} from './gpu-hmr-artifact-cas.mjs';
import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
} from './gpu-hmr-runtime-adapter-capabilities-v2.mjs';
import {
  evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity,
} from './gpu-hmr-runtime-adapter-capabilities-versioned.mjs';
import {
  classifyGpuHmrOutputOracleKind,
} from './gpu-hmr-output-oracle-kind.mjs';

export const GPU_HMR_PROOF_SCHEMA_VERSION = 'synthi.gpu.hmr.proof.v1';
export const GPU_HMR_VERIFIED_OUTPUT_MODALITY_SCHEMA_VERSION =
  'synthi.gpu_hmr.verified_output_modality.v1';
export const GPU_HMR_VERIFIED_DISPATCH_TRACE_SCHEMA_VERSION =
  'synthi.gpu_hmr.verified_dispatch_trace.v1';
export const GPU_HMR_VERIFIED_VISUAL_CAPTURE_PROVENANCE_SCHEMA_VERSION =
  'synthi.gpu_hmr.verified_visual_capture_provenance.v1';
export const GPU_HMR_VERIFIED_VISUAL_EVIDENCE_SCHEMA_VERSION =
  'synthi.gpu_hmr.verified_visual_evidence.v1';

const PINNED_DISPATCH_PROOFS = new WeakMap();
const PINNED_DISPATCH_TRACE_EVIDENCE = new WeakMap();
const PINNED_OUTPUT_MODALITY_EVIDENCE = new WeakMap();
const PINNED_VISUAL_CAPTURE_PROVENANCE = new WeakMap();
// This pin protects support-analysis integrity only. It never grants visual authority.
const PINNED_VISUAL_SUPPORT_EVIDENCE = new WeakMap();
// The runner-owned issuer lives outside this module. Until it supplies a pinned
// native observation, serialized or caller-created visual declarations have no authority.
const PINNED_RUNNER_VISUAL_OBSERVATIONS = new WeakMap();

const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const VISUAL_FILE_LIMITS = Object.freeze({
  maxEncodedBytes: 32 * 1024 * 1024,
  maxDecodedBytes: 256 * 1024 * 1024,
  maxDimension: 16_384,
  maxPixels: 64 * 1024 * 1024,
  maxPages: 1,
  maxSourceStreamBytes: 8 * 1024 * 1024,
});
const VISUAL_TEMPORAL_LIMITS = Object.freeze({
  maxBeforeCaptureAgeNs: 5_000_000_000n,
});
const VISUAL_RUNNER_PROVENANCE_GAP =
  'visual_capture_provenance_runner_owned_native_observation_missing';

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

function epochGraphFromProof(proof) {
  if (!proof || typeof proof !== 'object') return {};
  if (proof.epochGenerationGraph && typeof proof.epochGenerationGraph === 'object') {
    return proof.epochGenerationGraph;
  }
  if (proof.epoch_generation_graph && typeof proof.epoch_generation_graph === 'object') {
    return proof.epoch_generation_graph;
  }
  if (proof.generationGraph && typeof proof.generationGraph === 'object') {
    return proof.generationGraph;
  }
  if (proof.generation_graph && typeof proof.generation_graph === 'object') {
    return proof.generation_graph;
  }
  return {};
}

function latestEpochPublicationFromProof(proof) {
  const graph = epochGraphFromProof(proof);
  const publication =
    graph.latestPublication && typeof graph.latestPublication === 'object'
      ? graph.latestPublication
      : graph.latest_publication && typeof graph.latest_publication === 'object'
        ? graph.latest_publication
        : null;
  if (publication) return publication;
  const publishEdges = Array.isArray(graph.edges)
    ? graph.edges.filter((edge) =>
        edge
        && typeof edge === 'object'
        && String(edge.kind ?? edge.event ?? '').toLowerCase() === 'publish'
      )
    : [];
  return publishEdges.at(-1) ?? null;
}

function activeEpochArtifactIdsFromProof(proof) {
  const publication = latestEpochPublicationFromProof(proof);
  return contentAddressedArtifactIds([
    proof?.newArtifactId,
    proof?.new_artifact_id,
    proof?.activeArtifactId,
    proof?.active_artifact_id,
    proof?.publishedArtifactId,
    proof?.published_artifact_id,
    publication?.newArtifactId,
    publication?.new_artifact_id,
    publication?.activeArtifactId,
    publication?.active_artifact_id,
    publication?.publishedArtifactId,
    publication?.published_artifact_id,
    ...artifactIdsFromSha256Hashes([
      proof?.newArtifactHash,
      proof?.new_artifact_hash,
      proof?.newHash,
      proof?.new_hash,
      publication?.newArtifactHash,
      publication?.new_artifact_hash,
      publication?.newHash,
      publication?.new_hash,
    ]),
  ]);
}

function latestEpochPublicationTimestampFromProof(proof) {
  const publication = latestEpochPublicationFromProof(proof);
  return finiteNonNegativeNumber(
    publication?.publishTimestampMs
    ?? publication?.publish_timestamp_ms
    ?? publication?.timestampMs
    ?? publication?.timestamp_ms
    ?? proof?.publishTimestampMs
    ?? proof?.publish_timestamp_ms
    ?? proof?.timestampMs
    ?? proof?.timestamp_ms,
  );
}

function latestEpochPublicationMonotonicTimestampFromProof(proof) {
  const publication = latestEpochPublicationFromProof(proof);
  const value =
    publication?.timestampMonotonicNs
    ?? publication?.timestamp_monotonic_ns
    ?? publication?.publishTimestampMonotonicNs
    ?? publication?.publish_timestamp_monotonic_ns
    ?? proof?.timestampMonotonicNs
    ?? proof?.timestamp_monotonic_ns
    ?? proof?.publishTimestampMonotonicNs
    ?? proof?.publish_timestamp_monotonic_ns;
  return value === null || value === undefined ? null : monotonicTimestamp(String(value));
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

const RUNTIME_DISPATCH_EVIDENCE_REF_PREFIXES = Object.freeze([
  'worker-log:synthi_gpu_launch:',
  'worker-log:native_runtime_dispatch:',
]);

function runtimeDispatchEvidenceRefs(refs) {
  return compactStringList(refs).filter((ref) => {
    const value = String(ref ?? '').toLowerCase();
    return RUNTIME_DISPATCH_EVIDENCE_REF_PREFIXES.some((prefix) =>
      value.startsWith(prefix)
    );
  });
}

function runtimeDispatchEvidenceRefSession(ref) {
  const value = String(ref ?? '');
  const lower = value.toLowerCase();
  const prefix = RUNTIME_DISPATCH_EVIDENCE_REF_PREFIXES.find((candidate) =>
    lower.startsWith(candidate)
  );
  if (!prefix) return null;
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

const GPU_HMR_ABI_COMPATIBILITY_CLASSES = new Set(['compatible', 'additive', 'layout_changed', 'unknown']);

function abiCompatibilityClass(observation = {}) {
  const raw =
    observation.abiCompatibilityClass
    ?? observation.abi_compatibility_class
    ?? observation.abiClass
    ?? observation.abi_class
    ?? observation.compatibilityClass
    ?? observation.compatibility_class;
  const value = typeof raw === 'object' && raw !== null && !Array.isArray(raw)
    ? raw.value ?? raw.class ?? raw.abi_compatibility_class
    : raw;
  const normalized = typeof value === 'string' && value.trim()
    ? value.trim().toLowerCase()
    : null;
  return GPU_HMR_ABI_COMPATIBILITY_CLASSES.has(normalized) ? normalized : null;
}

function backendSpecificAdapterSafetyEvidence(observation = {}) {
  return compactStringList([
    ...(Array.isArray(observation.backendSpecificAdapterSafetyEvidenceRefs)
      ? observation.backendSpecificAdapterSafetyEvidenceRefs
      : []),
    ...(Array.isArray(observation.backend_specific_adapter_safety_evidence_refs)
      ? observation.backend_specific_adapter_safety_evidence_refs
      : []),
    ...(Array.isArray(observation.adapterSafetyEvidenceRefs)
      ? observation.adapterSafetyEvidenceRefs
      : []),
    ...(Array.isArray(observation.adapter_safety_evidence_refs)
      ? observation.adapter_safety_evidence_refs
      : []),
  ]);
}

function backendSpecificAdapterSafetyDeclared(observation = {}) {
  return observation.backendSpecificAdapterSafetyProven === true
    || observation.backend_specific_adapter_safety_proven === true;
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

function ownDataRecord(value) {
  if (
    value === null
    || typeof value !== 'object'
    || Array.isArray(value)
    || utilTypes.isProxy(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => Object.prototype.hasOwnProperty.call(descriptor, 'value'),
  );
}

function clonePlainData(value, seen = new Set()) {
  if (value === null || ['string', 'boolean'].includes(typeof value)) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (utilTypes.isProxy(value) || seen.has(value)) throw new Error('plain_data_tree_invalid');
    seen.add(value);
    const clone = value.map((entry) => clonePlainData(entry, seen));
    seen.delete(value);
    return clone;
  }
  if (!ownDataRecord(value) || seen.has(value)) throw new Error('plain_data_tree_invalid');
  seen.add(value);
  const clone = Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [key, clonePlainData(entry, seen)]),
  );
  seen.delete(value);
  return clone;
}

function deepFreezeData(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const entry of Object.values(value)) deepFreezeData(entry);
  return Object.isFrozen(value) ? value : Object.freeze(value);
}

function exactOwnKeys(value, keys) {
  return ownDataRecord(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.prototype.hasOwnProperty.call(value, key));
}

function aliasedEvidenceValue(sources, aliases) {
  const declarations = [];
  for (const source of sources) {
    if (!ownDataRecord(source)) continue;
    for (const alias of aliases) {
      if (Object.prototype.hasOwnProperty.call(source, alias)) {
        declarations.push({ alias, source, value: source[alias] });
      }
    }
  }
  const conflict = declarations.length > 1
    && declarations.some(({ value }) => !isDeepStrictEqual(value, declarations[0].value));
  return {
    value: conflict ? null : declarations[0]?.value ?? null,
    declared: declarations.length > 0,
    conflict,
    duplicate: declarations.length > 1,
  };
}

function frozenModalityFailure(failures) {
  const failedGates = Object.freeze([...new Set(failures)]);
  return Object.freeze({
    schemaVersion: GPU_HMR_VERIFIED_OUTPUT_MODALITY_SCHEMA_VERSION,
    accepted: false,
    modality: null,
    oracleKind: null,
    capabilityProofId: null,
    failedGates,
  });
}

export function verifyGpuHmrOutputModalityEvidence(capabilityFacet) {
  const integrity = evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity(capabilityFacet);
  const envelope = integrity.recomputedEnvelope;
  if (integrity.valid !== true || !envelope?.facet) {
    return frozenModalityFailure([
      'output_modality_capability_integrity_unverified',
      ...(Array.isArray(integrity.failures) ? integrity.failures : []),
    ]);
  }
  const facet = envelope.facet;
  if (
    envelope.schemaVersion !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION
    || envelope.historical !== false
    || facet.schemaVersion !== GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION
  ) {
    return frozenModalityFailure(['output_modality_capability_v2_required']);
  }
  const result = Object.freeze({
    schemaVersion: GPU_HMR_VERIFIED_OUTPUT_MODALITY_SCHEMA_VERSION,
    accepted: true,
    modality: facet.outputModality,
    oracleKind: facet.oracleKind,
    capabilityProofId: facet.proofId,
    capabilityBindingHash: facet.bindingHash,
    evidenceRefs: facet.evidenceRefs,
    failedGates: Object.freeze([]),
  });
  PINNED_OUTPUT_MODALITY_EVIDENCE.set(result, Object.freeze({
    modality: facet.outputModality,
    oracleKind: facet.oracleKind,
    capabilityProofId: facet.proofId,
    capabilityBindingHash: facet.bindingHash,
    evidenceRefs: facet.evidenceRefs,
  }));
  return result;
}

function outputModalityEvidenceFromObservation(observation, rawOracle) {
  const declaration = aliasedEvidenceValue(
    [observation, rawOracle],
    ['outputModalityEvidence', 'output_modality_evidence'],
  );
  const pinned = declaration.value && typeof declaration.value === 'object'
    ? PINNED_OUTPUT_MODALITY_EVIDENCE.get(declaration.value)
    : null;
  const kind = classifyGpuHmrOutputOracleKind(rawOracle.kind);
  const failedGates = [];
  if (declaration.conflict) failedGates.push('output_modality_evidence_alias_conflict');
  if (declaration.duplicate) failedGates.push('output_modality_evidence_duplicate');
  if (!pinned || declaration.value?.accepted !== true) {
    failedGates.push('output_modality_evidence_missing_or_unverified');
  }
  if (!kind.accepted) failedGates.push(kind.failureCode ?? 'output_oracle_kind_unaccepted');
  if (pinned && kind.accepted && pinned.oracleKind !== kind.kind) {
    failedGates.push('output_modality_evidence_oracle_kind_mismatch');
  }
  if (pinned && kind.accepted && pinned.modality !== kind.modality) {
    failedGates.push('output_modality_evidence_modality_mismatch');
  }
  return {
    accepted: failedGates.length === 0,
    declared: declaration.declared,
    modality: failedGates.length === 0 ? pinned.modality : null,
    registryModality: kind.modality,
    oracleKind: failedGates.length === 0 ? pinned.oracleKind : null,
    evidence: declaration.value,
    pinned,
    failedGates,
  };
}

function dispatchProofPublicIdentity(dispatchProof) {
  return {
    schemaVersion: stringField(dispatchProof?.schemaVersion),
    resultState: stringField(dispatchProof?.resultState),
    degradedState: dispatchProof?.degradedState ?? null,
    degradedReason: dispatchProof?.degradedReason ?? null,
    dispatchObserved: dispatchProof?.dispatchObserved === true,
    dispatchEvidenceObserved: dispatchProof?.dispatchEvidenceObserved === true,
    dispatchEvidenceRefs: compactStringList(dispatchProof?.dispatchEvidenceRefs),
    sessionScoped: dispatchProof?.sessionScoped === true,
    runtimeSessionObserved: dispatchProof?.runtimeSessionObserved === true,
    runtimeSessionIds: compactStringList(dispatchProof?.runtimeSessionIds),
    runtimeSessionConsistent: dispatchProof?.runtimeSessionConsistent === true,
    argProvenanceObserved: dispatchProof?.argProvenanceObserved === true,
    argProvenanceComplete: dispatchProof?.argProvenanceComplete === true,
    argProvenanceEvidenceObserved: dispatchProof?.argProvenanceEvidenceObserved === true,
    argProvenanceRecordComplete: dispatchProof?.argProvenanceRecordComplete === true,
    unknownArgCount: finiteNonNegativeNumber(dispatchProof?.unknownArgCount),
    abiProven: dispatchProof?.abiProven === true,
    abiProofEvidenceObserved: dispatchProof?.abiProofEvidenceObserved === true,
    epochSwapProven: dispatchProof?.epochSwapProven === true,
    epochProofEvidenceObserved: dispatchProof?.epochProofEvidenceObserved === true,
    streamOrderingProven: dispatchProof?.streamOrderingProven === true,
    replacementScopeProven: dispatchProof?.replacementScopeProven === true,
    runtimeTouchedSymbolsMatch: dispatchProof?.runtimeTouchedSymbolsMatch === true,
    runtimeArtifactMatchesSelected: dispatchProof?.runtimeArtifactMatchesSelected === true,
    selectedArtifactIds: contentAddressedArtifactIds(dispatchProof?.selectedArtifactIds),
    runtimeArtifactId: stringField(dispatchProof?.runtimeArtifactId),
    runtimeArtifactIds: dispatchRuntimeArtifactIdsFromProof(dispatchProof),
    dispatcherRegistrationIds: compactStringList(dispatchProof?.dispatcherRegistrationIds),
    dispatchTableEntryIds: compactStringList(dispatchProof?.dispatchTableEntryIds),
    dispatchTableHashes: compactStringList(dispatchProof?.dispatchTableHashes),
    dispatchStreamIds: compactStringList(dispatchProof?.dispatchStreamIds),
    gridDimensions: compactStringList(dispatchProof?.gridDimensions),
    blockDimensions: compactStringList(dispatchProof?.blockDimensions),
    sharedMemoryBytes: finiteNonNegativeNumberList(dispatchProof?.sharedMemoryBytes),
    dispatchTimestamps: finiteNonNegativeNumberList(dispatchProof?.dispatchTimestamps),
    dispatchId: stringField(dispatchProof?.dispatchId),
    processId: stringField(dispatchProof?.processId),
    epoch: stringField(dispatchProof?.epoch),
  };
}

function dispatchProofIdentity(dispatchProof) {
  const pinned = dispatchProof && typeof dispatchProof === 'object'
    ? PINNED_DISPATCH_PROOFS.get(dispatchProof)
    : null;
  if (!pinned || dispatchProof.resultState !== 'gpu-hmr-dispatch-safe-proven') return null;
  return isDeepStrictEqual(dispatchProofPublicIdentity(dispatchProof), pinned.publicIdentity)
    ? pinned
    : null;
}

function frozenDispatchTraceFailure(failures) {
  return Object.freeze({
    schemaVersion: GPU_HMR_VERIFIED_DISPATCH_TRACE_SCHEMA_VERSION,
    accepted: false,
    failedGates: Object.freeze([...new Set(failures)]),
  });
}

function parseRuntimeBoundaryFields(sourceLine, eventName) {
  if (typeof sourceLine !== 'string' || sourceLine.trim() !== sourceLine) return null;
  if (!/^[a-z][a-z0-9_]*$/.test(eventName)) return null;
  const marker = `[gpu-runtime-boundary] ${eventName} `;
  if (!sourceLine.startsWith(marker)) return null;
  const payload = sourceLine.slice(marker.length);
  if (!payload) return null;
  const fields = new Map();
  for (const token of payload.split(/\s+/)) {
    const field = token.match(/^([a-z][a-z0-9_]*)=([^\s=]+)$/);
    if (!field || fields.has(field[1])) return null;
    fields.set(field[1], field[2]);
  }
  return fields;
}

function parseDispatchTraceLine(sourceLine) {
  return parseRuntimeBoundaryFields(sourceLine, 'dispatch_trace');
}

function monotonicTimestamp(value) {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) return null;
  try {
    return BigInt(value) > 0n ? value : null;
  } catch {
    return null;
  }
}

function dispatchTraceAnchorFromObservation(observation, expected) {
  const declaration = aliasedEvidenceValue(
    [observation],
    ['dispatchTraceEvidence', 'dispatch_trace_evidence'],
  );
  const failures = [];
  if (declaration.conflict) failures.push('dispatch_trace_evidence_alias_conflict');
  if (declaration.duplicate) failures.push('dispatch_trace_evidence_duplicate');
  const candidate = declaration.value;
  if (!exactOwnKeys(candidate, [
    'evidenceRef',
    'sourceLine',
    'sourceLineHash',
    'sourceLineIndex',
    'sourceStreamHash',
  ])) {
    failures.push('dispatch_trace_evidence_field_set_invalid');
    return { anchor: null, failures };
  }
  const fields = parseDispatchTraceLine(candidate.sourceLine);
  if (!fields) failures.push('dispatch_trace_source_line_invalid');
  const sourceLineHash = typeof candidate.sourceLine === 'string'
    ? sha256Text(candidate.sourceLine)
    : null;
  const sourceLineIndex = Number.isInteger(candidate.sourceLineIndex) && candidate.sourceLineIndex >= 0
    ? candidate.sourceLineIndex
    : null;
  const trace = {
    dispatchId: fields?.get('dispatch_id') ?? null,
    dispatchTimestamp: monotonicTimestamp(fields?.get('timestamp_monotonic_ns')),
    processId: fields?.get('process_id') ?? null,
    runtimeSessionId: fields?.get('runtime_session') ?? null,
    runtimeArtifactId: fields?.get('artifact_id') ?? null,
    epoch: fields?.get('epoch') ?? null,
    outputTargetId: fields?.get('output_target_id') ?? null,
    deviceIdentity: fields?.get('device_identity') ?? null,
  };
  const evidenceRef = stringField(candidate.evidenceRef);
  const sourceStreamHash = /^sha256:[0-9a-f]{64}$/.test(candidate.sourceStreamHash ?? '')
    ? candidate.sourceStreamHash
    : null;
  if (!evidenceRef || !expected.dispatchEvidenceRefs.includes(evidenceRef)) {
    failures.push('dispatch_trace_evidence_ref_not_accepted_by_dispatch_proof');
  }
  if (!sourceLineHash || candidate.sourceLineHash !== sourceLineHash) {
    failures.push('dispatch_trace_source_line_hash_mismatch');
  }
  if (!sourceStreamHash) failures.push('dispatch_trace_source_stream_hash_invalid');
  if (sourceLineIndex === null) failures.push('dispatch_trace_source_line_index_invalid');
  for (const [field, value] of Object.entries(trace)) {
    if (!value) {
      failures.push(
        `dispatch_trace_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_missing`,
      );
    }
  }
  for (const field of [
    'dispatchId',
    'processId',
    'runtimeSessionId',
    'runtimeArtifactId',
    'epoch',
  ]) {
    if (trace[field] && trace[field] !== expected[field]) {
      failures.push(
        `dispatch_trace_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`,
      );
    }
  }
  if (!expected.epochPublicationTimestamp) {
    failures.push('dispatch_trace_epoch_publication_timestamp_unverified');
  } else if (
    trace.dispatchTimestamp
    && BigInt(trace.dispatchTimestamp) <= BigInt(expected.epochPublicationTimestamp)
  ) {
    failures.push('dispatch_trace_precedes_epoch_publication');
  }
  if (failures.length > 0) return { anchor: null, failures };
  return {
    anchor: Object.freeze({
      ...trace,
      evidenceRef,
      sourceLineHash,
      sourceLineIndex,
      sourceStreamHash,
    }),
    failures: [],
  };
}

export function verifyGpuHmrDispatchTraceEvidence(input) {
  if (!exactOwnKeys(input, ['dispatchProof'])) {
    return frozenDispatchTraceFailure(['dispatch_trace_evidence_field_set_invalid']);
  }
  const dispatchIdentity = dispatchProofIdentity(input.dispatchProof);
  if (!dispatchIdentity) {
    return frozenDispatchTraceFailure(['dispatch_trace_dispatch_proof_unverified']);
  }
  if (!dispatchIdentity.dispatchTraceAnchor) {
    return frozenDispatchTraceFailure(
      dispatchIdentity.dispatchTraceFailures.length > 0
        ? dispatchIdentity.dispatchTraceFailures
        : ['dispatch_trace_not_accepted_with_dispatch_proof'],
    );
  }

  const anchor = dispatchIdentity.dispatchTraceAnchor;
  const result = Object.freeze({
    schemaVersion: GPU_HMR_VERIFIED_DISPATCH_TRACE_SCHEMA_VERSION,
    accepted: true,
    proofAuthority: 'accepted_dispatch_proof_runtime_boundary_trace',
    ...anchor,
    failedGates: Object.freeze([]),
  });
  PINNED_DISPATCH_TRACE_EVIDENCE.set(result, Object.freeze({
    dispatchProof: input.dispatchProof,
    anchor,
  }));
  return result;
}

function dispatchTraceAnchor(dispatchProof, dispatchTraceEvidence) {
  const pinned = dispatchTraceEvidence && typeof dispatchTraceEvidence === 'object'
    ? PINNED_DISPATCH_TRACE_EVIDENCE.get(dispatchTraceEvidence)
    : null;
  if (!pinned || pinned.dispatchProof !== dispatchProof || !dispatchProofIdentity(dispatchProof)) {
    return null;
  }
  const current = {
    dispatchId: stringField(dispatchTraceEvidence.dispatchId),
    dispatchTimestamp: monotonicTimestamp(dispatchTraceEvidence.dispatchTimestamp),
    processId: stringField(dispatchTraceEvidence.processId),
    runtimeSessionId: stringField(dispatchTraceEvidence.runtimeSessionId),
    runtimeArtifactId: stringField(dispatchTraceEvidence.runtimeArtifactId),
    epoch: stringField(dispatchTraceEvidence.epoch),
    outputTargetId: stringField(dispatchTraceEvidence.outputTargetId),
    deviceIdentity: stringField(dispatchTraceEvidence.deviceIdentity),
    evidenceRef: stringField(dispatchTraceEvidence.evidenceRef),
    sourceLineHash: stringField(dispatchTraceEvidence.sourceLineHash),
    sourceLineIndex: Number.isInteger(dispatchTraceEvidence.sourceLineIndex)
      ? dispatchTraceEvidence.sourceLineIndex
      : null,
    sourceStreamHash: stringField(dispatchTraceEvidence.sourceStreamHash),
  };
  return isDeepStrictEqual(current, pinned.anchor) ? pinned.anchor : null;
}

function pathInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || Boolean(relative) && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function statIdentity(stat, includeSize = true) {
  const identity = {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: String(stat.birthtimeMs),
    ctimeMs: String(stat.ctimeMs),
  };
  if (includeSize) identity.size = String(stat.size);
  return identity;
}

function rootStatIdentity(stat) {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    birthtimeMs: String(stat.birthtimeMs),
  };
}

function handleAndPathIdentityMatch(handleIdentity, pathIdentity) {
  const deviceComparable = handleIdentity.dev !== '0' && pathIdentity.dev !== '0';
  return (!deviceComparable || handleIdentity.dev === pathIdentity.dev)
    && handleIdentity.ino === pathIdentity.ino
    && handleIdentity.birthtimeMs === pathIdentity.birthtimeMs
    && handleIdentity.ctimeMs === pathIdentity.ctimeMs
    && handleIdentity.size === pathIdentity.size;
}

function strictStableFileIdentity(pathIdentity, handleIdentity) {
  const device = handleIdentity.dev !== '0'
    ? handleIdentity.dev
    : pathIdentity.dev !== '0'
      ? pathIdentity.dev
      : null;
  const inode = handleIdentity.ino !== '0'
    ? handleIdentity.ino
    : pathIdentity.ino !== '0'
      ? pathIdentity.ino
      : null;
  if (!device || !inode) return null;
  return Object.freeze({
    device,
    inode,
    birthtimeMs: handleIdentity.birthtimeMs,
    ctimeMs: handleIdentity.ctimeMs,
    size: handleIdentity.size,
  });
}

function strictStableRootIdentity(pathIdentity, handleIdentity) {
  const device = handleIdentity.dev !== '0'
    ? handleIdentity.dev
    : pathIdentity.dev !== '0'
      ? pathIdentity.dev
      : null;
  const inode = handleIdentity.ino !== '0'
    ? handleIdentity.ino
    : pathIdentity.ino !== '0'
      ? pathIdentity.ino
      : null;
  if (!device || !inode || handleIdentity.birthtimeMs !== pathIdentity.birthtimeMs) return null;
  return Object.freeze({
    device,
    inode,
    birthtimeMs: handleIdentity.birthtimeMs,
  });
}

function stableFileIdentityKey(identity) {
  return identity?.device && identity?.inode
    ? `${identity.device}:${identity.inode}`
    : null;
}

function hardBoundedLimit(options, key) {
  const hardLimit = VISUAL_FILE_LIMITS[key];
  const requested = options?.limits?.[key] ?? options?.[key];
  return Number.isSafeInteger(requested) && requested > 0
    ? Math.min(requested, hardLimit)
    : hardLimit;
}

function hardBoundedTemporalLimit(options, key) {
  const hardLimit = VISUAL_TEMPORAL_LIMITS[key];
  const requested = options?.temporalLimits?.[key] ?? options?.[key];
  try {
    const normalized = requested === undefined ? hardLimit : BigInt(requested);
    return normalized > 0n && normalized < hardLimit ? normalized : hardLimit;
  } catch {
    return hardLimit;
  }
}

function publicAllowedRootBinding(binding) {
  return Object.freeze({
    path: binding.path,
    identity: Object.freeze({
      path: Object.freeze({ ...binding.identity.path }),
      handle: Object.freeze({ ...binding.identity.handle }),
      stable: Object.freeze({ ...binding.identity.stable }),
    }),
  });
}

async function closePinnedAllowedRoots(bindings) {
  await Promise.allSettled((Array.isArray(bindings) ? bindings : []).map(
    (binding) => binding?.handle?.close(),
  ));
}

async function pinAllowedRoots(allowedRoots, codePrefix) {
  if (
    !Array.isArray(allowedRoots)
    || utilTypes.isProxy(allowedRoots)
    || allowedRoots.length === 0
    || !allowedRoots.every((root) => typeof root === 'string' && root.trim())
  ) throw new Error(`${codePrefix}_allowed_root_missing`);
  const bindings = [];
  try {
    for (const root of allowedRoots) {
      let handle = null;
      try {
        const requestedPath = path.resolve(root);
        const pathMetadata = await lstat(requestedPath, { bigint: true });
        if (!pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()) {
          throw new Error(`${codePrefix}_allowed_root_not_stable_directory`);
        }
        const canonicalPath = await realpath(requestedPath);
        if (path.relative(requestedPath, canonicalPath) !== '') {
          throw new Error(`${codePrefix}_allowed_root_symlink_or_reparse`);
        }
        const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
        const directory = Number.isInteger(fsConstants.O_DIRECTORY) ? fsConstants.O_DIRECTORY : 0;
        handle = await open(requestedPath, fsConstants.O_RDONLY | noFollow | directory);
        const pathIdentity = rootStatIdentity(pathMetadata);
        const pathSnapshot = statIdentity(pathMetadata);
        const handleMetadata = await handle.stat({ bigint: true });
        const handleIdentity = rootStatIdentity(handleMetadata);
        const handleSnapshot = statIdentity(handleMetadata);
        if (
          !handleMetadata.isDirectory()
          || !handleAndPathIdentityMatch(handleIdentity, pathIdentity)
          || !handleAndPathIdentityMatch(handleSnapshot, pathSnapshot)
        ) throw new Error(`${codePrefix}_allowed_root_handle_path_identity_mismatch`);
        const stableIdentity = strictStableRootIdentity(pathIdentity, handleIdentity);
        if (!stableIdentity) {
          throw new Error(`${codePrefix}_allowed_root_stable_identity_unavailable`);
        }
        const binding = {
          path: canonicalPath,
          handle,
          identity: Object.freeze({
            path: Object.freeze(pathIdentity),
            handle: Object.freeze(handleIdentity),
            stable: stableIdentity,
          }),
          snapshot: Object.freeze({
            path: Object.freeze(pathSnapshot),
            handle: Object.freeze(handleSnapshot),
          }),
        };
        if (
          bindings.some((existing) => (
            existing.path === binding.path
            || stableFileIdentityKey(existing.identity.stable)
              === stableFileIdentityKey(binding.identity.stable)
          ))
        ) throw new Error(`${codePrefix}_allowed_root_duplicate`);
        bindings.push(binding);
        handle = null;
      } finally {
        if (handle) await handle.close();
      }
    }
    return bindings;
  } catch (error) {
    await closePinnedAllowedRoots(bindings);
    if (typeof error?.message === 'string' && error.message.startsWith(`${codePrefix}_`)) {
      throw error;
    }
    throw new Error(`${codePrefix}_allowed_root_unreadable`);
  }
}

async function verifyPinnedAllowedRoot(binding, codePrefix) {
  try {
    const pathMetadata = await lstat(binding.path, { bigint: true });
    if (!pathMetadata.isDirectory() || pathMetadata.isSymbolicLink()) {
      throw new Error(`${codePrefix}_allowed_root_replaced`);
    }
    const canonicalPath = await realpath(binding.path);
    if (canonicalPath !== binding.path) {
      throw new Error(`${codePrefix}_allowed_root_replaced`);
    }
    const pinnedHandleMetadata = await binding.handle.stat({ bigint: true });
    const pinnedHandleIdentity = rootStatIdentity(pinnedHandleMetadata);
    const pinnedHandleSnapshot = statIdentity(pinnedHandleMetadata);
    const currentPathIdentity = rootStatIdentity(pathMetadata);
    const currentPathSnapshot = statIdentity(pathMetadata);
    const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
    const directory = Number.isInteger(fsConstants.O_DIRECTORY) ? fsConstants.O_DIRECTORY : 0;
    const currentHandle = await open(binding.path, fsConstants.O_RDONLY | noFollow | directory);
    try {
      const currentHandleMetadata = await currentHandle.stat({ bigint: true });
      const currentHandleIdentity = rootStatIdentity(currentHandleMetadata);
      const currentHandleSnapshot = statIdentity(currentHandleMetadata);
      if (
        !currentHandleMetadata.isDirectory()
        || !isDeepStrictEqual(pinnedHandleIdentity, binding.identity.handle)
        || !isDeepStrictEqual(pinnedHandleSnapshot, binding.snapshot.handle)
        || !isDeepStrictEqual(currentPathIdentity, binding.identity.path)
        || !isDeepStrictEqual(currentPathSnapshot, binding.snapshot.path)
        || !isDeepStrictEqual(currentHandleIdentity, binding.identity.handle)
        || !isDeepStrictEqual(currentHandleSnapshot, binding.snapshot.handle)
        || !handleAndPathIdentityMatch(currentHandleIdentity, currentPathIdentity)
        || !handleAndPathIdentityMatch(currentHandleSnapshot, currentPathSnapshot)
        || !isDeepStrictEqual(
          strictStableRootIdentity(currentPathIdentity, currentHandleIdentity),
          binding.identity.stable,
        )
      ) throw new Error(`${codePrefix}_allowed_root_replaced`);
    } finally {
      await currentHandle.close();
    }
  } catch (error) {
    if (error?.message === `${codePrefix}_allowed_root_replaced`) throw error;
    throw new Error(`${codePrefix}_allowed_root_replaced`);
  }
}

function ancestorPathList(filePath, root) {
  const ancestors = [];
  let current = path.dirname(filePath);
  while (pathInsideRoot(current, root)) {
    ancestors.push(current);
    if (current === root) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return ancestors.reverse();
}

async function snapshotAncestorChain(filePath, root, codePrefix) {
  const snapshots = [];
  for (const ancestor of ancestorPathList(filePath, root)) {
    const metadata = await lstat(ancestor, { bigint: true });
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(`${codePrefix}_ancestor_not_stable_directory`);
    }
    snapshots.push({
      path: ancestor,
      realPath: await realpath(ancestor),
      identity: statIdentity(metadata, false),
    });
  }
  return snapshots;
}

async function stableAllowedRootRead(candidate, pinnedAllowedRoots, {
  codePrefix,
  maxBytes,
  afterFileOpen,
} = {}) {
  if (typeof candidate !== 'string' || !candidate.trim() || candidate.includes('\0')) {
    throw new Error(`${codePrefix}_path_invalid`);
  }
  const requested = path.resolve(candidate);
  const acceptedRoot = pinnedAllowedRoots.find((root) => pathInsideRoot(requested, root.path)) ?? null;
  if (!acceptedRoot) throw new Error(`${codePrefix}_path_outside_allowed_roots`);
  await verifyPinnedAllowedRoot(acceptedRoot, codePrefix);
  const pathStatBefore = await lstat(requested, { bigint: true });
  if (!pathStatBefore.isFile() || pathStatBefore.isSymbolicLink()) {
    throw new Error(`${codePrefix}_path_not_regular_file`);
  }
  const realPathBefore = await realpath(requested);
  if (path.relative(requested, realPathBefore) !== '') {
    throw new Error(`${codePrefix}_path_or_ancestor_symlink`);
  }
  if (!pathInsideRoot(realPathBefore, acceptedRoot.path)) {
    throw new Error(`${codePrefix}_path_outside_allowed_roots`);
  }
  const ancestorsBefore = await snapshotAncestorChain(realPathBefore, acceptedRoot.path, codePrefix);
  const pathIdentityBefore = statIdentity(pathStatBefore);
  const byteLimit = Number.isSafeInteger(maxBytes) && maxBytes > 0 ? maxBytes : 0;
  if (!byteLimit || pathStatBefore.size > BigInt(byteLimit)) {
    throw new Error(`${codePrefix}_encoded_bytes_limit_exceeded`);
  }

  const noFollow = Number.isInteger(fsConstants.O_NOFOLLOW) ? fsConstants.O_NOFOLLOW : 0;
  const binary = Number.isInteger(fsConstants.O_BINARY) ? fsConstants.O_BINARY : 0;
  const handle = await open(requested, fsConstants.O_RDONLY | noFollow | binary);
  try {
    const handleStatBefore = await handle.stat({ bigint: true });
    if (!handleStatBefore.isFile()) throw new Error(`${codePrefix}_handle_not_regular_file`);
    const handleIdentityBefore = statIdentity(handleStatBefore);
    if (!handleAndPathIdentityMatch(handleIdentityBefore, pathIdentityBefore)) {
      throw new Error(`${codePrefix}_handle_path_identity_mismatch`);
    }
    const stableIdentity = strictStableFileIdentity(pathIdentityBefore, handleIdentityBefore);
    if (!stableIdentity) throw new Error(`${codePrefix}_stable_file_identity_unavailable`);
    if (typeof afterFileOpen === 'function') {
      await afterFileOpen(Object.freeze({
        requestedPath: requested,
        realPath: realPathBefore,
        codePrefix,
      }));
    }
    const expectedSize = Number(handleStatBefore.size);
    if (!Number.isSafeInteger(expectedSize) || expectedSize > byteLimit) {
      throw new Error(`${codePrefix}_encoded_bytes_limit_exceeded`);
    }
    const allocation = Buffer.allocUnsafe(expectedSize);
    let bytesRead = 0;
    while (bytesRead < allocation.byteLength) {
      const read = await handle.read(
        allocation,
        bytesRead,
        allocation.byteLength - bytesRead,
        bytesRead,
      );
      if (read.bytesRead === 0) break;
      bytesRead += read.bytesRead;
    }
    const overflowProbe = Buffer.allocUnsafe(1);
    const overflow = await handle.read(overflowProbe, 0, 1, bytesRead);
    if (overflow.bytesRead !== 0 || bytesRead !== expectedSize) {
      throw new Error(`${codePrefix}_path_replaced_during_read`);
    }
    const bytes = allocation.subarray(0, bytesRead);
    const handleStatAfter = await handle.stat({ bigint: true });
    const pathStatAfter = await lstat(requested, { bigint: true });
    const realPathAfter = await realpath(requested);
    const ancestorsAfter = await snapshotAncestorChain(realPathAfter, acceptedRoot.path, codePrefix);
    await verifyPinnedAllowedRoot(acceptedRoot, codePrefix);
    if (
      !isDeepStrictEqual(statIdentity(handleStatAfter), handleIdentityBefore)
      || !isDeepStrictEqual(statIdentity(pathStatAfter), pathIdentityBefore)
      || !handleAndPathIdentityMatch(statIdentity(handleStatAfter), statIdentity(pathStatAfter))
      || realPathAfter !== realPathBefore
      || !isDeepStrictEqual(ancestorsAfter, ancestorsBefore)
    ) throw new Error(`${codePrefix}_path_replaced_during_read`);
    return Object.freeze({
      path: realPathBefore,
      bytes,
      contentHash: sha256Bytes(bytes),
      identity: Object.freeze({
        path: Object.freeze(pathIdentityBefore),
        handle: Object.freeze(handleIdentityBefore),
        stable: stableIdentity,
      }),
      allowedRoot: publicAllowedRootBinding(acceptedRoot),
    });
  } finally {
    await handle.close();
  }
}

function snapshotVisualRoleEntry(entry, role) {
  if (!ownDataRecord(entry)) throw new Error(`visual_evidence_${role}_entry_invalid`);
  const allowedKeys = new Set(['role', 'path', 'locator']);
  if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
    throw new Error(`visual_evidence_${role}_entry_field_set_invalid`);
  }
  try {
    return Object.freeze(clonePlainData(entry));
  } catch {
    throw new Error(`visual_evidence_${role}_entry_plain_data_invalid`);
  }
}

async function visualRoleBytes(entry, role, allowedRoots, pinnedAllowedRoots, options) {
  if (!ownDataRecord(entry)) throw new Error(`visual_evidence_${role}_entry_invalid`);
  const allowedKeys = new Set(['role', 'path', 'locator']);
  if (Object.keys(entry).some((key) => !allowedKeys.has(key))) {
    throw new Error(`visual_evidence_${role}_entry_field_set_invalid`);
  }
  if (entry.role !== role) throw new Error(`visual_evidence_${role}_role_mismatch`);
  const hasPath = Object.prototype.hasOwnProperty.call(entry, 'path');
  const hasLocator = Object.prototype.hasOwnProperty.call(entry, 'locator');
  if (!hasPath && !hasLocator) throw new Error(`visual_evidence_${role}_source_missing`);

  let locatorPath = null;
  let locatorValidation = null;
  if (hasLocator) {
    if (!ownDataRecord(entry.locator) || entry.locator.role !== role) {
      throw new Error(`visual_evidence_${role}_locator_role_mismatch`);
    }
    locatorValidation = await validateArtifactLocator(entry.locator, {
      allowedRoots,
      requireReadableBytes: false,
    });
    if (locatorValidation.accepted !== true) {
      throw new Error(`visual_evidence_${role}_locator_unverified`);
    }
    locatorPath = locatorValidation.localPath ?? locatorValidation.local_path ?? null;
  }
  const maxBytes = hardBoundedLimit(options, 'maxEncodedBytes');
  const afterFileOpen = typeof options?.afterFileOpen === 'function'
    ? (details) => options.afterFileOpen(Object.freeze({ ...details, role }))
    : null;
  const direct = hasPath
    ? await stableAllowedRootRead(entry.path, pinnedAllowedRoots, {
        codePrefix: `visual_evidence_${role}`,
        maxBytes,
        afterFileOpen,
      })
    : null;
  const located = locatorPath
    ? await stableAllowedRootRead(locatorPath, pinnedAllowedRoots, {
        codePrefix: `visual_evidence_${role}_locator`,
        maxBytes,
        afterFileOpen,
      })
    : null;
  if (
    direct
    && located
    && (
      direct.path !== located.path
      || !isDeepStrictEqual(direct.identity, located.identity)
      || direct.contentHash !== located.contentHash
    )
  ) {
    throw new Error(`visual_evidence_${role}_path_locator_mismatch`);
  }
  const verified = direct ?? located;
  if (!verified) throw new Error(`visual_evidence_${role}_readable_path_missing`);
  if (locatorValidation?.contentHash && locatorValidation.contentHash !== verified.contentHash) {
    throw new Error(`visual_evidence_${role}_locator_hash_mismatch`);
  }
  return {
    role,
    path: verified.path,
    bytes: verified.bytes,
    contentHash: verified.contentHash,
    fileIdentity: verified.identity,
    allowedRoot: verified.allowedRoot,
  };
}

function pngPreflight(bytes, role, options) {
  const fail = (suffix) => {
    throw new Error(`visual_evidence_${role}_${suffix}`);
  };
  if (!Buffer.isBuffer(bytes) || bytes.byteLength < 33 || !bytes.subarray(0, 8).equals(PNG_SIGNATURE)) {
    fail('png_signature_invalid');
  }
  const maxDimension = hardBoundedLimit(options, 'maxDimension');
  const maxPixels = hardBoundedLimit(options, 'maxPixels');
  const maxDecodedBytes = hardBoundedLimit(options, 'maxDecodedBytes');
  const maxPages = hardBoundedLimit(options, 'maxPages');
  let offset = 8;
  let chunkIndex = 0;
  let width = null;
  let height = null;
  let pages = 1;
  let idatObserved = false;
  let iendObserved = false;
  while (offset < bytes.byteLength) {
    if (bytes.byteLength - offset < 12) fail('png_chunk_bounds_invalid');
    const length = bytes.readUInt32BE(offset);
    if (length > bytes.byteLength - offset - 12) fail('png_chunk_bounds_invalid');
    const type = bytes.toString('ascii', offset + 4, offset + 8);
    const dataOffset = offset + 8;
    if (chunkIndex === 0 && (type !== 'IHDR' || length !== 13)) fail('png_ihdr_invalid');
    if (type === 'IHDR') {
      if (chunkIndex !== 0 || width !== null || length !== 13) fail('png_ihdr_invalid');
      width = bytes.readUInt32BE(dataOffset);
      height = bytes.readUInt32BE(dataOffset + 4);
      if (
        width <= 0
        || height <= 0
        || width > maxDimension
        || height > maxDimension
      ) fail('dimensions_limit_exceeded');
      const pixelCount = width * height;
      if (!Number.isSafeInteger(pixelCount) || pixelCount > maxPixels) {
        fail('pixel_limit_exceeded');
      }
      const decodedBytes = pixelCount * 4;
      if (!Number.isSafeInteger(decodedBytes) || decodedBytes > maxDecodedBytes) {
        fail('decoded_bytes_limit_exceeded');
      }
    } else if (type === 'acTL') {
      if (length !== 8) fail('png_animation_metadata_invalid');
      pages = bytes.readUInt32BE(dataOffset);
      if (pages <= 0 || pages > maxPages) fail('page_limit_exceeded');
    } else if (type === 'fcTL' || type === 'fdAT') {
      fail('page_limit_exceeded');
    } else if (type === 'IDAT') {
      idatObserved = true;
    } else if (type === 'IEND') {
      if (length !== 0 || iendObserved) fail('png_iend_invalid');
      iendObserved = true;
      offset += 12;
      if (offset !== bytes.byteLength) fail('png_trailing_bytes_invalid');
      break;
    }
    offset += length + 12;
    chunkIndex += 1;
  }
  if (width === null || height === null || !idatObserved || !iendObserved) {
    fail('png_structure_incomplete');
  }
  return Object.freeze({ width, height, pages, maxPixels, maxDecodedBytes });
}

function canonicalizeTransparentRgb(data) {
  const canonical = Buffer.from(data);
  for (let offset = 0; offset < canonical.byteLength; offset += 4) {
    if (canonical[offset + 3] === 0) {
      canonical[offset] = 0;
      canonical[offset + 1] = 0;
      canonical[offset + 2] = 0;
    }
  }
  return canonical;
}

function compositedChannel(channel, alpha) {
  return Math.round((channel * alpha) / 255);
}

function alphaAwareVisualQuality(data, width, height) {
  const pixels = width * height;
  let visiblePixels = 0;
  let lumaTotal = 0;
  let lumaSquareTotal = 0;
  const minChannel = [255, 255, 255];
  const maxChannel = [0, 0, 0];
  const uniqueSamples = new Set();
  const sampleStride = Math.max(1, Math.floor(pixels / 8192));
  let pixelIndex = 0;
  for (let offset = 0; offset < data.byteLength; offset += 4) {
    const alpha = data[offset + 3];
    const red = compositedChannel(data[offset], alpha);
    const green = compositedChannel(data[offset + 1], alpha);
    const blue = compositedChannel(data[offset + 2], alpha);
    const luma = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    lumaTotal += luma;
    lumaSquareTotal += luma * luma;
    if (alpha > 0 && (luma > 24 || Math.max(red, green, blue) - Math.min(red, green, blue) > 30)) {
      visiblePixels += 1;
    }
    minChannel[0] = Math.min(minChannel[0], red);
    minChannel[1] = Math.min(minChannel[1], green);
    minChannel[2] = Math.min(minChannel[2], blue);
    maxChannel[0] = Math.max(maxChannel[0], red);
    maxChannel[1] = Math.max(maxChannel[1], green);
    maxChannel[2] = Math.max(maxChannel[2], blue);
    if (pixelIndex % sampleStride === 0) uniqueSamples.add(`${red},${green},${blue},${alpha}`);
    pixelIndex += 1;
  }
  const meanLuma = pixels > 0 ? lumaTotal / pixels : 0;
  const variance = pixels > 0
    ? Math.max(0, (lumaSquareTotal / pixels) - (meanLuma * meanLuma))
    : 0;
  const stats = {
    width,
    height,
    visible_pixels: visiblePixels,
    mean_luma: meanLuma,
    luma_stddev: Math.sqrt(variance),
    rgb_span_mean: (
      (maxChannel[0] - minChannel[0])
      + (maxChannel[1] - minChannel[1])
      + (maxChannel[2] - minChannel[2])
    ) / 3,
    unique_color_sample_count: uniqueSamples.size,
  };
  return Object.freeze({
    ...stats,
    visual_quality: classifyGpuHmrVisualEvidenceStats(stats),
  });
}

async function decodedVisualRole(roleEvidence, role, options) {
  const preflight = pngPreflight(roleEvidence.bytes, role, options);
  const pipelineOptions = {
    animated: false,
    failOn: 'error',
    limitInputPixels: preflight.maxPixels,
    sequentialRead: true,
  };
  const metadata = await sharp(roleEvidence.bytes, pipelineOptions).metadata();
  if (
    metadata.format !== 'png'
    || metadata.width !== preflight.width
    || metadata.height !== preflight.height
    || Number(metadata.pages ?? 1) > 1
    || Number(metadata.pages ?? 1) > hardBoundedLimit(options, 'maxPages')
  ) throw new Error(`visual_evidence_${role}_png_metadata_mismatch`);
  const decoded = await sharp(roleEvidence.bytes, pipelineOptions)
    .toColourspace('srgb')
    .ensureAlpha()
    .raw({ depth: 'uchar' })
    .toBuffer({ resolveWithObject: true });
  const decodedByteLength = preflight.width * preflight.height * 4;
  if (
    decoded.info.width !== preflight.width
    || decoded.info.height !== preflight.height
    || decoded.info.channels !== 4
    || decoded.data.byteLength !== decodedByteLength
    || decodedByteLength > preflight.maxDecodedBytes
  ) throw new Error(`visual_evidence_${role}_decoded_layout_invalid`);
  const data = canonicalizeTransparentRgb(decoded.data);
  return {
    ...roleEvidence,
    data,
    decodedContentHash: sha256Bytes(data),
    width: preflight.width,
    height: preflight.height,
    channels: 4,
    quality: alphaAwareVisualQuality(data, preflight.width, preflight.height),
  };
}

async function verifiedVisualRoleBytes(entry, role, allowedRoots, pinnedAllowedRoots, options) {
  try {
    return await visualRoleBytes(entry, role, allowedRoots, pinnedAllowedRoots, options);
  } catch (error) {
    if (
      typeof error?.message === 'string'
      && /^visual_evidence_[a-z0-9_]+$/.test(error.message)
    ) throw error;
    throw new Error(`visual_evidence_${role}_byte_verification_failed`);
  }
}

async function verifiedDecodedVisualRoleBytes(roleEvidence, role, options) {
  try {
    return await decodedVisualRole(roleEvidence, role, options);
  } catch (error) {
    if (
      typeof error?.message === 'string'
      && /^visual_evidence_[a-z0-9_]+$/.test(error.message)
    ) throw error;
    throw new Error(`visual_evidence_${role}_byte_verification_failed`);
  }
}

function visualDiffMetrics(before, after, diff) {
  let changedPixels = 0;
  let absoluteDelta = 0;
  let diffMismatchPixels = 0;
  const pixels = before.width * before.height;
  for (let offset = 0; offset < before.data.length; offset += 4) {
    const beforeAlpha = before.data[offset + 3];
    const afterAlpha = after.data[offset + 3];
    const alphaDelta = Math.abs(beforeAlpha - afterAlpha);
    const expected = [0, 1, 2].map((channel) => Math.max(
      Math.abs(
        compositedChannel(before.data[offset + channel], beforeAlpha)
        - compositedChannel(after.data[offset + channel], afterAlpha)
      ),
      alphaDelta,
    ));
    if (expected[0] + expected[1] + expected[2] > 0) changedPixels += 1;
    absoluteDelta += expected[0] + expected[1] + expected[2];
    if (
      diff.data[offset] !== expected[0]
      || diff.data[offset + 1] !== expected[1]
      || diff.data[offset + 2] !== expected[2]
      || diff.data[offset + 3] !== 255
    ) diffMismatchPixels += 1;
  }
  return Object.freeze({
    pixelCount: pixels,
    changedPixels,
    changedPixelRatio: pixels > 0 ? changedPixels / pixels : 0,
    perceptualDiff: pixels > 0 ? absoluteDelta / (pixels * 3 * 255) : 0,
    diffMismatchPixels,
  });
}

const VISUAL_ORACLE_FIELD_SPECS = Object.freeze([
  ['oracleId', ['oracleId', 'oracle_id', 'id'], 'id'],
  ['requiredOracleId', ['requiredOracleId', 'required_oracle_id'], 'required_oracle_id'],
  ['kind', ['kind'], 'kind'],
  ['producer', ['producer'], 'producer'],
  ['expected', ['expected'], 'expected'],
  ['actual', ['actual'], 'actual'],
  ['passed', ['passed'], 'passed'],
  [
    'beforeEncodedHash',
    [
      'beforeEncodedHash', 'before_encoded_hash', 'beforeImageHash', 'before_image_hash',
      'beforeHash', 'before_hash',
    ],
    'before_encoded_hash',
  ],
  [
    'afterEncodedHash',
    [
      'afterEncodedHash', 'after_encoded_hash', 'afterImageHash', 'after_image_hash',
      'afterHash', 'after_hash',
    ],
    'after_encoded_hash',
  ],
  [
    'diffEncodedHash',
    [
      'diffEncodedHash', 'diff_encoded_hash', 'diffImageHash', 'diff_image_hash',
      'diffHash', 'diff_hash',
    ],
    'diff_encoded_hash',
  ],
  [
    'beforeDecodedHash',
    ['beforeDecodedHash', 'before_decoded_hash', 'beforeRawFrameHash', 'before_raw_frame_hash'],
    'before_decoded_hash',
  ],
  [
    'afterDecodedHash',
    ['afterDecodedHash', 'after_decoded_hash', 'afterRawFrameHash', 'after_raw_frame_hash'],
    'after_decoded_hash',
  ],
  [
    'diffDecodedHash',
    ['diffDecodedHash', 'diff_decoded_hash', 'diffRawFrameHash', 'diff_raw_frame_hash'],
    'diff_decoded_hash',
  ],
  ['width', ['width', 'frameWidth', 'frame_width'], 'width'],
  ['height', ['height', 'frameHeight', 'frame_height'], 'height'],
  [
    'outputTargetId',
    ['outputTargetId', 'output_target_id', 'outputTarget', 'output_target'],
    'output_target_id',
  ],
  ['processId', ['processId', 'process_id'], 'process_id'],
  [
    'runtimeSessionId',
    ['runtimeSessionId', 'runtimeSession', 'runtime_session', 'sessionId', 'session_id'],
    'runtime_session',
  ],
  ['deviceIdentity', ['deviceIdentity', 'device_identity'], 'device_identity'],
  [
    'afterDispatchId',
    ['afterDispatchId', 'after_dispatch_id', 'dispatchId', 'dispatch_id'],
    'after_dispatch_id',
  ],
  [
    'epoch',
    [
      'epoch', 'epoch_id', 'generation', 'outputEpoch', 'output_epoch',
      'outputGeneration', 'output_generation',
    ],
    'epoch',
  ],
  ['artifactId', ['artifactId', 'artifact_id'], 'artifact_id'],
  [
    'readbackTimestampMonotonicNs',
    [
      'readbackTimestampMonotonicNs',
      'readback_timestamp_monotonic_ns',
      'readbackTimestamp',
      'readback_timestamp',
      'readbackTs',
      'readback_ts',
    ],
    'readback_timestamp_monotonic_ns',
  ],
]);

const VISUAL_ORACLE_HASH_FIELDS = new Set([
  'expected',
  'actual',
  'beforeEncodedHash',
  'afterEncodedHash',
  'diffEncodedHash',
  'beforeDecodedHash',
  'afterDecodedHash',
  'diffDecodedHash',
]);

function strictVisualString(value) {
  return typeof value === 'string' && value.length > 0 && value.trim() === value
    ? value
    : null;
}

function normalizeVisualOracleField(key, value, sourceLine = false) {
  if (VISUAL_ORACLE_HASH_FIELDS.has(key)) {
    return typeof value === 'string' && /^sha256:[0-9a-f]{64}$/.test(value) ? value : null;
  }
  if (key === 'width' || key === 'height') {
    const number = sourceLine && typeof value === 'string' && /^[1-9][0-9]*$/.test(value)
      ? Number(value)
      : value;
    return Number.isSafeInteger(number) && number > 0 ? number : null;
  }
  if (key === 'passed') {
    if (sourceLine) return value === 'true' ? true : value === 'false' ? false : null;
    return typeof value === 'boolean' ? value : null;
  }
  if (key === 'readbackTimestampMonotonicNs') return monotonicTimestamp(value);
  return strictVisualString(value);
}

function visualOracleSemanticFailures(projection, prefix) {
  const failures = [];
  if (!projection) return [`${prefix}_invalid`];
  if (projection.oracleId !== projection.requiredOracleId) {
    failures.push(`${prefix}_contract_id_mismatch`);
  }
  if (projection.expected !== projection.afterEncodedHash) {
    failures.push(`${prefix}_expected_hash_mismatch`);
  }
  if (projection.actual !== projection.afterEncodedHash) {
    failures.push(`${prefix}_actual_hash_mismatch`);
  }
  if (projection.passed !== true) failures.push(`${prefix}_pass_status_invalid`);
  return failures;
}

function visualOracleProjectionFromRaw(rawOracle) {
  const failures = [];
  if (!ownDataRecord(rawOracle)) {
    return { projection: null, failures: ['visual_evidence_output_oracle_invalid'] };
  }
  const projection = {};
  const fieldBinding = {};
  for (const [key, aliases] of VISUAL_ORACLE_FIELD_SPECS) {
    const declaration = aliasedEvidenceValue([rawOracle], aliases);
    const fieldCode = key.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
    if (!declaration.declared) {
      failures.push(`visual_evidence_output_oracle_${fieldCode}_missing`);
      continue;
    }
    if (declaration.conflict) {
      failures.push(`visual_evidence_output_oracle_${fieldCode}_alias_conflict`);
      continue;
    }
    const normalized = normalizeVisualOracleField(key, declaration.value);
    if (normalized === null) {
      failures.push(`visual_evidence_output_oracle_${fieldCode}_invalid`);
      continue;
    }
    projection[key] = normalized;
    fieldBinding[key] = Object.freeze(aliases.flatMap((alias) => (
      Object.prototype.hasOwnProperty.call(rawOracle, alias)
        ? [Object.freeze({ alias, value: rawOracle[alias] })]
        : []
    )));
  }
  failures.push(...visualOracleSemanticFailures(
    Object.keys(projection).length === VISUAL_ORACLE_FIELD_SPECS.length ? projection : null,
    'visual_evidence_output_oracle',
  ));
  return {
    projection: failures.length === 0 ? Object.freeze(projection) : null,
    fieldBinding: failures.length === 0 ? deepFreezeData(fieldBinding) : null,
    failures: [...new Set(failures)],
  };
}

function visualOracleProjectionFromSourceLine(sourceLine) {
  const fields = parseRuntimeBoundaryFields(sourceLine, 'output_oracle');
  const expectedFields = VISUAL_ORACLE_FIELD_SPECS.map(([, , sourceField]) => sourceField);
  if (
    !fields
    || fields.size !== expectedFields.length
    || expectedFields.some((field) => !fields.has(field))
  ) return null;
  const projection = {};
  for (const [key, , sourceField] of VISUAL_ORACLE_FIELD_SPECS) {
    const normalized = normalizeVisualOracleField(key, fields.get(sourceField), true);
    if (normalized === null) return null;
    projection[key] = normalized;
  }
  return visualOracleSemanticFailures(projection, 'visual_capture_provenance_output_oracle').length === 0
    ? Object.freeze(projection)
    : null;
}

const VISUAL_CAPTURE_RECEIPT_FIELDS = Object.freeze([
  'role',
  'capture_event_id',
  'encoded_hash',
  'decoded_hash',
  'width',
  'height',
  'output_target_id',
  'process_id',
  'runtime_session',
  'device_identity',
  'dispatch_id',
  'epoch',
  'artifact_id',
  'timestamp_monotonic_ns',
]);

function parseVisualCaptureReceiptLine(sourceLine) {
  const fields = parseRuntimeBoundaryFields(sourceLine, 'visual_capture_receipt');
  if (
    !fields
    || fields.size !== VISUAL_CAPTURE_RECEIPT_FIELDS.length
    || VISUAL_CAPTURE_RECEIPT_FIELDS.some((field) => !fields.has(field))
  ) return null;
  const role = fields.get('role');
  const width = normalizeVisualOracleField('width', fields.get('width'), true);
  const height = normalizeVisualOracleField('height', fields.get('height'), true);
  const timestamp = monotonicTimestamp(fields.get('timestamp_monotonic_ns'));
  const encodedHash = normalizeVisualOracleField(
    'beforeEncodedHash',
    fields.get('encoded_hash'),
    true,
  );
  const decodedHash = normalizeVisualOracleField(
    'beforeDecodedHash',
    fields.get('decoded_hash'),
    true,
  );
  const strings = Object.fromEntries([
    ['captureEventId', 'capture_event_id'],
    ['outputTargetId', 'output_target_id'],
    ['processId', 'process_id'],
    ['runtimeSessionId', 'runtime_session'],
    ['deviceIdentity', 'device_identity'],
    ['dispatchId', 'dispatch_id'],
    ['epoch', 'epoch'],
    ['artifactId', 'artifact_id'],
  ].map(([key, field]) => [key, strictVisualString(fields.get(field))]));
  if (
    !['before', 'after', 'diff'].includes(role)
    || !width
    || !height
    || !timestamp
    || !encodedHash
    || !decodedHash
    || Object.values(strings).some((value) => !value)
  ) return null;
  return Object.freeze({
    role,
    encodedHash,
    decodedHash,
    width,
    height,
    timestampMonotonicNs: timestamp,
    ...strings,
  });
}

const VISUAL_DISPATCH_TRACE_FIELDS = Object.freeze([
  'artifact_id',
  'dispatch_id',
  'epoch',
  'output_target_id',
  'process_id',
  'runtime_session',
  'timestamp_monotonic_ns',
  'device_identity',
]);

function parseVisualDispatchObservationLine(sourceLine) {
  const fields = parseDispatchTraceLine(sourceLine);
  if (
    !fields
    || fields.size !== VISUAL_DISPATCH_TRACE_FIELDS.length
    || VISUAL_DISPATCH_TRACE_FIELDS.some((field) => !fields.has(field))
  ) return null;
  const timestamp = monotonicTimestamp(fields.get('timestamp_monotonic_ns'));
  const strings = Object.fromEntries([
    ['artifactId', 'artifact_id'],
    ['dispatchId', 'dispatch_id'],
    ['epoch', 'epoch'],
    ['outputTargetId', 'output_target_id'],
    ['processId', 'process_id'],
    ['runtimeSessionId', 'runtime_session'],
    ['deviceIdentity', 'device_identity'],
  ].map(([key, field]) => [key, strictVisualString(fields.get(field))]));
  if (!timestamp || Object.values(strings).some((value) => !value)) return null;
  return Object.freeze({ timestampMonotonicNs: timestamp, ...strings });
}

const VISUAL_PREVIOUS_OUTPUT_FIELDS = Object.freeze([
  'output_event_id',
  'encoded_hash',
  'decoded_hash',
  'width',
  'height',
  'output_target_id',
  'process_id',
  'runtime_session',
  'device_identity',
  'dispatch_id',
  'epoch',
  'artifact_id',
  'timestamp_monotonic_ns',
]);

function parseVisualPreviousOutputLine(sourceLine) {
  const fields = parseRuntimeBoundaryFields(sourceLine, 'visual_output_observation');
  if (
    !fields
    || fields.size !== VISUAL_PREVIOUS_OUTPUT_FIELDS.length
    || VISUAL_PREVIOUS_OUTPUT_FIELDS.some((field) => !fields.has(field))
  ) return null;
  const width = normalizeVisualOracleField('width', fields.get('width'), true);
  const height = normalizeVisualOracleField('height', fields.get('height'), true);
  const timestamp = monotonicTimestamp(fields.get('timestamp_monotonic_ns'));
  const encodedHash = normalizeVisualOracleField(
    'beforeEncodedHash',
    fields.get('encoded_hash'),
    true,
  );
  const decodedHash = normalizeVisualOracleField(
    'beforeDecodedHash',
    fields.get('decoded_hash'),
    true,
  );
  const strings = Object.fromEntries([
    ['outputEventId', 'output_event_id'],
    ['outputTargetId', 'output_target_id'],
    ['processId', 'process_id'],
    ['runtimeSessionId', 'runtime_session'],
    ['deviceIdentity', 'device_identity'],
    ['dispatchId', 'dispatch_id'],
    ['epoch', 'epoch'],
    ['artifactId', 'artifact_id'],
  ].map(([key, field]) => [key, strictVisualString(fields.get(field))]));
  if (
    !width
    || !height
    || !timestamp
    || !encodedHash
    || !decodedHash
    || Object.values(strings).some((value) => !value)
  ) return null;
  return Object.freeze({
    encodedHash,
    decodedHash,
    width,
    height,
    timestampMonotonicNs: timestamp,
    ...strings,
  });
}

function frozenVisualCaptureProvenanceFailure(failures) {
  return Object.freeze({
    schemaVersion: GPU_HMR_VERIFIED_VISUAL_CAPTURE_PROVENANCE_SCHEMA_VERSION,
    accepted: false,
    supportValidated: false,
    failedGates: Object.freeze([...new Set(failures)]),
  });
}

function sourceLineBinding(line, index) {
  return Object.freeze({ index, hash: sha256Text(line) });
}

function uniqueIndexedSourceLines(lines, marker) {
  return lines.flatMap((line, index) => line.startsWith(marker) ? [{ line, index }] : []);
}

export async function verifyGpuHmrVisualCaptureProvenance(input, options = {}) {
  const failures = [];
  let pinnedAllowedRoots = [];
  try {
    if (!exactOwnKeys(input, ['dispatchProof', 'dispatchTraceEvidence', 'sourceStreamPath'])) {
      return frozenVisualCaptureProvenanceFailure([
        'visual_capture_provenance_field_set_invalid',
      ]);
    }
    const dispatchAnchor = dispatchTraceAnchor(input.dispatchProof, input.dispatchTraceEvidence);
    if (!dispatchAnchor) {
      return frozenVisualCaptureProvenanceFailure([
        'visual_capture_provenance_dispatch_trace_unverified',
      ]);
    }
    const dispatchIdentity = dispatchProofIdentity(input.dispatchProof);
    const epochPublicationTimestamp = monotonicTimestamp(
      dispatchIdentity?.epochPublicationTimestamp === null
        || dispatchIdentity?.epochPublicationTimestamp === undefined
        ? null
        : String(dispatchIdentity.epochPublicationTimestamp),
    );
    if (!epochPublicationTimestamp) {
      return frozenVisualCaptureProvenanceFailure([
        'visual_capture_provenance_epoch_publication_timestamp_unverified',
      ]);
    }
    pinnedAllowedRoots = await pinAllowedRoots(
      options.allowedRoots,
      'visual_capture_provenance',
    );
    if (typeof options.afterAllowedRootsPinned === 'function') {
      await options.afterAllowedRootsPinned(Object.freeze(
        pinnedAllowedRoots.map(publicAllowedRootBinding),
      ));
    }
    const source = await stableAllowedRootRead(input.sourceStreamPath, pinnedAllowedRoots, {
      codePrefix: 'visual_capture_provenance_source_stream',
      maxBytes: hardBoundedLimit(options, 'maxSourceStreamBytes'),
      afterFileOpen: options.afterSourceFileOpen,
    });
    if (source.contentHash !== dispatchAnchor.sourceStreamHash) {
      failures.push('visual_capture_provenance_source_stream_hash_mismatch');
    }
    let text;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(source.bytes);
    } catch {
      failures.push('visual_capture_provenance_source_stream_utf8_invalid');
    }
    if (typeof text !== 'string' || text.includes('\0') || text.includes('\r')) {
      failures.push('visual_capture_provenance_source_stream_text_invalid');
    }
    if (failures.length > 0) return frozenVisualCaptureProvenanceFailure(failures);
    const lines = text.split('\n');
    const dispatchLine = lines[dispatchAnchor.sourceLineIndex] ?? null;
    if (
      !dispatchLine
      || sha256Text(dispatchLine) !== dispatchAnchor.sourceLineHash
      || !parseDispatchTraceLine(dispatchLine)
    ) failures.push('visual_capture_provenance_dispatch_line_mismatch');

    const controlCandidates = uniqueIndexedSourceLines(
      lines,
      '[gpu-runtime-boundary] visual_control_observation ',
    );
    const receiptCandidates = uniqueIndexedSourceLines(
      lines,
      '[gpu-runtime-boundary] visual_capture_receipt ',
    );
    const oracleCandidates = uniqueIndexedSourceLines(
      lines,
      '[gpu-runtime-boundary] output_oracle ',
    );
    const previousOutputCandidates = uniqueIndexedSourceLines(
      lines,
      '[gpu-runtime-boundary] visual_output_observation ',
    );
    const dispatchCandidates = uniqueIndexedSourceLines(
      lines,
      '[gpu-runtime-boundary] dispatch_trace ',
    );
    if (controlCandidates.length !== 2) {
      failures.push('visual_capture_provenance_control_line_count_invalid');
    }
    if (receiptCandidates.length !== 3) {
      failures.push('visual_capture_provenance_receipt_line_count_invalid');
    }
    if (oracleCandidates.length !== 1) {
      failures.push('visual_capture_provenance_output_oracle_line_count_invalid');
    }
    if (previousOutputCandidates.length !== 1) {
      failures.push('visual_capture_provenance_previous_output_line_count_invalid');
    }

    const receipts = new Map();
    for (const candidate of receiptCandidates) {
      const receipt = parseVisualCaptureReceiptLine(candidate.line);
      if (!receipt) {
        failures.push('visual_capture_provenance_receipt_line_invalid');
        continue;
      }
      if (receipts.has(receipt.role)) {
        failures.push(`visual_capture_provenance_${receipt.role}_receipt_duplicate`);
        continue;
      }
      receipts.set(receipt.role, Object.freeze({ ...receipt, ...sourceLineBinding(candidate.line, candidate.index) }));
    }
    for (const role of ['before', 'after', 'diff']) {
      if (!receipts.has(role)) failures.push(`visual_capture_provenance_${role}_receipt_missing`);
    }

    const controls = new Map();
    for (const candidate of controlCandidates) {
      const discovery = materializeRuntimeVisualControlObservation({ source_line: candidate.line });
      if (!['before', 'after'].includes(discovery.phase) || controls.has(discovery.phase)) {
        failures.push('visual_capture_provenance_control_phase_invalid_or_duplicate');
        continue;
      }
      controls.set(discovery.phase, candidate);
    }
    for (const phase of ['before', 'after']) {
      if (!controls.has(phase)) failures.push(`visual_capture_provenance_${phase}_control_missing`);
    }
    const sourceOracleProjection = oracleCandidates.length === 1
      ? visualOracleProjectionFromSourceLine(oracleCandidates[0].line)
      : null;
    if (!sourceOracleProjection) {
      failures.push('visual_capture_provenance_output_oracle_line_invalid');
    }
    const previousOutput = previousOutputCandidates.length === 1
      ? parseVisualPreviousOutputLine(previousOutputCandidates[0].line)
      : null;
    if (!previousOutput) {
      failures.push('visual_capture_provenance_previous_output_line_invalid');
    }
    const dispatchRecords = dispatchCandidates.map((candidate) => ({
      ...candidate,
      observation: parseVisualDispatchObservationLine(candidate.line),
    }));
    if (dispatchRecords.some((candidate) => !candidate.observation)) {
      failures.push('visual_capture_provenance_dispatch_line_invalid');
    }
    const currentDispatchRecords = dispatchRecords.filter((candidate) => (
      candidate.observation?.dispatchId === dispatchAnchor.dispatchId
    ));
    if (
      currentDispatchRecords.length !== 1
      || currentDispatchRecords[0]?.index !== dispatchAnchor.sourceLineIndex
    ) failures.push('visual_capture_provenance_current_dispatch_line_ambiguous');
    const previousDispatchRecords = previousOutput
      ? dispatchRecords.filter((candidate) => (
          candidate.observation?.dispatchId === previousOutput.dispatchId
        ))
      : [];
    if (previousDispatchRecords.length !== 1) {
      failures.push('visual_capture_provenance_previous_dispatch_line_ambiguous');
    }
    if (failures.length > 0) return frozenVisualCaptureProvenanceFailure(failures);

    const beforeReceipt = receipts.get('before');
    const afterReceipt = receipts.get('after');
    const diffReceipt = receipts.get('diff');
    const previousDispatchRecord = previousDispatchRecords[0];
    const previousDispatch = previousDispatchRecord.observation;
    const previousOutputCandidate = previousOutputCandidates[0];
    for (const receipt of [afterReceipt, diffReceipt]) {
      if (receipt.outputTargetId !== dispatchAnchor.outputTargetId) {
        failures.push(`visual_capture_provenance_${receipt.role}_output_target_mismatch`);
      }
      if (receipt.processId !== dispatchAnchor.processId) {
        failures.push(`visual_capture_provenance_${receipt.role}_process_mismatch`);
      }
      if (receipt.runtimeSessionId !== dispatchAnchor.runtimeSessionId) {
        failures.push(`visual_capture_provenance_${receipt.role}_session_mismatch`);
      }
      if (receipt.deviceIdentity !== dispatchAnchor.deviceIdentity) {
        failures.push(`visual_capture_provenance_${receipt.role}_device_mismatch`);
      }
      if (receipt.epoch !== dispatchAnchor.epoch) {
        failures.push(`visual_capture_provenance_${receipt.role}_epoch_mismatch`);
      }
      if (receipt.artifactId !== dispatchAnchor.runtimeArtifactId) {
        failures.push(`visual_capture_provenance_${receipt.role}_artifact_mismatch`);
      }
    }
    for (const receipt of [afterReceipt, diffReceipt]) {
      if (receipt.dispatchId !== dispatchAnchor.dispatchId) {
        failures.push(`visual_capture_provenance_${receipt.role}_dispatch_id_mismatch`);
      }
    }
    for (const [field, currentValue] of [
      ['outputTargetId', dispatchAnchor.outputTargetId],
      ['processId', dispatchAnchor.processId],
      ['runtimeSessionId', dispatchAnchor.runtimeSessionId],
      ['deviceIdentity', dispatchAnchor.deviceIdentity],
    ]) {
      if (previousDispatch[field] !== currentValue) {
        failures.push(`visual_capture_provenance_previous_dispatch_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
      }
      if (previousOutput[field] !== currentValue) {
        failures.push(`visual_capture_provenance_previous_output_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
      }
      if (beforeReceipt[field] !== currentValue) {
        failures.push(`visual_capture_provenance_before_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
      }
    }
    if (
      previousDispatch.dispatchId === dispatchAnchor.dispatchId
      || previousDispatch.artifactId === dispatchAnchor.runtimeArtifactId
      || previousDispatch.epoch === dispatchAnchor.epoch
    ) failures.push('visual_capture_provenance_previous_dispatch_identity_not_distinct');
    for (const field of ['dispatchId', 'epoch', 'artifactId']) {
      if (previousOutput[field] !== previousDispatch[field]) {
        failures.push(`visual_capture_provenance_previous_output_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
      }
      if (beforeReceipt[field] !== previousDispatch[field]) {
        failures.push(`visual_capture_provenance_before_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
      }
    }
    for (const field of ['encodedHash', 'decodedHash', 'width', 'height']) {
      if (beforeReceipt[field] !== previousOutput[field]) {
        failures.push(`visual_capture_provenance_before_previous_output_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
      }
    }
    if (
      beforeReceipt.width !== afterReceipt.width
      || beforeReceipt.height !== afterReceipt.height
      || beforeReceipt.width !== diffReceipt.width
      || beforeReceipt.height !== diffReceipt.height
    ) failures.push('visual_capture_provenance_dimensions_mismatch');

    const beforeControl = controls.get('before');
    const afterControl = controls.get('after');
    const oracleCandidate = oracleCandidates[0];
    if (!(
      previousDispatchRecord.index < previousOutputCandidate.index
      && previousOutputCandidate.index < beforeControl.index
      && beforeControl.index < beforeReceipt.index
      && beforeReceipt.index < dispatchAnchor.sourceLineIndex
      && dispatchAnchor.sourceLineIndex < afterControl.index
      && afterControl.index < afterReceipt.index
      && afterReceipt.index < diffReceipt.index
      && diffReceipt.index < oracleCandidate.index
    )) failures.push('visual_capture_provenance_source_line_order_unproven');
    const previousDispatchTimestamp = BigInt(previousDispatch.timestampMonotonicNs);
    const previousOutputTimestamp = BigInt(previousOutput.timestampMonotonicNs);
    const beforeTimestamp = BigInt(beforeReceipt.timestampMonotonicNs);
    const publicationTimestamp = BigInt(epochPublicationTimestamp);
    const currentDispatchTimestamp = BigInt(dispatchAnchor.dispatchTimestamp);
    const afterTimestamp = BigInt(afterReceipt.timestampMonotonicNs);
    const diffTimestamp = BigInt(diffReceipt.timestampMonotonicNs);
    if (
      previousDispatchTimestamp >= previousOutputTimestamp
      || previousOutputTimestamp >= beforeTimestamp
      || beforeTimestamp >= publicationTimestamp
      || publicationTimestamp >= currentDispatchTimestamp
      || afterTimestamp <= currentDispatchTimestamp
      || diffTimestamp < afterTimestamp
    ) failures.push('visual_capture_provenance_timestamp_order_unproven');
    const maxBeforeCaptureAgeNs = hardBoundedTemporalLimit(
      options,
      'maxBeforeCaptureAgeNs',
    );
    if (
      publicationTimestamp > beforeTimestamp
      && (
        publicationTimestamp - beforeTimestamp > maxBeforeCaptureAgeNs
        || currentDispatchTimestamp - beforeTimestamp > maxBeforeCaptureAgeNs
      )
    ) failures.push('visual_capture_provenance_before_capture_stale');
    if (
      beforeTimestamp > previousOutputTimestamp
      && beforeTimestamp - previousOutputTimestamp > maxBeforeCaptureAgeNs
    ) failures.push('visual_capture_provenance_previous_output_to_before_stale');

    const controlPair = evaluateRuntimeVisualControlObservationPair({
      before: materializeRuntimeVisualControlObservation({
        source_line: beforeControl.line,
        source_line_index: beforeControl.index,
        frame_hash: beforeReceipt.decodedHash,
        width: beforeReceipt.width,
        height: beforeReceipt.height,
        device_identity: beforeReceipt.deviceIdentity,
        dispatch_id: null,
      }),
      after: materializeRuntimeVisualControlObservation({
        source_line: afterControl.line,
        source_line_index: afterControl.index,
        frame_hash: afterReceipt.decodedHash,
        width: afterReceipt.width,
        height: afterReceipt.height,
        device_identity: afterReceipt.deviceIdentity,
        dispatch_id: afterReceipt.dispatchId,
      }),
      expected: {
        before_frame_hash: beforeReceipt.decodedHash,
        after_frame_hash: afterReceipt.decodedHash,
        width: beforeReceipt.width,
        height: beforeReceipt.height,
        process_id: dispatchAnchor.processId,
        runtime_session: dispatchAnchor.runtimeSessionId,
        device_identity: dispatchAnchor.deviceIdentity,
        dispatch_id: dispatchAnchor.dispatchId,
        dispatch_timestamp_monotonic_ns: dispatchAnchor.dispatchTimestamp,
        dispatch_line_index: dispatchAnchor.sourceLineIndex,
      },
    });
    if (controlPair.accepted !== true) {
      failures.push(...controlPair.failedGates.map(
        (gate) => `visual_capture_provenance_${gate}`,
      ));
    }
    if (
      controlPair.before?.capture_event_id !== beforeReceipt.captureEventId
      || controlPair.after?.capture_event_id !== afterReceipt.captureEventId
    ) failures.push('visual_capture_provenance_control_capture_event_mismatch');
    if (
      controlPair.before?.frame_timestamp_monotonic_ns !== beforeReceipt.timestampMonotonicNs
      || controlPair.after?.frame_timestamp_monotonic_ns !== afterReceipt.timestampMonotonicNs
    ) failures.push('visual_capture_provenance_control_timestamp_mismatch');

    const sourceRoleBindings = {
      before: [sourceOracleProjection.beforeEncodedHash, sourceOracleProjection.beforeDecodedHash],
      after: [sourceOracleProjection.afterEncodedHash, sourceOracleProjection.afterDecodedHash],
      diff: [sourceOracleProjection.diffEncodedHash, sourceOracleProjection.diffDecodedHash],
    };
    for (const role of ['before', 'after', 'diff']) {
      const receipt = receipts.get(role);
      if (
        receipt.encodedHash !== sourceRoleBindings[role][0]
        || receipt.decodedHash !== sourceRoleBindings[role][1]
      ) failures.push(`visual_capture_provenance_${role}_oracle_hash_mismatch`);
    }
    const oracleIdentityBindings = [
      ['width', beforeReceipt.width],
      ['height', beforeReceipt.height],
      ['outputTargetId', dispatchAnchor.outputTargetId],
      ['processId', dispatchAnchor.processId],
      ['runtimeSessionId', dispatchAnchor.runtimeSessionId],
      ['deviceIdentity', dispatchAnchor.deviceIdentity],
      ['afterDispatchId', dispatchAnchor.dispatchId],
      ['epoch', dispatchAnchor.epoch],
      ['artifactId', dispatchAnchor.runtimeArtifactId],
      ['readbackTimestampMonotonicNs', diffReceipt.timestampMonotonicNs],
    ];
    for (const [field, expected] of oracleIdentityBindings) {
      if (sourceOracleProjection[field] !== expected) {
        failures.push(`visual_capture_provenance_output_oracle_${field.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`)}_mismatch`);
      }
    }
    if (failures.length > 0) return frozenVisualCaptureProvenanceFailure(failures);

    const lineBindings = Object.freeze({
      previousDispatch: sourceLineBinding(
        previousDispatchRecord.line,
        previousDispatchRecord.index,
      ),
      previousOutput: sourceLineBinding(
        previousOutputCandidate.line,
        previousOutputCandidate.index,
      ),
      beforeControl: sourceLineBinding(beforeControl.line, beforeControl.index),
      beforeReceipt: sourceLineBinding(lines[beforeReceipt.index], beforeReceipt.index),
      dispatch: sourceLineBinding(dispatchLine, dispatchAnchor.sourceLineIndex),
      afterControl: sourceLineBinding(afterControl.line, afterControl.index),
      afterReceipt: sourceLineBinding(lines[afterReceipt.index], afterReceipt.index),
      diffReceipt: sourceLineBinding(lines[diffReceipt.index], diffReceipt.index),
      outputOracle: sourceLineBinding(oracleCandidate.line, oracleCandidate.index),
    });
    const result = deepFreezeData({
      schemaVersion: GPU_HMR_VERIFIED_VISUAL_CAPTURE_PROVENANCE_SCHEMA_VERSION,
      accepted: false,
      supportValidated: true,
      proofAuthority: 'caller_artifact_stream_verification_support_only',
      authorityGap: VISUAL_RUNNER_PROVENANCE_GAP,
      sourceStreamHash: source.contentHash,
      sourceStreamPath: source.path,
      sourceStreamFileIdentity: source.identity,
      sourceStreamStableFileIdentity: source.identity.stable,
      sourceStreamAllowedRoot: source.allowedRoot,
      dispatchId: dispatchAnchor.dispatchId,
      dispatchTimestamp: dispatchAnchor.dispatchTimestamp,
      epochPublicationTimestamp,
      processId: dispatchAnchor.processId,
      runtimeSessionId: dispatchAnchor.runtimeSessionId,
      deviceIdentity: dispatchAnchor.deviceIdentity,
      outputTargetId: dispatchAnchor.outputTargetId,
      epoch: dispatchAnchor.epoch,
      runtimeArtifactId: dispatchAnchor.runtimeArtifactId,
      previousDispatch,
      previousOutput,
      receipts: Object.freeze(Object.fromEntries(receipts)),
      lineBindings,
      outputOracleProjection: sourceOracleProjection,
      controlPair,
      failedGates: [VISUAL_RUNNER_PROVENANCE_GAP],
    });
    PINNED_VISUAL_CAPTURE_PROVENANCE.set(result, Object.freeze({
      dispatchProof: input.dispatchProof,
      dispatchTraceEvidence: input.dispatchTraceEvidence,
      dispatchAnchor,
      supportValidated: true,
      sourceStreamAllowedRoot: source.allowedRoot,
      publicIdentity: clonePlainData(result),
    }));
    return result;
  } catch (error) {
    const code = typeof error?.message === 'string'
      && /^visual_capture_provenance_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'visual_capture_provenance_verification_failed';
    return frozenVisualCaptureProvenanceFailure([code]);
  } finally {
    await closePinnedAllowedRoots(pinnedAllowedRoots);
  }
}

function visualCaptureSupportAnchor(
  dispatchProof,
  dispatchTraceEvidence,
  captureProvenance,
) {
  const pinned = captureProvenance && typeof captureProvenance === 'object'
    ? PINNED_VISUAL_CAPTURE_PROVENANCE.get(captureProvenance)
    : null;
  if (
    !pinned
    || pinned.dispatchProof !== dispatchProof
    || pinned.dispatchTraceEvidence !== dispatchTraceEvidence
    || pinned.supportValidated !== true
    || captureProvenance.accepted !== false
    || captureProvenance.supportValidated !== true
    || captureProvenance.authorityGap !== VISUAL_RUNNER_PROVENANCE_GAP
    || !isDeepStrictEqual(captureProvenance.failedGates, [VISUAL_RUNNER_PROVENANCE_GAP])
    || !isDeepStrictEqual(captureProvenance, pinned.publicIdentity)
  ) return null;
  const dispatchAnchor = dispatchTraceAnchor(dispatchProof, dispatchTraceEvidence);
  return dispatchAnchor && isDeepStrictEqual(dispatchAnchor, pinned.dispatchAnchor)
    ? Object.freeze({ ...pinned, captureProvenance })
    : null;
}

function frozenVisualFailure(failures, supportDetails = {}) {
  return deepFreezeData({
    schemaVersion: GPU_HMR_VERIFIED_VISUAL_EVIDENCE_SCHEMA_VERSION,
    ...supportDetails,
    accepted: false,
    failedGates: [...new Set(failures)],
  });
}

export async function verifyGpuHmrVisualProofBundle(input, options = {}) {
  const failures = [];
  let pinnedAllowedRoots = [];
  try {
    if (!exactOwnKeys(input, [
      'roles',
      'dispatchProof',
      'dispatchTraceEvidence',
      'captureProvenance',
      'outputModalityEvidence',
      'outputOracle',
    ])) {
      return frozenVisualFailure(['visual_evidence_bundle_field_set_invalid']);
    }
    const modality = PINNED_OUTPUT_MODALITY_EVIDENCE.get(input.outputModalityEvidence);
    if (!modality || modality.modality !== 'visual') {
      return frozenVisualFailure(['visual_evidence_visual_modality_unverified']);
    }
    const dispatchAnchor = dispatchTraceAnchor(
      input.dispatchProof,
      input.dispatchTraceEvidence,
    );
    if (!dispatchAnchor) {
      return frozenVisualFailure(['visual_evidence_dispatch_receipt_unverified']);
    }
    const capturePin = visualCaptureSupportAnchor(
      input.dispatchProof,
      input.dispatchTraceEvidence,
      input.captureProvenance,
    );
    if (!capturePin) {
      return frozenVisualFailure(['visual_evidence_capture_provenance_unverified']);
    }
    const rawOracle = visualOracleProjectionFromRaw(input.outputOracle);
    if (!rawOracle.projection) return frozenVisualFailure(rawOracle.failures);
    if (!isDeepStrictEqual(
      rawOracle.projection,
      input.captureProvenance.outputOracleProjection,
    )) {
      return frozenVisualFailure(['visual_evidence_output_oracle_source_projection_mismatch']);
    }
    if (rawOracle.projection.kind !== modality.oracleKind) {
      return frozenVisualFailure(['visual_evidence_output_oracle_kind_mismatch']);
    }
    const allowedRoots = Array.isArray(options.allowedRoots)
      && !utilTypes.isProxy(options.allowedRoots)
      && options.allowedRoots.length > 0
      && options.allowedRoots.every((root) => typeof root === 'string' && root.trim())
      ? Object.freeze([...options.allowedRoots])
      : null;
    if (!allowedRoots) {
      return frozenVisualFailure(['visual_evidence_allowed_root_missing']);
    }
    pinnedAllowedRoots = await pinAllowedRoots(allowedRoots, 'visual_evidence');
    if (typeof options.afterAllowedRootsPinned === 'function') {
      await options.afterAllowedRootsPinned(Object.freeze(
        pinnedAllowedRoots.map(publicAllowedRootBinding),
      ));
    }
    const sourceAllowedRoot = input.captureProvenance.sourceStreamAllowedRoot;
    const pinnedSourceAllowedRoot = pinnedAllowedRoots.find(
      (binding) => binding.path === sourceAllowedRoot?.path,
    );
    if (
      !pinnedSourceAllowedRoot
      || !isDeepStrictEqual(
        publicAllowedRootBinding(pinnedSourceAllowedRoot),
        sourceAllowedRoot,
      )
      || !isDeepStrictEqual(sourceAllowedRoot, capturePin.sourceStreamAllowedRoot)
    ) {
      return frozenVisualFailure(['visual_evidence_source_stream_allowed_root_changed']);
    }
    if (
      !Array.isArray(input.roles)
      || utilTypes.isProxy(input.roles)
      || input.roles.length !== 3
    ) {
      return frozenVisualFailure(['visual_evidence_role_count_invalid']);
    }
    const roles = new Map();
    for (const entry of input.roles) {
      if (!ownDataRecord(entry)) {
        failures.push('visual_evidence_role_invalid');
        continue;
      }
      const role = entry?.role;
      if (!['before', 'after', 'diff'].includes(role)) {
        failures.push('visual_evidence_role_invalid');
        continue;
      }
      if (roles.has(role)) failures.push(`visual_evidence_${role}_role_duplicate`);
      roles.set(role, snapshotVisualRoleEntry(entry, role));
    }
    for (const role of ['before', 'after', 'diff']) {
      if (!roles.has(role)) failures.push(`visual_evidence_${role}_role_missing`);
    }
    if (failures.length > 0) return frozenVisualFailure(failures);

    const roleBytes = {};
    for (const role of ['before', 'after', 'diff']) {
      roleBytes[role] = await verifiedVisualRoleBytes(
        roles.get(role),
        role,
        allowedRoots,
        pinnedAllowedRoots,
        options,
      );
    }
    if (new Set(Object.values(roleBytes).map((entry) => entry.path)).size !== 3) {
      failures.push('visual_evidence_role_path_reused');
    }
    if (Object.values(roleBytes).some(
      (entry) => entry.path === input.captureProvenance.sourceStreamPath,
    )) failures.push('visual_evidence_source_stream_role_path_reused');
    const identityBindings = [
      {
        role: 'source_stream',
        identity: input.captureProvenance.sourceStreamStableFileIdentity,
      },
      ...['before', 'after', 'diff'].map((role) => ({
        role,
        identity: roleBytes[role].fileIdentity?.stable,
      })),
    ];
    const identityKeys = new Map();
    for (const binding of identityBindings) {
      const key = stableFileIdentityKey(binding.identity);
      if (!key) {
        failures.push(`visual_evidence_${binding.role}_stable_file_identity_unavailable`);
        continue;
      }
      if (identityKeys.has(key)) {
        failures.push('visual_evidence_cross_role_file_identity_reused');
      } else {
        identityKeys.set(key, binding.role);
      }
    }
    if (failures.length > 0) return frozenVisualFailure(failures);

    const decoded = {};
    for (const role of ['before', 'after', 'diff']) {
      decoded[role] = await verifiedDecodedVisualRoleBytes(
        roleBytes[role],
        role,
        options,
      );
    }
    if (
      decoded.before.width !== decoded.after.width
      || decoded.before.height !== decoded.after.height
      || decoded.before.width !== decoded.diff.width
      || decoded.before.height !== decoded.diff.height
    ) failures.push('visual_evidence_decoded_dimensions_mismatch');
    for (const role of ['before', 'after']) {
      if (!screenshotQualifiesAsVisualEvidence({
        ...decoded[role].quality,
        path: decoded[role].path,
      })) failures.push(`visual_evidence_${role}_blank_or_low_quality`);
    }
    const dimensionsMatch =
      decoded.before.width === decoded.after.width
      && decoded.before.height === decoded.after.height
      && decoded.before.width === decoded.diff.width
      && decoded.before.height === decoded.diff.height;
    const metrics = dimensionsMatch
      ? visualDiffMetrics(decoded.before, decoded.after, decoded.diff)
      : {
          pixelCount: 0,
          changedPixels: 0,
          changedPixelRatio: 0,
          perceptualDiff: 0,
          diffMismatchPixels: 0,
        };
    if (decoded.before.contentHash === decoded.after.contentHash || metrics.changedPixels === 0) {
      failures.push('visual_evidence_before_after_same');
    }
    if (metrics.diffMismatchPixels > 0) failures.push('visual_evidence_diff_bytes_mismatch');
    if (
      Number(decoded.diff.quality.visible_pixels) <= 0
      || metrics.changedPixelRatio <= 0
      || metrics.perceptualDiff <= 0
    ) failures.push('visual_evidence_diff_blank');

    const receipts = input.captureProvenance.receipts;
    const oracleProjection = rawOracle.projection;
    const oracleRoleBindings = {
      before: [oracleProjection.beforeEncodedHash, oracleProjection.beforeDecodedHash],
      after: [oracleProjection.afterEncodedHash, oracleProjection.afterDecodedHash],
      diff: [oracleProjection.diffEncodedHash, oracleProjection.diffDecodedHash],
    };
    for (const role of ['before', 'after', 'diff']) {
      const receipt = receipts[role];
      if (
        decoded[role].contentHash !== receipt.encodedHash
        || decoded[role].decodedContentHash !== receipt.decodedHash
      ) failures.push(`visual_evidence_${role}_capture_receipt_hash_mismatch`);
      if (
        decoded[role].contentHash !== oracleRoleBindings[role][0]
        || decoded[role].decodedContentHash !== oracleRoleBindings[role][1]
      ) failures.push(`visual_evidence_${role}_output_oracle_hash_mismatch`);
      if (decoded[role].width !== receipt.width || decoded[role].height !== receipt.height) {
        failures.push(`visual_evidence_${role}_capture_receipt_dimensions_mismatch`);
      }
    }
    if (
      decoded.before.width !== oracleProjection.width
      || decoded.before.height !== oracleProjection.height
    ) failures.push('visual_evidence_output_oracle_dimensions_mismatch');
    if (failures.length > 0) return frozenVisualFailure(failures);

    const artifacts = Object.freeze(['before', 'after', 'diff'].map((role) => Object.freeze({
      role,
      path: decoded[role].path,
      contentHash: decoded[role].contentHash,
      decodedContentHash: decoded[role].decodedContentHash,
      byteLength: decoded[role].bytes.byteLength,
      decodedByteLength: decoded[role].data.byteLength,
      stableFileIdentity: decoded[role].fileIdentity.stable,
      allowedRoot: decoded[role].allowedRoot,
      width: decoded[role].width,
      height: decoded[role].height,
      visualQuality: decoded[role].quality.visual_quality,
      visiblePixels: decoded[role].quality.visible_pixels,
    })));
    // No producer-authenticated runner observation issuer exists in this module's
    // import boundary, so verified caller artifacts remain support-only.
    const result = frozenVisualFailure([VISUAL_RUNNER_PROVENANCE_GAP], {
      supportValidated: true,
      proofAuthority: 'live_allowed_root_image_bytes_support_only',
      authorityGap: VISUAL_RUNNER_PROVENANCE_GAP,
      modality: 'visual',
      oracleKind: modality.oracleKind,
      dispatchId: dispatchAnchor.dispatchId,
      dispatchTimestamp: dispatchAnchor.dispatchTimestamp,
      runtimeSessionId: dispatchAnchor.runtimeSessionId,
      processId: dispatchAnchor.processId,
      deviceIdentity: dispatchAnchor.deviceIdentity,
      outputTargetId: dispatchAnchor.outputTargetId,
      epoch: dispatchAnchor.epoch,
      runtimeArtifactId: dispatchAnchor.runtimeArtifactId,
      postDispatchTimestamp: oracleProjection.readbackTimestampMonotonicNs,
      previousDispatch: input.captureProvenance.previousDispatch,
      previousOutput: input.captureProvenance.previousOutput,
      sourceStreamStableFileIdentity:
        input.captureProvenance.sourceStreamStableFileIdentity,
      sourceStreamAllowedRoot: input.captureProvenance.sourceStreamAllowedRoot,
      allowedRoots: Object.freeze(pinnedAllowedRoots.map(publicAllowedRootBinding)),
      width: decoded.before.width,
      height: decoded.before.height,
      artifacts,
      metrics: Object.freeze(metrics),
      controlPair: input.captureProvenance.controlPair,
      captureProvenance: input.captureProvenance,
      outputOracleProjection: oracleProjection,
      outputOracleFieldBinding: rawOracle.fieldBinding,
    });
    PINNED_VISUAL_SUPPORT_EVIDENCE.set(result, Object.freeze({
      dispatchProof: input.dispatchProof,
      dispatchTraceEvidence: input.dispatchTraceEvidence,
      captureProvenance: input.captureProvenance,
      outputModalityEvidence: input.outputModalityEvidence,
      rawOutputOracle: input.outputOracle,
      outputOracleProjection: oracleProjection,
      outputOracleFieldBinding: rawOracle.fieldBinding,
      dispatchAnchor,
      allowedRoots: Object.freeze(pinnedAllowedRoots.map(publicAllowedRootBinding)),
      publicIdentity: clonePlainData(result),
    }));
    return result;
  } catch (error) {
    const code = typeof error?.message === 'string' && /^visual_evidence_[a-z0-9_]+$/.test(error.message)
      ? error.message
      : 'visual_evidence_byte_verification_failed';
    return frozenVisualFailure([code]);
  } finally {
    await closePinnedAllowedRoots(pinnedAllowedRoots);
  }
}

function verifiedVisualEvidenceFromObservation(observation, rawOracle, dispatchProof, modalityEvidence) {
  const declaration = aliasedEvidenceValue(
    [observation, rawOracle],
    ['verifiedVisualEvidence', 'verified_visual_evidence'],
  );
  const support = declaration.value && typeof declaration.value === 'object'
    ? PINNED_VISUAL_SUPPORT_EVIDENCE.get(declaration.value)
    : null;
  const failedGates = [];
  if (declaration.conflict) failedGates.push('visual_evidence_alias_conflict');
  if (declaration.duplicate) failedGates.push('visual_evidence_duplicate_alias');
  if (
    !support
    || declaration.value?.accepted !== false
    || declaration.value?.supportValidated !== true
    || !isDeepStrictEqual(declaration.value, support.publicIdentity)
  ) failedGates.push('visual_evidence_live_verification_missing');
  if (support && support.dispatchProof !== dispatchProof) failedGates.push('visual_evidence_dispatch_receipt_identity_mismatch');
  if (support && support.outputModalityEvidence !== modalityEvidence) {
    failedGates.push('visual_evidence_modality_identity_mismatch');
  }
  if (support && support.rawOutputOracle !== rawOracle) {
    failedGates.push('visual_evidence_output_oracle_identity_mismatch');
  }
  if (support) {
    const currentOracle = visualOracleProjectionFromRaw(rawOracle);
    if (
      !currentOracle.projection
      || !isDeepStrictEqual(currentOracle.projection, support.outputOracleProjection)
      || !isDeepStrictEqual(currentOracle.fieldBinding, support.outputOracleFieldBinding)
    ) failedGates.push('visual_evidence_output_oracle_changed');
  }
  const anchor = support
    ? dispatchTraceAnchor(dispatchProof, support.dispatchTraceEvidence)
    : null;
  if (support && (!anchor || !isDeepStrictEqual(anchor, support.dispatchAnchor))) {
    failedGates.push('visual_evidence_dispatch_receipt_changed');
  }
  if (
    support
    && !visualCaptureSupportAnchor(
      dispatchProof,
      support.dispatchTraceEvidence,
      support.captureProvenance,
    )
  ) failedGates.push('visual_evidence_capture_provenance_changed');
  if (support) failedGates.push(VISUAL_RUNNER_PROVENANCE_GAP);
  return {
    accepted: false,
    reason: failedGates[0] ?? null,
    failedGates,
    evidence: declaration.value,
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
  const oracleArtifacts = objectField(
    observation.oracleArtifacts,
    observation.oracle_artifacts,
    rawOracle.oracleArtifacts,
    rawOracle.oracle_artifacts,
  );
  const deterministicVisualMode = objectField(
    observation.deterministicVisualMode,
    observation.deterministic_visual_mode,
    rawOracle.deterministicVisualMode,
    rawOracle.deterministic_visual_mode,
  );
  const outputOracleTarget = objectField(
    observation.outputOracleTarget,
    observation.output_oracle_target,
    rawOracle.outputOracleTarget,
    rawOracle.output_oracle_target,
  );
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
  const outputModality = outputModalityEvidenceFromObservation(observation, rawOracle);
  const outputModalityEvidenceRequired = outputModality.registryModality === 'visual';
  const outputModalityRequirementSatisfied =
    outputModalityEvidenceRequired
      ? outputModality.accepted
      : !outputModality.declared || outputModality.accepted;
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
  const oracleProcessId = stringField(
    rawOracle.processId,
    rawOracle.process_id,
    observation.processId,
    observation.process_id,
  );
  const oracleArtifactId = typeof rawOracle.artifactId === 'string' && rawOracle.artifactId.trim()
    ? rawOracle.artifactId.trim()
    : typeof rawOracle.artifact_id === 'string' && rawOracle.artifact_id.trim()
      ? rawOracle.artifact_id.trim()
      : null;
  const oracleDispatchId = stringField(
    rawOracle.afterDispatchId,
    rawOracle.after_dispatch_id,
    rawOracle.dispatchId,
    rawOracle.dispatch_id,
    observation.afterDispatchId,
    observation.after_dispatch_id,
    observation.dispatchId,
    observation.dispatch_id,
    dispatchProof?.dispatchId,
    dispatchProof?.dispatch_id,
  );
  const oracleEpoch = stringField(
    rawOracle.epoch,
    rawOracle.epoch_id,
    rawOracle.outputEpoch,
    rawOracle.output_epoch,
    rawOracle.outputGeneration,
    rawOracle.output_generation,
    rawOracle.generation,
    Number.isFinite(rawOracle.epoch) ? String(rawOracle.epoch) : null,
    Number.isFinite(rawOracle.outputEpoch) ? String(rawOracle.outputEpoch) : null,
    Number.isFinite(rawOracle.output_epoch) ? String(rawOracle.output_epoch) : null,
    Number.isFinite(rawOracle.outputGeneration) ? String(rawOracle.outputGeneration) : null,
    Number.isFinite(rawOracle.output_generation) ? String(rawOracle.output_generation) : null,
    Number.isFinite(rawOracle.generation) ? String(rawOracle.generation) : null,
  );
  const dispatchArtifactIds = dispatchRuntimeArtifactIdsFromProof(dispatchProof);
  const epochProof = observation.epochProof && typeof observation.epochProof === 'object'
    ? observation.epochProof
    : observation.epoch_proof && typeof observation.epoch_proof === 'object'
      ? observation.epoch_proof
      : dispatchProof?.epochProof && typeof dispatchProof.epochProof === 'object'
        ? dispatchProof.epochProof
        : dispatchProof?.epoch_proof && typeof dispatchProof.epoch_proof === 'object'
          ? dispatchProof.epoch_proof
          : null;
  const activeEpochArtifactIds = activeEpochArtifactIdsFromProof(epochProof);
  const selectedArtifactIds = contentAddressedArtifactIds([
    ...(Array.isArray(observation.selectedArtifactIds) ? observation.selectedArtifactIds : []),
    ...(Array.isArray(observation.selected_artifact_ids) ? observation.selected_artifact_ids : []),
    ...(Array.isArray(dispatchProof?.selectedArtifactIds) ? dispatchProof.selectedArtifactIds : []),
    ...(Array.isArray(dispatchProof?.selected_artifact_ids) ? dispatchProof.selected_artifact_ids : []),
  ]);
  const oracleArtifactMatchesDispatch =
    oracleArtifactId !== null
    && dispatchArtifactIds.length > 0
    && dispatchArtifactIds.includes(oracleArtifactId);
  const oracleArtifactMatchesActiveEpoch =
    oracleArtifactId !== null
    && activeEpochArtifactIds.length > 0
    && activeEpochArtifactIds.includes(oracleArtifactId);
  const oracleArtifactMatchesSelected =
    oracleArtifactId !== null
    && selectedArtifactIds.length > 0
    && selectedArtifactIds.includes(oracleArtifactId);
  const oracleArtifactMatchesRuntime =
    oracleArtifactMatchesDispatch || oracleArtifactMatchesActiveEpoch;
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
  const latestEpochPublishTimestamp = latestEpochPublicationTimestampFromProof(epochProof);
  const epochPublishTimestampObserved = latestEpochPublishTimestamp !== null;
  const oracleReadbackAfterEpochPublication =
    !oracleArtifactMatchesActiveEpoch
    || (
      epochPublishTimestampObserved
      && oracleReadbackTimestampObserved
      && oracleReadbackTimestamp >= latestEpochPublishTimestamp
    );
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
    && outputModalityRequirementSatisfied
    && oracleEvidenceObserved
    && oracleProvenanceComplete
    && oracleRuntimeSessionMatchesDispatch
    && oracleArtifactMatchesRuntime
    && oracleReadbackAfterDispatch
    && oracleReadbackAfterEpochPublication
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
    processId: oracleProcessId,
    artifactId: oracleArtifactId,
    epoch: oracleEpoch,
    generation: oracleEpoch,
    dispatchId: oracleDispatchId,
    afterDispatchId: oracleDispatchId,
    artifactMatchesDispatch: oracleArtifactMatchesDispatch,
    artifactMatchesActiveEpoch: oracleArtifactMatchesActiveEpoch,
    artifactMatchesSelected: oracleArtifactMatchesSelected,
    artifactMatchesRuntime: oracleArtifactMatchesRuntime,
    dispatchArtifactIds,
    activeEpochArtifactIds,
    selectedArtifactIds,
    valuesCompatible: oracleValuesCompatible,
    epochPublishTimestampObserved,
    latestEpochPublishTimestamp,
    readbackAfterEpochPublication: oracleReadbackAfterEpochPublication,
    oracleId,
    requiredOracleId,
    contractIdObserved: oracleContractIdObserved,
    requiredContractObserved: oracleRequiredContractObserved,
    requiredContractMatched: oracleRequiredContractMatched,
    passStatusObserved: oraclePassStatusObserved,
    reportedPassed: oracleReportedPassed,
    kind: oracleKind,
    kindAccepted: oracleKindAccepted,
    modalityEvidenceAccepted: outputModality.accepted,
    modalityEvidenceDeclared: outputModality.declared,
    modalityEvidenceRequired: outputModalityEvidenceRequired,
    modality: outputModality.registryModality,
    modalityEvidence: outputModality.evidence,
    modalityFailedGates: outputModality.failedGates,
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
  const visualEvidenceRequired =
    outputModality.registryModality === 'visual';
  const renderVisualEvidenceRequired = visualEvidenceRequired;
  const verifiedVisualEvidence = visualEvidenceRequired
    ? verifiedVisualEvidenceFromObservation(
      observation,
      rawOracle,
      dispatchProof,
      outputModality.evidence,
    )
    : null;
  const visualEvidenceComplete =
    !visualEvidenceRequired || verifiedVisualEvidence?.accepted === true;

  if (!dispatchUsable) {
    return {
      schemaVersion: GPU_HMR_PROOF_SCHEMA_VERSION,
      resultState: dispatchProof?.resultState ?? null,
      degradedState: dispatchProof?.degradedState ?? 'gpu-hmr-dispatch-unobserved',
      degradedReason: dispatchProof?.degradedReason ?? 'runtime_dispatch_not_observed',
      outputOracle: { ...outputOracle, passed: false },
      oracleArtifacts,
      oracle_artifacts: oracleArtifacts,
      deterministicVisualMode,
      deterministic_visual_mode: deterministicVisualMode,
      outputOracleTarget,
      output_oracle_target: outputOracleTarget,
      processId: oracleProcessId,
      visualFrameObserved,
      visualEvidenceRequired,
      renderVisualEvidenceRequired,
      visualEvidenceComplete,
      verifiedVisualEvidence,
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
        degradedReason: verifiedVisualEvidence?.reason
          ?? 'visual_evidence_live_verification_missing',
        outputOracle: { ...outputOracle, passed: false },
        oracleArtifacts,
        oracle_artifacts: oracleArtifacts,
        deterministicVisualMode,
        deterministic_visual_mode: deterministicVisualMode,
        outputOracleTarget,
        output_oracle_target: outputOracleTarget,
        processId: oracleProcessId,
        visualFrameObserved,
        visualEvidenceRequired,
        renderVisualEvidenceRequired,
        visualEvidenceComplete,
        verifiedVisualEvidence,
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
      oracleArtifacts,
      oracle_artifacts: oracleArtifacts,
      deterministicVisualMode,
      deterministic_visual_mode: deterministicVisualMode,
      outputOracleTarget,
      output_oracle_target: outputOracleTarget,
      processId: oracleProcessId,
      visualFrameObserved,
      visualEvidenceRequired,
      renderVisualEvidenceRequired,
      visualEvidenceComplete,
      verifiedVisualEvidence,
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
    : (visualEvidenceRequired || outputModality.declared) && !outputModality.accepted
      ? outputModality.failedGates[0] ?? 'output_modality_evidence_missing_or_unverified'
    : oraclePayloadOtherwisePassed && rawOracleEvidenceRefs.length > 0 && !oracleEvidenceObserved
      ? 'output_oracle_evidence_unaccepted'
      : oraclePayloadOtherwisePassed && !oracleEvidenceObserved
        ? 'output_oracle_evidence_missing'
          : oraclePayloadOtherwisePassed && !oracleProvenanceComplete
            ? 'output_oracle_provenance_incomplete'
            : oraclePayloadOtherwisePassed && !oracleRuntimeSessionMatchesDispatch
              ? 'output_oracle_session_mismatch'
              : oraclePayloadOtherwisePassed && !oracleArtifactMatchesRuntime
                ? 'output_oracle_artifact_mismatch'
                : oraclePayloadOtherwisePassed && !dispatchTimestampObserved
                  ? 'output_oracle_dispatch_timestamp_missing'
                  : oraclePayloadOtherwisePassed && !oracleReadbackAfterDispatch
                    ? 'output_oracle_precedes_dispatch'
                    : oraclePayloadOtherwisePassed && oracleArtifactMatchesActiveEpoch && !epochPublishTimestampObserved
                      ? 'output_oracle_epoch_publish_timestamp_missing'
                      : oraclePayloadOtherwisePassed && !oracleReadbackAfterEpochPublication
                        ? 'output_oracle_precedes_epoch_publication'
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
    oracleArtifacts,
    oracle_artifacts: oracleArtifacts,
    deterministicVisualMode,
    deterministic_visual_mode: deterministicVisualMode,
    outputOracleTarget,
    output_oracle_target: outputOracleTarget,
    processId: oracleProcessId,
    visualFrameObserved,
    visualEvidenceRequired,
    renderVisualEvidenceRequired,
    visualEvidenceComplete,
    verifiedVisualEvidence,
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

function jsonSafeObject(value) {
  const record = objectField(value);
  if (!record) return null;
  try {
    return JSON.parse(JSON.stringify(record));
  } catch {
    return null;
  }
}

function objectMatrixField(value, limit = 32) {
  if (!Array.isArray(value)) return [];
  return value
    .map((record) => jsonSafeObject(record))
    .filter(Boolean)
    .slice(-limit);
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
  const runtimeArtifactIds = contentAddressedArtifactIds([
    observation.runtimeArtifactId,
    observation.runtime_artifact_id,
    ...(Array.isArray(observation.runtimeArtifactIds) ? observation.runtimeArtifactIds : []),
    ...(Array.isArray(observation.runtime_artifact_ids) ? observation.runtime_artifact_ids : []),
  ]);
  const runtimeArtifactId = contentAddressedArtifactIds([
    observation.runtimeArtifactId,
    observation.runtime_artifact_id,
    runtimeArtifactIds.at(-1),
  ])[0] ?? null;
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
  const dispatchId = stringField(
    observation.dispatchId,
    observation.dispatch_id,
    observation.kernelDispatchId,
    observation.kernel_dispatch_id,
    observation.launchId,
    observation.launch_id,
  );
  const dispatchEpoch = stringField(
    observation.epoch,
    observation.epoch_id,
    observation.dispatchEpoch,
    observation.dispatch_epoch,
    observation.dispatchGeneration,
    observation.dispatch_generation,
    observation.generation,
    observation.activeEpoch,
    observation.active_epoch,
    observation.activeGeneration,
    observation.active_generation,
    Number.isFinite(observation.generation) ? String(observation.generation) : null,
    Number.isFinite(observation.dispatchGeneration) ? String(observation.dispatchGeneration) : null,
    Number.isFinite(observation.dispatch_generation) ? String(observation.dispatch_generation) : null,
    Number.isFinite(observation.activeGeneration) ? String(observation.activeGeneration) : null,
    Number.isFinite(observation.active_generation) ? String(observation.active_generation) : null,
  );
  const processId = stringField(
    observation.processId,
    observation.process_id,
    observation.pid,
    Number.isFinite(observation.pid) ? String(observation.pid) : null,
  );
  const dispatchIdentityFields = {
    selectedArtifactIds,
    runtimeArtifactId,
    runtimeArtifactIds,
    dispatcherRegistrationIds,
    dispatchTableEntryIds,
    dispatchTableHashes,
    dispatchStreamIds,
    gridDimensions,
    blockDimensions,
    sharedMemoryBytes,
    dispatchTimestamps,
    dispatchId,
    epoch: dispatchEpoch,
    processId,
  };

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
      ...dispatchIdentityFields,
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
      ...dispatchIdentityFields,
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
      ...dispatchIdentityFields,
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
      ...dispatchIdentityFields,
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
      ...dispatchIdentityFields,
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
      ...dispatchIdentityFields,
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
      ...dispatchIdentityFields,
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
      ...dispatchIdentityFields,
    };
  }

  const dispatchIdentityDegradedReason = (() => {
    if (!selectedArtifactIds.length) return 'selected_artifact_identity_not_observed';
    if (!runtimeArtifactIds.length) return 'runtime_artifact_identity_not_observed';
    if (!dispatcherRegistrationIds.length) return 'dispatcher_registration_identity_not_observed';
    if (!dispatchTableEntryIds.length) return 'dispatch_table_entry_identity_not_observed';
    if (!dispatchTableHashes.length) return 'dispatch_table_hash_not_observed';
    if (!dispatchTimestamps.length) return 'dispatch_timestamp_not_observed';
    if (!dispatchEpoch) return 'dispatch_epoch_identity_not_observed';
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
      dispatchId,
      epoch: dispatchEpoch,
      processId,
    };
  }

  const proof = {
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
    runtimeArtifactId,
    runtimeArtifactIds,
    dispatcherRegistrationIds,
    dispatchTableEntryIds,
    dispatchTableHashes,
    dispatchStreamIds,
    gridDimensions,
    blockDimensions,
    sharedMemoryBytes,
    dispatchTimestamps,
    dispatchId,
    epoch: dispatchEpoch,
    processId,
  };
  const epochPublicationTimestamp = latestEpochPublicationMonotonicTimestampFromProof(epochProof);
  const dispatchTrace = dispatchTraceAnchorFromObservation(observation, {
    dispatchId,
    processId,
    runtimeSessionId: runtimeSessionIds[0] ?? null,
    runtimeArtifactId,
    epoch: dispatchEpoch,
    epochPublicationTimestamp,
    dispatchEvidenceRefs,
  });
  PINNED_DISPATCH_PROOFS.set(proof, Object.freeze({
    publicIdentity: dispatchProofPublicIdentity(proof),
    epochPublicationTimestamp,
    dispatchTraceAnchor: dispatchTrace.anchor,
    dispatchTraceFailures: Object.freeze([...new Set(dispatchTrace.failures)]),
  }));
  return proof;
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
  const parsedCompatibilityClass = abiCompatibilityClass(observation);
  const compatibilityClass = parsedCompatibilityClass ?? 'unknown';
  const backendSpecificAdapterSafetyEvidenceRefs = backendSpecificAdapterSafetyEvidence(observation);
  const adapterSafetyDeclared = backendSpecificAdapterSafetyDeclared(observation);
  const adapterSafetyDeclaredWithoutEvidence =
    adapterSafetyDeclared && backendSpecificAdapterSafetyEvidenceRefs.length === 0;
  const backendSpecificAdapterSafetyProven = backendSpecificAdapterSafetyEvidenceRefs.length > 0;
  const compatibilityClassAccepted =
    ['compatible', 'additive'].includes(compatibilityClass)
    || backendSpecificAdapterSafetyProven;
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
    && compatibilityClassAccepted
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
      abiCompatibilityClass: compatibilityClass,
      backendSpecificAdapterSafetyProven,
      backendSpecificAdapterSafetyEvidenceRefs,
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
        : adapterSafetyDeclaredWithoutEvidence
          ? 'backend_specific_adapter_safety_evidence_missing'
          : parsedCompatibilityClass === null
          ? 'abi_compatibility_class_missing'
          : !compatibilityClassAccepted
          ? 'abi_compatibility_class_unaccepted'
          : !layoutSizeAlignmentVerified
          ? 'abi_layout_size_alignment_unverified'
          : !acceptedExtractorProvenanceObserved
            ? 'abi_extractor_provenance_unverified'
            : !extractorProvenanceComplete
              ? 'abi_extractor_provenance_incomplete'
              : 'abi_fingerprint_hashes_unverified')
      : 'abi_evidence_not_collected',
    layoutSizeAlignmentVerified,
    abiCompatibilityClass: compatibilityClass,
    backendSpecificAdapterSafetyProven,
    backendSpecificAdapterSafetyEvidenceRefs,
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
  const processId = stringField(observation.processId, observation.process_id);
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
      processId,
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
      processId,
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
    processId,
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
  const processId = stringField(observation.processId, observation.process_id);
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
      processId,
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
      processId,
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
    processId,
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
  const anyAllocationAvailable =
    raw.anyAllocationAvailable === true || raw.any_allocation_available === true
      ? true
      : raw.anyAllocationAvailable === false || raw.any_allocation_available === false
        ? false
        : null;
  const textureResourceFallbackAvailable =
    raw.textureResourceFallbackAvailable === true || raw.texture_resource_fallback_available === true
      ? true
      : raw.textureResourceFallbackAvailable === false || raw.texture_resource_fallback_available === false
        ? false
        : null;
  const allocationMatrix = objectMatrixField(raw.allocationMatrix ?? raw.allocation_matrix);
  const textureResourceMatrix = objectMatrixField(
    raw.textureResourceMatrix ?? raw.texture_resource_matrix,
  );
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
    anyAllocationAvailable,
    allocationMatrix,
    allocationMatrixTotal:
      integerValue(raw.allocationMatrixTotal ?? raw.allocation_matrix_total)
      ?? (allocationMatrix.length > 0 ? allocationMatrix.length : null),
    allocationMatrixAvailableCount:
      integerValue(raw.allocationMatrixAvailableCount ?? raw.allocation_matrix_available_count),
    allocationMatrixFailureCount:
      integerValue(raw.allocationMatrixFailureCount ?? raw.allocation_matrix_failure_count),
    textureResourceFallbackAvailable,
    textureResourceMatrix,
    textureResourceMatrixTotal:
      integerValue(raw.textureResourceMatrixTotal ?? raw.texture_resource_matrix_total)
      ?? (textureResourceMatrix.length > 0 ? textureResourceMatrix.length : null),
    textureResourceMatrixAvailableCount:
      integerValue(
        raw.textureResourceMatrixAvailableCount ?? raw.texture_resource_matrix_available_count,
      ),
    textureResourceMatrixFailureCount:
      integerValue(raw.textureResourceMatrixFailureCount ?? raw.texture_resource_matrix_failure_count),
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
  const nativeLaunchObserverReadyEvidenceRefs = compactStringList(
    observation.nativeLaunchObserverReadyEvidenceRefs
    ?? observation.native_launch_observer_ready_evidence_refs,
  );
  const nativeFunctionResolutionEvidenceRefs = compactStringList(
    observation.nativeFunctionResolutionEvidenceRefs
    ?? observation.native_function_resolution_evidence_refs,
  );
  const nativeLaunchAttemptEvidenceRefs = compactStringList(
    observation.nativeLaunchAttemptEvidenceRefs
    ?? observation.native_launch_attempt_evidence_refs,
  );
  const nativeLaunchEvidenceRefs = compactStringList(
    observation.nativeLaunchEvidenceRefs
    ?? observation.native_launch_evidence_refs,
  );
  const nativeLaunchAttemptRecords = Array.isArray(
    observation.nativeLaunchAttemptRecords ?? observation.native_launch_attempt_records,
  )
    ? (observation.nativeLaunchAttemptRecords ?? observation.native_launch_attempt_records)
      .filter((record) => record && typeof record === 'object')
      .slice(-20)
    : [];
  const nativeLaunchRecords = Array.isArray(
    observation.nativeLaunchRecords ?? observation.native_launch_records,
  )
    ? (observation.nativeLaunchRecords ?? observation.native_launch_records)
      .filter((record) => record && typeof record === 'object')
      .slice(-20)
    : [];
  const nativeTextureObjectEvidenceRefs = compactStringList(
    observation.nativeTextureObjectEvidenceRefs
    ?? observation.native_texture_object_evidence_refs,
  );
  const nativeArrayAllocationEvidenceRefs = compactStringList(
    observation.nativeArrayAllocationEvidenceRefs
    ?? observation.native_array_allocation_evidence_refs,
  );
  const nativeArrayAllocationRecords = Array.isArray(
    observation.nativeArrayAllocationRecords ?? observation.native_array_allocation_records,
  )
    ? (observation.nativeArrayAllocationRecords ?? observation.native_array_allocation_records)
      .filter((record) => record && typeof record === 'object')
      .slice(-20)
    : [];
  const runtimeErrorEvidenceRefs = compactStringList(
    observation.runtimeErrorEvidenceRefs
    ?? observation.runtime_error_evidence_refs,
  );
  const runtimeErrorRecords = Array.isArray(
    observation.runtimeErrorRecords ?? observation.runtime_error_records,
  )
    ? (observation.runtimeErrorRecords ?? observation.runtime_error_records)
      .filter((record) => record && typeof record === 'object')
      .slice(-20)
    : [];
  const runtimeErrorSourceLocations = Array.isArray(
    observation.runtimeErrorSourceLocations ?? observation.runtime_error_source_locations,
  )
    ? (observation.runtimeErrorSourceLocations ?? observation.runtime_error_source_locations)
      .filter((record) => record && typeof record === 'object')
      .slice(-20)
    : [];
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
  const diagnosticEvidenceRefs = compactStringList([
    ...runtimeCapabilityEvidenceRefs,
    ...nativeLaunchObserverReadyEvidenceRefs,
    ...nativeFunctionResolutionEvidenceRefs,
    ...nativeLaunchAttemptEvidenceRefs,
    ...nativeLaunchEvidenceRefs,
    ...nativeTextureObjectEvidenceRefs,
    ...nativeArrayAllocationEvidenceRefs,
    ...runtimeErrorEvidenceRefs,
  ]);
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
    nativeLaunchObserverReadyEvidenceRefs,
    nativeFunctionResolutionEvidenceRefs,
    nativeLaunchAttemptEvidenceRefs,
    nativeLaunchEvidenceRefs,
    nativeLaunchAttemptRecords,
    nativeLaunchRecords,
    nativeTextureObjectEvidenceRefs,
    nativeArrayAllocationEvidenceRefs,
    nativeArrayAllocationRecords,
    runtimeErrorEvidenceRefs,
    runtimeErrorRecords,
    runtimeErrorSourceLocations,
    diagnosticEvidenceRefs,
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
  const arrayRecord = Array.isArray(proof.nativeArrayAllocationRecords)
    ? proof.nativeArrayAllocationRecords.at(-1)
    : null;
  const arrayDescriptor =
    arrayRecord && arrayRecord.descriptor_kind === 'channel_format'
      ? ` array_desc=channel_format:${arrayRecord.channel_x},${arrayRecord.channel_y},${arrayRecord.channel_z},${arrayRecord.channel_w}:${arrayRecord.channel_format_kind}`
      : '';
  const arraySize =
    arrayRecord && Number.isFinite(arrayRecord.width) && Number.isFinite(arrayRecord.height)
      ? ` array_size=${arrayRecord.width}x${arrayRecord.height}`
      : '';
  const runtimeErrorLocation = Array.isArray(proof.runtimeErrorSourceLocations)
    ? proof.runtimeErrorSourceLocations.at(-1)
    : null;
  const runtimeError =
    runtimeErrorLocation?.source_file_name && Number.isFinite(runtimeErrorLocation.source_line)
      ? ` runtime_error=${runtimeErrorLocation.source_file_name}:${runtimeErrorLocation.source_line}`
      : '';
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
  return `gpu_original_host_path_proof=${result}${degraded}${reason}${evidence}${session}${entry}${candidate}${observer}${resolver}${texture}${arrayAllocation}${arrayDescriptor}${arraySize}${runtimeError}${runtimeArrayCapability}${nativeAttempt}${upstreamExit}`;
}

function fullRuntimeVisualMechanics(outputProof) {
  if (!outputProof || typeof outputProof !== 'object') return false;
  const rawOracle = outputProof.outputOracle && typeof outputProof.outputOracle === 'object'
    ? outputProof.outputOracle
    : {};
  const kind = classifyGpuHmrOutputOracleKind(rawOracle.kind);
  // Preserve the existing compute/readback composition contract. Visual support
  // attached to a registered compute oracle remains diagnostic-only.
  if (kind.accepted === true && kind.modality === 'compute') return false;
  const visualEvidence = aliasedEvidenceValue(
    [outputProof, rawOracle],
    ['verifiedVisualEvidence', 'verified_visual_evidence'],
  );
  const visualRefs = compactStringList([
    ...(Array.isArray(outputProof.visualEvidenceRefs) ? outputProof.visualEvidenceRefs : []),
    ...(Array.isArray(rawOracle.visualEvidenceRefs) ? rawOracle.visualEvidenceRefs : []),
    ...(Array.isArray(rawOracle.visual_evidence_refs) ? rawOracle.visual_evidence_refs : []),
    rawOracle.visualEvidenceRef,
    rawOracle.visual_evidence_ref,
    rawOracle.visualRef,
    rawOracle.visual_ref,
    rawOracle.screenshotPath,
    rawOracle.screenshot_path,
  ]);
  const oracleArtifacts = objectField(
    outputProof.oracleArtifacts,
    outputProof.oracle_artifacts,
    rawOracle.oracleArtifacts,
    rawOracle.oracle_artifacts,
  );
  const artifactKeys = oracleArtifacts ? Object.keys(oracleArtifacts) : [];
  return kind.modality === 'visual'
    || outputProof.visualEvidenceRequired === true
    || outputProof.renderVisualEvidenceRequired === true
    || outputProof.visualFrameObserved === true
    || visualEvidence.declared
    || visualRefs.length > 0
    || artifactKeys.some((key) => /(?:^|_)(?:before|after|diff|frame|image|visual)(?:_|$)/i.test(key));
}

function fullRuntimeVisualAuthority(outputProof, dispatchProof) {
  if (!fullRuntimeVisualMechanics(outputProof)) {
    return Object.freeze({ required: false, accepted: true, reason: null, failedGates: [] });
  }
  const rawOracle = outputProof?.outputOracle && typeof outputProof.outputOracle === 'object'
    ? outputProof.outputOracle
    : {};
  const failures = [];
  const modalityDeclaration = aliasedEvidenceValue(
    [outputProof, rawOracle],
    ['outputModalityEvidence', 'output_modality_evidence', 'modalityEvidence'],
  );
  const modalityPin = modalityDeclaration.value && typeof modalityDeclaration.value === 'object'
    ? PINNED_OUTPUT_MODALITY_EVIDENCE.get(modalityDeclaration.value)
    : null;
  const oracleKind = classifyGpuHmrOutputOracleKind(rawOracle.kind);
  if (modalityDeclaration.conflict) failures.push('output_modality_evidence_alias_conflict');
  if (modalityDeclaration.duplicate) failures.push('output_modality_evidence_duplicate');
  if (!modalityPin || modalityDeclaration.value?.accepted !== true) {
    failures.push('output_modality_evidence_missing_or_unverified');
  } else if (
    modalityPin.modality !== 'visual'
    || oracleKind.accepted !== true
    || oracleKind.modality !== 'visual'
    || modalityPin.oracleKind !== oracleKind.kind
  ) {
    failures.push('output_modality_evidence_visual_binding_mismatch');
  }

  const visualDeclaration = aliasedEvidenceValue(
    [outputProof, rawOracle],
    ['verifiedVisualEvidence', 'verified_visual_evidence'],
  );
  if (visualDeclaration.conflict) failures.push('visual_evidence_alias_conflict');
  if (visualDeclaration.duplicate) failures.push('visual_evidence_duplicate_alias');
  const declaredVisualEvidence = visualDeclaration.value;
  const supportEvidence = declaredVisualEvidence?.evidence ?? declaredVisualEvidence;
  const supportPin = supportEvidence && typeof supportEvidence === 'object'
    ? PINNED_VISUAL_SUPPORT_EVIDENCE.get(supportEvidence)
    : null;
  if (
    !supportPin
    || supportEvidence?.accepted !== false
    || supportEvidence?.supportValidated !== true
    || !isDeepStrictEqual(supportEvidence, supportPin.publicIdentity)
  ) {
    failures.push('visual_evidence_live_verification_missing');
  } else {
    if (supportPin.dispatchProof !== dispatchProof) {
      failures.push('visual_evidence_dispatch_receipt_identity_mismatch');
    }
    if (supportPin.outputModalityEvidence !== modalityDeclaration.value) {
      failures.push('visual_evidence_modality_identity_mismatch');
    }
    const dispatchAnchor = dispatchTraceAnchor(dispatchProof, supportPin.dispatchTraceEvidence);
    if (!dispatchAnchor || !isDeepStrictEqual(dispatchAnchor, supportPin.dispatchAnchor)) {
      failures.push('visual_evidence_dispatch_receipt_changed');
    }
  }

  const runnerDeclaration = aliasedEvidenceValue(
    [outputProof],
    ['runnerVisualObservation', 'runner_visual_observation'],
  );
  const runnerPin = runnerDeclaration.value && typeof runnerDeclaration.value === 'object'
    ? PINNED_RUNNER_VISUAL_OBSERVATIONS.get(runnerDeclaration.value)
    : null;
  if (runnerDeclaration.conflict || runnerDeclaration.duplicate) {
    failures.push('visual_capture_provenance_runner_observation_alias_invalid');
  }
  if (
    !runnerPin
    || runnerPin.dispatchProof !== dispatchProof
    || runnerPin.outputModalityEvidence !== modalityDeclaration.value
    || runnerPin.visualSupportEvidence !== supportEvidence
  ) failures.push(VISUAL_RUNNER_PROVENANCE_GAP);

  const failedGates = Object.freeze([...new Set(failures)]);
  return Object.freeze({
    required: true,
    accepted: failedGates.length === 0,
    reason: failedGates[0] ?? null,
    failedGates,
  });
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
  const visualOutputAuthority = fullRuntimeVisualAuthority(outputProof, dispatchProof);
  const claimedOutputRank = effectiveProofRank(outputProof);
  const outputRank = visualOutputAuthority.required && !visualOutputAuthority.accepted
    ? Math.min(claimedOutputRank, proofStateRank('gpu-hmr-dispatch-safe-proven'))
    : claimedOutputRank;
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
      visualOutputAuthority.required && !visualOutputAuthority.accepted
        ? 'gpu-hmr-visual-evidence-missing'
        : outputProof?.degradedState ?? 'gpu-hmr-output-unobserved',
      visualOutputAuthority.required && !visualOutputAuthority.accepted
        ? visualOutputAuthority.reason
        : outputProof?.degradedReason ?? 'output_oracle_not_collected',
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
      outputClaimedRank: claimedOutputRank,
      outputResultState: outputProof?.resultState ?? null,
      visualOutputAuthorityRequired: visualOutputAuthority.required,
      visualOutputAuthorityProven: visualOutputAuthority.accepted,
      visualOutputAuthorityFailedGates: visualOutputAuthority.failedGates,
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
