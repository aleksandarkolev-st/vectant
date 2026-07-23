import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createGpuHmrObservedCapabilityGraph,
} from '../lib/gpu-hmr-observed-capability-graph.mjs';
import {
  createGpuHmrLiveOutputObservationAuthority,
} from '../lib/gpu-hmr-live-output-observation.mjs';

function hash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function graphNode(nodeId, capabilityId, bytes) {
  return {
    nodeId,
    capabilityId,
    observationSchemaHash: hash(`${nodeId}:open-schema`),
    verifierHash: hash(`${nodeId}:verifier-identity`),
    evidenceHash: hash(bytes),
    evidenceRefs: [`cas:${hash(bytes)}`],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

const firstBytes = Buffer.from('arbitrary verified output bytes: first');
const secondBytes = Buffer.from('arbitrary verified output bytes: second');
const firstNodeId = 'urn:unknown-output:state/one';
const secondNodeId = 'vendor.future.output+state://two';
const graph = createGpuHmrObservedCapabilityGraph({
  subjectBindingHash: hash('subject-without-architecture-name'),
  nodes: [
    graphNode(firstNodeId, 'opaque-output-mechanic-a', firstBytes),
    graphNode(secondNodeId, 'unregistered-output-mechanic-b', secondBytes),
  ],
  edges: [{
    dependentNodeId: secondNodeId,
    requiredNodeId: firstNodeId,
    relationId: 'verifier-defined-output-dependency',
    dependencySchemaHash: hash('dependency-schema'),
    evidenceHash: hash('dependency-evidence'),
    evidenceRefs: [`cas:${hash('dependency-evidence')}`],
  }],
});
const runtimeChainHash = hash('strict-runtime-chain');

const authority = createGpuHmrLiveOutputObservationAuthority({
  async observeLiveOutput({ liveInput }) {
    return { observations: liveInput };
  },
});
const receipt = await authority.observe({
  graph,
  runtimeChainHash,
  liveInput: [
    { nodeId: firstNodeId, bytes: firstBytes },
    { nodeId: secondNodeId, bytes: new Uint8Array(secondBytes) },
  ],
});

assert.equal(receipt.acceptedForGpuHmr, false);
assert.equal(receipt.gpuHmrSuccess, false);
assert.equal(receipt.canSatisfyRuntimeProof, false);
assert.equal(receipt.canSatisfyDispatchProof, false);
assert.equal(Object.isFrozen(receipt), true);
assert.equal(authority.verify(receipt, {
  graph,
  runtimeChainHash,
  requiredNodeIds: [secondNodeId, firstNodeId],
}).valid, true);

const jsonClone = clone(receipt);
assert.deepEqual(authority.verify(jsonClone, {
  graph,
  runtimeChainHash,
  requiredNodeIds: [firstNodeId],
}), {
  valid: false,
  failures: ['receipt_not_issued_by_authority'],
  observationSetHash: null,
  observedNodeIds: [],
});

const otherAuthority = createGpuHmrLiveOutputObservationAuthority({
  async observeLiveOutput({ liveInput }) {
    return { observations: liveInput };
  },
});
assert.equal(otherAuthority.verify(receipt, {
  graph,
  runtimeChainHash,
  requiredNodeIds: [firstNodeId],
}).valid, false);

assert.equal(authority.verify(receipt, {
  graph,
  runtimeChainHash,
  requiredNodeIds: ['not-observed'],
}).failures.includes('required_observation_missing'), true);
assert.equal(authority.verify(receipt, {
  graph,
  runtimeChainHash,
  requiredNodeIds: [firstNodeId],
}).failures.includes('required_observation_graph_incomplete'), true);
assert.equal(authority.verify(receipt, {
  graph,
  runtimeChainHash: hash('different-runtime-chain'),
  requiredNodeIds: [firstNodeId],
}).failures.includes('runtime_chain_hash_mismatch'), true);

await assert.rejects(
  authority.observe({
    graph,
    runtimeChainHash,
    liveInput: [{ nodeId: firstNodeId, bytes: Buffer.from('forged bytes') }],
  }),
  /observation_evidence_hash_mismatch/,
);
await assert.rejects(
  authority.observe({
    graph,
    runtimeChainHash,
    liveInput: [{ nodeId: firstNodeId, bytes: Buffer.alloc(0) }],
  }),
  /observation_bytes_empty/,
);
await assert.rejects(
  authority.observe({
    graph,
    runtimeChainHash,
    liveInput: [{ nodeId: firstNodeId, bytes: firstBytes }],
  }),
  /observation_graph_incomplete/,
);

const declarationObserver = createGpuHmrLiveOutputObservationAuthority({
  async observeLiveOutput() {
    return {
      observations: [],
      gpuHmrSuccess: true,
    };
  },
});
await assert.rejects(
  declarationObserver.observe({ graph, runtimeChainHash, liveInput: null }),
  /verifier_result_field_set_mismatch/,
);

console.log(JSON.stringify({
  status: 'ok',
  receiptHash: receipt.receiptHash,
  unfamiliarOutputMechanicsAccepted: true,
  outputBytesBoundToGraph: true,
  runtimeChainBound: true,
  jsonReplayRejected: true,
  crossAuthorityReplayRejected: true,
  declaredSuccessRejected: true,
}, null, 2));
