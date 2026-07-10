import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  buildRelayForwardDecision,
  enforceRequestEnvelopeReplayProtection,
  readLocalSupportPolicy,
  verifyRequestEnvelopeSignature,
} from "@/lib/local-support/controlPlane";
import { enqueueRelayRequest } from "@/lib/local-support/relayStore";

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
  const policy = readLocalSupportPolicy();
  if (policy.enabled) {
    const signatureDecision = verifyRequestEnvelopeSignature(
      body,
      process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET,
    );
    if (signatureDecision.decision === "denied") {
      return jsonNoStore({ ...signatureDecision, relay_forward: false }, 403);
    }
  }

  const decision = buildRelayForwardDecision(body, policy);
  if (decision.decision === "denied") {
    return jsonNoStore(decision, 403);
  }

  try {
    await enqueueRelayRequest(body, decision);
  } catch (error) {
    if (error?.code === "P2002") {
      return jsonNoStore({
        decision: "denied",
        reason: "request_replay_detected",
        relay_forward: false,
        raw_body_included: false,
        bytes_sent: 0,
      }, 409);
    }
    return jsonNoStore({
      decision: "denied",
      reason: "relay_unavailable",
      relay_forward: false,
      raw_body_included: false,
      bytes_sent: 0,
      user_visible_message: "Local Support relay is temporarily unavailable.",
    }, 503);
  }

  if (policy.enabled) {
    const replayDecision = enforceRequestEnvelopeReplayProtection(body);
    if (replayDecision.decision === "denied") {
      return jsonNoStore({ ...replayDecision, relay_forward: false }, 409);
    }
  }

  return jsonNoStore({ ...decision, decision: "relay_queued", relay_forward: true }, 202);
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
