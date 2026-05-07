/**
 * Sync, in-memory GitHub token cache used by Redux thunks and other non-React
 * modules that previously read localStorage. The cache is hydrated by
 * <SessionTokenHydrator/> from session.githubToken (NextAuth) and cleared on
 * sign-out. Nothing here ever touches localStorage.
 */

let _token = null;
let _source = null; // 'pat' | 'oauth' | null
const _listeners = new Set();

export function getGithubToken() {
  return _token;
}

export function getGithubTokenSource() {
  return _source;
}

export function setGithubToken(token, source = null) {
  if (_token === token && _source === source) return;
  _token = token || null;
  _source = token ? source : null;
  for (const fn of _listeners) {
    try { fn(_token); } catch (_) { /* ignore listener errors */ }
  }
}

export function subscribeGithubToken(fn) {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
