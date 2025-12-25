/**
 * Synthi Extension System - Visibility Manager
 * Handles tab visibility and extension pausing
 */

export class VisibilityManager {
  constructor() {
    /** @type {boolean} */
    this.isVisible = typeof document !== 'undefined' ? !document.hidden : true;
    
    /** @type {number|null} */
    this.hiddenSince = null;
    
    /** @type {number} Suspend threshold in ms (30 seconds) */
    this.suspendThreshold = 30000;
    
    /** @type {Set<string>} Paused extensions */
    this.paused = new Set();
    
    /** @type {Set<string>} Suspended extensions (due to long hidden) */
    this.suspendedForVisibility = new Set();
    
    /** @type {Function[]} */
    this.visibilityListeners = [];
    
    /** @type {Function|null} */
    this.onPause = null;
    
    /** @type {Function|null} */
    this.onResume = null;
    
    /** @type {Function|null} */
    this.onSuspend = null;
    
    /** @type {number|null} */
    this._checkInterval = null;
    
    // Set up visibility listener
    this._setupVisibilityListener();
  }

  /**
   * Set up document visibility listener
   */
  _setupVisibilityListener() {
    if (typeof document === 'undefined') return;

    document.addEventListener('visibilitychange', () => {
      this._handleVisibilityChange();
    });

    // Also listen for focus/blur as backup
    window.addEventListener('focus', () => {
      if (!this.isVisible) {
        this.isVisible = true;
        this._handleVisibilityChange();
      }
    });

    window.addEventListener('blur', () => {
      // Don't immediately hide - let visibilitychange handle it
    });
  }

  /**
   * Handle visibility change
   */
  _handleVisibilityChange() {
    const wasVisible = this.isVisible;
    this.isVisible = !document.hidden;

    if (wasVisible && !this.isVisible) {
      // Just became hidden
      this.hiddenSince = Date.now();
      this._onHidden();
    } else if (!wasVisible && this.isVisible) {
      // Just became visible
      this.hiddenSince = null;
      this._onVisible();
    }

    // Notify listeners
    for (const listener of this.visibilityListeners) {
      try {
        listener(this.isVisible);
      } catch (err) {
        console.error('[VisibilityManager] Listener error:', err);
      }
    }
  }

  /**
   * Handle becoming hidden
   */
  _onHidden() {
    console.log('[VisibilityManager] Tab hidden - pausing extensions');
    
    // Pause all extensions
    for (const extensionId of this._getRegisteredExtensions()) {
      this.paused.add(extensionId);
      if (this.onPause) {
        this.onPause(extensionId);
      }
    }

    // Start checking for suspend threshold
    this._startSuspendCheck();
  }

  /**
   * Handle becoming visible
   */
  _onVisible() {
    console.log('[VisibilityManager] Tab visible - resuming extensions');
    
    // Stop suspend checking
    this._stopSuspendCheck();
    
    // Resume all paused extensions
    for (const extensionId of this.paused) {
      if (this.onResume) {
        this.onResume(extensionId);
      }
    }
    this.paused.clear();
    
    // Resume visibility-suspended extensions
    for (const extensionId of this.suspendedForVisibility) {
      if (this.onResume) {
        this.onResume(extensionId);
      }
    }
    this.suspendedForVisibility.clear();
  }

  /**
   * Start checking for suspend threshold
   */
  _startSuspendCheck() {
    if (this._checkInterval) return;

    this._checkInterval = setInterval(() => {
      if (!this.isVisible && this.hiddenSince) {
        const hiddenDuration = Date.now() - this.hiddenSince;
        
        if (hiddenDuration >= this.suspendThreshold) {
          this._suspendAll();
          this._stopSuspendCheck();
        }
      }
    }, 5000);
  }

  /**
   * Stop suspend checking
   */
  _stopSuspendCheck() {
    if (this._checkInterval) {
      clearInterval(this._checkInterval);
      this._checkInterval = null;
    }
  }

  /**
   * Suspend all extensions
   */
  _suspendAll() {
    console.log('[VisibilityManager] Tab hidden > 30s - suspending extensions');
    
    for (const extensionId of this.paused) {
      this.suspendedForVisibility.add(extensionId);
      if (this.onSuspend) {
        this.onSuspend(extensionId);
      }
    }
  }

  /**
   * Get registered extensions
   * This would be populated from the actual extension registry
   * @returns {string[]}
   */
  _getRegisteredExtensions() {
    // This is a placeholder - in practice, this would come from the extension registry
    return Array.from(this.paused);
  }

  /**
   * Register an extension for visibility management
   * @param {string} extensionId
   */
  register(extensionId) {
    // If currently hidden, immediately pause
    if (!this.isVisible) {
      this.paused.add(extensionId);
      if (this.onPause) {
        this.onPause(extensionId);
      }
    }
  }

  /**
   * Unregister an extension
   * @param {string} extensionId
   */
  unregister(extensionId) {
    this.paused.delete(extensionId);
    this.suspendedForVisibility.delete(extensionId);
  }

  /**
   * Check if extension is paused
   * @param {string} extensionId
   * @returns {boolean}
   */
  isPaused(extensionId) {
    return this.paused.has(extensionId);
  }

  /**
   * Check if extension is suspended for visibility
   * @param {string} extensionId
   * @returns {boolean}
   */
  isSuspended(extensionId) {
    return this.suspendedForVisibility.has(extensionId);
  }

  /**
   * Subscribe to visibility changes
   * @param {Function} listener
   * @returns {Function} Unsubscribe function
   */
  onVisibilityChange(listener) {
    this.visibilityListeners.push(listener);
    return () => {
      const idx = this.visibilityListeners.indexOf(listener);
      if (idx !== -1) this.visibilityListeners.splice(idx, 1);
    };
  }

  /**
   * Get current state
   * @returns {object}
   */
  getState() {
    return {
      isVisible: this.isVisible,
      hiddenSince: this.hiddenSince,
      hiddenDuration: this.hiddenSince ? Date.now() - this.hiddenSince : 0,
      pausedCount: this.paused.size,
      suspendedCount: this.suspendedForVisibility.size
    };
  }

  /**
   * Dispose
   */
  dispose() {
    this._stopSuspendCheck();
    this.visibilityListeners = [];
    this.paused.clear();
    this.suspendedForVisibility.clear();
  }
}

// Singleton
let instance = null;

/**
 * Get VisibilityManager singleton
 * @returns {VisibilityManager}
 */
export function getVisibilityManager() {
  if (!instance) {
    instance = new VisibilityManager();
  }
  return instance;
}
