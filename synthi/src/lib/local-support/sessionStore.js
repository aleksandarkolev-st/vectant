import prisma from "@/lib/prisma";

export async function persistPairedSession(completed, proof, client = prisma) {
  if (completed?.decision !== "pairing_complete" || !validPublicKey(proof?.device_public_key)) {
    throw new Error("Pairing session was not safe to persist.");
  }
  if (proof.device_fingerprint !== completed.device_fingerprint) {
    throw new Error("Pairing device identity did not match completion.");
  }

  return client.localSupportSession.create({
    data: {
      sessionId: completed.session_id,
      pairingId: completed.pairing_id,
      browserSessionId: completed.browser_session_id,
      accountId: completed.account_id,
      orgId: completed.org_id,
      workspaceId: completed.workspace_id,
      deviceFingerprint: completed.device_fingerprint,
      devicePublicKey: proof.device_public_key.toLowerCase(),
      capabilitiesJson: JSON.stringify(completed.capabilities || []),
      policyVersion: completed.policy_version,
      protocolVersion: completed.protocol_version,
      appVersion: completed.app_version || "unknown",
      expiresAt: new Date(completed.expires_at),
    },
  });
}

export async function findActivePairedSession(sessionId, deviceFingerprint, client = prisma, now = new Date()) {
  return client.localSupportSession.findFirst({
    where: {
      sessionId,
      deviceFingerprint,
      status: "active",
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
}

export async function authorizeRelaySession(decision, client = prisma, now = new Date()) {
  const session = await client.localSupportSession.findFirst({
    where: {
      sessionId: decision.session_id,
      accountId: decision.account_id,
      orgId: decision.org_id,
      workspaceId: decision.workspace_id,
      deviceFingerprint: decision.device_fingerprint,
      status: "active",
      revokedAt: null,
      expiresAt: { gt: now },
    },
  });
  if (!session) return { ok: false, reason: "paired_session_not_found" };
  let capabilities;
  try {
    capabilities = JSON.parse(session.capabilitiesJson);
  } catch {
    return { ok: false, reason: "paired_session_capabilities_invalid" };
  }
  if (!Array.isArray(capabilities) || !capabilities.includes(decision.capability)) {
    return { ok: false, reason: "session_capability_not_granted" };
  }
  return { ok: true, session };
}

export async function updatePairedSessionPorts(sessionId, deviceFingerprint, ports, client = prisma) {
  const normalized = normalizeSyncedPorts(ports);
  if (!normalized) return false;
  const result = await client.localSupportSession.updateMany({
    where: {
      sessionId,
      deviceFingerprint,
      status: "active",
      revokedAt: null,
      expiresAt: { gt: new Date() },
    },
    data: { approvedPortsJson: JSON.stringify(normalized) },
  });
  return result.count === 1;
}

function normalizeSyncedPorts(value) {
  if (!Array.isArray(value) || value.length > 100) return null;
  const normalized = value.map((port) => {
    const allowedFields = new Set([
      "port", "target_host", "preview_host", "process_identity_hash",
      "browser_preview_allowed", "agent_read_allowed", "support_agent_read_allowed",
      "agent_interact_allowed", "send_response_body_allowed", "send_screenshot_allowed",
      "send_console_errors_allowed", "state_changing_methods_allowed", "expires_at",
    ]);
    if (!port || Object.keys(port).some((key) => !allowedFields.has(key))) return null;
    if (!port || !Number.isSafeInteger(port.port) || port.port < 1 || port.port > 65535) return null;
    if (!isAllowedPrivateTargetHost(port.target_host)) return null;
    if (typeof port.preview_host !== "string" || !/^br-local-p[1-9]\d{0,4}\.vectant-preview\.dev$/.test(port.preview_host)) return null;
    if (typeof port.process_identity_hash !== "string" || !/^sha256:[0-9a-f]{16,128}$/i.test(port.process_identity_hash)) return null;
    if (typeof port.expires_at !== "string" || port.expires_at.length > 80) return null;
    return {
      port: port.port,
      target_host: port.target_host,
      preview_host: port.preview_host,
      process_identity_hash: port.process_identity_hash,
      browser_preview_allowed: port.browser_preview_allowed === true,
      // The current product contract is browser-preview-only. These fields
      // remain in the schema for forward compatibility, but cloud state must
      // never elevate a port from a device-supplied boolean.
      agent_read_allowed: false,
      support_agent_read_allowed: false,
      agent_interact_allowed: false,
      send_response_body_allowed: false,
      send_screenshot_allowed: false,
      send_console_errors_allowed: false,
      state_changing_methods_allowed: false,
      expires_at: port.expires_at,
      persistent: false,
    };
  });
  if (normalized.some((port) => port === null)) return null;
  const unique = new Set(normalized.map((port) => port.port));
  return unique.size === normalized.length ? normalized : null;
}

function validPublicKey(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}

function isAllowedPrivateTargetHost(host) {
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return true;
  const parts = String(host).split(".").map((part) => Number(part));
  return parts.length === 4
    && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    && parts[0] === 127;
}
