import {
  createHash,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import {
  isKeyObject,
  isProxy,
  isSharedArrayBuffer,
  isUint8Array,
} from "node:util/types";
import type {
  GpuParentRuntimeProofAdmissionReceipt,
} from "./gpu_parent_runtime_proof_admission_receipt.js";
import * as sharedAdmissionVerifierModule
  from "../scripts/lib/gpu-hmr-mcp-admission-receipt-verifier.mjs";
import * as sharedOutputObservationVerifierModule
  from "../scripts/lib/gpu-hmr-mcp-output-observation-receipt-verifier.mjs";

const sharedAdmissionVerifier = sharedAdmissionVerifierModule as unknown as Readonly<{
  GPU_HMR_MCP_ADMISSION_VERIFICATION_KEY_SCHEMA:
    "synthi.gpu_hmr.mcp_admission_verification_key.v1";
  GPU_HMR_MCP_ADMISSION_ALGORITHM: "ed25519";
  GPU_HMR_MCP_ADMISSION_PRODUCER: "synthi-mcp";
  createGpuHmrMcpAdmissionVerificationKey: (publicKey: unknown) => unknown;
  parseGpuHmrMcpAdmissionVerificationKey: (value: unknown) => unknown;
  hashGpuHmrMcpValidationRunChallenge: (value: unknown) => unknown;
  verifyGpuHmrMcpAdmissionReceipt: (
    trustedVerificationKey: unknown,
    receipt: unknown,
    expectedValidationRunChallenge: unknown,
  ) => unknown;
}>;

const sharedOutputObservationVerifier =
  sharedOutputObservationVerifierModule as unknown as Readonly<{
    GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA:
      "synthi.gpu_hmr.mcp_output_observation_receipt.v1";
    GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY:
      "mcp_signed_output_byte_observation_support_only_not_gpu_hmr_acceptance";
    GPU_HMR_MCP_OUTPUT_OBSERVATION_VERIFICATION_AUTHORITY:
      "mcp_output_observation_signature_and_challenge_support_only_runtime_binding_bytes_replay_and_freshness_unchecked_not_gpu_hmr_acceptance";
    parseGpuHmrMcpOutputObservationReceiptSigningInput: (
      value: unknown,
    ) => unknown;
    createGpuHmrMcpOutputObservationReceiptSigningBytes: (
      value: unknown,
    ) => unknown;
    finalizeGpuHmrMcpOutputObservationReceipt: (
      value: unknown,
      signature: unknown,
    ) => unknown;
    verifyGpuHmrMcpOutputObservationReceipt: (
      trustedVerificationKey: unknown,
      receipt: unknown,
      expectedValidationRunChallenge: unknown,
    ) => unknown;
  }>;

export const GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_KEY_SCHEMA =
  sharedAdmissionVerifier.GPU_HMR_MCP_ADMISSION_VERIFICATION_KEY_SCHEMA;
export const GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA =
  sharedOutputObservationVerifier.GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA;
export const GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_ALGORITHM =
  sharedAdmissionVerifier.GPU_HMR_MCP_ADMISSION_ALGORITHM;
export const GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_PRODUCER =
  sharedAdmissionVerifier.GPU_HMR_MCP_ADMISSION_PRODUCER;
export const GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY =
  sharedOutputObservationVerifier
    .GPU_HMR_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY;
export const GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_AUTHORITY =
  sharedOutputObservationVerifier
    .GPU_HMR_MCP_OUTPUT_OBSERVATION_VERIFICATION_AUTHORITY;

const VERIFICATION_RESULT_SCHEMA =
  "synthi.gpu_hmr.mcp_output_observation_receipt_verification.v1" as const;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const U64_MAX = 18_446_744_073_709_551_615n;

const REQUEST_KEYS = [
  "admissionReceipt",
  "outputBytes",
] as const;
const RUNTIME_BINDING_DOMAIN =
  "synthi.gpu_hmr.mcp_output_runtime_binding.v1";
const OBSERVATION_REQUEST_DOMAIN =
  "synthi.gpu_hmr.mcp_output_observation_request.v1";
const SIGNER_CONTEXT_REQUIRED_KEYS = [
  "privateKey",
  "validationRunChallenge",
] as const;
const SIGNER_CONTEXT_OPTIONAL_KEYS = [
  "clockMonotonicNs",
  "clockUnixNs",
  "nonceBytes",
] as const;

export interface GpuMcpOutputObservationReceiptVerificationKey {
  readonly schemaVersion:
    typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_KEY_SCHEMA;
  readonly algorithm: typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_ALGORITHM;
  readonly keyId: string;
  readonly producer: typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_PRODUCER;
  readonly publicKey: string;
}

export interface GpuMcpOutputObservationReceiptRequest {
  readonly admissionReceipt: GpuParentRuntimeProofAdmissionReceipt;
  readonly outputBytes: Uint8Array;
}

interface GpuMcpOutputObservationReceiptSigningInput {
  readonly transportSessionId: string;
  readonly requestChallengeSha256: string;
  readonly runtimeBindingSha256: string;
  readonly producerObservationSha256: string;
  readonly outputContentSha256: string;
  readonly outputByteLength: string;
}

export interface GpuMcpOutputObservationReceipt
extends GpuMcpOutputObservationReceiptSigningInput {
  readonly schemaVersion: typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA;
  readonly algorithm: typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_ALGORITHM;
  readonly signerKeyId: string;
  readonly producer: typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_PRODUCER;
  readonly proofAuthority: typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY;
  readonly outputBytesObserved: true;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
  readonly validationRunChallengeSha256: string;
  readonly observedAtMonotonicNs: string;
  readonly issuedAtUnixNs: string;
  readonly sequence: string;
  readonly nonce: string;
  readonly receiptId: string;
  readonly signature: string;
}

export interface GpuMcpOutputObservationReceiptReplayScope {
  readonly replayScopeId: string;
  readonly signerKeyId: string;
  readonly validationRunChallengeSha256: string;
  readonly transportSessionId: string;
}

interface VerificationBase {
  readonly schemaVersion: typeof VERIFICATION_RESULT_SCHEMA;
  readonly verificationAuthority:
    typeof GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_VERIFICATION_AUTHORITY;
  readonly trustedKeyOriginChecked: false;
  readonly requestChallengeChecked: false;
  readonly runtimeBindingChecked: false;
  readonly outputBytesChecked: false;
  readonly replayChecked: false;
  readonly freshnessChecked: false;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuMcpOutputObservationReceiptVerified extends VerificationBase {
  readonly signatureVerified: true;
  readonly reason: null;
  readonly receiptId: string;
  readonly issuedAtUnixNs: bigint;
  readonly observedAtMonotonicNs: bigint;
  readonly sequence: bigint;
  readonly replayScope: GpuMcpOutputObservationReceiptReplayScope;
}

export interface GpuMcpOutputObservationReceiptRefused extends VerificationBase {
  readonly signatureVerified: false;
  readonly reason: string;
  readonly receiptId: null;
  readonly issuedAtUnixNs: null;
  readonly observedAtMonotonicNs: null;
  readonly sequence: null;
  readonly replayScope: null;
}

export type GpuMcpOutputObservationReceiptVerification =
  | GpuMcpOutputObservationReceiptVerified
  | GpuMcpOutputObservationReceiptRefused;

export interface GpuMcpOutputObservationReceiptSignerContext {
  readonly privateKey: KeyObject;
  readonly validationRunChallenge: string;
  readonly clockMonotonicNs?: () => bigint;
  readonly clockUnixNs?: () => bigint;
  readonly nonceBytes?: () => Uint8Array;
}

type SignerContextSnapshot = Readonly<{
  privateKey: unknown;
  validationRunChallenge: unknown;
  clockMonotonicNs: unknown;
  clockUnixNs: unknown;
  nonceBytes: unknown;
}>;

function snapshotExactDataObject(
  value: unknown,
  requiredKeys: readonly string[],
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    const requiredKeySet = new Set(requiredKeys);
    if (
      ownKeys.length !== requiredKeys.length
      || ownKeys.some((key) => typeof key !== "string" || !requiredKeySet.has(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of requiredKeys) {
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
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function snapshotPrimitiveDataObject(
  value: unknown,
): Readonly<Record<string, unknown>> | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length === 0
      || ownKeys.length > 64
      || ownKeys.some((key) => typeof key !== "string")
    ) {
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
        || !(
          descriptor.value === null
          || typeof descriptor.value === "string"
          || typeof descriptor.value === "number"
          || typeof descriptor.value === "boolean"
        )
      ) {
        return null;
      }
      Object.defineProperty(snapshot, key, {
        value: descriptor.value,
        enumerable: true,
        writable: false,
        configurable: false,
      });
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function domainSha256(domain: string, ...values: string[]): string {
  const hash = createHash("sha256").update(domain, "utf8");
  for (const value of values) {
    hash.update("\0", "utf8").update(value, "utf8");
  }
  return `sha256:${hash.digest("hex")}`;
}

function snapshotSignerContext(value: unknown): SignerContextSnapshot | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const requiredKeys = new Set<string>(SIGNER_CONTEXT_REQUIRED_KEYS);
    const allowedKeys = new Set<string>([
      ...SIGNER_CONTEXT_REQUIRED_KEYS,
      ...SIGNER_CONTEXT_OPTIONAL_KEYS,
    ]);
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.some((key) => typeof key !== "string" || !allowedKeys.has(key))
      || [...requiredKeys].some((key) => !ownKeys.includes(key))
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {
      clockMonotonicNs: undefined,
      clockUnixNs: undefined,
      nonceBytes: undefined,
    };
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
    return Object.freeze(snapshot) as SignerContextSnapshot;
  } catch {
    return null;
  }
}

const TYPED_ARRAY_PROTOTYPE = Object.getPrototypeOf(Uint8Array.prototype);
const TYPED_ARRAY_BUFFER_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "buffer")?.get;
const TYPED_ARRAY_BYTE_LENGTH_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteLength")?.get;
const TYPED_ARRAY_BYTE_OFFSET_GETTER =
  Object.getOwnPropertyDescriptor(TYPED_ARRAY_PROTOTYPE, "byteOffset")?.get;

function snapshotObservedBytes(value: unknown): Buffer | null {
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
    const buffer = Reflect.apply(
      TYPED_ARRAY_BUFFER_GETTER,
      value,
      [],
    ) as ArrayBufferLike;
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
    const byteOffset = Reflect.apply(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      value,
      [],
    ) as number;
    if (
      isSharedArrayBuffer(buffer)
      || !Number.isSafeInteger(byteLength)
      || byteLength < 0
    ) {
      return null;
    }
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    return null;
  }
}

function snapshotNonceBytes(value: unknown): Buffer | null {
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
    const buffer = Reflect.apply(TYPED_ARRAY_BUFFER_GETTER, value, []) as ArrayBuffer;
    const byteLength = Reflect.apply(
      TYPED_ARRAY_BYTE_LENGTH_GETTER,
      value,
      [],
    ) as number;
    const byteOffset = Reflect.apply(
      TYPED_ARRAY_BYTE_OFFSET_GETTER,
      value,
      [],
    ) as number;
    if (byteLength !== 32) return null;
    return Buffer.from(new Uint8Array(buffer, byteOffset, byteLength));
  } catch {
    return null;
  }
}

function deriveVerificationKey(
  privateKey: KeyObject,
): GpuMcpOutputObservationReceiptVerificationKey {
  let publicKeyDer: Buffer;
  try {
    const exported = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    publicKeyDer = Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
  } catch {
    throw new Error("gpu_mcp_output_observation_receipt_private_key_invalid");
  }
  if (
    publicKeyDer.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32
    || !publicKeyDer.subarray(0, ED25519_SPKI_PREFIX.byteLength)
      .equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error("gpu_mcp_output_observation_receipt_private_key_invalid");
  }
  const verificationKey = sharedAdmissionVerifier
    .createGpuHmrMcpAdmissionVerificationKey(
      publicKeyDer.subarray(ED25519_SPKI_PREFIX.byteLength).toString("base64url"),
    ) as GpuMcpOutputObservationReceiptVerificationKey | null;
  if (verificationKey === null) {
    throw new Error("gpu_mcp_output_observation_receipt_private_key_invalid");
  }
  return verificationKey;
}

function parseRequest(
  value: unknown,
  trustedVerificationKey: GpuMcpOutputObservationReceiptVerificationKey,
  validationRunChallenge: string,
): GpuMcpOutputObservationReceiptSigningInput | null {
  const request = snapshotExactDataObject(value, REQUEST_KEYS);
  if (request === null) return null;
  const admissionReceipt = snapshotPrimitiveDataObject(request.admissionReceipt);
  if (admissionReceipt === null) return null;
  const admissionVerification =
    sharedAdmissionVerifier.verifyGpuHmrMcpAdmissionReceipt(
      trustedVerificationKey,
      admissionReceipt,
      validationRunChallenge,
    ) as Readonly<Record<string, unknown>> | null;
  if (admissionVerification?.verified !== true) return null;
  const transportSessionId = admissionReceipt.transportSessionId;
  const admissionReceiptId = admissionReceipt.receiptId;
  const compileRequestNonce = admissionReceipt.compileRequestNonce;
  const producerObservationSha256 = admissionReceipt.protectedProofJsonSha256;
  if (
    typeof transportSessionId !== "string"
    || typeof admissionReceiptId !== "string"
    || typeof compileRequestNonce !== "string"
    || typeof producerObservationSha256 !== "string"
  ) {
    return null;
  }
  const outputBytes = snapshotObservedBytes(request.outputBytes);
  if (outputBytes === null) return null;
  const outputContentSha256 =
    `sha256:${createHash("sha256").update(outputBytes).digest("hex")}`;
  const outputByteLength = String(outputBytes.byteLength);
  outputBytes.fill(0);
  const runtimeBindingSha256 = domainSha256(
    RUNTIME_BINDING_DOMAIN,
    admissionReceiptId,
  );
  const requestChallengeSha256 = domainSha256(
    OBSERVATION_REQUEST_DOMAIN,
    admissionReceiptId,
    compileRequestNonce,
  );
  const validated = sharedOutputObservationVerifier
    .parseGpuHmrMcpOutputObservationReceiptSigningInput({
      transportSessionId,
      requestChallengeSha256,
      runtimeBindingSha256,
      producerObservationSha256,
      outputContentSha256,
      outputByteLength,
      observedAtMonotonicNs: "0",
    });
  return validated === null
    ? null
    : Object.freeze({
      transportSessionId,
      requestChallengeSha256,
      runtimeBindingSha256,
      producerObservationSha256,
      outputContentSha256,
      outputByteLength,
    });
}

function validClockValue(value: unknown): value is bigint {
  return typeof value === "bigint" && value >= 0n && value <= U64_MAX;
}

export function parseGpuMcpOutputObservationReceiptVerificationKey(
  value: unknown,
): GpuMcpOutputObservationReceiptVerificationKey | null {
  return sharedAdmissionVerifier.parseGpuHmrMcpAdmissionVerificationKey(value) as
    GpuMcpOutputObservationReceiptVerificationKey | null;
}

export function verifyGpuMcpOutputObservationReceipt(
  trustedVerificationKey: unknown,
  receipt: unknown,
  expectedValidationRunChallenge: unknown,
): GpuMcpOutputObservationReceiptVerification {
  return sharedOutputObservationVerifier.verifyGpuHmrMcpOutputObservationReceipt(
    trustedVerificationKey,
    receipt,
    expectedValidationRunChallenge,
  ) as GpuMcpOutputObservationReceiptVerification;
}

/**
 * Produces support evidence only. The signer verifies the admitted runtime
 * subject and observes the supplied bytes itself; the session authority still
 * owns trusted-key origin, one-time request, replay, and freshness policy.
 */
export class GpuMcpOutputObservationReceiptSigner {
  #privateKey: KeyObject | null;
  readonly #exportedVerificationKey: GpuMcpOutputObservationReceiptVerificationKey;
  readonly #validationRunChallenge: string;
  readonly #validationRunChallengeSha256: string;
  readonly #clockMonotonicNs: () => bigint;
  readonly #clockUnixNs: () => bigint;
  readonly #nonceBytes: () => Uint8Array;
  #sequence = 0n;
  #disposed = false;
  #signing = false;

  constructor(contextValue: GpuMcpOutputObservationReceiptSignerContext) {
    const context = snapshotSignerContext(contextValue);
    if (context === null) {
      throw new Error("gpu_mcp_output_observation_receipt_signer_context_invalid");
    }
    if (
      context.privateKey === null
      || typeof context.privateKey !== "object"
      || isProxy(context.privateKey)
      || !isKeyObject(context.privateKey)
      || context.privateKey.type !== "private"
      || context.privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new Error("gpu_mcp_output_observation_receipt_private_key_invalid");
    }
    for (const [value, reason] of [
      [context.clockMonotonicNs, "gpu_mcp_output_observation_receipt_observation_clock_invalid"],
      [context.clockUnixNs, "gpu_mcp_output_observation_receipt_issuance_clock_invalid"],
      [context.nonceBytes, "gpu_mcp_output_observation_receipt_nonce_source_invalid"],
    ] as const) {
      if (value !== undefined && (typeof value !== "function" || isProxy(value))) {
        throw new Error(reason);
      }
    }
    const validationRunChallengeSha256 = sharedAdmissionVerifier
      .hashGpuHmrMcpValidationRunChallenge(context.validationRunChallenge);
    if (typeof validationRunChallengeSha256 !== "string") {
      throw new Error(
        "gpu_mcp_output_observation_receipt_validation_run_challenge_invalid",
      );
    }
    this.#privateKey = context.privateKey;
    this.#exportedVerificationKey = deriveVerificationKey(context.privateKey);
    this.#validationRunChallenge = context.validationRunChallenge as string;
    this.#validationRunChallengeSha256 = validationRunChallengeSha256;
    this.#clockMonotonicNs =
      (context.clockMonotonicNs as (() => bigint) | undefined)
      ?? (() => process.hrtime.bigint());
    this.#clockUnixNs = (context.clockUnixNs as (() => bigint) | undefined)
      ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.#nonceBytes = (context.nonceBytes as (() => Uint8Array) | undefined)
      ?? (() => randomBytes(32));
  }

  exportVerificationKey(): GpuMcpOutputObservationReceiptVerificationKey {
    return this.#exportedVerificationKey;
  }

  signOutputObservationReceipt(
    requestValue: GpuMcpOutputObservationReceiptRequest,
  ): GpuMcpOutputObservationReceipt {
    this.assertActive();
    if (this.#signing) {
      throw new Error("gpu_mcp_output_observation_receipt_signer_busy");
    }
    const request = parseRequest(
      requestValue,
      this.#exportedVerificationKey,
      this.#validationRunChallenge,
    );
    if (request === null) {
      throw new Error("gpu_mcp_output_observation_receipt_request_invalid");
    }
    if (this.#sequence >= U64_MAX) {
      throw new Error("gpu_mcp_output_observation_receipt_sequence_exhausted");
    }

    this.#signing = true;
    let nonce: Buffer | null = null;
    try {
      let observedAtMonotonicNs: bigint;
      try {
        observedAtMonotonicNs = this.#clockMonotonicNs();
      } catch {
        throw new Error("gpu_mcp_output_observation_receipt_observation_clock_failed");
      }
      if (!validClockValue(observedAtMonotonicNs)) {
        throw new Error("gpu_mcp_output_observation_receipt_observation_clock_invalid");
      }
      this.assertActive();

      let issuedAtUnixNs: bigint;
      try {
        issuedAtUnixNs = this.#clockUnixNs();
      } catch {
        throw new Error("gpu_mcp_output_observation_receipt_issuance_clock_failed");
      }
      if (!validClockValue(issuedAtUnixNs)) {
        throw new Error("gpu_mcp_output_observation_receipt_issuance_clock_invalid");
      }
      this.assertActive();

      let rawNonce: unknown;
      try {
        rawNonce = this.#nonceBytes();
      } catch {
        throw new Error("gpu_mcp_output_observation_receipt_nonce_source_failed");
      }
      nonce = snapshotNonceBytes(rawNonce);
      if (nonce === null) {
        throw new Error("gpu_mcp_output_observation_receipt_nonce_source_invalid");
      }
      this.assertActive();

      const nextSequence = this.#sequence + 1n;
      const unsignedReceipt = Object.freeze({
        schemaVersion: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_SCHEMA,
        algorithm: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_ALGORITHM,
        signerKeyId: this.#exportedVerificationKey.keyId,
        producer: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_PRODUCER,
        proofAuthority: GPU_MCP_OUTPUT_OBSERVATION_RECEIPT_AUTHORITY,
        outputBytesObserved: true as const,
        acceptedForGpuHmr: false as const,
        gpuHmrSuccess: false as const,
        canSatisfyRuntimeProof: false as const,
        validationRunChallengeSha256: this.#validationRunChallengeSha256,
        ...request,
        observedAtMonotonicNs: observedAtMonotonicNs.toString(),
        issuedAtUnixNs: issuedAtUnixNs.toString(),
        sequence: nextSequence.toString(),
        nonce: nonce.toString("base64url"),
      });
      const signingBytes = sharedOutputObservationVerifier
        .createGpuHmrMcpOutputObservationReceiptSigningBytes(unsignedReceipt);
      if (!Buffer.isBuffer(signingBytes)) {
        throw new Error("gpu_mcp_output_observation_receipt_signing_material_invalid");
      }
      const privateKey = this.#privateKey;
      if (privateKey === null || this.#disposed) {
        throw new Error("gpu_mcp_output_observation_receipt_signer_disposed");
      }
      let signature: string;
      try {
        signature = `ed25519:${signBytes(null, signingBytes, privateKey).toString("base64url")}`;
      } catch {
        throw new Error("gpu_mcp_output_observation_receipt_signing_failed");
      }
      const receipt = sharedOutputObservationVerifier
        .finalizeGpuHmrMcpOutputObservationReceipt(unsignedReceipt, signature) as
          GpuMcpOutputObservationReceipt | null;
      if (receipt === null) {
        throw new Error("gpu_mcp_output_observation_receipt_signing_failed");
      }
      this.#sequence = nextSequence;
      return receipt;
    } finally {
      nonce?.fill(0);
      this.#signing = false;
    }
  }

  sign(request: GpuMcpOutputObservationReceiptRequest): GpuMcpOutputObservationReceipt {
    return this.signOutputObservationReceipt(request);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#privateKey = null;
    this.#disposed = true;
  }

  private assertActive(): void {
    if (this.#disposed || this.#privateKey === null) {
      throw new Error("gpu_mcp_output_observation_receipt_signer_disposed");
    }
  }
}
