import { beforeEach, describe, expect, it } from "vitest";
import {
  BrokerControlPlane,
  BrokerSubscriptionRegistry,
  assertBrokerProviderAllowed,
  brokerAuditLog,
  redactBrokerPayload,
  resolveBrokerProviderPolicy,
} from "../../src/broker/index.js";
import type { BrokerPrincipal } from "../../src/broker/auth.js";
import { EventLog } from "../../src/events/log.js";
import { session } from "../../src/session.js";
import { describeTool } from "../../src/tools/describe.js";

const inputPrincipal: BrokerPrincipal = {
  subject: "agent",
  role: "input_control",
  tenant_id: "tenant",
  session_ids: ["s1"],
};

const readOnlyPrincipal: BrokerPrincipal = {
  ...inputPrincipal,
  role: "read_only",
};

function installFakeAttached(): void {
  (session as unknown as { state: string }).state = "attached";
  (session as unknown as { attached: unknown }).attached = {
    sessionId: "s1",
    signalingUrl: "ws://localhost:9000",
    resolution: { width: 4, height: 4 },
    frames: {
      getFrame: async () => ({ data: Buffer.alloc(0), width: 4, height: 4, ts: Date.now(), seq: 1 }),
      hasFrame: () => true,
      waitForFirstFrame: async () => {},
      dimensions: () => ({ width: 4, height: 4 }),
    },
    channels: {},
  };
}

describe("broker security hardening", () => {
  beforeEach(() => {
    brokerAuditLog._resetForTests();
    session._resetForTests();
  });

  it("redacts secret keys and bearer-like values recursively", () => {
    const redacted = redactBrokerPayload({
      Authorization: "Bearer abc.def.ghi",
      nested: {
        api_key: "sk-secret",
        message: "using Bearer token-value",
      },
    }) as Record<string, unknown>;

    expect(redacted["Authorization"]).toBe("[REDACTED]");
    expect((redacted["nested"] as Record<string, unknown>)["api_key"]).toBe("[REDACTED]");
    expect((redacted["nested"] as Record<string, unknown>)["message"]).toBe("using [REDACTED]");
  });

  it("writes append-only audit records with verifiable hash chaining", () => {
    brokerAuditLog.append({ action: "subscribe", principal: "tenant:agent:read_only", payload: { token: "secret" }, ts: 1 });
    brokerAuditLog.append({ action: "dispatch_input", principal: "tenant:agent:input_control", payload: { lease_id: "l1" }, ts: 2 });
    const entries = brokerAuditLog.snapshot();
    expect(entries).toHaveLength(2);
    expect(entries[0]?.payload["token"]).toBe("[REDACTED]");
    expect(entries[1]?.previous_hash).toBe(entries[0]?.entry_hash);
    expect(brokerAuditLog.verifyIntegrity()).toBe(true);
  });

  it("denies third-party screenshot routing by default and audits the decision", () => {
    const prev = process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
    delete process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
    try {
      const policy = resolveBrokerProviderPolicy();
      expect(policy.allow_third_party_inference).toBe(false);
      const denied = assertBrokerProviderAllowed({
        provider: "claude_api",
        sends_screenshot: true,
        principal: inputPrincipal,
        session_id: "s1",
      });
      expect(denied.ok).toBe(false);
      if (denied.ok) throw new Error("unexpected provider allow");
      expect(denied.error.error).toBe("FORBIDDEN");
      expect(brokerAuditLog.snapshot()[0]?.action).toBe("provider_route_denied");
    } finally {
      if (prev === undefined) delete process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
      else process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"] = prev;
    }
  });

  it("allows third-party providers when explicitly enabled", () => {
    const prev = process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
    process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"] = "true";
    try {
      const allowed = assertBrokerProviderAllowed({
        provider: "gemini_api",
        sends_screenshot: true,
        principal: inputPrincipal,
        session_id: "s1",
      });
      expect(allowed.ok).toBe(true);
      expect(brokerAuditLog.snapshot()[0]?.action).toBe("provider_route_allowed");
    } finally {
      if (prev === undefined) delete process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
      else process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"] = prev;
    }
  });

  it("enforces third-party inference policy for server-side describe", async () => {
    const prevAllow = process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
    const prevBackend = process.env["SYNTHI_VISION_BACKEND"];
    delete process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
    process.env["SYNTHI_VISION_BACKEND"] = "claude_api";
    try {
      installFakeAttached();
      const response = await describeTool({ mode: "server_side" });
      expect(response.isError).toBe(true);
      expect((response.structuredContent as { error: string }).error).toBe("FORBIDDEN");
      expect((response.structuredContent as { reason?: string }).reason).toBe("third_party_inference_disabled");
      expect(brokerAuditLog.snapshot()[0]?.action).toBe("provider_route_denied");
    } finally {
      if (prevAllow === undefined) delete process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"];
      else process.env["SYNTHI_ALLOW_THIRD_PARTY_INFERENCE"] = prevAllow;
      if (prevBackend === undefined) delete process.env["SYNTHI_VISION_BACKEND"];
      else process.env["SYNTHI_VISION_BACKEND"] = prevBackend;
    }
  });

  it("redacts subscriber fanout before queueing log events", () => {
    const registry = new BrokerSubscriptionRegistry();
    const sub = registry.subscribe({
      principal: readOnlyPrincipal,
      session_id: "s1",
      topics: ["logs"],
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) throw new Error("unexpected subscribe failure");
    registry.publish({
      kind: "console",
      seq: 1,
      ts: 1,
      level: "info",
      source: "mcp_internal",
      message: "Authorization: Bearer abc.def.ghi",
    });
    const drained = registry.drain(sub.subscription_id);
    expect(Array.isArray(drained)).toBe(true);
    if (!Array.isArray(drained)) throw new Error("unexpected drain error");
    expect(drained[0]).toMatchObject({
      kind: "console",
      message: "Authorization: [REDACTED]",
    });
  });

  it("filters and redacts resumed subscription events", () => {
    const registry = new BrokerSubscriptionRegistry();
    const sub = registry.subscribe({
      principal: readOnlyPrincipal,
      session_id: "s1",
      topics: ["events", "logs"],
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) throw new Error("unexpected subscribe failure");

    const resumed = registry.resume({
      subscription_id: sub.subscription_id,
      last_seen_event_id: 0,
      events: [
        {
          kind: "input",
          seq: 1,
          ts: 1,
          action: "mouse:click",
          payload: { session_id: "s2", access_token: "secret-token" },
        },
        {
          kind: "console",
          seq: 2,
          ts: 2,
          level: "error",
          source: "mcp_internal",
          message: "Authorization: Bearer abc.def.ghi",
        },
      ],
    });

    expect(resumed.ok).toBe(true);
    if (!resumed.ok) throw new Error("unexpected resume failure");
    expect(resumed.events).toHaveLength(1);
    expect(resumed.events[0]).toMatchObject({
      kind: "console",
      message: "Authorization: [REDACTED]",
    });
  });

  it("redacts replay results and audits replay access", () => {
    const log = new EventLog();
    log.push({
      kind: "error",
      code: "FRAME_STALE",
      detail: {
        tool_call_id: "tc_1",
        access_token: "secret-token",
      },
    });
    const control = new BrokerControlPlane(log);
    const replay = control.replay({
      principal: inputPrincipal,
      session_id: "s1",
      from_event_id: 0,
    });
    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected replay failure");
    expect((replay.events[0]?.kind === "error" ? replay.events[0].detail?.["access_token"] : null)).toBe("[REDACTED]");
    expect(brokerAuditLog.snapshot().some((entry) => entry.action === "replay")).toBe(true);
  });

  it("filters replay results by explicit session metadata", () => {
    const log = new EventLog();
    log.push({
      kind: "frame",
      session_id: "s1",
      frame_seq: 1,
      frame_ts_ms: 1,
      ingest_ts_ms: 1,
      viewport: { w: 10, h: 10, dpr: 1 },
      is_keyframe: false,
    });
    log.push({
      kind: "frame",
      session_id: "s2",
      frame_seq: 1,
      frame_ts_ms: 2,
      ingest_ts_ms: 2,
      viewport: { w: 10, h: 10, dpr: 1 },
      is_keyframe: false,
    });
    log.push({
      kind: "input",
      action: "mouse:click",
      payload: { session_id: "s2", tool_call_id: "tc_s2" },
    });
    log.push({
      kind: "error",
      code: "FRAME_STALE",
      detail: { session_id: "s1", access_token: "secret-token" },
    });
    log.push({
      kind: "console",
      level: "info",
      source: "mcp_internal",
      message: "legacy global event",
    });
    const control = new BrokerControlPlane(log);

    const replay = control.replay({
      principal: inputPrincipal,
      session_id: "s1",
      from_event_id: 0,
    });

    expect(replay.ok).toBe(true);
    if (!replay.ok) throw new Error("unexpected replay failure");
    expect(replay.events.map((event) => event.seq)).toEqual([1, 4, 5]);
    expect(replay.events.some((event) => event.kind === "frame" && event.session_id === "s2")).toBe(false);
    expect((replay.events[1]?.kind === "error" ? replay.events[1].detail?.["access_token"] : null)).toBe("[REDACTED]");
  });
});
