/**
 * Synthi Extension System - Extension State Machine (FIXED)
 * PHASE A: Formalize the Runtime Contract
 * 
 * CRITICAL: States are now properly separated into:
 * - STABLE states (can be persisted, recovered from)
 * - TRANSIENT states (must complete, never persisted)
 * 
 * The worker only emits events - it NEVER decides state.
 * All state transitions happen here on the main thread.
 */

/**
 * STABLE extension states - these CAN be persisted and recovered
 * @readonly
 * @enum {string}
 */
export const StableState = Object.freeze({
  /** Extension registered but not loaded into worker */
  INSTALLED: 'installed',
  
  /** Extension code loaded into worker memory, ready to activate */
  LOADED: 'loaded',
  
  /** Extension is active and healthy */
  ACTIVE: 'active',
  
  /** Extension manually disabled by user */
  DISABLED: 'disabled',
  
  /** Extension permanently blocked due to repeated failures */
  QUARANTINED: 'quarantined'
});

/**
 * TRANSIENT extension states - these MUST NOT be persisted
 * They always resolve to a stable state
 * @readonly
 * @enum {string}
 */
export const TransientState = Object.freeze({
  /** Extension is currently in activate() - may timeout */
  ACTIVATING: 'activating',
  
  /** Extension is being suspended (cleanup in progress) */
  SUSPENDING: 'suspending',
  
  /** Extension crashed, recovery in progress */
  CRASHING: 'crashing'
});

/**
 * Combined state enum for convenience (stable + transient)
 * @readonly
 * @enum {string}
 */
export const ExtensionState = Object.freeze({
  ...StableState,
  ...TransientState
});

/**
 * Check if a state is stable (can be persisted)
 * @param {string} state
 * @returns {boolean}
 */
export function isStableState(state) {
  return Object.values(StableState).includes(state);
}

/**
 * Check if a state is transient (must not be persisted)
 * @param {string} state
 * @returns {boolean}
 */
export function isTransientState(state) {
  return Object.values(TransientState).includes(state);
}

/**
 * Valid state transitions
 * Key: current state, Value: array of allowed next states
 * 
 * RULES:
 * - CRASHING must always end in ACTIVE or QUARANTINED
 * - Transient states must have timeout handlers
 * - QUARANTINED extensions cannot activate (terminal until user reset)
 */
export const VALID_TRANSITIONS = Object.freeze({
  // Stable states
  [StableState.INSTALLED]: [
    StableState.LOADED,
    StableState.DISABLED
  ],
  
  [StableState.LOADED]: [
    TransientState.ACTIVATING,
    StableState.DISABLED,
    StableState.QUARANTINED // Load reveals critical issues
  ],
  
  [StableState.ACTIVE]: [
    TransientState.SUSPENDING, // Graceful suspend
    TransientState.CRASHING,   // Runtime error
    StableState.DISABLED,      // User disables
    StableState.LOADED         // Deactivation
  ],
  
  [StableState.DISABLED]: [
    StableState.INSTALLED // User re-enables (full reset)
  ],
  
  [StableState.QUARANTINED]: [
    StableState.DISABLED,   // User acknowledges
    StableState.INSTALLED   // User explicitly re-enables (full reset)
  ],
  
  // Transient states - MUST resolve to stable
  [TransientState.ACTIVATING]: [
    StableState.ACTIVE,      // Success
    StableState.QUARANTINED  // Timeout = immediate quarantine
    // NOTE: No CRASHING here - activation timeout is fatal
  ],
  
  [TransientState.SUSPENDING]: [
    StableState.LOADED,      // Successful suspend
    TransientState.CRASHING  // Error during suspend
  ],
  
  [TransientState.CRASHING]: [
    StableState.ACTIVE,      // Recovery successful (reload + reactivate)
    StableState.QUARANTINED  // Too many crashes or unrecoverable
    // RULE: CRASHING must ALWAYS end in ACTIVE or QUARANTINED
  ]
});

/**
 * Transient state timeout configurations
 * If a transient state doesn't resolve within timeout, force resolution
 */
export const TRANSIENT_TIMEOUTS = Object.freeze({
  [TransientState.ACTIVATING]: {
    timeoutMs: 2000,
    forceState: StableState.QUARANTINED,
    reason: 'Activation timeout - likely infinite loop'
  },
  [TransientState.SUSPENDING]: {
    timeoutMs: 1000,
    forceState: StableState.LOADED,
    reason: 'Suspend timeout - forcing unload'
  },
  [TransientState.CRASHING]: {
    timeoutMs: 5000,
    forceState: StableState.QUARANTINED,
    reason: 'Crash recovery timeout - quarantining'
  }
});

/**
 * Failure types that can occur
 * @readonly
 * @enum {string}
 */
export const FailureType = Object.freeze({
  /** activate() exceeded time limit */
  ACTIVATION_TIMEOUT: 'activation_timeout',
  
  /** Runtime exception in extension code */
  RUNTIME_EXCEPTION: 'runtime_exception',
  
  /** Worker died unexpectedly */
  WORKER_DEATH: 'worker_death',
  
  /** Extension sent invalid messages */
  PROTOCOL_VIOLATION: 'protocol_violation',
  
  /** Extension exceeded CPU budget (livelock/tight loop) */
  CPU_LIMIT_EXCEEDED: 'cpu_limit_exceeded',
  
  /** Extension exceeded memory budget */
  MEMORY_LIMIT_EXCEEDED: 'memory_limit_exceeded',
  
  /** Extension sent too many messages */
  MESSAGE_FLOOD: 'message_flood',
  
  /** Extension load/parse failed */
  LOAD_FAILURE: 'load_failure',
  
  /** Heartbeat drift detected (livelock) */
  HEARTBEAT_DRIFT: 'heartbeat_drift',
  
  /** API violation (banned API access) */
  API_VIOLATION: 'api_violation'
});

/**
 * Failure severity levels
 * @readonly
 * @enum {string}
 */
export const FailureSeverity = Object.freeze({
  /** Minor issue, log and continue */
  WARNING: 'warning',
  
  /** Extension should be restarted */
  RECOVERABLE: 'recoverable',
  
  /** Extension should be quarantined immediately */
  FATAL: 'fatal'
});

/**
 * Failure policy rules - what happens for each failure type
 */
export const FAILURE_POLICY = Object.freeze({
  [FailureType.ACTIVATION_TIMEOUT]: {
    severity: FailureSeverity.FATAL,
    action: 'quarantine',
    requiresWorkerRestart: true,
    maxRetries: 0,
    description: 'Activation exceeded hard timeout - likely infinite loop'
  },
  
  [FailureType.RUNTIME_EXCEPTION]: {
    severity: FailureSeverity.RECOVERABLE,
    action: 'crash',
    requiresWorkerRestart: false,
    maxRetries: 2,
    retryDelayMs: 5000,
    windowMs: 600000, // 10 minutes
    description: 'Unhandled exception in extension code'
  },
  
  [FailureType.WORKER_DEATH]: {
    severity: FailureSeverity.RECOVERABLE,
    action: 'crash',
    requiresWorkerRestart: true,
    maxRetries: 1,
    retryDelayMs: 1000,
    description: 'Extension host worker died unexpectedly'
  },
  
  [FailureType.PROTOCOL_VIOLATION]: {
    severity: FailureSeverity.FATAL,
    action: 'quarantine',
    requiresWorkerRestart: false,
    maxRetries: 0,
    description: 'Extension violated message protocol - security concern'
  },
  
  [FailureType.CPU_LIMIT_EXCEEDED]: {
    severity: FailureSeverity.FATAL,
    action: 'quarantine',
    requiresWorkerRestart: true,
    maxRetries: 0,
    description: 'Extension exceeded CPU budget - livelock detected'
  },
  
  [FailureType.MEMORY_LIMIT_EXCEEDED]: {
    severity: FailureSeverity.RECOVERABLE,
    action: 'crash',
    requiresWorkerRestart: true,
    maxRetries: 2,
    retryDelayMs: 30000,
    windowMs: 300000, // 5 minutes
    escalateToQuarantine: true,
    description: 'Extension exceeded memory budget'
  },
  
  [FailureType.MESSAGE_FLOOD]: {
    severity: FailureSeverity.RECOVERABLE,
    action: 'crash',
    requiresWorkerRestart: false,
    maxRetries: 3,
    retryDelayMs: 5000,
    windowMs: 60000,
    escalateToQuarantine: true,
    description: 'Extension sent too many messages'
  },
  
  [FailureType.LOAD_FAILURE]: {
    severity: FailureSeverity.FATAL,
    action: 'quarantine',
    requiresWorkerRestart: false,
    maxRetries: 0,
    description: 'Extension code failed to load/parse'
  },
  
  [FailureType.HEARTBEAT_DRIFT]: {
    severity: FailureSeverity.FATAL,
    action: 'quarantine',
    requiresWorkerRestart: true,
    maxRetries: 0,
    description: 'Worker heartbeat drift detected - CPU hog'
  },
  
  [FailureType.API_VIOLATION]: {
    severity: FailureSeverity.RECOVERABLE,
    action: 'crash',
    requiresWorkerRestart: false,
    maxRetries: 2, // 3 violations = quarantine (0, 1, 2 then fail)
    retryDelayMs: 0,
    windowMs: Infinity, // Violations never expire
    escalateToQuarantine: true,
    description: 'Extension accessed banned API'
  }
});

/**
 * Extension state record - stored for each extension
 * @typedef {Object} ExtensionStateRecord
 * @property {string} extensionId
 * @property {string} state - ONLY stable states should be persisted
 * @property {string|null} previousState
 * @property {number} stateChangedAt - timestamp
 * @property {string|null} transientState - current transient state if any (not persisted)
 * @property {number|null} transientStateStarted - when transient state began
 * @property {string|null} failureReason
 * @property {FailureType|null} failureType
 * @property {Array<{type: FailureType, timestamp: number, reason: string}>} failureHistory
 * @property {number} crashCount
 * @property {number} crashCountWindowStart
 * @property {number} activationAttempts
 * @property {number} lastActivationTime - ms
 * @property {boolean} userDisabled
 * @property {number} apiViolationCount - for API ban enforcement
 * @property {object} manifest
 * @property {string} code
 */

/**
 * Create initial state record for an extension
 * @param {string} extensionId
 * @param {object} manifest
 * @param {string} code
 * @returns {ExtensionStateRecord}
 */
export function createExtensionStateRecord(extensionId, manifest, code) {
  return {
    extensionId,
    state: StableState.INSTALLED,
    previousState: null,
    stateChangedAt: Date.now(),
    transientState: null,
    transientStateStarted: null,
    failureReason: null,
    failureType: null,
    failureHistory: [],
    crashCount: 0,
    crashCountWindowStart: Date.now(),
    activationAttempts: 0,
    lastActivationTime: 0,
    userDisabled: false,
    apiViolationCount: 0,
    manifest,
    code
  };
}

/**
 * Get state for persistence - NEVER returns transient states
 * @param {ExtensionStateRecord} record
 * @returns {string} A stable state
 */
export function getStateForPersistence(record) {
  if (isStableState(record.state)) {
    return record.state;
  }
  
  // If in transient state, return the previous stable state
  if (record.previousState && isStableState(record.previousState)) {
    return record.previousState;
  }
  
  // Fallback - should never happen
  console.error(`[ExtensionState] No stable state for persistence: ${record.extensionId}`);
  return StableState.INSTALLED;
}

/**
 * Check if a state transition is valid
 * @param {string} from
 * @param {string} to
 * @returns {boolean}
 */
export function isValidTransition(from, to) {
  const allowed = VALID_TRANSITIONS[from];
  return allowed ? allowed.includes(to) : false;
}

/**
 * Validate transition and throw if invalid
 * @param {string} from
 * @param {string} to
 * @throws {Error} If transition is invalid
 */
export function assertValidTransition(from, to) {
  if (!isValidTransition(from, to)) {
    throw new Error(
      `Invalid state transition: ${from} → ${to}. ` +
      `Allowed from ${from}: [${(VALID_TRANSITIONS[from] || []).join(', ')}]`
    );
  }
}

/**
 * Get the action to take for a failure
 * @param {FailureType} failureType
 * @param {ExtensionStateRecord} record
 * @returns {{nextState: string, requiresWorkerRestart: boolean, reason: string}}
 */
export function getFailureAction(failureType, record) {
  const policy = FAILURE_POLICY[failureType];
  if (!policy) {
    return {
      nextState: TransientState.CRASHING,
      requiresWorkerRestart: false,
      reason: `Unknown failure type: ${failureType}`
    };
  }

  // Check if within retry window
  const now = Date.now();
  const windowMs = policy.windowMs || 600000;
  
  // Count recent failures of same type
  const recentFailures = record.failureHistory.filter(f => 
    f.type === failureType && (now - f.timestamp) < windowMs
  ).length;

  // FATAL or exceeded retries = quarantine
  if (policy.severity === FailureSeverity.FATAL || recentFailures >= policy.maxRetries) {
    return {
      nextState: StableState.QUARANTINED,
      requiresWorkerRestart: policy.requiresWorkerRestart,
      reason: policy.description
    };
  }

  // Escalate to quarantine if configured
  if (policy.escalateToQuarantine && recentFailures >= policy.maxRetries) {
    return {
      nextState: StableState.QUARANTINED,
      requiresWorkerRestart: policy.requiresWorkerRestart,
      reason: `${policy.description} (${recentFailures + 1} times)`
    };
  }

  // Recoverable - enter CRASHING state for recovery attempt
  return {
    nextState: TransientState.CRASHING,
    requiresWorkerRestart: policy.requiresWorkerRestart,
    reason: policy.description
  };
}

/**
 * Get the resolution for a CRASHING state
 * Called after recovery attempt completes
 * @param {boolean} recoverySuccessful
 * @param {ExtensionStateRecord} record
 * @returns {{nextState: string, reason: string}}
 */
export function resolveCrashingState(recoverySuccessful, record) {
  if (recoverySuccessful) {
    return {
      nextState: StableState.ACTIVE,
      reason: 'Recovery successful'
    };
  }
  
  return {
    nextState: StableState.QUARANTINED,
    reason: 'Recovery failed - quarantining'
  };
}

/**
 * Get human-readable state description
 * @param {string} state
 * @returns {string}
 */
export function getStateDescription(state) {
  const descriptions = {
    [StableState.INSTALLED]: 'Installed',
    [StableState.LOADED]: 'Ready',
    [StableState.ACTIVE]: 'Active',
    [StableState.DISABLED]: 'Disabled',
    [StableState.QUARANTINED]: 'Blocked',
    [TransientState.ACTIVATING]: 'Starting...',
    [TransientState.SUSPENDING]: 'Suspending...',
    [TransientState.CRASHING]: 'Recovering...'
  };
  return descriptions[state] || 'Unknown';
}

/**
 * Check if extension can be activated
 * @param {ExtensionStateRecord} record
 * @returns {{canActivate: boolean, reason: string|null}}
 */
export function canActivate(record) {
  // QUARANTINED cannot activate
  if (record.state === StableState.QUARANTINED) {
    return {
      canActivate: false,
      reason: 'Extension is quarantined and cannot be activated'
    };
  }
  
  // DISABLED cannot activate
  if (record.state === StableState.DISABLED) {
    return {
      canActivate: false,
      reason: 'Extension is disabled'
    };
  }
  
  // Already active
  if (record.state === StableState.ACTIVE) {
    return {
      canActivate: false,
      reason: 'Extension is already active'
    };
  }
  
  // In transient state
  if (isTransientState(record.state)) {
    return {
      canActivate: false,
      reason: `Extension is in transient state: ${record.state}`
    };
  }
  
  // Must be LOADED to activate
  if (record.state !== StableState.LOADED) {
    return {
      canActivate: false,
      reason: `Extension must be in LOADED state, currently: ${record.state}`
    };
  }
  
  return { canActivate: true, reason: null };
}
