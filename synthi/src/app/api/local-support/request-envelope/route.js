import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  enforceRequestEnvelopeReplayProtection,
  readLocalSupportPolicy,
  validateRequestEnvelope,
  verifyRequestEnvelopeSignature,
} from "@/lib/local-support/controlPlane";

export const runtime = "nodejs";

export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return NextResponse.json(denied.body, { status: denied.status });
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) {
    const denied = deniedJson(bodyResult.reason, "Request body was too large.", bodyResult.status);
    return NextResponse.json(denied.body, { status: denied.status });
  }

  const body = bodyResult.value;
  const policy = readLocalSupportPolicy();
  if (policy.enabled) {
    const signatureDecision = verifyRequestEnvelopeSignature(
      body,
      process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET,
    );
    if (signatureDecision.decision === "denied") {
      return NextResponse.json(signatureDecision, { status: 403 });
    }
    const replayDecision = enforceRequestEnvelopeReplayProtection(body);
    if (replayDecision.decision === "denied") {
      return NextResponse.json(replayDecision, { status: 409 });
    }
  }

  const decision = validateRequestEnvelope(body, policy);
  const status = decision.decision === "denied" ? 403 : 200;
  return NextResponse.json(decision, { status });
}
