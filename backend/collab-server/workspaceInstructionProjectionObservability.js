'use strict';

/**
 * Small in-process operational view for passive instruction projection.
 * It intentionally records identifiers, outcomes, and timings only: managed
 * instruction bodies and terminal file text must never become telemetry.
 */

function safeDetails(details = {}) {
  const result = {};
  for (const [key, value] of Object.entries(details || {})) {
    if (/content|block|instruction.*text/i.test(key)) continue;
    if (value == null || ['string', 'number', 'boolean'].includes(typeof value)) result[key] = value;
  }
  return result;
}

function createWorkspaceInstructionProjectionObservability({ logger = null, now = () => Date.now() } = {}) {
  const events = new Map();
  const failures = new Map();
  let lastEventAt = null;

  function record(event, details = {}) {
    const name = String(event || 'workspace_instruction_projection_unknown');
    const safe = safeDetails(details);
    events.set(name, (events.get(name) || 0) + 1);
    if (/failed|error|conflict|unavailable/i.test(name)) {
      const reason = String(safe.reason || safe.code || safe.message || name);
      failures.set(reason, (failures.get(reason) || 0) + 1);
    }
    lastEventAt = now();
    try { logger?.info?.(name, safe); } catch (_) { /* observability is non-fatal */ }
  }

  return Object.freeze({
    record,
    snapshot() {
      return Object.freeze({
        events: Object.freeze(Object.fromEntries(events)),
        failures: Object.freeze(Object.fromEntries(failures)),
        lastEventAt,
      });
    },
  });
}

module.exports = {
  createWorkspaceInstructionProjectionObservability,
  safeDetails,
};
