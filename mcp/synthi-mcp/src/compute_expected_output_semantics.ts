import { createHash } from "node:crypto";

export const COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION =
  "synthi.gpu_hmr.compute_expected_output_semantics.v1" as const;

const SEMANTICS_HASH_DOMAIN =
  "synthi.gpu_hmr.compute_expected_output_semantics_hash.v1";
const EXPECTED_VALUES_HASH_DOMAIN =
  "synthi.gpu_hmr.compute_expected_output_values_hash.v1";
const CANONICAL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const CANONICAL_DECIMAL_PATTERN =
  /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]*[1-9])?$/;
const MAX_DECIMAL_CHARS = 128;
const MAX_OUTPUT_TARGET_CHARS = 512;
const MAX_SHAPE_RANK = 32;
const MAX_EXPECTED_VALUES = 16_384;

const DTYPE_BYTES = Object.freeze({
  u8: 1,
  i8: 1,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  i64: 8,
  f32: 4,
  f64: 8,
} as const);

type ComputeDtype = keyof typeof DTYPE_BYTES;
type ComparisonMode = "exact_bytes" | "numeric_tolerance";
type ByteOrder = "little_endian" | "big_endian" | "not_applicable";

export interface ComputeExpectedOutputSemanticsMaterial {
  readonly schemaVersion: typeof COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION;
  readonly comparisonMode: ComparisonMode;
  readonly outputTargetId: string;
  readonly byteOffset: number;
  readonly byteLength: number;
  readonly dtype: ComputeDtype;
  readonly shape: readonly number[];
  readonly elementCount: number;
  readonly byteOrder: ByteOrder;
  readonly toleranceDecimal: string;
  readonly expectedValuesDecimal: readonly string[] | null;
  readonly expectedValuesHash: string | null;
  readonly expectedRawHash: string | null;
}

export interface ComputeExpectedOutputSemantics
  extends ComputeExpectedOutputSemanticsMaterial {
  readonly semanticsHash: string;
}

export type ComputeExpectedOutputSemanticsValidation =
  | {
      readonly accepted: true;
      readonly value: Readonly<ComputeExpectedOutputSemantics>;
    }
  | {
      readonly accepted: false;
      readonly reason: string;
    };

const SEMANTICS_FIELDS = Object.freeze([
  "schemaVersion",
  "comparisonMode",
  "outputTargetId",
  "byteOffset",
  "byteLength",
  "dtype",
  "shape",
  "elementCount",
  "byteOrder",
  "toleranceDecimal",
  "expectedValuesDecimal",
  "expectedValuesHash",
  "expectedRawHash",
  "semanticsHash",
] as const);

function sha256(domain: string, material: unknown): string {
  return `sha256:${createHash("sha256")
    .update(domain)
    .update("\0")
    .update(JSON.stringify(material))
    .digest("hex")}`;
}

export function computeExpectedOutputValuesHash(
  values: readonly string[],
): string {
  return sha256(EXPECTED_VALUES_HASH_DOMAIN, values);
}

export function computeExpectedOutputSemanticsHash(
  value: ComputeExpectedOutputSemanticsMaterial,
): string {
  return sha256(SEMANTICS_HASH_DOMAIN, [
    value.schemaVersion,
    value.comparisonMode,
    value.outputTargetId,
    String(value.byteOffset),
    String(value.byteLength),
    value.dtype,
    value.shape.map(String),
    String(value.elementCount),
    value.byteOrder,
    value.toleranceDecimal,
    value.expectedValuesDecimal,
    value.expectedValuesHash,
    value.expectedRawHash,
  ]);
}

function plainDataRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const record: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!("value" in descriptor) || descriptor.enumerable !== true) return null;
    record[key] = descriptor.value;
  }
  return record;
}

function exactFields(record: Record<string, unknown>): boolean {
  const keys = Object.keys(record).sort();
  const expected = [...SEMANTICS_FIELDS].sort();
  return keys.length === expected.length
    && keys.every((key, index) => key === expected[index]);
}

function canonicalOutputTarget(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= MAX_OUTPUT_TARGET_CHARS
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalSafeInteger(value: unknown, allowZero: boolean): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && (allowZero ? value >= 0 : value > 0);
}

function denseNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  if (value.length > MAX_SHAPE_RANK) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const result: number[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || !canonicalSafeInteger(descriptor.value, false)
    ) {
      return null;
    }
    result.push(descriptor.value);
  }
  if (Object.keys(value).length !== value.length) return null;
  return result;
}

function denseStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    return null;
  }
  if (value.length === 0 || value.length > MAX_EXPECTED_VALUES) return null;
  if (Object.getOwnPropertySymbols(value).length > 0) return null;
  const result: string[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.prototype.hasOwnProperty.call(value, index)) return null;
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (
      descriptor === undefined
      || !("value" in descriptor)
      || descriptor.enumerable !== true
      || typeof descriptor.value !== "string"
    ) {
      return null;
    }
    result.push(descriptor.value);
  }
  if (Object.keys(value).length !== value.length) return null;
  return result;
}

function canonicalDecimal(value: string): boolean {
  return value.length > 0
    && value.length <= MAX_DECIMAL_CHARS
    && value !== "-0"
    && CANONICAL_DECIMAL_PATTERN.test(value);
}

function decimalValidForDtype(value: string, dtype: ComputeDtype): boolean {
  if (!canonicalDecimal(value)) return false;
  if (dtype.startsWith("u") || dtype.startsWith("i")) {
    if (value.includes(".")) return false;
    let parsed: bigint;
    try {
      parsed = BigInt(value);
    } catch {
      return false;
    }
    const bits = BigInt(Number(dtype.slice(1)));
    if (dtype.startsWith("u")) {
      return parsed >= 0n && parsed <= (1n << bits) - 1n;
    }
    const magnitude = 1n << (bits - 1n);
    return parsed >= -magnitude && parsed < magnitude;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || (parsed === 0 && value !== "0")) return false;
  if (dtype === "f32") {
    const rounded = Math.fround(parsed);
    return Number.isFinite(rounded) && (rounded !== 0 || parsed === 0);
  }
  return true;
}

function product(values: readonly number[]): number | null {
  let result = 1;
  for (const value of values) {
    result *= value;
    if (!Number.isSafeInteger(result)) return null;
  }
  return result;
}

function freezeSemantics(
  value: ComputeExpectedOutputSemantics,
): Readonly<ComputeExpectedOutputSemantics> {
  const shape = Object.freeze([...value.shape]);
  const expectedValuesDecimal = value.expectedValuesDecimal === null
    ? null
    : Object.freeze([...value.expectedValuesDecimal]);
  return Object.freeze({ ...value, shape, expectedValuesDecimal });
}

export function validateComputeExpectedOutputSemantics(
  input: unknown,
): ComputeExpectedOutputSemanticsValidation {
  const record = plainDataRecord(input);
  if (record === null) return { accepted: false, reason: "expected a plain data object" };
  if (!exactFields(record)) {
    return { accepted: false, reason: "expected exact semantic-contract fields" };
  }
  if (record.schemaVersion !== COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION) {
    return { accepted: false, reason: "schema version mismatch" };
  }
  if (
    record.comparisonMode !== "exact_bytes"
    && record.comparisonMode !== "numeric_tolerance"
  ) {
    return { accepted: false, reason: "comparison mode is invalid" };
  }
  if (!canonicalOutputTarget(record.outputTargetId)) {
    return { accepted: false, reason: "output target is invalid" };
  }
  if (!canonicalSafeInteger(record.byteOffset, true)) {
    return { accepted: false, reason: "byte offset is invalid" };
  }
  if (!canonicalSafeInteger(record.byteLength, false)) {
    return { accepted: false, reason: "byte length is invalid" };
  }
  if (typeof record.dtype !== "string" || !(record.dtype in DTYPE_BYTES)) {
    return { accepted: false, reason: "dtype is invalid" };
  }
  const dtype = record.dtype as ComputeDtype;
  const shape = denseNumberArray(record.shape);
  if (shape === null) return { accepted: false, reason: "shape is invalid" };
  if (!canonicalSafeInteger(record.elementCount, false)) {
    return { accepted: false, reason: "element count is invalid" };
  }
  const shapeElements = product(shape);
  if (shapeElements === null || shapeElements !== record.elementCount) {
    return { accepted: false, reason: "shape does not match element count" };
  }
  const dtypeBytes = DTYPE_BYTES[dtype];
  const expectedByteLength = record.elementCount * dtypeBytes;
  if (
    !Number.isSafeInteger(expectedByteLength)
    || expectedByteLength !== record.byteLength
    || record.byteOffset % dtypeBytes !== 0
    || !Number.isSafeInteger(record.byteOffset + record.byteLength)
  ) {
    return { accepted: false, reason: "byte selection does not match dtype and shape" };
  }
  if (
    record.byteOrder !== "little_endian"
    && record.byteOrder !== "big_endian"
    && record.byteOrder !== "not_applicable"
  ) {
    return { accepted: false, reason: "byte order is invalid" };
  }
  if (
    (dtypeBytes === 1 && record.byteOrder !== "not_applicable")
    || (dtypeBytes > 1 && record.byteOrder === "not_applicable")
  ) {
    return { accepted: false, reason: "byte order does not match dtype width" };
  }
  if (
    typeof record.toleranceDecimal !== "string"
    || !canonicalDecimal(record.toleranceDecimal)
    || record.toleranceDecimal.startsWith("-")
  ) {
    return { accepted: false, reason: "tolerance is invalid" };
  }

  let expectedValuesDecimal: readonly string[] | null = null;
  if (record.comparisonMode === "exact_bytes") {
    if (
      record.toleranceDecimal !== "0"
      || record.expectedValuesDecimal !== null
      || record.expectedValuesHash !== null
      || typeof record.expectedRawHash !== "string"
      || !CANONICAL_SHA256_PATTERN.test(record.expectedRawHash)
    ) {
      return { accepted: false, reason: "exact-byte expectation fields are inconsistent" };
    }
  } else {
    const values = denseStringArray(record.expectedValuesDecimal);
    if (
      values === null
      || values.length !== record.elementCount
      || values.some((value) => !decimalValidForDtype(value, dtype))
      || typeof record.expectedValuesHash !== "string"
      || !CANONICAL_SHA256_PATTERN.test(record.expectedValuesHash)
      || record.expectedValuesHash !== computeExpectedOutputValuesHash(values)
      || record.expectedRawHash !== null
    ) {
      return { accepted: false, reason: "numeric expectation fields are inconsistent" };
    }
    expectedValuesDecimal = values;
  }
  if (
    typeof record.semanticsHash !== "string"
    || !CANONICAL_SHA256_PATTERN.test(record.semanticsHash)
  ) {
    return { accepted: false, reason: "semantics hash is invalid" };
  }

  const material: ComputeExpectedOutputSemanticsMaterial = {
    schemaVersion: COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
    comparisonMode: record.comparisonMode,
    outputTargetId: record.outputTargetId,
    byteOffset: record.byteOffset,
    byteLength: record.byteLength,
    dtype,
    shape,
    elementCount: record.elementCount,
    byteOrder: record.byteOrder,
    toleranceDecimal: record.toleranceDecimal,
    expectedValuesDecimal,
    expectedValuesHash: record.expectedValuesHash as string | null,
    expectedRawHash: record.expectedRawHash as string | null,
  };
  if (record.semanticsHash !== computeExpectedOutputSemanticsHash(material)) {
    return { accepted: false, reason: "semantics hash mismatch" };
  }
  return {
    accepted: true,
    value: freezeSemantics({ ...material, semanticsHash: record.semanticsHash }),
  };
}
