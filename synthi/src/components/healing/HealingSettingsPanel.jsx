// src/components/healing/HealingSettingsPanel.jsx
// Detailed settings panel for the self-healing system.
// Can be rendered inside the settings docking panel or as a standalone view.
'use client';

import { useCallback } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectHealingEnabled,
  selectHealingConfig,
  selectHealingStats,
  selectAppliedFixCount,
  selectFixesByCategorySorted,
} from '@/redux/healingSelectors';
import {
  toggleHealing,
  updateConfig,
  addAutoHealCategory,
  removeAutoHealCategory,
  setMinConfidence,
  setRequireConfirmation,
  resetStats,
} from '@/redux/healingSlice';
import { HealingCategory } from '@/redux/healingSlice';

// Human-readable labels for each category
const CATEGORY_INFO = {
  [HealingCategory.TRAILING_WHITESPACE]: { label: 'Trailing whitespace', desc: 'Remove trailing spaces/tabs' },
  [HealingCategory.MISSING_NEWLINE_EOF]: { label: 'Missing newline at EOF', desc: 'Ensure file ends with newline' },
  [HealingCategory.TRAILING_COMMA]: { label: 'Trailing commas', desc: 'Fix trailing commas in JSON/objects' },
  [HealingCategory.DUPLICATE_IMPORT]: { label: 'Duplicate imports', desc: 'Remove duplicate import statements' },
  [HealingCategory.MISSING_COLON]: { label: 'Missing colons', desc: 'Add missing colons (Python def/class/if)' },
  [HealingCategory.MISSING_SEMICOLON]: { label: 'Missing semicolons', desc: 'Add missing semicolons (JS/TS/C++)' },
  [HealingCategory.UNUSED_IMPORT]: { label: 'Unused imports', desc: 'Remove unused import statements' },
  [HealingCategory.MISSING_IMPORT]: { label: 'Missing imports', desc: 'Auto-add missing import statements' },
  [HealingCategory.MISSING_BRACKET]: { label: 'Missing brackets', desc: 'Close unmatched brackets/parens' },
  [HealingCategory.NONE_COMPARISON]: { label: 'None comparison style', desc: 'Convert == None to is None' },
  [HealingCategory.UNCLOSED_STRING]: { label: 'Unclosed strings', desc: 'Close unclosed string literals' },
  [HealingCategory.MISMATCHED_QUOTES]: { label: 'Mismatched quotes', desc: 'Fix mismatched quote characters' },
  [HealingCategory.MISSING_INCLUDE]: { label: 'Missing #include', desc: 'Auto-add C/C++ include directives' },
};

export function HealingSettingsPanel() {
  const dispatch = useDispatch();
  const enabled = useSelector(selectHealingEnabled);
  const config = useSelector(selectHealingConfig);
  const stats = useSelector(selectHealingStats);
  const appliedCount = useSelector(selectAppliedFixCount);
  const categorySorted = useSelector(selectFixesByCategorySorted);
  const autoCategories = new Set(config.autoHealCategories || []);

  const handleToggleCategory = useCallback(
    (cat) => {
      if (autoCategories.has(cat)) {
        dispatch(removeAutoHealCategory(cat));
      } else {
        dispatch(addAutoHealCategory(cat));
      }
    },
    [autoCategories, dispatch]
  );

  return (
    <div
      className="flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-3"
      style={{ color: 'var(--text-primary)' }}
    >
      <div
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        Self-Healing
      </div>

      {/* Master toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm">Enable Self-Healing</span>
        <button
          onClick={() => dispatch(toggleHealing())}
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${
            enabled ? 'th-toggle-on' : 'th-toggle-off'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              enabled ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Require confirmation toggle */}
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm">Require Confirmation</span>
          <div className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
            Show fixes before applying
          </div>
        </div>
        <button
          onClick={() =>
            dispatch(setRequireConfirmation(!config.requireConfirmation))
          }
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${
            config.requireConfirmation ? 'th-toggle-on' : 'th-toggle-off'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              config.requireConfirmation ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      {/* Notifications toggle */}
      <div className="flex items-center justify-between">
        <span className="text-sm">Show Notifications</span>
        <button
          onClick={() =>
            dispatch(updateConfig({ showNotifications: !config.showNotifications }))
          }
          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all ${
            config.showNotifications ? 'th-toggle-on' : 'th-toggle-off'
          }`}
        >
          <span
            className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
              config.showNotifications ? 'translate-x-5' : 'translate-x-0.5'
            }`}
          />
        </button>
      </div>

      <div
        className="border-t my-1"
        style={{ borderColor: 'var(--border-subtle)' }}
      />

      {/* Confidence threshold */}
      <div>
        <div className="flex items-center justify-between mb-1">
          <span className="text-sm">Min Confidence</span>
          <span
            className="text-xs font-mono"
            style={{ color: 'var(--text-muted)' }}
          >
            {(config.minConfidence ?? 0.9).toFixed(2)}
          </span>
        </div>
        <input
          type="range"
          min="0.5"
          max="1.0"
          step="0.05"
          value={config.minConfidence ?? 0.9}
          onChange={(e) => dispatch(setMinConfidence(e.target.value))}
          className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
          style={{
            background: `linear-gradient(to right, var(--accent-primary) 0%, var(--accent-primary) ${((config.minConfidence ?? 0.9) - 0.5) * 200}%, var(--bg-elevated) ${((config.minConfidence ?? 0.9) - 0.5) * 200}%, var(--bg-elevated) 100%)`,
          }}
        />
      </div>

      <div
        className="border-t my-1"
        style={{ borderColor: 'var(--border-subtle)' }}
      />

      {/* Auto-heal categories */}
      <div>
        <div
          className="text-xs font-semibold uppercase tracking-wider mb-2"
          style={{ color: 'var(--text-muted)' }}
        >
          Auto-Fix Categories
        </div>
        <div className="flex flex-col gap-1.5">
          {Object.entries(CATEGORY_INFO).map(([cat, info]) => (
            <label
              key={cat}
              className="flex items-start gap-2 cursor-pointer group"
            >
              <input
                type="checkbox"
                checked={autoCategories.has(cat)}
                onChange={() => handleToggleCategory(cat)}
                className="mt-0.5 rounded border-[var(--border-medium)] accent-[var(--accent-primary)]"
              />
              <div className="flex-1 min-w-0">
                <div className="text-sm group-hover:opacity-80 transition-opacity">
                  {info.label}
                </div>
                <div
                  className="text-[10px] leading-tight"
                  style={{ color: 'var(--text-dim)' }}
                >
                  {info.desc}
                </div>
              </div>
            </label>
          ))}
        </div>
      </div>

      {/* Stats summary */}
      {appliedCount > 0 && (
        <>
          <div
            className="border-t my-1"
            style={{ borderColor: 'var(--border-subtle)' }}
          />
          <div>
            <div className="flex items-center justify-between mb-2">
              <span
                className="text-xs font-semibold uppercase tracking-wider"
                style={{ color: 'var(--text-muted)' }}
              >
                Session Stats
              </span>
              <button
                onClick={() => dispatch(resetStats())}
                className="text-[10px] px-1.5 py-0.5 rounded"
                style={{ color: 'var(--text-muted)', background: 'var(--bg-elevated)' }}
              >
                Reset
              </button>
            </div>
            <div className="flex flex-col gap-1">
              <div className="flex justify-between text-sm">
                <span>Fixes applied</span>
                <span className="font-mono" style={{ color: 'var(--accent-success)' }}>
                  {stats.totalFixesApplied || 0}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Fixes skipped</span>
                <span className="font-mono" style={{ color: 'var(--text-muted)' }}>
                  {stats.totalFixesSkipped || 0}
                </span>
              </div>
              <div className="flex justify-between text-sm">
                <span>Fixes undone</span>
                <span className="font-mono" style={{ color: 'var(--text-muted)' }}>
                  {stats.totalFixesUndone || 0}
                </span>
              </div>
              {categorySorted.length > 0 && (
                <div className="mt-1">
                  <div className="text-[10px] uppercase" style={{ color: 'var(--text-dim)' }}>
                    By category:
                  </div>
                  {categorySorted.slice(0, 5).map(({ category, count }) => (
                    <div key={category} className="flex justify-between text-xs mt-0.5">
                      <span style={{ color: 'var(--text-muted)' }}>
                        {CATEGORY_INFO[category]?.label || category}
                      </span>
                      <span className="font-mono" style={{ color: 'var(--text-secondary)' }}>
                        {count}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

export default HealingSettingsPanel;
