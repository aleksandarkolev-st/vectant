"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { PreviewLifecycleState } from '@/lib/preview-lifecycle';
import { getPreviewState, subscribePreviewStore, isPreviewBusy, isPreviewError } from '@/lib/preview-store';

/**
 * HMR Status Indicator
 * 
 * Displays the current Hot Module Replacement status in a small, unobtrusive
 * indicator similar to Next.js's HMR feedback. Shows status for:
 * - HMR applied successfully (green)
 * - HMR in progress (yellow pulse)
 * - Full reload required (orange)
 * - HMR failed/rejected (red)
 * - Shim applied (blue)
 */

const STATUS_CONFIGS = {
    idle: {
        color: 'bg-[#71717a]',
        text: '',
        show: false,
    },
    compiling: {
        color: 'bg-[#eab308] animate-pulse',
        text: 'Compiling...',
        show: true,
        // No autoHide - will be replaced by compile result
    },
    applied: {
        color: 'bg-[#22c55e]',
        text: 'HMR Applied',
        show: true,
        autoHide: 2000,
    },
    'shim-applied': {
        color: 'bg-[#327464]',
        text: 'Auto-shim enabled',
        show: true,
        autoHide: 3000,
    },
    'state-migrated': {
        color: 'bg-[#22c55e]',
        text: 'State Migrated',
        show: true,
        autoHide: 3000,
    },
    'crash-recovered': {
        color: 'bg-[#f97316]',
        text: 'Crash Recovered',
        show: true,
        autoHide: 5000,
    },
    'crash-fatal': {
        color: 'bg-[#ef4444]',
        text: 'Fatal Crash - Restart Required',
        show: true,
    },
    'host-kv-preserved': {
        color: 'bg-[#3d8b78]',
        text: 'State Preserved',
        show: true,
        autoHide: 2000,
    },
    'host-kv-reset-schema': {
        color: 'bg-[#eab308]',
        text: 'Schema Changed - Namespace Reset',
        show: true,
        autoHide: 4000,
    },
    // Fast Refresh boundary statuses
    'boundary-violation': {
        color: 'bg-[#f97316]',
        text: 'Fast Refresh Boundary Crossed',
        show: true,
        autoHide: 5000,
    },
    // Widget-level HMR statuses
    'widgets-detected': {
        color: 'bg-[#327464]',
        text: 'Widgets Detected',
        show: true,
        autoHide: 2000,
    },
    'widget-compiled': {
        color: 'bg-[#3d8b78]',
        text: 'Widget Updated',
        show: true,
        autoHide: 1500,
    },
    'widgets-compiled': {
        color: 'bg-[#3d8b78]',
        text: 'Widget HMR Complete',
        show: true,
        autoHide: 2500,
    },
    'widget-compile-error': {
        color: 'bg-[#ef4444]',
        text: 'Widget Compile Error',
        show: true,
        autoHide: 4000,
    },
    check: {
        color: 'bg-[#eab308] animate-pulse',
        text: 'Checking...',
        show: true,
    },
    prepare: {
        color: 'bg-[#eab308] animate-pulse',
        text: 'Preparing...',
        show: true,
    },
    dispose: {
        color: 'bg-[#eab308] animate-pulse',
        text: 'Disposing...',
        show: true,
    },
    apply: {
        color: 'bg-[#eab308] animate-pulse',
        text: 'Applying...',
        show: true,
    },
    'reload-planned': {
        color: 'bg-[#0ea5a4]',
        text: 'Reload Planned',
        show: true,
        autoHide: 3000,
    },
    'full-reload-required': {
        color: 'bg-[#f97316]',
        text: 'Full Reload Required',
        show: true,
        autoHide: 4000,
    },
    rejected: {
        color: 'bg-[#ef4444]',
        text: 'HMR Failed',
        show: true,
        autoHide: 4000,
    },
    fail: {
        color: 'bg-[#ef4444]',
        text: 'HMR Failed',
        show: true,
        autoHide: 4000,
    },
    'compile-error': {
        color: 'bg-[#ef4444]',
        text: 'Compile Error',
        show: true,
        // No autoHide - user needs to see this
    },
    'compile-warning': {
        color: 'bg-[#eab308]',
        text: 'Compiled with Warnings',
        show: true,
        autoHide: 4000,
    },
    'capability-detected': {
        color: 'bg-[#327464]',
        text: 'Module Analyzed',
        show: true,
        autoHide: 2000,
    },
};

export function HMRStatusIndicator({ className, pipelineState = null }) {
    const [status, setStatus] = useState('idle');
    const [details, setDetails] = useState(null);
    const [visible, setVisible] = useState(false);
    const [expanded, setExpanded] = useState(false);
    const hideTimerRef = useRef(null);
    const gpuHmrStatus = pipelineState?.gpuHmrStatus;

    const scheduleAutoHide = useCallback((delay) => {
        if (hideTimerRef.current) {
            clearTimeout(hideTimerRef.current);
        }
        if (!delay) {
            hideTimerRef.current = null;
            return;
        }
        hideTimerRef.current = setTimeout(() => {
            setVisible(false);
            setExpanded(false);
            hideTimerRef.current = null;
        }, delay);
    }, []);

    const handleHMRStatus = useCallback((event) => {
        const data = event.detail?.data || event.detail;
        const statusKey = data?.status || 'idle';
        
        console.log('[HMRStatusIndicator] Received status:', statusKey, data);
        
        setStatus(statusKey);
        setDetails(data);
        setVisible(true);
        
        const config = STATUS_CONFIGS[statusKey] || STATUS_CONFIGS.idle;
        scheduleAutoHide(config.autoHide);
    }, [scheduleAutoHide]);

    useEffect(() => {
        // Listen for HMR status events from the compiler
        const handleMessage = (event) => {
            if (event.detail?.type === 'hmr-status') {
                handleHMRStatus(event);
            }
        };
        
        window.addEventListener('synthi:hmr-update', handleMessage);
        window.addEventListener('synthi:hmr-status', handleHMRStatus);
        
        return () => {
            window.removeEventListener('synthi:hmr-update', handleMessage);
            window.removeEventListener('synthi:hmr-status', handleHMRStatus);
        };
    }, [handleHMRStatus]);

    useEffect(() => {
        return () => {
            if (hideTimerRef.current) {
                clearTimeout(hideTimerRef.current);
            }
        };
    }, []);

    useEffect(() => {
        const gpuStatus = gpuHmrStatus;
        if (!gpuStatus?.lastUpdatedAt) return;

        if (gpuStatus.lastEvent === 'runtime' && gpuStatus.runtimeError) {
            setStatus('compile-error');
            setDetails({
                status: 'compile-error',
                message: `GPU runtime: ${gpuStatus.runtimeError.kind || 'unknown'}`,
            });
            setVisible(true);
            scheduleAutoHide(null);
            return;
        }

        if (gpuStatus.lastEvent === 'ptxas' && gpuStatus.ptxas) {
            setStatus('compile-warning');
            setDetails({
                status: 'compile-warning',
                message: 'GPU toolchain diagnostics',
            });
            setVisible(true);
            scheduleAutoHide(STATUS_CONFIGS['compile-warning'].autoHide);
            return;
        }

        if (gpuStatus.lastEvent === 'reload' || gpuStatus.lastEvent === 'snapshot') {
            setStatus('reload-planned');
            setDetails({
                status: 'reload-planned',
                reason: gpuStatus.reloadReason || gpuStatus.reloadPlan || 'gpu-reload',
            });
            setVisible(true);
            scheduleAutoHide(STATUS_CONFIGS['reload-planned'].autoHide);
        }
    }, [gpuHmrStatus, scheduleAutoHide]);

    // Subscribe to preview store for compiled-preview lifecycle states.
    // This drives the indicator for native compiled previews alongside
    // the legacy event-based status above.
    useEffect(() => {
        function deriveStatus(previewState) {
            const s = previewState.state;
            if (s === PreviewLifecycleState.COMPILING) {
                setStatus('compiling');
                setDetails({ module: previewState.language });
                setVisible(true);
            } else if (s === PreviewLifecycleState.COMPILE_FAILED) {
                setStatus('compile-error');
                setDetails(previewState.buildDiagnostics || {});
                setVisible(true);
                scheduleAutoHide(null);
            } else if (s === PreviewLifecycleState.RELOAD_PLANNED) {
                setStatus('reload-planned');
                setDetails({
                    decision: previewState.plannerDecision,
                    reasonBundle: previewState.reasonBundle || null,
                });
                setVisible(true);
                scheduleAutoHide(STATUS_CONFIGS['reload-planned'].autoHide);
            } else if (s === PreviewLifecycleState.RELOAD_APPLYING) {
                setStatus('apply');
                setDetails({ decision: previewState.plannerDecision });
                setVisible(true);
                scheduleAutoHide(null);
            } else if (s === PreviewLifecycleState.RELOAD_APPLIED) {
                setStatus('applied');
                setDetails({ state_preserved: true, ...(previewState.stateSummary || {}) });
                setVisible(true);
                scheduleAutoHide(2000);
            } else if (s === PreviewLifecycleState.RELOAD_ROLLED_BACK) {
                setStatus('rejected');
                setDetails({ reason: previewState.rollbackReason });
                setVisible(true);
                scheduleAutoHide(STATUS_CONFIGS.rejected.autoHide);
            } else if (s === PreviewLifecycleState.CRASH_RECOVERED) {
                setStatus('crash-recovered');
                setDetails({});
                setVisible(true);
                scheduleAutoHide(5000);
            } else if (s === PreviewLifecycleState.CRASH_FATAL) {
                setStatus('crash-fatal');
                setDetails({});
                setVisible(true);
                scheduleAutoHide(null);
            } else if (s === PreviewLifecycleState.FULL_RESTART) {
                setStatus('full-reload-required');
                setDetails({});
                setVisible(true);
                scheduleAutoHide(STATUS_CONFIGS['full-reload-required'].autoHide);
            }
        }

        deriveStatus(getPreviewState());
        return subscribePreviewStore(deriveStatus);
    }, [scheduleAutoHide]);

    const config = STATUS_CONFIGS[status] || STATUS_CONFIGS.idle;
    
    // Build display text, adding counts if available
    let displayText = config.text;
    if (details?.errorCount !== undefined && details.errorCount > 0) {
        displayText = `${details.errorCount} Error${details.errorCount > 1 ? 's' : ''}`;
        if (details.warningCount > 0) {
            displayText += `, ${details.warningCount} Warning${details.warningCount > 1 ? 's' : ''}`;
        }
    } else if (details?.warningCount > 0 && status === 'compile-warning') {
        displayText = `${details.warningCount} Warning${details.warningCount > 1 ? 's' : ''}`;
    }
    
    if (!visible || !config.show) {
        return null;
    }

    const pipelineDetails = pipelineState ? {
        adapterFamily: pipelineState.adapterStatus?.adapterFamily,
        adapterHealth: pipelineState.adapterStatus?.health,
        restorePhase: pipelineState.restoreStatus?.phase,
        restoreStrategy: pipelineState.restoreStatus?.strategy,
        candidatePhase: pipelineState.candidateState?.phase,
        candidateGeneration: pipelineState.candidateState?.generation,
        aiCircuitState: pipelineState.aiLoopStatus?.circuitState,
        aiRequestPhase: pipelineState.aiLoopStatus?.requestPhase,
        overallHealth: pipelineState.healthPanel?.overallHealth,
        healthErrors: pipelineState.healthPanel?.errors || [],
        gpuHmrStatus,
        historyCount: pipelineState.hmrHistory?.length || 0,
        lastUpdateAt: pipelineState.lastUpdate?.timestamp || null,
    } : null;

    return (
        <div 
            className={cn(
                "fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded shadow-lg bg-[#09090b]/95 backdrop-blur-sm border border-[#1a1a1e] transition-all duration-300 cursor-pointer",
                expanded && "flex-col items-start",
                className
            )}
            onClick={() => setExpanded(!expanded)}
        >
            {/* Status Dot */}
            <div className={cn("w-2.5 h-2.5 rounded-full", config.color)} />
            
            {/* Status Text */}
            <span className="text-sm text-[#fafafa] font-medium">
                {displayText}
            </span>
            
            {/* Expanded Details */}
            {expanded && details && (
                <div className="text-xs text-[#71717a] mt-2 space-y-1 max-w-xs">
                    {details.module && (
                        <div>Module: <span className="text-[#a1a1aa]">{details.module}</span></div>
                    )}
                    {details.capability && (
                        <div>Capability: <span className="text-[#a1a1aa]">{details.capability}</span></div>
                    )}
                    {details.reason && (
                        <div>Reason: <span className="text-[#a1a1aa]">{details.reason}</span></div>
                    )}
                    {details.reasonBundle?.decision_reason && (
                        <div>Planner: <span className="text-[#a1a1aa]">{details.reasonBundle.decision_reason}</span></div>
                    )}
                    {details.message && (
                        <div>{details.message}</div>
                    )}
                    {details.warnings && details.warnings.length > 0 && (
                        <div className="text-[#eab308]">
                            {details.warnings.map((w, i) => (
                                <div key={i}>⚠️ {w}</div>
                            ))}
                        </div>
                    )}
                    {details.state_preserved !== undefined && (
                        <div>
                            State: <span className={details.state_preserved ? "text-[#22c55e]" : "text-[#eab308]"}>
                                {details.state_preserved ? "Preserved" : "Reset"}
                            </span>
                        </div>
                    )}
                    {pipelineDetails?.adapterFamily && pipelineDetails.adapterFamily !== 'none' && (
                        <div>Adapter: <span className="text-[#a1a1aa]">{pipelineDetails.adapterFamily} ({pipelineDetails.adapterHealth || 'unknown'})</span></div>
                    )}
                    {pipelineDetails?.restorePhase && pipelineDetails.restorePhase !== 'idle' && (
                        <div>Restore: <span className="text-[#a1a1aa]">{pipelineDetails.restorePhase}{pipelineDetails.restoreStrategy ? ` (${pipelineDetails.restoreStrategy})` : ''}</span></div>
                    )}
                    {pipelineDetails?.gpuHmrStatus?.reloadPlan && (
                        <div>GPU Reload: <span className="text-[#a1a1aa]">{pipelineDetails.gpuHmrStatus.reloadPlan}{pipelineDetails.gpuHmrStatus.reloadReason ? ` (${pipelineDetails.gpuHmrStatus.reloadReason})` : ''}</span></div>
                    )}
                    {pipelineDetails?.gpuHmrStatus?.snapshotTier && (
                        <div>
                            GPU Snapshot: <span className="text-[#a1a1aa]">
                                tier {pipelineDetails.gpuHmrStatus.snapshotTier}
                                {pipelineDetails.gpuHmrStatus.snapshotMs != null ? `, ${pipelineDetails.gpuHmrStatus.snapshotMs} ms` : ''}
                                {pipelineDetails.gpuHmrStatus.snapshotBytes != null ? `, ${pipelineDetails.gpuHmrStatus.snapshotBytes} bytes` : ''}
                                {pipelineDetails.gpuHmrStatus.snapshotBudgetMs != null ? `, budget ${pipelineDetails.gpuHmrStatus.snapshotBudgetMs} ms` : ''}
                            </span>
                        </div>
                    )}
                    {pipelineDetails?.gpuHmrStatus?.ptxas && (
                        <div>
                            PTXAS: <span className="text-[#a1a1aa]">
                                {pipelineDetails.gpuHmrStatus.ptxas.registers != null ? `${pipelineDetails.gpuHmrStatus.ptxas.registers} regs` : 'registers unknown'}
                                {pipelineDetails.gpuHmrStatus.ptxas.spillBytes != null ? `, ${pipelineDetails.gpuHmrStatus.ptxas.spillBytes} B spill` : ''}
                            </span>
                        </div>
                    )}
                    {pipelineDetails?.gpuHmrStatus?.runtimeError && (
                        <div>GPU Runtime: <span className="text-[#ef4444]">{pipelineDetails.gpuHmrStatus.runtimeError.kind || 'unknown'}</span></div>
                    )}
                    {pipelineDetails?.candidatePhase && pipelineDetails.candidateGeneration > 0 && (
                        <div>Candidate: <span className="text-[#a1a1aa]">g{pipelineDetails.candidateGeneration} {pipelineDetails.candidatePhase}</span></div>
                    )}
                    {pipelineDetails?.aiRequestPhase && pipelineDetails.aiRequestPhase !== 'idle' && (
                        <div>AI Loop: <span className="text-[#a1a1aa]">{pipelineDetails.aiCircuitState || 'closed'} / {pipelineDetails.aiRequestPhase}</span></div>
                    )}
                    {pipelineDetails?.overallHealth && pipelineDetails.overallHealth !== 'unknown' && (
                        <div>Health: <span className="text-[#a1a1aa]">{pipelineDetails.overallHealth}</span></div>
                    )}
                    {pipelineDetails?.historyCount > 0 && (
                        <div>Updates: <span className="text-[#a1a1aa]">{pipelineDetails.historyCount}</span></div>
                    )}
                    {pipelineDetails?.lastUpdateAt && (
                        <div>Last Update: <span className="text-[#a1a1aa]">{new Date(pipelineDetails.lastUpdateAt).toLocaleTimeString()}</span></div>
                    )}
                    {pipelineDetails?.healthErrors?.length > 0 && (
                        <div className="text-[#ef4444]">{pipelineDetails.healthErrors[pipelineDetails.healthErrors.length - 1]}</div>
                    )}
                </div>
            )}
        </div>
    );
}

export default HMRStatusIndicator;
