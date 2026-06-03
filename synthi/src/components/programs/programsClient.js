const BASE = '/api/workspace';

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
    const error = new Error(body?.error || `program_request_failed_${response.status}`);
    error.status = response.status;
    error.body = body;
    throw error;
  }

  return body;
}

function workspaceBase(workspaceSlug) {
  return `${BASE}/${encodeURIComponent(workspaceSlug)}/program-sessions`;
}

export async function fetchProgramSessions(workspaceSlug) {
  if (!workspaceSlug) return [];
  const body = await request(workspaceBase(workspaceSlug));
  return body.sessions || [];
}

export async function launchProgramSession(workspaceSlug, payload) {
  return request(workspaceBase(workspaceSlug), {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export async function stopProgramSession(workspaceSlug, sessionId) {
  return request(`${workspaceBase(workspaceSlug)}/${encodeURIComponent(sessionId)}/stop`, {
    method: 'POST',
  });
}

export async function restartProgramSession(workspaceSlug, sessionId) {
  return request(`${workspaceBase(workspaceSlug)}/${encodeURIComponent(sessionId)}/restart`, {
    method: 'POST',
  });
}