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
 *
 * @returns {{ id: string, name: string, avatar: string }}
 */
export function getCurrentUser() {
  if (typeof window === 'undefined') {
    return { id: 'guest', name: 'Guest', avatar: '' };
  }
  return {
    id:     localStorage.getItem(USER_ID_KEY) || 'guest',
    name:   localStorage.getItem(USER_NAME_KEY) || 'Guest',
    avatar: localStorage.getItem(USER_AVATAR_KEY) || '',
  };
}
