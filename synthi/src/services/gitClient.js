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
        if (!response.ok) {
            throw new Error(`Git error: ${response.statusText}`);
        }
        return response.json();
    },

    async init(slug, remoteUrl) {
        return this.request(slug, 'init', { remoteUrl });
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

    async push(slug) {
        return this.request(slug, 'push');
    },

    async syncFile(slug, filePath, content) {
        return this.request(slug, 'sync', { filePath, content });
    }
};
