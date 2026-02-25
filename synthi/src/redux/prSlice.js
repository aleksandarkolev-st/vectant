/**
 * prSlice.js — Redux state for Pull Request management.
 *
 * Manages:
 *  - GitHub repo info (owner / repo / provider)
 *  - PR list (open/closed/all)
 *  - Currently open PR + its detail data (files, comments, reviews, checks)
 *  - GitHub token availability flag
 */

import { createSlice, createAsyncThunk } from '@reduxjs/toolkit';
import prClient, { getStoredToken } from '@/services/prClient';
import { gitClient } from '@/services/gitClient';

// ── Async thunks ──────────────────────────────────────────────────────────────

export const fetchGithubInfo = createAsyncThunk(
  'pr/fetchGithubInfo',
  async (slug, { rejectWithValue, getState }) => {
    // Skip if already loaded for same slug
    const existing = getState().pr.githubInfo;
    if (existing?.owner && existing?.repo) return existing;
    try {
      const info = await gitClient.getGithubInfo(slug);
      if (info?.error) return rejectWithValue(info);
      return info; // { owner, repo, provider, remoteUrl, htmlUrl }
    } catch (e) {
      return rejectWithValue({ error: 'fetch_failed', message: e.message });
    }
  }
);

export const fetchPRList = createAsyncThunk(
  'pr/fetchList',
  async ({ owner, repo, state = 'open', slug }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      const prs = await prClient.listPRs(owner, repo, { state }, token);
      return { prs, state };
    } catch (e) {
      return rejectWithValue({ error: e.message, status: e.status });
    }
  },
  {
    condition: (_, { getState }) => {
      // Don't start a new fetch if one is already in progress
      return !getState().pr.prListLoading;
    },
  }
);

export const fetchPRDetail = createAsyncThunk(
  'pr/fetchDetail',
  async ({ owner, repo, prNumber, slug }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      const [pr, files, commits, reviews, issueComments, reviewComments] = await Promise.all([
        prClient.getPR(owner, repo, prNumber, token),
        prClient.listPRFiles(owner, repo, prNumber, token).catch(() => []),
        prClient.listPRCommits(owner, repo, prNumber, token).catch(() => []),
        prClient.listReviews(owner, repo, prNumber, token).catch(() => []),
        prClient.listIssueComments(owner, repo, prNumber, token).catch(() => []),
        prClient.listReviewComments(owner, repo, prNumber, token).catch(() => []),
      ]);

      // Fetch CI checks for the head SHA
      let checks = [];
      try {
        checks = await prClient.listCheckRunsForRef(owner, repo, pr.head.sha, token);
      } catch (_) {}

      return { pr, files, commits, reviews, issueComments, reviewComments, checks };
    } catch (e) {
      return rejectWithValue({ error: e.message, status: e.status });
    }
  }
);

export const createPR = createAsyncThunk(
  'pr/create',
  async ({ owner, repo, slug, ...prData }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      return await prClient.createPR(owner, repo, prData, token);
    } catch (e) {
      return rejectWithValue({ error: e.message, status: e.status, githubErrors: e.githubErrors });
    }
  }
);

export const updatePR = createAsyncThunk(
  'pr/update',
  async ({ owner, repo, prNumber, slug, updates }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      return await prClient.updatePR(owner, repo, prNumber, updates, token);
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const mergePR = createAsyncThunk(
  'pr/merge',
  async ({ owner, repo, prNumber, slug, mergeMethod, commitTitle, commitMessage }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      const result = await prClient.mergePR(owner, repo, prNumber, { mergeMethod, commitTitle, commitMessage }, token);
      return { result, prNumber };
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const closePR = createAsyncThunk(
  'pr/close',
  async ({ owner, repo, prNumber, slug }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      return await prClient.closePR(owner, repo, prNumber, token);
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const reopenPR = createAsyncThunk(
  'pr/reopen',
  async ({ owner, repo, prNumber, slug }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      return await prClient.reopenPR(owner, repo, prNumber, token);
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const submitReview = createAsyncThunk(
  'pr/review',
  async ({ owner, repo, prNumber, slug, event, body, comments }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      return await prClient.createReview(owner, repo, prNumber, { event, body, comments }, token);
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const postComment = createAsyncThunk(
  'pr/postComment',
  async ({ owner, repo, prNumber, slug, body }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      return await prClient.createIssueComment(owner, repo, prNumber, body, token);
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const deleteComment = createAsyncThunk(
  'pr/deleteComment',
  async ({ owner, repo, commentId, slug }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      await prClient.deleteIssueComment(owner, repo, commentId, token);
      return { commentId };
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const setLabels = createAsyncThunk(
  'pr/setLabels',
  async ({ owner, repo, prNumber, slug, labels }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      await prClient.setLabels(owner, repo, prNumber, labels.map(l => l.name || l), token);
      return labels;
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const setAssignees = createAsyncThunk(
  'pr/setAssignees',
  async ({ owner, repo, prNumber, slug, assignees }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      // GitHub requires separate add/remove calls — for simplicity we PUT all assignees
      await prClient.addAssignees(owner, repo, prNumber, assignees.map(a => a.login || a), token);
      return assignees;
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const validateToken = createAsyncThunk(
  'pr/validateToken',
  async ({ slug, token }, { rejectWithValue }) => {
    try {
      const user = await prClient.getAuthUser(token);
      return { user, token };
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const fetchRepoLabels = createAsyncThunk(
  'pr/fetchRepoLabels',
  async ({ owner, repo, slug }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      return await prClient.listRepoLabels(owner, repo, token);
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

export const fetchRepoBranches = createAsyncThunk(
  'pr/fetchRepoBranches',
  async ({ owner, repo, slug }, { rejectWithValue }) => {
    const token = getStoredToken(slug);
    if (!token) return rejectWithValue({ error: 'no_token' });
    try {
      const branches = await prClient.listBranches(owner, repo, token);
      return branches.map(b => b.name);
    } catch (e) {
      return rejectWithValue({ error: e.message });
    }
  }
);

// ── Slice ─────────────────────────────────────────────────────────────────────

const initialState = {
  // GitHub repo context
  githubInfo: null,           // { owner, repo, provider, remoteUrl, htmlUrl }
  githubInfoLoading: false,
  githubInfoError: null,

  // Token
  hasToken: false,            // true when a PAT is stored in localStorage
  tokenUser: null,            // authenticated GitHub user object

  // PR list
  prList: [],
  prListState: 'open',        // 'open' | 'closed' | 'all'
  prListLoading: false,
  prListError: null,

  // PR detail
  activePR: null,             // full PR object
  prFiles: [],
  prCommits: [],
  prReviews: [],
  prIssueComments: [],
  prReviewComments: [],
  prChecks: [],
  prDetailLoading: false,
  prDetailError: null,

  // Repo metadata
  repoLabels: [],
  repoBranches: [],

  // Create PR form
  createPRLoading: false,
  createPRError: null,

  // Action loading states
  mergePRLoading: false,
  reviewLoading: false,
  commentLoading: false,
  actionError: null,
};

const prSlice = createSlice({
  name: 'pr',
  initialState,
  reducers: {
    setHasToken(state, { payload }) {
      state.hasToken = payload;
      if (!payload) state.tokenUser = null;
    },
    setActivePR(state, { payload }) {
      state.activePR = payload;
      if (!payload) {
        state.prFiles = [];
        state.prCommits = [];
        state.prReviews = [];
        state.prIssueComments = [];
        state.prReviewComments = [];
        state.prChecks = [];
        state.prDetailError = null;
      }
    },
    setPRListState(state, { payload }) {
      state.prListState = payload;
    },
    clearActionError(state) {
      state.actionError = null;
    },
    clearCreatePRError(state) {
      state.createPRError = null;
    },
    clearPRError(state) {
      state.prListError = null;
      state.prDetailError = null;
    },
    // Optimistically update a PR in the list
    updatePRInList(state, { payload }) {
      const idx = state.prList.findIndex(p => p.number === payload.number);
      if (idx !== -1) state.prList[idx] = { ...state.prList[idx], ...payload };
      if (state.activePR?.number === payload.number) {
        state.activePR = { ...state.activePR, ...payload };
      }
    },
    // Add a newly posted comment optimistically
    addIssueComment(state, { payload }) {
      state.prIssueComments.push(payload);
    },
    removeIssueComment(state, { payload: commentId }) {
      state.prIssueComments = state.prIssueComments.filter(c => c.id !== commentId);
    },
  },
  extraReducers: (builder) => {
    // ── fetchGithubInfo ─────────────────────────────────────────────────────
    builder
      .addCase(fetchGithubInfo.pending, (state) => {
        state.githubInfoLoading = true;
        state.githubInfoError = null;
      })
      .addCase(fetchGithubInfo.fulfilled, (state, { payload }) => {
        state.githubInfoLoading = false;
        state.githubInfo = payload;
      })
      .addCase(fetchGithubInfo.rejected, (state, { payload }) => {
        state.githubInfoLoading = false;
        state.githubInfoError = payload?.message || 'Failed to get repo info';
      });

    // ── validateToken ───────────────────────────────────────────────────────
    builder
      .addCase(validateToken.fulfilled, (state, { payload }) => {
        state.hasToken = true;
        state.tokenUser = payload.user;
      })
      .addCase(validateToken.rejected, (state) => {
        state.hasToken = false;
        state.tokenUser = null;
      });

    // ── fetchPRList ─────────────────────────────────────────────────────────
    builder
      .addCase(fetchPRList.pending, (state) => {
        state.prListLoading = true;
        state.prListError = null;
      })
      .addCase(fetchPRList.fulfilled, (state, { payload }) => {
        state.prListLoading = false;
        state.prList = payload.prs;
        state.prListState = payload.state;
      })
      .addCase(fetchPRList.rejected, (state, { payload }) => {
        state.prListLoading = false;
        state.prListError = payload?.error === 'no_token' ? null : (payload?.error || 'Failed to load PRs');
      });

    // ── fetchPRDetail ───────────────────────────────────────────────────────
    builder
      .addCase(fetchPRDetail.pending, (state) => {
        state.prDetailLoading = true;
        state.prDetailError = null;
      })
      .addCase(fetchPRDetail.fulfilled, (state, { payload }) => {
        state.prDetailLoading = false;
        state.activePR = payload.pr;
        state.prFiles = payload.files;
        state.prCommits = payload.commits;
        state.prReviews = payload.reviews;
        state.prIssueComments = payload.issueComments;
        state.prReviewComments = payload.reviewComments;
        state.prChecks = payload.checks;
      })
      .addCase(fetchPRDetail.rejected, (state, { payload }) => {
        state.prDetailLoading = false;
        state.prDetailError = payload?.error || 'Failed to load PR details';
      });

    // ── createPR ────────────────────────────────────────────────────────────
    builder
      .addCase(createPR.pending, (state) => {
        state.createPRLoading = true;
        state.createPRError = null;
      })
      .addCase(createPR.fulfilled, (state, { payload }) => {
        state.createPRLoading = false;
        // Prepend to list
        state.prList = [payload, ...state.prList];
        state.activePR = payload;
      })
      .addCase(createPR.rejected, (state, { payload }) => {
        state.createPRLoading = false;
        state.createPRError = payload?.error || 'Failed to create PR';
      });

    // ── updatePR ────────────────────────────────────────────────────────────
    builder
      .addCase(updatePR.fulfilled, (state, { payload }) => {
        state.activePR = payload;
        const idx = state.prList.findIndex(p => p.number === payload.number);
        if (idx !== -1) state.prList[idx] = payload;
      });

    // ── mergePR ─────────────────────────────────────────────────────────────
    builder
      .addCase(mergePR.pending, (state) => {
        state.mergePRLoading = true;
        state.actionError = null;
      })
      .addCase(mergePR.fulfilled, (state, { payload }) => {
        state.mergePRLoading = false;
        if (state.activePR?.number === payload.prNumber) {
          state.activePR = { ...state.activePR, state: 'closed', merged: true };
        }
        const idx = state.prList.findIndex(p => p.number === payload.prNumber);
        if (idx !== -1) state.prList[idx] = { ...state.prList[idx], state: 'closed', merged: true };
      })
      .addCase(mergePR.rejected, (state, { payload }) => {
        state.mergePRLoading = false;
        state.actionError = payload?.error || 'Merge failed';
      });

    // ── closePR / reopenPR ───────────────────────────────────────────────────
    builder
      .addCase(closePR.fulfilled, (state, { payload }) => {
        state.activePR = payload;
        const idx = state.prList.findIndex(p => p.number === payload.number);
        if (idx !== -1) state.prList[idx] = payload;
      })
      .addCase(reopenPR.fulfilled, (state, { payload }) => {
        state.activePR = payload;
        const idx = state.prList.findIndex(p => p.number === payload.number);
        if (idx !== -1) state.prList[idx] = payload;
      });

    // ── submitReview ─────────────────────────────────────────────────────────
    builder
      .addCase(submitReview.pending, (state) => {
        state.reviewLoading = true;
        state.actionError = null;
      })
      .addCase(submitReview.fulfilled, (state, { payload }) => {
        state.reviewLoading = false;
        if (payload) state.prReviews.push(payload);
      })
      .addCase(submitReview.rejected, (state, { payload }) => {
        state.reviewLoading = false;
        state.actionError = payload?.error || 'Review submission failed';
      });

    // ── postComment ──────────────────────────────────────────────────────────
    builder
      .addCase(postComment.pending, (state) => {
        state.commentLoading = true;
        state.actionError = null;
      })
      .addCase(postComment.fulfilled, (state, { payload }) => {
        state.commentLoading = false;
        if (payload) state.prIssueComments.push(payload);
        if (state.activePR) state.activePR = { ...state.activePR, comments: (state.activePR.comments || 0) + 1 };
      })
      .addCase(postComment.rejected, (state, { payload }) => {
        state.commentLoading = false;
        state.actionError = payload?.error || 'Comment failed';
      });

    // ── deleteComment ────────────────────────────────────────────────────────
    builder
      .addCase(deleteComment.fulfilled, (state, { payload }) => {
        state.prIssueComments = state.prIssueComments.filter(c => c.id !== payload.commentId);
      });

    // ── fetchRepoLabels ──────────────────────────────────────────────────────
    builder
      .addCase(fetchRepoLabels.fulfilled, (state, { payload }) => {
        state.repoLabels = payload;
      });

    // ── fetchRepoBranches ────────────────────────────────────────────────────
    builder
      .addCase(fetchRepoBranches.fulfilled, (state, { payload }) => {
        state.repoBranches = payload;
      });

    // ── setLabels ────────────────────────────────────────────────────────────
    builder
      .addCase(setLabels.fulfilled, (state, { payload }) => {
        if (state.activePR) state.activePR = { ...state.activePR, labels: payload };
      });
  },
});

export const {
  setHasToken,
  setActivePR,
  setPRListState,
  clearActionError,
  clearCreatePRError,
  clearPRError,
  updatePRInList,
  addIssueComment,
  removeIssueComment,
} = prSlice.actions;

export default prSlice.reducer;
