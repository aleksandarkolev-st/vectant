import React, { useEffect, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { fetchGitStatus, checkoutBranch, clearCheckoutConflict, clearError } from '@/redux/gitSlice';
import { refreshWorkspaceThunk } from '@/redux/workspaceSlice';
import { GitBranch, Plus, ChevronDown, AlertTriangle, Archive, Trash2, X } from 'lucide-react';
import { toast } from 'sonner';
import {
    Select,
    SelectContent,
    SelectGroup,
    SelectItem,
    SelectLabel,
    SelectTrigger,
    SelectValue,
} from '@/components/ui/select';

/* ─── Checkout Conflict Dialog ─────────────────────── */
function CheckoutConflictDialog({ slug, branch, create, onClose }) {
    const dispatch = useDispatch();
    const [busy, setBusy] = useState(false);

    const handleStashAndCheckout = async () => {
        setBusy(true);
        const result = await dispatch(checkoutBranch({ slug, branch, create, mode: 'stash' }));
        setBusy(false);
        if (checkoutBranch.fulfilled.match(result)) {
            toast.success(`Stashed changes and switched to ${branch}`);
            dispatch(refreshWorkspaceThunk());
            onClose();
        } else if (result.payload?.code !== 'UNCOMMITTED_CHANGES') {
            toast.error(result.payload?.message || result.error?.message || 'Checkout failed');
        }
    };

    const handleForceCheckout = async () => {
        setBusy(true);
        const result = await dispatch(checkoutBranch({ slug, branch, create, mode: 'force' }));
        setBusy(false);
        if (checkoutBranch.fulfilled.match(result)) {
            toast.success(`Force switched to ${branch} (local changes discarded)`);
            dispatch(refreshWorkspaceThunk());
            onClose();
        } else {
            toast.error(result.payload?.message || result.error?.message || 'Checkout failed');
        }
    };

    return (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/60 backdrop-blur-sm">
            <div className="w-[380px] rounded-xl border shadow-2xl p-4" style={{ background: 'var(--bg-elevated, #18181b)', borderColor: 'var(--border-medium, #3f3f46)' }}>
                <div className="flex items-start gap-2.5 mb-3">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-warning)' }} />
                    <div>
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary, #e4e4e7)' }}>
                            Uncommitted Changes
                        </h3>
                        <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-secondary, #a1a1aa)' }}>
                            You have local changes that would be overwritten by switching to <strong className="font-mono text-[11px]" style={{ color: 'var(--text-primary, #e4e4e7)' }}>{branch}</strong>.
                            Choose how to proceed:
                        </p>
                    </div>
                </div>

                <div className="space-y-1.5 mb-3">
                    <button
                        onClick={handleStashAndCheckout}
                        disabled={busy}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors border disabled:opacity-50"
                        style={{
                            background: 'color-mix(in srgb, var(--attention-purple) 10%, transparent)',
                            borderColor: 'color-mix(in srgb, var(--attention-purple) 30%, transparent)',
                            color: 'var(--attention-purple)'
                        }}
                    >
                        <Archive className="w-3.5 h-3.5" />
                        Stash &amp; Checkout
                        <span className="ml-auto text-[10px] opacity-60">saves your changes</span>
                    </button>
                    <button
                        onClick={handleForceCheckout}
                        disabled={busy}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors border disabled:opacity-50"
                        style={{
                            background: 'color-mix(in srgb, var(--accent-danger) 8%, transparent)',
                            borderColor: 'color-mix(in srgb, var(--accent-danger) 25%, transparent)',
                            color: 'var(--accent-danger)'
                        }}
                    >
                        <Trash2 className="w-3.5 h-3.5" />
                        Force Checkout
                        <span className="ml-auto text-[10px] opacity-60">discards changes</span>
                    </button>
                </div>

                <button
                    onClick={onClose}
                    disabled={busy}
                    className="w-full py-1.5 rounded-lg text-xs font-medium transition-colors border"
                    style={{ borderColor: 'var(--border-medium, #3f3f46)', color: 'var(--text-secondary, #a1a1aa)' }}
                >
                    Cancel
                </button>
            </div>
        </div>
    );
}

export function BranchSelector({ slug }) {
    const dispatch = useDispatch();
    const { branches, currentBranch, loading, checkoutConflict } = useSelector(state => state.git);

    useEffect(() => {
        if (slug) {
            dispatch(fetchGitStatus(slug));
        }
    }, [slug, dispatch]);

    const handleValueChange = useCallback(async (value) => {
        if (value === 'create-new') {
            const branchName = prompt("Enter new branch name:");
            if (branchName) {
                const result = await dispatch(checkoutBranch({ slug, branch: branchName, create: true }));
                if (checkoutBranch.fulfilled.match(result)) {
                    dispatch(refreshWorkspaceThunk());
                }
            }
        } else {
            const result = await dispatch(checkoutBranch({ slug, branch: value }));
            if (checkoutBranch.fulfilled.match(result)) {
                dispatch(refreshWorkspaceThunk());
            }
        }
    }, [slug, dispatch]);

    const handleCloseConflictDialog = useCallback(() => {
        dispatch(clearCheckoutConflict());
        dispatch(clearError());
    }, [dispatch]);

    // Ensure branches.local is an array
    const localBranches = Array.isArray(branches?.local) ? branches.local : [];

    return (
        <>
            <Select value={currentBranch || ''} onValueChange={handleValueChange} disabled={loading}>
                <SelectTrigger className="h-5 w-auto gap-1.5 border-none bg-transparent px-1.5 text-[11px] rounded-full focus:ring-0 focus:ring-offset-0 data-[size=default]:h-5 data-[size=default]:px-1.5 data-[size=default]:py-0 [&>svg:last-child]:w-3 [&>svg:last-child]:h-3 [&>svg:last-child]:opacity-50 duration-300 hover:-translate-y-0.5 transition-all cursor-pointer" style={{ color: 'var(--text-primary)' }}>
                    <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} strokeWidth={1.5} />
                    <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent className="min-w-[140px] rounded-lg" style={{ background: 'var(--bg-elevated)', borderColor: 'var(--border-medium)', color: 'var(--text-primary)' }}>
                    <SelectGroup>
                        <SelectLabel className="text-xs" style={{ color: 'var(--text-muted)' }}>{localBranches.length > 0 ? 'Local Branches' : 'No branches'}</SelectLabel>
                        {localBranches.map(b => (
                            <SelectItem 
                                key={b} 
                                value={b}
                                className="text-xs cursor-pointer rounded"
                                style={{ color: 'var(--text-primary)' }}
                            >
                                {b}
                            </SelectItem>
                        ))}
                    </SelectGroup>
                    <SelectItem 
                        value="create-new" 
                        className="text-xs cursor-pointer rounded"
                        style={{ color: 'var(--accent-primary)' }}
                    >
                        <span className="flex items-center gap-1.5">
                            <Plus className="w-3 h-3" />
                            Create Branch
                        </span>
                    </SelectItem>
                </SelectContent>
            </Select>

            {/* Checkout conflict dialog */}
            {checkoutConflict && (
                <CheckoutConflictDialog
                    slug={slug}
                    branch={checkoutConflict.branch}
                    create={checkoutConflict.create}
                    onClose={handleCloseConflictDialog}
                />
            )}
        </>
    );
}
