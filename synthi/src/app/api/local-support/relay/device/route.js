import { createHash } from "node:crypto";

import { NextResponse } from "next/server";

import { authenticateLocalSupportDevice } from "@/lib/local-support/deviceAuth";
import {
  leaseLocalControlCommand,
  leaseRelayRequest,
  recordLocalControlOutcome,
  recordRelayOutcome,
} from "@/lib/local-support/relayStore";
import { updatePairedSessionPorts } from "@/lib/local-support/sessionStore";

export const runtime = "nodejs";

const PATH = "/api/local-support/relay/device";
const MAX_BODY_BYTES = 16 * 1024;
const POLL_FIELDS = new Set(["action"]);
const STATUS_FIELDS = new Set(["action", "ports"]);
const OUTCOME_FIELDS = new Set([
  "action", "request_id", "lease_id", "decision", "bytes_sent",
  "redaction_count", "scanner_version", "reason",
]);
const CONTROL_OUTCOME_FIELDS = new Set([
  "action", "command_id", "lease_id", "decision", "reason",
]);

export async function POST(req) {
  const raw = Buffer.from(await req.arrayBuffer());
  if (raw.length === 0 || raw.length > MAX_BODY_BYTES) {
    return jsonNoStore(denied("invalid_device_request"), 400);
  }
  const bodySha256 = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  const authentication = await authenticateLocalSupportDevice(req, PATH, bodySha256);
  if (!authentication.ok) {
    const status = authentication.reason === "device_auth_unavailable" ? 503 : 403;
    return jsonNoStore(denied(authentication.reason), status);
  }

  let body;
  try {
    body = JSON.parse(raw.toString("utf8"));
  } catch {
    return jsonNoStore(denied("invalid_device_request"), 400);
  }
  if (!body || Array.isArray(body) || typeof body !== "object") {
    return jsonNoStore(denied("invalid_device_request"), 400);
  }

  if (body.action === "poll" && hasOnlyFields(body, POLL_FIELDS)) {
    let controlCommand;
    try {
      controlCommand = await leaseLocalControlCommand({
        sessionId: authentication.session.sessionId,
        deviceFingerprint: authentication.session.deviceFingerprint,
      });
    } catch {
      return jsonNoStore(denied("relay_unavailable"), 503);
    }
    if (controlCommand) {
      return jsonNoStore({
        decision: "relay_control_command",
        command: controlCommand,
        raw_body_included: false,
        bytes_sent: 0,
      });
    }

    let delivery;
    try {
      delivery = await leaseRelayRequest({
        sessionId: authentication.session.sessionId,
        deviceFingerprint: authentication.session.deviceFingerprint,
      });
    } catch {
      return jsonNoStore(denied("relay_unavailable"), 503);
    }
    return jsonNoStore(delivery
      ? { decision: "relay_delivery", delivery, raw_body_included: false, bytes_sent: 0 }
      : { decision: "relay_idle", raw_body_included: false, bytes_sent: 0 });
  }

  if (body.action === "control_outcome" && validControlOutcome(body)
    && hasOnlyFields(body, CONTROL_OUTCOME_FIELDS)) {
    let outcome;
    try {
      outcome = await recordLocalControlOutcome({
        commandId: body.command_id,
        leaseId: body.lease_id,
        sessionId: authentication.session.sessionId,
        deviceFingerprint: authentication.session.deviceFingerprint,
        decision: body.decision,
        reason: body.reason,
      });
    } catch {
      return jsonNoStore(denied("relay_unavailable"), 503);
    }
    if (!outcome) return jsonNoStore(denied("control_lease_invalid"), 409);
    return jsonNoStore({ ...outcome, raw_body_included: false });
  }

  if (body.action === "status" && hasOnlyFields(body, STATUS_FIELDS) && Array.isArray(body.ports)) {
    let updated;
    try {
      updated = await updatePairedSessionPorts(
        authentication.session.sessionId,
        authentication.session.deviceFingerprint,
        body.ports,
      );
    } catch {
      return jsonNoStore(denied("relay_unavailable"), 503);
    }
    return jsonNoStore(updated
      ? { decision: "status_recorded", raw_body_included: false, bytes_sent: 0 }
      : denied("invalid_port_status"), updated ? 200 : 400);
  }

  if (body.action === "outcome" && validOutcome(body) && hasOnlyFields(body, OUTCOME_FIELDS)) {
    let outcome;
    try {
      outcome = await recordRelayOutcome({
        requestId: body.request_id,
        leaseId: body.lease_id,
        sessionId: authentication.session.sessionId,
        deviceFingerprint: authentication.session.deviceFingerprint,
        decision: body.decision,
        bytesSent: body.bytes_sent,
        redactionCount: body.redaction_count,
        scannerVersion: body.scanner_version,
        reason: body.reason,
      });
    } catch {
      return jsonNoStore(denied("relay_unavailable"), 503);
    }
    if (!outcome) return jsonNoStore(denied("relay_lease_invalid"), 409);
    return jsonNoStore({ ...outcome, raw_body_included: false });
  }

  return jsonNoStore(denied("invalid_device_request"), 400);
}

function validOutcome(body) {
  return safeId(body.request_id)
    && typeof body.lease_id === "string" && /^[0-9a-f-]{16,64}$/i.test(body.lease_id)
    && ["sent", "denied", "review_pending"].includes(body.decision)
    && Number.isSafeInteger(body.bytes_sent) && body.bytes_sent >= 0
    && Number.isSafeInteger(body.redaction_count) && body.redaction_count >= 0
    && typeof body.scanner_version === "string" && body.scanner_version.length <= 128
    && typeof body.reason === "string" && body.reason.length <= 256;
}

function validControlOutcome(body) {
  return safeId(body.command_id)
    && typeof body.lease_id === "string" && /^[0-9a-f-]{16,64}$/i.test(body.lease_id)
    && ["applied", "denied"].includes(body.decision)
    && typeof body.reason === "string" && body.reason.length <= 256;
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
}

function hasOnlyFields(body, allowed) {
  return Object.keys(body).every((key) => allowed.has(key));
}

function denied(reason) {
  return { decision: "denied", reason, raw_body_included: false, bytes_sent: 0 };
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
}
