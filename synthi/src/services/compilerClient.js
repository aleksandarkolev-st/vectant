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
let readyPromise = null;
const logHandlers = new Set();

const mapLanguage = (filename = '') => {
    const ext = filename.split('.').pop().toLowerCase();
    if (['cpp', 'cc', 'cxx', 'hpp', 'h'].includes(ext)) return 'cpp';
    if (ext === 'rs') return 'rust';
    if (ext === 'ts' || ext === 'tsx') return 'ts';
    return null;
};

const notifyLog = (msg) => {
    logHandlers.forEach((fn) => {
        try { fn(msg); } catch (e) { /* ignore */ }
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
            compileChannel.onclose = () => {};

            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp, sdp_type: offer.type }));

            compileChannel.onopen = () => resolve(true);
        };
    });
    return readyPromise;
};

export const compileWithWorker = async ({ filename, source, language, onLog } = {}) => {
    const lang = language || mapLanguage(filename);
    if (!lang) throw new Error('Unsupported language for compilation');
    await ensureConnection();

    if (onLog) logHandlers.add(onLog);

    return new Promise((resolve, reject) => {
        const handleLog = (line) => {
            try {
                const parsed = JSON.parse(line);
                if (parsed && parsed.status === 'done') {
                    logHandlers.delete(handleLog);
                    if (onLog) logHandlers.delete(onLog);
                    if (parsed.success) {
                        resolve(parsed);
                    } else {
                        reject(new Error('Compilation failed'));
                    }
                    return;
                }
            } catch (_) {}
        };
        logHandlers.add(handleLog);

        try {
            compileChannel.send(JSON.stringify({ language: lang, filename: filename || `main.${lang}`, source: source || '' }));
        } catch (e) {
            logHandlers.delete(handleLog);
            if (onLog) logHandlers.delete(onLog);
            reject(e);
        }
    });
};
