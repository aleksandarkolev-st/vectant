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
        if (!info.range.isEmpty()) {
          decs.push({
            range: info.range,
            options: {
              className: selectionClass, // Selection background
              stickiness: 1
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
        selectionColor = `rgba(${r}, ${g}, ${b}, 0.2)`;
    } else if (color.startsWith('hsl')) {
        selectionColor = color.replace('hsl', 'hsla').replace(')', ', 0.2)');
    }

    style.innerHTML = `
      .collab-selection-${clientId} {
        background-color: ${selectionColor};
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
