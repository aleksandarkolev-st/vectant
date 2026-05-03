import SynthiException from "@/components/SynthiException";

const SIGNAL_URL = process.env.NEXT_PUBLIC_COMPILE_SIGNAL_URL
    || (typeof window !== 'undefined' && window.location.hostname !== 'localhost'
        ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}/signal`
        : 'ws://localhost:9000');
const WORKER_SPAWNER_HEARTBEAT_MS = 60_000;
const USER_ID_STORAGE_KEY = 'synthi-user-id';

function shouldUseWorkspaceSpawner() {
    const override = process.env.NEXT_PUBLIC_ENABLE_WORKSPACE_SPAWNER;
    if (override != null) {
        const normalized = String(override).trim().toLowerCase();
        return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
    }

    try {
        const collabUrl = new URL(getCollabHttpBaseUrl());
        const signalHttpUrl = new URL(
            SIGNAL_URL
                .replace(/^ws:/, 'http:')
                .replace(/^wss:/, 'https:')
        );
        const localHosts = new Set(['localhost', '127.0.0.1']);
        return !(localHosts.has(collabUrl.hostname) && localHosts.has(signalHttpUrl.hostname));
    } catch (_) {
        return true;
    }
}

function getCollabHttpBaseUrl() {
    const envUrl = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL;
    if (envUrl) {
        return envUrl
            .replace(/^ws:/, 'http:')
            .replace(/^wss:/, 'https:')
            .replace(/\/$/, '');
    }

    if (typeof window !== 'undefined' && window.location.hostname !== 'localhost') {
        return `${window.location.origin}/collab`;
    }

    return 'http://localhost:1234';
}

const parseIceServers = (raw) => {
    if (!raw) return [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [{ urls: 'stun:stun.l.google.com:19302' }];
        return parsed;
    } catch (e) {
        console.warn('Failed to parse NEXT_PUBLIC_ICE_SERVERS, falling back to default STUN server', e);
        return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
};
/** Static fallback used when the TURN credential API is unreachable. */
const FALLBACK_ICE_SERVERS = parseIceServers(process.env.NEXT_PUBLIC_ICE_SERVERS);

/**
 * Fetch short-lived TURN credentials from /api/turn-credentials.
 * Falls back to the static NEXT_PUBLIC_ICE_SERVERS env if the API is not
 * configured or unreachable, so connectivity is never fully blocked.
 */
async function fetchIceServers() {
    try {
        const res = await fetch('/api/turn-credentials');
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data = await res.json();
        if (Array.isArray(data.iceServers) && data.iceServers.length > 0) {
            return data.iceServers;
        }
    } catch (e) {
        console.warn('[CompilerClient] TURN credential fetch failed, using fallback ICE:', e.message);
    }
    return FALLBACK_ICE_SERVERS;
}

export const CompilerStatus = {
    IDLE: 'idle',
    CONNECTING: 'connecting',
    CONNECTED: 'connected',
    DISCONNECTED: 'disconnected',
    ERROR: 'error'
};

export class CompilerClient {
    constructor(url = SIGNAL_URL) {
        this.url = url;
        this.useWorkspaceSpawner = shouldUseWorkspaceSpawner();
        this.ws = null;
        this.pc = null;
        this.pendingCompilationMap = new Map(); // session_id -> { resolve, reject }
        this.compileChannel = null;
        this.buildLogChannel = null;
        this.terminalChannel = null;
        this.emulatorInputChannel = null;
        this.lspChannel = null;
        this.fileSyncChannel = null;
        // Outstanding read-file requests keyed by requestId.
        // Resolved by the file-sync channel onmessage handler.
        this._fileReadPending = new Map();
        this._fileReadCounter = 0;
        // Listeners notified once when fileSyncChannel transitions to 'open'.
        this._fileSyncOpenListeners = new Set();
        this.readyPromise = null;
        this.currentStreams = [];
        this.logHandlers = new Set();
        this.statusListeners = new Set();
        this.textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
        this.terminalInputBuffer = [];
        this.guiInputBuffer = [];
        this.emulatorInputBuffer = [];
        this.status = CompilerStatus.IDLE;
        this.slug = null;
        this.supportsH265 = false;

        // Best-effort session scoping for client-side WebRTC diagnostics.
        // Signaling is currently unscoped, but build logs are session-scoped.
        this.activeSessionId = null;

        // Buffer WebRTC diagnostics that may occur before `activeSessionId` is known
        // (e.g., auto-connect on page load).
        this._pendingWebrtcLines = [];

        // Optional emitter used to mirror WebRTC diagnostics into the active build log output.
        // Set by `compile()` and cleared when the compile finishes.
        this._webrtcEmit = null;

        // Track target per session to support correct cancellation behavior.
        this._sessionTargets = new Map();
        
        // Track pending negotiation to avoid overlapping offer/answer cycles
        this._negotiationInProgress = false;
        this._pendingNegotiation = null;
        
        // Timer for retrying initial connection offer
        this._offerRetryInterval = null;

        // Grace period timer for transient 'disconnected' ICE state.
        // WebRTC can flicker to 'disconnected' and self-recover within
        // seconds — we only set DISCONNECTED after this grace period.
        this._disconnectGraceTimer = null;
        this._DISCONNECT_GRACE_MS = 5000;
        this._registeredSignalingSessionId = null;
        this._spawnerTouchTimer = null;

        
        this._handleTerminalInput = this._handleTerminalInput.bind(this);
        this._handleGuiInput = this._handleGuiInput.bind(this);
        this._handleEmulatorInput = this._handleEmulatorInput.bind(this);
    }

    setSlug(slug) {
        this.slug = slug;
    }

    /**
     * Set the signaling session identity. Called before connect() so the
     * register message includes a session_id for multiplexed routing.
     * @param {string} sessionId  e.g. "workspace-abc-user-123"
     */
    setSignalingSession(sessionId) {
        this._signalingSessionId = sessionId;
    }

    /** Build the session_id sent in the signaling "register" message. */
    _getSignalingSessionId() {
        if (this._signalingSessionId) return this._signalingSessionId;
        // Fallback: derive from slug (single-user session).
        if (this.slug) return this.slug;
        return undefined; // omit → server falls back to __legacy__
    }

    _getCompilerUserId() {
        if (typeof window === 'undefined' || !window.localStorage) return null;
        return window.localStorage.getItem(USER_ID_STORAGE_KEY) || null;
    }

    async _ensureWorkerPod(sessionId = this._getSignalingSessionId()) {
        if (!sessionId) return;

        const response = await fetch(`${getCollabHttpBaseUrl()}/api/spawner/ensure`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            credentials: 'omit',
            body: JSON.stringify({
                session_id: sessionId,
                user_id: this._getCompilerUserId() || sessionId,
            }),
        });

        if (response.ok) return;

        let detail = `HTTP ${response.status}`;
        try {
            const data = await response.json();
            detail = data?.error || detail;
        } catch (_) {
            // ignore JSON parse errors for non-JSON bodies
        }

        throw new Error(`Worker ensure failed: ${detail}`);
    }

    async _touchWorkerPod(sessionId = this._getSignalingSessionId()) {
        if (!sessionId) return;

        try {
            await fetch(`${getCollabHttpBaseUrl()}/api/spawner/touch`, {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                credentials: 'omit',
                keepalive: true,
                body: JSON.stringify({ session_id: sessionId }),
            });
        } catch (e) {
            console.warn('[CompilerClient] Worker heartbeat failed:', e.message);
        }
    }

    _clearSpawnerHeartbeat() {
        if (this._spawnerTouchTimer) {
            clearInterval(this._spawnerTouchTimer);
            this._spawnerTouchTimer = null;
        }
    }

    _startSpawnerHeartbeat(sessionId = this._getSignalingSessionId()) {
        this._clearSpawnerHeartbeat();
        if (!sessionId || typeof window === 'undefined') return;

        this._spawnerTouchTimer = window.setInterval(() => {
            this._touchWorkerPod(sessionId);
        }, WORKER_SPAWNER_HEARTBEAT_MS);
    }

    getMediaStream() {
        if (this.currentStreams && this.currentStreams.length > 0) {
            return this.currentStreams[0];
        }
        return null;
    }

    getActiveSessionId() {
        return this.activeSessionId;
    }

    _emitWebrtcDiag(line) {
        try {
            if (typeof this._webrtcEmit === 'function') {
                this._webrtcEmit(line);
                return;
            }
            this._pendingWebrtcLines.push({ t: Date.now(), line });
            // Bound memory usage.
            if (this._pendingWebrtcLines.length > 50) {
                this._pendingWebrtcLines.splice(0, this._pendingWebrtcLines.length - 50);
            }
        } catch (_) {
            // ignore
        }
    }

    _setStatus(newStatus) {
        if (this.status === newStatus) return;
        this.status = newStatus;
        this.statusListeners.forEach(cb => {
            try { cb(newStatus); } catch (e) { console.error(e); }
        });
    }

    onStatusChange(callback) {
        this.statusListeners.add(callback);
        return () => this.statusListeners.delete(callback);
    }

    _mapLanguage(filename = '') {
        const ext = filename.split('.').pop().toLowerCase();
        if (['c', 'cpp', 'cc', 'cxx', 'hpp', 'h'].includes(ext)) return 'cpp';
        if (ext === 'java') return 'java';
        if (ext === 'rs') return 'rust';
        if (ext === 'ts' || ext === 'tsx') return 'ts';
        if (ext === 'dart') return 'dart';
        // Note: js/jsx are intentionally not mapped here - they need special handling
        // for React Native vs browser environments
        return null;
    }

    // Detect if source code contains React Native imports
    _detectReactNativeInSource(source = '') {
        if (!source) return false;
        // Check for common React Native imports
        const rnPatterns = [
            /from\s+['"]react-native['"]/,
            /require\s*\(['"]react-native['"]\)/,
            /from\s+['"]@react-native/,
            /from\s+['"]expo/,
            /import.*from\s+['"]react-native-/
        ];
        return rnPatterns.some(pattern => pattern.test(source));
    }

    _notifyLog(msg) {
        // Normalize incoming payload to a string so handlers can parse it reliably.
        let text = msg;
        try {
            if (msg instanceof ArrayBuffer && this.textDecoder) {
                text = this.textDecoder.decode(new Uint8Array(msg));
            } else if (msg && typeof msg === 'object' && msg.data instanceof ArrayBuffer && this.textDecoder) {
                text = this.textDecoder.decode(new Uint8Array(msg.data));
            } else if (typeof msg !== 'string') {
                text = String(msg);
            }
        } catch (e) {
            text = String(msg);
        }

        // Device logcat can be extremely chatty; don't spam console/UI by default.
        try {
            const parsed = JSON.parse(text);
            if (parsed && parsed.type === 'logcat') {
                return;
            }
            // Suppress LSP stderr spam (clangd/ts-server emit many lines per
            // keystroke). Surface only on demand via SYNTHI_DEBUG_LSP=1.
            if (parsed && parsed.type === 'lsp-stderr') {
                if (typeof window !== 'undefined' && window.SYNTHI_DEBUG_LSP) {
                    console.log('[CompilerClient] lsp-stderr:', parsed.line);
                }
                return;
            }
        } catch (e) {
            // ignore
        }

        // Gate verbose received-log tracing behind a flag. Previously this
        // fired on EVERY log line (hundreds per minute) and drowned out
        // other console output.
        if (typeof window !== 'undefined' && window.SYNTHI_DEBUG_COMPILER) {
            if (typeof text === 'string' && text.length > 2000) {
                console.log('[CompilerClient] Received log (truncated):', `${text.slice(0, 2000)}…`);
            } else {
                console.log('[CompilerClient] Received log:', text);
            }
        }

        // Check for GUI control messages
        try {
            const parsed = JSON.parse(text);
            // Workspace reconciliation messages (generated file sync).
            if (parsed && typeof parsed.type === 'string' && parsed.type.startsWith('workspace-')) {
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:workspace-reconcile', { detail: parsed }));
                }
                // Do not forward these payloads to build log handlers (they can be large / base64).
                return;
            }
            const debugCompiler = typeof window !== 'undefined' && window.SYNTHI_DEBUG_COMPILER;
            if (parsed && parsed.type === 'run-gui-start') {
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:gui-start', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:gui-start', { detail: parsed }));
                }
                // The backend just called replace_track() — the real GStreamer
                // video is now flowing through the existing transceiver.  Re-emit
                // the media-track event so the <video> element in the GUI widget
                // gets a fresh srcObject assignment and calls play().  Without
                // this, the video can stay frozen on the placeholder (white).
                try {
                    if (this.currentStreams && this.currentStreams.length > 0) {
                        const stream = this.currentStreams[0];
                        const vt = stream?.getVideoTracks?.();
                        if (vt && vt.length > 0) {
                            // Create a fresh MediaStream so React detects the change
                            const freshStream = new MediaStream(stream.getTracks());
                            this.currentStreams = [freshStream];
                            window.dispatchEvent(new CustomEvent('synthi:media-track', {
                                detail: { track: vt[0], streams: [freshStream] }
                            }));
                            console.debug('[CompilerClient] Re-emitted media-track after gui-start');
                        }
                    }
                } catch (_) {}
            } else if (parsed && parsed.type === 'run-gui-end') {
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:gui-end', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:gui-end', { detail: parsed }));
                }
            } else if (parsed && parsed.type === 'compile-manifest') {
                // ULTRAPLAN Phase 8: bridge the Rust worker's manifest +
                // architecture cache into a CustomEvent that
                // useCompileManifestListener.js dispatches into the Redux
                // compileManifestSlice. Populates the StatusBar framework
                // pill, CompileErrorCard, and ConfidenceWarning components.
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:compile-manifest', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:compile-manifest', {
                        detail: {
                            manifest: parsed.manifest ?? null,
                            architecture: parsed.architecture ?? '',
                            rejection: parsed.rejection ?? null,
                        }
                    }));
                }
                // Don't log manifest payloads to the build log (they go
                // straight to the UI via Redux)
                return;
            } else if (parsed && parsed.type === 'compile-diagnostics') {
                // Structured compile diagnostics - dispatch to error overlay
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:compile-diagnostics', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:compile-diagnostics', { detail: parsed }));
                    // Also dispatch hmr-status for the indicator
                    if (parsed.error_count > 0) {
                        window.dispatchEvent(new CustomEvent('synthi:hmr-status', { 
                            detail: { 
                                status: 'compile-error', 
                                module: parsed.module,
                                diagnostics: parsed.diagnostics,
                                error_count: parsed.error_count,
                                warning_count: parsed.warning_count
                            } 
                        }));
                    }
                }
                // Don't log structured diagnostics to build log (they go to overlay)
                return;
            } else if (parsed && parsed.type === 'hmr-status') {
                // Native HMR status from Rust worker - dispatch to HMR system
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:hmr-status (native)', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:hmr-status', { detail: parsed.data || parsed }));
                }
                // Don't log HMR status to build log
                return;
            } else if (parsed && (parsed.type === 'update' || parsed.type === 'hash' || parsed.type === 'ok' || parsed.type === 'reload')) {
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:hmr-update', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:hmr-update', { detail: parsed }));
                }
                // Do not log HMR messages to the build log
                return;
            } else if (parsed && parsed.manifest && parsed.modules) {
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:hmr-update (Rust payload)', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    const hmrMsg = {
                        type: 'update',
                        data: {
                            hash: parsed.manifest.session_id,
                            modules: parsed.modules
                        }
                    };
                    window.dispatchEvent(new CustomEvent('synthi:hmr-update', { detail: hmrMsg }));
                }
                return;
            } else if (parsed && parsed.status && (parsed.status === 'applied' || parsed.status === 'rejected' || 
                       parsed.status === 'compile-error' || parsed.status === 'crash-recovered' ||
                       parsed.status === 'state-migrated' || parsed.status === 'crash-fatal')) {
                // Direct HMR status object from runner
                if (debugCompiler) console.log('[CompilerClient] Dispatching synthi:hmr-status (runner)', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:hmr-status', { detail: parsed }));
                }
                return;
            } else if (parsed && parsed.type === 'adapter_status') {
                // Adapter family status from HMR pipeline
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:adapter-status', { detail: parsed }));
                }
                return;
            } else if (parsed && parsed.type === 'adapter_health') {
                // Per-adapter health for the health panel
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:adapter-health', { detail: parsed }));
                }
                return;
            } else if (parsed && parsed.type === 'state_restore_status') {
                // State restore/migration progress
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:state-restore', { detail: parsed }));
                }
                return;
            } else if (parsed && parsed.type === 'ai_status') {
                // AI loop status (circuit breaker, cost, fallback)
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:ai-status', { detail: parsed }));
                }
                return;
            } else if (parsed && parsed.event && (
                parsed.event === 'Enqueued' ||
                parsed.event === 'Loading' ||
                parsed.event === 'HealthCheckStarted' ||
                parsed.event === 'HealthCheckCompleted' ||
                parsed.event === 'Promoted' ||
                parsed.event === 'RolledBack' ||
                parsed.event === 'Discarded' ||
                parsed.event === 'PromotionDecision'
            )) {
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:candidate-update', { detail: parsed }));
                }
                return;
            }
        } catch (e) {
            // ignore
        }

        // Dispatch structured program output event for the Output panel.
        // stdout/stderr lines are forwarded with their type so the panel can
        // distinguish program output from build system messages.
        try {
            const p = JSON.parse(text);
            if (p && (p.type === 'stdout' || p.type === 'stderr') && p.line != null) {
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:program-output', {
                        detail: { type: p.type, line: p.line, sessionId: p.sessionId }
                    }));
                }
            }
        } catch (_) { /* not JSON — ignore */ }

        this.logHandlers.forEach((fn) => {
            try { fn(text); } catch (e) { /* ignore */ }
        });
        try {
            // Also emit a global browser event so UI components (like TerminalPane)
            // can subscribe to real-time build output without importing this module.
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                const ev = new CustomEvent('synthi:build-log', { detail: msg });
                window.dispatchEvent(ev);
            }
        } catch (e) {
            // ignore
        }
    }

    _handleTerminalInput(ev) {
        try {
            const d = ev?.detail || {};
            const payload = JSON.stringify({ type: 'stdin', sessionId: d.sessionId, data: d.data });
            try { console.debug('[CompilerClient] terminalListener received', { payload, terminalReady: !!(this.terminalChannel && this.terminalChannel.readyState === 'open') }); } catch (_) {}
            if (this.terminalChannel && this.terminalChannel.readyState === 'open') {
                this.terminalChannel.send(payload);
                try { console.debug('[CompilerClient] sent payload over terminalChannel'); } catch (_) {}
            } else {
                // Buffer until channel opens
                this.terminalInputBuffer.push(payload);
                try { console.debug('[CompilerClient] buffered terminal input (channel not open)'); } catch (_) {}
            }
        } catch (e) { console.error('[CompilerClient] terminalListener error', e); }
    }

    _handleGuiInput(ev) {
        try {
            const d = ev?.detail || {};
            // Expect the detail to already be a serializable object for GUI events.
            const payload = JSON.stringify(d);
            try { console.debug('[CompilerClient] guiListener received', { payload, terminalReady: !!(this.terminalChannel && this.terminalChannel.readyState === 'open') }); } catch (_) {}
            if (this.terminalChannel && this.terminalChannel.readyState === 'open') {
                this.terminalChannel.send(payload);
                try { console.debug('[CompilerClient] sent gui payload over terminalChannel'); } catch (_) {}
            } else {
                // Buffer until channel opens
                this.guiInputBuffer.push(payload);
                try { console.debug('[CompilerClient] buffered gui input (channel not open)'); } catch (_) {}
            }
        } catch (e) { console.error('[CompilerClient] guiListener error', e); }
    }

    _handleEmulatorInput(ev) {
        try {
            const d = ev?.detail || {};
            const payload = JSON.stringify(d);
            
            // Debug log to confirm it hits the client
            console.debug('[CompilerClient] Sending emulator input:', payload);

            if (this.emulatorInputChannel && this.emulatorInputChannel.readyState === 'open') {
                this.emulatorInputChannel.send(payload);
            } else {
                console.warn('[CompilerClient] emulator-input channel not open, buffering. State:', this.emulatorInputChannel?.readyState);
                this.emulatorInputBuffer.push(payload);
            }
        } catch (e) {
            console.error('[CompilerClient] emulatorInputListener error', e);
        }
    }

    connect() {
        if (this.readyPromise) return this.readyPromise;
        
        this._setStatus(CompilerStatus.CONNECTING);
        
        this.readyPromise = new Promise(async (resolve, reject) => {
            // Fetch fresh TURN credentials before every PeerConnection so
            // relay candidates are always valid (handles credential TTL).
            const iceServers = await fetchIceServers();
            this.pc = new RTCPeerConnection({ iceServers });

            // Log supported codecs for debugging
            try {
                if (RTCRtpReceiver.getCapabilities) {
                    const capabilities = RTCRtpReceiver.getCapabilities('video');
                    if (capabilities && capabilities.codecs) {
                        console.log('Browser supported video codecs:', capabilities.codecs.map(c => c.mimeType));
                        const hasH265 = capabilities.codecs.some(c => c.mimeType.toLowerCase() === 'video/h265');
                        console.log('H.265 supported by browser:', hasH265);
                        this.supportsH265 = hasH265;
                    }
                }
            } catch (e) {
                console.warn('Failed to check codec capabilities', e);
            }

            this.pc.onicecandidate = (event) => {
                if (event.candidate && this.ws && this.ws.readyState === WebSocket.OPEN) {
                    this.ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
                }
            };

            this.pc.oniceconnectionstatechange = () => {
                try { console.debug('CompilerClient ICE connection state:', this.pc.iceConnectionState); } catch (e) {}
            };

            this.pc.onicegatheringstatechange = () => {
                try { console.debug('CompilerClient ICE gathering state:', this.pc.iceGatheringState); } catch (e) {}
            };
            this.pc.onconnectionstatechange = () => {
                try { console.debug('CompilerClient connection state:', this.pc.connectionState); } catch (e) {}
                if (this.pc.connectionState === 'connected') {
                    // Connection recovered — cancel any pending grace timer
                    if (this._disconnectGraceTimer) {
                        clearTimeout(this._disconnectGraceTimer);
                        this._disconnectGraceTimer = null;
                        console.log('[CompilerClient] Connection recovered from transient disconnect');
                    }
                    // Stop resending the SDP offer now that the PC is connected.
                    // Without this, the retry fires before the answer arrives,
                    // and webrtc-rs re-processes the duplicate offer, firing
                    // on_data_channel again for the vscode-server DC (kills the
                    // working VS Code Server process).
                    if (this._offerRetryInterval) {
                        clearInterval(this._offerRetryInterval);
                        this._offerRetryInterval = null;
                    }
                    this._setStatus(CompilerStatus.CONNECTED);

                    // Notify the extension system that WebRTC is ready
                    try {
                        window.dispatchEvent(new CustomEvent('synthi:webrtc-connected'));
                    } catch (_) {}
                } else if (this.pc.connectionState === 'failed') {
                    // 'failed' is permanent — set DISCONNECTED immediately
                    if (this._disconnectGraceTimer) {
                        clearTimeout(this._disconnectGraceTimer);
                        this._disconnectGraceTimer = null;
                    }
                    this._setStatus(CompilerStatus.DISCONNECTED);
                } else if (this.pc.connectionState === 'disconnected') {
                    // 'disconnected' is transient — start a grace period.
                    // ICE can self-recover within seconds. Only set
                    // DISCONNECTED if it doesn't recover in time.
                    if (!this._disconnectGraceTimer) {
                        console.log(`[CompilerClient] Transient disconnect detected, grace period ${this._DISCONNECT_GRACE_MS}ms...`);
                        this._disconnectGraceTimer = setTimeout(() => {
                            this._disconnectGraceTimer = null;
                            // Re-check state — it may have recovered during the timer
                            if (this.pc && this.pc.connectionState !== 'connected') {
                                console.warn('[CompilerClient] Grace period expired, connection did not recover');
                                this._setStatus(CompilerStatus.DISCONNECTED);
                            }
                        }, this._DISCONNECT_GRACE_MS);
                    }
                }
            };

            this.pc.ontrack = (event) => {
                console.log('Received remote track', event.track.kind, {
                    id: event.track?.id,
                    readyState: event.track?.readyState,
                    muted: event.track?.muted,
                    streams: event.streams?.length ?? 0,
                });

                // Track mute/unmute transitions are a strong signal of whether frames are flowing.
                try {
                    const kind = event.track?.kind;
                    const id = event.track?.id;
                    event.track.onunmute = () => {
                        try {
                            this._emitWebrtcDiag(`[webrtc] track onunmute: kind=${kind} id=${id}`);
                            
                            // When video track unmutes (new data flowing), create a fresh MediaStream
                            // and re-emit the media-track event. This ensures the frontend gets updated
                            // when backend replaces the track source (same track object, new media).
                            if (kind === 'video' && typeof window !== 'undefined' && window.dispatchEvent) {
                                // Create a fresh MediaStream to ensure React detects the change
                                const freshStream = new MediaStream([event.track]);
                                this.currentStreams = [freshStream];
                                console.debug('[CompilerClient] video track unmuted, emitting fresh MediaStream');
                                const ev = new CustomEvent('synthi:media-track', { detail: { track: event.track, streams: [freshStream] } });
                                window.dispatchEvent(ev);
                            }
                        } catch (_) {}
                    };
                    event.track.onmute = () => {
                        try {
                            this._emitWebrtcDiag(`[webrtc] track onmute: kind=${kind} id=${id}`);
                        } catch (_) {}
                    };
                } catch (_) {
                    // ignore
                }

                // Emit to build log stream so we can debug without DevTools.
                try {
                    const line = `[webrtc] ontrack: kind=${event.track?.kind} id=${event.track?.id} readyState=${event.track?.readyState} muted=${event.track?.muted} streams=${event.streams?.length ?? 0}`;
                    this._emitWebrtcDiag(line);
                } catch (_) {
                    // ignore
                }
                // Some browsers/transceivers deliver tracks with an empty `event.streams`.
                // In that case, synthesize a MediaStream so UI can attach it to <video>.
                let streams = (event.streams && event.streams.length > 0) ? event.streams : null;
                if (!streams) {
                    try { console.debug('[CompilerClient] ontrack without streams; synthesizing MediaStream'); } catch (_) {}
                    try {
                        if (!this._synthStream) this._synthStream = new MediaStream();
                        // Replace existing track of same kind to avoid piling up tracks across renegotiations.
                        const existing = this._synthStream.getTracks().filter(t => t.kind === event.track.kind);
                        existing.forEach(t => { try { this._synthStream.removeTrack(t); } catch (_) {} });
                        this._synthStream.addTrack(event.track);
                        streams = [this._synthStream];
                    } catch (_) {
                        // ignore
                    }
                }

                if (streams && streams.length > 0) {
                    this.currentStreams = streams;
                }

                // Keep references to most recent tracks for stats/debug.
                try {
                    if (event.track?.kind === 'video') this._remoteVideoTrack = event.track;
                    if (event.track?.kind === 'audio') this._remoteAudioTrack = event.track;
                } catch (_) {
                    // ignore
                }

                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    const ev = new CustomEvent('synthi:media-track', { detail: { track: event.track, streams: streams || [] } });
                    window.dispatchEvent(ev);
                }
            };

            this.pc.ondatachannel = (event) => {
                const ch = event.channel;
                if (ch.label === 'build-log') {
                    this.buildLogChannel = ch;
                    ch.onmessage = (ev) => this._notifyLog(ev.data);
                }
            };

            const signalingSessionId = this._getSignalingSessionId();
            if (signalingSessionId && this.useWorkspaceSpawner) {
                try {
                    await this._ensureWorkerPod(signalingSessionId);
                } catch (e) {
                    this.readyPromise = null;
                    this._setStatus(CompilerStatus.ERROR);
                    reject(e);
                    return;
                }
            }

            console.log('CompilerClient connecting to', this.url);
            const ws = new WebSocket(this.url);
            this.ws = ws;

            ws.onerror = (err) => {
                console.error('CompilerClient ws error', err);
                this._clearSpawnerHeartbeat();
                this._registeredSignalingSessionId = null;
                this.readyPromise = null;
                this._setStatus(CompilerStatus.ERROR);
                reject(err);
            };

            ws.onclose = () => {
                console.warn('CompilerClient ws closed');
                // Only clean up if this is still the active socket
                if (this.ws === ws) {
                    this.ws = null;

                    // If the WebRTC PeerConnection is still connected, DON'T
                    // tear everything down.  The signaling WS is only needed
                    // for SDP exchange and ICE candidates — once the PC is
                    // connected, DataChannels (LSP, vscode-server, terminal, …)
                    // work independently.  Tearing down a healthy PC would
                    // kill the LSP, vscode-server, etc. for no reason and trigger
                    // an unnecessary reconnect cycle.
                    if (this.pc && (this.pc.connectionState === 'connected' || this.pc.connectionState === 'connecting')) {
                        console.log('[CompilerClient] Signaling WS closed but WebRTC PC still alive (' + this.pc.connectionState + '), keeping channels');
                        return;
                    }

                    // PC is not connected — full teardown
                    this._clearSpawnerHeartbeat();
                    this._registeredSignalingSessionId = null;
                    this.readyPromise = null;
                    this.compileChannel = null;
                    this.buildLogChannel = null;
                    this.pc = null;
                    this.emulatorInputChannel = null;
                    this._setStatus(CompilerStatus.DISCONNECTED);
                }
            };

            ws.onmessage = async (event) => {
                // Ignore messages from a stale socket
                if (this.ws !== ws) return;
                let msg;
                try { msg = JSON.parse(event.data); } catch (_) { return; }
                if (msg.type === 'answer' && msg.sdp) {
                    // Only apply the answer if we're waiting for one (have-local-offer).
                    // Stale / duplicate answers (e.g. from the offer-retry loop) can arrive
                    // after the PC is already stable — silently ignore them.
                    const signalingState = this.pc?.signalingState;
                    if (signalingState === 'have-local-offer') {
                        try {
                            await this.pc.setRemoteDescription(new RTCSessionDescription({ type: msg.sdp_type || 'answer', sdp: msg.sdp }));
                            this._emitWebrtcDiag(`[webrtc] answer applied, new state=${this.pc?.signalingState}`);
                        } catch (e) {
                            console.warn('[CompilerClient] setRemoteDescription failed (race condition), ignoring:', e.message);
                            this._emitWebrtcDiag(`[webrtc] setRemoteDescription failed: ${e.message}`);
                        }
                        // Stop retrying offers now that we have an answer
                        if (this._offerRetryInterval) {
                            clearInterval(this._offerRetryInterval);
                            this._offerRetryInterval = null;
                        }
                        // Mark negotiation as complete
                        this._negotiationInProgress = false;
                        // Process any pending negotiation (e.g. LSP channel creation queued during connect)
                        if (this._pendingNegotiation) {
                            const pending = this._pendingNegotiation;
                            this._pendingNegotiation = null;
                            this._renegotiate(pending.reason, pending.sessionId, pending.onLog);
                        }
                    } else {
                        // Throttle this warning — stale answers are harmless but can flood the console
                        if (!this._lastStaleAnswerWarn || Date.now() - this._lastStaleAnswerWarn > 5000) {
                            console.warn(`[CompilerClient] Ignoring answer in signalingState=${signalingState} (expected have-local-offer)`);
                            this._lastStaleAnswerWarn = Date.now();
                            this._staleAnswerCount = 1;
                        } else {
                            this._staleAnswerCount = (this._staleAnswerCount || 0) + 1;
                        }
                        this._emitWebrtcDiag(`[webrtc] ignored answer signalingState=${signalingState}`);
                    }
                } else if (msg.type === 'offer' && msg.sdp) {
                    // Worker-initiated renegotiation (e.g. new tracks added after initial connection)
                    console.log('[CompilerClient] Received renegotiation offer from worker');
                    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp: msg.sdp }));
                    const answer = await this.pc.createAnswer();
                    await this.pc.setLocalDescription(answer);
                    if (ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: 'offer', sdp: answer.sdp, sdp_type: answer.type }));
                    }
                    // Emit negotiated codecs to build log stream.
                    try {
                        const sdp = String(msg.sdp || '');
                        const hasVp8 = /a=rtpmap:\\d+\\s+VP8\\//i.test(sdp);
                        const hasH264 = /a=rtpmap:\\d+\\s+H264\\//i.test(sdp);
                        const hasVp9 = /a=rtpmap:\\d+\\s+VP9\\//i.test(sdp);
                        const hasAv1 = /a=rtpmap:\\d+\\s+AV1\\//i.test(sdp);
                        const line = `[webrtc] renegotiation: hasVp8=${hasVp8} hasH264=${hasH264} hasVp9=${hasVp9} hasAv1=${hasAv1} sdpLen=${sdp.length}`;
                        this._emitWebrtcDiag(line);
                    } catch (_) {
                        // ignore
                    }
                } else if (msg.type === 'candidate' && msg.candidate) {
                    try { await this.pc.addIceCandidate(msg.candidate); } catch (_) {}
                }
            };

            ws.onopen = async () => {
                // Guard: if connect() was called again, this socket is stale
                if (this.ws !== ws) {
                    console.warn('[CompilerClient] onopen fired on stale socket, ignoring');
                    try { ws.close(); } catch (_) {}
                    return;
                }
                if (ws.readyState !== WebSocket.OPEN) {
                    console.warn('[CompilerClient] onopen but readyState is not OPEN:', ws.readyState);
                    return;
                }
                ws.send(JSON.stringify({
                    type: 'register',
                    role: 'browser',
                    session_id: signalingSessionId,
                }));
                this._registeredSignalingSessionId = signalingSessionId || null;
                if (this.useWorkspaceSpawner) {
                    void this._touchWorkerPod(signalingSessionId);
                    this._startSpawnerHeartbeat(signalingSessionId);
                }
                this.compileChannel = this.pc.createDataChannel('compile', { ordered: true });
                // Terminal channel for stdin forwarding
                this.terminalChannel = this.pc.createDataChannel('terminal', { ordered: true });
                // Emulator input backchannel (Android)
                this.emulatorInputChannel = this.pc.createDataChannel('emulator-input', { ordered: true });
                // File-sync channel: pushes file create/edit/delete/rename to worker disk.
                // Also handles `read` requests for absolute paths so the frontend can
                // resolve LSP go-to-definition results pointing at system headers.
                this.fileSyncChannel = this.pc.createDataChannel('file-sync', { ordered: true });
                this.fileSyncChannel.onopen = () => {
                    const listeners = Array.from(this._fileSyncOpenListeners);
                    this._fileSyncOpenListeners.clear();
                    for (const cb of listeners) {
                        try { cb(); } catch (e) { console.warn('[CompilerClient] fileSync open listener threw', e); }
                    }
                };
                this.fileSyncChannel.onmessage = (evt) => {
                    let msg;
                    try {
                        msg = typeof evt.data === 'string' ? JSON.parse(evt.data) : null;
                    } catch (_) { return; }
                    if (!msg || msg.op !== 'read-result') return;
                    const reqId = msg.requestId;
                    if (!reqId) return;
                    const pending = this._fileReadPending.get(reqId);
                    if (!pending) return;
                    this._fileReadPending.delete(reqId);
                    clearTimeout(pending.timeoutId);
                    if (msg.error) pending.resolve({ ok: false, error: msg.error, path: msg.path });
                    else pending.resolve({ ok: true, content: msg.content, path: msg.path });
                };

                // VS Code Server Manager channel — pre-created in SDP
                // to avoid unreliable DCEP in-band negotiation.
                this.vscodeServerChannel = this.pc.createDataChannel(`vscode-server?slug=${this.slug || ''}`, { ordered: true });
                this.vscodeServerChannel.binaryType = 'arraybuffer';
                this.vscodeServerChannel._earlyMessages = [];
                this.vscodeServerChannel.onmessage = (evt) => {
                    if (this.vscodeServerChannel._earlyMessages) {
                        this.vscodeServerChannel._earlyMessages.push(evt.data);
                    }
                };
                
                this.compileChannel.onclose = () => {};

                // Important: modern browsers (notably Chrome) may ignore offerToReceiveVideo/Audio
                // unless there is an explicit transceiver. Without an m=video section, the worker
                // cannot send the emulator stream and ontrack will never fire.
                try {
                    const transceivers = (typeof this.pc.getTransceivers === 'function') ? this.pc.getTransceivers() : [];
                    const hasVideo = transceivers.some(t => t?.receiver?.track?.kind === 'video');
                    const hasAudio = transceivers.some(t => t?.receiver?.track?.kind === 'audio');
                    if (!hasVideo && typeof this.pc.addTransceiver === 'function') {
                        this.pc.addTransceiver('video', { direction: 'recvonly' });
                    }
                    if (!hasAudio && typeof this.pc.addTransceiver === 'function') {
                        this.pc.addTransceiver('audio', { direction: 'recvonly' });
                    }
                } catch (e) {
                    console.warn('[CompilerClient] Failed to ensure recvonly transceivers', e);
                }

                // Mark initial negotiation as in progress
                this._negotiationInProgress = true;
                
                const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
                await this.pc.setLocalDescription(offer);
                try {
                    const sdp = String(offer?.sdp || '');
                    console.debug('[CompilerClient] Created initial offer', {
                        hasMVideo: /\nm=video\s/i.test(sdp),
                        hasMAudio: /\nm=audio\s/i.test(sdp),
                        sdpLen: sdp.length,
                        signalingState: this.pc?.signalingState,
                    });
                } catch (_) {}
                
                const offerPayload = JSON.stringify({ type: 'offer', sdp: offer.sdp, sdp_type: offer.type });
                ws.send(offerPayload);

                // Retry sending the offer periodically until we receive an Answer.
                // This prevents the connection from hanging if the Worker process is restarting 
                // and hasn't connected to the Signaling Server yet when we send the first offer.
                if (this._offerRetryInterval) clearInterval(this._offerRetryInterval);
                this._offerRetryInterval = setInterval(() => {
                    const isWaiting = this.pc && this.pc.signalingState === 'have-local-offer';
                    const isOpen = ws === this.ws && ws.readyState === WebSocket.OPEN;
                    
                    if (isWaiting && isOpen) {
                        console.log('[CompilerClient] Retrying offer transmission (worker might not be ready)...');
                        ws.send(offerPayload);
                    } else {
                        if (this._offerRetryInterval) {
                            clearInterval(this._offerRetryInterval);
                            this._offerRetryInterval = null;
                        }
                    }
                }, 2000);

                this.compileChannel.onopen = () => resolve(true);
                
                if (this.terminalChannel) {
                    this.terminalChannel.onopen = () => {
                        if (typeof window !== 'undefined' && window.addEventListener) {
                            window.addEventListener('synthi:terminal-input', this._handleTerminalInput);
                            window.addEventListener('synthi:gui-input', this._handleGuiInput);
                        }
                        // flush buffer
                        while (this.terminalInputBuffer.length > 0) {
                            const p = this.terminalInputBuffer.shift();
                            try { this.terminalChannel.send(p); } catch (_) { /* ignore */ }
                        }
                        // flush gui buffer
                        while (this.guiInputBuffer.length > 0) {
                            const p = this.guiInputBuffer.shift();
                            try { this.terminalChannel.send(p); } catch (_) { /* ignore */ }
                        }
                    };
                    // If the channel is already open, attach immediately
                    if (this.terminalChannel.readyState === 'open') {
                        if (typeof window !== 'undefined' && window.addEventListener) {
                            window.addEventListener('synthi:terminal-input', this._handleTerminalInput);
                            window.addEventListener('synthi:gui-input', this._handleGuiInput);
                        }
                    }
                    this.terminalChannel.onclose = () => {
                        try { 
                            window.removeEventListener('synthi:terminal-input', this._handleTerminalInput); 
                            window.removeEventListener('synthi:gui-input', this._handleGuiInput);
                        } catch (_) {}
                    };
                }

                if (this.emulatorInputChannel) {
                    this.emulatorInputChannel.onopen = () => {
                        try {
                            window.addEventListener('synthi:emulator-input', this._handleEmulatorInput);
                        } catch (_) {}
                        while (this.emulatorInputBuffer.length > 0) {
                            const p = this.emulatorInputBuffer.shift();
                            try { this.emulatorInputChannel.send(p); } catch (_) {}
                        }
                    };
                    this.emulatorInputChannel.onclose = () => {
                        try { window.removeEventListener('synthi:emulator-input', this._handleEmulatorInput); } catch (_) {}
                    };
                }
                // Remove listener when the WebSocket closes as a backup
                this.ws.addEventListener('close', () => {
                    try { 
                        window.removeEventListener('synthi:terminal-input', this._handleTerminalInput); 
                        window.removeEventListener('synthi:gui-input', this._handleGuiInput);
                        window.removeEventListener('synthi:emulator-input', this._handleEmulatorInput);
                    } catch (_) {}
                });
            };
        });
        return this.readyPromise;
    }

    _emitBuildStream(sessionId, line) {
        try {
            if (!sessionId) return;
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('synthi:build-stream', { detail: { sessionId, line } }));
            }
        } catch (_) {
            // ignore
        }
    }

    async _renegotiate(reason = '', sessionId = null, onLog = null) {
        try {
            if (!this.pc || !this.ws || this.ws.readyState !== WebSocket.OPEN) return;
            
            // If a negotiation is already in progress, queue this one
            if (this._negotiationInProgress) {
                console.debug('[CompilerClient] Negotiation in progress, queuing renegotiation for:', reason);
                this._pendingNegotiation = { reason, sessionId, onLog };
                return;
            }
            this._negotiationInProgress = true;
            
            const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
            await this.pc.setLocalDescription(offer);
            let hasMVideo = false;
            let hasMAudio = false;
            try {
                const sdp = String(offer?.sdp || '');
                hasMVideo = /\nm=video\s/i.test(sdp);
                hasMAudio = /\nm=audio\s/i.test(sdp);
                console.debug('[CompilerClient] Renegotiation offer', {
                    reason,
                    hasMVideo,
                    hasMAudio,
                    sdpLen: sdp.length,
                    signalingState: this.pc?.signalingState,
                });
            } catch (_) {}

            const line = `[webrtc] renegotiate reason=${reason} hasMVideo=${hasMVideo} hasMAudio=${hasMAudio} state=${this.pc?.signalingState}`;
            try { if (typeof onLog === 'function') onLog(line); } catch (_) {}
            this._emitBuildStream(sessionId, line);

            this.ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, sdp_type: offer.type }));
        } catch (e) {
            this._negotiationInProgress = false;
            console.warn('[CompilerClient] Renegotiation failed', e);
            const line = `[webrtc] renegotiate failed reason=${reason} err=${e?.message || String(e)}`;
            try { if (typeof onLog === 'function') onLog(line); } catch (_) {}
            this._emitBuildStream(sessionId, line);
        }
    }

    async _ensureRecvTransceivers({ video = false, audio = false, sessionId = null, onLog = null, forceRenegotiate = false } = {}) {
        if (!this.pc || typeof this.pc.addTransceiver !== 'function') return;
        let changed = false;
        let hasVideo = false;
        let hasAudio = false;
        try {
            const transceivers = (typeof this.pc.getTransceivers === 'function') ? this.pc.getTransceivers() : [];
            const hasKind = (kind) => transceivers.some(t => t?.receiver?.track?.kind === kind);
            hasVideo = hasKind('video');
            hasAudio = hasKind('audio');
            if (video && !hasKind('video')) {
                this.pc.addTransceiver('video', { direction: 'recvonly' });
                changed = true;
                hasVideo = true;
            }
            if (audio && !hasKind('audio')) {
                this.pc.addTransceiver('audio', { direction: 'recvonly' });
                changed = true;
                hasAudio = true;
            }
        } catch (e) {
            console.warn('[CompilerClient] Failed to ensure recvonly transceivers', e);
        }
        const line = `[webrtc] transceivers: hasVideo=${hasVideo} hasAudio=${hasAudio} requestedVideo=${video} requestedAudio=${audio} changed=${changed} forceRenegotiate=${forceRenegotiate}`;
        try { if (typeof onLog === 'function') onLog(line); } catch (_) {}
        this._emitBuildStream(sessionId, line);

        if (changed || forceRenegotiate) {
            await this._renegotiate(changed ? 'ensureRecvTransceivers' : 'forceRenegotiate', sessionId, onLog);
        }
    }

    createLspChannel(language) {
        if (!this.pc || this.pc.connectionState !== 'connected') {
            throw new Error('CompilerClient not connected');
        }
        const label = `lsp-${language}?slug=${this.slug || ''}`;
        const channel = this.pc.createDataChannel(label, { ordered: true });
        channel.binaryType = 'arraybuffer';

        // No SDP renegotiation needed — SCTP is already established from the
        // initial offer/answer (which created compile/terminal/emulator-input
        // data channels).  New data channels open automatically via in-band
        // SCTP negotiation (DATA_CHANNEL_OPEN message).  Calling _renegotiate
        // here would send a redundant offer that can actually disrupt the
        // SCTP transport and prevent the channel from opening.

        return channel;
    }

    /**
     * Create a DataChannel for the VS Code Server Manager.
     * The Rust worker will spawn `node vscode-server-manager.js` and pipe
     * newline-delimited JSON over the channel.
     *
     * @returns {RTCDataChannel}
     */
    createVSCodeServerChannel() {
        // Return the channel that was pre-created during connect() (part of SDP).
        if (this.vscodeServerChannel && this.vscodeServerChannel.readyState !== 'closed') {
            return this.vscodeServerChannel;
        }
        // Fallback: create on-demand
        if (!this.pc || this.pc.connectionState !== 'connected') {
            throw new Error('CompilerClient not connected');
        }
        const label = `vscode-server?slug=${this.slug || ''}`;
        this.vscodeServerChannel = this.pc.createDataChannel(label, { ordered: true });
        this.vscodeServerChannel.binaryType = 'arraybuffer';
        return this.vscodeServerChannel;
    }

    // ── File-sync helpers ──────────────────────────────────────────
    // These methods push file mutations from the browser to the worker's disk
    // so the LSP server sees newly created/edited/renamed/deleted files.

    /**
     * Write (create or update) a file on the worker's disk.
     * @param {string} relPath  Workspace-relative path, e.g. "src/utils.py"
     * @param {string} content  Full file content
     */
    syncFile(relPath, content) {
        if (!this.fileSyncChannel || this.fileSyncChannel.readyState !== 'open') return;
        try {
            this.fileSyncChannel.send(JSON.stringify({
                op: 'write',
                path: relPath,
                content,
                slug: this.slug || '',
            }));
        } catch (e) {
            console.warn('[CompilerClient] file-sync write failed:', e.message);
        }
    }

    /**
     * Send an edit delta to the worker for background classification.
     * The worker diffs old vs new content and caches the classification
     * so the compile handler can dispatch instantly on save.
     * @param {string} relPath  Workspace-relative path
     * @param {string} content  Full new file content
     */
    sendEditDelta(relPath, content) {
        if (!this.fileSyncChannel || this.fileSyncChannel.readyState !== 'open') return;
        try {
            this.fileSyncChannel.send(JSON.stringify({
                op: 'edit_delta',
                path: relPath,
                content,
                slug: this.slug || '',
            }));
        } catch (e) {
            // Best-effort — classification is an optimization, not critical
        }
    }

    /**
     * Delete a file or directory on the worker's disk.
     * @param {string} relPath  Workspace-relative path
     */
    deleteFile(relPath) {
        if (!this.fileSyncChannel || this.fileSyncChannel.readyState !== 'open') return;
        try {
            this.fileSyncChannel.send(JSON.stringify({
                op: 'delete',
                path: relPath,
                slug: this.slug || '',
            }));
        } catch (e) {
            console.warn('[CompilerClient] file-sync delete failed:', e.message);
        }
    }

    /**
     * Rename/move a file on the worker's disk.
     * @param {string} fromPath  Original workspace-relative path
     * @param {string} toPath    New workspace-relative path
     */
    renameFile(fromPath, toPath) {
        if (!this.fileSyncChannel || this.fileSyncChannel.readyState !== 'open') return;
        try {
            this.fileSyncChannel.send(JSON.stringify({
                op: 'rename',
                from: fromPath,
                to: toPath,
                slug: this.slug || '',
            }));
        } catch (e) {
            console.warn('[CompilerClient] file-sync rename failed:', e.message);
        }
    }

    /**
     * Create a directory on the worker's disk.
     * @param {string} relPath  Workspace-relative directory path
     */
    mkdirSync(relPath) {
        if (!this.fileSyncChannel || this.fileSyncChannel.readyState !== 'open') return;
        try {
            this.fileSyncChannel.send(JSON.stringify({
                op: 'mkdir',
                path: relPath,
                slug: this.slug || '',
            }));
        } catch (e) {
            console.warn('[CompilerClient] file-sync mkdir failed:', e.message);
        }
    }

    /**
     * Push every entry in `entries` to the worker's disk in a single batch.
     * Used at file-sync channel open time to give the language server a
     * complete view of the workspace before any cross-file feature is
     * exercised.
     * @param {Iterable<[string, string]>} entries
     */
    syncAllFiles(entries) {
        if (!this.fileSyncChannel || this.fileSyncChannel.readyState !== 'open') return 0;
        let count = 0;
        for (const [path, content] of entries) {
            if (!path || typeof content !== 'string') continue;
            this.syncFile(path, content);
            count += 1;
        }
        if (count > 0) {
            console.log(`[CompilerClient] file-sync: pushed ${count} files at startup`);
        }
        return count;
    }

    /**
     * Register a callback that fires once when the file-sync channel becomes
     * available. Already-open channels invoke the callback synchronously
     * (deferred via microtask so callers don't accidentally re-enter).
     * @param {() => void} cb
     */
    onFileSyncOpen(cb) {
        if (typeof cb !== 'function') return () => {};
        if (this.fileSyncChannel?.readyState === 'open') {
            queueMicrotask(() => { try { cb(); } catch (_) { /* ignored */ } });
            return () => {};
        }
        this._fileSyncOpenListeners.add(cb);
        return () => this._fileSyncOpenListeners.delete(cb);
    }

    /**
     * Read an absolute path on the worker (system headers, stdlib source,
     * etc.). Resolves with `{ ok, content, error, path }`. The worker
     * enforces a read-only allowlist; out-of-allowlist paths reject with
     * `error: 'path not allowed'`.
     *
     * @param {string} absPath  Absolute path on the worker (e.g. /usr/include/c++/11/iostream)
     * @param {{ timeoutMs?: number }} [opts]
     * @returns {Promise<{ ok: boolean, content?: string, error?: string, path?: string }>}
     */
    readRemoteFile(absPath, opts = {}) {
        const timeoutMs = opts.timeoutMs ?? 5000;
        if (!this.fileSyncChannel || this.fileSyncChannel.readyState !== 'open') {
            return Promise.resolve({ ok: false, error: 'file-sync channel not open' });
        }
        const reqId = `r${++this._fileReadCounter}-${Date.now()}`;
        return new Promise((resolve) => {
            const timeoutId = setTimeout(() => {
                this._fileReadPending.delete(reqId);
                resolve({ ok: false, error: 'timeout', path: absPath });
            }, timeoutMs);
            this._fileReadPending.set(reqId, { resolve, timeoutId });
            try {
                this.fileSyncChannel.send(JSON.stringify({
                    op: 'read',
                    path: absPath,
                    requestId: reqId,
                }));
            } catch (e) {
                clearTimeout(timeoutId);
                this._fileReadPending.delete(reqId);
                resolve({ ok: false, error: e?.message || 'send failed', path: absPath });
            }
        });
    }

    /**
     * Lightweight reconnect: tears down the local PeerConnection and
     * signaling WebSocket, then re-establishes a new connection,
     * WITHOUT sending a "reset" to the worker.  This preserves the
     * worker's vscode-server-manager processes so LSP/
     * extensions survive transient network blips.
     *
     * Use `reconnect()` (hard reset) only when the emulator/build
     * state needs to be cleared on the worker side.
     */
    async softReconnect() {
        console.log('[CompilerClient] Soft reconnect (no worker reset)...');

        if (this._disconnectGraceTimer) {
            clearTimeout(this._disconnectGraceTimer);
            this._disconnectGraceTimer = null;
        }

        if (this._offerRetryInterval) {
            clearInterval(this._offerRetryInterval);
            this._offerRetryInterval = null;
        }

        this._clearSpawnerHeartbeat();
        this._registeredSignalingSessionId = null;

        // Null out this.ws BEFORE closing so the onclose handler sees a stale
        // socket and skips its cleanup path (status broadcast + readyPromise
        // teardown). Without this, onclose fires DISCONNECTED while we are in
        // the middle of reconnecting, which races with the auto-reconnect timer
        // in useCompiler and can produce a second overlapping connect() call.
        const wsToClose = this.ws;
        const pcToClose = this.pc;
        this.ws = null;
        this.pc = null;
        if (wsToClose) { try { wsToClose.close(); } catch (_) {} }
        if (pcToClose) { try { pcToClose.close(); } catch (_) {} }

        await new Promise(r => setTimeout(r, 500));

        this.compileChannel = null;
        this.buildLogChannel = null;
        this.terminalChannel = null;
        this.emulatorInputChannel = null;
        this.lspChannel = null;
        this.fileSyncChannel = null;
        this._abortPendingFileReads('disconnect');
        this._fileSyncOpenListeners.clear();
        this.readyPromise = null;
        this._setStatus(CompilerStatus.IDLE);
        this.currentStreams = [];

        return this.connect();
    }

    /**
     * Reject any in-flight readRemoteFile promises with the given reason.
     * Safe to call multiple times.
     * @param {string} reason
     */
    _abortPendingFileReads(reason) {
        for (const [, pending] of this._fileReadPending) {
            try { clearTimeout(pending.timeoutId); } catch (_) { /* ignored */ }
            try { pending.resolve({ ok: false, error: reason }); } catch (_) { /* ignored */ }
        }
        this._fileReadPending.clear();
    }

    async reconnect() {
        console.log('[CompilerClient] Forcing reconnection to clear WebRTC state...');

        // Cancel any pending disconnect grace timer
        if (this._disconnectGraceTimer) {
            clearTimeout(this._disconnectGraceTimer);
            this._disconnectGraceTimer = null;
        }
        
        // Try to signal the worker to reset/exit before we close the socket.
        // This ensures the worker restarts and gives us a fresh PeerConnection,
        // avoiding GStreamer timestamp issues and renegotiation stalls.
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
            try {
                console.log('[CompilerClient] Sending reset command to worker...');
                this.ws.send(JSON.stringify({ type: 'reset' }));
            } catch (e) {
                console.warn('[CompilerClient] Failed to send reset command', e);
            }
        }

        if (this._offerRetryInterval) {
            clearInterval(this._offerRetryInterval);
            this._offerRetryInterval = null;
        }

        this._clearSpawnerHeartbeat();
        this._registeredSignalingSessionId = null;

        // Null out this.ws/pc BEFORE closing so onclose sees a stale socket
        // and skips the DISCONNECTED broadcast + readyPromise teardown that
        // would race with the reconnect we're about to initiate ourselves.
        const wsToClose = this.ws;
        const pcToClose = this.pc;
        this.ws = null;
        this.pc = null;
        if (wsToClose) { try { wsToClose.close(); } catch (_) {} }
        if (pcToClose) { try { pcToClose.close(); } catch (_) {} }

        // Wait for close events to propagate and backend to cleanup
        await new Promise(r => setTimeout(r, 1000));

        // Reset connection state but keep listeners
        this.compileChannel = null;
        this.buildLogChannel = null;
        this.terminalChannel = null;
        this.emulatorInputChannel = null;
        this.lspChannel = null;
        this.fileSyncChannel = null;
        this._abortPendingFileReads('reconnect');
        this._fileSyncOpenListeners.clear();
        this.readyPromise = null;
        this._setStatus(CompilerStatus.IDLE);

        // Clear streaming state
        this.currentStreams = [];

        return this.connect();
    }

    async compile({ filename, source, language, files = [], isGui = false, width, height, onLog, useAiSplit = false, userRequestedAi = false, userRequestedDeterministic = false, target = null, projectRoot = null, slug = null, sessionId: providedSessionId = null } = {}) {
        // Auto-detect React Native from source if no target specified and file is JS/JSX/TSX
        const ext = (filename || '').split('.').pop().toLowerCase();
        const isJsxFile = ['js', 'jsx', 'tsx', 'ts'].includes(ext);
        const isDartFile = ext === 'dart';
        
        let effectiveTarget = target;
        
        // Auto-detect Flutter projects from .dart files
        if (!effectiveTarget && isDartFile) {
            effectiveTarget = 'flutter-android-emulator';
            console.log('[CompilerClient] Auto-detected Flutter project from .dart file');
        }
        
        // Auto-detect React Native from source
        if (!effectiveTarget && isJsxFile && this._detectReactNativeInSource(source)) {
            effectiveTarget = 'react-native-emulator';
            console.log('[CompilerClient] Auto-detected React Native project from source imports');
        }
        
        // REMOVED: Force a clean WebRTC connection for mobile emulator runs.
        // This was causing unnecessary resets/disconnects on every "Run" click.
        // The reset should only happen on explicit Stop/Restart actions if needed.

        // For mobile targets, language detection is optional
        const isMobileTarget = effectiveTarget === 'react-native-emulator' || effectiveTarget === 'flutter-android-emulator';
        const lang = isMobileTarget ? (language || (isDartFile ? 'dart' : 'javascript')) : (language || this._mapLanguage(filename));
        if (!effectiveTarget && !lang) throw new SynthiException('Unsupported language for compilation', 'The file extension is not supported by the compiler.');
        // Generate a session id early so we can scope client-side WebRTC logs
        // (answer/ontrack) that occur during the initial connect/negotiation.
        const sessionId = (typeof providedSessionId === 'string' && providedSessionId.length > 0)
            ? providedSessionId
            : `sess-${Date.now()}-${Math.floor(Math.random()*100000)}`;

        // Record target for cancellation behavior (mobile vs non-mobile).
        this._sessionTargets.set(sessionId, effectiveTarget || 'native');

        // If a mobile session is already running, cancel it first and wait briefly
        // to allow the worker to teardown pipelines before starting a new run.
        if (isMobileTarget) {
            const previousSessionId = this.activeSessionId;
            if (previousSessionId && previousSessionId !== sessionId) {
                console.log('[CompilerClient] Waiting for previous session to cancel before starting new compile:', previousSessionId);
                const cancelResult = await this.cancelMobileJob(previousSessionId, { timeoutMs: 5000 });
                if (!cancelResult || !cancelResult.cancelled) {
                    if (typeof window !== 'undefined' && window.alert) {
                        window.alert(
                            `Previous build did not fully stop within 5 seconds (session ${previousSessionId}).\n` +
                            `Please wait a moment and try Run again.`
                        );
                    }
                    throw new SynthiException(
                        'Previous build still stopping',
                        'Previous build did not fully stop. Please wait and retry.'
                    );
                }
            }
        }

        // Associate client-side WebRTC logs with this run.
        this.activeSessionId = sessionId;

        // We'll want to surface browser-side WebRTC negotiation logs to the same build log stream.
        const clientLog = (line, sessionId) => {
            try { if (typeof onLog === 'function') onLog(line); } catch (_) {}
            this._emitBuildStream(sessionId, line);
        };

        // Install a WebRTC diagnostic emitter for this run so we can surface
        // answer/ontrack events in the build output (not only DevTools).
        this._webrtcEmit = (line) => {
            const sid = this.activeSessionId || sessionId;
            clientLog(line, sid);
        };

        // Marker to confirm updated client diagnostics are running.
        this._webrtcEmit('[webrtc] client-diag=v5');

        // Also log to console for immediate visibility
        console.log('[webrtc] client-diag=v5 - sessionId:', sessionId);

        return new Promise(async (resolve, reject) => {
            // Register promise callbacks so that cancelMobileJob can resolve/reject locally
            this.pendingCompilationMap.set(sessionId, { resolve, reject });

            // Flush any pre-session WebRTC diagnostics captured during auto-connect.
            if (this._pendingWebrtcLines && this._pendingWebrtcLines.length > 0) {
                const pending = this._pendingWebrtcLines.slice();
                this._pendingWebrtcLines.length = 0;
                for (const item of pending) {
                    const l = item?.line;
                    if (typeof l === 'string' && l.length > 0) {
                        this._webrtcEmit(`[webrtc] (pre-session) ${l.replace(/^\[webrtc\]\s*/i, '')}`);
                    }
                }
            }

            try {
                // If we didn't reconnect above (non-mobile targets), ensure we're connected
                const desiredSignalingSessionId = this._getSignalingSessionId() || null;
                if (this._registeredSignalingSessionId !== desiredSignalingSessionId) {
                    await this.softReconnect();
                } else if (!this.pc || this.pc.connectionState === 'closed') {
                    await this.connect();
                }

                // For mobile runs: sample WebRTC stats briefly to confirm inbound video bytes/frames.
                // This helps distinguish “UI issue” from “no media flowing / black frames”.
                const stopStats = () => {
                    try {
                        if (this._webrtcStatsTimer) {
                            clearInterval(this._webrtcStatsTimer);
                            this._webrtcStatsTimer = null;
                        }
                    } catch (_) {}
                };
                stopStats();
                if (effectiveTarget === 'react-native-emulator') {
                    let ticks = 0;
                    let lastBytes = null;
                    let sawNonZero = false;
                    this._webrtcStatsTimer = setInterval(async () => {
                        ticks += 1;
                        if (!this.pc || this.pc.connectionState === 'closed') {
                            stopStats();
                            return;
                        }
                        // Run for 60 ticks (2 min) to capture video after build completes.
                        // Stop early if we've seen data flowing for a while.
                        if (ticks > 60 || (sawNonZero && ticks > 30)) {
                            this._webrtcEmit?.(`[webrtc] stats timer stopping after ${ticks} ticks`);
                            stopStats();
                            return;
                        }
                        try {
                            const stats = await this.pc.getStats();
                            let bytesReceived = 0;
                            let packetsReceived = 0;
                            let framesDecoded = null;
                            let framesDropped = null;
                            let packetsLost = 0;
                            let jitter = null;
                            stats.forEach((r) => {
                                const isInbound = r.type === 'inbound-rtp';
                                const isVideo = r.kind === 'video' || r.mediaType === 'video';
                                if (!isInbound || !isVideo) return;
                                if (typeof r.bytesReceived === 'number') bytesReceived += r.bytesReceived;
                                if (typeof r.packetsReceived === 'number') packetsReceived += r.packetsReceived;
                                if (typeof r.framesDecoded === 'number') framesDecoded = (framesDecoded ?? 0) + r.framesDecoded;
                                if (typeof r.framesDropped === 'number') framesDropped = (framesDropped ?? 0) + r.framesDropped;
                                if (typeof r.packetsLost === 'number') packetsLost += r.packetsLost;
                                if (typeof r.jitter === 'number') jitter = r.jitter;
                            });

                            if (bytesReceived > 0) sawNonZero = true;
                            const muted = this._remoteVideoTrack ? !!this._remoteVideoTrack.muted : null;
                            const changed = (lastBytes === null) || (bytesReceived !== lastBytes);
                            lastBytes = bytesReceived;
                            // Always log during first 15 ticks, then only when changed
                            if (changed || bytesReceived > 0 || ticks <= 15) {
                                const fd = framesDecoded === null ? 'n/a' : String(framesDecoded);
                                const fdrop = framesDropped === null ? 'n/a' : String(framesDropped);
                                const jitterStr = jitter === null ? 'n/a' : jitter.toFixed(3);
                                this._webrtcEmit?.(`[webrtc] stats(video): bytes=${bytesReceived} packets=${packetsReceived} lost=${packetsLost} jitter=${jitterStr} framesDecoded=${fd} framesDropped=${fdrop} trackMuted=${muted}`);
                            }
                        } catch (_) {
                            // ignore
                        }
                    }, 2000);
                }

                // Mobile emulator streams video over WebRTC. If the browser connected earlier without
                // negotiating an m=video section, ontrack will never fire. Ensure recvonly video now.
                if (effectiveTarget === 'react-native-emulator' || isGui) {
                    // Fire-and-forget; we don't want to block the job on renegotiation.
                    this._ensureRecvTransceivers({ video: true, audio: isGui, forceRenegotiate: true, sessionId, onLog: (l) => clientLog(l, sessionId) })
                        .catch(() => {});
                }

                const handleLog = (msg) => {
                    // `msg` is normalized to a string by notifyLog. Ensure we have a string.
                    const line = typeof msg === 'string' ? msg : String(msg);

                    // Try to parse JSON to determine session and status.
                    let parsed = null;
                    try { parsed = JSON.parse(line); } catch (_) { parsed = null; }

                    // If the worker included a sessionId and it doesn't match this run, ignore.
                    if (parsed && parsed.sessionId && parsed.sessionId !== sessionId) return;

                    // Extract clean display text from structured messages.
                    // stdout/stderr JSON from the runner carries the actual output in `.line`.
                    // Internal status messages (stage/done) should not clutter the build log.
                    // lsp-stderr is diagnostic noise from the language server — always hide.
                    let displayLine = line;
                    if (parsed) {
                        if (parsed.type === 'lsp-stderr' || parsed.type === 'hmr-status' || parsed.type === 'run-gui-start' || parsed.type === 'run-gui-end') {
                            // Internal diagnostic / HMR / GUI-signal noise — suppress entirely
                            displayLine = null;
                        } else if ((parsed.type === 'stdout' || parsed.type === 'stderr') && parsed.line != null) {
                            displayLine = String(parsed.line);
                        } else if (parsed.status === 'done' || parsed.status === 'error') {
                            // Internal completion signals — don't forward to user-visible log.
                            displayLine = null;
                        }
                    }

                    // Forward clean log line to caller callback if provided
                    try { if (onLog && displayLine != null) onLog(displayLine); } catch (e) { /* ignore */ }

                    // Determine which sessionId to expose to UI consumers: prefer worker-provided sessionId
                    const sidToExpose = parsed && parsed.sessionId ? parsed.sessionId : sessionId;

                    // Keep activeSessionId aligned with worker-provided sessionId (best-effort).
                    if (sidToExpose && this.activeSessionId !== sidToExpose) {
                        this.activeSessionId = sidToExpose;
                    }

                    // Emit a stream event for UI consumers that want session-scoped streaming
                    try {
                        if (typeof window !== 'undefined' && window.dispatchEvent) {
                            const streamLine = displayLine != null ? displayLine : line;
                            const ev = new CustomEvent('synthi:build-stream', { detail: { sessionId: sidToExpose, line: streamLine } });
                            window.dispatchEvent(ev);
                        }
                    } catch (e) { /* ignore */ }

                    // Check for mobile job completion
                    if (parsed && parsed.type === 'mobile-status' && parsed.status === 'done') {
                        this.logHandlers.delete(handleLog);
                        this.pendingCompilationMap.delete(sessionId);
                        // Clear per-run WebRTC emitter.
                        this._webrtcEmit = null;
                        stopStats();
                        this._sessionTargets.delete(sessionId);
                        if (parsed.data?.success) {
                            resolve(parsed);
                        } else {
                            reject(new SynthiException('Mobile build failed', parsed.message || 'Mobile emulator job failed'));
                        }
                        return;
                    }

                    // Check for mobile job error
                    if (parsed && parsed.type === 'mobile-status' && parsed.status === 'error') {
                        this.logHandlers.delete(handleLog);
                        this.pendingCompilationMap.delete(sessionId);
                        this._webrtcEmit = null;
                        stopStats();
                        this._sessionTargets.delete(sessionId);
                        reject(new SynthiException('Mobile build failed', parsed.message || 'Mobile emulator job failed'));
                        return;
                    }

                    // Check for final JSON status message to resolve/reject for this session
                    if (parsed && parsed.status === 'done') {
                        // cleanup
                        this.logHandlers.delete(handleLog);
                        this.pendingCompilationMap.delete(sessionId);
                        this._webrtcEmit = null;
                        stopStats();
                        if (parsed.success) {
                            this._sessionTargets.delete(sessionId);
                            resolve(parsed);
                        } else {
                            this._sessionTargets.delete(sessionId);
                            // Surface the actual error details from the backend instead of a generic message.
                            // The worker sends `error`, `message`, and `stage` fields alongside success:false.
                            // `error` may be a string (stderr text) or an object/array (structured g++ JSON) —
                            // coerce to string for the exception message.
                            let detail = parsed.error || parsed.message || 'The compilation process returned an error status.';
                            if (typeof detail !== 'string') {
                                // Structured error (e.g. g++ JSON diagnostics array) — extract human-readable messages
                                try {
                                    if (Array.isArray(detail)) {
                                        detail = detail.map(d => d.message || JSON.stringify(d)).join('; ');
                                    } else {
                                        detail = detail.message || JSON.stringify(detail);
                                    }
                                } catch (_) {
                                    detail = String(detail);
                                }
                            }
                            const stage = parsed.stage ? `[${parsed.stage}]` : '';
                            reject(new SynthiException('Compilation failed', `${stage} ${detail}`.trim()));
                        }
                        return;
                    }
                };
                this.logHandlers.add(handleLog);

                this.compileChannel.send(JSON.stringify({
                    language: lang,
                    filename: filename || `main.${lang}`,
                    source: source || '',
                    files: files,
                    session_id: sessionId,
                    is_gui: isGui,
                    width: width,
                    height: height,
                    supports_h265: this.supportsH265,
                    use_ai_split: useAiSplit,
                    user_requested_ai: userRequestedAi,
                    user_requested_deterministic: userRequestedDeterministic,
                    target: effectiveTarget,
                    project_root: projectRoot,
                    slug: slug || this.slug
                }));
            } catch (e) {
                this.pendingCompilationMap.delete(sessionId);
                if (onLog) this.logHandlers.delete(onLog);
                reject(e);
            }
        });
    }

    /**
     * Cancel/stop a running mobile emulator job.
     * Sends a cancel message through the compile channel to terminate the job on the worker.
     * @param {string} sessionId - The session ID of the mobile job to cancel
     */
    async cancelMobileJob(sessionId, { timeoutMs = 5000 } = {}) {
        if (!sessionId) {
            console.warn('[CompilerClient] cancelMobileJob called without sessionId');
            return { cancelled: false, timedOut: false };
        }

        // Check if there is a pending local promise for this session and reject it
        if (this.pendingCompilationMap.has(sessionId)) {
            const { reject } = this.pendingCompilationMap.get(sessionId);
            reject(new SynthiException('Cancelled', 'Compilation cancelled by user'));
            this.pendingCompilationMap.delete(sessionId);
        }
        
        try {
            if (this.compileChannel && this.compileChannel.readyState === 'open') {
                this.compileChannel.send(JSON.stringify({
                    type: 'cancel-mobile-job',
                    session_id: sessionId,
                }));
                console.debug('[CompilerClient] Sent cancel-mobile-job for session:', sessionId);
            } else {
                console.warn('[CompilerClient] Cannot cancel mobile job - compile channel not open');
            }
        } catch (e) {
            console.error('[CompilerClient] Failed to send cancel-mobile-job:', e);
        }

        // Wait for cancellation confirmation from worker
        const result = await new Promise((resolve) => {
            let timer = null;
            const handler = (msg) => {
                const line = typeof msg === 'string' ? msg : String(msg);
                
                // Matches log: [mobile-job] Session ... cancelled by user
                // Also matches: [input.rs] Session ... marked as cancelled
                if (line.includes(sessionId) && (
                    line.includes('cancelled by user') || 
                    line.includes('marked as cancelled')
                )) {
                    cleanup();
                    resolve({ cancelled: true, timedOut: false });
                    return;
                }
                
                // Check for JSON status if applicable
                try {
                    const parsed = JSON.parse(line);
                    if (parsed && parsed.sessionId === sessionId && 
                       (parsed.type === 'mobile-status' && (parsed.status === 'done' || parsed.status === 'error'))) {
                           cleanup();
                           resolve({ cancelled: true, timedOut: false });
                    }
                } catch(_) {}
            };

            const cleanup = () => {
                this.logHandlers.delete(handler);
                if (timer) clearTimeout(timer);
            };

            // Set a timeout so we don't wait forever if the backend is silent or crashed
            timer = setTimeout(() => {
                cleanup();
                resolve({ cancelled: false, timedOut: true });
            }, timeoutMs); // timeout for cancellation confirmation

            this.logHandlers.add(handler);
        });
        
        // Clear active session if it matches
        if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
        }

        // Clear WebRTC emitter
        this._webrtcEmit = null;

        this._sessionTargets.delete(sessionId);

        return result;
    }

    /**
     * Dismiss a session locally without sending cancel-build to the worker.
     * Used for HMR saves: the worker's compile function will handle runner
     * restart automatically (killing old runner, reusing Xvfb/GStreamer).
     * Sending cancel-build would destroy the entire infrastructure.
     */
    dismissSession(sessionId) {
        if (!sessionId) return;
        // Reject the pending promise so the caller doesn't hang
        if (this.pendingCompilationMap.has(sessionId)) {
            const { reject } = this.pendingCompilationMap.get(sessionId);
            try { reject(new SynthiException('Cancelled', 'HMR restart')); } catch (_) {}
            this.pendingCompilationMap.delete(sessionId);
        }
        // Clear active session so compile() generates a fresh one
        if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
        }
        this._sessionTargets.delete(sessionId);
    }

    /**
     * Cancel/stop a running build (all targets).
     * Sends a cancel message through the compile channel to terminate the job on the worker.
     * @param {string} sessionId - The session ID of the job to cancel
     */
    async cancelBuild(sessionId, { timeoutMs = 5000 } = {}) {
        if (!sessionId) {
            console.warn('[CompilerClient] cancelBuild called without sessionId');
            return { cancelled: false, timedOut: false };
        }

        // Check if there is a pending local promise for this session and reject it
        if (this.pendingCompilationMap.has(sessionId)) {
            const { reject } = this.pendingCompilationMap.get(sessionId);
            reject(new SynthiException('Cancelled', 'Compilation cancelled by user'));
            this.pendingCompilationMap.delete(sessionId);
        }

        try {
            if (this.compileChannel && this.compileChannel.readyState === 'open') {
                this.compileChannel.send(JSON.stringify({
                    type: 'cancel-build',
                    session_id: sessionId,
                }));
                console.debug('[CompilerClient] Sent cancel-build for session:', sessionId);
            } else {
                console.warn('[CompilerClient] Cannot cancel build - compile channel not open');
            }
        } catch (e) {
            console.error('[CompilerClient] Failed to send cancel-build:', e);
        }

        const result = await new Promise((resolve) => {
            let timer = null;
            const handler = (msg) => {
                const line = typeof msg === 'string' ? msg : String(msg);
                const target = this._sessionTargets.get(sessionId);
                const isMobile = target === 'react-native-emulator';
                if (line.includes(sessionId) && (
                    line.includes('cancelled by user') ||
                    line.includes('cancelled')
                )) {
                    cleanup();
                    resolve({ cancelled: true, timedOut: false });
                    return;
                }

                try {
                    const parsed = JSON.parse(line);
                    if (parsed && parsed.sessionId === sessionId) {
                        if (!isMobile && parsed.type === 'build-status' && parsed.status === 'cancelled') {
                            cleanup();
                            resolve({ cancelled: true, timedOut: false });
                            return;
                        }
                        if (parsed.type === 'mobile-status' && parsed.status === 'cancelled') {
                            cleanup();
                            resolve({ cancelled: true, timedOut: false });
                            return;
                        }
                    }
                } catch (_) {}
            };

            const cleanup = () => {
                this.logHandlers.delete(handler);
                if (timer) clearTimeout(timer);
            };

            timer = setTimeout(() => {
                cleanup();
                resolve({ cancelled: false, timedOut: true });
            }, timeoutMs);

            this.logHandlers.add(handler);
        });

        if (this.activeSessionId === sessionId) {
            this.activeSessionId = null;
        }

        this._sessionTargets.delete(sessionId);

        return result;
    }

    dispose() {
        this._clearSpawnerHeartbeat();
        this._registeredSignalingSessionId = null;
        if (this.ws) {
            this.ws.close();
        }
        if (this.pc) {
            this.pc.close();
        }
        try {
            if (this._webrtcStatsTimer) {
                clearInterval(this._webrtcStatsTimer);
                this._webrtcStatsTimer = null;
            }
        } catch (_) {}
        if (typeof window !== 'undefined') {
            window.removeEventListener('synthi:terminal-input', this._handleTerminalInput);
            window.removeEventListener('synthi:gui-input', this._handleGuiInput);
        }
        this.ws = null;
        this.pc = null;
        this.compileChannel = null;
        this.buildLogChannel = null;
        this.terminalChannel = null;
        this.readyPromise = null;
        this.logHandlers.clear();
        this.statusListeners.clear();
        this._setStatus(CompilerStatus.IDLE);
    }
}

// Singleton instance for backward compatibility
let globalInstance = null;

export const getCompilerClient = () => {
    if (!globalInstance) {
        globalInstance = new CompilerClient();
    }
    return globalInstance;
};

export const getMediaStream = () => {
    if (!globalInstance) return null;
    return globalInstance.getMediaStream();
};

export const compileWithWorker = async (params) => {
    const client = getCompilerClient();
    return client.compile(params);
};

export const cancelMobileJob = (sessionId, options) => {
    const client = getCompilerClient();
    return client.cancelMobileJob(sessionId, options);
};
