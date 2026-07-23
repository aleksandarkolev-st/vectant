import { createHash } from "node:crypto";
import { constants as bufferConstants } from "node:buffer";
import { isProxy } from "node:util/types";
import { validatedUint8ArrayView } from "./validated_uint8_array.js";

export const GPU_MCP_OBSERVED_OUTPUT_BYTES_SCHEMA =
  "synthi.gpu_hmr.mcp_observed_output_bytes.v1" as const;
export const GPU_MCP_OBSERVED_OUTPUT_BYTES_AUTHORITY =
  "in_process_mcp_output_byte_source_observation_support_only_not_gpu_hmr_acceptance" as const;

const DEFAULT_MAX_PENDING_OBSERVATIONS = 1_024;
const MAX_PENDING_OBSERVATIONS = 65_536;
const DEFAULT_MAX_PENDING_BYTE_LENGTH = bufferConstants.MAX_LENGTH;
const MAX_PENDING_BYTE_LENGTH = Number.MAX_SAFE_INTEGER;
const DEFAULT_PENDING_OBSERVATION_TTL_MS = 30_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

declare const CONSUMER_CAPABILITY_BRAND: unique symbol;
declare const CONSUMER_CLAIM_BRAND: unique symbol;
declare const OBSERVATION_PERMIT_BRAND: unique symbol;

export interface GpuMcpObservedOutputBytes {
  readonly schemaVersion: typeof GPU_MCP_OBSERVED_OUTPUT_BYTES_SCHEMA;
  readonly proofAuthority: typeof GPU_MCP_OBSERVED_OUTPUT_BYTES_AUTHORITY;
  readonly outputContentSha256: string;
  readonly outputByteLength: string;
  readonly observedAtMonotonicNs: string;
  readonly outputBytesObserved: true;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuMcpOutputByteProducerCapability {
  observe(
    permit: GpuMcpOutputByteObservationPermit,
    outputBytes: Uint8Array,
  ): GpuMcpObservedOutputBytes;
  dispose(): boolean;
}

export interface GpuMcpOutputByteConsumerCapability {
  readonly [CONSUMER_CAPABILITY_BRAND]: never;
}

export interface GpuMcpOutputByteConsumerClaim {
  readonly [CONSUMER_CLAIM_BRAND]: never;
}

export interface GpuMcpOutputByteObservationPermit {
  readonly [OBSERVATION_PERMIT_BRAND]: never;
}

export interface GpuMcpTakenObservedOutputBytes {
  readonly bytes: Uint8Array;
  readonly permit: GpuMcpOutputByteObservationPermit;
  readonly observedAtMonotonicNs: bigint;
}

export interface GpuMcpOutputByteObservationBoundary {
  readonly producer: GpuMcpOutputByteProducerCapability;
  readonly consumer: GpuMcpOutputByteConsumerCapability;
}

export interface GpuMcpOutputByteObservationBoundaryOptions {
  readonly maxPendingObservations?: number;
  readonly maxPendingByteLength?: number;
  readonly pendingObservationTtlMs?: number;
}

interface PendingObservation {
  readonly bytes: Uint8Array;
  readonly accountedByteLength: number;
  readonly permit: GpuMcpOutputByteObservationPermit;
  readonly observedAtMonotonicNs: bigint;
  readonly expiresAtMonotonicNs: bigint;
}

interface BoundaryState {
  readonly observations: Map<object, PendingObservation>;
  readonly maxPendingObservations: number;
  readonly maxPendingByteLength: number;
  readonly pendingObservationTtlNs: bigint;
  pendingByteLength: number;
  producerActive: boolean;
  consumerActive: boolean;
  expiryTimer: NodeJS.Timeout | null;
}

interface ClaimState {
  readonly boundary: BoundaryState;
  readonly consumer: object;
  active: boolean;
}

interface PermitState {
  readonly claimHandle: object;
  readonly claim: ClaimState;
}

const consumerStates = new WeakMap<object, BoundaryState>();
const activeClaims = new WeakMap<object, object>();
const claimStates = new WeakMap<object, ClaimState>();
const permitStates = new WeakMap<object, PermitState>();

function boundedPositiveInteger(
  value: unknown,
  maximum: number,
): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= maximum;
}

function parseOptions(
  value: unknown,
): Required<GpuMcpOutputByteObservationBoundaryOptions> | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || isProxy(value)
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const allowedKeys = new Set([
      "maxPendingObservations",
      "maxPendingByteLength",
      "pendingObservationTtlMs",
    ]);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(
      (key) => typeof key !== "string" || !allowedKeys.has(key),
    )) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of ownKeys) {
      if (typeof key !== "string") return null;
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
    const maxPendingObservations =
      snapshot.maxPendingObservations
      ?? DEFAULT_MAX_PENDING_OBSERVATIONS;
    const pendingObservationTtlMs =
      snapshot.pendingObservationTtlMs
      ?? DEFAULT_PENDING_OBSERVATION_TTL_MS;
    const maxPendingByteLength =
      snapshot.maxPendingByteLength
      ?? DEFAULT_MAX_PENDING_BYTE_LENGTH;
    if (
      !boundedPositiveInteger(
        maxPendingObservations,
        MAX_PENDING_OBSERVATIONS,
      )
      || !boundedPositiveInteger(
        maxPendingByteLength,
        MAX_PENDING_BYTE_LENGTH,
      )
      || !boundedPositiveInteger(
        pendingObservationTtlMs,
        MAX_TIMER_DELAY_MS,
      )
    ) {
      return null;
    }
    return Object.freeze({
      maxPendingObservations,
      maxPendingByteLength,
      pendingObservationTtlMs,
    });
  } catch {
    return null;
  }
}

function consumerState(
  capability: unknown,
): BoundaryState | null {
  if (
    capability === null
    || typeof capability !== "object"
    || isProxy(capability)
  ) {
    return null;
  }
  return consumerStates.get(capability) ?? null;
}

function clearExpiryTimer(state: BoundaryState): void {
  if (state.expiryTimer === null) return;
  clearTimeout(state.expiryTimer);
  state.expiryTimer = null;
}

function pruneExpired(
  state: BoundaryState,
  nowMonotonicNs = process.hrtime.bigint(),
): void {
  for (const [token, pending] of state.observations) {
    if (pending.expiresAtMonotonicNs <= nowMonotonicNs) {
      state.observations.delete(token);
      state.pendingByteLength -= pending.accountedByteLength;
    }
  }
}

function scheduleExpiry(state: BoundaryState): void {
  clearExpiryTimer(state);
  if (
    !state.producerActive
    || !state.consumerActive
    || state.observations.size === 0
  ) {
    return;
  }
  let earliest: bigint | null = null;
  for (const pending of state.observations.values()) {
    if (
      earliest === null
      || pending.expiresAtMonotonicNs < earliest
    ) {
      earliest = pending.expiresAtMonotonicNs;
    }
  }
  if (earliest === null) return;
  const remainingNs = earliest - process.hrtime.bigint();
  const delayMs = Math.max(
    1,
    Math.min(
      MAX_TIMER_DELAY_MS,
      Number((remainingNs > 0n ? remainingNs : 0n) / 1_000_000n) + 1,
    ),
  );
  state.expiryTimer = setTimeout(() => {
    state.expiryTimer = null;
    pruneExpired(state);
    scheduleExpiry(state);
  }, delayMs);
  state.expiryTimer.unref?.();
}

function discardPending(state: BoundaryState): void {
  clearExpiryTimer(state);
  state.observations.clear();
  state.pendingByteLength = 0;
}

export function createGpuMcpOutputByteObservationBoundary(
  optionsValue: GpuMcpOutputByteObservationBoundaryOptions = {},
): GpuMcpOutputByteObservationBoundary {
  const options = parseOptions(optionsValue);
  if (options === null) {
    throw new Error(
      "gpu_mcp_output_byte_observation_boundary_options_invalid",
    );
  }
  const state: BoundaryState = {
    observations: new Map<object, PendingObservation>(),
    maxPendingObservations: options.maxPendingObservations,
    maxPendingByteLength: options.maxPendingByteLength,
    pendingObservationTtlNs:
      BigInt(options.pendingObservationTtlMs) * 1_000_000n,
    pendingByteLength: 0,
    producerActive: true,
    consumerActive: true,
    expiryTimer: null,
  };
  const consumer = Object.freeze(
    {},
  ) as GpuMcpOutputByteConsumerCapability;
  consumerStates.set(consumer, state);

  const producer = Object.freeze({
    observe: (
      permit: GpuMcpOutputByteObservationPermit,
      outputBytes: Uint8Array,
    ): GpuMcpObservedOutputBytes => {
      if (!state.producerActive || !state.consumerActive) {
        throw new Error(
          "gpu_mcp_output_byte_observation_producer_disposed",
        );
      }
      const permitState = permit !== null && typeof permit === "object"
        && !isProxy(permit)
        ? permitStates.get(permit)
        : undefined;
      if (
        permitState === undefined
        || permitState.claim.boundary !== state
        || !permitState.claim.active
        || activeClaims.get(permitState.claim.consumer)
          !== permitState.claimHandle
      ) {
        throw new Error(
          "gpu_mcp_output_byte_observation_permit_invalid",
        );
      }
      pruneExpired(state);
      if (
        state.observations.size
        >= state.maxPendingObservations
      ) {
        throw new Error(
          "gpu_mcp_output_byte_observation_capacity_exhausted",
        );
      }
      const bytes = validatedUint8ArrayView(outputBytes);
      if (bytes === null) {
        throw new Error(
          "gpu_mcp_output_byte_observation_bytes_invalid",
        );
      }
      if (
        bytes.byteLength
        > state.maxPendingByteLength - state.pendingByteLength
      ) {
        throw new Error(
          "gpu_mcp_output_byte_observation_byte_capacity_exhausted",
        );
      }
      permitStates.delete(permit);
      const observedAtMonotonicNs = process.hrtime.bigint();
      const observation = Object.freeze({
        schemaVersion: GPU_MCP_OBSERVED_OUTPUT_BYTES_SCHEMA,
        proofAuthority: GPU_MCP_OBSERVED_OUTPUT_BYTES_AUTHORITY,
        outputContentSha256:
          `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
        outputByteLength: String(bytes.byteLength),
        observedAtMonotonicNs: observedAtMonotonicNs.toString(),
        outputBytesObserved: true as const,
        acceptedForGpuHmr: false as const,
        gpuHmrSuccess: false as const,
        canSatisfyRuntimeProof: false as const,
      });
      state.observations.set(observation, {
        bytes,
        accountedByteLength: bytes.byteLength,
        permit,
        observedAtMonotonicNs,
        expiresAtMonotonicNs:
          observedAtMonotonicNs + state.pendingObservationTtlNs,
      });
      state.pendingByteLength += bytes.byteLength;
      scheduleExpiry(state);
      return observation;
    },
    dispose: (): boolean => {
      if (!state.producerActive) return false;
      state.producerActive = false;
      discardPending(state);
      return true;
    },
  });
  return Object.freeze({
    producer,
    consumer,
  });
}

export function claimGpuMcpOutputByteConsumerCapability(
  capability: unknown,
): GpuMcpOutputByteConsumerClaim | null {
  const state = consumerState(capability);
  if (
    state === null
    || !state.consumerActive
    || activeClaims.has(capability as object)
  ) {
    return null;
  }
  const claim = Object.freeze(
    {},
  ) as GpuMcpOutputByteConsumerClaim;
  const consumer = capability as object;
  activeClaims.set(consumer, claim);
  claimStates.set(claim, {
    boundary: state,
    consumer,
    active: true,
  });
  return claim;
}

export function issueGpuMcpOutputByteObservationPermit(
  claim: GpuMcpOutputByteConsumerClaim,
): GpuMcpOutputByteObservationPermit | null {
  if (
    claim === null
    || typeof claim !== "object"
    || isProxy(claim)
  ) {
    return null;
  }
  const claimState = claimStates.get(claim);
  if (
    claimState === undefined
    || !claimState.active
    || !claimState.boundary.producerActive
    || !claimState.boundary.consumerActive
    || activeClaims.get(claimState.consumer) !== claim
  ) {
    return null;
  }
  const permit = Object.freeze(
    {},
  ) as GpuMcpOutputByteObservationPermit;
  permitStates.set(permit, {
    claimHandle: claim,
    claim: claimState,
  });
  return permit;
}

export function releaseGpuMcpOutputByteConsumerClaim(
  claim: unknown,
): boolean {
  if (
    claim === null
    || typeof claim !== "object"
    || isProxy(claim)
  ) {
    return false;
  }
  const state = claimStates.get(claim);
  if (state === undefined || !state.active) return false;
  state.active = false;
  if (activeClaims.get(state.consumer) === claim) {
    activeClaims.delete(state.consumer);
  }
  discardPending(state.boundary);
  return true;
}

export function takeGpuMcpObservedOutputBytes(
  claim: GpuMcpOutputByteConsumerClaim,
  observation: unknown,
): GpuMcpTakenObservedOutputBytes | null {
  if (
    claim === null
    || typeof claim !== "object"
    || isProxy(claim)
  ) {
    return null;
  }
  const claimState = claimStates.get(claim);
  if (
    claimState === undefined
    || !claimState.active
    || activeClaims.get(claimState.consumer) !== claim
    || !claimState.boundary.consumerActive
    || observation === null
    || typeof observation !== "object"
    || isProxy(observation)
  ) {
    return null;
  }
  const boundary = claimState.boundary;
  pruneExpired(boundary);
  const pending = boundary.observations.get(observation);
  if (pending === undefined) {
    scheduleExpiry(boundary);
    return null;
  }
  boundary.observations.delete(observation);
  boundary.pendingByteLength -= pending.accountedByteLength;
  scheduleExpiry(boundary);
  return Object.freeze({
    bytes: pending.bytes,
    permit: pending.permit,
    observedAtMonotonicNs: pending.observedAtMonotonicNs,
  });
}

export function disposeGpuMcpOutputByteConsumerClaim(
  claim: GpuMcpOutputByteConsumerClaim,
): boolean {
  if (
    claim === null
    || typeof claim !== "object"
    || isProxy(claim)
  ) {
    return false;
  }
  const claimState = claimStates.get(claim);
  if (claimState === undefined || !claimState.active) return false;
  claimState.active = false;
  if (activeClaims.get(claimState.consumer) === claim) {
    activeClaims.delete(claimState.consumer);
  }
  claimState.boundary.consumerActive = false;
  claimState.boundary.producerActive = false;
  discardPending(claimState.boundary);
  return true;
}
