import { createHash } from "node:crypto";

import prisma from "@/lib/prisma";
import { verifyDevicePairingProof } from "@/lib/local-support/controlPlane";
import { persistPairedSession } from "@/lib/local-support/sessionStore";

const CLAIM_WINDOW_MS = 60_000;
const MAX_CLAIMS_PER_WINDOW = 20;
const MAX_CHALLENGE_ATTEMPTS = 5;
const CAPABILITIES = [
  "workspace.file.source.read",
  "workspace.log.read",
  "workspace.metadata.read",
  "workspace.git.status.read",
  "localhost.preview.browser",
];

export async function persistPairingChallenge(challenge, client = prisma) {
  if (challenge?.decision !== "pairing_challenge_created") {
    throw new Error("Pairing challenge was not valid for persistence.");
  }
  return client.localSupportPairingChallenge.create({
    data: {
      pairingId: challenge.pairing_id,
      codeHash: pairingCodeHash(challenge.code),
      fingerprint: challenge.fingerprint,
      serverNonce: challenge.server_nonce,
      browserSessionId: challenge.browser_session_id,
      requestedUserId: challenge.requested_user_id,
      accountId: challenge.account_id,
      orgId: challenge.org_id,
      workspaceId: challenge.workspace_id,
      expiresAt: new Date(challenge.expires_at),
    },
  });
}

export async function claimPairingChallengeDurably(input, policy, client = prisma, now = new Date()) {
  const code = typeof input?.code === "string" ? input.code : "";
  const workspaceId = typeof input?.workspace_id === "string" ? input.workspace_id : "";
  const appVersion = typeof input?.app_version === "string" ? input.app_version : "";
  const protocolVersion = typeof input?.protocol_version === "string" ? input.protocol_version : "";
  if (!policy.enabled) return denied("feature_disabled");
  if (!/^[A-HJ-NP-Z2-9]{12}$/.test(code)
    || !safeId(workspaceId)
    || !/^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(appVersion)
    || protocolVersion !== policy.protocol_version) {
    return denied("invalid_pairing_schema");
  }
  if (compareVersions(appVersion, policy.min_app_version) < 0) return denied("app_version_too_old");
  if (policy.vulnerable_versions.includes(appVersion)) return denied("app_version_blocked");

  return client.$transaction(async (tx) => {
    await tx.localSupportPairingRateLimit.deleteMany({ where: { expiresAt: { lte: now } } });
    const bucket = String(Math.floor(now.getTime() / CLAIM_WINDOW_MS));
    const rate = await tx.localSupportPairingRateLimit.upsert({
      where: { bucket },
      create: { bucket, attempts: 1, expiresAt: new Date(now.getTime() + CLAIM_WINDOW_MS) },
      update: { attempts: { increment: 1 } },
    });
    if (rate.attempts > MAX_CLAIMS_PER_WINDOW) return denied("pairing_rate_limited");

    const challenge = await tx.localSupportPairingChallenge.findUnique({
      where: { codeHash: pairingCodeHash(code) },
    });
    if (!challenge || !["pending", "claimed"].includes(challenge.status)) {
      return denied("pairing_challenge_not_found");
    }
    if (challenge.expiresAt <= now) {
      await tx.localSupportPairingChallenge.update({
        where: { pairingId: challenge.pairingId },
        data: { status: "expired" },
      });
      return denied("pairing_code_expired");
    }
    if (challenge.attempts >= MAX_CHALLENGE_ATTEMPTS) return denied("pairing_rate_limited");
    if (challenge.workspaceId !== "wk_pending_local_selection" && challenge.workspaceId !== workspaceId) {
      return denied("workspace_mismatch");
    }
    const claimedWorkspace = challenge.workspaceId === "wk_pending_local_selection"
      ? workspaceId
      : challenge.workspaceId;
    const updated = await tx.localSupportPairingChallenge.updateMany({
      where: {
        pairingId: challenge.pairingId,
        status: { in: ["pending", "claimed"] },
        attempts: { lt: MAX_CHALLENGE_ATTEMPTS },
        expiresAt: { gt: now },
      },
      data: {
        workspaceId: claimedWorkspace,
        appVersion,
        protocolVersion,
        status: "claimed",
        attempts: { increment: 1 },
      },
    });
    if (updated.count !== 1) return denied("pairing_challenge_not_found");
    return claimedResponse(challenge, claimedWorkspace, policy);
  });
}

export async function completePairingChallengeDurably(input, policy, client = prisma, now = new Date()) {
  if (!policy.enabled) return denied("feature_disabled");
  const pairingId = typeof input?.pairing_id === "string" ? input.pairing_id : "";
  const code = typeof input?.code === "string" ? input.code : "";
  const fingerprint = typeof input?.fingerprint === "string" ? input.fingerprint : "";
  const proof = input?.proof && typeof input.proof === "object" ? input.proof : null;
  if (!safeId(pairingId) || !proof) return denied("invalid_pairing_schema");

  return client.$transaction(async (tx) => {
    const challenge = await tx.localSupportPairingChallenge.findUnique({ where: { pairingId } });
    if (!challenge) return denied("pairing_challenge_not_found");
    if (challenge.status === "consumed") return denied("pairing_code_consumed");
    if (challenge.status !== "claimed") return denied("pairing_challenge_not_found");
    if (challenge.expiresAt <= now) return denied("pairing_code_expired");
    if (challenge.codeHash !== pairingCodeHash(code) || challenge.fingerprint !== fingerprint) {
      return denied("pairing_code_mismatch");
    }
    if (challenge.protocolVersion !== policy.protocol_version) return denied("protocol_version_mismatch");
    if (compareVersions(challenge.appVersion, policy.min_app_version) < 0) return denied("app_version_too_old");
    if (policy.vulnerable_versions.includes(challenge.appVersion)) return denied("app_version_blocked");

    const pairing = pairingProofContext(challenge);
    const proofDecision = verifyDevicePairingProof(proof, pairing);
    if (proofDecision.decision === "denied") return proofDecision;
    const completed = completedResponse(challenge, proof, policy);
    const consumed = await tx.localSupportPairingChallenge.updateMany({
      where: { pairingId, status: "claimed", expiresAt: { gt: now } },
      data: { status: "consumed", consumedAt: now },
    });
    if (consumed.count !== 1) return denied("pairing_code_consumed");
    await persistPairedSession(completed, proof, tx);
    return completed;
  });
}

function claimedResponse(challenge, workspaceId, policy) {
  return {
    decision: "pairing_challenge_claimed",
    reason: "confirm_pairing_fingerprint_locally",
    pairing_id: challenge.pairingId,
    fingerprint: challenge.fingerprint,
    server_nonce: challenge.serverNonce,
    browser_session_id: challenge.browserSessionId,
    requested_user_id: challenge.requestedUserId,
    account_id: challenge.accountId,
    org_id: challenge.orgId,
    workspace_id: workspaceId,
    expires_at: challenge.expiresAt.toISOString(),
    raw_body_included: false,
    bytes_sent: 0,
    policy_version: policy.policy_version,
    protocol_version: policy.protocol_version,
    user_visible_message: "Compare this fingerprint with the browser, then confirm pairing locally.",
  };
}

function completedResponse(challenge, proof, policy) {
  const sessionId = `sess_${createHash("sha256").update(challenge.pairingId).digest("hex").slice(0, 24)}`;
  return {
    decision: "pairing_complete",
    reason: "device_keypair_challenge_verified",
    account_id: challenge.accountId,
    org_id: challenge.orgId,
    workspace_id: challenge.workspaceId,
    session_id: sessionId,
    pairing_id: challenge.pairingId,
    browser_session_id: challenge.browserSessionId,
    requested_user_id: challenge.requestedUserId,
    device_fingerprint: proof.device_fingerprint,
    device_public_key_hash: `sha256:${createHash("sha256").update(proof.device_public_key).digest("hex")}`,
    capabilities: CAPABILITIES,
    expires_at: challenge.expiresAt.toISOString(),
    consent_receipt: {
      session_id: sessionId,
      account_id: challenge.accountId,
      org_id: challenge.orgId,
      workspace_id: challenge.workspaceId,
      device_fingerprint: proof.device_fingerprint,
      capabilities: CAPABILITIES,
      policy_version: policy.policy_version,
      expires_at: challenge.expiresAt.toISOString(),
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

function pairingProofContext(challenge) {
  return {
    pairing_id: challenge.pairingId,
    server_nonce: challenge.serverNonce,
    browser_session_id: challenge.browserSessionId,
    requested_user_id: challenge.requestedUserId,
  };
}

function pairingCodeHash(code) {
  return createHash("sha256").update("vectant-local-support-pairing-code:").update(code).digest("hex");
}

function safeId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.-]{3,128}$/.test(value);
}

function compareVersions(left, right) {
  const a = String(left).split(/[+-]/)[0].split(".").map(Number);
  const b = String(right).split(/[+-]/)[0].split(".").map(Number);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    if ((a[index] || 0) !== (b[index] || 0)) return (a[index] || 0) < (b[index] || 0) ? -1 : 1;
  }
  return 0;
}

function denied(reason) {
  return { decision: "denied", reason, raw_body_included: false, bytes_sent: 0 };
}
