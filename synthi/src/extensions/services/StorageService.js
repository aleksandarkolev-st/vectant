/**
 * Synthi Extension System - Storage Service
 * IndexedDB-based async storage for extensions
 */

const DB_NAME = 'synthi-extensions';
const DB_VERSION = 1;
const STORE_WORKSPACE = 'workspace';
const STORE_GLOBAL = 'global';
const STORE_SECRETS = 'secrets';

/**
 * Storage service for extensions
 */
export class StorageService {
  constructor() {
    /** @type {IDBDatabase|null} */
    this.db = null;
    
    /** @type {Promise<void>|null} */
    this._initPromise = null;
    
    /** @type {Map<string, any>} In-memory cache */
    this.cache = new Map();
    
    /** @type {number} Cache size limit (bytes) */
    this.cacheSizeLimit = 5 * 1024 * 1024; // 5MB
    
    /** @type {number} Current cache size estimate */
    this.cacheSize = 0;
    
    /** @type {string} */
    this.workspaceId = 'default';
  }

  /**
   * Open storage for a workspace
   * @param {string} [workspaceId]
   * @returns {Promise<void>}
   */
  async open(workspaceId = 'default') {
    this.workspaceId = workspaceId;
    return this.init();
  }

  /**
   * Initialize the storage
   * @returns {Promise<void>}
   */
  async init() {
    if (this._initPromise) return this._initPromise;

    this._initPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[StorageService] Failed to open database:', request.error);
        reject(request.error);
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = request.result;

        // Create stores
        if (!db.objectStoreNames.contains(STORE_WORKSPACE)) {
          db.createObjectStore(STORE_WORKSPACE, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_GLOBAL)) {
          db.createObjectStore(STORE_GLOBAL, { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains(STORE_SECRETS)) {
          db.createObjectStore(STORE_SECRETS, { keyPath: 'key' });
        }
      };
    });

    return this._initPromise;
  }

  /**
   * Ensure database is ready
   * @returns {Promise<void>}
   */
  async _ensureReady() {
    if (!this.db) {
      await this.init();
    }
  }

  /**
   * Get a value
   * @param {string} scope - 'workspace', 'global', or 'secrets'
   * @param {string} extensionId
   * @param {string} key
   * @returns {Promise<any>}
   */
  async get(scope, extensionId, key) {
    const cacheKey = `${scope}:${extensionId}:${key}`;
    
    // Check cache first
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey);
    }

    await this._ensureReady();

    const storeName = this._getStoreName(scope);
    const fullKey = `${extensionId}:${key}`;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.get(fullKey);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const value = request.result?.value;
        
        // Update cache
        if (value !== undefined) {
          this._cacheSet(cacheKey, value);
        }
        
        resolve(value);
      };
    });
  }

  /**
   * Set a value
   * @param {string} scope
   * @param {string} extensionId
   * @param {string} key
   * @param {any} value
   * @returns {Promise<void>}
   */
  async set(scope, extensionId, key, value) {
    await this._ensureReady();

    const storeName = this._getStoreName(scope);
    const fullKey = `${extensionId}:${key}`;
    const cacheKey = `${scope}:${extensionId}:${key}`;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, 'readwrite');
      const store = transaction.objectStore(storeName);

      if (value === undefined) {
        // Delete
        const request = store.delete(fullKey);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this.cache.delete(cacheKey);
          resolve();
        };
      } else {
        // Set
        const request = store.put({ key: fullKey, value });
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          this._cacheSet(cacheKey, value);
          resolve();
        };
      }
    });
  }

  /**
   * Delete a value
   * @param {string} scope
   * @param {string} extensionId
   * @param {string} key
   * @returns {Promise<void>}
   */
  async delete(scope, extensionId, key) {
    return this.set(scope, extensionId, key, undefined);
  }

  /**
   * Get all keys for an extension
   * @param {string} scope
   * @param {string} extensionId
   * @returns {Promise<string[]>}
   */
  async keys(scope, extensionId) {
    await this._ensureReady();

    const storeName = this._getStoreName(scope);
    const prefix = `${extensionId}:`;

    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction(storeName, 'readonly');
      const store = transaction.objectStore(storeName);
      const request = store.getAllKeys();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const keys = request.result
          .filter(k => k.startsWith(prefix))
          .map(k => k.slice(prefix.length));
        resolve(keys);
      };
    });
  }

  /**
   * Clear all data for an extension
   * @param {string} scope
   * @param {string} extensionId
   * @returns {Promise<void>}
   */
  async clear(scope, extensionId) {
    const keys = await this.keys(scope, extensionId);
    
    for (const key of keys) {
      await this.delete(scope, extensionId, key);
    }

    // Clear cache
    const prefix = `${scope}:${extensionId}:`;
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * Get store name for scope
   * @param {string} scope
   * @returns {string}
   */
  _getStoreName(scope) {
    switch (scope) {
      case 'workspace': return STORE_WORKSPACE;
      case 'global': return STORE_GLOBAL;
      case 'secrets': return STORE_SECRETS;
      default: throw new Error(`Unknown scope: ${scope}`);
    }
  }

  /**
   * Set value in cache with size management
   * @param {string} key
   * @param {any} value
   */
  _cacheSet(key, value) {
    // Estimate size
    const size = JSON.stringify(value).length * 2; // UTF-16

    // If cache is too large, evict oldest entries
    while (this.cacheSize + size > this.cacheSizeLimit && this.cache.size > 0) {
      const firstKey = this.cache.keys().next().value;
      const firstValue = this.cache.get(firstKey);
      const firstSize = JSON.stringify(firstValue).length * 2;
      this.cache.delete(firstKey);
      this.cacheSize -= firstSize;
    }

    // Remove old value if exists
    if (this.cache.has(key)) {
      const oldValue = this.cache.get(key);
      const oldSize = JSON.stringify(oldValue).length * 2;
      this.cacheSize -= oldSize;
    }

    this.cache.set(key, value);
    this.cacheSize += size;
  }

  /**
   * Close the database
   */
  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
    this._initPromise = null;
    this.cache.clear();
    this.cacheSize = 0;
  }
}

// Singleton
let instance = null;

/**
 * Get StorageService singleton
 * @returns {StorageService}
 */
export function getStorageService() {
  if (!instance) {
    instance = new StorageService();
  }
  return instance;
}
