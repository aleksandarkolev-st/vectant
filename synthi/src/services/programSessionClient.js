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

/**
 * Build the in-IDE preview URL for a program's web port.
 *
 * When `runtimeScope` is set, the port was opened inside the Sysbox per-workspace
 * runtime pod (RUNTIME_BACKEND=sysbox-pod) and routes through the runtime-scoped
 * proxy `/runtime/<scope>/port/<port>/` (matches proxyService). Otherwise,
 * `container`-type programs bind ports inside their per-workspace runtime container
 * and route through `/wsport/<slug>/<port>/`; all other runtime types use the global
 * `/port/<port>/` path. All share the collab origin, so no CSP change is needed.
 *
 * @param {number} port
 * @param {{ slug?: string, runtimeType?: string, runtimeScope?: string }} [opts]
 */
export function getProgramSessionAppUrl(port, { slug = null, runtimeType = null, runtimeScope = null } = {}) {
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    return null;
  }

  if (runtimeScope) {
    return `${COLLAB_BASE}/runtime/${encodeURIComponent(runtimeScope)}/port/${port}/`;
  }

  if (runtimeType === 'container' && slug) {
    return `${COLLAB_BASE}/wsport/${encodeURIComponent(slug)}/${port}/`;
  }

  return `${COLLAB_BASE}/port/${port}/`;
}