import { afterEach, describe, expect, it } from "vitest";
import { SessionChannels } from "../../src/channels.js";
import type { RTCDataChannel } from "werift";

function makeChannels(sent: string[]): SessionChannels {
  const buildLogDC = {
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  } as unknown as RTCDataChannel;
  const terminalDC = {
    readyState: "open",
    send: () => undefined,
  } as unknown as RTCDataChannel;
  const compileDC = {
    readyState: "open",
    send: (frame: string) => {
      sent.push(frame);
    },
  } as unknown as RTCDataChannel;
  return new SessionChannels(terminalDC, buildLogDC, compileDC);
}

describe("SessionChannels compile chunking", () => {
  afterEach(() => {
    delete process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES;
  });

  it("chunks large compile payloads without sending the full request first", async () => {
    process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES = "240";
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await channels.sendCompileRequest({
      language: "cpp",
      source: "int main(){return 0;}\n".repeat(40),
    });

    expect(sent.length).toBeGreaterThan(1);
    for (const frame of sent) {
      expect(Buffer.byteLength(frame, "utf8")).toBeLessThanOrEqual(240);
      const parsed = JSON.parse(frame) as Record<string, unknown>;
      expect(parsed.type).toBe("compile-request-chunk");
      expect(parsed).not.toHaveProperty("source");
    }
  });

  it("rejects invalid chunk byte configuration before sending", async () => {
    process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES = "not-a-number";
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(
      channels.sendCompileRequest({ source: "x".repeat(512) }),
    ).rejects.toThrow("invalid_compile_chunk_bytes:not-a-number");
    expect(sent).toHaveLength(0);
  });

  it("rejects too-small chunk byte limits instead of exceeding them", async () => {
    process.env.SYNTHI_MCP_COMPILE_CHUNK_BYTES = "32";
    const sent: string[] = [];
    const channels = makeChannels(sent);

    await expect(
      channels.sendCompileRequest({ source: "x".repeat(512) }),
    ).rejects.toThrow("compile_chunk_bytes_too_small:32");
    expect(sent).toHaveLength(0);
  });
});
