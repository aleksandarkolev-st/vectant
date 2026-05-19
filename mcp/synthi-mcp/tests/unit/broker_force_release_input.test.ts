import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { leaseRegistry } from "../../src/arbitration/lease.js";
import { session } from "../../src/session.js";
import { forceReleaseInputTool } from "../../src/tools/force_release_input.js";

const secret = "broker-secret";

function sign(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function token(role: "input_control" | "admin", subject: string): string {
  return sign({
    exp: Math.floor(Date.now() / 1000) + 60,
    sub: subject,
    role,
    tenant_id: "tenant",
    session_id: "s1",
  });
}

function installAttached(): void {
  (session as unknown as { attached: unknown }).attached = { sessionId: "s1" };
}

describe("synthi_force_release_input", () => {
  const previousSecret = process.env["SYNTHI_BROKER_AUTH_SECRET"];

  beforeEach(() => {
    session._resetForTests();
    leaseRegistry._resetForTests();
    process.env["SYNTHI_BROKER_AUTH_SECRET"] = secret;
  });

  afterEach(() => {
    if (previousSecret === undefined) delete process.env["SYNTHI_BROKER_AUTH_SECRET"];
    else process.env["SYNTHI_BROKER_AUTH_SECRET"] = previousSecret;
  });

  it("rejects callers without admin broker capability", async () => {
    installAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");

    const missing = await forceReleaseInputTool({ lease_id: lease.lease.lease_id });
    expect(missing.isError).toBe(true);
    expect((missing.structuredContent as { error: string }).error).toBe("UNAUTHORIZED");

    const nonAdmin = await forceReleaseInputTool({
      lease_id: lease.lease.lease_id,
      broker_token: token("input_control", "agent"),
    });
    expect(nonAdmin.isError).toBe(true);
    expect((nonAdmin.structuredContent as { error: string }).error).toBe("FORBIDDEN");
    expect(leaseRegistry.snapshot()).toHaveLength(1);
  });

  it("uses the authenticated admin subject as forced_by", async () => {
    installAttached();
    const lease = leaseRegistry.acquireWithPolicy(5_000, "agent", { scope: ["keyboard"] });
    expect(lease.ok).toBe(true);
    if (!lease.ok) throw new Error("unexpected lease failure");

    const spoofed = await forceReleaseInputTool({
      lease_id: lease.lease.lease_id,
      broker_token: token("admin", "admin-user"),
      forced_by: "spoofed-user",
    });
    expect(spoofed.isError).toBe(true);
    expect((spoofed.structuredContent as { error: string }).error).toBe("FORBIDDEN");

    const released = await forceReleaseInputTool({
      lease_id: lease.lease.lease_id,
      broker_token: token("admin", "admin-user"),
      reason: "human_takeover",
    });
    expect(released.isError).toBeUndefined();
    expect(released.structuredContent).toMatchObject({
      ok: true,
      released: true,
      forced_by: "admin-user",
      reason: "human_takeover",
    });
  });
});
