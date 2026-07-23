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

export type GpuMcpOutputByteCapture =
  () => Uint8Array | Promise<Uint8Array>;

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
): Promise<T> {
  if (!validCallback(captureOutputBytes) || !validCallback(isCurrent)) {
    throw new Error("gpu_mcp_admitted_output_capture_callback_invalid");
  }
  assertCurrent(isCurrent);
  const permit = authority.createOutputObservationPermit(admissionReceipt);
  assertCurrent(isCurrent);
  const captured = await captureOutputBytes();
  assertCurrent(isCurrent);
  const snapshot = snapshotValidatedUint8Array(captured);
  if (snapshot === null) {
    throw new Error("gpu_mcp_admitted_output_capture_bytes_invalid");
  }
  try {
    const result = await consume(permit, snapshot);
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
  );
}
