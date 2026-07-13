import { test, expect } from '@playwright/test';

const enabled = process.env.LOCAL_SUPPORT_STAGING_E2E === '1';
const baseUrl = process.env.VECTANT_TEST_BASE_URL || '';
const adminToken = process.env.VECTANT_LOCAL_SUPPORT_ADMIN_TOKEN || '';

test.skip(!enabled, 'Set LOCAL_SUPPORT_STAGING_E2E=1 to run against protected staging.');

test('protected staging exposes live policy controls without an auth redirect', async ({ page }) => {
  expect(baseUrl).toMatch(/^https:\/\//);
  expect(adminToken).toMatch(/^[\x21-\x7e]{8,256}$/);

  const landing = await page.goto(`${baseUrl}/local-support`, {
    waitUntil: 'domcontentloaded',
    timeout: 30_000,
  });
  expect(landing?.status()).toBe(200);
  expect(new URL(page.url()).origin).toBe(new URL(baseUrl).origin);

  const request = page.context().request;
  const headers = {
    origin: baseUrl,
    'sec-fetch-site': 'same-origin',
    'x-vectant-admin-token': adminToken,
  };
  const beforeResponse = await request.get(`${baseUrl}/api/local-support/policy`, { headers });
  expect(beforeResponse.status()).toBe(200);
  const before = await beforeResponse.json();
  expect(before.retention?.raw_bodies_allowed).toBe(false);

  const admin = await request.get(`${baseUrl}/api/local-support/admin/state`, { headers });
  expect(admin.status()).toBe(200);
  await expect(admin.json()).resolves.toMatchObject({
    decision: 'admin_state_ready',
    raw_body_included: false,
  });

  const restore = {
    action: 'update_policy',
    global_enabled: before.global_enabled === true,
    org_disabled: before.org_kill_switch === true,
    pairing_disabled: before.pairing_disabled === true,
    preview_disabled: before.emergency_controls?.preview_gateway_disabled === true,
    agent_access_disabled: before.emergency_controls?.agent_access_disabled !== false,
    min_app_version: before.min_app_version || '0.1.0',
    vulnerable_versions: Array.isArray(before.vulnerable_versions) ? before.vulnerable_versions : [],
    retention_days: before.retention?.local_activity_days || 30,
  };

  try {
    const disable = await request.post(`${baseUrl}/api/local-support/admin/state`, {
      headers: { ...headers, 'content-type': 'application/json' },
      data: {
        action: 'update_policy',
        global_enabled: false,
        org_disabled: true,
        pairing_disabled: true,
        preview_disabled: true,
        agent_access_disabled: true,
        min_app_version: restore.min_app_version,
        vulnerable_versions: restore.vulnerable_versions,
        retention_days: restore.retention_days,
      },
    });
    expect(disable.status()).toBe(200);
    await expect(disable.json()).resolves.toMatchObject({
      decision: 'policy_updated',
      global_enabled: false,
      org_disabled: true,
      preview_disabled: true,
      bytes_sent: 0,
      raw_body_included: false,
    });

    const deniedRelay = await request.post(`${baseUrl}/api/local-support/relay`, {
      headers: { origin: baseUrl, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' },
      data: { request_id: `staging_disable_${Date.now()}` },
    });
    expect(deniedRelay.status()).toBe(403);
    await expect(deniedRelay.json()).resolves.toMatchObject({
      decision: 'denied',
      reason: 'feature_disabled',
      bytes_sent: 0,
      raw_body_included: false,
    });
  } finally {
    const restored = await request.post(`${baseUrl}/api/local-support/admin/state`, {
      headers: { ...headers, 'content-type': 'application/json' },
      data: restore,
    });
    expect(restored.status()).toBe(200);
  }
});
