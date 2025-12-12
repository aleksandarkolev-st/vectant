import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import { gitClient } from '@/services/gitClient';

export const fetchGitStatus = createAsyncThunk(
    'git/fetchStatus',
    async (slug) => {
        const status = await gitClient.getStatus(slug);
        const branches = await gitClient.getBranches(slug);
        return { status, branches };
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
    async (slug, { dispatch }) => {
        const result = await gitClient.pull(slug);
        dispatch(fetchGitStatus(slug));
        dispatch(fetchUnpushedCommits({ slug, max: 50 }));
        dispatch(fetchCommitHistory({ slug }));
        return result;
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

const gitSlice = createSlice({
    name: 'git',
    initialState: {
        status: null,
        branches: { local: [], all: [] },
        remotes: [],
        commitHistory: { all: [], total: 0, page: 1, hasMore: false },
        unpushedCommits: [],
        stashList: [],
        blameData: [],
        currentBranch: 'main',
        loading: false,
        error: null,
        errorCode: null, // For structured error handling
    },
    reducers: {
        clearError: (state) => {
            state.error = null;
            state.errorCode = null;
        }
    },
    extraReducers: (builder) => {
        builder
            .addCase(fetchGitStatus.pending, (state) => {
                state.loading = true;
            })
            .addCase(fetchGitStatus.fulfilled, (state, action) => {
                state.loading = false;
                state.error = null;
                state.status = action.payload.status;
                state.branches = action.payload.branches || { local: [], all: [] };
                if (action.payload.status) {
                    state.currentBranch = action.payload.status.current;
                }
            })
            .addCase(fetchGitStatus.rejected, (state, action) => {
                state.loading = false;
                state.error = action.error.message;
                state.errorCode = action.error.code || null;
            });

        builder
            .addCase(fetchCommitHistory.pending, (state) => { state.loading = true; state.error = null; })
            .addCase(fetchCommitHistory.fulfilled, (state, action) => { 
                state.loading = false; 
                state.commitHistory = action.payload || { all: [], total: 0, page: 1, hasMore: false }; 
            })
            .addCase(fetchCommitHistory.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(fetchUnpushedCommits.pending, (state) => { state.loading = true; state.error = null; })
            .addCase(fetchUnpushedCommits.fulfilled, (state, action) => { state.loading = false; state.unpushedCommits = action.payload || []; })
            .addCase(fetchUnpushedCommits.rejected, (state, action) => { state.loading = false; state.error = action.error.message; });
        
        builder
            .addCase(fetchStashList.fulfilled, (state, action) => { state.stashList = action.payload || []; })
            .addCase(fetchBlame.fulfilled, (state, action) => { state.blameData = action.payload || []; });
        
        builder
            .addCase(initRepo.pending, (state) => { state.loading = true; state.error = null; })
            .addCase(initRepo.fulfilled, (state) => { state.loading = false; })
            .addCase(initRepo.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(cloneRepo.pending, (state) => { state.loading = true; state.error = null; })
            .addCase(cloneRepo.fulfilled, (state) => { state.loading = false; })
            .addCase(cloneRepo.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(addRemote.pending, (state) => { state.loading = true; state.error = null; })
            .addCase(addRemote.fulfilled, (state) => { state.loading = false; })
            .addCase(addRemote.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(pushChanges.pending, (state) => { state.loading = true; state.error = null; })
            .addCase(pushChanges.fulfilled, (state) => { state.loading = false; })
            .addCase(pushChanges.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(pullChanges.pending, (state) => { state.loading = true; state.error = null; })
            .addCase(pullChanges.fulfilled, (state) => { state.loading = false; })
            .addCase(pullChanges.rejected, (state, action) => { state.loading = false; state.error = action.error.message; })
            .addCase(fetchRemotes.fulfilled, (state, action) => {
                state.remotes = action.payload;
            });
    },
});

export const { clearError } = gitSlice.actions;
export default gitSlice.reducer;
