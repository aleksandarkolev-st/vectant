/**
 * Synthi Extension System - Cross-Extension Isolation
 * CRITICAL: Single worker = shared fate unless enforced
 * 
 * Provides:
 * - Per-extension message queues
 * - Per-extension rate counters  
 * - Scheduler attributes CPU usage per extension
 * 
 * If Extension A can starve B, isolation is fake.
 */

/**
 * @typedef {Object} ExtensionQueueEntry
 * @property {string} id - Unique message ID
 * @property {string} type - Message type
 * @property {any} payload - Message payload
 * @property {number} priority - 0 = highest
 * @property {number} timestamp - When queued
 * @property {number} timeout - When to expire
 */

/**
 * @typedef {Object} ExtensionRateState
 * @property {number} messageCount - Messages in current window
 * @property {number} windowStart - Window start timestamp
 * @property {number} throttledCount - Times throttled
 * @property {boolean} isThrottled - Currently throttled?
 * @property {number} cpuTime - Accumulated CPU time (ms)
 * @property {number} lastExecution - Last execution timestamp
 */

/**
 * Per-Extension Message Queue
 */
class ExtensionMessageQueue {
  /**
   * @param {string} extensionId
   * @param {Object} options
   * @param {number} [options.maxSize=1000]
   * @param {number} [options.defaultTimeout=30000]
   */
  constructor(extensionId, options = {}) {
    this.extensionId = extensionId;
    this.maxSize = options.maxSize || 1000;
    this.defaultTimeout = options.defaultTimeout || 30000;
    
    /** @type {ExtensionQueueEntry[]} */
    this.queue = [];
    
    /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
    this.pending = new Map();
    
    /** @type {number} */
    this.messageIdCounter = 0;
    
    /** @type {number} */
    this.droppedCount = 0;
    
    /** @type {boolean} */
    this.isPaused = false;
  }

  /**
   * Queue a message
   * @param {string} type
   * @param {any} payload
   * @param {Object} [options]
   * @param {number} [options.priority=5]
   * @param {number} [options.timeout]
   * @returns {{id: string, queued: boolean, dropped: boolean}}
   */
  enqueue(type, payload, options = {}) {
    const id = `${this.extensionId}-${++this.messageIdCounter}`;
    
    // Check if queue is full
    if (this.queue.length >= this.maxSize) {
      this.droppedCount++;
      console.warn(`[ExtensionQueue:${this.extensionId}] Queue full, dropping message: ${type}`);
      return { id, queued: false, dropped: true };
    }

    const entry = {
      id,
      type,
      payload,
      priority: options.priority ?? 5,
      timestamp: Date.now(),
      timeout: Date.now() + (options.timeout ?? this.defaultTimeout)
    };

    // Insert by priority (lower = higher priority)
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      if (entry.priority < this.queue[i].priority) {
        this.queue.splice(i, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.queue.push(entry);
    }

    return { id, queued: true, dropped: false };
  }

  /**
   * Dequeue next message
   * @returns {ExtensionQueueEntry|null}
   */
  dequeue() {
    if (this.isPaused) return null;
    
    // Remove expired messages first
    this._cleanExpired();
    
    if (this.queue.length === 0) return null;
    
    return this.queue.shift();
  }

  /**
   * Peek at next message without removing
   * @returns {ExtensionQueueEntry|null}
   */
  peek() {
    this._cleanExpired();
    return this.queue[0] || null;
  }

  /**
   * Get queue size
   * @returns {number}
   */
  size() {
    return this.queue.length;
  }

  /**
   * Pause queue processing
   */
  pause() {
    this.isPaused = true;
  }

  /**
   * Resume queue processing
   */
  resume() {
    this.isPaused = false;
  }

  /**
   * Clear all queued messages
   * @param {string} [reason]
   * @returns {number} Number of cleared messages
   */
  clear(reason = 'Queue cleared') {
    const count = this.queue.length;
    
    // Reject all pending
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error(reason));
    }
    this.pending.clear();
    this.queue = [];
    
    return count;
  }

  /**
   * Get stats
   * @returns {{size: number, dropped: number, pending: number, paused: boolean}}
   */
  getStats() {
    return {
      size: this.queue.length,
      dropped: this.droppedCount,
      pending: this.pending.size,
      paused: this.isPaused
    };
  }

  _cleanExpired() {
    const now = Date.now();
    const expired = [];
    
    this.queue = this.queue.filter(entry => {
      if (entry.timeout < now) {
        expired.push(entry);
        return false;
      }
      return true;
    });
    
    // Log expired if significant
    if (expired.length > 0) {
      console.warn(`[ExtensionQueue:${this.extensionId}] Expired ${expired.length} messages`);
    }
  }
}

/**
 * Per-Extension Rate Limiter
 */
class ExtensionRateLimiter {
  /**
   * @param {string} extensionId
   * @param {Object} options
   * @param {number} [options.messagesPerSecond=100]
   * @param {number} [options.cpuBudgetMs=500] - CPU budget per second
   * @param {number} [options.throttleDurationMs=1000]
   */
  constructor(extensionId, options = {}) {
    this.extensionId = extensionId;
    this.messagesPerSecond = options.messagesPerSecond || 100;
    this.cpuBudgetMs = options.cpuBudgetMs || 500;
    this.throttleDurationMs = options.throttleDurationMs || 1000;
    
    /** @type {ExtensionRateState} */
    this.state = {
      messageCount: 0,
      windowStart: Date.now(),
      throttledCount: 0,
      isThrottled: false,
      cpuTime: 0,
      lastExecution: 0
    };
    
    /** @type {NodeJS.Timeout|null} */
    this.throttleTimer = null;
  }

  /**
   * Check if message can be sent
   * @returns {{allowed: boolean, reason: string|null, waitMs: number}}
   */
  checkMessage() {
    this._maybeResetWindow();
    
    if (this.state.isThrottled) {
      return {
        allowed: false,
        reason: 'Extension is throttled due to excessive messages',
        waitMs: this.throttleDurationMs
      };
    }
    
    if (this.state.messageCount >= this.messagesPerSecond) {
      this._startThrottle('message_limit');
      return {
        allowed: false,
        reason: `Rate limit exceeded: ${this.messagesPerSecond}/s`,
        waitMs: this.throttleDurationMs
      };
    }
    
    this.state.messageCount++;
    return { allowed: true, reason: null, waitMs: 0 };
  }

  /**
   * Record CPU time used
   * @param {number} ms
   * @returns {{allowed: boolean, reason: string|null}}
   */
  recordCpuTime(ms) {
    this._maybeResetWindow();
    
    this.state.cpuTime += ms;
    this.state.lastExecution = Date.now();
    
    if (this.state.cpuTime >= this.cpuBudgetMs) {
      this._startThrottle('cpu_limit');
      return {
        allowed: false,
        reason: `CPU budget exceeded: ${this.cpuBudgetMs}ms/s`
      };
    }
    
    return { allowed: true, reason: null };
  }

  /**
   * Check if currently throttled
   * @returns {boolean}
   */
  isThrottled() {
    return this.state.isThrottled;
  }

  /**
   * Manually throttle
   * @param {number} [durationMs]
   */
  throttle(durationMs = this.throttleDurationMs) {
    this._startThrottle('manual', durationMs);
  }

  /**
   * Clear throttle
   */
  unthrottle() {
    this.state.isThrottled = false;
    if (this.throttleTimer) {
      clearTimeout(this.throttleTimer);
      this.throttleTimer = null;
    }
  }

  /**
   * Get current rate
   * @returns {number} Messages per second (current)
   */
  getCurrentRate() {
    const elapsed = (Date.now() - this.state.windowStart) / 1000;
    return elapsed > 0 ? this.state.messageCount / elapsed : 0;
  }

  /**
   * Get stats
   * @returns {ExtensionRateState & {currentRate: number}}
   */
  getStats() {
    return {
      ...this.state,
      currentRate: Math.round(this.getCurrentRate())
    };
  }

  /**
   * Reset stats
   */
  reset() {
    this.state = {
      messageCount: 0,
      windowStart: Date.now(),
      throttledCount: 0,
      isThrottled: false,
      cpuTime: 0,
      lastExecution: 0
    };
    this.unthrottle();
  }

  _maybeResetWindow() {
    const now = Date.now();
    if (now - this.state.windowStart >= 1000) {
      this.state.messageCount = 0;
      this.state.cpuTime = 0;
      this.state.windowStart = now;
    }
  }

  _startThrottle(reason, durationMs = this.throttleDurationMs) {
    if (this.state.isThrottled) return;
    
    this.state.isThrottled = true;
    this.state.throttledCount++;
    
    console.warn(`[RateLimiter:${this.extensionId}] Throttled: ${reason}`);
    
    this.throttleTimer = setTimeout(() => {
      this.state.isThrottled = false;
      this.throttleTimer = null;
    }, durationMs);
  }
}

/**
 * Fair Scheduler - ensures no extension starves others
 */
export class FairScheduler {
  /**
   * @param {Object} options
   * @param {number} [options.messagesPerSecond=100]
   * @param {number} [options.cpuBudgetMs=500]
   * @param {number} [options.maxQueueSize=1000]
   */
  constructor(options = {}) {
    this.options = {
      messagesPerSecond: options.messagesPerSecond || 100,
      cpuBudgetMs: options.cpuBudgetMs || 500,
      maxQueueSize: options.maxQueueSize || 1000
    };
    
    /** @type {Map<string, ExtensionMessageQueue>} */
    this.queues = new Map();
    
    /** @type {Map<string, ExtensionRateLimiter>} */
    this.rateLimiters = new Map();
    
    /** @type {string[]} */
    this.roundRobinOrder = [];
    
    /** @type {number} */
    this.roundRobinIndex = 0;
    
    /** @type {boolean} */
    this.isRunning = false;
    
    /** @type {((entry: ExtensionQueueEntry, extensionId: string) => Promise<void>)|null} */
    this.onProcess = null;
    
    /** @type {((extensionId: string, reason: string) => void)|null} */
    this.onThrottled = null;
    
    /** @type {((extensionId: string, reason: string) => void)|null} */
    this.onViolation = null;
  }

  /**
   * Register an extension
   * @param {string} extensionId
   */
  registerExtension(extensionId) {
    if (!this.queues.has(extensionId)) {
      this.queues.set(extensionId, new ExtensionMessageQueue(extensionId, {
        maxSize: this.options.maxQueueSize
      }));
      this.rateLimiters.set(extensionId, new ExtensionRateLimiter(extensionId, {
        messagesPerSecond: this.options.messagesPerSecond,
        cpuBudgetMs: this.options.cpuBudgetMs
      }));
      this.roundRobinOrder.push(extensionId);
    }
  }

  /**
   * Unregister an extension
   * @param {string} extensionId
   */
  unregisterExtension(extensionId) {
    const queue = this.queues.get(extensionId);
    if (queue) {
      queue.clear('Extension unregistered');
    }
    
    this.queues.delete(extensionId);
    this.rateLimiters.delete(extensionId);
    this.roundRobinOrder = this.roundRobinOrder.filter(id => id !== extensionId);
    
    if (this.roundRobinIndex >= this.roundRobinOrder.length) {
      this.roundRobinIndex = 0;
    }
  }

  /**
   * Queue a message for an extension
   * @param {string} extensionId
   * @param {string} type
   * @param {any} payload
   * @param {Object} [options]
   * @returns {{success: boolean, id: string|null, error: string|null}}
   */
  queueMessage(extensionId, type, payload, options = {}) {
    const queue = this.queues.get(extensionId);
    if (!queue) {
      return { success: false, id: null, error: 'Extension not registered' };
    }
    
    const rateLimiter = this.rateLimiters.get(extensionId);
    const rateCheck = rateLimiter?.checkMessage();
    
    if (rateCheck && !rateCheck.allowed) {
      if (this.onThrottled) {
        this.onThrottled(extensionId, rateCheck.reason);
      }
      return { success: false, id: null, error: rateCheck.reason };
    }
    
    const result = queue.enqueue(type, payload, options);
    
    if (result.dropped) {
      if (this.onViolation) {
        this.onViolation(extensionId, 'Queue overflow');
      }
      return { success: false, id: result.id, error: 'Queue full' };
    }
    
    return { success: true, id: result.id, error: null };
  }

  /**
   * Process next message using fair round-robin
   * @returns {Promise<boolean>} true if processed something
   */
  async processNext() {
    if (this.roundRobinOrder.length === 0) {
      return false;
    }

    // Try each extension in round-robin order
    const startIndex = this.roundRobinIndex;
    
    do {
      const extensionId = this.roundRobinOrder[this.roundRobinIndex];
      this.roundRobinIndex = (this.roundRobinIndex + 1) % this.roundRobinOrder.length;
      
      const queue = this.queues.get(extensionId);
      const rateLimiter = this.rateLimiters.get(extensionId);
      
      if (!queue || !rateLimiter) continue;
      if (rateLimiter.isThrottled()) continue;
      
      const entry = queue.dequeue();
      if (!entry) continue;
      
      // Process the message
      if (this.onProcess) {
        const startTime = performance.now();
        
        try {
          await this.onProcess(entry, extensionId);
        } catch (err) {
          console.error(`[FairScheduler] Error processing message for ${extensionId}:`, err);
        }
        
        const cpuTime = performance.now() - startTime;
        const cpuCheck = rateLimiter.recordCpuTime(cpuTime);
        
        if (!cpuCheck.allowed && this.onThrottled) {
          this.onThrottled(extensionId, cpuCheck.reason);
        }
      }
      
      return true;
    } while (this.roundRobinIndex !== startIndex);
    
    return false;
  }

  /**
   * Start processing loop
   */
  start() {
    if (this.isRunning) return;
    
    this.isRunning = true;
    this._processLoop();
  }

  /**
   * Stop processing
   */
  stop() {
    this.isRunning = false;
  }

  /**
   * Pause an extension's queue
   * @param {string} extensionId
   */
  pauseExtension(extensionId) {
    const queue = this.queues.get(extensionId);
    if (queue) queue.pause();
  }

  /**
   * Resume an extension's queue
   * @param {string} extensionId
   */
  resumeExtension(extensionId) {
    const queue = this.queues.get(extensionId);
    if (queue) queue.resume();
  }

  /**
   * Get stats for all extensions
   * @returns {Map<string, {queue: object, rate: object}>}
   */
  getStats() {
    const stats = new Map();
    
    for (const [id, queue] of this.queues) {
      const rateLimiter = this.rateLimiters.get(id);
      stats.set(id, {
        queue: queue.getStats(),
        rate: rateLimiter?.getStats() || {}
      });
    }
    
    return stats;
  }

  /**
   * Clear all queues
   * @param {string} [reason]
   */
  clearAll(reason = 'Scheduler cleared') {
    for (const queue of this.queues.values()) {
      queue.clear(reason);
    }
  }

  async _processLoop() {
    while (this.isRunning) {
      const processed = await this.processNext();
      
      // If nothing to process, yield
      if (!processed) {
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    }
  }
}

// Singleton
let schedulerInstance = null;

/**
 * Get singleton FairScheduler
 * @param {Object} [options]
 * @returns {FairScheduler}
 */
export function getFairScheduler(options = {}) {
  if (!schedulerInstance) {
    schedulerInstance = new FairScheduler(options);
  }
  return schedulerInstance;
}

/**
 * Create a new FairScheduler (for testing)
 * @param {Object} [options]
 * @returns {FairScheduler}
 */
export function createFairScheduler(options = {}) {
  return new FairScheduler(options);
}
