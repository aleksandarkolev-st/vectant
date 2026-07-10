import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { vi } from "vitest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const { getServerSessionMock } = vi.hoisted(() => ({
  getServerSessionMock: vi.fn(),
}));

vi.mock("next-auth", () => ({
  getServerSession: getServerSessionMock,
}));

vi.mock("@/app/auth", () => ({ authOptions: {} }));

import { clearAdminRevocationStore, clearPairingChallengeStore } from "@/lib/local-support/controlPlane";

import { POST } from "./route";

const OLD_ENV = { ...process.env };

beforeEach(() => {
  getServerSessionMock.mockReset();
  getServerSessionMock.mockResolvedValue({
    user: { id: "acct_pair", email: "pair@example.test" },
  });
});

afterEach(() => {
  process.env = { ...OLD_ENV };
  clearAdminRevocationStore();
  clearPairingChallengeStore();
});

function request(body, init = {}) {
  return new Request("https://beta.vectant.dev/api/local-support/pairing", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      origin: "https://beta.vectant.dev",
      "sec-fetch-site": "same-origin",
      ...(init.headers || {}),
    },
    body: JSON.stringify(body),
  });
}

function createBody(overrides = {}) {
  return {
    action: "create",
    account_id: "acct_pair",
    org_id: "org_pair",
    workspace_id: "wk_pair",
    browser_session_id: "browser_pair",
    requested_user_id: "user_pair",
    ...overrides,
  };
}

function signProof(challenge, overrides = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const publicDer = publicKey.export({ format: "der", type: "spki" });
  const devicePublicKey = Buffer.from(publicDer).subarray(-32).toString("hex");
  const proof = {
    pairing_id: challenge.pairing_id,
    server_nonce: challenge.server_nonce,
    browser_session_id: challenge.browser_session_id,
    requested_user_id: challenge.requested_user_id,
    device_public_key: devicePublicKey,
    device_fingerprint: deviceFingerprint(devicePublicKey),
    ...overrides,
  };
  const signature = sign(
    null,
    pairingChallengePayload(
      proof.pairing_id,
      proof.server_nonce,
      proof.browser_session_id,
      proof.requested_user_id,
      proof.device_public_key,
    ),
    privateKey,
  );
  return {
    ...proof,
    signature: signature.toString("hex"),
  };
}

function completeBody(challenge, proof = signProof(challenge), overrides = {}) {
  return {
    action: "complete",
    pairing_id: challenge.pairing_id,
    code: challenge.code,
    fingerprint: challenge.fingerprint,
    proof,
    ...overrides,
  };
}

describe("local support pairing route", () => {
  it("creates and consumes a signed pairing challenge exactly once", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    process.env.VECTANT_LOCAL_SUPPORT_ACCOUNT_ID = "acct_pair";
    process.env.VECTANT_LOCAL_SUPPORT_ORG_ID = "org_pair";

    const created = await POST(request(createBody()));
    const challenge = await created.json();

    expect(created.status).toBe(200);
    expect(created.headers.get("cache-control")).toBe("no-store");
    expect(challenge).toMatchObject({
      decision: "pairing_challenge_created",
      account_id: "acct_pair",
      org_id: "org_pair",
      workspace_id: "wk_pair",
      browser_session_id: "browser_pair",
      requested_user_id: "acct_pair",
      raw_body_included: false,
      bytes_sent: 0,
    });
    expect(challenge.code).toMatch(/^[A-Z2-9]{12}$/);
    expect(challenge.fingerprint).toMatch(/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/);

    const claimedResponse = await POST(request({ action: "claim", code: challenge.code }));
    const claimed = await claimedResponse.json();

    expect(claimedResponse.status).toBe(200);
    expect(claimed).toMatchObject({
      decision: "pairing_challenge_claimed",
      pairing_id: challenge.pairing_id,
      fingerprint: challenge.fingerprint,
      server_nonce: challenge.server_nonce,
      account_id: "acct_pair",
      org_id: "org_pair",
      workspace_id: "wk_pair",
      raw_body_included: false,
      bytes_sent: 0,
    });
    expect(claimed).not.toHaveProperty("code");

    const completed = await POST(request(completeBody(challenge)));
    const paired = await completed.json();

    expect(completed.status).toBe(200);
    expect(paired).toMatchObject({
      decision: "pairing_complete",
      account_id: "acct_pair",
      org_id: "org_pair",
      workspace_id: "wk_pair",
      browser_session_id: "browser_pair",
      requested_user_id: "acct_pair",
      raw_body_included: false,
      bytes_sent: 0,
      local_enforcement_required: true,
      consent_receipt: expect.objectContaining({
        account_id: "acct_pair",
        org_id: "org_pair",
        workspace_id: "wk_pair",
        user_confirmation_required: true,
      }),
    });
    expect(paired.device_public_key_hash).toMatch(/^sha256:/);
    expect(paired.device_fingerprint).toMatch(/^sha256:[0-9a-f]{16}$/);
    expect(paired.consent_receipt.device_fingerprint).toBe(paired.device_fingerprint);
    expect(JSON.stringify(paired)).not.toContain("PRIVATE KEY");

    const replay = await POST(request(completeBody(challenge)));
    expect(replay.status).toBe(409);
    await expect(replay.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "pairing_code_consumed",
      bytes_sent: 0,
    });
  });

  it("rejects cross-site pairing and disabled policy before issuing a code", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";

    const crossSite = await POST(request(createBody(), { headers: { "sec-fetch-site": "cross-site" } }));
    expect(crossSite.status).toBe(403);
    await expect(crossSite.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "bad_origin",
      bytes_sent: 0,
    });

    getServerSessionMock.mockResolvedValueOnce(null);
    const unauthenticated = await POST(request(createBody()));
    expect(unauthenticated.status).toBe(401);
    await expect(unauthenticated.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "authentication_required",
      bytes_sent: 0,
    });

    delete process.env.VECTANT_LOCAL_SUPPORT_ENABLED;
    const disabled = await POST(request(createBody()));
    expect(disabled.status).toBe(403);
    await expect(disabled.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "feature_disabled",
      bytes_sent: 0,
    });
  });

  it("rejects tampered device proofs and rate-limits bad code attempts", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";

    const created = await POST(request(createBody()));
    const challenge = await created.json();
    const tamperedProof = signProof(challenge, { browser_session_id: "browser_attacker" });
    const tampered = await POST(request(completeBody(challenge, tamperedProof)));
    expect(tampered.status).toBe(403);
    await expect(tampered.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "pairing_proof_context_mismatch",
      bytes_sent: 0,
    });

    for (let index = 0; index < 4; index += 1) {
      const bad = await POST(request(completeBody(challenge, signProof(challenge), { code: "BADCODE22222" })));
      expect(bad.status).toBe(403);
      await expect(bad.json()).resolves.toMatchObject({
        decision: "denied",
        reason: "pairing_code_mismatch",
      });
    }

    const limited = await POST(request(completeBody(challenge, signProof(challenge), { code: "BADCODE22222" })));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "pairing_rate_limited",
      bytes_sent: 0,
    });
  });

  it("rejects malformed completion code and fingerprint shape", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";

    const created = await POST(request(createBody()));
    const challenge = await created.json();

    for (const overrides of [
      { code: `${challenge.code}\n` },
      { code: challenge.code.toLowerCase() },
      { fingerprint: "a".repeat(128) },
    ]) {
      const response = await POST(request(completeBody(challenge, signProof(challenge), {
        request_id: `req_bad_pairing_shape_${Object.keys(overrides)[0]}`,
        ...overrides,
      })));
      expect(response.status).toBe(400);
      await expect(response.json()).resolves.toMatchObject({
        decision: "denied",
        reason: "invalid_pairing_schema",
        bytes_sent: 0,
      });
    }
  });

  it("rejects malformed and unknown desktop claim codes without challenge details", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    await POST(request(createBody()));

    const malformed = await POST(request({ action: "claim", code: "short" }));
    expect(malformed.status).toBe(400);
    await expect(malformed.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "invalid_pairing_schema",
      bytes_sent: 0,
    });

    const unknown = await POST(request({ action: "claim", code: "ZZZZZZZZZZZZ" }));
    expect(unknown.status).toBe(404);
    const unknownBody = await unknown.json();
    expect(unknownBody).toMatchObject({
      decision: "denied",
      reason: "pairing_challenge_not_found",
      bytes_sent: 0,
    });
    expect(unknownBody).not.toHaveProperty("pairing_id");
    expect(unknownBody).not.toHaveProperty("fingerprint");

    for (let index = 1; index < 20; index += 1) {
      const attempt = await POST(request({ action: "claim", code: "ZZZZZZZZZZZZ" }));
      expect(attempt.status).toBe(404);
    }
    const limited = await POST(request({ action: "claim", code: "ZZZZZZZZZZZZ" }));
    expect(limited.status).toBe(429);
    await expect(limited.json()).resolves.toMatchObject({
      decision: "denied",
      reason: "pairing_rate_limited",
      bytes_sent: 0,
    });
  });

  it("binds a pending browser challenge to the desktop-selected workspace", async () => {
    process.env.VECTANT_LOCAL_SUPPORT_ENABLED = "true";
    const created = await POST(request(createBody({ workspace_id: "wk_pending_local_selection" })));
    const challenge = await created.json();

    const claimed = await POST(request({
      action: "claim",
      code: challenge.code,
      workspace_id: "wk_desktop_selected",
    }));

    expect(claimed.status).toBe(200);
    await expect(claimed.json()).resolves.toMatchObject({
      decision: "pairing_challenge_claimed",
      workspace_id: "wk_desktop_selected",
    });
  });
});

function deviceFingerprint(devicePublicKeyHex) {
  const digest = createHash("sha256")
    .update("vectant-local-support-device:")
    .update(Buffer.from(devicePublicKeyHex, "hex"))
    .digest("hex");
  return `sha256:${digest.slice(0, 16)}`;
}

function pairingChallengePayload(...parts) {
  return Buffer.concat(parts.map((part) => {
    const bytes = Buffer.from(String(part), "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  }));
}
