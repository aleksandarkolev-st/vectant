import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  COMPUTE_EXPECTED_OUTPUT_CONTRACT_V2_SCHEMA_VERSION,
  COMPUTE_EXPECTED_OUTPUT_DERIVATION_SCHEMA_VERSION,
  COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
  COMPUTE_ORACLE_SEMANTIC_VERIFICATION_AUTHORITY,
  buildComputeExpectedOutputContract,
  computeExpectedOutputContractV2Hash,
  computeExpectedOutputSemanticsHash,
  computeExpectedOutputValuesHash,
  deriveComputeExpectedOutputContractV2,
  validateComputeExpectedOutputContractV2,
  validateComputeExpectedOutputSemantics,
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
  artifactAfterHash: `artifact:${sha256(Buffer.from('artifact-after'))}`,
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

const exactV2Semantics = {
  schemaVersion: COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
  comparisonMode: 'exact_bytes',
  outputTargetId: 'output:tensor:0',
  byteOffset: 64,
  byteLength: 16,
  dtype: 'u32',
  shape: [2, 2],
  elementCount: 4,
  byteOrder: 'little_endian',
  toleranceDecimal: '0',
  expectedValuesDecimal: null,
  expectedValuesHash: null,
  expectedRawHash: `sha256:${'a'.repeat(64)}`,
  semanticsHash: 'sha256:cd7074de01fc4bc0fb0eab922f457e4499c886128cadff30232b7e5f6df3bdde',
};
assert.equal(
  computeExpectedOutputSemanticsHash(exactV2Semantics),
  exactV2Semantics.semanticsHash,
);
assert.equal(validateComputeExpectedOutputSemantics(exactV2Semantics).accepted, true);

const numericV2Values = ['0.125', '-3.5', '12', '0'];
const numericV2Semantics = {
  schemaVersion: COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
  comparisonMode: 'numeric_tolerance',
  outputTargetId: 'output:activation:final',
  byteOffset: 0,
  byteLength: 16,
  dtype: 'f32',
  shape: [4],
  elementCount: 4,
  byteOrder: 'little_endian',
  toleranceDecimal: '0.001',
  expectedValuesDecimal: numericV2Values,
  expectedValuesHash: 'sha256:e793fbfcf7ce664e5632eaeee3e79cfd1fde4ee4a9db0ff6556647076f036450',
  expectedRawHash: null,
  semanticsHash: 'sha256:c35711fc5f51ee39096b85a00b41df7a83d07dac706fc132dfe93719fba58c32',
};
assert.equal(
  computeExpectedOutputValuesHash(numericV2Values),
  numericV2Semantics.expectedValuesHash,
);
assert.equal(
  computeExpectedOutputSemanticsHash(numericV2Semantics),
  numericV2Semantics.semanticsHash,
);
const numericV2Validation = validateComputeExpectedOutputSemantics(numericV2Semantics);
assert.equal(numericV2Validation.accepted, true);
assert.equal(Object.isFrozen(numericV2Validation.value.expectedValuesDecimal), true);

function v2Binding(outputTargetId) {
  return {
    projectId: 'project:generic',
    editId: 'source-edit:generic',
    artifactAfterHash: `sha256:${'b'.repeat(64)}`,
    outputTargetId,
    oracleCodeHash: `sha256:${'c'.repeat(64)}`,
    compileTransportNonce: 'gpu-proof-transport-request:0123456789abcdef0123456789abcdef',
    runtimeSessionId: 'runtime-session:generic',
  };
}

const exactV2Contract = deriveComputeExpectedOutputContractV2(
  exactV2Semantics,
  v2Binding(exactV2Semantics.outputTargetId),
);
assert.equal(exactV2Contract.schemaVersion, COMPUTE_EXPECTED_OUTPUT_CONTRACT_V2_SCHEMA_VERSION);
assert.equal(
  exactV2Contract.derivationSchemaVersion,
  COMPUTE_EXPECTED_OUTPUT_DERIVATION_SCHEMA_VERSION,
);
assert.equal(
  exactV2Contract.contractHash,
  'sha256:25324a3665869f50e1163acbaf601322fb6fa63c1609876180f99a8bb837d748',
);
assert.equal(validateComputeExpectedOutputContractV2(exactV2Contract).accepted, true);
assert.equal(Object.isFrozen(exactV2Contract), true);
assert.equal(Object.isFrozen(exactV2Contract.binding), true);

const numericV2Contract = deriveComputeExpectedOutputContractV2(
  numericV2Semantics,
  v2Binding(numericV2Semantics.outputTargetId),
);
assert.equal(
  numericV2Contract.contractHash,
  'sha256:4e164b0c64e6235260a70ebd0fb45be6a9ea1cb19c5c06a6c3c699851be34547',
);
assert.equal(validateComputeExpectedOutputContractV2(numericV2Contract).accepted, true);

const crossTargetV2 = structuredClone(exactV2Contract);
crossTargetV2.binding.outputTargetId = 'output:other';
crossTargetV2.contractHash = computeExpectedOutputContractV2Hash(crossTargetV2);
assert.equal(validateComputeExpectedOutputContractV2(crossTargetV2).accepted, false);

const invalidNonceV2 = structuredClone(exactV2Contract);
invalidNonceV2.binding.compileTransportNonce = 'fixture-nonce';
invalidNonceV2.contractHash = computeExpectedOutputContractV2Hash(invalidNonceV2);
assert.equal(validateComputeExpectedOutputContractV2(invalidNonceV2).accepted, false);

const aliasedV2 = structuredClone(exactV2Contract);
aliasedV2.schema_version = aliasedV2.schemaVersion;
assert.equal(validateComputeExpectedOutputContractV2(aliasedV2).accepted, false);

const scalarV2 = structuredClone(exactV2Semantics);
scalarV2.byteOffset = 128;
scalarV2.byteLength = 4;
scalarV2.shape = [];
scalarV2.elementCount = 1;
scalarV2.semanticsHash = computeExpectedOutputSemanticsHash(scalarV2);
const scalarValidation = validateComputeExpectedOutputSemantics(scalarV2);
assert.equal(scalarValidation.accepted, true);
assert.deepEqual(scalarValidation.value.shape, []);
assert.equal(Object.isFrozen(scalarValidation.value), true);
assert.equal(Object.isFrozen(scalarValidation.value.shape), true);

const overflowV2 = structuredClone(exactV2Semantics);
overflowV2.byteOffset = Number.MAX_SAFE_INTEGER - 15;
overflowV2.semanticsHash = computeExpectedOutputSemanticsHash(overflowV2);
assert.equal(validateComputeExpectedOutputSemantics(overflowV2).accepted, false);

const nonCanonicalDecimalV2 = structuredClone(numericV2Semantics);
nonCanonicalDecimalV2.expectedValuesDecimal[0] = '0.1250';
nonCanonicalDecimalV2.expectedValuesHash = computeExpectedOutputValuesHash(
  nonCanonicalDecimalV2.expectedValuesDecimal,
);
nonCanonicalDecimalV2.semanticsHash = computeExpectedOutputSemanticsHash(nonCanonicalDecimalV2);
assert.equal(validateComputeExpectedOutputSemantics(nonCanonicalDecimalV2).accepted, false);

const integerOverflowV2 = structuredClone(numericV2Semantics);
integerOverflowV2.dtype = 'u8';
integerOverflowV2.byteLength = 4;
integerOverflowV2.byteOrder = 'not_applicable';
integerOverflowV2.expectedValuesDecimal = ['256', '1', '2', '3'];
integerOverflowV2.expectedValuesHash = computeExpectedOutputValuesHash(
  integerOverflowV2.expectedValuesDecimal,
);
integerOverflowV2.semanticsHash = computeExpectedOutputSemanticsHash(integerOverflowV2);
assert.equal(validateComputeExpectedOutputSemantics(integerOverflowV2).accepted, false);

for (const rejectedF32 of [
  '0.00000000000000000000000000000000000000000000070064923216240857435571027827709373529053130706403438956761',
  '340282356779733661637539395458142568448',
]) {
  const boundaryV2 = structuredClone(numericV2Semantics);
  boundaryV2.expectedValuesDecimal = [rejectedF32, '1', '2', '3'];
  boundaryV2.expectedValuesHash = computeExpectedOutputValuesHash(boundaryV2.expectedValuesDecimal);
  boundaryV2.semanticsHash = computeExpectedOutputSemanticsHash(boundaryV2);
  assert.equal(validateComputeExpectedOutputSemantics(boundaryV2).accepted, false);
}

for (const acceptedF32 of [
  '0.000000000000000000000000000000000000000000001',
  '340282346638528859811704183484516925440',
]) {
  const boundaryV2 = structuredClone(numericV2Semantics);
  boundaryV2.expectedValuesDecimal = [acceptedF32, '1', '2', '3'];
  boundaryV2.expectedValuesHash = computeExpectedOutputValuesHash(boundaryV2.expectedValuesDecimal);
  boundaryV2.semanticsHash = computeExpectedOutputSemanticsHash(boundaryV2);
  assert.equal(validateComputeExpectedOutputSemantics(boundaryV2).accepted, true);
}

const missingBindingV2 = structuredClone(exactV2Contract);
delete missingBindingV2.binding.runtimeSessionId;
missingBindingV2.contractHash = computeExpectedOutputContractV2Hash(missingBindingV2);
assert.equal(validateComputeExpectedOutputContractV2(missingBindingV2).accepted, false);

const extraSemanticsFieldV2 = structuredClone(exactV2Semantics);
extraSemanticsFieldV2.profile = 'not-authority';
extraSemanticsFieldV2.semanticsHash = computeExpectedOutputSemanticsHash(extraSemanticsFieldV2);
assert.equal(validateComputeExpectedOutputSemantics(extraSemanticsFieldV2).accepted, false);

let accessorCalled = false;
const accessorV2 = structuredClone(exactV2Semantics);
Object.defineProperty(accessorV2, 'outputTargetId', {
  enumerable: true,
  get() {
    accessorCalled = true;
    return 'output:changed';
  },
});
assert.equal(validateComputeExpectedOutputSemantics(accessorV2).accepted, false);
assert.equal(accessorCalled, false);

Object.prototype.inheritedFourByteDtype = 4;
try {
  const inheritedDtypeV2 = structuredClone(exactV2Semantics);
  inheritedDtypeV2.dtype = 'inheritedFourByteDtype';
  inheritedDtypeV2.semanticsHash = computeExpectedOutputSemanticsHash(inheritedDtypeV2);
  assert.equal(validateComputeExpectedOutputSemantics(inheritedDtypeV2).accepted, false);
} finally {
  delete Object.prototype.inheritedFourByteDtype;
}

console.log(JSON.stringify({
  ok: true,
  acceptedContractHash: accepted.expectedOutputContractHash,
  forgedProducerSuccessRejected: true,
  producerOnlySuccessRejected: true,
  reboundContractRejected: true,
  exactBytesAccepted: true,
  staleContractRejected: true,
  losslessInt64Accepted: true,
  v2CrossLanguageGoldenVectorsAccepted: true,
  v2CrossTargetSubstitutionRejected: true,
  v2InvalidNonceRejected: true,
  v2AliasRejected: true,
  v2ScalarAndBoundsVerified: true,
  v2NonCanonicalDecimalRejected: true,
  v2NumericBoundsVerified: true,
  v2MissingBindingRejected: true,
  v2ExtraFieldRejected: true,
  v2AccessorRejectedWithoutEvaluation: true,
  v2InheritedDtypeRejected: true,
}, null, 2));
