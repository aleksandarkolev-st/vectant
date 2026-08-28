'use strict';

const {
  resolveTrustedControlPlaneBaseUrl,
} = require('./codesiteControlPlaneTrust');

const RUNTIME_STATE_TO_KIND = Object.freeze({
  running: 'state_changed',
  ready: 'ready',
  stopped: 'exited',
  crashed: 'crashed',
});

const MAX_PAYLOAD_BYTES = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 3000;

function createRuntimeObservationPublisher({
  fetchImpl = globalThis.fetch,
  authToken = process.env.SYNTHI_CODESITE_TOKEN || '',
  timeoutMs = DEFAULT_TIMEOUT_MS,
  resolveBaseUrl = resolveTrustedControlPlaneBaseUrl,
  logger = console,
} = {}) {
  const state = {
    published: 0,
    failed: 0,
    lastError: null,
    lastPublishedAt: null,
  };

  function configured() {
    return Boolean(authToken) && typeof fetchImpl === 'function';
  }

  async function publish(workspaceSlug, projectId, payload) {
    if (!configured()) {
      state.failed += 1;
      state.lastError = 'runtime_observation_publisher_unconfigured';
      return false;
    }
    const body = JSON.stringify(payload);
    if (Buffer.byteLength(body, 'utf8') > MAX_PAYLOAD_BYTES) {
      state.failed += 1;
      state.lastError = 'runtime_observation_payload_too_large';
      return false;
    }
    const baseUrl = resolveBaseUrl(null, workspaceSlug);
    if (!baseUrl) {
      state.failed += 1;
      state.lastError = 'runtime_observation_control_plane_unconfigured';
      return false;
    }
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchImpl(`${baseUrl}/api/workspace/${encodeURIComponent(workspaceSlug)}/codesite/projects/${encodeURIComponent(projectId)}/observations`, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          authorization: `Bearer ${authToken}`,
          'content-type': 'application/json',
        },
        body,
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response?.ok) {
        state.failed += 1;
        state.lastError = `control_plane_status_${response ? response.status : 'unknown'}`;
        return false;
      }
      state.published += 1;
      state.lastError = null;
      state.lastPublishedAt = new Date().toISOString();
      return true;
    } catch (error) {
      state.failed += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      return false;
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  /**
   * Maps a managed-runtime lifecycle transition onto a normalized project
   * observation. Returns null for transitions that carry no coordination
   * value. Never includes process output or command text.
   */
  function buildObservationPayload({ producerKind, producerEventId, occurredAt, runtimeSessionId, projectId, state: runtimeState, exitCode, stopReason, ports, healthState }) {
    const observationKind = RUNTIME_STATE_TO_KIND[String(runtimeState || '').toLowerCase()] || null;
    if (!observationKind) return null;
    const fact = { observationKind };
    if (runtimeState != null) fact.runtimeState = String(runtimeState);
    if (exitCode != null && Number.isFinite(Number(exitCode))) fact.exitCode = Math.trunc(Number(exitCode));
    if (healthState != null) fact.healthState = String(healthState);
    if (Array.isArray(ports) && ports.length) {
      fact.ports = [...new Set(ports.map((port) => Math.trunc(Number(port))).filter((port) => port >= 1 && port <= 65535))].sort((a, b) => a - b);
    }
    if (stopReason) fact.reasonCodes = [`stop_reason_${String(stopReason).replace(/[^a-z0-9_]/gi, '_')}`];
    return {
      eventType: 'runtime_observed',
      projectId,
      producer: { kind: producerKind, eventId: `${runtimeSessionId}:${producerEventId}` },
      occurredAt: occurredAt || new Date().toISOString(),
      refs: {
        runtimeSessionIds: [runtimeSessionId].filter(Boolean),
        ...(fact.ports ? {} : {}),
      },
      providerSessionBound: false,
      evidenceRefs: [],
      fact,
    };
  }

  /**
   * Entry point wired into the program runtime manager's event stream.
   * Publishes only events that carry a CodeSite project binding; everything
   * else is ignored silently so unmanaged runtimes never leak observations.
   */
  async function handleRuntimeEvent(event = {}) {
    const session = event?.session || {};
    const projectId = session.projectId;
    const workspaceSlug = session.workspaceSlug;
    if (!projectId || !workspaceSlug) return false;
    const payload = buildObservationPayload({
      producerKind: 'program_runtime_adapter',
      producerEventId: `${event.type}:${event.createdAt}`,
      occurredAt: event.createdAt,
      runtimeSessionId: session.sessionId,
      projectId,
      state: event.data?.state || session.state,
      exitCode: event.data?.exitCode ?? session.exitCode,
      stopReason: event.data?.stopReason ?? session.stopReason,
      ports: event.type === 'ports_updated' ? (event.data?.ports || session.activePorts) : undefined,
      healthState: event.type === 'health_changed' ? (event.data?.healthState ?? session.healthState) : undefined,
    });
    if (!payload) return false;
    return publish(workspaceSlug, projectId, payload);
  }

  async function reportHealth() {
    return {
      ok: state.failed === 0 || state.published > 0,
      code: state.lastError || (state.published > 0 ? 'publishing' : (configured() ? 'idle' : 'unconfigured')),
      published: state.published,
      failed: state.failed,
      lastPublishedAt: state.lastPublishedAt,
    };
  }

  return Object.freeze({ publish, buildObservationPayload, handleRuntimeEvent, reportHealth, configured });
}

module.exports = {
  createRuntimeObservationPublisher,
};
