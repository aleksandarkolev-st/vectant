"use client";

import { useState, useEffect, useCallback } from 'react';
import { cn } from '@/lib/utils';

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

export function HMRStatusIndicator({ className }) {
    const [status, setStatus] = useState('idle');
    const [details, setDetails] = useState(null);
    const [visible, setVisible] = useState(false);
    const [expanded, setExpanded] = useState(false);

    const handleHMRStatus = useCallback((event) => {
        const data = event.detail?.data || event.detail;
        const statusKey = data?.status || 'idle';
        
        console.log('[HMRStatusIndicator] Received status:', statusKey, data);
        
        setStatus(statusKey);
        setDetails(data);
        setVisible(true);
        
        const config = STATUS_CONFIGS[statusKey] || STATUS_CONFIGS.idle;
        if (config.autoHide) {
            setTimeout(() => {
                setVisible(false);
                setExpanded(false);
            }, config.autoHide);
        }
    }, []);

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
                </div>
            )}
        </div>
    );
}

export default HMRStatusIndicator;
