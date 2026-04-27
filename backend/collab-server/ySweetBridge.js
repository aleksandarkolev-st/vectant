/**
 * ySweetBridge.js — Thin bridge between collab-server and the Y-Sweet CRDT server.
 *
 * Responsibilities:
 *   1. Generate client-connection tokens (for frontend WebSocket auth).
 *   2. Read document content server-side (for pre-stage flush / git sync).
 *
 * Y-Sweet handles CRDT relay + persistence. This module only talks to
 * Y-Sweet's REST API (via @y-sweet/sdk) — it never holds Yjs docs in memory.
 */

const Y = require('yjs');
const config = require('./config');

// ── Doc-ID encoding ──────────────────────────────────────────────────────────
// Y-Sweet 0.9.x only allows alphanumeric chars, hyphens, and underscores in
// document IDs. Room keys from the frontend contain colons, slashes, spaces,
// and dots.  We encode them with a reversible Base64url (no padding) scheme.
function encodeDocId(raw) {
  return Buffer.from(raw, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

// ── Lazy-loaded SDK ──────────────────────────────────────────────────────────
// @y-sweet/sdk is ESM-only in recent versions. We handle both ESM and CJS
// imports so the server works regardless of the installed version.
let _managerPromise = null;

/**
 * Return a cached DocumentManager instance.
 * The manager is created once on first call and reused.
 * @returns {Promise<import('@y-sweet/sdk').DocumentManager>}
 */
function getManager() {
  if (_managerPromise) return _managerPromise;
  _managerPromise = (async () => {
    let sdk;
    try {
      sdk = await import('@y-sweet/sdk');
    } catch {
      // Fallback: CJS require (older @y-sweet/sdk versions)
      sdk = require('@y-sweet/sdk');
    }
    const DocumentManager = sdk.DocumentManager || sdk.default?.DocumentManager;
    if (!DocumentManager) {
      throw new Error('[ySweetBridge] @y-sweet/sdk does not export DocumentManager');
    }
    const connStr = config.YSWEET_AUTH_KEY
      ? `${config.YSWEET_URL}?auth=${config.YSWEET_AUTH_KEY}`
      : config.YSWEET_URL;
    const mgr = new DocumentManager(connStr);
    console.log(`[ySweetBridge] DocumentManager initialised → ${config.YSWEET_URL}`);
    return mgr;
  })();
  return _managerPromise;
}

/**
 * Get or create a Y-Sweet document and return a client token.
 * The frontend uses this token + URL to establish a WebSocket connection
 * directly to Y-Sweet.
 *
 * @param {string} docId — Y-Sweet document identifier (same as Yjs room name).
 * @returns {Promise<{ url: string, docId: string, token: string }>}
 */
async function getOrCreateToken(docId) {
  const safeId = encodeDocId(docId);
  const mgr = await getManager();
  return mgr.getOrCreateDocAndToken(safeId);
}

/**
 * Read the current text content of a Y-Sweet document.
 *
 * Creates a temporary Y.Doc, loads the server-side snapshot, and reads
 * the 'monaco' Y.Text type. This is used for pre-stage flush (writing
 * CRDT content to the git worktree before staging).
 *
 * @param {string} docId — Y-Sweet document identifier.
 * @returns {Promise<string|null>} document text, or null if empty / not found.
 */
async function readDocContent(docId) {
  const safeId = encodeDocId(docId);
  const mgr = await getManager();
  try {
    // getDocAsUpdate returns a Uint8Array with the full Yjs update
    const update = await mgr.getDocAsUpdate(safeId);
    if (!update || update.length === 0) return null;

    const doc = new Y.Doc();
    Y.applyUpdate(doc, update);
    const text = doc.getText('monaco');
    const content = text.toString();
    doc.destroy();
    return content || null;
  } catch (err) {
    // Document may not exist yet — treat as empty
    if (err?.status === 404 || err?.message?.includes('not found')) return null;
    console.error(`[ySweetBridge] readDocContent(${docId}) error:`, err?.message || err);
    return null;
  }
}

/**
 * Check whether a document exists in Y-Sweet.
 * @param {string} docId
 * @returns {Promise<boolean>}
 */
async function docExists(docId) {
  const safeId = encodeDocId(docId);
  const mgr = await getManager();
  try {
    await mgr.getDoc(safeId);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reset the content of a Y-Sweet document's 'monaco' Y.Text to `newContent`.
 *
 * Used to heal split-brain after an out-of-band disk write (AI agent,
 * terminal, etc.) where the CRDT snapshot diverged from disk.  We load the
 * current Y.Doc, rewrite the text using deletions + insertions (so existing
 * awareness / decorations remain valid), and push the resulting update back
 * to Y-Sweet.
 *
 * If no update method is available on the SDK, the caller should fall back
 * to a hard invalidation (clients destroy + reconnect to an empty doc).
 *
 * @param {string} docId
 * @param {string} newContent
 * @returns {Promise<boolean>} true on successful rewrite, false if unsupported
 */
async function resetDocContent(docId, newContent) {
  if (typeof newContent !== 'string') return false;
  const safeId = encodeDocId(docId);
  const mgr = await getManager();

  // Load current state (may be empty if doc is fresh)
  let existingUpdate = null;
  try {
    existingUpdate = await mgr.getDocAsUpdate(safeId);
  } catch (err) {
    if (!(err?.status === 404 || err?.message?.includes('not found'))) {
      console.warn(`[ySweetBridge] resetDocContent: getDocAsUpdate(${docId}) failed:`, err?.message || err);
    }
  }

  const doc = new Y.Doc();
  if (existingUpdate && existingUpdate.length > 0) {
    try { Y.applyUpdate(doc, existingUpdate); } catch (_) { /* fresh doc */ }
  }

  // Rewrite the monaco text in a single transaction so only one update is
  // generated.  We capture the update via doc.on('update') rather than
  // encodeStateAsUpdate so we can push just the delta.
  let updatePayload = null;
  const captureUpdate = (update) => { updatePayload = update; };
  doc.on('update', captureUpdate);
  try {
    const ytext = doc.getText('monaco');
    doc.transact(() => {
      if (ytext.length > 0) ytext.delete(0, ytext.length);
      if (newContent.length > 0) ytext.insert(0, newContent);
    });
  } finally {
    doc.off('update', captureUpdate);
  }
  doc.destroy();

  if (!updatePayload || updatePayload.length === 0) return true; // already matched

  // Try the write path.  @y-sweet/sdk exposes several method names across
  // versions — probe them in order.
  const methods = ['updateDoc', 'updateDocument', 'applyUpdate', 'writeUpdate'];
  for (const name of methods) {
    if (typeof mgr[name] === 'function') {
      try {
        await mgr[name](safeId, updatePayload);
        return true;
      } catch (err) {
        console.warn(`[ySweetBridge] resetDocContent: ${name}(${docId}) failed:`, err?.message || err);
        return false;
      }
    }
  }

  console.warn(`[ySweetBridge] resetDocContent: no write method available on DocumentManager`);
  return false;
}

/**
 * Apply a "patched-content" replacement as a minimal Yjs.Text edit so concurrent
 * editors merge cleanly. Master plan §8.4 (Yjs-aware apply).
 *
 * Strategy: we don't have a diff library installed, so we compute a single
 * minimal hunk by stripping the longest common prefix and longest common
 * suffix between the current Y.Text and `patchedContent`. The middle region
 * becomes one delete + one insert inside a `doc.transact()` block. CRDT
 * semantics handle any concurrent edits in the unchanged prefix/suffix.
 *
 * Falls back to `resetDocContent` if no Y.Text content exists yet.
 *
 * @param {string} docId       Y-Sweet document identifier
 * @param {string} patchedContent  full target file body
 * @returns {Promise<{ ok: boolean, strategy: 'crdt-hunk'|'reset'|'noop'|'unsupported' }>}
 */
async function applyTextDiffOps(docId, patchedContent) {
  if (typeof patchedContent !== 'string') {
    return { ok: false, strategy: 'unsupported' };
  }
  const safeId = encodeDocId(docId);
  const mgr = await getManager();

  let existingUpdate = null;
  try {
    existingUpdate = await mgr.getDocAsUpdate(safeId);
  } catch (err) {
    if (!(err?.status === 404 || err?.message?.includes('not found'))) {
      console.warn(`[ySweetBridge] applyTextDiffOps: getDocAsUpdate(${docId}) failed:`, err?.message || err);
    }
  }

  // Empty / missing doc → fall back to a fresh reset.
  if (!existingUpdate || existingUpdate.length === 0) {
    const ok = await resetDocContent(docId, patchedContent);
    return { ok, strategy: 'reset' };
  }

  const doc = new Y.Doc();
  try { Y.applyUpdate(doc, existingUpdate); } catch (_) { /* fresh */ }
  const ytext = doc.getText('monaco');
  const current = ytext.toString();

  if (current === patchedContent) {
    doc.destroy();
    return { ok: true, strategy: 'noop' };
  }

  // Compute longest common prefix + suffix in code-units.
  const a = current;
  const b = patchedContent;
  const aLen = a.length;
  const bLen = b.length;
  let prefix = 0;
  const minLen = Math.min(aLen, bLen);
  while (prefix < minLen && a.charCodeAt(prefix) === b.charCodeAt(prefix)) prefix++;
  let suffix = 0;
  while (
    suffix < (minLen - prefix) &&
    a.charCodeAt(aLen - 1 - suffix) === b.charCodeAt(bLen - 1 - suffix)
  ) suffix++;

  const deleteAt = prefix;
  const deleteLen = aLen - prefix - suffix;
  const insertText = b.slice(prefix, bLen - suffix);

  let updatePayload = null;
  const captureUpdate = (update) => { updatePayload = update; };
  doc.on('update', captureUpdate);
  try {
    doc.transact(() => {
      if (deleteLen > 0) ytext.delete(deleteAt, deleteLen);
      if (insertText.length > 0) ytext.insert(deleteAt, insertText);
    });
  } finally {
    doc.off('update', captureUpdate);
  }
  doc.destroy();

  if (!updatePayload || updatePayload.length === 0) {
    return { ok: true, strategy: 'noop' };
  }

  const methods = ['updateDoc', 'updateDocument', 'applyUpdate', 'writeUpdate'];
  for (const name of methods) {
    if (typeof mgr[name] === 'function') {
      try {
        await mgr[name](safeId, updatePayload);
        return { ok: true, strategy: 'crdt-hunk' };
      } catch (err) {
        console.warn(`[ySweetBridge] applyTextDiffOps: ${name}(${docId}) failed:`, err?.message || err);
        return { ok: false, strategy: 'unsupported' };
      }
    }
  }
  return { ok: false, strategy: 'unsupported' };
}

module.exports = { getOrCreateToken, readDocContent, docExists, getManager, resetDocContent, applyTextDiffOps };
