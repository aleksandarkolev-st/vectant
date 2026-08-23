'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { handleCodeSiteDeploymentStatusRequest } = require('../codesiteDeploymentStatus');

function responseRecorder() {
  return {
    status: null,
    body: null,
    writeHead(status) { this.status = status; },
    end(body) { this.body = JSON.parse(body); },
  };
}

async function withInternalToken(value, run) {
  const previous = process.env.COLLAB_INTERNAL_TOKEN;
  process.env.COLLAB_INTERNAL_TOKEN = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env.COLLAB_INTERNAL_TOKEN;
    else process.env.COLLAB_INTERNAL_TOKEN = previous;
  }
}

test('deployment status returns live overlay capability and fails closed for an absent runtime adapter', async () => {
  await withInternalToken('status-secret', async () => {
    const response = responseRecorder();
    await handleCodeSiteDeploymentStatusRequest({
      method: 'GET',
      headers: { 'x-collab-internal-token': 'status-secret' },
    }, response, {
      probeOverlayCapability: async () => ({ ok: true, code: 'docker_overlay_runtime_ready' }),
    });

    assert.equal(response.status, 200);
    assert.equal(response.body.ok, true);
    assert.match(response.body.checkedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.deepEqual(response.body.checks, {
      overlayCapable: { ok: true, code: 'docker_overlay_runtime_ready' },
      runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_unconfigured' },
    });
  });
});

test('deployment status rejects unauthenticated requests before running probes', async () => {
  await withInternalToken('status-secret', async () => {
    const response = responseRecorder();
    let probes = 0;
    await handleCodeSiteDeploymentStatusRequest({ method: 'GET', headers: {} }, response, {
      probeOverlayCapability: async () => { probes += 1; return { ok: true }; },
    });
    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: 'codesite_activity_auth_required' });
    assert.equal(probes, 0);
  });
});

test('deployment status rejects methods other than GET', async () => {
  await withInternalToken('status-secret', async () => {
    const response = responseRecorder();
    await handleCodeSiteDeploymentStatusRequest({
      method: 'POST',
      headers: { 'x-collab-internal-token': 'status-secret' },
    }, response);
    assert.equal(response.status, 405);
    assert.deepEqual(response.body, { ok: false, code: 'method_not_allowed' });
  });
});
