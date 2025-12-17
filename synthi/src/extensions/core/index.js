/**
 * Synthi Extension System - Core Module
 * Complete Implementation: Phases A through G
 * 
 * This module contains:
 * - Authoritative state management (Phase A)
 * - Hardened execution boundary (Phase B)
 * - VSIX compatibility control (Phase C)
 * - Observability / Inspector (Phase D)
 * - Livelock detection (Fix #2)
 * - Cross-extension isolation (Fix #5)
 * - Restart fences (Fix #6)
 * - Runtime API enforcement (Fix #3)
 * - Async observability store (Fix #4)
 */

// State Machine (Phase A - FIXED)
export {
  ExtensionState,
  StableState,
  TransientState,
  FailureType,
  FailureSeverity,
  VALID_TRANSITIONS,
  TRANSIENT_TIMEOUTS,
  FAILURE_POLICY,
  createExtensionStateRecord,
  isValidTransition,
  assertValidTransition,
  isStableState,
  isTransientState,
  getStateForPersistence,
  getFailureAction,
  resolveCrashingState,
  getStateDescription,
  canActivate
} from './ExtensionState.js';

// State Reducer (Phase A)
export {
  ExtensionStateReducer,
  ActionType,
  createAction,
  createInitialState,
  getExtensionStateReducer,
  createExtensionStateReducer
} from './ExtensionStateReducer.js';

// Extension Manager (Phase A+B)
export {
  ExtensionManager,
  getExtensionManager,
  createExtensionManager
} from './ExtensionManager.js';

// VSIX Compatibility Classifier (Phase C)
export {
  CompatibilityLevel,
  VSIXCompatibilityClassifier,
  quickCompatibilityCheck,
  getVSIXClassifier
} from './VSIXCompatibility.js';

// Extension Inspector (Phase D)
export {
  ExtensionInspector,
  getExtensionInspector,
  createExtensionInspector
} from './ExtensionInspector.js';

// Error Reporter (Phase F)
export {
  ExtensionErrorReporter,
  getErrorReporter,
  createErrorReporter
} from './ErrorReporter.js';

// Frozen API Contract (Phase C)
export {
  FROZEN_API_V1,
  checkAPISupport,
  generateAPIDocumentation
} from './FrozenAPI.js';

// Livelock Detection (Fix #2)
export {
  LivelockDetector,
  ExtensionCPUTracker,
  getLivelockDetector,
  getCPUTracker
} from './LivelockDetector.js';

// Async Observability Store (Fix #4)
export {
  ObservabilityStore,
  getObservabilityStore,
  createObservabilityStore
} from './ObservabilityStore.js';

// Cross-Extension Isolation (Fix #5)
export {
  FairScheduler,
  getFairScheduler,
  createFairScheduler
} from './CrossExtensionIsolation.js';

// Restart Fence (Fix #6)
export {
  RestartFence,
  WorkerState,
  RejectionReason,
  getRestartFence,
  createRestartFence
} from './RestartFence.js';

// Runtime API Enforcer (Fix #3)
export {
  RuntimeAPIEnforcer,
  APISupport,
  getRuntimeAPIEnforcer,
  createRuntimeAPIEnforcer
} from './RuntimeAPIEnforcer.js';
