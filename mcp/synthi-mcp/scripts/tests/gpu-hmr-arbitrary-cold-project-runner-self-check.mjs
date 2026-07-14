import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ARBITRARY_COLD_PROJECT_DESCRIPTOR_SCHEMA,
  ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
  ARBITRARY_COLD_PROJECT_RUN_FAILURE_AUTHORITY,
  ARBITRARY_COLD_PROJECT_RUN_FAILURE_SCHEMA,
  ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
  normalizeArbitraryColdProjectDescriptor,
  runArbitraryColdProject,
  verifyArbitraryColdProjectRun,
  verifyArbitraryColdProjectRunFailure,
} from '../gpu-hmr-arbitrary-cold-project-runner.mjs';
import {
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';
import {
  ARBITRARY_COLD_CLI_RESULT_ENVELOPE_AUTHORITY,
  ARBITRARY_COLD_CLI_RESULT_ENVELOPE_SCHEMA,
  verifyArbitraryColdCliResultEnvelope,
} from '../lib/gpu-hmr-arbitrary-cold-cli-envelope.mjs';
import {
  ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_AUTHORITY,
  ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_SCHEMA,
  verifyArbitraryColdRetainedExecutionChain,
} from '../lib/gpu-hmr-arbitrary-cold-retained-chain.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-arbitrary-cold-self-check-'));
const execFileAsync = promisify(execFile);

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

function resealEvidence(value) {
  const projection = { ...value };
  delete projection.evidenceHash;
  value.evidenceHash = `sha256:${createHash('sha256')
    .update(stableJson(projection))
    .digest('hex')}`;
}

function resealCliLocatorBinding(envelope, outputIndex) {
  const output = envelope.outputs[outputIndex];
  const locator = output.artifactLocator;
  const locatorProjection = { ...locator, manifestHash: undefined };
  locator.manifestHash = `sha256:${createHash('sha256')
    .update(stableJson(locatorProjection))
    .digest('hex')}`;
  output.transportEvidence.manifestHash = locator.manifestHash;
  const chain = envelope.retainedExecutionChain;
  const binding = chain.artifactLocatorBindings.find(
    (candidate) => candidate.path === output.metadata.path,
  );
  binding.manifestHash = locator.manifestHash;
  chain.runEvidence.artifactLocatorSetHash = `sha256:${createHash('sha256')
    .update(stableJson(chain.artifactLocatorBindings))
    .digest('hex')}`;
  resealEvidence(chain.runEvidence);
  resealEvidence(chain);
  envelope.evidence = structuredClone(chain.runEvidence);
  resealEvidence(envelope);
}

async function runningColdContainers() {
  const { stdout } = await execFileAsync('docker', ['ps', '--format', '{{.Names}}']);
  return new Set(stdout.split(/\r?\n/).filter((name) => (
    name.startsWith('synthi-arbitrary-cold-')
  )));
}

async function waitForNewColdContainer(previous, timeoutMillis = 30_000) {
  const deadline = Date.now() + timeoutMillis;
  while (Date.now() < deadline) {
    const current = await runningColdContainers();
    const added = [...current].find((name) => !previous.has(name));
    if (added) return added;
    await delay(100);
  }
  throw new Error('arbitrary_cold_runner_test_container_not_observed');
}

try {
  const privateArgument = '--private-self-check-argument=not-for-retention';
  const privateEnvironmentValue = 'private-self-check-environment-value-not-for-retention';
  const sourceRoot = path.join(root, 'opaque source tree');
  const readOnlyInputRoot = path.join(root, 'opaque dependency tree');
  const artifactRoot = path.join(root, 'retained artifact cas');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(readOnlyInputRoot, { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
  ]);
  const script = [
    '#!/bin/sh',
    'set -eu',
    `printf 'arbitrary cold project output\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/result.bin'`,
    'sleep 2',
    `cat '/workspace/inputs/opaque dependency/input.txt' >> '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/result.bin'`,
    'sleep 3',
    `printf '{"count":3,"status":"built"}\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/result.json'`,
    '',
  ].join('\n');
  assert.ok(!script.includes('manifest'));
  const scriptPath = path.join(sourceRoot, 'build-project.sh');
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  await chmod(scriptPath, 0o755);
  await writeFile(path.join(sourceRoot, 'ordinary-input.txt'), 'ordinary source bytes\n');
  await writeFile(path.join(readOnlyInputRoot, 'input.txt'), 'bound dependency bytes\n');

  const descriptor = {
    schemaVersion: ARBITRARY_COLD_PROJECT_DESCRIPTOR_SCHEMA,
    sourceRoot,
    readOnlyInputs: [{
      sourceRoot: readOnlyInputRoot,
      mountPath: 'opaque dependency',
      sourceLimits: {
        maxEntryCount: 4096,
        maxByteLength: 64 * 1024 * 1024,
      },
    }],
    workerImage: COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    containerRuntime: 'runc',
    command: '/bin/sh',
    args: ['/workspace/source/build-project.sh', privateArgument],
    environment: {
      HOME: '/tmp/cold-home',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      PRIVATE_SELF_CHECK_VALUE: privateEnvironmentValue,
      TMPDIR: '/tmp',
    },
    workingDirectory: '.',
    outputs: [
      {
        path: 'result.json',
        role: 'structured_result',
        artifactKind: 'structured_build_output',
        mediaType: 'application/json',
      },
      {
        path: 'result.bin',
        role: 'primary_result',
        artifactKind: 'opaque_build_output',
        mediaType: 'application/octet-stream',
      },
    ],
    sourceLimits: {
      maxEntryCount: 4096,
      maxByteLength: 64 * 1024 * 1024,
    },
    resources: {
      commandTimeoutMillis: 30_000,
      releaseTimeoutMillis: 30_000,
      workspaceByteLimit: 128 * 1024 * 1024,
      workspaceEntryLimit: 4096,
      collectedByteLimit: 16 * 1024 * 1024,
      collectedEntryLimit: 16,
      memoryBytes: 1024 * 1024 * 1024,
      memorySwapBytes: 1024 * 1024 * 1024,
      nanoCpus: 1_000_000_000,
      pidsLimit: 256,
      nofileLimit: 1024,
    },
  };
  const normalized = normalizeArbitraryColdProjectDescriptor(descriptor);
  assert.equal(normalized.sourceRoot, path.resolve(sourceRoot));
  assert.equal(normalized.readOnlyInputs[0].sourceRoot, path.resolve(readOnlyInputRoot));
  assert.equal(normalized.readOnlyInputs[0].mountPath, 'opaque dependency');
  const legacyV1Descriptor = structuredClone(descriptor);
  delete legacyV1Descriptor.readOnlyInputs;
  assert.deepEqual(
    normalizeArbitraryColdProjectDescriptor(legacyV1Descriptor).readOnlyInputs,
    [],
  );
  assert.throws(
    () => normalizeArbitraryColdProjectDescriptor({ ...descriptor, projectName: 'shortcut' }),
    /descriptor_shape_invalid/,
  );
  assert.throws(
    () => normalizeArbitraryColdProjectDescriptor({
      ...descriptor,
      sourceLimits: { ...descriptor.sourceLimits, maxEntryCount: 1_000_001 },
    }),
    /source_limits_exceed_policy/,
  );
  assert.throws(
    () => normalizeArbitraryColdProjectDescriptor({
      ...descriptor,
      readOnlyInputs: [{ ...descriptor.readOnlyInputs[0], mountPath: '../escape' }],
    }),
    /read_only_input_mount_path_invalid/,
  );
  assert.throws(
    () => normalizeArbitraryColdProjectDescriptor({
      ...descriptor,
      readOnlyInputs: [{ ...descriptor.readOnlyInputs[0], sourceRoot }],
    }),
    /read_only_input_source_overlap/,
  );
  assert.throws(
    () => normalizeArbitraryColdProjectDescriptor({
      ...descriptor,
      resources: { ...descriptor.resources, commandTimeoutMillis: 7_200_001 },
    }),
    /resources_exceed_policy/,
  );
  assert.throws(
    () => normalizeArbitraryColdProjectDescriptor(descriptor, {
      policy: {
        maxCommandTimeoutMillis: 5000,
        maxReleaseTimeoutMillis: 5000,
      },
    }),
    /resources_exceed_policy/,
  );
  const missingArtifactRoot = path.join(sourceRoot, 'must-not-be-created');
  await assert.rejects(
    () => runArbitraryColdProject(descriptor, { artifactRoot: missingArtifactRoot }),
    /artifact_root_invalid/,
  );
  await assert.rejects(() => readFile(missingArtifactRoot), /ENOENT/);
  await assert.rejects(
    () => runArbitraryColdProject(descriptor, { artifactRoot: sourceRoot }),
    /artifact_source_overlap/,
  );
  await assert.rejects(
    () => runArbitraryColdProject(descriptor, { artifactRoot: readOnlyInputRoot }),
    /artifact_source_overlap/,
  );
  await assert.rejects(
    () => runArbitraryColdProject(descriptor, {
      artifactRoot,
      policy: { maxReadOnlyInputTotalByteLength: 1 },
    }),
    /read_only_input_aggregate_limit_exceeded/,
  );

  const runDescriptor = structuredClone(descriptor);
  const preexistingColdContainers = await runningColdContainers();
  const pendingRun = runArbitraryColdProject(runDescriptor, { artifactRoot });
  runDescriptor.outputs[0].role = 'mutated_after_run_started';
  runDescriptor.resources.memoryBytes *= 2;
  runDescriptor.readOnlyInputs[0].mountPath = 'mutated after run started';
  await waitForNewColdContainer(preexistingColdContainers);
  try {
    await writeFile(path.join(readOnlyInputRoot, 'input.txt'), 'transient unbound bytes\n');
    await delay(3000);
  } finally {
    await writeFile(path.join(readOnlyInputRoot, 'input.txt'), 'bound dependency bytes\n');
  }
  const result = await pendingRun;
  assert.equal(await verifyArbitraryColdProjectRun(result), result);
  assert.equal(result.evidence.schemaVersion, ARBITRARY_COLD_PROJECT_RUN_SCHEMA);
  assert.equal(result.evidence.proofAuthority, ARBITRARY_COLD_PROJECT_RUN_AUTHORITY);
  assert.equal(result.evidence.coldBuildSucceeded, true);
  assert.equal(result.evidence.acceptedAsColdBuildEvidence, true);
  assert.equal(result.evidence.acceptedForGpuHmr, false);
  assert.equal(result.evidence.gpuHmrSuccess, false);
  assert.equal(result.evidence.canSatisfyRuntimeProof, false);
  assert.equal(result.evidence.canSatisfyDispatchProof, false);
  assert.equal(result.evidence.inputSetBindings.length, 2);
  assert.match(result.evidence.inputSetHash, /^sha256:[0-9a-f]{64}$/);
  assert.match(result.evidence.sourceSnapshotEvidenceHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.evidence.readOnlyInputSnapshotBindings.length, 1);
  assert.match(
    result.evidence.readOnlyInputSnapshotBindings[0].snapshotEvidenceHash,
    /^sha256:[0-9a-f]{64}$/,
  );
  assert.equal(result.evidence.readOnlyInputBindings.length, 1);
  assert.deepEqual(
    Object.keys(result.evidence.readOnlyInputBindings[0]).sort(),
    [
      'entryCount',
      'mountPath',
      'sourceBindingHash',
      'sourceTreeBindingEvidenceHash',
      'totalByteLength',
    ].sort(),
  );
  assert.equal(result.evidence.readOnlyInputBindings[0].mountPath, 'opaque dependency');
  assert.match(result.evidence.readOnlyInputBindings[0].sourceBindingHash, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.evidence.readOnlyInputBindings[0].entryCount, 1);
  assert.ok(result.evidence.readOnlyInputBindings[0].totalByteLength > 0);
  assert.equal('hostPath' in result.evidence.readOnlyInputBindings[0], false);
  assert.equal('sourceRoot' in result.evidence.readOnlyInputBindings[0], false);
  assert.equal(result.evidence.readOnlyInputCount, 1);
  assert.equal(result.evidence.readOnlyInputEntryCount, 1);
  assert.ok(result.evidence.readOnlyInputByteLength > 0);
  const retainedExecutionChain = JSON.parse(JSON.stringify(result.retainedExecutionChain));
  assert.equal(
    retainedExecutionChain.schemaVersion,
    ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_SCHEMA,
  );
  assert.equal(
    retainedExecutionChain.proofAuthority,
    ARBITRARY_COLD_RETAINED_EXECUTION_CHAIN_AUTHORITY,
  );
  assert.equal(retainedExecutionChain.acceptedAsRetainedColdExecutionChain, true);
  assert.equal(retainedExecutionChain.externalAuthenticityAnchorEmbedded, false);
  assert.equal(retainedExecutionChain.acceptedAsColdBuildEvidence, false);
  assert.equal(retainedExecutionChain.acceptedForGpuHmr, false);
  assert.equal(retainedExecutionChain.gpuHmrSuccess, false);
  assert.equal(retainedExecutionChain.canSatisfyRuntimeProof, false);
  assert.equal(retainedExecutionChain.canSatisfyDispatchProof, false);
  assert.equal(retainedExecutionChain.readOnlyInputSnapshotReceipts.length, 1);
  assert.equal(
    verifyArbitraryColdRetainedExecutionChain(retainedExecutionChain),
    retainedExecutionChain,
  );
  assert.equal('contract' in retainedExecutionChain, false);
  assert.equal(retainedExecutionChain.contractReceipt.plaintextCommandEmbedded, false);
  assert.equal(retainedExecutionChain.contractReceipt.plaintextArgumentsEmbedded, false);
  assert.equal(retainedExecutionChain.contractReceipt.plaintextEnvironmentValuesEmbedded, false);
  assert.equal('workerImageEvidence' in retainedExecutionChain, false);
  assert.equal(retainedExecutionChain.workerImageReceipt.environmentValuesEmbedded, false);
  assert.equal(retainedExecutionChain.workerImageReceipt.repoDigestValuesEmbedded, false);
  assert.equal(
    retainedExecutionChain.workerImageReceipt.environmentEntryCount >= 0,
    true,
  );
  const serializedRetainedExecutionChain = JSON.stringify(retainedExecutionChain);
  assert.doesNotMatch(serializedRetainedExecutionChain, /bound dependency bytes/);
  assert.equal(serializedRetainedExecutionChain.includes(privateArgument), false);
  assert.equal(serializedRetainedExecutionChain.includes(privateEnvironmentValue), false);
  const { stdout: workerImageInspectOutput } = await execFileAsync(
    'docker',
    ['image', 'inspect', COLD_BUILD_LAUNCHER_BUILDER_IMAGE],
  );
  const [workerImageDescriptor] = JSON.parse(workerImageInspectOutput);
  for (const environmentEntry of workerImageDescriptor?.Config?.Env ?? []) {
    assert.equal(serializedRetainedExecutionChain.includes(environmentEntry), false);
  }

  const forgedRetainedWorkerEnvironment = structuredClone(retainedExecutionChain);
  forgedRetainedWorkerEnvironment.workerImageReceipt.environmentValuesEmbedded = true;
  resealEvidence(forgedRetainedWorkerEnvironment.workerImageReceipt);
  resealEvidence(forgedRetainedWorkerEnvironment);
  assert.throws(
    () => verifyArbitraryColdRetainedExecutionChain(forgedRetainedWorkerEnvironment),
    /retained_execution_chain_invalid/,
  );

  const forgedRetainedWorkerReference = structuredClone(retainedExecutionChain);
  forgedRetainedWorkerReference.workerImageReference = `sha256:${'2'.repeat(64)}`;
  resealEvidence(forgedRetainedWorkerReference);
  assert.throws(
    () => verifyArbitraryColdRetainedExecutionChain(forgedRetainedWorkerReference),
    /retained_execution_chain_invalid/,
  );

  for (const mutateReceipt of [
    (receipt) => { receipt.commandInvocationHash = `sha256:${'0'.repeat(64)}`; },
    (receipt) => { receipt.environmentEntrySetHash = `sha256:${'1'.repeat(64)}`; },
    (receipt) => { receipt.resources.nanoCpus += 1; },
    (receipt) => { receipt.containerRuntime = 'different-runtime'; },
  ]) {
    const forgedRetainedContractCommitment = structuredClone(retainedExecutionChain);
    mutateReceipt(forgedRetainedContractCommitment.contractReceipt);
    resealEvidence(forgedRetainedContractCommitment.contractReceipt);
    resealEvidence(forgedRetainedContractCommitment);
    assert.throws(
      () => verifyArbitraryColdRetainedExecutionChain(forgedRetainedContractCommitment),
      /retained_execution_chain_invalid/,
    );
  }

  const forgedRetainedContractLink = structuredClone(retainedExecutionChain);
  forgedRetainedContractLink.runEvidence.contractHash = `sha256:${'0'.repeat(64)}`;
  resealEvidence(forgedRetainedContractLink.runEvidence);
  resealEvidence(forgedRetainedContractLink);
  assert.throws(
    () => verifyArbitraryColdRetainedExecutionChain(forgedRetainedContractLink),
    /retained_execution_chain_invalid/,
  );

  const forgedRetainedArtifact = structuredClone(retainedExecutionChain);
  forgedRetainedArtifact.artifactLocatorBindings[0].contentHash =
    `sha256:${'1'.repeat(64)}`;
  forgedRetainedArtifact.artifactLocatorBindings[0].artifactId =
    `artifact:sha256:${'1'.repeat(64)}`;
  forgedRetainedArtifact.runEvidence.artifactLocatorSetHash =
    `sha256:${createHash('sha256')
      .update(stableJson(forgedRetainedArtifact.artifactLocatorBindings))
      .digest('hex')}`;
  resealEvidence(forgedRetainedArtifact.runEvidence);
  resealEvidence(forgedRetainedArtifact);
  assert.throws(
    () => verifyArbitraryColdRetainedExecutionChain(forgedRetainedArtifact),
    /retained_execution_chain_invalid/,
  );

  const forgedRetainedAuthority = structuredClone(retainedExecutionChain);
  forgedRetainedAuthority.acceptedAsColdBuildEvidence = true;
  forgedRetainedAuthority.acceptedForGpuHmr = true;
  forgedRetainedAuthority.gpuHmrSuccess = true;
  resealEvidence(forgedRetainedAuthority);
  assert.throws(
    () => verifyArbitraryColdRetainedExecutionChain(forgedRetainedAuthority),
    /retained_execution_chain_invalid/,
  );
  assert.equal(result.outputs.length, 2);
  const binary = result.outputs.find((output) => output.metadata.path === 'result.bin');
  const structured = result.outputs.find((output) => output.metadata.path === 'result.json');
  assert.equal(structured.metadata.declaredRole, 'structured_result');
  assert.equal(
    binary.bytes.toString('utf8'),
    'arbitrary cold project output\nbound dependency bytes\n',
  );
  assert.deepEqual(JSON.parse(structured.bytes.toString('utf8')), {
    count: 3,
    status: 'built',
  });
  for (const output of result.outputs) {
    assert.equal(output.transportEvidence.accepted, true);
    assert.equal(output.transportEvidence.acceptedAsTransportEvidence, true);
    assert.equal(output.transportEvidence.acceptedForGpuHmr, false);
    assert.equal(output.transportEvidence.gpuHmrSuccess, false);
    assert.equal(
      (await readFile(output.artifactLocator.storage.localPath)).length,
      output.bytes.length,
    );
  }
  await assert.rejects(
    () => verifyArbitraryColdProjectRun(structuredClone(result)),
    /result_invalid/,
  );
  result.evidence.gpuHmrSuccess = true;
  await assert.rejects(
    () => verifyArbitraryColdProjectRun(result),
    /result_invalid/,
  );
  result.evidence.gpuHmrSuccess = false;
  assert.equal(await verifyArbitraryColdProjectRun(result), result);
  const sourceSnapshotEvidenceHash = result.evidence.sourceSnapshotEvidenceHash;
  result.evidence.sourceSnapshotEvidenceHash = `sha256:${'0'.repeat(64)}`;
  await assert.rejects(
    () => verifyArbitraryColdProjectRun(result),
    /result_invalid/,
  );
  result.evidence.sourceSnapshotEvidenceHash = sourceSnapshotEvidenceHash;
  assert.equal(await verifyArbitraryColdProjectRun(result), result);
  assert.ok(!JSON.stringify(result.evidence).match(
    /miopen|hiprt|flow|diamond|neural|blas|cuda|rocm|project_name|fixture_name/i,
  ));

  const movedArtifactSessionRoot = `${result.artifactSessionRoot}-moved`;
  await rename(result.artifactSessionRoot, movedArtifactSessionRoot);
  await mkdir(result.artifactSessionRoot);
  await assert.rejects(
    () => verifyArbitraryColdProjectRun(result),
    /artifact_session_identity_changed|result_invalid/,
  );
  await rm(result.artifactSessionRoot, { recursive: true, force: true });
  await rename(movedArtifactSessionRoot, result.artifactSessionRoot);
  assert.equal(await verifyArbitraryColdProjectRun(result), result);

  const descriptorPath = path.join(root, 'descriptor.json');
  const cliArtifactRoot = path.join(root, 'cli retained artifact cas');
  await Promise.all([
    writeFile(descriptorPath, `${JSON.stringify(descriptor)}\n`),
    mkdir(cliArtifactRoot, { recursive: true }),
  ]);
  const runnerPath = fileURLToPath(new URL('../gpu-hmr-arbitrary-cold-project-runner.mjs', import.meta.url));
  const parsedRunnerPath = path.parse(runnerPath);
  const cliRunnerPath = process.platform === 'win32'
    ? path.join(parsedRunnerPath.dir.toUpperCase(), parsedRunnerPath.base)
    : runnerPath;
  const { stdout, stderr } = await execFileAsync(process.execPath, [
    cliRunnerPath,
    '--descriptor', descriptorPath,
    '--artifact-root', cliArtifactRoot,
  ], {
    encoding: 'utf8',
    maxBuffer: 4 * 1024 * 1024,
    timeout: 120_000,
    windowsHide: true,
  });
  assert.equal(stderr, '');
  const cliResult = JSON.parse(stdout);
  assert.equal(cliResult.schemaVersion, ARBITRARY_COLD_CLI_RESULT_ENVELOPE_SCHEMA);
  assert.equal(cliResult.proofAuthority, ARBITRARY_COLD_CLI_RESULT_ENVELOPE_AUTHORITY);
  assert.equal(verifyArbitraryColdCliResultEnvelope(cliResult), cliResult);
  assert.equal(cliResult.outputBytesEmbedded, false);
  assert.equal(cliResult.externalAuthenticityAnchorEmbedded, false);
  assert.equal(cliResult.acceptedAsCliResultEnvelope, true);
  assert.equal(cliResult.acceptedAsColdBuildEvidence, false);
  assert.equal(cliResult.acceptedForGpuHmr, false);
  assert.equal(cliResult.gpuHmrSuccess, false);
  assert.equal(cliResult.canSatisfyRuntimeProof, false);
  assert.equal(cliResult.canSatisfyDispatchProof, false);
  assert.equal(cliResult.evidence.schemaVersion, ARBITRARY_COLD_PROJECT_RUN_SCHEMA);
  assert.equal(cliResult.evidence.acceptedForGpuHmr, false);
  assert.equal(cliResult.evidence.gpuHmrSuccess, false);
  assert.equal(
    verifyArbitraryColdRetainedExecutionChain(cliResult.retainedExecutionChain),
    cliResult.retainedExecutionChain,
  );
  assert.equal(
    cliResult.retainedExecutionChain.runEvidence.evidenceHash,
    cliResult.evidence.evidenceHash,
  );
  assert.equal(cliResult.outputs.length, descriptor.outputs.length);
  assert.equal(stdout.includes(privateArgument), false);
  assert.equal(stdout.includes(privateEnvironmentValue), false);
  const forgedCliDescriptorBinding = structuredClone(cliResult);
  forgedCliDescriptorBinding.descriptorHash = `sha256:${'0'.repeat(64)}`;
  resealEvidence(forgedCliDescriptorBinding);
  assert.throws(
    () => verifyArbitraryColdCliResultEnvelope(forgedCliDescriptorBinding),
    /cli_result_envelope_invalid/,
  );
  const forgedCliSiblingEvidence = structuredClone(cliResult);
  forgedCliSiblingEvidence.evidence.contractHash = `sha256:${'1'.repeat(64)}`;
  resealEvidence(forgedCliSiblingEvidence.evidence);
  resealEvidence(forgedCliSiblingEvidence);
  assert.throws(
    () => verifyArbitraryColdCliResultEnvelope(forgedCliSiblingEvidence),
    /cli_result_envelope_invalid/,
  );
  const forgedCliOutputAuthority = structuredClone(cliResult);
  forgedCliOutputAuthority.outputs[0].transportEvidence.runtimeAuthority = true;
  resealEvidence(forgedCliOutputAuthority);
  assert.throws(
    () => verifyArbitraryColdCliResultEnvelope(forgedCliOutputAuthority),
    /cli_result_envelope_invalid/,
  );
  for (const mutateTransport of [
    (transport) => { transport.schemaVersion = 'forged.transport.v1'; },
    (transport) => { transport.artifactUri = 'synthi-cas://forged/sha256/deadbeef'; },
    (transport) => { transport.byteLength += 1; },
    (transport) => { transport.mediaType = 'text/plain'; },
    (transport) => { transport.reasons = ['forged_transport_reason']; },
    (transport) => { transport.gaps = ['forged_transport_gap']; },
  ]) {
    const forgedCliTransport = structuredClone(cliResult);
    mutateTransport(forgedCliTransport.outputs[0].transportEvidence);
    resealEvidence(forgedCliTransport);
    assert.throws(
      () => verifyArbitraryColdCliResultEnvelope(forgedCliTransport),
      /cli_result_envelope_invalid/,
    );
  }
  const forgedCliCanonicalUri = structuredClone(cliResult);
  const canonicalLocator = forgedCliCanonicalUri.outputs[0].artifactLocator;
  canonicalLocator.artifactUri = [
    'synthi-cas://forged-namespace/sha256/',
    canonicalLocator.contentHash.slice('sha256:'.length),
  ].join('');
  forgedCliCanonicalUri.outputs[0].transportEvidence.artifactUri =
    canonicalLocator.artifactUri;
  resealCliLocatorBinding(forgedCliCanonicalUri, 0);
  assert.throws(
    () => verifyArbitraryColdCliResultEnvelope(forgedCliCanonicalUri),
    /cli_result_envelope_invalid/,
  );
  const forgedCliOutputRole = structuredClone(cliResult);
  forgedCliOutputRole.outputs[0].artifactLocator.role = 'forged_output_role';
  resealCliLocatorBinding(forgedCliOutputRole, 0);
  assert.throws(
    () => verifyArbitraryColdCliResultEnvelope(forgedCliOutputRole),
    /cli_result_envelope_invalid/,
  );
  assert.ok(!JSON.stringify(cliResult.evidence).match(
    /miopen|hiprt|flow|diamond|neural|blas|cuda|rocm|project_name|fixture_name/i,
  ));

  const refusedScript = [
    '#!/bin/sh',
    'set -eu',
    "printf 'opaque command failed\\n'",
    "printf 'Authorization: Bearer cli-secret-must-not-leak\\n' >&2",
    "printf 'ARBITRARY_API_KEY=second-cli-secret\\n' >&2",
    'exit 19',
    '',
  ].join('\n');
  const refusedArtifactRoot = path.join(root, 'refused cli retained artifact cas');
  await Promise.all([
    writeFile(scriptPath, refusedScript, { encoding: 'utf8', mode: 0o755 }),
    mkdir(refusedArtifactRoot, { recursive: true }),
  ]);
  await chmod(scriptPath, 0o755);
  let refusedCliError = null;
  try {
    await execFileAsync(process.execPath, [
      cliRunnerPath,
      '--descriptor', descriptorPath,
      '--artifact-root', refusedArtifactRoot,
    ], {
      encoding: 'utf8',
      maxBuffer: 4 * 1024 * 1024,
      timeout: 120_000,
      windowsHide: true,
    });
  } catch (error) {
    refusedCliError = error;
  }
  assert.ok(refusedCliError instanceof Error);
  assert.equal(refusedCliError.stdout, '');
  const refusedCliEnvelope = JSON.parse(refusedCliError.stderr);
  const failure = refusedCliEnvelope.failure;
  assert.equal(failure.schemaVersion, ARBITRARY_COLD_PROJECT_RUN_FAILURE_SCHEMA);
  assert.equal(failure.proofAuthority, ARBITRARY_COLD_PROJECT_RUN_FAILURE_AUTHORITY);
  assert.equal(verifyArbitraryColdProjectRunFailure(failure), failure);
  assert.equal(failure.failureCode, 'cold_build_execution_driver_ready_receipt_refused');
  assert.equal(failure.acceptedAsFailureDiagnostics, true);
  assert.equal(failure.acceptedAsColdBuildEvidence, false);
  assert.equal(failure.acceptedForGpuHmr, false);
  assert.equal(failure.gpuHmrSuccess, false);
  assert.equal(failure.canSatisfyRuntimeProof, false);
  assert.equal(failure.canSatisfyDispatchProof, false);
  assert.equal(failure.readyRefusalEvidence.childExitCode, 19);
  assert.equal(failure.refusalDiagnostics.acceptedAsDiagnosticSupportEvidence, true);
  assert.match(failure.refusalDiagnostics.streams.stdout.redactedText, /opaque command failed/);
  assert.match(failure.refusalDiagnostics.streams.stderr.redactedText, /<redacted>/);
  assert.doesNotMatch(refusedCliError.stderr, /cli-secret-must-not-leak/);
  assert.doesNotMatch(refusedCliError.stderr, /second-cli-secret/);
  assert.equal(failure.launcherDiagnostics.acceptedAsDiagnosticSupportEvidence, true);
  assert.match(
    failure.launcherDiagnostics.redactedText,
    /cold-build output snapshot refused/,
  );
  assert.equal(failure.launcherDiagnostics.acceptedForGpuHmr, false);
  assert.equal(failure.launcherDiagnostics.gpuHmrSuccess, false);
  assert.equal(failure.cleanupEvidence.absenceProven, true);
  failure.gpuHmrSuccess = true;
  assert.throws(
    () => verifyArbitraryColdProjectRunFailure(failure),
    /failure_evidence_invalid/,
  );
  failure.gpuHmrSuccess = false;
  assert.equal(verifyArbitraryColdProjectRunFailure(failure), failure);

  console.log(JSON.stringify({
    status: 'self_check_passed',
    schemaVersion: result.evidence.schemaVersion,
    evidenceHash: result.evidence.evidenceHash,
    sourceBindingHash: result.evidence.sourceBindingHash,
    workerImageId: result.evidence.workerImageId,
    outputCount: result.outputs.length,
    manifestAuthoredByProject: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
  }, null, 2));
} finally {
  await rm(root, { recursive: true, force: true });
}
