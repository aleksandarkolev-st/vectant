/**
 * Synthi Extension System - Hardened Extension Host Worker
 * PHASE B: Hardened Execution Boundary
 * 
 * This worker is DISPOSABLE. It can be killed and restarted at any time.
 * No extension state lives here - only execution happens here.
 * 
 * Security rules:
 * - Max message size enforced
 * - Max message rate enforced  
 * - Strict schema validation
 * - Unknown methods = fatal error
 * - Protocol violations = immediate termination signal
 */

// Load real Node.js browser polyfills (Buffer, path, events, stream, etc.)
// Built by: node scripts/build-node-polyfills.js → public/node-polyfills.js
try {
  importScripts('/node-polyfills.js');
} catch (e) {
  console.warn('[ExtensionHost] node-polyfills.js not found, extensions may fail:', e.message);
}

// ============================================================================
// Deep Auto-Stub: a Proxy that handles ANY property access, function call,
// or class extension without crashing. Unknown require() calls return this
// instead of {} so `extends unknown.Class` or `unknown.method()` just works.
// ============================================================================
self.__createDeepStub = function(moduleName) {
  const cache = new Map();
  
  function makeStub(path) {
    if (cache.has(path)) return cache.get(path);
    
    // A function that is also a constructor (works with `new` and `extends`)
    function StubFn() {
      // When used as a constructor, return a proxy instance too
      return makeStub(path + '.instance');
    }
    // Allow `class X extends StubFn` — needs a prototype with constructor
    StubFn.prototype = Object.create(null);
    StubFn.prototype.constructor = StubFn;
    // Make it work with Symbol.hasInstance (instanceof checks)
    Object.defineProperty(StubFn, Symbol.hasInstance, { value: () => false });
    
    const proxy = new Proxy(StubFn, {
      get(target, prop) {
        // Primitives and common JS protocol methods
        // Return '0.0.0' instead of '' so that semver.parse/gte/etc. get a
        // valid version string instead of crashing with "Invalid Version: ".
        if (prop === Symbol.toPrimitive) return (hint) => hint === 'number' ? 0 : '0.0.0';
        if (prop === Symbol.iterator) return undefined;
        if (prop === Symbol.toStringTag) return moduleName || 'Stub';
        if (prop === 'then') return undefined;  // prevent Promise-like behavior
        if (prop === 'catch') return undefined;
        if (prop === 'toJSON') return () => ({});
        if (prop === 'valueOf') return () => 0;
        if (prop === 'toString') return () => '0.0.0';
        if (prop === 'constructor') return StubFn;
        if (prop === 'prototype') return StubFn.prototype;
        if (prop === 'length') return 0;
        if (prop === 'name') return path.split('.').pop();
        if (prop === '__esModule') return true;
        if (prop === 'default') return proxy;  // ES module default export
        // Return a nested stub for anything else
        return makeStub(path + '.' + String(prop));
      },
      set(target, prop, value) {
        // Allow setting properties (some modules set config on imported objects)
        target[prop] = value;
        return true;
      },
      has(target, prop) {
        return true;  // pretend we have everything
      },
      apply(target, thisArg, args) {
        // When called as a function, return a stub (chainable)
        return makeStub(path + '()');
      },
      construct(target, args) {
        // When used with `new`, return a stub instance
        return makeStub(path + '.new');
      },
      getPrototypeOf() {
        return StubFn.prototype;
      }
    });
    
    cache.set(path, proxy);
    return proxy;
  }
  
  return makeStub(moduleName || 'unknown');
};

// ============================================================================
// Configuration Constants
// ============================================================================

const CONFIG = {
  // Message limits
  MAX_MESSAGE_SIZE: 25 * 1024 * 1024, // 25MB max message size (must exceed code size limit)
  MAX_MESSAGE_RATE: 100, // messages per second
  MESSAGE_RATE_WINDOW: 1000, // 1 second window
  
  // Activation limits
  ACTIVATION_TIMEOUT: 5000, // 5 seconds hard limit
  COMMAND_TIMEOUT: 5000, // 5 seconds per command
  
  // Memory limits
  MAX_EXTENSIONS: 50,
  
  // Heartbeat
  HEARTBEAT_INTERVAL: 5000
};

// ============================================================================
// Protocol - Message Validation
// ============================================================================

const VALID_REQUEST_METHODS = new Set([
  'loadExtension',
  'activateExtension',
  'deactivateExtension',
  'executeCommand',
  'suspendExtension',
  'resumeExtension',
  'killExtension',
  'getMetrics',
  'getExtensionStates',
  'ping'
]);

let messageIdCounter = 0;
let workerGeneration = 0;

function createMessageId() {
  return ++messageIdCounter;
}

function createResponse(id, result, error = null) {
  const msg = {
    id,
    type: 'response',
    generation: workerGeneration
  };
  if (error) {
    msg.error = {
      message: String(error.message || error),
      stack: error.stack ? String(error.stack).slice(0, 2000) : undefined,
      code: error.code
    };
  } else {
    msg.result = result;
  }
  return msg;
}

function createEvent(method, args = []) {
  return {
    id: createMessageId(),
    type: 'event',
    method,
    args,
    generation: workerGeneration
  };
}

/**
 * Validate incoming message - STRICT validation
 * @param {any} msg
 * @returns {{valid: boolean, error?: string}}
 */
function validateMessage(msg) {
  if (!msg || typeof msg !== 'object') {
    return { valid: false, error: 'Message must be an object' };
  }
  
  if (typeof msg.id !== 'number' || !Number.isFinite(msg.id)) {
    return { valid: false, error: 'Message id must be a finite number' };
  }
  
  if (!['request', 'response', 'event'].includes(msg.type)) {
    return { valid: false, error: `Invalid message type: ${msg.type}` };
  }
  
  if (msg.type === 'request') {
    if (typeof msg.method !== 'string') {
      return { valid: false, error: 'Request method must be a string' };
    }
    
    // STRICT: Only allow known methods
    if (!VALID_REQUEST_METHODS.has(msg.method)) {
      return { valid: false, error: `Unknown method: ${msg.method}` };
    }
    
    if (msg.args !== undefined && !Array.isArray(msg.args)) {
      return { valid: false, error: 'Request args must be an array' };
    }
  }
  
  return { valid: true };
}

/**
 * Estimate message size
 * @param {any} msg
 * @returns {number}
 */
function estimateMessageSize(msg) {
  try {
    return JSON.stringify(msg).length;
  } catch {
    return Infinity; // Can't serialize = too big
  }
}

// ============================================================================
// Rate Limiting
// ============================================================================

class RateLimiter {
  constructor(limit, windowMs) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.counts = new Map(); // extensionId -> { count, windowStart }
  }

  /**
   * Check if action is allowed
   * @param {string} key
   * @returns {boolean}
   */
  allow(key) {
    const now = performance.now();
    let entry = this.counts.get(key);
    
    if (!entry || (now - entry.windowStart) >= this.windowMs) {
      entry = { count: 0, windowStart: now };
      this.counts.set(key, entry);
    }
    
    if (entry.count >= this.limit) {
      return false;
    }
    
    entry.count++;
    return true;
  }

  reset(key) {
    this.counts.delete(key);
  }

  clear() {
    this.counts.clear();
  }
}

const messageRateLimiter = new RateLimiter(CONFIG.MAX_MESSAGE_RATE, CONFIG.MESSAGE_RATE_WINDOW);

// ============================================================================
// VS Code API Implementation (Minimal)
// ============================================================================

class EventEmitter {
  constructor() {
    this._listeners = [];
  }
  
  get event() {
    return (listener, thisArgs, disposables) => {
      const bound = thisArgs ? listener.bind(thisArgs) : listener;
      this._listeners.push(bound);
      const disposable = {
        dispose: () => {
          const idx = this._listeners.indexOf(bound);
          if (idx !== -1) this._listeners.splice(idx, 1);
        }
      };
      if (disposables) disposables.push(disposable);
      return disposable;
    };
  }
  
  fire(data) {
    for (const l of this._listeners) {
      try { l(data); } catch (e) { console.error('[EventEmitter]', e); }
    }
  }
  
  dispose() {
    this._listeners = [];
  }
}

function createVSCodeAPI(extensionId, host) {
  return {
    // Expose a realistic VS Code engine version so semver checks pass
    version: '1.85.0',
    commands: {
      registerCommand(command, callback, thisArg) {
        const handler = thisArg ? callback.bind(thisArg) : callback;
        return host.registerCommand(extensionId, command, handler);
      },
      async executeCommand(command, ...args) {
        const cmd = host.commands.get(command);
        if (cmd) {
          return cmd.handler(...args);
        }
        throw new Error(`Command not found: ${command}`);
      },
      async getCommands(filterInternal = false) {
        return Array.from(host.commands.keys());
      }
    },
    
    window: {
      showInformationMessage(message, ...items) {
        host.emit('showMessage', 'info', message, { items });
        return Promise.resolve(undefined);
      },
      showWarningMessage(message, ...items) {
        host.emit('showMessage', 'warning', message, { items });
        return Promise.resolve(undefined);
      },
      showErrorMessage(message, ...items) {
        host.emit('showMessage', 'error', message, { items });
        return Promise.resolve(undefined);
      },
      createWebviewPanel(viewType, title, showOptions, options) {
        const viewId = `${extensionId}.webview.${Date.now()}`;
        const onDidReceiveMessageEmitter = new EventEmitter();
        const onDidDisposeEmitter = new EventEmitter();
        const onDidChangeViewStateEmitter = new EventEmitter();
        const panel = {
          viewType,
          title,
          viewColumn: typeof showOptions === 'number' ? showOptions : 1,
          active: true,
          visible: true,
          webview: {
            _html: '',
            get html() { return this._html; },
            set html(value) {
              this._html = value;
              host.emit('updateWebview', viewId, { html: value });
            },
            options: options || {},
            onDidReceiveMessage: onDidReceiveMessageEmitter.event,
            postMessage: (msg) => {
              host.emit('postWebviewMessage', viewId, msg);
              return Promise.resolve(true);
            },
            asWebviewUri: (uri) => uri,
            cspSource: '',
          },
          reveal(viewColumn, preserveFocus) {
            host.emit('revealWebview', viewId, viewColumn, preserveFocus);
          },
          dispose() {
            host.emit('disposeWebview', viewId);
            onDidDisposeEmitter.fire();
          },
          onDidDispose: onDidDisposeEmitter.event,
          onDidChangeViewState: onDidChangeViewStateEmitter.event,
        };
        host.emit('createWebview', viewId, viewType, title, options);
        return panel;
      },
      registerWebviewViewProvider(viewId, provider, options) {
        // Resolve the webview view immediately so the extension can set HTML.
        const wvViewId = `${extensionId}.webviewView.${viewId}`;
        const onDidChangeVisibilityEmitter = new EventEmitter();
        const onDidDisposeEmitter = new EventEmitter();
        const webviewView = {
          viewType: viewId,
          visible: true,
          onDidChangeVisibility: onDidChangeVisibilityEmitter.event,
          onDidDispose: onDidDisposeEmitter.event,
          show(preserveFocus) { /* no-op for now */ },
          webview: {
            _html: '',
            options: options || {},
            get html() { return this._html; },
            set html(value) {
              this._html = value;
              host.emit('updateWebview', wvViewId, { html: value });
            },
            onDidReceiveMessage: new EventEmitter().event,
            postMessage: (msg) => {
              host.emit('postWebviewMessage', wvViewId, msg);
              return Promise.resolve(true);
            },
            asWebviewUri: (uri) => uri,
            cspSource: '',
          },
        };
        // Notify main thread to create the webview container
        host.emit('createWebview', wvViewId, viewId, viewId, options || {});
        // Let the extension resolve content into the view
        try {
          const result = provider.resolveWebviewView(webviewView, {}, { isCancellationRequested: false, onCancellationRequested: new EventEmitter().event });
          if (result && typeof result.then === 'function') {
            result.catch(e => console.error(`[registerWebviewViewProvider] resolveWebviewView failed for ${viewId}:`, e));
          }
        } catch (e) {
          console.error(`[registerWebviewViewProvider] resolveWebviewView threw for ${viewId}:`, e);
        }
        return {
          dispose() {
            onDidDisposeEmitter.fire();
            host.emit('disposeWebview', wvViewId);
          }
        };
      },
      createTreeView(viewId, options) {
        const treeView = {
          _viewId: viewId,
          _provider: options.treeDataProvider || null,
          _onDidExpandElement: new EventEmitter(),
          _onDidCollapseElement: new EventEmitter(),
          _onDidChangeSelection: new EventEmitter(),
          _onDidChangeVisibility: new EventEmitter(),
          title: undefined,
          description: undefined,
          message: undefined,
          badge: undefined,
          visible: true,
          selection: [],
          onDidExpandElement: null,
          onDidCollapseElement: null,
          onDidChangeSelection: null,
          onDidChangeVisibility: null,
          reveal() { return Promise.resolve(); },
          dispose() {
            host.emit('disposeTreeView', viewId);
          }
        };
        treeView.onDidExpandElement = treeView._onDidExpandElement.event;
        treeView.onDidCollapseElement = treeView._onDidCollapseElement.event;
        treeView.onDidChangeSelection = treeView._onDidChangeSelection.event;
        treeView.onDidChangeVisibility = treeView._onDidChangeVisibility.event;

        // Resolve initial data and notify the main thread
        if (treeView._provider) {
          host._treeDataProviders.set(viewId, treeView._provider);
          // Emit the tree data asynchronously
          _resolveTreeDataAndEmit(viewId, treeView._provider, host);
        }

        host.emit('registerTreeView', viewId, extensionId);
        return treeView;
      },
      registerTreeDataProvider(viewId, provider) {
        host._treeDataProviders.set(viewId, provider);
        _resolveTreeDataAndEmit(viewId, provider, host);
        host.emit('registerTreeView', viewId, extensionId);
        return { dispose: () => { host._treeDataProviders.delete(viewId); } };
      },
      createOutputChannel(name) {
        return {
          name,
          append(value) { console.log(`[${name}] ${value}`); },
          appendLine(value) { console.log(`[${name}] ${value}`); },
          clear() {},
          show() {},
          hide() {},
          dispose() {}
        };
      },
      setStatusBarMessage(text, hideAfterTimeout) {
        host.emit('setStatusBar', text, hideAfterTimeout);
        return { dispose: () => {} };
      }
    },
    
    workspace: {
      workspaceFolders: [],
      name: undefined,
      getConfiguration(section) {
        return {
          get(key, defaultValue) { return defaultValue; },
          has(key) { return false; },
          update() { return Promise.resolve(); }
        };
      },
      onDidChangeConfiguration: new EventEmitter().event
    },
    
    languages: {
      registerCompletionItemProvider() { return { dispose: () => {} }; },
      registerHoverProvider() { return { dispose: () => {} }; },
      registerDefinitionProvider() { return { dispose: () => {} }; },
      createDiagnosticCollection(name) {
        const diagnostics = new Map();
        return {
          name,
          set(uri, diags) { diagnostics.set(uri.toString(), diags); },
          delete(uri) { diagnostics.delete(uri.toString()); },
          clear() { diagnostics.clear(); },
          dispose() { diagnostics.clear(); }
        };
      }
    },
    
    Position: class Position {
      constructor(line, character) {
        this.line = line;
        this.character = character;
      }
    },
    Range: class Range {
      constructor(startLine, startChar, endLine, endChar) {
        if (typeof startLine === 'object') {
          this.start = startLine;
          this.end = startChar;
        } else {
          this.start = { line: startLine, character: startChar };
          this.end = { line: endLine, character: endChar };
        }
      }
    },
    Uri: {
      parse(str) {
        try {
          const url = new URL(str);
          return { scheme: url.protocol.replace(':', ''), path: url.pathname, toString: () => str };
        } catch {
          return { scheme: 'file', path: str, toString: () => str };
        }
      },
      file(path) {
        return { scheme: 'file', path, fsPath: path, toString: () => `file://${path}` };
      }
    },
    EventEmitter,
    Disposable: class Disposable {
      constructor(callOnDispose) {
        this._callOnDispose = callOnDispose;
      }
      dispose() {
        if (this._callOnDispose) this._callOnDispose();
      }
      static from(...disposables) {
        return new Disposable(() => disposables.forEach(d => d.dispose()));
      }
    },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    CompletionItemKind: { Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4, Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9 }
  };
}

// ============================================================================
// Tree Data Helper
// ============================================================================

/**
 * Resolve tree data from a TreeDataProvider and emit it to the main thread.
 * Walks up to 3 levels deep to avoid excessive recursion.
 */
async function _resolveTreeDataAndEmit(viewId, provider, host, maxDepth = 3) {
  try {
    const resolve = async (element, depth) => {
      const items = [];
      let children;
      try {
        children = await Promise.resolve(provider.getChildren(element));
      } catch (e) {
        console.warn(`[TreeData] getChildren failed for ${viewId}:`, e);
        return items;
      }
      if (!children || !Array.isArray(children)) return items;

      for (const child of children.slice(0, 200)) { // cap at 200 items per level
        let treeItem;
        try {
          treeItem = await Promise.resolve(provider.getTreeItem(child));
        } catch (e) {
          continue;
        }
        const item = {
          id: treeItem.id || (typeof child === 'string' ? child : String(Math.random())),
          label: typeof treeItem.label === 'string' ? treeItem.label : treeItem.label?.label || String(child),
          description: treeItem.description || undefined,
          tooltip: treeItem.tooltip || undefined,
          iconPath: treeItem.iconPath ? String(treeItem.iconPath) : undefined,
          collapsibleState: treeItem.collapsibleState || 0,
          contextValue: treeItem.contextValue || undefined,
          children: [],
        };

        // Recurse if collapsible and we haven't gone too deep
        if (item.collapsibleState && item.collapsibleState > 0 && depth < maxDepth) {
          item.children = await resolve(child, depth + 1);
        }
        items.push(item);
      }
      return items;
    };

    const data = await resolve(undefined, 0);
    host.emit('treeData', viewId, data);
  } catch (err) {
    console.error(`[TreeData] Failed to resolve tree data for ${viewId}:`, err);
  }
}

// ============================================================================
// Extension Host - Hardened
// ============================================================================

class HardenedExtensionHost {
  constructor() {
    /** @type {Map<string, {module: object, manifest: object, vscode: object}>} */
    this.loadedExtensions = new Map();
    
    /** @type {Map<string, object>} */
    this.activeContexts = new Map();
    
    /** @type {Map<string, {extensionId: string, handler: Function}>} */
    this.commands = new Map();
    
    /** @type {Map<string, Set<string>>} */
    this.commandsByExtension = new Map();
    
    /** @type {Map<string, {activationTime: number, cpuTime: number, lastActivity: number, messageCount: number}>} */
    this.metrics = new Map();
    
    /** @type {Set<string>} Extensions marked as suspended */
    this.suspended = new Set();

    /** @type {Map<string, object>} Tree data providers registered by extensions */
    this._treeDataProviders = new Map();
    
    /** @type {boolean} Is the host accepting new work */
    this.accepting = true;
  }

  /**
   * Handle incoming message from main thread
   * @param {any} msg
   */
  handleMessage(msg) {
    // Validate message structure - STRICT
    const validation = validateMessage(msg);
    if (!validation.valid) {
      console.error('[ExtensionHost] PROTOCOL VIOLATION:', validation.error);
      // Report violation to main thread
      this.emit('protocolViolation', validation.error);
      return;
    }

    // Check message size (exempt loadExtension — it carries full source code)
    if (msg.method !== 'loadExtension') {
      const size = estimateMessageSize(msg);
      if (size > CONFIG.MAX_MESSAGE_SIZE) {
        console.error('[ExtensionHost] Message too large:', size);
        self.postMessage(createResponse(msg.id, null, new Error('Message too large')));
        return;
      }
    }

    if (msg.type === 'request') {
      this._handleRequest(msg);
    }
  }

  async _handleRequest(msg) {
    const { id, method, args = [] } = msg;

    // Rate limit per method
    if (!messageRateLimiter.allow(method)) {
      console.warn('[ExtensionHost] Rate limit exceeded for:', method);
      self.postMessage(createResponse(id, null, { message: 'Rate limit exceeded', code: 'RATE_LIMITED' }));
      return;
    }

    if (!this.accepting && method !== 'ping') {
      self.postMessage(createResponse(id, null, { message: 'Worker not accepting requests', code: 'NOT_ACCEPTING' }));
      return;
    }

    try {
      let result;

      switch (method) {
        case 'ping':
          result = { pong: true, timestamp: Date.now(), generation: workerGeneration };
          break;
        case 'loadExtension':
          result = await this._loadExtension(...args);
          break;
        case 'activateExtension':
          result = await this._activateExtension(...args);
          break;
        case 'deactivateExtension':
          result = await this._deactivateExtension(...args);
          break;
        case 'executeCommand':
          result = await this._executeCommand(...args);
          break;
        case 'suspendExtension':
          result = this._suspendExtension(...args);
          break;
        case 'resumeExtension':
          result = this._resumeExtension(...args);
          break;
        case 'killExtension':
          result = await this._killExtension(...args);
          break;
        case 'getMetrics':
          result = this._getMetrics();
          break;
        case 'getExtensionStates':
          result = this._getExtensionStates();
          break;
        default:
          // Should never happen due to validation
          throw new Error(`Unknown method: ${method}`);
      }

      self.postMessage(createResponse(id, result));
    } catch (err) {
      console.error(`[ExtensionHost] ${method} failed:`, err);
      self.postMessage(createResponse(id, null, err));
    }
  }

  emit(method, ...args) {
    // Rate limit events
    if (!messageRateLimiter.allow(`event:${method}`)) {
      console.warn('[ExtensionHost] Event rate limit exceeded:', method);
      return;
    }
    self.postMessage(createEvent(method, args));
  }

  async _loadExtension(extensionId, code, manifest) {
    if (this.loadedExtensions.size >= CONFIG.MAX_EXTENSIONS) {
      throw new Error('Maximum extension limit reached');
    }

    if (this.loadedExtensions.has(extensionId)) {
      // Already loaded — clean up the old version so we can re-load
      console.log(`[ExtensionHost] Re-loading: ${extensionId}`);
      try { await this._deactivateExtension(extensionId); } catch (_) {}
      this.loadedExtensions.delete(extensionId);
      this.metrics.delete(extensionId);
      this.suspended.delete(extensionId);
    }

    // Validate code size
    if (typeof code !== 'string' || code.length > 20 * 1024 * 1024) { // 20MB max
      throw new Error('Extension code too large or invalid');
    }

    console.log(`[ExtensionHost] Loading: ${extensionId}`);

    const vscode = createVSCodeAPI(extensionId, this);

    try {
      const exports = {};
      const module = { exports };

      // Shim require() for bundled Node.js extensions.
      // Many marketplace extensions are webpack/esbuild bundles that call
      // require('vscode'), require('path'), require('fs'), etc.
      // Real polyfills are loaded from node-polyfills.js (bundled by esbuild).
      // The polyfill bundle sets self.__nodePolyfills, self.__nodeBuffer, self.__nodeProcess.
      const polyfills = self.__nodePolyfills || {};
      const BufferImpl = self.__nodeBuffer || (typeof Buffer !== 'undefined' ? Buffer : { from: () => new Uint8Array(), alloc: () => new Uint8Array(), allocUnsafe: () => new Uint8Array(), isBuffer: () => false, concat: () => new Uint8Array(), byteLength: () => 0 });
      const processImpl = self.__nodeProcess || { env: {}, platform: 'web', cwd: () => '/', version: '18.0.0', versions: { node: '18.0.0' }, nextTick: (cb) => setTimeout(cb, 0), stdout: { write: () => {} }, stderr: { write: () => {} } };

      // CRITICAL FIX: The browser process polyfill (process/browser.js) sets
      // process.version = "" and process.versions = {}.  Semver libraries crash
      // when they try to parse an empty string.  Patch them to valid semver.
      if (!processImpl.version || !/^\d/.test(processImpl.version.replace(/^v/, ''))) {
        processImpl.version = '18.0.0';
      }
      if (!processImpl.versions || typeof processImpl.versions !== 'object') {
        processImpl.versions = {};
      }
      if (!processImpl.versions.node) processImpl.versions.node = '18.0.0';
      if (!processImpl.versions.v8)   processImpl.versions.v8   = '10.2.154.26';
      if (!processImpl.versions.modules) processImpl.versions.modules = '108';

      // FIX: The browser process polyfill throws on process.binding().
      // Some extensions (Prisma) call it for native bindings (buffer, util, fs…).
      // Return a minimal stub object so the extension can continue.
      const origBinding = processImpl.binding;
      processImpl.binding = function(name) {
        try { if (origBinding) return origBinding.call(processImpl, name); } catch (_) {}
        return {};
      };
      if (typeof processImpl.dlopen !== 'function') {
        processImpl.dlopen = function() {
          console.warn('[ExtensionHost] process.dlopen() stubbed');
        };
      }

      const shimRequire = (id) => {
        if (id === 'vscode') return vscode;
        // Check real polyfills first (includes node: prefixed aliases)
        if (polyfills[id]) {
          // Wrap known polyfills in a safety Proxy: any property access that
          // resolves to undefined/null gets auto-stubbed, preventing
          // "Class extends value undefined" crashes.
          const real = polyfills[id];
          if (typeof real !== 'object' && typeof real !== 'function') return real;
          return new Proxy(real, {
            get(target, prop, receiver) {
              if (typeof prop === 'symbol') return Reflect.get(target, prop, receiver);
              const value = Reflect.get(target, prop, receiver);
              // If the real value exists and is usable, return it
              if (value !== undefined && value !== null) return value;
              // Value is undefined/null → return auto-stub instead of crashing
              // This catches: properties that exist but are undefined, AND
              // properties that don't exist at all on the polyfill
              return self.__createDeepStub(id + '.' + String(prop));
            }
          });
        }
        // For anything unknown, return a deep auto-stub Proxy.
        console.warn(`[ExtensionHost] require('${id}') auto-stubbed for ${extensionId}`);
        return self.__createDeepStub(id);
      };
      // Expose for module.createRequire
      self.__nodeRequire = shimRequire;

      // ---------- Class extends safety rewriting ----------
      // Webpack/esbuild bundles have their own internal __webpack_require__ that bypasses
      // our shimRequire Proxy. When an internally-resolved module is undefined, code like
      //   class Foo extends someUndefinedValue { ... }
      // crashes with "Class extends value undefined is not a constructor or null".
      // The JS engine throws this BEFORE Object.create is called, so we can't patch it
      // at runtime. Instead, we pre-process the code string to wrap every extends expression
      // in a safety function __x() that replaces undefined/non-function values with a stub class.
      code = code.replace(
        /(\bclass\b[^{]*?\bextends\s+)([^{]+)\{/g,
        function(_match, before, expr) {
          return before + '__x(' + expr.trim() + '){';
        }
      );

      // ---------- Semver "Invalid Version" safety patching ----------
      // Bundled semver libraries throw `new TypeError("Invalid Version: " + v)` when
      // given empty strings or non-semver values. Since we can't control every version
      // string that flows through webpack-internal modules, we patch the bundled code
      // to coerce invalid versions to "0.0.0" instead of throwing.
      // Typical minified patterns:
      //   throw new TypeError("Invalid Version: "+e)
      //   throw new TypeError(`Invalid Version: ${e}`)
      code = code.replace(
        /throw\s+new\s+TypeError\s*\(\s*["'`]Invalid Version:\s*["'`]\s*\+\s*(\w+)\s*\)/g,
        '($1 = (typeof $1 === "string" && /^\\d/.test($1)) ? $1 : "0.0.0", void 0)'
      );
      // Also catch template literal form: throw new TypeError(`Invalid Version: ${e}`)
      code = code.replace(
        /throw\s+new\s+TypeError\s*\(\s*`Invalid Version:\s*\$\{(\w+)\}`\s*\)/g,
        '($1 = (typeof $1 === "string" && /^\\d/.test($1)) ? $1 : "0.0.0", void 0)'
      );

      // ---------- Semver null-match safety patching (Layer 1) ----------
      // When the "Invalid Version" throw is tree-shaken by the minifier, the
      // SemVer constructor directly accesses match(regex)[1] on a null result.
      // The standard semver library preprocesses with .trim().replace(/^[v=]+/, '')
      // before matching, but some minified bundles strip this step. We re-inject
      // the prefix-stripping so strings like "v18.0.0" match strict semver regexes.
      code = code.replace(
        /\.trim\(\)\s*\.match\s*\(/g,
        '.trim().replace(/^[v=\\s]+/,"").match('
      );

      // Wrap extension code to inject Node.js globals.
      // Many webpack/esbuild bundles reference `global`, `Buffer`, `process` etc. at top level.
      const wrappedCode = `var global = self;
var globalThis = self;
var window = self;
var process = arguments[4];
var Buffer = arguments[5];
var require = arguments[3];
var __dirname = arguments[6];
var __filename = arguments[7];
var setImmediate = function(cb) { return setTimeout(cb, 0); };
var clearImmediate = function(id) { return clearTimeout(id); };
var __SafeBase = (function(){ function S(){} return S; })();
var __x = function(v){ if(v===void 0) return __SafeBase; if(v===null) return null; if(typeof v==='function') return v; return __SafeBase; };
var __origSPM = String.prototype.match;
String.prototype.match = function(re) {
  var r = __origSPM.call(this, re);
  if (r !== null) return r;
  if (!(re instanceof RegExp) || re.source.length < 12 || !/\\(/.test(re.source)) return r;
  var s = (typeof this === 'string' ? this : String(this)).trim();
  if (/^[v= \\t]*\\d+\\.\\d+\\.\\d+/.test(s)) {
    var c = s.replace(/^[v=\\s]+/, '');
    var m = __origSPM.call(c, /^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([\\w.+-]+))?(?:\\+([\\w.+-]+))?$/);
    if (m) return m;
  }
  if (re.source.length > 30 && re.source.indexOf('\\\\d') >= 0 && re.source.indexOf('\\\\.') >= 0) {
    var fb = __origSPM.call('0.0.0', re);
    if (fb) return fb;
    return ['0.0.0','0','0','0',undefined,undefined];
  }
  return r;
};
var __origExec = RegExp.prototype.exec;
RegExp.prototype.exec = function(str) {
  var r = __origExec.call(this, str);
  if (r !== null) return r;
  if (this.source.length < 12 || !/\\(/.test(this.source)) return r;
  var s = (typeof str === 'string' ? str : String(str)).trim();
  if (/^[v= \\t]*\\d+\\.\\d+\\.\\d+/.test(s)) {
    var c = s.replace(/^[v=\\s]+/, '');
    var m = __origExec.call(/^(\\d+)\\.(\\d+)\\.(\\d+)(?:-([\\w.+-]+))?(?:\\+([\\w.+-]+))?$/, c);
    if (m) return m;
  }
  if (this.source.length > 30 && this.source.indexOf('\\\\d') >= 0 && this.source.indexOf('\\\\.') >= 0) {
    var fb = __origExec.call(this, '0.0.0');
    if (fb) return fb;
    return ['0.0.0','0','0','0',undefined,undefined];
  }
  return r;
};
` + code;

      // Evaluate extension code with polyfill-backed shims
      const factory = new Function('vscode', 'exports', 'module', 'require', 'process', 'Buffer', '__dirname', '__filename', wrappedCode);
      factory(vscode, exports, module, shimRequire, processImpl, BufferImpl, '/', '/extension.js');
      
      const extensionModule = module.exports || exports;

      if (typeof extensionModule.activate !== 'function') {
        throw new Error('Extension must export an activate() function');
      }

      this.loadedExtensions.set(extensionId, {
        module: extensionModule,
        manifest,
        vscode
      });

      this.metrics.set(extensionId, {
        activationTime: 0,
        cpuTime: 0,
        lastActivity: Date.now(),
        messageCount: 0
      });

      console.log(`[ExtensionHost] Loaded: ${extensionId}`);
      return { success: true, extensionId };
    } catch (err) {
      console.error(`[ExtensionHost] Load failed for ${extensionId}:`, err);
      throw err;
    }
  }

  async _activateExtension(extensionId) {
    const ext = this.loadedExtensions.get(extensionId);
    if (!ext) {
      return { success: false, error: 'Extension not loaded' };
    }

    if (this.activeContexts.has(extensionId)) {
      return { success: true, activationTime: 0 };
    }

    if (this.suspended.has(extensionId)) {
      return { success: false, error: 'Extension is suspended' };
    }

    console.log(`[ExtensionHost] Activating: ${extensionId}`);
    const startTime = performance.now();

    const context = {
      subscriptions: [],
      extensionPath: '/',
      storagePath: '/storage',
      globalStoragePath: '/storage/global',
      workspaceState: { get: () => undefined, update: () => Promise.resolve() },
      globalState: { get: () => undefined, update: () => Promise.resolve(), setKeysForSync: () => {} }
    };

    try {
      // Wrap activation in Promise.race with timeout
      const activatePromise = (async () => {
        await ext.module.activate(context);
      })();

      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => {
          reject(Object.assign(new Error(`Activation timeout (${CONFIG.ACTIVATION_TIMEOUT}ms)`), {
            code: 'ACTIVATION_TIMEOUT'
          }));
        }, CONFIG.ACTIVATION_TIMEOUT);
      });

      await Promise.race([activatePromise, timeoutPromise]);

      const activationTime = performance.now() - startTime;
      this.activeContexts.set(extensionId, context);

      const metrics = this.metrics.get(extensionId);
      if (metrics) metrics.activationTime = activationTime;

      console.log(`[ExtensionHost] Activated: ${extensionId} in ${activationTime.toFixed(0)}ms`);
      
      this.emit('activationComplete', extensionId, true, activationTime, null);
      
      return { success: true, activationTime };
    } catch (err) {
      const activationTime = performance.now() - startTime;
      console.error(`[ExtensionHost] Activation failed for ${extensionId}:`, err);
      
      // Mark as suspended to prevent future activation attempts
      this.suspended.add(extensionId);
      
      this.emit('activationComplete', extensionId, false, activationTime, err.message);
      
      // If it was a timeout, signal to main thread this is fatal
      if (err.code === 'ACTIVATION_TIMEOUT') {
        return { 
          success: false, 
          activationTime, 
          error: err.message,
          code: 'ACTIVATION_TIMEOUT',
          fatal: true
        };
      }
      
      return { success: false, activationTime, error: err.message };
    }
  }

  async _deactivateExtension(extensionId) {
    const ext = this.loadedExtensions.get(extensionId);
    const ctx = this.activeContexts.get(extensionId);

    if (ext && ext.module && typeof ext.module.deactivate === 'function') {
      try {
        await Promise.race([
          ext.module.deactivate(),
          new Promise(resolve => setTimeout(resolve, 1000)) // 1s timeout for deactivate
        ]);
      } catch (err) {
        console.error(`[ExtensionHost] Deactivate error for ${extensionId}:`, err);
      }
    }

    if (ctx) {
      for (const d of ctx.subscriptions) {
        try { d.dispose(); } catch (e) {}
      }
      this.activeContexts.delete(extensionId);
    }

    // Unregister commands
    const cmds = this.commandsByExtension.get(extensionId);
    if (cmds) {
      for (const cmdId of cmds) {
        this.commands.delete(cmdId);
        this.emit('unregisterCommand', cmdId);
      }
      this.commandsByExtension.delete(extensionId);
    }

    return { success: true };
  }

  registerCommand(extensionId, commandId, handler) {
    if (this.commands.has(commandId)) {
      throw new Error(`Command ${commandId} already registered`);
    }

    console.log(`[ExtensionHost] Command: ${commandId}`);

    this.commands.set(commandId, { extensionId, handler });

    if (!this.commandsByExtension.has(extensionId)) {
      this.commandsByExtension.set(extensionId, new Set());
    }
    this.commandsByExtension.get(extensionId).add(commandId);

    this.emit('registerCommand', commandId, extensionId);

    return {
      dispose: () => {
        this.commands.delete(commandId);
        const cmds = this.commandsByExtension.get(extensionId);
        if (cmds) cmds.delete(commandId);
        this.emit('unregisterCommand', commandId);
      }
    };
  }

  async _executeCommand(commandId, ...args) {
    const cmd = this.commands.get(commandId);
    if (!cmd) {
      throw new Error(`Command not found: ${commandId}`);
    }

    if (this.suspended.has(cmd.extensionId)) {
      throw new Error(`Extension ${cmd.extensionId} is suspended`);
    }

    const startTime = performance.now();
    
    // Timeout for command execution
    const resultPromise = Promise.resolve(cmd.handler(...args));
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Command timeout')), CONFIG.COMMAND_TIMEOUT);
    });

    const result = await Promise.race([resultPromise, timeoutPromise]);
    
    const elapsed = performance.now() - startTime;
    const metrics = this.metrics.get(cmd.extensionId);
    if (metrics) {
      metrics.cpuTime += elapsed;
      metrics.lastActivity = Date.now();
    }

    return result;
  }

  _getMetrics() {
    const result = {};
    for (const [id, metrics] of this.metrics) {
      result[id] = { ...metrics };
    }
    return result;
  }

  _getExtensionStates() {
    const states = [];
    for (const [extensionId, ext] of this.loadedExtensions) {
      const isActive = this.activeContexts.has(extensionId);
      const isSuspended = this.suspended.has(extensionId);
      const metrics = this.metrics.get(extensionId) || {};
      const commands = Array.from(this.commandsByExtension.get(extensionId) || []);
      
      states.push({
        extensionId,
        manifest: ext.manifest,
        state: isSuspended ? 'suspended' : (isActive ? 'active' : 'loaded'),
        activationTime: metrics.activationTime || 0,
        cpuTime: metrics.cpuTime || 0,
        lastActivity: metrics.lastActivity || 0,
        commands
      });
    }
    return states;
  }

  _suspendExtension(extensionId) {
    this.suspended.add(extensionId);
    return { success: true };
  }

  _resumeExtension(extensionId) {
    this.suspended.delete(extensionId);
    return { success: true };
  }

  async _killExtension(extensionId) {
    await this._deactivateExtension(extensionId);
    this.loadedExtensions.delete(extensionId);
    this.suspended.delete(extensionId);
    this.metrics.delete(extensionId);
    messageRateLimiter.reset(extensionId);
    return { success: true };
  }

  /**
   * Prepare for shutdown
   */
  prepareShutdown() {
    this.accepting = false;
    console.log('[ExtensionHost] Preparing for shutdown');
  }
}

// ============================================================================
// Worker Entry Point
// ============================================================================

const host = new HardenedExtensionHost();

self.onmessage = (event) => {
  host.handleMessage(event.data);
};

// Error handling
self.onerror = (event) => {
  console.error('[ExtensionHost] Uncaught error:', event);
  self.postMessage(createEvent('workerError', [event.message || 'Unknown error']));
};

self.onunhandledrejection = (event) => {
  console.error('[ExtensionHost] Unhandled rejection:', event.reason);
  self.postMessage(createEvent('workerError', [event.reason?.message || 'Unhandled promise rejection']));
};

// Heartbeat - signals the worker is still responsive
setInterval(() => {
  self.postMessage(createEvent('heartbeat', [Date.now(), workerGeneration]));
}, CONFIG.HEARTBEAT_INTERVAL);

// Signal ready
self.postMessage(createEvent('workerReady', [workerGeneration]));

console.log('[ExtensionHost] Worker ready');

// Export for debugging
self.extensionHost = host;
