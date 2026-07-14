import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  link,
  lstat,
  open,
  readFile,
  realpath,
  stat,
  unlink,
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  COLD_BUILD_COLLECTOR_FRAME_MAGIC,
  COLD_BUILD_CONTAINER_EXTRACTION_TIMEOUT_MS,
  COLD_BUILD_CONTAINER_READY_POLL_MS,
  COLD_BUILD_CONTROL_FRAME_MAGIC,
  COLD_BUILD_LAUNCHER_CONTAINER_PATH,
  COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
  parseColdBuildCollectorCompletionReceipt,
  parseColdBuildCollectorFrame,
  parseColdBuildControlFrame,
  parseColdBuildFinalReceipt,
  runColdBuildHostProcess,
} from './gpu-hmr-cold-build-container-contract.mjs';
import {
  coldBuildLauncherCollectorExecArgs,
  publishColdBuildLauncherSpec,
  verifyColdBuildLauncherContainerInspection,
  verifyColdBuildLauncherExecutionInputs,
} from './gpu-hmr-cold-build-execution-plan.mjs';
import { computeColdBuildSourceTreeBinding } from './gpu-hmr-cold-build-source-tree-binding.mjs';

export const COLD_BUILD_EXECUTION_DRIVER_SCHEMA =
  'synthi.gpu_hmr.cold_build_execution_driver_result.v1';
export const COLD_BUILD_EXECUTION_DRIVER_AUTHORITY =
  'observed_static_launcher_protocol_only_not_gpu_hmr_success';
export const COLD_BUILD_HOST_FILE_PUBLICATION_SCHEMA =
  'synthi.gpu_hmr.cold_build_host_file_publication.v1';
export const COLD_BUILD_HOST_FILE_PUBLICATION_AUTHORITY =
  'exclusive_host_control_file_publication_only_not_gpu_hmr_success';
export const COLD_BUILD_READY_REFUSAL_EVIDENCE_SCHEMA =
  'synthi.gpu_hmr.cold_build_ready_refusal.v1';
export const COLD_BUILD_READY_REFUSAL_EVIDENCE_AUTHORITY =
  'observed_ready_receipt_refusal_only_not_cold_build_or_gpu_hmr_success';

const CONTAINER_ID_PATTERN = /^[a-f0-9]{64}$/;
const HASH_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CONTROL_FILE_NAMES = new Set(['collector-complete.json', 'final.json']);
const PINNED_DRIVER_RESULTS = new WeakMap();

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

function recomputeEvidenceHash(evidence) {
  const projection = { ...evidence };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function createReadyRefusalEvidence(ready, plan) {
  const receipt = ready.receipt;
  const evidence = {
    schemaVersion: COLD_BUILD_READY_REFUSAL_EVIDENCE_SCHEMA,
    proofAuthority: COLD_BUILD_READY_REFUSAL_EVIDENCE_AUTHORITY,
    executionNonce: plan.executionNonce,
    specHash: plan.specHash,
    commandSpecHash: plan.commandSpecHash,
    sourceBindingHash: plan.sourceBindingHash,
    inputSetHash: plan.inputSetHash,
    launcherExecutableHash: plan.launcherExecutableHash,
    readyReceiptHash: ready.receiptHash,
    readyFrameHash: ready.frameHash,
    protocolAccepted: receipt.protocolAccepted,
    childIdentityAccepted: receipt.childIdentityAccepted,
    childExitCode: receipt.childExitCode,
    commandTimedOut: receipt.commandTimedOut,
    commandStdoutByteLength: receipt.commandStdout.byteLength,
    commandStdoutHash: receipt.commandStdout.contentHash,
    commandStderrByteLength: receipt.commandStderr.byteLength,
    commandStderrHash: receipt.commandStderr.contentHash,
    processTreeQuiescent: receipt.processTree.quiescent,
    residualProcessCount: receipt.processTree.finalResidualPids.length,
    outputSnapshotAccepted: receipt.outputSnapshotAccepted,
    outputSnapshotHash: receipt.outputSnapshotHash,
    outputEntryCount: receipt.outputEntryCount,
    outputByteLength: receipt.outputByteLength,
    blockingGaps: [...receipt.blockingGaps],
    acceptedAsColdBuildRefusalEvidence: true,
    acceptedAsColdBuildEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  return evidence;
}

export function verifyColdBuildReadyRefusalEvidence(evidence, plan) {
  const blockingGaps = evidence?.blockingGaps;
  const hashOrEmpty = (value) => value === '' || HASH_PATTERN.test(value ?? '');
  const safeCount = (value) => Number.isSafeInteger(value) && value >= 0;
  if (
    !exactKeys(evidence, [
      'schemaVersion',
      'proofAuthority',
      'executionNonce',
      'specHash',
      'commandSpecHash',
      'sourceBindingHash',
      'inputSetHash',
      'launcherExecutableHash',
      'readyReceiptHash',
      'readyFrameHash',
      'protocolAccepted',
      'childIdentityAccepted',
      'childExitCode',
      'commandTimedOut',
      'commandStdoutByteLength',
      'commandStdoutHash',
      'commandStderrByteLength',
      'commandStderrHash',
      'processTreeQuiescent',
      'residualProcessCount',
      'outputSnapshotAccepted',
      'outputSnapshotHash',
      'outputEntryCount',
      'outputByteLength',
      'blockingGaps',
      'acceptedAsColdBuildRefusalEvidence',
      'acceptedAsColdBuildEvidence',
      'acceptedForGpuHmr',
      'gpuHmrSuccess',
      'canSatisfyRuntimeProof',
      'canSatisfyDispatchProof',
      'evidenceHash',
    ])
    || evidence.schemaVersion !== COLD_BUILD_READY_REFUSAL_EVIDENCE_SCHEMA
    || evidence.proofAuthority !== COLD_BUILD_READY_REFUSAL_EVIDENCE_AUTHORITY
    || evidence.executionNonce !== plan?.executionNonce
    || evidence.specHash !== plan?.specHash
    || evidence.commandSpecHash !== plan?.commandSpecHash
    || evidence.sourceBindingHash !== plan?.sourceBindingHash
    || evidence.inputSetHash !== plan?.inputSetHash
    || evidence.launcherExecutableHash !== plan?.launcherExecutableHash
    || !HASH_PATTERN.test(evidence.readyReceiptHash ?? '')
    || !HASH_PATTERN.test(evidence.readyFrameHash ?? '')
    || typeof evidence.protocolAccepted !== 'boolean'
    || typeof evidence.childIdentityAccepted !== 'boolean'
    || !Number.isSafeInteger(evidence.childExitCode)
    || evidence.childExitCode < 0
    || evidence.childExitCode > 255
    || typeof evidence.commandTimedOut !== 'boolean'
    || !safeCount(evidence.commandStdoutByteLength)
    || !HASH_PATTERN.test(evidence.commandStdoutHash ?? '')
    || !safeCount(evidence.commandStderrByteLength)
    || !HASH_PATTERN.test(evidence.commandStderrHash ?? '')
    || typeof evidence.processTreeQuiescent !== 'boolean'
    || !safeCount(evidence.residualProcessCount)
    || typeof evidence.outputSnapshotAccepted !== 'boolean'
    || !hashOrEmpty(evidence.outputSnapshotHash)
    || !safeCount(evidence.outputEntryCount)
    || !safeCount(evidence.outputByteLength)
    || !Array.isArray(blockingGaps)
    || blockingGaps.some((gap, index) => (
      typeof gap !== 'string'
      || gap.length < 1
      || (index > 0 && gap <= blockingGaps[index - 1])
    ))
    || evidence.protocolAccepted !== (blockingGaps.length === 0)
    || (
      evidence.protocolAccepted === true
      && (
        evidence.childIdentityAccepted !== true
        || evidence.outputSnapshotAccepted !== true
        || evidence.processTreeQuiescent !== true
        || evidence.residualProcessCount !== 0
        || !HASH_PATTERN.test(evidence.outputSnapshotHash)
      )
    )
    || (
      evidence.protocolAccepted === true
      && evidence.childExitCode === 0
      && evidence.commandTimedOut === false
    )
    || evidence.acceptedAsColdBuildRefusalEvidence !== true
    || evidence.acceptedAsColdBuildEvidence !== false
    || evidence.acceptedForGpuHmr !== false
    || evidence.gpuHmrSuccess !== false
    || evidence.canSatisfyRuntimeProof !== false
    || evidence.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(evidence) !== evidence.evidenceHash
  ) {
    throw new Error('cold_build_ready_refusal_evidence_invalid');
  }
  return evidence;
}

function payloadManifestFromPayloads(payloads) {
  if (!Array.isArray(payloads) || payloads.length < 1) {
    throw new Error('cold_build_execution_driver_payloads_invalid');
  }
  return payloads.map(({ entry, bytes }) => {
    if (
      !entry
      || typeof entry !== 'object'
      || Array.isArray(entry)
      || !Buffer.isBuffer(bytes)
      || !Number.isSafeInteger(entry.byteLength)
      || entry.byteLength !== bytes.byteLength
      || !HASH_PATTERN.test(entry.contentHash ?? '')
      || entry.contentHash !== contentHash(bytes)
    ) {
      throw new Error('cold_build_execution_driver_payload_invalid');
    }
    return {
      path: entry.path,
      byteLength: bytes.byteLength,
      contentHash: contentHash(bytes),
      mode: entry.mode,
    };
  });
}

function requireSafeInteger(value, name, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`cold_build_execution_driver_${name}_invalid`);
  }
  return value;
}

function requireContainerId(value) {
  if (!CONTAINER_ID_PATTERN.test(value ?? '')) {
    throw new Error('cold_build_execution_driver_container_id_invalid');
  }
  return value;
}

function diagnosticText(value) {
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  return String(value ?? '');
}

function assertProcessSucceeded(result, operation) {
  if (
    result?.exitCode !== 0
    || result?.signal !== null
    || result?.timedOut !== false
    || result?.error !== null
  ) {
    const error = new Error(`cold_build_execution_driver_${operation}_failed`);
    error.processResult = {
      exitCode: result?.exitCode ?? null,
      signal: result?.signal ?? null,
      timedOut: result?.timedOut === true,
      error: result?.error ?? null,
      stderr: diagnosticText(result?.stderr).slice(0, 8192),
    };
    throw error;
  }
  return result;
}

function parseCreatedContainerId(stdout) {
  const text = diagnosticText(stdout);
  if (!/^[a-f0-9]{64}(?:\r?\n)?$/.test(text)) {
    throw new Error('cold_build_execution_driver_create_stdout_invalid');
  }
  return requireContainerId(text.trim());
}

function parseSingleInspect(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(diagnosticText(stdout));
  } catch {
    throw new Error('cold_build_execution_driver_inspect_json_invalid');
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error('cold_build_execution_driver_inspect_cardinality_invalid');
  }
  return parsed;
}

async function runDocker(dockerExecutable, args, options) {
  return runColdBuildHostProcess(dockerExecutable, args, options);
}

function beginAttachedContainer({
  dockerExecutable,
  containerId,
  plan,
  readyTimeoutMs,
  totalTimeoutMs,
  maxReceiptBytes,
  maxDiagnosticBytes,
}) {
  let buffered = Buffer.alloc(0);
  let parsedReady = null;
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    rejectReady(new Error('cold_build_execution_driver_ready_timeout'));
  }, readyTimeoutMs);
  const maximumFrameBytes = COLD_BUILD_CONTROL_FRAME_MAGIC.byteLength + 8 + maxReceiptBytes;
  const onStdoutChunk = (chunk) => {
    if (parsedReady) return;
    buffered = Buffer.concat([buffered, Buffer.from(chunk)]);
    if (buffered.byteLength > maximumFrameBytes) {
      throw new Error('cold_build_execution_driver_ready_frame_oversize');
    }
    const prefixLength = COLD_BUILD_CONTROL_FRAME_MAGIC.byteLength;
    if (buffered.byteLength < prefixLength + 8) return;
    if (!buffered.subarray(0, prefixLength).equals(COLD_BUILD_CONTROL_FRAME_MAGIC)) {
      throw new Error('cold_build_execution_driver_ready_frame_magic_invalid');
    }
    const receiptLengthBigInt = buffered.readBigUInt64BE(prefixLength);
    if (receiptLengthBigInt > BigInt(maxReceiptBytes)) {
      throw new Error('cold_build_execution_driver_ready_frame_length_invalid');
    }
    const frameByteLength = prefixLength + 8 + Number(receiptLengthBigInt);
    if (buffered.byteLength < frameByteLength) return;
    parsedReady = parseColdBuildControlFrame(buffered.subarray(0, frameByteLength), {
      maxReceiptBytes,
      expectedExecutionNonce: plan.executionNonce,
      expectedLauncherIdentity: plan.launcherIdentity,
      expectedSpecHash: plan.specHash,
      expectedCommandSpecHash: plan.commandSpecHash,
      expectedSourceBindingHash: plan.sourceBindingHash,
    });
    parsedReady.frameBytes = Buffer.from(buffered.subarray(0, frameByteLength));
    settled = true;
    clearTimeout(timer);
    resolveReady(parsedReady);
  };
  const completion = runDocker(
    dockerExecutable,
    ['start', '--attach', containerId],
    {
      timeoutMs: totalTimeoutMs,
      maxStdoutBytes: maximumFrameBytes,
      maxStderrBytes: maxDiagnosticBytes,
      encoding: null,
      onStdoutChunk,
    },
  );
  completion.then((result) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    rejectReady(new Error(
      `cold_build_execution_driver_exited_before_ready:${result.exitCode ?? 'unknown'}`,
    ));
  });
  return { ready, completion };
}

async function pollControlFile({
  dockerExecutable,
  containerId,
  name,
  timeoutMs,
  maxReceiptBytes,
  maxDiagnosticBytes,
}) {
  if (!CONTROL_FILE_NAMES.has(name)) {
    throw new Error('cold_build_execution_driver_control_name_invalid');
  }
  const started = process.hrtime.bigint();
  const timeoutNanos = BigInt(requireSafeInteger(timeoutMs, 'control_timeout_ms')) * 1_000_000n;
  let lastResult = null;
  do {
    lastResult = await runDocker(dockerExecutable, [
      'exec',
      '--user',
      '0:0',
      requireContainerId(containerId),
      COLD_BUILD_LAUNCHER_CONTAINER_PATH,
      'read-control',
      '--spec',
      COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
      '--name',
      name,
    ], {
      timeoutMs: Math.min(timeoutMs, 5_000),
      maxStdoutBytes: maxReceiptBytes,
      maxStderrBytes: maxDiagnosticBytes,
      encoding: null,
    });
    if (
      lastResult.exitCode === 0
      && lastResult.signal === null
      && lastResult.timedOut === false
      && lastResult.error === null
    ) {
      return Buffer.from(lastResult.stdout);
    }
    await sleep(COLD_BUILD_CONTAINER_READY_POLL_MS);
  } while (process.hrtime.bigint() - started <= timeoutNanos);
  const error = new Error(`cold_build_execution_driver_control_timeout:${name}`);
  error.lastProcessResult = {
    exitCode: lastResult?.exitCode ?? null,
    signal: lastResult?.signal ?? null,
    timedOut: lastResult?.timedOut === true,
    error: lastResult?.error ?? null,
    stderr: diagnosticText(lastResult?.stderr).slice(0, 8192),
  };
  throw error;
}

async function publishExclusiveHostControlFile(directory, name, bytes) {
  const payload = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes ?? []);
  const destinationPath = path.join(directory, name);
  const temporaryPath = path.join(
    directory,
    `.${name}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  let destinationLinked = false;
  let publicationAccepted = false;
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(payload);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await chmod(temporaryPath, 0o444);
    await link(temporaryPath, destinationPath);
    destinationLinked = true;
    const [observedBytes, metadata] = await Promise.all([
      readFile(destinationPath),
      lstat(destinationPath),
    ]);
    if (!metadata.isFile() || !observedBytes.equals(payload)) {
      throw new Error('cold_build_execution_driver_host_file_identity_mismatch');
    }
    const evidence = {
      schemaVersion: COLD_BUILD_HOST_FILE_PUBLICATION_SCHEMA,
      proofAuthority: COLD_BUILD_HOST_FILE_PUBLICATION_AUTHORITY,
      role: name,
      byteLength: payload.byteLength,
      contentHash: contentHash(payload),
      exclusivePublication: true,
      regularFileObserved: true,
      acceptedAsHostFilePublicationEvidence: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    };
    evidence.evidenceHash = recomputeEvidenceHash(evidence);
    publicationAccepted = true;
    return evidence;
  } finally {
    await unlink(temporaryPath).catch(() => {});
    if (destinationLinked && !publicationAccepted) {
      await unlink(destinationPath).catch(() => {});
    }
  }
}

async function verifyFinalReleaseTree(plan, releasePublication, finalAckPublication) {
  const binding = await computeColdBuildSourceTreeBinding(plan.releaseHostPath, {
    maxEntryCount: plan.releaseTreeBindingEvidence.maxEntryCount,
    maxByteLength: plan.releaseTreeBindingEvidence.maxByteLength,
  });
  const expected = [
    {
      path: 'final-ack.json',
      contentHash: finalAckPublication.contentHash,
      byteLength: finalAckPublication.byteLength,
    },
    {
      path: 'release.json',
      contentHash: releasePublication.contentHash,
      byteLength: releasePublication.byteLength,
    },
  ];
  const observed = binding.entries.map((entry) => ({
    path: entry.path,
    kind: entry.kind,
    contentHash: entry.contentHash ?? null,
    byteLength: entry.byteLength ?? null,
  }));
  const expectedObserved = expected.map((entry) => ({
    ...entry,
    kind: 'file',
  }));
  if (stableJson(observed) !== stableJson(expectedObserved)) {
    throw new Error('cold_build_execution_driver_release_tree_invalid');
  }
  return binding;
}

async function verifyReleaseRootIdentity(releaseHostPath, observedBefore) {
  const plannedPath = path.resolve(releaseHostPath);
  const symbolic = await lstat(plannedPath, { bigint: true });
  const canonicalPath = await realpath(plannedPath);
  const canonical = await stat(canonicalPath, { bigint: true });
  if (
    symbolic.isSymbolicLink()
    || !canonical.isDirectory()
    || String(canonical.dev) !== observedBefore?.metadata?.device
    || String(canonical.ino) !== observedBefore?.metadata?.inode
    || Number(canonical.mode) !== observedBefore?.metadata?.mode
    || String(canonical.uid) !== observedBefore?.metadata?.ownerUserId
    || String(canonical.gid) !== observedBefore?.metadata?.ownerGroupId
  ) {
    throw new Error('cold_build_execution_driver_release_root_identity_changed');
  }
}

function buildReleaseReceipt({ plan, ready, frame, completion }) {
  const hostReceipt = {
    executionNonce: plan.executionNonce,
    specHash: plan.specHash,
    readyReceiptHash: ready.receiptHash,
    outputSnapshotHash: ready.receipt.outputSnapshotHash,
    collectorCompletionReceiptHash: completion.receiptHash,
    collectorReceiptHash: frame.receiptHash,
    collectorFrameHash: frame.frameHash,
    collectorFrameByteLength: completion.receipt.collectorFrameByteLength,
  };
  const hostReceiptHash = contentHash(stableJson(hostReceipt));
  const release = {
    schemaVersion: 'synthi.gpu_hmr.cold_build_release_receipt.v1',
    ...hostReceipt,
    hostReceiptHash,
  };
  return {
    hostReceipt,
    hostReceiptHash,
    release,
    releaseBytes: Buffer.from(stableJson(release), 'utf8'),
  };
}

async function cleanupContainer(
  dockerExecutable,
  containerReference,
  timeoutMs,
  { containerMayExist = false } = {},
) {
  if (!containerReference) {
    const evidence = {
      schemaVersion: 'synthi.gpu_hmr.cold_build_container_cleanup.v1',
      proofAuthority: 'container_cleanup_only_not_gpu_hmr_success',
      attempted: false,
      removed: !containerMayExist,
      absenceProven: !containerMayExist,
      blockingGaps: containerMayExist
        ? ['cold_build_execution_driver_container_identity_unavailable']
        : [],
      acceptedAsCleanupEvidence: !containerMayExist,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    };
    evidence.evidenceHash = recomputeEvidenceHash(evidence);
    return evidence;
  }
  const exactContainerId = requireContainerId(containerReference);
  const removed = await runDocker(
    dockerExecutable,
    ['rm', '--force', exactContainerId],
    {
      timeoutMs,
      maxStdoutBytes: 4096,
      maxStderrBytes: 32 * 1024,
      encoding: 'utf8',
    },
  );
  const listed = await runDocker(
    dockerExecutable,
    [
      'container',
      'ls',
      '--all',
      '--no-trunc',
      '--filter',
      `id=${exactContainerId}`,
      '--format',
      '{{.ID}}',
    ],
    {
      timeoutMs,
      maxStdoutBytes: 4096,
      maxStderrBytes: 32 * 1024,
      encoding: 'utf8',
    },
  );
  const removeCommandSucceeded = removed.exitCode === 0
    && removed.signal === null
    && removed.timedOut === false
    && removed.error === null;
  const absenceProven = listed.exitCode === 0
    && listed.signal === null
    && listed.timedOut === false
    && listed.error === null
    && diagnosticText(listed.stdout).trim() === '';
  const removedSuccessfully = removeCommandSucceeded || absenceProven;
  const blockingGaps = [
    removedSuccessfully ? null : 'cold_build_execution_driver_container_remove_failed',
    absenceProven ? null : 'cold_build_execution_driver_container_absence_unproven',
  ].filter(Boolean);
  const evidence = {
    schemaVersion: 'synthi.gpu_hmr.cold_build_container_cleanup.v1',
    proofAuthority: 'container_cleanup_only_not_gpu_hmr_success',
    attempted: true,
    removed: removedSuccessfully,
    removeCommandSucceeded,
    absenceProven,
    blockingGaps,
    acceptedAsCleanupEvidence: blockingGaps.length === 0,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  evidence.evidenceHash = recomputeEvidenceHash(evidence);
  return evidence;
}

export async function executeColdBuildLauncherPlan(plan, {
  dockerExecutable = 'docker',
  maxReceiptBytes = 1024 * 1024,
  maxDiagnosticBytes = 1024 * 1024,
  readyTimeoutMs = null,
  controlTimeoutMs = COLD_BUILD_CONTAINER_EXTRACTION_TIMEOUT_MS,
  cleanupTimeoutMs = 20_000,
} = {}) {
  requireSafeInteger(maxReceiptBytes, 'max_receipt_bytes', 2);
  requireSafeInteger(maxDiagnosticBytes, 'max_diagnostic_bytes', 1024);
  requireSafeInteger(controlTimeoutMs, 'control_timeout_ms');
  requireSafeInteger(cleanupTimeoutMs, 'cleanup_timeout_ms');
  const effectiveReadyTimeoutMs = readyTimeoutMs ?? (
    plan?.spec?.commandTimeoutMillis + COLD_BUILD_CONTAINER_EXTRACTION_TIMEOUT_MS
  );
  requireSafeInteger(effectiveReadyTimeoutMs, 'ready_timeout_ms');
  const totalTimeoutMs = effectiveReadyTimeoutMs
    + plan.spec.releaseTimeoutMillis
    + controlTimeoutMs
    + 30_000;
  if (!Number.isSafeInteger(totalTimeoutMs)) {
    throw new Error('cold_build_execution_driver_total_timeout_invalid');
  }
  const maximumCollectorBytes = COLD_BUILD_COLLECTOR_FRAME_MAGIC.byteLength
    + 8
    + maxReceiptBytes
    + plan.resourcePolicy.collectedByteLimit;
  if (!Number.isSafeInteger(maximumCollectorBytes)) {
    throw new Error('cold_build_execution_driver_collector_bound_invalid');
  }

  let containerReference = null;
  let containerMayExist = false;
  let attachedCompletion = null;
  let executionResult = null;
  let primaryError = null;
  let cleanupEvidence = null;
  try {
    const specPublication = await publishColdBuildLauncherSpec(plan);
    const inputEvidenceBeforeCreate = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'before_create',
    });
    if (inputEvidenceBeforeCreate.acceptedAsExecutionInputEvidence !== true) {
      throw new Error('cold_build_execution_driver_before_create_inputs_refused');
    }
    const created = assertProcessSucceeded(await runDocker(
      dockerExecutable,
      plan.containerCreateArgs,
      {
        timeoutMs: 30_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: maxDiagnosticBytes,
        encoding: 'utf8',
      },
    ), 'create');
    containerMayExist = true;
    const containerId = parseCreatedContainerId(created.stdout);
    containerReference = containerId;
    const inputEvidenceAfterCreate = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_create',
      expectedContainerId: containerId,
    });
    if (inputEvidenceAfterCreate.acceptedAsExecutionInputEvidence !== true) {
      throw new Error('cold_build_execution_driver_after_create_inputs_refused');
    }
    const inspected = assertProcessSucceeded(await runDocker(
      dockerExecutable,
      ['inspect', containerId],
      {
        timeoutMs: 30_000,
        maxStdoutBytes: 4 * 1024 * 1024,
        maxStderrBytes: maxDiagnosticBytes,
        encoding: 'utf8',
      },
    ), 'inspect');
    const containerInspection = verifyColdBuildLauncherContainerInspection(
      parseSingleInspect(inspected.stdout),
      plan,
      {
        expectedContainerId: containerId,
        inputEvidenceBeforeCreate,
        inputEvidenceAfterCreate,
      },
    );
    if (containerInspection.acceptedAsContainerInspectionEvidence !== true) {
      throw new Error('cold_build_execution_driver_container_inspection_refused');
    }

    const attached = beginAttachedContainer({
      dockerExecutable,
      containerId,
      plan,
      readyTimeoutMs: effectiveReadyTimeoutMs,
      totalTimeoutMs,
      maxReceiptBytes,
      maxDiagnosticBytes,
    });
    attachedCompletion = attached.completion;
    const ready = await attached.ready;
    if (
      ready.receipt.protocolAccepted !== true
      || ready.receipt.childExitCode !== 0
      || ready.receipt.commandTimedOut !== false
    ) {
      const error = new Error('cold_build_execution_driver_ready_receipt_refused');
      error.readyRefusalEvidence = createReadyRefusalEvidence(ready, plan);
      verifyColdBuildReadyRefusalEvidence(error.readyRefusalEvidence, plan);
      throw error;
    }

    const collected = assertProcessSucceeded(await runDocker(
      dockerExecutable,
      coldBuildLauncherCollectorExecArgs(plan, containerId),
      {
        timeoutMs: controlTimeoutMs,
        maxStdoutBytes: maximumCollectorBytes,
        maxStderrBytes: maxDiagnosticBytes,
        encoding: null,
      },
    ), 'collect');
    const collectorFrameBytes = Buffer.from(collected.stdout);
    const frame = parseColdBuildCollectorFrame(collectorFrameBytes, {
      maxHeaderBytes: maxReceiptBytes,
      maxPayloadBytes: plan.resourcePolicy.collectedByteLimit,
      maxEntryCount: plan.resourcePolicy.collectedEntryLimit,
      expectedExecutionNonce: plan.executionNonce,
      expectedSpecHash: plan.specHash,
      expectedReadyReceiptHash: ready.receiptHash,
      expectedOutputSnapshotHash: ready.receipt.outputSnapshotHash,
    });
    const completionBytes = await pollControlFile({
      dockerExecutable,
      containerId,
      name: 'collector-complete.json',
      timeoutMs: controlTimeoutMs,
      maxReceiptBytes,
      maxDiagnosticBytes,
    });
    const completion = parseColdBuildCollectorCompletionReceipt(completionBytes, {
      maxReceiptBytes,
      expectedExecutionNonce: plan.executionNonce,
      expectedSpecHash: plan.specHash,
      expectedReadyReceiptHash: ready.receiptHash,
      expectedOutputSnapshotHash: ready.receipt.outputSnapshotHash,
      expectedCollectorReceiptHash: frame.receiptHash,
      expectedCollectorFrameHash: frame.frameHash,
      expectedCollectorFrameByteLength: collectorFrameBytes.byteLength,
    });
    const inputEvidenceAfterCollection = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_collection',
      expectedContainerId: containerId,
    });
    if (inputEvidenceAfterCollection.acceptedAsExecutionInputEvidence !== true) {
      throw new Error('cold_build_execution_driver_after_collection_inputs_refused');
    }

    const releaseMaterial = buildReleaseReceipt({ plan, ready, frame, completion });
    const releasePublication = await publishExclusiveHostControlFile(
      plan.releaseHostPath,
      'release.json',
      releaseMaterial.releaseBytes,
    );
    const finalBytes = await pollControlFile({
      dockerExecutable,
      containerId,
      name: 'final.json',
      timeoutMs: plan.spec.releaseTimeoutMillis,
      maxReceiptBytes,
      maxDiagnosticBytes,
    });
    const final = parseColdBuildFinalReceipt(finalBytes, {
      maxReceiptBytes,
      expectedExecutionNonce: plan.executionNonce,
      expectedSpecHash: plan.specHash,
      expectedReadyReceiptHash: ready.receiptHash,
      expectedReleaseReceiptHash: releasePublication.contentHash,
      expectedCollectorCompletionReceiptHash: completion.receiptHash,
      expectedCollectorReceiptHash: frame.receiptHash,
      expectedCollectorFrameHash: frame.frameHash,
      expectedCollectorFrameByteLength: collectorFrameBytes.byteLength,
      expectedHostReceiptHash: releaseMaterial.hostReceiptHash,
      expectedChildExitCode: ready.receipt.childExitCode,
    });
    const finalAck = {
      schemaVersion: 'synthi.gpu_hmr.cold_build_final_ack.v1',
      executionNonce: plan.executionNonce,
      specHash: plan.specHash,
      finalReceiptHash: final.receiptHash,
    };
    const finalAckBytes = Buffer.from(stableJson(finalAck), 'utf8');
    const finalAckPublication = await publishExclusiveHostControlFile(
      plan.releaseHostPath,
      'final-ack.json',
      finalAckBytes,
    );
    const startResult = assertProcessSucceeded(await attachedCompletion, 'start');
    const observedStartStdout = Buffer.from(startResult.stdout);
    if (!observedStartStdout.equals(ready.frameBytes)) {
      throw new Error('cold_build_execution_driver_start_stdout_not_exact_ready_frame');
    }
    const finalReleaseTree = await verifyFinalReleaseTree(
      plan,
      releasePublication,
      finalAckPublication,
    );
    await verifyReleaseRootIdentity(
      plan.releaseHostPath,
      inputEvidenceAfterCollection.inputs.release,
    );
    const finalStateInspect = assertProcessSucceeded(await runDocker(
      dockerExecutable,
      ['inspect', containerId],
      {
        timeoutMs: 30_000,
        maxStdoutBytes: 4 * 1024 * 1024,
        maxStderrBytes: maxDiagnosticBytes,
        encoding: 'utf8',
      },
    ), 'final_state_inspect');
    const [finalDescriptor] = parseSingleInspect(finalStateInspect.stdout);
    const state = finalDescriptor?.State ?? {};
    if (
      state.Status !== 'exited'
      || state.Running !== false
      || state.Dead === true
      || state.OOMKilled !== false
      || state.ExitCode !== 0
    ) {
      throw new Error('cold_build_execution_driver_final_container_state_invalid');
    }
    const payloadManifest = payloadManifestFromPayloads(frame.payloads);
    const evidence = {
      schemaVersion: COLD_BUILD_EXECUTION_DRIVER_SCHEMA,
      proofAuthority: COLD_BUILD_EXECUTION_DRIVER_AUTHORITY,
      planHash: plan.planHash,
      executionNonce: plan.executionNonce,
      commandSpecHash: plan.commandSpecHash,
      sourceBindingHash: plan.sourceBindingHash,
      inputSetHash: plan.inputSetHash,
      specHash: plan.specHash,
      launcherExecutableHash: plan.launcherExecutableHash,
      containerIdHash: contentHash(containerId),
      specPublicationEvidenceHash: specPublication.evidenceHash,
      inputEvidenceBeforeCreateHash: inputEvidenceBeforeCreate.evidenceHash,
      inputEvidenceAfterCreateHash: inputEvidenceAfterCreate.evidenceHash,
      containerInspectionEvidenceHash: containerInspection.evidenceHash,
      readyReceiptHash: ready.receiptHash,
      outputSnapshotHash: ready.receipt.outputSnapshotHash,
      collectorReceiptHash: frame.receiptHash,
      collectorFrameHash: frame.frameHash,
      collectorFrameByteLength: collectorFrameBytes.byteLength,
      collectorCompletionReceiptHash: completion.receiptHash,
      inputEvidenceAfterCollectionHash: inputEvidenceAfterCollection.evidenceHash,
      releaseReceiptHash: releasePublication.contentHash,
      releasePublicationEvidenceHash: releasePublication.evidenceHash,
      hostReceiptHash: releaseMaterial.hostReceiptHash,
      finalReceiptHash: final.receiptHash,
      finalAckHash: finalAckPublication.contentHash,
      finalAckPublicationEvidenceHash: finalAckPublication.evidenceHash,
      finalReleaseTreeBindingHash: finalReleaseTree.sourceBindingHash,
      childExitCode: ready.receipt.childExitCode,
      payloadManifest,
      payloadManifestHash: contentHash(stableJson(payloadManifest)),
      protocolAccepted: true,
      acceptedAsColdBuildExecutionEvidence: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
    };
    evidence.evidenceHash = recomputeEvidenceHash(evidence);
    executionResult = {
      evidence,
      payloads: frame.payloads.map(({ entry, bytes }) => ({
        entry: { ...entry },
        bytes: Buffer.from(bytes),
      })),
    };
  } catch (error) {
    primaryError = error;
  } finally {
    cleanupEvidence = await cleanupContainer(
      dockerExecutable,
      containerReference,
      cleanupTimeoutMs,
      { containerMayExist },
    );
    if (attachedCompletion) await attachedCompletion.catch(() => {});
  }
  if (primaryError) {
    primaryError.cleanupEvidence = cleanupEvidence;
    throw primaryError;
  }
  if (cleanupEvidence.blockingGaps.length > 0) {
    const error = new Error('cold_build_execution_driver_cleanup_failed');
    error.cleanupEvidence = cleanupEvidence;
    throw error;
  }
  executionResult.evidence.cleanup = cleanupEvidence;
  executionResult.evidence.evidenceHash = recomputeEvidenceHash(executionResult.evidence);
  PINNED_DRIVER_RESULTS.set(executionResult, Object.freeze({
    plan,
    evidenceHash: executionResult.evidence.evidenceHash,
    payloadManifestHash: executionResult.evidence.payloadManifestHash,
  }));
  return executionResult;
}

export function verifyColdBuildExecutionDriverResult(result, plan) {
  const pinned = PINNED_DRIVER_RESULTS.get(result);
  const evidence = result?.evidence;
  const cleanup = evidence?.cleanup;
  let payloadManifest;
  try {
    payloadManifest = payloadManifestFromPayloads(result?.payloads);
  } catch {
    throw new Error('cold_build_execution_driver_result_invalid');
  }
  if (
    !pinned
    || pinned.plan !== plan
    || pinned.evidenceHash !== evidence?.evidenceHash
    || pinned.payloadManifestHash !== evidence?.payloadManifestHash
    || evidence?.schemaVersion !== COLD_BUILD_EXECUTION_DRIVER_SCHEMA
    || evidence?.proofAuthority !== COLD_BUILD_EXECUTION_DRIVER_AUTHORITY
    || evidence?.planHash !== plan?.planHash
    || evidence?.executionNonce !== plan?.executionNonce
    || evidence?.commandSpecHash !== plan?.commandSpecHash
    || evidence?.sourceBindingHash !== plan?.sourceBindingHash
    || evidence?.inputSetHash !== plan?.inputSetHash
    || evidence?.specHash !== plan?.specHash
    || evidence?.launcherExecutableHash !== plan?.launcherExecutableHash
    || evidence?.protocolAccepted !== true
    || evidence?.acceptedAsColdBuildExecutionEvidence !== true
    || evidence?.acceptedForGpuHmr !== false
    || evidence?.gpuHmrSuccess !== false
    || evidence?.canSatisfyRuntimeProof !== false
    || evidence?.canSatisfyDispatchProof !== false
    || !Array.isArray(evidence?.payloadManifest)
    || stableJson(payloadManifest) !== stableJson(evidence.payloadManifest)
    || contentHash(stableJson(payloadManifest)) !== evidence.payloadManifestHash
    || recomputeEvidenceHash(evidence) !== evidence.evidenceHash
    || cleanup?.schemaVersion !== 'synthi.gpu_hmr.cold_build_container_cleanup.v1'
    || cleanup?.proofAuthority !== 'container_cleanup_only_not_gpu_hmr_success'
    || cleanup?.acceptedAsCleanupEvidence !== true
    || cleanup?.absenceProven !== true
    || !Array.isArray(cleanup?.blockingGaps)
    || cleanup.blockingGaps.length !== 0
    || cleanup?.acceptedForGpuHmr !== false
    || cleanup?.gpuHmrSuccess !== false
    || cleanup?.canSatisfyRuntimeProof !== false
    || cleanup?.canSatisfyDispatchProof !== false
    || recomputeEvidenceHash(cleanup) !== cleanup.evidenceHash
  ) {
    throw new Error('cold_build_execution_driver_result_invalid');
  }
  return result;
}
