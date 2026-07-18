/**
 * @fileoverview Delegate vectant.programs.json generation to a configured Vectant
 * backend endpoint. Off by default: without VECTANT_MANIFEST_GENERATE_URL the
 * generate tool returns `configured:false` and the agent authors from the schema
 * instead. The POST body ({ files, workspace_name }) matches the ai-engine
 * generate endpoint; the token header defaults to that endpoint's internal-auth
 * header. fetch is injectable so tests never hit the network. Fail-closed: any
 * error is returned structurally, never thrown.
 */

const DEFAULT_TOKEN_HEADER = 'x-synthi-internal-token';

/** Resolve the generate configuration from the environment. */
export function generateConfig(env = process.env) {
  const url = typeof env.VECTANT_MANIFEST_GENERATE_URL === 'string' ? env.VECTANT_MANIFEST_GENERATE_URL.trim() : '';
  return {
    configured: url !== '',
    url: url || null,
    token: env.VECTANT_MANIFEST_GENERATE_TOKEN || null,
    tokenHeader: env.VECTANT_MANIFEST_GENERATE_TOKEN_HEADER || DEFAULT_TOKEN_HEADER,
  };
}

/**
 * @param {{ files: object, workspaceName?: string }} input
 * @returns {Promise<{ configured: boolean, manifest?: object, error?: string, status?: number, message?: string }>}
 */
export async function generateManifest({ files, workspaceName } = {}, { fetchImpl, config = generateConfig() } = {}) {
  if (!config.configured) {
    return {
      configured: false,
      error: 'not_configured',
      message: 'Set VECTANT_MANIFEST_GENERATE_URL to enable generation; otherwise author the manifest from describe_manifest_schema.',
    };
  }
  if (!files || typeof files !== 'object' || Array.isArray(files) || Object.keys(files).length === 0) {
    return { configured: true, error: 'no_files', message: 'Provide a non-empty files map { path: contents }.' };
  }

  const doFetch = fetchImpl || (typeof fetch === 'function' ? fetch : null);
  if (!doFetch) return { configured: true, error: 'no_fetch', message: 'No fetch implementation available.' };

  const headers = { 'content-type': 'application/json' };
  if (config.token) headers[config.tokenHeader] = config.token;

  let res;
  try {
    res = await doFetch(config.url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ files, workspace_name: workspaceName || null }),
    });
  } catch (e) {
    return { configured: true, error: 'request_failed', message: String(e?.message || e) };
  }
  if (!res.ok) {
    return { configured: true, error: 'http_error', status: res.status, message: `generate endpoint returned ${res.status}` };
  }
  let body;
  try {
    body = await res.json();
  } catch {
    return { configured: true, error: 'bad_response', message: 'generate endpoint returned non-JSON' };
  }
  const manifest = body && typeof body === 'object' ? body.manifest : null;
  if (!manifest) return { configured: true, error: 'no_manifest', message: 'generate endpoint did not return a manifest' };
  return { configured: true, manifest };
}
