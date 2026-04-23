/**
 * Presence counting — MCP side.
 *
 * Covers the getter/setter on SessionManager + the clamping done on
 * incoming values from the signaling-server. The signaling-server's
 * own unit tests in Rust cover the compute/broadcast logic; here we
 * cover what the MCP does with the values once they arrive.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { session } from "../../src/session.js";

describe("SessionManager — presence counts", () => {
  beforeEach(() => {
    session._resetForTests();
  });

  it("defaults to {humans:0, agents:1} until presence arrives", () => {
    const p = session.getPresenceCounts();
    expect(p).toEqual({ humans: 0, agents: 1 });
  });

  it("setPresenceCounts replaces values", () => {
    session.setPresenceCounts({ humans: 1, agents: 2 });
    expect(session.getPresenceCounts()).toEqual({ humans: 1, agents: 2 });
  });

  it("clamps negative values to zero (defensive — server should never send this)", () => {
    session.setPresenceCounts({ humans: -1, agents: -5 });
    expect(session.getPresenceCounts()).toEqual({ humans: 0, agents: 0 });
  });

  it("floors fractional values (defensive — JSON is lenient)", () => {
    session.setPresenceCounts({ humans: 1.7, agents: 2.9 });
    expect(session.getPresenceCounts()).toEqual({ humans: 1, agents: 2 });
  });

  it("getPresenceCounts returns a copy (mutation-safe)", () => {
    const a = session.getPresenceCounts();
    a.humans = 999;
    const b = session.getPresenceCounts();
    expect(b.humans).toBe(0);
  });
});
