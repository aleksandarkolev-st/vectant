import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/auth";
import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import { takeApprovedRelayPayload } from "@/lib/local-support/relayPayloadStore";

export const runtime = "nodejs";

export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return jsonNoStore(denied.body, denied.status);
  }
  const session = await getServerSession(authOptions);
  const accountId = session?.user?.id || session?.user?.email;
  if (!accountId) return jsonNoStore(denied("authentication_required"), 401);

  const parsed = await readBoundedJson(req, 4 * 1024);
  if (!parsed.ok) return jsonNoStore(denied(parsed.reason), parsed.status);
  const body = parsed.value;
  if (Object.keys(body).some((key) => key !== "request_id")
    || typeof body.request_id !== "string"
    || !/^[A-Za-z0-9_-]{8,128}$/.test(body.request_id)) {
    return jsonNoStore(denied("invalid_payload_request"), 400);
  }

  try {
    const payload = await takeApprovedRelayPayload(body.request_id, accountId);
    if (!payload) return jsonNoStore(denied("payload_not_available"), 404);
    return jsonNoStore({ decision: "payload_delivered", ...payload, raw_body_included: true });
  } catch {
    return jsonNoStore(denied("relay_unavailable"), 503);
  }
}

function denied(reason) {
  return { decision: "denied", reason, raw_body_included: false, bytes_sent: 0 };
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
