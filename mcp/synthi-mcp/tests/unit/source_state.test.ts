import { beforeEach, describe, expect, it } from "vitest";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";
import { compileTool } from "../../src/tools/compile.js";
import { reportSourceStateTool } from "../../src/tools/report_source_state.js";
import { getSourceStateTool } from "../../src/tools/get_source_state.js";
import type { SourceStateEvent } from "../../src/events/index.js";

function installFakeAttached(): { sent: Array<Record<string, unknown>> } {
  const sent: Array<Record<string, unknown>> = [];
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "source-state-fixture",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600 },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 800, height: 600, ts: Date.now(), seq: 1 }),
      hasFrame: () => true,
      dimensions: () => ({ width: 800, height: 600 }),
    },
    channels: {
      sendCompileRequest: async (payload: Record<string, unknown>) => {
        sent.push(payload);
      },
    },
  };
  return { sent };
}

describe("synthi_compile auto-emits source_state", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("emits a source_state event alongside the compile input event", async () => {
    installFakeAttached();
    session.setWireState("running");
    await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      filename: "fixture.cpp",
      files: [{ name: "helpers.h", content: "#pragma once\n" }],
    });

    const sourceStates = eventLog.query({ kind: "source_state" }) as SourceStateEvent[];
    expect(sourceStates).toHaveLength(1);
    expect(sourceStates[0]!.last_changed_files).toEqual(["fixture.cpp", "helpers.h"]);
    expect(sourceStates[0]!.content_hash).toMatch(/^[0-9a-f]{16}$/);
    expect((sourceStates[0]!.detail as { source: string }).source).toBe("synthi_compile");
  });

  it("content_hash changes when source content changes", async () => {
    installFakeAttached();
    session.setWireState("running");
    await compileTool({ language: "cpp", source: "int main(){return 0;}" });
    await compileTool({ language: "cpp", source: "int main(){return 1;}" });
    const sourceStates = eventLog.query({ kind: "source_state" }) as SourceStateEvent[];
    expect(sourceStates).toHaveLength(2);
    expect(sourceStates[0]!.content_hash).not.toBe(sourceStates[1]!.content_hash);
  });

  it("content_hash stable across identical compiles", async () => {
    installFakeAttached();
    session.setWireState("running");
    await compileTool({ language: "cpp", source: "int main(){return 0;}" });
    await compileTool({ language: "cpp", source: "int main(){return 0;}" });
    const sourceStates = eventLog.query({ kind: "source_state" }) as SourceStateEvent[];
    expect(sourceStates[0]!.content_hash).toBe(sourceStates[1]!.content_hash);
  });
});

describe("synthi_report_source_state", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("requires non-empty files array", async () => {
    const r = await reportSourceStateTool({});
    expect(r.isError).toBe(true);
    expect((r.structuredContent as { field?: string }).field).toBe("files");
  });

  it("rejects non-string file entry", async () => {
    const r = await reportSourceStateTool({ files: ["ok.cpp", 42] });
    expect(r.isError).toBe(true);
    const field = (r.structuredContent as { field?: string }).field;
    expect(field).toMatch(/files\[1\]/);
  });

  it("emits a source_state event with supplied content_hash", async () => {
    const r = await reportSourceStateTool({
      files: ["app.cpp"],
      content_hash: "deadbeefcafe0000",
      detail: { origin: "manual" },
    });
    expect(r.isError).toBeUndefined();
    const content = (r.structuredContent as { seq: number; content_hash: string });
    expect(content.seq).toBeGreaterThan(0);
    expect(content.content_hash).toBe("deadbeefcafe0000");
    const events = eventLog.query({ kind: "source_state" }) as SourceStateEvent[];
    expect(events).toHaveLength(1);
    expect(events[0]!.detail).toMatchObject({ source: "synthi_report_source_state", origin: "manual" });
  });

  it("falls back to hashing file names when content_hash is omitted", async () => {
    const r = await reportSourceStateTool({ files: ["a.cpp", "b.cpp"] });
    const content = (r.structuredContent as { content_hash: string });
    expect(content.content_hash).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe("synthi_get_source_state", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("returns empty state when no producer has fired yet and session is attached", async () => {
    installFakeAttached();
    const r = await getSourceStateTool({});
    const s = r.structuredContent as {
      last_changed_files: string[];
      last_change_seq: number | null;
      content_hash: string | null;
      source_state_event_count: number;
    };
    expect(s.last_changed_files).toEqual([]);
    expect(s.last_change_seq).toBeNull();
    expect(s.content_hash).toBeNull();
    expect(s.source_state_event_count).toBe(0);
  });

  it("reports the most recent source_state event", async () => {
    installFakeAttached();
    await reportSourceStateTool({ files: ["a.cpp"], content_hash: "111" });
    await reportSourceStateTool({ files: ["a.cpp", "b.cpp"], content_hash: "222" });
    const r = await getSourceStateTool({});
    const s = r.structuredContent as {
      last_changed_files: string[];
      content_hash: string;
      source_state_event_count: number;
    };
    expect(s.last_changed_files).toEqual(["a.cpp", "b.cpp"]);
    expect(s.content_hash).toBe("222");
    expect(s.source_state_event_count).toBe(2);
  });
});
