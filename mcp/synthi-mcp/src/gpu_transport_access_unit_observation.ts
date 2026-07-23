import { createHash, type Hash } from "node:crypto";
import { isProxy, isUint8Array } from "node:util/types";

export const GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA =
  "synthi.gpu_hmr.transport_access_unit_observation.v1" as const;
export const GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION =
  "synthi.gpu_hmr.length_prefixed_transport_record.v1" as const;
export const GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_AUTHORITY =
  "transport_access_unit_observation_only_not_gpu_hmr_acceptance" as const;
export const GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_SCHEMA =
  "synthi.gpu_hmr.transport_access_unit_observation_verification.v1" as const;
export const GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_AUTHORITY =
  "transport_access_unit_byte_commitments_recomputed_only_source_provenance_producer_signature_runtime_binding_ordinal_time_freshness_and_gpu_hmr_acceptance_unchecked" as const;

const PAYLOAD_DOMAIN = "synthi.gpu_hmr.transport_access_unit_payload.v1";
const BOUNDARY_WITNESS_DOMAIN =
  "synthi.gpu_hmr.transport_access_unit_boundary_witness.v1";
const STREAM_IDENTITY_DOMAIN = "synthi.gpu_hmr.transport_stream_identity.v1";
const NATIVE_IDENTITY_DOMAIN = "synthi.gpu_hmr.native_transport_identity.v1";
const OBSERVATION_DOMAIN =
  "synthi.gpu_hmr.transport_access_unit_observation_hash.v1";
const OBSERVATION_ID_PREFIX = "transport-access-unit-observation:sha256:";
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const U64_MAX = 18_446_744_073_709_551_615n;
const U128_MAX = 340_282_366_920_938_463_463_374_607_431_768_211_455n;
const U64_MASK = U64_MAX;

const OBSERVATION_KEYS = [
  "schemaVersion",
  "canonicalizationVersion",
  "streamInstanceIdentitySha256",
  "accessUnitOrdinal",
  "nativeTransportIdentitySha256",
  "fragmentCount",
  "totalPayloadByteLength",
  "transportPayloadCommitmentSha256",
  "nativeBoundaryWitnessCommitmentSha256",
  "observedAtMonotonicNs",
  "canonicalObservationSha256",
  "observationId",
  "proofAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;
const INPUT_KEYS = [
  "observation",
  "streamInstanceIdentity",
  "nativeTransportIdentity",
  "fragments",
  "limits",
] as const;
const LIMIT_KEYS = [
  "maxFragmentCount",
  "maxIdentityByteLength",
  "maxTotalPayloadByteLength",
  "maxTotalNativeBoundaryWitnessByteLength",
] as const;
const FRAGMENT_KEYS = ["payload", "nativeBoundaryWitness"] as const;

export interface GpuTransportAccessUnitObservationFragment {
  readonly payload: Uint8Array;
  readonly nativeBoundaryWitness: Uint8Array;
}

export interface GpuTransportAccessUnitObservationVerificationLimits {
  readonly maxFragmentCount: number;
  readonly maxIdentityByteLength: number;
  readonly maxTotalPayloadByteLength: number;
  readonly maxTotalNativeBoundaryWitnessByteLength: number;
}

export interface GpuTransportAccessUnitObservationVerificationInput {
  readonly observation: unknown;
  readonly streamInstanceIdentity: Uint8Array;
  readonly nativeTransportIdentity: Uint8Array;
  readonly fragments: readonly GpuTransportAccessUnitObservationFragment[];
  readonly limits: GpuTransportAccessUnitObservationVerificationLimits;
}

interface VerificationBase {
  readonly schemaVersion: typeof GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_SCHEMA;
  readonly verificationAuthority:
    typeof GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_AUTHORITY;
  readonly byteCommitmentsRecomputed: boolean;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuTransportAccessUnitObservationVerified extends VerificationBase {
  readonly verified: true;
  readonly reason: null;
  readonly byteCommitmentsRecomputed: true;
  readonly observationId: string;
  readonly canonicalObservationSha256: string;
  readonly streamInstanceIdentitySha256: string;
  readonly nativeTransportIdentitySha256: string;
  readonly transportPayloadCommitmentSha256: string;
  readonly nativeBoundaryWitnessCommitmentSha256: string;
  readonly accessUnitOrdinal: bigint;
  readonly fragmentCount: bigint;
  readonly totalPayloadByteLength: bigint;
  readonly observedAtMonotonicNs: bigint;
}

export interface GpuTransportAccessUnitObservationRefused extends VerificationBase {
  readonly verified: false;
  readonly reason: string;
  readonly observationId: null;
  readonly canonicalObservationSha256: null;
  readonly streamInstanceIdentitySha256: null;
  readonly nativeTransportIdentitySha256: null;
  readonly transportPayloadCommitmentSha256: null;
  readonly nativeBoundaryWitnessCommitmentSha256: null;
  readonly accessUnitOrdinal: null;
  readonly fragmentCount: null;
  readonly totalPayloadByteLength: null;
  readonly observedAtMonotonicNs: null;
}

export type GpuTransportAccessUnitObservationVerification =
  | GpuTransportAccessUnitObservationVerified
  | GpuTransportAccessUnitObservationRefused;

type ExactDataObject = Readonly<Record<string, unknown>>;
type OpaqueByteView = Readonly<{
  buffer: ArrayBuffer;
  byteOffset: number;
  byteLength: number;
}>;
type Observation = Readonly<{
  schemaVersion: string;
  canonicalizationVersion: string;
  streamInstanceIdentitySha256: string;
  accessUnitOrdinal: bigint;
  nativeTransportIdentitySha256: string;
  fragmentCount: bigint;
  totalPayloadByteLength: bigint;
  transportPayloadCommitmentSha256: string;
  nativeBoundaryWitnessCommitmentSha256: string;
  observedAtMonotonicNs: bigint;
  canonicalObservationSha256: string;
  observationId: string;
}>;
type Limits = Readonly<{
  maxFragmentCount: bigint;
  maxIdentityByteLength: bigint;
  maxTotalPayloadByteLength: bigint;
  maxTotalNativeBoundaryWitnessByteLength: bigint;
}>;
type SnapshotFragment = Readonly<{
  payload: Buffer;
  nativeBoundaryWitness: Buffer;
}>;

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;

function refused(reason: string): GpuTransportAccessUnitObservationRefused {
  return Object.freeze({
    schemaVersion: GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_SCHEMA,
    verificationAuthority:
      GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_AUTHORITY,
    verified: false,
    reason,
    byteCommitmentsRecomputed: false,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    observationId: null,
    canonicalObservationSha256: null,
    streamInstanceIdentitySha256: null,
    nativeTransportIdentitySha256: null,
    transportPayloadCommitmentSha256: null,
    nativeBoundaryWitnessCommitmentSha256: null,
    accessUnitOrdinal: null,
    fragmentCount: null,
    totalPayloadByteLength: null,
    observedAtMonotonicNs: null,
  });
}

function snapshotExactDataObject(
  value: unknown,
  expectedKeys: readonly string[],
): ExactDataObject | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    const expected = new Set(expectedKeys);
    if (
      ownKeys.length !== expectedKeys.length
      || ownKeys.some((key) => typeof key !== "string" || !expected.has(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
        || Object.prototype.hasOwnProperty.call(descriptor, "get")
        || Object.prototype.hasOwnProperty.call(descriptor, "set")
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotExactArray(
  value: unknown,
  maxLength: bigint,
): readonly unknown[] | null {
  try {
    if (!Array.isArray(value) || isProxy(value)) return null;
    const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
    if (
      lengthDescriptor === undefined
      || !Object.prototype.hasOwnProperty.call(lengthDescriptor, "value")
      || typeof lengthDescriptor.value !== "number"
      || !Number.isSafeInteger(lengthDescriptor.value)
      || lengthDescriptor.value < 0
    ) {
      return null;
    }
    const length = lengthDescriptor.value;
    if (BigInt(length) > maxLength) return null;
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== length + 1 || !ownKeys.includes("length")) return null;
    const snapshot: unknown[] = [];
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || descriptor.enumerable !== true
        || !Object.prototype.hasOwnProperty.call(descriptor, "value")
        || Object.prototype.hasOwnProperty.call(descriptor, "get")
        || Object.prototype.hasOwnProperty.call(descriptor, "set")
      ) {
        return null;
      }
      snapshot.push(descriptor.value);
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function opaqueByteView(value: unknown): OpaqueByteView | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || isProxy(value)
      || !ArrayBuffer.isView(value)
      || !isUint8Array(value)
      || TYPED_ARRAY_BUFFER_GETTER === undefined
      || TYPED_ARRAY_BYTE_LENGTH_GETTER === undefined
      || TYPED_ARRAY_BYTE_OFFSET_GETTER === undefined
    ) {
      return null;
    }
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as unknown;
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as unknown;
    const byteOffset = Reflect.apply(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      value,
      [],
    ) as unknown;
    if (
      !(buffer instanceof ArrayBuffer)
      || typeof byteLength !== "number"
      || typeof byteOffset !== "number"
      || !Number.isSafeInteger(byteLength)
      || !Number.isSafeInteger(byteOffset)
      || byteLength < 0
      || byteOffset < 0
      || byteOffset + byteLength > buffer.byteLength
    ) {
      return null;
    }
    return Object.freeze({ buffer, byteOffset, byteLength });
  } catch {
    return null;
  }
}

function copyOpaqueBytes(view: OpaqueByteView): Buffer {
  return Buffer.from(new Uint8Array(view.buffer, view.byteOffset, view.byteLength));
}

function parseCanonicalUnsignedDecimal(
  value: unknown,
  maximum: bigint,
): bigint | null {
  if (typeof value !== "string" || !/^(?:0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  try {
    const parsed = BigInt(value);
    return parsed <= maximum ? parsed : null;
  } catch {
    return null;
  }
}

function parseSha256(value: unknown): string | null {
  return typeof value === "string" && SHA256_PATTERN.test(value) ? value : null;
}

function parseLimits(value: unknown): Limits | null {
  const limits = snapshotExactDataObject(value, LIMIT_KEYS);
  if (limits === null) return null;
  const parsed: bigint[] = [];
  for (const key of LIMIT_KEYS) {
    const candidate = limits[key];
    if (
      typeof candidate !== "number"
      || !Number.isSafeInteger(candidate)
      || candidate <= 0
    ) {
      return null;
    }
    parsed.push(BigInt(candidate));
  }
  const [
    maxFragmentCount,
    maxIdentityByteLength,
    maxTotalPayloadByteLength,
    maxTotalNativeBoundaryWitnessByteLength,
  ] = parsed;
  if (
    maxFragmentCount === undefined
    || maxIdentityByteLength === undefined
    || maxTotalPayloadByteLength === undefined
    || maxTotalNativeBoundaryWitnessByteLength === undefined
  ) {
    return null;
  }
  return Object.freeze({
    maxFragmentCount,
    maxIdentityByteLength,
    maxTotalPayloadByteLength,
    maxTotalNativeBoundaryWitnessByteLength,
  });
}

function updateU64(hasher: Hash, value: bigint): void {
  const bytes = Buffer.allocUnsafe(8);
  bytes.writeBigUInt64BE(value);
  hasher.update(bytes);
}

function updateU128(hasher: Hash, value: bigint): void {
  updateU64(hasher, value >> 64n);
  updateU64(hasher, value & U64_MASK);
}

function updateLengthPrefixed(hasher: Hash, value: Uint8Array): void {
  updateU64(hasher, BigInt(value.byteLength));
  hasher.update(value);
}

function sha256Record(update: (hasher: Hash) => void): string {
  const hasher = createHash("sha256");
  update(hasher);
  return `sha256:${hasher.digest("hex")}`;
}

function payloadCommitment(fragments: readonly SnapshotFragment[]): string {
  return sha256Record((hasher) => {
    updateLengthPrefixed(hasher, Buffer.from(PAYLOAD_DOMAIN));
    updateLengthPrefixed(
      hasher,
      Buffer.from(GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION),
    );
    updateU64(hasher, BigInt(fragments.length));
    for (const fragment of fragments) updateLengthPrefixed(hasher, fragment.payload);
  });
}

function boundaryWitnessCommitment(fragments: readonly SnapshotFragment[]): string {
  return sha256Record((hasher) => {
    updateLengthPrefixed(hasher, Buffer.from(BOUNDARY_WITNESS_DOMAIN));
    updateLengthPrefixed(
      hasher,
      Buffer.from(GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION),
    );
    updateU64(hasher, BigInt(fragments.length));
    for (const fragment of fragments) {
      updateLengthPrefixed(hasher, fragment.nativeBoundaryWitness);
    }
  });
}

function identityCommitment(domain: string, identity: Uint8Array): string {
  return sha256Record((hasher) => {
    updateLengthPrefixed(hasher, Buffer.from(domain));
    updateLengthPrefixed(
      hasher,
      Buffer.from(GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION),
    );
    updateLengthPrefixed(hasher, identity);
  });
}

function observationCommitment(
  streamInstanceIdentitySha256: string,
  accessUnitOrdinal: bigint,
  nativeTransportIdentitySha256: string,
  fragmentCount: bigint,
  totalPayloadByteLength: bigint,
  transportPayloadCommitmentSha256: string,
  nativeBoundaryWitnessCommitmentSha256: string,
  observedAtMonotonicNs: bigint,
): string {
  return sha256Record((hasher) => {
    updateLengthPrefixed(hasher, Buffer.from(OBSERVATION_DOMAIN));
    updateLengthPrefixed(
      hasher,
      Buffer.from(GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA),
    );
    updateLengthPrefixed(
      hasher,
      Buffer.from(GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION),
    );
    updateLengthPrefixed(hasher, Buffer.from(streamInstanceIdentitySha256));
    updateU64(hasher, accessUnitOrdinal);
    updateLengthPrefixed(hasher, Buffer.from(nativeTransportIdentitySha256));
    updateU64(hasher, fragmentCount);
    updateU64(hasher, totalPayloadByteLength);
    updateLengthPrefixed(hasher, Buffer.from(transportPayloadCommitmentSha256));
    updateLengthPrefixed(
      hasher,
      Buffer.from(nativeBoundaryWitnessCommitmentSha256),
    );
    updateU128(hasher, observedAtMonotonicNs);
  });
}

function parseObservation(value: unknown): Observation | null {
  const observation = snapshotExactDataObject(value, OBSERVATION_KEYS);
  if (observation === null) return null;
  if (
    observation.schemaVersion !== GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA
    || observation.canonicalizationVersion
      !== GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION
    || observation.proofAuthority !== GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_AUTHORITY
    || observation.acceptedForGpuHmr !== false
    || observation.gpuHmrSuccess !== false
    || observation.canSatisfyRuntimeProof !== false
  ) {
    return null;
  }
  const streamInstanceIdentitySha256 = parseSha256(
    observation.streamInstanceIdentitySha256,
  );
  const nativeTransportIdentitySha256 = parseSha256(
    observation.nativeTransportIdentitySha256,
  );
  const transportPayloadCommitmentSha256 = parseSha256(
    observation.transportPayloadCommitmentSha256,
  );
  const nativeBoundaryWitnessCommitmentSha256 = parseSha256(
    observation.nativeBoundaryWitnessCommitmentSha256,
  );
  const canonicalObservationSha256 = parseSha256(
    observation.canonicalObservationSha256,
  );
  const accessUnitOrdinal = parseCanonicalUnsignedDecimal(
    observation.accessUnitOrdinal,
    U64_MAX,
  );
  const fragmentCount = parseCanonicalUnsignedDecimal(observation.fragmentCount, U64_MAX);
  const totalPayloadByteLength = parseCanonicalUnsignedDecimal(
    observation.totalPayloadByteLength,
    U64_MAX,
  );
  const observedAtMonotonicNs = parseCanonicalUnsignedDecimal(
    observation.observedAtMonotonicNs,
    U128_MAX,
  );
  if (
    streamInstanceIdentitySha256 === null
    || nativeTransportIdentitySha256 === null
    || transportPayloadCommitmentSha256 === null
    || nativeBoundaryWitnessCommitmentSha256 === null
    || canonicalObservationSha256 === null
    || accessUnitOrdinal === null
    || fragmentCount === null
    || totalPayloadByteLength === null
    || observedAtMonotonicNs === null
    || observation.observationId
      !== `${OBSERVATION_ID_PREFIX}${canonicalObservationSha256.slice("sha256:".length)}`
  ) {
    return null;
  }
  return Object.freeze({
    schemaVersion: observation.schemaVersion,
    canonicalizationVersion: observation.canonicalizationVersion,
    streamInstanceIdentitySha256,
    accessUnitOrdinal,
    nativeTransportIdentitySha256,
    fragmentCount,
    totalPayloadByteLength,
    transportPayloadCommitmentSha256,
    nativeBoundaryWitnessCommitmentSha256,
    observedAtMonotonicNs,
    canonicalObservationSha256,
    observationId: observation.observationId,
  });
}

function snapshotFragments(
  value: unknown,
  limits: Limits,
): readonly SnapshotFragment[] | null {
  const fragments = snapshotExactArray(value, limits.maxFragmentCount);
  if (
    fragments === null
    || fragments.length === 0
  ) {
    return null;
  }
  const views: Array<Readonly<{ payload: OpaqueByteView; nativeBoundaryWitness: OpaqueByteView }>> = [];
  let totalPayloadByteLength = 0n;
  let totalNativeBoundaryWitnessByteLength = 0n;
  for (const candidate of fragments) {
    const fragment = snapshotExactDataObject(candidate, FRAGMENT_KEYS);
    if (fragment === null) return null;
    const payload = opaqueByteView(fragment.payload);
    const nativeBoundaryWitness = opaqueByteView(fragment.nativeBoundaryWitness);
    if (payload === null || nativeBoundaryWitness === null || nativeBoundaryWitness.byteLength === 0) {
      return null;
    }
    totalPayloadByteLength += BigInt(payload.byteLength);
    totalNativeBoundaryWitnessByteLength += BigInt(nativeBoundaryWitness.byteLength);
    if (
      totalPayloadByteLength > U64_MAX
      || totalNativeBoundaryWitnessByteLength > U64_MAX
      || totalPayloadByteLength > limits.maxTotalPayloadByteLength
      || totalNativeBoundaryWitnessByteLength
        > limits.maxTotalNativeBoundaryWitnessByteLength
    ) {
      return null;
    }
    views.push(Object.freeze({ payload, nativeBoundaryWitness }));
  }
  return Object.freeze(views.map(({ payload, nativeBoundaryWitness }) => Object.freeze({
    payload: copyOpaqueBytes(payload),
    nativeBoundaryWitness: copyOpaqueBytes(nativeBoundaryWitness),
  })));
}

export function verifyGpuTransportAccessUnitObservation(
  inputValue: unknown,
): GpuTransportAccessUnitObservationVerification {
  const input = snapshotExactDataObject(inputValue, INPUT_KEYS);
  if (input === null) {
    return refused("gpu_transport_access_unit_observation_input_shape_invalid");
  }
  const limits = parseLimits(input.limits);
  if (limits === null) {
    return refused("gpu_transport_access_unit_observation_limits_invalid");
  }
  const streamInstanceIdentityView = opaqueByteView(input.streamInstanceIdentity);
  const nativeTransportIdentityView = opaqueByteView(input.nativeTransportIdentity);
  if (
    streamInstanceIdentityView === null
    || nativeTransportIdentityView === null
    || streamInstanceIdentityView.byteLength === 0
    || nativeTransportIdentityView.byteLength === 0
    || BigInt(streamInstanceIdentityView.byteLength) > limits.maxIdentityByteLength
    || BigInt(nativeTransportIdentityView.byteLength) > limits.maxIdentityByteLength
  ) {
    return refused("gpu_transport_access_unit_observation_identity_invalid");
  }
  const fragments = snapshotFragments(input.fragments, limits);
  if (fragments === null) {
    return refused("gpu_transport_access_unit_observation_fragments_invalid");
  }
  const observation = parseObservation(input.observation);
  if (observation === null) {
    return refused("gpu_transport_access_unit_observation_shape_or_authority_invalid");
  }

  const streamInstanceIdentity = copyOpaqueBytes(streamInstanceIdentityView);
  const nativeTransportIdentity = copyOpaqueBytes(nativeTransportIdentityView);
  const fragmentCount = BigInt(fragments.length);
  const totalPayloadByteLength = fragments.reduce(
    (total, fragment) => total + BigInt(fragment.payload.byteLength),
    0n,
  );
  const streamInstanceIdentitySha256 = identityCommitment(
    STREAM_IDENTITY_DOMAIN,
    streamInstanceIdentity,
  );
  const nativeTransportIdentitySha256 = identityCommitment(
    NATIVE_IDENTITY_DOMAIN,
    nativeTransportIdentity,
  );
  const transportPayloadCommitmentSha256 = payloadCommitment(fragments);
  const nativeBoundaryWitnessCommitmentSha256 = boundaryWitnessCommitment(fragments);
  const canonicalObservationSha256 = observationCommitment(
    streamInstanceIdentitySha256,
    observation.accessUnitOrdinal,
    nativeTransportIdentitySha256,
    fragmentCount,
    totalPayloadByteLength,
    transportPayloadCommitmentSha256,
    nativeBoundaryWitnessCommitmentSha256,
    observation.observedAtMonotonicNs,
  );
  const expectedObservationId = `${OBSERVATION_ID_PREFIX}${canonicalObservationSha256.slice(
    "sha256:".length,
  )}`;
  if (
    observation.streamInstanceIdentitySha256 !== streamInstanceIdentitySha256
    || observation.nativeTransportIdentitySha256 !== nativeTransportIdentitySha256
    || observation.fragmentCount !== fragmentCount
    || observation.totalPayloadByteLength !== totalPayloadByteLength
    || observation.transportPayloadCommitmentSha256 !== transportPayloadCommitmentSha256
    || observation.nativeBoundaryWitnessCommitmentSha256
      !== nativeBoundaryWitnessCommitmentSha256
    || observation.canonicalObservationSha256 !== canonicalObservationSha256
    || observation.observationId !== expectedObservationId
  ) {
    return refused("gpu_transport_access_unit_observation_commitment_mismatch");
  }
  return Object.freeze({
    schemaVersion: GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_SCHEMA,
    verificationAuthority:
      GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_AUTHORITY,
    verified: true,
    reason: null,
    byteCommitmentsRecomputed: true,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    observationId: observation.observationId,
    canonicalObservationSha256,
    streamInstanceIdentitySha256,
    nativeTransportIdentitySha256,
    transportPayloadCommitmentSha256,
    nativeBoundaryWitnessCommitmentSha256,
    accessUnitOrdinal: observation.accessUnitOrdinal,
    fragmentCount,
    totalPayloadByteLength,
    observedAtMonotonicNs: observation.observedAtMonotonicNs,
  });
}
