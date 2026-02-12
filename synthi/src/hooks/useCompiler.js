'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CompilerClient, CompilerStatus, getCompilerClient } from '@/services/compilerClient';

export function useCompiler() {
    const clientRef = useRef(null);
    const [status, setStatus] = useState(CompilerStatus.IDLE);
    const [isCompiling, setIsCompiling] = useState(false);
    const [mediaStream, setMediaStream] = useState(null);

    // Auto-reconnect timer ref — persists across status changes
    const reconnectTimerRef = useRef(null);
    const reconnectAttemptsRef = useRef(0);
    const MAX_RECONNECT_ATTEMPTS = 5;
    const RECONNECT_BASE_DELAY = 3000;

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const client = getCompilerClient();
        clientRef.current = client;
        
        setStatus(client.status);

        // Auto-connect if idle so LSP can start
        if (client.status === CompilerStatus.IDLE) {
            client.connect().catch(e => console.error("Auto-connect failed", e));
        }

        const unsubscribeStatus = client.onStatusChange((newStatus) => {
            setStatus(newStatus);

            // Auto-reconnect on disconnect
            if (newStatus === CompilerStatus.DISCONNECTED) {
                if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
                if (reconnectAttemptsRef.current < MAX_RECONNECT_ATTEMPTS) {
                    const delay = RECONNECT_BASE_DELAY * Math.pow(1.5, reconnectAttemptsRef.current);
                    console.log(`[useCompiler] Auto-reconnect attempt ${reconnectAttemptsRef.current + 1}/${MAX_RECONNECT_ATTEMPTS} in ${Math.round(delay)}ms`);
                    reconnectTimerRef.current = setTimeout(async () => {
                        reconnectTimerRef.current = null;
                        reconnectAttemptsRef.current++;
                        try {
                            // Use softReconnect to avoid killing vscode-server-manager
                            // and ext-host on the worker. The worker processes are
                            // independent of the WebRTC PeerConnection and will
                            // reconnect their DataChannels automatically.
                            await client.softReconnect();
                            console.log('[useCompiler] Auto-reconnect succeeded');
                            reconnectAttemptsRef.current = 0;
                        } catch (e) {
                            console.error('[useCompiler] Auto-reconnect failed:', e.message);
                        }
                    }, delay);
                } else {
                    console.warn(`[useCompiler] Max reconnect attempts (${MAX_RECONNECT_ATTEMPTS}) reached`);
                }
            } else if (newStatus === CompilerStatus.CONNECTED) {
                // Connection restored — reset reconnect counter
                reconnectAttemptsRef.current = 0;
                if (reconnectTimerRef.current) {
                    clearTimeout(reconnectTimerRef.current);
                    reconnectTimerRef.current = null;
                }
            }
        });

        const handleTrack = (e) => {
            const { streams, track } = e.detail || {};
            try {
                console.debug('[useCompiler] media-track event', {
                    streams: streams?.length ?? 0,
                    trackKind: track?.kind,
                    trackId: track?.id,
                    readyState: track?.readyState,
                    muted: track?.muted,
                });
            } catch (_) {
                // ignore
            }
            if (streams && streams.length > 0) {
                try {
                    const vt = typeof streams[0]?.getVideoTracks === 'function' ? streams[0].getVideoTracks().length : 0;
                    console.debug('[useCompiler] setting mediaStream from streams[0]', { videoTracks: vt });
                } catch (_) {}
                setMediaStream(streams[0]);
                return;
            }
            // Fallback: some browsers report `streams=[]` on ontrack.
            if (track && track.kind === 'video') {
                try {
                    const ms = new MediaStream([track]);
                    try {
                        const vt = typeof ms.getVideoTracks === 'function' ? ms.getVideoTracks().length : 0;
                        console.debug('[useCompiler] setting mediaStream from synthesized track', { videoTracks: vt });
                    } catch (_) {}
                    setMediaStream(ms);
                } catch (_) {
                    // ignore
                }
            }
        };
        window.addEventListener('synthi:media-track', handleTrack);
        
        const currentStream = client.getMediaStream();
        if (currentStream) {
            setMediaStream(currentStream);
        }

        return () => {
            unsubscribeStatus();
            window.removeEventListener('synthi:media-track', handleTrack);
            if (reconnectTimerRef.current) {
                clearTimeout(reconnectTimerRef.current);
                reconnectTimerRef.current = null;
            }
            // Do not dispose singleton
            clientRef.current = null;
        };
    }, []);

    const compile = useCallback(async (params) => {
        console.log('[useCompiler] Compile requested:', params);
        setIsCompiling(true);
        const client = clientRef.current || getCompilerClient();
        try {
            const result = await client.compile(params);
            console.log('[useCompiler] Compile result:', result);
            return result;
        } catch (e) {
            console.error('[useCompiler] Compile error:', e);
            throw e;
        } finally {
            setIsCompiling(false);
        }
    }, []);

    const cancelMobileJob = useCallback((sessionId) => {
        const client = clientRef.current || getCompilerClient();
        return client.cancelMobileJob(sessionId);
    }, []);

    const client = typeof window !== 'undefined' ? getCompilerClient() : null;

    return {
        client,
        compile,
        cancelMobileJob,
        status,
        isCompiling,
        mediaStream
    };
}
