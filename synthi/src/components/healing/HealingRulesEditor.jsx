// src/components/healing/HealingRulesEditor.jsx
// Plain-English rule builder for the self-healing system.
//
// Rules read as a sentence:  "Always fix missing imports in any file."
// The user never types regex, error codes, or JSON — each part of the
// sentence is a dropdown pick.  An optional "files matching …" scope opens
// a simple text input that accepts a glob (e.g. `tests/*`).
'use client';

import { useState, useCallback, useMemo, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Check } from 'lucide-react';
import { useDispatch, useSelector } from 'react-redux';
import {
  addRule,
  removeRule,
  updateRule,
  reorderRules,
  RuleAction,
} from '@/redux/healingSlice';
import { selectHealingRules, selectTriggers, selectLiveDiagnostics } from '@/redux/healingSelectors';
import {
  TargetVocabulary,
  ScopeVocabulary,
  ActionVocabulary,
  createRule,
  ruleToSentence,
  ruleMatches,
  categorizeDiagnostic,
  makeRuleId,
} from '@/lib/healing/ruleEngine';
import { useAnalyzerGateway } from '@/hooks/useAnalyzerGateway';
import { getFileLanguage } from '@/utils/fileUtils';

// ── Order dropdown options in a sensible narrative ──────────────────────
const ACTION_ORDER = [
  RuleAction.AUTO_APPLY,
  RuleAction.SUGGEST,
  RuleAction.AI_ESCALATE,
  RuleAction.IGNORE,
];

const TARGET_ORDER = [
  'any_error',
  'any_warning',
  'any_issue',
  'missing_imports',
  'unused_imports',
  'unused_variables',
  'missing_semicolons',
  'missing_colons',
  'missing_brackets',
  'syntax_errors',
  'type_errors',
  'style_warnings',
];

const SCOPE_ORDER = [
  'any_file',
  'javascript_files',
  'typescript_files',
  'python_files',
  'cpp_files',
  'java_files',
  'go_files',
  'rust_files',
  'glob',
];

// ── Inline dropdown pill ─────────────────────────────────────────────────
function Pill({ value, onChange, options, getLabel, className = '' }) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className={`inline-block rounded-md px-2 py-0.5 text-sm font-medium cursor-pointer appearance-none pr-6 ${className}`}
      style={{
        background: 'var(--bg-elevated)',
        color: 'var(--text-primary)',
        border: '1px solid var(--border-subtle)',
        backgroundImage:
          'linear-gradient(45deg, transparent 50%, currentColor 50%), linear-gradient(135deg, currentColor 50%, transparent 50%)',
        backgroundPosition:
          'calc(100% - 12px) calc(50% - 2px), calc(100% - 8px) calc(50% - 2px)',
        backgroundSize: '4px 4px',
        backgroundRepeat: 'no-repeat',
      }}
    >
      {options.map((opt) => (
        <option key={opt} value={opt}>
          {getLabel(opt)}
        </option>
      ))}
    </select>
  );
}

// ── Hover popover that shows the diagnostics a rule would affect ──────
// Portals to <body> so the rule-row's transform stacking context never
// clips it, and positions itself relative to the badge's viewport rect.
// Defaults to opening rightward; flips to the left side if that would
// overflow the viewport.
const POPOVER_WIDTH = 288; // w-72 = 18rem = 288px
const POPOVER_GAP   = 8;

function MatchPreview({ matched, anchorRect, onPointerEnter, onPointerLeave }) {
  if (!matched || matched.length === 0 || !anchorRect) return null;
  if (typeof document === 'undefined') return null;

  const display = matched.slice(0, 8);
  const overflow = matched.length - display.length;

  const viewportWidth = typeof window !== 'undefined' ? window.innerWidth : 1024;
  const flipLeft =
    anchorRect.right + POPOVER_GAP + POPOVER_WIDTH > viewportWidth - 16;
  const left = flipLeft
    ? Math.max(8, anchorRect.left - POPOVER_WIDTH - POPOVER_GAP)
    : anchorRect.right + POPOVER_GAP;
  const top = Math.max(8, anchorRect.top);

  return createPortal(
    <div
      role="dialog"
      className="heal-popover w-72 rounded-md p-2 text-left"
      style={{
        position: 'fixed',
        top,
        left,
        zIndex: 9999,
        background:
          'color-mix(in srgb, var(--bg-surface) 92%, transparent)',
        border: '1px solid var(--border-medium, var(--border-subtle))',
        color: 'var(--text-primary)',
        boxShadow:
          '0 12px 32px rgba(0,0,0,0.45), 0 0 0 1px color-mix(in srgb, var(--accent-primary) 14%, transparent)',
        transformOrigin: flipLeft ? 'top right' : 'top left',
      }}
      onMouseDown={(e) => e.stopPropagation()}
      onMouseEnter={onPointerEnter}
      onMouseLeave={onPointerLeave}
    >
      <div
        className="text-[10px] uppercase tracking-wider mb-1.5"
        style={{ color: 'var(--text-dim)' }}
      >
        Affects {matched.length} diagnostic{matched.length === 1 ? '' : 's'}
      </div>
      <div className="flex flex-col gap-1.5 max-h-64 overflow-y-auto heal-stagger">
        {display.map((d, i) => {
          const file = (d._raw?.filePath || d._raw?.file || '').split('/').pop() || 'file';
          const line = (d._raw?.location?.line ?? d._raw?.range?.start ?? 0) + 1;
          const fixCount = Array.isArray(d._raw?.fixes) ? d._raw.fixes.length : 0;
          const fixPreview = d._raw?.fixes?.[0]?.replacementText;
          const severity = (d.severity || 'error').toLowerCase();
          const sevColor =
            severity === 'error'
              ? 'var(--accent-danger, #ff6b6b)'
              : severity === 'warning'
                ? 'var(--accent-warning, #fbbf24)'
                : 'var(--accent-primary)';
          return (
            <div
              key={i}
              className="text-[11px] rounded p-1.5"
              style={{ background: 'var(--bg-base)', border: '1px solid var(--border-subtle)' }}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ background: sevColor }}
                />
                <span
                  className="font-mono text-[10px] truncate"
                  style={{ color: 'var(--text-muted)' }}
                  title={d._raw?.filePath || ''}
                >
                  {file}:{line}
                </span>
                {fixCount > 0 && (
                  <span
                    className="ml-auto text-[9px] px-1 rounded"
                    style={{
                      background: 'color-mix(in srgb, var(--accent-success) 15%, transparent)',
                      color: 'var(--accent-success)',
                    }}
                  >
                    {fixCount} fix{fixCount === 1 ? '' : 'es'}
                  </span>
                )}
              </div>
              {d._raw?.message && (
                <div
                  className="mt-1 text-[11px]"
                  style={{ color: 'var(--text-secondary)' }}
                >
                  {String(d._raw.message).slice(0, 140)}
                </div>
              )}
              {fixPreview && (
                <div
                  className="mt-1 px-1.5 py-0.5 rounded font-mono text-[10px] truncate"
                  style={{
                    background: 'color-mix(in srgb, var(--accent-success) 10%, transparent)',
                    color: 'color-mix(in srgb, var(--accent-success) 90%, white 10%)',
                  }}
                  title={fixPreview}
                >
                  → {String(fixPreview).slice(0, 80)}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {overflow > 0 && (
        <div
          className="text-[10px] text-center mt-1"
          style={{ color: 'var(--text-dim)' }}
        >
          + {overflow} more
        </div>
      )}
    </div>,
    document.body
  );
}

// ── Single rule row (view + inline edit) ─────────────────────────────────
function RuleRow({ rule, index, total, matched, onMove, onChange, onRemove, onToggle }) {
  const [isEditing, setIsEditing] = useState(false);
  const [hoverOpen, setHoverOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);
  const badgeWrapRef = useRef(null);
  const closeTimerRef = useRef(null);
  const matchCount = matched?.length ?? 0;

  const openHover = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
    if (badgeWrapRef.current) {
      setAnchorRect(badgeWrapRef.current.getBoundingClientRect());
    }
    setHoverOpen(true);
  }, []);
  const scheduleClose = useCallback(() => {
    if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
    closeTimerRef.current = setTimeout(() => setHoverOpen(false), 140);
  }, []);
  useEffect(() => () => { if (closeTimerRef.current) clearTimeout(closeTimerRef.current); }, []);

  // Re-measure the badge while the popover is open so scroll/resize keeps
  // it pinned.  Capture-phase scroll listener so nested scroll containers
  // (the settings panel itself) also trigger updates.
  useEffect(() => {
    if (!hoverOpen) return;
    const update = () => {
      if (badgeWrapRef.current) {
        setAnchorRect(badgeWrapRef.current.getBoundingClientRect());
      }
    };
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [hoverOpen]);

  const targetName =
    rule.target?.kind === 'target' ? rule.target.name : 'any_issue';
  const scopeName =
    rule.scope?.kind === 'glob'
      ? 'glob'
      : (rule.scope?.kind === 'scope' ? rule.scope.name : 'any_file');
  const globPattern = rule.scope?.kind === 'glob' ? (rule.scope.pattern || '') : '';

  const updateField = useCallback((patch) => {
    onChange(rule.id, patch);
  }, [onChange, rule.id]);

  return (
    <div
      className="heal-card flex items-start gap-2 p-2 rounded-md"
      style={{
        background: rule.disabled ? 'transparent' : 'var(--bg-elevated)',
        border: '1px solid var(--border-subtle)',
        opacity: rule.disabled ? 0.55 : 1,
      }}
    >
      {/* Enabled checkbox */}
      <input
        type="checkbox"
        checked={!rule.disabled}
        onChange={() => onToggle(rule.id, !!rule.disabled)}
        className="mt-1"
        title={rule.disabled ? 'Enable this rule' : 'Disable this rule'}
      />

      {/* Sentence — either read-only summary or inline builder */}
      <div className="flex-1 min-w-0">
        {!isEditing ? (
          <div className="flex items-baseline gap-1 flex-wrap">
            <span className="text-sm" style={{ color: 'var(--text-primary)' }}>
              {index + 1}.
            </span>
            <span
              className="text-sm cursor-text"
              style={{ color: 'var(--text-primary)' }}
              onClick={() => setIsEditing(true)}
            >
              {ruleToSentence(rule)}
            </span>
            {/* Live preview badge — updates as you edit the rule or as new
                diagnostics appear.  A zero count shows in muted grey so the
                user can see the rule is inert in the current snapshot.
                Hovering over a non-zero badge opens MatchPreview which
                lists each affected diagnostic with its fix preview. */}
            {typeof matchCount === 'number' && (
              <span
                ref={badgeWrapRef}
                className="inline-block"
                onMouseEnter={matchCount > 0 ? openHover : undefined}
                onMouseLeave={matchCount > 0 ? scheduleClose : undefined}
                onFocus={matchCount > 0 ? openHover : undefined}
                onBlur={matchCount > 0 ? scheduleClose : undefined}
              >
                <span
                  key={matchCount}
                  tabIndex={matchCount > 0 ? 0 : -1}
                  className="heal-count-pop inline-block text-[10px] px-1.5 py-0.5 rounded font-medium cursor-default transition-colors duration-200"
                  style={{
                    background: matchCount > 0
                      ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)'
                      : 'var(--bg-elevated)',
                    color: matchCount > 0
                      ? 'var(--accent-primary)'
                      : 'var(--text-dim)',
                  }}
                  title={matchCount === 0
                    ? 'No current diagnostics match this rule'
                    : `Hover for the ${matchCount} affected diagnostic${matchCount === 1 ? '' : 's'}`}
                >
                  {matchCount > 0 ? `affects ${matchCount}` : 'no matches'}
                </span>
                {hoverOpen && matchCount > 0 && (
                  <MatchPreview
                    matched={matched}
                    anchorRect={anchorRect}
                    onPointerEnter={openHover}
                    onPointerLeave={scheduleClose}
                  />
                )}
              </span>
            )}
          </div>
        ) : (
          <div className="flex items-baseline gap-1 flex-wrap">
            <Pill
              value={rule.action}
              onChange={(v) => updateField({ action: v })}
              options={ACTION_ORDER}
              getLabel={(v) => ActionVocabulary[v]?.label || v}
            />
            <Pill
              value={targetName}
              onChange={(v) =>
                updateField({ target: { kind: 'target', name: v } })
              }
              options={TARGET_ORDER}
              getLabel={(v) => TargetVocabulary[v]?.label || v}
            />
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              in
            </span>
            <Pill
              value={scopeName}
              onChange={(v) => {
                if (v === 'glob') {
                  updateField({
                    scope: { kind: 'glob', pattern: globPattern || '*' },
                  });
                } else {
                  updateField({ scope: { kind: 'scope', name: v } });
                }
              }}
              options={SCOPE_ORDER}
              getLabel={(v) => ScopeVocabulary[v]?.label || v}
            />
            {scopeName === 'glob' && (
              <input
                type="text"
                value={globPattern}
                onChange={(e) =>
                  updateField({
                    scope: { kind: 'glob', pattern: e.target.value },
                  })
                }
                placeholder="e.g. tests/*"
                className="ml-1 px-2 py-0.5 text-sm rounded-md"
                style={{
                  background: 'var(--bg-base)',
                  color: 'var(--text-primary)',
                  border: '1px solid var(--border-subtle)',
                  width: '12ch',
                }}
              />
            )}
            <span className="text-sm" style={{ color: 'var(--text-muted)' }}>
              .
            </span>
            <button
              onClick={() => setIsEditing(false)}
              className="ml-2 text-xs px-2 py-0.5 rounded"
              style={{ color: 'var(--accent-primary)' }}
            >
              Done
            </button>
          </div>
        )}
      </div>

      {/* Row controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={() => onMove(rule.id, -1)}
          disabled={index === 0}
          className="text-xs w-6 h-6 rounded hover:bg-[var(--bg-elevated)] disabled:opacity-30"
          title="Move up"
          style={{ color: 'var(--text-muted)' }}
        >
          ↑
        </button>
        <button
          onClick={() => onMove(rule.id, 1)}
          disabled={index === total - 1}
          className="text-xs w-6 h-6 rounded hover:bg-[var(--bg-elevated)] disabled:opacity-30"
          title="Move down"
          style={{ color: 'var(--text-muted)' }}
        >
          ↓
        </button>
        <button
          onClick={() => onRemove(rule.id)}
          className="text-xs w-6 h-6 rounded hover:bg-[var(--bg-elevated)]"
          title="Delete rule"
          style={{ color: 'var(--text-muted)' }}
        >
          ×
        </button>
      </div>
    </div>
  );
}

// ── Convert backend rule-translate response into a UI-shaped Rule object ──
function responseToRule(resp) {
  if (!resp || typeof resp !== 'object') return null;
  const { action, target, scope, pattern } = resp;
  if (!action || !target || !scope) return null;

  return {
    id: makeRuleId(),
    action,
    target: { kind: 'target', name: target },
    scope:
      scope === 'glob'
        ? { kind: 'glob', pattern: pattern || '*' }
        : { kind: 'scope', name: scope },
    disabled: false,
  };
}

// ── Main editor ──────────────────────────────────────────────────────────
export function HealingRulesEditor() {
  const dispatch = useDispatch();
  const rules = useSelector(selectHealingRules);
  const triggers = useSelector(selectTriggers);
  const liveDiagnostics = useSelector(selectLiveDiagnostics);
  const { ruleTranslate } = useAnalyzerGateway();

  // Saving indicator: a small green checkmark scales in then fades when
  // rules change.  We bump a counter on each save so React remounts the
  // icon and the synthi-save-pulse keyframe replays from the start.
  const [savedTick, setSavedTick] = useState(0);
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    setSavedTick((t) => t + 1);
  }, [rules]);

  // Pre-compute a normalised context per diagnostic once so per-rule match
  // checks in the preview don't re-infer categories on every render.  We
  // keep the raw diagnostic on `_raw` so the hover preview can show
  // file:line + message + fix replacement without another lookup.
  const diagnosticContexts = useMemo(() => {
    return (liveDiagnostics || []).map((d) => ({
      category: categorizeDiagnostic(d),
      severity: (d?.severity || 'error').toLowerCase(),
      confidence: typeof d?.confidence === 'number' ? d.confidence : undefined,
      filePath: d?.filePath || d?.file || d?.primaryFile || '',
      language: getFileLanguage(d?.filePath || d?.file || ''),
      _raw: d,
    }));
  }, [liveDiagnostics]);

  // Per-rule list of matched contexts.  The hover popover renders these
  // verbatim, and the count badge derives from .length.
  const ruleMatched = useMemo(() => {
    const out = {};
    for (const rule of rules || []) {
      if (!rule?.id) continue;
      const matched = [];
      for (const ctx of diagnosticContexts) {
        if (ruleMatches(rule, ctx)) matched.push(ctx);
      }
      out[rule.id] = matched;
    }
    return out;
  }, [rules, diagnosticContexts]);

  // Natural-language rule translation state
  const [nlText, setNlText] = useState('');
  const [nlTranslating, setNlTranslating] = useState(false);
  const [nlError, setNlError] = useState(null);

  // Only offer the NL input when AI is enabled — otherwise the endpoint
  // call just fails with a 503, and exposing it would be misleading.
  const aiAvailable = !!triggers?.useAIForHard;

  const handleAdd = useCallback(() => {
    dispatch(
      addRule(
        createRule({
          action: RuleAction.AUTO_APPLY,
          targetName: 'missing_imports',
          scopeName: 'any_file',
        })
      )
    );
  }, [dispatch]);

  const handleTranslate = useCallback(async () => {
    const text = nlText.trim();
    if (!text || typeof ruleTranslate !== 'function') return;

    setNlTranslating(true);
    setNlError(null);
    try {
      const resp = await ruleTranslate({ plainEnglish: text });
      const rule = responseToRule(resp);
      if (!rule) {
        setNlError("AI returned an unexpected response. Try rephrasing.");
        return;
      }
      dispatch(addRule(rule));
      setNlText('');
    } catch (err) {
      const msg = err?.message || String(err);
      // Gateway surfaces a "Rule translation backend error" when the
      // backend 503s (no GEMINI_API_KEY). Rewrite to something friendly.
      if (/503|unavailable|GEMINI_API_KEY/i.test(msg)) {
        setNlError("AI is not configured on the backend. Use the dropdown builder above.");
      } else if (/valid JSON|non-object/i.test(msg)) {
        setNlError("AI couldn't understand that. Try rephrasing or use the dropdown builder.");
      } else {
        setNlError(msg);
      }
    } finally {
      setNlTranslating(false);
    }
  }, [dispatch, ruleTranslate, nlText]);

  const handleChange = useCallback(
    (id, patch) => {
      dispatch(updateRule({ id, patch }));
    },
    [dispatch]
  );

  const handleRemove = useCallback(
    (id) => {
      dispatch(removeRule(id));
    },
    [dispatch]
  );

  const handleToggle = useCallback(
    (id, currentlyDisabled) => {
      dispatch(updateRule({ id, patch: { disabled: !currentlyDisabled } }));
    },
    [dispatch]
  );

  const handleMove = useCallback(
    (id, delta) => {
      const idx = rules.findIndex((r) => r.id === id);
      if (idx === -1) return;
      const newIdx = idx + delta;
      if (newIdx < 0 || newIdx >= rules.length) return;
      const order = rules.map((r) => r.id);
      [order[idx], order[newIdx]] = [order[newIdx], order[idx]];
      dispatch(reorderRules(order));
    },
    [dispatch, rules]
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div
            className="text-xs font-semibold uppercase tracking-wider"
            style={{ color: 'var(--text-muted)' }}
          >
            Rules
          </div>
          {/* Saving indicator: a small checkmark that scale-fades in/out
              on every rule edit.  key={savedTick} remounts the node so
              the synthi-save-pulse keyframe replays from 0%. */}
          {savedTick > 0 && (
            <Check
              key={savedTick}
              size={14}
              strokeWidth={3}
              className="synthi-save-pulse"
              style={{ color: 'var(--accent-success, #4ade80)' }}
              aria-label="Saved"
            />
          )}
        </div>
        <div className="text-[10px]" style={{ color: 'var(--text-dim)' }}>
          applied top to bottom
        </div>
      </div>

      {rules.length === 0 ? (
        <div
          className="text-xs italic p-3 rounded-md text-center"
          style={{ color: 'var(--text-muted)', background: 'var(--bg-elevated)' }}
        >
          No custom rules. Healing uses the default behaviour for all errors.
        </div>
      ) : (
        <div className="flex flex-col gap-1.5 heal-stagger">
          {rules.map((rule, i) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              index={i}
              total={rules.length}
              matched={ruleMatched[rule.id] || []}
              onMove={handleMove}
              onChange={handleChange}
              onRemove={handleRemove}
              onToggle={handleToggle}
            />
          ))}
        </div>
      )}

      <button
        onClick={handleAdd}
        className="heal-card text-sm text-left px-2 py-1.5 rounded-md mt-1"
        style={{
          color: 'var(--accent-primary)',
          background: 'var(--bg-elevated)',
          border: '1px dashed var(--border-medium)',
        }}
      >
        + Add a rule
      </button>

      {/* Natural-language rule translator — AI opt-in only */}
      {aiAvailable && (
        <div className="mt-2">
          <div
            className="text-[10px] mb-1"
            style={{ color: 'var(--text-dim)' }}
          >
            Or describe a rule in your own words:
          </div>
          <div className="flex gap-1">
            <input
              type="text"
              value={nlText}
              onChange={(e) => {
                setNlText(e.target.value);
                if (nlError) setNlError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !nlTranslating) handleTranslate();
              }}
              placeholder="e.g. don't touch files in the tests folder"
              disabled={nlTranslating}
              maxLength={500}
              className="flex-1 px-2 py-1 text-sm rounded-md"
              style={{
                background: 'var(--bg-base)',
                color: 'var(--text-primary)',
                border: '1px solid var(--border-subtle)',
              }}
            />
            <button
              onClick={handleTranslate}
              disabled={nlTranslating || !nlText.trim()}
              className="px-2 py-1 text-xs rounded-md disabled:opacity-40"
              style={{
                background: 'var(--accent-primary)',
                color: 'var(--text-on-accent, white)',
              }}
            >
              {nlTranslating ? '…' : 'Turn into rule'}
            </button>
          </div>
          {nlError && (
            <div
              className="text-[10px] mt-1"
              style={{ color: 'var(--accent-danger)' }}
            >
              {nlError}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default HealingRulesEditor;
