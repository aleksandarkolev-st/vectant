import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
// NOTE: Some Monaco edit operations can be executed inside Monaco view event
// handling which throws when pushEditOperations / executeCommands are invoked
// re-entrantly. We'll implement a safe Monaco <-> Y.Text binding here which
// guards against re-entrancy and applies edits using editor.executeEdits
// (instead of pushEditOperations) to better cooperate with Monaco's command
// stack.

class MonacoTextBinding {
  constructor(ytext, model, editor, awareness = null, monaco = null) {
    this.ytext = ytext;
    this.model = model;
    this.editor = editor;
    this.awareness = awareness;
    this.monaco = monaco;
    this._destroyed = false;
    this._observerTimeout = null;

    // Guard flag — when we apply remote changes to Monaco we don't want
    // local change handlers to re-propagate back into Yjs producing loops.
    this._applyingRemote = false;

    // Observe Y.Text changes
    this._yObserver = (event) => {
      try {
        const newText = this.ytext.toString();
        const current = this.model.getValue();
        
        // Normalize line endings for comparison to avoid false positives on Windows
        // Monaco might normalize to CRLF while Yjs has LF or vice versa
        const normalize = (s) => s ? s.replace(/\r\n/g, '\n') : '';
        if (normalize(current) === normalize(newText)) return;

        console.log('[Collab] Remote change detected. Applying to Monaco.');
        console.log(`[Collab] Current length: ${current.length}, New length: ${newText.length}`);

        // Use setTimeout to avoid reentrancy issues when Monaco fires view events
        // synchronously — scheduling to next event loop reduces chance of
        // 'invalid edit' exceptions while being reasonably responsive.
        if (this._observerTimeout) clearTimeout(this._observerTimeout);
        this._observerTimeout = setTimeout(() => {
          if (this._destroyed) return;
          // Ensure we are still editing the same model
          if (this.editor.getModel() !== this.model) return;

          try {
            // Mark guard so local change handler (MonacoTextBinding._modelListener)
            // skips this update — prevents Yjs → Monaco → Yjs feedback loop.
            this._applyingRemote = true;
            console.debug('[Collab] _applyingRemote = true (applying remote edit)');

            // Apply the full replacement via editor.executeEdits which is
            // safer for Monaco's edit flow than manipulating model directly
            // during view events.
            this.editor.executeEdits('synthi-collab', [{ range: this.model.getFullModelRange(), text: newText }]);

          } catch (e) {
            console.warn('[Collab] failed to apply remote diff to Monaco model', e?.message || e);
          } finally {
            // Reset flag synchronously. Monaco's onDidChangeContent fires
            // synchronously during executeEdits above, so it already saw
            // the flag as true. Resetting synchronously here avoids the
            // previous requestAnimationFrame delay which left a window
            // where user keystrokes were silently swallowed.
            this._applyingRemote = false;
            console.debug('[Collab] _applyingRemote = false (reset in finally)');
          }
        }, 0);

      } catch (err) {
        console.warn('[Collab] ytext observer error', err?.message || err);
      }
    };

    // Track remote decorations per clientId
    this._remoteDecorations = new Map(); // clientId -> { ids: [decorationIds], meta }
    // Content widgets fallback (per-client) for very-visible caret rendering
    this._contentWidgets = new Map(); // clientId -> { widgetObj, dom }

    // awareness integration - show remote cursors/selections and publish local cursor
    this._awareness = awareness;
    this._awarenessHandler = null;

    if (this._awareness) {
      // Listen for remote presence changes and update decorations
      this._awarenessHandler = (changes) => {
        try {
          // compute current states and update decorations
          const states = Array.from(this._awareness.getStates().entries()).map(([clientId, state]) => ({ clientId, state }));
          this._applyAwarenessDecorations(states);
        } catch (err) {
          console.warn('[Collab] awareness change handler failed', err?.message || err);
        }
      };
      try { this._awareness.on('change', this._awarenessHandler); } catch (_) { /* ignore if API differs */ }
    }

    // Publish local selection/cursor to awareness whenever editor selection changes
    this._cursorListener = editor.onDidChangeCursorSelection((ev) => {
      if (!this._awareness) return;
      try {
        const sel = ev.selection;
        const cursorState = {
          cursor: {
            anchor: { line: sel.selectionStartLineNumber, column: sel.selectionStartColumn },
            head: { line: sel.positionLineNumber, column: sel.positionColumn },
            range: { start: { line: sel.startLineNumber, column: sel.startColumn }, end: { line: sel.endLineNumber, column: sel.endColumn } }
          }
        };
        // set only the fields we care about
        this._awareness.setLocalStateField('cursor', cursorState.cursor);
        try {
          this._awareness.setLocalStateField('lastActive', Date.now());
        } catch (_) {}
      } catch (err) {
        // don't let cursor update errors break editing
      }
    });

    // When the Monaco model changes locally, reflect into Yjs
    this._modelListener = this.model.onDidChangeContent((e) => {
      if (this._applyingRemote) return;
      if (this._destroyed) return; // Don't write if binding is destroyed
      // Skip changes that came from our own collab edits (check source/origin)
      // Monaco's executeEdits passes a source string we can check
      if (e.isFlush) return; // setValue or similar bulk operation, skip to avoid loops
      // Verify we're still the active model on the editor
      if (this.editor.getModel() !== this.model) {
        console.debug('[Collab] Ignoring model change for inactive model');
        return;
      }
      try {
        const value = this.model.getValue();
        const doc = this.ytext.doc;
        if (!doc) return;
        
        // Check if ytext already has this exact content to avoid redundant writes
        const currentYtext = this.ytext.toString();
        if (currentYtext === value) return;
        
        // Full replace for now — later can patch using diffs for efficiency
        doc.transact(() => {
          this.ytext.delete(0, this.ytext.length);
          this.ytext.insert(0, value);
        });
      } catch (err) {
        console.warn('[Collab] error writing Monaco change to Yjs', err?.message || err);
      }
    });

    this.ytext.observe(this._yObserver);
  }

  destroy() {
    this._destroyed = true;
    if (this._observerTimeout) clearTimeout(this._observerTimeout);
    try { this.ytext.unobserve(this._yObserver); } catch (_) {}
    try { this._modelListener.dispose(); } catch (_) {}
    try { this._cursorListener?.dispose?.(); } catch (_) {}
    try {
      if (this._awareness && this._awarenessHandler) this._awareness.off('change', this._awarenessHandler);
    } catch (_) {}
    // remove remote decorations
    try {
      for (const [cid, rec] of this._remoteDecorations.entries()) {
        try { this.editor.deltaDecorations(rec.ids || [], []); } catch (_) {}
      }
      this._remoteDecorations.clear();
      // remove content widgets too
      for (const [cid, rec] of this._contentWidgets.entries()) {
        try { this.editor.removeContentWidget(rec.widgetObj); } catch (_) {}
        try { rec.dom?.remove?.(); } catch (_) {}
      }
      this._contentWidgets.clear();
    } catch (_) {}
  }

  // Apply awareness states into Monaco decorations
  _applyAwarenessDecorations(states) {
    try {
      const wanted = new Map();
      const localClientId = this._awareness?.clientID;
      const seenUsers = new Map();

      for (const s of states) {
        const cid = s.clientId;
        const st = s.state || {};
        if (!st || cid === localClientId) continue;
        const user = st.user || {};
        if (!st.cursor) continue;
        
        // Dedup users
        const userKey = user.id ? String(user.id) : String(cid);
        if (seenUsers.has(userKey)) continue;

        const range = this._toMonacoRange(st.cursor.range || st.cursor);
        if (!range) continue;

        seenUsers.set(userKey, { clientId: cid, state: st, range, user });
      }

      for (const [, val] of seenUsers.entries()) {
        const cid = val.clientId;
        const user = val.user || {};
        const range = val.range;
        const color = user.color || '#888';
        wanted.set(cid, { range, color, name: user.name || 'Anonymous' });
      }

      // 1. CLEANUP: Remove decorations/widgets for users who left
      for (const [cid, rec] of this._remoteDecorations.entries()) {
        if (!wanted.has(cid)) {
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

      // 2. RENDER: Add/Update decorations for active users
      for (const [cid, info] of wanted.entries()) {
        // --- A. Handle Selection (Background Highlight) via Decorations ---
        const selectionClass = `collab-selection-${cid}`;
        this._ensureStyleForClient(cid, info.color);

        const decs = [];
        if (info.range && !info.range.isEmpty()) {
          decs.push({
            range: info.range,
            options: {
              className: selectionClass, // Selection background
              stickiness: 1,
              zIndex: 10 // Ensure it's visible
            }
          });
        }

        const existingDec = this._remoteDecorations.get(cid);
        const oldIds = existingDec?.ids || [];
        const newIds = this.editor.deltaDecorations(oldIds, decs);
        this._remoteDecorations.set(cid, { ids: newIds, meta: info });

        // --- B. Handle Cursor & Name Tag via ContentWidget (Figma Style) ---
        // We calculate the position at the END of the selection (the head)
        const headPos = info.range.getEndPosition();
        
        let widgetRec = this._contentWidgets.get(cid);
        
        // If widget doesn't exist, create the DOM structure
        if (!widgetRec) {
          const dom = document.createElement('div');
          // Base container
          dom.className = 'synthi-cursor-widget';
          dom.style.backgroundColor = info.color; // The vertical bar color

          // The Label (Name Tag)
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
              preference: [0] // 0 = EXACT position
            })
          };

          this.editor.addContentWidget(widgetObj);
          widgetRec = { widgetObj, dom, currentLine: headPos.lineNumber, currentCol: headPos.column };
          this._contentWidgets.set(cid, widgetRec);
        } else {
            // Update existing widget position
            // We have to remove and re-add to force Monaco to update the position cleanly
            // or we can just update the internal reference if we implemented a dynamic getPosition.
            // Re-adding is safer for sync.
            if(widgetRec.currentLine !== headPos.lineNumber || widgetRec.currentCol !== headPos.column) {
                // Update internal position data for the closure
                widgetRec.widgetObj.getPosition = () => ({
                    position: { lineNumber: headPos.lineNumber, column: headPos.column },
                    preference: [0]
                });
                
                this.editor.layoutContentWidget(widgetRec.widgetObj);
                widgetRec.currentLine = headPos.lineNumber;
                widgetRec.currentCol = headPos.column;
            }
            
            // Update text/color just in case
            widgetRec.dom.style.backgroundColor = info.color;
            const label = widgetRec.dom.querySelector('.synthi-cursor-label');
            if(label) {
                label.style.backgroundColor = info.color;
                label.textContent = info.name;
            }
        }
      }

    } catch (err) {
      console.warn('[Collab] Decorations error', err);
    }
  }

  _toMonacoRange(raw) {
    try {
      const start = raw.start || raw.anchor || { line: raw.anchor?.line || raw.startLineNumber, column: raw.anchor?.column || raw.startColumn };
      const end = raw.end || raw.head || { line: raw.head?.line || raw.endLineNumber, column: raw.head?.column || raw.endColumn };
      const sLine = start.line || start.selectionStartLineNumber || raw.startLineNumber;
      const sCol = start.column || start.selectionStartColumn || raw.startColumn;
      const eLine = end.line || end.selectionEndLineNumber || raw.endLineNumber || raw.positionLineNumber;
      const eCol = end.column || end.selectionEndColumn || raw.endColumn || raw.positionColumn;
      if (!sLine || !sCol || !eLine || !eCol) return null;
      const M = this.monaco || ((typeof window !== 'undefined' && window.monaco) ? window.monaco : null);
      if (!M) return null;
      return new M.Range(sLine, sCol, eLine, eCol);
    } catch (_) { return null; }
  }

  _ensureStyleForClient(clientId, color) {
    const styleId = `synthi-collab-style-${clientId}`;
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    
    // Convert color to transparent version for selection
    let selectionColor = color;
    if(color.startsWith('#')) {
        // Simple Hex to RGBA conversion
        const r = parseInt(color.substring(1,3), 16);
        const g = parseInt(color.substring(3,5), 16);
        const b = parseInt(color.substring(5,7), 16);
        selectionColor = `rgba(${r}, ${g}, ${b}, 0.3)`;
    } else if (color.startsWith('hsl')) {
        selectionColor = color.replace('hsl', 'hsla').replace(')', ', 0.3)');
    }

    style.innerHTML = `
      .collab-selection-${clientId} {
        background-color: ${selectionColor};
        border-bottom: 2px solid ${color};
        opacity: 0.5;
      }
    `;
    document.head.appendChild(style);
  }
}

// Small client wrapper for workspace collaboration with Yjs.
// - Creates/maintains a Y.Doc per workspace:file
// - Connects via y-websocket provider
// - Creates MonacoBinding when a Monaco model is available

class CollabClient {
  constructor(serverUrl) {
    // Derive WebSocket URL from the env var used everywhere else, or fall back
    // to auto-detecting from the current page's location.
    if (serverUrl) {
      this.serverUrl = serverUrl;
    } else if (typeof process !== 'undefined' && process.env && process.env.NEXT_PUBLIC_COLLAB_SERVER_URL) {
      // Convert http(s) URL to ws(s) URL
      this.serverUrl = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL
        .replace(/^http:/, 'ws:')
        .replace(/^https:/, 'wss:');
    } else if (typeof window !== 'undefined') {
      const proto = window.location.protocol === 'https:' ? 'wss' : 'ws';
      const host = window.location.hostname;
      const port = process.env.NEXT_PUBLIC_COLLAB_PORT || '1234';
      this.serverUrl = `${proto}://${host}:${port}`;
    } else {
      this.serverUrl = 'ws://localhost:1234';
    }
    this.docs = new Map(); // key -> {doc, provider, bindings: Set}
    // awareness listener registry: key -> Map<originalCb, wrappedCb>
    this._awarenessListeners = new Map();

    // ── Connection status tracking ──
    // Aggregated status across all active providers: 'connected' | 'connecting' | 'disconnected'
    this._connectionStatus = 'disconnected';
    this._statusListeners = new Set();
  }

  /**
   * Current aggregate connection status.
   * @returns {'connected'|'connecting'|'disconnected'}
   */
  get connectionStatus() { return this._connectionStatus; }

  /**
   * Subscribe to connection status changes.
   * @param {(status: string) => void} cb
   * @returns {() => void} unsubscribe function
   */
  onStatusChange(cb) {
    this._statusListeners.add(cb);
    return () => this._statusListeners.delete(cb);
  }

  /** Re-derive aggregate status from all active providers */
  _updateConnectionStatus() {
    let hasConnected = false;
    let hasConnecting = false;
    for (const entry of this.docs.values()) {
      if (entry.provider?.wsconnected) hasConnected = true;
      else if (entry.provider?.wsconnecting) hasConnecting = true;
    }
    const next = hasConnected ? 'connected'
      : hasConnecting ? 'connecting'
      : 'disconnected';
    if (next !== this._connectionStatus) {
      this._connectionStatus = next;
      for (const cb of this._statusListeners) {
        try { cb(next); } catch (_) { /* ignore listener errors */ }
      }
    }
  }

  _roomKey(slug, path) {
    // Use the raw file path without sanitization. The server's parseDocName
    // extracts the path as-is from the room name, so any client-side
    // sanitization would cause a mismatch: the server would look for the
    // sanitized path on disk and fail to find it.
    const safePath = path || 'root';
    return `workspace:${slug}:${safePath}`;
  }

  /**
   * Reset/invalidate a document's content, forcing a fresh load from the server.
   * Used when local filesystem has changed (e.g., merge conflicts).
   */
  resetDocument(slug, path, newContent) {
    const key = this._roomKey(slug, path);
    const entry = this.docs.get(key);
    if (!entry) return;

    try {
      // Update the Yjs document with the new content
      entry.doc.transact(() => {
        if (entry.ytext.length > 0) {
          entry.ytext.delete(0, entry.ytext.length);
        }
        if (newContent) {
          entry.ytext.insert(0, newContent);
        }
      });
      // Reset the seeded flag so the content can be refreshed
      entry._seeded = false;
      console.log('[Collab] Reset document content for', key);
    } catch (e) {
      console.warn('[Collab] Failed to reset document:', e);
    }
  }

  /**
   * Destroy and remove a document from the cache, forcing a fresh connection on next access.
   */
  destroyDocument(slug, path) {
    const key = this._roomKey(slug, path);
    const entry = this.docs.get(key);
    if (!entry) return;

    try {
      // Dispose all bindings
      entry.bindings.forEach(binding => {
        try { binding.destroy(); } catch (_) {}
      });
      entry.bindings.clear();
      
      // Destroy provider and doc
      try { entry.provider.destroy(); } catch (_) {}
      try { entry.doc.destroy(); } catch (_) {}
      
      this.docs.delete(key);
      this._updateConnectionStatus();
      console.log('[Collab] Destroyed document for', key);
    } catch (e) {
      console.warn('[Collab] Failed to destroy document:', e);
    }
  }

  /**
   * Destroy ALL cached documents for a workspace slug.
   * Used after operations that change multiple files on disk (pull,
   * checkout, discard-all) so that stale CRDT state is never merged
   * with fresh server content on reconnect.
   *
   * @param {string} slug — Workspace slug
   */
  destroyAllForSlug(slug) {
    const prefix = `workspace:${slug}:`;
    const keysToDestroy = [];
    for (const key of this.docs.keys()) {
      if (key.startsWith(prefix)) keysToDestroy.push(key);
    }
    for (const key of keysToDestroy) {
      const entry = this.docs.get(key);
      if (!entry) continue;
      try {
        entry.bindings.forEach(binding => {
          try { binding.destroy(); } catch (_) {}
        });
        entry.bindings.clear();
        try { entry.provider.destroy(); } catch (_) {}
        try { entry.doc.destroy(); } catch (_) {}
        this.docs.delete(key);
      } catch (e) {
        console.warn('[Collab] Failed to destroy document:', key, e);
      }
    }
    if (keysToDestroy.length > 0) {
      this._updateConnectionStatus();
      console.log(`[Collab] Destroyed ${keysToDestroy.length} documents for slug ${slug}`);
    }
  }

  ensureDoc(slug, path) {
    const key = this._roomKey(slug, path);
    if (this.docs.has(key)) return this.docs.get(key);

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.serverUrl, key, doc, { connect: true });
    provider.on('status', (ev) => {
      console.debug('[Collab] Provider status for', key, ev.status);
      this._updateConnectionStatus();
    });

    // text element to use as monaco binding
    const ytext = doc.getText('monaco');

    const entry = { key, doc, provider, ytext, bindings: new Set() };
    this.docs.set(key, entry);
    return entry;
  }

  getAwarenessStates(slug, path) {
    const entry = this.docs.get(this._roomKey(slug, path));
    if (!entry || !entry.provider || !entry.provider.awareness) return [];
    const states = [];
    entry.provider.awareness.getStates().forEach((value, key) => {
      states.push({ clientId: key, state: value });
    });
    return states;
  }

  // Return only active editors for the room: states that include a cursor
  // and deduplicate by user.id (fall back to clientId) so we don't show
  // multiple entries for the same logical user.
  getActiveEditors(slug, path) {
    const entry = this.docs.get(this._roomKey(slug, path));
    if (!entry || !entry.provider || !entry.provider.awareness) return [];
    const seen = new Map(); // key -> { clientId, state }
    entry.provider.awareness.getStates().forEach((state, clientId) => {
      if (!state) return;
      if (!state.cursor) return; // only editors with cursor are "active"
      const userId = (state.user && state.user.id) ? String(state.user.id) : String(clientId);
      if (!seen.has(userId)) {
        seen.set(userId, { clientId, state });
      }
    });
    // return as array
    return Array.from(seen.values()).map(({ clientId, state }) => ({ clientId, state }));
  }

  // Aggregate active editors for an entire workspace (any file in this.docs map)
  getWorkspaceActiveEditors(slug) {
    if (!slug) return [];
    const prefix = `workspace:${slug}:`;
    const seen = new Map();

    for (const [k, entry] of this.docs.entries()) {
      if (!k.startsWith(prefix)) continue;
      if (!entry.provider || !entry.provider.awareness) continue;
      entry.provider.awareness.getStates().forEach((state, clientId) => {
        if (!state) return;
        if (!state.cursor && !state.lastActive) return; // ignore totally idle states
        const userId = (state.user && state.user.id) ? String(state.user.id) : String(clientId);
        // keep the most recent variant if duplicates
        const prev = seen.get(userId);
        const ts = state.lastActive || 0;
        if (!prev || (prev.state.lastActive || 0) < ts) {
          seen.set(userId, { clientId, state, key: k });
        }
      });
    }

    return Array.from(seen.values()).map(v => ({ clientId: v.clientId, state: v.state }));
  }

  // ── Workspace-level awareness ──────────────────────────────────────────

  /**
   * Subscribe to awareness changes across ALL rooms for a given slug.
   * The callback receives the deduplicated active-editor list (same shape
   * as getWorkspaceActiveEditors) whenever any room's awareness changes.
   *
   * Returns an unsubscribe function.
   */
  addWorkspaceAwarenessListener(slug, cb) {
    if (typeof cb !== 'function' || !slug) return () => {};
    const prefix = `workspace:${slug}:`;

    // Wrapped handler fires the aggregated snapshot
    const fire = () => {
      try { cb(this.getWorkspaceActiveEditors(slug)); }
      catch (err) { console.warn('[Collab] workspace awareness cb failed', err?.message || err); }
    };

    // Attach to every existing room that matches the slug
    const detachers = new Map(); // key -> off()

    const attachToEntry = (entry) => {
      if (detachers.has(entry.key)) return; // already subscribed
      if (!entry.provider?.awareness) return;
      const handler = () => fire();
      entry.provider.awareness.on('change', handler);
      detachers.set(entry.key, () => {
        try { entry.provider.awareness.off('change', handler); } catch (_) {}
      });
    };

    for (const [k, entry] of this.docs.entries()) {
      if (k.startsWith(prefix)) attachToEntry(entry);
    }

    // Watch for new docs being added (ensureDoc) — poll cheaply via interval
    const poll = setInterval(() => {
      for (const [k, entry] of this.docs.entries()) {
        if (k.startsWith(prefix)) attachToEntry(entry);
      }
    }, 2000);

    // Return unsubscribe
    return () => {
      clearInterval(poll);
      for (const off of detachers.values()) off();
      detachers.clear();
    };
  }

  // Subscribe to awareness change events for a room and receive current states
  addAwarenessListener(slug, path, cb) {
    if (typeof cb !== 'function') return () => {};
    const entry = this.ensureDoc(slug, path);
    if (!entry || !entry.provider || !entry.provider.awareness) return () => {};

    const key = entry.key;
    const wrapped = (changes) => {
      try {
        const states = this.getAwarenessStates(slug, path);
        cb(states, changes);
      } catch (err) {
        console.warn('[Collab] awareness listener callback failed', err?.message || err);
      }
    };

    // save wrapper reference so it can be removed
    if (!this._awarenessListeners.has(key)) this._awarenessListeners.set(key, new Map());
    this._awarenessListeners.get(key).set(cb, wrapped);
    try { entry.provider.awareness.on('change', wrapped); } catch (_) {}

    // return unsubscribe helper
    return () => this.removeAwarenessListener(slug, path, cb);
  }

  removeAwarenessListener(slug, path, cb) {
    const key = this._roomKey(slug, path);
    const entry = this.docs.get(key);
    if (!entry || !entry.provider || !entry.provider.awareness || !this._awarenessListeners.has(key)) return;
    const map = this._awarenessListeners.get(key);
    const wrapped = map.get(cb);
    if (!wrapped) return;
    try { entry.provider.awareness.off('change', wrapped); } catch (_) {}
    map.delete(cb);
    if (map.size === 0) this._awarenessListeners.delete(key);
  }

  attachEditor({ editor, monaco, slug, path, user, initialContent }) {
    if (!editor || !monaco || !slug || !path) return null;

    const entry = this.ensureDoc(slug, path);

    // Create or reuse model with a uri matching existing pattern
    const uri = monaco.Uri.parse(`/synthi/${path.startsWith('/') ? path.slice(1) : path}`);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(entry.ytext.toString() || '', undefined, uri);
    }

    // IMPORTANT: Use the explicit initialContent passed from Redux store
    // Do NOT use editor.getModel().getValue() as that may have stale content
    // from a previously opened file, causing content duplication.
    const providedContent = typeof initialContent === 'string' ? initialContent : '';
    
    // Determine which content source to use:
    // 1. If ytext has content (from server/other clients), use it (authoritative)
    // 2. If ytext is empty but initialContent was provided, seed ytext with it
    // 3. If both empty, nothing to do
    // 
    // CRITICAL: We must wait for the provider to sync before deciding ytext is empty.
    // Otherwise we race: ytext appears empty, we seed with initialContent, then
    // server sends the real content and Yjs merges them → content doubles.
    // 
    // Check if provider is synced; if not, delay seeding until sync event.
    const isSynced = entry.provider.synced;
    const ytextContent = entry.ytext.toString();
    const ytextHasContent = ytextContent.length > 0;
    const hasProvidedContent = providedContent.length > 0;
    
    // Track if we've already seeded this doc to prevent double-seeding
    if (!entry._seeded) {
      entry._seeded = false;
    }
    
    const doSeed = () => {
      // Only seed once per doc lifecycle
      if (entry._seeded) return;
      
      const currentYtext = entry.ytext.toString();
      if (currentYtext.length > 0) {
        // Ytext has content now (from server), use it
        if (model.getValue() !== currentYtext) {
          model.setValue(currentYtext);
        }
        entry._seeded = true;
      } else if (hasProvidedContent) {
        // Ytext is truly empty after sync, seed with provided content
        entry.doc.transact(() => {
          if (entry.ytext.length > 0) {
            entry.ytext.delete(0, entry.ytext.length);
          }
          entry.ytext.insert(0, providedContent);
        });
        if (model.getValue() !== providedContent) {
          model.setValue(providedContent);
        }
        entry._seeded = true;
      }
    };
    
    if (isSynced) {
      // Provider already synced, safe to seed now
      if (ytextHasContent) {
        // Ytext is authoritative - sync model to ytext content
        if (model.getValue() !== ytextContent) {
          model.setValue(ytextContent);
        }
        entry._seeded = true;
      } else if (hasProvidedContent && !entry._seeded) {
        doSeed();
      }
    } else {
      // Wait for sync before seeding to avoid racing with server content
      const syncHandler = () => {
        entry.provider.off('sync', syncHandler);
        doSeed();
      };
      entry.provider.on('sync', syncHandler);
      
      // Set model content optimistically so user sees something
      // but don't write to ytext yet
      if (model.getValue() !== providedContent && hasProvidedContent) {
        model.setValue(providedContent);
      }
    }
    
    // Now set the model on the editor if different
    const currentModel = editor.getModel();
    if (currentModel !== model) {
      editor.setModel(model);
    }

    // CLEANUP: Ensure we don't create duplicate bindings for the same model
    // or editor instance. If there is an existing binding for this model or
    // editor, destroy it and remove it from the entry.bindings set to avoid
    // duplicate writes that could cause the file content to double/grow.
    try {
      for (const existing of Array.from(entry.bindings)) {
        try {
          if (existing && (existing.model === model || existing.editor === editor)) {
            try { existing.destroy(); } catch (_) {}
            entry.bindings.delete(existing);
          }
        } catch (_) { /* ignore iteration/destroy errors */ }
      }
    } catch (_) {}

    const binding = new MonacoTextBinding(entry.ytext, model, editor, entry.provider.awareness, monaco);

    // Set local awareness if user provided
    if (user && entry.provider && entry.provider.awareness) {
      // Determine a stable id: prefer authenticated user id; otherwise
      // persist an anonymous client id in localStorage so the same user
      // across multiple tabs/devices gets the same identity and color.
      let id = user.id || null;
      if (!id) {
        try {
          const key = 'synthi:anonId';
          let stored = null;
          if (typeof window !== 'undefined' && window.localStorage) {
            stored = window.localStorage.getItem(key);
          }
          if (stored) id = stored;
          else {
            id = String(Math.floor(Math.random() * 1000000000));
            if (typeof window !== 'undefined' && window.localStorage) window.localStorage.setItem(key, id);
          }
        } catch (_) {
          id = String(Math.floor(Math.random() * 1000000));
        }
      }
      const name = user.name || user.email || 'Anonymous';
      const color = user.color || this._colorForUser(String(id));
      const image = user.image || null;

      const localState = { user: { id, name, color, image }, isUnsaved: false };
      entry.provider.awareness.setLocalState(localState);
    }

    entry.bindings.add(binding);

    // Listen for connection/disconnection and forward to console for observability
    const statusHandler = ({ status }) => console.debug('[Collab]', entry.key, 'status', status);
    entry.provider.on('status', statusHandler);

    // Track connection status
    let wsConnected = entry.provider.wsconnected || false;
    const connectionHandler = ({ status }) => {
      wsConnected = (status === 'connected');
    };
    entry.provider.on('status', connectionHandler);

    // Return an object that allows cleanup
    return {
      key: entry.key,
      // Expose method to check if remote changes are being applied
      // This allows the Editor to skip Redux updates during remote sync
      isApplyingRemote: () => binding._applyingRemote,
      // Expose WebSocket connection status
      isConnected: () => entry.provider.wsconnected || wsConnected,
      updateLocalUnsaved: (isUnsaved) => {
        if (entry.provider && entry.provider.awareness) {
            const current = entry.provider.awareness.getLocalState();
            if (current && current.isUnsaved !== isUnsaved) {
                entry.provider.awareness.setLocalStateField('isUnsaved', isUnsaved);
            }
        }
      },
      dispose: () => {
        // Explicitly clear local awareness state so we disappear immediately
        if (entry.provider && entry.provider.awareness) {
            try { entry.provider.awareness.setLocalState(null); } catch (_) {}
        }

        try {
          binding.destroy();
        } catch (e) { /* ignore */ }
        entry.bindings.delete(binding);
        // If no bindings remain, we can optionally destroy the provider after a timeout
        if (entry.bindings.size === 0) {
          setTimeout(() => {
            if (entry.bindings.size === 0) {
              try { entry.provider.destroy(); } catch (e) { /* ignore */ }
              try { entry.doc.destroy(); } catch (e) { /* ignore */ }
              this.docs.delete(entry.key);
            }
          }, 2000); // cleanup after 2s of inactivity
        }
      }
    };
  }

  _randomColor() {
    const hue = Math.floor(Math.random() * 360);
    return `hsl(${hue} 80% 50%)`;
  }

  // Deterministically generate a color for a given user identifier so the same
  // user gets the same color across multiple sessions/devices.
  _colorForUser(key) {
    if (!key || typeof key !== 'string') return this._randomColor();
    // simple djb2-like hash
    let h = 5381;
    for (let i = 0; i < key.length; i++) {
      h = ((h << 5) + h) + key.charCodeAt(i); /* h * 33 + c */
    }
    const hue = Math.abs(h) % 360;
    // Use strong saturation/lightness for readability
    return `hsl(${hue} 75% 48%)`;
  }

  async seedContentIfEmpty(slug, path, initialContent) {
    if (!slug || !path) return;
    const entry = this.ensureDoc(slug, path);
    
    // Wait for provider to sync before deciding if ytext is empty
    // This prevents racing with server content
    if (!entry.provider.synced) {
      await new Promise(resolve => {
        const handler = () => {
          entry.provider.off('sync', handler);
          resolve();
        };
        entry.provider.on('sync', handler);
        // Fallback timeout in case sync never fires
        setTimeout(() => {
          entry.provider.off('sync', handler);
          resolve();
        }, 2000);
      });
    }
    
    // Only seed if truly empty and not already seeded
    if (entry._seeded) return;
    if (entry.ytext.length === 0 && typeof initialContent === 'string' && initialContent.length > 0) {
      entry.doc.transact(() => {
        // Double-check length inside transaction
        if (entry.ytext.length === 0) {
          entry.ytext.insert(0, initialContent);
        }
      });
      entry._seeded = true;
    }
  }

  /**
   * Connect to the server's notification WebSocket for a workspace.
   * Listens for server-side events (e.g., file-tree-changed) and
   * invokes registered callbacks.
   *
   * @param {string} slug - workspace slug
   * @param {{ onFileTreeChanged?: Function }} handlers - event callbacks
   * @returns {Function} teardown function to close the connection
   */
  connectNotifications(slug, handlers = {}, userId = null) {
    if (!slug) return () => {};

    // Build ws(s) URL for /notifications
    const base = this.serverUrl.replace(/\/$/, '');
    let url = `${base}/notifications?slug=${encodeURIComponent(slug)}`;
    if (userId) url += `&userId=${encodeURIComponent(userId)}`;

    let ws;
    let reconnectTimer = null;
    let destroyed = false;
    let attempt = 0;

    // Exponential backoff: 1s → 2s → 4s → … → 30s cap, plus ±25% jitter
    const BACKOFF_BASE_MS = 1000;
    const BACKOFF_MAX_MS  = 30_000;

    const getBackoffDelay = () => {
      const exponential = Math.min(BACKOFF_BASE_MS * 2 ** attempt, BACKOFF_MAX_MS);
      const jitter = exponential * (0.75 + Math.random() * 0.5); // ±25%
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
        attempt = 0; // Reset backoff on successful connection
        console.log('[Collab] Notification WS connected for slug:', slug);
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(ev.data);
          if (msg.type === 'file-tree-changed' && msg.slug === slug) {
            if (typeof handlers.onFileTreeChanged === 'function') {
              handlers.onFileTreeChanged();
            }
          }
          if (msg.type === 'file-reverted' && msg.slug === slug) {
            if (typeof handlers.onFileReverted === 'function') {
              handlers.onFileReverted(msg.filePaths || []);
            }
          }
          if (msg.type === 'git-status-changed' && msg.slug === slug) {
            if (typeof handlers.onGitStatusChanged === 'function') {
              handlers.onGitStatusChanged(msg.filePath || null);
            }
          }
        } catch (_) {
          // Not JSON — ignore
        }
      };
      ws.onclose = () => {
        if (!destroyed) scheduleReconnect();
      };
      ws.onerror = () => {
        // onclose will fire after this
      };
    };

    const scheduleReconnect = () => {
      if (reconnectTimer || destroyed) return;
      const delay = getBackoffDelay();
      attempt++;
      console.log(`[Collab] Notification WS reconnecting in ${delay}ms (attempt ${attempt})`);
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        connect();
      }, delay);
    };

    connect();

    // Return teardown function
    return () => {
      destroyed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) { try { ws.close(); } catch (_) {} }
    };
  }

  disconnect() {
    for (const [k, entry] of this.docs.entries()) {
      try { entry.provider.destroy(); } catch (e) { /* ignore */ }
      try { entry.doc.destroy(); } catch (e) { /* ignore */ }
    }
    this.docs.clear();
  }
}

const defaultClient = new CollabClient();
export default defaultClient;
