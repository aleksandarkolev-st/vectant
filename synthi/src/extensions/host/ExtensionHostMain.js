/**
 * Synthi Extension System - Extension Host Main
 * Core logic for the extension host worker
 */

import { 
  createResponse, 
  createEvent, 
  createRequest,
  isValidMessage,
  MainToWorkerMethods,
  MainToWorkerMethodsExtended,
  WorkerToMainMethods 
} from '../bridge/MessageProtocol.js';
import { ExtensionRegistry } from './ExtensionRegistry.js';
import { ActivationManager } from './ActivationManager.js';
import { createExtensionContext } from './ExtensionContext.js';
import { createVSCodeAPI } from '../api/vscode.js';

export class ExtensionHostMain {
  constructor() {
    /** @type {ExtensionRegistry} */
    this.registry = new ExtensionRegistry();
    
    /** @type {ActivationManager} */
    this.activationManager = new ActivationManager(this);
    
    /** @type {Map<string, object>} Loaded extension modules */
    this.loadedExtensions = new Map();
    
    /** @type {Map<string, object>} Active extension contexts */
    this.activeContexts = new Map();
    
    /** @type {Map<string, Function>} Registered commands */
    this.commands = new Map();
    
    /** @type {Map<string, object>} Open text documents */
    this.documents = new Map();
    
    /** @type {Map<string, Set<string>>} Commands by extension */
    this.commandsByExtension = new Map();
    
    /** @type {object} Performance metrics per extension */
    this.metrics = new Map();
    
    /** @type {Set<string>} Suspended extensions */
    this.suspended = new Set();

    /** @type {Map<string, object>} Language providers registered by extensions */
    this._languageProviders = new Map();

    /** @type {Map<number, { resolve: Function, reject: Function }>} Pending round-trip UI requests */
    this._pendingRequests = new Map();

    /** @type {number} Request ID counter for main→worker requests */
    this._requestIdCounter = 0;

    /** @type {object|null} Active text editor state pushed from main thread */
    this._activeTextEditor = null;

    /** @type {Map<string, object>} File watchers by watcher ID */
    this._fileWatchers = new Map();

    /** @type {Map<string, object>} Terminals by ID */
    this._terminals = new Map();

    // Bind methods
    this.handleMessage = this.handleMessage.bind(this);
  }

  /**
   * Handle incoming message from main thread
   * @param {object} msg
   */
  handleMessage(msg) {
    if (!isValidMessage(msg)) {
      console.warn('[ExtensionHost] Invalid message:', msg);
      return;
    }

    if (msg.type === 'request') {
      this._handleRequest(msg);
    } else if (msg.type === 'event') {
      this._handleEvent(msg);
    } else if (msg.type === 'response') {
      // Handle responses to requests we sent to the main thread
      const pending = this._pendingRequests.get(msg.id);
      if (pending) {
        this._pendingRequests.delete(msg.id);
        if (msg.error) {
          pending.reject(new Error(msg.error.message));
        } else {
          pending.resolve(msg.result);
        }
      }
    }
  }

  /**
   * Handle request (expects response)
   * @param {object} msg
   */
  async _handleRequest(msg) {
    const { id, method, args = [], generation } = msg;

    try {
      let result;

      switch (method) {
        case MainToWorkerMethods.LOAD_EXTENSION:
          result = await this._loadExtension(...args);
          break;

        case MainToWorkerMethods.ACTIVATE_EXTENSION:
          result = await this._activateExtension(...args);
          break;

        case MainToWorkerMethods.DEACTIVATE_EXTENSION:
          result = await this._deactivateExtension(...args);
          break;

        case MainToWorkerMethods.EXECUTE_COMMAND:
          result = await this._executeCommand(...args);
          break;

        case MainToWorkerMethods.GET_METRICS:
          result = this._getMetrics();
          break;

        case MainToWorkerMethods.SUSPEND_EXTENSION:
          result = this._suspendExtension(...args);
          break;

        case MainToWorkerMethods.RESUME_EXTENSION:
          result = this._resumeExtension(...args);
          break;

        case MainToWorkerMethods.KILL_EXTENSION:
          result = await this._killExtension(...args);
          break;

        // ─── Language Provider Invocations (Main → Worker) ───────────
        case 'lang/provideCompletion':
          result = await this._invokeLanguageProvider(args[0], 'provideCompletionItems', args.slice(1));
          break;
        case 'lang/provideHover':
          result = await this._invokeLanguageProvider(args[0], 'provideHover', args.slice(1));
          break;
        case 'lang/provideDefinition':
          result = await this._invokeLanguageProvider(args[0], 'provideDefinition', args.slice(1));
          break;
        case 'lang/provideTypeDefinition':
          result = await this._invokeLanguageProvider(args[0], 'provideTypeDefinition', args.slice(1));
          break;
        case 'lang/provideImplementation':
          result = await this._invokeLanguageProvider(args[0], 'provideImplementation', args.slice(1));
          break;
        case 'lang/provideReferences':
          result = await this._invokeLanguageProvider(args[0], 'provideReferences', args.slice(1));
          break;
        case 'lang/provideDocumentHighlights':
          result = await this._invokeLanguageProvider(args[0], 'provideDocumentHighlights', args.slice(1));
          break;
        case 'lang/provideDocumentSymbols':
          result = await this._invokeLanguageProvider(args[0], 'provideDocumentSymbols', args.slice(1));
          break;
        case 'lang/provideCodeActions':
          result = await this._invokeLanguageProvider(args[0], 'provideCodeActions', args.slice(1));
          break;
        case 'lang/provideCodeLenses':
          result = await this._invokeLanguageProvider(args[0], 'provideCodeLenses', args.slice(1));
          break;
        case 'lang/resolveCodeLens':
          result = await this._invokeLanguageProvider(args[0], 'resolveCodeLens', args.slice(1));
          break;
        case 'lang/provideFormatting':
          result = await this._invokeLanguageProvider(args[0], 'provideDocumentFormattingEdits', args.slice(1));
          break;
        case 'lang/provideRangeFormatting':
          result = await this._invokeLanguageProvider(args[0], 'provideDocumentRangeFormattingEdits', args.slice(1));
          break;
        case 'lang/provideOnTypeFormatting':
          result = await this._invokeLanguageProvider(args[0], 'provideOnTypeFormattingEdits', args.slice(1));
          break;
        case 'lang/provideSignatureHelp':
          result = await this._invokeLanguageProvider(args[0], 'provideSignatureHelp', args.slice(1));
          break;
        case 'lang/provideRename':
          result = await this._invokeLanguageProvider(args[0], 'provideRenameEdits', args.slice(1));
          break;
        case 'lang/prepareRename':
          result = await this._invokeLanguageProvider(args[0], 'prepareRename', args.slice(1));
          break;
        case 'lang/provideDocumentLinks':
          result = await this._invokeLanguageProvider(args[0], 'provideDocumentLinks', args.slice(1));
          break;
        case 'lang/provideColors':
          result = await this._invokeLanguageProvider(args[0], 'provideDocumentColors', args.slice(1));
          break;
        case 'lang/provideColorPresentations':
          result = await this._invokeLanguageProvider(args[0], 'provideColorPresentations', args.slice(1));
          break;
        case 'lang/provideFoldingRanges':
          result = await this._invokeLanguageProvider(args[0], 'provideFoldingRanges', args.slice(1));
          break;
        case 'lang/provideSelectionRanges':
          result = await this._invokeLanguageProvider(args[0], 'provideSelectionRanges', args.slice(1));
          break;
        case 'lang/provideInlayHints':
          result = await this._invokeLanguageProvider(args[0], 'provideInlayHints', args.slice(1));
          break;
        case 'lang/provideInlineCompletions':
          result = await this._invokeLanguageProvider(args[0], 'provideInlineCompletions', args.slice(1));
          break;
        case 'lang/provideSemanticTokens':
          result = await this._invokeLanguageProvider(args[0], 'provideDocumentSemanticTokens', args.slice(1));
          break;
        case 'lang/resolveCompletionItem':
          result = await this._resolveCompletionItem(args[0], args[1]);
          break;

        // ─── Tree View data requests (Main → Worker) ────────────────
        case 'treeView/getChildren':
          result = await this._getTreeViewChildren(...args);
          break;
        case 'treeView/getTreeItem':
          result = await this._getTreeViewItem(...args);
          break;

        default:
          throw new Error(`Unknown method: ${method}`);
      }

      self.postMessage(createResponse(id, result, null, generation));
    } catch (err) {
      self.postMessage(createResponse(id, null, err, generation));
    }
  }

  /**
   * Handle event (no response expected)
   * @param {object} msg
   */
  _handleEvent(msg) {
    const { method, args = [] } = msg;

    switch (method) {
      case MainToWorkerMethods.TEXT_DOCUMENT_OPEN:
        this._onDocumentOpen(...args);
        break;

      case MainToWorkerMethods.TEXT_DOCUMENT_CLOSE:
        this._onDocumentClose(...args);
        break;

      case MainToWorkerMethods.TEXT_DOCUMENT_CHANGE:
        this._onDocumentChange(...args);
        break;

      case MainToWorkerMethods.SELECTION_CHANGE:
        this._onSelectionChange(...args);
        break;

      case MainToWorkerMethods.CONFIGURATION_CHANGE:
        this._onConfigurationChange(...args);
        break;

      case MainToWorkerMethods.WEBVIEW_MESSAGE:
        this._onWebviewMessage(...args);
        break;

      case MainToWorkerMethods.WEBVIEW_VISIBILITY:
        this._onWebviewVisibility(...args);
        break;

      case MainToWorkerMethods.WEBVIEW_DISPOSE:
        this._onWebviewDispose(...args);
        break;

      // ─── Extended events from Main → Worker ─────────────────────
      case 'editor/activeChanged':
        this._onActiveEditorChanged(...args);
        break;

      case 'fs/watcherEvent':
        this._onFileWatcherEvent(...args);
        break;
    }
  }

  /**
   * Send event to main thread
   * @param {string} method
   * @param {...any} args
   */
  emit(method, ...args) {
    self.postMessage(createEvent(method, args));
  }

  /**
   * Send a request to the main thread and wait for a response (round-trip RPC).
   * Used for UI round-trips: showQuickPick, showInputBox, fs operations, etc.
   * @param {string} method
   * @param {any[]} args
   * @param {number} [timeout=30000]
   * @returns {Promise<any>}
   */
  request(method, args = [], timeout = 30000) {
    const msg = createRequest(method, args);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pendingRequests.delete(msg.id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this._pendingRequests.set(msg.id, {
        resolve: (result) => { clearTimeout(timer); resolve(result); },
        reject: (err) => { clearTimeout(timer); reject(err); }
      });

      self.postMessage(msg);
    });
  }

  // ===========================================================================
  // Extension Lifecycle
  // ===========================================================================

  /**
   * Load extension code into worker (does not activate)
   * @param {string} extensionId
   * @param {string} code
   * @param {object} manifest
   */
  async _loadExtension(extensionId, code, manifest) {
    if (this.loadedExtensions.has(extensionId)) {
      throw new Error(`Extension ${extensionId} already loaded`);
    }

    // Register metadata
    this.registry.register(extensionId, manifest);

    // Create sandboxed execution environment
    const extensionModule = await this._evaluateExtensionCode(extensionId, code, manifest);
    
    this.loadedExtensions.set(extensionId, {
      module: extensionModule,
      manifest,
      code
    });

    // Initialize metrics
    this.metrics.set(extensionId, {
      extensionId,
      activationTime: 0,
      cpuTime: 0,
      heapUsed: 0,
      messageCount: 0,
      lastActivity: 0,
      violations: []
    });

    return { success: true };
  }

  /**
   * Evaluate extension code in sandboxed environment
   * @param {string} extensionId
   * @param {string} code
   * @param {object} manifest
   * @returns {Promise<object>}
   */
  async _evaluateExtensionCode(extensionId, code, manifest) {
    // Create the VS Code API for this extension
    const vscode = createVSCodeAPI(extensionId, this);

    // Create a sandboxed function that returns the module exports
    // Extensions expect to be able to require('vscode')
    const wrappedCode = `
      (function(vscode, exports, module) {
        ${code}
        return module.exports;
      })
    `;

    try {
      // eslint-disable-next-line no-new-func
      const factory = new Function('return ' + wrappedCode)();
      const exports = {};
      const module = { exports };

      const result = factory(vscode, exports, module);
      
      return result || module.exports;
    } catch (err) {
      console.error(`[ExtensionHost] Failed to evaluate ${extensionId}:`, err);
      throw err;
    }
  }

  /**
   * Activate an extension
   * @param {string} extensionId
   * @returns {Promise<{ success: boolean, activationTime: number, error?: string }>}
   */
  async _activateExtension(extensionId) {
    return this.activationManager.activate(extensionId);
  }

  /**
   * Deactivate an extension
   * @param {string} extensionId
   */
  async _deactivateExtension(extensionId) {
    const ext = this.loadedExtensions.get(extensionId);
    if (!ext) return;

    const ctx = this.activeContexts.get(extensionId);
    
    // Call deactivate if exists
    if (ext.module && typeof ext.module.deactivate === 'function') {
      try {
        await Promise.resolve(ext.module.deactivate());
      } catch (err) {
        console.error(`[ExtensionHost] Deactivate error for ${extensionId}:`, err);
      }
    }

    // Dispose subscriptions
    if (ctx) {
      for (const disposable of ctx.subscriptions) {
        try {
          disposable.dispose();
        } catch (err) {
          // Ignore disposal errors
        }
      }
      this.activeContexts.delete(extensionId);
    }

    // Unregister commands
    const commands = this.commandsByExtension.get(extensionId);
    if (commands) {
      for (const cmdId of commands) {
        this.commands.delete(cmdId);
        this.emit(WorkerToMainMethods.UNREGISTER_COMMAND, cmdId);
      }
      this.commandsByExtension.delete(extensionId);
    }

    return { success: true };
  }

  /**
   * Suspend an extension (pause without deactivating)
   * @param {string} extensionId
   */
  _suspendExtension(extensionId) {
    this.suspended.add(extensionId);
    return { success: true };
  }

  /**
   * Resume a suspended extension
   * @param {string} extensionId
   */
  _resumeExtension(extensionId) {
    this.suspended.delete(extensionId);
    return { success: true };
  }

  /**
   * Kill an extension (force deactivate and unload)
   * @param {string} extensionId
   */
  async _killExtension(extensionId) {
    await this._deactivateExtension(extensionId);
    this.loadedExtensions.delete(extensionId);
    this.registry.unregister(extensionId);
    this.suspended.delete(extensionId);
    this.metrics.delete(extensionId);
    return { success: true };
  }

  // ===========================================================================
  // Commands
  // ===========================================================================

  /**
   * Register a command handler
   * @param {string} extensionId
   * @param {string} commandId
   * @param {Function} handler
   */
  registerCommand(extensionId, commandId, handler) {
    if (this.commands.has(commandId)) {
      throw new Error(`Command ${commandId} already registered`);
    }

    this.commands.set(commandId, { extensionId, handler });
    
    if (!this.commandsByExtension.has(extensionId)) {
      this.commandsByExtension.set(extensionId, new Set());
    }
    this.commandsByExtension.get(extensionId).add(commandId);

    this.emit(WorkerToMainMethods.REGISTER_COMMAND, commandId, extensionId);

    return {
      dispose: () => {
        this.commands.delete(commandId);
        const cmds = this.commandsByExtension.get(extensionId);
        if (cmds) cmds.delete(commandId);
        this.emit(WorkerToMainMethods.UNREGISTER_COMMAND, commandId);
      }
    };
  }

  /**
   * Execute a command
   * @param {string} commandId
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async _executeCommand(commandId, ...args) {
    const cmd = this.commands.get(commandId);
    if (!cmd) {
      throw new Error(`Command not found: ${commandId}`);
    }

    // Check if extension is suspended
    if (this.suspended.has(cmd.extensionId)) {
      throw new Error(`Extension ${cmd.extensionId} is suspended`);
    }

    const startTime = performance.now();

    try {
      const result = await Promise.resolve(cmd.handler(...args));
      
      // Track CPU time
      const elapsed = performance.now() - startTime;
      this._trackCpuTime(cmd.extensionId, elapsed);

      return result;
    } catch (err) {
      console.error(`[ExtensionHost] Command ${commandId} error:`, err);
      throw err;
    }
  }

  // ===========================================================================
  // Document Events
  // ===========================================================================

  /**
   * Handle document open
   * @param {object} docInfo
   */
  _onDocumentOpen(docInfo) {
    this.documents.set(docInfo.uri, {
      uri: docInfo.uri,
      fileName: docInfo.fileName,
      languageId: docInfo.languageId,
      version: docInfo.version,
      lineCount: docInfo.lineCount,
      content: docInfo.content
    });
  }

  /**
   * Handle document close
   * @param {string} uri
   */
  _onDocumentClose(uri) {
    this.documents.delete(uri);
  }

  /**
   * Handle document change
   * @param {string} uri
   * @param {object[]} changes
   * @param {number} version
   */
  _onDocumentChange(uri, changes, version) {
    const doc = this.documents.get(uri);
    if (doc) {
      doc.version = version;
      // Apply changes to content so providers always have current text.
      // Changes are in VS Code format: { range: { start: { line, character }, end: { line, character } }, text }
      if (doc.content !== undefined && Array.isArray(changes)) {
        let content = doc.content;
        // Apply changes in reverse offset order to keep indices valid
        const sorted = [...changes].sort((a, b) => {
          const aOff = this._offsetInContent(content, a.range?.end || a.range?.start);
          const bOff = this._offsetInContent(content, b.range?.end || b.range?.start);
          return bOff - aOff;
        });
        for (const change of sorted) {
          if (change.range) {
            const startOff = this._offsetInContent(content, change.range.start);
            const endOff = this._offsetInContent(content, change.range.end);
            content = content.substring(0, startOff) + (change.text || '') + content.substring(endOff);
          }
        }
        doc.content = content;
        doc.lineCount = content.split('\n').length;
      }
    }
  }

  /**
   * Compute byte offset in content from a {line, character} position.
   */
  _offsetInContent(content, pos) {
    if (!pos) return 0;
    const lines = content.split('\n');
    let offset = 0;
    for (let i = 0; i < (pos.line ?? 0) && i < lines.length; i++) {
      offset += lines[i].length + 1; // +1 for \n
    }
    return offset + (pos.character ?? 0);
  }

  /**
   * Handle selection change
   * @param {string} uri
   * @param {object[]} selections
   */
  _onSelectionChange(uri, selections) {
    // Dispatch to extensions listening for selection changes
    // This is intentionally minimal - most extensions don't need this
  }

  /**
   * Handle configuration change
   * @param {object} change
   */
  _onConfigurationChange(change) {
    // Notify extensions of configuration changes
  }

  // ===========================================================================
  // Webview Events
  // ===========================================================================

  _onWebviewMessage(viewId, message) {
    // Route to appropriate extension
  }

  _onWebviewVisibility(viewId, visible) {
    // Pause/resume webview-related processing
  }

  _onWebviewDispose(viewId) {
    // Clean up webview resources
  }

  // ===========================================================================
  // Performance Tracking
  // ===========================================================================

  /**
   * Track CPU time for an extension
   * @param {string} extensionId
   * @param {number} ms
   */
  _trackCpuTime(extensionId, ms) {
    const metrics = this.metrics.get(extensionId);
    if (metrics) {
      metrics.cpuTime += ms;
      metrics.lastActivity = Date.now();

      // Check for CPU budget violation (50ms per second)
      // This is a simplified check - real implementation would use rolling window
      if (ms > 50) {
        metrics.violations.push({
          type: 'cpu',
          timestamp: Date.now(),
          value: ms,
          limit: 50
        });
      }
    }
  }

  /**
   * Get performance metrics
   * @returns {object}
   */
  _getMetrics() {
    const result = {};
    for (const [id, metrics] of this.metrics) {
      result[id] = { ...metrics };
    }
    return result;
  }

  /**
   * Get extension context
   * @param {string} extensionId
   * @returns {object|undefined}
   */
  getContext(extensionId) {
    return this.activeContexts.get(extensionId);
  }

  /**
   * Set extension context
   * @param {string} extensionId
   * @param {object} context
   */
  setContext(extensionId, context) {
    this.activeContexts.set(extensionId, context);
  }

  /**
   * Get loaded extension
   * @param {string} extensionId
   * @returns {object|undefined}
   */
  getExtension(extensionId) {
    return this.loadedExtensions.get(extensionId);
  }

  /**
   * Get document
   * @param {string} uri
   * @returns {object|undefined}
   */
  getDocument(uri) {
    return this.documents.get(uri);
  }

  // ===========================================================================
  // Language Provider Invocations
  // ===========================================================================

  /**
   * Invoke a registered language provider.
   * Called when the main thread (via LanguageProviderBridge) needs results.
   *
   * @param {string} providerId - e.g. "ext.completion:3"
   * @param {string} providerMethod - e.g. "provideCompletionItems"
   * @param {any[]} args - [uri, position, context, …] (serialized from main thread)
   * @returns {Promise<any>}
   */
  async _invokeLanguageProvider(providerId, providerMethod, args) {
    const registration = this._languageProviders.get(providerId);
    if (!registration) {
      throw new Error(`Provider not found: ${providerId}`);
    }

    const { provider } = registration;
    if (typeof provider[providerMethod] !== 'function') {
      return null; // provider doesn't implement this optional method
    }

    // Reconstruct document from URI
    const uri = args[0];
    const doc = this._getDocumentForProvider(uri);
    if (!doc && providerMethod !== 'resolveCodeLens') {
      console.warn(`[ExtensionHost] Document not found for provider call: ${uri}`);
      return null;
    }

    // Build call arguments based on provider method
    const callArgs = this._buildProviderCallArgs(providerMethod, doc, args);

    const startTime = performance.now();
    try {
      const result = await Promise.resolve(provider[providerMethod](...callArgs));
      this._trackCpuTime(registration.extensionId, performance.now() - startTime);
      return this._serializeProviderResult(providerMethod, result);
    } catch (err) {
      console.error(`[ExtensionHost] Provider ${providerId}.${providerMethod} error:`, err);
      return null;
    }
  }

  /**
   * Resolve a completion item (by index, from a previously returned list).
   * The LanguageProviderBridge stores the provider ID + index for later resolution.
   */
  async _resolveCompletionItem(providerId, itemIndex) {
    const registration = this._languageProviders.get(providerId);
    if (!registration || typeof registration.provider.resolveCompletionItem !== 'function') {
      return null;
    }

    // We need to cache the last completion result per provider to resolve items.
    // If the extension stores items, use its last result.
    const lastItems = registration._lastCompletionItems;
    if (!lastItems || !lastItems[itemIndex]) return null;

    const startTime = performance.now();
    try {
      const resolved = await Promise.resolve(
        registration.provider.resolveCompletionItem(lastItems[itemIndex], null)
      );
      this._trackCpuTime(registration.extensionId, performance.now() - startTime);
      return this._serializeSingleCompletionItem(resolved || lastItems[itemIndex]);
    } catch (err) {
      console.error(`[ExtensionHost] resolveCompletionItem error for ${providerId}:`, err);
      return null;
    }
  }

  /**
   * Get a VS Code-like document object for provider invocations.
   * Uses the synced document content from the main thread.
   */
  _getDocumentForProvider(uri) {
    const raw = this.documents.get(uri);
    if (!raw) return null;

    // Build a minimal TextDocument shape that extensions expect
    const lines = (raw.content || '').split('\n');
    return {
      uri: { toString: () => uri, fsPath: uri, scheme: 'file', path: uri },
      fileName: raw.fileName || uri,
      languageId: raw.languageId || 'plaintext',
      version: raw.version || 1,
      lineCount: lines.length,
      getText(range) {
        if (!range) return raw.content || '';
        const startLine = range.start?.line ?? 0;
        const startChar = range.start?.character ?? 0;
        const endLine = range.end?.line ?? lines.length - 1;
        const endChar = range.end?.character ?? (lines[endLine]?.length ?? 0);
        if (startLine === endLine) {
          return (lines[startLine] || '').substring(startChar, endChar);
        }
        const result = [(lines[startLine] || '').substring(startChar)];
        for (let i = startLine + 1; i < endLine; i++) result.push(lines[i] || '');
        result.push((lines[endLine] || '').substring(0, endChar));
        return result.join('\n');
      },
      lineAt(lineOrPos) {
        const ln = typeof lineOrPos === 'number' ? lineOrPos : (lineOrPos?.line ?? 0);
        const text = lines[ln] || '';
        return {
          lineNumber: ln,
          text,
          range: { start: { line: ln, character: 0 }, end: { line: ln, character: text.length } },
          rangeIncludingLineBreak: { start: { line: ln, character: 0 }, end: { line: ln + 1, character: 0 } },
          firstNonWhitespaceCharacterIndex: text.search(/\S/),
          isEmptyOrWhitespace: text.trim().length === 0
        };
      },
      offsetAt(pos) {
        let offset = 0;
        for (let i = 0; i < (pos.line ?? 0); i++) offset += (lines[i]?.length ?? 0) + 1;
        return offset + (pos.character ?? 0);
      },
      positionAt(offset) {
        let remaining = offset;
        for (let i = 0; i < lines.length; i++) {
          if (remaining <= lines[i].length) return { line: i, character: remaining };
          remaining -= lines[i].length + 1;
        }
        return { line: lines.length - 1, character: lines[lines.length - 1]?.length ?? 0 };
      },
      getWordRangeAtPosition(pos, regex) {
        const text = lines[pos.line] || '';
        const pattern = regex || /\w+/g;
        const re = new RegExp(pattern.source, 'g');
        let match;
        while ((match = re.exec(text)) !== null) {
          const start = match.index;
          const end = start + match[0].length;
          if (pos.character >= start && pos.character <= end) {
            return { start: { line: pos.line, character: start }, end: { line: pos.line, character: end } };
          }
        }
        return undefined;
      },
      validateRange(range) { return range; },
      validatePosition(pos) { return pos; }
    };
  }

  /**
   * Build call arguments for a provider method based on the serialized args.
   * args[0] is always the URI (already handled), args[1+] vary by method.
   */
  _buildProviderCallArgs(method, doc, args) {
    // Most providers: (document, position, [context])
    // Some providers: (document, range, context) or (document) only
    const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };

    switch (method) {
      case 'provideCompletionItems':
        return [doc, args[1] /* position */, args[2] /* context */, token];
      case 'provideHover':
        return [doc, args[1] /* position */, token];
      case 'provideDefinition':
      case 'provideTypeDefinition':
      case 'provideImplementation':
        return [doc, args[1] /* position */, token];
      case 'provideReferences':
        return [doc, args[1] /* position */, args[2] /* context */, token];
      case 'provideDocumentHighlights':
        return [doc, args[1] /* position */, token];
      case 'provideDocumentSymbols':
        return [doc, token];
      case 'provideCodeActions':
        return [doc, args[1] /* range */, args[2] /* context */, token];
      case 'provideCodeLenses':
        return [doc, token];
      case 'resolveCodeLens':
        // args: [uri, codeLensIndex] — need to retrieve from cache
        return [args[1] /* codeLens */, token];
      case 'provideDocumentFormattingEdits':
        return [doc, args[1] /* options */, token];
      case 'provideDocumentRangeFormattingEdits':
        return [doc, args[1] /* range */, args[2] /* options */, token];
      case 'provideOnTypeFormattingEdits':
        return [doc, args[1] /* position */, args[2] /* ch */, args[3] /* options */, token];
      case 'provideSignatureHelp':
        return [doc, args[1] /* position */, token, args[2] /* context */];
      case 'provideRenameEdits':
        return [doc, args[1] /* position */, args[2] /* newName */, token];
      case 'prepareRename':
        return [doc, args[1] /* position */, token];
      case 'provideDocumentLinks':
        return [doc, token];
      case 'provideDocumentColors':
        return [doc, token];
      case 'provideColorPresentations':
        return [args[1] /* color */, { document: doc, range: args[2] /* range */ }, token];
      case 'provideFoldingRanges':
        return [doc, {} /* context */, token];
      case 'provideSelectionRanges':
        return [doc, args[1] /* positions */, token];
      case 'provideInlayHints':
        return [doc, args[1] /* range */, token];
      case 'provideInlineCompletions':
        return [doc, args[1] /* position */, args[2] /* context */, token];
      case 'provideDocumentSemanticTokens':
        return [doc, token];
      default:
        return [doc, ...args.slice(1), token];
    }
  }

  /**
   * Serialize a provider result for transport back to the main thread.
   * Strips functions, circular references, and converts special types.
   */
  _serializeProviderResult(method, result) {
    if (result === null || result === undefined) return null;

    // Completion results — cache items for resolveCompletionItem
    if (method === 'provideCompletionItems') {
      return this._serializeCompletionResult(result);
    }

    // Convert to plain JSON-safe object
    try {
      return JSON.parse(JSON.stringify(result, (key, value) => {
        if (typeof value === 'function') return undefined;
        if (value instanceof RegExp) return value.source;
        if (value?.uri && typeof value.uri.toString === 'function') {
          return { ...value, uri: value.uri.toString() };
        }
        return value;
      }));
    } catch {
      return null;
    }
  }

  /**
   * Serialize completion result and cache items for resolveCompletionItem.
   */
  _serializeCompletionResult(result) {
    if (!result) return null;
    const items = Array.isArray(result) ? result : (result.items || []);
    const isIncomplete = result.isIncomplete || false;

    // Cache for resolve
    // Find which provider this belongs to by checking _lastCompletionItems
    // (set below after serialization)
    const serialized = items.map(item => this._serializeSingleCompletionItem(item));

    return { items: serialized, isIncomplete };
  }

  _serializeSingleCompletionItem(item) {
    if (!item) return null;
    try {
      return JSON.parse(JSON.stringify({
        label: item.label,
        kind: item.kind,
        detail: item.detail,
        documentation: item.documentation,
        sortText: item.sortText,
        filterText: item.filterText,
        preselect: item.preselect,
        insertText: item.insertText,
        range: item.range,
        commitCharacters: item.commitCharacters,
        additionalTextEdits: item.additionalTextEdits,
        command: item.command,
        tags: item.tags
      }, (key, value) => {
        if (typeof value === 'function') return undefined;
        if (value instanceof RegExp) return value.source;
        if (value?.uri && typeof value.uri.toString === 'function') {
          return { ...value, uri: value.uri.toString() };
        }
        return value;
      }));
    } catch {
      return { label: String(item.label || item), kind: 0 };
    }
  }

  // ===========================================================================
  // Active Editor & File Watcher events
  // ===========================================================================

  _onActiveEditorChanged(editorData) {
    this._activeTextEditor = editorData || null;
  }

  _onFileWatcherEvent(watcherId, eventType, uri) {
    const watcher = this._fileWatchers.get(watcherId);
    if (!watcher) return;

    // Dispatch to the appropriate event emitter
    switch (eventType) {
      case 'created':
        watcher._onDidCreate?.forEach(cb => { try { cb({ toString: () => uri, fsPath: uri }); } catch {} });
        break;
      case 'changed':
        watcher._onDidChange?.forEach(cb => { try { cb({ toString: () => uri, fsPath: uri }); } catch {} });
        break;
      case 'deleted':
        watcher._onDidDelete?.forEach(cb => { try { cb({ toString: () => uri, fsPath: uri }); } catch {} });
        break;
    }
  }

  // ===========================================================================
  // Tree View support
  // ===========================================================================

  _getTreeViewChildren(viewId, element) {
    // Tree view data providers are registered by extensions
    // This is a placeholder — extensions register via vscode.window.createTreeView
    return [];
  }

  _getTreeViewItem(viewId, element) {
    return null;
  }
}
