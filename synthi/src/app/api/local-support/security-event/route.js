import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/auth";
import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import { summarizeSecurityEvent } from "@/lib/local-support/controlPlane";
import { readDurableLocalSupportPolicy } from "@/lib/local-support/policyStore";
import { persistSecurityEvent } from "@/lib/local-support/securityEventStore";

export const runtime = "nodejs";

export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return jsonNoStore(denied.body, denied.status);
  }
  const session = await getServerSession(authOptions);
  const accountId = session?.user?.id || session?.user?.email;
  if (!accountId) {
    return jsonNoStore({
      decision: "denied",
      reason: "authentication_required",
      raw_body_included: false,
      bytes_sent: 0,
    }, 401);
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) {
    const denied = deniedJson(bodyResult.reason, bodyResult.message || "Request body was not accepted.", bodyResult.status);
    return jsonNoStore(denied.body, denied.status);
  }

  const body = bodyResult.value;
  let policy;
  try {
    policy = await readDurableLocalSupportPolicy(process.env, undefined, body?.org_id);
  } catch {
    return jsonNoStore({
      decision: "denied",
      reason: "policy_store_unavailable",
      raw_body_included: false,
      bytes_sent: 0,
    }, 503);
  }

  const result = summarizeSecurityEvent(body, policy);
  if (result.decision !== "denied") {
    try {
      await persistSecurityEvent(result, accountId);
    } catch {
      return jsonNoStore({
        decision: "denied",
        reason: "security_event_persistence_failed",
        raw_body_included: false,
        bytes_sent: 0,
      }, 503);
    }
  }
  const status = result.decision === "denied" ? 400 : 200;
  return jsonNoStore(result, status);
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
