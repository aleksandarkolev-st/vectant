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

/** Remove a session record (stops the runtime first if it's still running). */
export async function deleteProgramSession(workspaceSlug, sessionId) {
  return request(`${workspaceBase(workspaceSlug)}/${encodeURIComponent(sessionId)}`, {
    method: 'DELETE',
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

// ── Community-app hosting: submit to review + self-service ──

/** Submit this workspace's recipe (+ optional image ref) to the review gate. */
export async function submitForReview(workspaceSlug, { sourceImageRef } = {}) {
  return request(`${programsBase(workspaceSlug)}/publish`, {
    method: 'POST',
    body: JSON.stringify(sourceImageRef ? { sourceImageRef } : {}),
  });
}

/** List this workspace's submissions + their review status (redacted). */
export async function fetchMySubmissions(workspaceSlug) {
  if (!workspaceSlug) return [];
  const body = await request(`${programsBase(workspaceSlug)}/submissions`);
  return body.submissions || [];
}

/** Take a published app down (owner/admin). */
export async function unpublishProgram(workspaceSlug, packageId) {
  return request(`${programsBase(workspaceSlug)}/unpublish`, {
    method: 'POST',
    body: JSON.stringify({ packageId }),
  });
}

/** Ask Gemini to draft a vectant.programs.json → { manifest, valid, errors? }. */
export async function generateManifest(workspaceSlug) {
  return request(`${programsBase(workspaceSlug)}/generate-manifest`, { method: 'POST', body: JSON.stringify({}) });
}

/** Save a reviewed manifest to the workspace (re-validated server-side). */
export async function saveWorkspaceManifest(workspaceSlug, manifest) {
  return request(`${programsBase(workspaceSlug)}/manifest`, { method: 'POST', body: JSON.stringify({ manifest }) });
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

// ── Paid apps ──

/**
 * Start a purchase for a paid marketplace app. Returns one of:
 *   { free: true } · { entitled: true } · { checkoutUrl, priceCents, currency }
 * The caller opens `checkoutUrl` (the external payments page) when present.
 */
export async function checkoutProgram(workspaceSlug, packageId) {
  return request(`${programsBase(workspaceSlug)}/checkout`, {
    method: 'POST',
    body: JSON.stringify({ packageId }),
  });
}

/** Owner/admin: set/replace the price of an app this workspace published. */
export async function setProgramPricing(workspaceSlug, { packageId, priceCents, currency, payoutAccountRef, active }) {
  return request(`${programsBase(workspaceSlug)}/pricing`, {
    method: 'POST',
    body: JSON.stringify({ packageId, priceCents, currency, payoutAccountRef, active }),
  });
}

export async function scaffoldProgram(workspaceSlug, packageId) {
  return request(`${programsBase(workspaceSlug)}/scaffold`, {
    method: 'POST',
    body: JSON.stringify({ packageId }),
  });
}

// ── Slice 1 (real programs): repo auto-detection ──

/** Fetch the container program auto-detected in this workspace ({config, source} or null). */
export async function fetchDetectedProgram(workspaceSlug) {
  if (!workspaceSlug) return null;
  const body = await request(`${programsBase(workspaceSlug)}/detect`);
  return body.detected || null;
}

/** Launch the auto-detected container program (re-detected + launched server-side). */
export async function launchDetectedProgram(workspaceSlug) {
  return request(`${programsBase(workspaceSlug)}/detect`, { method: 'POST' });
}