import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { clickTool } from "../../src/tools/click.js";
import { typeTool } from "../../src/tools/type.js";
import { acquireInputTool } from "../../src/tools/acquire_input.js";
import { releaseInputTool } from "../../src/tools/release_input.js";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

function installFakeAttached(): { sent: string[] } {
  const sent: string[] = [];
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600 },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(10), width: 800, height: 600, ts: Date.now(), seq: 1 }),
      hasFrame: () => true,
      dimensions: () => ({ width: 800, height: 600 }),
    },
    channels: {
      sendInput: async (frames: string[]) => {
        for (const frame of frames) sent.push(frame);
      },
    },
  };
  return { sent };
}

describe("legacy input wrappers", () => {
  const prevLeaseMode = process.env["SYNTHI_LEASE_MODE"];

  beforeEach(() => {
    session._resetForTests();
    leaseRegistry._resetForTests();
    eventLog._resetForTests();
    if (prevLeaseMode === undefined) delete process.env["SYNTHI_LEASE_MODE"];
    else process.env["SYNTHI_LEASE_MODE"] = prevLeaseMode;
  });

  afterEach(() => {
    if (prevLeaseMode === undefined) delete process.env["SYNTHI_LEASE_MODE"];
    else process.env["SYNTHI_LEASE_MODE"] = prevLeaseMode;
  });

  it("synthi_click honors the disruption gate", async () => {
    installFakeAttached();
    session.setWireState("running");
    session.markDisruption("full-reload-required", {});

    const res = await clickTool({ x: 10, y: 10 });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("input_rejected_awaiting_ack");
  });

  it("synthi_type honors the disruption gate", async () => {
    installFakeAttached();
    session.setWireState("running");
    session.markDisruption("full-reload-required", {});

    const res = await typeTool({ text: "hello" });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("input_rejected_awaiting_ack");
  });

  it("synthi_click honors single-holder lease enforcement", async () => {
    process.env["SYNTHI_LEASE_MODE"] = "single-holder";
    installFakeAttached();
    session.setWireState("running");
    const acquire = await acquireInputTool({ lease_ms: 5_000, owner: "agent_a" });
    const leaseId = (acquire.structuredContent as { lease_id: string }).lease_id;

    const blocked = await clickTool({ x: 10, y: 10 });
    const allowed = await clickTool({ x: 10, y: 10, button: "left", lease_id: leaseId });

    expect(blocked.isError).toBe(true);
    expect((blocked.structuredContent as { error: string }).error).toBe("input_lease_held_by_other");
    expect(allowed.isError).toBeUndefined();
  });

  it("synthi_type honors single-holder lease enforcement", async () => {
    process.env["SYNTHI_LEASE_MODE"] = "single-holder";
    installFakeAttached();
    session.setWireState("running");
    const acquire = await acquireInputTool({ lease_ms: 5_000, owner: "agent_a" });
    const leaseId = (acquire.structuredContent as { lease_id: string }).lease_id;

    const blocked = await typeTool({ text: "hello" });
    const allowed = await typeTool({ text: "hello", lease_id: leaseId });

    expect(blocked.isError).toBe(true);
    expect((blocked.structuredContent as { error: string }).error).toBe("input_lease_held_by_other");
    expect(allowed.isError).toBeUndefined();
  });

  it("synthi_release_input reports mcp-local enforcement in single-holder mode", async () => {
    process.env["SYNTHI_LEASE_MODE"] = "single-holder";
    installFakeAttached();
    session.setWireState("running");
    const acquire = await acquireInputTool({ lease_ms: 5_000, owner: "agent_a" });
    const leaseId = (acquire.structuredContent as { lease_id: string }).lease_id;

    const release = await releaseInputTool({ lease_id: leaseId });

    expect(release.isError).toBeUndefined();
    expect((release.structuredContent as { enforcement: string }).enforcement).toBe("mcp-local");
  });
});
