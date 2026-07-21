#!/usr/bin/env node
import assert from 'node:assert/strict';
import { mkdtemp, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { writeArtifactToCas } from '../lib/gpu-hmr-artifact-cas.mjs';
import {
  GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION,
  GPU_HMR_VISUAL_INCREMENTAL_EVIDENCE_BINDING_SCHEMA_VERSION,
  computeVisualWorkerResultProofHash,
  computeAsyncVisualProof,
  validateVisualWorkerResultProofHash,
} from '../lib/gpu-hmr-visual-proof-worker.mjs';

const tmp = await mkdtemp(path.join(os.tmpdir(), 'synthi-visual-proof-worker-'));
const casRoot = path.join(tmp, 'cas');
const beforePng = await pngFromRegions({
  width: 32,
  height: 32,
  regions: [
    { x: 8, y: 8, width: 8, height: 8, rgba: [60, 60, 60, 255] },
  ],
});
const afterPng = await pngFromRegions({
  width: 32,
  height: 32,
  regions: [
    { x: 8, y: 8, width: 8, height: 8, rgba: [220, 30, 30, 255] },
  ],
});
const outsideRoiAfterPng = await pngFromRegions({
  width: 32,
  height: 32,
  regions: [
    { x: 24, y: 24, width: 6, height: 6, rgba: [30, 220, 80, 255] },
  ],
});

const beforeManifest = await writeArtifactToCas(beforePng, {
  artifactRoot: casRoot,
  mediaType: 'image/png',
  role: 'before_frame',
  sessionNamespace: 'visual-worker-smoke',
  producer: { name: 'visual_worker_smoke' },
});
const afterManifest = await writeArtifactToCas(afterPng, {
  artifactRoot: casRoot,
  mediaType: 'image/png',
  role: 'after_frame',
  sessionNamespace: 'visual-worker-smoke',
  producer: { name: 'visual_worker_smoke' },
});
const unchangedAfterManifest = await writeArtifactToCas(beforePng, {
  artifactRoot: casRoot,
  mediaType: 'image/png',
  role: 'after_frame',
  sessionNamespace: 'visual-worker-smoke',
  producer: { name: 'visual_worker_smoke' },
});
const outsideRoiAfterManifest = await writeArtifactToCas(outsideRoiAfterPng, {
  artifactRoot: casRoot,
  mediaType: 'image/png',
  role: 'after_frame',
  sessionNamespace: 'visual-worker-smoke',
  producer: { name: 'visual_worker_smoke' },
});

const diffPath = path.join(tmp, 'diff.png');
const proof = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: afterManifest },
  diffPath,
  tileSize: 8,
}, {
  allowedRoots: [casRoot],
  allowedOutputRoots: [tmp],
  timeoutMs: 30000,
});
assert.equal(proof.schemaVersion, GPU_HMR_ASYNC_VISUAL_PROOF_WORKER_SCHEMA_VERSION);
assert.equal(proof.eventType, 'proof_ready');
assert.equal(proof.accepted, true);
assert.equal(proof.acceptedAsAsyncVisualMetrics, true);
assert.equal(proof.acceptedForGpuHmr, false);
assert.equal(proof.gpuHmrSuccess, false);
assert.ok(proof.inputArtifacts.before.supportPath);
assert.equal(proof.inputArtifacts.before.localPath, null);
assert.equal(proof.inputArtifacts.before.pathReusableAsProof, false);
assert.equal(proof.inputArtifacts.before.freshReadMatchesSnapshot, true);
assert.equal(
  proof.inputArtifacts.before.freshReadHash,
  proof.inputArtifacts.before.casValidation.verifiedByteHash
    ?? proof.inputArtifacts.before.casValidation.readableContentHash,
);
assert.equal(
  proof.inputArtifacts.before.freshReadByteLength,
  proof.inputArtifacts.before.casValidation.verifiedByteLength
    ?? proof.inputArtifacts.before.casValidation.readableByteLength,
);
assert.match(proof.proofHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(proof.proofHash, proof.proof_hash);

const proofHashFixture = {
  accepted: true,
  eventType: 'proof_ready',
  metrics: { changedRatio: 0.25, visiblePixelCount: 256 },
};
proofHashFixture.proofHash = computeVisualWorkerResultProofHash(proofHashFixture);
proofHashFixture.proof_hash = proofHashFixture.proofHash;
assert.equal(validateVisualWorkerResultProofHash(proofHashFixture).accepted, true);
assert.deepEqual(
  validateVisualWorkerResultProofHash({
    ...proofHashFixture,
    metrics: { ...proofHashFixture.metrics, changedRatio: 0.75 },
  }).failures,
  ['visual_worker_proof_hash_mismatch'],
);
assert.deepEqual(
  validateVisualWorkerResultProofHash({
    ...proofHashFixture,
    proofHash: undefined,
    proof_hash: undefined,
  }).failures,
  ['visual_worker_proof_hash_missing'],
);
assert.deepEqual(
  validateVisualWorkerResultProofHash({
    ...proofHashFixture,
    proof_hash: `sha256:${'f'.repeat(64)}`,
  }).failures,
  ['visual_worker_proof_hash_alias_mismatch'],
);
assert.equal(proof.worker.offMainThread, true);
assert.match(proof.worker.executableHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(proof.worker.executableHash, proof.worker.executable_hash);
assert.equal(proof.worker.executableHash, proof.worker.executableManifestHash);
assert.equal(proof.worker.executableModuleCount, 3);
assert.match(proof.worker.nativeDependencyManifestHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(proof.worker.nativeDependencyManifestHash, proof.worker.native_dependency_manifest_hash);
assert.equal(
  proof.worker.nativeDependencyManifestSchemaVersion,
  'synthi.gpu_hmr.visual_worker_native_dependency_manifest.v1',
);
assert.equal(proof.worker.nativeDependencyCount, 1);
assert.equal(proof.worker.nativeDependencyManifest.dependencies[0].packageName, 'sharp');
assert.equal(proof.worker.nativeDependencyManifest.dependencies[0].role, 'native_image_decode_diff_backend');
assert.ok(proof.worker.nativeDependencyManifest.dependencies[0].runtimeVersionsHash);
assert.ok(proof.worker.nativeDependencyManifest.dependencies[0].runtimeVersions.sharp);
assert.deepEqual(
  proof.worker.executableManifest.modules.map((moduleEntry) => moduleEntry.role),
  ['visual_worker_entry', 'visual_worker_client', 'artifact_cas_helper'],
);
assert.equal(proof.incremental.fullFrameDiffComputed, true);
assert.equal(proof.incremental.tileHashing, true);
assert.ok(proof.changedRatio > 0);
assert.ok(proof.meanAbs > 0);
assert.ok(proof.metrics.changedPixelsThreshold4 > 0);
assert.ok(proof.metrics.changedPixelRatioThreshold4 > 0);
assert.ok(proof.metrics.meanAbsDelta8bit > 0);
assert.ok(proof.metrics.visiblePixelCount > 0);
assert.ok(proof.metrics.meanLuma8bit > 0);
assert.ok(proof.tileEvidence.changedTileCount > 0);
assert.match(proof.inputHashes.beforeRawFrameHash, /^sha256:[a-f0-9]{64}$/);
assert.match(proof.inputHashes.afterRawFrameHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(proof.inputHashes.beforeRawFrameHash, proof.inputHashes.beforeRawHash);
assert.equal(proof.inputHashes.afterRawFrameHash, proof.inputHashes.afterRawHash);
assert.match(proof.tileEvidence.tileListHash, /^sha256:[a-f0-9]{64}$/);
assert.match(proof.tileEvidence.bindingHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(proof.tileEvidence.binding.schemaVersion, GPU_HMR_VISUAL_INCREMENTAL_EVIDENCE_BINDING_SCHEMA_VERSION);
assert.equal(proof.tileEvidence.binding.evidenceKind, 'tile_hash_grid');
assert.equal(proof.tileEvidence.binding.bindingHash, proof.tileEvidence.bindingHash);
assert.equal(proof.tileEvidence.binding.beforeEncodedHash, proof.inputHashes.beforeEncodedHash);
assert.equal(proof.tileEvidence.binding.afterEncodedHash, proof.inputHashes.afterEncodedHash);
assert.equal(proof.tileEvidence.binding.beforeRawFrameHash, proof.inputHashes.beforeRawFrameHash);
assert.equal(proof.tileEvidence.binding.afterRawFrameHash, proof.inputHashes.afterRawFrameHash);
assert.equal(proof.tileEvidence.binding.tileListHash, proof.tileEvidence.tileListHash);
assert.equal((await stat(diffPath)).isFile(), true);

const deterministicModeHash = `sha256:${'1'.repeat(64)}`;
const deterministicBoundProof = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: afterManifest },
  roi: { x: 8, y: 8, width: 8, height: 8 },
  deterministicVisualModeHash: deterministicModeHash,
  tileSize: 8,
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(deterministicBoundProof.accepted, true);
assert.equal(deterministicBoundProof.inputHashes.deterministicVisualModeHash, deterministicModeHash);
assert.equal(
  deterministicBoundProof.tileEvidence.binding.deterministicVisualModeHash,
  deterministicModeHash,
);
assert.equal(
  deterministicBoundProof.roiEvidence.binding.deterministicVisualModeHash,
  deterministicModeHash,
);
assert.equal(
  deterministicBoundProof.roiEvidence.binding.tileBindingHash,
  deterministicBoundProof.tileEvidence.bindingHash,
);
assert.equal(
  deterministicBoundProof.roiEvidence.binding.roiBeforeHash,
  deterministicBoundProof.roiEvidence.beforeHash,
);
assert.equal(
  deterministicBoundProof.roiEvidence.binding.roiAfterHash,
  deterministicBoundProof.roiEvidence.afterHash,
);

const portableBeforeManifest = {
  ...beforeManifest,
  storage: {
    kind: beforeManifest.storage.kind,
    relativePath: beforeManifest.storage.relativePath,
  },
  manifestHash: null,
};
const portableAfterManifest = {
  ...afterManifest,
  storage: {
    kind: afterManifest.storage.kind,
    relativePath: afterManifest.storage.relativePath,
  },
  manifestHash: null,
};
const portableProof = await computeAsyncVisualProof({
  before: { casManifest: portableBeforeManifest },
  after: { casManifest: portableAfterManifest },
  tileSize: 8,
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(portableProof.accepted, true);
assert.equal(portableProof.acceptedForGpuHmr, false);
assert.ok(portableProof.changedRatio > 0);
assert.ok(portableProof.metrics.changedPixelsThreshold4 > 0);

const roiOutsideChangeFallback = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: outsideRoiAfterManifest },
  roi: { x: 0, y: 0, width: 8, height: 8 },
  allowRoiEarlyExit: true,
  tileSize: 8,
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(roiOutsideChangeFallback.accepted, true);
assert.equal(roiOutsideChangeFallback.incremental.roiEvaluated, true);
assert.equal(roiOutsideChangeFallback.incremental.deepDiffSkipped, false);
assert.equal(roiOutsideChangeFallback.incremental.fullFrameDiffComputed, true);
assert.equal(
  roiOutsideChangeFallback.incremental.skipReason,
  'roi_hash_unchanged_but_tiles_changed_outside_roi',
);
assert.equal(roiOutsideChangeFallback.incremental.roiEarlyExitBlocked, true);
assert.equal(roiOutsideChangeFallback.roiEvidence.changed, false);
assert.equal(roiOutsideChangeFallback.roiEvidence.earlyExitAccepted, false);
assert.match(roiOutsideChangeFallback.roiEvidence.bindingHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(
  roiOutsideChangeFallback.roiEvidence.binding.tileBindingHash,
  roiOutsideChangeFallback.tileEvidence.bindingHash,
);
assert.ok(roiOutsideChangeFallback.roiTileConsistency.changedTileCount > 0);
assert.ok(roiOutsideChangeFallback.roiTileConsistency.changedTilesOutsideRoiCount > 0);

const roiOutsideChangeNoTiles = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: outsideRoiAfterManifest },
  roi: { x: 0, y: 0, width: 8, height: 8 },
  allowRoiEarlyExit: true,
  tileHashing: false,
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(roiOutsideChangeNoTiles.accepted, true);
assert.equal(roiOutsideChangeNoTiles.incremental.roiEvaluated, true);
assert.equal(roiOutsideChangeNoTiles.incremental.tileHashing, false);
assert.equal(roiOutsideChangeNoTiles.incremental.deepDiffSkipped, false);
assert.equal(roiOutsideChangeNoTiles.incremental.fullFrameDiffComputed, true);
assert.equal(
  roiOutsideChangeNoTiles.incremental.skipReason,
  'roi_hash_unchanged_but_tile_evidence_missing',
);
assert.equal(roiOutsideChangeNoTiles.incremental.roiEarlyExitBlocked, true);
assert.equal(roiOutsideChangeNoTiles.roiEvidence.earlyExitAccepted, false);
assert.ok(roiOutsideChangeNoTiles.metrics.changedPixelsThreshold4 > 0);

const trueRoiSkip = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: unchangedAfterManifest },
  roi: { x: 0, y: 0, width: 8, height: 8 },
  allowRoiEarlyExit: true,
  tileSize: 8,
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(trueRoiSkip.accepted, true);
assert.equal(trueRoiSkip.incremental.roiEvaluated, true);
assert.equal(trueRoiSkip.incremental.deepDiffSkipped, true);
assert.equal(trueRoiSkip.incremental.fullFrameDiffComputed, false);
assert.equal(trueRoiSkip.incremental.skipReason, 'roi_hash_unchanged');
assert.equal(trueRoiSkip.incremental.roiEarlyExitSafe, true);
assert.equal(trueRoiSkip.incremental.roiEarlyExitBlocked, false);
assert.equal(trueRoiSkip.roiEvidence.changed, false);
assert.equal(trueRoiSkip.roiEvidence.earlyExitAccepted, true);
assert.match(trueRoiSkip.roiEvidence.bindingHash, /^sha256:[a-f0-9]{64}$/);
assert.equal(trueRoiSkip.roiEvidence.binding.evidenceKind, 'roi_hash');
assert.equal(trueRoiSkip.roiEvidence.binding.beforeRawFrameHash, trueRoiSkip.inputHashes.beforeRawFrameHash);
assert.equal(trueRoiSkip.roiEvidence.binding.afterRawFrameHash, trueRoiSkip.inputHashes.afterRawFrameHash);
assert.equal(trueRoiSkip.roiTileConsistency.changedTileCount, 0);

const roiFallback = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: afterManifest },
  roi: { x: 8, y: 8, width: 8, height: 8 },
  allowRoiEarlyExit: true,
  tileSize: 8,
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(roiFallback.accepted, true);
assert.equal(roiFallback.roiEvidence.changed, true);
assert.equal(roiFallback.incremental.fullFrameDiffComputed, true);

const requireRoi = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: afterManifest },
  requireRoiEvidence: true,
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(requireRoi.accepted, false);
assert.ok(requireRoi.reasons.includes('visual_worker_roi_required_missing'));

const forgedHashManifest = {
  ...beforeManifest,
  contentHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
};
const forgedHash = await computeAsyncVisualProof({
  before: { casManifest: forgedHashManifest },
  after: { casManifest: afterManifest },
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(forgedHash.accepted, false);
assert.ok(forgedHash.reasons.includes('before_cas_manifest_rejected'));

const forgedSuccessManifest = {
  ...beforeManifest,
  gpuHmrSuccess: true,
};
const forgedSuccess = await computeAsyncVisualProof({
  before: { casManifest: forgedSuccessManifest },
  after: { casManifest: afterManifest },
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(forgedSuccess.accepted, false);
assert.ok(forgedSuccess.reasons.includes('before_cas_manifest_rejected'));

const forgedSnakeCaseSuccessManifest = {
  ...beforeManifest,
  accepted_for_gpu_hmr: true,
  gpu_hmr_success: true,
};
const forgedSnakeCaseSuccess = await computeAsyncVisualProof({
  before: { casManifest: forgedSnakeCaseSuccessManifest },
  after: { casManifest: afterManifest },
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(forgedSnakeCaseSuccess.accepted, false);
assert.ok(forgedSnakeCaseSuccess.reasons.includes('before_cas_manifest_rejected'));

const forgedWorkerIdentity = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: afterManifest },
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
  expectedWorkerExecutableHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
});
assert.equal(forgedWorkerIdentity.accepted, false);
assert.equal(forgedWorkerIdentity.acceptedForGpuHmr, false);
assert.equal(forgedWorkerIdentity.gpuHmrSuccess, false);
assert.ok(forgedWorkerIdentity.reasons.includes('visual_worker_executable_hash_mismatch'));

const escapedManifest = {
  ...beforeManifest,
  storage: {
    ...beforeManifest.storage,
    localPath: path.join(tmp, 'outside.png'),
  },
};
const escapedPath = await computeAsyncVisualProof({
  before: { casManifest: escapedManifest },
  after: { casManifest: afterManifest },
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(escapedPath.accepted, false);
assert.ok(escapedPath.reasons.includes('before_cas_manifest_rejected'));

const directPathWithoutRoots = await computeAsyncVisualProof({
  before: { path: beforeManifest.storage.localPath },
  after: { path: afterManifest.storage.localPath },
}, {
  timeoutMs: 30000,
});
assert.equal(directPathWithoutRoots.accepted, false);
assert.ok(directPathWithoutRoots.reasons.includes('before_allowed_root_required_for_path'));
assert.ok(directPathWithoutRoots.reasons.includes('after_allowed_root_required_for_path'));

const diffPathWithoutOutputRoots = await computeAsyncVisualProof({
  before: { casManifest: beforeManifest },
  after: { casManifest: afterManifest },
  diffPath: path.join(tmp, 'unrooted-diff.png'),
}, {
  allowedRoots: [casRoot],
  timeoutMs: 30000,
});
assert.equal(diffPathWithoutOutputRoots.accepted, false);
assert.ok(diffPathWithoutOutputRoots.reasons.includes('visual_worker_diff_allowed_output_root_required'));

const timeout = await computeAsyncVisualProof({
  before: { bytesBase64: beforePng.toString('base64') },
  after: { bytesBase64: afterPng.toString('base64') },
}, {
  timeoutMs: 1,
  diagnosticDelayMs: 200,
});
assert.equal(timeout.accepted, false);
assert.ok(timeout.reasons.includes('visual_worker_timeout'));

const serialized = await computeAsyncVisualProof({
  before: { bytesBase64: beforePng.toString('base64') },
  after: { bytesBase64: afterPng.toString('base64') },
}, {
  timeoutMs: 30000,
});
assert.equal(serialized.accepted, true);
assert.equal(serialized.acceptedForGpuHmr, false);
assert.equal(serialized.inputArtifacts.before.transportKind, 'serialized_fallback');
assert.ok((await readFile(diffPath)).byteLength > 0);

const originalExecArgv = [...process.execArgv];
try {
  process.execArgv.push('--input-type=module');
  const inlineDiagnosticParentProof = await computeAsyncVisualProof({
    before: { casManifest: beforeManifest },
    after: { casManifest: afterManifest },
  }, {
    allowedRoots: [casRoot],
    timeoutMs: 30000,
  });
  assert.equal(inlineDiagnosticParentProof.accepted, true);
  assert.equal(inlineDiagnosticParentProof.acceptedForGpuHmr, false);
  assert.ok(!inlineDiagnosticParentProof.reasons.includes('visual_worker_error'));
} finally {
  process.execArgv.splice(0, process.execArgv.length, ...originalExecArgv);
}

async function pngFromRegions({ width, height, regions }) {
  const raw = Buffer.alloc(width * height * 4);
  for (let i = 0; i < raw.length; i += 4) {
    raw[i] = 4;
    raw[i + 1] = 6;
    raw[i + 2] = 8;
    raw[i + 3] = 255;
  }
  for (const region of regions) {
    for (let y = region.y; y < region.y + region.height; y += 1) {
      for (let x = region.x; x < region.x + region.width; x += 1) {
        const index = (y * width + x) * 4;
        raw[index] = region.rgba[0];
        raw[index + 1] = region.rgba[1];
        raw[index + 2] = region.rgba[2];
        raw[index + 3] = region.rgba[3];
      }
    }
  }
  return sharp(raw, {
    raw: {
      width,
      height,
      channels: 4,
    },
  }).png().toBuffer();
}
