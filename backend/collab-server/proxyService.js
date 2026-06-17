/**
 * proxyService.js — Port Scanner + Reverse Proxy for Synthi IDE
 *
 * Ported from the Rust `test-terminal-connection/web-term` sidecar into
 * the Node.js collab-server so everything runs as one process locally.
 *
 * Two responsibilities:
 *
 *   1. Port Scanner — discovers listening workspace ports from /proc and
 *      probes them, with a configurable fallback list for environments where
 *      socket discovery is unavailable.
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
const fs = require('fs');
const path = require('path');
const { URL } = require('url');
const { runtimeResourceId } = require('./runtimeIdentity');

// ─── Configuration ──────────────────────────────────────────────────────────

/** Where proxied requests are forwarded to.  127.0.0.1 locally, pod IP in K8s. */
const PROXY_HOST = process.env.PROXY_TARGET_HOST || '127.0.0.1';

/**
 * Optional production target template for runtime-scoped previews.
 * Example: http://{runtimeId}.synthi.svc.cluster.local:{sidecarPort}{sidecarPrefix}/{port}
 */
const PREVIEW_TARGET_TEMPLATE = process.env.SYNTHI_PREVIEW_TARGET_TEMPLATE || '';
const PREVIEW_SIDECAR_PORT = String(process.env.SYNTHI_PREVIEW_SIDECAR_PORT || '18080');
const PREVIEW_SIDECAR_PREFIX = normalizePathPrefix(process.env.SYNTHI_PREVIEW_SIDECAR_PREFIX || '/__synthi_preview') || '/__synthi_preview';

/** Fallback ports to actively scan when socket discovery is unavailable. */
const DEFAULT_SCAN_PORTS = [];

/** Extra/fallback scan ports. Comma-separated values and ranges are accepted. */
const CONFIGURED_SCAN_PORTS = parsePortList(
  process.env.PROXY_SCAN_PORTS ||
  process.env.SYNTHI_PREVIEW_SCAN_PORTS ||
  DEFAULT_SCAN_PORTS.join(',')
);

/** Repo roots used to attribute a listening process to a workspace. */
const REPO_ROOTS = [
  process.env.REPOS_DIR,
  process.env.REPO_CACHE_DIR,
  '/data/repos',
].filter((value, index, arr) => value && arr.indexOf(value) === index);

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

/** @type {Map<number, { port: number, pid?: number, cwd?: string, command?: string, workspaceSlug?: string, runtimeScope?: string }>} */
const portProcessMap = new Map();

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
  const discovered = discoverListeningPorts();
  const discoveredPorts = [...discovered.keys()];
  const portsToProbe = [...new Set([
    ...discoveredPorts,
    ...CONFIGURED_SCAN_PORTS,
  ])]
    .filter((port) => port !== serverPort)
    .sort((a, b) => a - b);

  const results = await Promise.all(
    portsToProbe
      .map(async (port) => ({ port, host: await probePort(port) }))
  );

  const found = new Set(results.filter((r) => r.host !== null).map((r) => r.port));
  // Update host map for each discovered port
  for (const r of results) {
    if (r.host) {
      portHostMap.set(r.port, r.host);
      const processInfo = discovered.get(r.port);
      if (processInfo) portProcessMap.set(r.port, processInfo);
      else portProcessMap.delete(r.port);
    } else {
      portHostMap.delete(r.port);
      portProcessMap.delete(r.port);
    }
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
  console.log(`[Proxy] Port scanner started (interval=${SCAN_INTERVAL_MS}ms, host=${PROXY_HOST}, fallbackPorts=${CONFIGURED_SCAN_PORTS.join(',')})`);
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
 * Parse a `/port/<N>/rest/of/path` or
 * `/runtime/<scope>/port/<N>/rest/of/path` URL.
 * @returns {{ port: number, downstream: string, runtimeScope: string|null } | null}
 */
function parsePortUrl(urlString) {
  let pathname = urlString || '/';
  let search = '';
  try {
    const parsed = new URL(urlString || '/', 'http://proxy.local');
    pathname = parsed.pathname;
    search = parsed.search || '';
  } catch (_) {
    const q = pathname.indexOf('?');
    if (q !== -1) {
      search = pathname.slice(q);
      pathname = pathname.slice(0, q);
    }
  }

  let match = /^\/runtime\/([^/]+)\/port\/(\d+)(\/.*)?$/.exec(pathname);
  if (match) {
    const port = parseInt(match[2], 10);
    const downstream = (match[3] || '/') + search;
    return { port, downstream, runtimeScope: decodeURIComponent(match[1]) };
  }

  match = /^\/port\/(\d+)(\/.*)?$/.exec(pathname);
  if (!match) return null;
  const port = parseInt(match[1], 10);
  const downstream = (match[2] || '/') + search;
  return { port, downstream, runtimeScope: null };
}

function normalizePathPrefix(value) {
  const raw = String(value || '').trim();
  if (!raw || raw === '/') return '';
  return `/${raw.replace(/^\/+|\/+$/g, '')}`;
}

function joinTargetPath(pathPrefix, downstream) {
  const prefix = normalizePathPrefix(pathPrefix);
  const tail = downstream && downstream.startsWith('/') ? downstream : `/${downstream || ''}`;
  return `${prefix}${tail}` || '/';
}

function previewTargetFor(port, runtimeScope) {
  if (runtimeScope && PREVIEW_TARGET_TEMPLATE) {
    const runtimeId = runtimeResourceId(runtimeScope);
    const rendered = PREVIEW_TARGET_TEMPLATE
      .replaceAll('{runtimeId}', runtimeId)
      .replaceAll('{runtimeScope}', runtimeId)
      .replaceAll('{sidecarPort}', PREVIEW_SIDECAR_PORT)
      .replaceAll('{sidecarPrefix}', PREVIEW_SIDECAR_PREFIX)
      .replaceAll('{port}', String(port));
    try {
      const url = new URL(rendered);
      return {
        hostname: url.hostname,
        port: Number(url.port) || port,
        protocol: url.protocol,
        pathPrefix: normalizePathPrefix(url.pathname),
      };
    } catch (err) {
      console.error('[Proxy] Invalid SYNTHI_PREVIEW_TARGET_TEMPLATE:', err.message);
    }
  }
  return {
    hostname: portHostMap.get(port) || PROXY_HOST,
    port,
    protocol: 'http:',
    pathPrefix: '',
  };
}

function portAllowedForRuntime(port, runtimeScope) {
  if (!runtimeScope) return true;
  const processInfo = portProcessMap.get(port);
  if (!processInfo?.runtimeScope) return true; // legacy process; keep local preview usable
  return processInfo.runtimeScope === runtimeScope;
}

function usesRemoteRuntimeTarget(runtimeScope) {
  return Boolean(runtimeScope && PREVIEW_TARGET_TEMPLATE);
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

  const { port, downstream, runtimeScope } = parsed;

  if (!usesRemoteRuntimeTarget(runtimeScope) && !activePorts.has(port)) {
    clientRes.writeHead(502, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: `Port ${port} is not active`, activePorts: [...activePorts] }));
    return;
  }

  if (!portAllowedForRuntime(port, runtimeScope)) {
    clientRes.writeHead(404, { 'Content-Type': 'application/json' });
    clientRes.end(JSON.stringify({ error: `Port ${port} is not active for this runtime scope` }));
    return;
  }

  // Build the proxied request
  const target = previewTargetFor(port, runtimeScope);
  const targetPath = joinTargetPath(target.pathPrefix, downstream);
  const options = {
    hostname: target.hostname,
    port: target.port,
    path: targetPath,
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
    const existingContentType = String(headers['content-type'] || '').toLowerCase();
    if (inferred && (!existingContentType || existingContentType.includes('text/plain') || existingContentType.includes('application/octet-stream'))) {
      headers['content-type'] = inferred;
    }
    // CORS — allow the Synthi frontend to fetch
    headers['access-control-allow-origin'] = '*';
    headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
    headers['access-control-allow-headers'] = '*';

    if (shouldRewriteBody(headers)) {
      const chunks = [];
      proxyRes.on('data', (chunk) => chunks.push(chunk));
      proxyRes.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        const rewritten = rewriteRootAbsoluteUrls(body, port, runtimeScope);
        delete headers['content-length'];
        delete headers['content-encoding'];
        clientRes.writeHead(proxyRes.statusCode, headers);
        clientRes.end(rewritten);
      });
      return;
    }

    clientRes.writeHead(proxyRes.statusCode, headers);
    proxyRes.pipe(clientRes, { end: true });
  });

  proxyReq.on('error', (err) => {
    console.error(`[Proxy] HTTP proxy error for port ${port} runtime=${runtimeScope || 'legacy'}:`, err.message);
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

function shouldRewriteBody(headers) {
  if (headers['content-encoding']) return false;
  const contentType = String(headers['content-type'] || '').toLowerCase();
  return (
    contentType.includes('text/html') ||
    contentType.includes('javascript') ||
    contentType.includes('text/css')
  );
}

function rewriteRootAbsoluteUrls(body, port, runtimeScope = null) {
  const prefix = runtimeScope
    ? `/runtime/${encodeURIComponent(runtimeScope)}/port/${port}`
    : `/port/${port}`;
  return body
    .replace(/(["'`])\/(?!\/|port\/|runtime\/)/g, `$1${prefix}/`)
    .replace(/(url\(\s*["']?)\/(?!\/|port\/|runtime\/)/g, `$1${prefix}/`);
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

  const { port, downstream, runtimeScope } = parsed;

  if (!usesRemoteRuntimeTarget(runtimeScope) && !activePorts.has(port)) {
    clientSocket.destroy();
    return false;
  }

  if (!portAllowedForRuntime(port, runtimeScope)) {
    clientSocket.destroy();
    return false;
  }

  // Open a raw TCP connection to the upstream
  const target = previewTargetFor(port, runtimeScope);
  const upstreamSocket = net.connect(target.port, target.hostname, () => {
    // Reconstruct the HTTP upgrade request for the upstream
    const targetPath = joinTargetPath(target.pathPrefix, downstream);
    const reqLine = `${clientReq.method} ${targetPath} HTTP/1.1\r\n`;
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
    console.error(`[Proxy] WS proxy error for port ${port} runtime=${runtimeScope || 'legacy'}:`, err.message);
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
  const requestedWorkspace = workspaceFilterFromReq(req);
  const requestedRuntimeScope = runtimeScopeFilterFromReq(req);
  const allPorts = [...activePorts].sort((a, b) => a - b);
  const hasRuntimeAttribution = allPorts.some((port) => Boolean(portProcessMap.get(port)?.runtimeScope));
  const runtimePorts = requestedRuntimeScope && hasRuntimeAttribution
    ? allPorts.filter((port) => portMatchesRuntimeScope(port, requestedRuntimeScope))
    : allPorts;
  const workspacePorts = requestedWorkspace
    ? runtimePorts.filter((port) => portMatchesWorkspace(port, requestedWorkspace))
    : runtimePorts;
  const hasWorkspaceAttribution = allPorts.some((port) => Boolean(portProcessMap.get(port)?.workspaceSlug));
  const ports = requestedRuntimeScope && (runtimePorts.length > 0 || hasRuntimeAttribution)
    ? workspacePorts
    : requestedWorkspace && (workspacePorts.length > 0 || hasWorkspaceAttribution)
    ? workspacePorts
    : allPorts;
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify({
    activePorts: ports,
    allActivePorts: allPorts,
    host: PROXY_HOST,
    workspace: requestedWorkspace,
    runtimeScope: requestedRuntimeScope,
    previews: ports.map((port) => previewForPort(port, requestedRuntimeScope)),
  }));
}

function previewForPort(port, requestedRuntimeScope = null) {
  const processInfo = portProcessMap.get(port);
  const runtimeScope = processInfo?.runtimeScope || requestedRuntimeScope || null;
  const target = previewTargetFor(port, runtimeScope);
  return {
    port,
    url: runtimeScope
      ? `/runtime/${encodeURIComponent(runtimeScope)}/port/${port}/`
      : `/port/${port}/`,
    target: `http://${target.hostname}:${target.port}${target.pathPrefix || '/'}`,
    workspace: processInfo?.workspaceSlug ?? null,
    runtimeScope,
    attributed: Boolean(processInfo?.workspaceSlug),
  };
}

function workspaceFilterFromReq(req) {
  try {
    const parsed = new URL(req.url || '/ports', 'http://collab.local');
    const value = parsed.searchParams.get('workspace') || parsed.searchParams.get('slug');
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function runtimeScopeFilterFromReq(req) {
  try {
    const parsed = new URL(req.url || '/ports', 'http://collab.local');
    const value = parsed.searchParams.get('runtimeScope') || parsed.searchParams.get('scope');
    return value && value.trim() ? value.trim() : null;
  } catch {
    return null;
  }
}

function portMatchesWorkspace(port, workspaceSlug) {
  return portProcessMap.get(port)?.workspaceSlug === workspaceSlug;
}

function portMatchesRuntimeScope(port, runtimeScope) {
  return portProcessMap.get(port)?.runtimeScope === runtimeScope;
}

function parsePortList(value) {
  if (!value) return [];
  const ports = new Set();
  for (const rawPart of String(value).split(',')) {
    const part = rawPart.trim();
    if (!part) continue;
    const range = part.match(/^(\d+)\s*-\s*(\d+)$/);
    if (range) {
      const start = Number(range[1]);
      const end = Number(range[2]);
      if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
      for (let port = Math.max(1, Math.min(start, end)); port <= Math.min(65535, Math.max(start, end)); port += 1) {
        ports.add(port);
      }
      continue;
    }
    const port = Number(part);
    if (Number.isInteger(port) && port > 0 && port <= 65535) ports.add(port);
  }
  return [...ports].sort((a, b) => a - b);
}

function discoverListeningPorts() {
  const ports = new Map();
  collectListeningPorts('/proc/net/tcp', ports);
  collectListeningPorts('/proc/net/tcp6', ports);
  enrichListeningPortProcesses(ports);
  return ports;
}

function collectListeningPorts(path, ports) {
  let content;
  try {
    content = fs.readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of content.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || fields[3] !== '0A') continue;
    const local = fields[1];
    const portHex = local.slice(local.lastIndexOf(':') + 1);
    const inode = fields[9];
    const port = Number.parseInt(portHex, 16);
    if (!Number.isInteger(port) || port <= 0 || port > 65535) continue;
    const current = ports.get(port) || { port, inodes: [] };
    if (inode && !current.inodes.includes(inode)) current.inodes.push(inode);
    ports.set(port, current);
  }
}

function enrichListeningPortProcesses(ports) {
  const inodeToPort = new Map();
  for (const [port, info] of ports) {
    for (const inode of info.inodes || []) inodeToPort.set(inode, port);
  }
  if (inodeToPort.size === 0) return;

  let procEntries;
  try {
    procEntries = fs.readdirSync('/proc', { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of procEntries) {
    if (!entry.isDirectory() || !/^\d+$/.test(entry.name)) continue;
    const pid = Number(entry.name);
    const fdDir = `/proc/${entry.name}/fd`;
    let fds;
    try {
      fds = fs.readdirSync(fdDir);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target;
      try {
        target = fs.readlinkSync(path.join(fdDir, fd));
      } catch {
        continue;
      }
      const match = target.match(/^socket:\[(\d+)\]$/);
      if (!match) continue;
      const port = inodeToPort.get(match[1]);
      if (!port) continue;
      const info = ports.get(port);
      if (!info || info.pid) continue;
      const cwd = readProcLink(`/proc/${entry.name}/cwd`);
      const command = readProcCommand(entry.name);
      const procEnv = readProcEnv(entry.name);
      const workspace = inferWorkspaceFromCwd(cwd);
      ports.set(port, {
        ...info,
        pid,
        cwd,
        command,
        ...(procEnv.SYNTHI_RUNTIME_SCOPE ? { runtimeScope: procEnv.SYNTHI_RUNTIME_SCOPE } : {}),
        ...(procEnv.SYNTHI_WORKSPACE_SLUG ? { workspaceSlug: procEnv.SYNTHI_WORKSPACE_SLUG } : {}),
        ...(workspace || {}),
      });
    }
  }
}

function readProcLink(linkPath) {
  try {
    return fs.readlinkSync(linkPath);
  } catch {
    return undefined;
  }
}

function readProcCommand(pid) {
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8')
      .split('\0')
      .filter(Boolean)
      .join(' ')
      .slice(0, 240) || undefined;
  } catch {
    return undefined;
  }
}

function readProcEnv(pid) {
  try {
    const entries = fs.readFileSync(`/proc/${pid}/environ`, 'utf8')
      .split('\0')
      .filter(Boolean);
    const out = {};
    for (const entry of entries) {
      const idx = entry.indexOf('=');
      if (idx <= 0) continue;
      out[entry.slice(0, idx)] = entry.slice(idx + 1);
    }
    return out;
  } catch {
    return {};
  }
}

function inferWorkspaceFromCwd(cwd) {
  if (!cwd) return null;
  for (const root of REPO_ROOTS) {
    const relative = path.relative(root, cwd);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) continue;
    const parts = relative.split(path.sep).filter(Boolean);
    if (!parts[0]) continue;
    return {
      workspaceSlug: parts[0],
      ...(parts[1] ? { userId: parts[1] } : {}),
    };
  }
  return null;
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
