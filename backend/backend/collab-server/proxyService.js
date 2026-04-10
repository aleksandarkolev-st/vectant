/**
 * proxyService.js — Port Scanner + Reverse Proxy for Synthi IDE
 *
 * Ported from the Rust `test-terminal-connection/web-term` sidecar into
 * the Node.js collab-server so everything runs as one process locally.
 *
 * Two responsibilities:
 *
 *   1. Port Scanner — periodically probes common dev-server ports on
 *      localhost and tracks which ones are alive.
 *
 *   2. Reverse Proxy — routes  HTTP  requests from `/port/<N>/...` to
 *      `http://127.0.0.1:<N>/...` so the Synthi IDE can preview running
 *      apps without exposing raw ports.  Also proxies WebSocket upgrades
 *      (critical for HMR / hot-reload in Next.js, Vite, etc.).
 *
 * In production (K8s):
 *   Set PROXY_TARGET_HOST to point at the workspace pod's IP instead of
 *   127.0.0.1.  The same code works unchanged.
 */

'use strict';

const http = require('http');
const net = require('net');
const { URL } = require('url');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Where proxied requests are forwarded to.  127.0.0.1 locally, pod IP in K8s. */
const PROXY_HOST = process.env.PROXY_TARGET_HOST || '127.0.0.1';

/** Ports to actively scan (covers most common dev frameworks). */
const SCAN_PORTS = [
  3000, 3001, 3002, 3003,   // React / Next.js
  4000, 4001, 4200,          // Angular / NestJS
  5000, 5001,                // Flask / .NET
  5173, 5174,                // Vite
  8000,                      // Django / FastAPI (8001 excluded — used by WebRTC worker WS)
  8080, 8081, 8888,          // misc / Jupyter
];

/** How often to re-scan (ms). */
const SCAN_INTERVAL_MS = 3000;

/** TCP connect timeout per port (ms). */
const PROBE_TIMEOUT_MS = 300;

/** HTTP proxy request timeout (ms). */
const PROXY_TIMEOUT_MS = 30_000;

// ─── State ──────────────────────────────────────────────────────────────────

/** @type {Set<number>} Currently active ports. */
const activePorts = new Set();

/** @type {Map<number, string>} Maps port → resolved host (127.0.0.1 or ::1). */
const portHostMap = new Map();

/** Listeners notified when the active port set changes. */
const changeListeners = [];

// ─── Port Scanner ───────────────────────────────────────────────────────────

/**
 * Probe a single port via TCP connect on a specific host.
 * @param {number} port
 * @param {string} host
 * @returns {Promise<boolean>}
 */
function probePortHost(port, host) {
  return new Promise((resolve) => {
    const sock = new net.Socket();
    sock.setTimeout(PROBE_TIMEOUT_MS);
    sock.once('connect', () => { sock.destroy(); resolve(true); });
    sock.once('timeout', () => { sock.destroy(); resolve(false); });
    sock.once('error',   () => { sock.destroy(); resolve(false); });
    sock.connect(port, host);
  });
}

/**
 * Probe a port on both IPv4 and IPv6.  Returns the host that responded,
 * or null if neither did.  Prefers the configured PROXY_HOST, falls back
 * to the other address family.
 * @param {number} port
 * @returns {Promise<string|null>}
 */
async function probePort(port) {
  // Try configured host first (usually 127.0.0.1)
  if (await probePortHost(port, PROXY_HOST)) return PROXY_HOST;
  // Try the other address family
  const alt = PROXY_HOST === '127.0.0.1' ? '::1' : '127.0.0.1';
  if (await probePortHost(port, alt)) return alt;
  return null;
}

/**
 * Run a single scan sweep.  Updates `activePorts` in-place and fires
 * change listeners when the set differs.
 */
async function scanOnce(serverPort) {
  const results = await Promise.all(
    SCAN_PORTS
      .filter((p) => p !== serverPort)               // never proxy ourselves
      .map(async (port) => ({ port, host: await probePort(port) }))
  );

  const found = new Set(results.filter((r) => r.host !== null).map((r) => r.port));
  // Update host map for each discovered port
  for (const r of results) {
    if (r.host) portHostMap.set(r.port, r.host);
    else portHostMap.delete(r.port);
  }

  // Diff
  const added   = [...found].filter((p) => !activePorts.has(p));
  const removed = [...activePorts].filter((p) => !found.has(p));

  if (added.length || removed.length) {
    activePorts.clear();
    for (const p of found) activePorts.add(p);

    if (added.length)   console.log(`[Proxy] Ports opened:  ${added.join(', ')}`);
    if (removed.length) console.log(`[Proxy] Ports closed:  ${removed.join(', ')}`);

    for (const fn of changeListeners) {
      try { fn([...activePorts]); } catch (_) { /* ignore */ }
    }
  }
}

let scanTimer = null;

/**
 * Start the background port scanner.
 * @param {number} serverPort - The collab-server's own port (excluded from scanning).
 */
function startScanner(serverPort) {
  if (scanTimer) return;
  // Immediate first scan
  scanOnce(serverPort).catch(() => {});
  scanTimer = setInterval(() => scanOnce(serverPort).catch(() => {}), SCAN_INTERVAL_MS);
  // Don't keep the process alive just for the scanner
  if (scanTimer.unref) scanTimer.unref();
  console.log(`[Proxy] Port scanner started (interval=${SCAN_INTERVAL_MS}ms, host=${PROXY_HOST})`);
}

function stopScanner() {
  if (scanTimer) { clearInterval(scanTimer); scanTimer = null; }
}

/**
 * Register a callback for port-set changes.
 * @param {(ports: number[]) => void} fn
 */
function onPortsChanged(fn) {
  changeListeners.push(fn);
}

/**
 * @returns {number[]} Currently detected active ports.
 */
function getActivePorts() {
  return [...activePorts];
}

// ─── MIME Helpers ────────────────────────────────────────────────────────────

const MIME_MAP = {
  '.js':    'application/javascript',
  '.mjs':   'application/javascript',
  '.css':   'text/css',
  '.json':  'application/json',
  '.html':  'text/html',
  '.htm':   'text/html',
  '.svg':   'image/svg+xml',
  '.png':   'image/png',
  '.jpg':   'image/jpeg',
  '.jpeg':  'image/jpeg',
  '.gif':   'image/gif',
  '.ico':   'image/x-icon',
  '.woff':  'font/woff',
  '.woff2': 'font/woff2',
  '.ttf':   'font/ttf',
  '.wasm':  'application/wasm',
  '.map':   'application/json',
};

function inferMime(urlPath) {
  const clean = (urlPath || '').split('?')[0].toLowerCase();
  for (const [ext, mime] of Object.entries(MIME_MAP)) {
    if (clean.endsWith(ext)) return mime;
  }
  return null;
}

// ─── HTTP Reverse Proxy ─────────────────────────────────────────────────────

/**
 * Parse a `/port/<N>/rest/of/path` URL.
 * @returns {{ port: number, downstream: string } | null}
 */
function parsePortUrl(urlString) {
  const match = /^\/port\/(\d+)(\/.*)?$/.exec(urlString);
  if (!match) return null;
  const port = parseInt(match[1], 10);
  const downstream = match[2] || '/';
  return { port, downstream };
}

/**
 * Handle an HTTP request that starts with /port/<N>/...
 * Proxies it to http://PROXY_HOST:<N>/...
 */
function proxyHttpRequest(clientReq, clientRes) {
  const parsed = parsePortUrl(clientReq.url);
  if (!parsed) {
    clientRes.writeHead(400, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: 'Invalid /port/<N>/path' }));
    return;
  }

  const { port, downstream } = parsed;

  if (!activePorts.has(port)) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: `Port ${port} is not active`, activePorts: [...activePorts] }));
    return;
  }

  // Build the proxied request
  const targetHost = portHostMap.get(port) || PROXY_HOST;
  const options = {
    hostname: targetHost,
    port,
    path: downstream,
    method: clientReq.method,
    headers: {
      ...clientReq.headers,
      host: `localhost:${port}`,   // Use 'localhost' so dev servers (Vite, etc.) accept it
    },
    timeout: PROXY_TIMEOUT_MS,
  };

  const proxyReq = http.request(options, (proxyRes) => {
    // Rewrite Content-Type for known extensions if upstream sends wrong type
    const headers = { ...proxyRes.headers };
    const inferred = inferMime(downstream);
    if (inferred && !headers['content-type']?.includes(inferred.split('/')[1])) {
      headers['content-type'] = inferred;
    }
    // CORS — allow the Synthi frontend to fetch
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['access-control-allow-headers'] = '*';

    clientRes.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy] HTTP proxy error for port ${port}:`, err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Upstream unreachable', detail: err.message }));
    }
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    if (!clientRes.headersSent) {
      clientRes.writeHead(504, { 'Content-Type': 'application/json' });
      clientRes.end(JSON.stringify({ error: 'Gateway timeout' }));
    }
  });

  // Pipe the client body to the upstream
  clientReq.pipe(proxyReq, { end: true });
}

// ─── WebSocket Reverse Proxy ────────────────────────────────────────────────

/**
 * Proxy a WebSocket upgrade for `/port/<N>/...` to the upstream dev server.
 * This is essential for HMR (Vite, Next.js, Webpack dev server).
 */
function proxyWsUpgrade(clientReq, clientSocket, head) {
  const parsed = parsePortUrl(clientReq.url);
  if (!parsed) {
    clientSocket.destroy();
    return false;
  }

  const { port, downstream } = parsed;

  if (!activePorts.has(port)) {
    clientSocket.destroy();
    return false;
  }

  // Open a raw TCP connection to the upstream
  const targetHost = portHostMap.get(port) || PROXY_HOST;
  const upstreamSocket = net.connect(port, targetHost, () => {
    // Reconstruct the HTTP upgrade request for the upstream
    const reqLine = `${clientReq.method} ${downstream} HTTP/1.1\r\n`;
    const headers = Object.entries(clientReq.headers)
      .filter(([k]) => k.toLowerCase() !== 'host')
      .map(([k, v]) => `${k}: ${v}`)
      .concat([`Host: localhost:${port}`])
      .join('\r\n');

    upstreamSocket.write(reqLine + headers + '\r\n\r\n');

    if (head && head.length) {
      upstreamSocket.write(head);
    }

    // Bidirectional pipe
    upstreamSocket.pipe(clientSocket);
    clientSocket.pipe(upstreamSocket);
  });

  upstreamSocket.on('error', (err) => {
    console.error(`[Proxy] WS proxy error for port ${port}:`, err.message);
    clientSocket.destroy();
  });

  upstreamSocket.setTimeout(PROXY_TIMEOUT_MS, () => {
    upstreamSocket.destroy();
    clientSocket.destroy();
  });

  clientSocket.on('error', () => upstreamSocket.destroy());

  return true;
}

// ─── Status Endpoint ────────────────────────────────────────────────────────

/**
 * Handle `GET /ports` — returns the list of active ports as JSON.
 */
function handlePortsStatus(req, res) {
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({ activePorts: [...activePorts], host: PROXY_HOST }));
}

// ─── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  startScanner,
  stopScanner,
  getActivePorts,
  onPortsChanged,
  proxyHttpRequest,
  proxyWsUpgrade,
  handlePortsStatus,
  parsePortUrl,
};
