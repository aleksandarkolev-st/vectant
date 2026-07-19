#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

import {
  GPU_HMR_SCREENSHOT_CAPTURE_BINDING_SCHEMA_VERSION,
  MCP_SCREENSHOT_CAPTURE_MANIFEST_SCHEMA_VERSION,
  verifyGpuHmrScreenshotCaptureBinding,
} from '../lib/gpu-hmr-screenshot-capture-binding.mjs';

const PNG_BYTES = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const FRAME_TIMESTAMP_MS = 1_750_000_000_000;
const CAPTURE_TIMESTAMP_MS = FRAME_TIMESTAMP_MS + 4;
const FRAME_SEQUENCE = 17;

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function metadataFor(bytes) {
  const imageSha256 = sha256(bytes);
  return {
    w: 1,
    h: 1,
    ts: FRAME_TIMESTAMP_MS,
    seq: FRAME_SEQUENCE,
    image_sha256: imageSha256,
    image_byte_length: bytes.length,
    mimeType: 'image/png',
    capture_manifest: {
      schema_version: MCP_SCREENSHOT_CAPTURE_MANIFEST_SCHEMA_VERSION,
      session_id: 'session:1',
      capture_event_id: 'capture:1',
      frame_event_id: 23,
      frame_seq: FRAME_SEQUENCE,
      frame_ts_ms: FRAME_TIMESTAMP_MS,
      capture_ts_ms: CAPTURE_TIMESTAMP_MS,
      image_sha256: imageSha256,
      image_byte_length: bytes.length,
      width: 1,
      height: 1,
    },
  };
}

function toolResultFor(bytes = PNG_BYTES, mutateMetadata = () => {}) {
  const metadata = metadataFor(bytes);
  mutateMetadata(metadata);
  return {
    content: [
      { type: 'image', data: bytes.toString('base64'), mimeType: 'image/png' },
      { type: 'text', text: JSON.stringify(metadata) },
    ],
    structuredContent: structuredClone(metadata),
  };
}

function assertSupportOnly(evidence) {
  assert.equal(evidence.acceptedForGpuHmr, false);
  assert.equal(evidence.gpuHmrSuccess, false);
  assert.equal(evidence.canSatisfyRuntimeProof, false);
  assert.equal(evidence.canSatisfyDispatchProof, false);
}

function assertRejected(evidence, expectedGate) {
  assert.equal(evidence.accepted, false);
  assert.equal(evidence.verified, false);
  assert.equal(evidence.acceptedAsScreenshotCaptureByteEvidence, false);
  assert.ok(
    evidence.failedGates.includes(expectedGate),
    `expected ${expectedGate}; got ${evidence.failedGates.join(',')}`,
  );
  assertSupportOnly(evidence);
}

const valid = verifyGpuHmrScreenshotCaptureBinding(toolResultFor());
assert.equal(valid.schemaVersion, GPU_HMR_SCREENSHOT_CAPTURE_BINDING_SCHEMA_VERSION);
assert.equal(valid.accepted, true);
assert.equal(valid.verified, true);
assert.equal(valid.acceptedAsScreenshotCaptureByteEvidence, true);
assert.equal(valid.captureBytesVerified, true);
assert.equal(valid.imageBlockCount, 1);
assert.equal(valid.imageSha256, sha256(PNG_BYTES));
assert.equal(valid.imageByteLength, PNG_BYTES.length);
assert.equal(valid.pngSignatureVerified, true);
assert.equal(valid.pngHeaderVerified, true);
assert.equal(valid.width, 1);
assert.equal(valid.height, 1);
assert.equal(valid.frameSeq, FRAME_SEQUENCE);
assert.equal(valid.frameTimestampMs, FRAME_TIMESTAMP_MS);
assert.equal(valid.captureTimestampMs, CAPTURE_TIMESTAMP_MS);
assert.equal(
  valid.captureManifestSchemaVersion,
  MCP_SCREENSHOT_CAPTURE_MANIFEST_SCHEMA_VERSION,
);
assert.deepEqual(valid.failedGates, []);
assertSupportOnly(valid);

const substitutedBytes = Buffer.from(PNG_BYTES);
substitutedBytes[substitutedBytes.length - 9] ^= 0x01;
const substitutedResult = toolResultFor();
substitutedResult.content[0].data = substitutedBytes.toString('base64');
const imageSubstitution = verifyGpuHmrScreenshotCaptureBinding(substitutedResult);
assertRejected(imageSubstitution, 'screenshot_metadata_image_sha256_mismatch');
assert.ok(
  imageSubstitution.failedGates.includes(
    'screenshot_capture_manifest_image_sha256_mismatch',
  ),
);

const forgedHash = verifyGpuHmrScreenshotCaptureBinding(toolResultFor(PNG_BYTES, (metadata) => {
  const declaration = `sha256:${'0'.repeat(64)}`;
  metadata.image_sha256 = declaration;
  metadata.capture_manifest.image_sha256 = declaration;
}));
assertRejected(forgedHash, 'screenshot_metadata_image_sha256_mismatch');

const forgedLength = verifyGpuHmrScreenshotCaptureBinding(toolResultFor(PNG_BYTES, (metadata) => {
  metadata.image_byte_length += 1;
  metadata.capture_manifest.image_byte_length += 1;
}));
assertRejected(forgedLength, 'screenshot_metadata_image_byte_length_mismatch');

const conflictingAliases = verifyGpuHmrScreenshotCaptureBinding(
  toolResultFor(PNG_BYTES, (metadata) => {
    metadata.capture_manifest.imageSha256 = `sha256:${'f'.repeat(64)}`;
  }),
);
assertRejected(conflictingAliases, 'screenshot_capture_alias_conflict');

const missingManifest = verifyGpuHmrScreenshotCaptureBinding(
  toolResultFor(PNG_BYTES, (metadata) => {
    delete metadata.capture_manifest;
  }),
);
assertRejected(missingManifest, 'screenshot_capture_manifest_missing');

const multipleImageResult = toolResultFor();
multipleImageResult.content.splice(1, 0, {
  type: 'image',
  data: PNG_BYTES.toString('base64'),
  mimeType: 'image/png',
});
const multipleImages = verifyGpuHmrScreenshotCaptureBinding(multipleImageResult);
assertRejected(multipleImages, 'screenshot_image_block_count_invalid');

const malformedBase64Result = toolResultFor();
malformedBase64Result.content[0].data = 'not+canonical===';
const malformedBase64 = verifyGpuHmrScreenshotCaptureBinding(malformedBase64Result);
assertRejected(malformedBase64, 'screenshot_image_base64_invalid');

const nonPngBytes = Buffer.from('ordinary bytes with matching declarations', 'utf8');
const nonPng = verifyGpuHmrScreenshotCaptureBinding(toolResultFor(nonPngBytes));
assertRejected(nonPng, 'screenshot_image_png_signature_invalid');

console.log(JSON.stringify({
  ok: true,
  schemaVersion: valid.schemaVersion,
  validBytesVerified: valid.captureBytesVerified,
  imageSubstitutionRejected: imageSubstitution.accepted === false,
  forgedHashRejected: forgedHash.accepted === false,
  forgedLengthRejected: forgedLength.accepted === false,
  conflictingAliasesRejected: conflictingAliases.accepted === false,
  missingManifestRejected: missingManifest.accepted === false,
  multipleImagesRejected: multipleImages.accepted === false,
  malformedBase64Rejected: malformedBase64.accepted === false,
  nonPngRejected: nonPng.accepted === false,
  supportOnly: valid.acceptedForGpuHmr === false
    && valid.gpuHmrSuccess === false
    && valid.canSatisfyRuntimeProof === false,
}, null, 2));
