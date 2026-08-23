import { afterEach, describe, expect, it, vi } from 'vitest';
import { probeCodeSiteActivityBridge, probeCodeSiteDeploymentStatus } from '../activityBridgeReadiness';

const ENV_KEYS = [
  'COLLAB_SERVER_URL',
  'SYNTHI_COLLAB_SERVER_URL',
  'NEXT_PUBLIC_COLLAB_SERVER_URL',
  'COLLAB_INTERNAL_TOKEN',
  'SYNTHI_COLLAB_INTERNAL_TOKEN',
  'SYNTHI_CODESITE_API_BASE_URL',
  'CODESITE_API_BASE_URL',
  'SYNTHI_APP_INTERNAL_URL',
];
const initialEnvironment = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const [key, value] of Object.entries(initialEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('probeCodeSiteActivityBridge', () => {
  it('publishes, refreshes, and closes a bounded authenticated activity record', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'activity-secret';
    process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://frontend.test/api/workspace/{workspace_slug}/codesite';
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activeTransactions: [{ transactionId: 'readiness-1' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    const result = await probeCodeSiteActivityBridge(
      new Request('http://frontend.test/api/workspace/acme/codesite/readiness'),
      { fetch, transactionId: 'readiness-1' },
    );

    expect(result).toEqual({ ok: true, checks: { published: true, refreshed: true, cleaned: true } });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls[0][0]).toEqual(new URL('http://collab.test/codesite/activity/__codesite_readiness__'));
    expect(fetch.mock.calls[0][1]).toMatchObject({
      method: 'POST',
      headers: expect.objectContaining({ 'x-collab-internal-token': 'activity-secret' }),
    });
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toMatchObject({
      event: 'transaction_opened',
      transactionId: 'readiness-1',
      controlPlaneUrl: 'http://frontend.test/api/workspace/__codesite_readiness__/codesite',
    });
    expect(fetch.mock.calls[1][1]).toMatchObject({ method: 'GET' });
    expect(JSON.parse(fetch.mock.calls[2][1].body)).toMatchObject({
      event: 'transaction_closed',
      transactionId: 'readiness-1',
    });
  });

  it('fails closed without a configured collab activity token', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    delete process.env.COLLAB_INTERNAL_TOKEN;
    delete process.env.SYNTHI_COLLAB_INTERNAL_TOKEN;
    const fetch = vi.fn();

    await expect(probeCodeSiteActivityBridge(
      new Request('http://frontend.test/api/workspace/acme/codesite/readiness'),
      { fetch },
    )).resolves.toEqual({
      ok: false,
      code: 'collab_activity_token_unconfigured',
      checks: { published: false, refreshed: false, cleaned: false },
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('cleans up a published record even when refresh verification fails', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'activity-secret';
    process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://frontend.test/api/workspace/{workspace_slug}/codesite';
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ activeTransactions: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }));

    await expect(probeCodeSiteActivityBridge(
      new Request('http://frontend.test/api/workspace/acme/codesite/readiness'),
      { fetch, transactionId: 'readiness-refresh-failure' },
    )).resolves.toEqual({
      ok: false,
      code: 'activity_refresh_failed',
      checks: { published: true, refreshed: false, cleaned: true },
    });
  });

  it('fails readiness when its transient activity record cannot be cleared', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'activity-secret';
    process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://frontend.test/api/workspace/{workspace_slug}/codesite';
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        activeTransactions: [{ transactionId: 'readiness-cleanup-failure' }],
      }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: false }), { status: 503 }));

    await expect(probeCodeSiteActivityBridge(
      new Request('http://frontend.test/api/workspace/acme/codesite/readiness'),
      { fetch, transactionId: 'readiness-cleanup-failure' },
    )).resolves.toEqual({
      ok: false,
      code: 'activity_cleanup_failed',
      checks: { published: true, refreshed: true, cleaned: false },
    });
  });
});

describe('probeCodeSiteDeploymentStatus', () => {
  it('combines the authenticated activity round trip with collab runtime capabilities', async () => {
    process.env.COLLAB_SERVER_URL = 'http://collab.test';
    process.env.COLLAB_INTERNAL_TOKEN = 'activity-secret';
    process.env.SYNTHI_CODESITE_API_BASE_URL = 'http://frontend.test/api/workspace/{workspace_slug}/codesite';
    let transactionId;
    const fetch = vi.fn(async (url, options) => {
      const target = new URL(url);
      if (target.pathname === '/codesite/deployment-status') {
        return new Response(JSON.stringify({
          ok: true,
          checks: {
            overlayCapable: { ok: true, code: 'docker_overlay_runtime_ready' },
            runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_unconfigured' },
          },
        }), { status: 200 });
      }
      if (options.method === 'GET') {
        return new Response(JSON.stringify({ activeTransactions: [{ transactionId }] }), { status: 200 });
      }
      const body = JSON.parse(options.body);
      if (body.event === 'transaction_opened') transactionId = body.transactionId;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });

    const result = await probeCodeSiteDeploymentStatus(
      new Request('http://frontend.test/api/workspace/acme/codesite/projects/proj-1/deployment-status'),
      { fetch, transactionId: 'status-transaction' },
    );

    expect(result).toEqual({
      activityBridge: { ok: true, checks: { published: true, refreshed: true, cleaned: true } },
      capabilities: {
        ok: true,
        checks: {
          overlayCapable: { ok: true, code: 'docker_overlay_runtime_ready' },
          runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_unconfigured' },
        },
      },
    });
    expect(fetch).toHaveBeenCalledTimes(4);
  });
});
