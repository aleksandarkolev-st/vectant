import { createHash } from 'node:crypto';
import path from 'node:path';

import {
  createArbitraryColdProjectContractReceipt,
  verifyArbitraryColdProjectContract,
  verifyArbitraryColdProjectContractReceipt,
} from './gpu-hmr-arbitrary-cold-project-contract.mjs';
import {
  COLD_BUILD_LAUNCHER_INPUT_ROOT,
  createColdBuildLauncherIdentityReceipt,
  verifyColdBuildLauncherIdentityReceipt,
} from './gpu-hmr-cold-build-container-contract.mjs';
import {
  createColdBuildOutputEvidenceReceipt,
  verifyColdBuildOutputEvidenceReceipt,
} from './gpu-hmr-cold-build-output-evidence.mjs';
import {
  createColdBuildSourceTreeSnapshotReceipt,
  verifyColdBuildSourceTreeSnapshotReceipt,
} from './gpu-hmr-cold-build-source-tree-binding.mjs';
import {
  verifyImmutableColdBuildWorkerImage,
  verifyRetainedImmutableColdBuildWorkerImage,
} from './gpu-hmr-cold-build-worker-image.mjs';

export const ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_retained_execution_chain.v1';
export const ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_AUTHORITY =
  'serialized_execution_chain_integrity_only_not_authenticity_or_gpu_hmr_success';

const ARBITRARY_COLD_PROJECT_RUN_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_run.v1';
const ARBITRARY_COLD_PROJECT_RUN_AUTHORITY =
  'orchestrated_cold_build_evidence_only_not_gpu_hmr_success';
const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^artifact:sha256:[a-f0-9]{64}$/;
const TRANSPORT_KIND_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const RUN_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'descriptorHash',
  'sourcePathIdentityHash',
  'sourceBindingHash',
  'sourceTreeBindingEvidenceHash',
  'sourceSnapshotEvidenceHash',
  'inputSetBindings',
  'inputSetHash',
  'readOnlyInputBindings',
  'readOnlyInputBindingSetHash',
  'readOnlyInputSnapshotBindings',
  'readOnlyInputSnapshotSetHash',
  'readOnlyInputCount',
  'readOnlyInputEntryCount',
  'readOnlyInputByteLength',
  'workerImageEvidenceHash',
  'workerImageId',
  'contractHash',
  'commandSpecHash',
  'launcherExecutableHash',
  'planHash',
  'driverExecutionEvidenceHash',
  'outputEvidenceHash',
  'outputSetHash',
  'outputContractHash',
  'artifactSessionRootIdentityHash',
  'artifactLocatorSetHash',
  'artifactCount',
  'timings',
  'coldBuildSucceeded',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);
const TIMING_KEYS = Object.freeze([
  'metricClock',
  'metricScope',
  'artifactRootValidationNanos',
  'imageInspectionNanos',
  'sourceBindingNanos',
  'readOnlyInputBindingNanos',
  'launcherMaterializationNanos',
  'executionNanos',
  'outputEvidenceNanos',
  'artifactPersistenceNanos',
  'totalRunnerWallNanos',
]);
const READ_ONLY_RECEIPT_KEYS = Object.freeze(['mountPath', 'snapshotReceipt']);
const ARTIFACT_BINDING_KEYS = Object.freeze([
  'path',
  'contentHash',
  'byteLength',
  'artifactId',
  'manifestHash',
  'transportKind',
]);
const CHAIN_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'descriptorHash',
  'sourceSnapshotReceipt',
  'readOnlyInputSnapshotReceipts',
  'workerImageReference',
  'workerImageEvidence',
  'contractReceipt',
  'launcherIdentityReceipt',
  'outputEvidenceReceipt',
  'runEvidence',
  'artifactLocatorBindings',
  'externalAuthenticityAnchorEmbedded',
  'acceptedAsRetainedColdExecutionChain',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function contentHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function recomputeEvidenceHash(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function byteOrder(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function supportFlagsAreFalse(value) {
  return value?.acceptedForGpuHmr === false
    && value?.gpuHmrSuccess === false
    && value?.canSatisfyRuntimeProof === false
    && value?.canSatisfyDispatchProof === false;
}

function normalizeMountPath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || Buffer.byteLength(value, 'utf8') > 1024
    || /[\\\0\r\n]/.test(value)
  ) {
    throw new Error('arbitrary_cold_retained_chain_mount_path_invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw new Error('arbitrary_cold_retained_chain_mount_path_invalid');
  }
  return normalized;
}

function artifactLocatorBindings(outputs) {
  if (!Array.isArray(outputs) || outputs.length < 1 || outputs.length > 100_000) {
    throw new Error('arbitrary_cold_retained_chain_artifacts_invalid');
  }
  const bindings = outputs.map((output) => ({
    path: output?.metadata?.path,
    contentHash: output?.artifactLocator?.contentHash,
    byteLength: output?.artifactLocator?.byteLength,
    artifactId: output?.artifactLocator?.artifactId,
    manifestHash: output?.artifactLocator?.manifestHash,
    transportKind: output?.artifactLocator?.transport?.kind,
  })).sort((left, right) => byteOrder(left.path ?? '', right.path ?? ''));
  if (!artifactBindingsAccepted(bindings)) {
    throw new Error('arbitrary_cold_retained_chain_artifacts_invalid');
  }
  return bindings;
}

function artifactBindingsAccepted(bindings) {
  if (!Array.isArray(bindings) || bindings.length < 1 || bindings.length > 100_000) {
    return false;
  }
  let previousPath = null;
  return bindings.every((binding) => {
    const accepted = exactKeys(binding, ARTIFACT_BINDING_KEYS)
      && typeof binding.path === 'string'
      && binding.path.length > 0
      && Buffer.byteLength(binding.path, 'utf8') <= 32 * 1024
      && !/[\\\0\r\n]/.test(binding.path)
      && path.posix.normalize(binding.path) === binding.path
      && binding.path !== '.'
      && !binding.path.startsWith('../')
      && !path.posix.isAbsolute(binding.path)
      && !path.win32.isAbsolute(binding.path)
      && SHA256_PATTERN.test(binding.contentHash ?? '')
      && Number.isSafeInteger(binding.byteLength)
      && binding.byteLength >= 0
      && ARTIFACT_ID_PATTERN.test(binding.artifactId ?? '')
      && binding.artifactId === `artifact:${binding.contentHash}`
      && SHA256_PATTERN.test(binding.manifestHash ?? '')
      && TRANSPORT_KIND_PATTERN.test(binding.transportKind ?? '')
      && (previousPath === null || byteOrder(previousPath, binding.path) < 0);
    previousPath = binding.path;
    return accepted;
  });
}

function contractOutputProjection(contractReceipt) {
  return contractReceipt.outputs.map((output) => ({
    path: output.path,
    declaredRole: output.role,
    declaredArtifactKind: output.artifactKind,
    declaredMediaType: output.mediaType,
  })).sort((left, right) => byteOrder(left.path, right.path));
}

function contractResourcePolicyProjection(resources) {
  return {
    memoryBytes: resources.memoryBytes,
    memorySwapBytes: resources.memorySwapBytes,
    nanoCpus: resources.nanoCpus,
    pidsLimit: resources.pidsLimit,
    nofileLimit: resources.nofileLimit,
    workspaceByteLimit: resources.workspaceByteLimit,
    workspaceEntryLimit: resources.workspaceEntryLimit,
    collectedByteLimit: resources.collectedByteLimit,
    collectedEntryLimit: resources.collectedEntryLimit,
  };
}

function observedOutputProjection(outputEvidence) {
  return outputEvidence.outputs.map((output) => ({
    path: output.path,
    declaredRole: output.declaredRole,
    declaredArtifactKind: output.declaredArtifactKind,
    declaredMediaType: output.declaredMediaType,
  })).sort((left, right) => byteOrder(left.path, right.path));
}

function readOnlyProjections(entries) {
  const runBindings = [];
  const snapshotBindings = [];
  const contractBindings = [];
  const planTreeBindings = [];
  let entryCount = 0;
  let byteLength = 0;
  for (const entry of entries) {
    const receipt = entry.snapshotReceipt;
    const sourceBinding = receipt.sourceTreeBindingEvidence;
    const snapshotBinding = receipt.snapshotTreeBindingEvidence;
    runBindings.push({
      mountPath: entry.mountPath,
      sourceBindingHash: sourceBinding.sourceBindingHash,
      sourceTreeBindingEvidenceHash: sourceBinding.evidenceHash,
      entryCount: sourceBinding.entryCount,
      totalByteLength: sourceBinding.totalByteLength,
    });
    snapshotBindings.push({
      mountPath: entry.mountPath,
      snapshotEvidenceHash: receipt.snapshotEvidence.evidenceHash,
    });
    contractBindings.push({
      mountPath: entry.mountPath,
      sourceBindingHash: sourceBinding.sourceBindingHash,
    });
    planTreeBindings.push({
      mountPath: entry.mountPath,
      containerPath: path.posix.join(COLD_BUILD_LAUNCHER_INPUT_ROOT, entry.mountPath),
      sourceBindingHash: snapshotBinding.sourceBindingHash,
      sourceTreeBindingEvidenceHash: snapshotBinding.evidenceHash,
      hostPathIdentityHash: receipt.snapshotEvidence.snapshotPathIdentityHash,
    });
    entryCount += sourceBinding.entryCount;
    byteLength += sourceBinding.totalByteLength;
    if (!Number.isSafeInteger(entryCount) || !Number.isSafeInteger(byteLength)) {
      throw new Error('arbitrary_cold_retained_chain_read_only_aggregate_invalid');
    }
  }
  return {
    runBindings,
    snapshotBindings,
    contractBindings: [...contractBindings].sort(
      (left, right) => byteOrder(left.mountPath, right.mountPath),
    ),
    planTreeBindings: [...planTreeBindings].sort(
      (left, right) => left.mountPath.localeCompare(right.mountPath),
    ),
    entryCount,
    byteLength,
  };
}

function runEvidenceAccepted(chain) {
  const run = chain.runEvidence;
  const sourceReceipt = chain.sourceSnapshotReceipt;
  const sourceBinding = sourceReceipt.sourceTreeBindingEvidence;
  const snapshotBinding = sourceReceipt.snapshotTreeBindingEvidence;
  const contractReceipt = chain.contractReceipt;
  const worker = chain.workerImageEvidence;
  const launcher = chain.launcherIdentityReceipt;
  const outputReceipt = chain.outputEvidenceReceipt;
  const driverReceipt = outputReceipt.executionDriverReceipt;
  const planReceipt = driverReceipt.executionPlanReceipt;
  const plan = planReceipt.planProjection;
  const driver = driverReceipt.driverEvidence;
  const output = outputReceipt.outputEvidence;
  const observedOutputsByPath = [...output.outputs].sort(
    (left, right) => byteOrder(left.path, right.path),
  );
  let readOnly;
  try {
    readOnly = readOnlyProjections(chain.readOnlyInputSnapshotReceipts);
  } catch {
    return false;
  }
  const expectedOutputContract = contractOutputProjection(contractReceipt);
  const observedOutputContract = observedOutputProjection(output);
  const totalRunnerWallNanos = run?.timings?.totalRunnerWallNanos;
  return exactKeys(run, RUN_EVIDENCE_KEYS)
    && run.schemaVersion === ARBITRARY_COLD_PROJECT_RUN_SCHEMA
    && run.proofAuthority === ARBITRARY_COLD_PROJECT_RUN_AUTHORITY
    && run.descriptorHash === chain.descriptorHash
    && run.sourcePathIdentityHash === sourceReceipt.snapshotEvidence.sourcePathIdentityHash
    && run.sourceBindingHash === sourceBinding.sourceBindingHash
    && run.sourceTreeBindingEvidenceHash === sourceBinding.evidenceHash
    && run.sourceSnapshotEvidenceHash === sourceReceipt.snapshotEvidence.evidenceHash
    && stableJson(run.inputSetBindings) === stableJson(contractReceipt.inputSetBindings)
    && run.inputSetHash === contractReceipt.inputSetHash
    && stableJson(run.readOnlyInputBindings) === stableJson(readOnly.runBindings)
    && run.readOnlyInputBindingSetHash === contentHash(stableJson(readOnly.runBindings))
    && stableJson(run.readOnlyInputSnapshotBindings)
      === stableJson(readOnly.snapshotBindings)
    && run.readOnlyInputSnapshotSetHash
      === contentHash(stableJson(readOnly.snapshotBindings))
    && run.readOnlyInputCount === chain.readOnlyInputSnapshotReceipts.length
    && run.readOnlyInputEntryCount === readOnly.entryCount
    && run.readOnlyInputByteLength === readOnly.byteLength
    && stableJson(contractReceipt.readOnlyInputs) === stableJson(readOnly.contractBindings)
    && run.workerImageEvidenceHash === worker.evidence.evidenceHash
    && run.workerImageId === worker.descriptor.imageId
    && contractReceipt.workerImageId === worker.descriptor.imageId
    && contractReceipt.workerImageOperatingSystem === worker.descriptor.operatingSystem
    && contractReceipt.workerImageArchitecture === worker.descriptor.architecture
    && launcher.architecture === worker.descriptor.architecture
    && run.contractHash === contractReceipt.contractHash
    && run.commandSpecHash === contractReceipt.commandSpecHash
    && plan.commandSpecHash === contractReceipt.commandSpecHash
    && plan.sourceBindingHash === snapshotBinding.sourceBindingHash
    && plan.sourceTreeBindingEvidenceHash === snapshotBinding.evidenceHash
    && plan.sourcePathIdentityHash === sourceReceipt.snapshotEvidence.snapshotPathIdentityHash
    && stableJson(plan.inputSetBindings) === stableJson(contractReceipt.inputSetBindings)
    && plan.inputSetHash === contractReceipt.inputSetHash
    && plan.readOnlyInputTreesHash === contentHash(stableJson(readOnly.planTreeBindings))
    && plan.workerImageId === worker.descriptor.imageId
    && plan.workerImageOperatingSystem === worker.descriptor.operatingSystem
    && plan.workerImageArchitecture === worker.descriptor.architecture
    && plan.commandHash === contractReceipt.commandInvocationHash
    && plan.environmentHash === contractReceipt.environmentEntrySetHash
    && stableJson(plan.resourcePolicy)
      === stableJson(contractResourcePolicyProjection(contractReceipt.resources))
    && plan.expectedContainerConfiguration?.runtime === contractReceipt.containerRuntime
    && plan.launcherExecutableHash === launcher.binaryHash
    && plan.launcherBuildEvidenceHash === launcher.buildEvidence.evidenceHash
    && run.launcherExecutableHash === launcher.binaryHash
    && run.planHash === planReceipt.planHash
    && run.driverExecutionEvidenceHash === driver.evidenceHash
    && run.outputEvidenceHash === output.evidenceHash
    && run.outputSetHash === output.outputSetHash
    && stableJson(expectedOutputContract) === stableJson(observedOutputContract)
    && run.outputContractHash === contentHash(stableJson(expectedOutputContract))
    && artifactBindingsAccepted(chain.artifactLocatorBindings)
    && run.artifactLocatorSetHash === contentHash(stableJson(chain.artifactLocatorBindings))
    && run.artifactCount === chain.artifactLocatorBindings.length
    && chain.artifactLocatorBindings.length === output.outputs.length
    && chain.artifactLocatorBindings.every((binding, index) => {
      const observed = observedOutputsByPath[index];
      return binding.path === observed.path
        && binding.contentHash === observed.observedContentHash
        && binding.byteLength === observed.observedByteLength;
    })
    && SHA256_PATTERN.test(run.artifactSessionRootIdentityHash ?? '')
    && exactKeys(run.timings, TIMING_KEYS)
    && run.timings.metricClock === 'monotonic_ns'
    && run.timings.metricScope === 'cold'
    && Number.isSafeInteger(totalRunnerWallNanos)
    && totalRunnerWallNanos >= 0
    && TIMING_KEYS.filter((name) => name.endsWith('Nanos')).every((name) => (
      Number.isSafeInteger(run.timings[name])
      && run.timings[name] >= 0
      && run.timings[name] <= totalRunnerWallNanos
    ))
    && run.coldBuildSucceeded === true
    && run.acceptedAsColdBuildEvidence === true
    && supportFlagsAreFalse(run)
    && SHA256_PATTERN.test(run.evidenceHash ?? '')
    && run.evidenceHash === recomputeEvidenceHash(run);
}

export function createArbitraryColdRetainedExecutionChain({
  descriptorHash,
  sourceSnapshot,
  readOnlyInputSnapshots = [],
  workerImageReference,
  workerImage,
  contract,
  launcherIdentity,
  outputEvidence,
  driverResult,
  plan,
  runEvidence,
  outputs,
} = {}) {
  if (!SHA256_PATTERN.test(descriptorHash ?? '')) {
    throw new Error('arbitrary_cold_retained_chain_descriptor_hash_invalid');
  }
  verifyImmutableColdBuildWorkerImage(workerImage, workerImageReference);
  verifyArbitraryColdProjectContract(contract);
  const sourceSnapshotReceipt = createColdBuildSourceTreeSnapshotReceipt(sourceSnapshot);
  const readOnlyInputSnapshotReceipts = readOnlyInputSnapshots.map((input) => ({
    mountPath: normalizeMountPath(input?.mountPath),
    snapshotReceipt: createColdBuildSourceTreeSnapshotReceipt(input?.snapshot),
  }));
  const chain = {
    schemaVersion: ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_SCHEMA,
    proofAuthority: ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_AUTHORITY,
    descriptorHash,
    sourceSnapshotReceipt,
    readOnlyInputSnapshotReceipts,
    workerImageReference,
    workerImageEvidence: structuredClone(workerImage),
    contractReceipt: createArbitraryColdProjectContractReceipt(contract),
    launcherIdentityReceipt: createColdBuildLauncherIdentityReceipt(launcherIdentity),
    outputEvidenceReceipt: createColdBuildOutputEvidenceReceipt(
      outputEvidence,
      driverResult,
      plan,
    ),
    runEvidence: structuredClone(runEvidence),
    artifactLocatorBindings: artifactLocatorBindings(outputs),
    externalAuthenticityAnchorEmbedded: false,
    acceptedAsRetainedColdExecutionChain: true,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  chain.evidenceHash = recomputeEvidenceHash(chain);
  verifyArbitraryColdRetainedExecutionChain(chain);
  return chain;
}

export function verifyArbitraryColdRetainedExecutionChain(chain) {
  try {
    verifyColdBuildSourceTreeSnapshotReceipt(chain?.sourceSnapshotReceipt);
    for (const entry of chain?.readOnlyInputSnapshotReceipts ?? []) {
      if (!exactKeys(entry, READ_ONLY_RECEIPT_KEYS)) {
        throw new Error('read_only_receipt_shape_invalid');
      }
      normalizeMountPath(entry.mountPath);
      verifyColdBuildSourceTreeSnapshotReceipt(entry.snapshotReceipt);
    }
    verifyRetainedImmutableColdBuildWorkerImage(
      chain?.workerImageEvidence,
      chain?.workerImageReference,
    );
    verifyArbitraryColdProjectContractReceipt(chain?.contractReceipt);
    verifyColdBuildLauncherIdentityReceipt(chain?.launcherIdentityReceipt);
    verifyColdBuildOutputEvidenceReceipt(chain?.outputEvidenceReceipt);
  } catch {
    throw new Error('arbitrary_cold_retained_execution_chain_invalid');
  }
  const readOnlyEntries = chain.readOnlyInputSnapshotReceipts;
  if (
    !exactKeys(chain, CHAIN_KEYS)
    || chain.schemaVersion !== ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_SCHEMA
    || chain.proofAuthority !== ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_AUTHORITY
    || !SHA256_PATTERN.test(chain.descriptorHash ?? '')
    || !Array.isArray(readOnlyEntries)
    || readOnlyEntries.length > 128
    || new Set(readOnlyEntries.map((entry) => entry.mountPath)).size !== readOnlyEntries.length
    || !artifactBindingsAccepted(chain.artifactLocatorBindings)
    || !runEvidenceAccepted(chain)
    || chain.externalAuthenticityAnchorEmbedded !== false
    || chain.acceptedAsRetainedColdExecutionChain !== true
    || chain.acceptedAsColdBuildEvidence !== false
    || !supportFlagsAreFalse(chain)
    || !SHA256_PATTERN.test(chain.evidenceHash ?? '')
    || chain.evidenceHash !== recomputeEvidenceHash(chain)
  ) {
    throw new Error('arbitrary_cold_retained_execution_chain_invalid');
  }
  return chain;
}
