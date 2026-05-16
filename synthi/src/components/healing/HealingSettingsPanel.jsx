// src/components/healing/HealingSettingsPanel.jsx
// User-facing settings panel for the self-healing system.
//
// Design goal: plain English, no numeric confidence thresholds or regex
// in the primary UI.  Users pick "how bold" (Careful/Balanced/Aggressive),
// when it should run (save/diagnostics-stable/AI), and compose custom
// rules as readable sentences.  Power-user knobs live behind an
// "Advanced" accordion.
'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useSelector, useDispatch } from 'react-redux';
import {
  selectHealingEnabled,
  selectHealingConfig,
  selectHealingStats,
  selectAppliedFixCount,
  selectFixesByCategorySorted,
  selectBoldness,
  selectTriggers,
  selectDebugLogging,
  selectDryRun,
  selectCustomThresholds,
} from '@/redux/healingSelectors';
import {
  toggleHealing,
  updateConfig,
  setBoldness,
  setTrigger,
  setCustomThresholds,
  setDebugLogging,
  setDryRun,
  setMaxAiCallsPerMinute,
  setRules,
  resetStats,
  enqueueToast,
  BoldnessThresholds,
} from '@/redux/healingSlice';
import { selectHealingRules } from '@/redux/healingSelectors';
import { HealingRulesEditor } from './HealingRulesEditor';
import { HealingHistoryPanel } from './HealingHistoryPanel';
import { ChevronRight } from 'lucide-react';

// ── Small UI atoms ──────────────────────────────────────────────────────
function Toggle({ checked, onChange, label, description }) {
  return (
    <label className="flex items-start justify-between cursor-pointer gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-sm" style={{ color: 'var(--text-primary)' }}>
          {label}
        </div>
        {description ? (
          <div className="text-[10px] leading-tight" style={{ color: 'var(--text-dim)' }}>
            {description}
          </div>
        ) : null}
      </div>
      <button
        type="button"
        onClick={() => onChange(!checked)}
        className={`relative inline-flex h-5 w-9 items-center rounded-full transition-all flex-shrink-0 ${
          checked ? 'th-toggle-on' : 'th-toggle-off'
        }`}
      >
        <span
          className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform shadow-sm ${
            checked ? 'translate-x-5' : 'translate-x-0.5'
          }`}
        />
      </button>
    </label>
  );
}

// Sliding-pill radio: a single absolutely-positioned indicator slides
// between options when the value changes, mirroring the hover/active feel
// of the dock-tab strip elsewhere in Synthi.  Inactive buttons get a
// subtle hover background so the pointer always has visual feedback.
function RadioRow({ value, onChange, options }) {
  const containerRef = useRef(null);
  const buttonRefs = useRef({});
  const [pill, setPill] = useState({ left: 0, width: 0, ready: false });
  const [hoveredOpt, setHoveredOpt] = useState(null);

  // Recompute the active button's geometry whenever the selected value or
  // the option list changes.  useLayoutEffect avoids a frame of misalignment.
  useLayoutEffect(() => {
    const container = containerRef.current;
    const button = buttonRefs.current[value];
    if (!container || !button) return;
    const cRect = container.getBoundingClientRect();
    const bRect = button.getBoundingClientRect();
    setPill({
      left: bRect.left - cRect.left,
      width: bRect.width,
      ready: true,
    });
  }, [value, options.length]);

  // Reposition on container resize — handles panel-width changes from
  // the docking system without needing a manual trigger.
  useEffect(() => {
    const container = containerRef.current;
    if (!container || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(() => {
      const button = buttonRefs.current[value];
      if (!button) return;
      const cRect = container.getBoundingClientRect();
      const bRect = button.getBoundingClientRect();
      setPill((p) => ({ left: bRect.left - cRect.left, width: bRect.width, ready: p.ready }));
    });
    ro.observe(container);
    return () => ro.disconnect();
  }, [value]);

  return (
    <div
      ref={containerRef}
      className="relative flex rounded-md p-0.5 gap-1"
      style={{
        background: 'var(--bg-base)',
        border: '1px solid var(--border-subtle)',
      }}
    >
      {/* Animated indicator pill — sits behind the buttons.
          On "Aggressive" the pill bleeds into the brand gradient,
          signalling intent: bolder choice, bolder visual. */}
      <div
        aria-hidden
        style={{
          position: 'absolute',
          top: 2,
          bottom: 2,
          left: pill.left,
          width: pill.width,
          background: value === 'aggressive'
            ? 'var(--brand-gradient)'
            : 'var(--attention-purple)',
          borderRadius: 4,
          opacity: pill.ready ? 1 : 0,
          transition:
            'left 280ms cubic-bezier(0.34, 1.36, 0.64, 1), width 280ms cubic-bezier(0.34, 1.36, 0.64, 1), opacity 120ms, background 200ms ease, box-shadow 200ms ease',
          boxShadow: value === 'aggressive'
            ? '0 1px 2px rgba(0,0,0,0.25), 0 0 14px color-mix(in srgb, var(--brand-stop-3) 38%, transparent)'
            : '0 1px 2px rgba(0,0,0,0.25), 0 0 12px color-mix(in srgb, var(--attention-purple) 32%, transparent)',
          pointerEvents: 'none',
          zIndex: 0,
        }}
      />
      {options.map((opt) => {
        const selected = value === opt.value;
        const isHover = hoveredOpt === opt.value && !selected;
        return (
          <button
            ref={(el) => {
              if (el) buttonRefs.current[opt.value] = el;
              else delete buttonRefs.current[opt.value];
            }}
            type="button"
            key={opt.value}
            onClick={() => onChange(opt.value)}
            onMouseEnter={() => setHoveredOpt(opt.value)}
            onMouseLeave={() => setHoveredOpt((h) => (h === opt.value ? null : h))}
            onFocus={() => setHoveredOpt(opt.value)}
            onBlur={() => setHoveredOpt((h) => (h === opt.value ? null : h))}
            className="relative flex-1 px-2 py-1 text-xs rounded focus:outline-none"
            style={{
              background: isHover ? 'rgba(255,255,255,0.04)' : 'transparent',
              color: selected
                ? 'var(--text-on-accent, white)'
                : isHover
                  ? 'var(--text-primary)'
                  : 'var(--text-muted)',
              fontWeight: selected ? 600 : 500,
              transition: 'color 160ms, background-color 160ms',
              zIndex: 1,
            }}
            title={opt.description}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

function SectionDivider() {
  return (
    <div
      className="border-t my-2"
      style={{ borderColor: 'var(--border-subtle)' }}
    />
  );
}

function SectionLabel({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between">
      <div
        className="text-xs font-semibold uppercase tracking-wider"
        style={{ color: 'var(--text-muted)' }}
      >
        {children}
      </div>
      {hint ? (
        <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
          {hint}
        </div>
      ) : null}
    </div>
  );
}

// ── Main panel ──────────────────────────────────────────────────────────
export function HealingSettingsPanel() {
  const dispatch = useDispatch();
  const enabled = useSelector(selectHealingEnabled);
  const config = useSelector(selectHealingConfig);
  const stats = useSelector(selectHealingStats);
  const appliedCount = useSelector(selectAppliedFixCount);
  const categorySorted = useSelector(selectFixesByCategorySorted);
  const boldness = useSelector(selectBoldness);
  const triggers = useSelector(selectTriggers);
  const debug = useSelector(selectDebugLogging);
  const dryRun = useSelector(selectDryRun);
  const custom = useSelector(selectCustomThresholds);
  const rules = useSelector(selectHealingRules);

  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [importText, setImportText] = useState('');
  const [importError, setImportError] = useState(null);

  const handleExportRules = useCallback(async () => {
    const text = JSON.stringify(rules, null, 2);
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard) {
        await navigator.clipboard.writeText(text);
        dispatch(enqueueToast({
          type: 'healing-undo',
          message: `Copied ${rules.length} rule${rules.length === 1 ? '' : 's'} to clipboard`,
        }));
      }
    } catch {
      // Clipboard blocked — fall back to showing the text in the import box
      setImportText(text);
    }
  }, [rules, dispatch]);

  const handleImportRules = useCallback(() => {
    const text = importText.trim();
    if (!text) {
      setImportError('Paste a JSON array of rules.');
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      setImportError(`Invalid JSON: ${e.message}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setImportError('Expected a JSON array of rules.');
      return;
    }
    // Regenerate ids so import doesn't collide with existing rules
    const normalised = parsed
      .filter((r) => r && typeof r === 'object' && r.action)
      .map((r) => ({
        ...r,
        id: `rule-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        disabled: !!r.disabled,
      }));
    if (normalised.length === 0) {
      setImportError('No valid rules found in JSON.');
      return;
    }
    dispatch(setRules(normalised));
    dispatch(enqueueToast({
      type: 'healing-undo',
      message: `Imported ${normalised.length} rule${normalised.length === 1 ? '' : 's'}`,
    }));
    setImportText('');
    setImportError(null);
  }, [importText, dispatch]);

  const handleTrigger = useCallback(
    (key, value) => dispatch(setTrigger({ key, value })),
    [dispatch]
  );

  const thresholds = custom || BoldnessThresholds[boldness] || BoldnessThresholds.balanced;

  return (
    <div
      className="flex flex-col h-full min-h-0 overflow-y-auto p-3 gap-3"
      style={{ color: 'var(--text-primary)' }}
    >
      {/* Master toggle */}
      <Toggle
        checked={enabled}
        onChange={() => dispatch(toggleHealing())}
        label="Enable Self-Healing"
        description="Automatically fix small issues the analyzer detects."
      />

      <Toggle
        checked={!!config.showNotifications}
        onChange={(v) => dispatch(updateConfig({ showNotifications: v }))}
        label="Notify me when fixes are applied"
      />

      {/* Boldness */}
      <SectionDivider />
      <div>
        <SectionLabel>How bold should healing be?</SectionLabel>
        <div className="mt-2">
          <RadioRow
            value={boldness}
            onChange={(v) => dispatch(setBoldness(v))}
            options={[
              {
                value: 'careful',
                label: 'Careful',
                description: 'Only fix things it is absolutely sure about.',
              },
              {
                value: 'balanced',
                label: 'Balanced',
                description: 'Fix safe stuff, suggest the rest.',
              },
              {
                value: 'aggressive',
                label: 'Aggressive',
                description:
                  'Try harder, and ask AI for help on tricky errors (if enabled).',
              },
            ]}
          />
        </div>
        <div
          className="text-[10px] mt-1.5"
          style={{ color: 'var(--text-dim)' }}
        >
          {boldness === 'careful'
            ? 'Only fixes with very high confidence are applied automatically.'
            : boldness === 'balanced'
              ? 'Safe fixes auto-apply; less certain ones wait for your approval.'
              : 'Auto-applies more confidently and uses AI to handle harder cases.'}
        </div>
      </div>

      {/* Triggers */}
      <SectionDivider />
      <div className="flex flex-col gap-2">
        <SectionLabel>When should it run?</SectionLabel>
        <Toggle
          checked={!!triggers.onSave}
          onChange={(v) => handleTrigger('onSave', v)}
          label="When I save a file"
        />
        <Toggle
          checked={!!triggers.onDiagnosticsStable}
          onChange={(v) => handleTrigger('onDiagnosticsStable', v)}
          label="Continuously as I work"
          description="Runs after you pause typing - can be noisier."
        />
        <Toggle
          checked={!!triggers.useAIForHard}
          onChange={(v) => handleTrigger('useAIForHard', v)}
          label="Also try AI for tricky errors"
          description="Sends uncertain fixes to the AI backend (uses credits)."
        />
      </div>

      {/* Rules */}
      <SectionDivider />
      <HealingRulesEditor />

      {/* Stats */}
      {appliedCount > 0 && (
        <>
          <SectionDivider />
          <div>
            <div className="flex items-center justify-between mb-2">
              <SectionLabel>Session Stats</SectionLabel>
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

              {/* Routing breakdown */}
              {stats.fixesByAction && (
                <div className="mt-1">
                  <div
                    className="text-[10px] uppercase"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    By action:
                  </div>
                  {[
                    { key: 'auto_apply',  label: 'Auto-applied' },
                    { key: 'suggest',     label: 'Suggested' },
                    { key: 'ai_escalate', label: 'Sent to AI' },
                    { key: 'ignored',     label: 'Ignored by rule' },
                  ].map(({ key, label }) => (
                    <div key={key} className="flex justify-between text-xs mt-0.5">
                      <span style={{ color: 'var(--text-muted)' }}>{label}</span>
                      <span
                        className="font-mono"
                        style={{ color: 'var(--text-secondary)' }}
                      >
                        {stats.fixesByAction[key] || 0}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {categorySorted.length > 0 && (
                <div className="mt-1">
                  <div
                    className="text-[10px] uppercase"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    By category:
                  </div>
                  {categorySorted.slice(0, 5).map(({ category, count }) => (
                    <div
                      key={category}
                      className="flex justify-between text-xs mt-0.5"
                    >
                      <span style={{ color: 'var(--text-muted)' }}>
                        {category.replace(/_/g, ' ')}
                      </span>
                      <span
                        className="font-mono"
                        style={{ color: 'var(--text-secondary)' }}
                      >
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

      {/* Recent fixes / time-travel */}
      <SectionDivider />
      <HealingHistoryPanel />

      {/* Advanced accordion */}
      <SectionDivider />
      <div>
        <button
          onClick={() => setAdvancedOpen((v) => !v)}
          className="flex items-center gap-1 text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          <ChevronRight
            className={`w-3 h-3 heal-chevron ${advancedOpen ? 'is-open' : ''}`}
            aria-hidden
          />
          <span>Advanced</span>
        </button>

        {advancedOpen && (
          <div className="mt-3 flex flex-col gap-3 heal-row-enter">
            {/* Fine-tune thresholds */}
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                Confidence thresholds
              </div>
              <div className="text-[10px] mb-2" style={{ color: 'var(--text-dim)' }}>
                Override the boldness preset. Leave at the preset to restore
                defaults.
              </div>

              <ThresholdRow
                label="Auto-apply at or above"
                value={thresholds.autoApply}
                onChange={(v) =>
                  dispatch(
                    setCustomThresholds({ ...thresholds, autoApply: v })
                  )
                }
              />
              <ThresholdRow
                label="Suggest at or above"
                value={thresholds.suggest}
                onChange={(v) =>
                  dispatch(setCustomThresholds({ ...thresholds, suggest: v }))
                }
              />
              <ThresholdRow
                label="Ask AI at or above"
                value={thresholds.aiEscalate ?? 0}
                disabled={!triggers.useAIForHard}
                onChange={(v) =>
                  dispatch(
                    setCustomThresholds({ ...thresholds, aiEscalate: v })
                  )
                }
              />
              {custom && (
                <button
                  onClick={() => dispatch(setCustomThresholds(null))}
                  className="mt-1 text-[10px]"
                  style={{ color: 'var(--accent-primary)' }}
                >
                  Reset to "{boldness}" preset
                </button>
              )}
            </div>

            <div className="flex flex-col gap-2">
              <Toggle
                checked={debug}
                onChange={(v) => dispatch(setDebugLogging(v))}
                label="Debug logging"
                description="Print [SelfHealing] decisions to the browser console."
              />
              <Toggle
                checked={dryRun}
                onChange={(v) => dispatch(setDryRun(v))}
                label="Dry-run mode"
                description="Log what would be applied without touching the buffer."
              />
            </div>

            {/* Throttle */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm">Max AI calls per minute</span>
                <span
                  className="text-xs font-mono"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {config.maxAiCallsPerMinute ?? 10}
                </span>
              </div>
              <input
                type="range"
                min="0"
                max="60"
                step="1"
                value={config.maxAiCallsPerMinute ?? 10}
                onChange={(e) =>
                  dispatch(setMaxAiCallsPerMinute(parseInt(e.target.value, 10)))
                }
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{ background: 'var(--bg-elevated)' }}
              />
            </div>

            {/* Max fixes per pass */}
            <div>
              <div className="flex items-center justify-between mb-1">
                <span className="text-sm">Max fixes per pass</span>
                <span
                  className="text-xs font-mono"
                  style={{ color: 'var(--text-muted)' }}
                >
                  {config.maxFixesPerPass ?? 5}
                </span>
              </div>
              <input
                type="range"
                min="1"
                max="20"
                step="1"
                value={config.maxFixesPerPass ?? 5}
                onChange={(e) =>
                  dispatch(
                    updateConfig({
                      maxFixesPerPass: parseInt(e.target.value, 10),
                    })
                  )
                }
                className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
                style={{ background: 'var(--bg-elevated)' }}
              />
            </div>

            {/* Export / Import rules */}
            <div>
              <div className="text-xs mb-1" style={{ color: 'var(--text-muted)' }}>
                Share your rules
              </div>
              <div className="text-[10px] mb-2" style={{ color: 'var(--text-dim)' }}>
                Copy rules as JSON to share with a teammate, or paste a JSON array
                to replace your current rules.
              </div>
              <button
                onClick={handleExportRules}
                disabled={rules.length === 0}
                className="text-xs px-2 py-1 rounded-md mr-2 disabled:opacity-40"
                style={{ background: 'var(--bg-elevated)', color: 'var(--text-primary)' }}
              >
                Copy rules as JSON
              </button>
              <textarea
                value={importText}
                onChange={(e) => {
                  setImportText(e.target.value);
                  if (importError) setImportError(null);
                }}
                placeholder="Paste JSON here..."
                className="w-full mt-2 px-2 py-1 text-xs font-mono rounded-md"
                rows={4}
                style={{
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-subtle)',
                  resize: 'vertical',
                }}
              />
              <div className="flex items-center gap-2 mt-1">
                <button
                  onClick={handleImportRules}
                  disabled={!importText.trim()}
                  className="text-xs px-2 py-1 rounded-md disabled:opacity-40"
                  style={{
                    background: 'var(--accent-primary)',
                    color: 'var(--text-on-accent, white)',
                  }}
                >
                  Import (replaces current)
                </button>
                {importError && (
                  <span
                    className="text-[10px]"
                    style={{ color: 'var(--accent-danger)' }}
                  >
                    {importError}
                  </span>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function ThresholdRow({ label, value, onChange, disabled }) {
  return (
    <div className={`mb-2 ${disabled ? 'opacity-50' : ''}`}>
      <div className="flex items-center justify-between mb-0.5">
        <span className="text-xs">{label}</span>
        <span
          className="text-[10px] font-mono"
          style={{ color: 'var(--text-muted)' }}
        >
          {(value ?? 0).toFixed(2)}
        </span>
      </div>
      <input
        type="range"
        min="0.3"
        max="1.0"
        step="0.05"
        value={value ?? 0}
        disabled={disabled}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        className="w-full h-1.5 rounded-full appearance-none cursor-pointer"
        style={{ background: 'var(--bg-elevated)' }}
      />
    </div>
  );
}

export default HealingSettingsPanel;
