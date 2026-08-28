import {
  GpuParentRuntimeProofAdmissionAuthority,
} from "../../src/gpu_parent_runtime_proof_admission_authority.js";
import type {
  GpuParentRuntimeProofAdmissionReceipt,
  GpuParentRuntimeProofAdmissionReceiptInput,
} from "../../src/gpu_parent_runtime_proof_admission_receipt.js";

const authority = new GpuParentRuntimeProofAdmissionAuthority();

function hash(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

const controlBindingCanonicalSha256 = hash("4");
const baseInput: GpuParentRuntimeProofAdmissionReceiptInput = Object.freeze({
  transportSessionId: "opaque-transport-session:telemetry-01",
  compileRequestNonce: `gpu-proof-transport-request:${"1".repeat(32)}`,
  computeExpectedOutputContractHash: hash("a"),
  computeExpectedOutputSemanticsHash: hash("b"),
  workerKeyId:
    `gpu-hmr-runtime-evidence-transport-key:sha256:${"2".repeat(64)}`,
  workerKeyAnnouncementId:
    `gpu-hmr-runtime-evidence-transport-key-announcement:sha256:${"3".repeat(64)}`,
  workerProcessId: "9123",
  controlBindingId:
    `gpu-parent-runtime-proof-control-binding:${controlBindingCanonicalSha256}`,
  controlBindingCanonicalSha256,
  controlTransportReceiptId:
    `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"5".repeat(64)}`,
  controlObservationContextHash: hash("6"),
  parentReceiptId:
    `gpu-parent-runtime-proof-receipt:sha256:${"7".repeat(64)}`,
  parentTransportReceiptId:
    `gpu-hmr-runtime-evidence-transport-receipt:sha256:${"8".repeat(64)}`,
  parentCanonicalProofSha256: hash("9"),
  parentObservationContextHash: hash("0"),
  requestId: `gpu-reload:request:${"c".repeat(32)}`,
  sourceEditId: `source-edit:sha256:${"d".repeat(64)}`,
  artifactContentHash: hash("e"),
  fullRuntimeProofId: `gpu-runtime-proof:sha256:${"f".repeat(64)}`,
  proofLedgerId: `gpu-ledger-proof:sha256:${"1".repeat(64)}`,
  runnerProcessId: 8123,
  runnerRuntimeSessionId: "opaque-runtime-session:telemetry-02",
  runnerChallenge: "23456789abcdef0123456789abcdef01",
  commandEnvelopeSha256: hash("2"),
  protectedProofJsonSha256: hash("3"),
});

export function gpuParentRuntimeProofAdmissionReceiptFixture(
  overrides: Partial<GpuParentRuntimeProofAdmissionReceiptInput> = {},
): GpuParentRuntimeProofAdmissionReceipt {
  return authority.signer().signAdmissionReceipt({
    ...baseInput,
    ...overrides,
  });
}
