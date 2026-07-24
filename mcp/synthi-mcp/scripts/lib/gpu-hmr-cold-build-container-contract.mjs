import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import {
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  readFile,
  realpath,
  rm,
  rmdir,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import {
  observedProviderIdentityLabelAccepted,
} from './gpu-hmr-observed-provider-identity.mjs';

export const COLD_BUILD_CONTAINER_PROTOCOL_SCHEMA =
  'synthi.gpu_hmr.cold_build_container_protocol.v2';
export const COLD_BUILD_CONTAINER_PROTOCOL_AUTHORITY =
  'isolated_command_transport_only_not_gpu_hmr_success';
export const COLD_BUILD_LAUNCHER_SCHEMA =
  'synthi.gpu_hmr.cold_build_static_launcher.v3';
export const COLD_BUILD_LAUNCHER_SPEC_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_spec.v3';
export const COLD_BUILD_LAUNCHER_BUILD_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_build.v2';
export const COLD_BUILD_LAUNCHER_BUILD_AUTHORITY =
  'content_addressed_launcher_build_only_not_gpu_hmr_success';
export const COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_identity_receipt.v1';
export const COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_AUTHORITY =
  'retained_launcher_identity_only_not_gpu_hmr_success';
export const COLD_BUILD_LAUNCHER_SOURCE_MANIFEST_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_source_manifest.v1';
export const COLD_BUILD_LAUNCHER_BUILDER_RECIPE_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_builder_recipe.v1';
export const COLD_BUILD_LAUNCHER_PUBLICATION_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_publication.v1';
export const COLD_BUILD_LAUNCHER_BUILDER_IMAGE =
  'golang@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5';
export const COLD_BUILD_LAUNCHER_CONTAINER_PATH =
  '/synthi-tools/cold-build-launcher';
export const COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH = '/synthi-spec/spec.json';
export const COLD_BUILD_LAUNCHER_SOURCE_ROOT = '/workspace/source';
export const COLD_BUILD_LAUNCHER_INPUT_ROOT = '/workspace/inputs';
export const COLD_BUILD_LAUNCHER_OUTPUT_ROOT = '/workspace/build';
export const COLD_BUILD_LAUNCHER_CONTROL_ROOT = '/synthi-control';
export const COLD_BUILD_LAUNCHER_RELEASE_ROOT = '/synthi-release';
export const COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH =
  'synthi-cold-build-output-manifest.json';
export const COLD_BUILD_OUTPUT_MANIFEST_MODE_COMMAND_PROVIDED =
  'command_provided';
export const COLD_BUILD_OUTPUT_MANIFEST_MODE_LAUNCHER_GENERATED =
  'launcher_generated';
export const COLD_BUILD_OUTPUT_LABEL_MAX_BYTES = 160;
export const COLD_BUILD_CONTAINER_COMMAND_UID = 65532;
export const COLD_BUILD_CONTAINER_COMMAND_GID = 65532;
export const COLD_BUILD_CONTAINER_CONTROL_TMPFS_BYTES = 1024 * 1024;
export const COLD_BUILD_CONTAINER_TMP_BYTES = 2 * 1024 * 1024 * 1024;
export const COLD_BUILD_CONTAINER_READY_POLL_MS = 50;
export const COLD_BUILD_CONTAINER_EXTRACTION_TIMEOUT_MS = 60_000;
export const COLD_BUILD_CONTAINER_RELEASE_TIMEOUT_MS = 60_000;
export const COLD_BUILD_CONTAINER_PROCESS_TERM_GRACE_MS = 500;
export const COLD_BUILD_CONTAINER_PROCESS_KILL_GRACE_MS = 2_000;
export const COLD_BUILD_HOST_PROCESS_KILL_CONFIRMATION_MS = 5_000;
export const COLD_BUILD_CONTAINER_CAPABILITIES = [
  'DAC_READ_SEARCH',
  'KILL',
  'SETGID',
  'SETPCAP',
  'SETUID',
].sort();
export const COLD_BUILD_COLLECTOR_FRAME_MAGIC = Buffer.from(
  'SYNTHI-COLD-BUILD-COLLECT-V1\n',
  'ascii',
);
export const COLD_BUILD_CONTROL_FRAME_MAGIC = Buffer.from(
  'SYNTHI-COLD-BUILD-CONTROL-V1\n',
  'ascii',
);
export const COLD_BUILD_COLLECTOR_COMPLETION_SCHEMA =
  'synthi.gpu_hmr.cold_build_collector_completion.v1';
export const COLD_BUILD_LAUNCHER_BUILDER_LABEL =
  'synthi.gpu_hmr.cold_build_launcher_builder=true';
export const COLD_BUILD_LAUNCHER_STALE_STATE_MS = 60 * 60 * 1000;
export const COLD_BUILD_LAUNCHER_CLEANUP_MAX_SCANNED_ENTRIES = 1024;
export const COLD_BUILD_LAUNCHER_CLEANUP_MAX_MATCHED_ENTRIES = 128;
export const COLD_BUILD_LAUNCHER_CLEANUP_TIMEOUT_MS = 5_000;

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const COLD_BUILD_LAUNCHER_SOURCE_PATH = path.resolve(
  MODULE_DIR,
  '..',
  'native',
  'cold-build-launcher',
  'main.go',
);

const ATTESTED_LAUNCHER_HASHES_BY_PROVIDER_IDENTITY = Object.freeze({
  amd64: 'sha256:44ee25aee904e7ee09c345a121b15449251ad765ce95c31a9c3766b89afe5aaf',
  arm64: 'sha256:4ee9b485435d1b7c30fc1c73871a9cd45d38c23c1f126d390a0876003c36fe9a',
});
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const PINNED_LAUNCHER_IDENTITIES = new WeakMap();
const COLD_BUILD_LAUNCHER_SOURCE_IDENTITY_KEYS = Object.freeze([
  'schemaVersion',
  'sourceHash',
  'byteLength',
  'repoRelativePath',
  'manifestHash',
]);
const COLD_BUILD_LAUNCHER_BUILD_EVIDENCE_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'sourceHash',
  'sourceByteLength',
  'sourceRepoRelativePath',
  'sourceManifestSchema',
  'sourceManifestHash',
  'sourceManifestRevalidated',
  'builderImage',
  'builderRecipeSchema',
  'builderRecipeHash',
  'architecture',
  'operatingSystem',
  'staticExecutable',
  'elfProgramHeaderTypes',
  'binaryHash',
  'expectedBinaryHash',
  'binaryByteLength',
  'reproducibleHashMatched',
  'cacheAccepted',
  'cacheHit',
  'immutableContentAddressedPublication',
  'mutableBuildLockUsed',
  'publicationKeyHash',
  'publicationManifestHash',
  'publicationDirectoryName',
  'publicationOutcome',
  'publicationCreated',
  'publicationRaceObserved',
  'publicationPreLinkCoordinationUsed',
  'publicationPrimitive',
  'publicationSameDevice',
  'publicationFileSyncStatus',
  'publicationFileSyncErrorCode',
  'publicationFileSyncIdentityVerified',
  'publicationDirectorySyncBeforeLinkStatus',
  'publicationDirectorySyncBeforeLinkErrorCode',
  'publicationDirectorySyncAfterLinkStatus',
  'publicationDirectorySyncAfterLinkErrorCode',
  'publicationDirectorySyncAfterCleanupStatus',
  'publicationDirectorySyncAfterCleanupErrorCode',
  'publicationIntegrityAccepted',
  'executionTimePathBindingRequired',
  'canAuthorizeLauncherExecution',
  'publicationDurabilityProven',
  'publicationDurabilityStatus',
  'publicationDirectoryHierarchySyncAttempted',
  'publicationDirectoryHierarchySyncAccepted',
  'publicationDirectoryHierarchySyncCount',
  'publicationDirectoryHierarchySyncSyncedCount',
  'publicationDirectoryHierarchySyncUnsupportedCount',
  'publicationDirectoryHierarchySyncEvidenceHash',
  'finalBinaryVerified',
  'finalBinaryVerifiedAfterDirectoryRevalidation',
  'finalBinaryRegularFile',
  'finalBinarySymbolicLink',
  'finalBinaryStableIdentity',
  'finalBinaryStableMetadata',
  'finalBinarySecondHandleIdentityVerified',
  'finalBinaryCanonicalPathStable',
  'finalBinaryImmutableMode',
  'finalBinaryExecutableModeObserved',
  'finalBinaryExecutableModeApplicable',
  'finalBinaryExecutableModeAccepted',
  'finalBinaryMode',
  'finalBinaryInodeIdentityHash',
  'finalBinaryLinkCount',
  'trustedCacheRootAccepted',
  'trustedCacheRootRevalidated',
  'trustedCacheRootPermissionVerification',
  'trustedCacheRootPermissionOwnershipRecomputed',
  'trustedCacheRootPermissionLimitation',
  'trustedCacheRootEvidenceHash',
  'trustedCacheRootIdentityRevalidated',
  'trustedCacheRootAncestorCount',
  'trustedCacheRootAncestorEvidenceHash',
  'trustedCacheRootAncestorRevalidated',
  'publicationDirectoryChainAccepted',
  'publicationDirectoryChainEvidenceHash',
  'publicationDirectoryRevalidated',
  'staleCandidateCleanupAccepted',
  'staleCandidateCleanupScannedCount',
  'staleCandidateCleanupRemovedCount',
  'staleCandidateCleanupRecentIgnoredCount',
  'staleCandidateCleanupFutureTimestampCount',
  'staleCandidateCleanupLeafRemovalAttemptCount',
  'staleCandidateCleanupNonEmptyRetainedCount',
  'staleCandidateCleanupRecursiveTraversalUsed',
  'staleCandidateCleanupBoundedLimitExceeded',
  'staleCandidateCleanupEvidenceHash',
  'staleBuildCleanupAccepted',
  'staleBuildCleanupScannedCount',
  'staleBuildCleanupRemovedCount',
  'staleBuildCleanupRecentIgnoredCount',
  'staleBuildCleanupFutureTimestampCount',
  'staleBuildCleanupLeafRemovalAttemptCount',
  'staleBuildCleanupNonEmptyRetainedCount',
  'staleBuildCleanupRecursiveTraversalUsed',
  'staleBuildCleanupBoundedLimitExceeded',
  'staleBuildCleanupEvidenceHash',
  'directoryLeaseCount',
  'directoryLeasesHeldThroughVerification',
  'directoryLeaseStatBoundCount',
  'directoryLeaseFallbackCount',
  'directoryLeaseStatBindingAccepted',
  'directoryLeaseFallbackLimitation',
  'coalescedPublicationWait',
  'buildExecuted',
  'buildCommandHash',
  'buildExitCode',
  'buildStdoutHash',
  'buildStderrHash',
  'builderContainerIdentityHash',
  'builderCleanupAttempted',
  'builderCleanupAccepted',
  'builderCleanupRemovalExitCode',
  'builderCleanupAbsenceObservationExitCode',
  'builderCleanupEvidenceHash',
  'accepted',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);
const COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_KEYS = Object.freeze([
  'schemaVersion',
  'proofAuthority',
  'architecture',
  'binaryHash',
  'sourceIdentity',
  'buildEvidence',
  'launcherBinaryBytesEmbedded',
  'executionTimePathBindingRequired',
  'acceptedAsColdBuildLauncherIdentityReceipt',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'canSatisfyRuntimeProof',
  'canSatisfyDispatchProof',
  'evidenceHash',
]);
const DIRECTORY_SYNC_UNSUPPORTED_CODES = new Set([
  'EBADF',
  'EISDIR',
  'EINVAL',
  'ENOSYS',
  'ENOTSUP',
  'EOPNOTSUPP',
  'EPERM',
]);

function contentHash(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
    .join(',')}}`;
}

function normalizeProviderIdentity(value) {
  return observedProviderIdentityLabelAccepted(value) ? value : null;
}

const COLD_BUILD_DOCKER_REDIRECT_ENVIRONMENT_NAMES = new Set([
  'BUILDKIT_HOST',
  'BUILDX_CONFIG',
  'CONTAINER_CONNECTION',
  'CONTAINER_HOST',
]);

export function coldBuildDockerHostEnvironment(source = process.env) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('cold_build_docker_host_environment_invalid');
  }
  const environment = {};
  for (const [name, value] of Object.entries(source)) {
    const normalizedName = String(name).toUpperCase();
    if (
      normalizedName.startsWith('DOCKER_')
      || COLD_BUILD_DOCKER_REDIRECT_ENVIRONMENT_NAMES.has(normalizedName)
    ) {
      continue;
    }
    if (typeof value === 'string') environment[name] = value;
  }
  return environment;
}

export function runColdBuildHostProcess(executable, args, {
  timeoutMs = 120_000,
  maxStdoutBytes = 1024 * 1024,
  maxStderrBytes = 1024 * 1024,
  encoding = 'utf8',
  onStdoutChunk = null,
  environment = process.env,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: environment,
      });
    } catch (error) {
      resolve({
        exitCode: null,
        signal: null,
        timedOut: false,
        error: error?.message || String(error),
        stdout: encoding ? '' : Buffer.alloc(0),
        stderr: encoding ? '' : Buffer.alloc(0),
        elapsedMs: Date.now() - startedAt,
        directProcessTermination: null,
      });
      return;
    }
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let outputExceeded = false;
    let timedOut = false;
    let settled = false;
    let terminationReason = null;
    let directProcessTermination = null;
    let timeoutTimer = null;
    let killConfirmationTimer = null;
    const finish = ({ exitCode, signal, error }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      clearTimeout(killConfirmationTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.unref();
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolve({
        exitCode,
        signal,
        timedOut,
        error,
        stdout: encoding ? stdoutBuffer.toString(encoding) : stdoutBuffer,
        stderr: encoding ? stderrBuffer.toString(encoding) : stderrBuffer,
        elapsedMs: Date.now() - startedAt,
        directProcessTermination,
      });
    };
    const requestTermination = (reason) => {
      if (terminationReason !== null || settled) return;
      terminationReason = reason;
      clearTimeout(timeoutTimer);
      if (child.exitCode !== null || child.signalCode !== null) {
        directProcessTermination = {
          attempted: false,
          processId: Number.isSafeInteger(child.pid) ? child.pid : null,
          signal: null,
          killRequestAccepted: null,
          killRequestError: null,
          alreadyExited: true,
          exitObserved: true,
          confirmedExited: true,
          exitCode: child.exitCode,
          exitSignal: child.signalCode,
        };
        finish({
          exitCode: child.exitCode,
          signal: child.signalCode,
          error: reason,
        });
        return;
      }
      let killRequestAccepted = false;
      let killRequestError = null;
      try {
        killRequestAccepted = child.kill('SIGKILL');
      } catch (error) {
        killRequestError = error?.message || String(error);
      }
      directProcessTermination = {
        attempted: true,
        processId: Number.isSafeInteger(child.pid) ? child.pid : null,
        signal: 'SIGKILL',
        killRequestAccepted,
        killRequestError,
        alreadyExited: false,
        exitObserved: false,
        confirmedExited: false,
        exitCode: null,
        exitSignal: null,
      };
      killConfirmationTimer = setTimeout(() => {
        finish({
          exitCode: null,
          signal: null,
          error: `${reason}:direct_process_termination_unconfirmed`,
        });
      }, COLD_BUILD_HOST_PROCESS_KILL_CONFIRMATION_MS);
    };
    const append = (chunks, chunk, currentBytes, maximumBytes) => {
      const remaining = Math.max(0, maximumBytes - currentBytes);
      if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
      if (chunk.byteLength > remaining) outputExceeded = true;
      return currentBytes + chunk.byteLength;
    };
    child.stdout.on('data', (chunk) => {
      const bytes = Buffer.from(chunk);
      try {
        onStdoutChunk?.(bytes);
      } catch {
        requestTermination('process_stdout_consumer_failed');
      }
      stdoutBytes = append(stdout, bytes, stdoutBytes, maxStdoutBytes);
      if (outputExceeded) requestTermination('process_output_limit_exceeded');
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes = append(
        stderr,
        Buffer.from(chunk),
        stderrBytes,
        maxStderrBytes,
      );
      if (outputExceeded) requestTermination('process_output_limit_exceeded');
    });
    timeoutTimer = setTimeout(() => {
      timedOut = true;
      requestTermination('process_timeout');
    }, timeoutMs);
    child.once('error', (error) => {
      if (terminationReason !== null) return;
      finish({
        exitCode: null,
        signal: null,
        error: error?.message || String(error),
      });
    });
    child.once('exit', (exitCode, signal) => {
      if (terminationReason === null || settled) return;
      directProcessTermination = {
        ...directProcessTermination,
        exitObserved: true,
        confirmedExited: true,
        exitCode,
        exitSignal: signal,
      };
      finish({
        exitCode,
        signal,
        error: terminationReason,
      });
    });
    child.once('close', (exitCode, signal) => {
      if (terminationReason !== null) return;
      finish({
        exitCode,
        signal,
        error: terminationReason ?? (outputExceeded ? 'process_output_limit_exceeded' : null),
      });
    });
  });
}

function runProcess(executable, args, { timeoutMs = 120_000, maxOutputBytes = 1024 * 1024 } = {}) {
  return runColdBuildHostProcess(executable, args, {
    timeoutMs,
    maxStdoutBytes: maxOutputBytes,
    maxStderrBytes: maxOutputBytes,
    encoding: 'utf8',
    environment: coldBuildDockerHostEnvironment(),
  });
}

function normalizedPathIdentity(value) {
  let normalized = path.normalize(path.resolve(value));
  if (process.platform === 'win32') {
    if (normalized.startsWith('\\\\?\\UNC\\')) {
      normalized = `\\\\${normalized.slice('\\\\?\\UNC\\'.length)}`;
    } else if (normalized.startsWith('\\\\?\\')) {
      normalized = normalized.slice('\\\\?\\'.length);
    }
    normalized = normalized.toLowerCase();
  }
  const root = path.parse(normalized).root;
  while (normalized.length > root.length && normalized.endsWith(path.sep)) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function exactKeys(value, keys) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && stableJson(Object.keys(value).sort()) === stableJson([...keys].sort());
}

function recomputeEvidenceHash(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  return contentHash(stableJson(projection));
}

function normalizeDeclaredOutputPath(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || Buffer.byteLength(value, 'utf8') > 32 * 1024
    || /[\\\0\r\n]/.test(value)
  ) {
    throw new Error('cold_build_launcher_declared_output_path_invalid');
  }
  const normalized = path.posix.normalize(value);
  if (
    normalized !== value
    || normalized === '.'
    || normalized === COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH
    || normalized.startsWith('../')
    || path.posix.isAbsolute(normalized)
    || path.win32.isAbsolute(normalized)
  ) {
    throw new Error('cold_build_launcher_declared_output_path_invalid');
  }
  return normalized;
}

function normalizeDeclaredOutputLabel(value) {
  if (
    typeof value !== 'string'
    || value.length < 1
    || Buffer.byteLength(value, 'utf8') > COLD_BUILD_OUTPUT_LABEL_MAX_BYTES
    || /[\0\r\n]/.test(value)
  ) {
    throw new Error('cold_build_launcher_declared_output_label_invalid');
  }
  return value;
}

function normalizeDeclaredOutputs(mode, declaredOutputs, collectedEntryLimit) {
  if (!Array.isArray(declaredOutputs)) {
    throw new Error('cold_build_launcher_declared_outputs_invalid');
  }
  if (mode === COLD_BUILD_OUTPUT_MANIFEST_MODE_COMMAND_PROVIDED) {
    if (declaredOutputs.length !== 0) {
      throw new Error('cold_build_launcher_command_provided_outputs_invalid');
    }
    return [];
  }
  if (
    mode !== COLD_BUILD_OUTPUT_MANIFEST_MODE_LAUNCHER_GENERATED
    || !Number.isSafeInteger(collectedEntryLimit)
    || declaredOutputs.length < 1
    || declaredOutputs.length > collectedEntryLimit - 1
  ) {
    throw new Error('cold_build_launcher_declared_outputs_invalid');
  }
  const normalized = declaredOutputs.map((output) => {
    if (!exactKeys(output, ['path', 'role', 'artifactKind', 'mediaType'])) {
      throw new Error('cold_build_launcher_declared_output_shape_invalid');
    }
    return {
      path: normalizeDeclaredOutputPath(output.path),
      role: normalizeDeclaredOutputLabel(output.role),
      artifactKind: normalizeDeclaredOutputLabel(output.artifactKind),
      mediaType: normalizeDeclaredOutputLabel(output.mediaType),
    };
  }).sort((left, right) => Buffer.compare(
    Buffer.from(left.path, 'utf8'),
    Buffer.from(right.path, 'utf8'),
  ));
  if (new Set(normalized.map(({ path: outputPath }) => outputPath)).size !== normalized.length) {
    throw new Error('cold_build_launcher_declared_output_duplicate');
  }
  return normalized;
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

function sameFileMetadata(left, right) {
  return left?.size === right?.size
    && left?.mode === right?.mode
    && left?.nlink === right?.nlink
    && left?.uid === right?.uid
    && left?.gid === right?.gid
    && left?.mtimeNs === right?.mtimeNs
    && left?.ctimeNs === right?.ctimeNs;
}

async function inspectLauncherFile(filePath, expectedHash, {
  requireImmutable = true,
} = {}) {
  let before;
  let beforeCanonicalPath;
  try {
    before = await lstat(filePath, { bigint: true });
    beforeCanonicalPath = await realpath(filePath);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { present: false, accepted: false, reason: 'missing' };
    }
    return {
      present: true,
      accepted: false,
      reason: `lstat_failed:${error?.code || 'unknown'}`,
    };
  }
  if (before.isSymbolicLink()) {
    return { present: true, accepted: false, reason: 'symbolic_link' };
  }
  if (!before.isFile()) {
    return { present: true, accepted: false, reason: 'not_regular_file' };
  }
  const readFlags = fsConstants.O_RDONLY
    | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  let handle;
  let verificationHandle;
  try {
    handle = await open(filePath, readFlags);
    const opened = await handle.stat({ bigint: true });
    const bytes = await handle.readFile();
    const afterRead = await handle.stat({ bigint: true });
    const afterPath = await lstat(filePath, { bigint: true });
    verificationHandle = await open(filePath, readFlags);
    const verificationOpened = await verificationHandle.stat({ bigint: true });
    const finalPath = await lstat(filePath, { bigint: true });
    const finalCanonicalPath = await realpath(filePath);
    const binaryHash = contentHash(bytes);
    const executable = (verificationOpened.mode & 0o111n) !== 0n;
    const executableModeApplicable = process.platform !== 'win32';
    const executableModeAccepted = !executableModeApplicable || executable;
    const immutableMode = (verificationOpened.mode & 0o222n) === 0n;
    const stableIdentity = samePathFileIdentity(before, afterPath)
      && samePathFileIdentity(afterPath, finalPath)
      && samePathFileIdentity(finalPath, verificationOpened)
      && sameOpenFileIdentity(opened, afterRead)
      && sameOpenFileIdentity(afterRead, verificationOpened);
    const stableMetadata = sameFileMetadata(before, opened)
      && sameFileMetadata(opened, afterRead)
      && sameFileMetadata(afterRead, afterPath)
      && sameFileMetadata(afterPath, verificationOpened)
      && sameFileMetadata(verificationOpened, finalPath);
    const canonicalPathStable = normalizedPathIdentity(beforeCanonicalPath)
      === normalizedPathIdentity(filePath)
      && normalizedPathIdentity(finalCanonicalPath)
        === normalizedPathIdentity(filePath);
    const invariantFailures = [];
    if (
      !opened.isFile()
      || !afterRead.isFile()
      || !afterPath.isFile()
      || !verificationOpened.isFile()
      || !finalPath.isFile()
    ) {
      invariantFailures.push('not_regular_file');
    }
    if (afterPath.isSymbolicLink() || finalPath.isSymbolicLink()) {
      invariantFailures.push('symbolic_link');
    }
    if (!stableIdentity) invariantFailures.push('unstable_identity');
    if (!stableMetadata) invariantFailures.push('unstable_metadata');
    if (!canonicalPathStable) invariantFailures.push('canonical_path_changed');
    if (opened.size <= 0n) invariantFailures.push('empty_file');
    if (
      opened.size !== BigInt(bytes.byteLength)
      || afterRead.size !== BigInt(bytes.byteLength)
      || afterPath.size !== BigInt(bytes.byteLength)
      || verificationOpened.size !== BigInt(bytes.byteLength)
      || finalPath.size !== BigInt(bytes.byteLength)
    ) invariantFailures.push('size_mismatch');
    if (!executableModeAccepted) invariantFailures.push('not_executable');
    if (requireImmutable && !immutableMode) invariantFailures.push('mutable_mode');
    if (binaryHash !== expectedHash) invariantFailures.push('hash_mismatch');
    const accepted = invariantFailures.length === 0;
    return {
      present: true,
      accepted,
      reason: accepted
        ? null
        : `launcher_file_invariant_failed:${invariantFailures.join(',')}`,
      bytes,
      binaryHash,
      byteLength: bytes.byteLength,
      regularFile: opened.isFile()
        && afterRead.isFile()
        && afterPath.isFile()
        && verificationOpened.isFile()
        && finalPath.isFile(),
      symbolicLink: before.isSymbolicLink()
        || afterPath.isSymbolicLink()
        || finalPath.isSymbolicLink(),
      stableIdentity,
      stableMetadata,
      canonicalPathStable,
      secondHandleIdentityVerified: sameOpenFileIdentity(afterRead, verificationOpened),
      executable,
      executableModeApplicable,
      executableModeAccepted,
      immutableMode,
      mode: Number(verificationOpened.mode & 0o777n),
      device: String(verificationOpened.dev),
      pathDevice: String(finalPath.dev),
      linkCount: Number(verificationOpened.nlink),
      inodeIdentityHash: contentHash(
        `${verificationOpened.dev}:${verificationOpened.ino}`,
      ),
    };
  } catch (error) {
    return {
      present: true,
      accepted: false,
      reason: `read_failed:${error?.code || 'unknown'}`,
    };
  } finally {
    await verificationHandle?.close().catch(() => {});
    await handle?.close().catch(() => {});
  }
}

async function inspectLauncherFileUntilStable(filePath, expectedHash, {
  timeoutMs = 5_000,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  let inspection = null;
  do {
    inspection = await inspectLauncherFile(filePath, expectedHash);
    if (inspection.accepted) return inspection;
    if (!/unstable_(identity|metadata)/.test(inspection.reason || '')) return inspection;
    await sleep(10);
  } while (Date.now() <= deadline);
  return {
    ...inspection,
    reason: `transient_identity_timeout:${inspection?.reason || 'unknown'}`,
  };
}

async function inspectPrivateDirectory(directoryPath) {
  const requestedPath = path.resolve(directoryPath);
  let metadata;
  let canonicalPath;
  try {
    metadata = await lstat(requestedPath, { bigint: true });
    canonicalPath = await realpath(requestedPath);
  } catch (error) {
    return {
      accepted: false,
      reason: `directory_inspection_failed:${error?.code || 'unknown'}`,
    };
  }
  const ownerUidMatched = typeof process.getuid === 'function'
    ? metadata.uid === BigInt(process.getuid())
    : null;
  const privateModeApplicable = process.platform !== 'win32';
  const privateModeAccepted = !privateModeApplicable || (metadata.mode & 0o022n) === 0n;
  const pathIdentityMatched = normalizedPathIdentity(canonicalPath)
    === normalizedPathIdentity(requestedPath);
  const accepted = metadata.isDirectory()
    && !metadata.isSymbolicLink()
    && pathIdentityMatched
    && ownerUidMatched !== false
    && privateModeAccepted;
  return {
    accepted,
    reason: accepted ? null : 'private_directory_invariant_failed',
    directory: metadata.isDirectory(),
    symbolicLink: metadata.isSymbolicLink(),
    pathIdentityMatched,
    ownerUidMatched,
    privateModeApplicable,
    privateModeAccepted,
    permissionVerification: privateModeApplicable
      ? 'posix_owner_and_group_other_write_mode'
      : 'windows_reparse_and_canonical_path_only_acl_not_recomputed',
    platformPermissionOwnershipRecomputed: privateModeApplicable,
    mode: Number(metadata.mode & 0o777n),
    device: String(metadata.dev),
    inode: String(metadata.ino),
    identityHash: contentHash(`${metadata.dev}:${metadata.ino}`),
    requestedPathHash: contentHash(normalizedPathIdentity(requestedPath)),
    canonicalPathHash: contentHash(normalizedPathIdentity(canonicalPath)),
  };
}

function isPathWithin(candidatePath, parentPath) {
  const candidate = normalizedPathIdentity(candidatePath);
  const parent = normalizedPathIdentity(parentPath);
  const relative = path.relative(parent, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function inspectCacheRootAncestors(cacheRoot) {
  const observations = [];
  let current = path.dirname(path.resolve(cacheRoot));
  for (;;) {
    const inspection = await inspectPrivateDirectory(current);
    let writeIsolationAccepted = inspection.accepted;
    let stickyDirectory = null;
    let ownerTrusted = null;
    if (process.platform !== 'win32') {
      const metadata = await lstat(current, { bigint: true });
      const groupOrOtherWritable = (metadata.mode & 0o022n) !== 0n;
      stickyDirectory = (metadata.mode & 0o1000n) !== 0n;
      ownerTrusted = metadata.uid === 0n
        || metadata.uid === BigInt(process.getuid());
      writeIsolationAccepted = inspection.directory
        && !inspection.symbolicLink
        && inspection.pathIdentityMatched
        && ownerTrusted
        && (!groupOrOtherWritable || stickyDirectory);
    }
    observations.push({
      pathHash: contentHash(normalizedPathIdentity(current)),
      identityHash: inspection.identityHash ?? null,
      writeIsolationAccepted,
      stickyDirectory,
      ownerTrusted,
    });
    if (!writeIsolationAccepted) {
      return { accepted: false, observations };
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return { accepted: true, observations };
}

async function requirePrivateDirectory(directoryPath, errorCode) {
  const inspection = await inspectPrivateDirectory(directoryPath);
  if (!inspection.accepted) {
    throw new Error(`${errorCode}:${inspection.reason}`);
  }
  return inspection;
}

async function openPrivateDirectoryLease(directoryPath) {
  const before = await requirePrivateDirectory(
    directoryPath,
    'cold_build_launcher_directory_lease_untrusted',
  );
  const openFlags = fsConstants.O_RDONLY
    | (fsConstants.O_DIRECTORY ?? 0)
    | (fsConstants.O_NOFOLLOW ?? 0);
  let fileHandle = null;
  try {
    fileHandle = await open(directoryPath, openFlags);
    const opened = await fileHandle.stat({ bigint: true });
    const after = await requirePrivateDirectory(
      directoryPath,
      'cold_build_launcher_directory_lease_changed',
    );
    if (
      after.identityHash !== before.identityHash
      || !opened.isDirectory()
      || (process.platform === 'win32'
        ? String(opened.ino) !== before.inode
        : contentHash(`${opened.dev}:${opened.ino}`) !== before.identityHash)
    ) {
      throw new Error('cold_build_launcher_directory_lease_identity_changed');
    }
    return {
      close: () => fileHandle.close(),
      identityHash: before.identityHash,
      statBound: true,
      leaseMethod: 'directory_file_handle_stat_bound',
    };
  } catch (error) {
    await fileHandle?.close().catch(() => {});
    if (
      process.platform !== 'win32'
      || !DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)
    ) throw error;
  }
  const directoryHandle = await opendir(directoryPath);
  try {
    const after = await requirePrivateDirectory(
      directoryPath,
      'cold_build_launcher_directory_lease_changed',
    );
    if (after.identityHash !== before.identityHash) {
      throw new Error('cold_build_launcher_directory_lease_identity_changed');
    }
    return {
      close: () => directoryHandle.close(),
      identityHash: before.identityHash,
      statBound: false,
      leaseMethod: 'windows_directory_iterator_path_bound',
    };
  } catch (error) {
    await directoryHandle.close().catch(() => {});
    throw error;
  }
}

async function closePrivateDirectoryLeases(leases) {
  const failures = [];
  for (const lease of [...leases].reverse()) {
    try {
      await lease.close();
    } catch (error) {
      failures.push(error?.code || 'unknown');
    }
  }
  if (failures.length > 0) {
    throw new Error(`cold_build_launcher_directory_lease_close_failed:${failures.join(',')}`);
  }
}

async function prepareTrustedCacheRoot(cacheRoot) {
  const resolvedRoot = path.resolve(cacheRoot);
  if (
    process.platform === 'win32'
    && !isPathWithin(resolvedRoot, coldBuildLauncherDefaultCacheBase())
  ) {
    throw new Error('cold_build_launcher_cache_root_untrusted:outside_user_cache_base');
  }
  try {
    await mkdir(resolvedRoot, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new Error(
      `cold_build_launcher_cache_root_untrusted:mkdir_failed:${error?.code || 'unknown'}`,
    );
  }
  const inspection = await requirePrivateDirectory(
    resolvedRoot,
    'cold_build_launcher_cache_root_untrusted',
  );
  const ancestors = await inspectCacheRootAncestors(resolvedRoot);
  if (!ancestors.accepted) {
    throw new Error('cold_build_launcher_cache_root_untrusted:ancestor_write_isolation_failed');
  }
  return {
    resolvedRoot,
    inspection,
    ancestorEvidenceHash: contentHash(stableJson(ancestors.observations)),
    ancestorCount: ancestors.observations.length,
  };
}

async function preparePrivateDirectoryChain(cacheRoot, relativeSegments) {
  let current = path.resolve(cacheRoot);
  const inspections = [];
  const paths = [];
  for (const segment of relativeSegments) {
    if (
      typeof segment !== 'string'
      || segment.length === 0
      || segment === '.'
      || segment === '..'
      || path.basename(segment) !== segment
    ) {
      throw new Error('cold_build_launcher_publication_segment_invalid');
    }
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    inspections.push(await requirePrivateDirectory(
      current,
      'cold_build_launcher_publication_directory_untrusted',
    ));
    paths.push(current);
  }
  return { directoryPath: current, inspections, paths };
}

async function removeStaleEntryWithoutTraversal(entryPath, {
  deadlineMs,
  entryKind,
}) {
  if (Date.now() > deadlineMs) throw new Error('cleanup_timeout');
  let metadata;
  try {
    metadata = await lstat(entryPath, { bigint: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return { removed: false, disappeared: true };
    throw error;
  }
  if (metadata.isSymbolicLink()) {
    await rm(entryPath, { force: true });
    return { removed: true, disappeared: false, nonEmptyRetained: false };
  }
  if (entryKind === 'candidate') {
    if (!metadata.isFile()) throw new Error('cleanup_entry_type_invalid');
    await rm(entryPath, { force: true });
    return { removed: true, disappeared: false, nonEmptyRetained: false };
  }
  if (!metadata.isDirectory()) throw new Error('cleanup_entry_type_invalid');
  try {
    await rmdir(entryPath);
    return { removed: true, disappeared: false, nonEmptyRetained: false };
  } catch (error) {
    if (!['ENOTEMPTY', 'EEXIST'].includes(error?.code)) throw error;
  }
  const retained = await lstat(entryPath, { bigint: true });
  if (
    !retained.isDirectory()
    || retained.isSymbolicLink()
    || !samePathFileIdentity(metadata, retained)
  ) {
    throw new Error('cleanup_entry_identity_changed');
  }
  return { removed: false, disappeared: false, nonEmptyRetained: true };
}

async function cleanupStaleCacheEntries(directoryPath, {
  prefix,
  entryKind,
  nowMs = Date.now(),
}) {
  const deadlineMs = nowMs + COLD_BUILD_LAUNCHER_CLEANUP_TIMEOUT_MS;
  const projection = {
    entryKind,
    prefixHash: contentHash(prefix),
    scannedCount: 0,
    matchedCount: 0,
    staleRemovedCount: 0,
    recentIgnoredCount: 0,
    futureTimestampCount: 0,
    invalidTypeCount: 0,
    removalFailureCount: 0,
    leafRemovalAttemptCount: 0,
    nonEmptyRetainedCount: 0,
    recursiveTraversalUsed: false,
    boundedLimitExceeded: false,
  };
  const directory = await opendir(directoryPath);
  try {
    for await (const entry of directory) {
      projection.scannedCount += 1;
      if (
        projection.scannedCount > COLD_BUILD_LAUNCHER_CLEANUP_MAX_SCANNED_ENTRIES
        || Date.now() > deadlineMs
      ) {
        projection.boundedLimitExceeded = true;
        break;
      }
      if (!entry.name.startsWith(prefix)) continue;
      projection.matchedCount += 1;
      if (projection.matchedCount > COLD_BUILD_LAUNCHER_CLEANUP_MAX_MATCHED_ENTRIES) {
        projection.boundedLimitExceeded = true;
        break;
      }
      const entryPath = path.join(directoryPath, entry.name);
      let metadata;
      try {
        metadata = await lstat(entryPath);
      } catch (error) {
        if (error?.code === 'ENOENT') continue;
        projection.removalFailureCount += 1;
        continue;
      }
      const futureTimestamp = metadata.mtimeMs > nowMs + 5 * 60 * 1000;
      if (futureTimestamp) projection.futureTimestampCount += 1;
      if (!futureTimestamp && nowMs - metadata.mtimeMs < COLD_BUILD_LAUNCHER_STALE_STATE_MS) {
        projection.recentIgnoredCount += 1;
        continue;
      }
      const typeAccepted = entryKind === 'candidate'
        ? metadata.isFile() || metadata.isSymbolicLink()
        : metadata.isDirectory() || metadata.isSymbolicLink();
      if (!typeAccepted) {
        projection.invalidTypeCount += 1;
        continue;
      }
      try {
        projection.leafRemovalAttemptCount += 1;
        const removal = await removeStaleEntryWithoutTraversal(entryPath, {
          deadlineMs,
          entryKind,
        });
        if (removal.removed) projection.staleRemovedCount += 1;
        if (removal.nonEmptyRetained) projection.nonEmptyRetainedCount += 1;
      } catch (error) {
        if (/cleanup_timeout/.test(error?.message || '')) {
          projection.boundedLimitExceeded = true;
        }
        projection.removalFailureCount += 1;
      }
    }
  } finally {
    await directory.close().catch((error) => {
      if (error?.code !== 'ERR_DIR_CLOSED') throw error;
    });
  }
  const accepted = projection.invalidTypeCount === 0
    && projection.removalFailureCount === 0
    && projection.boundedLimitExceeded === false;
  return {
    ...projection,
    accepted,
    evidenceHash: contentHash(stableJson(projection)),
  };
}

async function syncDirectory(directoryPath) {
  const flags = fsConstants.O_RDONLY
    | (process.platform === 'win32' ? 0 : (fsConstants.O_DIRECTORY ?? 0));
  let handle;
  try {
    handle = await open(directoryPath, flags);
    await handle.sync();
    return { status: 'synced', errorCode: null };
  } catch (error) {
    if (DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) {
      return { status: 'unsupported', errorCode: error.code };
    }
    throw new Error(
      `cold_build_launcher_publication_directory_sync_failed:${error?.code || 'unknown'}`,
    );
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function syncDirectoryHierarchy(directoryPath) {
  const observations = [];
  let current = path.resolve(directoryPath);
  for (;;) {
    const sync = await syncDirectory(current);
    observations.push({
      pathHash: contentHash(normalizedPathIdentity(current)),
      status: sync.status,
      errorCode: sync.errorCode,
    });
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const projection = {
    directoryCount: observations.length,
    syncedCount: observations.filter((observation) => observation.status === 'synced').length,
    unsupportedCount: observations.filter(
      (observation) => observation.status === 'unsupported',
    ).length,
    observations,
  };
  return {
    ...projection,
    accepted: projection.syncedCount === projection.directoryCount,
    evidenceHash: contentHash(stableJson(projection)),
  };
}

async function syncPublishedLauncherFile(filePath, expectedHash) {
  const before = await inspectLauncherFileUntilStable(filePath, expectedHash);
  if (!before.accepted) {
    throw new Error(`cold_build_launcher_published_file_sync_invalid:${before.reason}`);
  }
  const flags = fsConstants.O_RDONLY
    | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  let handle;
  let status = 'not_attempted';
  let errorCode = null;
  try {
    handle = await open(filePath, flags);
    const opened = await handle.stat({ bigint: true });
    if (
      !opened.isFile()
      || contentHash(`${opened.dev}:${opened.ino}`) !== before.inodeIdentityHash
    ) {
      throw new Error('cold_build_launcher_published_file_sync_identity_changed');
    }
    try {
      await handle.sync();
      status = 'synced';
    } catch (error) {
      if (!DIRECTORY_SYNC_UNSUPPORTED_CODES.has(error?.code)) throw error;
      status = 'unsupported';
      errorCode = error.code;
    }
    const afterSync = await handle.stat({ bigint: true });
    if (
      !sameOpenFileIdentity(opened, afterSync)
      || !sameFileMetadata(opened, afterSync)
    ) {
      throw new Error('cold_build_launcher_published_file_sync_identity_changed');
    }
  } finally {
    await handle?.close().catch(() => {});
  }
  const after = await inspectLauncherFileUntilStable(filePath, expectedHash);
  if (
    !after.accepted
    || after.inodeIdentityHash !== before.inodeIdentityHash
  ) {
    throw new Error('cold_build_launcher_published_file_changed_after_sync');
  }
  return {
    status,
    errorCode,
    identityVerified: true,
    inspection: after,
  };
}

async function publishLauncherBinary({
  publicationDirectory,
  cachedBinaryPath,
  binaryBytes,
  expectedBinaryHash,
  beforePublicationLink,
}) {
  const candidateBinaryPath = path.join(
    publicationDirectory,
    `.candidate-${process.pid}-${randomBytes(16).toString('hex')}`,
  );
  let candidateCreated = false;
  let publicationOutcome = null;
  let publicationRaceObserved = false;
  let sameDevice = false;
  let candidateInspection = null;
  let candidatePostCoordinationInspection = null;
  let directorySyncBeforeLink = null;
  let directorySyncAfterLink = null;
  let directorySyncAfterCleanup = null;
  let publishedFileSync = null;
  try {
    const handle = await open(candidateBinaryPath, 'wx', 0o500);
    candidateCreated = true;
    try {
      await handle.writeFile(binaryBytes);
      await handle.chmod(0o555);
      await handle.sync();
    } finally {
      await handle.close();
    }
    candidateInspection = await inspectLauncherFile(
      candidateBinaryPath,
      expectedBinaryHash,
    );
    if (!candidateInspection.accepted) {
      throw new Error(
        `cold_build_launcher_publication_candidate_invalid:${candidateInspection.reason}`,
      );
    }
    const publicationDirectoryMetadata = await lstat(publicationDirectory);
    sameDevice = candidateInspection.pathDevice === String(publicationDirectoryMetadata.dev);
    if (!sameDevice) {
      throw new Error('cold_build_launcher_publication_cross_device_candidate');
    }
    directorySyncBeforeLink = await syncDirectory(publicationDirectory);
    if (beforePublicationLink) {
      await beforePublicationLink(Object.freeze({
        candidateBinaryPath,
        cachedBinaryPath,
      }));
      candidatePostCoordinationInspection = await inspectLauncherFile(
        candidateBinaryPath,
        expectedBinaryHash,
      );
      if (
        !candidatePostCoordinationInspection.accepted
        || candidatePostCoordinationInspection.inodeIdentityHash
          !== candidateInspection.inodeIdentityHash
      ) {
        throw new Error('cold_build_launcher_publication_candidate_changed_during_coordination');
      }
    }
    try {
      await link(candidateBinaryPath, cachedBinaryPath);
      publicationOutcome = 'publication_created';
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw new Error(
          `cold_build_launcher_publication_link_failed:${error?.code || 'unknown'}`,
        );
      }
      publicationRaceObserved = true;
      const existing = await inspectLauncherFileUntilStable(
        cachedBinaryPath,
        expectedBinaryHash,
      );
      if (!existing.accepted) {
        throw new Error(
          `cold_build_launcher_publication_conflict_invalid:${existing.reason}`,
        );
      }
      publicationOutcome = 'verified_existing_after_race';
    }
    publishedFileSync = await syncPublishedLauncherFile(
      cachedBinaryPath,
      expectedBinaryHash,
    );
    directorySyncAfterLink = await syncDirectory(publicationDirectory);
  } finally {
    if (candidateCreated) {
      await rm(candidateBinaryPath, { force: true });
      directorySyncAfterCleanup = await syncDirectory(publicationDirectory);
    }
  }
  const published = await inspectLauncherFileUntilStable(
    cachedBinaryPath,
    expectedBinaryHash,
  );
  if (
    !published.accepted
    || published.inodeIdentityHash !== publishedFileSync?.inspection?.inodeIdentityHash
  ) {
    throw new Error(
      `cold_build_launcher_publication_bytes_invalid:${published.reason}`,
    );
  }
  return {
    binaryBytes: published.bytes,
    finalInspection: published,
    candidateInspection,
    candidatePostCoordinationInspection,
    publicationPreLinkCoordinationUsed: Boolean(beforePublicationLink),
    publicationOutcome,
    publicationRaceObserved,
    publicationPrimitive: 'hard_link_no_replace',
    sameDevice,
    fileSyncStatus: publishedFileSync.status,
    fileSyncErrorCode: publishedFileSync.errorCode,
    fileSyncIdentityVerified: publishedFileSync.identityVerified,
    directorySyncBeforeLink,
    directorySyncAfterLink,
    directorySyncAfterCleanup,
  };
}

function launcherBuilderRecipe(architecture, sourceHash) {
  if (!SHA256_PATTERN.test(sourceHash ?? '')) {
    throw new Error('cold_build_launcher_builder_source_hash_invalid');
  }
  const containerArguments = Object.freeze([
    '--pull',
    'missing',
    '--network',
    'none',
    '--read-only',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges=true',
    '--pids-limit',
    '256',
    '--memory',
    String(2 * 1024 * 1024 * 1024),
    '--memory-swap',
    String(2 * 1024 * 1024 * 1024),
    '--cpus',
    '2',
    '--tmpfs',
    '/tmp:rw,nosuid,nodev,size=1073741824',
  ]);
  const environment = Object.freeze([
    'CGO_ENABLED=0',
    'GO111MODULE=off',
    `GOARCH=${architecture}`,
    'GOCACHE=/tmp/go-cache',
    'GOOS=linux',
    `SYNTHI_LAUNCHER_SOURCE_HASH=${sourceHash}`,
  ].sort());
  const command = Object.freeze([
    '-eu',
    '-c',
    [
      'snapshot=/tmp/synthi-launcher-source/main.go',
      'mkdir -p /tmp/synthi-launcher-source',
      'cp /src/main.go "$snapshot"',
      'chmod 0444 "$snapshot"',
      'actual="$(sha256sum "$snapshot")"',
      'actual="${actual%% *}"',
      '[ "sha256:$actual" = "$SYNTHI_LAUNCHER_SOURCE_HASH" ]',
      'printf "%s\\n" "$SYNTHI_LAUNCHER_SOURCE_HASH"',
      'exec /usr/local/go/bin/go build -trimpath -buildvcs=false '
        + '\'-ldflags=-buildid=\' -o /out/cold-build-launcher "$snapshot"',
    ].join('; '),
  ]);
  const projection = {
    schemaVersion: COLD_BUILD_LAUNCHER_BUILDER_RECIPE_SCHEMA,
    builderImage: COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    operatingSystem: 'linux',
    architecture,
    containerArguments,
    environment,
    entrypoint: '/bin/sh',
    command,
    sourceMount: Object.freeze({ target: '/src', readOnly: true }),
    outputMount: Object.freeze({ target: '/out', readOnly: false }),
  };
  return Object.freeze({
    ...projection,
    recipeHash: contentHash(stableJson(projection)),
  });
}

function launcherBuildArgs({ sourceDir, outputDir, recipe, containerName }) {
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--label',
    COLD_BUILD_LAUNCHER_BUILDER_LABEL,
    ...recipe.containerArguments,
    ...recipe.environment.flatMap((entry) => ['--env', entry]),
    '--entrypoint',
    recipe.entrypoint,
    '--mount',
    `type=bind,source=${sourceDir},target=${recipe.sourceMount.target},readonly`,
    '--mount',
    `type=bind,source=${outputDir},target=${recipe.outputMount.target}`,
    recipe.builderImage,
    ...recipe.command,
  ];
}

async function verifyLauncherSourceSnapshot(snapshotPath, sourceIdentity) {
  const readFlags = fsConstants.O_RDONLY
    | (process.platform === 'win32' ? 0 : (fsConstants.O_NOFOLLOW ?? 0));
  const verificationHandle = await open(snapshotPath, readFlags);
  try {
    const beforeRead = await verificationHandle.stat({ bigint: true });
    const snapshotBytes = await verificationHandle.readFile();
    const afterRead = await verificationHandle.stat({ bigint: true });
    if (
      !beforeRead.isFile()
      || !afterRead.isFile()
      || !sameOpenFileIdentity(beforeRead, afterRead)
      || !sameFileMetadata(beforeRead, afterRead)
      || snapshotBytes.byteLength !== sourceIdentity.byteLength
      || contentHash(snapshotBytes) !== sourceIdentity.sourceHash
    ) {
      throw new Error('cold_build_launcher_source_snapshot_identity_invalid');
    }
    return Object.freeze({
      inodeIdentityHash: contentHash(`${afterRead.dev}:${afterRead.ino}`),
    });
  } finally {
    await verificationHandle.close();
  }
}

async function stageLauncherSourceSnapshot(buildDirectory, sourceIdentity) {
  const sourceDirectory = path.join(buildDirectory, 'source');
  const outputDirectory = path.join(buildDirectory, 'output');
  await mkdir(sourceDirectory, { mode: 0o700 });
  await mkdir(outputDirectory, { mode: 0o700 });
  await requirePrivateDirectory(
    sourceDirectory,
    'cold_build_launcher_source_snapshot_directory_untrusted',
  );
  await requirePrivateDirectory(
    outputDirectory,
    'cold_build_launcher_output_directory_untrusted',
  );

  const sourceBytes = await readFile(COLD_BUILD_LAUNCHER_SOURCE_PATH);
  if (
    sourceBytes.byteLength !== sourceIdentity.byteLength
    || contentHash(sourceBytes) !== sourceIdentity.sourceHash
  ) {
    throw new Error('cold_build_launcher_source_changed_before_snapshot');
  }

  const snapshotPath = path.join(sourceDirectory, 'main.go');
  const snapshotHandle = await open(snapshotPath, 'wx', 0o400);
  try {
    await snapshotHandle.writeFile(sourceBytes);
    await snapshotHandle.chmod(0o444);
    await snapshotHandle.sync();
  } finally {
    await snapshotHandle.close();
  }
  const inspection = await verifyLauncherSourceSnapshot(
    snapshotPath,
    sourceIdentity,
  );

  return Object.freeze({
    sourceDirectory,
    outputDirectory,
    snapshotPath,
    inodeIdentityHash: inspection.inodeIdentityHash,
  });
}

async function removeBuilderContainer(dockerExecutable, containerName) {
  const removal = await runProcess(
    dockerExecutable,
    ['rm', '--force', containerName],
    { timeoutMs: 20_000, maxOutputBytes: 256 * 1024 },
  );
  const deadline = Date.now() + 20_000;
  let absenceObservation = null;
  let consecutiveAbsent = 0;
  while (Date.now() <= deadline && consecutiveAbsent < 2) {
    absenceObservation = await runProcess(
      dockerExecutable,
      [
        'ps',
        '--all',
        '--quiet',
        '--filter',
        `name=^/${containerName}$`,
      ],
      { timeoutMs: 5_000, maxOutputBytes: 256 * 1024 },
    );
    const absent = absenceObservation.exitCode === 0
      && !absenceObservation.timedOut
      && !absenceObservation.error
      && absenceObservation.stdout.trim() === '';
    consecutiveAbsent = absent ? consecutiveAbsent + 1 : 0;
    if (consecutiveAbsent < 2) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  const accepted = consecutiveAbsent >= 2;
  return {
    attempted: true,
    accepted,
    removalExitCode: removal.exitCode,
    removalTimedOut: removal.timedOut,
    removalError: removal.error,
    removalStdoutHash: contentHash(removal.stdout),
    removalStderrHash: contentHash(removal.stderr),
    absenceObservationExitCode: absenceObservation?.exitCode ?? null,
    absenceObservationTimedOut: absenceObservation?.timedOut ?? false,
    absenceObservationError: absenceObservation?.error ?? null,
    absenceObservationStdoutHash: contentHash(absenceObservation?.stdout ?? ''),
    absenceObservationStderrHash: contentHash(absenceObservation?.stderr ?? ''),
    consecutiveAbsentObservations: consecutiveAbsent,
  };
}

function elfIdentity(bytes) {
  if (
    bytes.byteLength < 64
    || bytes[0] !== 0x7f
    || bytes[1] !== 0x45
    || bytes[2] !== 0x4c
    || bytes[3] !== 0x46
    || bytes[4] !== 2
    || bytes[5] !== 1
  ) {
    return null;
  }
  const machine = bytes.readUInt16LE(18);
  const architecture = machine === 62
    ? 'amd64'
    : machine === 183
      ? 'arm64'
      : `elf_machine_${machine}`;
  const programHeaderOffsetBigInt = bytes.readBigUInt64LE(32);
  if (programHeaderOffsetBigInt > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const programHeaderOffset = Number(programHeaderOffsetBigInt);
  const programHeaderEntrySize = bytes.readUInt16LE(54);
  const programHeaderCount = bytes.readUInt16LE(56);
  if (
    programHeaderEntrySize < 56
    || programHeaderCount < 1
    || programHeaderOffset + (programHeaderEntrySize * programHeaderCount) > bytes.byteLength
  ) {
    return null;
  }
  const programHeaderTypes = [];
  for (let index = 0; index < programHeaderCount; index += 1) {
    programHeaderTypes.push(bytes.readUInt32LE(programHeaderOffset + (index * programHeaderEntrySize)));
  }
  return {
    operatingSystem: 'linux',
    architecture,
    staticExecutable: !programHeaderTypes.includes(2) && !programHeaderTypes.includes(3),
    programHeaderTypes: [...new Set(programHeaderTypes)].sort((left, right) => left - right),
  };
}

export function coldBuildLauncherExpectedHash(architecture) {
  const providerIdentity = normalizeProviderIdentity(architecture);
  return providerIdentity
    ? ATTESTED_LAUNCHER_HASHES_BY_PROVIDER_IDENTITY[providerIdentity] ?? null
    : null;
}

function coldBuildLauncherSourceIdentityAccepted(sourceIdentity) {
  if (
    !exactKeys(sourceIdentity, COLD_BUILD_LAUNCHER_SOURCE_IDENTITY_KEYS)
    || sourceIdentity.schemaVersion !== COLD_BUILD_LAUNCHER_SOURCE_MANIFEST_SCHEMA
    || !SHA256_PATTERN.test(sourceIdentity.sourceHash ?? '')
    || !Number.isSafeInteger(sourceIdentity.byteLength)
    || sourceIdentity.byteLength < 1
    || sourceIdentity.repoRelativePath !== 'scripts/native/cold-build-launcher/main.go'
  ) {
    return false;
  }
  const projection = {
    schemaVersion: sourceIdentity.schemaVersion,
    sourceHash: sourceIdentity.sourceHash,
    byteLength: sourceIdentity.byteLength,
    repoRelativePath: sourceIdentity.repoRelativePath,
  };
  return sourceIdentity.manifestHash === contentHash(stableJson(projection));
}

function coldBuildLauncherBuildEvidenceAccepted(
  buildEvidence,
  architecture,
  binaryHash,
  sourceIdentity,
) {
  if (!exactKeys(buildEvidence, COLD_BUILD_LAUNCHER_BUILD_EVIDENCE_KEYS)) {
    return false;
  }
  const expectedBinaryHash = coldBuildLauncherExpectedHash(architecture);
  const expectedRecipe = launcherBuilderRecipe(
    architecture,
    sourceIdentity.sourceHash,
  );
  const publicationKeyProjection = {
    architecture,
    builderRecipeHash: expectedRecipe.recipeHash,
    expectedBinaryHash,
    sourceManifestHash: sourceIdentity.manifestHash,
  };
  const expectedPublicationKeyHash = contentHash(stableJson(publicationKeyProjection));
  const publicationDirectoryName = expectedPublicationKeyHash.slice('sha256:'.length);
  const publicationProjection = {
    schemaVersion: COLD_BUILD_LAUNCHER_PUBLICATION_SCHEMA,
    publicationKeyHash: expectedPublicationKeyHash,
    relativeBinaryPath: [
      'cold-build-launcher',
      'publications',
      architecture,
      publicationDirectoryName,
      'cold-build-launcher',
    ].join('/'),
  };
  const requiredHashFields = [
    'sourceHash',
    'sourceManifestHash',
    'builderRecipeHash',
    'binaryHash',
    'expectedBinaryHash',
    'publicationKeyHash',
    'publicationManifestHash',
    'publicationDirectoryHierarchySyncEvidenceHash',
    'finalBinaryInodeIdentityHash',
    'trustedCacheRootEvidenceHash',
    'trustedCacheRootAncestorEvidenceHash',
    'publicationDirectoryChainEvidenceHash',
    'staleCandidateCleanupEvidenceHash',
    'staleBuildCleanupEvidenceHash',
    'evidenceHash',
  ];
  const countFields = [
    'publicationDirectoryHierarchySyncCount',
    'publicationDirectoryHierarchySyncSyncedCount',
    'publicationDirectoryHierarchySyncUnsupportedCount',
    'finalBinaryMode',
    'finalBinaryLinkCount',
    'trustedCacheRootAncestorCount',
    'staleCandidateCleanupScannedCount',
    'staleCandidateCleanupRemovedCount',
    'staleCandidateCleanupRecentIgnoredCount',
    'staleCandidateCleanupFutureTimestampCount',
    'staleCandidateCleanupLeafRemovalAttemptCount',
    'staleCandidateCleanupNonEmptyRetainedCount',
    'staleBuildCleanupScannedCount',
    'staleBuildCleanupRemovedCount',
    'staleBuildCleanupRecentIgnoredCount',
    'staleBuildCleanupFutureTimestampCount',
    'staleBuildCleanupLeafRemovalAttemptCount',
    'staleBuildCleanupNonEmptyRetainedCount',
    'directoryLeaseCount',
    'directoryLeaseStatBoundCount',
    'directoryLeaseFallbackCount',
  ];
  const syncStatuses = new Set(['synced', 'unsupported', 'not_required_cache_hit']);
  const errorCodeFields = [
    'publicationFileSyncErrorCode',
    'publicationDirectorySyncBeforeLinkErrorCode',
    'publicationDirectorySyncAfterLinkErrorCode',
    'publicationDirectorySyncAfterCleanupErrorCode',
  ];
  const optionalBuildHashFields = [
    'buildCommandHash',
    'buildStdoutHash',
    'buildStderrHash',
    'builderContainerIdentityHash',
    'builderCleanupEvidenceHash',
  ];
  const elfProgramHeaderTypes = buildEvidence.elfProgramHeaderTypes;
  const cleanupCountsAccepted = [
    ['staleCandidateCleanupScannedCount', 'staleCandidateCleanupRemovedCount'],
    ['staleBuildCleanupScannedCount', 'staleBuildCleanupRemovedCount'],
  ].every(([scanned, removed]) => buildEvidence[removed] <= buildEvidence[scanned]);
  const publicationOutcomeAccepted = [
    'publication_created',
    'verified_existing_after_race',
    'cache_hit',
  ].includes(buildEvidence.publicationOutcome)
    && buildEvidence.publicationCreated
      === (buildEvidence.publicationOutcome === 'publication_created')
    && buildEvidence.publicationRaceObserved
      === (buildEvidence.publicationOutcome === 'verified_existing_after_race')
    && buildEvidence.cacheHit === (buildEvidence.publicationOutcome === 'cache_hit');
  const durabilityAccepted = (
    buildEvidence.publicationDurabilityStatus === 'durable'
    && buildEvidence.publicationDurabilityProven === true
    && buildEvidence.publicationDirectoryHierarchySyncAccepted === true
    && buildEvidence.publicationFileSyncStatus === 'synced'
  ) || (
    buildEvidence.publicationDurabilityStatus === 'directory_sync_unsupported'
    && buildEvidence.cacheHit === false
    && buildEvidence.publicationDurabilityProven === false
  ) || (
    buildEvidence.publicationDurabilityStatus
      === 'cache_verified_durability_not_reproven'
    && buildEvidence.cacheHit === true
    && buildEvidence.publicationDurabilityProven === false
  );
  const buildExecutionAccepted = buildEvidence.buildExecuted === true
    ? optionalBuildHashFields.every((name) => SHA256_PATTERN.test(buildEvidence[name] ?? ''))
      && buildEvidence.buildExitCode === 0
      && buildEvidence.buildStdoutHash
        === contentHash(`${sourceIdentity.sourceHash}\n`)
      && buildEvidence.builderCleanupAttempted === true
      && buildEvidence.builderCleanupAccepted === true
      && Number.isSafeInteger(buildEvidence.builderCleanupRemovalExitCode)
      && Number.isSafeInteger(buildEvidence.builderCleanupAbsenceObservationExitCode)
    : optionalBuildHashFields.every((name) => buildEvidence[name] === null)
      && buildEvidence.buildExitCode === null
      && buildEvidence.builderCleanupAttempted === false
      && buildEvidence.builderCleanupAccepted === true
      && buildEvidence.builderCleanupRemovalExitCode === null
      && buildEvidence.builderCleanupAbsenceObservationExitCode === null;
  return (
    buildEvidence.schemaVersion === COLD_BUILD_LAUNCHER_BUILD_SCHEMA
    && buildEvidence.proofAuthority === COLD_BUILD_LAUNCHER_BUILD_AUTHORITY
    && requiredHashFields.every((name) => SHA256_PATTERN.test(buildEvidence[name] ?? ''))
    && countFields.every((name) => Number.isSafeInteger(buildEvidence[name])
      && buildEvidence[name] >= 0)
    && errorCodeFields.every((name) => buildEvidence[name] === null
      || (typeof buildEvidence[name] === 'string' && buildEvidence[name].length > 0))
    && buildEvidence.sourceHash === sourceIdentity.sourceHash
    && buildEvidence.sourceByteLength === sourceIdentity.byteLength
    && buildEvidence.sourceRepoRelativePath === sourceIdentity.repoRelativePath
    && buildEvidence.sourceManifestSchema === sourceIdentity.schemaVersion
    && buildEvidence.sourceManifestHash === sourceIdentity.manifestHash
    && buildEvidence.sourceManifestRevalidated === true
    && buildEvidence.builderImage === COLD_BUILD_LAUNCHER_BUILDER_IMAGE
    && buildEvidence.builderRecipeSchema === COLD_BUILD_LAUNCHER_BUILDER_RECIPE_SCHEMA
    && buildEvidence.builderRecipeHash === expectedRecipe.recipeHash
    && buildEvidence.architecture === architecture
    && buildEvidence.operatingSystem === 'linux'
    && buildEvidence.staticExecutable === true
    && Array.isArray(elfProgramHeaderTypes)
    && elfProgramHeaderTypes.length > 0
    && elfProgramHeaderTypes.every((value, index) => Number.isSafeInteger(value)
      && value >= 0
      && value !== 2
      && value !== 3
      && (index === 0 || value > elfProgramHeaderTypes[index - 1]))
    && binaryHash === expectedBinaryHash
    && buildEvidence.binaryHash === expectedBinaryHash
    && buildEvidence.expectedBinaryHash === expectedBinaryHash
    && Number.isSafeInteger(buildEvidence.binaryByteLength)
    && buildEvidence.binaryByteLength >= 1024 * 1024
    && buildEvidence.reproducibleHashMatched === true
    && buildEvidence.cacheAccepted === true
    && typeof buildEvidence.cacheHit === 'boolean'
    && buildEvidence.immutableContentAddressedPublication === true
    && buildEvidence.mutableBuildLockUsed === false
    && buildEvidence.publicationKeyHash === expectedPublicationKeyHash
    && buildEvidence.publicationManifestHash
      === contentHash(stableJson(publicationProjection))
    && buildEvidence.publicationDirectoryName === publicationDirectoryName
    && publicationOutcomeAccepted
    && typeof buildEvidence.publicationPreLinkCoordinationUsed === 'boolean'
    && buildEvidence.publicationPrimitive === 'hard_link_no_replace'
    && buildEvidence.publicationSameDevice === true
    && syncStatuses.has(buildEvidence.publicationFileSyncStatus)
    && syncStatuses.has(buildEvidence.publicationDirectorySyncBeforeLinkStatus)
    && syncStatuses.has(buildEvidence.publicationDirectorySyncAfterLinkStatus)
    && syncStatuses.has(buildEvidence.publicationDirectorySyncAfterCleanupStatus)
    && buildEvidence.publicationFileSyncIdentityVerified === true
    && buildEvidence.publicationIntegrityAccepted === true
    && buildEvidence.executionTimePathBindingRequired === true
    && buildEvidence.canAuthorizeLauncherExecution === false
    && durabilityAccepted
    && buildEvidence.publicationDirectoryHierarchySyncAttempted === true
    && typeof buildEvidence.publicationDirectoryHierarchySyncAccepted === 'boolean'
    && buildEvidence.publicationDirectoryHierarchySyncCount >= 1
    && buildEvidence.publicationDirectoryHierarchySyncCount
      === buildEvidence.publicationDirectoryHierarchySyncSyncedCount
        + buildEvidence.publicationDirectoryHierarchySyncUnsupportedCount
    && buildEvidence.finalBinaryVerified === true
    && buildEvidence.finalBinaryVerifiedAfterDirectoryRevalidation === true
    && buildEvidence.finalBinaryRegularFile === true
    && buildEvidence.finalBinarySymbolicLink === false
    && buildEvidence.finalBinaryStableIdentity === true
    && buildEvidence.finalBinaryStableMetadata === true
    && buildEvidence.finalBinarySecondHandleIdentityVerified === true
    && buildEvidence.finalBinaryCanonicalPathStable === true
    && buildEvidence.finalBinaryImmutableMode === true
    && typeof buildEvidence.finalBinaryExecutableModeObserved === 'boolean'
    && typeof buildEvidence.finalBinaryExecutableModeApplicable === 'boolean'
    && buildEvidence.finalBinaryExecutableModeAccepted === true
    && buildEvidence.finalBinaryLinkCount >= 1
    && buildEvidence.trustedCacheRootAccepted === true
    && buildEvidence.trustedCacheRootRevalidated === true
    && typeof buildEvidence.trustedCacheRootPermissionVerification === 'string'
    && buildEvidence.trustedCacheRootPermissionVerification.length > 0
    && typeof buildEvidence.trustedCacheRootPermissionOwnershipRecomputed === 'boolean'
    && (buildEvidence.trustedCacheRootPermissionOwnershipRecomputed
      ? buildEvidence.trustedCacheRootPermissionLimitation === null
      : buildEvidence.trustedCacheRootPermissionLimitation
        === 'windows_acl_not_recomputed_execution_time_hash_required')
    && buildEvidence.trustedCacheRootIdentityRevalidated === true
    && buildEvidence.trustedCacheRootAncestorRevalidated === true
    && buildEvidence.publicationDirectoryChainAccepted === true
    && buildEvidence.publicationDirectoryRevalidated === true
    && buildEvidence.staleCandidateCleanupAccepted === true
    && buildEvidence.staleCandidateCleanupRecursiveTraversalUsed === false
    && buildEvidence.staleCandidateCleanupBoundedLimitExceeded === false
    && buildEvidence.staleBuildCleanupAccepted === true
    && buildEvidence.staleBuildCleanupRecursiveTraversalUsed === false
    && buildEvidence.staleBuildCleanupBoundedLimitExceeded === false
    && cleanupCountsAccepted
    && buildEvidence.directoryLeaseCount >= 1
    && buildEvidence.directoryLeaseCount
      === buildEvidence.directoryLeaseStatBoundCount
        + buildEvidence.directoryLeaseFallbackCount
    && buildEvidence.directoryLeasesHeldThroughVerification === true
    && buildEvidence.directoryLeaseStatBindingAccepted === true
    && (buildEvidence.directoryLeaseFallbackCount === 0
      ? buildEvidence.directoryLeaseFallbackLimitation === null
      : buildEvidence.directoryLeaseFallbackLimitation
        === 'windows_directory_handle_stat_binding_unavailable_execution_time_hash_required')
    && typeof buildEvidence.coalescedPublicationWait === 'boolean'
    && typeof buildEvidence.buildExecuted === 'boolean'
    && buildExecutionAccepted
    && buildEvidence.accepted === true
    && buildEvidence.acceptedForGpuHmr === false
    && buildEvidence.gpuHmrSuccess === false
    && buildEvidence.canSatisfyRuntimeProof === false
    && buildEvidence.canSatisfyDispatchProof === false
    && buildEvidence.evidenceHash === recomputeEvidenceHash(buildEvidence)
  );
}

export function createColdBuildLauncherIdentityReceipt(launcherIdentity) {
  requirePinnedLauncherIdentity(launcherIdentity);
  if (
    !coldBuildLauncherSourceIdentityAccepted(launcherIdentity.sourceIdentity)
    || !coldBuildLauncherBuildEvidenceAccepted(
      launcherIdentity.buildEvidence,
      launcherIdentity.architecture,
      launcherIdentity.binaryHash,
      launcherIdentity.sourceIdentity,
    )
  ) {
    throw new Error('cold_build_launcher_identity_receipt_source_invalid');
  }
  const receipt = {
    schemaVersion: COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_SCHEMA,
    proofAuthority: COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_AUTHORITY,
    architecture: launcherIdentity.architecture,
    binaryHash: launcherIdentity.binaryHash,
    sourceIdentity: structuredClone(launcherIdentity.sourceIdentity),
    buildEvidence: structuredClone(launcherIdentity.buildEvidence),
    launcherBinaryBytesEmbedded: false,
    executionTimePathBindingRequired: true,
    acceptedAsColdBuildLauncherIdentityReceipt: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  receipt.evidenceHash = recomputeEvidenceHash(receipt);
  return receipt;
}

export function verifyColdBuildLauncherIdentityReceipt(receipt) {
  const architecture = normalizeProviderIdentity(receipt?.architecture);
  if (
    !exactKeys(receipt, COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_KEYS)
    || receipt.schemaVersion !== COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_SCHEMA
    || receipt.proofAuthority !== COLD_BUILD_LAUNCHER_IDENTITY_RECEIPT_AUTHORITY
    || receipt.architecture !== architecture
    || receipt.binaryHash !== coldBuildLauncherExpectedHash(architecture)
    || !coldBuildLauncherSourceIdentityAccepted(receipt.sourceIdentity)
    || !coldBuildLauncherBuildEvidenceAccepted(
      receipt.buildEvidence,
      architecture,
      receipt.binaryHash,
      receipt.sourceIdentity,
    )
    || receipt.launcherBinaryBytesEmbedded !== false
    || receipt.executionTimePathBindingRequired !== true
    || receipt.acceptedAsColdBuildLauncherIdentityReceipt !== true
    || receipt.acceptedForGpuHmr !== false
    || receipt.gpuHmrSuccess !== false
    || receipt.canSatisfyRuntimeProof !== false
    || receipt.canSatisfyDispatchProof !== false
    || !SHA256_PATTERN.test(receipt.evidenceHash ?? '')
    || receipt.evidenceHash !== recomputeEvidenceHash(receipt)
  ) {
    throw new Error('cold_build_launcher_identity_receipt_invalid');
  }
  return receipt;
}

function requirePinnedLauncherIdentity(value) {
  const pinnedIdentity = value && typeof value === 'object'
    ? PINNED_LAUNCHER_IDENTITIES.get(value)
    : null;
  const architecture = normalizeProviderIdentity(value?.architecture);
  const expectedHash = coldBuildLauncherExpectedHash(architecture);
  const buildEvidence = value?.buildEvidence;
  if (
    !pinnedIdentity
    || !expectedHash
    || pinnedIdentity.architecture !== architecture
    || pinnedIdentity.executableHash !== expectedHash
    || value?.binaryHash !== expectedHash
    || buildEvidence?.schemaVersion !== COLD_BUILD_LAUNCHER_BUILD_SCHEMA
    || buildEvidence?.proofAuthority !== COLD_BUILD_LAUNCHER_BUILD_AUTHORITY
    || buildEvidence?.architecture !== architecture
    || buildEvidence?.binaryHash !== expectedHash
    || buildEvidence?.expectedBinaryHash !== expectedHash
    || buildEvidence?.sourceManifestRevalidated !== true
    || buildEvidence?.immutableContentAddressedPublication !== true
    || buildEvidence?.publicationPrimitive !== 'hard_link_no_replace'
    || buildEvidence?.publicationSameDevice !== true
    || buildEvidence?.publicationIntegrityAccepted !== true
    || buildEvidence?.publicationFileSyncIdentityVerified !== true
    || buildEvidence?.executionTimePathBindingRequired !== true
    || buildEvidence?.canAuthorizeLauncherExecution !== false
    || buildEvidence?.publicationDirectoryHierarchySyncAttempted !== true
    || !Number.isSafeInteger(buildEvidence?.publicationDirectoryHierarchySyncCount)
    || buildEvidence.publicationDirectoryHierarchySyncCount < 1
    || typeof buildEvidence?.publicationDirectoryHierarchySyncEvidenceHash !== 'string'
    || !/^sha256:[0-9a-f]{64}$/.test(
      buildEvidence.publicationDirectoryHierarchySyncEvidenceHash,
    )
    || ![
      'durable',
      'directory_sync_unsupported',
      'cache_verified_durability_not_reproven',
    ].includes(buildEvidence?.publicationDurabilityStatus)
    || (buildEvidence?.publicationDurabilityStatus === 'durable'
      && (buildEvidence?.publicationDurabilityProven !== true
        || buildEvidence?.publicationDirectoryHierarchySyncAccepted !== true))
    || (buildEvidence?.publicationDurabilityStatus !== 'durable'
      && buildEvidence?.publicationDurabilityProven !== false)
    || buildEvidence?.finalBinaryVerified !== true
    || buildEvidence?.finalBinaryVerifiedAfterDirectoryRevalidation !== true
    || buildEvidence?.finalBinaryRegularFile !== true
    || buildEvidence?.finalBinarySymbolicLink !== false
    || buildEvidence?.finalBinaryStableIdentity !== true
    || buildEvidence?.finalBinaryStableMetadata !== true
    || buildEvidence?.finalBinarySecondHandleIdentityVerified !== true
    || buildEvidence?.finalBinaryCanonicalPathStable !== true
    || buildEvidence?.finalBinaryImmutableMode !== true
    || buildEvidence?.finalBinaryExecutableModeAccepted !== true
    || buildEvidence?.trustedCacheRootAccepted !== true
    || buildEvidence?.trustedCacheRootRevalidated !== true
    || buildEvidence?.trustedCacheRootIdentityRevalidated !== true
    || buildEvidence?.trustedCacheRootAncestorRevalidated !== true
    || buildEvidence?.publicationDirectoryChainAccepted !== true
    || buildEvidence?.publicationDirectoryRevalidated !== true
    || buildEvidence?.staleCandidateCleanupAccepted !== true
    || buildEvidence?.staleBuildCleanupAccepted !== true
    || buildEvidence?.staleCandidateCleanupRecursiveTraversalUsed !== false
    || buildEvidence?.staleBuildCleanupRecursiveTraversalUsed !== false
    || buildEvidence?.directoryLeasesHeldThroughVerification !== true
    || buildEvidence?.directoryLeaseStatBindingAccepted !== true
    || !Number.isSafeInteger(buildEvidence?.directoryLeaseCount)
    || buildEvidence.directoryLeaseCount < 1
    || buildEvidence?.accepted !== true
    || buildEvidence?.acceptedForGpuHmr !== false
    || buildEvidence?.gpuHmrSuccess !== false
    || buildEvidence?.canSatisfyRuntimeProof !== false
    || buildEvidence?.canSatisfyDispatchProof !== false
  ) {
    throw new Error('cold_build_launcher_pinned_identity_invalid');
  }
  return pinnedIdentity;
}

export async function coldBuildLauncherSourceIdentity() {
  const bytes = await readFile(COLD_BUILD_LAUNCHER_SOURCE_PATH);
  const projection = {
    schemaVersion: COLD_BUILD_LAUNCHER_SOURCE_MANIFEST_SCHEMA,
    sourceHash: contentHash(bytes),
    byteLength: bytes.byteLength,
    repoRelativePath: 'scripts/native/cold-build-launcher/main.go',
  };
  return Object.freeze({
    ...projection,
    manifestHash: contentHash(stableJson(projection)),
  });
}

function coldBuildLauncherDefaultCacheBase() {
  const home = os.homedir();
  if (process.platform === 'win32') {
    return process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  }
  if (process.platform === 'darwin') return path.join(home, 'Library', 'Caches');
  return process.env.XDG_CACHE_HOME || path.join(home, '.cache');
}

export function coldBuildLauncherDefaultCacheRoot() {
  return path.join(coldBuildLauncherDefaultCacheBase(), 'synthi', 'gpu-hmr-tool-cache');
}

export async function coldBuildLauncherPublicationDescriptor({
  architecture,
  cacheRoot = coldBuildLauncherDefaultCacheRoot(),
} = {}) {
  if (architecture === null || architecture === undefined || architecture === '') {
    throw new Error('cold_build_launcher_target_architecture_required');
  }
  const normalizedArchitecture = normalizeProviderIdentity(architecture);
  if (!normalizedArchitecture) {
    throw new Error('cold_build_launcher_target_provider_identity_invalid');
  }
  const expectedBinaryHash = coldBuildLauncherExpectedHash(normalizedArchitecture);
  if (!expectedBinaryHash) {
    throw new Error('cold_build_launcher_reproducible_identity_capability_missing');
  }
  const sourceIdentity = await coldBuildLauncherSourceIdentity();
  const builderRecipe = launcherBuilderRecipe(
    normalizedArchitecture,
    sourceIdentity.sourceHash,
  );
  const publicationKeyProjection = {
    architecture: normalizedArchitecture,
    builderRecipeHash: builderRecipe.recipeHash,
    expectedBinaryHash,
    sourceManifestHash: sourceIdentity.manifestHash,
  };
  const publicationKeyHash = contentHash(stableJson(publicationKeyProjection));
  const publicationDirectoryName = publicationKeyHash.slice('sha256:'.length);
  const relativeDirectorySegments = [
    'cold-build-launcher',
    'publications',
    normalizedArchitecture,
    publicationDirectoryName,
  ];
  const relativeBinaryPath = path.join(
    ...relativeDirectorySegments,
    'cold-build-launcher',
  );
  const publicationProjection = {
    schemaVersion: COLD_BUILD_LAUNCHER_PUBLICATION_SCHEMA,
    publicationKeyHash,
    relativeBinaryPath: relativeBinaryPath.split(path.sep).join('/'),
  };
  const resolvedCacheRoot = path.resolve(cacheRoot);
  const publicationDirectory = path.join(resolvedCacheRoot, ...relativeDirectorySegments);
  return Object.freeze({
    normalizedArchitecture,
    expectedBinaryHash,
    sourceIdentity,
    builderRecipe,
    publicationKeyHash,
    publicationManifestHash: contentHash(stableJson(publicationProjection)),
    publicationDirectoryName,
    relativeDirectorySegments: Object.freeze([...relativeDirectorySegments]),
    relativeBinaryPath: publicationProjection.relativeBinaryPath,
    resolvedCacheRoot,
    publicationDirectory,
    cachedBinaryPath: path.join(publicationDirectory, 'cold-build-launcher'),
  });
}

const activeLauncherMaterializations = new Map();

async function materializeColdBuildLauncherOnce({
  dockerExecutable,
  descriptor,
  coalescedPublicationWait,
  beforePublicationLink,
}) {
  const {
    normalizedArchitecture,
    expectedBinaryHash,
    sourceIdentity,
    builderRecipe,
    publicationKeyHash,
    publicationManifestHash,
    publicationDirectoryName,
    relativeDirectorySegments,
    resolvedCacheRoot,
    publicationDirectory,
    cachedBinaryPath,
  } = descriptor;
  const trustedRoot = await prepareTrustedCacheRoot(resolvedCacheRoot);
  const publicationDirectoryChain = await preparePrivateDirectoryChain(
    trustedRoot.resolvedRoot,
    relativeDirectorySegments,
  );
  if (publicationDirectoryChain.directoryPath !== publicationDirectory) {
    throw new Error('cold_build_launcher_publication_path_identity_mismatch');
  }
  const buildDirectoryChain = await preparePrivateDirectoryChain(
    trustedRoot.resolvedRoot,
    ['cold-build-launcher', 'builds'],
  );
  const directoryLeasePaths = [...new Set([
    trustedRoot.resolvedRoot,
    ...publicationDirectoryChain.paths,
    ...buildDirectoryChain.paths,
  ].map((directoryPath) => normalizedPathIdentity(directoryPath)))];
  const directoryLeases = [];
  try {
    for (const directoryPath of directoryLeasePaths) {
      directoryLeases.push(await openPrivateDirectoryLease(directoryPath));
    }
  } catch (error) {
    await closePrivateDirectoryLeases(directoryLeases);
    throw error;
  }
  try {
  const publicationDirectoryHierarchySync = await syncDirectoryHierarchy(
    publicationDirectory,
  );
  const staleCandidateCleanup = await cleanupStaleCacheEntries(
    publicationDirectory,
    { prefix: '.candidate-', entryKind: 'candidate' },
  );
  const staleBuildCleanup = await cleanupStaleCacheEntries(
    buildDirectoryChain.directoryPath,
    { prefix: 'build-', entryKind: 'build' },
  );
  if (!staleCandidateCleanup.accepted || !staleBuildCleanup.accepted) {
    throw new Error('cold_build_launcher_stale_state_cleanup_failed');
  }
  const initialInspection = await inspectLauncherFileUntilStable(
    cachedBinaryPath,
    expectedBinaryHash,
  );
  if (initialInspection.present && !initialInspection.accepted) {
    throw new Error(
      `cold_build_launcher_publication_conflict_invalid:${initialInspection.reason}`,
    );
  }
  let finalInspection = initialInspection;
  let binaryBytes = initialInspection.accepted ? initialInspection.bytes : null;
  let cacheAccepted = initialInspection.accepted;
  const cacheHit = initialInspection.accepted;
  const cacheHitFileSync = cacheHit
    ? await syncPublishedLauncherFile(cachedBinaryPath, expectedBinaryHash)
    : null;
  if (cacheHitFileSync) {
    finalInspection = cacheHitFileSync.inspection;
    binaryBytes = cacheHitFileSync.inspection.bytes;
  }
  let buildResult = null;
  let buildArgs = null;
  let builderContainerName = null;
  let builderCleanup = null;
  let publicationOutcome = cacheHit ? 'cache_hit' : null;
  let publicationRaceObserved = false;
  let publicationPreLinkCoordinationUsed = false;
  let publicationSameDevice = finalInspection?.accepted
    ? finalInspection.pathDevice
      === String(publicationDirectoryChain.inspections.at(-1)?.device)
    : null;
  let publicationFileSyncStatus = cacheHit ? cacheHitFileSync.status : null;
  let publicationFileSyncErrorCode = cacheHit ? cacheHitFileSync.errorCode : null;
  let publicationFileSyncIdentityVerified = cacheHit
    ? cacheHitFileSync.identityVerified
    : false;
  let directorySyncBeforeLink = cacheHit
    ? { status: 'not_required_cache_hit', errorCode: null }
    : null;
  let directorySyncAfterLink = directorySyncBeforeLink;
  let directorySyncAfterCleanup = directorySyncBeforeLink;
  if (!cacheAccepted) {
    let temporaryDirectory = null;
    try {
      temporaryDirectory = await mkdtemp(path.join(buildDirectoryChain.directoryPath, 'build-'));
      await requirePrivateDirectory(
        temporaryDirectory,
        'cold_build_launcher_build_directory_untrusted',
      );
      const sourceSnapshot = await stageLauncherSourceSnapshot(
        temporaryDirectory,
        sourceIdentity,
      );
      builderContainerName = [
        'synthi-cold-launcher-builder',
        sourceIdentity.sourceHash.slice('sha256:'.length, 'sha256:'.length + 12),
        normalizedArchitecture,
        process.pid,
        randomBytes(6).toString('hex'),
      ].join('-');
      buildArgs = launcherBuildArgs({
        sourceDir: sourceSnapshot.sourceDirectory,
        outputDir: sourceSnapshot.outputDirectory,
        recipe: builderRecipe,
        containerName: builderContainerName,
      });
      try {
        buildResult = await runProcess(dockerExecutable, buildArgs, {
          timeoutMs: 180_000,
          maxOutputBytes: 1024 * 1024,
        });
      } finally {
        builderCleanup = await removeBuilderContainer(
          dockerExecutable,
          builderContainerName,
        );
      }
      if (!builderCleanup.accepted) {
        throw new Error('cold_build_launcher_builder_cleanup_failed');
      }
      if (
        buildResult.exitCode !== 0
        || buildResult.signal !== null
        || buildResult.timedOut
        || buildResult.error
      ) {
        throw new Error(
          `cold_build_launcher_build_failed:${buildResult.error || buildResult.stderr || buildResult.exitCode}`,
        );
      }
      if (buildResult.stdout !== `${sourceIdentity.sourceHash}\n`) {
        throw new Error('cold_build_launcher_source_snapshot_observation_mismatch');
      }
      const sourceSnapshotRevalidation = await verifyLauncherSourceSnapshot(
        sourceSnapshot.snapshotPath,
        sourceIdentity,
      );
      if (
        sourceSnapshotRevalidation.inodeIdentityHash
        !== sourceSnapshot.inodeIdentityHash
      ) {
        throw new Error('cold_build_launcher_source_snapshot_changed_during_build');
      }
      const builtPath = path.join(
        sourceSnapshot.outputDirectory,
        'cold-build-launcher',
      );
      const builtInspection = await inspectLauncherFile(
        builtPath,
        expectedBinaryHash,
        { requireImmutable: false },
      );
      if (!builtInspection.accepted) {
        throw new Error(
          `cold_build_launcher_reproducible_hash_mismatch:${builtInspection.reason}`,
        );
      }
      const publication = await publishLauncherBinary({
        publicationDirectory,
        cachedBinaryPath,
        binaryBytes: builtInspection.bytes,
        expectedBinaryHash,
        beforePublicationLink,
      });
      binaryBytes = publication.binaryBytes;
      finalInspection = publication.finalInspection;
      publicationOutcome = publication.publicationOutcome;
      publicationRaceObserved = publication.publicationRaceObserved;
      publicationPreLinkCoordinationUsed = publication.publicationPreLinkCoordinationUsed;
      publicationSameDevice = publication.sameDevice;
      publicationFileSyncStatus = publication.fileSyncStatus;
      publicationFileSyncErrorCode = publication.fileSyncErrorCode;
      publicationFileSyncIdentityVerified = publication.fileSyncIdentityVerified;
      directorySyncBeforeLink = publication.directorySyncBeforeLink;
      directorySyncAfterLink = publication.directorySyncAfterLink;
      directorySyncAfterCleanup = publication.directorySyncAfterCleanup;
      cacheAccepted = binaryBytes !== null;
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
    }
  }
  if (!cacheAccepted) {
    throw new Error('cold_build_launcher_cache_materialization_failed');
  }
  finalInspection = await inspectLauncherFileUntilStable(
    cachedBinaryPath,
    expectedBinaryHash,
  );
  if (!finalInspection.accepted) {
    throw new Error(
      `cold_build_launcher_cache_identity_changed:${finalInspection.reason}`,
    );
  }
  binaryBytes = finalInspection.bytes;
  publicationSameDevice = finalInspection.pathDevice
    === String(publicationDirectoryChain.inspections.at(-1)?.device);
  if (!publicationSameDevice) {
    throw new Error('cold_build_launcher_publication_final_cross_device');
  }
  const trustedRootRevalidation = await requirePrivateDirectory(
    trustedRoot.resolvedRoot,
    'cold_build_launcher_cache_root_changed',
  );
  if (trustedRootRevalidation.identityHash !== trustedRoot.inspection.identityHash) {
    throw new Error('cold_build_launcher_cache_root_identity_changed');
  }
  const ancestorRevalidation = await inspectCacheRootAncestors(trustedRoot.resolvedRoot);
  const ancestorRevalidationHash = contentHash(stableJson(ancestorRevalidation.observations));
  if (
    !ancestorRevalidation.accepted
    || ancestorRevalidationHash !== trustedRoot.ancestorEvidenceHash
  ) {
    throw new Error('cold_build_launcher_cache_root_ancestor_identity_changed');
  }
  const publicationDirectoryChainRevalidations = [];
  for (let index = 0; index < publicationDirectoryChain.paths.length; index += 1) {
    const inspection = await requirePrivateDirectory(
      publicationDirectoryChain.paths[index],
      'cold_build_launcher_publication_directory_changed',
    );
    if (inspection.identityHash !== publicationDirectoryChain.inspections[index].identityHash) {
      throw new Error('cold_build_launcher_publication_directory_identity_changed');
    }
    publicationDirectoryChainRevalidations.push(inspection);
  }
  const sourceIdentityRevalidation = await coldBuildLauncherSourceIdentity();
  if (sourceIdentityRevalidation.manifestHash !== sourceIdentity.manifestHash) {
    throw new Error('cold_build_launcher_source_identity_changed');
  }
  const postDirectoryFinalInspection = await inspectLauncherFileUntilStable(
    cachedBinaryPath,
    expectedBinaryHash,
  );
  if (
    !postDirectoryFinalInspection.accepted
    || postDirectoryFinalInspection.binaryHash !== finalInspection.binaryHash
    || postDirectoryFinalInspection.inodeIdentityHash !== finalInspection.inodeIdentityHash
  ) {
    throw new Error('cold_build_launcher_final_identity_changed_after_directory_revalidation');
  }
  const postFileRootRevalidation = await requirePrivateDirectory(
    trustedRoot.resolvedRoot,
    'cold_build_launcher_cache_root_changed_after_final_file_check',
  );
  const postFileDirectoryRevalidation = await requirePrivateDirectory(
    publicationDirectory,
    'cold_build_launcher_publication_directory_changed_after_final_file_check',
  );
  if (
    postFileRootRevalidation.identityHash !== trustedRoot.inspection.identityHash
    || postFileDirectoryRevalidation.identityHash
      !== publicationDirectoryChain.inspections.at(-1).identityHash
  ) {
    throw new Error('cold_build_launcher_directory_identity_changed_after_final_file_check');
  }
  finalInspection = postDirectoryFinalInspection;
  const directorySyncStatuses = [
    directorySyncBeforeLink?.status,
    directorySyncAfterLink?.status,
    directorySyncAfterCleanup?.status,
  ];
  const publicationDurabilityProven = !cacheHit
    && publicationDirectoryHierarchySync.accepted
    && directorySyncStatuses.every((status) => status === 'synced')
    && publicationFileSyncStatus === 'synced';
  const publicationDurabilityStatus = cacheHit
    ? 'cache_verified_durability_not_reproven'
    : publicationDurabilityProven
      ? 'durable'
      : 'directory_sync_unsupported';
  const binaryHash = contentHash(binaryBytes);
  const elf = elfIdentity(binaryBytes);
  if (
    binaryHash !== expectedBinaryHash
    || elf?.operatingSystem !== 'linux'
    || elf?.architecture !== normalizedArchitecture
    || elf?.staticExecutable !== true
    || binaryBytes.byteLength < 1024 * 1024
  ) {
    throw new Error('cold_build_launcher_binary_identity_invalid');
  }
  const buildProjection = {
    schemaVersion: COLD_BUILD_LAUNCHER_BUILD_SCHEMA,
    proofAuthority: COLD_BUILD_LAUNCHER_BUILD_AUTHORITY,
    sourceHash: sourceIdentity.sourceHash,
    sourceByteLength: sourceIdentity.byteLength,
    sourceRepoRelativePath: sourceIdentity.repoRelativePath,
    sourceManifestSchema: sourceIdentity.schemaVersion,
    sourceManifestHash: sourceIdentity.manifestHash,
    sourceManifestRevalidated: true,
    builderImage: builderRecipe.builderImage,
    builderRecipeSchema: builderRecipe.schemaVersion,
    builderRecipeHash: builderRecipe.recipeHash,
    architecture: normalizedArchitecture,
    operatingSystem: elf.operatingSystem,
    staticExecutable: elf.staticExecutable,
    elfProgramHeaderTypes: elf.programHeaderTypes,
    binaryHash,
    expectedBinaryHash,
    binaryByteLength: binaryBytes.byteLength,
    reproducibleHashMatched: true,
    cacheAccepted,
    cacheHit,
    immutableContentAddressedPublication: true,
    mutableBuildLockUsed: false,
    publicationKeyHash,
    publicationManifestHash,
    publicationDirectoryName,
    publicationOutcome,
    publicationCreated: publicationOutcome === 'publication_created',
    publicationRaceObserved,
    publicationPreLinkCoordinationUsed,
    publicationPrimitive: 'hard_link_no_replace',
    publicationSameDevice,
    publicationFileSyncStatus,
    publicationFileSyncErrorCode,
    publicationFileSyncIdentityVerified,
    publicationDirectorySyncBeforeLinkStatus: directorySyncBeforeLink?.status ?? null,
    publicationDirectorySyncBeforeLinkErrorCode:
      directorySyncBeforeLink?.errorCode ?? null,
    publicationDirectorySyncAfterLinkStatus: directorySyncAfterLink?.status ?? null,
    publicationDirectorySyncAfterLinkErrorCode:
      directorySyncAfterLink?.errorCode ?? null,
    publicationDirectorySyncAfterCleanupStatus:
      directorySyncAfterCleanup?.status ?? null,
    publicationDirectorySyncAfterCleanupErrorCode:
      directorySyncAfterCleanup?.errorCode ?? null,
    publicationIntegrityAccepted: true,
    executionTimePathBindingRequired: true,
    canAuthorizeLauncherExecution: false,
    publicationDurabilityProven,
    publicationDurabilityStatus,
    publicationDirectoryHierarchySyncAttempted: true,
    publicationDirectoryHierarchySyncAccepted:
      publicationDirectoryHierarchySync.accepted,
    publicationDirectoryHierarchySyncCount:
      publicationDirectoryHierarchySync.directoryCount,
    publicationDirectoryHierarchySyncSyncedCount:
      publicationDirectoryHierarchySync.syncedCount,
    publicationDirectoryHierarchySyncUnsupportedCount:
      publicationDirectoryHierarchySync.unsupportedCount,
    publicationDirectoryHierarchySyncEvidenceHash:
      publicationDirectoryHierarchySync.evidenceHash,
    finalBinaryVerified: finalInspection.accepted,
    finalBinaryVerifiedAfterDirectoryRevalidation: true,
    finalBinaryRegularFile: finalInspection.regularFile,
    finalBinarySymbolicLink: finalInspection.symbolicLink,
    finalBinaryStableIdentity: finalInspection.stableIdentity,
    finalBinaryStableMetadata: finalInspection.stableMetadata,
    finalBinarySecondHandleIdentityVerified:
      finalInspection.secondHandleIdentityVerified,
    finalBinaryCanonicalPathStable: finalInspection.canonicalPathStable,
    finalBinaryImmutableMode: finalInspection.immutableMode,
    finalBinaryExecutableModeObserved: finalInspection.executable,
    finalBinaryExecutableModeApplicable: finalInspection.executableModeApplicable,
    finalBinaryExecutableModeAccepted: finalInspection.executableModeAccepted,
    finalBinaryMode: finalInspection.mode,
    finalBinaryInodeIdentityHash: finalInspection.inodeIdentityHash,
    finalBinaryLinkCount: finalInspection.linkCount,
    trustedCacheRootAccepted: trustedRoot.inspection.accepted,
    trustedCacheRootRevalidated: trustedRootRevalidation.accepted,
    trustedCacheRootPermissionVerification:
      trustedRoot.inspection.permissionVerification,
    trustedCacheRootPermissionOwnershipRecomputed:
      trustedRoot.inspection.platformPermissionOwnershipRecomputed,
    trustedCacheRootPermissionLimitation:
      trustedRoot.inspection.platformPermissionOwnershipRecomputed
        ? null
        : 'windows_acl_not_recomputed_execution_time_hash_required',
    trustedCacheRootEvidenceHash: contentHash(stableJson(trustedRoot.inspection)),
    trustedCacheRootIdentityRevalidated:
      trustedRootRevalidation.identityHash === trustedRoot.inspection.identityHash,
    trustedCacheRootAncestorCount: trustedRoot.ancestorCount,
    trustedCacheRootAncestorEvidenceHash: trustedRoot.ancestorEvidenceHash,
    trustedCacheRootAncestorRevalidated:
      ancestorRevalidationHash === trustedRoot.ancestorEvidenceHash,
    publicationDirectoryChainAccepted: publicationDirectoryChain.inspections.every(
      (inspection) => inspection.accepted,
    ),
    publicationDirectoryChainEvidenceHash: contentHash(stableJson(
      publicationDirectoryChain.inspections,
    )),
    publicationDirectoryRevalidated: publicationDirectoryChainRevalidations.every(
      (inspection, index) => inspection.accepted
        && inspection.identityHash
          === publicationDirectoryChain.inspections[index].identityHash,
    ),
    staleCandidateCleanupAccepted: staleCandidateCleanup.accepted,
    staleCandidateCleanupScannedCount: staleCandidateCleanup.scannedCount,
    staleCandidateCleanupRemovedCount: staleCandidateCleanup.staleRemovedCount,
    staleCandidateCleanupRecentIgnoredCount: staleCandidateCleanup.recentIgnoredCount,
    staleCandidateCleanupFutureTimestampCount:
      staleCandidateCleanup.futureTimestampCount,
    staleCandidateCleanupLeafRemovalAttemptCount:
      staleCandidateCleanup.leafRemovalAttemptCount,
    staleCandidateCleanupNonEmptyRetainedCount:
      staleCandidateCleanup.nonEmptyRetainedCount,
    staleCandidateCleanupRecursiveTraversalUsed:
      staleCandidateCleanup.recursiveTraversalUsed,
    staleCandidateCleanupBoundedLimitExceeded:
      staleCandidateCleanup.boundedLimitExceeded,
    staleCandidateCleanupEvidenceHash: staleCandidateCleanup.evidenceHash,
    staleBuildCleanupAccepted: staleBuildCleanup.accepted,
    staleBuildCleanupScannedCount: staleBuildCleanup.scannedCount,
    staleBuildCleanupRemovedCount: staleBuildCleanup.staleRemovedCount,
    staleBuildCleanupRecentIgnoredCount: staleBuildCleanup.recentIgnoredCount,
    staleBuildCleanupFutureTimestampCount: staleBuildCleanup.futureTimestampCount,
    staleBuildCleanupLeafRemovalAttemptCount: staleBuildCleanup.leafRemovalAttemptCount,
    staleBuildCleanupNonEmptyRetainedCount: staleBuildCleanup.nonEmptyRetainedCount,
    staleBuildCleanupRecursiveTraversalUsed: staleBuildCleanup.recursiveTraversalUsed,
    staleBuildCleanupBoundedLimitExceeded: staleBuildCleanup.boundedLimitExceeded,
    staleBuildCleanupEvidenceHash: staleBuildCleanup.evidenceHash,
    directoryLeaseCount: directoryLeases.length,
    directoryLeasesHeldThroughVerification: true,
    directoryLeaseStatBoundCount: directoryLeases.filter(
      (lease) => lease.statBound,
    ).length,
    directoryLeaseFallbackCount: directoryLeases.filter(
      (lease) => !lease.statBound,
    ).length,
    directoryLeaseStatBindingAccepted: process.platform === 'win32'
      || directoryLeases.every((lease) => lease.statBound),
    directoryLeaseFallbackLimitation: directoryLeases.some((lease) => !lease.statBound)
      ? 'windows_directory_handle_stat_binding_unavailable_execution_time_hash_required'
      : null,
    coalescedPublicationWait,
    buildExecuted: buildResult !== null,
    buildCommandHash: buildArgs ? contentHash(stableJson(buildArgs)) : null,
    buildExitCode: buildResult?.exitCode ?? null,
    buildStdoutHash: buildResult ? contentHash(buildResult.stdout) : null,
    buildStderrHash: buildResult ? contentHash(buildResult.stderr) : null,
    builderContainerIdentityHash: builderContainerName
      ? contentHash(builderContainerName)
      : null,
    builderCleanupAttempted: builderCleanup?.attempted ?? false,
    builderCleanupAccepted: builderCleanup?.accepted ?? true,
    builderCleanupRemovalExitCode: builderCleanup?.removalExitCode ?? null,
    builderCleanupAbsenceObservationExitCode:
      builderCleanup?.absenceObservationExitCode ?? null,
    builderCleanupEvidenceHash: builderCleanup
      ? contentHash(stableJson(builderCleanup))
      : null,
    accepted: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  };
  const launcherIdentity = Object.freeze({
    executablePath: cachedBinaryPath,
    binaryHash,
    architecture: normalizedArchitecture,
    sourceIdentity: Object.freeze({ ...sourceIdentity }),
    buildEvidence: Object.freeze({
      ...buildProjection,
      evidenceHash: contentHash(stableJson(buildProjection)),
    }),
  });
  PINNED_LAUNCHER_IDENTITIES.set(launcherIdentity, Object.freeze({
    architecture: normalizedArchitecture,
    executableHash: binaryHash,
  }));
  return launcherIdentity;
  } finally {
    await closePrivateDirectoryLeases(directoryLeases);
  }
}

export async function materializeColdBuildLauncher({
  dockerExecutable = 'docker',
  architecture,
  cacheRoot = coldBuildLauncherDefaultCacheRoot(),
  beforePublicationLink = null,
} = {}) {
  if (beforePublicationLink !== null && typeof beforePublicationLink !== 'function') {
    throw new Error('cold_build_launcher_before_publication_link_invalid');
  }
  const descriptor = await coldBuildLauncherPublicationDescriptor({ architecture, cacheRoot });
  const materializationKey = contentHash(stableJson({
    cacheRoot: normalizedPathIdentity(descriptor.resolvedCacheRoot),
    dockerExecutable: String(dockerExecutable),
    publicationKeyHash: descriptor.publicationKeyHash,
  }));
  const activeMaterialization = activeLauncherMaterializations.get(materializationKey);
  if (activeMaterialization) {
    await activeMaterialization;
    return materializeColdBuildLauncherOnce({
      dockerExecutable,
      descriptor,
      coalescedPublicationWait: true,
      beforePublicationLink,
    });
  }
  const materialization = materializeColdBuildLauncherOnce({
    dockerExecutable,
    descriptor,
    coalescedPublicationWait: false,
    beforePublicationLink,
  });
  activeLauncherMaterializations.set(materializationKey, materialization);
  try {
    return await materialization;
  } finally {
    if (activeLauncherMaterializations.get(materializationKey) === materialization) {
      activeLauncherMaterializations.delete(materializationKey);
    }
  }
}

export function coldBuildLauncherEntrypoint() {
  return [COLD_BUILD_LAUNCHER_CONTAINER_PATH];
}

export function coldBuildLauncherCommand() {
  return ['run', '--spec', COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH];
}

export function coldBuildOutputTmpfsOptions(workspaceBytes, workspaceEntryCount) {
  return [
    'exec',
    `gid=${COLD_BUILD_CONTAINER_COMMAND_GID}`,
    'mode=0770',
    'nodev',
    `nr_inodes=${workspaceEntryCount}`,
    'nosuid',
    'rw',
    `size=${workspaceBytes}`,
    `uid=${COLD_BUILD_CONTAINER_COMMAND_UID}`,
  ].sort();
}

export function coldBuildControlTmpfsOptions() {
  return [
    'gid=0',
    'mode=0700',
    'nodev',
    'noexec',
    'nosuid',
    'rw',
    `size=${COLD_BUILD_CONTAINER_CONTROL_TMPFS_BYTES}`,
    'uid=0',
  ].sort();
}

export function coldBuildTmpfsOptions() {
  return [
    'exec',
    'nodev',
    'nosuid',
    'rw',
    `size=${COLD_BUILD_CONTAINER_TMP_BYTES}`,
  ].sort();
}

export function coldBuildLauncherSpec({
  executionNonce,
  launcherIdentity,
  commandSpecHash,
  sourceBindingHash,
  command,
  args = [],
  environment = [],
  workingDirectory,
  commandTimeoutMillis,
  releaseTimeoutMillis = COLD_BUILD_CONTAINER_RELEASE_TIMEOUT_MS,
  workspaceByteLimit,
  workspaceEntryLimit,
  collectedByteLimit,
  collectedEntryLimit,
  outputManifestMode = COLD_BUILD_OUTPUT_MANIFEST_MODE_COMMAND_PROVIDED,
  declaredOutputs = [],
} = {}) {
  const pinnedLauncher = requirePinnedLauncherIdentity(launcherIdentity);
  const normalizedDeclaredOutputs = normalizeDeclaredOutputs(
    outputManifestMode,
    declaredOutputs,
    collectedEntryLimit,
  );
  return {
    schemaVersion: COLD_BUILD_LAUNCHER_SPEC_SCHEMA,
    executionNonce,
    expectedLauncherExecutableHash: pinnedLauncher.executableHash,
    commandSpecHash,
    sourceBindingHash,
    command: [command, ...args],
    environment: [...environment].sort(),
    workingDirectory,
    commandUid: COLD_BUILD_CONTAINER_COMMAND_UID,
    commandGid: COLD_BUILD_CONTAINER_COMMAND_GID,
    sourceRoot: COLD_BUILD_LAUNCHER_SOURCE_ROOT,
    outputRoot: COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
    controlRoot: COLD_BUILD_LAUNCHER_CONTROL_ROOT,
    releaseRoot: COLD_BUILD_LAUNCHER_RELEASE_ROOT,
    outputManifestPath: COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH,
    outputManifestMode,
    declaredOutputs: normalizedDeclaredOutputs,
    commandTimeoutMillis,
    releaseTimeoutMillis,
    workspaceByteLimit,
    workspaceEntryLimit,
    collectedByteLimit,
    collectedEntryLimit,
    processTermGraceMillis: COLD_BUILD_CONTAINER_PROCESS_TERM_GRACE_MS,
    processKillGraceMillis: COLD_BUILD_CONTAINER_PROCESS_KILL_GRACE_MS,
  };
}

export function encodeColdBuildLauncherSpec(spec) {
  return Buffer.from(stableJson(spec), 'utf8');
}

export function coldBuildLauncherSpecHash(spec) {
  return contentHash(encodeColdBuildLauncherSpec(spec));
}

export function parseColdBuildControlFrame(buffer, {
  maxReceiptBytes,
  expectedExecutionNonce,
  expectedLauncherIdentity,
  expectedSpecHash,
  expectedCommandSpecHash,
  expectedSourceBindingHash,
} = {}) {
  const pinnedLauncher = requirePinnedLauncherIdentity(expectedLauncherIdentity);
  if (
    !Number.isSafeInteger(maxReceiptBytes)
    || maxReceiptBytes < 2
    || !/^[a-f0-9]{32}$/.test(expectedExecutionNonce ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedSpecHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedCommandSpecHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedSourceBindingHash ?? '')
  ) {
    throw new Error('cold_build_control_parser_bounds_or_bindings_invalid');
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const prefixLength = COLD_BUILD_CONTROL_FRAME_MAGIC.byteLength;
  if (
    bytes.byteLength < prefixLength + 8
    || !bytes.subarray(0, prefixLength).equals(COLD_BUILD_CONTROL_FRAME_MAGIC)
  ) {
    throw new Error('cold_build_control_frame_magic_invalid');
  }
  const receiptLengthBigInt = bytes.readBigUInt64BE(prefixLength);
  if (receiptLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('cold_build_control_receipt_length_invalid');
  }
  const receiptLength = Number(receiptLengthBigInt);
  const receiptStart = prefixLength + 8;
  if (
    receiptLength < 2
    || receiptLength > maxReceiptBytes
    || bytes.byteLength !== receiptStart + receiptLength
  ) {
    throw new Error('cold_build_control_receipt_length_invalid');
  }
  const receiptBytes = bytes.subarray(receiptStart);
  let receipt;
  try {
    receipt = JSON.parse(receiptBytes.toString('utf8'));
  } catch {
    throw new Error('cold_build_control_receipt_json_invalid');
  }
  const processTree = receipt?.processTree;
  const streamReceipts = [receipt?.commandStdout, receipt?.commandStderr];
  const blockingGaps = receipt?.blockingGaps;
  const gapsCanonical = Array.isArray(blockingGaps)
    && blockingGaps.every(
      (value, index) => typeof value === 'string'
        && value.length > 0
        && (index === 0 || value > blockingGaps[index - 1]),
    );
  const processIdsValid = (values) => Array.isArray(values)
    && values.every((value) => Number.isSafeInteger(value));
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || stableJson(Object.keys(receipt).sort()) !== stableJson([
      'blockingGaps',
      'childExitCode',
      'childIdentityAccepted',
      'childIdentityReceiptHash',
      'commandSpecHash',
      'commandStderr',
      'commandStdout',
      'commandTimedOut',
      'executionNonce',
      'launcherElapsedNanos',
      'launcherExecutableSelfHash',
      'launcherSchemaVersion',
      'outputByteLength',
      'outputEntryCount',
      'outputSnapshotAccepted',
      'outputSnapshotHash',
      'processTree',
      'protocolAccepted',
      'schemaVersion',
      'sourceBindingHash',
      'specHash',
    ].sort())
    || receipt.schemaVersion !== 'synthi.gpu_hmr.cold_build_ready_receipt.v2'
    || receipt.launcherSchemaVersion !== COLD_BUILD_LAUNCHER_SCHEMA
    || receipt.launcherExecutableSelfHash !== pinnedLauncher.executableHash
    || receipt.executionNonce !== expectedExecutionNonce
    || receipt.specHash !== expectedSpecHash
    || receipt.commandSpecHash !== expectedCommandSpecHash
    || receipt.sourceBindingHash !== expectedSourceBindingHash
    || typeof receipt.childIdentityReceiptHash !== 'string'
    || (
      receipt.childIdentityReceiptHash !== ''
      && !/^sha256:[a-f0-9]{64}$/.test(receipt.childIdentityReceiptHash)
    )
    || typeof receipt.childIdentityAccepted !== 'boolean'
    || !Number.isSafeInteger(receipt.childExitCode)
    || receipt.childExitCode < 0
    || receipt.childExitCode > 255
    || typeof receipt.commandTimedOut !== 'boolean'
    || streamReceipts.some((stream) => (
      !stream
      || typeof stream !== 'object'
      || Array.isArray(stream)
      || stableJson(Object.keys(stream).sort()) !== stableJson([
        'byteLength',
        'contentHash',
      ])
      || !Number.isSafeInteger(stream.byteLength)
      || stream.byteLength < 0
      || typeof stream.contentHash !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(stream.contentHash)
    ))
    || !processTree
    || typeof processTree !== 'object'
    || Array.isArray(processTree)
    || stableJson(Object.keys(processTree).sort()) !== stableJson([
      'directChildPid',
      'finalResidualPids',
      'initialResidualPids',
      'killSignalCount',
      'quiescent',
      'reapedChildCount',
      'termSignalCount',
    ].sort())
    || !Number.isSafeInteger(processTree.directChildPid)
    || processTree.directChildPid < 1
    || !processIdsValid(processTree.initialResidualPids)
    || !processIdsValid(processTree.finalResidualPids)
    || !Number.isSafeInteger(processTree.termSignalCount)
    || processTree.termSignalCount < 0
    || !Number.isSafeInteger(processTree.killSignalCount)
    || processTree.killSignalCount < 0
    || !Number.isSafeInteger(processTree.reapedChildCount)
    || processTree.reapedChildCount < 0
    || typeof processTree.quiescent !== 'boolean'
    || typeof receipt.outputSnapshotAccepted !== 'boolean'
    || typeof receipt.outputSnapshotHash !== 'string'
    || (
      receipt.outputSnapshotHash !== ''
      && !/^sha256:[a-f0-9]{64}$/.test(receipt.outputSnapshotHash)
    )
    || !Number.isSafeInteger(receipt.outputEntryCount)
    || receipt.outputEntryCount < 0
    || !Number.isSafeInteger(receipt.outputByteLength)
    || receipt.outputByteLength < 0
    || !Number.isSafeInteger(receipt.launcherElapsedNanos)
    || receipt.launcherElapsedNanos < 0
    || typeof receipt.protocolAccepted !== 'boolean'
    || !gapsCanonical
    || receipt.protocolAccepted !== (blockingGaps.length === 0)
    || (
      receipt.protocolAccepted
      && (
        receipt.childIdentityAccepted !== true
        || receipt.outputSnapshotAccepted !== true
        || processTree.quiescent !== true
        || processTree.finalResidualPids.length !== 0
        || !/^sha256:[a-f0-9]{64}$/.test(receipt.outputSnapshotHash)
      )
    )
  ) {
    throw new Error('cold_build_control_receipt_binding_invalid');
  }
  return {
    receipt,
    receiptBytes,
    receiptHash: contentHash(receiptBytes),
    frameHash: contentHash(bytes),
  };
}

export function parseColdBuildCollectorCompletionReceipt(buffer, {
  maxReceiptBytes,
  expectedExecutionNonce,
  expectedSpecHash,
  expectedReadyReceiptHash,
  expectedOutputSnapshotHash,
  expectedCollectorReceiptHash,
  expectedCollectorFrameHash,
  expectedCollectorFrameByteLength,
} = {}) {
  if (
    !Number.isSafeInteger(maxReceiptBytes)
    || maxReceiptBytes < 2
    || !/^[a-f0-9]{32}$/.test(expectedExecutionNonce ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedSpecHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedReadyReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedOutputSnapshotHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedCollectorReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedCollectorFrameHash ?? '')
    || !Number.isSafeInteger(expectedCollectorFrameByteLength)
    || expectedCollectorFrameByteLength < 1
  ) {
    throw new Error('cold_build_collector_completion_bindings_invalid');
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.byteLength < 2 || bytes.byteLength > maxReceiptBytes) {
    throw new Error('cold_build_collector_completion_length_invalid');
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('cold_build_collector_completion_json_invalid');
  }
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || stableJson(Object.keys(receipt).sort()) !== stableJson([
      'collectorFrameByteLength',
      'collectorFrameHash',
      'collectorReceiptHash',
      'executionNonce',
      'outputSnapshotHash',
      'readyReceiptHash',
      'schemaVersion',
      'specHash',
    ].sort())
    || receipt.schemaVersion !== COLD_BUILD_COLLECTOR_COMPLETION_SCHEMA
    || receipt.executionNonce !== expectedExecutionNonce
    || receipt.specHash !== expectedSpecHash
    || receipt.readyReceiptHash !== expectedReadyReceiptHash
    || receipt.outputSnapshotHash !== expectedOutputSnapshotHash
    || receipt.collectorReceiptHash !== expectedCollectorReceiptHash
    || receipt.collectorFrameHash !== expectedCollectorFrameHash
    || receipt.collectorFrameByteLength !== expectedCollectorFrameByteLength
  ) {
    throw new Error('cold_build_collector_completion_binding_invalid');
  }
  return {
    receipt,
    receiptBytes: bytes,
    receiptHash: contentHash(bytes),
  };
}

export function parseColdBuildFinalReceipt(buffer, {
  maxReceiptBytes,
  expectedExecutionNonce,
  expectedSpecHash,
  expectedReadyReceiptHash,
  expectedReleaseReceiptHash,
  expectedCollectorCompletionReceiptHash,
  expectedCollectorReceiptHash,
  expectedCollectorFrameHash,
  expectedCollectorFrameByteLength,
  expectedHostReceiptHash,
  expectedChildExitCode,
} = {}) {
  if (
    !Number.isSafeInteger(maxReceiptBytes)
    || maxReceiptBytes < 2
    || !/^[a-f0-9]{32}$/.test(expectedExecutionNonce ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedSpecHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedReadyReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedReleaseReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedCollectorCompletionReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedCollectorReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedCollectorFrameHash ?? '')
    || !Number.isSafeInteger(expectedCollectorFrameByteLength)
    || expectedCollectorFrameByteLength < 1
    || !/^sha256:[a-f0-9]{64}$/.test(expectedHostReceiptHash ?? '')
    || !Number.isSafeInteger(expectedChildExitCode)
    || expectedChildExitCode < 0
    || expectedChildExitCode > 255
  ) {
    throw new Error('cold_build_final_receipt_bindings_invalid');
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  if (bytes.byteLength < 2 || bytes.byteLength > maxReceiptBytes) {
    throw new Error('cold_build_final_receipt_length_invalid');
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('cold_build_final_receipt_json_invalid');
  }
  if (
    !receipt
    || typeof receipt !== 'object'
    || Array.isArray(receipt)
    || stableJson(Object.keys(receipt).sort()) !== stableJson([
      'childExitCode',
      'collectorCompletionReceiptHash',
      'collectorFrameByteLength',
      'collectorFrameHash',
      'collectorReceiptHash',
      'executionNonce',
      'hostReceiptHash',
      'protocolAccepted',
      'readyReceiptHash',
      'releaseReceiptHash',
      'schemaVersion',
      'specHash',
    ].sort())
    || receipt.schemaVersion !== 'synthi.gpu_hmr.cold_build_final_receipt.v1'
    || receipt.executionNonce !== expectedExecutionNonce
    || receipt.specHash !== expectedSpecHash
    || receipt.readyReceiptHash !== expectedReadyReceiptHash
    || receipt.releaseReceiptHash !== expectedReleaseReceiptHash
    || receipt.collectorCompletionReceiptHash !== expectedCollectorCompletionReceiptHash
    || receipt.collectorReceiptHash !== expectedCollectorReceiptHash
    || receipt.collectorFrameHash !== expectedCollectorFrameHash
    || receipt.collectorFrameByteLength !== expectedCollectorFrameByteLength
    || receipt.hostReceiptHash !== expectedHostReceiptHash
    || receipt.childExitCode !== expectedChildExitCode
    || receipt.protocolAccepted !== true
  ) {
    throw new Error('cold_build_final_receipt_binding_invalid');
  }
  return {
    receipt,
    receiptBytes: bytes,
    receiptHash: contentHash(bytes),
  };
}

export function parseColdBuildCollectorFrame(buffer, {
  maxHeaderBytes,
  maxPayloadBytes,
  maxEntryCount,
  expectedExecutionNonce,
  expectedSpecHash,
  expectedReadyReceiptHash,
  expectedOutputSnapshotHash,
} = {}) {
  if (
    !Number.isSafeInteger(maxHeaderBytes)
    || maxHeaderBytes < 2
    || !Number.isSafeInteger(maxPayloadBytes)
    || maxPayloadBytes < 1
    || !Number.isSafeInteger(maxEntryCount)
    || maxEntryCount < 1
    || !/^[a-f0-9]{32}$/.test(expectedExecutionNonce ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedSpecHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedReadyReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(expectedOutputSnapshotHash ?? '')
  ) {
    throw new Error('cold_build_collector_parser_bounds_or_bindings_invalid');
  }
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer ?? []);
  const prefixLength = COLD_BUILD_COLLECTOR_FRAME_MAGIC.byteLength;
  if (
    bytes.byteLength < prefixLength + 8
    || !bytes.subarray(0, prefixLength).equals(COLD_BUILD_COLLECTOR_FRAME_MAGIC)
  ) {
    throw new Error('cold_build_collector_frame_magic_invalid');
  }
  const headerLengthBigInt = bytes.readBigUInt64BE(prefixLength);
  if (headerLengthBigInt > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('cold_build_collector_header_length_invalid');
  }
  const headerLength = Number(headerLengthBigInt);
  if (headerLength < 2 || headerLength > maxHeaderBytes) {
    throw new Error('cold_build_collector_header_length_invalid');
  }
  const headerStart = prefixLength + 8;
  const payloadStart = headerStart + headerLength;
  if (payloadStart > bytes.byteLength) {
    throw new Error('cold_build_collector_frame_truncated');
  }
  let receipt;
  try {
    receipt = JSON.parse(bytes.subarray(headerStart, payloadStart).toString('utf8'));
  } catch {
    throw new Error('cold_build_collector_header_json_invalid');
  }
  const entries = Array.isArray(receipt?.entries) ? receipt.entries : [];
  const receiptKeys = Object.keys(receipt ?? {}).sort();
  if (
    stableJson(receiptKeys) !== stableJson([
      'collectedByteLength',
      'entries',
      'executionNonce',
      'outputSnapshotHash',
      'readyReceiptHash',
      'schemaVersion',
      'specHash',
    ].sort())
    || receipt.schemaVersion !== 'synthi.gpu_hmr.cold_build_collector_receipt.v1'
    || !/^[a-f0-9]{32}$/.test(receipt.executionNonce ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.specHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.readyReceiptHash ?? '')
    || !/^sha256:[a-f0-9]{64}$/.test(receipt.outputSnapshotHash ?? '')
    || receipt.executionNonce !== expectedExecutionNonce
    || receipt.specHash !== expectedSpecHash
    || receipt.readyReceiptHash !== expectedReadyReceiptHash
    || receipt.outputSnapshotHash !== expectedOutputSnapshotHash
    || !Number.isSafeInteger(receipt.collectedByteLength)
    || receipt.collectedByteLength < 0
    || entries.length < 1
    || entries.length > maxEntryCount
  ) {
    throw new Error('cold_build_collector_receipt_shape_invalid');
  }
  const seenPaths = new Set();
  let previousPath = null;
  const declaredPayloadBytes = entries.reduce((total, entry) => {
    const byteLength = Number(entry?.byteLength);
    const relativePath = String(entry?.path ?? '');
    const normalizedPath = path.posix.normalize(relativePath);
    if (
      stableJson(Object.keys(entry ?? {}).sort()) !== stableJson([
        'byteLength',
        'contentHash',
        'mode',
        'path',
      ].sort())
      || typeof entry?.byteLength !== 'number'
      || !Number.isSafeInteger(byteLength)
      || byteLength < 0
      || !relativePath
      || normalizedPath !== relativePath
      || normalizedPath === '.'
      || normalizedPath.startsWith('../')
      || path.posix.isAbsolute(normalizedPath)
      || path.win32.isAbsolute(normalizedPath)
      || /[\\\0\r\n]/.test(normalizedPath)
      || seenPaths.has(normalizedPath)
      || (
        previousPath !== null
        && Buffer.compare(Buffer.from(normalizedPath), Buffer.from(previousPath)) <= 0
      )
      || !/^sha256:[a-f0-9]{64}$/.test(entry?.contentHash ?? '')
      || !Number.isSafeInteger(entry?.mode)
      || entry.mode < 0
      || entry.mode > 0o777
    ) {
      throw new Error('cold_build_collector_entry_invalid');
    }
    seenPaths.add(normalizedPath);
    previousPath = normalizedPath;
    return total + byteLength;
  }, 0);
  if (
    !Number.isSafeInteger(declaredPayloadBytes)
    || declaredPayloadBytes !== receipt.collectedByteLength
    || declaredPayloadBytes > maxPayloadBytes
    || bytes.byteLength !== payloadStart + declaredPayloadBytes
  ) {
    throw new Error('cold_build_collector_payload_length_invalid');
  }
  const payloads = [];
  let offset = payloadStart;
  for (const entry of entries) {
    const payload = bytes.subarray(offset, offset + entry.byteLength);
    const observedHash = contentHash(payload);
    if (observedHash !== entry.contentHash) {
      throw new Error('cold_build_collector_payload_hash_mismatch');
    }
    payloads.push({ entry, bytes: payload });
    offset += entry.byteLength;
  }
  const receiptBytes = bytes.subarray(headerStart, payloadStart);
  return {
    receipt,
    receiptBytes,
    receiptHash: contentHash(receiptBytes),
    payloads,
    frameHash: contentHash(bytes),
  };
}
