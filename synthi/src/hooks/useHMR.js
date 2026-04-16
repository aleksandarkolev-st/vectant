import { useEffect, useRef, useState, useCallback } from 'react';
import { HMRRuntime, isNativePreviewActive } from '@/lib/hmr-runtime';
import { subscribeAiLoopStatus, getAiLoopStatus, installAiStatusListener } from '@/lib/ai-loop-status';
import { subscribeAdapterStatus, getAdapterStatus, handleAdapterStatusNotification, normalizeAdapterFamily } from '@/lib/adapter-status';
import { subscribeRestoreStatus, getRestoreStatus, installRestoreListener } from '@/lib/state-restore-status';
import { subscribeCandidateTracker, getCurrentCandidate, installCandidateListener } from '@/lib/candidate-tracker';
import { subscribeHealthPanel, getHealthPanel, updateAdapterHealth, setLifecycleState, setAiActive, pushError } from '@/lib/adapter-health-panel';

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

// Maximum number of history entries to keep (prevents memory leaks)
const MAX_HMR_HISTORY_SIZE = 50;

export function useHMR() {
    const runtimeRef = useRef(null);
    const [status, setStatus] = useState('idle');
    const [lastUpdate, setLastUpdate] = useState(null);
    const [hmrHistory, setHmrHistory] = useState([]);
    // Track mounted state to prevent updates after unmount
    const isMountedRef = useRef(true);
    // Loop guard: handleHMRMessage listens on synthi:hmr-status AND
    // dispatchHMRStatus emits on synthi:hmr-status. Without this set
    // we'd re-enter the handler on every status message and recurse
    // until the stack overflows. We add each CustomEvent we emit to
    // this WeakSet and the listener early-returns on membership.
    const ownDispatchedEvents = useRef(new WeakSet());

    // New subsystem states from HMR pipeline stores
    const [aiLoopStatus, setAiLoopStatus] = useState(getAiLoopStatus);
    const [adapterStatus, setAdapterStatus] = useState(getAdapterStatus);
    const [restoreStatus, setRestoreStatus] = useState(getRestoreStatus);
    const [candidateState, setCandidateState] = useState(getCurrentCandidate);
    const [healthPanel, setHealthPanel] = useState(getHealthPanel);

    // Dispatch HMR status event for UI components
    const dispatchHMRStatus = useCallback((statusData) => {
        if (typeof window !== 'undefined') {
            const ev = new CustomEvent('synthi:hmr-status', {
                detail: statusData
            });
            ownDispatchedEvents.current.add(ev);
            window.dispatchEvent(ev);
        }
    }, []);

    useEffect(() => {
        isMountedRef.current = true;
        
        // Initialize runtime
        if (!runtimeRef.current) {
            runtimeRef.current = new HMRRuntime({
                onStatusChange: (newStatus) => {
                    // SAFETY: Check if still mounted before state updates
                    if (!isMountedRef.current) return;
                    
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
                    if (isNativePreviewActive()) {
                        console.log('[HMR] Native preview is active; skipping browser reload');
                        return;
                    }
                    // Dispatch reload status before actually reloading
                    dispatchHMRStatus({
                        type: 'hmr-status',
                        data: { status: 'full-reload-required', reason: 'HMR not applicable' }
                    });
                    setTimeout(() => window.location.reload(), 500);
                }
            });
            
            // Expose runtime globally for debugging or direct access if needed
            if (typeof window !== 'undefined') {
                window.__SYNTHI_HMR_RUNTIME__ = runtimeRef.current;
            }
        }

        const handleHMRMessage = (event) => {
            // SAFETY: Check if still mounted
            if (!isMountedRef.current) return;
            // SAFETY: Skip events this hook just dispatched, otherwise
            // dispatchHMRStatus → synthi:hmr-status → handleHMRMessage
            // forms an infinite loop for any hmr-status branch.
            if (ownDispatchedEvents.current.has(event)) return;

            const message = event.detail;
            if (runtimeRef.current) {
                console.log('[HMR] Received message:', message);
                
                // Track HMR updates in history with bounded size
                if (message.type === 'update' || message.type === 'hmr-status') {
                    const newEntry = {
                        timestamp: Date.now(),
                        ...message
                    };
                    setLastUpdate(newEntry);
                    // SAFETY: Bound history size to prevent memory leaks
                    setHmrHistory(prev => {
                        const updated = [...prev, newEntry];
                        // Keep only the most recent entries
                        return updated.length > MAX_HMR_HISTORY_SIZE 
                            ? updated.slice(-MAX_HMR_HISTORY_SIZE) 
                            : updated;
                    });
                }
                
                // Handle hmr-status messages specially for UI feedback.
                // Messages arrive in two shapes depending on source:
                //   1. {type:'hmr-status', data:{status:'applied'}} (from onStatusChange callback)
                //   2. {type:'hmr-status', status:'reload-planned', ...} (from planner/worker)
                //   3. {status:'applied', ...} (direct status object from runner stderr)
                // Normalize to extract the status string consistently.
                if (message.type === 'hmr-status' || (message.status && !message.type)) {
                    const statusData = message.data || message;
                    
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
                    } else if (statusData.status === 'reload-planned') {
                        // HMR planner decided reload strategy
                        dispatchHMRStatus({
                            ...message,
                            data: {
                                ...statusData,
                                message: statusData.user_message || `Reload: ${statusData.decision} (${statusData.decision_reason})`
                            }
                        });
                    } else if (statusData.status === 'ai-gated') {
                        // AI gate blocked an AI call in Loop A
                        dispatchHMRStatus(message);
                    }
                    
                    return; // Don't pass to runtime for these messages
                }
                
                runtimeRef.current.handleMessage(message);
            }
        };

        window.addEventListener('synthi:hmr-update', handleHMRMessage);
        window.addEventListener('synthi:hmr-status', handleHMRMessage);

        // ── Subscribe to HMR pipeline stores ──
        const unsubAi = subscribeAiLoopStatus((s) => {
            if (isMountedRef.current) setAiLoopStatus(s);
        });
        const unsubAdapter = subscribeAdapterStatus((s) => {
            if (isMountedRef.current) setAdapterStatus(s);
        });
        const unsubRestore = subscribeRestoreStatus((s) => {
            if (isMountedRef.current) setRestoreStatus(s);
        });
        const unsubCandidate = subscribeCandidateTracker((s) => {
            if (isMountedRef.current) setCandidateState(s);
        });
        const unsubHealth = subscribeHealthPanel((s) => {
            if (isMountedRef.current) setHealthPanel(s);
        });

        // Install window event listeners that feed the stores
        const cleanupAiListener = installAiStatusListener();
        const cleanupRestoreListener = installRestoreListener();
        const cleanupCandidateListener = installCandidateListener();

        // Adapter status events: feed into the adapter-status store
        const handleAdapterEvent = (e) => {
            const payload = e.detail?.data || e.detail;
            if (payload) handleAdapterStatusNotification(payload);
        };
        window.addEventListener('synthi:adapter-status', handleAdapterEvent);

        // Adapter health events: feed into the health panel store
        const handleHealthEvent = (e) => {
            const d = e.detail?.data || e.detail;
            if (!d) return;
            const family = normalizeAdapterFamily(d.family);
            if (family && family !== 'none') {
                updateAdapterHealth(family, {
                    active: d.active,
                    health: d.health,
                    reloads: d.reloads,
                    lastMs: d.last_ms,
                });
            }
            if (d.lifecycle_state) setLifecycleState(d.lifecycle_state);
            if (d.ai_active != null) setAiActive(d.ai_active);
            if (d.error) pushError(d.error);
        };
        window.addEventListener('synthi:adapter-health', handleHealthEvent);

        return () => {
            // SAFETY: Mark as unmounted to prevent state updates after cleanup
            isMountedRef.current = false;
            window.removeEventListener('synthi:hmr-update', handleHMRMessage);
            window.removeEventListener('synthi:hmr-status', handleHMRMessage);
            window.removeEventListener('synthi:adapter-status', handleAdapterEvent);
            window.removeEventListener('synthi:adapter-health', handleHealthEvent);
            unsubAi();
            unsubAdapter();
            unsubRestore();
            unsubCandidate();
            unsubHealth();
            cleanupAiListener();
            cleanupRestoreListener();
            cleanupCandidateListener();
        };
    }, [dispatchHMRStatus]);

    return {
        status,
        lastUpdate,
        hmrHistory,
        runtime: runtimeRef.current,
        // HMR pipeline subsystem states
        aiLoopStatus,
        adapterStatus,
        restoreStatus,
        candidateState,
        healthPanel,
    };
}
