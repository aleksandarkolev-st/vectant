import { randomUUID } from "node:crypto";

import prisma from "@/lib/prisma";

const DEFAULT_LEASE_MS = 15_000;
const MAX_LEASE_MS = 60_000;

export async function enqueueRelayRequest(envelope, relayDecision, client = prisma) {
  const data = relayRequestData(envelope, relayDecision);
  return client.$transaction(async (tx) => {
    const request = await tx.localSupportRelayRequest.create({ data });
    await tx.localSupportCloudAudit.create({
      data: auditData(request, {
        decision: "queued",
        bytes_sent: 0,
        log_class: "local_support.control",
        reason: "signed_envelope_accepted",
      }),
    });
    return request;
  });
}

export async function leaseRelayRequest(
  { sessionId, deviceFingerprint, leaseId = randomUUID(), leaseMs = DEFAULT_LEASE_MS },
  client = prisma,
  now = new Date(),
) {
  const boundedLeaseMs = Math.max(1_000, Math.min(Number(leaseMs) || DEFAULT_LEASE_MS, MAX_LEASE_MS));
  const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs);

  return client.$transaction(async (tx) => {
    await tx.localSupportRelayRequest.updateMany({
      where: {
        sessionId,
        deviceFingerprint,
        status: { in: ["queued", "leased"] },
        expiresAt: { lte: now },
      },
      data: { status: "expired", leaseId: null, leaseExpiresAt: null },
    });

    const candidate = await tx.localSupportRelayRequest.findFirst({
      where: {
        sessionId,
        deviceFingerprint,
        expiresAt: { gt: now },
        OR: [
          { status: "queued" },
          { status: "leased", leaseExpiresAt: { lt: now } },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    if (!candidate) return null;

    const claimed = await tx.localSupportRelayRequest.updateMany({
      where: {
        requestId: candidate.requestId,
        expiresAt: { gt: now },
        OR: [
          { status: "queued" },
          { status: "leased", leaseExpiresAt: { lt: now } },
        ],
      },
      data: {
        status: "leased",
        leaseId,
        leaseExpiresAt,
        deliveryAttempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;

    const leased = await tx.localSupportRelayRequest.findUnique({
      where: { requestId: candidate.requestId },
    });
    return leased ? deliveryEnvelope(leased) : null;
  });
}

export async function recordRelayOutcome(
  { requestId, leaseId, decision, bytesSent = 0, redactionCount, scannerVersion, reason },
  client = prisma,
  now = new Date(),
) {
  const safeDecision = decision === "sent" ? "sent" : "denied";
  const safeBytes = safeDecision === "sent" ? boundedInteger(bytesSent, 0, 10 * 1024 * 1024) : 0;

  return client.$transaction(async (tx) => {
    const request = await tx.localSupportRelayRequest.findFirst({
      where: {
        requestId,
        leaseId,
        status: "leased",
        leaseExpiresAt: { gt: now },
        expiresAt: { gt: now },
      },
    });
    if (!request) return null;

    const updated = await tx.localSupportRelayRequest.updateMany({
      where: { requestId, leaseId, status: "leased" },
      data: {
        status: safeDecision,
        completedAt: now,
        leaseId: null,
        leaseExpiresAt: null,
      },
    });
    if (updated.count !== 1) return null;

    const audit = await tx.localSupportCloudAudit.create({
      data: auditData(request, {
        decision: safeDecision,
        bytes_sent: safeBytes,
        redaction_count: redactionCount,
        scanner_version: scannerVersion,
        log_class: "local_support.data",
        reason,
      }),
    });
    return { decision: safeDecision, bytes_sent: safeBytes, audit_id: audit.id };
  });
}

function relayRequestData(envelope, decision) {
  return {
    requestId: decision.request_id,
    sessionId: decision.session_id,
    accountId: decision.account_id,
    orgId: decision.org_id,
    workspaceId: decision.workspace_id,
    deviceFingerprint: decision.device_fingerprint,
    actor: decision.actor,
    capability: decision.capability,
    targetDisplay: decision.target_display,
    targetHash: decision.target_hash,
    targetClassification: decision.target_classification,
    redactionCount: boundedInteger(decision.redaction_count, 0, 10_000),
    scannerVersion: decision.scanner_version,
    policyVersion: decision.policy_version,
    protocolVersion: decision.protocol_version,
    appVersion: decision.app_version,
    deviceProof: envelope.device_proof,
    envelopeSignature: envelope.signature,
    expiresAt: new Date(envelope.expires_at),
  };
}

function deliveryEnvelope(request) {
  return {
    request_id: request.requestId,
    session_id: request.sessionId,
    account_id: request.accountId,
    org_id: request.orgId,
    workspace_id: request.workspaceId,
    device_fingerprint: request.deviceFingerprint,
    actor: request.actor,
    capability: request.capability,
    target_display: request.targetDisplay,
    target_hash: request.targetHash,
    target_classification: request.targetClassification,
    redaction_count: request.redactionCount,
    scanner_version: request.scannerVersion,
    policy_version: request.policyVersion,
    protocol_version: request.protocolVersion,
    app_version: request.appVersion,
    expires_at: request.expiresAt.toISOString(),
    device_proof: request.deviceProof,
    signature: request.envelopeSignature,
    lease_id: request.leaseId,
    lease_expires_at: request.leaseExpiresAt.toISOString(),
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
    bytesSent: boundedInteger(summary.bytes_sent, 0, 10 * 1024 * 1024),
    redactionCount: boundedInteger(summary.redaction_count ?? request.redactionCount, 0, 10_000),
    policyVersion: request.policyVersion,
    scannerVersion: typeof summary.scanner_version === "string"
      ? summary.scanner_version.slice(0, 128)
      : request.scannerVersion,
    logClass: summary.log_class,
    reason: typeof summary.reason === "string" ? summary.reason.slice(0, 256) : null,
  };
}

function boundedInteger(value, minimum, maximum) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return minimum;
  return Math.max(minimum, Math.min(Math.trunc(parsed), maximum));
}
