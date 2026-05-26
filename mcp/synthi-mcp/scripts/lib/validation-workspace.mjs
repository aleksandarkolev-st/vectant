export function validationWorkspaceFallbackEnabled(env = process.env) {
  return env.SYNTHI_VALIDATION_AUTHLESS_WORKSPACE === '1'
    || env.SYNTHI_VALIDATION_WORKSPACE_AUTH_FALLBACK === '1';
}

function isAuthUnavailable(error) {
  const message = error?.message ? String(error.message) : String(error ?? '');
  return /\b(?:401|403)\b/.test(message) && /auth|session|permission/i.test(message);
}

export async function createValidationWorkspace({ frontendUrl, name, slug, httpJson, record }) {
  try {
    return await httpJson('POST', `${frontendUrl}/api/workspace`, { name, slug });
  } catch (error) {
    if (!validationWorkspaceFallbackEnabled() || !isAuthUnavailable(error)) {
      throw error;
    }
    const detail = `frontend workspace API requires auth; using collab-backed validation workspace slug=${slug}`;
    if (typeof record === 'function') {
      record('validation workspace auth fallback', 'warn', detail);
    }
    return {
      id: slug,
      slug,
      name,
      validationOnly: true,
      fallbackReason: 'workspace_api_auth_unavailable',
    };
  }
}
