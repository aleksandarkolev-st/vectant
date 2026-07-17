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
      bypass_ai_split_cache: true,
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
    expect(payload["bypass_ai_split_cache"]).toBe(true);
  });

  it("forwards fresh AI split cache policy aliases", async () => {
    for (const field of [
      "bypass_ai_split_cache",
      "force_ai_split",
      "force_fresh_ai_split",
      "require_fresh_ai_split",
    ]) {
      const fake = installFakeAttached();
      session.setWireState("running");
      const res = await compileTool({
        language: "cpp",
        source: "int main(){return 0;}",
        [field]: true,
      });

      expect(res.isError).toBeUndefined();
      expect(fake.sent.at(-1)!.parsed["bypass_ai_split_cache"]).toBe(true);
      session._resetForTests();
      eventLog._resetForTests();
    }
  });

  it("forwards an explicit device compile cache bypass without granting authority", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      bypass_device_compile_cache: true,
    });

    expect(res.isError).toBeUndefined();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.parsed["bypass_device_compile_cache"]).toBe(true);
    expect(fake.sent[0]!.parsed["bypass_ai_split_cache"]).toBeUndefined();

    const input = eventLog.query({ kind: "input" })[0] as {
      payload: Record<string, unknown>;
    };
    expect(input.payload["bypass_device_compile_cache"]).toBe(true);
  });

  it("preserves explicit false and omits the device compile cache field by default", async () => {
    const explicitFalse = installFakeAttached();
    session.setWireState("running");
    const falseRes = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      bypass_device_compile_cache: false,
    });

    expect(falseRes.isError).toBeUndefined();
    expect(explicitFalse.sent[0]!.parsed["bypass_device_compile_cache"]).toBe(false);
    const falseInput = eventLog.query({ kind: "input" })[0] as {
      payload: Record<string, unknown>;
    };
    expect(falseInput.payload["bypass_device_compile_cache"]).toBe(false);

    session._resetForTests();
    eventLog._resetForTests();
    const defaultRequest = installFakeAttached();
    session.setWireState("running");
    const defaultRes = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
    });

    expect(defaultRes.isError).toBeUndefined();
    expect(defaultRequest.sent[0]!.parsed).not.toHaveProperty("bypass_device_compile_cache");
    const defaultInput = eventLog.query({ kind: "input" })[0] as {
      payload: Record<string, unknown>;
    };
    expect(defaultInput.payload).not.toHaveProperty("bypass_device_compile_cache");
  });

  it.each(["true", 1, null, {}])(
    "rejects a non-boolean device compile cache bypass (%j)",
    async (bypassDeviceCompileCache) => {
      const fake = installFakeAttached();
      session.setWireState("running");
      const res = await compileTool({
        language: "cpp",
        source: "int main(){return 0;}",
        bypass_device_compile_cache: bypassDeviceCompileCache,
      });

      expect(res.isError).toBe(true);
      expect((res.structuredContent as { field?: string; expected?: string }).field).toBe(
        "bypass_device_compile_cache",
      );
      expect((res.structuredContent as { expected?: string }).expected).toBe("boolean");
      expect(fake.sent).toHaveLength(0);
      session._resetForTests();
      eventLog._resetForTests();
    },
  );

  it("forwards request-bound provider proof fields and a backend routing hint", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    const nonce = "provider-call:0123456789abcdef0123456789abcdef";
    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      require_ai_provider_call: true,
      ai_provider_call_nonce: nonce,
      ai_provider: "generic-provider",
      ai_model: "generic-model",
      gpu_mode: "rocm",
    });

    expect(res.isError).toBeUndefined();
    expect(fake.sent[0]!.parsed["require_ai_provider_call"]).toBe(true);
    expect(fake.sent[0]!.parsed["ai_provider_call_nonce"]).toBe(nonce);
    expect(fake.sent[0]!.parsed["ai_provider"]).toBe("generic-provider");
    expect(fake.sent[0]!.parsed["ai_model"]).toBe("generic-model");
    expect(fake.sent[0]!.parsed["gpu_mode"]).toBe("rocm");
  });

  it("normalizes provider and model aliases onto canonical worker keys", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      provider_name: "  Generic-Provider  ",
      model_name: "  generic-model  ",
    });

    expect(res.isError).toBeUndefined();
    expect(fake.sent[0]!.parsed["ai_provider"]).toBe("generic-provider");
    expect(fake.sent[0]!.parsed["ai_model"]).toBe("generic-model");
  });

  it("forwards provider proof field aliases using canonical worker keys", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    const nonce = "provider-call:fedcba9876543210fedcba9876543210";
    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      force_ai_provider_call: true,
      provider_call_nonce: nonce,
    });

    expect(res.isError).toBeUndefined();
    expect(fake.sent[0]!.parsed["require_ai_provider_call"]).toBe(true);
    expect(fake.sent[0]!.parsed["ai_provider_call_nonce"]).toBe(nonce);
  });

  it("rejects a required provider call without a valid caller nonce", async () => {
    installFakeAttached();
    session.setWireState("running");
    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      require_ai_provider_call: true,
      ai_provider_call_nonce: "provider-call:not-hex",
    });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string }).field).toBe("ai_provider_call_nonce");
  });

  it("forwards workspace file refs without requiring inline contents", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    const res = await compileTool({
      language: "cpp",
      filename: "src/main.cpp",
      source: "int main(){return 0;}",
      file_refs: [{ name: "include/kernel.h", sha256: "abc123", bytes: 42 }],
    });

    expect(res.isError).toBeUndefined();
    const payload = fake.sent[0]!.parsed;
    expect(payload["files"]).toEqual([]);
    expect(payload["file_refs"]).toEqual([{ name: "include/kernel.h", sha256: "abc123", bytes: 42 }]);
    const sourceState = eventLog.query({ kind: "source_state" })[0] as unknown as {
      last_changed_files: string[];
    };
    expect(sourceState.last_changed_files).toContain("include/kernel.h");
  });

  it("rejects malformed file refs", async () => {
    installFakeAttached();
    session.setWireState("running");
    const res = await compileTool({
      language: "cpp",
      source: "int main(){}",
      file_refs: [{ name: "include/kernel.h", bytes: -1 }],
    });

    expect(res.isError).toBe(true);
    const field = (res.structuredContent as { field?: string }).field;
    expect(field).toBe("file_refs[0].bytes");
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

  it("forwards a bounded support-only source-first request intent unchanged", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");
    const intent = {
      schemaVersion: "synthi.gpu_hmr.source_first_request_intent.v1",
      proofAuthority: "source_first_request_intent_only_not_runtime_proof",
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      canSatisfyRuntimeProof: false,
      canSatisfyDispatchProof: false,
      sourcePaths: ["src/main.cpp"],
      evidence: { intentHash: "sha256:0123456789abcdef" },
    };

    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      source_first_request_intent: intent,
    });

    expect(res.isError).toBeUndefined();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]!.parsed["source_first_request_intent"]).toEqual(intent);
    expect(fake.sent[0]!.raw).toContain('"source_first_request_intent"');
  });

  it.each([null, [], "intent", 1])(
    "rejects a non-object source-first request intent (%j)",
    async (sourceFirstRequestIntent) => {
      const fake = installFakeAttached();
      session.setWireState("running");

      const res = await compileTool({
        language: "cpp",
        source: "int main(){return 0;}",
        source_first_request_intent: sourceFirstRequestIntent,
      });

      expect(res.isError).toBe(true);
      expect((res.structuredContent as { field?: string }).field).toBe(
        "source_first_request_intent",
      );
      expect(fake.sent).toHaveLength(0);
    },
  );

  it("rejects an oversized source-first request intent", async () => {
    const fake = installFakeAttached();
    session.setWireState("running");

    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      source_first_request_intent: { metadata: "x".repeat(64 * 1024) },
    });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string; reason?: string }).field).toBe(
      "source_first_request_intent",
    );
    expect((res.structuredContent as { reason?: string }).reason).toContain("exceeds 65536 bytes");
    expect(fake.sent).toHaveLength(0);
  });

  it.each([
    { gpuHmrSuccess: true },
    { nested: { can_satisfy_runtime_proof: true } },
    { nested: { dispatchAuthority: true } },
    { nested: { runtime_authority: "accepted" } },
  ])("rejects source-first authority claims (%j)", async (sourceFirstRequestIntent) => {
    const fake = installFakeAttached();
    session.setWireState("running");

    const res = await compileTool({
      language: "cpp",
      source: "int main(){return 0;}",
      source_first_request_intent: sourceFirstRequestIntent,
    });

    expect(res.isError).toBe(true);
    expect((res.structuredContent as { field?: string; reason?: string }).field).toBe(
      "source_first_request_intent",
    );
    expect((res.structuredContent as { reason?: string }).reason).toContain("authority claim");
    expect(fake.sent).toHaveLength(0);
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
