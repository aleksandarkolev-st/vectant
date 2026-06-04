export function validationWorkspaceFallbackEnabled(env = process.env) {
  return env.SYNTHI_VALIDATION_AUTHLESS_WORKSPACE === '1'
    || env.SYNTHI_VALIDATION_WORKSPACE_AUTH_FALLBACK === '1';
}

function isAuthUnavailable(error) {
  const message = error?.message ? String(error.message) : String(error ?? '');
  return /\b(?:401|403)\b/.test(message) && /auth|session|permission/i.test(message);
}

function isWorkspaceApiUnavailable(error) {
  const message = error?.message ? String(error.message) : String(error ?? '');
  const cause = error?.cause?.message ? String(error.cause.message) : '';
  return /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|terminated/i.test(
    `${message} ${cause}`,
  );
}

export async function createValidationWorkspace({ frontendUrl, name, slug, httpJson, record }) {
  try {
    return await httpJson('POST', `${frontendUrl}/api/workspace`, { name, slug });
  } catch (error) {
    const authUnavailable = isAuthUnavailable(error);
    const apiUnavailable = isWorkspaceApiUnavailable(error);
    const fallbackAllowed = validationWorkspaceFallbackEnabled()
      && (authUnavailable || apiUnavailable);
    if (!fallbackAllowed) {
      throw error;
    }
    const detail = authUnavailable
      ? `frontend workspace API requires auth; using collab-backed validation workspace slug=${slug}`
      : `frontend workspace API unavailable; using collab-backed validation workspace slug=${slug}`;
    if (typeof record === 'function') {
      record('validation workspace fallback', 'warn', detail);
    }
    return {
      id: slug,
      slug,
      name,
      validationOnly: true,
      fallbackReason: authUnavailable
        ? 'workspace_api_auth_unavailable'
        : 'workspace_api_unavailable',
    };
  }
}
