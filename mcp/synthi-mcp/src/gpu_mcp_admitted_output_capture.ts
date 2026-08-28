import { isProxy } from "node:util/types";
import {
  type GpuParentRuntimeProofAdmissionAuthority,
  type GpuParentRuntimeProofOutputObservation,
} from "./gpu_parent_runtime_proof_admission_authority.js";
import type {
  GpuParentRuntimeProofAdmissionReceipt,
} from "./gpu_parent_runtime_proof_admission_receipt.js";
import type {
  GpuMcpOutputByteProducerCapability,
  GpuMcpOutputByteObservationPermit,
} from "./gpu_mcp_output_byte_observation_boundary.js";
import type {
  GpuMcpOutputEvaluation,
  GpuMcpOutputEvaluatorCapability,
} from "./gpu_mcp_output_evaluation.js";
import {
  snapshotValidatedUint8Array,
} from "./validated_uint8_array.js";

const reflectApply = Reflect.apply;
const bufferFill = Buffer.prototype.fill;
const PromiseIntrinsic = Promise;
const AbortSignalIntrinsic = AbortSignal;
const eventTargetAddEventListener = EventTarget.prototype.addEventListener;
const eventTargetRemoveEventListener = EventTarget.prototype.removeEventListener;

function requiredGetter(
  prototype: object,
  property: string,
): (this: unknown) => unknown {
  const getter = Object.getOwnPropertyDescriptor(
    prototype,
    property,
  )?.get;
  if (getter === undefined) {
    throw new Error("gpu_mcp_admitted_output_capture_intrinsics_unavailable");
  }
  return getter;
}

const abortSignalAbortedGetter =
  requiredGetter(AbortSignal.prototype, "aborted");

export type GpuMcpOutputByteCapture =
  (signal?: AbortSignal) => Uint8Array | Promise<Uint8Array>;

function validCallback(value: unknown): value is () => unknown {
  return typeof value === "function" && !isProxy(value);
}

function assertCurrent(isCurrent: () => boolean): void {
  let current: unknown;
  try {
    current = isCurrent();
  } catch {
    throw new Error("gpu_mcp_admitted_output_capture_lifecycle_check_failed");
  }
  if (current !== true) {
    throw new Error("gpu_mcp_admitted_output_capture_lifecycle_changed");
  }
}

function validAbortSignal(value: unknown): value is AbortSignal {
  return value instanceof AbortSignalIntrinsic && !isProxy(value);
}

function signalAborted(signal: AbortSignal): boolean {
  return reflectApply(
    abortSignalAbortedGetter,
    signal,
    [],
  ) as boolean;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal !== undefined && signalAborted(signal)) {
    throw new Error("gpu_mcp_admitted_output_capture_aborted");
  }
}

async function scheduledOutputByteCapture(
  capture: GpuMcpOutputByteCapture,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  await undefined;
  assertNotAborted(signal);
  return signal === undefined ? capture() : capture(signal);
}

function invokeOutputByteCapture(
  capture: GpuMcpOutputByteCapture,
  signal?: AbortSignal,
): Promise<Uint8Array> {
  if (signal === undefined) {
    return scheduledOutputByteCapture(capture);
  }
  if (!validAbortSignal(signal)) {
    throw new Error("gpu_mcp_admitted_output_capture_abort_signal_invalid");
  }
  if (signalAborted(signal)) {
    throw new Error("gpu_mcp_admitted_output_capture_aborted");
  }
  const pending = scheduledOutputByteCapture(capture, signal);
  return new PromiseIntrinsic<Uint8Array>((resolve, reject) => {
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
      finish(() => reject(
        new Error("gpu_mcp_admitted_output_capture_aborted"),
      ));
    };
    reflectApply(eventTargetAddEventListener, signal, [
      "abort",
      onAbort,
      { once: true },
    ]);
    void (async () => {
      try {
        const bytes = await pending;
        finish(() => resolve(bytes));
      } catch (error) {
        finish(() => reject(error));
      }
    })();
  });
}

async function captureAdmittedOutput<T>(
  authority: GpuParentRuntimeProofAdmissionAuthority,
  producer: GpuMcpOutputByteProducerCapability,
  admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  captureOutputBytes: GpuMcpOutputByteCapture,
  isCurrent: () => boolean,
  consume: (
    permit: GpuMcpOutputByteObservationPermit,
    snapshot: Uint8Array,
  ) => T | Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  if (!validCallback(captureOutputBytes) || !validCallback(isCurrent)) {
    throw new Error("gpu_mcp_admitted_output_capture_callback_invalid");
  }
  if (signal !== undefined && !validAbortSignal(signal)) {
    throw new Error("gpu_mcp_admitted_output_capture_abort_signal_invalid");
  }
  assertNotAborted(signal);
  assertCurrent(isCurrent);
  const permit = authority.createOutputObservationPermit(admissionReceipt);
  assertCurrent(isCurrent);
  const captured = await invokeOutputByteCapture(
    captureOutputBytes,
    signal,
  );
  assertNotAborted(signal);
  assertCurrent(isCurrent);
  const snapshot = snapshotValidatedUint8Array(captured);
  if (snapshot === null) {
    throw new Error("gpu_mcp_admitted_output_capture_bytes_invalid");
  }
  try {
    const result = await consume(permit, snapshot);
    assertNotAborted(signal);
    assertCurrent(isCurrent);
    return result;
  } finally {
    reflectApply(bufferFill, snapshot, [0]);
  }
}

export function captureGpuMcpAdmittedOutputBytes(
  authority: GpuParentRuntimeProofAdmissionAuthority,
  producer: GpuMcpOutputByteProducerCapability,
  admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  captureOutputBytes: GpuMcpOutputByteCapture,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<GpuParentRuntimeProofOutputObservation> {
  return captureAdmittedOutput(
    authority,
    producer,
    admissionReceipt,
    captureOutputBytes,
    isCurrent,
    (permit, snapshot) => {
      const observed = producer.observe(permit, snapshot);
      return authority.observeOutput(admissionReceipt, observed);
    },
    signal,
  );
}

export function captureAndEvaluateGpuMcpAdmittedOutputBytes(
  authority: GpuParentRuntimeProofAdmissionAuthority,
  producer: GpuMcpOutputByteProducerCapability,
  admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  evaluatorCapability: GpuMcpOutputEvaluatorCapability,
  captureOutputBytes: GpuMcpOutputByteCapture,
  isCurrent: () => boolean,
  signal?: AbortSignal,
): Promise<GpuMcpOutputEvaluation> {
  return captureAdmittedOutput(
    authority,
    producer,
    admissionReceipt,
    captureOutputBytes,
    isCurrent,
    async (permit, snapshot) => {
      const observed = producer.observe(permit, snapshot);
      assertCurrent(isCurrent);
      return authority.observeAndEvaluateOutput(
        admissionReceipt,
        observed,
        evaluatorCapability,
        signal,
      );
    },
    signal,
  );
}
