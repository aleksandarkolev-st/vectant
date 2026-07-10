import { createHash, generateKeyPairSync, sign } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import { authenticateLocalSupportDevice, deviceRequestPayload } from "./deviceAuth";

const NOW = new Date("2030-01-01T00:00:00.000Z");
const TIMESTAMP = "1893456000";
const PATH = "/api/local-support/relay/device";
const BODY = '{"action":"poll"}';
const BODY_SHA256 = `sha256:${createHash("sha256").update(BODY).digest("hex")}`;

function fixture() {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const publicKeyHex = publicKey.export({ format: "der", type: "spki" }).subarray(-32).toString("hex");
  const values = {
    sessionId: "sess_12345678",
    deviceFingerprint: "sha256:1111111111111111",
    timestamp: TIMESTAMP,
    nonce: "22".repeat(16),
    bodySha256: BODY_SHA256,
  };
  const signature = sign(null, deviceRequestPayload(
    "POST", PATH, values.sessionId, values.deviceFingerprint, values.timestamp, values.nonce, values.bodySha256,
  ), privateKey).toString("hex");
  const request = new Request(`https://beta.vectant.dev${PATH}`, {
    method: "POST",
    headers: {
      "x-vectant-session-id": values.sessionId,
      "x-vectant-device-fingerprint": values.deviceFingerprint,
      "x-vectant-device-timestamp": values.timestamp,
      "x-vectant-device-nonce": values.nonce,
      "x-vectant-device-signature": signature,
      "x-vectant-body-sha256": values.bodySha256,
    },
  });
  return { request, publicKeyHex, values };
}

function clientFor(session, nonceCreate = vi.fn(async () => ({}))) {
  const tx = {
    localSupportDeviceNonce: { deleteMany: vi.fn(async () => ({})), create: nonceCreate },
    localSupportSession: { update: vi.fn(async () => ({})) },
  };
  return {
    tx,
    client: {
      localSupportSession: { findFirst: vi.fn(async () => session) },
      $transaction: vi.fn(async (callback) => callback(tx)),
    },
  };
}

describe("local support device request authentication", () => {
  it("verifies a fresh device-bound signature and records its nonce", async () => {
    const { request, publicKeyHex, values } = fixture();
    const { tx, client } = clientFor({ sessionId: values.sessionId, devicePublicKey: publicKeyHex });

    const result = await authenticateLocalSupportDevice(request, PATH, BODY_SHA256, client, NOW);

    expect(result).toMatchObject({ ok: true, session: { sessionId: values.sessionId } });
    expect(tx.localSupportDeviceNonce.create).toHaveBeenCalledWith({ data: expect.objectContaining({
      sessionId: values.sessionId,
      nonce: values.nonce,
    }) });
  });

  it("rejects a signature replay across server instances through the unique nonce", async () => {
    const { request, publicKeyHex, values } = fixture();
    const replay = Object.assign(new Error("unique"), { code: "P2002" });
    const { client } = clientFor(
      { sessionId: values.sessionId, devicePublicKey: publicKeyHex },
      vi.fn(async () => { throw replay; }),
    );

    await expect(authenticateLocalSupportDevice(request, PATH, BODY_SHA256, client, NOW))
      .resolves.toEqual({ ok: false, reason: "device_proof_replayed" });
  });

  it("rejects expired, path-confused, and tampered proofs", async () => {
    const { request, publicKeyHex, values } = fixture();
    const { client } = clientFor({ sessionId: values.sessionId, devicePublicKey: publicKeyHex });

    await expect(authenticateLocalSupportDevice(request, PATH, BODY_SHA256, client, new Date("2030-01-01T00:01:00.000Z")))
      .resolves.toEqual({ ok: false, reason: "device_proof_expired" });
    await expect(authenticateLocalSupportDevice(request, "/api/local-support/relay/other", BODY_SHA256, client, NOW))
      .resolves.toEqual({ ok: false, reason: "device_proof_context_mismatch" });

    await expect(authenticateLocalSupportDevice(request, PATH, `sha256:${"00".repeat(32)}`, client, NOW))
      .resolves.toEqual({ ok: false, reason: "device_proof_body_mismatch" });

    const tampered = new Request(request, { headers: new Headers(request.headers) });
    tampered.headers.set("x-vectant-device-signature", "00".repeat(64));
    await expect(authenticateLocalSupportDevice(tampered, PATH, BODY_SHA256, client, NOW))
      .resolves.toEqual({ ok: false, reason: "device_signature_invalid" });
  });
});
