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
        color: 'bg-gray-400',
        text: '',
        show: false,
    },
    applied: {
        color: 'bg-green-500',
        text: 'HMR Applied',
        show: true,
        autoHide: 2000,
    },
    'shim-applied': {
        color: 'bg-blue-500',
        text: 'Auto-shim enabled',
        show: true,
        autoHide: 3000,
    },
    check: {
        color: 'bg-yellow-500 animate-pulse',
        text: 'Checking...',
        show: true,
    },
    prepare: {
        color: 'bg-yellow-500 animate-pulse',
        text: 'Preparing...',
        show: true,
    },
    dispose: {
        color: 'bg-yellow-500 animate-pulse',
        text: 'Disposing...',
        show: true,
    },
    apply: {
        color: 'bg-yellow-500 animate-pulse',
        text: 'Applying...',
        show: true,
    },
    'full-reload-required': {
        color: 'bg-orange-500',
        text: 'Full Reload Required',
        show: true,
        autoHide: 4000,
    },
    rejected: {
        color: 'bg-red-500',
        text: 'HMR Failed',
        show: true,
        autoHide: 4000,
    },
    fail: {
        color: 'bg-red-500',
        text: 'HMR Failed',
        show: true,
        autoHide: 4000,
    },
    'compile-error': {
        color: 'bg-red-600',
        text: 'Compile Error',
        show: true,
    },
    'capability-detected': {
        color: 'bg-blue-400',
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
    
    if (!visible || !config.show) {
        return null;
    }

    return (
        <div 
            className={cn(
                "fixed bottom-4 right-4 z-50 flex items-center gap-2 px-3 py-2 rounded-lg shadow-lg bg-gray-900/90 backdrop-blur-sm border border-gray-700 transition-all duration-300 cursor-pointer",
                expanded && "flex-col items-start",
                className
            )}
            onClick={() => setExpanded(!expanded)}
        >
            {/* Status Dot */}
            <div className={cn("w-2 h-2 rounded-full", config.color)} />
            
            {/* Status Text */}
            <span className="text-sm text-gray-200 font-medium">
                {config.text}
            </span>
            
            {/* Expanded Details */}
            {expanded && details && (
                <div className="text-xs text-gray-400 mt-2 space-y-1 max-w-xs">
                    {details.module && (
                        <div>Module: <span className="text-gray-300">{details.module}</span></div>
                    )}
                    {details.capability && (
                        <div>Capability: <span className="text-gray-300">{details.capability}</span></div>
                    )}
                    {details.reason && (
                        <div>Reason: <span className="text-gray-300">{details.reason}</span></div>
                    )}
                    {details.message && (
                        <div>{details.message}</div>
                    )}
                    {details.warnings && details.warnings.length > 0 && (
                        <div className="text-yellow-400">
                            {details.warnings.map((w, i) => (
                                <div key={i}>⚠️ {w}</div>
                            ))}
                        </div>
                    )}
                    {details.state_preserved !== undefined && (
                        <div>
                            State: <span className={details.state_preserved ? "text-green-400" : "text-yellow-400"}>
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
