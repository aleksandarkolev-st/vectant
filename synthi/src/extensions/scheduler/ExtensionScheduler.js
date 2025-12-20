/**
 * Synthi Extension System - Extension Scheduler
 * CPU budget enforcement and extension throttling
 */

/**
 * @typedef {Object} ExtensionBudget
 * @property {number} cpuTimePerSecond - ms allowed per 1s (default: 50)
 * @property {number} messageRateLimit - messages/sec (default: 100)
 * @property {number} violationsBeforeSuspend - count (default: 3)
 */

/**
 * @typedef {Object} ExtensionMetrics
 * @property {number} cpuTime - Total CPU time used (ms)
 * @property {number} cpuTimeThisSecond - CPU time in current window
 * @property {number} windowStart - Start of current measurement window
 * @property {number} messageCount - Messages sent
 * @property {number} violations - Violation count
 * @property {boolean} throttled - Currently throttled
 * @property {boolean} suspended - Currently suspended
 */

const DEFAULT_BUDGET = {
  cpuTimePerSecond: 50,
  messageRateLimit: 100,
  violationsBeforeSuspend: 3
};

export class ExtensionScheduler {
  constructor() {
    /** @type {Map<string, ExtensionMetrics>} */
    this.metrics = new Map();
    
    /** @type {Map<string, ExtensionBudget>} */
    this.budgets = new Map();
    
    /** @type {Set<string>} */
    this.suspended = new Set();
    
    /** @type {Set<string>} */
    this.throttled = new Set();
    
    /** @type {number} */
    this.windowDuration = 1000; // 1 second window
    
    /** @type {Function|null} */
    this.onViolation = null;
    
    /** @type {Function|null} */
    this.onSuspend = null;
    
    /** @type {number|null} */
    this._cleanupInterval = null;
  }

  /**
   * Start the scheduler
   */
  start() {
    // Periodic cleanup of old data
    this._cleanupInterval = setInterval(() => {
      this._cleanup();
    }, 5000);
  }

  /**
   * Stop the scheduler
   */
  stop() {
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
  }

  /**
   * Register an extension for scheduling
   * @param {string} extensionId
   * @param {Partial<ExtensionBudget>} [budget]
   */
  register(extensionId, budget = {}) {
    this.budgets.set(extensionId, { ...DEFAULT_BUDGET, ...budget });
    
    this.metrics.set(extensionId, {
      cpuTime: 0,
      cpuTimeThisSecond: 0,
      windowStart: performance.now(),
      messageCount: 0,
      violations: 0,
      throttled: false,
      suspended: false
    });
  }

  /**
   * Unregister an extension
   * @param {string} extensionId
   */
  unregister(extensionId) {
    this.metrics.delete(extensionId);
    this.budgets.delete(extensionId);
    this.suspended.delete(extensionId);
    this.throttled.delete(extensionId);
  }

  /**
   * Record CPU time for an extension
   * @param {string} extensionId
   * @param {number} ms
   * @returns {boolean} True if within budget
   */
  recordCpuTime(extensionId, ms) {
    const metrics = this.metrics.get(extensionId);
    const budget = this.budgets.get(extensionId);
    
    if (!metrics || !budget) return true;
    
    // Check if we need to reset the window
    const now = performance.now();
    if (now - metrics.windowStart >= this.windowDuration) {
      metrics.cpuTimeThisSecond = 0;
      metrics.windowStart = now;
    }
    
    metrics.cpuTime += ms;
    metrics.cpuTimeThisSecond += ms;
    
    // Check budget
    if (metrics.cpuTimeThisSecond > budget.cpuTimePerSecond) {
      this._recordViolation(extensionId, 'cpu', metrics.cpuTimeThisSecond, budget.cpuTimePerSecond);
      return false;
    }
    
    return true;
  }

  /**
   * Check if extension can send a message
   * @param {string} extensionId
   * @returns {boolean}
   */
  canSendMessage(extensionId) {
    if (this.suspended.has(extensionId)) return false;
    if (this.throttled.has(extensionId)) return false;
    
    const metrics = this.metrics.get(extensionId);
    const budget = this.budgets.get(extensionId);
    
    if (!metrics || !budget) return true;
    
    // Reset window if needed
    const now = performance.now();
    if (now - metrics.windowStart >= this.windowDuration) {
      metrics.messageCount = 0;
      metrics.windowStart = now;
    }
    
    if (metrics.messageCount >= budget.messageRateLimit) {
      this._recordViolation(extensionId, 'message-rate', metrics.messageCount, budget.messageRateLimit);
      return false;
    }
    
    metrics.messageCount++;
    return true;
  }

  /**
   * Record a violation
   * @param {string} extensionId
   * @param {string} type
   * @param {number} value
   * @param {number} limit
   */
  _recordViolation(extensionId, type, value, limit) {
    const metrics = this.metrics.get(extensionId);
    const budget = this.budgets.get(extensionId);
    
    if (!metrics || !budget) return;
    
    metrics.violations++;
    
    // Notify
    if (this.onViolation) {
      this.onViolation({
        extensionId,
        type,
        value,
        limit,
        violationCount: metrics.violations
      });
    }
    
    // Throttle after first violation
    if (metrics.violations >= 1 && !metrics.throttled) {
      this._throttle(extensionId);
    }
    
    // Suspend after threshold
    if (metrics.violations >= budget.violationsBeforeSuspend) {
      this._suspend(extensionId);
    }
  }

  /**
   * Throttle an extension
   * @param {string} extensionId
   */
  _throttle(extensionId) {
    const metrics = this.metrics.get(extensionId);
    if (!metrics) return;
    
    this.throttled.add(extensionId);
    metrics.throttled = true;
    
    console.warn(`[Scheduler] Extension ${extensionId} throttled`);
    
    // Auto-unthrottle after 1 second
    setTimeout(() => {
      this.throttled.delete(extensionId);
      if (metrics) metrics.throttled = false;
    }, 1000);
  }

  /**
   * Suspend an extension
   * @param {string} extensionId
   */
  _suspend(extensionId) {
    const metrics = this.metrics.get(extensionId);
    if (!metrics) return;
    
    this.suspended.add(extensionId);
    metrics.suspended = true;
    
    console.error(`[Scheduler] Extension ${extensionId} suspended due to violations`);
    
    if (this.onSuspend) {
      this.onSuspend(extensionId);
    }
  }

  /**
   * Resume a suspended extension
   * @param {string} extensionId
   */
  resume(extensionId) {
    const metrics = this.metrics.get(extensionId);
    
    this.suspended.delete(extensionId);
    this.throttled.delete(extensionId);
    
    if (metrics) {
      metrics.suspended = false;
      metrics.throttled = false;
      metrics.violations = 0;
    }
    
    console.log(`[Scheduler] Extension ${extensionId} resumed`);
  }

  /**
   * Check if extension is suspended
   * @param {string} extensionId
   * @returns {boolean}
   */
  isSuspended(extensionId) {
    return this.suspended.has(extensionId);
  }

  /**
   * Check if extension is throttled
   * @param {string} extensionId
   * @returns {boolean}
   */
  isThrottled(extensionId) {
    return this.throttled.has(extensionId);
  }

  /**
   * Get metrics for an extension
   * @param {string} extensionId
   * @returns {ExtensionMetrics|undefined}
   */
  getMetrics(extensionId) {
    return this.metrics.get(extensionId);
  }

  /**
   * Get all metrics
   * @returns {Object<string, ExtensionMetrics>}
   */
  getAllMetrics() {
    const result = {};
    for (const [id, metrics] of this.metrics) {
      result[id] = { ...metrics };
    }
    return result;
  }

  /**
   * Periodic cleanup
   */
  _cleanup() {
    const now = performance.now();
    
    for (const [extensionId, metrics] of this.metrics) {
      // Reset window if stale
      if (now - metrics.windowStart >= this.windowDuration * 2) {
        metrics.cpuTimeThisSecond = 0;
        metrics.messageCount = 0;
        metrics.windowStart = now;
      }
    }
  }
}

// Singleton
let instance = null;

/**
 * Get ExtensionScheduler singleton
 * @returns {ExtensionScheduler}
 */
export function getExtensionScheduler() {
  if (!instance) {
    instance = new ExtensionScheduler();
  }
  return instance;
}
