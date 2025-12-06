import { useEffect, useRef, useState } from 'react';
import { HMRRuntime } from '@/lib/hmr-runtime';

export function useHMR() {
    const runtimeRef = useRef(null);
    const [status, setStatus] = useState('idle');

    useEffect(() => {
        // Initialize runtime
        if (!runtimeRef.current) {
            runtimeRef.current = new HMRRuntime({
                onStatusChange: (newStatus) => {
                    setStatus(newStatus);
                    console.log(`[HMR] Status: ${newStatus}`);
                },
                onReload: () => {
                    console.log('[HMR] Reload requested');
                    window.location.reload();
                }
            });
            
            // Expose runtime globally for debugging or direct access if needed
            window.__SYNTHI_HMR_RUNTIME__ = runtimeRef.current;
        }

        const handleHMRMessage = (event) => {
            const message = event.detail;
            if (runtimeRef.current) {
                console.log('[HMR] Received message:', message);
                runtimeRef.current.handleMessage(message);
            }
        };

        window.addEventListener('synthi:hmr-update', handleHMRMessage);

        return () => {
            window.removeEventListener('synthi:hmr-update', handleHMRMessage);
        };
    }, []);

    return {
        status,
        runtime: runtimeRef.current
    };
}
