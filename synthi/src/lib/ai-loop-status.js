// ============================================================
// ai-loop-status.js
// ============================================================
// Frontend store for AI (Loop B) status — tracks circuit state,
// cost budget, fallback progress, and individual request status.
// ============================================================

/**
 * @typedef {'closed'|'open'|'half-open'} CircuitState
 * @typedef {'idle'|'pending'|'success'|'failed'|'timeout'|'blocked'} AiRequestPhase
 */

/**
 * @typedef {Object} AiLoopStatus
 * @property {CircuitState} circuitState
 * @property {AiRequestPhase} requestPhase
 * @property {string|null} activeRequestId
 * @property {number} totalRequests
 * @property {number} totalTokens
 * @property {number} estimatedCostUsd
 * @property {number} budgetUsedPercent - 0..100
 * @property {string|null} currentFallbackLevel
 * @property {number} fallbacksRemaining
 * @property {number} consecutiveFailures
 * @property {number} updatedAt - epoch ms
 */

/** @type {AiLoopStatus} */
let _status = {
  circuitState: 'closed',
  requestPhase: 'idle',
  activeRequestId: null,
  totalRequests: 0,
  totalTokens: 0,
  estimatedCostUsd: 0,
  budgetUsedPercent: 0,
  currentFallbackLevel: null,
  fallbacksRemaining: 0,
  consecutiveFailures: 0,
  updatedAt: 0,
};

/** @type {Set<(status: AiLoopStatus) => void>} */
const _listeners = new Set();

function _notify() {
  const snap = { ..._status };
  for (const fn of _listeners) {
    try { fn(snap); } catch (_) { /* swallow */ }
  }
}

/**
 * Get current AI loop status.
 * @returns {AiLoopStatus}
 */
export function getAiLoopStatus() {
  return { ..._status };
}

/**
 * Subscribe to AI loop status changes.
 * @param {(status: AiLoopStatus) => void} fn
 * @returns {() => void}
 */
export function subscribeAiLoopStatus(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}

/**
 * Update status fields.
 * @param {Partial<AiLoopStatus>} update
 */
export function updateAiLoopStatus(update) {
  _status = { ..._status, ...update, updatedAt: Date.now() };
  _notify();
}

/**
 * Handle AI status notification from WebRTC data channel.
 * @param {Object} notification
 */
export function handleAiStatusNotification(notification) {
  if (!notification || !notification.type) return;

  const eventType = notification.type === 'ai_status'
    ? notification.ai_type || notification.type
    : notification.type;

  switch (eventType) {
    case 'request_started':
    case 'ai_request_started':
      updateAiLoopStatus({
        requestPhase: 'pending',
        activeRequestId: notification.request_id || null,
      });
      break;

    case 'request_success':
    case 'ai_request_success':
      updateAiLoopStatus({
        requestPhase: 'success',
        totalRequests: (_status.totalRequests || 0) + 1,
        totalTokens: (_status.totalTokens || 0) + (notification.tokens_used || 0),
        estimatedCostUsd: notification.estimated_cost || _status.estimatedCostUsd,
        budgetUsedPercent: notification.budget_used_percent || _status.budgetUsedPercent,
        consecutiveFailures: 0,
      });
      break;

    case 'request_failed':
    case 'failed':
    case 'ai_request_failed':
      updateAiLoopStatus({
        requestPhase: 'failed',
        consecutiveFailures: (_status.consecutiveFailures || 0) + 1,
      });
      break;

    case 'request_timeout':
    case 'timeout':
    case 'ai_request_timeout':
      updateAiLoopStatus({
        requestPhase: 'timeout',
        consecutiveFailures: (_status.consecutiveFailures || 0) + 1,
      });
      break;

    case 'circuit_changed':
    case 'ai_circuit_changed':
      updateAiLoopStatus({
        circuitState: notification.state || 'closed',
      });
      break;

    case 'fallback_progress':
    case 'ai_fallback_progress':
      updateAiLoopStatus({
        currentFallbackLevel: notification.level || null,
        fallbacksRemaining: notification.remaining || 0,
      });
      break;

    case 'blocked':
    case 'ai_blocked':
      updateAiLoopStatus({
        requestPhase: 'blocked',
        circuitState: 'open',
      });
      break;

    default:
      break;
  }
}

/**
 * Install window event listener for AI status events.
 * @returns {() => void} cleanup
 */
export function installAiStatusListener() {
  /** @param {CustomEvent} e */
  function handler(e) {
    const payload = e.detail?.data || e.detail;
    if (payload) {
      handleAiStatusNotification(payload);
    }
  }
  window.addEventListener('synthi:ai-status', handler);
  return () => window.removeEventListener('synthi:ai-status', handler);
}
