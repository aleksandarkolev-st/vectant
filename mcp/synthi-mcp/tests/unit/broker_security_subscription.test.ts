import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import {
  BrokerControlPlane,
  BrokerSubscriptionRegistry,
  authenticateBrokerBearer,
  authorizeBrokerCapability,
  type BrokerPrincipal,
} from "../../src/broker/index.js";
import { EventLog } from "../../src/events/log.js";

const secret = "broker-secret";

function sign(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256", typ: "JWT" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", secret).update(`${header}.${body}`).digest("base64url");
  return `${header}.${body}.${sig}`;
}

function principal(role: BrokerPrincipal["role"] = "input_control"): BrokerPrincipal {
  return {
    subject: "agent_a",
    role,
    tenant_id: "tenant_1",
    session_ids: ["s_1"],
  };
}

describe("broker auth", () => {
  it("validates signed tokens and extracts principal scope", () => {
    const token = sign({
      iss: "synthi",
      aud: "synthi-broker",
      exp: Math.floor(Date.now() / 1000) + 60,
      sub: "agent_a",
      role: "input_control",
      tenant_id: "tenant_1",
      session_id: "s_1",
      jti: "tok_1",
    });
    const result = authenticateBrokerBearer(token, {
      secret,
      issuer: "synthi",
      audience: "synthi-broker",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unexpected auth failure");
    expect(result.principal).toMatchObject({
      subject: "agent_a",
      role: "input_control",
      tenant_id: "tenant_1",
      session_ids: ["s_1"],
      token_id: "tok_1",
    });
  });

  it("rejects revoked tokens and wrong permissions", () => {
    const token = sign({
      exp: Math.floor(Date.now() / 1000) + 60,
      sub: "reader",
      role: "read_only",
      session_id: "s_1",
      jti: "revoked",
    });
    const revoked = authenticateBrokerBearer(token, { secret, revokedTokenIds: new Set(["revoked"]) });
    expect(revoked.ok).toBe(false);
    if (revoked.ok) throw new Error("unexpected auth success");
    expect(revoked.error.error).toBe("UNAUTHORIZED");

    const blocked = authorizeBrokerCapability({
      subject: "reader",
      role: "read_only",
      tenant_id: "tenant_1",
      session_ids: ["s_1"],
    }, "dispatch_input", "s_1");
    expect(blocked?.error.error).toBe("FORBIDDEN");
  });
});

describe("broker subscriptions", () => {
  let registry: BrokerSubscriptionRegistry;

  beforeEach(() => {
    registry = new BrokerSubscriptionRegistry();
  });

  it("drops old frames per subscriber without growing queue depth", () => {
    const sub = registry.subscribe({
      principal: principal("read_only"),
      session_id: "s_1",
      topics: ["frames"],
      cursor: 0,
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) throw new Error("unexpected subscribe failure");
    registry.publish({
      kind: "frame",
      seq: 1,
      ts: 1,
      session_id: "s_1",
      frame_seq: 1,
      frame_ts_ms: 1,
      ingest_ts_ms: 1,
      viewport: { w: 10, h: 10, dpr: 1 },
      is_keyframe: false,
    });
    registry.publish({
      kind: "frame",
      seq: 2,
      ts: 2,
      session_id: "s_1",
      frame_seq: 2,
      frame_ts_ms: 2,
      ingest_ts_ms: 2,
      viewport: { w: 10, h: 10, dpr: 1 },
      is_keyframe: false,
    });
    const health = registry.health(sub.subscription_id)[0]!;
    expect(health.queue_depth).toBe(1);
    expect(health.dropped_frames).toBe(1);
  });

  it("preserves queued control events when dropping frame backlog", () => {
    const sub = registry.subscribe({
      principal: principal("read_only"),
      session_id: "s_1",
      topics: ["frames", "events"],
      cursor: 0,
    });
    expect(sub.ok).toBe(true);
    if (!sub.ok) throw new Error("unexpected subscribe failure");

    registry.publish({
      kind: "lifecycle",
      seq: 1,
      ts: 1,
      state: "running",
    });
    registry.publish({
      kind: "frame",
      seq: 2,
      ts: 2,
      session_id: "s_1",
      frame_seq: 1,
      frame_ts_ms: 2,
      ingest_ts_ms: 2,
      viewport: { w: 10, h: 10, dpr: 1 },
      is_keyframe: false,
    });
    registry.publish({
      kind: "frame",
      seq: 3,
      ts: 3,
      session_id: "s_1",
      frame_seq: 2,
      frame_ts_ms: 3,
      ingest_ts_ms: 3,
      viewport: { w: 10, h: 10, dpr: 1 },
      is_keyframe: false,
    });

    const drained = registry.drain(sub.subscription_id);
    expect(Array.isArray(drained)).toBe(true);
    if (!Array.isArray(drained)) throw new Error("unexpected drain error");
    expect(drained.map((event) => event.kind)).toEqual(["lifecycle", "frame"]);
    expect(drained[1]).toMatchObject({ kind: "frame", frame_seq: 2 });
  });

  it("returns CURSOR_TOO_OLD for stale subscribe cursor", () => {
    const res = registry.subscribe({
      principal: principal("read_only"),
      session_id: "s_1",
      topics: ["events"],
      cursor: 1,
      oldest_event_id: 5,
    });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("unexpected subscribe success");
    expect(res.error.error).toBe("CURSOR_TOO_OLD");
  });
});

describe("broker control plane", () => {
  it("applies idempotency to subscribe and replays the same subscription", () => {
    const log = new EventLog();
    const control = new BrokerControlPlane(log);
    const first = control.subscribe({
      principal: principal("read_only"),
      session_id: "s_1",
      topics: ["events"],
      idempotency_key: "idem_1",
    });
    const second = control.subscribe({
      principal: principal("read_only"),
      session_id: "s_1",
      topics: ["events"],
      idempotency_key: "idem_1",
    });
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) throw new Error("unexpected subscribe failure");
    expect(second.subscription_id).toBe(first.subscription_id);
  });

  it("enforces tenant/session scope for replay", () => {
    const log = new EventLog();
    log.push({ kind: "lifecycle", state: "ready" });
    const control = new BrokerControlPlane(log);
    const blocked = control.replay({
      principal: principal("read_only"),
      session_id: "s_2",
      from_event_id: 0,
    });
    expect(blocked.ok).toBe(false);
    if (blocked.ok) throw new Error("unexpected replay success");
    expect(blocked.error.error).toBe("FORBIDDEN");
  });

  it("scopes non-admin health responses to the caller and requested session", () => {
    const log = new EventLog();
    const control = new BrokerControlPlane(log);
    const ownPrincipal = principal("read_only");
    const otherPrincipal: BrokerPrincipal = {
      ...ownPrincipal,
      subject: "agent_b",
      session_ids: ["s_2"],
    };
    const ownSub = control.subscribe({
      principal: ownPrincipal,
      session_id: "s_1",
      topics: ["events"],
      idempotency_key: "own",
    });
    const otherSub = control.subscribe({
      principal: otherPrincipal,
      session_id: "s_2",
      topics: ["events"],
      idempotency_key: "other",
    });
    expect(ownSub.ok).toBe(true);
    expect(otherSub.ok).toBe(true);
    if (!ownSub.ok || !otherSub.ok) throw new Error("unexpected subscribe failure");

    const health = control.health({
      principal: ownPrincipal,
      session_id: "s_1",
    });
    expect(health.ok).toBe(true);
    if (!health.ok) throw new Error("unexpected health failure");
    expect(health.subscribers.map((sub) => sub.subscription_id)).toEqual([ownSub.subscription_id]);

    const filtered = control.health({
      principal: ownPrincipal,
      session_id: "s_1",
      subscriber_id: otherSub.subscription_id,
    });
    expect(filtered.ok).toBe(true);
    if (!filtered.ok) throw new Error("unexpected filtered health failure");
    expect(filtered.subscribers).toHaveLength(0);
  });
});
