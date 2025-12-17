/**
 * Synthi Extension System - Activation Benchmark
 * Tracks extension activation times
 * Target: < 300ms median activation time
 */

export class ActivationBenchmark {
  constructor() {
    /** @type {Map<string, number[]>} Extension ID -> activation times */
    this.activationTimes = new Map();
    
    /** @type {Map<string, number>} Extension ID -> timestamp */
    this._pendingActivations = new Map();
    
    /** @type {number} Target median activation time (ms) */
    this.targetMedian = 300;
    
    /** @type {number} Soft limit for individual activation */
    this.softLimit = 200;
    
    /** @type {number} Hard limit for individual activation */
    this.hardLimit = 1000;
    
    /** @type {Function[]} */
    this._listeners = [];
  }

  /**
   * Mark start of activation
   * @param {string} extensionId
   */
  startActivation(extensionId) {
    this._pendingActivations.set(extensionId, performance.now());
  }

  /**
   * Mark end of activation
   * @param {string} extensionId
   * @param {boolean} [success=true]
   */
  endActivation(extensionId, success = true) {
    const startTime = this._pendingActivations.get(extensionId);
    if (!startTime) return;
    
    this._pendingActivations.delete(extensionId);
    
    const duration = performance.now() - startTime;
    
    // Record time
    let times = this.activationTimes.get(extensionId);
    if (!times) {
      times = [];
      this.activationTimes.set(extensionId, times);
    }
    times.push(duration);
    
    // Notify
    this._notifyActivation(extensionId, duration, success);
    
    // Log warnings
    if (duration > this.hardLimit) {
      console.error(`[ActivationBenchmark] Extension ${extensionId} activation took ${duration.toFixed(1)}ms (HARD LIMIT EXCEEDED)`);
    } else if (duration > this.softLimit) {
      console.warn(`[ActivationBenchmark] Extension ${extensionId} activation took ${duration.toFixed(1)}ms (soft limit exceeded)`);
    }
    
    return duration;
  }

  /**
   * Record activation time directly
   * @param {string} extensionId
   * @param {number} duration
   */
  recordActivation(extensionId, duration) {
    let times = this.activationTimes.get(extensionId);
    if (!times) {
      times = [];
      this.activationTimes.set(extensionId, times);
    }
    times.push(duration);
    
    this._notifyActivation(extensionId, duration, true);
  }

  /**
   * Notify listeners
   * @param {string} extensionId
   * @param {number} duration
   * @param {boolean} success
   */
  _notifyActivation(extensionId, duration, success) {
    for (const listener of this._listeners) {
      try {
        listener({
          extensionId,
          duration,
          success,
          exceeded: {
            soft: duration > this.softLimit,
            hard: duration > this.hardLimit
          }
        });
      } catch (err) {
        console.error('[ActivationBenchmark] Listener error:', err);
      }
    }
  }

  /**
   * Subscribe to activation events
   * @param {Function} listener
   * @returns {Function} Unsubscribe function
   */
  subscribe(listener) {
    this._listeners.push(listener);
    return () => {
      const idx = this._listeners.indexOf(listener);
      if (idx !== -1) this._listeners.splice(idx, 1);
    };
  }

  /**
   * Get stats for a specific extension
   * @param {string} extensionId
   * @returns {Object|null}
   */
  getExtensionStats(extensionId) {
    const times = this.activationTimes.get(extensionId);
    if (!times || times.length === 0) return null;
    
    return this._calculateStats(times);
  }

  /**
   * Get overall stats
   * @returns {Object}
   */
  getOverallStats() {
    const allTimes = [];
    
    for (const times of this.activationTimes.values()) {
      allTimes.push(...times);
    }
    
    if (allTimes.length === 0) {
      return {
        count: 0,
        extensionCount: 0,
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        p95: 0,
        withinSoftLimit: 100,
        withinHardLimit: 100,
        withinTarget: true
      };
    }

    const stats = this._calculateStats(allTimes);
    stats.extensionCount = this.activationTimes.size;
    stats.withinTarget = stats.median <= this.targetMedian;
    
    return stats;
  }

  /**
   * Calculate stats from array of times
   * @param {number[]} times
   * @returns {Object}
   */
  _calculateStats(times) {
    const sorted = [...times].sort((a, b) => a - b);
    const count = sorted.length;
    
    const min = sorted[0];
    const max = sorted[count - 1];
    const mean = sorted.reduce((a, b) => a + b, 0) / count;
    const median = this._percentile(sorted, 50);
    const p95 = this._percentile(sorted, 95);
    
    const withinSoftLimit = (sorted.filter(t => t <= this.softLimit).length / count) * 100;
    const withinHardLimit = (sorted.filter(t => t <= this.hardLimit).length / count) * 100;

    return {
      count,
      min: Number(min.toFixed(2)),
      max: Number(max.toFixed(2)),
      mean: Number(mean.toFixed(2)),
      median: Number(median.toFixed(2)),
      p95: Number(p95.toFixed(2)),
      withinSoftLimit: Number(withinSoftLimit.toFixed(1)),
      withinHardLimit: Number(withinHardLimit.toFixed(1))
    };
  }

  /**
   * Calculate percentile
   * @param {number[]} sorted
   * @param {number} p
   * @returns {number}
   */
  _percentile(sorted, p) {
    const idx = Math.ceil((p / 100) * sorted.length) - 1;
    return sorted[Math.max(0, idx)];
  }

  /**
   * Get breakdown by extension
   * @returns {Object}
   */
  getBreakdown() {
    const breakdown = {};
    
    for (const [extensionId, times] of this.activationTimes) {
      const stats = this._calculateStats(times);
      breakdown[extensionId] = {
        activations: times.length,
        lastActivation: times[times.length - 1],
        ...stats
      };
    }
    
    return breakdown;
  }

  /**
   * Get slow extensions (median > soft limit)
   * @returns {string[]}
   */
  getSlowExtensions() {
    const slow = [];
    
    for (const [extensionId, times] of this.activationTimes) {
      if (times.length > 0) {
        const stats = this._calculateStats(times);
        if (stats.median > this.softLimit) {
          slow.push(extensionId);
        }
      }
    }
    
    return slow;
  }

  /**
   * Clear all data
   */
  clear() {
    this.activationTimes.clear();
    this._pendingActivations.clear();
  }

  /**
   * Clear data for specific extension
   * @param {string} extensionId
   */
  clearExtension(extensionId) {
    this.activationTimes.delete(extensionId);
    this._pendingActivations.delete(extensionId);
  }
}

// Singleton
let instance = null;

/**
 * Get ActivationBenchmark singleton
 * @returns {ActivationBenchmark}
 */
export function getActivationBenchmark() {
  if (!instance) {
    instance = new ActivationBenchmark();
  }
  return instance;
}
