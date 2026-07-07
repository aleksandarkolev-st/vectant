import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  buildAdminRevokeDecision,
  constantTimeStringEqual,
  readLocalSupportPolicy,
  summarizeAdminState,
} from "@/lib/local-support/controlPlane";

export const runtime = "nodejs";

export async function GET(req) {
  const auth = authorizeAdmin(req);
  if (auth) return auth;

  const state = parseAdminStateEnv();
  return NextResponse.json(summarizeAdminState(state, readLocalSupportPolicy()), {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

export async function POST(req) {
  const auth = authorizeAdmin(req);
  if (auth) return auth;
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return NextResponse.json(denied.body, { status: denied.status });
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) {
    const denied = deniedJson(bodyResult.reason, "Request body was too large.", bodyResult.status);
    return NextResponse.json(denied.body, { status: denied.status });
  }

  const decision = buildAdminRevokeDecision(bodyResult.value, readLocalSupportPolicy());
  const status = decision.decision === "denied" ? 400 : 200;
  return NextResponse.json(decision, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function authorizeAdmin(req) {
  const expected = process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN;
  if (!expected) {
    const denied = deniedJson("admin_token_unconfigured", "Local Support admin access is not configured.");
    return NextResponse.json(denied.body, { status: denied.status });
  }
  const actual = req.headers.get("x-vectant-admin-token") || "";
  if (!constantTimeStringEqual(actual, expected)) {
    const denied = deniedJson("admin_token_invalid", "Local Support admin token was not accepted.");
    return NextResponse.json(denied.body, { status: 401 });
  }
  return null;
}

function parseAdminStateEnv() {
  try {
    const parsed = JSON.parse(process.env.VECTANT_LOCAL_SUPPORT_ADMIN_STATE_JSON || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
