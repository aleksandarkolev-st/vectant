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
  return jsonNoStore(summarizeAdminState(state, readLocalSupportPolicy()));
}

export async function POST(req) {
  const auth = authorizeAdmin(req);
  if (auth) return auth;
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return jsonNoStore(denied.body, denied.status);
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) {
    const denied = deniedJson(bodyResult.reason, "Request body was too large.", bodyResult.status);
    return jsonNoStore(denied.body, denied.status);
  }

  const decision = buildAdminRevokeDecision(bodyResult.value, readLocalSupportPolicy());
  const status = decision.decision === "denied" ? 400 : 200;
  return jsonNoStore(decision, status);
}

function authorizeAdmin(req) {
  const expected = process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN;
  if (!expected) {
    const denied = deniedJson("admin_token_unconfigured", "Local Support admin access is not configured.");
    return jsonNoStore(denied.body, denied.status);
  }
  const actual = req.headers.get("x-vectant-admin-token") || "";
  if (!constantTimeStringEqual(actual, expected)) {
    const denied = deniedJson("admin_token_invalid", "Local Support admin token was not accepted.");
    return jsonNoStore(denied.body, 401);
  }
  return null;
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

function parseAdminStateEnv() {
  try {
    const parsed = JSON.parse(process.env.VECTANT_LOCAL_SUPPORT_ADMIN_STATE_JSON || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}
