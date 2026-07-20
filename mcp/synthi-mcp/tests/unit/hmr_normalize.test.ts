import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import {
  classifyHmrMessage,
  HmrNormalizer,
  parseWireMessages,
  projectPublicHmrEvent,
  type WireMessage,
} from "../../src/hmr.js";
import {
  GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
  type GpuParentRuntimeProofControlVerificationMaterial,
} from "../../src/gpu_parent_runtime_proof_admission.js";
import {
  gpuParentRuntimeProofAdmissionReceiptFixture,
} from "./gpu_parent_runtime_proof_admission_fixture.js";

/**
 * Minimal DC mock: extends EventTarget and dispatches synthetic message events.
 * The HmrNormalizer only reads `event.data`, so plain Event objects with a
 * `.data` property are sufficient.
 */
class MockDC extends EventTarget {
  emit(data: string | ArrayBuffer): void {
    const ev = new Event("message");
    (ev as unknown as { data: unknown }).data = data;
    this.dispatchEvent(ev);
  }
}

function dc(): MockDC {
  return new MockDC();
}

function parentControlVerificationMaterialFixture():
  GpuParentRuntimeProofControlVerificationMaterial {
  return {
    schemaVersion:
      GPU_PARENT_RUNTIME_PROOF_CONTROL_VERIFICATION_MATERIAL_SCHEMA_VERSION,
    controlBinding: {
      type: "gpu_hmr_parent_runtime_proof_control_binding",
      signedEvidence: {
        algorithm: "ed25519",
        signature: "c2lnbmVkLXB1YmxpYy1ldmlkZW5jZQ",
      },
    },
    runtimeEvidenceTransportVerificationKey: {
      schemaVersion:
        "synthi.gpu_hmr.runtime_evidence_transport_verification_key.v1",
      algorithm: "ed25519",
      keyId: "runtime-evidence-key:fixture",
      producer: "synthi-webrtc-compiler-worker",
      workerInstanceId: "runtime-worker:fixture",
      workerProcessId: "731",
      publicKey: "cHVibGljLWV2aWRlbmNl",
      keyAnnouncementId: "runtime-evidence-key-announcement:fixture",
    },
    transportContext: {
      transportSessionId: "transport-session:fixture",
      compileRequestNonce: `gpu-proof-transport-request:${"4".repeat(32)}`,
      expectedWorkerProcessId: "731",
    },
    mcpAdmissionReceipt: gpuParentRuntimeProofAdmissionReceiptFixture(),
  };
}

function chunkWireMessage(msg: WireMessage, chunkBytes = 128): string[] {
  const body = Buffer.from(JSON.stringify(msg), "utf8");
  const hash = createHash("sha256").update(body).digest("hex");
  const total = Math.ceil(body.byteLength / chunkBytes);
  return Array.from({ length: total }, (_, index) => {
    const start = index * chunkBytes;
    const end = Math.min(body.byteLength, start + chunkBytes);
    return JSON.stringify({
      type: "structured-json-chunk",
      schemaVersion: "synthi.build_log.structured_json_chunk.v1",
      chunkId: `structured-json:sha256:${hash}`,
      encoding: "base64:utf8",
      sha256: `sha256:${hash}`,
      byteLength: body.byteLength,
      index,
      total,
      data: body.subarray(start, end).toString("base64"),
    });
  });
}

function terminalDiagnosticCanaries(): {
  module: string;
  previewId: string;
  signedUrl: string;
  resourceId: string;
  bearer: string;
  cookie: string;
} {
  const suffix = createHash("sha256")
    .update("hmr-terminal-diagnostic-canary")
    .digest("hex")
    .slice(0, 16);
  return {
    module: `module-${suffix}`,
    previewId: `preview-${suffix}`,
    signedUrl: `https://user:password@provider.invalid/v1/resource-${suffix}?signature=synthetic`,
    resourceId: `projects/${Number.parseInt(suffix.slice(0, 10), 16)}`,
    bearer: `Bearer header.${suffix}.signature`,
    cookie: `session=${suffix}`,
  };
}

function expectProjectedTerminalDetail(
  detail: Record<string, unknown> | undefined,
  canaries: ReturnType<typeof terminalDiagnosticCanaries>
): void {
  expect(detail).toBeDefined();
  expect(detail?.schemaVersion).toBe("synthi.hmr.public_terminal_diagnostic.v1");
  expect(detail?.proofAuthority).toBe("terminal_diagnostic_only_not_gpu_hmr_acceptance");
  expect(detail?.acceptedForGpuHmr).toBe(false);
  expect(detail?.gpuHmrSuccess).toBe(false);
  expect(detail?.moduleRef).toMatch(/^hmr-terminal-module-ref:sha256:[a-f0-9]{64}$/);
  expect(detail?.previewRef).toMatch(/^hmr-terminal-preview-ref:sha256:[a-f0-9]{64}$/);
  const serialized = JSON.stringify(detail);
  for (const canary of Object.values(canaries)) {
    expect(serialized).not.toContain(canary);
  }
  expect(detail).not.toHaveProperty("reason");
  expect(detail).not.toHaveProperty("message");
  expect(detail).not.toHaveProperty("diagnostics");
  expect(detail).not.toHaveProperty("module");
  expect(detail).not.toHaveProperty("preview_id");
}

describe("classifyHmrMessage (pure)", () => {
  it("projects terminal and non-terminal wire messages without retaining raw fields", () => {
    const canaries = terminalDiagnosticCanaries();
    const terminal = projectPublicHmrEvent({
      status: "rejected",
      module: canaries.module,
      preview_id: canaries.previewId,
      reason: canaries.signedUrl,
      authorization: canaries.bearer,
    });
    expect(terminal.status).toBe("rejected");
    expect(terminal.source).toBe("hmr_status");
    expectProjectedTerminalDetail(terminal.diagnostic, canaries);

    const intermediate = projectPublicHmrEvent({
      type: "compile-start",
      module: canaries.module,
      preview_id: canaries.previewId,
      stdout: canaries.signedUrl,
      headers: { authorization: canaries.bearer, cookie: canaries.cookie },
    });
    expect(intermediate.status).toBe("intermediate");
    expect(intermediate.source).toBe("wire_message");
    expect(intermediate.diagnostic.reasonClass).toBe("nonterminal_transition");
    expectProjectedTerminalDetail(intermediate.diagnostic, canaries);
  });

  describe("Family 1 — CandidateNotification", () => {
    it("Promoted → applied / candidate_notification", () => {
      const result = classifyHmrMessage({
        event: "Promoted",
        data: { preview_id: "p1", generation: 5, total_reload_ms: 42 },
      });
      expect(result?.status).toBe("applied");
      expect(result?.source).toBe("candidate_notification");
    });

    it("RolledBack → rejected", () => {
      const result = classifyHmrMessage({
        event: "RolledBack",
        data: { preview_id: "p1", generation: 5, reason: "abi mismatch" },
      });
      expect(result?.status).toBe("rejected");
      expect(result?.source).toBe("candidate_notification");
    });

    it("Discarded → discarded", () => {
      const result = classifyHmrMessage({
        event: "Discarded",
        data: { preview_id: "p1", generation: 5, reason: "superseded" },
      });
      expect(result?.status).toBe("discarded");
    });

    it("Enqueued / Loading / HealthCheckStarted / HealthCheckCompleted / PromotionDecision → null", () => {
      for (const event of [
        "Enqueued",
        "Loading",
        "HealthCheckStarted",
        "HealthCheckCompleted",
        "PromotionDecision",
      ]) {
        expect(classifyHmrMessage({ event, data: {} })).toBeNull();
      }
    });
  });

  describe("Family 2 — bare HmrStatus", () => {
    it("applied → applied / hmr_status", () => {
      const result = classifyHmrMessage({
        status: "applied",
        module: "core",
        capability: "Full HMR",
        state_preserved: true,
      });
      expect(result?.status).toBe("applied");
      expect(result?.source).toBe("hmr_status");
    });

    it("state-migrated → applied", () => {
      expect(classifyHmrMessage({ status: "state-migrated" })?.status).toBe("applied");
    });

    it("rejected → rejected", () => {
      expect(classifyHmrMessage({ status: "rejected", reason: "abi" })?.status).toBe("rejected");
    });

    it("compile-error → compile-error", () => {
      expect(classifyHmrMessage({ status: "compile-error" })?.status).toBe("compile-error");
    });

    it("full-reload-required → full-reload-required", () => {
      expect(classifyHmrMessage({ status: "full-reload-required" })?.status).toBe(
        "full-reload-required"
      );
    });

    it("done / host-kv-* / capability-detected → null (NOT terminal)", () => {
      expect(classifyHmrMessage({ status: "done", success: true, stage: "adapter" })).toBeNull();
      expect(classifyHmrMessage({ status: "done", success: true, stage: "runner" })).toBeNull();
      expect(classifyHmrMessage({ status: "done", success: false })).toBeNull();
      expect(classifyHmrMessage({ status: "host-kv-preserved" })).toBeNull();
      expect(classifyHmrMessage({ status: "host-kv-reset-schema-mismatch" })).toBeNull();
      expect(classifyHmrMessage({ status: "host-kv-ready" })).toBeNull();
      expect(classifyHmrMessage({ status: "capability-detected" })).toBeNull();
      expect(classifyHmrMessage({ status: "gpu-proof-state", resultState: "gpu-hmr-symbol-bound" })).toBeNull();
    });
  });

  describe("Family 3 — rollback / planner hmr-status", () => {
    it("{type:'hmr-status', status:'rejected'} → rejected / rollback_notification", () => {
      const result = classifyHmrMessage({
        type: "hmr-status",
        status: "rejected",
        reason_code: "abi_incompatible",
        reason: "missing symbol",
      });
      expect(result?.status).toBe("rejected");
      expect(result?.source).toBe("rollback_notification");
    });

    it("{type:'hmr-status', status:'reload-planned'} → null", () => {
      expect(
        classifyHmrMessage({
          type: "hmr-status",
          status: "reload-planned",
          decision: "warm_reload",
        })
      ).toBeNull();
    });
  });

  describe("Family 4 — compile-diagnostics", () => {
    it("error_count > 0 → compile-error / compile_diagnostics", () => {
      const result = classifyHmrMessage({
        type: "compile-diagnostics",
        module: "core",
        error_count: 2,
        diagnostics: [],
      });
      expect(result?.status).toBe("compile-error");
      expect(result?.source).toBe("compile_diagnostics");
    });

    it("error_count === 0 → null", () => {
      expect(
        classifyHmrMessage({ type: "compile-diagnostics", error_count: 0, diagnostics: [] })
      ).toBeNull();
    });
  });

  describe("unknown / stream pass-through", () => {
    it("stdout/stderr lines → null", () => {
      expect(classifyHmrMessage({ type: "stdout", line: "hello", sessionId: "s" })).toBeNull();
      expect(classifyHmrMessage({ type: "stderr", line: "oops", sessionId: "s" })).toBeNull();
    });

    it("ai_status / adapter_status / adapter_health → null", () => {
      expect(classifyHmrMessage({ type: "ai_status" })).toBeNull();
      expect(classifyHmrMessage({ type: "adapter_status" })).toBeNull();
      expect(classifyHmrMessage({ type: "adapter_health" })).toBeNull();
    });

    it("empty / unknown → null", () => {
      expect(classifyHmrMessage({})).toBeNull();
      expect(classifyHmrMessage({ type: "mystery" })).toBeNull();
    });
  });
});

describe("HmrNormalizer preclassification gate", () => {
  it("runs before terminal classification, proof retention, and public listeners", async () => {
    const mockDC = dc();
    const observed: WireMessage[] = [];
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
      {
        beforeClassify(message) {
          observed.push(message);
          return false;
        },
      },
    );
    const publicMessages: WireMessage[] = [];
    normalizer.onMessage((message) => publicMessages.push(message));

    mockDC.emit(JSON.stringify({ status: "applied", module: "arbitrary-module" }));
    mockDC.emit(JSON.stringify({
      status: "gpu-proof-state",
      module: "arbitrary-module",
      resultState: "gpu-hmr-full-runtime-proven",
    }));

    expect(observed).toHaveLength(2);
    expect(publicMessages).toEqual([]);
    expect(normalizer.latestGpuProof()).toBeNull();
    await expect(normalizer.waitForTerminal({ timeoutMs: 1 })).resolves.toMatchObject({
      status: "timeout",
      source: "timeout",
    });
    normalizer.dispose();
  });

  it("retains exact boolean callback behavior for admitted messages", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
      { beforeClassify: () => true },
    );
    const publicMessages: WireMessage[] = [];
    normalizer.onMessage((message) => publicMessages.push(message));

    mockDC.emit(JSON.stringify({ status: "applied", module: "arbitrary-module" }));

    expect(publicMessages).toEqual([{ status: "applied", module: "arbitrary-module" }]);
    normalizer.dispose();
  });

  it("attaches an included parent-control sidecar without changing proof wire data", () => {
    const mockDC = dc();
    const material = parentControlVerificationMaterialFixture();
    const wireMessage = {
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
      parentVerification: {
        fullRuntimeProofId: `gpu-runtime-proof:sha256:${"5".repeat(64)}`,
      },
    };
    const wireBytes = JSON.stringify(wireMessage);
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
      {
        beforeClassify: () => ({
          include: true,
          parentControlVerificationMaterial: material,
        }),
      },
    );
    const publicMessages: WireMessage[] = [];
    normalizer.onMessage((message) => publicMessages.push(message));

    mockDC.emit(wireBytes);

    const proof = normalizer.latestGpuProof();
    const canonicalMaterial = proof?.parentControlVerificationMaterial;
    expect(proof).not.toBeNull();
    expect(canonicalMaterial).toEqual(material);
    expect(canonicalMaterial).not.toBe(material);
    expect(Object.isFrozen(canonicalMaterial)).toBe(true);
    expect(Object.isFrozen(canonicalMaterial?.controlBinding)).toBe(true);
    expect(Object.isFrozen(
      canonicalMaterial?.runtimeEvidenceTransportVerificationKey,
    )).toBe(true);
    expect(Object.isFrozen(canonicalMaterial?.transportContext)).toBe(true);
    expect(Object.isFrozen(canonicalMaterial?.mcpAdmissionReceipt)).toBe(true);
    expect(Object.isFrozen(material)).toBe(false);
    expect(publicMessages).toEqual([wireMessage]);
    expect(JSON.stringify(publicMessages[0])).toBe(wireBytes);
    expect(publicMessages[0]).not.toHaveProperty(
      "parentControlVerificationMaterial",
    );
    normalizer.dispose();
  });

  it("suppresses typed preclassification decisions", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
      {
        beforeClassify: () => ({
          include: false,
          parentControlVerificationMaterial:
            parentControlVerificationMaterialFixture(),
        }),
      },
    );
    const publicListener = vi.fn();
    normalizer.onMessage(publicListener);

    mockDC.emit(JSON.stringify({
      type: "gpu_hmr_proof",
      resultState: "gpu-hmr-full-runtime-proven",
    }));

    expect(publicListener).not.toHaveBeenCalled();
    expect(normalizer.latestGpuProof()).toBeNull();
    normalizer.dispose();
  });

  it("fails closed when the gate throws", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
      {
        beforeClassify() {
          throw new Error("synthetic_gate_failure");
        },
      },
    );
    const publicListener = vi.fn();
    normalizer.onMessage(publicListener);

    mockDC.emit(JSON.stringify({ status: "applied" }));

    expect(publicListener).not.toHaveBeenCalled();
    normalizer.dispose();
  });
});

describe("HmrNormalizer GPU proof trust invalidation", () => {
  it("revokes retained proof one way while preserving ordinary HMR traffic", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
    );
    const publicMessages: WireMessage[] = [];
    const proofListener = vi.fn();
    normalizer.onMessage((message) => publicMessages.push(message));
    normalizer.onGpuProof({ module: "arbitrary-module" }, proofListener);

    mockDC.emit(JSON.stringify({
      status: "gpu-proof-state",
      module: "arbitrary-module",
      resultState: "gpu-hmr-compile-proven",
    }));
    expect(normalizer.latestGpuProof()?.resultState).toBe("gpu-hmr-compile-proven");
    expect(normalizer.latestGpuProof({ module: "arbitrary-module" })).not.toBeNull();
    expect(proofListener).toHaveBeenCalledTimes(1);

    const activeInvalidationListener = vi.fn();
    normalizer.onGpuProofTrustInvalidated(activeInvalidationListener);
    const invalidation = normalizer.invalidateGpuProofTrust(
      "runtime_evidence_transport_failed",
    );
    expect(invalidation).toMatchObject({
      schemaVersion: "synthi.gpu_hmr.proof_trust_invalidation.v1",
      proofAuthority: "proof_trust_invalidation_only_not_gpu_hmr_acceptance",
      reasonClass: "runtime_evidence_transport_failed",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
    });
    expect(Object.isFrozen(invalidation)).toBe(true);
    expect(activeInvalidationListener).toHaveBeenCalledTimes(1);
    expect(normalizer.latestGpuProof()).toBeNull();
    expect(normalizer.latestGpuProof({ module: "arbitrary-module" })).toBeNull();

    const lateInvalidationListener = vi.fn();
    normalizer.onGpuProofTrustInvalidated(lateInvalidationListener);
    expect(lateInvalidationListener).toHaveBeenCalledWith(invalidation);
    expect(normalizer.invalidateGpuProofTrust("runtime_evidence_transport_disposed"))
      .toBe(invalidation);
    expect(activeInvalidationListener).toHaveBeenCalledTimes(1);

    publicMessages.length = 0;
    mockDC.emit(JSON.stringify({
      status: "gpu-proof-state",
      module: "arbitrary-module",
      resultState: "gpu-hmr-full-runtime-proven",
    }));
    mockDC.emit(JSON.stringify({ type: "frame-ready", frame_sequence: 42 }));
    const sinceTs = Date.now();
    mockDC.emit(JSON.stringify({ status: "applied", module: "arbitrary-module" }));

    expect(proofListener).toHaveBeenCalledTimes(1);
    expect(normalizer.latestGpuProof()).toBeNull();
    expect(publicMessages).toEqual([
      { type: "frame-ready", frame_sequence: 42 },
      { status: "applied", module: "arbitrary-module" },
    ]);
    await expect(normalizer.waitForTerminal({
      module: "arbitrary-module",
      sinceTs,
      timeoutMs: 1,
    })).resolves.toMatchObject({ status: "applied", retained: true });
    normalizer.dispose();
  });

  it("invalidates proof trust before dispose clears listeners", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
    );
    const listener = vi.fn();
    normalizer.onGpuProofTrustInvalidated(() => {
      throw new Error("synthetic_invalidation_listener_failure");
    });
    normalizer.onGpuProofTrustInvalidated(listener);

    normalizer.dispose();

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0]![0]).toMatchObject({
      reasonClass: "hmr_normalizer_disposed",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
    });
    expect(normalizer.latestGpuProof()).toBeNull();
  });
});

describe("parseWireMessages", () => {
  it("extracts a structured JSON object from prefixed runner text", () => {
    const parsed = parseWireMessages(
      `[Runner Stderr] ${JSON.stringify({
        type: "gpu_hmr_proof",
        module: "device",
        resultState: "gpu-hmr-symbol-bound",
      })}`
    );

    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.type).toBe("gpu_hmr_proof");
    expect(parsed[0]!.module).toBe("device");
  });

  it("does not treat plain text as a wire message", () => {
    expect(parseWireMessages("ordinary compiler output")).toEqual([]);
  });
});

describe("HmrNormalizer — data channel subscription", () => {
  it("parses incoming messages and forwards to onMessage", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(mockDC as unknown as Parameters<typeof HmrNormalizer.prototype.onMessage>[0] extends never ? never : ConstructorParameters<typeof HmrNormalizer>[0]);
    const seen: WireMessage[] = [];
    normalizer.onMessage((msg) => seen.push(msg));
    mockDC.emit(JSON.stringify({ event: "Loading", data: { preview_id: "p1", generation: 1 } }));
    mockDC.emit(JSON.stringify({ event: "Promoted", data: { preview_id: "p1", generation: 1 } }));
    expect(seen).toHaveLength(2);
    expect(seen[0]!.event).toBe("Loading");
    expect(seen[1]!.event).toBe("Promoted");
    normalizer.dispose();
  });

  it("ignores non-JSON text", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]);
    const seen: WireMessage[] = [];
    normalizer.onMessage((msg) => seen.push(msg));
    mockDC.emit("not json at all");
    expect(seen).toHaveLength(0);
    normalizer.dispose();
  });

  it("reassembles chunked structured JSON before classification", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]);
    const seen: WireMessage[] = [];
    normalizer.onMessage((msg) => seen.push(msg));
    const chunks = chunkWireMessage({
      status: "gpu-proof-state",
      module: "device",
      resultState: "gpu-hmr-full-runtime-proven",
      padding: "x".repeat(2048),
    });

    for (const chunk of chunks.slice().reverse()) {
      mockDC.emit(chunk);
    }

    expect(seen).toHaveLength(1);
    expect(seen[0]!.status).toBe("gpu-proof-state");
    expect(normalizer.latestGpuProof({ module: "device" })?.resultState).toBe(
      "gpu-hmr-full-runtime-proven"
    );
    normalizer.dispose();
  });

  it("publishes only frozen matched proof snapshots to proof listeners", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    let received: ReturnType<typeof normalizer.latestGpuProof> = null;
    normalizer.onGpuProof({ module: "device" }, (proof) => {
      received = proof;
    });
    normalizer.onMessage((message) => {
      message.resultState = "gpu-hmr-compile-proven";
      message.module = "mutated-after-ingestion";
    });

    mockDC.emit(JSON.stringify({
      status: "gpu-proof-state",
      module: "device",
      resultState: "gpu-hmr-full-runtime-proven",
    }));

    expect(received?.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(received).not.toHaveProperty("raw");
    expect(Object.isFrozen(received)).toBe(true);
    expect(normalizer.latestGpuProof({ module: "device" })).toBe(received);
    expect(normalizer.latestGpuProof({ module: "mutated-after-ingestion" })).toBeNull();
    normalizer.dispose();
  });

  it("drops malformed typed chunks instead of forwarding them as wire events", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const seen: WireMessage[] = [];
    normalizer.onMessage((msg) => seen.push(msg));
    mockDC.emit(JSON.stringify({
      type: "structured-json-chunk",
      chunkId: "malformed",
      data: "Bearer synthetic.secret.value",
    }));
    expect(seen).toEqual([]);
    normalizer.dispose();
  });

  it("rejects oversized declarations and non-canonical base64", () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const seen: WireMessage[] = [];
    normalizer.onMessage((msg) => seen.push(msg));
    const frame = JSON.parse(chunkWireMessage({ status: "applied" })[0]!) as WireMessage;
    mockDC.emit(JSON.stringify({ ...frame, byteLength: 16 * 1024 * 1024 + 1 }));
    mockDC.emit(JSON.stringify({ ...frame, data: "not/canonical===" }));
    expect(seen).toEqual([]);
    normalizer.dispose();
  });

  it("accepts an idempotent duplicate and rejects a conflicting duplicate", () => {
    const acceptedDc = dc();
    const accepted = new HmrNormalizer(
      acceptedDc as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const acceptedSeen: WireMessage[] = [];
    accepted.onMessage((msg) => acceptedSeen.push(msg));
    const acceptedChunks = chunkWireMessage({ status: "applied", padding: "x".repeat(512) }, 64);
    acceptedDc.emit(acceptedChunks[0]!);
    acceptedDc.emit(acceptedChunks[0]!);
    for (const chunk of acceptedChunks.slice(1)) acceptedDc.emit(chunk);
    expect(acceptedSeen).toHaveLength(1);
    accepted.dispose();

    const rejectedDc = dc();
    const rejected = new HmrNormalizer(
      rejectedDc as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const rejectedSeen: WireMessage[] = [];
    rejected.onMessage((msg) => rejectedSeen.push(msg));
    const rejectedChunks = chunkWireMessage({ status: "applied", padding: "y".repeat(512) }, 64);
    const conflict = JSON.parse(rejectedChunks[0]!) as WireMessage;
    const originalBytes = Buffer.from(conflict.data as string, "base64");
    originalBytes[0] = originalBytes[0] === 0x7b ? 0x5b : 0x7b;
    conflict.data = originalBytes.toString("base64");
    rejectedDc.emit(rejectedChunks[0]!);
    rejectedDc.emit(JSON.stringify(conflict));
    for (const chunk of rejectedChunks.slice(1)) rejectedDc.emit(chunk);
    expect(rejectedSeen).toEqual([]);
    rejected.dispose();
  });

  it("expires and zeroes incomplete chunk buffers without later traffic", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-07-17T00:00:00.000Z"));
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    try {
      const chunks = chunkWireMessage({ status: "applied", padding: "z".repeat(512) }, 64);
      mockDC.emit(chunks[0]!);
      const internals = normalizer as unknown as {
        structuredJsonChunks: Map<string, { chunks: Map<number, Buffer> }>;
      };
      expect(internals.structuredJsonChunks.size).toBe(1);
      const retainedPart = [...internals.structuredJsonChunks.values()][0]!.chunks.get(0)!;
      expect(retainedPart.some((byte) => byte !== 0)).toBe(true);
      vi.advanceTimersByTime(120_001);
      expect(internals.structuredJsonChunks.size).toBe(0);
      expect(retainedPart.every((byte) => byte === 0)).toBe(true);
    } finally {
      normalizer.dispose();
      vi.useRealTimers();
    }
  });
});

describe("HmrNormalizer.waitForTerminal", () => {
  it("releases its message listener when the caller aborts", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0],
    );
    const abort = new AbortController();
    const internals = normalizer as unknown as { listeners: Set<unknown> };
    const waiting = normalizer.waitForTerminal({
      timeoutMs: 10_000,
      signal: abort.signal,
    });
    expect(internals.listeners.size).toBe(1);

    abort.abort();

    await expect(waiting).resolves.toMatchObject({
      status: "timeout",
      source: "timeout",
    });
    expect(internals.listeners.size).toBe(0);
    normalizer.dispose();
  });

  it.each([
    {
      name: "candidate rollback",
      message: (canaries: ReturnType<typeof terminalDiagnosticCanaries>): WireMessage => ({
        event: "RolledBack",
        data: {
          module: canaries.module,
          preview_id: canaries.previewId,
          generation: 7,
          reason: canaries.signedUrl,
          provider: {
            authorization: canaries.bearer,
            cookie: canaries.cookie,
            resource: canaries.resourceId,
          },
        },
      }),
    },
    {
      name: "rollback notification",
      message: (canaries: ReturnType<typeof terminalDiagnosticCanaries>): WireMessage => ({
        type: "hmr-status",
        status: "rejected",
        module: canaries.module,
        preview_id: canaries.previewId,
        reason_code: canaries.resourceId,
        reason: canaries.signedUrl,
        authorization: canaries.bearer,
      }),
    },
    {
      name: "compile diagnostics",
      message: (canaries: ReturnType<typeof terminalDiagnosticCanaries>): WireMessage => ({
        type: "compile-diagnostics",
        module: canaries.module,
        preview_id: canaries.previewId,
        error_count: 1,
        diagnostics: [{
          message: canaries.signedUrl,
          resource: canaries.resourceId,
          cookie: canaries.cookie,
        }],
      }),
    },
    {
      name: "bare rejected status",
      message: (canaries: ReturnType<typeof terminalDiagnosticCanaries>): WireMessage => ({
        status: "rejected",
        module: canaries.module,
        preview_id: canaries.previewId,
        reason: canaries.signedUrl,
        error: canaries.bearer,
        cookie: canaries.cookie,
      }),
    },
  ])("projects $name into safe live and retained diagnostics", async ({ message }) => {
    const canaries = terminalDiagnosticCanaries();
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const wait = normalizer.waitForTerminal({
      timeoutMs: 1_000,
      module: canaries.module,
      previewId: canaries.previewId,
    });
    mockDC.emit(JSON.stringify(message(canaries)));

    const live = await wait;
    expectProjectedTerminalDetail(live.detail, canaries);
    expect(live.retained).not.toBe(true);

    const retainedSince = Date.now();
    mockDC.emit(JSON.stringify(message(canaries)));
    const retained = await normalizer.waitForTerminal({
      timeoutMs: 1_000,
      module: canaries.module,
      previewId: canaries.previewId,
      sinceTs: retainedSince,
    });
    expect(retained.retained).toBe(true);
    expectProjectedTerminalDetail(retained.detail, canaries);
    normalizer.dispose();
  });

  it("resolves on first terminal event", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const waitPromise = normalizer.waitForTerminal({ timeoutMs: 1_000 });
    setTimeout(() => {
      mockDC.emit(JSON.stringify({ event: "Loading", data: { preview_id: "p1", generation: 1 } }));
      mockDC.emit(
        JSON.stringify({
          event: "Promoted",
          data: { preview_id: "p1", generation: 1, total_reload_ms: 42 },
        })
      );
    }, 10);
    const result = await waitPromise;
    expect(result.status).toBe("applied");
    expect(result.source).toBe("candidate_notification");
    expect(result.elapsedMs).toBeGreaterThan(0);
    expect(result.elapsedMs).toBeLessThan(1_000);
    normalizer.dispose();
  });

  it("times out when no terminal event arrives", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const result = await normalizer.waitForTerminal({ timeoutMs: 100 });
    expect(result.status).toBe("timeout");
    expect(result.source).toBe("timeout");
    expect(result.elapsedMs).toBeGreaterThanOrEqual(100);
    normalizer.dispose();
  });

  it("dedupes: Promoted followed by bare applied within 50ms → only one resolve", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );

    const spy = vi.fn();
    const waitPromise = normalizer.waitForTerminal({ timeoutMs: 1_000 }).then(spy);

    setTimeout(() => {
      mockDC.emit(
        JSON.stringify({
          event: "Promoted",
          data: { preview_id: "p1", generation: 1, total_reload_ms: 10 },
        })
      );
      // Simulated runner stderr arriving ~30ms after adapter Promoted.
      setTimeout(() => {
        mockDC.emit(JSON.stringify({ status: "applied", module: "core", state_preserved: true }));
      }, 30);
    }, 10);

    await waitPromise;
    // Give the late-arriving bare applied time to (not) trigger a second resolve.
    await new Promise((r) => setTimeout(r, 100));
    expect(spy).toHaveBeenCalledTimes(1);
    normalizer.dispose();
  });

  it("intermediate events do not resolve", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );

    const waitPromise = normalizer.waitForTerminal({ timeoutMs: 200 });
    setTimeout(() => {
      mockDC.emit(
        JSON.stringify({ event: "Enqueued", data: { preview_id: "p1", generation: 1, artifact_hash: "h" } })
      );
      mockDC.emit(JSON.stringify({ event: "Loading", data: { preview_id: "p1", generation: 1 } }));
      mockDC.emit(
        JSON.stringify({ event: "HealthCheckStarted", data: { preview_id: "p1", generation: 1 } })
      );
      mockDC.emit(JSON.stringify({ type: "hmr-status", status: "reload-planned", decision: "warm_reload" }));
      mockDC.emit(JSON.stringify({ status: "done", success: true, stage: "adapter" }));
      mockDC.emit(JSON.stringify({ status: "host-kv-preserved" }));
      mockDC.emit(JSON.stringify({ type: "compile-diagnostics", error_count: 0, diagnostics: [] }));
    }, 10);

    const result = await waitPromise;
    expect(result.status).toBe("timeout");
    normalizer.dispose();
  });

  it("synthesizes compile-error from {type:'compile-diagnostics', error_count>0}", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const waitPromise = normalizer.waitForTerminal({ timeoutMs: 500 });
    setTimeout(() => {
      mockDC.emit(
        JSON.stringify({
          type: "compile-diagnostics",
          module: "core",
          error_count: 3,
          diagnostics: ["undefined reference"],
        })
      );
    }, 10);
    const result = await waitPromise;
    expect(result.status).toBe("compile-error");
    expect(result.source).toBe("compile_diagnostics");
    normalizer.dispose();
  });

  it("recovers a terminal event observed after a caller-provided since_ts", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const sinceTs = Date.now();
    mockDC.emit(JSON.stringify({ status: "applied", module: "device", preview_id: "p1" }));

    const result = await normalizer.waitForTerminal({
      timeoutMs: 1_000,
      module: "device",
      sinceTs,
    });

    expect(result.status).toBe("applied");
    expect(result.retained).toBe(true);
    expect(result.observedAt).toBeGreaterThanOrEqual(sinceTs);
    normalizer.dispose();
  });

  it("does not recover stale or wrong-module terminal history", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const staleSinceTs = Date.now();
    mockDC.emit(JSON.stringify({ status: "applied", module: "core", preview_id: "p1" }));
    await new Promise((r) => setTimeout(r, 5));
    const freshSinceTs = Date.now();

    const staleResult = await normalizer.waitForTerminal({
      timeoutMs: 25,
      module: "core",
      sinceTs: freshSinceTs,
    });
    expect(staleResult.status).toBe("timeout");

    const wrongModuleResult = await normalizer.waitForTerminal({
      timeoutMs: 25,
      module: "device",
      sinceTs: staleSinceTs,
    });
    expect(wrongModuleResult.status).toBe("timeout");
    normalizer.dispose();
  });

  it("does not recover stale or wrong-module GPU proof history", async () => {
    const mockDC = dc();
    const normalizer = new HmrNormalizer(
      mockDC as unknown as ConstructorParameters<typeof HmrNormalizer>[0]
    );
    const staleSinceTs = Date.now();
    mockDC.emit(JSON.stringify({
      status: "gpu-proof-state",
      module: "core",
      resultState: "gpu-hmr-full-runtime-proven",
    }));
    await new Promise((r) => setTimeout(r, 5));
    const freshSinceTs = Date.now();

    expect(normalizer.latestGpuProof({
      sinceTs: freshSinceTs,
      module: "core",
    })).toBeNull();
    expect(normalizer.latestGpuProof({
      sinceTs: staleSinceTs,
      module: "device",
    })).toBeNull();

    mockDC.emit(JSON.stringify({
      status: "gpu-proof-state",
      module: "device",
      resultState: "gpu-hmr-full-runtime-proven",
    }));

    const proof = normalizer.latestGpuProof({
      sinceTs: freshSinceTs,
      module: "device",
    });
    expect(proof?.resultState).toBe("gpu-hmr-full-runtime-proven");
    expect(proof?.moduleRef).toMatch(/^gpu-proof-module-ref:sha256:[a-f0-9]{64}$/);
    expect(proof).not.toHaveProperty("raw");
    normalizer.dispose();
  });
});
