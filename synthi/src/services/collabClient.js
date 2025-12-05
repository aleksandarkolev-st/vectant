import * as Y from 'yjs';
import { WebsocketProvider } from 'y-websocket';
// NOTE: Some Monaco edit operations can be executed inside Monaco view event
// handling which throws when pushEditOperations / executeCommands are invoked
// re-entrantly. We'll implement a safe Monaco <-> Y.Text binding here which
// guards against re-entrancy and applies edits using editor.executeEdits
// (instead of pushEditOperations) to better cooperate with Monaco's command
// stack.

class MonacoTextBinding {
  constructor(ytext, model, editor, awareness = null) {
    this.ytext = ytext;
    this.model = model;
    this.editor = editor;
    this.awareness = awareness;

    // Guard flag — when we apply remote changes to Monaco we don't want
    // local change handlers to re-propagate back into Yjs producing loops.
    this._applyingRemote = false;

    // Observe Y.Text changes
    this._yObserver = (event) => {
      try {
        const newText = this.ytext.toString();
        const current = this.model.getValue();
        if (current === newText) return;

        // Use setTimeout to avoid reentrancy issues when Monaco fires view events
        // synchronously — scheduling to next event loop reduces chance of
        // 'invalid edit' exceptions while being reasonably responsive.
        setTimeout(() => {
          try {
            // Mark guard so local change handler skips this update
            this._applyingRemote = true;

            // Apply the full replacement via editor.executeEdits which is
            // safer for Monaco's edit flow than manipulating model directly
            // during view events.
            this.editor.executeEdits('synthi-collab', [{ range: this.model.getFullModelRange(), text: newText }]);

          } catch (e) {
            console.warn('[Collab] failed to apply remote diff to Monaco model', e?.message || e);
          } finally {
            // Small delay before lifting guard to allow Monaco to stabilize
            setTimeout(() => { this._applyingRemote = false; }, 0);
          }
        }, 0);

      } catch (err) {
        console.warn('[Collab] ytext observer error', err?.message || err);
      }
    };

    // Track remote decorations per clientId
    this._remoteDecorations = new Map(); // clientId -> { ids: [decorationIds], meta }

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
      try {
        const value = this.model.getValue();
        const doc = this.ytext.doc;
        if (!doc) return;
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
    } catch (_) {}
  }

  // Apply awareness states into Monaco decorations
  _applyAwarenessDecorations(states) {
    try {
      // Build a map of current decorations that should exist
      const wanted = new Map();
      const localClientId = this._awareness?.clientID;

      // Deduplicate by logical user id (state.user.id) so multiple clientIDs
      // from the same user don't show multiple badges.
      const seenUsers = new Map();
      for (const s of states) {
        const cid = s.clientId;
        const st = s.state || {};
        if (!st || cid === localClientId) continue;
        const user = st.user || {};
        if (!st.cursor) continue;
        const userKey = user.id ? String(user.id) : String(cid);
        // If we've already seen this logical user, skip additional clientIDs
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
        const lastActive = val.state?.lastActive || 0;
        wanted.set(cid, { range, color, name: user.name || 'User', lastActive });
      }

      // Remove any decorations that are no longer wanted
      for (const [cid, rec] of this._remoteDecorations.entries()) {
        if (!wanted.has(cid)) {
          try {
            this.editor.deltaDecorations(rec.ids || [], []);
          } catch (_) {}
          this._remoteDecorations.delete(cid);
        }
      }

      // Add/Update decorations for wanted clients
      for (const [cid, info] of wanted.entries()) {
        const existing = this._remoteDecorations.get(cid);
        const cursorClass = `collab-remote-cursor-${cid}`;
        const selectionClass = `collab-remote-selection-${cid}`;

        // Ensure styles exist (provide display name for initials in badge)
        this._ensureStyleForClient(cid, info.color, info.name);

        // Compose decorations: selection (if range non-empty), caret, and line badge (glyph margin)
        const decs = [];
        // selection
        const isRecent = (info.lastActive && (Date.now() - info.lastActive) < 5000);
        if (!info.range.isEmpty()) {
          decs.push({ range: info.range, options: { inlineClassName: selectionClass + (isRecent ? ` collab-recent-${cid}` : '') } });
        }
        // caret (use head position collapsed range)
        const M = (typeof window !== 'undefined' && window.monaco) ? window.monaco : null;
        const headRange = info.range.getEndPosition().equals(info.range.getStartPosition()) ? info.range : (M ? new M.Range(info.range.endLineNumber, info.range.endColumn, info.range.endLineNumber, info.range.endColumn) : info.range);
        // Use inlineClassName for zero-length caret ranges so Monaco will render
        // the caret reliably inside the text flow (className on a collapsed
        // range can be ignored by Monaco's renderer). inlineClassName applies
        // styling directly on the text node and works for collapsed ranges.
        decs.push({ range: headRange, options: { inlineClassName: cursorClass + (isRecent ? ` collab-recent-${cid}` : '') } });
        // line badge in glyph margin (show initials)
        try {
          const badgeClass = `collab-line-badge-${cid}`;
          decs.push({ range: headRange, options: { glyphMarginClassName: badgeClass, glyphMarginHoverMessage: { value: info.name } } });
        } catch (_) { }

        const oldIds = existing?.ids || [];
        const ids = this.editor.deltaDecorations(oldIds, decs);
        this._remoteDecorations.set(cid, { ids, meta: info });
      }
    } catch (err) {
      console.warn('[Collab] failed applying awareness decorations', err?.message || err);
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
      const M = (typeof window !== 'undefined' && window.monaco) ? window.monaco : null;
      if (!M) return null;
      return new M.Range(sLine, sCol, eLine, eCol);
    } catch (_) { return null; }
  }

  _ensureStyleForClient(clientId, color, displayName = '') {
    try {
      const nameCursor = `collab-remote-cursor-${clientId}`;
      const nameSelection = `collab-remote-selection-${clientId}`;
      // Avoid re-creating styles
      const existing = document.getElementById(`collab-style-${clientId}`);
      if (existing) return;
      const style = document.createElement('style');
      style.id = `collab-style-${clientId}`;
      // Create caret and selection styles using subtle rgba
      const rgba = (c) => {
        // convert named/hex color to rgba fallback (use hsl/css variable as-is)
        // If color is like hsl(...) leave it; else we use hex -> rgba(, , , 0.35)
        if (typeof c === 'string' && c.startsWith('hsl')) return c.replace(')', ', 0.35)');
        if (typeof c === 'string' && c.startsWith('#')) {
          // convert #rrggbb
          const r = parseInt(c.slice(1,3),16); const g = parseInt(c.slice(3,5),16); const b = parseInt(c.slice(5,7),16);
          return `rgba(${r}, ${g}, ${b}, 0.18)`;
        }
        return 'rgba(128,128,128,0.15)';
      };
      const caretColor = color || '#888';
      const selectionColor = rgba(color || '#888');
      // prepare initials string (1-2 letters)
      const initials = (displayName || '').split(' ').filter(Boolean).map(p => p[0] || '').join('').slice(0,2).toUpperCase() || '';
      // Compose CSS: selection, caret and glyph margin badge using ::after content
      style.innerHTML = `
        .${nameSelection} { background: ${selectionColor} !important; }
        /* caret: a solid thin bar that's guaranteed visible */
        .${nameCursor} { display:inline-block; width:2px; background: ${caretColor}; box-shadow: 0 0 6px ${caretColor}; margin-left: -1px; }
        /* small floating initials label attached near the caret */
        .${nameCursor}::before { content: '${initials}'; display: inline-block; font-size: 11px; line-height: 14px; padding: 2px 8px; border-radius: 10px; color: white; margin-left: 6px; transform: translateY(-140%); background: ${caretColor}; box-shadow: 0 6px 18px rgba(0,0,0,0.4); font-weight:700; }

        .${'collab-line-badge-' + clientId} { display: inline-block; height: 14px; width: 14px; border-radius: 14px; margin-left: 2px; box-sizing: border-box; background: ${caretColor}; border: 2px solid rgba(0,0,0,0.6); position: relative; }
        .${'collab-line-badge-' + clientId}::after { content: '${initials}'; display: block; font-size: 9px; line-height: 14px; text-align: center; color: white; font-weight: 600; }

        /* subtle recently-active pulse */
        @keyframes collabPulse_${clientId} { 0% { transform: scale(0.9); opacity: 0.8; } 50% { transform: scale(1.06); opacity: 1; } 100% { transform: scale(0.96); opacity: 0.9; } }
        .collab-recent-${clientId} { animation: collabPulse_${clientId} 1.2s ease-in-out both; }
      `;
      document.head.appendChild(style);
    } catch (_) {}
  }
}

// Small client wrapper for workspace collaboration with Yjs.
// - Creates/maintains a Y.Doc per workspace:file
// - Connects via y-websocket provider
// - Creates MonacoBinding when a Monaco model is available

class CollabClient {
  constructor(serverUrl) {
    this.serverUrl = serverUrl || (typeof window !== 'undefined' ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.hostname}:1234` : 'ws://localhost:1234');
    this.docs = new Map(); // key -> {doc, provider, bindings: Set}
    // awareness listener registry: key -> Map<originalCb, wrappedCb>
    this._awarenessListeners = new Map();
  }

  _roomKey(slug, path) {
    const safePath = path ? path.replace(/[^a-zA-Z0-9_.\-\/]/g, '_') : 'root';
    return `workspace:${slug}:${safePath}`;
  }

  ensureDoc(slug, path) {
    const key = this._roomKey(slug, path);
    if (this.docs.has(key)) return this.docs.get(key);

    const doc = new Y.Doc();
    const provider = new WebsocketProvider(this.serverUrl, key, doc, { connect: true });
    provider.on('status', (ev) => {
      console.debug('[Collab] Provider status for', key, ev.status);
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

  attachEditor({ editor, monaco, slug, path, user }) {
    if (!editor || !monaco || !slug || !path) return null;

    const entry = this.ensureDoc(slug, path);

    // Create or reuse model with a uri matching existing pattern
    const uri = monaco.Uri.parse(`/synthi/${path.startsWith('/') ? path.slice(1) : path}`);
    let model = monaco.editor.getModel(uri);
    if (!model) {
      model = monaco.editor.createModel(entry.ytext.toString() || '', undefined, uri);
    }

    // If model has content while ytext empty, push content into ytext
    if (entry.ytext.length === 0 && model.getValue()) {
      // Use simple replace
      entry.doc.transact(() => {
        entry.ytext.delete(0, entry.ytext.length);
        entry.ytext.insert(0, model.getValue());
      });
    }

    const binding = new MonacoTextBinding(entry.ytext, model, editor, entry.provider.awareness);

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

      const localState = { user: { id, name, color } };
      entry.provider.awareness.setLocalState(localState);
    }

    entry.bindings.add(binding);

    // Listen for connection/disconnection and forward to console for observability
    const statusHandler = ({ status }) => console.debug('[Collab]', entry.key, 'status', status);
    entry.provider.on('status', statusHandler);

    // Return an object that allows cleanup
    return {
      key: entry.key,
      dispose: () => {
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
          }, 1000 * 60); // cleanup after 60s of inactivity
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
    // Wait for provider sync once
    await new Promise(resolve => setTimeout(resolve, 100));
    if (entry.ytext.length === 0 && typeof initialContent === 'string' && initialContent.length > 0) {
      entry.doc.transact(() => {
        entry.ytext.insert(0, initialContent);
      });
    }
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
