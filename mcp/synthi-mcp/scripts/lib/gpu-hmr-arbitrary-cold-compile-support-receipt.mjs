import { createHash } from 'node:crypto';

import { verifyArbitraryColdProjectRun } from '../gpu-hmr-arbitrary-cold-project-runner.mjs';
import { validateArtifactCasManifest } from './gpu-hmr-artifact-cas.mjs';
import { verifyArbitraryColdRetainedExecutionChain } from './gpu-hmr-arbitrary-cold-retained-chain.mjs';
import { verifyColdBuildExecutionDriverReceipt } from './gpu-hmr-cold-build-execution-driver.mjs';
import { verifyColdBuildExecutionPlanReceipt } from './gpu-hmr-cold-build-execution-plan.mjs';
import { verifyColdBuildOutputEvidenceReceipt } from './gpu-hmr-cold-build-output-evidence.mjs';
import { verifyColdBuildSourceTreeSnapshotReceipt } from './gpu-hmr-cold-build-source-tree-binding.mjs';
import { verifyColdBuildWorkerImageReceipt } from './gpu-hmr-cold-build-worker-image.mjs';

export const ARBITRARY_COLD_COMPILE_SUPPORT_RECEIPT_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_compile_support_receipt.v1';
export const ARBITRARY_COLD_COMPILE_SUPPORT_RECEIPT_AUTHORITY =
  'trusted_cold_command_and_byte_backed_output_support_only_not_build_graph_device_artifact_runtime_dispatch_acceptance_or_success';

const SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const ARTIFACT_ID_PATTERN = /^artifact:sha256:[a-f0-9]{64}$/;
const PINNED_SUPPORT_RECEIPTS = new WeakMap();
const ARTIFACT_BINDING_KEYS = Object.freeze([
  'artifactId',
  'manifestHash',
  'contentHash',
  'byteLength',
  'actualContentHash',
  'actualByteLength',
]);
const RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'runEvidenceHash',
  'outputEvidenceHash',
  'driverReceiptHash',
  'commandPlanHash',
  'commandPlanReceiptHash',
  'sourceSnapshotHash',
  'sourceSnapshotReceiptHash',
  'imageId',
  'imageReceiptHash',
  'retainedChainHash',
  'artifactBindings',
  'artifactBindingSetHash',
  'artifactCount',
  'outputBytesEmbedded',
  'supportOnly',
  'trustedColdCommandExecution',
  'byteBackedOutputsVerified',
  'buildGraphObserved',
  'deviceArtifactSemanticsObserved',
  'runtimeObserved',
  'dispatchObserved',
  'accepted',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'receiptHash',
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

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function recomputeReceiptHash(receipt) {
  const projection = { ...receipt };
  delete projection.receiptHash;
  return contentHash(stableJson(projection));
}

function verifiedRunCommitments(runResult) {
  const chain = verifyArbitraryColdRetainedExecutionChain(
    runResult?.retainedExecutionChain,
  );
  const outputReceipt = verifyColdBuildOutputEvidenceReceipt(
    chain.outputEvidenceReceipt,
  );
  const driverReceipt = verifyColdBuildExecutionDriverReceipt(
    outputReceipt.executionDriverReceipt,
  );
  const commandPlanReceipt = verifyColdBuildExecutionPlanReceipt(
    driverReceipt.executionPlanReceipt,
  );
  const sourceSnapshotReceipt = verifyColdBuildSourceTreeSnapshotReceipt(
    chain.sourceSnapshotReceipt,
  );
  const imageReceipt = verifyColdBuildWorkerImageReceipt(chain.workerImageReceipt);
  if (
    chain.runEvidence.evidenceHash !== runResult.evidence.evidenceHash
    || outputReceipt.outputEvidence.evidenceHash !== runResult.evidence.outputEvidenceHash
    || driverReceipt.driverEvidence.evidenceHash
      !== runResult.evidence.driverExecutionEvidenceHash
    || commandPlanReceipt.planHash !== runResult.evidence.planHash
    || sourceSnapshotReceipt.snapshotEvidence.evidenceHash
      !== runResult.evidence.sourceSnapshotEvidenceHash
    || imageReceipt.imageId !== runResult.evidence.workerImageId
  ) {
    throw new Error('arbitrary_cold_compile_support_receipt_source_invalid');
  }
  return {
    runEvidenceHash: runResult.evidence.evidenceHash,
    outputEvidenceHash: outputReceipt.outputEvidence.evidenceHash,
    driverReceiptHash: driverReceipt.evidenceHash,
    commandPlanHash: commandPlanReceipt.planHash,
    commandPlanReceiptHash: commandPlanReceipt.evidenceHash,
    sourceSnapshotHash: sourceSnapshotReceipt.snapshotEvidence.evidenceHash,
    sourceSnapshotReceiptHash: sourceSnapshotReceipt.evidenceHash,
    imageId: imageReceipt.imageId,
    imageReceiptHash: imageReceipt.evidenceHash,
    retainedChainHash: chain.evidenceHash,
  };
}

async function verifiedArtifactBindings(runResult) {
  const bindings = [];
  for (const output of runResult.outputs) {
    const locator = output.artifactLocator;
    const validation = await validateArtifactCasManifest(locator, {
      artifactRoot: runResult.artifactSessionRoot,
      allowedRoots: [runResult.artifactSessionRoot],
      requireReadableBytes: true,
    });
    if (
      validation.accepted !== true
      || validation.acceptedAsTransportEvidence !== true
      || validation.artifactId !== locator.artifactId
      || validation.manifestHash !== locator.manifestHash
      || validation.contentHash !== locator.contentHash
      || validation.byteLength !== locator.byteLength
      || validation.readableContentHash !== locator.contentHash
      || validation.readableByteLength !== locator.byteLength
      || contentHash(output.bytes) !== validation.readableContentHash
      || output.bytes.byteLength !== validation.readableByteLength
    ) {
      throw new Error('arbitrary_cold_compile_support_receipt_output_bytes_invalid');
    }
    bindings.push({
      artifactId: validation.artifactId,
      manifestHash: validation.manifestHash,
      contentHash: validation.contentHash,
      byteLength: validation.byteLength,
      actualContentHash: validation.readableContentHash,
      actualByteLength: validation.readableByteLength,
    });
  }
  bindings.sort((left, right) => Buffer.compare(
    Buffer.from(stableJson(left), 'utf8'),
    Buffer.from(stableJson(right), 'utf8'),
  ));
  return bindings;
}

function receiptMaterial(commitments, artifactBindings) {
  return {
    schemaVersion: ARBITRARY_COLD_COMPILE_SUPPORT_RECEIPT_SCHEMA,
    proofAuthority: ARBITRARY_COLD_COMPILE_SUPPORT_RECEIPT_AUTHORITY,
    ...commitments,
    artifactBindings,
    artifactBindingSetHash: contentHash(stableJson(artifactBindings)),
    artifactCount: artifactBindings.length,
    outputBytesEmbedded: false,
    supportOnly: true,
    trustedColdCommandExecution: true,
    byteBackedOutputsVerified: true,
    buildGraphObserved: false,
    deviceArtifactSemanticsObserved: false,
    runtimeObserved: false,
    dispatchObserved: false,
    accepted: false,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
}

function receiptShapeAccepted(receipt) {
  return exactKeys(receipt, RECEIPT_KEYS)
    && receipt.schemaVersion === ARBITRARY_COLD_COMPILE_SUPPORT_RECEIPT_SCHEMA
    && receipt.proofAuthority === ARBITRARY_COLD_COMPILE_SUPPORT_RECEIPT_AUTHORITY
    && receipt.proofAuthority.includes('support_only')
    && SHA256_PATTERN.test(receipt.runEvidenceHash ?? '')
    && SHA256_PATTERN.test(receipt.outputEvidenceHash ?? '')
    && SHA256_PATTERN.test(receipt.driverReceiptHash ?? '')
    && SHA256_PATTERN.test(receipt.commandPlanHash ?? '')
    && SHA256_PATTERN.test(receipt.commandPlanReceiptHash ?? '')
    && SHA256_PATTERN.test(receipt.sourceSnapshotHash ?? '')
    && SHA256_PATTERN.test(receipt.sourceSnapshotReceiptHash ?? '')
    && SHA256_PATTERN.test(receipt.imageId ?? '')
    && SHA256_PATTERN.test(receipt.imageReceiptHash ?? '')
    && SHA256_PATTERN.test(receipt.retainedChainHash ?? '')
    && Array.isArray(receipt.artifactBindings)
    && receipt.artifactBindings.length > 0
    && receipt.artifactBindings.every((binding) => (
      exactKeys(binding, ARTIFACT_BINDING_KEYS)
      && ARTIFACT_ID_PATTERN.test(binding.artifactId ?? '')
      && SHA256_PATTERN.test(binding.manifestHash ?? '')
      && SHA256_PATTERN.test(binding.contentHash ?? '')
      && SHA256_PATTERN.test(binding.actualContentHash ?? '')
      && Number.isSafeInteger(binding.byteLength)
      && binding.byteLength >= 0
      && Number.isSafeInteger(binding.actualByteLength)
      && binding.actualByteLength >= 0
      && binding.actualContentHash === binding.contentHash
      && binding.actualByteLength === binding.byteLength
    ))
    && stableJson(receipt.artifactBindings) === stableJson(
      [...receipt.artifactBindings].sort((left, right) => Buffer.compare(
        Buffer.from(stableJson(left), 'utf8'),
        Buffer.from(stableJson(right), 'utf8'),
      )),
    )
    && receipt.artifactBindingSetHash === contentHash(stableJson(receipt.artifactBindings))
    && receipt.artifactCount === receipt.artifactBindings.length
    && receipt.outputBytesEmbedded === false
    && receipt.supportOnly === true
    && receipt.trustedColdCommandExecution === true
    && receipt.byteBackedOutputsVerified === true
    && receipt.buildGraphObserved === false
    && receipt.deviceArtifactSemanticsObserved === false
    && receipt.runtimeObserved === false
    && receipt.dispatchObserved === false
    && receipt.accepted === false
    && receipt.acceptedAsColdBuildEvidence === false
    && receipt.acceptedForGpuHmr === false
    && receipt.gpuHmrSuccess === false
    && receipt.canSatisfyRuntimeProof === false
    && receipt.canSatisfyDispatchProof === false
    && SHA256_PATTERN.test(receipt.receiptHash ?? '')
    && receipt.receiptHash === recomputeReceiptHash(receipt);
}

export async function createArbitraryColdCompileSupportReceipt(runResult) {
  await verifyArbitraryColdProjectRun(runResult);
  const commitments = verifiedRunCommitments(runResult);
  const artifactBindings = await verifiedArtifactBindings(runResult);
  const receipt = receiptMaterial(commitments, artifactBindings);
  receipt.receiptHash = recomputeReceiptHash(receipt);
  if (!receiptShapeAccepted(receipt)) {
    throw new Error('arbitrary_cold_compile_support_receipt_source_invalid');
  }
  PINNED_SUPPORT_RECEIPTS.set(receipt, Object.freeze({
    runResult,
    receiptHash: receipt.receiptHash,
  }));
  return receipt;
}

export async function verifyArbitraryColdCompileSupportReceipt(receipt) {
  const pinned = PINNED_SUPPORT_RECEIPTS.get(receipt);
  if (!pinned) {
    throw new Error('arbitrary_cold_compile_support_receipt_invalid');
  }
  try {
    await verifyArbitraryColdProjectRun(pinned.runResult);
    const commitments = verifiedRunCommitments(pinned.runResult);
    const artifactBindings = await verifiedArtifactBindings(pinned.runResult);
    const expected = receiptMaterial(commitments, artifactBindings);
    expected.receiptHash = recomputeReceiptHash(expected);
    if (
      !receiptShapeAccepted(receipt)
      || receipt.receiptHash !== pinned.receiptHash
      || stableJson(receipt) !== stableJson(expected)
    ) {
      throw new Error('receipt_mismatch');
    }
  } catch {
    throw new Error('arbitrary_cold_compile_support_receipt_invalid');
  }
  return receipt;
}
