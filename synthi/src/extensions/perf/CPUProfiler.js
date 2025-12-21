/**
 * Synthi Extension System - CPU Profiler
 * Tracks CPU time per extension
 */

export class CPUProfiler {
  constructor() {
    /** @type {Map<string, object>} Extension ID -> profile data */
    this.profiles = new Map();
    
    /** @type {Map<string, number>} Ongoing operation start times */
    this._pending = new Map();
    
    /** @type {number} Aggregation window (ms) */
    this.windowSize = 60000; // 1 minute
    
    /** @type {number} Sample retention period */
    this.retentionPeriod = 300000; // 5 minutes
  }

  /**
   * Register an extension
   * @param {string} extensionId
   */
  register(extensionId) {
    this.profiles.set(extensionId, {
      totalTime: 0,
      operationCount: 0,
      samples: [],
      byOperation: new Map()
    });
  }

  /**
   * Unregister an extension
   * @param {string} extensionId
   */
  unregister(extensionId) {
    this.profiles.delete(extensionId);
    
    // Clean up pending
    for (const [key] of this._pending) {
      if (key.startsWith(extensionId + ':')) {
        this._pending.delete(key);
      }
    }
  }

  /**
   * Start timing an operation
   * @param {string} extensionId
   * @param {string} [operation='default']
   * @returns {string} Operation key for endOperation
   */
  startOperation(extensionId, operation = 'default') {
    const key = `${extensionId}:${operation}:${Date.now()}`;
    this._pending.set(key, performance.now());
    return key;
  }

  /**
   * End timing an operation
   * @param {string} operationKey
   * @returns {number} Duration in ms
   */
  endOperation(operationKey) {
    const startTime = this._pending.get(operationKey);
    if (!startTime) return 0;
    
    this._pending.delete(operationKey);
    
    const duration = performance.now() - startTime;
    const [extensionId, operation] = operationKey.split(':');
    
    this._recordDuration(extensionId, operation, duration);
    
    return duration;
  }

  /**
   * Record a duration directly
   * @param {string} extensionId
   * @param {string} operation
   * @param {number} duration
   */
  recordDuration(extensionId, operation, duration) {
    this._recordDuration(extensionId, operation, duration);
  }

  /**
   * Internal duration recording
   * @param {string} extensionId
   * @param {string} operation
   * @param {number} duration
   */
  _recordDuration(extensionId, operation, duration) {
    let profile = this.profiles.get(extensionId);
    
    if (!profile) {
      this.register(extensionId);
      profile = this.profiles.get(extensionId);
    }

    const now = Date.now();
    
    // Update totals
    profile.totalTime += duration;
    profile.operationCount++;
    
    // Add sample
    profile.samples.push({
      timestamp: now,
      operation,
      duration
    });
    
    // Update by-operation stats
    let opStats = profile.byOperation.get(operation);
    if (!opStats) {
      opStats = { totalTime: 0, count: 0 };
      profile.byOperation.set(operation, opStats);
    }
    opStats.totalTime += duration;
    opStats.count++;
    
    // Cleanup old samples
    this._cleanup(extensionId);
  }

  /**
   * Cleanup old samples
   * @param {string} extensionId
   */
  _cleanup(extensionId) {
    const profile = this.profiles.get(extensionId);
    if (!profile) return;
    
    const cutoff = Date.now() - this.retentionPeriod;
    profile.samples = profile.samples.filter(s => s.timestamp > cutoff);
  }

  /**
   * Get stats for an extension
   * @param {string} extensionId
   * @returns {Object|null}
   */
  getStats(extensionId) {
    const profile = this.profiles.get(extensionId);
    if (!profile) return null;
    
    this._cleanup(extensionId);
    
    const now = Date.now();
    const windowStart = now - this.windowSize;
    
    // Calculate window stats
    const windowSamples = profile.samples.filter(s => s.timestamp > windowStart);
    const windowTime = windowSamples.reduce((sum, s) => sum + s.duration, 0);
    
    // CPU percentage (time spent / window size)
    const cpuPercentage = (windowTime / this.windowSize) * 100;
    
    // By-operation breakdown
    const operations = {};
    for (const [op, stats] of profile.byOperation) {
      operations[op] = {
        totalTime: Number(stats.totalTime.toFixed(2)),
        count: stats.count,
        avgTime: Number((stats.totalTime / stats.count).toFixed(2))
      };
    }

    return {
      totalTime: Number(profile.totalTime.toFixed(2)),
      operationCount: profile.operationCount,
      windowTime: Number(windowTime.toFixed(2)),
      windowOperations: windowSamples.length,
      cpuPercentage: Number(cpuPercentage.toFixed(2)),
      operations
    };
  }

  /**
   * Get overall stats
   * @returns {Object}
   */
  getOverallStats() {
    const stats = {
      totalTime: 0,
      totalOperations: 0,
      extensionCount: this.profiles.size,
      extensions: {}
    };

    for (const [extensionId, profile] of this.profiles) {
      const extStats = this.getStats(extensionId);
      if (extStats) {
        stats.totalTime += extStats.totalTime;
        stats.totalOperations += extStats.operationCount;
        stats.extensions[extensionId] = extStats;
      }
    }

    stats.totalTime = Number(stats.totalTime.toFixed(2));
    return stats;
  }

  /**
   * Get hottest extensions (by CPU usage)
   * @param {number} [limit=5]
   * @returns {Array<{extensionId: string, cpuPercentage: number}>}
   */
  getHotExtensions(limit = 5) {
    const rankings = [];
    
    for (const [extensionId] of this.profiles) {
      const stats = this.getStats(extensionId);
      if (stats) {
        rankings.push({
          extensionId,
          cpuPercentage: stats.cpuPercentage
        });
      }
    }
    
    rankings.sort((a, b) => b.cpuPercentage - a.cpuPercentage);
    return rankings.slice(0, limit);
  }

  /**
   * Get recent operations
   * @param {string} extensionId
   * @param {number} [limit=100]
   * @returns {Array}
   */
  getRecentOperations(extensionId, limit = 100) {
    const profile = this.profiles.get(extensionId);
    if (!profile) return [];
    
    return profile.samples.slice(-limit);
  }

  /**
   * Clear all data
   */
  clear() {
    this.profiles.clear();
    this._pending.clear();
  }

  /**
   * Clear data for specific extension
   * @param {string} extensionId
   */
  clearExtension(extensionId) {
    this.profiles.delete(extensionId);
  }
}

// Singleton
let instance = null;

/**
 * Get CPUProfiler singleton
 * @returns {CPUProfiler}
 */
export function getCPUProfiler() {
  if (!instance) {
    instance = new CPUProfiler();
  }
  return instance;
}
