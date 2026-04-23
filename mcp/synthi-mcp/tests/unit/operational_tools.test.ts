import { beforeEach, describe, expect, it } from "vitest";
import { getUsageTool } from "../../src/tools/get_usage.js";
import { setQualityTool } from "../../src/tools/set_quality.js";
import { checkpointTool } from "../../src/tools/checkpoint.js";
import { acknowledgeDisruptionTool } from "../../src/tools/acknowledge_disruption.js";
import { getCrashInfoTool } from "../../src/tools/get_crash_info.js";
import { resetGuestTool } from "../../src/tools/reset_guest.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

function installFakeAttached(): void {
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600 },
  };
}

describe("synthi_get_usage", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns zero counters when no events emitted", async () => {
    const res = await getUsageTool({});
    const body = res.structuredContent as { counters: Record<string, number>; vision_cost_usd_estimate: number };
    expect(body.counters.tool_call).toBe(0);
    expect(body.counters.screenshot).toBe(0);
    expect(body.vision_cost_usd_estimate).toBe(0);
  });

  it("aggregates usage events", async () => {
    eventLog.push({ kind: "usage", metric: "screenshot", value: 1 });
    eventLog.push({ kind: "usage", metric: "screenshot", value: 1 });
    eventLog.push({ kind: "usage", metric: "tool_call", value: 1 });
    eventLog.push({
      kind: "usage",
      metric: "vision_inference",
      value: 1,
      detail: { cost_usd: 0.0042 },
    });
    const res = await getUsageTool({});
    const body = res.structuredContent as { counters: Record<string, number>; vision_cost_usd_estimate: number };
    expect(body.counters.screenshot).toBe(2);
    expect(body.counters.tool_call).toBe(1);
    expect(body.counters.vision_inference).toBe(1);
    expect(body.vision_cost_usd_estimate).toBeCloseTo(0.0042);
  });
});

describe("synthi_set_quality", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
    installFakeAttached();
  });

  it("validates target_fps positive", async () => {
    const res = await setQualityTool({ target_fps: 0 });
    expect(res.isError).toBe(true);
  });

  it("returns applied:false with a note", async () => {
    const res = await setQualityTool({ target_fps: 30 });
    const body = res.structuredContent as { applied: boolean; note: string };
    expect(body.applied).toBe(false);
    expect(body.note).toContain("phase 2");
  });
});

describe("synthi_checkpoint", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("requires label", async () => {
    const res = await checkpointTool({});
    expect(res.isError).toBe(true);
  });

  it("writes console event and returns seq+ts", async () => {
    const res = await checkpointTool({ label: "mid_edit" });
    const body = res.structuredContent as { seq: number; ts: number };
    expect(body.seq).toBeGreaterThan(0);
    expect(body.ts).toBeGreaterThan(0);
    const events = eventLog.query({ kind: "console" });
    expect(events.length).toBe(1);
    expect((events[0] as { message: string }).message).toContain("mid_edit");
  });
});

describe("synthi_acknowledge_disruption", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns cleared:none when nothing is pending", async () => {
    const res = await acknowledgeDisruptionTool({});
    expect((res.structuredContent as { cleared: string }).cleared).toBe("none");
  });

  it("clears a pending disruption", async () => {
    session.markDisruption("crash-recovered", { pid: 1234 });
    const res = await acknowledgeDisruptionTool({});
    expect((res.structuredContent as { cleared: string }).cleared).toBe("crash-recovered");
    expect(session.disruptionPending()).toBeNull();
  });
});

describe("synthi_get_crash_info", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns null when no crash recorded", async () => {
    const res = await getCrashInfoTool({});
    expect((res.structuredContent as { crash_info: unknown }).crash_info).toBeNull();
    expect((res.structuredContent as { pending_disruption: unknown }).pending_disruption).toBeNull();
  });

  it("returns crash info after markDisruption", async () => {
    session.markDisruption("full-reload-required", { reason: "schema_mismatch" });
    const res = await getCrashInfoTool({});
    const body = res.structuredContent as { crash_info: Record<string, unknown>; pending_disruption: string };
    expect(body.pending_disruption).toBe("full-reload-required");
    expect(body.crash_info!.reason).toBe("schema_mismatch");
  });
});

describe("synthi_reset_guest", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("requires attach", async () => {
    const res = await resetGuestTool({});
    expect(res.isError).toBe(true);
  });

  it("records intent when attached", async () => {
    installFakeAttached();
    const res = await resetGuestTool({});
    const body = res.structuredContent as { applied: boolean };
    expect(body.applied).toBe(false);
    const events = eventLog.query({ kind: "lifecycle" });
    expect(events.some((e) => {
      const d = (e as { detail?: Record<string, unknown> }).detail;
      return d && d["event"] === "reset_guest_requested";
    })).toBe(true);
  });
});
