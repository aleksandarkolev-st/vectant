/**
 * prClient.js — GitHub REST API client for Pull Request management.
 *
 * Calls the GitHub API directly from the browser using the user's PAT
 * (stored in localStorage per workspace).  Works with GitHub.com only;
 * GitLab / Bitbucket support can be added later.
 *
 * Token storage key: `synthi:github-token:<slug>`
 */

const GITHUB_API = 'https://api.github.com';

// ── Token helpers ─────────────────────────────────────────────────────────────

const GLOBAL_TOKEN_KEY = 'synthi:global-github-token';

export function getStoredToken(slug) {
  if (typeof window === 'undefined') return null;
  // Per-workspace token takes priority, then fall back to global token
  return localStorage.getItem(`synthi:github-token:${slug}`)
    || localStorage.getItem(GLOBAL_TOKEN_KEY)
    || null;
}

export function getGlobalToken() {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(GLOBAL_TOKEN_KEY) || null;
}

export function storeToken(slug, token) {
  if (typeof window === 'undefined') return;
  if (token) {
    localStorage.setItem(`synthi:github-token:${slug}`, token);
  } else {
    localStorage.removeItem(`synthi:github-token:${slug}`);
  }
}

export function clearToken(slug) {
  storeToken(slug, null);
}

// ── Core fetch wrapper ────────────────────────────────────────────────────────

async function ghFetch(path, { method = 'GET', body, token, accept } = {}) {
  if (!token) throw new Error('No GitHub token configured. Please add your Personal Access Token.');

  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: accept || 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
  };
  if (body && method !== 'GET') {
    headers['Content-Type'] = 'application/json';
  }

  let res;
  try {
    res = await fetch(`${GITHUB_API}${path}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (networkError) {
    const err = new Error('Network error — check your internet connection and try again.');
    err.status = 0;
    err.isNetworkError = true;
    throw err;
  }

  // 204 No Content
  if (res.status === 204) return null;

  let json = null;
  try {
    json = await res.json();
  } catch (_) {}

  if (!res.ok) {
    let message;
    if (res.status === 401) {
      message = 'Authentication failed — your token may be expired or revoked. Update it in settings.';
    } else if (res.status === 403) {
      message = json?.message?.includes('rate limit')
        ? 'GitHub API rate limit exceeded. Wait a few minutes and try again.'
        : `Permission denied (403): ${json?.message || 'Check your token scopes.'}`;
    } else if (res.status === 404) {
      message = `Not found (404): ${json?.message || 'The resource may not exist or your token lacks access.'}`;
    } else if (res.status === 422) {
      if (json?.errors?.length) {
        // Build descriptive per-field messages from GitHub's error response
        const details = json.errors.map(e => {
          const field = e.field || e.resource || 'unknown field';
          const code = e.code || '';
          if (e.message) return e.message;
          if (code === 'missing_field') return `"${field}" is required but was not provided`;
          if (code === 'invalid') return `"${field}" has an invalid value`;
          if (code === 'missing') return `"${field}" does not exist`;
          if (code === 'already_exists') return `"${field}" already exists — a duplicate was detected`;
          if (code === 'custom') return e.message || `Validation failed for "${field}"`;
          return `${field}: ${code || 'validation failed'}`;
        });
        message = `Validation failed:\n• ${details.join('\n• ')}`;
      } else {
        // Provide context-aware fallback messages based on the API path
        const pathHint = path.toLowerCase();
        if (pathHint.includes('/reviews')) {
          message = json?.message || 'Review submission failed — ensure you have a non-empty body for comment-only reviews and that the PR is open.';
        } else if (pathHint.includes('/pulls') && method === 'POST') {
          message = json?.message || 'PR creation failed — verify that head/base branches exist and are different, and that a PR for this branch pair does not already exist.';
        } else if (pathHint.includes('/merge')) {
          message = json?.message || 'Merge failed — the PR may have merge conflicts, failing status checks, or require additional approvals.';
        } else {
          message = json?.message || 'Validation error — check your input and try again.';
        }
      }
    } else {
      message = json?.message || json?.error || res.statusText || `HTTP ${res.status}`;
    }
    const err = new Error(message);
    err.status = res.status;
    err.githubErrors = json?.errors;
    throw err;
  }

  return json;
}

/**
 * Paginate through all pages of a GitHub list API.
 * @param {string} path - API path (may include ?per_page=...)
 * @param {object} opts
 * @returns {Promise<Array>}
 */
async function ghFetchAll(path, opts = {}) {
  const results = [];
  let url = path.includes('?') ? path : `${path}?per_page=100`;
  while (url) {
    const res = await fetch(`${GITHUB_API}${url}`, {
      headers: {
        Authorization: `Bearer ${opts.token}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
    });
    const json = await res.json().catch(() => []);
    if (!res.ok) {
      const err = new Error(json?.message || `HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    results.push(...(Array.isArray(json) ? json : []));

    // Parse Link header for pagination
    const link = res.headers.get('Link') || '';
    const nextMatch = link.match(/<([^>]+)>;\s*rel="next"/);
    if (nextMatch) {
      // Strip the base URL since we prepend it in ghFetch
      url = nextMatch[1].replace(GITHUB_API, '');
    } else {
      url = null;
    }
  }
  return results;
}

// ── Public API ────────────────────────────────────────────────────────────────

const prClient = {
  /**
   * Verify a token is valid and get the authenticated user.
   */
  async getAuthUser(token) {
    return ghFetch('/user', { token });
  },

  // ── Pull Requests ───────────────────────────────────────────────────────────

  /**
   * List pull requests.
   * @param {string} owner
   * @param {string} repo
   * @param {{ state?: 'open'|'closed'|'all', head?: string, base?: string, sort?: string, direction?: string }} filters
   * @param {string} token
   */
  async listPRs(owner, repo, filters = {}, token) {
    const params = new URLSearchParams({
      state: filters.state || 'open',
      sort: filters.sort || 'updated',
      direction: filters.direction || 'desc',
      per_page: '50',
    });
    if (filters.head) params.set('head', filters.head);
    if (filters.base) params.set('base', filters.base);
    return ghFetch(`/repos/${owner}/${repo}/pulls?${params}`, { token });
  },

  /**
   * Get a single pull request.
   */
  async getPR(owner, repo, prNumber, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, { token });
  },

  /**
   * Create a pull request.
   */
  async createPR(owner, repo, { title, body, head, base, draft = false, maintainer_can_modify = true }, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      body: { title, body, head, base, draft, maintainer_can_modify },
      token,
    });
  },

  /**
   * Update PR properties (title, body, state, base, maintainer_can_modify).
   */
  async updatePR(owner, repo, prNumber, updates, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}`, {
      method: 'PATCH',
      body: updates,
      token,
    });
  },

  /**
   * Close a PR (sets state to 'closed').
   */
  async closePR(owner, repo, prNumber, token) {
    return this.updatePR(owner, repo, prNumber, { state: 'closed' }, token);
  },

  /**
   * Reopen a PR.
   */
  async reopenPR(owner, repo, prNumber, token) {
    return this.updatePR(owner, repo, prNumber, { state: 'open' }, token);
  },

  /**
   * Merge a pull request.
   * @param {'merge'|'squash'|'rebase'} mergeMethod
   */
  async mergePR(owner, repo, prNumber, { commitTitle, commitMessage, mergeMethod = 'merge', sha } = {}, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
      method: 'PUT',
      body: {
        commit_title: commitTitle,
        commit_message: commitMessage,
        merge_method: mergeMethod,
        sha,
      },
      token,
    });
  },

  // ── PR Files ────────────────────────────────────────────────────────────────

  async listPRFiles(owner, repo, prNumber, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/pulls/${prNumber}/files`, { token });
  },

  // ── PR Commits ──────────────────────────────────────────────────────────────

  async listPRCommits(owner, repo, prNumber, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/pulls/${prNumber}/commits`, { token });
  },

  // ── Reviews ─────────────────────────────────────────────────────────────────

  async listReviews(owner, repo, prNumber, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, { token });
  },

  /**
   * Submit a review.
   * @param {'APPROVE'|'REQUEST_CHANGES'|'COMMENT'|'PENDING'} event
   */
  async createReview(owner, repo, prNumber, { event, body, comments }, token) {
    // Only include fields that are defined — GitHub rejects unknown/empty
    // fields (e.g. `comments: []` without inline comment objects).
    const payload = { event };
    if (body !== undefined && body !== null && body !== '') payload.body = body;
    if (Array.isArray(comments) && comments.length > 0) payload.comments = comments;
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews`, {
      method: 'POST',
      body: payload,
      token,
    });
  },

  async dismissReview(owner, repo, prNumber, reviewId, message, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/reviews/${reviewId}/dismissals`, {
      method: 'PUT',
      body: { message },
      token,
    });
  },

  // ── Review Requests ─────────────────────────────────────────────────────────

  async listRequestedReviewers(owner, repo, prNumber, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, { token });
  },

  async requestReviewers(owner, repo, prNumber, { reviewers = [], team_reviewers = [] }, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, {
      method: 'POST',
      body: { reviewers, team_reviewers },
      token,
    });
  },

  async removeReviewers(owner, repo, prNumber, { reviewers = [], team_reviewers = [] }, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/requested_reviewers`, {
      method: 'DELETE',
      body: { reviewers, team_reviewers },
      token,
    });
  },

  // ── Issue Comments (general PR comments / timeline) ─────────────────────────

  async listIssueComments(owner, repo, prNumber, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/issues/${prNumber}/comments?per_page=100`, { token });
  },

  async createIssueComment(owner, repo, prNumber, body, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, {
      method: 'POST',
      body: { body },
      token,
    });
  },

  async updateIssueComment(owner, repo, commentId, body, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: 'PATCH',
      body: { body },
      token,
    });
  },

  async deleteIssueComment(owner, repo, commentId, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/comments/${commentId}`, {
      method: 'DELETE',
      token,
    });
  },

  // ── Review Comments (inline code comments) ───────────────────────────────────

  async listReviewComments(owner, repo, prNumber, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/pulls/${prNumber}/comments?per_page=100`, { token });
  },

  async createReviewComment(owner, repo, prNumber, { body, commitId, path, line, side = 'RIGHT' }, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
      method: 'POST',
      body: { body, commit_id: commitId, path, line, side },
      token,
    });
  },

  async replyToReviewComment(owner, repo, prNumber, commentId, body, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/${prNumber}/comments`, {
      method: 'POST',
      body: { body, in_reply_to: commentId },
      token,
    });
  },

  async deleteReviewComment(owner, repo, commentId, token) {
    return ghFetch(`/repos/${owner}/${repo}/pulls/comments/${commentId}`, {
      method: 'DELETE',
      token,
    });
  },

  // ── Labels ──────────────────────────────────────────────────────────────────

  async listRepoLabels(owner, repo, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/labels`, { token });
  },

  async addLabels(owner, repo, prNumber, labels, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
      method: 'POST',
      body: { labels },
      token,
    });
  },

  async removeLabel(owner, repo, prNumber, label, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels/${encodeURIComponent(label)}`, {
      method: 'DELETE',
      token,
    });
  },

  async setLabels(owner, repo, prNumber, labels, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/labels`, {
      method: 'PUT',
      body: { labels },
      token,
    });
  },

  // ── Assignees ───────────────────────────────────────────────────────────────

  async addAssignees(owner, repo, prNumber, assignees, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/assignees`, {
      method: 'POST',
      body: { assignees },
      token,
    });
  },

  async removeAssignees(owner, repo, prNumber, assignees, token) {
    return ghFetch(`/repos/${owner}/${repo}/issues/${prNumber}/assignees`, {
      method: 'DELETE',
      body: { assignees },
      token,
    });
  },

  async listCollaborators(owner, repo, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/collaborators`, { token });
  },

  // ── Checks ──────────────────────────────────────────────────────────────────

  async listCheckRunsForRef(owner, repo, ref, token) {
    const data = await ghFetch(`/repos/${owner}/${repo}/commits/${ref}/check-runs?per_page=100`, { token });
    return data?.check_runs || [];
  },

  async listCheckSuitesForRef(owner, repo, ref, token) {
    const data = await ghFetch(`/repos/${owner}/${repo}/commits/${ref}/check-suites?per_page=100`, { token });
    return data?.check_suites || [];
  },

  // ── Repo info ────────────────────────────────────────────────────────────────

  async getRepo(owner, repo, token) {
    return ghFetch(`/repos/${owner}/${repo}`, { token });
  },

  async listBranches(owner, repo, token) {
    return ghFetchAll(`/repos/${owner}/${repo}/branches`, { token });
  },

  async compareCommits(owner, repo, base, head, token) {
    return ghFetch(`/repos/${owner}/${repo}/compare/${base}...${head}`, { token });
  },

  /**
   * Get merge conflict status by comparing base and head.
   */
  async getMergeability(owner, repo, prNumber, token) {
    // Mergability is computed lazily by GitHub; poll until non-null
    let pr = await this.getPR(owner, repo, prNumber, token);
    let tries = 0;
    while (pr.mergeable === null && tries < 3) {
      await new Promise(r => setTimeout(r, 1500));
      pr = await this.getPR(owner, repo, prNumber, token);
      tries++;
    }
    return { mergeable: pr.mergeable, mergeableState: pr.mergeable_state };
  },
};

export default prClient;
