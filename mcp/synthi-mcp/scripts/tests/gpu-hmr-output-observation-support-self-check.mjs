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

function subjectBindingHash(value) {
  const canonical = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
  return hash(JSON.stringify(canonical));
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
const runtimeSubject = Object.freeze({
  artifactIdentity: hash('changed-artifact'),
  dispatchIdentity: 'dispatch:opaque:17',
  epochIdentity: 'epoch:opaque:8',
  outputTargetIdentity: 'output:opaque:3',
  processIdentity: 'process:opaque:41',
  runtimeSessionIdentity: 'session:opaque:12',
});
const graphNodes = [
  graphNode(firstNodeId, 'opaque-output-mechanic-a', firstBytes),
  graphNode(secondNodeId, 'unregistered-output-mechanic-b', secondBytes),
];
const graphEdges = [{
  dependentNodeId: secondNodeId,
  requiredNodeId: firstNodeId,
  relationId: 'verifier-defined-output-dependency',
  dependencySchemaHash: hash('dependency-schema'),
  evidenceHash: hash('dependency-evidence'),
  evidenceRefs: [`cas:${hash('dependency-evidence')}`],
}];
function graphForSubject(subject, nodes = graphNodes, edges = graphEdges) {
  return createGpuHmrObservedCapabilityGraph({
    subjectBindingHash: subjectBindingHash(subject),
    nodes,
    edges,
  });
}
const graph = graphForSubject(runtimeSubject);
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

for (const [field, value] of [
  ['artifactIdentity', hash('other-artifact')],
  ['dispatchIdentity', 'dispatch:opaque:18'],
  ['epochIdentity', 'epoch:opaque:9'],
  ['outputTargetIdentity', 'output:opaque:4'],
  ['processIdentity', 'process:opaque:42'],
  ['runtimeSessionIdentity', 'session:opaque:13'],
]) {
  const inspection = channel.inspect(receipt, {
    graph: graphForSubject({ ...runtimeSubject, [field]: value }),
    declaredRuntimeChainHash: runtimeChainHash,
    requiredNodeIds: [firstNodeId, secondNodeId],
  });
  assert.equal(inspection.supportIntegrityValid, false, field);
  assert.equal(inspection.failures.includes('subject_binding_hash_mismatch'), true, field);
}

const missingDependencyGraph = graphForSubject(runtimeSubject, [
  graphNode(secondNodeId, 'unregistered-output-mechanic-b', secondBytes),
], []);
const missingDependencyInspection = channel.inspect(receipt, {
  graph: missingDependencyGraph,
  declaredRuntimeChainHash: runtimeChainHash,
  requiredNodeIds: [secondNodeId],
});
assert.equal(missingDependencyInspection.supportIntegrityValid, false);
assert.equal(missingDependencyInspection.failures.includes('graph_hash_mismatch'), true);

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
  runtimeSubjectMutationRejected: true,
  dependencyClosureMutationRejected: true,
  declaredSuccessRejected: true,
  canSatisfyRuntimeProof: false,
}, null, 2));
