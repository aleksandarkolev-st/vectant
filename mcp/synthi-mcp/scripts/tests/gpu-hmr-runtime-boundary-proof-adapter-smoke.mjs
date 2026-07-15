#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { deflateSync } from 'node:zlib';
import {
  buildComputeOracleArtifactsFromByteEvidence,
  buildRuntimeBoundaryInputEvidence,
  buildRuntimeBoundaryProofAdapter,
  buildRuntimeBoundaryRunModeProof,
  buildRuntimeBoundaryStageEvidence,
  materializeRuntimeBoundaryEventLines,
} from '../lib/gpu-hmr-runtime-boundary-proof-adapter.mjs';
import {
  buildGpuHmrFrameGateRuntimeBinding,
} from '../lib/gpu-hmr-proof-ledger.mjs';

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

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  ).join(',')}}`;
}

function contentHash(value) {
  return sha256Buffer(Buffer.from(stableJson(value)));
}

const COMPUTE_RAW_BYTES = Buffer.from(Array.from({ length: 128 }, (_, index) =>
  (index * 19 + 11) % 256
));
const COMPUTE_RAW_PATH = path.resolve(
  '.gpu-hmr-test-logs',
  'runtime-boundary-adapter-compute-smoke',
  'readback.bin',
);
mkdirSync(path.dirname(COMPUTE_RAW_PATH), { recursive: true });
writeFileSync(COMPUTE_RAW_PATH, COMPUTE_RAW_BYTES);
const COMPUTE_RAW_HASH = sha256Buffer(COMPUTE_RAW_BYTES);
const COMPUTE_SLICE_BYTES = COMPUTE_RAW_BYTES.subarray(0, 64);
const COMPUTE_SLICE_HASH = sha256Buffer(COMPUTE_SLICE_BYTES);

function writeVisualFixturePngs() {
  const fixtureParent = path.resolve('.gpu-hmr-test-logs');
  mkdirSync(fixtureParent, { recursive: true });
  const fixtureDir = mkdtempSync(path.join(fixtureParent, 'runtime-boundary-adapter-visual-smoke-'));
  const allowedDir = path.join(fixtureDir, 'allowed');
  const outsideDir = path.join(fixtureDir, 'outside');
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  const roles = [
    ['before', tinyRgbPng(255, 0, 0)],
    ['after', tinyRgbPng(0, 255, 0)],
    ['diff', tinyRgbPng(0, 0, 255)],
  ];
  const fixture = Object.fromEntries(roles.flatMap(([role, bytes]) => {
    const file = path.join(allowedDir, `${role}.png`);
    writeFileSync(file, bytes);
    return [
      [`${role}Image`, file],
      [`${role}ImageHash`, sha256Buffer(bytes)],
      [`${role}ImageByteLength`, bytes.length],
    ];
  }));
  const directEscapeAfterImage = path.join(outsideDir, 'after.png');
  writeFileSync(directEscapeAfterImage, tinyRgbPng(0, 255, 0));
  const symlinkDir = path.join(allowedDir, 'outside-link');
  symlinkSync(outsideDir, symlinkDir, process.platform === 'win32' ? 'junction' : 'dir');
  return {
    ...fixture,
    artifactRoot: allowedDir,
    directEscapeAfterImage,
    symlinkEscapeAfterImage: path.join(symlinkDir, 'after.png'),
  };
}

function visualEvidenceArtifactsFromFixture(fixture) {
  return ['before', 'after', 'diff'].map((role) => ({
    kind: 'visual-artifact',
    role,
    artifactRole: role,
    artifact_role: role,
    path: fixture[`${role}Image`],
    sourcePath: fixture[`${role}Image`],
    source_path: fixture[`${role}Image`],
    contentHash: fixture[`${role}ImageHash`],
    content_hash: fixture[`${role}ImageHash`],
    contentHashVerified: true,
    content_hash_verified: true,
    byteLength: fixture[`${role}ImageByteLength`],
    byte_length: fixture[`${role}ImageByteLength`],
    bytes: fixture[`${role}ImageByteLength`],
    proofId: `visual-artifact-verification:${fixture[`${role}ImageHash`]}`,
    proof_id: `visual-artifact-verification:${fixture[`${role}ImageHash`]}`,
    evidenceId: `visual-artifact-verification:${fixture[`${role}ImageHash`]}`,
    evidence_id: `visual-artifact-verification:${fixture[`${role}ImageHash`]}`,
    proofAuthority: 'runtime_boundary_visual_artifact_verification_not_gpu_hmr_success',
    proof_authority: 'runtime_boundary_visual_artifact_verification_not_gpu_hmr_success',
    evidenceAuthority: 'runtime_boundary_visual_artifact_verification_not_gpu_hmr_success',
    evidence_authority: 'runtime_boundary_visual_artifact_verification_not_gpu_hmr_success',
    acceptedAsVisualEvidence: true,
    accepted_as_visual_evidence: true,
    acceptedAsImageEvidence: true,
    accepted_as_image_evidence: true,
    acceptedAsRuntimeVisualProof: false,
    accepted_as_runtime_visual_proof: false,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    readError: null,
    read_error: null,
    visualAnalysisError: null,
    visual_analysis_error: null,
    evidenceRefs: [`visual-artifact-verification:${role}:${fixture[`${role}ImageHash`]}`],
    evidence_refs: [`visual-artifact-verification:${role}:${fixture[`${role}ImageHash`]}`],
  }));
}

function boundaryEvents(overrides = {}) {
  const session = overrides.session ?? 'runtime-session-1';
  const processId = overrides.processId ?? 'pid-1';
  const deviceUuid = overrides.deviceUuid ?? 'device-1';
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
      deviceUuid,
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
      deviceUuid,
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
      deviceUuid,
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
      deviceUuid,
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
      deviceUuid,
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
    rawReadbackBin: COMPUTE_RAW_PATH,
    rawReadbackHash: COMPUTE_RAW_HASH,
    checksumBefore: HASH_A,
    checksumAfter: COMPUTE_RAW_HASH,
    deterministicSliceHash: COMPUTE_SLICE_HASH,
    rawReadbackByteLength: COMPUTE_RAW_BYTES.length,
    sliceOffset: 0,
    sliceLength: COMPUTE_SLICE_BYTES.length,
    timestampAfterDispatch: 400,
    epoch: 'epoch-7',
    rawReadbackHashVerified: true,
    deterministicSliceHashVerified: true,
    expectedOutputVerified: true,
    expectedOutputHash: COMPUTE_RAW_HASH,
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
    sourceManifestHash: HASH_D,
    sourceManifestHashVerified: true,
    sourceIdentityEvidenceRefs: ['source-manifest:generic-runtime-boundary-project'],
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

function installCaptureEvidenceBinding(captureManifest, binding) {
  const bindingHash = contentHash(binding);
  captureManifest.evidence_binding = structuredClone(binding);
  captureManifest.evidence_binding_hash = bindingHash;
  captureManifest.frame_gate.evidence_binding = structuredClone(binding);
  captureManifest.frame_gate.evidence_binding_hash = bindingHash;
}

const CALLER_RUNTIME_PROOF_CLAIMS = Object.freeze({
  runtime_proof_id: `gpu-runtime-proof:${HASH_C}`,
  runtime_proof_state: 'gpu-hmr-full-runtime-proven',
  runtime_proof_accepted: true,
  runtime_proof_observed_at_ms: 1_100,
  hmr_observed_at_ms: 1_000,
});

function callerSuppliedCaptureBoundaryManifest(input, fixture) {
  const unbound = buildRuntimeBoundaryProofAdapter(input);
  const sourceRecord = unbound.runtimeProofArtifact?.derivedProofLedgerRecord;
  if (!sourceRecord) throw new Error('visual_capture_smoke_derived_record_missing');
  const record = structuredClone(sourceRecord);
  const stages = buildRuntimeBoundaryStageEvidence(input.runtimeBoundaryEvents).stageEvents;
  for (const [recordKey, stage] of [
    ['loader_event', stages.artifact_transport],
    ['epoch_publish_event', stages.epoch_publication],
    ['dispatch_event', stages.dispatch_trace],
    ['output_event', stages.output_oracle],
  ]) {
    record[recordKey] = {
      ...record[recordKey],
      runtime_session_id: stage.runtimeSessionId,
      device_uuid: stage.deviceUuid,
    };
  }
  record.output_event.output_target_id = stages.output_oracle.outputTargetId;
  record.process_identity = {
    ...record.process_identity,
    runtime_session_id: stages.host_identity.runtimeSessionId,
  };
  record.device_identity = {
    ...record.device_identity,
    device_uuid: stages.host_identity.deviceUuid,
  };
  Object.assign(record, CALLER_RUNTIME_PROOF_CLAIMS);
  record.runtime_session_id = stages.dispatch_trace.runtimeSessionId;

  const evidenceBinding = buildGpuHmrFrameGateRuntimeBinding(record);
  const captureManifest = {
    schema_version: 'synthi.mcp.capture_manifest.v1',
    session_id: 'capture-session-1',
    capture_backend: 'png-smoke',
    capture_event_id: 'screenshot:capture-session-1:12:1500',
    frame_event_id: 'broker-frame:capture-session-1:12',
    frame_seq: 12,
    frame_ts_ms: 1_400,
    capture_ts_ms: 1_500,
    source_frame_hash: fixture.afterImageHash,
    broker_frame_hash: fixture.afterImageHash,
    image_sha256: fixture.afterImageHash,
    image_byte_length: fixture.afterImageByteLength,
    width: 1,
    height: 1,
    gate_token: 'frame-gate:caller-supplied-capture-token',
    gate_token_verified: true,
    required_frame_seq: 11,
    required_ts_ms: 1_200,
    frame_gate: {
      status: 'satisfied',
      required_frame_seq: 11,
      required_ts_ms: 1_200,
      gate_token: 'frame-gate:caller-supplied-capture-token',
      gate_token_verified: true,
      gate_token_issued_at_ms: 1_300,
      gate_token_expires_at_ms: 2_000,
      session_id: 'capture-session-1',
      captured_frame_seq: 12,
      captured_ts_ms: 1_400,
      timeout_ms: 120_000,
    },
  };
  installCaptureEvidenceBinding(captureManifest, evidenceBinding);
  return captureManifest;
}

function mutateCaptureManifest(input, mutate) {
  const changed = structuredClone(input);
  mutate(changed.visualOracleArtifacts.capture_manifest);
  return changed;
}

function withAfterVisualArtifactPath(input, artifactPath) {
  const changed = structuredClone(input);
  const artifact = changed.visualEvidenceArtifacts.find((entry) => entry.role === 'after');
  artifact.path = artifactPath;
  artifact.filePath = artifactPath;
  artifact.file_path = artifactPath;
  artifact.sourcePath = artifactPath;
  artifact.source_path = artifactPath;
  return changed;
}

function visualLedgerArtifactsFromResult(result) {
  const record = result.runtimeProofArtifact?.proofLedger?.records?.[0] ?? {};
  const oracleArtifacts = record.oracle_artifacts ?? record.oracleArtifacts ?? {};
  return oracleArtifacts.visual_oracle_artifacts
    ?? oracleArtifacts.visualOracleArtifacts
    ?? null;
}

function assertVisualCaptureRefused(result, expectedFailure) {
  assert.equal(result.accepted, false);
  assert.ok(result.failedGates.includes(expectedFailure), result.failedGates.join(','));
  assert.equal(visualLedgerArtifactsFromResult(result)?.visual_capture_runtime_binding, undefined);
}

const stageEvidence = buildRuntimeBoundaryStageEvidence(boundaryEvents());
assert.equal(stageEvidence.accepted, true, stageEvidence.failedGates.join(','));
assert.equal(stageEvidence.normalizedEvents.length, 5);
assert.equal(stageEvidence.gpuHmrSuccess, false);
assert.equal(buildRuntimeBoundaryInputEvidence(adapterInput()).accepted, true);

const materializedLines = materializeRuntimeBoundaryEventLines(boundaryEvents({
  epochPublication: {
    fields: {
      host_identity_previous_generation: 1,
      host_identity_active_generation: 2,
    },
  },
}));
assert.equal(materializedLines.accepted, true, materializedLines.failedGates.join(','));
assert.equal(materializedLines.gpuHmrSuccess, false);
assert.equal(materializedLines.canSatisfyRuntimeProof, false);
assert.equal(materializedLines.runtimeBoundaryLines.length, 5);
assert.equal(materializedLines.boundaryLineHashes.length, 5);
assert.ok(materializedLines.runtimeBoundaryLines.some((line) => line.includes('[gpu-runtime-boundary] artifact_transport ')));
assert.ok(materializedLines.runtimeBoundaryLines.some((line) => line.includes('[gpu-runtime-boundary] dispatcher_epoch ')));
assert.ok(materializedLines.runtimeBoundaryLines.some((line) => line.includes('[gpu-runtime-boundary] synthi_gpu_launch ')));
assert.ok(materializedLines.runtimeBoundaryLines.some((line) => line.includes('[gpu-runtime-boundary] host_identity ')));
assert.ok(materializedLines.runtimeBoundaryLines.some((line) => line.includes('[gpu-runtime-boundary] output_oracle ')));
assert.ok(materializedLines.runtimeBoundaryLines.some((line) => line.includes('host_identity_previous_generation=1')));
assert.ok(materializedLines.bindingHash.startsWith('sha256:'));

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
const visualInputWithoutCaptureManifest = adapterInput({
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
  visualEvidenceArtifacts: visualEvidenceArtifactsFromFixture(visualFixture),
  allowedArtifactRoots: [visualFixture.artifactRoot],
});

const visualMissingCaptureManifest = buildRuntimeBoundaryProofAdapter(
  visualInputWithoutCaptureManifest,
);
assertVisualCaptureRefused(
  visualMissingCaptureManifest,
  'runtime_boundary_visual_capture_manifest_missing',
);

const captureManifest = callerSuppliedCaptureBoundaryManifest(
  visualInputWithoutCaptureManifest,
  visualFixture,
);
const visualInput = {
  ...visualInputWithoutCaptureManifest,
  visualOracleArtifacts: {
    ...visualInputWithoutCaptureManifest.visualOracleArtifacts,
    capture_manifest: captureManifest,
  },
};
const visualStageEvidence = buildRuntimeBoundaryStageEvidence(visualInput.runtimeBoundaryEvents);
assert.equal(visualStageEvidence.accepted, true, visualStageEvidence.failedGates.join(','));
assert.equal(buildRuntimeBoundaryInputEvidence(visualInput).accepted, true);
const preliminaryRuntimeBindingGate =
  'runtime_boundary_visual_capture_preliminary_runtime_binding_material_incomplete';
const visualRefused = buildRuntimeBoundaryProofAdapter(visualInput);
assertVisualCaptureRefused(visualRefused, preliminaryRuntimeBindingGate);
assert.ok(
  !visualRefused.failedGates.includes('runtime_boundary_visual_capture_allowed_artifact_roots_missing'),
  visualRefused.failedGates.join(','),
);
assert.ok(
  !visualRefused.failedGates.includes(
    'runtime_boundary_visual_capture_after_image_path_outside_allowed_artifact_roots',
  ),
  visualRefused.failedGates.join(','),
);
assert.equal(visualRefused.gpuHmrSuccess, false, 'adapter facet must stay evidence-only for visual proof');
assert.equal(visualInput.visualOracleArtifacts.visual_capture_runtime_binding, undefined);
for (const field of Object.keys(CALLER_RUNTIME_PROOF_CLAIMS)) {
  assert.ok(
    visualRefused.failedGates.includes(
      `runtime_boundary_visual_capture_preliminary_${field}_missing`,
    ),
    visualRefused.failedGates.join(','),
  );
}

for (const [field, value] of Object.entries({
  runtime_proof_id: `gpu-runtime-proof:${HASH_D}`,
  runtime_proof_state: 'caller-asserted-runtime-proof',
  runtime_proof_accepted: false,
  runtime_proof_observed_at_ms: 1_150,
  hmr_observed_at_ms: 1_050,
})) {
  const result = buildRuntimeBoundaryProofAdapter(mutateCaptureManifest(
    visualInput,
    (manifest) => {
      const binding = structuredClone(manifest.frame_gate.evidence_binding);
      binding[field] = value;
      installCaptureEvidenceBinding(manifest, binding);
    },
  ));
  assertVisualCaptureRefused(result, preliminaryRuntimeBindingGate);
  const preliminaryRecord = result.runtimeProofArtifact?.derivedProofLedgerRecord ?? {};
  assert.equal(
    Object.prototype.hasOwnProperty.call(preliminaryRecord, field),
    false,
    `${field} must not be promoted from caller capture evidence`,
  );
}

const visualMissingAllowedRoots = buildRuntimeBoundaryProofAdapter({
  ...visualInput,
  allowedArtifactRoots: [],
});
assertVisualCaptureRefused(
  visualMissingAllowedRoots,
  'runtime_boundary_visual_capture_allowed_artifact_roots_missing',
);

const visualDirectPathEscape = buildRuntimeBoundaryProofAdapter(withAfterVisualArtifactPath(
  visualInput,
  visualFixture.directEscapeAfterImage,
));
assertVisualCaptureRefused(
  visualDirectPathEscape,
  'runtime_boundary_visual_capture_after_image_path_outside_allowed_artifact_roots',
);

const visualSymlinkEscape = buildRuntimeBoundaryProofAdapter(withAfterVisualArtifactPath(
  visualInput,
  visualFixture.symlinkEscapeAfterImage,
));
assertVisualCaptureRefused(
  visualSymlinkEscape,
  'runtime_boundary_visual_capture_after_image_path_outside_allowed_artifact_roots',
);

const visualWrongImageHash = buildRuntimeBoundaryProofAdapter(mutateCaptureManifest(
  visualInput,
  (manifest) => {
    manifest.image_sha256 = HASH_D;
  },
));
assertVisualCaptureRefused(
  visualWrongImageHash,
  'runtime_boundary_visual_capture_manifest_image_hash_mismatch',
);

const visualWrongRuntimeSession = buildRuntimeBoundaryProofAdapter(mutateCaptureManifest(
  visualInput,
  (manifest) => {
    const binding = structuredClone(manifest.frame_gate.evidence_binding);
    binding.runtime_session_id = 'runtime-session-stale';
    installCaptureEvidenceBinding(manifest, binding);
  },
));
assertVisualCaptureRefused(
  visualWrongRuntimeSession,
  preliminaryRuntimeBindingGate,
);

const visualWrongProcess = buildRuntimeBoundaryProofAdapter(mutateCaptureManifest(
  visualInput,
  (manifest) => {
    const binding = structuredClone(manifest.frame_gate.evidence_binding);
    binding.process_id = 'pid-stale';
    installCaptureEvidenceBinding(manifest, binding);
  },
));
assertVisualCaptureRefused(
  visualWrongProcess,
  preliminaryRuntimeBindingGate,
);

const visualPreDispatchFrame = buildRuntimeBoundaryProofAdapter(mutateCaptureManifest(
  visualInput,
  (manifest) => {
    manifest.frame_ts_ms = 1_100;
    manifest.frame_gate.captured_ts_ms = 1_100;
  },
));
assertVisualCaptureRefused(
  visualPreDispatchFrame,
  preliminaryRuntimeBindingGate,
);

const visualPreGateCapture = buildRuntimeBoundaryProofAdapter(mutateCaptureManifest(
  visualInput,
  (manifest) => {
    manifest.capture_ts_ms = 1_299;
  },
));
assertVisualCaptureRefused(
  visualPreGateCapture,
  preliminaryRuntimeBindingGate,
);

const visualDeclaredOnlyOracle = buildRuntimeBoundaryProofAdapter({
  ...visualInput,
  visualEvidenceArtifacts: [],
});
assert.equal(visualDeclaredOnlyOracle.accepted, false);
assert.equal(visualDeclaredOnlyOracle.runtimeProofArtifact, null);
assert.ok(
  visualDeclaredOnlyOracle.failedGates.includes('runtime_boundary_visual_evidence_artifacts_missing'),
  visualDeclaredOnlyOracle.failedGates.join(','),
);

const visualExpectedHashOnly = buildRuntimeBoundaryProofAdapter({
  ...visualInput,
  visualEvidenceArtifacts: visualEvidenceArtifactsFromFixture(visualFixture).map((artifact) =>
    artifact.role === 'before'
      ? {
          ...artifact,
          contentHash: null,
          content_hash: null,
          expectedHash: visualFixture.beforeImageHash,
          expected_hash: visualFixture.beforeImageHash,
        }
      : artifact
  ),
});
assert.equal(visualExpectedHashOnly.accepted, false);
assert.equal(visualExpectedHashOnly.runtimeProofArtifact, null);
assert.ok(
  visualExpectedHashOnly.failedGates.includes('runtime_boundary_visual_evidence_before_content_hash_missing'),
  visualExpectedHashOnly.failedGates.join(','),
);

const visualUnverifiedContentHash = buildRuntimeBoundaryProofAdapter({
  ...visualInput,
  visualEvidenceArtifacts: visualEvidenceArtifactsFromFixture(visualFixture).map((artifact) =>
    artifact.role === 'after'
      ? {
          ...artifact,
          contentHashVerified: false,
          content_hash_verified: false,
        }
      : artifact
  ),
});
assert.equal(visualUnverifiedContentHash.accepted, false);
assert.equal(visualUnverifiedContentHash.runtimeProofArtifact, null);
assert.ok(
  visualUnverifiedContentHash.failedGates.includes('runtime_boundary_visual_evidence_after_content_hash_unverified'),
  visualUnverifiedContentHash.failedGates.join(','),
);

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

const missingSourceManifestHash = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  sourceManifestHash: null,
  source_manifest_hash: null,
});
assert.equal(missingSourceManifestHash.accepted, false);
assert.equal(missingSourceManifestHash.runtimeProofArtifact, null);
assert.ok(
  missingSourceManifestHash.failedGates.includes('runtime_boundary_source_manifest_hash_missing'),
  missingSourceManifestHash.failedGates.join(','),
);

const unverifiedSourceManifestHash = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  sourceManifestHashVerified: false,
  source_manifest_hash_verified: false,
});
assert.equal(unverifiedSourceManifestHash.accepted, false);
assert.equal(unverifiedSourceManifestHash.runtimeProofArtifact, null);
assert.ok(
  unverifiedSourceManifestHash.failedGates.includes('runtime_boundary_source_manifest_hash_unverified'),
  unverifiedSourceManifestHash.failedGates.join(','),
);

const missingSourceIdentityEvidenceRefs = buildRuntimeBoundaryProofAdapter({
  ...adapterInput(),
  sourceIdentityEvidenceRefs: [],
  source_identity_evidence_refs: [],
});
assert.equal(missingSourceIdentityEvidenceRefs.accepted, false);
assert.equal(missingSourceIdentityEvidenceRefs.runtimeProofArtifact, null);
assert.ok(
  missingSourceIdentityEvidenceRefs.failedGates.includes('runtime_boundary_source_identity_evidence_refs_missing'),
  missingSourceIdentityEvidenceRefs.failedGates.join(','),
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
