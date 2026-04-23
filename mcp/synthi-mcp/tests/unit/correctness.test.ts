import { beforeEach, describe, expect, it } from "vitest";
import { buildError, ERROR_PRIORITY, pickHighestPriority } from "../../src/correctness/errors.js";
import { checkInputGate } from "../../src/correctness/input_gate.js";
import { mouseTool } from "../../src/tools/mouse.js";
import { keyboardTool } from "../../src/tools/keyboard.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

function installFakeAttached(): void {
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fake",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600 },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 800, height: 600, ts: Date.now(), seq: 1 }),
      dimensions: () => ({ width: 800, height: 600 }),
    },
    channels: {
      sendInput: async () => {},
    },
  };
}

describe("buildError", () => {
  it("includes priority and required_tool_call for unsafe_signaling", () => {
    const e = buildError("unsafe_signaling");
    expect(e.error).toBe("unsafe_signaling");
    expect(e.priority).toBe(1);
    expect(e.required_tool_call).toBeDefined();
  });

  it("unknown codes fall through with priority 99", () => {
    const e = buildError("never_heard_of_it");
    expect(e.error).toBe("never_heard_of_it");
    expect(e.priority).toBe(99);
  });
});

describe("pickHighestPriority", () => {
  it("returns null on empty list", () => {
    expect(pickHighestPriority([])).toBeNull();
  });

  it("returns lowest priority number (most actionable)", () => {
    expect(pickHighestPriority(["frame_stale", "unsafe_signaling"])).toBe("unsafe_signaling");
    expect(pickHighestPriority(["click_out_of_bounds", "session_not_ready"])).toBe("session_not_ready");
    expect(pickHighestPriority(["session_migrating", "input_rejected_awaiting_ack"])).toBe("session_migrating");
  });
});

describe("checkInputGate", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns session_terminated when not attached", () => {
    const e = checkInputGate();
    expect(e?.error).toBe("session_terminated");
  });

  it("passes when attached and state=running", () => {
    installFakeAttached();
    session.setWireState("running");
    expect(checkInputGate()).toBeNull();
  });

  it("returns session_not_ready when state=warming", () => {
    installFakeAttached();
    session.setWireState("warming");
    expect(checkInputGate()?.error).toBe("session_not_ready");
  });

  it("returns session_migrating when state=migrating", () => {
    installFakeAttached();
    session.setWireState("migrating");
    expect(checkInputGate()?.error).toBe("session_migrating");
  });

  it("returns input_rejected_awaiting_ack when disruption is pending", () => {
    installFakeAttached();
    session.setWireState("running");
    session.markDisruption("crash-recovered", { pid: 5 });
    const e = checkInputGate();
    expect(e?.error).toBe("input_rejected_awaiting_ack");
    expect((e as unknown as { pending_disruption: string }).pending_disruption).toBe("crash-recovered");
  });

  it("priority ladder — migrating wins over awaiting_ack", () => {
    installFakeAttached();
    session.setWireState("migrating");
    session.markDisruption("crash-recovered", {});
    expect(checkInputGate()?.error).toBe("session_migrating");
  });
});

describe("input tools honor the correctness gate", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("synthi_mouse blocks on session_not_ready", async () => {
    installFakeAttached();
    session.setWireState("warming");
    const res = await mouseTool({ action: "click", x: 10, y: 10 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("session_not_ready");
  });

  it("synthi_keyboard blocks on input_rejected_awaiting_ack", async () => {
    installFakeAttached();
    session.setWireState("running");
    session.markDisruption("full-reload-required", {});
    const res = await keyboardTool({ action: "type", text: "hello" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("input_rejected_awaiting_ack");
  });

  it("synthi_mouse resumes after acknowledge_disruption", async () => {
    installFakeAttached();
    session.setWireState("running");
    session.markDisruption("crash-recovered", {});
    const blocked = await mouseTool({ action: "click", x: 10, y: 10 });
    expect(blocked.isError).toBe(true);
    session.clearDisruption();
    const allowed = await mouseTool({ action: "click", x: 10, y: 10 });
    expect(allowed.isError).toBeUndefined();
  });
});

describe("ERROR_PRIORITY map is monotone", () => {
  it("every spec has a numeric priority", () => {
    for (const [code, prio] of Object.entries(ERROR_PRIORITY)) {
      expect(typeof prio).toBe("number");
      expect(prio).toBeGreaterThan(0);
      expect(code.length).toBeGreaterThan(0);
    }
  });

  it("unsafe_signaling is the highest priority (lowest number)", () => {
    const unsafe = ERROR_PRIORITY["unsafe_signaling"]!;
    for (const [code, prio] of Object.entries(ERROR_PRIORITY)) {
      if (code === "unsafe_signaling") continue;
      expect(prio).toBeGreaterThanOrEqual(unsafe);
    }
  });
});
