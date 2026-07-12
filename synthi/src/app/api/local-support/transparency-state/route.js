import { NextResponse } from "next/server";
import { getServerSession } from "next-auth";

import { authOptions } from "@/app/auth";
import { summarizeTransparencyState } from "@/lib/local-support/controlPlane";
import { readDurableLocalSupportPolicy } from "@/lib/local-support/policyStore";
import { readCloudTransparencyState } from "@/lib/local-support/transparencyStore";

export const runtime = "nodejs";

export async function GET() {
  let policy;
  try {
    policy = await readDurableLocalSupportPolicy();
  } catch {
    return jsonNoStore({
      decision: "denied",
      reason: "policy_store_unavailable",
      raw_body_included: false,
      bytes_sent: 0,
    }, 503);
  }
  const localState = await readLocalDaemonTransparencyState();
  const session = await getServerSession(authOptions);
  const accountId = session?.user?.id || session?.user?.email || null;
  const cloudState = await readCloudTransparencyState(accountId);
  return jsonNoStore(summarizeTransparencyState(localState || cloudState, policy));
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

async function readLocalDaemonTransparencyState(env = process.env) {
  const baseUrl = env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL;
  const bearerToken = env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER;
  if (!baseUrl || !bearerToken) {
    return null;
  }

  const statusUrl = buildLocalStatusUrl(baseUrl);
  if (!statusUrl) {
    return {
      activity: [{
        class: "Denied",
        summary: "Local daemon status URL was rejected because it was not loopback HTTP.",
      }],
    };
  }

  try {
    const response = await fetch(statusUrl, {
      method: "GET",
      cache: "no-store",
      headers: {
        origin: "https://app.vectant.dev",
        "sec-fetch-site": "same-site",
        "x-vectant-csrf": env.VECTANT_LOCAL_SUPPORT_LOCAL_CSRF || "csrf_local_status_request_000000",
        authorization: `Bearer ${bearerToken}`,
      },
    });
    if (!response.ok) {
      return null;
    }
    const status = await response.json();
    return mapLocalDaemonStatus(status);
  } catch {
    return null;
  }
}

function buildLocalStatusUrl(baseUrl) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) {
    return null;
  }
  url.username = "";
  url.password = "";
  url.hash = "";
  url.pathname = `/v1/status/web_${Date.now().toString(36)}`;
  url.search = "";
  return url.toString();
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") {
    return true;
  }
  if (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) {
    return host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return false;
}

function mapLocalDaemonStatus(status) {
  const session = status?.session && typeof status.session === "object" ? status.session : {};
  const workspace = status?.workspace && typeof status.workspace === "object" ? status.workspace : {};
  const history = status?.history && typeof status.history === "object" ? status.history : {};
  const events = Array.isArray(history.events) ? history.events : [];
  const receipts = Array.isArray(history.consent_receipts) ? history.consent_receipts : [];
  const ports = Array.isArray(status?.ports) ? status.ports : [];

  return {
    scanner_version: workspace.scanner_version,
    session: {
      connected: typeof session.session_id === "string" && session.session_id.startsWith("sess_"),
      paused: session.paused === true,
      account_id: session.account_id,
      org_id: session.org_id,
      session_id: session.session_id,
      device_fingerprint: session.device_fingerprint,
      permission_mode: "Balanced mode",
    },
    workspace: {
      workspace_id: workspace.workspace_id,
      display: workspace.display,
    },
    sent_payloads: receipts.map((receipt) => ({
      request_id: receipt.request_id,
      actor: receipt.actor,
      target_display: receipt.target_display,
      target_hash: receipt.content_sha256,
      classification: receipt.classification,
      redaction_count: 0,
      bytes_sent: 0,
      reason: receipt.capability,
      at: receipt.granted_at,
    })),
    blocked_items: events
      .filter((event) => String(event.class || "").toLowerCase() === "denied")
      .map((event) => ({
        target: event.summary,
        reason: "denied_locally",
        classification: "L5",
        at: event.at,
      })),
    activity: events.map((event) => ({
      at: event.at,
      class: event.class,
      summary: event.summary,
    })),
    ports: ports.map((port) => ({
      port: port.port,
      target_host: port.target_host,
      preview_host: port.preview_host,
      process_hash: port.process_identity_hash,
      ttl: port.expires_at,
      browser: port.browser_preview_allowed,
      aiRead: port.agent_read_allowed,
      supportRead: port.support_agent_read_allowed,
      aiInteract: port.agent_interact_allowed,
      responseBodies: port.send_response_body_allowed,
      persistent: port.persistent,
      methods: port.state_changing_methods_allowed ? "GET, HEAD, state-changing allowed" : "GET, HEAD only",
      preview_token: port.preview_token,
    })),
    export_metadata: {
      raw_bodies_included: false,
      audit_chain_verified: events.every((event) => event.event_hash && event.previous_hash),
      session_id: session.session_id,
      workspace_display: workspace.display,
    },
  };
}
