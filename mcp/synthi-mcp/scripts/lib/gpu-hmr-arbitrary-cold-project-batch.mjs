import { createHash } from 'node:crypto';
import {
  lstat,
  open,
  readdir,
  realpath,
} from 'node:fs/promises';
import path from 'node:path';

import {
  normalizeArbitraryColdProjectDescriptor,
  verifyArbitraryColdProjectRun,
  verifyArbitraryColdProjectRunFailure,
} from '../gpu-hmr-arbitrary-cold-project-runner.mjs';

export const ARBITRARY_COLD_BATCH_SELECTION_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_batch_selection.v1';
export const ARBITRARY_COLD_BATCH_SELECTION_AUTHORITY =
  'descriptor_hash_sampling_only_not_cold_build_or_gpu_hmr_success';
export const ARBITRARY_COLD_BATCH_SUMMARY_SCHEMA =
  'synthi.gpu_hmr.arbitrary_cold_project_batch_summary.v2';
export const ARBITRARY_COLD_BATCH_SUMMARY_AUTHORITY =
  'batch_orchestration_summary_only_not_cold_build_or_gpu_hmr_success';

const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const DEFAULT_LIMITS = Object.freeze({
  maxDescriptorCount: 1024,
  maxDescriptorByteLength: 1024 * 1024,
  maxDescriptorTotalByteLength: 64 * 1024 * 1024,
  maxDirectoryCount: 1024,
  maxDepth: 32,
});
const PINNED_SELECTIONS = new WeakMap();
const PINNED_ATTEMPTS = new WeakSet();
const PINNED_RECORDS = new WeakSet();
const SELECTION_KEYS = Object.freeze([
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
]);
const SELECTED_ENTRY_KEYS = Object.freeze(['descriptorHash', 'selectionScore']);
const ATTEMPT_KEYS = Object.freeze([
  'descriptorHash',
  'selectionScore',
  'selectionEvidenceHash',
  'descriptorSetHash',
  'outcome',
  'runEvidenceHash',
  'retainedExecutionChainHash',
  'failureEvidenceHash',
  'artifactCount',
  'artifactLocatorSetHash',
  'evidenceHash',
]);
const SUMMARY_KEYS = Object.freeze([
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

function supportFlagsAreFalse(value) {
  return value?.acceptedAsColdBuildEvidence === false
    && value?.acceptedForGpuHmr === false
    && value?.gpuHmrSuccess === false
    && value?.canSatisfyRuntimeProof === false
    && value?.canSatisfyDispatchProof === false;
}

function comparablePath(value) {
  const normalized = path.normalize(value);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function pathIsInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== ''
    && relative !== '..'
    && !relative.startsWith(`..${path.sep}`)
    && !path.isAbsolute(relative);
}

function requireLimit(value, name, maximum) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`arbitrary_cold_batch_${name}_invalid`);
  }
  return value;
}

function normalizeLimits(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('arbitrary_cold_batch_limits_invalid');
  }
  const unknown = Object.keys(input).filter((key) => !Object.hasOwn(DEFAULT_LIMITS, key));
  if (unknown.length > 0) {
    throw new Error('arbitrary_cold_batch_limits_invalid');
  }
  return Object.freeze({
    maxDescriptorCount: requireLimit(
      input.maxDescriptorCount ?? DEFAULT_LIMITS.maxDescriptorCount,
      'descriptor_count_limit',
      DEFAULT_LIMITS.maxDescriptorCount,
    ),
    maxDescriptorByteLength: requireLimit(
      input.maxDescriptorByteLength ?? DEFAULT_LIMITS.maxDescriptorByteLength,
      'descriptor_byte_limit',
      DEFAULT_LIMITS.maxDescriptorByteLength,
    ),
    maxDescriptorTotalByteLength: requireLimit(
      input.maxDescriptorTotalByteLength ?? DEFAULT_LIMITS.maxDescriptorTotalByteLength,
      'descriptor_total_byte_limit',
      DEFAULT_LIMITS.maxDescriptorTotalByteLength,
    ),
    maxDirectoryCount: requireLimit(
      input.maxDirectoryCount ?? DEFAULT_LIMITS.maxDirectoryCount,
      'directory_count_limit',
      DEFAULT_LIMITS.maxDirectoryCount,
    ),
    maxDepth: requireLimit(
      input.maxDepth ?? DEFAULT_LIMITS.maxDepth,
      'depth_limit',
      DEFAULT_LIMITS.maxDepth,
    ),
  });
}

function sameFileMetadata(left, right) {
  return left?.size === right?.size
    && left?.mode === right?.mode
    && left?.nlink === right?.nlink
    && left?.uid === right?.uid
    && left?.gid === right?.gid
    && left?.mtimeNs === right?.mtimeNs
    && left?.ctimeNs === right?.ctimeNs;
}

function samePathFileIdentity(left, right) {
  if (process.platform === 'win32') {
    return typeof left?.ino === 'bigint'
      && left.ino !== 0n
      && left.ino === right?.ino;
  }
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameOpenFileIdentity(left, right) {
  return typeof left?.dev === 'bigint'
    && typeof left?.ino === 'bigint'
    && left.ino !== 0n
    && left.dev === right?.dev
    && left.ino === right?.ino;
}

async function readBoundDescriptor(filePath, byteLimit) {
  const beforePath = await lstat(filePath, { bigint: true });
  if (
    beforePath.isSymbolicLink()
    || !beforePath.isFile()
    || beforePath.size < 2n
    || beforePath.size > BigInt(byteLimit)
  ) {
    throw new Error('arbitrary_cold_batch_descriptor_file_invalid');
  }
  const handle = await open(filePath, 'r');
  let verificationHandle = null;
  try {
    const before = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    const pathAfter = await lstat(filePath, { bigint: true });
    verificationHandle = await open(filePath, 'r');
    const verification = await verificationHandle.stat({ bigint: true });
    const finalPath = await lstat(filePath, { bigint: true });
    if (
      !before.isFile()
      || before.size < 2n
      || before.size > BigInt(byteLimit)
      || pathAfter.isSymbolicLink()
      || finalPath.isSymbolicLink()
      || !samePathFileIdentity(beforePath, pathAfter)
      || !samePathFileIdentity(pathAfter, finalPath)
      || !samePathFileIdentity(finalPath, verification)
      || !sameOpenFileIdentity(before, after)
      || !sameOpenFileIdentity(after, verification)
      || !sameFileMetadata(beforePath, before)
      || !sameFileMetadata(before, after)
      || !sameFileMetadata(after, pathAfter)
      || !sameFileMetadata(pathAfter, verification)
      || !sameFileMetadata(verification, finalPath)
      || BigInt(bytes.byteLength) !== verification.size
    ) {
      throw new Error('arbitrary_cold_batch_descriptor_file_changed');
    }
    return bytes;
  } finally {
    await verificationHandle?.close().catch(() => {});
    await handle.close();
  }
}

function byteOrder(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

export async function discoverArbitraryColdProjectDescriptors(descriptorRoot, {
  limits: limitOverrides = {},
  runnerPolicy = {},
} = {}) {
  if (typeof descriptorRoot !== 'string' || descriptorRoot.length < 1 || /[\0\r\n]/.test(descriptorRoot)) {
    throw new Error('arbitrary_cold_batch_descriptor_root_invalid');
  }
  const limits = normalizeLimits(limitOverrides);
  const requestedRoot = path.resolve(descriptorRoot);
  const [rootMetadata, canonicalRoot] = await Promise.all([
    lstat(requestedRoot, { bigint: true }),
    realpath(requestedRoot),
  ]);
  if (
    rootMetadata.isSymbolicLink()
    || !rootMetadata.isDirectory()
    || comparablePath(requestedRoot) !== comparablePath(canonicalRoot)
  ) {
    throw new Error('arbitrary_cold_batch_descriptor_root_invalid');
  }

  const files = [];
  const pending = [{ directory: canonicalRoot, depth: 0 }];
  let directoryCount = 0;
  while (pending.length > 0) {
    const current = pending.shift();
    directoryCount += 1;
    if (directoryCount > limits.maxDirectoryCount || current.depth > limits.maxDepth) {
      throw new Error('arbitrary_cold_batch_descriptor_tree_limit_exceeded');
    }
    const entries = await readdir(current.directory, { withFileTypes: true });
    entries.sort((left, right) => byteOrder(left.name, right.name));
    for (const entry of entries) {
      const entryPath = path.join(current.directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error('arbitrary_cold_batch_descriptor_tree_symlink_refused');
      }
      if (entry.isDirectory()) {
        const canonicalDirectory = await realpath(entryPath);
        if (!pathIsInside(canonicalRoot, canonicalDirectory)) {
          throw new Error('arbitrary_cold_batch_descriptor_tree_escape');
        }
        pending.push({ directory: canonicalDirectory, depth: current.depth + 1 });
        continue;
      }
      if (path.extname(entry.name).toLowerCase() !== '.json') continue;
      if (!entry.isFile()) {
        throw new Error('arbitrary_cold_batch_descriptor_file_invalid');
      }
      files.push(entryPath);
      if (files.length > limits.maxDescriptorCount) {
        throw new Error('arbitrary_cold_batch_descriptor_count_limit_exceeded');
      }
    }
  }
  if (files.length < 1) {
    throw new Error('arbitrary_cold_batch_descriptors_missing');
  }

  const records = [];
  let totalByteLength = 0;
  for (const descriptorPath of files) {
    const canonicalPath = await realpath(descriptorPath);
    if (!pathIsInside(canonicalRoot, canonicalPath)) {
      throw new Error('arbitrary_cold_batch_descriptor_tree_escape');
    }
    const bytes = await readBoundDescriptor(canonicalPath, limits.maxDescriptorByteLength);
    totalByteLength += bytes.byteLength;
    if (totalByteLength > limits.maxDescriptorTotalByteLength) {
      throw new Error('arbitrary_cold_batch_descriptor_total_byte_limit_exceeded');
    }
    let parsed;
    try {
      parsed = JSON.parse(bytes.toString('utf8'));
    } catch {
      throw new Error('arbitrary_cold_batch_descriptor_json_invalid');
    }
    const descriptor = normalizeArbitraryColdProjectDescriptor(parsed, { policy: runnerPolicy });
    const descriptorHash = contentHash(stableJson(descriptor));
    const record = Object.freeze({
      descriptorPath: canonicalPath,
      descriptorBytesHash: contentHash(bytes),
      descriptorByteLength: bytes.byteLength,
      descriptorHash,
      descriptor,
    });
    PINNED_RECORDS.add(record);
    records.push(record);
  }
  records.sort((left, right) => byteOrder(left.descriptorHash, right.descriptorHash));
  if (new Set(records.map((record) => record.descriptorHash)).size !== records.length) {
    throw new Error('arbitrary_cold_batch_duplicate_descriptor_refused');
  }
  return Object.freeze(records);
}

function verifyDescriptorRecord(record) {
  if (
    !record
    || typeof record !== 'object'
    || !PINNED_RECORDS.has(record)
    || !HASH_PATTERN.test(record.descriptorHash ?? '')
    || !HASH_PATTERN.test(record.descriptorBytesHash ?? '')
    || !Number.isSafeInteger(record.descriptorByteLength)
    || record.descriptorByteLength < 2
    || record.descriptorHash !== contentHash(stableJson(record.descriptor))
  ) {
    throw new Error('arbitrary_cold_batch_descriptor_record_invalid');
  }
}

export function selectArbitraryColdProjectDescriptors(records, {
  seed,
  sampleCount,
} = {}) {
  if (!Array.isArray(records) || records.length < 1) {
    throw new Error('arbitrary_cold_batch_descriptor_records_invalid');
  }
  records.forEach(verifyDescriptorRecord);
  if (new Set(records.map((record) => record.descriptorHash)).size !== records.length) {
    throw new Error('arbitrary_cold_batch_duplicate_descriptor_refused');
  }
  if (
    typeof seed !== 'string'
    || seed.length < 1
    || Buffer.byteLength(seed, 'utf8') > 1024
    || /[\0\r\n]/.test(seed)
  ) {
    throw new Error('arbitrary_cold_batch_seed_invalid');
  }
  if (!Number.isSafeInteger(sampleCount) || sampleCount < 1 || sampleCount > records.length) {
    throw new Error('arbitrary_cold_batch_sample_count_invalid');
  }
  const seedHash = contentHash(`synthi-arbitrary-cold-batch-seed-v1:${seed}`);
  const ranked = records.map((record) => ({
    descriptorHash: record.descriptorHash,
    selectionScore: contentHash(
      `synthi-arbitrary-cold-batch-rank-v1:${seedHash}:${record.descriptorHash}`,
    ),
  })).sort((left, right) => (
    byteOrder(left.selectionScore, right.selectionScore)
      || byteOrder(left.descriptorHash, right.descriptorHash)
  ));
  const selected = ranked.slice(0, sampleCount);
  const descriptorSetHash = contentHash(stableJson(
    records.map((record) => record.descriptorHash).sort(byteOrder),
  ));
  const selection = {
    schemaVersion: ARBITRARY_COLD_BATCH_SELECTION_SCHEMA,
    proofAuthority: ARBITRARY_COLD_BATCH_SELECTION_AUTHORITY,
    descriptorSetHash,
    seedHash,
    availableDescriptorCount: records.length,
    requestedSampleCount: sampleCount,
    selected,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  selection.evidenceHash = contentHash(stableJson(selection));
  PINNED_SELECTIONS.set(selection, Object.freeze({
    descriptorSetHash,
    seedHash,
    selected: stableJson(selected),
  }));
  return selection;
}

export function verifyArbitraryColdBatchSelection(selection, records) {
  const pinned = PINNED_SELECTIONS.get(selection);
  records.forEach(verifyDescriptorRecord);
  try {
    verifyRetainedArbitraryColdBatchSelection(selection);
  } catch {
    throw new Error('arbitrary_cold_batch_selection_invalid');
  }
  if (
    !pinned
    || pinned.descriptorSetHash !== selection.descriptorSetHash
    || pinned.seedHash !== selection.seedHash
    || pinned.selected !== stableJson(selection.selected)
    || selection.availableDescriptorCount !== records.length
    || selection.requestedSampleCount !== selection.selected.length
    || selection.selected.some((entry) => (
      !HASH_PATTERN.test(entry.descriptorHash ?? '')
      || !HASH_PATTERN.test(entry.selectionScore ?? '')
      || !records.some((record) => record.descriptorHash === entry.descriptorHash)
    ))
  ) {
    throw new Error('arbitrary_cold_batch_selection_invalid');
  }
  return selection;
}

export function verifyRetainedArbitraryColdBatchSelection(selection) {
  const selected = selection?.selected;
  if (
    !exactKeys(selection, SELECTION_KEYS)
    || selection.schemaVersion !== ARBITRARY_COLD_BATCH_SELECTION_SCHEMA
    || selection.proofAuthority !== ARBITRARY_COLD_BATCH_SELECTION_AUTHORITY
    || !HASH_PATTERN.test(selection.descriptorSetHash ?? '')
    || !HASH_PATTERN.test(selection.seedHash ?? '')
    || !Number.isSafeInteger(selection.availableDescriptorCount)
    || selection.availableDescriptorCount < 1
    || !Number.isSafeInteger(selection.requestedSampleCount)
    || selection.requestedSampleCount < 1
    || selection.requestedSampleCount > selection.availableDescriptorCount
    || !Array.isArray(selected)
    || selected.length !== selection.requestedSampleCount
    || new Set(selected.map((entry) => entry?.descriptorHash)).size !== selected.length
    || selected.some((entry, index) => (
      !exactKeys(entry, SELECTED_ENTRY_KEYS)
      || !HASH_PATTERN.test(entry.descriptorHash ?? '')
      || !HASH_PATTERN.test(entry.selectionScore ?? '')
      || entry.selectionScore !== contentHash(
        `synthi-arbitrary-cold-batch-rank-v1:${selection.seedHash}:${entry.descriptorHash}`,
      )
      || (index > 0 && (
        byteOrder(selected[index - 1].selectionScore, entry.selectionScore) > 0
        || (
          selected[index - 1].selectionScore === entry.selectionScore
          && byteOrder(selected[index - 1].descriptorHash, entry.descriptorHash) >= 0
        )
      ))
    ))
    || !supportFlagsAreFalse(selection)
    || !HASH_PATTERN.test(selection.evidenceHash ?? '')
    || recomputeEvidenceHash(selection) !== selection.evidenceHash
  ) {
    throw new Error('arbitrary_cold_batch_retained_selection_invalid');
  }
  return selection;
}

function retainedAttemptAccepted(attempt, selected, selection) {
  const completed = attempt?.outcome === 'cold_run_completed';
  const refused = attempt?.outcome === 'cold_run_refused';
  return exactKeys(attempt, ATTEMPT_KEYS)
    && attempt.descriptorHash === selected?.descriptorHash
    && attempt.selectionScore === selected?.selectionScore
    && attempt.selectionEvidenceHash === selection.evidenceHash
    && attempt.descriptorSetHash === selection.descriptorSetHash
    && (completed || refused)
    && (completed
      ? HASH_PATTERN.test(attempt.runEvidenceHash ?? '')
        && HASH_PATTERN.test(attempt.retainedExecutionChainHash ?? '')
        && attempt.failureEvidenceHash === null
        && Number.isSafeInteger(attempt.artifactCount)
        && attempt.artifactCount >= 1
        && HASH_PATTERN.test(attempt.artifactLocatorSetHash ?? '')
      : attempt.runEvidenceHash === null
        && attempt.retainedExecutionChainHash === null
        && HASH_PATTERN.test(attempt.failureEvidenceHash ?? '')
        && attempt.artifactCount === 0
        && attempt.artifactLocatorSetHash === null)
    && HASH_PATTERN.test(attempt.evidenceHash ?? '')
    && recomputeEvidenceHash(attempt) === attempt.evidenceHash;
}

export function verifyRetainedArbitraryColdBatchSummary(summary, selection) {
  verifyRetainedArbitraryColdBatchSelection(selection);
  const attempts = summary?.attempts;
  const completedCount = Array.isArray(attempts)
    ? attempts.filter((attempt) => attempt?.outcome === 'cold_run_completed').length
    : -1;
  if (
    !exactKeys(summary, SUMMARY_KEYS)
    || summary.schemaVersion !== ARBITRARY_COLD_BATCH_SUMMARY_SCHEMA
    || summary.proofAuthority !== ARBITRARY_COLD_BATCH_SUMMARY_AUTHORITY
    || summary.selectionEvidenceHash !== selection.evidenceHash
    || summary.descriptorSetHash !== selection.descriptorSetHash
    || summary.seedHash !== selection.seedHash
    || !Array.isArray(attempts)
    || attempts.length !== selection.selected.length
    || attempts.some((attempt, index) => (
      !retainedAttemptAccepted(attempt, selection.selected[index], selection)
    ))
    || summary.attemptedCount !== attempts.length
    || summary.completedColdRunCount !== completedCount
    || summary.refusedColdRunCount !== attempts.length - completedCount
    || summary.batchExecutionCompleted !== true
    || !supportFlagsAreFalse(summary)
    || !HASH_PATTERN.test(summary.evidenceHash ?? '')
    || recomputeEvidenceHash(summary) !== summary.evidenceHash
  ) {
    throw new Error('arbitrary_cold_batch_retained_summary_invalid');
  }
  return summary;
}

function selectedEntry(selection, descriptorHash) {
  const entry = selection.selected.find((candidate) => candidate.descriptorHash === descriptorHash);
  if (!entry) throw new Error('arbitrary_cold_batch_descriptor_not_selected');
  return entry;
}

function outputLocatorProjection(result) {
  return result.outputs.map((output) => ({
    path: output.metadata.path,
    contentHash: output.artifactLocator.contentHash,
    byteLength: output.artifactLocator.byteLength,
    artifactId: output.artifactLocator.artifactId,
    manifestHash: output.artifactLocator.manifestHash,
  })).sort((left, right) => byteOrder(left.path, right.path));
}

export async function createCompletedArbitraryColdBatchAttempt({
  selection,
  records,
  descriptorHash,
  result,
}) {
  verifyArbitraryColdBatchSelection(selection, records);
  await verifyArbitraryColdProjectRun(result);
  const selected = selectedEntry(selection, descriptorHash);
  const locators = outputLocatorProjection(result);
  const attempt = {
    descriptorHash,
    selectionScore: selected.selectionScore,
    selectionEvidenceHash: selection.evidenceHash,
    descriptorSetHash: selection.descriptorSetHash,
    outcome: 'cold_run_completed',
    runEvidenceHash: result.evidence.evidenceHash,
    retainedExecutionChainHash: result.retainedExecutionChain.evidenceHash,
    failureEvidenceHash: null,
    artifactCount: locators.length,
    artifactLocatorSetHash: contentHash(stableJson(locators)),
  };
  attempt.evidenceHash = contentHash(stableJson(attempt));
  PINNED_ATTEMPTS.add(attempt);
  return attempt;
}

export function createRefusedArbitraryColdBatchAttempt({
  selection,
  records,
  descriptorHash,
  failure,
}) {
  verifyArbitraryColdBatchSelection(selection, records);
  verifyArbitraryColdProjectRunFailure(failure);
  const selected = selectedEntry(selection, descriptorHash);
  const attempt = {
    descriptorHash,
    selectionScore: selected.selectionScore,
    selectionEvidenceHash: selection.evidenceHash,
    descriptorSetHash: selection.descriptorSetHash,
    outcome: 'cold_run_refused',
    runEvidenceHash: null,
    retainedExecutionChainHash: null,
    failureEvidenceHash: failure.evidenceHash,
    artifactCount: 0,
    artifactLocatorSetHash: null,
  };
  attempt.evidenceHash = contentHash(stableJson(attempt));
  PINNED_ATTEMPTS.add(attempt);
  return attempt;
}

export function createArbitraryColdBatchSummary(selection, records, attempts) {
  verifyArbitraryColdBatchSelection(selection, records);
  if (
    !Array.isArray(attempts)
    || attempts.length !== selection.selected.length
    || attempts.some((attempt, index) => (
      !PINNED_ATTEMPTS.has(attempt)
      || attempt?.descriptorHash !== selection.selected[index].descriptorHash
      || attempt?.selectionScore !== selection.selected[index].selectionScore
      || attempt?.selectionEvidenceHash !== selection.evidenceHash
      || attempt?.descriptorSetHash !== selection.descriptorSetHash
      || !['cold_run_completed', 'cold_run_refused'].includes(attempt?.outcome)
      || !HASH_PATTERN.test(attempt?.evidenceHash ?? '')
      || recomputeEvidenceHash(attempt) !== attempt.evidenceHash
    ))
  ) {
    throw new Error('arbitrary_cold_batch_attempts_invalid');
  }
  const completedCount = attempts.filter((attempt) => attempt.outcome === 'cold_run_completed').length;
  const summary = {
    schemaVersion: ARBITRARY_COLD_BATCH_SUMMARY_SCHEMA,
    proofAuthority: ARBITRARY_COLD_BATCH_SUMMARY_AUTHORITY,
    selectionEvidenceHash: selection.evidenceHash,
    descriptorSetHash: selection.descriptorSetHash,
    seedHash: selection.seedHash,
    attemptedCount: attempts.length,
    completedColdRunCount: completedCount,
    refusedColdRunCount: attempts.length - completedCount,
    attempts: structuredClone(attempts),
    batchExecutionCompleted: true,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  summary.evidenceHash = contentHash(stableJson(summary));
  verifyRetainedArbitraryColdBatchSummary(summary, selection);
  return summary;
}
