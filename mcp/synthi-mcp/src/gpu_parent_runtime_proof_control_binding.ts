import { createHash } from "node:crypto";
import {
  canonicalizeGpuParentRuntimeProofJson,
  parseGpuParentRuntimeOutputOracleCommitment,
  type GpuParentRuntimeProofExpectedBinding,
} from "./gpu_parent_runtime_proof.js";
import type {
  RuntimeEvidenceTransportReceiptConsumer,
  RuntimeEvidenceTransportSupportVerification,
} from "./runtime_evidence_transport.js";

export const GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SCHEMA_VERSION =
  "synthi.gpu_hmr.parent_runtime_proof_control_binding.v4";
export const GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE =
  "gpu_hmr_parent_runtime_proof_control_binding";
export const GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_AUTHORITY =
  "parent_signed_compile_correlated_runtime_proof_binding_only_not_gpu_hmr_acceptance";
export const GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SUBJECT_SCHEMA_VERSION =
  "synthi.gpu_hmr.parent_runtime_proof_control_binding_subject.v4";

const VALIDATION_SCHEMA =
  "synthi.gpu_hmr.parent_runtime_proof_control_binding_verification.v1";
const BINDING_ID_PREFIX = "gpu-parent-runtime-proof-control-binding:";
const TRANSPORT_RECEIPT_PREFIX =
  "gpu-hmr-runtime-evidence-transport-receipt:";
const MAX_PROCESS_ID = 0xffff_ffff;

const CONTROL_BINDING_KEYS = [
  "schemaVersion",
  "type",
  "proofAuthority",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
  "compileSessionId",
  "compileRequestNonce",
  "requestId",
  "sourceEditId",
  "artifactContentHash",
  "fullRuntimeProofId",
  "proofLedgerId",
  "protectedProofJsonSha256",
  "canonicalProofSha256",
  "runnerPid",
  "runnerRuntimeSessionId",
  "runnerChallenge",
  "commandEnvelopeSha256",
  "prepublicationOutputOracleCommitment",
  "computeExpectedOutputContractHash",
  "computeExpectedOutputSemanticsHash",
  "parentPid",
  "bindingCanonicalSha256",
  "bindingId",
  "runtimeEvidenceTransportEnvelope",
] as const;

const BINDING_METADATA_KEYS = new Set<string>([
  "bindingCanonicalSha256",
  "bindingId",
  "runtimeEvidenceTransportEnvelope",
]);

const CONTEXT_KEYS = [
  "transportSessionId",
  "compileRequestNonce",
  "expectedWorkerProcessId",
  "receiptConsumer",
] as const;

const SUPPORT_VERIFICATION_KEYS = [
  "verified",
  "reason",
  "receiptId",
  "observationContextHash",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const;

export type GpuParentRuntimeProofControlBindingReceiptConsumer = Pick<
  RuntimeEvidenceTransportReceiptConsumer,
  "consumeSupportEnvelope"
>;

export interface GpuParentRuntimeProofControlBindingVerificationContext {
  readonly transportSessionId: string;
  readonly compileRequestNonce: string;
  readonly expectedWorkerProcessId: string;
  readonly receiptConsumer: GpuParentRuntimeProofControlBindingReceiptConsumer;
}

export interface GpuParentRuntimeProofControlBindingValidationEvidence {
  readonly bindingId: string | null;
  readonly bindingCanonicalSha256: string | null;
  readonly transportReceiptId: string | null;
  readonly observationContextHash: string | null;
}

interface GpuParentRuntimeProofControlBindingValidationBase {
  readonly schemaVersion: typeof VALIDATION_SCHEMA;
  readonly code: string;
  readonly evidence: GpuParentRuntimeProofControlBindingValidationEvidence;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuParentRuntimeProofControlBindingVerified
extends GpuParentRuntimeProofControlBindingValidationBase {
  readonly verified: true;
  readonly code: "gpu_parent_runtime_proof_control_binding_verified";
  readonly reason: null;
  readonly expectedBinding: GpuParentRuntimeProofExpectedBinding;
  readonly computeExpectedOutputContractHash: string | null;
  readonly computeExpectedOutputSemanticsHash: string | null;
}

export interface GpuParentRuntimeProofControlBindingRefused
extends GpuParentRuntimeProofControlBindingValidationBase {
  readonly verified: false;
  readonly reason: string;
}

export type GpuParentRuntimeProofControlBindingValidation =
  | GpuParentRuntimeProofControlBindingVerified
  | GpuParentRuntimeProofControlBindingRefused;

type ExactRecord = Record<string, unknown>;

function exactDataRecord(
  value: unknown,
  expectedKeys: readonly string[],
): ExactRecord | null {
  try {
    if (
      value === null
      || typeof value !== "object"
      || Array.isArray(value)
      || Object.getPrototypeOf(value) !== Object.prototype
    ) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (
      ownKeys.length !== expectedKeys.length
      || ownKeys.some((key) => typeof key !== "string")
      || !expectedKeys.every((key) => ownKeys.includes(key))
    ) {
      return null;
    }

    const snapshot: ExactRecord = {};
    for (const key of expectedKeys) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        descriptor === undefined
        || !("value" in descriptor)
        || descriptor.enumerable !== true
      ) {
        return null;
      }
      snapshot[key] = descriptor.value;
    }
    return snapshot;
  } catch {
    return null;
  }
}

function canonicalToken(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 512
    && /^[\x21-\x7e]+$/.test(value);
}

function canonicalSha256(value: unknown): value is string {
  return typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value);
}

function canonicalPrefixedSha256(value: unknown, prefix: string): value is string {
  return typeof value === "string"
    && value.startsWith(prefix)
    && canonicalSha256(value.slice(prefix.length));
}

function canonicalProcessNumber(value: unknown): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value >= 1
    && value <= MAX_PROCESS_ID;
}

function normalizeExternalProcessId(value: unknown): string | null {
  if (typeof value !== "string" || !/^[1-9][0-9]*$/.test(value)) return null;
  try {
    const parsed = BigInt(value);
    return parsed <= BigInt(MAX_PROCESS_ID) ? value : null;
  } catch {
    return null;
  }
}

function validCompileRequestNonce(value: unknown): value is string {
  return typeof value === "string"
    && /^gpu-proof-transport-request:[a-f0-9]{32}$/.test(value);
}

function validBindingFieldShapes(binding: ExactRecord): boolean {
  const commitment = parseGpuParentRuntimeOutputOracleCommitment(
    binding.prepublicationOutputOracleCommitment,
  );
  return commitment !== undefined
    && (commitment === null || (
      commitment.candidateArtifactSha256 === binding.artifactContentHash
      && commitment.editId === binding.sourceEditId
    ))
    && canonicalToken(binding.compileSessionId)
    && validCompileRequestNonce(binding.compileRequestNonce)
    && typeof binding.requestId === "string"
    && /^gpu-reload:request:[a-f0-9]{32}$/.test(binding.requestId)
    && canonicalPrefixedSha256(binding.sourceEditId, "source-edit:")
    && canonicalSha256(binding.artifactContentHash)
    && canonicalPrefixedSha256(binding.fullRuntimeProofId, "gpu-runtime-proof:")
    && canonicalPrefixedSha256(binding.proofLedgerId, "gpu-ledger-proof:")
    && canonicalSha256(binding.protectedProofJsonSha256)
    && canonicalSha256(binding.canonicalProofSha256)
    && canonicalProcessNumber(binding.runnerPid)
    && canonicalToken(binding.runnerRuntimeSessionId)
    && typeof binding.runnerChallenge === "string"
    && /^[a-f0-9]{32}$/.test(binding.runnerChallenge)
    && canonicalSha256(binding.commandEnvelopeSha256)
    && (
      binding.computeExpectedOutputContractHash === null
      || canonicalSha256(binding.computeExpectedOutputContractHash)
    )
    && (
      binding.computeExpectedOutputSemanticsHash === null
      || canonicalSha256(binding.computeExpectedOutputSemanticsHash)
    )
    && canonicalProcessNumber(binding.parentPid)
    && canonicalSha256(binding.bindingCanonicalSha256)
    && canonicalPrefixedSha256(binding.bindingId, BINDING_ID_PREFIX);
}

function reconstructBasePayload(binding: ExactRecord): ExactRecord {
  const basePayload: ExactRecord = {};
  for (const key of CONTROL_BINDING_KEYS) {
    if (!BINDING_METADATA_KEYS.has(key)) basePayload[key] = binding[key];
  }
  return basePayload;
}

function sha256(value: Uint8Array | string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value as Record<string, unknown>)) {
      deepFreeze(child);
    }
    Object.freeze(value);
  }
  return value;
}

function emptyEvidence(): GpuParentRuntimeProofControlBindingValidationEvidence {
  return {
    bindingId: null,
    bindingCanonicalSha256: null,
    transportReceiptId: null,
    observationContextHash: null,
  };
}

function refusal(
  code: string,
): GpuParentRuntimeProofControlBindingRefused {
  return deepFreeze({
    schemaVersion: VALIDATION_SCHEMA,
    verified: false,
    code,
    reason: code,
    evidence: emptyEvidence(),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function verified(
  binding: ExactRecord,
  bindingId: string,
  bindingCanonicalSha256: string,
  transportReceiptId: string,
  observationContextHash: string,
): GpuParentRuntimeProofControlBindingVerified {
  return deepFreeze({
    schemaVersion: VALIDATION_SCHEMA,
    verified: true,
    code: "gpu_parent_runtime_proof_control_binding_verified",
    reason: null,
    evidence: {
      bindingId,
      bindingCanonicalSha256,
      transportReceiptId,
      observationContextHash,
    },
    expectedBinding: {
      requestId: binding.requestId as string,
      sourceEditId: binding.sourceEditId as string,
      artifactContentHash: binding.artifactContentHash as string,
      fullRuntimeProofId: binding.fullRuntimeProofId as string,
      proofLedgerId: binding.proofLedgerId as string,
      runnerProcessId: binding.runnerPid as number,
      runnerRuntimeSessionId: binding.runnerRuntimeSessionId as string,
      runnerChallenge: binding.runnerChallenge as string,
      commandEnvelopeSha256: binding.commandEnvelopeSha256 as string,
      computeExpectedOutputSemanticsHash:
        binding.computeExpectedOutputSemanticsHash as string | null,
      prepublicationOutputOracleCommitment:
        parseGpuParentRuntimeOutputOracleCommitment(
          binding.prepublicationOutputOracleCommitment,
        ) ?? null,
    },
    computeExpectedOutputContractHash:
      binding.computeExpectedOutputContractHash as string | null,
    computeExpectedOutputSemanticsHash:
      binding.computeExpectedOutputSemanticsHash as string | null,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

type ParsedSupportVerification =
  | Readonly<{
      status: "verified";
      receiptId: string;
      observationContextHash: string;
    }>
  | Readonly<{ status: "refused" }>
  | Readonly<{ status: "invalid" }>;

function parseSupportVerification(
  value: RuntimeEvidenceTransportSupportVerification,
): ParsedSupportVerification {
  const result = exactDataRecord(value, SUPPORT_VERIFICATION_KEYS);
  if (
    result === null
    || result.acceptedForGpuHmr !== false
    || result.gpuHmrSuccess !== false
    || result.canSatisfyRuntimeProof !== false
  ) {
    return { status: "invalid" };
  }
  if (result.verified === false) {
    return canonicalToken(result.reason)
      && result.receiptId === null
      && result.observationContextHash === null
      ? { status: "refused" }
      : { status: "invalid" };
  }
  if (
    result.verified !== true
    || result.reason !== null
    || !canonicalPrefixedSha256(result.receiptId, TRANSPORT_RECEIPT_PREFIX)
    || !canonicalSha256(result.observationContextHash)
  ) {
    return { status: "invalid" };
  }
  return {
    status: "verified",
    receiptId: result.receiptId,
    observationContextHash: result.observationContextHash,
  };
}

/**
 * Verifies the worker's signed compile-correlated control binding without
 * applying any project, fixture, kernel, or GPU-HMR acceptance policy.
 */
export function verifyGpuParentRuntimeProofControlBinding(
  rawBinding: unknown,
  rawContext: GpuParentRuntimeProofControlBindingVerificationContext,
): GpuParentRuntimeProofControlBindingValidation {
  const context = exactDataRecord(rawContext, CONTEXT_KEYS);
  if (context === null) {
    return refusal("gpu_parent_runtime_proof_control_binding_external_context_invalid");
  }
  const expectedWorkerProcessId = normalizeExternalProcessId(
    context.expectedWorkerProcessId,
  );
  const receiptConsumer = context.receiptConsumer as
    | GpuParentRuntimeProofControlBindingReceiptConsumer
    | null;
  let consumeSupportEnvelope: unknown;
  try {
    consumeSupportEnvelope = receiptConsumer?.consumeSupportEnvelope;
  } catch {
    consumeSupportEnvelope = null;
  }
  if (
    !canonicalToken(context.transportSessionId)
    || !validCompileRequestNonce(context.compileRequestNonce)
    || expectedWorkerProcessId === null
    || receiptConsumer === null
    || (typeof receiptConsumer !== "object" && typeof receiptConsumer !== "function")
    || typeof consumeSupportEnvelope !== "function"
  ) {
    return refusal("gpu_parent_runtime_proof_control_binding_external_context_invalid");
  }

  const binding = exactDataRecord(rawBinding, CONTROL_BINDING_KEYS);
  if (binding === null) {
    return refusal("gpu_parent_runtime_proof_control_binding_shape_invalid");
  }
  if (
    binding.schemaVersion !== GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SCHEMA_VERSION
    || binding.type !== GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_TYPE
    || binding.proofAuthority !== GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_AUTHORITY
    || binding.acceptedForGpuHmr !== false
    || binding.gpuHmrSuccess !== false
    || binding.canSatisfyRuntimeProof !== false
  ) {
    return refusal("gpu_parent_runtime_proof_control_binding_authority_invalid");
  }
  if (!validBindingFieldShapes(binding)) {
    return refusal("gpu_parent_runtime_proof_control_binding_field_invalid");
  }
  if (binding.compileSessionId !== context.transportSessionId) {
    return refusal("gpu_parent_runtime_proof_control_binding_transport_session_mismatch");
  }
  if (binding.compileRequestNonce !== context.compileRequestNonce) {
    return refusal("gpu_parent_runtime_proof_control_binding_compile_request_nonce_mismatch");
  }
  if (String(binding.parentPid) !== expectedWorkerProcessId) {
    return refusal("gpu_parent_runtime_proof_control_binding_worker_process_mismatch");
  }
  let canonicalBasePayload: Buffer;
  let bindingCanonicalSha256: string;
  try {
    canonicalBasePayload = Buffer.from(
      canonicalizeGpuParentRuntimeProofJson(reconstructBasePayload(binding)),
      "utf8",
    );
    bindingCanonicalSha256 = sha256(canonicalBasePayload);
  } catch {
    return refusal("gpu_parent_runtime_proof_control_binding_canonicalization_failed");
  }
  if (binding.bindingCanonicalSha256 !== bindingCanonicalSha256) {
    return refusal("gpu_parent_runtime_proof_control_binding_canonical_hash_mismatch");
  }
  const expectedBindingId = `${BINDING_ID_PREFIX}${bindingCanonicalSha256}`;
  if (binding.bindingId !== expectedBindingId) {
    return refusal("gpu_parent_runtime_proof_control_binding_id_mismatch");
  }

  let rawReceiptVerification: RuntimeEvidenceTransportSupportVerification;
  try {
    rawReceiptVerification = receiptConsumer.consumeSupportEnvelope({
      envelope: binding.runtimeEvidenceTransportEnvelope,
      observedPayload: canonicalBasePayload,
      runnerProcessId: binding.runnerPid as number,
      runtimeSessionId: binding.runnerRuntimeSessionId as string,
      runnerChallenge: binding.runnerChallenge as string,
      transportSessionId: context.transportSessionId as string,
      requestId: binding.requestId as string,
      sourceEditId: binding.sourceEditId as string,
      subjectIdentityNamespace:
        GPU_PARENT_RUNTIME_PROOF_CONTROL_BINDING_SUBJECT_SCHEMA_VERSION,
      subjectCanonicalBytes: canonicalBasePayload,
      artifactContentHash: binding.artifactContentHash as string,
      observedRuntimeProofId: binding.fullRuntimeProofId as string,
      observedProofLedgerId: binding.proofLedgerId as string,
    });
  } catch {
    return refusal("gpu_parent_runtime_proof_control_binding_receipt_consumer_failed");
  }

  const receiptVerification = parseSupportVerification(rawReceiptVerification);
  if (receiptVerification.status === "refused") {
    return refusal("gpu_parent_runtime_proof_control_binding_receipt_consumer_refused");
  }
  if (receiptVerification.status === "invalid") {
    return refusal("gpu_parent_runtime_proof_control_binding_receipt_result_invalid");
  }

  return verified(
    binding,
    expectedBindingId,
    bindingCanonicalSha256,
    receiptVerification.receiptId,
    receiptVerification.observationContextHash,
  );
}
