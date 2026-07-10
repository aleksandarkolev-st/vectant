import { createPublicKey, verify as verifySignature } from "node:crypto";

import prisma from "@/lib/prisma";
import { findActivePairedSession } from "@/lib/local-support/sessionStore";

const MAX_CLOCK_SKEW_SECONDS = 30;
const NONCE_TTL_MS = 2 * 60 * 1000;

export async function authenticateLocalSupportDevice(req, expectedPath, client = prisma, now = new Date()) {
  const headers = readProofHeaders(req.headers);
  if (!headers) return denied("device_proof_missing");
  if (req.method !== "POST" || new URL(req.url).pathname !== expectedPath) {
    return denied("device_proof_context_mismatch");
  }

  const timestampSeconds = Number(headers.timestamp);
  if (!Number.isSafeInteger(timestampSeconds)
    || Math.abs(Math.floor(now.getTime() / 1000) - timestampSeconds) > MAX_CLOCK_SKEW_SECONDS) {
    return denied("device_proof_expired");
  }

  const session = await findActivePairedSession(
    headers.sessionId,
    headers.deviceFingerprint,
    client,
    now,
  );
  if (!session) return denied("device_session_not_found");
  if (!verifyDeviceRequestSignature(headers, req.method, expectedPath, session.devicePublicKey)) {
    return denied("device_signature_invalid");
  }

  try {
    await client.$transaction(async (tx) => {
      await tx.localSupportDeviceNonce.deleteMany({ where: { expiresAt: { lte: now } } });
      await tx.localSupportDeviceNonce.create({
        data: {
          sessionId: session.sessionId,
          nonce: headers.nonce,
          expiresAt: new Date(now.getTime() + NONCE_TTL_MS),
        },
      });
      await tx.localSupportSession.update({
        where: { sessionId: session.sessionId },
        data: { lastDeviceProofAt: now },
      });
    });
  } catch (error) {
    return denied(error?.code === "P2002" ? "device_proof_replayed" : "device_auth_unavailable");
  }

  return { ok: true, session };
}

export function deviceRequestPayload(method, path, sessionId, deviceFingerprint, timestamp, nonce) {
  return lengthPrefixed([
    "VECTANT-LOCAL-SUPPORT-DEVICE-V1",
    method,
    path,
    sessionId,
    deviceFingerprint,
    String(timestamp),
    nonce,
  ]);
}

function readProofHeaders(headers) {
  const values = {
    sessionId: headers.get("x-vectant-session-id") || "",
    deviceFingerprint: headers.get("x-vectant-device-fingerprint") || "",
    timestamp: headers.get("x-vectant-device-timestamp") || "",
    nonce: headers.get("x-vectant-device-nonce") || "",
    signature: headers.get("x-vectant-device-signature") || "",
  };
  if (!/^sess_[A-Za-z0-9_-]{8,120}$/.test(values.sessionId)
    || !/^sha256:[0-9a-f]{16}$/i.test(values.deviceFingerprint)
    || !/^\d{10}$/.test(values.timestamp)
    || !/^[0-9a-f]{32}$/i.test(values.nonce)
    || !/^[0-9a-f]{128}$/i.test(values.signature)) {
    return null;
  }
  return values;
}

function verifyDeviceRequestSignature(headers, method, path, publicKeyHex) {
  if (!/^[0-9a-f]{64}$/i.test(publicKeyHex || "")) return false;
  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(publicKeyHex, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    return verifySignature(
      null,
      deviceRequestPayload(
        method,
        path,
        headers.sessionId,
        headers.deviceFingerprint,
        headers.timestamp,
        headers.nonce,
      ),
      publicKey,
      Buffer.from(headers.signature, "hex"),
    );
  } catch {
    return false;
  }
}

function lengthPrefixed(parts) {
  return Buffer.concat(parts.map((part) => {
    const bytes = Buffer.from(String(part), "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  }));
}

function denied(reason) {
  return { ok: false, reason };
}
