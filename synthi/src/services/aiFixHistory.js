// src/services/aiFixHistory.js
// In-memory audit log for AI fix actions (apply/dismiss/auto-apply).
//
// Keeps the last N entries so the user can review what the AI
// changed and potentially undo.  Persisted to sessionStorage so
// it survives page reloads within a session.
//
// Usage:
//   import { aiFixHistory } from '@/services/aiFixHistory';
//   aiFixHistory.record({ fix, action: 'applied', filePath });
//   aiFixHistory.entries();
//   aiFixHistory.clear();

const STORAGE_KEY = 'synthi-ai-fix-history';
const MAX_ENTRIES = 200;

class AIFixHistory {
  constructor() {
    this._entries = [];
    this._load();
  }

  /** Record a fix action. */
  record({ fix, action, filePath, timestamp }) {
    const entry = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      fixId: fix?.fix_id || fix?.id || null,
      ruleId: fix?.rule_id || fix?.ruleId || null,
      category: fix?.category || null,
      description: fix?.description || null,
      confidence: fix?.confidence || null,
      severity: fix?.severity || null,
      line: fix?.line ?? fix?.start_line ?? null,
      originalText: fix?.original_text || fix?.originalText || null,
      replacementText: fix?.replacement_text || fix?.replacementText || null,
      action,        // 'applied' | 'dismissed' | 'auto_applied' | 'modified'
      filePath,
      timestamp: timestamp || Date.now(),
    };

    this._entries.unshift(entry); // newest first

    if (this._entries.length > MAX_ENTRIES) {
      this._entries = this._entries.slice(0, MAX_ENTRIES);
    }

    this._save();
    return entry;
  }

  /** Get all entries (newest first). */
  entries() {
    return [...this._entries];
  }

  /** Get entries for a specific file. */
  forFile(filePath) {
    return this._entries.filter((e) => e.filePath === filePath);
  }

  /** Get entries for a specific action. */
  forAction(action) {
    return this._entries.filter((e) => e.action === action);
  }

  /** Get recent entries (last N). */
  recent(n = 20) {
    return this._entries.slice(0, n);
  }

  /** Summary stats. */
  stats() {
    const applied = this._entries.filter((e) => e.action === 'applied' || e.action === 'auto_applied').length;
    const dismissed = this._entries.filter((e) => e.action === 'dismissed').length;
    const total = this._entries.length;

    return {
      total,
      applied,
      dismissed,
      acceptanceRate: total > 0 ? applied / total : 0,
      uniqueFiles: new Set(this._entries.map((e) => e.filePath)).size,
    };
  }

  /** Clear all history. */
  clear() {
    this._entries = [];
    this._save();
  }

  /** @private Load from sessionStorage. */
  _load() {
    try {
      if (typeof sessionStorage === 'undefined') return;
      const raw = sessionStorage.getItem(STORAGE_KEY);
      if (raw) {
        this._entries = JSON.parse(raw);
      }
    } catch {
      // Ignore parse errors
    }
  }

  /** @private Save to sessionStorage. */
  _save() {
    try {
      if (typeof sessionStorage === 'undefined') return;
      sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this._entries));
    } catch {
      // Storage full or unavailable — fail silently
    }
  }
}

/** Singleton instance. */
export const aiFixHistory = new AIFixHistory();
