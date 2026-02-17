"use client";
import { useState } from 'react';
import { Terminal, ShieldCheck, ShieldX, Loader2 } from 'lucide-react';

/**
 * CommandApprovalCard – renders inline in the chat timeline when the AI
 * requests permission to execute a terminal command.
 *
 * Props:
 *   id        – unique approval ID (from the commandPending event)
 *   command   – the shell command string
 *   onApprove – (id) => void
 *   onReject  – (id) => void
 *   status    – 'pending' | 'running' | 'approved' | 'rejected' | 'failed' | 'expired'
 */
export default function CommandApprovalCard({ id, command, onApprove, onReject, status = 'pending' }) {
    const [busy, setBusy] = useState(false);

    const handleApprove = async () => {
        if (busy || status !== 'pending') return;
        setBusy(true);
        try {
            await onApprove?.(id);
        } catch (_) { }
        setBusy(false);
    };

    const handleReject = async () => {
        if (busy || status !== 'pending') return;
        setBusy(true);
        try {
            await onReject?.(id);
        } catch (_) { }
        setBusy(false);
    };

    const isPending = status === 'pending';
    const isRunning = status === 'running';
    const isApproved = status === 'approved';
    const isRejected = status === 'rejected';
    const isFailed = status === 'failed';
    const isExpired = status === 'expired';

    return (
        <div
            className={`rounded-lg border overflow-hidden shadow-md text-xs ${
                isPending
                    ? 'border-amber-700/50 bg-gradient-to-br from-[#1a1708] to-[#0f0e0a]'
                    : isRunning
                    ? 'border-blue-700/50 bg-gradient-to-br from-[#0d1520] to-[#0a0e14]'
                    : isApproved
                    ? 'border-emerald-800/50 bg-gradient-to-br from-[#0d1a15] to-[#0a0f0d]'
                    : isFailed
                    ? 'border-orange-800/50 bg-gradient-to-br from-[#1a1008] to-[#0f0d0a]'
                    : 'border-rose-800/50 bg-gradient-to-br from-[#1a0d0d] to-[#0f0a0a]'
            }`}
        >
            {/* Header */}
            <div className="flex items-center gap-2 px-3 py-2 border-b border-white/[0.06]">
                <Terminal className="w-3.5 h-3.5 text-amber-400 flex-shrink-0" strokeWidth={2} />
                <span className="text-[11px] font-semibold text-[#e4e4e7] uppercase tracking-wide">
                    Command Approval
                </span>
                {isPending && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-amber-400 font-medium">
                        <span className="w-1.5 h-1.5 rounded-full bg-amber-400 animate-pulse" />
                        Waiting
                    </span>
                )}
                {isRunning && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-blue-400 font-medium">
                        <Loader2 className="w-3 h-3 animate-spin" /> Running…
                    </span>
                )}
                {isApproved && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-emerald-400 font-medium">
                        <ShieldCheck className="w-3 h-3" /> Approved
                    </span>
                )}
                {isRejected && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-rose-400 font-medium">
                        <ShieldX className="w-3 h-3" /> Rejected
                    </span>
                )}
                {isFailed && (
                    <span className="ml-auto inline-flex items-center gap-1 text-[10px] text-orange-400 font-medium">
                        <ShieldX className="w-3 h-3" /> Failed
                    </span>
                )}
                {isExpired && (
                    <span className="ml-auto text-[10px] text-[#71717a] font-medium">
                        Expired
                    </span>
                )}
            </div>

            {/* Command preview */}
            <div className="px-3 py-2">
                <pre className="text-[11px] font-mono text-[#c7c9d1] bg-black/30 rounded px-2 py-1.5 whitespace-pre-wrap break-all leading-snug border border-white/[0.04]">
                    <span className="text-amber-500/70 select-none">$ </span>
                    {command}
                </pre>
            </div>

            {/* Actions */}
            {(isPending || isRunning) && (
                <div className="flex items-center justify-end gap-3 px-3 py-2 border-t border-white/[0.06]">
                    <button
                        disabled={busy || isRunning}
                        onClick={handleReject}
                        className="text-[11px] font-semibold text-rose-400 hover:text-rose-300 px-3 py-1 rounded-md border border-rose-800/40 hover:border-rose-700/60 bg-rose-500/10 hover:bg-rose-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {busy && !isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Deny'}
                    </button>
                    <button
                        disabled={busy || isRunning}
                        onClick={handleApprove}
                        className="text-[11px] font-semibold text-emerald-400 hover:text-emerald-300 px-3 py-1 rounded-md border border-emerald-800/40 hover:border-emerald-700/60 bg-emerald-500/10 hover:bg-emerald-500/20 transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                        {isRunning ? <Loader2 className="w-3 h-3 animate-spin" /> : busy ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Allow'}
                    </button>
                </div>
            )}
        </div>
    );
}
