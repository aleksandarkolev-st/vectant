// src/components/healing/HealingRulesEditor.jsx
// Plain-English rule builder for the self-healing system.
//
// Rules read as a sentence:  "Always fix missing imports in any file."
// The user never types regex, error codes, or JSON — each part of the
// sentence is a dropdown pick.  An optional "files matching …" scope opens
// a simple text input that accepts a glob (e.g. `tests/*`).
'use client';

import { useState, useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import {
  addRule,
  removeRule,
  updateRule,
  reorderRules,
  RuleAction,
} from '@/redux/healingSlice';
import { selectHealingRules } from '@/redux/healingSelectors';
import {
  TargetVocabulary,
  ScopeVocabulary,
  ActionVocabulary,
  createRule,
  ruleToSentence,
} from '@/lib/healing/ruleEngine';

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
function RuleRow({ rule, index, total, onMove, onChange, onRemove, onToggle }) {
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

// ── Main editor ──────────────────────────────────────────────────────────
export function HealingRulesEditor() {
  const dispatch = useDispatch();
  const rules = useSelector(selectHealingRules);

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
    </div>
  );
}

export default HealingRulesEditor;
