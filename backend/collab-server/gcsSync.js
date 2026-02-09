/**
 * GCS Sync Utility
 * Handles bidirectional sync between collab-server repos and Google Cloud Storage
 */
const { Storage } = require('@google-cloud/storage');
const fs = require('fs');
const path = require('path');
const config = require('./config');

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
    
    const content = fs.readFileSync(localPath);
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
    
    // Ensure directory exists
    const dir = path.dirname(localPath);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    
    const [contents] = await file.download();
    fs.writeFileSync(localPath, contents);
    
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

    const { onProgress, excludePatterns = ['.git'] } = options;
    const gcsPrefix = `${GCS_PREFIX}/${slug}/`;
    
    // Collect all files to upload
    const filesToUpload = [];
    
    function collectFiles(dir, baseDir) {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        
        for (const item of items) {
            // Skip excluded patterns
            if (excludePatterns.some(pattern => item.name === pattern || item.name.startsWith(pattern))) {
                continue;
            }
            
            const fullPath = path.join(dir, item.name);
            const relativePath = path.relative(baseDir, fullPath).replace(/\\/g, '/');
            
            if (item.isDirectory()) {
                // Add folder marker
                filesToUpload.push({
                    localPath: null,
                    gcsPath: gcsPrefix + relativePath + '/',
                    isFolder: true,
                });
                collectFiles(fullPath, baseDir);
            } else {
                filesToUpload.push({
                    localPath: fullPath,
                    gcsPath: gcsPrefix + relativePath,
                    isFolder: false,
                });
            }
        }
    }
    
    collectFiles(repoPath, repoPath);
    
    console.log(`[GCS] Uploading ${filesToUpload.length} items to GCS for slug: ${slug}`);
    
    const results = { success: 0, failed: 0, errors: [] };
    const { bucket } = getStorage();
    
    // Upload in batches to avoid overwhelming the API
    const BATCH_SIZE = 10;
    for (let i = 0; i < filesToUpload.length; i += BATCH_SIZE) {
        const batch = filesToUpload.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (item) => {
            try {
                if (item.isFolder) {
                    // Create folder marker
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
    
    console.log(`[GCS] Upload complete: ${results.success} succeeded, ${results.failed} failed`);
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

    const { onProgress } = options;
    const gcsPrefix = `${GCS_PREFIX}/${slug}/`;
    
    // List all files in GCS
    const files = await listFiles(gcsPrefix);
    
    // Filter out folder markers and the prefix itself
    const filesToDownload = files.filter(f => {
        const relativePath = f.name.substring(gcsPrefix.length);
        return relativePath && !relativePath.endsWith('/') && f.size > 0;
    });
    
    console.log(`[GCS] Downloading ${filesToDownload.length} files from GCS for slug: ${slug}`);
    
    if (filesToDownload.length === 0) {
        console.log('[GCS] No files to download');
        return { success: 0, failed: 0, total: 0 };
    }
    
    // Ensure repo directory exists
    if (!fs.existsSync(repoPath)) {
        fs.mkdirSync(repoPath, { recursive: true });
    }
    
    const results = { success: 0, failed: 0, errors: [] };
    const { bucket } = getStorage();
    
    // Download in batches
    const BATCH_SIZE = 10;
    for (let i = 0; i < filesToDownload.length; i += BATCH_SIZE) {
        const batch = filesToDownload.slice(i, i + BATCH_SIZE);
        
        await Promise.all(batch.map(async (item) => {
            try {
                const relativePath = item.name.substring(gcsPrefix.length);
                const localPath = path.join(repoPath, relativePath);
                
                // Ensure directory exists
                const dir = path.dirname(localPath);
                if (!fs.existsSync(dir)) {
                    fs.mkdirSync(dir, { recursive: true });
                }
                
                const file = bucket.file(item.name);
                const [contents] = await file.download();
                fs.writeFileSync(localPath, contents);
                
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
 */
async function syncFileToGcs(slug, relativePath, content) {
    if (!isGcsConfigured()) {
        return { success: false, reason: 'GCS not configured' };
    }

    const gcsPath = `${GCS_PREFIX}/${slug}/${relativePath}`;
    const MAX_RETRIES = 3;
    let lastError = null;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        try {
            const { bucket } = getStorage();
            const file = bucket.file(gcsPath);

            await file.save(content, {
                resumable: false,
                contentType: 'application/octet-stream',
                metadata: { cacheControl: 'no-cache' }
            });

            return { success: true, path: gcsPath };
        } catch (e) {
            lastError = e;
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
async function deleteFileFromGcs(slug, relativePath) {
    if (!isGcsConfigured()) {
        return { success: false, reason: 'GCS not configured' };
    }

    const gcsPath = `${GCS_PREFIX}/${slug}/${relativePath}`;
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

module.exports = {
    isGcsConfigured,
    uploadRepoToGcs,
    downloadGcsToRepo,
    syncFileToGcs,
    deleteFileFromGcs,
    uploadFile,
    downloadFile,
    listFiles,
};
