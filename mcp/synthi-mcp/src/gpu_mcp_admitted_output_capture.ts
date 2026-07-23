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
} from "./gpu_mcp_output_byte_observation_boundary.js";
import {
  snapshotValidatedUint8Array,
} from "./validated_uint8_array.js";

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

export async function captureGpuMcpAdmittedOutputBytes(
  authority: GpuParentRuntimeProofAdmissionAuthority,
  producer: GpuMcpOutputByteProducerCapability,
  admissionReceipt: GpuParentRuntimeProofAdmissionReceipt,
  captureOutputBytes: GpuMcpOutputByteCapture,
  isCurrent: () => boolean,
): Promise<GpuParentRuntimeProofOutputObservation> {
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
    const observed = producer.observe(permit, snapshot);
    const observation = authority.observeOutput(admissionReceipt, observed);
    assertCurrent(isCurrent);
    return observation;
  } finally {
    snapshot.fill(0);
  }
}
