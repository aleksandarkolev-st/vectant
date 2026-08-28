import { getCodeSiteRuntimeConfig } from './runtimeConfig';

const READINESS_WORKSPACE_SLUG = '__codesite_readiness__';

function configuredCollabHttpUrl() {
  return getCodeSiteRuntimeConfig().collabServerUrl;
}

function collabInternalToken() {
  return getCodeSiteRuntimeConfig().collabInternalToken;
}

function controlPlaneUrlFor(request, workspaceSlug) {
  const explicit = process.env.SYNTHI_CODESITE_API_BASE_URL || process.env.CODESITE_API_BASE_URL;
  if (explicit) {
    return explicit.replace('{workspace_slug}', encodeURIComponent(workspaceSlug)).replace(/\/+$/, '');
  }
  const requestUrl = new URL(request.url);
  const configuredOrigin = process.env.SYNTHI_CODESITE_BASE_URL
    || process.env.SYNTHI_APP_INTERNAL_URL
    || process.env.SYNTHI_APP_URL
    || process.env.NEXTAUTH_URL
    || requestUrl.origin;
  return new URL(`/api/workspace/${encodeURIComponent(workspaceSlug)}/codesite`, configuredOrigin).toString().replace(/\/$/, '');
}

function timeoutSignal(timeoutMs) {
  return typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
    ? AbortSignal.timeout(timeoutMs)
    : undefined;
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

/**
 * Exercises the real frontend -> collab activity bridge without touching an
 * operator workspace. The transient record is always closed before returning.
 * The result intentionally contains only check states and identifiers, never
 * configured URLs, headers, or secret material.
 */
export async function probeCodeSiteActivityBridge(request, options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const workspaceSlug = options.workspaceSlug || READINESS_WORKSPACE_SLUG;
  const transactionId = options.transactionId || `readiness-${crypto.randomUUID()}`;
  const collabUrl = configuredCollabHttpUrl();
  const token = collabInternalToken();
  const timeoutMs = Number(options.timeoutMs || getCodeSiteRuntimeConfig().readinessTimeoutMs);

  if (!collabUrl || !token || typeof fetchImpl !== 'function') {
    return {
      ok: false,
      code: !collabUrl ? 'collab_url_unconfigured' : (!token ? 'collab_activity_token_unconfigured' : 'fetch_unavailable'),
      checks: { published: false, refreshed: false, cleaned: false },
    };
  }

  const activityUrl = new URL(`/codesite/activity/${encodeURIComponent(workspaceSlug)}`, `${collabUrl}/`);
  const controlPlaneUrl = controlPlaneUrlFor(request, workspaceSlug);
  const headers = {
    accept: 'application/json',
    'content-type': 'application/json',
    'x-collab-internal-token': token,
    'x-codesite-control-plane-url': controlPlaneUrl,
  };
  const checks = { published: false, refreshed: false, cleaned: false };
  let result;

  try {
    const published = await fetchImpl(activityUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        event: 'transaction_opened',
        transactionId,
        status: 'open',
        source: 'codesite_readiness_probe',
        controlPlaneUrl,
        // The close below is the normal cleanup path; this bounds a record if
        // the process dies between publish and cleanup.
        ttlMs: 15_000,
      }),
      signal: timeoutSignal(timeoutMs),
    });
    checks.published = Boolean(published?.ok);
    if (!checks.published) {
      result = { ok: false, code: 'activity_publish_failed', checks };
    } else {
      const refreshed = await fetchImpl(activityUrl, {
        method: 'GET',
        headers: { accept: 'application/json', 'x-collab-internal-token': token },
        signal: timeoutSignal(timeoutMs),
      });
      const refreshedBody = refreshed?.ok ? await responseJson(refreshed) : null;
      checks.refreshed = Boolean(refreshed?.ok)
        && Array.isArray(refreshedBody?.activeTransactions)
        && refreshedBody.activeTransactions.some((item) => item?.transactionId === transactionId);
      result = checks.refreshed
        ? { ok: true, checks }
        : { ok: false, code: 'activity_refresh_failed', checks };
    }
  } catch (_) {
    result = { ok: false, code: 'activity_probe_unreachable', checks };
  } finally {
    try {
      const closed = await fetchImpl(activityUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          event: 'transaction_closed',
          transactionId,
          status: 'closed',
          source: 'codesite_readiness_probe',
          controlPlaneUrl,
        }),
        signal: timeoutSignal(timeoutMs),
      });
      checks.cleaned = Boolean(closed?.ok);
    } catch (_) {
      checks.cleaned = false;
    }
  }
  if (result.ok && !checks.cleaned) {
    return { ok: false, code: 'activity_cleanup_failed', checks };
  }
  return result;
}

async function probeCollabDeploymentCapabilities(options = {}) {
  const fetchImpl = options.fetch || globalThis.fetch;
  const collabUrl = configuredCollabHttpUrl();
  const token = collabInternalToken();
  const timeoutMs = Number(options.timeoutMs || getCodeSiteRuntimeConfig().readinessTimeoutMs);
  if (!collabUrl || !token || typeof fetchImpl !== 'function') {
    return {
      ok: false,
      code: !collabUrl ? 'collab_url_unconfigured' : (!token ? 'collab_activity_token_unconfigured' : 'fetch_unavailable'),
      checks: {
        overlayCapable: { ok: false, code: 'overlay_capability_unavailable' },
        runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_health_unavailable' },
      },
    };
  }

  try {
    const response = await fetchImpl(new URL('/codesite/deployment-status', `${collabUrl}/`), {
      method: 'GET',
      headers: { accept: 'application/json', 'x-collab-internal-token': token },
      signal: timeoutSignal(timeoutMs),
    });
    const body = await responseJson(response);
    if (!response?.ok || !body?.ok) {
      return {
        ok: false,
        code: 'collab_deployment_status_failed',
        checks: {
          overlayCapable: { ok: false, code: 'overlay_capability_unavailable' },
          runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_health_unavailable' },
        },
      };
    }
    return {
      ok: true,
      checks: {
        overlayCapable: {
          ok: body.checks?.overlayCapable?.ok === true,
          code: body.checks?.overlayCapable?.code || 'overlay_capability_unavailable',
        },
        runtimeEventAdapterHealthy: {
          ok: body.checks?.runtimeEventAdapterHealthy?.ok === true,
          code: body.checks?.runtimeEventAdapterHealthy?.code || 'runtime_event_adapter_health_unavailable',
        },
      },
    };
  } catch (_) {
    return {
      ok: false,
      code: 'collab_deployment_status_unreachable',
      checks: {
        overlayCapable: { ok: false, code: 'overlay_capability_unavailable' },
        runtimeEventAdapterHealthy: { ok: false, code: 'runtime_event_adapter_health_unavailable' },
      },
    };
  }
}

export async function probeCodeSiteDeploymentStatus(request, options = {}) {
  const [activityBridge, capabilities] = await Promise.all([
    probeCodeSiteActivityBridge(request, options),
    probeCollabDeploymentCapabilities(options),
  ]);
  return { activityBridge, capabilities };
}
