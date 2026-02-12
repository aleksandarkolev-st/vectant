const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gcsSync = require('./gcsSync');
const config = require('./config');
const repoCache = require('./repoCache');

const TEXT_EXTENSIONS = new Set([
    'js','jsx','ts','tsx','json','md','txt','py','rs','go','java','c','h','cpp','hpp','cs','html','css','yml','yaml','toml','xml','sh',
    'env','gitignore','dockerfile','makefile','gradle','lock'
]);

const BINARY_EXTENSIONS = new Set([
    'png','jpg','jpeg','gif','bmp','webp','ico','pdf','zip','tar','gz','bz2','xz','7z',
    'mp3','mp4','mov','avi','mkv','wav','ogg','flac','exe','dll','so','dylib','bin',
    'class','jar','war','psd','ai','ttf','otf','woff','woff2','wasm'
]);

const VENDOR_DIRS = new Set(['node_modules','vendor','third_party','external','.yarn','.pnpm']);
const GENERATED_DIRS = new Set(['dist','build','out','coverage','.next','.nuxt','target']);

function isBinaryExtension(ext) {
    return BINARY_EXTENSIONS.has(String(ext || '').toLowerCase());
}

function isVendorPath(relPath) {
    const parts = String(relPath || '').replace(/\\/g, '/').split('/');
    return parts.some((p) => VENDOR_DIRS.has(p));
}

function isGeneratedPath(relPath) {
    const parts = String(relPath || '').replace(/\\/g, '/').split('/');
    if (parts.some((p) => GENERATED_DIRS.has(p))) return true;
    const lower = relPath.toLowerCase();
    if (lower.includes('/generated/') || lower.includes('/gen/')) return true;
    if (lower.includes('.min.')) return true;
    if (lower.endsWith('.map')) return true;
    if (lower.endsWith('.pb.go') || lower.endsWith('.pb.cc') || lower.endsWith('.pb.h')) return true;
    if (lower.endsWith('.g.dart')) return true;
    return false;
}

function hashStream(stream) {
    return new Promise((resolve, reject) => {
        const hash = crypto.createHash('sha256');
        stream.on('data', (chunk) => hash.update(chunk));
        stream.on('error', reject);
        stream.on('end', () => resolve(hash.digest('hex')));
    });
}

async function hashFile(absPath) {
    const stream = fs.createReadStream(absPath);
    try {
        return await hashStream(stream);
    } finally {
        try { stream.destroy(); } catch (_) {}
    }
}

function languageForPath(p) {
    const ext = (path.extname(p || '').replace('.', '') || '').toLowerCase();
    const map = {
        js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript',
        py: 'python', rs: 'rust', go: 'go', java: 'java', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp',
        html: 'html', css: 'css', json: 'json', md: 'markdown', yml: 'yaml', yaml: 'yaml', toml: 'toml', xml: 'xml', sh: 'shell',
    };
    return map[ext] || (ext ? ext : 'plaintext');
}

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

class MigrationError extends GitError {
    constructor(slug, message, phase = 'unknown') {
        super(`Migration failed for ${slug}: ${message}`, 'MIGRATION_FAILED', { slug, phase });
        this.slug = slug;
        this.phase = phase;
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
        this.baseDir = baseDir || config.REPO_CACHE_DIR;
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    // Helper to run operations with lock + repo cache acquire/release
    async withLock(slug, operation) {
        const releaseLock = await repoLock.acquire(slug);
        try {
            // Ensure working tree is materialised before the operation
            await repoCache.acquire(slug);
            try {
                return await operation();
            } finally {
                repoCache.release(slug);
            }
        } finally {
            releaseLock();
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
        // NOTE: merge conflict detection should be handled explicitly by the
        // caller (e.g. pull()) using git status, NOT here.  mapGitError is a
        // generic fallback and doesn't have enough context to enumerate the
        // conflicted files.  Only match if the message is clearly a merge
        // conflict that somehow escaped the caller's handling.
        if (msg.includes('merge conflict') && !msg.includes('would be overwritten')) {
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

    /**
     * Archive the .git directory to GCS for fast re-hydration.
     * Called after mutating git operations (commit, pull, checkout, clone).
     * Fire-and-forget — failures are logged but never thrown.
     */
    _archiveGitAsync(slug) {
        // For migrated repos, archive the bare repo directory.
        // For legacy repos, archive the standard working tree.
        const barePath = this.getBarePath(slug);
        const repoPath = fs.existsSync(barePath) ? barePath : this.getRepoPath(slug);
        gcsSync.archiveGitToGcs(slug, repoPath).catch((e) => {
            console.warn(`[GitService] .git archive failed for ${slug}:`, e.message);
        });
    }

    isRepoExists(slug) {
        const repoPath = this.getRepoPath(slug);
        return fs.existsSync(repoPath);
    }

    isRepoInitialized(slug) {
        const repoPath = this.getRepoPath(slug);
        const gitDir = path.join(repoPath, '.git');
        if (!fs.existsSync(gitDir)) return false;

        const stat = fs.statSync(gitDir);
        // Standard repo: .git is a directory
        if (stat.isDirectory()) return true;
        // Migrated worktree: .git is a file pointing to the bare repo
        if (stat.isFile()) return true;

        return false;
    }

    getGit(slug) {
        const repoPath = this.getRepoPath(slug);
        if (!fs.existsSync(repoPath)) {
            throw new RepoNotFoundError(slug);
        }
        
        // Check for .git (directory for standard repos, file for worktrees)
        const gitDir = path.join(repoPath, '.git');
        if (!fs.existsSync(gitDir)) {
            throw new RepoNotInitializedError(slug);
        }

        const stat = fs.statSync(gitDir);
        if (!stat.isDirectory() && !stat.isFile()) {
            throw new RepoNotInitializedError(slug);
        }

        return simpleGit(repoPath);
    }

    /**
     * Ensure internal artifacts are listed in .git/info/exclude so they
     * never appear in git status, even if a bug places them in the working tree.
     * Safe to call multiple times — only appends if the pattern is missing.
     */
    _ensureLocalExcludes(repoPath) {
        try {
            // Resolve the actual git directory — handles both standard (.git dir)
            // and worktree (.git file pointing to gitdir)
            let gitDirPath = path.join(repoPath, '.git');
            try {
                const stat = fs.statSync(gitDirPath);
                if (stat.isFile()) {
                    // Worktree: .git file contains "gitdir: /path/to/actual/gitdir"
                    const content = fs.readFileSync(gitDirPath, 'utf8').trim();
                    const match = content.match(/^gitdir:\s*(.+)$/m);
                    if (match) {
                        gitDirPath = path.resolve(repoPath, match[1].trim());
                    }
                }
            } catch (_) {
                // Fall through — use the default .git path
            }

            const excludePath = path.join(gitDirPath, 'info', 'exclude');
            const infoDir = path.dirname(excludePath);
            if (!fs.existsSync(infoDir)) fs.mkdirSync(infoDir, { recursive: true });

            const existing = fs.existsSync(excludePath)
                ? fs.readFileSync(excludePath, 'utf8')
                : '';

            const patterns = ['.git-archive.tar.gz', '.synthi-migrated', '_upstream.git', 'sessions/'];
            const toAppend = patterns.filter(p => !existing.includes(p));
            if (toAppend.length > 0) {
                const suffix = existing.endsWith('\n') || existing === '' ? '' : '\n';
                fs.appendFileSync(excludePath, suffix + toAppend.join('\n') + '\n');
            }
        } catch (e) {
            console.warn('[GitService] Failed to update .git/info/exclude:', e.message);
        }
    }

    async initRepo(slug, remoteUrl) {
        return this.withLock(slug, async () => {
            // repoCache.acquire (inside withLock) already materialised files
            // from GCS if needed, so we only need to git-init if missing.
            const repoPath = this.getRepoPath(slug);
            
            if (!fs.existsSync(repoPath)) {
                fs.mkdirSync(repoPath, { recursive: true });
            }

            // ── Lazy migration: upgrade legacy repos transparently ────────
            // Must release the lock before calling ensureMigrated (it acquires its own)
            // But we're already inside withLock, so we check directly without re-locking.
            if (this.isLegacyRepo(slug)) {
                console.log(`[GitService] initRepo: legacy repo detected for "${slug}", migrating…`);
                // Perform inline migration (we already hold the lock)
                await this._createMigrationBackup(slug);
                try {
                    await this._migrateToSessionStructure(slug);
                    const valid = await this._validateMigration(slug);
                    if (!valid) {
                        throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                    }
                    this._cleanupMigrationBackup(slug);
                    console.log(`[GitService] initRepo: migration complete for "${slug}"`);
                } catch (e) {
                    console.error(`[GitService] initRepo: migration failed, rolling back:`, e.message);
                    try { await this._restoreMigrationBackup(slug); } catch (_) {}
                    // Fall through to normal init logic — legacy repo is restored
                }
            }

            if (!fs.existsSync(path.join(repoPath, '.git'))) {
                const git = simpleGit(repoPath);
                await git.init();
                if (remoteUrl) {
                    await git.addRemote('origin', remoteUrl);
                }
            }
            // Defense-in-depth: hide internal artifacts from git status
            this._ensureLocalExcludes(repoPath);
            return { success: true, path: repoPath };
        });
    }

    async cloneRepo(slug, repoUrl, token) {
        return this.withLock(slug, async () => {
            const repoPath = this.getRepoPath(slug);

            // ── Handle existing repo gracefully ───────────────────────────
            if (fs.existsSync(repoPath)) {
                const hasGit = fs.existsSync(path.join(repoPath, '.git'));

                // If it's a legacy repo, migrate it instead of throwing
                if (this.isLegacyRepo(slug)) {
                    console.log(`[GitService] cloneRepo: legacy repo exists for "${slug}", migrating instead of failing…`);
                    await this._createMigrationBackup(slug);
                    try {
                        await this._migrateToSessionStructure(slug);
                        const valid = await this._validateMigration(slug);
                        if (!valid) {
                            throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                        }
                        this._cleanupMigrationBackup(slug);
                        console.log(`[GitService] cloneRepo: migration complete, returning existing repo`);
                        return { success: true, path: repoPath, migrated: true };
                    } catch (e) {
                        console.error(`[GitService] cloneRepo: migration failed, rolling back:`, e.message);
                        try { await this._restoreMigrationBackup(slug); } catch (_) {}
                        // Fall through to existing-repo error
                    }
                }

                // Already migrated — not an error
                if (this.isMigratedRepo(slug)) {
                    console.log(`[GitService] cloneRepo: repo "${slug}" already exists and is migrated`);
                    return { success: true, path: repoPath, alreadyExists: true };
                }

                // Directory exists but has no .git — this is an empty stub
                // created by repoCache materialisation.  Remove it so `git clone`
                // can use the path as its target directory.
                if (!hasGit) {
                    console.log(`[GitService] cloneRepo: removing empty stub directory for "${slug}"`);
                    fs.rmSync(repoPath, { recursive: true, force: true });
                } else {
                    // Has a .git dir but isn't legacy and isn't migrated — genuinely exists
                    throw new GitError(`Repository for slug ${slug} already exists`, 'REPO_EXISTS');
                }
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

            // Archive .git to GCS for fast re-hydration after eviction
            this._archiveGitAsync(slug);
            // Defense-in-depth: hide internal artifacts from git status
            this._ensureLocalExcludes(repoPath);
            
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
                this._archiveGitAsync(slug);
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
                this._archiveGitAsync(slug);
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
                        const ws = workspaceManager.getBySlug(slug);
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
            const git = this.getGit(slug);
            try {
                const pullResult = await git.pull();
                const status = await this.getStatus(slug);
                
                // Check for merge conflicts after pull (in case pull succeeded but left conflicts)
                if (status && status.hasConflicts) {
                    throw new MergeConflictError(status.conflictedFiles);
                }
                
                this._archiveGitAsync(slug);
                
                return {
                    ...status,
                    pullSummary: {
                        changes: pullResult.summary?.changes || 0,
                        insertions: pullResult.summary?.insertions || 0,
                        deletions: pullResult.summary?.deletions || 0,
                    }
                };
            } catch (e) {
                // Archive .git even on conflict so the state is persisted
                this._archiveGitAsync(slug);
                if (e instanceof MergeConflictError) throw e;
                
                const msg = (e.message || '').toLowerCase();

                // ── Pre-condition failure: local uncommitted changes ──
                // This is NOT a merge conflict — the pull was rejected before
                // merging. Tell the user to commit/stash first.
                if (msg.includes('would be overwritten') || msg.includes('please commit your changes or stash')) {
                    throw new GitError(
                        'You have uncommitted changes that would be overwritten by merge. Please commit or stash them first.',
                        'UNCOMMITTED_CHANGES'
                    );
                }

                // ── Real merge conflict ──
                // The pull started a merge that ended with conflicts.
                // Use git.status() as the authoritative source for the file list
                // because stderr output format varies across Git versions.
                if (msg.includes('conflict') || msg.includes('merge failed') || msg.includes('automatic merge failed')) {
                    let conflictedFiles = [];
                    try {
                        const status = await git.status();
                        conflictedFiles = (status.conflicted || []).slice();
                    } catch (statusErr) {
                        console.warn('[GitService] git status failed after merge conflict:', statusErr.message);
                        // Last resort: try raw porcelain output
                        try {
                            const raw = await git.raw(['status', '--porcelain']);
                            conflictedFiles = (raw || '').split('\n')
                                .filter(line => line.startsWith('UU ') || line.startsWith('AA ') || line.startsWith('DD ')
                                             || line.startsWith('AU ') || line.startsWith('UA ')
                                             || line.startsWith('DU ') || line.startsWith('UD '))
                                .map(line => line.slice(3).trim())
                                .filter(Boolean);
                        } catch (_) { /* give up — throw with empty list */ }
                    }
                    throw new MergeConflictError(conflictedFiles);
                }
                
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

    // ===== Merge Conflict Resolution =====
    
    // Resolve conflict by accepting "ours" (current branch) version
    async resolveConflictOurs(slug, filePath) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.checkout(['--ours', filePath]);
                await git.add(filePath);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    // Resolve conflict by accepting "theirs" (incoming) version
    async resolveConflictTheirs(slug, filePath) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.checkout(['--theirs', filePath]);
                await git.add(filePath);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    // Mark a conflicted file as resolved (after manual edit)
    async markResolved(slug, filePath) {
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

    // Abort current merge (discard all merge changes)
    async abortMerge(slug) {
        return this.withLock(slug, async () => {
            try {
                const git = this.getGit(slug);
                await git.merge(['--abort']);
                return this.getStatus(slug);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        });
    }

    // Get the content for each version of a conflicted file
    async getConflictVersions(slug, filePath) {
        try {
            const git = this.getGit(slug);
            
            // Get the three versions: base, ours, theirs
            let base = '', ours = '', theirs = '';
            
            try {
                base = await git.raw(['show', `:1:${filePath}`]); // base (common ancestor)
            } catch (e) { /* file might not exist in base */ }
            
            try {
                ours = await git.raw(['show', `:2:${filePath}`]); // ours (current branch)
            } catch (e) { /* file might not exist in ours */ }
            
            try {
                theirs = await git.raw(['show', `:3:${filePath}`]); // theirs (incoming)
            } catch (e) { /* file might not exist in theirs */ }
            
            // Get current working copy (with conflict markers)
            let current = '';
            try {
                const repoPath = this.getRepoPath(slug);
                const fullPath = path.join(repoPath, filePath);
                current = fs.readFileSync(fullPath, 'utf-8');
            } catch (e) { /* ignore */ }
            
            return { base, ours, theirs, current };
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
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
                // No upstream configured - we cannot determine unpushed commits
                return [];
            }

            // Check if upstream ref actually exists locally (was fetched)
            try {
                await git.raw(['rev-parse', '--verify', upstream]);
            } catch (e) {
                // Upstream ref doesn't exist locally (never fetched)
                return [];
            }

            // Use raw git log with proper two-dot notation: upstream..HEAD
            // This shows commits reachable from HEAD but NOT from upstream (truly unpushed)
            try {
                const logOutput = await git.raw([
                    'log', 
                    `${upstream}..${currentBranch}`,  // Two-dot: in currentBranch but NOT in upstream
                    `--max-count=${Math.min(max, 200)}`,
                    '--format=%H|%s|%an|%ae|%aI'  // hash|subject|author|email|date
                ]);
                
                if (!logOutput || !logOutput.trim()) return [];
                
                return logOutput.trim().split('\n').filter(Boolean).map(line => {
                    const [hash, message, author_name, author_email, date] = line.split('|');
                    return { hash, message, author_name, author_email, date };
                });
            } catch (e) {
                console.error('Raw git log for unpushed failed:', e?.message);
                return [];
            }
        } catch (e) {
            console.error('Get unpushed commits error:', e?.message || e);
            return [];
        }
    }

    // Get commits that are in upstream but not in local (incoming/behind)
    async getIncomingCommits(slug, max = 50) {
        try {
            if (!this.isRepoExists(slug)) return [];
            if (!this.isRepoInitialized(slug)) return [];
            const git = this.getGit(slug);
            const branchSummary = await git.branchLocal();
            const currentBranch = branchSummary.current;
            if (!currentBranch) return [];

            // Try to determine upstream/tracking branch
            let upstream = null;
            try {
                const res = await git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', `${currentBranch}@{u}`]);
                upstream = res.trim();
            } catch (e) {
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

            if (!upstream) return [];

            // Check if upstream ref exists locally
            try {
                await git.raw(['rev-parse', '--verify', upstream]);
            } catch (e) {
                return [];
            }

            // Use raw git log with proper two-dot notation: HEAD..upstream
            // This shows commits reachable from upstream but NOT from HEAD (incoming)
            try {
                const logOutput = await git.raw([
                    'log', 
                    `${currentBranch}..${upstream}`,  // Two-dot: in upstream but NOT in currentBranch
                    `--max-count=${Math.min(max, 200)}`,
                    '--format=%H|%s|%an|%ae|%aI'  // hash|subject|author|email|date
                ]);
                
                if (!logOutput || !logOutput.trim()) return [];
                
                return logOutput.trim().split('\n').filter(Boolean).map(line => {
                    const [hash, message, author_name, author_email, date] = line.split('|');
                    return { hash, message, author_name, author_email, date };
                });
            } catch (e) {
                console.error('Raw git log for incoming failed:', e?.message);
                return [];
            }
        } catch (e) {
            console.error('Get incoming commits error:', e?.message || e);
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

    /**
     * Rename / move a file or directory.
     * @param {string} slug - Workspace slug
     * @param {string} oldPath - Current relative path
     * @param {string} newPath - Desired relative path
     * @returns {Promise<{success: boolean}>}
     */
    async renameItem(slug, oldPath, newPath) {
        const repoPath = this.getRepoPath(slug);
        const absOld = path.join(repoPath, oldPath);
        const absNew = path.join(repoPath, newPath);
        // Ensure the target directory exists
        await fs.promises.mkdir(path.dirname(absNew), { recursive: true });
        await fs.promises.rename(absOld, absNew);
        return { success: true };
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
    
    /**
     * Delete a file or directory (recursively)
     * @param {string} slug - Workspace slug
     * @param {string} itemPath - Path to file or directory
     * @returns {Promise<{deleted: number}>} Number of items deleted
     */
    async deleteItem(slug, itemPath) {
        const repoPath = this.getRepoPath(slug);
        // Remove trailing slash for path operations
        const cleanPath = itemPath.endsWith('/') ? itemPath.slice(0, -1) : itemPath;
        const fullPath = path.join(repoPath, cleanPath);
        
        let deleted = 0;
        
        try {
            const stat = await fs.promises.stat(fullPath);
            
            if (stat.isDirectory()) {
                // Recursively delete directory
                await fs.promises.rm(fullPath, { recursive: true, force: true });
                // Count approximate items (we'll say 1 for the dir itself)
                deleted = 1;
            } else {
                await fs.promises.unlink(fullPath);
                deleted = 1;
            }
        } catch (e) {
            if (e.code === 'ENOENT') {
                // File/folder doesn't exist - not an error
                return { deleted: 0, error: 'not_found' };
            }
            throw e;
        }
        
        return { deleted };
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
                                language: '',
                                is_text: false,
                                is_binary: false,
                                is_vendor: isVendorPath(relDir),
                                is_generated: isGeneratedPath(relDir),
                                content_hash: '',
                                last_author: null,
                                last_commit: null,
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
                    const isText = TEXT_EXTENSIONS.has(ext) || ext === '';
                    const isBinary = !isText && isBinaryExtension(ext);
                    let contentHash = '';
                    try {
                        contentHash = await hashFile(full);
                    } catch (_) {
                        contentHash = '';
                    }
                    out.push({
                        path: rel,
                        size: st.size,
                        lastModified: st.mtimeMs,
                        extension: ext,
                        language: languageForPath(rel),
                        is_text: isText,
                        is_binary: isBinary,
                        is_vendor: isVendorPath(rel),
                        is_generated: isGeneratedPath(rel),
                        content_hash: contentHash,
                        last_author: null,
                        last_commit: null,
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

    _sanitizeRelativePath(filePath) {
        if (typeof filePath !== 'string') return null;
        const raw = filePath.replace(/\\/g, '/').trim();
        if (!raw) return null;
        const stripped = raw.replace(/^\/+/, '');
        const parts = stripped.split('/').filter(Boolean);
        if (parts.length === 0) return null;
        // Prevent traversal
        for (const p of parts) {
            if (p === '..' || p === '.') return null;
            if (p.includes('\u0000')) return null;
        }
        return parts.join('/');
    }

    async writeFile(slug, filePath, content) {
        const repoPath = this.getRepoPath(slug);
        const safeRel = this._sanitizeRelativePath(filePath);
        if (!safeRel) {
            throw new Error('Invalid file path');
        }
        const fullPath = path.join(repoPath, safeRel);
        try {
            // Ensure directory exists
            const dirPath = path.dirname(fullPath);
            await fs.promises.mkdir(dirPath, { recursive: true });
            await fs.promises.writeFile(fullPath, content, 'utf-8');
        } catch (e) {
            throw new Error(`Failed to write file: ${e.message}`);
        }
    }

    async createDirectory(slug, dirPath) {
        const repoPath = this.getRepoPath(slug);
        const fullPath = path.join(repoPath, dirPath);
        try {
            await fs.promises.mkdir(fullPath, { recursive: true });
        } catch (e) {
            throw new Error(`Failed to create directory: ${e.message}`);
        }
    }

    async writeFilesBatch(slug, files, options = {}) {
        const syncToGcs = options.syncToGcs !== false;

        return this.withLock(slug, async () => {
            const repoPath = this.getRepoPath(slug);
            if (!Array.isArray(files)) {
                throw new Error('files must be an array');
            }

            const written = [];
            const skipped = [];
            const errors = [];

            for (const f of files) {
                try {
                    const rel = this._sanitizeRelativePath(f?.path);
                    if (!rel) {
                        skipped.push({ path: f?.path, reason: 'invalid_path' });
                        continue;
                    }

                    // NOTE: we intentionally do NOT allow folder markers here.
                    if (rel.endsWith('/')) {
                        skipped.push({ path: rel, reason: 'folders_not_supported' });
                        continue;
                    }

                    const encoding = (f?.encoding || 'utf8').toLowerCase();
                    const content = (typeof f?.content === 'string') ? f.content : (typeof f?.contentBase64 === 'string' ? f.contentBase64 : null);
                    if (typeof content !== 'string') {
                        skipped.push({ path: rel, reason: 'missing_content' });
                        continue;
                    }

                    const fullPath = path.join(repoPath, rel);
                    await fs.promises.mkdir(path.dirname(fullPath), { recursive: true });

                    if (encoding === 'base64') {
                        const buf = Buffer.from(content, 'base64');
                        await fs.promises.writeFile(fullPath, buf);
                    } else {
                        await fs.promises.writeFile(fullPath, content, 'utf-8');
                    }

                    written.push({ path: rel, bytes: (encoding === 'base64') ? Buffer.byteLength(content, 'base64') : Buffer.byteLength(content, 'utf-8') });

                    if (syncToGcs && gcsSync.isGcsConfigured()) {
                        try {
                            await gcsSync.syncFileToGcs(slug, rel, content);
                        } catch (e) {
                            // Non-fatal: file is still written to repo, but storage may lag.
                            errors.push({ path: rel, stage: 'gcs_upload', error: e?.message || String(e) });
                        }
                    }
                } catch (e) {
                    errors.push({ path: f?.path, stage: 'write', error: e?.message || String(e) });
                }
            }

            return {
                success: errors.length === 0,
                written,
                skipped,
                errors,
            };
        });
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

    // ── Lazy Migration: Detection Helpers ───────────────────────────────────

    /**
     * Detect whether a repo at `repos/<slug>/` is a "legacy" flat working tree.
     *
     * Legacy layout:
     *   repos/<slug>/.git/   ← regular (non-bare) git directory
     *   repos/<slug>/src/
     *   repos/<slug>/...
     *
     * Returns `true` if the repo exists AND is a standard non-bare repo
     * WITHOUT the `.synthi-migrated` marker.
     */
    isLegacyRepo(slug) {
        const repoPath = this.getRepoPath(slug);
        const gitDir = path.join(repoPath, '.git');
        const marker = path.join(repoPath, '.synthi-migrated');

        // Must exist and have a .git directory (not a file — files indicate worktrees)
        if (!fs.existsSync(gitDir)) return false;
        try {
            const stat = fs.statSync(gitDir);
            if (!stat.isDirectory()) return false; // .git file = worktree, not legacy
        } catch (_) {
            return false;
        }

        // If already marked as migrated, it's not legacy
        if (fs.existsSync(marker)) return false;

        // Check it's NOT bare (bare repos have no working tree)
        try {
            const configPath = path.join(gitDir, 'config');
            if (fs.existsSync(configPath)) {
                const content = fs.readFileSync(configPath, 'utf8');
                if (content.includes('bare = true')) return false;
            }
        } catch (_) {
            // If we can't read config, assume non-bare
        }

        return true;
    }

    /**
     * Detect whether a repo has already been migrated to session-aware structure.
     * Checks for the `.synthi-migrated` marker file.
     */
    isMigratedRepo(slug) {
        const repoPath = this.getRepoPath(slug);
        return fs.existsSync(path.join(repoPath, '.synthi-migrated'));
    }

    /**
     * Get the path to the upstream bare repository for a slug.
     * After migration: repos/<slug>/_upstream.git
     */
    getBarePath(slug) {
        return path.join(this.baseDir, slug, '_upstream.git');
    }

    /**
     * Write the `.synthi-migrated` marker file to indicate successful migration.
     * Contains JSON metadata about when and how the migration was performed.
     */
    _writeMigrationMarker(slug) {
        const repoPath = this.getRepoPath(slug);
        const markerPath = path.join(repoPath, '.synthi-migrated');
        const metadata = {
            version: 1,
            migratedAt: new Date().toISOString(),
            barePath: this.getBarePath(slug),
            structure: 'bare+worktree',
        };
        fs.writeFileSync(markerPath, JSON.stringify(metadata, null, 2), 'utf8');
    }

    /**
     * Read migration metadata from the marker file (if it exists).
     * Returns null if the repo hasn't been migrated.
     */
    _readMigrationMarker(slug) {
        const repoPath = this.getRepoPath(slug);
        const markerPath = path.join(repoPath, '.synthi-migrated');
        if (!fs.existsSync(markerPath)) return null;
        try {
            return JSON.parse(fs.readFileSync(markerPath, 'utf8'));
        } catch (_) {
            return null;
        }
    }

    /**
     * Create a backup of the legacy repo before migration.
     * Copies `repos/<slug>/` → `repos/<slug>._migration_backup/`
     *
     * Returns the backup path. Caller is responsible for cleanup on success.
     *
     * @param {string} slug
     * @returns {Promise<string>} Backup directory path
     */
    async _createMigrationBackup(slug) {
        const repoPath = this.getRepoPath(slug);
        const backupPath = `${repoPath}._migration_backup`;

        // Clean up any stale backup from a previous failed migration
        if (fs.existsSync(backupPath)) {
            console.warn(`[Migration] Removing stale backup: ${backupPath}`);
            fs.rmSync(backupPath, { recursive: true, force: true });
        }

        console.log(`[Migration] Creating backup: ${repoPath} → ${backupPath}`);
        await fs.promises.cp(repoPath, backupPath, { recursive: true });
        return backupPath;
    }

    /**
     * Restore a repo from its migration backup (rollback).
     * Replaces the current repo directory with the backup.
     */
    async _restoreMigrationBackup(slug) {
        const repoPath = this.getRepoPath(slug);
        const backupPath = `${repoPath}._migration_backup`;

        if (!fs.existsSync(backupPath)) {
            throw new MigrationError(slug, 'No backup found for rollback', 'rollback');
        }

        console.warn(`[Migration] Rolling back: ${backupPath} → ${repoPath}`);

        // Remove the (partially) migrated repo
        if (fs.existsSync(repoPath)) {
            fs.rmSync(repoPath, { recursive: true, force: true });
        }

        // Restore from backup
        await fs.promises.rename(backupPath, repoPath);
        console.log(`[Migration] Rollback complete for ${slug}`);
    }

    /**
     * Remove the migration backup after successful migration.
     */
    _cleanupMigrationBackup(slug) {
        const backupPath = `${this.getRepoPath(slug)}._migration_backup`;
        if (fs.existsSync(backupPath)) {
            fs.rmSync(backupPath, { recursive: true, force: true });
            console.log(`[Migration] Backup cleaned up for ${slug}`);
        }
    }

    /**
     * Core migration: convert a legacy flat repo into bare + worktree structure.
     *
     * Steps:
     *  1. Clone --bare from the legacy repo → repos/<slug>/_upstream.git
     *  2. Preserve the original remote URL (if any) in the bare repo
     *  3. Remove the legacy .git directory from the working tree
     *  4. Re-attach the working tree as a git worktree of the bare repo
     *  5. Write the .synthi-migrated marker
     *
     * MUST be called under the repo lock.  Caller handles backup/rollback.
     *
     * @param {string} slug
     * @returns {Promise<{ barePath: string, worktreePath: string }>}
     */
    async _migrateToSessionStructure(slug) {
        const repoPath = this.getRepoPath(slug);
        const barePath = this.getBarePath(slug);
        const legacyGitDir = path.join(repoPath, '.git');

        console.log(`[Migration] ── Starting migration for "${slug}" ──`);
        console.log(`[Migration]   Legacy repo: ${repoPath}`);
        console.log(`[Migration]   Bare target: ${barePath}`);

        // ── Step 1: Capture metadata from legacy repo ─────────────────────
        const legacyGit = simpleGit(repoPath);

        let currentBranch = 'main';
        try {
            const status = await legacyGit.status();
            currentBranch = status.current || 'main';
        } catch (_) {}

        let remoteUrl = null;
        try {
            const remotes = await legacyGit.getRemotes(true);
            const origin = remotes.find(r => r.name === 'origin');
            if (origin && origin.refs && origin.refs.fetch) {
                remoteUrl = origin.refs.fetch;
            }
        } catch (_) {}

        console.log(`[Migration]   Branch: ${currentBranch}, Remote: ${remoteUrl || '(none)'}`);

        // ── Step 2: Create bare clone from the legacy repo ────────────────
        if (fs.existsSync(barePath)) {
            fs.rmSync(barePath, { recursive: true, force: true });
        }

        try {
            const git = simpleGit();
            await git.clone(repoPath, barePath, ['--bare']);
            console.log(`[Migration]   Bare clone created at: ${barePath}`);
        } catch (e) {
            throw new MigrationError(slug, `Bare clone failed: ${e.message}`, 'bare-clone');
        }

        // ── Step 3: Set the remote URL on the bare repo (if any) ──────────
        if (remoteUrl) {
            try {
                const bareGit = simpleGit(barePath);
                await bareGit.remote(['set-url', 'origin', remoteUrl]);
                console.log(`[Migration]   Remote URL preserved: ${remoteUrl}`);
            } catch (e) {
                // Non-fatal — the remote can be re-added later
                console.warn(`[Migration]   Failed to set remote URL: ${e.message}`);
            }
        }

        // ── Step 4: Remove the legacy .git and re-attach as worktree ──────
        try {
            // Remove the old .git directory
            fs.rmSync(legacyGitDir, { recursive: true, force: true });
            console.log(`[Migration]   Removed legacy .git directory`);

            // Register the existing working tree as a worktree of the bare repo
            const bareGit = simpleGit(barePath);
            await bareGit.raw(['worktree', 'add', '--detach', repoPath]);
            console.log(`[Migration]   Re-attached as worktree: ${repoPath}`);

            // Checkout the original branch in the worktree
            const wtGit = simpleGit(repoPath);
            try {
                await wtGit.checkout(currentBranch);
            } catch (_) {
                // Branch might not exist as a local ref — try creating it
                try {
                    await wtGit.checkoutLocalBranch(currentBranch);
                } catch (__) {}
            }
            console.log(`[Migration]   Checked out branch: ${currentBranch}`);
        } catch (e) {
            throw new MigrationError(slug, `Worktree re-attach failed: ${e.message}`, 'worktree-reattach');
        }

        // ── Step 5: Write migration marker ────────────────────────────────
        this._writeMigrationMarker(slug);
        console.log(`[Migration] ── Migration complete for "${slug}" ──`);

        return { barePath, worktreePath: repoPath };
    }

    /**
     * Validate that a migrated repo is functional.
     * Checks that the bare repo and main worktree are intact and operable.
     *
     * @param {string} slug
     * @returns {Promise<boolean>}
     */
    async _validateMigration(slug) {
        const repoPath = this.getRepoPath(slug);
        const barePath = this.getBarePath(slug);

        // 1. Bare repo must exist and be valid
        if (!fs.existsSync(barePath)) {
            console.error(`[Migration] Validation failed: bare repo missing at ${barePath}`);
            return false;
        }

        try {
            const bareGit = simpleGit(barePath);
            // Verify it's a valid bare repo by listing branches
            await bareGit.branch(['-a']);
        } catch (e) {
            console.error(`[Migration] Validation failed: bare repo not valid:`, e.message);
            return false;
        }

        // 2. Worktree (.git file) must exist in the working tree
        const gitFile = path.join(repoPath, '.git');
        if (!fs.existsSync(gitFile)) {
            console.error(`[Migration] Validation failed: .git file missing in worktree`);
            return false;
        }

        // 3. Worktree must be functional (can run git status)
        try {
            const wtGit = simpleGit(repoPath);
            await wtGit.status();
        } catch (e) {
            console.error(`[Migration] Validation failed: worktree not functional:`, e.message);
            return false;
        }

        // 4. Migration marker must exist
        if (!fs.existsSync(path.join(repoPath, '.synthi-migrated'))) {
            console.error(`[Migration] Validation failed: migration marker missing`);
            return false;
        }

        console.log(`[Migration] Validation passed for "${slug}"`);
        return true;
    }

    /**
     * Orchestrator: lazily migrate a legacy repo to session structure.
     *
     * If the repo is already migrated, this is a fast no-op.
     * If the repo is legacy, it performs a safe migration with backup/rollback.
     *
     * Thread-safe: uses the existing per-slug RepoLock.
     * Idempotent: multiple calls are safe.
     *
     * @param {string} slug
     * @returns {Promise<{ migrated: boolean, wasLegacy: boolean }>}
     */
    async ensureMigrated(slug) {
        // Fast path: already migrated
        if (this.isMigratedRepo(slug)) {
            return { migrated: true, wasLegacy: false };
        }

        // Not legacy either — brand-new or doesn't exist yet
        if (!this.isLegacyRepo(slug)) {
            return { migrated: false, wasLegacy: false };
        }

        // ── Legacy repo detected — migrate under lock ────────────────────
        const releaseLock = await repoLock.acquire(slug);
        try {
            // Double-check after acquiring lock (another caller may have migrated)
            if (this.isMigratedRepo(slug)) {
                return { migrated: true, wasLegacy: false };
            }
            if (!this.isLegacyRepo(slug)) {
                return { migrated: false, wasLegacy: false };
            }

            console.log(`[Migration] Legacy repo detected for "${slug}", starting migration…`);

            // 1. Backup
            await this._createMigrationBackup(slug);

            try {
                // 2. Migrate
                await this._migrateToSessionStructure(slug);

                // 3. Validate
                const valid = await this._validateMigration(slug);
                if (!valid) {
                    throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                }

                // 4. Cleanup backup on success
                this._cleanupMigrationBackup(slug);

                return { migrated: true, wasLegacy: true };
            } catch (e) {
                // Rollback on any failure
                console.error(`[Migration] Migration failed for "${slug}", rolling back:`, e.message);
                try {
                    await this._restoreMigrationBackup(slug);
                } catch (rollbackErr) {
                    console.error(`[Migration] CRITICAL: Rollback also failed for "${slug}":`, rollbackErr.message);
                    // At this point both migration and rollback failed.
                    // The backup directory still exists for manual recovery.
                }
                throw e instanceof MigrationError ? e : new MigrationError(slug, e.message, 'unknown');
            }
        } finally {
            releaseLock();
        }
    }

    // ── Worktree Factory (Session-based isolation) ────────────────────────

    /**
     * Get the sessions directory for a workspace slug.
     *
     * Structure:
     *   repos/<slug>/              ← main working tree (shared / upstream)
     *   repos/<slug>/sessions/     ← per-user worktrees
     *   repos/<slug>/sessions/<userId>/
     */
    getSessionsDir(slug) {
        return path.join(this.baseDir, slug, 'sessions');
    }

    /**
     * Get the worktree path for a specific user's session.
     */
    getSessionWorktreePath(slug, userId) {
        return path.join(this.getSessionsDir(slug), userId);
    }

    /**
     * Ensure a private worktree exists for a user (Host).
     * Uses `git worktree add` to create an isolated copy that shares the
     * same .git object database as the main repo.
     *
     * If the worktree already exists, this is a no-op and returns the path.
     *
     * @param {string} slug   — Workspace slug
     * @param {string} userId — The host user's id
     * @param {string} [branch] — Branch to check out (defaults to current branch)
     * @returns {Promise<{ path: string, created: boolean }>}
     */
    async ensureSessionWorktree(slug, userId, branch = null) {
        return this.withLock(slug, async () => {
            // ── Lazy migration: upgrade legacy repos before creating worktrees
            if (this.isLegacyRepo(slug)) {
                console.log(`[GitService] ensureSessionWorktree: legacy repo for "${slug}", migrating…`);
                await this._createMigrationBackup(slug);
                try {
                    await this._migrateToSessionStructure(slug);
                    const valid = await this._validateMigration(slug);
                    if (!valid) {
                        throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                    }
                    this._cleanupMigrationBackup(slug);
                } catch (e) {
                    console.error(`[GitService] ensureSessionWorktree: migration failed, rolling back:`, e.message);
                    try { await this._restoreMigrationBackup(slug); } catch (_) {}
                    throw e instanceof MigrationError ? e : new MigrationError(slug, e.message, 'worktree-migration');
                }
            }

            const worktreePath = this.getSessionWorktreePath(slug, userId);

            // If worktree already exists, just return it
            if (fs.existsSync(worktreePath) && fs.existsSync(path.join(worktreePath, '.git'))) {
                console.log(`[GitService] Session worktree already exists: ${worktreePath}`);
                return { path: worktreePath, created: false };
            }

            // Ensure the main repo is initialized
            const mainRepoPath = this.getRepoPath(slug);
            if (!fs.existsSync(path.join(mainRepoPath, '.git'))) {
                throw new GitError(`Main repo for ${slug} not initialized`, 'REPO_NOT_INITIALIZED');
            }

            const sessionsDir = this.getSessionsDir(slug);
            if (!fs.existsSync(sessionsDir)) {
                fs.mkdirSync(sessionsDir, { recursive: true });
            }

            // For migrated repos, use the bare repo as the worktree source.
            // For non-migrated repos, fall back to the main working tree.
            const gitSourcePath = this.isMigratedRepo(slug)
                ? this.getBarePath(slug)
                : mainRepoPath;

            // Exclude sessions directory from git tracking
            if (!this.isMigratedRepo(slug)) {
                this._ensureLocalExcludes(mainRepoPath);
            }

            const git = simpleGit(gitSourcePath);

            // Determine branch to use
            if (!branch) {
                try {
                    const status = await git.status();
                    branch = status.current || 'main';
                } catch (_) {
                    branch = 'main';
                }
            }

            try {
                // Create a new worktree.  Use --detach to avoid the
                // "branch already checked out" error when the same branch
                // is active in the main working tree.
                await git.raw(['worktree', 'add', '--detach', worktreePath]);
                // Then check out the desired branch in the worktree
                const wtGit = simpleGit(worktreePath);
                await wtGit.checkout(branch).catch(() => {
                    // If branch doesn't exist locally, try to create it
                    return wtGit.checkoutLocalBranch(branch).catch(() => {});
                });
                console.log(`[GitService] Created session worktree: ${worktreePath} (branch: ${branch})`);
            } catch (e) {
                console.error(`[GitService] Failed to create worktree for ${slug}/${userId}:`, e.message);
                throw new GitError(`Failed to create session worktree: ${e.message}`, 'WORKTREE_ERROR');
            }

            return { path: worktreePath, created: true };
        });
    }

    /**
     * Remove a user's session worktree.
     */
    async removeSessionWorktree(slug, userId) {
        return this.withLock(slug, async () => {
            const worktreePath = this.getSessionWorktreePath(slug, userId);

            if (!fs.existsSync(worktreePath)) {
                return { success: true, existed: false };
            }

            try {
                // Use bare repo for migrated repos, main working tree otherwise
                const gitSourcePath = this.isMigratedRepo(slug)
                    ? this.getBarePath(slug)
                    : this.getRepoPath(slug);
                const git = simpleGit(gitSourcePath);
                await git.raw(['worktree', 'remove', '--force', worktreePath]);
                console.log(`[GitService] Removed session worktree: ${worktreePath}`);
            } catch (e) {
                // Force cleanup if git worktree remove fails
                console.warn(`[GitService] git worktree remove failed, force-deleting: ${e.message}`);
                try {
                    fs.rmSync(worktreePath, { recursive: true, force: true });
                } catch (_) {}
            }

            return { success: true, existed: true };
        });
    }

    /**
     * List all active session worktrees for a slug.
     */
    async listSessionWorktrees(slug) {
        const sessionsDir = this.getSessionsDir(slug);
        if (!fs.existsSync(sessionsDir)) return [];

        try {
            const entries = fs.readdirSync(sessionsDir, { withFileTypes: true });
            return entries
                .filter(e => e.isDirectory())
                .map(e => ({
                    userId: e.name,
                    path: path.join(sessionsDir, e.name),
                }));
        } catch (_) {
            return [];
        }
    }
}

const { REPOS_DIR } = require('./config');

const gitService = new GitService(REPOS_DIR);

// Export the singleton instance as default, with error classes attached
gitService.GitError = GitError;
gitService.MigrationError = MigrationError;
gitService.RepoNotFoundError = RepoNotFoundError;
gitService.RepoNotInitializedError = RepoNotInitializedError;
gitService.MergeConflictError = MergeConflictError;
gitService.AuthenticationError = AuthenticationError;
gitService.RemoteNotConfiguredError = RemoteNotConfiguredError;

module.exports = gitService;
