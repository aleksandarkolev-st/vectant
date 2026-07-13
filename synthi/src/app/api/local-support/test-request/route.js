import { createHash, randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/auth";
import { isSameOriginRequest } from "@/app/api/local-support/httpGuards";
import prisma from "@/lib/prisma";
import { enqueueRelayRequest } from "@/lib/local-support/relayStore";
import { readDurableLocalSupportPolicy } from "@/lib/local-support/policyStore";

export const runtime = "nodejs";

export async function POST(req) {
  if (process.env.VECTANT_LOCAL_SUPPORT_TEST_REQUESTS !== "true") {
    return json({ decision: "denied", reason: "test_requests_disabled", bytes_sent: 0 }, 404);
  }
  if (!isSameOriginRequest(req)) {
    return json({ decision: "denied", reason: "bad_origin", bytes_sent: 0 }, 403);
  }

  const session = await getServerSession(authOptions);
  const accountId = session?.user?.id || session?.user?.email || "";
  if (!accountId) return json({ decision: "denied", reason: "authentication_required", bytes_sent: 0 }, 401);

  const policy = await readDurableLocalSupportPolicy();
  if (!policy.enabled) return json({ decision: "denied", reason: "feature_disabled", bytes_sent: 0 }, 403);

  const paired = await prisma.localSupportSession.findFirst({
    where: { accountId, status: "active", revokedAt: null, expiresAt: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (!paired) return json({ decision: "denied", reason: "local_app_not_connected", bytes_sent: 0 }, 403);

  const requestId = `test_${randomUUID().replaceAll("-", "")}`;
  const targetDisplay = "package.json";
  const targetHash = `sha256:${createHash("sha256").update(targetDisplay).digest("hex")}`;
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();
  const envelope = {
    request_id: requestId,
    session_id: paired.sessionId,
    account_id: paired.accountId,
    org_id: paired.orgId,
    workspace_id: paired.workspaceId,
    device_fingerprint: paired.deviceFingerprint,
    device_proof: "manual_test_request",
    signature: "manual_test_request",
    capability: "workspace.file.source.read",
    actor: "support_agent",
    expires_at: expiresAt,
    app_version: paired.appVersion,
    protocol_version: paired.protocolVersion,
    policy_version: paired.policyVersion,
    target_display: targetDisplay,
    target_classification: "L2",
    scanner_version: "manual-test-request",
    redaction_count: 0,
  };
  const decision = {
    request_id: requestId,
    session_id: paired.sessionId,
    account_id: paired.accountId,
    org_id: paired.orgId,
    workspace_id: paired.workspaceId,
    device_fingerprint: paired.deviceFingerprint,
    actor: "support_agent",
    capability: "workspace.file.source.read",
    target_display: targetDisplay,
    target_hash: targetHash,
    target_classification: "L2",
    redaction_count: 0,
    scanner_version: "manual-test-request",
    policy_version: paired.policyVersion,
    protocol_version: paired.protocolVersion,
    app_version: paired.appVersion,
  };

  await enqueueRelayRequest(envelope, decision);
  return json({
    decision: "test_request_queued",
    request_id: requestId,
    target_display: targetDisplay,
    bytes_sent: 0,
    user_visible_message: "A test file request was queued for local review. Nothing was sent.",
  }, 202);
}

function json(body, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
