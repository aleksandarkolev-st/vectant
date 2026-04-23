const DEFAULT_LIMIT_MB = 32;
const DEFAULT_MAX_FILE_MB = 4;

// Per-file local snapshot history (most-recent-first).  Bounded so huge
// files and long sessions don't blow up memory.  This is an in-memory
// "oh no, I just saved garbage" safety net — it predates git commit
// history and works even for never-committed files.
const DEFAULT_SNAPSHOT_LIMIT = 10;
const DEFAULT_SNAPSHOT_MAX_FILE_BYTES = 1 * 1024 * 1024; // 1 MB

function estimateBytes(str) {
  if (typeof str !== 'string') return 0;
  // JS strings are roughly 2 bytes/char (UTF-16)
  return str.length * 2;
}

export class FileCache {
  constructor(options = {}) {
    const mb = Number(options.maxMB || process.env.NEXT_PUBLIC_FILE_CACHE_MB || DEFAULT_LIMIT_MB);
    this.maxBytes = Number.isFinite(mb) ? Math.max(4, mb) * 1024 * 1024 : DEFAULT_LIMIT_MB * 1024 * 1024;

    const perFileMb = Number(options.maxFileMB || process.env.NEXT_PUBLIC_FILE_CACHE_MAX_FILE_MB || DEFAULT_MAX_FILE_MB);
    this.maxFileBytes = Number.isFinite(perFileMb) ? Math.max(1, perFileMb) * 1024 * 1024 : DEFAULT_MAX_FILE_MB * 1024 * 1024;

    this._map = new Map(); // path -> entry
    this._bytes = 0;
    this._activePath = null;

    // path -> [{ content, savedAt }]  (most-recent first)
    this._snapshots = new Map();
    this._snapshotLimit = options.snapshotLimit || DEFAULT_SNAPSHOT_LIMIT;
    this._snapshotMaxFileBytes = options.snapshotMaxFileBytes || DEFAULT_SNAPSHOT_MAX_FILE_BYTES;
  }

  /**
   * Record a save-time snapshot of a file's content so the user can
   * recover from accidentally-saved garbage before it makes it to a git
   * commit.  Drops snapshots for very large files to keep memory bounded.
   */
  pushSnapshot(path, content) {
    if (!path || typeof content !== 'string') return;
    if (estimateBytes(content) > this._snapshotMaxFileBytes) return;
    let history = this._snapshots.get(path);
    if (!history) {
      history = [];
      this._snapshots.set(path, history);
    }
    // De-dup: if the newest snapshot is identical, don't add another
    if (history.length > 0 && history[0].content === content) return;
    history.unshift({ content, savedAt: Date.now() });
    if (history.length > this._snapshotLimit) history.length = this._snapshotLimit;
  }

  /** Return an immutable copy of snapshots (newest first). */
  getSnapshots(path) {
    const history = this._snapshots.get(path);
    return history ? history.slice() : [];
  }

  /** Clear all snapshots for a path — e.g. after user commits. */
  clearSnapshots(path) {
    this._snapshots.delete(path);
  }

  stats() {
    return { entries: this._map.size, bytes: this._bytes, maxBytes: this.maxBytes, activePath: this._activePath };
  }

  setActive(path) {
    this._activePath = path || null;
    if (path) this.touch(path);
  }

  has(path) {
    return this._map.has(path);
  }

  getEntry(path) {
    const entry = this._map.get(path);
    if (!entry) return undefined;
    this.touch(path);
    return entry;
  }

  get(path) {
    const entry = this.getEntry(path);
    return entry ? entry.content : undefined;
  }

  touch(path) {
    const entry = this._map.get(path);
    if (!entry) return;
    entry.lastAccessed = Date.now();
    // LRU via insertion order
    this._map.delete(path);
    this._map.set(path, entry);
  }

  set(path, content, options = {}) {
    if (!path) return;

    const ast = options.ast;
    const now = Date.now();
    const newBytes = estimateBytes(content);

    const existing = this._map.get(path);
    if (existing) {
      this._bytes -= existing.sizeBytes || 0;
      this._map.delete(path);
    }

    if (newBytes > this.maxFileBytes) {
      // Do not cache oversized files
      if (existing) {
        this._bytes -= existing.sizeBytes || 0;
        this._map.delete(path);
      }
      return;
    }

    const entry = {
      path,
      content: typeof content === 'string' ? content : String(content ?? ''),
      ast: ast ?? existing?.ast,
      lastAccessed: now,
      sizeBytes: newBytes,
    };

    this._map.set(path, entry);
    this._bytes += newBytes;

    this._evictIfNeeded();
  }

  delete(path) {
    const entry = this._map.get(path);
    if (!entry) return;
    this._map.delete(path);
    this._bytes -= entry.sizeBytes || 0;
    if (this._activePath === path) this._activePath = null;
    // Keep snapshots: the user may still want to recover content after a
    // cache eviction.  They're bounded separately.
  }

  clear() {
    this._map.clear();
    this._bytes = 0;
    this._activePath = null;
    this._snapshots.clear();
  }

  _evictIfNeeded() {
    if (this._bytes <= this.maxBytes) return;

    // Evict least-recently-used, never evict active.
    for (const [key, entry] of this._map) {
      if (this._bytes <= this.maxBytes) break;
      if (this._activePath && key === this._activePath) continue;
      this._map.delete(key);
      this._bytes -= entry.sizeBytes || 0;
    }
  }
}

export const fileCache = new FileCache();
