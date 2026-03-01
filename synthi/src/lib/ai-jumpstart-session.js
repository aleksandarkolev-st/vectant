/**
 * AI Jumpstart session transfer utilities.
 *
 * Uses sessionStorage (one-time, same-tab) to pass jumpstart data
 * from the dashboard → workspace page, matching the existing pattern
 * used for guest collab sessions.
 *
 * @module ai-jumpstart-session
 */

const STORAGE_KEY = "synthi-ai-jumpstart";

/**
 * @typedef {Object} JumpstartAttachment
 * @property {string} id      - Unique ID
 * @property {string} name    - File name
 * @property {number} size    - Byte size
 * @property {string} type    - MIME type
 * @property {string|null} content - Text content or base64 data URL
 * @property {'text'|'image'|'binary'} kind
 */

/**
 * @typedef {Object} JumpstartPayload
 * @property {string} prompt         - User's project idea description
 * @property {JumpstartAttachment[]} attachments - Attached reference files
 */

/**
 * Persist jumpstart data to sessionStorage before navigating to workspace.
 *
 * @param {JumpstartPayload} payload
 */
export function storeJumpstartPayload(payload) {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.error("[ai-jumpstart] Failed to store payload:", err);
  }
}

/**
 * Retrieve and consume (remove) the jumpstart payload.
 * Returns null if nothing is stored.
 *
 * @returns {JumpstartPayload | null}
 */
export function consumeJumpstartPayload() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    sessionStorage.removeItem(STORAGE_KEY);
    return JSON.parse(raw);
  } catch (err) {
    console.error("[ai-jumpstart] Failed to consume payload:", err);
    sessionStorage.removeItem(STORAGE_KEY);
    return null;
  }
}

/**
 * Check if a jumpstart payload is pending (without consuming it).
 *
 * @returns {boolean}
 */
export function hasJumpstartPayload() {
  try {
    return sessionStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}
