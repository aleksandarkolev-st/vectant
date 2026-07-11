"use client";

import { useState, useEffect, useCallback, useRef } from 'react';
import { cn } from '@/lib/utils';
import { X, ChevronDown, ChevronRight, AlertCircle, AlertTriangle, Info, Lightbulb, Copy, Check, RefreshCw, FileCode, Wand2 } from 'lucide-react';
import { PreviewLifecycleState } from '@/lib/preview-lifecycle';
import { getPreviewState, subscribePreviewStore } from '@/lib/preview-store';
import { normalizeDiagnosticsPayload } from '@/lib/diagnostics-normalizer';

/**
 * Error Overlay Component
 * 
 * Displays compile/runtime errors in a Vectant recovery overlay.
 * Shows source code snippets, file:line info, suggestions, and allows dismiss.
 */

// Quick fix action types
const QUICK_FIX_TYPES = {
    ADD_INCLUDE: 'add-include',
    ADD_SEMICOLON: 'add-semicolon', 
    FIX_TYPO: 'fix-typo',
    REMOVE_UNUSED: 'remove-unused',
    ADD_DECLARATION: 'add-declaration',
    CHANGE_TYPE: 'change-type',
};

const SEVERITY_CONFIGS = {
    error: {
        icon: AlertCircle,
        tone: 'var(--accent-danger)',
        bg: 'color-mix(in srgb, var(--accent-danger) 10%, var(--bg-panel) 90%)',
        border: 'color-mix(in srgb, var(--accent-danger) 40%, var(--border-subtle))',
        label: 'Error',
    },
    warning: {
        icon: AlertTriangle,
        tone: 'var(--accent-warning)',
        bg: 'color-mix(in srgb, var(--accent-warning) 10%, var(--bg-panel) 90%)',
        border: 'color-mix(in srgb, var(--accent-warning) 42%, var(--border-subtle))',
        label: 'Warning',
    },
    note: {
        icon: Info,
        tone: 'var(--accent-secondary)',
        bg: 'color-mix(in srgb, var(--accent-secondary) 9%, var(--bg-panel) 91%)',
        border: 'color-mix(in srgb, var(--accent-secondary) 34%, var(--border-subtle))',
        label: 'Note',
    },
    help: {
        icon: Lightbulb,
        tone: 'var(--accent-success)',
        bg: 'color-mix(in srgb, var(--accent-success) 10%, var(--bg-panel) 90%)',
        border: 'color-mix(in srgb, var(--accent-success) 36%, var(--border-subtle))',
        label: 'Help',
    },
    info: {
        icon: Info,
        tone: 'var(--text-secondary)',
        bg: 'color-mix(in srgb, var(--bg-elevated) 58%, var(--bg-panel) 42%)',
        border: 'var(--border-subtle)',
        label: 'Info',
    },
};

// Analyze error message and generate quick fix suggestions
function generateQuickFixes(diagnostic) {
    const fixes = [];
    const msg = (diagnostic.message || '').toLowerCase();
    const code = diagnostic.code || '';
    
    // Missing include
    if (msg.includes('undeclared identifier') || msg.includes('unknown type') || 
        msg.includes('was not declared') || msg.includes('no type named')) {
        const typeMatch = diagnostic.message.match(/'([^']+)'/);
        if (typeMatch) {
            const typeName = typeMatch[1];
            // Common type -> header mappings
            const headerMap = {
                'uint32_t': 'stdint.h',
                'uint64_t': 'stdint.h',
                'int32_t': 'stdint.h',
                'size_t': 'stddef.h',
                'string': 'string',
                'vector': 'vector',
                'map': 'map',
                'printf': 'stdio.h',
                'malloc': 'stdlib.h',
                'SDL_Renderer': 'SDL2/SDL.h',
                'SDL_Window': 'SDL2/SDL.h',
            };
            const header = headerMap[typeName];
            if (header) {
                fixes.push({
                    type: QUICK_FIX_TYPES.ADD_INCLUDE,
                    label: `Add #include <${header}>`,
                    action: { type: 'insert', line: 1, content: `#include <${header}>\n` }
                });
            }
        }
    }
    
    // Missing semicolon
    if (msg.includes('expected \';\'' ) || msg.includes('missing semicolon')) {
        fixes.push({
            type: QUICK_FIX_TYPES.ADD_SEMICOLON,
            label: 'Add missing semicolon',
            action: { type: 'insert-char', char: ';' }
        });
    }
    
    // Typo suggestions from compiler
    if (msg.includes('did you mean')) {
        const suggestionMatch = diagnostic.message.match(/did you mean ['"]?([^'"?\s]+)/i);
        if (suggestionMatch) {
            fixes.push({
                type: QUICK_FIX_TYPES.FIX_TYPO,
                label: `Change to '${suggestionMatch[1]}'`,
                action: { type: 'replace', replacement: suggestionMatch[1] }
            });
        }
    }
    
    // Unused variable
    if (msg.includes('unused variable') || msg.includes('unused parameter')) {
        const varMatch = diagnostic.message.match(/'([^']+)'/);
        if (varMatch) {
            fixes.push({
                type: QUICK_FIX_TYPES.REMOVE_UNUSED,
                label: `Add (void)${varMatch[1]} to suppress`,
                action: { type: 'insert', content: `(void)${varMatch[1]}; // suppress unused warning\n` }
            });
        }
    }
    
    return fixes;
}

// Code snippet component with line highlighting
function CodeSnippet({ code, highlightLine, startLine = 1, language = 'cpp' }) {
    const lines = code.split('\n');
    
    return (
        <div
            className="overflow-hidden rounded-[var(--radius-control)] border font-mono text-sm"
            style={{
                background: 'var(--bg-editor)',
                borderColor: 'var(--border-subtle)',
                color: 'var(--text-secondary)',
            }}
        >
            <div className="overflow-x-auto">
                <table className="w-full">
                    <tbody>
                        {lines.map((line, idx) => {
                            const lineNum = startLine + idx;
                            const isHighlighted = lineNum === highlightLine;
                            return (
                                <tr 
                                    key={idx}
                                    style={{
                                        background: isHighlighted
                                            ? 'color-mix(in srgb, var(--accent-danger) 15%, transparent)'
                                            : 'transparent',
                                    }}
                                >
                                    <td
                                        className="select-none border-r px-3 py-0.5 text-right"
                                        style={{
                                            borderColor: 'var(--border-subtle)',
                                            background: isHighlighted
                                                ? 'color-mix(in srgb, var(--accent-danger) 10%, transparent)'
                                                : 'transparent',
                                            color: isHighlighted ? 'var(--accent-danger)' : 'var(--text-tertiary)',
                                        }}
                                    >
                                        {lineNum}
                                    </td>
                                    <td
                                        className="whitespace-pre px-4 py-0.5"
                                        style={{ color: isHighlighted ? 'var(--text-primary)' : 'var(--text-secondary)' }}
                                    >
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

// Quick fix button component
function QuickFixButton({ fix, onApply }) {
    return (
        <button
            onClick={() => onApply(fix)}
            className="th-focus-ring flex items-center gap-2 rounded-[var(--radius-control)] border px-3 py-1.5 text-sm transition-colors"
            style={{
                background: 'color-mix(in srgb, var(--accent-secondary) 14%, transparent)',
                borderColor: 'color-mix(in srgb, var(--accent-secondary) 34%, var(--border-subtle))',
                color: 'var(--accent-secondary)',
            }}
        >
            <Wand2 size={14} />
            {fix.label}
        </button>
    );
}

// Single diagnostic display
function DiagnosticCard({ diagnostic, isExpanded, onToggle, onGoToFile, onApplyFix, isSelected }) {
    const [copied, setCopied] = useState(false);
    const severity = diagnostic.severity?.toLowerCase() || 'error';
    const config = SEVERITY_CONFIGS[severity] || SEVERITY_CONFIGS.error;
    const Icon = config.icon;
    const quickFixes = generateQuickFixes(diagnostic);
    
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
        <div
            className={cn(
                "rounded-[var(--radius-panel)] border transition-all",
                isSelected && "outline outline-1 outline-offset-0"
            )}
            style={{
                background: config.bg,
                borderColor: config.border,
                outlineColor: isSelected ? 'color-mix(in srgb, var(--attention-purple) 60%, transparent)' : 'transparent',
                boxShadow: isSelected ? 'var(--attention-rim)' : 'none',
            }}
        >
            {/* Header */}
            <div 
                className="flex cursor-pointer items-center gap-3 p-4"
                onClick={onToggle}
            >
                <button
                    className="vt-icon-button th-focus-ring h-7 w-7"
                    style={{ color: 'var(--text-secondary)' }}
                >
                    {isExpanded ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                <Icon className="h-5 w-5" style={{ color: config.tone }} />
                <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                        <span className="text-xs font-semibold uppercase tracking-[0.08em]" style={{ color: config.tone }}>
                            {config.label}
                        </span>
                        {diagnostic.code && (
                            <span className="font-mono text-xs" style={{ color: 'var(--text-tertiary)' }}>
                                [{diagnostic.code}]
                            </span>
                        )}
                    </div>
                    <p className="mt-1 break-words" style={{ color: 'var(--text-primary)' }}>{diagnostic.message}</p>
                </div>
                <div className="flex items-center gap-2">
                    {location && (
                        <button
                            onClick={(e) => { e.stopPropagation(); handleGoToFile(); }}
                            className="vt-icon-button th-focus-ring h-7 w-7"
                            title="Go to file"
                        >
                            <FileCode size={14} />
                        </button>
                    )}
                    <button 
                        onClick={(e) => { e.stopPropagation(); handleCopy(); }}
                        className="vt-icon-button th-focus-ring h-7 w-7"
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
                        className="th-focus-ring font-mono text-sm hover:underline"
                        style={{ color: 'var(--accent-secondary)' }}
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
                            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Suggested fixes</p>
                            {diagnostic.suggestions.map((suggestion, idx) => (
                                <div
                                    key={idx}
                                    className="rounded-[var(--radius-control)] border p-3"
                                    style={{
                                        background: 'color-mix(in srgb, var(--accent-success) 9%, transparent)',
                                        borderColor: 'color-mix(in srgb, var(--accent-success) 32%, var(--border-subtle))',
                                    }}
                                >
                                    <p className="text-sm" style={{ color: 'var(--accent-success)' }}>{suggestion.message}</p>
                                    {suggestion.replacement && (
                                        <pre
                                            className="mt-2 overflow-x-auto rounded-[var(--radius-control)] p-2 font-mono text-sm"
                                            style={{
                                                background: 'var(--bg-editor)',
                                                color: 'var(--text-primary)',
                                            }}
                                        >
                                            {suggestion.replacement}
                                        </pre>
                                    )}
                                </div>
                            ))}
                        </div>
                    )}
                    
                    {/* Quick fixes (auto-generated) */}
                    {quickFixes.length > 0 && (
                        <div className="space-y-2">
                            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Quick fixes</p>
                            <div className="flex flex-wrap gap-2">
                                {quickFixes.map((fix, idx) => (
                                    <QuickFixButton 
                                        key={idx} 
                                        fix={fix} 
                                        onApply={onApplyFix} 
                                    />
                                ))}
                                <button
                                    onClick={() => {
                                        window.dispatchEvent(new CustomEvent('synthi:request-ai-fix', {
                                            detail: { diagnostic }
                                        }));
                                    }}
                                    className="th-focus-ring flex items-center gap-2 rounded-[var(--radius-control)] border px-3 py-1.5 text-sm transition-colors"
                                    style={{
                                        background: 'color-mix(in srgb, var(--attention-purple) 14%, transparent)',
                                        borderColor: 'color-mix(in srgb, var(--attention-purple) 36%, var(--border-subtle))',
                                        color: 'var(--attention-purple)',
                                    }}
                                >
                                    <Wand2 size={14} />
                                    Dispatch fix agent
                                </button>
                            </div>
                        </div>
                    )}
                    
                    {/* AI fix button when no quick fixes available */}
                    {quickFixes.length === 0 && (
                        <button
                            onClick={() => {
                                window.dispatchEvent(new CustomEvent('synthi:request-ai-fix', {
                                    detail: { diagnostic }
                                }));
                            }}
                            className="th-focus-ring flex items-center gap-2 rounded-[var(--radius-control)] border px-3 py-1.5 text-sm transition-colors"
                            style={{
                                background: 'color-mix(in srgb, var(--attention-purple) 14%, transparent)',
                                borderColor: 'color-mix(in srgb, var(--attention-purple) 36%, var(--border-subtle))',
                                color: 'var(--attention-purple)',
                            }}
                        >
                            <Wand2 size={14} />
                            Dispatch fix agent
                        </button>
                    )}
                    
                    {/* Related diagnostics */}
                    {diagnostic.related && diagnostic.related.length > 0 && (
                        <div className="space-y-2 border-l-2 pl-4" style={{ borderColor: 'var(--border-medium)' }}>
                            {diagnostic.related.map((related, idx) => (
                                <div key={idx} className="text-sm">
                                    <span style={{ color: 'var(--text-secondary)' }}>
                                        {related.location && (
                                            <span className="font-mono" style={{ color: 'var(--accent-secondary)' }}>
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
        <div
            className="rounded-[var(--radius-panel)] border p-4"
            style={{
                background: 'color-mix(in srgb, var(--accent-danger) 10%, var(--bg-panel) 90%)',
                borderColor: 'color-mix(in srgb, var(--accent-danger) 42%, var(--border-subtle))',
            }}
        >
            <div className="flex items-start gap-3">
                <AlertCircle className="mt-0.5 h-6 w-6 flex-shrink-0" style={{ color: 'var(--accent-danger)' }} />
                <div className="flex-1">
                    <h3 className="text-lg font-semibold" style={{ color: 'var(--accent-danger)' }}>
                        Runtime Crash: {crashInfo.signal_name || 'Unknown Signal'}
                    </h3>
                    <p className="mt-1" style={{ color: 'var(--text-secondary)' }}>
                        Module <span className="font-mono" style={{ color: 'var(--accent-warning)' }}>{crashInfo.module_name}</span> crashed
                        {crashInfo.address && (
                            <span style={{ color: 'var(--text-tertiary)' }}> at address 0x{crashInfo.address.toString(16)}</span>
                        )}
                    </p>
                    
                    {/* Source location if available */}
                    {crashInfo.source_location && (
                        <div
                            className="mt-3 rounded-[var(--radius-control)] p-3 font-mono text-sm"
                            style={{ background: 'var(--bg-editor)' }}
                        >
                            <span style={{ color: 'var(--accent-secondary)' }}>
                                {crashInfo.source_location.file}:{crashInfo.source_location.line}
                                {crashInfo.source_location.column > 0 && `:${crashInfo.source_location.column}`}
                            </span>
                            {crashInfo.source_location.function && (
                                <span style={{ color: 'var(--text-secondary)' }}> in </span>
                            )}
                            {crashInfo.source_location.function && (
                                <span style={{ color: 'var(--accent-warning)' }}>{crashInfo.source_location.function}</span>
                            )}
                        </div>
                    )}
                    
                    {/* Stack frames */}
                    {crashInfo.source_frames && crashInfo.source_frames.length > 0 && (
                        <div className="mt-3">
                            <p className="mb-2 text-sm" style={{ color: 'var(--text-secondary)' }}>Stack trace</p>
                            <div
                                className="max-h-48 space-y-1 overflow-y-auto rounded-[var(--radius-control)] p-3 font-mono text-xs"
                                style={{ background: 'var(--bg-editor)' }}
                            >
                                {crashInfo.source_frames.map((frame, idx) => (
                                    <div key={idx} style={{ color: 'var(--text-secondary)' }}>
                                        <span style={{ color: 'var(--text-tertiary)' }}>{idx}:</span>{' '}
                                        <span style={{ color: 'var(--accent-secondary)' }}>
                                            {frame.file}:{frame.line}
                                        </span>
                                        {frame.function && (
                                            <>
                                                <span style={{ color: 'var(--text-tertiary)' }}> in </span>
                                                <span style={{ color: 'var(--accent-warning)' }}>{frame.function}</span>
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
                            <summary className="cursor-pointer text-sm" style={{ color: 'var(--text-secondary)' }}>
                                Raw backtrace
                            </summary>
                            <pre
                                className="mt-2 max-h-48 overflow-x-auto overflow-y-auto rounded-[var(--radius-control)] p-3 text-xs"
                                style={{
                                    background: 'var(--bg-editor)',
                                    color: 'var(--text-secondary)',
                                }}
                            >
                                {crashInfo.backtrace}
                            </pre>
                        </details>
                    )}
                    
                    <p className="mt-3 text-sm" style={{ color: 'var(--accent-success)' }}>
                        Previous module remains live. Patch the fault and save to retry.
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
    const [selectedIndex, setSelectedIndex] = useState(0); // Currently selected error for keyboard nav
    const [isRetrying, setIsRetrying] = useState(false);
    const overlayRef = useRef(null);
    
    // Handle compile diagnostics
    const handleCompileDiagnostics = useCallback((event) => {
        const data = event.detail?.data || event.detail;
        console.log('[ErrorOverlay] Received compile-diagnostics:', data);
        const normalizedDiagnostics = Array.isArray(data?.diagnostics) ? data.diagnostics : [];
        
        if (data && normalizedDiagnostics.length > 0) {
            // Filter to show only errors (not warnings in overlay)
            const errors = normalizedDiagnostics.filter(d =>
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
            const normalizedDiagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
            if (normalizedDiagnostics.length > 0) {
                setDiagnostics(normalizedDiagnostics);
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

    const handleBuildLog = useCallback((event) => {
        try {
            const parsed = typeof event.detail === 'string'
                ? JSON.parse(event.detail)
                : event.detail;
            if (parsed?.type === 'compile-diagnostics') {
                handleCompileDiagnostics({ detail: parsed });
            }
        } catch {}
    }, [handleCompileDiagnostics]);
    
    useEffect(() => {
        window.addEventListener('synthi:compile-diagnostics', handleCompileDiagnostics);
        window.addEventListener('synthi:hmr-status', handleHMRStatus);
        window.addEventListener('synthi:error', handleDirectError);
        window.addEventListener('synthi:build-log', handleBuildLog);
        
        return () => {
            window.removeEventListener('synthi:compile-diagnostics', handleCompileDiagnostics);
            window.removeEventListener('synthi:hmr-status', handleHMRStatus);
            window.removeEventListener('synthi:error', handleDirectError);
            window.removeEventListener('synthi:build-log', handleBuildLog);
        };
    }, [handleBuildLog, handleCompileDiagnostics, handleHMRStatus, handleDirectError]);
    
    // Subscribe to preview-store for compiled-preview diagnostics.
    // Normalizes diagnostics through the unified schema before rendering.
    useEffect(() => {
        function onPreviewChange(previewState) {
            if (previewState.state === PreviewLifecycleState.COMPILE_FAILED && previewState.buildDiagnostics) {
                const normalized = normalizeDiagnosticsPayload(previewState.buildDiagnostics);
                const errors = normalized.diagnostics.filter(d => d.severity === 'error');
                if (errors.length > 0) {
                    setDiagnostics(errors);
                    setModule(normalized.module || 'unknown');
                    setCrashInfo(null);
                    setVisible(true);
                    setExpandedIds(new Set([0]));
                }
            } else if (previewState.state === PreviewLifecycleState.CRASH_RECOVERED) {
                setCrashInfo(previewState.reloadDiagnostics || {});
                setDiagnostics([]);
                setModule(previewState.language || 'unknown');
                setVisible(true);
            } else if (
                previewState.state === PreviewLifecycleState.RELOAD_APPLIED ||
                previewState.state === PreviewLifecycleState.IDLE
            ) {
                setVisible(false);
                setDiagnostics([]);
                setCrashInfo(null);
            }
        }

        onPreviewChange(getPreviewState());
        return subscribePreviewStore(onPreviewChange);
    }, []);

    // Handle escape key to dismiss
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (!visible) return;
            
            switch (e.key) {
                case 'Escape':
                    setVisible(false);
                    break;
                case 'ArrowDown':
                case 'n':
                case 'j':
                    // Next error
                    e.preventDefault();
                    setSelectedIndex(prev => {
                        const next = Math.min(prev + 1, diagnostics.length - 1);
                        setExpandedIds(new Set([next]));
                        return next;
                    });
                    break;
                case 'ArrowUp':
                case 'p':
                case 'k':
                    // Previous error
                    e.preventDefault();
                    setSelectedIndex(prev => {
                        const next = Math.max(prev - 1, 0);
                        setExpandedIds(new Set([next]));
                        return next;
                    });
                    break;
                case 'Enter':
                    // Go to selected error location
                    e.preventDefault();
                    if (diagnostics[selectedIndex]?.location) {
                        const loc = diagnostics[selectedIndex].location;
                        handleGoToFile(loc.file, loc.line, loc.column);
                    }
                    break;
                case 'f':
                    // Apply first quick fix if available
                    if (!e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        const diag = diagnostics[selectedIndex];
                        if (diag) {
                            const fixes = generateQuickFixes(diag);
                            if (fixes.length > 0) {
                                handleApplyFix(fixes[0], diag);
                            }
                        }
                    }
                    break;
                case 'r':
                    // Retry compilation
                    if (!e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        handleRetryCompilation();
                    }
                    break;
                case 'a':
                    // AI fix request
                    if (!e.ctrlKey && !e.metaKey) {
                        e.preventDefault();
                        const diag = diagnostics[selectedIndex];
                        if (diag) {
                            handleRequestAIFix(diag);
                        }
                    }
                    break;
            }
        };
        window.addEventListener('keydown', handleKeyDown);
        return () => window.removeEventListener('keydown', handleKeyDown);
    }, [visible, diagnostics, selectedIndex]);
    
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
    
    const handleApplyFix = useCallback((fix, diagnostic) => {
        // Dispatch event for editor to apply the quick fix
        window.dispatchEvent(new CustomEvent('synthi:apply-fix', {
            detail: { 
                fix, 
                diagnostic,
                location: diagnostic?.location 
            }
        }));
        console.log('[ErrorOverlay] Applying fix:', fix.label);
    }, []);
    
    const handleRetryCompilation = useCallback(() => {
        setIsRetrying(true);
        window.dispatchEvent(new CustomEvent('synthi:retry-compile', {
            detail: { module }
        }));
        // Reset retry state after a short delay
        setTimeout(() => setIsRetrying(false), 2000);
    }, [module]);
    
    const handleRequestAIFix = useCallback((diagnostic) => {
        // Dispatch event for AI system to analyze and fix
        window.dispatchEvent(new CustomEvent('synthi:request-ai-fix', {
            detail: {
                diagnostic,
                module,
                allDiagnostics: diagnostics
            }
        }));
        console.log('[ErrorOverlay] Requesting AI fix for:', diagnostic.message);
    }, [module, diagnostics]);
    
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
                "fixed inset-0 z-[100] flex flex-col overflow-hidden backdrop-blur-sm",
                className
            )}
            style={{
                background:
                    'linear-gradient(135deg, color-mix(in srgb, var(--bg-app) 96%, transparent), color-mix(in srgb, var(--bg-panel) 94%, transparent))',
                color: 'var(--text-primary)',
            }}
        >
            {/* Header */}
            <div
                className="flex items-center justify-between border-b px-6 py-4"
                style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--bg-panel) 76%, transparent)',
                }}
            >
                <div className="flex items-center gap-4">
                    <div className="flex items-center gap-2">
                        <span
                            className="flex h-8 w-8 items-center justify-center rounded-[var(--radius-control)] border"
                            style={{
                                background: 'color-mix(in srgb, var(--accent-danger) 12%, transparent)',
                                borderColor: 'color-mix(in srgb, var(--accent-danger) 38%, var(--border-subtle))',
                            }}
                        >
                            <AlertCircle className="h-5 w-5" style={{ color: 'var(--accent-danger)' }} />
                        </span>
                        <h2 className="text-xl font-semibold">
                            {crashInfo ? 'Runtime recovery' : 'Compile gate failed'}
                        </h2>
                    </div>
                    {!crashInfo && (
                        <div className="flex items-center gap-3 text-sm">
                            {errorCount > 0 && (
                                <span style={{ color: 'var(--accent-danger)' }}>
                                    {errorCount} error{errorCount !== 1 ? 's' : ''}
                                </span>
                            )}
                            {warningCount > 0 && (
                                <span style={{ color: 'var(--accent-warning)' }}>
                                    {warningCount} warning{warningCount !== 1 ? 's' : ''}
                                </span>
                            )}
                        </div>
                    )}
                    {module && (
                        <span className="text-sm" style={{ color: 'var(--text-tertiary)' }}>
                            target <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>{module}</span>
                        </span>
                    )}
                </div>
                <button
                    onClick={handleDismiss}
                    className="vt-icon-button th-focus-ring h-9 w-9"
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
                            isSelected={selectedIndex === idx}
                            onToggle={() => toggleExpanded(idx)}
                            onGoToFile={handleGoToFile}
                            onApplyFix={(fix) => handleApplyFix(fix, diag)}
                        />
                    ))}
                </div>
            </div>
            
            {/* Footer */}
            <div
                className="border-t px-6 py-3"
                style={{
                    borderColor: 'var(--border-subtle)',
                    background: 'color-mix(in srgb, var(--bg-panel) 76%, transparent)',
                }}
            >
                <div className="flex items-center justify-between text-sm" style={{ color: 'var(--text-secondary)' }}>
                    <div className="flex items-center gap-3">
                        <span className="vt-state-dot" style={{ background: 'var(--accent-success)' }} />
                        <span>Previous snapshot remains live while this gate is repaired.</span>
                    </div>
                    <div className="flex items-center gap-3">
                        <button
                            onClick={handleRetryCompilation}
                            disabled={isRetrying}
                            className={cn(
                                "th-focus-ring flex items-center gap-1.5 rounded-[var(--radius-control)] border px-3 py-1 transition-colors",
                                isRetrying && "opacity-50 cursor-not-allowed"
                            )}
                            style={{
                                background: 'var(--bg-elevated)',
                                borderColor: 'var(--border-subtle)',
                                color: 'var(--text-primary)',
                            }}
                        >
                            <RefreshCw size={14} className={cn(isRetrying && "animate-spin")} />
                            {isRetrying ? 'Retrying...' : 'Retry'}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
}

export default ErrorOverlay;
