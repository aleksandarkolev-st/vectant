import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COLD_BUILD_CONTAINER_PROTOCOL_SCHEMA =
  'synthi.gpu_hmr.cold_build_container_protocol.v2';
export const COLD_BUILD_CONTAINER_PROTOCOL_AUTHORITY =
  'isolated_command_transport_only_not_gpu_hmr_success';
export const COLD_BUILD_LAUNCHER_SCHEMA =
  'synthi.gpu_hmr.cold_build_static_launcher.v2';
export const COLD_BUILD_LAUNCHER_SPEC_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_spec.v2';
export const COLD_BUILD_LAUNCHER_BUILD_SCHEMA =
  'synthi.gpu_hmr.cold_build_launcher_build.v1';
export const COLD_BUILD_LAUNCHER_BUILD_AUTHORITY =
  'content_addressed_launcher_build_only_not_gpu_hmr_success';
export const COLD_BUILD_LAUNCHER_BUILDER_IMAGE =
  'golang@sha256:3641e0d9b931dc4f2f185dcd669c4679670e9277c8166a838ddb98a2d4389cb5';
export const COLD_BUILD_LAUNCHER_CONTAINER_PATH =
  '/synthi-tools/cold-build-launcher';
export const COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH = '/synthi-spec/spec.json';
export const COLD_BUILD_LAUNCHER_SOURCE_ROOT = '/workspace/source';
export const COLD_BUILD_LAUNCHER_OUTPUT_ROOT = '/workspace/build';
export const COLD_BUILD_LAUNCHER_CONTROL_ROOT = '/synthi-control';
export const COLD_BUILD_LAUNCHER_RELEASE_ROOT = '/synthi-release';
export const COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH =
  'synthi-cold-build-output-manifest.json';
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

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const COLD_BUILD_LAUNCHER_SOURCE_PATH = path.resolve(
  MODULE_DIR,
  '..',
  'native',
  'cold-build-launcher',
  'main.go',
);

const EXPECTED_LAUNCHER_HASHES = Object.freeze({
  amd64: 'sha256:cc4c5c3c4e23a419dce0c5151085381e5729a00e9109f1bc662d7b4e6dc46f46',
  arm64: 'sha256:1667187e33cec7c6a68c4c51fd961ddaf96b1acf7f9e88079fec1a2f51f982c5',
});
const PINNED_LAUNCHER_IDENTITIES = new WeakMap();

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

function normalizeArchitecture(value) {
  const architecture = String(value ?? '').trim().toLowerCase();
  if (architecture === 'x64' || architecture === 'x86_64') return 'amd64';
  if (architecture === 'aarch64') return 'arm64';
  return architecture;
}

export function runColdBuildHostProcess(executable, args, {
  timeoutMs = 120_000,
  maxStdoutBytes = 1024 * 1024,
  maxStderrBytes = 1024 * 1024,
  encoding = 'utf8',
  onStdoutChunk = null,
} = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(executable, args, {
        windowsHide: true,
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
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
  });
}

async function hashFile(filePath) {
  return contentHash(await readFile(filePath));
}

async function cachedLauncherAccepted(filePath, expectedHash) {
  try {
    const metadata = await stat(filePath);
    return metadata.isFile()
      && metadata.size > 0
      && await hashFile(filePath) === expectedHash;
  } catch {
    return false;
  }
}

async function acquireLauncherBuildLock(lockPath, cachedBinaryPath, expectedHash) {
  const deadline = Date.now() + 240_000;
  const ownerToken = randomBytes(16).toString('hex');
  const owner = {
    schemaVersion: 'synthi.gpu_hmr.cold_build_launcher_lock.v1',
    ownerToken,
    processId: process.pid,
    hostName: os.hostname(),
    platform: process.platform,
    createdAtMs: Date.now(),
  };
  while (Date.now() <= deadline) {
    try {
      const handle = await open(lockPath, 'wx', 0o600);
      try {
        await handle.writeFile(stableJson(owner), 'utf8');
        await handle.sync();
      } finally {
        await handle.close();
      }
      return { acquired: true, cacheAccepted: false, ownerToken };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    if (await cachedLauncherAccepted(cachedBinaryPath, expectedHash)) {
      return { acquired: false, cacheAccepted: true };
    }
    try {
      const metadata = await stat(lockPath);
      const lock = JSON.parse(await readFile(lockPath, 'utf8'));
      const processId = Number(lock?.processId);
      const lockShapeAccepted = lock?.schemaVersion
          === 'synthi.gpu_hmr.cold_build_launcher_lock.v1'
        && /^[a-f0-9]{32}$/.test(lock?.ownerToken ?? '')
        && Number.isSafeInteger(processId)
        && processId > 0
        && typeof lock?.hostName === 'string'
        && lock.hostName.length > 0
        && typeof lock?.platform === 'string'
        && lock.platform.length > 0
        && Number.isSafeInteger(lock?.createdAtMs)
        && lock.createdAtMs > 0;
      const localOwner = lock?.hostName === os.hostname()
        && lock?.platform === process.platform;
      let ownerAlive = true;
      if (localOwner && Number.isSafeInteger(processId) && processId > 0) {
        try {
          process.kill(processId, 0);
        } catch (error) {
          ownerAlive = error?.code !== 'ESRCH';
        }
      }
      if (
        Date.now() - metadata.mtimeMs > 5_000
        && lockShapeAccepted
        && Date.now() - lock.createdAtMs > 5_000
        && localOwner
        && !ownerAlive
      ) {
        await rm(lockPath, { force: true });
        continue;
      }
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('cold_build_launcher_build_lock_timeout');
}

async function releaseLauncherBuildLock(lockPath, ownerToken) {
  if (!/^[a-f0-9]{32}$/.test(ownerToken ?? '')) {
    throw new Error('cold_build_launcher_build_lock_owner_invalid');
  }
  let lock;
  try {
    lock = JSON.parse(await readFile(lockPath, 'utf8'));
  } catch (error) {
    throw new Error(
      `cold_build_launcher_build_lock_read_failed:${error?.message || String(error)}`,
    );
  }
  if (lock?.ownerToken !== ownerToken) {
    throw new Error('cold_build_launcher_build_lock_ownership_lost');
  }
  await rm(lockPath);
}

function launcherBuildArgs({ sourceDir, outputDir, architecture, containerName }) {
  return [
    'run',
    '--rm',
    '--name',
    containerName,
    '--label',
    COLD_BUILD_LAUNCHER_BUILDER_LABEL,
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
    '--env',
    'CGO_ENABLED=0',
    '--env',
    'GOOS=linux',
    '--env',
    `GOARCH=${architecture}`,
    '--env',
    'GOCACHE=/tmp/go-cache',
    '--env',
    'GO111MODULE=off',
    '--entrypoint',
    '/usr/local/go/bin/go',
    '--mount',
    `type=bind,source=${sourceDir},target=/src,readonly`,
    '--mount',
    `type=bind,source=${outputDir},target=/out`,
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    'build',
    '-trimpath',
    '-buildvcs=false',
    '-ldflags=-buildid=',
    '-o',
    '/out/cold-build-launcher',
    '/src/main.go',
  ];
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
  return EXPECTED_LAUNCHER_HASHES[normalizeArchitecture(architecture)] ?? null;
}

function requirePinnedLauncherIdentity(value) {
  const pinnedIdentity = value && typeof value === 'object'
    ? PINNED_LAUNCHER_IDENTITIES.get(value)
    : null;
  const architecture = normalizeArchitecture(value?.architecture);
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
  return {
    sourceHash: contentHash(bytes),
    byteLength: bytes.byteLength,
    repoRelativePath: 'scripts/native/cold-build-launcher/main.go',
  };
}

export async function materializeColdBuildLauncher({
  dockerExecutable = 'docker',
  architecture,
  cacheRoot = path.join(os.tmpdir(), 'synthi-gpu-hmr-tool-cache'),
} = {}) {
  const normalizedArchitecture = normalizeArchitecture(architecture);
  if (!normalizedArchitecture) {
    throw new Error('cold_build_launcher_target_architecture_required');
  }
  const expectedBinaryHash = coldBuildLauncherExpectedHash(normalizedArchitecture);
  if (!expectedBinaryHash) {
    throw new Error(`cold_build_launcher_architecture_unsupported:${normalizedArchitecture}`);
  }
  const sourceIdentity = await coldBuildLauncherSourceIdentity();
  const cacheDirectory = path.join(
    cacheRoot,
    'cold-build-launcher',
    sourceIdentity.sourceHash.slice('sha256:'.length),
    normalizedArchitecture,
  );
  const cachedBinaryPath = path.join(cacheDirectory, 'cold-build-launcher');
  const buildLockPath = path.join(cacheDirectory, 'build.lock');
  await mkdir(cacheDirectory, { recursive: true, mode: 0o700 });
  let cacheAccepted = await cachedLauncherAccepted(cachedBinaryPath, expectedBinaryHash);
  const cacheHit = cacheAccepted;
  let buildResult = null;
  let buildArgs = null;
  let builderContainerName = null;
  let builderCleanup = null;
  let lockAcquired = false;
  let lockOwnerToken = null;
  if (!cacheAccepted) {
    const lock = await acquireLauncherBuildLock(
      buildLockPath,
      cachedBinaryPath,
      expectedBinaryHash,
    );
    lockAcquired = lock.acquired;
    lockOwnerToken = lock.ownerToken ?? null;
    cacheAccepted = lock.cacheAccepted;
  }
  if (!cacheAccepted && lockAcquired) {
    let temporaryDirectory = null;
    try {
      temporaryDirectory = await mkdtemp(path.join(cacheDirectory, 'build-'));
      cacheAccepted = await cachedLauncherAccepted(cachedBinaryPath, expectedBinaryHash);
      if (cacheAccepted) return materializeColdBuildLauncher({
        dockerExecutable,
        architecture: normalizedArchitecture,
        cacheRoot,
      });
      builderContainerName = [
        'synthi-cold-launcher-builder',
        sourceIdentity.sourceHash.slice('sha256:'.length, 'sha256:'.length + 12),
        normalizedArchitecture,
        process.pid,
        randomBytes(6).toString('hex'),
      ].join('-');
      buildArgs = launcherBuildArgs({
        sourceDir: path.dirname(COLD_BUILD_LAUNCHER_SOURCE_PATH),
        outputDir: temporaryDirectory,
        architecture: normalizedArchitecture,
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
      const builtPath = path.join(temporaryDirectory, 'cold-build-launcher');
      if (await hashFile(builtPath) !== expectedBinaryHash) {
        throw new Error('cold_build_launcher_reproducible_hash_mismatch');
      }
      const pendingPath = `${cachedBinaryPath}.pending-${process.pid}-${Date.now()}`;
      await copyFile(builtPath, pendingPath);
      await chmod(pendingPath, 0o755);
      await rm(cachedBinaryPath, { force: true });
      await rename(pendingPath, cachedBinaryPath);
      cacheAccepted = true;
    } finally {
      if (temporaryDirectory) {
        await rm(temporaryDirectory, { recursive: true, force: true });
      }
      await releaseLauncherBuildLock(buildLockPath, lockOwnerToken);
    }
  }
  if (!cacheAccepted) {
    throw new Error('cold_build_launcher_cache_materialization_failed');
  }
  await chmod(cachedBinaryPath, 0o755);
  const binaryBytes = await readFile(cachedBinaryPath);
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
    builderImage: COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    architecture: normalizedArchitecture,
    operatingSystem: elf.operatingSystem,
    staticExecutable: elf.staticExecutable,
    elfProgramHeaderTypes: elf.programHeaderTypes,
    binaryHash,
    binaryByteLength: binaryBytes.byteLength,
    reproducibleHashMatched: true,
    cacheAccepted,
    cacheHit,
    buildLockAcquired: lockAcquired,
    buildLockOwnerTokenHash: lockOwnerToken ? contentHash(lockOwnerToken) : null,
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
}

export function coldBuildLauncherEntrypoint() {
  return [COLD_BUILD_LAUNCHER_CONTAINER_PATH];
}

export function coldBuildLauncherCommand() {
  return ['run', '--spec', COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH];
}

export function coldBuildOutputTmpfsOptions(workspaceBytes, workspaceEntryCount) {
  return [
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
} = {}) {
  const pinnedLauncher = requirePinnedLauncherIdentity(launcherIdentity);
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
