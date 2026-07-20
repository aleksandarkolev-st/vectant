import { createHash, randomBytes } from "node:crypto";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE,
  verifyGpuParentRuntimeProofControlBinding,
  type GpuParentRuntimeProofControlBindingReceiptConsumer,
} from "./gpu_parent_runtime_proof_control_binding.js";
import {
  verifyGpuParentRuntimeProofTransport,
  type GpuParentRuntimeProofExpectedBinding,
  type GpuParentRuntimeProofReceiptConsumer,
} from "./gpu_parent_runtime_proof.js";
import type {
  RuntimeEvidenceTransportKeyPin,
  RuntimeEvidenceTransportVerificationKey,
} from "./runtime_evidence_transport.js";

const COMPILE_NONCE_PREFIX = "gpu-proof-transport-request:";
const COMPILE_CORRELATION_PREFIX = "gpu-proof-compile-correlation:";
const FULL_RUNTIME_STATE = "gpu-hmr-full-runtime-proven";
const GPU_PROOF_TYPE = "gpu_hmr_proof";
const GPU_PROOF_STATUS = "gpu-proof-state";
const DEFAULT_MAX_PENDING_INTENTS = 64;
const DEFAULT_MAX_VERIFIED_BINDINGS = 64;
const DEFAULT_MAX_ISSUED_NONCES = 4_096;
const DEFAULT_INTENT_TTL_MS = 30 * 60_000;
const DEFAULT_BINDING_TTL_MS = 5 * 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

export const GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION =
  "synthi.gpu_hmr.parent_control_verification_material.v1";

export type GpuParentRuntimeProofAdmissionReceiptConsumer =
  GpuParentRuntimeProofControlBindingReceiptConsumer
  & GpuParentRuntimeProofReceiptConsumer;

export interface GpuParentRuntimeProofAdmissionLimits {
  readonly maxPendingIntents?: number;
  readonly maxVerifiedBindings?: number;
  readonly maxIssuedNonces?: number;
  readonly intentTtlMs?: number;
  readonly bindingTtlMs?: number;
}

export interface GpuParentRuntimeProofAdmissionContext {
  readonly transportSessionId: string;
  readonly keyPin: RuntimeEvidenceTransportKeyPin;
  readonly receiptConsumer: GpuParentRuntimeProofAdmissionReceiptConsumer;
  readonly limits?: GpuParentRuntimeProofAdmissionLimits;
  readonly now?: () => number;
  readonly nonceBytes?: () => Uint8Array;
}

export interface GpuParentRuntimeProofCompileIntent {
  readonly compileRequestNonce: string;
  readonly correlationId: string;
  readonly computeExpectedOutputContractHash: string | null;
  readonly computeExpectedOutputSemanticsHash: string | null;
}

export interface GpuParentRuntimeProofControlVerificationTransportContext {
  readonly transportSessionId: string;
  readonly compileRequestNonce: string;
  readonly expectedWorkerProcessId: string;
}

export interface GpuParentRuntimeProofControlVerificationMaterial {
  readonly schemaVersion:
    typeof GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION;
  readonly controlBinding: Readonly<Record<string, unknown>>;
  readonly runtimeEvidenceTransportVerificationKey:
    RuntimeEvidenceTransportVerificationKey;
  readonly transportContext:
    GpuParentRuntimeProofControlVerificationTransportContext;
}

export type GpuParentRuntimeProofTrustInvalidationReason =
  | "runtime_evidence_transport_failed"
  | "runtime_evidence_transport_disposed";

export interface GpuParentRuntimeProofAdmissionSnapshot {
  readonly schemaVersion: "synthi.gpu_hmr.parent_runtime_proof_admission_snapshot.v1";
  readonly proofAuthority: "session_admission_diagnostics_only_not_gpu_hmr_acceptance";
  readonly status: "active" | "failed" | "disposed";
  readonly pendingIntentCount: number;
  readonly verifiedBindingCount: number;
  readonly admittedProofCount: number;
  readonly lastDecisionCode: string | null;
  readonly failureReason: string | null;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

interface PendingIntent {
  readonly compileRequestNonce: string;
  readonly correlationId: string;
  readonly computeExpectedOutputContractHash: string | null;
  readonly computeExpectedOutputSemanticsHash: string | null;
  readonly expiresAt: number;
}

interface VerifiedBinding {
  readonly bindingId: string;
  readonly expectedBinding: GpuParentRuntimeProofExpectedBinding;
  readonly protectedProofJsonSha256: string;
  readonly canonicalProofSha256: string;
  readonly controlBinding: Readonly<Record<string, unknown>>;
  readonly runtimeEvidenceTransportVerificationKey:
    RuntimeEvidenceTransportVerificationKey;
  readonly transportContext:
    GpuParentRuntimeProofControlVerificationTransportContext;
  readonly expiresAt: number;
}

interface RetainedControlVerificationMaterial {
  readonly material: GpuParentRuntimeProofControlVerificationMaterial;
  readonly requestId: string;
  readonly expiresAt: number;
}

interface OwnEnumerableDataProperty {
  readonly present: boolean;
  readonly value: unknown;
}

type ControlIdentityKind = "fullRuntimeProofId" | "requestId";

function positiveBoundedInteger(
  value: unknown,
  fallback: number,
  maximum: number,
): number {
  if (value === undefined) return fallback;
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value < 1
    || value > maximum
  ) {
    throw new Error("gpu_parent_runtime_proof_admission_limit_invalid");
  }
  return value;
}

function canonicalToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function validCompileRequestNonce(value: unknown): value is string {
  return typeof value === "string"
    && /^gpu-proof-transport-request:[a-f0-9]{32}$/.test(value);
}

function validOptionalCanonicalSha256(
  value: unknown,
): value is string | null {
  return value === null
    || (typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value));
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (
    value === null
    || typeof value !== "object"
    || Array.isArray(value)
    || Object.getPrototypeOf(value) !== Object.prototype
  ) {
    return null;
  }
  return value as Record<string, unknown>;
}

function ownEnumerableDataProperty(
  value: object,
  key: string,
): OwnEnumerableDataProperty | null {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) return { present: false, value: undefined };
    if (!("value" in descriptor) || descriptor.enumerable !== true) return null;
    return { present: true, value: descriptor.value };
  } catch {
    return null;
  }
}

function correlationId(transportSessionId: string, nonce: string): string {
  const digest = createHash("sha256")
    .update("synthi.gpu_hmr.compile_correlation.v1\0")
    .update(transportSessionId)
    .update("\0")
    .update(nonce)
    .digest("hex");
  return `${COMPILE_CORRELATION_PREFIX}sha256:${digest}`;
}

function nonceHistoryKey(nonce: string): string {
  return createHash("sha256")
    .update("synthi.gpu_hmr.compile_nonce_history.v1\0")
    .update(nonce)
    .digest("hex");
}

function controlIdentityHistoryKey(
  kind: ControlIdentityKind,
  value: string,
): string {
  return `${kind}\0${value}`;
}

function freezeExpectedBinding(
  value: GpuParentRuntimeProofExpectedBinding,
): GpuParentRuntimeProofExpectedBinding {
  return Object.freeze({
    ...value,
    prepublicationOutputOracleCommitment:
      value.prepublicationOutputOracleCommitment === null
        ? null
        : Object.freeze({ ...value.prepublicationOutputOracleCommitment }),
  });
}

function deepFreeze<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object") return value;
  if (seen.has(value)) return value;
  seen.add(value);
  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("gpu_parent_runtime_proof_data_accessor_rejected");
    }
    deepFreeze(descriptor.value, seen);
  }
  if (!Object.isFrozen(value)) Object.freeze(value);
  if (!Object.isFrozen(value)) {
    throw new TypeError("gpu_parent_runtime_proof_data_freeze_failed");
  }
  return value;
}

function cloneAndDeepFreeze<T>(value: T): T {
  return deepFreeze(structuredClone(value));
}

function assertParsedDataGraph(
  value: unknown,
  seen = new WeakSet<object>(),
): void {
  if (
    value === null
    || typeof value === "string"
    || typeof value === "number"
    || typeof value === "boolean"
  ) {
    return;
  }
  if (typeof value !== "object") {
    throw new TypeError("gpu_parent_runtime_proof_non_data_value_rejected");
  }
  if (seen.has(value)) {
    throw new TypeError("gpu_parent_runtime_proof_repeated_data_reference_rejected");
  }
  seen.add(value);
  const array = Array.isArray(value);
  const prototype = Object.getPrototypeOf(value);
  if (
    (array && prototype !== Array.prototype)
    || (!array && prototype !== Object.prototype)
  ) {
    throw new TypeError("gpu_parent_runtime_proof_non_plain_data_rejected");
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== "string") {
      throw new TypeError("gpu_parent_runtime_proof_symbol_data_rejected");
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError("gpu_parent_runtime_proof_data_accessor_rejected");
    }
    if (array && key === "length") continue;
    if (descriptor.enumerable !== true) {
      throw new TypeError("gpu_parent_runtime_proof_non_enumerable_data_rejected");
    }
    assertParsedDataGraph(descriptor.value, seen);
  }
}

function freezeParsedParentMessage(value: Record<string, unknown>): boolean {
  try {
    assertParsedDataGraph(value);
    structuredClone(value);
    deepFreeze(value);
    return true;
  } catch {
    return false;
  }
}

function sameTransportVerificationKey(
  left: RuntimeEvidenceTransportVerificationKey,
  right: RuntimeEvidenceTransportVerificationKey,
): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.algorithm === right.algorithm
    && left.keyId === right.keyId
    && left.producer === right.producer
    && left.workerInstanceId === right.workerInstanceId
    && left.workerProcessId === right.workerProcessId
    && left.publicKey === right.publicKey
    && left.keyAnnouncementId === right.keyAnnouncementId;
}

export class SessionGpuParentRuntimeProofAdmission {
  private readonly transportSessionId: string;
  private readonly keyPin: RuntimeEvidenceTransportKeyPin;
  private readonly receiptConsumer: GpuParentRuntimeProofAdmissionReceiptConsumer;
  private readonly now: () => number;
  private readonly nonceBytes: () => Uint8Array;
  private readonly maxPendingIntents: number;
  private readonly maxVerifiedBindings: number;
  private readonly maxIssuedNonces: number;
  private readonly intentTtlMs: number;
  private readonly bindingTtlMs: number;
  private readonly pendingIntents = new Map<string, PendingIntent>();
  private readonly issuedNonceHashes = new Set<string>();
  private readonly admittedControlIdentityHistory = new Set<string>();
  private readonly bindingsByProofId = new Map<string, VerifiedBinding>();
  private readonly reservedProofIdByRequestId = new Map<string, string>();
  private readonly retainedControlVerificationMaterials =
    new Map<string, RetainedControlVerificationMaterial>();
  private readonly controlNoncesInFlight = new Set<string>();
  private readonly parentProofIdsInFlight = new Set<string>();
  private disposed = false;
  private failureReason: string | null = null;
  private lastDecisionCode: string | null = null;
  private admittedProofCount = 0;

  constructor(context: GpuParentRuntimeProofAdmissionContext) {
    if (!canonicalToken(context.transportSessionId)) {
      throw new Error("gpu_parent_runtime_proof_admission_session_invalid");
    }
    this.transportSessionId = context.transportSessionId;
    this.keyPin = context.keyPin;
    this.receiptConsumer = context.receiptConsumer;
    this.now = context.now ?? Date.now;
    this.nonceBytes = context.nonceBytes ?? (() => randomBytes(16));
    const limits = context.limits ?? {};
    this.maxPendingIntents = positiveBoundedInteger(
      limits.maxPendingIntents,
      DEFAULT_MAX_PENDING_INTENTS,
      65_536,
    );
    this.maxVerifiedBindings = positiveBoundedInteger(
      limits.maxVerifiedBindings,
      DEFAULT_MAX_VERIFIED_BINDINGS,
      65_536,
    );
    this.maxIssuedNonces = positiveBoundedInteger(
      limits.maxIssuedNonces,
      DEFAULT_MAX_ISSUED_NONCES,
      1_000_000,
    );
    this.intentTtlMs = positiveBoundedInteger(
      limits.intentTtlMs,
      DEFAULT_INTENT_TTL_MS,
      MAX_TIMER_DELAY_MS,
    );
    this.bindingTtlMs = positiveBoundedInteger(
      limits.bindingTtlMs,
      DEFAULT_BINDING_TTL_MS,
      MAX_TIMER_DELAY_MS,
    );
  }

  issueCompileIntent(
    computeExpectedOutputContractHash: string | null = null,
    computeExpectedOutputSemanticsHash: string | null = null,
  ): GpuParentRuntimeProofCompileIntent {
    this.assertActive();
    if (!validOptionalCanonicalSha256(computeExpectedOutputContractHash)) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_expected_output_contract_hash_invalid",
      );
    }
    if (!validOptionalCanonicalSha256(computeExpectedOutputSemanticsHash)) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_expected_output_semantics_hash_invalid",
      );
    }
    const now = this.currentTime();
    this.prune(now);
    if (this.pendingIntents.size >= this.maxPendingIntents) {
      throw new Error("gpu_parent_runtime_proof_admission_intent_capacity_exhausted");
    }
    if (this.issuedNonceHashes.size >= this.maxIssuedNonces) {
      throw new Error("gpu_parent_runtime_proof_admission_nonce_history_exhausted");
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const bytes = this.nonceBytes();
      try {
        if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 16) {
          throw new Error("gpu_parent_runtime_proof_admission_nonce_source_invalid");
        }
        const nonce = `${COMPILE_NONCE_PREFIX}${Buffer.from(bytes).toString("hex")}`;
        const nonceHash = nonceHistoryKey(nonce);
        if (!validCompileRequestNonce(nonce) || this.issuedNonceHashes.has(nonceHash)) continue;
        const intent = Object.freeze({
          compileRequestNonce: nonce,
          correlationId: correlationId(this.transportSessionId, nonce),
          computeExpectedOutputContractHash,
          computeExpectedOutputSemanticsHash,
          expiresAt: now + this.intentTtlMs,
        });
        this.issuedNonceHashes.add(nonceHash);
        this.pendingIntents.set(nonce, intent);
        this.lastDecisionCode = "gpu_parent_runtime_proof_compile_intent_issued";
        return Object.freeze({
          compileRequestNonce: intent.compileRequestNonce,
          correlationId: intent.correlationId,
          computeExpectedOutputContractHash:
            intent.computeExpectedOutputContractHash,
          computeExpectedOutputSemanticsHash:
            intent.computeExpectedOutputSemanticsHash,
        });
      } finally {
        bytes.fill(0);
      }
    }
    throw new Error("gpu_parent_runtime_proof_admission_nonce_collision");
  }

  cancelCompileIntent(compileRequestNonce: string): void {
    if (!validCompileRequestNonce(compileRequestNonce)) return;
    if (this.pendingIntents.delete(compileRequestNonce)) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_compile_intent_cancelled";
    }
  }

  takeControlVerificationMaterial(
    fullRuntimeProofId: string,
  ): GpuParentRuntimeProofControlVerificationMaterial | null {
    if (this.disposed || this.failureReason !== null) return null;
    this.prune(this.currentTime());
    const retained = this.retainedControlVerificationMaterials.get(
      fullRuntimeProofId,
    );
    if (retained === undefined) return null;
    this.retainedControlVerificationMaterials.delete(fullRuntimeProofId);
    this.releaseRequestIdReservation(retained.requestId, fullRuntimeProofId);
    return retained.material;
  }

  invalidateTrust(reason: GpuParentRuntimeProofTrustInvalidationReason): void {
    if (this.disposed || this.failureReason !== null) return;
    this.fail(`gpu_parent_runtime_proof_admission_${reason}`);
  }

  beforeClassify(message: Record<string, unknown>, _observedAt: number): boolean {
    if (this.disposed) return false;
    const now = this.currentTime();
    this.prune(now);

    const typeProperty = ownEnumerableDataProperty(message, "type");
    if (typeProperty === null) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_message_data_shape_invalid";
      return false;
    }
    if (typeProperty.value === GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE) {
      this.consumeControlBinding(message);
      return false;
    }

    const statusProperty = ownEnumerableDataProperty(message, "status");
    const resultStateProperty = ownEnumerableDataProperty(message, "resultState");
    const resultStateAliasProperty = ownEnumerableDataProperty(
      message,
      "result_state",
    );
    const parentProperty = ownEnumerableDataProperty(message, "parentVerification");
    const parentAliasProperty = ownEnumerableDataProperty(
      message,
      "parent_verification",
    );
    if (
      statusProperty === null
      || resultStateProperty === null
      || resultStateAliasProperty === null
      || parentProperty === null
      || parentAliasProperty === null
    ) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_message_data_shape_invalid";
      return false;
    }
    const stateCandidate = resultStateProperty.value
      ?? resultStateAliasProperty.value;
    const state = typeof stateCandidate === "string" ? stateCandidate : null;
    const hasParent = parentProperty.present;
    const hasRejectedParentAlias = parentAliasProperty.present;
    const typedProof = typeProperty.value === GPU_PROOF_TYPE;
    const statusProof = statusProperty.value === GPU_PROOF_STATUS;
    const reservedFullRuntimeClaim = state === FULL_RUNTIME_STATE && (typedProof || statusProof);

    if (hasRejectedParentAlias) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_parent_alias_suppressed";
      return false;
    }
    if (hasParent && !typedProof) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_parent_on_untyped_message_suppressed";
      return false;
    }
    if (typedProof && hasParent) {
      if (state !== FULL_RUNTIME_STATE) {
        this.lastDecisionCode = "gpu_parent_runtime_proof_parent_state_invalid";
        return false;
      }
      return this.consumeParentProof(message);
    }
    if (reservedFullRuntimeClaim) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_unbound_full_runtime_claim_suppressed";
      return false;
    }
    return true;
  }

  snapshot(): GpuParentRuntimeProofAdmissionSnapshot {
    this.prune(this.currentTime());
    return Object.freeze({
      schemaVersion: "synthi.gpu_hmr.parent_runtime_proof_admission_snapshot.v1",
      proofAuthority: "session_admission_diagnostics_only_not_gpu_hmr_acceptance",
      status: this.disposed ? "disposed" : this.failureReason === null ? "active" : "failed",
      pendingIntentCount: this.pendingIntents.size,
      verifiedBindingCount: this.bindingsByProofId.size,
      admittedProofCount: this.admittedProofCount,
      lastDecisionCode: this.lastDecisionCode,
      failureReason: this.failureReason,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.pendingIntents.clear();
    this.issuedNonceHashes.clear();
    this.admittedControlIdentityHistory.clear();
    this.bindingsByProofId.clear();
    this.reservedProofIdByRequestId.clear();
    this.retainedControlVerificationMaterials.clear();
    this.controlNoncesInFlight.clear();
    this.parentProofIdsInFlight.clear();
    this.disposed = true;
    this.lastDecisionCode = "gpu_parent_runtime_proof_admission_disposed";
  }

  private consumeControlBinding(
    message: Record<string, unknown>,
  ): void {
    if (this.failureReason !== null) return;
    const nonceProperty = ownEnumerableDataProperty(
      message,
      "compileRequestNonce",
    );
    const nonce = nonceProperty?.present === true
      ? nonceProperty.value
      : undefined;
    if (!validCompileRequestNonce(nonce) || !this.pendingIntents.has(nonce)) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_control_without_live_intent";
      return;
    }
    const pendingIntent = this.pendingIntents.get(nonce);
    if (pendingIntent === undefined) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_control_without_live_intent";
      return;
    }
    if (this.controlNoncesInFlight.has(nonce)) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_control_reentry_suppressed";
      return;
    }
    const pin = this.keyPin.snapshot();
    if (pin.status !== "pinned" || pin.key === null) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_control_key_not_pinned";
      return;
    }
    if (this.reservedCapsuleCount() >= this.maxVerifiedBindings) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_binding_capacity_exhausted";
      return;
    }

    let controlBinding: Readonly<Record<string, unknown>>;
    let runtimeEvidenceTransportVerificationKey:
      RuntimeEvidenceTransportVerificationKey;
    try {
      controlBinding = cloneAndDeepFreeze(message);
      runtimeEvidenceTransportVerificationKey = cloneAndDeepFreeze(pin.key);
    } catch {
      this.lastDecisionCode =
        "gpu_parent_runtime_proof_control_verification_material_capture_failed";
      return;
    }
    const transportContext = deepFreeze({
      transportSessionId: this.transportSessionId,
      compileRequestNonce: nonce,
      expectedWorkerProcessId: pin.key.workerProcessId,
    });

    let validation: ReturnType<typeof verifyGpuParentRuntimeProofControlBinding>;
    this.controlNoncesInFlight.add(nonce);
    try {
      validation = verifyGpuParentRuntimeProofControlBinding(controlBinding, {
        transportSessionId: this.transportSessionId,
        compileRequestNonce: nonce,
        expectedWorkerProcessId: pin.key.workerProcessId,
        receiptConsumer: this.receiptConsumer,
      });
    } finally {
      this.controlNoncesInFlight.delete(nonce);
    }
    if (!this.isActive()) return;
    if (!validation.verified) {
      this.lastDecisionCode = validation.code;
      return;
    }
    const commitNow = this.currentTime();
    this.prune(commitNow);
    if (!this.isActive()) return;
    if (this.pendingIntents.get(nonce) !== pendingIntent) {
      this.lastDecisionCode =
        "gpu_parent_runtime_proof_control_transaction_state_changed";
      return;
    }
    const currentPin = this.keyPin.snapshot();
    if (currentPin.status !== "pinned" || currentPin.key === null) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_control_key_not_pinned";
      return;
    }
    if (!sameTransportVerificationKey(
      currentPin.key,
      runtimeEvidenceTransportVerificationKey,
    )) {
      this.fail("gpu_parent_runtime_proof_transport_verification_key_changed");
      return;
    }
    if (
      validation.computeExpectedOutputContractHash
      !== pendingIntent.computeExpectedOutputContractHash
    ) {
      this.fail(
        "gpu_parent_runtime_proof_authenticated_expected_output_contract_hash_mismatch",
      );
      return;
    }
    if (
      validation.computeExpectedOutputSemanticsHash
      !== pendingIntent.computeExpectedOutputSemanticsHash
    ) {
      this.fail(
        "gpu_parent_runtime_proof_authenticated_expected_output_semantics_hash_mismatch",
      );
      return;
    }

    const proofId = validation.expectedBinding.fullRuntimeProofId;
    const requestId = validation.expectedBinding.requestId;
    const proofIdentityHistoryKey = controlIdentityHistoryKey(
      "fullRuntimeProofId",
      proofId,
    );
    const requestIdentityHistoryKey = controlIdentityHistoryKey(
      "requestId",
      requestId,
    );
    if (
      this.admittedControlIdentityHistory.has(proofIdentityHistoryKey)
      || this.admittedControlIdentityHistory.has(requestIdentityHistoryKey)
      || this.bindingsByProofId.has(proofId)
      || this.retainedControlVerificationMaterials.has(proofId)
      || this.reservedProofIdByRequestId.has(requestId)
    ) {
      this.fail("gpu_parent_runtime_proof_authenticated_binding_identity_collision");
      return;
    }
    if (this.reservedCapsuleCount() >= this.maxVerifiedBindings) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_binding_capacity_exhausted";
      return;
    }
    const bindingId = validation.evidence.bindingId;
    if (bindingId === null) {
      this.fail("gpu_parent_runtime_proof_verified_control_binding_id_missing");
      return;
    }
    const binding = Object.freeze({
      bindingId,
      expectedBinding: freezeExpectedBinding(validation.expectedBinding),
      protectedProofJsonSha256:
        controlBinding.protectedProofJsonSha256 as string,
      canonicalProofSha256: controlBinding.canonicalProofSha256 as string,
      controlBinding,
      runtimeEvidenceTransportVerificationKey,
      transportContext,
      expiresAt: commitNow + this.bindingTtlMs,
    });
    this.bindingsByProofId.set(proofId, binding);
    this.reservedProofIdByRequestId.set(requestId, proofId);
    this.admittedControlIdentityHistory.add(proofIdentityHistoryKey);
    this.admittedControlIdentityHistory.add(requestIdentityHistoryKey);
    this.pendingIntents.delete(nonce);
    this.lastDecisionCode = "gpu_parent_runtime_proof_control_admitted";
  }

  private consumeParentProof(
    message: Record<string, unknown>,
  ): boolean {
    if (this.failureReason !== null) return false;
    if (!freezeParsedParentMessage(message)) {
      this.lastDecisionCode =
        "gpu_parent_runtime_proof_parent_message_freeze_failed";
      return false;
    }
    const pin = this.keyPin.snapshot();
    if (pin.status !== "pinned" || pin.key === null) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_parent_key_not_pinned";
      return false;
    }
    const parent = plainRecord(message.parentVerification);
    const proofId = parent?.fullRuntimeProofId;
    if (typeof proofId !== "string") {
      this.lastDecisionCode = "gpu_parent_runtime_proof_parent_binding_identity_missing";
      return false;
    }
    if (this.parentProofIdsInFlight.has(proofId)) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_parent_reentry_suppressed";
      return false;
    }
    const binding = this.bindingsByProofId.get(proofId);
    if (binding === undefined) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_parent_binding_missing";
      return false;
    }
    if (
      parent?.protectedProofJsonSha256 !== binding.protectedProofJsonSha256
      || parent.canonicalProofSha256 !== binding.canonicalProofSha256
    ) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_control_parent_hash_mismatch";
      return false;
    }
    if (!sameTransportVerificationKey(
      pin.key,
      binding.runtimeEvidenceTransportVerificationKey,
    )) {
      this.fail("gpu_parent_runtime_proof_transport_verification_key_changed");
      return false;
    }

    let validation: ReturnType<typeof verifyGpuParentRuntimeProofTransport>;
    this.parentProofIdsInFlight.add(proofId);
    try {
      validation = verifyGpuParentRuntimeProofTransport(message, {
        transportSessionId: this.transportSessionId,
        expectedWorkerProcessId: pin.key.workerProcessId,
        expectedBinding: binding.expectedBinding,
        receiptConsumer: this.receiptConsumer,
      });
    } finally {
      this.parentProofIdsInFlight.delete(proofId);
    }
    if (!this.isActive()) return false;
    if (!validation.verified) {
      this.lastDecisionCode = validation.code;
      return false;
    }
    const commitNow = this.currentTime();
    this.prune(commitNow);
    if (!this.isActive()) return false;
    if (this.bindingsByProofId.get(proofId) !== binding) {
      this.lastDecisionCode =
        "gpu_parent_runtime_proof_parent_transaction_state_changed";
      return false;
    }
    const currentPin = this.keyPin.snapshot();
    if (currentPin.status !== "pinned" || currentPin.key === null) {
      this.lastDecisionCode = "gpu_parent_runtime_proof_parent_key_not_pinned";
      return false;
    }
    if (!sameTransportVerificationKey(
      currentPin.key,
      binding.runtimeEvidenceTransportVerificationKey,
    )) {
      this.fail("gpu_parent_runtime_proof_transport_verification_key_changed");
      return false;
    }
    if (
      this.retainedControlVerificationMaterials.has(proofId)
      || this.reservedProofIdByRequestId.get(
        binding.expectedBinding.requestId,
      ) !== proofId
      || this.reservedCapsuleCount() > this.maxVerifiedBindings
    ) {
      this.fail("gpu_parent_runtime_proof_capsule_reservation_invariant_failed");
      return false;
    }

    const material: GpuParentRuntimeProofControlVerificationMaterial = deepFreeze({
      schemaVersion:
        GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
      controlBinding: binding.controlBinding,
      runtimeEvidenceTransportVerificationKey:
        binding.runtimeEvidenceTransportVerificationKey,
      transportContext: binding.transportContext,
    });
    this.bindingsByProofId.delete(proofId);
    this.retainedControlVerificationMaterials.set(proofId, Object.freeze({
      material,
      requestId: binding.expectedBinding.requestId,
      expiresAt: commitNow + this.bindingTtlMs,
    }));
    this.admittedProofCount += 1;
    this.lastDecisionCode = "gpu_parent_runtime_proof_parent_admitted";
    return true;
  }

  private removeBinding(binding: GpuParentRuntimeProofExpectedBinding): void {
    this.bindingsByProofId.delete(binding.fullRuntimeProofId);
    this.releaseRequestIdReservation(binding.requestId, binding.fullRuntimeProofId);
  }

  private prune(now: number): void {
    for (const [nonce, intent] of this.pendingIntents) {
      if (intent.expiresAt <= now) this.pendingIntents.delete(nonce);
    }
    for (const binding of this.bindingsByProofId.values()) {
      if (binding.expiresAt > now) continue;
      this.removeBinding(binding.expectedBinding);
    }
    for (const [proofId, retained] of this.retainedControlVerificationMaterials) {
      if (retained.expiresAt <= now) {
        this.retainedControlVerificationMaterials.delete(proofId);
        this.releaseRequestIdReservation(retained.requestId, proofId);
      }
    }
  }

  private reservedCapsuleCount(): number {
    return this.bindingsByProofId.size
      + this.retainedControlVerificationMaterials.size;
  }

  private releaseRequestIdReservation(requestId: string, proofId: string): void {
    if (this.reservedProofIdByRequestId.get(requestId) === proofId) {
      this.reservedProofIdByRequestId.delete(requestId);
    }
  }

  private isActive(): boolean {
    return !this.disposed && this.failureReason === null;
  }

  private currentTime(): number {
    const value = this.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("gpu_parent_runtime_proof_admission_clock_invalid");
    }
    return value;
  }

  private fail(reason: string): void {
    this.failureReason = reason;
    this.pendingIntents.clear();
    this.issuedNonceHashes.clear();
    this.admittedControlIdentityHistory.clear();
    this.bindingsByProofId.clear();
    this.reservedProofIdByRequestId.clear();
    this.retainedControlVerificationMaterials.clear();
    this.controlNoncesInFlight.clear();
    this.parentProofIdsInFlight.clear();
    this.lastDecisionCode = reason;
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error("gpu_parent_runtime_proof_admission_disposed");
    }
    if (this.failureReason !== null) throw new Error(this.failureReason);
  }
}
