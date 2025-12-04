'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { CompilerClient, CompilerStatus } from '@/services/compilerClient';

export function useCompiler() {
    const clientRef = useRef(null);
    const [status, setStatus] = useState(CompilerStatus.IDLE);
    const [mediaStream, setMediaStream] = useState(null);

    useEffect(() => {
        if (typeof window === 'undefined') return;

        const client = new CompilerClient();
        clientRef.current = client;

        const unsubscribeStatus = client.onStatusChange(setStatus);

        const handleTrack = (e) => {
             const { streams } = e.detail;
             if (streams && streams.length > 0) {
                 setMediaStream(streams[0]);
             }
        };
        window.addEventListener('synthi:media-track', handleTrack);

        return () => {
            unsubscribeStatus();
            window.removeEventListener('synthi:media-track', handleTrack);
            client.dispose();
            clientRef.current = null;
        };
    }, []);

    const compile = useCallback(async (params) => {
        if (!clientRef.current) {
            throw new Error('Compiler client not initialized');
        }
        return clientRef.current.compile(params);
    }, []);

    return {
        compile,
        status,
        mediaStream
    };
}
