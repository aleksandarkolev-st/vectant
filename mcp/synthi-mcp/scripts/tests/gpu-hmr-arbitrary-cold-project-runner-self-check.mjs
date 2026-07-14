import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import {
  ARBITRARY_COLD_PROJECT_DESCRIPTOR_SCHEMA,
  ARBITRARY_COLD_PROJECT_RUN_AUTHORITY,
  ARBITRARY_COLD_PROJECT_RUN_SCHEMA,
  normalizeArbitraryColdProjectDescriptor,
  runArbitraryColdProject,
  verifyArbitraryColdProjectRun,
} from '../gpu-hmr-arbitrary-cold-project-runner.mjs';
import {
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';

const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-arbitrary-cold-self-check-'));
const execFileAsync = promisify(execFile);
try {
  const sourceRoot = path.join(root, 'opaque source tree');
  const artifactRoot = path.join(root, 'retained artifact cas');
  await Promise.all([
    mkdir(sourceRoot, { recursive: true }),
    mkdir(artifactRoot, { recursive: true }),
  ]);
  const script = [
    '#!/bin/sh',
    'set -eu',
    `printf 'arbitrary cold project output\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/result.bin'`,
    `printf '{"count":3,"status":"built"}\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/result.json'`,
    '',
  ].join('\n');
  assert.ok(!script.includes('manifest'));
  const scriptPath = path.join(sourceRoot, 'build-project.sh');
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  await chmod(scriptPath, 0o755);
  await writeFile(path.join(sourceRoot, 'ordinary-input.txt'), 'ordinary source bytes\n');

  const descriptor = {
    schemaVersion: ARBITRARY_COLD_PROJECT_DESCRIPTOR_SCHEMA,
    sourceRoot,
    workerImage: COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
    containerRuntime: 'runc',
    command: '/bin/sh',
    args: ['/workspace/source/build-project.sh'],
    environment: {
      HOME: '/tmp/cold-home',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
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

  const runDescriptor = structuredClone(descriptor);
  const pendingRun = runArbitraryColdProject(runDescriptor, { artifactRoot });
  runDescriptor.outputs[0].role = 'mutated_after_run_started';
  runDescriptor.resources.memoryBytes *= 2;
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
  assert.equal(result.outputs.length, 2);
  const binary = result.outputs.find((output) => output.metadata.path === 'result.bin');
  const structured = result.outputs.find((output) => output.metadata.path === 'result.json');
  assert.equal(structured.metadata.declaredRole, 'structured_result');
  assert.equal(binary.bytes.toString('utf8'), 'arbitrary cold project output\n');
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
  assert.equal(cliResult.evidence.schemaVersion, ARBITRARY_COLD_PROJECT_RUN_SCHEMA);
  assert.equal(cliResult.evidence.acceptedForGpuHmr, false);
  assert.equal(cliResult.evidence.gpuHmrSuccess, false);
  assert.equal(cliResult.outputs.length, descriptor.outputs.length);
  assert.ok(!JSON.stringify(cliResult.evidence).match(
    /miopen|hiprt|flow|diamond|neural|blas|cuda|rocm|project_name|fixture_name/i,
  ));

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
