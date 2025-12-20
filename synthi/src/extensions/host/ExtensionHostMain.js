/**
 * Synthi Extension System - Extension Host Main
 * Core logic for the extension host worker
 */

import { 
  createResponse, 
  createEvent, 
  isValidMessage,
  MainToWorkerMethods,
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
      // Note: Full content sync would happen here in a real implementation
      // For performance, we only track version and apply changes on demand
    }
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
}
