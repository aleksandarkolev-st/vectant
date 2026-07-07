import { createHash, createHmac, createPublicKey, randomBytes, timingSafeEqual, verify as verifySignature } from "node:crypto";

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
  "old_version",
  "rate_limit_exceeded",
  "scanner_failure",
  "suspicious_support_request",
  "traffic_spike",
]);

const MAX_REPLAY_CACHE_ENTRIES = 5_000;
const replayCache = new Map();
const pairingSessions = new Map();
const revokedSessions = new Set();
const revokedDevices = new Set();
const PAIRING_TTL_MS = 5 * 60 * 1000;
const MAX_PAIRING_ATTEMPTS = 5;

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
  const allowedAccountId = env.VECTANT_LOCAL_SUPPORT_ACCOUNT_ID || null;
  const allowedOrgId = env.VECTANT_LOCAL_SUPPORT_ORG_ID || null;
  const allowedDeviceFingerprint = env.VECTANT_LOCAL_SUPPORT_DEVICE_FINGERPRINT || null;
  const disabledReason = env.VECTANT_LOCAL_SUPPORT_DISABLED_REASON || null;
  const allowFastSupport = env.VECTANT_LOCAL_SUPPORT_FAST_SUPPORT_ENABLED === "true";
  const agentPreviewReadEnabled = env.VECTANT_LOCAL_SUPPORT_AGENT_PREVIEW_READ_ENABLED === "true";
  const vulnerableVersions = parseCsv(env.VECTANT_LOCAL_SUPPORT_VULNERABLE_VERSIONS);
  const revokedSessionIds = parseCsv(env.VECTANT_LOCAL_SUPPORT_REVOKED_SESSIONS);
  const revokedDeviceFingerprints = parseCsv(env.VECTANT_LOCAL_SUPPORT_REVOKED_DEVICES);
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
    account_id: allowedAccountId,
    org_id: allowedOrgId,
    device_fingerprint: allowedDeviceFingerprint,
    vulnerable_versions: vulnerableVersions,
    revoked_sessions: revokedSessionIds,
    revoked_devices: revokedDeviceFingerprints,
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
      revoked_sessions: revokedSessionIds,
      revoked_devices: revokedDeviceFingerprints,
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

export function constantTimeStringEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") return false;
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

export function enforceRequestEnvelopeReplayProtection(envelope, nowMs = Date.now()) {
  const requestId = typeof envelope?.request_id === "string" ? envelope.request_id.trim() : "";
  const sessionId = typeof envelope?.session_id === "string" ? envelope.session_id.trim() : "";
  const expiresAt = Date.parse(envelope?.expires_at || "");
  if (!requestId || !sessionId || !Number.isFinite(expiresAt)) {
    return deny("request_replay_identity_invalid", "Request envelope replay identity is invalid.");
  }

  pruneReplayCache(nowMs);
  const cacheKey = `${sessionId}\0${requestId}`;
  if (replayCache.has(cacheKey)) {
    return deny("request_replay_detected", "This request envelope was already used.");
  }
  replayCache.set(cacheKey, expiresAt);
  if (replayCache.size > MAX_REPLAY_CACHE_ENTRIES) {
    const oldestKey = replayCache.keys().next().value;
    replayCache.delete(oldestKey);
  }
  return {
    decision: "accepted",
    reason: "request_replay_nonce_recorded",
    policy_version: POLICY_VERSION,
    bytes_sent: 0,
    local_enforcement_required: true,
  };
}

export function clearRequestEnvelopeReplayCache() {
  replayCache.clear();
}

export function clearPairingChallengeStore() {
  pairingSessions.clear();
}

export function clearAdminRevocationStore() {
  revokedSessions.clear();
  revokedDevices.clear();
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
  const required = [
    "request_id",
    "session_id",
    "account_id",
    "org_id",
    "workspace_id",
    "device_fingerprint",
    "device_proof",
    "capability",
    "actor",
    "expires_at",
    "app_version",
    "protocol_version",
    "policy_version",
  ];
  for (const field of required) {
    if (!request[field] || typeof request[field] !== "string") {
      return deny("invalid_schema", `${field} is required.`);
    }
  }
  for (const field of ["request_id", "session_id", "account_id", "org_id", "workspace_id"]) {
    if (!isSafeEnvelopeIdentifier(request[field])) {
      return deny("invalid_schema", `${field} is not an accepted identifier.`);
    }
  }
  if (!isSemverLike(request.app_version)) {
    return deny("invalid_schema", "app_version is not an accepted version.");
  }
  if (policy.account_id && request.account_id !== policy.account_id) {
    return deny("account_mismatch", "This support request is not for the paired account.");
  }
  if (policy.org_id && request.org_id !== policy.org_id) {
    return deny("org_mismatch", "This support request is not for the paired organization.");
  }
  if (policy.device_fingerprint && request.device_fingerprint !== policy.device_fingerprint) {
    return deny("device_mismatch", "This support request is not for the paired local device.");
  }
  if (isSessionRevoked(request.session_id, policy)) {
    return deny("session_revoked", "This support session was revoked.");
  }
  if (isDeviceRevoked(request.device_fingerprint, policy)) {
    return deny("device_revoked", "This local support device was revoked.");
  }
  if (!isSha256Hex(request.device_fingerprint, 16)) {
    return deny("device_fingerprint_invalid", "The device fingerprint was not accepted.");
  }
  if (!isSha256Hex(request.device_proof, 64)) {
    return deny("device_proof_invalid", "The device proof was not accepted.");
  }
  if (request.protocol_version !== policy.protocol_version) {
    return deny("protocol_version_mismatch", "This support request uses a stale local-support protocol.");
  }
  if (request.policy_version !== policy.policy_version) {
    return deny("policy_version_mismatch", "This support request was signed for a different policy version.");
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

export function createPairingChallenge(input, policy = readLocalSupportPolicy(), nowMs = Date.now()) {
  if (!policy.enabled) {
    return deny("feature_disabled", "Local Support pairing is disabled by policy.");
  }
  const body = input && typeof input === "object" ? input : {};
  const accountId = typeof body.account_id === "string" ? body.account_id : "";
  const orgId = typeof body.org_id === "string" ? body.org_id : "";
  const workspaceId = typeof body.workspace_id === "string" ? body.workspace_id : "";
  const browserSessionId = typeof body.browser_session_id === "string" ? body.browser_session_id : "";
  const requestedUserId = typeof body.requested_user_id === "string" ? body.requested_user_id : "";

  for (const value of [accountId, orgId, workspaceId, browserSessionId, requestedUserId]) {
    if (!isSafeEnvelopeIdentifier(value)) {
      return deny("invalid_pairing_schema", "Pairing request identifiers were not accepted.");
    }
  }
  if (policy.account_id && accountId !== policy.account_id) {
    return deny("account_mismatch", "This pairing request is not for the configured account.");
  }
  if (policy.org_id && orgId !== policy.org_id) {
    return deny("org_mismatch", "This pairing request is not for the configured organization.");
  }

  prunePairingSessions(nowMs);
  const code = randomPairingCode();
  const pairing = {
    pairing_id: `pair_${randomBytes(12).toString("hex")}`,
    code,
    fingerprint: pairingFingerprint(code),
    server_nonce: `nonce_${randomBytes(16).toString("hex")}`,
    browser_session_id: browserSessionId,
    requested_user_id: requestedUserId,
    account_id: accountId,
    org_id: orgId,
    workspace_id: workspaceId,
    expires_at_ms: nowMs + PAIRING_TTL_MS,
    attempts: 0,
    consumed: false,
  };
  pairingSessions.set(pairing.pairing_id, pairing);

  return {
    decision: "pairing_challenge_created",
    reason: "confirm_pairing_code_and_fingerprint_locally",
    pairing_id: pairing.pairing_id,
    code,
    fingerprint: pairing.fingerprint,
    server_nonce: pairing.server_nonce,
    browser_session_id: browserSessionId,
    requested_user_id: requestedUserId,
    account_id: accountId,
    org_id: orgId,
    workspace_id: workspaceId,
    expires_at: new Date(pairing.expires_at_ms).toISOString(),
    expires_in_seconds: Math.trunc(PAIRING_TTL_MS / 1000),
    raw_body_included: false,
    bytes_sent: 0,
    policy_version: policy.policy_version,
    protocol_version: policy.protocol_version,
    user_visible_message: "Confirm this code and fingerprint in the local desktop app before pairing.",
  };
}

export function completePairingChallenge(input, policy = readLocalSupportPolicy(), nowMs = Date.now()) {
  if (!policy.enabled) {
    return deny("feature_disabled", "Local Support pairing is disabled by policy.");
  }
  prunePairingSessions(nowMs);
  const body = input && typeof input === "object" ? input : {};
  const pairingId = typeof body.pairing_id === "string" ? body.pairing_id : "";
  const code = typeof body.code === "string" ? body.code : "";
  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint : "";
  const proof = body.proof && typeof body.proof === "object" ? body.proof : null;
  const pairing = pairingSessions.get(pairingId);
  if (!pairing || !proof) {
    return deny("pairing_challenge_not_found", "Pairing challenge was not found or already expired.");
  }

  pairing.attempts += 1;
  if (pairing.attempts > MAX_PAIRING_ATTEMPTS) {
    return deny("pairing_rate_limited", "Too many pairing attempts. Start a new pairing challenge.");
  }
  if (pairing.consumed) {
    return deny("pairing_code_consumed", "This pairing code was already used.");
  }
  if (nowMs > pairing.expires_at_ms) {
    pairingSessions.delete(pairingId);
    return deny("pairing_code_expired", "This pairing code expired.");
  }
  if (!constantTimeStringEqual(code, pairing.code) || !constantTimeStringEqual(fingerprint, pairing.fingerprint)) {
    return deny("pairing_code_mismatch", "Pairing code or fingerprint did not match.");
  }

  const proofDecision = verifyDevicePairingProof(proof, pairing);
  if (proofDecision.decision === "denied") {
    return proofDecision;
  }

  pairing.consumed = true;
  return {
    decision: "pairing_complete",
    reason: "device_keypair_challenge_verified",
    account_id: pairing.account_id,
    org_id: pairing.org_id,
    workspace_id: pairing.workspace_id,
    session_id: `sess_${createHash("sha256").update(pairing.pairing_id).digest("hex").slice(0, 24)}`,
    pairing_id: pairing.pairing_id,
    browser_session_id: pairing.browser_session_id,
    requested_user_id: pairing.requested_user_id,
    device_fingerprint: proof.device_fingerprint,
    device_public_key_hash: `sha256:${createHash("sha256").update(proof.device_public_key).digest("hex")}`,
    capabilities: [...MVP_ALLOWED_CAPABILITIES],
    expires_at: new Date(pairing.expires_at_ms).toISOString(),
    consent_receipt: {
      session_id: `sess_${createHash("sha256").update(pairing.pairing_id).digest("hex").slice(0, 24)}`,
      account_id: pairing.account_id,
      org_id: pairing.org_id,
      workspace_id: pairing.workspace_id,
      device_fingerprint: proof.device_fingerprint,
      capabilities: [...MVP_ALLOWED_CAPABILITIES],
      policy_version: policy.policy_version,
      expires_at: new Date(pairing.expires_at_ms).toISOString(),
      user_confirmation_required: true,
    },
    raw_body_included: false,
    bytes_sent: 0,
    local_enforcement_required: true,
    policy_version: policy.policy_version,
    protocol_version: policy.protocol_version,
    user_visible_message: "Pairing proof verified. The local app remains final authority for every request.",
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
    alert_route: alertRouteForSeverity(severity),
    dedupe_key: buildSecurityEventDedupeKey(eventType, event.session_id || "", target),
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

export function buildRelayForwardDecision(input, policy = readLocalSupportPolicy()) {
  const envelopeDecision = validateRequestEnvelope(input, policy);
  if (envelopeDecision.decision === "denied") {
    return {
      ...envelopeDecision,
      relay_forward: false,
      raw_body_included: false,
      control_plane_log_class: "local_support.control",
      data_plane_log_class: "local_support.data",
    };
  }

  const targetDisplay = scrubTelemetryValue(input.target_display || input.target || input.path || input.url || "");
  const targetHash = targetDisplay
    ? `sha256:${createHash("sha256").update(targetDisplay).digest("hex")}`
    : null;
  const redactionCount = clampNumber(input.redaction_count, 0, 1_000, 0);

  return {
    decision: "relay_ready",
    reason: "signed_nonce_bound_envelope_ready_for_local_authority",
    relay_forward: true,
    local_enforcement_required: true,
    raw_body_included: false,
    response_body_included: false,
    bytes_sent: 0,
    actor: scrubTelemetryValue(input.actor),
    request_id: scrubTelemetryValue(input.request_id),
    session_id: scrubTelemetryValue(input.session_id),
    account_id: scrubTelemetryValue(input.account_id),
    org_id: scrubTelemetryValue(input.org_id),
    device_fingerprint: scrubTelemetryValue(input.device_fingerprint),
    workspace_id: scrubTelemetryValue(input.workspace_id),
    capability: scrubTelemetryValue(input.capability),
    target_display: targetDisplay,
    target_hash: targetHash,
    target_classification: scrubTelemetryValue(input.target_classification || "unknown"),
    redaction_count: redactionCount,
    scanner_version: scrubTelemetryValue(input.scanner_version || "pending_local_scan"),
    policy_version: policy.policy_version,
    protocol_version: policy.protocol_version,
    app_version: scrubTelemetryValue(input.app_version),
    control_plane_log_class: "local_support.control",
    data_plane_log_class: "local_support.data",
    user_visible_message: "Relay may forward only this signed envelope. Local app remains final authority.",
  };
}

export function summarizeAdminState(input, policy = readLocalSupportPolicy()) {
  const state = input && typeof input === "object" ? input : {};
  const devices = Array.isArray(state.devices) ? state.devices : [];
  const sessions = Array.isArray(state.sessions) ? state.sessions : [];

  return {
    decision: "admin_state_ready",
    raw_body_included: false,
    policy_version: policy.policy_version,
    protocol_version: policy.protocol_version,
    emergency_controls: policy.emergency_controls,
    paired_devices: devices.slice(0, 100).map((device) => ({
      device_id: scrubTelemetryValue(device.device_id || device.id || ""),
      account_id: scrubTelemetryValue(device.account_id || ""),
      org_id: scrubTelemetryValue(device.org_id || ""),
      app_version: scrubTelemetryValue(device.app_version || ""),
      last_active_at: scrubTelemetryValue(device.last_active_at || ""),
      policy_version: scrubTelemetryValue(device.policy_version || policy.policy_version),
      active_sessions: clampNumber(device.active_sessions, 0, 100, 0),
      approved_ports_count: clampNumber(device.approved_ports_count, 0, 100, 0),
      revoked: device.revoked === true,
    })),
    active_sessions: sessions.slice(0, 100).map((session) => ({
      session_id: scrubTelemetryValue(session.session_id || session.id || ""),
      device_id: scrubTelemetryValue(session.device_id || ""),
      account_id: scrubTelemetryValue(session.account_id || ""),
      org_id: scrubTelemetryValue(session.org_id || ""),
      workspace_id: scrubTelemetryValue(session.workspace_id || ""),
      app_version: scrubTelemetryValue(session.app_version || ""),
      policy_version: scrubTelemetryValue(session.policy_version || policy.policy_version),
      approved_ports_count: clampNumber(session.approved_ports_count, 0, 100, 0),
      last_active_at: scrubTelemetryValue(session.last_active_at || ""),
      revoked: session.revoked === true,
    })),
  };
}

export function summarizeTransparencyState(input, policy = readLocalSupportPolicy()) {
  const state = input && typeof input === "object" ? input : {};
  const session = state.session && typeof state.session === "object" ? state.session : {};
  const workspace = state.workspace && typeof state.workspace === "object" ? state.workspace : {};
  const inventory = Array.isArray(state.inventory) ? state.inventory : [];
  const sentPayloads = Array.isArray(state.sent_payloads) ? state.sent_payloads : [];
  const blockedItems = Array.isArray(state.blocked_items) ? state.blocked_items : [];
  const activity = Array.isArray(state.activity) ? state.activity : [];
  const ports = Array.isArray(state.ports) ? state.ports : [];

  return {
    decision: "transparency_state_ready",
    raw_bodies_included: false,
    policy_version: policy.policy_version,
    protocol_version: policy.protocol_version,
    scanner_version: scrubTelemetryValue(state.scanner_version || "scanner-2026.07.05"),
    session: {
      connected: session.connected === true,
      paused: session.paused === true,
      account_id: scrubTelemetryValue(session.account_id || "not_paired"),
      org_id: scrubTelemetryValue(session.org_id || "not_paired"),
      session_id: scrubTelemetryValue(session.session_id || "not_paired"),
      device_fingerprint: scrubTelemetryValue(session.device_fingerprint || "not_paired"),
      permission_mode: scrubTelemetryValue(session.permission_mode || "Balanced mode"),
    },
    workspace: {
      workspace_id: scrubTelemetryValue(workspace.workspace_id || "not_selected"),
      display: scrubTelemetryValue(workspace.display || workspace.root || "No workspace selected"),
    },
    inventory: inventory.slice(0, 200).map((item) => ({
      target: scrubTelemetryValue(item.target || item.path || ""),
      state: normalizeTransparencyState(item.state, ["available_locally", "approval_required", "blocked_locally", "sent_to_vectant"], "available_locally"),
      classification: scrubTelemetryValue(item.classification || item.className || "unknown"),
      reason: scrubTelemetryValue(item.reason || ""),
      bytes_sent: clampNumber(item.bytes_sent, 0, 100_000_000, 0),
    })),
    sent_payloads: sentPayloads.slice(0, 200).map((item) => ({
      id: scrubTelemetryValue(item.id || item.request_id || ""),
      actor: scrubTelemetryValue(item.actor || ""),
      target: scrubTelemetryValue(item.target || item.target_display || ""),
      classification: scrubTelemetryValue(item.classification || item.className || "unknown"),
      hash: scrubTelemetryValue(item.hash || item.target_hash || ""),
      redactions: clampNumber(item.redactions || item.redaction_count, 0, 1_000, 0),
      bytes: clampNumber(item.bytes || item.bytes_sent, 0, 100_000_000, 0),
      reason: scrubTelemetryValue(item.reason || ""),
      at: scrubTelemetryValue(item.at || ""),
    })),
    blocked_items: blockedItems.slice(0, 200).map((item) => ({
      target: scrubTelemetryValue(item.target || item.path || ""),
      reason: scrubTelemetryValue(item.reason || ""),
      className: scrubTelemetryValue(item.className || item.classification || "unknown"),
      bytes_sent: 0,
      at: scrubTelemetryValue(item.at || ""),
    })),
    activity: activity.slice(0, 300).map((item) => ({
      at: scrubTelemetryValue(item.at || ""),
      kind: scrubTelemetryValue(item.kind || item.class || "Event"),
      text: scrubTelemetryValue(item.text || item.summary || ""),
    })),
    ports: ports.slice(0, 100).map((item) => ({
      port: clampNumber(item.port, 1, 65_535, 0),
      targetHost: scrubTelemetryValue(item.targetHost || item.target_host || "127.0.0.1"),
      service: scrubTelemetryValue(item.service || ""),
      previewHost: scrubTelemetryValue(item.previewHost || item.preview_host || ""),
      processHash: scrubTelemetryValue(item.processHash || item.process_hash || ""),
      ttl: scrubTelemetryValue(item.ttl || item.expires_at || "session_end"),
      browser: item.browser !== false,
      aiRead: false,
      supportRead: false,
      aiInteract: false,
      responseBodies: false,
      screenshots: false,
      consoleNetwork: false,
      persistent: false,
      methods: scrubTelemetryValue(item.methods || "GET, HEAD only"),
      requestRate: scrubTelemetryValue(item.requestRate || item.request_rate || "60/min"),
      responseLimit: scrubTelemetryValue(item.responseLimit || item.response_limit || "stream capped"),
      token_state: item.revoked === true ? "revoked" : "present_hidden_from_renderer",
      revoked: item.revoked === true,
    })).filter((item) => item.port > 0),
    export_metadata: {
      exported_by: "local_support_app",
      export_type: "scrubbed_activity_history",
      session_id: scrubTelemetryValue(session.session_id || "not_paired"),
      workspace_display: scrubTelemetryValue(workspace.display || workspace.root || "No workspace selected"),
      policy_version: policy.policy_version,
      scanner_version: scrubTelemetryValue(state.scanner_version || "scanner-2026.07.05"),
      raw_bodies_included: false,
    },
  };
}

export function buildAdminRevokeDecision(input, policy = readLocalSupportPolicy()) {
  const targetType = typeof input?.target_type === "string" ? input.target_type : "";
  const targetId = typeof input?.target_id === "string" ? input.target_id.trim() : "";
  if (!["device", "session"].includes(targetType) || !targetId) {
    return deny("invalid_admin_revoke_target", "Admin revoke requires a device or session target.");
  }
  return {
    decision: "revocation_required",
    reason: `${targetType}_revocation_requested`,
    target_type: targetType,
    target_id: scrubTelemetryValue(targetId),
    policy_version: policy.policy_version,
    raw_body_included: false,
    bytes_sent: 0,
    local_enforcement_required: true,
    user_visible_message: "The local app and relay must revoke this target immediately.",
  };
}

export function recordAdminRevocation(input, policy = readLocalSupportPolicy()) {
  const decision = buildAdminRevokeDecision(input, policy);
  if (decision.decision === "denied") {
    return decision;
  }
  if (decision.target_type === "session") {
    revokedSessions.add(decision.target_id);
  }
  if (decision.target_type === "device") {
    revokedDevices.add(decision.target_id);
  }
  return {
    ...decision,
    revocation_recorded: true,
    revoked_sessions_count: revokedSessions.size,
    revoked_devices_count: revokedDevices.size,
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

function isSessionRevoked(sessionId, policy) {
  return revokedSessions.has(sessionId) || policy.revoked_sessions?.includes(sessionId);
}

function isDeviceRevoked(deviceFingerprint, policy) {
  return revokedDevices.has(deviceFingerprint) || policy.revoked_devices?.includes(deviceFingerprint);
}

function normalizeTransparencyState(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function verifyDevicePairingProof(proof, pairing) {
  const required = [
    "pairing_id",
    "server_nonce",
    "browser_session_id",
    "requested_user_id",
    "device_public_key",
    "device_fingerprint",
    "signature",
  ];
  for (const field of required) {
    if (typeof proof[field] !== "string" || !proof[field]) {
      return deny("pairing_proof_invalid", "Pairing proof was incomplete.");
    }
  }
  if (
    proof.pairing_id !== pairing.pairing_id
    || proof.server_nonce !== pairing.server_nonce
    || proof.browser_session_id !== pairing.browser_session_id
    || proof.requested_user_id !== pairing.requested_user_id
  ) {
    return deny("pairing_proof_context_mismatch", "Pairing proof was signed for a different challenge.");
  }
  if (!/^[0-9a-f]{64}$/i.test(proof.device_public_key)) {
    return deny("pairing_device_public_key_invalid", "Device public key was not accepted.");
  }
  if (!/^[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}$/i.test(proof.device_fingerprint)) {
    return deny("pairing_device_fingerprint_invalid", "Device fingerprint was not accepted.");
  }
  if (proof.device_fingerprint !== pairingDeviceFingerprint(proof.device_public_key)) {
    return deny("pairing_device_fingerprint_mismatch", "Device fingerprint did not match the public key.");
  }
  if (!/^[0-9a-f]{128}$/i.test(proof.signature)) {
    return deny("pairing_signature_invalid", "Pairing proof signature was not accepted.");
  }

  try {
    const publicKey = createPublicKey({
      key: Buffer.concat([
        Buffer.from("302a300506032b6570032100", "hex"),
        Buffer.from(proof.device_public_key, "hex"),
      ]),
      format: "der",
      type: "spki",
    });
    const ok = verifySignature(
      null,
      pairingChallengePayload(
        proof.pairing_id,
        proof.server_nonce,
        proof.browser_session_id,
        proof.requested_user_id,
        proof.device_public_key,
      ),
      publicKey,
      Buffer.from(proof.signature, "hex"),
    );
    if (!ok) {
      return deny("pairing_signature_invalid", "Pairing proof signature did not verify.");
    }
  } catch {
    return deny("pairing_signature_invalid", "Pairing proof signature did not verify.");
  }

  return {
    decision: "verified",
    reason: "pairing_device_proof_verified",
  };
}

function pairingChallengePayload(...parts) {
  return Buffer.concat(parts.map((part) => {
    const bytes = Buffer.from(String(part), "utf8");
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(bytes.length));
    return Buffer.concat([length, bytes]);
  }));
}

function pairingDeviceFingerprint(devicePublicKeyHex) {
  const digest = createHash("sha256")
    .update("vectant-local-support-device:")
    .update(Buffer.from(devicePublicKeyHex, "hex"))
    .digest("hex");
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}

function pairingFingerprint(code) {
  const digest = createHash("sha256")
    .update("vectant-local-support-pairing:")
    .update(code)
    .digest("hex");
  return `${digest.slice(0, 4)}-${digest.slice(4, 8)}-${digest.slice(8, 12)}`;
}

function randomPairingCode() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from(randomBytes(12), (byte) => alphabet[byte % alphabet.length]).join("");
}

function prunePairingSessions(nowMs) {
  for (const [pairingId, pairing] of pairingSessions) {
    if (pairing.expires_at_ms <= nowMs) {
      pairingSessions.delete(pairingId);
    }
  }
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

function pruneReplayCache(nowMs) {
  for (const [key, expiresAt] of replayCache) {
    if (expiresAt <= nowMs) {
      replayCache.delete(key);
    }
  }
}

function severityForEvent(eventType, count) {
  if (eventType === "scanner_failure") return "critical";
  if (["path_traversal", "denied_secret_request", "preview_redirect_blocked"].includes(eventType)) {
    return count >= 3 ? "critical" : "high";
  }
  if (["rate_limit_exceeded", "suspicious_support_request", "pairing_failed", "traffic_spike"].includes(eventType)) {
    return count >= 5 ? "high" : "medium";
  }
  if (["app_version_too_old", "old_version"].includes(eventType)) return "medium";
  if (eventType === "bad_origin") return count >= 10 ? "high" : "medium";
  return "low";
}

function alertRouteForSeverity(severity) {
  if (severity === "critical") return "local_support.security.critical";
  if (severity === "high") return "local_support.security.high";
  if (severity === "medium") return "local_support.security.watch";
  return "local_support.security.info";
}

function buildSecurityEventDedupeKey(eventType, sessionId, targetDisplay) {
  const basis = [
    eventType,
    scrubTelemetryValue(sessionId || "no-session"),
    targetDisplay || "no-target",
  ].join("\0");
  return `sha256:${createHash("sha256").update(basis).digest("hex")}`;
}

function isSha256Hex(value, hexLength) {
  const digest = typeof value === "string" && value.startsWith("sha256:")
    ? value.slice("sha256:".length)
    : "";
  return digest.length === hexLength && /^[0-9a-f]+$/i.test(digest);
}

function isSafeEnvelopeIdentifier(value) {
  return typeof value === "string"
    && value.length >= 3
    && value.length <= 128
    && /^[A-Za-z0-9._:-]+$/.test(value);
}

function isSemverLike(value) {
  return typeof value === "string"
    && value.length <= 32
    && /^\d+(?:\.\d+){0,3}(?:[-+][A-Za-z0-9._-]+)?$/.test(value);
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
