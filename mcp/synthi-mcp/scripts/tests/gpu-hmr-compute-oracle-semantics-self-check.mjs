import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  COMPUTE_ORACLE_SEMANTIC_VERIFICATION_AUTHORITY,
  buildComputeExpectedOutputContract,
  verifyComputeOracleSemantics,
} from '../lib/gpu-hmr-compute-oracle-semantics.mjs';

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function encodeFloat32(values) {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => bytes.writeFloatLE(value, index * 4));
  return bytes;
}

const binding = {
  projectId: 'project:semantic-self-check',
  editId: 'edit:semantic-self-check',
  artifactAfterHash: sha256(Buffer.from('artifact-after')),
  outputTargetId: 'output:semantic-self-check',
  oracleCodeHash: sha256(Buffer.from('oracle-code')),
};
const expectedValues = [1.25, 2.5, 5, 10];
const rawBytes = encodeFloat32(expectedValues);
const contract = buildComputeExpectedOutputContract({
  comparisonMode: 'numeric_tolerance',
  dtype: 'f32',
  shape: [2, 2],
  elementCount: expectedValues.length,
  byteOrder: 'little_endian',
  tolerance: 0.00001,
  expectedValues,
  binding,
  evidenceRefs: ['contract:pre-dispatch-semantic-self-check'],
});
const schema = {
  schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v2',
  dtype: { name: 'f32', byteWidth: 4 },
  shape: [2, 2],
  elementCount: expectedValues.length,
  byteLength: rawBytes.length,
  byteOrder: 'little_endian',
  rawReadbackHash: sha256(rawBytes),
};

const accepted = verifyComputeOracleSemantics({
  rawBytes,
  readbackSchema: Buffer.from(JSON.stringify(schema)),
  expectedOutputContract: contract,
  observedBinding: binding,
});
assert.equal(accepted.accepted, true, JSON.stringify(accepted.failedGates));
assert.equal(accepted.bindingAccepted, true);
assert.equal(accepted.mismatchCount, 0);
assert.equal(accepted.acceptedForGpuHmr, false);
assert.equal(accepted.gpuHmrSuccess, false);
assert.equal(accepted.canSatisfyRuntimeProof, false);
assert.equal(accepted.proofAuthority, COMPUTE_ORACLE_SEMANTIC_VERIFICATION_AUTHORITY);

const wrongBytes = encodeFloat32([1.25, 2.5, 5, 11]);
const wrongSchema = {
  ...schema,
  rawReadbackHash: sha256(wrongBytes),
  expectedOutput: {
    dataType: 'float32',
    values: [1.25, 2.5, 5, 11],
    tolerance: 0.00001,
    verified: true,
  },
};
const forgedProducerSuccess = verifyComputeOracleSemantics({
  rawBytes: wrongBytes,
  readbackSchema: wrongSchema,
  expectedOutputContract: contract,
  observedBinding: binding,
});
assert.equal(forgedProducerSuccess.accepted, false);
assert.ok(forgedProducerSuccess.failedGates.some(({ code }) => (
  code === 'compute_oracle_numeric_values_mismatch'
)));
assert.ok(forgedProducerSuccess.failedGates.some(({ code }) => (
  code === 'compute_oracle_producer_expected_values_conflict_with_contract'
)));

const producerOnly = verifyComputeOracleSemantics({
  rawBytes,
  readbackSchema: {
    ...schema,
    expectedOutput: {
      dataType: 'float32',
      values: expectedValues,
      tolerance: 0.00001,
      verified: true,
    },
  },
  observedBinding: binding,
});
assert.equal(producerOnly.accepted, false);
assert.ok(producerOnly.failedGates.some(({ code }) => (
  code === 'compute_oracle_expected_output_contract_missing'
)));

const reboundContract = buildComputeExpectedOutputContract({
  ...contract,
  binding: { ...binding, editId: 'edit:rebound-after-dispatch' },
});
const rebound = verifyComputeOracleSemantics({
  rawBytes,
  readbackSchema: schema,
  expectedOutputContract: reboundContract,
  observedBinding: binding,
});
assert.equal(rebound.accepted, false);
assert.ok(rebound.failedGates.some(({ code }) => code === 'compute_oracle_binding_edit_id_mismatch'));

const exactContract = buildComputeExpectedOutputContract({
  comparisonMode: 'exact_bytes',
  dtype: 'u8',
  shape: [rawBytes.length],
  elementCount: rawBytes.length,
  byteOrder: 'not_applicable',
  expectedRawHash: sha256(rawBytes),
  binding,
  evidenceRefs: ['contract:pre-dispatch-exact-self-check'],
});
const exact = verifyComputeOracleSemantics({
  rawBytes,
  readbackSchema: {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v1',
    dataType: 'uint8',
    elementCount: rawBytes.length,
    byteLength: rawBytes.length,
    rawReadbackHash: sha256(rawBytes),
  },
  expectedOutputContract: exactContract,
  observedBinding: binding,
});
assert.equal(exact.accepted, true, JSON.stringify(exact.failedGates));

const staleContract = structuredClone(contract);
staleContract.expectedValues[0] = 99;
const stale = verifyComputeOracleSemantics({
  rawBytes,
  readbackSchema: schema,
  expectedOutputContract: staleContract,
  observedBinding: binding,
});
assert.equal(stale.accepted, false);
assert.ok(stale.failedGates.some(({ code }) => (
  code === 'compute_oracle_expected_output_contract_expected_values_hash_mismatch'
)));
assert.ok(stale.failedGates.some(({ code }) => (
  code === 'compute_oracle_expected_output_contract_hash_mismatch'
)));

const int64Values = ['-9007199254740993', '9007199254740993'];
const int64Bytes = Buffer.alloc(int64Values.length * 8);
int64Values.forEach((value, index) => int64Bytes.writeBigInt64LE(BigInt(value), index * 8));
const int64Contract = buildComputeExpectedOutputContract({
  comparisonMode: 'numeric_tolerance',
  dtype: 'int64',
  shape: [int64Values.length],
  elementCount: int64Values.length,
  byteOrder: 'little_endian',
  expectedValues: int64Values,
  binding,
  evidenceRefs: ['contract:pre-dispatch-int64-self-check'],
});
const int64 = verifyComputeOracleSemantics({
  rawBytes: int64Bytes,
  readbackSchema: {
    schemaVersion: 'synthi.gpu.hmr.compute_readback_schema.v2',
    dtype: { name: 'i64', byteWidth: 8 },
    shape: [int64Values.length],
    elementCount: int64Values.length,
    byteLength: int64Bytes.length,
    byteOrder: 'little_endian',
    rawReadbackHash: sha256(int64Bytes),
  },
  expectedOutputContract: int64Contract,
  observedBinding: binding,
});
assert.equal(int64.accepted, true, JSON.stringify(int64.failedGates));

console.log(JSON.stringify({
  ok: true,
  acceptedContractHash: accepted.expectedOutputContractHash,
  forgedProducerSuccessRejected: true,
  producerOnlySuccessRejected: true,
  reboundContractRejected: true,
  exactBytesAccepted: true,
  staleContractRejected: true,
  losslessInt64Accepted: true,
}, null, 2));
