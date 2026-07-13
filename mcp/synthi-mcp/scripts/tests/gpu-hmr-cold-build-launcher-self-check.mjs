import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  chmod,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COLD_BUILD_CONTAINER_CAPABILITIES,
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_BUILDER_LABEL,
  COLD_BUILD_LAUNCHER_CONTAINER_PATH,
  COLD_BUILD_LAUNCHER_CONTROL_ROOT,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
  COLD_BUILD_LAUNCHER_RELEASE_ROOT,
  COLD_BUILD_LAUNCHER_SOURCE_ROOT,
  COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
  COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH,
  COLD_BUILD_COLLECTOR_COMPLETION_SCHEMA,
  COLD_BUILD_COLLECTOR_FRAME_MAGIC,
  COLD_BUILD_CONTROL_FRAME_MAGIC,
  coldBuildControlTmpfsOptions,
  coldBuildLauncherCommand,
  coldBuildLauncherEntrypoint,
  coldBuildLauncherSpec,
  coldBuildLauncherSpecHash,
  coldBuildLauncherSourceIdentity,
  coldBuildOutputTmpfsOptions,
  coldBuildTmpfsOptions,
  encodeColdBuildLauncherSpec,
  materializeColdBuildLauncher,
  parseColdBuildCollectorCompletionReceipt,
  parseColdBuildCollectorFrame,
  parseColdBuildControlFrame,
  parseColdBuildFinalReceipt,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';

const dockerExecutable = process.env.SYNTHI_GPU_HMR_DOCKER_EXECUTABLE || 'docker';
const maxDiagnosticBytes = 1024 * 1024;

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

function rewriteCollectorHeader(frameBytes, mutate) {
  const prefixLength = COLD_BUILD_COLLECTOR_FRAME_MAGIC.byteLength;
  const headerLength = Number(frameBytes.readBigUInt64BE(prefixLength));
  const headerStart = prefixLength + 8;
  const payloadStart = headerStart + headerLength;
  const receipt = JSON.parse(frameBytes.subarray(headerStart, payloadStart).toString('utf8'));
  mutate(receipt);
  const headerBytes = Buffer.from(stableJson(receipt), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(headerBytes.byteLength));
  return Buffer.concat([
    COLD_BUILD_COLLECTOR_FRAME_MAGIC,
    length,
    headerBytes,
    frameBytes.subarray(payloadStart),
  ]);
}

function encodeControlReceiptFrame(receipt) {
  const receiptBytes = Buffer.from(stableJson(receipt), 'utf8');
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(receiptBytes.byteLength));
  return Buffer.concat([COLD_BUILD_CONTROL_FRAME_MAGIC, length, receiptBytes]);
}

function spawnCaptured(executable, args, {
  timeoutMs = 60_000,
  maxStdoutBytes = maxDiagnosticBytes,
  maxStderrBytes = maxDiagnosticBytes,
  encoding = null,
  onStdoutChunk = null,
} = {}) {
  return new Promise((resolve) => {
    const child = spawn(executable, args, {
      windowsHide: true,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let stdoutLength = 0;
    let stderrLength = 0;
    let outputExceeded = false;
    const append = (chunks, chunk, currentLength, maximum) => {
      const bytes = Buffer.from(chunk);
      const remaining = Math.max(0, maximum - currentLength);
      if (remaining > 0) chunks.push(bytes.subarray(0, remaining));
      if (bytes.byteLength > remaining) outputExceeded = true;
      return currentLength + bytes.byteLength;
    };
    child.stdout.on('data', (chunk) => {
      onStdoutChunk?.(Buffer.from(chunk));
      stdoutLength = append(stdout, chunk, stdoutLength, maxStdoutBytes);
      if (outputExceeded) child.kill('SIGKILL');
    });
    child.stderr.on('data', (chunk) => {
      stderrLength = append(stderr, chunk, stderrLength, maxStderrBytes);
      if (outputExceeded) child.kill('SIGKILL');
    });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({
        exitCode: null,
        signal: null,
        timedOut,
        error: error?.message || String(error),
        stdout: Buffer.concat(stdout),
        stderr: Buffer.concat(stderr),
      });
    });
    child.once('close', (exitCode, signal) => {
      clearTimeout(timer);
      const stdoutBuffer = Buffer.concat(stdout);
      const stderrBuffer = Buffer.concat(stderr);
      resolve({
        exitCode,
        signal,
        timedOut,
        error: outputExceeded ? 'process_output_limit_exceeded' : null,
        stdout: encoding ? stdoutBuffer.toString(encoding) : stdoutBuffer,
        stderr: encoding ? stderrBuffer.toString(encoding) : stderrBuffer,
      });
    });
  });
}

async function writeAtomicHostFile(directory, name, value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8');
  const temporaryPath = path.join(
    directory,
    `.${name}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`,
  );
  const destinationPath = path.join(directory, name);
  const handle = await open(temporaryPath, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporaryPath, 0o444);
  await rename(temporaryPath, destinationPath);
}

function launcherContainerCreateArgs({
  containerName,
  launcherPath,
  sourceDir,
  releaseDir,
  specPath,
  outputBytes = 64 * 1024 * 1024,
  outputEntries = 4096,
}) {
  return [
    'create',
    '--pull',
    'never',
    '--name',
    containerName,
    '--network',
    'none',
    '--read-only',
    '--privileged=false',
    '--cap-drop',
    'ALL',
    ...COLD_BUILD_CONTAINER_CAPABILITIES.flatMap((capability) => ['--cap-add', capability]),
    '--security-opt',
    'no-new-privileges=true',
    '--pids-limit',
    '128',
    '--memory',
    String(1024 * 1024 * 1024),
    '--memory-swap',
    String(1024 * 1024 * 1024),
    '--cpus',
    '2',
    '--ipc',
    'private',
    '--user',
    '0:0',
    '--no-healthcheck',
    '--env',
    'LD_PRELOAD=/image-owned-preload-must-not-control-launcher.so',
    '--tmpfs',
    `/tmp:${coldBuildTmpfsOptions().join(',')}`,
    '--tmpfs',
    `${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}:${coldBuildOutputTmpfsOptions(outputBytes, outputEntries).join(',')}`,
    '--tmpfs',
    `${COLD_BUILD_LAUNCHER_CONTROL_ROOT}:${coldBuildControlTmpfsOptions().join(',')}`,
    '--mount',
    `type=bind,source=${sourceDir},target=${COLD_BUILD_LAUNCHER_SOURCE_ROOT},readonly`,
    '--mount',
    `type=bind,source=${releaseDir},target=${COLD_BUILD_LAUNCHER_RELEASE_ROOT},readonly`,
    '--mount',
    `type=bind,source=${specPath},target=${COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH},readonly`,
    '--mount',
    `type=bind,source=${launcherPath},target=${COLD_BUILD_LAUNCHER_CONTAINER_PATH},readonly`,
    '--workdir',
    '/',
    '--entrypoint',
    coldBuildLauncherEntrypoint()[0],
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    ...coldBuildLauncherCommand(),
  ];
}

function beginAttachedContainer(containerId, {
  executionNonce,
  specHash,
  commandSpecHash,
  sourceBindingHash,
  timeoutMs = 20_000,
}) {
  let controlFrameBuffer = Buffer.alloc(0);
  let settled = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const timeout = setTimeout(() => {
    if (!settled) {
      settled = true;
      rejectReady(new Error('launcher ready control frame timeout'));
    }
  }, timeoutMs);
  const onStdoutChunk = (chunk) => {
    if (settled) return;
    controlFrameBuffer = Buffer.concat([controlFrameBuffer, chunk]);
    const prefixLength = COLD_BUILD_CONTROL_FRAME_MAGIC.byteLength;
    if (controlFrameBuffer.byteLength < prefixLength + 8) return;
    if (!controlFrameBuffer.subarray(0, prefixLength).equals(COLD_BUILD_CONTROL_FRAME_MAGIC)) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(new Error('launcher control frame magic mismatch'));
      return;
    }
    const receiptLengthBigInt = controlFrameBuffer.readBigUInt64BE(prefixLength);
    if (receiptLengthBigInt > BigInt(maxDiagnosticBytes)) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(new Error('launcher control frame length invalid'));
      return;
    }
    const frameLength = prefixLength + 8 + Number(receiptLengthBigInt);
    if (controlFrameBuffer.byteLength < frameLength) return;
    try {
      const parsed = parseColdBuildControlFrame(
        controlFrameBuffer.subarray(0, frameLength),
        {
          maxReceiptBytes: maxDiagnosticBytes,
          expectedExecutionNonce: executionNonce,
          expectedSpecHash: specHash,
          expectedCommandSpecHash: commandSpecHash,
          expectedSourceBindingHash: sourceBindingHash,
        },
      );
      settled = true;
      clearTimeout(timeout);
      resolveReady(parsed);
    } catch (error) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(error);
    }
  };
  const completion = runDocker(['start', '--attach', containerId], {
    timeoutMs: timeoutMs + 25_000,
    maxStdoutBytes: 4 * 1024 * 1024,
    maxStderrBytes: 4 * 1024 * 1024,
    onStdoutChunk,
  });
  completion.then((result) => {
    if (!settled) {
      settled = true;
      clearTimeout(timeout);
      rejectReady(new Error(`launcher exited before ready: ${result.stderr || result.exitCode}`));
    }
  });
  return { completion, ready };
}

async function runProtocolRefusalScenario({ launcher, mode }) {
  const executionNonce = randomBytes(16).toString('hex');
  const commandSpecHash = contentHash(`protocol-refusal-command:${mode}`);
  const sourceBindingHash = contentHash(`protocol-refusal-source:${mode}`);
  const artifactBytes = Buffer.from('bounded-protocol-refusal-artifact\n', 'utf8');
  const artifactHash = contentHash(artifactBytes);
  const root = await mkdtemp(path.join(os.tmpdir(), `synthi-cold-refusal-${mode}-`));
  const sourceDir = path.join(root, 'source');
  const releaseDir = path.join(root, 'release');
  const specDir = path.join(root, 'spec');
  const scriptPath = path.join(sourceDir, 'build.sh');
  const specPath = path.join(specDir, 'spec.json');
  const containerName = `synthi-cold-refusal-${mode}-${executionNonce}`;
  let containerId = null;
  try {
    await Promise.all([
      mkdir(sourceDir, { recursive: true }),
      mkdir(releaseDir, { recursive: true }),
      mkdir(specDir, { recursive: true }),
    ]);
    const manifest = {
      schemaVersion: 'synthi.gpu_hmr.cold_build_output_manifest.v1',
      commandSpecHash,
      sourceBindingHash,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      outputs: [{
        path: mode === 'windows-absolute-output-path' ? 'C:/artifact' : 'artifact.bin',
        role: 'generic_build_artifact',
        artifactKind: 'opaque_build_output',
        mediaType: 'application/octet-stream',
        contentHash: artifactHash,
        byteLength: artifactBytes.byteLength,
      }],
    };
    const script = mode === 'command-timeout-pipe'
      ? [
        '#!/bin/sh',
        "trap '' TERM",
        `(trap '' TERM; while :; do printf child-output; sleep 0.01; done) &`,
        'while :; do printf parent-output; sleep 0.01; done',
        '',
      ].join('\n')
      : [
        '#!/bin/sh',
        'set -eu',
        `printf 'bounded-protocol-refusal-artifact\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/artifact.bin'`,
        ...(mode === 'unsafe-output-tree'
          ? [
            `ln -s artifact.bin '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/link.out'`,
            `mkfifo '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/pipe.out'`,
          ]
          : []),
        `cat > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/${COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH}' <<'SYNTHI_MANIFEST'`,
        JSON.stringify(manifest),
        'SYNTHI_MANIFEST',
        '',
      ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    await chmod(scriptPath, 0o755);
    if (mode === 'symlink-working-directory') {
      await requireDocker([
        'run',
        '--rm',
        '--network',
        'none',
        '--read-only',
        '--cap-drop',
        'ALL',
        '--security-opt',
        'no-new-privileges=true',
        '--entrypoint',
        '/bin/ln',
        '--mount',
        `type=bind,source=${sourceDir},target=/source`,
        COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
        '-s',
        '/tmp',
        '/source/escape',
      ]);
    }
    const directArgvMode = mode === 'direct-argv-no-manifest'
      || mode === 'symlink-working-directory';
    const spec = coldBuildLauncherSpec({
      executionNonce,
      commandSpecHash,
      sourceBindingHash,
      command: directArgvMode ? '/usr/local/go/bin/go' : '/bin/sh',
      args: directArgvMode
        ? ['version']
        : [`${COLD_BUILD_LAUNCHER_SOURCE_ROOT}/build.sh`],
      environment: [
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        'TMPDIR=/tmp',
      ],
      workingDirectory: mode === 'symlink-working-directory'
        ? `${COLD_BUILD_LAUNCHER_SOURCE_ROOT}/escape`
        : COLD_BUILD_LAUNCHER_SOURCE_ROOT,
      commandTimeoutMillis: mode === 'command-timeout-pipe' ? 1_000 : 10_000,
      releaseTimeoutMillis: 2_000,
      workspaceByteLimit: 64 * 1024 * 1024,
      workspaceEntryLimit: 4096,
      collectedByteLimit: 4 * 1024 * 1024,
      collectedEntryLimit: 2,
    });
    const specBytes = encodeColdBuildLauncherSpec(spec);
    const specHash = coldBuildLauncherSpecHash(spec);
    await writeFile(specPath, specBytes, { mode: 0o444 });
    await chmod(specPath, 0o444);
    const created = await requireDocker(launcherContainerCreateArgs({
      containerName,
      launcherPath: launcher.executablePath,
      sourceDir,
      releaseDir,
      specPath,
    }));
    containerId = created.stdout.trim();
    const attached = beginAttachedContainer(containerId, {
      executionNonce,
      specHash,
      commandSpecHash,
      sourceBindingHash,
      timeoutMs: 10_000,
    });
    const readyFrame = await attached.ready;
    const ready = readyFrame.receipt;
    const readyHash = readyFrame.receiptHash;
    if ([
      'unsafe-output-tree',
      'symlink-working-directory',
      'direct-argv-no-manifest',
      'command-timeout-pipe',
      'windows-absolute-output-path',
    ].includes(mode)) {
      assert.equal(ready.outputSnapshotAccepted, false);
      assert.equal(ready.protocolAccepted, false);
      assert.ok(ready.blockingGaps.includes('output_snapshot_invalid'));
      if (mode === 'symlink-working-directory') {
        assert.equal(ready.childIdentityAccepted, false);
        assert.ok(ready.blockingGaps.includes('child_identity_unproven'));
      } else {
        assert.equal(ready.childIdentityAccepted, true);
      }
      if (mode === 'direct-argv-no-manifest') {
        assert.equal(ready.childExitCode, 0);
        assert.ok(ready.commandStdout.byteLength > 0);
      }
      if (mode === 'command-timeout-pipe') {
        assert.equal(ready.commandTimedOut, true);
        assert.equal(ready.childExitCode, 124);
        assert.equal(ready.processTree.quiescent, true);
      }
      const result = await attached.completion;
      assert.equal(result.exitCode, 125, `${mode}: ${result.stderr || result.exitCode}`);
      return;
    }
    assert.equal(ready.protocolAccepted, true, JSON.stringify(ready));

    let completion = null;
    let completionHash = null;
    let frame = null;
    if (mode !== 'skipped-collection') {
      const collected = await spawnCaptured(dockerExecutable, [
        'exec',
        '--user',
        '0:0',
        containerId,
        COLD_BUILD_LAUNCHER_CONTAINER_PATH,
        'collect',
        '--spec',
        COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
      ], {
        timeoutMs: 20_000,
        maxStdoutBytes: 8 * 1024 * 1024,
        maxStderrBytes: maxDiagnosticBytes,
      });
      assert.equal(collected.exitCode, 0, collected.stderr.toString('utf8'));
      frame = parseColdBuildCollectorFrame(collected.stdout, {
        maxHeaderBytes: 1024 * 1024,
        maxPayloadBytes: 4 * 1024 * 1024,
        maxEntryCount: 2,
        expectedExecutionNonce: executionNonce,
        expectedSpecHash: specHash,
        expectedReadyReceiptHash: readyHash,
        expectedOutputSnapshotHash: ready.outputSnapshotHash,
      });
      const completionBytes = await pollControl(containerId, 'collector-complete.json');
      const parsedCompletion = parseColdBuildCollectorCompletionReceipt(completionBytes, {
        maxReceiptBytes: maxDiagnosticBytes,
        expectedExecutionNonce: executionNonce,
        expectedSpecHash: specHash,
        expectedReadyReceiptHash: readyHash,
        expectedOutputSnapshotHash: ready.outputSnapshotHash,
        expectedCollectorReceiptHash: frame.receiptHash,
        expectedCollectorFrameHash: frame.frameHash,
        expectedCollectorFrameByteLength: collected.stdout.byteLength,
      });
      completion = parsedCompletion.receipt;
      completionHash = parsedCompletion.receiptHash;
    }

    const release = {
      schemaVersion: 'synthi.gpu_hmr.cold_build_release_receipt.v1',
      executionNonce,
      specHash,
      readyReceiptHash: readyHash,
      outputSnapshotHash: ready.outputSnapshotHash,
      collectorCompletionReceiptHash: completionHash ?? contentHash(randomBytes(32)),
      collectorReceiptHash: frame?.receiptHash ?? contentHash(randomBytes(32)),
      collectorFrameHash: frame?.frameHash ?? contentHash(randomBytes(32)),
      collectorFrameByteLength: completion?.collectorFrameByteLength ?? 128,
      hostReceiptHash: contentHash(randomBytes(32)),
    };
    const releaseBytes = Buffer.from(
      `${stableJson(release)}${mode === 'trailing-release' ? '{}' : ''}`,
      'utf8',
    );
    await writeAtomicHostFile(releaseDir, 'release.json', releaseBytes);

    if (mode === 'trailing-final-ack') {
      const finalBytes = await pollControl(containerId, 'final.json');
      const parsedFinal = parseColdBuildFinalReceipt(finalBytes, {
        maxReceiptBytes: maxDiagnosticBytes,
        expectedExecutionNonce: executionNonce,
        expectedSpecHash: specHash,
        expectedReadyReceiptHash: readyHash,
        expectedReleaseReceiptHash: contentHash(releaseBytes),
        expectedCollectorCompletionReceiptHash: completionHash,
        expectedCollectorReceiptHash: frame.receiptHash,
        expectedCollectorFrameHash: frame.frameHash,
        expectedCollectorFrameByteLength: completion.collectorFrameByteLength,
        expectedHostReceiptHash: release.hostReceiptHash,
        expectedChildExitCode: 0,
      });
      assert.equal(parsedFinal.receipt.protocolAccepted, true);
      const finalAck = {
        schemaVersion: 'synthi.gpu_hmr.cold_build_final_ack.v1',
        executionNonce,
        specHash,
        finalReceiptHash: contentHash(finalBytes),
      };
      await writeAtomicHostFile(
        releaseDir,
        'final-ack.json',
        `${stableJson(finalAck)}{}`,
      );
    }

    const result = await attached.completion;
    assert.equal(result.exitCode, 125, `${mode}: ${result.stderr || result.exitCode}`);
    const inspected = await requireDocker([
      'inspect',
      containerId,
      '--format',
      '{{json .State}}',
    ]);
    const state = JSON.parse(inspected.stdout);
    assert.equal(state.Running, false);
    assert.equal(state.ExitCode, 125);
  } finally {
    await runDocker(['rm', '--force', containerId || containerName], { timeoutMs: 20_000 });
    await rm(root, { recursive: true, force: true });
  }
}

async function runDocker(args, options = {}) {
  return spawnCaptured(dockerExecutable, args, { encoding: 'utf8', ...options });
}

async function requireDocker(args, options = {}) {
  const result = await runDocker(args, options);
  assert.equal(
    result.exitCode,
    0,
    `docker ${args[0]} failed: ${result.error || result.stderr || result.exitCode}`,
  );
  assert.equal(result.signal, null);
  assert.equal(result.timedOut, false);
  assert.equal(result.error, null);
  return result;
}

async function pollControl(containerId, name, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  let lastResult = null;
  while (Date.now() <= deadline) {
    lastResult = await runDocker([
      'exec',
      '--user',
      '0:0',
      containerId,
      COLD_BUILD_LAUNCHER_CONTAINER_PATH,
      'read-control',
      '--spec',
      COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
      '--name',
      name,
    ], { timeoutMs: 5_000 });
    if (lastResult.exitCode === 0 && !lastResult.error && !lastResult.timedOut) {
      return Buffer.from(lastResult.stdout, 'utf8');
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`control receipt ${name} not observed: ${lastResult?.stderr || 'timeout'}`);
}

async function main() {
  await assert.rejects(
    materializeColdBuildLauncher({ dockerExecutable }),
    /target_architecture_required/,
  );
  const builderImageInspection = await requireDocker([
    'image',
    'inspect',
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  ]);
  const builderImageDescriptor = JSON.parse(builderImageInspection.stdout)?.[0];
  assert.equal(builderImageDescriptor?.Os, 'linux');
  assert.ok(['amd64', 'arm64'].includes(builderImageDescriptor?.Architecture));
  const launcher = await materializeColdBuildLauncher({
    dockerExecutable,
    architecture: builderImageDescriptor.Architecture,
  });
  assert.match(launcher.binaryHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(launcher.buildEvidence.accepted, true);
  assert.equal(launcher.buildEvidence.acceptedForGpuHmr, false);
  assert.equal(launcher.buildEvidence.gpuHmrSuccess, false);
  assert.equal(launcher.buildEvidence.canSatisfyRuntimeProof, false);
  assert.equal(launcher.buildEvidence.canSatisfyDispatchProof, false);
  assert.equal(launcher.buildEvidence.operatingSystem, 'linux');
  assert.equal(launcher.buildEvidence.architecture, launcher.architecture);
  assert.ok(['amd64', 'arm64'].includes(launcher.architecture));
  assert.equal(launcher.buildEvidence.staticExecutable, true);
  assert.equal(launcher.buildEvidence.builderCleanupAccepted, true);
  const alternateArchitecture = launcher.architecture === 'amd64' ? 'arm64' : 'amd64';
  const alternateLauncher = await materializeColdBuildLauncher({
    dockerExecutable,
    architecture: alternateArchitecture,
  });
  assert.equal(alternateLauncher.architecture, alternateArchitecture);
  assert.equal(alternateLauncher.buildEvidence.operatingSystem, 'linux');
  assert.equal(alternateLauncher.buildEvidence.staticExecutable, true);
  assert.notEqual(alternateLauncher.binaryHash, launcher.binaryHash);
  const concurrentCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-concurrent-cache-'),
  );
  try {
    const concurrentLaunchers = await Promise.all(
      Array.from({ length: 4 }, () => materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: concurrentCacheRoot,
      })),
    );
    assert.ok(concurrentLaunchers.every((item) => item.binaryHash === launcher.binaryHash));
    assert.equal(
      concurrentLaunchers.filter((item) => item.buildEvidence.buildExecuted).length,
      1,
    );
    assert.ok(concurrentLaunchers.every(
      (item) => item.buildEvidence.builderCleanupAccepted === true,
    ));
  } finally {
    await rm(concurrentCacheRoot, { recursive: true, force: true });
  }
  const staleLockCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-stale-lock-cache-'),
  );
  try {
    const sourceIdentity = await coldBuildLauncherSourceIdentity();
    const staleCacheDirectory = path.join(
      staleLockCacheRoot,
      'cold-build-launcher',
      sourceIdentity.sourceHash.slice('sha256:'.length),
      launcher.architecture,
    );
    await mkdir(staleCacheDirectory, { recursive: true });
    const staleLockPath = path.join(staleCacheDirectory, 'build.lock');
    await writeFile(staleLockPath, stableJson({
      schemaVersion: 'synthi.gpu_hmr.cold_build_launcher_lock.v1',
      ownerToken: 'f'.repeat(32),
      processId: 2_147_483_647,
      hostName: os.hostname(),
      platform: process.platform,
      createdAtMs: Date.now() - 60_000,
    }), { encoding: 'utf8', mode: 0o600 });
    const staleTimestamp = new Date(Date.now() - 60_000);
    await utimes(staleLockPath, staleTimestamp, staleTimestamp);
    const recovered = await materializeColdBuildLauncher({
      dockerExecutable,
      architecture: launcher.architecture,
      cacheRoot: staleLockCacheRoot,
    });
    assert.equal(recovered.buildEvidence.buildExecuted, true);
    assert.equal(recovered.buildEvidence.buildLockAcquired, true);
    assert.equal(recovered.buildEvidence.builderCleanupAccepted, true);
    await assert.rejects(readFile(staleLockPath), /ENOENT/);
  } finally {
    await rm(staleLockCacheRoot, { recursive: true, force: true });
  }
  const leftoverBuilders = await requireDocker([
    'ps',
    '--all',
    '--quiet',
    '--filter',
    `label=${COLD_BUILD_LAUNCHER_BUILDER_LABEL}`,
  ]);
  assert.equal(leftoverBuilders.stdout.trim(), '');

  const version = await requireDocker([
    'run',
    '--rm',
    '--network',
    'none',
    '--read-only',
    '--entrypoint',
    COLD_BUILD_LAUNCHER_CONTAINER_PATH,
    '--mount',
    `type=bind,source=${launcher.executablePath},target=${COLD_BUILD_LAUNCHER_CONTAINER_PATH},readonly`,
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    'version',
  ]);
  const versionReceipt = JSON.parse(version.stdout);
  assert.equal(versionReceipt.schemaVersion, 'synthi.gpu_hmr.cold_build_static_launcher.v1');

  const executionNonce = randomBytes(16).toString('hex');
  const commandSpecHash = contentHash('launcher-self-check-command');
  const sourceBindingHash = contentHash('launcher-self-check-source');
  const artifactBytes = Buffer.from('project-neutral-cold-build-artifact\n', 'utf8');
  const artifactHash = contentHash(artifactBytes);
  const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-cold-launcher-self-check-'));
  const sourceDir = path.join(root, 'source');
  const releaseDir = path.join(root, 'release');
  const specDir = path.join(root, 'spec');
  const scriptPath = path.join(sourceDir, 'build.sh');
  const sourceSentinelPath = path.join(sourceDir, 'source-sentinel.txt');
  const specPath = path.join(specDir, 'spec.json');
  const containerName = `synthi-cold-launcher-self-check-${executionNonce}`;
  let containerId = null;
  let startPromise = null;
  try {
    await Promise.all([
      mkdir(sourceDir, { recursive: true }),
      mkdir(releaseDir, { recursive: true }),
      mkdir(specDir, { recursive: true }),
    ]);
    await writeFile(sourceSentinelPath, 'immutable-source\n', 'utf8');
    const manifest = {
      schemaVersion: 'synthi.gpu_hmr.cold_build_output_manifest.v1',
      commandSpecHash,
      sourceBindingHash,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      outputs: [{
        path: 'artifact.bin',
        role: 'generic_build_artifact',
        artifactKind: 'opaque_build_output',
        mediaType: 'application/octet-stream',
        contentHash: artifactHash,
        byteLength: artifactBytes.byteLength,
      }],
    };
    const script = [
      '#!/bin/sh',
      'set -eu',
      `if printf 'mutated\\n' > '${COLD_BUILD_LAUNCHER_SOURCE_ROOT}/source-sentinel.txt' 2>/dev/null; then exit 91; fi`,
      `printf 'project-neutral-cold-build-artifact\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/artifact.bin'`,
      `cat > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/${COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH}' <<'SYNTHI_MANIFEST'`,
      JSON.stringify(manifest),
      'SYNTHI_MANIFEST',
      `(trap '' HUP TERM; while :; do printf x >> '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/background.tmp'; sleep 0.01; done) &`,
      'exit 0',
      '',
    ].join('\n');
    await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
    await chmod(scriptPath, 0o755);
    const spec = coldBuildLauncherSpec({
      executionNonce,
      commandSpecHash,
      sourceBindingHash,
      command: '/bin/sh',
      args: [`${COLD_BUILD_LAUNCHER_SOURCE_ROOT}/build.sh`],
      environment: [
        'HOME=/tmp/synthi-home',
        'PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
        `SYNTHI_COLD_BUILD_COMMAND_SPEC_HASH=${commandSpecHash}`,
        `SYNTHI_COLD_BUILD_OUTPUT_MANIFEST=${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/${COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH}`,
        `SYNTHI_COLD_BUILD_OUTPUT_ROOT=${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}`,
        `SYNTHI_COLD_BUILD_SOURCE_BINDING_HASH=${sourceBindingHash}`,
        `SYNTHI_COLD_BUILD_SOURCE_ROOT=${COLD_BUILD_LAUNCHER_SOURCE_ROOT}`,
        'TMPDIR=/tmp',
      ],
      workingDirectory: COLD_BUILD_LAUNCHER_SOURCE_ROOT,
      commandTimeoutMillis: 10_000,
      workspaceByteLimit: 64 * 1024 * 1024,
      workspaceEntryLimit: 4096,
      collectedByteLimit: 4 * 1024 * 1024,
      collectedEntryLimit: 2,
    });
    const specBytes = encodeColdBuildLauncherSpec(spec);
    const specHash = coldBuildLauncherSpecHash(spec);
    await writeFile(specPath, specBytes, { mode: 0o444 });
    await chmod(specPath, 0o444);

    const createArgs = launcherContainerCreateArgs({
      containerName,
      launcherPath: launcher.executablePath,
      sourceDir,
      releaseDir,
      specPath,
    });
    const createResult = await requireDocker(createArgs);
    containerId = createResult.stdout.trim();
    assert.match(containerId, /^[a-f0-9]{12,64}$/);

    const attached = beginAttachedContainer(containerId, {
      executionNonce,
      specHash,
      commandSpecHash,
      sourceBindingHash,
    });
    startPromise = attached.completion;
    const readyFrame = await attached.ready;
    const readyBytes = readyFrame.receiptBytes;
    const ready = readyFrame.receipt;
    const readyHash = readyFrame.receiptHash;
    assert.equal(ready.schemaVersion, 'synthi.gpu_hmr.cold_build_ready_receipt.v1');
    assert.equal(ready.executionNonce, executionNonce);
    assert.equal(ready.specHash, specHash);
    assert.equal(ready.commandSpecHash, commandSpecHash);
    assert.equal(ready.sourceBindingHash, sourceBindingHash);
    assert.equal(ready.childIdentityAccepted, true);
    assert.equal(ready.childExitCode, 0);
    assert.equal(ready.commandTimedOut, false);
    assert.equal(ready.processTree.quiescent, true);
    assert.equal(ready.processTree.finalResidualPids.length, 0);
    assert.ok(
      ready.processTree.initialResidualPids.length > 0
      || ready.processTree.termSignalCount > 0
      || ready.processTree.killSignalCount > 0,
      'the detached writer adversary must be observed or terminated',
    );
    assert.equal(ready.outputSnapshotAccepted, true);
    assert.equal(ready.protocolAccepted, true, JSON.stringify(ready));
    assert.deepEqual(ready.blockingGaps, []);
    const controlParserBindings = {
      maxReceiptBytes: maxDiagnosticBytes,
      expectedExecutionNonce: executionNonce,
      expectedSpecHash: specHash,
      expectedCommandSpecHash: commandSpecHash,
      expectedSourceBindingHash: sourceBindingHash,
    };
    assert.throws(
      () => parseColdBuildControlFrame(
        encodeControlReceiptFrame({ ...ready, protocolAccepted: 'true' }),
        controlParserBindings,
      ),
      /receipt_binding_invalid/,
    );
    assert.throws(
      () => parseColdBuildControlFrame(
        encodeControlReceiptFrame({ ...ready, forgedAuthority: true }),
        controlParserBindings,
      ),
      /receipt_binding_invalid/,
    );

    const collectResult = await spawnCaptured(dockerExecutable, [
      'exec',
      '--user',
      '0:0',
      containerId,
      COLD_BUILD_LAUNCHER_CONTAINER_PATH,
      'collect',
      '--spec',
      COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
    ], {
      timeoutMs: 20_000,
      maxStdoutBytes: 8 * 1024 * 1024,
      maxStderrBytes: maxDiagnosticBytes,
    });
    assert.equal(collectResult.exitCode, 0, collectResult.stderr.toString('utf8'));
    assert.equal(collectResult.error, null);
    const frame = parseColdBuildCollectorFrame(collectResult.stdout, {
      maxHeaderBytes: 1024 * 1024,
      maxPayloadBytes: 4 * 1024 * 1024,
      maxEntryCount: 2,
      expectedExecutionNonce: executionNonce,
      expectedSpecHash: specHash,
      expectedReadyReceiptHash: readyHash,
      expectedOutputSnapshotHash: ready.outputSnapshotHash,
    });
    assert.equal(frame.receipt.schemaVersion, 'synthi.gpu_hmr.cold_build_collector_receipt.v1');
    assert.equal(frame.receipt.executionNonce, executionNonce);
    assert.equal(frame.receipt.specHash, specHash);
    assert.equal(frame.receipt.readyReceiptHash, readyHash);
    assert.equal(frame.receipt.outputSnapshotHash, ready.outputSnapshotHash);
    const artifact = frame.payloads.find(({ entry }) => entry.path === 'artifact.bin');
    assert.ok(artifact);
    assert.equal(contentHash(artifact.bytes), artifactHash);
    const corruptedFrame = Buffer.from(collectResult.stdout);
    corruptedFrame[corruptedFrame.length - 1] ^= 0xff;
    assert.throws(
      () => parseColdBuildCollectorFrame(corruptedFrame, {
        maxHeaderBytes: 1024 * 1024,
        maxPayloadBytes: 4 * 1024 * 1024,
        maxEntryCount: 2,
        expectedExecutionNonce: executionNonce,
        expectedSpecHash: specHash,
        expectedReadyReceiptHash: readyHash,
        expectedOutputSnapshotHash: ready.outputSnapshotHash,
      }),
      /payload_hash_mismatch/,
    );
    assert.throws(
      () => parseColdBuildCollectorFrame(collectResult.stdout, {
        maxHeaderBytes: 1024 * 1024,
        maxPayloadBytes: 4 * 1024 * 1024,
        maxEntryCount: 2,
        expectedExecutionNonce: '0'.repeat(32),
        expectedSpecHash: specHash,
        expectedReadyReceiptHash: readyHash,
        expectedOutputSnapshotHash: ready.outputSnapshotHash,
      }),
      /receipt_shape_invalid/,
    );
    assert.throws(
      () => parseColdBuildCollectorFrame(
        Buffer.concat([collectResult.stdout, Buffer.from([0])]),
        {
          maxHeaderBytes: 1024 * 1024,
          maxPayloadBytes: 4 * 1024 * 1024,
          maxEntryCount: 2,
          expectedExecutionNonce: executionNonce,
          expectedSpecHash: specHash,
          expectedReadyReceiptHash: readyHash,
          expectedOutputSnapshotHash: ready.outputSnapshotHash,
        },
      ),
      /payload_length_invalid/,
    );
    const parserBindings = {
      maxHeaderBytes: 1024 * 1024,
      maxPayloadBytes: 4 * 1024 * 1024,
      maxEntryCount: 2,
      expectedExecutionNonce: executionNonce,
      expectedSpecHash: specHash,
      expectedReadyReceiptHash: readyHash,
      expectedOutputSnapshotHash: ready.outputSnapshotHash,
    };
    assert.throws(
      () => parseColdBuildCollectorFrame(
        rewriteCollectorHeader(collectResult.stdout, (receipt) => {
          receipt.schemaVersion = 'forged.schema';
        }),
        parserBindings,
      ),
      /receipt_shape_invalid/,
    );
    assert.throws(
      () => parseColdBuildCollectorFrame(
        rewriteCollectorHeader(collectResult.stdout, (receipt) => {
          receipt.entries[0].path = '../escape';
        }),
        parserBindings,
      ),
      /entry_invalid/,
    );
    assert.throws(
      () => parseColdBuildCollectorFrame(
        rewriteCollectorHeader(collectResult.stdout, (receipt) => {
          receipt.entries[0].byteLength = String(receipt.entries[0].byteLength);
        }),
        parserBindings,
      ),
      /entry_invalid/,
    );
    assert.throws(
      () => parseColdBuildCollectorFrame(
        rewriteCollectorHeader(collectResult.stdout, (receipt) => {
          receipt.entries[1].path = receipt.entries[0].path;
        }),
        parserBindings,
      ),
      /entry_invalid/,
    );

    const completionBytes = await pollControl(containerId, 'collector-complete.json');
    const parsedCompletion = parseColdBuildCollectorCompletionReceipt(completionBytes, {
      maxReceiptBytes: maxDiagnosticBytes,
      expectedExecutionNonce: executionNonce,
      expectedSpecHash: specHash,
      expectedReadyReceiptHash: readyHash,
      expectedOutputSnapshotHash: ready.outputSnapshotHash,
      expectedCollectorReceiptHash: frame.receiptHash,
      expectedCollectorFrameHash: frame.frameHash,
      expectedCollectorFrameByteLength: collectResult.stdout.byteLength,
    });
    const completion = parsedCompletion.receipt;
    const completionHash = parsedCompletion.receiptHash;
    assert.equal(completion.schemaVersion, COLD_BUILD_COLLECTOR_COMPLETION_SCHEMA);
    assert.equal(completion.executionNonce, executionNonce);
    assert.equal(completion.specHash, specHash);
    assert.equal(completion.readyReceiptHash, readyHash);
    assert.equal(completion.outputSnapshotHash, ready.outputSnapshotHash);
    assert.equal(completion.collectorReceiptHash, frame.receiptHash);
    assert.equal(completion.collectorFrameHash, frame.frameHash);
    assert.equal(completion.collectorFrameByteLength, collectResult.stdout.byteLength);

    const hostReceipt = {
      executionNonce,
      specHash,
      readyReceiptHash: readyHash,
      outputSnapshotHash: ready.outputSnapshotHash,
      collectorCompletionReceiptHash: completionHash,
      collectorReceiptHash: frame.receiptHash,
      collectorFrameHash: frame.frameHash,
      collectorFrameByteLength: collectResult.stdout.byteLength,
    };
    const hostReceiptHash = contentHash(stableJson(hostReceipt));
    const release = {
      schemaVersion: 'synthi.gpu_hmr.cold_build_release_receipt.v1',
      executionNonce,
      specHash,
      readyReceiptHash: readyHash,
      outputSnapshotHash: ready.outputSnapshotHash,
      collectorCompletionReceiptHash: completionHash,
      collectorReceiptHash: frame.receiptHash,
      collectorFrameHash: frame.frameHash,
      collectorFrameByteLength: collectResult.stdout.byteLength,
      hostReceiptHash,
    };
    const releaseBytes = Buffer.from(stableJson(release), 'utf8');
    await writeAtomicHostFile(
      releaseDir,
      'release.json',
      releaseBytes,
    );
    const finalBytes = await pollControl(containerId, 'final.json');
    const finalParserBindings = {
      maxReceiptBytes: maxDiagnosticBytes,
      expectedExecutionNonce: executionNonce,
      expectedSpecHash: specHash,
      expectedReadyReceiptHash: readyHash,
      expectedReleaseReceiptHash: contentHash(releaseBytes),
      expectedCollectorCompletionReceiptHash: completionHash,
      expectedCollectorReceiptHash: frame.receiptHash,
      expectedCollectorFrameHash: frame.frameHash,
      expectedCollectorFrameByteLength: collectResult.stdout.byteLength,
      expectedHostReceiptHash: hostReceiptHash,
      expectedChildExitCode: 0,
    };
    const parsedFinal = parseColdBuildFinalReceipt(finalBytes, finalParserBindings);
    const finalReceipt = parsedFinal.receipt;
    assert.throws(
      () => parseColdBuildFinalReceipt(
        Buffer.from(stableJson({ ...finalReceipt, protocolAccepted: 'true' }), 'utf8'),
        finalParserBindings,
      ),
      /receipt_binding_invalid/,
    );
    assert.equal(finalReceipt.schemaVersion, 'synthi.gpu_hmr.cold_build_final_receipt.v1');
    assert.equal(finalReceipt.executionNonce, executionNonce);
    assert.equal(finalReceipt.specHash, specHash);
    assert.equal(finalReceipt.readyReceiptHash, readyHash);
    assert.equal(finalReceipt.collectorCompletionReceiptHash, completionHash);
    assert.equal(finalReceipt.collectorReceiptHash, frame.receiptHash);
    assert.equal(finalReceipt.collectorFrameHash, frame.frameHash);
    assert.equal(finalReceipt.collectorFrameByteLength, collectResult.stdout.byteLength);
    assert.equal(finalReceipt.hostReceiptHash, hostReceiptHash);
    assert.equal(finalReceipt.childExitCode, 0);
    assert.equal(finalReceipt.protocolAccepted, true);
    const finalAck = {
      schemaVersion: 'synthi.gpu_hmr.cold_build_final_ack.v1',
      executionNonce,
      specHash,
      finalReceiptHash: parsedFinal.receiptHash,
    };
    await writeAtomicHostFile(
      releaseDir,
      'final-ack.json',
      stableJson(finalAck),
    );
    const startResult = await startPromise;
    assert.equal(startResult.exitCode, 0, startResult.stderr);
    assert.equal(startResult.signal, null);
    assert.equal(startResult.timedOut, false);
    assert.equal(startResult.error, null);
    const inspect = await requireDocker([
      'inspect',
      containerId,
      '--format',
      '{{json .State}}',
    ]);
    const state = JSON.parse(inspect.stdout);
    assert.equal(state.Status, 'exited');
    assert.equal(state.Running, false);
    assert.equal(state.OOMKilled, false);
    assert.equal(state.ExitCode, 0);
    assert.equal(await readFile(sourceSentinelPath, 'utf8'), 'immutable-source\n');
  } finally {
    if (containerId) {
      await runDocker(['rm', '--force', containerId], { timeoutMs: 20_000 });
    } else {
      await runDocker(['rm', '--force', containerName], { timeoutMs: 20_000 });
    }
    await rm(root, { recursive: true, force: true });
  }
  for (const mode of [
    'skipped-collection',
    'trailing-release',
    'trailing-final-ack',
    'unsafe-output-tree',
    'symlink-working-directory',
    'direct-argv-no-manifest',
    'command-timeout-pipe',
    'windows-absolute-output-path',
  ]) {
    await runProtocolRefusalScenario({ launcher, mode });
  }
  process.stdout.write('gpu-hmr cold-build static launcher self-check passed\n');
}

await main();
