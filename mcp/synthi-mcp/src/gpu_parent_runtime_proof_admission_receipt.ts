import {
  createHash,
  createPublicKey,
  randomBytes,
  sign as signBytes,
  type KeyObject,
} from "node:crypto";
import { isKeyObject, isProxy, isUint8Array } from "node:util/types";
import * as sharedMcpAdmissionReceiptVerifierModule
  from "../scripts/lib/gpu-hmr-mcp-admission-receipt-verifier.mjs";

const sharedMcpAdmissionReceiptVerifier =
  sharedMcpAdmissionReceiptVerifierModule as unknown as Readonly<{
    GPU_HMR_MCP_ADMISSION_VERIFICATION_KEY_SCHEMA:
      "synthi.gpu_hmr.mcp_admission_verification_key.v1";
    GPU_HMR_MCP_ADMISSION_RECEIPT_SCHEMA:
      "synthi.gpu_hmr.mcp_admission_receipt.v1";
    GPU_HMR_MCP_ADMISSION_ALGORITHM: "ed25519";
    GPU_HMR_MCP_ADMISSION_PRODUCER: "synthi-mcp";
    GPU_HMR_MCP_ADMISSION_RECEIPT_AUTHORITY:
      "mcp_signed_control_and_parent_proof_admission_support_only_not_gpu_hmr_acceptance";
    GPU_HMR_MCP_ADMISSION_VERIFICATION_AUTHORITY:
      "mcp_admission_signature_and_challenge_binding_support_only_replay_and_freshness_unchecked_not_gpu_hmr_acceptance";
    createGpuHmrMcpAdmissionVerificationKey: (publicKey: unknown) => unknown;
    parseGpuHmrMcpAdmissionVerificationKey: (value: unknown) => unknown;
    hashGpuHmrMcpValidationRunChallenge: (value: unknown) => unknown;
    parseGpuHmrMcpAdmissionReceiptSigningInput: (value: unknown) => unknown;
    createGpuHmrMcpAdmissionReceiptSigningBytes: (value: unknown) => unknown;
    finalizeGpuHmrMcpAdmissionReceipt: (
      value: unknown,
      signature: unknown,
    ) => unknown;
    verifyGpuHmrMcpAdmissionReceipt: (
      trustedVerificationKey: unknown,
      receipt: unknown,
      expectedValidationRunChallenge: unknown,
    ) => unknown;
  }>;

export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_KEY_SCHEMA =
  sharedMcpAdmissionReceiptVerifier
    .GPU_HMR_MCP_ADMISSION_VERIFICATION_KEY_SCHEMA;
export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_SCHEMA =
  sharedMcpAdmissionReceiptVerifier.GPU_HMR_MCP_ADMISSION_RECEIPT_SCHEMA;
export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_ALGORITHM =
  sharedMcpAdmissionReceiptVerifier.GPU_HMR_MCP_ADMISSION_ALGORITHM;
export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_PRODUCER =
  sharedMcpAdmissionReceiptVerifier.GPU_HMR_MCP_ADMISSION_PRODUCER;
export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_AUTHORITY =
  sharedMcpAdmissionReceiptVerifier
    .GPU_HMR_MCP_ADMISSION_RECEIPT_AUTHORITY;
export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_AUTHORITY =
  sharedMcpAdmissionReceiptVerifier
    .GPU_HMR_MCP_ADMISSION_VERIFICATION_AUTHORITY;

const VERIFICATION_RESULT_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_receipt_verification.v1" as const;
const ED25519_SPKI_PREFIX = Buffer.from(
  "302a300506032b6570032100",
  "hex",
);
const U64_MAX = 18_446_744_073_709_551_615n;
const NONCE_BINDING_DOMAIN =
  "synthi.gpu_hmr.mcp_admission_nonce_binding.v1";

const SIGNER_CONTEXT_REQUIRED_KEYS = [
  "privateKey",
  "validationRunChallenge",
] as const;
const SIGNER_CONTEXT_OPTIONAL_KEYS = [
  "clockUnixNs",
  "nonceBindingKey",
  "nonceBytes",
] as const;

export interface GpuParentRuntimeProofAdmissionReceiptVerificationKey {
  readonly schemaVersion:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_KEY_SCHEMA;
  readonly algorithm:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_ALGORITHM;
  readonly keyId: string;
  readonly producer:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_PRODUCER;
  readonly publicKey: string;
}

export interface GpuParentRuntimeProofAdmissionReceiptInput {
  readonly transportSessionId: string;
  readonly compileRequestNonce: string;
  readonly computeExpectedOutputContractHash: string | null;
  readonly computeExpectedOutputSemanticsHash: string | null;
  readonly workerKeyId: string;
  readonly workerKeyAnnouncementId: string;
  readonly workerProcessId: string;
  readonly controlBindingId: string;
  readonly controlBindingCanonicalSha256: string;
  readonly controlTransportReceiptId: string;
  readonly controlObservationContextHash: string;
  readonly parentReceiptId: string;
  readonly parentTransportReceiptId: string;
  readonly parentCanonicalProofSha256: string;
  readonly parentObservationContextHash: string;
  readonly requestId: string;
  readonly sourceEditId: string;
  readonly artifactContentHash: string;
  readonly fullRuntimeProofId: string;
  readonly proofLedgerId: string;
  readonly runnerProcessId: number;
  readonly runnerRuntimeSessionId: string;
  readonly runnerChallenge: string;
  readonly commandEnvelopeSha256: string;
  readonly protectedProofJsonSha256: string;
}

export interface GpuParentRuntimeProofAdmissionReceipt
extends GpuParentRuntimeProofAdmissionReceiptInput {
  readonly schemaVersion:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_SCHEMA;
  readonly algorithm:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_ALGORITHM;
  readonly signerKeyId: string;
  readonly producer:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_PRODUCER;
  readonly proofAuthority:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_AUTHORITY;
  readonly controlStageAdmitted: true;
  readonly parentProofStageAdmitted: true;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
  readonly validationRunChallengeSha256: string;
  readonly admittedAtUnixNs: string;
  readonly sequence: string;
  readonly nonce: string;
  readonly receiptId: string;
  readonly signature: string;
}

export interface GpuParentRuntimeProofAdmissionOutputContractBinding {
  readonly outputContractSha256: string | null;
  readonly outputSemanticsSha256: string | null;
}

export function gpuParentRuntimeProofAdmissionOutputContractBinding(
  receipt: GpuParentRuntimeProofAdmissionReceipt,
): GpuParentRuntimeProofAdmissionOutputContractBinding {
  return Object.freeze({
    outputContractSha256: receipt.computeExpectedOutputContractHash,
    outputSemanticsSha256: receipt.computeExpectedOutputSemanticsHash,
  });
}

export interface GpuParentRuntimeProofAdmissionReceiptReplayScope {
  readonly replayScopeId: string;
  readonly signerKeyId: string;
  readonly validationRunChallengeSha256: string;
  readonly transportSessionId: string;
}

interface GpuParentRuntimeProofAdmissionReceiptVerificationBase {
  readonly schemaVersion: typeof VERIFICATION_RESULT_SCHEMA;
  readonly verificationAuthority:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_VERIFICATION_AUTHORITY;
  readonly replayChecked: false;
  readonly freshnessChecked: false;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuParentRuntimeProofAdmissionReceiptVerified
extends GpuParentRuntimeProofAdmissionReceiptVerificationBase {
  readonly verified: true;
  readonly reason: null;
  readonly receiptId: string;
  readonly admittedAtUnixNs: bigint;
  readonly sequence: bigint;
  readonly replayScope: GpuParentRuntimeProofAdmissionReceiptReplayScope;
}

export interface GpuParentRuntimeProofAdmissionReceiptRefused
extends GpuParentRuntimeProofAdmissionReceiptVerificationBase {
  readonly verified: false;
  readonly reason: string;
  readonly receiptId: null;
  readonly admittedAtUnixNs: null;
  readonly sequence: null;
  readonly replayScope: null;
}

export type GpuParentRuntimeProofAdmissionReceiptVerification =
  | GpuParentRuntimeProofAdmissionReceiptVerified
  | GpuParentRuntimeProofAdmissionReceiptRefused;

export interface GpuParentRuntimeProofAdmissionReceiptSignerContext {
  readonly privateKey: KeyObject;
  readonly validationRunChallenge: string;
  readonly clockUnixNs?: () => bigint;
  readonly nonceBindingKey?: Uint8Array;
  readonly nonceBytes?: () => Uint8Array;
}

type SignerContextSnapshot = Readonly<{
  privateKey: unknown;
  validationRunChallenge: unknown;
  clockUnixNs: unknown;
  nonceBindingKey: unknown;
  nonceBytes: unknown;
}>;

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
      clockUnixNs: undefined,
      nonceBindingKey: undefined,
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
): GpuParentRuntimeProofAdmissionReceiptVerificationKey {
  let publicKeyDer: Buffer;
  try {
    const exported = createPublicKey(privateKey).export({
      format: "der",
      type: "spki",
    });
    publicKeyDer = Buffer.isBuffer(exported) ? exported : Buffer.from(exported);
  } catch {
    throw new Error(
      "gpu_parent_runtime_proof_admission_receipt_private_key_invalid",
    );
  }
  if (
    publicKeyDer.byteLength !== ED25519_SPKI_PREFIX.byteLength + 32
    || !publicKeyDer.subarray(0, ED25519_SPKI_PREFIX.byteLength)
      .equals(ED25519_SPKI_PREFIX)
  ) {
    throw new Error(
      "gpu_parent_runtime_proof_admission_receipt_private_key_invalid",
    );
  }
  const publicKey = publicKeyDer
    .subarray(ED25519_SPKI_PREFIX.byteLength)
    .toString("base64url");
  const verificationKey = sharedMcpAdmissionReceiptVerifier
    .createGpuHmrMcpAdmissionVerificationKey(publicKey) as
      GpuParentRuntimeProofAdmissionReceiptVerificationKey | null;
  if (verificationKey === null) {
    throw new Error(
      "gpu_parent_runtime_proof_admission_receipt_private_key_invalid",
    );
  }
  return verificationKey;
}

export function parseGpuParentRuntimeProofAdmissionReceiptVerificationKey(
  value: unknown,
): GpuParentRuntimeProofAdmissionReceiptVerificationKey | null {
  return sharedMcpAdmissionReceiptVerifier
    .parseGpuHmrMcpAdmissionVerificationKey(value) as
      GpuParentRuntimeProofAdmissionReceiptVerificationKey | null;
}

export function verifyGpuParentRuntimeProofAdmissionReceipt(
  trustedVerificationKey: unknown,
  receipt: unknown,
  expectedValidationRunChallenge: unknown,
): GpuParentRuntimeProofAdmissionReceiptVerification {
  return sharedMcpAdmissionReceiptVerifier.verifyGpuHmrMcpAdmissionReceipt(
    trustedVerificationKey,
    receipt,
    expectedValidationRunChallenge,
  ) as GpuParentRuntimeProofAdmissionReceiptVerification;
}

export class GpuParentRuntimeProofAdmissionReceiptSigner {
  #privateKey: KeyObject | null;
  readonly #exportedVerificationKey:
    GpuParentRuntimeProofAdmissionReceiptVerificationKey;
  readonly #validationRunChallengeSha256: string;
  readonly #clockUnixNs: () => bigint;
  readonly #nonceBytes: () => Uint8Array;
  #nonceBindingKey: Buffer | null;
  #sequence = 0n;
  #disposed = false;
  #signing = false;

  constructor(contextValue: GpuParentRuntimeProofAdmissionReceiptSignerContext) {
    const context = snapshotSignerContext(contextValue);
    if (context === null) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_signer_context_invalid",
      );
    }
    if (
      context.privateKey === null
      || typeof context.privateKey !== "object"
      || isProxy(context.privateKey)
      || !isKeyObject(context.privateKey)
      || context.privateKey.type !== "private"
      || context.privateKey.asymmetricKeyType !== "ed25519"
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_private_key_invalid",
      );
    }
    if (
      context.clockUnixNs !== undefined
      && (typeof context.clockUnixNs !== "function" || isProxy(context.clockUnixNs))
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_clock_invalid",
      );
    }
    if (
      context.nonceBytes !== undefined
      && (typeof context.nonceBytes !== "function" || isProxy(context.nonceBytes))
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_nonce_source_invalid",
      );
    }
    const nonceBindingKey = context.nonceBindingKey === undefined
      ? null
      : snapshotNonceBytes(context.nonceBindingKey);
    if (context.nonceBindingKey !== undefined && nonceBindingKey === null) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_nonce_binding_key_invalid",
      );
    }
    const challengeHash = sharedMcpAdmissionReceiptVerifier
      .hashGpuHmrMcpValidationRunChallenge(
        context.validationRunChallenge,
      );
    if (typeof challengeHash !== "string") {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_validation_run_challenge_invalid",
      );
    }

    this.#privateKey = context.privateKey;
    this.#exportedVerificationKey = deriveVerificationKey(context.privateKey);
    this.#validationRunChallengeSha256 = challengeHash;
    this.#clockUnixNs = (context.clockUnixNs as (() => bigint) | undefined)
      ?? (() => BigInt(Date.now()) * 1_000_000n);
    this.#nonceBindingKey = nonceBindingKey;
    this.#nonceBytes = (context.nonceBytes as (() => Uint8Array) | undefined)
      ?? (() => randomBytes(32));
  }

  exportVerificationKey(): GpuParentRuntimeProofAdmissionReceiptVerificationKey {
    return this.#exportedVerificationKey;
  }

  signAdmissionReceipt(
    inputValue: GpuParentRuntimeProofAdmissionReceiptInput,
  ): GpuParentRuntimeProofAdmissionReceipt {
    this.assertActive();
    if (this.#signing) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_signer_busy",
      );
    }
    const input = sharedMcpAdmissionReceiptVerifier
      .parseGpuHmrMcpAdmissionReceiptSigningInput(inputValue) as
        GpuParentRuntimeProofAdmissionReceiptInput | null;
    if (input === null) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_input_invalid",
      );
    }
    if (this.#sequence >= U64_MAX) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_sequence_exhausted",
      );
    }

    this.#signing = true;
    let nonce: Buffer | null = null;
    try {
      let admittedAtUnixNs: bigint;
      try {
        admittedAtUnixNs = this.#clockUnixNs();
      } catch {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_clock_failed",
        );
      }
      if (
        typeof admittedAtUnixNs !== "bigint"
        || admittedAtUnixNs < 0n
        || admittedAtUnixNs > U64_MAX
      ) {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_clock_invalid",
        );
      }
      this.assertActive();

      let rawNonce: unknown;
      try {
        rawNonce = this.#nonceBytes();
      } catch {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_nonce_source_failed",
        );
      }
      nonce = snapshotNonceBytes(rawNonce);
      if (nonce === null) {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_nonce_source_invalid",
        );
      }
      const nonceBindingKey = this.#nonceBindingKey;
      if (nonceBindingKey !== null) {
        const sourceNonce = nonce;
        try {
          nonce = createHash("sha256")
            .update(NONCE_BINDING_DOMAIN, "utf8")
            .update("\0", "utf8")
            .update(nonceBindingKey)
            .update(sourceNonce)
            .digest();
        } finally {
          sourceNonce.fill(0);
        }
      }
      this.assertActive();

      const nextSequence = this.#sequence + 1n;
      const unsignedReceipt = Object.freeze({
        schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_SCHEMA,
        algorithm: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_ALGORITHM,
        signerKeyId: this.#exportedVerificationKey.keyId,
        producer: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_PRODUCER,
        proofAuthority: GPU_PARENT_RUNTIME_PROOF_ADMISSION_RECEIPT_AUTHORITY,
        controlStageAdmitted: true as const,
        parentProofStageAdmitted: true as const,
        acceptedForGpuHmr: false as const,
        gpuHmrSuccess: false as const,
        canSatisfyRuntimeProof: false as const,
        validationRunChallengeSha256: this.#validationRunChallengeSha256,
        ...input,
        admittedAtUnixNs: admittedAtUnixNs.toString(),
        sequence: nextSequence.toString(),
        nonce: nonce.toString("base64url"),
      });
      const signingBytes = sharedMcpAdmissionReceiptVerifier
        .createGpuHmrMcpAdmissionReceiptSigningBytes(unsignedReceipt);
      if (!Buffer.isBuffer(signingBytes)) {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_signing_material_invalid",
        );
      }
      const privateKey = this.#privateKey;
      if (privateKey === null || this.#disposed) {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_signer_disposed",
        );
      }

      let signature: string;
      try {
        signature = `ed25519:${signBytes(
          null,
          signingBytes,
          privateKey,
        ).toString("base64url")}`;
      } catch {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_signing_failed",
        );
      }
      const receipt = sharedMcpAdmissionReceiptVerifier
        .finalizeGpuHmrMcpAdmissionReceipt(unsignedReceipt, signature) as
          GpuParentRuntimeProofAdmissionReceipt | null;
      if (receipt === null) {
        throw new Error(
          "gpu_parent_runtime_proof_admission_receipt_signing_failed",
        );
      }
      this.#sequence = nextSequence;
      return receipt;
    } finally {
      nonce?.fill(0);
      this.#signing = false;
    }
  }

  sign(
    input: GpuParentRuntimeProofAdmissionReceiptInput,
  ): GpuParentRuntimeProofAdmissionReceipt {
    return this.signAdmissionReceipt(input);
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#privateKey = null;
    this.#nonceBindingKey?.fill(0);
    this.#nonceBindingKey = null;
    this.#disposed = true;
  }

  private assertActive(): void {
    if (this.#disposed || this.#privateKey === null) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_receipt_signer_disposed",
      );
    }
  }
}
