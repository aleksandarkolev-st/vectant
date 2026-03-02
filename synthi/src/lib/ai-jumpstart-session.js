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

/** Maximum prompt length (matches AIJumpstartSection constant) */
const MAX_PROMPT_LENGTH = 2000;

/**
 * Sanitize the prompt text — trim, enforce length, strip control characters.
 * @param {string} raw
 * @returns {string}
 */
function sanitizePrompt(raw) {
  if (typeof raw !== "string") return "";
  // Strip non-printable control chars except newlines/tabs
  const cleaned = raw.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  return cleaned.trim().slice(0, MAX_PROMPT_LENGTH);
}

/**
 * Sanitize a single attachment – ensure required fields, strip unexpected properties.
 * @param {JumpstartAttachment} att
 * @returns {JumpstartAttachment}
 */
function sanitizeAttachment(att) {
  return {
    id: String(att.id || ""),
    name: String(att.name || "unknown").slice(0, 255),
    size: typeof att.size === "number" ? att.size : 0,
    type: String(att.type || "application/octet-stream").slice(0, 127),
    content: att.content ?? null,
    kind: ["text", "image", "binary"].includes(att.kind) ? att.kind : "binary",
  };
}

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
 * Sanitizes prompt text and validates attachments before storing.
 *
 * @param {JumpstartPayload} payload
 */
export function storeJumpstartPayload(payload) {
  try {
    const sanitized = {
      prompt: sanitizePrompt(payload.prompt),
      attachments: Array.isArray(payload.attachments)
        ? payload.attachments.map(sanitizeAttachment)
        : [],
    };
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized));
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
