import React, { useEffect, useState, useCallback, useMemo } from 'react';
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
import { useConfirmDialog } from '@/components/ui/useConfirmDialog';
import { usePromptDialog } from '@/components/ui/usePromptDialog';

/* ─── Checkout Conflict Dialog ─────────────────────── */
function CheckoutConflictDialog({ slug, branch, create, onClose }) {
    const dispatch = useDispatch();
    const { confirm, confirmDialog } = useConfirmDialog();
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
        const ok = await confirm({
            title: 'Discard local changes?',
            message: `Switching to ${branch} with discard enabled will drop uncommitted work in this workspace. This cannot be undone.`,
            confirmLabel: 'Discard and switch',
            cancelLabel: 'Keep changes',
            tone: 'danger',
        });
        if (!ok) return;
        setBusy(true);
        const result = await dispatch(checkoutBranch({ slug, branch, create, mode: 'force' }));
        setBusy(false);
        if (checkoutBranch.fulfilled.match(result)) {
            toast.success(`Discarded local changes and switched to ${branch}`);
            dispatch(refreshWorkspaceThunk());
            onClose();
        } else {
            toast.error(result.payload?.message || result.error?.message || 'Checkout failed');
        }
    };

    return (
        <div
            className="fixed inset-0 z-40 flex items-center justify-center"
            style={{ background: 'color-mix(in srgb, var(--bg-app) 76%, transparent)' }}
        >
            <div className="vt-dialog-surface w-[380px] p-4">
                <div className="flex items-start gap-2.5 mb-3">
                    <AlertTriangle className="w-5 h-5 flex-shrink-0 mt-0.5" style={{ color: 'var(--accent-warning)' }} />
                    <div>
                        <h3 className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>
                            Uncommitted changes
                        </h3>
                        <p className="text-xs mt-1 leading-relaxed" style={{ color: 'var(--text-secondary)' }}>
                            Local changes would be overwritten by switching to <strong className="font-mono text-[11px]" style={{ color: 'var(--text-primary)' }}>{branch}</strong>.
                        </p>
                    </div>
                </div>

                <div className="space-y-1.5 mb-3">
                    <button
                        onClick={handleStashAndCheckout}
                        disabled={busy}
                        className="w-full flex items-center gap-2 px-3 py-2 rounded-lg text-xs font-medium transition-colors border disabled:opacity-50"
                        style={{
                            background: 'color-mix(in srgb, var(--accent-primary) 10%, transparent)',
                            borderColor: 'color-mix(in srgb, var(--accent-primary) 30%, transparent)',
                            color: 'var(--accent-primary)'
                        }}
                    >
                        <Archive className="w-3.5 h-3.5" />
                        Stash and switch
                        <span className="ml-auto text-[10px] opacity-60">keeps changes</span>
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
                        Discard and switch
                        <span className="ml-auto text-[10px] opacity-60">requires confirm</span>
                    </button>
                </div>

                <button
                    onClick={onClose}
                    disabled={busy}
                    className="th-focus-ring th-btn-ghost w-full py-1.5 rounded-lg text-xs font-medium transition-colors border"
                    style={{ borderColor: 'var(--border-medium)', color: 'var(--text-secondary)' }}
                >
                    Cancel
                </button>
                {confirmDialog}
            </div>
        </div>
    );
}

export function BranchSelector({ slug }) {
    const dispatch = useDispatch();
    const { branches, currentBranch, loading, checkoutConflict, status, unpushedCommits, incomingCommits } = useSelector(state => state.git);
    const { menuState, openMenu, closeMenu } = useContextMenu();
    const { confirm, confirmDialog } = useConfirmDialog();
    const { prompt, promptDialog } = usePromptDialog();

    useEffect(() => {
        if (slug) {
            dispatch(fetchGitStatus(slug));
        }
    }, [slug, dispatch]);

    const handleValueChange = useCallback(async (value) => {
        if (value === 'create-new') {
            const branchName = await prompt({
                title: 'Create branch',
                message: currentBranch ? `Base: ${currentBranch}` : 'Create a local branch in this workspace.',
                placeholder: 'feature/workspace-update',
                confirmLabel: 'Create branch',
            });
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
    }, [currentBranch, dispatch, prompt, slug]);

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
                    const ok = await confirm({
                        title: 'Merge branch?',
                        message: `"${branch}" into "${currentBranch}"`,
                        confirmLabel: 'Merge',
                        tone: 'warning',
                    });
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
    const branchCountLabel = `${localBranches.length} local`;
    const fileChangeCount = Array.isArray(status?.files) ? status.files.length : 0;
    const aheadCount = Array.isArray(unpushedCommits) && unpushedCommits.length > 0 ? unpushedCommits.length : (status?.ahead ?? 0);
    const behindCount = Array.isArray(incomingCommits) && incomingCommits.length > 0 ? incomingCommits.length : (status?.behind ?? 0);
    const repoHealthItems = useMemo(() => {
        const items = [];
        if (fileChangeCount > 0) items.push(['Dirty', fileChangeCount]);
        if (aheadCount > 0) items.push(['Ahead', aheadCount]);
        if (behindCount > 0) items.push(['Behind', behindCount]);
        return items.length > 0 ? items : [['Clean', 0]];
    }, [aheadCount, behindCount, fileChangeCount]);

    return (
        <>
            <Select value={currentBranch || ''} onValueChange={handleValueChange} disabled={loading}>
                <SelectTrigger
                    onContextMenu={handleTriggerContextMenu}
                    className="vt-branch-trigger th-focus-ring h-5 w-auto gap-1.5 border-none bg-transparent px-1.5 text-[11px] rounded-full focus:ring-0 focus:ring-offset-0 data-[size=default]:h-5 data-[size=default]:px-1.5 data-[size=default]:py-0 [&>svg:last-child]:w-3 [&>svg:last-child]:h-3 [&>svg:last-child]:opacity-50 transition-colors cursor-pointer"
                    style={{ color: 'var(--text-primary)' }}
                    aria-label={currentBranch ? `Current branch ${currentBranch}` : 'Select branch'}
                >
                    <GitBranch className="w-3.5 h-3.5" style={{ color: 'var(--accent-primary)' }} strokeWidth={1.5} />
                    <SelectValue placeholder="Select branch" />
                </SelectTrigger>
                <SelectContent
                    position="popper"
                    side="top"
                    align="start"
                    sideOffset={10}
                    className="vt-branch-menu w-[260px] p-1.5"
                    style={{ color: 'var(--text-primary)' }}
                >
                    <SelectGroup>
                        <SelectLabel className="vt-branch-menu__label">
                            <span>Repository</span>
                            <span>{branchCountLabel}</span>
                        </SelectLabel>
                        <div className="vt-branch-health" aria-label="Repository health">
                            {repoHealthItems.map(([label, value]) => (
                                <span key={label} className={value > 0 ? 'is-active' : ''}>
                                    <strong>{value}</strong>
                                    {label}
                                </span>
                            ))}
                        </div>
                        {localBranches.map(b => (
                            <SelectItem
                                key={b}
                                value={b}
                                onContextMenu={(e) => handleBranchContextMenu(e, b)}
                                className="vt-branch-option text-xs cursor-pointer rounded"
                                style={{ color: 'var(--text-primary)' }}
                            >
                                <span className="flex min-w-0 items-center gap-2">
                                    <GitBranch className="h-3.5 w-3.5 shrink-0" style={{ color: b === currentBranch ? 'var(--accent-primary)' : 'var(--text-muted)' }} strokeWidth={1.75} />
                                    <span className="truncate font-mono text-[11px]">{b}</span>
                                </span>
                            </SelectItem>
                        ))}
                    </SelectGroup>
                    <SelectItem
                        value="create-new"
                        className="vt-branch-option vt-branch-option--create mt-1 text-xs cursor-pointer rounded"
                        style={{ color: 'var(--accent-primary)' }}
                    >
                        <span className="flex items-center gap-1.5">
                            <Plus className="w-3 h-3" />
                            New branch
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
            {confirmDialog}
            {promptDialog}
        </>
    );
}
