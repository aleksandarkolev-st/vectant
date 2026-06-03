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
      'Content-Type': 'application/json',
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

export async function launchProgramRuntime({ workspaceSlug, sessionId, command, userId, title = null, timeout = 60000, env = {} }) {
  const launch = await requestJson(`/exec-terminal/${encodeURIComponent(workspaceSlug)}`, {
    method: 'POST',
    body: JSON.stringify({ sessionId, command, userId, name: title, timeout, env }),
  });
  const runtimeSession = await getProgramRuntimeSession(workspaceSlug, sessionId).catch(() => null);
  return {
    ...launch,
    runtimeSession,
  };
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