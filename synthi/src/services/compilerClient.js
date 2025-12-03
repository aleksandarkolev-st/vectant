const SIGNAL_URL = process.env.NEXT_PUBLIC_COMPILE_SIGNAL_URL || 'ws://localhost:9000';
// Optional: supply ICE servers through NEXT_PUBLIC_ICE_SERVERS as a JSON array of
// RTCIceServer objects. Example (in .env.local):
// NEXT_PUBLIC_ICE_SERVERS='[{"urls":["stun:stun.l.google.com:19302"]},{"urls":["turn:turn.example.com:3478"],"username":"user","credential":"pass"}]'
const parseIceServers = (raw) => {
    if (!raw) return [{ urls: 'stun:stun.l.google.com:19302' }];
    try {
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [{ urls: 'stun:stun.l.google.com:19302' }];
        return parsed;
    } catch (e) {
        // If parsing fails, fallback to a single Google STUN server
        console.warn('Failed to parse NEXT_PUBLIC_ICE_SERVERS, falling back to default STUN server', e);
        return [{ urls: 'stun:stun.l.google.com:19302' }];
    }
};
const ICE_SERVERS = parseIceServers(process.env.NEXT_PUBLIC_ICE_SERVERS);

let ws = null;
let pc = null;
let compileChannel = null;
let buildLogChannel = null;
let terminalChannel = null;
let readyPromise = null;
let currentStreams = [];
const logHandlers = new Set();
const textDecoder = typeof TextDecoder !== 'undefined' ? new TextDecoder() : null;
let terminalInputBuffer = [];

export const getMediaStream = () => {
    if (currentStreams && currentStreams.length > 0) {
        return currentStreams[0];
    }
    return null;
};

const mapLanguage = (filename = '') => {
    const ext = filename.split('.').pop().toLowerCase();
    if (['cpp', 'cc', 'cxx', 'hpp', 'h'].includes(ext)) return 'cpp';
    if (ext === 'rs') return 'rust';
    if (ext === 'ts' || ext === 'tsx') return 'ts';
    return null;
};

const notifyLog = (msg) => {
    // Normalize incoming payload to a string so handlers can parse it reliably.
    let text = msg;
    try {
        if (msg instanceof ArrayBuffer && textDecoder) {
            text = textDecoder.decode(new Uint8Array(msg));
        } else if (msg && typeof msg === 'object' && msg.data instanceof ArrayBuffer && textDecoder) {
            text = textDecoder.decode(new Uint8Array(msg.data));
        } else if (typeof msg !== 'string') {
            text = String(msg);
        }
    } catch (e) {
        text = String(msg);
    }

    // Check for GUI control messages
    try {
        const parsed = JSON.parse(text);
        if (parsed && parsed.type === 'run-gui-start') {
            console.log('[compilerClient] Dispatching synthi:gui-start', parsed);
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('synthi:gui-start', { detail: parsed }));
            }
        } else if (parsed && parsed.type === 'run-gui-end') {
            console.log('[compilerClient] Dispatching synthi:gui-end', parsed);
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                window.dispatchEvent(new CustomEvent('synthi:gui-end', { detail: parsed }));
            }
        }
    } catch (e) {
        // ignore
    }

    logHandlers.forEach((fn) => {
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
};

const ensureConnection = () => {
    if (readyPromise) return readyPromise;
    readyPromise = new Promise((resolve, reject) => {
        pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

        // Log supported codecs for debugging
        try {
            if (RTCRtpReceiver.getCapabilities) {
                const capabilities = RTCRtpReceiver.getCapabilities('video');
                if (capabilities && capabilities.codecs) {
                    console.log('Browser supported video codecs:', capabilities.codecs.map(c => c.mimeType));
                    const hasH265 = capabilities.codecs.some(c => c.mimeType.toLowerCase() === 'video/h265');
                    console.log('H.265 supported by browser:', hasH265);
                }
            }
        } catch (e) {
            console.warn('Failed to check codec capabilities', e);
        }

        pc.onicecandidate = (event) => {
            if (event.candidate && ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'candidate', candidate: event.candidate }));
            }
        };

        pc.oniceconnectionstatechange = () => {
            try { console.debug('compilerClient ICE connection state:', pc.iceConnectionState); } catch (e) {}
        };

        pc.onicegatheringstatechange = () => {
            try { console.debug('compilerClient ICE gathering state:', pc.iceGatheringState); } catch (e) {}
        };
        pc.onconnectionstatechange = () => {
            try { console.debug('compilerClient connection state:', pc.connectionState); } catch (e) {}
        };

        pc.ontrack = (event) => {
            console.log('Received remote track', event.track.kind);
            if (event.streams && event.streams.length > 0) {
                currentStreams = event.streams;
            }
            if (typeof window !== 'undefined' && window.dispatchEvent) {
                const ev = new CustomEvent('synthi:media-track', { detail: { track: event.track, streams: event.streams } });
                window.dispatchEvent(ev);
            }
        };

        pc.ondatachannel = (event) => {
            const ch = event.channel;
            if (ch.label === 'build-log') {
                buildLogChannel = ch;
                ch.onmessage = (ev) => notifyLog(ev.data);
            }
        };

        console.log('compilerClient connecting to', SIGNAL_URL);
        ws = new WebSocket(SIGNAL_URL);

        ws.onerror = (err) => {
            console.error('compilerClient ws error', err);
            readyPromise = null;
            reject(err);
        };

        ws.onclose = () => {
            console.warn('compilerClient ws closed');
            readyPromise = null;
            compileChannel = null;
            buildLogChannel = null;
            pc = null;
            ws = null;
        };

        ws.onmessage = async (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch (_) { return; }
            if (msg.type === 'answer' && msg.sdp) {
                await pc.setRemoteDescription(new RTCSessionDescription({ type: msg.sdp_type || 'answer', sdp: msg.sdp }));
            } else if (msg.type === 'candidate' && msg.candidate) {
                try { await pc.addIceCandidate(msg.candidate); } catch (_) {}
            }
        };

        ws.onopen = async () => {
            ws.send(JSON.stringify({ type: 'register', role: 'browser' }));
            compileChannel = pc.createDataChannel('compile', { ordered: true });
            // Terminal channel for stdin forwarding
            terminalChannel = pc.createDataChannel('terminal', { ordered: true });
            compileChannel.onclose = () => {};

            const offer = await pc.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: true });
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, sdp_type: offer.type }));

            compileChannel.onopen = () => resolve(true);
            // Listen for terminal input events only after the terminal channel is open.
            const terminalListener = (ev) => {
                try {
                    const d = ev?.detail || {};
                    const payload = JSON.stringify({ type: 'stdin', sessionId: d.sessionId, data: d.data });
                    try { console.debug('[compilerClient] terminalListener received', { payload, terminalReady: !!(terminalChannel && terminalChannel.readyState === 'open') }); } catch (_) {}
                    if (terminalChannel && terminalChannel.readyState === 'open') {
                        terminalChannel.send(payload);
                        try { console.debug('[compilerClient] sent payload over terminalChannel'); } catch (_) {}
                    } else {
                        // Buffer until channel opens
                        terminalInputBuffer.push(payload);
                        try { console.debug('[compilerClient] buffered terminal input (channel not open)'); } catch (_) {}
                    }
                } catch (e) { console.error('[compilerClient] terminalListener error', e); }
            };
            if (terminalChannel) {
                terminalChannel.onopen = () => {
                    if (typeof window !== 'undefined' && window.addEventListener) {
                        window.addEventListener('synthi:terminal-input', terminalListener);
                    }
                    // flush buffer
                    while (terminalInputBuffer.length > 0) {
                        const p = terminalInputBuffer.shift();
                        try { terminalChannel.send(p); } catch (_) { /* ignore */ }
                    }
                };
                // If the channel is already open, attach immediately
                if (terminalChannel.readyState === 'open') {
                    if (typeof window !== 'undefined' && window.addEventListener) {
                        window.addEventListener('synthi:terminal-input', terminalListener);
                    }
                }
                terminalChannel.onclose = () => {
                    try { window.removeEventListener('synthi:terminal-input', terminalListener); } catch (_) {}
                };
            }
            // Remove listener when the WebSocket closes as a backup
            ws.addEventListener('close', () => {
                try { window.removeEventListener('synthi:terminal-input', terminalListener); } catch (_) {}
            });
        };
    });
    return readyPromise;
};

export const compileWithWorker = async ({ filename, source, language, files = [], isGui = false, width, height, onLog } = {}) => {
    const lang = language || mapLanguage(filename);
    if (!lang) throw new Error('Unsupported language for compilation');
    await ensureConnection();

    if (onLog) logHandlers.add(onLog);

    return new Promise((resolve, reject) => {
        // Unique session id for this compile - allows streaming and session-scoped events
        const sessionId = `sess-${Date.now()}-${Math.floor(Math.random()*100000)}`;

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

            // Check for final JSON status message to resolve/reject for this session
            if (parsed && parsed.status === 'done') {
                // cleanup
                logHandlers.delete(handleLog);
                if (onLog) logHandlers.delete(onLog);
                if (parsed.success) {
                    resolve(parsed);
                } else {
                    reject(new Error('Compilation failed'));
                }
                return;
            }
        };
        logHandlers.add(handleLog);

        try {
            compileChannel.send(JSON.stringify({
                language: lang,
                filename: filename || `main.${lang}`,
                source: source || '',
                files: files,
                session_id: sessionId,
                is_gui: isGui,
                width: width,
                height: height
            }));
        } catch (e) {
            logHandlers.delete(handleLog);
            if (onLog) logHandlers.delete(onLog);
            reject(e);
        }
    });
};
