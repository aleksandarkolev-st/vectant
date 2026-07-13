import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import prisma from '../synthi/src/lib/prisma.js';
import {
  POLICY_VERSION,
  LOCAL_SUPPORT_PROTOCOL,
  signDeviceProof,
  signRequestEnvelope,
} from '../synthi/src/lib/local-support/controlPlane.js';

const enabled = process.env.LOCAL_SUPPORT_LIVE_RELAY_E2E === '1';
const baseUrl = process.env.VECTANT_TEST_BASE_URL || 'http://localhost:3100';
const adminToken = process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN || '';
const envelopeSecret = process.env.VECTANT_LOCAL_SUPPORT_ENVELOPE_SECRET || '';
const deviceProofSecret = process.env.VECTANT_LOCAL_SUPPORT_DEVICE_PROOF_SECRET || '';
const relayPayloadKey = process.env.VECTANT_LOCAL_SUPPORT_RELAY_PAYLOAD_KEY
  || 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=';
const runId = Date.now().toString(36);
const sessionId = `sess_live_relay_${runId}`;
const requestId = `req_live_relay_${runId}`;
const alertRequestId = `req_live_alert_${runId}`;
const accountId = `acct_live_relay_${runId}`;
const orgId = `org_live_relay_${runId}`;
const workspaceId = `wk_live_relay_${runId}`;

test.skip(!enabled, 'Set LOCAL_SUPPORT_LIVE_RELAY_E2E=1 to run the live Rust relay probe.');

test('Rust RelayClient polls, reports review, uploads, and leaves scrubbed cloud state', async ({ page }) => {
  expect(Buffer.from(relayPayloadKey, 'base64')).toHaveLength(32);
  expect(adminToken).toBeTruthy();
  const identityPath = join(mkdtempSync(join(tmpdir(), 'vectant-live-relay-')), 'device-identity.json');
  const relayBinary = join(
    process.cwd(),
    'backend', 'vectant-local-support-app', 'desktop', 'target', 'debug',
    process.platform === 'win32' ? 'local-support-live-relay.exe' : 'local-support-live-relay',
  );
  try {
    execFileSync('cargo', [
      'build',
      '--manifest-path', 'backend/vectant-local-support-app/desktop/Cargo.toml',
      '--features', 'live-test-relay',
      '--bin', 'local-support-live-relay',
    ], { stdio: 'inherit' });
    const identityOutput = execFileSync(relayBinary, [
      `${baseUrl}/api/local-support/relay/device`, identityPath, sessionId, 'identity',
    ], { encoding: 'utf8' });
    const identity = JSON.parse(identityOutput.replace(/^LIVE_RELAY_IDENTITY\s+/, '').trim());

    await prisma.localSupportPolicyState.upsert({
      where: { id: 'global' },
      create: {
        id: 'global', globalEnabled: true, orgDisabled: false, pairingDisabled: false,
        previewDisabled: false, agentAccessDisabled: true, minAppVersion: '0.1.0',
        vulnerableVersionsJson: '[]', retentionDays: 30, updatedBy: 'live-relay-e2e',
      },
      update: {
        globalEnabled: true, orgDisabled: false, pairingDisabled: false,
        previewDisabled: false, agentAccessDisabled: true, minAppVersion: '0.1.0',
        vulnerableVersionsJson: '[]', retentionDays: 30, updatedBy: 'live-relay-e2e',
      },
    });
    await prisma.localSupportSession.create({
      data: {
        sessionId,
        pairingId: `pair_live_relay_${runId}`,
        browserSessionId: `browser_live_relay_${runId}`,
        accountId,
        orgId,
        workspaceId,
        deviceFingerprint: identity.device_fingerprint,
        devicePublicKey: identity.device_public_key,
        capabilitiesJson: JSON.stringify(['workspace.log.read']),
        policyVersion: POLICY_VERSION,
        protocolVersion: LOCAL_SUPPORT_PROTOCOL,
        appVersion: '0.1.0',
        expiresAt: new Date(Date.now() + 10 * 60 * 1000),
      },
    });

    const envelope = {
      request_id: requestId,
      session_id: sessionId,
      account_id: accountId,
      org_id: orgId,
      workspace_id: workspaceId,
      device_fingerprint: identity.device_fingerprint,
      device_proof: '',
      capability: 'workspace.log.read',
      actor: 'support_agent',
      expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
      app_version: '0.1.0',
      protocol_version: LOCAL_SUPPORT_PROTOCOL,
      policy_version: POLICY_VERSION,
      target_display: 'server.log',
      target_classification: 'L2',
      scanner_version: 'scanner-live-test',
      redaction_count: 1,
    };
    envelope.device_proof = signDeviceProof(envelope, deviceProofSecret);
    envelope.signature = signRequestEnvelope(envelope, envelopeSecret);
    const request = page.context().request;
    const queued = await request.post(`${baseUrl}/api/local-support/relay`, {
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      data: envelope,
    });
    expect(queued.status()).toBe(202);
    await expect(queued.json()).resolves.toMatchObject({ decision: 'relay_queued', relay_forward: true });

    const endpoint = `${baseUrl}/api/local-support/relay/device`;
    const pollOutput = execFileSync(relayBinary, [endpoint, identityPath, sessionId, 'poll'], { encoding: 'utf8' });
    const delivery = JSON.parse(pollOutput.trim());
    expect(delivery).toMatchObject({ request_id: requestId, session_id: sessionId, capability: 'workspace.log.read' });

    const outcomeOutput = execFileSync(relayBinary, [
      endpoint, identityPath, sessionId, 'outcome', requestId, delivery.lease_id, 'review_pending',
    ], { encoding: 'utf8' });
    expect(JSON.parse(outcomeOutput)).toMatchObject({ decision: 'review_pending', bytes_sent: 0 });

    const payloadOutput = execFileSync(relayBinary, [
      endpoint, identityPath, sessionId, 'upload', requestId, 'redacted-live-payload',
    ], { encoding: 'utf8' });
    expect(JSON.parse(payloadOutput)).toMatchObject({ decision: 'sent', bytes_sent: 21 });

    const stored = await prisma.localSupportRelayRequest.findUnique({
      where: { requestId },
      include: { payload: true, auditEntries: true },
    });
    expect(stored?.status).toBe('sent');
    expect(stored?.payload?.byteCount).toBe(21);
    expect(stored?.payload?.ciphertext).not.toContain('redacted-live-payload');
    expect(stored?.auditEntries.map((entry) => entry.decision)).toEqual(['queued', 'review_pending', 'sent']);
    expect(stored?.auditEntries.every((entry) => entry.bytesSent >= 0)).toBe(true);

    const alertEnvelope = {
      ...envelope,
      request_id: alertRequestId,
      target_display: 'secret.log',
      target_classification: 'L4',
      device_proof: '',
    };
    alertEnvelope.device_proof = signDeviceProof(alertEnvelope, deviceProofSecret);
    alertEnvelope.signature = signRequestEnvelope(alertEnvelope, envelopeSecret);
    const alertQueued = await page.context().request.post(`${baseUrl}/api/local-support/relay`, {
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      data: alertEnvelope,
    });
    expect(alertQueued.status()).toBe(202);
    const alertDelivery = JSON.parse(execFileSync(relayBinary, [endpoint, identityPath, sessionId, 'poll'], { encoding: 'utf8' }));
    expect(alertDelivery.request_id).toBe(alertRequestId);
    const deniedOutcome = execFileSync(relayBinary, [
      endpoint, identityPath, sessionId, 'outcome', alertRequestId, alertDelivery.lease_id, 'denied',
    ], { encoding: 'utf8' });
    expect(JSON.parse(deniedOutcome)).toMatchObject({ decision: 'denied', bytes_sent: 0 });
    const alert = await prisma.localSupportSecurityEvent.findFirst({ where: { requestId: alertRequestId } });
    expect(alert).toMatchObject({
      eventType: 'denied_secret',
      alert: true,
      alertRoute: 'security_ops_immediate',
      targetDisplay: 'secret.log',
    });

    const revoke = await page.context().request.post(`${baseUrl}/api/local-support/admin/state`, {
      headers: {
        origin: baseUrl,
        'sec-fetch-site': 'same-origin',
        'x-vectant-admin-token': adminToken,
        'content-type': 'application/json',
      },
      data: { target_type: 'session', target_id: sessionId },
    });
    expect(revoke.status()).toBe(200);
    await expect(revoke.json()).resolves.toMatchObject({
      decision: 'revocation_required',
      revocation_recorded: true,
    });

    const revokedPoll = execFileSync(relayBinary, [endpoint, identityPath, sessionId, 'poll'], { encoding: 'utf8' });
    expect(JSON.parse(revokedPoll.trim())).toEqual({ decision: 'relay_revoked' });

    const revoked = await prisma.localSupportSession.findUnique({ where: { sessionId } });
    const purged = await prisma.localSupportRelayRequest.findUnique({
      where: { requestId },
      include: { payload: true },
    });
    expect(revoked?.status).toBe('revoked');
    expect(purged?.payload).toBeNull();
  } finally {
    await prisma.localSupportRelayRequest.deleteMany({ where: { requestId: { in: [requestId, alertRequestId] } } });
    await prisma.localSupportSession.deleteMany({ where: { sessionId } });
    await prisma.localSupportPolicyState.deleteMany({ where: { id: 'global' } });
    await prisma.$disconnect();
    rmSync(identityPath, { force: true });
    rmSync(join(identityPath, '..'), { recursive: true, force: true });
  }
});
