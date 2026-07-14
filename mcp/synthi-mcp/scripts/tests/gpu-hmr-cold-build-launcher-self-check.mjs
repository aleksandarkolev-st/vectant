import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  access,
  chown,
  chmod,
  lstat,
  lutimes,
  mkdtemp,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  COLD_BUILD_CONTAINER_CAPABILITIES,
  COLD_BUILD_HOST_PROCESS_KILL_CONFIRMATION_MS,
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_BUILDER_LABEL,
  COLD_BUILD_LAUNCHER_CONTAINER_PATH,
  COLD_BUILD_LAUNCHER_CONTROL_ROOT,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
  COLD_BUILD_LAUNCHER_RELEASE_ROOT,
  COLD_BUILD_LAUNCHER_SOURCE_ROOT,
  COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
  COLD_BUILD_LAUNCHER_CLEANUP_MAX_MATCHED_ENTRIES,
  COLD_BUILD_LAUNCHER_STALE_STATE_MS,
  COLD_BUILD_OUTPUT_MANIFEST_CONTAINER_PATH,
  COLD_BUILD_COLLECTOR_COMPLETION_SCHEMA,
  COLD_BUILD_COLLECTOR_FRAME_MAGIC,
  COLD_BUILD_CONTROL_FRAME_MAGIC,
  coldBuildControlTmpfsOptions,
  coldBuildLauncherCommand,
  coldBuildLauncherEntrypoint,
  coldBuildLauncherPublicationDescriptor,
  coldBuildLauncherSpec,
  coldBuildLauncherSpecHash,
  coldBuildOutputTmpfsOptions,
  coldBuildTmpfsOptions,
  encodeColdBuildLauncherSpec,
  materializeColdBuildLauncher,
  parseColdBuildCollectorCompletionReceipt,
  parseColdBuildCollectorFrame,
  parseColdBuildControlFrame,
  parseColdBuildFinalReceipt,
  runColdBuildHostProcess,
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

async function waitForPaths(paths, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    const observations = await Promise.all(paths.map(async (filePath) => {
      try {
        await access(filePath);
        return true;
      } catch {
        return false;
      }
    }));
    if (observations.every(Boolean)) return;
    await sleep(25);
  }
  throw new Error(`paths_not_observed:${paths.join(',')}`);
}

async function createPrivateDirectoryChain(root, segments) {
  let current = root;
  await mkdir(current, { recursive: true, mode: 0o700 });
  await chmod(current, 0o700);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
    }
    await chmod(current, 0o700);
  }
  return current;
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
  return runColdBuildHostProcess(executable, args, {
    timeoutMs,
    maxStdoutBytes,
    maxStderrBytes,
    encoding,
    onStdoutChunk,
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

function processIdentityAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== 'ESRCH';
  }
}

async function killAndProveProcessAbsent(processId) {
  let killError = null;
  try {
    process.kill(processId, 'SIGKILL');
  } catch (error) {
    if (error?.code !== 'ESRCH') killError = error;
  }
  const deadline = Date.now() + 2_000;
  while (Date.now() <= deadline) {
    if (!processIdentityAlive(processId)) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  if (killError) throw killError;
  assert.fail(`process ${processId} survived explicit test cleanup`);
}

function escapedDescriptorHolderProgram({ outputBytes = 0, parentStaysAlive = false } = {}) {
  const descendantProgram = 'setInterval(() => {}, 1000);';
  return [
    "const { spawn } = require('node:child_process');",
    `const child = spawn(process.execPath, ['-e', ${JSON.stringify(descendantProgram)}], {`,
    "  detached: true, windowsHide: true, stdio: ['ignore', 'inherit', 'inherit'],",
    '});',
    "process.stdout.write(String(child.pid) + '\\n');",
    outputBytes > 0 ? `process.stdout.write('x'.repeat(${outputBytes}));` : '',
    'child.unref();',
    parentStaysAlive ? 'setInterval(() => {}, 1000);' : '',
  ].filter(Boolean).join('\n');
}

async function assertCapturedTimeoutIsBounded() {
  const parentProgram = escapedDescriptorHolderProgram();
  const timeoutMs = 750;
  const startedAt = Date.now();
  const result = await spawnCaptured(process.execPath, ['-e', parentProgram], {
    timeoutMs,
    maxStdoutBytes: 1024,
    maxStderrBytes: 1024,
    encoding: 'utf8',
  });
  const elapsedMs = Date.now() - startedAt;
  const descendantProcessId = Number(String(result.stdout).trim().split(/\s+/)[0]);
  assert.ok(Number.isSafeInteger(descendantProcessId) && descendantProcessId > 0);
  assert.equal(processIdentityAlive(descendantProcessId), true);
  await killAndProveProcessAbsent(descendantProcessId);
  assert.equal(result.timedOut, true);
  assert.equal(result.error, 'process_timeout');
  assert.equal(result.directProcessTermination?.attempted, false);
  assert.equal(result.directProcessTermination?.alreadyExited, true);
  assert.equal(result.directProcessTermination?.confirmedExited, true);
  assert.ok(
    elapsedMs <= timeoutMs + COLD_BUILD_HOST_PROCESS_KILL_CONFIRMATION_MS + 2_000,
    `captured process exceeded bounded termination window: ${elapsedMs}ms`,
  );

  const outputLimited = await spawnCaptured(
    process.execPath,
    ['-e', escapedDescriptorHolderProgram({ outputBytes: 65_536, parentStaysAlive: true })],
    {
      timeoutMs: 10_000,
      maxStdoutBytes: 32,
      maxStderrBytes: 32,
      encoding: 'utf8',
    },
  );
  const outputLimitDescendantProcessId = Number(
    String(outputLimited.stdout).trim().split(/\s+/)[0],
  );
  assert.ok(
    Number.isSafeInteger(outputLimitDescendantProcessId)
      && outputLimitDescendantProcessId > 0,
  );
  assert.equal(processIdentityAlive(outputLimitDescendantProcessId), true);
  await killAndProveProcessAbsent(outputLimitDescendantProcessId);
  assert.equal(outputLimited.timedOut, false);
  assert.equal(outputLimited.error, 'process_output_limit_exceeded');
  assert.equal(outputLimited.stdout.length, 32);
  assert.equal(outputLimited.directProcessTermination?.attempted, true);
  assert.equal(outputLimited.directProcessTermination?.killRequestAccepted, true);
  assert.equal(outputLimited.directProcessTermination?.confirmedExited, true);
}

function launcherContainerCreateArgs({
  containerName,
  launcherPath,
  sourceDir,
  releaseDir,
  specPath,
  launcherCommand = coldBuildLauncherCommand(),
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
    ...launcherCommand,
  ];
}

async function assertLauncherExecutableHashMismatch({
  containerName,
  launcherPath,
  sourceDir,
  releaseDir,
  specPath,
}) {
  const modeCommands = [
    ['run', ['run', '--spec', COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH]],
    ['child', ['child', '--spec', COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH]],
    ['collect', ['collect', '--spec', COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH]],
    [
      'read-control',
      [
        'read-control',
        '--spec',
        COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
        '--name',
        'ready.json',
      ],
    ],
  ];
  for (const [mode, launcherCommand] of modeCommands) {
    const modeContainerName = `${containerName}-${mode}`;
    let modeContainerId = null;
    try {
      const created = await requireDocker(launcherContainerCreateArgs({
        containerName: modeContainerName,
        launcherPath,
        sourceDir,
        releaseDir,
        specPath,
        launcherCommand,
      }));
      modeContainerId = created.stdout.trim();
      const result = await spawnCaptured(
        dockerExecutable,
        ['start', '--attach', modeContainerId],
        { timeoutMs: 20_000, encoding: 'utf8' },
      );
      assert.equal(result.exitCode, 125, `${mode}: ${result.stderr}`);
      assert.match(result.stderr, /launcher executable hash mismatch/, mode);
    } finally {
      await runDocker(
        ['rm', '--force', modeContainerId || modeContainerName],
        { timeoutMs: 20_000 },
      );
    }
  }
}

function beginAttachedContainer(containerId, {
  executionNonce,
  launcherIdentity,
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
          expectedLauncherIdentity: launcherIdentity,
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
      launcherIdentity: launcher,
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
    if (mode === 'launcher-executable-hash-mismatch') {
      const mountedLauncherPath = path.join(root, 'replaced-cold-build-launcher');
      await writeFile(mountedLauncherPath, Buffer.concat([
        await readFile(launcher.executablePath),
        Buffer.from('post-verification-replacement', 'utf8'),
      ]), { mode: 0o700 });
      await chmod(mountedLauncherPath, 0o755);
      await assertLauncherExecutableHashMismatch({
        containerName,
        launcherPath: mountedLauncherPath,
        sourceDir,
        releaseDir,
        specPath,
      });
      return;
    }
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
      launcherIdentity: launcher,
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
        assert.equal(ready.childIdentityAccepted, true, `${mode}: ${JSON.stringify(ready)}`);
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

async function assertLinuxCacheRootTrustRefusals() {
  assert.notEqual(process.platform, 'win32');
  const worldWritableRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-launcher-linux-world-writable-'),
  );
  try {
    await chmod(worldWritableRoot, 0o777);
    await assert.rejects(
      materializeColdBuildLauncher({
        architecture: 'amd64',
        cacheRoot: worldWritableRoot,
        dockerExecutable: 'must-not-run',
      }),
      /cold_build_launcher_cache_root_untrusted/,
    );
  } finally {
    await chmod(worldWritableRoot, 0o700).catch(() => {});
    await rm(worldWritableRoot, { recursive: true, force: true });
  }

  const writableAncestorRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-launcher-linux-writable-ancestor-'),
  );
  try {
    const unsafeParent = path.join(writableAncestorRoot, 'unsafe-parent');
    const privateChild = path.join(unsafeParent, 'private-child');
    await mkdir(unsafeParent, { mode: 0o700 });
    await chmod(unsafeParent, 0o777);
    await mkdir(privateChild, { mode: 0o700 });
    await assert.rejects(
      materializeColdBuildLauncher({
        architecture: 'amd64',
        cacheRoot: privateChild,
        dockerExecutable: 'must-not-run',
      }),
      /ancestor_write_isolation_failed/,
    );
  } finally {
    await chmod(path.join(writableAncestorRoot, 'unsafe-parent'), 0o700).catch(() => {});
    await rm(writableAncestorRoot, { recursive: true, force: true });
  }

  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    const foreignAncestorRoot = await mkdtemp(
      path.join(os.tmpdir(), 'synthi-launcher-linux-foreign-ancestor-'),
    );
    const foreignParent = path.join(foreignAncestorRoot, 'foreign-parent');
    const privateChild = path.join(foreignParent, 'private-child');
    try {
      await mkdir(foreignParent, { mode: 0o700 });
      await mkdir(privateChild, { mode: 0o700 });
      await chown(foreignParent, 12345, 12345);
      await assert.rejects(
        materializeColdBuildLauncher({
          architecture: 'amd64',
          cacheRoot: privateChild,
          dockerExecutable: 'must-not-run',
        }),
        /ancestor_write_isolation_failed/,
      );
    } finally {
      await chown(foreignParent, 0, 0).catch(() => {});
      await rm(foreignAncestorRoot, { recursive: true, force: true });
    }
  }
}

async function main() {
  await assertCapturedTimeoutIsBounded();
  if (process.argv.includes('--linux-cache-root-only')) {
    await assertLinuxCacheRootTrustRefusals();
    process.stdout.write('gpu-hmr Linux cache-root trust self-check passed\n');
    return;
  }
  if (process.argv.includes('--host-process-only')) {
    process.stdout.write('gpu-hmr cold-build host process self-check passed\n');
    return;
  }
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
  assert.match(launcher.buildEvidence.sourceManifestHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(launcher.buildEvidence.builderRecipeHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(launcher.buildEvidence.publicationKeyHash, /^sha256:[a-f0-9]{64}$/);
  assert.match(launcher.buildEvidence.publicationManifestHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(launcher.buildEvidence.sourceManifestRevalidated, true);
  assert.equal(launcher.buildEvidence.publicationPrimitive, 'hard_link_no_replace');
  assert.equal(launcher.buildEvidence.publicationSameDevice, true);
  assert.equal(launcher.buildEvidence.publicationIntegrityAccepted, true);
  assert.equal(launcher.buildEvidence.executionTimePathBindingRequired, true);
  assert.equal(launcher.buildEvidence.canAuthorizeLauncherExecution, false);
  assert.equal(launcher.buildEvidence.directoryLeaseStatBindingAccepted, true);
  assert.ok([
    'durable',
    'directory_sync_unsupported',
    'cache_verified_durability_not_reproven',
  ].includes(launcher.buildEvidence.publicationDurabilityStatus));
  assert.equal(launcher.buildEvidence.publicationDirectoryHierarchySyncAttempted, true);
  assert.equal(launcher.buildEvidence.publicationFileSyncIdentityVerified, true);
  assert.ok(launcher.buildEvidence.publicationDirectoryHierarchySyncCount >= 1);
  assert.match(
    launcher.buildEvidence.publicationDirectoryHierarchySyncEvidenceHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  if (launcher.buildEvidence.publicationDurabilityStatus === 'durable') {
    assert.equal(launcher.buildEvidence.publicationDurabilityProven, true);
    assert.equal(launcher.buildEvidence.publicationFileSyncStatus, 'synced');
    assert.equal(
      launcher.buildEvidence.publicationDirectoryHierarchySyncAccepted,
      true,
    );
  } else {
    assert.equal(launcher.buildEvidence.publicationDurabilityProven, false);
  }
  assert.equal(launcher.buildEvidence.finalBinaryVerified, true);
  assert.equal(
    launcher.buildEvidence.finalBinaryVerifiedAfterDirectoryRevalidation,
    true,
  );
  assert.equal(launcher.buildEvidence.finalBinaryRegularFile, true);
  assert.equal(launcher.buildEvidence.finalBinarySymbolicLink, false);
  assert.equal(launcher.buildEvidence.finalBinaryStableIdentity, true);
  assert.equal(launcher.buildEvidence.finalBinaryStableMetadata, true);
  assert.equal(launcher.buildEvidence.finalBinarySecondHandleIdentityVerified, true);
  assert.equal(launcher.buildEvidence.finalBinaryCanonicalPathStable, true);
  assert.equal(launcher.buildEvidence.finalBinaryImmutableMode, true);
  assert.equal(launcher.buildEvidence.finalBinaryExecutableModeAccepted, true);
  assert.equal(
    launcher.buildEvidence.trustedCacheRootPermissionOwnershipRecomputed,
    process.platform !== 'win32',
  );
  assert.ok(['publication_created', 'verified_existing_after_race', 'cache_hit'].includes(
    launcher.buildEvidence.publicationOutcome,
  ));
  assert.ok([
    'synced',
    'unsupported',
    'not_required_cache_hit',
  ].includes(launcher.buildEvidence.publicationDirectorySyncAfterCleanupStatus));
  assert.equal(
    launcher.buildEvidence.finalBinaryExecutableModeApplicable,
    process.platform !== 'win32',
  );
  const forgedLauncherIdentity = JSON.parse(JSON.stringify(launcher));
  assert.throws(
    () => coldBuildLauncherSpec({ launcherIdentity: forgedLauncherIdentity }),
    /cold_build_launcher_pinned_identity_invalid/,
  );
  assert.throws(
    () => parseColdBuildControlFrame(Buffer.alloc(0), {
      expectedLauncherIdentity: forgedLauncherIdentity,
    }),
    /cold_build_launcher_pinned_identity_invalid/,
  );
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
    assert.equal(
      concurrentLaunchers.filter(
        (item) => item.buildEvidence.publicationOutcome === 'publication_created',
      ).length,
      1,
    );
    assert.equal(
      concurrentLaunchers.filter(
        (item) => item.buildEvidence.coalescedPublicationWait,
      ).length,
      3,
    );
    assert.ok(concurrentLaunchers.every(
      (item) => item.buildEvidence.builderCleanupAccepted === true
        && item.buildEvidence.immutableContentAddressedPublication === true
        && item.buildEvidence.mutableBuildLockUsed === false,
    ));
    assert.ok(concurrentLaunchers.every(
      (item) => item.buildEvidence.publicationPrimitive === 'hard_link_no_replace'
        && item.buildEvidence.publicationSameDevice === true
        && item.buildEvidence.publicationIntegrityAccepted === true
        && item.buildEvidence.finalBinaryVerified === true
        && item.buildEvidence.finalBinaryImmutableMode === true
        && item.buildEvidence.finalBinaryExecutableModeAccepted === true
        && item.buildEvidence.finalBinarySymbolicLink === false
        && item.buildEvidence.trustedCacheRootAccepted === true
        && item.buildEvidence.trustedCacheRootRevalidated === true,
    ));
  } finally {
    await rm(concurrentCacheRoot, { recursive: true, force: true });
  }

  const crossProcessCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-cross-process-cache-'),
  );
  try {
    const barrierPath = path.join(crossProcessCacheRoot, 'start-barrier');
    const linkBarrierPath = path.join(crossProcessCacheRoot, 'link-barrier');
    const readyPaths = [0, 1].map(
      (index) => path.join(crossProcessCacheRoot, `child-${index}.ready`),
    );
    const linkReadyPaths = [0, 1].map(
      (index) => path.join(crossProcessCacheRoot, `child-${index}.link-ready`),
    );
    const contractModuleUrl = new URL(
      '../lib/gpu-hmr-cold-build-container-contract.mjs',
      import.meta.url,
    ).href;
    const childPromises = readyPaths.map((readyPath, index) => {
      const childProgram = [
        "import { access, writeFile } from 'node:fs/promises';",
        "import { setTimeout as sleep } from 'node:timers/promises';",
        `import { materializeColdBuildLauncher } from ${JSON.stringify(contractModuleUrl)};`,
        `await writeFile(${JSON.stringify(readyPath)}, 'ready', { flag: 'wx' });`,
        'for (;;) {',
        `  try { await access(${JSON.stringify(barrierPath)}); break; } catch { await sleep(10); }`,
        '}',
        'const result = await materializeColdBuildLauncher({',
        `  dockerExecutable: ${JSON.stringify(dockerExecutable)},`,
        `  architecture: ${JSON.stringify(launcher.architecture)},`,
        `  cacheRoot: ${JSON.stringify(crossProcessCacheRoot)},`,
        '  beforePublicationLink: async () => {',
        `    await writeFile(${JSON.stringify(linkReadyPaths[index])}, 'ready', { flag: 'wx' });`,
        '    for (;;) {',
        `      try { await access(${JSON.stringify(linkBarrierPath)}); break; } catch { await sleep(10); }`,
        '    }',
        '  },',
        '});',
        'process.stdout.write(JSON.stringify({',
        '  binaryHash: result.binaryHash,',
        '  executablePath: result.executablePath,',
        '  buildEvidence: result.buildEvidence,',
        '}));',
      ].join('\n');
      return spawnCaptured(
        process.execPath,
        ['--input-type=module', '-e', childProgram],
        {
          timeoutMs: 240_000,
          maxStdoutBytes: 1024 * 1024,
          maxStderrBytes: 1024 * 1024,
          encoding: 'utf8',
        },
      );
    });
    await waitForPaths(readyPaths);
    await writeFile(barrierPath, 'start', { flag: 'wx' });
    await waitForPaths(linkReadyPaths, 240_000);
    await writeFile(linkBarrierPath, 'link', { flag: 'wx' });
    const childResults = await Promise.all(childPromises);
    assert.ok(childResults.every(
      (result) => result.exitCode === 0
        && result.signal === null
        && result.timedOut === false
        && result.error === null,
    ), stableJson(childResults));
    const childLaunchers = childResults.map((result) => JSON.parse(result.stdout));
    assert.ok(childLaunchers.every(
      (item) => item.binaryHash === launcher.binaryHash
        && item.executablePath === childLaunchers[0].executablePath
        && item.buildEvidence.immutableContentAddressedPublication === true
        && item.buildEvidence.mutableBuildLockUsed === false
        && item.buildEvidence.publicationPrimitive === 'hard_link_no_replace'
        && item.buildEvidence.publicationSameDevice === true
        && item.buildEvidence.publicationFileSyncIdentityVerified === true
        && ['synced', 'unsupported'].includes(
          item.buildEvidence.publicationFileSyncStatus,
        )
        && item.buildEvidence.finalBinaryVerified === true,
    ));
    assert.equal(
      childLaunchers.filter(
        (item) => item.buildEvidence.publicationOutcome === 'publication_created',
      ).length,
      1,
    );
    assert.equal(
      childLaunchers.filter(
        (item) => item.buildEvidence.publicationOutcome
          === 'verified_existing_after_race',
      ).length,
      1,
    );
    assert.equal(
      childLaunchers.filter(
        (item) => item.buildEvidence.publicationRaceObserved === true,
      ).length,
      1,
    );
    assert.ok(childLaunchers.every(
      (item) => item.buildEvidence.publicationPreLinkCoordinationUsed === true,
    ));
  } finally {
    await rm(crossProcessCacheRoot, { recursive: true, force: true });
  }

  const sameInodeMutationCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-same-inode-mutation-'),
  );
  try {
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: sameInodeMutationCacheRoot,
        beforePublicationLink: async ({ candidateBinaryPath }) => {
          const bytes = await readFile(candidateBinaryPath);
          bytes[0] ^= 0xff;
          await chmod(candidateBinaryPath, 0o700);
          const handle = await open(candidateBinaryPath, 'r+');
          try {
            await handle.writeFile(bytes);
            await handle.sync();
          } finally {
            await handle.close();
          }
          await chmod(candidateBinaryPath, 0o555);
        },
      }),
      /cold_build_launcher_publication_candidate_changed_during_coordination/,
    );
  } finally {
    await rm(sameInodeMutationCacheRoot, { recursive: true, force: true });
  }

  const abandonedStateCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-abandoned-state-cache-'),
  );
  try {
    const descriptor = await coldBuildLauncherPublicationDescriptor({
      architecture: launcher.architecture,
      cacheRoot: abandonedStateCacheRoot,
    });
    await createPrivateDirectoryChain(
      abandonedStateCacheRoot,
      descriptor.relativeDirectorySegments,
    );
    const abandonedLockPath = path.join(
      abandonedStateCacheRoot,
      'cold-build-launcher',
      'build.lock',
    );
    const abandonedCandidatePath = path.join(
      descriptor.publicationDirectory,
      '.candidate-abandoned',
    );
    const futureCandidatePath = path.join(
      descriptor.publicationDirectory,
      '.candidate-future',
    );
    const abandonedBuildDirectory = await createPrivateDirectoryChain(
      abandonedStateCacheRoot,
      ['cold-build-launcher', 'builds', 'build-abandoned'],
    );
    const emptyAbandonedBuildDirectory = await createPrivateDirectoryChain(
      abandonedStateCacheRoot,
      ['cold-build-launcher', 'builds', 'build-empty-abandoned'],
    );
    const outsideCleanupTarget = path.join(
      abandonedStateCacheRoot,
      'outside-cleanup-target',
    );
    await mkdir(outsideCleanupTarget, { mode: 0o700 });
    const outsideCleanupSentinel = path.join(outsideCleanupTarget, 'sentinel.txt');
    await writeFile(outsideCleanupSentinel, 'must survive stale cleanup', { mode: 0o600 });
    const abandonedBuildSymlink = path.join(
      abandonedStateCacheRoot,
      'cold-build-launcher',
      'builds',
      'build-symlink-abandoned',
    );
    await symlink(
      outsideCleanupTarget,
      abandonedBuildSymlink,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(abandonedLockPath, 'untrusted legacy lock bytes', { mode: 0o600 });
    await writeFile(
      abandonedCandidatePath,
      'partial publication bytes',
      { mode: 0o500 },
    );
    await writeFile(futureCandidatePath, 'future candidate bytes', { mode: 0o500 });
    await writeFile(
      path.join(abandonedBuildDirectory, 'partial-output'),
      'partial build bytes',
      { mode: 0o600 },
    );
    const staleTimestamp = new Date(
      Date.now() - COLD_BUILD_LAUNCHER_STALE_STATE_MS - 60_000,
    );
    await utimes(abandonedCandidatePath, staleTimestamp, staleTimestamp);
    const futureTimestamp = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await utimes(futureCandidatePath, futureTimestamp, futureTimestamp);
    await utimes(abandonedBuildDirectory, staleTimestamp, staleTimestamp);
    await utimes(emptyAbandonedBuildDirectory, staleTimestamp, staleTimestamp);
    await lutimes(abandonedBuildSymlink, staleTimestamp, staleTimestamp);
    const recovered = await materializeColdBuildLauncher({
      dockerExecutable,
      architecture: launcher.architecture,
      cacheRoot: abandonedStateCacheRoot,
    });
    assert.equal(recovered.buildEvidence.buildExecuted, true);
    assert.equal(recovered.buildEvidence.publicationOutcome, 'publication_created');
    assert.equal(recovered.buildEvidence.mutableBuildLockUsed, false);
    assert.equal(recovered.buildEvidence.builderCleanupAccepted, true);
    assert.ok(recovered.buildEvidence.staleCandidateCleanupRemovedCount >= 1);
    assert.ok(recovered.buildEvidence.staleCandidateCleanupFutureTimestampCount >= 1);
    assert.ok(recovered.buildEvidence.staleBuildCleanupRemovedCount >= 1);
    assert.ok(recovered.buildEvidence.staleBuildCleanupNonEmptyRetainedCount >= 1);
    assert.equal(recovered.buildEvidence.staleCandidateCleanupRecursiveTraversalUsed, false);
    assert.equal(recovered.buildEvidence.staleBuildCleanupRecursiveTraversalUsed, false);
    assert.equal(await readFile(abandonedLockPath, 'utf8'), 'untrusted legacy lock bytes');
    await assert.rejects(access(abandonedCandidatePath), { code: 'ENOENT' });
    await assert.rejects(access(futureCandidatePath), { code: 'ENOENT' });
    assert.equal(
      await readFile(path.join(abandonedBuildDirectory, 'partial-output'), 'utf8'),
      'partial build bytes',
    );
    await assert.rejects(access(emptyAbandonedBuildDirectory), { code: 'ENOENT' });
    await assert.rejects(access(abandonedBuildSymlink), { code: 'ENOENT' });
    assert.equal(await readFile(outsideCleanupSentinel, 'utf8'), 'must survive stale cleanup');
  } finally {
    await rm(abandonedStateCacheRoot, { recursive: true, force: true });
  }

  const boundedCleanupCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-bounded-cleanup-'),
  );
  try {
    const descriptor = await coldBuildLauncherPublicationDescriptor({
      architecture: launcher.architecture,
      cacheRoot: boundedCleanupCacheRoot,
    });
    await createPrivateDirectoryChain(
      boundedCleanupCacheRoot,
      descriptor.relativeDirectorySegments,
    );
    await Promise.all(Array.from(
      { length: COLD_BUILD_LAUNCHER_CLEANUP_MAX_MATCHED_ENTRIES + 1 },
      (_, index) => writeFile(
        path.join(descriptor.publicationDirectory, `.candidate-bounded-${index}`),
        'recent candidate',
        { mode: 0o500 },
      ),
    ));
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: boundedCleanupCacheRoot,
      }),
      /cold_build_launcher_stale_state_cleanup_failed/,
    );
  } finally {
    await rm(boundedCleanupCacheRoot, { recursive: true, force: true });
  }

  const poisonedPublicationCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-poisoned-publication-cache-'),
  );
  try {
    const descriptor = await coldBuildLauncherPublicationDescriptor({
      architecture: launcher.architecture,
      cacheRoot: poisonedPublicationCacheRoot,
    });
    await createPrivateDirectoryChain(
      poisonedPublicationCacheRoot,
      descriptor.relativeDirectorySegments,
    );
    const poisonedBinaryPath = descriptor.cachedBinaryPath;
    await writeFile(poisonedBinaryPath, 'forged launcher bytes', { mode: 0o700 });
    await chmod(poisonedBinaryPath, 0o555);
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: poisonedPublicationCacheRoot,
      }),
      /cold_build_launcher_publication_conflict_invalid/,
    );
    assert.equal(await readFile(poisonedBinaryPath, 'utf8'), 'forged launcher bytes');
  } finally {
    await rm(poisonedPublicationCacheRoot, { recursive: true, force: true });
  }

  const mutablePublicationCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-mutable-publication-cache-'),
  );
  try {
    const descriptor = await coldBuildLauncherPublicationDescriptor({
      architecture: launcher.architecture,
      cacheRoot: mutablePublicationCacheRoot,
    });
    await createPrivateDirectoryChain(
      mutablePublicationCacheRoot,
      descriptor.relativeDirectorySegments,
    );
    const exactLauncherBytes = await readFile(launcher.executablePath);
    await writeFile(descriptor.cachedBinaryPath, exactLauncherBytes, { mode: 0o700 });
    await chmod(descriptor.cachedBinaryPath, 0o755);
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: mutablePublicationCacheRoot,
      }),
      /cold_build_launcher_publication_conflict_invalid:.*mutable_mode/,
    );
    assert.equal(contentHash(await readFile(descriptor.cachedBinaryPath)), launcher.binaryHash);
  } finally {
    await rm(mutablePublicationCacheRoot, { recursive: true, force: true });
  }

  const symlinkPublicationCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-symlink-publication-cache-'),
  );
  try {
    const descriptor = await coldBuildLauncherPublicationDescriptor({
      architecture: launcher.architecture,
      cacheRoot: symlinkPublicationCacheRoot,
    });
    await createPrivateDirectoryChain(
      symlinkPublicationCacheRoot,
      descriptor.relativeDirectorySegments,
    );
    const targetDirectory = path.join(symlinkPublicationCacheRoot, 'symlink-target');
    await mkdir(targetDirectory, { mode: 0o700 });
    await symlink(
      targetDirectory,
      descriptor.cachedBinaryPath,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: symlinkPublicationCacheRoot,
      }),
      /cold_build_launcher_publication_conflict_invalid:symbolic_link/,
    );
    assert.equal((await lstat(descriptor.cachedBinaryPath)).isSymbolicLink(), true);
  } finally {
    await rm(symlinkPublicationCacheRoot, { recursive: true, force: true });
  }

  const symlinkRootParent = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-symlink-root-'),
  );
  try {
    const targetRoot = path.join(symlinkRootParent, 'target');
    const linkedRoot = path.join(symlinkRootParent, 'linked');
    await mkdir(targetRoot, { mode: 0o700 });
    await symlink(
      targetRoot,
      linkedRoot,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: linkedRoot,
      }),
      /cold_build_launcher_cache_root_untrusted/,
    );
  } finally {
    await rm(symlinkRootParent, { recursive: true, force: true });
  }

  const symlinkInternalCacheRoot = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-symlink-internal-'),
  );
  try {
    const coldBuildDirectory = await createPrivateDirectoryChain(
      symlinkInternalCacheRoot,
      ['cold-build-launcher'],
    );
    const targetDirectory = path.join(symlinkInternalCacheRoot, 'target');
    await mkdir(targetDirectory, { mode: 0o700 });
    await symlink(
      targetDirectory,
      path.join(coldBuildDirectory, 'publications'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: symlinkInternalCacheRoot,
      }),
      /cold_build_launcher_publication_directory_untrusted/,
    );
  } finally {
    await rm(symlinkInternalCacheRoot, { recursive: true, force: true });
  }

  if (process.platform === 'win32') {
    const outsideUserCacheRoot = path.join(
      os.homedir(),
      `synthi-cold-launcher-outside-user-cache-${randomBytes(8).toString('hex')}`,
    );
    await assert.rejects(
      materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: outsideUserCacheRoot,
      }),
      /cold_build_launcher_cache_root_untrusted:outside_user_cache_base/,
    );
    await assert.rejects(access(outsideUserCacheRoot), { code: 'ENOENT' });
  }

  if (process.platform !== 'win32') {
    await assertLinuxCacheRootTrustRefusals();
  }

  const failedCoalescingParent = await mkdtemp(
    path.join(os.tmpdir(), 'synthi-cold-launcher-failed-coalescing-'),
  );
  try {
    const failedCacheRoot = path.join(failedCoalescingParent, 'cache-root');
    await writeFile(failedCacheRoot, 'not a directory', { mode: 0o600 });
    const failedResults = await Promise.allSettled(
      Array.from({ length: 2 }, () => materializeColdBuildLauncher({
        dockerExecutable,
        architecture: launcher.architecture,
        cacheRoot: failedCacheRoot,
      })),
    );
    assert.ok(failedResults.every(
      (result) => result.status === 'rejected'
        && /cold_build_launcher_cache_root_untrusted/.test(String(result.reason)),
    ));
    await rm(failedCacheRoot, { force: true });
    await mkdir(failedCacheRoot, { mode: 0o700 });
    const retry = await materializeColdBuildLauncher({
      dockerExecutable,
      architecture: launcher.architecture,
      cacheRoot: failedCacheRoot,
    });
    assert.equal(retry.buildEvidence.publicationOutcome, 'publication_created');
    assert.equal(retry.buildEvidence.buildExecuted, true);
  } finally {
    await rm(failedCoalescingParent, { recursive: true, force: true });
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
  assert.equal(versionReceipt.schemaVersion, 'synthi.gpu_hmr.cold_build_static_launcher.v2');
  assert.equal(versionReceipt.executableSelfHash, launcher.binaryHash);

  const executionNonce = randomBytes(16).toString('hex');
  const commandSpecHash = contentHash('launcher-self-check-command');
  const sourceBindingHash = contentHash('launcher-self-check-source');
  const artifactBytes = Buffer.from('project-neutral-cold-build-artifact\n', 'utf8');
  const artifactHash = contentHash(artifactBytes);
  const postExecIdentityBytes = Buffer.from('post-exec-identity-accepted\n', 'utf8');
  const postExecIdentityHash = contentHash(postExecIdentityBytes);
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
      outputs: [
        {
          path: 'artifact.bin',
          role: 'generic_build_artifact',
          artifactKind: 'opaque_build_output',
          mediaType: 'application/octet-stream',
          contentHash: artifactHash,
          byteLength: artifactBytes.byteLength,
        },
        {
          path: 'post-exec-identity.txt',
          role: 'post_exec_identity_probe',
          artifactKind: 'structured_runtime_probe',
          mediaType: 'text/plain',
          contentHash: postExecIdentityHash,
          byteLength: postExecIdentityBytes.byteLength,
        },
      ],
    };
    const script = [
      '#!/bin/sh',
      'set -eu',
      `if printf 'mutated\\n' > '${COLD_BUILD_LAUNCHER_SOURCE_ROOT}/source-sentinel.txt' 2>/dev/null; then exit 91; fi`,
      'uid_fields= gid_fields= groups_fields= cap_inh= cap_prm= cap_eff= cap_bnd= cap_amb= no_new_privs=',
      'while IFS= read -r status_line; do',
      '  case "$status_line" in',
      '    Uid:*) uid_fields=${status_line#Uid:} ;;',
      '    Gid:*) gid_fields=${status_line#Gid:} ;;',
      '    Groups:*) groups_fields=${status_line#Groups:} ;;',
      '    CapInh:*) set -- ${status_line#CapInh:}; cap_inh=${1-} ;;',
      '    CapPrm:*) set -- ${status_line#CapPrm:}; cap_prm=${1-} ;;',
      '    CapEff:*) set -- ${status_line#CapEff:}; cap_eff=${1-} ;;',
      '    CapBnd:*) set -- ${status_line#CapBnd:}; cap_bnd=${1-} ;;',
      '    CapAmb:*) set -- ${status_line#CapAmb:}; cap_amb=${1-} ;;',
      '    NoNewPrivs:*) set -- ${status_line#NoNewPrivs:}; no_new_privs=${1-} ;;',
      '  esac',
      'done < /proc/thread-self/status',
      'set -- $uid_fields; [ "$#" -eq 4 ] && [ "$1" = "65532" ] && [ "$2" = "65532" ] && [ "$3" = "65532" ] && [ "$4" = "65532" ] || exit 92',
      'set -- $gid_fields; [ "$#" -eq 4 ] && [ "$1" = "65532" ] && [ "$2" = "65532" ] && [ "$3" = "65532" ] && [ "$4" = "65532" ] || exit 93',
      'set -- $groups_fields; [ "$#" -eq 0 ] || exit 94',
      "for capability in \"$cap_inh\" \"$cap_prm\" \"$cap_eff\" \"$cap_bnd\" \"$cap_amb\"; do case \"$capability\" in ''|*[!0]*) exit 95 ;; esac; done",
      '[ "$no_new_privs" = "1" ] || exit 96',
      `printf 'post-exec-identity-accepted\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/post-exec-identity.txt'`,
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
      launcherIdentity: launcher,
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
      collectedEntryLimit: 3,
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
      launcherIdentity: launcher,
      specHash,
      commandSpecHash,
      sourceBindingHash,
    });
    startPromise = attached.completion;
    const readyFrame = await attached.ready;
    const readyBytes = readyFrame.receiptBytes;
    const ready = readyFrame.receipt;
    const readyHash = readyFrame.receiptHash;
    assert.equal(ready.schemaVersion, 'synthi.gpu_hmr.cold_build_ready_receipt.v2');
    assert.equal(ready.launcherExecutableSelfHash, launcher.binaryHash);
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
      expectedLauncherIdentity: launcher,
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
    assert.throws(
      () => parseColdBuildControlFrame(
        encodeControlReceiptFrame({
          ...ready,
          launcherExecutableSelfHash: contentHash('replayed-launcher'),
        }),
        controlParserBindings,
      ),
      /receipt_binding_invalid/,
    );
    for (const blockingGaps of [null, {}, '', false]) {
      assert.throws(
        () => parseColdBuildControlFrame(
          encodeControlReceiptFrame({ ...ready, blockingGaps }),
          controlParserBindings,
        ),
        /receipt_binding_invalid/,
      );
    }
    for (const malformedReceipt of [
      {
        ...ready,
        childIdentityReceiptHash: [ready.childIdentityReceiptHash],
      },
      {
        ...ready,
        commandStdout: {
          ...ready.commandStdout,
          contentHash: [ready.commandStdout.contentHash],
        },
      },
      {
        ...ready,
        commandStderr: {
          ...ready.commandStderr,
          contentHash: [ready.commandStderr.contentHash],
        },
      },
      {
        ...ready,
        outputSnapshotHash: [ready.outputSnapshotHash],
      },
    ]) {
      assert.throws(
        () => parseColdBuildControlFrame(
          encodeControlReceiptFrame(malformedReceipt),
          controlParserBindings,
        ),
        /receipt_binding_invalid/,
      );
    }

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
      maxEntryCount: 3,
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
    const postExecIdentity = frame.payloads.find(
      ({ entry }) => entry.path === 'post-exec-identity.txt',
    );
    assert.ok(postExecIdentity);
    assert.equal(contentHash(postExecIdentity.bytes), postExecIdentityHash);
    const corruptedFrame = Buffer.from(collectResult.stdout);
    corruptedFrame[corruptedFrame.length - 1] ^= 0xff;
    assert.throws(
      () => parseColdBuildCollectorFrame(corruptedFrame, {
        maxHeaderBytes: 1024 * 1024,
        maxPayloadBytes: 4 * 1024 * 1024,
        maxEntryCount: 3,
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
        maxEntryCount: 3,
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
          maxEntryCount: 3,
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
      maxEntryCount: 3,
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
    'launcher-executable-hash-mismatch',
  ]) {
    await runProtocolRefusalScenario({ launcher, mode });
  }
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await runProtocolRefusalScenario({ launcher, mode: 'direct-argv-no-manifest' });
  }
  process.stdout.write('gpu-hmr cold-build static launcher self-check passed\n');
}

await main();
