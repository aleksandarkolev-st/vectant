/**
 * Synthi VS Code Tunnel Service Worker
 *
 * Intercepts HTTP requests from the code-server iframe and tunnels them
 * through BroadcastChannel → main page → VSCodeServerProxy → DataChannel
 * → vscode-server-manager → code-server.
 *
 * Uses BroadcastChannel instead of client.postMessage to avoid needing
 * the page to be "controlled" by the SW (eliminates controllerchange hang).
 *
 * Routing:
 *   1. Requests to /__vscode-proxy__/* → strip prefix, proxy to code-server
 *   2. Requests whose Referer starts with /__vscode-proxy__ (iframe sub-resources)
 */

const SW_VERSION = '2.0-broadcastchannel';
const PROXY_PREFIX = '/__vscode-proxy__';
let requestIdCounter = 0;
const pendingRequests = new Map();

// BroadcastChannel for communicating with the main page
const channel = new BroadcastChannel('vscode-tunnel');

console.log('[vscode-tunnel-sw] Script loaded, version:', SW_VERSION);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

self.addEventListener('install', () => {
  console.log('[vscode-tunnel-sw] Installing...');
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  console.log('[vscode-tunnel-sw] Activated');
  event.waitUntil(self.clients.claim());
});

// ---------------------------------------------------------------------------
// BroadcastChannel responses from the main page
// ---------------------------------------------------------------------------

channel.addEventListener('message', (event) => {
  const msg = event.data;
  if (!msg || msg.type !== 'vscode-proxy-response') return;

  console.log('[vscode-tunnel-sw] Got proxy response via BroadcastChannel, id:', msg.id, 'status:', msg.status);
  const pending = pendingRequests.get(msg.id);
  if (!pending) return;
  pendingRequests.delete(msg.id);

  try {
    const bodyBytes = msg.body
      ? Uint8Array.from(atob(msg.body), c => c.charCodeAt(0))
      : new Uint8Array(0);

    const respHeaders = new Headers();
    if (msg.headers) {
      for (const [key, value] of Object.entries(msg.headers)) {
        const lk = key.toLowerCase();
        // Skip hop-by-hop and encoding headers
        if (lk === 'content-encoding' || lk === 'transfer-encoding' || lk === 'content-length') continue;
        try { respHeaders.set(key, value); } catch (_) {}
      }
    }
    respHeaders.set('content-length', String(bodyBytes.length));

    pending.resolve(new Response(bodyBytes, {
      status: msg.status || 200,
      statusText: msg.statusText || '',
      headers: respHeaders,
    }));
  } catch (err) {
    pending.resolve(new Response(`SW proxy error: ${err.message}`, { status: 502 }));
  }
});

// ---------------------------------------------------------------------------
// Fetch interception
// ---------------------------------------------------------------------------

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // Case 1: Explicit proxy-prefixed request (iframe navigation + prefixed sub-resources)
  if (url.pathname.startsWith(PROXY_PREFIX + '/') || url.pathname === PROXY_PREFIX) {
    let targetPath = url.pathname.slice(PROXY_PREFIX.length) || '/';
    if (url.search) targetPath += url.search;
    console.log('[vscode-tunnel-sw] Intercepting proxy request:', event.request.method, targetPath);
    event.respondWith(proxyFetch(event.request, targetPath));
    return;
  }

  // Case 2: Sub-resource from within the code-server iframe (detected by Referer)
  const referer = event.request.referrer || '';
  if (referer) {
    try {
      const refUrl = new URL(referer);
      if (refUrl.pathname.startsWith(PROXY_PREFIX + '/') || refUrl.pathname === PROXY_PREFIX) {
        let targetPath = url.pathname;
        if (url.search) targetPath += url.search;
        console.log('[vscode-tunnel-sw] Intercepting sub-resource (via Referer):', event.request.method, targetPath);
        event.respondWith(proxyFetch(event.request, targetPath));
        return;
      }
    } catch (_) {}
  }

  // Everything else — pass through to network
});

// ---------------------------------------------------------------------------
// Proxy fetch — sends request via BroadcastChannel, waits for response
// ---------------------------------------------------------------------------

async function proxyFetch(request, targetPath) {
  const id = ++requestIdCounter;

  // Read request body
  let bodyBase64 = null;
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    try {
      const buf = await request.arrayBuffer();
      if (buf.byteLength > 0) {
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.length; i++) {
          binary += String.fromCharCode(bytes[i]);
        }
        bodyBase64 = btoa(binary);
      }
    } catch (_) {}
  }

  // Collect request headers
  const headers = {};
  for (const [key, value] of request.headers.entries()) {
    const lk = key.toLowerCase();
    if (lk === 'host' || lk === 'origin' || lk === 'service-worker') continue;
    headers[key] = value;
  }

  // Create pending promise with timeout
  const responsePromise = new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      resolve(new Response('Proxy request timeout (30s)', { status: 504 }));
    }, 30000);

    pendingRequests.set(id, {
      resolve: (resp) => {
        clearTimeout(timer);
        resolve(resp);
      },
    });
  });

  // Send via BroadcastChannel (no need for client lookup)
  console.log('[vscode-tunnel-sw] Sending proxy request via BroadcastChannel, id:', id, 'path:', targetPath);
  channel.postMessage({
    type: 'vscode-proxy-request',
    id,
    method: request.method,
    path: targetPath,
    headers,
    body: bodyBase64,
  });

  return responsePromise;
}
