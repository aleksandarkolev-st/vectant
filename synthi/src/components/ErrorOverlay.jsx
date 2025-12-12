"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { X, ChevronDown, ChevronRight, AlertCircle, AlertTriangle, Info, Lightbulb, Copy, Check } from 'lucide-react';

/**
 * Error Overlay Component
 * 
 * Displays compile/runtime errors in a Next.js-style full-screen overlay.
 * Shows source code snippets, file:line info, suggestions, and allows dismiss.
 */

const SEVERITY_CONFIGS = {
    error: {
        icon: AlertCircle,
        color: 'text-red-400',
        bgColor: 'bg-red-500/10',
        borderColor: 'border-red-500/30',
        label: 'Error',
    },
    warning: {
        icon: AlertTriangle,
        color: 'text-yellow-400',
        bgColor: 'bg-yellow-500/10',
        borderColor: 'border-yellow-500/30',
        label: 'Warning',
    },
    note: {
        icon: Info,
        color: 'text-blue-400',
        bgColor: 'bg-blue-500/10',
        borderColor: 'border-blue-500/30',
        label: 'Note',
    },
    help: {
        icon: Lightbulb,
        color: 'text-green-400',
        bgColor: 'bg-green-500/10',
        borderColor: 'border-green-500/30',
        label: 'Help',
    },
    info: {
        icon: Info,
        color: 'text-gray-400',
        bgColor: 'bg-gray-500/10',
        borderColor: 'border-gray-500/30',
        label: 'Info',
    },
};

// Code snippet component with line highlighting
function CodeSnippet({ code, highlightLine, startLine = 1, language = 'cpp' }) {
    const lines = code.split('\n');
    
    return (
        <div className="font-mono text-sm bg-gray-950 rounded-lg overflow-hidden border border-gray-800">
            <div className="overflow-x-auto">
                <table className="w-full">
                    <tbody>
                        {lines.map((line, idx) => {
                            const lineNum = startLine + idx;
                            const isHighlighted = lineNum === highlightLine;
                            return (
                                <tr 
                                    key={idx}
                                    className={cn(
                                        "hover:bg-gray-800/50",
                                        isHighlighted && "bg-red-500/20"
                                    )}
                                >
                                    <td className={cn(
                                        "px-3 py-0.5 text-right select-none border-r border-gray-800 text-gray-500",
                                        isHighlighted && "text-red-400 bg-red-500/10"
                                    )}>
                                        {lineNum}
                                    </td>
                                    <td className={cn(
                                        "px-4 py-0.5 whitespace-pre",
                                        isHighlighted && "text-red-200"
                                    )}>
                                        {line || ' '}
                                    </td>
                                </tr>
                            );
                        })}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// Single diagnostic display
function DiagnosticCard({ diagnostic, isExpanded, onToggle, onGoToFile }) {
    const [copied, setCopied] = useState(false);
    const severity = diagnostic.severity?.toLowerCase() || 'error';
    const config = SEVERITY_CONFIGS[severity] || SEVERITY_CONFIGS.error;
    const Icon = config.icon;
    
    const location = diagnostic.location;
    const locationString = location 
        ? `${location.file}:${location.line}:${location.column}`
        : null;
    
    const handleCopy = useCallback(() => {
        const text = `${locationString || ''}: ${diagnostic.message}`;
        navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    }, [locationString, diagnostic.message]);
    
    const handleGoToFile = useCallback(() => {
        if (location && onGoToFile) {
            onGoToFile(location.file, location.line, location.column);
        }
    }, [location, onGoToFile]);
    
    return (
        <div className={cn(
            "rounded-lg border",
            config.bgColor,
            config.borderColor
        )}>
            {/* Header */}
            <div 
                className="flex items-center gap-3 p-4 cursor-pointer hover:bg-white/5"
                onClick={onToggle}
            >
                <button className="text-gray-400 hover:text-white">
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <Icon className={cn("w-5 h-5", config.color)} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className={cn("text-xs font-semibold uppercase", config.color)}>
                            {config.label}
                        </span>
                        {diagnostic.code && (
                            <span className="text-xs text-gray-500 font-mono">
                                [{diagnostic.code}]
                            </span>
                        )}
                    </div>
                    <p className="text-white mt-1 break-words">{diagnostic.message}</p>
                </div>
                <div className="flex items-center gap-2">
                    <button 
                        onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                        className="p-1.5 rounded hover:bg-white/10 text-gray-400 hover:text-white"
                        title="Copy error"
                    >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                    </button>
                </div>
            </div>
            
            {/* Location */}
            {locationString && (
                <div className="px-4 pb-2 -mt-2">
                    <button
                        onClick={handleGoToFile}
                        className="text-sm text-blue-400 hover:text-blue-300 hover:underline font-mono"
                    >
                        {locationString}
                    </button>
                </div>
            )}
            
            {/* Expanded content */}
            {isExpanded && (
                <div className="px-4 pb-4 space-y-3">
                    {/* Code snippet */}
                    {diagnostic.codeSnippet && (
                        <CodeSnippet 
                            code={diagnostic.codeSnippet}
                            highlightLine={location?.line}
                            startLine={diagnostic.snippetStartLine || Math.max(1, (location?.line || 1) - 2)}
                        />
                    )}
                    
                    {/* Suggestions */}
                    {diagnostic.suggestions && diagnostic.suggestions.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-sm text-gray-400">Suggested fixes:</p>
                            {diagnostic.suggestions.map((suggestion, idx) => (
                                <div key={idx} className="bg-green-500/10 border border-green-500/30 rounded p-3">
                                    <p className="text-sm text-green-400">{suggestion.message}</p>
                                    {suggestion.replacement && (
                                        <pre className="mt-2 text-sm text-green-200 font-mono bg-gray-950 p-2 rounded overflow-x-auto">
                                            {suggestion.replacement}
                                        </pre>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    
                    {/* Related diagnostics */}
                    {diagnostic.related && diagnostic.related.length > 0 && (
                        <div className="space-y-2 pl-4 border-l-2 border-gray-700">
                            {diagnostic.related.map((related, idx) => (
                                <div key={idx} className="text-sm">
                                    <span className="text-gray-400">
                                        {related.location && (
                                            <span className="font-mono text-blue-400">
                                                {related.location.file}:{related.location.line}:{related.location.column}:{' '}
                                            </span>
                                        )}
                                        {related.message}
                                    </span>
                                </div>
                            ))}
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}

// Crash info display for runtime errors
function CrashInfoCard({ crashInfo, onDismiss }) {
    return (
        <div className="bg-red-900/20 border border-red-500/50 rounded-lg p-4">
            <div className="flex items-start gap-3">
                <AlertCircle className="w-6 h-6 text-red-400 flex-shrink-0 mt-0.5" />
                <div className="flex-1">
                    <h3 className="text-lg font-semibold text-red-400">
                        Runtime Crash: {crashInfo.signal_name || 'Unknown Signal'}
                    </h3>
                    <p className="text-gray-300 mt-1">
                        Module <span className="font-mono text-yellow-400">{crashInfo.module_name}</span> crashed
                        {crashInfo.address && (
                            <span className="text-gray-500"> at address 0x{crashInfo.address.toString(16)}</span>
                        )}
                    </p>
                    
                    {/* Source location if available */}
                    {crashInfo.source_location && (
                        <div className="mt-3 bg-gray-950 rounded p-3 font-mono text-sm">
                            <span className="text-blue-400">
                                {crashInfo.source_location.file}:{crashInfo.source_location.line}
                                {crashInfo.source_location.column > 0 && `:${crashInfo.source_location.column}`}
                            </span>
                            {crashInfo.source_location.function && (
                                <span className="text-gray-400"> in </span>
                            )}
                            {crashInfo.source_location.function && (
                                <span className="text-yellow-400">{crashInfo.source_location.function}</span>
                            )}
                        </div>
                    )}
                    
                    {/* Stack frames */}
                    {crashInfo.source_frames && crashInfo.source_frames.length > 0 && (
                        <div className="mt-3">
                            <p className="text-sm text-gray-400 mb-2">Stack trace:</p>
                            <div className="bg-gray-950 rounded p-3 font-mono text-xs space-y-1 max-h-48 overflow-y-auto">
                                {crashInfo.source_frames.map((frame, idx) => (
                                    <div key={idx} className="text-gray-300">
                                        <span className="text-gray-500">{idx}:</span>{' '}
                                        <span className="text-blue-400">
                                            {frame.file}:{frame.line}
                                        </span>
                                        {frame.function && (
                                            <>
                                                <span className="text-gray-500"> in </span>
                                                <span className="text-yellow-400">{frame.function}</span>
                                            </>
                                        )}
                                    </div>
                                ))}
                            </div>
                        </div>
                    )}
                    
                    {/* Raw backtrace fallback */}
                    {!crashInfo.source_frames?.length && crashInfo.backtrace && (
                        <details className="mt-3">
                            <summary className="text-sm text-gray-400 cursor-pointer hover:text-gray-300">
                                Raw backtrace
                            </summary>
                            <pre className="mt-2 bg-gray-950 rounded p-3 text-xs text-gray-400 overflow-x-auto max-h-48 overflow-y-auto">
                                {crashInfo.backtrace}
                            </pre>
                        </details>
                    )}
                    
                    <p className="mt-3 text-sm text-green-400">
                        ✓ Old module continues running. Fix the issue and save to retry.
                    </p>
                </div>
            </div>
        </div>
    );
}

export function ErrorOverlay({ className }) {
    const [visible, setVisible] = useState(false);
    const [diagnostics, setDiagnostics] = useState([]);
    const [crashInfo, setCrashInfo] = useState(null);
    const [module, setModule] = useState('');
    const [expandedIds, setExpandedIds] = useState(new Set([0])); // First error expanded by default
    const overlayRef = useRef(null);
    
    // Handle compile diagnostics
    const handleCompileDiagnostics = useCallback((event) => {
        const data = event.detail?.data || event.detail;
        console.log('[ErrorOverlay] Received compile-diagnostics:', data);
        
        if (data && data.diagnostics && data.diagnostics.length > 0) {
            // Filter to show only errors (not warnings in overlay)
            const errors = data.diagnostics.filter(d => 
                d.severity?.toLowerCase() === 'error'
            );
            
            if (errors.length > 0) {
                setDiagnostics(errors);
                setModule(data.module || 'unknown');
                setCrashInfo(null);
                setVisible(true);
                setExpandedIds(new Set([0]));
            }
        }
    }, []);
    
    // Handle HMR status (including crash recovery)
    const handleHMRStatus = useCallback((event) => {
        const data = event.detail?.data || event.detail;
        console.log('[ErrorOverlay] Received hmr-status:', data);
        
        if (data?.status === 'compile-error') {
            // Compile error from HMR system
            if (data.diagnostics && data.diagnostics.length > 0) {
                setDiagnostics(data.diagnostics);
                setModule(data.module || 'unknown');
                setCrashInfo(null);
                setVisible(true);
            }
        } else if (data?.status === 'crash-recovered') {
            // Runtime crash
            setCrashInfo(data.crash_info || data);
            setDiagnostics([]);
            setModule(data.module || 'unknown');
            setVisible(true);
        } else if (data?.status === 'applied' || data?.status === 'state-migrated') {
            // Success - hide overlay
            setVisible(false);
            setDiagnostics([]);
            setCrashInfo(null);
        }
    }, []);
    
    // Handle direct error events
    const handleDirectError = useCallback((event) => {
        const data = event.detail;
        console.log('[ErrorOverlay] Received direct error:', data);
        
        if (data?.type === 'compile-diagnostics') {
            handleCompileDiagnostics({ detail: data });
        }
    }, [handleCompileDiagnostics]);
    
    useEffect(() => {
        window.addEventListener('synthi:compile-diagnostics', handleCompileDiagnostics);
        window.addEventListener('synthi:hmr-status', handleHMRStatus);
        window.addEventListener('synthi:error', handleDirectError);
        window.addEventListener('synthi:build-log', (e) => {
            // Check if build log contains diagnostics JSON
            try {
                const parsed = JSON.parse(e.detail);
                if (parsed.type === 'compile-diagnostics') {
                    handleCompileDiagnostics({ detail: parsed });
                }
            } catch {}
        });
        
        return () => {
            window.removeEventListener('synthi:compile-diagnostics', handleCompileDiagnostics);
            window.removeEventListener('synthi:hmr-status', handleHMRStatus);
            window.removeEventListener('synthi:error', handleDirectError);
        };
    }, [handleCompileDiagnostics, handleHMRStatus, handleDirectError]);
    
    // Handle escape key to dismiss
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape' && visible) {
                setVisible(false);
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [visible]);
    
    const toggleExpanded = useCallback((idx) => {
        setExpandedIds(prev => {
            const next = new Set(prev);
            if (next.has(idx)) {
                next.delete(idx);
            } else {
                next.add(idx);
            }
            return next;
        });
    }, []);
    
    const handleGoToFile = useCallback((file, line, column) => {
        // Dispatch event for editor to navigate to file location
        window.dispatchEvent(new CustomEvent('synthi:goto-location', {
            detail: { file, line, column }
        }));
        setVisible(false);
    }, []);
    
    const handleDismiss = useCallback(() => {
        setVisible(false);
    }, []);
    
    if (!visible) {
        return null;
    }
    
    const errorCount = diagnostics.filter(d => d.severity?.toLowerCase() === 'error').length;
    const warningCount = diagnostics.filter(d => d.severity?.toLowerCase() === 'warning').length;
    
    return (
        <div 
            ref={overlayRef}
            className={cn(
                "fixed inset-0 z-[100] bg-gray-950/95 backdrop-blur-sm overflow-hidden flex flex-col",
                className
            )}
        >
            {/* Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-gray-800 bg-gray-900/50">
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <AlertCircle className="w-6 h-6 text-red-400" />
                        <h2 className="text-xl font-semibold text-white">
                            {crashInfo ? 'Runtime Error' : 'Compilation Failed'}
                        </h2>
                    </div>
                    {!crashInfo && (
                        <div className="flex items-center gap-3 text-sm">
                            {errorCount > 0 && (
                                <span className="text-red-400">
                                    {errorCount} error{errorCount !== 1 ? 's' : ''}
                                </span>
                            )}
                            {warningCount > 0 && (
                                <span className="text-yellow-400">
                                    {warningCount} warning{warningCount !== 1 ? 's' : ''}
                                </span>
                            )}
                        </div>
                    )}
                    {module && (
                        <span className="text-sm text-gray-500">
                            in <span className="font-mono text-gray-400">{module}</span>
                        </span>
                    )}
                </div>
                <button
                    onClick={handleDismiss}
                    className="p-2 rounded-lg hover:bg-gray-800 text-gray-400 hover:text-white transition-colors"
                    title="Dismiss (Esc)"
                >
                    <X size={20} />
                </button>
            </div>
            
            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6">
                <div className="max-w-4xl mx-auto space-y-4">
                    {/* Crash info */}
                    {crashInfo && (
                        <CrashInfoCard crashInfo={crashInfo} onDismiss={handleDismiss} />
                    )}
                    
                    {/* Diagnostics */}
                    {diagnostics.map((diag, idx) => (
                        <DiagnosticCard
                            key={idx}
                            diagnostic={diag}
                            isExpanded={expandedIds.has(idx)}
                            onToggle={() => toggleExpanded(idx)}
                            onGoToFile={handleGoToFile}
                        />
                    ))}
                </div>
            </div>
            
            {/* Footer */}
            <div className="px-6 py-3 border-t border-gray-800 bg-gray-900/50">
                <div className="flex items-center justify-between text-sm text-gray-400">
                    <span>Press <kbd className="px-1.5 py-0.5 bg-gray-800 rounded text-gray-300 font-mono text-xs">Esc</kbd> to dismiss</span>
                    <span>The previous working version continues running</span>
                </div>
            </div>
        </div>
    );
}

export default ErrorOverlay;
