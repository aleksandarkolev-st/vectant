import React, { useEffect, useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
    fetchGitStatus,
    checkoutBranch,
    clearCheckoutConflict,
    clearError,
    pushChanges,
    pullChanges,
    fetchRemote,
    forceRefreshGitStatus,
    mergeBranchForConflicts,
} from '@/redux/gitSlice';
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
import {
    ContextMenu,
    useContextMenu,
} from '@/components/docking-wm/components/ContextMenu';

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
    const { menuState, openMenu, closeMenu } = useContextMenu();

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

    const copy = useCallback((text) => {
        if (!text) return;
        navigator.clipboard.writeText(text).then(
            () => toast.success(`Copied "${text}"`),
            () => toast.error('Copy failed'),
        );
    }, []);

    // Right-click on the branch pill itself → operate on the CURRENT branch.
    const handleTriggerContextMenu = useCallback((e) => {
        openMenu(e, [
            {
                id: 'push',
                label: 'Push',
                disabled: !currentBranch,
                action: () => dispatch(pushChanges({ slug, force: false })),
            },
            {
                id: 'pull',
                label: 'Pull',
                disabled: !currentBranch,
                action: () => dispatch(pullChanges(slug)),
            },
            {
                id: 'fetch',
                label: 'Fetch',
                dividerAfter: true,
                action: () => dispatch(fetchRemote(slug)),
            },
            {
                id: 'copy-current',
                label: 'Copy Branch Name',
                disabled: !currentBranch,
                action: () => copy(currentBranch),
            },
            {
                id: 'refresh',
                label: 'Refresh',
                dividerAfter: true,
                action: () => dispatch(forceRefreshGitStatus(slug)),
            },
            {
                id: 'create-new',
                label: 'Create Branch…',
                action: () => handleValueChange('create-new'),
            },
        ]);
    }, [currentBranch, slug, dispatch, openMenu, handleValueChange, copy]);

    // Right-click on a branch row in the dropdown → operate on THAT branch.
    const handleBranchContextMenu = useCallback((e, branch) => {
        const isCurrent = branch === currentBranch;
        const target = currentBranch || 'current';
        openMenu(e, [
            {
                id: 'checkout',
                label: 'Checkout',
                disabled: isCurrent,
                action: () => handleValueChange(branch),
            },
            {
                id: 'copy-name',
                label: 'Copy Branch Name',
                dividerAfter: true,
                action: () => copy(branch),
            },
            {
                id: 'merge',
                label: `Merge into ${target}`,
                disabled: isCurrent || !currentBranch,
                action: async () => {
                    const ok = window.confirm(`Merge "${branch}" into "${currentBranch}"?`);
                    if (!ok) return;
                    const result = await dispatch(mergeBranchForConflicts({ slug, branch }));
                    if (mergeBranchForConflicts.fulfilled.match(result)) {
                        if (result.payload?.hasConflicts) {
                            toast.warning(`Merge of ${branch} produced conflicts`);
                        } else {
                            toast.success(`Merged ${branch} into ${currentBranch}`);
                        }
                    } else {
                        toast.error(result.payload?.message || result.error?.message || 'Merge failed');
                    }
                },
            },
        ]);
    }, [currentBranch, slug, dispatch, openMenu, handleValueChange, copy]);

    // Ensure branches.local is an array
    const localBranches = Array.isArray(branches?.local) ? branches.local : [];

    return (
        <>
            <Select value={currentBranch || ''} onValueChange={handleValueChange} disabled={loading}>
                <SelectTrigger
                    onContextMenu={handleTriggerContextMenu}
                    className="h-5 w-auto gap-1.5 border-none bg-transparent px-1.5 text-[11px] rounded-full focus:ring-0 focus:ring-offset-0 data-[size=default]:h-5 data-[size=default]:px-1.5 data-[size=default]:py-0 [&>svg:last-child]:w-3 [&>svg:last-child]:h-3 [&>svg:last-child]:opacity-50 duration-300 hover:-translate-y-0.5 transition-all cursor-pointer"
                    style={{ color: 'var(--text-primary)' }}
                >
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
                                onContextMenu={(e) => handleBranchContextMenu(e, b)}
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

            {menuState && <ContextMenu {...menuState} onClose={closeMenu} />}

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
