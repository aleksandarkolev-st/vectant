import prisma from "@/lib/prisma";

export async function readCloudTransparencyState(accountId, client = prisma, now = new Date()) {
  if (!accountId) return emptyState();
  const [session, audits, requests] = await Promise.all([
    client.localSupportSession.findFirst({
      where: { accountId, status: "active", revokedAt: null, expiresAt: { gt: now } },
      orderBy: { createdAt: "desc" },
    }),
    client.localSupportCloudAudit.findMany({
      where: { accountId },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
    client.localSupportRelayRequest.findMany({
      where: { accountId, status: { in: ["review_pending", "sent", "delivered", "denied"] } },
      orderBy: { createdAt: "desc" },
      take: 200,
    }),
  ]);

  const sent = latestAuditByRequest(audits.filter((item) => item.decision === "sent"));
  const blocked = latestAuditByRequest(audits.filter((item) => item.decision === "denied"));
  return {
    scanner_version: audits[0]?.scannerVersion || "scanner-2026.07.05",
    session: session ? {
      connected: true,
      paused: false,
      account_id: session.accountId,
      org_id: session.orgId,
      session_id: session.sessionId,
      device_fingerprint: session.deviceFingerprint,
      permission_mode: "Balanced mode",
    } : undefined,
    workspace: session ? {
      workspace_id: session.workspaceId,
      display: session.workspaceId,
    } : undefined,
    inventory: requests.map((item) => ({
      target: item.targetDisplay,
      state: item.status === "review_pending"
        ? "approval_required"
        : item.status === "denied"
          ? "blocked_locally"
          : "sent_to_vectant",
      classification: item.targetClassification,
      reason: inventoryReason(item.status),
      bytes_sent: item.status === "sent" || item.status === "delivered"
        ? sent.find((audit) => audit.requestId === item.requestId)?.bytesSent || 0
        : 0,
    })),
    sent_payloads: sent.map((item) => ({
      request_id: item.requestId,
      actor: item.actor,
      target_display: item.targetDisplay,
      target_hash: item.targetHash,
      classification: item.targetClassification,
      redaction_count: item.redactionCount,
      bytes_sent: item.bytesSent,
      reason: item.reason,
      at: item.createdAt.toISOString(),
    })),
    blocked_items: blocked.map((item) => ({
      target: item.targetDisplay,
      reason: item.reason,
      classification: item.targetClassification,
      bytes_sent: 0,
      at: item.createdAt.toISOString(),
    })),
    activity: audits.map((item) => ({
      at: item.createdAt.toISOString(),
      class: item.logClass === "local_support.control" ? "Control" : activityClass(item.decision),
      summary: `${item.decision}: ${item.capability} for ${item.targetDisplay}; ${item.bytesSent} bytes sent.`,
    })),
    ports: parseApprovedPorts(session?.approvedPortsJson),
    export_metadata: {
      raw_bodies_included: false,
      audit_chain_verified: false,
      session_id: session?.sessionId,
      workspace_display: session?.workspaceId,
    },
  };
}

function parseApprovedPorts(value) {
  try {
    const ports = JSON.parse(value || "[]");
    return Array.isArray(ports) ? ports.map((port) => ({
      port: port.port,
      target_host: port.target_host,
      preview_host: port.preview_host,
      process_hash: port.process_identity_hash,
      ttl: port.expires_at,
      browser: port.browser_preview_allowed === true,
      aiRead: false,
      supportRead: false,
      aiInteract: false,
      responseBodies: false,
      screenshots: false,
      consoleNetwork: false,
      persistent: false,
      methods: "GET, HEAD",
    })) : [];
  } catch {
    return [];
  }
}

function latestAuditByRequest(audits) {
  const seen = new Set();
  return audits.filter((item) => {
    if (seen.has(item.requestId)) return false;
    seen.add(item.requestId);
    return true;
  });
}

function inventoryReason(status) {
  if (status === "review_pending") return "Waiting for local review; nothing sent.";
  if (status === "denied") return "Denied locally; zero bytes sent.";
  return "Approved locally and sent through the encrypted relay.";
}

function activityClass(decision) {
  if (decision === "denied") return "Denied";
  if (decision === "sent" || decision === "delivered") return "Data";
  return "Control";
}

function emptyState() {
  return {
    session: undefined,
    workspace: undefined,
    inventory: [],
    sent_payloads: [],
    blocked_items: [],
    activity: [],
    ports: [],
  };
}
