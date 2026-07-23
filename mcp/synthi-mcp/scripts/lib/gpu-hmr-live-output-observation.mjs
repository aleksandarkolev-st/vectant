import { createHash } from 'node:crypto';

import {
  evaluateGpuHmrObservedCapabilityGraphIntegrity,
} from './gpu-hmr-observed-capability-graph.mjs';

export const GPU_HMR_LIVE_OUTPUT_OBSERVATION_SCHEMA_VERSION =
  'synthi.gpu_hmr.live_output_observation.v1';
export const GPU_HMR_LIVE_OUTPUT_OBSERVATION_AUTHORITY =
  'in_process_verifier_owned_output_bytes_only_not_gpu_hmr_success';

const HASH_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REQUEST_FIELDS = Object.freeze(['graph', 'runtimeChainHash', 'liveInput']);
const VERIFIER_RESULT_FIELDS = Object.freeze(['observations']);
const OBSERVATION_FIELDS = Object.freeze(['nodeId', 'bytes']);
const EXPECTED_FIELDS = Object.freeze([
  'graph',
  'runtimeChainHash',
  'requiredNodeIds',
]);
const RECEIPT_FIELDS = Object.freeze([
  'schemaVersion',
  'authority',
  'subjectBindingHash',
  'graphHash',
  'runtimeChainHash',
  'observations',
  'observationSetHash',
  'receiptHash',
  'receiptId',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);
const MAX_OBSERVATIONS = 128;
const MAX_IDENTIFIER_BYTES = 1024;
const MAX_TOTAL_OBSERVATION_BYTES = 512 * 1024 * 1024;

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
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Reflect.ownKeys(descriptors);
  if (keys.some((key) => typeof key !== 'string')) fail(`${label}_field_set_mismatch`);
  const actual = [...keys].sort();
  const expected = [...fields].sort();
  if (stableJson(actual) !== stableJson(expected)) fail(`${label}_field_set_mismatch`);
  for (const key of actual) {
    if (!Object.hasOwn(descriptors[key], 'value')) fail(`${label}_data_fields_required`);
  }
  return Object.fromEntries(actual.map((key) => [key, descriptors[key].value]));
}

function requireHash(value, label) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) fail(`${label}_invalid`);
  return value;
}

function requireIdentifier(value, label) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value !== value.trim()
    || /\p{Cc}/u.test(value)
    || Buffer.byteLength(value, 'utf8') > MAX_IDENTIFIER_BYTES
  ) {
    fail(`${label}_invalid`);
  }
  return value;
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

function bytesHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function compareCanonical(left, right) {
  const leftJson = stableJson(left);
  const rightJson = stableJson(right);
  if (leftJson < rightJson) return -1;
  if (leftJson > rightJson) return 1;
  return 0;
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
  } else if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) deepFreeze(entry);
  }
  return Object.freeze(value);
}

function requireGraph(candidate) {
  const integrity = evaluateGpuHmrObservedCapabilityGraphIntegrity(candidate);
  if (!integrity.valid || integrity.recomputedGraph === null) {
    fail('observed_capability_graph_invalid');
  }
  return integrity.recomputedGraph;
}

function normalizeRequiredNodeIds(value) {
  if (!Array.isArray(value) || value.length > MAX_OBSERVATIONS) {
    fail('required_node_ids_invalid');
  }
  const nodeIds = value.map((entry, index) =>
    requireIdentifier(entry, `required_node_ids_${index}`));
  if (new Set(nodeIds).size !== nodeIds.length) fail('required_node_ids_duplicate');
  return Object.freeze([...nodeIds].sort());
}

function publicReceiptMaterial(receipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    authority: receipt.authority,
    subjectBindingHash: receipt.subjectBindingHash,
    graphHash: receipt.graphHash,
    runtimeChainHash: receipt.runtimeChainHash,
    observations: receipt.observations,
    observationSetHash: receipt.observationSetHash,
    acceptedForGpuHmr: receipt.acceptedForGpuHmr,
    gpuHmrSuccess: receipt.gpuHmrSuccess,
    canSatisfyRuntimeProof: receipt.canSatisfyRuntimeProof,
    canSatisfyDispatchProof: receipt.canSatisfyDispatchProof,
  };
}

export function createGpuHmrLiveOutputObservationAuthority({ observeLiveOutput }) {
  if (typeof observeLiveOutput !== 'function') fail('live_output_observer_required');
  const issuedReceipts = new WeakMap();

  async function observe(request) {
    const source = requireExactRecord(request, REQUEST_FIELDS, 'request');
    const graph = requireGraph(source.graph);
    const runtimeChainHash = requireHash(source.runtimeChainHash, 'runtime_chain_hash');
    const rawResult = await observeLiveOutput(Object.freeze({
      graph,
      runtimeChainHash,
      liveInput: source.liveInput,
    }));
    const result = requireExactRecord(rawResult, VERIFIER_RESULT_FIELDS, 'verifier_result');
    if (!Array.isArray(result.observations) || result.observations.length === 0
      || result.observations.length > MAX_OBSERVATIONS) {
      fail('observations_invalid');
    }

    const graphNodes = new Map(graph.nodes.map((node) => [node.nodeId, node]));
    let totalBytes = 0;
    const observations = result.observations.map((entry, index) => {
      const observation = requireExactRecord(
        entry,
        OBSERVATION_FIELDS,
        `observations_${index}`,
      );
      const nodeId = requireIdentifier(observation.nodeId, `observations_${index}_node_id`);
      const graphNode = graphNodes.get(nodeId);
      if (!graphNode) fail('observation_node_missing_from_graph');
      if (!Buffer.isBuffer(observation.bytes) && !(observation.bytes instanceof Uint8Array)) {
        fail('observation_bytes_required');
      }
      const bytes = Buffer.from(observation.bytes);
      if (bytes.byteLength === 0) fail('observation_bytes_empty');
      totalBytes += bytes.byteLength;
      if (totalBytes > MAX_TOTAL_OBSERVATION_BYTES) fail('observation_bytes_too_large');
      const evidenceHash = bytesHash(bytes);
      if (evidenceHash !== graphNode.evidenceHash) fail('observation_evidence_hash_mismatch');
      return Object.freeze({ nodeId, byteLength: bytes.byteLength, evidenceHash });
    }).sort(compareCanonical);
    const nodeIds = observations.map((observation) => observation.nodeId).sort();
    if (new Set(nodeIds).size !== nodeIds.length) fail('observation_node_duplicate');
    const graphNodeIds = graph.nodes.map((node) => node.nodeId).sort();
    if (stableJson(nodeIds) !== stableJson(graphNodeIds)) {
      fail('observation_graph_incomplete');
    }

    const observationSetHash = canonicalHash({
      domain: `${GPU_HMR_LIVE_OUTPUT_OBSERVATION_SCHEMA_VERSION}.observation_set`,
      observations,
    });
    const declaration = {
      schemaVersion: GPU_HMR_LIVE_OUTPUT_OBSERVATION_SCHEMA_VERSION,
      authority: GPU_HMR_LIVE_OUTPUT_OBSERVATION_AUTHORITY,
      subjectBindingHash: graph.subjectBindingHash,
      graphHash: graph.graphHash,
      runtimeChainHash,
      observations: Object.freeze(observations),
      observationSetHash,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    };
    const receiptHash = canonicalHash({
      domain: `${GPU_HMR_LIVE_OUTPUT_OBSERVATION_SCHEMA_VERSION}.receipt`,
      receipt: publicReceiptMaterial(declaration),
    });
    const receipt = deepFreeze({
      ...declaration,
      receiptHash,
      receiptId: `gpu-hmr-live-output-observation:${receiptHash}`,
    });
    issuedReceipts.set(receipt, Object.freeze({
      graphHash: graph.graphHash,
      subjectBindingHash: graph.subjectBindingHash,
      runtimeChainHash,
      observationSetHash,
      nodeIds: Object.freeze(nodeIds),
      receiptHash,
    }));
    return receipt;
  }

  function verify(receipt, expected) {
    const failures = [];
    const pinned = receipt !== null && typeof receipt === 'object'
      ? issuedReceipts.get(receipt)
      : undefined;
    if (!pinned) {
      return Object.freeze({
        valid: false,
        failures: Object.freeze(['receipt_not_issued_by_authority']),
        observationSetHash: null,
        observedNodeIds: Object.freeze([]),
      });
    }
    try {
      const receiptSource = requireExactRecord(receipt, RECEIPT_FIELDS, 'receipt');
      const expectedSource = requireExactRecord(expected, EXPECTED_FIELDS, 'expected');
      const graph = requireGraph(expectedSource.graph);
      const runtimeChainHash = requireHash(
        expectedSource.runtimeChainHash,
        'expected_runtime_chain_hash',
      );
      const requiredNodeIds = normalizeRequiredNodeIds(expectedSource.requiredNodeIds);
      const graphNodeIds = graph.nodes.map((node) => node.nodeId).sort();
      if (stableJson(requiredNodeIds) !== stableJson(graphNodeIds)) {
        failures.push('required_observation_graph_incomplete');
      }
      if (receiptSource.schemaVersion !== GPU_HMR_LIVE_OUTPUT_OBSERVATION_SCHEMA_VERSION) {
        failures.push('schema_version_mismatch');
      }
      if (receiptSource.authority !== GPU_HMR_LIVE_OUTPUT_OBSERVATION_AUTHORITY) {
        failures.push('authority_mismatch');
      }
      if (graph.graphHash !== pinned.graphHash || receiptSource.graphHash !== pinned.graphHash) {
        failures.push('graph_hash_mismatch');
      }
      if (
        graph.subjectBindingHash !== pinned.subjectBindingHash
        || receiptSource.subjectBindingHash !== pinned.subjectBindingHash
      ) {
        failures.push('subject_binding_hash_mismatch');
      }
      if (
        runtimeChainHash !== pinned.runtimeChainHash
        || receiptSource.runtimeChainHash !== pinned.runtimeChainHash
      ) {
        failures.push('runtime_chain_hash_mismatch');
      }
      if (receiptSource.observationSetHash !== pinned.observationSetHash) {
        failures.push('observation_set_hash_mismatch');
      }
      if (receiptSource.receiptHash !== pinned.receiptHash
        || receiptSource.receiptId !== `gpu-hmr-live-output-observation:${pinned.receiptHash}`) {
        failures.push('receipt_identity_mismatch');
      }
      if (
        receiptSource.acceptedForGpuHmr !== false
        || receiptSource.gpuHmrSuccess !== false
        || receiptSource.canSatisfyRuntimeProof !== false
        || receiptSource.canSatisfyDispatchProof !== false
      ) {
        failures.push('authority_claim_forbidden');
      }
      if (canonicalHash({
        domain: `${GPU_HMR_LIVE_OUTPUT_OBSERVATION_SCHEMA_VERSION}.receipt`,
        receipt: publicReceiptMaterial(receiptSource),
      }) !== pinned.receiptHash) {
        failures.push('receipt_hash_mismatch');
      }
      const observedNodeIds = new Set(pinned.nodeIds);
      for (const nodeId of requiredNodeIds) {
        if (!observedNodeIds.has(nodeId)) failures.push('required_observation_missing');
      }
    } catch {
      failures.push('receipt_verification_failed');
    }
    const uniqueFailures = Object.freeze([...new Set(failures)]);
    return Object.freeze({
      valid: uniqueFailures.length === 0,
      failures: uniqueFailures,
      observationSetHash: pinned.observationSetHash,
      observedNodeIds: Object.freeze([...pinned.nodeIds]),
    });
  }

  return Object.freeze({ observe, verify });
}
