import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  COLD_BUILD_LAUNCHER_CONTAINER_PATH,
  COLD_BUILD_LAUNCHER_INPUT_ROOT,
  COLD_BUILD_LAUNCHER_RELEASE_ROOT,
  COLD_BUILD_LAUNCHER_SOURCE_ROOT,
  COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH,
  COLD_BUILD_LAUNCHER_OUTPUT_ROOT,
  COLD_BUILD_OUTPUT_MANIFEST_MODE_LAUNCHER_GENERATED,
  materializeColdBuildLauncher,
  runColdBuildHostProcess,
} from '../lib/gpu-hmr-cold-build-container-contract.mjs';
import {
  COLD_BUILD_CONTAINER_INSPECTION_AUTHORITY,
  COLD_BUILD_CONTAINER_INSPECTION_SCHEMA,
  COLD_BUILD_EXECUTION_PLAN_AUTHORITY,
  COLD_BUILD_EXECUTION_PLAN_RECEIPT_AUTHORITY,
  COLD_BUILD_EXECUTION_PLAN_RECEIPT_SCHEMA,
  COLD_BUILD_EXECUTION_PLAN_SCHEMA,
  coldBuildLauncherCollectorExecArgs,
  createColdBuildExecutionPlanReceipt,
  createColdBuildLauncherExecutionPlan,
  publishColdBuildLauncherSpec,
  verifyColdBuildExecutionPlanReceipt,
  verifyColdBuildLauncherContainerInspection,
  verifyColdBuildLauncherExecutionInputs,
} from '../lib/gpu-hmr-cold-build-execution-plan.mjs';
import { computeColdBuildSourceTreeBinding } from '../lib/gpu-hmr-cold-build-source-tree-binding.mjs';

const dockerExecutable = process.env.SYNTHI_GPU_HMR_DOCKER_EXECUTABLE || 'docker';
const SYNTHETIC_CONTAINER_ID = 'a'.repeat(64);

async function workerImageDescriptor() {
  const inspected = await runColdBuildHostProcess(dockerExecutable, [
    'image',
    'inspect',
    COLD_BUILD_LAUNCHER_BUILDER_IMAGE,
  ], {
    timeoutMs: 30_000,
    maxStdoutBytes: 2 * 1024 * 1024,
    maxStderrBytes: 4096,
    encoding: 'utf8',
  });
  assert.equal(inspected.exitCode, 0, inspected.stderr || inspected.error);
  const [descriptor] = JSON.parse(inspected.stdout);
  assert.equal(descriptor?.Os, 'linux');
  assert.ok(['amd64', 'arm64'].includes(descriptor?.Architecture));
  assert.match(descriptor?.Id ?? '', /^sha256:[a-f0-9]{64}$/);
  return descriptor;
}

function syntheticInspect(plan) {
  const expected = plan.expectedContainerConfiguration;
  return {
    Id: SYNTHETIC_CONTAINER_ID,
    Name: `/${plan.containerName}`,
    Image: expected.imageId,
    Config: {
      Image: expected.imageId,
      Entrypoint: [...expected.entrypoint],
      Cmd: [...expected.command],
      User: expected.user,
      WorkingDir: expected.workingDirectory,
      Labels: {
        unrelated_image_label: 'ignored',
        ...expected.labels,
      },
      Volumes: null,
      Healthcheck: { Test: ['NONE'] },
      Env: [...expected.containerEnvironment],
      OpenStdin: false,
      StdinOnce: false,
      Tty: false,
    },
    HostConfig: {
      NetworkMode: expected.networkMode,
      ReadonlyRootfs: expected.readOnlyRootfs,
      Privileged: expected.privileged,
      CapDrop: [...expected.capDrop].reverse(),
      CapAdd: [...expected.capAdd].reverse(),
      SecurityOpt: [...expected.securityOpt],
      IpcMode: expected.ipcMode,
      PidsLimit: expected.pidsLimit,
      Memory: expected.memoryBytes,
      MemorySwap: expected.memorySwapBytes,
      NanoCpus: expected.nanoCpus,
      Ulimits: expected.ulimits.map((entry) => ({
        Name: entry.name,
        Soft: entry.soft,
        Hard: entry.hard,
      })).reverse(),
      Tmpfs: Object.fromEntries(Object.entries(expected.tmpfs).map(([target, options]) => [
        target,
        [...options].reverse().join(','),
      ])),
      AutoRemove: false,
      UsernsMode: '',
      PidMode: expected.pidMode,
      UTSMode: expected.utsMode,
      CgroupnsMode: expected.cgroupnsMode,
      Runtime: expected.runtime,
      GroupAdd: [],
      DeviceCgroupRules: [],
      Dns: [],
      DnsOptions: [],
      DnsSearch: [],
      ExtraHosts: [],
      Links: [],
      VolumesFrom: [],
      Sysctls: {},
      PortBindings: {},
      PublishAllPorts: false,
      CgroupParent: '',
      Isolation: '',
      Devices: [],
      DeviceRequests: [],
      RestartPolicy: { Name: 'no' },
    },
    Mounts: expected.mounts.map((mount) => ({
      Type: mount.type,
      Source: {
        [COLD_BUILD_LAUNCHER_SOURCE_ROOT]: plan.sourceHostPath,
        [COLD_BUILD_LAUNCHER_RELEASE_ROOT]: plan.releaseHostPath,
        [COLD_BUILD_LAUNCHER_SPEC_CONTAINER_PATH]: plan.specHostPath,
        [COLD_BUILD_LAUNCHER_CONTAINER_PATH]: plan.launcherHostPath,
      }[mount.destination] ?? plan.readOnlyInputTrees.find(
        (input) => input.containerPath === mount.destination,
      )?.hostPath,
      Destination: mount.destination,
      RW: mount.readWrite,
      Propagation: mount.propagation,
    })),
  };
}

function assertRefused(plan, inputEvidenceBeforeCreate, inputEvidenceAfterCreate, mutate, expectedGap) {
  const inspect = structuredClone(syntheticInspect(plan));
  mutate(inspect);
  const evidence = verifyColdBuildLauncherContainerInspection([inspect], plan, {
    expectedContainerId: SYNTHETIC_CONTAINER_ID,
    inputEvidenceBeforeCreate,
    inputEvidenceAfterCreate,
  });
  assert.equal(evidence.configurationMatchesPlan, false);
  assert.equal(evidence.acceptedAsContainerInspectionEvidence, false);
  assert.ok(evidence.blockingGaps.includes(expectedGap), JSON.stringify(evidence));
  assert.equal(evidence.acceptedForGpuHmr, false);
  assert.equal(evidence.gpuHmrSuccess, false);
}

async function main() {
  const workerImage = await workerImageDescriptor();
  const launcherIdentity = await materializeColdBuildLauncher({
    dockerExecutable,
    architecture: workerImage.Architecture,
  });
  const root = await mkdtemp(path.join(os.tmpdir(), 'synthi-cold-plan-'));
  let liveContainerId = null;
  try {
    const sourceHostPath = path.join(root, 'arbitrary source, with spaces \u03a9');
    const releaseHostPath = path.join(root, 'release, channel');
    const specHostDirectory = path.join(root, 'specs');
    const readOnlyInputHostPath = path.join(root, 'dependency tree, with spaces');
    const readOnlyInputFilePath = path.join(readOnlyInputHostPath, 'include', 'opaque.hpp');
    const nestedSourceDirectory = path.join(sourceHostPath, 'module tree');
    const nestedSourcePath = path.join(nestedSourceDirectory, 'source unit.ext');
    await Promise.all([
      mkdir(nestedSourceDirectory, { recursive: true }),
      mkdir(releaseHostPath, { recursive: true }),
      mkdir(specHostDirectory, { recursive: true }),
      mkdir(path.dirname(readOnlyInputFilePath), { recursive: true }),
    ]);
    await chmod(specHostDirectory, 0o700);
    await writeFile(nestedSourcePath, 'initial source bytes\n', 'utf8');
    await writeFile(readOnlyInputFilePath, 'initial dependency bytes\n', 'utf8');
    const sourceTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
      sourceHostPath,
      {
        maxEntryCount: 250_000,
        maxByteLength: 4 * 1024 * 1024 * 1024,
      },
    );
    const releaseTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
      releaseHostPath,
      {
        maxEntryCount: 64,
        maxByteLength: 1024 * 1024,
      },
    );
    const readOnlyInputTreeBindingEvidence = await computeColdBuildSourceTreeBinding(
      readOnlyInputHostPath,
      {
        maxEntryCount: 4096,
        maxByteLength: 64 * 1024 * 1024,
      },
    );
    const common = {
      launcherIdentity,
      executionNonce: randomBytes(16).toString('hex'),
      commandSpecHash: `sha256:${'1'.repeat(64)}`,
      sourceTreeBindingEvidence,
      readOnlyInputTrees: [{
        hostPath: readOnlyInputHostPath,
        mountPath: 'dependency tree/headers',
        sourceTreeBindingEvidence: readOnlyInputTreeBindingEvidence,
      }],
      releaseTreeBindingEvidence,
      command: '/toolchain/driver',
      args: ['--input', 'module tree/source unit.ext', '--emit', '/workspace/build'],
      environment: {
        BUILD_MODE: 'cold',
        PATH: '/usr/local/bin:/usr/bin:/bin',
      },
      workingDirectory: '/workspace/source/module tree',
      commandTimeoutMillis: 120_000,
      workspaceByteLimit: 4 * 1024 * 1024 * 1024,
      workspaceEntryLimit: 250_000,
      collectedByteLimit: 512 * 1024 * 1024,
      collectedEntryLimit: 4096,
      outputManifestMode: COLD_BUILD_OUTPUT_MANIFEST_MODE_LAUNCHER_GENERATED,
      declaredOutputs: [
        {
          path: 'nested/z-output.bin',
          role: 'opaque_secondary_output',
          artifactKind: 'opaque_build_output',
          mediaType: 'application/octet-stream',
        },
        {
          path: 'a-output.bin',
          role: 'opaque_primary_output',
          artifactKind: 'opaque_build_output',
          mediaType: 'application/octet-stream',
        },
      ],
      containerName: `synthi-cold-${randomBytes(8).toString('hex')}`,
      workerImageId: workerImage.Id,
      workerImageEnvironment: workerImage.Config?.Env ?? [],
      workerImageOperatingSystem: workerImage.Os,
      workerImageArchitecture: workerImage.Architecture,
      containerRuntime: 'runc',
      sourceHostPath,
      releaseHostPath,
      specHostDirectory,
      memoryBytes: 8 * 1024 * 1024 * 1024,
      memorySwapBytes: 8 * 1024 * 1024 * 1024,
      nanoCpus: 6_500_000_000,
      pidsLimit: 2048,
      nofileLimit: 8192,
    };
    const plan = createColdBuildLauncherExecutionPlan(common);
    const specHostPath = plan.specHostPath;
    const specPublication = await publishColdBuildLauncherSpec(plan);
    assert.equal(specPublication.published, true);
    assert.equal(specPublication.contentAddressedName, path.basename(specHostPath));
    specPublication.acceptedForGpuHmr = true;
    await assert.rejects(
      () => verifyColdBuildLauncherExecutionInputs(plan, { phase: 'before_create' }),
      /spec_publication_evidence_invalid/,
    );
    specPublication.acceptedForGpuHmr = false;
    const syntheticInputsBefore = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'before_create',
    });
    const syntheticInputsAfter = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_create',
      expectedContainerId: SYNTHETIC_CONTAINER_ID,
    });
    await assert.rejects(
      () => verifyColdBuildLauncherExecutionInputs(plan),
      /execution_input_phase_invalid/,
    );
    await assert.rejects(
      () => verifyColdBuildLauncherExecutionInputs(plan, {
        phase: 'before_create',
        expectedContainerId: SYNTHETIC_CONTAINER_ID,
      }),
      /container_id_unexpected/,
    );
    await assert.rejects(
      () => verifyColdBuildLauncherExecutionInputs(plan, {
        phase: 'after_create',
        expectedContainerId: 'short',
      }),
      /container_id_invalid/,
    );
    assert.equal(plan.schemaVersion, COLD_BUILD_EXECUTION_PLAN_SCHEMA);
    assert.equal(plan.proofAuthority, COLD_BUILD_EXECUTION_PLAN_AUTHORITY);
    assert.equal(plan.planValid, true);
    assert.equal(plan.acceptedForGpuHmr, false);
    assert.equal(plan.gpuHmrSuccess, false);
    assert.equal(plan.canSatisfyRuntimeProof, false);
    assert.equal(plan.canSatisfyDispatchProof, false);
    assert.equal(plan.readyReceiptRequired, true);
    assert.equal(plan.canAuthorizeLauncherExecution, false);
    assert.equal(plan.inputSetBindings.length, 2);
    assert.match(plan.inputSetHash, /^sha256:[0-9a-f]{64}$/);
    assert.equal(plan.launcherExecutableHash, launcherIdentity.binaryHash);
    assert.equal(plan.releaseBindingHash, releaseTreeBindingEvidence.sourceBindingHash);
    assert.equal(plan.readOnlyInputTrees.length, 1);
    assert.equal(
      plan.readOnlyInputTrees[0].containerPath,
      `${COLD_BUILD_LAUNCHER_INPUT_ROOT}/dependency tree/headers`,
    );
    assert.equal(
      plan.readOnlyInputTrees[0].sourceBindingHash,
      readOnlyInputTreeBindingEvidence.sourceBindingHash,
    );
    assert.equal(plan.spec.expectedLauncherExecutableHash, launcherIdentity.binaryHash);
    assert.equal(plan.spec.command[0], common.command);
    assert.equal(
      plan.spec.outputManifestMode,
      COLD_BUILD_OUTPUT_MANIFEST_MODE_LAUNCHER_GENERATED,
    );
    assert.deepEqual(
      plan.spec.declaredOutputs.map(({ path: outputPath }) => outputPath),
      ['a-output.bin', 'nested/z-output.bin'],
    );
    assert.deepEqual(plan.spec.environment, [
      'BUILD_MODE=cold',
      'PATH=/usr/local/bin:/usr/bin:/bin',
    ]);
    assert.ok(plan.containerCreateArgs.some(
      (value) => value.includes(launcherIdentity.executablePath),
    ));
    assert.ok(plan.containerCreateArgs.some((value) => value.includes('arbitrary source, with spaces')));
    assert.ok(plan.containerCreateArgs.some((value) => value.includes('readonly')));
    assert.ok(plan.expectedContainerConfiguration.tmpfs['/tmp'].includes('exec'));
    assert.ok(
      plan.expectedContainerConfiguration.tmpfs[COLD_BUILD_LAUNCHER_OUTPUT_ROOT]
        .includes('exec'),
    );
    assert.ok(
      plan.expectedContainerConfiguration.tmpfs['/synthi-control'].includes('noexec'),
    );
    assert.ok(!JSON.stringify(plan).match(/hiprt|rocm|flow|miopen|blas|neural|diamond/i));

    const planReceipt = createColdBuildExecutionPlanReceipt(plan);
    const retainedPlanReceipt = JSON.parse(JSON.stringify(planReceipt));
    assert.equal(planReceipt.schemaVersion, COLD_BUILD_EXECUTION_PLAN_RECEIPT_SCHEMA);
    assert.equal(planReceipt.proofAuthority, COLD_BUILD_EXECUTION_PLAN_RECEIPT_AUTHORITY);
    assert.equal(planReceipt.planHash, plan.planHash);
    assert.equal(planReceipt.planProjection.inputSetHash, plan.inputSetHash);
    assert.equal(planReceipt.acceptedAsColdBuildExecutionPlanReceipt, true);
    assert.equal(planReceipt.acceptedForGpuHmr, false);
    assert.equal(planReceipt.gpuHmrSuccess, false);
    assert.equal(planReceipt.canSatisfyRuntimeProof, false);
    assert.equal(planReceipt.canSatisfyDispatchProof, false);
    assert.equal(
      verifyColdBuildExecutionPlanReceipt(retainedPlanReceipt),
      retainedPlanReceipt,
    );
    const forgedPlanReceipt = structuredClone(retainedPlanReceipt);
    forgedPlanReceipt.planProjection.inputSetHash = `sha256:${'0'.repeat(64)}`;
    assert.throws(
      () => verifyColdBuildExecutionPlanReceipt(forgedPlanReceipt),
      /execution_plan_receipt_invalid/,
    );
    const authorityClaimingPlanReceipt = structuredClone(retainedPlanReceipt);
    authorityClaimingPlanReceipt.planProjection.gpuHmrSuccess = true;
    assert.throws(
      () => verifyColdBuildExecutionPlanReceipt(authorityClaimingPlanReceipt),
      /execution_plan_receipt_invalid/,
    );
    assert.ok(!JSON.stringify(planReceipt).match(
      /hiprt|rocm|flow|miopen|blas|neural|diamond|project_name|fixture_name/i,
    ));

    const deterministicPlan = createColdBuildLauncherExecutionPlan(common);
    assert.equal(deterministicPlan.planHash, plan.planHash);
    assert.equal(deterministicPlan.specHash, plan.specHash);
    assert.equal(deterministicPlan.containerCreateArgsHash, plan.containerCreateArgsHash);
    await assert.rejects(
      () => publishColdBuildLauncherSpec(deterministicPlan),
      /spec_content_address_collision/,
    );
    const postCollisionInputs = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'before_create',
    });
    assert.equal(postCollisionInputs.acceptedAsExecutionInputEvidence, true);

    const evidence = verifyColdBuildLauncherContainerInspection(
      [syntheticInspect(plan)],
      plan,
      {
        expectedContainerId: SYNTHETIC_CONTAINER_ID,
        inputEvidenceBeforeCreate: syntheticInputsBefore,
        inputEvidenceAfterCreate: syntheticInputsAfter,
      },
    );
    assert.equal(evidence.schemaVersion, COLD_BUILD_CONTAINER_INSPECTION_SCHEMA);
    assert.equal(evidence.proofAuthority, COLD_BUILD_CONTAINER_INSPECTION_AUTHORITY);
    assert.equal(evidence.configurationMatchesPlan, true, JSON.stringify(evidence));
    assert.equal(evidence.acceptedAsContainerInspectionEvidence, true);
    assert.deepEqual(evidence.blockingGaps, []);
    assert.equal(evidence.planHash, plan.planHash);
    assert.equal(evidence.inputSetHash, plan.inputSetHash);
    assert.equal(evidence.acceptedForGpuHmr, false);
    assert.equal(evidence.gpuHmrSuccess, false);
    assert.equal(evidence.canSatisfyRuntimeProof, false);
    assert.equal(evidence.canSatisfyDispatchProof, false);
    assert.equal(evidence.readyReceiptRequired, true);
    assert.equal(evidence.canAuthorizeLauncherExecution, false);
    const inputSetHash = plan.inputSetHash;
    plan.inputSetHash = `sha256:${'0'.repeat(64)}`;
    await assert.rejects(
      () => verifyColdBuildLauncherExecutionInputs(plan, { phase: 'before_create' }),
      /execution_plan_identity_invalid/,
    );
    plan.inputSetHash = inputSetHash;
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: syntheticInputsBefore,
        },
      ),
      /input_observation_reused/,
    );
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsAfter,
          inputEvidenceAfterCreate: syntheticInputsBefore,
        },
      ),
      /input_evidence_invalid/,
    );

    const liveInputsBefore = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'before_create',
    });
    const created = await runColdBuildHostProcess(
      dockerExecutable,
      plan.containerCreateArgs,
      {
        timeoutMs: 30_000,
        maxStdoutBytes: 4096,
        maxStderrBytes: 32 * 1024,
        encoding: 'utf8',
      },
    );
    assert.equal(created.exitCode, 0, created.stderr || created.error);
    liveContainerId = created.stdout.trim();
    assert.match(liveContainerId, /^[a-f0-9]{12,64}$/);
    const liveInspected = await runColdBuildHostProcess(
      dockerExecutable,
      ['inspect', liveContainerId],
      {
        timeoutMs: 30_000,
        maxStdoutBytes: 2 * 1024 * 1024,
        maxStderrBytes: 32 * 1024,
        encoding: 'utf8',
      },
    );
    assert.equal(liveInspected.exitCode, 0, liveInspected.stderr || liveInspected.error);
    const liveInputsAfter = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_create',
      expectedContainerId: liveContainerId,
    });
    const liveInspectionEvidence = verifyColdBuildLauncherContainerInspection(
      JSON.parse(liveInspected.stdout),
      plan,
      {
        expectedContainerId: liveContainerId,
        inputEvidenceBeforeCreate: liveInputsBefore,
        inputEvidenceAfterCreate: liveInputsAfter,
      },
    );
    const collectorExecArgs = coldBuildLauncherCollectorExecArgs(plan, liveContainerId);
    assert.equal(collectorExecArgs[3], liveContainerId);
    assert.equal(
      liveInspectionEvidence.configurationMatchesPlan,
      true,
      JSON.stringify(liveInspectionEvidence),
    );

    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.NetworkMode = 'bridge';
    }, 'cold_build_container_network_mode_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.Privileged = true;
    }, 'cold_build_container_privileged_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.PidMode = 'host';
    }, 'cold_build_container_pid_mode_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.DeviceRequests = [{ Driver: 'arbitrary' }];
    }, 'cold_build_container_device_request_count_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Config.Entrypoint = ['/bin/sh'];
    }, 'cold_build_container_entrypoint_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Config.Labels['synthi.cold_build.spec_hash'] = `sha256:${'4'.repeat(64)}`;
    }, 'cold_build_container_labels_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Mounts.find((mount) => mount.Destination === '/workspace/source').RW = true;
    }, 'cold_build_container_mounts_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Mounts.find(
        (mount) => mount.Destination === plan.readOnlyInputTrees[0].containerPath,
      ).RW = true;
    }, 'cold_build_container_mounts_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Mounts.find(
        (mount) => mount.Destination === COLD_BUILD_LAUNCHER_CONTAINER_PATH,
      ).Source = path.join(root, 'replayed-launcher');
    }, 'cold_build_container_mounts_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.Memory -= 1;
    }, 'cold_build_container_memory_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.Tmpfs['/synthi-control'] = 'rw';
    }, 'cold_build_container_tmpfs_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.Tmpfs[COLD_BUILD_LAUNCHER_OUTPUT_ROOT] = inspect.HostConfig.Tmpfs[
        COLD_BUILD_LAUNCHER_OUTPUT_ROOT
      ].replace('exec', 'noexec');
    }, 'cold_build_container_tmpfs_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Id = 'b'.repeat(64);
    }, 'cold_build_container_id_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Name = '/replayed-container';
    }, 'cold_build_container_name_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.Config.Env = [...inspect.Config.Env, 'REPLAYED=true'];
    }, 'cold_build_container_environment_mismatch');
    assertRefused(plan, syntheticInputsBefore, syntheticInputsAfter, (inspect) => {
      inspect.HostConfig.GroupAdd = ['0'];
    }, 'cold_build_container_group_add_mismatch');
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan), syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: syntheticInputsAfter,
        },
      ),
      /inspection_cardinality_invalid/,
    );
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: { ...syntheticInputsBefore },
          inputEvidenceAfterCreate: syntheticInputsAfter,
        },
      ),
      /input_evidence_invalid/,
    );
    const originalInputMetadataHash = syntheticInputsBefore.inputs.spec.metadataHash;
    syntheticInputsBefore.inputs.spec.metadataHash = `sha256:${'6'.repeat(64)}`;
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: syntheticInputsAfter,
        },
      ),
      /input_evidence_invalid/,
    );
    syntheticInputsBefore.inputs.spec.metadataHash = originalInputMetadataHash;

    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        { ...plan },
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: syntheticInputsAfter,
        },
      ),
      /execution_plan_identity_invalid/,
    );
    const originalCommandHash = plan.commandHash;
    plan.commandHash = `sha256:${'5'.repeat(64)}`;
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: syntheticInputsAfter,
        },
      ),
      /execution_plan_identity_invalid/,
    );
    plan.commandHash = originalCommandHash;
    const originalSpecBytes = plan.specBytes;
    const replayedSpecBytes = Buffer.from(originalSpecBytes);
    replayedSpecBytes[replayedSpecBytes.byteLength - 2] ^= 1;
    plan.specBytes = replayedSpecBytes;
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: syntheticInputsAfter,
        },
      ),
      /execution_plan_identity_invalid/,
    );
    plan.specBytes = originalSpecBytes;
    const originalCreateCommand = plan.containerCreateArgs[0];
    plan.containerCreateArgs[0] = 'run';
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: syntheticInputsAfter,
        },
      ),
      /execution_plan_identity_invalid/,
    );
    plan.containerCreateArgs[0] = originalCreateCommand;

    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        environment: ['PATH=/bin', 'PATH=/usr/bin'],
      }),
      /environment_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        outputManifestMode: 'command_provided',
      }),
      /command_provided_outputs_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        declaredOutputs: [{
          ...common.declaredOutputs[0],
          path: '../escape.bin',
        }],
      }),
      /declared_output_path_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        declaredOutputs: [{
          ...common.declaredOutputs[0],
          metadataAuthority: 'forged_success',
        }],
      }),
      /declared_output_shape_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        workingDirectory: '/workspace/build',
      }),
      /working_directory_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        workerImageId: 'latest',
      }),
      /worker_image_id_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        workerImageOperatingSystem: 'windows',
      }),
      /worker_image_operating_system_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        workerImageArchitecture: common.workerImageArchitecture === 'amd64'
          ? 'arm64'
          : 'amd64',
      }),
      /launcher_architecture_mismatch/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        containerRuntime: '../runtime',
      }),
      /container_runtime_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        specHostDirectory: sourceHostPath,
      }),
      /input_path_overlap/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        readOnlyInputTrees: [{
          ...common.readOnlyInputTrees[0],
          hostPath: sourceHostPath,
          sourceTreeBindingEvidence,
        }],
      }),
      /input_path_overlap/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        readOnlyInputTrees: [
          common.readOnlyInputTrees[0],
          { ...common.readOnlyInputTrees[0], mountPath: 'dependency tree' },
        ],
      }),
      /read_only_input_mount_overlap/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        readOnlyInputTrees: [{
          ...common.readOnlyInputTrees[0],
          mountPath: '../escape',
        }],
      }),
      /read_only_input_mount_path_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        sourceTreeBindingEvidence: {
          ...sourceTreeBindingEvidence,
          acceptedForGpuHmr: true,
        },
      }),
      /source_tree_binding_evidence_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        releaseTreeBindingEvidence: {
          ...releaseTreeBindingEvidence,
          gpuHmrSuccess: true,
        },
      }),
      /source_tree_binding_evidence_invalid/,
    );
    assert.throws(
      () => createColdBuildLauncherExecutionPlan({
        ...common,
        sourceHostPath: `${common.sourceHostPath}\nreplayed`,
      }),
      /source_path_invalid/,
    );

    const restoredInputs = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'before_create',
    });
    await writeFile(readOnlyInputFilePath, 'changed dependency bytes\n', 'utf8');
    const changedReadOnlyInputs = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_create',
      expectedContainerId: SYNTHETIC_CONTAINER_ID,
    });
    assert.equal(changedReadOnlyInputs.acceptedAsExecutionInputEvidence, false);
    assert.ok(changedReadOnlyInputs.blockingGaps.includes(
      'cold_build_execution_input_read_only_0_binding_mismatch',
    ));
    assert.ok(changedReadOnlyInputs.blockingGaps.includes(
      'cold_build_execution_input_set_binding_mismatch',
    ));
    assert.notEqual(changedReadOnlyInputs.inputsHash, restoredInputs.inputsHash);
    await writeFile(readOnlyInputFilePath, 'initial dependency bytes\n', 'utf8');
    const unexpectedReleasePath = path.join(releaseHostPath, 'nested', 'unexpected.json');
    await mkdir(path.dirname(unexpectedReleasePath), { recursive: true });
    await writeFile(unexpectedReleasePath, '{"unexpected":true}\n', 'utf8');
    const changedReleaseInputs = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_create',
      expectedContainerId: SYNTHETIC_CONTAINER_ID,
    });
    assert.equal(changedReleaseInputs.acceptedAsExecutionInputEvidence, false);
    assert.ok(changedReleaseInputs.blockingGaps.includes(
      'cold_build_execution_input_release_binding_mismatch',
    ));
    assert.notEqual(changedReleaseInputs.inputsHash, restoredInputs.inputsHash);
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: restoredInputs,
          inputEvidenceAfterCreate: changedReleaseInputs,
        },
      ),
      /input_evidence_invalid/,
    );
    await rm(path.join(releaseHostPath, 'nested'), { recursive: true, force: true });
    await writeFile(nestedSourcePath, 'changed source bytes\n', 'utf8');
    const changedSourceInputs = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_create',
      expectedContainerId: SYNTHETIC_CONTAINER_ID,
    });
    assert.equal(changedSourceInputs.acceptedAsExecutionInputEvidence, false);
    assert.ok(changedSourceInputs.blockingGaps.includes(
      'cold_build_execution_input_source_binding_mismatch',
    ));
    assert.notEqual(changedSourceInputs.inputsHash, restoredInputs.inputsHash);
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: restoredInputs,
          inputEvidenceAfterCreate: changedSourceInputs,
        },
      ),
      /input_evidence_invalid/,
    );

    const corruptedSpecBytes = Buffer.from(plan.specBytes);
    corruptedSpecBytes[corruptedSpecBytes.byteLength - 2] ^= 1;
    await chmod(specHostPath, 0o600);
    await writeFile(specHostPath, corruptedSpecBytes);
    const corruptedInputEvidence = await verifyColdBuildLauncherExecutionInputs(plan, {
      phase: 'after_create',
      expectedContainerId: SYNTHETIC_CONTAINER_ID,
    });
    assert.equal(corruptedInputEvidence.acceptedAsExecutionInputEvidence, false);
    assert.ok(corruptedInputEvidence.blockingGaps.includes(
      'cold_build_execution_input_spec_invalid',
    ));
    assert.throws(
      () => verifyColdBuildLauncherContainerInspection(
        [syntheticInspect(plan)],
        plan,
        {
          expectedContainerId: SYNTHETIC_CONTAINER_ID,
          inputEvidenceBeforeCreate: syntheticInputsBefore,
          inputEvidenceAfterCreate: corruptedInputEvidence,
        },
      ),
      /input_evidence_invalid/,
    );

    console.log(JSON.stringify({
      status: 'self_check_passed',
      schemaVersion: COLD_BUILD_EXECUTION_PLAN_SCHEMA,
      planHash: plan.planHash,
      launcherExecutableHash: plan.launcherExecutableHash,
      containerInspectionEvidenceHash: evidence.evidenceHash,
      liveContainerInspectionEvidenceHash: liveInspectionEvidence.evidenceHash,
      configurationMatchesPlan: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    }, null, 2));
  } finally {
    if (liveContainerId) {
      await runColdBuildHostProcess(
        dockerExecutable,
        ['rm', '--force', liveContainerId],
        {
          timeoutMs: 30_000,
          maxStdoutBytes: 4096,
          maxStderrBytes: 4096,
          encoding: 'utf8',
        },
      );
    }
    await rm(root, { recursive: true, force: true });
  }
}

await main();
