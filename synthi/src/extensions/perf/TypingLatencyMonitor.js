/**
 * Synthi Extension System - Typing Latency Monitor
 * Tracks keypress-to-render latency
 * Target: < 10ms typing latency
 */

export class TypingLatencyMonitor {
  constructor() {
    /** @type {number[]} Recent latency samples */
    this.samples = [];
    
    /** @type {number} Max samples to keep */
    this.maxSamples = 1000;
    
    /** @type {number} Target latency in ms */
    this.targetLatency = 10;
    
    /** @type {number} Warning threshold */
    this.warningThreshold = 16; // ~60fps
    
    /** @type {number} Critical threshold */
    this.criticalThreshold = 50;
    
    /** @type {number|null} Current keypress timestamp */
    this._keypressTime = null;
    
    /** @type {boolean} */
    this._isMonitoring = false;
    
    /** @type {Function[]} */
    this._listeners = [];
    
    /** @type {Object} Statistics cache */
    this._statsCache = null;
    
    /** @type {number} Stats cache duration */
    this._statsCacheDuration = 100;
    
    /** @type {number} Last stats calc time */
    this._lastStatsCalc = 0;
  }

  /**
   * Start monitoring
   * @param {HTMLElement} [element] Optional element to attach to
   */
  start(element) {
    if (this._isMonitoring) return;
    this._isMonitoring = true;
    
    // In a real implementation, this would hook into Monaco's input handling
    // For now, we provide manual instrumentation methods
    console.log('[TypingLatencyMonitor] Started');
  }

  /**
   * Stop monitoring
   */
  stop() {
    this._isMonitoring = false;
    console.log('[TypingLatencyMonitor] Stopped');
  }

  /**
   * Record keypress start (call when key is pressed)
   */
  markKeypressStart() {
    if (!this._isMonitoring) return;
    this._keypressTime = performance.now();
  }

  /**
   * Record keypress end (call when change is rendered)
   */
  markKeypressEnd() {
    if (!this._isMonitoring || this._keypressTime === null) return;
    
    const latency = performance.now() - this._keypressTime;
    this._keypressTime = null;
    
    this._recordSample(latency);
  }

  /**
   * Record a complete latency measurement
   * @param {number} latency
   */
  recordLatency(latency) {
    if (!this._isMonitoring) return;
    this._recordSample(latency);
  }

  /**
   * Internal sample recording
   * @param {number} latency
   */
  _recordSample(latency) {
    this.samples.push(latency);
    
    // Trim old samples
    if (this.samples.length > this.maxSamples) {
      this.samples = this.samples.slice(-this.maxSamples);
    }
    
    // Invalidate cache
    this._statsCache = null;
    
    // Check thresholds
    if (latency > this.criticalThreshold) {
      this._notify('critical', latency);
    } else if (latency > this.warningThreshold) {
      this._notify('warning', latency);
    }
  }

  /**
   * Notify listeners
   * @param {string} level
   * @param {number} latency
   */
  _notify(level, latency) {
    for (const listener of this._listeners) {
      try {
        listener({ level, latency, stats: this.getStats() });
      } catch (err) {
        console.error('[TypingLatencyMonitor] Listener error:', err);
      }
    }
  }

  /**
   * Subscribe to latency events
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
   * Get statistics
   * @returns {Object}
   */
  getStats() {
    const now = performance.now();
    
    // Return cached if recent
    if (this._statsCache && now - this._lastStatsCalc < this._statsCacheDuration) {
      return this._statsCache;
    }

    if (this.samples.length === 0) {
      return {
        count: 0,
        min: 0,
        max: 0,
        mean: 0,
        median: 0,
        p95: 0,
        p99: 0,
        withinTarget: 100,
        status: 'ok'
      };
    }

    const sorted = [...this.samples].sort((a, b) => a - b);
    const count = sorted.length;
    
    const min = sorted[0];
    const max = sorted[count - 1];
    const mean = sorted.reduce((a, b) => a + b, 0) / count;
    const median = this._percentile(sorted, 50);
    const p95 = this._percentile(sorted, 95);
    const p99 = this._percentile(sorted, 99);
    
    const withinTarget = (sorted.filter(s => s <= this.targetLatency).length / count) * 100;
    
    let status = 'ok';
    if (p95 > this.criticalThreshold) status = 'critical';
    else if (p95 > this.warningThreshold) status = 'warning';

    this._statsCache = {
      count,
      min: Number(min.toFixed(2)),
      max: Number(max.toFixed(2)),
      mean: Number(mean.toFixed(2)),
      median: Number(median.toFixed(2)),
      p95: Number(p95.toFixed(2)),
      p99: Number(p99.toFixed(2)),
      withinTarget: Number(withinTarget.toFixed(1)),
      status
    };
    
    this._lastStatsCalc = now;
    return this._statsCache;
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
   * Check if latency is within target
   * @returns {boolean}
   */
  isWithinTarget() {
    const stats = this.getStats();
    return stats.median <= this.targetLatency;
  }

  /**
   * Clear all samples
   */
  clear() {
    this.samples = [];
    this._statsCache = null;
  }

  /**
   * Get recent samples
   * @param {number} [count]
   * @returns {number[]}
   */
  getRecentSamples(count = 100) {
    return this.samples.slice(-count);
  }
}

// Singleton
let instance = null;

/**
 * Get TypingLatencyMonitor singleton
 * @returns {TypingLatencyMonitor}
 */
export function getTypingLatencyMonitor() {
  if (!instance) {
    instance = new TypingLatencyMonitor();
  }
  return instance;
}
