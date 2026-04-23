import { describe, expect, it } from "vitest";
import {
  buttonNameToCode,
  encodeClickPair,
  encodeKey,
  encodeMouseButton,
  encodeMouseMove,
  encodeTypeSequence,
  encodeWheel,
} from "../../src/wire/input.js";

describe("wire/input — gui-event envelope", () => {
  const sessionId = "sess-abc-123";

  describe("buttonNameToCode", () => {
    it("maps left → 1", () => expect(buttonNameToCode("left")).toBe(1));
    it("maps middle → 2", () => expect(buttonNameToCode("middle")).toBe(2));
    it("maps right → 3", () => expect(buttonNameToCode("right")).toBe(3));
    it("defaults to 1 when undefined", () => expect(buttonNameToCode(undefined)).toBe(1));
  });

  it("encodeMouseMove produces {type,sessionId,event:{type:'mouse',action:'move',x,y}}", () => {
    const json = encodeMouseMove(sessionId, 100, 200);
    const parsed = JSON.parse(json) as Record<string, unknown>;
    expect(parsed).toEqual({
      type: "gui-event",
      sessionId,
      event: { type: "mouse", action: "move", x: 100, y: 200 },
    });
  });

  it("encodeMouseButton emits an integer button code inside the event", () => {
    const json = encodeMouseButton(sessionId, 50, 60, 1, "down");
    expect(JSON.parse(json)).toEqual({
      type: "gui-event",
      sessionId,
      event: { type: "mouse", action: "down", x: 50, y: 60, button: 1 },
    });
  });

  it("encodeWheel carries deltaY without x/y/button", () => {
    expect(JSON.parse(encodeWheel(sessionId, -120))).toEqual({
      type: "gui-event",
      sessionId,
      event: { type: "mouse", action: "wheel", deltaY: -120 },
    });
  });

  it("encodeKey produces the expected JS-ev.key event", () => {
    const json = encodeKey(sessionId, "Enter", "down");
    expect(JSON.parse(json)).toEqual({
      type: "gui-event",
      sessionId,
      event: { type: "key", action: "down", key: "Enter" },
    });
  });

  describe("encodeClickPair", () => {
    it("defaults to left-button (code 1) and emits down then up", () => {
      const [down, up] = encodeClickPair(sessionId, 10, 20);
      const d = JSON.parse(down) as { event: { action: string; button: number } };
      const u = JSON.parse(up) as { event: { action: string; button: number } };
      expect(d.event.action).toBe("down");
      expect(d.event.button).toBe(1);
      expect(u.event.action).toBe("up");
      expect(u.event.button).toBe(1);
    });

    it("maps 'right' to button code 3", () => {
      const [down] = encodeClickPair(sessionId, 0, 0, "right");
      const d = JSON.parse(down) as { event: { button: number } };
      expect(d.event.button).toBe(3);
    });

    it("maps 'middle' to button code 2", () => {
      const [down] = encodeClickPair(sessionId, 0, 0, "middle");
      const d = JSON.parse(down) as { event: { button: number } };
      expect(d.event.button).toBe(2);
    });

    it("both frames carry the same sessionId, x, y, and button", () => {
      const [down, up] = encodeClickPair(sessionId, 400, 500, "left");
      const d = JSON.parse(down) as { sessionId: string; event: Record<string, unknown> };
      const u = JSON.parse(up) as { sessionId: string; event: Record<string, unknown> };
      expect(d.sessionId).toBe(sessionId);
      expect(u.sessionId).toBe(sessionId);
      expect(d.event.x).toBe(400);
      expect(d.event.y).toBe(500);
      expect(u.event.x).toBe(400);
      expect(u.event.y).toBe(500);
      expect(d.event.button).toBe(u.event.button);
    });
  });

  describe("encodeTypeSequence", () => {
    it("emits two frames per character (down, up)", () => {
      const frames = encodeTypeSequence(sessionId, "ab");
      expect(frames).toHaveLength(4);
      const parsed = frames.map((f) => JSON.parse(f) as { event: { action: string; key: string } });
      expect(parsed[0]!.event).toEqual({ type: "key", action: "down", key: "a" });
      expect(parsed[1]!.event).toEqual({ type: "key", action: "up", key: "a" });
      expect(parsed[2]!.event).toEqual({ type: "key", action: "down", key: "b" });
      expect(parsed[3]!.event).toEqual({ type: "key", action: "up", key: "b" });
    });

    it("handles empty strings", () => {
      expect(encodeTypeSequence(sessionId, "")).toEqual([]);
    });

    it("uses ev.key convention for single characters (Enter stays 'Enter', space stays ' ')", () => {
      const frames = encodeTypeSequence(sessionId, " ");
      const first = JSON.parse(frames[0]!) as { event: { key: string } };
      expect(first.event.key).toBe(" ");
    });
  });

  describe("envelope shape invariants", () => {
    it("always nests the inner event under event.", () => {
      // This is the critical F1 invariant: the MVP's flat {type:'mouse',...}
      // shape would be silently dropped by the worker (main.rs:1690).
      const json = encodeMouseMove(sessionId, 0, 0);
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(parsed.type).toBe("gui-event");
      expect(parsed).toHaveProperty("sessionId");
      expect(parsed).toHaveProperty("event");
      expect(typeof parsed.event).toBe("object");
    });

    it("does not include any unexpected top-level keys", () => {
      const json = encodeMouseButton(sessionId, 1, 2, 1, "down");
      const parsed = JSON.parse(json) as Record<string, unknown>;
      expect(Object.keys(parsed).sort()).toEqual(["event", "sessionId", "type"]);
    });
  });
});
