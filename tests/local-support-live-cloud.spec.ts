import { test, expect } from '@playwright/test';

const enabled = process.env.LOCAL_SUPPORT_LIVE_CLOUD_E2E === '1';
const baseUrl = process.env.VECTANT_TEST_BASE_URL;
const adminToken = process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN || '';

test.skip(!enabled, 'Set LOCAL_SUPPORT_LIVE_CLOUD_E2E=1 to run against a live Next/PostgreSQL stack.');
if (enabled && !baseUrl) throw new Error('VECTANT_TEST_BASE_URL is required for live cloud E2E.');

test('browser reaches the real cloud policy route and durable admin controls', async ({ page }) => {
  await page.goto(`${baseUrl}/local-support`, { waitUntil: 'domcontentloaded' });
  const requestHeaders = {
    origin: baseUrl,
    'sec-fetch-site': 'same-origin',
    'x-vectant-admin-token': adminToken,
  };
  const request = page.context().request;
  const update = await request.post(`${baseUrl}/api/local-support/admin/state`, {
    headers: { ...requestHeaders, 'content-type': 'application/json' },
    data: {
      action: 'update_policy',
      global_enabled: true,
      org_disabled: true,
      pairing_disabled: true,
      preview_disabled: true,
      agent_access_disabled: true,
      min_app_version: '8.7.6',
      vulnerable_versions: ['8.7.5'],
      retention_days: 7,
    },
  });
  const policy = await request.get(`${baseUrl}/api/local-support/policy`, {
    headers: requestHeaders,
  });
  const result = {
    updateStatus: update.status(),
    updateBody: await update.json(),
    policyStatus: policy.status(),
    policy: await policy.json(),
  };

  expect(result.updateStatus, JSON.stringify(result.updateBody)).toBe(200);
  expect(result.updateBody).toMatchObject({
    decision: 'policy_updated',
    org_disabled: true,
    pairing_disabled: true,
    preview_disabled: true,
    bytes_sent: 0,
    raw_body_included: false,
  });
  expect(result.policyStatus).toBe(200);
  expect(result.policy).toMatchObject({
    enabled: false,
    org_kill_switch: true,
    pairing_disabled: true,
    min_app_version: '8.7.6',
    vulnerable_versions: ['8.7.5'],
    emergency_controls: {
      pairing_disabled: true,
      preview_gateway_disabled: true,
      agent_access_disabled: true,
    },
  });
  expect(result.updateBody.raw_body_included).toBe(false);
  expect(result.policy.retention.raw_bodies_allowed).toBe(false);
});
