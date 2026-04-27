import collabSessionService from '@/services/collabSessionService';

const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';

/**
 * Normalize a file path to forward slashes and strip leading slash.
 * Prevents Windows-style backslash paths from reaching the server.
 */
function normalizePath(p) {
    if (!p || typeof p !== 'string') return p;
    return p.replace(/\\/g, '/').replace(/^\/+/, '');
}

let cachedUserId = null;
// Display name + email for commit attribution. Sent on every git request
// as `x-user-name` / `x-user-email`; the server pins these as
// GIT_AUTHOR_*/GIT_COMMITTER_* on commit-creating operations so a guest's
// commits in a host's worktree show up under the guest's GitHub identity.
let cachedUserName = null;
let cachedUserEmail = null;

// Resolvers that will be called when userId becomes available.
let _userIdReadyResolvers = [];

/**
 * RFC 7230 forbids non-token characters in HTTP header values, and many
 * proxies silently drop headers containing them. base64-encode anything
 * that isn't pure ASCII so non-Latin names survive the trip.
 */
function _encodeHeader(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;
    // Pure ASCII (no controls, no high-bit) — pass through.
    // eslint-disable-next-line no-control-regex
    if (/^[\x20-\x7E]+$/.test(s)) return s;
    if (typeof window === 'undefined') return s; // SSR safety
    try {
        const bytes = new TextEncoder().encode(s);
        let bin = '';
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        return btoa(bin);
    } catch {
        return s;
    }
}

// Actions that truly cannot wait for authentication (bootstrapping).
// All other actions (including reads like status, remotes, log) MUST wait
// for userId so the server resolves the correct per-user repo — otherwise
// operations fall back to the slug-level directory which may have stale or
// phantom data (e.g., a single "Initial commit" with no origin).
const AUTH_EXEMPT_ACTIONS = new Set(['init', 'clone']);

/**
 * Wait for cachedUserId to be set (up to timeoutMs).
 * Resolves immediately if already set.
 */
function _waitForUserId(timeoutMs = 3000) {
    if (cachedUserId) return Promise.resolve(cachedUserId);
    return new Promise((resolve) => {
        const timer = setTimeout(() => {
            // Remove this resolver from the queue
            _userIdReadyResolvers = _userIdReadyResolvers.filter(r => r !== onReady);
            resolve(null); // timed out — proceed without userId
        }, timeoutMs);
        const onReady = (uid) => {
            clearTimeout(timer);
            resolve(uid);
        };
        _userIdReadyResolvers.push(onReady);
    });
}

export const gitClient = {
    setUserId(userId) {
        cachedUserId = userId;
        // Wake up any pending requests that were waiting for auth.
        if (userId && _userIdReadyResolvers.length > 0) {
            const resolvers = _userIdReadyResolvers.splice(0);
            resolvers.forEach(r => r(userId));
        }
    },

    /**
     * Attach the display name + email used for commit attribution.
     * Safe to call repeatedly — the latest values win for subsequent
     * requests. `null` clears the value.
     */
    setIdentity({ userId, name, email } = {}) {
        if (typeof userId !== 'undefined') this.setUserId(userId);
        cachedUserName  = (typeof name  === 'string' && name.trim())  ? name.trim()  : null;
        cachedUserEmail = (typeof email === 'string' && email.trim()) ? email.trim() : null;
    },

    async request(slug, action, data = {}) {
        // Wait for auth before dispatching.  Without userId the server
        // falls back to the slug-level repo which produces wrong results.
        // Only truly bootstrapping actions (init, clone) are exempt.
        if (!cachedUserId && !AUTH_EXEMPT_ACTIONS.has(action)) {
            await _waitForUserId(3000);
        }

        const headers = {
            'Content-Type': 'application/json',
        };

        // Attach authenticated user id for per-user repo isolation.
        if (cachedUserId) {
            headers['x-user-id'] = cachedUserId;
        }
        // Identity headers — picked up by the server as commitIdentity and
        // pinned to GIT_AUTHOR_*/GIT_COMMITTER_* for commit-creating actions
        // so a guest's commits in a host's worktree are attributed to them.
        const encodedName  = _encodeHeader(cachedUserName);
        const encodedEmail = _encodeHeader(cachedUserEmail);
        if (encodedName)  headers['x-user-name']  = encodedName;
        if (encodedEmail) headers['x-user-email'] = encodedEmail;
        if (collabSessionService?.isActive && collabSessionService.sessionId) {
            headers['x-session-id'] = collabSessionService.sessionId;
        }

        // Normalize file paths — convert Windows backslashes to forward slashes
        // and strip leading slashes to prevent path resolution mismatches.
        if (data.filePath) data = { ...data, filePath: normalizePath(data.filePath) };
        if (data.path) data = { ...data, path: normalizePath(data.path) };

        const response = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/${action}`, {
            method: 'POST',
            headers,
            body: JSON.stringify(data),
        });
        let body = null;
        try {
            body = await response.json();
        } catch (e) {
            // ignore parse errors
        }
        if (!response.ok) {
            // Handle structured error responses
            // Prefer body.message (human-readable) over body.error (machine key like "permission_denied")
            const error = new Error((body && (body.message || body.error)) || response.statusText || 'Unknown git error');
            error.code = body?.error || body?.code || 'UNKNOWN';
            error.details = body?.details || null;
            error.statusCode = response.status;
            error.required = body?.required || null;
            error.granted = body?.granted || null;

            // ── Permission boundary toast ──
            // Surface 403 permission_denied as a *sticky* toast so the user
            // keeps seeing the constraint on every subsequent retry (silent
            // drop-on-5s would let people retry forever without realising
            // their role blocks the action).  Stable id coalesces repeated
            // failures onto a single notification.
            if (response.status === 403 && (error.code === 'permission_denied' || error.code === 'host_only')) {
                const toastId = `permission-denied:${action}:${data.filePath || data.path || ''}`;
                import('sonner').then(({ toast }) => {
                    toast.error(error.message || 'Permission denied', {
                        id: toastId,
                        description: error.required
                            ? `Requires "${error.required}" permission. Ask the session Host.`
                            : undefined,
                        duration: Infinity,
                        closeButton: true,
                    });
                }).catch(() => { /* sonner not available */ });
            }

            throw error;
        }
        return body;
    },

    async init(slug, remoteUrl) {
        return this.request(slug, 'init', { remoteUrl });
    },

    async addRemote(slug, name, url, token) {
        const body = { name, url };
        if (token) body.token = token;
        return this.request(slug, 'add-remote', body);
    },

    async removeRemote(slug, name) {
        return this.request(slug, 'remove-remote', { name });
    },

    async setRemoteUrl(slug, name, url, token) {
        const body = { name, url };
        if (token) body.token = token;
        return this.request(slug, 'set-remote-url', body);
    },

    async getRemotes(slug) {
        return this.request(slug, 'remotes');
    },

    async clone(slug, repoUrl, token) {
        return this.request(slug, 'clone', { repoUrl, token });
    },

    async getStatus(slug) {
        return this.request(slug, 'status');
    },

    async getBranches(slug) {
        return this.request(slug, 'branches');
    },

    async checkout(slug, branch, create = false, mode = 'normal') {
        return this.request(slug, 'checkout', { branch, create, mode });
    },

    async fetch(slug, token) {
        return this.request(slug, 'fetch', token ? { token } : {});
    },

    async commit(slug, message, amend = false) {
        return this.request(slug, 'commit', { message, amend });
    },

    async stageFile(slug, filePath) {
        return this.request(slug, 'stage', { filePath });
    },

    async stageAll(slug) {
        return this.request(slug, 'stage-all');
    },

    async stageLines(slug, filePath, patch) {
        return this.request(slug, 'stage-lines', { filePath, patch });
    },

    async unstageLines(slug, filePath, patch) {
        return this.request(slug, 'unstage-lines', { filePath, patch });
    },

    async discardLines(slug, filePath, patch) {
        return this.request(slug, 'discard-lines', { filePath, patch });
    },

    async unstageFile(slug, filePath) {
        return this.request(slug, 'unstage', { filePath });
    },

    async unstageAll(slug) {
        return this.request(slug, 'unstage-all');
    },

    async push(slug, token, force = false) {
        const data = {};
        if (token) data.token = token;
        if (force) data.force = true;
        return this.request(slug, 'push', data);
    },

    async pull(slug, token) {
        return this.request(slug, 'pull', token ? { token } : {});
    },

    async discardChange(slug, filePath) {
        return this.request(slug, 'discard', { filePath });
    },

    async discardAll(slug) {
        return this.request(slug, 'discard-all');
    },

    async getDiff(slug, filePath, parsed = false) {
        return this.request(slug, 'diff', { filePath, parsed });
    },

    async getLog(slug, page = 1, limit = 50) {
        return this.request(slug, 'log', { page, limit });
    },

    async getUnpushed(slug, max = 50) {
        return this.request(slug, 'unpushed', { max });
    },

    async getIncoming(slug, max = 50) {
        return this.request(slug, 'incoming', { max });
    },

    async getBlame(slug, filePath) {
        return this.request(slug, 'blame', { filePath });
    },

    // Stash operations
    async stashList(slug) {
        return this.request(slug, 'stash-list');
    },

    async stashPush(slug, message = '') {
        return this.request(slug, 'stash-push', { message });
    },

    async stashPop(slug, index = 0) {
        return this.request(slug, 'stash-pop', { index });
    },

    async stashApply(slug, index = 0) {
        return this.request(slug, 'stash-apply', { index });
    },

    async stashDrop(slug, index = 0) {
        return this.request(slug, 'stash-drop', { index });
    },

    async syncFile(slug, filePath, content) {
        return this.request(slug, 'sync', { filePath, content });
    },

    async getFileContent(slug, filePath, ref = 'HEAD') {
        return this.request(slug, 'file-content', { filePath, ref });
    },

    // Merge conflict resolution
    async resolveConflictOurs(slug, filePath) {
        return this.request(slug, 'resolve-ours', { filePath });
    },

    async resolveConflictTheirs(slug, filePath) {
        return this.request(slug, 'resolve-theirs', { filePath });
    },

    async markResolved(slug, filePath) {
        return this.request(slug, 'mark-resolved', { filePath });
    },

    async abortMerge(slug) {
        return this.request(slug, 'abort-merge');
    },

    async mergeBranch(slug, branch, token) {
        const data = { branch };
        if (token) data.token = token;
        return this.request(slug, 'merge-branch', data);
    },

    /**
     * In-memory merge conflict detection using git merge-tree.
     * Runs in milliseconds — no working tree changes.
     */
    async checkMergeConflicts(slug, baseBranch, headBranch, token) {
        const data = { baseBranch, headBranch };
        if (token) data.token = token;
        return this.request(slug, 'check-merge-conflicts', data);
    },

    async cherryPick(slug, hash) {
        return this.request(slug, 'cherry-pick', { hash });
    },

    async revertCommit(slug, hash) {
        return this.request(slug, 'revert', { hash });
    },

    async interactiveRebase(slug, baseCommit, operations) {
        return this.request(slug, 'interactive-rebase', { baseCommit, operations });
    },

    async rebaseAbort(slug) {
        return this.request(slug, 'rebase-abort');
    },

    async rebaseContinue(slug) {
        return this.request(slug, 'rebase-continue');
    },

    // ── Tag management ─────────────────────────────────
    async getTags(slug) {
        return this.request(slug, 'tags');
    },

    async createTag(slug, name, ref = 'HEAD', message) {
        return this.request(slug, 'create-tag', { name, ref, message });
    },

    async deleteTag(slug, name) {
        return this.request(slug, 'delete-tag', { name });
    },

    async pushTag(slug, name, token) {
        return this.request(slug, 'push-tag', { name, token });
    },

    async getCommitDetail(slug, hash) {
        return this.request(slug, 'commit-detail', { hash });
    },

    async getConflictVersions(slug, filePath) {
        return this.request(slug, 'conflict-versions', { filePath });
    },

    async readFile(slug, path) {
        return this.request(slug, 'file', { path });
    },

    async writeFile(slug, path, content) {
        return this.request(slug, 'write-file', { path, content });
    },

    async createDirectory(slug, path) {
        return this.request(slug, 'create-directory', { path });
    },
    

    async writeFilesBatch(slug, files, options = {}) {
        return this.request(slug, 'write-files-batch', {
            files,
            syncToGcs: options.syncToGcs !== false,
        });
    },
    
    /**
     * Clear Yjs collaboration persistence for specified files.
     * Used after merge conflict resolution to ensure fresh content loads.
     * @param {string} slug - Workspace slug
     * @param {string[]} files - Array of file paths to clear
     */
    async clearCollabPersistence(slug, files) {
        return this.request(slug, 'clear-collab', { files });
    },

    /**
     * Get GitHub repo info (owner, repo, provider) extracted from the git remote URL.
     * Used by the Pull Requests panel.
     */
    async getGithubInfo(slug) {
        return this.request(slug, 'github-info');
    },
};
