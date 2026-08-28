'use strict';

const { enforceCodeSiteActivityAuth } = require('./codesiteActivityEndpoint');

function writeJsonResponse(res, status, body) {
  res.writeHead(status, {
    'content-type': 'application/json',
    'cache-control': 'no-store',
  });
  res.end(JSON.stringify(body));
}

function unavailable(code) {
  return { ok: false, code };
}

async function resolveCheck(probe, fallbackCode) {
  if (typeof probe !== 'function') return unavailable(fallbackCode);
  try {
    const result = await probe();
    return {
      ok: result?.ok === true,
      code: result?.code || (result?.ok ? 'ready' : fallbackCode),
    };
  } catch (_) {
    return unavailable(fallbackCode);
  }
}

async function handleCodeSiteDeploymentStatusRequest(req, res, options = {}) {
  const respond = options.writeJsonResponse || writeJsonResponse;
  if (!enforceCodeSiteActivityAuth(req, res, { writeJsonResponse: respond })) {
    return true;
  }
  if (req.method !== 'GET') {
    respond(res, 405, { ok: false, code: 'method_not_allowed' });
    return true;
  }

  const [overlayCapable, runtimeEventAdapterHealthy] = await Promise.all([
    resolveCheck(options.probeOverlayCapability, 'overlay_runtime_unavailable'),
    resolveCheck(options.probeRuntimeEventAdapter, 'runtime_event_adapter_unconfigured'),
  ]);
  respond(res, 200, {
    ok: true,
    checkedAt: new Date().toISOString(),
    checks: { overlayCapable, runtimeEventAdapterHealthy },
  });
  return true;
}

module.exports = {
  handleCodeSiteDeploymentStatusRequest,
  resolveCheck,
};
