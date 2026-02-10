/**
 * Synthi Extension System - Worker Proxy
 * RPC proxy for main thread to communicate with extension host worker
 */

import {
  createRequest,
  createResponse,
  createEvent,
  isValidMessage,
  MainToWorkerMethods
} from './MessageProtocol.js';

/**
 * @typedef {Object} PendingRequest
 * @property {Function} resolve
 * @property {Function} reject
 * @property {number} timeout
 * @property {number} startTime
 */

export class WorkerProxy {
  constructor() {
    /** @type {Worker|null} */
    this.worker = null;
    
    /** @type {number} */
    this.generation = 0;
    
    /** @type {'uninitialized'|'initializing'|'running'|'restarting'|'terminated'} */
    this.state = 'uninitialized';
    
    /** @type {string|null} */
    this.workerUrl = null;
    
    /** @type {Map<number, PendingRequest>} */
    this.pendingRequests = new Map();
    
    /** @type {Map<string, Function[]>} */
    this.eventListeners = new Map();
    
    /** @type {boolean} */
    this.ready = false;
    
    /** @type {Function[]} */
    this.readyCallbacks = [];
    
    /** @type {number} Default timeout for requests (ms) */
    this.defaultTimeout = 5000;
    
    /** @type {number} */
    this.messageCount = 0;
    
    /** @type {number} */
    this.lastMessageTime = 0;
  }

  /**
   * Initialize the worker
   * @param {string} workerUrl - URL to the worker script
   * @returns {Promise<void>}
   */
  async init(workerUrl) {
    if (this.worker) {
      throw new Error('Worker already initialized');
    }

    this.ready = false;
    this.state = 'initializing';
    this.workerUrl = workerUrl;

    return new Promise((resolve, reject) => {
      try {
        // Workers in /public/ are plain scripts (not ES modules).
        // Using { type: 'module' } would cause them to fail silently.
        this.worker = new Worker(workerUrl);
        
        this.worker.onmessage = (event) => {
          this._handleMessage(event.data);
        };
        
        this.worker.onerror = (error) => {
          console.error('[WorkerProxy] Worker error:', error);
          this._rejectAllPending('Worker error');
          this.state = 'terminated';
          this.ready = false;
          this._emit('error', error);
        };

        // Wait for worker ready signal
        const readyTimeout = setTimeout(() => {
          reject(new Error('Worker initialization timeout'));
        }, 10000);

        this.readyCallbacks.push(() => {
          clearTimeout(readyTimeout);
          // State is already set to 'running' by _handleMessage workerReady handler
          resolve();
        });
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
    if (!isValidMessage(data)) {
      console.warn('[WorkerProxy] Invalid message received:', data);
      return;
    }

    // Handle workerReady BEFORE generation fencing.
    // The worker starts with its own generation counter (typically 0).
    // We sync our generation to match so subsequent messages pass the fence.
    if (data.type === 'event' && data.method === 'workerReady') {
      if (typeof data.generation === 'number') {
        this.generation = data.generation;
      }
      this.ready = true;
      this.state = 'running';
      this.readyCallbacks.forEach(cb => cb());
      this.readyCallbacks = [];
      this._emit(data.method, ...(data.args || []));
      return;
    }

    if (typeof data?.generation === 'number' && data.generation !== this.generation) {
      // Drop stale replies from older worker generations
      return;
    }

    this.messageCount++;
    this.lastMessageTime = performance.now();

    if (data.type === 'response') {
      const pending = this.pendingRequests.get(data.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(data.id);
        
        if (data.error) {
          const err = new Error(data.error.message);
          err.stack = data.error.stack;
          pending.reject(err);
        } else {
          pending.resolve(data.result);
        }
      }
    } else if (data.type === 'event') {
      this._emit(data.method, ...(data.args || []));
    }
  }

  /**
   * Send a request to the worker and wait for response
   * @param {string} method
   * @param {any[]} args
   * @param {number} [timeout]
   * @returns {Promise<any>}
   */
  async request(method, args = [], timeout = this.defaultTimeout) {
    if (!this.worker) {
      throw new Error('Worker not initialized');
    }

    if (this.state !== 'running') {
      throw new Error(`Worker not ready (state: ${this.state})`);
    }

    const msg = createRequest(method, args);
    msg.generation = this.generation;

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`Request timeout: ${method}`));
      }, timeout);

      this.pendingRequests.set(msg.id, {
        resolve,
        reject,
        timeout: timeoutId,
        startTime: performance.now()
      });

      this.worker.postMessage(msg);
    });
  }

  /**
   * Send an event to the worker (no response expected)
   * @param {string} method
   * @param {any[]} args
   */
  send(method, args = []) {
    if (!this.worker) {
      console.warn('[WorkerProxy] Cannot send, worker not initialized');
      return;
    }

    const msg = createEvent(method, args);
    msg.generation = this.generation;
    this.worker.postMessage(msg);
  }

  /**
   * Subscribe to events from worker
   * @param {string} event
   * @param {Function} callback
   * @returns {Function} Unsubscribe function
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
   * Emit event to listeners
   * @param {string} event
   * @param {...any} args
   */
  _emit(event, ...args) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.forEach(cb => {
        try {
          cb(...args);
        } catch (err) {
          console.error(`[WorkerProxy] Event listener error (${event}):`, err);
        }
      });
    }
  }

  /**
   * Terminate the worker
   */
  terminate() {
    if (this.worker) {
      this._rejectAllPending('Worker terminated');

      this.worker.terminate();
      this.worker = null;
      this.ready = false;
      this.state = 'terminated';
    }
  }

  /**
   * Begin a restart cycle so new requests are rejected until init completes
   */
  beginRestart() {
    this.state = 'restarting';
    this.ready = false;
    this._rejectAllPending('Worker restarting');
  }

  /**
   * Reject and clear all pending requests
   * @param {string} reason
   * @private
   */
  _rejectAllPending(reason) {
    this.pendingRequests.forEach((pending) => {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    });
    this.pendingRequests.clear();
  }

  /**
   * Check if worker is ready
   * @returns {boolean}
   */
  isReady() {
    return this.ready;
  }

  // =========================================================================
  // Convenience methods for common operations
  // =========================================================================

  /**
   * Activate an extension
   * @param {string} extensionId
   * @returns {Promise<{ success: boolean, activationTime: number, error?: string }>}
   */
  activateExtension(extensionId) {
    return this.request(MainToWorkerMethods.ACTIVATE_EXTENSION, [extensionId], 8000)
      .catch(err => {
        if (err.message && err.message.startsWith('Request timeout')) {
          err.code = 'ACTIVATION_TIMEOUT';
          err.extensionId = extensionId;
        }
        throw err;
      });
  }

  /**
   * Deactivate an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  deactivateExtension(extensionId) {
    return this.request(MainToWorkerMethods.DEACTIVATE_EXTENSION, [extensionId]);
  }

  /**
   * Load extension code into worker
   * @param {string} extensionId
   * @param {string} code - Extension JavaScript code
   * @param {object} manifest - Extension manifest
   * @returns {Promise<void>}
   */
  loadExtension(extensionId, code, manifest) {
    // Large extensions (e.g. GitHub Pull Requests) can take a while to eval.
    // Use a generous 30s timeout instead of the default 5s.
    return this.request(MainToWorkerMethods.LOAD_EXTENSION, [extensionId, code, manifest], 30000);
  }

  /**
   * Execute a command
   * @param {string} commandId
   * @param {...any} args
   * @returns {Promise<any>}
   */
  executeCommand(commandId, ...args) {
    return this.request(MainToWorkerMethods.EXECUTE_COMMAND, [commandId, ...args], 1000);
  }

  /**
   * Notify worker of document open
   * @param {object} document - Document info
   */
  notifyDocumentOpen(document) {
    this.send(MainToWorkerMethods.TEXT_DOCUMENT_OPEN, [document]);
  }

  /**
   * Notify worker of document change
   * @param {string} uri
   * @param {object[]} changes
   * @param {number} version
   */
  notifyDocumentChange(uri, changes, version) {
    this.send(MainToWorkerMethods.TEXT_DOCUMENT_CHANGE, [uri, changes, version]);
  }

  /**
   * Notify worker of document close
   * @param {string} uri
   */
  notifyDocumentClose(uri) {
    this.send(MainToWorkerMethods.TEXT_DOCUMENT_CLOSE, [uri]);
  }

  /**
   * Notify worker of selection change
   * @param {string} uri
   * @param {object[]} selections
   */
  notifySelectionChange(uri, selections) {
    this.send(MainToWorkerMethods.SELECTION_CHANGE, [uri, selections]);
  }

  /**
   * Get performance metrics from worker
   * @returns {Promise<object>}
   */
  getMetrics() {
    return this.request(MainToWorkerMethods.GET_METRICS, []);
  }

  /**
   * Suspend an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  suspendExtension(extensionId) {
    return this.request(MainToWorkerMethods.SUSPEND_EXTENSION, [extensionId]);
  }

  /**
   * Resume an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  resumeExtension(extensionId) {
    return this.request(MainToWorkerMethods.RESUME_EXTENSION, [extensionId]);
  }

  /**
   * Kill an extension
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  killExtension(extensionId) {
    return this.request(MainToWorkerMethods.KILL_EXTENSION, [extensionId]);
  }
}

// Singleton instance
let instance = null;

/**
 * Get the WorkerProxy singleton
 * @returns {WorkerProxy}
 */
export function getWorkerProxy() {
  if (!instance) {
    instance = new WorkerProxy();
  }
  return instance;
}

/**
 * Create a new WorkerProxy (for testing)
 * @returns {WorkerProxy}
 */
export function createWorkerProxy() {
  return new WorkerProxy();
}
