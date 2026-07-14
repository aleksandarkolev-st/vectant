import assert from 'node:assert/strict';

import {
  ARBITRARY_COLD_PROJECT_CONTRACT_AUTHORITY,
  ARBITRARY_COLD_PROJECT_CONTRACT_SCHEMA,
  createArbitraryColdProjectContract,
  verifyArbitraryColdProjectContract,
} from '../lib/gpu-hmr-arbitrary-cold-project-contract.mjs';

const base = {
  sourceBindingHash: `sha256:${'1'.repeat(64)}`,
  workerImageId: `sha256:${'2'.repeat(64)}`,
  workerImageOperatingSystem: 'linux',
  workerImageArchitecture: 'amd64',
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
assert.equal(first.outputs[0].metadataAuthority, 'advisory_only_not_output_acceptance');
assert.equal(verifyArbitraryColdProjectContract(first), first);

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
