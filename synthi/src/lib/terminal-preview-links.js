const LOCAL_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const LOOPBACK_CALLBACK_PARAM_RE = /(redirect|callback|return|continue|next|url|uri)/i;
const SCHEMELESS_LOOPBACK_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):\d+(?:[/?#]|$)/i;
const TERMINAL_URL_RE = /\bhttps?:\/\/[^\s"'<>]+/gi;

export function parseTerminalUrl(rawUri) {
  if (!rawUri || typeof rawUri !== 'string') return null;
  const uri = rawUri.trim();
  try {
    if (SCHEMELESS_LOOPBACK_RE.test(uri)) {
      return new URL(`http://${uri}`);
    }
    return new URL(uri);
  } catch (_) {
    try {
      return new URL(`http://${uri}`);
    } catch (_) {
      return null;
    }
  }
}

export function isRuntimeLoopbackUrl(parsed) {
  return Boolean(parsed?.port && LOCAL_PREVIEW_HOSTS.has(parsed.hostname));
}

export function buildRuntimePreviewPathUrl(rawUri, runtimeScope, windowOrigin = '') {
  if (!runtimeScope || !windowOrigin) return null;
  const parsed = parseTerminalUrl(rawUri);
  if (!isRuntimeLoopbackUrl(parsed)) return null;

  const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/';
  return `${windowOrigin}/collab/runtime/${encodeURIComponent(runtimeScope)}/port/${encodeURIComponent(parsed.port)}${path}${parsed.search}${parsed.hash}`;
}

function shouldInspectTerminalLinkParam(key, value) {
  if (!key || !value) return false;
  if (LOOPBACK_CALLBACK_PARAM_RE.test(key)) return true;
  return /^https?:\/\//i.test(value) || /^https?%3a%2f%2f/i.test(value);
}

function hasRuntimeLoopbackParam(params) {
  for (const [key, value] of params) {
    if (!shouldInspectTerminalLinkParam(key, value)) continue;
    if (isRuntimeLoopbackUrl(parseTerminalUrl(value))) return true;
  }
  return false;
}

function hashParamsFromUrl(parsed) {
  const rawHash = parsed?.hash ? parsed.hash.slice(1) : '';
  if (!rawHash || !rawHash.includes('=')) return null;
  const body = rawHash.startsWith('?') ? rawHash.slice(1) : rawHash;
  return new URLSearchParams(body);
}

export function terminalLinkNeedsRuntimeResolution(rawUri) {
  const parsed = parseTerminalUrl(rawUri);
  if (!parsed) return false;
  if (isRuntimeLoopbackUrl(parsed)) return true;
  if (hasRuntimeLoopbackParam(parsed.searchParams)) return true;
  const hashParams = hashParamsFromUrl(parsed);
  return hashParams ? hasRuntimeLoopbackParam(hashParams) : false;
}

export function terminalLinkHasNestedLoopbackCallback(rawUri) {
  const parsed = parseTerminalUrl(rawUri);
  if (!parsed || isRuntimeLoopbackUrl(parsed)) return false;
  if (hasRuntimeLoopbackParam(parsed.searchParams)) return true;
  const hashParams = hashParamsFromUrl(parsed);
  return hashParams ? hasRuntimeLoopbackParam(hashParams) : false;
}

export async function resolveRuntimePreviewUrl(rawUri, runtimeScope, options = {}) {
  const windowOrigin = options.windowOrigin || '';
  const fallbackUrl = buildRuntimePreviewPathUrl(rawUri, runtimeScope, windowOrigin);
  const parsed = parseTerminalUrl(rawUri);
  if (!runtimeScope || !parsed || !isRuntimeLoopbackUrl(parsed)) {
    return fallbackUrl || rawUri;
  }

  const terminalHttpUrl = String(options.terminalHttpUrl || '').replace(/\/+$/, '');
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  if (!terminalHttpUrl || typeof fetchImpl !== 'function') {
    return fallbackUrl || rawUri;
  }

  try {
    const path = parsed.pathname && parsed.pathname !== '/' ? parsed.pathname : '/';
    const previewPath = `${path}${parsed.search}${parsed.hash}`;
    const params = new URLSearchParams({
      runtimeScope,
      port: parsed.port,
      path: previewPath,
    });
    const response = await fetchImpl(`${terminalHttpUrl}/preview-url?${params.toString()}`, {
      method: 'GET',
      credentials: 'same-origin',
    });
    if (!response.ok) return fallbackUrl || rawUri;
    const data = await response.json();
    if (options.preferPathUrl && data?.pathUrl) return data.pathUrl;
    return data?.url || data?.publicUrl || fallbackUrl || rawUri;
  } catch (_) {
    return fallbackUrl || rawUri;
  }
}

async function rewriteLoopbackParams(params, runtimeScope, options) {
  const next = new URLSearchParams();
  let changed = false;

  for (const [key, value] of params) {
    let nextValue = value;
    if (shouldInspectTerminalLinkParam(key, value) && isRuntimeLoopbackUrl(parseTerminalUrl(value))) {
      nextValue = await resolveRuntimePreviewUrl(value, runtimeScope, options);
      changed = changed || nextValue !== value;
    }
    next.append(key, nextValue);
  }

  return { changed, params: next };
}

export async function resolveTerminalLinkUrl(rawUri, runtimeScope, options = {}) {
  const bridgeUrl = buildLoopbackCallbackBridgeUrl(
    rawUri,
    runtimeScope,
    options.loopbackCallbackBridgeUrl,
    options.loopbackContext || options,
  );
  if (bridgeUrl) return bridgeUrl;

  const directPreview = await resolveRuntimePreviewUrl(rawUri, runtimeScope, options);
  if (directPreview !== rawUri) return directPreview;

  const parsed = parseTerminalUrl(rawUri);
  if (!parsed || !runtimeScope) return rawUri;

  const rewrittenSearch = await rewriteLoopbackParams(parsed.searchParams, runtimeScope, options);
  if (rewrittenSearch.changed) parsed.search = rewrittenSearch.params.toString();

  const hashParams = hashParamsFromUrl(parsed);
  let hashChanged = false;
  if (hashParams) {
    const rewrittenHash = await rewriteLoopbackParams(hashParams, runtimeScope, options);
    hashChanged = rewrittenHash.changed;
    if (hashChanged) parsed.hash = rewrittenHash.params.toString();
  }

  return rewrittenSearch.changed || hashChanged ? parsed.toString() : rawUri;
}

export function buildLoopbackCallbackBridgeUrl(rawUri, runtimeScope, bridgeBaseUrl, context = {}) {
  if (!runtimeScope || !bridgeBaseUrl || !terminalLinkHasNestedLoopbackCallback(rawUri)) {
    return null;
  }

  try {
    const bridge = new URL(bridgeBaseUrl);
    bridge.searchParams.set('runtimeScope', runtimeScope);
    bridge.searchParams.set('authUrl', rawUri);
    for (const key of ['workspaceSlug', 'terminalId', 'runtimeKind', 'filesystemUserId', 'actorUserId', 'collabSessionId']) {
      const value = context?.[key];
      if (value) bridge.searchParams.set(key, String(value));
    }
    return bridge.toString();
  } catch (_) {
    return null;
  }
}

export function rewriteTerminalOutputLoopbackAuthLinks(text, { runtimeScope, bridgeBaseUrl, loopbackContext } = {}) {
  if (!text || !runtimeScope || !bridgeBaseUrl || !/localhost|127\.0\.0\.1|0\.0\.0\.0|%2f%2flocalhost|%2f%2f127\.0\.0\.1|%2f%2f0\.0\.0\.0/i.test(text)) {
    return text;
  }

  return String(text).replace(TERMINAL_URL_RE, (match) => {
    const bridgeUrl = buildLoopbackCallbackBridgeUrl(match, runtimeScope, bridgeBaseUrl, loopbackContext);
    return bridgeUrl || match;
  });
}
