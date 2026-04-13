/**
 * WorkspaceManager — In-memory workspace metadata store.
 *
 * This replaced the previous file-based workspaces.json approach which had
 * several problems:
 *   - No concurrency safety (multiple writes could corrupt the file)
 *   - Plaintext credentials (GitHub tokens) stored on disk
 *   - State drift between this file and the Prisma DB in the main Synthi app
 *
 * Now workspace metadata is held in-memory and seeded on-demand. The Prisma DB
 * in the main Synthi app is the authoritative source for workspace records.
 * This in-memory store is only used to cache metadata during the lifetime of
 * the collab-server process (e.g., to look up remote URLs for push operations).
 *
 * On restart, metadata is re-populated when workspaces are accessed.
 */

class WorkspaceManager {
    constructor() {
        /** @type {Map<string, {slug: string, repoUrl: string, owner: string, name: string, createdAt: string}>} */
        this.workspaces = new Map();
    }

    /**
     * Register a workspace. Called after clone or when a workspace is first accessed.
     * Stores only non-sensitive metadata (repoUrl should NOT contain tokens).
     */
    addWorkspace(slug, repoUrl, owner, name) {
        if (this.workspaces.has(slug)) return;

        // Strip any embedded tokens from the URL before storing
        let safeUrl = repoUrl || '';
        try {
            if (safeUrl.includes('@') && safeUrl.startsWith('https://')) {
                const url = new URL(safeUrl);
                url.username = '';
                url.password = '';
                safeUrl = url.toString();
            }
        } catch (_) {
            // If URL parsing fails, keep as-is but log a warning
            console.warn('[WorkspaceManager] Could not parse repoUrl to strip credentials');
        }

        this.workspaces.set(slug, {
            slug,
            repoUrl: safeUrl,
            owner: owner || '',
            name: name || slug,
            createdAt: new Date().toISOString(),
        });
    }

    /**
     * Get workspaces optionally filtered by owner.
     */
    getWorkspaces(owner) {
        const all = Array.from(this.workspaces.values());
        if (!owner) return all;
        return all.filter(w => w.owner === owner);
    }

    /**
     * Get all workspaces.
     */
    getAllWorkspaces() {
        return Array.from(this.workspaces.values());
    }

    /**
     * Find a single workspace by slug.
     */
    getBySlug(slug) {
        return this.workspaces.get(slug) || null;
    }
}

module.exports = new WorkspaceManager();
