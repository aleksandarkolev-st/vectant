import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  GPU_MCP_OBSERVED_OUTPUT_BYTES_AUTHORITY,
  GPU_MCP_OBSERVED_OUTPUT_BYTES_SCHEMA,
  claimGpuMcpOutputByteConsumerCapability,
  createGpuMcpOutputByteObservationBoundary,
  disposeGpuMcpOutputByteConsumerClaim,
  issueGpuMcpOutputByteObservationPermit,
  releaseGpuMcpOutputByteConsumerClaim,
  takeGpuMcpObservedOutputBytes,
} from "../../src/gpu_mcp_output_byte_observation_boundary.js";

function contentHash(bytes: Uint8Array): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function readyBoundary(
  options: Parameters<
    typeof createGpuMcpOutputByteObservationBoundary
  >[0] = {},
) {
  const boundary = createGpuMcpOutputByteObservationBoundary(options);
  const claim = claimGpuMcpOutputByteConsumerCapability(
    boundary.consumer,
  );
  if (claim === null) throw new Error("consumer claim unavailable");
  const permit = issueGpuMcpOutputByteObservationPermit(claim);
  if (permit === null) throw new Error("observation permit unavailable");
  return { boundary, claim, permit };
}

function nextPermit(
  claim: ReturnType<typeof claimGpuMcpOutputByteConsumerCapability>,
) {
  if (claim === null) throw new Error("consumer claim unavailable");
  const permit = issueGpuMcpOutputByteObservationPermit(claim);
  if (permit === null) throw new Error("observation permit unavailable");
  return permit;
}

describe("GPU MCP output byte observation boundary", () => {
  it("binds arbitrary byte sequences behind a one-shot opaque token", () => {
    const { boundary, claim, permit } = readyBoundary();
    const sourceBytes = Uint8Array.of(0, 7, 19, 255);
    const expectedHash = contentHash(sourceBytes);
    const observation = boundary.producer.observe(permit, sourceBytes);

    expect(observation).toEqual({
      schemaVersion: GPU_MCP_OBSERVED_OUTPUT_BYTES_SCHEMA,
      proofAuthority: GPU_MCP_OBSERVED_OUTPUT_BYTES_AUTHORITY,
      outputContentSha256: expectedHash,
      outputByteLength: "4",
      observedAtMonotonicNs: observation.observedAtMonotonicNs,
      outputBytesObserved: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(observation)).toBe(true);
    expect(() => boundary.producer.observe(
      permit,
      Uint8Array.of(1),
    )).toThrow("gpu_mcp_output_byte_observation_permit_invalid");
    const consumed = takeGpuMcpObservedOutputBytes(
      claim,
      observation,
    );
    expect(consumed).toMatchObject({
      bytes: Uint8Array.of(0, 7, 19, 255),
      permit,
      observedAtMonotonicNs:
        BigInt(observation.observedAtMonotonicNs),
    });
    expect(takeGpuMcpObservedOutputBytes(
      claim,
      observation,
    )).toBeNull();
  });

  it("bounds pending observations and expires them on a monotonic timer", async () => {
    const { boundary, claim, permit } = readyBoundary({
      maxPendingObservations: 1,
      maxPendingByteLength: 3,
      pendingObservationTtlMs: 5,
    });
    const expired = boundary.producer.observe(
      permit,
      Uint8Array.of(1),
    );
    const pendingPermit = nextPermit(claim);
    expect(() => boundary.producer.observe(
      pendingPermit,
      Uint8Array.of(2),
    )).toThrow(
      "gpu_mcp_output_byte_observation_capacity_exhausted",
    );

    await new Promise((resolve) => setTimeout(resolve, 20));
    const current = boundary.producer.observe(
      pendingPermit,
      Uint8Array.of(3),
    );
    expect(takeGpuMcpObservedOutputBytes(claim, expired)).toBeNull();
    expect(takeGpuMcpObservedOutputBytes(claim, current))
      .toMatchObject({ bytes: Uint8Array.of(3) });
  });

  it("enforces a generic aggregate pending-byte budget", () => {
    const { boundary, claim, permit } = readyBoundary({
      maxPendingObservations: 4,
      maxPendingByteLength: 3,
    });
    const first = boundary.producer.observe(
      permit,
      Uint8Array.of(1, 2),
    );
    const secondPermit = nextPermit(claim);
    expect(() => boundary.producer.observe(
      secondPermit,
      Uint8Array.of(3, 4),
    )).toThrow(
      "gpu_mcp_output_byte_observation_byte_capacity_exhausted",
    );
    expect(takeGpuMcpObservedOutputBytes(claim, first))
      .toMatchObject({ bytes: Uint8Array.of(1, 2) });
    expect(() => boundary.producer.observe(
      secondPermit,
      Uint8Array.of(3, 4),
    )).not.toThrow();
  });

  it("releases the original budget charge after source-buffer detachment", () => {
    const { boundary, claim, permit } = readyBoundary({
      maxPendingObservations: 2,
      maxPendingByteLength: 3,
    });
    const buffer = new ArrayBuffer(3);
    const bytes = new Uint8Array(buffer);
    bytes.set([1, 2, 3]);
    const observation = boundary.producer.observe(permit, bytes);
    structuredClone(buffer, { transfer: [buffer] });
    expect(bytes.byteLength).toBe(0);

    const detachedObservation = takeGpuMcpObservedOutputBytes(
      claim,
      observation,
    );
    expect(detachedObservation).not.toBeNull();
    expect(detachedObservation?.bytes.byteLength).toBe(0);
    expect(() => boundary.producer.observe(
      nextPermit(claim),
      Uint8Array.of(4, 5, 6),
    )).not.toThrow();
  });

  it("accepts an empty byte sequence without inventing an output category", () => {
    const { boundary, permit } = readyBoundary();
    const observation = boundary.producer.observe(
      permit,
      new Uint8Array(),
    );

    expect(observation.outputByteLength).toBe("0");
    expect(observation.outputContentSha256)
      .toBe(contentHash(new Uint8Array()));
    expect(JSON.stringify(observation)).not.toMatch(
      /project|profile|fixture|scenario|backend|camera|image|tensor|media/i,
    );
  });

  it("rejects cloned, serialized, foreign, and raw-byte lookalikes", () => {
    const {
      boundary: first,
      claim: firstClaim,
      permit: firstPermit,
    } = readyBoundary();
    const {
      boundary: second,
      permit: secondPermit,
    } = readyBoundary();
    const observation = first.producer.observe(
      firstPermit,
      Uint8Array.of(1, 2, 3),
    );

    for (const candidate of [
      { ...observation },
      JSON.parse(JSON.stringify(observation)),
      Uint8Array.of(1, 2, 3),
      second.producer.observe(
        secondPermit,
        Uint8Array.of(1, 2, 3),
      ),
    ]) {
      expect(takeGpuMcpObservedOutputBytes(
        firstClaim,
        candidate,
      )).toBeNull();
    }
    expect(takeGpuMcpObservedOutputBytes(
      firstClaim,
      observation,
    )).toMatchObject({ bytes: Uint8Array.of(1, 2, 3) });
  });

  it("rejects unsupported or shared byte views without invoking proxy traps", () => {
    const { boundary, permit } = readyBoundary();
    let trapCalls = 0;
    const failTrap = (): never => {
      trapCalls += 1;
      throw new Error("byte proxy trap must not run");
    };
    const proxy = new Proxy(Uint8Array.of(1), {
      get: failTrap,
      getOwnPropertyDescriptor: failTrap,
      getPrototypeOf: failTrap,
      ownKeys: failTrap,
    });

    for (const bytes of [
      proxy,
      new Uint16Array([1]),
      new Uint8Array(new SharedArrayBuffer(4)),
    ]) {
      expect(() => boundary.producer.observe(
        permit,
        bytes as Uint8Array,
      ))
        .toThrow("gpu_mcp_output_byte_observation_bytes_invalid");
    }
    expect(trapCalls).toBe(0);
    expect(() => boundary.producer.observe(
      permit,
      Uint8Array.of(1),
    )).not.toThrow();
  });

  it("allows exactly one authority claim while keeping the consumer opaque", () => {
    const boundary = createGpuMcpOutputByteObservationBoundary();

    expect(Object.keys(boundary.consumer)).toEqual([]);
    expect(JSON.stringify(boundary.consumer)).toBe("{}");
    const firstClaim = claimGpuMcpOutputByteConsumerCapability(
      boundary.consumer,
    );
    expect(firstClaim).not.toBeNull();
    if (firstClaim === null) throw new Error("consumer claim unavailable");
    const firstPermit = issueGpuMcpOutputByteObservationPermit(
      firstClaim,
    );
    if (firstPermit === null) throw new Error("observation permit unavailable");
    const pending = boundary.producer.observe(
      firstPermit,
      Uint8Array.of(8),
    );
    expect(takeGpuMcpObservedOutputBytes(
      boundary.consumer as never,
      pending,
    )).toBeNull();
    expect(claimGpuMcpOutputByteConsumerCapability(
      boundary.consumer,
    )).toBeNull();
    expect(takeGpuMcpObservedOutputBytes(
      { ...firstClaim } as never,
      pending,
    )).toBeNull();
    expect(takeGpuMcpObservedOutputBytes(
      firstClaim,
      pending,
    )).toMatchObject({ bytes: Uint8Array.of(8) });
    expect(claimGpuMcpOutputByteConsumerCapability(
      { ...boundary.consumer },
    )).toBeNull();
    expect(releaseGpuMcpOutputByteConsumerClaim(
      boundary.consumer,
    )).toBe(false);
    expect(releaseGpuMcpOutputByteConsumerClaim(
      firstClaim,
    )).toBe(true);
    expect(() => boundary.producer.observe(
      firstPermit,
      Uint8Array.of(9),
    )).toThrow("gpu_mcp_output_byte_observation_permit_invalid");
    const secondClaim = claimGpuMcpOutputByteConsumerCapability(
      boundary.consumer,
    );
    expect(secondClaim).not.toBeNull();
    expect(issueGpuMcpOutputByteObservationPermit(
      { ...firstClaim } as never,
    )).toBeNull();
  });

  it("does not carry pending observations across claim generations", () => {
    const { boundary, claim, permit } = readyBoundary({
      maxPendingObservations: 1,
      maxPendingByteLength: 1,
    });
    const priorGeneration = boundary.producer.observe(
      permit,
      Uint8Array.of(7),
    );

    expect(releaseGpuMcpOutputByteConsumerClaim(claim)).toBe(true);
    const nextClaim = claimGpuMcpOutputByteConsumerCapability(
      boundary.consumer,
    );
    expect(nextClaim).not.toBeNull();
    if (nextClaim === null) throw new Error("consumer claim unavailable");
    expect(takeGpuMcpObservedOutputBytes(
      nextClaim,
      priorGeneration,
    )).toBeNull();
    const current = boundary.producer.observe(
      nextPermit(nextClaim),
      Uint8Array.of(8),
    );
    expect(takeGpuMcpObservedOutputBytes(
      nextClaim,
      current,
    )).toMatchObject({ bytes: Uint8Array.of(8) });
  });

  it("retires both sides when the consumer is disposed", () => {
    const { boundary, claim, permit } = readyBoundary();
    const pending = boundary.producer.observe(
      permit,
      Uint8Array.of(9),
    );

    expect(disposeGpuMcpOutputByteConsumerClaim(
      claim,
    )).toBe(true);
    expect(disposeGpuMcpOutputByteConsumerClaim(
      claim,
    )).toBe(false);
    expect(takeGpuMcpObservedOutputBytes(
      claim,
      pending,
    )).toBeNull();
    expect(() => boundary.producer.observe(
      permit,
      Uint8Array.of(10),
    )).toThrow(
      "gpu_mcp_output_byte_observation_producer_disposed",
    );
    expect(boundary.producer.dispose()).toBe(false);
  });
});
