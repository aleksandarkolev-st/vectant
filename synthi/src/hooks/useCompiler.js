'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CompilerClient, CompilerStatus, getCompilerClient } from '@/services/compilerClient';

export function useCompiler() {
    const clientRef = useRef(null);
    const [status, setStatus] = useState(CompilerStatus.IDLE);
    const [mediaStream, setMediaStream] = useState(null);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const client = getCompilerClient();
        clientRef.current = client;
        
        setStatus(client.status);

        // Auto-connect if idle so LSP can start
        if (client.status === CompilerStatus.IDLE) {
            client.connect().catch(e => console.error("Auto-connect failed", e));
        }

        const unsubscribeStatus = client.onStatusChange(setStatus);

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
            // Do not dispose singleton
            clientRef.current = null;
        };
    }, []);

    const compile = useCallback(async (params) => {
        console.log('[useCompiler] Compile requested:', params);
        const client = clientRef.current || getCompilerClient();
        try {
            const result = await client.compile(params);
            console.log('[useCompiler] Compile result:', result);
            return result;
        } catch (e) {
            console.error('[useCompiler] Compile error:', e);
            throw e;
        }
    }, []);

    const client = typeof window !== 'undefined' ? getCompilerClient() : null;

    return {
        client,
        compile,
        status,
        mediaStream
    };
}
