import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/auth";
import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  createPairingChallenge,
} from "@/lib/local-support/controlPlane";
import {
  claimPairingChallengeDurably,
  completePairingChallengeDurably,
  persistPairingChallenge,
} from "@/lib/local-support/pairingStore";
import { readDurableLocalSupportPolicy } from "@/lib/local-support/policyStore";

export const runtime = "nodejs";

export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return jsonNoStore(denied.body, denied.status);
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) {
    const denied = deniedJson(bodyResult.reason, bodyResult.message || "Request body was not accepted.", bodyResult.status);
    return jsonNoStore(denied.body, denied.status);
  }

  const body = bodyResult.value;
  const action = typeof body?.action === "string" ? body.action : "";
  let createBody = body;
  if (action === "create") {
    const session = await getServerSession(authOptions);
    const authenticatedUserId = session?.user?.id || session?.user?.email;
    if (!authenticatedUserId) {
      return jsonNoStore({
        decision: "denied",
        reason: "authentication_required",
        bytes_sent: 0,
        user_visible_message: "Sign in before starting Local Support pairing.",
      }, 401);
    }
    createBody = {
      ...body,
      account_id: authenticatedUserId,
      requested_user_id: authenticatedUserId,
      org_id: body.org_id || process.env.VECTANT_LOCAL_SUPPORT_ORG_ID || "",
    };
  }

  let policy;
  try {
    policy = await readDurableLocalSupportPolicy(
      process.env,
      undefined,
      action === "create" ? createBody.org_id : body.org_id,
    );
  } catch {
    return pairingPersistenceFailure("pairing_policy_unavailable");
  }
  if (action === "create" && !createBody.org_id) {
    createBody = { ...createBody, org_id: policy.org_id || body.org_id };
  }

  let result;
  if (action === "create") {
    result = createPairingChallenge(createBody, policy);
    if (result.decision === "pairing_challenge_created") {
      try {
        await persistPairingChallenge(result);
      } catch {
        return pairingPersistenceFailure();
      }
    }
  } else if (action === "claim") {
    try {
      result = await claimPairingChallengeDurably(body, policy);
    } catch {
      return pairingPersistenceFailure();
    }
  } else if (action === "complete") {
    try {
      result = await completePairingChallengeDurably(body, policy);
    } catch {
      return pairingPersistenceFailure();
    }
  } else {
    result = deniedJson("invalid_pairing_action", "Pairing action was not accepted.", 400).body;
  }
  const status = result.decision === "denied" ? statusForDeniedReason(result.reason) : 200;
  return jsonNoStore(result, status);
}

function pairingPersistenceFailure(reason = "pairing_session_persistence_failed") {
  return jsonNoStore({
    decision: "denied",
    reason,
    bytes_sent: 0,
    raw_body_included: false,
    user_visible_message: "Pairing could not be secured. Start a new pairing challenge.",
  }, 503);
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
