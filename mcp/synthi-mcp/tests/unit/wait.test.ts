import { beforeEach, describe, expect, it } from "vitest";
import { waitTool } from "../../src/tools/wait.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

describe("synthi_wait", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("rejects unknown condition", async () => {
    const res = await waitTool({ condition: "not_a_real_condition" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string }).field).toBe("condition");
  });

  it("rejects non-positive timeout", async () => {
    const res = await waitTool({ condition: "log", pattern: "x", timeoutMs: -5 });
    expect(res.isError).toBe(true);
  });

  it("condition:log resolves on matching event", async () => {
    const matching = "test_marker_42";
    setTimeout(() => {
      eventLog.push({ kind: "console", level: "info", message: matching, source: "mcp_internal" });
    }, 30);
    const res = await waitTool({ condition: "log", pattern: matching, timeoutMs: 500 });
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { status: string }).status).toBe("resolved");
    expect((res.structuredContent as { condition: string }).condition).toBe("log");
  });

  it("condition:log returns timeout when no match", async () => {
    const res = await waitTool({ condition: "log", pattern: "definitely_never_appears", timeoutMs: 80 });
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { status: string }).status).toBe("timeout");
  });

  it("condition:source_state resolves when source_state pushed", async () => {
    setTimeout(() => {
      eventLog.push({
        kind: "source_state",
        last_changed_files: ["main.cpp"],
      });
    }, 25);
    const res = await waitTool({ condition: "source_state", timeoutMs: 500 });
    expect((res.structuredContent as { status: string }).status).toBe("resolved");
  });

  it("condition:text returns text_wait_text_wait_requires_ocr_backend (unsupported)", async () => {
    const res = await waitTool({ condition: "text", substring: "Hello", timeoutMs: 100 });
    expect(res.isError).toBe(true);
    const body = res.structuredContent as { error: string; required_tool_call?: Record<string, unknown> };
    expect(body.error).toContain("text_wait");
    expect(body.required_tool_call).toBeDefined();
  });

  it("condition:element returns not_attached when no session", async () => {
    const res = await waitTool({ condition: "element", handle_id: "x", timeoutMs: 100 });
    expect(res.isError).toBeUndefined();
    expect((res.structuredContent as { status: string }).status).toBe("timeout");
  });
});
