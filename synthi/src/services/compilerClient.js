import SynthiException from "@/components/SynthiException";

const SIGNAL_URL = process.env.NEXT_PUBLIC_COMPILE_SIGNAL_URL || 'ws://localhost:9000';

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
const ICE_SERVERS = parseIceServers(process.env.NEXT_PUBLIC_ICE_SERVERS);

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
        this.ws = null;
        this.pc = null;
        this.compileChannel = null;
        this.buildLogChannel = null;
        this.terminalChannel = null;
        this.lspChannel = null;
        this.readyPromise = null;
        this.currentStreams = [];
        this.logHandlers = new Set();
        this.statusListeners = new Set();
        this.textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
        this.terminalInputBuffer = [];
        this.guiInputBuffer = [];
        this.status = CompilerStatus.IDLE;
        this.slug = null;
        this.supportsH265 = false;
        
        this._handleTerminalInput = this._handleTerminalInput.bind(this);
        this._handleGuiInput = this._handleGuiInput.bind(this);
    }

    setSlug(slug) {
        this.slug = slug;
    }

    getMediaStream() {
        if (this.currentStreams && this.currentStreams.length > 0) {
            return this.currentStreams[0];
        }
        return null;
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
        if (['cpp', 'cc', 'cxx', 'hpp', 'h'].includes(ext)) return 'cpp';
        if (ext === 'rs') return 'rust';
        if (ext === 'ts' || ext === 'tsx') return 'ts';
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

        console.log('[CompilerClient] Received log:', text);

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
            if (parsed && parsed.type === 'run-gui-start') {
                console.log('[CompilerClient] Dispatching synthi:gui-start', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:gui-start', { detail: parsed }));
                }
            } else if (parsed && parsed.type === 'run-gui-end') {
                console.log('[CompilerClient] Dispatching synthi:gui-end', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:gui-end', { detail: parsed }));
                }
            } else if (parsed && parsed.type === 'compile-diagnostics') {
                // Structured compile diagnostics - dispatch to error overlay
                console.log('[CompilerClient] Dispatching synthi:compile-diagnostics', parsed);
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
                console.log('[CompilerClient] Dispatching synthi:hmr-status (native)', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:hmr-status', { detail: parsed.data || parsed }));
                }
                // Don't log HMR status to build log
                return;
            } else if (parsed && (parsed.type === 'update' || parsed.type === 'hash' || parsed.type === 'ok' || parsed.type === 'reload')) {
                console.log('[CompilerClient] Dispatching synthi:hmr-update', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:hmr-update', { detail: parsed }));
                }
                // Do not log HMR messages to the build log
                return;
            } else if (parsed && parsed.manifest && parsed.modules) {
                console.log('[CompilerClient] Dispatching synthi:hmr-update (Rust payload)', parsed);
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
                console.log('[CompilerClient] Dispatching synthi:hmr-status (runner)', parsed);
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    window.dispatchEvent(new CustomEvent('synthi:hmr-status', { detail: parsed }));
                }
                return;
            }
        } catch (e) {
            // ignore
        }

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

    connect() {
        if (this.readyPromise) return this.readyPromise;
        
        this._setStatus(CompilerStatus.CONNECTING);
        
        this.readyPromise = new Promise((resolve, reject) => {
            this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

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
                    this._setStatus(CompilerStatus.CONNECTED);
                } else if (this.pc.connectionState === 'disconnected' || this.pc.connectionState === 'failed') {
                    this._setStatus(CompilerStatus.DISCONNECTED);
                }
            };

            this.pc.ontrack = (event) => {
                console.log('Received remote track', event.track.kind);
                if (event.streams && event.streams.length > 0) {
                    this.currentStreams = event.streams;
                }
                if (typeof window !== 'undefined' && window.dispatchEvent) {
                    const ev = new CustomEvent('synthi:media-track', { detail: { track: event.track, streams: event.streams } });
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

            console.log('CompilerClient connecting to', this.url);
            this.ws = new WebSocket(this.url);

            this.ws.onerror = (err) => {
                console.error('CompilerClient ws error', err);
                this.readyPromise = null;
                this._setStatus(CompilerStatus.ERROR);
                reject(err);
            };

            this.ws.onclose = () => {
                console.warn('CompilerClient ws closed');
                this.readyPromise = null;
                this.compileChannel = null;
                this.buildLogChannel = null;
                this.pc = null;
                this.ws = null;
                this._setStatus(CompilerStatus.DISCONNECTED);
            };

            this.ws.onmessage = async (event) => {
                let msg;
                try { msg = JSON.parse(event.data); } catch (_) { return; }
                if (msg.type === 'answer' && msg.sdp) {
                    await this.pc.setRemoteDescription(new RTCSessionDescription({ type: msg.sdp_type || 'answer', sdp: msg.sdp }));
                } else if (msg.type === 'candidate' && msg.candidate) {
                    try { await this.pc.addIceCandidate(msg.candidate); } catch (_) {}
                }
            };

            this.ws.onopen = async () => {
                this.ws.send(JSON.stringify({ type: 'register', role: 'browser' }));
                this.compileChannel = this.pc.createDataChannel('compile', { ordered: true });
                // Terminal channel for stdin forwarding
                this.terminalChannel = this.pc.createDataChannel('terminal', { ordered: true });
                
                this.compileChannel.onclose = () => {};

                const offer = await this.pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
                await this.pc.setLocalDescription(offer);
                this.ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, sdp_type: offer.type }));

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
                        }
                    }
                    this.terminalChannel.onclose = () => {
                        try { 
                            window.removeEventListener('synthi:terminal-input', this._handleTerminalInput); 
                            window.removeEventListener('synthi:gui-input', this._handleGuiInput);
                        } catch (_) {}
                    };
                }
                // Remove listener when the WebSocket closes as a backup
                this.ws.addEventListener('close', () => {
                    try { 
                        window.removeEventListener('synthi:terminal-input', this._handleTerminalInput); 
                        window.removeEventListener('synthi:gui-input', this._handleGuiInput);
                    } catch (_) {}
                });
            };
        });
        return this.readyPromise;
    }

    createLspChannel(language) {
        if (!this.pc || this.pc.connectionState !== 'connected') {
            throw new Error('CompilerClient not connected');
        }
        const label = `lsp-${language}?slug=${this.slug || ''}`;
        const channel = this.pc.createDataChannel(label, { ordered: true });
        channel.binaryType = 'arraybuffer';

        // Trigger renegotiation to establish the new data channel
        this.pc.createOffer().then(offer => {
            return this.pc.setLocalDescription(offer).then(() => offer);
        }).then(offer => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
                this.ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, sdp_type: offer.type }));
            }
        }).catch(e => console.error('Renegotiation failed', e));

        return channel;
    }

    async compile({ filename, source, language, files = [], isGui = false, width, height, onLog, useAiSplit = false, target = null, projectRoot = null, slug = null, sessionId: providedSessionId = null } = {}) {
        // Auto-detect React Native from source if no target specified and file is JS/JSX/TSX
        const ext = (filename || '').split('.').pop().toLowerCase();
        const isJsxFile = ['js', 'jsx', 'tsx', 'ts'].includes(ext);
        
        let effectiveTarget = target;
        if (!effectiveTarget && isJsxFile && this._detectReactNativeInSource(source)) {
            effectiveTarget = 'react-native-emulator';
            console.log('[CompilerClient] Auto-detected React Native project from source imports');
        }
        
        // For mobile targets, language detection is optional
        const lang = effectiveTarget === 'react-native-emulator' ? (language || 'javascript') : (language || this._mapLanguage(filename));
        if (!effectiveTarget && !lang) throw new SynthiException('Unsupported language for compilation', 'The file extension is not supported by the compiler.');
        await this.connect();

        return new Promise((resolve, reject) => {
            // Unique session id for this compile - allows streaming and session-scoped events
            const sessionId = (typeof providedSessionId === 'string' && providedSessionId.length > 0)
                ? providedSessionId
                : `sess-${Date.now()}-${Math.floor(Math.random()*100000)}`;

            const handleLog = (msg) => {
                // `msg` is normalized to a string by notifyLog. Ensure we have a string.
                const line = typeof msg === 'string' ? msg : String(msg);

                // Try to parse JSON to determine session and status.
                let parsed = null;
                try { parsed = JSON.parse(line); } catch (_) { parsed = null; }

                // If the worker included a sessionId and it doesn't match this run, ignore.
                if (parsed && parsed.sessionId && parsed.sessionId !== sessionId) return;

                // Forward raw log line to caller callback if provided
                try { if (onLog) onLog(line); } catch (e) { /* ignore */ }

                // Determine which sessionId to expose to UI consumers: prefer worker-provided sessionId
                const sidToExpose = parsed && parsed.sessionId ? parsed.sessionId : sessionId;

                // Emit a stream event for UI consumers that want session-scoped streaming
                try {
                    if (typeof window !== 'undefined' && window.dispatchEvent) {
                        const ev = new CustomEvent('synthi:build-stream', { detail: { sessionId: sidToExpose, line } });
                        window.dispatchEvent(ev);
                    }
                } catch (e) { /* ignore */ }

                // Check for mobile job completion
                if (parsed && parsed.type === 'mobile-status' && parsed.status === 'done') {
                    this.logHandlers.delete(handleLog);
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
                    reject(new SynthiException('Mobile build failed', parsed.message || 'Mobile emulator job failed'));
                    return;
                }

                // Check for final JSON status message to resolve/reject for this session
                if (parsed && parsed.status === 'done') {
                    // cleanup
                    this.logHandlers.delete(handleLog);
                    if (parsed.success) {
                        resolve(parsed);
                    } else {
                        reject(new SynthiException('Compilation failed', 'The compilation process returned an error status.'));
                    }
                    return;
                }
            };
            this.logHandlers.add(handleLog);

            try {
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
                    target: effectiveTarget,
                    project_root: projectRoot,
                    slug: slug || this.slug
                }));
            } catch (e) {
                this.logHandlers.delete(handleLog);
                if (onLog) this.logHandlers.delete(onLog);
                reject(e);
            }
        });
    }

    dispose() {
        if (this.ws) {
            this.ws.close();
        }
        if (this.pc) {
            this.pc.close();
        }
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
