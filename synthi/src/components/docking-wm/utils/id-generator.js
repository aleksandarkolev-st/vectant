/**
 * @fileoverview Unique ID generation for layout nodes, tabs, and windows.
 * Uses a combination of prefix + counter + random suffix for debugging readability.
 */

let counter = 0;

/**
 * Generate a short random string.
 * @param {number} length
 * @returns {string}
 */
function randomSuffix(length = 4) {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  for (let i = 0; i < length; i++) {
    result += chars[Math.floor(Math.random() * chars.length)];
  }
  return result;
}

/**
 * Generate a unique ID with a readable prefix.
 * @param {'node'|'tab'|'float'|'popout'|'profile'} prefix
 * @returns {string}
 */
export function generateId(prefix = 'node') {
  counter++;
  return `${prefix}-${counter}-${randomSuffix()}`;
}

/**
 * Generate a node ID.
 * @returns {string}
 */
export function nodeId() {
  return generateId('node');
}

/**
 * Generate a tab ID.
 * @returns {string}
 */
export function tabId() {
  return generateId('tab');
}

/**
 * Generate a floating window ID.
 * @returns {string}
 */
export function floatId() {
  return generateId('float');
}

/**
 * Generate a popout window ID.
 * @returns {string}
 */
export function popoutId() {
  return generateId('popout');
}

/**
 * Generate a profile ID.
 * @returns {string}
 */
export function profileId() {
  return generateId('profile');
}

/**
 * Reset counter (for testing).
 */
export function resetIdCounter() {
  counter = 0;
}
