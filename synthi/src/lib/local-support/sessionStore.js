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

function validPublicKey(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/i.test(value);
}
