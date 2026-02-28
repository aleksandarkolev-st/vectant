// src/services/aiSuppressedRules.js
// Client-side storage for user-suppressed AI rule IDs.
//
// When a user right-clicks "Suppress this rule" on a fix,
// the rule_id is added here. Suppressed rules are filtered
// out before displaying fixes.
//
// Persistence: localStorage (survives session restarts).

const STORAGE_KEY = 'synthi:ai-suppressed-rules';

class AISuppressedRules {
  constructor() {
    this._rules = new Set();
    this._load();
  }

  /** Suppress a rule by ID. */
  suppress(ruleId) {
    if (!ruleId) return;
    this._rules.add(ruleId);
    this._save();
  }

  /** Un-suppress a rule. */
  unsuppress(ruleId) {
    this._rules.delete(ruleId);
    this._save();
  }

  /** Check if a rule is suppressed. */
  isSuppressed(ruleId) {
    return this._rules.has(ruleId);
  }

  /** Get all suppressed rule IDs. */
  all() {
    return [...this._rules];
  }

  /** Number of suppressed rules. */
  get count() {
    return this._rules.size;
  }

  /** Clear all suppressions. */
  clear() {
    this._rules.clear();
    this._save();
  }

  /**
   * Filter an array of fixes, removing any with suppressed rule_ids.
   * @param {Array} fixes
   * @returns {Array} non-suppressed fixes
   */
  filterFixes(fixes) {
    if (!fixes || this._rules.size === 0) return fixes;
    return fixes.filter((fix) => {
      const id = fix.rule_id || fix.ruleId || '';
      return !this._rules.has(id);
    });
  }

  // ── Persistence ────────────────────────────────────────────

  _save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...this._rules]));
    } catch {
      // localStorage may be unavailable
    }
  }

  _load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this._rules = new Set(arr);
        }
      }
    } catch {
      // corrupt or unavailable
    }
  }
}

/** Singleton instance. */
export const aiSuppressedRules = new AISuppressedRules();
