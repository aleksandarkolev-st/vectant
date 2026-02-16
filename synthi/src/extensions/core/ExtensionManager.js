/**
 * Synthi Extension System - Extension Manager
 * PHASE A+B: Main Thread Coordinator
 * 
 * This is the main entry point for the extension system.
 * It coordinates between:
 * - ExtensionStateReducer (authoritative state)
 * - WorkerProxy (communication with worker)
 * - Failure handling
 * - Recovery
 */

import {
  ExtensionState,
  FailureType,
  getStateDescription
} from './ExtensionState.js';

import {
  ExtensionStateReducer,
  ActionType,
  createAction,
  getExtensionStateReducer
} from './ExtensionStateReducer.js';

/**
 * @typedef {Object} ExtensionManagerOptions
 * @property {string} workerUrl - URL to the hardened worker script
 * @property {boolean} [debug] - Enable debug logging
 * @property {number} [activationTimeout] - Override activation timeout (ms)
 * @property {number} [requestTimeout] - Override request timeout (ms)
 */

/**
 * Configuration
 */
const CONFIG = {
  // Timeouts
  WORKER_INIT_TIMEOUT: 10000,
  ACTIVATION_TIMEOUT: 3000,
  REQUEST_TIMEOUT: 5000,
  HEARTBEAT_TIMEOUT: 15000, // If no heartbeat for this long, worker is dead
  
  // Retry settings
  MAX_WORKER_RESTARTS: 3,
  WORKER_RESTART_COOLDOWN: 5000 // Min time between restarts
};

/**
 * Generate unique request ID
 */
let requestIdCounter = 0;
function createRequestId() {
  return ++requestIdCounter;
}

/**
 * Extension Manager - Main Thread Coordinator
 */
export class ExtensionManager {
  /**
   * @param {ExtensionManagerOptions} [options]
   */
  constructor(options = {}) {
    /** @type {ExtensionStateReducer} */
    this.stateReducer = getExtensionStateReducer();
    
    /** @type {Worker|null} */
    this.worker = null;
    
    /** @type {string|null} */
    this.workerUrl = options.workerUrl || null;
    
    /** @type {number} */
    this.workerGeneration = 0;
    
    /** @type {'uninitialized'|'initializing'|'running'|'restarting'|'dead'} */
    this.workerState = 'uninitialized';
    
    /** @type {Map<number, {resolve: Function, reject: Function, timer: number, method: string}>} */
    this.pendingRequests = new Map();
    
    /** @type {Map<string, Function[]>} */
    this.eventListeners = new Map();
    
    /** @type {number|null} */
    this.lastHeartbeat = null;
    
    /** @type {number|null} */
    this.heartbeatCheckInterval = null;
    
    /** @type {number} */
    this.workerRestartCount = 0;
    
    /** @type {number} */
    this.lastWorkerRestart = 0;
    
    /** @type {Set<string>} Commands registered in worker */
    this.registeredCommands = new Set();
    
    /** @type {boolean} */
    this.debug = options.debug || false;
    
    /** @type {number} */
    this.activationTimeout = options.activationTimeout || CONFIG.ACTIVATION_TIMEOUT;
    
    /** @type {number} */
    this.requestTimeout = options.requestTimeout || CONFIG.REQUEST_TIMEOUT;
    
    /** @type {Promise<void>|null} */
    this._initPromise = null;
    
    /** @type {Promise<void>|null} */
    this._restartPromise = null;
  }

  /**
   * Initialize the extension manager
   * @param {string} [workerUrl]
   * @returns {Promise<void>}
   */
  async init(workerUrl) {
    if (this._initPromise) {
      return this._initPromise;
    }

    this._initPromise = this._doInit(workerUrl);
    return this._initPromise;
  }

  async _doInit(workerUrl) {
    if (workerUrl) {
      this.workerUrl = workerUrl;
    }

    if (!this.workerUrl) {
      throw new Error('workerUrl is required');
    }

    this.workerState = 'initializing';
    this.workerGeneration++;
    const currentGen = this.workerGeneration;

    try {
      await this._createWorker();
      
      if (this.workerGeneration !== currentGen) {
        throw new Error('Worker generation changed during init');
      }

      this.workerState = 'running';
      this._startHeartbeatCheck();
      
      this._log('Extension manager initialized');
    } catch (err) {
      this.workerState = 'dead';
      throw err;
    }
  }

  async _createWorker() {
    return new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(this.workerUrl);
        
        this.worker.onmessage = (event) => {
          this._handleMessage(event.data);
        };
        
        this.worker.onerror = (error) => {
          this._log('Worker error:', error, 'error');
          this._handleWorkerError(error);
        };

        // Wait for ready signal
        const timeout = setTimeout(() => {
          reject(new Error('Worker initialization timeout'));
        }, CONFIG.WORKER_INIT_TIMEOUT);

        const readyHandler = (data) => {
          if (data?.method === 'workerReady') {
            clearTimeout(timeout);
            this._log('Worker ready');
            resolve();
          }
        };

        // Temporarily listen for ready
        const originalHandler = this.worker.onmessage;
        this.worker.onmessage = (event) => {
          readyHandler(event.data);
          originalHandler(event);
        };

      } catch (err) {
        reject(err);
      }
    });
  }

  /**
   * Handle incoming message from worker
   * @param {any} data
   */
  _handleMessage(data) {
    if (!data || typeof data !== 'object') {
      this._log('Invalid message from worker', data, 'warn');
      return;
    }

    // Sync generation with worker on workerReady event (worker always starts at generation 0)
    if (data.type === 'event' && data.method === 'workerReady') {
      if (typeof data.generation === 'number') {
        this.workerGeneration = data.generation;
      }
    }

    // Check generation (after potential sync from workerReady above)
    if (typeof data.generation === 'number' && data.generation !== this.workerGeneration) {
      this._log('Dropping stale message from old worker generation', null, 'debug');
      return;
    }

    if (data.type === 'response') {
      this._handleResponse(data);
    } else if (data.type === 'event') {
      this._handleEvent(data);
    }
  }

  _handleResponse(data) {
    const pending = this.pendingRequests.get(data.id);
    if (!pending) {
      this._log(`Response for unknown request: ${data.id}`, null, 'debug');
      return;
    }

    clearTimeout(pending.timer);
    this.pendingRequests.delete(data.id);

    if (data.error) {
      const err = new Error(data.error.message);
      err.stack = data.error.stack;
      err.code = data.error.code;
      pending.reject(err);
    } else {
      pending.resolve(data.result);
    }
  }

  _handleEvent(data) {
    const { method, args = [] } = data;

    switch (method) {
      case 'workerReady':
        this._log('Worker ready signal received');
        break;
        
      case 'heartbeat':
        this.lastHeartbeat = Date.now();
        break;
        
      case 'registerCommand':
        this.registeredCommands.add(args[0]);
        this._emit('registerCommand', args[0], args[1]);
        break;
        
      case 'unregisterCommand':
        this.registeredCommands.delete(args[0]);
        this._emit('unregisterCommand', args[0]);
        break;
        
      case 'activationComplete':
        this._handleActivationComplete(args[0], args[1], args[2], args[3]);
        break;
        
      case 'protocolViolation':
        this._log('Protocol violation from extension:', args[0], 'error');
        // This is serious - consider quarantining
        break;
        
      case 'workerError':
        this._log('Worker reported error:', args[0], 'error');
        break;
        
      case 'createWebview':
      case 'updateWebview':
      case 'disposeWebview':
      case 'showMessage':
      case 'setStatusBar':
        this._emit(method, ...args);
        break;
        
      default:
        this._emit(method, ...args);
    }
  }

  _handleActivationComplete(extensionId, success, activationTime, error) {
    if (success) {
      this.stateReducer.dispatch(
        createAction(ActionType.ACTIVATE_SUCCESS, extensionId, { activationTime })
      );
    } else {
      this.stateReducer.dispatch(
        createAction(ActionType.ACTIVATE_FAILURE, extensionId, {
          reason: error,
          failureType: FailureType.ACTIVATION_TIMEOUT
        })
      );
    }
    
    this._emit('activationComplete', extensionId, success, activationTime, error);
  }

  _handleWorkerError(error) {
    this._rejectAllPending('Worker error');
    
    // Dispatch worker died action
    this.stateReducer.dispatch(
      createAction(ActionType.WORKER_DIED, null, { error: error?.message })
    );
    
    this.workerState = 'dead';
    this._emit('workerError', error);
    
    // Attempt restart if within limits
    this._maybeRestartWorker('error');
  }

  /**
   * Send a request to the worker
   * @param {string} method
   * @param {any[]} args
   * @param {number} [timeout]
   * @returns {Promise<any>}
   */
  async _request(method, args = [], timeout = this.requestTimeout) {
    if (this.workerState !== 'running') {
      throw new Error(`Worker not running (state: ${this.workerState})`);
    }

    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    const id = createRequestId();
    const msg = {
      id,
      type: 'request',
      method,
      args,
      generation: this.workerGeneration
    };

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(id);
        const err = new Error(`Request timeout: ${method}`);
        err.code = 'TIMEOUT';
        reject(err);
      }, timeout);

      this.pendingRequests.set(id, { resolve, reject, timer, method });
      this.worker.postMessage(msg);
    });
  }

  /**
   * Reject all pending requests
   * @param {string} reason
   */
  _rejectAllPending(reason) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  /**
   * Start heartbeat monitoring
   */
  _startHeartbeatCheck() {
    this.lastHeartbeat = Date.now();
    
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
    }

    this.heartbeatCheckInterval = setInterval(() => {
      if (!this.lastHeartbeat) return;
      
      const timeSinceHeartbeat = Date.now() - this.lastHeartbeat;
      if (timeSinceHeartbeat > CONFIG.HEARTBEAT_TIMEOUT) {
        this._log('Worker heartbeat timeout - worker appears dead', null, 'error');
        this._handleWorkerDeath('heartbeat_timeout');
      }
    }, 5000);
  }

  _handleWorkerDeath(reason) {
    if (this.workerState === 'dead' || this.workerState === 'restarting') {
      return;
    }

    this._rejectAllPending('Worker died');
    
    this.stateReducer.dispatch(
      createAction(ActionType.WORKER_DIED, null, { reason })
    );
    
    this.workerState = 'dead';
    this._emit('workerDeath', reason);
    
    this._maybeRestartWorker(reason);
  }

  /**
   * Maybe restart worker if within limits
   * @param {string} reason
   */
  async _maybeRestartWorker(reason) {
    const now = Date.now();
    
    // Check cooldown
    if (now - this.lastWorkerRestart < CONFIG.WORKER_RESTART_COOLDOWN) {
      this._log('Worker restart on cooldown', null, 'warn');
      return;
    }
    
    // Check restart count
    if (this.workerRestartCount >= CONFIG.MAX_WORKER_RESTARTS) {
      this._log('Max worker restarts exceeded', null, 'error');
      this._emit('workerRestartLimitReached');
      return;
    }

    await this._restartWorker(reason);
  }

  /**
   * Restart the worker and reload healthy extensions
   * @param {string} reason
   */
  async _restartWorker(reason) {
    if (this._restartPromise) {
      return this._restartPromise;
    }

    this._restartPromise = this._doRestartWorker(reason);
    return this._restartPromise.finally(() => {
      this._restartPromise = null;
    });
  }

  async _doRestartWorker(reason) {
    this._log(`Restarting worker due to: ${reason}`);
    
    this.workerState = 'restarting';
    this.workerRestartCount++;
    this.lastWorkerRestart = Date.now();

    // Terminate old worker
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    // Clear all pending
    this._rejectAllPending('Worker restarting');
    this.registeredCommands.clear();

    // Increment generation
    this.workerGeneration++;

    try {
      await this._createWorker();
      this.workerState = 'running';
      
      // Dispatch worker restarted
      this.stateReducer.dispatch(createAction(ActionType.WORKER_RESTARTED, null));
      
      // Reload healthy extensions
      await this._reloadHealthyExtensions();
      
      this._emit('workerRestarted');
      this._log('Worker restarted successfully');
    } catch (err) {
      this.workerState = 'dead';
      this._log('Worker restart failed:', err, 'error');
      throw err;
    }
  }

  /**
   * Reload all non-quarantined/disabled extensions
   */
  async _reloadHealthyExtensions() {
    const extensions = this.stateReducer.getAllExtensions();
    
    for (const ext of extensions) {
      // Skip quarantined and disabled
      if (ext.state === ExtensionState.QUARANTINED ||
          ext.state === ExtensionState.DISABLED) {
        this._log(`Skipping ${ext.extensionId} (${ext.state})`);
        continue;
      }

      try {
        await this._request('loadExtension', [ext.extensionId, ext.code, ext.manifest]);
        this.stateReducer.dispatch(createAction(ActionType.LOAD_SUCCESS, ext.extensionId));
        this._log(`Reloaded: ${ext.extensionId}`);
        
        // Re-activate if it was previously active
        if (ext.previousState === ExtensionState.ACTIVE) {
          try {
            await this.activateExtension(ext.extensionId);
          } catch (activateErr) {
            this._log(`Failed to reactivate ${ext.extensionId}:`, activateErr, 'error');
          }
        }
      } catch (err) {
        this._log(`Failed to reload ${ext.extensionId}:`, err, 'error');
        this.stateReducer.dispatch(
          createAction(ActionType.REPORT_FAILURE, ext.extensionId, {
            failureType: FailureType.LOAD_FAILURE,
            reason: err.message
          })
        );
      }
    }
  }

  // =========================================================================
  // Public API
  // =========================================================================

  /**
   * Register an extension
   * @param {string} extensionId
   * @param {object} manifest
   * @param {string} code
   * @returns {Promise<void>}
   */
  async registerExtension(extensionId, manifest, code) {
    // Register in state reducer first
    const result = this.stateReducer.dispatch(
      createAction(ActionType.REGISTER, extensionId, { manifest, code })
    );
    
    if (!result.success) {
      throw new Error(result.error);
    }

    // Load into worker
    try {
      await this._request('loadExtension', [extensionId, code, manifest]);
      this.stateReducer.dispatch(createAction(ActionType.LOAD_SUCCESS, extensionId));
      this._log(`Registered: ${extensionId}`);
    } catch (err) {
      this.stateReducer.dispatch(
        createAction(ActionType.LOAD_FAILURE, extensionId, { reason: err.message })
      );
      throw err;
    }
  }

  /**
   * Activate an extension
   * @param {string} extensionId
   * @returns {Promise<{success: boolean, activationTime: number}>}
   */
  async activateExtension(extensionId) {
    // Check if activation is allowed
    const { canActivate, reason } = this.stateReducer.canActivate(extensionId);
    if (!canActivate) {
      throw new Error(reason);
    }

    // Dispatch activate start
    this.stateReducer.dispatch(createAction(ActionType.ACTIVATE_START, extensionId));

    try {
      const result = await this._request(
        'activateExtension',
        [extensionId],
        this.activationTimeout
      );

      if (result.success) {
        this.stateReducer.dispatch(
          createAction(ActionType.ACTIVATE_SUCCESS, extensionId, {
            activationTime: result.activationTime
          })
        );
        return result;
      } else {
        // Activation failed (but returned normally)
        const failureType = result.code === 'ACTIVATION_TIMEOUT' 
          ? FailureType.ACTIVATION_TIMEOUT 
          : FailureType.RUNTIME_EXCEPTION;
        
        const dispatchResult = this.stateReducer.dispatch(
          createAction(ActionType.ACTIVATE_FAILURE, extensionId, {
            reason: result.error,
            failureType
          })
        );

        // If requires worker restart, do it
        if (dispatchResult.requiresWorkerRestart) {
          this._log(`Restarting worker after ${extensionId} activation failure`);
          await this._restartWorker(`activation_failure:${extensionId}`);
        }

        throw new Error(result.error);
      }
    } catch (err) {
      // Request itself failed (e.g., timeout)
      if (err.code === 'TIMEOUT') {
        const dispatchResult = this.stateReducer.dispatch(
          createAction(ActionType.ACTIVATE_FAILURE, extensionId, {
            reason: 'Activation timeout',
            failureType: FailureType.ACTIVATION_TIMEOUT
          })
        );

        if (dispatchResult.requiresWorkerRestart) {
          this._log(`Hard timeout - restarting worker after ${extensionId}`);
          await this._restartWorker(`activation_timeout:${extensionId}`);
        }
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
    try {
      await this._request('deactivateExtension', [extensionId]);
      this.stateReducer.dispatch(createAction(ActionType.DEACTIVATE, extensionId));
    } catch (err) {
      this._log(`Deactivation failed for ${extensionId}:`, err, 'error');
      throw err;
    }
  }

  /**
   * Execute a command
   * @param {string} commandId
   * @param {...any} args
   * @returns {Promise<any>}
   */
  async executeCommand(commandId, ...args) {
    if (!this.registeredCommands.has(commandId)) {
      throw new Error(`Unknown command: ${commandId}`);
    }

    return this._request('executeCommand', [commandId, ...args]);
  }

  /**
   * Suspend an extension
   * @param {string} extensionId
   * @param {string} [reason]
   * @returns {Promise<void>}
   */
  async suspendExtension(extensionId, reason) {
    await this._request('suspendExtension', [extensionId]);
    this.stateReducer.dispatch(
      createAction(ActionType.SUSPEND, extensionId, { reason })
    );
  }

  /**
   * Resume a suspended extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async resumeExtension(extensionId) {
    await this._request('resumeExtension', [extensionId]);
    this.stateReducer.dispatch(createAction(ActionType.RESUME, extensionId));
  }

  /**
   * Quarantine an extension
   * @param {string} extensionId
   * @param {string} reason
   * @returns {Promise<void>}
   */
  async quarantineExtension(extensionId, reason) {
    await this._request('killExtension', [extensionId]);
    this.stateReducer.dispatch(
      createAction(ActionType.QUARANTINE, extensionId, { reason })
    );
  }

  /**
   * Disable an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async disableExtension(extensionId) {
    await this._request('killExtension', [extensionId]);
    this.stateReducer.dispatch(createAction(ActionType.DISABLE, extensionId));
  }

  /**
   * Enable a disabled extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async enableExtension(extensionId) {
    this.stateReducer.dispatch(createAction(ActionType.ENABLE, extensionId));
    
    // Reload the extension
    const ext = this.stateReducer.getExtension(extensionId);
    if (ext) {
      await this._request('loadExtension', [extensionId, ext.code, ext.manifest]);
      this.stateReducer.dispatch(createAction(ActionType.LOAD_SUCCESS, extensionId));
    }
  }

  /**
   * Reset a quarantined extension (user action)
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async resetExtension(extensionId) {
    this.stateReducer.dispatch(createAction(ActionType.RESET, extensionId));
    
    // Reload the extension
    const ext = this.stateReducer.getExtension(extensionId);
    if (ext) {
      await this._request('loadExtension', [extensionId, ext.code, ext.manifest]);
      this.stateReducer.dispatch(createAction(ActionType.LOAD_SUCCESS, extensionId));
    }
  }

  /**
   * Get extension states (main thread authoritative)
   * @returns {Array}
   */
  getExtensionStates() {
    return this.stateReducer.getAllExtensions().map(ext => ({
      extensionId: ext.extensionId,
      state: ext.state,
      stateDescription: getStateDescription(ext.state),
      manifest: ext.manifest,
      failureReason: ext.failureReason,
      failureType: ext.failureType,
      activationAttempts: ext.activationAttempts,
      lastActivationTime: ext.lastActivationTime,
      failureHistory: ext.failureHistory
    }));
  }

  /**
   * Get extension info
   * @param {string} extensionId
   * @returns {object|undefined}
   */
  getExtension(extensionId) {
    return this.stateReducer.getExtension(extensionId);
  }

  /**
   * Subscribe to events
   * @param {string} event
   * @param {Function} callback
   * @returns {() => void}
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);
    
    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        const idx = listeners.indexOf(callback);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    };
  }

  /**
   * Shutdown the extension manager
   */
  async shutdown() {
    this._log('Shutting down...');
    
    if (this.heartbeatCheckInterval) {
      clearInterval(this.heartbeatCheckInterval);
      this.heartbeatCheckInterval = null;
    }

    this._rejectAllPending('Shutting down');

    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }

    this.workerState = 'dead';
    this.registeredCommands.clear();
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  _emit(event, ...args) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const cb of listeners) {
        try {
          cb(...args);
        } catch (err) {
          console.error(`[ExtensionManager] Event listener error (${event}):`, err);
        }
      }
    }
  }

  _log(message, data = null, level = 'info') {
    if (!this.debug && level === 'debug') return;
    
    const prefix = '[ExtensionManager]';
    const fullMsg = data ? `${prefix} ${message}` : `${prefix} ${message}`;
    
    switch (level) {
      case 'error':
        console.error(fullMsg, data || '');
        break;
      case 'warn':
        console.warn(fullMsg, data || '');
        break;
      case 'debug':
        console.debug(fullMsg, data || '');
        break;
      default:
        console.log(fullMsg, data || '');
    }
  }
}

// Singleton
let instance = null;

/**
 * Get the singleton ExtensionManager
 * @returns {ExtensionManager}
 */
export function getExtensionManager() {
  if (!instance) {
    instance = new ExtensionManager();
  }
  return instance;
}

/**
 * Create a new ExtensionManager (for testing)
 * @param {ExtensionManagerOptions} [options]
 * @returns {ExtensionManager}
 */
export function createExtensionManager(options) {
  return new ExtensionManager(options);
}
