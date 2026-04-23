import { beforeEach, describe, expect, it } from "vitest";
import { mouseTool } from "../../src/tools/mouse.js";
import { keyboardTool } from "../../src/tools/keyboard.js";
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
        for (const f of frames) sent.push(f);
      },
    },
  };
  return { sent };
}

describe("synthi_mouse", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("rejects unknown action", async () => {
    installFakeAttached();
    const res = await mouseTool({ action: "bogus", x: 10, y: 10 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string }).field).toBe("action");
  });

  it("click sends two frames (down+up)", async () => {
    const { sent } = installFakeAttached();
    const res = await mouseTool({ action: "click", x: 100, y: 50 });
    expect(res.isError).toBeUndefined();
    expect(sent.length).toBe(2);
    const down = JSON.parse(sent[0]!);
    const up = JSON.parse(sent[1]!);
    expect(down.event.action).toBe("down");
    expect(up.event.action).toBe("up");
  });

  it("double_click sends four frames", async () => {
    const { sent } = installFakeAttached();
    await mouseTool({ action: "double_click", x: 10, y: 10 });
    expect(sent.length).toBe(4);
  });

  it("drag sends down → move → up", async () => {
    const { sent } = installFakeAttached();
    await mouseTool({ action: "drag", x: 10, y: 10, toX: 100, toY: 200 });
    expect(sent.length).toBe(3);
    expect(JSON.parse(sent[0]!).event.action).toBe("down");
    expect(JSON.parse(sent[1]!).event.action).toBe("move");
    expect(JSON.parse(sent[2]!).event.action).toBe("up");
  });

  it("wheel sends one frame with deltaY", async () => {
    const { sent } = installFakeAttached();
    await mouseTool({ action: "wheel", deltaY: 120 });
    expect(sent.length).toBe(1);
    const parsed = JSON.parse(sent[0]!);
    expect(parsed.event.action).toBe("wheel");
    expect(parsed.event.deltaY).toBe(120);
  });

  it("click out-of-bounds returns click_out_of_bounds", async () => {
    installFakeAttached();
    const res = await mouseTool({ action: "click", x: 5000, y: 5000 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("click_out_of_bounds");
  });

  it("emits one input event per action", async () => {
    installFakeAttached();
    await mouseTool({ action: "click", x: 10, y: 10 });
    const events = eventLog.query({ kind: "input" });
    expect(events.length).toBe(1);
    expect((events[0] as { action: string }).action).toBe("mouse:click");
  });
});

describe("synthi_keyboard", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("rejects unknown action", async () => {
    installFakeAttached();
    const res = await keyboardTool({ action: "nope" });
    expect(res.isError).toBe(true);
  });

  it("type sends 2 frames per character", async () => {
    const { sent } = installFakeAttached();
    await keyboardTool({ action: "type", text: "abc" });
    expect(sent.length).toBe(6);
  });

  it("type with empty string sends zero frames", async () => {
    const { sent } = installFakeAttached();
    const res = await keyboardTool({ action: "type", text: "" });
    expect(res.isError).toBeUndefined();
    expect(sent.length).toBe(0);
    expect((res.structuredContent as { charsSent: number }).charsSent).toBe(0);
  });

  it("key sends down + up", async () => {
    const { sent } = installFakeAttached();
    await keyboardTool({ action: "key", key: "Enter" });
    expect(sent.length).toBe(2);
    expect(JSON.parse(sent[0]!).event.key).toBe("Enter");
    expect(JSON.parse(sent[0]!).event.action).toBe("down");
    expect(JSON.parse(sent[1]!).event.action).toBe("up");
  });

  it("chord presses keys in order, releases in reverse", async () => {
    const { sent } = installFakeAttached();
    await keyboardTool({ action: "chord", keys: ["Control", "c"] });
    expect(sent.length).toBe(4);
    const parsed = sent.map((s) => JSON.parse(s));
    expect(parsed[0].event.key).toBe("Control");
    expect(parsed[0].event.action).toBe("down");
    expect(parsed[1].event.key).toBe("c");
    expect(parsed[1].event.action).toBe("down");
    expect(parsed[2].event.key).toBe("c");
    expect(parsed[2].event.action).toBe("up");
    expect(parsed[3].event.key).toBe("Control");
    expect(parsed[3].event.action).toBe("up");
  });

  it("rejects chord with non-string entries", async () => {
    installFakeAttached();
    const res = await keyboardTool({ action: "chord", keys: ["Control", 123] });
    expect(res.isError).toBe(true);
  });

  it("emits one input event per action", async () => {
    installFakeAttached();
    await keyboardTool({ action: "key", key: "Tab" });
    const events = eventLog.query({ kind: "input" });
    expect(events.length).toBe(1);
    expect((events[0] as { action: string }).action).toBe("keyboard:key");
  });
});
