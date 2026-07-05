import { NextResponse } from "next/server";

import { readLocalSupportPolicy, summarizeSecurityEvent } from "@/lib/local-support/controlPlane";

export const runtime = "nodejs";

export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    return NextResponse.json(
      {
        decision: "denied",
        reason: "bad_origin",
        bytes_sent: 0,
        user_visible_message: "Request origin was not accepted.",
      },
      { status: 403 },
    );
  }

  const body = await req.json().catch(() => null);
  const result = summarizeSecurityEvent(body, readLocalSupportPolicy());
  const status = result.decision === "denied" ? 400 : 200;
  return NextResponse.json(result, { status });
}

function isSameOriginRequest(req) {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const url = new URL(req.url);
  return origin === `${url.protocol}//${url.host}`;
}
