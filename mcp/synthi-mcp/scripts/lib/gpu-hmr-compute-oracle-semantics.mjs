import { createHash } from 'node:crypto';

export const COMPUTE_EXPECTED_OUTPUT_CONTRACT_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_expected_output_contract.v1';
export const COMPUTE_ORACLE_SEMANTIC_VERIFICATION_SCHEMA_VERSION =
  'synthi.gpu.hmr.compute_oracle_semantic_verification.v1';
export const COMPUTE_ORACLE_SEMANTIC_VERIFICATION_AUTHORITY =
  'consumer_recomputed_compute_oracle_semantics_not_gpu_hmr_success';

const SHA256_RE = /^sha256:[0-9a-f]{64}$/;
const ARTIFACT_SHA256_RE = /^artifact:sha256:[0-9a-f]{64}$/;
const MAX_SCHEMA_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 32;
const MAX_JSON_ENTRIES = 32768;
const MAX_STRING_BYTES = 64 * 1024;
const MAX_EXPECTED_VALUES = 262144;

const DTYPE_ALIASES = new Map([
  ['bool', 'bool'],
  ['boolean', 'bool'],
  ['i8', 'i8'],
  ['int8', 'i8'],
  ['u8', 'u8'],
  ['uint8', 'u8'],
  ['uchar', 'u8'],
  ['byte', 'u8'],
  ['bf16', 'bf16'],
  ['bfloat16', 'bf16'],
  ['f16', 'f16'],
  ['float16', 'f16'],
  ['half', 'f16'],
  ['i16', 'i16'],
  ['int16', 'i16'],
  ['u16', 'u16'],
  ['uint16', 'u16'],
  ['f32', 'f32'],
  ['float', 'f32'],
  ['float32', 'f32'],
  ['i32', 'i32'],
  ['int', 'i32'],
  ['int32', 'i32'],
  ['u32', 'u32'],
  ['uint', 'u32'],
  ['uint32', 'u32'],
  ['complex64', 'complex64'],
  ['c64', 'complex64'],
  ['f64', 'f64'],
  ['double', 'f64'],
  ['float64', 'f64'],
  ['i64', 'i64'],
  ['int64', 'i64'],
  ['u64', 'u64'],
  ['uint64', 'u64'],
  ['complex128', 'complex128'],
  ['c128', 'complex128'],
]);

const DTYPE_WIDTHS = new Map([
  ['bool', 1],
  ['i8', 1],
  ['u8', 1],
  ['bf16', 2],
  ['f16', 2],
  ['i16', 2],
  ['u16', 2],
  ['f32', 4],
  ['i32', 4],
  ['u32', 4],
  ['complex64', 8],
  ['f64', 8],
  ['i64', 8],
  ['u64', 8],
  ['complex128', 16],
]);

const READBACK_SCHEMA_VERSIONS = new Set([
  'synthi.gpu.hmr.compute_readback_schema.v1',
  'synthi.gpu_hmr.compute_readback_schema.v1',
  'synthi.gpu.hmr.compute_readback_schema.v2',
]);

const CONTRACT_FIELDS = new Set([
  'schemaVersion',
  'schema_version',
  'comparisonMode',
  'comparison_mode',
  'dtype',
  'dataType',
  'data_type',
  'shape',
  'elementCount',
  'element_count',
  'byteOrder',
  'byte_order',
  'tolerance',
  'expectedValues',
  'expected_values',
  'expectedValuesHash',
  'expected_values_hash',
  'expectedRawHash',
  'expected_raw_hash',
  'binding',
  'evidenceRefs',
  'evidence_refs',
  'contractHash',
  'contract_hash',
]);

const BINDING_FIELDS = Object.freeze([
  ['projectId', 'project_id'],
  ['editId', 'edit_id'],
  ['artifactAfterHash', 'artifact_after_hash'],
  ['outputTargetId', 'output_target_id'],
  ['oracleCodeHash', 'oracle_code_hash'],
]);
const BINDING_FIELD_NAMES = new Set(BINDING_FIELDS.flat());

function plainObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function stableJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableJson(value[key])}`
  )).join(',')}}`;
}

function sha256(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function hashObject(value) {
  return sha256(Buffer.from(stableJson(value), 'utf8'));
}

function uniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean))];
}

function pushFailure(failures, code, details = {}) {
  if (!failures.some((failure) => failure.code === code)) failures.push({ code, ...details });
}

function aliasedValue(source, keys, failures, code) {
  const present = keys
    .filter((key) => Object.prototype.hasOwnProperty.call(source, key) && source[key] !== undefined)
    .map((key) => ({ key, value: source[key] }));
  if (present.length > 1) {
    const first = stableJson(present[0].value);
    if (present.some((entry) => stableJson(entry.value) !== first)) {
      pushFailure(failures, `${code}_alias_conflict`, { aliases: present.map((entry) => entry.key) });
    }
  }
  return present[0]?.value;
}

function textValue(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function inspectJsonBounds(value) {
  const stack = [{ value, depth: 0 }];
  const seen = new Set();
  let entries = 0;
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > MAX_JSON_DEPTH) return 'json_depth_limit_exceeded';
    if (
      typeof current.value === 'string'
      && Buffer.byteLength(current.value, 'utf8') > MAX_STRING_BYTES
    ) {
      return 'json_string_limit_exceeded';
    }
    if (!current.value || typeof current.value !== 'object') continue;
    if (seen.has(current.value)) return 'json_cycle_detected';
    seen.add(current.value);
    const children = Array.isArray(current.value)
      ? current.value
      : Object.values(current.value);
    entries += children.length;
    if (entries > MAX_JSON_ENTRIES) return 'json_entry_limit_exceeded';
    for (const child of children) stack.push({ value: child, depth: current.depth + 1 });
  }
  return null;
}

function parseReadbackSchema(input, failures) {
  if (Buffer.isBuffer(input) || input instanceof Uint8Array) {
    const bytes = Buffer.from(input);
    if (bytes.length === 0) {
      pushFailure(failures, 'compute_oracle_readback_schema_empty');
      return null;
    }
    if (bytes.length > MAX_SCHEMA_BYTES) {
      pushFailure(failures, 'compute_oracle_readback_schema_size_limit_exceeded');
      return null;
    }
    try {
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      input = JSON.parse(decoded);
    } catch {
      pushFailure(failures, 'compute_oracle_readback_schema_invalid_json');
      return null;
    }
  }
  const schema = plainObject(input);
  if (!schema) {
    pushFailure(failures, 'compute_oracle_readback_schema_invalid');
    return null;
  }
  const boundFailure = inspectJsonBounds(schema);
  if (boundFailure) {
    pushFailure(failures, `compute_oracle_readback_schema_${boundFailure}`);
    return null;
  }
  return schema;
}

function normalizeDtype(value) {
  const source = plainObject(value);
  const raw = textValue(source?.name ?? value)?.toLowerCase();
  return raw ? DTYPE_ALIASES.get(raw) ?? null : null;
}

function normalizeShape(value, failures, prefix) {
  if (!Array.isArray(value) || value.length === 0) {
    pushFailure(failures, `${prefix}_shape_invalid`);
    return null;
  }
  let product = 1;
  for (const dimension of value) {
    if (!Number.isSafeInteger(dimension) || dimension <= 0) {
      pushFailure(failures, `${prefix}_shape_invalid`);
      return null;
    }
    product *= dimension;
    if (!Number.isSafeInteger(product)) {
      pushFailure(failures, `${prefix}_shape_product_overflow`);
      return null;
    }
  }
  return { shape: [...value], elementCount: product };
}

function integerValue(value) {
  return Number.isSafeInteger(value) && value > 0 ? value : null;
}

function normalizeByteOrder(value, dtype) {
  const width = DTYPE_WIDTHS.get(dtype);
  const raw = textValue(value)?.toLowerCase();
  if (width === 1) return raw && raw !== 'not_applicable' ? null : 'not_applicable';
  if (!raw) return 'little_endian';
  if (['little_endian', 'little', 'le'].includes(raw)) return 'little_endian';
  if (['big_endian', 'big', 'be'].includes(raw)) return 'big_endian';
  return null;
}

function normalizeBinding(source, failures, prefix) {
  const binding = plainObject(source);
  if (!binding) {
    pushFailure(failures, `${prefix}_missing`);
    return null;
  }
  for (const key of Object.keys(binding)) {
    if (!BINDING_FIELD_NAMES.has(key)) pushFailure(failures, `${prefix}_unknown_field`, { field: key });
  }
  const normalized = {};
  for (const [camel, snake] of BINDING_FIELDS) {
    const value = textValue(aliasedValue(binding, [camel, snake], failures, `${prefix}_${snake}`));
    if (!value) pushFailure(failures, `${prefix}_${snake}_missing`);
    normalized[camel] = value;
  }
  if (
    normalized.artifactAfterHash
    && !SHA256_RE.test(normalized.artifactAfterHash)
    && !ARTIFACT_SHA256_RE.test(normalized.artifactAfterHash)
  ) {
    pushFailure(failures, `${prefix}_artifact_after_hash_invalid`);
  }
  if (normalized.oracleCodeHash && !SHA256_RE.test(normalized.oracleCodeHash)) {
    pushFailure(failures, `${prefix}_oracle_code_hash_invalid`);
  }
  return normalized;
}

function normalizeExpectedValues(values, dtype, elementCount, failures) {
  if (!Array.isArray(values)) {
    pushFailure(failures, 'compute_oracle_expected_values_missing');
    return null;
  }
  if (values.length > MAX_EXPECTED_VALUES) {
    pushFailure(failures, 'compute_oracle_expected_values_limit_exceeded');
    return null;
  }
  if (values.length !== elementCount) {
    pushFailure(failures, 'compute_oracle_expected_value_count_mismatch', {
      expected: elementCount,
      actual: values.length,
    });
    return null;
  }
  const normalized = [];
  for (const value of values) {
    if (dtype === 'bool') {
      if (typeof value !== 'boolean') {
        pushFailure(failures, 'compute_oracle_expected_value_invalid');
        return null;
      }
      normalized.push(value);
    } else if (dtype === 'i64' || dtype === 'u64') {
      try {
        const bigint = BigInt(value);
        if (dtype === 'u64' && bigint < 0n) throw new Error('negative unsigned value');
        normalized.push(bigint.toString());
      } catch {
        pushFailure(failures, 'compute_oracle_expected_value_invalid');
        return null;
      }
    } else if (dtype === 'complex64' || dtype === 'complex128') {
      const components = Array.isArray(value)
        ? value
        : plainObject(value)
          ? [value.real, value.imag]
          : null;
      if (!components || components.length !== 2 || components.some((entry) => !Number.isFinite(entry))) {
        pushFailure(failures, 'compute_oracle_expected_value_invalid');
        return null;
      }
      normalized.push([Number(components[0]), Number(components[1])]);
    } else {
      if (!Number.isFinite(value)) {
        pushFailure(failures, 'compute_oracle_expected_value_invalid');
        return null;
      }
      normalized.push(Number(value));
    }
  }
  return normalized;
}

function expectedContractMaterial(contract) {
  return {
    schemaVersion: COMPUTE_EXPECTED_OUTPUT_CONTRACT_SCHEMA_VERSION,
    comparisonMode: contract.comparisonMode,
    dtype: contract.dtype,
    shape: contract.shape,
    elementCount: contract.elementCount,
    byteOrder: contract.byteOrder,
    tolerance: contract.tolerance,
    expectedValues: contract.expectedValues,
    expectedValuesHash: contract.expectedValuesHash,
    expectedRawHash: contract.expectedRawHash,
    binding: contract.binding,
    evidenceRefs: contract.evidenceRefs,
  };
}

function normalizeExpectedContract(input, failures) {
  const source = plainObject(input);
  if (!source) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_missing');
    return null;
  }
  const boundFailure = inspectJsonBounds(source);
  if (boundFailure) {
    pushFailure(failures, `compute_oracle_expected_output_contract_${boundFailure}`);
    return null;
  }
  for (const key of Object.keys(source)) {
    if (!CONTRACT_FIELDS.has(key)) pushFailure(failures, 'compute_oracle_expected_output_contract_unknown_field', { field: key });
  }
  const schemaVersion = textValue(aliasedValue(
    source,
    ['schemaVersion', 'schema_version'],
    failures,
    'compute_oracle_expected_output_contract_schema_version',
  ));
  if (schemaVersion !== COMPUTE_EXPECTED_OUTPUT_CONTRACT_SCHEMA_VERSION) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_schema_version_invalid');
  }
  const comparisonMode = textValue(aliasedValue(
    source,
    ['comparisonMode', 'comparison_mode'],
    failures,
    'compute_oracle_expected_output_contract_comparison_mode',
  ));
  if (!['exact_bytes', 'numeric_tolerance'].includes(comparisonMode)) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_comparison_mode_invalid');
  }
  const dtype = normalizeDtype(aliasedValue(
    source,
    ['dtype', 'dataType', 'data_type'],
    failures,
    'compute_oracle_expected_output_contract_dtype',
  ));
  if (!dtype) pushFailure(failures, 'compute_oracle_expected_output_contract_dtype_invalid');
  const shapeResult = normalizeShape(source.shape, failures, 'compute_oracle_expected_output_contract');
  const declaredElementCount = integerValue(aliasedValue(
    source,
    ['elementCount', 'element_count'],
    failures,
    'compute_oracle_expected_output_contract_element_count',
  ));
  if (!declaredElementCount) pushFailure(failures, 'compute_oracle_expected_output_contract_element_count_invalid');
  if (shapeResult && declaredElementCount && shapeResult.elementCount !== declaredElementCount) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_shape_count_mismatch');
  }
  const byteOrder = dtype
    ? normalizeByteOrder(aliasedValue(
      source,
      ['byteOrder', 'byte_order'],
      failures,
      'compute_oracle_expected_output_contract_byte_order',
    ), dtype)
    : null;
  if (!byteOrder) pushFailure(failures, 'compute_oracle_expected_output_contract_byte_order_invalid');
  const toleranceValue = source.tolerance ?? 0;
  const tolerance = Number.isFinite(toleranceValue) && toleranceValue >= 0
    ? Number(toleranceValue)
    : null;
  if (tolerance === null) pushFailure(failures, 'compute_oracle_expected_output_contract_tolerance_invalid');
  const expectedRawHash = textValue(aliasedValue(
    source,
    ['expectedRawHash', 'expected_raw_hash'],
    failures,
    'compute_oracle_expected_output_contract_expected_raw_hash',
  ));
  const expectedValues = comparisonMode === 'numeric_tolerance' && dtype && declaredElementCount
    ? normalizeExpectedValues(aliasedValue(
      source,
      ['expectedValues', 'expected_values'],
      failures,
      'compute_oracle_expected_output_contract_expected_values',
    ), dtype, declaredElementCount, failures)
    : null;
  const suppliedExpectedValues = aliasedValue(
    source,
    ['expectedValues', 'expected_values'],
    failures,
    'compute_oracle_expected_output_contract_expected_values',
  );
  if (comparisonMode === 'exact_bytes' && suppliedExpectedValues != null) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_expected_values_forbidden');
  }
  if (comparisonMode === 'exact_bytes' && !SHA256_RE.test(expectedRawHash ?? '')) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_expected_raw_hash_invalid');
  }
  const computedExpectedValuesHash = expectedValues ? hashObject(expectedValues) : null;
  const declaredExpectedValuesHash = textValue(aliasedValue(
    source,
    ['expectedValuesHash', 'expected_values_hash'],
    failures,
    'compute_oracle_expected_output_contract_expected_values_hash',
  ));
  if (comparisonMode === 'numeric_tolerance') {
    if (expectedRawHash) {
      pushFailure(failures, 'compute_oracle_expected_output_contract_expected_raw_hash_forbidden');
    }
    if (!SHA256_RE.test(declaredExpectedValuesHash ?? '')) {
      pushFailure(failures, 'compute_oracle_expected_output_contract_expected_values_hash_invalid');
    } else if (computedExpectedValuesHash && declaredExpectedValuesHash !== computedExpectedValuesHash) {
      pushFailure(failures, 'compute_oracle_expected_output_contract_expected_values_hash_mismatch');
    }
  } else if (declaredExpectedValuesHash) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_expected_values_hash_forbidden');
  }
  const binding = normalizeBinding(source.binding, failures, 'compute_oracle_expected_output_contract_binding');
  const evidenceRefs = uniqueStrings(aliasedValue(
    source,
    ['evidenceRefs', 'evidence_refs'],
    failures,
    'compute_oracle_expected_output_contract_evidence_refs',
  ));
  if (evidenceRefs.length === 0) pushFailure(failures, 'compute_oracle_expected_output_contract_evidence_refs_missing');
  const normalized = {
    schemaVersion: COMPUTE_EXPECTED_OUTPUT_CONTRACT_SCHEMA_VERSION,
    comparisonMode,
    dtype,
    shape: shapeResult?.shape ?? null,
    elementCount: declaredElementCount,
    byteOrder,
    tolerance,
    expectedValues,
    expectedValuesHash: computedExpectedValuesHash,
    expectedRawHash: comparisonMode === 'exact_bytes' ? expectedRawHash : null,
    binding,
    evidenceRefs,
  };
  const computedContractHash = hashObject(expectedContractMaterial(normalized));
  const suppliedContractHash = textValue(aliasedValue(
    source,
    ['contractHash', 'contract_hash'],
    failures,
    'compute_oracle_expected_output_contract_hash',
  ));
  if (!SHA256_RE.test(suppliedContractHash ?? '')) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_hash_invalid');
  } else if (suppliedContractHash !== computedContractHash) {
    pushFailure(failures, 'compute_oracle_expected_output_contract_hash_mismatch');
  }
  normalized.contractHash = computedContractHash;
  return normalized;
}

export function buildComputeExpectedOutputContract(input = {}) {
  const source = plainObject(input) ?? {};
  const failures = [];
  const comparisonMode = textValue(source.comparisonMode ?? source.comparison_mode);
  const dtype = normalizeDtype(source.dtype ?? source.dataType ?? source.data_type);
  const elementCount = integerValue(source.elementCount ?? source.element_count);
  const shapeResult = normalizeShape(source.shape, failures, 'compute_oracle_expected_output_contract');
  const byteOrder = dtype
    ? normalizeByteOrder(source.byteOrder ?? source.byte_order, dtype)
    : null;
  const expectedValues = comparisonMode === 'numeric_tolerance' && dtype && elementCount
    ? normalizeExpectedValues(
      source.expectedValues ?? source.expected_values,
      dtype,
      elementCount,
      failures,
    )
    : null;
  const binding = normalizeBinding(
    source.binding,
    failures,
    'compute_oracle_expected_output_contract_binding',
  );
  const canonical = {
    schemaVersion: COMPUTE_EXPECTED_OUTPUT_CONTRACT_SCHEMA_VERSION,
    comparisonMode,
    dtype,
    shape: shapeResult?.shape ?? source.shape,
    elementCount,
    byteOrder,
    tolerance: source.tolerance ?? 0,
    expectedValues,
    expectedValuesHash: expectedValues ? hashObject(expectedValues) : null,
    expectedRawHash: comparisonMode === 'exact_bytes'
      ? source.expectedRawHash ?? source.expected_raw_hash ?? null
      : null,
    binding,
    evidenceRefs: uniqueStrings(source.evidenceRefs ?? source.evidence_refs),
  };
  const candidate = {
    ...canonical,
    contractHash: hashObject(expectedContractMaterial(canonical)),
  };
  const validationFailures = [];
  const normalized = normalizeExpectedContract(candidate, validationFailures);
  failures.push(...validationFailures);
  if (failures.length > 0 || !normalized) {
    const error = new Error(`invalid compute expected-output contract: ${[
      ...new Set(failures.map(({ code }) => code)),
    ].join(',')}`);
    error.failures = failures;
    throw error;
  }
  return { ...candidate, contractHash: normalized.contractHash };
}

function normalizeReadbackMetadata(schema, rawBytes, failures) {
  const schemaVersion = textValue(schema.schemaVersion ?? schema.schema_version);
  if (!READBACK_SCHEMA_VERSIONS.has(schemaVersion)) {
    pushFailure(failures, 'compute_oracle_readback_schema_version_invalid');
  }
  const dtype = normalizeDtype(schema.dtype ?? schema.dataType ?? schema.data_type ?? schema.elementType ?? schema.element_type);
  if (!dtype) pushFailure(failures, 'compute_oracle_readback_schema_dtype_invalid');
  const width = DTYPE_WIDTHS.get(dtype);
  const declaredElementCount = integerValue(schema.elementCount ?? schema.element_count);
  if (!declaredElementCount) pushFailure(failures, 'compute_oracle_readback_schema_element_count_invalid');
  const shapeResult = Array.isArray(schema.shape)
    ? normalizeShape(schema.shape, failures, 'compute_oracle_readback_schema')
    : declaredElementCount
      ? { shape: [declaredElementCount], elementCount: declaredElementCount }
      : null;
  if (shapeResult && declaredElementCount && shapeResult.elementCount !== declaredElementCount) {
    pushFailure(failures, 'compute_oracle_readback_schema_shape_count_mismatch');
  }
  const declaredByteLength = integerValue(schema.byteLength ?? schema.byte_length) ?? rawBytes.length;
  if (declaredByteLength !== rawBytes.length) {
    pushFailure(failures, 'compute_oracle_readback_schema_byte_length_mismatch');
  }
  if (width && declaredElementCount && width * declaredElementCount !== rawBytes.length) {
    pushFailure(failures, 'compute_oracle_readback_schema_dtype_byte_length_mismatch');
  }
  const byteOrder = dtype
    ? normalizeByteOrder(schema.byteOrder ?? schema.byte_order, dtype)
    : null;
  if (!byteOrder) pushFailure(failures, 'compute_oracle_readback_schema_byte_order_invalid');
  const declaredRawHash = textValue(schema.rawReadbackHash ?? schema.raw_readback_hash);
  const actualRawHash = sha256(rawBytes);
  if (declaredRawHash && declaredRawHash !== actualRawHash) {
    pushFailure(failures, 'compute_oracle_readback_schema_raw_hash_mismatch');
  }
  return {
    schemaVersion,
    dtype,
    shape: shapeResult?.shape ?? null,
    elementCount: declaredElementCount,
    byteLength: declaredByteLength,
    byteOrder,
    rawReadbackHash: actualRawHash,
    producerExpectedOutput: plainObject(schema.expectedOutput ?? schema.expected_output),
  };
}

function halfToNumber(bits) {
  const sign = (bits & 0x8000) ? -1 : 1;
  const exponent = (bits >>> 10) & 0x1f;
  const fraction = bits & 0x03ff;
  if (exponent === 0) return sign * (fraction / 1024) * (2 ** -14);
  if (exponent === 0x1f) return fraction === 0 ? sign * Infinity : NaN;
  return sign * (1 + fraction / 1024) * (2 ** (exponent - 15));
}

function bfloatToNumber(bits) {
  const bytes = Buffer.allocUnsafe(4);
  bytes.writeUInt32LE((bits << 16) >>> 0, 0);
  return bytes.readFloatLE(0);
}

function decodeScalar(view, offset, dtype, littleEndian) {
  switch (dtype) {
    case 'bool': return view.getUint8(offset) !== 0;
    case 'i8': return view.getInt8(offset);
    case 'u8': return view.getUint8(offset);
    case 'bf16': return bfloatToNumber(view.getUint16(offset, littleEndian));
    case 'f16': return halfToNumber(view.getUint16(offset, littleEndian));
    case 'i16': return view.getInt16(offset, littleEndian);
    case 'u16': return view.getUint16(offset, littleEndian);
    case 'f32': return view.getFloat32(offset, littleEndian);
    case 'i32': return view.getInt32(offset, littleEndian);
    case 'u32': return view.getUint32(offset, littleEndian);
    case 'f64': return view.getFloat64(offset, littleEndian);
    case 'i64': return view.getBigInt64(offset, littleEndian).toString();
    case 'u64': return view.getBigUint64(offset, littleEndian).toString();
    default: return null;
  }
}

function decodeValues(rawBytes, metadata, failures) {
  if (!metadata.dtype || !metadata.elementCount || !metadata.byteOrder) return null;
  if (metadata.elementCount > MAX_EXPECTED_VALUES) {
    pushFailure(failures, 'compute_oracle_numeric_decode_element_limit_exceeded');
    return null;
  }
  const view = new DataView(rawBytes.buffer, rawBytes.byteOffset, rawBytes.byteLength);
  const width = DTYPE_WIDTHS.get(metadata.dtype);
  const littleEndian = metadata.byteOrder !== 'big_endian';
  const values = [];
  for (let index = 0; index < metadata.elementCount; index += 1) {
    const offset = index * width;
    if (metadata.dtype === 'complex64') {
      values.push([
        view.getFloat32(offset, littleEndian),
        view.getFloat32(offset + 4, littleEndian),
      ]);
    } else if (metadata.dtype === 'complex128') {
      values.push([
        view.getFloat64(offset, littleEndian),
        view.getFloat64(offset + 8, littleEndian),
      ]);
    } else {
      values.push(decodeScalar(view, offset, metadata.dtype, littleEndian));
    }
  }
  if (values.some((value) => (
    Array.isArray(value)
      ? value.some((component) => !Number.isFinite(component))
      : typeof value === 'number' && !Number.isFinite(value)
  ))) {
    pushFailure(failures, 'compute_oracle_actual_value_non_finite');
  }
  return values;
}

function compareValues(actual, expected, dtype, tolerance) {
  let mismatchCount = 0;
  let maxAbsDelta = 0;
  for (let index = 0; index < expected.length; index += 1) {
    const actualValue = actual[index];
    const expectedValue = expected[index];
    if (dtype === 'i64' || dtype === 'u64' || dtype === 'bool') {
      if (actualValue !== expectedValue) mismatchCount += 1;
      continue;
    }
    const actualComponents = Array.isArray(actualValue) ? actualValue : [actualValue];
    const expectedComponents = Array.isArray(expectedValue) ? expectedValue : [expectedValue];
    let mismatched = false;
    for (let component = 0; component < expectedComponents.length; component += 1) {
      const delta = Math.abs(actualComponents[component] - expectedComponents[component]);
      maxAbsDelta = Math.max(maxAbsDelta, delta);
      if (!Number.isFinite(delta) || delta > tolerance) mismatched = true;
    }
    if (mismatched) mismatchCount += 1;
  }
  return { mismatchCount, maxAbsDelta };
}

function producerExpectationConflicts(producerExpectedOutput, contract, failures) {
  if (!producerExpectedOutput) return;
  const producerDtype = normalizeDtype(
    producerExpectedOutput.dtype
    ?? producerExpectedOutput.dataType
    ?? producerExpectedOutput.data_type,
  );
  if (producerDtype && producerDtype !== contract.dtype) {
    pushFailure(failures, 'compute_oracle_producer_expected_dtype_conflicts_with_contract');
  }
  const producerValues = producerExpectedOutput.values ?? producerExpectedOutput.expectedValues;
  if (Array.isArray(producerValues) && contract.expectedValues) {
    const producerFailures = [];
    const normalizedProducerValues = normalizeExpectedValues(
      producerValues,
      contract.dtype,
      contract.elementCount,
      producerFailures,
    );
    if (
      producerFailures.length > 0
      || !normalizedProducerValues
      || hashObject(normalizedProducerValues) !== contract.expectedValuesHash
    ) {
      pushFailure(failures, 'compute_oracle_producer_expected_values_conflict_with_contract');
    }
  }
  const producerHash = textValue(producerExpectedOutput.expectedHash ?? producerExpectedOutput.expected_hash);
  if (producerHash && contract.expectedRawHash && producerHash !== contract.expectedRawHash) {
    pushFailure(failures, 'compute_oracle_producer_expected_hash_conflicts_with_contract');
  }
}

function verifyObservedBinding(contractBinding, observedSource, failures) {
  const observedFailures = [];
  const observed = normalizeBinding(observedSource, observedFailures, 'compute_oracle_observed_binding');
  failures.push(...observedFailures.filter((failure) => (
    !failures.some((existing) => existing.code === failure.code)
  )));
  if (!contractBinding || !observed) return false;
  let accepted = true;
  for (const [camel, snake] of BINDING_FIELDS) {
    if (contractBinding[camel] !== observed[camel]) {
      pushFailure(failures, `compute_oracle_binding_${snake}_mismatch`);
      accepted = false;
    }
  }
  return accepted;
}

export function verifyComputeOracleSemantics({
  rawBytes,
  readbackSchema,
  expectedOutputContract,
  observedBinding,
} = {}) {
  const failures = [];
  const bytes = Buffer.isBuffer(rawBytes) || rawBytes instanceof Uint8Array
    ? Buffer.from(rawBytes)
    : null;
  if (!bytes || bytes.length === 0) pushFailure(failures, 'compute_oracle_raw_readback_bytes_missing');
  const schema = parseReadbackSchema(readbackSchema, failures);
  const contract = normalizeExpectedContract(expectedOutputContract, failures);
  const metadata = bytes && schema ? normalizeReadbackMetadata(schema, bytes, failures) : null;
  let bindingAccepted = false;
  let mismatchCount = null;
  let maxAbsDelta = null;
  let actualValuesHash = null;
  if (contract) bindingAccepted = verifyObservedBinding(contract.binding, observedBinding, failures);
  if (metadata && contract) {
    if (metadata.dtype !== contract.dtype) pushFailure(failures, 'compute_oracle_dtype_contract_mismatch');
    if (stableJson(metadata.shape) !== stableJson(contract.shape)) {
      pushFailure(failures, 'compute_oracle_shape_contract_mismatch');
    }
    if (metadata.elementCount !== contract.elementCount) {
      pushFailure(failures, 'compute_oracle_element_count_contract_mismatch');
    }
    if (metadata.byteOrder !== contract.byteOrder) {
      pushFailure(failures, 'compute_oracle_byte_order_contract_mismatch');
    }
    producerExpectationConflicts(metadata.producerExpectedOutput, contract, failures);
    if (contract.comparisonMode === 'exact_bytes') {
      mismatchCount = metadata.rawReadbackHash === contract.expectedRawHash ? 0 : 1;
      maxAbsDelta = null;
      if (mismatchCount > 0) pushFailure(failures, 'compute_oracle_exact_bytes_mismatch');
    } else if (contract.comparisonMode === 'numeric_tolerance' && bytes) {
      const actualValues = decodeValues(bytes, metadata, failures);
      if (actualValues && contract.expectedValues) {
        actualValuesHash = hashObject(actualValues);
        const comparison = compareValues(actualValues, contract.expectedValues, contract.dtype, contract.tolerance);
        mismatchCount = comparison.mismatchCount;
        maxAbsDelta = comparison.maxAbsDelta;
        if (comparison.mismatchCount > 0) pushFailure(failures, 'compute_oracle_numeric_values_mismatch');
      }
    }
  }
  const accepted = failures.length === 0 && bindingAccepted === true && mismatchCount === 0;
  const failedGates = failures;
  return {
    schemaVersion: COMPUTE_ORACLE_SEMANTIC_VERIFICATION_SCHEMA_VERSION,
    schema_version: COMPUTE_ORACLE_SEMANTIC_VERIFICATION_SCHEMA_VERSION,
    proofAuthority: COMPUTE_ORACLE_SEMANTIC_VERIFICATION_AUTHORITY,
    proof_authority: COMPUTE_ORACLE_SEMANTIC_VERIFICATION_AUTHORITY,
    accepted,
    acceptedForGpuHmr: false,
    accepted_for_gpu_hmr: false,
    gpuHmrSuccess: false,
    gpu_hmr_success: false,
    canSatisfyRuntimeProof: false,
    can_satisfy_runtime_proof: false,
    canSatisfyDispatchProof: false,
    can_satisfy_dispatch_proof: false,
    expectedOutputContractHash: contract?.contractHash ?? null,
    expected_output_contract_hash: contract?.contractHash ?? null,
    comparisonMode: contract?.comparisonMode ?? null,
    comparison_mode: contract?.comparisonMode ?? null,
    dtype: contract?.dtype ?? metadata?.dtype ?? null,
    shape: contract?.shape ?? metadata?.shape ?? null,
    elementCount: contract?.elementCount ?? metadata?.elementCount ?? null,
    element_count: contract?.elementCount ?? metadata?.elementCount ?? null,
    rawReadbackHash: metadata?.rawReadbackHash ?? (bytes ? sha256(bytes) : null),
    raw_readback_hash: metadata?.rawReadbackHash ?? (bytes ? sha256(bytes) : null),
    expectedRawHash: contract?.expectedRawHash ?? null,
    expected_raw_hash: contract?.expectedRawHash ?? null,
    expectedValuesHash: contract?.expectedValuesHash ?? null,
    expected_values_hash: contract?.expectedValuesHash ?? null,
    actualValuesHash,
    actual_values_hash: actualValuesHash,
    mismatchCount,
    mismatch_count: mismatchCount,
    maxAbsDelta,
    max_abs_delta: maxAbsDelta,
    bindingAccepted,
    binding_accepted: bindingAccepted,
    failedGates,
    failed_gates: failedGates,
    evidenceRefs: contract?.evidenceRefs ?? [],
    evidence_refs: contract?.evidenceRefs ?? [],
  };
}
