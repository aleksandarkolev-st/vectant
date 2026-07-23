import { createHash, type Hash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_AUTHORITY,
  GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION,
  GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA,
  GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_AUTHORITY,
  verifyGpuTransportAccessUnitObservation,
  type GpuTransportAccessUnitObservationFragment,
  type GpuTransportAccessUnitObservationVerificationInput,
} from "../../src/gpu_transport_access_unit_observation.js";

const PAYLOAD_DOMAIN = "synthi.gpu_hmr.transport_access_unit_payload.v1";
const BOUNDARY_WITNESS_DOMAIN =
  "synthi.gpu_hmr.transport_access_unit_boundary_witness.v1";
const STREAM_IDENTITY_DOMAIN = "synthi.gpu_hmr.transport_stream_identity.v1";
const NATIVE_IDENTITY_DOMAIN = "synthi.gpu_hmr.native_transport_identity.v1";
const OBSERVATION_DOMAIN =
  "synthi.gpu_hmr.transport_access_unit_observation_hash.v1";
const OBSERVATION_ID_PREFIX = "transport-access-unit-observation:sha256:";
const U64_MASK = 18_446_744_073_709_551_615n;

const limits = Object.freeze({
  maxFragmentCount: 8,
  maxIdentityByteLength: 64,
  maxTotalPayloadByteLength: 256,
  maxTotalNativeBoundaryWitnessByteLength: 256,
});

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

function digest(update: (hasher: Hash) => void): string {
  const hasher = createHash("sha256");
  update(hasher);
  return `sha256:${hasher.digest("hex")}`;
}

function identityCommitment(domain: string, identity: Uint8Array): string {
  return digest((hasher) => {
    updateLengthPrefixed(hasher, Buffer.from(domain));
    updateLengthPrefixed(
      hasher,
      Buffer.from(GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION),
    );
    updateLengthPrefixed(hasher, identity);
  });
}

function payloadCommitment(fragments: readonly GpuTransportAccessUnitObservationFragment[]): string {
  return digest((hasher) => {
    updateLengthPrefixed(hasher, Buffer.from(PAYLOAD_DOMAIN));
    updateLengthPrefixed(
      hasher,
      Buffer.from(GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION),
    );
    updateU64(hasher, BigInt(fragments.length));
    for (const fragment of fragments) updateLengthPrefixed(hasher, fragment.payload);
  });
}

function boundaryWitnessCommitment(
  fragments: readonly GpuTransportAccessUnitObservationFragment[],
): string {
  return digest((hasher) => {
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
  return digest((hasher) => {
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
    updateLengthPrefixed(hasher, Buffer.from(nativeBoundaryWitnessCommitmentSha256));
    updateU128(hasher, observedAtMonotonicNs);
  });
}

function fixture(overrides: Partial<Record<string, unknown>> = {}): GpuTransportAccessUnitObservationVerificationInput {
  const streamInstanceIdentity = Buffer.from([0, 17, 33, 255]);
  const nativeTransportIdentity = Buffer.from([91, 0, 77, 142]);
  const fragments = Object.freeze([
    Object.freeze({
      payload: Buffer.alloc(0),
      nativeBoundaryWitness: Buffer.from([4, 0, 5]),
    }),
    Object.freeze({
      payload: Buffer.from([1, 2, 3]),
      nativeBoundaryWitness: Buffer.from([8, 9]),
    }),
  ]);
  const accessUnitOrdinal = 0n;
  const observedAtMonotonicNs = 340_282_366_920_938_463_463_374_607_431_768_211_450n;
  const streamInstanceIdentitySha256 = identityCommitment(
    STREAM_IDENTITY_DOMAIN,
    streamInstanceIdentity,
  );
  const nativeTransportIdentitySha256 = identityCommitment(
    NATIVE_IDENTITY_DOMAIN,
    nativeTransportIdentity,
  );
  const fragmentCount = BigInt(fragments.length);
  const totalPayloadByteLength = fragments.reduce(
    (total, fragment) => total + BigInt(fragment.payload.byteLength),
    0n,
  );
  const transportPayloadCommitmentSha256 = payloadCommitment(fragments);
  const nativeBoundaryWitnessCommitmentSha256 = boundaryWitnessCommitment(fragments);
  const canonicalObservationSha256 = observationCommitment(
    streamInstanceIdentitySha256,
    accessUnitOrdinal,
    nativeTransportIdentitySha256,
    fragmentCount,
    totalPayloadByteLength,
    transportPayloadCommitmentSha256,
    nativeBoundaryWitnessCommitmentSha256,
    observedAtMonotonicNs,
  );
  const observation = {
    schemaVersion: GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_SCHEMA,
    canonicalizationVersion: GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_CANONICALIZATION,
    streamInstanceIdentitySha256,
    accessUnitOrdinal: accessUnitOrdinal.toString(),
    nativeTransportIdentitySha256,
    fragmentCount: fragmentCount.toString(),
    totalPayloadByteLength: totalPayloadByteLength.toString(),
    transportPayloadCommitmentSha256,
    nativeBoundaryWitnessCommitmentSha256,
    observedAtMonotonicNs: observedAtMonotonicNs.toString(),
    canonicalObservationSha256,
    observationId: `${OBSERVATION_ID_PREFIX}${canonicalObservationSha256.slice("sha256:".length)}`,
    proofAuthority: GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_AUTHORITY,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    ...overrides,
  };
  return {
    observation,
    streamInstanceIdentity,
    nativeTransportIdentity,
    fragments,
    limits,
  };
}

describe("verifyGpuTransportAccessUnitObservation", () => {
  it("recomputes ordered opaque bytes, zero ordinal, empty payloads, and u128 time", () => {
    const input = fixture();
    const result = verifyGpuTransportAccessUnitObservation(input);

    expect(result.verified).toBe(true);
    if (!result.verified) return;
    expect(result.accessUnitOrdinal).toBe(0n);
    expect(result.fragmentCount).toBe(2n);
    expect(result.totalPayloadByteLength).toBe(3n);
    expect(result.observedAtMonotonicNs).toBe(
      340_282_366_920_938_463_463_374_607_431_768_211_450n,
    );
    expect(result.byteCommitmentsRecomputed).toBe(true);
    expect(result.verificationAuthority).toBe(
      GPU_TRANSPORT_ACCESS_UNIT_OBSERVATION_VERIFICATION_AUTHORITY,
    );
    expect(result.acceptedForGpuHmr).toBe(false);
    expect(result.gpuHmrSuccess).toBe(false);
    expect(result.canSatisfyRuntimeProof).toBe(false);
    expect(Object.values(result).some((value) => value instanceof Uint8Array)).toBe(false);
  });

  it.each([
    ["fragment order", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      fragments: [...input.fragments].reverse(),
    })],
    ["boundary witness", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      fragments: [
        input.fragments[0]!,
        { ...input.fragments[1]!, nativeBoundaryWitness: Buffer.from([9, 8]) },
      ],
    })],
    ["stream identity", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      streamInstanceIdentity: Buffer.from([0, 17, 33, 254]),
    })],
    ["native identity", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      nativeTransportIdentity: Buffer.from([91, 0, 77, 141]),
    })],
    ["payload length", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      fragments: [
        input.fragments[0]!,
        { ...input.fragments[1]!, payload: Buffer.from([1, 2, 3, 4]) },
      ],
    })],
    ["reported hash", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      observation: {
        ...(input.observation as Record<string, unknown>),
        canonicalObservationSha256: `sha256:${"0".repeat(64)}`,
        observationId: `${OBSERVATION_ID_PREFIX}${"0".repeat(64)}`,
      },
    })],
  ])("rejects altered %s", (_name, alter) => {
    const result = verifyGpuTransportAccessUnitObservation(alter(fixture()));
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("gpu_transport_access_unit_observation_commitment_mismatch");
  });

  it("rejects extra serialized fields and support-claiming flags", () => {
    const extra = fixture();
    const extraResult = verifyGpuTransportAccessUnitObservation({
      ...extra,
      observation: { ...(extra.observation as Record<string, unknown>), extra: true },
    });
    expect(extraResult.verified).toBe(false);
    expect(extraResult.reason).toBe(
      "gpu_transport_access_unit_observation_shape_or_authority_invalid",
    );

    const success = fixture();
    const successResult = verifyGpuTransportAccessUnitObservation({
      ...success,
      observation: { ...(success.observation as Record<string, unknown>), gpuHmrSuccess: true },
    });
    expect(successResult.verified).toBe(false);
    expect(successResult.reason).toBe(
      "gpu_transport_access_unit_observation_shape_or_authority_invalid",
    );
  });

  it.each([
    ["leading zero", "00"],
    ["signed", "+1"],
    ["numeric value", 1],
    ["u64 overflow", "18446744073709551616"],
    ["u128 overflow", "340282366920938463463374607431768211456"],
  ])("rejects noncanonical numeric representation: %s", (_name, value) => {
    const input = fixture();
    const observation = { ...(input.observation as Record<string, unknown>) };
    if (_name === "u128 overflow") observation.observedAtMonotonicNs = value;
    else observation.accessUnitOrdinal = value;
    const result = verifyGpuTransportAccessUnitObservation({ ...input, observation });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe(
      "gpu_transport_access_unit_observation_shape_or_authority_invalid",
    );
  });

  it("enforces caller-provided verification bounds before copying bytes", () => {
    const input = fixture();
    const result = verifyGpuTransportAccessUnitObservation({
      ...input,
      limits: { ...limits, maxTotalPayloadByteLength: 2 },
    });
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("gpu_transport_access_unit_observation_fragments_invalid");
    expect(result.byteCommitmentsRecomputed).toBe(false);
    expect(result.acceptedForGpuHmr).toBe(false);
    expect(result.gpuHmrSuccess).toBe(false);
    expect(result.canSatisfyRuntimeProof).toBe(false);
  });

  it.each([
    ["top-level input proxy", (input: GpuTransportAccessUnitObservationVerificationInput) =>
      new Proxy(input as object, {})],
    ["top-level input getter", (input: GpuTransportAccessUnitObservationVerificationInput) => {
      const topLevel = { ...input };
      Object.defineProperty(topLevel, "limits", {
        enumerable: true,
        get: () => input.limits,
      });
      return topLevel;
    }],
    ["limits proxy", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      limits: new Proxy(input.limits, {}),
    })],
    ["fragment array proxy", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      fragments: new Proxy(input.fragments, {}),
    })],
    ["fragment object getter", (input: GpuTransportAccessUnitObservationVerificationInput) => {
      const first = { ...input.fragments[0]! };
      Object.defineProperty(first, "payload", {
        enumerable: true,
        get: () => input.fragments[0]!.payload,
      });
      return {
        ...input,
        fragments: [first, input.fragments[1]!],
      };
    }],
    ["typed-array view proxy", (input: GpuTransportAccessUnitObservationVerificationInput) => ({
      ...input,
      streamInstanceIdentity: new Proxy(input.streamInstanceIdentity, {}) as Uint8Array,
    })],
  ])("rejects adversarial %s shape", (_name, alter) => {
    const result = verifyGpuTransportAccessUnitObservation(alter(fixture()));
    expect(result.verified).toBe(false);
    expect(result.byteCommitmentsRecomputed).toBe(false);
    expect(result.acceptedForGpuHmr).toBe(false);
    expect(result.gpuHmrSuccess).toBe(false);
    expect(result.canSatisfyRuntimeProof).toBe(false);
  });
});
