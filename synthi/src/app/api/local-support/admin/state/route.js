import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import { constantTimeStringEqual, summarizeAdminState } from "@/lib/local-support/controlPlane";
import {
  readDurableAdminState,
  recordDurableAdminRevocation,
} from "@/lib/local-support/adminStore";
import {
  readDurableLocalSupportPolicy,
  updateDurableLocalSupportPolicy,
} from "@/lib/local-support/policyStore";

export const runtime = "nodejs";

export async function GET(req) {
  const auth = authorizeAdmin(req);
  if (auth) return auth;
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return jsonNoStore(denied.body, denied.status);
  }

  try {
    const [state, policy] = await Promise.all([
      readDurableAdminState(),
      readDurableLocalSupportPolicy(process.env, undefined, new URL(req.url).searchParams.get("org_id")),
    ]);
    return jsonNoStore(summarizeAdminState(state, policy));
  } catch {
    return jsonNoStore({
      decision: "denied",
      reason: "admin_state_unavailable",
      raw_body_included: false,
      bytes_sent: 0,
    }, 503);
  }
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
    const denied = deniedJson(bodyResult.reason, bodyResult.message || "Request body was not accepted.", bodyResult.status);
    return jsonNoStore(denied.body, denied.status);
  }

  let decision;
  try {
    if (bodyResult.value.action === "update_policy") {
      decision = await updateDurableLocalSupportPolicy(bodyResult.value, "admin_api");
    } else {
      const policy = await readDurableLocalSupportPolicy();
      decision = await recordDurableAdminRevocation(bodyResult.value, policy);
    }
  } catch {
    return jsonNoStore({
      decision: "denied",
      reason: "admin_revocation_unavailable",
      raw_body_included: false,
      bytes_sent: 0,
    }, 503);
  }
  const status = decision.decision === "denied" ? 400 : 200;
  return jsonNoStore(decision, status);
}

function authorizeAdmin(req) {
  const expected = process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN;
  if (!expected) {
    const denied = deniedJson("admin_token_unconfigured", "Local Support admin access is not configured.");
    return jsonNoStore(denied.body, denied.status);
  }
  if (!isSafeAdminToken(expected)) {
    const denied = deniedJson("admin_token_misconfigured", "Local Support admin access is not configured safely.");
    return jsonNoStore(denied.body, denied.status);
  }
  const actual = req.headers.get("x-vectant-admin-token") || "";
  if (!isSafeAdminToken(actual) || !constantTimeStringEqual(actual, expected)) {
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

function isSafeAdminToken(value) {
  return typeof value === "string"
    && value.length >= 8
    && value.length <= 256
    && /^[\x21-\x7e]+$/.test(value);
}
