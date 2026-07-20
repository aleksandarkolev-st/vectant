import { isProxy } from "node:util/types";
import {
  verifyGpuHmrMcpAdmissionReceipt,
} from "./gpu-hmr-mcp-admission-receipt-verifier.mjs";

export const GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_matrix_verification.v1";
export const GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY =
  "matrix_external_trust_signature_challenge_binding_freshness_and_replay_verification_support_only_not_gpu_hmr_acceptance";
export const GPU_HMR_MCP_ADMISSION_REPLAY_REGISTRY_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_replay_registry.v1";

const U64_MAX = 18_446_744_073_709_551_615n;
const DEFAULT_MAX_REPLAY_SCOPES = 4_096;
const DEFAULT_MAX_RECEIPTS_PER_SCOPE = 65_536;
const REPLAY_REGISTRY_OPTION_KEYS = Object.freeze([
  "maxScopes",
  "maxReceiptsPerScope",
]);
const VERIFICATION_CONTEXT_KEYS = Object.freeze([
  "trustedVerificationKey",
  "validationRunChallenge",
  "receipt",
  "nowUnixNs",
  "maxAgeNs",
  "maxFutureSkewNs",
  "replayRegistry",
  "expectedBinding",
]);
const EXPECTED_BINDING_KEYS = Object.freeze([
  "transportSessionId",
  "compileRequestNonce",
  "computeExpectedOutputContractHash",
  "computeExpectedOutputSemanticsHash",
  "artifactContentHash",
  "fullRuntimeProofId",
  "proofLedgerId",
  "runnerRuntimeSessionId",
]);

const replayRegistryStates = new WeakMap();
const verifiedProjections = new WeakMap();

function snapshotExactDataObject(value, requiredKeys) {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== requiredKeys.length) return null;
    const required = new Set(requiredKeys);
    if (ownKeys.some((key) => typeof key !== "string" || !required.has(key))) {
      return null;
    }
    const snapshot = {};
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

function canonicalUnixNs(value) {
  return typeof value === "bigint" && value >= 0n && value <= U64_MAX;
}

function snapshotOptionalDataObject(value, allowedKeys) {
  try {
    if (value === null || typeof value !== "object" || isProxy(value)) return null;
    if (Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
      return null;
    }
    const allowed = new Set(allowedKeys);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.some((key) => typeof key !== "string" || !allowed.has(key))) {
      return null;
    }
    const snapshot = {};
    for (const key of ownKeys) {
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

function positiveSafeInteger(value) {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0;
}

function refused(reason, details = {}) {
  return Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_SCHEMA,
    accepted: false,
    reason,
    proofAuthority: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY,
    signatureVerified: details.signatureVerified === true,
    challengeBound: details.challengeBound === true,
    bindingChecked: details.bindingChecked === true,
    freshnessChecked: details.freshnessChecked === true,
    replayChecked: details.replayChecked === true,
    receiptId: details.receiptId ?? null,
    signerKeyId: details.signerKeyId ?? null,
    replayScopeId: details.replayScopeId ?? null,
    admittedAtUnixNs: details.admittedAtUnixNs ?? null,
    sequence: details.sequence ?? null,
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
}

function accepted(verification, receipt) {
  const result = Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_SCHEMA,
    accepted: true,
    reason: null,
    proofAuthority: GPU_HMR_MCP_ADMISSION_MATRIX_VERIFICATION_AUTHORITY,
    signatureVerified: true,
    challengeBound: true,
    bindingChecked: true,
    freshnessChecked: true,
    replayChecked: true,
    receiptId: verification.receiptId,
    signerKeyId: verification.replayScope.signerKeyId,
    replayScopeId: verification.replayScope.replayScopeId,
    admittedAtUnixNs: verification.admittedAtUnixNs.toString(),
    sequence: verification.sequence.toString(),
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
  });
  verifiedProjections.set(result, Object.freeze({
    required: true,
    receiptId: verification.receiptId,
    contractHash: receipt.computeExpectedOutputContractHash,
    semanticsHash: receipt.computeExpectedOutputSemanticsHash,
    compileTransportNonce: receipt.compileRequestNonce,
    artifactContentHash: receipt.artifactContentHash,
    fullRuntimeProofId: receipt.fullRuntimeProofId,
    proofLedgerId: receipt.proofLedgerId,
    runtimeSessionId: receipt.runnerRuntimeSessionId,
  }));
  return result;
}

function matchingExpectedBinding(receipt, expectedBinding) {
  return EXPECTED_BINDING_KEYS.every(
    (key) => receipt[key] === expectedBinding[key],
  );
}

function consumeReplayState(registry, verification, receipt) {
  const registryState = replayRegistryStates.get(registry);
  if (registryState === undefined) {
    return "gpu_hmr_mcp_admission_replay_registry_invalid";
  }
  const scopeId = verification.replayScope.replayScopeId;
  const scope = registryState.scopes.get(scopeId);
  if (scope?.highestReceiptId === verification.receiptId) {
    return "gpu_hmr_mcp_admission_receipt_replayed";
  }
  if (scope !== undefined && verification.sequence <= scope.highestSequence) {
    return "gpu_hmr_mcp_admission_sequence_not_increasing";
  }
  if (scope?.nonces.has(receipt.nonce)) {
    return "gpu_hmr_mcp_admission_nonce_replayed";
  }

  if (scope === undefined) {
    if (registryState.scopes.size >= registryState.maxScopes) {
      return "gpu_hmr_mcp_admission_replay_scope_capacity_exhausted";
    }
    registryState.scopes.set(scopeId, {
      highestSequence: verification.sequence,
      highestReceiptId: verification.receiptId,
      nonces: new Set([receipt.nonce]),
    });
  } else {
    if (scope.nonces.size >= registryState.maxReceiptsPerScope) {
      return "gpu_hmr_mcp_admission_replay_scope_receipt_capacity_exhausted";
    }
    scope.highestSequence = verification.sequence;
    scope.highestReceiptId = verification.receiptId;
    scope.nonces.add(receipt.nonce);
  }
  return null;
}

export function createGpuHmrMcpAdmissionReplayRegistry(optionsValue = {}) {
  const options = snapshotOptionalDataObject(
    optionsValue,
    REPLAY_REGISTRY_OPTION_KEYS,
  );
  if (options === null) {
    throw new Error("gpu_hmr_mcp_admission_replay_registry_options_invalid");
  }
  const maxScopes = options.maxScopes ?? DEFAULT_MAX_REPLAY_SCOPES;
  const maxReceiptsPerScope =
    options.maxReceiptsPerScope ?? DEFAULT_MAX_RECEIPTS_PER_SCOPE;
  if (!positiveSafeInteger(maxScopes) || !positiveSafeInteger(maxReceiptsPerScope)) {
    throw new Error("gpu_hmr_mcp_admission_replay_registry_capacity_invalid");
  }
  const registry = Object.freeze({
    schemaVersion: GPU_HMR_MCP_ADMISSION_REPLAY_REGISTRY_SCHEMA,
    proofAuthority: "in_process_replay_state_only_not_gpu_hmr_acceptance",
    acceptedForGpuHmr: false,
    gpuHmrSuccess: false,
    canSatisfyRuntimeProof: false,
    maxScopes,
    maxReceiptsPerScope,
  });
  replayRegistryStates.set(registry, {
    scopes: new Map(),
    maxScopes,
    maxReceiptsPerScope,
  });
  return registry;
}

export function verifyGpuHmrMcpAdmissionReceiptForMatrix(contextValue) {
  const context = snapshotExactDataObject(
    contextValue,
    VERIFICATION_CONTEXT_KEYS,
  );
  if (context === null) {
    return refused("gpu_hmr_mcp_admission_matrix_context_invalid");
  }
  const expectedBinding = snapshotExactDataObject(
    context.expectedBinding,
    EXPECTED_BINDING_KEYS,
  );
  if (expectedBinding === null) {
    return refused("gpu_hmr_mcp_admission_expected_binding_invalid");
  }
  if (
    !canonicalUnixNs(context.nowUnixNs)
    || !canonicalUnixNs(context.maxAgeNs)
    || !canonicalUnixNs(context.maxFutureSkewNs)
  ) {
    return refused("gpu_hmr_mcp_admission_freshness_policy_invalid");
  }
  if (!replayRegistryStates.has(context.replayRegistry)) {
    return refused("gpu_hmr_mcp_admission_replay_registry_invalid");
  }

  const verification = verifyGpuHmrMcpAdmissionReceipt(
    context.trustedVerificationKey,
    context.receipt,
    context.validationRunChallenge,
  );
  if (verification?.verified !== true) {
    return refused(
      verification?.reason ?? "gpu_hmr_mcp_admission_signature_verification_failed",
    );
  }
  const receipt = snapshotExactDataObject(
    context.receipt,
    Reflect.ownKeys(context.receipt),
  );
  const verifiedDetails = {
    signatureVerified: true,
    challengeBound: true,
    receiptId: verification.receiptId,
    signerKeyId: verification.replayScope.signerKeyId,
    replayScopeId: verification.replayScope.replayScopeId,
    admittedAtUnixNs: verification.admittedAtUnixNs.toString(),
    sequence: verification.sequence.toString(),
  };
  if (receipt === null || !matchingExpectedBinding(receipt, expectedBinding)) {
    return refused("gpu_hmr_mcp_admission_signed_binding_mismatch", {
      ...verifiedDetails,
      bindingChecked: true,
    });
  }

  const admittedAt = verification.admittedAtUnixNs;
  const now = context.nowUnixNs;
  if (admittedAt > now && admittedAt - now > context.maxFutureSkewNs) {
    return refused("gpu_hmr_mcp_admission_receipt_from_future", {
      ...verifiedDetails,
      bindingChecked: true,
      freshnessChecked: true,
    });
  }
  if (now > admittedAt && now - admittedAt > context.maxAgeNs) {
    return refused("gpu_hmr_mcp_admission_receipt_stale", {
      ...verifiedDetails,
      bindingChecked: true,
      freshnessChecked: true,
    });
  }

  const replayReason = consumeReplayState(
    context.replayRegistry,
    verification,
    receipt,
  );
  if (replayReason !== null) {
    return refused(replayReason, {
      ...verifiedDetails,
      bindingChecked: true,
      freshnessChecked: true,
      replayChecked: true,
    });
  }
  return accepted(verification, receipt);
}

export function verifiedGpuHmrMcpAdmissionReceiptProjection(value) {
  return verifiedProjections.get(value) ?? null;
}
