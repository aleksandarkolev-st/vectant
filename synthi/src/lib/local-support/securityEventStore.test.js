import { describe, expect, it, vi } from "vitest";

import { persistSecurityEvent } from "./securityEventStore";

describe("durable local support security events", () => {
  it("persists only scrubbed alert summaries and a target hash", async () => {
    const create = vi.fn(async ({ data }) => ({ id: "event-1", ...data }));
    const result = await persistSecurityEvent({
      decision: "recorded",
      dedupe_key: "denied_secret_request:sess_1:hash",
      event_type: "denied_secret_request",
      severity: "critical",
      alert: true,
      alert_route: "local_support.security.critical",
      session_id: "sess_1",
      request_id: "req_1",
      target_display: ".env authorization: [REDACTED]",
      count: 2,
      raw_body: "must never persist",
    }, "acct_1", { localSupportSecurityEvent: { create } });

    expect(result).toMatchObject({
      alert: true,
      logClass: "local_support.security.critical",
      targetHash: expect.stringMatching(/^sha256:[0-9a-f]{64}$/),
    });
    expect(result).not.toHaveProperty("raw_body");
    expect(JSON.stringify(result)).not.toContain("must never persist");
  });
});
