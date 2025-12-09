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
        try {
            await git.push();
        } catch (e) {
            const msg = (e.message || '').toLowerCase();
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
                            await git.push(remoteToUse, currentBranch, ['--set-upstream']);
                        } else {
                            throw new Error('No remote configured for this repository. Add a remote with `git remote add origin <url>` or use /git/:slug/init with a remoteUrl.');
                        }
                    } catch (innerE) {
                        throw innerE;
                    }
                } else {
                    throw e;
                }
            } else {
                throw e;
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

    async syncFile(slug, filePath, content) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        const dir = path.dirname(fullPath);
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(fullPath, content);
    }
    
    async deleteFile(slug, filePath) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        if (fs.existsSync(fullPath)) {
            fs.unlinkSync(fullPath);
        }
    }

    async listFiles(slug) {
        const repoPath = this.getRepoPath(slug);
        if (!fs.existsSync(repoPath)) return [];
        
        const getFiles = (dir, baseDir) => {
            let results = [];
            const list = fs.readdirSync(dir);
            list.forEach(file => {
                if (file === '.git') return;
                const filePath = path.join(dir, file);
                const stat = fs.statSync(filePath);
                if (stat && stat.isDirectory()) {
                    results = results.concat(getFiles(filePath, baseDir));
                } else {
                    results.push(path.relative(baseDir, filePath).replace(/\\/g, '/'));
                }
            });
            return results;
        };
        
        return getFiles(repoPath, repoPath);
    }

    async readFile(slug, filePath) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, filePath);
        if (fs.existsSync(fullPath)) {
            return fs.readFileSync(fullPath, 'utf-8');
        }
        throw new Error('File not found');
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
