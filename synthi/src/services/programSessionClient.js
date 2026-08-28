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
 * `vncPath` appends the noVNC websocket path for a webGui (KasmVNC) App tab: noVNC
 * otherwise opens `ws://<host>/websockify` at the ROOT, which the container port proxy
 * (only routing `/wsport/<slug>/<port>/…`) can't reach → 1006. It also adds
 * `resize=scale`, which makes noVNC zoom the framebuffer to fit the iframe instead of
 * showing scrollbars — so the stream is resizeable (tracks a dragged floating window)
 * and an undocked frame always fits the whole app (zooms out when the frame is small).
 * Only affects the `/wsport/` form (the local hybrid container path); a no-op otherwise.
 *
 * @param {number} port
 * @param {{ slug?: string, runtimeType?: string, runtimeScope?: string, vncPath?: boolean }} [opts]
 */
export function getProgramSessionAppUrl(port, { slug = null, runtimeType = null, runtimeScope = null, vncPath = false } = {}) {
  if (typeof port !== 'number' || !Number.isFinite(port)) {
    return null;
  }

  if (runtimeScope) {
    return `${COLLAB_BASE}/runtime/${encodeURIComponent(runtimeScope)}/port/${port}/`;
  }

  if (runtimeType === 'container' && slug) {
    const encSlug = encodeURIComponent(slug);
    const base = `${COLLAB_BASE}/wsport/${encSlug}/${port}/`;
    return vncPath ? `${base}?path=wsport/${encSlug}/${port}/websockify&resize=scale` : base;
  }

  return `${COLLAB_BASE}/port/${port}/`;
}