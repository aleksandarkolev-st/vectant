import SynthiException from "@/components/SynthiException";

const DEFAULT_WS_URL =
  process.env.NEXT_PUBLIC_GATEWAY_WS_URL || 'ws://localhost:7070/ws';
// Increase timeout to better accommodate long-running AI/gateway requests.
const DEFAULT_TIMEOUT = 120_000;

const STATUS = {
  IDLE: 'idle',
  CONNECTING: 'connecting',
  CONNECTED: 'connected',
  DISCONNECTED: 'disconnected',
  ERROR: 'error',
};

const READY_STATES = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
};

const createRequestId = () => {
  const cryptoRef = globalThis?.crypto;
  if (cryptoRef?.randomUUID) {
    return cryptoRef.randomUUID();
  }
  return `req_${Math.random().toString(36).slice(2, 10)}`;
};

export class AnalyzerGatewayClient {
  constructor({
    url = DEFAULT_WS_URL,
    timeout = DEFAULT_TIMEOUT,
    autoReconnect = true,
    maxReconnectDelay = 10_000,
    debug = false,
  } = {}) {
    this.url = url;
    this.timeout = timeout;
    this.autoReconnect = autoReconnect;
    this.maxReconnectDelay = maxReconnectDelay;
    this.debug = debug;
    this.socket = null;
    this.status = STATUS.IDLE;
    this.messageQueue = [];
    this.pending = new Map();
    this.statusListeners = new Set();
    this.eventListeners = new Set();
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.isDisposed = false;
  }

  get readyState() {
    return this.socket?.readyState ?? READY_STATES.CLOSED;
  }

  start() {
    if (this.isDisposed || typeof window === 'undefined') {
      return;
    }

    if (
      this.socket &&
      (this.readyState === READY_STATES.OPEN ||
        this.readyState === READY_STATES.CONNECTING)
    ) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    try {
      this.socket = new WebSocket(this.url);
    } catch (err) {
      this._setStatus(STATUS.ERROR);
      this._emitEvent({ type: 'error', error: err });
      this._scheduleReconnect();
      return;
    }

    this._setStatus(STATUS.CONNECTING);

    this.socket.addEventListener('open', this._handleOpen);
    this.socket.addEventListener('message', this._handleMessage);
    this.socket.addEventListener('error', this._handleSocketError);
    this.socket.addEventListener('close', this._handleClose);
  }

  dispose() {
    this.isDisposed = true;
    this.autoReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._cleanupSocket();
    this._rejectAllPending(
      new SynthiException('Gateway disposed before receiving a response', 'The analyzer gateway client has been disposed and can no longer process requests.')
    );
  }

  onStatusChange(listener) {
    if (typeof listener !== 'function') return () => {};
    this.statusListeners.add(listener);
    listener(this.status);
    return () => this.statusListeners.delete(listener);
  }

  onEvent(listener) {
    if (typeof listener !== 'function') return () => {};
    this.eventListeners.add(listener);
    return () => this.eventListeners.delete(listener);
  }

  analyzeStatic(payload) {
    return this._sendRequest('analyze/static', payload);
  }

  // `options` may include `{ onStream: (chunk) => {} }` to receive
  // partial streaming chunks emitted by the gateway for this request.
  analyzeAi(payload, options = {}) {
    return this._sendRequest('analyze/ai', payload, options);
  }

  /**
   * Run proactive analysis (static + semantic + optional AI)
   * @param {Object} payload - Analysis request
   * @param {string} payload.code - Code to analyze
   * @param {string} payload.lang - Language identifier
   * @param {string} [payload.filePath] - File path for context
   * @param {string[]} [payload.tiers] - Tiers to run: 'static', 'semantic', 'ai'
   * @param {boolean} [payload.includeAi] - Include AI analysis tier
   * @param {number} [payload.maxDiagnostics] - Max diagnostics to return
   * @param {Array} [payload.relatedFiles] - Related files for context
   * @param {Object} [options] - Request options
   * @param {Function} [options.onTierComplete] - Callback when a tier completes
   * @returns {Promise<Object>} Analysis result with diagnostics
   */
  analyzeProactive(payload, options = {}) {
    return this._sendRequest('analyze/proactive', payload, {
      ...options,
      onStream: (data) => {
        // Handle tier completion events
        if (data?.tier && typeof options.onTierComplete === 'function') {
          options.onTierComplete({
            tier: data.tier,
            diagnostics: data.diagnostics || [],
            elapsedMs: data.elapsedMs || 0,
            fromCache: data.fromCache || false,
          });
        }
        // Also forward to generic stream handler if provided
        if (typeof options.onStream === 'function') {
          options.onStream(data);
        }
      },
    });
  }

  /**
   * Container-First proactive analysis (RECOMMENDED)
   * 
   * This endpoint does NOT require content - only file paths.
   * The server fetches content directly from the container filesystem,
   * ensuring the AI analyzes exactly what the compiler sees.
   * 
   * @param {Object} payload - Analysis request
   * @param {string} payload.slug - Workspace slug (container ID)
   * @param {string} payload.filePath - File path within workspace
   * @param {string} payload.lang - Language identifier
   * @param {string[]} [payload.relatedPaths] - Related file paths for cross-file analysis
   * @param {boolean} [payload.includeAi] - Include AI analysis
   * @param {string[]} [payload.tiers] - Analysis tiers: 'static', 'semantic', 'ai'
   * @param {Object} [options] - Request options
   * @param {Function} [options.onTierComplete] - Callback when a tier completes
   * @returns {Promise<Object>} Analysis result with diagnostics
   */
  analyzeContainer(payload, options = {}) {
    // Map from frontend naming to backend naming
    const backendPayload = {
      slug: payload.slug,
      file_path: payload.filePath,
      lang: payload.lang,
      related_paths: payload.relatedPaths || [],
      include_ai: payload.includeAi || false,
      tiers: payload.tiers || ['static', 'semantic'],
      max_diagnostics: payload.maxDiagnostics || 50,
    };
    
    if (payload.model) backendPayload.model = payload.model;
    if (payload.apiKey) backendPayload.api_key = payload.apiKey;
    
    return this._sendRequest('analyze/container', backendPayload, {
      ...options,
      onStream: (data) => {
        if (data?.tier && typeof options.onTierComplete === 'function') {
          options.onTierComplete({
            tier: data.tier,
            diagnostics: data.diagnostics || [],
            elapsedMs: data.elapsedMs || 0,
            fromCache: data.fromCache || false,
          });
        }
        if (typeof options.onStream === 'function') {
          options.onStream(data);
        }
      },
    });
  }

  /**
   * Run quick proactive analysis (static + semantic only, optimized for real-time)
   * @param {Object} payload - Analysis request
   * @param {string} payload.code - Code to analyze  
   * @param {string} payload.lang - Language identifier
   * @param {string} [payload.filePath] - File path for context
   * @returns {Promise<Object>} Quick analysis result
   */
  analyzeProactiveQuick(payload) {
    return this._sendRequest('analyze/proactive/quick', payload);
  }

  /**
   * Run workspace-level multi-file analysis
   * @param {Object} payload - Workspace analysis request
   * @param {string} payload.workspaceId - Unique workspace identifier
   * @param {Array} [payload.changedFiles] - Files that changed (for incremental)
   * @param {Array} [payload.allFiles] - All workspace files
   * @param {string} [payload.focusFile] - Currently focused file path
   * @param {boolean} [payload.includeAi] - Include AI analysis
   * @param {number} [payload.maxDiagnosticsPerFile] - Max diagnostics per file
   * @param {boolean} [payload.incremental] - Use incremental mode
   * @param {Object} [options] - Request options
   * @param {Function} [options.onFileComplete] - Callback when a file analysis completes
   * @param {Function} [options.onSuggestions] - Callback when suggestions are received
   * @returns {Promise<Object>} Workspace analysis result
   */
  analyzeWorkspace(payload, options = {}) {
    return this._sendRequest('analyze/workspace', payload, {
      ...options,
      onStream: (data) => {
        // Handle per-file completion events
        if (data?.filePath && typeof options.onFileComplete === 'function') {
          options.onFileComplete({
            filePath: data.filePath,
            diagnostics: data.diagnostics || [],
            fromCache: data.fromCache || false,
          });
        }
        // Handle suggestions
        if (data?.suggestions && typeof options.onSuggestions === 'function') {
          options.onSuggestions(data.suggestions);
        }
        // Forward to generic stream handler
        if (typeof options.onStream === 'function') {
          options.onStream(data);
        }
      },
    });
  }

  /**
   * Run incremental workspace analysis (only changed files + dependents)
   * @param {Object} payload - Analysis request
   * @param {string} payload.workspaceId - Unique workspace identifier
   * @param {Array} payload.changedFiles - Files that changed
   * @param {Array} [payload.allFiles] - All workspace files for context
   * @param {string} [payload.focusFile] - Currently focused file path
   * @param {boolean} [payload.includeAi] - Include AI analysis
   * @param {Object} [options] - Request options
   * @returns {Promise<Object>} Incremental analysis result
   */
  analyzeWorkspaceIncremental(payload, options = {}) {
    return this._sendRequest('analyze/workspace/incremental', {
      ...payload,
      incremental: true,
    }, options);
  }

  _sendRequest(action, data, options = {}) {
    if (this.isDisposed) {
      return Promise.reject(new SynthiException('Gateway client has been disposed', 'The analyzer gateway client has been disposed and can no longer process requests.'));
    }

    if (!data || typeof data !== 'object') {
      return Promise.reject(new SynthiException('Payload must be an object', 'The payload provided to the analyzer gateway client must be an object.'));
    }

    const requestId = createRequestId();
    const envelope = JSON.stringify({ action, requestId, data });

    return new Promise((resolve, reject) => {
      const timeoutId = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new SynthiException(`Gateway request timed out after ${this.timeout}ms`, `The request to the analyzer gateway timed out after ${this.timeout} milliseconds.`));
      }, this.timeout);

      this.pending.set(requestId, {
        resolve,
        reject,
        timeoutId,
        action,
        // Optional streaming callback attached per-request
        onStream: typeof options.onStream === 'function' ? options.onStream : undefined,
      });

      this._enqueue(envelope);
      this.start();
    });
  }

  _enqueue(payload) {
    if (this.readyState === READY_STATES.OPEN) {
      try {
        this.socket.send(payload);
      } catch (err) {
        this._emitEvent({ type: 'error', error: err });
      }
      return;
    }
    this.messageQueue.push(payload);
  }

  _flushQueue() {
    if (this.messageQueue.length === 0 || this.readyState !== READY_STATES.OPEN) {
      return;
    }
    while (this.messageQueue.length > 0) {
      const payload = this.messageQueue.shift();
      try {
        this.socket.send(payload);
      } catch (err) {
        this._emitEvent({ type: 'error', error: err });
        break;
      }
    }
  }

  _handleOpen = () => {
    this._setStatus(STATUS.CONNECTED);
    this.reconnectAttempts = 0;
    this._flushQueue();
  };

  _handleMessage = (event) => {
    const raw = typeof event?.data === 'string' ? event.data : null;
    if (!raw) {
      return;
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch (err) {
      if (this.debug) {
        console.warn('Gateway message parse error', err, raw);
      }
      return;
    }

    if (payload?.requestId && this.pending.has(payload.requestId)) {
      const pending = this.pending.get(payload.requestId);
      this.pending.delete(payload.requestId);
      clearTimeout(pending.timeoutId);

      if (payload.type === 'error') {
        // Build a more informative Error including backend details
        const msgPart =
          typeof payload.message === 'string'
            ? payload.message
            : JSON.stringify(payload.message || 'Gateway returned an error payload');
        const detailPart = payload.detail
          ? `${
              typeof payload.detail === 'string' ? payload.detail : JSON.stringify(payload.detail)
            }`
          : '';

        const err = new SynthiException(msgPart, detailPart);
        // Attach raw payload for callers that want to inspect more fields
        err.gatewayPayload = payload;
        if (payload.status) err.status = payload.status;

        if (this.debug) {
          console.warn('Gateway returned error payload for request', payload.requestId, payload);
        }

        pending.reject(err);
      } else {
        pending.resolve(payload);
      }
      return;
    }

    if (payload?.type === 'error') {
      this._emitEvent({
        type: 'error',
        error: new SynthiException(payload.message || 'Gateway error', ''),
        payload,
      });
    } else {
      this._emitEvent({ type: 'message', payload });
    }
  };

  _handleSocketError = (event) => {
    if (this.debug) {
      console.error('Gateway socket error', event);
    }
    this._setStatus(STATUS.ERROR);
    this._emitEvent({
      type: 'error',
      error: new SynthiException('Gateway socket error', ''),
      event,
    });
  };

  _handleClose = () => {
    if (this.isDisposed) {
      return;
    }

    this._setStatus(STATUS.DISCONNECTED);
    this._cleanupSocket();
    this._rejectAllPending(new SynthiException('Gateway connection closed', 'The connection to the analyzer gateway was closed.'));
    this._scheduleReconnect();
  };

  _cleanupSocket() {
    if (!this.socket) return;
    this.socket.removeEventListener('open', this._handleOpen);
    this.socket.removeEventListener('message', this._handleMessage);
    this.socket.removeEventListener('error', this._handleSocketError);
    this.socket.removeEventListener('close', this._handleClose);
    try {
      if (
        this.socket.readyState === READY_STATES.OPEN ||
        this.socket.readyState === READY_STATES.CONNECTING
      ) {
        this.socket.close();
      }
    } catch (err) {
      // Swallow close errors.
    }
    this.socket = null;
  }

  _rejectAllPending(reason) {
    this.pending.forEach(({ reject, timeoutId }) => {
      clearTimeout(timeoutId);
      reject(reason);
    });
    this.pending.clear();
  }

  _scheduleReconnect() {
    if (!this.autoReconnect || this.isDisposed) {
      return;
    }
    this.reconnectAttempts += 1;
    const delay = Math.min(
      1000 * Math.pow(2, this.reconnectAttempts - 1),
      this.maxReconnectDelay
    );
    this.reconnectTimer = setTimeout(() => {
      this.start();
    }, delay);
  }

  _setStatus(nextStatus) {
    if (this.status === nextStatus) return;
    this.status = nextStatus;
    this.statusListeners.forEach((listener) => {
      try {
        listener(nextStatus);
      } catch (err) {
        if (this.debug) {
          console.warn('Gateway status listener error', err);
        }
      }
    });
  }

  _emitEvent(event) {
    // If the gateway emitted a streaming payload with a `streamId`, forward
    // it to any pending request that registered an `onStream` callback.
    try {
      const payload = event?.payload;
      if (payload && payload.streamId && this.pending.has(payload.streamId)) {
        const pending = this.pending.get(payload.streamId);
        try {
          if (pending?.onStream) pending.onStream(payload?.data ?? payload);
        } catch (e) {
          if (this.debug) console.warn('onStream callback error', e);
        }
      }
    } catch (e) {
      if (this.debug) console.warn('Stream dispatch error', e);
    }

    this.eventListeners.forEach((listener) => {
      try {
        listener(event);
      } catch (err) {
        if (this.debug) {
          console.warn('Gateway event listener error', err);
        }
      }
    });
  }
}

export const GatewayStatus = STATUS;
