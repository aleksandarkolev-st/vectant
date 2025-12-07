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
             const { streams } = e.detail;
             if (streams && streams.length > 0) {
                 setMediaStream(streams[0]);
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
