import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
  COLD_BUILD_LAUNCHER_SOURCE_ROOT,
  COLD_BUILD_OUTPUT_MANIFEST_MODE_LAUNCHER_GENERATED,
  materializeColdBuildLauncher,
  runColdBuildHostProcess,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';
import {
  COLD_BUILD_EXECUTION_DRIVER_AUTHORITY,
  COLD_BUILD_EXECUTION_DRIVER_SCHEMA,
  COLD_BUILD_READY_REFUSAL_EVIDENCE_AUTHORITY,
  COLD_BUILD_READY_REFUSAL_EVIDENCE_SCHEMA,
  executeColdBuildLauncherPlan,
  verifyColdBuildReadyRefusalEvidence,
  verifyColdBuildExecutionDriverResult,
} from '../lib/gpu-hmr-cold-build-execution-driver.mjs';
import { createColdBuildLauncherExecutionPlan } from '../lib/gpu-hmr-cold-build-execution-plan.mjs';
import {
  COLD_BUILD_OUTPUT_EVIDENCE_AUTHORITY,
  COLD_BUILD_OUTPUT_EVIDENCE_SCHEMA,
  deriveColdBuildOutputEvidence,
  verifyColdBuildOutputEvidence,
} from '../lib/gpu-hmr-cold-build-output-evidence.mjs';
import { computeColdBuildSourceTreeBinding } from '../lib/gpu-hmr-cold-build-source-tree-binding.mjs';

const dockerExecutable = process.env.SYNTHI_GPU_HMR_DOCKER_EXECUTABLE || 'docker';

function contentHash(value) {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), 'utf8');
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => (
      `${JSON.stringify(key)}:${stableJson(value[key])}`
    )).join(',')}}`;
  }
  return JSON.stringify(value);
}

async function workerImageDescriptor() {
  const result = await runColdBuildHostProcess(dockerExecutable, [
    'image',
    'inspect',
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  ], {
    timeoutMs: 30_000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 32 * 1024,
    encoding: 'utf8',
  });
  assert.equal(result.exitCode, 0, result.stderr || result.error);
  const [descriptor] = JSON.parse(result.stdout);
  assert.equal(descriptor?.Os, 'linux');
  assert.ok(['amd64', 'arm64'].includes(descriptor?.Architecture));
  assert.match(descriptor?.Id ?? '', /^sha256:[a-f0-9]{64}$/);
  return descriptor;
}

async function createPlanFixture({ root, launcherIdentity, workerImage, valid }) {
  const sourceHostPath = path.join(root, 'opaque source, with spaces Ω');
  const releaseHostPath = path.join(root, 'opaque release channel');
  const specHostDirectory = path.join(root, 'private specs');
  await Promise.all([
    mkdir(sourceHostPath, { recursive: true }),
    mkdir(releaseHostPath, { recursive: true }),
    mkdir(specHostDirectory, { recursive: true }),
  ]);
  await chmod(specHostDirectory, 0o700);

  const artifactBytes = Buffer.from('opaque project-neutral build bytes\n', 'utf8');
  const commandSpecHash = contentHash(`opaque-command:${randomBytes(16).toString('hex')}`);
  const script = valid
    ? [
      '#!/bin/sh',
      'set -eu',
      `printf 'opaque project-neutral build bytes\\n' > '${COLD_BUILD_LAUNCHER_OUTPUT_ROOT}/opaque-output.bin'`,
      '',
    ].join('\n')
    : [
      '#!/bin/sh',
      'set -eu',
      'exit 9',
      '',
    ].join('\n');
  const scriptPath = path.join(sourceHostPath, 'opaque-build.sh');
  await writeFile(scriptPath, script, { encoding: 'utf8', mode: 0o755 });
  await chmod(scriptPath, 0o755);
  await writeFile(path.join(sourceHostPath, 'input.data'), 'arbitrary input bytes\n', 'utf8');

  const sourceTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
    sourceHostPath,
    { maxEntryCount: 4096, maxByteLength: 64 * 1024 * 1024 },
  );
  const releaseTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
    releaseHostPath,
    { maxEntryCount: 16, maxByteLength: 1024 * 1024 },
  );
  const plan = createColdBuildLauncherExecutionPlan({
    launcherIdentity,
    executionNonce: randomBytes(16).toString('hex'),
    commandSpecHash,
    sourceTreeBindingEvidence,
    releaseTreeBindingEvidence,
    command: '/bin/sh',
    args: [`${COLD_BUILD_LAUNCHER_SOURCE_ROOT}/opaque-build.sh`],
    environment: {
      HOME: '/tmp/synthi-home',
      PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
      SYNTHI_COLD_BUILD_OUTPUT_ROOT: COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
      SYNTHI_COLD_BUILD_SOURCE_ROOT: COLD_BUILD_LAUNCHER_SOURCE_ROOT,
      TMPDIR: '/tmp',
    },
    workingDirectory: COLD_BUILD_LAUNCHER_SOURCE_ROOT,
    commandTimeoutMillis: 15_000,
    releaseTimeoutMillis: 15_000,
    workspaceByteLimit: 64 * 1024 * 1024,
    workspaceEntryLimit: 4096,
    collectedByteLimit: 4 * 1024 * 1024,
    collectedEntryLimit: 4,
    outputManifestMode: COLD_BUILD_OUTPUT_MANIFEST_MODE_LAUNCHER_GENERATED,
    declaredOutputs: [{
      path: 'opaque-output.bin',
      role: 'generic_build_artifact',
      artifactKind: 'opaque_build_output',
      mediaType: 'application/octet-stream',
    }],
    containerName: `synthi-cold-driver-${randomBytes(8).toString('hex')}`,
    workerImageId: workerImage.Id,
    workerImageEnvironment: workerImage.Config?.Env ?? [],
    workerImageOperatingSystem: workerImage.Os,
    workerImageArchitecture: workerImage.Architecture,
    containerRuntime: 'runc',
    sourceHostPath,
    releaseHostPath,
    specHostDirectory,
    memoryBytes: 1024 * 1024 * 1024,
    memorySwapBytes: 1024 * 1024 * 1024,
    nanoCpus: 1_000_000_000,
    pidsLimit: 256,
    nofileLimit: 1024,
  });
  return {
    artifactBytes,
    plan,
    sourceHostPath,
  };
}

async function assertContainerAbsent(reference) {
  const result = await runColdBuildHostProcess(
    dockerExecutable,
    ['inspect', reference],
    {
      timeoutMs: 10_000,
      maxStdoutBytes: 4096,
      maxStderrBytes: 32 * 1024,
      encoding: 'utf8',
    },
  );
  assert.notEqual(result.exitCode, 0, `container still exists: ${reference}`);
}

async function main() {
  const workerImage = await workerImageDescriptor();
  const launcherIdentity = await materializeColdBuildLauncher({
    dockerExecutable,
    architecture: workerImage.Architecture,
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-cold-driver-'));
  try {
    const acceptedFixture = await createPlanFixture({
      root: path.join(root, 'accepted'),
      launcherIdentity,
      workerImage,
      valid: true,
    });
    const accepted = await executeColdBuildLauncherPlan(acceptedFixture.plan, {
      dockerExecutable,
      maxReceiptBytes: 1024 * 1024,
      maxDiagnosticBytes: 1024 * 1024,
      readyTimeoutMs: 30_000,
      controlTimeoutMs: 30_000,
    });
    assert.equal(
      verifyColdBuildExecutionDriverResult(accepted, acceptedFixture.plan),
      accepted,
    );
    const outputEvidence = deriveColdBuildOutputEvidence(
      accepted,
      acceptedFixture.plan,
    );
    assert.equal(
      verifyColdBuildOutputEvidence(outputEvidence, accepted, acceptedFixture.plan),
      outputEvidence,
    );
    assert.equal(outputEvidence.evidence.schemaVersion, COLD_BUILD_OUTPUT_EVIDENCE_SCHEMA);
    assert.equal(outputEvidence.evidence.proofAuthority, COLD_BUILD_OUTPUT_EVIDENCE_AUTHORITY);
    assert.equal(outputEvidence.evidence.acceptedAsColdBuildOutputEvidence, true);
    assert.equal(outputEvidence.evidence.acceptedForGpuHmr, false);
    assert.equal(outputEvidence.evidence.gpuHmrSuccess, false);
    assert.equal(outputEvidence.evidence.declarationMetadataAuthority,
      'advisory_only_not_output_acceptance');
    assert.equal(outputEvidence.outputs.length, 1);
    assert.ok(outputEvidence.outputs[0].bytes.equals(acceptedFixture.artifactBytes));
    const clonedOutputEvidence = structuredClone(outputEvidence);
    assert.throws(
      () => verifyColdBuildOutputEvidence(
        clonedOutputEvidence,
        accepted,
        acceptedFixture.plan,
      ),
      /output_evidence_result_invalid/,
    );
    const clonedResult = structuredClone(accepted);
    assert.throws(
      () => verifyColdBuildExecutionDriverResult(clonedResult, acceptedFixture.plan),
      /driver_result_invalid/,
    );
    assert.equal(accepted.evidence.schemaVersion, COLD_BUILD_EXECUTION_DRIVER_SCHEMA);
    assert.equal(accepted.evidence.proofAuthority, COLD_BUILD_EXECUTION_DRIVER_AUTHORITY);
    assert.equal(accepted.evidence.protocolAccepted, true);
    assert.equal(accepted.evidence.acceptedAsColdBuildExecutionEvidence, true);
    assert.equal(accepted.evidence.acceptedForGpuHmr, false);
    assert.equal(accepted.evidence.gpuHmrSuccess, false);
    assert.equal(accepted.evidence.canSatisfyRuntimeProof, false);
    assert.equal(accepted.evidence.canSatisfyDispatchProof, false);
    assert.equal(accepted.evidence.cleanup.acceptedAsCleanupEvidence, true);
    assert.equal(accepted.evidence.cleanup.absenceProven, true);
    const evidenceProjection = { ...accepted.evidence };
    delete evidenceProjection.evidenceHash;
    assert.equal(accepted.evidence.evidenceHash, contentHash(stableJson(evidenceProjection)));
    assert.equal(accepted.payloads.length, 2);
    const artifactPayload = accepted.payloads.find(
      ({ entry }) => entry.path === 'opaque-output.bin',
    );
    assert.ok(artifactPayload);
    assert.ok(artifactPayload.bytes.equals(acceptedFixture.artifactBytes));
    const artifactManifestEntry = accepted.evidence.payloadManifest.find(
      (entry) => entry.path === 'opaque-output.bin',
    );
    assert.ok(artifactManifestEntry);
    assert.equal(
      artifactManifestEntry.contentHash,
      contentHash(acceptedFixture.artifactBytes),
    );
    assert.equal(
      await readFile(path.join(acceptedFixture.sourceHostPath, 'input.data'), 'utf8'),
      'arbitrary input bytes\n',
    );
    assert.ok(!JSON.stringify(accepted.evidence).match(
      /miopen|hiprt|flow|diamond|neural|blas|fixture_name|project_name/i,
    ));
    const originalAcceptedForGpuHmr = accepted.evidence.acceptedForGpuHmr;
    accepted.evidence.acceptedForGpuHmr = true;
    assert.throws(
      () => verifyColdBuildExecutionDriverResult(accepted, acceptedFixture.plan),
      /driver_result_invalid/,
    );
    accepted.evidence.acceptedForGpuHmr = originalAcceptedForGpuHmr;
    const originalPayloadByte = artifactPayload.bytes[0];
    artifactPayload.bytes[0] ^= 1;
    assert.throws(
      () => verifyColdBuildExecutionDriverResult(accepted, acceptedFixture.plan),
      /driver_result_invalid/,
    );
    artifactPayload.bytes[0] = originalPayloadByte;
    assert.equal(
      verifyColdBuildExecutionDriverResult(accepted, acceptedFixture.plan),
      accepted,
    );
    outputEvidence.evidence.acceptedForGpuHmr = true;
    assert.throws(
      () => verifyColdBuildOutputEvidence(
        outputEvidence,
        accepted,
        acceptedFixture.plan,
      ),
      /output_evidence_result_invalid/,
    );
    outputEvidence.evidence.acceptedForGpuHmr = false;
    assert.equal(
      verifyColdBuildOutputEvidence(outputEvidence, accepted, acceptedFixture.plan),
      outputEvidence,
    );
    await assertContainerAbsent(acceptedFixture.plan.containerName);

    const refusedFixture = await createPlanFixture({
      root: path.join(root, 'refused'),
      launcherIdentity,
      workerImage,
      valid: false,
    });
    let refusedError = null;
    try {
      await executeColdBuildLauncherPlan(refusedFixture.plan, {
        dockerExecutable,
        maxReceiptBytes: 1024 * 1024,
        maxDiagnosticBytes: 1024 * 1024,
        readyTimeoutMs: 30_000,
        controlTimeoutMs: 30_000,
      });
    } catch (error) {
      refusedError = error;
    }
    assert.ok(refusedError instanceof Error);
    assert.match(refusedError.message, /ready_receipt_refused|exited_before_ready/);
    const refusal = refusedError.readyRefusalEvidence;
    assert.equal(refusal.schemaVersion, COLD_BUILD_READY_REFUSAL_EVIDENCE_SCHEMA);
    assert.equal(refusal.proofAuthority, COLD_BUILD_READY_REFUSAL_EVIDENCE_AUTHORITY);
    assert.equal(
      verifyColdBuildReadyRefusalEvidence(refusal, refusedFixture.plan),
      refusal,
    );
    assert.equal(refusal.childExitCode, 9);
    assert.equal(refusal.commandTimedOut, false);
    assert.equal(refusal.protocolAccepted, false);
    assert.equal(refusal.outputSnapshotAccepted, false);
    assert.ok(refusal.blockingGaps.includes('output_snapshot_invalid'));
    assert.match(refusal.commandStdoutHash, /^sha256:[a-f0-9]{64}$/);
    assert.match(refusal.commandStderrHash, /^sha256:[a-f0-9]{64}$/);
    assert.equal(refusal.acceptedAsColdBuildRefusalEvidence, true);
    assert.equal(refusal.acceptedAsColdBuildEvidence, false);
    assert.equal(refusal.acceptedForGpuHmr, false);
    assert.equal(refusal.gpuHmrSuccess, false);
    refusal.gpuHmrSuccess = true;
    assert.throws(
      () => verifyColdBuildReadyRefusalEvidence(refusal, refusedFixture.plan),
      /ready_refusal_evidence_invalid/,
    );
    refusal.gpuHmrSuccess = false;
    assert.equal(
      verifyColdBuildReadyRefusalEvidence(refusal, refusedFixture.plan),
      refusal,
    );
    assert.equal(refusedError.cleanupEvidence?.absenceProven, true);
    assert.equal(refusedError.cleanupEvidence?.acceptedForGpuHmr, false);
    assert.equal(refusedError.cleanupEvidence?.gpuHmrSuccess, false);
    await assertContainerAbsent(refusedFixture.plan.containerName);

    console.log(JSON.stringify({
      status: 'self_check_passed',
      schemaVersion: accepted.evidence.schemaVersion,
      executionEvidenceHash: accepted.evidence.evidenceHash,
      collectorFrameHash: accepted.evidence.collectorFrameHash,
      finalReceiptHash: accepted.evidence.finalReceiptHash,
      payloadCount: accepted.payloads.length,
      cleanupAbsenceProven: accepted.evidence.cleanup.absenceProven,
      malformedBuildRefused: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    }, null, 2));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
