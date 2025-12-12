const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');

class GitService {
    constructor(baseDir) {
        this.baseDir = baseDir;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    getRepoPath(slug) {
        return path.join(this.baseDir, slug);
    }

    isRepoExists(slug) {
        const repoPath = this.getRepoPath(slug);
        return fs.existsSync(repoPath);
    }

    isRepoInitialized(slug) {
        const repoPath = this.getRepoPath(slug);
        const gitDir = path.join(repoPath, '.git');
        return fs.existsSync(gitDir) && fs.statSync(gitDir).isDirectory();
    }

    getGit(slug) {
        const repoPath = this.getRepoPath(slug);
        if (!fs.existsSync(repoPath)) {
            throw new Error(`Repository for slug ${slug} not found`);
        }
        
        // Check for .git directory to prevent traversing up to parent repository
        const gitDir = path.join(repoPath, '.git');
        if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
             throw new Error(`Repository for slug ${slug} is not initialized`);
        }

        return simpleGit(repoPath);
    }

    async initRepo(slug, remoteUrl) {
        const repoPath = this.getRepoPath(slug);
        
        if (!fs.existsSync(repoPath)) {
            fs.mkdirSync(repoPath, { recursive: true });
        }

        if (!fs.existsSync(path.join(repoPath, '.git'))) {
            const git = simpleGit(repoPath);
            await git.init();
            if (remoteUrl) {
                await git.addRemote('origin', remoteUrl);
            }
        }
        return { success: true, path: repoPath };
    }

    async cloneRepo(slug, repoUrl, token) {
        const repoPath = this.getRepoPath(slug);
        if (fs.existsSync(repoPath)) {
            throw new Error(`Repository for slug ${slug} already exists`);
        }
        
        let urlToClone = repoUrl;
        // Inject token if provided and it's a GitHub URL
        if (token && repoUrl.startsWith('https://github.com/')) {
             urlToClone = repoUrl.replace('https://', `https://${token}@`);
        }
        
        await simpleGit().clone(urlToClone, repoPath);
        return { success: true, path: repoPath };
    }

    async listWorkspaces() {
        if (!fs.existsSync(this.baseDir)) return [];
        const dirents = fs.readdirSync(this.baseDir, { withFileTypes: true });
        return dirents
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    }

    async getStatus(slug) {
        try {
            if (!this.isRepoExists(slug)) return null;
            if (!this.isRepoInitialized(slug)) {
                console.debug(`Git status: repository ${slug} not initialized`);
                return null;
            }
            const git = this.getGit(slug);
            return await git.status();
        } catch (e) {
            console.error("Git status error:", e?.message || e);
            return null;
        }
    }

    async getBranches(slug) {
        try {
            if (!this.isRepoExists(slug)) return { local: [], current: '', all: [] };
            if (!this.isRepoInitialized(slug)) {
                console.debug(`Get branches: repository ${slug} not initialized`);
                return { local: [], current: '', all: [] };
            }
            const git = this.getGit(slug);
            const localSummary = await git.branchLocal();
            const allSummary = await git.branch(['-a']);
            return { 
                local: localSummary.all, 
                current: localSummary.current,
                all: allSummary.all 
            };
        } catch (e) {
            console.error("Get branches error:", e?.message || e);
            return { local: [], current: '', all: [] };
        }
    }

    async checkout(slug, branchName, create = false) {
        const git = this.getGit(slug);
        if (create) {
            await git.checkoutLocalBranch(branchName);
        } else {
            await git.checkout(branchName);
        }
        return this.getStatus(slug);
    }

    async fetch(slug) {
        const git = this.getGit(slug);
        await git.fetch();
        return this.getStatus(slug);
    }

    async commit(slug, message) {
        const git = this.getGit(slug);
        await git.commit(message);
        return this.getStatus(slug);
    }

    async stageFile(slug, filePath) {
        const git = this.getGit(slug);
        await git.add(filePath);
        return this.getStatus(slug);
    }

    async unstageFile(slug, filePath) {
        const git = this.getGit(slug);
        try {
            await git.reset(['HEAD', filePath]);
        } catch (e) {
            // Fallback for initial commit or if HEAD is invalid
            await git.rm(['--cached', filePath]);
        }
        return this.getStatus(slug);
    }

    async push(slug) {
        const git = this.getGit(slug);
        // Make sure we don't trigger interactive credential prompts in the server process
        const prev = process.env.GIT_TERMINAL_PROMPT;
        process.env.GIT_TERMINAL_PROMPT = '0';
        try {
            // If no remotes configured, attempt to auto-add from workspace metadata
            try {
                const remotes = await git.getRemotes(true);
                if (!remotes || remotes.length === 0) {
                    try {
                        const workspaceManager = require('./workspaceManager');
                        const ws = workspaceManager.getAllWorkspaces().find(w => w.slug === slug);
                        if (ws && ws.repoUrl) {
                            await git.addRemote('origin', ws.repoUrl);
                        }
                    } catch (inner) {
                        // Ignore, we'll handle missing remote error below
                        console.debug('workspaceManager not usable for push fallback', inner?.message || inner);
                    }
                }
            } catch (innerErr) {
                // If git.getRemotes fails, ignore and let push provide a clearer message
                console.debug('getRemotes failed prior to push:', innerErr?.message || innerErr);
            }

            await git.push();
        } catch (e) {
            const msg = (e.message || '').toLowerCase();

            // Handle 'no upstream branch' by attempting to set upstream automatically
            if (msg.includes('no upstream branch') || msg.includes('set-upstream') || msg.includes('no configured push destination') || msg.includes('no configured remote')) {
                const branchSummary = await git.branchLocal();
                const currentBranch = branchSummary.current;
                if (currentBranch) {
                    // Try to locate a configured remote to push to
                    try {
                        const remotes = await git.getRemotes(true);
                        let remoteToUse = remotes && remotes.length > 0 ? remotes[0].name : null;
                        if (!remoteToUse) {
                            try {
                                const workspaceManager = require('./workspaceManager');
                                const ws = workspaceManager.getAllWorkspaces().find(w => w.slug === slug);
                                if (ws && ws.repoUrl) {
                                    await git.addRemote('origin', ws.repoUrl);
                                    remoteToUse = 'origin';
                                }
                            } catch (inner) {
                                console.debug('workspaceManager not usable for push fallback', inner?.message || inner);
                            }
                        }
                        if (remoteToUse) {
                            try {
                                await git.push(remoteToUse, currentBranch, ['--set-upstream']);
                            } catch (pushErr) {
                                // Map push errors into helpful messages
                                const pushMsg = (pushErr.message || '').toLowerCase();
                                if (pushMsg.includes('repository not found')) {
                                    throw new Error('Remote repository not found or inaccessible. Check the remote URL and access permissions (token/SSH).');
                                }
                                if (pushMsg.includes('authentication failed') || pushMsg.includes('user cancelled')) {
                                    throw new Error('Authentication failed during push. Please configure remote credentials or use a token/SSH key.');
                                }
                                throw pushErr;
                            }
                        } else {
                            throw new Error('No remote configured for this repository. Add a remote with `git remote add origin <url>` or use /git/:slug/init with a remoteUrl.');
                        }
                    } catch (innerE) {
                        throw innerE;
                    }
                } else {
                    throw e;
                }
            }

            // Map common Git errors to clear, non-interactive messages
            if (msg.includes('repository not found')) {
                throw new Error('Remote repository not found or inaccessible. Check the remote URL and permissions (token/SSH).');
            }
            if (msg.includes('authentication failed') || msg.includes('user cancelled') || msg.includes('user cancelled dialog')) {
                throw new Error('Authentication failed during push. Please configure remote credentials or use a token/SSH key, and make sure the server process can push non-interactively.');
            }

            throw e;
        } finally {
            // Restore previous env value
            if (typeof prev === 'undefined') {
                delete process.env.GIT_TERMINAL_PROMPT;
            } else {
                process.env.GIT_TERMINAL_PROMPT = prev;
            }
        }
        return this.getStatus(slug);
    }

    async addRemote(slug, name, url) {
        const git = this.getGit(slug);
        await git.addRemote(name, url);
        return this.getStatus(slug);
    }

    async removeRemote(slug, name) {
        const git = this.getGit(slug);
        await git.removeRemote(name);
        return this.getStatus(slug);
    }

    async getRemotes(slug) {
        const git = this.getGit(slug);
        return await git.getRemotes(true);
    }

    async pull(slug) {
        const git = this.getGit(slug);
        await git.pull();
        return this.getStatus(slug);
    }

    async discardChange(slug, filePath) {
        const git = this.getGit(slug);
        // Check if file is untracked
        const status = await git.status();
        const fileStatus = status.files.find(f => f.path === filePath);
        
        if (fileStatus && fileStatus.index === '?') {
            // Untracked file, delete it
            const repoPath = this.getRepoPath(slug);
            const fullPath = path.join(repoPath, filePath);
            if (fs.existsSync(fullPath)) {
                fs.unlinkSync(fullPath);
            }
        } else {
            await git.checkout(filePath);
        }
        return this.getStatus(slug);
    }

    async getDiff(slug, filePath) {
        if (!this.isRepoExists(slug)) return '';
        if (!this.isRepoInitialized(slug)) return '';
        const git = this.getGit(slug);
        if (filePath) {
            return await git.diff([filePath]);
        }
        return await git.diff();
    }

    async getLog(slug) {
        try {
            if (!this.isRepoExists(slug)) return { all: [] };
            if (!this.isRepoInitialized(slug)) return { all: [] };
            const git = this.getGit(slug);
            return await git.log();
        } catch (e) {
            console.error('Get log error:', e?.message || e);
            return { all: [] };
        }
    }

    async getUnpushedCommits(slug, max = 50) {
        try {
            if (!this.isRepoExists(slug)) return [];
            if (!this.isRepoInitialized(slug)) return [];
            const git = this.getGit(slug);
            const branchSummary = await git.branchLocal();
            const currentBranch = branchSummary.current;
            if (!currentBranch) return [];

            // Try to determine upstream/tracking branch (if exists)
            let upstream = null;
            try {
                // rev-parse will throw if no upstream configured
                const res = await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${currentBranch}@{u}`]);
                upstream = res.trim();
            } catch (e) {
                // No configured upstream; attempt to use origin/<branch> if origin exists
                try {
                    const remotes = await git.getRemotes(true);
                    const hasOrigin = remotes && remotes.some(r => r.name === 'origin');
                    if (hasOrigin) {
                        upstream = `origin/${currentBranch}`;
                    }
                } catch (inner) {
                    // ignore
                }
            }

            if (!upstream) {
                // No upstream; consider last N local commits as 'unpushed candidates'
                const last = await git.log({ n: Math.min(max, 50) });
                return last.all;
            }

            // Use git.log with range upstream..currentBranch to get commits that are in current but not in upstream
            const unpushedLog = await git.log({ from: upstream, to: currentBranch, n: Math.min(max, 200) });
            return unpushedLog.all;
        } catch (e) {
            console.error('Get unpushed commits error:', e?.message || e);
            return [];
        }
    }

    async syncFile(slug, filePath, content) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        const dir = path.dirname(fullPath);
        await fs.promises.mkdir(dir, { recursive: true });
        await fs.promises.writeFile(fullPath, content);
    }
    
    async deleteFile(slug, filePath) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        try {
            await fs.promises.unlink(fullPath);
        } catch (_) {
            // ignore
        }
    }

    async listFiles(slug) {
        const repoPath = this.getRepoPath(slug);
        if (!fs.existsSync(repoPath)) return [];
        const metas = await this.listFilesMeta(slug);
        return metas.map(m => m.path);
    }

    async listFilesMeta(slug) {
        const repoPath = this.getRepoPath(slug);
        try {
            await fs.promises.access(repoPath);
        } catch (_) {
            return [];
        }

        const out = [];
        const stack = [repoPath];

        while (stack.length) {
            const dir = stack.pop();
            let dh;
            try {
                dh = await fs.promises.opendir(dir);
            } catch (_) {
                continue;
            }

            for await (const dirent of dh) {
                const name = dirent.name;
                if (name === '.git') continue;
                const full = path.join(dir, name);
                if (dirent.isDirectory()) {
                    // Include folder markers so the tree can represent empty dirs
                    try {
                        const st = await fs.promises.stat(full);
                        const relDir = path.relative(repoPath, full).replace(/\\/g, '/');
                        if (relDir) {
                            out.push({
                                path: relDir,
                                isFolder: true,
                                size: 0,
                                lastModified: st.mtimeMs,
                                extension: '',
                            });
                        }
                    } catch (_) {
                        // ignore
                    }
                    stack.push(full);
                } else if (dirent.isFile()) {
                    let st;
                    try {
                        st = await fs.promises.stat(full);
                    } catch (_) {
                        continue;
                    }
                    const rel = path.relative(repoPath, full).replace(/\\/g, '/');
                    const ext = (path.extname(rel).replace('.', '') || '').toLowerCase();
                    out.push({
                        path: rel,
                        size: st.size,
                        lastModified: st.mtimeMs,
                        extension: ext,
                    });
                }
            }
        }

        return out;
    }

    async readFile(slug, filePath) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        try {
            return await fs.promises.readFile(fullPath, 'utf-8');
        } catch (_) {
            throw new Error('File not found');
        }
    }

    async getFileContent(slug, filePath, ref = 'HEAD') {
        if (!this.isRepoExists(slug)) return '';
        if (!this.isRepoInitialized(slug)) return '';
        const git = this.getGit(slug);
        try {
            // Ensure forward slashes for git command and remove leading slash
            let gitPath = filePath.replace(/\\/g, '/');
            if (gitPath.startsWith('/')) gitPath = gitPath.substring(1);
            
            // Use raw show command to avoid simple-git parsing issues
            return await git.raw(['show', `${ref}:${gitPath}`]);
        } catch (e) {
            console.error(`Error fetching content for ${ref}:${filePath}`, e.message);
            try {
                // Fallback: try cat-file -p which is plumbing and might be more robust
                let gitPath = filePath.replace(/\\/g, '/');
                if (gitPath.startsWith('/')) gitPath = gitPath.substring(1);
                return await git.raw(['cat-file', '-p', `${ref}:${gitPath}`]);
            } catch (e2) {
                console.error(`Fallback cat-file failed for ${ref}:${filePath}`, e2.message);
                return '';
            }
        }
    }
}

module.exports = new GitService(path.join(__dirname, 'repos'));
