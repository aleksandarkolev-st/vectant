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
const isExtensionHost = process.env.SYNTHI_EXTENSION_HOST_CONFIRMED === 'true';

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
const MAX_RECONNECT_ATTEMPTS = 5;

/** @type {number} Base delay for exponential backoff (ms) */
const RECONNECT_BASE_DELAY = 1000;

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

  const delay = RECONNECT_BASE_DELAY * Math.pow(2, reconnectAttempts);
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
// Module Interception
//
// VS Code's Extension Host (code-server 4.108+, ESM build) re-hooks
// Module._load and Module._resolveFilename AFTER our preload runs — and
// may do so MULTIPLE TIMES during the boot sequence.  The old polling
// approach (check every 10ms for 3s) was too narrow: VS Code could
// re-hook after the polling window closed, silently removing our wrapper.
//
// New approach: use Object.defineProperty to install getter/setter traps
// on Module._load and Module._resolveFilename.  Any time VS Code
// assigns a new function to these properties, our setter captures it
// and our getter returns a wrapper that intercepts require('vscode').
// This is permanent — no polling, no timing windows.
//
// The vscode API is detected by duck-typing (must have window, commands,
// workspace).  Once intercepted, we call wrapVSCodeAPI() to add
// observation hooks for tree views and webview providers.
// ============================================================================

const Module = require('module');
const realOriginalLoad = Module._load;  // The TRUE original before anyone hooks

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
 * Attempt to wrap a result that might be the vscode API.
 * VS Code creates separate API namespace objects per extension, so we must
 * wrap EVERY instance — not just the first.  Each instance gets its own
 * registerTreeDataProvider / registerWebviewViewProvider functions that
 * delegate to shared underlying services.
 *
 * Returns true if wrapping was performed on this call.
 */
function _tryWrapVscodeResult(result, source) {
  if (!result || typeof result !== 'object') return false;
  // Duck-type: must have window, commands, workspace
  if (!result.window || !result.commands || !result.workspace) return false;
  // Already wrapped this specific instance?
  if (_wrappedApiInstances.has(result)) return false;

  _wrappedApiInstances.add(result);
  _wrappedApiCount++;

  // Keep a reference for command execution (first instance is fine)
  if (!realVscodeApi) {
    realVscodeApi = result;
  }
  vsCodeWrapped = true;

  try {
    log(`Wrapping vscode API instance #${_wrappedApiCount} via ${source}`);
    log(`  registerWebviewViewProvider: ${typeof result.window?.registerWebviewViewProvider}`);
    log(`  registerTreeDataProvider: ${typeof result.window?.registerTreeDataProvider}`);
    wrapVSCodeAPI(result);
  } catch (e) {
    logError(`Failed to wrap vscode API instance #${_wrappedApiCount}: ${e.message}`);
    logError(e.stack || '');
  }
  return true;
}

// ---------------------------------------------------------------------------
// Strategy 0 (PRIMARY): Module.prototype.require hook
//
// The most reliable interception point.  Every CJS require() call from
// extension code flows through Module.prototype.require.  Unlike
// Module._load defineProperty traps, this cannot be bypassed by cached
// function references, ESM/CJS boundary issues, or VS Code re-hooking.
//
// When an extension calls require('vscode'), VS Code's own interceptor
// (NodeModuleRequireInterceptor, which hooks Module._load internally)
// returns the real API.  Our hook on Module.prototype.require sees the
// returned result and wraps it — after VS Code's interceptor has done
// its work.
// ---------------------------------------------------------------------------

const _origPrototypeRequire = Module.prototype.require;
let _requireHookCallCount = 0;

Module.prototype.require = function synthiRequireHook(id) {
  const result = _origPrototypeRequire.apply(this, arguments);

  _requireHookCallCount++;
  if (_requireHookCallCount <= 3 || _requireHookCallCount % 500 === 0) {
    log(`require() hook #${_requireHookCallCount}: "${id}" (from: ${this?.filename ? this.filename.split('/').slice(-3).join('/') : 'unknown'})`);
  }

  if (id === 'vscode') {
    try {
      const didWrap = _tryWrapVscodeResult(result, `require('vscode') hook (from: ${this?.filename || 'unknown'})`);
      if (didWrap) {
        log(`SUCCESS: vscode API intercepted via Module.prototype.require hook (call #${_requireHookCallCount})`);
      }
    } catch (e) {
      logError(`require hook failed to wrap: ${e.message}`);
    }
  }

  return result;
};
log('Module.prototype.require hook installed');

// ---------------------------------------------------------------------------
// Strategy 1: Object.defineProperty trap on Module._load
//
// Our getter always returns our wrapper function.  Our setter captures
// whatever function VS Code assigns (so we delegate to it).  VS Code
// thinks it replaced Module._load, but we're still in the call chain.
// ---------------------------------------------------------------------------

/** The "real" underlying _load function (VS Code's hook or Node's original) */
let _underlyingLoad = realOriginalLoad;

/**
 * Re-entrancy guard.  VS Code's require-interceptor captures our proxy
 * as `originalLoad` (from our getter), then assigns its own hook (captured
 * by our setter as `_underlyingLoad`).  For non-factory requests (anything
 * except 'vscode'), VS Code's hook calls `originalLoad` → our proxy →
 * `_underlyingLoad` → VS Code's hook → infinite loop.
 *
 * The guard detects re-entrance and delegates directly to Node's true
 * original Module._load, breaking the cycle.
 */
let _proxyReentrant = false;
let _proxyCallCount = 0;

function _synthiModuleLoadProxy(request, parent, isMain) {
  if (_proxyReentrant) {
    // We're being called from inside VS Code's hook, which captured our
    // proxy as its `originalLoad`.  Break the cycle → Node's true original.
    return realOriginalLoad.apply(this, arguments);
  }

  _proxyReentrant = true;
  _proxyCallCount++;

  // Log the first 5 calls and then periodically for diagnostics
  if (_proxyCallCount <= 5 || _proxyCallCount % 200 === 0) {
    log(`Module._load proxy call #${_proxyCallCount}: request="${request}"`);
  }

  try {
    const result = _underlyingLoad.apply(this, arguments);
    if (!vsCodeWrapped && (request === 'vscode' || request === 'vscode-nls')) {
      if (request === 'vscode') {
        _tryWrapVscodeResult(result, `Module._load proxy (call #${_proxyCallCount})`);
      }
    }
    return result;
  } finally {
    _proxyReentrant = false;
  }
}
_synthiModuleLoadProxy.__synthiHook = true;

let _loadTrapActive = false;
let _loadReassignCount = 0;
try {
  Object.defineProperty(Module, '_load', {
    get() { return _synthiModuleLoadProxy; },
    set(newLoad) {
      if (newLoad && !newLoad.__synthiHook) {
        _loadReassignCount++;
        log(`Module._load reassigned #${_loadReassignCount} (by: ${newLoad.name || 'anonymous'}), captured via property trap`);
        _underlyingLoad = newLoad;
      }
    },
    configurable: true,
    enumerable: true,
  });
  _loadTrapActive = true;
  log('Module._load property trap installed');
} catch (e) {
  logError(`Module._load property trap failed: ${e.message} — falling back to direct hook`);
  // Fallback: use the same re-entrancy-guarded proxy as a direct override
  Module._load = _synthiModuleLoadProxy;
}

// ---------------------------------------------------------------------------
// Strategy 2: Object.defineProperty trap on Module._resolveFilename
//
// When 'vscode' is resolved, we immediately check Module._cache for the
// resolved path and try to wrap the cached module.  This catches the case
// where VS Code pre-populates the cache so Module._load is never called.
// ---------------------------------------------------------------------------
let _underlyingResolveFilename = Module._resolveFilename;
const _origResolveFilename = Module._resolveFilename;  // True original
let _resolveReentrant = false;

function _synthiResolveFilenameProxy(request, parent, isMain, options) {
  if (_resolveReentrant) {
    // Same circular reference issue as Module._load — break cycle
    return _origResolveFilename.apply(this, arguments);
  }

  _resolveReentrant = true;
  try {
    const resolved = _underlyingResolveFilename.apply(this, arguments);
    if (request === 'vscode' && !vsCodeWrapped) {
      log(`Module._resolveFilename: 'vscode' → ${resolved} (parent: ${parent?.filename || 'unknown'})`);
      // Try the global cache immediately
      try {
        const cached = Module._cache?.[resolved];
        if (cached && cached.exports) {
          _tryWrapVscodeResult(cached.exports, `_resolveFilename cache hit (${resolved})`);
        }
      } catch (_) {}
    }
    return resolved;
  } finally {
    _resolveReentrant = false;
  }
}

try {
  Object.defineProperty(Module, '_resolveFilename', {
    get() { return _synthiResolveFilenameProxy; },
    set(newFn) {
      if (newFn !== _synthiResolveFilenameProxy) {
        log(`Module._resolveFilename reassigned — captured`);
        _underlyingResolveFilename = newFn;
      }
    },
    configurable: true,
    enumerable: true,
  });
  log('Module._resolveFilename property trap installed');
} catch (e) {
  logError(`Module._resolveFilename trap failed: ${e.message}`);
  // Fallback: simple overwrite
  const origResolve = Module._resolveFilename;
  Module._resolveFilename = function (request, parent, isMain, options) {
    const resolved = origResolve.apply(this, arguments);
    if (request === 'vscode' && !vsCodeWrapped) {
      try {
        const cached = Module._cache?.[resolved];
        if (cached?.exports) _tryWrapVscodeResult(cached.exports, '_resolveFilename fallback');
      } catch (_) {}
    }
    return resolved;
  };
}

// ---------------------------------------------------------------------------
// Strategy 3: Periodic scan of Module._cache
//
// Belt-and-suspenders: in case both traps are somehow bypassed, we also
// periodically scan the global module cache for the vscode API shape.
// Extended to 120s (240 attempts at 500ms).
// ---------------------------------------------------------------------------
let _cacheCheckAttempts = 0;
const _cacheCheckInterval = setInterval(() => {
  _cacheCheckAttempts++;
  if (vsCodeWrapped || _cacheCheckAttempts > 240) {
    clearInterval(_cacheCheckInterval);
    if (!vsCodeWrapped) {
      log(`Module._cache duck-typing gave up after ${_cacheCheckAttempts} attempts (${_cacheCheckAttempts * 500 / 1000}s)`);
    }
    return;
  }

  // Use Module._cache (global singleton) — require.cache might differ in ESM context
  const cache = Module._cache || {};
  for (const key of Object.keys(cache)) {
    const mod = cache[key];
    if (mod && mod.exports && typeof mod.exports === 'object' && !vsCodeWrapped) {
      const exp = mod.exports;
      if (exp.window && exp.commands && exp.workspace &&
          typeof exp.window.registerWebviewViewProvider === 'function' &&
          typeof exp.window.registerTreeDataProvider === 'function') {
        _tryWrapVscodeResult(exp, `Module._cache duck-typing (key: ${key})`);
        clearInterval(_cacheCheckInterval);
        return;
      }
    }
  }
}, 500);

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
    const extensionId = _inferExtensionId();
    trackedTreeProviders.set(viewId, { provider, extensionId });

    // Notify bridge of the registration
    bridgeSend({ type: 'treeProvider', viewId, extensionId });

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
      const extensionId = _inferExtensionId();
      trackedTreeProviders.set(viewId, { provider, extensionId });

      // Notify bridge
      bridgeSend({ type: 'treeProvider', viewId, extensionId });

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
      const extensionId = _inferExtensionId();
      bridgeSend({ type: 'webviewPanel', viewId, viewType, title, extensionId });

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
    bridgeSend({ type: 'command', commandId, extensionId: _inferExtensionId() });

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

    case 'resolveWebviewView': {
      // Resolve a webview view on demand.  Code-server runs headless so
      // resolveWebviewView is never called naturally.  We create a mock
      // WebviewView and call the provider ourselves.
      const { viewType } = msg;
      const entry = trackedWebviewProviders.get(viewType);
      if (!entry || !entry.provider) {
        logError(`No tracked webview provider for: ${viewType}`);
        break;
      }

      // If already resolved (has a webviewView), just re-send the current HTML
      if (entry.webviewView && entry.webviewView.webview) {
        const html = entry.webviewView.webview.html;
        if (html) {
          log(`Re-sending existing HTML for ${viewType} (${html.length} chars)`);
          bridgeSend({ type: 'webviewHtml', viewType, html });
        }
        break;
      }

      log(`Resolving webview view on demand: ${viewType}`);

      try {
        // Create a mock WebviewView object that mimics VS Code's interface.
        // The extension will set webview.html which we intercept.
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
        const result = entry.provider.resolveWebviewView(mockWebviewView, {}, { isCancellationRequested: false, onCancellationRequested: { event: () => ({ dispose() {} }) } });

        // Handle async providers
        if (result && typeof result.then === 'function') {
          result.then(() => {
            log(`Webview view ${viewType} resolved (async)`);
            // HTML should have been sent via the interceptor
          }).catch((err) => {
            logError(`resolveWebviewView failed for ${viewType}: ${err.message}`);
          });
        } else {
          log(`Webview view ${viewType} resolved (sync)`);
        }
      } catch (e) {
        logError(`resolveWebviewView error for ${viewType}: ${e.message}`);
      }
      break;
    }

    case 'executeCommand': {
      // Execute a command via the real vscode.commands.executeCommand API
      const { commandId, args: cmdArgs } = msg;
      if (!realVscodeApi?.commands?.executeCommand) {
        logError('Cannot execute command: vscode API not available yet');
        break;
      }
      log(`Bridge requested command execution: ${commandId}`);
      try {
        realVscodeApi.commands.executeCommand(commandId, ...(cmdArgs || []))
          .then(() => {
            log(`Command ${commandId} executed successfully`);
          }, (err) => {
            logError(`Command ${commandId} failed: ${err.message}`);
          });
      } catch (e) {
        logError(`Command ${commandId} execution error: ${e.message}`);
      }
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
