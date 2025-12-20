/**
 * Synthi Extension System - Timer Throttler
 * Controls setTimeout/setInterval for extensions
 */

/**
 * @typedef {Object} TimerConfig
 * @property {number} minDelay - Minimum delay allowed (ms)
 * @property {number} maxActiveTimers - Max simultaneous timers
 * @property {number} backgroundMultiplier - Delay multiplier when hidden
 */

const DEFAULT_CONFIG = {
  minDelay: 100,
  maxActiveTimers: 50,
  backgroundMultiplier: 10
};

export class TimerThrottler {
  constructor() {
    /** @type {Map<string, Map<number, object>>} Extension ID -> Timer ID -> Timer info */
    this.timers = new Map();
    
    /** @type {Map<string, TimerConfig>} */
    this.configs = new Map();
    
    /** @type {number} */
    this.nextTimerId = 1;
    
    /** @type {boolean} */
    this.isBackground = false;
    
    /** @type {Set<string>} Paused extensions */
    this.paused = new Set();
  }

  /**
   * Register an extension
   * @param {string} extensionId
   * @param {Partial<TimerConfig>} [config]
   */
  register(extensionId, config = {}) {
    this.configs.set(extensionId, { ...DEFAULT_CONFIG, ...config });
    this.timers.set(extensionId, new Map());
  }

  /**
   * Unregister an extension
   * @param {string} extensionId
   */
  unregister(extensionId) {
    // Clear all timers
    const extTimers = this.timers.get(extensionId);
    if (extTimers) {
      for (const [timerId, info] of extTimers) {
        this._clearTimer(info);
      }
    }
    
    this.timers.delete(extensionId);
    this.configs.delete(extensionId);
    this.paused.delete(extensionId);
  }

  /**
   * Set a timeout for an extension
   * @param {string} extensionId
   * @param {Function} callback
   * @param {number} delay
   * @returns {number} Timer ID
   */
  setTimeout(extensionId, callback, delay) {
    return this._setTimer(extensionId, callback, delay, false);
  }

  /**
   * Set an interval for an extension
   * @param {string} extensionId
   * @param {Function} callback
   * @param {number} delay
   * @returns {number} Timer ID
   */
  setInterval(extensionId, callback, delay) {
    return this._setTimer(extensionId, callback, delay, true);
  }

  /**
   * Internal timer creation
   * @param {string} extensionId
   * @param {Function} callback
   * @param {number} delay
   * @param {boolean} isInterval
   * @returns {number}
   */
  _setTimer(extensionId, callback, delay, isInterval) {
    const config = this.configs.get(extensionId) || DEFAULT_CONFIG;
    const extTimers = this.timers.get(extensionId);
    
    if (!extTimers) {
      // Extension not registered, use global timer
      if (isInterval) {
        return globalThis.setInterval(callback, delay);
      } else {
        return globalThis.setTimeout(callback, delay);
      }
    }

    // Check max timers
    if (extTimers.size >= config.maxActiveTimers) {
      console.warn(`[TimerThrottler] Extension ${extensionId} exceeded max timers (${config.maxActiveTimers})`);
      return -1;
    }

    // Apply minimum delay
    let effectiveDelay = Math.max(delay, config.minDelay);
    
    // Apply background multiplier
    if (this.isBackground) {
      effectiveDelay *= config.backgroundMultiplier;
    }

    const timerId = this.nextTimerId++;
    
    const info = {
      id: timerId,
      extensionId,
      callback,
      originalDelay: delay,
      effectiveDelay,
      isInterval,
      realId: null,
      isPaused: this.paused.has(extensionId)
    };

    // Don't start if paused
    if (!info.isPaused) {
      this._startTimer(info);
    }

    extTimers.set(timerId, info);
    return timerId;
  }

  /**
   * Start a timer
   * @param {object} info
   */
  _startTimer(info) {
    const wrapper = () => {
      const extTimers = this.timers.get(info.extensionId);
      if (!extTimers || !extTimers.has(info.id)) return;
      
      try {
        info.callback();
      } catch (err) {
        console.error(`[TimerThrottler] Timer callback error (${info.extensionId}):`, err);
      }

      // Cleanup for timeouts
      if (!info.isInterval) {
        extTimers.delete(info.id);
      }
    };

    if (info.isInterval) {
      info.realId = globalThis.setInterval(wrapper, info.effectiveDelay);
    } else {
      info.realId = globalThis.setTimeout(wrapper, info.effectiveDelay);
    }
  }

  /**
   * Clear a timer
   * @param {object} info
   */
  _clearTimer(info) {
    if (info.realId !== null) {
      if (info.isInterval) {
        globalThis.clearInterval(info.realId);
      } else {
        globalThis.clearTimeout(info.realId);
      }
      info.realId = null;
    }
  }

  /**
   * Clear a timeout
   * @param {string} extensionId
   * @param {number} timerId
   */
  clearTimeout(extensionId, timerId) {
    this._clear(extensionId, timerId);
  }

  /**
   * Clear an interval
   * @param {string} extensionId
   * @param {number} timerId
   */
  clearInterval(extensionId, timerId) {
    this._clear(extensionId, timerId);
  }

  /**
   * Internal clear
   * @param {string} extensionId
   * @param {number} timerId
   */
  _clear(extensionId, timerId) {
    const extTimers = this.timers.get(extensionId);
    if (!extTimers) return;

    const info = extTimers.get(timerId);
    if (!info) return;

    this._clearTimer(info);
    extTimers.delete(timerId);
  }

  /**
   * Pause all timers for an extension
   * @param {string} extensionId
   */
  pause(extensionId) {
    this.paused.add(extensionId);
    
    const extTimers = this.timers.get(extensionId);
    if (!extTimers) return;

    for (const [, info] of extTimers) {
      this._clearTimer(info);
      info.isPaused = true;
    }
  }

  /**
   * Resume all timers for an extension
   * @param {string} extensionId
   */
  resume(extensionId) {
    this.paused.delete(extensionId);
    
    const extTimers = this.timers.get(extensionId);
    if (!extTimers) return;

    for (const [, info] of extTimers) {
      if (info.isPaused) {
        info.isPaused = false;
        this._startTimer(info);
      }
    }
  }

  /**
   * Set background state
   * @param {boolean} isBackground
   */
  setBackgroundState(isBackground) {
    if (this.isBackground === isBackground) return;
    
    this.isBackground = isBackground;
    
    // Update all active timers
    for (const [extensionId, extTimers] of this.timers) {
      const config = this.configs.get(extensionId) || DEFAULT_CONFIG;
      
      for (const [, info] of extTimers) {
        if (info.isPaused) continue;
        
        // Recalculate effective delay
        let newDelay = Math.max(info.originalDelay, config.minDelay);
        if (isBackground) {
          newDelay *= config.backgroundMultiplier;
        }
        
        if (newDelay !== info.effectiveDelay) {
          // Restart timer with new delay
          this._clearTimer(info);
          info.effectiveDelay = newDelay;
          this._startTimer(info);
        }
      }
    }
  }

  /**
   * Get timer count for an extension
   * @param {string} extensionId
   * @returns {number}
   */
  getTimerCount(extensionId) {
    const extTimers = this.timers.get(extensionId);
    return extTimers ? extTimers.size : 0;
  }

  /**
   * Get all timer stats
   * @returns {object}
   */
  getStats() {
    const stats = {
      isBackground: this.isBackground,
      extensions: {}
    };

    for (const [extensionId, extTimers] of this.timers) {
      let intervals = 0;
      let timeouts = 0;
      let paused = 0;

      for (const [, info] of extTimers) {
        if (info.isInterval) intervals++;
        else timeouts++;
        if (info.isPaused) paused++;
      }

      stats.extensions[extensionId] = {
        total: extTimers.size,
        intervals,
        timeouts,
        paused
      };
    }

    return stats;
  }
}

// Singleton
let instance = null;

/**
 * Get TimerThrottler singleton
 * @returns {TimerThrottler}
 */
export function getTimerThrottler() {
  if (!instance) {
    instance = new TimerThrottler();
  }
  return instance;
}
