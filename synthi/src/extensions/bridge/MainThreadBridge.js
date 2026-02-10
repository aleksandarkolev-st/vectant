/**
 * Synthi Extension System - Main Thread Bridge
 * Coordinates extension system on the main thread
 */

import { WorkerProxy, getWorkerProxy } from './WorkerProxy.js';
import { WorkerToMainMethods } from './MessageProtocol.js';

/**
 * @typedef {Object} ExtensionInfo
 * @property {string} id
 * @property {string} name
 * @property {string} version
 * @property {boolean} isActive
 * @property {boolean} failed
 * @property {string|null} failedReason
 * @property {string[]} activationEvents
 * @property {object} manifest
 * @property {string} code
 */

export class MainThreadBridge {
  constructor() {
    /** @type {WorkerProxy} */
    this.workerProxy = getWorkerProxy();

    /** @type {string|null} */
    this.workerUrl = null;
    
    /** @type {Map<string, ExtensionInfo>} */
    this.extensions = new Map();
    
    /** @type {Map<string, Function>} */
    this.commandHandlers = new Map();
    
    /** @type {Set<string>} */
    this.extensionCommands = new Set();
    
    /** @type {Function|null} */
    this.onApplyEdit = null;
    
    /** @type {Function|null} */
    this.onShowMessage = null;
    
    /** @type {Function|null} */
    this.onSetDiagnostics = null;
    
    /** @type {Function|null} */
    this.onCreateWebview = null;
    
    /** @type {boolean} */
    this.initialized = false;
    
    /** @type {Map<string, object>} */
    this.pendingActivations = new Map();

    /** @type {boolean} */
    this.handlersRegistered = false;

    /** @type {Promise<void>|null} */
    this.restartPromise = null;
  }

  /**
   * Initialize the extension system
   * @param {string} workerUrl
   * @returns {Promise<void>}
   */
  async init(workerUrl) {
    if (this.initialized) {
      console.warn('[MainThreadBridge] Already initialized');
      return;
    }

    this.workerUrl = workerUrl;

    // Set up event handlers before initializing worker
    this._setupEventHandlers();

    // Initialize worker
    await this.workerProxy.init(workerUrl);
    
    this.initialized = true;
    console.log('[MainThreadBridge] Extension system initialized');
  }

  /**
   * Set up handlers for events from worker
   */
  _setupEventHandlers() {
    if (this.handlersRegistered) {
      return;
    }

    const proxy = this.workerProxy;

    // Command registration
    proxy.on(WorkerToMainMethods.REGISTER_COMMAND, (commandId, extensionId) => {
      this.extensionCommands.add(commandId);
      console.log(`[MainThreadBridge] Command registered: ${commandId} (${extensionId})`);
    });

    proxy.on(WorkerToMainMethods.UNREGISTER_COMMAND, (commandId) => {
      this.extensionCommands.delete(commandId);
    });

    // Text edits
    proxy.on(WorkerToMainMethods.APPLY_EDIT, (uri, edits) => {
      if (this.onApplyEdit) {
        this.onApplyEdit(uri, edits);
      }
    });

    // Messages
    proxy.on(WorkerToMainMethods.SHOW_MESSAGE, (type, message, options) => {
      if (this.onShowMessage) {
        this.onShowMessage(type, message, options);
      } else {
        // Fallback
        if (type === 'error') console.error(message);
        else if (type === 'warning') console.warn(message);
        else console.log(message);
      }
    });

    // Diagnostics
    proxy.on(WorkerToMainMethods.SET_DIAGNOSTICS, (uri, diagnostics, source) => {
      if (this.onSetDiagnostics) {
        this.onSetDiagnostics(uri, diagnostics, source);
      }
    });

    proxy.on(WorkerToMainMethods.CLEAR_DIAGNOSTICS, (uri, source) => {
      if (this.onSetDiagnostics) {
        this.onSetDiagnostics(uri, [], source);
      }
    });

    // Webviews
    proxy.on(WorkerToMainMethods.CREATE_WEBVIEW, (viewId, viewType, title, options) => {
      if (this.onCreateWebview) {
        this.onCreateWebview(viewId, viewType, title, options);
      }
    });

    // Activation complete
    proxy.on(WorkerToMainMethods.ACTIVATION_COMPLETE, (extensionId, success, time, error) => {
      const info = this.extensions.get(extensionId);
      if (info) {
        info.isActive = success;
      }
      
      const pending = this.pendingActivations.get(extensionId);
      if (pending) {
        this.pendingActivations.delete(extensionId);
        if (success) {
          pending.resolve({ success: true, activationTime: time });
        } else {
          pending.reject(new Error(error || 'Activation failed'));
        }
      }
    });

    // Performance metrics
    proxy.on(WorkerToMainMethods.REPORT_METRICS, (metrics) => {
      this._handleMetrics(metrics);
    });

    this.handlersRegistered = true;
  }

  /**
   * Handle performance metrics from extensions
   * @param {object} metrics
   */
  _handleMetrics(metrics) {
    // Check for violations
    if (metrics.violations && metrics.violations.length > 0) {
      for (const violation of metrics.violations) {
        console.warn(
          `[MainThreadBridge] Performance violation: ${violation.extensionId} ` +
          `${violation.type} (${violation.value}/${violation.limit})`
        );

        // Auto-suspend after 3 violations
        const info = this.extensions.get(violation.extensionId);
        if (info && info.violationCount >= 3) {
          console.error(`[MainThreadBridge] Suspending ${violation.extensionId} due to violations`);
          this.suspendExtension(violation.extensionId);
        }
      }
    }
  }

  /**
   * Register an extension
   * @param {string} extensionId
   * @param {object} manifest
   * @param {string} code
   * @returns {Promise<void>}
   */
  async registerExtension(extensionId, manifest, code) {
    if (this.extensions.has(extensionId)) {
      // Already registered — unregister the old version first
      console.log(`[MainThreadBridge] Re-registering ${extensionId} (already loaded)`);
      try {
        await this.deactivateExtension(extensionId);
      } catch (_) { /* may not be active */ }
      this.extensions.delete(extensionId);
    }

    // Store extension info
    this.extensions.set(extensionId, {
      id: extensionId,
      name: manifest.name,
      displayName: manifest.displayName || manifest.name,
      version: manifest.version,
      isActive: false,
      failed: false,
      failedReason: null,
      activationEvents: manifest.activationEvents || [],
      violationCount: 0,
      manifest,
      code
    });

    // Load into worker
    await this.workerProxy.loadExtension(extensionId, code, manifest);
    
    console.log(`[MainThreadBridge] Extension registered: ${extensionId}`);
  }

  /**
   * Activate an extension
   * @param {string} extensionId
   * @returns {Promise<{ success: boolean, activationTime: number }>}
   */
  async activateExtension(extensionId) {
    const info = this.extensions.get(extensionId);
    if (!info) {
      throw new Error(`Extension ${extensionId} not registered`);
    }

    if (info.failed) {
      throw new Error(info.failedReason || `Extension ${extensionId} is permanently disabled after a hard failure`);
    }

    if (info.isActive) {
      return { success: true, activationTime: 0 };
    }

    try {
      return await this.workerProxy.activateExtension(extensionId);
    } catch (err) {
      if (err.code === 'ACTIVATION_TIMEOUT') {
        await this._handleActivationTimeout(extensionId, err);
        throw new Error(
          `Activation hard-timeout for ${extensionId}. Worker was restarted and the extension has been disabled.`
        );
      }
      throw err;
    }
  }

  /**
   * Deactivate an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async deactivateExtension(extensionId) {
    const info = this.extensions.get(extensionId);
    if (!info || !info.isActive) return;

    await this.workerProxy.deactivateExtension(extensionId);
    info.isActive = false;
  }

  /**
   * Suspend an extension (pause execution)
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async suspendExtension(extensionId) {
    await this.workerProxy.suspendExtension(extensionId);
  }

  /**
   * Check if a command is from an extension
   * @param {string} commandId
   * @returns {boolean}
   */
  isExtensionCommand(commandId) {
    return this.extensionCommands.has(commandId);
  }

  /**
   * Execute an extension command
   * @param {string} commandId
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async executeCommand(commandId, ...args) {
    if (!this.extensionCommands.has(commandId)) {
      throw new Error(`Unknown command: ${commandId}`);
    }

    return this.workerProxy.executeCommand(commandId, ...args);
  }

  /**
   * Trigger activation for extensions matching an event
   * @param {string} event - e.g., 'onLanguage:javascript'
   * @returns {Promise<void>}
   */
  async triggerActivation(event) {
    const toActivate = [];

    for (const [id, info] of this.extensions) {
      if (info.isActive) continue;
      if (info.failed) continue;

      for (const activationEvent of info.activationEvents) {
        if (this._matchesActivationEvent(activationEvent, event)) {
          toActivate.push(id);
          break;
        }
      }
    }

    // Activate in parallel
    await Promise.allSettled(
      toActivate.map(id => this.activateExtension(id))
    );
  }

  /**
   * Check if activation event matches
   * @param {string} pattern
   * @param {string} event
   * @returns {boolean}
   */
  _matchesActivationEvent(pattern, event) {
    // Exact match
    if (pattern === event) return true;

    // Pattern matching
    const [patternType, patternValue] = pattern.split(':');
    const [eventType, eventValue] = event.split(':');

    if (patternType !== eventType) return false;
    if (!patternValue) return true;
    if (patternValue === eventValue) return true;

    return false;
  }

  /**
   * Notify extensions of document open
   * @param {object} document
   */
  notifyDocumentOpen(document) {
    // Trigger onLanguage activation
    this.triggerActivation(`onLanguage:${document.languageId}`);
    
    // Send to worker
    this.workerProxy.notifyDocumentOpen(document);
  }

  /**
   * Notify extensions of document change
   * @param {string} uri
   * @param {object[]} changes
   * @param {number} version
   */
  notifyDocumentChange(uri, changes, version) {
    this.workerProxy.notifyDocumentChange(uri, changes, version);
  }

  /**
   * Notify extensions of document close
   * @param {string} uri
   */
  notifyDocumentClose(uri) {
    this.workerProxy.notifyDocumentClose(uri);
  }

  /**
   * Notify extensions of selection change
   * @param {string} uri
   * @param {object[]} selections
   */
  notifySelectionChange(uri, selections) {
    this.workerProxy.notifySelectionChange(uri, selections);
  }

  /**
   * Get all registered extensions
   * @returns {ExtensionInfo[]}
   */
  getExtensions() {
    return Array.from(this.extensions.values());
  }

  /**
   * Get extension states without hitting the worker (main thread authoritative)
   * @returns {Array<{ extensionId: string, state: string, manifest: object, commands: string[], failedReason: string|null }>}
   */
  getExtensionStates() {
    const states = [];

    for (const [id, info] of this.extensions) {
      const state = info.failed ? 'failed' : (info.isActive ? 'active' : 'loaded');
      const commands = [];

      // Collect contributed commands if present in manifest
      const manifestCommands = info.manifest?.contributes?.commands || [];
      for (const cmd of manifestCommands) {
        if (cmd?.command) {
          commands.push(cmd.command);
        }
      }

      states.push({
        extensionId: id,
        manifest: info.manifest,
        state,
        activationEvents: info.activationEvents,
        commands,
        failedReason: info.failedReason || null
      });
    }

    return states;
  }

  /**
   * Get extension info
   * @param {string} extensionId
   * @returns {ExtensionInfo|undefined}
   */
  getExtension(extensionId) {
    return this.extensions.get(extensionId);
  }

  /**
   * Shutdown the extension system
   */
  async shutdown() {
    // Deactivate all extensions
    for (const [id, info] of this.extensions) {
      if (info.isActive) {
        try {
          await this.deactivateExtension(id);
        } catch (err) {
          console.error(`Failed to deactivate ${id}:`, err);
        }
      }
    }

    // Terminate worker
    this.workerProxy.terminate();
    this.extensions.clear();
    this.extensionCommands.clear();
    this.pendingActivations.clear();
    this.initialized = false;
    this.workerUrl = null;
  }

  /**
   * Handle an activation timeout by marking the extension as failed and restarting the worker
   * @param {string} extensionId
   * @param {Error} err
   */
  async _handleActivationTimeout(extensionId, err) {
    console.error(
      `[MainThreadBridge] Activation timeout for ${extensionId}: ${err?.message || 'unknown error'}. ` +
      'Restarting extension host worker.'
    );

    this._markExtensionFailed(extensionId, 'Activation hard timeout');
    await this._restartWorker(extensionId, 'activation_timeout');
  }

  /**
   * Mark an extension as permanently failed
   * @param {string} extensionId
   * @param {string} reason
   */
  _markExtensionFailed(extensionId, reason) {
    const info = this.extensions.get(extensionId);
    if (!info) return;

    info.failed = true;
    info.failedReason = reason;
    info.isActive = false;
  }

  /**
   * Restart the extension host worker and reload healthy extensions
   * @param {string|null} failedExtensionId
   * @param {string} reason
   */
  async _restartWorker(failedExtensionId, reason) {
    if (!this.workerUrl) {
      console.warn('[MainThreadBridge] Cannot restart worker before initialization');
      return;
    }

    if (this.restartPromise) {
      return this.restartPromise;
    }

    const doRestart = async () => {
      this.workerProxy.beginRestart();
      // Clear any pending activation waiters
      this.pendingActivations.clear();
      this.extensionCommands.clear();

      // Terminate poisoned worker
      this.workerProxy.terminate();

      console.warn(
        `[MainThreadBridge] Restarting extension host worker due to ${reason}` +
        (failedExtensionId ? ` (failed: ${failedExtensionId})` : '')
      );

      // Spin up fresh worker
      await this.workerProxy.init(this.workerUrl);

      // Reload healthy extensions
      for (const [id, info] of this.extensions) {
        if (info.failed || id === failedExtensionId) {
          info.isActive = false;
          continue;
        }

        try {
          await this.workerProxy.loadExtension(id, info.code, info.manifest);
          if (info.isActive) {
            try {
              const result = await this.workerProxy.activateExtension(id);
              info.isActive = !!result?.success;
            } catch (activateErr) {
              console.error(
                `[MainThreadBridge] Failed to reactivate ${id} after restart:`,
                activateErr
              );
              this._markExtensionFailed(
                id,
                `Reactivation failed after worker restart: ${activateErr.message}`
              );
            }
          }
        } catch (err) {
          console.error(`[MainThreadBridge] Failed to reload ${id} after restart:`, err);
          this._markExtensionFailed(
            id,
            `Reload failed after worker restart: ${err.message}`
          );
        }
      }
    };

    this.restartPromise = doRestart().finally(() => {
      this.restartPromise = null;
    });

    return this.restartPromise;
  }
}

// Singleton instance
let instance = null;

/**
 * Get the MainThreadBridge singleton
 * @returns {MainThreadBridge}
 */
export function getMainThreadBridge() {
  if (!instance) {
    instance = new MainThreadBridge();
  }
  return instance;
}

/**
 * Create a new MainThreadBridge (for testing)
 * @returns {MainThreadBridge}
 */
export function createMainThreadBridge() {
  return new MainThreadBridge();
}
