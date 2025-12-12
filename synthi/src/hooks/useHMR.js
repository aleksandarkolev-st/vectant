import { useEffect, useRef, useState, useCallback } from 'react';
import { HMRRuntime } from '@/lib/hmr-runtime';

/**
 * Enhanced HMR Hook
 * 
 * Provides HMR status tracking with detailed state for UI feedback.
 * Status values:
 * - idle: No HMR activity
 * - check/prepare/dispose/apply: HMR in progress
 * - applied: HMR successfully applied
 * - rejected: HMR failed, keeping old module
 * - full-reload-required: Module requires full page reload
 * - fail: HMR system error
 */
export function useHMR() {
    const runtimeRef = useRef(null);
    const [status, setStatus] = useState('idle');
    const [lastUpdate, setLastUpdate] = useState(null);
    const [hmrHistory, setHmrHistory] = useState([]);

    // Dispatch HMR status event for UI components
    const dispatchHMRStatus = useCallback((statusData) => {
        window.dispatchEvent(new CustomEvent('synthi:hmr-status', {
            detail: statusData
        }));
    }, []);

    useEffect(() => {
        // Initialize runtime
        if (!runtimeRef.current) {
            runtimeRef.current = new HMRRuntime({
                onStatusChange: (newStatus) => {
                    setStatus(newStatus);
                    console.log(`[HMR] Status: ${newStatus}`);
                    
                    // Dispatch status change for UI indicator
                    dispatchHMRStatus({ 
                        type: 'hmr-status',
                        data: { status: newStatus }
                    });
                },
                onReload: () => {
                    console.log('[HMR] Reload requested');
                    // Dispatch reload status before actually reloading
                    dispatchHMRStatus({
                        type: 'hmr-status',
                        data: { status: 'full-reload-required', reason: 'HMR not applicable' }
                    });
                    setTimeout(() => window.location.reload(), 500);
                }
            });
            
            // Expose runtime globally for debugging or direct access if needed
            window.__SYNTHI_HMR_RUNTIME__ = runtimeRef.current;
        }

        const handleHMRMessage = (event) => {
            const message = event.detail;
            if (runtimeRef.current) {
                console.log('[HMR] Received message:', message);
                
                // Track HMR updates in history
                if (message.type === 'update' || message.type === 'hmr-status') {
                    setLastUpdate({
                        timestamp: Date.now(),
                        ...message
                    });
                    setHmrHistory(prev => [...prev.slice(-9), {
                        timestamp: Date.now(),
                        ...message
                    }]);
                }
                
                // Handle hmr-status messages specially for UI feedback
                if (message.type === 'hmr-status') {
                    const statusData = message.data || {};
                    
                    // Map backend status to UI status
                    if (statusData.status === 'applied') {
                        setStatus('applied');
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'rejected') {
                        setStatus('rejected');
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'full-reload-required') {
                        setStatus('full-reload-required');
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'capability-detected') {
                        // Informational - show briefly
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'shim-applied') {
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'compile-error') {
                        setStatus('fail');
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'crash-recovered') {
                        // Runtime crash was caught and recovered
                        setStatus('rejected');
                        dispatchHMRStatus({
                            ...message,
                            data: {
                                ...statusData,
                                status: 'crash-recovered',
                                message: `Plugin crashed (${statusData.signal || 'unknown'}) but recovered. Old module continues.`
                            }
                        });
                    } else if (statusData.status === 'crash-fatal') {
                        // Too many crashes, need full restart
                        setStatus('fail');
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'state-migrated') {
                        // Field-level state migration occurred
                        dispatchHMRStatus({
                            ...message,
                            data: {
                                ...statusData,
                                status: 'applied',
                                message: `State migrated: ${statusData.preserved || 0} fields preserved, ${statusData.reset || 0} reset`
                            }
                        });
                    } else if (statusData.status === 'host-kv-preserved') {
                        // Host KV namespaces preserved
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'host-kv-reset-schema') {
                        // Host KV namespace reset due to schema change
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'boundary-violation') {
                        // Fast Refresh boundary crossed - show warning/error
                        setStatus(statusData.canProceed ? 'check' : 'full-reload-required');
                        dispatchHMRStatus({
                            ...message,
                            data: {
                                ...statusData,
                                message: statusData.summary || 'Fast Refresh boundary crossed'
                            }
                        });
                    } else if (statusData.status === 'widgets-detected') {
                        // Widget-level HMR detected multiple components
                        dispatchHMRStatus({
                            ...message,
                            data: {
                                ...statusData,
                                message: `Detected ${statusData.count} widgets for component-level HMR`
                            }
                        });
                    } else if (statusData.status === 'widget-compiled') {
                        // Individual widget compiled successfully
                        dispatchHMRStatus(message);
                    } else if (statusData.status === 'widgets-compiled') {
                        // Widget compilation summary
                        setStatus('applied');
                        dispatchHMRStatus({
                            ...message,
                            data: {
                                ...statusData,
                                status: 'applied',
                                message: statusData.message || `Widget HMR: ${statusData.loaded} components updated`
                            }
                        });
                    } else if (statusData.status === 'widget-compile-error') {
                        // Individual widget failed to compile
                        dispatchHMRStatus(message);
                    }
                    
                    return; // Don't pass to runtime for these messages
                }
                
                runtimeRef.current.handleMessage(message);
            }
        };

        window.addEventListener('synthi:hmr-update', handleHMRMessage);

        return () => {
            window.removeEventListener('synthi:hmr-update', handleHMRMessage);
        };
    }, [dispatchHMRStatus]);

    return {
        status,
        lastUpdate,
        hmrHistory,
        runtime: runtimeRef.current
    };
}
