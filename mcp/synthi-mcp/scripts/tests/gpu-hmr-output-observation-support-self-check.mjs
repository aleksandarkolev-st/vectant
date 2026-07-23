import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createGpuHmrObservedCapabilityGraph,
} from '../lib/gpu-hmr-observed-capability-graph.mjs';
import {
  createGpuHmrOutputObservationSupportChannel,
} from '../lib/gpu-hmr-output-observation-support.mjs';

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
const runtimeChainHash = hash('caller-declared-runtime-chain');

const channel = createGpuHmrOutputObservationSupportChannel({
  async collectOutputBytes({ sourceInput }) {
    return { observations: sourceInput };
  },
});
const receipt = await channel.collect({
  graph,
  declaredRuntimeChainHash: runtimeChainHash,
  sourceInput: [
    { nodeId: firstNodeId, bytes: firstBytes },
    { nodeId: secondNodeId, bytes: new Uint8Array(secondBytes) },
  ],
});

assert.equal(receipt.acceptedForGpuHmr, false);
assert.equal(receipt.gpuHmrSuccess, false);
assert.equal(receipt.canSatisfyRuntimeProof, false);
assert.equal(receipt.canSatisfyDispatchProof, false);
assert.equal(Object.isFrozen(receipt), true);
assert.equal(channel.inspect(receipt, {
  graph,
  declaredRuntimeChainHash: runtimeChainHash,
  requiredNodeIds: [secondNodeId, firstNodeId],
}).supportIntegrityValid, true);
assert.equal('verify' in channel, false);
assert.equal('valid' in channel.inspect(receipt, {
  graph,
  declaredRuntimeChainHash: runtimeChainHash,
  requiredNodeIds: [secondNodeId, firstNodeId],
}), false);

const jsonClone = clone(receipt);
assert.deepEqual(channel.inspect(jsonClone, {
  graph,
  declaredRuntimeChainHash: runtimeChainHash,
  requiredNodeIds: [firstNodeId],
}), {
  supportIntegrityValid: false,
  failures: ['receipt_not_issued_by_authority'],
  observationSetHash: null,
  observedNodeIds: [],
});

const otherChannel = createGpuHmrOutputObservationSupportChannel({
  async collectOutputBytes({ sourceInput }) {
    return { observations: sourceInput };
  },
});
assert.equal(otherChannel.inspect(receipt, {
  graph,
  declaredRuntimeChainHash: runtimeChainHash,
  requiredNodeIds: [firstNodeId],
}).supportIntegrityValid, false);

assert.equal(channel.inspect(receipt, {
  graph,
  declaredRuntimeChainHash: runtimeChainHash,
  requiredNodeIds: ['not-observed'],
}).failures.includes('required_observation_missing'), true);
assert.equal(channel.inspect(receipt, {
  graph,
  declaredRuntimeChainHash: runtimeChainHash,
  requiredNodeIds: [firstNodeId],
}).failures.includes('required_observation_graph_incomplete'), true);
assert.equal(channel.inspect(receipt, {
  graph,
  declaredRuntimeChainHash: hash('different-runtime-chain'),
  requiredNodeIds: [firstNodeId],
}).failures.includes('declared_runtime_chain_hash_mismatch'), true);

await assert.rejects(
  channel.collect({
    graph,
    declaredRuntimeChainHash: runtimeChainHash,
    sourceInput: [{ nodeId: firstNodeId, bytes: Buffer.from('forged bytes') }],
  }),
  /observation_evidence_hash_mismatch/,
);
await assert.rejects(
  channel.collect({
    graph,
    declaredRuntimeChainHash: runtimeChainHash,
    sourceInput: [{ nodeId: firstNodeId, bytes: Buffer.alloc(0) }],
  }),
  /observation_bytes_empty/,
);
await assert.rejects(
  channel.collect({
    graph,
    declaredRuntimeChainHash: runtimeChainHash,
    sourceInput: [{ nodeId: firstNodeId, bytes: firstBytes }],
  }),
  /observation_graph_incomplete/,
);

const declarationChannel = createGpuHmrOutputObservationSupportChannel({
  async collectOutputBytes() {
    return {
      observations: [],
      gpuHmrSuccess: true,
    };
  },
});
await assert.rejects(
  declarationChannel.collect({
    graph,
    declaredRuntimeChainHash: runtimeChainHash,
    sourceInput: null,
  }),
  /verifier_result_field_set_mismatch/,
);

console.log(JSON.stringify({
  status: 'ok',
  receiptHash: receipt.receiptHash,
  unfamiliarOutputMechanicsAccepted: true,
  outputBytesBoundToGraphAsSupportOnly: true,
  declaredRuntimeChainBoundAsSupportOnly: true,
  jsonReplayRejected: true,
  crossAuthorityReplayRejected: true,
  declaredSuccessRejected: true,
  canSatisfyRuntimeProof: false,
}, null, 2));
