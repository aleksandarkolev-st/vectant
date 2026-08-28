import { describe, expect, it } from "vitest";

import { decryptRelayPayload, encryptRelayPayload, relayPayloadSha256 } from "./relayPayloadCrypto";

const env = { VECTANT_LOCAL_SUPPORT_RELAY_PAYLOAD_KEY: Buffer.alloc(32, 7).toString("base64") };
const context = {
  requestId: "req_123",
  sessionId: "sess_123",
  workspaceId: "wk_123",
  deviceFingerprint: "sha256:1111111111111111",
};

describe("encrypted relay payloads", () => {
  it("encrypts approved content with context-bound authenticated encryption", () => {
    const blob = encryptRelayPayload("redacted local content", context, env);

    expect(blob).not.toContain("redacted local content");
    expect(decryptRelayPayload(blob, context, env)).toBe("redacted local content");
    expect(relayPayloadSha256("redacted local content")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("fails closed for a different request context, tampering, or invalid key", () => {
    const blob = encryptRelayPayload("approved", context, env);
    expect(() => decryptRelayPayload(blob, { ...context, requestId: "req_other" }, env)).toThrow();
    expect(() => decryptRelayPayload(`${blob.slice(0, -2)}AA`, context, env)).toThrow();
    expect(() => encryptRelayPayload("approved", context, {
      VECTANT_LOCAL_SUPPORT_RELAY_PAYLOAD_KEY: Buffer.alloc(16).toString("base64"),
    })).toThrow("canonical 32-byte");
  });
});
