import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  buildTransparencyActionDecision,
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
    const denied = deniedJson(
      bodyResult.reason,
      bodyResult.message || "Request body was not accepted.",
      bodyResult.status,
    );
    return jsonNoStore(denied.body, denied.status);
  }

  const decision = buildTransparencyActionDecision(
    bodyResult.value,
    parseTransparencyStateEnv(),
    readLocalSupportPolicy(),
  );
  return jsonNoStore(decision, decision.decision === "denied" ? 403 : 200);
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function parseTransparencyStateEnv() {
  try {
    const parsed = JSON.parse(process.env.VECTANT_LOCAL_SUPPORT_TRANSPARENCY_STATE_JSON || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
