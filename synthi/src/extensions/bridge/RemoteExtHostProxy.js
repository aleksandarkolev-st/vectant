/**
 * Synthi Extension System - Remote Extension Host Proxy
 *
 * Browser-side proxy that communicates with the Node.js remote extension host
 * running on the backend via a WebRTC DataChannel.
 *
 * Implements the same interface as WorkerProxy so MainThreadBridge can use
 * either interchangeably: request(), send(), on(), loadExtension(), etc.
 *
 * Protocol: newline-delimited JSON over DataChannel (same schema as WorkerProxy
 * messages: { id, type, method, args, generation }).
 */

import {
  createRequest,
  createEvent,
  isValidMessage,
  MainToWorkerMethods,
} from './MessageProtocol.js';

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
    if (typeof data === 'string') return data; // not chunked

    const buf = data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer || data);

    // Check for CHNK magic header (16 bytes minimum)
    if (buf.length < 16) return null;
    const magic = String.fromCharCode(buf[0], buf[1], buf[2], buf[3]);
    if (magic !== 'CHNK') {
      // Not a chunked message — try to decode as plain binary
      try { return new TextDecoder().decode(buf); } catch { return null; }
    }

    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const msgId = view.getUint32(4);       // offset 4, after "CHNK"
    const chunkIdx = view.getUint32(8);    // offset 8
    const totalChunks = view.getUint32(12); // offset 12
    const payload = buf.slice(16);          // offset 16

    if (totalChunks <= 1) {
      // Single chunk — just decode
      return new TextDecoder().decode(payload);
    }

    if (!this.pending.has(msgId)) {
      this.pending.set(msgId, { chunks: new Map(), total: totalChunks, created: Date.now() });
    }
    const entry = this.pending.get(msgId);
    entry.chunks.set(chunkIdx, payload);

    if (entry.chunks.size === entry.total) {
      this.pending.delete(msgId);
      // Reassemble in order
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

    return null; // still waiting for more chunks
  }

  /** Garbage-collect stale incomplete messages (>30s old) */
  gc() {
    const now = Date.now();
    for (const [id, entry] of this.pending) {
      if (now - entry.created > 30000) {
        console.warn(`[RemoteExtHostProxy] Dropping stale chunked message ${id}`);
        this.pending.delete(id);
      }
    }
  }
}


export class RemoteExtHostProxy {
  /**
   * @param {RTCDataChannel} channel - Already-created DataChannel with label "ext-host?slug=..."
   */
  constructor(channel) {
    /** @type {RTCDataChannel} */
    this.channel = channel;

    /** @type {number} */
    this.generation = 0;

    /** @type {'connecting'|'running'|'terminated'} */
    this.state = 'connecting';

    /** @type {Map<number, {resolve: Function, reject: Function, timeout: number, startTime: number}>} */
    this.pendingRequests = new Map();

    /** @type {Map<string, Function[]>} */
    this.eventListeners = new Map();

    /** @type {boolean} */
    this.ready = false;

    /** @type {Function[]} */
    this.readyCallbacks = [];

    /** @type {Function[]} */
    this.readyRejectCallbacks = [];

    /** @type {number} */
    this.defaultTimeout = 15000; // remote is slower than local worker

    /** @type {number} */
    this.messageCount = 0;

    /** @type {ChunkReassembler} */
    this._reassembler = new ChunkReassembler();

    /** @type {number|null} */
    this._gcInterval = null;

    /** @type {number} */
    this._chunkMsgIdCounter = 0;

    this._wireChannel();
  }

  // =========================================================================
  // DataChannel wiring
  // =========================================================================

  _wireChannel() {
    const ch = this.channel;

    ch.binaryType = 'arraybuffer';

    ch.onopen = () => {
      console.log('[RemoteExtHostProxy] DataChannel opened');
      // The remote-ext-host.js sends a workerReady event on startup —
      // we wait for that before resolving init.
    };

    ch.onmessage = (evt) => {
      const json = this._reassembler.feed(evt.data);
      if (!json) return; // partial chunk

      let msg;
      try { msg = JSON.parse(json); } catch (e) {
        console.warn('[RemoteExtHostProxy] JSON parse error:', e.message);
        return;
      }
      this._handleMessage(msg);
    };

    ch.onerror = (err) => {
      console.error('[RemoteExtHostProxy] DataChannel error:', err);
      this._rejectAllPending('DataChannel error');
      this._rejectReadyCallbacks('DataChannel error');
      this.state = 'terminated';
      this.ready = false;
      this._emit('error', err);
    };

    ch.onclose = () => {
      console.warn('[RemoteExtHostProxy] DataChannel closed');
      this._rejectAllPending('DataChannel closed');
      this._rejectReadyCallbacks('DataChannel closed before workerReady');
      this.state = 'terminated';
      this.ready = false;
      this._emit('disconnected');
    };

    // GC stale chunked messages every 15s
    this._gcInterval = setInterval(() => this._reassembler.gc(), 15000);

    // Replay any messages that were buffered on the DC before this proxy
    // was created (e.g. workerReady sent before onmessage was attached).
    const earlyMsgs = ch._earlyMessages;
    ch._earlyMessages = null; // stop buffering — proxy's onmessage is live
    if (earlyMsgs && earlyMsgs.length > 0) {
      console.log(`[RemoteExtHostProxy] Replaying ${earlyMsgs.length} early message(s)`);
      for (const data of earlyMsgs) {
        const json = this._reassembler.feed(data);
        if (!json) continue;
        let msg;
        try { msg = JSON.parse(json); } catch (_) { continue; }
        this._handleMessage(msg);
      }
    }
  }

  // =========================================================================
  // Init
  // =========================================================================

  /**
   * Wait for the remote extension host to signal workerReady.
   * @param {number} [timeout=20000] - Max time to wait for ready signal
   * @returns {Promise<void>}
   */
  async waitForReady(timeout = 20000) {
    if (this.ready) return;

    return new Promise((resolve, reject) => {
      let settled = false;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        clearTimeout(overallTimer);
        if (dcOpenTimer) clearTimeout(dcOpenTimer);
        fn(arg);
      };

      // Overall timeout (25s)
      const overallTimer = setTimeout(() => {
        settle(reject, new Error('Remote extension host initialization timeout'));
      }, timeout);

      // Sub-timeout: if the DC hasn't opened within 8s, the SCTP
      // transport is likely broken and we should fail fast instead
      // of wasting the full 25s.
      const dcOpenTimer = this.channel.readyState !== 'open'
        ? setTimeout(() => {
            if (this.channel.readyState !== 'open') {
              console.warn(`[RemoteExtHostProxy] DC stuck in '${this.channel.readyState}' after 8s, failing fast`);
              settle(reject, new Error(`ext-host DataChannel stuck in '${this.channel.readyState}' (SCTP transport may be down)`));
            }
          }, 8000)
        : null;

      // Happy path: workerReady received
      this.readyCallbacks.push(() => settle(resolve));

      // Sad path: DC closed/errored before workerReady
      // (readyRejectCallbacks is invoked by _rejectReadyCallbacks)
      this.readyRejectCallbacks.push((reason) => {
        settle(reject, new Error(reason));
      });
    });
  }

  /**
   * Reject all waiting readyCallbacks (e.g. when DC closes before workerReady).
   */
  _rejectReadyCallbacks(reason) {
    if (this.readyRejectCallbacks) {
      for (const cb of this.readyRejectCallbacks) {
        try { cb(reason); } catch (_) {}
      }
      this.readyRejectCallbacks = [];
    }
  }

  // =========================================================================
  // Message handling (same logic as WorkerProxy._handleMessage)
  // =========================================================================

  _handleMessage(data) {
    if (!isValidMessage(data)) {
      console.warn('[RemoteExtHostProxy] Invalid message:', data);
      return;
    }

    // Handle workerReady
    if (data.type === 'event' && data.method === 'workerReady') {
      if (typeof data.generation === 'number') {
        this.generation = data.generation;
      }
      this.ready = true;
      this.state = 'running';
      console.log('[RemoteExtHostProxy] Remote extension host ready');
      this.readyCallbacks.forEach(cb => cb());
      this.readyCallbacks = [];
      this._emit(data.method, ...(data.args || []));
      return;
    }

    // Generation fencing
    if (typeof data?.generation === 'number' && data.generation !== this.generation) {
      console.warn(`[RemoteExtHostProxy] Dropping stale message gen=${data.generation} (expected ${this.generation})`);
      return;
    }

    this.messageCount++;

    if (data.type === 'response') {
      const pending = this.pendingRequests.get(data.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(data.id);

        if (data.error) {
          const err = new Error(data.error.message);
          err.stack = data.error.stack;
          pending.reject(err);
        } else {
          pending.resolve(data.result);
        }
      } else {
        console.warn(`[RemoteExtHostProxy] Orphan response id=${data.id}`);
      }
    } else if (data.type === 'event') {
      this._emit(data.method, ...(data.args || []));
    }
  }

  // =========================================================================
  // RPC interface (mirrors WorkerProxy)
  // =========================================================================

  /**
   * Send a request and wait for response
   */
  async request(method, args = [], timeout = this.defaultTimeout) {
    if (this.state === 'terminated') {
      throw new Error('Remote extension host is disconnected');
    }

    const msg = createRequest(method, args);
    msg.generation = this.generation;

    // Register the pending response handler BEFORE sending so a fast
    // response arriving mid-chunk-send doesn't get orphaned.
    const responsePromise = new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pendingRequests.delete(msg.id);
        reject(new Error(`Remote request timeout: ${method}`));
      }, timeout);

      this.pendingRequests.set(msg.id, {
        resolve,
        reject,
        timeout: timeoutId,
        startTime: performance.now(),
      });
    });

    // Prevent unhandled rejection: if ch.onerror fires while _sendRaw is
    // still in-flight, _rejectAllPending rejects responsePromise before
    // anyone is awaiting it.  This no-op catch absorbs that; the real
    // error still propagates through the _sendRaw throw below.
    responsePromise.catch(() => {});

    // Send (may involve chunking for large payloads).
    // If the send fails (e.g. SCTP transport died), we MUST clean up the
    // pending request to avoid a double-reject.
    try {
      await this._sendRaw(msg);
    } catch (sendErr) {
      const pending = this.pendingRequests.get(msg.id);
      if (pending) {
        clearTimeout(pending.timeout);
        this.pendingRequests.delete(msg.id);
      }
      throw sendErr;
    }

    return responsePromise;
  }

  /**
   * Send an event (fire-and-forget)
   */
  send(method, args = []) {
    const msg = createEvent(method, args);
    msg.generation = this.generation;
    this._sendRaw(msg); // fire-and-forget, no await needed
  }

  /**
   * Subscribe to events from the remote host
   */
  on(event, callback) {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, []);
    }
    this.eventListeners.get(event).push(callback);

    return () => {
      const listeners = this.eventListeners.get(event);
      if (listeners) {
        const idx = listeners.indexOf(callback);
        if (idx !== -1) listeners.splice(idx, 1);
      }
    };
  }

  _emit(event, ...args) {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      for (const cb of listeners.slice()) {
        try { cb(...args); } catch (err) {
          console.error(`[RemoteExtHostProxy] Event listener error (${event}):`, err);
        }
      }
    }
  }

  /** Max payload per DataChannel message (64KB is safe for all SCTP implementations) */
  static MAX_DC_MSG_SIZE = 64 * 1024;

  /** Max buffered amount before we wait for drain (256KB) */
  static MAX_BUFFERED = 256 * 1024;

  /** Send a JSON message over the DataChannel, chunking if necessary */
  async _sendRaw(obj) {
    if (!this.channel || this.channel.readyState !== 'open') {
      throw new Error('DataChannel not open (state: ' + (this.channel?.readyState ?? 'none') + ')');
    }
    try {
      const json = JSON.stringify(obj);

      if (json.length <= RemoteExtHostProxy.MAX_DC_MSG_SIZE) {
        // Small enough — send as-is (wait for buffer space first)
        await this._waitForBufferDrain();
        if (this.channel.readyState !== 'open') {
          throw new Error('DataChannel closed before send');
        }
        this.channel.send(json);
        return;
      }

      // Chunk the serialised JSON string into pieces.
      // Each chunk is a self-contained JSON line so the Rust bridge
      // (which forwards each DC message as one stdin line) and the
      // Node.js host can handle them independently.
      const msgId = ++this._chunkMsgIdCounter;
      const chunkSize = RemoteExtHostProxy.MAX_DC_MSG_SIZE - 200; // headroom for wrapper
      const total = Math.ceil(json.length / chunkSize);

      console.log(`[RemoteExtHostProxy] Chunking message (${json.length} chars) into ${total} chunks, msgId=${msgId}`);

      for (let i = 0; i < total; i++) {
        // Wait for SCTP buffer to drain before sending each chunk
        await this._waitForBufferDrain();
        if (this.channel.readyState !== 'open') {
          throw new Error('DataChannel closed during chunked send');
        }
        const chunk = {
          __chunk: true,
          msgId,
          idx: i,
          total,
          data: json.slice(i * chunkSize, (i + 1) * chunkSize),
        };
        try {
          this.channel.send(JSON.stringify(chunk));
        } catch (sendErr) {
          // Wrap OperationError so the message includes 'DataChannel' for
          // transport error classification
          throw new Error(`DataChannel send failed (chunk ${i + 1}/${total}): ${sendErr.message}`);
        }
      }
    } catch (e) {
      console.error('[RemoteExtHostProxy] Send failed:', e.message);
      throw e; // let caller handle
    }
  }

  /**
   * Wait until the DataChannel's bufferedAmount drops below MAX_BUFFERED.
   * Uses the onbufferedamountlow event when available, with a polling fallback.
   */
  _waitForBufferDrain() {
    if (!this.channel || this.channel.readyState !== 'open') {
      return Promise.reject(new Error('DataChannel closed'));
    }
    if (this.channel.bufferedAmount <= RemoteExtHostProxy.MAX_BUFFERED) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      // Set the low-water mark for the event
      this.channel.bufferedAmountLowThreshold = RemoteExtHostProxy.MAX_BUFFERED;

      const onLow = () => {
        cleanup();
        resolve();
      };
      const onClose = () => {
        cleanup();
        reject(new Error('DataChannel closed during drain wait'));
      };

      const cleanup = () => {
        clearTimeout(pollTimer);
        this.channel?.removeEventListener('bufferedamountlow', onLow);
        this.channel?.removeEventListener('close', onClose);
      };

      this.channel.addEventListener('bufferedamountlow', onLow, { once: true });
      this.channel.addEventListener('close', onClose, { once: true });

      // Polling fallback in case the event doesn't fire (some browsers)
      const pollTimer = setInterval(() => {
        if (!this.channel || this.channel.readyState !== 'open') {
          cleanup();
          reject(new Error('DataChannel closed during drain wait'));
        } else if (this.channel.bufferedAmount <= RemoteExtHostProxy.MAX_BUFFERED) {
          cleanup();
          resolve();
        }
      }, 50);
    });
  }

  // =========================================================================
  // Convenience methods (mirrors WorkerProxy)
  // =========================================================================

  /**
   * Load an extension on the remote host.
   *
   * For large code bundles (>16KB) the code is streamed to the remote host
   * as a series of small `uploadCodeChunk` events BEFORE the actual
   * `loadExtension` RPC call (which is sent with code=null).  Each chunk
   * is small enough (~16KB) that even after JSON escaping it fits in a
   * single DataChannel message — avoiding the double-escaping problem
   * that occurs when _sendRaw has to sub-chunk a large JSON payload.
   */
  async loadExtension(extensionId, code, manifest) {
    const CODE_CHUNK_SIZE = 16 * 1024; // 16KB — safe after JSON escaping

    if (typeof code === 'string' && code.length > CODE_CHUNK_SIZE) {
      const totalChunks = Math.ceil(code.length / CODE_CHUNK_SIZE);
      console.log(
        `[RemoteExtHostProxy] Streaming ${code.length} chars in ${totalChunks} chunks for ${extensionId}`
      );

      for (let i = 0; i < totalChunks; i++) {
        const chunk = code.slice(i * CODE_CHUNK_SIZE, (i + 1) * CODE_CHUNK_SIZE);
        const msg = createEvent('uploadCodeChunk', [
          extensionId,
          i,
          totalChunks,
          chunk,
        ]);
        msg.generation = this.generation;
        await this._sendRaw(msg);
      }

      console.log(
        `[RemoteExtHostProxy] All ${totalChunks} chunks sent, calling loadExtension for ${extensionId}`
      );
      // code=null tells the remote host to assemble from uploaded chunks
      return this.request('loadExtension', [extensionId, null, manifest], 60000);
    }

    // Small code — send inline as before
    const codeLen = typeof code === 'string' ? code.length : 0;
    const timeout = Math.min(
      60000,
      20000 + Math.ceil(codeLen / (1024 * 1024)) * 5000
    );
    return this.request('loadExtension', [extensionId, code, manifest], timeout);
  }

  activateExtension(extensionId) {
    return this.request('activateExtension', [extensionId], 30000);
  }

  deactivateExtension(extensionId) {
    return this.request('deactivateExtension', [extensionId], 10000);
  }

  executeCommand(commandId, ...args) {
    return this.request('executeCommand', [commandId, ...args], 10000);
  }

  resolveTreeData(viewId) {
    return this.request('resolveTreeData', [viewId], 15000);
  }

  notifyDocumentOpen(document) {
    this.send(MainToWorkerMethods.TEXT_DOCUMENT_OPEN, [document]);
  }

  notifyDocumentChange(uri, changes, version) {
    this.send(MainToWorkerMethods.TEXT_DOCUMENT_CHANGE, [uri, changes, version]);
  }

  notifyDocumentClose(uri) {
    this.send(MainToWorkerMethods.TEXT_DOCUMENT_CLOSE, [uri]);
  }

  notifySelectionChange(uri, selections) {
    this.send(MainToWorkerMethods.SELECTION_CHANGE, [uri, selections]);
  }

  isReady() {
    return this.ready;
  }

  terminate() {
    this._rejectAllPending('Terminated');
    if (this._gcInterval) clearInterval(this._gcInterval);
    if (this.channel) {
      try { this.channel.close(); } catch (_) {}
    }
    this.state = 'terminated';
    this.ready = false;
  }

  _rejectAllPending(reason) {
    for (const [id, pending] of this.pendingRequests) {
      clearTimeout(pending.timeout);
      pending.reject(new Error(reason));
    }
    this.pendingRequests.clear();
  }
}
