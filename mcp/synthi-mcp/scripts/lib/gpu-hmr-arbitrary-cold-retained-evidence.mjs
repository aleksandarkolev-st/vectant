import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import {
  ARBITRARY_COLD_BATCH_REPORT_AUTHORITY,
  ARBITRARY_COLD_BATCH_REPORT_SCHEMA,
} from '../gpu-hmr-arbitrary-cold-project-batch.mjs';
import {
  ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
  ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
  normalizeArbitraryColdProjectDescriptor,
  verifyArbitraryColdProjectRunFailure,
} from '../gpu-hmr-arbitrary-cold-project-runner.mjs';
import {
  ARBITRARY_COLD_BATCH_SELECTION_AUTHORITY,
  ARBITRARY_COLD_BATCH_SELECTION_SCHEMA,
  ARBITRARY_COLD_BATCH_SUMMARY_AUTHORITY,
  ARBITRARY_COLD_BATCH_SUMMARY_SCHEMA,
} from './gpu-hmr-arbitrary-cold-project-batch.mjs';
import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION,
  validateArtifactCasManifest,
} from './gpu-hmr-artifact-cas.mjs';
import { createColdBuildInputSet } from './gpu-hmr-cold-build-input-set.mjs';

export const ARBITRARY_COLD_RETAINED_EVIDENCE_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_retained_evidence.v1';
export const ARBITRARY_COLD_RETAINED_EVIDENCE_AUTHORITY =
  'recomputed_descriptor_commitments_and_cas_bytes_only_not_authenticity_or_gpu_hmr_success';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const RUN_EVIDENCE_KEYS = [
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
];
const TIMING_KEYS = [
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
];
const OUTPUT_METADATA_KEYS = [
  'path',
  'declaredRole',
  'declaredArtifactKind',
  'declaredMediaType',
  'declaredContentHash',
  'declaredByteLength',
  'observedContentHash',
  'observedByteLength',
  'mode',
  'metadataAuthority',
];
const FACET_KEYS = [
  'schemaVersion',
  'proofAuthority',
  'batchReportEvidenceHash',
  'selectionEvidenceHash',
  'summaryEvidenceHash',
  'descriptorSetHash',
  'descriptorRecordSetHash',
  'verifiedDescriptorCount',
  'verifiedCompletedColdRunCount',
  'verifiedRefusedColdRunCount',
  'verifiedArtifactCount',
  'verifiedArtifactLocatorSetHash',
  'samplingSeedPreimageVerified',
  'externalReportHashMatched',
  'sourceBindingManifestsRetained',
  'executionChainRecordsRetained',
  'limitations',
  'acceptedAsRetainedBatchEvidence',
  'acceptedAsRetainedColdOutputEvidence',
  'acceptedAsColdBuildEvidence',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
];

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

function comparablePath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === '' || (
    relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative)
  );
}

function pathIdentityHash(value) {
  const normalized = path.resolve(value).replaceAll('\\', '/').replace(/\/+$/, '');
  return contentHash(process.platform === 'win32' ? normalized.toLowerCase() : normalized);
}

function requireHash(value) {
  return HASH_PATTERN.test(value ?? '');
}

function supportFlagsAreFalse(value) {
  return value?.acceptedForGpuHmr === false
    && value?.gpuHmrSuccess === false
    && value?.canSatisfyRuntimeProof === false
    && value?.canSatisfyDispatchProof === false;
}

function samplingSeedHash(seed) {
  if (
    typeof seed !== 'string'
    || seed.length < 1
    || Buffer.byteLength(seed, 'utf8') > 1024
    || /[\0\r\n]/.test(seed)
  ) {
    throw new Error('arbitrary_cold_retained_sampling_seed_invalid');
  }
  return contentHash(`synthi-arbitrary-cold-batch-seed-v1:${seed}`);
}

function outputContractProjection(descriptor) {
  return descriptor.outputs.map((output) => ({
    path: output.path,
    declaredRole: output.role,
    declaredArtifactKind: output.artifactKind,
    declaredMediaType: output.mediaType,
  })).sort((left, right) => byteOrder(left.path, right.path));
}

function runArtifactLocatorProjection(outputs) {
  return outputs.map((output) => ({
    path: output.metadata.path,
    contentHash: output.metadata.observedContentHash,
    byteLength: output.metadata.observedByteLength,
    artifactId: output.artifactLocator.artifactId,
    manifestHash: output.artifactLocator.manifestHash,
    transportKind: output.artifactLocator.transport.kind,
  })).sort((left, right) => byteOrder(left.path, right.path));
}

function attemptArtifactLocatorProjection(outputs) {
  return outputs.map((output) => ({
    path: output.metadata.path,
    contentHash: output.artifactLocator.contentHash,
    byteLength: output.artifactLocator.byteLength,
    artifactId: output.artifactLocator.artifactId,
    manifestHash: output.artifactLocator.manifestHash,
  })).sort((left, right) => byteOrder(left.path, right.path));
}

async function verifyDescriptorRecords(records) {
  if (!Array.isArray(records) || records.length < 1) {
    throw new Error('arbitrary_cold_retained_descriptor_records_invalid');
  }
  const verified = [];
  for (const record of records) {
    if (
      !record
      || typeof record !== 'object'
      || !requireHash(record.descriptorHash)
      || !requireHash(record.descriptorBytesHash)
      || !Number.isSafeInteger(record.descriptorByteLength)
      || record.descriptorByteLength < 2
      || typeof record.descriptorPath !== 'string'
    ) {
      throw new Error('arbitrary_cold_retained_descriptor_record_invalid');
    }
    const normalized = normalizeArbitraryColdProjectDescriptor(record.descriptor);
    const canonicalPath = await realpath(record.descriptorPath);
    const bytes = await readFile(canonicalPath);
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('arbitrary_cold_retained_descriptor_record_invalid');
    }
    const normalizedBytes = normalizeArbitraryColdProjectDescriptor(parsed);
    if (
      comparablePath(canonicalPath) !== comparablePath(record.descriptorPath)
      || record.descriptorByteLength !== bytes.byteLength
      || record.descriptorBytesHash !== contentHash(bytes)
      || record.descriptorHash !== contentHash(stableJson(normalized))
      || stableJson(normalizedBytes) !== stableJson(normalized)
    ) {
      throw new Error('arbitrary_cold_retained_descriptor_record_invalid');
    }
    verified.push({
      descriptorHash: record.descriptorHash,
      descriptorBytesHash: record.descriptorBytesHash,
      descriptorByteLength: record.descriptorByteLength,
      descriptor: normalized,
    });
  }
  verified.sort((left, right) => byteOrder(left.descriptorHash, right.descriptorHash));
  if (new Set(verified.map((record) => record.descriptorHash)).size !== verified.length) {
    throw new Error('arbitrary_cold_retained_descriptor_duplicate');
  }
  return verified;
}

function verifySelection(selection, records, samplingSeed) {
  const descriptorHashes = records.map((record) => record.descriptorHash).sort(byteOrder);
  const descriptorSetHash = contentHash(stableJson(descriptorHashes));
  const ranked = records.map((record) => ({
    descriptorHash: record.descriptorHash,
    selectionScore: contentHash(
      `synthi-arbitrary-cold-batch-rank-v1:${selection?.seedHash}:${record.descriptorHash}`,
    ),
  })).sort((left, right) => (
    byteOrder(left.selectionScore, right.selectionScore)
      || byteOrder(left.descriptorHash, right.descriptorHash)
  ));
  const expectedSelected = ranked.slice(0, selection?.requestedSampleCount);
  if (samplingSeed !== null && samplingSeedHash(samplingSeed) !== selection?.seedHash) {
    throw new Error('arbitrary_cold_retained_sampling_seed_mismatch');
  }
  if (
    !exactKeys(selection, [
      'schemaVersion',
      'proofAuthority',
      'descriptorSetHash',
      'seedHash',
      'availableDescriptorCount',
      'requestedSampleCount',
      'selected',
      'acceptedAsColdBuildEvidence',
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'canSatisfyDispatchProof',
      'evidenceHash',
    ])
    || selection.schemaVersion !== ARBITRARY_COLD_BATCH_SELECTION_SCHEMA
    || selection.proofAuthority !== ARBITRARY_COLD_BATCH_SELECTION_AUTHORITY
    || !requireHash(selection.seedHash)
    || selection.descriptorSetHash !== descriptorSetHash
    || selection.availableDescriptorCount !== records.length
    || !Number.isSafeInteger(selection.requestedSampleCount)
    || selection.requestedSampleCount < 1
    || selection.requestedSampleCount > records.length
    || stableJson(selection.selected) !== stableJson(expectedSelected)
    || selection.acceptedAsColdBuildEvidence !== false
    || !supportFlagsAreFalse(selection)
    || recomputeEvidenceHash(selection) !== selection.evidenceHash
  ) {
    throw new Error('arbitrary_cold_retained_selection_invalid');
  }
  return descriptorSetHash;
}

function verifyAttempt(attempt, selected, selection) {
  if (
    !exactKeys(attempt, [
      'descriptorHash',
      'selectionScore',
      'selectionEvidenceHash',
      'descriptorSetHash',
      'outcome',
      'runEvidenceHash',
      'failureEvidenceHash',
      'artifactCount',
      'artifactLocatorSetHash',
      'evidenceHash',
    ])
    || attempt.descriptorHash !== selected.descriptorHash
    || attempt.selectionScore !== selected.selectionScore
    || attempt.selectionEvidenceHash !== selection.evidenceHash
    || attempt.descriptorSetHash !== selection.descriptorSetHash
    || !['cold_run_completed', 'cold_run_refused'].includes(attempt.outcome)
    || !Number.isSafeInteger(attempt.artifactCount)
    || attempt.artifactCount < 0
    || recomputeEvidenceHash(attempt) !== attempt.evidenceHash
  ) {
    throw new Error('arbitrary_cold_retained_attempt_invalid');
  }
}

function verifySummary(summary, selection) {
  if (
    !exactKeys(summary, [
      'schemaVersion',
      'proofAuthority',
      'selectionEvidenceHash',
      'descriptorSetHash',
      'seedHash',
      'attemptedCount',
      'completedColdRunCount',
      'refusedColdRunCount',
      'attempts',
      'batchExecutionCompleted',
      'acceptedAsColdBuildEvidence',
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'canSatisfyDispatchProof',
      'evidenceHash',
    ])
    || summary.schemaVersion !== ARBITRARY_COLD_BATCH_SUMMARY_SCHEMA
    || summary.proofAuthority !== ARBITRARY_COLD_BATCH_SUMMARY_AUTHORITY
    || summary.selectionEvidenceHash !== selection.evidenceHash
    || summary.descriptorSetHash !== selection.descriptorSetHash
    || summary.seedHash !== selection.seedHash
    || !Array.isArray(summary.attempts)
    || summary.attempts.length !== selection.selected.length
    || summary.attemptedCount !== summary.attempts.length
    || summary.completedColdRunCount
      !== summary.attempts.filter((attempt) => attempt.outcome === 'cold_run_completed').length
    || summary.refusedColdRunCount
      !== summary.attempts.filter((attempt) => attempt.outcome === 'cold_run_refused').length
    || summary.completedColdRunCount + summary.refusedColdRunCount !== summary.attemptedCount
    || summary.batchExecutionCompleted !== true
    || summary.acceptedAsColdBuildEvidence !== false
    || !supportFlagsAreFalse(summary)
    || recomputeEvidenceHash(summary) !== summary.evidenceHash
  ) {
    throw new Error('arbitrary_cold_retained_summary_invalid');
  }
  summary.attempts.forEach((attempt, index) => (
    verifyAttempt(attempt, selection.selected[index], selection)
  ));
}

function verifyRunEvidence(runEvidence, descriptor, descriptorHash, outputs, artifactSessionRoot) {
  const readOnlyBindings = runEvidence?.readOnlyInputBindings;
  const snapshotBindings = runEvidence?.readOnlyInputSnapshotBindings;
  if (!Array.isArray(readOnlyBindings) || !Array.isArray(snapshotBindings)) {
    throw new Error('arbitrary_cold_retained_run_evidence_invalid');
  }
  const expectedMountPaths = descriptor.readOnlyInputs.map((input) => input.mountPath).sort(byteOrder);
  const observedMountPaths = readOnlyBindings.map((input) => input?.mountPath).sort(byteOrder);
  const observedSnapshotMountPaths = snapshotBindings.map((input) => input?.mountPath).sort(byteOrder);
  if (
    readOnlyBindings.some((binding) => (
      !exactKeys(binding, [
        'mountPath',
        'sourceBindingHash',
        'sourceTreeBindingEvidenceHash',
        'entryCount',
        'totalByteLength',
      ])
      || !requireHash(binding.sourceBindingHash)
      || !requireHash(binding.sourceTreeBindingEvidenceHash)
      || !Number.isSafeInteger(binding.entryCount)
      || binding.entryCount < 0
      || !Number.isSafeInteger(binding.totalByteLength)
      || binding.totalByteLength < 0
    ))
    || snapshotBindings.some((binding) => (
      !exactKeys(binding, ['mountPath', 'snapshotEvidenceHash'])
      || !requireHash(binding.snapshotEvidenceHash)
    ))
    || stableJson(observedMountPaths) !== stableJson(expectedMountPaths)
    || stableJson(observedSnapshotMountPaths) !== stableJson(expectedMountPaths)
  ) {
    throw new Error('arbitrary_cold_retained_run_evidence_invalid');
  }
  const inputSet = createColdBuildInputSet({
    sourceBindingHash: runEvidence?.sourceBindingHash,
    readOnlyInputs: readOnlyBindings.map((binding) => ({
      mountPath: binding.mountPath,
      sourceBindingHash: binding.sourceBindingHash,
    })),
  });
  const outputMetadata = outputs.map((output) => output.metadata);
  const outputContract = outputContractProjection(descriptor);
  const totalRunnerWallNanos = runEvidence?.timings?.totalRunnerWallNanos;
  if (
    !exactKeys(runEvidence, RUN_EVIDENCE_KEYS)
    || runEvidence.schemaVersion !== ARBITRARY_COLD_PROJECT_RUN_SCHEMA
    || runEvidence.proofAuthority !== ARBITRARY_COLD_PROJECT_RUN_AUTHORITY
    || runEvidence.descriptorHash !== descriptorHash
    || runEvidence.sourcePathIdentityHash !== pathIdentityHash(descriptor.sourceRoot)
    || ![
      'sourceBindingHash',
      'sourceTreeBindingEvidenceHash',
      'sourceSnapshotEvidenceHash',
      'workerImageEvidenceHash',
      'workerImageId',
      'contractHash',
      'commandSpecHash',
      'launcherExecutableHash',
      'planHash',
      'driverExecutionEvidenceHash',
      'outputEvidenceHash',
    ].every((name) => requireHash(runEvidence[name]))
    || stableJson(runEvidence.inputSetBindings) !== stableJson(inputSet.entries)
    || runEvidence.inputSetHash !== inputSet.inputSetHash
    || runEvidence.readOnlyInputBindingSetHash !== contentHash(stableJson(readOnlyBindings))
    || runEvidence.readOnlyInputSnapshotSetHash !== contentHash(stableJson(snapshotBindings))
    || runEvidence.readOnlyInputCount !== readOnlyBindings.length
    || runEvidence.readOnlyInputEntryCount
      !== readOnlyBindings.reduce((total, binding) => total + binding.entryCount, 0)
    || runEvidence.readOnlyInputByteLength
      !== readOnlyBindings.reduce((total, binding) => total + binding.totalByteLength, 0)
    || runEvidence.outputSetHash !== contentHash(stableJson(outputMetadata))
    || runEvidence.outputContractHash !== contentHash(stableJson(outputContract))
    || runEvidence.artifactSessionRootIdentityHash !== pathIdentityHash(artifactSessionRoot)
    || runEvidence.artifactLocatorSetHash
      !== contentHash(stableJson(runArtifactLocatorProjection(outputs)))
    || runEvidence.artifactCount !== outputs.length
    || !exactKeys(runEvidence.timings, TIMING_KEYS)
    || runEvidence.timings.metricClock !== 'monotonic_ns'
    || runEvidence.timings.metricScope !== 'cold'
    || Object.entries(runEvidence.timings).some(([name, value]) => (
      name.endsWith('Nanos') && (!Number.isSafeInteger(value) || value < 0)
    ))
    || TIMING_KEYS.filter((name) => name.endsWith('Nanos')).some(
      (name) => runEvidence.timings[name] > totalRunnerWallNanos,
    )
    || runEvidence.coldBuildSucceeded !== true
    || runEvidence.acceptedAsColdBuildEvidence !== true
    || !supportFlagsAreFalse(runEvidence)
    || recomputeEvidenceHash(runEvidence) !== runEvidence.evidenceHash
  ) {
    throw new Error('arbitrary_cold_retained_run_evidence_invalid');
  }
}

async function canonicalArtifactSessionRoot(reportedRoot, allowedArtifactRoots) {
  if (
    typeof reportedRoot !== 'string'
    || !Array.isArray(allowedArtifactRoots)
    || allowedArtifactRoots.length < 1
  ) {
    throw new Error('arbitrary_cold_retained_artifact_root_invalid');
  }
  const [canonicalSession, ...canonicalRoots] = await Promise.all([
    realpath(reportedRoot),
    ...allowedArtifactRoots.map((root) => realpath(root)),
  ]);
  const metadata = await lstat(canonicalSession);
  if (
    metadata.isSymbolicLink()
    || !metadata.isDirectory()
    || comparablePath(canonicalSession) !== comparablePath(reportedRoot)
    || !canonicalRoots.some((root) => pathIsInside(root, canonicalSession))
  ) {
    throw new Error('arbitrary_cold_retained_artifact_root_invalid');
  }
  return canonicalSession;
}

async function verifyCompletedReport(entry, attempt, record, allowedArtifactRoots) {
  const artifactSessionRoot = await canonicalArtifactSessionRoot(
    entry.artifactSessionRoot,
    allowedArtifactRoots,
  );
  if (!Array.isArray(entry.outputs) || entry.outputs.length < 1) {
    throw new Error('arbitrary_cold_retained_completed_report_invalid');
  }
  const outputs = [...entry.outputs].sort((left, right) => (
    byteOrder(left?.metadata?.path ?? '', right?.metadata?.path ?? '')
  ));
  const declarations = outputContractProjection(record.descriptor);
  if (outputs.length !== declarations.length) {
    throw new Error('arbitrary_cold_retained_completed_report_invalid');
  }
  const locatorFacts = [];
  for (let index = 0; index < outputs.length; index += 1) {
    const output = outputs[index];
    const metadata = output?.metadata;
    const declaration = declarations[index];
    const locator = output?.artifactLocator;
    const storedTransport = output?.transportEvidence;
    if (
      !exactKeys(output, ['metadata', 'artifactLocator', 'transportEvidence'])
      || !exactKeys(metadata, OUTPUT_METADATA_KEYS)
      || metadata.path !== declaration.path
      || metadata.declaredRole !== declaration.declaredRole
      || metadata.declaredArtifactKind !== declaration.declaredArtifactKind
      || metadata.declaredMediaType !== declaration.declaredMediaType
      || metadata.declaredContentHash !== metadata.observedContentHash
      || metadata.declaredByteLength !== metadata.observedByteLength
      || !requireHash(metadata.observedContentHash)
      || !Number.isSafeInteger(metadata.observedByteLength)
      || metadata.observedByteLength < 0
      || !Number.isSafeInteger(metadata.mode)
      || metadata.mode < 0
      || metadata.mode > 0o7777
      || metadata.metadataAuthority !== 'advisory_only_not_output_acceptance'
      || locator?.schemaVersion !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION
      || locator?.contentHash !== metadata.observedContentHash
      || locator?.byteLength !== metadata.observedByteLength
      || locator?.mediaType !== metadata.declaredMediaType
      || locator?.role !== 'cold_build_output'
      || locator?.acceptedForGpuHmr !== false
      || locator?.gpuHmrSuccess !== false
    ) {
      throw new Error('arbitrary_cold_retained_completed_report_invalid');
    }
    const recomputedTransport = await validateArtifactCasManifest(locator, {
      artifactRoot: artifactSessionRoot,
      allowedRoots: [artifactSessionRoot],
      requireReadableBytes: true,
    });
    if (
      recomputedTransport.accepted !== true
      || recomputedTransport.acceptedAsTransportEvidence !== true
      || recomputedTransport.acceptedForGpuHmr !== false
      || recomputedTransport.gpuHmrSuccess !== false
      || storedTransport?.schemaVersion
        !== GPU_HMR_ARTIFACT_TRANSPORT_EVIDENCE_SCHEMA_VERSION
      || storedTransport?.accepted !== true
      || storedTransport?.acceptedAsTransportEvidence !== true
      || storedTransport?.acceptedForGpuHmr !== false
      || storedTransport?.gpuHmrSuccess !== false
      || storedTransport?.proofAuthority !== 'transport_integrity_only'
      || storedTransport?.manifestHash !== recomputedTransport.manifestHash
      || storedTransport?.contentHash !== recomputedTransport.contentHash
      || storedTransport?.artifactId !== recomputedTransport.artifactId
      || storedTransport?.artifactUri !== recomputedTransport.artifactUri
      || storedTransport?.transportKind !== recomputedTransport.transportKind
      || storedTransport?.byteLength !== recomputedTransport.byteLength
      || storedTransport?.mediaType !== recomputedTransport.mediaType
    ) {
      throw new Error('arbitrary_cold_retained_artifact_transport_invalid');
    }
    locatorFacts.push({
      descriptorHash: entry.descriptorHash,
      path: metadata.path,
      contentHash: locator.contentHash,
      byteLength: locator.byteLength,
      artifactId: locator.artifactId,
      manifestHash: locator.manifestHash,
    });
  }
  verifyRunEvidence(
    entry.runEvidence,
    record.descriptor,
    record.descriptorHash,
    outputs,
    artifactSessionRoot,
  );
  const attemptLocators = attemptArtifactLocatorProjection(outputs);
  if (
    attempt.runEvidenceHash !== entry.runEvidence.evidenceHash
    || attempt.failureEvidenceHash !== null
    || attempt.artifactCount !== outputs.length
    || attempt.artifactLocatorSetHash !== contentHash(stableJson(attemptLocators))
  ) {
    throw new Error('arbitrary_cold_retained_completed_report_invalid');
  }
  return locatorFacts;
}

function verifyRefusedReport(entry, attempt) {
  verifyArbitraryColdProjectRunFailure(entry.failureEvidence);
  if (
    entry.runEvidence !== null
    || entry.artifactSessionRoot !== null
    || !Array.isArray(entry.outputs)
    || entry.outputs.length !== 0
    || attempt.runEvidenceHash !== null
    || attempt.failureEvidenceHash !== entry.failureEvidence.evidenceHash
    || attempt.artifactCount !== 0
    || attempt.artifactLocatorSetHash !== null
  ) {
    throw new Error('arbitrary_cold_retained_refused_report_invalid');
  }
}

export async function recomputeArbitraryColdRetainedEvidence(report, descriptorRecords, {
  allowedArtifactRoots = [],
  samplingSeed = null,
  expectedBatchReportEvidenceHash = null,
} = {}) {
  const records = await verifyDescriptorRecords(descriptorRecords);
  const descriptorSetHash = verifySelection(report?.selection, records, samplingSeed);
  verifySummary(report?.summary, report.selection);
  if (
    expectedBatchReportEvidenceHash !== null
    && (
      !requireHash(expectedBatchReportEvidenceHash)
      || expectedBatchReportEvidenceHash !== report?.evidenceHash
    )
  ) {
    throw new Error('arbitrary_cold_retained_external_report_hash_mismatch');
  }
  if (
    !exactKeys(report, [
      'schemaVersion',
      'proofAuthority',
      'selection',
      'summary',
      'reports',
      'acceptedAsColdBuildEvidence',
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'canSatisfyDispatchProof',
      'evidenceHash',
    ])
    || report.schemaVersion !== ARBITRARY_COLD_BATCH_REPORT_SCHEMA
    || report.proofAuthority !== ARBITRARY_COLD_BATCH_REPORT_AUTHORITY
    || !Array.isArray(report.reports)
    || report.reports.length !== report.selection.selected.length
    || report.reports.length !== report.summary.attempts.length
    || report.acceptedAsColdBuildEvidence !== false
    || !supportFlagsAreFalse(report)
    || recomputeEvidenceHash(report) !== report.evidenceHash
  ) {
    throw new Error('arbitrary_cold_retained_batch_report_invalid');
  }
  const recordsByHash = new Map(records.map((record) => [record.descriptorHash, record]));
  const locatorFacts = [];
  for (let index = 0; index < report.reports.length; index += 1) {
    const entry = report.reports[index];
    const attempt = report.summary.attempts[index];
    const selected = report.selection.selected[index];
    const record = recordsByHash.get(selected.descriptorHash);
    if (
      !exactKeys(entry, [
        'descriptorHash',
        'descriptorBytesHash',
        'outcome',
        'runEvidence',
        'artifactSessionRoot',
        'outputs',
        'failureEvidence',
      ])
      || !record
      || entry.descriptorHash !== selected.descriptorHash
      || entry.descriptorHash !== attempt.descriptorHash
      || entry.descriptorBytesHash !== record.descriptorBytesHash
      || entry.outcome !== attempt.outcome
    ) {
      throw new Error('arbitrary_cold_retained_report_entry_invalid');
    }
    if (entry.outcome === 'cold_run_completed') {
      locatorFacts.push(...await verifyCompletedReport(
        entry,
        attempt,
        record,
        allowedArtifactRoots,
      ));
    } else if (entry.outcome === 'cold_run_refused') {
      verifyRefusedReport(entry, attempt);
    } else {
      throw new Error('arbitrary_cold_retained_report_entry_invalid');
    }
  }
  locatorFacts.sort((left, right) => (
    byteOrder(left.descriptorHash, right.descriptorHash)
      || byteOrder(left.path, right.path)
  ));
  const descriptorRecordFacts = records.map((record) => ({
    descriptorHash: record.descriptorHash,
    descriptorBytesHash: record.descriptorBytesHash,
    descriptorByteLength: record.descriptorByteLength,
  }));
  const samplingSeedPreimageVerified = samplingSeed !== null;
  const externalReportHashMatched = expectedBatchReportEvidenceHash !== null;
  const limitations = [
    'source_binding_manifest_not_retained',
    'execution_chain_records_not_retained',
    ...(!samplingSeedPreimageVerified ? ['sampling_seed_preimage_not_supplied'] : []),
    ...(!externalReportHashMatched ? ['external_authenticity_anchor_not_supplied'] : []),
    'retained_cold_evidence_not_runtime_or_gpu_hmr_proof',
  ];
  const facet = {
    schemaVersion: ARBITRARY_COLD_RETAINED_EVIDENCE_SCHEMA,
    proofAuthority: ARBITRARY_COLD_RETAINED_EVIDENCE_AUTHORITY,
    batchReportEvidenceHash: report.evidenceHash,
    selectionEvidenceHash: report.selection.evidenceHash,
    summaryEvidenceHash: report.summary.evidenceHash,
    descriptorSetHash,
    descriptorRecordSetHash: contentHash(stableJson(descriptorRecordFacts)),
    verifiedDescriptorCount: records.length,
    verifiedCompletedColdRunCount: report.summary.completedColdRunCount,
    verifiedRefusedColdRunCount: report.summary.refusedColdRunCount,
    verifiedArtifactCount: locatorFacts.length,
    verifiedArtifactLocatorSetHash: contentHash(stableJson(locatorFacts)),
    samplingSeedPreimageVerified,
    externalReportHashMatched,
    sourceBindingManifestsRetained: false,
    executionChainRecordsRetained: false,
    limitations,
    acceptedAsRetainedBatchEvidence: true,
    acceptedAsRetainedColdOutputEvidence: report.summary.completedColdRunCount > 0,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  facet.evidenceHash = recomputeEvidenceHash(facet);
  return verifyArbitraryColdRetainedEvidence(facet);
}

export function verifyArbitraryColdRetainedEvidence(facet) {
  if (
    !exactKeys(facet, FACET_KEYS)
    || facet.schemaVersion !== ARBITRARY_COLD_RETAINED_EVIDENCE_SCHEMA
    || facet.proofAuthority !== ARBITRARY_COLD_RETAINED_EVIDENCE_AUTHORITY
    || ![
      facet.batchReportEvidenceHash,
      facet.selectionEvidenceHash,
      facet.summaryEvidenceHash,
      facet.descriptorSetHash,
      facet.descriptorRecordSetHash,
      facet.verifiedArtifactLocatorSetHash,
      facet.evidenceHash,
    ].every(requireHash)
    || ![
      facet.verifiedDescriptorCount,
      facet.verifiedCompletedColdRunCount,
      facet.verifiedRefusedColdRunCount,
      facet.verifiedArtifactCount,
    ].every((value) => Number.isSafeInteger(value) && value >= 0)
    || facet.verifiedDescriptorCount < 1
    || typeof facet.samplingSeedPreimageVerified !== 'boolean'
    || typeof facet.externalReportHashMatched !== 'boolean'
    || facet.sourceBindingManifestsRetained !== false
    || facet.executionChainRecordsRetained !== false
    || stableJson(facet.limitations) !== stableJson([
      'source_binding_manifest_not_retained',
      'execution_chain_records_not_retained',
      ...(!facet.samplingSeedPreimageVerified ? ['sampling_seed_preimage_not_supplied'] : []),
      ...(!facet.externalReportHashMatched ? ['external_authenticity_anchor_not_supplied'] : []),
      'retained_cold_evidence_not_runtime_or_gpu_hmr_proof',
    ])
    || facet.acceptedAsRetainedBatchEvidence !== true
    || facet.acceptedAsRetainedColdOutputEvidence
      !== (facet.verifiedCompletedColdRunCount > 0)
    || facet.acceptedAsColdBuildEvidence !== false
    || !supportFlagsAreFalse(facet)
    || recomputeEvidenceHash(facet) !== facet.evidenceHash
  ) {
    throw new Error('arbitrary_cold_retained_evidence_invalid');
  }
  return facet;
}
