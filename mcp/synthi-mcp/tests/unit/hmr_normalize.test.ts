import { describe, expect, it, vi } from "vitest";
import {
  classifyHmrMessage,
  HmrNormalizer,
  type WireMessage,
} from "../../src/hmr.js";

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

describe("classifyHmrMessage (pure)", () => {
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
});

describe("HmrNormalizer.waitForTerminal", () => {
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
});
