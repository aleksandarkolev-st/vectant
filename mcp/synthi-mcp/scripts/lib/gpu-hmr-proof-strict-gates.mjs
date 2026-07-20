import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluateGpuHmrAcceptanceContract } from './gpu-hmr-acceptance-contract.mjs';
import {
  CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION,
  casRelativePathForHash,
  collectArtifactLocators,
  hashFromArtifactId,
  normalizeSha256Hash,
  sha256Text as casSha256Text,
  stableJson,
} from './gpu-hmr-artifact-cas.mjs';
import { queryGpuHmrLedgerInvariants } from './gpu-hmr-proof-ledger.mjs';
import {
  classifyGpuHmrOutputOracleKind,
  isGpuHmrVisualOutputOracleKind,
} from './gpu-hmr-output-oracle-kind.mjs';

export const GPU_HMR_STRICT_PROOF_GATES_SCHEMA_VERSION =
  'synthi.gpu_hmr.strict_proof_gates.v1';

function isObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function compactStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value ?? '').trim())
    .filter(Boolean))];
}

function firstObject(...values) {
  return values.find((value) => isObject(value)) ?? null;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) ?? null;
}

const VISUAL_OR_ENGINE_BACKENDS = new Set(['hiprt', 'vulkan', 'webgpu', 'bevy_wgsl']);
const ACCEPTED_PROOF_LEDGER_SOURCE_CONSISTENCY_MODES = new Set([
  'derived_only',
  'explicit_vs_derived',
]);
const MODULE_FILE_PATH = fileURLToPath(import.meta.url);
const MODULE_DIR = path.dirname(MODULE_FILE_PATH);
const DEFAULT_VISUAL_ARTIFACT_ROOTS = [
  process.cwd(),
  path.resolve(MODULE_DIR, '../..'),
  path.resolve(MODULE_DIR, '../../..'),
  path.resolve(MODULE_DIR, '../../../..'),
];
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_CHUNK_TYPE_PATTERN = /^[A-Za-z]{4}$/u;
const CAS_URI_SCHEME = 'synthi-cas:';
const SHA256_DIGEST_PATTERN = /^[a-f0-9]{64}$/u;
const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < table.length; i += 1) {
    let crc = i;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) ? (0xedb88320 ^ (crc >>> 1)) : (crc >>> 1);
    }
    table[i] = crc >>> 0;
  }
  return table;
})();

function sortedCodes(values) {
  return compactStrings((Array.isArray(values) ? values : [])
    .map((value) => value?.code ?? value))
    .sort();
}

function sameCodes(a, b) {
  const left = sortedCodes(a);
  const right = sortedCodes(b);
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function gateRow(name, failures, successDetail) {
  const normalizedFailures = compactStrings(failures);
  return {
    schemaVersion: GPU_HMR_STRICT_PROOF_GATES_SCHEMA_VERSION,
    name,
    status: normalizedFailures.length === 0 ? 'pass' : 'fail',
    accepted: normalizedFailures.length === 0,
    failures: normalizedFailures,
    detail: normalizedFailures.length === 0
      ? successDetail
      : `failures=${normalizedFailures.join(',')}`,
  };
}

function proofArtifactFromRecord(record) {
  if (isObject(record?.artifact)) return record.artifact;
  if (isObject(record)) return record;
  return null;
}

function proofArtifactLabel(record, index) {
  const candidate = record?.label
    ?? record?.name
    ?? record?.proofId
    ?? record?.proof_id
    ?? record?.artifact?.proofId
    ?? record?.artifact?.proof_id
    ?? `artifact-${index + 1}`;
  return String(candidate || `artifact-${index + 1}`).replace(/\s+/g, '-');
}

function ledgerRecords(ledger) {
  if (!isObject(ledger)) return [];
  if (Array.isArray(ledger.records)) return ledger.records.filter(isObject);
  if (isObject(ledger.record)) return [ledger.record];
  return [];
}

function normalizedText(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().toLowerCase();
    if (isObject(value) && typeof value.value === 'string' && value.value.trim()) {
      return value.value.trim().toLowerCase();
    }
  }
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (isObject(value) && typeof value.value === 'string' && value.value.trim()) {
      return value.value.trim();
    }
  }
  return null;
}

function isGfxArch(value) {
  return /^gfx[0-9][0-9a-z]*$/iu.test(String(value ?? '').trim());
}

function hipModuleHardwareTargetFailures({ artifact, acceptanceContract, proofLedger }) {
  const proofId = firstString(artifact?.proofId, artifact?.proof_id) ?? '';
  const hardware = firstObject(
    artifact?.hardwareTargetEvidence,
    artifact?.hardware_target_evidence,
  );
  const requiresHipModuleHardware =
    proofId.startsWith('hip-module-runtime-proof-artifact:')
    || normalizedText(hardware?.schemaVersion, hardware?.schema_version)
      === 'synthi.gpu_hmr.hip_module_hardware_target_evidence.v1';
  if (!requiresHipModuleHardware) return [];

  const record = ledgerRecords(proofLedger)[0] ?? {};
  const device = firstObject(record.device_identity, record.deviceIdentity) ?? {};
  const adapter = firstObject(device.adapter_info, device.adapterInfo) ?? {};
  const artifactIdentity = firstObject(
    acceptanceContract?.artifact_identity,
    acceptanceContract?.artifactIdentity,
  ) ?? {};
  const backend = normalizedText(
    acceptanceContract?.backend,
    record.backend,
    hardware?.backend,
    device.backend,
    adapter.backend,
  );
  const compileTarget = firstString(
    hardware?.gpuArch,
    hardware?.gpu_arch,
    hardware?.compileTarget,
    hardware?.compile_target,
    artifactIdentity.compile_target,
    artifactIdentity.compileTarget,
    device.gpu_arch,
    device.gpuArch,
    device.gcn_arch_name,
    device.gcnArchName,
    device.compile_target,
    device.compileTarget,
    adapter.gpu_arch,
    adapter.gpuArch,
    adapter.gcn_arch_name,
    adapter.gcnArchName,
  );
  const deviceUuid = firstString(
    hardware?.deviceUuid,
    hardware?.device_uuid,
    device.device_uuid,
    device.deviceUuid,
    adapter.device_uuid,
    adapter.deviceUuid,
  );
  return compactStrings([
    hardware ? null : 'hip_module_hardware_target_evidence_missing',
    hardware?.accepted === true ? null : 'hip_module_hardware_target_not_accepted',
    backend === 'hip' ? null : 'hip_module_hardware_backend_not_hip',
    isGfxArch(compileTarget) ? null : 'hip_module_hardware_gfx_arch_missing',
    deviceUuid ? null : 'hip_module_hardware_device_identity_missing',
  ]);
}

function visualArtifactsPresent(record) {
  const oracleArtifacts = firstObject(record.oracle_artifacts, record.oracleArtifacts);
  const outputEvent = firstObject(record.output_event, record.outputEvent) ?? {};
  const outputArtifacts = firstObject(outputEvent.oracle_artifacts, outputEvent.oracleArtifacts);
  const outputOracle = firstObject(outputEvent.output_oracle, outputEvent.outputOracle) ?? {};
  const outputOracleArtifacts = firstObject(outputOracle.oracle_artifacts, outputOracle.oracleArtifacts);
  return [
    oracleArtifacts?.visual_oracle_artifacts,
    oracleArtifacts?.visualOracleArtifacts,
    outputArtifacts?.visual_oracle_artifacts,
    outputArtifacts?.visualOracleArtifacts,
    outputEvent.visual_oracle_artifacts,
    outputEvent.visualOracleArtifacts,
    outputOracle.visual_oracle_artifacts,
    outputOracle.visualOracleArtifacts,
    outputOracleArtifacts?.visual_oracle_artifacts,
    outputOracleArtifacts?.visualOracleArtifacts,
  ].some(isObject);
}

function computeArtifactsPresent(record) {
  return computeOracleArtifactObjects(record).length > 0;
}

function contentAddressedSha256(value) {
  return /^sha256:[a-f0-9]{64}$/i.test(String(value ?? '').trim());
}

function normalizeSha256(value) {
  const text = String(value ?? '').trim().toLowerCase();
  return contentAddressedSha256(text) ? text : null;
}

function sha256Bytes(buffer) {
  return `sha256:${createHash('sha256').update(buffer).digest('hex')}`;
}

function crc32(buffer, start, end) {
  let crc = 0xffffffff;
  for (let index = start; index < end; index += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function positiveInteger(value) {
  const numeric = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : null;
}

function dimensionsFromValue(value) {
  if (Array.isArray(value) && value.length >= 2) {
    const width = positiveInteger(value[0]);
    const height = positiveInteger(value[1]);
    return width && height ? { width, height } : null;
  }
  if (!isObject(value)) return null;
  const width = positiveInteger(value.width ?? value.w);
  const height = positiveInteger(value.height ?? value.h);
  return width && height ? { width, height } : null;
}

function sameDimensions(left, right) {
  return Boolean(left && right && left.width === right.width && left.height === right.height);
}

function pngHeaderEvidence(buffer) {
  const failedGates = [];
  let width = null;
  let height = null;
  if (!Buffer.isBuffer(buffer) || buffer.length < PNG_SIGNATURE.length) {
    failedGates.push('png_header_too_short');
    return { accepted: false, width, height, failedGates };
  }
  if (!buffer.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    failedGates.push('png_signature_mismatch');
    return { accepted: false, width, height, failedGates };
  }
  if (buffer.length < 33) {
    failedGates.push('png_header_too_short');
  }
  let offset = PNG_SIGNATURE.length;
  let chunkIndex = 0;
  let seenIhdr = false;
  let seenIdat = false;
  let seenIend = false;
  while (offset < buffer.length) {
    if (offset + 12 > buffer.length) {
      failedGates.push('png_chunk_header_truncated');
      break;
    }
    const length = buffer.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const crcOffset = dataEnd;
    const nextOffset = crcOffset + 4;
    const chunkType = buffer.subarray(typeStart, typeStart + 4).toString('ascii');
    if (!PNG_CHUNK_TYPE_PATTERN.test(chunkType)) {
      failedGates.push('png_chunk_type_invalid');
    }
    if (nextOffset > buffer.length) {
      failedGates.push('png_chunk_data_truncated');
      break;
    }
    const expectedCrc = buffer.readUInt32BE(crcOffset);
    const actualCrc = crc32(buffer, typeStart, dataEnd);
    if (expectedCrc !== actualCrc) {
      failedGates.push('png_chunk_crc_mismatch');
    }
    if (chunkIndex === 0 && chunkType !== 'IHDR') {
      failedGates.push('png_ihdr_not_first');
    }
    if (!seenIhdr && chunkType !== 'IHDR') {
      failedGates.push('png_chunk_before_ihdr');
    }
    if (chunkType === 'IHDR') {
      if (seenIhdr) {
        failedGates.push('png_ihdr_duplicate');
      }
      seenIhdr = true;
      if (length !== 13) failedGates.push('png_ihdr_length_invalid');
      if (length >= 13) {
        width = buffer.readUInt32BE(dataStart);
        height = buffer.readUInt32BE(dataStart + 4);
        const bitDepth = buffer[dataStart + 8];
        const colorType = buffer[dataStart + 9];
        const compression = buffer[dataStart + 10];
        const filter = buffer[dataStart + 11];
        const interlace = buffer[dataStart + 12];
        if (!Number.isFinite(width) || width <= 0) failedGates.push('png_width_invalid');
        if (!Number.isFinite(height) || height <= 0) failedGates.push('png_height_invalid');
        if (![1, 2, 4, 8, 16].includes(bitDepth)) failedGates.push('png_bit_depth_invalid');
        if (![0, 2, 3, 4, 6].includes(colorType)) failedGates.push('png_color_type_invalid');
        if (compression !== 0) failedGates.push('png_compression_method_invalid');
        if (filter !== 0) failedGates.push('png_filter_method_invalid');
        if (interlace !== 0 && interlace !== 1) failedGates.push('png_interlace_method_invalid');
      }
    } else if (chunkType === 'IDAT') {
      seenIdat = true;
    } else if (chunkType === 'IEND') {
      if (length !== 0) failedGates.push('png_iend_length_invalid');
      seenIend = true;
      if (nextOffset !== buffer.length) {
        failedGates.push('png_trailing_bytes_after_iend');
      }
      break;
    }
    offset = nextOffset;
    chunkIndex += 1;
  }
  if (!seenIhdr) failedGates.push('png_ihdr_missing');
  if (!seenIdat) failedGates.push('png_idat_missing');
  if (!seenIend) failedGates.push('png_iend_missing');
  return {
    accepted: failedGates.length === 0,
    width,
    height,
    failedGates,
  };
}

function fileUrlToPathMaybe(value) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (/^file:\/\//iu.test(text)) {
    try {
      return fileURLToPath(text);
    } catch {
      return null;
    }
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(text)) return null;
  return text;
}

function uniqueRealRoots(values) {
  const roots = [];
  const seen = new Set();
  for (const raw of compactStrings(values)) {
    try {
      const resolved = realpathSync(path.resolve(raw));
      const key = resolved.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        roots.push(resolved);
      }
    } catch {
      // Non-existent artifact roots cannot safely authorize file evidence.
    }
  }
  return roots;
}

function pathInsideRoot(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (relative && !relative.startsWith('..') && !path.isAbsolute(relative));
}

function visualArtifactRoots(options = {}) {
  return uniqueRealRoots([
    ...DEFAULT_VISUAL_ARTIFACT_ROOTS,
    ...compactStrings(options.visualArtifactRoots ?? options.visual_artifact_roots),
  ]);
}

function computeArtifactRoots(options = {}) {
  return uniqueRealRoots([
    ...DEFAULT_VISUAL_ARTIFACT_ROOTS,
    ...compactStrings(options.computeArtifactRoots ?? options.compute_artifact_roots),
    ...compactStrings(options.allowedArtifactRoots ?? options.allowed_artifact_roots),
    ...compactStrings(options.allowedCasRoots ?? options.allowed_cas_roots),
  ]);
}

function computeArtifactPathBaseRoots(options = {}) {
  return uniqueRealRoots([
    ...DEFAULT_VISUAL_ARTIFACT_ROOTS,
    ...compactStrings(options.computeArtifactPathBaseRoots ?? options.compute_artifact_path_base_roots),
    ...compactStrings(options.artifactPathBaseRoots ?? options.artifact_path_base_roots),
  ]);
}

function resolveReadableVisualArtifactPath(rawPath, roots) {
  const pathText = fileUrlToPathMaybe(rawPath);
  if (!pathText || roots.length === 0) return null;
  const candidates = path.isAbsolute(pathText)
    ? [path.resolve(pathText)]
    : roots.map((root) => path.resolve(root, pathText));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const realPath = realpathSync(candidate);
      if (!roots.some((root) => pathInsideRoot(realPath, root))) continue;
      return realPath;
    } catch {
      // Keep trying the next candidate.
    }
  }
  return null;
}

function resolveReadableComputeArtifactPath(rawPath, allowedRoots, pathBaseRoots = allowedRoots) {
  const pathText = fileUrlToPathMaybe(rawPath);
  if (!pathText || allowedRoots.length === 0) return null;
  const candidates = path.isAbsolute(pathText)
    ? [path.resolve(pathText)]
    : pathBaseRoots.map((root) => path.resolve(root, pathText));
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const realPath = realpathSync(candidate);
      if (!allowedRoots.some((root) => pathInsideRoot(realPath, root))) continue;
      return realPath;
    } catch {
      // Keep trying the next candidate.
    }
  }
  return null;
}

function visualArtifactByteHash(entry, roots) {
  const resolvedPath = resolveReadableVisualArtifactPath(entry?.path, roots);
  const casValidation = visualArtifactCasLocatorValidation(entry?.artifactCasLocator, roots);
  const artifactPath = resolvedPath ?? (
    casValidation?.accepted === true ? casValidation.localPath : null
  );
  if (!artifactPath) {
    return casValidation ? { casValidation } : null;
  }
  try {
    const bytes = readFileSync(artifactPath);
    return {
      resolvedPath: artifactPath,
      hash: sha256Bytes(bytes),
      pngHeader: pngHeaderEvidence(bytes),
      casValidation,
    };
  } catch {
    return casValidation ? { casValidation } : null;
  }
}

function normalizedComputeArtifactRole(value) {
  const role = String(value ?? '').trim().toLowerCase().replace(/[-\s]+/g, '_');
  if ([
    'raw_readback',
    'raw_readback_bin',
    'readback',
    'readback_bin',
    'compute_readback',
    'compute_raw_readback',
    'runtime_compute_raw_readback',
  ].includes(role)) {
    return 'raw_readback';
  }
  if ([
    'schema',
    'readback_schema',
    'readback_schema_json',
    'compute_schema',
    'compute_readback_schema',
    'runtime_compute_readback_schema',
  ].includes(role)) {
    return 'readback_schema';
  }
  if ([
    'card',
    'proof_card',
    'proof_card_png',
    'rendered_card',
    'rendered_card_png',
    'compute_card',
    'compute_proof_card',
    'runtime_compute_proof_card',
  ].includes(role)) {
    return 'rendered_card';
  }
  return null;
}

function computeArtifactLocatorRole(locator) {
  return normalizedComputeArtifactRole(
    locator?.role
    ?? locator?.artifactRole
    ?? locator?.artifact_role
    ?? locator?.artifactKind
    ?? locator?.artifact_kind,
  );
}

function computeArtifactLocatorHash(locator) {
  const directHash = normalizeSha256(
    locator?.contentHash
    ?? locator?.content_hash
    ?? locator?.artifactHash
    ?? locator?.artifact_hash,
  );
  if (directHash) return directHash;
  try {
    return normalizeSha256(hashFromArtifactId(firstString(locator?.artifactId, locator?.artifact_id)));
  } catch {
    return null;
  }
}

function computeArtifactLocatorValidation(locator, roots, expectedHash = null) {
  if (!isObject(locator)) return null;
  const reasons = [];
  const fail = (reason) => reasons.push(reason);
  const result = {
    accepted: false,
    acceptedAsTransportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'transport_integrity_only',
    contentHash: null,
    manifestHash: null,
    localPath: null,
    byteLength: null,
    reasons,
  };
  if (firstString(locator.schemaVersion, locator.schema_version) !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) {
    fail('artifact_cas_manifest_schema_invalid');
  }
  const role = computeArtifactLocatorRole(locator);
  if (role !== 'raw_readback') fail('artifact_cas_compute_role_not_raw_readback');
  const contentHash = computeArtifactLocatorHash(locator);
  if (!contentHash) fail('artifact_cas_content_hash_invalid');
  result.contentHash = contentHash;
  if (expectedHash && contentHash && contentHash !== expectedHash) {
    fail('artifact_cas_content_hash_mismatch');
  }
  try {
    const artifactHash = hashFromArtifactId(firstString(locator.artifactId, locator.artifact_id));
    if (contentHash && artifactHash !== contentHash) {
      fail('artifact_cas_artifact_id_hash_mismatch');
    }
  } catch {
    fail('artifact_cas_artifact_id_invalid');
  }
  validateVisualArtifactCasUri(locator, contentHash, fail);
  const byteLength = Number(locator.byteLength ?? locator.byte_length);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    fail('artifact_cas_byte_length_invalid');
  } else {
    result.byteLength = byteLength;
  }
  const transport = isObject(locator.transport) ? locator.transport : {};
  if (transport.contentAddressed !== true && transport.content_addressed !== true) {
    fail('artifact_cas_transport_not_content_addressed');
  }
  if (transport.bytesEmbedded === true || transport.bytes_embedded === true) {
    fail('artifact_cas_manifest_embeds_bytes');
  }
  if (
    locator.acceptedForGpuHmr === true
    || locator.accepted_for_gpu_hmr === true
    || locator.gpuHmrSuccess === true
    || locator.gpu_hmr_success === true
  ) {
    fail('artifact_cas_manifest_claims_gpu_hmr_success');
  }
  const declaredManifestHash = firstString(locator.manifestHash, locator.manifest_hash);
  const manifestHashInput = { ...locator, manifestHash: undefined };
  if (Object.prototype.hasOwnProperty.call(manifestHashInput, 'manifest_hash')) {
    manifestHashInput.manifest_hash = undefined;
  }
  result.manifestHash = casSha256Text(stableJson(manifestHashInput));
  if (declaredManifestHash && declaredManifestHash !== result.manifestHash) {
    fail('artifact_cas_manifest_hash_mismatch');
  }
  if (contentHash) {
    const resolvedPath = resolveReadableCasLocatorPath(locator, roots, contentHash, fail);
    if (resolvedPath) {
      result.localPath = resolvedPath;
      try {
        const bytes = readFileSync(resolvedPath);
        const readableHash = sha256Bytes(bytes);
        if (readableHash !== contentHash) fail('artifact_cas_readable_hash_mismatch');
        if (Number.isSafeInteger(byteLength) && bytes.byteLength !== byteLength) {
          fail('artifact_cas_readable_byte_length_mismatch');
        }
      } catch {
        fail('artifact_cas_local_path_unreadable');
      }
    }
  }
  if (reasons.length === 0) {
    result.accepted = true;
    result.acceptedAsTransportEvidence = true;
  }
  return result;
}

function computeArtifactCasLocators(source, role = 'raw_readback') {
  const expectedRole = normalizedComputeArtifactRole(role);
  return collectArtifactLocators(source).filter((locator) => {
    if ((locator.schemaVersion ?? locator.schema_version) !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) {
      return false;
    }
    return computeArtifactLocatorRole(locator) === expectedRole;
  });
}

function readComputeArtifactLocatorManifest(value, role, roots, pathBaseRoots = roots) {
  if (isObject(value)) {
    return {
      manifest: {
        role,
        ...value,
        role: value.role ?? value.artifactRole ?? value.artifact_role ?? role,
      },
      readError: null,
    };
  }
  const manifestPath = resolveReadableComputeArtifactPath(value, roots, pathBaseRoots);
  if (!manifestPath) return { manifest: null, readError: null };
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8'));
    return {
      manifest: {
        role,
        ...parsed,
        role: parsed.role ?? parsed.artifactRole ?? parsed.artifact_role ?? role,
      },
      readError: null,
      manifestPath,
    };
  } catch (error) {
    return {
      manifest: null,
      readError: error?.message ? String(error.message) : String(error),
      manifestPath,
    };
  }
}

function computeRawReadbackLocators(source, roots, pathBaseRoots = roots) {
  const manifestValues = [
    source.raw_readback_cas_manifest,
    source.rawReadbackCasManifest,
    source.raw_readback_locator,
    source.rawReadbackLocator,
  ].filter((value) => value !== undefined && value !== null);
  const manifestLocators = manifestValues.flatMap((value) => {
    const loaded = readComputeArtifactLocatorManifest(value, 'raw_readback', roots, pathBaseRoots);
    return loaded.manifest ? [loaded.manifest] : [];
  });
  return [
    ...manifestLocators,
    ...computeArtifactCasLocators(source, 'raw_readback'),
  ];
}

function computeOracleArtifactObjects(record) {
  const oracleArtifacts = firstObject(record.oracle_artifacts, record.oracleArtifacts);
  const outputEvent = firstObject(record.output_event, record.outputEvent) ?? {};
  const outputArtifacts = firstObject(outputEvent.oracle_artifacts, outputEvent.oracleArtifacts);
  const outputOracle = firstObject(outputEvent.output_oracle, outputEvent.outputOracle) ?? {};
  const outputOracleArtifacts = firstObject(outputOracle.oracle_artifacts, outputOracle.oracleArtifacts);
  return [
    oracleArtifacts?.compute_oracle_artifacts,
    oracleArtifacts?.computeOracleArtifacts,
    outputArtifacts?.compute_oracle_artifacts,
    outputArtifacts?.computeOracleArtifacts,
    outputEvent.compute_oracle_artifacts,
    outputEvent.computeOracleArtifacts,
    outputOracle.compute_oracle_artifacts,
    outputOracle.computeOracleArtifacts,
    outputOracleArtifacts?.compute_oracle_artifacts,
    outputOracleArtifacts?.computeOracleArtifacts,
  ].filter(isObject);
}

function visualArtifactObjects(record) {
  const oracleArtifacts = firstObject(record.oracle_artifacts, record.oracleArtifacts);
  const outputEvent = firstObject(record.output_event, record.outputEvent) ?? {};
  const outputArtifacts = firstObject(outputEvent.oracle_artifacts, outputEvent.oracleArtifacts);
  const outputOracle = firstObject(outputEvent.output_oracle, outputEvent.outputOracle) ?? {};
  const outputOracleArtifacts = firstObject(outputOracle.oracle_artifacts, outputOracle.oracleArtifacts);
  return [
    oracleArtifacts?.visual_oracle_artifacts,
    oracleArtifacts?.visualOracleArtifacts,
    outputArtifacts?.visual_oracle_artifacts,
    outputArtifacts?.visualOracleArtifacts,
    outputEvent.visual_oracle_artifacts,
    outputEvent.visualOracleArtifacts,
    outputOracle.visual_oracle_artifacts,
    outputOracle.visualOracleArtifacts,
    outputOracleArtifacts?.visual_oracle_artifacts,
    outputOracleArtifacts?.visualOracleArtifacts,
  ].filter(isObject);
}

function visualArtifactRole(value, fallbackPath = '') {
  const role = normalizedText(value?.role, value?.artifactRole, value?.artifact_role);
  if (role === 'before' || role === 'baseline') return 'before';
  if (role === 'after' || role === 'changed') return 'after';
  if (role === 'diff' || role === 'delta') return 'diff';
  const lowerPath = String(fallbackPath ?? '').toLowerCase();
  if (lowerPath.includes('before') || lowerPath.includes('baseline')) return 'before';
  if (lowerPath.includes('after') || lowerPath.includes('changed')) return 'after';
  if (lowerPath.includes('diff') || lowerPath.includes('delta')) return 'diff';
  return 'artifact';
}

function visualArtifactHashForRole(object, role) {
  return firstString(
    object?.expectedHash,
    object?.expected_hash,
    object?.contentHash,
    object?.content_hash,
    object?.imageSha256,
    object?.image_sha256,
    object?.sha256,
    object?.hash,
    role === 'before' ? object?.before_image_hash : null,
    role === 'before' ? object?.beforeImageHash : null,
    role === 'after' ? object?.after_image_hash : null,
    role === 'after' ? object?.afterImageHash : null,
    role === 'diff' ? object?.diff_image_hash : null,
    role === 'diff' ? object?.diffImageHash : null,
  );
}

function visualArtifactLocatorRole(locator) {
  const role = normalizedText(locator?.role, locator?.artifactRole, locator?.artifact_role);
  if (['before', 'baseline', 'before_frame', 'baseline_frame'].includes(role)) return 'before';
  if (['after', 'changed', 'after_frame', 'changed_frame'].includes(role)) return 'after';
  if (['diff', 'delta', 'diff_frame', 'difference_frame', 'delta_frame'].includes(role)) return 'diff';
  return null;
}

function visualArtifactLocatorHash(locator) {
  if (!isObject(locator)) return null;
  try {
    return normalizeSha256Hash(firstString(
      locator.contentHash,
      locator.content_hash,
      locator.artifactHash,
      locator.artifact_hash,
      locator.artifactContentHash,
      locator.artifact_content_hash,
    ));
  } catch {
    try {
      return hashFromArtifactId(firstString(locator.artifactId, locator.artifact_id));
    } catch {
      return null;
    }
  }
}

function visualCasLocatorLooksLikeImageEvidence(locator = {}) {
  const mediaType = normalizedText(locator.mediaType, locator.media_type) ?? '';
  const artifactKind = normalizedText(locator.artifactKind, locator.artifact_kind) ?? '';
  return mediaType.startsWith('image/')
    || artifactKind.includes('visual')
    || artifactKind.includes('frame')
    || artifactKind.includes('screenshot')
    || artifactKind.includes('render');
}

function visualArtifactCasLocatorClaimsAuthority(locator = {}) {
  return locator.acceptedForGpuHmr === true
    || locator.accepted_for_gpu_hmr === true
    || locator.gpuHmrSuccess === true
    || locator.gpu_hmr_success === true;
}

function visualArtifactCasLocatorAuditCandidates(value) {
  return collectArtifactLocators(value).filter((locator) =>
    firstString(locator.schemaVersion, locator.schema_version)
    || firstString(locator.artifactUri, locator.artifact_uri)
    || isObject(locator.transport)
    || visualArtifactCasLocatorClaimsAuthority(locator)
  );
}

function visualArtifactCasLocatorAuditFailures(value, roots) {
  return visualArtifactCasLocatorAuditCandidates(value).flatMap((locator) => {
    if (visualArtifactCasLocatorClaimsAuthority(locator)) {
      return ['visual_oracle_artifact_cas_locator_invalid'];
    }
    if (
      firstString(locator.schemaVersion, locator.schema_version) === CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION
      && (visualArtifactLocatorRole(locator) || visualCasLocatorLooksLikeImageEvidence(locator))
    ) {
      const validation = visualArtifactCasLocatorValidation(locator, roots);
      return validation?.accepted === true ? [] : ['visual_oracle_artifact_cas_locator_invalid'];
    }
    return [];
  });
}

function visualArtifactCasLocators(value) {
  const seen = new Set();
  return collectArtifactLocators(value)
    .filter((locator) =>
      firstString(locator.schemaVersion, locator.schema_version) === CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION
      && visualArtifactLocatorRole(locator)
      && visualCasLocatorLooksLikeImageEvidence(locator)
    )
    .filter((locator) => {
      const role = visualArtifactLocatorRole(locator);
      const hash = visualArtifactLocatorHash(locator) ?? 'unknown';
      const manifestHash = firstString(locator.manifestHash, locator.manifest_hash) ?? 'no-manifest';
      const key = `${role}:${hash}:${manifestHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function visualArtifactCasLocatorForEntry(locators, role, expectedHash) {
  const normalizedHash = normalizeSha256(expectedHash);
  return locators.find((locator) => {
    if (visualArtifactLocatorRole(locator) !== role) return false;
    const locatorHash = visualArtifactLocatorHash(locator);
    return !normalizedHash || !locatorHash || normalizedHash === locatorHash;
  }) ?? null;
}

function realpathInsideRoots(rawPath, roots) {
  const pathText = fileUrlToPathMaybe(rawPath);
  if (!pathText || roots.length === 0) return null;
  try {
    const realPath = realpathSync(path.resolve(pathText));
    if (!roots.some((root) => pathInsideRoot(realPath, root))) return null;
    if (!statSync(realPath).isFile()) return null;
    return realPath;
  } catch {
    return null;
  }
}

function relativeCasPathFromLocator(locator, contentHash) {
  const storage = isObject(locator?.storage) ? locator.storage : {};
  const relativePath = firstString(storage.relativePath, storage.relative_path);
  if (!relativePath) return casRelativePathForHash(contentHash);
  const normalized = relativePath.replace(/\\/g, '/').split('/').filter(Boolean).join('/');
  return normalized;
}

function resolveReadableCasLocatorPath(locator, roots, contentHash, fail) {
  const storage = isObject(locator?.storage) ? locator.storage : {};
  const localPath = firstString(storage.localPath, storage.local_path);
  if (localPath) {
    const resolved = realpathInsideRoots(localPath, roots);
    if (!resolved) fail('artifact_cas_local_path_outside_allowed_roots');
    return resolved;
  }
  let relativePath = null;
  try {
    relativePath = relativeCasPathFromLocator(locator, contentHash);
    if (relativePath !== casRelativePathForHash(contentHash)) {
      fail('artifact_cas_relative_path_hash_mismatch');
      return null;
    }
  } catch {
    fail('artifact_cas_relative_path_invalid');
    return null;
  }
  for (const root of roots) {
    const candidate = path.join(root, ...relativePath.split('/'));
    const resolved = realpathInsideRoots(candidate, [root]);
    if (resolved) return resolved;
  }
  fail('artifact_cas_relative_path_unreadable');
  return null;
}

function validateVisualArtifactCasUri(locator, contentHash, fail) {
  const artifactUri = firstString(locator.artifactUri, locator.artifact_uri);
  if (!artifactUri) {
    fail('artifact_cas_uri_invalid');
    return;
  }
  try {
    const parsed = new URL(artifactUri);
    if (parsed.protocol !== CAS_URI_SCHEME) {
      fail('artifact_cas_uri_scheme_invalid');
      return;
    }
    if (!parsed.hostname) {
      fail('artifact_cas_uri_namespace_invalid');
      return;
    }
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== 'sha256' || !SHA256_DIGEST_PATTERN.test(parts[1])) {
      fail('artifact_cas_uri_path_invalid');
      return;
    }
    if (contentHash && parts[1] !== contentHash.slice('sha256:'.length)) {
      fail('artifact_cas_uri_hash_mismatch');
    }
  } catch {
    fail('artifact_cas_uri_invalid');
  }
}

function visualArtifactCasLocatorValidation(locator, roots) {
  if (!isObject(locator)) return null;
  const reasons = [];
  const fail = (reason) => reasons.push(reason);
  const result = {
    accepted: false,
    acceptedAsTransportEvidence: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    proofAuthority: 'transport_integrity_only',
    contentHash: null,
    manifestHash: null,
    localPath: null,
    reasons,
  };
  if (firstString(locator.schemaVersion, locator.schema_version) !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) {
    fail('artifact_cas_manifest_schema_invalid');
  }
  const role = visualArtifactLocatorRole(locator);
  if (!role) fail('artifact_cas_visual_role_missing');
  if (!visualCasLocatorLooksLikeImageEvidence(locator)) {
    fail('artifact_cas_visual_media_type_missing');
  }
  let contentHash = null;
  try {
    contentHash = visualArtifactLocatorHash(locator);
    if (!contentHash) throw new Error('missing_hash');
    result.contentHash = contentHash;
  } catch {
    fail('artifact_cas_content_hash_invalid');
  }
  try {
    const artifactHash = hashFromArtifactId(firstString(locator.artifactId, locator.artifact_id));
    if (contentHash && artifactHash !== contentHash) {
      fail('artifact_cas_artifact_id_hash_mismatch');
    }
  } catch {
    fail('artifact_cas_artifact_id_invalid');
  }
  validateVisualArtifactCasUri(locator, contentHash, fail);
  const byteLength = Number(locator.byteLength ?? locator.byte_length);
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    fail('artifact_cas_byte_length_invalid');
  }
  const transport = isObject(locator.transport) ? locator.transport : {};
  if (transport.contentAddressed !== true && transport.content_addressed !== true) {
    fail('artifact_cas_transport_not_content_addressed');
  }
  if (transport.bytesEmbedded === true || transport.bytes_embedded === true) {
    fail('artifact_cas_manifest_embeds_bytes');
  }
  if (
    locator.acceptedForGpuHmr === true
    || locator.accepted_for_gpu_hmr === true
    || locator.gpuHmrSuccess === true
    || locator.gpu_hmr_success === true
  ) {
    fail('artifact_cas_manifest_claims_gpu_hmr_success');
  }
  const declaredManifestHash = firstString(locator.manifestHash, locator.manifest_hash);
  const manifestHashInput = { ...locator, manifestHash: undefined };
  if (Object.prototype.hasOwnProperty.call(manifestHashInput, 'manifest_hash')) {
    manifestHashInput.manifest_hash = undefined;
  }
  result.manifestHash = casSha256Text(stableJson(manifestHashInput));
  if (declaredManifestHash && declaredManifestHash !== result.manifestHash) {
    fail('artifact_cas_manifest_hash_mismatch');
  }
  if (contentHash) {
    const resolvedPath = resolveReadableCasLocatorPath(locator, roots, contentHash, fail);
    if (resolvedPath) {
      result.localPath = resolvedPath;
      try {
        const bytes = readFileSync(resolvedPath);
        const readableHash = sha256Bytes(bytes);
        if (readableHash !== contentHash) fail('artifact_cas_readable_hash_mismatch');
        if (Number.isSafeInteger(byteLength) && bytes.byteLength !== byteLength) {
          fail('artifact_cas_readable_byte_length_mismatch');
        }
      } catch {
        fail('artifact_cas_local_path_unreadable');
      }
    }
  }
  if (reasons.length === 0) {
    result.accepted = true;
    result.acceptedAsTransportEvidence = true;
  }
  return result;
}

function visualArtifactDimensions(object) {
  if (!isObject(object)) return null;
  return dimensionsFromValue(firstArray(
    object.swapchain_size,
    object.swapchainSize,
    object.framebuffer_size,
    object.framebufferSize,
    object.capture_size,
    object.captureSize,
    object.image_size,
    object.imageSize,
    object.dimensions,
    object.size,
    object.resolution,
  )) ?? dimensionsFromValue(firstObject(
    object.swapchain_size,
    object.swapchainSize,
    object.framebuffer_size,
    object.framebufferSize,
    object.capture_size,
    object.captureSize,
    object.image_size,
    object.imageSize,
    object.dimensions,
    object.size,
    object.resolution,
  )) ?? dimensionsFromValue(object);
}

function visualArtifactDimensionsForRole(object, role) {
  if (!isObject(object)) return null;
  if (role === 'before') {
    return dimensionsFromValue(firstArray(
      object.before_image_size,
      object.beforeImageSize,
      object.before_image_dimensions,
      object.beforeImageDimensions,
      object.before_dimensions,
      object.beforeDimensions,
    )) ?? dimensionsFromValue(firstObject(
      object.before_image_size,
      object.beforeImageSize,
      object.before_image_dimensions,
      object.beforeImageDimensions,
      object.before_dimensions,
      object.beforeDimensions,
    ));
  }
  if (role === 'after') {
    return dimensionsFromValue(firstArray(
      object.after_image_size,
      object.afterImageSize,
      object.after_image_dimensions,
      object.afterImageDimensions,
      object.after_dimensions,
      object.afterDimensions,
    )) ?? dimensionsFromValue(firstObject(
      object.after_image_size,
      object.afterImageSize,
      object.after_image_dimensions,
      object.afterImageDimensions,
      object.after_dimensions,
      object.afterDimensions,
    ));
  }
  if (role === 'diff') {
    return dimensionsFromValue(firstArray(
      object.diff_image_size,
      object.diffImageSize,
      object.diff_image_dimensions,
      object.diffImageDimensions,
      object.diff_dimensions,
      object.diffDimensions,
    )) ?? dimensionsFromValue(firstObject(
      object.diff_image_size,
      object.diffImageSize,
      object.diff_image_dimensions,
      object.diffImageDimensions,
      object.diff_dimensions,
      object.diffDimensions,
    ));
  }
  return null;
}

function visualArtifactEntriesFromValue(value) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => visualArtifactEntriesFromValue(entry));
  }
  if (!isObject(value)) return [];
  const sharedDimensions = visualArtifactDimensions(value);
  const locators = visualArtifactCasLocators(value);
  const directPath = firstString(
    value.path,
    value.sourcePath,
    value.source_path,
    value.localPath,
    value.local_path,
    value.absolutePath,
    value.absolute_path,
    value.filePath,
    value.file_path,
    value.file,
    value.uri,
  );
  const entries = [];
  if (directPath) {
    const role = visualArtifactRole(value, directPath);
    entries.push({
      role,
      path: directPath,
      hash: visualArtifactHashForRole(value, role),
      declaredDimensions: visualArtifactDimensionsForRole(value, role) ?? sharedDimensions,
      artifactCasLocator: visualArtifactCasLocatorForEntry(locators, role, visualArtifactHashForRole(value, role)),
    });
  }
  const pushRole = (role, pathValues, hashValues) => {
    const rolePath = firstString(...pathValues);
    const hash = firstString(...hashValues);
    const artifactCasLocator = visualArtifactCasLocatorForEntry(locators, role, hash);
    if (!rolePath && !hash && !artifactCasLocator) return;
    entries.push({
      role,
      path: rolePath,
      hash: hash ?? visualArtifactLocatorHash(artifactCasLocator),
      declaredDimensions: visualArtifactDimensionsForRole(value, role) ?? sharedDimensions,
      artifactCasLocator,
    });
  };
  pushRole('before', [value.before_image, value.beforeImage], [value.before_image_hash, value.beforeImageHash]);
  pushRole('after', [value.after_image, value.afterImage], [value.after_image_hash, value.afterImageHash]);
  pushRole('diff', [value.diff_image, value.diffImage], [value.diff_image_hash, value.diffImageHash]);
  pushRole('before', [value.baseline_image, value.baselineImage, value.baselineCapturePath, value.baseline_capture_path], []);
  pushRole('after', [value.changed_image, value.changedImage, value.changedCapturePath, value.changed_capture_path], []);
  const existingCasKeys = new Set(entries.map((entry) =>
    `${entry.role}:${normalizeSha256(entry.hash) ?? 'unknown'}`
  ));
  for (const locator of locators) {
    const role = visualArtifactLocatorRole(locator);
    if (!['before', 'after', 'diff'].includes(role)) continue;
    const hash = visualArtifactLocatorHash(locator);
    const key = `${role}:${hash ?? 'unknown'}`;
    if (existingCasKeys.has(key)) continue;
    existingCasKeys.add(key);
    entries.push({
      role,
      path: null,
      hash,
      declaredDimensions: visualArtifactDimensionsForRole(value, role) ?? sharedDimensions,
      artifactCasLocator: locator,
    });
  }
  return entries;
}

function recordClaimsVisualOutput(record) {
  const outputEvent = firstObject(record.output_event, record.outputEvent) ?? {};
  const kind = normalizedText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind) ?? '';
  return isGpuHmrVisualOutputOracleKind(kind)
    || visualArtifactsPresent(record);
}

function outputOracleKindDeclarationFailures(proofLedger) {
  return compactStrings(ledgerRecords(proofLedger).map((record) => {
    const outputEvent = firstObject(record.output_event, record.outputEvent) ?? {};
    return classifyGpuHmrOutputOracleKind(
      normalizedText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind),
    ).failureCode;
  }));
}

function visualOracleDeclarationFailures(proofLedger, options = {}) {
  const records = ledgerRecords(proofLedger).filter(recordClaimsVisualOutput);
  if (records.length === 0) return [];
  const roots = visualArtifactRoots(options);
  const entries = records.flatMap((record) =>
    visualArtifactObjects(record).flatMap((object) => visualArtifactEntriesFromValue(object))
  );
  const casLocatorAuditFailures = records.flatMap((record) =>
    visualArtifactObjects(record).flatMap((object) => visualArtifactCasLocatorAuditFailures(object, roots))
  );
  const hasRole = (role) => entries.some((entry) =>
    entry.role === role && (entry.path || entry.artifactCasLocator)
  );
  const hasContentAddressedHash = (role) => entries.some((entry) =>
    entry.role === role && contentAddressedSha256(entry.hash)
  );
  const declaredHashes = entries
    .map((entry) => entry.hash)
    .filter((hash) => hash !== undefined && hash !== null && String(hash).trim() !== '');
  const allDeclaredHashesContentAddressed = declaredHashes.every(contentAddressedSha256);
  const matchedHashesByRole = new Map();
  const addMatchedRoleHash = (role, hash) => {
    if (!normalizeSha256(hash)) return;
    const existing = matchedHashesByRole.get(role) ?? new Set();
    existing.add(normalizeSha256(hash));
    matchedHashesByRole.set(role, existing);
  };
  const byteBackedRoleFailures = ['before', 'after', 'diff'].flatMap((role) => {
    const roleEntries = entries.filter((entry) => entry.role === role);
    const hashedEntries = roleEntries.filter((entry) => normalizeSha256(entry.hash));
    if (hashedEntries.length === 0) return [];
    const validations = hashedEntries.map((entry) => ({
      expectedHash: normalizeSha256(entry.hash),
      declaredDimensions: entry.declaredDimensions,
      actual: visualArtifactByteHash(entry, roots),
    }));
    const readable = validations.filter((validation) => validation.actual);
    const matched = readable.some((validation) =>
      validation.expectedHash === validation.actual.hash
    );
    const matchedPng = readable.some((validation) =>
      validation.expectedHash === validation.actual.hash
      && validation.actual.pngHeader?.accepted === true
    );
    const declaredDimensionChecks = readable.filter((validation) =>
      validation.expectedHash === validation.actual.hash
      && validation.actual.pngHeader?.accepted === true
      && validation.declaredDimensions
    );
    const dimensionsMatched = declaredDimensionChecks.length === 0
      || declaredDimensionChecks.some((validation) =>
        sameDimensions(validation.declaredDimensions, validation.actual.pngHeader)
      );
    const invalidCasLocator = validations.some((validation) =>
      validation.actual?.casValidation
      && validation.actual.casValidation.accepted !== true
    );
    for (const validation of readable) {
      if (validation.expectedHash === validation.actual.hash) {
        addMatchedRoleHash(role, validation.actual.hash);
      }
    }
    return compactStrings([
      readable.length > 0 ? null : `visual_oracle_${role}_image_bytes_unreadable`,
      invalidCasLocator ? `visual_oracle_${role}_image_cas_locator_invalid` : null,
      matched ? null : `visual_oracle_${role}_image_hash_mismatch`,
      matched && !matchedPng ? `visual_oracle_${role}_image_png_invalid` : null,
      matchedPng && !dimensionsMatched ? `visual_oracle_${role}_image_dimensions_mismatch` : null,
    ]);
  });
  const rolesShareMatchedHash = (left, right) => {
    const leftHashes = matchedHashesByRole.get(left) ?? new Set();
    const rightHashes = matchedHashesByRole.get(right) ?? new Set();
    return [...leftHashes].some((hash) => rightHashes.has(hash));
  };
  return compactStrings([
    entries.length > 0 ? null : 'visual_oracle_artifacts_missing',
    hasRole('before') ? null : 'visual_oracle_before_image_missing',
    hasRole('after') ? null : 'visual_oracle_after_image_missing',
    hasRole('diff') ? null : 'visual_oracle_diff_image_missing',
    hasContentAddressedHash('before') ? null : 'visual_oracle_before_image_hash_missing',
    hasContentAddressedHash('after') ? null : 'visual_oracle_after_image_hash_missing',
    hasContentAddressedHash('diff') ? null : 'visual_oracle_diff_image_hash_missing',
    allDeclaredHashesContentAddressed ? null : 'visual_oracle_image_hash_not_content_addressed',
    rolesShareMatchedHash('before', 'after')
      ? 'visual_oracle_before_after_image_hashes_not_distinct'
      : null,
    (
      rolesShareMatchedHash('before', 'diff')
      || rolesShareMatchedHash('after', 'diff')
    )
      ? 'visual_oracle_diff_image_hash_not_distinct'
      : null,
    ...byteBackedRoleFailures,
    ...casLocatorAuditFailures,
  ]);
}

function computeDeclaredRawHash(source) {
  return normalizeSha256(firstString(
    source.raw_readback_hash,
    source.rawReadbackHash,
    source.readback_hash,
    source.readbackHash,
  ));
}

function computeDeclaredRawByteLength(source) {
  const verification = firstObject(
    source.raw_readback_verification,
    source.rawReadbackVerification,
    source.byte_verification,
    source.byteVerification,
  ) ?? {};
  const value = source.raw_readback_byte_length
    ?? source.rawReadbackByteLength
    ?? source.byte_length
    ?? source.byteLength
    ?? verification.byte_length
    ?? verification.byteLength;
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function computeDeterministicSlice(source) {
  return firstObject(source.deterministic_slice, source.deterministicSlice) ?? {};
}

function computeDeterministicSliceHash(source, slice) {
  const verification = firstObject(
    source.raw_readback_verification,
    source.rawReadbackVerification,
    source.byte_verification,
    source.byteVerification,
  ) ?? {};
  return normalizeSha256(firstString(
    source.deterministic_slice_hash,
    source.deterministicSliceHash,
    slice.hash,
    slice.sha256,
    slice.slice_hash,
    slice.sliceHash,
    verification.deterministic_slice_hash,
    verification.deterministicSliceHash,
    verification.slice_hash,
    verification.sliceHash,
  ));
}

function zeroOrPositiveInteger(value) {
  const numeric = Number(value);
  return Number.isSafeInteger(numeric) && numeric >= 0 ? numeric : null;
}

function computeOracleRawReadbackBytes(source, roots, expectedHash = null, pathBaseRoots = roots) {
  const rawPath = firstString(source.raw_readback_bin, source.rawReadbackBin);
  const resolvedPath = resolveReadableComputeArtifactPath(rawPath, roots, pathBaseRoots);
  if (resolvedPath) {
    try {
      return {
        path: resolvedPath,
        bytes: readFileSync(resolvedPath),
        casValidation: null,
      };
    } catch {
      return null;
    }
  }
  const validations = computeRawReadbackLocators(source, roots, pathBaseRoots)
    .map((locator) => computeArtifactLocatorValidation(locator, roots, expectedHash))
    .filter(Boolean);
  const accepted = validations.find((validation) => validation.accepted === true && validation.localPath);
  if (!accepted) {
    return validations.length > 0
      ? { path: null, bytes: null, casValidations: validations }
      : null;
  }
  try {
    return {
      path: accepted.localPath,
      bytes: readFileSync(accepted.localPath),
      casValidation: accepted,
    };
  } catch {
    return { path: accepted.localPath, bytes: null, casValidation: accepted };
  }
}

function computeOracleDeclarationFailures(proofLedger, options = {}) {
  const records = ledgerRecords(proofLedger).filter((record) =>
    computeArtifactsPresent(record) && !recordClaimsVisualOutput(record)
  );
  if (records.length === 0) return [];
  const roots = computeArtifactRoots(options);
  const pathBaseRoots = computeArtifactPathBaseRoots(options);
  const failures = [];
  const addFailure = (code) => {
    if (code) failures.push(code);
  };
  for (const artifacts of records.flatMap(computeOracleArtifactObjects)) {
    const declaredHash = computeDeclaredRawHash(artifacts);
    const declaredByteLength = computeDeclaredRawByteLength(artifacts);
    const byteEvidence = computeOracleRawReadbackBytes(artifacts, roots, declaredHash, pathBaseRoots);
    const bytes = byteEvidence?.bytes;
    const casValidations = [
      ...(byteEvidence?.casValidation ? [byteEvidence.casValidation] : []),
      ...(Array.isArray(byteEvidence?.casValidations) ? byteEvidence.casValidations : []),
    ];
    if (casValidations.some((validation) => validation.accepted !== true)) {
      addFailure('compute_oracle_raw_readback_cas_locator_invalid');
    }
    if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
      addFailure('compute_oracle_raw_readback_bytes_unreadable');
      continue;
    }
    const actualHash = sha256Bytes(bytes);
    if (!declaredHash) {
      addFailure('compute_oracle_raw_readback_hash_missing');
    } else if (actualHash !== declaredHash) {
      addFailure('compute_oracle_raw_readback_hash_mismatch');
    }
    if (declaredByteLength === null) {
      addFailure('compute_oracle_raw_readback_byte_length_missing');
    } else if (bytes.length !== declaredByteLength) {
      addFailure('compute_oracle_raw_readback_byte_length_mismatch');
    }
    const slice = computeDeterministicSlice(artifacts);
    const sliceOffset = zeroOrPositiveInteger(slice.offset ?? slice.byte_offset ?? slice.byteOffset);
    const sliceLength = positiveInteger(slice.length ?? slice.byte_length ?? slice.byteLength);
    const declaredSliceHash = computeDeterministicSliceHash(artifacts, slice);
    if (sliceOffset === null || sliceLength === null) {
      addFailure('compute_oracle_deterministic_slice_bounds_missing');
    } else if (sliceOffset + sliceLength > bytes.length) {
      addFailure('compute_oracle_deterministic_slice_out_of_bounds');
    } else {
      const actualSliceHash = sha256Bytes(bytes.subarray(sliceOffset, sliceOffset + sliceLength));
      if (!declaredSliceHash) {
        addFailure('compute_oracle_deterministic_slice_hash_missing');
      } else if (declaredSliceHash !== actualSliceHash) {
        addFailure('compute_oracle_deterministic_slice_hash_mismatch');
      }
    }
  }
  return compactStrings(failures);
}

function visualOracleArtifactOverlaysFromLedger(proofLedger, options = {}) {
  const roots = visualArtifactRoots(options);
  const overlays = [];
  for (const [index, record] of ledgerRecords(proofLedger).entries()) {
    const entries = visualArtifactObjects(record).flatMap((object) => visualArtifactEntriesFromValue(object));
    const overlay = {};
    for (const role of ['before', 'after', 'diff']) {
      const accepted = entries
        .filter((entry) => entry.role === role && entry.artifactCasLocator)
        .map((entry) => ({
          entry,
          expectedHash: normalizeSha256(entry.hash),
          actual: visualArtifactByteHash(entry, roots),
        }))
        .find((validation) =>
          validation.expectedHash
          && validation.actual?.casValidation?.accepted === true
          && validation.actual.hash === validation.expectedHash
          && validation.actual.resolvedPath
        );
      if (!accepted) continue;
      if (role === 'before') {
        overlay.before_image = accepted.actual.resolvedPath;
        overlay.beforeImage = accepted.actual.resolvedPath;
      } else if (role === 'after') {
        overlay.after_image = accepted.actual.resolvedPath;
        overlay.afterImage = accepted.actual.resolvedPath;
      } else if (role === 'diff') {
        overlay.diff_image = accepted.actual.resolvedPath;
        overlay.diffImage = accepted.actual.resolvedPath;
      }
    }
    if (Object.keys(overlay).length > 0) {
      overlays[index] = {
        ...overlay,
        proofAuthority: 'resolved_visual_artifact_overlay_transport_integrity_only',
        proof_authority: 'resolved_visual_artifact_overlay_transport_integrity_only',
        acceptedForGpuHmr: false,
        accepted_for_gpu_hmr: false,
        gpuHmrSuccess: false,
        gpu_hmr_success: false,
      };
    }
  }
  return overlays;
}

function outputOracleTarget(record) {
  const outputEvent = firstObject(record?.output_event, record?.outputEvent) ?? {};
  const outputOracle = firstObject(outputEvent.output_oracle, outputEvent.outputOracle) ?? {};
  return firstObject(
    record?.output_oracle_target,
    record?.outputOracleTarget,
    outputEvent.output_oracle_target,
    outputEvent.outputOracleTarget,
    outputOracle.output_oracle_target,
    outputOracle.outputOracleTarget,
  );
}

function outputOracleTargetKind(target) {
  return normalizedText(target?.kind, target?.target_kind, target?.targetKind);
}

function computeOnlyOutputTargetVerified(record) {
  const target = outputOracleTarget(record);
  return outputOracleTargetKind(target) === 'compute'
    && (target.compute_only_target_verified === true || target.computeOnlyTargetVerified === true);
}

function recordRequiresDeterministicVisualMode(record) {
  const backend = normalizedText(record.backend);
  const outputEvent = firstObject(record.output_event, record.outputEvent) ?? {};
  const kind = normalizedText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind) ?? '';
  const computeOnlyOutput = computeOnlyOutputTargetVerified(record);
  return (!computeOnlyOutput && VISUAL_OR_ENGINE_BACKENDS.has(backend))
    || isGpuHmrVisualOutputOracleKind(kind)
    || visualArtifactsPresent(record);
}

function ledgerRequiresDeterministicVisualMode(ledger) {
  return ledgerRecords(ledger).some(recordRequiresDeterministicVisualMode);
}

function proofLedgerSourceConsistencyMode(sourceConsistency) {
  return normalizedText(sourceConsistency?.mode);
}

export function adversarialPreflightStrictGate(preflight, options = {}) {
  const failures = [];
  if (!isObject(preflight)) {
    failures.push('adversarial_preflight_missing');
  } else {
    if (preflight.skipped === true) failures.push('adversarial_preflight_skipped');
    if (preflight.ok !== true) failures.push('adversarial_preflight_not_ok');
    if (Number.isFinite(preflight.exitCode) && preflight.exitCode !== 0) {
      failures.push('adversarial_preflight_exit_nonzero');
    }
    if (preflight.error) failures.push('adversarial_preflight_error_present');
    if (typeof preflight.scriptPath !== 'string' || !preflight.scriptPath.trim()) {
      failures.push('adversarial_preflight_script_path_missing');
    }
    if (typeof preflight.stdoutHash !== 'string' || !preflight.stdoutHash.trim()) {
      failures.push('adversarial_preflight_stdout_hash_missing');
    }
    if (typeof preflight.stderrHash !== 'string' || !preflight.stderrHash.trim()) {
      failures.push('adversarial_preflight_stderr_hash_missing');
    }
  }
  return gateRow(
    options.name ?? 'strict adversarial preflight acceptance',
    failures,
    `script=${preflight?.scriptPath ?? 'unknown'} elapsed_ms=${Number(preflight?.elapsedMs ?? 0).toFixed(1)}`,
  );
}

export function runtimeProofArtifactStrictGate(record, options = {}) {
  const artifact = proofArtifactFromRecord(record);
  const failures = [];
  if (!artifact) {
    failures.push('runtime_proof_artifact_missing');
  } else {
    const proofLedgerQuery = firstObject(
      artifact.proofLedgerQuery,
      artifact.proof_ledger_query,
    );
    const proofLedger = firstObject(
      artifact.proofLedger,
      artifact.proof_ledger,
    );
    const acceptanceContract = firstObject(
      artifact.acceptanceContract,
      artifact.acceptance_contract,
    );
    const acceptanceContractEvaluation = firstObject(
      artifact.acceptanceContractEvaluation,
      artifact.acceptance_contract_evaluation,
    );
    const acceptanceContractConsistencyCamel = isObject(artifact.acceptanceContractConsistency)
      ? artifact.acceptanceContractConsistency
      : null;
    const acceptanceContractConsistencySnake = isObject(artifact.acceptance_contract_consistency)
      ? artifact.acceptance_contract_consistency
      : null;
    const acceptanceContractConsistency = firstObject(
      acceptanceContractConsistencyCamel,
      acceptanceContractConsistencySnake,
    );
    const acceptanceContractConsistencyAliasMismatch =
      acceptanceContractConsistencyCamel
      && acceptanceContractConsistencySnake
      && stableJson(acceptanceContractConsistencyCamel) !== stableJson(acceptanceContractConsistencySnake);
    const proofLedgerSourceConsistency = firstObject(
      artifact.proofLedgerSourceConsistency,
      artifact.proof_ledger_source_consistency,
    );
    const deterministicVisualModeEvaluation = firstObject(
      artifact.deterministicVisualModeEvaluation,
      artifact.deterministic_visual_mode_evaluation,
    );
    const stageResults = firstArray(
      artifact.stageResults,
      artifact.stage_results,
    );
    const limitations = firstArray(artifact.limitations);
    const gpuHmrSuccess = artifact.gpuHmrSuccess === true
      || artifact.gpu_hmr_success === true;
    const visualLedgerRequiresDeterministicMode =
      proofLedger && ledgerRequiresDeterministicVisualMode(proofLedger);
    let recomputedProofLedgerQuery = null;
    let visualOverlayUsed = false;
    failures.push(...hipModuleHardwareTargetFailures({
      artifact,
      acceptanceContract,
      proofLedger,
    }));

    if (artifact.fullRuntimeProven !== true && artifact.full_runtime_proven !== true) {
      failures.push('runtime_full_proof_not_proven');
    }
    if (!gpuHmrSuccess) failures.push('runtime_proof_artifact_gpu_hmr_success_false');
    if (!stageResults || stageResults.length === 0) {
      failures.push('runtime_proof_artifact_stage_results_missing');
    } else if (stageResults.some((stage) => firstObject(stage)?.status !== 'passed')) {
      failures.push('runtime_proof_artifact_stage_failed');
    }
    if (!limitations) {
      failures.push('runtime_proof_artifact_limitations_missing');
    } else if (limitations.length > 0) {
      failures.push('runtime_proof_artifact_limitations_present');
    }
    if (!proofLedger) {
      failures.push('proof_ledger_missing');
    } else {
      const visualOracleArtifactOverlays = visualOracleArtifactOverlaysFromLedger(proofLedger, options);
      visualOverlayUsed = visualOracleArtifactOverlays.some((overlay) =>
        isObject(overlay) && Object.keys(overlay).length > 0
      );
      recomputedProofLedgerQuery = queryGpuHmrLedgerInvariants(
        proofLedger,
        {
          requireVisualCaptureRuntimeBinding: visualLedgerRequiresDeterministicMode,
          ...(visualOverlayUsed ? {
            visualOracleArtifactOverlays,
            ignoreSuppliedLedgerQueryAndSuccess: true,
          } : {}),
        },
      );
      if (recomputedProofLedgerQuery.gpuHmrSuccess !== true) {
        failures.push('proof_ledger_recomputed_query_rejected');
      }
      if (
        proofLedgerQuery
        && (
          proofLedgerQuery.gpuHmrSuccess !== recomputedProofLedgerQuery.gpuHmrSuccess
          || !sameCodes(proofLedgerQuery.failedInvariants, recomputedProofLedgerQuery.failedInvariants)
        )
      ) {
        failures.push('proof_ledger_query_mismatch');
      }
      failures.push(...outputOracleKindDeclarationFailures(proofLedger));
      failures.push(...visualOracleDeclarationFailures(proofLedger, options));
      failures.push(...computeOracleDeclarationFailures(proofLedger, options));
    }
    if (!proofLedgerQuery) {
      failures.push('proof_ledger_query_missing');
    } else if (proofLedgerQuery.gpuHmrSuccess !== true) {
      failures.push('proof_ledger_query_rejected');
    }
    if (!acceptanceContract) {
      failures.push('acceptance_contract_missing');
    } else {
      const recomputedAcceptance = evaluateGpuHmrAcceptanceContract(acceptanceContract);
      if (recomputedAcceptance.accepted !== true) {
        failures.push('acceptance_contract_recomputed_rejected');
      }
      if (
        acceptanceContractEvaluation
        && (
          acceptanceContractEvaluation.accepted !== recomputedAcceptance.accepted
          || !sameCodes(acceptanceContractEvaluation.failedGates, recomputedAcceptance.failedGates)
        )
      ) {
        failures.push('acceptance_contract_evaluation_mismatch');
      }
    }
    if (!acceptanceContractEvaluation) {
      failures.push('acceptance_contract_evaluation_missing');
    } else if (acceptanceContractEvaluation.accepted !== true) {
      failures.push('acceptance_contract_rejected');
    }
    if (acceptanceContractConsistencyAliasMismatch) {
      failures.push('acceptance_contract_consistency_alias_mismatch');
    }
    if (!acceptanceContractConsistency) {
      failures.push('acceptance_contract_consistency_missing');
    } else if (acceptanceContractConsistency.accepted !== true) {
      failures.push('acceptance_contract_consistency_rejected');
    } else if (acceptanceContractConsistency.checked !== true) {
      failures.push('acceptance_contract_consistency_unchecked');
    }
    if (!proofLedgerSourceConsistency) {
      failures.push('proof_ledger_source_consistency_missing');
    } else if (proofLedgerSourceConsistency.accepted !== true) {
      failures.push('proof_ledger_source_consistency_rejected');
    } else if (!ACCEPTED_PROOF_LEDGER_SOURCE_CONSISTENCY_MODES.has(
      proofLedgerSourceConsistencyMode(proofLedgerSourceConsistency),
    )) {
      failures.push('proof_ledger_source_consistency_unverified_mode');
    }
    if (visualLedgerRequiresDeterministicMode && !deterministicVisualModeEvaluation) {
      failures.push('deterministic_visual_mode_missing');
    }
    if (
      deterministicVisualModeEvaluation
      && deterministicVisualModeEvaluation.accepted !== true
    ) {
      failures.push('deterministic_visual_mode_rejected');
    }
  }
  return gateRow(
    options.name ?? 'strict runtime proof artifact acceptance',
    failures,
    `proof_id=${artifact?.proofId ?? artifact?.proof_id ?? 'unknown'}`,
  );
}

export function runtimeProofArtifactStrictGates(records, options = {}) {
  const list = Array.isArray(records) ? records.filter(Boolean) : [];
  if (list.length === 0 && options.requireAtLeastOne !== false) {
    return [
      gateRow(
        options.missingName ?? 'strict runtime proof artifact presence',
        ['runtime_proof_artifact_missing'],
        'runtime proof artifact present',
      ),
    ];
  }
  return list.map((record, index) => runtimeProofArtifactStrictGate(record, {
    ...options,
    name: `${options.namePrefix ?? 'strict runtime proof artifact acceptance'} ${proofArtifactLabel(record, index)}`,
  }));
}

export function strictProofGateFailures(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.status === 'fail');
}
