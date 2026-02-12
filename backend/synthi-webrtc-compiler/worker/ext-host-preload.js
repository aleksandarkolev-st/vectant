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

    // Announce ourselves with an initial handshake
    bridgeSend({
      type: 'hello',
      pid: process.pid,
      extHostEnv: !!process.env.VSCODE_IPC_HOOK_EXTHOST,
    });
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
// Tree Data Resolution
//
// Calls the real TreeDataProvider's getChildren() and getTreeItem() methods
// to extract the tree structure, then sends it to the bridge as JSON.
// ============================================================================

/** Maximum depth to recurse when resolving tree data */
const TREE_MAX_DEPTH = 4;

/** Maximum items per level */
const TREE_MAX_ITEMS_PER_LEVEL = 200;

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
      arguments: treeItem.command.arguments,
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
    vscode.window.registerWebviewViewProvider = function wrappedRegisterWebviewViewProvider(viewType, provider, options) {
      log(`registerWebviewViewProvider intercepted: ${viewType}`);

      // Wrap the provider's resolveWebviewView to intercept the webview object
      const wrappedProvider = Object.create(provider);
      wrappedProvider.resolveWebviewView = function (webviewView, context, token) {
        // Intercept the webview's html property setter
        _interceptWebviewHtml(webviewView.webview, viewType);

        // Notify bridge
        bridgeSend({ type: 'webviewProvider', viewType });

        // Track
        trackedWebviewProviders.set(viewType, { provider, webviewView });

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

      return disposable;
    };
    log('registerWebviewViewProvider wrapped');
  }

  // ── createWebviewPanel (editor/floating webview panels) ──
  const origCreateWP = vscode.window.createWebviewPanel;
  if (origCreateWP) {
    vscode.window.createWebviewPanel = function wrappedCreateWebviewPanel(viewType, title, showOptions, options) {
      log(`createWebviewPanel intercepted: ${viewType} "${title}"`);

      // Call the real API
      const panel = origCreateWP.call(this, viewType, title, showOptions, options);

      const viewId = `panel-${viewType}-${Date.now()}`;

      // Intercept webview HTML
      _interceptWebviewHtml(panel.webview, viewId);

      // Notify bridge
      bridgeSend({ type: 'webviewPanel', viewId, viewType, title });

      // Track disposal
      panel.onDidDispose(() => {
        bridgeSend({ type: 'webviewDisposed', viewId });
      });

      return panel;
    };
    log('createWebviewPanel wrapped');
  }
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
 *
 * @param {object} vscode
 */
function wrapCommands(vscode) {
  if (!vscode.commands?.registerCommand) {
    log('commands.registerCommand not found');
    return;
  }

  const original = vscode.commands.registerCommand;

  vscode.commands.registerCommand = function wrappedRegisterCommand(commandId, callback, thisArg) {
    // Call the real API
    const disposable = original.call(this, commandId, callback, thisArg);

    // Notify bridge of command registration
    bridgeSend({ type: 'command', commandId });

    return disposable;
  };

  log('commands.registerCommand wrapped');
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

    default:
      log(`Unknown bridge request action: ${msg.action}`);
  }
}

// ============================================================================
// Cleanup
// ============================================================================

process.on('exit', () => {
  if (bridgeSocket) {
    try { bridgeSocket.end(); } catch (_) {}
  }
});
