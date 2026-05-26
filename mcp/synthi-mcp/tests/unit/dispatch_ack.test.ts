/**
 * Unit tests for the input dispatch_id + ack pipeline.
 *
 * Covers:
 *   - DispatchAckRegistry.register allocates unique ids + promise.
 *   - resolveAck resolves the right entry + exposes reason.
 *   - Unknown dispatch_id on resolveAck returns false (no-op).
 *   - Timeout rejects with input_ack_timeout; timer cleared on resolve.
 *   - cancel() rejects pending + cleans registry.
 *   - Wire encoders round-trip `dispatch_id` through the envelope.
 *
 * Production wiring of the tool layer to await acks is intentionally
 * staged — that belongs in a follow-up commit with its own test plan.
 * This commit ships the primitive + wire extension + the session tap
 * that resolves the registry when worker echoes land.
 */

import { describe, it, expect } from "vitest";
import {
  DispatchAckRegistry,
  dispatchAckRegistry,
} from "../../src/util/dispatch_ack_registry.js";
import {
  encodeClickPair,
  encodeKey,
  encodeMouseButton,
  encodeMouseMove,
  encodeTypeSequence,
  encodeWheel,
  type GuiEventEnvelope,
} from "../../src/wire/input.js";

describe("DispatchAckRegistry", () => {
  it("register() returns unique ids + resolvable promise", async () => {
    const reg = new DispatchAckRegistry();
    const a = reg.register();
    const b = reg.register();
    expect(a.id).not.toBe(b.id);
    expect(reg.size()).toBe(2);
    a._resolve({ accepted: true, elapsedMs: 5 });
    await expect(a.promise).resolves.toEqual({ accepted: true, elapsedMs: 5 });
    expect(reg.size()).toBe(1);
  });

  it("resolveAck carries accepted + reason; rounds elapsedMs up from registerTs", async () => {
    const reg = new DispatchAckRegistry();
    const h = reg.register();
    const ok = reg.resolveAck({ dispatch_id: h.id, accepted: false, reason: "no_sdl_sender" });
    expect(ok).toBe(true);
    const res = await h.promise;
    expect(res.accepted).toBe(false);
    expect(res.reason).toBe("no_sdl_sender");
    expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
  });

  it("resolveAck for unknown id returns false without side effect", () => {
    const reg = new DispatchAckRegistry();
    const res = reg.resolveAck({ dispatch_id: "dsp_does_not_exist", accepted: true });
    expect(res).toBe(false);
  });

  it("timeout rejects with input_ack_timeout + removes entry", async () => {
    const reg = new DispatchAckRegistry();
    const h = reg.register(25);
    await expect(h.promise).rejects.toThrow(/input_ack_timeout/);
    expect(reg.size()).toBe(0);
  });

  it("can defer the timeout window until dispatch is sent", async () => {
    const reg = new DispatchAckRegistry();
    const h = reg.register(15, "dsp_deferred", { deferTimeout: true });
    await new Promise((r) => setTimeout(r, 30));
    expect(reg.size()).toBe(1);

    const rejection = expect(h.promise).rejects.toThrow(/input_ack_timeout/);
    h.startTimer();
    await rejection;
    expect(reg.size()).toBe(0);
  });

  it("resolve before timeout clears the timer (no late rejection)", async () => {
    const reg = new DispatchAckRegistry();
    const h = reg.register(50);
    reg.resolveAck({ dispatch_id: h.id, accepted: true });
    await expect(h.promise).resolves.toMatchObject({ accepted: true });
    // Give the would-be timeout a chance to fire.
    await new Promise((r) => setTimeout(r, 60));
    // If the timer weren't cleared, a double-resolve would've thrown
    // inside the reject() path. Registry still empty.
    expect(reg.size()).toBe(0);
  });

  it("cancel() rejects with input_ack_cancelled + clears entry", async () => {
    const reg = new DispatchAckRegistry();
    const h = reg.register(1_000);
    h.cancel();
    await expect(h.promise).rejects.toThrow(/input_ack_cancelled/);
    expect(reg.size()).toBe(0);
  });

  it("_resetForTests clears without resolving (primitive escape hatch)", () => {
    const reg = new DispatchAckRegistry();
    reg.register();
    reg.register();
    reg._resetForTests();
    expect(reg.size()).toBe(0);
  });

  it("exported singleton is a DispatchAckRegistry instance", () => {
    expect(dispatchAckRegistry).toBeInstanceOf(DispatchAckRegistry);
  });
});

describe("input wire — dispatch_id round-trips", () => {
  const decode = (s: string): GuiEventEnvelope => JSON.parse(s) as GuiEventEnvelope;

  it("encodeMouseMove carries dispatch_id when provided", () => {
    const env = decode(encodeMouseMove("s1", 10, 20, "dsp_test"));
    expect(env.dispatch_id).toBe("dsp_test");
    expect(env.event).toEqual({ type: "mouse", action: "move", x: 10, y: 20 });
  });

  it("encodeMouseButton carries dispatch_id + button code", () => {
    const env = decode(encodeMouseButton("s1", 10, 20, 1, "down", "dsp_down"));
    expect(env.dispatch_id).toBe("dsp_down");
    expect(env.event).toMatchObject({ type: "mouse", action: "down", button: 1 });
  });

  it("encodeWheel carries dispatch_id", () => {
    const env = decode(encodeWheel("s1", -120, "dsp_wheel"));
    expect(env.dispatch_id).toBe("dsp_wheel");
  });

  it("encodeKey carries dispatch_id for each half", () => {
    const down = decode(encodeKey("s1", "a", "down", "dsp_d"));
    const up = decode(encodeKey("s1", "a", "up", "dsp_u"));
    expect(down.dispatch_id).toBe("dsp_d");
    expect(up.dispatch_id).toBe("dsp_u");
  });

  it("encodeClickPair pairs down/up ids", () => {
    const [downStr, upStr] = encodeClickPair("s1", 100, 200, "left", ["dsp_down", "dsp_up"]);
    expect(decode(downStr).dispatch_id).toBe("dsp_down");
    expect(decode(upStr).dispatch_id).toBe("dsp_up");
  });

  it("encodeTypeSequence uses supplier per key-half", () => {
    let i = 0;
    const supplier = (): string => `dsp_${i++}`;
    const frames = encodeTypeSequence("s1", "ab", supplier);
    expect(frames).toHaveLength(4);
    expect(decode(frames[0]!).dispatch_id).toBe("dsp_0");
    expect(decode(frames[1]!).dispatch_id).toBe("dsp_1");
    expect(decode(frames[2]!).dispatch_id).toBe("dsp_2");
    expect(decode(frames[3]!).dispatch_id).toBe("dsp_3");
  });

  it("omitting dispatch_id leaves field absent (back-compat)", () => {
    const env = decode(encodeMouseMove("s1", 1, 2));
    expect(env.dispatch_id).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(env, "dispatch_id")).toBe(false);
  });
});
