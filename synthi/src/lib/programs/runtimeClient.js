import { parseProgramManifest } from './manifest';
import { importDevcontainer } from './devcontainer';
import { detectRepoProgram } from './repoDetect';
import { withInternalAiAuth } from '@/lib/internalAiAuth';

const COLLAB_BASE = (process.env.COLLAB_SERVER_URL || process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234').replace(/\/$/, '');

async function parseJsonResponse(response) {
  const text = await response.text().catch(() => '');
  if (!text) {
    return {};
  }

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

async function requestJson(path, options = {}) {
  const response = await fetch(`${COLLAB_BASE}${path}`, {
    ...options,
    headers: {
      ...withInternalAiAuth({ 'Content-Type': 'application/json' }),
      ...(options.headers || {}),
    },
  });
  const payload = await parseJsonResponse(response);

  if (!response.ok) {
    const error = new Error(payload.error || `Collab runtime request failed (${response.status})`);
    error.status = response.status;
    error.payload = payload;
    throw error;
  }

  return payload;
}

export async function listProgramRuntimeSessions(workspaceSlug) {
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/sessions`);
  return data.sessions || [];
}

export async function getProgramRuntimeSession(workspaceSlug, sessionId) {
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}`);
  return data.session || null;
}

export async function launchProgramRuntime({ workspaceSlug, sessionId, command, userId, title = null, timeout = 60000, env = {}, codeSiteContext = null }) {
  const launch = await requestJson(`/exec-terminal/${encodeURIComponent(workspaceSlug)}`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, command, userId, name: title, timeout, env, codeSiteContext }),
  });
  const runtimeSession = await getProgramRuntimeSession(workspaceSlug, sessionId).catch(() => null);
  return {
    ...launch,
    runtimeSession,
  };
}

/**
 * One-shot command exec inside the workspace's Sysbox runtime pod (where the
 * workspace's own dockerd lives). Routed by workspaceSlug → runtimeScope on the
 * collab-server (never a user id). Returns the collab response verbatim:
 * `{ runtimeScope, stdout, stderr, exitCode, timedOut }`. Throws with
 * `error.status === 409` (`runtime_pod_not_ready`) when no runtime pod is ready.
 */
export async function execInWorkspaceRuntime(workspaceSlug, { command, timeout, codeSiteContext = null } = {}) {
  return requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/exec`, {
    method: 'POST',
    body: JSON.stringify({ command, ...(timeout != null ? { timeout } : {}), codeSiteContext }),
  });
}

export async function stopProgramRuntimeSession(workspaceSlug, sessionId) {
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  });
  return data.session || null;
}

export async function restartProgramRuntimeSession(workspaceSlug, sessionId) {
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}/restart`, {
    method: 'POST',
  });
  return data.session || null;
}

export async function listProgramRuntimeSessionEvents(workspaceSlug, sessionId) {
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/sessions/${encodeURIComponent(sessionId)}/events`);
  return data.events || [];
}

/**
 * Discover a recipe manifest in the workspace (vectant.programs.json preferred,
 * else .devcontainer/devcontainer.json) and parse it into a NormalizedProgramConfig.
 *
 * @returns {Promise<{ config: object, source: string } | null>}
 */
export async function discoverManifest(workspaceSlug, userId = '') {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/manifest${query}`);
  if (!data || !data.found || !data.raw) {
    return null;
  }
  if (data.source === 'devcontainer.json') {
    // Slice 1: when the collab-server reports a container runtime is available,
    // a devcontainer with an image/build becomes a real `container` program;
    // otherwise it stays a managed-command recipe (existing behavior).
    const { config } = importDevcontainer(data.raw, { containerRuntime: data.containerRuntimeAvailable === true });
    return { config, source: 'devcontainer.json' };
  }
  const config = parseProgramManifest(data.raw);
  return { config, source: 'vectant.programs.json' };
}

/**
 * Slice 1 (real programs): ask the collab-server which container artifacts exist in
 * the workspace (docker-compose / devcontainer / Dockerfile) and whether a container
 * runtime is available, then map the highest-precedence one into a container program.
 *
 * @returns {Promise<{ config: object, source: string } | null>}
 */
export async function fetchDetectedRepoProgram(workspaceSlug, userId = '') {
  const query = userId ? `?userId=${encodeURIComponent(userId)}` : '';
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/detect${query}`);
  if (!data || !data.found) {
    return null;
  }
  return detectRepoProgram({
    files: data.files || {},
    containerRuntime: data.containerRuntimeAvailable === true,
    name: workspaceSlug,
  });
}

/**
 * Launch an installed program from its NormalizedProgramConfig recipe through
 * the collab-server managed runtime (install steps then launch).
 *
 * @returns {Promise<object|null>} the managed session snapshot
 */
export async function launchInstalledProgram({ workspaceSlug, sessionId, config, userId = '', title = null, codeSiteContext = null }) {
  const data = await requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/launch-program`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, userId, title, config, codeSiteContext }),
  });
  return data.session || null;
}

/**
 * Write starter files into a workspace's repo dir (only-missing, path-guarded by
 * the collab-server). Returns the collab response verbatim: `{ written, skipped }`.
 * `userId` must be the IDE's workspaceUserId so files land where the editor reads.
 */
export async function scaffoldProgram({ workspaceSlug, userId = '', files = [] }) {
  return requestJson(`/program-runtime/${encodeURIComponent(workspaceSlug)}/scaffold`, {
    method: 'POST',
    body: JSON.stringify({ userId, files }),
  });
}
