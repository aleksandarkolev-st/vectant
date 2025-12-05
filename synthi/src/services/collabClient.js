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
      const localState = {
        user: {
          id: user.id || String(Math.floor(Math.random() * 1000000)),
          name: user.name || user.email || 'Anonymous',
          color: user.color || this._randomColor()
        }
      };
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
