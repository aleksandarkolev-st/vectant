#!/usr/bin/env node
/**
 * Synthi Remote Extension Host
 * 
 * Runs on the backend (spawned by the Rust WebRTC worker).
 * Loads VS Code extensions with full Node.js APIs.
 * Communicates with the browser via newline-delimited JSON over stdin/stdout.
 * 
 * Protocol (same as WorkerProxy/extension-host-worker-hardened.js):
 *   Request:  { id, type: 'request', method, args, generation }
 *   Response: { id, type: 'response', result?, error?, generation }
 *   Event:    { id, type: 'event', method, args, generation }
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const readline = require('readline');
const { EventEmitter } = require('events');

// ============================================================================
// Configuration
// ============================================================================

const GENERATION = 0;
let messageIdCounter = 0;

function createMessageId() {
  return ++messageIdCounter;
}

function createResponse(id, result, error = null) {
  const msg = { id, type: 'response', generation: GENERATION };
  if (error) {
    msg.error = {
      message: String(error.message || error),
      stack: error.stack ? String(error.stack).slice(0, 2000) : undefined,
      code: error.code,
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
    generation: GENERATION,
  };
}

function send(obj) {
  try {
    const json = JSON.stringify(obj);
    process.stdout.write(json + '\n');
  } catch (e) {
    process.stderr.write(`[remote-ext-host] send error: ${e.message}\n`);
  }
}

function emit(method, ...args) {
  send(createEvent(method, args));
}

// ============================================================================
// Extension State
// ============================================================================

/** @type {Map<string, {module: object, manifest: object, vscode: object}>} */
const loadedExtensions = new Map();

/** @type {Map<string, object>} */
const activeContexts = new Map();

/** @type {Map<string, {extensionId: string, handler: Function}>} */
const commands = new Map();

/** @type {Map<string, object>} Tree data providers: viewId → {provider, options} */
const treeDataProviders = new Map();

/** @type {Map<string, object>} Webview view providers: viewType → {provider} */
const webviewViewProviders = new Map();

/** @type {Map<string, {chunks: Map<number,string>, total: number, created: number}>} */
const pendingCodeUploads = new Map();

/** @type {Map<string, {chunks: Map<number,string>, total: number, created: number}>} */
const pendingManifestUploads = new Map();

// ============================================================================
// vscode API Types
// ============================================================================

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Range {
  constructor(startLine, startChar, endLine, endChar) {
    if (startLine instanceof Position) {
      this.start = startLine;
      this.end = startChar;
    } else {
      this.start = new Position(startLine, startChar);
      this.end = new Position(endLine, endChar);
    }
  }
}

class Uri {
  constructor(scheme, authority, path, query, fragment) {
    this.scheme = scheme || 'file';
    this.authority = authority || '';
    this.path = path || '';
    this.query = query || '';
    this.fragment = fragment || '';
  }
  static parse(str) {
    try {
      const u = new URL(str);
      return new Uri(u.protocol.replace(':', ''), u.hostname, u.pathname, u.search, u.hash);
    } catch {
      return new Uri('file', '', str);
    }
  }
  static file(p) { return new Uri('file', '', p); }
  static from(obj) { return new Uri(obj.scheme, obj.authority, obj.path, obj.query, obj.fragment); }
  get fsPath() { return this.path; }
  toString() {
    if (this.scheme === 'file') return `file://${this.path}`;
    return `${this.scheme}://${this.authority}${this.path}`;
  }
  with(change) {
    return new Uri(
      change.scheme ?? this.scheme, change.authority ?? this.authority,
      change.path ?? this.path, change.query ?? this.query, change.fragment ?? this.fragment
    );
  }
  toJSON() { return { scheme: this.scheme, authority: this.authority, path: this.path, query: this.query, fragment: this.fragment }; }
}

class VscodeEventEmitter {
  constructor() {
    this._listeners = [];
  }
  get event() {
    const self = this;
    return function subscribe(listener, thisArg, disposables) {
      const bound = thisArg ? listener.bind(thisArg) : listener;
      self._listeners.push(bound);
      const disposable = {
        dispose() {
          const idx = self._listeners.indexOf(bound);
          if (idx >= 0) self._listeners.splice(idx, 1);
        }
      };
      if (disposables) disposables.push(disposable);
      return disposable;
    };
  }
  fire(data) {
    for (const fn of this._listeners.slice()) {
      try { fn(data); } catch (e) {
        process.stderr.write(`[remote-ext-host] event listener error: ${e.message}\n`);
      }
    }
  }
  dispose() { this._listeners.length = 0; }
}

class Disposable {
  constructor(callOnDispose) { this._callOnDispose = callOnDispose; }
  static from(...disposables) {
    return new Disposable(() => disposables.forEach(d => d?.dispose?.()));
  }
  dispose() {
    if (this._callOnDispose) { this._callOnDispose(); this._callOnDispose = null; }
  }
}

class CancellationTokenSource {
  constructor() {
    this._emitter = new VscodeEventEmitter();
    this.token = {
      isCancellationRequested: false,
      onCancellationRequested: this._emitter.event,
    };
  }
  cancel() { this.token.isCancellationRequested = true; this._emitter.fire(); }
  dispose() { this._emitter.dispose(); }
}

const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
const DiagnosticSeverity = { Error: 0, Warning: 1, Information: 2, Hint: 3 };
const CompletionItemKind = {
  Text: 0, Method: 1, Function: 2, Constructor: 3, Field: 4,
  Variable: 5, Class: 6, Interface: 7, Module: 8, Property: 9,
  Unit: 10, Value: 11, Enum: 12, Keyword: 13, Snippet: 14,
  Color: 15, File: 16, Reference: 17, Folder: 18,
};
const StatusBarAlignment = { Left: 1, Right: 2 };
const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2, Three: 3 };

// ============================================================================
// Tree Data Resolution
// ============================================================================

async function resolveTreeData(viewId) {
  const entry = treeDataProviders.get(viewId);
  if (!entry) return;

  const { provider } = entry;
  if (!provider.getChildren || !provider.getTreeItem) return;

  const maxDepth = 3;
  const maxItemsPerLevel = 200;

  const resolve = async (element, depth) => {
    const items = [];
    let children;
    try {
      children = await provider.getChildren(element);
    } catch (e) {
      process.stderr.write(`[remote-ext-host] TreeData getChildren failed for ${viewId}: ${e.message}\n`);
      return items;
    }
    if (!children || !Array.isArray(children)) return items;

    for (let i = 0; i < Math.min(children.length, maxItemsPerLevel); i++) {
      const child = children[i];
      let treeItem;
      try {
        treeItem = await provider.getTreeItem(child);
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

      if (item.collapsibleState && item.collapsibleState > 0 && depth < maxDepth) {
        item.children = await resolve(child, depth + 1);
      }
      items.push(item);
    }
    return items;
  };

  try {
    const data = await resolve(undefined, 0);
    emit('treeData', viewId, data);
  } catch (err) {
    process.stderr.write(`[remote-ext-host] TreeData resolve failed for ${viewId}: ${err.message}\n`);
  }
}

// ============================================================================
// vscode API Factory
// ============================================================================

function createVSCodeAPI(extensionId) {
  const subscriptions = [];

  const api = {
    version: '1.85.0',

    // ── commands ──────────────────────────────────────────────
    commands: {
      registerCommand(command, callback, thisArg) {
        const handler = thisArg ? callback.bind(thisArg) : callback;
        commands.set(command, { extensionId, handler });
        emit('registerCommand', command, extensionId);
        const disposable = new Disposable(() => {
          commands.delete(command);
          emit('unregisterCommand', command);
        });
        subscriptions.push(disposable);
        return disposable;
      },
      async executeCommand(command, ...args) {
        const entry = commands.get(command);
        if (entry) return entry.handler(...args);
        process.stderr.write(`[remote-ext-host] Unknown command: ${command}\n`);
        return undefined;
      },
      async getCommands() { return Array.from(commands.keys()); },
    },

    // ── window ───────────────────────────────────────────────
    window: {
      showInformationMessage(message, ...rest) {
        emit('showMessage', 'info', message, rest);
        return Promise.resolve(undefined);
      },
      showWarningMessage(message, ...rest) {
        emit('showMessage', 'warning', message, rest);
        return Promise.resolve(undefined);
      },
      showErrorMessage(message, ...rest) {
        emit('showMessage', 'error', message, rest);
        return Promise.resolve(undefined);
      },
      showQuickPick(items, options) {
        emit('showQuickPick', items, options);
        return Promise.resolve(undefined);
      },
      showInputBox(options) {
        emit('showInputBox', options);
        return Promise.resolve(undefined);
      },

      createTreeView(viewId, options) {
        if (options.treeDataProvider) {
          treeDataProviders.set(viewId, {
            provider: options.treeDataProvider,
            extensionId,
          });
          emit('registerTreeView', viewId, extensionId);
          // Resolve tree data after a tick to let the extension finish init
          setTimeout(() => resolveTreeData(viewId), 100);
        }
        const onDidChangeVisibilityEmitter = new VscodeEventEmitter();
        return {
          dispose() {
            treeDataProviders.delete(viewId);
          },
          reveal() { return Promise.resolve(); },
          onDidChangeVisibility: onDidChangeVisibilityEmitter.event,
          visible: true,
          title: options.title || viewId,
          message: '',
          description: '',
          badge: undefined,
        };
      },

      registerTreeDataProvider(viewId, provider) {
        treeDataProviders.set(viewId, { provider, extensionId });
        emit('registerTreeView', viewId, extensionId);
        setTimeout(() => resolveTreeData(viewId), 100);
        return new Disposable(() => treeDataProviders.delete(viewId));
      },

      registerWebviewViewProvider(viewType, provider, options) {
        webviewViewProviders.set(viewType, { provider, extensionId });

        // Create a WebviewView to pass to the provider
        const htmlEmitter = new VscodeEventEmitter();
        const webviewView = {
          viewType,
          webview: {
            options: { enableScripts: true, ...(options || {}) },
            _html: '',
            get html() { return this._html; },
            set html(val) {
              this._html = val;
              emit('updateWebview', viewType, val);
            },
            onDidReceiveMessage: new VscodeEventEmitter().event,
            postMessage(msg) { emit('postWebviewMessage', viewType, msg); return Promise.resolve(true); },
            asWebviewUri(uri) { return uri; },
            cspSource: '',
          },
          visible: true,
          onDidDispose: new VscodeEventEmitter().event,
          onDidChangeVisibility: new VscodeEventEmitter().event,
          show() {},
          dispose() { webviewViewProviders.delete(viewType); },
          title: viewType,
          description: '',
          badge: undefined,
        };

        emit('createWebview', viewType, viewType, viewType, extensionId);

        // Resolve the provider
        try {
          const token = new CancellationTokenSource().token;
          const result = provider.resolveWebviewView(webviewView, { state: undefined }, token);
          if (result && typeof result.then === 'function') {
            result.catch(e => process.stderr.write(`[remote-ext-host] resolveWebviewView error: ${e.message}\n`));
          }
        } catch (e) {
          process.stderr.write(`[remote-ext-host] resolveWebviewView error: ${e.message}\n`);
        }

        return new Disposable(() => {
          webviewViewProviders.delete(viewType);
          emit('disposeWebview', viewType);
        });
      },

      createWebviewPanel(viewType, title, showOptions, panelOptions) {
        const viewId = `panel-${viewType}-${Date.now()}`;
        const htmlEmitter = new VscodeEventEmitter();
        const panel = {
          viewType,
          title,
          webview: {
            options: { enableScripts: true, ...(panelOptions || {}) },
            _html: '',
            get html() { return this._html; },
            set html(val) {
              this._html = val;
              emit('updateWebview', viewId, val);
            },
            onDidReceiveMessage: new VscodeEventEmitter().event,
            postMessage(msg) { emit('postWebviewMessage', viewId, msg); return Promise.resolve(true); },
            asWebviewUri(uri) { return uri; },
            cspSource: '',
          },
          visible: true,
          active: true,
          viewColumn: typeof showOptions === 'number' ? showOptions : showOptions?.viewColumn || ViewColumn.One,
          onDidDispose: new VscodeEventEmitter().event,
          onDidChangeViewState: new VscodeEventEmitter().event,
          reveal() {},
          dispose() { emit('disposeWebview', viewId); },
        };
        emit('createWebview', viewId, viewType, title, extensionId);
        return panel;
      },

      createOutputChannel(name, optionsOrLang) {
        // VS Code 1.74+ supports { log: true } → returns a LogOutputChannel
        // with trace/debug/info/warn/error methods.  Many extensions rely on
        // these, so we always provide them.
        const ch = {
          name,
          _lines: [],
          append(value) { ch._lines.push(value); },
          appendLine(value) { ch._lines.push(value + '\n'); emit('outputChannel', name, value); },
          clear() { ch._lines = []; },
          show() {},
          hide() {},
          dispose() {},
          replace(value) { ch._lines = [value]; },
          // LogOutputChannel methods (VS Code >=1.74)
          trace(...args) { ch.appendLine(`[trace] ${args.join(' ')}`); },
          debug(...args) { ch.appendLine(`[debug] ${args.join(' ')}`); },
          info(...args) { ch.appendLine(`[info] ${args.join(' ')}`); },
          warn(...args) { ch.appendLine(`[warn] ${args.join(' ')}`); },
          error(...args) { ch.appendLine(`[error] ${args.join(' ')}`); },
          // logLevel property (LogOutputChannel)
          logLevel: 2, // Info
          onDidChangeLogLevel: (listener) => new Disposable(() => {}),
        };
        return ch;
      },

      createStatusBarItem(alignmentOrId, priority) {
        const item = {
          alignment: typeof alignmentOrId === 'number' ? alignmentOrId : StatusBarAlignment.Left,
          priority: priority || 0,
          _text: '',
          get text() { return this._text; },
          set text(val) { this._text = val; },
          tooltip: '', command: '', color: '', backgroundColor: undefined,
          show() { emit('setStatusBar', this._text, 0); },
          hide() {},
          dispose() {},
        };
        return item;
      },

      setStatusBarMessage(text, timeoutOrThenable) {
        emit('setStatusBar', text, typeof timeoutOrThenable === 'number' ? timeoutOrThenable : 5000);
        return new Disposable(() => {});
      },

      get activeTextEditor() { return undefined; },
      get visibleTextEditors() { return []; },
      get activeTerminal() { return undefined; },
      get terminals() { return []; },
      onDidChangeActiveTextEditor: new VscodeEventEmitter().event,
      onDidChangeVisibleTextEditors: new VscodeEventEmitter().event,
      onDidChangeTextEditorSelection: new VscodeEventEmitter().event,
      withProgress(options, task) {
        const progress = { report() {} };
        const token = new CancellationTokenSource().token;
        return Promise.resolve(task(progress, token));
      },
    },

    // ── workspace ────────────────────────────────────────────
    workspace: {
      workspaceFolders: [{ uri: Uri.file('/workspace'), name: 'workspace', index: 0 }],
      rootPath: '/workspace',
      name: 'workspace',
      getConfiguration(section) {
        return {
          get(key, defaultValue) { return defaultValue; },
          has() { return false; },
          inspect() { return undefined; },
          update() { return Promise.resolve(); },
        };
      },
      onDidChangeConfiguration: new VscodeEventEmitter().event,
      onDidOpenTextDocument: new VscodeEventEmitter().event,
      onDidCloseTextDocument: new VscodeEventEmitter().event,
      onDidChangeTextDocument: new VscodeEventEmitter().event,
      onDidSaveTextDocument: new VscodeEventEmitter().event,
      createFileSystemWatcher() {
        return {
          onDidCreate: new VscodeEventEmitter().event,
          onDidChange: new VscodeEventEmitter().event,
          onDidDelete: new VscodeEventEmitter().event,
          dispose() {},
        };
      },
      openTextDocument() { return Promise.resolve({ uri: Uri.file(''), getText() { return ''; }, lineCount: 0 }); },
      applyEdit() { return Promise.resolve(true); },
      registerTextDocumentContentProvider() { return new Disposable(() => {}); },
      fs: {
        readFile(uri) { return fs.promises.readFile(uri.fsPath || uri.path); },
        writeFile(uri, content) { return fs.promises.writeFile(uri.fsPath || uri.path, content); },
        stat(uri) {
          return fs.promises.stat(uri.fsPath || uri.path).then(s => ({
            type: s.isDirectory() ? 2 : 1,
            ctime: s.ctimeMs, mtime: s.mtimeMs, size: s.size,
          }));
        },
        readDirectory(uri) {
          return fs.promises.readdir(uri.fsPath || uri.path, { withFileTypes: true }).then(entries =>
            entries.map(e => [e.name, e.isDirectory() ? 2 : 1])
          );
        },
        delete(uri) { return fs.promises.unlink(uri.fsPath || uri.path); },
        rename(oldUri, newUri) { return fs.promises.rename(oldUri.fsPath, newUri.fsPath); },
        createDirectory(uri) { return fs.promises.mkdir(uri.fsPath || uri.path, { recursive: true }); },
      },
    },

    // ── languages ────────────────────────────────────────────
    languages: {
      registerCompletionItemProvider() { return new Disposable(() => {}); },
      registerHoverProvider() { return new Disposable(() => {}); },
      registerDefinitionProvider() { return new Disposable(() => {}); },
      registerCodeActionsProvider() { return new Disposable(() => {}); },
      registerDocumentFormattingEditProvider() { return new Disposable(() => {}); },
      registerDocumentSymbolProvider() { return new Disposable(() => {}); },
      registerRenameProvider() { return new Disposable(() => {}); },
      createDiagnosticCollection(name) {
        const _entries = new Map();
        return {
          name: name || 'default',
          set(uri, diagnostics) { _entries.set(uri.toString(), diagnostics); },
          delete(uri) { _entries.delete(uri.toString()); },
          clear() { _entries.clear(); },
          forEach(cb) { _entries.forEach(cb); },
          get(uri) { return _entries.get(uri.toString()); },
          has(uri) { return _entries.has(uri.toString()); },
          dispose() { _entries.clear(); },
          [Symbol.iterator]() { return _entries[Symbol.iterator](); },
        };
      },
      match() { return 0; },
      getLanguages() { return Promise.resolve([]); },
      setTextDocumentLanguage() { return Promise.resolve(undefined); },
      onDidChangeDiagnostics: new VscodeEventEmitter().event,
    },

    // ── authentication ───────────────────────────────────────
    authentication: {
      getSession(providerId, scopes, options) {
        emit('authenticationGetSession', providerId, scopes, options);
        return Promise.resolve(undefined);
      },
      registerAuthenticationProvider(id, label, provider) {
        emit('registerAuthProvider', id, label);
        return new Disposable(() => {});
      },
      onDidChangeSessions: new VscodeEventEmitter().event,
    },

    // ── env ──────────────────────────────────────────────────
    env: {
      appName: 'Synthi',
      appRoot: process.cwd(),
      language: 'en',
      machineId: 'synthi-remote',
      sessionId: `session-${Date.now()}`,
      uriScheme: 'vscode',
      clipboard: {
        readText() { return Promise.resolve(''); },
        writeText() { return Promise.resolve(); },
      },
      openExternal(uri) {
        emit('openExternal', uri?.toString?.() || String(uri));
        return Promise.resolve(true);
      },
      asExternalUri(uri) { return Promise.resolve(uri); },
      createTelemetryLogger() {
        return { logUsage() {}, logError() {}, dispose() {} };
      },
    },

    // ── extensions ───────────────────────────────────────────
    extensions: {
      getExtension(id) {
        const ext = loadedExtensions.get(id);
        if (!ext) return undefined;
        return {
          id,
          extensionPath: '/extension',
          isActive: activeContexts.has(id),
          exports: ext.module,
          packageJSON: ext.manifest,
          extensionUri: Uri.file('/extension'),
          extensionKind: 2, // Workspace
          activate() { return Promise.resolve(ext.module); },
        };
      },
      get all() {
        return Array.from(loadedExtensions.entries()).map(([id, ext]) => ({
          id, extensionPath: '/extension', isActive: activeContexts.has(id),
          exports: ext.module, packageJSON: ext.manifest,
          extensionUri: Uri.file('/extension'), extensionKind: 2,
        }));
      },
      onDidChange: new VscodeEventEmitter().event,
    },

    // ── Types ────────────────────────────────────────────────
    Position,
    Range,
    Uri,
    EventEmitter: VscodeEventEmitter,
    Disposable,
    CancellationTokenSource,
    TreeItemCollapsibleState,
    DiagnosticSeverity,
    CompletionItemKind,
    StatusBarAlignment,
    ViewColumn,
    TreeItem: class TreeItem {
      constructor(labelOrUri, collapsibleState) {
        if (typeof labelOrUri === 'string') {
          this.label = labelOrUri;
        } else {
          this.resourceUri = labelOrUri;
        }
        this.collapsibleState = collapsibleState || TreeItemCollapsibleState.None;
      }
    },
    ThemeIcon: class ThemeIcon {
      constructor(id, color) { this.id = id; this.color = color; }
      static File = new (class { constructor() { this.id = 'file'; } })();
      static Folder = new (class { constructor() { this.id = 'folder'; } })();
    },
    ThemeColor: class ThemeColor {
      constructor(id) { this.id = id; }
    },
    MarkdownString: class MarkdownString {
      constructor(value) { this.value = value || ''; this.isTrusted = false; this.supportThemeIcons = false; }
      appendMarkdown(val) { this.value += val; return this; }
      appendText(val) { this.value += val; return this; }
      appendCodeblock(code, lang) { this.value += `\n\`\`\`${lang || ''}\n${code}\n\`\`\`\n`; return this; }
    },
    FileType: { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { SourceControl: 1, Window: 10, Notification: 15 },
    ExtensionMode: { Production: 1, Development: 2, Test: 3 },
    UIKind: { Desktop: 1, Web: 2 },
    ExtensionKind: { UI: 1, Workspace: 2 },
    LogLevel: { Off: 0, Trace: 1, Debug: 2, Info: 3, Warning: 4, Error: 5 },

    // ── l10n (localization) ──────────────────────────────────
    l10n: {
      t(message, ...args) {
        if (typeof message === 'object') return message.message || '';
        return String(message);
      },
      bundle: undefined,
      uri: undefined,
    },

    // ── comments API (used by GitHub PR extension) ──────────
    comments: {
      createCommentController(id, label) {
        const controller = {
          id, label, dispose() {},
          commentingRangeProvider: undefined,
          createCommentThread(uri, range, comments) {
            return {
              uri, range, comments, dispose() {},
              collapsibleState: 0, canReply: true, contextValue: '',
              label: '',
            };
          },
        };
        return controller;
      },
    },
  };

  // Create an extension context
  const context = {
    subscriptions,
    extensionPath: '/extension',
    extensionUri: Uri.file('/extension'),
    storagePath: '/tmp/synthi-ext-storage/' + extensionId,
    storageUri: Uri.file('/tmp/synthi-ext-storage/' + extensionId),
    globalStoragePath: '/tmp/synthi-ext-global-storage',
    globalStorageUri: Uri.file('/tmp/synthi-ext-global-storage'),
    logPath: '/tmp/synthi-ext-logs/' + extensionId,
    logUri: Uri.file('/tmp/synthi-ext-logs/' + extensionId),
    extensionMode: 1, // Production
    globalState: {
      _data: {},
      get(key, defaultValue) { return this._data[key] ?? defaultValue; },
      update(key, value) { this._data[key] = value; return Promise.resolve(); },
      keys() { return Object.keys(this._data); },
      setKeysForSync() {},
    },
    workspaceState: {
      _data: {},
      get(key, defaultValue) { return this._data[key] ?? defaultValue; },
      update(key, value) { this._data[key] = value; return Promise.resolve(); },
      keys() { return Object.keys(this._data); },
    },
    secrets: {
      _data: {},
      get(key) { return Promise.resolve(this._data[key]); },
      store(key, value) { this._data[key] = value; return Promise.resolve(); },
      delete(key) { delete this._data[key]; return Promise.resolve(); },
      onDidChange: new VscodeEventEmitter().event,
    },
    environmentVariableCollection: {
      persistent: true,
      description: '',
      replace() {}, append() {}, prepend() {}, get() { return undefined; },
      forEach() {}, delete() {}, clear() {},
      [Symbol.iterator]() { return [][Symbol.iterator](); },
      getScoped() { return this; },
    },
    extension: {
      id: extensionId,
      extensionUri: Uri.file('/extension'),
      extensionPath: '/extension',
      isActive: false,
      packageJSON: {},
      extensionKind: 2,
      exports: undefined,
    },
    languageModelAccessInformation: {
      onDidChange: new VscodeEventEmitter().event,
      canSendRequest() { return undefined; },
    },
  };

  // ---------------------------------------------------------------------------
  // Wrap the API in a Proxy so that ANY property access that isn't explicitly
  // defined still returns something usable.  This means extensions can do
  // `class Foo extends vscode.Whatever` or `vscode.SomeEnum.Value` without
  // crashing, even if we haven't manually shimmed that API surface yet.
  // ---------------------------------------------------------------------------
  const proxiedApi = new Proxy(api, {
    get(target, prop, receiver) {
      // Known property → return it
      if (prop in target) return Reflect.get(target, prop, receiver);
      // Symbols, toJSON, inspect, etc. → don't proxy
      if (typeof prop === 'symbol') return undefined;
      if (prop === 'toJSON' || prop === 'then' || prop === 'constructor') return undefined;

      // Build a dynamic class that:
      //  - Can be instantiated with `new vscode.X(...)`
      //  - Can be used as a base class: `class Foo extends vscode.X {}`
      //  - Has enum-style numeric statics: `vscode.X.SomeValue` → 0
      const dynClass = class DynamicVSCodeStub {
        constructor(...args) {
          // Store constructor args as properties for basic data-holder classes
          args.forEach((a, i) => { this[`_arg${i}`] = a; });
        }
      };
      Object.defineProperty(dynClass, 'name', { value: String(prop) });

      // Wrap the class in a Proxy so static property access (enum values)
      // returns auto-incrementing integers: vscode.X.Foo → 0, vscode.X.Bar → 1
      const enumCache = new Map();
      let enumCounter = 0;
      const proxiedClass = new Proxy(dynClass, {
        get(cls, key) {
          if (key in cls) return cls[key];
          if (typeof key === 'symbol') return undefined;
          if (key === 'prototype' || key === 'name' || key === 'length') return cls[key];
          // Auto-generate enum-style numeric value
          if (!enumCache.has(key)) {
            enumCache.set(key, enumCounter++);
          }
          return enumCache.get(key);
        }
      });

      // Cache it on the real target so the same object is returned every time
      target[prop] = proxiedClass;
      return proxiedClass;
    }
  });

  return { api: proxiedApi, context };
}

// ============================================================================
// Extension Lifecycle
// ============================================================================

async function loadExtension(extensionId, code, manifest) {
  if (loadedExtensions.has(extensionId)) {
    process.stderr.write(`[remote-ext-host] Re-loading: ${extensionId}\n`);
    try { await deactivateExtension(extensionId); } catch (_) {}
    loadedExtensions.delete(extensionId);
  }

  process.stderr.write(`[remote-ext-host] loadExtension called: ${extensionId} (code=${code === null ? 'null' : typeof code + ':' + (code?.length || 0)}, manifest=${manifest === null ? 'null' : typeof manifest})\n`);

  // If code is null, assemble from previously uploaded chunks
  if (code === null || code === undefined) {
    const upload = pendingCodeUploads.get(extensionId);
    process.stderr.write(`[remote-ext-host] Code upload status: ${upload ? upload.chunks.size + '/' + upload.total : 'NOT FOUND'}\n`);
    if (upload && upload.chunks.size === upload.total) {
      const parts = [];
      for (let i = 0; i < upload.total; i++) {
        parts.push(upload.chunks.get(i) || '');
      }
      code = parts.join('');
      pendingCodeUploads.delete(extensionId);
      process.stderr.write(
        `[remote-ext-host] Assembled code from ${upload.total} chunks (${code.length} chars) for ${extensionId}\n`
      );
    } else {
      const got = upload ? upload.chunks.size : 0;
      const expected = upload ? upload.total : '?';
      throw new Error(
        `No complete uploaded code for ${extensionId} (got ${got}/${expected} chunks)`
      );
    }
  }

  // If manifest is null, assemble from previously uploaded manifest chunks
  if (manifest === null || manifest === undefined) {
    process.stderr.write(`[remote-ext-host] Manifest is null, checking uploaded chunks...\n`);
    const mUpload = pendingManifestUploads.get(extensionId);
    if (mUpload && mUpload.chunks.size === mUpload.total) {
      const mParts = [];
      for (let i = 0; i < mUpload.total; i++) {
        mParts.push(mUpload.chunks.get(i) || '');
      }
      const manifestJson = mParts.join('');
      pendingManifestUploads.delete(extensionId);
      try {
        manifest = JSON.parse(manifestJson);
        process.stderr.write(
          `[remote-ext-host] Assembled manifest from ${mUpload.total} chunks for ${extensionId}\n`
        );
      } catch (e) {
        throw new Error(`Failed to parse assembled manifest for ${extensionId}: ${e.message}`);
      }
    } else {
      const got = mUpload ? mUpload.chunks.size : 0;
      const expected = mUpload ? mUpload.total : '?';
      throw new Error(
        `No complete uploaded manifest for ${extensionId} (got ${got}/${expected} chunks)`
      );
    }
  }

  process.stderr.write(`[remote-ext-host] Loading: ${extensionId} (code length: ${code?.length || 0})\n`);

  const { api: vscode, context } = createVSCodeAPI(extensionId);
  context.extension.packageJSON = manifest;

  try {
    // ── Write extension to disk so Node.js loads it via the real module system ──
    const safeId = extensionId.replace(/[^a-zA-Z0-9._-]/g, '_');
    const extDir = path.join(os.tmpdir(), 'synthi-ext-host', safeId);
    fs.mkdirSync(extDir, { recursive: true });
    const extFile = path.join(extDir, 'extension.js');
    fs.writeFileSync(extFile, code, 'utf-8');

    // Write a minimal package.json so Node module resolution works
    fs.writeFileSync(
      path.join(extDir, 'package.json'),
      JSON.stringify({ name: safeId, version: '1.0.0', main: 'extension.js' }),
    );

    // Update context paths to point at the real directory
    context.extensionPath = extDir;
    context.extensionUri = Uri.file(extDir);
    context.extension.extensionPath = extDir;
    context.extension.extensionUri = Uri.file(extDir);

    // ── Inject `require('vscode')` into the module cache ──
    // This is exactly what VS Code's real extension host does — the
    // `vscode` module isn't an npm package, it's provided by the host
    // process and placed in the module cache.
    const vscodeModulePath = require.resolve('vscode').catch?.(() => null) || 'vscode';
    require.cache['vscode'] = {
      id: 'vscode',
      filename: 'vscode',
      loaded: true,
      exports: vscode,
      parent: null,
      children: [],
      paths: [],
    };

    // Also hook Module._resolveFilename so `require('vscode')` works
    // even from nested modules (the cache key alone isn't always enough).
    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
      if (request === 'vscode') return 'vscode';
      return origResolve.call(this, request, parent, isMain, options);
    };

    process.stderr.write(`[remote-ext-host] Loading ${extensionId} via require('${extFile}')\n`);
    const loadStart = Date.now();

    // Clear any stale cached version from a previous load
    delete require.cache[require.resolve?.(extFile) || extFile];
    delete require.cache[extFile];

    // Load the extension through Node.js's real module system
    const extensionModule = require(extFile);

    process.stderr.write(
      `[remote-ext-host] require() completed in ${Date.now() - loadStart}ms\n`,
    );

    // Restore original resolver (keep the cache entry for `vscode`)
    Module._resolveFilename = origResolve;

    if (typeof extensionModule.activate !== 'function') {
      throw new Error('Extension must export an activate() function');
    }

    loadedExtensions.set(extensionId, {
      module: extensionModule,
      manifest,
      vscode,
      context,
    });

    process.stderr.write(`[remote-ext-host] Loaded: ${extensionId}\n`);
    return { success: true, extensionId };
  } catch (err) {
    process.stderr.write(
      `[remote-ext-host] Load failed for ${extensionId}: ${err.message}\n${err.stack}\n`,
    );
    throw err;
  }
}

/**
 * Load an extension from its installed directory on disk.
 * Unlike loadExtension(), this preserves the extension's full directory
 * structure so multi-file extensions and relative requires work.
 *
 * @param {string} extensionId  e.g. "publisher.name"
 * @param {string} extensionPath  Absolute path to the extension directory
 * @returns {Promise<{success: boolean, extensionId: string}>}
 */
async function loadExtensionFromPath(extensionId, extensionPath) {
  if (loadedExtensions.has(extensionId)) {
    process.stderr.write(`[remote-ext-host] Re-loading from path: ${extensionId}\n`);
    try { await deactivateExtension(extensionId); } catch (_) {}
    loadedExtensions.delete(extensionId);
  }

  process.stderr.write(`[remote-ext-host] loadExtensionFromPath: ${extensionId} at ${extensionPath}\n`);

  // Read manifest from the extension directory
  const pkgPath = path.join(extensionPath, 'package.json');
  if (!fs.existsSync(pkgPath)) {
    throw new Error(`package.json not found at ${pkgPath}`);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  } catch (e) {
    throw new Error(`Failed to parse package.json for ${extensionId}: ${e.message}`);
  }

  // Resolve the main entry point (Node-style: try .js, /index.js)
  const mainEntry = manifest.main || 'extension.js';
  let mainPath = path.resolve(extensionPath, mainEntry);
  if (!fs.existsSync(mainPath)) {
    if (fs.existsSync(mainPath + '.js')) {
      mainPath = mainPath + '.js';
    } else if (fs.existsSync(path.join(mainPath, 'index.js'))) {
      mainPath = path.join(mainPath, 'index.js');
    }
    // If still not found, let require() try — it handles more resolution cases
  }

  const { api: vscode, context } = createVSCodeAPI(extensionId);
  context.extension.packageJSON = manifest;
  context.extensionPath = extensionPath;
  context.extensionUri = Uri.file(extensionPath);
  context.extension.extensionPath = extensionPath;
  context.extension.extensionUri = Uri.file(extensionPath);

  try {
    // Inject `require('vscode')` into the module cache
    require.cache['vscode'] = {
      id: 'vscode',
      filename: 'vscode',
      loaded: true,
      exports: vscode,
      parent: null,
      children: [],
      paths: [],
    };

    const origResolve = Module._resolveFilename;
    Module._resolveFilename = function (request, parent, isMain, options) {
      if (request === 'vscode') return 'vscode';
      return origResolve.call(this, request, parent, isMain, options);
    };

    process.stderr.write(`[remote-ext-host] Loading ${extensionId} from path: ${mainPath}\n`);
    const loadStart = Date.now();

    // Clear stale cache for the main file
    try { delete require.cache[require.resolve(mainPath)]; } catch (_) {}

    const extensionModule = require(mainPath);

    process.stderr.write(
      `[remote-ext-host] require() from path completed in ${Date.now() - loadStart}ms\n`,
    );

    Module._resolveFilename = origResolve;

    if (typeof extensionModule.activate !== 'function') {
      throw new Error('Extension must export an activate() function');
    }

    loadedExtensions.set(extensionId, {
      module: extensionModule,
      manifest,
      vscode,
      context,
    });

    process.stderr.write(`[remote-ext-host] Loaded from path: ${extensionId}\n`);
    return { success: true, extensionId };
  } catch (err) {
    process.stderr.write(
      `[remote-ext-host] Load from path failed for ${extensionId}: ${err.message}\n${err.stack}\n`,
    );
    throw err;
  }
}

async function activateExtension(extensionId) {
  const ext = loadedExtensions.get(extensionId);
  if (!ext) throw new Error(`Extension ${extensionId} not loaded`);

  process.stderr.write(`[remote-ext-host] Activating: ${extensionId}\n`);
  const start = Date.now();

  try {
    await ext.module.activate(ext.context);
    activeContexts.set(extensionId, ext.context);
    const activationTime = Date.now() - start;
    process.stderr.write(`[remote-ext-host] Activated: ${extensionId} in ${activationTime}ms\n`);
    return { success: true, activationTime };
  } catch (err) {
    process.stderr.write(`[remote-ext-host] Activation failed for ${extensionId}: ${err.message}\n${err.stack}\n`);
    return { success: false, error: err.message };
  }
}

async function deactivateExtension(extensionId) {
  const ext = loadedExtensions.get(extensionId);
  if (!ext) return;
  try {
    if (typeof ext.module.deactivate === 'function') {
      await ext.module.deactivate();
    }
  } catch (_) {}
  activeContexts.delete(extensionId);
  // Clean up context subscriptions
  if (ext.context?.subscriptions) {
    for (const sub of ext.context.subscriptions) {
      try { sub.dispose(); } catch (_) {}
    }
  }
}

// ============================================================================
// Event Handler (fire-and-forget messages from browser)
// ============================================================================

function handleEvent(msg) {
  const { method, args = [] } = msg;
  switch (method) {
    case 'uploadCodeChunk': {
      const [extensionId, chunkIndex, totalChunks, data] = args;
      if (!pendingCodeUploads.has(extensionId)) {
        pendingCodeUploads.set(extensionId, {
          chunks: new Map(),
          total: totalChunks,
          created: Date.now(),
        });
      }
      const entry = pendingCodeUploads.get(extensionId);
      entry.chunks.set(chunkIndex, data);
      if (entry.chunks.size % 50 === 0 || entry.chunks.size === entry.total) {
        process.stderr.write(
          `[remote-ext-host] uploadCodeChunk ${extensionId}: ${entry.chunks.size}/${entry.total}\n`
        );
      }
      break;
    }
    case 'uploadManifestChunk': {
      const [extensionId, chunkIndex, totalChunks, data] = args;
      if (!pendingManifestUploads.has(extensionId)) {
        pendingManifestUploads.set(extensionId, {
          chunks: new Map(),
          total: totalChunks,
          created: Date.now(),
        });
      }
      const mEntry = pendingManifestUploads.get(extensionId);
      mEntry.chunks.set(chunkIndex, data);
      if (mEntry.chunks.size === mEntry.total) {
        process.stderr.write(
          `[remote-ext-host] uploadManifestChunk ${extensionId}: ${mEntry.chunks.size}/${mEntry.total} (complete)\n`
        );
      }
      break;
    }
    default:
      break;
  }
}

// ============================================================================
// Message Handler
// ============================================================================

async function handleMessage(msg) {
  if (!msg || typeof msg !== 'object') return;

  // Handle fire-and-forget events (e.g. streamed code chunks)
  if (msg.type === 'event') {
    handleEvent(msg);
    return;
  }

  if (msg.type !== 'request') return;

  const { id, method, args = [] } = msg;
  process.stderr.write(`[remote-ext-host] RPC request: ${method} (id=${id}, args count=${args.length})\n`);

  try {
    let result;
    switch (method) {
      case 'ping':
        result = { pong: true, timestamp: Date.now(), generation: GENERATION };
        break;
      case 'loadExtension':
        result = await loadExtension(...args);
        break;
      case 'loadExtensionFromPath':
        result = await loadExtensionFromPath(...args);
        break;
      case 'activateExtension':
        result = await activateExtension(...args);
        break;
      case 'deactivateExtension':
        result = await deactivateExtension(...args);
        break;
      case 'executeCommand': {
        const [commandId, ...cmdArgs] = args;
        const entry = commands.get(commandId);
        if (entry) {
          result = await entry.handler(...cmdArgs);
        } else {
          throw new Error(`Unknown command: ${commandId}`);
        }
        break;
      }
      case 'resolveTreeData': {
        const [viewId] = args;
        await resolveTreeData(viewId);
        result = { success: true };
        break;
      }
      case 'getExtensionStates': {
        const states = {};
        for (const [id, ext] of loadedExtensions) {
          states[id] = { loaded: true, active: activeContexts.has(id) };
        }
        result = states;
        break;
      }
      default:
        throw new Error(`Unknown method: ${method}`);
    }
    send(createResponse(id, result));
  } catch (err) {
    process.stderr.write(`[remote-ext-host] ${method} failed: ${err.message}\n`);
    send(createResponse(id, null, err));
  }
}

// ============================================================================
// Chunk reassembler (browser sends large messages in pieces)
// ============================================================================

/** @type {Map<number, {chunks: Map<number, string>, total: number, created: number}>} */
const pendingChunks = new Map();

/**
 * If `msg` is a chunk wrapper ({__chunk, msgId, idx, total, data}), buffer it
 * and return the reassembled full message once all chunks arrive.  Returns
 * null while chunks are still pending.  Non-chunk messages are returned as-is.
 */
function handleChunk(msg) {
  if (!msg || !msg.__chunk) return msg; // not a chunk

  const { msgId, idx, total, data } = msg;
  if (!pendingChunks.has(msgId)) {
    pendingChunks.set(msgId, { chunks: new Map(), total, created: Date.now() });
  }
  const entry = pendingChunks.get(msgId);
  entry.chunks.set(idx, data);

  if (entry.chunks.size < entry.total) return null; // still waiting

  // All chunks received — reassemble in order
  pendingChunks.delete(msgId);
  const parts = [];
  for (let i = 0; i < entry.total; i++) {
    parts.push(entry.chunks.get(i) || '');
  }
  const fullJson = parts.join('');
  try {
    return JSON.parse(fullJson);
  } catch (e) {
    process.stderr.write(`[remote-ext-host] Chunk reassembly parse error (msgId=${msgId}): ${e.message}\n`);
    return null;
  }
}

// GC stale incomplete chunks every 30s
setInterval(() => {
  const now = Date.now();
  for (const [id, entry] of pendingChunks) {
    if (now - entry.created > 60000) {
      process.stderr.write(`[remote-ext-host] Dropping stale chunk group msgId=${id}\n`);
      pendingChunks.delete(id);
    }
  }
  // Also GC stale code uploads (extensions that never called loadExtension)
  for (const [id, entry] of pendingCodeUploads) {
    if (now - entry.created > 120000) {
      process.stderr.write(`[remote-ext-host] Dropping stale code upload for ${id}\n`);
      pendingCodeUploads.delete(id);
    }
  }
  for (const [id, entry] of pendingManifestUploads) {
    if (now - entry.created > 120000) {
      process.stderr.write(`[remote-ext-host] Dropping stale manifest upload for ${id}\n`);
      pendingManifestUploads.delete(id);
    }
  }
}, 30000);

// ============================================================================
// stdin/stdout I/O
// ============================================================================

const rl = readline.createInterface({ input: process.stdin });

rl.on('line', (line) => {
  if (!line.trim()) return;
  try {
    const raw = JSON.parse(line);
    // Handle chunked messages from the browser
    const msg = handleChunk(raw);
    if (msg) {
      handleMessage(msg);
    }
  } catch (e) {
    process.stderr.write(`[remote-ext-host] Parse error: ${e.message}\n`);
  }
});

rl.on('close', () => {
  process.stderr.write('[remote-ext-host] stdin closed, shutting down\n');
  process.exit(0);
});

// Signal ready
emit('workerReady', GENERATION);
process.stderr.write('[remote-ext-host] Remote extension host ready\n');
