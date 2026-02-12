/**
 * Synthi Extension System - VS Code Server Proxy
 *
 * Browser-side proxy that communicates with the `vscode-server-manager.js`
 * running on the backend via a WebRTC DataChannel, and optionally opens a
 * WebSocket tunnel to the real VS Code Server for Extension Host protocol.
 *
 * Two-layer architecture:
 *   1. **Control channel** — JSON-RPC over DataChannel (same interface as
 *      RemoteExtHostProxy) for managing the server lifecycle and VSIX installs.
 *   2. **Extension Host tunnel** — WebSocket-over-DataChannel to the real
 *      VS Code Server, giving the browser a genuine Extension Host connection.
 *
 * The control channel uses the same newline-delimited JSON protocol as
 * RemoteExtHostProxy so MainThreadBridge can use it interchangeably for
 * lifecycle operations (install, list, status).
 */

import {
  createRequest,
  isValidMessage,
} from './MessageProtocol.js';

// ============================================================================
// Constants
// ============================================================================

const DEFAULT_TIMEOUT = 30000;      // Server ops may be slow (binary download, VSIX install)
const SERVER_START_TIMEOUT = 60000; // Starting the server + downloading binary can take a minute
const HEARTBEAT_INTERVAL = 10000;

// ============================================================================
// Chunk Reassembler — matches Rust make_chunks() binary protocol
// ============================================================================

/**
 * Reassembles chunked messages (>60KB) that the Rust worker splits.
 * Chunk header (16 bytes):
 *   4 bytes: "CHNK" magic
 *   4 bytes: msg_id (u32 big-endian)
 *   4 bytes: chunk_index (u32 big-endian)
 *   4 bytes: total_chunks (u32 big-endian)
 *   remaining: payload
 */
class ChunkReassembler {
  constructor() {
    /** @type {Map<number, {chunks: Map<number, Uint8Array>, total: number, created: number}>} */
    this.pending = new Map();
  }

  /** @returns {string|null} Fully reassembled JSON string, or null if still waiting */
  feed(data) {
    if (typeof data === 'string') return data;

    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);
    if (buf.length < 16) return null;

    const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
    if (magic !== 'CHNK') {
      try { return new TextDecoder().decode(buf); } catch { return null; }
    }

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const msgId = view.getUint32(4);
    const chunkIdx = view.getUint32(8);
    const totalChunks = view.getUint32(12);
    const payload = buf.slice(16);

    if (totalChunks <= 1) {
      return new TextDecoder().decode(payload);
    }

    if (!this.pending.has(msgId)) {
      this.pending.set(msgId, { chunks: new Map(), total: totalChunks, created: Date.now() });
    }
    const entry = this.pending.get(msgId);
    entry.chunks.set(chunkIdx, payload);

    if (entry.chunks.size === entry.total) {
      this.pending.delete(msgId);
      const parts = [];
      for (let i = 0; i < entry.total; i++) {
        parts.push(entry.chunks.get(i) || new Uint8Array(0));
      }
      const totalLen = parts.reduce((s, p) => s + p.length, 0);
      const combined = new Uint8Array(totalLen);
      let offset = 0;
      for (const p of parts) {
        combined.set(p, offset);
        offset += p.length;
      }
      return new TextDecoder().decode(combined);
    }

    return null;
  }

  gc() {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.created > 30000) this.pending.delete(id);
    }
  }
}

// ============================================================================
// VSCodeServerProxy
// ============================================================================

export class VSCodeServerProxy {
  /**
   * @param {RTCDataChannel} channel - DataChannel to the vscode-server-manager process
   */
  constructor(channel) {
    /** @type {RTCDataChannel} */
    this.channel = channel;

    /** @type {'connecting'|'running'|'terminated'} */
    this.state = 'connecting';

    /** @type {boolean} */
    this.ready = false;

    /** @type {Map<number, {resolve: Function, reject: Function, timeout: number}>} */
    this.pendingRequests = new Map();

    /** @type {Map<string, Function[]>} */
    this.eventListeners = new Map();

    /** @type {Function[]} */
    this.readyCallbacks = [];

    /** @type {Function[]} */
    this.readyRejectCallbacks = [];

    /** @type {number} */
    this.generation = 0;

    /** @type {number|null} Server port on the backend */
    this.serverPort = null;

    /** @type {string|null} Server connection token */
    this.serverToken = null;

    /** @type {'stopped'|'starting'|'running'|'error'} */
    this.serverState = 'stopped';

    /** @type {number|null} */
    this._heartbeatInterval = null;

    /** @type {ChunkReassembler} */
    this._reassembler = new ChunkReassembler();

    // ── Backpressure / send queue ──────────────────────────────
    /** @type {string[]} */
    this._sendQueue = [];
    this._draining = false;
    // DataChannel bufferedAmount threshold (128 KB).  When the buffer
    // exceeds this, new sends are queued until it drains.
    this._highWaterMark = 128 * 1024;

    this._wireChannel();
  }

  // =========================================================================
  // DataChannel wiring
  // =========================================================================

  _wireChannel() {
    const ch = this.channel;
    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      console.log('[VSCodeServerProxy] DataChannel opened');
    };

    ch.onmessage = (evt) => {
      // Handle chunked binary messages from Rust worker
      const decoded = this._reassembler.feed(evt.data);
      if (decoded === null) return; // still waiting for more chunks

      // May contain multiple newline-delimited messages
      const lines = decoded.split('\n').filter(l => l.trim());
      for (const line of lines) {
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        this._handleMessage(msg);
      }
    };

    ch.onerror = (err) => {
      console.error('[VSCodeServerProxy] DataChannel error:', err);
      this._rejectAllPending('DataChannel error');
      this._rejectReady('DataChannel error');
      this.state = 'terminated';
      this.ready = false;
      this._emit('error', err);
    };

    ch.onclose = () => {
      console.warn('[VSCodeServerProxy] DataChannel closed');
      this._rejectAllPending('DataChannel closed');
      this._rejectReady('DataChannel closed');
      this.state = 'terminated';
      this.ready = false;
      this._emit('disconnected');
    };

    // Start heartbeat
    this._heartbeatInterval = setInterval(() => {
      if (this.ready && this.channel.readyState === 'open') {
        this.request('getStatus').catch(() => {});
      }
    }, HEARTBEAT_INTERVAL);

    // Drain any messages buffered by compilerClient's early handler.
    // The channel may have received workerReady before this proxy was created.
    if (ch._earlyMessages && ch._earlyMessages.length > 0) {
      const buffered = ch._earlyMessages.splice(0);
      ch._earlyMessages = null; // stop buffering
      console.log(`[VSCodeServerProxy] Draining ${buffered.length} early message(s)`);
      for (const data of buffered) {
        ch.onmessage({ data });
      }
    } else if (ch._earlyMessages) {
      ch._earlyMessages = null;
    }
  }

  // =========================================================================
  // Message handling
  // =========================================================================

  _handleMessage(msg) {
    // Handle workerReady from the server manager
    if (msg.type === 'event' && msg.method === 'workerReady') {
      this.ready = true;
      this.state = 'running';
      console.log('[VSCodeServerProxy] VS Code Server Manager ready');
      for (const cb of this.readyCallbacks) { try { cb(); } catch (_) {} }
      this.readyCallbacks = [];
      this._emit('workerReady');
      return;
    }

    // Handle events
    if (msg.type === 'event') {
      this._emit(msg.method, ...(msg.args || []));

      // Track server state from events
      if (msg.method === 'serverStatus') {
        const [status, ...rest] = msg.args || [];
        this.serverState = status;
        if (status === 'running') {
          this.serverPort = rest[0] || null;
          this.serverToken = rest[1] || null;
        }
      }
      return;
    }

    // Handle streamed responses (large proxyHttp payloads)
    if (msg.type === 'response' && msg.stream) {
      this._handleStreamChunk(msg);
      return;
    }

    // Handle responses
    if (msg.type === 'response' && this.pendingRequests.has(msg.id)) {
      const { resolve, reject, timeout } = this.pendingRequests.get(msg.id);
      this.pendingRequests.delete(msg.id);
      clearTimeout(timeout);

      if (msg.error) {
        reject(new Error(msg.error.message || 'Unknown error'));
      } else {
        resolve(msg.result);
      }
    }
  }

  // =========================================================================
  // Streamed response reassembly
  // =========================================================================

  /**
   * Handle a chunk of a streamed response.  Large proxyHttp responses are
   * sent as:  stream:'start' → stream:'data' ×N → stream:'end'
   * We reassemble the body and resolve the original request promise.
   */
  _handleStreamChunk(msg) {
    if (!this._pendingStreams) this._pendingStreams = new Map();

    if (msg.stream === 'start') {
      this._pendingStreams.set(msg.id, {
        meta: msg.meta,
        chunks: [],
      });
      return;
    }

    if (msg.stream === 'data') {
      const stream = this._pendingStreams.get(msg.id);
      if (stream) {
        stream.chunks.push(msg.chunk);
      }
      return;
    }

    if (msg.stream === 'end') {
      const stream = this._pendingStreams.get(msg.id);
      this._pendingStreams.delete(msg.id);
      if (!stream) return;

      // Reassemble the full response
      const result = {
        status: stream.meta.status,
        statusText: stream.meta.statusText,
        headers: stream.meta.headers,
        body: stream.chunks.join(''),
      };

      console.log(`[VSCodeServerProxy] Streamed response ${msg.id} reassembled: ${result.body.length} chars`);

      // Resolve the pending request promise
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        this.pendingRequests.delete(msg.id);
        clearTimeout(pending.timeout);
        pending.resolve(result);
      }
    }
  }

  // =========================================================================
  // Request/Response RPC
  // =========================================================================

  /**
   * Send an RPC request to the server manager.
   * @param {string} method
   * @param {any[]} [args]
   * @param {number} [timeoutMs]
   * @returns {Promise<any>}
   */
  request(method, args = [], timeoutMs = DEFAULT_TIMEOUT) {
    return new Promise((resolve, reject) => {
      if (this.state === 'terminated') {
        return reject(new Error('VSCodeServerProxy is terminated'));
      }
      if (this.channel.readyState !== 'open') {
        return reject(new Error(`DataChannel not open (state: ${this.channel.readyState})`));
      }

      const msg = createRequest(method, args);
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`Request timeout: ${method} (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingRequests.set(msg.id, { resolve, reject, timeout });

      try {
        this._send(JSON.stringify(msg));
      } catch (err) {
        this.pendingRequests.delete(msg.id);
        clearTimeout(timeout);
        reject(err);
      }
    });
  }

  // =========================================================================
  // Backpressure-aware send
  // =========================================================================

  /**
   * Queue-aware send.  If the DataChannel buffer is already above the
   * high-water mark, the payload is queued and flushed once the buffer
   * drains below `_highWaterMark` via `bufferedamountlow`.
   *
   * @param {string} data - serialized JSON to send
   */
  _send(data) {
    if (this.channel.readyState !== 'open') {
      throw new Error(`DataChannel not open (state: ${this.channel.readyState})`);
    }

    if (this.channel.bufferedAmount > this._highWaterMark) {
      this._sendQueue.push(data);
      this._ensureDrain();
      return;
    }

    try {
      this.channel.send(data);
    } catch (err) {
      // If send fails (buffer full), queue the data for retry
      this._sendQueue.push(data);
      this._ensureDrain();
    }
  }

  /**
   * Fire-and-forget send (no request/response tracking).
   * Used for wsSend where the backend doesn't respond on success.
   *
   * @param {string} method
   * @param {any[]} [args]
   */
  _fireAndForget(method, args = []) {
    if (this.state === 'terminated' || this.channel.readyState !== 'open') return;
    const msg = createRequest(method, args);
    try {
      this._send(JSON.stringify(msg));
    } catch (_) {
      // Silently drop — fire-and-forget
    }
  }

  /**
   * Set up the `bufferedamountlow` listener to drain the send queue.
   */
  _ensureDrain() {
    if (this._draining) return;
    this._draining = true;
    this.channel.bufferedAmountLowThreshold = this._highWaterMark / 2;
    this.channel.onbufferedamountlow = () => {
      this._drainQueue();
    };
  }

  /**
   * Flush queued messages while the buffer is below the high-water mark.
   */
  _drainQueue() {
    while (this._sendQueue.length > 0) {
      if (this.channel.readyState !== 'open') {
        this._sendQueue.length = 0;
        break;
      }
      if (this.channel.bufferedAmount > this._highWaterMark) {
        return; // wait for next bufferedamountlow event
      }
      const data = this._sendQueue.shift();
      try {
        this.channel.send(data);
      } catch (_) {
        // channel failed, discard remaining
        this._sendQueue.length = 0;
        break;
      }
    }
    // All drained — remove listener
    if (this._sendQueue.length === 0) {
      this._draining = false;
      this.channel.onbufferedamountlow = null;
    }
  }

  // =========================================================================
  // Init / Ready
  // =========================================================================

  /**
   * Wait for the VS Code Server Manager to be ready.
   *
   * Strategy:
   *  1. If `workerReady` event was already received → resolve immediately.
   *  2. Wait for `workerReady` up to a short window (PROBE_DELAY).
   *  3. If still not ready, send periodic `getStatus` probes.  If the
   *     manager responds, it's alive and we treat it as ready.  This
   *     handles the case where `workerReady` was lost, or the deployed
   *     manager only sends it after `startServer` completes.
   *
   * @param {number} [timeout=30000]
   * @returns {Promise<void>}
   */
  async waitForReady(timeout = 30000) {
    if (this.ready) return;

    const PROBE_DELAY = 3000;   // wait this long for workerReady first
    const PROBE_INTERVAL = 2000; // then probe every 2s

    return new Promise((resolve, reject) => {
      let settled = false;
      let probeTimer = null;

      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (probeTimer) clearInterval(probeTimer);
        fn(arg);
      };

      const timer = setTimeout(() => {
        settle(reject, new Error('VSCodeServerProxy: ready timeout'));
      }, timeout);

      // Normal path: workerReady event resolves this
      this.readyCallbacks.push(() => settle(resolve));
      this.readyRejectCallbacks.push((reason) => settle(reject, new Error(reason)));

      // Fallback path: if workerReady is lost or not sent on startup,
      // probe the manager with getStatus requests.
      const probe = () => {
        if (settled || this.channel.readyState !== 'open') return;
        this.request('getStatus', [], 5000)
          .then((result) => {
            if (settled) return;
            console.log('[VSCodeServerProxy] getStatus probe succeeded, treating as ready');
            // Mark ready if not already
            if (!this.ready) {
              this.ready = true;
              this.state = 'running';
              if (result?.state) this.serverState = result.state;
              if (result?.port) this.serverPort = result.port;
              if (result?.token) this.serverToken = result.token;
            }
            settle(resolve);
          })
          .catch(() => {
            // probe failed, will retry on next interval
          });
      };

      // Start probing after PROBE_DELAY (giving workerReady a chance first)
      setTimeout(() => {
        if (settled) return;
        probe(); // first probe
        probeTimer = setInterval(probe, PROBE_INTERVAL);
      }, PROBE_DELAY);
    });
  }

  /** @returns {boolean} */
  isReady() {
    return this.ready && this.state === 'running';
  }

  // =========================================================================
  // Server Lifecycle API
  // =========================================================================

  /**
   * Start the VS Code Server for a workspace.
   * Downloads the server binary if needed.
   *
   * @param {string} slug - Workspace slug
   * @param {object} [options]
   * @param {string} [options.workspaceDir] - Workspace root on the backend
   * @returns {Promise<{port: number, token: string}>}
   */
  async startServer(slug, options = {}) {
    const result = await this.request('startServer', [slug, options], SERVER_START_TIMEOUT);
    if (result) {
      this.serverPort = result.port;
      this.serverToken = result.token;
      this.serverState = 'running';
      this.workspaceDir = result.workspaceDir || null;
    }
    return result;
  }

  /**
   * Stop the VS Code Server.
   * @returns {Promise<void>}
   */
  async stopServer() {
    await this.request('stopServer');
    this.serverPort = null;
    this.serverToken = null;
    this.serverState = 'stopped';
  }

  /**
   * Get current server status.
   * @returns {Promise<{state: string, port: number|null, token: string|null, slug: string|null, extensions: string[]}>}
   */
  async getStatus() {
    return this.request('getStatus');
  }

  /**
   * Get WebSocket connection info for the VS Code Server.
   * Used by the browser to open a WebSocket tunnel to the real Extension Host.
   *
   * @returns {Promise<{host: string, port: number, path: string, token: string, wsUrl: string}|null>}
   */
  async getConnectionInfo() {
    return this.request('getConnectionInfo');
  }

  // =========================================================================
  // Extension Management API
  // =========================================================================

  /**
   * Install a VSIX file into the VS Code Server.
   *
   * @param {string} extensionId - e.g. "publisher.name"
   * @param {string} vsixBase64 - Base64-encoded VSIX file contents
   * @returns {Promise<{success: boolean, extensionId: string, error?: string}>}
   */
  async installExtension(extensionId, vsixBase64) {
    return this.request('installExtension', [extensionId, vsixBase64], 120000);
  }

  /**
   * Install an extension from the marketplace by ID.
   *
   * @param {string} extensionId - e.g. "dbaeumer.vscode-eslint"
   * @returns {Promise<{success: boolean, extensionId: string}>}
   */
  async installExtensionFromMarketplace(extensionId) {
    return this.request('installExtensionFromMarketplace', [extensionId], 120000);
  }

  /**
   * Uninstall an extension from the server.
   * @param {string} extensionId
   * @returns {Promise<{success: boolean}>}
   */
  async uninstallExtension(extensionId) {
    return this.request('uninstallExtension', [extensionId]);
  }

  /**
   * List extensions installed in the server.
   * @returns {Promise<string[]>}
   */
  async listExtensions() {
    return this.request('listExtensions');
  }

  // =========================================================================
  // HTTP Proxy (for embedding code-server UI)
  // =========================================================================

  /**
   * Proxy an HTTP request to the running code-server instance.
   *
   * @param {{ method: string, path: string, headers?: object, body?: string }} reqData
   *   body should be base64-encoded if present.
   * @returns {Promise<{ status: number, statusText: string, headers: object, body: string }>}
   *   body is base64-encoded.
   */
  async proxyHttp(reqData) {
    // 60s timeout — large JS bundles are streamed in paced chunks which can
    // take several seconds on the first load (SW caches for subsequent loads).
    return this.request('proxyHttp', [reqData], 60000);
  }

  // =========================================================================
  // WebSocket Tunnel (through the same DataChannel)
  // =========================================================================

  /**
   * Open a WebSocket tunnel to code-server through the DataChannel pipeline.
   * @param {string} urlPath - The WebSocket URL path (e.g. '/?reconnectionToken=...')
   * @returns {Promise<{tunnelId: number}>}
   */
  async wsConnect(urlPath) {
    return this.request('wsConnect', [urlPath], 15000);
  }

  /**
   * Send data through an open WebSocket tunnel.
   * Fire-and-forget — the backend does not send a response on success,
   * only on error.  This dramatically reduces DataChannel traffic since
   * code-server can send dozens of WS messages per second.
   *
   * @param {number} tunnelId
   * @param {string} data - text or base64-encoded binary
   * @param {boolean} [isBinary=false]
   */
  async wsSend(tunnelId, data, isBinary = false) {
    this._fireAndForget('wsSend', [tunnelId, data, isBinary]);
  }

  /**
   * Close a WebSocket tunnel.
   * @param {number} tunnelId
   * @param {number} [code=1000]
   */
  async wsClose(tunnelId, code = 1000) {
    return this.request('wsClose', [tunnelId, code], 5000);
  }

  // =========================================================================
  // Event Emitter
  // =========================================================================

  /**
   * Subscribe to an event.
   * @param {string} event
   * @param {Function} handler
   * @returns {Function} Unsubscribe function
   */
  on(event, handler) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(handler);
    return () => {
      const handlers = this.eventListeners.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    };
  }

  _emit(event, ...args) {
    const handlers = this.eventListeners.get(event);
    if (handlers) {
      for (const h of handlers) {
        try { h(...args); } catch (e) {
          console.error(`[VSCodeServerProxy] Event handler error (${event}):`, e);
        }
      }
    }
  }

  // =========================================================================
  // Cleanup
  // =========================================================================

  _rejectAllPending(reason) {
    for (const [id, { reject, timeout }] of this.pendingRequests) {
      clearTimeout(timeout);
      reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }

  _rejectReady(reason) {
    for (const cb of this.readyRejectCallbacks) {
      try { cb(reason); } catch (_) {}
    }
    this.readyRejectCallbacks = [];
  }

  /**
   * Soft cleanup — release timers, reject pending requests, but keep
   * the DataChannel open so a new proxy can be created on the same DC
   * without triggering the Rust side to kill & respawn the manager.
   */
  dispose() {
    if (this._heartbeatInterval) {
      clearInterval(this._heartbeatInterval);
      this._heartbeatInterval = null;
    }
    this._sendQueue.length = 0;
    this._draining = false;
    this._rejectAllPending('Proxy disposed');
    this._rejectReady('Proxy disposed');
    this.state = 'terminated';
    this.ready = false;
    // NOTE: intentionally NOT closing the DataChannel
  }

  /**
   * Hard cleanup — dispose AND close the DataChannel.
   * Only use this when you're done with the channel entirely
   * (e.g., full shutdown or PeerConnection teardown).
   */
  terminate() {
    this.dispose();
    try { this.channel.close(); } catch (_) {}
  }
}
