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
   * NOTE: Pausing/suspending extensions on tab hide is disabled.
   * In an IDE, extensions must keep running (LSP, formatters, linters)
   * even when the user switches tabs.
   */
  _onHidden() {
    console.log('[VisibilityManager] Tab hidden - extensions continue running');
    // Do NOT pause or suspend extensions — they need to stay active
    // for LSP, file watchers, and other background tasks.
  }

  /**
   * Handle becoming visible
   */
  _onVisible() {
    console.log('[VisibilityManager] Tab visible');
    
    // Stop suspend checking (should already be stopped, but be safe)
    this._stopSuspendCheck();
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
   * NOTE: Disabled — extensions must keep running in background.
   */
  _suspendAll() {
    // Intentionally empty — IDE extensions should never be suspended
    // due to tab visibility changes.
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
    // Do NOT pause extensions on register even if tab is hidden.
    // Extensions must remain active for background tasks (LSP, etc.).
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
