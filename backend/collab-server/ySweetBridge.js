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
 * Compute a list of line-level hunks { start, deleteCount, insert } that
 * transforms `current` into `target`. Coordinates are character offsets in
 * `current`, so they can be fed straight into Y.Text.delete()/insert().
 *
 * Implementation: split both texts into lines (keeping the trailing
 * newline on each line), peel off the longest common prefix + suffix of
 * lines to bound the LCS region, then run a standard LCS-DP on the
 * remaining middle. Walk the LCS to emit ordered, non-overlapping hunks.
 *
 * The hunks are yielded in increasing offset order so they can be applied
 * sequentially after adjusting later offsets by each preceding delta.
 *
 * @returns {Array<{start:number, deleteCount:number, insert:string}>}
 */
function diffToHunks(current, target) {
  if (current === target) return [];

  // Split keeping trailing newlines so concat(lines) === original.
  const splitKeepingNL = (s) => {
    const out = [];
    let i = 0;
    while (i < s.length) {
      const j = s.indexOf('\n', i);
      if (j === -1) { out.push(s.slice(i)); break; }
      out.push(s.slice(i, j + 1));
      i = j + 1;
    }
    return out.length === 0 ? [''] : out;
  };

  const a = splitKeepingNL(current);
  const b = splitKeepingNL(target);

  // Peel common prefix
  let p = 0;
  const minP = Math.min(a.length, b.length);
  while (p < minP && a[p] === b[p]) p++;

  // Peel common suffix
  let s = 0;
  while (
    s < (Math.min(a.length, b.length) - p) &&
    a[a.length - 1 - s] === b[b.length - 1 - s]
  ) s++;

  const aMid = a.slice(p, a.length - s);
  const bMid = b.slice(p, b.length - s);

  // Char offset where the middle region starts in `current`.
  let baseOffset = 0;
  for (let i = 0; i < p; i++) baseOffset += a[i].length;

  // Fast paths for pure insert / pure delete in the middle region.
  if (aMid.length === 0) {
    if (bMid.length === 0) return [];
    return [{ start: baseOffset, deleteCount: 0, insert: bMid.join('') }];
  }
  if (bMid.length === 0) {
    return [{ start: baseOffset, deleteCount: aMid.join('').length, insert: '' }];
  }

  // LCS DP over the middle region. Cap to keep memory bounded; if the
  // region is too large, fall back to a single coarse hunk.
  const MAX_LCS_LINES = 4000;
  if (aMid.length > MAX_LCS_LINES || bMid.length > MAX_LCS_LINES) {
    return [{
      start: baseOffset,
      deleteCount: aMid.join('').length,
      insert: bMid.join(''),
    }];
  }

  const m = aMid.length, n = bMid.length;
  // dp[i][j] = LCS length of aMid[i:] vs bMid[j:]
  const dp = new Array(m + 1);
  for (let i = 0; i <= m; i++) dp[i] = new Int32Array(n + 1);
  for (let i = m - 1; i >= 0; i--) {
    for (let j = n - 1; j >= 0; j--) {
      dp[i][j] = aMid[i] === bMid[j]
        ? dp[i + 1][j + 1] + 1
        : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  // Walk the DP to emit hunks. We accumulate consecutive non-matches into
  // a single hunk for efficiency.
  const hunks = [];
  let i = 0, j = 0;
  let curOffset = baseOffset;
  let pendingDel = 0;
  let pendingIns = '';
  let pendingStart = curOffset;

  const flush = () => {
    if (pendingDel === 0 && pendingIns.length === 0) return;
    hunks.push({ start: pendingStart, deleteCount: pendingDel, insert: pendingIns });
    pendingDel = 0;
    pendingIns = '';
  };

  while (i < m && j < n) {
    if (aMid[i] === bMid[j]) {
      flush();
      curOffset += aMid[i].length;
      pendingStart = curOffset;
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      // Deletion: extends the hunk's deleteCount AND consumes source bytes,
      // so the running source offset advances. pendingStart stays put — it
      // marks where the hunk began.
      pendingDel += aMid[i].length;
      curOffset += aMid[i].length;
      i++;
    } else {
      pendingIns += bMid[j];
      j++;
    }
  }
  while (i < m) {
    pendingDel += aMid[i].length;
    curOffset += aMid[i].length;
    i++;
  }
  while (j < n) { pendingIns += bMid[j]; j++; }
  flush();

  return hunks;
}

/**
 * Apply a "patched-content" replacement as a minimal Yjs.Text edit so concurrent
 * editors merge cleanly. Master plan §8.4 (Yjs-aware apply).
 *
 * Strategy: line-level LCS diff between the current Y.Text and the target
 * content yields a list of hunks. Each hunk is applied as one delete + one
 * insert inside a single `doc.transact()` block. CRDT semantics handle
 * concurrent edits in the unchanged regions between hunks.
 *
 * Falls back to `resetDocContent` if no Y.Text content exists yet.
 *
 * @param {string} docId       Y-Sweet document identifier
 * @param {string} patchedContent  full target file body
 * @returns {Promise<{ ok: boolean, strategy: 'crdt-hunks'|'reset'|'noop'|'unsupported', hunks?: number }>}
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

  const hunks = diffToHunks(current, patchedContent);
  if (hunks.length === 0) {
    doc.destroy();
    return { ok: true, strategy: 'noop' };
  }

  let updatePayload = null;
  const captureUpdate = (update) => { updatePayload = update; };
  doc.on('update', captureUpdate);
  try {
    doc.transact(() => {
      // Apply hunks back-to-front so earlier offsets remain valid.
      for (let k = hunks.length - 1; k >= 0; k--) {
        const h = hunks[k];
        if (h.deleteCount > 0) ytext.delete(h.start, h.deleteCount);
        if (h.insert.length > 0) ytext.insert(h.start, h.insert);
      }
    });
  } finally {
    doc.off('update', captureUpdate);
  }
  doc.destroy();

  if (!updatePayload || updatePayload.length === 0) {
    return { ok: true, strategy: 'noop', hunks: 0 };
  }

  const methods = ['updateDoc', 'updateDocument', 'applyUpdate', 'writeUpdate'];
  for (const name of methods) {
    if (typeof mgr[name] === 'function') {
      try {
        await mgr[name](safeId, updatePayload);
        return { ok: true, strategy: 'crdt-hunks', hunks: hunks.length };
      } catch (err) {
        console.warn(`[ySweetBridge] applyTextDiffOps: ${name}(${docId}) failed:`, err?.message || err);
        return { ok: false, strategy: 'unsupported' };
      }
    }
  }
  return { ok: false, strategy: 'unsupported' };
}

module.exports = { getOrCreateToken, readDocContent, docExists, getManager, resetDocContent, applyTextDiffOps, diffToHunks };
