import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { gitClient } from '@/services/gitClient';
import collabClient from '@/services/collabClient';

/**
 * Read the global GitHub token from localStorage.
 * Falls back to the per-workspace PR token if no global token is set.
 */
function getGitToken(slug) {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem('synthi:global-github-token')
        || localStorage.getItem(`synthi:github-token:${slug}`)
        || null;
}

// Track a queued re-fetch so that when a fetchGitStatus is in-flight and
// another request arrives, we automatically re-fetch once the current one
// finishes rather than silently dropping the request.
let _pendingRefetchSlug = null;

/**
 * Force-refresh git status bypassing the dedup guard.
 * Used after mutations (stage, unstage, commit…) where we MUST get fresh data.
 */
export const forceRefreshGitStatus = createAsyncThunk(
    'git/forceRefreshStatus',
    async (slug) => {
        const status = await gitClient.getStatus(slug);
        const branches = await gitClient.getBranches(slug);
        return { status, branches };
    }
);

export const fetchGitStatus = createAsyncThunk(
    'git/fetchStatus',
    async (slug, { dispatch }) => {
        const status = await gitClient.getStatus(slug);
        const branches = await gitClient.getBranches(slug);
        // If another request was queued while we were in-flight, re-dispatch
        // after returning so the caller (reducer) marks _statusFetching = false
        // before the next fetch starts.
        if (_pendingRefetchSlug) {
            const queuedSlug = _pendingRefetchSlug;
            _pendingRefetchSlug = null;
            // Use queueMicrotask to dispatch after the fulfilled reducer runs
            queueMicrotask(() => dispatch(fetchGitStatus(queuedSlug)));
        }
        return { status, branches };
    },
    {
        // Prevent redundant concurrent fetches — if a fetchGitStatus is already
        // in-flight, queue a re-fetch for when it completes instead of dropping.
        condition: (slug, { getState }) => {
            const { git } = getState();
            if (git._statusFetching) {
                _pendingRefetchSlug = slug;
                return false;
            }
        },
    }
);

export const checkoutBranch = createAsyncThunk(
    'git/checkout',
    async ({ slug, branch, create }, { dispatch }) => {
        await gitClient.checkout(slug, branch, create);
        // Refresh status AND unpushed so the UI immediately reflects the
        // correct ahead/behind count for the newly active branch.
        dispatch(fetchGitStatus(slug));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    }
);

export const syncFileToGit = createAsyncThunk(
    'git/syncFile',
    async ({ slug, filePath, content }) => {
        await gitClient.syncFile(slug, filePath, content);
    }
);

export const fetchRemote = createAsyncThunk(
    'git/fetchRemote',
    async (slug, { dispatch }) => {
        const token = getGitToken(slug);
        await gitClient.fetch(slug, token);
        dispatch(fetchGitStatus(slug));
    }
);

export const fetchCommitHistory = createAsyncThunk(
    'git/fetchLog',
    async ({ slug, page = 1, limit = 50 }) => {
        return await gitClient.getLog(slug, page, limit);
    }
);

export const fetchUnpushedCommits = createAsyncThunk(
    'git/fetchUnpushed',
    async ({ slug, max = 50 }) => {
        return await gitClient.getUnpushed(slug, max);
    }
);

export const fetchIncomingCommits = createAsyncThunk(
    'git/fetchIncoming',
    async ({ slug, max = 50 }) => {
        return await gitClient.getIncoming(slug, max);
    }
);

export const initRepo = createAsyncThunk(
    'git/init',
    async ({ slug, remoteUrl }, { dispatch }) => {
        await gitClient.init(slug, remoteUrl);
        dispatch(fetchGitStatus(slug));
    }
);

export const addRemote = createAsyncThunk(
    'git/addRemote',
    async ({ slug, name, url }, { dispatch }) => {
        await gitClient.addRemote(slug, name, url);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchRemotes(slug));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    }
);

export const removeRemote = createAsyncThunk(
    'git/removeRemote',
    async ({ slug, name }, { dispatch }) => {
        await gitClient.removeRemote(slug, name);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchRemotes(slug));
    }
);

export const setRemoteUrl = createAsyncThunk(
    'git/setRemoteUrl',
    async ({ slug, name, url }, { dispatch }) => {
        await gitClient.setRemoteUrl(slug, name, url);
        dispatch(fetchRemotes(slug));
    }
);

export const fetchRemotes = createAsyncThunk(
    'git/fetchRemotes',
    async (slug) => {
        return await gitClient.getRemotes(slug);
    }
);

export const cloneRepo = createAsyncThunk(
    'git/clone',
    async ({ slug, repoUrl, token }, { dispatch }) => {
        await gitClient.clone(slug, repoUrl, token);
        dispatch(fetchGitStatus(slug));
    }
);

export const commitChanges = createAsyncThunk(
    'git/commit',
    async ({ slug, message, amend }, { dispatch }) => {
        await gitClient.commit(slug, message, amend);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchCommitHistory({ slug }));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
        // After a commit (especially merge commit), refresh incoming to clear merged commits
        dispatch(fetchIncomingCommits({ slug, max: 50 }));
    }
);

export const cherryPickCommit = createAsyncThunk(
    'git/cherryPick',
    async ({ slug, hash }, { dispatch }) => {
        await gitClient.cherryPick(slug, hash);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchCommitHistory({ slug }));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    }
);

export const revertCommit = createAsyncThunk(
    'git/revert',
    async ({ slug, hash }, { dispatch }) => {
        await gitClient.revertCommit(slug, hash);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchCommitHistory({ slug }));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
    }
);

export const fetchCommitDetail = createAsyncThunk(
    'git/fetchCommitDetail',
    async ({ slug, hash }) => {
        return await gitClient.getCommitDetail(slug, hash);
    }
);

export const stageFile = createAsyncThunk(
    'git/stage',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.stageFile(slug, filePath);
        dispatch(forceRefreshGitStatus(slug));
    }
);

export const stageAll = createAsyncThunk(
    'git/stageAll',
    async (slug, { dispatch }) => {
        await gitClient.stageAll(slug);
        dispatch(forceRefreshGitStatus(slug));
    }
);

export const stageLines = createAsyncThunk(
    'git/stageLines',
    async ({ slug, filePath, patch }, { dispatch }) => {
        await gitClient.stageLines(slug, filePath, patch);
        dispatch(forceRefreshGitStatus(slug));
    }
);

export const fetchFileDiff = createAsyncThunk(
    'git/fetchFileDiff',
    async ({ slug, filePath }) => {
        return await gitClient.getDiff(slug, filePath, true);
    }
);

export const unstageFile = createAsyncThunk(
    'git/unstage',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.unstageFile(slug, filePath);
        dispatch(forceRefreshGitStatus(slug));
    }
);

export const unstageAll = createAsyncThunk(
    'git/unstageAll',
    async (slug, { dispatch }) => {
        await gitClient.unstageAll(slug);
        dispatch(forceRefreshGitStatus(slug));
    }
);

export const pushChanges = createAsyncThunk(
    'git/push',
    async (slug, { dispatch }) => {
        const token = getGitToken(slug);
        await gitClient.push(slug, token);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
        dispatch(fetchCommitHistory({ slug }));
        dispatch(fetchRemotes(slug));
    }
);

export const pullChanges = createAsyncThunk(
    'git/pull',
    async (slug, { dispatch, rejectWithValue }) => {
        try {
            const token = getGitToken(slug);
            const result = await gitClient.pull(slug, token);
            dispatch(fetchGitStatus(slug));
            dispatch(fetchUnpushedCommits({ slug, max: 50 }));
            dispatch(fetchCommitHistory({ slug }));
            
            // If pull resulted in conflicts (shouldn't normally happen here since server throws)
            if (result && (result.hasConflicts || result.conflicted?.length > 0)) {
                // fetchGitStatus (dispatched above) will populate status.conflictedFiles
                // from the server, which the UI reads for the conflict list.
                console.log('[Git] Pull returned conflict state — refreshing status');
            }
            
            return result;
        } catch (error) {
            // ── Pre-condition failure: uncommitted changes block the pull ──
            // MUST be checked BEFORE MERGE_CONFLICT because the legacy server
            // mapped both to HTTP 409.  error.code is authoritative.
            if (error.code === 'UNCOMMITTED_CHANGES') {
                return rejectWithValue({
                    code: 'UNCOMMITTED_CHANGES',
                    message: error.message || 'You have uncommitted changes that would be overwritten. Please commit or stash them first.',
                });
            }

            // ── Real merge conflict ──
            if (error.code === 'MERGE_CONFLICT' || error.statusCode === 409) {
                // Server sends conflictedFiles in details
                const conflictedFiles = error.details?.conflictedFiles || error.details?.conflicted || [];
                
                console.log('[Git] Merge conflict detected, files:', conflictedFiles);
                
                // Clear Yjs collab persistence for conflicted files to ensure fresh content loads
                if (conflictedFiles.length > 0) {
                    try {
                        await gitClient.clearCollabPersistence(slug, conflictedFiles);
                        console.log('[Git] Cleared collab persistence for conflicted files');
                    } catch (e) {
                        console.warn('[Git] Failed to clear collab persistence:', e);
                    }
                }
                
                // fetchGitStatus (dispatched below) will populate status.conflictedFiles
                // from the server's getStatus(), which the UI reads for the conflict list.
                
                // Still refresh git status to show the conflicts in UI
                dispatch(fetchGitStatus(slug));
                dispatch(fetchUnpushedCommits({ slug, max: 50 }));
                dispatch(fetchCommitHistory({ slug }));
                
                // Return a special payload instead of rejecting
                return rejectWithValue({
                    code: 'MERGE_CONFLICT',
                    message: error.message,
                    conflicted: conflictedFiles
                });
            }

            throw error;
        }
    }
);

export const discardChange = createAsyncThunk(
    'git/discard',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.discardChange(slug, filePath);
        // Do NOT call collabClient.destroyDocument() here — the server
        // closes the Yjs WebSocket connections when it invalidates the doc,
        // and then broadcasts 'file-reverted' which Editor.jsx handles by
        // properly tearing down the binding, destroying the document, and
        // re-fetching clean content.  Calling destroyDocument here races
        // with that handler: if file-reverted arrives first and re-creates
        // the doc, this call would destroy the fresh doc, leaving the
        // editor without a Yjs binding.
        dispatch(fetchGitStatus(slug));
    }
);

export const discardAll = createAsyncThunk(
    'git/discardAll',
    async (slug, { dispatch, getState }) => {
        await gitClient.discardAll(slug);
        // Same reasoning as discardChange — let the server-side invalidation
        // + file-reverted broadcast handle the Yjs doc lifecycle.
        dispatch(fetchGitStatus(slug));
    }
);

// Stash operations
export const fetchStashList = createAsyncThunk(
    'git/fetchStashList',
    async (slug) => {
        return await gitClient.stashList(slug);
    }
);

export const stashPush = createAsyncThunk(
    'git/stashPush',
    async ({ slug, message }, { dispatch }) => {
        await gitClient.stashPush(slug, message);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchStashList(slug));
    }
);

export const stashPop = createAsyncThunk(
    'git/stashPop',
    async ({ slug, index = 0 }, { dispatch }) => {
        await gitClient.stashPop(slug, index);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchStashList(slug));
    }
);

export const stashApply = createAsyncThunk(
    'git/stashApply',
    async ({ slug, index = 0 }, { dispatch }) => {
        await gitClient.stashApply(slug, index);
        dispatch(fetchGitStatus(slug));
    }
);

export const stashDrop = createAsyncThunk(
    'git/stashDrop',
    async ({ slug, index = 0 }, { dispatch }) => {
        await gitClient.stashDrop(slug, index);
        dispatch(fetchStashList(slug));
    }
);

// Blame
export const fetchBlame = createAsyncThunk(
    'git/fetchBlame',
    async ({ slug, filePath }) => {
        return await gitClient.getBlame(slug, filePath);
    }
);

// Merge Conflict Resolution
export const resolveConflictOurs = createAsyncThunk(
    'git/resolveConflictOurs',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.resolveConflictOurs(slug, filePath);
        dispatch(fetchGitStatus(slug));
    }
);

export const resolveConflictTheirs = createAsyncThunk(
    'git/resolveConflictTheirs',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.resolveConflictTheirs(slug, filePath);
        dispatch(fetchGitStatus(slug));
    }
);

export const markResolved = createAsyncThunk(
    'git/markResolved',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.markResolved(slug, filePath);
        dispatch(fetchGitStatus(slug));
        // Refresh incoming commits as conflict resolution progresses
        dispatch(fetchIncomingCommits({ slug, max: 50 }));
    }
);

export const abortMerge = createAsyncThunk(
    'git/abortMerge',
    async (slug, { dispatch }) => {
        await gitClient.abortMerge(slug);
        dispatch(fetchGitStatus(slug));
        // After aborting merge, incoming commits should reappear as still pending
        dispatch(fetchIncomingCommits({ slug, max: 50 }));
    }
);

export const fetchConflictVersions = createAsyncThunk(
    'git/fetchConflictVersions',
    async ({ slug, filePath }) => {
        return await gitClient.getConflictVersions(slug, filePath);
    }
);

const gitSlice = createSlice({
    name: 'git',
    initialState: {
        status: null,
        branches: { local: [], all: [] },
        remotes: [],
        commitHistory: { all: [], total: 0, page: 1, hasMore: false },
        unpushedCommits: [],
        incomingCommits: [],
        stashList: [],
        blameData: [],
        currentBranch: 'main',
        loading: false,
        _statusFetching: false, // de-dup guard for fetchGitStatus
        // actionError persists until explicitly dismissed by user or next
        // user-initiated action — background refreshes never clear it.
        actionError: null,
        actionErrorCode: null,
        error: null,
        errorCode: null, // For structured error handling
        // The file path currently open in the Merge Conflict Editor.
        // When set, the main editor area renders MergeConflictEditor
        // instead of the standard Monaco editor.
        conflictResolverFile: null,
        // Commit detail for the expanded commit in history
        commitDetail: null,
        commitDetailLoading: false,
    },
    reducers: {
        clearError: (state) => {
            state.error = null;
            state.errorCode = null;
            state.actionError = null;
            state.actionErrorCode = null;
        },
        openConflictResolver: (state, action) => {
            state.conflictResolverFile = action.payload; // filePath string
        },
        closeConflictResolver: (state) => {
            state.conflictResolverFile = null;
        },
    },
    extraReducers: (builder) => {
        // ── Background refresh thunks ─────────────────────────
        // These NEVER touch actionError so user-facing errors persist.
        builder
            .addCase(fetchGitStatus.pending, (state) => {
                state.loading = true;
                state._statusFetching = true;
            })
            .addCase(fetchGitStatus.fulfilled, (state, action) => {
                state.loading = false;
                state._statusFetching = false;
                state.error = null;
                state.status = action.payload.status;
                state.branches = action.payload.branches || { local: [], all: [] };
                if (action.payload.status) {
                    state.currentBranch = action.payload.status.current;
                    // Auto-close conflict resolver if conflicts are gone
                    const stillConflicted = action.payload.status.conflictedFiles ?? [];
                    if (state.conflictResolverFile && !stillConflicted.includes(state.conflictResolverFile)) {
                        state.conflictResolverFile = null;
                    }
                }
            })
            .addCase(fetchGitStatus.rejected, (state, action) => {
                state.loading = false;
                state._statusFetching = false;
                state.error = action.error.message;
                state.errorCode = action.error.code || null;
            })
            // forceRefreshGitStatus — same reducers, bypasses dedup guard
            .addCase(forceRefreshGitStatus.pending, (state) => {
                state.loading = true;
            })
            .addCase(forceRefreshGitStatus.fulfilled, (state, action) => {
                state.loading = false;
                state.error = null;
                state.status = action.payload.status;
                state.branches = action.payload.branches || { local: [], all: [] };
                if (action.payload.status) {
                    state.currentBranch = action.payload.status.current;
                    const stillConflicted = action.payload.status.conflictedFiles ?? [];
                    if (state.conflictResolverFile && !stillConflicted.includes(state.conflictResolverFile)) {
                        state.conflictResolverFile = null;
                    }
                }
            })
            .addCase(forceRefreshGitStatus.rejected, (state, action) => {
                state.loading = false;
                state.error = action.error.message;
                state.errorCode = action.error.code || null;
            });

        builder
            .addCase(fetchCommitHistory.pending, (state) => { state.loading = true; })
            .addCase(fetchCommitHistory.fulfilled, (state, action) => { 
                state.loading = false; 
                state.commitHistory = action.payload || { all: [], total: 0, page: 1, hasMore: false }; 
            })
            .addCase(fetchCommitHistory.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(fetchUnpushedCommits.pending, (state) => { state.loading = true; })
            .addCase(fetchUnpushedCommits.fulfilled, (state, action) => { state.loading = false; state.unpushedCommits = action.payload || []; })
            .addCase(fetchUnpushedCommits.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(fetchIncomingCommits.pending, (state) => { state.loading = true; })
            .addCase(fetchIncomingCommits.fulfilled, (state, action) => { state.loading = false; state.incomingCommits = action.payload || []; })
            .addCase(fetchIncomingCommits.rejected, (state, action) => { state.loading = false; state.error = action.error.message; });
        
        builder
            .addCase(fetchStashList.fulfilled, (state, action) => { state.stashList = action.payload || []; })
            .addCase(fetchBlame.fulfilled, (state, action) => { state.blameData = action.payload || []; });
        
        builder
            .addCase(fetchRemotes.fulfilled, (state, action) => {
                state.remotes = action.payload;
            });

        // ── User-initiated action thunks ──────────────────────
        // These write to actionError on failure and clear it on next attempt.
        builder
            .addCase(initRepo.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(initRepo.fulfilled, (state) => { state.loading = false; })
            .addCase(initRepo.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(cloneRepo.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(cloneRepo.fulfilled, (state) => { state.loading = false; })
            .addCase(cloneRepo.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(addRemote.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(addRemote.fulfilled, (state) => { state.loading = false; })
            .addCase(addRemote.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(setRemoteUrl.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(setRemoteUrl.fulfilled, (state) => { state.loading = false; })
            .addCase(setRemoteUrl.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(stageLines.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(stageLines.fulfilled, (state) => { state.loading = false; })
            .addCase(stageLines.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(cherryPickCommit.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(cherryPickCommit.fulfilled, (state) => { state.loading = false; })
            .addCase(cherryPickCommit.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(revertCommit.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(revertCommit.fulfilled, (state) => { state.loading = false; })
            .addCase(revertCommit.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(fetchCommitDetail.pending, (state) => { state.commitDetailLoading = true; })
            .addCase(fetchCommitDetail.fulfilled, (state, action) => { state.commitDetailLoading = false; state.commitDetail = action.payload; })
            .addCase(fetchCommitDetail.rejected, (state) => { state.commitDetailLoading = false; state.commitDetail = null; })
            .addCase(pushChanges.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(pushChanges.fulfilled, (state) => { state.loading = false; })
            .addCase(pushChanges.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; })
            .addCase(pullChanges.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(pullChanges.fulfilled, (state) => { state.loading = false; })
            .addCase(pullChanges.rejected, (state, action) => { 
                state.loading = false; 
                if (action.payload?.code === 'MERGE_CONFLICT') {
                    const files = action.payload.conflicted || [];
                    state.actionError = `Merge conflict: ${files.length} file${files.length !== 1 ? 's' : ''} need resolution`;
                    state.actionErrorCode = 'MERGE_CONFLICT';
                } else if (action.payload?.code === 'UNCOMMITTED_CHANGES' || action.meta?.rejectedWithValue && action.payload?.code === 'UNCOMMITTED_CHANGES') {
                    state.actionError = action.payload?.message || 'You have uncommitted changes that would be overwritten. Please commit or stash them first.';
                    state.actionErrorCode = 'UNCOMMITTED_CHANGES';
                } else {
                    state.actionError = action.error?.message || action.payload?.message || 'Pull failed';
                    state.actionErrorCode = action.error?.code || null;
                }
            })
            .addCase(commitChanges.pending, (state) => {
                state.loading = true; state.actionError = null; state.actionErrorCode = null;
                // Optimistic: snapshot current files and clear staged entries
                if (state.status?.files) {
                    state._preCommitFiles = JSON.parse(JSON.stringify(state.status.files));
                    // Remove all staged files from the list (they'll be committed)
                    state.status.files = state.status.files.filter(f => f.index === ' ' || f.index === '?');
                }
            })
            .addCase(commitChanges.fulfilled, (state) => {
                state.loading = false;
                delete state._preCommitFiles;
            })
            .addCase(commitChanges.rejected, (state, action) => {
                state.loading = false;
                state.actionError = action.error.message;
                state.actionErrorCode = action.error.code || null;
                // Rollback: restore staged files
                if (state._preCommitFiles && state.status) {
                    state.status.files = state._preCommitFiles;
                }
                delete state._preCommitFiles;
            });
        
        // Staging/discard actions — Optimistic UI with rollback
        builder
            .addCase(stageFile.pending, (state, action) => {
                if (!state.status?.files) return;
                state._preStageFiles = JSON.parse(JSON.stringify(state.status.files));
                const fp = action.meta.arg?.filePath;
                if (!fp) return;
                const file = state.status.files.find(f => f.path === fp);
                if (file) {
                    if (file.working_dir === '?' || file.index === '?') {
                        file.index = 'A'; file.working_dir = ' ';
                    } else if (file.working_dir !== ' ') {
                        file.index = file.working_dir; file.working_dir = ' ';
                    }
                }
            })
            .addCase(stageFile.fulfilled, (state) => { delete state._preStageFiles; })
            .addCase(stageFile.rejected, (state, action) => {
                if (state._preStageFiles) { state.status.files = state._preStageFiles; delete state._preStageFiles; }
                state.actionError = action.error.message;
            })
            .addCase(unstageFile.pending, (state, action) => {
                if (!state.status?.files) return;
                state._preStageFiles = JSON.parse(JSON.stringify(state.status.files));
                const fp = action.meta.arg?.filePath;
                if (!fp) return;
                const file = state.status.files.find(f => f.path === fp);
                if (file) {
                    if (file.index === 'A') {
                        file.index = '?'; file.working_dir = '?';
                    } else if (file.index !== ' ' && file.index !== '?') {
                        file.working_dir = file.index; file.index = ' ';
                    }
                }
            })
            .addCase(unstageFile.fulfilled, (state) => { delete state._preStageFiles; })
            .addCase(unstageFile.rejected, (state, action) => {
                if (state._preStageFiles) { state.status.files = state._preStageFiles; delete state._preStageFiles; }
                state.actionError = action.error.message;
            })
            .addCase(stageAll.pending, (state) => {
                if (!state.status?.files) return;
                state._preStageFiles = JSON.parse(JSON.stringify(state.status.files));
                for (const file of state.status.files) {
                    if (file.working_dir === '?' || file.index === '?') {
                        file.index = 'A'; file.working_dir = ' ';
                    } else if (file.working_dir !== ' ') {
                        file.index = file.working_dir; file.working_dir = ' ';
                    }
                }
            })
            .addCase(stageAll.fulfilled, (state) => { delete state._preStageFiles; })
            .addCase(stageAll.rejected, (state, action) => {
                if (state._preStageFiles) { state.status.files = state._preStageFiles; delete state._preStageFiles; }
                state.actionError = action.error.message;
            })
            .addCase(unstageAll.pending, (state) => {
                if (!state.status?.files) return;
                state._preStageFiles = JSON.parse(JSON.stringify(state.status.files));
                for (const file of state.status.files) {
                    if (file.index === 'A') {
                        file.index = '?'; file.working_dir = '?';
                    } else if (file.index !== ' ' && file.index !== '?') {
                        file.working_dir = file.index; file.index = ' ';
                    }
                }
            })
            .addCase(unstageAll.fulfilled, (state) => { delete state._preStageFiles; })
            .addCase(unstageAll.rejected, (state, action) => {
                if (state._preStageFiles) { state.status.files = state._preStageFiles; delete state._preStageFiles; }
                state.actionError = action.error.message;
            })
            .addCase(discardChange.rejected, (state, action) => { state.actionError = action.error.message; })
            .addCase(discardAll.rejected, (state, action) => { state.actionError = action.error.message; })
            .addCase(stashPush.rejected, (state, action) => { state.actionError = action.error.message; })
            .addCase(stashPop.rejected, (state, action) => { state.actionError = action.error.message; })
            .addCase(stashDrop.rejected, (state, action) => { state.actionError = action.error.message; });

        // Merge conflict resolution handlers
        builder
            .addCase(resolveConflictOurs.pending, (state) => { state.loading = true; state.actionError = null; })
            .addCase(resolveConflictOurs.fulfilled, (state) => { state.loading = false; })
            .addCase(resolveConflictOurs.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; })
            .addCase(resolveConflictTheirs.pending, (state) => { state.loading = true; state.actionError = null; })
            .addCase(resolveConflictTheirs.fulfilled, (state) => { state.loading = false; })
            .addCase(resolveConflictTheirs.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; })
            .addCase(markResolved.pending, (state) => { state.loading = true; state.actionError = null; })
            .addCase(markResolved.fulfilled, (state) => { state.loading = false; })
            .addCase(markResolved.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; })
            .addCase(abortMerge.pending, (state) => { state.loading = true; state.actionError = null; })
            .addCase(abortMerge.fulfilled, (state) => { state.loading = false; state.conflictResolverFile = null; })
            .addCase(abortMerge.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; });
    },
});

export const { clearError, openConflictResolver, closeConflictResolver } = gitSlice.actions;
export default gitSlice.reducer;
