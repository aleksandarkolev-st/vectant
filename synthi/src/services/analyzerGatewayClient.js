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
   * Unified Intelligence Pipeline analysis (RECOMMENDED)
   * 
   * This is the preferred endpoint that combines:
   * - Layer A: Static analysis (syntax patterns)
   * - Layer B: Semantic analysis (CppSemanticAnalyzer, etc.)
   * - Layer C: AI analysis (on-demand, triggered when errors found)
   * 
   * Content is fetched from the container filesystem - the client sends only paths.
   * This ensures the AI analyzes exactly what the compiler sees.
   * 
   * @param {Object} payload - Analysis request
   * @param {string} payload.slug - Workspace slug (container ID)
   * @param {string} payload.filePath - File path within workspace
   * @param {string} payload.lang - Language identifier
   * @param {number} [payload.version] - Document version for stale detection
   * @param {string[]} [payload.layers] - Analysis layers: 'static', 'semantic', 'ai'
   * @param {boolean} [payload.includeAi] - Force include AI layer
   * @param {boolean} [payload.triggerAiOnErrors] - Auto-trigger AI if errors found (default: true)
   * @param {number} [payload.maxDiagnostics] - Max diagnostics to return
   * @param {string} [payload.model] - AI model to use
   * @param {string} [payload.apiKey] - Custom API key for AI
   * @param {Object} [options] - Request options
   * @param {Function} [options.onLayerComplete] - Callback when a layer completes
   * @returns {Promise<Object>} Unified analysis result with deduplicated diagnostics
   */
  analyzeUnified(payload, options = {}) {
    // Map from frontend naming to backend naming (snake_case)
    const backendPayload = {
      slug: payload.slug,
      file_path: payload.filePath,
      lang: payload.lang,
      layers: payload.layers || ['static', 'semantic'],
      include_ai: payload.includeAi || false,
      trigger_ai_on_errors: payload.triggerAiOnErrors !== false, // Default true
      max_diagnostics: payload.maxDiagnostics || 50,
    };
    
    // Include version for stale detection
    if (typeof payload.version === 'number' || typeof payload.version === 'string') {
      backendPayload.version = payload.version;
    }

    // Include content override if provided
    if (typeof payload.content === 'string') {
      backendPayload.content = payload.content;
    }
    
    if (payload.model) backendPayload.model = payload.model;
    if (payload.apiKey) backendPayload.api_key = payload.apiKey;
    
    return this._sendRequest('analyze/unified', backendPayload, {
      ...options,
      onStream: (data) => {
        // Handle layer completion events (for streaming results)
        if (data?.layer && typeof options.onLayerComplete === 'function') {
          options.onLayerComplete({
            layer: data.layer,
            diagnostics: data.diagnostics || [],
            elapsedMs: data.elapsedMs || 0,
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

  // ==========================================================================
  // Self-Healing API
  // ==========================================================================

  /**
   * Analyze code for auto-healable micro-issues.
   * 
   * Returns detected fixes (missing colons, unused imports, etc.)
   * without applying them, unless autoApply is true.
   * 
   * @param {Object} payload - Healing request
   * @param {string} payload.code - Code to analyze
   * @param {string} payload.lang - Language identifier
   * @param {string} [payload.filePath] - File path
   * @param {boolean} [payload.autoApply=false] - Auto-apply safe fixes
   * @returns {Promise<Object>} Healing result with fixes
   */
  healAnalyze(payload) {
    return this._sendRequest('heal/analyze', {
      code: payload.code,
      lang: payload.lang,
      filePath: payload.filePath || 'untitled',
      autoApply: payload.autoApply || false,
    });
  }

  /**
   * Apply healing fixes to code.
   * 
   * Can apply all safe fixes or specific fix IDs.
   * 
   * @param {Object} payload - Apply request
   * @param {string} payload.code - Current code
   * @param {string} payload.lang - Language identifier
   * @param {string} [payload.filePath] - File path
   * @param {string[]} [payload.fixIds] - Specific fix IDs to apply (null = all safe)
   * @returns {Promise<Object>} Result with healed code
   */
  healApply(payload) {
    return this._sendRequest('heal/apply', {
      code: payload.code,
      lang: payload.lang,
      filePath: payload.filePath || 'untitled',
      fixIds: payload.fixIds || null,
    });
  }

  /**
   * Container-first healing: analyze file from container filesystem.
   * 
   * @param {Object} payload - Container healing request
   * @param {string} payload.slug - Workspace slug
   * @param {string} payload.filePath - File path in workspace
   * @param {string} payload.lang - Language identifier
   * @returns {Promise<Object>} Healing result
   */
  healContainer(payload) {
    return this._sendRequest('heal/container', {
      slug: payload.slug,
      filePath: payload.filePath,
      lang: payload.lang,
    });
  }

  /**
   * Get or update healing configuration.
   * 
   * @param {Object} [config] - Config updates (omit for GET)
   * @returns {Promise<Object>} Current configuration
   */
  healConfig(config = null) {
    return this._sendRequest('heal/config', config || {});
  }

  /**
   * Get healing statistics.
   * @returns {Promise<Object>} Healing stats
   */
  healStats() {
    return this._sendRequest('heal/stats', {});
  }

  /**
   * List all registered healing rules.
   * @returns {Promise<Object>} List of rules
   */
  healRules() {
    return this._sendRequest('heal/rules', {});
  }

  /**
   * Batch-analyse multiple files for healing issues.
   * @param {Object} payload - Batch request
   * @param {Array} payload.files - Files to analyse [{filePath, language, code, priority?}]
   * @returns {Promise<Object>} Aggregated batch result
   */
  healBatch(payload) {
    return this._sendRequest('heal/batch', payload);
  }

  /**
   * Get healing cache statistics.
   * @returns {Promise<Object>} Cache hit rate and size
   */
  healCacheStats() {
    return this._sendRequest('heal/cache/stats', {});
  }

  /**
   * List available healing configuration presets.
   * @returns {Promise<Object>} Preset names and their config values
   */
  healPresets() {
    return this._sendRequest('heal/presets', {});
  }

  /**
   * Apply a named healing configuration preset.
   * @param {string} presetName - e.g. "conservative", "balanced", "aggressive"
   * @returns {Promise<Object>} Applied config
   */
  healApplyPreset(presetName) {
    return this._sendRequest('heal/preset', { preset: presetName });
  }

  /**
   * Get Prometheus-compatible healing metrics.
   * @returns {Promise<Object>} Raw metrics text
   */
  healMetrics() {
    return this._sendRequest('heal/metrics', {});
  }

  // ─── AI Agent Methods ──────────────────────────────────────────────

  /**
   * Analyze code using the AI agent (LLM-powered detection).
   *
   * Sends code to the LLM which identifies real bugs:
   * logic errors, null safety, missing awaits, off-by-one, etc.
   *
   * @param {Object} payload - AI analysis request
   * @param {string} payload.code - Code to analyze
   * @param {string} payload.lang - Language identifier
   * @param {string} [payload.filePath] - File path
   * @param {string} [payload.workspaceRoot] - Workspace root for context
   * @param {boolean} [payload.autoApply=false] - Auto-apply safe fixes
   * @param {number} [payload.focusStartLine] - Focus range start
   * @param {number} [payload.focusEndLine] - Focus range end
   * @param {boolean} [payload.validateFixes=true] - Run validation pass
   * @param {number} [payload.minConfidence] - Minimum confidence threshold
   * @returns {Promise<Object>} AI analysis result with fixes
   */
  aiAnalyze(payload) {
    return this._sendRequest('heal/ai/analyze', {
      code: payload.code,
      lang: payload.lang,
      filePath: payload.filePath || 'untitled',
      workspaceRoot: payload.workspaceRoot || null,
      autoApply: payload.autoApply || false,
      focusStartLine: payload.focusStartLine ?? null,
      focusEndLine: payload.focusEndLine ?? null,
      validateFixes: payload.validateFixes ?? true,
      minConfidence: payload.minConfidence ?? null,
    });
  }

  /**
   * Analyze multiple files using the AI agent in one LLM call.
   *
   * @param {Object} payload - Batch request
   * @param {Object} payload.files - Object of { path: sourceCode }
   * @param {string} [payload.lang] - Language identifier
   * @param {boolean} [payload.autoApply=false] - Auto-apply safe fixes
   * @returns {Promise<Object>} Batch analysis results by file
   */
  aiBatch(payload) {
    return this._sendRequest('heal/ai/batch', {
      files: payload.files,
      lang: payload.lang || null,
      autoApply: payload.autoApply || false,
    });
  }

  /**
   * Run hybrid analysis: regex rules + AI detection, merged results.
   *
   * @param {Object} payload - Hybrid request
   * @param {string} payload.code - Code to analyze
   * @param {string} payload.lang - Language identifier
   * @param {string} [payload.filePath] - File path
   * @param {string} [payload.workspaceRoot] - Workspace root for context
   * @param {boolean} [payload.autoApply=false] - Auto-apply safe fixes
   * @returns {Promise<Object>} Merged results
   */
  aiHybrid(payload) {
    return this._sendRequest('heal/ai/hybrid', {
      code: payload.code,
      lang: payload.lang,
      filePath: payload.filePath || 'untitled',
      workspaceRoot: payload.workspaceRoot || null,
      autoApply: payload.autoApply || false,
    });
  }

  /**
   * Get AI agent statistics: LLM calls, latency, acceptance rate.
   * @returns {Promise<Object>} Agent statistics
   */
  aiStats() {
    return this._sendRequest('heal/ai/stats', {});
  }

  /**
   * Submit feedback for an AI-generated fix.
   * This teaches the agent to improve over time.
   * @param {Object} payload - Feedback data
   * @param {string} payload.ruleId - The AI rule id (e.g. "AI_LOGIC_ERROR")
   * @param {string} payload.feedbackType - One of: accepted, rejected, modified, auto_applied
   * @param {string} [payload.filePath] - File the fix was in
   * @param {string} [payload.originalText] - Original code
   * @param {string} [payload.replacementText] - Replacement code
   * @param {string} [payload.description] - Fix description
   * @returns {Promise<Object>} Feedback acknowledgement
   */
  aiFeedback(payload) {
    if (!payload?.ruleId || !payload?.feedbackType) {
      return Promise.reject(new Error('ruleId and feedbackType are required'));
    }
    return this._sendRequest('heal/ai/feedback', payload);
  }

  /**
   * Get the AI agent memory summary — acceptance rates, suppressed patterns.
   * @returns {Promise<Object>} Memory summary
   */
  aiMemory() {
    return this._sendRequest('heal/ai/memory', {});
  }

  /**
   * Clear all AI agent learned patterns.
   * Resets acceptance rates, un-suppresses everything.
   * @returns {Promise<Object>} Clear confirmation
   */
  aiMemoryClear() {
    return this._sendRequest('heal/ai/memory/clear', {});
  }

  /**
   * Run streaming AI analysis — receives progressive events as fixes are found.
   *
   * @param {Object} payload
   * @param {string} payload.code       – file content to analyze
   * @param {string} payload.lang       – language id
   * @param {string} [payload.filePath] – workspace-relative file path
   * @param {Object} callbacks
   * @param {Function} [callbacks.onProgress] – (data) => void, progress updates
   * @param {Function} [callbacks.onPartialFix] – (fix) => void, each fix as it arrives
   * @param {Function} [callbacks.onComplete]  – (data) => void, final result
   * @param {Function} [callbacks.onError]     – (err) => void, error events
   * @returns {Promise<void>} resolves when stream ends
   */
  aiStream(payload, callbacks = {}) {
    return new Promise((resolve, reject) => {
      const requestId = this._sendRequest('heal/ai/stream', {
        code: payload.code,
        lang: payload.lang || 'plaintext',
        filePath: payload.filePath,
        workspaceRoot: payload.workspaceRoot,
        validateFixes: payload.validateFixes ?? true,
        minConfidence: payload.minConfidence,
      });

      // Listen for stream messages matching this requestId
      const handler = (event) => {
        const msg = typeof event.data === 'string' ? JSON.parse(event.data) : event.data;
        if (!msg || msg.requestId !== requestId) return;

        if (msg.type === 'stream') {
          const ev = msg.event || msg.data?.event;
          if (ev === 'progress' && callbacks.onProgress) {
            callbacks.onProgress(msg.data);
          } else if (ev === 'partial_fix' && callbacks.onPartialFix) {
            callbacks.onPartialFix(msg.data);
          } else if (ev === 'complete' && callbacks.onComplete) {
            callbacks.onComplete(msg.data);
          } else if (ev === 'error' && callbacks.onError) {
            callbacks.onError(msg.data);
          }
        }

        if (msg.type === 'stream_end') {
          cleanup();
          resolve();
        }
      };

      const cleanup = () => {
        if (this._ws) {
          this._ws.removeEventListener('message', handler);
        }
      };

      if (this._ws) {
        this._ws.addEventListener('message', handler);
      }

      // Safety timeout — 60 s
      setTimeout(() => {
        cleanup();
        resolve();
      }, 60_000);
    });
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
