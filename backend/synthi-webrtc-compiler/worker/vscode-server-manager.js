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

function _extractRpcArgsFromBuffer(dataBuf) {
  try {
    if (!dataBuf || dataBuf.length < 7) return null;
    const methodLen = dataBuf[6];
    const argsOffset = 7 + methodLen;
    if (dataBuf.length < argsOffset + 4) return null;
    const argsLen = dataBuf.readUInt32BE(argsOffset);
    if (argsLen <= 0 || dataBuf.length < argsOffset + 4 + argsLen) return null;
    const argsJson = dataBuf.slice(argsOffset + 4, argsOffset + 4 + argsLen).toString('utf8');
    const parsed = JSON.parse(argsJson);
    return Array.isArray(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function _collectStringCandidates(value, out) {
  if (!value) return;
  if (typeof value === 'string') {
    if (value.length >= 3 && value.length <= 200) out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) _collectStringCandidates(item, out);
    return;
  }
  if (typeof value === 'object') {
    for (const key of Object.keys(value)) {
      _collectStringCandidates(value[key], out);
    }
  }
}

function _pickViewIdFromCandidates(candidates) {
  for (const value of candidates) {
    if (!value) continue;
    if (value.startsWith('$') || value.startsWith('__vsc')) continue;
    if (value.includes('://')) continue;
    if (/^[a-z0-9_.-]+:[a-z0-9_.:-]+$/i.test(value)) return value;
    if (/^[a-z0-9_.-]+$/i.test(value) && (value.includes('.') || value.includes('-'))) return value;
  }
  return null;
}

function _captureProviderFromRpc(methodName, args) {
  if (!methodName) return;
  const lower = methodName.toLowerCase();
  const isRegisterLike = lower.includes('register') || lower.includes('create');
  const isTreeRegistration = isRegisterLike && (lower.includes('tree') || lower.includes('viewcontainer'));
  const isWebviewRegistration = isRegisterLike && lower.includes('webview');

  const candidates = [];
  _collectStringCandidates(args, candidates);
  const knownTreeMatch = candidates.find((value) => manifestKnownTreeViews.has(value));
  const knownWebviewMatch = candidates.find((value) => manifestKnownWebviewViews.has(value));

  // Prefer explicit manifest-known IDs when present in args;
  // otherwise fall back to generic candidate extraction.
  const inferredTreeId = knownTreeMatch || (isTreeRegistration ? _pickViewIdFromCandidates(candidates) : null);
  const inferredWebviewId = knownWebviewMatch || (isWebviewRegistration ? _pickViewIdFromCandidates(candidates) : null);

  if (!inferredTreeId && !inferredWebviewId && !isTreeRegistration && !isWebviewRegistration) {
    return;
  }

  if (inferredTreeId) {
    if (!rpcObservedTreeViews.has(inferredTreeId)) {
      rpcObservedTreeViews.add(inferredTreeId);
      process.stderr.write(`[rpc-fallback] Tree provider observed via EH RPC: ${inferredTreeId} (${methodName})\n`);
      sendEvent('registerTreeView', inferredTreeId, 'rpc-fallback');
      sendEvent('providerList', Array.from(rpcObservedTreeViews), Array.from(rpcObservedWebviewViews));
    }
  }

  if (inferredWebviewId) {
    if (!rpcObservedWebviewViews.has(inferredWebviewId)) {
      rpcObservedWebviewViews.add(inferredWebviewId);
      process.stderr.write(`[rpc-fallback] Webview provider observed via EH RPC: ${inferredWebviewId} (${methodName})\n`);
      sendEvent('createWebview', inferredWebviewId, inferredWebviewId, inferredWebviewId, { extensionId: 'rpc-fallback' });
      sendEvent('providerList', Array.from(rpcObservedTreeViews), Array.from(rpcObservedWebviewViews));
    }
  }
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

/** @type {boolean} Ensures auto UI extension scan runs once per manager lifecycle */
let _autoUiScanStarted = false;

/** @type {Map<string, object>} viewId → last known tree data */
const preloadTreeCache = new Map();

/** @type {Set<string>} Tree views observed directly from EH RPC registrations */
const rpcObservedTreeViews = new Set();

/** @type {Set<string>} Webview view types observed directly from EH RPC registrations */
const rpcObservedWebviewViews = new Set();

/** @type {Set<string>} Tree view IDs confirmed by ext-host-preload registration */
const preloadRegisteredTreeViews = new Set();

/** @type {Set<string>} Webview view IDs confirmed by ext-host-preload registration */
const preloadRegisteredWebviewViews = new Set();

/** @type {Set<string>} Tree view IDs discovered statically from extension manifests */
const manifestKnownTreeViews = new Set();

/** @type {Set<string>} Webview view IDs discovered statically from extension manifests */
const manifestKnownWebviewViews = new Set();

/** @type {string} Dedup key to avoid repeatedly emitting identical fallback provider lists */
let _lastFallbackProviderEmitKey = '';

/** @type {Set<string>} One-time skip logs for unresolved tree refresh attempts */
const _skippedTreeRefreshLogged = new Set();

/** @type {Set<string>} One-time skip logs for unresolved webview resolve attempts */
const _skippedWebviewResolveLogged = new Set();

/** @type {boolean} Whether the bootstrapState message has been received from preload */
let _bootstrapStateReceived = false;

/** @type {string[]} Webview view types queued for resolution before bootstrap */
const _deferredWebviewResolutions = [];

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
      if (preloadRegisteredTreeViews.size > 0) {
        sendToPreloadClients({ action: 'refreshAllTrees' });
      }
      // Try resolving known webview views
      for (const extId of extHostLoadedExtensions) {
        const result = _readExtensionManifest(extId);
        if (result?.manifest?.contributes?.views) {
          const views = result.manifest.contributes.views;
          for (const container of Object.keys(views)) {
            for (const view of views[container]) {
              if (view.type === 'webview') {
                if (preloadRegisteredWebviewViews.has(view.id)) {
                  sendToPreloadClients({ action: 'resolveWebviewView', viewType: view.id });
                }
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
 * Mark bootstrap as ready via a fallback signal (not preload interception).
 * Used when EH reports Initialized but ext-host-preload never emits
 * bootstrapState due VS Code internal API path changes.
 *
 * @param {string} reason
 */
function _markBootstrapReadyFallback(reason) {
  if (_bootstrapStateReceived) return;
  _bootstrapStateReceived = true;
  process.stderr.write(`[preload-bridge] Synthetic bootstrap ready via ${reason}\n`);
  sendEvent('bootstrapState', true, `fallback:${reason}`);
  _startProviderDiscovery(`fallback:${reason}`);

  if (_deferredWebviewResolutions.length > 0) {
    process.stderr.write(`[preload-bridge] Flushing ${_deferredWebviewResolutions.length} deferred webview resolutions (fallback)\n`);
    const deferred = [..._deferredWebviewResolutions];
    _deferredWebviewResolutions.length = 0;
    for (const viewType of deferred) {
      const delays = [1500, 4000, 9000];
      for (const d of delays) {
        const t = setTimeout(() => {
          if (preloadRegisteredWebviewViews.has(viewType)) {
            sendToPreloadClients({ action: 'resolveWebviewView', viewType });
          }
        }, d);
        if (t.unref) t.unref();
      }
    }
  }
}

/**
 * Emit a merged provider list using manifest + RPC observations.
 * This keeps the browser bridge functional even if preload bootstrap
 * interception fails and no providerList arrives from ext-host-preload.
 *
 * @param {string} reason
 */
function _emitMergedFallbackProviders(reason) {
  const mergedTreeViews = Array.from(new Set([
    ...manifestKnownTreeViews,
    ...rpcObservedTreeViews,
  ]));
  const mergedWebviews = Array.from(new Set([
    ...manifestKnownWebviewViews,
    ...rpcObservedWebviewViews,
  ]));

  const emitKey = `${mergedTreeViews.slice().sort().join(',')}|${mergedWebviews.slice().sort().join(',')}`;
  if (emitKey === _lastFallbackProviderEmitKey) return;
  _lastFallbackProviderEmitKey = emitKey;

  process.stderr.write(`[fallback-providers] Emitting merged providers (${reason}): ${mergedTreeViews.length} trees, ${mergedWebviews.length} webviews\n`);

  // Emit tree registrations so UI can render containers immediately.
  for (const viewId of mergedTreeViews) {
    sendEvent('registerTreeView', viewId, 'manifest-rpc-fallback');
  }

  // Emit placeholder webviews so sidebar entries aren't empty while
  // waiting for real provider HTML.
  for (const viewType of mergedWebviews) {
    sendEvent('createWebview', viewType, viewType, viewType, { extensionId: 'manifest-rpc-fallback' });
  }

  sendEvent('providerList', mergedTreeViews, mergedWebviews);
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
      preloadRegisteredTreeViews.add(msg.viewId);
      _skippedTreeRefreshLogged.delete(msg.viewId);
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
      preloadRegisteredWebviewViews.add(msg.viewType);
      _skippedWebviewResolveLogged.delete(msg.viewType);
      sendEvent('createWebview', msg.viewType, msg.viewType, msg.viewType, { extensionId: msg.extensionId });
      // Auto-resolve: code-server is headless so the sidebar never opens,
      // meaning resolveWebviewView is never called naturally.  We trigger
      // it ourselves so the extension generates its HTML content.
      setTimeout(() => {
        process.stderr.write(`[preload-bridge] Auto-resolving webview view: ${msg.viewType}\n`);
        if (preloadRegisteredWebviewViews.has(msg.viewType)) {
          sendToPreloadClients({ action: 'resolveWebviewView', viewType: msg.viewType });
        }
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
      if (!_autoUiScanStarted) {
        _autoUiScanStarted = true;
        _autoLoadUIExtensions().catch(err => {
          process.stderr.write(`[preload-bridge] Auto-load UI extensions failed: ${err.message}\n`);
        });
      } else {
        process.stderr.write(`[preload-bridge] Auto-scan already completed for this session — skipping duplicate run\n`);
      }

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
      // a timeout.  With the api:'vscode' init data fix, bootstrap should
      // complete within 5-10s; 20s gives ample margin.
      process.stderr.write(`[preload-bridge] Waiting for bootstrapState before requesting providers\n`);
      const _bootstrapFallbackTimer = setTimeout(() => {
        if (!_bootstrapStateReceived) {
          process.stderr.write(`[preload-bridge] WARNING: bootstrapState not received after 20s — requesting providers as fallback\n`);
          process.stderr.write(`[preload-bridge] Possible causes: vscode API interception path not reached, extension activation stalled, or init metadata mismatch\n`);
          _startProviderDiscovery('fallback-timeout');
        }
      }, 20000);
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

        // Flush deferred webview resolution requests now that extensions are activating.
        // Add a small delay to give providers time to register after activation.
        if (_deferredWebviewResolutions.length > 0) {
          process.stderr.write(`[preload-bridge] Flushing ${_deferredWebviewResolutions.length} deferred webview resolutions\n`);
          const deferred = [..._deferredWebviewResolutions];
          _deferredWebviewResolutions.length = 0;
          for (const viewType of deferred) {
            // Stagger resolution: 3s after bootstrap for first, then 5s, 10s retries
            const delays = [3000, 5000, 10000];
            for (const d of delays) {
              const t = setTimeout(() => {
                if (preloadRegisteredWebviewViews.has(viewType)) {
                  sendToPreloadClients({ action: 'resolveWebviewView', viewType });
                }
              }, d);
              if (t.unref) t.unref();
            }
          }
        }
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
      const mergedTreeViews = Array.from(new Set([...(msg.treeViews || []), ...rpcObservedTreeViews]));
      const mergedWebviews = Array.from(new Set([...(msg.webviews || []), ...rpcObservedWebviewViews]));
      for (const viewId of (msg.treeViews || [])) preloadRegisteredTreeViews.add(viewId);
      for (const viewType of (msg.webviews || [])) preloadRegisteredWebviewViews.add(viewType);
      const treeCount = mergedTreeViews.length;
      const webviewCount = mergedWebviews.length;
      process.stderr.write(`[preload-bridge] Provider list: ${treeCount} trees, ${webviewCount} webviews\n`);
      sendEvent('providerList', mergedTreeViews, mergedWebviews);
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

      // Also patch bootstrap-fork.js for early ODP trap + early preload load
      _patchBootstrapFork(rootCandidates, bridgePort, preloadPath);

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
 * @param {string} preloadPath - Absolute path to ext-host-preload.js
 */
function _patchBootstrapFork(rootCandidates, bridgePort, preloadPath) {
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
  const escapedPreloadPath = String(preloadPath || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const bootstrapInjection = [
    BOOTSTRAP_BEGIN,
    `// Early Object.defineProperty trap — installed before ANY ESM imports.`,
    `// Uses process.argv guard (not env var — env var set after this runs).`,
    `(function() {`,
    `  if (!process.argv.includes('--type=extensionHost')) return;`,
    `  process.env.SYNTHI_EXT_BRIDGE_PORT = process.env.SYNTHI_EXT_BRIDGE_PORT || "${bridgePort}";`,
    `  process.env.SYNTHI_EXTENSION_HOST_CONFIRMED = process.env.SYNTHI_EXTENSION_HOST_CONFIRMED || "true";`,
    `  const __synthiPreloadPath = "${escapedPreloadPath}";`,
    `  if (__synthiPreloadPath) {`,
    `    try {`,
    `      const __synthiCR = (typeof require === 'function')`,
    `        ? require`,
    `        : import('node:module').then((m) => m.createRequire(process.cwd() + '/__synthi_bootstrap_require__.js'));`,
    `      if (typeof __synthiCR === 'function') {`,
    `        __synthiCR(__synthiPreloadPath);`,
    `      } else if (__synthiCR && typeof __synthiCR.then === 'function') {`,
    `        __synthiCR.then((__rq) => { try { __rq(__synthiPreloadPath); } catch (_e2) { process.stderr.write('[ext-host-preload:bootstrap] Early preload async require failed: ' + _e2.message + '\\n'); } });`,
    `      } else {`,
    `        process.stderr.write('[ext-host-preload:bootstrap] Early preload loader unavailable\\n');`,
    `      }`,
    `    }`,
    `    catch (_e) { process.stderr.write('[ext-host-preload:bootstrap] Early preload require failed: ' + _e.message + '\\n'); }`,
    `  }`,
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

    // ── Delayed startup summary ──
    // After 15s, log a comprehensive one-shot summary of the entire
    // pipeline state.  This is invaluable for diagnosing why extensions
    // don't load — you can see at a glance which stages completed.
    const _startupSummaryTimer = setTimeout(() => {
      const bootstrapStatus = _bootstrapStateReceived
        ? 'received=true \u2713'
        : 'received=false \u2717 (extensions may not have loaded)';
      const bridgeStatus = preloadClients.size > 0
        ? `port=${preloadBridgePort || 'N/A'} clients=${preloadClients.size} \u2713`
        : `port=${preloadBridgePort || 'N/A'} clients=0 \u2717 (preload may not have connected)`;
      const deferredCount = _deferredWebviewResolutions.length;
      const lines = [
        `\n${'='.repeat(60)}`,
        `  SYNTHI Extension Host Startup Summary (${new Date().toISOString()})`,
        `${'='.repeat(60)}`,
        `  Server:     port=${port} state=${serverState} pid=${serverProcess?.pid || 'N/A'}`,
        `  Bridge:     ${bridgeStatus}`,
        `  Bootstrap:  ${bootstrapStatus}`,
        `  Extensions: scanned=${extHostLoadedExtensions.size} installed=${installedExtensions.size}`,
        `  Manifest:   trees=${manifestKnownTreeViews.size} webviews=${manifestKnownWebviewViews.size}`,
        `  RPC Fallback: trees=${rpcObservedTreeViews.size} webviews=${rpcObservedWebviewViews.size}`,
        `  Deferred:   ${deferredCount} webview resolutions pending`,
        `  Workspace:  ${currentWorkspaceDir || '(none)'} slug=${currentSlug || '(none)'}`,
        `${'='.repeat(60)}\n`,
      ];
      process.stderr.write(lines.join('\n'));
    }, 15000);
    if (_startupSummaryTimer.unref) _startupSummaryTimer.unref();

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
      //
      // IMPORTANT: PersistentProtocol's ProtocolWriter batches multiple
      // messages into a single write (via setTimeout(0)), which means a
      // single WebSocket frame can contain MULTIPLE protocol messages
      // (e.g. Resume + Ready back-to-back).  This function parses ONE
      // message and returns how many bytes were consumed via _consumed.
      function parseOneProtocolMsg(payload) {
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

        const consumed = 13 + dataLen;
        const data = payload.slice(13, consumed);
        if (msgType === ProtoMsgType.Control) {
          // Control — always JSON
          try {
            const parsed = JSON.parse(data.toString('utf8'));
            parsed._consumed = consumed;
            return parsed;
          } catch (_) { return null; }
        }
        // Non-control: preserve raw data buffer for Ready/Initialized detection.
        // Also try JSON parse for diagnostic logging.
        let jsonParsed = null;
        if (dataLen > 1) {
          try {
            jsonParsed = JSON.parse(data.toString('utf8'));
          } catch (_) {}
        }
        if (jsonParsed && typeof jsonParsed === 'object') {
          jsonParsed._consumed = consumed;
          return jsonParsed;
        }
        // Return a synthetic object with raw data bytes
        return {
          _protoType: msgType,
          _dataLen: dataLen,
          _raw: data.toString('utf8').slice(0, 100),
          _rawBuf: data,
          _consumed: consumed,
        };
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

      // ── RPC Response Handler ─────────────────────────────────────
      // VS Code's Extension Host sends RPC requests (type 1-4) over
      // the protocol socket and expects responses.  Without responses,
      // RPCProtocol marks the connection as unresponsive after 3s, and
      // pending Promises never resolve — blocking extension activation.
      //
      // VS Code RPCProtocol message types (rpcProtocol.ts):
      //   RequestJSONArgs=1, RequestJSONArgsWithCancellation=2,
      //   RequestMixedArgs=3, RequestMixedArgsWithCancellation=4,
      //   Acknowledged=5, Cancel=6,
      //   ReplyOKEmpty=7, ReplyOKVSBuffer=8, ReplyOKJSON=9,
      //   ReplyOKJSONWithBuffers=10, ReplyErrError=11, ReplyErrEmpty=12
      //
      // Message format:
      //   byte 0: MessageType (UInt8)
      //   bytes 1-4: reqId (UInt32BE)
      //   byte 5: rpcId (UInt8)
      //   byte 6: method name length (UInt8)
      //   bytes 7+: method name, then args
      //
      // Response: Acknowledged(5) + ReplyOKEmpty(7) for most methods.
      // For data-returning methods ($getInitialState, $getTools, etc.)
      // we send ReplyOKJSON(9) with appropriate default data.
      function _handleEHRpc(dataBuf) {
        if (!dataBuf || dataBuf.length < 5) return;

        const rpcMsgType = dataBuf[0];
        // Only handle request types (1-4)
        if (rpcMsgType < 1 || rpcMsgType > 4) return;

        const reqId = dataBuf.readUInt32BE(1);

        // Parse method name for diagnostics and routing
        let methodName = '';
        if (dataBuf.length >= 7) {
          const methodLen = dataBuf[6];
          if (dataBuf.length >= 7 + methodLen) {
            methodName = dataBuf.slice(7, 7 + methodLen).toString('utf8');
          }
        }

        const rpcArgs = _extractRpcArgsFromBuffer(dataBuf);
        _captureProviderFromRpc(methodName, rpcArgs);

        // Decode $logExtensionHostMessage for diagnostics
        if (methodName === '$logExtensionHostMessage') {
          try {
            const argsOffset = 7 + dataBuf[6]; // skip past method name
            const argsLen = dataBuf.readUInt32BE(argsOffset);
            const argsJson = dataBuf.slice(argsOffset + 4, argsOffset + 4 + argsLen).toString('utf8');
            const args = JSON.parse(argsJson);
            if (args && args[0]) {
              const entry = args[0];
              const sev = entry.severity || 'log';
              const text = entry.arguments || '';
              process.stderr.write(`[vscode-server-manager] EH ${sev}: ${text}\n`);
            }
          } catch (_) {}
        }

        // 1. Send Acknowledged (type=5)
        const ackRpc = Buffer.alloc(5);
        ackRpc[0] = 5; // Acknowledged
        ackRpc.writeUInt32BE(reqId, 1);

        const ackHdr = Buffer.alloc(13);
        ackHdr[0] = ProtoMsgType.Regular;
        ackHdr.writeUInt32BE(nextMsgId++, 1);
        ackHdr.writeUInt32BE(lastReceivedMsgId, 5);
        ackHdr.writeUInt32BE(ackRpc.length, 9);
        try { sendWSFrame(Buffer.concat([ackHdr, ackRpc])); } catch (_) {}

        // 2. Send reply
        let replyRpc;
        if (methodName === '$getInitialState') {
          // Return window initial state — VS Code destructures { isFocused }
          // from the result, so null crashes with TypeError.
          const json = Buffer.from('{"isFocused":false}', 'utf8');
          replyRpc = Buffer.alloc(5 + 4 + json.length);
          replyRpc[0] = 9; // ReplyOKJSON
          replyRpc.writeUInt32BE(reqId, 1);
          replyRpc.writeUInt32BE(json.length, 5);
          json.copy(replyRpc, 9);
        } else if (methodName === '$getTools') {
          // Return empty tools array
          const json = Buffer.from('[]', 'utf8');
          replyRpc = Buffer.alloc(5 + 4 + json.length);
          replyRpc[0] = 9; // ReplyOKJSON
          replyRpc.writeUInt32BE(reqId, 1);
          replyRpc.writeUInt32BE(json.length, 5);
          json.copy(replyRpc, 9);
        } else if (methodName === '$stat') {
          // File stat — reply with error (file not found is acceptable)
          replyRpc = Buffer.alloc(5);
          replyRpc[0] = 12; // ReplyErrEmpty
          replyRpc.writeUInt32BE(reqId, 1);
        } else {
          // Default: ReplyOKEmpty (void response)
          replyRpc = Buffer.alloc(5);
          replyRpc[0] = 7; // ReplyOKEmpty
          replyRpc.writeUInt32BE(reqId, 1);
        }

        const replyHdr = Buffer.alloc(13);
        replyHdr[0] = ProtoMsgType.Regular;
        replyHdr.writeUInt32BE(nextMsgId++, 1);
        replyHdr.writeUInt32BE(lastReceivedMsgId, 5);
        replyHdr.writeUInt32BE(replyRpc.length, 9);
        try { sendWSFrame(Buffer.concat([replyHdr, replyRpc])); } catch (_) {}
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
          // messages, otherwise they hit parseOneProtocolMsg, fail to parse,
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

          // Parse ALL protocol messages from this frame's payload.
          // PersistentProtocol's ProtocolWriter batches multiple messages
          // into a single write (via setTimeout(0)), so a single WebSocket
          // frame can contain e.g. [Resume(13b) + Ready(14b)] = 27 bytes.
          // We must parse and handle ALL of them, not just the first.
          let framePayload = frame.payload;
          while (framePayload.length >= 13) {
            const msg = parseOneProtocolMsg(framePayload);
            if (!msg) {
              if (framePayload.length >= 13) {
                process.stderr.write(`[vscode-server-manager] EH trigger: rx unparseable data in frame (${framePayload.length}b remaining, hex=${framePayload.slice(0, 20).toString('hex')})\n`);
              }
              break;
            }
            const consumed = msg._consumed || 13;
            framePayload = framePayload.slice(consumed);

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
            // The FIRST protocol message after connectionType=2 comes from
            // code-server's OWN protocol handler (typically proto:7 = Pause).
            // code-server then passes the raw socket to the EH process.
            // The EH creates a FRESH PersistentProtocol on this socket.
            if (msg.type === 'error') {
              process.stderr.write(`[vscode-server-manager] EH connection rejected: ${msg.reason || JSON.stringify(msg)}\n`);
              step = 'error';
            } else {
              const trigger = msg.type || `proto:${msg._protoType}`;
              firstMsgTime = Date.now();
              step = 'ehStarting';

              // CRITICAL: Reset protocol IDs for the new EH endpoint.
              // code-server consumed our auth messages (IDs 1,2). The EH
              // creates a fresh PersistentProtocol that expects incoming
              // message IDs starting from 1. If we continue with ID 3+,
              // PersistentProtocol detects a gap and buffers our messages
              // without delivering them (causing ReplayRequest loops).
              process.stderr.write(`[vscode-server-manager] Connection accepted (${trigger}) — resetting protocol IDs for EH endpoint\n`);
              nextMsgId = 1;
              lastReceivedMsgId = 0;
            }
          }
          else if (step === 'ehStarting') {
            // Wait for the EH's Ready signal.
            //
            // VS Code's Extension Host protocol (extensionHostProtocol.ts)
            // uses 1-byte payloads inside Regular (type 1) messages:
            //   0x02 = MessageType.Ready    ("I'm ready for init data")
            //   0x01 = MessageType.Initialized ("init data processed")
            //
            // The EH sends Resume (proto:8) + Ready (proto:1, data=0x02)
            // in quick succession. PersistentProtocol batches them into
            // a single WebSocket frame. We must detect the Ready byte.
            //
            // Resume (proto:8) is flow control — NOT a Ready signal.
            const trigger = msg.type || `proto:${msg._protoType}`;
            if (msg._protoType === ProtoMsgType.Regular && msg._dataLen === 1 && msg._rawBuf) {
              const readyByte = msg._rawBuf[0];
              if (readyByte === 0x02) {
                process.stderr.write(`[vscode-server-manager] EH sent Ready signal (0x02) — sending init data\n`);
                _doSendInitData('EH Ready signal');
                step = 'initSent';
              } else {
                process.stderr.write(`[vscode-server-manager] EH sent Regular 1-byte (0x${readyByte.toString(16)}) — not Ready, ignoring\n`);
              }
            } else if (msg._protoType === ProtoMsgType.Resume) {
              process.stderr.write(`[vscode-server-manager] EH sent Resume (flow control) — waiting for Ready signal\n`);
            } else {
              process.stderr.write(`[vscode-server-manager] EH trigger: ${trigger} while waiting for Ready\n`);
            }
          }
          else if (step === 'initSent') {
            // After init data is sent, handle protocol messages from the EH
            const trigger = msg.type || `proto:${msg._protoType}`;
            if (msg._protoType === ProtoMsgType.Regular && msg._dataLen === 1 && msg._rawBuf) {
              const statusByte = msg._rawBuf[0];
              if (statusByte === 0x01) {
                // MessageType.Initialized — the EH parsed our init data
                // and is loading extensions!
                process.stderr.write(`[vscode-server-manager] EH sent Initialized (0x01) — extensions are loading! ✓\n`);
                // If preload bootstrap interception never fires, treat
                // EH Initialized as a fallback readiness signal.
                _markBootstrapReadyFallback('eh-initialized');
                step = 'running';
              } else if (statusByte === 0x02) {
                // Late Ready — EH may be re-requesting init data
                process.stderr.write(`[vscode-server-manager] EH sent Ready (0x02) after init — re-sending init data\n`);
                initDataSent = false;
                _doSendInitData('Late Ready signal');
              }
            } else if (msg._protoType === ProtoMsgType.Regular && msg._rawBuf) {
              // Regular RPC message from EH — respond to keep RPCProtocol alive
              _handleEHRpc(msg._rawBuf);
            } else if (msg._protoType === ProtoMsgType.ReplayRequest) {
              // ReplayRequest — EH wants us to replay unacked messages.
              // With corrected message IDs this should be rare, but handle
              // it anyway by re-sending init data with current nextMsgId.
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
          else if (step === 'running') {
            // EH is running — handle ongoing protocol messages
            if (msg._protoType === ProtoMsgType.Regular && msg._rawBuf) {
              // Regular RPC message from EH — must respond to prevent
              // RPCProtocol unresponsive timeout (3s) and unblock
              // extension activation pipeline.
              _handleEHRpc(msg._rawBuf);
            } else if (msg._protoType === ProtoMsgType.ReplayRequest) {
              // ReplayRequest while running: the EH wants us to replay
              // unacked messages. We don't buffer sent messages, so we
              // can't replay. But we MUST NOT re-send init data — that
              // would be parsed as a garbled RPC message by RPCProtocol,
              // causing more errors and triggering another ReplayRequest
              // (infinite loop).  Instead, send an Ack to acknowledge
              // the EH's messages and tell PersistentProtocol we're alive.
              process.stderr.write(`[vscode-server-manager] EH sent ReplayRequest while running — sending Ack (NOT re-sending init data)\n`);
              try {
                const ackHdr = Buffer.alloc(13);
                ackHdr[0] = ProtoMsgType.Ack;
                ackHdr.writeUInt32BE(nextMsgId++, 1);
                ackHdr.writeUInt32BE(lastReceivedMsgId, 5);
                ackHdr.writeUInt32BE(0, 9);
                sendWSFrame(ackHdr);
              } catch (_) {}
            } else if (msg._protoType >= ProtoMsgType.Pause && msg._protoType <= ProtoMsgType.KeepAlive) {
              try {
                const ackHdr = Buffer.alloc(13);
                ackHdr[0] = ProtoMsgType.Ack;
                ackHdr.writeUInt32BE(nextMsgId++, 1);
                ackHdr.writeUInt32BE(lastReceivedMsgId, 5);
                ackHdr.writeUInt32BE(0, 9);
                sendWSFrame(ackHdr);
              } catch (_) {}
            }
          }
          } // end inner while (multi-message parsing)
        }
      });

      socket.on('error', (err) => {
        process.stderr.write(`[vscode-server-manager] EH trigger socket error: ${err.message}\n`);
      });
      socket.on('close', () => {
        process.stderr.write(`[vscode-server-manager] EH trigger socket closed (step=${step})\n`);
      });

      // Fallback: if we never receive the Ready signal within 5s
      // (e.g. the 1-byte 0x02 message was somehow lost), send init
      // data anyway to avoid hanging forever.
      const readyFallbackTimer = setTimeout(() => {
        if (step === 'ehStarting' && !initDataSent) {
          process.stderr.write(`[vscode-server-manager] Ready signal not received after 5s — sending init data via fallback\n`);
          _doSendInitData(`fallback timer (no Ready signal after 5s)`);
          step = 'initSent';
        }
      }, 5000);
      if (readyFallbackTimer.unref) readyFallbackTimer.unref();

      // Keep the socket alive — the Extension Host reads from it.
      // Resolve the promise so startServer() continues, but DO NOT
      // close the socket.  The EH process inherits our raw socket
      // via IPC and uses it for ongoing protocol communication.
      // We keep responding to pings to maintain the WebSocket connection.
      setTimeout(() => {
        if (step !== 'done' && step !== 'error' && step !== 'running') {
          process.stderr.write(`[vscode-server-manager] EH trigger: protocol timeout 20s (step=${step}), continuing\n`);

          // If init data was sent but bootstrapState was never received,
          // log the situation but do NOT re-send init data.
          // The EH may already be in 'running' state processing RPC,
          // and re-sending init data would corrupt the RPC stream.
          if (initDataSent && !_bootstrapStateReceived) {
            process.stderr.write(`[vscode-server-manager] 20s: bootstrapState not received (step=${step}) — NOT re-sending init data\n`);
          }
        }
        resolve();
      }, 20000);

      // Secondary recovery: if after 60s bootstrapState still hasn't
      // been received, log a diagnostic but do NOT re-send init data.
      // Re-sending init data while the EH is in 'running' state causes
      // RPCProtocol to misparse the init JSON as an RPC message, which
      // triggers errors and ReplayRequest loops.
      const _lateRecoveryTimer = setTimeout(() => {
        if (!_bootstrapStateReceived && !socket.destroyed) {
          process.stderr.write(`[vscode-server-manager] 60s: bootstrapState still not received — extensions may not have activated\n`);
          process.stderr.write(`[vscode-server-manager] 60s: NOT re-sending init data (would corrupt running RPCProtocol)\n`);
          // Send an Ack to keep PersistentProtocol alive
          try {
            const ackHdr = Buffer.alloc(13);
            ackHdr[0] = ProtoMsgType.Ack;
            ackHdr.writeUInt32BE(nextMsgId++, 1);
            ackHdr.writeUInt32BE(lastReceivedMsgId, 5);
            ackHdr.writeUInt32BE(0, 9);
            sendWSFrame(ackHdr);
          } catch (_) {}
        }
      }, 60000);
      if (_lateRecoveryTimer.unref) _lateRecoveryTimer.unref();
      socket.on('close', () => clearTimeout(_lateRecoveryTimer));

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
  //
  // The Extension Host receives its extension list ONLY from the client's
  // init data (IExtensionHostInitData.extensions.allExtensions).
  // code-server does NOT push extensions independently — it just relays
  // the socket.  We MUST include installed extensions here.
  //
  // NOTE: code-server 4.108.2 may log "Extension 'xxx' is already registered"
  // if the Extension Host Agent also scans --extensions-dir.  This is a
  // non-fatal warning — the extension is still usable from the first
  // registration.  The alternative (sending 0 extensions) is worse:
  // the EH has nothing to activate and require('vscode') never fires.
  const extensions = [];
  const myExtensionIds = [];

  try {
    const dirs = fs.readdirSync(EXTENSIONS_DIR);
    for (const dir of dirs) {
      const pkgPath = path.join(EXTENSIONS_DIR, dir, 'package.json');
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        const extId = `${pkg.publisher || 'unknown'}.${pkg.name || dir}`.toLowerCase();
        const extIdentifier = { value: extId, _lower: extId };
        const extLocation = path.join(EXTENSIONS_DIR, dir);
        const hasRuntimeEntry = !!(pkg.main || pkg.browser);
        const forceNodeEntrypoint = !!pkg.main;
        const contributes = pkg.contributes || {};
        const hasUIContributions = !!(
          (contributes.views && Object.keys(contributes.views).length > 0)
          || (contributes.viewsContainers && Object.keys(contributes.viewsContainers).length > 0)
          || (contributes.customEditors && contributes.customEditors.length > 0)
          || (contributes.notebooks && contributes.notebooks.length > 0)
        );
        const declaredActivationEvents = Array.isArray(pkg.activationEvents) && pkg.activationEvents.length > 0
          ? pkg.activationEvents
          : ['*'];
        const activationEvents = hasRuntimeEntry && hasUIContributions
          ? Array.from(new Set(['*', ...declaredActivationEvents]))
          : declaredActivationEvents;
        const rawDeclaredExtensionKind = Array.isArray(pkg.extensionKind)
          ? pkg.extensionKind
          : (pkg.extensionKind !== undefined && pkg.extensionKind !== null ? [pkg.extensionKind] : []);
        const declaredExtensionKind = rawDeclaredExtensionKind
          .map((kind) => {
            if (kind === 1 || kind === 2 || kind === 3) return kind;
            if (kind === 'ui') return 1;
            if (kind === 'workspace') return 2;
            if (kind === 'web') return 3;
            return undefined;
          })
          .filter((kind) => typeof kind === 'number');
        const extensionKind = hasRuntimeEntry
          ? Array.from(new Set([2, ...declaredExtensionKind]))
          : declaredExtensionKind;

        const extensionDesc = {
          // ExtensionIdentifier serialized shape used by VS Code internals.
          // `_lower` is required for identifier keying in ExtensionIdentifier.toKey().
          identifier: extIdentifier,
          id: extId,
          // CRITICAL: $mid: 1 marks this object as a URI for VS Code's
          // MarshalledObjectMarshaller / reviveInitData().  Without it,
          // URI.revive() is never called and the object stays a plain POJO.
          // Calls to .fsPath / .toString() then fail silently, stalling
          // the EH bootstrap before extension loading begins.
          extensionLocation: { $mid: 1, scheme: 'file', authority: '', path: extLocation, query: '', fragment: '' },
          isBuiltin: false,
          isUnderDevelopment: false,
          name: pkg.name || dir,
          publisher: pkg.publisher || 'unknown',
          version: pkg.version || '0.0.0',
          engines: pkg.engines || { vscode: '*' },
          main: pkg.main || undefined,
          // In Synthi's headless remote Extension Host path we need providers
          // to register inside the Node EH process. If both main+browser are
          // present, VS Code web flows may prefer browser entrypoints that
          // won't execute in this process. Prefer Node when available.
          browser: forceNodeEntrypoint ? undefined : (pkg.browser || undefined),
          activationEvents,
          extensionKind,
          contributes: pkg.contributes || {},
          enabledApiProposals: pkg.enabledApiProposals || [],
          // 'api' controls whether VS Code provides the 'vscode' module.
          // Extensions with a main/browser entry point need 'vscode';
          // theme-only extensions (no entry point) can use 'none'.
          api: pkg.api || (pkg.main || pkg.browser ? 'vscode' : 'none'),
          targetPlatform: 'universal',
          // Required by IExtensionDescription in newer VS Code builds.
          isUserBuiltin: false,
          isApplicationScoped: false,
          preRelease: !!pkg.preview,
          uuid: crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'),
        };

        extensions.push(extensionDesc);
        // myExtensions in init data is expected to be extension ID strings.
        // Using identifier objects can prevent the EH from considering these
        // as local/owned extensions, which blocks activation.
        myExtensionIds.push(extId);

        if (!pkg.main && !pkg.browser) {
          process.stderr.write(`[eh-init] Extension ${extId}: no main/browser field — may be theme-only\n`);
        }

        if (forceNodeEntrypoint && pkg.browser) {
          process.stderr.write(`[eh-init] Extension ${extId}: forcing Node entrypoint (main=${pkg.main}, browser=${pkg.browser} ignored)\n`);
        }

        if (hasRuntimeEntry && hasUIContributions && !declaredActivationEvents.includes('*')) {
          process.stderr.write(`[eh-init] Extension ${extId}: forcing '*' activation in headless mode (declared: ${declaredActivationEvents.length})\n`);
        }

        if (hasRuntimeEntry && (!declaredExtensionKind.includes(2))) {
          process.stderr.write(`[eh-init] Extension ${extId}: forcing extensionKind to include workspace(2) (declared: ${declaredExtensionKind.length ? declaredExtensionKind.join(',') : 'none'})\n`);
        }

        process.stderr.write(`[eh-init] Extension: ${extId} (main: ${pkg.main || pkg.browser || 'none'}, api: ${extensionDesc.api})\n`);
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
      appRoot: { $mid: 1, scheme: 'file', authority: '', path: '/', query: '', fragment: '' },
      appName: 'code-server',
      appHost: 'web',
      appLanguage: 'en',
      extensionTelemetryLogResource: { $mid: 1, scheme: 'file', authority: '', path: path.join(logsDir, 'telemetry.log'), query: '', fragment: '' },
      isExtensionTelemetryLoggingOnly: true,
      appUriScheme: 'vscode',
      globalStorageHome: { $mid: 1, scheme: 'file', authority: '', path: path.join(userDataDir, 'globalStorage'), query: '', fragment: '' },
      workspaceStorageHome: { $mid: 1, scheme: 'file', authority: '', path: path.join(userDataDir, 'workspaceStorage'), query: '', fragment: '' },
    },
    workspace: {
      id: currentSlug || 'default',
      name: currentSlug || 'workspace',
      configuration: null,
      isUntitled: false,
      transient: false,
      // folders is REQUIRED — VS Code crashes during workspace init without it
      folders: [{
        uri: { $mid: 1, scheme: 'file', authority: '', path: workspaceDir, query: '', fragment: '' },
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
    //   { allExtensions, myExtensions, activationEvents }
    // activationEvents is a map: { [extensionId: string]: string[] }
    // SyncedActivationEventsReader's constructor calls Object.keys() on it,
    // so it MUST be a non-null object (even if empty).
    extensions: {
      allExtensions: extensions,
      myExtensions: myExtensionIds,
      activationEvents: (() => {
        const map = Object.create(null);
        for (const ext of extensions) {
          map[ext.identifier.value.toLowerCase()] = ext.activationEvents || ['*'];
        }
        return map;
      })(),
    },
    logLevel: 1, // LogLevel.Info
    // Each logger MUST have resource, id, and name
    loggers: [{
      resource: { $mid: 1, scheme: 'file', authority: '', path: path.join(logsDir, 'exthost.log'), query: '', fragment: '' },
      id: 'exthost',
      name: 'Extension Host',
    }],
    logsLocation: { $mid: 1, scheme: 'file', authority: '', path: logsDir, query: '', fragment: '' },
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
  if (!initData.extensions?.activationEvents || typeof initData.extensions.activationEvents !== 'object') {
    process.stderr.write(`[eh-init] WARNING: extensions.activationEvents is missing — SyncedActivationEventsReader will crash\n`);
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
                  manifestKnownWebviewViews.add(view.id);
                  // Queue webview resolution — will be flushed after bootstrapState
                  // is received, ensuring extensions have actually activated.
                  const viewType = view.id;
                  if (_bootstrapStateReceived) {
                    // Bootstrap already received — resolve after a short delay
                    const t = setTimeout(() => {
                      if (preloadRegisteredWebviewViews.has(viewType)) {
                        sendToPreloadClients({ action: 'resolveWebviewView', viewType });
                      }
                    }, 3000);
                    if (t.unref) t.unref();
                  } else {
                    _deferredWebviewResolutions.push(viewType);
                    process.stderr.write(`[ext-scan]   Deferred webview resolution for ${viewType} (waiting for bootstrapState)\n`);
                  }
                } else {
                  manifestKnownTreeViews.add(view.id);
                }
              }
            }
          }
        }
      }
    }
  }

  process.stderr.write(`[ext-scan] Scan complete: ${dirs.length} extensions, ${uiExtCount} with UI contributions\n`);

  // Always emit a static+RPC merged list so the browser can render
  // contribution shells even when bootstrap interception never fires.
  _emitMergedFallbackProviders('post-ext-scan');

  // If bootstrap still hasn't arrived shortly after scanning, force
  // fallback provider discovery and event emission.
  const bootstrapGraceTimer = setTimeout(() => {
    if (_bootstrapStateReceived) return;
    process.stderr.write('[fallback-providers] bootstrapState still missing after ext scan grace period — using manifest/RPC fallback\n');
    _emitMergedFallbackProviders('bootstrap-missing');
  }, 8000);
  if (bootstrapGraceTimer.unref) bootstrapGraceTimer.unref();
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
 * Collect contributed webview view IDs from extension manifest.
 *
 * @param {object} manifest
 * @returns {string[]}
 */
function _getContributedWebviewViewIds(manifest) {
  if (!manifest?.contributes?.views || typeof manifest.contributes.views !== 'object') {
    return [];
  }

  const ids = [];
  for (const views of Object.values(manifest.contributes.views)) {
    if (!Array.isArray(views)) continue;
    for (const view of views) {
      if (view?.type === 'webview' && typeof view.id === 'string' && view.id) {
        ids.push(view.id);
      }
    }
  }
  return ids;
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
  const webviewViewTypes = _getContributedWebviewViewIds(manifest);

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
  for (const viewType of webviewViewTypes) {
    if (preloadRegisteredWebviewViews.has(viewType)) {
      sendToPreloadClients({ action: 'resolveWebviewView', viewType });
    }
  }

  // Also schedule retries — extensions may not have activated yet when
  // the first request fires (they need to require('vscode'), register
  // providers, etc.)  Retry at 5s and 15s after loadExtensionForUI.
  const retryDelays = [5000, 15000];
  for (const delay of retryDelays) {
    const timer = setTimeout(() => {
      process.stderr.write(`[preload-bridge] Retry provider refresh for ${extensionId} (${delay / 1000}s)\n`);
      sendToPreloadClients({ action: 'refreshAllTrees' });
      sendToPreloadClients({ action: 'listProviders' });
      for (const viewType of webviewViewTypes) {
        if (preloadRegisteredWebviewViews.has(viewType)) {
          sendToPreloadClients({ action: 'resolveWebviewView', viewType });
        }
      }
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
  preloadRegisteredTreeViews.clear();
  preloadRegisteredWebviewViews.clear();
  _skippedTreeRefreshLogged.clear();
  _skippedWebviewResolveLogged.clear();
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

  const { id, method } = msg;
  const args = Array.isArray(msg.args)
    ? msg.args
    : (msg.args === undefined || msg.args === null ? [] : [msg.args]);

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
          if (preloadRegisteredTreeViews.has(viewId)) {
            sendToPreloadClients({ action: 'refreshTreeData', viewId });
          } else {
            if (!_skippedTreeRefreshLogged.has(viewId)) {
              _skippedTreeRefreshLogged.add(viewId);
              process.stderr.write(`[preload-bridge] Skipping refreshTreeData for ${viewId}: provider not registered yet\n`);
            }
          }
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
        if (preloadRegisteredWebviewViews.has(viewType)) {
          log(`Requesting preload to resolve webview view: ${viewType}`);
          sendToPreloadClients({ action: 'resolveWebviewView', viewType });
          sendResponse(id, { success: true, viewType });
        } else {
          if (!_skippedWebviewResolveLogged.has(viewType)) {
            _skippedWebviewResolveLogged.add(viewType);
            process.stderr.write(`[preload-bridge] Skipping resolveWebviewView for ${viewType}: provider not registered yet\n`);
          }
          sendResponse(id, { success: false, skipped: true, reason: 'provider-not-registered', viewType });
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
