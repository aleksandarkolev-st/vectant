// src/services/aiSuppressedRules.js
//
// Fingerprint-aware suppression store for AI healing rules.
//
// Two suppression modes:
//   'fingerprint' (default) — suppress only fixes matching a specific
//       pattern (ruleId + category + normalised original_text hash).
//   'rule' — blanket-suppress every fix emitted by a rule_id.
//
// Persistence: localStorage (keyed per env + workspaceId + userId)
// with schema versioning and automatic migration.
//
// Backend is authoritative for TTL expiry and escalation.
// This module is a local cache — mergeRemote() does a full
// replace from backend state.  No independent TTL computation.
//
// API note: filterFixes(fixes) returns { visible, suppressedCount },
// NOT a bare array.

const SCHEMA_VERSION = 2;
const MAX_PENDING_OPS = 100;

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

function storageKey(env, workspaceId, userId) {
  const e = env || 'default';
  const w = workspaceId || 'default';
  const u = userId || 'anonymous';
  return `synthi:ai-suppressed:${e}:${w}:${u}`;
}

// ── Main class ───────────────────────────────────────────────────────

class AISuppressedRules {
  /**
   * @param {Object} [opts]
   * @param {string} [opts.env]    – app environment id (e.g. 'prod', 'dev')
   * @param {string} [opts.userId] – current user id for namespacing
   */
  constructor({ env, workspaceId, userId } = {}) {
    /** @type {Map<string, Object>} ruleId → entry */
    this._entries = new Map();
    this._env = env ?? null;
    this._workspaceId = workspaceId ?? null;
    this._userId = userId ?? null;
    this._version = SCHEMA_VERSION;
    this._updatedAt = null;
    /** @type {Array<{op: string, ruleId: string, fix?: Object, opts?: Object, ts: string, acked: boolean}>} */
    this._pendingOps = [];
    this._load();
  }

  // ── Public: configure identity (call once at boot) ─────────────────

  /**
   * Current env/workspaceId scope (for including in backend payloads).
   * @returns {{ env: string|null, workspaceId: string|null }}
   */
  get scope() {
    return { env: this._env, workspaceId: this._workspaceId };
  }

  /**
   * Re-key the store when env / userId becomes known.
   * Saves current state under old key, loads from new key.
   */
  configure({ env, workspaceId, userId }) {
    this._save();
    this._env = env ?? this._env;
    this._workspaceId = workspaceId ?? this._workspaceId;
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
        escalated: false,
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

    this._queueOp({ op: 'suppress', ruleId, mode, reason, ttl });
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
    this._queueOp({ op: 'unsuppress', ruleId });
    this._save();
  }

  // ── Query ──────────────────────────────────────────────────────────

  /** Check if a specific fix is suppressed. */
  isSuppressed(fix) {
    const ruleId = fix?.rule_id || fix?.ruleId || '';
    if (!ruleId) return false;

    const entry = this._entries.get(ruleId);
    if (!entry) return false;
    // No local TTL check — backend is authoritative for expiry.

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
      result.push({
        ruleId,
        mode: entry.mode,
        fingerprintCount: entry.fingerprints.size,
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ttl: entry.ttl,
        reason: entry.reason,
        escalated: entry.escalated ?? false,
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
      entries[ruleId] = {
        mode: entry.mode,
        fingerprints: [...entry.fingerprints],
        createdAt: entry.createdAt,
        updatedAt: entry.updatedAt,
        ttl: entry.ttl,
        reason: entry.reason,
        escalated: entry.escalated ?? false,
      };
    }
    return { version: this._version, updatedAt: this._updatedAt, entries };
  }

  /**
   * Full-replace local cache with remote state, then replay un-acked
   * pending ops so offline/inflight mutations are preserved.
   *
   * Remote (backend) is authoritative — handles TTL expiry, escalation,
   * and deletions.  But local ops that haven't been acked yet are
   * replayed on top so they survive flaky networks.
   */
  mergeRemote(remote) {
    if (!remote?.entries) return;

    this._entries.clear();

    for (const [ruleId, re] of Object.entries(remote.entries)) {
      this._entries.set(ruleId, {
        mode: re.mode || 'fingerprint',
        fingerprints: new Set(re.fingerprints || []),
        createdAt: re.createdAt || new Date().toISOString(),
        updatedAt: re.updatedAt || new Date().toISOString(),
        ttl: re.ttl ?? null,
        reason: re.reason ?? null,
        escalated: re.escalated ?? false,
      });
    }

    // Replay un-acked ops on top of remote state
    const pending = this._pendingOps.filter((op) => !op.acked);
    for (const op of pending) {
      if (op.op === 'suppress') {
        // Re-apply local suppress that backend hasn't seen yet
        const now = new Date().toISOString();
        let entry = this._entries.get(op.ruleId);
        if (!entry) {
          entry = {
            mode: op.mode || 'fingerprint',
            fingerprints: new Set(),
            createdAt: now,
            updatedAt: now,
            ttl: op.ttl ?? null,
            reason: op.reason ?? null,
            escalated: false,
          };
          this._entries.set(op.ruleId, entry);
        }
      } else if (op.op === 'unsuppress') {
        this._entries.delete(op.ruleId);
      }
    }

    this._updatedAt = remote.updatedAt || new Date().toISOString();
    this._save();
  }

  // ── Pending ops queue ──────────────────────────────────────────────

  /** @private Append op to queue (capped). */
  _queueOp({ op, ruleId, mode, reason, ttl }) {
    this._pendingOps.push({
      op,
      ruleId,
      mode: mode ?? undefined,
      reason: reason ?? undefined,
      ttl: ttl ?? undefined,
      ts: new Date().toISOString(),
      acked: false,
    });
    // Cap queue to prevent unbounded growth
    if (this._pendingOps.length > MAX_PENDING_OPS) {
      this._pendingOps = this._pendingOps.slice(-MAX_PENDING_OPS);
    }
  }

  /**
   * Mark a pending op as acked by the backend.
   * Call after a successful gateway.aiPolicySuppress / aiPolicyUnsuppress.
   * @param {string} ruleId
   * @param {string} op  – 'suppress' | 'unsuppress'
   */
  ackOp(ruleId, op) {
    for (const entry of this._pendingOps) {
      if (entry.ruleId === ruleId && entry.op === op && !entry.acked) {
        entry.acked = true;
        break; // ack oldest matching
      }
    }
    // Prune fully-acked ops
    this._pendingOps = this._pendingOps.filter((e) => !e.acked);
  }

  /** Get un-acked ops (for debugging / sync status). */
  get pendingOps() {
    return this._pendingOps.filter((e) => !e.acked);
  }

  /** Clear all pending ops (e.g. after successful full sync). */
  clearPendingOps() {
    this._pendingOps = [];
  }

  // ── Persistence (localStorage) ─────────────────────────────────────

  _save() {
    try {
      const key = storageKey(this._env, this._workspaceId, this._userId);
      localStorage.setItem(key, JSON.stringify(this.toJSON()));
    } catch {
      // localStorage may be unavailable or full
    }
  }

  _load() {
    try {
      const key = storageKey(this._env, this._workspaceId, this._userId);
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
          escalated: entry.escalated ?? false,
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

}

/** Singleton — reconfigure via .configure() once identity is known. */
export const aiSuppressedRules = new AISuppressedRules();
