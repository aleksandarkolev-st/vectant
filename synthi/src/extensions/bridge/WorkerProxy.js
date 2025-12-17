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

    return new Promise((resolve, reject) => {
      try {
        this.worker = new Worker(workerUrl, { type: 'module' });
        
        this.worker.onmessage = (event) => {
          this._handleMessage(event.data);
        };
        
        this.worker.onerror = (error) => {
          console.error('[WorkerProxy] Worker error:', error);
          this._emit('error', error);
        };

        // Wait for worker ready signal
        const readyTimeout = setTimeout(() => {
          reject(new Error('Worker initialization timeout'));
        }, 10000);

        this.readyCallbacks.push(() => {
          clearTimeout(readyTimeout);
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
      // Handle worker ready signal
      if (data.method === 'workerReady') {
        this.ready = true;
        this.readyCallbacks.forEach(cb => cb());
        this.readyCallbacks = [];
      }
      
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

    const msg = createRequest(method, args);

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
      // Reject all pending requests
      this.pendingRequests.forEach((pending, id) => {
        clearTimeout(pending.timeout);
        pending.reject(new Error('Worker terminated'));
      });
      this.pendingRequests.clear();

      this.worker.terminate();
      this.worker = null;
      this.ready = false;
    }
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
    return this.request(MainToWorkerMethods.ACTIVATE_EXTENSION, [extensionId], 2000);
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
    return this.request(MainToWorkerMethods.LOAD_EXTENSION, [extensionId, code, manifest]);
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
