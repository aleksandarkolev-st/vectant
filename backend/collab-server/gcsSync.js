/**
 * GCS Sync Utility
 * Handles bidirectional sync between collab-server repos and Google Cloud Storage
 */
const { Storage } = require('@google-cloud/storage');
const crypto = require('crypto');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const config = require('./config');

/**
 * Compute a fast content hash (SHA-256, first 16 hex chars) for delta sync.
 * @param {Buffer} buf
 * @returns {string}
 */
function contentHash(buf) {
    return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
}

// GCS configuration — driven entirely by the centralized config module
const GCS_CONFIG = {
    projectId: config.GCS_PROJECT_ID,
    bucketName: config.GCS_BUCKET_NAME,
    credentials: config.GCS_CREDENTIALS,
};

/** Prefix inside the GCS bucket under which workspace files are stored. */
const GCS_PREFIX = config.GCS_WORKSPACE_PREFIX;

let storage = null;
let bucket = null;

/**
 * Initialize GCS client lazily
 */
function getStorage() {
    if (!storage) {
        try {
            storage = new Storage({
                projectId: GCS_CONFIG.projectId,
                credentials: GCS_CONFIG.credentials,
            });
            bucket = storage.bucket(GCS_CONFIG.bucketName);
            console.log('[GCS] Initialized GCS client for bucket:', GCS_CONFIG.bucketName);
        } catch (e) {
            console.error('[GCS] Failed to initialize GCS client:', e.message);
            throw e;
        }
    }
    return { storage, bucket };
}

/**
 * Check if GCS is properly configured
 */
function isGcsConfigured() {
    return !!(GCS_CONFIG.credentials.private_key && GCS_CONFIG.credentials.client_email);
}

/**
 * Upload a single file to GCS
 */
async function uploadFile(localPath, gcsPath, options = {}) {
    const { bucket } = getStorage();
    const file = bucket.file(gcsPath);
    
    // PERF: async read — avoids blocking the event loop during upload batches
    const content = await fsp.readFile(localPath);
    await file.save(content, {
        resumable: false,
        contentType: options.contentType || 'application/octet-stream',
        metadata: {
            cacheControl: 'no-cache',
        }
    });
    
    return { success: true, path: gcsPath };
}

/**
 * Download a single file from GCS
 */
async function downloadFile(gcsPath, localPath) {
    const { bucket } = getStorage();
    const file = bucket.file(gcsPath);
    
    const [exists] = await file.exists();
    if (!exists) {
        throw new Error(`File not found in GCS: ${gcsPath}`);
    }
    
    // PERF: async mkdir + write — avoids blocking during download batches
    const dir = path.dirname(localPath);
    await fsp.mkdir(dir, { recursive: true });
    
    const [contents] = await file.download();
    await fsp.writeFile(localPath, contents);
    
    return { success: true, path: localPath };
}

/**
 * List all files in a GCS prefix
 */
async function listFiles(prefix) {
    const { bucket } = getStorage();
    const [files] = await bucket.getFiles({ prefix, autoPaginate: true });
    return files.map(f => ({
        name: f.name,
        size: parseInt(f.metadata.size || 0),
        updated: f.metadata.updated,
    }));
}

/**
 * Upload entire repo directory to GCS
 * @param {string} repoPath - Local path to the repository
 * @param {string} slug - Workspace slug
 * @param {object} options - Options like onProgress callback
 */
async function uploadRepoToGcs(repoPath, slug, options = {}) {
    if (!isGcsConfigured()) {
        console.warn('[GCS] GCS not configured, skipping upload');
        return { success: false, reason: 'GCS not configured' };
    }

    const { onProgress, excludePatterns = ['.git'], userId } = options;
    const gcsPrefix = userId
        ? `${GCS_PREFIX}/${slug}/${userId}/`
        : `${GCS_PREFIX}/${slug}/`;
    const manifestGcsPath = gcsPrefix + '.synthi-manifest.json';
    
    // ── 1. Load the previous upload manifest from GCS (if any) ──────────
    let oldManifest = {};   // { relativePath: hash }
    try {
        const { bucket } = getStorage();
        const mf = bucket.file(manifestGcsPath);
        const [exists] = await mf.exists();
        if (exists) {
            const [buf] = await mf.download();
            oldManifest = JSON.parse(buf.toString('utf8'));
        }
    } catch (e) {
        console.warn('[GCS] Failed to load upload manifest, doing full upload:', e.message);
    }

    // ── 2. Collect local files and compute content hashes ───────────────
    const localFiles = [];   // { localPath, relativePath, isFolder, hash? }
    
    async function collectFiles(dir, baseDir) {
        const items = await fsp.readdir(dir, { withFileTypes: true });
        
        for (const item of items) {
            if (excludePatterns.some(pattern => item.name === pattern || item.name.startsWith(pattern))) {
                continue;
            }
            
            const fullPath = path.join(dir, item.name);
            const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            
            if (item.isDirectory()) {
                localFiles.push({ localPath: null, relativePath, isFolder: true });
                await collectFiles(fullPath, baseDir);
            } else {
                const buf = await fsp.readFile(fullPath);
                localFiles.push({
                    localPath: fullPath,
                    relativePath,
                    isFolder: false,
                    hash: contentHash(buf),
                });
            }
        }
    }
    
    await collectFiles(repoPath, repoPath);

    // ── 3. Diff against the old manifest ────────────────────────────────
    const newManifest = {};
    const filesToUpload = [];

    for (const item of localFiles) {
        if (item.isFolder) {
            // Always ensure folder markers exist (cheap no-op most of the time)
            filesToUpload.push({
                localPath: null,
                gcsPath: gcsPrefix + item.relativePath + '/',
                isFolder: true,
            });
        } else {
            newManifest[item.relativePath] = item.hash;
            // Only upload if hash differs or file is new
            if (oldManifest[item.relativePath] !== item.hash) {
                filesToUpload.push({
                    localPath: item.localPath,
                    gcsPath: gcsPrefix + item.relativePath,
                    isFolder: false,
                });
            }
        }
    }

    // Detect deleted files (in old manifest but not in local)
    const filesToDelete = Object.keys(oldManifest).filter(rp => !(rp in newManifest));

    const skipped = localFiles.filter(f => !f.isFolder).length - filesToUpload.filter(f => !f.isFolder).length;
    console.log(`[GCS] Delta sync: ${filesToUpload.filter(f => !f.isFolder).length} changed, ${skipped} unchanged, ${filesToDelete.length} deleted (slug: ${slug})`);

    const results = { success: 0, failed: 0, errors: [], skipped, deleted: 0 };
    const { bucket } = getStorage();
    
    // ── 4. Upload changed/new files in batches ──────────────────────────
    // PERF: batch size 30 to maximize throughput (same as download path)
    const BATCH_SIZE = 30;
    for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
        const batch = filesToUpload.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (item) => {
            try {
                if (item.isFolder) {
                    const file = bucket.file(item.gcsPath);
                    await file.save('', {
                        contentType: 'application/x-directory',
                        resumable: false,
                        metadata: {
                            cacheControl: 'no-cache',
                            metadata: { isFolder: 'true' }
                        }
                    });
                } else {
                    await uploadFile(item.localPath, item.gcsPath);
                }
                results.success++;
            } catch (e) {
                results.failed++;
                results.errors.push({ path: item.gcsPath, error: e.message });
                console.error(`[GCS] Failed to upload ${item.gcsPath}:`, e.message);
            }
        }));
        
        if (onProgress) {
            onProgress({
                uploaded: results.success,
                failed: results.failed,
                total: filesToUpload.length,
                percent: Math.round(((results.success + results.failed) / filesToUpload.length) * 100)
            });
        }
    }

    // ── 5. Delete removed files from GCS ────────────────────────────────
    if (filesToDelete.length > 0) {
        for (let i = 0; i < filesToDelete.length; i += BATCH_SIZE) {
            const batch = filesToDelete.slice(i, i + BATCH_SIZE);
            await Promise.all(batch.map(async (rp) => {
                try {
                    const file = bucket.file(gcsPrefix + rp);
                    await file.delete({ ignoreNotFound: true });
                    results.deleted++;
                } catch (e) {
                    console.warn(`[GCS] Failed to delete stale ${rp}:`, e.message);
                }
            }));
        }
    }

    // ── 6. Persist the new manifest to GCS ──────────────────────────────
    try {
        const mf = bucket.file(manifestGcsPath);
        await mf.save(JSON.stringify(newManifest), {
            resumable: false,
            contentType: 'application/json',
            metadata: { cacheControl: 'no-cache' },
        });
    } catch (e) {
        console.warn('[GCS] Failed to persist upload manifest:', e.message);
    }

    console.log(`[GCS] Upload complete: ${results.success} succeeded, ${results.failed} failed, ${skipped} skipped, ${results.deleted} deleted`);
    return results;
}

/**
 * Download workspace files from GCS to local repo path
 * @param {string} slug - Workspace slug
 * @param {string} repoPath - Local path to download to
 * @param {object} options - Options like onProgress callback
 */
async function downloadGcsToRepo(slug, repoPath, options = {}) {
    if (!isGcsConfigured()) {
        console.warn('[GCS] GCS not configured, skipping download');
        return { success: false, reason: 'GCS not configured' };
    }

    const { onProgress, userId } = options;
    const gcsPrefix = userId
        ? `${GCS_PREFIX}/${slug}/${userId}/`
        : `${GCS_PREFIX}/${slug}/`;
    
    // List all files in GCS
    const files = await listFiles(gcsPrefix);
    
    // Filter out folder markers, the prefix itself, and internal artifacts
    // that should never appear in the working tree
    const INTERNAL_ARTIFACTS = new Set(['.git-archive.tar.gz']);
    const filesToDownload = files.filter(f => {
        const relativePath = f.name.substring(gcsPrefix.length);
        if (!relativePath || relativePath.endsWith('/') || f.size === 0) return false;
        // Skip internal GCS-only blobs that are not user files
        if (INTERNAL_ARTIFACTS.has(relativePath)) return false;
        // Skip anything inside .git/ — restored separately via restoreGitFromGcs
        if (relativePath === '.git' || relativePath.startsWith('.git/')) return false;
        return true;
    });
    
    console.log(`[GCS] Downloading ${filesToDownload.length} files from GCS for slug: ${slug}`);
    
    if (filesToDownload.length === 0) {
        console.log('[GCS] No files to download');
        return { success: 0, failed: 0, total: 0 };
    }
    
    // PERF: async mkdir replaces existsSync + mkdirSync
    await fsp.mkdir(repoPath, { recursive: true });
    
    const results = { success: 0, failed: 0, errors: [] };
    const { bucket } = getStorage();
    
    // PERF: increased batch size from 10 → 30 for faster downloads
    const BATCH_SIZE = 30;
    for (let i = 0; i < filesToDownload.length; i += BATCH_SIZE) {
        const batch = filesToDownload.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (item) => {
            try {
                const relativePath = item.name.substring(gcsPrefix.length);
                const localPath = path.join(repoPath, relativePath);
                
                // PERF: async mkdir + write
                const dir = path.dirname(localPath);
                await fsp.mkdir(dir, { recursive: true });
                
                const file = bucket.file(item.name);
                const [contents] = await file.download();
                await fsp.writeFile(localPath, contents);
                
                results.success++;
            } catch (e) {
                results.failed++;
                results.errors.push({ path: item.name, error: e.message });
                console.error(`[GCS] Failed to download ${item.name}:`, e.message);
            }
        }));
        
        if (onProgress) {
            onProgress({
                downloaded: results.success,
                failed: results.failed,
                total: filesToDownload.length,
                percent: Math.round(((results.success + results.failed) / filesToDownload.length) * 100)
            });
        }
    }
    
    console.log(`[GCS] Download complete: ${results.success} succeeded, ${results.failed} failed`);
    return results;
}

/**
 * Sync a single file change to GCS (for real-time sync) with retry logic.
 * Retries up to 3 times with exponential backoff on transient failures.
 *
 * After a failure we reset the module-level Storage client so the next
 * attempt gets a fresh auth/keepalive pool. Without this, a transient
 * network hiccup during the first call leaves the cached Duplexify
 * upload pipeline in a destroyed state, and every subsequent call
 * surfaces as "Cannot call write after a stream was destroyed" — even
 * though credentials and connectivity are fine.
 */
async function syncFileToGcs(slug, relativePath, content, userId) {
    if (!isGcsConfigured()) {
        return { success: false, reason: 'GCS not configured' };
    }

    const gcsPath = userId
        ? `${GCS_PREFIX}/${slug}/${userId}/${relativePath}`
        : `${GCS_PREFIX}/${slug}/${relativePath}`;
    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { bucket } = getStorage();
            const file = bucket.file(gcsPath);
            const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content), 'utf8');

            await file.save(body, {
                resumable: false,
                contentType: 'application/octet-stream',
                metadata: { cacheControl: 'no-cache' }
            });

            return { success: true, path: gcsPath };
        } catch (e) {
            lastError = e;
            storage = null;
            bucket = null;
            if (attempt < MAX_RETRIES) {
                const delay = Math.min(500 * Math.pow(2, attempt - 1), 4000);
                console.warn(`[GCS] syncFileToGcs attempt ${attempt} failed for ${gcsPath}: ${e.message}. Retrying in ${delay}ms...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }

    console.error(`[GCS] syncFileToGcs failed after ${MAX_RETRIES} attempts for ${gcsPath}:`, lastError?.message);
    throw lastError;
}

/**
 * Delete a file from GCS
 */
async function deleteFileFromGcs(slug, relativePath, userId) {
    if (!isGcsConfigured()) {
        return { success: false, reason: 'GCS not configured' };
    }

    const gcsPath = userId
        ? `${GCS_PREFIX}/${slug}/${userId}/${relativePath}`
        : `${GCS_PREFIX}/${slug}/${relativePath}`;
    const { bucket } = getStorage();
    const file = bucket.file(gcsPath);
    
    try {
        await file.delete({ ignoreNotFound: true });
        return { success: true, path: gcsPath };
    } catch (e) {
        console.error(`[GCS] Failed to delete ${gcsPath}:`, e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Archive the .git directory as a tarball and upload to GCS.
 * Used for fast re-hydration when a working tree is materialised.
 *
 * The tarball is stored at `<GCS_PREFIX>/<slug>/.git-archive.tar.gz`.
 *
 * @param {string} slug
 * @param {string} repoPath - local working tree root
 */
async function archiveGitToGcs(slug, repoPath, userId) {
    if (!isGcsConfigured()) return { success: false, reason: 'GCS not configured' };

    const gitDir = path.join(repoPath, '.git');
    try { await fsp.access(gitDir); } catch {
        return { success: false, reason: '.git directory does not exist' };
    }

    const { createGzip } = require('zlib');
    const tar = require('tar');

    const gcsPath = userId
        ? `${GCS_PREFIX}/${slug}/${userId}/.git-archive.tar.gz`
        : `${GCS_PREFIX}/${slug}/.git-archive.tar.gz`;

    try {
        const { bucket } = getStorage();
        const file = bucket.file(gcsPath);

        // Stream tar.gz directly to GCS (no temp file)
        await new Promise((resolve, reject) => {
            const uploadStream = file.createWriteStream({
                resumable: false,
                contentType: 'application/gzip',
                metadata: { cacheControl: 'no-cache' },
            });

            tar.create(
                { gzip: true, cwd: repoPath },
                ['.git']
            )
            .pipe(uploadStream)
            .on('error', reject)
            .on('finish', resolve);
        });

        console.log(`[GCS] Archived .git for ${slug} → ${gcsPath}`);
        return { success: true, path: gcsPath };
    } catch (e) {
        console.error(`[GCS] Failed to archive .git for ${slug}:`, e.message);
        return { success: false, error: e.message };
    }
}

/**
 * Restore a .git tarball from GCS into a working tree.
 *
 * @param {string} slug
 * @param {string} repoPath - local working tree root
 * @returns {{ success: boolean }}
 */
async function restoreGitFromGcs(slug, repoPath, userId) {
    if (!isGcsConfigured()) return { success: false, reason: 'GCS not configured' };

    const tar = require('tar');

    const gcsPath = userId
        ? `${GCS_PREFIX}/${slug}/${userId}/.git-archive.tar.gz`
        : `${GCS_PREFIX}/${slug}/.git-archive.tar.gz`;

    try {
        const { bucket } = getStorage();
        const file = bucket.file(gcsPath);

        const [exists] = await file.exists();
        if (!exists) {
            return { success: false, reason: 'No .git archive found in GCS' };
        }

        // Ensure target dir exists
        await fsp.mkdir(repoPath, { recursive: true });

        // Stream download + extract
        await new Promise((resolve, reject) => {
            file.createReadStream()
                .pipe(tar.extract({ cwd: repoPath }))
                .on('error', reject)
                .on('finish', resolve);
        });

        console.log(`[GCS] Restored .git for ${slug} from ${gcsPath}`);
        return { success: true };
    } catch (e) {
        console.error(`[GCS] Failed to restore .git for ${slug}:`, e.message);
        return { success: false, error: e.message };
    }
}

module.exports = {
    isGcsConfigured,
    uploadRepoToGcs,
    downloadGcsToRepo,
    syncFileToGcs,
    deleteFileFromGcs,
    uploadFile,
    downloadFile,
    listFiles,
    archiveGitToGcs,
    restoreGitFromGcs,
};
