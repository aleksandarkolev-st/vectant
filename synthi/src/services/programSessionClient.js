const PROGRAMS_BASE = '/api/workspace';
const COLLAB_BASE = (process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234').replace(/\/$/, '');

async function parseJson(response) {
  return response.json().catch(() => ({}));
}

async function request(path, init = {}) {
  const response = await fetch(path, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
  const body = await parseJson(response);

  if (!response.ok) {
    const error = new Error(body?.error || `program_session_request_failed_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function sessionBase(workspaceSlug, sessionId) {
  return `${PROGRAMS_BASE}/${encodeURIComponent(workspaceSlug)}/program-sessions/${encodeURIComponent(sessionId)}`;
}

export async function fetchProgramSession(workspaceSlug, sessionId) {
  const body = await request(sessionBase(workspaceSlug, sessionId));
  return body.session || null;
}

export async function fetchProgramSessionEvents(workspaceSlug, sessionId) {
  const body = await request(`${sessionBase(workspaceSlug, sessionId)}/events`);
  return body.events || [];
}

export async function stopProgramSessionRuntime(workspaceSlug, sessionId) {
  const body = await request(`${sessionBase(workspaceSlug, sessionId)}/stop`, { method: 'POST' });
  return body.session || null;
}

export async function restartProgramSessionRuntime(workspaceSlug, sessionId) {
  const body = await request(`${sessionBase(workspaceSlug, sessionId)}/restart`, { method: 'POST' });
  return body.session || null;
}

export function getProgramSessionAppUrl(port) {
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    return null;
  }

  return `${COLLAB_BASE}/port/${port}/`;
}