/**
 * Synthi Extension System - Async Observability Store
 * CRITICAL: localStorage is blocking and unsafe
 * 
 * Uses IndexedDB for:
 * - Non-blocking async writes
 * - Batched operations
 * - Never writes on hot paths
 * 
 * If observability can slow the IDE, it's broken.
 */

const DB_NAME = 'synthi-extension-observability';
const DB_VERSION = 1;

// Object stores
const STORES = {
  CRASH_HISTORY: 'crashHistory',
  EXTENSION_METRICS: 'extensionMetrics',
  ACTION_LOG: 'actionLog',
  HEALTH_SNAPSHOTS: 'healthSnapshots'
};

/**
 * @typedef {Object} CrashRecord
 * @property {string} id - Unique ID (extensionId + timestamp)
 * @property {string} extensionId
 * @property {string} failureType
 * @property {string} reason
 * @property {number} timestamp
 * @property {string|null} stackTrace
 */

/**
 * @typedef {Object} MetricsRecord
 * @property {string} extensionId
 * @property {number} activations
 * @property {number} crashes
 * @property {number} apiViolations
 * @property {number} totalCpuTime
 * @property {number} messagesIn
 * @property {number} messagesOut
 * @property {number} lastUpdated
 */

/**
 * Async Observability Store using IndexedDB
 */
export class ObservabilityStore {
  constructor() {
    /** @type {IDBDatabase|null} */
    this.db = null;
    
    /** @type {Promise<void>|null} */
    this.initPromise = null;
    
    /** @type {boolean} */
    this.initialized = false;
    
    /** @type {Array<{store: string, operation: string, data: any}>} */
    this.pendingWrites = [];
    
    /** @type {NodeJS.Timeout|null} */
    this.flushTimer = null;
    
    /** @type {number} */
    this.flushIntervalMs = 5000; // Batch writes every 5 seconds
    
    /** @type {number} */
    this.maxPendingWrites = 100;
    
    /** @type {boolean} */
    this.isAvailable = typeof indexedDB !== 'undefined';
  }

  /**
   * Initialize the database
   * @returns {Promise<void>}
   */
  async init() {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    
    if (!this.isAvailable) {
      console.warn('[ObservabilityStore] IndexedDB not available, falling back to memory-only');
      this.initialized = true;
      return;
    }

    this.initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onerror = () => {
        console.error('[ObservabilityStore] Failed to open database:', request.error);
        this.isAvailable = false;
        resolve(); // Don't fail, just degrade
      };
      
      request.onsuccess = () => {
        this.db = request.result;
        this.initialized = true;
        this._startFlushTimer();
        resolve();
      };
      
      request.onupgradeneeded = (event) => {
        const db = event.target.result;
        
        // Crash history store
        if (!db.objectStoreNames.contains(STORES.CRASH_HISTORY)) {
          const crashStore = db.createObjectStore(STORES.CRASH_HISTORY, { keyPath: 'id' });
          crashStore.createIndex('extensionId', 'extensionId', { unique: false });
          crashStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Extension metrics store
        if (!db.objectStoreNames.contains(STORES.EXTENSION_METRICS)) {
          db.createObjectStore(STORES.EXTENSION_METRICS, { keyPath: 'extensionId' });
        }
        
        // Action log store
        if (!db.objectStoreNames.contains(STORES.ACTION_LOG)) {
          const logStore = db.createObjectStore(STORES.ACTION_LOG, { 
            keyPath: 'id', 
            autoIncrement: true 
          });
          logStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Health snapshots store
        if (!db.objectStoreNames.contains(STORES.HEALTH_SNAPSHOTS)) {
          const healthStore = db.createObjectStore(STORES.HEALTH_SNAPSHOTS, { 
            keyPath: 'id', 
            autoIncrement: true 
          });
          healthStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });

    return this.initPromise;
  }

  /**
   * Queue a crash record for writing
   * NON-BLOCKING - returns immediately
   * @param {string} extensionId
   * @param {string} failureType
   * @param {string} reason
   * @param {string|null} [stackTrace]
   */
  recordCrash(extensionId, failureType, reason, stackTrace = null) {
    const record = {
      id: `${extensionId}-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      extensionId,
      failureType,
      reason,
      timestamp: Date.now(),
      stackTrace
    };
    
    this._queueWrite(STORES.CRASH_HISTORY, 'put', record);
  }

  /**
   * Queue metrics update
   * NON-BLOCKING - returns immediately
   * @param {string} extensionId
   * @param {Partial<MetricsRecord>} updates
   */
  updateMetrics(extensionId, updates) {
    this._queueWrite(STORES.EXTENSION_METRICS, 'update', {
      extensionId,
      updates,
      timestamp: Date.now()
    });
  }

  /**
   * Queue action log entry
   * NON-BLOCKING - returns immediately
   * @param {string} action
   * @param {string} extensionId
   * @param {object} [details]
   */
  logAction(action, extensionId, details = {}) {
    this._queueWrite(STORES.ACTION_LOG, 'add', {
      action,
      extensionId,
      details,
      timestamp: Date.now()
    });
  }

  /**
   * Queue health snapshot
   * NON-BLOCKING - returns immediately
   * @param {object} snapshot
   */
  recordHealthSnapshot(snapshot) {
    this._queueWrite(STORES.HEALTH_SNAPSHOTS, 'add', {
      ...snapshot,
      timestamp: Date.now()
    });
  }

  /**
   * Get crash history for extension (async)
   * @param {string} extensionId
   * @param {number} [limit=100]
   * @returns {Promise<CrashRecord[]>}
   */
  async getCrashHistory(extensionId, limit = 100) {
    await this.init();
    
    if (!this.db) return [];
    
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(STORES.CRASH_HISTORY, 'readonly');
        const store = tx.objectStore(STORES.CRASH_HISTORY);
        const index = store.index('extensionId');
        const request = index.getAll(IDBKeyRange.only(extensionId), limit);
        
        request.onsuccess = () => {
          resolve(request.result || []);
        };
        
        request.onerror = () => {
          console.error('[ObservabilityStore] getCrashHistory error:', request.error);
          resolve([]);
        };
      } catch (err) {
        console.error('[ObservabilityStore] getCrashHistory exception:', err);
        resolve([]);
      }
    });
  }

  /**
   * Get metrics for extension (async)
   * @param {string} extensionId
   * @returns {Promise<MetricsRecord|null>}
   */
  async getMetrics(extensionId) {
    await this.init();
    
    if (!this.db) return null;
    
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(STORES.EXTENSION_METRICS, 'readonly');
        const store = tx.objectStore(STORES.EXTENSION_METRICS);
        const request = store.get(extensionId);
        
        request.onsuccess = () => {
          resolve(request.result || null);
        };
        
        request.onerror = () => {
          console.error('[ObservabilityStore] getMetrics error:', request.error);
          resolve(null);
        };
      } catch (err) {
        console.error('[ObservabilityStore] getMetrics exception:', err);
        resolve(null);
      }
    });
  }

  /**
   * Get all metrics (async)
   * @returns {Promise<MetricsRecord[]>}
   */
  async getAllMetrics() {
    await this.init();
    
    if (!this.db) return [];
    
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(STORES.EXTENSION_METRICS, 'readonly');
        const store = tx.objectStore(STORES.EXTENSION_METRICS);
        const request = store.getAll();
        
        request.onsuccess = () => {
          resolve(request.result || []);
        };
        
        request.onerror = () => {
          console.error('[ObservabilityStore] getAllMetrics error:', request.error);
          resolve([]);
        };
      } catch (err) {
        console.error('[ObservabilityStore] getAllMetrics exception:', err);
        resolve([]);
      }
    });
  }

  /**
   * Get recent action log entries (async)
   * @param {number} [limit=100]
   * @returns {Promise<object[]>}
   */
  async getRecentActions(limit = 100) {
    await this.init();
    
    if (!this.db) return [];
    
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(STORES.ACTION_LOG, 'readonly');
        const store = tx.objectStore(STORES.ACTION_LOG);
        const index = store.index('timestamp');
        
        // Get last N entries
        const results = [];
        const cursorRequest = index.openCursor(null, 'prev');
        
        cursorRequest.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor && results.length < limit) {
            results.push(cursor.value);
            cursor.continue();
          } else {
            resolve(results);
          }
        };
        
        cursorRequest.onerror = () => {
          console.error('[ObservabilityStore] getRecentActions error:', cursorRequest.error);
          resolve([]);
        };
      } catch (err) {
        console.error('[ObservabilityStore] getRecentActions exception:', err);
        resolve([]);
      }
    });
  }

  /**
   * Flush all pending writes NOW
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.pendingWrites.length === 0) return;
    if (!this.db) return;

    const writes = [...this.pendingWrites];
    this.pendingWrites = [];

    // Group by store for efficiency
    const byStore = new Map();
    for (const write of writes) {
      if (!byStore.has(write.store)) {
        byStore.set(write.store, []);
      }
      byStore.get(write.store).push(write);
    }

    // Execute writes per store
    const promises = [];
    
    for (const [storeName, storeWrites] of byStore) {
      promises.push(this._executeWrites(storeName, storeWrites));
    }

    try {
      await Promise.all(promises);
    } catch (err) {
      console.error('[ObservabilityStore] Flush error:', err);
      // Re-queue failed writes (up to a limit)
      if (this.pendingWrites.length < this.maxPendingWrites) {
        this.pendingWrites.push(...writes);
      }
    }
  }

  /**
   * Clear all data (for testing)
   * @returns {Promise<void>}
   */
  async clear() {
    await this.init();
    
    if (!this.db) return;
    
    const stores = Object.values(STORES);
    
    for (const storeName of stores) {
      await new Promise((resolve) => {
        try {
          const tx = this.db.transaction(storeName, 'readwrite');
          const store = tx.objectStore(storeName);
          const request = store.clear();
          request.onsuccess = () => resolve();
          request.onerror = () => resolve();
        } catch (err) {
          resolve();
        }
      });
    }
  }

  /**
   * Stop the store
   */
  stop() {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    
    // Final flush (best effort, non-blocking)
    this.flush().catch(() => {});
  }

  // =========================================================================
  // Private Methods
  // =========================================================================

  _queueWrite(store, operation, data) {
    this.pendingWrites.push({ store, operation, data });
    
    // If too many pending, flush immediately
    if (this.pendingWrites.length >= this.maxPendingWrites) {
      this.flush().catch(() => {});
    }
  }

  _startFlushTimer() {
    if (this.flushTimer) return;
    
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) => {
        console.error('[ObservabilityStore] Auto-flush error:', err);
      });
    }, this.flushIntervalMs);
  }

  async _executeWrites(storeName, writes) {
    if (!this.db) return;
    
    return new Promise((resolve, reject) => {
      try {
        const tx = this.db.transaction(storeName, 'readwrite');
        const store = tx.objectStore(storeName);
        
        for (const write of writes) {
          if (write.operation === 'put') {
            store.put(write.data);
          } else if (write.operation === 'add') {
            store.add(write.data);
          } else if (write.operation === 'update') {
            // Read-modify-write for updates
            const getReq = store.get(write.data.extensionId);
            getReq.onsuccess = () => {
              const existing = getReq.result || {
                extensionId: write.data.extensionId,
                activations: 0,
                crashes: 0,
                apiViolations: 0,
                totalCpuTime: 0,
                messagesIn: 0,
                messagesOut: 0,
                lastUpdated: 0
              };
              
              // Merge updates
              const updated = { ...existing, ...write.data.updates, lastUpdated: Date.now() };
              store.put(updated);
            };
          }
        }
        
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      } catch (err) {
        reject(err);
      }
    });
  }
}

// Singleton
let storeInstance = null;

/**
 * Get singleton ObservabilityStore
 * @returns {ObservabilityStore}
 */
export function getObservabilityStore() {
  if (!storeInstance) {
    storeInstance = new ObservabilityStore();
  }
  return storeInstance;
}

/**
 * Create a new store (for testing)
 * @returns {ObservabilityStore}
 */
export function createObservabilityStore() {
  return new ObservabilityStore();
}
