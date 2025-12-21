/**
 * Synthi Extension System - Memory Monitor
 * Heap tracking and memory enforcement
 */

/**
 * Memory limits
 */
const DEFAULT_LIMITS = {
  perExtension: 64 * 1024 * 1024,  // 64MB per extension
  total: 256 * 1024 * 1024         // 256MB total for all extensions
};

export class MemoryMonitor {
  constructor() {
    /** @type {Map<string, number>} Estimated heap usage per extension */
    this.heapEstimates = new Map();
    
    /** @type {Map<string, { limit: number }>} Per-extension limits */
    this.limits = new Map();
    
    /** @type {number} */
    this.totalLimit = DEFAULT_LIMITS.total;
    
    /** @type {number} */
    this.defaultPerExtensionLimit = DEFAULT_LIMITS.perExtension;
    
    /** @type {Function|null} */
    this.onOverflow = null;
    
    /** @type {number|null} */
    this._monitorInterval = null;
    
    /** @type {number} Check interval in ms */
    this.checkInterval = 5000;
  }

  /**
   * Start monitoring
   */
  start() {
    if (this._monitorInterval) return;

    this._monitorInterval = setInterval(() => {
      this._checkMemory();
    }, this.checkInterval);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (this._monitorInterval) {
      clearInterval(this._monitorInterval);
      this._monitorInterval = null;
    }
  }

  /**
   * Register an extension for monitoring
   * @param {string} extensionId
   * @param {number} [limit]
   */
  register(extensionId, limit = this.defaultPerExtensionLimit) {
    this.limits.set(extensionId, { limit });
    this.heapEstimates.set(extensionId, 0);
  }

  /**
   * Unregister an extension
   * @param {string} extensionId
   */
  unregister(extensionId) {
    this.limits.delete(extensionId);
    this.heapEstimates.delete(extensionId);
  }

  /**
   * Update heap estimate for an extension
   * @param {string} extensionId
   * @param {number} bytes
   */
  updateEstimate(extensionId, bytes) {
    this.heapEstimates.set(extensionId, bytes);
    
    // Check limit
    const config = this.limits.get(extensionId);
    if (config && bytes > config.limit) {
      this._handleOverflow(extensionId, bytes, config.limit);
    }
  }

  /**
   * Record memory allocation
   * @param {string} extensionId
   * @param {number} deltaBytes
   */
  recordAllocation(extensionId, deltaBytes) {
    const current = this.heapEstimates.get(extensionId) || 0;
    this.updateEstimate(extensionId, current + deltaBytes);
  }

  /**
   * Get current estimate for an extension
   * @param {string} extensionId
   * @returns {number}
   */
  getEstimate(extensionId) {
    return this.heapEstimates.get(extensionId) || 0;
  }

  /**
   * Get total memory usage
   * @returns {number}
   */
  getTotalUsage() {
    let total = 0;
    for (const bytes of this.heapEstimates.values()) {
      total += bytes;
    }
    return total;
  }

  /**
   * Check memory and handle violations
   */
  _checkMemory() {
    // Check total limit
    const total = this.getTotalUsage();
    if (total > this.totalLimit) {
      console.warn(`[MemoryMonitor] Total memory ${this._formatBytes(total)} exceeds limit ${this._formatBytes(this.totalLimit)}`);
      
      // Find largest extension
      let largest = null;
      let largestSize = 0;
      
      for (const [id, bytes] of this.heapEstimates) {
        if (bytes > largestSize) {
          largest = id;
          largestSize = bytes;
        }
      }
      
      if (largest) {
        this._handleOverflow(largest, largestSize, this.limits.get(largest)?.limit || this.defaultPerExtensionLimit);
      }
    }

    // Check per-extension limits
    for (const [extensionId, bytes] of this.heapEstimates) {
      const config = this.limits.get(extensionId);
      if (config && bytes > config.limit) {
        this._handleOverflow(extensionId, bytes, config.limit);
      }
    }

    // Try to get actual memory info if available
    this._tryUpdateFromPerformance();
  }

  /**
   * Try to update estimates from performance API
   */
  _tryUpdateFromPerformance() {
    // Note: performance.memory is Chrome-only and not available in workers
    // This is a placeholder for when we have better memory visibility
    if (typeof performance !== 'undefined' && performance.memory) {
      const used = performance.memory.usedJSHeapSize;
      const total = performance.memory.totalJSHeapSize;
      
      console.debug(`[MemoryMonitor] JS Heap: ${this._formatBytes(used)} / ${this._formatBytes(total)}`);
    }
  }

  /**
   * Handle memory overflow
   * @param {string} extensionId
   * @param {number} current
   * @param {number} limit
   */
  _handleOverflow(extensionId, current, limit) {
    console.error(
      `[MemoryMonitor] Extension ${extensionId} exceeded memory limit: ` +
      `${this._formatBytes(current)} > ${this._formatBytes(limit)}`
    );

    if (this.onOverflow) {
      this.onOverflow({
        extensionId,
        current,
        limit,
        message: `Memory limit exceeded: ${this._formatBytes(current)} > ${this._formatBytes(limit)}`
      });
    }
  }

  /**
   * Format bytes for display
   * @param {number} bytes
   * @returns {string}
   */
  _formatBytes(bytes) {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  }

  /**
   * Get memory report
   * @returns {object}
   */
  getReport() {
    const extensions = {};
    
    for (const [id, bytes] of this.heapEstimates) {
      const config = this.limits.get(id);
      extensions[id] = {
        used: bytes,
        usedFormatted: this._formatBytes(bytes),
        limit: config?.limit || this.defaultPerExtensionLimit,
        limitFormatted: this._formatBytes(config?.limit || this.defaultPerExtensionLimit),
        percentage: ((bytes / (config?.limit || this.defaultPerExtensionLimit)) * 100).toFixed(1)
      };
    }

    const total = this.getTotalUsage();

    return {
      total: {
        used: total,
        usedFormatted: this._formatBytes(total),
        limit: this.totalLimit,
        limitFormatted: this._formatBytes(this.totalLimit),
        percentage: ((total / this.totalLimit) * 100).toFixed(1)
      },
      extensions
    };
  }
}

// Singleton
let instance = null;

/**
 * Get MemoryMonitor singleton
 * @returns {MemoryMonitor}
 */
export function getMemoryMonitor() {
  if (!instance) {
    instance = new MemoryMonitor();
  }
  return instance;
}
