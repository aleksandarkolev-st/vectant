import { createHash, randomUUID } from "node:crypto";
import prisma from "@/lib/prisma";

const DEFAULT_LEASE_MS = 15_000;
const MAX_LEASE_MS = 60_000;
const CONTROL_COMMAND_LEASE_MS = 15_000;

export const LOCAL_CONTROL_COMMAND_ACTIONS = new Set([
  "enable_fast_support",
  "disable_fast_support",
  "pause_session",
  "resume_session",
  "disconnect_session",
  "revoke_session_approvals",
  "revoke_port",
]);

export async function enqueueLocalControlCommand(
  {
    commandId, sessionId, accountId, orgId, workspaceId, deviceFingerprint, action, port,
    expiresAt, policyVersion = "unknown", scannerVersion = "not_applicable",
  },
  client = prisma,
) {
  if (!LOCAL_CONTROL_COMMAND_ACTIONS.has(action)) {
    throw new Error("Unsupported local control command.");
  }
  if (action === "revoke_port" && (!Number.isInteger(port) || port < 1 || port > 65_535)) {
    throw new Error("Invalid local control port.");
  }
  const data = {
    commandId,
    sessionId,
    accountId,
    orgId,
    workspaceId,
    deviceFingerprint,
    action,
    port: action === "revoke_port" ? port : null,
    expiresAt: new Date(expiresAt),
  };
  return client.$transaction(async (tx) => {
    const command = await tx.localSupportControlCommand.create({ data });
    await tx.localSupportControlAudit.create({
      data: controlAuditData({
        commandId, sessionId, accountId, orgId, workspaceId, deviceFingerprint, action,
        decision: "queued", policyVersion, scannerVersion,
      }),
    });
    return command;
  });
}

export async function leaseLocalControlCommand(
  { sessionId, deviceFingerprint, leaseId = randomUUID(), leaseMs = CONTROL_COMMAND_LEASE_MS },
  client = prisma,
  now = new Date(),
) {
  const boundedLeaseMs = Math.max(1_000, Math.min(Number(leaseMs) || CONTROL_COMMAND_LEASE_MS, MAX_LEASE_MS));
  const leaseExpiresAt = new Date(now.getTime() + boundedLeaseMs);

  return client.$transaction(async (tx) => {
    await tx.localSupportControlCommand.updateMany({
      where: {
        sessionId,
        deviceFingerprint,
        status: { in: ["queued", "leased"] },
        expiresAt: { lte: now },
      },
      data: { status: "expired", leaseId: null, leaseExpiresAt: null },
    });
    const candidate = await tx.localSupportControlCommand.findFirst({
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
    const claimed = await tx.localSupportControlCommand.updateMany({
      where: {
        commandId: candidate.commandId,
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
    const leased = await tx.localSupportControlCommand.findUnique({
      where: { commandId: candidate.commandId },
    });
    return leased ? controlCommandEnvelope(leased) : null;
  });
}

export async function recordLocalControlOutcome(
  { commandId, leaseId, sessionId, deviceFingerprint, decision, reason },
  client = prisma,
  now = new Date(),
) {
  const safeDecision = decision === "applied" ? "applied" : "denied";
  const safeReason = scrubControlReason(reason);
  return client.$transaction(async (tx) => {
    const updated = await tx.localSupportControlCommand.updateMany({
      where: {
        commandId,
        leaseId,
        sessionId,
        deviceFingerprint,
        status: "leased",
        leaseExpiresAt: { gt: now },
        expiresAt: { gt: now },
      },
      data: {
        status: safeDecision,
        completedAt: now,
        leaseId: null,
        leaseExpiresAt: null,
        resultReason: safeReason,
      },
    });
    if (updated.count !== 1) return null;
    await tx.localSupportControlAudit.update({
      where: { commandId },
      data: { decision: safeDecision, reason: safeReason },
    });
    return { decision: safeDecision, reason: safeReason, command_id: commandId };
  });
}

function scrubControlReason(value) {
  return String(value || "local_control_denied")
    .replace(/authorization:\s*(bearer|basic)\s+[^\s]+/gi, "authorization: [REDACTED]")
    .replace(/\b(postgres|postgresql|mysql|mongodb|redis):\/\/[^\s'"<>]+/gi, "[REDACTED:database_url]")
    .replace(/\b(cookie|set-cookie):\s*[^\n\r]+/gi, "$1: [REDACTED]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws_access_key]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:openai_api_key]")
    .slice(0, 256);
}

function controlCommandEnvelope(command) {
  return {
    command_id: command.commandId,
    session_id: command.sessionId,
    account_id: command.accountId,
    org_id: command.orgId,
    workspace_id: command.workspaceId,
    device_fingerprint: command.deviceFingerprint,
    action: command.action,
    port: command.port,
    expires_at: command.expiresAt.toISOString(),
    lease_id: command.leaseId,
    lease_expires_at: command.leaseExpiresAt.toISOString(),
  };
}

function controlAuditData({
  commandId, sessionId, accountId, orgId, workspaceId, deviceFingerprint, action,
  decision, policyVersion, scannerVersion, reason = null,
}) {
  return {
    commandId,
    sessionId,
    accountId,
    orgId,
    workspaceId,
    deviceFingerprint,
    actor: "browser_user",
    capability: `local_support.${action}`,
    targetDisplay: `workspace:${workspaceId}`,
    targetHash: `sha256:${createHash("sha256").update(workspaceId).digest("hex")}`,
    targetClassification: "control",
    decision,
    bytesSent: 0,
    redactionCount: 0,
    policyVersion: String(policyVersion || "unknown").slice(0, 128),
    scannerVersion: String(scannerVersion || "not_applicable").slice(0, 128),
    logClass: "local_support.control",
    reason: reason ? scrubControlReason(reason) : null,
  };
}

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
  {
    requestId,
    leaseId,
    sessionId,
    deviceFingerprint,
    decision,
    bytesSent = 0,
    redactionCount,
    scannerVersion,
    reason,
  },
  client = prisma,
  now = new Date(),
) {
  const safeDecision = ["sent", "review_pending"].includes(decision) ? decision : "denied";
  const safeBytes = safeDecision === "sent" ? boundedInteger(bytesSent, 0, 10 * 1024 * 1024) : 0;

  return client.$transaction(async (tx) => {
    const request = await tx.localSupportRelayRequest.findFirst({
      where: {
        requestId,
        leaseId,
        sessionId,
        deviceFingerprint,
        status: "leased",
        leaseExpiresAt: { gt: now },
        expiresAt: { gt: now },
      },
    });
    if (!request) return null;

    const updated = await tx.localSupportRelayRequest.updateMany({
      where: { requestId, leaseId, sessionId, deviceFingerprint, status: "leased" },
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
    if (safeDecision === "denied") {
      await tx.localSupportSecurityEvent.create({
        data: denialAlertData(request, reason, now),
      });
    }
    return { decision: safeDecision, bytes_sent: safeBytes, audit_id: audit.id };
  });
}

function denialAlertData(request, reason, now) {
  const safeReason = typeof reason === "string" ? reason.slice(0, 128).toLowerCase() : "local_request_denied";
  const classification = String(request.targetClassification || "").toUpperCase();
  let eventType = "local_request_denied";
  let severity = "medium";
  if (safeReason.includes("scanner")) {
    eventType = "scanner_failure";
    severity = "high";
  } else if (safeReason.includes("secret") || ["L4", "L5"].includes(classification)) {
    eventType = "denied_secret";
    severity = "high";
  } else if (safeReason.includes("traversal") || safeReason.includes("path_escape")) {
    eventType = "traversal_attempt";
    severity = "high";
  } else if (safeReason.includes("rate")) {
    eventType = "rate_limit";
  } else if (safeReason.includes("preview_redirect")) {
    eventType = "preview_redirect_block";
  } else if (safeReason.includes("version")) {
    eventType = "old_version";
  }
  return {
    dedupeKey: `${eventType}:${request.sessionId}:${request.requestId}`.slice(0, 256),
    eventType,
    severity,
    alert: true,
    alertRoute: severity === "high" ? "security_ops_immediate" : "security_ops_monitor",
    accountId: String(request.accountId || "").slice(0, 256),
    sessionId: String(request.sessionId || "").slice(0, 128),
    requestId: String(request.requestId || "").slice(0, 128),
    targetDisplay: String(request.targetDisplay || "").slice(0, 512),
    targetHash: String(request.targetHash || "").slice(0, 128),
    count: 1,
    logClass: `local_support.security.${severity}`,
    createdAt: now,
  };
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
