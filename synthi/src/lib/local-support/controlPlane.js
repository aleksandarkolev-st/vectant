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
    retention_days: 30,
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
