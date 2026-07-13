import { NextResponse } from "next/server";

import { deniedJson, isSameOriginRequest, readBoundedJson } from "@/app/api/local-support/httpGuards";
import {
  buildTransparencyActionDecision,
} from "@/lib/local-support/controlPlane";
import { readDurableLocalSupportPolicy } from "@/lib/local-support/policyStore";

export const runtime = "nodejs";

export async function POST(req) {
  if (!isSameOriginRequest(req)) {
    const denied = deniedJson("bad_origin", "Request origin was not accepted.");
    return jsonNoStore(denied.body, denied.status);
  }

  const bodyResult = await readBoundedJson(req);
  if (!bodyResult.ok) {
    const denied = deniedJson(
      bodyResult.reason,
      bodyResult.message || "Request body was not accepted.",
      bodyResult.status,
    );
    return jsonNoStore(denied.body, denied.status);
  }

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

  if (process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL
    && !buildLocalDaemonUrl(process.env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL, "/v1/status")) {
    return jsonNoStore(
      deniedBody("local_daemon_url_not_loopback", "Local daemon URL was rejected because it was not loopback HTTP."),
      403,
    );
  }

  const localStatus = await readLocalDaemonStatus();
  const currentState = localStatus?.state || {};
  const decision = buildTransparencyActionDecision(
    bodyResult.value,
    currentState,
    policy,
  );
  if (decision.decision === "denied") {
    return jsonNoStore(decision, 403);
  }

  const forwarded = await forwardLocalDaemonAction(bodyResult.value, decision, localStatus);
  if (forwarded) {
    return jsonNoStore(forwarded.body, forwarded.status);
  }

  return jsonNoStore(decision, 200);
}

function jsonNoStore(body, status = 200) {
  return NextResponse.json(body, {
    status,
    headers: {
      "Cache-Control": "no-store",
    },
  });
}

async function readLocalDaemonStatus(env = process.env) {
  const statusUrl = buildLocalDaemonUrl(env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL, `/v1/status/web_${Date.now().toString(36)}`);
  if (!statusUrl || !env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER) return null;
  try {
    const response = await fetch(statusUrl, {
      method: "GET",
      cache: "no-store",
      headers: localDaemonHeaders(env, false),
    });
    if (!response.ok) return null;
    const status = await response.json();
    const session = status?.session && typeof status.session === "object" ? status.session : {};
    const workspace = status?.workspace && typeof status.workspace === "object" ? status.workspace : {};
    const ports = Array.isArray(status?.ports) ? status.ports : [];
    return {
      raw: status,
      state: {
        session: {
          connected: Boolean(session.session_id),
          paused: session.paused === true,
          session_id: session.session_id,
          account_id: session.account_id,
          org_id: session.org_id,
          device_fingerprint: session.device_fingerprint,
        },
        workspace: {
          workspace_id: workspace.workspace_id,
          display: workspace.display,
        },
        ports: ports.map((port) => ({
          port: port.port,
          preview_host: port.preview_host,
          revoked: false,
        })),
      },
    };
  } catch {
    return null;
  }
}

async function forwardLocalDaemonAction(body, decision, localStatus, env = process.env) {
  if (!localStatus) return null;
  if (!env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER || !env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET) {
    return {
      status: 503,
      body: deniedBody("local_daemon_control_unavailable", "Local daemon control credentials are unavailable."),
    };
  }
  const action = decision.action;
  const requestId = `web_${action}_${Date.now().toString(36)}`;
  const endpoint = localDaemonActionPath(action, body, requestId);
  if (!endpoint) {
    return {
      status: 400,
      body: deniedBody("invalid_local_daemon_action", "The requested local action was not recognized."),
    };
  }
  const url = buildLocalDaemonUrl(env.VECTANT_LOCAL_SUPPORT_LOCAL_API_URL, endpoint.path);
  if (!url) {
    return {
      status: 403,
      body: deniedBody("local_daemon_url_not_loopback", "Local daemon URL was rejected because it was not loopback HTTP."),
    };
  }
  try {
    const response = await fetch(url, {
      method: endpoint.method,
      cache: "no-store",
      headers: localDaemonHeaders(env, endpoint.hasJsonBody),
      body: endpoint.body ? JSON.stringify(endpoint.body) : undefined,
    });
    const daemonBody = await response.json().catch(() => ({}));
    if (!response.ok || daemonBody.decision === "denied") {
      return {
        status: response.ok ? 403 : response.status,
        body: {
          ...deniedBody(
            daemonBody.reason || "local_daemon_action_denied",
            scrubLocalDaemonMessage(daemonBody.user_visible_message || "Local daemon rejected this action."),
          ),
          local_daemon_forwarded: true,
        },
      };
    }
    return {
      status: 200,
      body: sanitizeLocalDaemonActionResponse(decision, daemonBody),
    };
  } catch {
    return {
      status: 502,
      body: {
        ...deniedBody("local_daemon_unreachable", "Local daemon could not be reached for this action."),
        local_daemon_forwarded: false,
      },
    };
  }
}

function localDaemonActionPath(action, body, requestId) {
  if (action === "enable_fast_support") return { method: "POST", path: `/v1/session/fast-support/${requestId}`, body: { enabled: true } };
  if (action === "disable_fast_support") return { method: "POST", path: `/v1/session/fast-support/${requestId}`, body: { enabled: false } };
  if (action === "pause_session") return { method: "POST", path: `/v1/session/pause/${requestId}` };
  if (action === "resume_session") return { method: "POST", path: `/v1/session/resume/${requestId}` };
  if (action === "disconnect_session") return { method: "POST", path: `/v1/session/disconnect/${requestId}` };
  if (action === "revoke_session_approvals") return { method: "POST", path: `/v1/approval/revoke-all/${requestId}` };
  if (action === "export_history") return { method: "GET", path: `/v1/history/export/${requestId}` };
  if (action === "delete_history") return { method: "POST", path: `/v1/history/delete/${requestId}` };
  if (action === "revoke_port") {
    const port = Number(body?.port);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
    return { method: "POST", path: `/v1/port/revoke/${port}/${requestId}` };
  }
  return null;
}

function buildLocalDaemonUrl(baseUrl, path) {
  let url;
  try {
    url = new URL(baseUrl || "");
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !isLoopbackHostname(url.hostname)) return null;
  url.username = "";
  url.password = "";
  url.hash = "";
  url.pathname = path;
  url.search = "";
  return url.toString();
}

function localDaemonHeaders(env, hasJsonBody) {
  const headers = {
    origin: "https://app.vectant.dev",
    "sec-fetch-site": "same-site",
    "x-vectant-csrf": env.VECTANT_LOCAL_SUPPORT_LOCAL_CSRF || "csrf_local_control_request_000",
    authorization: `Bearer ${env.VECTANT_LOCAL_SUPPORT_LOCAL_BEARER}`,
  };
  if (env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET) {
    headers["x-vectant-local-control-secret"] = env.VECTANT_LOCAL_SUPPORT_LOCAL_CONTROL_SECRET;
  }
  if (hasJsonBody) headers["content-type"] = "application/json";
  return headers;
}

function isLoopbackHostname(hostname) {
  const host = String(hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "[::1]") return true;
  if (/^127\.(?:\d{1,3}\.){2}\d{1,3}$/.test(host)) {
    return host.split(".").every((part) => Number(part) >= 0 && Number(part) <= 255);
  }
  return false;
}

function sanitizeLocalDaemonActionResponse(decision, daemonBody) {
  const body = {
    ...decision,
    decision: "local_control_action_applied",
    local_daemon_forwarded: true,
    daemon_decision: String(daemonBody.decision || "ok").slice(0, 80),
    bytes_sent: 0,
    raw_body_included: false,
  };
  if (decision.action === "export_history") {
    body.export = {
      export_version: String(daemonBody.export_version || ""),
      raw_bodies_included: daemonBody.raw_bodies_included === true,
      retention_days: Number.isFinite(Number(daemonBody.retention_days)) ? Number(daemonBody.retention_days) : 0,
      events_count: Array.isArray(daemonBody.events) ? daemonBody.events.length : 0,
      consent_receipts_count: Array.isArray(daemonBody.consent_receipts) ? daemonBody.consent_receipts.length : 0,
      root_hash: typeof daemonBody.root_hash === "string" ? daemonBody.root_hash : null,
    };
  }
  return body;
}

function deniedBody(reason, message) {
  return {
    decision: "denied",
    reason,
    bytes_sent: 0,
    user_visible_message: message,
  };
}

function scrubLocalDaemonMessage(value) {
  return String(value || "")
    .replace(/authorization:\s*(bearer|basic)\s+[^\s]+/gi, "authorization: [REDACTED]")
    .replace(/\b(cookie|set-cookie):\s*[^\n\r]+/gi, "$1: [REDACTED]")
    .replace(/\b(postgres|postgresql|mysql|mongodb|redis):\/\/[^\s'\"<>]+/gi, "[REDACTED:database_url]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws_access_key]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:openai_api_key]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED:github_token]")
    .slice(0, 240);
}
