import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  claimPairingChallengeDurably,
  completePairingChallengeDurably,
  findPairingOrganization,
  persistPairingChallenge,
} from "./pairingStore";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const CODE = "ABCD2345WXYZ";
const policy = {
  enabled: true,
  min_app_version: "0.1.0",
  vulnerable_versions: [],
  policy_version: "policy-1",
  protocol_version: "local-support-mvp.1",
};

function challenge(overrides = {}) {
  return {
    pairingId: "pair_12345678",
    codeHash: createHash("sha256").update("vectant-local-support-pairing-code:").update(CODE).digest("hex"),
    fingerprint: pairingFingerprint(CODE),
    serverNonce: "nonce_12345678",
    browserSessionId: "browser_12345678",
    requestedUserId: "acct_12345678",
    accountId: "acct_12345678",
    orgId: "org_12345678",
    workspaceId: "wk_pending_local_selection",
    appVersion: "0.1.0",
    protocolVersion: "local-support-mvp.1",
    attempts: 0,
    status: "pending",
    expiresAt: new Date("2030-01-01T00:05:00.000Z"),
    ...overrides,
  };
}

function fakeClient(record = challenge()) {
  const tx = {
    localSupportPairingRateLimit: {
      deleteMany: vi.fn(async () => ({})),
      upsert: vi.fn(async () => ({ attempts: 1 })),
    },
    localSupportPairingChallenge: {
      create: vi.fn(async ({ data }) => data),
      findUnique: vi.fn(async () => record),
      update: vi.fn(async ({ data }) => ({ ...record, ...data })),
      updateMany: vi.fn(async () => ({ count: 1 })),
    },
    localSupportSession: { create: vi.fn(async ({ data }) => data) },
  };
  return {
    tx,
    client: {
      localSupportPairingChallenge: tx.localSupportPairingChallenge,
      $transaction: vi.fn(async (callback) => callback(tx)),
    },
  };
}

describe("durable local support pairing", () => {
  it("persists only a pairing code hash", async () => {
    const { tx, client } = fakeClient();
    await persistPairingChallenge({
      decision: "pairing_challenge_created",
      pairing_id: "pair_12345678",
      code: CODE,
      fingerprint: pairingFingerprint(CODE),
      server_nonce: "nonce_12345678",
      browser_session_id: "browser_12345678",
      requested_user_id: "acct_12345678",
      account_id: "acct_12345678",
      org_id: "org_12345678",
      workspace_id: "wk_pending_local_selection",
      expires_at: "2030-01-01T00:05:00.000Z",
    }, client);

    const stored = tx.localSupportPairingChallenge.create.mock.calls[0][0].data;
    expect(stored).not.toHaveProperty("code");
    expect(stored.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(stored)).not.toContain(CODE);
  });

  it("resolves challenge organization without returning pairing secrets", async () => {
    const { client, tx } = fakeClient();
    await expect(findPairingOrganization({ code: CODE }, "claim", client)).resolves.toBe("org_12345678");
    expect(tx.localSupportPairingChallenge.findUnique).toHaveBeenCalledWith({
      where: { codeHash: expect.stringMatching(/^[0-9a-f]{64}$/) },
    });
  });

  it("claims atomically with app/protocol policy and a durable rate window", async () => {
    const { tx, client } = fakeClient();
    const result = await claimPairingChallengeDurably({
      code: CODE,
      workspace_id: "wk_desktop_12345678",
      app_version: "0.1.0",
      protocol_version: "local-support-mvp.1",
    }, policy, client, NOW);

    expect(result).toMatchObject({
      decision: "pairing_challenge_claimed",
      workspace_id: "wk_desktop_12345678",
    });
    expect(tx.localSupportPairingRateLimit.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { attempts: { increment: 1 } },
    }));
    expect(tx.localSupportPairingChallenge.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "claimed", appVersion: "0.1.0" }),
    }));
  });

  it("blocks old, vulnerable, and stale protocol desktop claims", async () => {
    const { client } = fakeClient();
    const base = { code: CODE, workspace_id: "wk_desktop_12345678" };
    await expect(claimPairingChallengeDurably({
      ...base, app_version: "0.0.9", protocol_version: policy.protocol_version,
    }, policy, client, NOW)).resolves.toMatchObject({ reason: "app_version_too_old" });
    await expect(claimPairingChallengeDurably({
      ...base, app_version: "0.1.0", protocol_version: "local-support-old",
    }, policy, client, NOW)).resolves.toMatchObject({ reason: "invalid_pairing_schema" });
    await expect(claimPairingChallengeDurably({
      ...base, app_version: "0.1.0", protocol_version: policy.protocol_version,
    }, { ...policy, vulnerable_versions: ["0.1.0"] }, client, NOW))
      .resolves.toMatchObject({ reason: "app_version_blocked" });
    await expect(claimPairingChallengeDurably({
      ...base, app_version: "0.1.0+build", protocol_version: policy.protocol_version,
    }, { ...policy, vulnerable_versions: ["0.1.0"] }, client, NOW))
      .resolves.toMatchObject({ reason: "app_version_blocked" });
  });

  it("consumes the challenge and creates the device-bound session in one transaction", async () => {
    const claimed = challenge({ workspaceId: "wk_desktop_12345678", status: "claimed" });
    const { tx, client } = fakeClient(claimed);
    const proof = signProof(claimed);
    const result = await completePairingChallengeDurably({
      pairing_id: claimed.pairingId,
      code: CODE,
      fingerprint: claimed.fingerprint,
      proof,
    }, policy, client, NOW);

    expect(result).toMatchObject({
      decision: "pairing_complete",
      workspace_id: "wk_desktop_12345678",
      device_fingerprint: proof.device_fingerprint,
    });
    expect(tx.localSupportPairingChallenge.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: "consumed", consumedAt: NOW }),
    }));
    expect(tx.localSupportSession.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sessionId: expect.stringMatching(/^sess_/),
      devicePublicKey: proof.device_public_key,
    }) });
  });

  it("rechecks semantic vulnerable-version policy before completing a claim", async () => {
    const claimed = challenge({ appVersion: "0.1.0+build", status: "claimed" });
    const { client } = fakeClient(claimed);
    const proof = signProof(claimed);

    await expect(completePairingChallengeDurably({
      pairing_id: claimed.pairingId,
      code: CODE,
      fingerprint: claimed.fingerprint,
      proof,
    }, { ...policy, vulnerable_versions: ["0.1.0"] }, client, NOW))
      .resolves.toMatchObject({ reason: "app_version_blocked" });
  });
});

function signProof(record) {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const devicePublicKey = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const deviceFingerprint = `sha256:${createHash("sha256")
    .update("vectant-local-support-device:")
    .update(Buffer.from(devicePublicKey, "hex"))
    .digest("hex").slice(0, 16)}`;
  const payload = lengthPrefixed([
    "vectant-local-support-pairing-proof-v1",
    record.pairingId,
    record.serverNonce,
    record.browserSessionId,
    record.requestedUserId,
    devicePublicKey,
  ]);
  return {
    pairing_id: record.pairingId,
    server_nonce: record.serverNonce,
    browser_session_id: record.browserSessionId,
    requested_user_id: record.requestedUserId,
    device_public_key: devicePublicKey,
    device_fingerprint: deviceFingerprint,
    signature: sign(null, payload, privateKey).toString("hex"),
  };
}

function lengthPrefixed(parts) {
  return Buffer.concat(parts.map((part) => {
    const bytes = Buffer.from(String(part));
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  }));
}

function pairingFingerprint(code) {
  const digest = createHash("sha256").update("vectant-local-support-pairing:").update(code).digest("hex");
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}
