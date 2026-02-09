import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { gitClient } from '@/services/gitClient';

export const fetchGitStatus = createAsyncThunk(
    'git/fetchStatus',
    async (slug) => {
        const status = await gitClient.getStatus(slug);
        const branches = await gitClient.getBranches(slug);
        return { status, branches };
    },
    {
        // Prevent redundant concurrent fetches — if a fetchGitStatus is already
        // in-flight (state.git.loading === true from this thunk), skip.
        condition: (_, { getState }) => {
            const { git } = getState();
            // Only block if loading is specifically from a status fetch.
            // We use a dedicated flag to avoid conflating with other thunks
            // that also set `loading`.
            if (git._statusFetching) return false;
        },
    }
);

export const checkoutBranch = createAsyncThunk(
    'git/checkout',
    async ({ slug, branch, create }, { dispatch }) => {
        await gitClient.checkout(slug, branch, create);
        dispatch(fetchGitStatus(slug));
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
        await gitClient.fetch(slug);
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
    async ({ slug, message }, { dispatch }) => {
        await gitClient.commit(slug, message);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchCommitHistory({ slug }));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
        // After a commit (especially merge commit), refresh incoming to clear merged commits
        dispatch(fetchIncomingCommits({ slug, max: 50 }));
    }
);

export const stageFile = createAsyncThunk(
    'git/stage',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.stageFile(slug, filePath);
        dispatch(fetchGitStatus(slug));
    }
);

export const stageAll = createAsyncThunk(
    'git/stageAll',
    async (slug, { dispatch }) => {
        await gitClient.stageAll(slug);
        dispatch(fetchGitStatus(slug));
    }
);

export const unstageFile = createAsyncThunk(
    'git/unstage',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.unstageFile(slug, filePath);
        dispatch(fetchGitStatus(slug));
    }
);

export const unstageAll = createAsyncThunk(
    'git/unstageAll',
    async (slug, { dispatch }) => {
        await gitClient.unstageAll(slug);
        dispatch(fetchGitStatus(slug));
    }
);

export const pushChanges = createAsyncThunk(
    'git/push',
    async (slug, { dispatch }) => {
        await gitClient.push(slug);
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
            const result = await gitClient.pull(slug);
            dispatch(fetchGitStatus(slug));
            dispatch(fetchUnpushedCommits({ slug, max: 50 }));
            dispatch(fetchCommitHistory({ slug }));
            
            // If pull resulted in conflicts (shouldn't normally happen here since server throws)
            if (result && (result.hasConflicts || result.conflicted?.length > 0)) {
                dispatch({ type: 'git/conflictsDetected', payload: result.conflicted || [] });
            }
            
            return result;
        } catch (error) {
            // Check if this is a merge conflict error
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
                
                // Dispatch conflict detection action to invalidate caches
                dispatch({ type: 'git/conflictsDetected', payload: conflictedFiles });
                
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
        dispatch(fetchGitStatus(slug));
    }
);

export const discardAll = createAsyncThunk(
    'git/discardAll',
    async (slug, { dispatch }) => {
        await gitClient.discardAll(slug);
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
    },
    reducers: {
        clearError: (state) => {
            state.error = null;
            state.errorCode = null;
            state.actionError = null;
            state.actionErrorCode = null;
        }
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
                }
            })
            .addCase(fetchGitStatus.rejected, (state, action) => {
                state.loading = false;
                state._statusFetching = false;
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
                } else {
                    state.actionError = action.error?.message || action.payload?.message || 'Pull failed';
                    state.actionErrorCode = action.error?.code || null;
                }
            })
            .addCase(commitChanges.pending, (state) => { state.loading = true; state.actionError = null; state.actionErrorCode = null; })
            .addCase(commitChanges.fulfilled, (state) => { state.loading = false; })
            .addCase(commitChanges.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; state.actionErrorCode = action.error.code || null; });
        
        // Staging/discard actions
        builder
            .addCase(stageFile.rejected, (state, action) => { state.actionError = action.error.message; })
            .addCase(unstageFile.rejected, (state, action) => { state.actionError = action.error.message; })
            .addCase(stageAll.rejected, (state, action) => { state.actionError = action.error.message; })
            .addCase(unstageAll.rejected, (state, action) => { state.actionError = action.error.message; })
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
            .addCase(abortMerge.fulfilled, (state) => { state.loading = false; })
            .addCase(abortMerge.rejected, (state, action) => { state.loading = false; state.actionError = action.error.message; });
    },
});

export const { clearError } = gitSlice.actions;
export default gitSlice.reducer;
