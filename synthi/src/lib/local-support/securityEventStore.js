import { createHash } from "node:crypto";

import prisma from "@/lib/prisma";

export async function persistSecurityEvent(summary, accountId, client = prisma) {
  if (summary?.decision !== "recorded" || !accountId) {
    throw new Error("Security event was not valid for persistence.");
  }
  return client.localSupportSecurityEvent.create({
    data: {
      dedupeKey: String(summary.dedupe_key).slice(0, 256),
      eventType: String(summary.event_type).slice(0, 128),
      severity: String(summary.severity).slice(0, 32),
      alert: summary.alert === true,
      alertRoute: String(summary.alert_route).slice(0, 128),
      accountId: String(accountId).slice(0, 256),
      sessionId: String(summary.session_id || "").slice(0, 128),
      requestId: String(summary.request_id || "").slice(0, 128),
      targetDisplay: String(summary.target_display || "").slice(0, 512),
      targetHash: `sha256:${createHash("sha256").update(String(summary.target_display || "")).digest("hex")}`,
      count: boundedCount(summary.count),
      logClass: `local_support.security.${summary.severity}`,
    },
  });
}

export async function readRecentSecurityAlerts(client = prisma) {
  return client.localSupportSecurityEvent.findMany({
    where: { alert: true },
    orderBy: { createdAt: "desc" },
    take: 100,
  });
}

function boundedCount(value) {
  const count = Number(value);
  return Number.isFinite(count) ? Math.max(1, Math.min(Math.trunc(count), 100)) : 1;
}
