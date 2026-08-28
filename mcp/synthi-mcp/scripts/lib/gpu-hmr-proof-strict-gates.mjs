import { createHash } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { types as utilTypes } from 'node:util';

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
import { verifyComputeOracleSemantics } from './gpu-hmr-compute-oracle-semantics.mjs';

export const GPU_HMR_STRICT_PROOF_GATES_SCHEMA_VERSION =
  'synthi.gpu_hmr.strict_proof_gates.v2';

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

function ownValue(value, key) {
  return isObject(value) && Object.prototype.hasOwnProperty.call(value, key)
    ? value[key]
    : undefined;
}

function firstOwnObject(value, ...keys) {
  return firstObject(...keys.map((key) => ownValue(value, key)));
}

function firstOwnArray(value, ...keys) {
  return firstArray(...keys.map((key) => ownValue(value, key)));
}

function plainDataTreeFailure(value) {
  const pending = [{ value, leave: false }];
  const active = new Set();
  const complete = new Set();
  while (pending.length > 0) {
    const entry = pending.pop();
    const current = entry.value;
    if (current === null || typeof current === 'string' || typeof current === 'boolean') continue;
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) return 'nonfinite_number';
      if (Object.is(current, -0)) return 'negative_zero';
      continue;
    }
    if (typeof current === 'bigint') return 'bigint';
    if (typeof current === 'symbol') return 'symbol_value';
    if (typeof current === 'undefined') return 'undefined_value';
    if (typeof current === 'function') return 'function_value';
    if (typeof current !== 'object') return 'unsupported_value';
    try {
      if (utilTypes.isProxy(current)) return 'proxy';
    } catch {
      return 'introspection_failed';
    }
    if (entry.leave) {
      active.delete(current);
      complete.add(current);
      continue;
    }
    if (complete.has(current)) continue;
    if (active.has(current)) return 'cycle';
    active.add(current);
    pending.push({ value: current, leave: true });
    let prototype;
    let descriptors;
    let keys;
    let array;
    try {
      array = Array.isArray(current);
      prototype = Object.getPrototypeOf(current);
      descriptors = Object.getOwnPropertyDescriptors(current);
      keys = Reflect.ownKeys(descriptors);
    } catch {
      return 'introspection_failed';
    }
    if (keys.some((key) => typeof key === 'symbol')) return 'symbol_property';
    if (array) {
      if (prototype !== Array.prototype) return 'array_prototype';
      const names = keys;
      const lengthDescriptor = descriptors.length;
      const length = lengthDescriptor?.value;
      if (
        !lengthDescriptor
        || !Object.prototype.hasOwnProperty.call(lengthDescriptor, 'value')
        || !Number.isSafeInteger(length)
        || length < 0
        || names.length !== length + 1
        || names.some((name) => name !== 'length' && !/^(?:0|[1-9][0-9]*)$/u.test(name))
      ) {
        return 'array_shape';
      }
      for (let index = 0; index < length; index += 1) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) return 'array_shape';
        if (!('value' in descriptor)) return 'array_element_accessor';
        if (descriptor.enumerable !== true) {
          return 'array_element_descriptor';
        }
        pending.push({ value: descriptor.value, leave: false });
      }
      continue;
    }
    if (prototype !== Object.prototype && prototype !== null) return 'object_prototype';
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!('value' in descriptor)) return 'accessor_property';
      if (descriptor.enumerable !== true) {
        return 'object_property_descriptor';
      }
      pending.push({ value: descriptor.value, leave: false });
    }
  }
  return null;
}

function stableDataEqual(left, right) {
  if (plainDataTreeFailure(left) || plainDataTreeFailure(right)) return false;
  try {
    return stableJson(left) === stableJson(right);
  } catch {
    return false;
  }
}

function strictOwnAliasedValue(source, keys, failures, code) {
  if (!isObject(source)) {
    failures.push(`${code}_container_missing`);
    return undefined;
  }
  for (const key of keys) {
    if (key in source && !Object.prototype.hasOwnProperty.call(source, key)) {
      failures.push(`${code}_prototype_inherited`);
    }
  }
  const present = keys.flatMap((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor) return [];
    if (!('value' in descriptor) || descriptor.enumerable !== true) {
      failures.push(`${code}_property_descriptor_invalid`);
      return [];
    }
    return [{ key, value: descriptor.value }];
  });
  if (
    present.length > 1
    && present.some((entry) => !stableDataEqual(entry.value, present[0].value))
  ) {
    failures.push(`${code}_alias_conflict`);
  }
  return present[0]?.value;
}

function strictOwnAliasedObject(source, keys, failures, code) {
  const value = strictOwnAliasedValue(source, keys, failures, code);
  if (value === undefined) return null;
  if (!isObject(value)) {
    failures.push(`${code}_invalid`);
    return null;
  }
  const shapeFailure = plainDataTreeFailure(value);
  if (shapeFailure) failures.push(`${code}_${shapeFailure}`);
  return value;
}

function strictOwnAliasedString(source, keys, failures, code) {
  const value = strictOwnAliasedValue(source, keys, failures, code);
  const normalized = typeof value === 'string' && value.trim() ? value.trim() : null;
  if (value !== undefined && !normalized) failures.push(`${code}_invalid`);
  return normalized;
}

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
  if (isObject(ownValue(record, 'artifact'))) return record.artifact;
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
  if (Object.prototype.hasOwnProperty.call(ledger, 'records')) {
    return Array.isArray(ledger.records) ? ledger.records.filter(isObject) : [];
  }
  if (isObject(ownValue(ledger, 'record'))) return [ledger.record];
  return [ledger];
}

function topLevelObjectAliasMismatch(value, camelKey, snakeKey) {
  if (!isObject(value)) return false;
  const hasCamel = Object.prototype.hasOwnProperty.call(value, camelKey);
  const hasSnake = Object.prototype.hasOwnProperty.call(value, snakeKey);
  return hasCamel
    && hasSnake
    && !stableDataEqual(value[camelKey], value[snakeKey]);
}

function acceptanceContractLedgerBindingFailures(proofLedger, recomputedContractHash) {
  if (!recomputedContractHash || !isObject(proofLedger)) return [];
  const records = ledgerRecords(proofLedger);
  if (records.length === 0) return ['proof_ledger_acceptance_contract_binding_record_missing'];
  const failures = [];
  for (const record of records) {
    const hasCamelHash = Object.prototype.hasOwnProperty.call(record, 'contractHash');
    const hasSnakeHash = Object.prototype.hasOwnProperty.call(record, 'contract_hash');
    const camelHash = hasCamelHash ? firstString(record.contractHash) : null;
    const snakeHash = hasSnakeHash ? firstString(record.contract_hash) : null;
    if (
      hasCamelHash
      && hasSnakeHash
      && !stableDataEqual(record.contractHash, record.contract_hash)
    ) {
      failures.push('proof_ledger_acceptance_contract_hash_alias_mismatch');
    }
    const recordHash = camelHash ?? snakeHash;
    if (!recordHash) {
      failures.push('proof_ledger_acceptance_contract_hash_missing');
    } else if (recordHash !== recomputedContractHash) {
      failures.push('proof_ledger_acceptance_contract_hash_mismatch');
    }
  }
  return failures;
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

const COMPUTE_ARTIFACT_ROOT_OPTION_SPECS = Object.freeze([
  ['computeArtifactRoots', true],
  ['compute_artifact_roots', true],
  ['allowedRoots', true],
  ['allowed_roots', true],
  ['allowedArtifactRoots', true],
  ['allowed_artifact_roots', true],
  ['allowedCasRoots', true],
  ['allowed_cas_roots', true],
  ['artifactRoot', false],
  ['artifact_root', false],
  ['artifactCasRoot', false],
  ['artifact_cas_root', false],
  ['casRoot', false],
  ['cas_root', false],
]);

function explicitComputeArtifactRootSelection(options = {}) {
  let supplied = false;
  let malformed = false;
  const roots = [];
  for (const [key, list] of COMPUTE_ARTIFACT_ROOT_OPTION_SPECS) {
    if (!Object.prototype.hasOwnProperty.call(options, key)) continue;
    supplied = true;
    const declared = options[key];
    const values = list
      ? (Array.isArray(declared) ? declared : null)
      : [declared];
    if (values === null || values.some((value) => typeof value !== 'string' || !value.trim())) {
      malformed = true;
      continue;
    }
    roots.push(...values.map((value) => value.trim()));
  }
  return {
    supplied,
    roots: malformed ? [] : [...new Set(roots)],
  };
}

function computeArtifactRoots(options = {}) {
  const explicit = explicitComputeArtifactRootSelection(options);
  return uniqueRealRoots(
    explicit.supplied ? explicit.roots : DEFAULT_VISUAL_ARTIFACT_ROOTS,
  );
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
  if ([
    'oracle_code',
    'oracle_implementation',
    'semantic_oracle_implementation',
    'compute_oracle_implementation',
    'runtime_compute_oracle_implementation',
  ].includes(role)) {
    return 'oracle_implementation';
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

function computeArtifactLocatorValidation(
  locator,
  roots,
  expectedHash = null,
  expectedRole = 'raw_readback',
) {
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
  const locatorShapeFailure = plainDataTreeFailure(locator);
  if (locatorShapeFailure) {
    fail(`artifact_cas_manifest_${locatorShapeFailure}`);
    return result;
  }
  if (firstString(locator.schemaVersion, locator.schema_version) !== CAS_ARTIFACT_LOCATOR_SCHEMA_VERSION) {
    fail('artifact_cas_manifest_schema_invalid');
  }
  const role = computeArtifactLocatorRole(locator);
  if (role !== expectedRole) fail(`artifact_cas_compute_role_not_${expectedRole}`);
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
  if (!manifestPath) {
    return {
      manifest: null,
      readError: 'artifact_cas_manifest_unreadable_or_outside_allowed_roots',
    };
  }
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

function computeReadbackSchemaLocators(source, roots, pathBaseRoots = roots) {
  const manifestValues = [
    source.readback_schema_cas_manifest,
    source.readbackSchemaCasManifest,
    source.readback_schema_locator,
    source.readbackSchemaLocator,
  ].filter((value) => value !== undefined && value !== null);
  const manifestLocators = manifestValues.flatMap((value) => {
    const loaded = readComputeArtifactLocatorManifest(value, 'readback_schema', roots, pathBaseRoots);
    return loaded.manifest ? [loaded.manifest] : [];
  });
  return [
    ...manifestLocators,
    ...computeArtifactCasLocators(source, 'readback_schema'),
  ];
}

function computeOracleImplementationLocators(source, roots, pathBaseRoots = roots) {
  const manifestValues = [
    source.oracle_implementation_cas_manifest,
    source.oracleImplementationCasManifest,
    source.semantic_oracle_implementation_cas_manifest,
    source.semanticOracleImplementationCasManifest,
    source.oracle_implementation_locator,
    source.oracleImplementationLocator,
    source.semantic_oracle_implementation_locator,
    source.semanticOracleImplementationLocator,
  ].filter((value) => value !== undefined && value !== null);
  const manifestLocators = manifestValues.flatMap((value) => {
    const loaded = readComputeArtifactLocatorManifest(
      value,
      'oracle_implementation',
      roots,
      pathBaseRoots,
    );
    return loaded.manifest ? [loaded.manifest] : [];
  });
  return [
    ...manifestLocators,
    ...computeArtifactCasLocators(source, 'oracle_implementation'),
  ];
}

const COMPUTE_CAS_ROLE_DECLARATIONS = Object.freeze([
  {
    role: 'raw_readback',
    fields: [
      'raw_readback_cas_manifest',
      'rawReadbackCasManifest',
      'raw_readback_locator',
      'rawReadbackLocator',
    ],
  },
  {
    role: 'readback_schema',
    fields: [
      'readback_schema_cas_manifest',
      'readbackSchemaCasManifest',
      'schema_cas_manifest',
      'schemaCasManifest',
      'readback_schema_locator',
      'readbackSchemaLocator',
    ],
  },
  {
    role: 'rendered_card',
    fields: [
      'rendered_card_cas_manifest',
      'renderedCardCasManifest',
      'proof_card_cas_manifest',
      'proofCardCasManifest',
      'rendered_card_locator',
      'renderedCardLocator',
    ],
  },
  {
    role: 'oracle_implementation',
    fields: [
      'oracle_implementation_cas_manifest',
      'oracleImplementationCasManifest',
      'semantic_oracle_implementation_cas_manifest',
      'semanticOracleImplementationCasManifest',
      'oracle_implementation_locator',
      'oracleImplementationLocator',
      'semantic_oracle_implementation_locator',
      'semanticOracleImplementationLocator',
    ],
  },
]);

function computeArtifactExpectedHash(source, role) {
  if (role === 'raw_readback') {
    return normalizeSha256(firstString(
      source.raw_readback_hash,
      source.rawReadbackHash,
      source.readback_hash,
      source.readbackHash,
    ));
  }
  if (role === 'readback_schema') {
    return normalizeSha256(firstString(
      source.readback_schema_hash,
      source.readbackSchemaHash,
      source.schema_hash,
      source.schemaHash,
    ));
  }
  if (role === 'oracle_implementation') {
    return normalizeSha256(firstString(
      source.oracle_code_hash,
      source.oracleCodeHash,
      source.semantic_oracle_implementation_hash,
      source.semanticOracleImplementationHash,
    ));
  }
  return null;
}

function computeArtifactCasAudit(source, roots, pathBaseRoots = roots) {
  const candidates = [];
  const explicitlyDeclared = new Set();
  for (const field of [
    'artifact_cas_locators',
    'artifactCasLocators',
    'artifact_cas_locator',
    'artifactCasLocator',
  ]) {
    if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
    const declared = Array.isArray(source[field]) ? source[field] : [source[field]];
    for (const locator of declared) {
      if (!isObject(locator)) {
        candidates.push({
          expectedRole: null,
          locator: null,
          readError: 'artifact_cas_declared_locator_malformed',
        });
        continue;
      }
      explicitlyDeclared.add(locator);
      candidates.push({
        expectedRole: computeArtifactLocatorRole(locator),
        locator,
        readError: null,
      });
    }
  }
  for (const declaration of COMPUTE_CAS_ROLE_DECLARATIONS) {
    for (const field of declaration.fields) {
      if (!Object.prototype.hasOwnProperty.call(source, field)) continue;
      const value = source[field];
      if (value === undefined || value === null) continue;
      if (isObject(value)) explicitlyDeclared.add(value);
      const loaded = readComputeArtifactLocatorManifest(
        value,
        declaration.role,
        roots,
        pathBaseRoots,
      );
      candidates.push({
        expectedRole: declaration.role,
        locator: loaded.manifest,
        readError: loaded.readError,
      });
    }
  }
  for (const locator of collectArtifactLocators(source)) {
    if (explicitlyDeclared.has(locator)) continue;
    candidates.push({
      expectedRole: computeArtifactLocatorRole(locator),
      locator,
      readError: null,
    });
  }

  const validations = candidates.map((candidate) => {
    if (candidate.readError || !candidate.locator || !candidate.expectedRole) {
      return {
        accepted: false,
        role: candidate.expectedRole,
        reasons: [candidate.readError ?? 'artifact_cas_compute_role_invalid'],
      };
    }
    return {
      ...computeArtifactLocatorValidation(
        candidate.locator,
        roots,
        computeArtifactExpectedHash(source, candidate.expectedRole),
        candidate.expectedRole,
      ),
      role: candidate.expectedRole,
    };
  });
  const hashesByRole = new Map();
  for (const validation of validations) {
    if (!validation.role || !validation.contentHash) continue;
    const hashes = hashesByRole.get(validation.role) ?? new Set();
    hashes.add(validation.contentHash);
    hashesByRole.set(validation.role, hashes);
  }
  for (const [role, hashes] of hashesByRole) {
    if (hashes.size <= 1) continue;
    validations.push({
      accepted: false,
      role,
      reasons: ['artifact_cas_conflicting_peer_content_hashes'],
    });
  }
  return validations;
}

function computeArtifactCasAuditFailures(source, roots, pathBaseRoots = roots) {
  return compactStrings(computeArtifactCasAudit(source, roots, pathBaseRoots)
    .filter((validation) => validation.accepted !== true)
    .flatMap((validation) => [
      'compute_oracle_artifact_cas_locator_invalid',
      validation.role
        ? `compute_oracle_${validation.role}_cas_locator_invalid`
        : 'compute_oracle_untyped_cas_locator_invalid',
    ]));
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
  return outputOracleTargetKind(outputOracleTarget(record)) === 'visual'
    || visualArtifactsPresent(record);
}

function outputOracleKindDeclarationFailures(proofLedger) {
  return compactStrings(ledgerRecords(proofLedger).map((record) => {
    const outputEvent = firstObject(record.output_event, record.outputEvent) ?? {};
    return normalizedText(outputEvent.kind, outputEvent.oracle_kind, outputEvent.oracleKind)
      ? null
      : 'output_oracle_kind_missing';
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

function computeOracleReadbackSchemaBytes(source, roots, expectedHash = null, pathBaseRoots = roots) {
  const schemaPath = firstString(source.readback_schema_json, source.readbackSchemaJson);
  const resolvedPath = resolveReadableComputeArtifactPath(schemaPath, roots, pathBaseRoots);
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
  const validations = computeReadbackSchemaLocators(source, roots, pathBaseRoots)
    .map((locator) => computeArtifactLocatorValidation(
      locator,
      roots,
      expectedHash,
      'readback_schema',
    ))
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

function computeOracleImplementationBytes(source, roots, pathBaseRoots, failures) {
  const directArtifact = strictOwnAliasedObject(
    source,
    [
      'oracle_implementation_artifact',
      'oracleImplementationArtifact',
      'semantic_oracle_implementation_artifact',
      'semanticOracleImplementationArtifact',
    ],
    failures,
    'compute_oracle_implementation_artifact',
  );
  const expectedHash = normalizeSha256(strictOwnAliasedString(
    source,
    [
      'oracle_code_hash',
      'oracleCodeHash',
      'semantic_oracle_implementation_hash',
      'semanticOracleImplementationHash',
    ],
    failures,
    'compute_oracle_implementation_declared_hash',
  ));
  let directBytes = null;
  let directPath = null;
  if (directArtifact) {
    const shapeFailure = plainDataTreeFailure(directArtifact);
    if (shapeFailure) {
      failures.push(`compute_oracle_implementation_artifact_${shapeFailure}`);
    }
    const schemaVersion = strictOwnAliasedString(
      directArtifact,
      ['schema_version', 'schemaVersion'],
      failures,
      'compute_oracle_implementation_artifact_schema',
    );
    if (schemaVersion !== 'synthi.gpu_hmr.oracle_implementation_artifact.v1') {
      failures.push('compute_oracle_implementation_artifact_schema_invalid');
    }
    const role = normalizedComputeArtifactRole(strictOwnAliasedString(
      directArtifact,
      ['role', 'artifact_role', 'artifactRole'],
      failures,
      'compute_oracle_implementation_artifact_role',
    ));
    if (role !== 'oracle_implementation') {
      failures.push('compute_oracle_implementation_artifact_role_invalid');
    }
    const artifactPath = strictOwnAliasedString(
      directArtifact,
      ['path', 'file_path', 'filePath'],
      failures,
      'compute_oracle_implementation_artifact_path',
    );
    const artifactHash = normalizeSha256(strictOwnAliasedString(
      directArtifact,
      ['hash', 'content_hash', 'contentHash'],
      failures,
      'compute_oracle_implementation_artifact_hash',
    ));
    const byteLength = positiveInteger(strictOwnAliasedValue(
      directArtifact,
      ['byte_length', 'byteLength'],
      failures,
      'compute_oracle_implementation_artifact_byte_length',
    ));
    directPath = resolveReadableComputeArtifactPath(artifactPath, roots, pathBaseRoots);
    if (!directPath) {
      failures.push('compute_oracle_implementation_artifact_path_unreadable');
    } else {
      try {
        directBytes = readFileSync(directPath);
      } catch {
        failures.push('compute_oracle_implementation_artifact_bytes_unreadable');
      }
    }
    if (!artifactHash) failures.push('compute_oracle_implementation_artifact_hash_invalid');
    if (byteLength === null) failures.push('compute_oracle_implementation_artifact_byte_length_invalid');
    if (Buffer.isBuffer(directBytes)) {
      const actualHash = sha256Bytes(directBytes);
      if (artifactHash && actualHash !== artifactHash) {
        failures.push('compute_oracle_implementation_artifact_hash_mismatch');
      }
      if (expectedHash && actualHash !== expectedHash) {
        failures.push('compute_oracle_implementation_oracle_code_hash_mismatch');
      }
      if (byteLength !== null && directBytes.length !== byteLength) {
        failures.push('compute_oracle_implementation_artifact_byte_length_mismatch');
      }
    }
  }

  const casValidations = computeOracleImplementationLocators(source, roots, pathBaseRoots)
    .map((locator) => computeArtifactLocatorValidation(
      locator,
      roots,
      expectedHash,
      'oracle_implementation',
    ))
    .filter(Boolean);
  const acceptedCas = casValidations.find((validation) =>
    validation.accepted === true && validation.localPath
  );
  let casBytes = null;
  if (acceptedCas) {
    try {
      casBytes = readFileSync(acceptedCas.localPath);
    } catch {
      failures.push('compute_oracle_implementation_cas_bytes_unreadable');
    }
  }
  if (!directArtifact && casValidations.length === 0) {
    failures.push('compute_oracle_implementation_byte_artifact_missing');
  }
  if (!directArtifact && casValidations.length > 0 && !acceptedCas) {
    failures.push('compute_oracle_implementation_cas_locator_invalid');
  }
  const bytes = directBytes ?? casBytes;
  if (!Buffer.isBuffer(bytes) || bytes.length === 0) {
    failures.push('compute_oracle_implementation_bytes_unreadable');
    return { bytes: null, hash: null, path: directPath ?? acceptedCas?.localPath ?? null };
  }
  const hash = sha256Bytes(bytes);
  if (expectedHash && hash !== expectedHash) {
    failures.push('compute_oracle_implementation_oracle_code_hash_mismatch');
  }
  return {
    bytes,
    hash,
    path: directPath ?? acceptedCas?.localPath ?? null,
    casValidations,
  };
}

function strictComputeOracleArtifactObjects(record, failures) {
  const oracleArtifacts = strictOwnAliasedObject(
    record,
    ['oracle_artifacts', 'oracleArtifacts'],
    failures,
    'compute_oracle_ledger_oracle_artifacts',
  );
  const outputEvent = strictOwnAliasedObject(
    record,
    ['output_event', 'outputEvent'],
    failures,
    'compute_oracle_ledger_output_event',
  ) ?? {};
  const outputArtifacts = strictOwnAliasedObject(
    outputEvent,
    ['oracle_artifacts', 'oracleArtifacts'],
    failures,
    'compute_oracle_output_event_oracle_artifacts',
  );
  const outputOracle = strictOwnAliasedObject(
    outputEvent,
    ['output_oracle', 'outputOracle'],
    failures,
    'compute_oracle_output_event_oracle',
  ) ?? {};
  const outputOracleArtifacts = strictOwnAliasedObject(
    outputOracle,
    ['oracle_artifacts', 'oracleArtifacts'],
    failures,
    'compute_oracle_output_oracle_artifacts',
  );
  return [
    [oracleArtifacts, 'compute_oracle_ledger_artifacts'],
    [outputArtifacts, 'compute_oracle_output_event_artifacts'],
    [outputEvent, 'compute_oracle_output_event'],
    [outputOracle, 'compute_oracle_output_oracle'],
    [outputOracleArtifacts, 'compute_oracle_nested_output_oracle_artifacts'],
  ].flatMap(([container, code]) => {
    if (!isObject(container)) return [];
    const artifacts = strictOwnAliasedObject(
      container,
      ['compute_oracle_artifacts', 'computeOracleArtifacts'],
      failures,
      code,
    );
    return artifacts ? [artifacts] : [];
  });
}

function computeExpectedOutputContractEvidence(
  rawAcceptanceContract,
  recomputedAcceptanceContract,
) {
  const failures = [];
  const rawContractShape = plainDataTreeFailure(rawAcceptanceContract);
  if (rawContractShape) failures.push(`compute_oracle_acceptance_contract_${rawContractShape}`);
  const rawFission = strictOwnAliasedObject(
    rawAcceptanceContract,
    ['fission_report', 'fissionReport'],
    failures,
    'compute_oracle_acceptance_fission_report',
  );
  const rawOutputOracle = strictOwnAliasedObject(
    rawFission,
    ['output_oracle_contract', 'outputOracleContract'],
    failures,
    'compute_oracle_acceptance_output_oracle_contract',
  );
  const rawExpected = strictOwnAliasedObject(
    rawOutputOracle,
    ['expected_output_contract', 'expectedOutputContract'],
    failures,
    'compute_oracle_expected_output_contract',
  );

  const recomputedFission = strictOwnAliasedObject(
    recomputedAcceptanceContract,
    ['fission_report', 'fissionReport'],
    failures,
    'compute_oracle_recomputed_fission_report',
  );
  const recomputedOutputOracle = strictOwnAliasedObject(
    recomputedFission,
    ['output_oracle_contract', 'outputOracleContract'],
    failures,
    'compute_oracle_recomputed_output_oracle_contract',
  );
  const recomputedExpected = strictOwnAliasedObject(
    recomputedOutputOracle,
    ['expected_output_contract', 'expectedOutputContract'],
    failures,
    'compute_oracle_recomputed_expected_output_contract',
  );
  if (!rawExpected || !recomputedExpected) {
    failures.push('compute_oracle_expected_output_contract_missing');
  } else if (!stableDataEqual(rawExpected, recomputedExpected)) {
    failures.push('compute_oracle_expected_output_contract_recompute_mismatch');
  }
  return {
    expectedOutputContract: recomputedExpected,
    outputOracleContract: recomputedOutputOracle,
    failures: compactStrings(failures),
  };
}

function ledgerOracleModalityEvidence(proofLedger) {
  const failures = [];
  const modalities = compactStrings(ledgerRecords(proofLedger).map((record) =>
    outputOracleTargetKind(outputOracleTarget(record))
  ));
  if (modalities.length === 0) failures.push('output_oracle_target_modality_missing');
  if (modalities.length > 1) failures.push('output_oracle_target_modality_mismatch');
  const modality = modalities.length === 1 ? modalities[0] : null;
  if (modality && modality !== 'compute' && modality !== 'visual') {
    failures.push('output_oracle_target_verifier_missing');
  }
  return {
    modality,
    failures: compactStrings(failures),
  };
}

function ledgerOracleModalityFailures(proofLedger, requiredModality) {
  if (!requiredModality) return ['output_oracle_target_modality_unverified'];
  const records = ledgerRecords(proofLedger);
  const hasComputeArtifacts = records.some(computeArtifactsPresent);
  const hasVisualArtifacts = records.some(visualArtifactsPresent);
  const failures = [];
  if (requiredModality === 'compute') {
    if (!hasComputeArtifacts) failures.push('compute_oracle_required_ledger_artifacts_missing');
    if (hasVisualArtifacts) failures.push('compute_oracle_contract_visual_artifacts_forbidden');
  } else if (requiredModality === 'visual') {
    if (!hasVisualArtifacts) failures.push('visual_oracle_required_ledger_artifacts_missing');
    if (hasComputeArtifacts) failures.push('visual_oracle_contract_compute_artifacts_forbidden');
  }
  return compactStrings(failures);
}

function declaredRuntimeIdentityValue({
  declaredValue,
  runtimeValues,
  failures,
  code,
}) {
  if (!declaredValue) failures.push(`${code}_declaration_missing`);
  const observed = compactStrings(runtimeValues);
  if (observed.length === 0) {
    failures.push(`${code}_runtime_observation_missing`);
    return null;
  }
  if (observed.length > 1) failures.push(`${code}_runtime_observation_mismatch`);
  if (declaredValue && observed[0] !== declaredValue) {
    failures.push(`${code}_declaration_runtime_mismatch`);
  }
  return observed[0];
}

function runtimeIdentityValue({ runtimeValues, failures, code }) {
  const observed = compactStrings(runtimeValues);
  if (observed.length === 0) {
    failures.push(`${code}_runtime_observation_missing`);
    return null;
  }
  if (observed.length > 1) failures.push(`${code}_runtime_observation_mismatch`);
  return observed[0];
}

function computeObservedSemanticBinding({
  record,
  artifacts,
  acceptanceContract,
  outputOracleContract,
  recomputedOracleCodeHash,
  failures,
}) {
  const outputEvent = strictOwnAliasedObject(
    record,
    ['output_event', 'outputEvent'],
    failures,
    'compute_oracle_semantic_output_event',
  ) ?? {};
  const dispatchEvent = strictOwnAliasedObject(
    record,
    ['dispatch_event', 'dispatchEvent'],
    failures,
    'compute_oracle_semantic_dispatch_event',
  ) ?? {};
  const outputOracle = strictOwnAliasedObject(
    outputEvent,
    ['output_oracle', 'outputOracle'],
    failures,
    'compute_oracle_semantic_output_oracle',
  ) ?? {};
  const outputTarget = strictOwnAliasedObject(
    record,
    ['output_oracle_target', 'outputOracleTarget'],
    failures,
    'compute_oracle_semantic_output_target',
  ) ?? {};
  const deviceIdentity = strictOwnAliasedObject(
    record,
    ['device_identity', 'deviceIdentity'],
    failures,
    'compute_oracle_semantic_device_identity',
  ) ?? {};

  const contractBackend = strictOwnAliasedString(
    acceptanceContract,
    ['backend'],
    failures,
    'compute_oracle_contract_backend',
  );
  const contractProjectId = strictOwnAliasedString(
    acceptanceContract,
    ['project_id', 'projectId'],
    failures,
    'compute_oracle_contract_project_id',
  );
  const contractEditId = strictOwnAliasedString(
    acceptanceContract,
    ['edit_id', 'editId'],
    failures,
    'compute_oracle_contract_edit_id',
  );
  const contractArtifactAfterHash = strictOwnAliasedString(
    acceptanceContract,
    ['artifact_hash_after', 'artifactHashAfter'],
    failures,
    'compute_oracle_contract_artifact_after_hash',
  );
  const ledgerBackend = strictOwnAliasedString(
    record,
    ['backend'],
    failures,
    'compute_oracle_ledger_backend',
  );
  const deviceBackend = strictOwnAliasedString(
    deviceIdentity,
    ['backend'],
    failures,
    'compute_oracle_device_identity_backend',
  );
  const ledgerProjectId = strictOwnAliasedString(
    record,
    ['project_id', 'projectId'],
    failures,
    'compute_oracle_ledger_project_id',
  );
  const ledgerEditId = strictOwnAliasedString(
    record,
    ['edit_id', 'editId'],
    failures,
    'compute_oracle_ledger_edit_id',
  );
  const ledgerArtifactAfterHash = strictOwnAliasedString(
    record,
    ['artifact_after_hash', 'artifactAfterHash'],
    failures,
    'compute_oracle_ledger_artifact_after_hash',
  );
  if (!deviceBackend) {
    failures.push('compute_oracle_semantic_backend_device_identity_missing');
  }
  const backend = declaredRuntimeIdentityValue({
    declaredValue: contractBackend,
    runtimeValues: [ledgerBackend, deviceBackend],
    failures,
    code: 'compute_oracle_semantic_backend',
  });
  const projectId = declaredRuntimeIdentityValue({
    declaredValue: contractProjectId,
    runtimeValues: [ledgerProjectId],
    failures,
    code: 'compute_oracle_semantic_project_id',
  });
  const editId = declaredRuntimeIdentityValue({
    declaredValue: contractEditId,
    runtimeValues: [ledgerEditId],
    failures,
    code: 'compute_oracle_semantic_edit_id',
  });
  const artifactAfterHash = declaredRuntimeIdentityValue({
    declaredValue: contractArtifactAfterHash,
    runtimeValues: [ledgerArtifactAfterHash],
    failures,
    code: 'compute_oracle_semantic_artifact_after_hash',
  });
  const outputEventTargetId = strictOwnAliasedString(
    outputEvent,
    ['output_target_id', 'outputTargetId'],
    failures,
    'compute_oracle_output_event_target_id',
  );
  const declaredOutputTargetId = strictOwnAliasedString(
    outputOracleContract,
    ['target_id', 'targetId', 'output_target_id', 'outputTargetId'],
    failures,
    'compute_oracle_contract_output_target_id',
  );
  if (!outputEventTargetId) {
    failures.push('compute_oracle_semantic_output_target_id_output_event_missing');
  }
  const outputTargetId = declaredRuntimeIdentityValue({
    declaredValue: declaredOutputTargetId,
    runtimeValues: [
      outputEventTargetId,
      strictOwnAliasedString(
        dispatchEvent,
        ['output_target_id', 'outputTargetId'],
      failures,
      'compute_oracle_dispatch_event_target_id',
    ),
    strictOwnAliasedString(
      outputOracle,
      ['output_target_id', 'outputTargetId', 'target_id', 'targetId'],
      failures,
      'compute_oracle_output_oracle_target_id',
    ),
    strictOwnAliasedString(
      outputTarget,
      ['target_id', 'targetId', 'output_target_id', 'outputTargetId'],
      failures,
      'compute_oracle_ledger_output_target_id',
    ),
    ],
    failures,
    code: 'compute_oracle_semantic_output_target_id',
  });
  const outputEventOracleCodeHash = strictOwnAliasedString(
    outputEvent,
    ['oracle_code_hash', 'oracleCodeHash'],
    failures,
    'compute_oracle_output_event_oracle_code_hash',
  );
  if (!outputEventOracleCodeHash) {
    failures.push('compute_oracle_semantic_oracle_code_hash_output_event_missing');
  }
  const declaredOracleCodeHash = runtimeIdentityValue({
    runtimeValues: [
      outputEventOracleCodeHash,
      strictOwnAliasedString(
        outputOracle,
        ['oracle_code_hash', 'oracleCodeHash'],
      failures,
      'compute_oracle_output_oracle_code_hash',
    ),
    strictOwnAliasedString(
      artifacts,
      ['oracle_code_hash', 'oracleCodeHash'],
      failures,
      'compute_oracle_artifacts_oracle_code_hash',
    ),
    ],
    failures,
    code: 'compute_oracle_semantic_oracle_code_hash',
  });
  if (!recomputedOracleCodeHash) {
    failures.push('compute_oracle_semantic_oracle_code_hash_bytes_unverified');
  } else if (
    !normalizeSha256(declaredOracleCodeHash)
    || normalizeSha256(declaredOracleCodeHash) !== recomputedOracleCodeHash
  ) {
    failures.push('compute_oracle_semantic_oracle_code_hash_byte_binding_mismatch');
  }
  return {
    backend,
    projectId,
    editId,
    artifactAfterHash,
    outputTargetId,
    oracleCodeHash: recomputedOracleCodeHash,
  };
}

function computeSemanticSliceFailures(artifacts, rawBytes, schemaBytes) {
  const failures = [];
  const slice = strictOwnAliasedObject(
    artifacts,
    ['deterministic_slice', 'deterministicSlice'],
    failures,
    'compute_oracle_semantic_deterministic_slice',
  );
  if (!slice || !Buffer.isBuffer(rawBytes)) {
    if (!slice) failures.push('compute_oracle_semantic_deterministic_slice_missing');
    return compactStrings(failures);
  }
  const offset = zeroOrPositiveInteger(strictOwnAliasedValue(
    slice,
    ['offset', 'byte_offset', 'byteOffset'],
    failures,
    'compute_oracle_semantic_deterministic_slice_offset',
  ));
  const length = positiveInteger(strictOwnAliasedValue(
    slice,
    ['length', 'byte_length', 'byteLength'],
    failures,
    'compute_oracle_semantic_deterministic_slice_length',
  ));
  const declaredHash = normalizeSha256(strictOwnAliasedString(
    slice,
    ['hash', 'sha256', 'slice_hash', 'sliceHash'],
    failures,
    'compute_oracle_semantic_deterministic_slice_hash',
  ));
  if (offset === null || length === null || offset + length > rawBytes.length) {
    failures.push('compute_oracle_semantic_deterministic_slice_bounds_invalid');
    return compactStrings(failures);
  }
  const actualHash = sha256Bytes(rawBytes.subarray(offset, offset + length));
  if (!declaredHash || declaredHash !== actualHash) {
    failures.push('compute_oracle_semantic_deterministic_slice_hash_mismatch');
  }
  if (Buffer.isBuffer(schemaBytes)) {
    try {
      const schema = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(schemaBytes));
      const schemaSlice = strictOwnAliasedObject(
        schema,
        ['deterministic_slice', 'deterministicSlice'],
        failures,
        'compute_oracle_readback_schema_deterministic_slice',
      );
      if (schemaSlice) {
        const schemaOffset = zeroOrPositiveInteger(strictOwnAliasedValue(
          schemaSlice,
          ['offset', 'byte_offset', 'byteOffset'],
          failures,
          'compute_oracle_readback_schema_deterministic_slice_offset',
        ));
        const schemaLength = positiveInteger(strictOwnAliasedValue(
          schemaSlice,
          ['length', 'byte_length', 'byteLength'],
          failures,
          'compute_oracle_readback_schema_deterministic_slice_length',
        ));
        const schemaHash = normalizeSha256(strictOwnAliasedString(
          schemaSlice,
          ['hash', 'sha256', 'slice_hash', 'sliceHash'],
          failures,
          'compute_oracle_readback_schema_deterministic_slice_hash',
        ));
        if (schemaOffset !== offset || schemaLength !== length || schemaHash !== declaredHash) {
          failures.push('compute_oracle_deterministic_slice_schema_mismatch');
        }
      }
    } catch {
      failures.push('compute_oracle_readback_schema_invalid_json');
    }
  }
  return compactStrings(failures);
}

function computeOracleSemanticFailures({
  proofLedger,
  rawAcceptanceContract,
  recomputedAcceptance,
  requiredModality,
  options,
}) {
  const records = ledgerRecords(proofLedger).filter(computeArtifactsPresent);
  if (records.length === 0) {
    return requiredModality === 'compute'
      ? ['compute_oracle_required_ledger_artifacts_missing']
      : [];
  }
  const failures = [];
  if (records.some(recordClaimsVisualOutput)) {
    failures.push('compute_oracle_mixed_visual_compute_modality_ambiguous');
  }
  if (!recomputedAcceptance || recomputedAcceptance.accepted !== true) {
    failures.push('compute_oracle_acceptance_contract_not_verified');
  }
  const contractEvidence = computeExpectedOutputContractEvidence(
    rawAcceptanceContract,
    recomputedAcceptance?.contract,
  );
  failures.push(...contractEvidence.failures);
  const roots = computeArtifactRoots(options);
  const pathBaseRoots = computeArtifactPathBaseRoots(options);
  for (const record of records) {
    const artifactsList = strictComputeOracleArtifactObjects(record, failures);
    if (artifactsList.length === 0) {
      failures.push('compute_oracle_artifacts_missing');
      continue;
    }
    for (const artifacts of artifactsList) {
      const artifactShapeFailure = plainDataTreeFailure(artifacts);
      if (artifactShapeFailure) {
        failures.push(`compute_oracle_artifacts_${artifactShapeFailure}`);
        continue;
      }
      failures.push(...computeArtifactCasAuditFailures(artifacts, roots, pathBaseRoots));
      const declaredRawHash = normalizeSha256(strictOwnAliasedString(
        artifacts,
        ['raw_readback_hash', 'rawReadbackHash', 'readback_hash', 'readbackHash'],
        failures,
        'compute_oracle_semantic_raw_readback_hash',
      ));
      const rawPath = strictOwnAliasedString(
        artifacts,
        ['raw_readback_bin', 'rawReadbackBin'],
        failures,
        'compute_oracle_semantic_raw_readback_path',
      );
      const schemaPath = strictOwnAliasedString(
        artifacts,
        ['readback_schema_json', 'readbackSchemaJson'],
        failures,
        'compute_oracle_semantic_readback_schema_path',
      );
      if (!rawPath && computeRawReadbackLocators(artifacts, roots, pathBaseRoots).length === 0) {
        failures.push('compute_oracle_semantic_raw_readback_artifact_missing');
      }
      if (!schemaPath && computeReadbackSchemaLocators(artifacts, roots, pathBaseRoots).length === 0) {
        failures.push('compute_oracle_semantic_readback_schema_artifact_missing');
      }
      const declaredSchemaHash = normalizeSha256(strictOwnAliasedString(
        artifacts,
        ['readback_schema_hash', 'readbackSchemaHash'],
        failures,
        'compute_oracle_semantic_readback_schema_hash',
      ));
      if (!declaredSchemaHash) {
        failures.push('compute_oracle_semantic_readback_schema_hash_missing');
      }
      const rawEvidence = computeOracleRawReadbackBytes(
        artifacts,
        roots,
        declaredRawHash,
        pathBaseRoots,
      );
      const schemaEvidence = computeOracleReadbackSchemaBytes(
        artifacts,
        roots,
        declaredSchemaHash,
        pathBaseRoots,
      );
      const rawCasValidations = [
        ...(rawEvidence?.casValidation ? [rawEvidence.casValidation] : []),
        ...(Array.isArray(rawEvidence?.casValidations) ? rawEvidence.casValidations : []),
      ];
      const schemaCasValidations = [
        ...(schemaEvidence?.casValidation ? [schemaEvidence.casValidation] : []),
        ...(Array.isArray(schemaEvidence?.casValidations) ? schemaEvidence.casValidations : []),
      ];
      if (rawCasValidations.some((validation) => validation.accepted !== true)) {
        failures.push('compute_oracle_semantic_raw_readback_cas_locator_invalid');
      }
      if (schemaCasValidations.some((validation) => validation.accepted !== true)) {
        failures.push('compute_oracle_semantic_readback_schema_cas_locator_invalid');
      }
      const rawBytes = rawEvidence?.bytes;
      const schemaBytes = schemaEvidence?.bytes;
      if (!Buffer.isBuffer(rawBytes) || rawBytes.length === 0) {
        failures.push('compute_oracle_semantic_raw_readback_bytes_unreadable');
        continue;
      }
      if (!Buffer.isBuffer(schemaBytes) || schemaBytes.length === 0) {
        failures.push('compute_oracle_semantic_readback_schema_bytes_unreadable');
        continue;
      }
      if (declaredRawHash && sha256Bytes(rawBytes) !== declaredRawHash) {
        failures.push('compute_oracle_semantic_raw_readback_hash_mismatch');
      }
      if (declaredSchemaHash && sha256Bytes(schemaBytes) !== declaredSchemaHash) {
        failures.push('compute_oracle_semantic_readback_schema_hash_mismatch');
      }
      failures.push(...computeSemanticSliceFailures(artifacts, rawBytes, schemaBytes));
      const oracleImplementation = computeOracleImplementationBytes(
        artifacts,
        roots,
        pathBaseRoots,
        failures,
      );
      const observedBinding = computeObservedSemanticBinding({
        record,
        artifacts,
        acceptanceContract: recomputedAcceptance?.contract ?? {},
        outputOracleContract: contractEvidence.outputOracleContract ?? {},
        recomputedOracleCodeHash: oracleImplementation.hash,
        failures,
      });
      const verification = verifyComputeOracleSemantics({
        rawBytes,
        readbackSchema: schemaBytes,
        expectedOutputContract: contractEvidence.expectedOutputContract,
        observedBinding: {
          projectId: observedBinding.projectId,
          editId: observedBinding.editId,
          artifactAfterHash: observedBinding.artifactAfterHash,
          outputTargetId: observedBinding.outputTargetId,
          oracleCodeHash: observedBinding.oracleCodeHash,
        },
      });
      if (verification.accepted !== true) {
        failures.push('compute_oracle_semantic_verification_rejected');
        failures.push(...(verification.failedGates ?? verification.failed_gates ?? [])
          .map((failure) => failure?.code ?? failure));
      }
    }
  }
  return compactStrings(failures);
}

function computeOracleDeclarationFailures(proofLedger, options = {}) {
  const records = ledgerRecords(proofLedger).filter(computeArtifactsPresent);
  if (records.length === 0) return [];
  const roots = computeArtifactRoots(options);
  const pathBaseRoots = computeArtifactPathBaseRoots(options);
  const failures = [];
  if (records.some(recordClaimsVisualOutput)) {
    failures.push('compute_oracle_mixed_visual_compute_modality_ambiguous');
  }
  const addFailure = (code) => {
    if (code) failures.push(code);
  };
  for (const artifacts of records.flatMap(computeOracleArtifactObjects)) {
    const artifactShapeFailure = plainDataTreeFailure(artifacts);
    if (artifactShapeFailure) {
      addFailure(`compute_oracle_artifacts_${artifactShapeFailure}`);
      continue;
    }
    failures.push(...computeArtifactCasAuditFailures(artifacts, roots, pathBaseRoots));
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
  const kind = firstObject(target?.kind);
  return normalizedText(kind?.value, target?.kind, target?.target_kind, target?.targetKind);
}

function recordRequiresDeterministicVisualMode(record) {
  return outputOracleTargetKind(outputOracleTarget(record)) === 'visual'
    || visualArtifactsPresent(record);
}

function ledgerRequiresDeterministicVisualMode(ledger) {
  return ledgerRecords(ledger).some(recordRequiresDeterministicVisualMode);
}

function proofLedgerSourceConsistencyMode(sourceConsistency) {
  return normalizedText(sourceConsistency?.mode);
}

function adversarialPreflightStrictGateValidated(preflight, options) {
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

function adversarialPreflightBoundaryFailure(code) {
  return gateRow(
    'strict adversarial preflight acceptance',
    [code],
    'adversarial preflight boundary input accepted',
  );
}

export function adversarialPreflightStrictGate(preflight, options = {}) {
  try {
    const preflightFailure = plainDataTreeFailure(preflight);
    if (preflightFailure) {
      return adversarialPreflightBoundaryFailure(
        `adversarial_preflight_plain_data_${preflightFailure}`,
      );
    }
    const optionsFailure = plainDataTreeFailure(options);
    if (optionsFailure) {
      return adversarialPreflightBoundaryFailure(
        `adversarial_preflight_options_plain_data_${optionsFailure}`,
      );
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      return adversarialPreflightBoundaryFailure('adversarial_preflight_options_not_object');
    }
    return adversarialPreflightStrictGateValidated(preflight, options);
  } catch {
    return adversarialPreflightBoundaryFailure('adversarial_preflight_boundary_exception');
  }
}

function runtimeProofArtifactStrictGateValidated(record, options) {
  const artifact = proofArtifactFromRecord(record);
  const failures = [];
  if (!artifact) {
    failures.push('runtime_proof_artifact_missing');
  } else {
    const proofLedgerQuery = firstOwnObject(
      artifact,
      'proofLedgerQuery',
      'proof_ledger_query',
    );
    const proofLedger = firstOwnObject(
      artifact,
      'proofLedger',
      'proof_ledger',
    );
    const proofLedgerAliasMismatch = topLevelObjectAliasMismatch(
      artifact,
      'proofLedger',
      'proof_ledger',
    );
    const acceptanceContract = firstOwnObject(
      artifact,
      'acceptanceContract',
      'acceptance_contract',
    );
    const acceptanceContractAliasMismatch = topLevelObjectAliasMismatch(
      artifact,
      'acceptanceContract',
      'acceptance_contract',
    );
    const acceptanceContractShapeFailure = acceptanceContract
      ? plainDataTreeFailure(acceptanceContract)
      : null;
    const acceptanceContractEvaluation = firstOwnObject(
      artifact,
      'acceptanceContractEvaluation',
      'acceptance_contract_evaluation',
    );
    const acceptanceContractConsistencyCamel = isObject(
      ownValue(artifact, 'acceptanceContractConsistency'),
    )
      ? ownValue(artifact, 'acceptanceContractConsistency')
      : null;
    const acceptanceContractConsistencySnake = isObject(
      ownValue(artifact, 'acceptance_contract_consistency'),
    )
      ? ownValue(artifact, 'acceptance_contract_consistency')
      : null;
    const acceptanceContractConsistency = firstObject(
      acceptanceContractConsistencyCamel,
      acceptanceContractConsistencySnake,
    );
    const acceptanceContractConsistencyAliasMismatch =
      acceptanceContractConsistencyCamel
      && acceptanceContractConsistencySnake
      && !stableDataEqual(
        acceptanceContractConsistencyCamel,
        acceptanceContractConsistencySnake,
      );
    const proofLedgerSourceConsistency = firstOwnObject(
      artifact,
      'proofLedgerSourceConsistency',
      'proof_ledger_source_consistency',
    );
    const deterministicVisualModeEvaluation = firstOwnObject(
      artifact,
      'deterministicVisualModeEvaluation',
      'deterministic_visual_mode_evaluation',
    );
    const stageResults = firstOwnArray(
      artifact,
      'stageResults',
      'stage_results',
    );
    const limitations = firstOwnArray(artifact, 'limitations');
    const gpuHmrSuccess = ownValue(artifact, 'gpuHmrSuccess') === true
      || ownValue(artifact, 'gpu_hmr_success') === true;
    const visualLedgerRequiresDeterministicMode =
      proofLedger && ledgerRequiresDeterministicVisualMode(proofLedger);
    let recomputedProofLedgerQuery = null;
    let recomputedAcceptanceContractHash = null;
    let recomputedAcceptance = null;
    let requiredOracleModality = null;
    let visualOverlayUsed = false;
    failures.push(...hipModuleHardwareTargetFailures({
      artifact,
      acceptanceContract,
      proofLedger,
    }));

    if (
      ownValue(artifact, 'fullRuntimeProven') !== true
      && ownValue(artifact, 'full_runtime_proven') !== true
    ) {
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
      const modalityEvidence = ledgerOracleModalityEvidence(proofLedger);
      requiredOracleModality = modalityEvidence.modality;
      failures.push(...modalityEvidence.failures);
    }
    if (proofLedgerAliasMismatch) {
      failures.push('proof_ledger_alias_mismatch');
    }
    if (!proofLedgerQuery) {
      failures.push('proof_ledger_query_missing');
    } else if (proofLedgerQuery.gpuHmrSuccess !== true) {
      failures.push('proof_ledger_query_rejected');
    }
    if (!acceptanceContract) {
      failures.push('acceptance_contract_missing');
    } else if (acceptanceContractShapeFailure) {
      failures.push(`acceptance_contract_${acceptanceContractShapeFailure}`);
    } else {
      recomputedAcceptance = evaluateGpuHmrAcceptanceContract(acceptanceContract);
      recomputedAcceptanceContractHash = recomputedAcceptance.recomputedContractHash;
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
    if (acceptanceContractAliasMismatch) {
      failures.push('acceptance_contract_alias_mismatch');
    }
    failures.push(...acceptanceContractLedgerBindingFailures(
      proofLedger,
      recomputedAcceptanceContractHash,
    ));
    if (proofLedger) {
      failures.push(...ledgerOracleModalityFailures(proofLedger, requiredOracleModality));
      failures.push(...computeOracleSemanticFailures({
        proofLedger,
        rawAcceptanceContract: acceptanceContract,
        recomputedAcceptance,
        requiredModality: requiredOracleModality,
        options,
      }));
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

function runtimeProofArtifactBoundaryFailure(code) {
  return gateRow(
    'strict runtime proof artifact acceptance',
    [code],
    'runtime proof artifact boundary input accepted',
  );
}

export function runtimeProofArtifactStrictGate(record, options = {}) {
  try {
    const recordFailure = plainDataTreeFailure(record);
    if (recordFailure) {
      return runtimeProofArtifactBoundaryFailure(
        `runtime_proof_artifact_plain_data_${recordFailure}`,
      );
    }
    const optionsFailure = plainDataTreeFailure(options);
    if (optionsFailure) {
      return runtimeProofArtifactBoundaryFailure(
        `runtime_proof_artifact_options_plain_data_${optionsFailure}`,
      );
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      return runtimeProofArtifactBoundaryFailure('runtime_proof_artifact_options_not_object');
    }
    return runtimeProofArtifactStrictGateValidated(record, options);
  } catch {
    return runtimeProofArtifactBoundaryFailure('runtime_proof_artifact_boundary_exception');
  }
}

function runtimeProofArtifactStrictGatesValidated(records, options) {
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

function runtimeProofArtifactStrictGatesBoundaryFailure(code) {
  return [gateRow(
    'strict runtime proof artifact acceptance',
    [code],
    'runtime proof artifacts boundary input accepted',
  )];
}

export function runtimeProofArtifactStrictGates(records, options = {}) {
  try {
    const recordsFailure = plainDataTreeFailure(records);
    if (recordsFailure) {
      return runtimeProofArtifactStrictGatesBoundaryFailure(
        `runtime_proof_artifacts_plain_data_${recordsFailure}`,
      );
    }
    const optionsFailure = plainDataTreeFailure(options);
    if (optionsFailure) {
      return runtimeProofArtifactStrictGatesBoundaryFailure(
        `runtime_proof_artifacts_options_plain_data_${optionsFailure}`,
      );
    }
    if (options === null || typeof options !== 'object' || Array.isArray(options)) {
      return runtimeProofArtifactStrictGatesBoundaryFailure(
        'runtime_proof_artifacts_options_not_object',
      );
    }
    return runtimeProofArtifactStrictGatesValidated(records, options);
  } catch {
    return runtimeProofArtifactStrictGatesBoundaryFailure(
      'runtime_proof_artifacts_boundary_exception',
    );
  }
}

function strictProofGateFailuresValidated(rows) {
  return (Array.isArray(rows) ? rows : []).filter((row) => row?.status === 'fail');
}

function strictProofGateFailuresBoundaryFailure(code) {
  return [gateRow(
    'strict proof gate failure filtering',
    [code],
    'strict proof gate rows boundary input accepted',
  )];
}

export function strictProofGateFailures(rows) {
  try {
    const rowsFailure = plainDataTreeFailure(rows);
    if (rowsFailure) {
      return strictProofGateFailuresBoundaryFailure(
        `strict_proof_gate_rows_plain_data_${rowsFailure}`,
      );
    }
    return strictProofGateFailuresValidated(rows);
  } catch {
    return strictProofGateFailuresBoundaryFailure('strict_proof_gate_rows_boundary_exception');
  }
}
