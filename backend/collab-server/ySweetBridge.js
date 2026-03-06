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
  const mgr = await getManager();
  return mgr.getOrCreateDocAndToken(docId);
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
  const mgr = await getManager();
  try {
    // getDocAsUpdate returns a Uint8Array with the full Yjs update
    const update = await mgr.getDocAsUpdate(docId);
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
  const mgr = await getManager();
  try {
    await mgr.getDoc(docId);
    return true;
  } catch {
    return false;
  }
}

module.exports = { getOrCreateToken, readDocContent, docExists, getManager };
