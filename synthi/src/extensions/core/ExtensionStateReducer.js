/**
 * Synthi Extension System - Extension State Reducer
 * PHASE A: Single Authoritative State Manager
 * 
 * This is the SINGLE place where extension state changes.
 * All state is managed here on the main thread.
 * Worker only emits events that trigger state transitions.
 */

import {
  ExtensionState,
  FailureType,
  isValidTransition,
  getFailureAction,
  createExtensionStateRecord,
  getStateDescription,
  FAILURE_POLICY
} from './ExtensionState.js';

/**
 * Action types for the reducer
 * @readonly
 * @enum {string}
 */
export const ActionType = Object.freeze({
  // Lifecycle actions
  REGISTER: 'REGISTER',
  LOAD_START: 'LOAD_START',
  LOAD_SUCCESS: 'LOAD_SUCCESS',
  LOAD_FAILURE: 'LOAD_FAILURE',
  ACTIVATE_START: 'ACTIVATE_START',
  ACTIVATE_SUCCESS: 'ACTIVATE_SUCCESS',
  ACTIVATE_FAILURE: 'ACTIVATE_FAILURE',
  DEACTIVATE: 'DEACTIVATE',
  
  // Failure actions
  REPORT_FAILURE: 'REPORT_FAILURE',
  REPORT_CRASH: 'REPORT_CRASH',
  
  // Recovery actions
  SUSPEND: 'SUSPEND',
  RESUME: 'RESUME',
  QUARANTINE: 'QUARANTINE',
  
  // User actions
  DISABLE: 'DISABLE',
  ENABLE: 'ENABLE',
  RESET: 'RESET', // Full reset after quarantine
  
  // Worker lifecycle
  WORKER_DIED: 'WORKER_DIED',
  WORKER_RESTARTED: 'WORKER_RESTARTED',
  
  // Cleanup
  UNREGISTER: 'UNREGISTER',
  CLEAR_FAILURE_HISTORY: 'CLEAR_FAILURE_HISTORY'
});

/**
 * Create an action
 * @param {ActionType} type
 * @param {string} extensionId
 * @param {object} [payload]
 * @returns {{type: ActionType, extensionId: string, payload?: object, timestamp: number}}
 */
export function createAction(type, extensionId, payload = {}) {
  return {
    type,
    extensionId,
    payload,
    timestamp: Date.now()
  };
}

/**
 * @typedef {Object} ExtensionSystemState
 * @property {Map<string, import('./ExtensionState.js').ExtensionStateRecord>} extensions
 * @property {number} workerGeneration
 * @property {'running'|'restarting'|'dead'} workerStatus
 * @property {Array<{type: ActionType, extensionId: string, timestamp: number}>} actionLog
 * @property {Set<string>} quarantinedIds
 */

/**
 * Create initial system state
 * @returns {ExtensionSystemState}
 */
export function createInitialState() {
  return {
    extensions: new Map(),
    workerGeneration: 0,
    workerStatus: 'running',
    actionLog: [],
    quarantinedIds: new Set()
  };
}

/**
 * Extension State Reducer - THE authoritative state manager
 * 
 * Rules:
 * 1. State transitions must be valid according to VALID_TRANSITIONS
 * 2. Invalid transitions are logged but rejected
 * 3. Worker events only trigger actions, never directly change state
 * 4. All failure handling follows FAILURE_POLICY
 */
export class ExtensionStateReducer {
  constructor() {
    /** @type {ExtensionSystemState} */
    this.state = createInitialState();
    
    /** @type {Array<(state: ExtensionSystemState, action: any) => void>} */
    this.listeners = [];
    
    /** @type {boolean} */
    this.debugMode = false;
    
    /** @type {number} Max action log entries */
    this.maxActionLogSize = 1000;
  }

  /**
   * Get current state (immutable view)
   * @returns {ExtensionSystemState}
   */
  getState() {
    return this.state;
  }

  /**
   * Get extension record
   * @param {string} extensionId
   * @returns {import('./ExtensionState.js').ExtensionStateRecord|undefined}
   */
  getExtension(extensionId) {
    return this.state.extensions.get(extensionId);
  }

  /**
   * Get all extensions
   * @returns {Array<import('./ExtensionState.js').ExtensionStateRecord>}
   */
  getAllExtensions() {
    return Array.from(this.state.extensions.values());
  }

  /**
   * Get extensions by state
   * @param {ExtensionState} state
   * @returns {Array<import('./ExtensionState.js').ExtensionStateRecord>}
   */
  getExtensionsByState(state) {
    return this.getAllExtensions().filter(e => e.state === state);
  }

  /**
   * Check if extension can be activated
   * @param {string} extensionId
   * @returns {{canActivate: boolean, reason?: string}}
   */
  canActivate(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) {
      return { canActivate: false, reason: 'Extension not found' };
    }

    if (ext.state === ExtensionState.QUARANTINED) {
      return { canActivate: false, reason: `Extension quarantined: ${ext.failureReason}` };
    }

    if (ext.state === ExtensionState.DISABLED) {
      return { canActivate: false, reason: 'Extension disabled by user' };
    }

    if (ext.state === ExtensionState.ACTIVE) {
      return { canActivate: false, reason: 'Already active' };
    }

    if (ext.state === ExtensionState.ACTIVATING) {
      return { canActivate: false, reason: 'Already activating' };
    }

    if (!isValidTransition(ext.state, ExtensionState.ACTIVATING)) {
      return { canActivate: false, reason: `Invalid state for activation: ${ext.state}` };
    }

    return { canActivate: true };
  }

  /**
   * Dispatch an action to update state
   * @param {object} action
   * @returns {{success: boolean, newState?: ExtensionState, error?: string, requiresWorkerRestart?: boolean}}
   */
  dispatch(action) {
    const { type, extensionId, payload, timestamp } = action;
    
    // Log action
    this._logAction(action);
    
    if (this.debugMode) {
      console.log(`[StateReducer] ${type}(${extensionId})`, payload);
    }

    let result;
    
    switch (type) {
      case ActionType.REGISTER:
        result = this._handleRegister(extensionId, payload);
        break;
        
      case ActionType.LOAD_START:
        result = this._handleLoadStart(extensionId);
        break;
        
      case ActionType.LOAD_SUCCESS:
        result = this._handleLoadSuccess(extensionId);
        break;
        
      case ActionType.LOAD_FAILURE:
        result = this._handleLoadFailure(extensionId, payload);
        break;
        
      case ActionType.ACTIVATE_START:
        result = this._handleActivateStart(extensionId);
        break;
        
      case ActionType.ACTIVATE_SUCCESS:
        result = this._handleActivateSuccess(extensionId, payload);
        break;
        
      case ActionType.ACTIVATE_FAILURE:
        result = this._handleActivateFailure(extensionId, payload);
        break;
        
      case ActionType.DEACTIVATE:
        result = this._handleDeactivate(extensionId);
        break;
        
      case ActionType.REPORT_FAILURE:
        result = this._handleReportFailure(extensionId, payload);
        break;
        
      case ActionType.SUSPEND:
        result = this._handleSuspend(extensionId, payload);
        break;
        
      case ActionType.RESUME:
        result = this._handleResume(extensionId);
        break;
        
      case ActionType.QUARANTINE:
        result = this._handleQuarantine(extensionId, payload);
        break;
        
      case ActionType.DISABLE:
        result = this._handleDisable(extensionId);
        break;
        
      case ActionType.ENABLE:
        result = this._handleEnable(extensionId);
        break;
        
      case ActionType.RESET:
        result = this._handleReset(extensionId);
        break;
        
      case ActionType.WORKER_DIED:
        result = this._handleWorkerDied(payload);
        break;
        
      case ActionType.WORKER_RESTARTED:
        result = this._handleWorkerRestarted();
        break;
        
      case ActionType.UNREGISTER:
        result = this._handleUnregister(extensionId);
        break;
        
      case ActionType.CLEAR_FAILURE_HISTORY:
        result = this._handleClearFailureHistory(extensionId);
        break;
        
      default:
        result = { success: false, error: `Unknown action type: ${type}` };
    }

    // Notify listeners
    if (result.success) {
      this._notifyListeners(action);
    }

    return result;
  }

  /**
   * Subscribe to state changes
   * @param {(state: ExtensionSystemState, action: any) => void} listener
   * @returns {() => void} Unsubscribe function
   */
  subscribe(listener) {
    this.listeners.push(listener);
    return () => {
      const idx = this.listeners.indexOf(listener);
      if (idx !== -1) this.listeners.splice(idx, 1);
    };
  }

  // =========================================================================
  // Action Handlers
  // =========================================================================

  _handleRegister(extensionId, payload) {
    if (this.state.extensions.has(extensionId)) {
      return { success: false, error: 'Extension already registered' };
    }

    const { manifest, code } = payload;
    const record = createExtensionStateRecord(extensionId, manifest, code);
    this.state.extensions.set(extensionId, record);
    
    return { success: true, newState: ExtensionState.INSTALLED };
  }

  _handleLoadStart(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };
    
    // Loading is implicit - we go directly to LOADED on success
    return { success: true };
  }

  _handleLoadSuccess(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    if (!isValidTransition(ext.state, ExtensionState.LOADED)) {
      return { success: false, error: `Invalid transition: ${ext.state} -> LOADED` };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.LOADED;
    ext.stateChangedAt = Date.now();
    
    return { success: true, newState: ExtensionState.LOADED };
  }

  _handleLoadFailure(extensionId, payload) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    const { reason } = payload;
    
    // Load failure is fatal
    ext.previousState = ext.state;
    ext.state = ExtensionState.QUARANTINED;
    ext.stateChangedAt = Date.now();
    ext.failureReason = reason || 'Load failure';
    ext.failureType = FailureType.LOAD_FAILURE;
    ext.failureHistory.push({
      type: FailureType.LOAD_FAILURE,
      timestamp: Date.now(),
      reason: reason || 'Load failure'
    });
    
    this.state.quarantinedIds.add(extensionId);
    
    return { success: true, newState: ExtensionState.QUARANTINED };
  }

  _handleActivateStart(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    if (!isValidTransition(ext.state, ExtensionState.ACTIVATING)) {
      return { success: false, error: `Invalid transition: ${ext.state} -> ACTIVATING` };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.ACTIVATING;
    ext.stateChangedAt = Date.now();
    ext.activationAttempts++;
    
    return { success: true, newState: ExtensionState.ACTIVATING };
  }

  _handleActivateSuccess(extensionId, payload) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    if (!isValidTransition(ext.state, ExtensionState.ACTIVE)) {
      return { success: false, error: `Invalid transition: ${ext.state} -> ACTIVE` };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.ACTIVE;
    ext.stateChangedAt = Date.now();
    ext.lastActivationTime = payload?.activationTime || 0;
    ext.failureReason = null;
    ext.failureType = null;
    
    return { success: true, newState: ExtensionState.ACTIVE };
  }

  _handleActivateFailure(extensionId, payload) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    const { reason, failureType = FailureType.ACTIVATION_TIMEOUT } = payload;
    
    // Record failure
    ext.failureHistory.push({
      type: failureType,
      timestamp: Date.now(),
      reason: reason || 'Activation failed'
    });

    // Get policy action
    const action = getFailureAction(failureType, ext);
    
    ext.previousState = ext.state;
    ext.state = action.nextState;
    ext.stateChangedAt = Date.now();
    ext.failureReason = action.reason;
    ext.failureType = failureType;

    if (action.nextState === ExtensionState.QUARANTINED) {
      this.state.quarantinedIds.add(extensionId);
    }

    return {
      success: true,
      newState: action.nextState,
      requiresWorkerRestart: action.requiresWorkerRestart
    };
  }

  _handleDeactivate(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    if (!isValidTransition(ext.state, ExtensionState.LOADED)) {
      return { success: false, error: `Invalid transition: ${ext.state} -> LOADED` };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.LOADED;
    ext.stateChangedAt = Date.now();
    
    return { success: true, newState: ExtensionState.LOADED };
  }

  _handleReportFailure(extensionId, payload) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    const { failureType, reason } = payload;
    
    // Record failure
    ext.failureHistory.push({
      type: failureType,
      timestamp: Date.now(),
      reason: reason || 'Unknown failure'
    });

    // Get policy action
    const action = getFailureAction(failureType, ext);

    // Check if state change is valid
    if (!isValidTransition(ext.state, action.nextState)) {
      // Log but don't change state if transition invalid
      console.warn(`[StateReducer] Invalid transition ${ext.state} -> ${action.nextState} for ${extensionId}`);
      return { success: true, newState: ext.state };
    }

    ext.previousState = ext.state;
    ext.state = action.nextState;
    ext.stateChangedAt = Date.now();
    ext.failureReason = action.reason;
    ext.failureType = failureType;

    if (action.nextState === ExtensionState.QUARANTINED) {
      this.state.quarantinedIds.add(extensionId);
    }

    return {
      success: true,
      newState: action.nextState,
      requiresWorkerRestart: action.requiresWorkerRestart
    };
  }

  _handleSuspend(extensionId, payload) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    if (!isValidTransition(ext.state, ExtensionState.SUSPENDED)) {
      return { success: false, error: `Invalid transition: ${ext.state} -> SUSPENDED` };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.SUSPENDED;
    ext.stateChangedAt = Date.now();
    if (payload?.reason) {
      ext.failureReason = payload.reason;
    }
    
    return { success: true, newState: ExtensionState.SUSPENDED };
  }

  _handleResume(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    if (!isValidTransition(ext.state, ExtensionState.ACTIVE)) {
      return { success: false, error: `Invalid transition: ${ext.state} -> ACTIVE` };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.ACTIVE;
    ext.stateChangedAt = Date.now();
    
    return { success: true, newState: ExtensionState.ACTIVE };
  }

  _handleQuarantine(extensionId, payload) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    // Quarantine is always allowed from any state except DISABLED
    if (ext.state === ExtensionState.DISABLED) {
      return { success: false, error: 'Cannot quarantine disabled extension' };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.QUARANTINED;
    ext.stateChangedAt = Date.now();
    ext.failureReason = payload?.reason || 'Manually quarantined';
    
    this.state.quarantinedIds.add(extensionId);
    
    return { success: true, newState: ExtensionState.QUARANTINED };
  }

  _handleDisable(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    ext.previousState = ext.state;
    ext.state = ExtensionState.DISABLED;
    ext.stateChangedAt = Date.now();
    ext.userDisabled = true;
    
    this.state.quarantinedIds.delete(extensionId);
    
    return { success: true, newState: ExtensionState.DISABLED };
  }

  _handleEnable(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    if (ext.state !== ExtensionState.DISABLED) {
      return { success: false, error: 'Extension not disabled' };
    }

    ext.previousState = ext.state;
    ext.state = ExtensionState.INSTALLED;
    ext.stateChangedAt = Date.now();
    ext.userDisabled = false;
    
    return { success: true, newState: ExtensionState.INSTALLED };
  }

  _handleReset(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    // Full reset - clear all failure state
    ext.previousState = ext.state;
    ext.state = ExtensionState.INSTALLED;
    ext.stateChangedAt = Date.now();
    ext.failureReason = null;
    ext.failureType = null;
    ext.failureHistory = [];
    ext.crashCount = 0;
    ext.crashCountWindowStart = Date.now();
    ext.activationAttempts = 0;
    ext.userDisabled = false;
    
    this.state.quarantinedIds.delete(extensionId);
    
    return { success: true, newState: ExtensionState.INSTALLED };
  }

  _handleWorkerDied(payload) {
    this.state.workerStatus = 'dead';
    this.state.workerGeneration++;

    // Mark all activating extensions as crashed
    for (const ext of this.state.extensions.values()) {
      if (ext.state === ExtensionState.ACTIVATING) {
        ext.previousState = ext.state;
        ext.state = ExtensionState.CRASHED;
        ext.stateChangedAt = Date.now();
        ext.failureReason = 'Worker died during activation';
        ext.failureType = FailureType.WORKER_DEATH;
        ext.failureHistory.push({
          type: FailureType.WORKER_DEATH,
          timestamp: Date.now(),
          reason: 'Worker died during activation'
        });
      }
    }

    return { success: true };
  }

  _handleWorkerRestarted() {
    this.state.workerStatus = 'running';
    
    // All non-quarantined/disabled extensions go back to INSTALLED
    // (They need to be reloaded)
    for (const ext of this.state.extensions.values()) {
      if (ext.state !== ExtensionState.QUARANTINED && 
          ext.state !== ExtensionState.DISABLED) {
        ext.previousState = ext.state;
        ext.state = ExtensionState.INSTALLED;
        ext.stateChangedAt = Date.now();
      }
    }

    return { success: true };
  }

  _handleUnregister(extensionId) {
    if (!this.state.extensions.has(extensionId)) {
      return { success: false, error: 'Extension not found' };
    }

    this.state.extensions.delete(extensionId);
    this.state.quarantinedIds.delete(extensionId);
    
    return { success: true };
  }

  _handleClearFailureHistory(extensionId) {
    const ext = this.getExtension(extensionId);
    if (!ext) return { success: false, error: 'Extension not found' };

    ext.failureHistory = [];
    ext.crashCount = 0;
    ext.crashCountWindowStart = Date.now();
    
    return { success: true };
  }

  // =========================================================================
  // Internal Helpers
  // =========================================================================

  _logAction(action) {
    this.state.actionLog.push({
      type: action.type,
      extensionId: action.extensionId,
      timestamp: action.timestamp
    });

    // Trim log if too large
    if (this.state.actionLog.length > this.maxActionLogSize) {
      this.state.actionLog = this.state.actionLog.slice(-this.maxActionLogSize / 2);
    }
  }

  _notifyListeners(action) {
    for (const listener of this.listeners) {
      try {
        listener(this.state, action);
      } catch (err) {
        console.error('[StateReducer] Listener error:', err);
      }
    }
  }

  /**
   * Export state for debugging/persistence
   * @returns {object}
   */
  exportState() {
    return {
      extensions: Array.from(this.state.extensions.entries()).map(([id, ext]) => ({
        ...ext,
        // Don't export code in debug view
        code: `[${ext.code?.length || 0} chars]`
      })),
      workerGeneration: this.state.workerGeneration,
      workerStatus: this.state.workerStatus,
      quarantinedIds: Array.from(this.state.quarantinedIds),
      actionLogLength: this.state.actionLog.length
    };
  }
}

// Singleton
let instance = null;

/**
 * Get the singleton ExtensionStateReducer
 * @returns {ExtensionStateReducer}
 */
export function getExtensionStateReducer() {
  if (!instance) {
    instance = new ExtensionStateReducer();
  }
  return instance;
}

/**
 * Create a new ExtensionStateReducer (for testing)
 * @returns {ExtensionStateReducer}
 */
export function createExtensionStateReducer() {
  return new ExtensionStateReducer();
}
