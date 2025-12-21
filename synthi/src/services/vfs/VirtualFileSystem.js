/**
 * Virtual File System (VFS) - Server-First Architecture
 * 
 * This module implements a Server-First file system abstraction that ensures
 * 100% consistency between the frontend editor, backend execution, and AI context.
 * 
 * Architecture:
 * 1. SERVER is the absolute Source of Truth
 * 2. All reads go through the server (with local caching for speed)
 * 3. All writes go to the server first, then propagate to local cache
 * 4. Content hashes ensure consistency validation
 * 5. Version vectors prevent stale updates
 * 
 * Cache Layers:
 * - Layer 1 (Hot): In-memory Map for open/active files
 * - Layer 2 (Warm): IndexedDB for session persistence (validated on connect)
 * - Layer 3 (Server): Server-side file system (absolute truth)
 */

import { EventEmitter } from 'events';

// ============================================================================
// Constants
// ============================================================================

const VFS_DB_NAME = 'synthi-vfs';
const VFS_DB_VERSION = 1;
const VFS_STORE_FILES = 'files';
const VFS_STORE_META = 'meta';

const SYNC_DEBOUNCE_MS = 100;
const VALIDATION_INTERVAL_MS = 30000; // Validate hashes every 30s
const MAX_HOT_CACHE_SIZE = 50 * 1024 * 1024; // 50MB hot cache

// ============================================================================
// Types
// ============================================================================

/**
 * @typedef {Object} VFSFile
 * @property {string} path - Absolute path within workspace
 * @property {string} content - File content
 * @property {string} contentHash - SHA-256 hash of content
 * @property {number} version - Monotonic version counter
 * @property {number} serverVersion - Last known server version
 * @property {number} lastModified - Timestamp of last modification
 * @property {string} language - Detected language
 * @property {'clean'|'dirty'|'syncing'|'conflict'} syncState
 * @property {string} [serverHash] - Last known server hash (for conflict detection)
 */

/**
 * @typedef {Object} VFSEvent
 * @property {'change'|'save'|'sync'|'conflict'|'delete'} type
 * @property {string} path
 * @property {VFSFile} [file]
 * @property {string} [error]
 */

// ============================================================================
// Utilities
// ============================================================================

/**
 * Compute SHA-256 hash of content
 * @param {string} content 
 * @returns {Promise<string>}
 */
async function computeHash(content) {
  if (!content) return 'empty';
  
  // Use Web Crypto API if available (faster, async)
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoder = new TextEncoder();
    const data = encoder.encode(content);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  }
  
  // Fallback to simple hash
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16);
}

/**
 * Detect language from file extension
 * @param {string} path 
 * @returns {string}
 */
function detectLanguage(path) {
  if (!path) return 'plaintext';
  const ext = path.split('.').pop()?.toLowerCase();
  const langMap = {
    'js': 'javascript', 'jsx': 'javascriptreact',
    'ts': 'typescript', 'tsx': 'typescriptreact',
    'py': 'python', 'rs': 'rust', 'go': 'go',
    'java': 'java', 'c': 'c', 'cpp': 'cpp',
    'h': 'c', 'hpp': 'cpp', 'css': 'css',
    'scss': 'scss', 'html': 'html', 'json': 'json',
    'yaml': 'yaml', 'yml': 'yaml', 'md': 'markdown',
    'toml': 'toml', 'xml': 'xml', 'sql': 'sql',
  };
  return langMap[ext] || 'plaintext';
}

// ============================================================================
// IndexedDB Cache Layer
// ============================================================================

class IndexedDBCache {
  constructor() {
    /** @type {IDBDatabase|null} */
    this.db = null;
    this.initPromise = null;
  }

  async init() {
    if (this.db) return;
    if (this.initPromise) return this.initPromise;

    this.initPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        resolve(); // IndexedDB not available, skip
        return;
      }

      const request = indexedDB.open(VFS_DB_NAME, VFS_DB_VERSION);

      request.onerror = () => {
        console.warn('[VFS] IndexedDB failed to open:', request.error);
        resolve(); // Don't block on IndexedDB failure
      };

      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = request.result;
        
        if (!db.objectStoreNames.contains(VFS_STORE_FILES)) {
          const store = db.createObjectStore(VFS_STORE_FILES, { keyPath: 'key' });
          store.createIndex('workspace', 'workspace', { unique: false });
          store.createIndex('lastAccessed', 'lastAccessed', { unique: false });
        }
        
        if (!db.objectStoreNames.contains(VFS_STORE_META)) {
          db.createObjectStore(VFS_STORE_META, { keyPath: 'key' });
        }
      };
    });

    return this.initPromise;
  }

  _key(workspaceId, path) {
    return `${workspaceId}:${path}`;
  }

  async get(workspaceId, path) {
    await this.init();
    if (!this.db) return null;

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(VFS_STORE_FILES, 'readonly');
        const store = tx.objectStore(VFS_STORE_FILES);
        const request = store.get(this._key(workspaceId, path));

        request.onsuccess = () => resolve(request.result?.data || null);
        request.onerror = () => resolve(null);
      } catch (e) {
        resolve(null);
      }
    });
  }

  async set(workspaceId, path, data) {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(VFS_STORE_FILES, 'readwrite');
        const store = tx.objectStore(VFS_STORE_FILES);
        
        store.put({
          key: this._key(workspaceId, path),
          workspace: workspaceId,
          path,
          data,
          lastAccessed: Date.now(),
        });

        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async delete(workspaceId, path) {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(VFS_STORE_FILES, 'readwrite');
        const store = tx.objectStore(VFS_STORE_FILES);
        store.delete(this._key(workspaceId, path));
        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }

  async clearWorkspace(workspaceId) {
    await this.init();
    if (!this.db) return;

    return new Promise((resolve) => {
      try {
        const tx = this.db.transaction(VFS_STORE_FILES, 'readwrite');
        const store = tx.objectStore(VFS_STORE_FILES);
        const index = store.index('workspace');
        const request = index.openCursor(IDBKeyRange.only(workspaceId));

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            store.delete(cursor.primaryKey);
            cursor.continue();
          }
        };

        tx.oncomplete = () => resolve();
        tx.onerror = () => resolve();
      } catch (e) {
        resolve();
      }
    });
  }
}

// ============================================================================
// Virtual File System
// ============================================================================

export class VirtualFileSystem extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.workspaceId
   * @param {string} options.serverUrl
   */
  constructor({ workspaceId, serverUrl }) {
    super();
    
    this.workspaceId = workspaceId;
    this.serverUrl = serverUrl || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';
    
    // Hot cache (in-memory)
    /** @type {Map<string, VFSFile>} */
    this.hotCache = new Map();
    this.hotCacheSize = 0;
    
    // Warm cache (IndexedDB)
    this.warmCache = new IndexedDBCache();
    
    // Pending writes queue
    /** @type {Map<string, {content: string, resolve: Function, reject: Function}>} */
    this.pendingWrites = new Map();
    this.writeDebounceTimer = null;
    
    // Connection state
    this.connected = false;
    this.validationTimer = null;
    
    // Version tracking for conflict detection
    this.localVersions = new Map(); // path -> version
  }

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  async connect() {
    console.log('[VFS] Connecting to workspace:', this.workspaceId);
    
    // Initialize warm cache
    await this.warmCache.init();
    
    // Validate cached files against server
    await this._validateCachedFiles();
    
    this.connected = true;
    
    // Start periodic validation
    this.validationTimer = setInterval(() => {
      this._validateCachedFiles().catch(console.error);
    }, VALIDATION_INTERVAL_MS);
    
    this.emit('connected');
    console.log('[VFS] Connected');
  }

  disconnect() {
    console.log('[VFS] Disconnecting');
    
    if (this.validationTimer) {
      clearInterval(this.validationTimer);
      this.validationTimer = null;
    }
    
    if (this.writeDebounceTimer) {
      clearTimeout(this.writeDebounceTimer);
      this.writeDebounceTimer = null;
    }
    
    this.connected = false;
    this.emit('disconnected');
  }

  // ==========================================================================
  // Read Operations (Server-First with Caching)
  // ==========================================================================

  /**
   * Read file content - Server authoritative with hot/warm caching
   * @param {string} path 
   * @param {Object} options
   * @param {boolean} [options.forceServer=false] - Bypass cache
   * @param {AbortSignal} [options.signal]
   * @returns {Promise<VFSFile>}
   */
  async readFile(path, options = {}) {
    const { forceServer = false, signal } = options;
    
    // 1. Check hot cache (fastest)
    if (!forceServer) {
      const hotFile = this.hotCache.get(path);
      if (hotFile && hotFile.syncState !== 'conflict') {
        console.log(`[VFS] Hot cache hit: ${path}`);
        return hotFile;
      }
    }
    
    // 2. Check warm cache and validate against server hash
    if (!forceServer) {
      const warmFile = await this.warmCache.get(this.workspaceId, path);
      if (warmFile) {
        // Validate hash against server
        const serverHash = await this._fetchServerHash(path, signal);
        if (serverHash && serverHash === warmFile.contentHash) {
          console.log(`[VFS] Warm cache hit (validated): ${path}`);
          // Promote to hot cache
          this._addToHotCache(path, warmFile);
          return warmFile;
        }
        console.log(`[VFS] Warm cache stale, fetching from server: ${path}`);
      }
    }
    
    // 3. Fetch from server (Source of Truth)
    console.log(`[VFS] Fetching from server: ${path}`);
    const content = await this._fetchFromServer(path, signal);
    const contentHash = await computeHash(content);
    
    const file = {
      path,
      content,
      contentHash,
      version: (this.localVersions.get(path) || 0) + 1,
      serverVersion: Date.now(),
      lastModified: Date.now(),
      language: detectLanguage(path),
      syncState: 'clean',
      serverHash: contentHash,
    };
    
    this.localVersions.set(path, file.version);
    
    // Update both caches
    this._addToHotCache(path, file);
    await this.warmCache.set(this.workspaceId, path, file);
    
    return file;
  }

  /**
   * Get file from hot cache only (for performance-critical reads)
   * @param {string} path 
   * @returns {VFSFile|null}
   */
  getFromHotCache(path) {
    return this.hotCache.get(path) || null;
  }

  /**
   * Check if file exists and get its metadata
   * @param {string} path 
   * @returns {Promise<{exists: boolean, hash?: string}>}
   */
  async exists(path) {
    try {
      const hash = await this._fetchServerHash(path);
      return { exists: hash !== null, hash };
    } catch {
      return { exists: false };
    }
  }

  // ==========================================================================
  // Write Operations (Server-First)
  // ==========================================================================

  /**
   * Update file content locally (marks as dirty)
   * This is called on every keystroke but doesn't immediately save to server
   * @param {string} path 
   * @param {string} content 
   * @returns {Promise<VFSFile>}
   */
  async updateContent(path, content) {
    const contentHash = await computeHash(content);
    
    let file = this.hotCache.get(path);
    
    if (file) {
      // Check if content actually changed
      if (file.contentHash === contentHash) {
        return file; // No change
      }
      
      // Update existing file
      file = {
        ...file,
        content,
        contentHash,
        version: file.version + 1,
        lastModified: Date.now(),
        syncState: 'dirty',
      };
    } else {
      // New file
      file = {
        path,
        content,
        contentHash,
        version: 1,
        serverVersion: 0,
        lastModified: Date.now(),
        language: detectLanguage(path),
        syncState: 'dirty',
        serverHash: null,
      };
    }
    
    this.localVersions.set(path, file.version);
    this._addToHotCache(path, file);
    
    this.emit('change', { type: 'change', path, file });
    
    return file;
  }

  /**
   * Save file to server (explicit save action)
   * @param {string} path 
   * @param {string} [content] - If not provided, uses hot cache content
   * @returns {Promise<VFSFile>}
   */
  async saveFile(path, content) {
    let file = this.hotCache.get(path);
    
    if (content !== undefined) {
      // Use provided content
      file = await this.updateContent(path, content);
    } else if (!file) {
      throw new Error(`File not in cache: ${path}`);
    }
    
    // Mark as syncing
    file = { ...file, syncState: 'syncing' };
    this._addToHotCache(path, file);
    
    try {
      // Send to server
      await this._saveToServer(path, file.content);
      
      // Update state to clean
      file = {
        ...file,
        syncState: 'clean',
        serverVersion: Date.now(),
        serverHash: file.contentHash,
      };
      
      this._addToHotCache(path, file);
      await this.warmCache.set(this.workspaceId, path, file);
      
      this.emit('save', { type: 'save', path, file });
      
      console.log(`[VFS] Saved to server: ${path}`);
      return file;
      
    } catch (error) {
      // Revert to dirty state
      file = { ...file, syncState: 'dirty' };
      this._addToHotCache(path, file);
      
      console.error(`[VFS] Save failed: ${path}`, error);
      throw error;
    }
  }

  /**
   * Delete a file
   * @param {string} path 
   */
  async deleteFile(path) {
    // Remove from caches
    this.hotCache.delete(path);
    await this.warmCache.delete(this.workspaceId, path);
    this.localVersions.delete(path);
    
    // Delete from server
    await this._deleteFromServer(path);
    
    this.emit('delete', { type: 'delete', path });
  }

  // ==========================================================================
  // Batch Operations (for AI context)
  // ==========================================================================

  /**
   * Get multiple files at once (optimized for AI context building)
   * @param {string[]} paths 
   * @returns {Promise<VFSFile[]>}
   */
  async readFiles(paths) {
    return Promise.all(paths.map(p => this.readFile(p).catch(() => null))).then(files => files.filter(Boolean));
  }

  /**
   * Get all dirty (unsaved) files
   * @returns {VFSFile[]}
   */
  getDirtyFiles() {
    return Array.from(this.hotCache.values()).filter(f => f.syncState === 'dirty');
  }

  /**
   * Get current content for a file (hot cache preferred, server fallback)
   * This is the method the AI analyzer should use
   * @param {string} path 
   * @returns {Promise<{content: string, hash: string}|null>}
   */
  async getCurrentContent(path) {
    // Always prefer hot cache for the most recent content
    const hot = this.hotCache.get(path);
    if (hot) {
      return { content: hot.content, hash: hot.contentHash };
    }
    
    // Fallback to server
    try {
      const file = await this.readFile(path);
      return { content: file.content, hash: file.contentHash };
    } catch {
      return null;
    }
  }

  // ==========================================================================
  // Server Communication
  // ==========================================================================

  async _fetchFromServer(path, signal) {
    const url = `${this.serverUrl}/git/${this.workspaceId}/file?path=${encodeURIComponent(path)}`;
    
    const res = await fetch(url, { signal });
    if (!res.ok) {
      throw new Error(`Failed to fetch file: ${res.status}`);
    }
    
    const data = await res.json();
    return data.content;
  }

  async _fetchServerHash(path, signal) {
    try {
      const url = `${this.serverUrl}/git/${this.workspaceId}/file-hash?path=${encodeURIComponent(path)}`;
      const res = await fetch(url, { signal });
      
      if (!res.ok) return null;
      
      const data = await res.json();
      return data.hash || null;
    } catch {
      return null;
    }
  }

  async _saveToServer(path, content) {
    const formData = new FormData();
    const blob = new Blob([content], { type: 'text/plain' });
    const fileName = path.split('/').pop() || 'file';
    formData.append('file', blob, fileName);
    formData.append('filePath', path);
    
    const url = `/api/workspace/${this.workspaceId}/item/`;
    
    const res = await fetch(url, {
      method: 'POST',
      body: formData,
    });
    
    if (!res.ok) {
      throw new Error(`Failed to save file: ${res.status}`);
    }
  }

  async _deleteFromServer(path) {
    const url = `/api/workspace/${this.workspaceId}/item?path=${encodeURIComponent(path)}`;
    
    const res = await fetch(url, { method: 'DELETE' });
    
    if (!res.ok) {
      throw new Error(`Failed to delete file: ${res.status}`);
    }
  }

  // ==========================================================================
  // Cache Management
  // ==========================================================================

  _addToHotCache(path, file) {
    const existingSize = this.hotCache.get(path)?.content?.length || 0;
    const newSize = file.content?.length || 0;
    
    this.hotCacheSize = this.hotCacheSize - existingSize + newSize;
    this.hotCache.set(path, file);
    
    // Evict if over limit
    if (this.hotCacheSize > MAX_HOT_CACHE_SIZE) {
      this._evictFromHotCache();
    }
  }

  _evictFromHotCache() {
    // Find oldest clean files to evict
    const entries = Array.from(this.hotCache.entries())
      .filter(([_, f]) => f.syncState === 'clean')
      .sort((a, b) => a[1].lastModified - b[1].lastModified);
    
    for (const [path, file] of entries) {
      if (this.hotCacheSize <= MAX_HOT_CACHE_SIZE * 0.8) break;
      
      this.hotCache.delete(path);
      this.hotCacheSize -= file.content?.length || 0;
      console.log(`[VFS] Evicted from hot cache: ${path}`);
    }
  }

  async _validateCachedFiles() {
    // Validate hot cache entries against server
    const validations = [];
    
    for (const [path, file] of this.hotCache) {
      if (file.syncState !== 'clean') continue;
      
      validations.push(
        this._fetchServerHash(path).then(serverHash => {
          if (serverHash && serverHash !== file.contentHash) {
            console.warn(`[VFS] Stale cache detected: ${path}`);
            // Mark as needing refresh
            this.hotCache.set(path, { ...file, syncState: 'conflict' });
            this.emit('conflict', { type: 'conflict', path, file });
          }
        }).catch(() => {})
      );
    }
    
    await Promise.all(validations);
  }

  // ==========================================================================
  // Statistics
  // ==========================================================================

  getStats() {
    return {
      hotCacheEntries: this.hotCache.size,
      hotCacheSize: this.hotCacheSize,
      dirtyFiles: this.getDirtyFiles().length,
      connected: this.connected,
    };
  }
}

// ============================================================================
// Singleton & Factory
// ============================================================================

/** @type {Map<string, VirtualFileSystem>} */
const instances = new Map();

/**
 * Get or create a VFS instance for a workspace
 * @param {string} workspaceId 
 * @param {Object} [options]
 * @returns {VirtualFileSystem}
 */
export function getVFS(workspaceId, options = {}) {
  if (!instances.has(workspaceId)) {
    const vfs = new VirtualFileSystem({ workspaceId, ...options });
    instances.set(workspaceId, vfs);
  }
  return instances.get(workspaceId);
}

/**
 * Destroy a VFS instance
 * @param {string} workspaceId 
 */
export function destroyVFS(workspaceId) {
  const vfs = instances.get(workspaceId);
  if (vfs) {
    vfs.disconnect();
    instances.delete(workspaceId);
  }
}

export default VirtualFileSystem;
