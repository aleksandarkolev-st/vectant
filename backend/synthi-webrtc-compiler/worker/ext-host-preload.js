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

// ============================================================================
// Guard: only activate inside VS Code's Extension Host process
// ============================================================================

// The Extension Host sets these env vars. If they're absent, we're in the
// wrong process (e.g. code-server's main process, a terminal, a task runner).
const isExtensionHost = !!(
  process.env.VSCODE_IPC_HOOK_EXTHOST ||
  process.env.VSCODE_HANDLES_UNCAUGHT_ERRORS ||
  process.env.VSCODE_NLS_CONFIG ||
  // code-server's fork also sets this
  process.env.VSCODE_PIPE_LOGGING === 'true'
);

// The manager tells us where to connect
const BRIDGE_PORT = parseInt(process.env.SYNTHI_EXT_BRIDGE_PORT || '0', 10);

if (!isExtensionHost) {
  // Not the Extension Host — do nothing
  return;
}

if (!BRIDGE_PORT) {
  // No bridge port configured — extensions run normally, no observation
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

/**
 * Connect to the vscode-server-manager's TCP bridge.
 * Non-blocking — if connection fails, extensions still work normally.
 */
function connectBridge() {
  if (connectionAttempted) return;
  connectionAttempted = true;

  const socket = net.createConnection({ port: BRIDGE_PORT, host: '127.0.0.1' }, () => {
    log('Connected to bridge');
    bridgeSocket = socket;
    bridgeConnected = true;

    // Flush queued messages
    for (const msg of pendingMessages) {
      socket.write(msg + '\n');
    }
    pendingMessages = [];
  });

  socket.setNoDelay(true);

  socket.on('error', (err) => {
    logError(`Bridge connection error: ${err.message}`);
    bridgeConnected = false;
    bridgeSocket = null;
  });

  socket.on('close', () => {
    log('Bridge connection closed');
    bridgeConnected = false;
    bridgeSocket = null;
  });

  // Don't let the socket keep the process alive
  socket.unref();
}

/**
 * Send a JSON message to the bridge. Queues if not yet connected.
 * @param {object} msg
 */
function bridgeSend(msg) {
  const json = JSON.stringify(msg);
  if (bridgeConnected && bridgeSocket) {
    bridgeSocket.write(json + '\n');
  } else {
    pendingMessages.push(json);
  }
}

// Initiate connection immediately
connectBridge();

// ============================================================================
// Module Interception
// ============================================================================

const Module = require('module');
const originalLoad = Module._load;

/** @type {boolean} Whether we've already wrapped the vscode module */
let vsCodeWrapped = false;

/**
 * Intercept Module._load to wrap the `vscode` module when it's first loaded.
 * All other modules pass through untouched.
 */
Module._load = function (request, parent, isMain) {
  const result = originalLoad.apply(this, arguments);

  // Only intercept the 'vscode' module, and only once
  if (request === 'vscode' && !vsCodeWrapped && result && typeof result === 'object') {
    vsCodeWrapped = true;
    log('Intercepted vscode module — wrapping API surfaces');
    wrapVSCodeAPI(result);
  }

  return result;
};

// ============================================================================
// State: tracked providers
// ============================================================================

/** @type {Map<string, {provider: object, extensionId?: string}>} */
const trackedTreeProviders = new Map();

/** @type {Map<string, {provider: object, extensionId?: string}>} */
const trackedWebviewProviders = new Map();

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
function wrapVSCodeAPI(vscode) {
  if (!vscode.window) {
    logError('vscode.window not found — cannot wrap');
    return;
  }

  wrapRegisterTreeDataProvider(vscode);
  wrapCreateTreeView(vscode);
  wrapWebviewProviders(vscode);
  wrapCommands(vscode);

  log('All API wrappers installed successfully');
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

  vscode.window.registerTreeDataProvider = function wrappedRegisterTreeDataProvider(viewId, provider) {
    log(`registerTreeDataProvider intercepted: ${viewId}`);

    // Call the real API — this is the genuine registration
    const disposable = original.call(this, viewId, provider);

    // Track the provider for data extraction
    trackedTreeProviders.set(viewId, { provider });

    // Notify bridge of the registration
    bridgeSend({ type: 'treeProvider', viewId });

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

  vscode.window.createTreeView = function wrappedCreateTreeView(viewId, options) {
    log(`createTreeView intercepted: ${viewId}`);

    // Call the real API
    const treeView = original.call(this, viewId, options);

    // Track the provider if one was given
    const provider = options?.treeDataProvider;
    if (provider) {
      trackedTreeProviders.set(viewId, { provider });

      // Notify bridge
      bridgeSend({ type: 'treeProvider', viewId });

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

  log('createTreeView wrapped');
}

// ============================================================================
// Cleanup
// ============================================================================

process.on('exit', () => {
  if (bridgeSocket) {
    try { bridgeSocket.end(); } catch (_) {}
  }
});
