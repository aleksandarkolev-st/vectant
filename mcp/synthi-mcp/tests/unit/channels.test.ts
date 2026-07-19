import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { SessionChannels } from "../../src/channels.js";
import {
  RUNTIME_EVIDENCE_TRANSPORT_ALGORITHM,
  RUNTIME_EVIDENCE_TRANSPORT_DATA_CHANNEL_LABEL,
  RUNTIME_EVIDENCE_TRANSPORT_VERIFICATION_KEY_SCHEMA,
  RuntimeEvidenceTransportKeyPin,
} from "../../src/runtime_evidence_transport.js";
import type { RTCDataChannel } from "werift";

const TRANSPORT_SESSION_ID = "opaque-compile-session:unit-01";

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

    await channels.sendCompileRequest({
      language: "cpp",
      source: "int main(){return 0;}\n".repeat(40),
    });

    expect(sent.length).toBeGreaterThan(1);
    for (const frame of sent) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(240);
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      expect(parsed.type).toBe("compile-request-chunk");
      expect(parsed).not.toHaveProperty("source");
    }
    expect(decodeCompilePayload(sent).gpu_proof_transport_nonce)
      .toMatch(/^gpu-proof-transport-request:[a-f0-9]{32}$/);
    channels.dispose();
  });

  it("injects a one-shot proof nonce and returns a non-secret correlation receipt", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent);

    const receipt = await channels.sendCompileRequest({
      language: "cpp",
      source: "int main(){return 0;}",
    });

    const payload = decodeCompilePayload(sent);
    expect(payload.gpu_proof_transport_nonce)
      .toMatch(/^gpu-proof-transport-request:[a-f0-9]{32}$/);
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

  it("cancels the live proof intent when compile transport fails", async () => {
    const sent: string[] = [];
    const channels = makeChannels(sent, () => {
      throw new Error("synthetic_compile_transport_failure");
    });

    await expect(channels.sendCompileRequest({ source: "int main(){}" }))
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
