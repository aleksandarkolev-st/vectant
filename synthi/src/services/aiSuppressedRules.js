// src/services/aiSuppressedRules.js
//
// Fingerprint-aware suppression store for AI healing rules.
//
// Two suppression modes:
//   'fingerprint' (default) — suppress only fixes matching a specific
//       pattern (ruleId + category + normalised original_text hash).
//   'rule' — blanket-suppress every fix emitted by a rule_id.
//
// Persistence: localStorage (keyed per env + userId) with schema
// versioning and automatic migration.  Backend sync is handled
// externally via the /heal/ai/policy/* endpoints — this module
// focuses on fast local reads/writes.

const SCHEMA_VERSION = 2;

// ── Helpers ──────────────────────────────────────────────────────────

/** DJB2a-style hash — deterministic, fast, good-enough for fingerprints. */
function djb2(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) + h + str.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/**
 * Compute a stable fingerprint for a fix.
 * Incorporates ruleId, category, and the first 200 chars of the
 * original text (trimmed) — stable across line-number changes.
 */
export function computeFingerprint(fix) {
  const ruleId = fix?.rule_id || fix?.ruleId || '';
  const category = fix?.category || '';
  const original = (fix?.original_text || fix?.originalText || '').trim().slice(0, 200);
  return djb2(`${ruleId}\0${category}\0${original}`);
}

function storageKey(env, userId) {
  const e = env || 'default';
  const u = userId || 'anonymous';
  return `synthi:ai-suppressed:${e}:${u}`;
}

// ── Main class ───────────────────────────────────────────────────────

class AISuppressedRules {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.env]    – app environment id (e.g. 'prod', 'dev')
   * @param {string} [opts.userId] – current user id for namespacing
   */
  constructor({ env, userId } = {}) {
    /** @type {Map<string, Object>} ruleId → entry */
    this._entries = new Map();
    this._env = env ?? null;
    this._userId = userId ?? null;
    this._version = SCHEMA_VERSION;
    this._updatedAt = null;
    this._load();
  }

  // ── Public: configure identity (call once at boot) ─────────────────

  /**
   * Re-key the store when env / userId becomes known.
   * Saves current state under old key, loads from new key.
   */
  configure({ env, userId }) {
    this._save();
    this._env = env ?? this._env;
    this._userId = userId ?? this._userId;
    this._load();
  }

  // ── Suppress ───────────────────────────────────────────────────────

  /**
   * Suppress a specific fix (fingerprinted) or an entire rule.
   *
   * @param {string} ruleId
   * @param {Object} [fix]     – if provided, fingerprint is computed
   * @param {Object} [opts]
   * @param {'fingerprint'|'rule'} [opts.mode='fingerprint']
   * @param {number|null}  [opts.ttl=null] – seconds, null = permanent
   * @param {string|null}  [opts.reason=null]
   */
  suppress(ruleId, fix = null, { mode = 'fingerprint', ttl = null, reason = null } = {}) {
    if (!ruleId) return;

    const now = new Date().toISOString();
    let entry = this._entries.get(ruleId);

    if (!entry) {
      entry = {
        mode,
        fingerprints: new Set(),
        createdAt: now,
        updatedAt: now,
        ttl,
        reason,
      };
      this._entries.set(ruleId, entry);
    }

    // Idempotent mode upgrade: fingerprint → rule is OK, rule → fingerprint is not
    if (mode === 'rule') {
      entry.mode = 'rule';
    }

    if (mode === 'fingerprint' && fix) {
      entry.fingerprints.add(computeFingerprint(fix));
    }

    entry.updatedAt = now;
    if (reason) entry.reason = reason;
    if (ttl !== null) entry.ttl = ttl;
    this._updatedAt = now;

    this._save();
  }

  // ── Unsuppress ─────────────────────────────────────────────────────

  /**
   * Remove suppression.  Idempotent.
   * If `fix` is given in fingerprint mode, only that fingerprint is removed.
   * If the entry has no remaining fingerprints it is deleted entirely.
   */
  unsuppress(ruleId, fix = null) {
    if (!ruleId) return;
    const entry = this._entries.get(ruleId);
    if (!entry) return;

    if (fix && entry.mode === 'fingerprint') {
      entry.fingerprints.delete(computeFingerprint(fix));
      if (entry.fingerprints.size === 0) {
        this._entries.delete(ruleId);
      } else {
        entry.updatedAt = new Date().toISOString();
      }
    } else {
      this._entries.delete(ruleId);
    }

    this._updatedAt = new Date().toISOString();
    this._save();
  }

  // ── Query ──────────────────────────────────────────────────────────

  /** Check if a specific fix is suppressed. */
  isSuppressed(fix) {
    const ruleId = fix?.rule_id || fix?.ruleId || '';
    if (!ruleId) return false;

    const entry = this._entries.get(ruleId);
    if (!entry) return false;
    if (this._isExpired(entry)) {
      this._entries.delete(ruleId);
      return false;
    }

    if (entry.mode === 'rule') return true;
    return entry.fingerprints.has(computeFingerprint(fix));
  }

  /**
   * Filter an array of fixes, removing suppressed ones.
   * @returns {{ visible: Array, suppressedCount: number }}
   */
  filterFixes(fixes) {
    if (!fixes || this._entries.size === 0) {
      return { visible: fixes || [], suppressedCount: 0 };
    }

    const visible = [];
    let suppressedCount = 0;

    for (const fix of fixes) {
      if (this.isSuppressed(fix)) {
        suppressedCount++;
      } else {
        visible.push(fix);
      }
    }

    return { visible, suppressedCount };
  }

  // ── Enumeration ────────────────────────────────────────────────────

  /** All entries as plain array for UI rendering. */
  all() {
    const result = [];
    for (const [ruleId, entry] of this._entries) {
      if (this._isExpired(entry)) {
        this._entries.delete(ruleId);
        continue;
      }
      result.push({
        ruleId,
        mode: entry.mode,
        fingerprintCount: entry.fingerprints.size,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ttl: entry.ttl,
        reason: entry.reason,
      });
    }
    return result;
  }

  get count() {
    return this._entries.size;
  }

  get updatedAt() {
    return this._updatedAt;
  }

  clear() {
    this._entries.clear();
    this._updatedAt = new Date().toISOString();
    this._save();
  }

  /** Export serialisable snapshot (for backend sync). */
  toJSON() {
    const entries = {};
    for (const [ruleId, entry] of this._entries) {
      if (this._isExpired(entry)) continue;
      entries[ruleId] = {
        mode: entry.mode,
        fingerprints: [...entry.fingerprints],
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ttl: entry.ttl,
        reason: entry.reason,
      };
    }
    return { version: this._version, updatedAt: this._updatedAt, entries };
  }

  /** Merge remote state into local (latest-writer-wins per entry). */
  mergeRemote(remote) {
    if (!remote?.entries) return;

    for (const [ruleId, re] of Object.entries(remote.entries)) {
      const local = this._entries.get(ruleId);
      if (!local || re.updatedAt > local.updatedAt) {
        this._entries.set(ruleId, {
          mode: re.mode || 'fingerprint',
          fingerprints: new Set(re.fingerprints || []),
          createdAt: re.createdAt || new Date().toISOString(),
          updatedAt: re.updatedAt || new Date().toISOString(),
          ttl: re.ttl ?? null,
          reason: re.reason ?? null,
        });
      }
    }

    if (remote.updatedAt && (!this._updatedAt || remote.updatedAt > this._updatedAt)) {
      this._updatedAt = remote.updatedAt;
    }

    this._save();
  }

  // ── Persistence (localStorage) ─────────────────────────────────────

  _save() {
    try {
      const key = storageKey(this._env, this._userId);
      localStorage.setItem(key, JSON.stringify(this.toJSON()));
    } catch {
      // localStorage may be unavailable or full
    }
  }

  _load() {
    try {
      const key = storageKey(this._env, this._userId);
      const raw = localStorage.getItem(key);
      if (!raw) return;

      const parsed = JSON.parse(raw);
      this._hydrate(parsed);
    } catch {
      // Corrupt data — start fresh, never crash
      this._entries = new Map();
    }
  }

  _hydrate(data) {
    if (!data || typeof data !== 'object') return;

    // Schema migration
    if (this._needsMigration(data)) {
      this._migrate(data);
      return;
    }

    this._version = data.version ?? SCHEMA_VERSION;
    this._updatedAt = data.updatedAt ?? null;

    if (data.entries && typeof data.entries === 'object') {
      for (const [ruleId, entry] of Object.entries(data.entries)) {
        this._entries.set(ruleId, {
          mode: entry.mode || 'fingerprint',
          fingerprints: new Set(Array.isArray(entry.fingerprints) ? entry.fingerprints : []),
          createdAt: entry.createdAt || null,
          updatedAt: entry.updatedAt || null,
          ttl: entry.ttl ?? null,
          reason: entry.reason ?? null,
        });
      }
    }
  }

  _needsMigration(data) {
    // v1 stored as bare array of ruleId strings
    if (Array.isArray(data)) return true;
    if ((data.version ?? 1) < SCHEMA_VERSION) return true;
    return false;
  }

  /** Migrate v1 (flat Set of ruleIds) → v2 (Map with fingerprints). */
  _migrate(data) {
    const now = new Date().toISOString();

    if (Array.isArray(data)) {
      // v1: bare array of ruleId strings
      for (const ruleId of data) {
        if (typeof ruleId === 'string') {
          this._entries.set(ruleId, {
            mode: 'rule',           // v1 was always blanket
            fingerprints: new Set(),
            createdAt: now,
            updatedAt: now,
            ttl: null,
            reason: 'migrated from v1',
          });
        }
      }
    }

    this._version = SCHEMA_VERSION;
    this._updatedAt = now;
    this._save();
  }

  _isExpired(entry) {
    if (!entry.ttl) return false;
    const created = new Date(entry.createdAt).getTime();
    return Date.now() - created > entry.ttl * 1000;
  }
}

/** Singleton — reconfigure via .configure() once identity is known. */
export const aiSuppressedRules = new AISuppressedRules();
