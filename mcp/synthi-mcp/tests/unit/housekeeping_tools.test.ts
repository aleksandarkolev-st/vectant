import { beforeEach, describe, expect, it } from "vitest";
import { detachTool } from "../../src/tools/detach.js";
import { healthTool } from "../../src/tools/health.js";
import { reconnectTool } from "../../src/tools/reconnect.js";
import { getEventLogTool } from "../../src/tools/get_event_log.js";
import { getSourceStateTool } from "../../src/tools/get_source_state.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

describe("synthi_detach", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns detached:false when not attached", async () => {
    const res = await detachTool({});
    expect(res.isError).toBeUndefined();
    expect(res.structuredContent).toEqual({ ok: true, detached: false });
  });
});

describe("synthi_health", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("reports mcp_state:detached when no attach has run", async () => {
    const res = await healthTool({});
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { mcp_state: string }).mcp_state).toBe("detached");
    expect((res.structuredContent as { unsafe_mode: boolean }).unsafe_mode).toBe(false);
  });
});

describe("synthi_reconnect", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns not_attached when no prior attach", async () => {
    const res = await reconnectTool({});
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("not_attached");
  });
});

describe("synthi_get_event_log", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns empty entries when log is clean", async () => {
    const res = await getEventLogTool({});
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { count: number }).count).toBe(0);
    expect((res.structuredContent as { last_seq: number }).last_seq).toBe(0);
  });

  it("returns entries after since_seq", async () => {
    eventLog.push({ kind: "lifecycle", state: "ready" });
    eventLog.push({ kind: "lifecycle", state: "running" });
    const res = await getEventLogTool({ since_seq: 1 });
    expect(res.isError).toBeUndefined();
    const entries = (res.structuredContent as { entries: unknown[] }).entries;
    expect(entries.length).toBe(1);
  });

  it("returns lease events by kind", async () => {
    eventLog.push({ kind: "lease", action: "queued", owner: "agent", payload: { request_id: "req_1" } });
    const res = await getEventLogTool({ kind: "lease" });
    expect(res.isError).toBeUndefined();
    const entries = (res.structuredContent as { entries: Array<{ kind: string }> }).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]?.kind).toBe("lease");
  });

  it("rejects invalid kind", async () => {
    const res = await getEventLogTool({ kind: "totally_not_a_kind" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string; field?: string }).field).toBe("kind");
  });

  it("rejects negative since_seq", async () => {
    const res = await getEventLogTool({ since_seq: -1 });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string }).field).toBe("since_seq");
  });

  it("rejects non-integer limit", async () => {
    const res = await getEventLogTool({ limit: 1.5 });
    expect(res.isError).toBe(true);
  });
});

describe("synthi_get_source_state", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns not_attached when detached", async () => {
    const res = await getSourceStateTool({});
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("not_attached");
  });
});
