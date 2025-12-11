const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const gcsSync = require('./gcsSync');

// ===== Error Types for structured error handling =====
class GitError extends Error {
    constructor(message, code = 'GIT_ERROR', details = null) {
        super(message);
        this.name = 'GitError';
        this.code = code;
        this.details = details;
    }

    toJSON() {
        return {
            error: this.message,
            code: this.code,
            details: this.details
        };
    }
}

class RepoNotFoundError extends GitError {
    constructor(slug) {
        super(`Repository for slug ${slug} not found`, 'REPO_NOT_FOUND');
    }
}

class RepoNotInitializedError extends GitError {
    constructor(slug) {
        super(`Repository for slug ${slug} is not initialized`, 'REPO_NOT_INITIALIZED');
    }
}

class AuthenticationError extends GitError {
    constructor(message = 'Authentication failed') {
        super(message, 'AUTH_FAILED');
    }
}

class MergeConflictError extends GitError {
    constructor(files = []) {
        super('Merge conflict detected', 'MERGE_CONFLICT', { conflictedFiles: files });
        this.conflictedFiles = files;
    }
}

class RemoteNotConfiguredError extends GitError {
    constructor() {
        super('No remote configured for this repository', 'NO_REMOTE');
    }
}

// ===== Simple async mutex for per-repo locking =====
class RepoLock {
    constructor() {
        this.locks = new Map(); // slug -> Promise
    }

    async acquire(slug) {
        while (this.locks.has(slug)) {
            await this.locks.get(slug);
        }
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        this.locks.set(slug, promise);
        return () => {
            this.locks.delete(slug);
            release();
        };
    }
}

const repoLock = new RepoLock();

class GitService {
    constructor(baseDir) {
        this.baseDir = baseDir;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    // Helper to run operations with lock
    async withLock(slug, operation) {
        const release = await repoLock.acquire(slug);
        try {
            return await operation();
        } finally {
            release();
        }
    }

    // Centralized error mapper for git errors
    mapGitError(e, slug) {
        const msg = (e.message || '').toLowerCase();
        
        if (msg.includes('repository not found') || msg.includes('remote: repository not found')) {
            return new GitError('Remote repository not found or inaccessible. Check the remote URL and access permissions.', 'REMOTE_NOT_FOUND');
        }
        if (msg.includes('authentication failed') || msg.includes('user cancelled') || msg.includes('could not read username')) {
            return new AuthenticationError('Authentication failed. Please configure credentials or use an access token.');
        }
        if (msg.includes('conflict') || msg.includes('merge conflict')) {
            return new MergeConflictError();
        }
        if (msg.includes('not initialized')) {
            return new RepoNotInitializedError(slug);
        }
        if (msg.includes('not found') && msg.includes('slug')) {
            return new RepoNotFoundError(slug);
        }
        if (msg.includes('no remote configured') || msg.includes('no configured push destination')) {
            return new RemoteNotConfiguredError();
        }
        
        // Return original error with structured format
        return new GitError(e.message || 'Unknown git error', 'GIT_ERROR');
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
            throw new RepoNotFoundError(slug);
        }
        
        // Check for .git directory to prevent traversing up to parent repository
        const gitDir = path.join(repoPath, '.git');
        if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
             throw new RepoNotInitializedError(slug);
        }

        return simpleGit(repoPath);
    }

    async initRepo(slug, remoteUrl) {
        return this.withLock(slug, async () => {
            const repoPath = this.getRepoPath(slug);
            
            if (!fs.existsSync(repoPath)) {
                fs.mkdirSync(repoPath, { recursive: true });
            }

            // Download files from GCS before initializing git
            // This ensures all workspace files are in the repo
            if (gcsSync.isGcsConfigured()) {
                console.log(`[GitService] Downloading workspace files from GCS for slug: ${slug}`);
                try {
                    const downloadResult = await gcsSync.downloadGcsToRepo(slug, repoPath);
                    console.log(`[GitService] GCS download complete:`, downloadResult);
                } catch (e) {
                    console.warn(`[GitService] Failed to download from GCS, continuing with init:`, e.message);
                }
            }

            if (!fs.existsSync(path.join(repoPath, '.git'))) {
                const git = simpleGit(repoPath);
                await git.init();
                if (remoteUrl) {
                    await git.addRemote('origin', remoteUrl);
                }
            }
            return { success: true, path: repoPath };
        });
    }

    async cloneRepo(slug, repoUrl, token) {
        return this.withLock(slug, async () => {
            const repoPath = this.getRepoPath(slug);
            if (fs.existsSync(repoPath)) {
                throw new GitError(`Repository for slug ${slug} already exists`, 'REPO_EXISTS');
            }
            
            // Set up git with credential helper for secure token usage
            const git = simpleGit();
            
            // Clone with token using environment variable to avoid exposing in URL
            if (token && repoUrl.startsWith('https://')) {
                // Use GIT_ASKPASS with a temporary script or extraheader for authentication
                const cloneOptions = {
                    '--config': `http.extraheader=Authorization: Bearer ${token}`
                };
                
                try {
                    await git.clone(repoUrl, repoPath, cloneOptions);
                } catch (e) {
                    // Fallback to URL-based auth if extraheader fails (for GitHub tokens)
                    const urlWithToken = repoUrl.replace('https://', `https://oauth2:${token}@`);
                    await git.clone(urlWithToken, repoPath);
                    
                    // Remove token from stored remote URL after clone
                    const repoGit = simpleGit(repoPath);
                    await repoGit.remote(['set-url', 'origin', repoUrl]);
                }
            } else {
                await git.clone(repoUrl, repoPath);
            }
            
            // Upload cloned files to GCS so frontend can access them
            if (gcsSync.isGcsConfigured()) {
                console.log(`[GitService] Uploading cloned files to GCS for slug: ${slug}`);
                try {
                    const uploadResult = await gcsSync.uploadRepoToGcs(repoPath, slug);
                    console.log(`[GitService] GCS upload complete:`, uploadResult);
                } catch (e) {
                    console.warn(`[GitService] Failed to upload to GCS:`, e.message);
                    // Don't fail the clone operation, just log the warning
                }
            }
            
            return { success: true, path: repoPath };
        });
    }

    async listWorkspaces() {
        if (!fs.existsSync(this.baseDir)) return [];
        const dirents = fs.readdirSync(this.baseDir, { withFileTypes: true });
        return dirents
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    }

    async getStatus(slug) {
        if (!this.isRepoExists(slug)) return null;
        if (!this.isRepoInitialized(slug)) {
            return null;
        }
        
        try {
            const git = this.getGit(slug);
            const status = await git.status();
            
            // Check for merge conflicts
            const hasConflicts = status.conflicted && status.conflicted.length > 0;
            
            return {
                ...status,
                hasConflicts,
                conflictedFiles: status.conflicted || []
            };
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    async getBranches(slug) {
        if (!this.isRepoExists(slug)) return { local: [], current: '', all: [] };
        if (!this.isRepoInitialized(slug)) {
            return { local: [], current: '', all: [] };
        }
        
        try {
            const git = this.getGit(slug);
            const localSummary = await git.branchLocal();
            const allSummary = await git.branch(['-a']);
            return { 
                local: localSummary.all, 
                current: localSummary.current,
                all: allSummary.all 
            };
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    async checkout(slug, branchName, create = false) {
        return this.withLock(slug, async () => {
            const git = this.getGit(slug);
            try {
                if (create) {
                    await git.checkoutLocalBranch(branchName);
                } else {
                    await git.checkout(branchName);
                }
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async fetch(slug) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.fetch();
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async commit(slug, message) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.commit(message);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async stageFile(slug, filePath) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.add(filePath);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    // Stage specific lines/hunks using patch mode
    async stageLines(slug, filePath, patch) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                // Use git apply --cached to stage a specific patch
                await git.raw(['apply', '--cached', '--unidiff-zero'], patch);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async unstageFile(slug, filePath) {
        return this.withLock(slug, async () => {
            const git = this.getGit(slug);
            try {
                await git.reset(['HEAD', filePath]);
            } catch (e) {
                // Fallback for initial commit or if HEAD is invalid
                try {
                    await git.rm(['--cached', filePath]);
                } catch (e2) {
                    throw this.mapGitError(e, slug);
                }
            }
            return this.getStatus(slug);
        });
    }

    // Stage all changes
    async stageAll(slug) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.add('-A');
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    // Unstage all staged changes
    async unstageAll(slug) {
        return this.withLock(slug, async () => {
            const git = this.getGit(slug);
            try {
                await git.reset(['HEAD']);
            } catch (e) {
                // Fallback for initial commit - reset --mixed with rm --cached for each file
                try {
                    const status = await git.status();
                    for (const file of status.staged) {
                        await git.rm(['--cached', file]);
                    }
                } catch (e2) {
                    throw this.mapGitError(e, slug);
                }
            }
            return this.getStatus(slug);
        });
    }

    // Discard all unstaged changes
    async discardAll(slug) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                const status = await git.status();
                
                // Checkout all modified/deleted tracked files
                if (status.modified.length > 0 || status.deleted.length > 0) {
                    await git.checkout(['--', '.']);
                }
                
                // Clean untracked files
                if (status.not_added.length > 0) {
                    await git.clean('f', ['-d']);
                }
                
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async push(slug) {
        return this.withLock(slug, async () => {
            const git = this.getGit(slug);
            // Make sure we don't trigger interactive credential prompts in the server process
            const prev = process.env.GIT_TERMINAL_PROMPT;
            process.env.GIT_TERMINAL_PROMPT = '0';
            try {
                // If no remotes configured, attempt to auto-add from workspace metadata
                const remotes = await git.getRemotes(true);
                if (!remotes || remotes.length === 0) {
                    try {
                        const workspaceManager = require('./workspaceManager');
                        const ws = workspaceManager.getAllWorkspaces().find(w => w.slug === slug);
                        if (ws && ws.repoUrl) {
                            await git.addRemote('origin', ws.repoUrl);
                        } else {
                            throw new RemoteNotConfiguredError();
                        }
                    } catch (inner) {
                        if (inner instanceof RemoteNotConfiguredError) throw inner;
                        throw new RemoteNotConfiguredError();
                    }
                }

                await git.push();
            } catch (e) {
                const msg = (e.message || '').toLowerCase();

                // Handle 'no upstream branch' by attempting to set upstream automatically
                if (msg.includes('no upstream branch') || msg.includes('set-upstream') || msg.includes('no configured push destination') || msg.includes('no configured remote')) {
                    const branchSummary = await git.branchLocal();
                    const currentBranch = branchSummary.current;
                    if (currentBranch) {
                        const remotes = await git.getRemotes(true);
                        let remoteToUse = remotes && remotes.length > 0 ? remotes[0].name : null;
                        if (!remoteToUse) {
                            throw new RemoteNotConfiguredError();
                        }
                        try {
                            await git.push(remoteToUse, currentBranch, ['--set-upstream']);
                        } catch (pushErr) {
                            throw this.mapGitError(pushErr, slug);
                        }
                    } else {
                        throw this.mapGitError(e, slug);
                    }
                } else {
                    throw this.mapGitError(e, slug);
                }
            } finally {
                // Restore previous env value
                if (typeof prev === 'undefined') {
                    delete process.env.GIT_TERMINAL_PROMPT;
                } else {
                    process.env.GIT_TERMINAL_PROMPT = prev;
                }
            }
            return this.getStatus(slug);
        });
    }

    async addRemote(slug, name, url) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.addRemote(name, url);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async removeRemote(slug, name) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.removeRemote(name);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async getRemotes(slug) {
        try {
            const git = this.getGit(slug);
            return await git.getRemotes(true);
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    async pull(slug) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.pull();
                const status = await this.getStatus(slug);
                
                // Check for merge conflicts after pull
                if (status && status.hasConflicts) {
                    throw new MergeConflictError(status.conflictedFiles);
                }
                
                return status;
            } catch (e) {
                if (e instanceof MergeConflictError) throw e;
                throw this.mapGitError(e, slug);
            }
        });
    }

    async discardChange(slug, filePath) {
        return this.withLock(slug, async () => {
            try {
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
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    // Get structured diff with parsed hunks for better frontend display
    async getDiff(slug, filePath, options = {}) {
        if (!this.isRepoExists(slug)) return { raw: '', hunks: [] };
        if (!this.isRepoInitialized(slug)) return { raw: '', hunks: [] };
        
        try {
            const git = this.getGit(slug);
            let raw;
            if (filePath) {
                raw = await git.diff([filePath]);
            } else {
                raw = await git.diff();
            }
            
            // Parse diff into structured hunks if requested
            if (options.parsed) {
                const hunks = this.parseDiff(raw);
                return { raw, hunks };
            }
            
            return raw;
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    // Parse unified diff format into structured hunks
    parseDiff(diffText) {
        if (!diffText) return [];
        
        const hunks = [];
        const lines = diffText.split('\n');
        let currentHunk = null;
        let currentFile = null;
        
        for (const line of lines) {
            if (line.startsWith('diff --git')) {
                currentFile = line;
            } else if (line.startsWith('@@')) {
                // Parse hunk header: @@ -start,count +start,count @@
                const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@(.*)/);
                if (match) {
                    currentHunk = {
                        file: currentFile,
                        header: line,
                        oldStart: parseInt(match[1]),
                        oldCount: parseInt(match[2]) || 1,
                        newStart: parseInt(match[3]),
                        newCount: parseInt(match[4]) || 1,
                        context: match[5] || '',
                        lines: []
                    };
                    hunks.push(currentHunk);
                }
            } else if (currentHunk && (line.startsWith('+') || line.startsWith('-') || line.startsWith(' '))) {
                currentHunk.lines.push({
                    type: line[0] === '+' ? 'add' : line[0] === '-' ? 'remove' : 'context',
                    content: line.substring(1)
                });
            }
        }
        
        return hunks;
    }

    async getLog(slug, options = {}) {
        if (!this.isRepoExists(slug)) return { all: [], total: 0 };
        if (!this.isRepoInitialized(slug)) return { all: [], total: 0 };
        
        try {
            const git = this.getGit(slug);
            const { page = 1, limit = 50 } = options;
            const skip = (page - 1) * limit;
            
            // Get log with pagination
            const log = await git.log({ 
                n: limit,
                '--skip': skip
            });
            
            // Get total count for pagination info
            let total = log.total;
            if (!total) {
                try {
                    const countResult = await git.raw(['rev-list', '--count', 'HEAD']);
                    total = parseInt(countResult.trim()) || 0;
                } catch {
                    total = log.all.length;
                }
            }
            
            return { 
                all: log.all, 
                total,
                page,
                limit,
                hasMore: skip + log.all.length < total
            };
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    // Git blame support
    async getBlame(slug, filePath) {
        if (!this.isRepoExists(slug)) return [];
        if (!this.isRepoInitialized(slug)) return [];
        
        try {
            const git = this.getGit(slug);
            // Use porcelain format for easier parsing
            const blameOutput = await git.raw(['blame', '--line-porcelain', filePath]);
            return this.parseBlame(blameOutput);
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    parseBlame(blameText) {
        if (!blameText) return [];
        
        const lines = blameText.split('\n');
        const blameData = [];
        let currentEntry = {};
        
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            
            if (/^[0-9a-f]{40}/.test(line)) {
                // New commit hash line
                const parts = line.split(' ');
                currentEntry = {
                    hash: parts[0],
                    originalLine: parseInt(parts[1]),
                    finalLine: parseInt(parts[2]),
                    numLines: parseInt(parts[3]) || 1
                };
            } else if (line.startsWith('author ')) {
                currentEntry.author = line.substring(7);
            } else if (line.startsWith('author-time ')) {
                currentEntry.timestamp = parseInt(line.substring(12));
            } else if (line.startsWith('summary ')) {
                currentEntry.summary = line.substring(8);
            } else if (line.startsWith('\t')) {
                // Line content
                currentEntry.content = line.substring(1);
                blameData.push({ ...currentEntry });
            }
        }
        
        return blameData;
    }

    // ===== Stash Operations =====
    async stashList(slug) {
        try {
            const git = this.getGit(slug);
            const result = await git.stashList();
            return result.all || [];
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    async stashPush(slug, message = '') {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                const options = message ? ['-m', message] : [];
                await git.stash(['push', ...options]);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async stashPop(slug, index = 0) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.stash(['pop', `stash@{${index}}`]);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async stashDrop(slug, index = 0) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.stash(['drop', `stash@{${index}}`]);
                return this.stashList(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    async stashApply(slug, index = 0) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.stash(['apply', `stash@{${index}}`]);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
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
