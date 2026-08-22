'use strict';

const { configuredControlPlaneBaseUrl } = require('./codesiteControlPlaneTrust');

const READINESS_WORKSPACE_SLUG = '__codesite_readiness__';

function controlPlaneToken() {
  return process.env.SYNTHI_CODESITE_TOKEN || '';
}

function readinessWorkspaceSlug() {
  return String(process.env.SYNTHI_CODESITE_READINESS_WORKSPACE_SLUG || READINESS_WORKSPACE_SLUG).trim() || READINESS_WORKSPACE_SLUG;
}

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

function readinessUrl() {
  const baseUrl = configuredControlPlaneBaseUrl(readinessWorkspaceSlug());
  return baseUrl ? `${baseUrl}/readiness` : null;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

async function probeCodeSiteReadiness(options = {}) {
  const fetchImpl = options.fetch || global.fetch;
  const token = options.token ?? controlPlaneToken();
  const targetUrl = options.url || readinessUrl();
  const timeoutMs = Number(options.timeoutMs || process.env.SYNTHI_CODESITE_READINESS_TIMEOUT_MS || 3_000);
  if (!targetUrl || !token || typeof fetchImpl !== 'function') {
    return {
      ok: false,
      code: !targetUrl ? 'control_plane_url_unconfigured' : (!token ? 'control_plane_token_unconfigured' : 'fetch_unavailable'),
      checks: { controlPlaneReachable: false, activityBridgeReachable: false },
    };
  }
  try {
    const response = await fetchImpl(targetUrl, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${token}` },
      signal: timeoutSignal(timeoutMs),
    });
    const body = await responseJson(response);
    const checks = {
      controlPlaneReachable: Boolean(response?.ok),
      activityBridgeReachable: Boolean(body?.checks?.activityBridgeReachable),
    };
    return response?.ok && body?.ok && checks.activityBridgeReachable
      ? { ok: true, checks }
      : { ok: false, code: 'control_plane_readiness_failed', checks };
  } catch (_) {
    return {
      ok: false,
      code: 'control_plane_readiness_unreachable',
      checks: { controlPlaneReachable: false, activityBridgeReachable: false },
    };
  }
}

function writeJsonResponse(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function handleCodeSiteReadinessRequest(req, res, options = {}) {
  if (req.method !== 'GET') {
    writeJsonResponse(res, 405, { ok: false, code: 'method_not_allowed' });
    return true;
  }
  const result = await (options.probe || probeCodeSiteReadiness)(options);
  writeJsonResponse(res, result.ok ? 200 : 503, result);
  return true;
}

module.exports = {
  READINESS_WORKSPACE_SLUG,
  handleCodeSiteReadinessRequest,
  probeCodeSiteReadiness,
  readinessUrl,
};
