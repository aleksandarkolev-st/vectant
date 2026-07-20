import { createHash } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SessionChannels } from "../../src/channels.js";
import {
  COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
  computeExpectedOutputSemanticsHash,
  type ComputeExpectedOutputSemantics,
  type ComputeExpectedOutputSemanticsMaterial,
} from "../../src/compute_expected_output_semantics.js";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportKeyPin,
} from "../../src/runtime_evidence_transport.js";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
  type GpuParentRuntimeProofControlVerificationMaterial,
} from "../../src/gpu_parent_runtime_proof_admission.js";
import {
  GpuParentRuntimeProofAdmissionAuthority,
} from "../../src/gpu_parent_runtime_proof_admission_authority.js";
import {
  gpuParentRuntimeProofAdmissionReceiptFixture,
} from "./gpu_parent_runtime_proof_admission_fixture.js";
import type { RTCDataChannel } from "werift";

const TRANSPORT_SESSION_ID = "opaque-compile-session:unit-01";
const EXPECTED_OUTPUT_CONTRACT_HASH = `sha256:${"a".repeat(64)}`;
const ADMISSION_AUTHORITY = new GpuParentRuntimeProofAdmissionAuthority();

function exactOutputSemantics(): ComputeExpectedOutputSemantics {
  const material: ComputeExpectedOutputSemanticsMaterial = {
    schemaVersion: COMPUTE_EXPECTED_OUTPUT_SEMANTICS_SCHEMA_VERSION,
    comparisonMode: "exact_bytes",
    outputTargetId: "output:tensor:0",
    byteOffset: 64,
    byteLength: 16,
    dtype: "u32",
    shape: [2, 2],
    elementCount: 4,
    byteOrder: "little_endian",
    toleranceDecimal: "0",
    expectedValuesDecimal: null,
    expectedValuesHash: null,
    expectedRawHash: `sha256:${"a".repeat(64)}`,
  };
  return { ...material, semanticsHash: computeExpectedOutputSemanticsHash(material) };
}

class MockEvidenceDataChannel extends EventTarget {
  readonly label = RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL;
  readonly readyState = "open" as const;

  emit(data: unknown): void {
    const event = new Event("message");
    (event as unknown as { data: unknown }).data = data;
    this.dispatchEvent(event);
  }

  close(): void {
    this.dispatchEvent(new Event("close"));
  }
}

class MockBuildLogDataChannel extends EventTarget {
  emit(message: Record<string, unknown>): void {
    const event = new Event("message");
    (event as unknown as { data: unknown }).data = JSON.stringify(message);
    this.dispatchEvent(event);
  }
}

function sha256Hex(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function verificationKeyAnnouncement(fill: number): Record<string, unknown> {
  const publicKeyBytes = Buffer.alloc(32, fill);
  const publicKey = publicKeyBytes.toString("base64url");
  const keyId = `gpu-hmr-runtime-evidence-transport-key:sha256:${sha256Hex(publicKeyBytes)}`;
  const workerInstanceId = `gpu-hmr-worker-instance:sha256:${"8".repeat(64)}`;
  const workerProcessId = "9123";
  const producer = "synthi-webrtc-compiler-worker";
  const announcementMaterial = JSON.stringify([
    RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    producer,
    workerInstanceId,
    workerProcessId,
    publicKey,
  ]);
  return {
    schemaVersion: RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
    algorithm: RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
    keyId,
    producer,
    workerInstanceId,
    workerProcessId,
    publicKey,
    keyAnnouncementId:
      `gpu-hmr-runtime-evidence-transport-key-announcement:sha256:${sha256Hex(announcementMaterial)}`,
  };
}

function parentControlVerificationMaterialFixture():
  GpuParentRuntimeProofControlVerificationMaterial {
  return {
    schemaVersion:
      GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
    controlBinding: {
      type: "gpu_hmr_parent_runtime_proof_control_binding",
      signedEvidence: {
        algorithm: RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
        signature: "c2lnbmVkLXB1YmxpYy1ldmlkZW5jZQ",
      },
    },
    runtimeEvidenceTransportVerificationKey:
      verificationKeyAnnouncement(7) as unknown as
        GpuParentRuntimeProofControlVerificationMaterial[
          "runtimeEvidenceTransportVerificationKey"
        ],
    transportContext: {
      transportSessionId: TRANSPORT_SESSION_ID,
      compileRequestNonce: `gpu-proof-transport-request:${"1".repeat(32)}`,
      expectedWorkerProcessId: "9123",
    },
    mcpAdmissionReceipt: gpuParentRuntimeProofAdmissionReceiptFixture(),
  };
}

function pinnedTransport(): {
  pin: RuntimeEvidenceTransportKeyPin;
  channel: MockEvidenceDataChannel;
} {
  const channel = new MockEvidenceDataChannel();
  const pin = new RuntimeEvidenceTransportKeyPin();
  pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
  channel.emit(JSON.stringify(verificationKeyAnnouncement(7)));
  expect(pin.snapshot().status).toBe("pinned");
  return { pin, channel };
}

function pinnedKeyPin(): RuntimeEvidenceTransportKeyPin {
  return pinnedTransport().pin;
}

function decodeCompilePayload(sent: string[]): Record<string, unknown> {
  const first = JSON.parse(sent[0]!) as Record<string, unknown>;
  if (first.type !== "compile-request-chunk") return first;
  const encoded = sent
    .map((frame) => JSON.parse(frame) as Record<string, unknown>)
    .sort((left, right) => Number(left.seq) - Number(right.seq))
    .map((frame) => String(frame.data))
    .join("");
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, unknown>;
}

function makeChannels(
  sent: string[],
  send: (frame: string) => void = (frame) => sent.push(frame),
  buildLogDC: MockBuildLogDataChannel = new MockBuildLogDataChannel(),
  keyPin: RuntimeEvidenceTransportKeyPin = pinnedKeyPin(),
): SessionChannels {
  const terminalDC = {
    readyState: "open",
    send: () => undefined,
  } as unknown as RTCDataChannel;
  const compileDC = {
    readyState: "open",
    send,
  } as unknown as RTCDataChannel;
  return new SessionChannels(terminalDC, buildLogDC as unknown as RTCDataChannel, compileDC, {
    keyPin,
    transportSessionId: TRANSPORT_SESSION_ID,
    admissionReceiptSigner: ADMISSION_AUTHORITY.signer(),
  });
}

describe("SessionChannels compile chunking", () => {
  afterEach(() => {
    delete process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES;
  });

  it("chunks large compile payloads without sending the full request first", async () => {
    process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES = "240";
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await channels.sendCompileRequest(
      {
        language: "cpp",
        source: "int main(){return 0;}\n".repeat(40),
      },
      EXPECTED_OUTPUT_CONTRACT_HASH,
    );

    expect(sent.length).toBeGreaterThan(1);
    for (const frame of sent) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(240);
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      expect(parsed.type).toBe("compile-request-chunk");
      expect(parsed).not.toHaveProperty("source");
    }
    const decoded = decodeCompilePayload(sent);
    expect(decoded.gpu_proof_transport_nonce)
      .toMatch(/^gpu-proof-transport-request:[a-f0-9]{32}$/);
    expect(decoded.compute_expected_output_contract_hash)
      .toBe(EXPECTED_OUTPUT_CONTRACT_HASH);
    channels.dispose();
  });

  it("injects a one-shot proof nonce and returns a non-secret correlation receipt", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent);

    const receipt = await channels.sendCompileRequest(
      {
        language: "cpp",
        source: "int main(){return 0;}",
      },
      EXPECTED_OUTPUT_CONTRACT_HASH,
    );

    const payload = decodeCompilePayload(sent);
    expect(payload.gpu_proof_transport_nonce)
      .toMatch(/^gpu-proof-transport-request:[a-f0-9]{32}$/);
    expect(payload.compute_expected_output_contract_hash)
      .toBe(EXPECTED_OUTPUT_CONTRACT_HASH);
    expect(receipt.proofCorrelationId)
      .toMatch(/^gpu-proof-compile-correlation:sha256:[a-f0-9]{64}$/);
    expect(receipt.proofCorrelationId).not.toContain(
      String(payload.gpu_proof_transport_nonce),
    );
    expect(Number.isSafeInteger(receipt.dispatchedAt)).toBe(true);
    expect(receipt).toMatchObject({
      schemaVersion: "synthi.gpu_hmr.compile_dispatch_correlation.v1",
      proofAuthority: "compile_dispatch_correlation_only_not_gpu_hmr_acceptance",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(receipt)).toBe(true);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot()).toMatchObject({
      status: "active",
      pendingIntentCount: 1,
      verifiedBindingCount: 0,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    });
    channels.dispose();
  });

  it("revalidates, snapshots, and transports caller-owned output semantics", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent);
    const semantics = exactOutputSemantics();

    const receipt = await channels.sendCompileRequest(
      { language: "cpp", source: "int main(){return 0;}" },
      undefined,
      semantics,
    );

    const payload = decodeCompilePayload(sent);
    expect(payload.compute_expected_output_semantics).toEqual(semantics);
    expect(payload).not.toHaveProperty("compute_expected_output_semantics_hash");
    expect(receipt.computeExpectedOutputSemanticsHash).toBe(semantics.semanticsHash);
    expect(Object.isFrozen(receipt)).toBe(true);
    channels.dispose();
  });

  it("omits an absent expected-output contract hash on the direct wire path", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await channels.sendCompileRequest({ source: "int main(){}" });

    expect(decodeCompilePayload(sent))
      .not.toHaveProperty("compute_expected_output_contract_hash");
    channels.dispose();
  });

  it("rejects caller-supplied transport nonces", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(channels.sendCompileRequest({
      source: "int main(){}",
      gpu_proof_transport_nonce:
        "gpu-proof-transport-request:0123456789abcdef0123456789abcdef",
    })).rejects.toThrow("compile_gpu_proof_transport_nonce_reserved");

    expect(sent).toEqual([]);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });

  it.each([
    "compute_expected_output_contract_hash",
    "computeExpectedOutputContractHash",
  ])("rejects caller-supplied expected-output wire field %s", async (field) => {
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(channels.sendCompileRequest({
      source: "int main(){}",
      [field]: EXPECTED_OUTPUT_CONTRACT_HASH,
    })).rejects.toThrow("compile_compute_expected_output_contract_hash_reserved");

    expect(sent).toEqual([]);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });

  it.each([
    "compute_expected_output_semantics",
    "computeExpectedOutputSemantics",
    "compute_expected_output_semantics_hash",
    "computeExpectedOutputSemanticsHash",
  ])("rejects caller-supplied semantic wire field %s", async (field) => {
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(channels.sendCompileRequest({
      source: "int main(){}",
      [field]: exactOutputSemantics(),
    })).rejects.toThrow("compile_compute_expected_output_semantics_reserved");

    expect(sent).toEqual([]);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });

  it("rejects mutated semantic preimages before issuing an admission intent", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent);
    const semantics = { ...exactOutputSemantics(), byteOffset: 2 };

    await expect(channels.sendCompileRequest(
      { source: "int main(){}" },
      undefined,
      semantics,
    )).rejects.toThrow("compile_compute_expected_output_semantics_invalid");

    expect(sent).toEqual([]);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });

  it.each([
    `sha256:${"A".repeat(64)}`,
    `sha256:${"g".repeat(64)}`,
    "sha256:short",
  ])("rejects an invalid expected-output contract hash before dispatch (%s)", async (
    expectedOutputContractHash,
  ) => {
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(channels.sendCompileRequest(
      { source: "int main(){}" },
      expectedOutputContractHash,
    )).rejects.toThrow("compile_compute_expected_output_contract_hash_invalid");

    expect(sent).toEqual([]);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });

  it("cancels the live proof intent when compile transport fails", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent, () => {
      throw new Error("synthetic_compile_transport_failure");
    });

    await expect(channels.sendCompileRequest(
      { source: "int main(){}" },
      EXPECTED_OUTPUT_CONTRACT_HASH,
    ))
      .rejects.toThrow("synthetic_compile_transport_failure");

    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });

  it("suppresses unbound full-runtime claims before HMR proof classification", () => {
    const sent: string[] = [];
    const buildLog = new MockBuildLogDataChannel();
    const channels = makeChannels(sent, (frame) => sent.push(frame), buildLog);
    const publicMessages: Record<string, unknown>[] = [];
    channels.hmr.onMessage((message) => publicMessages.push(message));

    buildLog.emit({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
    });
    expect(channels.hmr.latestGpuProof()).toBeNull();
    expect(publicMessages).toEqual([]);

    buildLog.emit({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-compile-proven",
    });
    expect(channels.hmr.latestGpuProof()?.resultState).toBe("gpu-hmr-compile-proven");
    expect(publicMessages).toHaveLength(1);
    channels.dispose();
  });

  it("takes parent-control material only for the admitted strict parent proof", () => {
    const buildLog = new MockBuildLogDataChannel();
    const transport = pinnedTransport();
    const channels = makeChannels(
      [],
      () => undefined,
      buildLog,
      transport.pin,
    );
    const admission = (channels as unknown as {
      gpuParentRuntimeProofAdmission: {
        beforeClassify: (
          message: Record<string, unknown>,
          observedAt: number,
        ) => boolean;
        takeControlVerificationMaterial: (
          fullRuntimeProofId: string,
        ) => GpuParentRuntimeProofControlVerificationMaterial | null;
      };
    }).gpuParentRuntimeProofAdmission;
    const beforeClassify = vi.spyOn(admission, "beforeClassify");
    const takeMaterial = vi.spyOn(
      admission,
      "takeControlVerificationMaterial",
    );
    const material = parentControlVerificationMaterialFixture();
    takeMaterial.mockReturnValue(material);
    beforeClassify
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false);

    const admittedProofId = `gpu-runtime-proof:sha256:${"2".repeat(64)}`;
    const admittedProof = {
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
      parentVerification: { fullRuntimeProofId: admittedProofId },
    };
    const publicMessages: Record<string, unknown>[] = [];
    const retainedProofs: NonNullable<
      ReturnType<typeof channels.hmr.latestGpuProof>
    >[] = [];
    channels.hmr.onMessage((message) => publicMessages.push(message));
    channels.hmr.onGpuProof({}, (proof) => retainedProofs.push(proof));

    buildLog.emit({
      type: "gpu_hmr_parent_runtime_proof_control_binding",
      fullRuntimeProofId: admittedProofId,
    });
    buildLog.emit({ type: "ordinary-event", value: 1 });
    buildLog.emit({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-compile-proven",
    });
    buildLog.emit({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
      parentVerification: { fullRuntimeProofId: admittedProofId },
      runtimeEvidenceTransportReceipt: { signature: "rejected" },
    });
    buildLog.emit({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
      parentVerification: {
        fullRuntimeProofId: `gpu-runtime-proof:sha256:${"3".repeat(64)}`,
      },
    });
    const admittedWireBytes = JSON.stringify(admittedProof);
    buildLog.emit(admittedProof);
    buildLog.emit(admittedProof);

    expect(beforeClassify).toHaveBeenCalledTimes(7);
    expect(takeMaterial).toHaveBeenCalledTimes(1);
    expect(takeMaterial).toHaveBeenCalledWith(admittedProofId);
    expect(beforeClassify.mock.invocationCallOrder[5])
      .toBeLessThan(takeMaterial.mock.invocationCallOrder[0]!);
    expect(retainedProofs).toHaveLength(2);
    expect(retainedProofs[0]).not.toHaveProperty(
      "parentControlVerificationMaterial",
    );
    expect(retainedProofs[1]?.parentControlVerificationMaterial)
      .toEqual(material);
    expect(Object.isFrozen(
      retainedProofs[1]?.parentControlVerificationMaterial?.controlBinding,
    )).toBe(true);
    expect(Object.isFrozen(
      retainedProofs[1]?.parentControlVerificationMaterial
        ?.mcpAdmissionReceipt,
    )).toBe(true);
    expect(publicMessages).toEqual([
      { type: "ordinary-event", value: 1 },
      { type: "gpu_hmr_proof", resultState: "gpu-hmr-compile-proven" },
      admittedProof,
    ]);
    expect(JSON.stringify(publicMessages[2])).toBe(admittedWireBytes);
    expect(publicMessages[2]).not.toHaveProperty(
      "parentControlVerificationMaterial",
    );

    beforeClassify.mockRestore();
    takeMaterial.mockClear();
    transport.channel.close();
    buildLog.emit(admittedProof);
    expect(takeMaterial).not.toHaveBeenCalled();
    expect(channels.hmr.latestGpuProof()).toBeNull();
    channels.dispose();
  });

  it("suppresses an admitted-looking strict parent proof when its material is missing", () => {
    const buildLog = new MockBuildLogDataChannel();
    const channels = makeChannels([], () => undefined, buildLog);
    const admission = (channels as unknown as {
      gpuParentRuntimeProofAdmission: {
        beforeClassify: (
          message: Record<string, unknown>,
          observedAt: number,
        ) => boolean;
        takeControlVerificationMaterial: (
          fullRuntimeProofId: string,
        ) => GpuParentRuntimeProofControlVerificationMaterial | null;
      };
    }).gpuParentRuntimeProofAdmission;
    const beforeClassify = vi.spyOn(admission, "beforeClassify")
      .mockReturnValue(true);
    const takeMaterial = vi.spyOn(
      admission,
      "takeControlVerificationMaterial",
    ).mockReturnValue(null);
    const publicMessages: Record<string, unknown>[] = [];
    const retainedProofs: NonNullable<
      ReturnType<typeof channels.hmr.latestGpuProof>
    >[] = [];
    channels.hmr.onMessage((message) => publicMessages.push(message));
    channels.hmr.onGpuProof({}, (proof) => retainedProofs.push(proof));
    const ordinaryMessage = { type: "ordinary-event", value: 2 };
    const nonStrictProof = {
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-compile-proven",
    };
    const fullRuntimeProofId =
      `gpu-runtime-proof:sha256:${"9".repeat(64)}`;

    buildLog.emit(ordinaryMessage);
    buildLog.emit(nonStrictProof);
    buildLog.emit({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
      parentVerification: { fullRuntimeProofId },
    });

    expect(beforeClassify).toHaveBeenCalledTimes(3);
    expect(takeMaterial).toHaveBeenCalledTimes(1);
    expect(takeMaterial).toHaveBeenCalledWith(fullRuntimeProofId);
    expect(publicMessages).toEqual([ordinaryMessage, nonStrictProof]);
    expect(retainedProofs).toHaveLength(1);
    expect(retainedProofs[0]?.resultState).toBe("gpu-hmr-compile-proven");
    expect(retainedProofs[0]).not.toHaveProperty(
      "parentControlVerificationMaterial",
    );
    expect(channels.hmr.latestGpuProof()).toBe(retainedProofs[0]);
    channels.dispose();
  });

  it.each(["closed", "replaced", "disposed"] as const)(
    "revokes proof state when authenticated evidence transport is %s",
    async (transition) => {
      const sent: string[] = [];
      const buildLog = new MockBuildLogDataChannel();
      const transport = pinnedTransport();
      const channels = makeChannels(
        sent,
        (frame) => sent.push(frame),
        buildLog,
        transport.pin,
      );
      await channels.sendCompileRequest({ source: "int main(){}" });
      buildLog.emit({
        type: "gpu_hmr_proof",
        module: "arbitrary-module",
        resultState: "gpu-hmr-compile-proven",
      });
      expect(channels.hmr.latestGpuProof()).not.toBeNull();
      expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(1);

      const invalidations: Record<string, unknown>[] = [];
      const publicMessages: Record<string, unknown>[] = [];
      channels.hmr.onGpuProofTrustInvalidated((event) => invalidations.push(event));
      channels.hmr.onMessage((message) => publicMessages.push(message));
      if (transition === "closed") {
        transport.channel.close();
      } else if (transition === "replaced") {
        transport.channel.emit(JSON.stringify(verificationKeyAnnouncement(6)));
      } else {
        transport.pin.dispose();
      }

      const expectedReason = transition === "disposed"
        ? "runtime_evidence_transport_disposed"
        : "runtime_evidence_transport_failed";
      expect(invalidations).toHaveLength(1);
      expect(invalidations[0]).toMatchObject({
        reasonClass: expectedReason,
        acceptedForGpuHmr: false,
        gpuHmrSuccess: false,
      });
      expect(channels.hmr.latestGpuProof()).toBeNull();
      expect(channels.gpuParentRuntimeProofAdmissionSnapshot()).toMatchObject({
        status: "failed",
        pendingIntentCount: 0,
        verifiedBindingCount: 0,
        failureReason: `gpu_parent_runtime_proof_admission_${expectedReason}`,
      });

      buildLog.emit({
        type: "gpu_hmr_proof",
        module: "arbitrary-module",
        resultState: "gpu-hmr-compile-proven",
      });
      buildLog.emit({ type: "ordinary-event", value: 1 });
      expect(publicMessages).toEqual([{ type: "ordinary-event", value: 1 }]);
      expect(channels.hmr.latestGpuProof()).toBeNull();
      await expect(channels.sendCompileRequest({ source: "int main(){return 1;}" }))
        .rejects.toThrow(/runtime_evidence_transport_/);
      channels.dispose();
    },
  );

  it("inherits an already-failed evidence key pin as terminal proof distrust", () => {
    const channel = new MockEvidenceDataChannel();
    const pin = new RuntimeEvidenceTransportKeyPin();
    pin.bindAuthenticatedPeerDataChannel(channel as unknown as RTCDataChannel);
    channel.emit("not-json");
    expect(pin.snapshot().status).toBe("failed");

    const buildLog = new MockBuildLogDataChannel();
    const channels = makeChannels([], () => undefined, buildLog, pin);
    const invalidations: Record<string, unknown>[] = [];
    const publicMessages: Record<string, unknown>[] = [];
    channels.hmr.onGpuProofTrustInvalidated((event) => invalidations.push(event));
    channels.hmr.onMessage((message) => publicMessages.push(message));
    buildLog.emit({ type: "ordinary-event", value: 2 });

    expect(invalidations).toHaveLength(1);
    expect(invalidations[0]).toMatchObject({
      reasonClass: "runtime_evidence_transport_failed",
      acceptedForGpuHmr: false,
    });
    expect(publicMessages).toEqual([{ type: "ordinary-event", value: 2 }]);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot()).toMatchObject({
      status: "failed",
      pendingIntentCount: 0,
      verifiedBindingCount: 0,
    });
    channels.dispose();
  });

  it("rejects invalid chunk byte configuration before sending", async () => {
    process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES = "not-a-number";
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(
      channels.sendCompileRequest({ source: "x".repeat(512) }),
    ).rejects.toThrow("invalid_compile_chunk_bytes:not-a-number");
    expect(sent).toHaveLength(0);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });

  it("rejects too-small chunk byte limits instead of exceeding them", async () => {
    process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES = "32";
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(
      channels.sendCompileRequest({ source: "x".repeat(512) }),
    ).rejects.toThrow("compile_chunk_bytes_too_small:32");
    expect(sent).toHaveLength(0);
    expect(channels.gpuParentRuntimeProofAdmissionSnapshot().pendingIntentCount).toBe(0);
    channels.dispose();
  });
});
