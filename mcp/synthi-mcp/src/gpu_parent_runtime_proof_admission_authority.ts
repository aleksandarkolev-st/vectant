import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  type KeyObject,
} from "node:crypto";
import { isKeyObject, isProxy } from "node:util/types";
import * as sharedOnlineReplayAuthorityModule
  from "../scripts/lib/gpu-hmr-mcp-admission-online-replay-authority.mjs";
import {
  GpuParentRuntimeProofAdmissionReceiptSigner,
  gpuParentRuntimeProofAdmissionOutputContractBinding,
  verifyGpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceipt,
  type GpuParentRuntimeProofAdmissionReceiptVerificationKey,
} from "./gpu_parent_runtime_proof_admission_receipt.js";
import {
  GpuMcpOutputObservationReceiptSigner,
  type GpuMcpOutputObservationReceipt,
} from "./gpu_mcp_output_observation_receipt.js";
import {
  claimGpuMcpOutputByteConsumerCapability,
  disposeGpuMcpOutputByteConsumerClaim,
  issueGpuMcpOutputByteObservationPermit,
  releaseGpuMcpOutputByteConsumerClaim,
  takeGpuMcpObservedOutputBytes,
  type GpuMcpObservedOutputBytes,
  type GpuMcpOutputByteConsumerCapability,
  type GpuMcpOutputByteConsumerClaim,
  type GpuMcpOutputByteObservationPermit,
} from "./gpu_mcp_output_byte_observation_boundary.js";
import {
  claimGpuMcpOutputEvaluatorExecutorCapability,
  disposeGpuMcpOutputEvaluatorExecutorClaim,
  evaluateGpuMcpOutputBytes,
  gpuMcpOutputEvaluatorCapabilityMatchesExecutorClaim,
  GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_AUTHORITY,
  GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA,
  releaseGpuMcpOutputEvaluatorExecutorClaim,
  snapshotGpuMcpOutputEvaluatorMaterialBytes,
  type GpuMcpOutputEvaluation,
  type GpuMcpOutputEvaluatorCapability,
  type GpuMcpOutputEvaluatorExecutorCapability,
  type GpuMcpOutputEvaluatorExecutorClaim,
} from "./gpu_mcp_output_evaluation.js";
import {
  executeReopenedGpuMcpOutputEvaluatorMaterialInFreshProcess,
  executeGpuMcpOutputEvaluatorInFreshProcess,
  GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY,
  GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA,
  type GpuMcpOutputEvaluatorFreshProcessOptions,
  type GpuMcpOutputEvaluatorFreshProcessExecution,
} from "./gpu_mcp_output_evaluator_fresh_process.js";

export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA =
  "synthi.gpu_hmr.mcp_admission_trust_material.v3" as const;
export const GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY =
  "live_mcp_control_channel_trust_material_only_not_gpu_hmr_acceptance" as const;
export const GPU_PARENT_RUNTIME_PROOF_OUTPUT_OBSERVATION_SCHEMA =
  "synthi.gpu_hmr.parent_output_observation.v1" as const;
export const GPU_PARENT_RUNTIME_PROOF_OUTPUT_OBSERVATION_AUTHORITY =
  "live_mcp_session_admission_and_output_byte_observation_support_only_not_gpu_hmr_acceptance" as const;
export const GPU_PARENT_RUNTIME_PROOF_OUTPUT_EVALUATION_RECEIPT_SCHEMA =
  "synthi.gpu_hmr.parent_output_evaluation_receipt.v1" as const;
export const GPU_PARENT_RUNTIME_PROOF_OUTPUT_EVALUATION_RECEIPT_AUTHORITY =
  "live_parent_admission_bound_output_evaluation_support_only_not_gpu_hmr_acceptance" as const;
export const GPU_PARENT_RUNTIME_PROOF_FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_SCHEMA =
  "synthi.gpu_hmr.parent_fresh_process_output_evaluation_receipt.v2" as const;
export const GPU_PARENT_RUNTIME_PROOF_FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_AUTHORITY =
  "live_parent_admission_bound_fresh_process_output_evaluation_support_only_not_gpu_hmr_acceptance" as const;

const U64_MAX = 18_446_744_073_709_551_615n;
const DEFAULT_MAX_RECEIPT_AGE_NS = 30_000_000_000n;
const DEFAULT_MAX_FUTURE_SKEW_NS = 1_000_000_000n;
const MAX_ONLINE_REPLAY_SCOPES = 65_536;
const MAX_ONLINE_REPLAY_RECEIPTS_PER_SCOPE = 65_536;
const MAX_ONLINE_REPLAY_OPERATIONS = 262_144;
const MAX_ONLINE_REPLAY_OPERATION_TIMEOUT_MS = 60_000;
const OUTPUT_EVALUATION_RECEIPT_ID_DOMAIN =
  "synthi.gpu_hmr.parent_output_evaluation_receipt.id.v1";
const FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_ID_DOMAIN =
  "synthi.gpu_hmr.parent_fresh_process_output_evaluation_receipt.id.v2";
const freeze = Object.freeze;
const reflectApply = Reflect.apply;
const jsonStringify = JSON.stringify;
const createHashIntrinsic = createHash;
const hashPrototype = Object.getPrototypeOf(
  createHashIntrinsic("sha256"),
);
const hashUpdate = hashPrototype.update as Function;
const hashDigest = hashPrototype.digest as Function;
const uint8ArrayFill = Uint8Array.prototype.fill;

function requiredGetter(
  prototype: object,
  property: string,
): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  if (getter === undefined) {
    throw new Error(
      "gpu_parent_runtime_proof_admission_authority_intrinsics_unavailable",
    );
  }
  return getter;
}

const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayByteLengthGetter =
  requiredGetter(typedArrayPrototype, "byteLength");
const weakMapGet = WeakMap.prototype.get;
const weakMapSet = WeakMap.prototype.set;

function getWeakMapValue<K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
): V | undefined {
  return reflectApply(weakMapGet, map, [key]) as V | undefined;
}

function setWeakMapValue<K extends object, V>(
  map: WeakMap<K, V>,
  key: K,
  value: V,
): void {
  reflectApply(weakMapSet, map, [key, value]);
}

function sha256Hex(
  ...values: readonly (string | Uint8Array)[]
): string {
  const hash = createHashIntrinsic("sha256");
  for (const value of values) {
    reflectApply(
      hashUpdate,
      hash,
      typeof value === "string" ? [value, "utf8"] : [value],
    );
  }
  return reflectApply(hashDigest, hash, ["hex"]) as string;
}

function clearBytes(bytes: Uint8Array | null): void {
  if (bytes === null) return;
  try {
    reflectApply(uint8ArrayFill, bytes, [0]);
  } catch {
    // Detached buffers expose no bytes to clear.
  }
}

function outputEvaluationReceiptId(
  content: object,
): string {
  const canonical = jsonStringify(content);
  if (canonical === undefined) {
    throw new Error(
      "gpu_parent_runtime_proof_output_evaluation_receipt_unavailable",
    );
  }
  const digest = sha256Hex(
    OUTPUT_EVALUATION_RECEIPT_ID_DOMAIN,
    "\0",
    canonical,
  );
  return `gpu-mcp-output-evaluation-receipt:sha256:${digest}`;
}

function createOutputEvaluationReceipt(
  evaluation: GpuMcpOutputEvaluation,
  admissionReceiptId: string,
  outputObservationReceiptId: string,
  materialBytes: Uint8Array,
): GpuParentRuntimeProofOutputEvaluationReceipt {
  const material = evaluation.evaluatorMaterial;
  const materialByteLength = reflectApply(
    typedArrayByteLengthGetter,
    materialBytes,
    [],
  ) as number;
  const materialSha256 = `sha256:${sha256Hex(materialBytes)}`;
  if (
    evaluation.admissionReceiptId !== admissionReceiptId
    || evaluation.outputObservationReceiptId !== outputObservationReceiptId
    || material.schemaVersion !== GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA
    || material.proofAuthority
      !== GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_AUTHORITY
    || material.materialSha256 !== materialSha256
    || material.materialByteLength !== String(materialByteLength)
    || material.evaluatorFunctionSourceSha256
      !== evaluation.evaluatorFunctionSourceSha256
    || material.outputContractSha256 !== evaluation.outputContractSha256
    || material.outputSemanticsSha256 !== evaluation.outputSemanticsSha256
    || material.isolatedExecutionRequired !== true
    || material.isolatedExecutionVerified !== false
    || material.acceptedForGpuHmr !== false
    || material.gpuHmrSuccess !== false
    || material.canSatisfyRuntimeProof !== false
    || evaluation.acceptedForGpuHmr !== false
    || evaluation.gpuHmrSuccess !== false
    || evaluation.canSatisfyRuntimeProof !== false
  ) {
    throw new Error(
      "gpu_parent_runtime_proof_output_evaluation_material_binding_mismatch",
    );
  }
  const content = freeze({
    schemaVersion:
      GPU_PARENT_RUNTIME_PROOF_OUTPUT_EVALUATION_RECEIPT_SCHEMA,
    proofAuthority:
      GPU_PARENT_RUNTIME_PROOF_OUTPUT_EVALUATION_RECEIPT_AUTHORITY,
    evaluatorMaterialSchemaVersion: material.schemaVersion,
    evaluatorMaterialSha256: material.materialSha256,
    evaluatorMaterialByteLength: material.materialByteLength,
    evaluatorFunctionSourceSha256:
      evaluation.evaluatorFunctionSourceSha256,
    evaluatorSourceSha256: material.evaluatorSourceSha256,
    outputContractSha256: evaluation.outputContractSha256,
    outputSemanticsSha256: evaluation.outputSemanticsSha256,
    admissionReceiptId,
    outputObservationReceiptId,
    outputContentSha256: evaluation.outputContentSha256,
    outputByteLength: evaluation.outputByteLength,
    evaluatedAtMonotonicNs: evaluation.evaluatedAtMonotonicNs,
    outputContractPassed: evaluation.outputContractPassed,
    materialBytesChecked: true as const,
    liveAdmissionBindingChecked: true as const,
    isolatedExecutionRequired: true as const,
    isolatedExecutionVerified: false as const,
    acceptedForGpuHmr: false as const,
    gpuHmrSuccess: false as const,
    canSatisfyRuntimeProof: false as const,
  });
  return freeze({
    ...content,
    receiptId: outputEvaluationReceiptId(content),
  });
}

function freshProcessOutputEvaluationReceiptId(
  content: object,
): string {
  const canonical = jsonStringify(content);
  if (canonical === undefined) {
    throw new Error(
      "gpu_parent_runtime_proof_fresh_process_output_evaluation_receipt_unavailable",
    );
  }
  const digest = sha256Hex(
    FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_ID_DOMAIN,
    "\0",
    canonical,
  );
  return `gpu-mcp-fresh-process-output-evaluation-receipt:sha256:${digest}`;
}

function createFreshProcessOutputEvaluationReceipt(
  execution: GpuMcpOutputEvaluatorFreshProcessExecution,
  reopenedInputExecution: GpuMcpOutputEvaluatorFreshProcessExecution,
  admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  outputObservationReceipt: GpuMcpOutputObservationReceipt,
): GpuParentRuntimeProofFreshProcessOutputEvaluationReceipt {
  const outputContractBinding =
    gpuParentRuntimeProofAdmissionOutputContractBinding(admissionReceipt);
  if (
    execution.schemaVersion
      !== GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA
    || execution.proofAuthority
      !== GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY
    || execution.outputContractSha256
      !== outputContractBinding.outputContractSha256
    || execution.outputSemanticsSha256
      !== outputContractBinding.outputSemanticsSha256
    || execution.outputContentSha256
      !== outputObservationReceipt.outputContentSha256
    || execution.outputByteLength
      !== outputObservationReceipt.outputByteLength
    || execution.freshProcessExecutionObserved !== true
    || execution.parentClosureUnavailable !== true
    || execution.staticExecutionGraphVerified !== true
    || execution.loadedGraphIdentityAttested !== false
    || execution.loadedGraphIdentityGap
      !== "runtime_loaded_graph_identity_attestation_missing"
    || execution.isolatedExecutionVerified !== false
    || execution.containerAttestationVerified !== false
    || execution.acceptedForGpuHmr !== false
    || execution.gpuHmrSuccess !== false
    || execution.canSatisfyRuntimeProof !== false
    || !freshProcessExecutionsMatch(
      execution,
      reopenedInputExecution,
    )
  ) {
    throw new Error(
      "gpu_parent_runtime_proof_fresh_process_output_evaluation_binding_mismatch",
    );
  }
  const executionCanonical = jsonStringify(execution);
  const reopenedInputExecutionCanonical =
    jsonStringify(reopenedInputExecution);
  if (
    executionCanonical === undefined
    || reopenedInputExecutionCanonical === undefined
  ) {
    throw new Error(
      "gpu_parent_runtime_proof_fresh_process_output_evaluation_receipt_unavailable",
    );
  }
  const content = freeze({
    schemaVersion:
      GPU_PARENT_RUNTIME_PROOF_FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_SCHEMA,
    proofAuthority:
      GPU_PARENT_RUNTIME_PROOF_FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_AUTHORITY,
    freshProcessExecutionSchemaVersion: execution.schemaVersion,
    freshProcessExecutionAuthority: execution.proofAuthority,
    freshProcessExecutionHash: `sha256:${sha256Hex(executionCanonical)}`,
    reopenedInputExecutionHash:
      `sha256:${sha256Hex(reopenedInputExecutionCanonical)}`,
    reopenedInputProcessObservationHash:
      reopenedInputExecution.processObservationHash,
    reopenedInputResultContentSha256:
      reopenedInputExecution.resultContentSha256,
    reopenedInputResultByteLength:
      reopenedInputExecution.resultByteLength,
    reopenedInputExecutionStartedMonotonicNs:
      reopenedInputExecution.executionStartedMonotonicNs,
    reopenedInputExecutionFinishedMonotonicNs:
      reopenedInputExecution.executionFinishedMonotonicNs,
    evaluatorMaterialSha256: execution.evaluatorMaterialSha256,
    evaluatorMaterialByteLength: execution.evaluatorMaterialByteLength,
    evaluatorFunctionSourceSha256:
      execution.evaluatorFunctionSourceSha256,
    evaluatorSourceSha256: execution.evaluatorSourceSha256,
    outputContractSha256: execution.outputContractSha256,
    outputSemanticsSha256: execution.outputSemanticsSha256,
    admissionReceiptId: admissionReceipt.receiptId,
    outputObservationReceiptId: outputObservationReceipt.receiptId,
    outputContentSha256: execution.outputContentSha256,
    outputByteLength: execution.outputByteLength,
    executionEntrypointSha256: execution.executionEntrypointSha256,
    executionEntrypointByteLength:
      execution.executionEntrypointByteLength,
    executionGraphHash: execution.executionGraphHash,
    processObservationHash: execution.processObservationHash,
    resultContentSha256: execution.resultContentSha256,
    resultByteLength: execution.resultByteLength,
    executionStartedMonotonicNs:
      execution.executionStartedMonotonicNs,
    executionFinishedMonotonicNs:
      execution.executionFinishedMonotonicNs,
    timeoutMs: execution.timeoutMs,
    timedOut: false as const,
    exitCode: 0 as const,
    outputContractPassed: execution.outputContractPassed,
    freshProcessExecutionObserved: true as const,
    parentClosureUnavailable: true as const,
    staticExecutionGraphVerified: true as const,
    loadedGraphIdentityAttested: false as const,
    loadedGraphIdentityGap:
      "runtime_loaded_graph_identity_attestation_missing" as const,
    liveAdmissionBindingChecked: true as const,
    outputObservationBindingChecked: true as const,
    evaluatorMaterialBytesReopened: true as const,
    outputBytesReopened: true as const,
    reopenedInputExecutionBindingChecked: true as const,
    isolatedExecutionVerified: false as const,
    containerAttestationVerified: false as const,
    acceptedForGpuHmr: false as const,
    gpuHmrSuccess: false as const,
    canSatisfyRuntimeProof: false as const,
  });
  return freeze({
    ...content,
    receiptId: freshProcessOutputEvaluationReceiptId(content),
  });
}

const REEXECUTION_STABLE_FIELDS = [
  "schemaVersion",
  "proofAuthority",
  "evaluatorMaterialSha256",
  "evaluatorMaterialByteLength",
  "evaluatorFunctionSourceSha256",
  "evaluatorSourceSha256",
  "outputContractSha256",
  "outputSemanticsSha256",
  "outputContentSha256",
  "outputByteLength",
  "executionEntrypointSha256",
  "executionEntrypointByteLength",
  "executionGraphHash",
  "resultContentSha256",
  "resultByteLength",
  "timeoutMs",
  "timedOut",
  "exitCode",
  "outputContractPassed",
  "freshProcessExecutionObserved",
  "parentClosureUnavailable",
  "staticExecutionGraphVerified",
  "loadedGraphIdentityAttested",
  "loadedGraphIdentityGap",
  "isolatedExecutionVerified",
  "containerAttestationVerified",
  "acceptedForGpuHmr",
  "gpuHmrSuccess",
  "canSatisfyRuntimeProof",
] as const satisfies readonly (
  keyof GpuMcpOutputEvaluatorFreshProcessExecution
)[];

function freshProcessExecutionsMatch(
  execution: GpuMcpOutputEvaluatorFreshProcessExecution,
  reopenedInputExecution: GpuMcpOutputEvaluatorFreshProcessExecution,
): boolean {
  return REEXECUTION_STABLE_FIELDS.every(
    (field) => execution[field] === reopenedInputExecution[field],
  );
}

export interface GpuParentRuntimeProofOutputObservation {
  readonly schemaVersion:
    typeof GPU_PARENT_RUNTIME_PROOF_OUTPUT_OBSERVATION_SCHEMA;
  readonly proofAuthority:
    typeof GPU_PARENT_RUNTIME_PROOF_OUTPUT_OBSERVATION_AUTHORITY;
  readonly receipt: GpuMcpOutputObservationReceipt;
  readonly trustedKeyOriginChecked: true;
  readonly admissionBindingChecked: true;
  readonly requestChallengeChecked: true;
  readonly runtimeBindingChecked: true;
  readonly outputBytesChecked: true;
  readonly admissionGenerationChecked: true;
  readonly producerObservationPermitChecked: true;
  readonly producerObservationTimeChecked: true;
  readonly postAdmissionObservationChecked: true;
  readonly replayChecked: false;
  readonly freshnessChecked: true;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuParentRuntimeProofOutputEvaluationReceipt {
  readonly schemaVersion:
    typeof GPU_PARENT_RUNTIME_PROOF_OUTPUT_EVALUATION_RECEIPT_SCHEMA;
  readonly proofAuthority:
    typeof GPU_PARENT_RUNTIME_PROOF_OUTPUT_EVALUATION_RECEIPT_AUTHORITY;
  readonly receiptId: string;
  readonly evaluatorMaterialSchemaVersion:
    typeof GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA;
  readonly evaluatorMaterialSha256: string;
  readonly evaluatorMaterialByteLength: string;
  readonly evaluatorFunctionSourceSha256: string;
  readonly evaluatorSourceSha256: string;
  readonly outputContractSha256: string;
  readonly outputSemanticsSha256: string | null;
  readonly admissionReceiptId: string;
  readonly outputObservationReceiptId: string;
  readonly outputContentSha256: string;
  readonly outputByteLength: string;
  readonly evaluatedAtMonotonicNs: string;
  readonly outputContractPassed: boolean;
  readonly materialBytesChecked: true;
  readonly liveAdmissionBindingChecked: true;
  readonly isolatedExecutionRequired: true;
  readonly isolatedExecutionVerified: false;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuParentRuntimeProofFreshProcessOutputEvaluationReceipt
extends Omit<
  GpuMcpOutputEvaluatorFreshProcessExecution,
  "schemaVersion" | "proofAuthority"
> {
  readonly schemaVersion:
    typeof GPU_PARENT_RUNTIME_PROOF_FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_SCHEMA;
  readonly proofAuthority:
    typeof GPU_PARENT_RUNTIME_PROOF_FRESH_PROCESS_OUTPUT_EVALUATION_RECEIPT_AUTHORITY;
  readonly receiptId: string;
  readonly freshProcessExecutionSchemaVersion:
    typeof GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_SCHEMA;
  readonly freshProcessExecutionAuthority:
    typeof GPU_MCP_OUTPUT_EVALUATOR_FRESH_PROCESS_EXECUTION_AUTHORITY;
  readonly freshProcessExecutionHash: string;
  readonly reopenedInputExecutionHash: string;
  readonly reopenedInputProcessObservationHash: string;
  readonly reopenedInputResultContentSha256: string;
  readonly reopenedInputResultByteLength: string;
  readonly reopenedInputExecutionStartedMonotonicNs: string;
  readonly reopenedInputExecutionFinishedMonotonicNs: string;
  readonly admissionReceiptId: string;
  readonly outputObservationReceiptId: string;
  readonly liveAdmissionBindingChecked: true;
  readonly outputObservationBindingChecked: true;
  readonly evaluatorMaterialBytesReopened: true;
  readonly outputBytesReopened: true;
  readonly reopenedInputExecutionBindingChecked: true;
}

export interface GpuParentRuntimeProofAdmissionOnlineReplayResponseVerificationKey {
  readonly schemaVersion:
    "synthi.gpu_hmr.mcp_admission_online_replay_response_key.v1";
  readonly algorithm: "ed25519";
  readonly keyId: string;
  readonly publicKey: string;
}

export interface GpuParentRuntimeProofAdmissionOnlineReplayAuthorityProjection {
  readonly authorityId: string;
  readonly authorityGenerationId: string;
  readonly responseVerificationKey:
    GpuParentRuntimeProofAdmissionOnlineReplayResponseVerificationKey;
  readonly endpoint: string;
  readonly parentPid: number;
  readonly parentStartIdentity: string;
  readonly transport: "unix_domain_socket" | "windows_named_pipe";
  readonly operationTimeoutMs: number;
  readonly maxReceiptAgeNs: string;
  readonly maxFutureSkewNs: string;
  readonly maxScopes: number;
  readonly maxReceiptsPerScope: number;
  readonly policyHash: string;
}

interface OnlineReplayAuthorityStartOptions {
  readonly trustedVerificationKey:
    GpuParentRuntimeProofAdmissionReceiptVerificationKey;
  readonly validationRunChallenge: string;
  readonly maxReceiptAgeNs?: bigint;
  readonly maxFutureSkewNs?: bigint;
  readonly maxScopes?: number;
  readonly maxReceiptsPerScope?: number;
  readonly maxOperations?: number;
  readonly operationTimeoutMs?: number;
}

type OnlineReplayAuthorityServer = Readonly<Record<string, unknown>>;

const sharedOnlineReplayAuthority =
  sharedOnlineReplayAuthorityModule as unknown as Readonly<{
    startGpuHmrMcpAdmissionOnlineReplayAuthorityServer: (
      options: OnlineReplayAuthorityStartOptions,
    ) => Promise<OnlineReplayAuthorityServer>;
    gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection: (
      server: unknown,
    ) => GpuParentRuntimeProofAdmissionOnlineReplayAuthorityProjection | null;
    disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer: (
      server: unknown,
    ) => Promise<boolean>;
  }>;

export interface GpuParentRuntimeProofAdmissionAuthorityContext {
  readonly privateKey?: KeyObject;
  readonly validationRunChallenge?: string;
  readonly clockUnixNs?: () => bigint;
  readonly nonceBytes?: () => Uint8Array;
  readonly outputByteConsumerCapability?:
    GpuMcpOutputByteConsumerCapability;
  readonly outputEvaluatorExecutorCapability?:
    GpuMcpOutputEvaluatorExecutorCapability;
  readonly maxReceiptAgeNs?: bigint;
  readonly maxFutureSkewNs?: bigint;
  readonly maxScopes?: number;
  readonly maxReceiptsPerScope?: number;
  readonly maxOperations?: number;
  readonly operationTimeoutMs?: number;
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
  readonly onlineReplayAuthority:
    GpuParentRuntimeProofAdmissionOnlineReplayAuthorityProjection;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

interface AuthorityContextSnapshot {
  readonly privateKey: unknown;
  readonly validationRunChallenge: unknown;
  readonly clockUnixNs: unknown;
  readonly nonceBytes: unknown;
  readonly outputByteConsumerCapability: unknown;
  readonly outputEvaluatorExecutorCapability: unknown;
  readonly maxReceiptAgeNs: unknown;
  readonly maxFutureSkewNs: unknown;
  readonly maxScopes: unknown;
  readonly maxReceiptsPerScope: unknown;
  readonly maxOperations: unknown;
  readonly operationTimeoutMs: unknown;
}

type AuthorityContextKey = keyof AuthorityContextSnapshot;

const CONTEXT_KEYS: ReadonlySet<string> = new Set<AuthorityContextKey>([
  "privateKey",
  "validationRunChallenge",
  "clockUnixNs",
  "nonceBytes",
  "outputByteConsumerCapability",
  "outputEvaluatorExecutorCapability",
  "maxReceiptAgeNs",
  "maxFutureSkewNs",
  "maxScopes",
  "maxReceiptsPerScope",
  "maxOperations",
  "operationTimeoutMs",
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
      outputByteConsumerCapability: undefined,
      outputEvaluatorExecutorCapability: undefined,
      maxReceiptAgeNs: undefined,
      maxFutureSkewNs: undefined,
      maxScopes: undefined,
      maxReceiptsPerScope: undefined,
      maxOperations: undefined,
      operationTimeoutMs: undefined,
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

function validUnixNs(value: unknown, positive: boolean): value is bigint {
  return typeof value === "bigint"
    && value >= (positive ? 1n : 0n)
    && value <= U64_MAX;
}

function validBoundedPositiveInteger(
  value: unknown,
  maximum: number,
): value is number {
  return typeof value === "number"
    && Number.isSafeInteger(value)
    && value > 0
    && value <= maximum;
}

function onlineReplayOptions(
  context: AuthorityContextSnapshot,
  trustedVerificationKey:
    GpuParentRuntimeProofAdmissionReceiptVerificationKey,
  validationRunChallenge: string,
): OnlineReplayAuthorityStartOptions {
  return Object.freeze({
    trustedVerificationKey,
    validationRunChallenge,
    ...(context.maxReceiptAgeNs === undefined
      ? {}
      : { maxReceiptAgeNs: context.maxReceiptAgeNs as bigint }),
    ...(context.maxFutureSkewNs === undefined
      ? {}
      : { maxFutureSkewNs: context.maxFutureSkewNs as bigint }),
    ...(context.maxScopes === undefined
      ? {}
      : { maxScopes: context.maxScopes as number }),
    ...(context.maxReceiptsPerScope === undefined
      ? {}
      : { maxReceiptsPerScope: context.maxReceiptsPerScope as number }),
    ...(context.maxOperations === undefined
      ? {}
      : { maxOperations: context.maxOperations as number }),
    ...(context.operationTimeoutMs === undefined
      ? {}
      : { operationTimeoutMs: context.operationTimeoutMs as number }),
  });
}

function disposedError(): Error {
  return new Error("gpu_parent_runtime_proof_admission_authority_disposed");
}

class AuthorityAdmissionReceiptSigner
extends GpuParentRuntimeProofAdmissionReceiptSigner {
  readonly #onSigned: (receipt: GpuParentRuntimeProofAdmissionReceipt) => void;

  constructor(
    context: ConstructorParameters<
      typeof GpuParentRuntimeProofAdmissionReceiptSigner
    >[0],
    onSigned: (receipt: GpuParentRuntimeProofAdmissionReceipt) => void,
  ) {
    super(context);
    this.#onSigned = onSigned;
  }

  override signAdmissionReceipt(
    input: Parameters<
      GpuParentRuntimeProofAdmissionReceiptSigner["signAdmissionReceipt"]
    >[0],
  ): GpuParentRuntimeProofAdmissionReceipt {
    const receipt = super.signAdmissionReceipt(input);
    this.#onSigned(receipt);
    return receipt;
  }
}

export class GpuParentRuntimeProofAdmissionAuthority {
  readonly #receiptSigner:
    GpuParentRuntimeProofAdmissionReceiptSigner;
  readonly #outputObservationSigner:
    GpuMcpOutputObservationReceiptSigner;
  readonly #outputByteConsumerClaim:
    GpuMcpOutputByteConsumerClaim | null;
  readonly #outputEvaluatorExecutorClaim:
    GpuMcpOutputEvaluatorExecutorClaim | null;
  readonly #verificationKey:
    GpuParentRuntimeProofAdmissionReceiptVerificationKey;
  readonly #validationRunChallenge: string;
  readonly #clockUnixNs: () => bigint;
  readonly #maxReceiptAgeNs: bigint;
  readonly #maxFutureSkewNs: bigint;
  readonly #issuedAdmissionReceiptExpirations: Map<string, bigint>;
  readonly #verifiedOutputObservations = new WeakMap<
    GpuParentRuntimeProofOutputObservation,
    {
      readonly admissionReceipt: GpuParentRuntimeProofAdmissionReceipt;
      readonly receipt: GpuMcpOutputObservationReceipt;
    }
  >();
  readonly #verifiedOutputEvaluations = new WeakMap<
    GpuMcpOutputEvaluation,
    {
      readonly admissionReceipt: GpuParentRuntimeProofAdmissionReceipt;
      readonly observation: GpuParentRuntimeProofOutputObservation;
      readonly receipt: GpuParentRuntimeProofOutputEvaluationReceipt;
    }
  >();
  readonly #verifiedFreshProcessOutputEvaluations = new WeakMap<
    GpuParentRuntimeProofFreshProcessOutputEvaluationReceipt,
    {
      readonly admissionReceipt: GpuParentRuntimeProofAdmissionReceipt;
      readonly observation: GpuParentRuntimeProofOutputObservation;
      readonly receipt:
        GpuParentRuntimeProofFreshProcessOutputEvaluationReceipt;
    }
  >();
  readonly #outputObservationPermitAdmissionReceiptIds = new WeakMap<
    GpuMcpOutputByteObservationPermit,
    string
  >();
  readonly #onlineReplayOptions: OnlineReplayAuthorityStartOptions;
  #onlineReplayServerPromise: Promise<OnlineReplayAuthorityServer> | null = null;
  #trustMaterialPromise:
    Promise<GpuParentRuntimeProofAdmissionTrustMaterial> | null = null;
  #disposePromise: Promise<void> | null = null;
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
    if (
      context.maxReceiptAgeNs !== undefined
      && !validUnixNs(context.maxReceiptAgeNs, true)
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_authority_freshness_policy_invalid",
      );
    }
    if (
      context.maxFutureSkewNs !== undefined
      && !validUnixNs(context.maxFutureSkewNs, false)
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_authority_freshness_policy_invalid",
      );
    }
    if (
      (
        context.maxScopes !== undefined
        && !validBoundedPositiveInteger(
          context.maxScopes,
          MAX_ONLINE_REPLAY_SCOPES,
        )
      )
      || (
        context.maxReceiptsPerScope !== undefined
        && !validBoundedPositiveInteger(
          context.maxReceiptsPerScope,
          MAX_ONLINE_REPLAY_RECEIPTS_PER_SCOPE,
        )
      )
      || (
        context.maxOperations !== undefined
        && !validBoundedPositiveInteger(
          context.maxOperations,
          MAX_ONLINE_REPLAY_OPERATIONS,
        )
      )
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_authority_capacity_policy_invalid",
      );
    }
    if (
      context.operationTimeoutMs !== undefined
      && !validBoundedPositiveInteger(
        context.operationTimeoutMs,
        MAX_ONLINE_REPLAY_OPERATION_TIMEOUT_MS,
      )
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_authority_operation_timeout_invalid",
      );
    }

    const privateKey = context.privateKey ?? generateKeyPairSync("ed25519").privateKey;
    let generatedChallenge: Buffer | null = null;
    const validationRunChallenge = context.validationRunChallenge ?? (() => {
      generatedChallenge = randomBytes(32);
      return generatedChallenge.toString("base64url");
    })();
    const clockUnixNs =
      (context.clockUnixNs as (() => bigint) | undefined)
      ?? (() => BigInt(Date.now()) * 1_000_000n);
    const maxReceiptAgeNs =
      (context.maxReceiptAgeNs as bigint | undefined)
      ?? DEFAULT_MAX_RECEIPT_AGE_NS;
    const maxTrackedAdmissionReceipts =
      (context.maxOperations as number | undefined)
      ?? MAX_ONLINE_REPLAY_OPERATIONS;
    const generationSecret = randomBytes(32);
    const issuedAdmissionReceiptExpirations = new Map<string, bigint>();
    const rememberIssuedAdmissionReceipt = (
      receipt: GpuParentRuntimeProofAdmissionReceipt,
    ): void => {
      const admittedAtUnixNs = BigInt(receipt.admittedAtUnixNs);
      for (const [receiptId, expiresAtUnixNs] of
        issuedAdmissionReceiptExpirations) {
        if (expiresAtUnixNs < admittedAtUnixNs) {
          issuedAdmissionReceiptExpirations.delete(receiptId);
        }
      }
      if (
        issuedAdmissionReceiptExpirations.size
        >= maxTrackedAdmissionReceipts
      ) {
        throw new Error(
          "gpu_parent_runtime_proof_admission_authority_generation_capacity_exhausted",
        );
      }
      issuedAdmissionReceiptExpirations.set(
        receipt.receiptId,
        admittedAtUnixNs + maxReceiptAgeNs,
      );
    };

    let outputByteConsumerClaim:
      GpuMcpOutputByteConsumerClaim | null = null;
    if (context.outputByteConsumerCapability !== undefined) {
      outputByteConsumerClaim =
        claimGpuMcpOutputByteConsumerCapability(
        context.outputByteConsumerCapability,
      );
      if (outputByteConsumerClaim === null) {
        generatedChallenge?.fill(0);
        generationSecret.fill(0);
        throw new Error(
          "gpu_parent_runtime_proof_admission_authority_output_byte_consumer_invalid",
        );
      }
    }
    let outputEvaluatorExecutorClaim:
      GpuMcpOutputEvaluatorExecutorClaim | null = null;
    if (context.outputEvaluatorExecutorCapability !== undefined) {
      outputEvaluatorExecutorClaim =
        claimGpuMcpOutputEvaluatorExecutorCapability(
          context.outputEvaluatorExecutorCapability,
        );
      if (outputEvaluatorExecutorClaim === null) {
        if (outputByteConsumerClaim !== null) {
          releaseGpuMcpOutputByteConsumerClaim(
            outputByteConsumerClaim,
          );
        }
        generatedChallenge?.fill(0);
        generationSecret.fill(0);
        throw new Error(
          "gpu_parent_runtime_proof_admission_authority_output_evaluator_executor_invalid",
        );
      }
    }
    let receiptSigner: GpuParentRuntimeProofAdmissionReceiptSigner | null = null;
    let outputObservationSigner: GpuMcpOutputObservationReceiptSigner | null =
      null;
    try {
      receiptSigner = new AuthorityAdmissionReceiptSigner(
        {
          privateKey,
          validationRunChallenge,
          clockUnixNs,
          nonceBindingKey: generationSecret,
          ...(context.nonceBytes === undefined
            ? {}
            : { nonceBytes: context.nonceBytes as () => Uint8Array }),
        },
        rememberIssuedAdmissionReceipt,
      );
      outputObservationSigner = new GpuMcpOutputObservationReceiptSigner({
        privateKey,
        validationRunChallenge,
        clockUnixNs,
        ...(context.nonceBytes === undefined
          ? {}
          : { nonceBytes: context.nonceBytes as () => Uint8Array }),
      });
    } catch (error) {
      receiptSigner?.dispose();
      if (outputByteConsumerClaim !== null) {
        releaseGpuMcpOutputByteConsumerClaim(
          outputByteConsumerClaim,
        );
      }
      if (outputEvaluatorExecutorClaim !== null) {
        releaseGpuMcpOutputEvaluatorExecutorClaim(
          outputEvaluatorExecutorClaim,
        );
      }
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
      generationSecret.fill(0);
    }
    if (receiptSigner === null || outputObservationSigner === null) {
      throw new Error(
        "gpu_parent_runtime_proof_admission_authority_signer_initialization_failed",
      );
    }

    this.#receiptSigner = receiptSigner;
    this.#outputObservationSigner = outputObservationSigner;
    this.#outputByteConsumerClaim =
      outputByteConsumerClaim;
    this.#outputEvaluatorExecutorClaim =
      outputEvaluatorExecutorClaim;
    this.#verificationKey = receiptSigner.exportVerificationKey();
    this.#validationRunChallenge = validationRunChallenge;
    this.#clockUnixNs = clockUnixNs;
    this.#maxReceiptAgeNs = maxReceiptAgeNs;
    this.#maxFutureSkewNs =
      (context.maxFutureSkewNs as bigint | undefined)
      ?? DEFAULT_MAX_FUTURE_SKEW_NS;
    this.#issuedAdmissionReceiptExpirations =
      issuedAdmissionReceiptExpirations;
    this.#onlineReplayOptions = onlineReplayOptions(
      context,
      this.#verificationKey,
      validationRunChallenge,
    );
  }

  signer(): GpuParentRuntimeProofAdmissionReceiptSigner {
    if (this.#disposed) throw disposedError();
    return this.#receiptSigner;
  }

  isVerifiedOutputObservation(
    value: unknown,
  ): value is GpuParentRuntimeProofOutputObservation {
    if (this.#disposed || value === null || typeof value !== "object") {
      return false;
    }
    const binding = getWeakMapValue(
      this.#verifiedOutputObservations,
      value as GpuParentRuntimeProofOutputObservation,
    );
    return binding !== undefined
      && binding.receipt
        === (value as GpuParentRuntimeProofOutputObservation).receipt;
  }

  isVerifiedOutputObservationForAdmission(
    value: unknown,
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  ): value is GpuParentRuntimeProofOutputObservation {
    if (!this.isVerifiedOutputObservation(value)) return false;
    const binding = getWeakMapValue(
      this.#verifiedOutputObservations,
      value,
    );
    return binding?.admissionReceipt === admissionReceipt;
  }

  isVerifiedOutputEvaluation(
    value: unknown,
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  ): value is GpuMcpOutputEvaluation {
    if (
      this.#disposed
      || value === null
      || typeof value !== "object"
      || isProxy(value)
    ) {
      return false;
    }
    const binding = getWeakMapValue(
      this.#verifiedOutputEvaluations,
      value as GpuMcpOutputEvaluation,
    );
    return binding !== undefined
      && binding.admissionReceipt === admissionReceipt
      && this.isVerifiedOutputObservationForAdmission(
        binding.observation,
        admissionReceipt,
      )
      && binding.observation.receipt.receiptId
        === (value as GpuMcpOutputEvaluation).outputObservationReceiptId;
  }

  outputEvaluationReceipt(
    value: unknown,
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  ): GpuParentRuntimeProofOutputEvaluationReceipt | null {
    if (!this.isVerifiedOutputEvaluation(value, admissionReceipt)) {
      return null;
    }
    try {
      this.#assertCurrentAdmission(admissionReceipt);
    } catch {
      return null;
    }
    return getWeakMapValue(
      this.#verifiedOutputEvaluations,
      value,
    )?.receipt ?? null;
  }

  freshProcessOutputEvaluationReceipt(
    value: unknown,
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  ): GpuParentRuntimeProofFreshProcessOutputEvaluationReceipt | null {
    if (
      this.#disposed
      || value === null
      || typeof value !== "object"
      || isProxy(value)
    ) {
      return null;
    }
    const receipt =
      value as GpuParentRuntimeProofFreshProcessOutputEvaluationReceipt;
    const binding = getWeakMapValue(
      this.#verifiedFreshProcessOutputEvaluations,
      receipt,
    );
    if (
      binding === undefined
      || binding.receipt !== receipt
      || binding.admissionReceipt !== admissionReceipt
      || !this.isVerifiedOutputObservationForAdmission(
        binding.observation,
        admissionReceipt,
      )
      || binding.observation.receipt.receiptId
        !== receipt.outputObservationReceiptId
    ) {
      return null;
    }
    try {
      this.#assertCurrentAdmission(admissionReceipt);
    } catch {
      return null;
    }
    return receipt;
  }

  createOutputObservationPermit(
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  ): GpuMcpOutputByteObservationPermit {
    if (this.#disposed) throw disposedError();
    const admission = this.#assertCurrentAdmission(admissionReceipt);
    const consumerClaim = this.#outputByteConsumerClaim;
    if (consumerClaim === null) {
      throw new Error(
        "gpu_parent_runtime_proof_output_byte_consumer_unavailable",
      );
    }
    const permit = issueGpuMcpOutputByteObservationPermit(
      consumerClaim,
    );
    if (permit === null) {
      throw new Error(
        "gpu_parent_runtime_proof_output_byte_observation_permit_unavailable",
      );
    }
    setWeakMapValue(
      this.#outputObservationPermitAdmissionReceiptIds,
      permit,
      admission.receiptId,
    );
    return permit;
  }

  observeOutput(
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
    observedOutput: GpuMcpObservedOutputBytes,
  ): GpuParentRuntimeProofOutputObservation {
    return this.#consumeOutputObservation(
      admissionReceipt,
      observedOutput,
    ).observation;
  }

  async observeAndEvaluateOutput(
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
    observedOutput: GpuMcpObservedOutputBytes,
    evaluatorCapability: GpuMcpOutputEvaluatorCapability,
    signal?: AbortSignal,
  ): Promise<GpuMcpOutputEvaluation> {
    if (this.#disposed) throw disposedError();
    const executorClaim = this.#outputEvaluatorExecutorClaim;
    if (executorClaim === null) {
      throw new Error(
        "gpu_parent_runtime_proof_output_evaluator_executor_unavailable",
      );
    }
    const consumed = this.#consumeOutputObservation(
      admissionReceipt,
      observedOutput,
    );
    const evaluation = await evaluateGpuMcpOutputBytes(
      executorClaim,
      evaluatorCapability,
      admissionReceipt,
      consumed.observation.receipt,
      consumed.outputBytes,
      signal,
    );
    if (
      this.#disposed
      || evaluation.admissionReceiptId
        !== consumed.admissionReceiptId
      || evaluation.outputObservationReceiptId
        !== consumed.observation.receipt.receiptId
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_output_evaluation_admission_binding_mismatch",
      );
    }
    const materialBytes =
      snapshotGpuMcpOutputEvaluatorMaterialBytes(evaluatorCapability);
    if (materialBytes === null) {
      throw new Error(
        "gpu_parent_runtime_proof_output_evaluator_material_unavailable",
      );
    }
    const receipt = createOutputEvaluationReceipt(
      evaluation,
      consumed.admissionReceiptId,
      consumed.observation.receipt.receiptId,
      materialBytes,
    );
    setWeakMapValue(
      this.#verifiedOutputEvaluations,
      evaluation,
      {
        admissionReceipt,
        observation: consumed.observation,
        receipt,
      },
    );
    return evaluation;
  }

  async observeAndEvaluateOutputInFreshProcess(
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
    observedOutput: GpuMcpObservedOutputBytes,
    evaluatorCapability: GpuMcpOutputEvaluatorCapability,
    options?: GpuMcpOutputEvaluatorFreshProcessOptions,
  ): Promise<GpuParentRuntimeProofFreshProcessOutputEvaluationReceipt> {
    if (this.#disposed) throw disposedError();
    const executorClaim = this.#outputEvaluatorExecutorClaim;
    if (executorClaim === null) {
      throw new Error(
        "gpu_parent_runtime_proof_output_evaluator_executor_unavailable",
      );
    }
    if (!gpuMcpOutputEvaluatorCapabilityMatchesExecutorClaim(
      executorClaim,
      evaluatorCapability,
    )) {
      throw new Error(
        "gpu_parent_runtime_proof_output_evaluator_capability_invalid",
      );
    }
    const consumed = this.#consumeOutputObservation(
      admissionReceipt,
      observedOutput,
    );
    const materialBytes =
      snapshotGpuMcpOutputEvaluatorMaterialBytes(evaluatorCapability);
    if (materialBytes === null) {
      clearBytes(consumed.outputBytes);
      throw new Error(
        "gpu_parent_runtime_proof_output_evaluator_material_unavailable",
      );
    }
    try {
      const execution =
        await executeGpuMcpOutputEvaluatorInFreshProcess(
          evaluatorCapability,
          consumed.outputBytes,
          options,
        );
      if (
        this.#disposed
        || this.#outputEvaluatorExecutorClaim !== executorClaim
        || !gpuMcpOutputEvaluatorCapabilityMatchesExecutorClaim(
          executorClaim,
          evaluatorCapability,
        )
      ) {
        throw new Error(
          "gpu_parent_runtime_proof_output_evaluator_boundary_disposed",
        );
      }
      const reopenedInputExecution =
        await executeReopenedGpuMcpOutputEvaluatorMaterialInFreshProcess(
          executorClaim,
          evaluatorCapability,
          materialBytes,
          consumed.outputBytes,
          { timeoutMs: execution.timeoutMs },
        );
      if (
        this.#disposed
        || this.#outputEvaluatorExecutorClaim !== executorClaim
        || !gpuMcpOutputEvaluatorCapabilityMatchesExecutorClaim(
          executorClaim,
          evaluatorCapability,
        )
      ) {
        throw new Error(
          "gpu_parent_runtime_proof_output_evaluator_boundary_disposed",
        );
      }
      const receipt = createFreshProcessOutputEvaluationReceipt(
        execution,
        reopenedInputExecution,
        admissionReceipt,
        consumed.observation.receipt,
      );
      if (
        this.#disposed
        || receipt.admissionReceiptId !== consumed.admissionReceiptId
        || receipt.outputObservationReceiptId
          !== consumed.observation.receipt.receiptId
        || receipt.outputContentSha256
          !== consumed.observation.receipt.outputContentSha256
        || receipt.outputByteLength
          !== consumed.observation.receipt.outputByteLength
      ) {
        throw new Error(
          "gpu_parent_runtime_proof_fresh_process_output_evaluation_binding_mismatch",
        );
      }
      setWeakMapValue(
        this.#verifiedFreshProcessOutputEvaluations,
        receipt,
        {
          admissionReceipt,
          observation: consumed.observation,
          receipt,
        },
      );
      return receipt;
    } finally {
      clearBytes(materialBytes);
      clearBytes(consumed.outputBytes);
    }
  }

  #consumeOutputObservation(
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
    observedOutput: GpuMcpObservedOutputBytes,
  ): {
    readonly admissionReceiptId: string;
    readonly observation: GpuParentRuntimeProofOutputObservation;
    readonly outputBytes: Uint8Array;
  } {
    if (this.#disposed) throw disposedError();
    const admission = this.#assertCurrentAdmission(admissionReceipt);
    const consumerClaim = this.#outputByteConsumerClaim;
    if (consumerClaim === null) {
      throw new Error(
        "gpu_parent_runtime_proof_output_byte_consumer_unavailable",
      );
    }
    const producerObservation = takeGpuMcpObservedOutputBytes(
      consumerClaim,
      observedOutput,
    );
    if (producerObservation === null) {
      throw new Error(
        "gpu_parent_runtime_proof_output_byte_source_observation_invalid",
      );
    }
    if (
      getWeakMapValue(
        this.#outputObservationPermitAdmissionReceiptIds,
        producerObservation.permit,
      ) !== admission.receiptId
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_output_byte_observation_admission_binding_mismatch",
      );
    }

    const receipt = this.#outputObservationSigner.sign({
      admissionReceipt,
      outputBytes: producerObservation.bytes,
      observedAtMonotonicNs:
        producerObservation.observedAtMonotonicNs,
    });
    this.#assertFreshAdmission(
      admission.admittedAtUnixNs,
      BigInt(receipt.issuedAtUnixNs),
    );
    if (
      receipt.outputContentSha256 !== observedOutput.outputContentSha256
      || receipt.outputByteLength !== observedOutput.outputByteLength
      || receipt.observedAtMonotonicNs
        !== observedOutput.observedAtMonotonicNs
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_output_byte_source_observation_mismatch",
      );
    }
    const observation = Object.freeze({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_OUTPUT_OBSERVATION_SCHEMA,
      proofAuthority: GPU_PARENT_RUNTIME_PROOF_OUTPUT_OBSERVATION_AUTHORITY,
      receipt,
      trustedKeyOriginChecked: true as const,
      admissionBindingChecked: true as const,
      requestChallengeChecked: true as const,
      runtimeBindingChecked: true as const,
      outputBytesChecked: true as const,
      admissionGenerationChecked: true as const,
      producerObservationPermitChecked: true as const,
      producerObservationTimeChecked: true as const,
      postAdmissionObservationChecked: true as const,
      replayChecked: false as const,
      freshnessChecked: true as const,
      acceptedForGpuHmr: false as const,
      gpuHmrSuccess: false as const,
      canSatisfyRuntimeProof: false as const,
    });
    setWeakMapValue(
      this.#verifiedOutputObservations,
      observation,
      {
        admissionReceipt,
        receipt,
      },
    );
    return Object.freeze({
      admissionReceiptId: admission.receiptId,
      observation,
      outputBytes: producerObservation.bytes,
    });
  }

  #assertCurrentAdmission(
    admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  ): {
    readonly admittedAtUnixNs: bigint;
    readonly receiptId: string;
  } {
    const admissionVerification =
      verifyGpuParentRuntimeProofAdmissionReceipt(
        this.#verificationKey,
        admissionReceipt,
        this.#validationRunChallenge,
      );
    if (!admissionVerification.verified) {
      throw new Error(
        "gpu_parent_runtime_proof_output_observation_admission_invalid",
      );
    }

    const nowUnixNs = this.#currentUnixNs();
    this.#assertFreshAdmission(
      admissionVerification.admittedAtUnixNs,
      nowUnixNs,
    );
    this.#pruneIssuedAdmissionReceipts(nowUnixNs);
    if (
      !this.#issuedAdmissionReceiptExpirations.has(
        admissionVerification.receiptId,
      )
    ) {
      throw new Error(
        "gpu_parent_runtime_proof_output_observation_admission_generation_mismatch",
      );
    }
    return Object.freeze({
      admittedAtUnixNs: admissionVerification.admittedAtUnixNs,
      receiptId: admissionVerification.receiptId,
    });
  }

  trustMaterial(): Promise<GpuParentRuntimeProofAdmissionTrustMaterial> {
    if (this.#disposed) return Promise.reject(disposedError());
    if (this.#trustMaterialPromise === null) {
      this.#trustMaterialPromise = this.#startOnlineReplayAuthority();
    }
    return this.#trustMaterialPromise;
  }

  dispose(): Promise<void> {
    if (this.#disposePromise !== null) return this.#disposePromise;
    this.#disposed = true;
    this.#receiptSigner.dispose();
    this.#outputObservationSigner.dispose();
    if (this.#outputByteConsumerClaim !== null) {
      disposeGpuMcpOutputByteConsumerClaim(
        this.#outputByteConsumerClaim,
      );
    }
    if (this.#outputEvaluatorExecutorClaim !== null) {
      disposeGpuMcpOutputEvaluatorExecutorClaim(
        this.#outputEvaluatorExecutorClaim,
      );
    }
    this.#issuedAdmissionReceiptExpirations.clear();
    this.#disposePromise = this.#disposeOnlineReplayAuthority();
    return this.#disposePromise;
  }

  #currentUnixNs(): bigint {
    let nowUnixNs: unknown;
    try {
      nowUnixNs = this.#clockUnixNs();
    } catch {
      throw new Error(
        "gpu_parent_runtime_proof_output_observation_clock_failed",
      );
    }
    if (!validUnixNs(nowUnixNs, false)) {
      throw new Error(
        "gpu_parent_runtime_proof_output_observation_clock_invalid",
      );
    }
    return nowUnixNs;
  }

  #assertFreshAdmission(admittedAtUnixNs: bigint, nowUnixNs: bigint): void {
    if (admittedAtUnixNs > nowUnixNs + this.#maxFutureSkewNs) {
      throw new Error(
        "gpu_parent_runtime_proof_output_observation_admission_from_future",
      );
    }
    if (nowUnixNs > admittedAtUnixNs + this.#maxReceiptAgeNs) {
      throw new Error(
        "gpu_parent_runtime_proof_output_observation_admission_stale",
      );
    }
  }

  #pruneIssuedAdmissionReceipts(nowUnixNs: bigint): void {
    for (const [key, expiresAtUnixNs] of
      this.#issuedAdmissionReceiptExpirations) {
      if (expiresAtUnixNs < nowUnixNs) {
        this.#issuedAdmissionReceiptExpirations.delete(key);
      }
    }
  }

  async #startOnlineReplayAuthority():
    Promise<GpuParentRuntimeProofAdmissionTrustMaterial> {
    const serverPromise = sharedOnlineReplayAuthority
      .startGpuHmrMcpAdmissionOnlineReplayAuthorityServer(
        this.#onlineReplayOptions,
      );
    this.#onlineReplayServerPromise = serverPromise;
    const server = await serverPromise;
    if (this.#disposed) {
      await sharedOnlineReplayAuthority
        .disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(server);
      throw disposedError();
    }

    const onlineReplayAuthority = sharedOnlineReplayAuthority
      .gpuHmrMcpAdmissionOnlineReplayAuthorityServerProjection(server);
    if (onlineReplayAuthority === null) {
      await sharedOnlineReplayAuthority
        .disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(server);
      throw new Error(
        "gpu_parent_runtime_proof_admission_authority_online_replay_projection_unavailable",
      );
    }

    return Object.freeze({
      schemaVersion: GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_SCHEMA,
      proofAuthority:
        GPU_PARENT_RUNTIME_PROOF_ADMISSION_TRUST_MATERIAL_AUTHORITY,
      verificationKey: this.#verificationKey,
      validationRunChallenge: this.#validationRunChallenge,
      replayPolicyRequired: true,
      freshnessPolicyRequired: true,
      onlineReplayAuthority,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
  }

  async #disposeOnlineReplayAuthority(): Promise<void> {
    const serverPromise = this.#onlineReplayServerPromise;
    if (serverPromise === null) return;

    let server: OnlineReplayAuthorityServer;
    try {
      server = await serverPromise;
    } catch {
      return;
    }
    await sharedOnlineReplayAuthority
      .disposeGpuHmrMcpAdmissionOnlineReplayAuthorityServer(server);
  }
}
