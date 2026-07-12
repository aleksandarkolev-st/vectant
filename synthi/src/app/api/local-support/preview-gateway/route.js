import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  buildPreviewGatewayDecision,
  enforceRequestEnvelopeReplayProtection,
  verifyRequestEnvelopeSignature,
} from "@/lib/local-support/controlPlane";
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
  let policy;
  try {
    policy = await readDurableLocalSupportPolicy();
  } catch {
    return jsonNoStore({
      decision: "denied", reason: "policy_store_unavailable", preview_forward: false,
      raw_body_included: false, bytes_sent: 0,
    }, 503);
  }
  if (policy.enabled) {
    const signatureDecision = verifyRequestEnvelopeSignature(
      body,
      process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET,
    );
    if (signatureDecision.decision === "denied") {
      return jsonNoStore({ ...signatureDecision, preview_forward: false }, 403);
    }
  }

  const decision = buildPreviewGatewayDecision(body, policy);
  if (decision.decision === "denied") {
    return jsonNoStore(decision, 403);
  }

  if (policy.enabled) {
    const replayDecision = enforceRequestEnvelopeReplayProtection(body);
    if (replayDecision.decision === "denied") {
      return jsonNoStore({ ...replayDecision, preview_forward: false }, 409);
    }
  }

  return jsonNoStore(decision, 200);
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
