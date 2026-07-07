import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  completePairingChallenge,
  createPairingChallenge,
  readLocalSupportPolicy,
} from "@/lib/local-support/controlPlane";

export const runtime = "nodejs";

export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return jsonNoStore(denied.body, denied.status);
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) {
    const denied = deniedJson(bodyResult.reason, "Request body was too large.", bodyResult.status);
    return jsonNoStore(denied.body, denied.status);
  }

  const body = bodyResult.value;
  const action = typeof body?.action === "string" ? body.action : "";
  const policy = readLocalSupportPolicy();
  const result = action === "create"
    ? createPairingChallenge(body, policy)
    : action === "complete"
      ? completePairingChallenge(body, policy)
      : deniedJson("invalid_pairing_action", "Pairing action was not accepted.", 400).body;
  const status = result.decision === "denied" ? statusForDeniedReason(result.reason) : 200;
  return jsonNoStore(result, status);
}

function statusForDeniedReason(reason) {
  if (reason === "invalid_pairing_action" || reason === "invalid_pairing_schema") return 400;
  if (reason === "pairing_challenge_not_found") return 404;
  if (reason === "pairing_rate_limited") return 429;
  if (reason === "pairing_code_consumed") return 409;
  return 403;
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
