import prisma from "@/lib/prisma";
import {
  decryptRelayPayload,
  encryptRelayPayload,
  relayPayloadSha256,
} from "@/lib/local-support/relayPayloadCrypto";

const MAX_PAYLOAD_BYTES = 256 * 1024;
const PAYLOAD_TTL_MS = 5 * 60 * 1000;

export async function storeApprovedRelayPayload(input, client = prisma, now = new Date()) {
  const contentBytes = Buffer.byteLength(input.content || "", "utf8");
  if (contentBytes === 0 || contentBytes > MAX_PAYLOAD_BYTES) return null;
  if (relayPayloadSha256(input.content) !== input.contentSha256) return null;

  return client.$transaction(async (tx) => {
    const request = await tx.localSupportRelayRequest.findFirst({
      where: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        deviceFingerprint: input.deviceFingerprint,
        status: "review_pending",
        expiresAt: { gt: now },
      },
    });
    if (!request) return null;

    const context = payloadContext(request);
    const ciphertext = encryptRelayPayload(input.content, context);
    const expiresAt = new Date(Math.min(request.expiresAt.getTime(), now.getTime() + PAYLOAD_TTL_MS));
    const updated = await tx.localSupportRelayRequest.updateMany({
      where: { requestId: request.requestId, status: "review_pending" },
      data: { status: "sent", completedAt: now },
    });
    if (updated.count !== 1) return null;

    await tx.localSupportRelayPayload.create({
      data: {
        requestId: request.requestId,
        ciphertext,
        byteCount: contentBytes,
        contentSha256: input.contentSha256,
        redactionCount: boundedInteger(input.redactionCount, 0, 10_000),
        scannerVersion: String(input.scannerVersion || "").slice(0, 128),
        expiresAt,
      },
    });
    await tx.localSupportCloudAudit.create({
      data: auditData(request, {
        decision: "sent",
        bytesSent: contentBytes,
        redactionCount: input.redactionCount,
        scannerVersion: input.scannerVersion,
        reason: "approved_payload_encrypted",
      }),
    });
    return { decision: "sent", bytes_sent: contentBytes, expires_at: expiresAt.toISOString() };
  });
}

export async function takeApprovedRelayPayload(
  requestId,
  accountId,
  sessionId,
  workspaceId,
  client = prisma,
  now = new Date(),
) {
  return client.$transaction(async (tx) => {
    await tx.localSupportRelayPayload.deleteMany({ where: { expiresAt: { lte: now } } });
    const payload = await tx.localSupportRelayPayload.findFirst({
      where: {
        requestId,
        expiresAt: { gt: now },
        request: { accountId, sessionId, workspaceId, status: "sent" },
      },
      include: { request: true },
    });
    if (!payload) return null;

    const content = decryptRelayPayload(payload.ciphertext, payloadContext(payload.request));
    if (relayPayloadSha256(content) !== payload.contentSha256
      || Buffer.byteLength(content, "utf8") !== payload.byteCount) {
      throw new Error("Relay payload integrity check failed.");
    }
    await tx.localSupportRelayPayload.delete({ where: { requestId } });
    await tx.localSupportRelayRequest.update({
      where: { requestId },
      data: { status: "delivered" },
    });
    await tx.localSupportCloudAudit.create({
      data: auditData(payload.request, {
        decision: "delivered",
        bytesSent: payload.byteCount,
        redactionCount: payload.redactionCount,
        scannerVersion: payload.scannerVersion,
        reason: "one_time_payload_retrieved",
      }),
    });
    return {
      content,
      bytes_sent: payload.byteCount,
      content_sha256: payload.contentSha256,
      redaction_count: payload.redactionCount,
      scanner_version: payload.scannerVersion,
    };
  });
}

export async function denyReviewedRelayRequest(input, client = prisma, now = new Date()) {
  return client.$transaction(async (tx) => {
    const request = await tx.localSupportRelayRequest.findFirst({
      where: {
        requestId: input.requestId,
        sessionId: input.sessionId,
        deviceFingerprint: input.deviceFingerprint,
        status: "review_pending",
        expiresAt: { gt: now },
      },
    });
    if (!request) return null;
    const updated = await tx.localSupportRelayRequest.updateMany({
      where: { requestId: request.requestId, status: "review_pending" },
      data: { status: "denied", completedAt: now },
    });
    if (updated.count !== 1) return null;
    await tx.localSupportCloudAudit.create({
      data: auditData(request, {
        decision: "denied",
        bytesSent: 0,
        redactionCount: request.redactionCount,
        scannerVersion: request.scannerVersion,
        reason: "local_user_denied",
      }),
    });
    return { decision: "denied", bytes_sent: 0 };
  });
}

function payloadContext(request) {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    workspaceId: request.workspaceId,
    deviceFingerprint: request.deviceFingerprint,
  };
}

function auditData(request, summary) {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    accountId: request.accountId,
    orgId: request.orgId,
    workspaceId: request.workspaceId,
    deviceFingerprint: request.deviceFingerprint,
    actor: request.actor,
    capability: request.capability,
    targetDisplay: request.targetDisplay,
    targetHash: request.targetHash,
    targetClassification: request.targetClassification,
    decision: summary.decision,
    bytesSent: boundedInteger(summary.bytesSent, 0, MAX_PAYLOAD_BYTES),
    redactionCount: boundedInteger(summary.redactionCount, 0, 10_000),
    policyVersion: request.policyVersion,
    scannerVersion: String(summary.scannerVersion || request.scannerVersion).slice(0, 128),
    logClass: "local_support.data",
    reason: summary.reason,
  };
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}
