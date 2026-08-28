import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  ARBITRARY_COLD_PROJECT_CONTRACT_AUTHORITY,
  ARBITRARY_COLD_PROJECT_CONTRACT_RECEIPT_AUTHORITY,
  ARBITRARY_COLD_PROJECT_CONTRACT_RECEIPT_SCHEMA,
  ARBITRARY_COLD_PROJECT_CONTRACT_SCHEMA,
  createArbitraryColdProjectContract,
  createArbitraryColdProjectContractReceipt,
  verifyArbitraryColdProjectContract,
  verifyArbitraryColdProjectContractReceipt,
  verifyRetainedArbitraryColdProjectContract,
} from '../lib/gpu-hmr-arbitrary-cold-project-contract.mjs';

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resealEvidence(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  value.evidenceHash = `sha256:${createHash('sha256')
    .update(stableJson(projection))
    .digest('hex')}`;
}

const base = {
  sourceBindingHash: `sha256:${'1'.repeat(64)}`,
  readOnlyInputs: [
    { mountPath: 'toolchain headers', sourceBindingHash: `sha256:${'3'.repeat(64)}` },
    { mountPath: 'vendor/source', sourceBindingHash: `sha256:${'4'.repeat(64)}` },
  ],
  workerImageId: `sha256:${'2'.repeat(64)}`,
  workerImageOperatingSystem: 'provider-defined-os/future-v7',
  workerImageArchitecture: 'provider-defined-machine/future-v11',
  containerRuntime: 'runc',
  command: '/opaque/tool',
  args: ['--build', 'arbitrary input'],
  environment: { MODE: 'cold', VALUE: 'opaque' },
  workingDirectory: 'nested source',
  outputs: [{
    path: 'build/result.bin',
    role: 'opaque_role',
    artifactKind: 'opaque_kind',
    mediaType: 'application/octet-stream',
  }],
  resources: {
    commandTimeoutMillis: 120_000,
    releaseTimeoutMillis: 60_000,
    workspaceByteLimit: 4 * 1024 * 1024 * 1024,
    workspaceEntryLimit: 250_000,
    collectedByteLimit: 512 * 1024 * 1024,
    collectedEntryLimit: 4096,
    memoryBytes: 8 * 1024 * 1024 * 1024,
    memorySwapBytes: 8 * 1024 * 1024 * 1024,
    nanoCpus: 4_000_000_000,
    pidsLimit: 1024,
    nofileLimit: 4096,
  },
};

const first = createArbitraryColdProjectContract(structuredClone(base));
const second = createArbitraryColdProjectContract(structuredClone(base));
assert.equal(first.schemaVersion, ARBITRARY_COLD_PROJECT_CONTRACT_SCHEMA);
assert.equal(first.proofAuthority, ARBITRARY_COLD_PROJECT_CONTRACT_AUTHORITY);
assert.equal(first.contractHash, second.contractHash);
assert.equal(first.commandSpecHash, second.commandSpecHash);
assert.equal(first.acceptedForGpuHmr, false);
assert.equal(first.gpuHmrSuccess, false);
assert.equal(first.canSatisfyRuntimeProof, false);
assert.equal(first.canSatisfyDispatchProof, false);
assert.equal(first.inputSetBindings.length, 3);
assert.equal(first.inputSetBindings[0].containerPath, '/workspace/inputs/toolchain headers');
assert.equal(first.inputSetBindings[2].containerPath, '/workspace/source');
assert.match(first.inputSetHash, /^sha256:[0-9a-f]{64}$/);
assert.equal(first.outputs[0].metadataAuthority, 'advisory_only_not_output_acceptance');
assert.deepEqual(first.readOnlyInputs.map((entry) => entry.mountPath), [
  'toolchain headers',
  'vendor/source',
]);
assert.equal(verifyArbitraryColdProjectContract(first), first);
const retainedContract = JSON.parse(JSON.stringify(first));
assert.equal(
  verifyRetainedArbitraryColdProjectContract(retainedContract),
  retainedContract,
);
const retainedContractWithUnknownField = structuredClone(retainedContract);
retainedContractWithUnknownField.fixtureName = 'must-not-be-accepted';
assert.throws(
  () => verifyRetainedArbitraryColdProjectContract(retainedContractWithUnknownField),
  /retained_contract_invalid/,
);
const retainedContractWithForgedInput = structuredClone(retainedContract);
retainedContractWithForgedInput.inputSetHash = `sha256:${'0'.repeat(64)}`;
assert.throws(
  () => verifyRetainedArbitraryColdProjectContract(retainedContractWithForgedInput),
  /retained_contract_invalid/,
);
const retainedContractWithAuthorityClaim = structuredClone(retainedContract);
retainedContractWithAuthorityClaim.gpuHmrSuccess = true;
assert.throws(
  () => verifyRetainedArbitraryColdProjectContract(retainedContractWithAuthorityClaim),
  /retained_contract_invalid/,
);

const secretValue = 'contract-secret-value-must-not-be-retained';
const secretArgument = '--credential=argument-secret-must-not-be-retained';
const secretCommand = '/private/command-name-must-not-be-retained';
const secretWorkingDirectory = 'private-working-directory-must-not-be-retained';
const sensitiveContract = createArbitraryColdProjectContract({
  ...structuredClone(base),
  command: secretCommand,
  args: ['--build', secretArgument],
  environment: {
    MODE: 'cold',
    API_TOKEN: secretValue,
  },
  workingDirectory: secretWorkingDirectory,
});
const contractReceipt = createArbitraryColdProjectContractReceipt(sensitiveContract);
const retainedContractReceipt = JSON.parse(JSON.stringify(contractReceipt));
assert.equal(contractReceipt.schemaVersion, ARBITRARY_COLD_PROJECT_CONTRACT_RECEIPT_SCHEMA);
assert.equal(
  contractReceipt.proofAuthority,
  ARBITRARY_COLD_PROJECT_CONTRACT_RECEIPT_AUTHORITY,
);
assert.equal(contractReceipt.plaintextCommandEmbedded, false);
assert.equal(contractReceipt.plaintextArgumentsEmbedded, false);
assert.equal(contractReceipt.plaintextEnvironmentValuesEmbedded, false);
assert.equal(contractReceipt.acceptedAsRetainedContractReceipt, true);
assert.equal(contractReceipt.acceptedAsColdBuildEvidence, false);
assert.equal(contractReceipt.acceptedForGpuHmr, false);
assert.equal(contractReceipt.gpuHmrSuccess, false);
assert.equal(contractReceipt.canSatisfyRuntimeProof, false);
assert.equal(contractReceipt.canSatisfyDispatchProof, false);
assert.equal(
  verifyArbitraryColdProjectContractReceipt(retainedContractReceipt),
  retainedContractReceipt,
);
const serializedContractReceipt = JSON.stringify(contractReceipt);
for (const secret of [
  secretValue,
  secretArgument,
  secretCommand,
  secretWorkingDirectory,
]) {
  assert.equal(serializedContractReceipt.includes(secret), false);
}
assert.throws(
  () => createArbitraryColdProjectContractReceipt(structuredClone(sensitiveContract)),
  /contract_invalid/,
);
const forgedReceiptInputSet = structuredClone(retainedContractReceipt);
forgedReceiptInputSet.inputSetHash = `sha256:${'0'.repeat(64)}`;
resealEvidence(forgedReceiptInputSet);
assert.throws(
  () => verifyArbitraryColdProjectContractReceipt(forgedReceiptInputSet),
  /contract_receipt_invalid/,
);
const forgedReceiptAuthority = structuredClone(retainedContractReceipt);
forgedReceiptAuthority.acceptedAsColdBuildEvidence = true;
forgedReceiptAuthority.acceptedForGpuHmr = true;
forgedReceiptAuthority.gpuHmrSuccess = true;
resealEvidence(forgedReceiptAuthority);
assert.throws(
  () => verifyArbitraryColdProjectContractReceipt(forgedReceiptAuthority),
  /contract_receipt_invalid/,
);

const reorderedInputs = createArbitraryColdProjectContract({
  ...structuredClone(base),
  readOnlyInputs: [...base.readOnlyInputs].reverse(),
});
assert.equal(reorderedInputs.commandSpecHash, first.commandSpecHash);
assert.equal(reorderedInputs.contractHash, first.contractHash);

const changedInput = createArbitraryColdProjectContract({
  ...structuredClone(base),
  readOnlyInputs: [{
    ...base.readOnlyInputs[0],
    sourceBindingHash: `sha256:${'5'.repeat(64)}`,
  }],
});
assert.notEqual(changedInput.commandSpecHash, first.commandSpecHash);
assert.notEqual(changedInput.contractHash, first.contractHash);
assert.notEqual(changedInput.inputSetHash, first.inputSetHash);

const changedOutput = createArbitraryColdProjectContract({
  ...structuredClone(base),
  outputs: [{ ...base.outputs[0], path: 'build/different.bin' }],
});
assert.notEqual(changedOutput.commandSpecHash, first.commandSpecHash);
assert.notEqual(changedOutput.contractHash, first.contractHash);

const clone = structuredClone(first);
assert.throws(() => verifyArbitraryColdProjectContract(clone), /contract_invalid/);
first.acceptedForGpuHmr = true;
assert.throws(() => verifyArbitraryColdProjectContract(first), /contract_invalid/);
first.acceptedForGpuHmr = false;
assert.equal(verifyArbitraryColdProjectContract(first), first);
const inputSetHash = first.inputSetHash;
first.inputSetHash = `sha256:${'0'.repeat(64)}`;
assert.throws(() => verifyArbitraryColdProjectContract(first), /contract_invalid/);
first.inputSetHash = inputSetHash;
assert.equal(verifyArbitraryColdProjectContract(first), first);

assert.throws(
  () => createArbitraryColdProjectContract({ ...structuredClone(base), projectName: 'shortcut' }),
  /shape_invalid/,
);
assert.throws(
  () => createArbitraryColdProjectContract({
    ...structuredClone(base),
    outputs: [{ ...base.outputs[0], path: '../escape.bin' }],
  }),
  /output_path_invalid/,
);
assert.throws(
  () => createArbitraryColdProjectContract({
    ...structuredClone(base),
    outputs: [{ ...base.outputs[0], role: 'x'.repeat(161) }],
  }),
  /output_label_invalid/,
);
assert.throws(
  () => createArbitraryColdProjectContract({
    ...structuredClone(base),
    resources: { ...base.resources, collectedEntryLimit: 1 },
  }),
  /resources_invalid/,
);
assert.throws(
  () => createArbitraryColdProjectContract({
    ...structuredClone(base),
    readOnlyInputs: [{ mountPath: '../escape', sourceBindingHash: `sha256:${'3'.repeat(64)}` }],
  }),
  /read_only_input_mount_path_invalid/,
);
assert.throws(
  () => createArbitraryColdProjectContract({
    ...structuredClone(base),
    readOnlyInputs: [base.readOnlyInputs[0], { ...base.readOnlyInputs[0] }],
  }),
  /read_only_input_overlap/,
);
assert.throws(
  () => createArbitraryColdProjectContract({
    ...structuredClone(base),
    readOnlyInputs: [
      { mountPath: 'vendor', sourceBindingHash: `sha256:${'3'.repeat(64)}` },
      { mountPath: 'vendor/nested', sourceBindingHash: `sha256:${'4'.repeat(64)}` },
    ],
  }),
  /read_only_input_overlap/,
);
assert.throws(
  () => createArbitraryColdProjectContract({
    ...structuredClone(base),
    readOnlyInputs: [{ ...base.readOnlyInputs[0], project: 'shortcut' }],
  }),
  /read_only_input_shape_invalid/,
);
for (const invalidLabel of ['', 'line\nbreak', 'nul\0byte']) {
  assert.throws(
    () => createArbitraryColdProjectContract({
      ...structuredClone(base),
      workerImageArchitecture: invalidLabel,
    }),
    /worker_image_architecture_invalid/,
  );
}
assert.ok(!JSON.stringify(first).match(/miopen|hiprt|flow|diamond|neural|blas|cuda|rocm/i));

console.log(JSON.stringify({
  status: 'self_check_passed',
  schemaVersion: first.schemaVersion,
  contractHash: first.contractHash,
  commandSpecHash: first.commandSpecHash,
  projectNameFieldRejected: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
}, null, 2));
