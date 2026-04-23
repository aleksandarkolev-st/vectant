import { describe, expect, it } from "vitest";
import { EventLog } from "../../src/events/log.js";

describe("EventLog", () => {
  it("assigns monotonic seq on push", () => {
    const log = new EventLog();
    const a = log.push({ kind: "lifecycle", state: "ready" });
    const b = log.push({ kind: "lifecycle", state: "running" });
    expect(a.seq).toBe(1);
    expect(b.seq).toBe(2);
    expect(b.ts).toBeGreaterThanOrEqual(a.ts);
    expect(log.lastSeq()).toBe(2);
  });

  it("evicts oldest entries when capacity exceeded", () => {
    const log = new EventLog(3);
    log.push({ kind: "lifecycle", state: "ready" });
    log.push({ kind: "lifecycle", state: "running" });
    log.push({ kind: "lifecycle", state: "crashed" });
    log.push({ kind: "lifecycle", state: "terminated" });
    const all = log.query();
    expect(all.length).toBe(3);
    expect((all[0] as { state: string }).state).toBe("running");
    expect((all[2] as { state: string }).state).toBe("terminated");
  });

  it("query filters by kind", () => {
    const log = new EventLog();
    log.push({ kind: "lifecycle", state: "ready" });
    log.push({
      kind: "hmr",
      status: "applied",
      source: "candidate_notification",
    });
    log.push({
      kind: "input",
      action: "click",
      payload: { x: 0, y: 0 },
    });
    expect(log.query({ kind: "hmr" }).length).toBe(1);
    expect(log.query({ kind: ["hmr", "lifecycle"] }).length).toBe(2);
  });

  it("query filters by since_seq", () => {
    const log = new EventLog();
    const a = log.push({ kind: "lifecycle", state: "ready" });
    log.push({ kind: "lifecycle", state: "running" });
    log.push({ kind: "lifecycle", state: "terminated" });
    expect(log.query({ since_seq: a.seq }).length).toBe(2);
  });

  it("query filters by since_ts", () => {
    const log = new EventLog();
    log.push({ kind: "lifecycle", state: "ready", ts: 1000 });
    log.push({ kind: "lifecycle", state: "running", ts: 2000 });
    log.push({ kind: "lifecycle", state: "terminated", ts: 3000 });
    expect(log.query({ since_ts: 2000 }).length).toBe(2);
  });

  it("query respects limit", () => {
    const log = new EventLog();
    for (let i = 0; i < 10; i++) log.push({ kind: "lifecycle", state: "ready" });
    expect(log.query({ limit: 3 }).length).toBe(3);
  });

  it("onAppend fires for new entries after subscribe", () => {
    const log = new EventLog();
    log.push({ kind: "lifecycle", state: "ready" });
    const seen: unknown[] = [];
    const unsub = log.onAppend((e) => seen.push(e));
    log.push({ kind: "lifecycle", state: "running" });
    log.push({ kind: "lifecycle", state: "terminated" });
    unsub();
    log.push({ kind: "lifecycle", state: "crashed" });
    expect(seen.length).toBe(2);
  });

  it("clear() drops entries but keeps seq monotonic", () => {
    const log = new EventLog();
    log.push({ kind: "lifecycle", state: "ready" });
    log.push({ kind: "lifecycle", state: "running" });
    log.clear();
    expect(log.size()).toBe(0);
    const next = log.push({ kind: "lifecycle", state: "ready" });
    expect(next.seq).toBe(3);
  });

  it("rejects invalid capacity", () => {
    expect(() => new EventLog(0)).toThrow(/invalid_capacity/);
    expect(() => new EventLog(-1)).toThrow(/invalid_capacity/);
    expect(() => new EventLog(NaN)).toThrow(/invalid_capacity/);
  });
});
