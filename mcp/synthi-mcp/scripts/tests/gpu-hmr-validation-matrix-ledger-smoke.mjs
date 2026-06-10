#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  collectGpuHmrValidationMatrixLedger,
  GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
} from '../lib/gpu-hmr-validation-matrix-ledger.mjs';
import {
  assessGeneratedGpuSplitGranularity,
  verifyGeneratedGpuSplitDeterministicFission,
} from '../lib/gpu-hmr-generated-split-granularity.mjs';

const PNG_HEADER = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

async function writePng(filePath) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, PNG_HEADER);
}

const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'gpu-hmr-validation-matrix-'));
const mcpRoot = path.join(tmpRoot, 'mcp', 'synthi-mcp');
const logsRoot = path.join(mcpRoot, '.gpu-hmr-test-logs');
const artifactsRoot = path.join(mcpRoot, '.gpu-hmr-test-artifacts');

const visualDir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow');
await writePng(path.join(visualDir, 'before-hmr-first.png'));
await writePng(path.join(visualDir, 'after-hmr-first.png'));
await writePng(path.join(visualDir, 'before-after-diff.png'));
await writeJson(path.join(visualDir, 'agent-split-results.json'), [
  { name: 'fixture', status: 'pass', detail: 'flow' },
  { name: 'worker used GPU split endpoint', status: 'pass', detail: 'GPU markers detected' },
  { name: 'generated split contains HMR ABI', status: 'pass', detail: 'shared.h, core.cpp, device.hip' },
  { name: 'generated split HMR granularity', status: 'pass', detail: 'claim=device_translation_unit_hmr rejected_claims=per_kernel_hmr' },
  {
    name: 'mcp wait_hmr proof gate',
    status: 'pass',
    detail: JSON.stringify({
      gpu_proof_validation: {
        satisfied: true,
        proofLedgerValidation: {
          proofId: 'gpu-ledger-proof:sha256:synthetic',
          gpuHmrSuccess: true,
          failedInvariants: [],
        },
        runtimeProofArtifactValidation: {
          accepted: true,
          failedGates: [],
        },
      },
      gpu_proof_telemetry: {
        proofId: 'gpu-runtime-proof:sha256:synthetic',
      },
      timingMetrics: {
        metricClock: 'monotonic_ns',
        metricScope: 'hot_delta_1',
        cacheState: 'compiler_cache_warm',
      },
    }),
  },
  { name: 'device-only GPU HMR observed', status: 'pass', detail: '[gpu-reload] plan=device_only' },
  {
    name: 'mcp screenshot before hmr',
    status: 'pass',
    detail: `images=${path.join(visualDir, 'before-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot after hmr',
    status: 'pass',
    detail: `images=${path.join(visualDir, 'after-hmr-first.png')}`,
  },
  {
    name: 'mcp screenshot visual delta',
    status: 'pass',
    detail: `changed=4.20% mean_abs=6.50 selected_delta_ms=123 diff=${path.join(visualDir, 'before-after-diff.png')}`,
  },
  { name: 'runner stayed alive after GPU HMR', status: 'pass', detail: 'no runner crash marker' },
]);

const runModeProofBase = {
  schemaVersion: 'synthi.gpu.hmr.agent_split_run_mode_proof.v1',
  backend: 'hip',
  targetId: 'flow',
  profileId: 'flow',
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  visualArtifacts: {
    beforeImage: path.join(visualDir, 'before-hmr-first.png'),
    afterImage: path.join(visualDir, 'after-hmr-first.png'),
    diffImage: path.join(visualDir, 'before-after-diff.png'),
  },
  visualMetrics: {
    changedPixelRatio: 0.042,
    meanAbsDelta8bit: 6.5,
    visiblePixelCount: 2000,
  },
};

function waitProofValidation(proofId, runtimeProofId) {
  return {
    gpuProofValidation: {
      satisfied: true,
      proofLedgerValidation: {
        proofId,
        gpuHmrSuccess: true,
        failedInvariants: [],
      },
      runtimeProofArtifactValidation: {
        accepted: true,
        failedGates: [],
      },
    },
    gpuProofTelemetry: {
      proofId: runtimeProofId,
    },
  };
}

await writeJson(path.join(visualDir, 'run-mode-cold.json'), {
  ...runModeProofBase,
  proofId: 'agent-split-run-mode-proof:sha256:cold',
  coldSplitProven: true,
  cold_split_proven: true,
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'cold',
    cacheState: 'clean',
    editId: 'initial-ai-split',
    editHash: 'sha256:cold-split',
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:synthetic-hot1', 'gpu-runtime-proof:sha256:synthetic-hot1'),
  proofId: 'agent-split-run-mode-proof:sha256:hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot1',
    editHash: 'sha256:hot1',
  },
});

await writeJson(path.join(visualDir, 'run-mode-hot2.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:synthetic-hot2', 'gpu-runtime-proof:sha256:synthetic-hot2'),
  proofId: 'agent-split-run-mode-proof:sha256:hot2',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:hot2',
    editHash: 'sha256:hot2',
    editKind: 'different_gpu_edit',
    differentEdit: true,
  },
});

await writeJson(path.join(visualDir, 'negative-edit-refusal.json'), {
  schemaVersion: 'synthi.gpu.hmr.agent_split_negative_edit_refusal.v1',
  proofId: 'agent-split-negative-edit-refusal:sha256:synthetic',
  backend: 'hip',
  targetId: 'flow',
  profileId: 'flow',
  acceptedForGpuHmr: false,
  gpuHmrSuccess: false,
  cpuHmrUsed: false,
  fullRebuildUsed: false,
  processRestarted: false,
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'negative-edit:abi-layout',
    editHash: 'sha256:negative-edit',
    editKind: 'negative_edit',
    differentEdit: true,
  },
  reasons: ['abi_compatibility_class_layout_changed', 'gpu_hmr_rejected_before_load'],
});

const fissionManifest = {
  gpu: {
    vendor: 'rocm',
    device_roles: [
      { id: 'device.integrator', path: 'gpu/integrator.hip', compiler: 'hipcc', arch: ['gfx1201'] },
      { id: 'device.shading', path: 'gpu/shading.hip', compiler: 'hipcc', arch: ['gfx1201'] },
    ],
  },
};
const fissionFiles = {
  'gpu/integrator.hip': '__global__ void integrate(float* out) {}',
  'gpu/shading.hip': '__global__ void shade(float* out) {}',
};
const fissionAssessment = assessGeneratedGpuSplitGranularity({
  manifest: fissionManifest,
  files: fissionFiles,
});
const fissionReport = verifyGeneratedGpuSplitDeterministicFission({
  assessment: fissionAssessment,
  selectedPath: 'gpu/shading.hip',
  changedPaths: ['gpu/shading.hip'],
  selectedArtifact: {
    sourcePath: 'gpu/shading.hip',
    proofIds: [
      'gpu-runtime-proof:sha256:synthetic-fission',
      'gpu-ledger-proof:sha256:synthetic-fission',
    ],
    runtimeProofAccepted: true,
  },
  outputOracleContract: {
    oracleId: 'oracle:generated-split-visual:sha256:synthetic-fission',
    kind: 'visual',
    target: 'framebuffer',
  },
  unaffectedArtifactHashesBefore: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  unaffectedArtifactHashesAfter: {
    'gpu/integrator.hip': 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  },
  compilerArgsHash: 'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
});
await writeJson(path.join(visualDir, 'generated-split-deterministic-fission.json'), fissionReport);

await writeJson(path.join(artifactsRoot, 'opencl-preflight', 'opencl-proof.json'), {
  schema: 'synthi.gpu_hmr.opencl_preflight.v1',
  slug: 'synthetic-opencl-preflight',
  classification: {
    openclAccepted: false,
    resultState: 'opencl-runtime-rejected',
    unsupportedReasons: ['opencl_vendor_icd_missing'],
  },
  acceptance: {
    acceptedForOpenClRuntimePreflight: false,
    acceptedForOpenClOutputProof: false,
    gpuHmrSuccess: true,
    noShimApplied: true,
    noVendorIcdSynthesized: true,
    noSymlinkApplied: true,
  },
  proofId: 'opencl-preflight-proof:sha256:synthetic',
});

await writeJson(path.join(logsRoot, 'external-projects', 'bevy-wgsl-shader-material-rejection-proof.json'), {
  schemaVersion: 'synthi.gpu.hmr.external_project_rejection.v1',
  profileId: 'bevy-wgsl-shader-material',
  proofMode: 'mcp_preview',
  status: 'fail',
  rejection: {
    accepted: false,
    reasons: [
      'external_profile_failed',
      'mcp_no_decoded_frames',
      'mcp_request_timeout',
      'visual_frame_missing',
      'visual_oracle_not_accepted',
    ],
  },
  proofId: 'external-rejection-proof:sha256:synthetic-bevy',
});

await writeJson(path.join(artifactsRoot, 'webgpu-runtime-visual-proof', 'forged-webgpu-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu' },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
});

const forgedWebGpuVisualDir = path.join(artifactsRoot, 'webgpu-runtime-visual-proof');
await writePng(path.join(forgedWebGpuVisualDir, 'forged-before.png'));
await writePng(path.join(forgedWebGpuVisualDir, 'forged-after.png'));
await writePng(path.join(forgedWebGpuVisualDir, 'forged-diff.png'));
await writeJson(path.join(forgedWebGpuVisualDir, 'forged-webgpu-query-only-proof.json'), {
  schema: 'synthi.gpu_hmr.webgpu_runtime_visual_proof.v1',
  proofId: 'webgpu-runtime-visual-proof:sha256:query-only-forged',
  gpuHmrSuccess: true,
  profile: { id: 'forged-webgpu-query-only' },
  visualOracleArtifacts: {
    beforeImage: path.join(forgedWebGpuVisualDir, 'forged-before.png'),
    afterImage: path.join(forgedWebGpuVisualDir, 'forged-after.png'),
    diffImage: path.join(forgedWebGpuVisualDir, 'forged-diff.png'),
  },
  visualThresholdValidation: { accepted: true },
  browser: { processContinuity: { accepted: true, processRestarted: false } },
  nativeWebGpuApiEvidence: { accepted: true },
  metrics: {
    changedPixelRatio: 0.2,
    meanAbsDelta8bit: 12,
  },
  proofLedgerQuery: {
    schemaVersion: 'synthi.gpu.hmr.proof_ledger_query.v1',
    proofId: 'gpu-ledger-proof:sha256:forged-query-only',
    gpuHmrSuccess: true,
    failedInvariants: [],
  },
});

const ledger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [logsRoot, artifactsRoot],
  generatedAt: '2026-06-09T00:00:00.000Z',
  includeUnproven: true,
});

assert.equal(ledger.schemaVersion, GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION);
assert.equal(ledger.query.accepted, true);
assert.ok(ledger.proofId.startsWith('gpu-validation-matrix-ledger:sha256:'));

const acceptedFlow = ledger.rows.find((row) => row.targetId === 'flow');
assert.equal(acceptedFlow?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(acceptedFlow.acceptedForGpuHmr, true);
assert.equal(acceptedFlow.visual.accepted, true);
assert.equal(acceptedFlow.runMode.accepted, true);
assert.equal(acceptedFlow.runMode.metricScope, 'hot_delta_1');
assert.equal(acceptedFlow.visual.changedPixelRatio, 0.042);
assert.equal(acceptedFlow.ledger.proofId, 'gpu-ledger-proof:sha256:synthetic');

const opencl = ledger.rows.find((row) => row.backend === 'opencl');
assert.equal(opencl?.matrixOutcome, 'refusal_proven');
assert.equal(opencl.acceptedForGpuHmr, false);
assert.equal(opencl.gpuHmrSuccess, false);
assert.equal(opencl.refusalProven, true);

const bevy = ledger.rows.find((row) => row.backend === 'bevy_wgsl');
assert.equal(bevy?.matrixOutcome, 'refusal_proven');
assert.equal(bevy.acceptedForGpuHmr, false);
assert.ok(bevy.reasons.includes('mcp_no_decoded_frames'));
assert.ok(bevy.reasons.includes('mcp_request_timeout'));
assert.ok(bevy.reasons.includes('visual_frame_missing'));

const forgedWebGpu = ledger.rows.find((row) => row.targetId === 'forged-webgpu');
assert.equal(forgedWebGpu?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpu.acceptedForGpuHmr, false);
assert.ok(forgedWebGpu.reasons.includes('visual_artifacts_not_readable'));

const forgedWebGpuQueryOnly = ledger.rows.find((row) => row.targetId === 'forged-webgpu-query-only');
assert.equal(forgedWebGpuQueryOnly?.matrixOutcome, 'unproven');
assert.equal(forgedWebGpuQueryOnly.acceptedForGpuHmr, false);
assert.equal(forgedWebGpuQueryOnly.visual.accepted, true);
assert.equal(forgedWebGpuQueryOnly.ledger.present, false);
assert.equal(forgedWebGpuQueryOnly.ledger.source, 'supplied_query');
assert.ok(forgedWebGpuQueryOnly.reasons.includes('proof_ledger_record_missing'));

assert.equal(ledger.summary.acceptedFullRuntimeGpuHmrRows, 3);
assert.equal(ledger.summary.refusalProvenRows, 3);
assert.ok(ledger.summary.unprovenRows >= 1);

const coverageById = new Map(ledger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(coverageById.get('flow_visual_gpu_path')?.status, 'accepted');
assert.equal(coverageById.get('opencl_dispatch_readback')?.status, 'refused');
assert.equal(coverageById.get('bevy_file_loaded_wgsl')?.status, 'refused');
assert.equal(coverageById.get('webgpu_scoped_runtime_visual')?.status, 'missing');
assert.equal(coverageById.get('per_kernel_smallest_safe_fission')?.status, 'accepted');
assert.equal(coverageById.get('per_target_run_modes')?.status, 'accepted');
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:cold_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_1_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_2_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('hip:flow:hot_delta_2_different_edit_evidence_missing'));
assert.ok(!coverageById.get('per_target_run_modes')?.openGaps.includes('negative_edit_refusal_evidence_missing'));

const coldRunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'cold'
);
assert.equal(coldRunMode?.matrixOutcome, 'cold_split_proven');
assert.equal(coldRunMode.acceptedForGpuHmr, false);

const hot2RunMode = ledger.rows.find((row) =>
  row.targetId === 'flow' && row.proofMode === 'run_mode_proof' && row.runMode.metricScope === 'hot_delta_2'
);
assert.equal(hot2RunMode?.matrixOutcome, 'full_runtime_gpu_hmr');
assert.equal(hot2RunMode.runMode.differentEdit, true);

const negativeEdit = ledger.rows.find((row) => row.proofMode === 'negative_edit');
assert.equal(negativeEdit?.matrixOutcome, 'refusal_proven');

const duplicateHot2Dir = path.join(logsRoot, 'agent-split-artifacts', 'synthetic-flow-duplicate-hot2');
await writePng(path.join(duplicateHot2Dir, 'before.png'));
await writePng(path.join(duplicateHot2Dir, 'after.png'));
await writePng(path.join(duplicateHot2Dir, 'diff.png'));
await writeJson(path.join(duplicateHot2Dir, 'hot1.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:duplicate-hot1', 'gpu-runtime-proof:sha256:duplicate-hot1'),
  targetId: 'duplicate-hot2',
  profileId: 'duplicate-hot2',
  proofId: 'agent-split-run-mode-proof:sha256:duplicate-hot1',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(duplicateHot2Dir, 'before.png'),
    afterImage: path.join(duplicateHot2Dir, 'after.png'),
    diffImage: path.join(duplicateHot2Dir, 'diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_1',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot1',
    editHash: 'sha256:same-edit',
  },
});
await writeJson(path.join(duplicateHot2Dir, 'hot2.json'), {
  ...runModeProofBase,
  ...waitProofValidation('gpu-ledger-proof:sha256:duplicate-hot2', 'gpu-runtime-proof:sha256:duplicate-hot2'),
  targetId: 'duplicate-hot2',
  profileId: 'duplicate-hot2',
  proofId: 'agent-split-run-mode-proof:sha256:duplicate-hot2',
  acceptedForGpuHmr: true,
  gpuHmrSuccess: true,
  visualArtifacts: {
    beforeImage: path.join(duplicateHot2Dir, 'before.png'),
    afterImage: path.join(duplicateHot2Dir, 'after.png'),
    diffImage: path.join(duplicateHot2Dir, 'diff.png'),
  },
  runMode: {
    metricClock: 'monotonic_ns',
    metricScope: 'hot_delta_2',
    cacheState: 'compiler_cache_warm',
    editId: 'source-edit:duplicate-hot2',
    editHash: 'sha256:same-edit',
    editKind: 'gpu_artifact_edit',
    differentEdit: false,
  },
});
const duplicateLedger = await collectGpuHmrValidationMatrixLedger({
  repoRoot: tmpRoot,
  mcpRoot,
  roots: [duplicateHot2Dir],
  generatedAt: '2026-06-09T00:00:01.000Z',
  includeUnproven: true,
});
const duplicateCoverage = new Map(duplicateLedger.summary.planCoverage.map((entry) => [entry.id, entry]));
assert.equal(duplicateCoverage.get('per_target_run_modes')?.status, 'missing');
assert.ok(duplicateCoverage.get('per_target_run_modes')?.openGaps.includes(
  'hip:duplicate-hot2:hot_delta_2_different_edit_evidence_missing',
));

const fissionRow = ledger.rows.find((row) => row.matrixOutcome === 'deterministic_fission_proven');
assert.equal(fissionRow?.acceptedForGpuHmr, false);
assert.equal(fissionRow.proofChainAccepted, true);
assert.equal(fissionRow.acceptanceClass, 'smallest_safe_per_kernel_fission');

console.log(JSON.stringify({
  ok: true,
  schemaVersion: GPU_HMR_VALIDATION_MATRIX_LEDGER_SCHEMA_VERSION,
  proofId: ledger.proofId,
  rows: ledger.rows.length,
}, null, 2));
