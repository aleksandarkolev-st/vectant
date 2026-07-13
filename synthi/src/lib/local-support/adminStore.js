import prisma from "@/lib/prisma";
import { buildAdminRevokeDecision } from "@/lib/local-support/controlPlane";

const REVOCABLE_RELAY_STATUSES = ["queued", "leased", "review_pending"];

export async function readDurableAdminState(client = prisma) {
  const now = new Date();
  const [sessions, alerts] = await Promise.all([
    client.localSupportSession.findMany({
      orderBy: { createdAt: "desc" },
      take: 500,
    }),
    client.localSupportSecurityEvent.findMany({
      where: { alert: true },
      orderBy: { createdAt: "desc" },
      take: 100,
    }),
  ]);
  const deviceMap = new Map();
  for (const session of sessions) {
    const active = isActiveSession(session, now);
    const approvedPortsCount = active ? countApprovedPorts(session.approvedPortsJson) : 0;
    const current = deviceMap.get(session.deviceFingerprint) || {
      device_id: session.deviceFingerprint,
      account_id: session.accountId,
      org_id: session.orgId,
      app_version: session.appVersion,
      last_active_at: (session.lastDeviceProofAt || session.updatedAt).toISOString(),
      policy_version: session.policyVersion,
      active_sessions: 0,
      approved_ports_count: 0,
      revoked: true,
    };
    if (active) {
      current.active_sessions += 1;
      current.approved_ports_count += approvedPortsCount;
      current.revoked = false;
    }
    deviceMap.set(session.deviceFingerprint, current);
  }
  return {
    devices: [...deviceMap.values()],
    sessions: sessions.map((session) => ({
      session_id: session.sessionId,
      device_id: session.deviceFingerprint,
      account_id: session.accountId,
      org_id: session.orgId,
      workspace_id: session.workspaceId,
      app_version: session.appVersion,
      policy_version: session.policyVersion,
      approved_ports_count: isActiveSession(session, now)
        ? countApprovedPorts(session.approvedPortsJson)
        : 0,
      last_active_at: (session.lastDeviceProofAt || session.updatedAt).toISOString(),
      revoked: !isActiveSession(session, now),
    })),
    revoked_sessions: sessions
      .filter((session) => !isActiveSession(session, now))
      .map((session) => session.sessionId),
    revoked_devices: [...deviceMap.values()]
      .filter((device) => device.revoked)
      .map((device) => device.device_id),
    alerts: alerts.map((alert) => ({
      event_id: alert.id,
      event_type: alert.eventType,
      severity: alert.severity,
      alert_route: alert.alertRoute,
      account_id: alert.accountId,
      session_id: alert.sessionId,
      request_id: alert.requestId,
      target_display: alert.targetDisplay,
      target_hash: alert.targetHash,
      count: alert.count,
      at: alert.createdAt.toISOString(),
    })),
  };
}

function isActiveSession(session, now) {
  return session.status === "active"
    && !session.revokedAt
    && session.expiresAt > now;
}

function countApprovedPorts(value) {
  try {
    const parsed = JSON.parse(value || "[]");
    return Array.isArray(parsed) ? parsed.length : 0;
  } catch {
    return 0;
  }
}

export async function recordDurableAdminRevocation(input, policy, client = prisma, now = new Date()) {
  const decision = buildAdminRevokeDecision(input, policy);
  if (decision.decision === "denied") return decision;

  return client.$transaction(async (tx) => {
    const sessionWhere = decision.target_type === "session"
      ? { sessionId: decision.target_id }
      : { deviceFingerprint: decision.target_id };
    const sessions = await tx.localSupportSession.findMany({ where: sessionWhere });
    if (sessions.length === 0) {
      return { ...decision, decision: "denied", reason: "admin_revoke_target_not_found" };
    }
    const sessionIds = sessions.map((session) => session.sessionId);
    await tx.localSupportSession.updateMany({
      where: { sessionId: { in: sessionIds } },
      data: { status: "revoked", revokedAt: now },
    });
    await tx.localSupportRelayPayload.deleteMany({
      where: { request: { sessionId: { in: sessionIds } } },
    });
    await tx.localSupportRelayRequest.updateMany({
      where: { sessionId: { in: sessionIds }, status: { in: REVOCABLE_RELAY_STATUSES } },
      data: { status: "revoked", completedAt: now, leaseId: null, leaseExpiresAt: null },
    });
    const [revokedSessionsCount, revokedDevices] = await Promise.all([
      tx.localSupportSession.count({ where: { status: "revoked" } }),
      tx.localSupportSession.findMany({ where: { status: "revoked" }, select: { deviceFingerprint: true } }),
    ]);
    return {
      ...decision,
      revocation_recorded: true,
      revoked_sessions_count: revokedSessionsCount,
      revoked_devices_count: new Set(revokedDevices.map((item) => item.deviceFingerprint)).size,
    };
  });
}
