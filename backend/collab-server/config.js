/**
 * Centralized configuration for collab-server.
 *
 * Every tunable value lives here so that the rest of the codebase can
 * `require('./config')` instead of scattering `process.env` reads and
 * magic-string defaults across dozens of files.
 *
 * All values are derived from environment variables with sensible defaults
 * for local development. In production, set the env vars explicitly.
 */

const path = require('path');

// ── Paths ────────────────────────────────────────────────────────────────────
/** Root directory that holds per-workspace git repositories (one sub-dir per slug). */
const REPOS_DIR = path.resolve(process.env.REPOS_DIR || path.join(__dirname, 'repos'));

/** @deprecated LevelDB removed — CRDT persistence is handled by Y-Sweet. */
const LEVELDB_DIR = process.env.LEVELDB_DIR || path.join(__dirname, 'data', 'collab-leveldb');

// ── Y-Sweet (CRDT relay + persistence) ───────────────────────────────────────
/** Connection URL for the Y-Sweet server (e.g. http://y-sweet:8080). */
const YSWEET_URL = (process.env.YSWEET_URL || 'http://localhost:8080').replace(/\/$/, '');

/** Optional auth key shared with the Y-Sweet server for token signing. */
const YSWEET_AUTH_KEY = process.env.YSWEET_AUTH_KEY || '';

// ── Networking ───────────────────────────────────────────────────────────────
const PORT = Number(process.env.COLLAB_PORT) || 1234;

/** Base URL of the code-intelligence / AI-engine backend. */
const CODE_INTEL_URL = (process.env.CODE_INTEL_URL || 'http://localhost:8000').replace(/\/$/, '');

/** Allowed CORS origin for the HTTP API. */
const CORS_ORIGIN = process.env.CORS_ORIGIN || 'http://localhost:3000';

// ── GCS (Google Cloud Storage) ───────────────────────────────────────────────
const GCS_PROJECT_ID   = process.env.GCP_PROJECT_ID   || 'overview-synti';
const GCS_BUCKET_NAME  = process.env.GCS_BUCKET_NAME  || 'synthi-cloud-storage';
const GCS_CLIENT_EMAIL = process.env.GCP_CLIENT_EMAIL || '';
const GCS_PRIVATE_KEY  = (process.env.GCP_PRIVATE_KEY || '').replace(/\\n/g, '\n');
const GCS_CREDENTIALS  = process.env.GCP_CREDENTIALS
    ? JSON.parse(process.env.GCP_CREDENTIALS)
    : { client_email: GCS_CLIENT_EMAIL, private_key: GCS_PRIVATE_KEY };

// Validate PEM at startup. A silent-but-corrupt key surfaces as
// "Cannot call write after a stream was destroyed" from @google-cloud/storage
// mid-upload (JWT signing fails → auth lib destroys the request stream).
// Parsing here turns that into a loud, actionable boot error.
if (GCS_CREDENTIALS.private_key) {
    try {
        require('crypto').createPrivateKey(GCS_CREDENTIALS.private_key);
    } catch (e) {
        console.error(
            '[config] GCP_PRIVATE_KEY is malformed (%s). Check .env — a corrupt key ' +
            'makes every GCS upload fail with "stream destroyed" / "DECODER routines::unsupported".',
            e.message,
        );
    }
}

/** Prefix inside the GCS bucket under which workspace files are stored. */
const GCS_WORKSPACE_PREFIX = process.env.GCS_WORKSPACE_PREFIX || 'workspaces';

// ── Feature flags ────────────────────────────────────────────────────────────
/** Whether the Yjs auto-flush should also sync files to GCS. */
const GCS_SYNC_ON_FLUSH = String(process.env.GCS_SYNC_ON_FLUSH || 'true').toLowerCase() !== 'false';

/** Whether the Yjs auto-flush should trigger incremental code-intel indexing. */
const CODE_INTEL_AUTO_INDEX = String(process.env.CODE_INTEL_AUTO_INDEX || 'true').toLowerCase() !== 'false';

// ── Yjs auto-flush ──────────────────────────────────────────────────────────
/** Debounce interval (ms) before Yjs changes are flushed to disk. */
const FLUSH_DEBOUNCE_MS = Number(process.env.FLUSH_DEBOUNCE_MS) || 150;

// ── TURN credentials (Cloudflare Calls) ──────────────────────────────────────
/** Cloudflare TURN token ID (from the Calls dashboard). */
const CLOUDFLARE_TURN_TOKEN_ID = process.env.CLOUDFLARE_TURN_TOKEN_ID || '';

/** Cloudflare TURN API secret token. */
const CLOUDFLARE_TURN_API_TOKEN = process.env.CLOUDFLARE_TURN_API_TOKEN || '';

/** Credential lifetime in seconds. Default: 86400 (24 h). */
const TURN_CREDENTIAL_TTL = Number(process.env.TURN_CREDENTIAL_TTL) || 86400;

// ── Ephemeral repo cache ─────────────────────────────────────────────────────
/**
 * Directory used for ephemeral working trees.  Treat as a disposable cache:
 * GCS is the durable store; this folder can be wiped at any time.
 */
const REPO_CACHE_DIR = path.resolve(
  process.env.REPO_CACHE_DIR || path.join(__dirname, 'repos')
);

/** Maximum number of working trees kept in the LRU cache. */
const REPO_CACHE_MAX = Number(process.env.REPO_CACHE_MAX) || 50;

/**
 * Time-to-live for an idle working tree (ms).
 * After this period with no acquire(), the tree is eligible for eviction.
 */
const REPO_CACHE_TTL_MS = Number(process.env.REPO_CACHE_TTL_MS) || 5 * 60 * 1000; // 5 min

// ── Workspace preparation ──────────────────────────────────────────────────
const WORKSPACE_PREP_STATE_DIR = path.resolve(
    process.env.WORKSPACE_PREP_STATE_DIR || path.join(path.dirname(REPO_CACHE_DIR), '.synthi-workspace-prep')
);

const WORKSPACE_PREP_MAX_PARALLEL = Number(process.env.WORKSPACE_PREP_MAX_PARALLEL) || 1;
const WORKSPACE_PREP_JOB_TIMEOUT_MS = Number(process.env.WORKSPACE_PREP_JOB_TIMEOUT_MS) || 30 * 60 * 1000;
const WORKSPACE_PREP_LOCAL_VOLUME = process.env.WORKSPACE_PREP_LOCAL_VOLUME || 'synthi-ide_collab-data';
const WORKSPACE_PREP_MOUNT_PATH = process.env.WORKSPACE_PREP_MOUNT_PATH || '/data';
const WORKSPACE_PREP_PVC_NAME = process.env.WORKSPACE_PREP_PVC_NAME || 'collab-data-pvc';

module.exports = {
    REPOS_DIR,
    LEVELDB_DIR,
    YSWEET_URL,
    YSWEET_AUTH_KEY,
    PORT,
    CODE_INTEL_URL,
    CORS_ORIGIN,
    GCS_PROJECT_ID,
    GCS_BUCKET_NAME,
    GCS_CLIENT_EMAIL,
    GCS_PRIVATE_KEY,
    GCS_CREDENTIALS,
    GCS_WORKSPACE_PREFIX,
    GCS_SYNC_ON_FLUSH,
    CODE_INTEL_AUTO_INDEX,
    FLUSH_DEBOUNCE_MS,
    CLOUDFLARE_TURN_TOKEN_ID,
    CLOUDFLARE_TURN_API_TOKEN,
    TURN_CREDENTIAL_TTL,
    REPO_CACHE_DIR,
    REPO_CACHE_MAX,
    REPO_CACHE_TTL_MS,
    WORKSPACE_PREP_STATE_DIR,
    WORKSPACE_PREP_MAX_PARALLEL,
    WORKSPACE_PREP_JOB_TIMEOUT_MS,
    WORKSPACE_PREP_LOCAL_VOLUME,
    WORKSPACE_PREP_MOUNT_PATH,
    WORKSPACE_PREP_PVC_NAME,
};
