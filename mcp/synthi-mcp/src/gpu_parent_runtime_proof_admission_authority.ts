import {
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { isKeyObject, isProxy } from "node:util/types";
import {
  GpuParentRuntimeProofAdmissionReceiptSigner,
  type GpuParentRuntimeProofAdmissionReceiptVerificationKey,
} from "./gpu_parent_runtime_proof_admission_receipt.js";

export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_trust_material.v1" as const;
export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY =
  "live_mcp_control_channel_trust_material_only_not_gpu_hmr_acceptance" as const;

export interface GpuParentRuntimeProofAdmissionAuthorityContext {
  readonly privateKey?: KeyObject;
  readonly validationRunChallenge?: string;
  readonly clockUnixNs?: () => bigint;
  readonly nonceBytes?: () => Uint8Array;
}

export interface GpuParentRuntimeProofAdmissionTrustMaterial {
  readonly schemaVersion:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA;
  readonly proofAuthority:
    typeof GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY;
  readonly verificationKey:
    GpuParentRuntimeProofAdmissionReceiptVerificationKey;
  readonly validationRunChallenge: string;
  readonly replayPolicyRequired: true;
  readonly freshnessPolicyRequired: true;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

interface AuthorityContextSnapshot {
  readonly privateKey: unknown;
  readonly validationRunChallenge: unknown;
  readonly clockUnixNs: unknown;
  readonly nonceBytes: unknown;
}

type AuthorityContextKey = keyof AuthorityContextSnapshot;

const CONTEXT_KEYS: ReadonlySet<string> = new Set<AuthorityContextKey>([
  "privateKey",
  "validationRunChallenge",
  "clockUnixNs",
  "nonceBytes",
]);

function snapshotContext(value: unknown): AuthorityContextSnapshot | null {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some(
      (key) => typeof key !== "string" || !CONTEXT_KEYS.has(key),
    )) {
      return null;
    }

    const snapshot: Record<AuthorityContextKey, unknown> = {
      privateKey: undefined,
      validationRunChallenge: undefined,
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
      snapshot[key as AuthorityContextKey] = descriptor.value;
    }
    return Object.freeze(snapshot);
  } catch {
    return null;
  }
}

function validPrivateKey(value: unknown): value is KeyObject {
  return value !== null
    && typeof value === "object"
    && !isProxy(value)
    && isKeyObject(value)
    && value.type === "private"
    && value.asymmetricKeyType === "ed25519";
}

function validCallback(value: unknown): value is () => unknown {
  return typeof value === "function" && !isProxy(value);
}

export class GpuParentRuntimeProofAdmissionAuthority {
  readonly #receiptSigner:
    GpuParentRuntimeProofAdmissionReceiptSigner;
  readonly #exportedTrustMaterial:
    GpuParentRuntimeProofAdmissionTrustMaterial;
  #disposed = false;

  constructor(contextValue: GpuParentRuntimeProofAdmissionAuthorityContext = {}) {
    const context = snapshotContext(contextValue);
    if (context === null) {
      throw new Error("gpu_parent_runtime_proof_admission_authority_context_invalid");
    }
    if (context.privateKey !== undefined && !validPrivateKey(context.privateKey)) {
      throw new Error("gpu_parent_runtime_proof_admission_authority_private_key_invalid");
    }
    if (
      context.validationRunChallenge !== undefined
      && typeof context.validationRunChallenge !== "string"
    ) {
      throw new Error("gpu_parent_runtime_proof_admission_authority_challenge_invalid");
    }
    if (context.clockUnixNs !== undefined && !validCallback(context.clockUnixNs)) {
      throw new Error("gpu_parent_runtime_proof_admission_authority_clock_invalid");
    }
    if (context.nonceBytes !== undefined && !validCallback(context.nonceBytes)) {
      throw new Error("gpu_parent_runtime_proof_admission_authority_nonce_source_invalid");
    }

    const privateKey = context.privateKey ?? generateKeyPairSync("ed25519").privateKey;
    let generatedChallenge: Buffer | null = null;
    const validationRunChallenge = context.validationRunChallenge ?? (() => {
      generatedChallenge = randomBytes(32);
      return generatedChallenge.toString("base64url");
    })();

    try {
      this.#receiptSigner = new GpuParentRuntimeProofAdmissionReceiptSigner({
        privateKey,
        validationRunChallenge,
        ...(context.clockUnixNs === undefined
          ? {}
          : { clockUnixNs: context.clockUnixNs as () => bigint }),
        ...(context.nonceBytes === undefined
          ? {}
          : { nonceBytes: context.nonceBytes as () => Uint8Array }),
      });
    } catch (error) {
      if (
        error instanceof Error
        && error.message
          === "gpu_parent_runtime_proof_admission_receipt_validation_run_challenge_invalid"
      ) {
        throw new Error("gpu_parent_runtime_proof_admission_authority_challenge_invalid");
      }
      throw error;
    } finally {
      generatedChallenge?.fill(0);
    }

    this.#exportedTrustMaterial = Object.freeze({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      verificationKey: this.#receiptSigner.exportVerificationKey(),
      validationRunChallenge,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  }

  signer(): GpuParentRuntimeProofAdmissionReceiptSigner {
    if (this.#disposed) {
      throw new Error("gpu_parent_runtime_proof_admission_authority_disposed");
    }
    return this.#receiptSigner;
  }

  trustMaterial(): GpuParentRuntimeProofAdmissionTrustMaterial {
    return this.#exportedTrustMaterial;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.#receiptSigner.dispose();
    this.#disposed = true;
  }
}
