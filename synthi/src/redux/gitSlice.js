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

export const commitChanges = createAsyncThunk(
    'git/commit',
    async ({ slug, message }, { dispatch }) => {
        await gitClient.commit(slug, message);
        dispatch(fetchGitStatus(slug));
    }
);

export const stageFile = createAsyncThunk(
    'git/stage',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.stageFile(slug, filePath);
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

export const pushChanges = createAsyncThunk(
    'git/push',
    async (slug, { dispatch }) => {
        await gitClient.push(slug);
        dispatch(fetchGitStatus(slug));
    }
);

export const pullChanges = createAsyncThunk(
    'git/pull',
    async (slug, { dispatch }) => {
        await gitClient.pull(slug);
        dispatch(fetchGitStatus(slug));
    }
);

export const discardChange = createAsyncThunk(
    'git/discard',
    async ({ slug, filePath }, { dispatch }) => {
        await gitClient.discardChange(slug, filePath);
        dispatch(fetchGitStatus(slug));
    }
);

const gitSlice = createSlice({
    name: 'git',
    initialState: {
        status: null,
        branches: { local: [], all: [] },
        currentBranch: 'main',
        loading: false,
        error: null,
    },
    reducers: {},
    extraReducers: (builder) => {
        builder
            .addCase(fetchGitStatus.pending, (state) => {
                state.loading = true;
            })
            .addCase(fetchGitStatus.fulfilled, (state, action) => {
                state.loading = false;
                state.status = action.payload.status;
                state.branches = action.payload.branches || { local: [], all: [] };
                if (action.payload.status) {
                    state.currentBranch = action.payload.status.current;
                }
            })
            .addCase(fetchGitStatus.rejected, (state, action) => {
                state.loading = false;
                state.error = action.error.message;
            });
    },
});

export default gitSlice.reducer;
