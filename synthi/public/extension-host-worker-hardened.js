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

      // --- Reusable helpers ---
      function noop() {}
      function noopReturn(v) { return function() { return v; }; }
      function noopPromise(v) { return function() { return Promise.resolve(v); }; }
      function chainable() { var obj = {}; var handler = { get: function(_, prop) { if (prop === 'then' || prop === 'catch') return undefined; return function() { return new Proxy(obj, handler); }; } }; return new Proxy(obj, handler); }

      // --- EventEmitter (proper constructor for `new` and inherits) ---
      function EventEmitterCtor() {
        this._events = {};
      }
      EventEmitterCtor.prototype.on = function(e, fn) { (this._events[e] = this._events[e] || []).push(fn); return this; };
      EventEmitterCtor.prototype.addListener = EventEmitterCtor.prototype.on;
      EventEmitterCtor.prototype.off = function(e, fn) { var l = this._events[e]; if (l) this._events[e] = l.filter(function(f) { return f !== fn; }); return this; };
      EventEmitterCtor.prototype.removeListener = EventEmitterCtor.prototype.off;
      EventEmitterCtor.prototype.removeAllListeners = function(e) { if (e) delete this._events[e]; else this._events = {}; return this; };
      EventEmitterCtor.prototype.once = function(e, fn) { var self = this; function wrap() { self.off(e, wrap); fn.apply(this, arguments); } this.on(e, wrap); return this; };
      EventEmitterCtor.prototype.emit = function(e) { var args = Array.prototype.slice.call(arguments, 1); var l = this._events[e]; if (!l) return false; l.forEach(function(fn) { fn.apply(null, args); }); return true; };
      EventEmitterCtor.prototype.listenerCount = function(e) { return (this._events[e] || []).length; };
      EventEmitterCtor.prototype.listeners = function(e) { return (this._events[e] || []).slice(); };
      EventEmitterCtor.prototype.setMaxListeners = function() { return this; };
      EventEmitterCtor.prototype.getMaxListeners = function() { return 10; };
      EventEmitterCtor.prototype.prependListener = EventEmitterCtor.prototype.on;
      EventEmitterCtor.prototype.prependOnceListener = EventEmitterCtor.prototype.once;
      EventEmitterCtor.prototype.eventNames = function() { return Object.keys(this._events); };

      // --- Stream stubs ---
      function StreamCtor() { EventEmitterCtor.call(this); }
      StreamCtor.prototype = Object.create(EventEmitterCtor.prototype);
      StreamCtor.prototype.pipe = function(dest) { return dest; };
      StreamCtor.prototype.read = noopReturn(null);
      StreamCtor.prototype.write = noopReturn(true);
      StreamCtor.prototype.end = noop;
      StreamCtor.prototype.destroy = noop;
      StreamCtor.prototype.setEncoding = function() { return this; };

      function ReadableCtor() { StreamCtor.call(this); this.readable = true; }
      ReadableCtor.prototype = Object.create(StreamCtor.prototype);
      function WritableCtor() { StreamCtor.call(this); this.writable = true; }
      WritableCtor.prototype = Object.create(StreamCtor.prototype);
      function DuplexCtor() { StreamCtor.call(this); this.readable = true; this.writable = true; }
      DuplexCtor.prototype = Object.create(StreamCtor.prototype);
      function TransformCtor() { DuplexCtor.call(this); }
      TransformCtor.prototype = Object.create(DuplexCtor.prototype);
      function PassThroughCtor() { TransformCtor.call(this); }
      PassThroughCtor.prototype = Object.create(TransformCtor.prototype);

      var statObj = { isFile: noopReturn(false), isDirectory: noopReturn(false), isSymbolicLink: noopReturn(false), isBlockDevice: noopReturn(false), isCharacterDevice: noopReturn(false), isFIFO: noopReturn(false), isSocket: noopReturn(false), size: 0, mtime: new Date(0), atime: new Date(0), ctime: new Date(0), birthtime: new Date(0), mode: 0 };

      const BUILTIN_STUBS = {
        path: {
          join: function() { return Array.prototype.slice.call(arguments).filter(Boolean).join('/').replace(/\/+/g, '/'); },
          resolve: function() { var p = Array.prototype.slice.call(arguments).filter(Boolean).join('/'); return p.charAt(0) === '/' ? p : '/' + p; },
          dirname: function(p) { return p ? p.replace(/[/\\][^/\\]*$/, '') || '/' : '.'; },
          basename: function(p, ext) { var b = (p || '').split(/[/\\]/).pop() || ''; return ext && b.endsWith(ext) ? b.slice(0, -ext.length) : b; },
          extname: function(p) { var m = (p || '').match(/\.[^./\\]+$/); return m ? m[0] : ''; },
          normalize: function(p) { return (p || '').replace(/[/\\]+/g, '/'); },
          isAbsolute: function(p) { return (p || '').charAt(0) === '/'; },
          relative: function(from, to) { return to || ''; },
          parse: function(p) { p = p || ''; var ext = (p.match(/\.[^./\\]+$/) || [''])[0]; var base = p.split(/[/\\]/).pop() || ''; return { root: p.charAt(0) === '/' ? '/' : '', dir: p.replace(/[/\\][^/\\]*$/, '') || '', base: base, ext: ext, name: base.slice(0, base.length - ext.length) }; },
          format: function(o) { o = o || {}; return (o.dir || o.root || '') + '/' + (o.base || (o.name || '') + (o.ext || '')); },
          sep: '/',
          delimiter: ':',
          posix: null, // assigned below
          win32: null
        },
        fs: {
          readFileSync: noopReturn(''),
          writeFileSync: noop,
          existsSync: noopReturn(false),
          mkdirSync: noop,
          readdirSync: noopReturn([]),
          statSync: noopReturn(statObj),
          lstatSync: noopReturn(statObj),
          unlinkSync: noop,
          rmdirSync: noop,
          renameSync: noop,
          copyFileSync: noop,
          chmodSync: noop,
          accessSync: function() { throw new Error('ENOENT: no such file (web shim)'); },
          readlinkSync: noopReturn(''),
          realpathSync: function(p) { return p; },
          createReadStream: function() { return new ReadableCtor(); },
          createWriteStream: function() { return new WritableCtor(); },
          watch: function() { return new EventEmitterCtor(); },
          watchFile: noop,
          unwatchFile: noop,
          constants: { F_OK: 0, R_OK: 4, W_OK: 2, X_OK: 1, COPYFILE_EXCL: 1 },
          promises: {
            readFile: noopPromise(''),
            writeFile: noopPromise(undefined),
            readdir: noopPromise([]),
            stat: noopPromise(statObj),
            lstat: noopPromise(statObj),
            mkdir: noopPromise(undefined),
            rmdir: noopPromise(undefined),
            unlink: noopPromise(undefined),
            rename: noopPromise(undefined),
            access: function() { return Promise.reject(new Error('ENOENT: no such file (web shim)')); },
            realpath: function(p) { return Promise.resolve(p); },
            copyFile: noopPromise(undefined),
            chmod: noopPromise(undefined)
          }
        },
        os: {
          homedir: noopReturn('/'),
          tmpdir: noopReturn('/tmp'),
          platform: noopReturn('web'),
          EOL: '\n',
          type: noopReturn('Web'),
          arch: noopReturn('wasm'),
          cpus: noopReturn([]),
          totalmem: noopReturn(8 * 1024 * 1024 * 1024),
          freemem: noopReturn(4 * 1024 * 1024 * 1024),
          hostname: noopReturn('localhost'),
          release: noopReturn('0.0.0'),
          uptime: noopReturn(0),
          userInfo: noopReturn({ username: 'web', homedir: '/', shell: '/bin/sh', uid: 1000, gid: 1000 }),
          networkInterfaces: noopReturn({}),
          endianness: noopReturn('LE'),
          constants: {
            signals: { SIGHUP: 1, SIGINT: 2, SIGQUIT: 3, SIGILL: 4, SIGTRAP: 5, SIGABRT: 6, SIGBUS: 7, SIGFPE: 8, SIGKILL: 9, SIGUSR1: 10, SIGSEGV: 11, SIGUSR2: 12, SIGPIPE: 13, SIGALRM: 14, SIGTERM: 15, SIGCHLD: 17, SIGCONT: 18, SIGSTOP: 19, SIGTSTP: 20, SIGTTIN: 21, SIGTTOU: 22 },
            errno: { EACCES: -13, ENOENT: -2, EEXIST: -17, EISDIR: -21, ENOTDIR: -20, ENOTEMPTY: -39, EPERM: -1, EBADF: -9 },
            priority: { PRIORITY_LOW: 19, PRIORITY_BELOW_NORMAL: 10, PRIORITY_NORMAL: 0, PRIORITY_ABOVE_NORMAL: -7, PRIORITY_HIGH: -14, PRIORITY_HIGHEST: -20 }
          }
        },
        util: {
          promisify: function(fn) { return fn; },
          inherits: function(ctor, superCtor) { if (superCtor) { ctor.super_ = superCtor; ctor.prototype = Object.create(superCtor.prototype, { constructor: { value: ctor } }); } },
          deprecate: function(fn) { return fn; },
          inspect: function(obj) { try { return JSON.stringify(obj, null, 2); } catch(e) { return String(obj); } },
          format: function() { return Array.prototype.slice.call(arguments).map(String).join(' '); },
          types: { isProxy: noopReturn(false), isDate: function(v) { return v instanceof Date; }, isRegExp: function(v) { return v instanceof RegExp; }, isNativeError: function(v) { return v instanceof Error; } },
          TextDecoder: typeof TextDecoder !== 'undefined' ? TextDecoder : function() {},
          TextEncoder: typeof TextEncoder !== 'undefined' ? TextEncoder : function() {},
          callbackify: function(fn) { return function() { var args = Array.prototype.slice.call(arguments); var cb = args.pop(); fn.apply(null, args).then(function(r) { cb(null, r); }, cb); }; }
        },
        events: { EventEmitter: EventEmitterCtor, once: function(emitter, evt) { return new Promise(function(resolve) { emitter.once(evt, function() { resolve(Array.prototype.slice.call(arguments)); }); }); } },
        stream: { Stream: StreamCtor, Readable: ReadableCtor, Writable: WritableCtor, Duplex: DuplexCtor, Transform: TransformCtor, PassThrough: PassThroughCtor, pipeline: function() { var cb = arguments[arguments.length - 1]; if (typeof cb === 'function') cb(null); }, finished: function(s, cb) { if (typeof cb === 'function') cb(null); } },
        child_process: {
          exec: function(cmd, opts, cb) { cb = cb || opts; if (typeof cb === 'function') setTimeout(function() { cb(new Error('child_process not available in web worker'), '', ''); }, 0); },
          execSync: function() { throw new Error('child_process not available in web worker'); },
          execFile: function(file, args, opts, cb) { cb = cb || opts || args; if (typeof cb === 'function') setTimeout(function() { cb(new Error('child_process not available in web worker'), '', ''); }, 0); },
          fork: function() { throw new Error('child_process.fork not available in web worker'); },
          spawn: function() { var proc = new EventEmitterCtor(); proc.stdin = new WritableCtor(); proc.stdout = new ReadableCtor(); proc.stderr = new ReadableCtor(); proc.pid = 0; proc.kill = noop; proc.ref = noop; proc.unref = noop; setTimeout(function() { proc.emit('error', new Error('child_process not available in web worker')); proc.emit('close', 1); }, 0); return proc; }
        },
        net: {
          Socket: function NetSocket() { DuplexCtor.call(this); this.connect = function() { return this; }; this.setTimeout = noop; this.setNoDelay = noop; this.setKeepAlive = noop; this.address = noopReturn({}); this.destroy = noop; this.ref = noop; this.unref = noop; },
          Server: function NetServer() { EventEmitterCtor.call(this); this.listen = function() { return this; }; this.close = noop; this.address = noopReturn(null); this.ref = noop; this.unref = noop; },
          createServer: function() { return new BUILTIN_STUBS.net.Server(); },
          createConnection: function() { return new BUILTIN_STUBS.net.Socket(); },
          connect: function() { return new BUILTIN_STUBS.net.Socket(); },
          isIP: function(s) { return 0; },
          isIPv4: noopReturn(false),
          isIPv6: noopReturn(false)
        },
        url: {
          URL: typeof URL !== 'undefined' ? URL : function() {},
          URLSearchParams: typeof URLSearchParams !== 'undefined' ? URLSearchParams : function() {},
          parse: function(u) { try { var o = new URL(u); return { protocol: o.protocol, hostname: o.hostname, port: o.port, pathname: o.pathname, search: o.search, hash: o.hash, host: o.host, href: o.href }; } catch(e) { return { href: u }; } },
          format: function(o) { return o && o.href ? o.href : ''; },
          resolve: function(from, to) { try { return new URL(to, from).href; } catch(e) { return to; } }
        },
        crypto: {
          randomUUID: function() { return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) { var r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16); }); },
          randomBytes: function(n) { var buf = new Uint8Array(n); if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(buf); return buf; },
          createHash: function() { return { update: function() { return this; }, digest: function(enc) { return enc === 'hex' ? '0'.repeat(64) : new Uint8Array(32); } }; },
          createHmac: function() { return { update: function() { return this; }, digest: function(enc) { return enc === 'hex' ? '0'.repeat(64) : new Uint8Array(32); } }; }
        },
        querystring: {
          parse: function(s) { var o = {}; (s || '').replace(/^\?/, '').split('&').forEach(function(p) { var kv = p.split('='); if (kv[0]) o[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || ''); }); return o; },
          stringify: function(o) { return Object.keys(o || {}).map(function(k) { return encodeURIComponent(k) + '=' + encodeURIComponent(o[k]); }).join('&'); },
          encode: function(o) { return BUILTIN_STUBS.querystring.stringify(o); },
          decode: function(s) { return BUILTIN_STUBS.querystring.parse(s); }
        },
        string_decoder: {
          StringDecoder: function StringDecoder() { this.write = function(buf) { return typeof buf === 'string' ? buf : new TextDecoder().decode(buf); }; this.end = function(buf) { return buf ? this.write(buf) : ''; }; }
        },
        http: {
          request: function(opts, cb) { var req = new EventEmitterCtor(); req.write = noop; req.end = function() { setTimeout(function() { req.emit('error', new Error('http not available in web worker')); }, 0); }; req.setTimeout = noop; req.destroy = noop; return req; },
          get: function(opts, cb) { return BUILTIN_STUBS.http.request(opts, cb); },
          createServer: function() { return new EventEmitterCtor(); },
          Agent: function HttpAgent() {},
          STATUS_CODES: { 200: 'OK', 201: 'Created', 204: 'No Content', 301: 'Moved Permanently', 302: 'Found', 304: 'Not Modified', 400: 'Bad Request', 401: 'Unauthorized', 403: 'Forbidden', 404: 'Not Found', 500: 'Internal Server Error' }
        },
        https: {
          request: function(opts, cb) { return BUILTIN_STUBS.http.request(opts, cb); },
          get: function(opts, cb) { return BUILTIN_STUBS.http.request(opts, cb); },
          createServer: function() { return new EventEmitterCtor(); },
          Agent: function HttpsAgent() {}
        },
        zlib: {
          createGzip: function() { return new TransformCtor(); },
          createGunzip: function() { return new TransformCtor(); },
          createDeflate: function() { return new TransformCtor(); },
          createInflate: function() { return new TransformCtor(); },
          gzip: function(buf, cb) { cb(null, buf); },
          gunzip: function(buf, cb) { cb(null, buf); },
          deflate: function(buf, cb) { cb(null, buf); },
          inflate: function(buf, cb) { cb(null, buf); },
          gzipSync: function(buf) { return buf; },
          gunzipSync: function(buf) { return buf; },
          deflateSync: function(buf) { return buf; },
          inflateSync: function(buf) { return buf; },
          constants: { Z_NO_FLUSH: 0, Z_SYNC_FLUSH: 2, Z_FULL_FLUSH: 3, Z_FINISH: 4 }
        },
        tty: {
          isatty: noopReturn(false),
          ReadStream: ReadableCtor,
          WriteStream: WritableCtor
        },
        assert: {
          ok: function(v, msg) { if (!v) throw new Error(msg || 'Assertion failed'); },
          equal: function(a, b, msg) { if (a != b) throw new Error(msg || a + ' != ' + b); },
          strictEqual: function(a, b, msg) { if (a !== b) throw new Error(msg || a + ' !== ' + b); },
          notEqual: function(a, b, msg) { if (a == b) throw new Error(msg || a + ' == ' + b); },
          notStrictEqual: function(a, b, msg) { if (a === b) throw new Error(msg || a + ' === ' + b); },
          deepEqual: function() {},
          deepStrictEqual: function() {},
          throws: function(fn, msg) { try { fn(); throw new Error(msg || 'Missing expected exception'); } catch(e) {} },
          fail: function(msg) { throw new Error(msg || 'Assert.fail'); }
        },
        module: {
          createRequire: function() { return shimRequire; },
          builtinModules: ['path', 'fs', 'os', 'util', 'events', 'stream', 'child_process', 'net', 'url', 'crypto', 'http', 'https', 'zlib', 'tty', 'assert', 'querystring', 'string_decoder', 'module']
        },
        perf_hooks: {
          performance: typeof performance !== 'undefined' ? performance : { now: function() { return Date.now(); } },
          PerformanceObserver: function() { this.observe = noop; this.disconnect = noop; }
        },
        worker_threads: {
          isMainThread: true,
          parentPort: null,
          workerData: null,
          Worker: function() { throw new Error('worker_threads not available in web worker'); }
        }
      };
      // path.posix self-reference
      BUILTIN_STUBS.path.posix = BUILTIN_STUBS.path;
      BUILTIN_STUBS.path.win32 = BUILTIN_STUBS.path;
      const shimRequire = (id) => {
        if (id === 'vscode') return vscode;
        if (BUILTIN_STUBS[id]) return BUILTIN_STUBS[id];
        // For anything else, return an empty module to avoid hard crash
        console.warn(`[ExtensionHost] require('${id}') shimmed as empty for ${extensionId}`);
        return {};
      };
      
      // Wrap extension code to inject Node.js globals (global, globalThis, window)
      // Many webpack/esbuild bundles reference `global` at the top level which
      // does not exist in Web Workers — alias it to `self`.
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
` + code;

      // Evaluate extension code with require shim
      const factory = new Function('vscode', 'exports', 'module', 'require', 'process', 'Buffer', '__dirname', '__filename', wrappedCode);
      const processShim = { env: {}, platform: 'web', cwd: () => '/', version: 'v18.0.0', versions: { node: '18.0.0' }, nextTick: (cb) => setTimeout(cb, 0), stdout: { write: () => {} }, stderr: { write: () => {} } };
      const BufferShim = typeof Buffer !== 'undefined' ? Buffer : { from: () => new Uint8Array(), alloc: () => new Uint8Array(), isBuffer: () => false, concat: () => new Uint8Array() };
      factory(vscode, exports, module, shimRequire, processShim, BufferShim, '/', '/extension.js');
      
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
