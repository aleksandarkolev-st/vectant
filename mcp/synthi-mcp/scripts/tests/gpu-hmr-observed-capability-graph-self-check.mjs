import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  createGpuHmrObservedCapabilityGraph,
  evaluateGpuHmrObservedCapabilityGraphIntegrity,
} from '../lib/gpu-hmr-observed-capability-graph.mjs';

function hash(label) {
  return `sha256:${createHash('sha256').update(label).digest('hex')}`;
}

function node(nodeId, capabilityId) {
  return {
    nodeId,
    capabilityId,
    observationSchemaHash: hash(`${nodeId}:observation-schema`),
    verifierHash: hash(`${nodeId}:verifier`),
    evidenceHash: hash(`${nodeId}:evidence`),
    evidenceRefs: [`cas:${hash(`${nodeId}:evidence`)}`],
  };
}

function edge(dependentNodeId, requiredNodeId, relationId) {
  return {
    dependentNodeId,
    requiredNodeId,
    relationId,
    dependencySchemaHash: hash(`${relationId}:dependency-schema`),
    evidenceHash: hash(`${dependentNodeId}:${requiredNodeId}:${relationId}`),
    evidenceRefs: [`cas:${hash(`${relationId}:edge-evidence`)}`],
  };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function expectRejected(factory, expectedCode) {
  assert.throws(factory, (error) => error instanceof Error && error.message === expectedCode);
}

const graphInput = {
  subjectBindingHash: hash('arbitrary-runtime-subject'),
  nodes: [
    node('node:future-output', 'urn:future-runtime:opaque+output@2029/custom-stage'),
    node('node:future-publication', 'x-private-mechanic://publish/indirect-state'),
    node('node:future-dispatch', 'vendor.extension.without-a-registered-enum'),
  ],
  edges: [
    edge('node:future-output', 'node:future-dispatch', 'depends-on-observed-mechanic'),
    edge('node:future-dispatch', 'node:future-publication', 'requires-before-use'),
    edge('node:future-publication', 'node:future-output', 'recursive-state-relation'),
    edge('node:future-output', 'node:future-output', 'self-described-runtime-relation'),
  ],
};

const graph = createGpuHmrObservedCapabilityGraph(graphInput);
assert.equal(graph.valid, true);
assert.equal(graph.acceptedForGpuHmr, false);
assert.equal(graph.gpuHmrSuccess, false);
assert.equal(graph.canSatisfyRuntimeProof, false);
assert.equal(graph.canSatisfyDispatchProof, false);
assert.equal(Object.isFrozen(graph), true);
assert.equal(Object.isFrozen(graph.nodes), true);
assert.equal(evaluateGpuHmrObservedCapabilityGraphIntegrity(graph).valid, true);

const reordered = createGpuHmrObservedCapabilityGraph({
  ...graphInput,
  nodes: [...graphInput.nodes].reverse(),
  edges: [...graphInput.edges].reverse(),
});
assert.equal(reordered.graphHash, graph.graphHash);

const serialized = clone(graph);
const serializedIntegrity = evaluateGpuHmrObservedCapabilityGraphIntegrity(serialized);
assert.equal(serializedIntegrity.valid, true);
assert.equal(serializedIntegrity.recomputedGraph.acceptedForGpuHmr, false);
assert.equal(serializedIntegrity.recomputedGraph.canSatisfyRuntimeProof, false);

const forgedAuthority = clone(graph);
forgedAuthority.authority = 'runtime_authority';
forgedAuthority.acceptedForGpuHmr = true;
forgedAuthority.gpuHmrSuccess = true;
forgedAuthority.canSatisfyRuntimeProof = true;
assert.equal(evaluateGpuHmrObservedCapabilityGraphIntegrity(forgedAuthority).valid, false);
assert.ok(
  evaluateGpuHmrObservedCapabilityGraphIntegrity(forgedAuthority).failures.includes(
    'authority_claim_forbidden',
  ),
);

const changedEvidence = clone(graphInput);
changedEvidence.nodes[0].evidenceHash = hash('changed-evidence');
assert.notEqual(createGpuHmrObservedCapabilityGraph(changedEvidence).graphHash, graph.graphHash);

const duplicateNode = clone(graphInput);
duplicateNode.nodes.push(node('node:future-output', 'another-unfamiliar-capability'));
expectRejected(
  () => createGpuHmrObservedCapabilityGraph(duplicateNode),
  'node_id_duplicate',
);

const danglingEdge = clone(graphInput);
danglingEdge.edges.push(edge('node:future-output', 'node:not-observed', 'missing-observation'));
expectRejected(
  () => createGpuHmrObservedCapabilityGraph(danglingEdge),
  'edge_node_reference_missing',
);

const duplicateEdge = clone(graphInput);
duplicateEdge.edges.push(clone(duplicateEdge.edges[0]));
expectRejected(
  () => createGpuHmrObservedCapabilityGraph(duplicateEdge),
  'edge_duplicate',
);

const successClaimInput = clone(graphInput);
successClaimInput.gpuHmrSuccess = true;
expectRejected(
  () => createGpuHmrObservedCapabilityGraph(successClaimInput),
  'input_field_set_mismatch',
);

const accessorInput = clone(graphInput);
Object.defineProperty(accessorInput, 'nodes', {
  enumerable: true,
  get() {
    throw new Error('accessor_must_not_run');
  },
});
expectRejected(
  () => createGpuHmrObservedCapabilityGraph(accessorInput),
  'input_data_fields_required',
);

const oversizedIdentifier = clone(graphInput);
oversizedIdentifier.nodes[0].capabilityId = 'x'.repeat(1025);
expectRejected(
  () => createGpuHmrObservedCapabilityGraph(oversizedIdentifier),
  'nodes_0_capability_id_invalid',
);

console.log(JSON.stringify({
  status: 'ok',
  graphHash: graph.graphHash,
  unfamiliarCapabilitiesAccepted: true,
  arbitraryTopologyAccepted: true,
  serializedGraphRuntimeAuthority: false,
  forgedAuthorityRejected: true,
}, null, 2));
