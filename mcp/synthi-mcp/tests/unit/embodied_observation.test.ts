import { describe, expect, it } from "vitest";
import {
  ChannelRegistry,
  dropSensitiveKeysPolicy,
  secretsPolicy,
} from "../../src/embodied/observation.js";

describe("observation channel registry + redaction policies", () => {
  it("unknown channels error loudly instead of returning silence", async () => {
    const registry = new ChannelRegistry();
    await expect(registry.observe("nonexistent")).rejects.toThrow(/unknown channel/);
  });

  it("applies the secrets policy to nested strings", async () => {
    const registry = new ChannelRegistry();
    registry.register("console", () => ({
      lines: ["API_TOKEN=super-secret-1", "plain line"],
      meta: { nested: "ghp_0123456789abcdefghijklmnopqrstuvwxyzABCDEF" },
    }));
    const bundle = await registry.observe("console");
    const data = bundle.data as { lines: string[]; meta: { nested: string } };
    expect(data.lines[0]).not.toContain("super-secret-1");
    expect(data.lines[1]).toBe("plain line");
    expect(data.meta.nested).toContain("<redacted github_pat>");
    expect(bundle.policies_applied).toEqual(["secrets"]);
    expect(bundle.channels_used).toEqual(["console"]);
  });

  it("dropSensitiveKeys removes whole credential fields", async () => {
    const registry = new ChannelRegistry();
    registry.register("net", () => ({
      url: "https://host.test/p",
      headers: { Authorization: "Bearer x", Accept: "application/json" },
      auth_token: "keep-me-out",
      body: { user: "a", password_hash: "b" },
    }));
    const bundle = await registry.observe("net", [dropSensitiveKeysPolicy]);
    const data = bundle.data as Record<string, unknown>;
    expect(Object.keys(data.headers as object)).toEqual(["Accept"]);
    expect(data.auth_token).toBeUndefined();
    expect((data.body as Record<string, unknown>).password_hash).toBeUndefined();
    expect((data.body as Record<string, unknown>).user).toBe("a");
  });

  it("composes policies in order", async () => {
    const registry = new ChannelRegistry();
    registry.register("mixed", () => ({
      line: "PASSWORD=abc123",
      password: "field",
    }));
    const bundle = await registry.observe("mixed", [dropSensitiveKeysPolicy, secretsPolicy]);
    const data = bundle.data as { line: string; password?: string };
    expect(data.password).toBeUndefined(); // dropped by policy 1
    expect(data.line).toContain("<redacted"); // scrubbed by policy 2
    expect(bundle.policies_applied).toEqual(["drop_sensitive_keys", "secrets"]);
  });
});
