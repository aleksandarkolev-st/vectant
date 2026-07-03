#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  buildComputeOracleArtifactsFromByteEvidence,
  buildRuntimeBoundaryInputEvidence,
  buildRuntimeBoundaryProofAdapter,
  buildRuntimeBoundaryRunModeProof,
  buildRuntimeBoundaryStageEvidence,
} from '../lib/gpu-hmr-runtime-boundary-proof-adapter.mjs';

const HASH_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const HASH_B = 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const HASH_C = 'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc';
const HASH_D = 'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd';
const HASH_E = 'sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee';

function boundaryEvents(overrides = {}) {
  const session = overrides.session ?? 'runtime-session-1';
  const processId = overrides.processId ?? 'pid-1';
  const artifactHash = overrides.artifactHash ?? HASH_B;
  const epoch = overrides.epoch ?? 'epoch-7';
  const dispatchId = overrides.dispatchId ?? 'dispatch-1';
  return [
    {
      kind: 'artifact_transport',
      eventId: 'load-1',
      artifactHash,
      processId,
      runtimeSession: session,
      timestampMonotonicNs: 100,
      evidenceRefs: ['runtime-boundary:artifact-transport'],
      ...(overrides.artifactTransport ?? {}),
    },
    {
      kind: 'epoch_publication',
      eventId: 'publish-1',
      artifactHash,
      epoch,
      processId,
      runtimeSession: session,
      timestampMonotonicNs: 200,
      dispatchTableHashBefore: HASH_D,
      dispatchTableHashAfter: HASH_E,
      evidenceRefs: ['runtime-boundary:epoch-publication'],
      ...(overrides.epochPublication ?? {}),
    },
    {
      kind: 'synthi_gpu_launch',
      eventId: dispatchId,
      artifactHash,
      epoch,
      dispatchId,
      processId,
      runtimeSession: session,
      stream: 'stream-1',
      dispatchTableEntry: 'generic_kernel:epoch-7',
      timestampMonotonicNs: 300,
      evidenceRefs: [`worker-log:synthi_gpu_launch:${session}:${dispatchId}`],
      ...(overrides.dispatchTrace ?? {}),
    },
    {
      kind: 'host_identity',
      eventId: 'host-1',
      processId,
      runtimeSession: session,
      deviceUuid: 'device-1',
      contextId: 'ctx-1',
      stream: 'stream-1',
      timestampMonotonicNs: 310,
      evidenceRefs: ['runtime-boundary:host-identity'],
      ...(overrides.hostIdentity ?? {}),
    },
    {
      kind: 'output_oracle',
      eventId: 'output-1',
      artifactHash,
      epoch,
      afterDispatchId: dispatchId,
      processId,
      runtimeSession: session,
      outputTargetId: 'allocation-1',
      oracleKind: 'buffer_checksum',
      timestampMonotonicNs: 400,
      evidenceRefs: [`worker-log:output_oracle:${session}:${dispatchId}`],
      ...(overrides.outputOracle ?? {}),
    },
  ].filter(Boolean);
}

function computeOracle() {
  return buildComputeOracleArtifactsFromByteEvidence({
    rawReadbackHash: HASH_B,
    checksumBefore: HASH_A,
    checksumAfter: HASH_B,
    deterministicSliceHash: HASH_C,
    rawReadbackByteLength: 128,
    sliceOffset: 0,
    sliceLength: 64,
    timestampAfterDispatch: 400,
    epoch: 'epoch-7',
  });
}

function adapterInput(overrides = {}) {
  return {
    backend: 'hip',
    projectId: 'generic-runtime-boundary-project',
    editId: 'gpu-artifact-edit',
    targetId: 'generic-runtime-boundary-target',
    sourcePaths: ['src/kernels/generic.hip'],
    entryPoint: 'generic_kernel',
    compileTarget: 'gfx1201',
    compiler: 'hipcc',
    compilerArgsHash: HASH_C,
    artifactHashBefore: HASH_A,
    artifactHashAfter: HASH_B,
    contractHash: HASH_C,
    runtimeBoundaryEvents: boundaryEvents(overrides.events ?? {}),
    computeOracleArtifacts: computeOracle(),
    ...overrides,
  };
}

const stageEvidence = buildRuntimeBoundaryStageEvidence(boundaryEvents());
assert.equal(stageEvidence.accepted, true, stageEvidence.failedGates.join(','));
assert.equal(stageEvidence.normalizedEvents.length, 5);
assert.equal(stageEvidence.gpuHmrSuccess, false);
assert.equal(buildRuntimeBoundaryInputEvidence(adapterInput()).accepted, true);

const accepted = buildRuntimeBoundaryProofAdapter(adapterInput());
assert.equal(accepted.accepted, true, accepted.failedGates.join(','));
assert.equal(accepted.gpuHmrSuccess, false, 'adapter facet itself must not claim GPU HMR success');
assert.equal(accepted.canSatisfyRuntimeProof, true);
assert.equal(accepted.fullRuntimeProof.fullRuntimeProven, true);
assert.equal(accepted.runtimeProofArtifact.gpuHmrSuccess, true);
assert.equal(accepted.strictGate.status, 'pass', accepted.strictGate.detail);
assert.equal(accepted.runtimeProofArtifact.proofLedgerQuery.gpuHmrSuccess, true);
assert.equal(accepted.runtimeProofArtifact.acceptanceContractEvaluation.accepted, true);

const runModeProof = buildRuntimeBoundaryRunModeProof(adapterInput());
assert.equal(runModeProof.schemaVersion, 'synthi.gpu.hmr.runtime_run_mode_proof.v1');
assert.equal(runModeProof.accepted, true, runModeProof.failedGates.join(','));
assert.equal(runModeProof.runtimeProofArtifact.gpuHmrSuccess, true);
assert.equal(runModeProof.runtimeBoundaryProofAdapter.gpuHmrSuccess, false);

const missingOutput = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  runtimeBoundaryEvents: boundaryEvents().filter((event) => event.kind !== 'output_oracle'),
});
assert.equal(missingOutput.accepted, false);
assert.ok(
  missingOutput.failedGates.includes('runtime_boundary_stage_output_oracle_missing'),
  missingOutput.failedGates.join(','),
);
assert.equal(missingOutput.runtimeProofArtifact, null);

const forgedSuccess = buildRuntimeBoundaryProofAdapter(adapterInput({
  events: {
    outputOracle: {
      gpuHmrSuccess: true,
    },
  },
}));
assert.equal(forgedSuccess.accepted, false);
assert.ok(
  forgedSuccess.failedGates.includes('runtime_boundary_event_claims_success_authority'),
  forgedSuccess.failedGates.join(','),
);

const dispatchMismatch = buildRuntimeBoundaryProofAdapter(adapterInput({
  events: {
    outputOracle: {
      afterDispatchId: 'dispatch-from-old-epoch',
    },
  },
}));
assert.equal(dispatchMismatch.accepted, false);
assert.ok(
  dispatchMismatch.failedGates.includes('runtime_boundary_output_dispatch_id_mismatch'),
  dispatchMismatch.failedGates.join(','),
);

const cpuFallback = buildRuntimeBoundaryProofAdapter(adapterInput({ cpuHmrUsed: true }));
assert.equal(cpuFallback.accepted, false);
assert.ok(
  cpuFallback.failedGates.includes('cpu_hmr_used')
    || cpuFallback.failedGates.includes('cpu_hmr_absence_not_verified')
    || cpuFallback.failedGates.includes('runtime_proof_artifact_gpu_hmr_success_false'),
  cpuFallback.failedGates.join(','),
);

const missingOracleBytes = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  computeOracleArtifacts: {
    ...computeOracle(),
    raw_readback_hash_verified: false,
    raw_readback_verification: {
      ...computeOracle().raw_readback_verification,
      hash_verified: false,
    },
  },
});
assert.equal(missingOracleBytes.accepted, false);
assert.ok(
  missingOracleBytes.failedGates.includes('compute_oracle_raw_readback_hash_unverified')
    || missingOracleBytes.failedGates.includes('proof_ledger_recomputed_query_rejected'),
  missingOracleBytes.failedGates.join(','),
);

const missingSourceIdentity = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  sourcePaths: [],
});
assert.equal(missingSourceIdentity.accepted, false);
assert.equal(missingSourceIdentity.runtimeProofArtifact, null);
assert.ok(
  missingSourceIdentity.failedGates.includes('runtime_boundary_source_paths_missing'),
  missingSourceIdentity.failedGates.join(','),
);

console.log('[ok] GPU HMR runtime-boundary proof adapter self-check passed');
