import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { isProxy } from "node:util/types";
import type {
  GpuMcpOutputObservationReceipt,
} from "./gpu_mcp_output_observation_receipt.js";
import {
  gpuParentRuntimeProofAdmissionOutputContractBinding,
  type GpuParentRuntimeProofAdmissionReceipt,
} from "./gpu_parent_runtime_proof_admission_receipt.js";
import {
  snapshotValidatedUint8Array,
} from "./validated_uint8_array.js";

export const GPU_MCP_OUTPUT_EVALUATION_SCHEMA =
  "synthi.gpu_hmr.mcp_output_evaluation.v1" as const;
export const GPU_MCP_OUTPUT_EVALUATION_AUTHORITY =
  "in_process_mcp_output_evaluator_support_only_not_gpu_hmr_acceptance" as const;
export const GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA =
  "synthi.gpu_hmr.mcp_output_evaluator_material.v1" as const;
export const GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_AUTHORITY =
  "content_addressed_evaluator_material_support_only_not_gpu_hmr_acceptance" as const;

const CANONICAL_SHA256_PATTERN = /^sha256:[a-f0-9]{64}$/;
const REGISTRATION_KEYS = [
  "outputContractSha256",
  "outputSemanticsSha256",
  "evaluate",
] as const;
const EVALUATOR_IDENTITY_DOMAIN =
  "synthi.gpu_hmr.mcp_output_evaluator.function_source.v1";

function requiredGetter(
  prototype: object,
  property: string,
): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(prototype, property)?.get;
  if (getter === undefined) {
    throw new Error("gpu_mcp_output_evaluation_runtime_intrinsics_unavailable");
  }
  return getter;
}

const freeze = Object.freeze;
const reflectApply = Reflect.apply;
const createHashIntrinsic = createHash;
const hashPrototype = Object.getPrototypeOf(
  createHashIntrinsic("sha256"),
);
const hashUpdate = hashPrototype.update as Function;
const hashDigest = hashPrototype.digest as Function;
const bufferByteLength = Buffer.byteLength;
const bufferFrom = Buffer.from;
const jsonStringify = JSON.stringify;
const structuredCloneIntrinsic = structuredClone;
const SetIntrinsic = Set;
const setAdd = Set.prototype.add;
const setClear = Set.prototype.clear;
const setDelete = Set.prototype.delete;
const setForEach = Set.prototype.forEach;
const setHas = Set.prototype.has;
const WeakMapIntrinsic = WeakMap;
const weakMapDelete = WeakMap.prototype.delete;
const weakMapGet = WeakMap.prototype.get;
const weakMapHas = WeakMap.prototype.has;
const weakMapSet = WeakMap.prototype.set;
const Uint8ArrayIntrinsic = Uint8Array;
const uint8ArrayFill = Uint8Array.prototype.fill;
const uint8ArraySet = Uint8Array.prototype.set;
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const typedArrayBufferGetter =
  requiredGetter(typedArrayPrototype, "buffer");
const typedArrayByteLengthGetter =
  requiredGetter(typedArrayPrototype, "byteLength");
const functionToString = Function.prototype.toString;
const stringIncludes = String.prototype.includes;
const AbortControllerIntrinsic = AbortController;
const AbortSignalIntrinsic = AbortSignal;
const abortControllerAbort = AbortController.prototype.abort;
const abortControllerSignalGetter =
  requiredGetter(AbortController.prototype, "signal");
const abortSignalAbortedGetter =
  requiredGetter(AbortSignal.prototype, "aborted");
const eventTargetAddEventListener = EventTarget.prototype.addEventListener;
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener;
const monotonicNow = process.hrtime.bigint;

declare const OUTPUT_EVALUATOR_EXECUTOR_CAPABILITY_BRAND: unique symbol;
declare const OUTPUT_EVALUATOR_EXECUTOR_CLAIM_BRAND: unique symbol;
declare const OUTPUT_EVALUATOR_CAPABILITY_BRAND: unique symbol;

export type GpuMcpOutputEvaluator =
  (
    outputBytes: Uint8Array,
    signal: AbortSignal,
  ) => boolean | Promise<boolean>;

export interface GpuMcpOutputEvaluatorCapability {
  readonly [OUTPUT_EVALUATOR_CAPABILITY_BRAND]: never;
}

export interface GpuMcpOutputEvaluatorExecutorCapability {
  readonly [OUTPUT_EVALUATOR_EXECUTOR_CAPABILITY_BRAND]: never;
}

export interface GpuMcpOutputEvaluatorExecutorClaim {
  readonly [OUTPUT_EVALUATOR_EXECUTOR_CLAIM_BRAND]: never;
}

export interface GpuMcpOutputEvaluatorRegistration {
  readonly outputContractSha256: string;
  readonly outputSemanticsSha256: string | null;
  readonly evaluate: GpuMcpOutputEvaluator;
}

export interface GpuMcpOutputEvaluatorRegistrar {
  register(
    registration: GpuMcpOutputEvaluatorRegistration,
  ): GpuMcpOutputEvaluatorCapability;
  dispose(): boolean;
}

export interface GpuMcpOutputEvaluatorBoundary {
  readonly registrar: GpuMcpOutputEvaluatorRegistrar;
  readonly executor: GpuMcpOutputEvaluatorExecutorCapability;
}

export interface GpuMcpOutputEvaluatorMaterial {
  readonly schemaVersion:
    typeof GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA;
  readonly proofAuthority:
    typeof GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_AUTHORITY;
  readonly materialSha256: string;
  readonly materialByteLength: string;
  readonly evaluatorFunctionSourceSha256: string;
  readonly evaluatorSourceSha256: string;
  readonly evaluatorSourceByteLength: string;
  readonly outputContractSha256: string;
  readonly outputSemanticsSha256: string | null;
  readonly isolatedExecutionRequired: true;
  readonly isolatedExecutionVerified: false;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

export interface GpuMcpOutputEvaluation {
  readonly schemaVersion: typeof GPU_MCP_OUTPUT_EVALUATION_SCHEMA;
  readonly proofAuthority: typeof GPU_MCP_OUTPUT_EVALUATION_AUTHORITY;
  readonly evaluatorFunctionSourceSha256: string;
  readonly evaluatorMaterial: GpuMcpOutputEvaluatorMaterial;
  readonly outputContractSha256: string;
  readonly outputSemanticsSha256: string | null;
  readonly admissionReceiptId: string;
  readonly outputObservationReceiptId: string;
  readonly outputContentSha256: string;
  readonly outputByteLength: string;
  readonly evaluatedAtMonotonicNs: string;
  readonly outputContractPassed: boolean;
  readonly acceptedForGpuHmr: false;
  readonly gpuHmrSuccess: false;
  readonly canSatisfyRuntimeProof: false;
}

interface OutputEvaluatorBoundaryState {
  active: boolean;
  readonly activeEvaluations: Set<AbortController>;
}

interface OutputEvaluatorCapabilityState
extends GpuMcpOutputEvaluatorRegistration {
  readonly boundary: OutputEvaluatorBoundaryState;
  readonly evaluatorFunctionSourceSha256: string;
  readonly evaluatorMaterialSource: string;
  readonly evaluatorMaterial: GpuMcpOutputEvaluatorMaterial;
}

interface OutputEvaluatorExecutorClaimState {
  readonly boundary: OutputEvaluatorBoundaryState;
  readonly executor: object;
  active: boolean;
}

const executorStates =
  new WeakMapIntrinsic<object, OutputEvaluatorBoundaryState>();
const activeExecutorClaims =
  new WeakMapIntrinsic<object, object>();
const executorClaimStates =
  new WeakMapIntrinsic<object, OutputEvaluatorExecutorClaimState>();
const evaluatorCapabilityStates =
  new WeakMapIntrinsic<object, OutputEvaluatorCapabilityState>();

function getWeakMapValue<V>(
  map: WeakMap<object, V>,
  key: object,
): V | undefined {
  return reflectApply(weakMapGet, map, [key]) as V | undefined;
}

function setWeakMapValue<V>(
  map: WeakMap<object, V>,
  key: object,
  value: V,
): void {
  reflectApply(weakMapSet, map, [key, value]);
}

function weakMapHasKey(
  map: WeakMap<object, unknown>,
  key: object,
): boolean {
  return reflectApply(weakMapHas, map, [key]) as boolean;
}

function deleteWeakMapKey(
  map: WeakMap<object, unknown>,
  key: object,
): boolean {
  return reflectApply(weakMapDelete, map, [key]) as boolean;
}

function addSetValue<T>(set: Set<T>, value: T): void {
  reflectApply(setAdd, set, [value]);
}

function deleteSetValue<T>(set: Set<T>, value: T): boolean {
  return reflectApply(setDelete, set, [value]) as boolean;
}

function setHasValue<T>(set: Set<T>, value: T): boolean {
  return reflectApply(setHas, set, [value]) as boolean;
}

function clearSet<T>(set: Set<T>): void {
  reflectApply(setClear, set, []);
}

function forEachSetValue<T>(
  set: Set<T>,
  callback: (value: T) => void,
): void {
  reflectApply(setForEach, set, [callback]);
}

function canonicalSha256(value: unknown): value is string {
  return typeof value === "string"
    && CANONICAL_SHA256_PATTERN.test(value);
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

function snapshotRegistration(
  value: unknown,
): GpuMcpOutputEvaluatorRegistration | null {
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
    const ownKeys = Reflect.ownKeys(value);
    const allowedKeys = new SetIntrinsic<string>(REGISTRATION_KEYS);
    if (
      ownKeys.length !== REGISTRATION_KEYS.length
      || ownKeys.some(
        (key) => typeof key !== "string" || !setHasValue(allowedKeys, key),
      )
    ) {
      return null;
    }
    const snapshot: Record<string, unknown> = {};
    for (const key of REGISTRATION_KEYS) {
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
    if (
      !canonicalSha256(snapshot.outputContractSha256)
      || !(
        snapshot.outputSemanticsSha256 === null
        || canonicalSha256(snapshot.outputSemanticsSha256)
      )
      || typeof snapshot.evaluate !== "function"
      || isProxy(snapshot.evaluate)
    ) {
      return null;
    }
    return freeze({
      outputContractSha256: snapshot.outputContractSha256,
      outputSemanticsSha256: snapshot.outputSemanticsSha256,
      evaluate: snapshot.evaluate,
    }) as GpuMcpOutputEvaluatorRegistration;
  } catch {
    return null;
  }
}

function activeExecutorClaim(
  value: unknown,
): OutputEvaluatorExecutorClaimState | null {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
  ) {
    return null;
  }
  const claim = getWeakMapValue(executorClaimStates, value);
  if (
    claim === undefined
    || !claim.active
    || !claim.boundary.active
    || getWeakMapValue(activeExecutorClaims, claim.executor) !== value
  ) {
    return null;
  }
  return claim;
}

function evaluatorCapabilityState(
  value: unknown,
): OutputEvaluatorCapabilityState | null {
  if (
    value === null
    || typeof value !== "object"
    || isProxy(value)
  ) {
    return null;
  }
  const state = getWeakMapValue(evaluatorCapabilityStates, value);
  return state?.boundary.active === true ? state : null;
}

function outputSha256(bytes: Uint8Array): string {
  return `sha256:${sha256Hex(bytes)}`;
}

interface EvaluatorSourceIdentity {
  readonly source: string;
  readonly functionSourceSha256: string;
  readonly sourceSha256: string;
  readonly sourceByteLength: string;
}

function evaluatorSourceIdentity(
  evaluate: GpuMcpOutputEvaluator,
): EvaluatorSourceIdentity {
  let source: string;
  try {
    source = reflectApply(functionToString, evaluate, []);
  } catch {
    throw new Error("gpu_mcp_output_evaluator_function_source_unavailable");
  }
  if (reflectApply(stringIncludes, source, ["[native code]"])) {
    throw new Error("gpu_mcp_output_evaluator_function_source_unavailable");
  }
  const functionSourceSha256 =
    `sha256:${sha256Hex(EVALUATOR_IDENTITY_DOMAIN, "\0", source)}`;
  const sourceSha256 = `sha256:${sha256Hex(source)}`;
  return freeze({
    source,
    functionSourceSha256,
    sourceSha256,
    sourceByteLength: String(bufferByteLength(source, "utf8")),
  });
}

function outputEvaluatorMaterial(
  identity: EvaluatorSourceIdentity,
  registration: GpuMcpOutputEvaluatorRegistration,
): {
  readonly manifest: GpuMcpOutputEvaluatorMaterial;
  readonly source: string;
} {
  const source = jsonStringify({
    schemaVersion: GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA,
    evaluatorFunctionSourceSha256: identity.functionSourceSha256,
    evaluatorSourceSha256: identity.sourceSha256,
    evaluatorSourceByteLength: identity.sourceByteLength,
    evaluatorSource: identity.source,
    outputContractSha256: registration.outputContractSha256,
    outputSemanticsSha256: registration.outputSemanticsSha256,
  });
  if (source === undefined) {
    throw new Error("gpu_mcp_output_evaluator_material_unavailable");
  }
  const materialSha256 = `sha256:${sha256Hex(source)}`;
  return freeze({
    source,
    manifest: freeze({
      schemaVersion: GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_SCHEMA,
      proofAuthority: GPU_MCP_OUTPUT_EVALUATOR_MATERIAL_AUTHORITY,
      materialSha256,
      materialByteLength: String(bufferByteLength(source, "utf8")),
      evaluatorFunctionSourceSha256: identity.functionSourceSha256,
      evaluatorSourceSha256: identity.sourceSha256,
      evaluatorSourceByteLength: identity.sourceByteLength,
      outputContractSha256: registration.outputContractSha256,
      outputSemanticsSha256: registration.outputSemanticsSha256,
      isolatedExecutionRequired: true as const,
      isolatedExecutionVerified: false as const,
      acceptedForGpuHmr: false as const,
      gpuHmrSuccess: false as const,
      canSatisfyRuntimeProof: false as const,
    }),
  });
}

function typedArrayByteLength(bytes: Uint8Array): number {
  return reflectApply(typedArrayByteLengthGetter, bytes, []) as number;
}

function typedArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return reflectApply(typedArrayBufferGetter, bytes, []) as ArrayBuffer;
}

function fillBytes(bytes: Uint8Array, value: number): void {
  reflectApply(uint8ArrayFill, bytes, [value]);
}

function signalAborted(signal: AbortSignal): boolean {
  return reflectApply(abortSignalAbortedGetter, signal, []) as boolean;
}

function abortController(controller: AbortController): void {
  reflectApply(abortControllerAbort, controller, []);
}

function abortControllerSignal(
  controller: AbortController,
): AbortSignal {
  return reflectApply(
    abortControllerSignalGetter,
    controller,
    [],
  ) as AbortSignal;
}

function abortBoundaryEvaluations(
  boundary: OutputEvaluatorBoundaryState,
): void {
  forEachSetValue(boundary.activeEvaluations, (controller) => {
    abortController(controller);
  });
  clearSet(boundary.activeEvaluations);
}

function validAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignalIntrinsic && !isProxy(value);
}

function destroyEvaluatorBytes(bytes: Uint8Array): void {
  try {
    if (typedArrayByteLength(bytes) === 0) return;
    const buffer = typedArrayBuffer(bytes);
    const transferred = structuredCloneIntrinsic(buffer, {
      transfer: [buffer],
    });
    fillBytes(new Uint8ArrayIntrinsic(transferred), 0);
    return;
  } catch {
    // Fall through to in-place zeroing when detachment is unavailable.
  }
  try {
    fillBytes(bytes, 0);
  } catch {
    // A detached view no longer exposes bytes to clear.
  }
}

async function awaitEvaluation(
  evaluate: GpuMcpOutputEvaluator,
  bytes: Uint8Array,
  signal: AbortSignal,
): Promise<unknown> {
  if (signalAborted(signal)) {
    destroyEvaluatorBytes(bytes);
    throw new Error("gpu_mcp_output_evaluation_aborted");
  }
  const evaluation = Promise.resolve().then(() => evaluate(bytes, signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void): void => {
      if (settled) return;
      settled = true;
      reflectApply(eventTargetRemoveEventListener, signal, [
        "abort",
        onAbort,
      ]);
      callback();
    };
    const onAbort = (): void => {
      destroyEvaluatorBytes(bytes);
      finish(() => reject(new Error("gpu_mcp_output_evaluation_aborted")));
    };
    reflectApply(eventTargetAddEventListener, signal, [
      "abort",
      onAbort,
      { once: true },
    ]);
    evaluation.then(
      (result) => finish(() => resolve(result)),
      () => finish(() => reject(
        new Error("gpu_mcp_output_evaluation_failed"),
      )),
    );
  });
}

export function createGpuMcpOutputEvaluatorBoundary():
GpuMcpOutputEvaluatorBoundary {
  const boundary: OutputEvaluatorBoundaryState = {
    active: true,
    activeEvaluations: new SetIntrinsic<AbortController>(),
  };
  const executor = freeze(
    {},
  ) as GpuMcpOutputEvaluatorExecutorCapability;
  setWeakMapValue(executorStates, executor, boundary);
  const registrar = freeze({
    register: (
      registrationValue: GpuMcpOutputEvaluatorRegistration,
    ): GpuMcpOutputEvaluatorCapability => {
      if (!boundary.active) {
        throw new Error("gpu_mcp_output_evaluator_boundary_disposed");
      }
      const registration = snapshotRegistration(registrationValue);
      if (registration === null) {
        throw new Error(
          "gpu_mcp_output_evaluator_registration_invalid",
        );
      }
      const capability = freeze(
        {},
      ) as GpuMcpOutputEvaluatorCapability;
      const sourceIdentity = evaluatorSourceIdentity(
        registration.evaluate,
      );
      const evaluatorMaterial = outputEvaluatorMaterial(
        sourceIdentity,
        registration,
      );
      setWeakMapValue(evaluatorCapabilityStates, capability, {
        boundary,
        evaluatorFunctionSourceSha256:
          sourceIdentity.functionSourceSha256,
        evaluatorMaterialSource: evaluatorMaterial.source,
        evaluatorMaterial: evaluatorMaterial.manifest,
        ...registration,
      });
      return capability;
    },
    dispose: (): boolean => {
      if (!boundary.active) return false;
      boundary.active = false;
      abortBoundaryEvaluations(boundary);
      return true;
    },
  });
  return freeze({ registrar, executor });
}

export function gpuMcpOutputEvaluatorMaterial(
  capability: unknown,
): GpuMcpOutputEvaluatorMaterial | null {
  return evaluatorCapabilityState(capability)?.evaluatorMaterial ?? null;
}

export function snapshotGpuMcpOutputEvaluatorMaterialBytes(
  capability: unknown,
): Uint8Array | null {
  const state = evaluatorCapabilityState(capability);
  if (state === null) return null;
  const encoded = bufferFrom(state.evaluatorMaterialSource, "utf8");
  const snapshot = new Uint8ArrayIntrinsic(
    typedArrayByteLength(encoded),
  );
  reflectApply(uint8ArraySet, snapshot, [encoded]);
  fillBytes(encoded, 0);
  return snapshot;
}

export function claimGpuMcpOutputEvaluatorExecutorCapability(
  capability: unknown,
): GpuMcpOutputEvaluatorExecutorClaim | null {
  if (
    capability === null
    || typeof capability !== "object"
    || isProxy(capability)
  ) {
    return null;
  }
  const boundary = getWeakMapValue(executorStates, capability);
  if (
    boundary === undefined
    || !boundary.active
    || weakMapHasKey(activeExecutorClaims, capability)
  ) {
    return null;
  }
  const claim = freeze(
    {},
  ) as GpuMcpOutputEvaluatorExecutorClaim;
  setWeakMapValue(activeExecutorClaims, capability, claim);
  setWeakMapValue(executorClaimStates, claim, {
    boundary,
    executor: capability,
    active: true,
  });
  return claim;
}

export function releaseGpuMcpOutputEvaluatorExecutorClaim(
  claim: unknown,
): boolean {
  const state = activeExecutorClaim(claim);
  if (state === null) return false;
  state.active = false;
  abortBoundaryEvaluations(state.boundary);
  if (getWeakMapValue(activeExecutorClaims, state.executor) === claim) {
    deleteWeakMapKey(activeExecutorClaims, state.executor);
  }
  return true;
}

export function disposeGpuMcpOutputEvaluatorExecutorClaim(
  claim: unknown,
): boolean {
  const state = activeExecutorClaim(claim);
  if (state === null) return false;
  state.active = false;
  state.boundary.active = false;
  abortBoundaryEvaluations(state.boundary);
  if (getWeakMapValue(activeExecutorClaims, state.executor) === claim) {
    deleteWeakMapKey(activeExecutorClaims, state.executor);
  }
  return true;
}

export async function evaluateGpuMcpOutputBytes(
  executorClaim: GpuMcpOutputEvaluatorExecutorClaim,
  evaluatorCapability: GpuMcpOutputEvaluatorCapability,
  admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  outputObservationReceipt: GpuMcpOutputObservationReceipt,
  outputBytes: Uint8Array,
  signalValue?: AbortSignal,
): Promise<GpuMcpOutputEvaluation> {
  const claim = activeExecutorClaim(executorClaim);
  const evaluator = evaluatorCapabilityState(evaluatorCapability);
  if (
    claim === null
    || evaluator === null
    || evaluator.boundary !== claim.boundary
  ) {
    throw new Error("gpu_mcp_output_evaluator_capability_invalid");
  }
  if (
    signalValue !== undefined
    && !validAbortSignal(signalValue)
  ) {
    throw new Error("gpu_mcp_output_evaluation_abort_signal_invalid");
  }
  const outputContractBinding =
    gpuParentRuntimeProofAdmissionOutputContractBinding(admissionReceipt);
  if (
    evaluator.outputContractSha256
      !== outputContractBinding.outputContractSha256
    || evaluator.outputSemanticsSha256
      !== outputContractBinding.outputSemanticsSha256
  ) {
    throw new Error("gpu_mcp_output_evaluation_contract_binding_mismatch");
  }
  const sourceBytes = snapshotValidatedUint8Array(outputBytes);
  if (sourceBytes === null) {
    throw new Error("gpu_mcp_output_evaluation_bytes_invalid");
  }
  const evaluatorBytes = new Uint8ArrayIntrinsic(
    typedArrayByteLength(sourceBytes),
  );
  reflectApply(uint8ArraySet, evaluatorBytes, [sourceBytes]);
  fillBytes(sourceBytes, 0);
  const lifecycleController = new AbortControllerIntrinsic();
  const lifecycleSignal = abortControllerSignal(lifecycleController);
  const onCallerAbort = (): void => abortController(lifecycleController);
  addSetValue(claim.boundary.activeEvaluations, lifecycleController);
  if (signalValue !== undefined) {
    if (signalAborted(signalValue)) {
      abortController(lifecycleController);
    } else {
      reflectApply(eventTargetAddEventListener, signalValue, [
        "abort",
        onCallerAbort,
        { once: true },
      ]);
    }
  }
  try {
    const expectedHash = outputObservationReceipt.outputContentSha256;
    const expectedLength = outputObservationReceipt.outputByteLength;
    if (
      outputSha256(evaluatorBytes) !== expectedHash
      || String(typedArrayByteLength(evaluatorBytes)) !== expectedLength
    ) {
      throw new Error("gpu_mcp_output_evaluation_observation_binding_mismatch");
    }
    const verdict = await awaitEvaluation(
      evaluator.evaluate,
      evaluatorBytes,
      lifecycleSignal,
    );
    if (verdict !== true && verdict !== false) {
      throw new Error("gpu_mcp_output_evaluation_verdict_invalid");
    }
    if (
      outputSha256(evaluatorBytes) !== expectedHash
      || String(typedArrayByteLength(evaluatorBytes)) !== expectedLength
    ) {
      throw new Error("gpu_mcp_output_evaluation_bytes_mutated");
    }
    if (signalAborted(lifecycleSignal)) {
      throw new Error("gpu_mcp_output_evaluation_aborted");
    }
    if (
      activeExecutorClaim(executorClaim) !== claim
      || evaluatorCapabilityState(evaluatorCapability) !== evaluator
    ) {
      throw new Error("gpu_mcp_output_evaluator_boundary_disposed");
    }
    return freeze({
      schemaVersion: GPU_MCP_OUTPUT_EVALUATION_SCHEMA,
      proofAuthority: GPU_MCP_OUTPUT_EVALUATION_AUTHORITY,
      evaluatorFunctionSourceSha256:
        evaluator.evaluatorFunctionSourceSha256,
      evaluatorMaterial: evaluator.evaluatorMaterial,
      outputContractSha256: evaluator.outputContractSha256,
      outputSemanticsSha256: evaluator.outputSemanticsSha256,
      admissionReceiptId: admissionReceipt.receiptId,
      outputObservationReceiptId: outputObservationReceipt.receiptId,
      outputContentSha256: expectedHash,
      outputByteLength: expectedLength,
      evaluatedAtMonotonicNs: monotonicNow().toString(),
      outputContractPassed: verdict,
      acceptedForGpuHmr: false as const,
      gpuHmrSuccess: false as const,
      canSatisfyRuntimeProof: false as const,
    });
  } finally {
    if (signalValue !== undefined) {
      reflectApply(eventTargetRemoveEventListener, signalValue, [
        "abort",
        onCallerAbort,
      ]);
    }
    deleteSetValue(claim.boundary.activeEvaluations, lifecycleController);
    destroyEvaluatorBytes(evaluatorBytes);
  }
}
