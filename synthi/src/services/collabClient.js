// ─────────────────────────────────────────────────────────────────────────────
// CollabClient — Workspace collaboration orchestrator.
//
// Architecture (Phase 4b — Workerized CRDTs):
//   • All Y.Doc lifecycle, CRDT encoding/decoding, and WebSocket sync run
//     inside a dedicated Web Worker (collab-crdt.worker.js).
//   • This module communicates with the worker through the CRDTWorkerBridge.
//   • MonacoTextBinding receives lightweight delta payloads from the worker
//     and applies them to the Monaco model on the main thread.
//   • Local keystrokes are forwarded to the worker as offset-based changes;
//     the heavy Yjs transact + binary encoding happens off the main thread.
//
// The external API is identical to the pre-worker version so that all
// consumers (Editor, StatusBar, CollabPanel, etc.) require zero changes.
// ─────────────────────────────────────────────────────────────────────────────

import bridge from './crdtWorkerBridge';
import { resolveCollabWsUrl } from '@/lib/collab-url';

// ─────────────────────────────────────────────────────────────────────────────
// MonacoTextBinding — Bridges the CRDT worker with the Monaco editor model.
// Remote deltas arrive via the bridge; local changes are posted to the worker.
// Awareness state (remote cursors / selections) is rendered as Monaco
// decorations + content widgets, updated via bridge awareness events.
// ─────────────────────────────────────────────────────────────────────────────

class MonacoTextBinding {
  /**
   * @param {object} opts
   * @param {import('./crdtWorkerBridge').default} opts.bridge
   * @param {string} opts.key        — Yjs room key
   * @param {object} opts.model      — Monaco ITextModel
   * @param {object} opts.editor     — Monaco ICodeEditor
   * @param {object} opts.monaco     — Monaco namespace
   */
  constructor({ bridge: br, key, model, editor, monaco }) {
    this.bridge = br;
    this.key = key;
    this.model = model;
    this.editor = editor;
    this.monaco = monaco;
    this._destroyed = false;
    this._applyingRemote = false;

    // ── Remote delta handler (worker → Monaco) ───────────────────────────
    this._unsubDelta = br.onRemoteDelta(key, (delta, fullText, deltaBatch) => {
      this._handleRemoteDelta(delta, fullText, deltaBatch);
    });

    // ── Awareness decorations ────────────────────────────────────────────
    this._remoteDecorations = new Map(); // clientId → { ids, meta }
    this._contentWidgets = new Map();    // clientId → { widgetObj, dom, … }
    this._localClientId = null;
    this._awarenessRafId = null;
    this._pendingAwarenessStates = null;

    this._unsubAwareness = br.onAwareness(key, (states, localClientId, _changes) => {
      this._pendingAwarenessStates = states;
      this._localClientId = localClientId;
      if (this._awarenessRafId) return; // already scheduled
      this._awarenessRafId = requestAnimationFrame(() => {
        this._awarenessRafId = null;
        if (this._destroyed) return;
        try {
          this._applyAwarenessDecorations(this._pendingAwarenessStates);
        } catch (err) {
          console.warn('[Collab] awareness decoration error', err?.message || err);
        }
      });
    });

    // Kick an initial awareness render once the worker reports states
    br.requestAwarenessStates(key).then(({ states, localClientId }) => {
      if (this._destroyed) return;
      this._localClientId = localClientId;
      try { this._applyAwarenessDecorations(states); } catch (_) {}
    });

    // ── Heartbeat — keep awareness alive ──────────────────────────────────
    this._heartbeatTimer = setInterval(() => {
      if (this._destroyed) return;
      br.setAwarenessField(key, 'lastActive', Date.now());
    }, 20000);

    // ── Cursor / selection publishing ─────────────────────────────────────
    this._pendingCursorState = null;
    this._cursorThrottleTimer = null;
    const CURSOR_THROTTLE_MS = 50;

    const flushCursorState = () => {
      this._cursorThrottleTimer = null;
      if (!this._pendingCursorState) return;
      try {
        br.setAwarenessField(key, 'cursor', this._pendingCursorState);
        br.setAwarenessField(key, 'lastActive', Date.now());
      } catch (_) {}
      this._pendingCursorState = null;
    };

    this._cursorListener = editor.onDidChangeCursorSelection((ev) => {
      try {
        const sel = ev.selection;
        const cursorState = {
          anchor: { line: sel.selectionStartLineNumber, column: sel.selectionStartColumn },
          head: { line: sel.positionLineNumber, column: sel.positionColumn },
          range: {
            start: { line: sel.startLineNumber, column: sel.startColumn },
            end: { line: sel.endLineNumber, column: sel.endColumn },
          },
        };
        const allSelections = editor.getSelections();
        if (allSelections && allSelections.length > 1) {
          cursorState.secondarySelections = allSelections.slice(1).map((s) => ({
            start: { line: s.startLineNumber, column: s.startColumn },
            end: { line: s.endLineNumber, column: s.endColumn },
          }));
        }
        this._pendingCursorState = cursorState;
        if (!this._cursorThrottleTimer) {
          this._cursorThrottleTimer = setTimeout(flushCursorState, CURSOR_THROTTLE_MS);
        }
      } catch (_) { /* don't break editing */ }
    });

    // ── Local changes → worker ────────────────────────────────────────────
    this._modelListener = this.model.onDidChangeContent((e) => {
      if (this._applyingRemote) return;
      if (this._destroyed) return;
      if (e.isFlush) return;
      if (this.editor.getModel() !== this.model) return;

      try {
        const changes = e.changes;
        if (!changes || changes.length === 0) return;

        // Serialize changes for the worker (offset-based, no Monaco objects)
        const serialized = changes.map((c) => ({
          rangeOffset: c.rangeOffset,
          rangeLength: c.rangeLength,
          text: c.text,
        }));

        const fullText = this.model.getValue();
        br.sendLocalChanges(key, serialized, fullText);
        // Optimistically update the bridge's content cache so that
        // synchronous reads (e.g. normalize comparisons) stay current.
        br.updateContentCache(key, fullText);
      } catch (err) {
        console.warn('[Collab] local change forwarding failed', err?.message || err);
      }
    });
  }

  // ── Remote delta application ──────────────────────────────────────────────

  _buildEditsFromDelta(delta) {
    const modelLength = this.model.getValue().length;
    const edits = [];
    let oldIndex = 0;

    for (const op of delta) {
      if (op.retain != null) {
        if (!Number.isFinite(op.retain) || op.retain < 0) return { valid: false, edits };
        oldIndex += op.retain;
        if (oldIndex > modelLength) return { valid: false, edits };
      } else if (op.insert != null) {
        if (oldIndex < 0 || oldIndex > modelLength) return { valid: false, edits };
        const pos = this.model.getPositionAt(oldIndex);
        edits.push({
          range: new this.monaco.Range(pos.lineNumber, pos.column, pos.lineNumber, pos.column),
          text: typeof op.insert === 'string' ? op.insert : '',
        });
      } else if (op.delete != null) {
        if (!Number.isFinite(op.delete) || op.delete < 0) return { valid: false, edits };
        if (oldIndex < 0 || oldIndex + op.delete > modelLength) return { valid: false, edits };
        const pos = this.model.getPositionAt(oldIndex);
        const endPos = this.model.getPositionAt(oldIndex + op.delete);
        edits.push({
          range: new this.monaco.Range(pos.lineNumber, pos.column, endPos.lineNumber, endPos.column),
          text: '',
        });
        oldIndex += op.delete;
      }
    }

    return { valid: true, edits };
  }

  _applyFullText(fullText) {
    this.model.applyEdits([{ range: this.model.getFullModelRange(), text: fullText }]);
  }

  _handleRemoteDelta(delta, fullText, deltaBatch = null) {
    try {
      if (this._destroyed) return;
      if (this.editor.getModel() !== this.model) return;

      const normalize = (s) => (s ? s.replace(/\r\n/g, '\n') : '');
      const current = this.model.getValue();
      if (normalize(current) === normalize(fullText)) return;

      const deltas = Array.isArray(deltaBatch) && deltaBatch.length > 0
        ? deltaBatch.filter((d) => Array.isArray(d) && d.length > 0)
        : (Array.isArray(delta) && delta.length > 0 ? [delta] : []);

      this._applyingRemote = true;
      try {
        if (deltas.length === 0) {
          this._applyFullText(fullText);
          return;
        }

        for (const nextDelta of deltas) {
          const { valid, edits } = this._buildEditsFromDelta(nextDelta);
          if (!valid) {
            // Delta doesn't describe this model's state — full replace is the
            // only safe recovery.
            console.warn('[Collab] remote delta offsets out of bounds, falling back to full replace');
            this._applyFullText(fullText);
            return;
          }
          if (edits.length > 0) this.model.applyEdits(edits);
        }

        // Post-apply safeguard: verify model matches the worker's full text.
        const afterApply = normalize(this.model.getValue());
        const expected = normalize(fullText);
        if (afterApply !== expected) {
          console.warn('[Collab] post-apply mismatch detected, correcting via full replace');
          this._applyFullText(fullText);
        }
      } catch (e) {
        console.warn('[Collab] incremental remote apply failed, full replace', e?.message);
        try {
          this._applyFullText(fullText);
        } catch (e2) {
          console.warn('[Collab] full-replace fallback also failed', e2?.message);
        }
      } finally {
        this._applyingRemote = false;
      }
    } catch (err) {
      console.warn('[Collab] remote delta handler error', err?.message || err);
    }
  }

  // ── Awareness decorations (identical to pre-worker version) ───────────────

  _applyAwarenessDecorations(states) {
    try {
      const wanted = new Map();
      const localCid = this._localClientId;
      const seenUsers = new Map();

      for (const s of states) {
        const cid = s.clientId;
        const st = s.state || {};
        if (!st || cid === localCid) continue;
        const user = st.user || {};
        if (!st.cursor) continue;

        const userKey = user.id ? String(user.id) : String(cid);
        if (seenUsers.has(userKey)) continue;

        const cursorData = st.cursor;
        const range = this._toMonacoRange(cursorData.range || cursorData);
        if (!range) continue;

        const secondaryRanges = [];
        if (Array.isArray(cursorData.secondarySelections)) {
          for (const sec of cursorData.secondarySelections) {
            const sr = this._toMonacoRange(sec);
            if (sr) secondaryRanges.push(sr);
          }
        }

        seenUsers.set(userKey, { clientId: cid, state: st, range, secondaryRanges, user });
      }

      for (const [, val] of seenUsers.entries()) {
        const cid = val.clientId;
        const user = val.user || {};
        const color = user.color || '#888';
        wanted.set(cid, { range: val.range, secondaryRanges: val.secondaryRanges, color, name: user.name || 'Anonymous' });
      }

      // Cleanup: remove decorations / widgets for users who left
      for (const [cid] of this._remoteDecorations.entries()) {
        if (!wanted.has(cid)) {
          const rec = this._remoteDecorations.get(cid);
          this.editor.deltaDecorations(rec.ids || [], []);
          this._remoteDecorations.delete(cid);
        }
      }
      for (const [cid, rec] of this._contentWidgets.entries()) {
        if (!wanted.has(cid)) {
          this.editor.removeContentWidget(rec.widgetObj);
          this._contentWidgets.delete(cid);
        }
      }

      // Render: add / update decorations for active users
      for (const [cid, info] of wanted.entries()) {
        const selectionClass = `collab-selection-${cid}`;
        const cursorLineClass = `collab-cursor-line-${cid}`;
        this._ensureStyleForClient(cid, info.color);

        const decs = [];
        if (info.range && !info.range.isEmpty()) {
          decs.push({
            range: info.range,
            options: {
              className: selectionClass,
              inlineClassName: selectionClass,
              stickiness: 1,
              zIndex: 10,
              minimap: { color: info.color, position: 2 },
              overviewRuler: { color: info.color, position: 2 },
            },
          });
        }
        if (info.range) {
          const headPos = info.range.getEndPosition();
          const M = this.monaco;
          if (M) {
            decs.push({
              range: new M.Range(headPos.lineNumber, 1, headPos.lineNumber, 1),
              options: {
                isWholeLine: true,
                className: cursorLineClass,
                stickiness: 1,
                zIndex: 5,
                overviewRuler: { color: info.color, position: 2 },
              },
            });
          }
        }
        if (info.secondaryRanges) {
          for (const sr of info.secondaryRanges) {
            if (sr && !sr.isEmpty()) {
              decs.push({
                range: sr,
                options: { className: selectionClass, inlineClassName: selectionClass, stickiness: 1, zIndex: 10 },
              });
            }
          }
        }

        const existingDec = this._remoteDecorations.get(cid);
        const oldIds = existingDec?.ids || [];
        const newIds = this.editor.deltaDecorations(oldIds, decs);
        this._remoteDecorations.set(cid, { ids: newIds, meta: info });

        // Content widget (Figma-style cursor + name tag)
        const headPos = info.range.getEndPosition();
        let widgetRec = this._contentWidgets.get(cid);

        if (!widgetRec) {
          const dom = document.createElement('div');
          dom.className = 'synthi-cursor-widget';
          dom.style.backgroundColor = info.color;
          const label = document.createElement('div');
          label.className = 'synthi-cursor-label';
          label.style.backgroundColor = info.color;
          label.textContent = info.name;
          dom.appendChild(label);

          const widgetObj = {
            getId: () => `synthi.cursor.${cid}`,
            getDomNode: () => dom,
            getPosition: () => ({
              position: { lineNumber: headPos.lineNumber, column: headPos.column },
              preference: [0],
            }),
          };
          this.editor.addContentWidget(widgetObj);
          widgetRec = { widgetObj, dom, currentLine: headPos.lineNumber, currentCol: headPos.column };
          this._contentWidgets.set(cid, widgetRec);
        } else {
          if (widgetRec.currentLine !== headPos.lineNumber || widgetRec.currentCol !== headPos.column) {
            widgetRec.widgetObj.getPosition = () => ({
              position: { lineNumber: headPos.lineNumber, column: headPos.column },
              preference: [0],
            });
            this.editor.layoutContentWidget(widgetRec.widgetObj);
            widgetRec.currentLine = headPos.lineNumber;
            widgetRec.currentCol = headPos.column;
          }
          widgetRec.dom.style.backgroundColor = info.color;
          const lbl = widgetRec.dom.querySelector('.synthi-cursor-label');
          if (lbl) {
            lbl.style.backgroundColor = info.color;
            lbl.textContent = info.name;
          }
        }
      }
    } catch (err) {
      console.warn('[Collab] Decorations error', err);
    }
  }

  _toMonacoRange(raw) {
    try {
      const start = raw.start || raw.anchor || { line: raw.startLineNumber, column: raw.startColumn };
      const end = raw.end || raw.head || { line: raw.endLineNumber, column: raw.endColumn };
      const sLine = start.line || start.selectionStartLineNumber || raw.startLineNumber;
      const sCol = start.column || start.selectionStartColumn || raw.startColumn;
      const eLine = end.line || end.selectionEndLineNumber || raw.endLineNumber || raw.positionLineNumber;
      const eCol = end.column || end.selectionEndColumn || raw.endColumn || raw.positionColumn;
      if (!sLine || !sCol || !eLine || !eCol) return null;
      const M = this.monaco;
      if (!M) return null;
      return new M.Range(sLine, sCol, eLine, eCol);
    } catch (_) {
      return null;
    }
  }

  _ensureStyleForClient(clientId, color) {
    const styleId = `synthi-collab-style-${clientId}`;
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;

    let selectionColor = color;
    let borderColor = color;
    let cursorLineColor = color;
    if (color.startsWith('#')) {
      const r = parseInt(color.substring(1, 3), 16);
      const g = parseInt(color.substring(3, 5), 16);
      const b = parseInt(color.substring(5, 7), 16);
      selectionColor = `rgba(${r}, ${g}, ${b}, 0.25)`;
      borderColor = `rgba(${r}, ${g}, ${b}, 0.45)`;
      cursorLineColor = `rgba(${r}, ${g}, ${b}, 0.08)`;
    } else if (color.startsWith('hsl')) {
      selectionColor = color.replace('hsl', 'hsla').replace(')', ', 0.25)');
      borderColor = color.replace('hsl', 'hsla').replace(')', ', 0.45)');
      cursorLineColor = color.replace('hsl', 'hsla').replace(')', ', 0.08)');
    }

    style.innerHTML = `
      .collab-selection-${clientId} {
        background-color: ${selectionColor} !important;
        border: 1px solid ${borderColor};
        border-radius: 2px;
        min-width: 4px;
      }
      .collab-cursor-line-${clientId} {
        background-color: ${cursorLineColor} !important;
        border-left: 2px solid ${color} !important;
      }
    `;
    document.head.appendChild(style);
  }

  // ── Tear-down ─────────────────────────────────────────────────────────────

  destroy() {
    this._destroyed = true;
    if (this._cursorThrottleTimer) clearTimeout(this._cursorThrottleTimer);
    if (this._heartbeatTimer) clearInterval(this._heartbeatTimer);
    if (this._awarenessRafId) cancelAnimationFrame(this._awarenessRafId);
    try { this._unsubDelta(); } catch (_) {}
    try { this._unsubAwareness(); } catch (_) {}
    try { this._modelListener.dispose(); } catch (_) {}
    try { this._cursorListener?.dispose?.(); } catch (_) {}
    // Remove remote decorations
    try {
      for (const [, rec] of this._remoteDecorations.entries()) {
        try { this.editor.deltaDecorations(rec.ids || [], []); } catch (_) {}
      }
      this._remoteDecorations.clear();
      for (const [, rec] of this._contentWidgets.entries()) {
        try { this.editor.removeContentWidget(rec.widgetObj); } catch (_) {}
        try { rec.dom?.remove?.(); } catch (_) {}
      }
      this._contentWidgets.clear();
    } catch (_) {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// CollabClient — Manages per-file collaboration, awareness, notifications.
// Delegates all CRDT / WebSocket work to the CRDT worker via the bridge.
// ─────────────────────────────────────────────────────────────────────────────


class CollabClient {
  constructor(serverUrl) {
    // Derive WebSocket URL for the collab server (notifications, sessions, REST).
    if (serverUrl) {
      this.serverUrl = serverUrl;
    } else if (typeof window !== 'undefined') {
      this.serverUrl = resolveCollabWsUrl();
    } else {
      this.serverUrl = 'ws://localhost:1234';
    }

    // Document CRDT sync goes through the collab server's Yjs relay.
    // The browser must connect to /yjs so the server can route upgrades.
    const collabWsBase = this.serverUrl.replace(/\/$/, '');
    this.docSyncUrl = collabWsBase.endsWith('/yjs')
      ? collabWsBase
      : `${collabWsBase}/yjs`;

    this.docs = new Map(); // key -> lightweight bridge-managed entry
    this.identity = { userId: null, sessionId: null, hostId: null };
    this._awarenessListeners = new Map(); // key → Map<originalCb, { wrapped, unsub }>
    this._cachedUserImage = null;

    // ── Connection status tracking ──
    this._connectionStatus = 'disconnected';
    this._statusListeners = new Set();

    // Configure the bridge with the document sync WebSocket endpoint.
    if (typeof window !== 'undefined') {
      bridge.configure(this.docSyncUrl);

      // Global bridge handlers for connection status aggregation
      this._unsubGlobalStatus = bridge.onGlobalStatus((_key, _status, _wsconnected, _wsconnecting) => {
        this._updateConnectionStatus();
      });

      // Global invalidation handler — clean up main-thread entry when worker
      // destroys a doc due to WS close code 4000.
      this._unsubGlobalInval = bridge.onGlobalInvalidation((key) => {
        const entry = this.docs.get(key);
        if (entry) {
          entry.bindings.forEach((b) => { try { b.destroy(); } catch (_) {} });
          entry.bindings.clear();
          entry._unsubs.forEach((fn) => fn());
          this.docs.delete(key);
          this._updateConnectionStatus();
        }
      });
    }
  }

  // ── Connection status ─────────────────────────────────────────────────────

  get connectionStatus() { return this._connectionStatus; }

  onStatusChange(cb) {
    this._statusListeners.add(cb);
    return () => this._statusListeners.delete(cb);
  }

  _updateConnectionStatus() {
    let hasConnected = false;
    let hasConnecting = false;
    for (const entry of this.docs.values()) {
      if (entry.wsconnected) hasConnected = true;
      else if (entry.wsconnecting) hasConnecting = true;
    }
    const next = hasConnected ? 'connected' : hasConnecting ? 'connecting' : 'disconnected';
    if (next !== this._connectionStatus) {
      this._connectionStatus = next;
      for (const cb of this._statusListeners) {
        try { cb(next); } catch (_) {}
      }
    }
  }

  // ── Room key helpers ──────────────────────────────────────────────────────

  _roomKey(slug, path) {
    const safePath = path || 'root';
    const scopeUserId = this.identity.hostId || this.identity.userId;
    if (scopeUserId) {
      return `workspace:${slug}:user:${encodeURIComponent(String(scopeUserId))}:${safePath}`;
    }
    return `workspace:${slug}:legacy-denied:${safePath}`;
  }

  getRoomKey(slug, path) {
    return this._roomKey(slug, path);
  }

  // ── Identity management ───────────────────────────────────────────────────

  setIdentity({ userId = null, sessionId = null, hostId = null } = {}) {
    const nextUser = userId || null;
    const nextSession = sessionId || null;
    const nextHost = hostId || null;
    const changed =
      this.identity.userId !== nextUser ||
      this.identity.sessionId !== nextSession ||
      this.identity.hostId !== nextHost;
    if (!changed) return;

    const scopeChanged =
      this.identity.userId !== nextUser || this.identity.hostId !== nextHost;

    this.identity = { userId: nextUser, sessionId: nextSession, hostId: nextHost };

    if (scopeChanged) {
      this._cachedUserImage = null;
      // Destroy all main-thread entries
      for (const [key, entry] of this.docs.entries()) {
        try {
          entry.bindings.forEach((b) => { try { b.destroy(); } catch (_) {} });
          entry.bindings.clear();
          entry._unsubs.forEach((fn) => fn());
        } catch (_) {}
        this.docs.delete(key);
      }
      // Tell worker to destroy all docs
      bridge.disconnectAll();
      this._updateConnectionStatus();
    }
  }

  // ── Document management ───────────────────────────────────────────────────

  resetDocument(slug, path, newContent) {
    const key = this._roomKey(slug, path);
    const entry = this.docs.get(key);
    if (!entry) return;
    bridge.resetContent(key, newContent);
    entry._seeded = false;
    bridge.resetSeedFlag(key);
    console.log('[Collab] Reset document content for', key);
  }

  destroyDocument(slug, path) {
    const key = this._roomKey(slug, path);
    const entry = this.docs.get(key);
    if (!entry) return;

    entry.bindings.forEach((b) => { try { b.destroy(); } catch (_) {} });
    entry.bindings.clear();
    entry._unsubs.forEach((fn) => fn());
    bridge.destroyDoc(key);
    this.docs.delete(key);
    this._updateConnectionStatus();
    console.log('[Collab] Destroyed document for', key);
  }

  destroyAllForSlug(slug) {
    const prefix = `workspace:${slug}:`;
    const keysToDestroy = [];
    for (const key of this.docs.keys()) {
      if (key.startsWith(prefix)) keysToDestroy.push(key);
    }
    for (const key of keysToDestroy) {
      const entry = this.docs.get(key);
      if (!entry) continue;
      entry.bindings.forEach((b) => { try { b.destroy(); } catch (_) {} });
      entry.bindings.clear();
      entry._unsubs.forEach((fn) => fn());
      this.docs.delete(key);
    }
    // Tell worker to destroy all matching docs (may include docs without main-thread entry)
    bridge.destroyPrefix(prefix);
    if (keysToDestroy.length > 0) {
      this._updateConnectionStatus();
      console.log(`[Collab] Destroyed ${keysToDestroy.length} documents for slug ${slug}`);
    }
  }

  // ── ensureDoc — creates a lightweight entry + worker-side CRDT doc ─────

  ensureDoc(slug, path) {
    const key = this._roomKey(slug, path);
    if (this.docs.has(key)) return this.docs.get(key);

    if (!this.identity.userId) {
      throw new Error('Authenticated user id is required for collaboration');
    }

    const entry = {
      key,
      bindings: new Set(),
      _seeded: false,
      _seedTimer: null,
      _seedDeltaUnsub: null,
      synced: false,
      wsconnected: false,
      wsconnecting: false,
      _unsubs: [],
    };

    entry._unsubs.push(
      bridge.onStatus(key, (status, wsconnected, wsconnecting) => {
        entry.wsconnected = wsconnected;
        entry.wsconnecting = wsconnecting;
        console.debug('[Collab] Provider status for', key, status);
        this._updateConnectionStatus();
      })
    );
    entry._unsubs.push(
      bridge.onSynced(key, (_content, _length) => {
        entry.synced = true;
      })
    );
    entry._unsubs.push(
      bridge.onDocReady(key, (msg) => {
        entry.synced = msg.synced;
        entry.wsconnected = msg.wsconnected;
      })
    );
    entry._unsubs.push(
      bridge.onSeedReset(key, () => {
        entry._seeded = false;
        entry.synced = false;
        entry.wsconnected = false;
        console.log('[Collab] WS non-clean close — resetting seed flag for', key);
      })
    );

    this.docs.set(key, entry);

    bridge.ensureDoc(key, {
      userId: this.identity.userId,
      ...(this.identity.sessionId ? { sessionId: this.identity.sessionId } : {}),
    });

    return entry;
  }

  getAwarenessStates(slug, path) {
    const key = this._roomKey(slug, path);
    return bridge.getAwarenessStates(key);
  }

  getActiveEditors(slug, path) {
    const key = this._roomKey(slug, path);
    const states = bridge.getAwarenessStates(key);
    const seen = new Map();
    for (const { clientId, state } of states) {
      if (!state) continue;
      if (!state.cursor) continue;
      const userId = state.user?.id ? String(state.user.id) : String(clientId);
      if (!seen.has(userId)) {
        seen.set(userId, { clientId, state });
      }
    }
    return Array.from(seen.values());
  }

  getWorkspaceActiveEditors(slug) {
    if (!slug) return [];
    const prefix = `workspace:${slug}:`;
    const seen = new Map();

    for (const [k] of this.docs.entries()) {
      if (!k.startsWith(prefix)) continue;
      const states = bridge.getAwarenessStates(k);
      for (const { clientId, state } of states) {
        if (!state) continue;
        if (!state.cursor && !state.lastActive) continue;
        const userId = state.user?.id ? String(state.user.id) : String(clientId);
        const ts = state.lastActive || 0;
        const prev = seen.get(userId);
        if (!prev || (prev.state.lastActive || 0) < ts) {
          seen.set(userId, { clientId, state, key: k });
        }
      }
    }
    return Array.from(seen.values()).map((v) => ({ clientId: v.clientId, state: v.state, key: v.key }));
  }

  // ── Awareness listeners ───────────────────────────────────────────────────

  addWorkspaceAwarenessListener(slug, cb) {
    if (typeof cb !== 'function' || !slug) return () => {};
    const prefix = `workspace:${slug}:`;

    const fire = () => {
      try { cb(this.getWorkspaceActiveEditors(slug)); }
      catch (err) { console.warn('[Collab] workspace awareness cb failed', err?.message || err); }
    };

    const detachers = new Map(); // key → unsub

    const attachToKey = (key) => {
      if (detachers.has(key)) return;
      const unsub = bridge.onAwareness(key, () => fire());
      detachers.set(key, unsub);
    };

    for (const key of this.docs.keys()) {
      if (key.startsWith(prefix)) attachToKey(key);
    }

    const poll = setInterval(() => {
      for (const key of this.docs.keys()) {
        if (key.startsWith(prefix)) attachToKey(key);
      }
    }, 2000);

    return () => {
      clearInterval(poll);
      for (const unsub of detachers.values()) unsub();
      detachers.clear();
    };
  }

  addAwarenessListener(slug, path, cb, options = {}) {
    if (typeof cb !== 'function') return () => {};
    const shouldConnect = options?.connect !== false;
    const key = this._roomKey(slug, path);

    if (shouldConnect) this.ensureDoc(slug, path);
    if (!this.docs.has(key)) return () => {};

    const roomKey = key;
    const wrapped = (states, _localClientId, changes) => {
      try { cb(states, changes); }
      catch (err) { console.warn('[Collab] awareness listener callback failed', err?.message || err); }
    };

    const unsub = bridge.onAwareness(key, wrapped);

    if (!this._awarenessListeners.has(roomKey)) this._awarenessListeners.set(roomKey, new Map());
    this._awarenessListeners.get(roomKey).set(cb, { wrapped, unsub });

    return () => this.removeAwarenessListener(slug, path, cb);
  }

  removeAwarenessListener(slug, path, cb) {
    const key = this._roomKey(slug, path);
    const map = this._awarenessListeners.get(key);
    if (!map) return;
    const rec = map.get(cb);
    if (!rec) return;
    rec.unsub();
    map.delete(cb);
    if (map.size === 0) this._awarenessListeners.delete(key);
  }

  // ── attachEditor — the main binding entrypoint ────────────────────────────

  attachEditor({ editor, monaco, slug, path, user, initialContent }) {
    if (!editor || !monaco || !slug || !path) return null;

    const entry = this.ensureDoc(slug, path);
    const key = entry.key;

    // Create or reuse Monaco model
    const uri = monaco.Uri.parse(`/synthi/${path.startsWith('/') ? path.slice(1) : path}`);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(bridge.getContent(key) || '', undefined, uri);
    }

    const providedContent = typeof initialContent === 'string' ? initialContent : '';
    const normalizeContent = (s) => (s ? s.replace(/\r\n/g, '\n').replace(/\s+$/, '') : '');

    // Cancel any pending seed timer / observer from a PREVIOUS attachEditor call
    if (entry._seedTimer) {
      clearTimeout(entry._seedTimer);
      entry._seedTimer = null;
    }
    if (entry._seedDeltaUnsub) {
      try { entry._seedDeltaUnsub(); } catch (_) {}
      entry._seedDeltaUnsub = null;
    }

    let bindingEstablished = false;
    let binding = null;

    // ── Seeding strategy (same logic as pre-worker, adapted for bridge) ──
    const SEED_WAIT_MS = 1500;

    const doSeed = () => {
      if (entry._seeded) return;

      const currentContent = bridge.getContent(key);
      if (currentContent.length > 0) {
        // Worker / server has content — sync model to it
        if (bindingEstablished && binding) {
          const modelText = model.getValue();
          if (modelText.length > 0 && normalizeContent(modelText) !== normalizeContent(currentContent)) {
            try {
              binding._applyingRemote = true;
              model.applyEdits([{ range: model.getFullModelRange(), text: currentContent }]);
            } finally {
              binding._applyingRemote = false;
            }
          }
        } else if (normalizeContent(model.getValue()) !== normalizeContent(currentContent)) {
          model.setValue(currentContent);
        }
        entry._seeded = true;
        bridge.markSeeded(key);
        return;
      }

      // Content still empty — wait for server bindState to complete
      if (!providedContent) return;

      let settled = false;

      const commit = () => {
        if (settled || entry._seeded) return;
        settled = true;
        if (entry._seedTimer) { clearTimeout(entry._seedTimer); entry._seedTimer = null; }
        if (entry._seedDeltaUnsub) { try { entry._seedDeltaUnsub(); } catch (_) {} entry._seedDeltaUnsub = null; }

        const content = bridge.getContent(key);
        if (content.length > 0) {
          // Server seeded while we waited — the binding handles model sync
          if (!bindingEstablished && normalizeContent(model.getValue()) !== normalizeContent(content)) {
            model.setValue(content);
          }
        } else {
          // GUEST GUARD: never seed from guest side
          if (this.identity.hostId) {
            console.debug('[Collab] Guest: skipping client seed, waiting for host Yjs state');
            entry._seeded = true;
            bridge.markSeeded(key);
            return;
          }
          // Client seeds — tell worker to insert content into ytext
          bridge.seedContent(key, providedContent);
          if (!bindingEstablished && normalizeContent(model.getValue()) !== normalizeContent(providedContent)) {
            model.setValue(providedContent);
          }
        }
        entry._seeded = true;
        bridge.markSeeded(key);
      };

      // React immediately when worker's ytext gets content (via remote delta)
      entry._seedDeltaUnsub = bridge.onRemoteDelta(key, (_delta, fullText) => {
        if (fullText.length > 0) commit();
      });
      // Also react to sync events (server sends content on sync)
      const unsubSeedSync = bridge.onSynced(key, (content) => {
        if (content.length > 0) commit();
        try { unsubSeedSync(); } catch (_) {}
      });

      entry._seedTimer = setTimeout(commit, SEED_WAIT_MS);
    };

    // Decide seeding path based on current state
    if (entry.synced) {
      const cachedContent = bridge.getContent(key);
      if (cachedContent.length > 0) {
        if (normalizeContent(model.getValue()) !== normalizeContent(cachedContent)) {
          model.setValue(cachedContent);
        }
        entry._seeded = true;
        bridge.markSeeded(key);
      } else if (providedContent && !entry._seeded) {
        doSeed();
      }
    } else {
      // Show the disk-provided content IMMEDIATELY so the editor isn't blank
      // during the (sometimes multi-second) CRDT sync on load/reload. This is
      // display-only and safe: it runs BEFORE the binding's local-change
      // listener is attached below, so it is NEVER pushed into the CRDT, and
      // doSeed() reconciles against the authoritative server state once synced
      // (server content wins via a guarded applyEdits; the guest guard holds).
      if (providedContent && model.getValue().length === 0) {
        model.setValue(providedContent);
      }
      // Wait for sync before the authoritative seed / reconcile.
      const unsubSyncWait = bridge.onSynced(key, (_content) => {
        try { unsubSyncWait(); } catch (_) {}
        doSeed();
      });
    }

    // Set the model on the editor if different
    if (editor.getModel() !== model) {
      editor.setModel(model);
    }

    // Clean up duplicate bindings for same model / editor
    try {
      for (const existing of Array.from(entry.bindings)) {
        if (existing && (existing.model === model || existing.editor === editor)) {
          try { existing.destroy(); } catch (_) {}
          entry.bindings.delete(existing);
        }
      }
    } catch (_) {}

    // Create the new binding
    binding = new MonacoTextBinding({ bridge, key, model, editor, monaco });
    bindingEstablished = true;
    entry.bindings.add(binding);

    // Set local awareness
    if (user) {
      let id = user.id || null;
      if (!id) {
        try {
          const storageKey = 'synthi:anonId';
          let stored = null;
          if (typeof window !== 'undefined' && window.localStorage) {
            stored = window.localStorage.getItem(storageKey);
          }
          if (stored) id = stored;
          else {
            id = String(Math.floor(Math.random() * 1000000000));
            if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(storageKey, id);
          }
        } catch (_) {
          id = String(Math.floor(Math.random() * 1000000));
        }
      }
      const name = user.name || user.email || 'Anonymous';
      const color = user.color || this._colorForUser(String(id));
      if (user.image) this._cachedUserImage = user.image;
      const image = this._cachedUserImage || null;

      bridge.setAwarenessState(key, { user: { id, name, color, image }, isUnsaved: false });
    }

    // Track connection status via bridge
    const statusHandler = (status) => console.debug('[Collab]', key, 'status', status);
    const unsubStatusLog = bridge.onStatus(key, statusHandler);

    return {
      key: entry.key,
      isApplyingRemote: () => binding._applyingRemote,
      isConnected: () => entry.wsconnected,
      updateLocalUnsaved: (isUnsaved) => {
        bridge.setAwarenessField(key, 'isUnsaved', isUnsaved);
      },
      dispose: () => {
        // Clear local awareness so we disappear from other clients immediately
        bridge.clearAwareness(key);

        try { binding.destroy(); } catch (_) {}
        entry.bindings.delete(binding);
        try { unsubStatusLog(); } catch (_) {}

        // If no bindings remain, destroy after a grace period
        if (entry.bindings.size === 0) {
          setTimeout(() => {
            if (entry.bindings.size === 0 && this.docs.has(key)) {
              entry._unsubs.forEach((fn) => fn());
              bridge.destroyDoc(key);
              this.docs.delete(key);
            }
          }, 2000);
        }
      },
    };
  }

  // ── Color helpers ─────────────────────────────────────────────────────────

  _randomColor() {
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue} 80% 50%)`;
  }

  _colorForUser(key) {
    if (!key || typeof key !== 'string') return this._randomColor();
    let h = 5381;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) + h) + key.charCodeAt(i);
    }
    const hue = Math.abs(h) % 360;
    return `hsl(${hue} 75% 48%)`;
  }

  // ── seedContentIfEmpty (async) ────────────────────────────────────────────

  async seedContentIfEmpty(slug, path, initialContent) {
    if (!slug || !path) return;
    const entry = this.ensureDoc(slug, path);
    const key = entry.key;

    // Wait for provider sync
    if (!entry.synced) {
      await new Promise((resolve) => {
        const unsub = bridge.onSynced(key, () => { unsub(); resolve(); });
        setTimeout(() => { unsub(); resolve(); }, 2000);
      });
    }

    if (entry._seeded) return;
    const content = bridge.getContent(key);
    if (content.length > 0) {
      entry._seeded = true;
      bridge.markSeeded(key);
      return;
    }

    // Wait a bit more for server bindState
    await new Promise((resolve) => setTimeout(resolve, 1500));

    if (entry._seeded) return;
    const contentAfter = bridge.getContent(key);
    if (contentAfter.length > 0) {
      entry._seeded = true;
      bridge.markSeeded(key);
      return;
    }

    // Still empty — client seeds
    if (typeof initialContent === 'string' && initialContent.length > 0) {
      bridge.seedContent(key, initialContent);
      entry._seeded = true;
    }
  }

  // ── Notification WebSocket (stays on main thread — no Yjs involved) ───────

  connectNotifications(slug, handlers = {}, scope = null) {
    if (!slug) return () => {};

    const normalizedScope =
      typeof scope === 'string'
        ? { userId: scope, sessionId: null }
        : { userId: scope?.userId || null, sessionId: scope?.sessionId || null, userEmail: scope?.userEmail || null };

    const base = this.serverUrl.replace(/\/$/, '');
    let url = `${base}/notifications?slug=${encodeURIComponent(slug)}`;
    if (normalizedScope.userId) url += `&userId=${encodeURIComponent(normalizedScope.userId)}`;
    if (normalizedScope.sessionId) url += `&sessionId=${encodeURIComponent(normalizedScope.sessionId)}`;
    if (normalizedScope.userEmail) url += `&email=${encodeURIComponent(normalizedScope.userEmail)}`;

    let ws;
    let reconnectTimer = null;
    let destroyed = false;
    let attempt = 0;

    const BACKOFF_BASE_MS = 1000;
    const BACKOFF_MAX_MS = 30_000;
    const getBackoffDelay = () => {
      const exponential = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      const jitter = exponential * (0.75 + Math.random() * 0.5);
      return Math.round(jitter);
    };

    const connect = () => {
      if (destroyed) return;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        console.warn('[Collab] Notification WS connect error:', e.message);
        scheduleReconnect();
        return;
      }

      ws.onopen = () => {
        attempt = 0;
        console.log('[Collab] Notification WS connected for slug:', slug);
        if (typeof handlers.onConnected === 'function') handlers.onConnected();
      };

      ws.onmessage = async (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'file-tree-changed' && msg.slug === slug) {
            if (typeof handlers.onFileTreeChanged === 'function') handlers.onFileTreeChanged();
          }
          if (msg.type === 'file-reverted' && msg.slug === slug) {
            // CRITICAL: Destroy affected Yjs docs IMMEDIATELY — before
            // calling external handlers and before the Yjs WebsocketProvider
            // can auto-reconnect with stale CRDT state.  The server closes
            // the Yjs WS (code 4000) during invalidation, and the provider
            // schedules a reconnect after ~100ms.  By destroying the doc
            // here (which sets provider.shouldConnect = false), we prevent
            // the stale reconnect that causes content duplication.
            const filePaths = msg.filePaths || [];
            if (filePaths.length === 0) {
              this.destroyAllForSlug(slug);
            } else {
              for (const fp of filePaths) this.destroyDocument(slug, fp);
            }
            if (typeof handlers.onFileReverted === 'function') handlers.onFileReverted(filePaths);
          }
          if (msg.type === 'doc-invalidated' && msg.slug === slug) {
            // Server invalidated CRDT docs (e.g. after git pull/checkout).
            // Destroy local Y.Docs so they reconnect with fresh state.
            const filePaths = msg.filePaths || [];
            if (filePaths.length === 0) {
              this.destroyAllForSlug(slug);
            } else {
              for (const fp of filePaths) {
                this.destroyDocument(slug, fp);
              }
            }
            if (typeof handlers.onDocInvalidated === 'function') {
              handlers.onDocInvalidated(filePaths);
            }
          }
          if (msg.type === 'git-status-changed' && msg.slug === slug) {
            if (typeof handlers.onGitStatusChanged === 'function') handlers.onGitStatusChanged(msg.filePath || null);
          }
          if (msg.type === 'file-saved' && msg.slug === slug) {
            if (typeof handlers.onFileSaved === 'function') handlers.onFileSaved(msg.filePath || null);
          }
          if (msg.type === 'container-ports' && msg.slug === slug) {
            if (typeof handlers.onContainerPorts === 'function') handlers.onContainerPorts(Array.isArray(msg.ports) ? msg.ports : []);
          }
          if (msg.type === 'auto-session-created') {
            const { default: collabSessionService } = await import('@/services/collabSessionService');
            collabSessionService._handleAutoSessionCreated(msg);
          }
          if (msg.type === 'collab-invite') {
            if (typeof handlers.onCollabInvite === 'function') handlers.onCollabInvite(msg);
          }
          if (msg.type === 'session-knock' || msg.type === 'knock') {
            const { default: collabSessionService } = await import('@/services/collabSessionService');
            collabSessionService._handleWsMessage(msg);
          }
          if (msg.type === 'permission:requested' || msg.type === 'knock:cancelled') {
            const { default: collabSessionService } = await import('@/services/collabSessionService');
            collabSessionService._handleWsMessage(msg);
          }
        } catch (_) {}
      };
      ws.onclose = () => {
        if (!destroyed) scheduleReconnect();
      };
      ws.onerror = () => {};
    };

    const scheduleReconnect = () => {
      if (reconnectTimer || destroyed) return;
      const delay = getBackoffDelay();
      attempt++;
      console.log(`[Collab] Notification WS reconnecting in ${delay}ms (attempt ${attempt})`);
      reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
    };

    connect();

    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { try { ws.close(); } catch (_) {} }
    };
  }

  // ── Disconnect all ────────────────────────────────────────────────────────

  disconnect() {
    for (const [_key, entry] of this.docs.entries()) {
      entry.bindings.forEach((b) => { try { b.destroy(); } catch (_) {} });
      entry.bindings.clear();
      entry._unsubs.forEach((fn) => fn());
    }
    this.docs.clear();
    bridge.disconnectAll();
    this._cachedUserImage = null;
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────
const defaultClient = new CollabClient();
export default defaultClient;
