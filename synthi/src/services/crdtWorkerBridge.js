// ─────────────────────────────────────────────────────────────────────────────
// CRDT Worker Bridge — Main-thread adapter for the collab-crdt Web Worker.
// Provides an event-driven API with synchronous content caching so that
// CollabClient and MonacoTextBinding never need to await worker round-trips
// during latency-critical operations (keystrokes, delta application).
// ─────────────────────────────────────────────────────────────────────────────

class CRDTWorkerBridge {
  constructor() {
    /** @type {Worker | null} */
    this._worker = null;
    this._ready = false;
    /** @type {Promise<void> | null} */
    this._readyPromise = null;

    // Per-key event handler sets
    /** @type {Map<string, { onDelta: Set, onAwareness: Set, onStatus: Set, onSynced: Set, onDocReady: Set, onInvalidated: Set, onSeedReset: Set }>} */
    this._handlers = new Map();

    // Cached ytext content per key (updated on every remote-delta, synced, doc-ready, local update)
    /** @type {Map<string, { content: string, length: number }>} */
    this._contentCache = new Map();

    // Cached awareness states per key
    /** @type {Map<string, { states: Array, localClientId: number|null }>} */
    this._awarenessCache = new Map();

    // Pending async request resolvers — { resolve, timer } so we can
    // auto-expire stale requests if the worker crashes or drops a reply.
    /** @type {Map<number, { resolve: Function, timer: any }>} */
    this._pendingRequests = new Map();
    this._requestIdCounter = 0;
    this._requestTimeoutMs = 10_000;

    // Global event handlers (fired for ALL keys)
    this._globalStatusHandlers = new Set();
    this._globalInvalidationHandlers = new Set();
  }

  // ── Worker bootstrap ──────────────────────────────────────────────────────

  _ensureWorker() {
    if (this._worker) return this._readyPromise;

    try {
      this._worker = new Worker(
        new URL('../workers/collab-crdt.worker.js', import.meta.url)
      );
    } catch (err) {
      console.error('[CRDTBridge] Failed to create CRDT worker:', err);
      // Create a no-op fallback so callers don't crash
      this._worker = /** @type {any} */ ({
        postMessage: () => {},
        terminate: () => {},
        onmessage: null,
        onerror: null,
      });
      this._ready = true;
      this._readyPromise = Promise.resolve();
      return this._readyPromise;
    }

    this._readyPromise = new Promise((resolve) => {
      const timeout = setTimeout(() => {
        console.warn('[CRDTBridge] Worker ready timeout — proceeding anyway');
        this._ready = true;
        resolve();
      }, 5000);

      const handler = (e) => {
        if (e.data?.type === 'ready') {
          clearTimeout(timeout);
          this._ready = true;
          resolve();
        }
      };
      this._worker.addEventListener('message', handler, { once: true });
    });

    this._worker.onmessage = (e) => this._handleMessage(e.data);
    this._worker.onerror = (e) => {
      console.error('[CRDTBridge] Worker runtime error:', e);
    };

    return this._readyPromise;
  }

  _post(msg) {
    if (!this._worker) this._ensureWorker();
    this._worker.postMessage(msg);
  }

  _getHandlers(key) {
    let h = this._handlers.get(key);
    if (!h) {
      h = {
        onDelta: new Set(),
        onAwareness: new Set(),
        onStatus: new Set(),
        onSynced: new Set(),
        onDocReady: new Set(),
        onInvalidated: new Set(),
        onSeedReset: new Set(),
      };
      this._handlers.set(key, h);
    }
    return h;
  }

  // ── Message handler ───────────────────────────────────────────────────────

  _handleMessage(msg) {
    if (!msg?.type) return;

    const handlers = msg.key ? this._handlers.get(msg.key) : null;

    switch (msg.type) {
      case 'ready':
        this._ready = true;
        break;

      // ── Remote delta from Yjs (worker) → main thread ──
      case 'remote-delta': {
        this._contentCache.set(msg.key, { content: msg.fullText, length: msg.length });
        if (handlers) {
          for (const cb of handlers.onDelta) {
            try { cb(msg.delta, msg.fullText); } catch (_) {}
          }
        }
        break;
      }

      // ── Awareness state changes ──
      case 'awareness-update': {
        this._awarenessCache.set(msg.key, { states: msg.states, localClientId: msg.localClientId });
        if (handlers) {
          for (const cb of handlers.onAwareness) {
            try { cb(msg.states, msg.localClientId, msg.changes); } catch (_) {}
          }
        }
        break;
      }

      // ── Provider status ──
      case 'provider-status': {
        if (handlers) {
          for (const cb of handlers.onStatus) {
            try { cb(msg.status, msg.wsconnected, msg.wsconnecting); } catch (_) {}
          }
        }
        for (const cb of this._globalStatusHandlers) {
          try { cb(msg.key, msg.status, msg.wsconnected, msg.wsconnecting); } catch (_) {}
        }
        break;
      }

      // ── Provider synced ──
      case 'provider-synced': {
        this._contentCache.set(msg.key, { content: msg.content, length: msg.length });
        if (handlers) {
          for (const cb of handlers.onSynced) {
            try { cb(msg.content, msg.length); } catch (_) {}
          }
        }
        break;
      }

      // ── Doc-ready (initial state after ensure-doc) ──
      case 'doc-ready': {
        this._contentCache.set(msg.key, { content: msg.content, length: msg.length });
        if (handlers) {
          for (const cb of handlers.onDocReady) {
            try { cb(msg); } catch (_) {}
          }
        }
        break;
      }

      // ── Doc invalidated (WS close code 4000) ──
      case 'doc-invalidated': {
        this._contentCache.delete(msg.key);
        this._awarenessCache.delete(msg.key);
        if (handlers) {
          for (const cb of handlers.onInvalidated) {
            try { cb(); } catch (_) {}
          }
        }
        this._handlers.delete(msg.key);
        for (const cb of this._globalInvalidationHandlers) {
          try { cb(msg.key); } catch (_) {}
        }
        break;
      }

      // ── Seed flag reset (non-clean WS close) ──
      case 'seed-reset': {
        this._contentCache.delete(msg.key);
        this._awarenessCache.delete(msg.key);
        if (handlers) {
          for (const cb of handlers.onSeedReset) {
            try { cb(msg); } catch (_) {}
          }
        }
        break;
      }

      // ── Async request responses ──
      case 'content-response':
      case 'awareness-states-response':
      case 'has-doc-response': {
        const pending = this._pendingRequests.get(msg.requestId);
        if (pending) {
          this._pendingRequests.delete(msg.requestId);
          if (pending.timer) clearTimeout(pending.timer);
          pending.resolve(msg);
        }
        if (msg.type === 'content-response' && msg.key) {
          this._contentCache.set(msg.key, { content: msg.content, length: msg.length });
        }
        if (msg.type === 'awareness-states-response' && msg.key) {
          this._awarenessCache.set(msg.key, { states: msg.states, localClientId: msg.localClientId });
        }
        break;
      }

      // ── Seed events (informational) ──
      case 'seed-skipped': {
        if (msg.key) {
          this._contentCache.set(msg.key, { content: msg.content, length: msg.length });
        }
        break;
      }
      case 'seed-applied':
        break;

      // ── Prefix destruction completed ──
      case 'prefix-destroyed': {
        for (const key of [...this._handlers.keys()]) {
          if (key.startsWith(msg.prefix)) {
            this._handlers.delete(key);
            this._contentCache.delete(key);
            this._awarenessCache.delete(key);
          }
        }
        break;
      }

      case 'error':
        console.warn('[CRDTBridge] Worker error for', msg.key, ':', msg.error);
        break;
    }
  }

  // ── Public: Worker commands ───────────────────────────────────────────────

  configure(serverUrl) {
    this._ensureWorker();
    this._post({ type: 'configure', serverUrl });
  }

  ensureDoc(key, params) {
    this._ensureWorker();
    this._post({ type: 'ensure-doc', key, params });
  }

  sendLocalChanges(key, changes, fullText) {
    this._post({ type: 'local-changes', key, changes, fullText });
  }

  seedContent(key, content, force = false) {
    this._post({ type: 'seed-content', key, content, force });
  }

  markSeeded(key) {
    this._post({ type: 'mark-seeded', key });
  }

  resetSeedFlag(key) {
    this._post({ type: 'reset-seed-flag', key });
  }

  resetContent(key, content) {
    this._post({ type: 'reset-content', key, content });
  }

  setAwarenessState(key, state) {
    this._post({ type: 'set-awareness-state', key, state });
  }

  setAwarenessField(key, field, value) {
    this._post({ type: 'set-awareness-field', key, field, value });
  }

  clearAwareness(key) {
    this._post({ type: 'clear-awareness', key });
  }

  destroyDoc(key) {
    this._post({ type: 'destroy-doc', key });
    this._contentCache.delete(key);
    this._awarenessCache.delete(key);
    this._handlers.delete(key);
  }

  destroyPrefix(prefix) {
    this._post({ type: 'destroy-prefix', prefix });
  }

  disconnectAll() {
    this._post({ type: 'disconnect-all' });
    this._contentCache.clear();
    this._awarenessCache.clear();
    this._handlers.clear();
    // Reject-by-fallback any lingering requests so callers don't hang forever.
    for (const [requestId, pending] of this._pendingRequests) {
      try { if (pending.timer) clearTimeout(pending.timer); } catch (_) {}
      try { pending.resolve(null); } catch (_) {}
      this._pendingRequests.delete(requestId);
    }
  }

  // ── Public: Synchronous cached reads ──────────────────────────────────────

  getContent(key) {
    return this._contentCache.get(key)?.content ?? '';
  }

  getContentLength(key) {
    return this._contentCache.get(key)?.length ?? 0;
  }

  /** Optimistically update the content cache from the main thread. */
  updateContentCache(key, content) {
    this._contentCache.set(key, { content, length: content.length });
  }

  getAwarenessStates(key) {
    return this._awarenessCache.get(key)?.states || [];
  }

  getLocalClientId(key) {
    return this._awarenessCache.get(key)?.localClientId ?? null;
  }

  // ── Public: Async requests ────────────────────────────────────────────────

  /**
   * Internal helper — registers a pending request with a timeout so the
   * pending-requests map can't grow unboundedly if the worker drops a reply
   * (crash, terminated, dead WebSocket, etc.).
   */
  _createRequest(fallback) {
    const requestId = ++this._requestIdCounter;
    const promise = new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this._pendingRequests.delete(requestId)) {
          console.warn('[CRDTBridge] request', requestId, 'timed out');
          resolve(fallback);
        }
      }, this._requestTimeoutMs);
      if (typeof timer === 'object' && typeof timer.unref === 'function') timer.unref();
      this._pendingRequests.set(requestId, { resolve, timer });
    });
    return { requestId, promise };
  }

  requestContent(key) {
    const { requestId, promise } = this._createRequest({ content: '' });
    this._post({ type: 'get-content', key, requestId });
    return promise.then((msg) => (msg && typeof msg === 'object' ? msg.content : ''));
  }

  requestAwarenessStates(key) {
    const { requestId, promise } = this._createRequest({ states: [], localClientId: null });
    this._post({ type: 'get-awareness-states', key, requestId });
    return promise.then((msg) => ({ states: msg?.states || [], localClientId: msg?.localClientId ?? null }));
  }

  requestHasDoc(key) {
    const { requestId, promise } = this._createRequest({ exists: false });
    this._post({ type: 'has-doc', key, requestId });
    return promise;
  }

  // ── Public: Event subscriptions ───────────────────────────────────────────

  onRemoteDelta(key, cb) {
    this._getHandlers(key).onDelta.add(cb);
    return () => { this._handlers.get(key)?.onDelta?.delete(cb); };
  }

  onAwareness(key, cb) {
    this._getHandlers(key).onAwareness.add(cb);
    return () => { this._handlers.get(key)?.onAwareness?.delete(cb); };
  }

  onStatus(key, cb) {
    this._getHandlers(key).onStatus.add(cb);
    return () => { this._handlers.get(key)?.onStatus?.delete(cb); };
  }

  onSynced(key, cb) {
    this._getHandlers(key).onSynced.add(cb);
    return () => { this._handlers.get(key)?.onSynced?.delete(cb); };
  }

  onDocReady(key, cb) {
    this._getHandlers(key).onDocReady.add(cb);
    return () => { this._handlers.get(key)?.onDocReady?.delete(cb); };
  }

  onInvalidated(key, cb) {
    this._getHandlers(key).onInvalidated.add(cb);
    return () => { this._handlers.get(key)?.onInvalidated?.delete(cb); };
  }

  onSeedReset(key, cb) {
    this._getHandlers(key).onSeedReset.add(cb);
    return () => { this._handlers.get(key)?.onSeedReset?.delete(cb); };
  }

  // Global event subscriptions (fired for ALL keys)
  onGlobalStatus(cb) {
    this._globalStatusHandlers.add(cb);
    return () => this._globalStatusHandlers.delete(cb);
  }

  onGlobalInvalidation(cb) {
    this._globalInvalidationHandlers.add(cb);
    return () => this._globalInvalidationHandlers.delete(cb);
  }
}

// ── Singleton ───────────────────────────────────────────────────────────────
const bridge = new CRDTWorkerBridge();
export default bridge;
