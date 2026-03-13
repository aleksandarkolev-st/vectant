const simpleGit = require('simple-git');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const gcsSync = require('./gcsSync');
const config = require('./config');
const repoCache = require('./repoCache');

let NodeGit = null;
let nodeGitLoadError = null;
try {
    NodeGit = require('nodegit');
} catch (error) {
    nodeGitLoadError = error;
}

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
// Directories to ALWAYS skip when listing files (never descend)
const SKIP_DIRS = new Set(['.git', 'node_modules', '.synthi', '.code_intel', '__pycache__', '.next', '.venv', 'venv', '.tox', '.mypy_cache', '.pytest_cache', '.turbo', '.cache', '.parcel-cache']);

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
        this.statusCache = new Map();
        this.statusRefreshes = new Map();
        if (!fs.existsSync(this.baseDir)) {
            fs.mkdirSync(this.baseDir, { recursive: true });
        }
    }

    _cacheKeyForRepoPath(repoPath) {
        return path.resolve(repoPath);
    }

    _inferScopeFromRepoPath(repoPath, fallbackSlug = null) {
        try {
            const relative = path.relative(this.baseDir, repoPath || '');
            const parts = relative.split(path.sep).filter(Boolean);
            if (parts.length >= 2) {
                return { slug: parts[0], userId: parts[1] };
            }
            if (parts.length === 1) {
                return { slug: parts[0], userId: null };
            }
        } catch (_) {}
        return { slug: fallbackSlug || null, userId: null };
    }

    _emptyStatus(current = 'main') {
        return {
            not_added: [], created: [], deleted: [], modified: [],
            renamed: [], staged: [], conflicted: [],
            files: [], ahead: 0, behind: 0, current, tracking: null,
            hasConflicts: false, conflictedFiles: [],
        };
    }

    _filterStatus(status) {
        const AI_INDEX_PREFIXES = ['.synthi/', '.code_intel/', '.code_intel_backups/'];
        const isAIPath = (filePath) => AI_INDEX_PREFIXES.some(p => filePath.startsWith(p));
        const filterFiles = (arr) => (arr || []).filter(f => !isAIPath(typeof f === 'string' ? f : f.path || ''));

        const filteredStatus = {
            ...status,
            files: filterFiles(status.files),
            not_added: (status.not_added || []).filter(f => !isAIPath(f)),
            created: (status.created || []).filter(f => !isAIPath(f)),
            deleted: (status.deleted || []).filter(f => !isAIPath(f)),
            modified: (status.modified || []).filter(f => !isAIPath(f)),
            renamed: filterFiles(status.renamed),
            staged: (status.staged || []).filter(f => !isAIPath(f)),
            conflicted: (status.conflicted || []).filter(f => !isAIPath(f)),
        };

        const hasConflicts = filteredStatus.conflicted && filteredStatus.conflicted.length > 0;

        return {
            ...filteredStatus,
            hasConflicts,
            conflictedFiles: filteredStatus.conflicted || []
        };
    }

    _normalizeBranchRefName(refName) {
        const raw = String(refName || '').trim();
        if (!raw) return '';
        if (raw.startsWith('refs/heads/')) return raw.slice('refs/heads/'.length);
        if (raw.startsWith('refs/remotes/')) return raw.slice('refs/remotes/'.length);
        return raw;
    }

    _buildStatusFileEntry(filePath, statusBits) {
        const STATUS = NodeGit?.Status?.STATUS || {};
        let index = ' ';
        let workingDir = ' ';

        if (statusBits & STATUS.CONFLICTED) {
            index = 'U';
            workingDir = 'U';
        } else {
            if (statusBits & STATUS.INDEX_NEW) index = 'A';
            else if (statusBits & STATUS.INDEX_MODIFIED) index = 'M';
            else if (statusBits & STATUS.INDEX_DELETED) index = 'D';
            else if (statusBits & STATUS.INDEX_RENAMED) index = 'R';
            else if (statusBits & STATUS.INDEX_TYPECHANGE) index = 'T';

            if (statusBits & STATUS.WT_NEW) {
                index = '?';
                workingDir = '?';
            } else if (statusBits & STATUS.WT_MODIFIED) {
                workingDir = 'M';
            } else if (statusBits & STATUS.WT_DELETED) {
                workingDir = 'D';
            } else if (statusBits & STATUS.WT_RENAMED) {
                workingDir = 'R';
            } else if (statusBits & STATUS.WT_TYPECHANGE) {
                workingDir = 'T';
            }
        }

        return {
            path: filePath,
            index,
            working_dir: workingDir,
        };
    }

    _pushUniquePath(list, seen, filePath) {
        const normalized = String(filePath || '').trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        list.push(normalized);
    }

    _pushUniqueRename(list, seen, filePath) {
        const normalized = String(filePath || '').trim();
        if (!normalized || seen.has(normalized)) return;
        seen.add(normalized);
        list.push({ from: normalized, to: normalized });
    }

    _decorateCommitRef(refs, shortHash, name, type) {
        if (!shortHash || !name || !type) return;
        if (!refs[shortHash]) refs[shortHash] = [];
        if (!refs[shortHash].some((ref) => ref.name === name && ref.type === type)) {
            refs[shortHash].push({ name, type });
        }
    }

    _classifyDecoratedRef(refName) {
        if (refName.startsWith('refs/tags/')) {
            return { name: refName.slice('refs/tags/'.length), type: 'tag' };
        }
        if (refName.startsWith('refs/remotes/')) {
            const normalized = refName.slice('refs/remotes/'.length);
            if (!normalized || /\/HEAD$/.test(normalized)) return null;
            return { name: normalized, type: 'remote' };
        }
        if (refName.startsWith('refs/heads/')) {
            return { name: refName.slice('refs/heads/'.length), type: 'branch' };
        }
        return null;
    }

    async _readCommitRefsWithNodeGit(repo) {
        const refs = {};
        let currentBranchRefName = null;

        try {
            const currentBranch = await repo.getCurrentBranch();
            currentBranchRefName = currentBranch?.name?.() || null;
        } catch (_) {}

        const refNames = await repo.getReferenceNames(NodeGit.Reference.TYPE.ALL);
        for (const refName of refNames) {
            const decorated = this._classifyDecoratedRef(refName);
            if (!decorated) continue;

            try {
                const commit = await repo.getReferenceCommit(refName);
                const shortHash = commit?.sha?.()?.slice(0, 7);
                if (!shortHash) continue;
                this._decorateCommitRef(refs, shortHash, decorated.name, decorated.type);
                if (decorated.type === 'branch' && currentBranchRefName === refName) {
                    this._decorateCommitRef(refs, shortHash, decorated.name, 'head');
                }
            } catch (_) {
                // Best-effort decoration only.
            }
        }

        return refs;
    }

    async _countCommitsWithNodeGit(repo, headOid) {
        const walker = repo.createRevWalk();
        walker.sorting(NodeGit.Revwalk.SORT.TOPOLOGICAL, NodeGit.Revwalk.SORT.TIME);
        walker.push(headOid);

        let total = 0;
        while (true) {
            try {
                await walker.next();
                total += 1;
            } catch (error) {
                if (error?.errno === NodeGit.Error.CODE.ITEROVER) {
                    break;
                }
                throw error;
            }
        }

        return total;
    }

    async _readLogWithNodeGit(repoPath, options = {}) {
        const repo = await NodeGit.Repository.open(repoPath);
        const { page = 1, limit = 50 } = options;
        const skip = Math.max(0, (page - 1) * limit);
        const headCommit = await repo.getHeadCommit();

        if (!headCommit) {
            return { all: [], total: 0, refs: {}, page, limit, hasMore: false };
        }

        const walker = repo.createRevWalk();
        walker.sorting(NodeGit.Revwalk.SORT.TOPOLOGICAL, NodeGit.Revwalk.SORT.TIME);
        walker.push(headCommit.id());

        const fetched = await walker.getCommits(skip + limit + 1);
        const pageCommits = fetched.slice(skip, skip + limit);
        const hasMore = fetched.length > skip + limit;

        const all = pageCommits.map((commit) => {
            const author = typeof commit.author === 'function' ? commit.author() : null;
            const fullMessage = typeof commit.message === 'function' ? (commit.message() || '') : '';
            const summary = typeof commit.summary === 'function'
                ? (commit.summary() || '')
                : (fullMessage.split(/\r?\n/, 1)[0] || '');
            const body = typeof commit.body === 'function'
                ? (commit.body() || '').trim()
                : fullMessage.replace(/^.*(?:\r?\n|$)/, '').trim();

            const parents = [];
            for (let i = 0; i < commit.parentcount(); i += 1) {
                parents.push(commit.parentId(i).toString());
            }

            return {
                hash: commit.sha(),
                parents: parents.join(' '),
                author_name: author?.name?.() || '',
                author_email: author?.email?.() || '',
                date: commit.date().toISOString(),
                message: summary.trim(),
                body,
            };
        });

        const [total, refs] = await Promise.all([
            this._countCommitsWithNodeGit(repo, headCommit.id()),
            this._readCommitRefsWithNodeGit(repo),
        ]);

        return {
            all,
            total,
            refs,
            page,
            limit,
            hasMore,
        };
    }

    async _readLogWithSimpleGit(slug, options = {}) {
        const userId = options.userId;
        const git = await this.getGit(slug, userId);
        const { page = 1, limit = 50 } = options;
        const skip = (page - 1) * limit;

        // Use a custom format that includes parent hashes (%P) for the
        // commit graph.  simple-git's default log() omits parents, so
        // the frontend receives no branching information and renders a
        // single vertical line.
        const SEP = '---COMMIT_SEP---';
        const FIELD = '---FIELD---';
        // Format: hash | parents | author_name | author_email | date | subject | body
        const fmt = [`--format=${SEP}%H${FIELD}%P${FIELD}%aN${FIELD}%aE${FIELD}%aI${FIELD}%s${FIELD}%b`];
        const logArgs = ['log', ...fmt, `-n`, `${limit}`];
        if (skip > 0) logArgs.push(`--skip=${skip}`);

        const rawOutput = await git.raw(logArgs);

        // Parse the raw output into commit objects
        const all = rawOutput
            .split(SEP)
            .filter(Boolean)
            .map(block => {
                const parts = block.split(FIELD);
                return {
                    hash: (parts[0] || '').trim(),
                    parents: (parts[1] || '').trim(),
                    author_name: (parts[2] || '').trim(),
                    author_email: (parts[3] || '').trim(),
                    date: (parts[4] || '').trim(),
                    message: (parts[5] || '').trim(),
                    body: (parts[6] || '').trim(),
                };
            })
            .filter(c => c.hash);

        // Get total count for pagination info
        let total;
        try {
            const countResult = await git.raw(['rev-list', '--count', 'HEAD']);
            total = parseInt(countResult.trim()) || 0;
        } catch {
            total = all.length;
        }

        // Collect branch & tag refs mapped to commit hashes
        let refs = {};
        try {
            const branchRaw = await git.raw(['for-each-ref', '--format=%(objectname:short) %(refname:short)', 'refs/heads/', 'refs/remotes/', 'refs/tags/']);
            for (const line of branchRaw.trim().split('\n').filter(Boolean)) {
                const spaceIdx = line.indexOf(' ');
                if (spaceIdx < 0) continue;
                const hash = line.substring(0, spaceIdx);
                const name = line.substring(spaceIdx + 1);
                if (!refs[hash]) refs[hash] = [];
                let type = 'branch';
                if (name.startsWith('origin/') || name.startsWith('upstream/')) type = 'remote';
                if (name.startsWith('v') && /^v?\d/.test(name)) type = 'tag';
                refs[hash].push({ name, type });
            }
            const tagRaw = await git.raw(['tag', '--format=%(objectname:short) %(refname:short)']);
            for (const line of tagRaw.trim().split('\n').filter(Boolean)) {
                const spaceIdx = line.indexOf(' ');
                if (spaceIdx < 0) continue;
                const hash = line.substring(0, spaceIdx);
                const name = line.substring(spaceIdx + 1);
                if (!refs[hash]) refs[hash] = [];
                if (!refs[hash].some(r => r.name === name)) {
                    refs[hash].push({ name, type: 'tag' });
                }
            }
        } catch { /* refs decoration is best-effort */ }

        return {
            all,
            total,
            refs,
            page,
            limit,
            hasMore: skip + all.length < total,
        };
    }

    async _readStatusBundleWithNodeGit(repoPath) {
        const repo = await NodeGit.Repository.open(repoPath);
        const refNames = await repo.getReferenceNames(NodeGit.Reference.TYPE.ALL);

        const localBranches = refNames
            .filter((name) => name.startsWith('refs/heads/'))
            .map((name) => this._normalizeBranchRefName(name))
            .sort();

        const allBranches = refNames
            .filter((name) => name.startsWith('refs/heads/') || name.startsWith('refs/remotes/'))
            .map((name) => this._normalizeBranchRefName(name))
            .filter((name) => name && !/\/HEAD$/.test(name))
            .sort();

        let current = '';
        let tracking = null;
        let ahead = 0;
        let behind = 0;

        try {
            const currentBranch = await repo.getCurrentBranch();
            current = currentBranch?.shorthand?.() || this._normalizeBranchRefName(currentBranch?.name?.());

            try {
                const upstreamBranch = await NodeGit.Branch.upstream(currentBranch);
                tracking = upstreamBranch?.shorthand?.() || this._normalizeBranchRefName(upstreamBranch?.name?.());
                const currentTarget = currentBranch?.target?.();
                const upstreamTarget = upstreamBranch?.target?.();
                if (currentTarget && upstreamTarget) {
                    const counts = await NodeGit.Graph.aheadBehind(repo, currentTarget, upstreamTarget);
                    ahead = Number(counts?.ahead) || 0;
                    behind = Number(counts?.behind) || 0;
                }
            } catch (_) {}
        } catch (error) {
            const msg = error?.message || '';
            if (!msg.includes('reference') && !msg.includes('HEAD') && !msg.includes('unborn')) {
                throw error;
            }
        }

        const status = this._emptyStatus(current || 'main');
        status.current = current || status.current;
        status.tracking = tracking;
        status.ahead = ahead;
        status.behind = behind;

        const seen = {
            not_added: new Set(),
            created: new Set(),
            deleted: new Set(),
            modified: new Set(),
            renamed: new Set(),
            staged: new Set(),
            conflicted: new Set(),
            files: new Set(),
        };

        await NodeGit.Status.foreachExt(
            repo,
            {
                show: NodeGit.Status.SHOW.INDEX_AND_WORKDIR,
                flags: NodeGit.Status.OPT.INCLUDE_UNTRACKED |
                    NodeGit.Status.OPT.RECURSE_UNTRACKED_DIRS |
                    NodeGit.Status.OPT.RENAMES_HEAD_TO_INDEX |
                    NodeGit.Status.OPT.RENAMES_INDEX_TO_WORKDIR,
            },
            (filePath, statusBits) => {
                if (!filePath) return 0;

                const entry = this._buildStatusFileEntry(filePath, statusBits);
                if (!seen.files.has(filePath)) {
                    seen.files.add(filePath);
                    status.files.push(entry);
                }

                const STATUS = NodeGit.Status.STATUS;
                if (statusBits & STATUS.CONFLICTED) {
                    this._pushUniquePath(status.conflicted, seen.conflicted, filePath);
                }
                if (statusBits & STATUS.WT_NEW) {
                    this._pushUniquePath(status.not_added, seen.not_added, filePath);
                }
                if (statusBits & STATUS.INDEX_NEW) {
                    this._pushUniquePath(status.created, seen.created, filePath);
                    this._pushUniquePath(status.staged, seen.staged, filePath);
                }
                if (statusBits & STATUS.INDEX_MODIFIED) {
                    this._pushUniquePath(status.staged, seen.staged, filePath);
                }
                if (statusBits & STATUS.INDEX_DELETED) {
                    this._pushUniquePath(status.deleted, seen.deleted, filePath);
                    this._pushUniquePath(status.staged, seen.staged, filePath);
                }
                if (statusBits & STATUS.WT_MODIFIED) {
                    this._pushUniquePath(status.modified, seen.modified, filePath);
                }
                if (statusBits & STATUS.WT_DELETED) {
                    this._pushUniquePath(status.deleted, seen.deleted, filePath);
                }
                if (statusBits & (STATUS.INDEX_RENAMED | STATUS.WT_RENAMED)) {
                    this._pushUniqueRename(status.renamed, seen.renamed, filePath);
                }

                return 0;
            }
        );

        const filteredStatus = this._filterStatus(status);
        const bundle = {
            status: filteredStatus,
            branches: {
                local: localBranches,
                current: current || filteredStatus.current || '',
                all: allBranches.length > 0 ? allBranches : localBranches,
            },
            timestamp: Date.now(),
            source: 'nodegit',
        };

        const key = this._cacheKeyForRepoPath(repoPath);
        this.statusCache.set(key, bundle);
        return bundle;
    }

    async _readStatusBundleWithSimpleGit(repoPath) {
        const git = simpleGit(repoPath);

        let status;
        try {
            status = await git.status();
        } catch (e) {
            const msg = e.message || '';
            if (msg.includes('does not have any commits yet') || msg.includes('ambiguous argument \'HEAD\'')) {
                status = this._emptyStatus();
            } else {
                throw e;
            }
        }

        let localSummary = { all: [], current: status.current || '' };
        let allSummary = { all: [] };
        try {
            localSummary = await git.branchLocal();
            allSummary = await git.branch(['-a']);
        } catch (e) {
            const msg = e.message || '';
            if (!msg.includes('does not have any commits yet') && !msg.includes('ambiguous argument \'HEAD\'')) {
                throw e;
            }
        }

        const filteredStatus = this._filterStatus(status);
        const bundle = {
            status: filteredStatus,
            branches: {
                local: localSummary.all || [],
                current: localSummary.current || filteredStatus.current || '',
                all: allSummary.all || localSummary.all || [],
            },
            timestamp: Date.now(),
            source: 'simple-git',
        };

        const key = this._cacheKeyForRepoPath(repoPath);
        this.statusCache.set(key, bundle);
        return bundle;
    }

    async _readStatusBundleByRepoPath(repoPath) {
        if (NodeGit) {
            try {
                return await this._readStatusBundleWithNodeGit(repoPath);
            } catch (error) {
                const reason = error?.message || error?.code || 'unknown error';
                console.warn(`[GitService] Native git status failed for ${repoPath}; falling back to simple-git: ${reason}`);
            }
        } else if (nodeGitLoadError) {
            const reason = nodeGitLoadError?.message || nodeGitLoadError?.code || 'not available';
            console.warn(`[GitService] Native git bindings unavailable; using simple-git fallback: ${reason}`);
            nodeGitLoadError = null;
        }

        return this._readStatusBundleWithSimpleGit(repoPath);
    }

    async _ensureStatusBundle(slug, userId, { force = false } = {}) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        const key = this._cacheKeyForRepoPath(repoPath);

        if (!force && this.statusCache.has(key)) {
            return { repoPath, bundle: this.statusCache.get(key) };
        }

        if (this.statusRefreshes.has(key)) {
            return { repoPath, bundle: await this.statusRefreshes.get(key) };
        }

        const refreshPromise = this._readStatusBundleByRepoPath(repoPath)
            .finally(() => this.statusRefreshes.delete(key));
        this.statusRefreshes.set(key, refreshPromise);

        return { repoPath, bundle: await refreshPromise };
    }

    async prewarmStatusCache(slug, userId) {
        const { bundle } = await this._ensureStatusBundle(slug, userId, { force: true });
        return bundle;
    }

    invalidateStatusCache(slug, userId, { scheduleRefresh = false } = {}) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        return this.invalidateStatusCacheByRepoPath(repoPath, { scheduleRefresh, slug, userId });
    }

    invalidateStatusCacheByRepoPath(repoPath, { scheduleRefresh = false, slug = null, userId = null } = {}) {
        const key = this._cacheKeyForRepoPath(repoPath);
        this.statusCache.delete(key);
        if (!scheduleRefresh) return null;
        const scope = slug ? { slug, userId } : this._inferScopeFromRepoPath(repoPath);
        if (!scope.slug) return null;
        return this.prewarmStatusCache(scope.slug, scope.userId).catch((e) => {
            console.warn(`[GitService] Failed to prewarm git cache for ${scope.slug}${scope.userId ? '/' + scope.userId : ''}: ${e.message}`);
            return null;
        });
    }

    async handleFilesystemEvents({ slug, rootDir, events = [] } = {}) {
        if (!rootDir || !Array.isArray(events) || events.length === 0) return null;
        const scope = this._inferScopeFromRepoPath(rootDir, slug);
        const bundle = await this.invalidateStatusCacheByRepoPath(rootDir, {
            scheduleRefresh: true,
            slug: scope.slug,
            userId: scope.userId,
        });
        if (!bundle || !scope.slug) return null;
        return { slug: scope.slug, userId: scope.userId, bundle, rootDir, events };
    }

    // Helper to run operations with lock + repo cache acquire/release
    async withLock(slug, operation, userId) {
        const lockKey = userId ? `${slug}:${userId}` : slug;
        const releaseLock = await repoLock.acquire(lockKey);
        try {
            // Ensure working tree is materialised before the operation
            await repoCache.acquire(slug, userId);
            try {
                return await operation();
            } finally {
                repoCache.release(slug, userId);
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
        if (msg.includes('requested url returned error: 403') || msg.includes('http 403')) {
            return new AuthenticationError('Access denied (HTTP 403). Verify token permissions, repository access, and SSO authorization if your org requires it.');
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

    /**
     * Extract an auth token from the push URL of the first configured remote.
     * Supports formats like:
     *   https://<token>@github.com/owner/repo.git
     *   https://x-access-token:<token>@github.com/owner/repo.git
     *   https://oauth2:<token>@github.com/owner/repo.git
     *
     * @param {object} git - simple-git instance
     * @returns {Promise<string|null>} The extracted token, or null
     */
    async _extractTokenFromRemoteUrl(git) {
        try {
            const remotes = await git.getRemotes(true);
            if (!remotes || remotes.length === 0) return null;
            const pushUrl = remotes[0]?.refs?.push || remotes[0]?.refs?.fetch;
            if (!pushUrl || !pushUrl.startsWith('https://')) return null;

            const parsed = new URL(pushUrl);
            // Password field takes priority (https://user:<token>@host)
            if (parsed.password) {
                return decodeURIComponent(parsed.password);
            }
            // Username-only token (https://<token>@host) — skip known non-token usernames
            if (parsed.username && parsed.username !== 'git' && parsed.username !== 'oauth2' && parsed.username !== 'x-access-token') {
                return decodeURIComponent(parsed.username);
            }
            return null;
        } catch (_) {
            return null;
        }
    }

    getRepoPath(slug) {
        return path.join(this.baseDir, slug);
    }

    /**
     * Get the per-user working tree path.
     * Structure: repos/<slug>/<userId>/
     *
     * Every user in a workspace gets their own isolated working tree
     * cloned from the upstream bare repo, so each has an independent
     * git index, staging area, and working files.
     *
     * @param {string} slug   — Workspace slug
     * @param {string} userId — Authenticated user identifier
     * @returns {string} Absolute path to the user's working tree
     */
    getUserRepoPath(slug, userId) {
        if (!userId) throw new GitError('userId is required for per-user repo path', 'MISSING_USER_ID');
        // Sanitise userId to prevent directory traversal attacks
        const safeId = String(userId).replace(/[^a-zA-Z0-9_@.\-]/g, '_');
        return path.join(this.baseDir, slug, safeId);
    }

    /**
     * Resolve the effective working tree path for a git operation.
     * If userId is provided, returns the per-user path; otherwise falls
     * back to the shared (slug-level) path for backward compatibility.
     *
     * @param {string} slug
     * @param {string} [userId]
     * @returns {string}
     */
    getEffectiveRepoPath(slug, userId) {
        return userId ? this.getUserRepoPath(slug, userId) : this.getRepoPath(slug);
    }

    /**
     * Archive the .git directory to GCS for fast re-hydration.
     * Called after mutating git operations (commit, pull, checkout, clone).
     * Fire-and-forget — failures are logged but never thrown.
     */
    _archiveGitAsync(slug, userId) {
        const repoPath = userId
            ? this.getUserRepoPath(slug, userId)
            : (() => {
                // For migrated repos, archive the bare repo directory.
                // For legacy repos, archive the standard working tree.
                const barePath = this.getBarePath(slug);
                return fs.existsSync(barePath) ? barePath : this.getRepoPath(slug);
            })();
        gcsSync.archiveGitToGcs(slug, repoPath, userId).catch((e) => {
            console.warn(`[GitService] .git archive failed for ${slug}${userId ? '/' + userId : ''}:`, e.message);
        });
    }

    async isRepoExists(slug, userId) {
        const fsp = require('fs').promises;
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        try { await fsp.access(repoPath); return true; } catch (_) { return false; }
    }

    async isRepoInitialized(slug, userId) {
        const fsp = require('fs').promises;
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        const gitDir = path.join(repoPath, '.git');
        try {
            const stat = await fsp.stat(gitDir);
            return stat.isDirectory() || stat.isFile();
        } catch (_) {
            return false;
        }
    }

    async getGit(slug, userId) {
        const fsp = require('fs').promises;
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        try {
            await fsp.access(repoPath);
        } catch (_) {
            throw new RepoNotFoundError(slug);
        }
        
        // Check for .git (directory for standard repos, file for worktrees)
        const gitDir = path.join(repoPath, '.git');
        let stat;
        try {
            stat = await fsp.stat(gitDir);
        } catch (_) {
            throw new RepoNotInitializedError(slug);
        }

        if (!stat.isDirectory() && !stat.isFile()) {
            throw new RepoNotInitializedError(slug);
        }

        return simpleGit(repoPath);
    }

    /**
     * Ensure internal artifacts are listed in .git/info/exclude so they
     * never appear in git status, even if a bug places them in the working tree.
     * Safe to call multiple times — only appends if the pattern is missing.
     *
     * For linked worktrees git reads info/exclude from the **commondir**
     * (the bare repo), not the worktree gitdir, so we write to both
     * locations to cover all cases.
     */
    async _ensureLocalExcludes(repoPath) {
        try {
            // Resolve the actual git directory — handles both standard (.git dir)
            // and worktree (.git file pointing to gitdir)
            let gitDirPath = path.join(repoPath, '.git');
            let commonDirPath = null;
            try {
                const stat = await fs.promises.stat(gitDirPath);
                if (stat.isFile()) {
                    // Worktree: .git file contains "gitdir: /path/to/actual/gitdir"
                    const content = (await fs.promises.readFile(gitDirPath, 'utf8')).trim();
                    const match = content.match(/^gitdir:\s*(.+)$/m);
                    if (match) {
                        gitDirPath = path.resolve(repoPath, match[1].trim());
                        // Read commondir to find the shared bare repo
                        const commondirFile = path.join(gitDirPath, 'commondir');
                        if (await fs.promises.access(commondirFile).then(() => true).catch(() => false)) {
                            const rel = (await fs.promises.readFile(commondirFile, 'utf8')).trim();
                            commonDirPath = path.resolve(gitDirPath, rel);
                        }
                    }
                }
            } catch (_) {
                // Fall through — use the default .git path
            }

            const patterns = ['.git-archive.tar.gz', '.synthi-migrated', '_upstream.git', 'sessions/'];

            // Dynamically exclude per-user repo subdirectories from the slug-
            // level repo.  Without this, git at the slug level tracks user
            // repo directories as untracked content, and cloning the slug repo
            // for a new user copies every other user's working tree.
            try {
                const repoDir = path.basename(repoPath);
                const parentDir = path.dirname(repoPath);
                // Only add user-repo exclusions for the slug-level repo
                // (not for per-user repos which live inside the slug dir)
                if (await fs.promises.access(parentDir).then(() => true).catch(() => false)) {
                    const entries = await fs.promises.readdir(repoPath, { withFileTypes: true });
                    for (const e of entries) {
                        if (!e.isDirectory()) continue;
                        if (e.name === '.git' || e.name === '_upstream.git' || e.name === 'sessions') continue;
                        // If this subdirectory has its own .git, it's a user repo
                        if (await fs.promises.access(path.join(repoPath, e.name, '.git')).then(() => true).catch(() => false)) {
                            if (!patterns.includes(e.name + '/')) {
                                patterns.push(e.name + '/');
                            }
                        }
                    }
                }
            } catch (_) { /* non-fatal */ }

            // Write exclude patterns to the gitDirPath (handles normal repos)
            await this._writeExcludePatterns(path.join(gitDirPath, 'info', 'exclude'), patterns);

            // For worktrees, also write to the commondir (bare repo) —
            // git reads info/exclude from commondir, not the worktree gitdir.
            if (commonDirPath && commonDirPath !== gitDirPath) {
                await this._writeExcludePatterns(path.join(commonDirPath, 'info', 'exclude'), patterns);
            }
        } catch (e) {
            console.warn('[GitService] Failed to update .git/info/exclude:', e.message);
        }
    }

    /**
     * Helper: append exclude patterns to a git exclude file if missing.
     */
    async _writeExcludePatterns(excludePath, patterns) {
        const infoDir = path.dirname(excludePath);
        if (!await fs.promises.access(infoDir).then(() => true).catch(() => false)) {
            await fs.promises.mkdir(infoDir, { recursive: true });
        }

        const existing = await fs.promises.readFile(excludePath, 'utf8').catch(() => '');

        const toAppend = patterns.filter(p => !existing.includes(p));
        if (toAppend.length > 0) {
            const suffix = existing.endsWith('\n') || existing === '' ? '' : '\n';
            await fs.promises.appendFile(excludePath, suffix + toAppend.join('\n') + '\n');
        }
    }

    /**
     * Resolve the remote origin URL for a workspace.
     *
     * Checks (in order):
     *   1. Any existing per-user repo's origin remote
     *   2. The workspace metadata (workspaceManager)
     *
     * @param {string} slug
     * @returns {Promise<string|null>} Remote URL or null
     */
    async _resolveRemoteUrl(slug) {
        // 1. Check existing user repos for a configured origin remote
        const userRepos = await this.listUserRepos(slug);
        for (const repo of userRepos) {
            try {
                const git = simpleGit(repo.path);
                const remotes = await git.getRemotes(true);
                const origin = remotes.find(r => r.name === 'origin');
                if (origin?.refs?.fetch) {
                    return origin.refs.fetch;
                }
            } catch (_) { /* continue checking next repo */ }
        }

        // 2. Check the bare repo
        const barePath = this.getBarePath(slug);
        if (fs.existsSync(barePath)) {
            try {
                const bareGit = simpleGit(barePath);
                const remotes = await bareGit.getRemotes(true);
                const origin = remotes.find(r => r.name === 'origin');
                if (origin?.refs?.fetch) {
                    return origin.refs.fetch;
                }
            } catch (_) { /* non-fatal */ }
        }

        // 3. Check workspaceManager in-memory metadata
        try {
            const workspaceManager = require('./workspaceManager');
            const all = workspaceManager.getAllWorkspaces();
            const ws = all.find(w => w.slug === slug);
            if (ws?.repoUrl) return ws.repoUrl;
        } catch (_) { /* non-fatal */ }

        return null;
    }

    async initRepo(slug, remoteUrl, userId) {
        const initResult = await this.withLock(slug, async () => {
            // repoCache.acquire (inside withLock) already materialised files
            // from GCS if needed, so we only need to git-init if missing.
            const repoPath = this.getRepoPath(slug);
            
            if (!fs.existsSync(repoPath)) {
                fs.mkdirSync(repoPath, { recursive: true });
            }

            // ── Lazy migration: upgrade legacy repos transparently ────────
            // Must release the lock before calling ensureMigrated (it acquires its own)
            // But we're already inside withLock, so we check directly without re-locking.
            if (await this.isLegacyRepo(slug)) {
                console.log(`[GitService] initRepo: legacy repo detected for "${slug}", migrating…`);
                try {
                    // Perform inline migration (we already hold the lock)
                    await this._createMigrationBackup(slug);
                    try {
                        await this._migrateToSessionStructure(slug);
                        const valid = await this._validateMigration(slug);
                        if (!valid) {
                            throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                        }
                        await this._cleanupMigrationBackup(slug);
                        console.log(`[GitService] initRepo: migration complete for "${slug}"`);
                    } catch (e) {
                        console.error(`[GitService] initRepo: migration failed, rolling back:`, e.message);
                        try { await this._restoreMigrationBackup(slug); } catch (_) {}
                        // Fall through to normal init logic — legacy repo is restored
                    }
                } catch (e) {
                    // If the repo directory disappeared (ENOENT), skip migration
                    // and fall through to re-init below.
                    if (e.code === 'ENOENT' || (e.details && e.details.phase === 'backup')) {
                        console.warn(`[GitService] initRepo: repo for "${slug}" was evicted during migration, skipping`);
                    } else {
                        throw e;
                    }
                }
            }

            // ── Skip slug-level git init for migrated repos ──────────
            // After migration the slug-level directory only contains
            // _upstream.git and per-user subdirectories.  There is no
            // worktree at the slug level, so creating a .git here is
            // wrong and produces phantom "1 initial commit" with no
            // origin when read-only requests fall back to it.
            if (this.isMigratedRepo(slug) || fs.existsSync(this.getBarePath(slug))) {
                // Clean up any spurious .git that a previous run created
                const spuriousGit = path.join(repoPath, '.git');
                if (fs.existsSync(spuriousGit)) {
                    try {
                        const stat = fs.statSync(spuriousGit);
                        if (stat.isDirectory()) {
                            await fs.promises.rm(spuriousGit, { recursive: true, force: true });
                            console.log(`[GitService] initRepo: removed spurious .git dir at slug level for "${slug}"`);
                        }
                    } catch (_) { /* non-fatal */ }
                }
                console.log(`[GitService] initRepo: skipping slug-level git init for migrated repo "${slug}"`);
                return { success: true, path: repoPath };
            }

            if (!fs.existsSync(path.join(repoPath, '.git'))) {
                const git = simpleGit(repoPath);
                await git.init();
                if (remoteUrl) {
                    await git.addRemote('origin', remoteUrl);
                }
                // Ensure HEAD exists so that downstream git operations
                // (status, reset, etc.) don't fail with "no commits yet".
                await git.commit('Initial commit', { '--allow-empty': null });
            }
            // Defense-in-depth: hide internal artifacts from git status
            await this._ensureLocalExcludes(repoPath);
            return { success: true, path: repoPath };
        });

        // ── Provision per-user working tree (outside slug-level lock) ────
        if (userId) {
            const userResult = await this.ensureUserRepo(slug, userId);
            console.log(`[GitService] initRepo: per-user repo for ${slug}/${userId} (created=${userResult.created})`);
        }

        return initResult;
    }

    async cloneRepo(slug, repoUrl, token, userId) {
        const cloneResult = await this.withLock(slug, async () => {
            const repoPath = this.getRepoPath(slug);
            let cleanRepoUrl = repoUrl;
            let effectiveToken = token;
            let parsedCleanUrl = null;
            let tokenFromUrl = null;
            let urlUsername = '';
            let urlHadPassword = false;

            if (typeof cleanRepoUrl === 'string' && cleanRepoUrl.startsWith('https://')) {
                try {
                    const parsedUrl = new URL(cleanRepoUrl);
                    urlUsername = decodeURIComponent(parsedUrl.username || '');
                    urlHadPassword = Boolean(parsedUrl.password);
                    if (parsedUrl.password) {
                        tokenFromUrl = decodeURIComponent(parsedUrl.password);
                    } else if (parsedUrl.username && parsedUrl.username !== 'oauth2' && parsedUrl.username !== 'x-access-token') {
                        tokenFromUrl = decodeURIComponent(parsedUrl.username);
                    }

                    // If URL contains credentials, they are considered the source of truth
                    // for this clone request (matches user-entered URL semantics).
                    if (tokenFromUrl) effectiveToken = tokenFromUrl;

                    if (parsedUrl.username || parsedUrl.password) {
                        parsedUrl.username = '';
                        parsedUrl.password = '';
                        cleanRepoUrl = parsedUrl.toString();
                        console.warn('[GitService] cloneRepo: stripped embedded credentials from repo URL');
                    }
                    parsedCleanUrl = parsedUrl;
                } catch (_) {
                    // Keep original URL if parsing fails; clone will surface a clear error.
                }
            }

            // ── Handle existing repo gracefully ───────────────────────────
            if (fs.existsSync(repoPath)) {
                const hasGit = fs.existsSync(path.join(repoPath, '.git'));

                // If it's a legacy repo, migrate it instead of throwing
                if (await this.isLegacyRepo(slug)) {
                    console.log(`[GitService] cloneRepo: legacy repo exists for "${slug}", migrating instead of failing…`);
                    try {
                        await this._createMigrationBackup(slug);
                        try {
                            await this._migrateToSessionStructure(slug);
                            const valid = await this._validateMigration(slug);
                            if (!valid) {
                                throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                            }
                            await this._cleanupMigrationBackup(slug);
                            console.log(`[GitService] cloneRepo: migration complete, returning existing repo`);
                            return { success: true, path: repoPath, migrated: true };
                        } catch (e) {
                            console.error(`[GitService] cloneRepo: migration failed, rolling back:`, e.message);
                            try { await this._restoreMigrationBackup(slug); } catch (_) {}
                            // Fall through to existing-repo error
                        }
                    } catch (e) {
                        if (e.code === 'ENOENT' || (e.details && e.details.phase === 'backup')) {
                            console.warn(`[GitService] cloneRepo: repo for "${slug}" evicted during migration, treating as empty`);
                            // Directory gone — fall through to fresh clone below
                        } else {
                            throw e;
                        }
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
                    await fs.promises.rm(repoPath, { recursive: true, force: true });
                } else {
                    // Has a .git dir but isn't legacy and isn't migrated — genuinely exists
                    throw new GitError(`Repository for slug ${slug} already exists`, 'REPO_EXISTS');
                }
            }
            
            // Set up git with credential helper for secure token usage
            const git = simpleGit();
            
            // Clone with token using environment variable to avoid exposing in URL
            if (effectiveToken && typeof cleanRepoUrl === 'string' && cleanRepoUrl.startsWith('https://')) {
                // Use GIT_ASKPASS with a temporary script or extraheader for authentication
                const cloneOptions = {
                    '--config': `http.extraheader=Authorization: Bearer ${effectiveToken}`
                };
                
                try {
                    await git.clone(cleanRepoUrl, repoPath, cloneOptions);
                } catch (e) {
                    // Fallback to URL-based auth if extraheader fails.
                    const host = (parsedCleanUrl?.hostname || new URL(cleanRepoUrl).hostname || '').toLowerCase();
                    const fallbackAttempts = [];

                    // 1) Preserve the original URL credential style first when user supplied
                    //    token as username (https://TOKEN@host/repo.git)
                    if (tokenFromUrl && !urlHadPassword && urlUsername && urlUsername !== 'oauth2' && urlUsername !== 'x-access-token') {
                        const styleUrl = new URL(cleanRepoUrl);
                        styleUrl.username = effectiveToken;
                        styleUrl.password = '';
                        fallbackAttempts.push(styleUrl.toString());
                    }

                    // 2) GitHub canonical PAT style
                    if (host === 'github.com') {
                        const ghUrl = new URL(cleanRepoUrl);
                        ghUrl.username = 'x-access-token';
                        ghUrl.password = effectiveToken;
                        fallbackAttempts.push(ghUrl.toString());
                    }

                    // 3) Generic oauth2 style fallback
                    const oauthUrl = new URL(cleanRepoUrl);
                    oauthUrl.username = 'oauth2';
                    oauthUrl.password = effectiveToken;
                    fallbackAttempts.push(oauthUrl.toString());

                    let cloneSucceeded = false;
                    let lastError = e;
                    for (const candidateUrl of fallbackAttempts) {
                        try {
                            await git.clone(candidateUrl, repoPath);
                            cloneSucceeded = true;
                            break;
                        } catch (err) {
                            lastError = err;
                        }
                    }
                    if (!cloneSucceeded) throw lastError;
                    
                    // Strip credentials from the remote URL in the cloned repo
                    // so tokens are never persisted on disk.  Auth is handled
                    // transiently via extraheader / _extractTokenFromRemoteUrl.
                    try {
                        const clonedGit = simpleGit(repoPath);
                        await clonedGit.remote(['set-url', 'origin', cleanRepoUrl]);
                    } catch (_) {}
                }
            } else {
                await git.clone(cleanRepoUrl, repoPath);
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

            // ── Convert to bare repo + remove working tree ──────────────
            // The slug-level directory should only contain _upstream.git
            // (the bare repo) and per-user subdirectories. Working tree
            // files at the slug level are unnecessary and waste space.
            const barePath = this.getBarePath(slug);
            if (!fs.existsSync(barePath)) {
                try {
                    const bareGit = simpleGit();
                    await bareGit.clone(repoPath, barePath, ['--bare', '--no-hardlinks']);
                    console.log(`[GitService] Created bare repo at ${barePath}`);
                    // Set the clean URL (no credentials) on the bare repo.
                    // Auth is handled transiently at push/pull time.
                    try {
                        const bGit = simpleGit(barePath);
                        await bGit.remote(['set-url', 'origin', cleanRepoUrl]);
                    } catch (_) {}
                } catch (e) {
                    console.warn(`[GitService] Failed to create bare repo: ${e.message}`);
                }
            }

            // Remove the slug-level working tree (keep _upstream.git and
            // any per-user directories that may already exist).
            try {
                const entries = fs.readdirSync(repoPath, { withFileTypes: true });
                for (const entry of entries) {
                    if (entry.name === '_upstream.git') continue;
                    // Don't delete per-user repo directories
                    if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'sessions' && !entry.name.startsWith('.')) {
                        const maybeGit = path.join(repoPath, entry.name, '.git');
                        if (fs.existsSync(maybeGit)) continue; // per-user repo
                    }
                    const fullPath = path.join(repoPath, entry.name);
                    await fs.promises.rm(fullPath, { recursive: true, force: true });
                }
                console.log(`[GitService] Cleaned slug-level working tree for "${slug}"`);
            } catch (e) {
                console.warn(`[GitService] Failed to clean slug-level working tree: ${e.message}`);
            }

            // Archive .git to GCS for fast re-hydration after eviction
            this._archiveGitAsync(slug);
            
            return { success: true, path: repoPath };
        });

        // ── Provision per-user working tree (outside slug-level lock) ────
        if (userId) {
            const userResult = await this.ensureUserRepo(slug, userId);
            console.log(`[GitService] cloneRepo: per-user repo for ${slug}/${userId} (created=${userResult.created})`);
        }

        return cloneResult;
    }

    async listWorkspaces() {
        if (!await fs.promises.access(this.baseDir).then(() => true).catch(() => false)) return [];
        const dirents = await fs.promises.readdir(this.baseDir, { withFileTypes: true });
        return dirents
            .filter(dirent => dirent.isDirectory())
            .map(dirent => dirent.name);
    }

    async getStatus(slug, userId) {
        if (!await this.isRepoExists(slug, userId)) return null;
        if (!await this.isRepoInitialized(slug, userId)) {
            return null;
        }
        
        try {
            const { bundle } = await this._ensureStatusBundle(slug, userId);
            return bundle ? bundle.status : null;
        } catch (e) {
            // Gracefully handle repos that have no commits yet (orphan branch).
            // This can happen if the initial commit failed or the repo was
            // re-initialised without a seed commit.
            const msg = e.message || '';
            if (msg.includes('does not have any commits yet') || msg.includes('ambiguous argument \'HEAD\'')) {
                console.warn(`[GitService] getStatus: repo ${slug}/${userId || ''} has no commits — returning empty status`);
                return this._emptyStatus();
            }
            throw this.mapGitError(e, slug);
        }
    }

    async getBranches(slug, userId) {
        if (!await this.isRepoExists(slug, userId)) return { local: [], current: '', all: [] };
        if (!await this.isRepoInitialized(slug, userId)) {
            return { local: [], current: '', all: [] };
        }
        
        try {
            const { bundle } = await this._ensureStatusBundle(slug, userId);
            return bundle ? bundle.branches : { local: [], current: '', all: [] };
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    // ── Tag management ─────────────────────────────────
    async getTags(slug, userId) {
        if (!await this.isRepoExists(slug, userId)) return [];
        if (!await this.isRepoInitialized(slug, userId)) return [];
        try {
            const git = await this.getGit(slug, userId);
            const raw = await git.raw(['tag', '-l', '--sort=-creatordate', '--format=%(refname:short)%09%(objectname:short)%09%(creatordate:iso-strict)%09%(contents:subject)']);
            return raw.trim().split('\n').filter(Boolean).map(line => {
                const [name, hash, date, message] = line.split('\t');
                return { name, hash, date, message: message || '' };
            });
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    async createTag(slug, name, ref = 'HEAD', message, userId) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
            try {
                if (message) {
                    await git.tag(['-a', name, ref, '-m', message]);
                } else {
                    await git.tag([name, ref]);
                }
                return { name, ref };
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async deleteTag(slug, name, userId) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
            try {
                await git.tag(['-d', name]);
                return { deleted: name };
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async pushTag(slug, name, userId, token) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
            try {
                const effectiveToken = token || await this._extractTokenFromRemoteUrl(git);
                if (effectiveToken) {
                    const remotes = await git.getRemotes(true);
                    const remoteUrl = remotes?.[0]?.refs?.push || remotes?.[0]?.refs?.fetch || '';
                    let authUrl = null;
                    if (remoteUrl.startsWith('https://')) {
                        try { const u = new URL(remoteUrl); u.username = 'x-access-token'; u.password = effectiveToken; authUrl = u.toString(); } catch (_) {}
                    }
                    if (authUrl) {
                        await git.raw(['push', authUrl, `refs/tags/${name}`]);
                    } else {
                        await git.raw(['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'push', 'origin', `refs/tags/${name}`]);
                    }
                } else {
                    await git.push('origin', `refs/tags/${name}`);
                }
                return { pushed: name };
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async checkout(slug, branchName, create = false, userId, mode = 'normal') {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
            try {
                // ── Ensure we have the latest remote refs ──
                // If the branch doesn't exist locally (e.g. a PR head branch
                // like "MAZNA"), we need to fetch first so git knows about
                // the remote-tracking ref. Without this, git checkout fails
                // with: error: pathspec '<branch>' did not match any file(s).
                if (!create) {
                    try {
                        const branchSummary = await git.branch();
                        const localExists = branchSummary.all.includes(branchName);
                        if (!localExists) {
                            // Fetch the specific branch from origin
                            try {
                                const token = await this._extractTokenFromRemoteUrl(git);
                                if (token) {
                                    const remotes = await git.getRemotes(true);
                                    const remoteUrl = remotes?.[0]?.refs?.fetch || remotes?.[0]?.refs?.push || '';
                                    if (remoteUrl.startsWith('https://')) {
                                        try {
                                            const u = new URL(remoteUrl);
                                            u.username = 'x-access-token';
                                            u.password = token;
                                            await git.raw(['fetch', u.toString(), branchName]);
                                        } catch (_) {
                                            await git.raw(['-c', `http.extraheader=Authorization: Bearer ${token}`, 'fetch', 'origin', branchName]);
                                        }
                                    } else {
                                        await git.raw(['-c', `http.extraheader=Authorization: Bearer ${token}`, 'fetch', 'origin', branchName]);
                                    }
                                } else {
                                    await git.fetch('origin', branchName);
                                }
                            } catch (fetchErr) {
                                console.warn(`[GitService] checkout: fetch origin ${branchName} failed: ${fetchErr.message}`);
                                // Continue — branch may exist locally under a different listing
                            }

                            // After fetch, check if it's now available as a remote-tracking branch.
                            // If so, create a local tracking branch automatically.
                            try {
                                const remoteBranch = `origin/${branchName}`;
                                await git.raw(['rev-parse', '--verify', remoteBranch]);
                                // Remote-tracking branch exists — create local branch tracking it
                                await git.raw(['checkout', '-b', branchName, '--track', remoteBranch]);
                                this._archiveGitAsync(slug, userId);
                                return this.getStatus(slug, userId);
                            } catch (_) {
                                // Remote-tracking branch doesn't exist either — fall through
                                // to the normal checkout which will produce the appropriate error
                            }
                        }
                    } catch (_) {
                        // git.branch() failed — continue with normal checkout
                    }
                }

                // mode: 'stash' — stash before checkout, pop after
                // mode: 'force' — discard local changes (git checkout -f)
                if (mode === 'stash') {
                    await git.stash(['push', '-m', `auto-stash before checkout to ${branchName}`]);
                    try {
                        if (create) await git.checkoutLocalBranch(branchName);
                        else await git.checkout(branchName);
                        // Try to pop the stash; if it conflicts leave it in the stash list
                        try { await git.stash(['pop']); } catch (_popErr) {
                            console.warn(`[Git] Stash pop after checkout to '${branchName}' conflicted — stash preserved`);
                        }
                    } catch (checkoutErr) {
                        // Restore stash if checkout itself failed
                        try { await git.stash(['pop']); } catch (_) {}
                        throw checkoutErr;
                    }
                } else if (mode === 'force') {
                    if (create) {
                        // For create + force: create the branch then force-checkout
                        await git.checkout(['-B', branchName]);
                    } else {
                        await git.checkout(['-f', branchName]);
                    }
                } else {
                    if (create) {
                        await git.checkoutLocalBranch(branchName);
                    } else {
                        await git.checkout(branchName);
                    }
                }
                this._archiveGitAsync(slug, userId);
                return this.getStatus(slug, userId);
            } catch (e) {
                const msg = (e.message || '').toLowerCase();
                if (msg.includes('would be overwritten') || msg.includes('your local changes')) {
                    const err = new Error('Your local changes would be overwritten by checkout. Commit, stash, or discard them first.');
                    err.code = 'UNCOMMITTED_CHANGES';
                    throw err;
                }
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async fetch(slug, userId, token) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                const effectiveToken = token || await this._extractTokenFromRemoteUrl(git);
                if (effectiveToken) {
                    const remotes = await git.getRemotes(true);
                    const remoteUrl = remotes?.[0]?.refs?.fetch || remotes?.[0]?.refs?.push || '';
                    let authUrl = null;
                    if (remoteUrl.startsWith('https://')) {
                        try { const u = new URL(remoteUrl); u.username = 'x-access-token'; u.password = effectiveToken; authUrl = u.toString(); } catch (_) {}
                    }
                    if (authUrl) {
                        const remoteName = remotes?.[0]?.name || 'origin';
                        // Temporarily set the remote URL, fetch, then restore
                        await git.raw(['fetch', authUrl]);
                    } else {
                        await git.raw(['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'fetch']);
                    }
                } else {
                    await git.fetch();
                }
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async commit(slug, message, userId, amend = false) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                // Check if there are staged changes before committing
                // (skip for amend — amend can just rewrite the message).
                if (!amend) {
                    const status = await git.status();
                    if (!status.staged || status.staged.length === 0) {
                        throw new GitError(
                            'Nothing to commit — stage files first.',
                            'NOTHING_STAGED'
                        );
                    }
                }
                if (amend) {
                    await git.commit(message, { '--amend': null });
                } else {
                    await git.commit(message);
                }
                this._archiveGitAsync(slug, userId);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    /**
     * Interactive rebase — apply a list of operations to a range of commits.
     *
     * @param {string} slug          - repo identifier
     * @param {string} baseCommit    - the commit onto which we rebase (exclusive,
     *                                 typically HEAD~N or a commit hash)
     * @param {Array}  operations    - ordered list of { action, hash, message? }
     *                                 action: 'pick'|'reword'|'squash'|'fixup'|'drop'
     * @param {string} userId
     */
    async interactiveRebase(slug, baseCommit, operations, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                const repoPath = this.getEffectiveRepoPath(slug, userId);

                // Build the rebase-todo script
                const todoLines = operations.map(op => {
                    const action = op.action || 'pick';
                    const hash = op.hash;
                    const msg = op.message || '';
                    return `${action} ${hash} ${msg}`;
                });

                // Write todo to a file and use GIT_SEQUENCE_EDITOR to apply it
                const todoFile = path.join(repoPath, '.git', '_rebase_todo.txt');
                await fs.promises.writeFile(todoFile, todoLines.join('\n') + '\n', 'utf8');

                // Build reword messages if any
                const rewords = operations.filter(op => op.action === 'reword' && op.message);
                const rewordMap = {};
                rewords.forEach(r => { rewordMap[r.hash.substring(0, 7)] = r.message; });

                // Determine the sequence-editor script based on OS
                const isWin = process.platform === 'win32';
                let seqEditor;
                if (isWin) {
                    // On Windows, use a simple copy command as sequence editor
                    const todoFileEscaped = todoFile.replace(/\\/g, '\\\\');
                    seqEditor = `cmd /c copy /y "${todoFileEscaped}" `;
                } else {
                    seqEditor = `cp "${todoFile}" `;
                }

                // Use env to set the sequence editor
                const env = {
                    ...process.env,
                    GIT_SEQUENCE_EDITOR: `${seqEditor}`,
                };

                // For rewords, we need a GIT_EDITOR that writes the new message
                // For simplicity, handle rewords as a second pass:
                // First do the rebase with pick/squash/fixup/drop,
                // then use git commit --amend for any rewords.

                // Actually, simpler: write a shell script as GIT_SEQUENCE_EDITOR
                // that simply copies our pre-computed todo over the rebase-todo file.
                const seqScript = path.join(repoPath, '.git', '_seq_editor');
                if (isWin) {
                    // Windows batch: copy our todo over the argument ($1 = path git passes)
                    const batContent = `@echo off\ncopy /y "${todoFile.replace(/\\/g, '\\\\')}" %1 >nul\n`;
                    const batFile = seqScript + '.bat';
                    fs.writeFileSync(batFile, batContent, 'utf8');
                    env.GIT_SEQUENCE_EDITOR = batFile;
                } else {
                    const shContent = `#!/bin/sh\ncp "${todoFile}" "$1"\n`;
                    fs.writeFileSync(seqScript, shContent, { mode: 0o755 });
                    env.GIT_SEQUENCE_EDITOR = seqScript;
                }

                // Run the interactive rebase
                await git.env(env).rebase(['-i', baseCommit]);

                // Cleanup temp files
                try { await fs.promises.unlink(todoFile); } catch (_) {}
                try { await fs.promises.unlink(isWin ? seqScript + '.bat' : seqScript); } catch (_) {}

                this._archiveGitAsync(slug, userId);
                return this.getStatus(slug, userId);
            } catch (e) {
                // If rebase fails, try to abort so we don't leave repo in bad state
                try {
                    const git2 = await this.getGit(slug, userId);
                    await git2.rebase(['--abort']);
                } catch (_) { /* already clean */ }
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async rebaseAbort(slug, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.rebase(['--abort']);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async rebaseContinue(slug, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.rebase(['--continue']);
                this._archiveGitAsync(slug, userId);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async stageFile(slug, filePath, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.add(filePath);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Stage specific lines/hunks using patch mode
    async stageLines(slug, filePath, patch, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                const repoPath = this.getEffectiveRepoPath(slug, userId);

                // Write the patch to a temp file — simple-git's raw() passes
                // all args as CLI arguments and does NOT support stdin piping,
                // so we can't pass the patch content inline.
                const tmpDir = path.join(repoPath, '.git');
                const tmpPatch = path.join(tmpDir, `_stage_${Date.now()}.patch`);
                await fs.promises.writeFile(tmpPatch, patch, 'utf8');

                try {
                    await git.raw(['apply', '--cached', '--unidiff-zero', '--recount', '--ignore-whitespace', tmpPatch]);
                } finally {
                    // Always clean up the temp patch file
                    try { await fs.promises.unlink(tmpPatch); } catch (_) {}
                }
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Discard (revert) selected lines from the working tree by reverse-applying a patch
    async discardLines(slug, filePath, patch, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                const repoPath = this.getEffectiveRepoPath(slug, userId);

                const tmpDir = path.join(repoPath, '.git');
                const tmpPatch = path.join(tmpDir, `_discard_${Date.now()}.patch`);
                await fs.promises.writeFile(tmpPatch, patch, 'utf8');

                try {
                    await git.raw(['apply', '--reverse', '--unidiff-zero', '--recount', '--ignore-whitespace', tmpPatch]);
                } finally {
                    try { await fs.promises.unlink(tmpPatch); } catch (_) {}
                }
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Unstage specific lines/hunks from the index by reverse-applying a patch
    // with --cached (index only, no working tree changes).
    // This is the inverse of stageLines — toggling a hunk back to unstaged.
    async unstageLines(slug, filePath, patch, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                const repoPath = this.getEffectiveRepoPath(slug, userId);

                const tmpDir = path.join(repoPath, '.git');
                const tmpPatch = path.join(tmpDir, `_unstage_${Date.now()}.patch`);
                await fs.promises.writeFile(tmpPatch, patch, 'utf8');

                try {
                    await git.raw(['apply', '--cached', '--reverse', '--unidiff-zero', '--recount', '--ignore-whitespace', tmpPatch]);
                } finally {
                    try { await fs.promises.unlink(tmpPatch); } catch (_) {}
                }
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async unstageFile(slug, filePath, userId) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
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
            return this.getStatus(slug, userId);
        }, userId);
    }

    // Stage all changes
    async stageAll(slug, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.add('-A');
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Unstage all staged changes
    async unstageAll(slug, userId) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
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
            return this.getStatus(slug, userId);
        }, userId);
    }

    // Discard all unstaged changes
    async discardAll(slug, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                const status = await git.status();
                
                // Checkout all modified/deleted tracked files
                if (status.modified.length > 0 || status.deleted.length > 0) {
                    await git.checkout(['--', '.']);
                }
                
                // Clean untracked files
                if (status.not_added.length > 0) {
                    await git.clean('f', ['-d']);
                }
                
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async push(slug, userId, token, force = false) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
            // Make sure we don't trigger interactive credential prompts in the server process
            const prev = process.env.GIT_TERMINAL_PROMPT;
            process.env.GIT_TERMINAL_PROMPT = '0';

            // If no explicit token provided, try to extract one from the remote URL
            let effectiveToken = token;
            if (!effectiveToken) {
                effectiveToken = await this._extractTokenFromRemoteUrl(git);
            }

            /**
             * Build an authenticated push URL by embedding the token directly
             * into the HTTPS remote URL.  GitHub (and most Git forges) reject
             * the `Authorization: Bearer` header for HTTPS pushes but accept
             * URL-embedded credentials in the form:
             *    https://x-access-token:<TOKEN>@github.com/owner/repo.git
             *
             * We resolve the remote URL, strip any existing credentials, then
             * embed the token.  The authenticated URL is used as the push
             * target via `git push <url> <branch>` (a transient URL — it is
             * never persisted to the remote config).
             */
            const _buildAuthUrl = (remoteUrl, tkn) => {
                if (!remoteUrl || !tkn || !remoteUrl.startsWith('https://')) return null;
                try {
                    const u = new URL(remoteUrl);
                    u.username = 'x-access-token';
                    u.password = tkn;
                    return u.toString();
                } catch (_) { return null; }
            };

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

                // Resolve the remote URL for logging / URL-based auth
                const updatedRemotes = await git.getRemotes(true);
                const remoteUrl = updatedRemotes?.[0]?.refs?.push || updatedRemotes?.[0]?.refs?.fetch || '';

                if (effectiveToken) {
                    const authUrl = _buildAuthUrl(remoteUrl, effectiveToken);
                    const maskedUrl = authUrl ? authUrl.replace(effectiveToken, '***') : '(no auth url)';
                    console.log(`[GitService][push] slug=${slug} force=${force} remote=${updatedRemotes?.[0]?.name} authUrl=${maskedUrl}`);

                    if (authUrl) {
                        // Push using the transient authenticated URL
                        const branchSummary = await git.branchLocal();
                        const currentBranch = branchSummary.current || 'HEAD';
                        const pushArgs = ['push'];
                        if (force) pushArgs.push('--force-with-lease');
                        pushArgs.push(authUrl, currentBranch);
                        console.log(`[GitService][push] Executing: git ${pushArgs.map(a => a === authUrl ? maskedUrl : a).join(' ')}`);
                        await git.raw(pushArgs);

                        // Set upstream tracking so git status reports ahead/behind correctly
                        const remoteName = updatedRemotes?.[0]?.name || 'origin';
                        try {
                            await git.raw(['branch', `--set-upstream-to=${remoteName}/${currentBranch}`, currentBranch]);
                        } catch (_) {}

                        // Update local remote refs so the remote branch SHA matches HEAD
                        try {
                            await git.raw(['fetch', authUrl, `${currentBranch}:refs/remotes/${remoteName}/${currentBranch}`]);
                        } catch (_) {
                            // Fallback: just update the ref directly
                            try {
                                const headHash = (await git.raw(['rev-parse', 'HEAD'])).trim();
                                await git.raw(['update-ref', `refs/remotes/${remoteName}/${currentBranch}`, headHash]);
                            } catch (__) {}
                        }
                    } else {
                        // Fallback to extraheader (non-GitHub forges)
                        console.log(`[GitService][push] Falling back to extraheader auth for ${remoteUrl}`);
                        const pushArgs = ['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'push'];
                        if (force) pushArgs.push('--force-with-lease');
                        await git.raw(pushArgs);

                        // Set upstream tracking
                        const branchSummary = await git.branchLocal();
                        const currentBranch = branchSummary.current;
                        const remoteName = updatedRemotes?.[0]?.name || 'origin';
                        if (currentBranch) {
                            try {
                                await git.raw(['branch', `--set-upstream-to=${remoteName}/${currentBranch}`, currentBranch]);
                            } catch (_) {}
                            try {
                                const headHash = (await git.raw(['rev-parse', 'HEAD'])).trim();
                                await git.raw(['update-ref', `refs/remotes/${remoteName}/${currentBranch}`, headHash]);
                            } catch (_) {}
                        }
                    }
                } else {
                    console.log(`[GitService][push] No token — pushing without auth. remote=${remoteUrl}`);
                    if (force) {
                        await git.push({ '--force-with-lease': null });
                    } else {
                        await git.push();
                    }

                    // Set upstream tracking for no-token push as well
                    const branchSummary = await git.branchLocal();
                    const currentBranch = branchSummary.current;
                    const remoteName = updatedRemotes?.[0]?.name || 'origin';
                    if (currentBranch) {
                        try {
                            await git.raw(['branch', `--set-upstream-to=${remoteName}/${currentBranch}`, currentBranch]);
                        } catch (_) {}
                    }
                }
            } catch (e) {
                const msg = (e.message || '').toLowerCase();
                console.error(`[GitService][push] Error: ${e.message}`);

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
                        const remoteUrl = remotes[0]?.refs?.push || remotes[0]?.refs?.fetch || '';
                        try {
                            if (effectiveToken) {
                                const authUrl = _buildAuthUrl(remoteUrl, effectiveToken);
                                if (authUrl) {
                                    const pushArgs = ['push', '--set-upstream'];
                                    if (force) pushArgs.push('--force-with-lease');
                                    pushArgs.push(authUrl, currentBranch);
                                    console.log(`[GitService][push] set-upstream with authUrl for branch ${currentBranch}`);
                                    await git.raw(pushArgs);

                                    // After successful push to URL, also set the named remote tracking
                                    try { await git.raw(['branch', `--set-upstream-to=${remoteToUse}/${currentBranch}`, currentBranch]); } catch (_) {}
                                } else {
                                    const pushArgs = ['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'push', '--set-upstream', remoteToUse, currentBranch];
                                    if (force) pushArgs.push('--force-with-lease');
                                    await git.raw(pushArgs);
                                }
                            } else {
                                const opts = ['--set-upstream'];
                                if (force) opts.push('--force-with-lease');
                                await git.push(remoteToUse, currentBranch, opts);
                            }
                        } catch (pushErr) {
                            console.error(`[GitService][push] set-upstream push failed: ${pushErr.message}`);
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
            return this.getStatus(slug, userId);
        }, userId);
    }

    async addRemote(slug, name, url, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.addRemote(name, url);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async removeRemote(slug, name, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.removeRemote(name);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    /**
     * Update the URL of an existing remote.
     *
     * Uses `git remote set-url <name> <url>` under the hood.
     */
    async setRemoteUrl(slug, name, url, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.remote(['set-url', name, url]);
                return await this.getRemotes(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async getRemotes(slug, userId) {
        try {
            const git = await this.getGit(slug, userId);
            return await git.getRemotes(true);
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    async pull(slug, userId, token) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);
            try {
                // If no explicit token provided, try to extract one from the remote URL
                let effectiveToken = token;
                if (!effectiveToken) {
                    effectiveToken = await this._extractTokenFromRemoteUrl(git);
                }

                let pullResult;
                if (effectiveToken) {
                    // Build authenticated URL for pull (same approach as push)
                    const remotes = await git.getRemotes(true);
                    const remoteUrl = remotes?.[0]?.refs?.fetch || remotes?.[0]?.refs?.push || '';
                    let authUrl = null;
                    if (remoteUrl.startsWith('https://')) {
                        try {
                            const u = new URL(remoteUrl);
                            u.username = 'x-access-token';
                            u.password = effectiveToken;
                            authUrl = u.toString();
                        } catch (_) {}
                    }
                    if (authUrl) {
                        const branchSummary = await git.branchLocal();
                        const currentBranch = branchSummary.current || 'HEAD';
                        console.log(`[GitService][pull] Using URL-based auth for ${slug}`);
                        await git.raw(['pull', authUrl, currentBranch]);
                    } else {
                        await git.raw(['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'pull']);
                    }
                    pullResult = { summary: { changes: 0, insertions: 0, deletions: 0 } };
                } else {
                    pullResult = await git.pull();
                }
                const status = await this.getStatus(slug, userId);
                
                // Check for merge conflicts after pull (in case pull succeeded but left conflicts)
                if (status && status.hasConflicts) {
                    throw new MergeConflictError(status.conflictedFiles);
                }
                
                this._archiveGitAsync(slug, userId);
                
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
                this._archiveGitAsync(slug, userId);
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
        }, userId);
    }

    async discardChange(slug, filePath, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                // Check if file is untracked
                const status = await git.status();
                const fileStatus = status.files.find(f => f.path === filePath);
                
                if (fileStatus && fileStatus.index === '?') {
                    // Untracked file, delete it
                    const repoPath = this.getEffectiveRepoPath(slug, userId);
                    const fullPath = path.join(repoPath, filePath);
                    if (fs.existsSync(fullPath)) {
                        await fs.promises.unlink(fullPath);
                    }
                } else {
                    await git.checkout(filePath);
                }
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // ===== Merge Conflict Resolution =====
    
    // Resolve conflict by accepting "ours" (current branch) version
    async resolveConflictOurs(slug, filePath, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.checkout(['--ours', filePath]);
                await git.add(filePath);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Resolve conflict by accepting "theirs" (incoming) version
    async resolveConflictTheirs(slug, filePath, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.checkout(['--theirs', filePath]);
                await git.add(filePath);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Mark a conflicted file as resolved (after manual edit)
    async markResolved(slug, filePath, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.add(filePath);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Cherry-pick a commit onto the current branch
    async cherryPick(slug, hash, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.raw(['cherry-pick', hash]);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Revert a commit (create an inverse commit)
    async revertCommit(slug, hash, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.raw(['revert', hash]);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    // Get detailed information about a specific commit
    async getCommitDetail(slug, hash, userId) {
        try {
            const git = await this.getGit(slug, userId);
            const showOutput = await git.show(['--format=%H%n%an%n%ae%n%aI%n%s%n%b', '--stat', hash]);
            const diff = await git.show(['--format=', '--patch', hash]);

            // Also get numeric stat for per-file insertions/deletions
            let numstat = '';
            try { numstat = await git.raw(['show', '--format=', '--numstat', hash]); } catch (_) {}

            const lines = showOutput.split('\n');
            const commitHash = lines[0] || '';
            const author_name = lines[1] || '';
            const author_email = lines[2] || '';
            const date = lines[3] || '';
            const subject = lines[4] || '';

            // Body runs from line 5 until the stat summary (blank line before stat block)
            let bodyEnd = 5;
            for (let i = lines.length - 1; i >= 5; i--) {
                if (lines[i].trim() === '') { bodyEnd = i; break; }
            }
            const body = lines.slice(5, bodyEnd).join('\n').trim();

            // Build file list from numstat (reliable, machine-readable)
            const files = [];
            for (const nl of (numstat || '').split('\n').filter(Boolean)) {
                const parts = nl.split('\t');
                if (parts.length < 3) continue;
                const [ins, del, ...rest] = parts;
                // Handle renames: numstat shows "old => new" or "{old => new}/path"
                let file = rest.join('\t');
                if (!file) continue;
                // For renames with arrow notation, extract the new name
                const renameMatch = file.match(/\{(.+?) => (.+?)\}(.*)/);
                if (renameMatch) {
                    const prefix = file.substring(0, file.indexOf('{'));
                    file = prefix + renameMatch[2] + renameMatch[3];
                } else if (file.includes(' => ')) {
                    file = file.split(' => ').pop();
                }
                files.push({
                    file: file.trim(),
                    insertions: ins === '-' ? 0 : parseInt(ins) || 0,
                    deletions: del === '-' ? 0 : parseInt(del) || 0,
                });
            }

            return { hash: commitHash, author_name, author_email, date, subject, body, files, diff };
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    // Abort current merge (discard all merge changes)
    async abortMerge(slug, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.merge(['--abort']);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    /**
     * Merge a branch into the current branch.
     * This is used by the PR conflict resolution flow — it intentionally
     * allows conflicts so the user can resolve them in the Source Control panel.
     *
     * @param {string} slug     Workspace slug
     * @param {string} branch   Branch to merge (e.g. 'main', 'origin/main')
     * @param {string} userId   User identifier
     * @param {string} [token]  Optional auth token for the fetch step
     * @returns {{ status, hasConflicts, conflictedFiles }}
     */
    async mergeBranch(slug, branch, userId, token) {
        return this.withLock(slug, async () => {
            const git = await this.getGit(slug, userId);

            // Normalise: strip leading "origin/" so we always work with the
            // bare branch name and prefix it ourselves where needed.
            const bareBranch = branch.replace(/^origin\//, '');
            const remoteBranch = `origin/${bareBranch}`;

            // 1. Fetch the specific branch from origin so the remote-tracking
            //    ref is guaranteed to exist and be up-to-date.
            try {
                const effectiveToken = token || await this._extractTokenFromRemoteUrl(git);
                if (effectiveToken) {
                    const remotes = await git.getRemotes(true);
                    const remoteUrl = remotes?.[0]?.refs?.fetch || remotes?.[0]?.refs?.push || '';
                    if (remoteUrl.startsWith('https://')) {
                        try {
                            const u = new URL(remoteUrl);
                            u.username = 'x-access-token';
                            u.password = effectiveToken;
                            await git.raw(['fetch', u.toString(), bareBranch]);
                        } catch (_) {
                            await git.raw(['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'fetch', 'origin', bareBranch]);
                        }
                    } else {
                        await git.raw(['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'fetch', 'origin', bareBranch]);
                    }
                } else {
                    await git.fetch('origin', bareBranch);
                }
            } catch (fetchErr) {
                console.warn(`[GitService] mergeBranch: fetch origin ${bareBranch} failed: ${fetchErr.message}`);
                // Continue — merge might still work with local refs
            }

            // 2. Attempt merge against the remote-tracking branch.
            let mergeResult;
            let hasConflicts = false;
            try {
                mergeResult = await git.merge([remoteBranch]);
            } catch (e) {
                const msg = (e?.message || '').toLowerCase();
                // Git merge exits non-zero on conflicts — this is expected
                if (msg.includes('conflict') || msg.includes('automatic merge failed') || msg.includes('merge_msg')) {
                    hasConflicts = true;
                } else {
                    throw this.mapGitError(e, slug);
                }
            }

            // 3. Read updated status
            const status = await this.getStatus(slug, userId);
            const conflictedFiles = (status?.conflictedFiles || []).map(f => typeof f === 'string' ? f : f.path || f);

            return {
                status,
                hasConflicts: hasConflicts || (status?.hasConflicts ?? false) || conflictedFiles.length > 0,
                conflictedFiles,
            };
        }, userId);
    }

    /**
     * Check for merge conflicts between two branches using `git merge-tree`.
     * This runs entirely in-memory (no working tree changes) and executes
     * in milliseconds — orders of magnitude faster than a physical merge.
     *
     * @param {string} slug       Workspace slug
     * @param {string} baseBranch The base branch (e.g. 'main', 'origin/main')
     * @param {string} headBranch The head/PR branch (e.g. 'feature', 'origin/feature')
     * @param {string} userId     User identifier
     * @param {string} [token]    Optional auth token for the fetch step
     * @returns {{ hasConflicts: boolean, conflictedFiles: string[] }}
     */
    async checkMergeConflicts(slug, baseBranch, headBranch, userId, token) {
        const git = await this.getGit(slug, userId);

        // Normalise branch names — ensure we reference remote-tracking branches
        const bareBase = baseBranch.replace(/^origin\//, '');
        const bareHead = headBranch.replace(/^origin\//, '');
        const remoteBase = `origin/${bareBase}`;
        const remoteHead = `origin/${bareHead}`;

        // 1. Fetch both branches so remote-tracking refs are up-to-date.
        //    Use explicit refspecs so that origin/<branch> refs are updated
        //    even when fetching by URL (which only updates FETCH_HEAD).
        const refspecs = [
            `+refs/heads/${bareBase}:refs/remotes/origin/${bareBase}`,
            `+refs/heads/${bareHead}:refs/remotes/origin/${bareHead}`,
        ];
        let fetchOk = false;
        try {
            const effectiveToken = token || await this._extractTokenFromRemoteUrl(git);
            if (effectiveToken) {
                const remotes = await git.getRemotes(true);
                const remoteUrl = remotes?.[0]?.refs?.fetch || remotes?.[0]?.refs?.push || '';
                if (remoteUrl.startsWith('https://')) {
                    try {
                        const u = new URL(remoteUrl);
                        u.username = 'x-access-token';
                        u.password = effectiveToken;
                        await git.raw(['fetch', u.toString(), ...refspecs]);
                    } catch (_) {
                        await git.raw(['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'fetch', 'origin', ...refspecs]);
                    }
                } else {
                    await git.raw(['-c', `http.extraheader=Authorization: Bearer ${effectiveToken}`, 'fetch', 'origin', ...refspecs]);
                }
            } else {
                await git.raw(['fetch', 'origin', ...refspecs]);
            }
            fetchOk = true;
        } catch (fetchErr) {
            console.warn(`[GitService] checkMergeConflicts: fetch failed — conflict result may be stale: ${fetchErr.message}`);
        }

        // 2. Find the merge base between the two branches
        let mergeBase;
        try {
            mergeBase = (await git.raw(['merge-base', remoteBase, remoteHead])).trim();
        } catch (e) {
            // No common ancestor — cannot determine mergeability
            return { hasConflicts: false, conflictedFiles: [], error: 'No common ancestor found', fetchFailed: !fetchOk };
        }

        // 3. Run git merge-tree (legacy 3-argument form).
        //    This is the most reliable cross-version approach: it operates
        //    entirely in-memory (no working tree / index changes), always
        //    exits 0, and embeds <<<<<<< conflict markers directly in its
        //    output when the merge has conflicts.
        //
        //    We intentionally do NOT use the newer --write-tree form because
        //    simple-git's .raw() drops stdout on non-zero exit, making it
        //    impossible to read the CONFLICT lines reliably.
        let mergeTreeOutput = '';
        try {
            mergeTreeOutput = await git.raw(['merge-tree', mergeBase, remoteBase, remoteHead]);
        } catch (e) {
            // Some git versions may throw on the legacy form too
            mergeTreeOutput = e?.message || e?.toString() || '';
        }

        // 4. Parse — check for conflict markers AND the "changed in both"
        //    section header that is FOLLOWED by conflict markers.
        //    The string 'changed in both' alone is NOT proof of a conflict
        //    (clean merges of the same file also produce it), so we only
        //    treat it as a conflict signal when <<<<<<< markers are present.
        const hasConflicts = mergeTreeOutput.includes('<<<<<<<');

        // 5. Extract conflicted file names
        const conflictedFiles = [];
        if (hasConflicts) {
            const filePattern = /\+\+\+ b\/(.+)/g;
            let match;
            const seen = new Set();
            while ((match = filePattern.exec(mergeTreeOutput)) !== null) {
                const file = match[1].trim();
                if (!seen.has(file)) {
                    seen.add(file);
                    conflictedFiles.push(file);
                }
            }
        }

        console.log(`[GitService] checkMergeConflicts: ${bareBase}..${bareHead} → fetchOk=${fetchOk}, mergeBase=${mergeBase?.slice(0, 8)}, hasConflicts=${hasConflicts}, files=${conflictedFiles.length}, outputLen=${mergeTreeOutput.length}`);
        return { hasConflicts, conflictedFiles, fetchFailed: !fetchOk };
    }

    // Get the content for each version of a conflicted file
    async getConflictVersions(slug, filePath, userId) {
        try {
            const git = await this.getGit(slug, userId);
            
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
                const repoPath = this.getEffectiveRepoPath(slug, userId);
                const fullPath = path.join(repoPath, filePath);
                current = await fs.promises.readFile(fullPath, 'utf8');
            } catch (e) { /* ignore */ }
            
            return { base, ours, theirs, current };
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    // Get structured diff with parsed hunks for better frontend display
    async getDiff(slug, filePath, options = {}) {
        const userId = options.userId;
        if (!await this.isRepoExists(slug, userId)) return { raw: '', hunks: [] };
        if (!await this.isRepoInitialized(slug, userId)) return { raw: '', hunks: [] };
        
        try {
            const git = await this.getGit(slug, userId);
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
        const userId = options.userId;
        if (!await this.isRepoExists(slug, userId)) return { all: [], total: 0 };
        if (!await this.isRepoInitialized(slug, userId)) return { all: [], total: 0 };
        
        try {
            if (NodeGit) {
                try {
                    const repoPath = this.getEffectiveRepoPath(slug, userId);
                    return await this._readLogWithNodeGit(repoPath, options);
                } catch (error) {
                    const reason = error?.message || error?.code || 'unknown error';
                    console.warn(`[GitService] Native git log failed for ${slug}${userId ? '/' + userId : ''}; falling back to simple-git: ${reason}`);
                }
            }

            return await this._readLogWithSimpleGit(slug, options);
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    // Git blame support
    async getBlame(slug, filePath, userId) {
        if (!await this.isRepoExists(slug, userId)) return [];
        if (!await this.isRepoInitialized(slug, userId)) return [];
        
        try {
            const git = await this.getGit(slug, userId);
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
    async stashList(slug, userId) {
        try {
            const git = await this.getGit(slug, userId);
            const result = await git.stashList();
            return result.all || [];
        } catch (e) {
            throw this.mapGitError(e, slug);
        }
    }

    async stashPush(slug, message = '', userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                const options = message ? ['-m', message] : [];
                await git.stash(['push', ...options]);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async stashPop(slug, index = 0, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.stash(['pop', `stash@{${index}}`]);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async stashDrop(slug, index = 0, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.stash(['drop', `stash@{${index}}`]);
                return this.stashList(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async stashApply(slug, index = 0, userId) {
        return this.withLock(slug, async () => {
            try {
                const git = await this.getGit(slug, userId);
                await git.stash(['apply', `stash@{${index}}`]);
                return this.getStatus(slug, userId);
            } catch (e) {
                throw this.mapGitError(e, slug);
            }
        }, userId);
    }

    async getUnpushedCommits(slug, max = 50, userId) {
        try {
            if (!await this.isRepoExists(slug, userId)) return [];
            if (!await this.isRepoInitialized(slug, userId)) return [];
            const git = await this.getGit(slug, userId);
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
                // No upstream configured — this is a brand-new local branch that has
                // never been pushed.  Show every commit on HEAD that isn't reachable
                // from any remote ref.  If there are no remotes at all return empty.
                try {
                    const remotes = await git.getRemotes(false);
                    if (!remotes || remotes.length === 0) return [];
                    const logOutput = await git.raw([
                        'log', 'HEAD',
                        '--not', '--glob=refs/remotes/*',
                        `--max-count=${Math.min(max, 200)}`,
                        '--format=%H|%s|%an|%ae|%aI',
                    ]);
                    if (!logOutput || !logOutput.trim()) return [];
                    return logOutput.trim().split('\n').filter(Boolean).map(line => {
                        const [hash, message, author_name, author_email, date] = line.split('|');
                        return { hash, message, author_name, author_email, date };
                    });
                } catch (noRemoteErr) {
                    return [];
                }
            }

            // Check if upstream ref actually exists locally (was fetched).
            // If the upstream ref is missing it could still be a freshly-created
            // remote tracking branch that hasn't been fetched yet — treat the same
            // as "no upstream": show commits not on any remote.
            let upstreamExists = true;
            try {
                await git.raw(['rev-parse', '--verify', upstream]);
            } catch (e) {
                upstreamExists = false;
            }

            if (!upstreamExists) {
                // Remote branch doesn't exist yet — new branch, never pushed.
                try {
                    const logOutput = await git.raw([
                        'log', 'HEAD',
                        '--not', '--glob=refs/remotes/*',
                        `--max-count=${Math.min(max, 200)}`,
                        '--format=%H|%s|%an|%ae|%aI',
                    ]);
                    if (!logOutput || !logOutput.trim()) return [];
                    return logOutput.trim().split('\n').filter(Boolean).map(line => {
                        const [hash, message, author_name, author_email, date] = line.split('|');
                        return { hash, message, author_name, author_email, date };
                    });
                } catch (e) {
                    return [];
                }
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
    async getIncomingCommits(slug, max = 50, userId) {
        try {
            if (!await this.isRepoExists(slug, userId)) return [];
            if (!await this.isRepoInitialized(slug, userId)) return [];
            const git = await this.getGit(slug, userId);
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

    async syncFile(slug, filePath, content, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
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
    async renameItem(slug, oldPath, newPath, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        const absOld = path.join(repoPath, oldPath);
        const absNew = path.join(repoPath, newPath);
        // Ensure the target directory exists
        await fs.promises.mkdir(path.dirname(absNew), { recursive: true });
        await fs.promises.rename(absOld, absNew);
        return { success: true };
    }

    async deleteFile(slug, filePath, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
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
    async deleteItem(slug, itemPath, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
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

    async listFiles(slug, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        if (!fs.existsSync(repoPath)) return [];
        const metas = await this.listFilesMeta(slug, userId);
        return metas.map(m => m.path);
    }

    async listFilesMeta(slug, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
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
                if (SKIP_DIRS.has(name)) continue;
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
                    // Skip expensive per-file hashing for the tree listing.
                    // Hash is only needed for VFS validation (file-hash endpoint).
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
                        content_hash: '',
                        last_author: null,
                        last_commit: null,
                    });
                }
            }
        }

        return out;
    }

    async readFile(slug, filePath, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        // Normalize backslashes → forward slashes and strip leading slash
        const safePath = (filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
        const fullPath = path.join(repoPath, safePath);
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

    async writeFile(slug, filePath, content, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
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

    async createDirectory(slug, dirPath, userId) {
        const repoPath = this.getEffectiveRepoPath(slug, userId);
        const fullPath = path.join(repoPath, dirPath);
        try {
            await fs.promises.mkdir(fullPath, { recursive: true });
        } catch (e) {
            throw new Error(`Failed to create directory: ${e.message}`);
        }
    }

    async writeFilesBatch(slug, files, options = {}) {
        const syncToGcs = options.syncToGcs !== false;
        const userId = options.userId;

        return this.withLock(slug, async () => {
            const repoPath = this.getEffectiveRepoPath(slug, userId);
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
                            await gcsSync.syncFileToGcs(slug, rel, content, userId);
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
        }, userId);
    }

    async getFileContent(slug, filePath, ref = 'HEAD', userId) {
        if (!await this.isRepoExists(slug, userId)) return '';
        if (!await this.isRepoInitialized(slug, userId)) return '';
        const git = await this.getGit(slug, userId);
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
    async isLegacyRepo(slug) {
        const repoPath = this.getRepoPath(slug);
        const gitDir = path.join(repoPath, '.git');
        const marker = path.join(repoPath, '.synthi-migrated');

        // Must exist and have a .git directory (not a file — files indicate worktrees)
        if (!await fs.promises.access(gitDir).then(() => true).catch(() => false)) return false;
        try {
            const stat = await fs.promises.stat(gitDir);
            if (!stat.isDirectory()) return false; // .git file = worktree, not legacy
        } catch (_) {
            return false;
        }

        // If already marked as migrated, it's not legacy
        if (await fs.promises.access(marker).then(() => true).catch(() => false)) return false;

        // Check it's NOT bare (bare repos have no working tree)
        try {
            const configPath = path.join(gitDir, 'config');
            if (await fs.promises.access(configPath).then(() => true).catch(() => false)) {
                const content = await fs.promises.readFile(configPath, 'utf8');
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

        // Guard: if the repo was evicted from the cache between the caller's
        // isLegacyRepo check and this point, the directory may no longer exist.
        if (!fs.existsSync(repoPath)) {
            throw new MigrationError(slug, `Repo directory missing (evicted?): ${repoPath}`, 'backup');
        }

        // Clean up any stale backup from a previous failed migration
        if (fs.existsSync(backupPath)) {
            console.warn(`[Migration] Removing stale backup: ${backupPath}`);
            await fs.promises.rm(backupPath, { recursive: true, force: true });
        }

        console.log(`[Migration] Creating backup: ${repoPath} → ${backupPath}`);
        try {
            await fs.promises.cp(repoPath, backupPath, { recursive: true });
        } catch (e) {
            if (e.code === 'ENOENT') {
                throw new MigrationError(slug, `Backup failed — source disappeared (ENOENT): ${repoPath}`, 'backup');
            }
            throw e;
        }
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
            await fs.promises.rm(repoPath, { recursive: true, force: true });
        }

        // Restore from backup
        await fs.promises.rename(backupPath, repoPath);
        console.log(`[Migration] Rollback complete for ${slug}`);
    }

    /**
     * Remove the migration backup after successful migration.
     */
    async _cleanupMigrationBackup(slug) {
        const backupPath = `${this.getRepoPath(slug)}._migration_backup`;
        if (fs.existsSync(backupPath)) {
            await fs.promises.rm(backupPath, { recursive: true, force: true });
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
            await fs.promises.rm(barePath, { recursive: true, force: true });
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
            await fs.promises.rm(legacyGitDir, { recursive: true, force: true });
            console.log(`[Migration]   Removed legacy .git directory`);

            // Manually wire the worktree links.
            // `git worktree add` cannot be used because the working directory
            // already exists (it contains user files + _upstream.git).
            // Instead we create the admin entries by hand — this is the same
            // structure that `git worktree add` would produce.
            const wtName = 'main';
            const wtAdminDir = path.join(barePath, 'worktrees', wtName);
            fs.mkdirSync(wtAdminDir, { recursive: true });

            // Get HEAD commit hash from bare repo
            const bareGit = simpleGit(barePath);
            const headHash = (await bareGit.revparse(['HEAD'])).trim();

            // Detach the bare repo's HEAD so the worktree can checkout the branch.
            // Bare repos default to `ref: refs/heads/main` which blocks worktree checkout.
            await bareGit.raw(['update-ref', '--no-deref', 'HEAD', headHash]);
            console.log(`[Migration]   Detached bare HEAD to ${headHash.slice(0, 7)}`);

            // gitdir file in the admin dir → points to the .git file in the worktree
            const dotGitInWorktree = path.join(repoPath, '.git');
            fs.writeFileSync(path.join(wtAdminDir, 'gitdir'), dotGitInWorktree + '\n');

            // HEAD in the admin dir → symbolic ref to the branch
            fs.writeFileSync(path.join(wtAdminDir, 'HEAD'), `ref: refs/heads/${currentBranch}\n`);

            // commondir → relative path back to bare repo root
            fs.writeFileSync(path.join(wtAdminDir, 'commondir'), '../..\n');

            // .git FILE in the worktree → points to the admin dir
            fs.writeFileSync(dotGitInWorktree, `gitdir: ${wtAdminDir}\n`);
            console.log(`[Migration]   Re-attached as worktree: ${repoPath}`);

            // Rebuild the index from HEAD so git recognises the working files.
            // Without this, all tracked files show as "deleted" because the
            // manually-wired worktree has no index file.
            const wtGit = simpleGit(repoPath);
            await wtGit.reset(['HEAD']);
            console.log(`[Migration]   Index rebuilt via git reset`);

            console.log(`[Migration]   Checked out branch: ${currentBranch}`);
        } catch (e) {
            throw new MigrationError(slug, `Worktree re-attach failed: ${e.message}`, 'worktree-reattach');
        }

        // ── Step 5: Write migration marker ────────────────────────────────
        this._writeMigrationMarker(slug);

        // ── Step 6: Clean up slug-level working tree files ────────────────
        // The slug-level directory should only contain _upstream.git and
        // per-user subdirectories. Working tree files at the slug level
        // are unused and waste space.  Remove them now that we have the
        // bare repo.
        try {
            const entries = fs.readdirSync(repoPath, { withFileTypes: true });
            for (const entry of entries) {
                // Keep the bare repo
                if (entry.name === '_upstream.git') continue;
                // Keep migration marker
                if (entry.name === '.synthi-migrated') continue;
                // Keep per-user repo directories (have .git inside)
                if (entry.isDirectory() && entry.name !== '.git' && entry.name !== 'sessions' && !entry.name.startsWith('.')) {
                    const maybeGit = path.join(repoPath, entry.name, '.git');
                    if (fs.existsSync(maybeGit)) continue;
                }
                const fullPath = path.join(repoPath, entry.name);
                await fs.promises.rm(fullPath, { recursive: true, force: true });
            }
            // Also remove the worktree admin entry from the bare repo
            // so git doesn't think there's a linked worktree at the slug path.
            const wtAdminMain = path.join(barePath, 'worktrees', 'main');
            if (fs.existsSync(wtAdminMain)) {
                await fs.promises.rm(wtAdminMain, { recursive: true, force: true });
            }
            console.log(`[Migration]   Cleaned slug-level working tree files`);
        } catch (e) {
            // Non-fatal — files will just take up space
            console.warn(`[Migration]   Failed to clean slug-level working tree: ${e.message}`);
        }

        console.log(`[Migration] ── Migration complete for "${slug}" ──`);

        return { barePath, worktreePath: repoPath };
    }

    /**
     * Validate that a migrated repo is functional.
     * Checks that the bare repo exists and the migration marker is present.
     * The slug-level directory is NOT a worktree — it only contains
     * _upstream.git and per-user subdirectories.
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

        // 2. Migration marker must exist
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
        if (!await this.isLegacyRepo(slug)) {
            return { migrated: false, wasLegacy: false };
        }

        // ── Legacy repo detected — migrate under lock ────────────────────
        const releaseLock = await repoLock.acquire(slug);
        try {
            // Double-check after acquiring lock (another caller may have migrated)
            if (this.isMigratedRepo(slug)) {
                return { migrated: true, wasLegacy: false };
            }
            if (!await this.isLegacyRepo(slug)) {
                return { migrated: false, wasLegacy: false };
            }

            console.log(`[Migration] Legacy repo detected for "${slug}", starting migration…`);

            // 1. Backup (guarded against ENOENT — directory may have been evicted)
            try {
                await this._createMigrationBackup(slug);
            } catch (e) {
                if (e.code === 'ENOENT' || (e.details && e.details.phase === 'backup')) {
                    console.warn(`[Migration] Repo for "${slug}" was evicted, skipping migration`);
                    return { migrated: false, wasLegacy: true, evicted: true };
                }
                throw e;
            }

            try {
                // 2. Migrate
                await this._migrateToSessionStructure(slug);

                // 3. Validate
                const valid = await this._validateMigration(slug);
                if (!valid) {
                    throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                }

                // 4. Cleanup backup on success
                await this._cleanupMigrationBackup(slug);

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
     * @deprecated Use ensureUserRepo() instead. In the direct-access model,
     *   guests share the host's per-user repo — session worktrees are no longer created.
     */
    async ensureSessionWorktree(slug, userId, branch = null) {
        return this.withLock(slug, async () => {
            // ── Lazy migration: upgrade legacy repos before creating worktrees
            if (await this.isLegacyRepo(slug)) {
                console.log(`[GitService] ensureSessionWorktree: legacy repo for "${slug}", migrating…`);
                try {
                    await this._createMigrationBackup(slug);
                    try {
                        await this._migrateToSessionStructure(slug);
                        const valid = await this._validateMigration(slug);
                        if (!valid) {
                            throw new MigrationError(slug, 'Post-migration validation failed', 'validation');
                        }
                        await this._cleanupMigrationBackup(slug);
                    } catch (e) {
                        console.error(`[GitService] ensureSessionWorktree: migration failed, rolling back:`, e.message);
                        try { await this._restoreMigrationBackup(slug); } catch (_) {}
                        throw e instanceof MigrationError ? e : new MigrationError(slug, e.message, 'worktree-migration');
                    }
                } catch (e) {
                    // If the repo directory was evicted (ENOENT) during migration,
                    // log and continue — the directory will be re-materialised below.
                    if (e.code === 'ENOENT' || (e.details && e.details.phase === 'backup')) {
                        console.warn(`[GitService] ensureSessionWorktree: repo for "${slug}" was evicted during migration, skipping migration`);
                    } else {
                        throw e;
                    }
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
                await this._ensureLocalExcludes(mainRepoPath);
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
                    await fs.promises.rm(worktreePath, { recursive: true, force: true });
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

    // ── Per-user repo isolation ─────────────────────────────────────────────

    /**
     * Ensure a per-user working tree exists for the given user.
     *
     * Clone source priority:
     *   1. Upstream bare repo (migrated structure)
     *   2. First existing user repo (avoids slug-level nesting)
     *   3. Slug-level working tree (legacy, no per-user repos yet)
     *   4. Remote origin URL from any existing repo (fetches latest remote)
     *   5. Fresh git init (absolute fallback)
     *
     * This is the PRIMARY entry-point for provisioning a user's isolated repo.
     * It is idempotent — calling it multiple times for the same (slug, userId)
     * is a fast no-op.
     *
     * @param {string} slug   — Workspace slug
     * @param {string} userId — Authenticated user id
     * @returns {Promise<{ path: string, created: boolean }>}
     */
    async ensureUserRepo(slug, userId) {
        if (!userId) throw new GitError('userId is required', 'MISSING_USER_ID');

        const userRepoPath = this.getUserRepoPath(slug, userId);

        // Fast path: already exists and is functional
        if (fs.existsSync(userRepoPath) && fs.existsSync(path.join(userRepoPath, '.git'))) {
            return { path: userRepoPath, created: false };
        }

        return this.withLock(slug, async () => {
            // Double-check after acquiring lock
            if (fs.existsSync(userRepoPath) && fs.existsSync(path.join(userRepoPath, '.git'))) {
                return { path: userRepoPath, created: false };
            }

            const barePath = this.getBarePath(slug);

            // ── Clone source resolution ──────────────────────────────────
            // Priority:
            //   1. Bare repo (_upstream.git) — canonical local source
            //   2. Remote URL — fetches latest main branch from upstream
            //   3. Existing per-user repo — peers have the same history
            //   4. Fresh init — last resort
            //
            // NOTE: The slug-level working tree (repos/<slug>/) is
            // intentionally skipped — it is not maintained and may contain
            // stale or nested content.
            let cloneSource = null;
            if (fs.existsSync(barePath)) {
                cloneSource = barePath;
            }

            // ── Try cloning from the remote URL ─────────────────────────
            // When a new user joins a workspace they've never worked in,
            // cloning from the remote ensures they always get the latest
            // main branch content.
            if (!cloneSource) {
                const remoteUrl = await this._resolveRemoteUrl(slug);
                if (remoteUrl) {
                    fs.mkdirSync(path.dirname(userRepoPath), { recursive: true });
                    try {
                        const git = simpleGit();
                        await git.clone(remoteUrl, userRepoPath, ['--no-hardlinks']);
                        await this._ensureLocalExcludes(userRepoPath);
                        console.log(`[GitService] Cloned user repo for ${slug}/${userId} from remote: ${remoteUrl}`);
                        return { path: userRepoPath, created: true };
                    } catch (e) {
                        // Remote clone failed — clean up and try other sources
                        try { await fs.promises.rm(userRepoPath, { recursive: true, force: true }); } catch (_) {}
                        console.warn(`[GitService] Remote clone failed for ${slug}/${userId}: ${e.message}, trying other sources`);
                    }
                }
            }

            // ── Fallback: clone from an existing peer user repo ─────────
            if (!cloneSource) {
                const existingUserRepos = await this.listUserRepos(slug);
                const peerRepo = existingUserRepos.find(r => r.userId !== userId);
                if (peerRepo) {
                    cloneSource = peerRepo.path;
                    console.log(`[GitService] Using peer user repo as clone source for ${slug}/${userId}`);
                }
            }

            if (!cloneSource) {
                // No upstream to clone from — init a fresh repo
                fs.mkdirSync(userRepoPath, { recursive: true });
                const git = simpleGit(userRepoPath);
                await git.init();
                // Create an initial empty commit so that HEAD exists.
                // Without this, `git status`, `git reset HEAD`, and other
                // commands that reference HEAD fail with "does not have any
                // commits yet".
                await git.commit('Initial commit', { '--allow-empty': null });
                console.log(`[GitService] Created fresh user repo for ${slug}/${userId}`);
                await this._ensureLocalExcludes(userRepoPath);
                return { path: userRepoPath, created: true };
            }

            // Clone from the upstream source
            fs.mkdirSync(path.dirname(userRepoPath), { recursive: true });
            try {
                // Guard: verify clone source still exists (may have been evicted)
                if (!fs.existsSync(cloneSource)) {
                    console.warn(`[GitService] Clone source ${cloneSource} disappeared, falling back to fresh init for ${slug}/${userId}`);
                    fs.mkdirSync(userRepoPath, { recursive: true });
                    const git = simpleGit(userRepoPath);
                    await git.init();
                    await git.commit('Initial commit', { '--allow-empty': null });
                    await this._ensureLocalExcludes(userRepoPath);
                    return { path: userRepoPath, created: true };
                }

                const git = simpleGit();
                // Use --no-hardlinks to ensure complete isolation between users
                await git.clone(cloneSource, userRepoPath, ['--no-hardlinks']);

                // If we cloned from the bare repo or a peer, re-set the remote to
                // the original upstream URL (if any) rather than the local path.
                const userGit = simpleGit(userRepoPath);
                try {
                    let resolvedUrl = null;

                    // Try getting origin from the clone source first
                    try {
                        const sourceGit = simpleGit(cloneSource);
                        const remotes = await sourceGit.getRemotes(true);
                        const origin = remotes.find(r => r.name === 'origin');
                        if (origin?.refs?.fetch) {
                            resolvedUrl = origin.refs.fetch;
                        }
                    } catch (_) { /* non-fatal */ }

                    // If the resolved URL looks like a local path rather than
                    // a real remote URL, try harder to resolve the actual remote.
                    if (!resolvedUrl || !resolvedUrl.includes('://')) {
                        const betterUrl = await this._resolveRemoteUrl(slug);
                        if (betterUrl) resolvedUrl = betterUrl;
                    }

                    if (resolvedUrl) {
                        await userGit.remote(['set-url', 'origin', resolvedUrl]);
                    }
                } catch (_) {
                    // Non-fatal — local clone is still functional
                }

                await this._ensureLocalExcludes(userRepoPath);
                console.log(`[GitService] Cloned user repo for ${slug}/${userId} from ${cloneSource}`);
                return { path: userRepoPath, created: true };
            } catch (e) {
                // Clean up failed clone
                try { await fs.promises.rm(userRepoPath, { recursive: true, force: true }); } catch (_) {}
                throw new GitError(
                    `Failed to create user repo for ${slug}/${userId}: ${e.message}`,
                    'USER_REPO_ERROR'
                );
            }
        }, userId);
    }

    /**
     * Check if a per-user repo exists and is initialized.
     */
    isUserRepoInitialized(slug, userId) {
        const userRepoPath = this.getUserRepoPath(slug, userId);
        const gitDir = path.join(userRepoPath, '.git');
        if (!fs.existsSync(gitDir)) return false;
        try {
            const stat = fs.statSync(gitDir);
            return stat.isDirectory() || stat.isFile();
        } catch (_) {
            return false;
        }
    }

    /**
     * Get a simple-git instance for a user's repo.
     */
    getUserGit(slug, userId) {
        const userRepoPath = this.getUserRepoPath(slug, userId);
        if (!fs.existsSync(userRepoPath)) {
            throw new RepoNotFoundError(`${slug}/${userId}`);
        }
        const gitDir = path.join(userRepoPath, '.git');
        if (!fs.existsSync(gitDir)) {
            throw new RepoNotInitializedError(`${slug}/${userId}`);
        }
        return simpleGit(userRepoPath);
    }

    /**
     * List all user repos for a workspace slug.
     * Returns array of { userId, path }.
     */
    async listUserRepos(slug) {
        const slugDir = path.join(this.baseDir, slug);
        if (!await fs.promises.access(slugDir).then(() => true).catch(() => false)) return [];

        try {
            const entries = await fs.promises.readdir(slugDir, { withFileTypes: true });
            const results = [];
            for (const e of entries) {
                if (!e.isDirectory()) continue;
                // Exclude internal directories
                if (e.name === '_upstream.git' || e.name === 'sessions' || e.name.startsWith('.')) continue;
                // Must have a .git to be a valid user repo
                if (await fs.promises.access(path.join(slugDir, e.name, '.git')).then(() => true).catch(() => false)) {
                    results.push({
                        userId: e.name,
                        path: path.join(slugDir, e.name),
                    });
                }
            }
            return results;
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
