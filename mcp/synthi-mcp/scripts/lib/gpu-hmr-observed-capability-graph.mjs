import { createHash } from 'node:crypto';

export const GPU_HMR_OBSERVED_CAPABILITY_GRAPH_SCHEMA_VERSION =
  'synthi.gpu_hmr.observed_capability_graph.v1';
export const GPU_HMR_OBSERVED_CAPABILITY_GRAPH_AUTHORITY =
  'verifier_observation_graph_integrity_only_not_runtime_or_gpu_hmr_authority';

export const GPU_HMR_OBSERVED_CAPABILITY_GRAPH_INPUT_FIELDS = Object.freeze([
  'subjectBindingHash',
  'nodes',
  'edges',
]);
export const GPU_HMR_OBSERVED_CAPABILITY_GRAPH_NODE_FIELDS = Object.freeze([
  'nodeId',
  'capabilityId',
  'observationSchemaHash',
  'verifierHash',
  'evidenceHash',
  'evidenceRefs',
]);
export const GPU_HMR_OBSERVED_CAPABILITY_GRAPH_EDGE_FIELDS = Object.freeze([
  'dependentNodeId',
  'requiredNodeId',
  'relationId',
  'dependencySchemaHash',
  'evidenceHash',
  'evidenceRefs',
]);

const OUTPUT_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  'subjectBindingHash',
  'nodes',
  'edges',
  'graphHash',
  'graphId',
  'valid',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);
const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const MAX_NODES = 4096;
const MAX_EDGES = 16384;
const MAX_IDENTIFIER_BYTES = 1024;
const MAX_EVIDENCE_REFS = 64;
const MAX_EVIDENCE_REF_BYTES = 2048;
const MAX_EVIDENCE_REFS_BYTES = 32 * 1024;

function fail(code) {
  throw new Error(code);
}

function isPlainRecord(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requireExactRecord(value, fields, label) {
  if (!isPlainRecord(value)) fail(`${label}_record_required`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key !== 'string')) fail(`${label}_field_set_mismatch`);
  const actual = [...ownKeys].sort();
  const expected = [...fields].sort();
  if (stableJson(actual) !== stableJson(expected)) fail(`${label}_field_set_mismatch`);
  for (const key of actual) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !Object.hasOwn(descriptor, 'value')) {
      fail(`${label}_data_fields_required`);
    }
  }
  return value;
}

function requireBoundedString(value, label, maximumBytes) {
  if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
    fail(`${label}_invalid`);
  }
  if (/\p{Cc}/u.test(value) || Buffer.byteLength(value, 'utf8') > maximumBytes) {
    fail(`${label}_invalid`);
  }
  return value;
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail(`${label}_invalid`);
  return value;
}

function normalizeEvidenceRefs(value, label) {
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE_REFS) {
    fail(`${label}_invalid`);
  }
  const refs = value.map((entry, index) => requireBoundedString(
    entry,
    `${label}_${index}`,
    MAX_EVIDENCE_REF_BYTES,
  ));
  if (new Set(refs).size !== refs.length) fail(`${label}_duplicate`);
  if (refs.reduce((total, entry) => total + Buffer.byteLength(entry, 'utf8'), 0)
    > MAX_EVIDENCE_REFS_BYTES) {
    fail(`${label}_too_large`);
  }
  return Object.freeze([...refs].sort());
}

function normalizeNode(value, index) {
  const label = `nodes_${index}`;
  const source = requireExactRecord(
    value,
    GPU_HMR_OBSERVED_CAPABILITY_GRAPH_NODE_FIELDS,
    label,
  );
  return Object.freeze({
    nodeId: requireBoundedString(source.nodeId, `${label}_node_id`, MAX_IDENTIFIER_BYTES),
    capabilityId: requireBoundedString(
      source.capabilityId,
      `${label}_capability_id`,
      MAX_IDENTIFIER_BYTES,
    ),
    observationSchemaHash: requireHash(
      source.observationSchemaHash,
      `${label}_observation_schema_hash`,
    ),
    verifierHash: requireHash(source.verifierHash, `${label}_verifier_hash`),
    evidenceHash: requireHash(source.evidenceHash, `${label}_evidence_hash`),
    evidenceRefs: normalizeEvidenceRefs(source.evidenceRefs, `${label}_evidence_refs`),
  });
}

function normalizeEdge(value, index) {
  const label = `edges_${index}`;
  const source = requireExactRecord(
    value,
    GPU_HMR_OBSERVED_CAPABILITY_GRAPH_EDGE_FIELDS,
    label,
  );
  return Object.freeze({
    dependentNodeId: requireBoundedString(
      source.dependentNodeId,
      `${label}_dependent_node_id`,
      MAX_IDENTIFIER_BYTES,
    ),
    requiredNodeId: requireBoundedString(
      source.requiredNodeId,
      `${label}_required_node_id`,
      MAX_IDENTIFIER_BYTES,
    ),
    relationId: requireBoundedString(
      source.relationId,
      `${label}_relation_id`,
      MAX_IDENTIFIER_BYTES,
    ),
    dependencySchemaHash: requireHash(
      source.dependencySchemaHash,
      `${label}_dependency_schema_hash`,
    ),
    evidenceHash: requireHash(source.evidenceHash, `${label}_evidence_hash`),
    evidenceRefs: normalizeEvidenceRefs(source.evidenceRefs, `${label}_evidence_refs`),
  });
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function canonicalHash(value) {
  return `sha256:${createHash('sha256').update(stableJson(value)).digest('hex')}`;
}

function compareCanonical(left, right) {
  const leftJson = stableJson(left);
  const rightJson = stableJson(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

function graphHashMaterial(graph) {
  return {
    schemaVersion: graph.schemaVersion,
    authority: graph.authority,
    subjectBindingHash: graph.subjectBindingHash,
    nodes: graph.nodes,
    edges: graph.edges,
    valid: graph.valid,
    acceptedForGpuHmr: graph.acceptedForGpuHmr,
    gpuHmrSuccess: graph.gpuHmrSuccess,
    canSatisfyRuntimeProof: graph.canSatisfyRuntimeProof,
    canSatisfyDispatchProof: graph.canSatisfyDispatchProof,
  };
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

export function createGpuHmrObservedCapabilityGraph(input) {
  const source = requireExactRecord(
    input,
    GPU_HMR_OBSERVED_CAPABILITY_GRAPH_INPUT_FIELDS,
    'input',
  );
  const subjectBindingHash = requireHash(source.subjectBindingHash, 'subject_binding_hash');
  if (!Array.isArray(source.nodes) || source.nodes.length > MAX_NODES) {
    fail('nodes_invalid');
  }
  if (!Array.isArray(source.edges) || source.edges.length > MAX_EDGES) {
    fail('edges_invalid');
  }

  const nodes = source.nodes.map(normalizeNode).sort(compareCanonical);
  const nodeIds = nodes.map((node) => node.nodeId);
  if (new Set(nodeIds).size !== nodeIds.length) fail('node_id_duplicate');

  const knownNodeIds = new Set(nodeIds);
  const edges = source.edges.map(normalizeEdge).sort(compareCanonical);
  for (const edge of edges) {
    if (!knownNodeIds.has(edge.dependentNodeId) || !knownNodeIds.has(edge.requiredNodeId)) {
      fail('edge_node_reference_missing');
    }
  }
  const edgeKeys = edges.map(stableJson);
  if (new Set(edgeKeys).size !== edgeKeys.length) fail('edge_duplicate');

  const declaration = {
    schemaVersion: GPU_HMR_OBSERVED_CAPABILITY_GRAPH_SCHEMA_VERSION,
    authority: GPU_HMR_OBSERVED_CAPABILITY_GRAPH_AUTHORITY,
    subjectBindingHash,
    nodes: Object.freeze(nodes),
    edges: Object.freeze(edges),
    valid: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  const graphHash = canonicalHash({
    domain: `${GPU_HMR_OBSERVED_CAPABILITY_GRAPH_SCHEMA_VERSION}.graph`,
    graph: graphHashMaterial(declaration),
  });
  return deepFreeze({
    ...declaration,
    graphHash,
    graphId: `gpu-hmr-observed-capability-graph:${graphHash}`,
  });
}

export function evaluateGpuHmrObservedCapabilityGraphIntegrity(candidate) {
  const failures = [];
  let recomputedGraph = null;
  try {
    const source = requireExactRecord(candidate, OUTPUT_FIELDS, 'candidate');
    recomputedGraph = createGpuHmrObservedCapabilityGraph({
      subjectBindingHash: source.subjectBindingHash,
      nodes: source.nodes,
      edges: source.edges,
    });
    if (source.schemaVersion !== GPU_HMR_OBSERVED_CAPABILITY_GRAPH_SCHEMA_VERSION) {
      failures.push('schema_version_mismatch');
    }
    if (source.authority !== GPU_HMR_OBSERVED_CAPABILITY_GRAPH_AUTHORITY) {
      failures.push('authority_mismatch');
    }
    if (source.graphHash !== recomputedGraph.graphHash) failures.push('graph_hash_mismatch');
    if (source.graphId !== recomputedGraph.graphId) failures.push('graph_id_mismatch');
    if (source.valid !== true) failures.push('validity_mismatch');
    if (
      source.acceptedForGpuHmr !== false
      || source.gpuHmrSuccess !== false
      || source.canSatisfyRuntimeProof !== false
      || source.canSatisfyDispatchProof !== false
    ) {
      failures.push('authority_claim_forbidden');
    }
    if (stableJson(source.nodes) !== stableJson(recomputedGraph.nodes)) {
      failures.push('nodes_not_canonical');
    }
    if (stableJson(source.edges) !== stableJson(recomputedGraph.edges)) {
      failures.push('edges_not_canonical');
    }
  } catch {
    failures.push('graph_recompute_failed');
  }
  const uniqueFailures = Object.freeze([...new Set(failures)]);
  return Object.freeze({
    valid: uniqueFailures.length === 0 && recomputedGraph !== null,
    failures: uniqueFailures,
    recomputedGraph,
  });
}
