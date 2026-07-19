import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

export const MCP_SCREENSHOT_CAPTURE_MANIFEST_SCHEMA_VERSION =
  'synthi.mcp.capture_manifest.v1';
export const GPU_HMR_SCREENSHOT_CAPTURE_BINDING_SCHEMA_VERSION =
  'synthi.gpu_hmr.screenshot_capture_byte_binding.v1';
export const GPU_HMR_SCREENSHOT_CAPTURE_BINDING_AUTHORITY =
  'verified_mcp_screenshot_capture_bytes_support_only_not_gpu_hmr_runtime_proof';

const PNG_SIGNATURE = Buffer.from([
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
]);
const CANONICAL_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CANONICAL_SHA256 = /^sha256:[a-f0-9]{64}$/;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function hasOwn(object, key) {
  return isObject(object) && Object.prototype.hasOwnProperty.call(object, key);
}

function snakeToCamel(key) {
  return key.replace(/_([a-z0-9])/g, (_, character) => character.toUpperCase());
}

function addFailure(failures, code, detail = {}) {
  const failure = { code, ...detail };
  if (!failures.some((entry) => isDeepStrictEqual(entry, failure))) {
    failures.push(failure);
  }
}

function collectAliasConflicts(value, failures, path = '$', visited = new WeakSet()) {
  if (!value || typeof value !== 'object' || visited.has(value)) return;
  visited.add(value);
  if (Array.isArray(value)) {
    value.forEach((entry, index) => {
      collectAliasConflicts(entry, failures, `${path}[${index}]`, visited);
    });
    return;
  }

  for (const key of Object.keys(value)) {
    if (!key.includes('_')) continue;
    const camelKey = snakeToCamel(key);
    if (
      camelKey !== key
      && hasOwn(value, camelKey)
      && !isDeepStrictEqual(value[key], value[camelKey])
    ) {
      addFailure(failures, 'screenshot_capture_alias_conflict', {
        path,
        fields: [key, camelKey],
      });
    }
  }
  for (const [key, entry] of Object.entries(value)) {
    collectAliasConflicts(entry, failures, `${path}.${key}`, visited);
  }
}

function aliasedValue(object, snakeKey, camelKey) {
  if (hasOwn(object, snakeKey)) return object[snakeKey];
  if (hasOwn(object, camelKey)) return object[camelKey];
  return undefined;
}

function declaredValue(object, keys, failures, conflictCode, path) {
  const declarations = keys
    .filter((key) => hasOwn(object, key))
    .map((key) => ({ key, value: object[key] }));
  if (
    declarations.length > 1
    && declarations.some(({ value }) => !isDeepStrictEqual(value, declarations[0].value))
  ) {
    addFailure(failures, conflictCode, {
      path,
      fields: declarations.map(({ key }) => key),
    });
  }
  return declarations[0]?.value;
}

function decodeCanonicalBase64(value) {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value.length % 4 !== 0
    || !CANONICAL_BASE64.test(value)
  ) {
    return null;
  }
  const bytes = Buffer.from(value, 'base64');
  return bytes.length > 0 && bytes.toString('base64') === value ? bytes : null;
}

function pngHeader(bytes) {
  const signatureVerified = Buffer.isBuffer(bytes)
    && bytes.length >= PNG_SIGNATURE.length
    && bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE);
  if (
    !signatureVerified
    || bytes.length < 33
    || bytes.readUInt32BE(8) !== 13
    || bytes.toString('ascii', 12, 16) !== 'IHDR'
  ) {
    return { signatureVerified, width: null, height: null };
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return {
    signatureVerified,
    width: width > 0 ? width : null,
    height: height > 0 ? height : null,
  };
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function isPositiveSafeInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function isNonNegativeNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNonemptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonemptyIdentity(value) {
  return isNonemptyText(value) || isNonNegativeSafeInteger(value);
}

function metadataFromToolResult(toolResult, failures) {
  const content = Array.isArray(toolResult?.content) ? toolResult.content : [];
  const textBlocks = content.filter((block) => isObject(block) && block.type === 'text');
  const parsedMetadata = [];

  for (const [index, block] of textBlocks.entries()) {
    if (typeof block.text !== 'string') {
      addFailure(failures, 'screenshot_metadata_json_invalid', {
        path: `$.content[text:${index}].text`,
      });
      continue;
    }
    try {
      const parsed = JSON.parse(block.text);
      if (!isObject(parsed)) {
        addFailure(failures, 'screenshot_metadata_json_invalid', {
          path: `$.content[text:${index}].text`,
        });
        continue;
      }
      parsedMetadata.push(parsed);
    } catch {
      addFailure(failures, 'screenshot_metadata_json_invalid', {
        path: `$.content[text:${index}].text`,
      });
    }
  }

  if (parsedMetadata.length > 1) {
    addFailure(failures, 'screenshot_metadata_block_count_invalid', {
      actual: parsedMetadata.length,
      expected: 1,
    });
  }

  const structuredPresent = hasOwn(toolResult, 'structuredContent')
    || hasOwn(toolResult, 'structured_content');
  const structuredMetadata = aliasedValue(
    toolResult,
    'structured_content',
    'structuredContent',
  );
  if (structuredPresent && !isObject(structuredMetadata)) {
    addFailure(failures, 'screenshot_structured_metadata_invalid');
  }

  const textMetadata = parsedMetadata[0] ?? null;
  if (
    textMetadata
    && isObject(structuredMetadata)
    && !isDeepStrictEqual(textMetadata, structuredMetadata)
  ) {
    addFailure(failures, 'screenshot_metadata_sources_conflict');
  }

  const metadata = textMetadata ?? (isObject(structuredMetadata) ? structuredMetadata : null);
  if (!metadata) addFailure(failures, 'screenshot_metadata_missing');
  return {
    metadata,
    jsonMetadataBlockCount: parsedMetadata.length,
    structuredMetadataPresent: structuredPresent,
    metadataSource: textMetadata
      ? (isObject(structuredMetadata) ? 'json_text_and_structured_content' : 'json_text')
      : isObject(structuredMetadata)
        ? 'structured_content'
        : null,
  };
}

function supportEvidence(state, failures) {
  const frozenFailures = Object.freeze(failures.map((failure) => Object.freeze({ ...failure })));
  const failedGates = Object.freeze([...new Set(frozenFailures.map(({ code }) => code))]);
  const verified = frozenFailures.length === 0;
  return Object.freeze({
    schemaVersion: GPU_HMR_SCREENSHOT_CAPTURE_BINDING_SCHEMA_VERSION,
    proofAuthority: GPU_HMR_SCREENSHOT_CAPTURE_BINDING_AUTHORITY,
    accepted: verified,
    verified,
    acceptedAsScreenshotCaptureByteEvidence: verified,
    captureBytesVerified: verified,
    imageBlockCount: state.imageBlockCount ?? 0,
    jsonMetadataBlockCount: state.jsonMetadataBlockCount ?? 0,
    structuredMetadataPresent: state.structuredMetadataPresent ?? false,
    metadataSource: state.metadataSource ?? null,
    mimeType: state.mimeType ?? null,
    pngSignatureVerified: state.pngSignatureVerified ?? false,
    pngHeaderVerified: state.pngHeaderVerified ?? false,
    imageSha256: state.imageSha256 ?? null,
    imageByteLength: state.imageByteLength ?? null,
    width: state.width ?? null,
    height: state.height ?? null,
    frameSeq: state.frameSeq ?? null,
    frameTimestampMs: state.frameTimestampMs ?? null,
    captureTimestampMs: state.captureTimestampMs ?? null,
    captureManifestSchemaVersion: state.captureManifestSchemaVersion ?? null,
    sessionId: state.sessionId ?? null,
    captureEventId: state.captureEventId ?? null,
    frameEventId: state.frameEventId ?? null,
    failures: frozenFailures,
    failedGates,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    canSatisfyDispatchProof: false,
  });
}

function verifyScreenshotCaptureBinding(toolResult) {
  const failures = [];
  const state = {};
  if (!isObject(toolResult)) {
    addFailure(failures, 'screenshot_tool_result_invalid');
    return supportEvidence(state, failures);
  }
  if (toolResult.isError === true) {
    addFailure(failures, 'screenshot_tool_result_is_error');
  }
  collectAliasConflicts(toolResult, failures);

  const content = Array.isArray(toolResult.content) ? toolResult.content : null;
  if (!content) addFailure(failures, 'screenshot_tool_result_content_invalid');
  const imageBlocks = (content ?? [])
    .map((block, index) => ({ block, index }))
    .filter(({ block }) => isObject(block) && block.type === 'image');
  state.imageBlockCount = imageBlocks.length;
  if (imageBlocks.length !== 1) {
    addFailure(failures, 'screenshot_image_block_count_invalid', {
      actual: imageBlocks.length,
      expected: 1,
    });
  }

  const imageBlock = imageBlocks.length === 1 ? imageBlocks[0].block : null;
  let bytes = null;
  if (imageBlock) {
    const mimeType = aliasedValue(imageBlock, 'mime_type', 'mimeType');
    state.mimeType = typeof mimeType === 'string' ? mimeType : null;
    if (mimeType !== 'image/png') {
      addFailure(failures, 'screenshot_image_mime_type_invalid');
    }
    bytes = decodeCanonicalBase64(imageBlock.data);
    if (!bytes) addFailure(failures, 'screenshot_image_base64_invalid');
  }

  if (bytes) {
    state.imageSha256 = sha256(bytes);
    state.imageByteLength = bytes.length;
    const header = pngHeader(bytes);
    state.pngSignatureVerified = header.signatureVerified;
    state.pngHeaderVerified = header.width !== null && header.height !== null;
    if (!header.signatureVerified) {
      addFailure(failures, 'screenshot_image_png_signature_invalid');
    } else if (!state.pngHeaderVerified) {
      addFailure(failures, 'screenshot_image_png_header_invalid');
    }
    state.pngWidth = header.width;
    state.pngHeight = header.height;
  }

  const metadataResult = metadataFromToolResult(toolResult, failures);
  Object.assign(state, metadataResult);
  const metadata = metadataResult.metadata;
  if (!metadata) return supportEvidence(state, failures);
  collectAliasConflicts(metadata, failures, '$.metadata');

  const metadataMimeType = aliasedValue(metadata, 'mime_type', 'mimeType');
  if (metadataMimeType !== undefined && metadataMimeType !== 'image/png') {
    addFailure(failures, 'screenshot_metadata_mime_type_invalid');
  }

  const topImageHash = aliasedValue(metadata, 'image_sha256', 'imageSha256');
  const topImageByteLength = aliasedValue(
    metadata,
    'image_byte_length',
    'imageByteLength',
  );
  if (!CANONICAL_SHA256.test(topImageHash ?? '')) {
    addFailure(failures, 'screenshot_metadata_image_sha256_invalid');
  }
  if (!isPositiveSafeInteger(topImageByteLength)) {
    addFailure(failures, 'screenshot_metadata_image_byte_length_invalid');
  }

  const manifest = aliasedValue(metadata, 'capture_manifest', 'captureManifest');
  if (!isObject(manifest)) {
    addFailure(failures, 'screenshot_capture_manifest_missing');
    return supportEvidence(state, failures);
  }
  collectAliasConflicts(manifest, failures, '$.metadata.capture_manifest');

  const schemaVersion = aliasedValue(manifest, 'schema_version', 'schemaVersion');
  state.captureManifestSchemaVersion = typeof schemaVersion === 'string'
    ? schemaVersion
    : null;
  if (schemaVersion !== MCP_SCREENSHOT_CAPTURE_MANIFEST_SCHEMA_VERSION) {
    addFailure(failures, 'screenshot_capture_manifest_schema_invalid');
  }

  const sessionId = aliasedValue(manifest, 'session_id', 'sessionId');
  const captureEventId = aliasedValue(manifest, 'capture_event_id', 'captureEventId');
  const frameEventId = aliasedValue(manifest, 'frame_event_id', 'frameEventId');
  state.sessionId = isNonemptyText(sessionId) ? sessionId.trim() : null;
  state.captureEventId = isNonemptyText(captureEventId) ? captureEventId.trim() : null;
  state.frameEventId = isNonemptyIdentity(frameEventId) ? frameEventId : null;
  if (!isNonemptyText(sessionId)) {
    addFailure(failures, 'screenshot_capture_manifest_session_id_invalid');
  }
  if (!isNonemptyText(captureEventId)) {
    addFailure(failures, 'screenshot_capture_manifest_capture_event_id_invalid');
  }
  if (!isNonemptyIdentity(frameEventId)) {
    addFailure(failures, 'screenshot_capture_manifest_frame_event_id_invalid');
  }

  const manifestImageHash = aliasedValue(manifest, 'image_sha256', 'imageSha256');
  const manifestImageByteLength = aliasedValue(
    manifest,
    'image_byte_length',
    'imageByteLength',
  );
  if (!CANONICAL_SHA256.test(manifestImageHash ?? '')) {
    addFailure(failures, 'screenshot_capture_manifest_image_sha256_invalid');
  }
  if (!isPositiveSafeInteger(manifestImageByteLength)) {
    addFailure(failures, 'screenshot_capture_manifest_image_byte_length_invalid');
  }
  if (topImageHash !== manifestImageHash) {
    addFailure(failures, 'screenshot_image_sha256_declarations_mismatch');
  }
  if (topImageByteLength !== manifestImageByteLength) {
    addFailure(failures, 'screenshot_image_byte_length_declarations_mismatch');
  }
  if (typeof state.imageSha256 === 'string' && topImageHash !== state.imageSha256) {
    addFailure(failures, 'screenshot_metadata_image_sha256_mismatch');
  }
  if (typeof state.imageSha256 === 'string' && manifestImageHash !== state.imageSha256) {
    addFailure(failures, 'screenshot_capture_manifest_image_sha256_mismatch');
  }
  if (
    isPositiveSafeInteger(state.imageByteLength)
    && topImageByteLength !== state.imageByteLength
  ) {
    addFailure(failures, 'screenshot_metadata_image_byte_length_mismatch');
  }
  if (
    isPositiveSafeInteger(state.imageByteLength)
    && manifestImageByteLength !== state.imageByteLength
  ) {
    addFailure(failures, 'screenshot_capture_manifest_image_byte_length_mismatch');
  }

  const topWidth = declaredValue(
    metadata,
    ['w', 'width'],
    failures,
    'screenshot_metadata_width_declarations_conflict',
    '$.metadata',
  );
  const topHeight = declaredValue(
    metadata,
    ['h', 'height'],
    failures,
    'screenshot_metadata_height_declarations_conflict',
    '$.metadata',
  );
  const manifestWidth = declaredValue(
    manifest,
    ['width', 'w'],
    failures,
    'screenshot_capture_manifest_width_declarations_conflict',
    '$.metadata.capture_manifest',
  );
  const manifestHeight = declaredValue(
    manifest,
    ['height', 'h'],
    failures,
    'screenshot_capture_manifest_height_declarations_conflict',
    '$.metadata.capture_manifest',
  );
  if (!isPositiveSafeInteger(topWidth) || !isPositiveSafeInteger(topHeight)) {
    addFailure(failures, 'screenshot_metadata_dimensions_invalid');
  }
  if (!isPositiveSafeInteger(manifestWidth) || !isPositiveSafeInteger(manifestHeight)) {
    addFailure(failures, 'screenshot_capture_manifest_dimensions_invalid');
  }
  if (topWidth !== manifestWidth || topHeight !== manifestHeight) {
    addFailure(failures, 'screenshot_capture_dimensions_mismatch');
  }
  if (
    isPositiveSafeInteger(state.pngWidth)
    && isPositiveSafeInteger(state.pngHeight)
    && (topWidth !== state.pngWidth || topHeight !== state.pngHeight)
  ) {
    addFailure(failures, 'screenshot_capture_png_dimensions_mismatch');
  }
  state.width = isPositiveSafeInteger(manifestWidth) ? manifestWidth : null;
  state.height = isPositiveSafeInteger(manifestHeight) ? manifestHeight : null;

  const topFrameSeq = declaredValue(
    metadata,
    ['seq', 'frame_seq', 'frameSeq'],
    failures,
    'screenshot_metadata_frame_sequence_declarations_conflict',
    '$.metadata',
  );
  const manifestFrameSeq = declaredValue(
    manifest,
    ['frame_seq', 'frameSeq'],
    failures,
    'screenshot_capture_manifest_frame_sequence_declarations_conflict',
    '$.metadata.capture_manifest',
  );
  if (!isNonNegativeSafeInteger(topFrameSeq)) {
    addFailure(failures, 'screenshot_metadata_frame_sequence_invalid');
  }
  if (!isNonNegativeSafeInteger(manifestFrameSeq)) {
    addFailure(failures, 'screenshot_capture_manifest_frame_sequence_invalid');
  }
  if (topFrameSeq !== manifestFrameSeq) {
    addFailure(failures, 'screenshot_capture_frame_sequence_mismatch');
  }
  state.frameSeq = isNonNegativeSafeInteger(manifestFrameSeq) ? manifestFrameSeq : null;

  const topFrameTimestampMs = declaredValue(
    metadata,
    ['ts', 'frame_ts_ms', 'frameTsMs', 'timestamp_ms', 'timestampMs'],
    failures,
    'screenshot_metadata_frame_timestamp_declarations_conflict',
    '$.metadata',
  );
  const manifestFrameTimestampMs = declaredValue(
    manifest,
    ['frame_ts_ms', 'frameTsMs'],
    failures,
    'screenshot_capture_manifest_frame_timestamp_declarations_conflict',
    '$.metadata.capture_manifest',
  );
  const captureTimestampMs = declaredValue(
    manifest,
    ['capture_ts_ms', 'captureTsMs'],
    failures,
    'screenshot_capture_manifest_capture_timestamp_declarations_conflict',
    '$.metadata.capture_manifest',
  );
  if (!isNonNegativeNumber(topFrameTimestampMs)) {
    addFailure(failures, 'screenshot_metadata_frame_timestamp_invalid');
  }
  if (!isNonNegativeNumber(manifestFrameTimestampMs)) {
    addFailure(failures, 'screenshot_capture_manifest_frame_timestamp_invalid');
  }
  if (!isNonNegativeNumber(captureTimestampMs)) {
    addFailure(failures, 'screenshot_capture_manifest_capture_timestamp_invalid');
  }
  if (topFrameTimestampMs !== manifestFrameTimestampMs) {
    addFailure(failures, 'screenshot_capture_frame_timestamp_mismatch');
  }
  if (
    isNonNegativeNumber(manifestFrameTimestampMs)
    && isNonNegativeNumber(captureTimestampMs)
    && captureTimestampMs < manifestFrameTimestampMs
  ) {
    addFailure(failures, 'screenshot_capture_timestamp_order_invalid');
  }
  state.frameTimestampMs = isNonNegativeNumber(manifestFrameTimestampMs)
    ? manifestFrameTimestampMs
    : null;
  state.captureTimestampMs = isNonNegativeNumber(captureTimestampMs)
    ? captureTimestampMs
    : null;

  return supportEvidence(state, failures);
}

export function verifyGpuHmrScreenshotCaptureBinding(toolResult) {
  try {
    return verifyScreenshotCaptureBinding(toolResult);
  } catch {
    return supportEvidence({}, [{ code: 'screenshot_capture_verifier_internal_failure' }]);
  }
}

export const verifyMcpScreenshotCaptureBytes = verifyGpuHmrScreenshotCaptureBinding;
export const MCP_CAPTURE_MANIFEST_SCHEMA_VERSION =
  MCP_SCREENSHOT_CAPTURE_MANIFEST_SCHEMA_VERSION;
