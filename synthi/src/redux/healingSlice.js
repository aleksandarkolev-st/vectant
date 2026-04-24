// src/redux/healingSlice.js
// Redux slice for the Self-Healing system state management.
// Tracks healing configuration, applied fixes, undo history, and statistics.
import { createSlice } from '@reduxjs/toolkit';

// ── Healing categories (mirrors backend HealingCategory) ──────────────────
export const HealingCategory = Object.freeze({
  MISSING_COLON: 'missing_colon',
  MISSING_SEMICOLON: 'missing_semicolon',
  MISSING_BRACKET: 'missing_bracket',
  UNUSED_IMPORT: 'unused_import',
  MISSING_IMPORT: 'missing_import',
  DUPLICATE_IMPORT: 'duplicate_import',
  TRAILING_WHITESPACE: 'trailing_whitespace',
  MISSING_NEWLINE_EOF: 'missing_newline_eof',
  UNCLOSED_STRING: 'unclosed_string',
  MISMATCHED_QUOTES: 'mismatched_quotes',
  NONE_COMPARISON: 'none_comparison',
  TRAILING_COMMA: 'trailing_comma',
  UNUSED_VARIABLE: 'unused_variable',
  UNDECLARED_VARIABLE: 'undeclared_variable',
  TYPO_IN_IDENTIFIER: 'typo_in_identifier',
  TYPE_MISMATCH: 'type_mismatch',
  MISSING_RETURN: 'missing_return',
  MISSING_INCLUDE: 'missing_include',
});

// ── Severity levels ───────────────────────────────────────────────────────
export const HealingSeverity = Object.freeze({
  CRITICAL: 'critical',
  MODERATE: 'moderate',
  LOW: 'low',
});

// ── Boldness → confidence threshold mapping ───────────────────────────────
// User-facing "How bold should healing be?" setting.  Maps to numeric
// confidence bands at runtime.  Keep these tuned conservatively — users
// only raise boldness after they trust the system.
export const BoldnessThresholds = Object.freeze({
  careful:    { autoApply: 0.95, suggest: 0.85, aiEscalate: null  },
  balanced:   { autoApply: 0.90, suggest: 0.70, aiEscalate: 0.50  },
  aggressive: { autoApply: 0.80, suggest: 0.55, aiEscalate: 0.40  },
});

// ── Rule action types (returned by the rule engine) ───────────────────────
export const RuleAction = Object.freeze({
  AUTO_APPLY:  'auto_apply',   // silently fix
  SUGGEST:     'suggest',      // show lightbulb / pending fix
  AI_ESCALATE: 'ai_escalate',  // send to /heal/ai/hybrid for a second opinion
  IGNORE:      'ignore',       // drop entirely
});

// ── Trigger modes ──────────────────────────────────────────────────────────
export const TriggerMode = Object.freeze({
  ON_SAVE: 'onSave',
  ON_DIAGNOSTICS_STABLE: 'onDiagnosticsStable',
  ON_KEYSTROKE: 'onKeystroke',  // legacy / advanced — fires on every edit debounced
});

// ── Default categories that are safe to auto-heal ─────────────────────────
// NOTE: TRAILING_WHITESPACE, MISSING_NEWLINE_EOF, and TRAILING_COMMA are
// intentionally excluded — they produce cosmetic-only edits (add/remove
// blank lines, trim trailing spaces) that are disruptive without fixing
// real code issues.
const DEFAULT_AUTO_HEAL_CATEGORIES = [
  HealingCategory.DUPLICATE_IMPORT,
  HealingCategory.MISSING_COLON,
  HealingCategory.MISSING_SEMICOLON,
  HealingCategory.UNUSED_IMPORT,
  HealingCategory.MISSING_IMPORT,
  HealingCategory.MISSING_BRACKET,
  HealingCategory.NONE_COMPARISON,
  HealingCategory.MISSING_RETURN,
  HealingCategory.MISSING_INCLUDE,
];

// ── Initial state ─────────────────────────────────────────────────────────
export const initialHealingState = {
  // Master toggle
  enabled: false,

  // Configuration
  config: {
    // ── Plain-English knobs (primary UI) ─────────────────────────────
    // "How bold should healing be?"  → determines default confidence bands
    boldness: 'balanced',        // 'careful' | 'balanced' | 'aggressive'

    // "When should it run?"
    triggers: {
      onSave: true,
      onDiagnosticsStable: false,
      onKeystroke: false,         // advanced / legacy
      useAIForHard: false,        // escalate ambiguous fixes to /heal/ai/hybrid
    },

    // User-authored rules — evaluated top-to-bottom, first match wins.
    // Shape: { id, action, target, scope, disabled? }  (see ruleEngine.js)
    rules: [],

    // ── Power-user knobs (advanced accordion) ────────────────────────
    // When set, these OVERRIDE the boldness preset's thresholds.
    customThresholds: null,       // null | { autoApply, suggest, aiEscalate }
    maxFixesPerPass: 5,
    maxAiCallsPerMinute: 10,      // throttle for AI escalation
    debugLogging: false,          // enables [SelfHealing] verbose logs
    dryRun: false,                // log what would be applied without touching the buffer

    // ── Notifications ────────────────────────────────────────────────
    showNotifications: true,
    soundEnabled: false,

    // ── Legacy fields kept for backwards-compat / internal use ───────
    // (no longer exposed in the UI, but referenced by existing code paths)
    autoHealCategories: DEFAULT_AUTO_HEAL_CATEGORIES,
    minConfidence: 0.9,            // superseded by boldness thresholds
    cooldownMs: 1000,
    debounceMs: 800,
    requireConfirmation: false,    // rules now dictate this (SUGGEST action)
  },

  // Currently pending fixes (awaiting application or confirmation)
  pendingFixes: [],

  // Recently applied fixes (for undo support, keep last 50)
  appliedFixes: [],

  // Undo stack – stores reverted text for each applied fix
  undoStack: [],

  // Per-file healing state
  fileStates: {},
  // Shape: { [filePath]: { lastHealedAt, fixCount, isHealing, lastContentHash } }

  // Global statistics
  stats: {
    totalFixesApplied: 0,
    totalFixesSkipped: 0,
    totalFixesUndone: 0,
    fixesByCategory: {},
    fixesByLanguage: {},
    // Routing breakdown — lets users see whether their boldness preset
    // is producing sensible splits (too many suggestions? too few?).
    fixesByAction: {
      auto_apply: 0,
      suggest: 0,
      ai_escalate: 0,
      ignored: 0,
    },
    sessionStartedAt: null,
  },

  // Smart-rule-suggestion tracker.  Each time the user manually accepts a
  // suggested fix of some category, the count bumps; when it crosses a
  // threshold, useSmartRuleSuggestions proposes an auto-apply rule.
  // Symmetric: dismissals bump a separate counter for "never heal this".
  suggestionCandidates: {
    accepts:    {},   // { [category]: number }
    dismissals: {},   // { [category]: number }
  },
  // Per-category timestamp, set when the user declined a suggestion so we
  // don't nag them again for a while.
  suggestionsSnoozed: {},

  // Event log (keep last 100 events)
  events: [],

  // Status for the UI indicator
  status: 'idle', // 'idle' | 'analyzing' | 'applying' | 'cooldown' | 'error'
  lastError: null,

  // Toast notification queue
  toastQueue: [],

  // ── AI Agent state ──────────────────────────────────────────────────
  ai: {
    enabled: false,
    mode: 'ai', // 'ai' | 'hybrid' | 'off'
    isAnalyzing: false,
    lastAnalyzedAt: null,
    pendingFixes: [],
    stats: null,
    error: null,
  },
};

// ── Slice ─────────────────────────────────────────────────────────────────
const healingSlice = createSlice({
  name: 'healing',
  initialState: initialHealingState,
  reducers: {
    // ── Master toggle ───────────────────────────────────────────────────
    setHealingEnabled(state, action) {
      state.enabled = !!action.payload;
      if (!state.enabled) {
        state.status = 'idle';
        state.pendingFixes = [];
      }
    },
    toggleHealing(state) {
      state.enabled = !state.enabled;
      if (!state.enabled) {
        state.status = 'idle';
        state.pendingFixes = [];
      }
    },

    // ── Configuration ───────────────────────────────────────────────────
    updateConfig(state, action) {
      state.config = { ...state.config, ...action.payload };
    },
    setAutoHealCategories(state, action) {
      state.config.autoHealCategories = action.payload;
    },
    addAutoHealCategory(state, action) {
      const cat = action.payload;
      if (!state.config.autoHealCategories.includes(cat)) {
        state.config.autoHealCategories.push(cat);
      }
    },
    removeAutoHealCategory(state, action) {
      state.config.autoHealCategories = state.config.autoHealCategories.filter(
        (c) => c !== action.payload
      );
    },
    setMinConfidence(state, action) {
      const val = parseFloat(action.payload);
      if (!isNaN(val) && val >= 0 && val <= 1) {
        state.config.minConfidence = val;
      }
    },
    setRequireConfirmation(state, action) {
      state.config.requireConfirmation = !!action.payload;
    },

    // ── Boldness / triggers / rules ─────────────────────────────────────
    setBoldness(state, action) {
      const val = action.payload;
      if (val === 'careful' || val === 'balanced' || val === 'aggressive') {
        state.config.boldness = val;
      }
    },
    setTrigger(state, action) {
      // payload: { key: 'onSave'|'onDiagnosticsStable'|'onKeystroke'|'useAIForHard', value: boolean }
      const { key, value } = action.payload || {};
      if (state.config.triggers && typeof key === 'string') {
        state.config.triggers[key] = !!value;
      }
    },
    setTriggers(state, action) {
      state.config.triggers = { ...state.config.triggers, ...(action.payload || {}) };
    },
    setCustomThresholds(state, action) {
      state.config.customThresholds = action.payload || null;
    },
    setDebugLogging(state, action) {
      state.config.debugLogging = !!action.payload;
    },
    setDryRun(state, action) {
      state.config.dryRun = !!action.payload;
    },
    setMaxAiCallsPerMinute(state, action) {
      const n = parseInt(action.payload, 10);
      if (!Number.isNaN(n) && n >= 0) state.config.maxAiCallsPerMinute = n;
    },

    // Rule management
    addRule(state, action) {
      const rule = action.payload;
      if (!rule || typeof rule !== 'object') return;
      if (!rule.id) rule.id = `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
      state.config.rules.push(rule);
    },
    updateRule(state, action) {
      const { id, patch } = action.payload || {};
      const idx = state.config.rules.findIndex((r) => r.id === id);
      if (idx !== -1) {
        state.config.rules[idx] = { ...state.config.rules[idx], ...(patch || {}) };
      }
    },
    removeRule(state, action) {
      state.config.rules = state.config.rules.filter((r) => r.id !== action.payload);
    },
    reorderRules(state, action) {
      // payload: array of rule ids in the new order
      const order = action.payload || [];
      const byId = new Map(state.config.rules.map((r) => [r.id, r]));
      const reordered = [];
      for (const id of order) if (byId.has(id)) reordered.push(byId.get(id));
      // append any rules not in the order list at the end
      for (const r of state.config.rules) if (!order.includes(r.id)) reordered.push(r);
      state.config.rules = reordered;
    },
    setRules(state, action) {
      state.config.rules = Array.isArray(action.payload) ? action.payload : [];
    },

    // ── Status ──────────────────────────────────────────────────────────
    setHealingStatus(state, action) {
      state.status = action.payload;
    },
    setHealingError(state, action) {
      state.status = 'error';
      state.lastError = action.payload;
    },
    clearHealingError(state) {
      if (state.status === 'error') state.status = 'idle';
      state.lastError = null;
    },

    // ── Pending fixes ───────────────────────────────────────────────────
    setPendingFixes(state, action) {
      state.pendingFixes = action.payload || [];
    },
    addPendingFix(state, action) {
      state.pendingFixes.push(action.payload);
    },
    removePendingFix(state, action) {
      const fixId = action.payload;
      state.pendingFixes = state.pendingFixes.filter((f) => f.id !== fixId);
    },
    clearPendingFixes(state) {
      state.pendingFixes = [];
    },

    // ── Applied fixes ───────────────────────────────────────────────────
    recordAppliedFix(state, action) {
      const fix = action.payload;
      // Add to applied list (max 50)
      state.appliedFixes.unshift({
        ...fix,
        appliedAt: Date.now(),
      });
      if (state.appliedFixes.length > 50) {
        state.appliedFixes = state.appliedFixes.slice(0, 50);
      }

      // Remove from pending
      if (fix.id) {
        state.pendingFixes = state.pendingFixes.filter((f) => f.id !== fix.id);
      }

      // Update stats
      state.stats.totalFixesApplied += 1;
      const cat = fix.category || 'unknown';
      state.stats.fixesByCategory[cat] =
        (state.stats.fixesByCategory[cat] || 0) + 1;
      const lang = fix.language || 'unknown';
      state.stats.fixesByLanguage[lang] =
        (state.stats.fixesByLanguage[lang] || 0) + 1;

      // Update file state
      const filePath = fix.filePath || fix.file_path;
      if (filePath) {
        if (!state.fileStates[filePath]) {
          state.fileStates[filePath] = {
            lastHealedAt: null,
            fixCount: 0,
            isHealing: false,
            lastContentHash: null,
          };
        }
        state.fileStates[filePath].lastHealedAt = Date.now();
        state.fileStates[filePath].fixCount += 1;
      }
    },

    // ── Undo support ────────────────────────────────────────────────────
    pushUndo(state, action) {
      // action.payload: { fixId, filePath, originalText, range }
      state.undoStack.unshift(action.payload);
      if (state.undoStack.length > 50) {
        state.undoStack = state.undoStack.slice(0, 50);
      }
    },
    popUndo(state) {
      state.undoStack.shift();
    },
    recordUndone(state) {
      state.stats.totalFixesUndone += 1;
    },
    clearUndoStack(state) {
      state.undoStack = [];
    },

    // ── Skip tracking ───────────────────────────────────────────────────
    recordSkippedFix(state, action) {
      state.stats.totalFixesSkipped += 1;
      // Remove from pending if present
      const fixId = action.payload?.id;
      if (fixId) {
        state.pendingFixes = state.pendingFixes.filter((f) => f.id !== fixId);
      }
    },

    // ── File state ──────────────────────────────────────────────────────
    setFileHealingState(state, action) {
      const { filePath, ...rest } = action.payload;
      if (!state.fileStates[filePath]) {
        state.fileStates[filePath] = {
          lastHealedAt: null,
          fixCount: 0,
          isHealing: false,
          lastContentHash: null,
        };
      }
      Object.assign(state.fileStates[filePath], rest);
    },
    clearFileHealingState(state, action) {
      delete state.fileStates[action.payload];
    },

    // ── Events ──────────────────────────────────────────────────────────
    addHealingEvent(state, action) {
      state.events.unshift({
        ...action.payload,
        timestamp: action.payload.timestamp || Date.now(),
      });
      if (state.events.length > 100) {
        state.events = state.events.slice(0, 100);
      }
    },
    clearHealingEvents(state) {
      state.events = [];
    },

    // ── Toast queue ─────────────────────────────────────────────────────
    enqueueToast(state, action) {
      const next = action.payload || {};
      // Coalesce stacking healing toasts for the same file.  Without this,
      // each heal pass enqueues its own toast and Sonner stacks them into
      // a wall of "Auto-fixed 1 issue" notifications.
      if (next.type === 'healing') {
        const existingIdx = state.toastQueue.findIndex(
          (t) => t.type === 'healing' && (t.filePath || null) === (next.filePath || null)
        );
        if (existingIdx !== -1) {
          const existing = state.toastQueue[existingIdx];
          const combined = (existing.fixCount || 1) + (next.fixCount || 1);
          state.toastQueue[existingIdx] = {
            ...existing,
            // Use the newest description but the combined count
            fixCount: combined,
            message: combined === 1
              ? existing.message
              : `Auto-fixed ${combined} issues`,
            details: next.details || existing.details,
            createdAt: Date.now(),
            // Bump id so the toast component re-fires with the new count
            id: `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          };
          return;
        }
      }
      state.toastQueue.push({
        id: next.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ...next,
        createdAt: Date.now(),
      });
    },
    dequeueToast(state) {
      state.toastQueue.shift();
    },
    dismissToast(state, action) {
      state.toastQueue = state.toastQueue.filter(
        (t) => t.id !== action.payload
      );
    },
    clearToasts(state) {
      state.toastQueue = [];
    },

    // ── Session stats ───────────────────────────────────────────────────
    initSession(state) {
      state.stats.sessionStartedAt = Date.now();
    },
    resetStats(state) {
      state.stats = {
        totalFixesApplied: 0,
        totalFixesSkipped: 0,
        totalFixesUndone: 0,
        fixesByCategory: {},
        fixesByLanguage: {},
        fixesByAction: { auto_apply: 0, suggest: 0, ai_escalate: 0, ignored: 0 },
        sessionStartedAt: Date.now(),
      };
    },

    // Record a routing decision — called by the rule engine pathway
    // regardless of whether the fix was ultimately applied.  Payload:
    // { action: 'auto_apply'|'suggest'|'ai_escalate'|'ignore', count: number }
    incrementActionCount(state, action) {
      const { action: act, count } = action.payload || {};
      const n = typeof count === 'number' && count > 0 ? count : 1;
      const key = act === 'ignore' ? 'ignored' : act;  // stats key differs from RuleAction
      if (state.stats.fixesByAction && key in state.stats.fixesByAction) {
        state.stats.fixesByAction[key] += n;
      }
    },

    // Smart-rule-suggestion events
    recordSuggestionAccepted(state, action) {
      const cat = action.payload;
      if (!cat) return;
      state.suggestionCandidates.accepts[cat] =
        (state.suggestionCandidates.accepts[cat] || 0) + 1;
    },
    // Atomic replace that credits any dropped pending fix as a dismissal
    // (unless it's still in the new list).  Let the smart-rule hook watch
    // the resulting counts and propose an ignore-rule if the user keeps
    // letting the same category fall through without accepting.
    replacePendingFixesAndTrackDismissals(state, action) {
      const next = Array.isArray(action.payload) ? action.payload : [];
      const nextIds = new Set(next.map((f) => f.id).filter(Boolean));
      for (const prev of state.pendingFixes) {
        if (!prev?.id || nextIds.has(prev.id)) continue;
        const cat = prev.category;
        if (!cat) continue;
        state.suggestionCandidates.dismissals[cat] =
          (state.suggestionCandidates.dismissals[cat] || 0) + 1;
      }
      state.pendingFixes = next;
    },
    recordSuggestionDismissed(state, action) {
      const cat = action.payload;
      if (!cat) return;
      state.suggestionCandidates.dismissals[cat] =
        (state.suggestionCandidates.dismissals[cat] || 0) + 1;
    },
    snoozeSuggestionFor(state, action) {
      const cat = action.payload;
      if (!cat) return;
      state.suggestionsSnoozed[cat] = Date.now();
    },
    clearSuggestionCandidate(state, action) {
      const cat = action.payload;
      if (!cat) return;
      delete state.suggestionCandidates.accepts[cat];
      delete state.suggestionCandidates.dismissals[cat];
    },

    // ── Hydration (from localStorage) ───────────────────────────────────
    hydrateHealing(state, action) {
      const saved = action.payload;
      if (saved && typeof saved === 'object') {
        if (typeof saved.enabled === 'boolean') state.enabled = saved.enabled;
        if (saved.config) state.config = { ...state.config, ...saved.config };
      }
    },

    // ── Full reset ──────────────────────────────────────────────────────
    resetHealing() {
      return { ...initialHealingState };
    },

    // ── AI Agent reducers ─────────────────────────────────────────────
    setAIMode(state, action) {
      state.ai.mode = action.payload; // 'ai' | 'hybrid' | 'off'
    },
    setAIEnabled(state, action) {
      state.ai.enabled = !!action.payload;
    },
    setAIAnalyzing(state, action) {
      state.ai.isAnalyzing = !!action.payload;
    },
    setAIFixes(state, action) {
      state.ai.pendingFixes = action.payload || [];
      state.ai.lastAnalyzedAt = Date.now();
    },
    clearAIFixes(state) {
      state.ai.pendingFixes = [];
    },
    removeAIFix(state, action) {
      const fixId = action.payload;
      state.ai.pendingFixes = state.ai.pendingFixes.filter(
        (f) => (f.fix_id || f.id) !== fixId
      );
    },
    setAIStats(state, action) {
      state.ai.stats = action.payload;
    },
    setAIError(state, action) {
      state.ai.error = action.payload;
    },
    clearAIError(state) {
      state.ai.error = null;
    },
  },
});

export const {
  setHealingEnabled,
  toggleHealing,
  updateConfig,
  setAutoHealCategories,
  addAutoHealCategory,
  removeAutoHealCategory,
  setMinConfidence,
  setRequireConfirmation,
  setBoldness,
  setTrigger,
  setTriggers,
  setCustomThresholds,
  setDebugLogging,
  setDryRun,
  setMaxAiCallsPerMinute,
  addRule,
  updateRule,
  removeRule,
  reorderRules,
  setRules,
  setHealingStatus,
  setHealingError,
  clearHealingError,
  setPendingFixes,
  addPendingFix,
  removePendingFix,
  clearPendingFixes,
  recordAppliedFix,
  pushUndo,
  popUndo,
  recordUndone,
  clearUndoStack,
  recordSkippedFix,
  setFileHealingState,
  clearFileHealingState,
  addHealingEvent,
  clearHealingEvents,
  enqueueToast,
  dequeueToast,
  dismissToast,
  clearToasts,
  initSession,
  resetStats,
  incrementActionCount,
  recordSuggestionAccepted,
  replacePendingFixesAndTrackDismissals,
  recordSuggestionDismissed,
  snoozeSuggestionFor,
  clearSuggestionCandidate,
  hydrateHealing,
  resetHealing,
  // AI Agent
  setAIMode,
  setAIEnabled,
  setAIAnalyzing,
  setAIFixes,
  clearAIFixes,
  removeAIFix,
  setAIStats,
  setAIError,
  clearAIError,
} = healingSlice.actions;

export default healingSlice.reducer;
