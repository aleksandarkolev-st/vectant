import { beforeEach, describe, expect, it } from "vitest";
import { compileTool } from "../../src/tools/compile.js";
import { eventLog } from "../../src/events/index.js";
import { session } from "../../src/session.js";

interface SentPayload {
  raw: string;
  parsed: Record<string, unknown>;
}

function installFakeAttached(): { sent: SentPayload[]; setReadyState: (s: string) => void } {
  const sent: SentPayload[] = [];
  let readyState = "open";
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "fixture-session",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 800, height: 600 },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 800, height: 600, ts: Date.now(), seq: 1 }),
      hasFrame: () => true,
      dimensions: () => ({ width: 800, height: 600 }),
    },
    channels: {
      sendCompileRequest: async (payload: Record<string, unknown>) => {
        if (readyState !== "open") {
          throw new Error(`compile_channel_not_open:${readyState}`);
        }
        const raw = JSON.stringify(payload);
        sent.push({ raw, parsed: payload });
      },
    },
  };
  return {
    sent,
    setReadyState: (s: string) => {
      readyState = s;
    },
  };
}

describe("synthi_compile", () => {
  beforeEach(() => {
    session._resetForTests();
    eventLog._resetForTests();
  });

  it("rejects when language is missing", async () => {
    installFakeAttached();
    const res = await compileTool({ source: "int main(){}" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string }).field).toBe("language");
  });

  it("rejects when source is missing", async () => {
    installFakeAttached();
    const res = await compileTool({ language: "cpp" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string }).field).toBe("source");
  });

  it("rejects malformed files array", async () => {
    installFakeAttached();
    const res = await compileTool({
      language: "cpp",
      source: "int main(){}",
      files: [{ name: 42, content: "x" }],
    });
    expect(res.isError).toBe(true);
    const field = (res.structuredContent as { field?: string }).field;
    expect(field).toMatch(/files\[0\]/);
  });

  it("refuses when not attached (input_gate)", async () => {
    // session._resetForTests leaves wireState ready + detached attached
    const res = await compileTool({ language: "cpp", source: "int main(){}" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("session_terminated");
  });

  it("sends a well-formed CompileRequest on the compile channel", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      is_gui: true,
      width: 800,
      height: 600,
      use_ai_split: true,
    });
    expect(res.isError).toBeUndefined();
    expect(fake.sent).toHaveLength(1);
    const payload = fake.sent[0]!.parsed;
    expect(payload["language"]).toBe("cpp");
    expect(payload["filename"]).toBe("main.cpp");
    expect(payload["source"]).toBe("int main(){return 0;}");
    expect(payload["session_id"]).toBe("fixture-session");
    expect(payload["is_gui"]).toBe(true);
    expect(payload["use_ai_split"]).toBe(true);
  });

  it("honors explicit filename", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    await compileTool({ language: "cpp", source: "...", filename: "fixture.cpp" });
    expect(fake.sent[0]!.parsed["filename"]).toBe("fixture.cpp");
  });

  it("forwards optional target/project_root/slug", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    await compileTool({
      language: "java",
      source: "class A{}",
      target: "react-native-emulator",
      project_root: "apps/ui",
      slug: "counter",
    });
    const p = fake.sent[0]!.parsed;
    expect(p["target"]).toBe("react-native-emulator");
    expect(p["project_root"]).toBe("apps/ui");
    expect(p["slug"]).toBe("counter");
  });

  it("emits an input event with payload metadata", async () => {
    installFakeAttached();
    session.setWireState("running");
    await compileTool({ language: "cpp", source: "int main(){}", use_ai_split: true });
    const inputs = eventLog.query({ kind: "input" });
    expect(inputs).toHaveLength(1);
    const ev = inputs[0] as unknown as {
      action: string;
      payload: { language: string; use_ai_split: boolean; source_chars: number };
    };
    expect(ev.action).toBe("compile:start");
    expect(ev.payload.language).toBe("cpp");
    expect(ev.payload.use_ai_split).toBe(true);
    expect(ev.payload.source_chars).toBeGreaterThan(0);
  });

  it("surfaces compile_channel_not_open when DC is closed", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    fake.setReadyState("closed");
    const res = await compileTool({ language: "cpp", source: "int main(){}" });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("compile_channel_not_open");
  });

  it("blocks on the input gate when a disruption is pending", async () => {
    installFakeAttached();
    session.setWireState("running");
    session.markDisruption("crash-recovered", {});
    const res = await compileTool({ language: "cpp", source: "..." });
    expect(res.isError).toBe(true);
    expect((res.structuredContent as { error: string }).error).toBe("input_rejected_awaiting_ack");
  });
});
