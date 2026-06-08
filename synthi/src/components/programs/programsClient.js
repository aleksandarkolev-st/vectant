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

// ── Phase 2: persisted installs (manifest-driven) ──

function programsBase(workspaceSlug) {
  return `${BASE}/${encodeURIComponent(workspaceSlug)}/programs`;
}

export async function fetchInstalledPrograms(workspaceSlug) {
  if (!workspaceSlug) return [];
  const body = await request(`${programsBase(workspaceSlug)}/installed`);
  return body.installs || [];
}

/**
 * Install the workspace recipe (vectant.programs.json / devcontainer.json).
 * Throws with `error.status === 409` and `error.body.requested` (scopes) when
 * consent is required; pass `{ grantScopes }` to approve and re-submit.
 */
export async function installWorkspaceProgram(workspaceSlug, payload) {
  return request(`${programsBase(workspaceSlug)}/install`, {
    method: 'POST',
    body: JSON.stringify(payload || {}),
  });
}

export async function launchInstalledProgram(workspaceSlug, installId) {
  return request(`${programsBase(workspaceSlug)}/${encodeURIComponent(installId)}/launch`, {
    method: 'POST',
  });
}

// ── Phase 5: open marketplace (publish / browse / install) ──

/** Publish this workspace's recipe to the global catalog (owner/admin). */
export async function publishWorkspaceProgram(workspaceSlug) {
  return request(`${programsBase(workspaceSlug)}/publish`, { method: 'POST', body: JSON.stringify({}) });
}

/** Browse/search the global published catalog. */
export async function fetchMarketplace(workspaceSlug, q = '') {
  if (!workspaceSlug) return [];
  const suffix = q ? `?q=${encodeURIComponent(q)}` : '';
  const body = await request(`${programsBase(workspaceSlug)}/marketplace${suffix}`);
  return body.programs || [];
}

/**
 * Install a published program by packageId+version. Like the manifest install,
 * throws `error.status === 409` with `error.body.requested` when consent is
 * required; pass `grantScopes` to approve and re-submit.
 */
export async function installPublishedProgram(workspaceSlug, packageId, version, grantScopes) {
  return request(`${programsBase(workspaceSlug)}/install`, {
    method: 'POST',
    body: JSON.stringify({ packageId, version, ...(grantScopes ? { grantScopes } : {}) }),
  });
}