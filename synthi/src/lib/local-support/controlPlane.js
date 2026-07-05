import { createHmac, timingSafeEqual } from "node:crypto";

export const LOCAL_SUPPORT_PROTOCOL = "local-support-mvp.1";
export const DEFAULT_MIN_APP_VERSION = "0.1.0";
export const POLICY_VERSION = "2026.07.05";

const MVP_ALLOWED_CAPABILITIES = new Set([
  "workspace.file.source.read",
  "workspace.log.read",
  "workspace.metadata.read",
  "workspace.git.status.read",
  "localhost.preview.browser",
]);

const DISALLOWED_ACTOR_CAPABILITIES = new Set([
  "localhost.preview.agent_read",
  "localhost.preview.support_agent_read",
  "localhost.preview.agent_interact",
  "localhost.preview.response_body",
  "localhost.preview.screenshot",
  "browser.console.read",
  "browser.network_summary.read",
  "workspace.file.write",
  "workspace.command.execute",
  "workspace.repo.upload",
]);

const SECURITY_EVENT_TYPES = new Set([
  "bad_origin",
  "path_traversal",
  "denied_secret_request",
  "pairing_failed",
  "preview_redirect_blocked",
  "app_version_too_old",
  "rate_limit_exceeded",
  "scanner_failure",
  "suspicious_support_request",
]);

export const POLICY_PRECEDENCE = [
  "hardcoded_safety_baseline",
  "emergency_remote_kill_switch",
  "enterprise_org_policy",
  "workspace_policy",
  "user_global_setting",
  "current_session_mode",
  "item_specific_approval",
  "final_scanner_redactor_decision",
];

export function readLocalSupportPolicy(env = process.env) {
  const globalEnabled = env.VECTANT_LOCAL_SUPPORT_ENABLED === "true";
  const orgKillSwitch = env.VECTANT_LOCAL_SUPPORT_ORG_DISABLED === "true";
  const previewEnabled = env.VECTANT_LOCAL_SUPPORT_PREVIEW_ENABLED !== "false";
  const previewGatewayDisabled = env.VECTANT_LOCAL_SUPPORT_PREVIEW_GATEWAY_DISABLED === "true";
  const pairingDisabled = env.VECTANT_LOCAL_SUPPORT_PAIRING_DISABLED === "true";
  const minAppVersion = env.VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION || DEFAULT_MIN_APP_VERSION;
  const disabledReason = env.VECTANT_LOCAL_SUPPORT_DISABLED_REASON || null;
  const allowFastSupport = env.VECTANT_LOCAL_SUPPORT_FAST_SUPPORT_ENABLED === "true";
  const agentPreviewReadEnabled = env.VECTANT_LOCAL_SUPPORT_AGENT_PREVIEW_READ_ENABLED === "true";
  const vulnerableVersions = parseCsv(env.VECTANT_LOCAL_SUPPORT_VULNERABLE_VERSIONS);
  const noRetention = env.VECTANT_LOCAL_SUPPORT_NO_RETENTION === "true";
  const retentionDays = noRetention
    ? 0
    : clampNumber(env.VECTANT_LOCAL_SUPPORT_RETENTION_DAYS, 1, 90, 30);

  return {
    enabled: globalEnabled && !orgKillSwitch && !pairingDisabled,
    global_enabled: globalEnabled,
    org_kill_switch: orgKillSwitch,
    pairing_disabled: pairingDisabled,
    disabled_reason: disabledReason,
    min_app_version: minAppVersion,
    vulnerable_versions: vulnerableVersions,
    policy_version: POLICY_VERSION,
    protocol_version: LOCAL_SUPPORT_PROTOCOL,
    retention: {
      no_retention: noRetention,
      local_activity_days: retentionDays,
      cloud_security_event_days: retentionDays,
      raw_bodies_allowed: false,
      export_available: true,
    },
    emergency_controls: {
      feature_disabled: !globalEnabled,
      org_disabled: orgKillSwitch,
      preview_gateway_disabled: previewGatewayDisabled,
      pairing_disabled: pairingDisabled,
      agent_access_disabled: true,
      vulnerable_version_blocklist: vulnerableVersions,
      update_revocation_supported: true,
    },
    mvp: {
      balanced_mode_default: true,
      manual_mode_available: true,
      fast_support_enabled: allowFastSupport,
      agent_read_enabled: false,
      agent_interaction_enabled: false,
      agent_preview_read_enabled: agentPreviewReadEnabled,
      browser_preview_enabled: previewEnabled && !previewGatewayDisabled,
      persistent_port_approvals: false,
      shell_commands: false,
      file_writes: false,
      repo_upload: false,
    },
    allowed_capabilities: [...MVP_ALLOWED_CAPABILITIES],
  };
}

export function evaluatePolicyPrecedence(layers = {}) {
  for (const layerName of POLICY_PRECEDENCE) {
    const layer = normalizePolicyLayer(layers[layerName]);
    if (layer.decision === "denied") {
      return {
        ...deny(`blocked_by_${layerName}`, layer.message || "A higher-priority policy layer blocked this request."),
        blocked_layer: layerName,
        precedence: POLICY_PRECEDENCE,
      };
    }
  }

  const itemApproval = normalizePolicyLayer(layers.item_specific_approval);
  const finalScan = normalizePolicyLayer(layers.final_scanner_redactor_decision);
  const approved = itemApproval.decision === "approved" && finalScan.decision === "allow";
  return {
    decision: approved ? "allowed_after_local_checks" : "approval_required",
    reason: approved ? "all_policy_layers_allowed" : "item_approval_or_scanner_review_required",
    policy_version: POLICY_VERSION,
    bytes_sent: 0,
    local_enforcement_required: true,
    blocked_layer: null,
    precedence: POLICY_PRECEDENCE,
  };
}

export function signRequestEnvelope(envelope, secret) {
  if (!secret || typeof secret !== "string") {
    throw new Error("request envelope signing secret is required");
  }
  return `sha256=${createHmac("sha256", secret).update(canonicalizeEnvelope(envelope)).digest("hex")}`;
}

export function verifyRequestEnvelopeSignature(envelope, secret) {
  if (!secret || typeof secret !== "string") {
    return deny("request_envelope_signing_unconfigured", "Request envelope signing is not configured.");
  }
  const signature = typeof envelope?.signature === "string" ? envelope.signature : "";
  if (!signature.startsWith("sha256=")) {
    return deny("request_envelope_signature_missing", "Request envelope signature is required.");
  }

  const expected = signRequestEnvelope(envelope, secret);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return deny("request_envelope_signature_invalid", "Request envelope signature did not match.");
  }

  return {
    decision: "verified",
    reason: "request_envelope_signature_valid",
    policy_version: POLICY_VERSION,
    bytes_sent: 0,
    local_enforcement_required: true,
  };
}

export function compareSemverLike(left, right) {
  const parse = (value) => String(value || "0")
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .map((value) => (Number.isFinite(value) ? value : 0));
  const a = parse(left);
  const b = parse(right);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const av = a[index] || 0;
    const bv = b[index] || 0;
    if (av > bv) return 1;
    if (av < bv) return -1;
  }
  return 0;
}

export function validateRequestEnvelope(input, policy = readLocalSupportPolicy()) {
  const request = input && typeof input === "object" ? input : {};
  if (!policy.enabled) {
    return deny("feature_disabled", "Local Support is disabled by policy.");
  }
  const required = ["request_id", "session_id", "workspace_id", "capability", "actor", "expires_at", "app_version"];
  for (const field of required) {
    if (!request[field] || typeof request[field] !== "string") {
      return deny("invalid_schema", `${field} is required.`);
    }
  }
  if (compareSemverLike(request.app_version, policy.min_app_version) < 0) {
    return deny("app_version_too_old", "Update required before pairing or requests can continue.");
  }
  if (policy.vulnerable_versions?.includes(request.app_version)) {
    return deny("app_version_blocked", "This local app version was revoked for security reasons.");
  }
  const expiresAt = Date.parse(request.expires_at);
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    return deny("expired_request", "The request envelope expired.");
  }
  if (DISALLOWED_ACTOR_CAPABILITIES.has(request.capability)) {
    return deny("capability_blocked_in_mvp", "This capability is outside the Local Support MVP.");
  }
  if (!MVP_ALLOWED_CAPABILITIES.has(request.capability)) {
    return deny("capability_not_allowed", "The requested capability is not allowed.");
  }
  if (request.capability === "localhost.preview.browser" && !policy.mvp.browser_preview_enabled) {
    return deny("preview_disabled", "Browser preview is disabled by policy.");
  }
  if (request.actor === "vectant_ai" && request.capability === "localhost.preview.browser") {
    return deny("agent_preview_read_separate_permission_required", "Browser preview does not allow AI page reading.");
  }
  if (!["vectant_ai", "support_agent", "user_browser"].includes(request.actor)) {
    return deny("actor_not_allowed", "The actor is not allowed for this session.");
  }
  return {
    decision: "approval_required",
    reason: "local_policy_and_user_review_required",
    policy_version: policy.policy_version,
    protocol_version: policy.protocol_version,
    bytes_sent: 0,
    local_enforcement_required: true,
    user_visible_message: "The local app must re-check policy and show review before any data is sent.",
  };
}

export function summarizeSecurityEvent(input, policy = readLocalSupportPolicy()) {
  const event = input && typeof input === "object" ? input : {};
  const eventType = typeof event.event_type === "string" ? event.event_type : "";
  if (!SECURITY_EVENT_TYPES.has(eventType)) {
    return deny("invalid_security_event_type", "Security event type is not accepted.");
  }
  const count = Number.isFinite(Number(event.count)) ? Math.max(1, Math.min(Number(event.count), 100)) : 1;
  const severity = severityForEvent(eventType, count);
  const target = scrubTelemetryValue(event.target || event.path || event.url || "");

  return {
    accepted: true,
    decision: "recorded",
    event_type: eventType,
    severity,
    alert: severity === "high" || severity === "critical",
    count,
    policy_version: policy.policy_version,
    raw_body_included: false,
    retention_days: policy.retention?.cloud_security_event_days ?? 30,
    session_id: scrubTelemetryValue(event.session_id || ""),
    request_id: scrubTelemetryValue(event.request_id || ""),
    target_display: target,
    user_visible_message: "Security event recorded without raw local content.",
  };
}

function deny(reason, message) {
  return {
    decision: "denied",
    reason,
    policy_version: POLICY_VERSION,
    bytes_sent: 0,
    local_enforcement_required: true,
    user_visible_message: message,
  };
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function clampNumber(value, min, max, fallback) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(Math.trunc(parsed), max));
}

function normalizePolicyLayer(value) {
  if (value === true || value === "allow" || value === "approved") {
    return { decision: value === "approved" ? "approved" : "allow" };
  }
  if (value === false || value === "deny" || value === "denied") {
    return { decision: "denied" };
  }
  if (value && typeof value === "object") {
    return {
      decision: value.decision || (value.allowed === false ? "denied" : "allow"),
      message: value.message || value.reason || null,
    };
  }
  return { decision: "allow" };
}

function canonicalizeEnvelope(value) {
  return JSON.stringify(canonicalValue(value, new Set(["signature"])));
}

function canonicalValue(value, excludedKeys = new Set()) {
  if (Array.isArray(value)) {
    return value.map((item) => canonicalValue(item, excludedKeys));
  }
  if (value && typeof value === "object") {
    return Object.keys(value)
      .filter((key) => !excludedKeys.has(key))
      .sort()
      .reduce((acc, key) => {
        acc[key] = canonicalValue(value[key], excludedKeys);
        return acc;
      }, {});
  }
  return value;
}

function severityForEvent(eventType, count) {
  if (eventType === "scanner_failure") return "critical";
  if (["path_traversal", "denied_secret_request", "preview_redirect_blocked"].includes(eventType)) {
    return count >= 3 ? "critical" : "high";
  }
  if (["rate_limit_exceeded", "suspicious_support_request", "pairing_failed"].includes(eventType)) {
    return count >= 5 ? "high" : "medium";
  }
  return "low";
}

function scrubTelemetryValue(value) {
  return String(value || "")
    .replace(/authorization:\s*(bearer|basic)\s+[^\s]+/gi, "authorization: [REDACTED]")
    .replace(/\b(cookie|set-cookie):\s*[^\n\r]+/gi, "$1: [REDACTED]")
    .replace(/\b(postgres|postgresql|mysql|mongodb|redis):\/\/[^\s'"<>]+/gi, "[REDACTED:database_url]")
    .replace(/AKIA[0-9A-Z]{16}/g, "[REDACTED:aws_access_key]")
    .replace(/sk-[A-Za-z0-9_-]{20,}/g, "[REDACTED:openai_api_key]")
    .replace(/gh[pousr]_[A-Za-z0-9_]{20,}/g, "[REDACTED:github_token]")
    .slice(0, 240);
}
