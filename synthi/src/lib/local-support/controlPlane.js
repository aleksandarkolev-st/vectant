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

export function readLocalSupportPolicy(env = process.env) {
  const globalEnabled = env.VECTANT_LOCAL_SUPPORT_ENABLED === "true";
  const orgKillSwitch = env.VECTANT_LOCAL_SUPPORT_ORG_DISABLED === "true";
  const previewEnabled = env.VECTANT_LOCAL_SUPPORT_PREVIEW_ENABLED !== "false";
  const minAppVersion = env.VECTANT_LOCAL_SUPPORT_MIN_APP_VERSION || DEFAULT_MIN_APP_VERSION;
  const allowFastSupport = env.VECTANT_LOCAL_SUPPORT_FAST_SUPPORT_ENABLED === "true";
  const agentPreviewReadEnabled = env.VECTANT_LOCAL_SUPPORT_AGENT_PREVIEW_READ_ENABLED === "true";

  return {
    enabled: globalEnabled && !orgKillSwitch,
    global_enabled: globalEnabled,
    org_kill_switch: orgKillSwitch,
    min_app_version: minAppVersion,
    policy_version: POLICY_VERSION,
    protocol_version: LOCAL_SUPPORT_PROTOCOL,
    mvp: {
      balanced_mode_default: true,
      manual_mode_available: true,
      fast_support_enabled: allowFastSupport,
      agent_read_enabled: false,
      agent_interaction_enabled: false,
      agent_preview_read_enabled: agentPreviewReadEnabled,
      browser_preview_enabled: previewEnabled,
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
