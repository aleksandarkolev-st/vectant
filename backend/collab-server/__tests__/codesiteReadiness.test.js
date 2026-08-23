'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const {
  handleCodeSiteReadinessRequest,
  probeCodeSiteReadiness,
} = require('../codesiteReadiness');

function withEnv(env, fn) {
  const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return Promise.resolve().then(fn).finally(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

function responseCapture() {
  const res = new PassThrough();
  res.statusCode = null;
  res.headers = null;
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  return res;
}

test('CodeSite readiness probes the authenticated control plane and activity bridge', async () => {
  await withEnv({
    SYNTHI_CODESITE_API_BASE_URL: 'http://frontend.test/api/workspace/{workspace_slug}/codesite',
    SYNTHI_CODESITE_TOKEN: 'control-plane-secret',
  }, async () => {
    const calls = [];
    const result = await probeCodeSiteReadiness({
      fetch: async (url, options) => {
        calls.push({ url: String(url), options });
        return new Response(JSON.stringify({
          ok: true,
          checks: { activityBridgeReachable: true },
        }), { status: 200 });
      },
    });
    assert.deepEqual(result, {
      ok: true,
      checks: { controlPlaneReachable: true, activityBridgeReachable: true },
    });
    assert.equal(calls[0].url, 'http://frontend.test/api/workspace/__codesite_readiness__/codesite/readiness');
    assert.equal(calls[0].options.headers.authorization, 'Bearer control-plane-secret');
  });
});

test('CodeSite readiness fails closed when control-plane configuration is missing', async () => {
  await withEnv({
    SYNTHI_CODESITE_API_BASE_URL: undefined,
    CODESITE_API_BASE_URL: undefined,
    SYNTHI_CODESITE_BASE_URL: undefined,
    SYNTHI_CODESITE_TOKEN: undefined,
  }, async () => {
    const result = await probeCodeSiteReadiness({ fetch: async () => { throw new Error('must not fetch'); } });
    assert.deepEqual(result, {
      ok: false,
      code: 'control_plane_url_unconfigured',
      checks: { controlPlaneReachable: false, activityBridgeReachable: false },
    });
  });
});

test('CodeSite readiness endpoint reports a non-secret 503 failure result', async () => {
  const response = responseCapture();
  let payload = '';
  response.on('data', (chunk) => { payload += chunk; });
  await handleCodeSiteReadinessRequest({ method: 'GET' }, response, {
    probe: async () => ({
      ok: false,
      code: 'control_plane_readiness_failed',
      checks: { controlPlaneReachable: true, activityBridgeReachable: false },
    }),
  });
  assert.equal(response.statusCode, 503);
  assert.deepEqual(JSON.parse(payload), {
    ok: false,
    code: 'control_plane_readiness_failed',
    checks: { controlPlaneReachable: true, activityBridgeReachable: false },
  });
});
