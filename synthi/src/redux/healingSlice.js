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
  enabled: true,

  // Configuration
  config: {
    autoHealCategories: DEFAULT_AUTO_HEAL_CATEGORIES,
    minConfidence: 0.9,
    maxFixesPerPass: 5,
    cooldownMs: 1000,
    debounceMs: 800,
    showNotifications: true,
    requireConfirmation: false, // If true, all fixes need user approval
    soundEnabled: false,
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
    sessionStartedAt: null,
  },

  // Event log (keep last 100 events)
  events: [],

  // Status for the UI indicator
  status: 'idle', // 'idle' | 'analyzing' | 'applying' | 'cooldown' | 'error'
  lastError: null,

  // Toast notification queue
  toastQueue: [],

  // ── AI Agent state ──────────────────────────────────────────────────
  ai: {
    enabled: true,
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
      state.toastQueue.push({
        id: action.payload.id || `toast-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        ...action.payload,
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
        sessionStartedAt: Date.now(),
      };
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
