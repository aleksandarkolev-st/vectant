#!/usr/bin/env node
/**
 * VS Code Server Manager
 *
 * Manages the lifecycle of a real VS Code Server (code-server / vscode-server)
 * on the backend. Extensions run in the genuine Extension Host with full
 * `vscode.*` API.  ext-host-preload.js is injected via NODE_OPTIONS to wrap
 * the real API and relay UI events back through a TCP bridge.
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
 * so the Rust worker can spawn it via the vscode-server DataChannel.
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
// Protocol (stdin/stdout JSON)
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

/** @type {Function[]} Callbacks waiting for first preload client */
const _preloadReadyWaiters = [];

/** @type {Map<string, object>} viewId → last known tree data */
const preloadTreeCache = new Map();

/** @type {boolean} Whether the bootstrapState message has been received from preload */
let _bootstrapStateReceived = false;

/**
 * Trigger provider discovery with retried attempts.
 * Called once from either bootstrapState handler or the 45s fallback timer.
 *
 * @param {string} trigger - reason string for logging
 */
function _startProviderDiscovery(trigger) {
  const retryDelays = [500, 3000, 8000, 20000];
  for (const delay of retryDelays) {
    const timer = setTimeout(() => {
      process.stderr.write(`[preload-bridge] Provider discovery (${delay / 1000}s after ${trigger})\n`);
      sendToPreloadClients({ action: 'listProviders' });
      sendToPreloadClients({ action: 'refreshAllTrees' });
      // Try resolving known webview views
      for (const extId of extHostLoadedExtensions) {
        const result = _readExtensionManifest(extId);
        if (result?.manifest?.contributes?.views) {
          const views = result.manifest.contributes.views;
          for (const container of Object.keys(views)) {
            for (const view of views[container]) {
              if (view.type === 'webview') {
                sendToPreloadClients({ action: 'resolveWebviewView', viewType: view.id });
              }
            }
          }
        }
      }
    }, delay);
    if (timer.unref) timer.unref();
  }
}

/**
 * Wait for at least one preload client to connect to the bridge.
 * Resolves immediately if a client is already connected.
 *
 * @param {number} timeoutMs - Maximum time to wait (default 15s)
 * @returns {Promise<boolean>} true if a client connected, false if timed out
 */
function waitForPreloadClient(timeoutMs = 15000) {
  if (preloadClients.size > 0) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      const idx = _preloadReadyWaiters.indexOf(cb);
      if (idx !== -1) _preloadReadyWaiters.splice(idx, 1);
      resolve(false);
    }, timeoutMs);
    if (timer.unref) timer.unref();
    function cb() {
      clearTimeout(timer);
      resolve(true);
    }
    _preloadReadyWaiters.push(cb);
  });
}

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
      process.stderr.write(`[preload-bridge] Client connected from Extension Host (total: ${preloadClients.size + 1})\n`);
      preloadClients.add(socket);

      // Notify anyone waiting for a preload client
      while (_preloadReadyWaiters.length > 0) {
        const cb = _preloadReadyWaiters.shift();
        try { cb(); } catch (_) {}
      }

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
      sendEvent('createWebview', msg.viewType, msg.viewType, msg.viewType, { extensionId: msg.extensionId });
      // Auto-resolve: code-server is headless so the sidebar never opens,
      // meaning resolveWebviewView is never called naturally.  We trigger
      // it ourselves so the extension generates its HTML content.
      setTimeout(() => {
        process.stderr.write(`[preload-bridge] Auto-resolving webview view: ${msg.viewType}\n`);
        sendToPreloadClients({ action: 'resolveWebviewView', viewType: msg.viewType });
      }, 500);
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
      sendEvent('createWebview', msg.viewId, msg.viewType, msg.title, { extensionId: msg.extensionId });
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

    case 'hello': {
      // Preload client connected and identified itself
      process.stderr.write(`[preload-bridge] Hello from Extension Host (pid: ${msg.pid}, ppid: ${msg.ppid})\n`);

      // Auto-scan extension manifests for UI contribution metadata.
      // This only reads package.json files — it does NOT load or activate
      // extensions.  We need to know which extensions have views/webviews
      // so we can request data once they DO activate.
      _autoLoadUIExtensions().catch(err => {
        process.stderr.write(`[preload-bridge] Auto-load UI extensions failed: ${err.message}\n`);
      });

      // DO NOT request providers here.  Extensions haven't activated yet
      // because VS Code's bootstrap hasn't finished registering the
      // virtual 'vscode' module.  Requesting providers now always returns
      // 0 trees, 0 webviews — it's pure noise.
      //
      // Provider requests are deferred to the 'bootstrapState' handler
      // (below) which fires when the preload observes the first successful
      // require('vscode') call.
      //
      // Fallback: if bootstrapState never fires (e.g. because Module._load
      // interception fails in ESM mode), start requesting providers after
      // a generous timeout.
      process.stderr.write(`[preload-bridge] Waiting for bootstrapState before requesting providers\n`);
      const _bootstrapFallbackTimer = setTimeout(() => {
        if (!_bootstrapStateReceived) {
          process.stderr.write(`[preload-bridge] bootstrapState never received after 45s — requesting providers as fallback\n`);
          _startProviderDiscovery('fallback-timeout');
        }
      }, 45000);
      if (_bootstrapFallbackTimer.unref) _bootstrapFallbackTimer.unref();
      break;
    }

    case 'bootstrapState': {
      // The preload's Module.prototype.require hook observed that
      // require('vscode') returned a real API object.  This means
      // VS Code's bootstrap completed and extensions are activating.
      const complete = msg.complete;
      const method = msg.method || 'unknown';
      const wrappedCount = msg.wrappedCount || 0;
      process.stderr.write(`[preload-bridge] Bootstrap state: complete=${complete}, method=${method}, wrapped=${wrappedCount}\n`);

      if (complete) {
        _bootstrapStateReceived = true;
        sendEvent('bootstrapState', true);
        _startProviderDiscovery('bootstrapState');
      }
      break;
    }

    case 'ipcState': {
      // IPC state report from the preload script
      process.stderr.write(`[preload-bridge] IPC state: readySent=${msg.readySent}, socketReceived=${msg.socketReceived}, socketType=${msg.socketType}\n`);
      if (!msg.socketReceived) {
        process.stderr.write(`[preload-bridge] WARNING: Extension Host did not receive client socket — EH initialization may be stalled\n`);
      }
      break;
    }

    case 'providerList': {
      // Response to a listProviders request — log and forward to browser
      const treeCount = msg.treeViews?.length || 0;
      const webviewCount = msg.webviews?.length || 0;
      process.stderr.write(`[preload-bridge] Provider list: ${treeCount} trees, ${webviewCount} webviews\n`);
      sendEvent('providerList', msg.treeViews, msg.webviews);
      break;
    }

    case 'ehExit': {
      // Extension Host process is exiting
      process.stderr.write(`[preload-bridge] Extension Host exiting: code=${msg.code}, uptime=${msg.uptime}s, api=${msg.apiIntercepted}, trees=${msg.treeProviders}, webviews=${msg.webviewProviders}\n`);
      sendEvent('ehProcessExit', msg.code, msg.uptime, msg.apiIntercepted);
      break;
    }

    case 'ehError': {
      // Uncaught exception or unhandled rejection in Extension Host
      process.stderr.write(`[preload-bridge] Extension Host error: ${msg.error}${msg.rejection ? ' (unhandled rejection)' : ''}\n`);
      if (msg.stack) {
        process.stderr.write(`[preload-bridge]   ${msg.stack.split('\n').slice(0, 3).join('\n  ')}\n`);
      }
      sendEvent('ehError', msg.error, msg.rejection || false);
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
// Extension Host Preload Injection
//
// VS Code / code-server strips NODE_OPTIONS from the Extension Host child
// process environment.  This means --require ext-host-preload.js never
// reaches the Extension Host.  To work around this we patch
// extensionHostProcess.js (the Extension Host entrypoint) to require our
// preload at the very top, before any extension code loads.
// ============================================================================

/**
 * Patch code-server's extensionHostProcess.js to require our preload script.
 * Uses begin/end markers so the injection block can be replaced on each
 * restart with the current bridge port.
 *
 * @param {string} serverBinaryPath - Path to the code-server binary
 * @param {string} preloadPath - Absolute path to ext-host-preload.js
 * @param {number} bridgePort - TCP port for the preload bridge
 * @returns {boolean} true if patching succeeded
 */
function _patchExtensionHostForPreload(serverBinaryPath, preloadPath, bridgePort) {
  const BEGIN_MARKER = '/* SYNTHI_PRELOAD_BEGIN */';
  const END_MARKER = '/* SYNTHI_PRELOAD_END */';

  // Derive the code-server root from the binary.
  // code-server standalone: /root/.synthi/vscode-server/bin/code-server
  //   → root = /root/.synthi/vscode-server
  // Symlinked: bin/code-server → ../lib/code-server-4.x.x/bin/code-server
  //   → resolvedRoot = lib/code-server-4.x.x (go up 2)
  //   → also check VSCODE_SERVER_DIR as primary root
  let resolvedBinary = serverBinaryPath;
  try {
    resolvedBinary = fs.realpathSync(serverBinaryPath);
  } catch (e) {
    // Use original path
  }

  // Collect multiple root candidates to search
  const rootCandidates = new Set();
  // From original binary (e.g. /root/.synthi/vscode-server)
  rootCandidates.add(path.dirname(path.dirname(serverBinaryPath)));
  // From resolved binary (follows symlinks)
  rootCandidates.add(path.dirname(path.dirname(resolvedBinary)));
  // The configured VSCODE_SERVER_DIR
  rootCandidates.add(VSCODE_SERVER_DIR);

  // Search common paths for extensionHostProcess.js
  const candidates = [];
  for (const serverRoot of rootCandidates) {
    candidates.push(
      // Standalone code-server install (typical)
      path.join(serverRoot, 'lib', 'vscode', 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js'),
      // Code-server npm install
      path.join(serverRoot, 'node_modules', 'code-server', 'lib', 'vscode', 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js'),
      // VS Code Server (Remote SSH)
      path.join(serverRoot, 'out', 'vs', 'workbench', 'api', 'node', 'extensionHostProcess.js'),
    );
  }

  // Also try `find` on Linux for non-standard layouts
  if (process.platform !== 'win32') {
    for (const serverRoot of rootCandidates) {
      try {
        const found = execSync(
          `find "${serverRoot}" -name "extensionHostProcess.js" -path "*/api/node/*" -maxdepth 8 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim().split('\n').filter(Boolean);
        for (const f of found) {
          if (!candidates.includes(f)) candidates.push(f);
        }
      } catch (_) {}
    }
  }

  // Build the injection block with the current bridge port.
  //
  // code-server 4.108+ uses VS Code's ESM build, so extensionHostProcess.js
  // runs as an ES module where `require` is not defined.  We use
  // `createRequire` from `node:module` to get a CJS-compatible require.
  //
  // CRITICAL: In ESM, all `import` declarations are hoisted and evaluated
  // BEFORE any top-level code.  This means the original file's imports
  // (which load VS Code's entire module graph) run before our env var
  // assignments and preload require().  We MUST set env vars before the
  // import statement to ensure the bootstrap-fork.js patch (which checks
  // process.argv, not env vars) can fire correctly.
  //
  // The env var assignments use process.env which is synchronous and
  // available immediately.  The `import` from `node:module` is hoisted
  // but createRequire is used in top-level code which runs after all
  // imports.  Our preload runs as CJS require() and installs hooks
  // before extensionHostProcess.js's own top-level code executes.
  const escapedPath = preloadPath.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const injection = [
    BEGIN_MARKER,
    `import { createRequire as __synthiCR } from "node:module";`,
    `process.env.SYNTHI_EXT_BRIDGE_PORT = process.env.SYNTHI_EXT_BRIDGE_PORT || "${bridgePort}";`,
    `process.env.SYNTHI_EXTENSION_HOST_CONFIRMED = "true";`,
    `const __synthiRequire = __synthiCR(import.meta.url);`,
    `try { __synthiRequire("${escapedPath}"); }`,
    `catch (_e) { process.stderr.write("[ext-host-preload] Injection failed: " + _e.message + "\\n"); }`,
    END_MARKER,
    '',  // blank line separator
  ].join('\n');

  for (const candidate of candidates) {
    if (!fs.existsSync(candidate)) continue;

    try {
      let content = fs.readFileSync(candidate, 'utf8');

      // Remove existing injection block if present (port may have changed)
      const beginIdx = content.indexOf(BEGIN_MARKER);
      const endIdx = content.indexOf(END_MARKER);
      if (beginIdx !== -1 && endIdx !== -1) {
        const endOfBlock = endIdx + END_MARKER.length;
        // Also remove trailing newline
        const afterBlock = content[endOfBlock] === '\n' ? endOfBlock + 1 : endOfBlock;
        content = content.slice(0, beginIdx) + content.slice(afterBlock);
        process.stderr.write(`[vscode-server-manager] Removed stale preload injection from: ${candidate}\n`);
      }

      // Inject at the very top of the file
      fs.writeFileSync(candidate, injection + content);
      process.stderr.write(`[vscode-server-manager] Patched extensionHostProcess.js (bridge port ${bridgePort}): ${candidate}\n`);

      // Also patch bootstrap-fork.js for early ODP trap
      _patchBootstrapFork(rootCandidates, bridgePort);

      return true;
    } catch (e) {
      process.stderr.write(`[vscode-server-manager] Failed to patch ${candidate}: ${e.message}\n`);
    }
  }

  process.stderr.write(`[vscode-server-manager] WARNING: Could not find extensionHostProcess.js to patch\n`);
  process.stderr.write(`[vscode-server-manager]   Searched roots: ${[...rootCandidates].join(', ')}\n`);
  process.stderr.write(`[vscode-server-manager]   Candidates tried: ${candidates.length}\n`);
  return false;
}

/**
 * Patch bootstrap-fork.js to install an early Object.defineProperty trap.
 *
 * bootstrap-fork.js runs BEFORE extensionHostProcess.js (it's the CJS entry
 * point that forks child processes). VS Code's static ESM imports in
 * extensionHostProcess.js are evaluated before our preload's top-level code.
 * During ESM evaluation, VS Code's modules may cache Object.defineProperty.
 *
 * By patching bootstrap-fork.js, our ODP trap is in place before ANY ESM
 * evaluation happens, so we intercept _VSCODE_IMPORT_VSCODE_API even when
 * VS Code uses a cached ODP reference.
 *
 * CRITICAL: We use process.argv check (--type=extensionHost) instead of
 * SYNTHI_EXTENSION_HOST_CONFIRMED because the env var is set in
 * extensionHostProcess.js which runs AFTER bootstrap-fork.js.
 *
 * @param {Set<string>} rootCandidates - Server root directory candidates
 * @param {number} bridgePort - TCP port for the preload bridge
 */
function _patchBootstrapFork(rootCandidates, bridgePort) {
  const BOOTSTRAP_BEGIN = '/* SYNTHI_BOOTSTRAP_PRELOAD_BEGIN */';
  const BOOTSTRAP_END = '/* SYNTHI_BOOTSTRAP_PRELOAD_END */';

  const bootstrapCandidates = [];
  for (const serverRoot of rootCandidates) {
    bootstrapCandidates.push(
      path.join(serverRoot, 'lib', 'vscode', 'out', 'bootstrap-fork.js'),
      path.join(serverRoot, 'node_modules', 'code-server', 'lib', 'vscode', 'out', 'bootstrap-fork.js'),
      path.join(serverRoot, 'out', 'bootstrap-fork.js'),
    );
  }

  // Also search via find on Linux
  if (process.platform !== 'win32') {
    for (const serverRoot of rootCandidates) {
      try {
        const found = execSync(
          `find "${serverRoot}" -name "bootstrap-fork.js" -path "*/out/*" -maxdepth 6 2>/dev/null`,
          { encoding: 'utf8', timeout: 5000 }
        ).trim().split('\n').filter(Boolean);
        for (const f of found) {
          if (!bootstrapCandidates.includes(f)) bootstrapCandidates.push(f);
        }
      } catch (_) {}
    }
  }

  // Guard uses process.argv instead of env var — env var isn't set yet.
  // bootstrap-fork.js runs for ALL forked processes (PTY host, file watcher,
  // etc.), so we MUST check --type=extensionHost to avoid false positives.
  const bootstrapInjection = [
    BOOTSTRAP_BEGIN,
    `// Early Object.defineProperty trap — installed before ANY ESM imports.`,
    `// Uses process.argv guard (not env var — env var set after this runs).`,
    `(function() {`,
    `  if (!process.argv.includes('--type=extensionHost')) return;`,
    `  process.env.SYNTHI_EXT_BRIDGE_PORT = process.env.SYNTHI_EXT_BRIDGE_PORT || "${bridgePort}";`,
    `  const _origODP = Object.defineProperty;`,
    `  const _PREFIX = '[ext-host-preload:bootstrap]';`,
    `  let _odpCount = 0;`,
    `  Object.defineProperty = function(target, prop, descriptor) {`,
    `    if (target === globalThis && _odpCount < 50) {`,
    `      _odpCount++;`,
    `      process.stderr.write(_PREFIX + ' ODP: globalThis.' + String(prop) + ' type=' + typeof (descriptor && descriptor.value) + '\\n');`,
    `    }`,
    `    if (target === globalThis && typeof prop === 'string' && prop.includes('VSCODE') && prop.includes('IMPORT') && descriptor && typeof descriptor.value === 'function') {`,
    `      process.stderr.write(_PREFIX + ' INTERCEPTED: globalThis.' + prop + ' — wrapping API factory\\n');`,
    `      const origFn = descriptor.value;`,
    `      const wrappedFn = function() {`,
    `        const result = origFn.apply(this, arguments);`,
    `        return result;`,
    `      };`,
    `      wrappedFn._synthiWrapped = true;`,
    `      wrappedFn._origFn = origFn;`,
    `      descriptor = Object.assign({}, descriptor, { value: wrappedFn, configurable: true });`,
    `    }`,
    `    return _origODP.call(this, target, prop, descriptor);`,
    `  };`,
    `  process.stderr.write(_PREFIX + ' Early ODP trap installed\\n');`,
    `})();`,
    BOOTSTRAP_END,
    '',
  ].join('\n');

  for (const candidate of bootstrapCandidates) {
    if (!fs.existsSync(candidate)) continue;

    try {
      let content = fs.readFileSync(candidate, 'utf8');

      // Remove existing injection
      const beginIdx = content.indexOf(BOOTSTRAP_BEGIN);
      const endIdx = content.indexOf(BOOTSTRAP_END);
      if (beginIdx !== -1 && endIdx !== -1) {
        const endOfBlock = endIdx + BOOTSTRAP_END.length;
        const afterBlock = content[endOfBlock] === '\n' ? endOfBlock + 1 : endOfBlock;
        content = content.slice(0, beginIdx) + content.slice(afterBlock);
        process.stderr.write(`[vscode-server-manager] Removed stale bootstrap injection from: ${candidate}\n`);
      }

      // Inject at the very top
      fs.writeFileSync(candidate, bootstrapInjection + content);
      process.stderr.write(`[vscode-server-manager] Patched bootstrap-fork.js: ${candidate}\n`);
      return true;
    } catch (e) {
      process.stderr.write(`[vscode-server-manager] Failed to patch bootstrap-fork.js ${candidate}: ${e.message}\n`);
    }
  }

  return false;
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

    // ── Patch the Extension Host entrypoint ──
    // VS Code's Extension Host launcher strips NODE_OPTIONS, so --require
    // never reaches the Extension Host. We patch extensionHostProcess.js
    // directly to require our preload script at the top of the file.
    // This is the ONLY injection mechanism — we deliberately do NOT set
    // NODE_OPTIONS because it would load the preload in non-EH processes
    // (code-server's main process, PTY host, etc.) causing false positives.
    const preloadPath = path.join(__dirname, 'ext-host-preload.js');
    if (bridgePort) {
      _patchExtensionHostForPreload(binary, preloadPath, bridgePort);
    }

    // ── Ensure required extensions are installed ──
    // Extensions MUST be on disk before the Extension Host starts,
    // otherwise there's nothing for it to load.
    try {
      const extResult = await _ensureRequiredExtensions(binary);
      process.stderr.write(`[vscode-server-manager] Extension verification: ${extResult.alreadyPresent.length} present, ${extResult.installed.length} installed, ${extResult.failed.length} failed\n`);
    } catch (extErr) {
      process.stderr.write(`[vscode-server-manager] Extension verification failed (non-fatal): ${extErr.message}\n`);
    }

    process.stderr.write(`[vscode-server-manager] Starting: ${binary} ${args.join(' ')}\n`);

    serverProcess = spawn(binary, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // Pass connection token for server-side validation
        VSCODE_SERVER_TOKEN: token,
        // Disable GPU (headless server)
        VSCODE_CLI_DISABLE_GPU: '1',
        // Tell the preload script where our TCP bridge is listening
        // (inherited by Extension Host child process via the env)
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

    // ── Trigger Extension Host startup ──
    // code-server only spawns the Extension Host when a browser session
    // connects via WebSocket. Since we use it headlessly, we initiate a
    // WebSocket connection ourselves to force the EH to start.
    _triggerExtensionHostStartup(port, token).catch(err => {
      process.stderr.write(`[vscode-server-manager] EH trigger failed (non-fatal): ${err.message}\n`);
    });

    process.stderr.write(`[vscode-server-manager] Server ready on port ${port}\n`);
    return { port, token, workspaceDir };

  } catch (err) {
    serverState = 'error';
    sendEvent('serverStatus', 'error', err.message);
    throw err;
  }
}

/**
 * Trigger the Extension Host to start by opening a WebSocket connection to
 * code-server and speaking the VS Code remote protocol.
 *
 * code-server only spawns the Extension Host when a client connects via
 * the remote protocol (handleUpgrade → auth → connectionType).  A bare
 * WebSocket upgrade is not enough — the server waits for the client to
 * send a Control message with { type:'auth' }, responds with
 * { type:'sign' }, and then expects { desiredConnectionType:2 }
 * (ExtensionHost) to actually fork the Extension Host process.
 *
 * We use --without-connection-token (set by code-server), so any auth
 * token is accepted.
 *
 * @param {number} port
 * @param {string} token
 * @returns {Promise<void>}
 */
async function _triggerExtensionHostStartup(port, token) {
  // ── Step 0: Read VS Code's commit hash from product.json ──────────
  let vsCodeCommit = 'unknown';
  try {
    const binary = findServerBinary();
    let resolvedBinary = binary;
    try { resolvedBinary = fs.realpathSync(binary); } catch (_) {}
    // code-server: <root>/lib/code-server-4.x/lib/vscode/product.json
    const codeServerRoot = path.dirname(path.dirname(resolvedBinary));
    const productCandidates = [
      path.join(codeServerRoot, 'lib', 'vscode', 'product.json'),
      path.join(codeServerRoot, 'product.json'),
      path.join(path.dirname(codeServerRoot), 'lib', 'vscode', 'product.json'),
    ];
    for (const p of productCandidates) {
      try {
        const product = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (product.commit) { vsCodeCommit = product.commit; break; }
      } catch (_) {}
    }
  } catch (_) {}
  process.stderr.write(`[vscode-server-manager] VS Code commit for EH trigger: ${vsCodeCommit}\n`);

  // ── Step 1: Load the workspace page (may bootstrap session) ────────
  await new Promise((resolve) => {
    const req = http.get(`http://127.0.0.1:${port}/`, (res) => {
      res.resume(); // Drain
      process.stderr.write(`[vscode-server-manager] Workspace page loaded (status: ${res.statusCode})\n`);
      resolve();
    });
    req.on('error', () => resolve());
    req.setTimeout(5000, () => { req.destroy(); resolve(); });
  });

  // ── Step 2: WebSocket upgrade ──────────────────────────────────────
  const reconnToken = crypto.randomBytes(16).toString('hex');
  const wsPath = `/?reconnectionToken=${reconnToken}&reconnection=false&skipWebSocketFrames=false`;
  const wsKey = crypto.randomBytes(16).toString('base64');

  return new Promise((resolve) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: wsPath,
      method: 'GET',
      headers: {
        'Connection': 'Upgrade',
        'Upgrade': 'websocket',
        'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': wsKey,
        'Host': `127.0.0.1:${port}`,
      },
    });

    req.on('upgrade', (_res, socket, head) => {
      process.stderr.write(`[vscode-server-manager] WebSocket upgrade ok, sending VS Code protocol handshake\n`);

      socket.unref();
      socket.setKeepAlive(true, 30000);

      // ── VS Code PersistentProtocol message types ──────────────────
      const ProtoMsgType = {
        None: 0,
        Regular: 1,
        Control: 2,
        Ack: 3,
        Disconnect: 5,
        ReplayRequest: 6,
        Pause: 7,
        Resume: 8,
        KeepAlive: 9,
      };

      // ── VS Code remote protocol helpers ──────────────────────────
      // WebSocket frame encoder (client → server, MUST be masked)
      function sendWSFrame(payload) {
        const buf = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
        const mask = crypto.randomBytes(4);
        const masked = Buffer.alloc(buf.length);
        for (let i = 0; i < buf.length; i++) masked[i] = buf[i] ^ mask[i % 4];

        let hdr;
        if (buf.length < 126) {
          hdr = Buffer.alloc(6);
          hdr[0] = 0x82; // FIN + binary
          hdr[1] = 0x80 | buf.length;
          mask.copy(hdr, 2);
        } else if (buf.length < 65536) {
          hdr = Buffer.alloc(8);
          hdr[0] = 0x82;
          hdr[1] = 0xFE;
          hdr.writeUInt16BE(buf.length, 2);
          mask.copy(hdr, 4);
        } else {
          hdr = Buffer.alloc(14);
          hdr[0] = 0x82;
          hdr[1] = 0xFF;
          hdr.writeUInt32BE(0, 2);
          hdr.writeUInt32BE(buf.length, 6);
          mask.copy(hdr, 10);
        }
        socket.write(Buffer.concat([hdr, masked]));
      }

      // VS Code PersistentProtocol control message (type = 2)
      let nextMsgId = 1;
      let lastReceivedMsgId = 0;  // tracks last msg ID from server for ack echoing
      function makeControlMsg(jsonObj) {
        const json = JSON.stringify(jsonObj);
        const jsonBuf = Buffer.from(json, 'utf8');
        const hdr = Buffer.alloc(13);
        hdr[0] = ProtoMsgType.Control;
        hdr.writeUInt32BE(nextMsgId++, 1);
        hdr.writeUInt32BE(lastReceivedMsgId, 5); // ack
        hdr.writeUInt32BE(jsonBuf.length, 9);
        return Buffer.concat([hdr, jsonBuf]);
      }

      // VS Code PersistentProtocol regular message (type = 1)
      // Used for RPC data / init data after the connection is established
      function makeRegularMsg(dataBuf) {
        if (typeof dataBuf === 'string') dataBuf = Buffer.from(dataBuf, 'utf8');
        const hdr = Buffer.alloc(13);
        hdr[0] = ProtoMsgType.Regular;
        hdr.writeUInt32BE(nextMsgId++, 1);
        hdr.writeUInt32BE(lastReceivedMsgId, 5); // ack
        hdr.writeUInt32BE(dataBuf.length, 9);
        return Buffer.concat([hdr, dataBuf]);
      }

      // WebSocket frame decoder (server → client, unmasked)
      function tryParseWSFrame(buf) {
        if (buf.length < 2) return null;
        let payloadLen = buf[1] & 0x7F;
        let offset = 2;
        if (payloadLen === 126) {
          if (buf.length < 4) return null;
          payloadLen = buf.readUInt16BE(2);
          offset = 4;
        } else if (payloadLen === 127) {
          if (buf.length < 10) return null;
          payloadLen = buf.readUInt32BE(6); // lower 32 bits
          offset = 10;
        }
        if (buf[1] & 0x80) offset += 4; // skip mask if present
        if (buf.length < offset + payloadLen) return null;
        return {
          opcode: buf[0] & 0x0F,
          payload: buf.slice(offset, offset + payloadLen),
          totalLength: offset + payloadLen,
        };
      }

      // Parse VS Code protocol message from WebSocket payload.
      // VS Code's PersistentProtocol uses a 13-byte header:
      //   byte 0:   message type (1=Regular, 2=Control, 3=Ack, 4=Disconnect, ...)
      //   bytes 1-4: message id (uint32be)
      //   bytes 5-8: ack (uint32be)
      //   bytes 9-12: data length (uint32be)
      //   bytes 13+: data (JSON for Control messages)
      // For non-Control types the data may not be JSON.
      function parseProtocolMsg(payload) {
        if (payload.length < 13) return null;
        const msgType = payload[0];
        const receivedId = payload.readUInt32BE(1);
        const dataLen = payload.readUInt32BE(9);
        if (payload.length < 13 + dataLen) return null;

        // Track the highest received message ID for ack echoing.
        // PersistentProtocol expects each outgoing message to ack the
        // last received message ID from the peer.
        if (receivedId > lastReceivedMsgId) {
          lastReceivedMsgId = receivedId;
        }

        const data = payload.slice(13, 13 + dataLen);
        if (msgType === ProtoMsgType.Control) {
          // Control — always JSON
          try { return JSON.parse(data.toString('utf8')); } catch (_) { return null; }
        }
        // Non-control: try to parse as JSON anyway (some responses use type 1)
        try {
          const parsed = JSON.parse(data.toString('utf8'));
          if (parsed && typeof parsed === 'object') return parsed;
        } catch (_) {}
        // Return a synthetic object so we can at least log the type
        return { _protoType: msgType, _dataLen: dataLen, _raw: data.toString('utf8').slice(0, 100) };
      }

      // ── Protocol state machine ──────────────────────────────────
      let step = 'awaitSign';
      let recvBuf = head && head.length > 0 ? Buffer.from(head) : Buffer.alloc(0);
      let firstMsgTime = 0;  // timestamp of first protocol message after connectionType request
      let initDataSent = false;

      // Helper: send init data + start KeepAlive loop.
      // Called exactly once from whichever path first determines the EH
      // has the socket.
      function _doSendInitData(reason) {
        if (initDataSent) return; // already sent
        initDataSent = true;
        process.stderr.write(`[vscode-server-manager] Sending init data (reason: ${reason})\n`);
        _sendExtensionHostInitData(sendWSFrame, makeRegularMsg, port).then(() => {
          process.stderr.write(`[vscode-server-manager] Extension Host init data sent successfully\n`);

          // Start protocol KeepAlive: the EH's PersistentProtocol
          // expects periodic KeepAlive (type 9) messages from the
          // client, otherwise it considers the connection dead.
          const keepAliveProtoInterval = setInterval(() => {
            try {
              const hdr = Buffer.alloc(13);
              hdr[0] = ProtoMsgType.KeepAlive;
              hdr.writeUInt32BE(nextMsgId++, 1);
              hdr.writeUInt32BE(lastReceivedMsgId, 5);  // ack last seen
              hdr.writeUInt32BE(0, 9);  // data length = 0
              sendWSFrame(hdr);
            } catch (_) {
              clearInterval(keepAliveProtoInterval);
            }
          }, 5000);
          if (keepAliveProtoInterval.unref) keepAliveProtoInterval.unref();
          socket.on('close', () => clearInterval(keepAliveProtoInterval));
        }).catch((initErr) => {
          process.stderr.write(`[vscode-server-manager] Failed to send EH init data: ${initErr.message}\n`);
        });
      }

      // Step 2a: Send auth request
      sendWSFrame(makeControlMsg({
        type: 'auth',
        auth: '00000000-0000-0000-0000-000000000000',
      }));
      process.stderr.write(`[vscode-server-manager] EH trigger: sent auth request\n`);

      socket.on('data', (chunk) => {
        recvBuf = Buffer.concat([recvBuf, chunk]);

        // Process all complete frames in buffer
        while (true) {
          const frame = tryParseWSFrame(recvBuf);
          if (!frame) break;
          recvBuf = recvBuf.slice(frame.totalLength);

          // WebSocket control frames (RFC 6455 §5.5)
          // These must be handled BEFORE trying to parse VS Code protocol
          // messages, otherwise they hit parseProtocolMsg, fail to parse,
          // and get logged as "unparseable frame" — which is misleading
          // and can cause stream desync if the log handler has side effects.
          if (frame.opcode === 0x08) { // Close
            process.stderr.write(`[vscode-server-manager] EH trigger: server closed WebSocket\n`);
            return;
          }
          if (frame.opcode === 0x09) { // Ping → must reply with Pong echoing payload
            // RFC 6455 §5.5.2: Pong MUST echo the exact payload.
            // Control frame payloads are ≤125 bytes per spec, but handle
            // extended length defensively.
            const pongPayload = frame.payload;
            const pongMask = crypto.randomBytes(4);
            let pongHdr;
            if (pongPayload.length < 126) {
              pongHdr = Buffer.alloc(6);
              pongHdr[0] = 0x8A; // FIN + pong opcode
              pongHdr[1] = 0x80 | pongPayload.length;
              pongMask.copy(pongHdr, 2);
            } else {
              // Extended length pong (unlikely but safe)
              pongHdr = Buffer.alloc(8);
              pongHdr[0] = 0x8A;
              pongHdr[1] = 0x80 | 126;
              pongHdr.writeUInt16BE(pongPayload.length, 2);
              pongMask.copy(pongHdr, 4);
            }
            const maskedPong = Buffer.alloc(pongPayload.length);
            for (let i = 0; i < pongPayload.length; i++) {
              maskedPong[i] = pongPayload[i] ^ pongMask[i % 4];
            }
            socket.write(Buffer.concat([pongHdr, maskedPong]));
            continue;
          }
          if (frame.opcode === 0x0A) { // Pong — silently consume
            continue;
          }

          const msg = parseProtocolMsg(frame.payload);
          if (!msg) {
            process.stderr.write(`[vscode-server-manager] EH trigger: rx unparseable frame (opcode=${frame.opcode}, ${frame.payload.length}b, hex=${frame.payload.slice(0, 20).toString('hex')})\n`);
            continue;
          }

          process.stderr.write(`[vscode-server-manager] EH trigger: rx ${JSON.stringify(msg).slice(0, 300)}\n`);

          if (step === 'awaitSign' && msg.type === 'sign') {
            step = 'awaitOk';
            // Step 2b: Send ExtensionHost connection request
            // signedData = msg.signedData (server signs the challenge) 
            sendWSFrame(makeControlMsg({
              type: 'connectionType',
              commit: vsCodeCommit,
              signedData: msg.signedData || msg.data || '',
              desiredConnectionType: 2, // ConnectionType.ExtensionHost
              args: { language: 'en' },
            }));
            process.stderr.write(`[vscode-server-manager] EH trigger: sent ExtensionHost connection request\n`);
          }
          else if (step === 'awaitOk') {
            // CRITICAL TIMING ISSUE:
            //
            // The FIRST protocol message after connectionType=2 comes from
            // code-server's OWN protocol handler (typically proto:7 = Pause).
            // At this point, code-server has NOT yet forked the Extension Host.
            // The socket is still owned by code-server's Node.js process.
            //
            // If we send init data NOW, it goes into code-server's TCP buffer.
            // When code-server later passes the socket fd to the EH via IPC,
            // any data already Read() by code-server's Node.js buffer is LOST.
            // The EH never receives our init data and hangs forever.
            //
            // Strategy: Record the time of the first message. Transition to
            // 'ehStarting'. Only send init data when we receive a SECOND
            // protocol message ≥400ms later (which must be from the EH, not
            // code-server), or after a 2s fallback timer.
            if (msg.type === 'error') {
              process.stderr.write(`[vscode-server-manager] EH connection rejected: ${msg.reason || JSON.stringify(msg)}\n`);
              step = 'error';
            } else {
              const trigger = msg.type || `proto:${msg._protoType}`;
              firstMsgTime = Date.now();
              step = 'ehStarting';
              process.stderr.write(`[vscode-server-manager] Connection accepted (${trigger}) — waiting for EH process to take over socket before sending init data\n`);
            }
          }
          else if (step === 'ehStarting') {
            // Wait for a message that arrives AFTER the EH has the socket.
            const elapsed = Date.now() - firstMsgTime;
            const trigger = msg.type || `proto:${msg._protoType}`;
            if (elapsed >= 400) {
              process.stderr.write(`[vscode-server-manager] EH has socket (${trigger}, ${elapsed}ms after first msg) — sending init data\n`);
              _doSendInitData(`EH protocol message: ${trigger} after ${elapsed}ms`);
              step = 'initSent';
            } else {
              process.stderr.write(`[vscode-server-manager] EH trigger: ${trigger} at +${elapsed}ms — too early, waiting for EH\n`);
            }
          }
          else if (step === 'initSent') {
            // After init data is sent, handle protocol messages from the EH
            const trigger = msg.type || `proto:${msg._protoType}`;
            if (msg._protoType === ProtoMsgType.Regular) {
              // Regular message from EH — extension host is initializing
              process.stderr.write(`[vscode-server-manager] EH sent Regular message (${msg._dataLen}b) — bootstrap progressing\n`);
            } else if (msg._protoType === ProtoMsgType.ReplayRequest) {
              // ReplayRequest — EH wants us to replay unacked messages
              // Re-send init data if it was lost
              process.stderr.write(`[vscode-server-manager] EH sent ReplayRequest — re-sending init data\n`);
              initDataSent = false;
              _doSendInitData(`ReplayRequest from EH`);
            } else if (msg._protoType === ProtoMsgType.Ack) {
              // Ack — protocol acknowledgment, no response needed
            } else if (msg._protoType >= ProtoMsgType.Pause && msg._protoType <= ProtoMsgType.KeepAlive) {
              // Pause/Resume/KeepAlive — respond with ack
              try {
                const ackHdr = Buffer.alloc(13);
                ackHdr[0] = ProtoMsgType.Ack;
                ackHdr.writeUInt32BE(nextMsgId++, 1);
                ackHdr.writeUInt32BE(lastReceivedMsgId, 5); // ack last seen
                ackHdr.writeUInt32BE(0, 9);
                sendWSFrame(ackHdr);
              } catch (_) {}
            }
          }
        }
      });

      socket.on('error', (err) => {
        process.stderr.write(`[vscode-server-manager] EH trigger socket error: ${err.message}\n`);
      });
      socket.on('close', () => {
        process.stderr.write(`[vscode-server-manager] EH trigger socket closed (step=${step})\n`);
      });

      // Fallback: if the EH hasn't been detected by 2s after connection
      // acceptance, send init data anyway.
      const readyFallbackTimer = setTimeout(() => {
        if (step === 'ehStarting' && !initDataSent) {
          _doSendInitData(`fallback timer (step=${step})`);
          step = 'initSent';
        }
      }, 2000);
      if (readyFallbackTimer.unref) readyFallbackTimer.unref();

      // Keep the socket alive — the Extension Host reads from it.
      // Resolve the promise so startServer() continues, but DO NOT
      // close the socket.  The EH process inherits our raw socket
      // via IPC and uses it for ongoing protocol communication.
      // We keep responding to pings to maintain the WebSocket connection.
      setTimeout(() => {
        if (step !== 'done' && step !== 'error') {
          process.stderr.write(`[vscode-server-manager] EH trigger: protocol timeout (step=${step}), continuing\n`);
        }
        resolve();
      }, 12000);

      // Periodic keepalive: send WebSocket ping every 30s
      const keepaliveInterval = setInterval(() => {
        try {
          // Send WebSocket ping (opcode 0x09, masked, 0 length)
          const pingHdr = Buffer.alloc(6);
          pingHdr[0] = 0x89; // FIN + ping
          pingHdr[1] = 0x80; // masked, 0 length
          crypto.randomBytes(4).copy(pingHdr, 2);
          socket.write(pingHdr);
        } catch (_) {
          clearInterval(keepaliveInterval);
        }
      }, 30000);
      if (keepaliveInterval.unref) keepaliveInterval.unref();
      socket.on('close', () => clearInterval(keepaliveInterval));
    });

    req.on('response', (res) => {
      res.resume();
      process.stderr.write(`[vscode-server-manager] EH trigger: got HTTP ${res.statusCode} instead of upgrade\n`);
      resolve();
    });

    req.on('error', (err) => {
      process.stderr.write(`[vscode-server-manager] EH trigger WebSocket error: ${err.message}\n`);
      resolve();
    });

    req.setTimeout(10000, () => {
      req.destroy();
      process.stderr.write(`[vscode-server-manager] EH trigger WebSocket timeout\n`);
      resolve();
    });

    req.end();
  });
}

/**
 * Send Extension Host initialization data.
 *
 * After the connectionType=2 handshake, code-server passes our raw
 * WebSocket socket to the Extension Host process via IPC.  The EH wraps
 * it in PersistentProtocol, sends MessageType.Ready, then WAITS for
 * the client (us) to send IExtensionHostInitData as a Regular message.
 *
 * code-server does NOT send init data — it only relays the socket.
 * The CLIENT (browser or, in our case, this manager) MUST send init data.
 * Without it, the EH waits forever and never loads extensions.
 *
 * We scan EXTENSIONS_DIR for installed extension manifests and construct
 * a minimal but complete IExtensionHostInitData payload.
 *
 * @param {Function} sendWSFrame - Sends a buffer as a masked WebSocket frame
 * @param {Function} makeRegularMsg - Wraps data in PersistentProtocol Regular header
 * @param {number} port - Server port (for remote authority)
 * @returns {Promise<void>}
 */
async function _sendExtensionHostInitData(sendWSFrame, makeRegularMsg, port) {
  // ── Gather extension descriptions ──
  const extensions = [];
  const myExtensionIds = [];

  try {
    const dirs = fs.readdirSync(EXTENSIONS_DIR);
    for (const dir of dirs) {
      const pkgPath = path.join(EXTENSIONS_DIR, dir, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const extId = `${pkg.publisher || 'unknown'}.${pkg.name || dir}`.toLowerCase();
        const extLocation = path.join(EXTENSIONS_DIR, dir);

        const extensionDesc = {
          identifier: { value: extId },
          extensionLocation: { scheme: 'file', authority: '', path: extLocation, query: '', fragment: '' },
          isBuiltin: false,
          isUnderDevelopment: false,
          name: pkg.name || dir,
          publisher: pkg.publisher || 'unknown',
          version: pkg.version || '0.0.0',
          engines: pkg.engines || { vscode: '*' },
          main: pkg.main || undefined,
          browser: pkg.browser || undefined,
          activationEvents: pkg.activationEvents || ['*'],
          contributes: pkg.contributes || {},
          enabledApiProposals: pkg.enabledApiProposals || [],
          api: pkg.api || 'none',
          targetPlatform: 'universal',
          isApplicationScoped: false,
          uuid: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
        };

        extensions.push(extensionDesc);
        myExtensionIds.push({ value: extId });

        // Validate extension has an entry point
        if (!pkg.main && !pkg.browser) {
          process.stderr.write(`[eh-init] Extension ${extId}: no main/browser field — may be theme-only\n`);
        }

        process.stderr.write(`[eh-init] Extension: ${extId} (main: ${pkg.main || pkg.browser || 'none'})\n`);
      } catch (e) {
        // Skip dirs without valid package.json (e.g. extensions.json)
      }
    }
  } catch (e) {
    process.stderr.write(`[eh-init] Cannot read extensions dir: ${e.message}\n`);
  }

  process.stderr.write(`[eh-init] Sending init data with ${extensions.length} extensions\n`);

  // ── Read product.json for version info ──
  let vsVersion = '1.88.0';
  let vsCommit = 'unknown';
  let vsQuality = 'stable';
  try {
    const binary = findServerBinary();
    let resolvedBinary = binary;
    try { resolvedBinary = fs.realpathSync(binary); } catch (_) {}
    const codeServerRoot = path.dirname(path.dirname(resolvedBinary));
    const productCandidates = [
      path.join(codeServerRoot, 'lib', 'vscode', 'product.json'),
      path.join(codeServerRoot, 'product.json'),
      path.join(path.dirname(codeServerRoot), 'lib', 'vscode', 'product.json'),
    ];
    for (const p of productCandidates) {
      try {
        const product = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (product.version) vsVersion = product.version;
        if (product.commit) vsCommit = product.commit;
        if (product.quality) vsQuality = product.quality;
        break;
      } catch (_) {}
    }
  } catch (_) {}

  // ── Construct IExtensionHostInitData ──
  // This MUST match VS Code's IExtensionHostInitData interface exactly.
  // Missing or wrongly-typed fields cause the EH to fail during
  // deserialization and hang forever waiting for valid init data.
  const workspaceDir = currentWorkspaceDir || '/tmp/synthi-workspaces/default';
  const userDataDir = path.join(VSCODE_SERVER_DIR, 'user-data', currentSlug || 'default');
  const logsDir = path.join(userDataDir, 'logs');

  // Ensure log directories exist
  try { fs.mkdirSync(logsDir, { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(path.join(userDataDir, 'globalStorage'), { recursive: true }); } catch (_) {}
  try { fs.mkdirSync(path.join(userDataDir, 'workspaceStorage'), { recursive: true }); } catch (_) {}

  // Generate stable session/machine IDs
  const sessionId = crypto.randomBytes(16).toString('hex');
  const machineId = crypto.createHash('sha256').update(os.hostname() + VSCODE_SERVER_DIR).digest('hex');

  const initData = {
    version: vsVersion,
    quality: vsQuality,
    commit: vsCommit,
    parentPid: process.pid,
    environment: {
      isExtensionDevelopmentDebug: false,
      appRoot: { scheme: 'file', authority: '', path: '/', query: '', fragment: '' },
      appName: 'code-server',
      appHost: 'web',
      appLanguage: 'en',
      extensionTelemetryLogResource: { scheme: 'file', authority: '', path: path.join(logsDir, 'telemetry.log'), query: '', fragment: '' },
      isExtensionTelemetryLoggingOnly: true,
      appUriScheme: 'vscode',
      globalStorageHome: { scheme: 'file', authority: '', path: path.join(userDataDir, 'globalStorage'), query: '', fragment: '' },
      workspaceStorageHome: { scheme: 'file', authority: '', path: path.join(userDataDir, 'workspaceStorage'), query: '', fragment: '' },
    },
    workspace: {
      id: currentSlug || 'default',
      name: currentSlug || 'workspace',
      configuration: null,
      isUntitled: false,
      transient: false,
      // folders is REQUIRED — VS Code crashes during workspace init without it
      folders: [{
        uri: { scheme: 'file', authority: '', path: workspaceDir, query: '', fragment: '' },
        name: path.basename(workspaceDir),
        index: 0,
      }],
    },
    remote: {
      isRemote: true,
      authority: `127.0.0.1:${port}`,
      connectionData: null,
    },
    consoleForward: {
      includeStack: false,
      logNative: false,
    },
    // telemetryInfo is REQUIRED — EH crashes if missing
    telemetryInfo: {
      sessionId,
      machineId,
      sqmId: '',
      devDeviceId: '',
      firstSessionDate: new Date().toISOString(),
      commitHash: vsCommit !== 'unknown' ? vsCommit : undefined,
      msftInternal: false,
    },
    // CRITICAL: extensions must be nested under 'extensions', not at top level.
    // VS Code's ExtensionHostExtensions deserializer expects:
    //   { allExtensions: IExtensionDescription[], myExtensions: ExtensionIdentifier[] }
    extensions: {
      allExtensions: extensions,
      myExtensions: myExtensionIds,
    },
    logLevel: 1, // LogLevel.Info
    // Each logger MUST have resource, id, and name
    loggers: [{
      resource: { scheme: 'file', authority: '', path: path.join(logsDir, 'exthost.log'), query: '', fragment: '' },
      id: 'exthost',
      name: 'Extension Host',
    }],
    logsLocation: { scheme: 'file', authority: '', path: logsDir, query: '', fragment: '' },
    autoStart: true,
    uiKind: 2, // UIKind.Web
  };

  // ── Send as PersistentProtocol Regular message ──
  // Validate required fields before sending.  Missing fields cause
  // the EH to silently hang during deserialization.
  const requiredTopLevel = ['version', 'commit', 'parentPid', 'environment', 'workspace', 'extensions', 'telemetryInfo'];
  for (const key of requiredTopLevel) {
    if (initData[key] === undefined || initData[key] === null) {
      process.stderr.write(`[eh-init] WARNING: init data missing required field '${key}'\n`);
    }
  }
  if (!initData.extensions?.allExtensions || !Array.isArray(initData.extensions.allExtensions)) {
    process.stderr.write(`[eh-init] WARNING: extensions.allExtensions is missing or not an array\n`);
  }
  if (!initData.extensions?.myExtensions || !Array.isArray(initData.extensions.myExtensions)) {
    process.stderr.write(`[eh-init] WARNING: extensions.myExtensions is missing or not an array\n`);
  }
  if (!initData.workspace?.folders || !Array.isArray(initData.workspace.folders) || initData.workspace.folders.length === 0) {
    process.stderr.write(`[eh-init] WARNING: workspace.folders is empty — VS Code may crash during init\n`);
  }

  const initJson = JSON.stringify(initData);
  process.stderr.write(`[eh-init] Init data size: ${initJson.length} bytes, extensions: ${extensions.length}\n`);
  sendWSFrame(makeRegularMsg(initJson));
  process.stderr.write(`[eh-init] Init data sent\n`);
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

    // Stop the legacy Extension Host Bridge (no-op)
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
// Extension Auto-Discovery
//
// Scans EXTENSIONS_DIR for all installed extensions with UI contributions
// and registers them for preload bridge tracking.  Called when the preload
// client first connects (hello message).
// ============================================================================

/**
 * Scan all installed extensions and load any with UI contributions.
 * This ensures that when the Extension Host starts loading extensions,
 * we're already tracking which ones have views/webview views.
 *
 * @returns {Promise<void>}
 */
async function _autoLoadUIExtensions() {
  process.stderr.write(`[ext-scan] Auto-scanning extensions in ${EXTENSIONS_DIR}\n`);

  let dirs;
  try {
    dirs = fs.readdirSync(EXTENSIONS_DIR);
  } catch (e) {
    process.stderr.write(`[ext-scan] Cannot read extensions dir: ${e.message}\n`);
    return;
  }

  let uiExtCount = 0;

  for (const dir of dirs) {
    const pkgPath = path.join(EXTENSIONS_DIR, dir, 'package.json');
    let pkg;
    try {
      pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    } catch (_) {
      continue;
    }

    const extId = `${pkg.publisher || 'unknown'}.${pkg.name || dir}`;

    // Check for UI contributions (views, viewsContainers, webview views,
    // custom editors, notebooks, menus)
    const contributes = pkg.contributes || {};
    const hasViews = contributes.views && Object.keys(contributes.views).length > 0;
    const hasViewsContainers = contributes.viewsContainers && Object.keys(contributes.viewsContainers).length > 0;
    const hasCommands = contributes.commands && contributes.commands.length > 0;
    const hasCustomEditors = contributes.customEditors && contributes.customEditors.length > 0;
    const hasNotebooks = contributes.notebooks && contributes.notebooks.length > 0;
    const hasMenus = contributes.menus && Object.keys(contributes.menus).length > 0;
    const hasViewsWelcome = contributes.viewsWelcome && contributes.viewsWelcome.length > 0;

    const isUIExtension = hasViews || hasViewsContainers || hasCustomEditors || hasNotebooks;

    if (isUIExtension) {
      uiExtCount++;
      process.stderr.write(`[ext-scan] UI extension: ${extId} (views: ${hasViews}, containers: ${hasViewsContainers}, commands: ${hasCommands}, editors: ${hasCustomEditors}, notebooks: ${hasNotebooks})\n`);

      // Track it without waiting for the Extension Host to load it
      if (!extHostLoadedExtensions.has(extId)) {
        extHostLoadedExtensions.add(extId);

        // Enumerate view IDs from the manifest for targeted webview resolution
        if (contributes.views) {
          for (const container of Object.keys(contributes.views)) {
            for (const view of contributes.views[container]) {
              if (view.id) {
                process.stderr.write(`[ext-scan]   View: ${view.id} (type: ${view.type || 'tree'}, container: ${container})\n`);
                if (view.type === 'webview') {
                  // Schedule webview resolution for later when the extension activates
                  const viewType = view.id;
                  setTimeout(() => {
                    sendToPreloadClients({ action: 'resolveWebviewView', viewType });
                  }, 10000); // 10s delay — extension needs time to activate
                }
              }
            }
          }
        }
      }
    }
  }

  process.stderr.write(`[ext-scan] Scan complete: ${dirs.length} extensions, ${uiExtCount} with UI contributions\n`);
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
// Extension Installation Verification
//
// Ensures required extensions are actually installed in EXTENSIONS_DIR
// before triggering the Extension Host.  Extensions MUST be present on
// disk for the EH to load them.  If they're missing, we auto-install
// using `code-server --install-extension`.
// ============================================================================

/** Extensions that must be installed for the Synthi sidebar to work */
const REQUIRED_EXTENSIONS = [
  'GitHub.vscode-pull-request-github',
];

/**
 * Verify all required extensions are installed and install any that are missing.
 * Reads the extensions directory to check for existing installations and uses
 * the code-server binary to install missing ones.
 *
 * @param {string} binary - Path to the code-server binary
 * @returns {Promise<{installed: string[], alreadyPresent: string[], failed: string[]}>}
 */
async function _ensureRequiredExtensions(binary) {
  const result = { installed: [], alreadyPresent: [], failed: [] };

  // Ensure the extensions directory exists
  fs.mkdirSync(EXTENSIONS_DIR, { recursive: true });

  // Read currently installed extensions
  let installedDirs = [];
  try {
    installedDirs = fs.readdirSync(EXTENSIONS_DIR);
  } catch (e) {
    process.stderr.write(`[ext-install] Cannot read extensions dir: ${e.message}\n`);
  }

  process.stderr.write(`[ext-install] Extensions directory: ${EXTENSIONS_DIR}\n`);
  process.stderr.write(`[ext-install] Found ${installedDirs.length} extension dirs: [${installedDirs.slice(0, 15).join(', ')}]\n`);

  for (const extId of REQUIRED_EXTENSIONS) {
    // Check if extension is already installed (prefix match, case-insensitive)
    const extIdLower = extId.toLowerCase();
    const found = installedDirs.find(dir => dir.toLowerCase().startsWith(extIdLower));

    if (found) {
      // Verify the directory actually has a package.json with a main entry
      const pkgPath = path.join(EXTENSIONS_DIR, found, 'package.json');
      let hasMain = false;
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        hasMain = !!pkg.main || !!pkg.browser;
        if (hasMain) {
          process.stderr.write(`[ext-install] ✓ ${extId} installed (dir: ${found}, main: ${pkg.main || pkg.browser})\n`);
          result.alreadyPresent.push(extId);
          continue;
        } else {
          process.stderr.write(`[ext-install] ⚠ ${extId} dir exists but no main entry — reinstalling\n`);
        }
      } catch (e) {
        process.stderr.write(`[ext-install] ⚠ ${extId} dir exists but package.json unreadable: ${e.message} — reinstalling\n`);
      }
    } else {
      process.stderr.write(`[ext-install] ✗ ${extId} NOT found in extensions dir — installing\n`);
    }

    // Install the extension
    try {
      process.stderr.write(`[ext-install] Installing ${extId} via code-server CLI...\n`);
      const output = execFileSync(binary, [
        '--install-extension', extId,
        '--extensions-dir', EXTENSIONS_DIR,
      ], {
        timeout: 180000,   // 3 minutes for large extensions
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, VSCODE_CLI_DISABLE_GPU: '1' },
      });
      process.stderr.write(`[ext-install] ✓ ${extId} installed successfully\n`);
      const stdout = output.toString().trim();
      if (stdout) process.stderr.write(`[ext-install]   output: ${stdout.slice(0, 300)}\n`);
      result.installed.push(extId);
    } catch (installErr) {
      process.stderr.write(`[ext-install] ✗ Failed to install ${extId}: ${installErr.message}\n`);
      if (installErr.stderr) {
        process.stderr.write(`[ext-install]   stderr: ${installErr.stderr.toString().slice(0, 500)}\n`);
      }
      result.failed.push(extId);
    }
  }

  // Final check: list what's in the extensions dir now
  try {
    const finalDirs = fs.readdirSync(EXTENSIONS_DIR);
    process.stderr.write(`[ext-install] Final extensions dir: ${finalDirs.length} entries\n`);
    for (const dir of finalDirs) {
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(EXTENSIONS_DIR, dir, 'package.json'), 'utf8'));
        const hasUI = !!(pkg.contributes?.views || pkg.contributes?.viewsContainers);
        process.stderr.write(`[ext-install]   ${dir} → main: ${pkg.main || pkg.browser || '(none)'}, UI: ${hasUI}\n`);
      } catch (_) {
        process.stderr.write(`[ext-install]   ${dir} → (no readable package.json)\n`);
      }
    }
  } catch (_) {}

  return result;
}

// ============================================================================
// Extension Host Bridge (Preload-Based)
//
// Instead of the deleted remote-ext-host.js (which used a shimmed vscode API),
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

  // Wait for at least one preload client to connect before sending commands.
  // The Extension Host may still be starting — without this gate the commands
  // go nowhere because sendToPreloadClients iterates an empty set.
  const ready = await waitForPreloadClient(15000);
  if (ready) {
    process.stderr.write(`[preload-bridge] Preload client ready — requesting data for ${extensionId}\n`);
  } else {
    process.stderr.write(`[preload-bridge] Preload client not connected after 15s — sending anyway\n`);
  }

  // Ask preload clients to refresh — the extension may already be loaded
  // in the Extension Host and have registered providers
  sendToPreloadClients({ action: 'refreshAllTrees' });
  sendToPreloadClients({ action: 'listProviders' });

  // Also schedule retries — extensions may not have activated yet when
  // the first request fires (they need to require('vscode'), register
  // providers, etc.)  Retry at 5s and 15s after loadExtensionForUI.
  const retryDelays = [5000, 15000];
  for (const delay of retryDelays) {
    const timer = setTimeout(() => {
      process.stderr.write(`[preload-bridge] Retry provider refresh for ${extensionId} (${delay / 1000}s)\n`);
      sendToPreloadClients({ action: 'refreshAllTrees' });
      sendToPreloadClients({ action: 'listProviders' });
      // Also try resolving webview views on demand
      sendToPreloadClients({ action: 'resolveWebviewView', viewType: `${extensionId}:*` });
    }, delay);
    if (timer.unref) timer.unref();
  }

  return { success: true, hasUI: true };
}

/**
 * No-op for backward compatibility. The preload approach doesn't need a
 * separate extension host process.
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
            // Ping → respond with pong (must echo payload, must mask per RFC 6455)
            const pong = encodeWsFrame(0x0A, result.payload, true);
            socket.write(pong);
          } else if (result.opcode === 0x0A) {
            // Pong — silently consume (response to our ping, if any)
          }
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

      case 'refreshTreeData': {
        // Request the preload bridge to re-resolve tree data for a specific view
        const [viewId] = args;
        if (viewId) {
          sendToPreloadClients({ action: 'refreshTreeData', viewId });
        } else {
          sendToPreloadClients({ action: 'refreshAllTrees' });
        }
        sendResponse(id, { success: true });
        break;
      }

      case 'getCachedTreeData': {
        // Return cached tree data from preload bridge (no round-trip needed)
        const [viewId] = args;
        if (viewId) {
          const data = preloadTreeCache.get(viewId) || null;
          sendResponse(id, { viewId, data });
        } else {
          // Return all cached trees
          const all = {};
          for (const [k, v] of preloadTreeCache) {
            all[k] = v;
          }
          sendResponse(id, all);
        }
        break;
      }

      case 'executeExtensionCommand': {
        // Execute a command registered by an extension via the preload bridge
        const [commandId, ...commandArgs] = args;
        if (!commandId) {
          sendResponse(id, null, new Error('commandId is required'));
          break;
        }
        sendToPreloadClients({
          action: 'executeCommand',
          commandId,
          args: commandArgs,
        });
        // Commands are fire-and-forget through the preload bridge
        sendResponse(id, { success: true, commandId });
        break;
      }

      case 'listPreloadProviders': {
        // Request the preload bridge to enumerate all registered providers
        sendToPreloadClients({ action: 'listProviders' });
        sendResponse(id, { success: true });
        break;
      }

      case 'resolveWebviewView': {
        // Ask the preload bridge to resolve a specific webview view on demand.
        // Code-server runs headless, so resolveWebviewView is never called
        // naturally — we trigger it ourselves so the extension generates HTML.
        const [viewType] = args;
        if (!viewType) {
          sendResponse(id, null, new Error('viewType is required'));
          break;
        }
        log(`Requesting preload to resolve webview view: ${viewType}`);
        sendToPreloadClients({ action: 'resolveWebviewView', viewType });
        sendResponse(id, { success: true, viewType });
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
