/**
 * Centralised localStorage keys and accessor for the current
 * Synthi user identity. Avoids scattering raw key strings across
 * the codebase and ensures consistent fallback values.
 */

export const USER_ID_KEY     = 'synthi-user-id';
export const USER_NAME_KEY   = 'synthi-user-name';
export const USER_AVATAR_KEY = 'synthi-user-avatar';

/**
 * Read the current user identity from localStorage.
 * The fallback chain: name → avatar → id ensures a human-readable
 * display name is always available even if some fields are missing.
 *
 * @returns {{ id: string, name: string, avatar: string }}
 */
export function getCurrentUser() {
  if (typeof window === 'undefined') {
    return { id: 'guest', name: 'Guest', avatar: '' };
  }
  const id     = localStorage.getItem(USER_ID_KEY) || 'guest';
  const name   = localStorage.getItem(USER_NAME_KEY) || null;
  const avatar = localStorage.getItem(USER_AVATAR_KEY) || '';

  // Human-readable display name: prefer name, fall back to email-like
  // portion of the id if it contains '@', otherwise 'Guest'.
  const displayName = name || (id.includes('@') ? id.split('@')[0] : null) || 'Guest';

  return { id, name: displayName, avatar };
}
