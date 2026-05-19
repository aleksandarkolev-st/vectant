/**
 * Runtime Error Interceptor
 * 
 * Listens to HMR compile errors on the CustomEvent bus and orchestrates
 * the AI healing loop:
 * 
 *   compile-error → collect source + diagnostics → AI fix → apply → retry compile
 * 
 * This is a singleton service (not a React hook) so it works regardless
 * of which components are mounted. The React hook `useRuntimeHealing`
 * provides the reactive UI layer on top of this.
 * 
 * Events consumed:
 *   - synthi:compile-error     — compiler diagnostics from build worker
 *   - synthi:request-ai-fix    — manual "fix with AI" button clicks
 *   - synthi:hmr-status        — HMR status changes (fail, rejected, etc.)
 * 
 * Events produced:
 *   - synthi:runtime-heal-start    — healing attempt started
 *   - synthi:runtime-heal-result   — healing result (success/fail + healed code)
 *   - synthi:runtime-heal-applied  — fix was applied to the editor
 *   - synthi:runtime-heal-error    — healing pipeline error
 *   - synthi:retry-compile         — request HMR re-trigger after fix applied
 */

// ── Configuration ──────────────────────────────────────────────────────

const MAX_HEAL_ATTEMPTS = 3;       // Max consecutive heal attempts per file
const HEAL_COOLDOWN_MS = 2000;     // Minimum time between heal attempts
const AUTO_HEAL_DELAY_MS = 800;    // Delay before auto-healing (debounce rapid errors)
const ATTEMPT_RESET_MS = 30000;    // Reset attempt counter after this idle period
const HMR_FAILURE_REPORT_COOLDOWN_MS = 5000;

// ── State ──────────────────────────────────────────────────────────────

let _instance = null;

class RuntimeErrorInterceptor {
  constructor() {
    /** @type {import('./analyzerGatewayClient').AnalyzerGatewayClient | null} */
    this._gateway = null;
    /** @type {Function | null} — returns the Monaco editor instance */
    this._getEditor = null;
    /** @type {boolean} */
    this._enabled = false;
    /** @type {boolean} — auto-heal on compile error (vs manual only) */
    this._autoHeal = true;
    
    // Per-file healing state
    /** @type {Map<string, { attempts: number, lastAttempt: number, timer: any }>} */
    this._fileState = new Map();

    // Best-effort dedupe for agentic HMR-failure observability.
    /** @type {Map<string, number>} */
    this._hmrFailureReports = new Map();
    
    // Currently active healing request (only one at a time)
    this._activeRequest = null;
    
    // Bound event handlers (for cleanup)
    this._onCompileError = this._handleCompileError.bind(this);
    this._onCompileDiagnostics = this._handleCompileDiagnostics.bind(this);
    this._onRequestAIFix = this._handleRequestAIFix.bind(this);
    this._onHMRStatus = this._handleHMRStatus.bind(this);
    
    // Listeners for state changes (React hooks subscribe here)
    /** @type {Set<Function>} */
    this._listeners = new Set();
    
    // Observable state
    this._state = {
      status: 'idle',         // idle | healing | applying | retrying | error | success
      filePath: null,
      attempt: 0,
      maxAttempts: MAX_HEAL_ATTEMPTS,
      lastResult: null,       // last healing result from backend
      lastError: null,        // last error message
    };
  }

  // ── Lifecycle ──────────────────────────────────────────────────────

  /**
   * Initialize the interceptor with required dependencies.
   * @param {Object} opts
   * @param {import('./analyzerGatewayClient').AnalyzerGatewayClient} opts.gateway
   * @param {Function} opts.getEditor — returns the active Monaco editor
   * @param {boolean} [opts.autoHeal=true] — auto-heal on compile errors
   */
  init({ gateway, getEditor, autoHeal = true }) {
    const firstInit = !this._initialized;
    this._gateway = gateway;
    this._getEditor = getEditor;
    this._autoHeal = autoHeal;
    this._initialized = true;
    // Only log on first init — this function gets called by multiple hooks
    // on every render, flooding the console with identical messages.
    if (firstInit) {
      console.log('[RuntimeHealing] Interceptor initialized', { autoHeal });
    }
  }

  /**
   * Start listening to HMR error events.
   */
  start() {
    if (this._enabled) return;
    if (typeof window === 'undefined') return;
    
    window.addEventListener('synthi:compile-error', this._onCompileError);
    window.addEventListener('synthi:compile-diagnostics', this._onCompileDiagnostics);
    window.addEventListener('synthi:request-ai-fix', this._onRequestAIFix);
    window.addEventListener('synthi:hmr-status', this._onHMRStatus);
    
    this._enabled = true;
    console.log('[RuntimeHealing] Interceptor started — listening for errors');
  }

  /**
   * Stop listening and clean up.
   */
  stop() {
    if (!this._enabled) return;
    if (typeof window === 'undefined') return;
    
    window.removeEventListener('synthi:compile-error', this._onCompileError);
    window.removeEventListener('synthi:compile-diagnostics', this._onCompileDiagnostics);
    window.removeEventListener('synthi:request-ai-fix', this._onRequestAIFix);
    window.removeEventListener('synthi:hmr-status', this._onHMRStatus);
    
    // Clear any pending auto-heal timers
    for (const state of this._fileState.values()) {
      if (state.timer) clearTimeout(state.timer);
    }
    this._fileState.clear();
    this._enabled = false;
    
    console.log('[RuntimeHealing] Interceptor stopped');
  }

  // ── Event Handlers ─────────────────────────────────────────────────

  /**
   * Handle compile-diagnostics events from compilerClient.
   * Bridges to _handleCompileError by extracting error diagnostics.
   */
  _handleCompileDiagnostics(event) {
    const detail = event.detail || {};
    const diagnostics = Array.isArray(detail.diagnostics) ? detail.diagnostics : [];
    const errorCount = detail.error_count || 0;
    
    if (errorCount === 0 && diagnostics.length === 0) return;
    
    // Bridge to the existing compile-error handler
    this._handleCompileError(new CustomEvent('synthi:compile-error', {
      detail: { diagnostics, module: detail.language || null },
    }));
  }

  /**
   * Handle compile-error events from the build worker.
   * If auto-heal is on, debounce and start healing.
   */
  _handleCompileError(event) {
    const detail = event.detail || {};
    const diagnostics = Array.isArray(detail.diagnostics) ? detail.diagnostics : [];
    const module = detail.module || null;
    
    // Only heal on actual errors (not warnings)
    const errorDiags = diagnostics.filter(
      d => d.severity === 'error' || d.severity === 'fatal'
    );
    if (errorDiags.length === 0) return;
    
    console.log(
      `[RuntimeHealing] Compile error: ${errorDiags.length} errors in ${module || 'unknown'}`
    );
    
    if (this._autoHeal) {
      this._scheduleAutoHeal(module, errorDiags);
    }
  }

  /**
   * Handle manual "Fix with AI" button clicks from ErrorOverlay.
   */
  _handleRequestAIFix(event) {
    const detail = event.detail || {};
    const diagnostic = detail.diagnostic;
    const module = detail.module;
    const allDiagnostics = detail.allDiagnostics || (diagnostic ? [diagnostic] : []);
    
    console.log('[RuntimeHealing] Manual AI fix requested for:', module);
    
    // Manual request — skip debounce, heal immediately
    this._doHeal(module, allDiagnostics, { manual: true });
  }

  /**
   * Handle HMR status changes — 'applied' (success after healing),
   * 'compile-error' (bridge to healing), 'fail', 'rejected'.
   */
  _handleHMRStatus(event) {
    const detail = event.detail || {};
    const data = detail.data || detail;
    const status = data.status;
    
    // If HMR applied successfully after we healed, clear attempt counter
    if (status === 'applied' && this._state.status === 'retrying') {
      this._updateState({ status: 'success', lastError: null });
      this._dispatch('synthi:runtime-heal-applied', {
        filePath: this._state.filePath,
        attempt: this._state.attempt,
      });
      // Reset attempts on success
      const filePath = this._state.filePath;
      if (filePath) {
        this._fileState.delete(filePath);
      }
      console.log('[RuntimeHealing] ✓ HMR applied after healing!');
    }
    
    // If compile-error arrives via hmr-status, bridge to the compile error handler
    if (status === 'compile-error') {
      const diagnostics = data.diagnostics || [];
      if (diagnostics.length > 0 || data.error_count > 0) {
        this._handleCompileError(new CustomEvent('synthi:compile-error', {
          detail: { diagnostics, module: data.language || null },
        }));
      }
    }

    if (
      status === 'rejected'
      || status === 'fail'
      || status === 'crash-fatal'
      || status === 'full-reload-required'
    ) {
      this._reportHmrFailure(data);
    }
  }

  // ── Auto-heal scheduling ──────────────────────────────────────────

  _scheduleAutoHeal(module, diagnostics) {
    const filePath = this._resolveFilePath(module, diagnostics);
    const state = this._getFileState(filePath);
    
    // Clear existing debounce timer
    if (state.timer) clearTimeout(state.timer);
    
    // Check if we've exceeded max attempts
    if (state.attempts >= MAX_HEAL_ATTEMPTS) {
      const elapsed = Date.now() - state.lastAttempt;
      if (elapsed < ATTEMPT_RESET_MS) {
        console.log(
          `[RuntimeHealing] Max attempts (${MAX_HEAL_ATTEMPTS}) reached for ${filePath}, ` +
          `waiting ${Math.round((ATTEMPT_RESET_MS - elapsed) / 1000)}s before retry`
        );
        return;
      }
      // Reset after cooldown
      state.attempts = 0;
    }
    
    // Check cooldown
    const sinceLastAttempt = Date.now() - state.lastAttempt;
    if (sinceLastAttempt < HEAL_COOLDOWN_MS) {
      const waitMs = HEAL_COOLDOWN_MS - sinceLastAttempt;
      state.timer = setTimeout(() => {
        this._doHeal(module, diagnostics, { manual: false });
      }, waitMs);
      return;
    }
    
    // Debounce rapid errors (e.g., save triggers multiple compile events)
    state.timer = setTimeout(() => {
      this._doHeal(module, diagnostics, { manual: false });
    }, AUTO_HEAL_DELAY_MS);
  }

  // ── Core healing pipeline ──────────────────────────────────────────

  /**
   * Execute the healing pipeline:
   * 1. Get source code from editor
   * 2. Send diagnostics + code to AI backend
   * 3. If healed code returned, apply it
   * 4. Trigger HMR retry
   */
  async _doHeal(module, diagnostics, { manual = false } = {}) {
    if (!this._gateway || !this._getEditor) {
      console.warn('[RuntimeHealing] Not initialized — skipping heal');
      return;
    }
    
    // Don't overlap concurrent healing requests
    if (this._activeRequest && !manual) {
      console.log('[RuntimeHealing] Healing already in progress, skipping');
      return;
    }
    
    const editor = this._getEditor();
    if (!editor) {
      console.warn('[RuntimeHealing] No active editor — cannot heal');
      return;
    }
    
    const model = editor.getModel?.();
    if (!model) {
      console.warn('[RuntimeHealing] No editor model — cannot heal');
      return;
    }
    
    const sourceCode = model.getValue();
    const filePath = model.uri?.path || module || 'untitled';
    const language = model.getLanguageId?.() || this._guessLanguage(filePath);
    
    // Update attempt tracking
    const state = this._getFileState(filePath);
    state.attempts++;
    state.lastAttempt = Date.now();
    
    // Update observable state
    this._updateState({
      status: 'healing',
      filePath,
      attempt: state.attempts,
      lastResult: null,
      lastError: null,
    });
    
    this._dispatch('synthi:runtime-heal-start', {
      filePath,
      module,
      diagnosticCount: diagnostics.length,
      attempt: state.attempts,
      manual,
    });
    
    console.log(
      `[RuntimeHealing] Healing attempt ${state.attempts}/${MAX_HEAL_ATTEMPTS} ` +
      `for ${filePath} (${diagnostics.length} diagnostics, ${manual ? 'manual' : 'auto'})`
    );
    
    try {
      this._activeRequest = true;
      
      const result = await this._gateway.aiRuntimeHeal({
        code: sourceCode,
        lang: language,
        filePath,
        diagnostics,
        module,
        autoApply: true,
      });
      
      this._activeRequest = null;
      
      if (!result || result.error) {
        throw new Error(result?.error || result?.detail || 'Unknown backend error');
      }
      
      this._updateState({ lastResult: result });
      
      this._dispatch('synthi:runtime-heal-result', {
        filePath,
        result,
        attempt: state.attempts,
      });
      
      // If we got healed code, apply it
      if (result.wasHealed && result.healedCode) {
        console.log(
          `[RuntimeHealing] Got healed code (${result.appliedFixes?.length || 0} fixes applied)`
        );
        
        this._updateState({ status: 'applying' });
        
        // Apply the healed code to the editor
        const applied = this._applyHealedCode(editor, model, result.healedCode);
        
        if (applied) {
          this._updateState({ status: 'retrying' });
          
          // Trigger HMR re-compile
          setTimeout(() => {
            this._dispatch('synthi:retry-compile', {
              module,
              filePath,
              reason: 'runtime-healing',
            });
            console.log('[RuntimeHealing] Triggered HMR retry');
          }, 300); // Small delay to let the editor update propagate
        } else {
          this._updateState({ status: 'error', lastError: 'Failed to apply healed code' });
        }
      } else {
        // AI couldn't fix it
        console.log('[RuntimeHealing] AI could not produce a fix');
        this._updateState({
          status: 'error',
          lastError: `AI found ${result.fixCount || 0} potential fixes but none were safe to apply`,
        });
      }
    } catch (err) {
      this._activeRequest = null;
      console.error('[RuntimeHealing] Pipeline error:', err);
      this._updateState({
        status: 'error',
        lastError: err.message || 'Healing pipeline error',
      });
      this._dispatch('synthi:runtime-heal-error', {
        filePath,
        error: err.message,
        attempt: state.attempts,
      });
    }
  }

  // ── Editor operations ──────────────────────────────────────────────

  /**
   * Apply healed code to the Monaco editor as a single undoable edit.
   * @returns {boolean} Whether the edit was applied
   */
  _applyHealedCode(editor, model, healedCode) {
    try {
      const fullRange = model.getFullModelRange();
      
      // Apply as a single edit so the user can Ctrl+Z to undo
      editor.executeEdits('runtime-healing', [{
        range: fullRange,
        text: healedCode,
        forceMoveMarkers: true,
      }]);
      
      console.log('[RuntimeHealing] Healed code applied to editor');
      return true;
    } catch (err) {
      console.error('[RuntimeHealing] Failed to apply healed code:', err);
      return false;
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  _getFileState(filePath) {
    if (!this._fileState.has(filePath)) {
      this._fileState.set(filePath, { attempts: 0, lastAttempt: 0, timer: null });
    }
    return this._fileState.get(filePath);
  }

  _resolveFilePath(module, diagnostics) {
    // Try to get file path from diagnostics first
    for (const d of diagnostics) {
      const loc = d.location || {};
      if (loc.file) return loc.file;
    }
    return module || 'unknown';
  }

  _guessLanguage(filePath) {
    const ext = filePath.split('.').pop()?.toLowerCase();
    const map = {
      js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
      py: 'python', rs: 'rust', cpp: 'cpp', c: 'c', go: 'go',
      java: 'java', kt: 'kotlin', swift: 'swift', rb: 'ruby',
      css: 'css', html: 'html', json: 'json', yaml: 'yaml',
    };
    return map[ext] || ext || 'plaintext';
  }

  _resolveHmrFailurePath(statusData) {
    if (statusData?.filePath) return statusData.filePath;
    if (statusData?.file_path) return statusData.file_path;
    if (this._state.filePath) return this._state.filePath;

    const editor = this._getEditor?.();
    const model = editor?.getModel?.();
    const editorPath = model?.uri?.path;
    if (editorPath) return editorPath;

    return statusData?.module || statusData?.module_id || 'unknown';
  }

  _reportHmrFailure(statusData) {
    if (!this._gateway?.agenticRecordHmrFailure) {
      return;
    }

    const filePath = this._resolveHmrFailurePath(statusData);
    const status = statusData?.status || 'unknown';
    const reportKey = `${status}:${filePath}`;
    const now = Date.now();
    const lastReportAt = this._hmrFailureReports.get(reportKey) || 0;

    if (now - lastReportAt < HMR_FAILURE_REPORT_COOLDOWN_MS) {
      return;
    }

    this._hmrFailureReports.set(reportKey, now);

    void this._gateway.agenticRecordHmrFailure({ filePath }).catch((err) => {
      console.warn('[RuntimeHealing] Failed to record HMR failure', {
        filePath,
        status,
        error: err?.message || err,
      });
    });
  }

  _dispatch(eventName, detail) {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent(eventName, { detail }));
    }
  }

  // ── Observable state (for React hooks) ─────────────────────────────

  _updateState(partial) {
    this._state = { ...this._state, ...partial };
    this._listeners.forEach(fn => {
      try { fn(this._state); } catch (e) { /* ignore listener errors */ }
    });
  }

  getState() {
    return this._state;
  }

  subscribe(listener) {
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  // ── Public API ─────────────────────────────────────────────────────

  get enabled() { return this._enabled; }
  get autoHeal() { return this._autoHeal; }
  set autoHeal(val) { this._autoHeal = !!val; }

  /** Reset attempt counters (e.g., after user makes manual edits) */
  resetAttempts(filePath) {
    if (filePath) {
      this._fileState.delete(filePath);
    } else {
      this._fileState.clear();
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────

export function getRuntimeErrorInterceptor() {
  if (!_instance) {
    _instance = new RuntimeErrorInterceptor();
  }
  return _instance;
}

export { RuntimeErrorInterceptor };
