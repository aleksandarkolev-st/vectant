#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
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

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data = Buffer.alloc(0)) {
  const typeBytes = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBytes, data])), 0);
  return Buffer.concat([length, typeBytes, data, crc]);
}

function tinyRgbPng(red, green, blue) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const idat = deflateSync(Buffer.from([0, red, green, blue]));
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND'),
  ]);
}

function sha256Buffer(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function writeVisualFixturePngs() {
  const relativeDir = path.join('.gpu-hmr-test-logs', 'runtime-boundary-adapter-visual-smoke');
  const absoluteDir = path.resolve(relativeDir);
  mkdirSync(absoluteDir, { recursive: true });
  const roles = [
    ['before', tinyRgbPng(255, 0, 0)],
    ['after', tinyRgbPng(0, 255, 0)],
    ['diff', tinyRgbPng(0, 0, 255)],
  ];
  return Object.fromEntries(roles.flatMap(([role, bytes]) => {
    const file = path.join(relativeDir, `${role}.png`);
    writeFileSync(path.resolve(file), bytes);
    return [
      [`${role}Image`, file],
      [`${role}ImageHash`, sha256Buffer(bytes)],
    ];
  }));
}

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
      evidenceRefs: [
        `worker-log:synthi_gpu_launch:${session}:${dispatchId}`,
        `worker-log:launch_arg_provenance:${session}:${dispatchId}:output`,
      ],
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
      evidenceRefs: [
        'worker-log:host_identity:runner_process',
        'worker-log:host_identity:host_state',
        'worker-log:host_identity:stream_context',
        `worker-log:host_identity_snapshot:${session}:runner_process:1->2`,
        `worker-log:host_identity_snapshot:${session}:host_state:1->2`,
        `worker-log:host_identity_snapshot:${session}:stream_context:1->2`,
      ],
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
    rawReadbackHashVerified: true,
    deterministicSliceHashVerified: true,
    expectedOutputVerified: true,
    expectedOutputHash: HASH_B,
    expectedOutputChange: true,
    evidenceRefs: ['compute-oracle:raw-readback-bytes'],
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

const visualFixture = writeVisualFixturePngs();
const visualInput = adapterInput({
  backend: 'hip',
  outputTargetId: 'framebuffer-1',
  computeOracleArtifacts: null,
  events: {
    outputOracle: {
      outputTargetId: 'framebuffer-1',
      oracleKind: 'render_target_hash',
      cameraStateHash: HASH_C,
      swapchainSize: [1, 1],
      framebufferIdentity: 'framebuffer-1',
      captureBackend: 'png-smoke',
      frameNumber: 12,
      evidenceRefs: [
        'worker-log:output_oracle:runtime-session-1:dispatch-1',
        'validation:output-oracle:visual-pngs',
      ],
    },
  },
  deterministicVisualMode: {
    schemaVersion: 'synthi.gpu_hmr.deterministic_visual_mode.v1',
    fixedSeed: true,
    seedPolicyFixed: true,
    frozenCamera: true,
    temporalAccumulationNotApplicable: true,
    taaNotApplicable: true,
    denoiserNotApplicable: true,
    fixedResolution: true,
    fixedSwapchainImageCount: true,
    frameCaptureAfterEpochDispatch: true,
    presentationFenceOrFrameBoundary: true,
  },
  visualOracleArtifacts: {
    beforeImage: visualFixture.beforeImage,
    beforeImageHash: visualFixture.beforeImageHash,
    afterImage: visualFixture.afterImage,
    afterImageHash: visualFixture.afterImageHash,
    diffImage: visualFixture.diffImage,
    diffImageHash: visualFixture.diffImageHash,
    blankFrameRejection: true,
    sameFrameRejection: true,
    newEpochWatermarkOrTrace: 'dispatch-1',
    cameraStateHash: HASH_C,
    swapchainSize: [1, 1],
    captureBackend: 'png-smoke',
    frameNumber: 12,
    timestampAfterDispatch: 400,
    changedPixelRatio: 1,
    perceptualDiff: 1,
    visiblePixelCount: 1,
    pixelMetricsVerified: true,
    evidenceRefs: ['validation:output-oracle:visual-pngs'],
  },
});
const visualStageEvidence = buildRuntimeBoundaryStageEvidence(visualInput.runtimeBoundaryEvents);
assert.equal(visualStageEvidence.accepted, true, visualStageEvidence.failedGates.join(','));
assert.equal(buildRuntimeBoundaryInputEvidence(visualInput).accepted, true);
const visualAccepted = buildRuntimeBoundaryProofAdapter(visualInput);
assert.equal(visualAccepted.accepted, true, visualAccepted.failedGates.join(','));
assert.equal(visualAccepted.gpuHmrSuccess, false, 'adapter facet must stay evidence-only for visual proof');
assert.equal(visualAccepted.runtimeProofArtifact.gpuHmrSuccess, true);
assert.equal(visualAccepted.runtimeProofArtifact.proofLedgerQuery.gpuHmrSuccess, true);
const visualLedgerRecord = visualAccepted.runtimeProofArtifact.proofLedger.records[0];
const visualLedgerOracleArtifacts = visualLedgerRecord.oracle_artifacts
  ?? visualLedgerRecord.oracleArtifacts
  ?? {};
const visualLedgerArtifacts = visualLedgerOracleArtifacts.visual_oracle_artifacts
  ?? visualLedgerOracleArtifacts.visualOracleArtifacts;
assert.ok(visualLedgerArtifacts, Object.keys(visualLedgerRecord).join(','));
assert.equal(visualLedgerArtifacts.after_image_hash, visualFixture.afterImageHash);
assert.equal(visualAccepted.strictGate.status, 'pass', visualAccepted.strictGate.detail);

const visualMissingFramebuffer = buildRuntimeBoundaryProofAdapter({
  ...visualInput,
  runtimeBoundaryEvents: boundaryEvents({
    outputOracle: {
      outputTargetId: 'framebuffer-1',
      oracleKind: 'render_target_hash',
      cameraStateHash: HASH_C,
      swapchainSize: [1, 1],
      captureBackend: 'png-smoke',
      frameNumber: 12,
      evidenceRefs: ['worker-log:output_oracle:runtime-session-1:dispatch-1'],
    },
  }),
});
assert.equal(visualMissingFramebuffer.accepted, false);
assert.ok(
  visualMissingFramebuffer.failedGates.includes('output_oracle_visual_framebuffer_identity_missing'),
  visualMissingFramebuffer.failedGates.join(','),
);

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
  missingOracleBytes.failedGates.includes('runtime_boundary_compute_oracle_raw_readback_hash_unverified')
    || missingOracleBytes.failedGates.includes('compute_oracle_raw_readback_hash_unverified')
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

const missingEventEvidenceRefs = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  runtimeBoundaryEvents: boundaryEvents().map((event) => ({
    ...event,
    evidenceRefs: [],
  })),
});
assert.equal(missingEventEvidenceRefs.accepted, false);
assert.equal(missingEventEvidenceRefs.runtimeProofArtifact, null);
assert.ok(
  missingEventEvidenceRefs.failedGates.includes('runtime_boundary_event_evidence_refs_missing')
    || missingEventEvidenceRefs.failedGates.includes('artifact_transport_evidence_refs_missing'),
  missingEventEvidenceRefs.failedGates.join(','),
);

const inputEventArtifactMismatch = buildRuntimeBoundaryProofAdapter(adapterInput({
  artifactHashAfter: HASH_E,
}));
assert.equal(inputEventArtifactMismatch.accepted, false);
assert.equal(inputEventArtifactMismatch.runtimeProofArtifact, null);
assert.ok(
  inputEventArtifactMismatch.failedGates.includes('runtime_boundary_input_artifact_hash_after_mismatch'),
  inputEventArtifactMismatch.failedGates.join(','),
);

const duplicateForgedStage = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  runtimeBoundaryEvents: [
    ...boundaryEvents(),
    {
      ...boundaryEvents().find((event) => event.kind === 'output_oracle'),
      eventId: 'output-forged-duplicate',
      gpuHmrSuccess: true,
      evidenceRefs: ['runtime-boundary:forged-duplicate-output'],
    },
  ],
});
assert.equal(duplicateForgedStage.accepted, false);
assert.equal(duplicateForgedStage.runtimeProofArtifact, null);
assert.ok(
  duplicateForgedStage.failedGates.includes('runtime_boundary_stage_output_oracle_duplicate'),
  duplicateForgedStage.failedGates.join(','),
);
assert.ok(
  duplicateForgedStage.failedGates.includes('runtime_boundary_event_claims_success_authority'),
  duplicateForgedStage.failedGates.join(','),
);

const declaredOnlyOracle = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  computeOracleArtifacts: buildComputeOracleArtifactsFromByteEvidence({
    rawReadbackHash: HASH_B,
    checksumBefore: HASH_A,
    checksumAfter: HASH_B,
    deterministicSliceHash: HASH_C,
    rawReadbackByteLength: 128,
    sliceOffset: 0,
    sliceLength: 64,
    timestampAfterDispatch: 400,
    epoch: 'epoch-7',
  }),
});
assert.equal(declaredOnlyOracle.accepted, false);
assert.equal(declaredOnlyOracle.runtimeProofArtifact, null);
assert.ok(
  declaredOnlyOracle.failedGates.includes('runtime_boundary_compute_oracle_expected_output_not_verified')
    || declaredOnlyOracle.failedGates.includes('runtime_boundary_compute_oracle_evidence_refs_missing'),
  declaredOnlyOracle.failedGates.join(','),
);

console.log('[ok] GPU HMR runtime-boundary proof adapter self-check passed');
