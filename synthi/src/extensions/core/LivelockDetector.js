/**
 * Synthi Extension System - Livelock Detector
 * CRITICAL: Heartbeat alone is insufficient
 * 
 * Implements drift detection:
 * - Measure expected heartbeat vs actual arrival
 * - If drift > 2× interval → assume CPU hog
 * - Kill worker immediately
 * 
 * Without this, tight loops slip through.
 */

/**
 * @typedef {Object} HeartbeatRecord
 * @property {number} expected - When heartbeat should have arrived
 * @property {number} actual - When heartbeat actually arrived (null if missed)
 * @property {number} drift - Actual - Expected (positive = late)
 */

/**
 * Livelock Detector
 * Monitors heartbeat timing to detect CPU-hogging extensions
 */
export class LivelockDetector {
  /**
   * @param {Object} options
   * @param {number} [options.heartbeatInterval=5000] - Expected ms between heartbeats
   * @param {number} [options.maxDriftMultiplier=2] - Kill if drift > interval * this
   * @param {number} [options.historySize=10] - Number of heartbeats to track
   * @param {(reason: string) => void} [options.onLivelock] - Called when livelock detected
   */
  constructor(options = {}) {
    this.heartbeatInterval = options.heartbeatInterval || 5000;
    this.maxDriftMultiplier = options.maxDriftMultiplier || 2;
    this.historySize = options.historySize || 10;
    this.onLivelock = options.onLivelock || (() => {});
    
    /** @type {HeartbeatRecord[]} */
    this.history = [];
    
    /** @type {number|null} */
    this.lastHeartbeat = null;
    
    /** @type {number|null} */
    this.expectedNextHeartbeat = null;
    
    /** @type {NodeJS.Timeout|null} */
    this.checkTimer = null;
    
    /** @type {boolean} */
    this.isMonitoring = false;
    
    /** @type {number} */
    this.missedCount = 0;
    
    /** @type {number} */
    this.consecutiveLate = 0;
    
    /** @type {string|null} */
    this.suspectedExtension = null;
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    this.lastHeartbeat = Date.now();
    this.expectedNextHeartbeat = this.lastHeartbeat + this.heartbeatInterval;
    this.missedCount = 0;
    this.consecutiveLate = 0;
    
    this._scheduleCheck();
    
    console.log('[LivelockDetector] Started monitoring');
  }

  /**
   * Stop monitoring
   */
  stop() {
    this.isMonitoring = false;
    
    if (this.checkTimer) {
      clearTimeout(this.checkTimer);
      this.checkTimer = null;
    }
    
    console.log('[LivelockDetector] Stopped monitoring');
  }

  /**
   * Reset detector (e.g., after worker restart)
   */
  reset() {
    this.stop();
    this.history = [];
    this.lastHeartbeat = null;
    this.expectedNextHeartbeat = null;
    this.missedCount = 0;
    this.consecutiveLate = 0;
    this.suspectedExtension = null;
  }

  /**
   * Record a received heartbeat
   * @param {string} [activeExtension] - Currently active extension (for blame attribution)
   * @returns {{healthy: boolean, drift: number, warning: string|null}}
   */
  recordHeartbeat(activeExtension = null) {
    if (!this.isMonitoring) {
      return { healthy: true, drift: 0, warning: null };
    }

    const now = Date.now();
    const expected = this.expectedNextHeartbeat || now;
    const drift = now - expected;
    
    // Record in history
    const record = {
      expected,
      actual: now,
      drift,
      extension: activeExtension
    };
    
    this.history.push(record);
    if (this.history.length > this.historySize) {
      this.history.shift();
    }

    // Update state
    this.lastHeartbeat = now;
    this.expectedNextHeartbeat = now + this.heartbeatInterval;
    
    // Check for livelock
    const maxAllowedDrift = this.heartbeatInterval * this.maxDriftMultiplier;
    
    if (drift > maxAllowedDrift) {
      // CRITICAL: Drift exceeds threshold
      this.consecutiveLate++;
      this.suspectedExtension = activeExtension;
      
      const reason = `Heartbeat drift ${drift}ms exceeds max ${maxAllowedDrift}ms` +
                     (activeExtension ? ` (suspected: ${activeExtension})` : '');
      
      console.error(`[LivelockDetector] LIVELOCK DETECTED: ${reason}`);
      
      // Trigger callback
      this.onLivelock(reason);
      
      return {
        healthy: false,
        drift,
        warning: reason
      };
    }
    
    // Check for concerning pattern (multiple late heartbeats)
    if (drift > this.heartbeatInterval * 0.5) {
      this.consecutiveLate++;
      
      if (this.consecutiveLate >= 3) {
        const reason = `3+ consecutive late heartbeats (last drift: ${drift}ms)`;
        console.warn(`[LivelockDetector] Warning: ${reason}`);
        
        return {
          healthy: true,
          drift,
          warning: reason
        };
      }
    } else {
      // Good heartbeat, reset counter
      this.consecutiveLate = 0;
    }
    
    this.missedCount = 0; // Reset missed count on successful heartbeat
    
    return { healthy: true, drift, warning: null };
  }

  /**
   * Get current health status
   * @returns {{healthy: boolean, drift: number, missedCount: number, avgDrift: number}}
   */
  getStatus() {
    const now = Date.now();
    const timeSinceLastHeartbeat = this.lastHeartbeat ? (now - this.lastHeartbeat) : 0;
    
    // Calculate average drift
    const avgDrift = this.history.length > 0
      ? this.history.reduce((sum, r) => sum + Math.max(0, r.drift), 0) / this.history.length
      : 0;
    
    // Check if we're currently in trouble
    const maxAllowedDrift = this.heartbeatInterval * this.maxDriftMultiplier;
    const currentlyLate = timeSinceLastHeartbeat > (this.heartbeatInterval + maxAllowedDrift);
    
    return {
      healthy: !currentlyLate && this.missedCount < 2,
      drift: timeSinceLastHeartbeat,
      missedCount: this.missedCount,
      avgDrift: Math.round(avgDrift),
      consecutiveLate: this.consecutiveLate,
      suspectedExtension: this.suspectedExtension
    };
  }

  /**
   * Get drift history
   * @returns {HeartbeatRecord[]}
   */
  getHistory() {
    return [...this.history];
  }

  /**
   * Schedule next check
   * @private
   */
  _scheduleCheck() {
    if (!this.isMonitoring) return;
    
    // Check slightly after expected heartbeat
    const checkDelay = this.heartbeatInterval + 500;
    
    this.checkTimer = setTimeout(() => {
      this._checkHeartbeat();
    }, checkDelay);
  }

  /**
   * Check if heartbeat was missed
   * @private
   */
  _checkHeartbeat() {
    if (!this.isMonitoring) return;

    const now = Date.now();
    const expected = this.expectedNextHeartbeat || now;
    const timeSinceLast = this.lastHeartbeat ? (now - this.lastHeartbeat) : this.heartbeatInterval * 3;
    
    // If we're checking and no heartbeat came, it was missed
    const maxAllowedTime = this.heartbeatInterval * this.maxDriftMultiplier;
    
    if (timeSinceLast > maxAllowedTime) {
      this.missedCount++;
      
      // Record missed heartbeat
      this.history.push({
        expected,
        actual: null,
        drift: Infinity,
        missed: true
      });
      if (this.history.length > this.historySize) {
        this.history.shift();
      }

      const reason = `Heartbeat missed (${timeSinceLast}ms since last, max allowed: ${maxAllowedTime}ms)`;
      console.error(`[LivelockDetector] MISSED HEARTBEAT: ${reason}`);
      
      // Single missed heartbeat = immediate livelock assumption
      this.onLivelock(reason);
    }

    // Schedule next check
    this._scheduleCheck();
  }
}

/**
 * Per-extension CPU tracking
 * Attributes CPU time to specific extensions
 */
export class ExtensionCPUTracker {
  constructor() {
    /** @type {Map<string, {totalTime: number, samples: number, lastStart: number|null}>} */
    this.extensionTimes = new Map();
    
    /** @type {string|null} */
    this.currentExtension = null;
    
    /** @type {number|null} */
    this.currentStart = null;
  }

  /**
   * Mark start of extension execution
   * @param {string} extensionId
   */
  startExecution(extensionId) {
    // End previous if any
    if (this.currentExtension) {
      this.endExecution(this.currentExtension);
    }
    
    this.currentExtension = extensionId;
    this.currentStart = performance.now();
  }

  /**
   * Mark end of extension execution
   * @param {string} extensionId
   */
  endExecution(extensionId) {
    if (this.currentExtension !== extensionId) {
      console.warn(`[CPUTracker] End mismatch: expected ${this.currentExtension}, got ${extensionId}`);
      return;
    }
    
    if (!this.currentStart) return;
    
    const duration = performance.now() - this.currentStart;
    
    let record = this.extensionTimes.get(extensionId);
    if (!record) {
      record = { totalTime: 0, samples: 0, lastStart: null };
      this.extensionTimes.set(extensionId, record);
    }
    
    record.totalTime += duration;
    record.samples++;
    
    this.currentExtension = null;
    this.currentStart = null;
  }

  /**
   * Get current executing extension
   * @returns {string|null}
   */
  getCurrentExtension() {
    return this.currentExtension;
  }

  /**
   * Get CPU stats for extension
   * @param {string} extensionId
   * @returns {{totalTime: number, samples: number, avgTime: number}|null}
   */
  getStats(extensionId) {
    const record = this.extensionTimes.get(extensionId);
    if (!record) return null;
    
    return {
      totalTime: Math.round(record.totalTime),
      samples: record.samples,
      avgTime: record.samples > 0 ? Math.round(record.totalTime / record.samples) : 0
    };
  }

  /**
   * Get all CPU stats
   * @returns {Map<string, {totalTime: number, samples: number, avgTime: number}>}
   */
  getAllStats() {
    const result = new Map();
    for (const [id, record] of this.extensionTimes) {
      result.set(id, {
        totalTime: Math.round(record.totalTime),
        samples: record.samples,
        avgTime: record.samples > 0 ? Math.round(record.totalTime / record.samples) : 0
      });
    }
    return result;
  }

  /**
   * Reset stats for extension
   * @param {string} extensionId
   */
  resetStats(extensionId) {
    this.extensionTimes.delete(extensionId);
    if (this.currentExtension === extensionId) {
      this.currentExtension = null;
      this.currentStart = null;
    }
  }

  /**
   * Reset all stats
   */
  resetAll() {
    this.extensionTimes.clear();
    this.currentExtension = null;
    this.currentStart = null;
  }
}

// Singleton instances
let detectorInstance = null;
let trackerInstance = null;

/**
 * Get singleton LivelockDetector
 * @param {Object} [options]
 * @returns {LivelockDetector}
 */
export function getLivelockDetector(options = {}) {
  if (!detectorInstance) {
    detectorInstance = new LivelockDetector(options);
  }
  return detectorInstance;
}

/**
 * Get singleton CPUTracker
 * @returns {ExtensionCPUTracker}
 */
export function getCPUTracker() {
  if (!trackerInstance) {
    trackerInstance = new ExtensionCPUTracker();
  }
  return trackerInstance;
}
