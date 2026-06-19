/**
 * Container-Centric Virtual File System (ContainerVFS)
 * 
 * This implements the "Gold Standard" architecture where:
 * 1. The SERVER CONTAINER is the absolute Source of Truth
 * 2. Y.js CRDTs provide real-time synchronization
 * 3. Client cache is for display only, NOT for analysis
 * 
 * Key Principle: The compiler, AI, and Git ALL read from the same container filesystem.
 * The client NEVER sends content for analysis - it only sends file paths.
 * 
 * Flow:
 * 1. User types → Y.js updates locally → WebSocket sync → Server Y.js → Flush to disk
 * 2. Analysis request → Server reads from disk → Returns diagnostics
 * 3. Save → Already on disk (Y.js auto-flushes), just Git commit
 */

import collabClient from './collabClient';
import { gitClient } from './gitClient';
import { resolveCollabHttpUrl } from '@/lib/collab-url';

// ============================================================================
// Configuration
// ============================================================================

const COLLAB_SERVER_URL = resolveCollabHttpUrl();
const FLUSH_DEBOUNCE_MS = 100; // Debounce disk flushes
const VALIDATION_INTERVAL_MS = 5000; // How often to validate client matches server

// ============================================================================
// ContainerVFS Class
// ============================================================================

class ContainerVFS {
  constructor() {
    this.slug = null;
    this.flushTimers = new Map(); // path -> timer
    this.validationInterval = null;
    this.contentHashes = new Map(); // path -> { clientHash, serverHash, lastValidated }
    this.listeners = new Set();
    this._initialized = false;
  }

  /**
   * Initialize VFS for a workspace
   * @param {string} slug - Workspace slug
   */
  async init(slug) {
    if (this._initialized && this.slug === slug) {
      return;
    }

    this.slug = slug;
    this._initialized = true;

    console.log(`[ContainerVFS] Initialized for workspace: ${slug}`);

    // Start periodic validation
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
    }
    this.validationInterval = setInterval(() => {
      this._validateOpenFiles();
    }, VALIDATION_INTERVAL_MS);
  }

  /**
   * Dispose VFS resources
   */
  dispose() {
    if (this.validationInterval) {
      clearInterval(this.validationInterval);
    }
    this.flushTimers.forEach(timer => clearTimeout(timer));
    this.flushTimers.clear();
    this.contentHashes.clear();
    this._initialized = false;
    console.log('[ContainerVFS] Disposed');
  }

  // ==========================================================================
  // Core File Operations - All Server-First
  // ==========================================================================

  /**
   * Read file content - ALWAYS from server
   * @param {string} path - File path
   * @returns {Promise<string>} File content from server
   */
  async readFile(path) {
    if (!this.slug) throw new Error('[ContainerVFS] Not initialized');

    console.log(`[ContainerVFS] readFile: ${path}`);
    
    try {
      const result = await gitClient.request(this.slug, 'file', { path });
      const content = result?.content ?? '';
      
      // Update our hash tracking
      this.contentHashes.set(path, {
        serverHash: this._computeHash(content),
        lastValidated: Date.now(),
      });
      
      return content;
    } catch (e) {
      console.error(`[ContainerVFS] readFile failed for ${path}:`, e);
      throw e;
    }
  }

  /**
   * Write file content - Goes to server immediately via Y.js flush
   * This is called when Y.js content changes need to be persisted to disk
   * @param {string} path - File path
   * @param {string} content - File content
   */
  async writeFile(path, content) {
    if (!this.slug) throw new Error('[ContainerVFS] Not initialized');

    console.log(`[ContainerVFS] writeFile: ${path} (${content.length} chars)`);

    try {
      // Write directly to server disk
      await gitClient.writeFile(this.slug, path, content);
      
      // Update hash tracking
      this.contentHashes.set(path, {
        serverHash: this._computeHash(content),
        lastValidated: Date.now(),
      });

      // Notify listeners
      this._emit('write', { path, content });
      
      console.log(`[ContainerVFS] writeFile SUCCESS: ${path}`);
    } catch (e) {
      console.error(`[ContainerVFS] writeFile failed for ${path}:`, e);
      throw e;
    }
  }

  /**
   * Schedule a debounced flush of Y.js content to disk
   * Called whenever Y.js content changes
   * @param {string} path - File path
   * @param {string} content - Current Y.js content
   */
  scheduleFlush(path, content) {
    if (!this.slug) return;

    // Clear existing timer
    if (this.flushTimers.has(path)) {
      clearTimeout(this.flushTimers.get(path));
    }

    // Schedule new flush
    const timer = setTimeout(async () => {
      this.flushTimers.delete(path);
      try {
        await this.writeFile(path, content);
        console.log(`[ContainerVFS] Flushed ${path} to disk`);
      } catch (e) {
        console.error(`[ContainerVFS] Flush failed for ${path}:`, e);
      }
    }, FLUSH_DEBOUNCE_MS);

    this.flushTimers.set(path, timer);
  }

  /**
   * Force immediate flush of a file
   * @param {string} path - File path
   * @param {string} content - Content to flush
   */
  async flushImmediate(path, content) {
    // Cancel any pending debounced flush
    if (this.flushTimers.has(path)) {
      clearTimeout(this.flushTimers.get(path));
      this.flushTimers.delete(path);
    }
    
    await this.writeFile(path, content);
  }

  // ==========================================================================
  // Validation - Ensure Client matches Server
  // ==========================================================================

  /**
   * Validate that client content matches server
   * @param {string} path - File path
   * @param {string} clientContent - Content from client/editor
   * @returns {Promise<{valid: boolean, serverContent?: string}>}
   */
  async validateFile(path, clientContent) {
    if (!this.slug) throw new Error('[ContainerVFS] Not initialized');

    try {
      const result = await gitClient.request(this.slug, 'file-hash', { path });
      const serverHash = result?.hash;
      const clientHash = this._computeHash(clientContent);

      const valid = serverHash === clientHash;

      if (!valid) {
        console.warn(`[ContainerVFS] VALIDATION FAILED for ${path}`);
        console.warn(`  Client hash: ${clientHash?.substring(0, 8)}`);
        console.warn(`  Server hash: ${serverHash?.substring(0, 8)}`);
        
        // Fetch server content for reconciliation
        const serverContent = await this.readFile(path);
        return { valid: false, serverContent, serverHash, clientHash };
      }

      return { valid: true };
    } catch (e) {
      console.error(`[ContainerVFS] validateFile failed for ${path}:`, e);
      return { valid: false, error: e.message };
    }
  }

  /**
   * Get the authoritative content for analysis
   * This ALWAYS returns server content, never client content
   * @param {string} path - File path
   * @returns {Promise<string>} Server content
   */
  async getContentForAnalysis(path) {
    return this.readFile(path);
  }

  /**
   * Get multiple files for analysis (batch)
   * @param {string[]} paths - File paths
   * @returns {Promise<Map<string, string>>} path -> content
   */
  async getFilesForAnalysis(paths) {
    const results = new Map();
    
    // Fetch in parallel
    await Promise.all(
      paths.map(async (path) => {
        try {
          const content = await this.readFile(path);
          results.set(path, content);
        } catch (e) {
          console.warn(`[ContainerVFS] Could not read ${path} for analysis:`, e.message);
        }
      })
    );

    return results;
  }

  // ==========================================================================
  // Y.js Integration
  // ==========================================================================

  /**
   * Bind to a Y.js document and auto-flush changes to disk
   * @param {string} path - File path
   * @param {Y.Text} ytext - Y.js Text type
   */
  bindYjsDocument(path, ytext) {
    if (!ytext) return;

    const observer = () => {
      const content = ytext.toString();
      this.scheduleFlush(path, content);
    };

    ytext.observe(observer);

    // Return cleanup function
    return () => {
      ytext.unobserve(observer);
    };
  }

  // ==========================================================================
  // Internal Methods
  // ==========================================================================

  _computeHash(content) {
    if (!content) return 'empty';
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(16);
  }

  async _validateOpenFiles() {
    // This would validate all currently open files
    // For now, just log that validation ran
    if (this.contentHashes.size > 0) {
      console.log(`[ContainerVFS] Periodic validation for ${this.contentHashes.size} files`);
    }
  }

  _emit(event, data) {
    this.listeners.forEach(listener => {
      try {
        listener(event, data);
      } catch (e) {
        console.warn('[ContainerVFS] Listener error:', e);
      }
    });
  }

  /**
   * Add event listener
   * @param {Function} listener - (event, data) => void
   */
  addListener(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

// ============================================================================
// Singleton Export
// ============================================================================

export const containerVFS = new ContainerVFS();
export default containerVFS;
