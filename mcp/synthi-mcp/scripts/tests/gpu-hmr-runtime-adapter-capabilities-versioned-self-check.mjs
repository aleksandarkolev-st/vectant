#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
  createGpuHmrRuntimeAdapterCapabilities,
} from '../lib/gpu-hmr-runtime-adapter-capabilities.mjs';
import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
  createGpuHmrRuntimeAdapterCapabilitiesV2,
} from '../lib/gpu-hmr-runtime-adapter-capabilities-v2.mjs';
import {
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_AUTHORITY,
  GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_ENVELOPE_SCHEMA_VERSION,
  createGpuHmrRuntimeAdapterCapabilitiesVersioned,
  dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned,
  evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity,
} from '../lib/gpu-hmr-runtime-adapter-capabilities-versioned.mjs';

const V1_INPUT = Object.freeze({
  artifactFormat: 'native_binary',
  outputModality: 'compute',
  oracleKind: 'compute_oracle',
  publicationModel: 'dispatch_table_epoch',
  commandRecordingModel: 'late_bound_dispatch',
  pipelineCacheOwner: 'none',
  evidenceRefs: ['trace:source', 'hash:artifact'],
});
const V2_INPUT = Object.freeze({
  ...V1_INPUT,
  artifactMaterializationModel: 'ahead_of_time',
  dispatchBindingModel: 'direct',
  resourceBindingModel: 'fixed_layout',
  deviceTopology: 'single_device',
  synchronizationTopology: 'single_queue_ordered',
  stateContinuityModel: 'stateless',
  rayTracingStateModel: 'none',
  pipelineReuseModel: 'none',
});
const FALSE_AUTHORITY_FIELDS = Object.freeze([
  'acceptedAsSupportEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
]);

function expectReject(callback, expression) {
  assert.throws(callback, expression);
}

function assertSupportOnly(envelope, version, historical) {
  assert.equal(Object.isFrozen(envelope), true);
  assert.equal(envelope.envelopeSchemaVersion,
    GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_ENVELOPE_SCHEMA_VERSION);
  assert.equal(envelope.schemaVersion, version);
  assert.equal(envelope.authority, GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_VERSIONED_AUTHORITY);
  assert.equal(envelope.historical, historical);
  assert.equal(envelope.valid, true);
  assert.equal(Object.isFrozen(envelope.facet), true);
  for (const field of FALSE_AUTHORITY_FIELDS) {
    assert.equal(envelope[field], false, field);
    assert.equal(envelope.facet[field], false, `facet.${field}`);
  }
  assert.equal(envelope.obligations, envelope.facet.obligations);
  assert.equal(envelope.capabilitiesHash, envelope.facet.capabilitiesHash);
  assert.equal(envelope.obligationsHash, envelope.facet.obligationsHash);
  assert.equal(envelope.bindingHash, envelope.facet.bindingHash);
  assert.equal(envelope.proofId, envelope.facet.proofId);
}

const v1Facet = createGpuHmrRuntimeAdapterCapabilities(V1_INPUT);
const v1Bytes = Buffer.from(JSON.stringify(v1Facet));
const v1Envelope = dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(v1Facet);
assertSupportOnly(v1Envelope, GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION, true);
assert.deepEqual(Buffer.from(JSON.stringify(v1Envelope.facet)), v1Bytes);
assert.equal(v1Envelope.proofId, v1Facet.proofId);
assert.equal(v1Envelope.facet.proofId, v1Facet.proofId);

const v2Facet = createGpuHmrRuntimeAdapterCapabilitiesV2(V2_INPUT);
const v2Envelope = dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(v2Facet);
assertSupportOnly(v2Envelope, GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION, false);
assert.deepEqual(v2Envelope.facet, v2Facet);

const created = createGpuHmrRuntimeAdapterCapabilitiesVersioned({
  schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
  ...V2_INPUT,
});
assertSupportOnly(created, GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION, false);

expectReject(
  () => createGpuHmrRuntimeAdapterCapabilitiesVersioned({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION,
    ...V1_INPUT,
  }),
  /create_downgrade_forbidden/,
);
expectReject(
  () => createGpuHmrRuntimeAdapterCapabilitiesVersioned({
    schemaVersion: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_V2_SCHEMA_VERSION,
    ...V2_INPUT,
    gpuHmrSuccess: true,
  }),
  /create_unknown_field:gpuHmrSuccess/,
);

const mixed = {
  ...v1Facet,
  artifactMaterializationModel: 'ahead_of_time',
};
const mixedResult = evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity(mixed);
assert.equal(mixedResult.valid, false);
assert.match(mixedResult.failures[0], /facet_mixed_version_fields/);
expectReject(() => dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(mixed), /facet_rejected/);

const forged = { ...v2Facet, acceptedForGpuHmr: true };
const forgedResult = evaluateGpuHmrRuntimeAdapterCapabilitiesVersionedIntegrity(forged);
assert.equal(forgedResult.valid, false);
assert.equal(forgedResult.acceptedForGpuHmr, false);
expectReject(() => dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(forged), /facet_rejected/);

for (const candidate of [
  { ...v2Facet, schema_version: v2Facet.schemaVersion },
  { ...v2Facet, schema_version: GPU_HMR_RUNTIME_ADAPTER_CAPABILITIES_SCHEMA_VERSION },
  { ...v2Facet, schemaVersion: 'synthi.gpu_hmr.runtime_adapter_capabilities.v99' },
]) {
  expectReject(() => dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(candidate), /facet_rejected/);
}

const accessor = { ...v2Facet };
Object.defineProperty(accessor, 'authority', {
  enumerable: true,
  get: () => v2Facet.authority,
});
const symbol = { ...v2Facet, [Symbol('untrusted')]: 'value' };
const cyclic = { ...v2Facet, evidenceRefs: [] };
cyclic.evidenceRefs.push(cyclic);
const oversized = { ...v2Facet, evidenceRefs: ['x'.repeat(4097)] };
for (const candidate of [new Proxy(v2Facet, {}), accessor, symbol, cyclic, oversized]) {
  expectReject(() => dispatchGpuHmrRuntimeAdapterCapabilitiesVersioned(candidate), /facet_rejected/);
}

const source = await readFile(
  new URL('../lib/gpu-hmr-runtime-adapter-capabilities-versioned.mjs', import.meta.url),
  'utf8',
);
assert.doesNotMatch(source, /\b(?:project|backend|profile|target|fixture)\b/i);
assert.match(source, /schemaVersion/);
assert.match(source, /V1_FACET_FIELDS/);
assert.match(source, /V2_FACET_FIELDS/);

console.log('gpu-hmr-runtime-adapter-capabilities-versioned-self-check: ok');
