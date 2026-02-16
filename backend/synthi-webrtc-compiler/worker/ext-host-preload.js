#!/usr/bin/env node
/**
 * Extension Host Preload Script
 *
 * Injected into code-server's Extension Host process via NODE_OPTIONS=--require.
 * This script runs BEFORE any extension code loads. It intercepts the real
 * `vscode` module at the Module._load level and wraps specific API surfaces
 * (registerTreeDataProvider, createTreeView, registerWebviewViewProvider,
 * createWebviewPanel) to extract UI events and relay them to the
 * vscode-server-manager over a local TCP connection.
 *
 * KEY DESIGN PRINCIPLES:
 *   1. NO SHIMS — extensions get the REAL vscode API. We only wrap the
 *      return values to observe registrations and data changes.
 *   2. UNIVERSAL — works with any extension because the real API handles
 *      all the complexity (l10n, authentication, git, etc.)
 *   3. TRANSPARENT — if the TCP bridge is unavailable, extensions run
 *      normally with zero overhead.
 *   4. NON-INVASIVE — we never replace or stub API methods. We intercept
 *      the real module's exports and add observation hooks.
 *
 * Communication:
 *   This script ↔ TCP ↔ vscode-server-manager.js ↔ stdout ↔ Rust ↔ browser
 *
 * The TCP protocol is newline-delimited JSON:
 *   { type: 'treeProvider', viewId, extensionId }
 *   { type: 'treeData', viewId, data: [...] }
 *   { type: 'webviewProvider', viewType, extensionId }
 *   { type: 'webviewHtml', viewType, html }
 *   { type: 'command', commandId, extensionId }
 */

'use strict';

if (globalThis.__SYNTHI_EXTHOST_PRELOAD_LOADED) {
  process.stderr.write('[ext-host-preload] Duplicate load detected, skipping\n');
  return;
}
globalThis.__SYNTHI_EXTHOST_PRELOAD_LOADED = true;

// Early prefix (before full logging is set up)
const PREFIX_EARLY = '[ext-host-preload]';

// ============================================================================
// Guard: only activate inside VS Code's Extension Host process
// ============================================================================

// Pre-guard diagnostic — always log so we can confirm the file loaded
process.stderr.write(`${PREFIX_EARLY} Loading (PID=${process.pid}, script=${__filename})\n`);
process.stderr.write(`${PREFIX_EARLY}   SYNTHI_EXT_BRIDGE_PORT=${process.env.SYNTHI_EXT_BRIDGE_PORT || '(unset)'}\n`);
process.stderr.write(`${PREFIX_EARLY}   SYNTHI_EXTENSION_HOST_CONFIRMED=${process.env.SYNTHI_EXTENSION_HOST_CONFIRMED || '(unset)'}\n`);

// SYNTHI_EXTENSION_HOST_CONFIRMED is set by our extensionHostProcess.js patch,
// right before require(). If it's present we KNOW we're in the Extension Host.
// SYNTHI_EXT_BRIDGE_PORT tells us where to connect.
const isExtensionHost = process.env.SYNTHI_EXTENSION_HOST_CONFIRMED === 'true'
  || process.argv.includes('--type=extensionHost');

// The manager tells us where to connect
const BRIDGE_PORT = parseInt(process.env.SYNTHI_EXT_BRIDGE_PORT || '0', 10);

if (!isExtensionHost) {
  process.stderr.write(`${PREFIX_EARLY} Guard failed — not in Extension Host, skipping\n`);
  return;
}

if (!BRIDGE_PORT) {
  process.stderr.write(`${PREFIX_EARLY} No bridge port configured, skipping\n`);
  return;
}

// ============================================================================
// Logging (to stderr so it doesn't interfere with VS Code's IPC)
// ============================================================================

const PREFIX = '[ext-host-preload]';

function log(...args) {
  process.stderr.write(`${PREFIX} ${args.join(' ')}\n`);
}

function logError(...args) {
  process.stderr.write(`${PREFIX} ERROR: ${args.join(' ')}\n`);
}

log(`Preload activated (PID=${process.pid}, bridge port=${BRIDGE_PORT})`);

// ============================================================================
// ESM Loader Hook Registration
//
// Node.js 22+ supports module.register() for custom ESM loader hooks.
// VS Code's ESM build loads extensions via dynamic import(), which
// bypasses CJS Module._load hooks entirely.  Register our ESM hook
// to intercept `import('vscode')` in ESM extensions.
// ============================================================================

try {
  const nodeModule = require('module');
  if (typeof nodeModule.register === 'function') {
    const hookPath = require('path').join(__dirname, 'esm-vscode-hook.mjs');
    const hookUrl = require('url').pathToFileURL(hookPath).href;
    nodeModule.register(hookUrl);
    log(`ESM loader hook registered: ${hookPath}`);
  } else {
    log('module.register() not available — ESM hook not installed');
  }
} catch (e) {
  log(`ESM loader hook registration failed (non-fatal): ${e.message}`);
}

// ============================================================================
// Extension ID Inference
//
// When wrapper functions are called (registerTreeDataProvider, etc.), we
// infer the calling extension's ID from the call stack by looking for
// paths inside the extensions directory.
// ============================================================================

/**
 * Attempt to infer the calling extension's ID from the call stack.
 * Looks for paths like `.../extensions/publisher.name-version/...`
 *
 * @returns {string|undefined}
 */
function _inferExtensionId() {
  try {
    const stack = new Error().stack || '';
    // Match paths like /extensions/publisher.name-1.0.0/ or \extensions\publisher.name-1.0.0\
    const match = stack.match(/[/\\]extensions[/\\]([^/\\]+?)-\d+[^/\\]*[/\\]/);
    if (match) return match[1];
    // Fallback: match any extensions/xxx/ pattern
    const fallback = stack.match(/[/\\]extensions[/\\]([^/\\]+?)[/\\]/);
    if (fallback) return fallback[1];
  } catch (_) {}
  return undefined;
}

// ============================================================================
// TCP Bridge Connection
// ============================================================================

const net = require('net');

/** @type {net.Socket|null} */
let bridgeSocket = null;

/** @type {boolean} */
let bridgeConnected = false;

/** @type {Array<string>} Messages queued before connection is established */
let pendingMessages = [];

/** @type {boolean} */
let connectionAttempted = false;

/** @type {number} */
let reconnectAttempts = 0;

/** @type {number} Maximum reconnection attempts */
const MAX_RECONNECT_ATTEMPTS = 10;

/** @type {number} Base delay for exponential backoff (ms) */
const RECONNECT_BASE_DELAY = 1000;

/** @type {number} Maximum delay between reconnects (ms) */
const RECONNECT_MAX_DELAY = 30000;

/**
 * Connect to the vscode-server-manager's TCP bridge.
 * Non-blocking — if connection fails, extensions still work normally.
 * Supports automatic reconnection with exponential backoff.
 */
function connectBridge() {
  if (connectionAttempted || bridgeConnected) return;
  connectionAttempted = true;

  const socket = net.createConnection({ port: BRIDGE_PORT, host: '127.0.0.1' }, () => {
    log('Connected to bridge');
    bridgeSocket = socket;
    bridgeConnected = true;
    const wasReconnect = reconnectAttempts > 0;
    reconnectAttempts = 0; // Reset on successful connection

    // Flush queued messages
    for (const msg of pendingMessages) {
      socket.write(msg + '\n');
    }
    pendingMessages = [];

    // Announce ourselves with an initial handshake
    bridgeSend({
      type: 'hello',
      pid: process.pid,
      ppid: process.ppid,
      extHostEnv: !!process.env.VSCODE_IPC_HOOK_EXTHOST,
    });

    // On reconnect, re-send current state so manager catches up
    if (wasReconnect && vsCodeWrapped) {
      log('Reconnect: re-sending bootstrapState and provider list');
      bridgeSend({
        type: 'bootstrapState',
        complete: true,
        method: 'reconnect',
        wrappedCount: _wrappedApiCount,
      });
      // Immediately send current provider list
      const treeViews = Array.from(trackedTreeProviders.keys());
      const webviews = Array.from(trackedWebviewProviders.keys());
      bridgeSend({ type: 'providerList', treeViews, webviews });
    }
  });

  socket.setNoDelay(true);

  // ── Handle incoming messages from the manager ──
  let incomingBuf = '';
  socket.on('data', (chunk) => {
    incomingBuf += chunk.toString();
    let newlineIdx;
    while ((newlineIdx = incomingBuf.indexOf('\n')) !== -1) {
      const line = incomingBuf.slice(0, newlineIdx).trim();
      incomingBuf = incomingBuf.slice(newlineIdx + 1);
      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        _handleBridgeRequest(msg);
      } catch (e) {
        logError(`Failed to parse bridge request: ${e.message}`);
      }
    }
  });

  socket.on('error', (err) => {
    logError(`Bridge connection error: ${err.message}`);
    bridgeConnected = false;
    bridgeSocket = null;
    _scheduleReconnect();
  });

  socket.on('close', () => {
    log('Bridge connection closed');
    bridgeConnected = false;
    bridgeSocket = null;
    _scheduleReconnect();
  });

  // Don't let the socket keep the process alive
  socket.unref();
}

/**
 * Schedule a reconnection attempt with exponential backoff.
 */
function _scheduleReconnect() {
  if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    log(`Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached — giving up`);
    return;
  }

  const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts), RECONNECT_MAX_DELAY);
  reconnectAttempts++;
  log(`Scheduling reconnect attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms`);

  const timer = setTimeout(() => {
    connectionAttempted = false;
    connectBridge();
  }, delay);

  // Don't let the timer keep the process alive
  if (timer.unref) timer.unref();
}

/**
 * Send a JSON message to the bridge. Queues if not yet connected.
 * Queue is limited to prevent memory leaks if bridge never connects.
 * @param {object} msg
 */
function bridgeSend(msg) {
  try {
    const json = JSON.stringify(msg);
    if (bridgeConnected && bridgeSocket) {
      bridgeSocket.write(json + '\n');
    } else {
      // Cap the queue at 500 messages to prevent unbounded memory growth
      if (pendingMessages.length < 500) {
        pendingMessages.push(json);
      }
    }
  } catch (e) {
    // Never let serialization errors bubble up to extension code
    logError(`bridgeSend error: ${e.message}`);
  }
}

// Initiate connection immediately
connectBridge();

// ============================================================================
// Process IPC Monitor
//
// The Extension Host communicates with code-server's main process via
// Node.js IPC (process.send / process.on('message')).  The critical
// sequence is:
//   1. EH sends VSCODE_EXTHOST_IPC_READY to server     (outgoing)
//   2. Server sends VSCODE_EXTHOST_IPC_SOCKET + handle  (incoming)
//   3. EH wraps the received socket in PersistentProtocol
//   4. EH reads initialization data from the protocol
//   5. EH loads and activates extensions
//
// If step 2 never happens (server doesn't send socket), or step 4 stalls
// (client never sends init data), the EH sits idle forever.  We monitor
// IPC to diagnose exactly where the chain breaks.
// ============================================================================

let _ipcMessageCount = 0;
let _ipcReceivedSocket = false;
let _ipcReadySent = false;

// Monitor outgoing process.send to detect when EH signals readiness
const _origProcessSend = process.send ? process.send.bind(process) : null;
if (_origProcessSend) {
  let _ipcOutCount = 0;
  process.send = function synthiProcessSendMonitor(msg, handle, options, callback) {
    if (msg && typeof msg === 'object') {
      _ipcOutCount++;
      if (msg.type === 'VSCODE_EXTHOST_IPC_READY') {
        _ipcReadySent = true;
        log('IPC OUT: Extension Host sent VSCODE_EXTHOST_IPC_READY → server should now send us the client socket');
      } else if (_ipcOutCount <= 5) {
        // Only log first 5 outgoing IPC messages to avoid noise
        log(`IPC OUT #${_ipcOutCount}: type=${msg.type || JSON.stringify(msg).slice(0, 100)}`);
      }
    }
    return _origProcessSend.apply(process, arguments);
  };
  log(`IPC: process.send interceptor installed (process.connected=${process.connected})`);
} else {
  log('IPC: process.send is null — IPC channel may not be available (Extension Host not spawned via fork?)');
}

// Monitor incoming messages
process.on('message', (msg, handle) => {
  _ipcMessageCount++;

  if (msg && typeof msg === 'object') {
    const msgType = msg.type || '(no type)';
    const hasHandle = !!handle;
    log(`IPC IN #${_ipcMessageCount}: type=${msgType} hasHandle=${hasHandle}`);

    if (msgType === 'VSCODE_EXTHOST_IPC_SOCKET' || hasHandle) {
      _ipcReceivedSocket = true;
      log('IPC IN: Received client socket from server — Extension Host protocol should initialize now');
      log(`IPC IN: Socket handle type: ${handle?.constructor?.name || typeof handle}`);
      // Log init params if present
      if (msg.initialDataChunk) {
        log(`IPC IN: initialDataChunk present (${msg.initialDataChunk.length || 'N/A'} bytes)`);
      }
      if (msg.skipWebSocketFrames !== undefined) {
        log(`IPC IN: skipWebSocketFrames=${msg.skipWebSocketFrames}`);
      }
      // Notify bridge about IPC state
      bridgeSend({
        type: 'ipcState',
        readySent: _ipcReadySent,
        socketReceived: true,
        socketType: handle?.constructor?.name || 'unknown',
      });
    }
  }
});

// Report IPC channel state
if (process.connected) {
  log('IPC: Channel available (process.connected=true)');
} else {
  log('WARNING: IPC channel NOT available (process.connected=false) — Extension Host cannot communicate with server');
}

// Diagnostic: check if IPC ready was sent within a reasonable time
const _ipcCheckTimer = setTimeout(() => {
  if (!_ipcReadySent) {
    log('IPC WARNING: VSCODE_EXTHOST_IPC_READY was NOT sent after 10s — VS Code bootstrap may be stuck');
    log(`  process.connected: ${process.connected}`);
    log(`  VSCODE_EXTHOST_WILL_SEND_SOCKET: ${process.env.VSCODE_EXTHOST_WILL_SEND_SOCKET || '(unset)'}`);
    log(`  VSCODE_ESM_ENTRYPOINT: ${process.env.VSCODE_ESM_ENTRYPOINT || '(unset)'}`);
  } else if (!_ipcReceivedSocket) {
    log('IPC WARNING: READY was sent but socket was NOT received after 10s — server may not have forwarded the client socket');
  } else {
    log(`IPC: OK — ready sent, socket received, ${_ipcMessageCount} messages total`);
  }
}, 10000);
if (_ipcCheckTimer.unref) _ipcCheckTimer.unref();

// ============================================================================
// Module Interception
//
// DESIGN: We never change module resolution behavior.
// VS Code's Extension Host uses a custom NodeModuleRequireInterceptor
// that resolves the virtual 'vscode' module.  Our hooks must remain
// pass-through observers only.
//
// We use non-invasive strategies:
//
//   1. Module.prototype.require + Module._load observer hooks — wrap the
//      return value AFTER VS Code's interceptor has already done its work.
//      Extensions get the real API; we just observe it.
//
//   2. globalThis factory traps — In VS Code's ESM build, the API is provided
//      via globalThis._VSCODE_IMPORT_VSCODE_API / _VSCODE_API_IMPL_PROVIDER.
//      We intercept the factory assignment (Object.defineProperty setter) and
//      wrap the factory to observe every API instance it produces.
//
// Both strategies are purely observational.  They never interfere with
// module resolution, and never
// inject anything into Module._cache.
// ============================================================================

const Module = require('module');

/** @type {boolean} Whether we've wrapped at least one vscode API instance */
let vsCodeWrapped = false;

/** @type {object|null} Reference to the real vscode API for command execution */
let realVscodeApi = null;

/**
 * Track which API instances have already been wrapped to prevent double-wrapping.
 * WeakSet so we don't prevent GC of per-extension API instances.
 */
const _wrappedApiInstances = new WeakSet();
let _wrappedApiCount = 0;

/**
 * Detect whether a value looks like the real vscode API object.
 *
 * Newer VS Code/code-server builds can expose slightly different shapes
 * (e.g. missing `workspace` early, or ESM interop wrappers), so we prefer
 * capability checks over strict property triples.
 *
 * @param {any} obj
 * @returns {boolean}
 */
function _isObjectLike(obj) {
  return !!obj && (typeof obj === 'object' || typeof obj === 'function');
}

function _safeGet(obj, prop) {
  try {
    return obj ? obj[prop] : undefined;
  } catch (_) {
    return undefined;
  }
}

function _looksLikeVscodeApi(obj) {
  if (!_isObjectLike(obj)) return false;

  const windowApi = _safeGet(obj, 'window');
  const commandsApi = _safeGet(obj, 'commands');
  const hasWindow = _isObjectLike(windowApi);
  const hasWorkspace = _isObjectLike(_safeGet(obj, 'workspace'));
  const hasExtensions = _isObjectLike(_safeGet(obj, 'extensions'));
  const hasEnv = _isObjectLike(_safeGet(obj, 'env'));
  const hasCommands = _isObjectLike(commandsApi);
  const hasVersion = typeof _safeGet(obj, 'version') === 'string';
  const hasCommandExec = hasCommands && (
    typeof _safeGet(commandsApi, 'executeCommand') === 'function'
    || typeof _safeGet(commandsApi, 'registerCommand') === 'function'
  );
  const hasUiEntry = hasWindow && (
    typeof _safeGet(windowApi, 'registerTreeDataProvider') === 'function'
    || typeof _safeGet(windowApi, 'createTreeView') === 'function'
    || typeof _safeGet(windowApi, 'registerWebviewViewProvider') === 'function'
    || typeof _safeGet(windowApi, 'createWebviewPanel') === 'function'
  );
  const hasCoreSurface = hasWorkspace || hasExtensions || hasEnv || hasWindow || hasCommands || hasVersion;

  // Accept either a fully-shaped API object OR an early/proxy namespace
  // that still has enough surface to install wrappers.
  return hasCoreSurface && (hasUiEntry || hasCommandExec || (hasWindow && hasCommands));
}

/**
 * Collect possible vscode API candidates from common wrapper/interop shapes.
 *
 * @param {any} value
 * @returns {Array<{ candidate: any, sourceSuffix: string }>}
 */
function _collectVscodeApiCandidates(value) {
  const out = [];
  const seen = new Set();

  function add(candidate, sourceSuffix) {
    if (!_isObjectLike(candidate)) return;
    if (seen.has(candidate)) return;
    seen.add(candidate);
    out.push({ candidate, sourceSuffix });
  }

  add(value, '');

  // Common namespace wrappers (ESM/CJS interop).
  const likelyProps = ['default', 'vscode', 'api', 'exports', 'module'];
  for (const prop of likelyProps) {
    add(_safeGet(value, prop), ` (via ${prop})`);
  }

  // Some builds stash the API under a namespaced key; only inspect likely keys.
  try {
    for (const key of Object.keys(value || {})) {
      if (key === 'default' || /vscode|api/i.test(key)) {
        add(_safeGet(value, key), ` (via ${key})`);
      }
    }
  } catch (_) {}

  return out;
}

/**
 * Attempt to wrap a result that might be the vscode API.
 * VS Code creates separate API namespace objects per extension, so we must
 * wrap EVERY instance — not just the first.  Each instance gets its own
 * registerTreeDataProvider / registerWebviewViewProvider functions that
 * delegate to shared underlying services.
 *
 * Returns true if wrapping was performed on this call.
 */
function _tryWrapVscodeResult(result, source) {
  if (!_isObjectLike(result)) return false;

  const candidates = _collectVscodeApiCandidates(result);
  for (const { candidate, sourceSuffix } of candidates) {
    // Duck-type using capabilities (less brittle across VS Code builds)
    if (!_looksLikeVscodeApi(candidate)) continue;
    // Already wrapped this specific instance?
    if (_wrappedApiInstances.has(candidate)) continue;

    try {
      const installed = wrapVSCodeAPI(candidate);
      if (!installed) {
        continue;
      }
    } catch (e) {
      logError(`Failed to wrap vscode API candidate via ${source}${sourceSuffix}: ${e.message}`);
      logError(e.stack || '');
      continue;
    }

    _wrappedApiInstances.add(candidate);
    _wrappedApiCount++;

    // Keep a reference for command execution (first instance is fine)
    if (!realVscodeApi) {
      realVscodeApi = candidate;
    }
    vsCodeWrapped = true;

    log(`Wrapping vscode API instance #${_wrappedApiCount} via ${source}${sourceSuffix}`);
    return true;
  }

  return false;
}

/**
 * Wrap a function that may return a vscode API object.
 * Handles both sync and Promise-returning factories.
 *
 * @param {Function} fn
 * @param {string} source
 * @returns {Function}
 */
function _wrapPotentialApiFactory(fn, source) {
  if (typeof fn !== 'function') return fn;
  if (fn.__synthiApiFactoryWrapped) return fn;

  function _handleResult(result, detail) {
    try {
      const didWrap = _tryWrapVscodeResult(result, `${source}${detail ? ` (${detail})` : ''}`);
      if (didWrap) {
        log(`SUCCESS: vscode API intercepted via ${source}`);
        bridgeSend({
          type: 'bootstrapState',
          complete: true,
          method: source,
          wrappedCount: _wrappedApiCount,
        });
      }
    } catch (e) {
      logError(`${source} wrapper failed: ${e.message}`);
    }
    return result;
  }

  const wrapped = function wrappedApiFactory(...args) {
    const detail = args.length > 0 ? `arg0=${String(args[0]).slice(0, 80)}` : '';
    const result = fn.apply(this, args);

    // Some internals may return thenables/futures before exposing the API.
    if (result && typeof result.then === 'function') {
      return result.then((resolved) => _handleResult(resolved, detail));
    }
    return _handleResult(result, detail);
  };

  try {
    wrapped.__synthiApiFactoryWrapped = true;
    wrapped.__synthiApiFactorySource = source;
  } catch (_) {}

  return wrapped;
}

function _looksLikeApiFactoryName(name) {
  if (typeof name !== 'string' || !name) return false;
  return (
    /vscode/i.test(name)
    || /apifactory/i.test(name)
    || /import.*api/i.test(name)
    || /create.*api/i.test(name)
  );
}

function _tryWrapApiFactoryExports(result, source) {
  try {
    // Function export module
    if (typeof result === 'function' && _looksLikeApiFactoryName(result.name || '')) {
      const wrappedFn = _wrapPotentialApiFactory(result, `${source} (function export)`);
      if (wrappedFn !== result) {
        log(`Wrapped internal API factory function via ${source}`);
        return wrappedFn;
      }
      return result;
    }

    // Object/namespace export module
    if (!_isObjectLike(result)) return result;

    for (const key of Object.keys(result)) {
      const value = _safeGet(result, key);
      if (typeof value !== 'function') continue;
      if (!_looksLikeApiFactoryName(key) && !_looksLikeApiFactoryName(value.name || '')) continue;

      const wrappedFactory = _wrapPotentialApiFactory(value, `${source}.${key}`);
      if (wrappedFactory !== value) {
        result[key] = wrappedFactory;
        log(`Wrapped internal API factory export: ${key} via ${source}`);
      }
    }
  } catch (e) {
    logError(`Failed to wrap internal API factory exports via ${source}: ${e.message}`);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Strategy 1 (PRIMARY): Module.prototype.require hook
//
// Every CJS require() call from extension code flows through
// Module.prototype.require.  We hook it to observe returns from
// require('vscode') AFTER VS Code's own interceptor has resolved it.
// We never call require('vscode') ourselves — that would fail because
// 'vscode' is a virtual module that only VS Code's interceptor knows.
// ---------------------------------------------------------------------------

const _origPrototypeRequire = Module.prototype.require;
const _origModuleLoad = Module._load;
let _requireHookCallCount = 0;
let _moduleLoadHookCallCount = 0;

Module._load = function synthiModuleLoadHook(request, parent, isMain) {
  let result = _origModuleLoad.apply(this, arguments);

  _moduleLoadHookCallCount++;

  if (request === 'vscode') {
    try {
      const didWrap = _tryWrapVscodeResult(result, `Module._load('vscode') from ${parent?.filename || 'unknown'}`);
      if (didWrap) {
        log(`SUCCESS: vscode API intercepted via Module._load('vscode') (call #${_moduleLoadHookCallCount})`);
        bridgeSend({
          type: 'bootstrapState',
          complete: true,
          method: 'module-load-hook',
          wrappedCount: _wrappedApiCount,
        });
      }
    } catch (e) {
      logError(`Module._load hook failed to wrap: ${e.message}`);
    }
  }

  // Fallback: newer VS Code paths may expose API factories through internal
  // modules without ever loading the virtual 'vscode' module directly.
  const requestText = typeof request === 'string' ? request : '';
  if (
    requestText
    && (
      requestText.includes('extHost.api.impl')
      || requestText.includes('extHostExtensionService')
      || requestText.includes('extensionHostProcess')
      || requestText.includes('api/common')
    )
  ) {
    result = _tryWrapApiFactoryExports(result, `Module._load(${requestText})`);
  }

  return result;
};

Module.prototype.require = function synthiRequireHook(id) {
  let result = _origPrototypeRequire.apply(this, arguments);

  _requireHookCallCount++;

  if (id === 'vscode') {
    try {
      const didWrap = _tryWrapVscodeResult(result, `require('vscode') from ${this?.filename || 'unknown'}`);
      if (didWrap) {
        log(`SUCCESS: vscode API intercepted via require('vscode') (call #${_requireHookCallCount})`);
        bridgeSend({
          type: 'bootstrapState',
          complete: true,
          method: 'require-hook',
          wrappedCount: _wrappedApiCount,
        });
      }
    } catch (e) {
      logError(`require hook failed to wrap: ${e.message}`);
    }
  }

  const idText = typeof id === 'string' ? id : '';
  if (
    idText
    && (
      idText.includes('extHost.api.impl')
      || idText.includes('extHostExtensionService')
      || idText.includes('extensionHostProcess')
      || idText.includes('api/common')
    )
  ) {
    result = _tryWrapApiFactoryExports(result, `require(${idText})`);
  }

  return result;
};
log('Module._load and Module.prototype.require observer hooks installed');

// ---------------------------------------------------------------------------
// Strategy 1b (active fallback): probe require('vscode')
//
// Some VS Code/code-server ESM boot paths may never hit our passive
// interception points. As a fallback, periodically attempt to require the
// virtual 'vscode' module. This is wrapped in try/catch and only used for
// observation; failures are expected early in bootstrap.
// ---------------------------------------------------------------------------
let _activeProbeAttempts = 0;
const _maxActiveProbeAttempts = 30;
let _activeEsmProbeAttempts = 0;
const _maxActiveEsmProbeAttempts = 30;
const _activeProbeTimer = setInterval(() => {
  if (vsCodeWrapped) {
    clearInterval(_activeProbeTimer);
    return;
  }

  _activeProbeAttempts++;
  try {
    const api = module.require('vscode');
    const didWrap = _tryWrapVscodeResult(api, `active probe require('vscode') attempt ${_activeProbeAttempts}`);
    if (didWrap) {
      log(`SUCCESS: vscode API intercepted via active require probe (attempt ${_activeProbeAttempts})`);
      bridgeSend({
        type: 'bootstrapState',
        complete: true,
        method: 'active-probe',
        wrappedCount: _wrappedApiCount,
      });
      clearInterval(_activeProbeTimer);
      return;
    }
  } catch (_) {
    // Expected until VS Code's virtual module hook is fully ready.
  }

  if (_activeProbeAttempts >= _maxActiveProbeAttempts) {
    clearInterval(_activeProbeTimer);
    log(`Active require('vscode') probe exhausted after ${_activeProbeAttempts} attempts`);
  }
}, 1000);
if (_activeProbeTimer.unref) _activeProbeTimer.unref();

const _activeEsmProbeTimer = setInterval(async () => {
  if (vsCodeWrapped) {
    clearInterval(_activeEsmProbeTimer);
    return;
  }

  _activeEsmProbeAttempts++;
  try {
    const esmApi = await import('vscode');
    const didWrap = _tryWrapVscodeResult(esmApi, `active probe import('vscode') attempt ${_activeEsmProbeAttempts}`);
    if (didWrap) {
      log(`SUCCESS: vscode API intercepted via active import probe (attempt ${_activeEsmProbeAttempts})`);
      bridgeSend({
        type: 'bootstrapState',
        complete: true,
        method: 'active-esm-probe',
        wrappedCount: _wrappedApiCount,
      });
      clearInterval(_activeEsmProbeTimer);
      return;
    }
  } catch (_) {
    // Expected until VS Code's ESM virtual module path is ready.
  }

  if (_activeEsmProbeAttempts >= _maxActiveEsmProbeAttempts) {
    clearInterval(_activeEsmProbeTimer);
    log(`Active import('vscode') probe exhausted after ${_activeEsmProbeAttempts} attempts`);
  }
}, 1200);
if (_activeEsmProbeTimer.unref) _activeEsmProbeTimer.unref();

// ---------------------------------------------------------------------------
// Diagnostic: periodic status check (observation only, no recovery attempts)
//
// We log at 3 checkpoints: 10s, 30s, 60s.  Only the 60s checkpoint
// logs full detail if the API hasn't been intercepted yet; the 10s and
// 30s logs are one-liners to keep stderr manageable.
// ---------------------------------------------------------------------------
const _startedAt = Date.now();
const _statusCheckDelays = [10000, 30000, 60000];
for (const delay of _statusCheckDelays) {
  const timer = setTimeout(() => {
    const elapsed = ((Date.now() - _startedAt) / 1000).toFixed(1);
    if (vsCodeWrapped) {
      log(`Status at ${elapsed}s: API intercepted ✓ (${_wrappedApiCount} instances, ${trackedTreeProviders.size} trees, ${trackedWebviewProviders.size} webviews, ${trackedCommandHandlers.size} commands)`);
    } else if (delay >= 60000) {
      // Full diagnostic dump only at the final checkpoint
      log(`Status at ${elapsed}s: vscode API NOT yet intercepted — FULL DIAGNOSTIC:`);
      log(`  require hook calls: ${_requireHookCallCount}`);
      log(`  Module._load hook calls: ${_moduleLoadHookCallCount}`);
      log(`  active import probes: ${_activeEsmProbeAttempts}`);
      log(`  process.connected: ${process.connected}`);
      log(`  VSCODE_IPC_HOOK_EXTHOST: ${process.env.VSCODE_IPC_HOOK_EXTHOST || '(unset)'}`);
      log(`  SYNTHI_EXTENSION_HOST_CONFIRMED: ${process.env.SYNTHI_EXTENSION_HOST_CONFIRMED || '(unset)'}`);
      log(`  SYNTHI_EXT_BRIDGE_PORT: ${process.env.SYNTHI_EXT_BRIDGE_PORT || '(unset)'}`);
      log(`  IPC ready sent: ${_ipcReadySent}, socket received: ${_ipcReceivedSocket}`);
      log(`  _VSCODE_IMPORT_VSCODE_API: ${typeof globalThis._VSCODE_IMPORT_VSCODE_API}`);
      log(`  _VSCODE_API_IMPL_PROVIDER: ${typeof globalThis._VSCODE_API_IMPL_PROVIDER}`);
      log(`  Module._cache keys: ${Object.keys(require.cache || {}).length}`);
    } else {
      // Brief one-liner at earlier checkpoints
      log(`Status at ${elapsed}s: API not yet intercepted (require calls: ${_requireHookCallCount}, _load calls: ${_moduleLoadHookCallCount}, active import probes: ${_activeEsmProbeAttempts}, connected: ${process.connected})`);
    }
  }, delay);
  timer.unref();
}

// ---------------------------------------------------------------------------
// Strategy 5a: Object.defineProperty trap (ESM/global factory path)
//
// Newer VS Code builds often wire _VSCODE_* globals via defineProperty
// descriptors rather than direct assignment, which bypasses property setters.
// Hook defineProperty to wrap function descriptors/getters/setters on globalThis.
// ---------------------------------------------------------------------------

const _origObjectDefineProperty = Object.defineProperty;
Object.defineProperty = function synthiDefinePropertyTrap(target, prop, descriptor) {
  try {
    if (
      target === globalThis
      && typeof prop === 'string'
      && prop.includes('VSCODE')
      && descriptor
      && typeof descriptor === 'object'
    ) {
      const next = { ...descriptor };
      const wantsFactoryWrap = (
        prop.includes('IMPORT_VSCODE_API')
        || prop.includes('API_IMPL_PROVIDER')
        || prop.includes('VSCODE_API')
      );

      if (wantsFactoryWrap && typeof next.value === 'function') {
        next.value = _wrapPotentialApiFactory(next.value, `defineProperty:${prop}:value`);
      }

      if (wantsFactoryWrap && typeof next.get === 'function') {
        const originalGet = next.get;
        next.get = function wrappedVscodeFactoryGetter(...args) {
          const value = originalGet.apply(this, args);
          if (typeof value === 'function') {
            return _wrapPotentialApiFactory(value, `defineProperty:${prop}:getter`);
          }
          return value;
        };
      }

      if (wantsFactoryWrap && typeof next.set === 'function') {
        const originalSet = next.set;
        next.set = function wrappedVscodeFactorySetter(value, ...args) {
          const wrappedValue = typeof value === 'function'
            ? _wrapPotentialApiFactory(value, `defineProperty:${prop}:setter`)
            : value;
          return originalSet.call(this, wrappedValue, ...args);
        };
      }

      return _origObjectDefineProperty.call(this, target, prop, next);
    }
  } catch (e) {
    logError(`defineProperty trap error for ${String(prop)}: ${e.message}`);
  }

  return _origObjectDefineProperty.call(this, target, prop, descriptor);
};
log('Object.defineProperty trap installed for global VSCODE factories');

// ---------------------------------------------------------------------------
// Strategy 5: globalThis API factory interception (ESM build)
//
// In VS Code's ESM build, the vscode API is provided to extensions via
// global factory functions stored on globalThis:
//   - _VSCODE_IMPORT_VSCODE_API: called by the ESM module loader when
//     an extension does `import * as vscode from 'vscode'`
//   - _VSCODE_API_IMPL_PROVIDER: set in extensionHostMain.ts as the
//     backing factory for all per-extension API namespaces
//
// We install Object.defineProperty traps to detect the exact moment
// VS Code sets these globals, then wrap the factory so every API
// instance it produces passes through _tryWrapVscodeResult().
// ---------------------------------------------------------------------------

// Trap 1: _VSCODE_IMPORT_VSCODE_API (ESM import interception)
let _esmApiFactory = undefined;
try {
  // Capture if already set (unlikely but safe)
  const existing = globalThis._VSCODE_IMPORT_VSCODE_API;

  Object.defineProperty(globalThis, '_VSCODE_IMPORT_VSCODE_API', {
    get() { return _esmApiFactory; },
    set(factory) {
      if (typeof factory !== 'function') {
        _esmApiFactory = factory;
        return;
      }
      log('globalThis._VSCODE_IMPORT_VSCODE_API set by VS Code — wrapping factory');
      _esmApiFactory = _wrapPotentialApiFactory(factory, '_VSCODE_IMPORT_VSCODE_API');
      log('ESM API factory wrapped via globalThis trap');
    },
    configurable: true,
    enumerable: true,
  });

  // If it was already set before our trap, wrap it now
  if (typeof existing === 'function') {
    globalThis._VSCODE_IMPORT_VSCODE_API = existing; // triggers our setter
  }
  log('globalThis._VSCODE_IMPORT_VSCODE_API property trap installed');
} catch (e) {
  logError(`Failed to install ESM API factory trap: ${e.message}`);
}

// Trap 2: _VSCODE_API_IMPL_PROVIDER (extensionHostMain.ts factory)
let _apiImplProvider = undefined;
try {
  const existing2 = globalThis._VSCODE_API_IMPL_PROVIDER;

  Object.defineProperty(globalThis, '_VSCODE_API_IMPL_PROVIDER', {
    get() { return _apiImplProvider; },
    set(provider) {
      if (typeof provider !== 'function') {
        _apiImplProvider = provider;
        return;
      }
      log('globalThis._VSCODE_API_IMPL_PROVIDER set by VS Code — wrapping');
      _apiImplProvider = _wrapPotentialApiFactory(provider, '_VSCODE_API_IMPL_PROVIDER');
    },
    configurable: true,
    enumerable: true,
  });

  if (typeof existing2 === 'function') {
    globalThis._VSCODE_API_IMPL_PROVIDER = existing2;
  }
  log('globalThis._VSCODE_API_IMPL_PROVIDER property trap installed');
} catch (e) {
  logError(`Failed to install API IMPL provider trap: ${e.message}`);
}

// Note: We do NOT poll globalThis for unknown _VSCODE* functions.
// Blindly calling unknown globals can trigger side effects and break
// VS Code's bootstrap.  The two traps above cover the known factories.

// ---------------------------------------------------------------------------
// Strategy 6: Module._cache polling fallback
//
// If neither the require hook nor the globalThis traps fired after 15s,
// it likely means VS Code's bootstrap used an unanticipated code path
// (e.g. a new ESM loader, internal extensionHostMain changes, etc.).
//
// As a last resort, scan Module._cache for any cached module whose
// exports look like the vscode API (duck-type via capability checks).
// This is purely observational — we never call
// require('vscode') ourselves.
// ---------------------------------------------------------------------------
const _cachePollDelays = [15000, 25000, 40000];
for (const delay of _cachePollDelays) {
  const pollTimer = setTimeout(() => {
    if (vsCodeWrapped) return; // already intercepted

    const elapsed = ((Date.now() - _startedAt) / 1000).toFixed(1);
    log(`Cache poll at ${elapsed}s: scanning Module._cache for vscode API...`);

    const cache = require.cache || {};
    let found = false;
    for (const key of Object.keys(cache)) {
      const mod = cache[key];
      if (!mod || !Object.prototype.hasOwnProperty.call(mod, 'exports')) continue;
      const ex = mod.exports;
      const didWrap = _tryWrapVscodeResult(ex, `Module._cache poll (key: ${key.slice(-80)})`);
      if (didWrap) {
        log(`SUCCESS: vscode API intercepted via Module._cache poll`);
        bridgeSend({
          type: 'bootstrapState',
          complete: true,
          method: 'cache-poll',
          wrappedCount: _wrappedApiCount,
        });
        found = true;
        break;
      }
    }

    if (!found) {
      log(`Cache poll at ${elapsed}s: no vscode API found in ${Object.keys(cache).length} cached modules`);
    }
  }, delay);
  pollTimer.unref();
}

// ---------------------------------------------------------------------------
// Strategy 6b: passive global factory scan fallback
//
// Some code-server builds expose API factories on renamed global keys that
// still contain VSCODE/API hints, but don't hit our exact traps soon enough.
// We never call global functions here; we only wrap descriptors/functions.
// ---------------------------------------------------------------------------
function _looksLikeGlobalFactoryKey(name) {
  return (
    /VSCODE/i.test(name)
    || /EXTHOST/i.test(name)
    || /API_IMPL/i.test(name)
    || /IMPORT_VSCODE_API/i.test(name)
  );
}

function _scanAndWrapGlobalFactories(reason) {
  if (vsCodeWrapped) return 0;

  let wrapped = 0;
  const names = Object.getOwnPropertyNames(globalThis);
  for (const name of names) {
    if (!_looksLikeGlobalFactoryKey(name)) continue;

    let desc;
    try {
      desc = Object.getOwnPropertyDescriptor(globalThis, name);
    } catch (_) {
      continue;
    }
    if (!desc || !desc.configurable) continue;

    const next = { ...desc };
    let changed = false;

    if (typeof next.value === 'function') {
      const wrappedValue = _wrapPotentialApiFactory(next.value, `global-scan:${reason}:${name}:value`);
      if (wrappedValue !== next.value) {
        next.value = wrappedValue;
        changed = true;
      }
    }

    if (typeof next.get === 'function') {
      const originalGet = next.get;
      next.get = function wrappedGlobalFactoryGetter(...args) {
        const value = originalGet.apply(this, args);
        if (typeof value === 'function') {
          return _wrapPotentialApiFactory(value, `global-scan:${reason}:${name}:getter`);
        }
        return value;
      };
      changed = true;
    }

    if (typeof next.set === 'function') {
      const originalSet = next.set;
      next.set = function wrappedGlobalFactorySetter(value, ...args) {
        const maybeWrapped = typeof value === 'function'
          ? _wrapPotentialApiFactory(value, `global-scan:${reason}:${name}:setter`)
          : value;
        return originalSet.call(this, maybeWrapped, ...args);
      };
      changed = true;
    }

    if (!changed) continue;

    try {
      _origObjectDefineProperty.call(Object, globalThis, name, next);
      wrapped++;
    } catch (_) {
      // Ignore non-overridable properties
    }
  }

  if (wrapped > 0) {
    log(`Global factory scan (${reason}) wrapped ${wrapped} candidate descriptors`);
  }
  return wrapped;
}

for (const delay of [12000, 22000, 35000]) {
  const timer = setTimeout(() => {
    _scanAndWrapGlobalFactories(`t+${delay}ms`);
  }, delay);
  if (timer.unref) timer.unref();
}

// ============================================================================
// State: tracked providers
// ============================================================================

/** @type {Map<string, {provider: object, extensionId?: string}>} */
const trackedTreeProviders = new Map();

/** @type {Map<string, {provider: object, extensionId?: string}>} */
const trackedWebviewProviders = new Map();

/** @type {Map<string, {callback: Function, thisArg?: any}>} */
const trackedCommandHandlers = new Map();

/** @type {Map<string, {handler: object, extensionId?: string}>} */
const trackedUriHandlers = new Map();

/** @type {Array<string>} pending URI callback URLs received before handler registration */
const pendingUriCallbacks = [];

/** @type {Set<string>} commands already attempted for extension activation */
const _commandActivationAttempts = new Set();

/** @type {boolean} one-time broad activation attempt completed */
let _broadCommandActivationAttempted = false;

/** @type {{ id: string|null, ts: number }} recent user-triggered bridge command context */
const _lastBridgeCommand = { id: null, ts: 0 };

/** @type {Map<string, number>} providerId -> last forced interactive auth timestamp */
const _lastForcedInteractiveAuthAt = new Map();

/** @type {Map<string, number>} providerId -> timestamp when session was confirmed available */
const _knownAuthSessionAt = new Map();

/** @type {{ key: string|null, ts: number }} duplicate executeCommand suppression */
const _lastExecuteCommandEnvelope = { key: null, ts: 0 };

/** @type {Set<string>} viewTypes already logged as missing provider */
const _missingWebviewProviderLogged = new Set();

// ============================================================================
// Tree Data Resolution
//
// Calls the real TreeDataProvider's getChildren() and getTreeItem() methods
// to extract the tree structure, then sends it to the bridge as JSON.
// ============================================================================

/** Maximum depth to recurse when resolving tree data */
const TREE_MAX_DEPTH = 4;

/** Maximum items per level */
const TREE_MAX_ITEMS_PER_LEVEL = 200;

/**
 * Safely serialize command arguments to prevent JSON.stringify failures.
 * Converts Uri objects to strings, strips circular refs and class instances.
 *
 * @param {any[]|undefined} args
 * @returns {any[]|undefined}
 */
function _safeSerializeArgs(args) {
  if (!args || !Array.isArray(args)) return undefined;
  try {
    // Test serialization first — fast path for simple args
    JSON.stringify(args);
    return args;
  } catch (_) {
    // Fallback: serialize individual args with replacer
    return args.map(arg => {
      try {
        return JSON.parse(JSON.stringify(arg, (key, value) => {
          if (typeof value === 'bigint') return String(value);
          if (value && typeof value === 'object' && typeof value.toString === 'function' && value.scheme) {
            // VS Code Uri object
            return value.toString();
          }
          return value;
        }));
      } catch (_) {
        return String(arg);
      }
    });
  }
}

/** Debounce timer map to avoid hammering providers on rapid changes */
const _treeResolveTimers = new Map();

/**
 * Resolve tree data from a provider and send it to the bridge.
 * Debounced at 150ms per viewId to handle rapid onDidChangeTreeData bursts.
 *
 * @param {string} viewId
 * @param {object} provider - A TreeDataProvider with getChildren/getTreeItem
 */
function resolveAndSendTreeData(viewId, provider) {
  // Debounce
  if (_treeResolveTimers.has(viewId)) {
    clearTimeout(_treeResolveTimers.get(viewId));
  }

  _treeResolveTimers.set(viewId, setTimeout(async () => {
    _treeResolveTimers.delete(viewId);

    if (!provider || typeof provider.getChildren !== 'function') {
      log(`No getChildren for ${viewId}, skipping resolve`);
      return;
    }

    try {
      const data = await _resolveTreeLevel(provider, undefined, 0);
      log(`Resolved tree data for ${viewId}: ${data.length} root items`);
      bridgeSend({ type: 'treeData', viewId, data });
    } catch (err) {
      logError(`Tree data resolve failed for ${viewId}: ${err.message}`);
      // Send empty tree so the UI doesn't stay in loading state
      bridgeSend({ type: 'treeData', viewId, data: [] });
    }
  }, 150));
}

/**
 * Recursively resolve a level of the tree.
 *
 * @param {object} provider
 * @param {*} element - The parent element (undefined for root)
 * @param {number} depth
 * @returns {Promise<object[]>}
 */
async function _resolveTreeLevel(provider, element, depth) {
  const items = [];

  let children;
  try {
    children = await provider.getChildren(element);
  } catch (e) {
    logError(`getChildren failed at depth ${depth}: ${e.message}`);
    return items;
  }

  if (!children || !Array.isArray(children)) return items;

  for (let i = 0; i < Math.min(children.length, TREE_MAX_ITEMS_PER_LEVEL); i++) {
    const child = children[i];

    let treeItem;
    try {
      // getTreeItem may return a TreeItem or a Thenable<TreeItem>
      treeItem = await (typeof provider.getTreeItem === 'function'
        ? provider.getTreeItem(child)
        : child);
    } catch (e) {
      logError(`getTreeItem failed: ${e.message}`);
      continue;
    }

    if (!treeItem) continue;

    const item = _serializeTreeItem(treeItem, child);

    // Recurse into collapsible items
    if (item.collapsibleState > 0 && depth < TREE_MAX_DEPTH) {
      try {
        item.children = await _resolveTreeLevel(provider, child, depth + 1);
      } catch (_) {
        item.children = [];
      }
    }

    items.push(item);
  }

  return items;
}

/**
 * Serialize a VS Code TreeItem into a plain JSON-safe object.
 *
 * @param {object} treeItem - VS Code TreeItem
 * @param {*} element - The raw element from getChildren
 * @returns {object}
 */
function _serializeTreeItem(treeItem, element) {
  let label;
  if (typeof treeItem.label === 'string') {
    label = treeItem.label;
  } else if (treeItem.label && typeof treeItem.label === 'object') {
    // TreeItemLabel: { label: string, highlights?: [number, number][] }
    label = treeItem.label.label || '';
  } else if (treeItem.resourceUri) {
    // File-based items often use resourceUri instead of label
    const uri = treeItem.resourceUri;
    label = (uri.path || uri.fsPath || '').split('/').pop() || String(element);
  } else {
    label = String(element);
  }

  let iconPath;
  if (treeItem.iconPath) {
    if (typeof treeItem.iconPath === 'string') {
      iconPath = treeItem.iconPath;
    } else if (treeItem.iconPath.id) {
      // ThemeIcon
      iconPath = `codicon:${treeItem.iconPath.id}`;
    } else if (treeItem.iconPath.dark || treeItem.iconPath.light) {
      // { dark: Uri, light: Uri }
      iconPath = String(treeItem.iconPath.dark || treeItem.iconPath.light);
    }
  }

  let tooltip;
  if (typeof treeItem.tooltip === 'string') {
    tooltip = treeItem.tooltip;
  } else if (treeItem.tooltip && typeof treeItem.tooltip === 'object' && treeItem.tooltip.value) {
    // MarkdownString
    tooltip = treeItem.tooltip.value;
  }

  return {
    id: treeItem.id || (typeof element === 'string' ? element : `item-${Math.random().toString(36).slice(2)}`),
    label,
    description: treeItem.description || undefined,
    tooltip,
    iconPath,
    collapsibleState: treeItem.collapsibleState || 0,
    contextValue: treeItem.contextValue || undefined,
    command: treeItem.command ? {
      command: treeItem.command.command,
      title: treeItem.command.title,
      // Safe-serialize arguments: drop non-serializable values to prevent
      // JSON.stringify failures that would silently lose the entire tree
      arguments: _safeSerializeArgs(treeItem.command.arguments),
    } : undefined,
    children: [],
  };
}

// ============================================================================
// API Wrapping
// ============================================================================

/**
 * Wrap the real vscode API to observe UI registrations.
 * This MUTATES the real API object to add observation hooks.
 * The original functions are preserved and called normally.
 *
 * @param {object} vscode - The real vscode module exports
 */

/**
 * Safely assign a property on a potentially frozen/sealed object.
 * Falls back to Object.defineProperty when direct assignment throws.
 * Verifies the assignment actually took effect (sloppy mode silently
 * ignores writes to non-writable properties).
 *
 * @param {object} obj - Target object
 * @param {string} prop - Property name
 * @param {*} value - New value
 * @param {string} label - Human-readable label for logging
 * @returns {boolean} true if assignment succeeded
 */
function _safeAssign(obj, prop, value, label) {
  // Strategy 1: Object.defineProperty (most reliable — works even on
  // non-writable/non-configurable-in-sloppy-mode properties).
  try {
    Object.defineProperty(obj, prop, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    if (obj[prop] === value) return true;
  } catch (_) {}

  // Strategy 2: direct assignment
  try {
    obj[prop] = value;
    // Verify it actually took effect (sloppy mode silently ignores
    // writes to non-writable properties)
    if (obj[prop] === value) return true;
  } catch (_) {}

  // Strategy 3: delete + re-assign (handles inherited non-writable props)
  try {
    delete obj[prop];
    obj[prop] = value;
    if (obj[prop] === value) return true;
  } catch (_) {}

  // Strategy 4: defineProperty without enumerable (some internal objects
  // reject enumerable:true)
  try {
    Object.defineProperty(obj, prop, {
      value,
      writable: true,
      configurable: true,
    });
    if (obj[prop] === value) return true;
  } catch (_) {}

  log(`Could not assign ${label} — all strategies failed`);
  return false;
}

function wrapVSCodeAPI(vscode) {
  if (!vscode.window) {
    logError('vscode.window not found — cannot wrap');
    return false;
  }

  wrapRegisterTreeDataProvider(vscode);
  wrapCreateTreeView(vscode);
  wrapWebviewProviders(vscode);
  wrapCommands(vscode);
  wrapEnvOpenExternal(vscode);
  wrapEnvAsExternalUri(vscode);
  wrapClipboardWriteText(vscode);
  wrapAuthentication(vscode);
  wrapUriHandlers(vscode);

  log('All API wrappers installed successfully');
  return true;
}

// ============================================================================
// Wrap: env.openExternal
// ============================================================================

/**
 * Wrap vscode.env.openExternal so that URLs the extension wants to open
 * (e.g. OAuth sign-in pages) are forwarded to the browser via the bridge.
 * In headless code-server there is no desktop browser, so the call would
 * otherwise silently fail.
 */
function wrapEnvOpenExternal(vscode) {
  if (!vscode.env) {
    log('vscode.env not found — skipping openExternal wrap');
    return;
  }

  const original = vscode.env.openExternal;
  if (typeof original !== 'function') {
    log('vscode.env.openExternal is not a function — skipping wrap');
    return;
  }

  const wrappedOpenExternal = function wrappedOpenExternal(target) {
    // target is a vscode.Uri — extract the string representation
    const url = target?.toString?.() || String(target);
    log(`env.openExternal intercepted: ${url}`);

    // Forward to bridge for the browser to open
    bridgeSend({ type: 'openExternal', url });

    // Still call the original so code-server's own handler can run
    // (it may handle localhost callbacks for OAuth redirect URIs)
    return original.call(this, target);
  };

  if (!_safeAssign(vscode.env, 'openExternal', wrappedOpenExternal, 'env.openExternal')) {
    return;
  }

  log('env.openExternal wrapped');
}

// ============================================================================
// Wrap: authentication.getSession
// ============================================================================

/**
 * Wrap vscode.authentication.getSession so that when an extension requests a
 * session with { createIfNone: true }, we forward the auth request to the
 * browser via the bridge.  In headless code-server the main-thread stub
 * cannot orchestrate the full OAuth flow, so we intercept it here.
 */
function wrapAuthentication(vscode) {
  if (!vscode.authentication) {
    log('vscode.authentication not found — skipping auth wrap');
    return;
  }

  const originalGetSession = vscode.authentication.getSession;
  if (typeof originalGetSession !== 'function') {
    log('vscode.authentication.getSession is not a function — skipping');
    return;
  }

  const wrappedGetSession = function wrappedGetSession(providerId, scopes, options) {
    let effectiveOptions = options;

    const ageMs = Date.now() - (_lastBridgeCommand.ts || 0);
    const recentUserCommand = ageMs >= 0 && ageMs <= 20000;
    const requestedInteractive = !!(options && (options.createIfNone || options.forceNewSession));

    if (
      recentUserCommand
      && options
      && options.createIfNone === false
      && !options.forceNewSession
      && typeof providerId === 'string'
      && providerId.length > 0
    ) {
      // In headless mode, command handlers often do a passive session check
      // first (createIfNone:false). For user-initiated command flows that
      // should sign in, promote this to interactive session creation.
      effectiveOptions = { ...options, createIfNone: true };
      log(`authentication.getSession promoted to interactive: provider=${providerId} command=${_lastBridgeCommand.id || 'unknown'} ageMs=${ageMs}`);
    }

    const commandId = String(_lastBridgeCommand.id || '').toLowerCase();
    const explicitSignInCommand = recentUserCommand && (
      commandId.includes('sign-in')
      || commandId.includes('signin')
      || commandId.includes('login')
      || commandId.includes('auth')
    );

    if (
      explicitSignInCommand
      && String(providerId || '').toLowerCase() === 'github'
    ) {
      effectiveOptions = {
        ...(effectiveOptions || options || {}),
        createIfNone: true,
        forceNewSession: true,
      };
      log(`authentication.getSession forced new github session for explicit sign-in command=${_lastBridgeCommand.id || 'unknown'} ageMs=${ageMs}`);
    }

    if (
      (!recentUserCommand)
      && options
      && options.createIfNone === false
      && !options.forceNewSession
      && String(providerId || '').toLowerCase() === 'github'
    ) {
      const now = Date.now();
      const lastForced = _lastForcedInteractiveAuthAt.get('github') || 0;
      if (now - lastForced > 120000) {
        effectiveOptions = { ...options, createIfNone: true };
        _lastForcedInteractiveAuthAt.set('github', now);
        log(`authentication.getSession force-promoted (cooldown) for github`);
      }
    }

    log(`authentication.getSession intercepted: provider=${providerId} scopes=${JSON.stringify(scopes)} options=${JSON.stringify(effectiveOptions)}`);

    // Notify bridge of the authentication request so the frontend can
    // potentially show UI or handle device-code flow
    if (effectiveOptions && (effectiveOptions.createIfNone || effectiveOptions.forceNewSession || requestedInteractive)) {
      log(`Authentication request requires user interaction: provider=${providerId}`);
      bridgeSend({
        type: 'authSessionRequest',
        providerId,
        scopes: scopes || [],
        createIfNone: !!effectiveOptions.createIfNone,
        forceNewSession: !!effectiveOptions.forceNewSession,
      });
    }

    // Delegate to the real implementation — in code-server this will
    // attempt the built-in auth providers (GitHub, Microsoft, etc.)
    return originalGetSession.call(this, providerId, scopes, effectiveOptions);
  };

  if (!_safeAssign(vscode.authentication, 'getSession', wrappedGetSession, 'authentication.getSession')) {
    return;
  }

  // Also wrap onDidChangeSessions to track session changes
  const originalOnDidChange = vscode.authentication.onDidChangeSessions;
  if (typeof originalOnDidChange === 'function') {
    const wrappedOnDidChange = function wrappedOnDidChangeSessions(listener, thisArg, disposables) {
      const wrappedListener = function(e) {
        log(`onDidChangeSessions fired: provider=${e?.provider?.id || 'unknown'}`);
        if (e?.provider?.id) {
          _lastForcedInteractiveAuthAt.delete(String(e.provider.id).toLowerCase());
        }
        bridgeSend({ type: 'authSessionChanged', providerId: e?.provider?.id || 'unknown' });
        return listener.call(this, e);
      };
      return originalOnDidChange.call(this, wrappedListener, thisArg, disposables);
    };
    _safeAssign(vscode.authentication, 'onDidChangeSessions', wrappedOnDidChange, 'authentication.onDidChangeSessions');
  }

  log('authentication.getSession wrapped');
}

// ============================================================================
// Wrap: window.registerUriHandler
// ============================================================================

function wrapUriHandlers(vscode) {
  if (!vscode.window) return;

  const original = vscode.window.registerUriHandler;
  if (typeof original !== 'function') {
    log('window.registerUriHandler is not a function — skipping');
    return;
  }

  const wrappedRegisterUriHandler = function wrappedRegisterUriHandler(handler) {
    const extensionId = _inferExtensionId() || 'unknown';
    const key = extensionId;
    log(`registerUriHandler intercepted: ${extensionId}`);

    const disposable = original.call(this, handler);
    trackedUriHandlers.set(key, { handler, extensionId });
    bridgeSend({ type: 'uriHandlerRegistered', extensionId });

    if (pendingUriCallbacks.length > 0 && typeof handler?.handleUri === 'function') {
      const queued = pendingUriCallbacks.splice(0, pendingUriCallbacks.length);
      for (const rawUrl of queued) {
        try {
          const uri = typeof realVscodeApi?.Uri?.parse === 'function'
            ? realVscodeApi.Uri.parse(rawUrl)
            : rawUrl;
          const result = handler.handleUri(uri);
          if (result && typeof result.then === 'function') {
            result.catch(err => logError(`Queued URI callback rejected (${extensionId}): ${err.message}`));
          }
          bridgeSend({ type: 'uriCallbackResult', ok: true, delivered: 1, queued: true, url: rawUrl });
        } catch (e) {
          logError(`Queued URI callback failed (${extensionId}): ${e.message}`);
          bridgeSend({ type: 'uriCallbackResult', ok: false, reason: 'queued-uri-handler-failed', url: rawUrl });
        }
      }
    }

    const originalDispose = disposable?.dispose;
    if (typeof originalDispose === 'function') {
      disposable.dispose = function wrappedUriHandlerDispose() {
        trackedUriHandlers.delete(key);
        return originalDispose.call(this);
      };
    }

    return disposable;
  };

  if (_safeAssign(vscode.window, 'registerUriHandler', wrappedRegisterUriHandler, 'window.registerUriHandler')) {
    log('window.registerUriHandler wrapped');
  }
}

// ============================================================================
// Wrap: env.asExternalUri
// ============================================================================

/**
 * Wrap vscode.env.asExternalUri so that OAuth callback URI mappings are
 * intercepted and forwarded to the bridge.
 */
function wrapEnvAsExternalUri(vscode) {
  if (!vscode.env) return;

  const original = vscode.env.asExternalUri;
  if (typeof original !== 'function') {
    log('vscode.env.asExternalUri is not a function — skipping');
    return;
  }

  const wrappedAsExternalUri = function wrappedAsExternalUri(target) {
    const url = target?.toString?.() || String(target);
    log(`env.asExternalUri intercepted: ${url}`);
    bridgeSend({ type: 'asExternalUri', url });
    return original.call(this, target);
  };

  if (_safeAssign(vscode.env, 'asExternalUri', wrappedAsExternalUri, 'env.asExternalUri')) {
    log('env.asExternalUri wrapped');
  }
}

// ============================================================================
// Wrap: env.clipboard.writeText
// ============================================================================

/**
 * Wrap vscode.env.clipboard.writeText so that clipboard writes (e.g. device
 * codes for GitHub OAuth) are also forwarded through the bridge.  The RPC
 * handler already forwards $writeText, but this ensures the API-level call
 * is also captured.
 */
function wrapClipboardWriteText(vscode) {
  if (!vscode.env || !vscode.env.clipboard) {
    log('vscode.env.clipboard not found — skipping clipboard wrap');
    return;
  }

  const original = vscode.env.clipboard.writeText;
  if (typeof original !== 'function') {
    log('vscode.env.clipboard.writeText is not a function — skipping');
    return;
  }

  const wrappedWriteText = function wrappedWriteText(text) {
    log(`clipboard.writeText intercepted: ${String(text).slice(0, 50)}`);
    bridgeSend({ type: 'clipboardWrite', text: String(text) });
    return original.call(this, text);
  };

  if (_safeAssign(vscode.env.clipboard, 'writeText', wrappedWriteText, 'clipboard.writeText')) {
    log('clipboard.writeText wrapped');
  }
}

// ============================================================================
// Wrap: window.registerTreeDataProvider
// ============================================================================

/**
 * Wrap vscode.window.registerTreeDataProvider to observe tree registrations
 * and forward data to the bridge.
 *
 * @param {object} vscode
 */
function wrapRegisterTreeDataProvider(vscode) {
  const original = vscode.window.registerTreeDataProvider;
  if (!original) {
    log('registerTreeDataProvider not found (VS Code version too old?)');
    return;
  }

  const wrappedRegisterTreeDataProvider = function wrappedRegisterTreeDataProvider(viewId, provider) {
    log(`registerTreeDataProvider intercepted: ${viewId}`);

    // Call the real API — this is the genuine registration
    const disposable = original.call(this, viewId, provider);

    // Track the provider for data extraction
    const extensionId = _inferExtensionId();
    trackedTreeProviders.set(viewId, { provider, extensionId });

    // Notify bridge of the registration
    bridgeSend({ type: 'treeProvider', viewId, extensionId });

    // Immediately notify bridge of updated provider list
    _sendProviderListUpdate();

    // Subscribe to provider's change events to re-resolve data
    if (provider.onDidChangeTreeData) {
      try {
        const changeDisposable = provider.onDidChangeTreeData((element) => {
          log(`Tree data changed for ${viewId}`);
          resolveAndSendTreeData(viewId, provider);
        });
        // Chain disposal
        const originalDispose = disposable.dispose.bind(disposable);
        disposable.dispose = function () {
          trackedTreeProviders.delete(viewId);
          try { changeDisposable.dispose(); } catch (_) {}
          return originalDispose();
        };
      } catch (e) {
        logError(`Failed to subscribe to onDidChangeTreeData for ${viewId}: ${e.message}`);
      }
    }

    // Initial data resolution after a tick (let extension finish init)
    setTimeout(() => resolveAndSendTreeData(viewId, provider), 200);

    return disposable;
  };

  if (!_safeAssign(vscode.window, 'registerTreeDataProvider', wrappedRegisterTreeDataProvider, 'window.registerTreeDataProvider')) {
    return;
  }
  log('registerTreeDataProvider wrapped');
}

// ============================================================================
// Wrap: window.createTreeView
// ============================================================================

/**
 * Wrap vscode.window.createTreeView to observe tree view creation.
 * createTreeView is an alternative to registerTreeDataProvider that returns
 * a TreeView object with additional control methods (reveal, etc.).
 *
 * @param {object} vscode
 */
function wrapCreateTreeView(vscode) {
  const original = vscode.window.createTreeView;
  if (!original) {
    log('createTreeView not found (VS Code version too old?)');
    return;
  }

  const wrappedCreateTreeView = function wrappedCreateTreeView(viewId, options) {
    log(`createTreeView intercepted: ${viewId}`);

    // Call the real API
    const treeView = original.call(this, viewId, options);

    // Track the provider if one was given
    const provider = options?.treeDataProvider;
    if (provider) {
      const extensionId = _inferExtensionId();
      trackedTreeProviders.set(viewId, { provider, extensionId });

      // Notify bridge
      bridgeSend({ type: 'treeProvider', viewId, extensionId });

      // Immediately notify bridge of updated provider list
      _sendProviderListUpdate();

      // Subscribe to provider's change events
      if (provider.onDidChangeTreeData) {
        try {
          const changeDisposable = provider.onDidChangeTreeData((element) => {
            log(`Tree data changed (createTreeView) for ${viewId}`);
            resolveAndSendTreeData(viewId, provider);
          });

          // Chain disposal
          const originalDispose = treeView.dispose.bind(treeView);
          treeView.dispose = function () {
            trackedTreeProviders.delete(viewId);
            try { changeDisposable.dispose(); } catch (_) {}
            return originalDispose();
          };
        } catch (e) {
          logError(`Failed to subscribe to onDidChangeTreeData for ${viewId}: ${e.message}`);
        }
      }

      // Initial data resolution
      setTimeout(() => resolveAndSendTreeData(viewId, provider), 200);
    }

    return treeView;
  };

  if (!_safeAssign(vscode.window, 'createTreeView', wrappedCreateTreeView, 'window.createTreeView')) {
    return;
  }
  log('createTreeView wrapped');
}

// ============================================================================
// Wrap: window.registerWebviewViewProvider
// ============================================================================

/**
 * Wrap vscode.window.registerWebviewViewProvider to observe webview
 * registrations and intercept HTML content updates.
 *
 * @param {object} vscode
 */
function wrapWebviewProviders(vscode) {
  // ── registerWebviewViewProvider (sidebar/panel webviews) ──
  const origRegisterWVP = vscode.window.registerWebviewViewProvider;
  if (origRegisterWVP) {
    const wrappedRegisterWebviewViewProvider = function wrappedRegisterWebviewViewProvider(viewType, provider, options) {
      log(`registerWebviewViewProvider intercepted: ${viewType}`);

      // Notify bridge immediately at registration time (not deferred to
      // resolveWebviewView) so the browser knows this view exists even
      // when code-server runs headless and never opens the sidebar.
      const extensionId = _inferExtensionId();
      bridgeSend({ type: 'webviewProvider', viewType, extensionId });

      // Track the provider at registration time so we can call
      // resolveWebviewView on demand from the bridge
      trackedWebviewProviders.set(viewType, { provider, webviewView: null, extensionId });

      // Wrap the provider's resolveWebviewView to intercept the webview object
      const wrappedProvider = Object.create(provider);
      wrappedProvider.resolveWebviewView = function (webviewView, context, token) {
        // Intercept the webview's html property setter
        _interceptWebviewHtml(webviewView.webview, viewType);

        // Update tracking with the resolved webviewView
        trackedWebviewProviders.set(viewType, { provider, webviewView, extensionId });

        // Call original resolveWebviewView
        return provider.resolveWebviewView.call(provider, webviewView, context, token);
      };

      // Call the real API with our wrapped provider
      const disposable = origRegisterWVP.call(this, viewType, wrappedProvider, options);

      // Chain disposal
      const originalDispose = disposable.dispose.bind(disposable);
      disposable.dispose = function () {
        trackedWebviewProviders.delete(viewType);
        bridgeSend({ type: 'webviewDisposed', viewType });
        return originalDispose();
      };

      // Immediately notify bridge of updated provider list
      _sendProviderListUpdate();

      // Auto-resolve in headless mode: code-server never opens sidebar
      // views, so resolveWebviewView is never called naturally.  Trigger
      // it ourselves after a short delay to let the extension finish init.
      setTimeout(() => {
        _resolveWebviewViewHeadless(viewType);
      }, 500);

      return disposable;
    };
    if (_safeAssign(vscode.window, 'registerWebviewViewProvider', wrappedRegisterWebviewViewProvider, 'window.registerWebviewViewProvider')) {
      log('registerWebviewViewProvider wrapped');
    }
  }

  // ── createWebviewPanel (editor/floating webview panels) ──
  const origCreateWP = vscode.window.createWebviewPanel;
  if (origCreateWP) {
    const wrappedCreateWebviewPanel = function wrappedCreateWebviewPanel(viewType, title, showOptions, options) {
      log(`createWebviewPanel intercepted: ${viewType} "${title}"`);

      // Call the real API
      const panel = origCreateWP.call(this, viewType, title, showOptions, options);

      const viewId = `panel-${viewType}-${Date.now()}`;

      // Intercept webview HTML
      _interceptWebviewHtml(panel.webview, viewId);

      // Notify bridge
      const extensionId = _inferExtensionId();
      bridgeSend({ type: 'webviewPanel', viewId, viewType, title, extensionId });

      // Track disposal
      panel.onDidDispose(() => {
        bridgeSend({ type: 'webviewDisposed', viewId });
      });

      return panel;
    };
    if (_safeAssign(vscode.window, 'createWebviewPanel', wrappedCreateWebviewPanel, 'window.createWebviewPanel')) {
      log('createWebviewPanel wrapped');
    }
  }
}

/**
 * Create a mock Webview object that mimics VS Code's Webview interface.
 * Used for headless resolution of webview view providers.
 *
 * @param {string} viewType - The view identifier
 * @returns {object} A mock webview with html property, messaging, etc.
 */
function _createMockWebview(viewType) {
  const _onDidReceiveMessage = { event: () => ({ dispose() {} }), fire: () => {} };
  const _onDidDispose = { event: () => ({ dispose() {} }), fire: () => {} };

  const webview = {
    _html: '',
    options: {},
    cspSource: '',
    onDidReceiveMessage: _onDidReceiveMessage.event,
    onDidDispose: _onDidDispose.event,
    asWebviewUri(uri) {
      // code-server rewrites URIs anyway, return as-is
      return uri;
    },
    postMessage(message) {
      // Extensions call this to send messages to the webview.
      // In headless mode we can bridge this later if needed.
      log(`Mock webview postMessage for ${viewType}: ${JSON.stringify(message).slice(0, 200)}`);
      return Promise.resolve(true);
    },
  };

  // Define html as a simple getter/setter so _interceptWebviewHtml can wrap it
  Object.defineProperty(webview, 'html', {
    get() { return webview._html; },
    set(value) { webview._html = value; },
    configurable: true,
    enumerable: true,
  });

  return webview;
}

/**
 * Intercept a Webview object's `html` property setter to observe changes.
 * VS Code's webview.html is already a getter/setter, so we need to work
 * with the existing property descriptor.
 *
 * @param {object} webview - The vscode.Webview object
 * @param {string} viewId - The view identifier for bridge messages
 */
function _interceptWebviewHtml(webview, viewId) {
  try {
    // Get the existing property descriptor (might be on prototype)
    let descriptor = null;
    let obj = webview;
    while (obj && !descriptor) {
      descriptor = Object.getOwnPropertyDescriptor(obj, 'html');
      if (!descriptor) obj = Object.getPrototypeOf(obj);
    }

    if (descriptor && descriptor.set) {
      // Property has a setter — wrap it
      const originalSet = descriptor.set;
      const originalGet = descriptor.get;

      Object.defineProperty(webview, 'html', {
        get: originalGet ? function () { return originalGet.call(this); } : function () { return this._synthiHtml || ''; },
        set: function (value) {
          originalSet.call(this, value);
          // Send the HTML content to bridge
          bridgeSend({ type: 'webviewHtml', viewType: viewId, html: value });
        },
        configurable: true,
        enumerable: true,
      });
    } else {
      // Simple property — use defineProperty with a backing store
      let _html = webview.html || '';
      Object.defineProperty(webview, 'html', {
        get() { return _html; },
        set(value) {
          _html = value;
          bridgeSend({ type: 'webviewHtml', viewType: viewId, html: value });
        },
        configurable: true,
        enumerable: true,
      });
    }
  } catch (e) {
    logError(`Failed to intercept webview.html for ${viewId}: ${e.message}`);
  }
}

// ============================================================================
// Wrap: commands.registerCommand
// ============================================================================

/**
 * Wrap vscode.commands.registerCommand to observe command registrations.
 * Uses multiple strategies since vscode.commands may resist property assignment.
 *
 * @param {object} vscode
 */
function wrapCommands(vscode) {
  if (!vscode.commands?.registerCommand) {
    log('commands.registerCommand not found');
    return;
  }

  const original = vscode.commands.registerCommand;

  /**
   * The core wrapping logic: call the real registerCommand AND store handler.
   */
  function interceptedRegisterCommand(commandId, callback, thisArg) {
    // Call the real API
    const disposable = original.call(vscode.commands, commandId, callback, thisArg);

    // Store the handler so we can call it directly from the bridge.
    if (typeof callback === 'function') {
      trackedCommandHandlers.set(commandId, { callback, thisArg });
      log(`Command handler stored: ${commandId}`);
    }

    // Notify bridge of command registration
    bridgeSend({ type: 'command', commandId, extensionId: _inferExtensionId() });

    // Clean up on dispose
    const origDispose = disposable?.dispose;
    if (origDispose) {
      disposable.dispose = function() {
        trackedCommandHandlers.delete(commandId);
        return origDispose.call(this);
      };
    }

    return disposable;
  }

  // Strategy 1: _safeAssign (works if property is writable/configurable)
  const assigned = _safeAssign(vscode.commands, 'registerCommand', interceptedRegisterCommand, 'commands.registerCommand');

  if (assigned) {
    log('commands.registerCommand wrapped via property assignment');
  } else {
    log('commands.registerCommand: property assignment failed, trying Proxy');
  }

  // Strategy 2: Replace vscode.commands with a Proxy that intercepts
  // registerCommand calls.  This works even when the commands object
  // uses getters or is a Proxy itself.
  // We always install this as a safety net since Strategy 1 may have
  // silently failed (property set appears to succeed but getter still
  // returns the original — e.g. Proxy-backed namespace objects).
  try {
    const commandsTarget = vscode.commands;
    const commandsProxy = new Proxy(commandsTarget, {
      get(target, prop, receiver) {
        if (prop === 'registerCommand') {
          return interceptedRegisterCommand;
        }
        const val = Reflect.get(target, prop, receiver);
        // Bind functions to preserve `this` context
        if (typeof val === 'function') {
          return val.bind(target);
        }
        return val;
      }
    });

    // Replace vscode.commands with our proxy
    if (_safeAssign(vscode, 'commands', commandsProxy, 'vscode.commands (proxy)')) {
      log('vscode.commands replaced with Proxy for registerCommand interception');
    } else {
      log('vscode.commands Proxy replacement also failed — commands may not be tracked');
    }
  } catch (e) {
    logError(`Proxy creation for vscode.commands failed: ${e.message}`);
  }
}

// ============================================================================
// Provider List Notification + Headless Webview Resolution
// ============================================================================

/**
 * Send an updated provider list to the bridge immediately.
 * Called whenever a new provider is registered so the browser
 * doesn't have to wait for a periodic poll.
 */
function _sendProviderListUpdate() {
  const treeViews = Array.from(trackedTreeProviders.keys());
  const webviews = Array.from(trackedWebviewProviders.keys());
  log(`Provider list updated: ${treeViews.length} trees, ${webviews.length} webviews`);
  bridgeSend({ type: 'providerList', treeViews, webviews });
}

/**
 * Resolve a webview view provider headlessly.  In code-server running
 * without a visible sidebar, resolveWebviewView is never called by
 * VS Code.  We create a mock WebviewView and call the provider ourselves
 * so the extension generates its HTML which we relay to the browser.
 *
 * @param {string} viewType - The view identifier to resolve
 */
function _resolveWebviewViewHeadless(viewType) {
  const entry = trackedWebviewProviders.get(viewType);
  if (!entry || !entry.provider) {
    if (!_missingWebviewProviderLogged.has(viewType)) {
      _missingWebviewProviderLogged.add(viewType);
      log(`Cannot resolve webview headlessly: no provider for ${viewType}`);
    }
    return;
  }

  // Provider now exists; clear missing marker so future genuine regressions
  // can be logged again if the provider disappears.
  _missingWebviewProviderLogged.delete(viewType);

  // If already resolved, re-send the HTML
  if (entry.webviewView && entry.webviewView.webview) {
    const html = entry.webviewView.webview.html;
    if (html) {
      log(`Re-sending existing HTML for ${viewType} (${html.length} chars)`);
      bridgeSend({ type: 'webviewHtml', viewType, html });
    }
    return;
  }

  log(`Auto-resolving webview view headlessly: ${viewType}`);

  try {
    const mockWebview = _createMockWebview(viewType);
    const mockWebviewView = {
      webview: mockWebview,
      viewType,
      visible: true,
      onDidChangeVisibility: { event: () => ({ dispose() {} }) },
      onDidDispose: { event: () => ({ dispose() {} }) },
      show: () => {},
      title: undefined,
      description: undefined,
      badge: undefined,
    };

    // Intercept HTML before calling resolve
    _interceptWebviewHtml(mockWebview, viewType);

    // Update tracking
    trackedWebviewProviders.set(viewType, { ...entry, webviewView: mockWebviewView });

    // Call the provider's resolveWebviewView
    const result = entry.provider.resolveWebviewView(
      mockWebviewView,
      {},
      { isCancellationRequested: false, onCancellationRequested: { event: () => ({ dispose() {} }) } }
    );

    if (result && typeof result.then === 'function') {
      result.then(() => {
        log(`Webview view ${viewType} auto-resolved (async)`);
      }).catch((err) => {
        logError(`Auto-resolveWebviewView failed for ${viewType}: ${err.message}`);
      });
    } else {
      log(`Webview view ${viewType} auto-resolved (sync)`);
    }
  } catch (e) {
    logError(`Auto-resolveWebviewView error for ${viewType}: ${e.message}`);
  }
}

function _invokeTrackedCommand(commandId, cmdArgs) {
  const tracked = trackedCommandHandlers.get(commandId);
  if (!tracked) return false;

  log(`Calling stored handler directly for: ${commandId}`);
  try {
    const result = tracked.callback.apply(tracked.thisArg, cmdArgs || []);
    if (result && typeof result.then === 'function') {
      result.then(
        () => log(`Command ${commandId} completed successfully`),
        (err) => logError(`Command ${commandId} rejected: ${err.message}`)
      );
    } else {
      log(`Command ${commandId} executed (sync)`);
    }
  } catch (e) {
    logError(`Command ${commandId} handler threw: ${e.message}`);
  }

  return true;
}

function _generateCommandVariants(commandId) {
  const value = String(commandId || '');
  if (!value) return [];

  const variants = new Set([value]);
  variants.add(value.replace(/NoEnterprise$/i, ''));
  variants.add(value.replace(/\.sign-?in$/i, '.login'));
  variants.add(value.replace(/\.login$/i, '.signin'));

  return Array.from(variants).filter(Boolean);
}

function _tokenizeCommandId(commandId) {
  if (!commandId || typeof commandId !== 'string') return [];
  return commandId
    .split(/[^a-zA-Z0-9]+/)
    .map(t => t.trim().toLowerCase())
    .filter(Boolean);
}

function _normalizeCommandText(commandId) {
  return String(commandId || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '');
}

function _isAuthLikeCommand(commandId) {
  const lower = String(commandId || '').toLowerCase();
  return lower.includes('signin')
    || lower.includes('sign-in')
    || lower.includes('login')
    || lower.includes('auth')
    || lower.includes('session');
}

function _commandPrefix(commandId) {
  const value = String(commandId || '').toLowerCase();
  return value.includes('.') ? value.split('.')[0] : value;
}

function _tokenOverlapCount(a, b) {
  const aTokens = new Set(_tokenizeCommandId(a));
  const bTokens = new Set(_tokenizeCommandId(b));
  let overlap = 0;
  for (const token of aTokens) {
    if (bTokens.has(token)) overlap++;
  }
  return overlap;
}

function _scoreCommandAlias(queryId, candidateId) {
  if (!queryId || !candidateId) return -1;
  if (queryId === candidateId) return 1e9;

  const qLower = String(queryId).toLowerCase();
  const cLower = String(candidateId).toLowerCase();
  const qPrefix = queryId.includes('.') ? queryId.split('.')[0].toLowerCase() : '';
  const cPrefix = candidateId.includes('.') ? candidateId.split('.')[0].toLowerCase() : '';

  const qTokens = new Set(_tokenizeCommandId(queryId));
  const cTokens = new Set(_tokenizeCommandId(candidateId));

  let overlap = 0;
  for (const token of qTokens) {
    if (cTokens.has(token)) overlap++;
  }

  let score = overlap * 100;
  if (qPrefix && cPrefix && qPrefix === cPrefix) score += 350;
  if (qPrefix && cPrefix && qPrefix !== cPrefix) {
    // Prefer same-prefix command families and avoid cross-extension jumps.
    score -= 140;

    // Explicitly block common false-positive: pr.* -> prisma.*
    if ((qPrefix === 'pr' && cPrefix === 'prisma') || (qPrefix === 'prisma' && cPrefix === 'pr')) {
      score -= 500;
    }
  }
  if (candidateId.toLowerCase().includes(queryId.toLowerCase())) score += 250;
  if (queryId.toLowerCase().includes(candidateId.toLowerCase())) score += 100;

  const qNorm = _normalizeCommandText(queryId);
  const cNorm = _normalizeCommandText(candidateId);
  if (qNorm && cNorm) {
    if (cNorm.includes(qNorm)) score += 220;
    if (qNorm.includes(cNorm)) score += 120;
  }

  const querySignInLike = qLower.includes('signin') || qLower.includes('sign-in') || qLower.includes('login');
  const candidateSignInLike = cLower.includes('signin') || cLower.includes('sign-in') || cLower.includes('login');
  if (querySignInLike && candidateSignInLike) {
    score += 300;
  }

  // Give extra weight to auth-ish token alignment but keep generic scoring.
  const authLike = ['signin', 'login', 'auth', 'session', 'credential'];
  for (const token of authLike) {
    if (qTokens.has(token) && cTokens.has(token)) score += 90;
  }

  return score;
}

function _findBestTrackedAlias(commandId) {
  if (!commandId) return null;
  const keys = Array.from(trackedCommandHandlers.keys());
  if (keys.length === 0) return null;

  const queryPrefix = _commandPrefix(commandId);
  const queryAuthLike = _isAuthLikeCommand(commandId);

  let bestId = null;
  let bestScore = 0;
  for (const candidate of keys) {
    const score = _scoreCommandAlias(commandId, candidate);
    const candidatePrefix = _commandPrefix(candidate);

    // Keep short-prefix commands inside their family to avoid collisions
    // like pr.* mistakenly aliasing to prisma.*.
    if (
      queryPrefix
      && queryPrefix.length <= 3
      && candidatePrefix
      && candidatePrefix !== queryPrefix
      && !queryAuthLike
    ) {
      continue;
    }

    if (score > bestScore) {
      bestScore = score;
      bestId = candidate;
    }
  }

  // Require a meaningful match threshold to avoid random aliases.
  if (bestId && bestScore >= 200) {
    return { commandId: bestId, score: bestScore };
  }
  return null;
}

function _topTrackedCandidates(commandId, limit = 5) {
  const keys = Array.from(trackedCommandHandlers.keys());
  return keys
    .map((candidate) => ({
      commandId: candidate,
      score: _scoreCommandAlias(commandId, candidate),
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

function _findBestKnownAlias(commandId, knownCommands) {
  if (!commandId || !Array.isArray(knownCommands) || knownCommands.length === 0) return null;

  let best = null;
  let bestScore = 0;
  const queryPrefix = _commandPrefix(commandId);
  const queryAuthLike = _isAuthLikeCommand(commandId);
  for (const candidate of knownCommands) {
    if (typeof candidate !== 'string') continue;
    const candidatePrefix = _commandPrefix(candidate);

    if (
      queryPrefix
      && queryPrefix.length <= 3
      && candidatePrefix
      && candidatePrefix !== queryPrefix
      && !queryAuthLike
    ) {
      continue;
    }

    const score = _scoreCommandAlias(commandId, candidate);
    if (score > bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  if (best && bestScore >= 220) {
    return { commandId: best, score: bestScore };
  }
  return null;
}

async function _getKnownCommandsSnapshot(commandId) {
  try {
    const getter = realVscodeApi?.commands?.getCommands;
    if (typeof getter !== 'function') return [];
    const all = await getter.call(realVscodeApi.commands, true);
    if (!Array.isArray(all)) return [];

    const queryPrefix = _commandPrefix(commandId);
    const queryAuthLike = _isAuthLikeCommand(commandId);
    return all
      .filter(id => typeof id === 'string')
      .filter(id => {
        const candidatePrefix = _commandPrefix(id);
        if (queryPrefix && candidatePrefix && candidatePrefix === queryPrefix) {
          return true;
        }
        if (queryAuthLike && _isAuthLikeCommand(id)) {
          return true;
        }
        return _tokenOverlapCount(commandId, id) > 0;
      })
      .slice(0, 120);
  } catch (_) {
    return [];
  }
}

function _findExtensionsContributingCommand(commandId) {
  const out = [];
  const all = realVscodeApi?.extensions?.all;
  if (!Array.isArray(all) || !commandId) return out;

  for (const ext of all) {
    try {
      const commands = ext?.packageJSON?.contributes?.commands;
      if (!Array.isArray(commands)) continue;

      const matched = commands.some((entry) => {
        if (typeof entry === 'string') return entry === commandId;
        return entry && entry.command === commandId;
      });

      if (matched) out.push(ext);
    } catch (_) {}
  }

  return out;
}

function _findExtensionsByCommandPrefix(commandId) {
  const out = [];
  const all = realVscodeApi?.extensions?.all;
  if (!Array.isArray(all) || !commandId || typeof commandId !== 'string') return out;

  const prefix = commandId.includes('.') ? commandId.split('.')[0] : commandId;
  const lowered = prefix.toLowerCase();

  for (const ext of all) {
    try {
      const id = String(ext?.id || '').toLowerCase();
      const name = String(ext?.packageJSON?.name || '').toLowerCase();
      const publisher = String(ext?.packageJSON?.publisher || '').toLowerCase();
      if (id.includes(lowered) || name.includes(lowered) || publisher.includes(lowered)) {
        out.push(ext);
      }
    } catch (_) {}
  }

  return out;
}

async function _activateExtensionsForCommand(commandId) {
  if (!commandId) return { activated: 0, total: 0 };

  if (_commandActivationAttempts.has(commandId)) {
    return { activated: 0, total: 0 };
  }
  _commandActivationAttempts.add(commandId);

  let targets = _findExtensionsContributingCommand(commandId);

  // Fallback 1: heuristic prefix matching (e.g. pr.* → GitHub PR extension)
  if (targets.length === 0) {
    targets = _findExtensionsByCommandPrefix(commandId);
  }

  // Fallback 2: one-time broad activation of all inactive extensions.
  // Some commands are registered dynamically and not declared in manifests.
  if (targets.length === 0 && !_broadCommandActivationAttempted) {
    _broadCommandActivationAttempted = true;
    const all = Array.isArray(realVscodeApi?.extensions?.all) ? realVscodeApi.extensions.all : [];
    const inactive = all.filter(ext => ext && !ext.isActive);
    if (inactive.length > 0) {
      log(`No manifest/prefix match for ${commandId}; broad activation of ${inactive.length} inactive extension(s)`);
      targets = inactive;
    }
  }

  if (targets.length === 0) {
    return { activated: 0, total: 0 };
  }

  let activated = 0;
  for (const ext of targets) {
    try {
      if (!ext.isActive) {
        log(`Activating extension for command ${commandId}: ${ext.id}`);
        await ext.activate();
      }
      activated++;
    } catch (e) {
      logError(`Extension activation failed for ${ext?.id || 'unknown'} (${commandId}): ${e.message}`);
    }
  }

  return { activated, total: targets.length };
}

// ============================================================================
// Bridge Request Handler (incoming from vscode-server-manager)
// ============================================================================

/**
 * Handle a request from the vscode-server-manager.
 * Supports:
 *   - refreshTreeData: re-resolve and send tree data for a viewId
 *   - listProviders: list all tracked tree/webview providers
 *   - refreshAllTrees: re-resolve all tracked tree providers
 *
 * @param {object} msg
 */
function _handleBridgeRequest(msg) {
  if (!msg || typeof msg !== 'object') return;

  switch (msg.action) {
    case 'refreshTreeData': {
      const { viewId } = msg;
      const entry = trackedTreeProviders.get(viewId);
      if (entry && entry.provider) {
        log(`Bridge requested tree refresh for ${viewId}`);
        resolveAndSendTreeData(viewId, entry.provider);
      } else {
        logError(`No tracked provider for tree refresh: ${viewId}`);
      }
      break;
    }

    case 'refreshAllTrees': {
      log(`Bridge requested refresh of all ${trackedTreeProviders.size} tree providers`);
      for (const [viewId, entry] of trackedTreeProviders) {
        if (entry.provider) {
          resolveAndSendTreeData(viewId, entry.provider);
        }
      }
      break;
    }

    case 'listProviders': {
      const treeViews = Array.from(trackedTreeProviders.keys());
      const webviews = Array.from(trackedWebviewProviders.keys());
      log(`Bridge requested provider list: ${treeViews.length} trees, ${webviews.length} webviews`);
      bridgeSend({
        type: 'providerList',
        treeViews,
        webviews,
      });
      break;
    }

    case 'resolveWebviewView': {
      // Resolve a webview view on demand — delegate to the shared function
      const { viewType } = msg;
      _resolveWebviewViewHeadless(viewType);
      break;
    }

    case 'authSessionEstablished': {
      // Manager notifies us that an auth session was established (e.g.
      // device flow completed). Clear forced-interactive bookkeeping so
      // subsequent getSession calls use the cached session instead of
      // re-triggering the device flow.
      const { providerId, accountLabel } = msg;
      const pid = String(providerId || '').toLowerCase();
      log(`Auth session established from bridge: provider=${pid} account=${accountLabel || 'unknown'}`);
      _lastForcedInteractiveAuthAt.delete(pid);
      _knownAuthSessionAt.set(pid, Date.now());
      // Clear stale bridge command context so auth wrapper stops
      // promoting getSession calls to interactive
      if (_lastBridgeCommand.id && _lastBridgeCommand.ts > 0) {
        const ageMs = Date.now() - _lastBridgeCommand.ts;
        if (ageMs < 30000) {
          _lastBridgeCommand.ts = 0;
          _lastBridgeCommand.id = null;
        }
      }
      break;
    }

    case 'executeCommand': {
      // Execute a command by directly calling its stored handler.
      // We can't rely on vscode.commands.executeCommand() because the EH
      // command service often doesn't find locally-registered commands and
      // delegates to the main thread (which we stub), causing a no-op loop.
      const { commandId, args: cmdArgs } = msg;
      const variants = _generateCommandVariants(commandId);
      const effectiveCommandId = variants[0] || commandId;
      const envelopeKey = JSON.stringify({ commandId: effectiveCommandId, args: Array.isArray(cmdArgs) ? cmdArgs : [] });
      const now = Date.now();
      if (
        _lastExecuteCommandEnvelope.key === envelopeKey
        && (now - _lastExecuteCommandEnvelope.ts) < 1200
      ) {
        log(`Skipping duplicate command envelope: ${effectiveCommandId}`);
        break;
      }
      _lastExecuteCommandEnvelope.key = envelopeKey;
      _lastExecuteCommandEnvelope.ts = now;

      log(`Bridge requested command execution: ${effectiveCommandId}`);

      // Mark recent user-triggered command context so auth wrapper can
      // distinguish passive background checks from explicit user actions.
      _lastBridgeCommand.id = effectiveCommandId || null;
      _lastBridgeCommand.ts = Date.now();

      for (const variant of variants) {
        if (_invokeTrackedCommand(variant, cmdArgs)) {
          return;
        }
      }

      // 1b. Generic alias fallback: resolve to closest tracked command.
      // Useful when welcome-content buttons reference legacy/variant IDs.
      const alias = _findBestTrackedAlias(effectiveCommandId);
      if (alias) {
        log(`No direct handler for ${effectiveCommandId}; trying alias ${alias.commandId} (score=${alias.score})`);
        if (_invokeTrackedCommand(alias.commandId, cmdArgs)) {
          return;
        }
      }

      (async () => {
        // 2. Activate contributing extension(s) on demand, then retry.
        const activation = await _activateExtensionsForCommand(effectiveCommandId);
        if (activation.total > 0) {
          log(`Activation attempt for ${effectiveCommandId}: ${activation.activated}/${activation.total} extension(s)`);
          if (_invokeTrackedCommand(effectiveCommandId, cmdArgs)) {
            return;
          }

          const aliasAfterActivation = _findBestTrackedAlias(effectiveCommandId);
          if (aliasAfterActivation) {
            log(`Post-activation alias for ${effectiveCommandId}: ${aliasAfterActivation.commandId} (score=${aliasAfterActivation.score})`);
            if (_invokeTrackedCommand(aliasAfterActivation.commandId, cmdArgs)) {
              return;
            }
          }

          const knownCommands = await _getKnownCommandsSnapshot(effectiveCommandId);
          const knownAlias = _findBestKnownAlias(effectiveCommandId, knownCommands);
          if (knownAlias && realVscodeApi?.commands?.executeCommand) {
            log(`Trying known-command alias for ${effectiveCommandId}: ${knownAlias.commandId} (score=${knownAlias.score})`);
            try {
              await realVscodeApi.commands.executeCommand(knownAlias.commandId, ...(cmdArgs || []));
              log(`Known-command alias executed: ${knownAlias.commandId}`);
              return;
            } catch (e) {
              logError(`Known-command alias failed ${knownAlias.commandId}: ${e.message}`);
            }
          }

          const candidates = _topTrackedCandidates(effectiveCommandId, 5);
          logError(`No tracked handler for ${effectiveCommandId} after activation retry`);
          bridgeSend({
            type: 'commandExecutionFailed',
            commandId: effectiveCommandId,
            reason: 'no-tracked-handler-after-activation',
            trackedHandlers: trackedCommandHandlers.size,
            candidates,
            knownCommands,
          });
          return;
        }

        // 3. Fallback to vscode API for non-contributed/built-in commands.
        if (realVscodeApi?.commands?.executeCommand) {
          const knownCommands = await _getKnownCommandsSnapshot(effectiveCommandId);
          const knownAlias = _findBestKnownAlias(effectiveCommandId, knownCommands);

          if (knownAlias && knownAlias.commandId !== effectiveCommandId) {
            log(`No stored handler for ${effectiveCommandId}; using known-command alias ${knownAlias.commandId} (score=${knownAlias.score})`);
            try {
              await realVscodeApi.commands.executeCommand(knownAlias.commandId, ...(cmdArgs || []));
              log(`Command ${effectiveCommandId} executed via known alias ${knownAlias.commandId}`);
              return;
            } catch (e) {
              logError(`Known alias execution failed for ${effectiveCommandId} -> ${knownAlias.commandId}: ${e.message}`);
            }
          }

          log(`No stored handler for ${effectiveCommandId}, falling back to vscode API`);
          try {
            realVscodeApi.commands.executeCommand(effectiveCommandId, ...(cmdArgs || []))
              .then(() => log(`Command ${effectiveCommandId} executed via API`),
                (err) => logError(`Command ${effectiveCommandId} API call failed: ${err.message}`));
          } catch (e) {
            logError(`Command ${effectiveCommandId} API error: ${e.message}`);
          }
        } else {
          logError(`Cannot execute ${effectiveCommandId}: no handler and no vscode API`);
          bridgeSend({
            type: 'commandExecutionFailed',
            commandId: effectiveCommandId,
            reason: 'no-handler-and-no-vscode-api',
            trackedHandlers: trackedCommandHandlers.size,
            candidates: _topTrackedCandidates(effectiveCommandId, 5),
            knownCommands: [],
          });
        }
      })().catch((e) => {
        logError(`executeCommand async flow failed for ${effectiveCommandId}: ${e.message}`);
      });
      break;
    }

    case 'deliverUriCallback': {
      const rawUrl = String(msg?.url || '');
      const uriComponents = msg?.uriComponents;
      if (!rawUrl) {
        logError('deliverUriCallback: missing url');
        break;
      }

      if (trackedUriHandlers.size === 0) {
        pendingUriCallbacks.push(rawUrl);
        log(`deliverUriCallback: queued (no handlers yet) ${rawUrl}`);
        bridgeSend({ type: 'uriCallbackResult', ok: false, queued: true, reason: 'queued-no-uri-handler', url: rawUrl });
        break;
      }

      let uriArg = rawUrl;
      try {
        const uriApi = realVscodeApi?.Uri;
        if (uriComponents && typeof uriApi?.from === 'function') {
          uriArg = uriApi.from(uriComponents);
        } else if (typeof uriApi?.parse === 'function') {
          uriArg = uriApi.parse(rawUrl);
        }
      } catch (e) {
        logError(`deliverUriCallback: Uri.parse failed (${e.message}), using raw URL`);
      }

      let delivered = 0;
      for (const [, entry] of trackedUriHandlers) {
        const handler = entry?.handler;
        if (!handler || typeof handler.handleUri !== 'function') continue;
        try {
          const result = handler.handleUri(uriArg);
          if (result && typeof result.then === 'function') {
            result.catch(err => logError(`URI handler rejected (${entry.extensionId || 'unknown'}): ${err.message}`));
          }
          delivered++;
        } catch (e) {
          logError(`URI handler threw (${entry.extensionId || 'unknown'}): ${e.message}`);
        }
      }

      log(`deliverUriCallback: delivered to ${delivered} handler(s)`);
      bridgeSend({ type: 'uriCallbackResult', ok: delivered > 0, delivered, url: rawUrl });
      break;
    }

    default:
      log(`Unknown bridge request action: ${msg.action}`);
  }
}

// ============================================================================
// Process Exit Monitoring
// ============================================================================

// Notify the bridge when the Extension Host process is about to exit.
// Common exit reasons: OOM, unhandled exception, VS Code shutdown.
// The manager can use this to decide whether to restart code-server.

process.on('exit', (code) => {
  const uptime = ((Date.now() - _startedAt) / 1000).toFixed(1);
  const msg = `Extension Host exiting (code=${code}, uptime=${uptime}s, apiIntercepted=${vsCodeWrapped}, providers=${trackedTreeProviders.size}t/${trackedWebviewProviders.size}w)`;
  process.stderr.write(`[ext-host-preload] ${msg}\n`);
  // Best-effort notify — socket may already be closed
  try {
    if (bridgeSocket && !bridgeSocket.destroyed) {
      bridgeSocket.write(JSON.stringify({
        type: 'ehExit',
        code,
        uptime: parseFloat(uptime),
        apiIntercepted: vsCodeWrapped,
        wrappedCount: _wrappedApiCount,
        treeProviders: trackedTreeProviders.size,
        webviewProviders: trackedWebviewProviders.size,
      }) + '\n');
    }
  } catch (_) {}
});

process.on('uncaughtException', (err) => {
  logError(`Uncaught exception in Extension Host: ${err.message}`);
  logError(err.stack || '');
  try {
    bridgeSend({ type: 'ehError', error: err.message, stack: err.stack });
  } catch (_) {}
});

process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logError(`Unhandled rejection in Extension Host: ${msg}`);
  try {
    bridgeSend({ type: 'ehError', error: msg, rejection: true });
  } catch (_) {}
});

// ============================================================================
// Cleanup
// ============================================================================

process.on('exit', () => {
  if (bridgeSocket) {
    try { bridgeSocket.end(); } catch (_) {}
  }
});
