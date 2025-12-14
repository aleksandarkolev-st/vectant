const COLLAB_SERVER_URL = process.env.NEXT_PUBLIC_COLLAB_SERVER_URL || 'http://localhost:1234';

export const gitClient = {
    async request(slug, action, data = {}) {
        const response = await fetch(`${COLLAB_SERVER_URL}/git/${slug}/${action}`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
            },
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
            const error = new Error((body && (body.error || body.message)) || response.statusText || 'Unknown git error');
            error.code = body?.code || 'UNKNOWN';
            error.details = body?.details || null;
            error.statusCode = response.status;
            throw error;
        }
        return body;
    },

    async init(slug, remoteUrl) {
        return this.request(slug, 'init', { remoteUrl });
    },

    async addRemote(slug, name, url) {
        return this.request(slug, 'add-remote', { name, url });
    },

    async removeRemote(slug, name) {
        return this.request(slug, 'remove-remote', { name });
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

    async checkout(slug, branch, create = false) {
        return this.request(slug, 'checkout', { branch, create });
    },

    async fetch(slug) {
        return this.request(slug, 'fetch');
    },

    async commit(slug, message) {
        return this.request(slug, 'commit', { message });
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

    async unstageFile(slug, filePath) {
        return this.request(slug, 'unstage', { filePath });
    },

    async unstageAll(slug) {
        return this.request(slug, 'unstage-all');
    },

    async push(slug) {
        return this.request(slug, 'push');
    },

    async pull(slug) {
        return this.request(slug, 'pull');
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

    async getConflictVersions(slug, filePath) {
        return this.request(slug, 'conflict-versions', { filePath });
    },

    async readFile(slug, path) {
        return this.request(slug, 'file', { path });
    },

    async writeFile(slug, path, content) {
        return this.request(slug, 'write-file', { path, content });
    },
    
    /**
     * Clear Yjs collaboration persistence for specified files.
     * Used after merge conflict resolution to ensure fresh content loads.
     * @param {string} slug - Workspace slug
     * @param {string[]} files - Array of file paths to clear
     */
    async clearCollabPersistence(slug, files) {
        return this.request(slug, 'clear-collab', { files });
    }
};
