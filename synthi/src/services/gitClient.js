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
            const msg = (body && (body.error || body.message)) || response.statusText || 'Unknown git error';
            throw new Error(msg);
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

    async unstageFile(slug, filePath) {
        return this.request(slug, 'unstage', { filePath });
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

    async getDiff(slug, filePath) {
        return this.request(slug, 'diff', { filePath });
    },

    async getLog(slug) {
        return this.request(slug, 'log');
    },

    async getUnpushed(slug, max = 50) {
        return this.request(slug, 'unpushed', { max });
    },

    async syncFile(slug, filePath, content) {
        return this.request(slug, 'sync', { filePath, content });
    },

    async getFileContent(slug, filePath, ref = 'HEAD') {
        return this.request(slug, 'file-content', { filePath, ref });
    }
};
