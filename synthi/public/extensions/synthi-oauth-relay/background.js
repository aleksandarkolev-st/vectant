const STORAGE_KEYS = {
  armedSession: 'synthi.oauthRelay.armedSession',
  lastSubmission: 'synthi.oauthRelay.lastSubmission',
};

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const DEFAULT_ENDPOINT_PATH = '/api/oauth-relay/callback';
const MAX_SESSION_AGE_MS = 15 * 60 * 1000;

let pendingSessionId = '';

function storageArea() {
  return chrome.storage.session || chrome.storage.local;
}

function now() {
  return Date.now();
}

function normalizeLoopbackHost(value) {
  const host = String(value || '').trim().toLowerCase();
  return host === '[::1]' ? '::1' : host;
}

function parseUrl(value) {
  try {
    return new URL(String(value || '').trim());
  } catch {
    return null;
  }
}

function parseLoopbackUrl(value) {
  const parsed = parseUrl(value);
  if (!parsed) return null;

  const host = normalizeLoopbackHost(parsed.hostname);
  const port = Number(parsed.port);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (!LOOPBACK_HOSTS.has(host)) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;

  return {
    href: parsed.href,
    host,
    port,
    path: parsed.pathname || '/',
  };
}

function pathMatchesPrefix(path, prefix) {
  if (!prefix || prefix === '/') return true;
  if (path === prefix) return true;
  const normalized = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return path.startsWith(normalized);
}

function expectedMatches(session, loopback) {
  const expected = session?.expectedCallback || {};
  if (expected.host && normalizeLoopbackHost(expected.host) !== loopback.host) return false;
  if (expected.port && Number(expected.port) !== loopback.port) return false;
  if (expected.pathPrefix && !pathMatchesPrefix(loopback.path, String(expected.pathPrefix))) return false;
  return true;
}

function isExpired(session) {
  const expiresAt = Date.parse(session?.expiresAt || '');
  if (Number.isNaN(expiresAt)) return true;
  if (expiresAt <= now()) return true;
  const armedAt = Number(session?.armedAt || 0);
  return Boolean(armedAt && now() - armedAt > MAX_SESSION_AGE_MS);
}

async function getStored(key) {
  const data = await storageArea().get(key);
  return data?.[key] || null;
}

async function setStored(key, value) {
  await storageArea().set({ [key]: value });
}

async function removeStored(key) {
  await storageArea().remove(key);
}

function normalizeEndpoint(endpoint, senderUrl) {
  const sender = parseUrl(senderUrl);
  const configured = parseUrl(endpoint);
  const base = configured || (sender ? new URL(DEFAULT_ENDPOINT_PATH, sender.origin) : null);
  if (!base || base.protocol !== 'https:') return null;
  if (sender && base.origin !== sender.origin) return null;
  return base.href;
}

function normalizeExpectedCallback(value) {
  const expected = value && typeof value === 'object' ? value : {};
  const host = normalizeLoopbackHost(expected.host);
  const port = Number(expected.port);
  const pathPrefix = String(expected.pathPrefix || '').trim();
  return {
    ...(LOOPBACK_HOSTS.has(host) ? { host } : {}),
    ...(Number.isInteger(port) && port >= 1 && port <= 65535 ? { port } : {}),
    ...(pathPrefix ? { pathPrefix: pathPrefix.startsWith('/') ? pathPrefix : `/${pathPrefix}` } : {}),
  };
}

async function armRelay(payload, sender) {
  const sessionId = String(payload?.sessionId || '').trim();
  const workspaceSlug = String(payload?.workspaceSlug || '').trim();
  const runtimeScope = String(payload?.runtimeScope || '').trim();
  const endpoint = normalizeEndpoint(payload?.endpoint, sender?.url || sender?.origin);
  const expiresAt = String(payload?.expiresAt || '').trim();

  if (!sessionId || !workspaceSlug || !runtimeScope || !endpoint || Number.isNaN(Date.parse(expiresAt))) {
    return { ok: false, installed: true, error: 'invalid_relay_session' };
  }

  const session = {
    sessionId,
    workspaceSlug,
    runtimeScope,
    terminalId: String(payload?.terminalId || '').trim(),
    expectedCallback: normalizeExpectedCallback(payload?.expectedCallback),
    endpoint,
    expiresAt,
    armedAt: now(),
  };

  await setStored(STORAGE_KEYS.armedSession, session);
  return {
    ok: true,
    installed: true,
    armed: true,
    sessionId,
    workspaceSlug,
    runtimeScope,
    expiresAt,
    lastSubmission: await getStored(STORAGE_KEYS.lastSubmission),
  };
}

async function extensionStatus() {
  const session = await getStored(STORAGE_KEYS.armedSession);
  const lastSubmission = await getStored(STORAGE_KEYS.lastSubmission);
  if (!session || isExpired(session)) {
    await removeStored(STORAGE_KEYS.armedSession);
    return {
      installed: true,
      armed: false,
      lastSubmission,
    };
  }

  return {
    installed: true,
    armed: true,
    sessionId: session.sessionId,
    workspaceSlug: session.workspaceSlug,
    runtimeScope: session.runtimeScope,
    expiresAt: session.expiresAt,
    lastSubmission,
  };
}

async function clearRelay() {
  await removeStored(STORAGE_KEYS.armedSession);
  return {
    installed: true,
    armed: false,
    lastSubmission: await getStored(STORAGE_KEYS.lastSubmission),
  };
}

async function submitCallback(session, callbackUrl, source) {
  if (!session?.sessionId || pendingSessionId === session.sessionId) return;
  pendingSessionId = session.sessionId;

  try {
    const response = await fetch(session.endpoint, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionId: session.sessionId,
        workspaceSlug: session.workspaceSlug,
        callbackUrl,
      }),
    });
    const body = await response.json().catch(() => ({}));
    const result = {
      sessionId: session.sessionId,
      ok: response.ok && body?.ok !== false,
      statusCode: body?.statusCode || response.status,
      error: response.ok ? '' : body?.error || `HTTP ${response.status}`,
      source,
      submittedAt: new Date().toISOString(),
    };
    await setStored(STORAGE_KEYS.lastSubmission, result);
    if (result.ok) {
      await removeStored(STORAGE_KEYS.armedSession);
    }
  } catch (err) {
    await setStored(STORAGE_KEYS.lastSubmission, {
      sessionId: session.sessionId,
      ok: false,
      error: err?.message || 'callback_submit_failed',
      source,
      submittedAt: new Date().toISOString(),
    });
  } finally {
    pendingSessionId = '';
  }
}

async function maybeRelayNavigation(details, source) {
  if (!details || details.frameId !== 0) return;
  const loopback = parseLoopbackUrl(details.url);
  if (!loopback) return;

  const session = await getStored(STORAGE_KEYS.armedSession);
  if (!session || isExpired(session)) {
    await removeStored(STORAGE_KEYS.armedSession);
    return;
  }
  if (!expectedMatches(session, loopback)) return;

  await submitCallback(session, loopback.href, source);
}

function handleRuntimeMessage(message, sender, sendResponse) {
  const type = message?.type;
  const payload = message?.payload || {};

  (async () => {
    if (type === 'SYNTHI_OAUTH_RELAY_STATUS') {
      return extensionStatus();
    }
    if (type === 'SYNTHI_OAUTH_RELAY_ARM') {
      return armRelay(payload, sender);
    }
    if (type === 'SYNTHI_OAUTH_RELAY_CLEAR') {
      return clearRelay();
    }
    return { installed: true, ok: false, error: 'unknown_message_type' };
  })()
    .then(sendResponse)
    .catch((err) => sendResponse({
      installed: true,
      ok: false,
      error: err?.message || 'extension_message_failed',
    }));

  return true;
}

chrome.runtime.onMessage.addListener(handleRuntimeMessage);
chrome.runtime.onMessageExternal?.addListener(handleRuntimeMessage);
chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  maybeRelayNavigation(details, 'onBeforeNavigate');
});
chrome.webNavigation.onErrorOccurred.addListener((details) => {
  maybeRelayNavigation(details, 'onErrorOccurred');
});

