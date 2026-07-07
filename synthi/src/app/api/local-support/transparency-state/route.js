import { NextResponse } from "next/server";

import { readLocalSupportPolicy, summarizeTransparencyState } from "@/lib/local-support/controlPlane";

export const runtime = "nodejs";

export async function GET() {
  return jsonNoStore(summarizeTransparencyState(parseTransparencyStateEnv(), readLocalSupportPolicy()));
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
