import { NextResponse } from "next/server";

import { readLocalSupportPolicy } from "@/lib/local-support/controlPlane";

export const runtime = "nodejs";

export async function GET() {
  const policy = readLocalSupportPolicy();
  return NextResponse.json({
    ...policy,
    user_visible_message: policy.enabled
      ? "Local Support is available for this organization. The local app still enforces every request."
      : "Local Support is disabled by organization or global policy.",
  });
}
