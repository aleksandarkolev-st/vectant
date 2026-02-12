#!/usr/bin/env node
/**
 * VS Code Server Manager
 *
 * Manages the lifecycle of a real VS Code Server (code-server / vscode-server)
 * on the backend. Instead of running extension code through a custom shimmed
 * Node.js host (`remote-ext-host.js`), this spawns a real VS Code Server
 * process that provides a **genuine Extension Host** with full `vscode.*` API.
 *
 * Responsibilities:
 *   1. Download / locate the VS Code Server binary
 *   2. Start the server per-workspace (unique port or socket per slug)
 *   3. Install VSIX files into the server's extensions directory
 *   4. Expose the server's WebSocket endpoint for the browser to connect
 *   5. Health-check and restart on crash
 *
 * Communication with the browser:
 *   Browser ←WebRTC DataChannel→ Rust worker ←stdin/stdout→ this manager
 *   OR
 *   Browser ←WebSocket (tunnelled over WebRTC)→ VS Code Server
 *
 * The manager communicates over newline-delimited JSON on stdin/stdout
 * (same pattern as remote-ext-host.js) so the Rust worker can spawn it
 * identically.
 */

'use strict';

const { spawn, execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const net = require('net');
const readline = require('readline');
const https = require('https');
const http = require('http');
const crypto = require('crypto');

// ============================================================================
// Configuration
// ============================================================================

/** Where to store the VS Code Server binary and data */
const VSCODE_SERVER_DIR = process.env.SYNTHI_VSCODE_SERVER_DIR
  || path.join(os.homedir(), '.synthi', 'vscode-server');

/** Where extensions are installed for the VS Code Server */
const EXTENSIONS_DIR = path.join(VSCODE_SERVER_DIR, 'extensions');

/** Server binary name depends on platform */
const IS_WIN = process.platform === 'win32';
const SERVER_BIN_NAME = IS_WIN ? 'code-server.cmd' : 'code-server';

/** VS Code Server version to download if not present */
const VSCODE_SERVER_VERSION = process.env.SYNTHI_VSCODE_SERVER_VERSION || 'stable';

/** Port range for dynamically allocated server instances */
const PORT_RANGE_START = parseInt(process.env.SYNTHI_VSCODE_PORT_START || '18000', 10);
const PORT_RANGE_END = parseInt(process.env.SYNTHI_VSCODE_PORT_END || '18999', 10);

/** Maximum time to wait for server to become ready (ms) */
const SERVER_READY_TIMEOUT = 30000;

/** Health check interval (ms) */
const HEALTH_CHECK_INTERVAL = 10000;

/** Maximum restart attempts before giving up */
const MAX_RESTART_ATTEMPTS = 3;

// ============================================================================
// Prevent EPIPE from crashing the process
// ============================================================================

process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') {
    process.stderr.write('[vscode-server-manager] stdout EPIPE — parent pipe closed, exiting gracefully\n');
    process.exit(0);
  }
});

process.on('uncaughtException', (err) => {
  if (err.code === 'EPIPE') {
    process.stderr.write('[vscode-server-manager] uncaught EPIPE, exiting gracefully\n');
    process.exit(0);
  }
  process.stderr.write(`[vscode-server-manager] uncaught exception: ${err.message}\n`);
  process.exit(1);
});

// ============================================================================
// Protocol (stdin/stdout JSON, same as remote-ext-host.js)
// ============================================================================

const GENERATION = 0;
let messageIdCounter = 0;

function createMessageId() {
  return ++messageIdCounter;
}

// ── Paced write queue ────────────────────────────────────────────────
// stdout feeds the Rust worker which forwards to the DataChannel.
// Writing too fast causes SCTP buffer overflow → OperationError.
// This queue paces writes so the Rust stdout-reader and DC sender
// can keep up.  Large payloads (WS tunnel data) are especially bursty.

/** @type {{data: string, resolve?: Function}[]} */
const _writeQueue = [];
let _writing = false;
const WRITE_PACE_MS = 12;  // delay between queued writes (controls DC throughput)

function send(obj) {
  try {
    const json = JSON.stringify(obj);
    _enqueueWrite(json + '\n');
  } catch (e) {
    process.stderr.write(`[vscode-server-manager] send error: ${e.message}\n`);
  }
}

/**
 * Enqueue a string for paced writing to stdout.
 * Returns a Promise that resolves when the data is actually written.
 */
function _enqueueWrite(data) {
  return new Promise((resolve) => {
    _writeQueue.push({ data, resolve });
    if (!_writing) _drainWriteQueue();
  });
}

async function _drainWriteQueue() {
  if (_writing) return;
  _writing = true;
  while (_writeQueue.length > 0) {
    const { data, resolve } = _writeQueue.shift();
    const ok = process.stdout.write(data);
    if (resolve) resolve();
    if (!ok) {
      // stdout buffer full — wait for drain before continuing
      await new Promise(r => process.stdout.once('drain', r));
    }
    // Small yield to let the Rust reader consume lines and send DC messages
    // before we enqueue more.  This prevents bursty WS events from
    // saturating the SCTP buffer.
    if (_writeQueue.length > 0) {
      await new Promise(r => setTimeout(r, WRITE_PACE_MS));
    }
  }
  _writing = false;
}

/**
 * Stream a large response body in paced chunks to prevent DataChannel
 * buffer overflow.  Each chunk is emitted as a separate JSON line on stdout
 * so the Rust worker sends each as a separate (small) DC message.
 *
 * Protocol:
 *   {id, type:'response', stream:'start', meta:{status,headers,...}, generation}
 *   {id, type:'response', stream:'data', chunk:'base64…', generation}  ×N
 *   {id, type:'response', stream:'end', generation}
 *
 * @param {number} id    Request ID
 * @param {object} result  The proxyHttp result {status, statusText, headers, body}
 */
async function sendResponseStreamed(id, result) {
  const body = result.body || '';
  const meta = {
    status: result.status,
    statusText: result.statusText || '',
    headers: result.headers || {},
    bodySize: body.length,
  };
  // Start
  send({ id, type: 'response', stream: 'start', meta, generation: GENERATION });

  // Body chunks — 48KB each (~64KB after JSON wrapping)
  const CHUNK = 48000;
  const total = Math.ceil(body.length / CHUNK);
  for (let i = 0; i < body.length; i += CHUNK) {
    const chunk = body.slice(i, i + CHUNK);
    // Use the paced write queue instead of writing directly to stdout.
    // This ensures large streamed responses don't bypass the queue and
    // compete with other messages for the DataChannel buffer.
    await _enqueueWrite(JSON.stringify({
      id, type: 'response', stream: 'data', chunk, generation: GENERATION,
    }) + '\n');
  }

  // End
  send({ id, type: 'response', stream: 'end', generation: GENERATION });
  process.stderr.write(`[vscode-server-manager] Streamed response ${id}: ${body.length} bytes in ${total} chunks\n`);
}

/**
 * Stream a large WS tunnel event in paced chunks.
 * Works like sendResponseStreamed but for ws:data events.
 *
 * Protocol:
 *   {type:'event', method:'ws:data:start', args:[tunnelId, totalSize, isBinary]}
 *   {type:'event', method:'ws:data:chunk', args:[tunnelId, chunkData]}  ×N
 *   {type:'event', method:'ws:data:end',   args:[tunnelId]}
 *
 * @param {number} tunnelId
 * @param {string} payload  Text or base64-encoded binary data
 * @param {boolean} isBinary
 */
async function _sendWsEventStreamed(tunnelId, payload, isBinary) {
  sendEvent('ws:data:start', tunnelId, payload.length, isBinary);

  const CHUNK = 48000;
  const total = Math.ceil(payload.length / CHUNK);
  for (let i = 0; i < payload.length; i += CHUNK) {
    const chunk = payload.slice(i, i + CHUNK);
    await _enqueueWrite(JSON.stringify({
      id: createMessageId(),
      type: 'event',
      method: 'ws:data:chunk',
      args: [tunnelId, chunk],
      generation: GENERATION,
    }) + '\n');
  }

  sendEvent('ws:data:end', tunnelId);
  process.stderr.write(`[vscode-server-manager] Streamed WS event tunnel ${tunnelId}: ${payload.length} chars in ${total} chunks\n`);
}

function sendResponse(id, result, error = null) {
  const msg = { id, type: 'response', generation: GENERATION };
  if (error) {
    msg.error = {
      message: String(error.message || error),
      stack: error.stack ? String(error.stack).slice(0, 2000) : undefined,
    };
  } else {
    msg.result = result;
  }
  send(msg);
}

function sendEvent(method, ...args) {
  send({
    id: createMessageId(),
    type: 'event',
    method,
    args,
    generation: GENERATION,
  });
}

// ============================================================================
// Extension Host Preload Bridge (TCP server)
//
// The ext-host-preload.js script runs inside code-server's Extension Host
// process and connects back to this TCP server. It sends UI events (tree
// provider registrations, tree data, webview HTML changes) as newline-
// delimited JSON. We parse them and forward to the browser via stdout.
// ============================================================================

/** @type {net.Server|null} */
let preloadBridgeServer = null;

/** @type {number|null} TCP port the bridge listens on */
let preloadBridgePort = null;

/** @type {Set<net.Socket>} Connected preload clients */
const preloadClients = new Set();

/** @type {Map<string, object>} viewId → last known tree data */
const preloadTreeCache = new Map();

/**
 * Start the TCP bridge server for ext-host-preload.js connections.
 * Picks a random available port and stores it in preloadBridgePort.
 *
 * @returns {Promise<number>} The port the bridge is listening on
 */
function startPreloadBridge() {
  return new Promise((resolve, reject) => {
    if (preloadBridgeServer) {
      resolve(preloadBridgePort);
      return;
    }

    const server = net.createServer((socket) => {
      process.stderr.write(`[preload-bridge] Client connected from Extension Host\n`);
      preloadClients.add(socket);

      let lineBuf = '';

      socket.on('data', (chunk) => {
        lineBuf += chunk.toString();
        let newlineIdx;
        while ((newlineIdx = lineBuf.indexOf('\n')) !== -1) {
          const line = lineBuf.slice(0, newlineIdx).trim();
          lineBuf = lineBuf.slice(newlineIdx + 1);
          if (!line) continue;

          try {
            const msg = JSON.parse(line);
            _handlePreloadMessage(msg);
          } catch (e) {
            process.stderr.write(`[preload-bridge] Parse error: ${e.message}\n`);
          }
        }
      });

      socket.on('close', () => {
        process.stderr.write(`[preload-bridge] Client disconnected\n`);
        preloadClients.delete(socket);
      });

      socket.on('error', (err) => {
        process.stderr.write(`[preload-bridge] Socket error: ${err.message}\n`);
        preloadClients.delete(socket);
      });
    });

    server.listen(0, '127.0.0.1', () => {
      preloadBridgePort = server.address().port;
      preloadBridgeServer = server;
      process.stderr.write(`[preload-bridge] TCP bridge listening on port ${preloadBridgePort}\n`);
      resolve(preloadBridgePort);
    });

    server.on('error', (err) => {
      process.stderr.write(`[preload-bridge] Server error: ${err.message}\n`);
      reject(err);
    });

    // Don't let the bridge server keep the process alive on its own
    server.unref();
  });
}

/**
 * Stop the preload bridge TCP server.
 */
function stopPreloadBridge() {
  if (preloadBridgeServer) {
    for (const client of preloadClients) {
      try { client.destroy(); } catch (_) {}
    }
    preloadClients.clear();
    try { preloadBridgeServer.close(); } catch (_) {}
    preloadBridgeServer = null;
    preloadBridgePort = null;
    process.stderr.write(`[preload-bridge] TCP bridge stopped\n`);
  }
}

/**
 * Handle a message from the ext-host-preload.js script.
 * These are UI events extracted from the real Extension Host.
 *
 * @param {object} msg
 */
function _handlePreloadMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'treeProvider': {
      // A tree data provider was registered
      process.stderr.write(`[preload-bridge] Tree provider registered: ${msg.viewId} (ext: ${msg.extensionId})\n`);
      sendEvent('registerTreeView', msg.viewId, msg.extensionId);
      break;
    }

    case 'treeData': {
      // Tree data resolved for a view
      process.stderr.write(`[preload-bridge] Tree data for ${msg.viewId}: ${(msg.data || []).length} items\n`);
      preloadTreeCache.set(msg.viewId, msg.data);
      sendEvent('treeData', msg.viewId, msg.data);
      break;
    }

    case 'webviewProvider': {
      // A webview view provider was registered
      process.stderr.write(`[preload-bridge] Webview provider registered: ${msg.viewType} (ext: ${msg.extensionId})\n`);
      sendEvent('createWebview', msg.viewType, msg.viewType, msg.viewType, msg.extensionId);
      break;
    }

    case 'webviewHtml': {
      // Webview HTML content updated
      process.stderr.write(`[preload-bridge] Webview HTML for ${msg.viewType}: ${(msg.html || '').length} chars\n`);
      sendEvent('updateWebview', msg.viewType, msg.html);
      break;
    }

    case 'webviewPanel': {
      // A webview panel was created
      process.stderr.write(`[preload-bridge] Webview panel: ${msg.viewId} (type: ${msg.viewType})\n`);
      sendEvent('createWebview', msg.viewId, msg.viewType, msg.title, msg.extensionId);
      break;
    }

    case 'webviewPanelHtml': {
      // Webview panel HTML content updated
      sendEvent('updateWebview', msg.viewId, msg.html);
      break;
    }

    case 'command': {
      // A command was registered
      process.stderr.write(`[preload-bridge] Command registered: ${msg.commandId} (ext: ${msg.extensionId})\n`);
      sendEvent('registerCommand', msg.commandId, msg.extensionId);
      break;
    }

    case 'webviewDisposed': {
      sendEvent('disposeWebview', msg.viewType || msg.viewId);
      break;
    }

    default:
      process.stderr.write(`[preload-bridge] Unknown message type: ${msg.type}\n`);
  }
}

/**
 * Send a message to all connected preload clients.
 * Used to request tree data refresh, etc.
 *
 * @param {object} msg
 */
function sendToPreloadClients(msg) {
  const json = JSON.stringify(msg) + '\n';
  for (const client of preloadClients) {
    try {
      client.write(json);
    } catch (e) {
      process.stderr.write(`[preload-bridge] Write to client failed: ${e.message}\n`);
    }
  }
}

// ============================================================================
// Server State
// ============================================================================

/** @type {import('child_process').ChildProcess|null} */
let serverProcess = null;

/** @type {number|null} */
let serverPort = null;

/** @type {string|null} */
let serverToken = null;

/** @type {string|null} */
let currentSlug = null;

/** @type {string|null} */
let currentWorkspaceDir = null;

/** @type {'stopped'|'starting'|'running'|'error'} */
let serverState = 'stopped';

/** @type {number} */
let restartAttempts = 0;

/** @type {NodeJS.Timeout|null} */
let healthCheckTimer = null;

/** @type {Map<string, {id: string, vsixPath: string, installed: boolean}>} */
const installedExtensions = new Map();

// ============================================================================
// Port allocation
// ============================================================================

/**
 * Find an available TCP port in the configured range.
 * @returns {Promise<number>}
 */
function findAvailablePort() {
  return new Promise((resolve, reject) => {
    let port = PORT_RANGE_START;
    const tryPort = () => {
      if (port > PORT_RANGE_END) {
        return reject(new Error(`No available port in range ${PORT_RANGE_START}-${PORT_RANGE_END}`));
      }
      const srv = net.createServer();
      srv.once('error', () => { port++; tryPort(); });
      srv.once('listening', () => {
        srv.close(() => resolve(port));
      });
      srv.listen(port, '127.0.0.1');
    };
    tryPort();
  });
}

// ============================================================================
// VS Code Server Binary Management
// ============================================================================

/**
 * Get the path to the VS Code Server binary.
 * Checks several locations:
 *   1. SYNTHI_VSCODE_SERVER_BIN env var (explicit path)
 *   2. Our managed install at ~/.synthi/vscode-server/bin/
 *   3. System PATH (code-server)
 *   4. VS Code's own server binary (~/.vscode-server/)
 *
 * @returns {string|null} Path to binary, or null if not found
 */
function findServerBinary() {
  // 1. Explicit env
  if (process.env.SYNTHI_VSCODE_SERVER_BIN) {
    const p = process.env.SYNTHI_VSCODE_SERVER_BIN;
    if (fs.existsSync(p)) return p;
  }

  // 2. Managed install
  const managedBin = path.join(VSCODE_SERVER_DIR, 'bin', SERVER_BIN_NAME);
  if (fs.existsSync(managedBin)) return managedBin;

  // 3. System PATH — try `code-server`
  try {
    const which = IS_WIN ? 'where' : 'which';
    const result = execSync(`${which} code-server`, { encoding: 'utf8', timeout: 5000 }).trim();
    if (result && fs.existsSync(result.split('\n')[0])) return result.split('\n')[0];
  } catch (_) {}

  // 4. VS Code's own server binary (Remote SSH installs)
  const vscodeServerDir = path.join(os.homedir(), '.vscode-server', 'bin');
  if (fs.existsSync(vscodeServerDir)) {
    const versions = fs.readdirSync(vscodeServerDir).sort().reverse();
    for (const ver of versions) {
      const bin = path.join(vscodeServerDir, ver, 'bin', IS_WIN ? 'code-server.cmd' : 'code-server');
      if (fs.existsSync(bin)) return bin;
    }
  }

  return null;
}

/**
 * Download and install code-server if not present.
 * Uses the code-server install script for Linux/macOS,
 * or downloads the binary directly for Windows.
 *
 * @returns {Promise<string>} Path to installed binary
 */
async function ensureServerBinary() {
  const existing = findServerBinary();
  if (existing) {
    process.stderr.write(`[vscode-server-manager] Found server binary: ${existing}\n`);
    return existing;
  }

  process.stderr.write('[vscode-server-manager] VS Code Server not found, installing code-server...\n');
  sendEvent('serverStatus', 'downloading');

  // Create install directory
  const binDir = path.join(VSCODE_SERVER_DIR, 'bin');
  fs.mkdirSync(binDir, { recursive: true });

  if (IS_WIN) {
    // On Windows, download the standalone zip from GitHub
    return await downloadCodeServerWindows(binDir);
  } else {
    // On Linux/macOS, use the official install script
    return await installCodeServerUnix(binDir);
  }
}

/**
 * Install code-server on Unix via the official install script.
 * @param {string} binDir
 * @returns {Promise<string>}
 */
function installCodeServerUnix(binDir) {
  return new Promise((resolve, reject) => {
    const installScript = spawn('sh', ['-c',
      `curl -fsSL https://code-server.dev/install.sh | sh -s -- --prefix="${path.join(VSCODE_SERVER_DIR, 'install')}" --method=standalone`
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 120000,
    });

    let stdout = '';
    let stderr = '';
    installScript.stdout.on('data', (d) => { stdout += d; });
    installScript.stderr.on('data', (d) => { stderr += d; });

    installScript.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`code-server install failed (exit ${code}): ${stderr}`));
      }
      // Find the installed binary
      const installed = path.join(VSCODE_SERVER_DIR, 'install', 'bin', 'code-server');
      if (fs.existsSync(installed)) {
        // Symlink into our bin directory
        const link = path.join(binDir, 'code-server');
        try { fs.unlinkSync(link); } catch (_) {}
        fs.symlinkSync(installed, link);
        resolve(link);
      } else {
        reject(new Error('code-server binary not found after install'));
      }
    });
  });
}

/**
 * Download code-server on Windows (standalone release).
 * @param {string} binDir
 * @returns {Promise<string>}
 */
async function downloadCodeServerWindows(binDir) {
  // Fetch the latest release info from GitHub
  const releaseUrl = 'https://api.github.com/repos/coder/code-server/releases/latest';

  const releaseJson = await httpGet(releaseUrl);
  const release = JSON.parse(releaseJson);

  // Find the Windows asset
  const winAsset = release.assets.find(a =>
    a.name.includes('windows') && a.name.endsWith('.zip')
  );
  if (!winAsset) {
    throw new Error('No Windows release asset found for code-server');
  }

  const zipPath = path.join(VSCODE_SERVER_DIR, 'code-server.zip');

  // Download the zip
  process.stderr.write(`[vscode-server-manager] Downloading ${winAsset.browser_download_url}\n`);
  await downloadFile(winAsset.browser_download_url, zipPath);

  // Extract (use PowerShell on Windows)
  const extractDir = path.join(VSCODE_SERVER_DIR, 'install');
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(`powershell -Command "Expand-Archive -Force -Path '${zipPath}' -DestinationPath '${extractDir}'"`, {
    timeout: 60000,
  });

  // Find the binary inside the extracted directory
  const extracted = fs.readdirSync(extractDir).find(d => d.startsWith('code-server'));
  if (!extracted) throw new Error('code-server not found in extracted archive');

  const binPath = path.join(extractDir, extracted, 'bin', 'code-server.cmd');
  if (!fs.existsSync(binPath)) {
    // Try alternative path structure
    const altBin = path.join(extractDir, extracted, 'code-server.cmd');
    if (fs.existsSync(altBin)) return altBin;
    throw new Error(`code-server binary not found at ${binPath}`);
  }

  return binPath;
}

// ============================================================================
// HTTP helpers
// ============================================================================

function httpGet(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'synthi-vscode-server-manager' } }, (res) => {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return httpGet(res.headers.location).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => resolve(data));
      res.on('error', reject);
    }).on('error', reject);
  });
}

function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https') ? https : http;
    mod.get(url, { headers: { 'User-Agent': 'synthi-vscode-server-manager' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadFile(res.headers.location, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        return reject(new Error(`HTTP ${res.statusCode} downloading ${url}`));
      }
      const stream = fs.createWriteStream(dest);
      res.pipe(stream);
      stream.on('finish', () => { stream.close(); resolve(); });
      stream.on('error', reject);
    }).on('error', reject);
  });
}

// ============================================================================
// VS Code Server Lifecycle
// ============================================================================

/**
 * Start the VS Code Server for a given workspace slug.
 *
 * @param {string} slug - Workspace identifier
 * @param {object} [options]
 * @param {string} [options.workspaceDir] - Workspace root directory on disk
 * @returns {Promise<{port: number, token: string}>}
 */
async function startServer(slug, options = {}) {
  if (serverState === 'running' && currentSlug === slug) {
    return { port: serverPort, token: serverToken };
  }

  // Stop existing server if running a different workspace
  if (serverProcess) {
    await stopServer();
  }

  serverState = 'starting';
  currentSlug = slug;
  sendEvent('serverStatus', 'starting', slug);

  try {
    const binary = await ensureServerBinary();
    const port = await findAvailablePort();

    // Generate a connection token
    const token = require('crypto').randomBytes(16).toString('hex');

    // Workspace directory — default to /tmp/synthi-workspaces/<slug>
    const workspaceDir = options.workspaceDir
      || path.join(os.tmpdir(), 'synthi-workspaces', slug);
    fs.mkdirSync(workspaceDir, { recursive: true });
    currentWorkspaceDir = workspaceDir;

    // User data directory (settings, state)
    const userDataDir = path.join(VSCODE_SERVER_DIR, 'user-data', slug);
    fs.mkdirSync(userDataDir, { recursive: true });

    // Build server arguments
    const args = [
      '--port', String(port),
      '--host', '127.0.0.1',
      '--auth', 'none',           // We handle auth at the WebRTC layer
      '--disable-telemetry',
      '--disable-update-check',
      '--extensions-dir', EXTENSIONS_DIR,
      '--user-data-dir', userDataDir,
    ];

    // If the binary is code-server (coder/code-server), add its specific flags
    if (binary.includes('code-server')) {
      args.push('--bind-addr', `127.0.0.1:${port}`);
      // Remove redundant --port and --host for code-server
      const portIdx = args.indexOf('--port');
      if (portIdx >= 0) args.splice(portIdx, 2);
      const hostIdx = args.indexOf('--host');
      if (hostIdx >= 0) args.splice(hostIdx, 2);
    }

    // Append workspace directory
    args.push(workspaceDir);

    // ── Start the preload bridge BEFORE spawning code-server ──
    // The bridge TCP server must be listening before the Extension Host
    // process starts, so ext-host-preload.js can connect immediately.
    let bridgePort = 0;
    try {
      bridgePort = await startPreloadBridge();
      process.stderr.write(`[vscode-server-manager] Preload bridge ready on port ${bridgePort}\n`);
    } catch (bridgeErr) {
      process.stderr.write(`[vscode-server-manager] Preload bridge start failed (non-fatal): ${bridgeErr.message}\n`);
    }

    // Build NODE_OPTIONS to inject ext-host-preload.js into the Extension Host.
    // The preload script uses SYNTHI_EXT_BRIDGE_PORT to connect back to us.
    // It checks for VSCODE_IPC_HOOK_EXTHOST to ensure it only activates
    // inside the Extension Host process, not code-server's main process.
    const preloadPath = path.join(__dirname, 'ext-host-preload.js');
    const existingNodeOptions = process.env.NODE_OPTIONS || '';
    const nodeOptions = bridgePort
      ? `${existingNodeOptions} --require "${preloadPath}"`.trim()
      : existingNodeOptions;

    process.stderr.write(`[vscode-server-manager] Starting: ${binary} ${args.join(' ')}\n`);

    serverProcess = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Pass connection token for server-side validation
        VSCODE_SERVER_TOKEN: token,
        // Disable GPU (headless server)
        VSCODE_CLI_DISABLE_GPU: '1',
        // Inject ext-host-preload.js into all Node child processes.
        // The preload script self-guards to only activate in the Extension Host.
        ...(nodeOptions ? { NODE_OPTIONS: nodeOptions } : {}),
        // Tell the preload script where our TCP bridge is listening
        ...(bridgePort ? { SYNTHI_EXT_BRIDGE_PORT: String(bridgePort) } : {}),
      },
    });

    serverPort = port;
    serverToken = token;

    // Capture server output for debugging
    serverProcess.stdout.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        process.stderr.write(`[vscode-server] ${line}\n`);
        sendEvent('serverLog', line);
      }
    });

    serverProcess.stderr.on('data', (data) => {
      const line = data.toString().trim();
      if (line) {
        process.stderr.write(`[vscode-server:err] ${line}\n`);
        sendEvent('serverLog', line);
      }
    });

    serverProcess.on('exit', (code, signal) => {
      process.stderr.write(`[vscode-server-manager] Server exited: code=${code} signal=${signal}\n`);
      serverState = 'stopped';
      serverProcess = null;
      sendEvent('serverStatus', 'stopped', code, signal);

      // Auto-restart if crashed unexpectedly
      if (code !== 0 && code !== null && restartAttempts < MAX_RESTART_ATTEMPTS) {
        restartAttempts++;
        process.stderr.write(`[vscode-server-manager] Auto-restarting (attempt ${restartAttempts}/${MAX_RESTART_ATTEMPTS})\n`);
        startServer(slug, options).catch(err => {
          process.stderr.write(`[vscode-server-manager] Restart failed: ${err.message}\n`);
          sendEvent('serverStatus', 'error', err.message);
        });
      }
    });

    // Wait for the server to be ready
    await waitForServer(port, SERVER_READY_TIMEOUT);

    serverState = 'running';
    restartAttempts = 0;
    sendEvent('serverStatus', 'running', port, token);

    // Start health checks
    startHealthChecks(port);

    process.stderr.write(`[vscode-server-manager] Server ready on port ${port}\n`);
    return { port, token, workspaceDir };

  } catch (err) {
    serverState = 'error';
    sendEvent('serverStatus', 'error', err.message);
    throw err;
  }
}

/**
 * Wait for the VS Code Server HTTP endpoint to respond.
 * @param {number} port
 * @param {number} timeout
 * @returns {Promise<void>}
 */
function waitForServer(port, timeout) {
  return new Promise((resolve, reject) => {
    const startTime = Date.now();

    const check = () => {
      if (Date.now() - startTime > timeout) {
        return reject(new Error(`VS Code Server did not become ready within ${timeout}ms`));
      }

      const req = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
        if (res.statusCode === 200) {
          resolve();
        } else {
          setTimeout(check, 500);
        }
        res.resume(); // Drain response
      });

      req.on('error', () => {
        setTimeout(check, 500);
      });

      req.setTimeout(2000, () => {
        req.destroy();
        setTimeout(check, 500);
      });
    };

    check();
  });
}

/**
 * Stop the VS Code Server.
 * @returns {Promise<void>}
 */
function stopServer() {
  return new Promise((resolve) => {
    if (healthCheckTimer) {
      clearInterval(healthCheckTimer);
      healthCheckTimer = null;
    }

    if (!serverProcess) {
      serverState = 'stopped';
      resolve();
      return;
    }

    process.stderr.write('[vscode-server-manager] Stopping server...\n');

    // Stop the preload bridge (TCP server for ext-host-preload.js)
    stopPreloadBridge();

    // Also stop the Extension Host Bridge (legacy remote-ext-host.js)
    stopExtHostBridge();

    const killTimer = setTimeout(() => {
      try { serverProcess?.kill('SIGKILL'); } catch (_) {}
    }, 5000);

    serverProcess.once('exit', () => {
      clearTimeout(killTimer);
      serverProcess = null;
      serverState = 'stopped';
      serverPort = null;
      serverToken = null;
      currentWorkspaceDir = null;
      resolve();
    });

    try {
      serverProcess.kill('SIGTERM');
    } catch (_) {
      serverProcess = null;
      serverState = 'stopped';
      clearTimeout(killTimer);
      resolve();
    }
  });
}

/**
 * Periodic health check — verify server is still responding.
 * @param {number} port
 */
function startHealthChecks(port) {
  if (healthCheckTimer) clearInterval(healthCheckTimer);
  healthCheckTimer = setInterval(() => {
    if (serverState !== 'running') return;

    const req = http.get(`http://127.0.0.1:${port}/healthz`, (res) => {
      res.resume();
      if (res.statusCode !== 200) {
        process.stderr.write(`[vscode-server-manager] Health check failed: HTTP ${res.statusCode}\n`);
        sendEvent('serverStatus', 'unhealthy');
      }
    });

    req.on('error', (err) => {
      process.stderr.write(`[vscode-server-manager] Health check error: ${err.message}\n`);
      sendEvent('serverStatus', 'unhealthy');
    });

    req.setTimeout(5000, () => {
      req.destroy();
      process.stderr.write('[vscode-server-manager] Health check timeout\n');
    });
  }, HEALTH_CHECK_INTERVAL);
}

// ============================================================================
// Extension (VSIX) Management
// ============================================================================

/**
 * Install a VSIX file into the VS Code Server's extensions directory.
 *
 * @param {string} extensionId - e.g. "publisher.name"
 * @param {Buffer|string} vsixData - Raw VSIX bytes (base64-encoded if string)
 * @returns {Promise<{success: boolean, extensionId: string}>}
 */
async function installVSIX(extensionId, vsixData) {
  // Ensure extensions directory exists
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

  // Write VSIX to a temp file
  const vsixPath = path.join(os.tmpdir(), `synthi-vsix-${extensionId.replace(/\./g, '-')}-${Date.now()}.vsix`);

  if (typeof vsixData === 'string') {
    // Assume base64-encoded
    fs.writeFileSync(vsixPath, Buffer.from(vsixData, 'base64'));
  } else {
    fs.writeFileSync(vsixPath, vsixData);
  }

  try {
    const binary = findServerBinary();

    if (binary) {
      // Use the server's CLI to install the extension properly
      process.stderr.write(`[vscode-server-manager] Installing VSIX: ${extensionId}\n`);

      execFileSync(binary, [
        '--install-extension', vsixPath,
        '--extensions-dir', EXTENSIONS_DIR,
        '--force',
      ], {
        timeout: 60000,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } else {
      // Fallback: manual extraction
      await manualInstallVSIX(extensionId, vsixPath);
    }

    installedExtensions.set(extensionId, {
      id: extensionId,
      vsixPath,
      installed: true,
    });

    sendEvent('extensionInstalled', extensionId);
    process.stderr.write(`[vscode-server-manager] ✓ VSIX installed: ${extensionId}\n`);

    // Track UI contributions and request preload refresh.
    // With preload approach, extensions are automatically bridged.
    try {
      await loadExtensionForUI(extensionId);
    } catch (uiErr) {
      process.stderr.write(`[vscode-server-manager] UI bridge load after VSIX install failed: ${uiErr.message}\n`);
    }

    return { success: true, extensionId };

  } catch (err) {
    process.stderr.write(`[vscode-server-manager] VSIX install failed for ${extensionId}: ${err.message}\n`);
    sendEvent('extensionInstallFailed', extensionId, err.message);
    return { success: false, extensionId, error: err.message };

  } finally {
    // Clean up temp file
    try { fs.unlinkSync(vsixPath); } catch (_) {}
  }
}

/**
 * Manually extract a VSIX (ZIP) into the extensions directory.
 * Used when the server binary isn't available for CLI install.
 *
 * @param {string} extensionId
 * @param {string} vsixPath
 */
async function manualInstallVSIX(extensionId, vsixPath) {
  const extDir = path.join(EXTENSIONS_DIR, extensionId);
  fs.mkdirSync(extDir, { recursive: true });

  // VSIX files are ZIP archives. Use native tools to extract.
  if (IS_WIN) {
    execSync(`powershell -Command "Expand-Archive -Force -Path '${vsixPath}' -DestinationPath '${extDir}'"`, {
      timeout: 30000,
    });
  } else {
    execSync(`unzip -o -q "${vsixPath}" -d "${extDir}"`, {
      timeout: 30000,
    });
  }

  // VSIX packages have an `extension/` subdirectory — move its contents up
  const innerDir = path.join(extDir, 'extension');
  if (fs.existsSync(innerDir)) {
    const files = fs.readdirSync(innerDir);
    for (const f of files) {
      fs.renameSync(path.join(innerDir, f), path.join(extDir, f));
    }
    try { fs.rmdirSync(innerDir); } catch (_) {}
  }
}

/**
 * Uninstall an extension from the server.
 * @param {string} extensionId
 * @returns {{success: boolean}}
 */
function uninstallExtension(extensionId) {
  const extDir = path.join(EXTENSIONS_DIR, extensionId);

  try {
    if (fs.existsSync(extDir)) {
      fs.rmSync(extDir, { recursive: true, force: true });
    }
    installedExtensions.delete(extensionId);
    sendEvent('extensionUninstalled', extensionId);
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

/**
 * List extensions installed in the server's extensions directory.
 * @returns {string[]}
 */
function listInstalledExtensions() {
  try {
    if (!fs.existsSync(EXTENSIONS_DIR)) return [];
    return fs.readdirSync(EXTENSIONS_DIR).filter(f => {
      const stat = fs.statSync(path.join(EXTENSIONS_DIR, f));
      return stat.isDirectory();
    });
  } catch (_) {
    return [];
  }
}

// ============================================================================
// Extension Host Bridge (Preload-Based)
//
// Instead of spawning remote-ext-host.js with a shimmed vscode API,
// we now rely on ext-host-preload.js injected into code-server's real
// Extension Host via NODE_OPTIONS. The preload script intercepts the
// genuine vscode API and sends UI events back through the TCP bridge.
//
// The functions below provide backward-compatible interfaces so the
// rest of the codebase (installVSIX, installExtensionFromMarketplace)
// can still call loadExtensionForUI() etc.
// ============================================================================

/** @type {Set<string>} Extensions known to have UI contributions */
const extHostLoadedExtensions = new Set();

/**
 * Check if an extension has UI contributions (views, webview views, tree data).
 *
 * @param {object} manifest - Extension package.json
 * @returns {boolean}
 */
function _hasUIContributions(manifest) {
  if (!manifest?.contributes) return false;
  const c = manifest.contributes;
  if (c.views && Object.keys(c.views).length > 0) return true;
  if (c.viewsContainers && Object.keys(c.viewsContainers).length > 0) return true;
  return false;
}

/**
 * Read an extension's manifest from its directory in EXTENSIONS_DIR.
 * Handles the various directory structures that code-server --install-extension
 * produces (e.g. `publisher.name-version/package.json`).
 *
 * @param {string} extensionId
 * @returns {{manifest: object, extDir: string}|null}
 */
function _readExtensionManifest(extensionId) {
  // Try exact match first
  let extDir = path.join(EXTENSIONS_DIR, extensionId);
  let pkgPath = path.join(extDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      return { manifest: JSON.parse(fs.readFileSync(pkgPath, 'utf8')), extDir };
    } catch (_) {}
  }

  // code-server names directories as `publisher.name-version`
  try {
    const dirs = fs.readdirSync(EXTENSIONS_DIR);
    for (const dir of dirs) {
      if (dir.startsWith(extensionId) || dir.toLowerCase().startsWith(extensionId.toLowerCase())) {
        extDir = path.join(EXTENSIONS_DIR, dir);
        pkgPath = path.join(extDir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          try {
            return { manifest: JSON.parse(fs.readFileSync(pkgPath, 'utf8')), extDir };
          } catch (_) {}
        }
      }
    }
  } catch (_) {}

  return null;
}

/**
 * Mark an extension as UI-bridged and request data from preload clients.
 *
 * With the preload approach, extensions are loaded by code-server's real
 * Extension Host automatically. We don't need to "load" them manually.
 * This function just:
 *   1. Checks if the extension has UI contributions
 *   2. Marks it as bridged
 *   3. Tells preload clients to refresh tree data
 *
 * @param {string} extensionId
 * @returns {Promise<{success: boolean, hasUI: boolean}>}
 */
async function loadExtensionForUI(extensionId) {
  if (extHostLoadedExtensions.has(extensionId)) {
    process.stderr.write(`[preload-bridge] ${extensionId} already tracked\n`);
    return { success: true, hasUI: true };
  }

  const result = _readExtensionManifest(extensionId);
  if (!result) {
    process.stderr.write(`[preload-bridge] Cannot find manifest for ${extensionId}\n`);
    return { success: false, hasUI: false };
  }

  const { manifest } = result;

  if (!_hasUIContributions(manifest)) {
    process.stderr.write(`[preload-bridge] ${extensionId} has no UI contributions\n`);
    return { success: true, hasUI: false };
  }

  extHostLoadedExtensions.add(extensionId);
  process.stderr.write(`[preload-bridge] Tracking UI for ${extensionId}\n`);

  // Ask preload clients to refresh — the extension may already be loaded
  // in the Extension Host and have registered providers
  sendToPreloadClients({ action: 'refreshAllTrees' });
  sendToPreloadClients({ action: 'listProviders' });

  return { success: true, hasUI: true };
}

/**
 * No-op for backward compatibility. The old bridge spawned remote-ext-host.js;
 * the new preload approach doesn't need a separate process.
 */
function startExtHostBridge() {
  process.stderr.write('[preload-bridge] startExtHostBridge() is a no-op (using preload approach)\n');
}

/**
 * No-op for backward compatibility.
 */
function stopExtHostBridge() {
  process.stderr.write('[preload-bridge] stopExtHostBridge() is a no-op (using preload approach)\n');
  extHostLoadedExtensions.clear();
}

// ============================================================================
// WebSocket Tunnel
// ============================================================================

/**
 * Create a WebSocket tunnel between the VS Code Server and a DataChannel.
 *
 * The browser connects to the VS Code Server via a WebSocket that is
 * tunnelled through the WebRTC DataChannel. This gives the browser a
 * direct connection to the real Extension Host.
 *
 * The Rust worker handles the DataChannel↔TCP bridging. This function
 * provides the connection info.
 *
 * @returns {{host: string, port: number, path: string, token: string}|null}
 */
function getServerConnectionInfo() {
  if (serverState !== 'running' || !serverPort) return null;
  return {
    host: '127.0.0.1',
    port: serverPort,
    path: '/',
    token: serverToken || '',
    wsUrl: `ws://127.0.0.1:${serverPort}/?reconnectionToken=${serverToken}&reconnection=false&skipWebSocketFrames=false`,
  };
}

// ============================================================================
// Minimal WebSocket Client (stdlib only — Node 18 has no native WebSocket)
// ============================================================================

/**
 * WebSocket tunnels keyed by tunnel ID.
 * Each entry: { socket, connected }
 * @type {Map<number, {socket: net.Socket, connected: boolean}>}
 */
const wsTunnels = new Map();
let wsTunnelIdCounter = 0;

/**
 * Open a raw WebSocket connection to code-server.
 * Uses HTTP upgrade via the `http` module + manual WS frame encode/decode.
 */
function wsConnect(tunnelId, urlPath) {
  return new Promise((resolve, reject) => {
    if (!serverPort || serverState !== 'running') {
      return reject(new Error('VS Code Server not running'));
    }

    const wsKey = crypto.randomBytes(16).toString('base64');
    let reqPath = urlPath || '/';
    // Strip the /__vscode-proxy__ prefix that the browser-side shim includes
    if (reqPath.startsWith('/__vscode-proxy__')) {
      reqPath = reqPath.slice('/__vscode-proxy__'.length) || '/';
    }

    const req = http.request({
      hostname: '127.0.0.1',
      port: serverPort,
      path: reqPath,
      method: 'GET',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': wsKey,
        'Host': `127.0.0.1:${serverPort}`,
      },
    });

    req.on('upgrade', (res, socket, head) => {
      process.stderr.write(`[ws-tunnel] Connected tunnel ${tunnelId} to ${reqPath}\n`);

      wsTunnels.set(tunnelId, { socket, connected: true });

      // If there was initial data in the upgrade head, process it
      if (head && head.length > 0) {
        handleWsData(tunnelId, head);
      }

      // Incoming data from code-server → parse WS frames → send as events
      // Flow control: pause the socket while we're draining large frames
      // to prevent overloading the DataChannel's SCTP buffer.
      let frameBuf = Buffer.alloc(0);
      let processingFrames = false;

      const processFrames = async () => {
        if (processingFrames) return;
        processingFrames = true;

        while (true) {
          const result = parseWsFrame(frameBuf);
          if (!result) break;
          frameBuf = result.rest;

          if (result.opcode === 0x01) {
            // Text frame — stream if large
            const payload = result.payload.toString('utf8');
            if (payload.length > 100000) {
              // Pause the socket while we pace-write a large frame
              socket.pause();
              await _sendWsEventStreamed(tunnelId, payload, false);
              // Cooldown: let the Rust worker / browser drain before next frame
              await new Promise(r => setTimeout(r, 30));
              socket.resume();
            } else {
              sendEvent('ws:data', tunnelId, payload);
            }
          } else if (result.opcode === 0x02) {
            // Binary frame — base64 encode, stream if large
            const payload = result.payload.toString('base64');
            if (payload.length > 100000) {
              socket.pause();
              await _sendWsEventStreamed(tunnelId, payload, true);
              await new Promise(r => setTimeout(r, 30));
              socket.resume();
            } else {
              sendEvent('ws:data', tunnelId, payload, 'binary');
            }
          } else if (result.opcode === 0x08) {
            // Close frame
            const code = result.payload.length >= 2 ? result.payload.readUInt16BE(0) : 1000;
            sendEvent('ws:close', tunnelId, code);
            socket.end();
            wsTunnels.delete(tunnelId);
            processingFrames = false;
            return;
          } else if (result.opcode === 0x09) {
            // Ping → respond with pong
            const pong = encodeWsFrame(0x0A, result.payload, false);
            socket.write(pong);
          }
          // 0x0A pong — ignore
        }
        processingFrames = false;
      };

      socket.on('data', (chunk) => {
        frameBuf = Buffer.concat([frameBuf, chunk]);
        processFrames();
      });

      socket.on('close', () => {
        if (wsTunnels.has(tunnelId)) {
          sendEvent('ws:close', tunnelId, 1006);
          wsTunnels.delete(tunnelId);
        }
      });

      socket.on('error', (err) => {
        process.stderr.write(`[ws-tunnel] Error on tunnel ${tunnelId}: ${err.message}\n`);
        sendEvent('ws:error', tunnelId, err.message);
        wsTunnels.delete(tunnelId);
      });

      resolve({ tunnelId });
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(10000, () => {
      req.destroy(new Error('WebSocket handshake timeout'));
    });

    req.end();
  });
}

/** Send a text message through a WS tunnel */
function wsSend(tunnelId, data, isBinary) {
  const tunnel = wsTunnels.get(tunnelId);
  if (!tunnel || !tunnel.connected) {
    throw new Error(`WS tunnel ${tunnelId} not found or not connected`);
  }
  const buf = isBinary ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8');
  const opcode = isBinary ? 0x02 : 0x01;
  const frame = encodeWsFrame(opcode, buf, true); // client must mask
  tunnel.socket.write(frame);
}

/** Close a WS tunnel */
function wsClose(tunnelId, code) {
  const tunnel = wsTunnels.get(tunnelId);
  if (!tunnel) return;
  const codeBuf = Buffer.alloc(2);
  codeBuf.writeUInt16BE(code || 1000, 0);
  const frame = encodeWsFrame(0x08, codeBuf, true);
  tunnel.socket.write(frame);
  tunnel.socket.end();
  wsTunnels.delete(tunnelId);
}

// ---------------------------------------------------------------------------
// WebSocket frame codec (RFC 6455)
// ---------------------------------------------------------------------------

/**
 * Parse a single WebSocket frame from a buffer.
 * @returns {{ opcode, payload: Buffer, rest: Buffer } | null}
 */
function parseWsFrame(buf) {
  if (buf.length < 2) return null;

  const firstByte = buf[0];
  const opcode = firstByte & 0x0F;
  const secondByte = buf[1];
  const masked = !!(secondByte & 0x80);
  let payloadLen = secondByte & 0x7F;
  let offset = 2;

  if (payloadLen === 126) {
    if (buf.length < 4) return null;
    payloadLen = buf.readUInt16BE(2);
    offset = 4;
  } else if (payloadLen === 127) {
    if (buf.length < 10) return null;
    // For practical purposes, read as 32-bit (frames > 4GB unlikely)
    payloadLen = buf.readUInt32BE(6);
    offset = 10;
  }

  const maskLen = masked ? 4 : 0;
  const totalLen = offset + maskLen + payloadLen;
  if (buf.length < totalLen) return null;

  let payload;
  if (masked) {
    const maskKey = buf.slice(offset, offset + 4);
    payload = Buffer.alloc(payloadLen);
    for (let i = 0; i < payloadLen; i++) {
      payload[i] = buf[offset + 4 + i] ^ maskKey[i % 4];
    }
  } else {
    payload = buf.slice(offset, offset + payloadLen);
  }

  return { opcode, payload, rest: buf.slice(totalLen) };
}

/**
 * Encode a WebSocket frame.
 * @param {number} opcode
 * @param {Buffer} payload
 * @param {boolean} mask - true for client→server frames
 * @returns {Buffer}
 */
function encodeWsFrame(opcode, payload, mask) {
  const len = payload.length;
  let headerLen = 2;
  if (len > 65535) headerLen += 8;
  else if (len > 125) headerLen += 2;
  if (mask) headerLen += 4;

  const frame = Buffer.alloc(headerLen + len);
  frame[0] = 0x80 | opcode; // FIN + opcode

  let offset = 2;
  if (len > 65535) {
    frame[1] = mask ? (127 | 0x80) : 127;
    frame.writeUInt32BE(0, 2);   // high 32 bits = 0
    frame.writeUInt32BE(len, 6); // low 32 bits
    offset = 10;
  } else if (len > 125) {
    frame[1] = mask ? (126 | 0x80) : 126;
    frame.writeUInt16BE(len, 2);
    offset = 4;
  } else {
    frame[1] = mask ? (len | 0x80) : len;
  }

  if (mask) {
    const maskKey = crypto.randomBytes(4);
    maskKey.copy(frame, offset);
    offset += 4;
    for (let i = 0; i < len; i++) {
      frame[offset + i] = payload[i] ^ maskKey[i % 4];
    }
  } else {
    payload.copy(frame, offset);
  }

  return frame;
}

// ============================================================================
// HTTP Proxy (for embedding code-server UI in a browser iframe)
// ============================================================================

/**
 * Proxy an HTTP request to the running code-server instance.
 * Returns { status, statusText, headers, body } where body is base64-encoded.
 *
 * @param {{ method: string, path: string, headers?: object, body?: string }} reqData
 * @returns {Promise<{ status: number, statusText: string, headers: object, body: string }>}
 */
function proxyHttpRequest(reqData) {
  return new Promise((resolve, reject) => {
    const { method = 'GET', path = '/', headers = {}, body } = reqData;

    const options = {
      hostname: '127.0.0.1',
      port: serverPort,
      path,
      method,
      headers: {
        ...headers,
        host: `127.0.0.1:${serverPort}`,
      },
    };

    const req = http.request(options, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const bodyBuf = Buffer.concat(chunks);
        // Convert response headers to a plain object
        const respHeaders = {};
        for (const [key, value] of Object.entries(res.headers)) {
          respHeaders[key] = Array.isArray(value) ? value.join(', ') : value;
        }
        resolve({
          status: res.statusCode,
          statusText: res.statusMessage || '',
          headers: respHeaders,
          body: bodyBuf.toString('base64'),
        });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Proxy request timeout'));
    });

    if (body) {
      req.write(Buffer.from(body, 'base64'));
    }
    req.end();
  });
}

// ============================================================================
// Sidebar-Only CSS (injected when sidebarOnly=true)
// ============================================================================

/**
 * Returns a <style> block that hides everything except the sidebar panel.
 * Used when embedding code-server in a scoped iframe for extension views.
 */
function getSidebarOnlyCSS() {
  return `
<style id="synthi-sidebar-only">
  .part.editor,
  .part.panel,
  .part.statusbar,
  .part.titlebar,
  .part.auxiliarybar,
  .part.activitybar {
    display: none !important;
    width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
  }
  .part.sidebar {
    position: fixed !important;
    left: 0 !important;
    top: 0 !important;
    width: 100vw !important;
    height: 100vh !important;
    max-width: 100vw !important;
    z-index: 99999 !important;
  }
  .split-view-container,
  .composite.viewlet,
  .composite.viewlet > .content,
  .pane-body,
  .monaco-scrollable-element {
    width: 100% !important;
    max-width: 100% !important;
  }
  .composite.title {
    display: none !important;
  }
  body, .monaco-workbench {
    background: transparent !important;
  }
</style>`;
}

// ============================================================================
// WebSocket Shim (injected into code-server HTML)
// ============================================================================

/**
 * Returns a JavaScript string that, when injected into the code-server page,
 * overrides the native WebSocket constructor to route all WS traffic through
 * window.parent.postMessage → our tunnel pipeline.
 */
function getWsShimScript() {
  return `
(function() {
  if(window.__synthiWsShim) return;
  window.__synthiWsShim = true;

  var RealWebSocket = window.WebSocket;
  var tunnelIdCounter = 0;

  function TunnelWebSocket(url, protocols) {
    var self = this;
    this._tunnelId = null;
    this._url = url;
    this._protocols = protocols;
    this.readyState = 0; // CONNECTING
    this.bufferedAmount = 0;
    this.extensions = '';
    this.protocol = '';
    this.binaryType = 'blob';
    this.onopen = null;
    this.onmessage = null;
    this.onerror = null;
    this.onclose = null;
    this._listeners = {};

    // Parse the URL to extract just the path+query
    var parsed;
    try { parsed = new URL(url); } catch(e) { parsed = { pathname: '/', search: '' }; }
    var wsPath = parsed.pathname + parsed.search;

    // Request tunnel via parent
    window.parent.postMessage({
      type: 'synthi-ws-connect',
      path: wsPath,
    }, '*');

    // Listen for responses
    function onMessage(evt) {
      var msg = evt.data;
      if (!msg || !msg.type) return;

      if (msg.type === 'synthi-ws-connected' && self._tunnelId === null && msg.path === wsPath) {
        self._tunnelId = msg.tunnelId;
        self.readyState = 1; // OPEN
        var openEvt = new Event('open');
        if (self.onopen) self.onopen(openEvt);
        self.dispatchEvent(openEvt);
        return;
      }

      if (self._tunnelId === null) return;

      if (msg.type === 'synthi-ws-data' && msg.tunnelId === self._tunnelId) {
        var msgEvt;
        if (msg.binary) {
          // Convert base64 to ArrayBuffer, wrap in Blob if binaryType is 'blob'
          var binary = atob(msg.data);
          var bytes = new Uint8Array(binary.length);
          for (var i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          var d = self.binaryType === 'blob' ? new Blob([bytes.buffer]) : bytes.buffer;
          msgEvt = new MessageEvent('message', { data: d });
        } else {
          msgEvt = new MessageEvent('message', { data: msg.data });
        }
        if (self.onmessage) self.onmessage(msgEvt);
        self.dispatchEvent(msgEvt);
        return;
      }

      if (msg.type === 'synthi-ws-close' && msg.tunnelId === self._tunnelId) {
        self.readyState = 3; // CLOSED
        var closeEvt = new CloseEvent('close', { code: msg.code || 1000, reason: '' });
        if (self.onclose) self.onclose(closeEvt);
        self.dispatchEvent(closeEvt);
        window.removeEventListener('message', onMessage);
        return;
      }

      if (msg.type === 'synthi-ws-error' && msg.tunnelId === self._tunnelId) {
        var errEvt = new Event('error');
        if (self.onerror) self.onerror(errEvt);
        self.dispatchEvent(errEvt);
        return;
      }
    }
    window.addEventListener('message', onMessage);
  }

  TunnelWebSocket.prototype = Object.create(EventTarget.prototype);
  TunnelWebSocket.prototype.constructor = TunnelWebSocket;
  TunnelWebSocket.CONNECTING = 0;
  TunnelWebSocket.OPEN = 1;
  TunnelWebSocket.CLOSING = 2;
  TunnelWebSocket.CLOSED = 3;

  TunnelWebSocket.prototype.send = function(data) {
    if (this.readyState !== 1) throw new DOMException('WebSocket not open', 'InvalidStateError');
    var isBinary = false;
    var payload;
    if (typeof data === 'string') {
      payload = data;
    } else {
      isBinary = true;
      var bytes = new Uint8Array(data instanceof ArrayBuffer ? data : data.buffer);
      var binary = '';
      for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
      payload = btoa(binary);
    }
    window.parent.postMessage({
      type: 'synthi-ws-send',
      tunnelId: this._tunnelId,
      data: payload,
      binary: isBinary,
    }, '*');
  };

  TunnelWebSocket.prototype.close = function(code, reason) {
    if (this.readyState >= 2) return;
    this.readyState = 2; // CLOSING
    window.parent.postMessage({
      type: 'synthi-ws-close',
      tunnelId: this._tunnelId,
      code: code || 1000,
    }, '*');
  };

  // EventTarget methods
  TunnelWebSocket.prototype.addEventListener = function(type, fn) {
    if (!this._listeners[type]) this._listeners[type] = [];
    this._listeners[type].push(fn);
  };
  TunnelWebSocket.prototype.removeEventListener = function(type, fn) {
    if (!this._listeners[type]) return;
    this._listeners[type] = this._listeners[type].filter(function(f) { return f !== fn; });
  };
  TunnelWebSocket.prototype.dispatchEvent = function(evt) {
    var fns = this._listeners[evt.type] || [];
    for (var i = 0; i < fns.length; i++) { try { fns[i](evt); } catch(e) { console.error(e); } }
    return true;
  };

  window.WebSocket = TunnelWebSocket;
  console.log('[synthi-ws-shim] WebSocket shim installed');
})();
`;
}

// ============================================================================
// stdin Command Handler
// ============================================================================

const rl = readline.createInterface({ input: process.stdin, terminal: false });

rl.on('line', async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    process.stderr.write(`[vscode-server-manager] Invalid JSON: ${line}\n`);
    return;
  }

  const { id, method, args = [] } = msg;

  try {
    switch (method) {
      case 'startServer': {
        const [slug, options] = args;
        const result = await startServer(slug, options || {});
        sendResponse(id, result);
        break;
      }

      case 'stopServer': {
        await stopServer();
        sendResponse(id, { success: true });
        break;
      }

      case 'getStatus': {
        sendResponse(id, {
          state: serverState,
          port: serverPort,
          token: serverToken,
          slug: currentSlug,
          workspaceDir: currentWorkspaceDir,
          extensions: listInstalledExtensions(),
        });
        break;
      }

      case 'getConnectionInfo': {
        const info = getServerConnectionInfo();
        sendResponse(id, info);
        break;
      }

      case 'installExtension': {
        const [extensionId, vsixData] = args;
        const result = await installVSIX(extensionId, vsixData);
        sendResponse(id, result);
        break;
      }

      case 'uninstallExtension': {
        const [extensionId] = args;
        const result = uninstallExtension(extensionId);
        sendResponse(id, result);
        break;
      }

      case 'listExtensions': {
        const exts = listInstalledExtensions();
        sendResponse(id, exts);
        break;
      }

      case 'installExtensionFromMarketplace': {
        // Install via CLI: code-server --install-extension <id>
        const [extensionId] = args;
        const binary = findServerBinary();
        if (!binary) {
          sendResponse(id, null, new Error('Server binary not found'));
          break;
        }
        try {
          execFileSync(binary, [
            '--install-extension', extensionId,
            '--extensions-dir', EXTENSIONS_DIR,
          ], {
            timeout: 120000,
            stdio: ['ignore', 'pipe', 'pipe'],
          });

          // Track UI contributions and request preload refresh
          try {
            await loadExtensionForUI(extensionId);
          } catch (uiErr) {
            process.stderr.write(`[vscode-server-manager] UI bridge load failed for ${extensionId}: ${uiErr.message}\n`);
          }

          // With the preload approach, ALL extensions get the real vscode API
          // and UI events are automatically bridged. Always report uiBridged=true
          // so the browser never falls back to synthetic placeholder events.
          sendResponse(id, { success: true, extensionId, uiBridged: true });
        } catch (err) {
          sendResponse(id, null, err);
        }
        break;
      }

      case 'loadExtensionForUI': {
        // Explicitly load an already-installed extension into the UI bridge
        const [extensionId] = args;
        try {
          const result = await loadExtensionForUI(extensionId);
          sendResponse(id, result);
        } catch (err) {
          sendResponse(id, null, err);
        }
        break;
      }

      case 'proxyHttp': {
        const [reqData] = args;
        if (!serverPort || serverState !== 'running') {
          sendResponse(id, null, new Error('VS Code Server not running'));
          break;
        }
        try {
          const proxyResult = await proxyHttpRequest(reqData);

          // Inject WebSocket shim into HTML responses so code-server uses our tunnel
          const ct = (proxyResult.headers['content-type'] || '');
          if (ct.includes('text/html') && proxyResult.body) {
            const html = Buffer.from(proxyResult.body, 'base64').toString('utf8');
            const shimScript = getWsShimScript();
            let injections = `<script>${shimScript}</script>`;

            // Sidebar-only mode: inject CSS to hide editor/terminal/statusbar
            // and make the sidebar fill the viewport
            const reqPath = reqData.path || '';
            if (reqPath.includes('sidebarOnly=true')) {
              injections += getSidebarOnlyCSS();
            }

            const injectedHtml = html.replace('<head>', `<head>${injections}`);
            proxyResult.body = Buffer.from(injectedHtml, 'utf8').toString('base64');
          }

          // Stream large responses to avoid DataChannel buffer overflow.
          // Static JS/CSS bundles can be 1-17MB base64-encoded.
          const bodyLen = proxyResult.body ? proxyResult.body.length : 0;
          if (bodyLen > 200000) {
            await sendResponseStreamed(id, proxyResult);
          } else {
            sendResponse(id, proxyResult);
          }
        } catch (err) {
          sendResponse(id, null, err);
        }
        break;
      }

      case 'wsConnect': {
        const [urlPath] = args;
        if (!serverPort || serverState !== 'running') {
          sendResponse(id, null, new Error('VS Code Server not running'));
          break;
        }
        try {
          const tunnelId = ++wsTunnelIdCounter;
          const result = await wsConnect(tunnelId, urlPath);
          sendResponse(id, result);
        } catch (err) {
          sendResponse(id, null, err);
        }
        break;
      }

      case 'wsSend': {
        const [tunnelId, data, isBinary] = args;
        try {
          wsSend(tunnelId, data, isBinary);
          // Fire-and-forget: skip response to reduce DataChannel traffic.
          // The browser side sends wsSend without awaiting a response.
        } catch (err) {
          // Only respond on error so the browser can log it
          sendResponse(id, null, err);
        }
        break;
      }

      case 'wsClose': {
        const [tunnelId, code] = args;
        wsClose(tunnelId, code);
        sendResponse(id, { success: true });
        break;
      }

      default:
        sendResponse(id, null, new Error(`Unknown method: ${method}`));
    }
  } catch (err) {
    sendResponse(id, null, err);
  }
});

// ============================================================================
// Signal Handling
// ============================================================================

process.on('SIGTERM', async () => {
  process.stderr.write('[vscode-server-manager] SIGTERM received, shutting down...\n');
  await stopServer();
  process.exit(0);
});

process.on('SIGINT', async () => {
  process.stderr.write('[vscode-server-manager] SIGINT received, shutting down...\n');
  await stopServer();
  process.exit(0);
});

rl.on('close', async () => {
  process.stderr.write('[vscode-server-manager] stdin closed, shutting down...\n');
  await stopServer();
  process.exit(0);
});

// Announce readiness — the manager is ready to receive commands (startServer,
// installExtension, etc.) via stdin immediately.  The browser-side
// VSCodeServerProxy.waitForReady() listens for this event.
process.stderr.write('[vscode-server-manager] VS Code Server Manager started\n');
sendEvent('workerReady');
