import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const adminStore = vi.hoisted(() => ({
  read: vi.fn(),
  revoke: vi.fn(),
  authorize: vi.fn(),
  readPolicy: vi.fn(),
  updatePolicy: vi.fn(),
}));

vi.mock("@/lib/local-support/adminStore", async () => {
  const controlPlane = await import("@/lib/local-support/controlPlane");
  return {
    readDurableAdminState: adminStore.read,
    recordDurableAdminRevocation: adminStore.revoke.mockImplementation(
      async (input, policy) => controlPlane.recordAdminRevocation(input, policy),
    ),
  };
});
vi.mock("@/lib/local-support/sessionStore", () => ({
  authorizeRelaySession: adminStore.authorize,
}));
vi.mock("@/lib/local-support/policyStore", async () => {
  const controlPlane = await import("@/lib/local-support/controlPlane");
  return {
    readDurableLocalSupportPolicy: adminStore.readPolicy.mockImplementation(
      async () => controlPlane.readLocalSupportPolicy(),
    ),
    updateDurableLocalSupportPolicy: adminStore.updatePolicy,
  };
});

import {
  clearAdminRevocationStore,
  clearRequestEnvelopeReplayCache,
  signDeviceProof,
  signRequestEnvelope,
} from "@/lib/local-support/controlPlane";
import { POST as REQUEST_ENVELOPE_POST } from "@/app/api/local-support/request-envelope/route";

import { GET, POST } from "./route";

const OLD_ENV = { ...process.env };
const DEVICE_PROOF_SECRET = "test-device-proof-secret";

beforeEach(() => {
  adminStore.read.mockReset();
  adminStore.read.mockImplementation(async () => {
    try {
      return JSON.parse(process.env.VECTANT_LOCAL_SUPPORT_ADMIN_STATE_JSON || "{}");
    } catch {
      return {};
    }
  });
  adminStore.revoke.mockClear();
  adminStore.authorize.mockReset();
  adminStore.authorize.mockResolvedValue({ ok: true, session: { sessionId: "sess_123" } });
  adminStore.readPolicy.mockClear();
  adminStore.updatePolicy.mockReset();
  adminStore.updatePolicy.mockResolvedValue({ decision: "policy_updated", bytes_sent: 0 });
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  clearAdminRevocationStore();
  clearRequestEnvelopeReplayCache();
});

function adminGet(headers = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/admin/state", {
    method: "GET",
    headers: {
      origin: "https://beta.vectant.dev",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
  });
}

function adminPost(body, headers = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/admin/state", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      "sec-fetch-site": "same-origin",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

function requestEnvelope(body) {
  return new Request("https://beta.vectant.dev/api/local-support/request-envelope", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      "sec-fetch-site": "same-origin",
    },
    body: JSON.stringify(body),
  });
}

function signedEnvelope(overrides = {}) {
  const body = {
    request_id: "req_admin_revoke",
    session_id: "sess_123",
    account_id: "acct_123",
    org_id: "org_123",
    workspace_id: "wk_123",
    device_fingerprint: "sha256:1111111111111111",
    capability: "workspace.log.read",
    actor: "support_agent",
    expires_at: new Date(Date.now() + 60_000).toISOString(),
    app_version: "0.1.0",
    protocol_version: "local-support-mvp.1",
    policy_version: "2026.07.05",
    ...overrides,
  };
  const proofBoundBody = {
    ...body,
    device_proof: overrides.device_proof || signDeviceProof(body, DEVICE_PROOF_SECRET),
  };
  return {
    ...proofBoundBody,
    signature: signRequestEnvelope(proofBoundBody, "test-envelope-secret"),
  };
}

describe("local support admin state route", () => {
  it("fails closed when admin access is unconfigured or token is wrong", async () => {
    delete process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN;
    let response = await GET(adminGet());
    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "admin_token_unconfigured",
      bytes_sent: 0,
    });

    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    response = await GET(adminGet({ "x-vectant-admin-token": "wrong" }));
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "admin_token_invalid",
      bytes_sent: 0,
    });
  });

  it("rejects unsafe admin token configuration and oversized presented tokens", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "short";
    let response = await GET(adminGet({ "x-vectant-admin-token": "short" }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "admin_token_misconfigured",
      bytes_sent: 0,
    });

    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    response = await GET(adminGet({ "x-vectant-admin-token": "a".repeat(512) }));
    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "admin_token_invalid",
      bytes_sent: 0,
    });
  });

  it("denies cross-site fetch metadata for admin state reads", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";

    const response = await GET(adminGet({
      "x-vectant-admin-token": "admin-secret",
      "sec-fetch-site": "cross-site",
    }));

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("denies cross-site fetch metadata for admin revocation", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";

    const response = await POST(
      adminPost(
        { target_type: "session", target_id: "sess_123" },
        {
          "x-vectant-admin-token": "admin-secret",
          "sec-fetch-site": "cross-site",
        },
      ),
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });
  });

  it("returns scrubbed device and session summaries without raw bodies", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_STATE_JSON = JSON.stringify({
      devices: [
        {
          device_id: "dev_123 Authorization: Bearer abcdefghijklmnopqrstuvwxyz",
          account_id: "acct_123",
          org_id: "org_123",
          app_version: "0.1.0",
          last_active_at: "2026-07-06T12:00:00Z",
          active_sessions: 2,
          approved_ports_count: 1,
        },
      ],
      sessions: [
        {
          session_id: "sess_123",
          device_id: "dev_123",
          workspace_id: "wk_123",
          approved_ports_count: 1,
          app_version: "0.1.0",
        },
      ],
    });

    const response = await GET(adminGet({ "x-vectant-admin-token": "admin-secret" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "admin_state_ready",
      raw_body_included: false,
      paired_devices: [
        expect.objectContaining({
          account_id: "acct_123",
          approved_ports_count: 1,
          active_sessions: 2,
        }),
      ],
      active_sessions: [
        expect.objectContaining({
          session_id: "sess_123",
          approved_ports_count: 1,
        }),
      ],
    });
    expect(json.paired_devices[0].device_id).toContain("authorization: [REDACTED]");
    expect(JSON.stringify(json)).not.toContain("abcdefghijklmnopqrstuvwxyz");
  });

  it("builds immediate revoke decisions for devices and sessions", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";

    const response = await POST(
      adminPost(
        { target_type: "session", target_id: "sess_123" },
        { "x-vectant-admin-token": "admin-secret" },
      ),
    );
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(json).toMatchObject({
      decision: "revocation_required",
      reason: "session_revocation_requested",
      target_type: "session",
      target_id: "sess_123",
      revocation_recorded: true,
      bytes_sent: 0,
      raw_body_included: false,
      local_enforcement_required: true,
    });

    const invalid = await POST(
      adminPost(
        { target_type: "workspace", target_id: "wk_123" },
        { "x-vectant-admin-token": "admin-secret" },
      ),
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "invalid_admin_revoke_target",
      bytes_sent: 0,
    });
  });

  it("applies validated persistent kill switches through the admin API", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    adminStore.updatePolicy.mockResolvedValueOnce({
      decision: "policy_updated",
      pairing_disabled: true,
      preview_disabled: true,
      min_app_version: "0.2.0",
      raw_body_included: false,
      bytes_sent: 0,
    });
    const body = {
      action: "update_policy",
      pairing_disabled: true,
      preview_disabled: true,
      min_app_version: "0.2.0",
    };

    const response = await POST(adminPost(body, { "x-vectant-admin-token": "admin-secret" }));

    expect(response.status).toBe(200);
    expect(adminStore.updatePolicy).toHaveBeenCalledWith(body, "admin_api");
    await expect(response.json()).resolves.toMatchObject({
      decision: "policy_updated",
      pairing_disabled: true,
      preview_disabled: true,
      bytes_sent: 0,
    });
  });

  it("admin session revoke immediately denies signed request envelopes", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET = "test-envelope-secret";
    process.env.VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET = DEVICE_PROOF_SECRET;

    const before = await REQUEST_ENVELOPE_POST(requestEnvelope(signedEnvelope({ request_id: "req_before_revoke" })));
    expect(before.status).toBe(200);
    await expect(before.json()).resolves.toMatchObject({
      decision: "approval_required",
      bytes_sent: 0,
    });

    const revoke = await POST(
      adminPost(
        { target_type: "session", target_id: "sess_123" },
        { "x-vectant-admin-token": "admin-secret" },
      ),
    );
    expect(revoke.status).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({
      decision: "revocation_required",
      revocation_recorded: true,
    });

    const after = await REQUEST_ENVELOPE_POST(requestEnvelope(signedEnvelope({ request_id: "req_after_revoke" })));
    expect(after.status).toBe(403);
    await expect(after.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "session_revoked",
      bytes_sent: 0,
    });
  });

  it("admin state exposes scrubbed env and runtime revocations", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN = "admin-secret";
    process.env.VECTANT_LOCAL_SUPPORT_REVOKED_DEVICES = "sha256:2222222222222222";

    const revoke = await POST(
      adminPost(
        { target_type: "session", target_id: "sess_runtime" },
        { "x-vectant-admin-token": "admin-secret" },
      ),
    );
    expect(revoke.status).toBe(200);

    const response = await GET(adminGet({ "x-vectant-admin-token": "admin-secret" }));
    const json = await response.json();

    expect(response.status).toBe(200);
    expect(json).toMatchObject({
      decision: "admin_state_ready",
      raw_body_included: false,
      revocations: {
        revoked_sessions_count: 1,
        revoked_devices_count: 1,
        revoked_sessions: ["sess_runtime"],
        revoked_devices: ["sha256:2222222222222222"],
      },
    });
  });
});
