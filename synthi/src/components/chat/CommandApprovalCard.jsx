"use client";
import { useState } from 'react';
import { Terminal, ShieldCheck, ShieldX, Loader2 } from 'lucide-react';

/**
 * CommandApprovalCard – renders inline in the chat timeline when the AI
 * requests permission to execute a terminal command. Restyled onto the
 * shared Vectant card chrome (.vx-rcard / .vx-btn); the status accent
 * (warning / purple / success / danger) drives border + glyph + pill.
 *
 * Props:
 *   id        – unique approval ID
 *   command   – the shell command string
 *   onApprove – (id) => void
 *   onReject  – (id) => void
 *   status    – 'pending' | 'running' | 'approved' | 'rejected' | 'failed' | 'expired'
 */
export default function CommandApprovalCard({ id, command, onApprove, onReject, status = 'pending', output, filesCount = 0 }) {
    const [busy, setBusy] = useState(false);

    const handleApprove = async () => {
        if (busy || status !== 'pending') return;
        setBusy(true);
        try { await onApprove?.(id); } catch (_) { }
        setBusy(false);
    };
    const handleReject = async () => {
        if (busy || status !== 'pending') return;
        setBusy(true);
        try { await onReject?.(id); } catch (_) { }
        setBusy(false);
    };

    const isPending = status === 'pending';
    const isRunning = status === 'running';
    const isApproved = status === 'approved';
    const isRejected = status === 'rejected';
    const isFailed = status === 'failed';
    const isExpired = status === 'expired';

    const accent = isApproved ? 'var(--accent-success)'
        : (isRejected || isFailed) ? 'var(--accent-danger)'
        : isRunning ? 'var(--attention-purple)'
        : 'var(--accent-warning)';

    const pillBase = {
        display: 'inline-flex', alignItems: 'center', gap: 4,
        fontSize: 9, fontWeight: 600, padding: '2px 7px', borderRadius: 999,
        color: accent, background: `color-mix(in srgb, ${accent} 12%, transparent)`,
        border: `1px solid color-mix(in srgb, ${accent} 32%, transparent)`,
    };

    const statusPill = (() => {
        if (isPending) return <span style={pillBase}><span className="w-1.5 h-1.5 rounded-full animate-pulse" style={{ background: accent }} /> Waiting</span>;
        if (isRunning) return <span style={pillBase}><Loader2 className="w-3 h-3 animate-spin" /> Running</span>;
        if (isApproved) return <span style={pillBase}><ShieldCheck className="w-3 h-3" /> Approved</span>;
        if (isRejected) return <span style={pillBase}><ShieldX className="w-3 h-3" /> Rejected</span>;
        if (isFailed) return <span style={pillBase}><ShieldX className="w-3 h-3" /> Failed</span>;
        if (isExpired) return <span style={{ ...pillBase, color: 'var(--text-muted)', background: 'transparent', border: '1px solid var(--border-medium)' }}>Expired</span>;
        return null;
    })();

    return (
        <div className="vx-rcard" style={{ borderColor: `color-mix(in srgb, ${accent} 38%, transparent)` }}>
            {/* Header */}
            <div className="vx-rcard-hd vx-rcard-hd--static" style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                <span className="flex items-center justify-center flex-shrink-0" style={{ width: 16, height: 16, borderRadius: 6, background: `color-mix(in srgb, ${accent} 18%, transparent)` }}>
                    <Terminal className="w-2.5 h-2.5" style={{ color: accent }} strokeWidth={2} />
                </span>
                <span className="vx-rcard-title">Command</span>
                <span className="vx-rcard-chips">{statusPill}</span>
            </div>

            {/* Command preview */}
            <div style={{ padding: '8px 12px' }}>
                <pre className="text-[11px] font-mono whitespace-pre-wrap break-all leading-snug rounded-md px-2 py-1.5" style={{ background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}>
                    <span className="select-none" style={{ color: accent, opacity: 0.8 }}>$ </span>{command}
                </pre>
            </div>

            {/* Auto-apply note */}
            {isPending && filesCount > 0 && (
                <div className="text-[10px]" style={{ padding: '0 12px 8px', color: 'color-mix(in srgb, var(--accent-warning) 80%, var(--text-secondary))' }}>
                    Approving will save {filesCount} file{filesCount > 1 ? 's' : ''} to disk first, then run the command.
                </div>
            )}

            {/* Output */}
            {output && (isApproved || isFailed) && (
                <div style={{ padding: '0 12px 10px' }}>
                    <pre className="text-[10px] font-mono whitespace-pre-wrap break-all leading-snug max-h-32 overflow-y-auto rounded-md px-2 py-1.5" style={{ background: 'var(--bg-app)', border: '1px solid var(--border-subtle)', color: 'var(--text-muted)' }}>
                        {output}
                    </pre>
                </div>
            )}

            {/* Actions */}
            {(isPending || isRunning) && (
                <div className="vx-rcard-acts" style={{ padding: '0 12px 12px', justifyContent: 'flex-end' }}>
                    <button
                        disabled={busy || isRunning}
                        onClick={handleReject}
                        className="vx-btn vx-btn--ghost disabled:opacity-40 disabled:cursor-not-allowed"
                        style={{ color: 'var(--accent-danger)', borderColor: 'color-mix(in srgb, var(--accent-danger) 35%, transparent)' }}
                    >
                        {busy && !isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Deny'}
                    </button>
                    <button
                        disabled={busy || isRunning}
                        onClick={handleApprove}
                        className="vx-btn vx-btn--primary disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {(isRunning || busy) ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Allow'}
                    </button>
                </div>
            )}
        </div>
    );
}
