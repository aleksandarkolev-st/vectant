// src/components/healing/HealingRulesEditor.jsx
// Plain-English rule builder for the self-healing system.
//
// Rules read as a sentence:  "Always fix missing imports in any file."
// The user never types regex, error codes, or JSON — each part of the
// sentence is a dropdown pick.  An optional "files matching …" scope opens
// a simple text input that accepts a glob (e.g. `tests/*`).
'use client';

import { useState, useCallback, useMemo } from 'react';
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

// ── Single rule row (view + inline edit) ─────────────────────────────────
function RuleRow({ rule, index, total, matchCount, onMove, onChange, onRemove, onToggle }) {
  const [isEditing, setIsEditing] = useState(false);

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
      className="flex items-start gap-2 p-2 rounded-md"
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
                user can see the rule is inert in the current snapshot. */}
            {typeof matchCount === 'number' && (
              <span
                className="text-[10px] px-1.5 py-0.5 rounded font-medium"
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
                  : `This rule would touch ${matchCount} current diagnostic${matchCount === 1 ? '' : 's'}`}
              >
                {matchCount > 0 ? `affects ${matchCount}` : 'no matches'}
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
  const { gateway } = useAnalyzerGateway();

  // Pre-compute a normalised context per diagnostic once so per-rule match
  // checks in the preview don't re-infer categories on every render.
  const diagnosticContexts = useMemo(() => {
    return (liveDiagnostics || []).map((d) => ({
      category: categorizeDiagnostic(d),
      severity: (d?.severity || 'error').toLowerCase(),
      confidence: typeof d?.confidence === 'number' ? d.confidence : undefined,
      filePath: d?.filePath || d?.file || d?.primaryFile || '',
      language: getFileLanguage(d?.filePath || d?.file || ''),
    }));
  }, [liveDiagnostics]);

  // Per-rule "affects N diagnostics" count.  Memoised so changes in a rule
  // you're NOT editing don't force the whole list to recompute.
  const ruleCounts = useMemo(() => {
    const out = {};
    for (const rule of rules || []) {
      if (!rule?.id) continue;
      let n = 0;
      for (const ctx of diagnosticContexts) {
        if (ruleMatches(rule, ctx)) n += 1;
      }
      out[rule.id] = n;
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
    if (!text || !gateway?.ruleTranslate) return;

    setNlTranslating(true);
    setNlError(null);
    try {
      const resp = await gateway.ruleTranslate({ plainEnglish: text });
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
  }, [dispatch, gateway, nlText]);

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
        <div
          className="text-xs font-semibold uppercase tracking-wider"
          style={{ color: 'var(--text-muted)' }}
        >
          Rules
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
        <div className="flex flex-col gap-1.5">
          {rules.map((rule, i) => (
            <RuleRow
              key={rule.id}
              rule={rule}
              index={i}
              total={rules.length}
              matchCount={ruleCounts[rule.id] ?? 0}
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
        className="text-sm text-left px-2 py-1.5 rounded-md mt-1 hover:opacity-80 transition-opacity"
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
