const LOCAL_PREVIEW_HOSTS = new Set(['localhost', '127.0.0.1', '0.0.0.0', '::1', '[::1]']);
const LOOPBACK_CALLBACK_PARAM_RE = /(redirect|callback|return|continue|next|url|uri)/i;
const SCHEMELESS_LOOPBACK_RE = /^(localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|::1):\d+(?:[/?#]|$)/i;
// Terminal output can include OSC-8 hyperlink wrappers and ANSI/control bytes
// around a visible URL. Treat ASCII controls as hard URL boundaries so the
// detected relay link matches the clean URI xterm gives us on a direct click.
const TERMINAL_URL_RE = /\bhttps?:\/\/[^\s"'<>\x00-\x1F\x7F]+/gi;
const TERMINAL_URL_TRAILING_PUNCTUATION_RE = /[)\].,;:!?]+$/;
const TERMINAL_OSC_SEQUENCE_RE = /\x1B\][\s\S]*?(?:\x07|\x1B\\)/g;
const TERMINAL_CSI_SEQUENCE_RE = /\x1B\[[0-?]*[ -/]*[@-~]/g;
const TERMINAL_ESCAPE_SEQUENCE_RE = /\x1B[@-Z\\-_]/g;
const TERMINAL_CONTROL_RE = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const LOOPBACK_TEXT_HINT_RE = /localhost|127\.0\.0\.1|0\.0\.0\.0|::1|%2f%2flocalhost|%2f%2f127\.0\.0\.1|%2f%2f0\.0\.0\.0|%2f%2f%5b%3a%3a1%5d|%2f%2f%3a%3a1/i;

const LOOPBACK_AUTH_REQUEST_STORAGE_PREFIX = 'synthi.loopbackAuth.request:';
const LOOPBACK_AUTH_REQUEST_TTL_MS = 10 * 60 * 1000;

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

function getLoopbackAuthRequestStorage() {
  if (typeof globalThis === 'undefined') return null;
  try {
    return globalThis.localStorage || null;
  } catch (_) {
    return null;
  }
}

function hashLoopbackAuthRequest(rawUri, runtimeScope, context = {}) {
  const basis = [
    runtimeScope || '',
    context?.workspaceSlug || '',
    context?.terminalId || '',
    String(rawUri || ''),
  ].join('\n');
  let hash = 2166136261;
  for (let i = 0; i < basis.length; i += 1) {
    hash ^= basis.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `lr_${(hash >>> 0).toString(36)}`;
}

function cleanupExpiredLoopbackAuthRequests(storage, now = Date.now()) {
  if (!storage) return;
  try {
    const keys = [];
    for (let index = 0; index < storage.length; index += 1) {
      const key = storage.key(index);
      if (key?.startsWith(LOOPBACK_AUTH_REQUEST_STORAGE_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      try {
        const entry = JSON.parse(storage.getItem(key) || '{}');
        if (!entry?.createdAt || now - Number(entry.createdAt) > LOOPBACK_AUTH_REQUEST_TTL_MS) {
          storage.removeItem(key);
        }
      } catch (_) {
        storage.removeItem(key);
      }
    }
  } catch (_) {}
}

function persistLoopbackAuthRequest(relayKey, payload) {
  const storage = getLoopbackAuthRequestStorage();
  if (!storage || !relayKey || !payload?.authUrl) return false;
  try {
    cleanupExpiredLoopbackAuthRequests(storage);
    storage.setItem(`${LOOPBACK_AUTH_REQUEST_STORAGE_PREFIX}${relayKey}`, JSON.stringify({
      ...payload,
      createdAt: Date.now(),
    }));
    return true;
  } catch (_) {
    return false;
  }
}

export function readPersistedLoopbackAuthRequest(relayKey) {
  const storage = getLoopbackAuthRequestStorage();
  if (!storage || !relayKey) return null;
  const storageKey = `${LOOPBACK_AUTH_REQUEST_STORAGE_PREFIX}${relayKey}`;
  try {
    const entry = JSON.parse(storage.getItem(storageKey) || 'null');
    if (!entry?.authUrl || !entry?.createdAt) return null;
    if (Date.now() - Number(entry.createdAt) > LOOPBACK_AUTH_REQUEST_TTL_MS) {
      storage.removeItem(storageKey);
      return null;
    }
    return entry;
  } catch (_) {
    try { storage.removeItem(storageKey); } catch {}
    return null;
  }
}

export function buildLoopbackCallbackBridgeUrl(rawUri, runtimeScope, bridgeBaseUrl, context = {}) {
  if (!runtimeScope || !bridgeBaseUrl || !terminalLinkHasNestedLoopbackCallback(rawUri)) {
    return null;
  }

  try {
    const bridge = new URL(bridgeBaseUrl);
    bridge.searchParams.set('runtimeScope', runtimeScope);

    const contextPayload = {};
    for (const key of ['workspaceSlug', 'terminalId', 'runtimeKind', 'filesystemUserId', 'actorUserId', 'collabSessionId']) {
      const value = context?.[key];
      if (!value) continue;
      contextPayload[key] = String(value);
      bridge.searchParams.set(key, String(value));
    }

    const relayKey = hashLoopbackAuthRequest(rawUri, runtimeScope, contextPayload);
    const persisted = persistLoopbackAuthRequest(relayKey, {
      authUrl: rawUri,
      runtimeScope,
      context: contextPayload,
    });
    if (persisted) {
      bridge.searchParams.set('relayKey', relayKey);
    } else {
      bridge.searchParams.set('authUrl', rawUri);
    }

    return bridge.toString();
  } catch (_) {
    return null;
  }
}

function terminalUrlCandidates(rawMatch) {
  const candidates = [];
  const seen = new Set();
  const original = String(rawMatch || '').trim();
  let candidate = original.replace(TERMINAL_URL_TRAILING_PUNCTUATION_RE, '');

  while (candidate) {
    if (!seen.has(candidate)) {
      seen.add(candidate);
      candidates.push(candidate);
    }
    if (!TERMINAL_URL_TRAILING_PUNCTUATION_RE.test(candidate)) break;
    candidate = candidate.replace(TERMINAL_URL_TRAILING_PUNCTUATION_RE, '');
  }

  if (original && !seen.has(original)) {
    candidates.push(original);
  }

  return candidates;
}

function stripTerminalControlSequences(text) {
  return String(text || '')
    .replace(TERMINAL_OSC_SEQUENCE_RE, '')
    .replace(TERMINAL_CSI_SEQUENCE_RE, '')
    .replace(TERMINAL_ESCAPE_SEQUENCE_RE, '')
    .replace(TERMINAL_CONTROL_RE, '')
    .replace(/[\t\r\n]+/g, ' ');
}

function terminalLinkDetectionTexts(text) {
  const raw = String(text || '');
  const rendered = stripTerminalControlSequences(raw);
  return rendered && rendered !== raw ? [rendered, raw] : [raw];
}

function hasBrokenOAuthStateParam(rawUri) {
  const parsed = parseTerminalUrl(rawUri);
  if (!parsed?.searchParams?.has('state')) return false;
  return parsed.searchParams.getAll('state').some((state) => String(state || '').trim().length < 8);
}

export function findTerminalLoopbackAuthLinks(text, { runtimeScope, bridgeBaseUrl, loopbackContext, limit = 3 } = {}) {
  if (!text || !runtimeScope || !bridgeBaseUrl || !LOOPBACK_TEXT_HINT_RE.test(text)) {
    return [];
  }

  const links = [];
  const seen = new Set();
  const maxLinks = Math.max(1, Number(limit) || 3);

  for (const detectionText of terminalLinkDetectionTexts(text)) {
    if (links.length >= maxLinks) break;

    String(detectionText).replace(TERMINAL_URL_RE, (match) => {
      if (links.length >= maxLinks) return match;

      for (const candidate of terminalUrlCandidates(match)) {
        if (hasBrokenOAuthStateParam(candidate)) continue;
        const bridgeUrl = buildLoopbackCallbackBridgeUrl(candidate, runtimeScope, bridgeBaseUrl, loopbackContext);
        if (!bridgeUrl || seen.has(bridgeUrl)) continue;
        seen.add(bridgeUrl);
        links.push({ originalUrl: candidate, bridgeUrl });
        break;
      }

      return match;
    });
  }

  return links;
}

export function rewriteTerminalOutputLoopbackAuthLinks(text, { runtimeScope, bridgeBaseUrl, loopbackContext } = {}) {
  if (!text || !runtimeScope || !bridgeBaseUrl || !LOOPBACK_TEXT_HINT_RE.test(text)) {
    return text;
  }

  return String(text).replace(TERMINAL_URL_RE, (match) => {
    const bridgeUrl = buildLoopbackCallbackBridgeUrl(match, runtimeScope, bridgeBaseUrl, loopbackContext);
    return bridgeUrl || match;
  });
}
