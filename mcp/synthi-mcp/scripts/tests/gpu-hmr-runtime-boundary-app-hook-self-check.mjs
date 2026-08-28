#!/usr/bin/env node

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  executeRuntimeBoundaryAppHookCommand,
  normalizeRuntimeBoundaryAppHook,
  runtimeBoundaryAppHookClaimsAuthority,
  runtimeBoundaryAppHookDeclaredEventManifestPath,
  transportRuntimeBoundaryAppHookArtifact,
} from '../lib/gpu-hmr-runtime-boundary-app-hook.mjs';

function supportOnlyPayload(schemaVersion) {
  return {
    schemaVersion,
    proofAuthority: 'runtime_boundary_observation_only_not_gpu_hmr_success',
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
    blockingGaps: ['strict_runtime_proof_not_supplied_by_app_hook'],
  };
}

function fakeWorkerContext(files, options = {}) {
  const state = {
    scripts: [],
    copies: [],
  };
  return {
    state,
    available: options.available !== false,
    async executeShell(script) {
      state.scripts.push(script);
      return options.commandFailed
        ? [
            'runtime_adapter_status=failed',
            'runtime_adapter_exit_code=9',
            'runtime_adapter_skip_reason=runtime_adapter_command_failed',
            'runtime_adapter_ms=3',
          ].join('\n')
        : [
            'runtime_adapter_status=pass',
            'runtime_adapter_exit_code=0',
            'runtime_adapter_skip_reason=none',
            'runtime_adapter_ms=3',
          ].join('\n');
    },
    async readText(workerPath) {
      return String(options.logs?.[workerPath] ?? '');
    },
    async existsNonEmpty(workerPath) {
      return Buffer.byteLength(files.get(workerPath) ?? '') > 0;
    },
    async copyToHost(workerPath, hostPath) {
      const bytes = files.get(workerPath);
      if (!bytes) throw new Error(`missing fake worker bytes: ${workerPath}`);
      state.copies.push({ workerPath, hostPath });
      await writeFile(hostPath, bytes);
    },
  };
}

const root = await mkdtemp(path.join(tmpdir(), 'synthi-runtime-app-hook-'));
try {
  const repoRoot = path.join(root, 'repo');
  const allowedRoot = path.join(repoRoot, 'evidence');
  await mkdir(allowedRoot, { recursive: true });
  const workerRepoRoot = '/worker/repo';
  const resultRelativePath = 'evidence/result.json';
  const eventRelativePath = 'evidence/events.json';
  const workerResultPath = `${workerRepoRoot}/${resultRelativePath}`;
  const workerEventPath = `${workerRepoRoot}/${eventRelativePath}`;
  const resultBytes = Buffer.from(`${JSON.stringify(
    supportOnlyPayload('synthi.gpu_hmr.runtime_profile_adapter_result.v1'),
  )}\n`);
  const eventBytes = Buffer.from(`${JSON.stringify({
    ...supportOnlyPayload('synthi.gpu_hmr.runtime_boundary_event_manifest.v1'),
    runtimeBoundaryEvents: [],
  })}\n`);
  const files = new Map([
    [workerResultPath, resultBytes],
    [workerEventPath, eventBytes],
  ]);
  const worker = fakeWorkerContext(files, {
    logs: {
      '/worker/tmp/run.log': '[synthi-runtime-adapter] status=pass',
    },
  });
  const adapter = normalizeRuntimeBoundaryAppHook({
    enabled: true,
    command: 'exec ./declared-host-path --emit-runtime-boundary-result',
    workingDirectory: 'build',
    resultPath: resultRelativePath,
    eventManifestPath: eventRelativePath,
    timeoutMs: 4321,
    evidenceRefs: ['contract:runtime-boundary-app-hook'],
  });

  assert.equal(adapter.declared, true);
  assert.equal(adapter.enabled, true);
  assert.equal(adapter.workingDirectory, 'build');
  assert.equal(adapter.resultPath, resultRelativePath);
  assert.equal(adapter.eventManifestPath, eventRelativePath);
  assert.equal(adapter.timeoutMs, 4321);
  assert.match(adapter.commandHash, /^sha256:[a-f0-9]{64}$/);
  assert.equal(adapter.acceptedForGpuHmr, false);
  assert.equal(adapter.gpuHmrSuccess, false);
  assert.equal(adapter.canSatisfyRuntimeProof, false);

  const execution = await executeRuntimeBoundaryAppHookCommand({
    adapter,
    workerContext: worker,
    workerRepoRoot,
    defaultWorkingDirectory: 'build-default',
    workerTempDir: '/worker/tmp',
    runLogPath: '/worker/tmp/run.log',
    identity: 'runtime-boundary-app-hook',
    sessionSuffix: 'session',
    environment: {
      SYNTHI_GPU_HMR_RUNTIME_SESSION: 'session',
    },
  });
  assert.equal(execution.status, 'runtime_boundary_app_hook_executed');
  assert.equal(execution.acceptedAsSupportEvidence, true);
  assert.equal(execution.acceptedForGpuHmr, false);
  assert.equal(execution.gpuHmrSuccess, false);
  assert.equal(execution.canSatisfyRuntimeProof, false);
  assert.equal(worker.state.scripts.length, 1);
  assert.match(worker.state.scripts[0], /cd '\/worker\/repo\/build'/);
  assert.match(worker.state.scripts[0], /exec \.\/declared-host-path/);
  assert.match(worker.state.scripts[0], /SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_RESULT_PATH='\/worker\/repo\/evidence\/result\.json'/);
  assert.match(worker.state.scripts[0], /SYNTHI_REAL_ROCM_RUNTIME_ADAPTER_EVENT_MANIFEST_PATH='\/worker\/repo\/evidence\/events\.json'/);

  const resultTransport = await transportRuntimeBoundaryAppHookArtifact({
    kind: 'result',
    adapter,
    declaredPath: resultRelativePath,
    workerRepoRoot,
    hostRepoRoot: repoRoot,
    allowedHostRoots: [allowedRoot],
    workerContext: worker,
    required: true,
  });
  assert.equal(resultTransport.accepted, true);
  assert.equal(resultTransport.copied, true);
  assert.equal(resultTransport.payloadValidated, true);
  assert.equal(resultTransport.byteLength, resultBytes.length);
  assert.match(resultTransport.rawSha256, /^sha256:[a-f0-9]{64}$/);
  assert.equal(resultTransport.acceptedForGpuHmr, false);
  assert.deepEqual(
    await readFile(path.join(repoRoot, resultRelativePath)),
    resultBytes,
  );

  const eventTransport = await transportRuntimeBoundaryAppHookArtifact({
    kind: 'event_manifest',
    adapter,
    declaredPath: eventRelativePath,
    workerRepoRoot,
    hostRepoRoot: repoRoot,
    allowedHostRoots: [allowedRoot],
    workerContext: worker,
    required: true,
  });
  assert.equal(eventTransport.accepted, true);
  assert.equal(eventTransport.payloadValidated, true);
  assert.equal(eventTransport.canSatisfyDispatchProof, false);

  const undeclaredAdapter = normalizeRuntimeBoundaryAppHook(null);
  const missingHook = await executeRuntimeBoundaryAppHookCommand({
    adapter: undeclaredAdapter,
    workerContext: worker,
    workerRepoRoot,
    workerTempDir: '/worker/tmp',
  });
  assert.equal(missingHook.acceptedAsSupportEvidence, false);
  assert.ok(missingHook.blockingGaps.includes('runtime_boundary_app_hook_missing'));

  const logOnlyAdapter = normalizeRuntimeBoundaryAppHook({
    command: 'printf log-only',
    workingDirectory: 'build',
  });
  const logOnly = await executeRuntimeBoundaryAppHookCommand({
    adapter: logOnlyAdapter,
    workerContext: worker,
    workerRepoRoot,
    workerTempDir: '/worker/tmp',
  });
  assert.equal(logOnly.attempted, false);
  assert.equal(logOnly.acceptedAsSupportEvidence, false);
  assert.ok(logOnly.blockingGaps.includes('runtime_boundary_app_hook_result_path_missing'));

  const failedWorker = fakeWorkerContext(files, { commandFailed: true });
  const commandFailure = await executeRuntimeBoundaryAppHookCommand({
    adapter,
    workerContext: failedWorker,
    workerRepoRoot,
    workerTempDir: '/worker/tmp',
  });
  assert.equal(commandFailure.acceptedAsSupportEvidence, false);
  assert.ok(commandFailure.blockingGaps.includes('runtime_boundary_app_hook_command_failed'));

  const missingBytes = await transportRuntimeBoundaryAppHookArtifact({
    kind: 'result',
    adapter,
    declaredPath: 'evidence/missing.json',
    workerRepoRoot,
    hostRepoRoot: repoRoot,
    allowedHostRoots: [allowedRoot],
    workerContext: worker,
    required: true,
  });
  assert.equal(missingBytes.accepted, false);
  assert.ok(missingBytes.blockingGaps.includes(
    'runtime_boundary_app_hook_result_transport_worker_file_missing',
  ));

  const authorityResultPath = 'evidence/authority-result.json';
  files.set(
    `${workerRepoRoot}/${authorityResultPath}`,
    Buffer.from(`${JSON.stringify({
      ...supportOnlyPayload('synthi.gpu_hmr.runtime_profile_adapter_result.v1'),
      nested: { accepted_for_gpu_hmr: true },
    })}\n`),
  );
  const authorityResult = await transportRuntimeBoundaryAppHookArtifact({
    kind: 'result',
    adapter,
    declaredPath: authorityResultPath,
    workerRepoRoot,
    hostRepoRoot: repoRoot,
    allowedHostRoots: [allowedRoot],
    workerContext: worker,
    required: true,
  });
  assert.equal(authorityResult.accepted, false);
  assert.ok(authorityResult.blockingGaps.includes(
    'runtime_boundary_app_hook_result_transport_payload_claimed_authority',
  ));
  assert.deepEqual(authorityResult.authorityClaimPaths, ['nested.accepted_for_gpu_hmr']);
  assert.equal(runtimeBoundaryAppHookClaimsAuthority({ gpu_hmr_success: true }), true);

  const outsideAllowedRoot = await transportRuntimeBoundaryAppHookArtifact({
    kind: 'result',
    adapter,
    declaredPath: 'other/result.json',
    workerRepoRoot,
    hostRepoRoot: repoRoot,
    allowedHostRoots: [allowedRoot],
    workerContext: worker,
    required: true,
  });
  assert.equal(outsideAllowedRoot.accepted, false);
  assert.ok(outsideAllowedRoot.blockingGaps.includes(
    'runtime_boundary_app_hook_result_transport_path_outside_allowed_roots',
  ));

  assert.throws(
    () => normalizeRuntimeBoundaryAppHook({
      command: 'true',
      resultPath: '../escaped-result.json',
    }),
    /relative path without traversal/,
  );
  assert.throws(
    () => normalizeRuntimeBoundaryAppHook({
      command: 'true',
      workingDirectory: '../escaped-working-directory',
      resultPath: resultRelativePath,
    }),
    /relative path without traversal/,
  );
  assert.throws(
    () => normalizeRuntimeBoundaryAppHook({
      command: 'true',
      resultPath: '/absolute/result.json',
    }),
    /relative path without traversal/,
  );
  assert.throws(
    () => normalizeRuntimeBoundaryAppHook({
      command: 'true',
      eventManifestPath: 'C:\\escaped\\events.json',
      resultPath: resultRelativePath,
    }),
    /relative path without traversal/,
  );

  const noEventAdapter = normalizeRuntimeBoundaryAppHook({
    command: 'true',
    resultPath: 'result-with-derived-event.json',
  });
  assert.equal(
    runtimeBoundaryAppHookDeclaredEventManifestPath(noEventAdapter),
    'result-with-derived-event-runtime-boundary-events.json',
  );
  const noEventBytes = await transportRuntimeBoundaryAppHookArtifact({
    kind: 'event_manifest',
    adapter: noEventAdapter,
    declaredPath: '',
    workerRepoRoot,
    hostRepoRoot: repoRoot,
    allowedHostRoots: [repoRoot],
    workerContext: worker,
    required: true,
  });
  assert.equal(noEventBytes.accepted, false);
  assert.equal(noEventBytes.copied, false);
  assert.ok(noEventBytes.blockingGaps.includes(
    'runtime_boundary_app_hook_event_manifest_transport_path_missing',
  ));

  console.log('gpu hmr runtime-boundary app-hook self-check passed');
} finally {
  await rm(root, { recursive: true, force: true });
}
