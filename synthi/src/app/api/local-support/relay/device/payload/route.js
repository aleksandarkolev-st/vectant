import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { authenticateLocalSupportDevice } from "@/lib/local-support/deviceAuth";
import {
  denyReviewedRelayRequest,
  storeApprovedRelayPayload,
} from "@/lib/local-support/relayPayloadStore";
import { readDurableLocalSupportPolicy } from "@/lib/local-support/policyStore";

export const runtime = "nodejs";

const PATH = "/api/local-support/relay/device/payload";
const MAX_UPLOAD_BODY_BYTES = 384 * 1024;
const ALLOWED_FIELDS = new Set([
  "action", "request_id", "content", "content_sha256", "redaction_count", "scanner_version",
]);
const DENIAL_FIELDS = new Set(["action", "request_id", "reason"]);

export async function POST(req) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length === 0 || raw.length > MAX_UPLOAD_BODY_BYTES) {
    return jsonNoStore(denied("invalid_payload_upload"), 413);
  }
  const bodySha256 = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const authentication = await authenticateLocalSupportDevice(req, PATH, bodySha256);
  if (!authentication.ok) {
    return jsonNoStore(
      denied(authentication.reason),
      authentication.reason === "device_auth_unavailable" ? 503 : 403,
    );
  }
  let policy;
  try {
    policy = await readDurableLocalSupportPolicy(
      process.env,
      undefined,
      authentication.session.orgId,
    );
  } catch {
    return jsonNoStore(denied("policy_store_unavailable"), 503);
  }
  if (!policy.enabled) return jsonNoStore(denied("feature_disabled"), 403);

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return jsonNoStore(denied("invalid_payload_upload"), 400);
  }
  if (!body || Array.isArray(body) || typeof body !== "object"
    || (!validUpload(body) && !validDenial(body))) {
    return jsonNoStore(denied("invalid_payload_upload"), 400);
  }

  try {
    if (validDenial(body)) {
      const result = await denyReviewedRelayRequest({
        requestId: body.request_id,
        sessionId: authentication.session.sessionId,
        deviceFingerprint: authentication.session.deviceFingerprint,
      });
      if (!result) return jsonNoStore(denied("payload_request_not_pending"), 409);
      return jsonNoStore({ ...result, raw_body_included: false });
    }
    const result = await storeApprovedRelayPayload({
      requestId: body.request_id,
      sessionId: authentication.session.sessionId,
      deviceFingerprint: authentication.session.deviceFingerprint,
      content: body.content,
      contentSha256: body.content_sha256,
      redactionCount: body.redaction_count,
      scannerVersion: body.scanner_version,
    });
    if (!result) return jsonNoStore(denied("payload_request_not_pending"), 409);
    return jsonNoStore({ ...result, raw_body_included: false });
  } catch {
    return jsonNoStore(denied("relay_unavailable"), 503);
  }
}

function validDenial(body) {
  return Object.keys(body).every((key) => DENIAL_FIELDS.has(key))
    && body.action === "deny"
    && typeof body.request_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(body.request_id)
    && body.reason === "local_user_denied";
}

function validUpload(body) {
  return body && !Array.isArray(body) && typeof body === "object"
    && Object.keys(body).every((key) => ALLOWED_FIELDS.has(key))
    && body.action === "upload"
    && typeof body.request_id === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(body.request_id)
    && typeof body.content === "string" && Buffer.byteLength(body.content, "utf8") <= 256 * 1024
    && /^sha256:[0-9a-f]{64}$/i.test(body.content_sha256 || "")
    && Number.isSafeInteger(body.redaction_count) && body.redaction_count >= 0
    && typeof body.scanner_version === "string" && body.scanner_version.length <= 128;
}

function denied(reason) {
  return { decision: "denied", reason, raw_body_included: false, bytes_sent: 0 };
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
