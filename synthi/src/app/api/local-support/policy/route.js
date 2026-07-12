import { NextResponse } from "next/server";

import { readDurableLocalSupportPolicy } from "@/lib/local-support/policyStore";

export const runtime = "nodejs";

export async function GET() {
  let policy;
  try {
    policy = await readDurableLocalSupportPolicy();
  } catch {
    return NextResponse.json({
      enabled: false,
      decision: "denied",
      reason: "policy_store_unavailable",
      bytes_sent: 0,
      user_visible_message: "Local Support policy is unavailable and requests are disabled.",
    }, { status: 503, headers: { "Cache-Control": "no-store" } });
  }
  return NextResponse.json({
    ...policy,
    user_visible_message: policy.enabled
      ? "Local Support is available for this organization. The local app still enforces every request."
      : policy.disabled_reason || "Local Support is disabled by organization, emergency, or global policy.",
  }, {
    headers: {
      "Cache-Control": "no-store",
    },
  });
}
