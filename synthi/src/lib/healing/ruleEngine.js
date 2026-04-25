// src/lib/healing/ruleEngine.js
// Pure (side-effect-free) routing layer for the self-healing system.
//
// Given a diagnostic + fix + user-authored rules + confidence thresholds,
// returns the *action* to take: auto_apply, suggest, ai_escalate, or ignore.
//
// The UI assembles rules from dropdowns — this module never parses regex
// or error codes.  All matching is category-based, severity-based, or
// a simple glob against the file path.

import { RuleAction, HealingCategory } from '@/redux/healingSlice';

// ── Plain-English target vocabulary ──────────────────────────────────────
// Each "target" in the UI dropdown maps to a set of healing categories
// and/or severities.  Rules can target any subset of these.
export const TargetVocabulary = Object.freeze({
  any_error: {
    label: 'any error',
    severities: ['error'],
  },
  any_warning: {
    label: 'any warning',
    severities: ['warning'],
  },
  any_issue: {
    label: 'any issue',
    severities: ['error', 'warning', 'info', 'hint'],
  },
  missing_imports: {
    label: 'missing imports',
    categories: [
      HealingCategory.MISSING_IMPORT,
      HealingCategory.DUPLICATE_IMPORT,
      HealingCategory.MISSING_INCLUDE,
    ],
  },
  unused_imports: {
    label: 'unused imports',
    categories: [HealingCategory.UNUSED_IMPORT],
  },
  unused_variables: {
    label: 'unused variables',
    categories: [HealingCategory.UNUSED_VARIABLE],
  },
  missing_semicolons: {
    label: 'missing semicolons',
    categories: [HealingCategory.MISSING_SEMICOLON],
  },
  missing_colons: {
    label: 'missing colons',
    categories: [HealingCategory.MISSING_COLON],
  },
  missing_brackets: {
    label: 'missing brackets',
    categories: [HealingCategory.MISSING_BRACKET],
  },
  syntax_errors: {
    label: 'syntax errors',
    categories: [
      HealingCategory.MISSING_SEMICOLON,
      HealingCategory.MISSING_COLON,
      HealingCategory.MISSING_BRACKET,
      HealingCategory.UNCLOSED_STRING,
      HealingCategory.MISMATCHED_QUOTES,
    ],
  },
  type_errors: {
    label: 'type errors',
    categories: [HealingCategory.TYPE_MISMATCH],
  },
  style_warnings: {
    label: 'style warnings',
    categories: [
      HealingCategory.TRAILING_WHITESPACE,
      HealingCategory.MISSING_NEWLINE_EOF,
      HealingCategory.TRAILING_COMMA,
      HealingCategory.NONE_COMPARISON,
    ],
  },
});

// ── Plain-English scope vocabulary ───────────────────────────────────────
export const ScopeVocabulary = Object.freeze({
  any_file:        { label: 'any file',           languages: null },
  javascript_files:{ label: 'JavaScript files',   languages: ['javascript'] },
  typescript_files:{ label: 'TypeScript files',   languages: ['typescript'] },
  python_files:    { label: 'Python files',       languages: ['python'] },
  cpp_files:       { label: 'C/C++ files',        languages: ['c', 'cpp'] },
  java_files:      { label: 'Java files',         languages: ['java'] },
  go_files:        { label: 'Go files',           languages: ['go'] },
  rust_files:      { label: 'Rust files',         languages: ['rust'] },
  glob:            { label: 'files matching…',    languages: null, needsPattern: true },
});

// ── Plain-English action vocabulary ──────────────────────────────────────
export const ActionVocabulary = Object.freeze({
  [RuleAction.AUTO_APPLY]:  { label: 'Always fix',     verb: 'fix'        },
  [RuleAction.SUGGEST]:     { label: 'Suggest a fix',  verb: 'suggest'    },
  [RuleAction.AI_ESCALATE]: { label: 'Ask AI',         verb: 'ask AI about' },
  [RuleAction.IGNORE]:      { label: 'Never touch',    verb: 'ignore'     },
});

// ── Diagnostic → healing category inference ──────────────────────────────
// Mirrors useSelfHealing.js so the rule engine can categorise live
// diagnostics for the rule-editor preview counts without depending on the
// Monaco-integrated fix normaliser.
const DIAG_CATEGORY_TO_HEAL = {
  syntax: 'missing_semicolon',
  missing_semicolon: 'missing_semicolon',
  missing_colon: 'missing_colon',
  missing_bracket: 'missing_bracket',
  missing_paren: 'missing_bracket',
  preprocessor: 'missing_bracket',
  import: 'missing_import',
  unused_import: 'unused_import',
  missing_import: 'missing_import',
  duplicate_import: 'duplicate_import',
  include: 'missing_import',
  whitespace: 'trailing_whitespace',
  trailing_whitespace: 'trailing_whitespace',
  string: 'unclosed_string',
  unclosed_string: 'unclosed_string',
  mismatched_quotes: 'mismatched_quotes',
  trailing_comma: 'trailing_comma',
  logic_error: 'missing_semicolon',
  type_error: 'type_mismatch',
  null_reference: 'none_comparison',
  unused_code: 'unused_import',
};

function inferCategoryFromMessage(msg) {
  if (!msg) return null;
  const m = String(msg).toLowerCase();
  if (m.includes('semicolon'))                             return 'missing_semicolon';
  if (m.includes('missing colon'))                         return 'missing_colon';
  if (m.includes('bracket') || m.includes('brace') || m.includes('paren'))
                                                            return 'missing_bracket';
  if (m.includes('import') && m.includes('unused'))        return 'unused_import';
  if (m.includes('import') || m.includes('include'))       return 'missing_import';
  if (m.includes('whitespace') || m.includes('trailing space'))
                                                            return 'trailing_whitespace';
  if (m.includes('comma'))                                  return 'trailing_comma';
  if (m.includes('quote') || m.includes('string'))         return 'unclosed_string';
  if (m.includes('return'))                                 return 'missing_return';
  return null;
}

/**
 * Best-effort healing category for an arbitrary diagnostic.  Used by the
 * rule-editor live preview to count how many current diagnostics a rule
 * would match, without needing the Monaco fix normaliser.
 */
export function categorizeDiagnostic(diag) {
  if (!diag) return null;
  return (
    DIAG_CATEGORY_TO_HEAL[String(diag.category || '').toLowerCase()] ||
    DIAG_CATEGORY_TO_HEAL[String(diag.code     || '').toLowerCase()] ||
    inferCategoryFromMessage(diag.message) ||
    diag.category ||
    null
  );
}

// ── Glob matcher (simple, no regex) ──────────────────────────────────────
// Supports: *  **  ?  — good enough for "tests/*" or "src/**/*.ts"
function globToRegExp(glob) {
  if (!glob) return null;
  // Escape regex special chars, then replace glob tokens
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§DOUBLESTAR§')
    .replace(/\*/g, '[^/]*')
    .replace(/§DOUBLESTAR§/g, '.*')
    .replace(/\?/g, '[^/]');
  try {
    return new RegExp(`^${escaped}$`, 'i');
  } catch {
    return null;
  }
}

function normalizePath(p) {
  if (!p) return '';
  return String(p).replace(/^[./\\]+/, '').replace(/\\/g, '/');
}

// ── Rule matching ────────────────────────────────────────────────────────

/**
 * Does a rule's `target` match this diagnostic/fix?
 * Target shape:
 *   { kind: 'any' }
 *   { kind: 'target', name: 'missing_imports' }   // looks up TargetVocabulary
 *   { kind: 'category', category: 'missing_semicolon' }
 *   { kind: 'severity', severity: 'error' }
 */
function targetMatches(target, ctx) {
  if (!target) return true;
  const kind = target.kind || 'any';

  if (kind === 'any') return true;

  if (kind === 'category') {
    return ctx.category === target.category;
  }

  if (kind === 'severity') {
    return ctx.severity === target.severity;
  }

  if (kind === 'target') {
    const vocab = TargetVocabulary[target.name];
    if (!vocab) return false;
    const catOk =
      !vocab.categories ||
      (ctx.category && vocab.categories.includes(ctx.category));
    const sevOk =
      !vocab.severities ||
      (ctx.severity && vocab.severities.includes(ctx.severity));
    // A vocab entry may specify either categories OR severities (or both).
    // Match if EITHER side passes when the other is absent; require BOTH
    // when both are present.
    if (vocab.categories && vocab.severities) return catOk && sevOk;
    if (vocab.categories) return catOk;
    if (vocab.severities) return sevOk;
    return false;
  }

  return false;
}

/**
 * Does a rule's `scope` match this file path/language?
 * Scope shape:
 *   { kind: 'any' }
 *   { kind: 'scope', name: 'javascript_files' }   // looks up ScopeVocabulary
 *   { kind: 'language', languages: ['typescript'] }
 *   { kind: 'glob', pattern: 'tests/*' }
 */
function scopeMatches(scope, ctx) {
  if (!scope) return true;
  const kind = scope.kind || 'any';

  if (kind === 'any') return true;

  if (kind === 'language') {
    const langs = Array.isArray(scope.languages) ? scope.languages : [];
    return !!ctx.language && langs.includes(ctx.language);
  }

  if (kind === 'scope') {
    const vocab = ScopeVocabulary[scope.name];
    if (!vocab) return false;
    if (vocab.languages) {
      return !!ctx.language && vocab.languages.includes(ctx.language);
    }
    if (scope.name === 'glob' && scope.pattern) {
      const re = globToRegExp(scope.pattern);
      return !!re && re.test(normalizePath(ctx.filePath));
    }
    return true;
  }

  if (kind === 'glob') {
    const re = globToRegExp(scope.pattern);
    return !!re && re.test(normalizePath(ctx.filePath));
  }

  return false;
}

// ── Fallback policy (no rule matched) ────────────────────────────────────
//
// Uses the effective thresholds (from boldness preset or custom override) to
// decide action based on confidence alone:
//
//   conf >= autoApply   → AUTO_APPLY
//   conf >= suggest     → SUGGEST
//   conf >= aiEscalate  → AI_ESCALATE  (if AI is enabled)
//   else                → IGNORE
//
// Severity filter: by default, only 'error' severity reaches auto-apply.
// Warnings & below are demoted to SUGGEST at best.
function fallbackAction({ confidence, severity }, thresholds, aiEnabled) {
  const conf = typeof confidence === 'number' ? confidence : 0;
  const sev = severity || 'error';

  if (conf >= thresholds.autoApply) {
    // Safety: never silently auto-fix non-error severities in fallback.
    return sev === 'error' ? RuleAction.AUTO_APPLY : RuleAction.SUGGEST;
  }
  if (conf >= thresholds.suggest) return RuleAction.SUGGEST;
  if (aiEnabled && typeof thresholds.aiEscalate === 'number' && conf >= thresholds.aiEscalate) {
    return RuleAction.AI_ESCALATE;
  }
  return RuleAction.IGNORE;
}

/**
 * Does this rule's target + scope match a given (diagnostic-like) context?
 * Used by the rule-editor live preview to count how many current diagnostics
 * a rule would touch.  Confidence is treated as "any" here — a rule's
 * preview count is about its *intent*, not what the confidence bands would
 * filter later.
 */
export function ruleMatches(rule, ctx) {
  if (!rule || rule.disabled) return false;
  if (!targetMatches(rule.target, ctx)) return false;
  if (!scopeMatches(rule.scope, ctx)) return false;
  if (typeof rule.minConfidence === 'number' &&
      typeof ctx.confidence === 'number' &&
      ctx.confidence < rule.minConfidence) {
    return false;
  }
  return true;
}

// ── Main entry point ─────────────────────────────────────────────────────

/**
 * Evaluate a fix against the rule list and thresholds.
 *
 * @param {Object} args
 * @param {Object} args.fix          – normalized healing fix (category, confidence, ...)
 * @param {Object} args.diagnostic   – source diagnostic (severity, code, message, ...)
 * @param {Array}  args.rules        – user-authored rule list
 * @param {Object} args.thresholds   – { autoApply, suggest, aiEscalate }
 * @param {string} args.filePath
 * @param {string} args.language
 * @param {boolean} args.aiEnabled   – whether AI escalation is available
 *
 * @returns {{ action: string, reason: string, rule?: Object }}
 */
export function evaluateFix({
  fix,
  diagnostic,
  rules,
  thresholds,
  filePath,
  language,
  aiEnabled,
}) {
  const ctx = {
    category: fix?.category || diagnostic?.category || null,
    severity: (diagnostic?.severity || fix?.severity || 'error').toLowerCase(),
    confidence: typeof fix?.confidence === 'number'
      ? fix.confidence
      : (typeof diagnostic?.confidence === 'number' ? diagnostic.confidence : 0),
    filePath: filePath || fix?.filePath || diagnostic?.filePath || '',
    language: language || 'plaintext',
  };

  // 1. User rules — first match wins
  for (const rule of rules || []) {
    if (!rule || rule.disabled) continue;
    if (!rule.action) continue;
    if (!targetMatches(rule.target, ctx)) continue;
    if (!scopeMatches(rule.scope, ctx)) continue;

    // minConfidence on the rule itself (optional)
    if (typeof rule.minConfidence === 'number' && ctx.confidence < rule.minConfidence) {
      continue;
    }

    return {
      action: rule.action,
      reason: `rule "${ruleToSentence(rule)}"`,
      rule,
    };
  }

  // 2. Fallback: confidence-based routing from boldness thresholds
  const action = fallbackAction(ctx, thresholds, aiEnabled);
  return {
    action,
    reason: `confidence ${ctx.confidence.toFixed(2)} / ${ctx.severity} → ${action}`,
  };
}

// ── Human-readable rule serialiser (for logs and list display) ───────────

export function ruleToSentence(rule) {
  if (!rule) return '';
  const act = ActionVocabulary[rule.action]?.label || rule.action || '?';

  let targetStr = 'any issue';
  if (rule.target) {
    if (rule.target.kind === 'target' && TargetVocabulary[rule.target.name]) {
      targetStr = TargetVocabulary[rule.target.name].label;
    } else if (rule.target.kind === 'category') {
      targetStr = rule.target.category?.replace(/_/g, ' ') || 'any issue';
    } else if (rule.target.kind === 'severity') {
      targetStr = `any ${rule.target.severity}`;
    }
  }

  let scopeStr = 'any file';
  if (rule.scope) {
    if (rule.scope.kind === 'scope' && ScopeVocabulary[rule.scope.name]) {
      scopeStr = ScopeVocabulary[rule.scope.name].label;
      if (rule.scope.name === 'glob' && rule.scope.pattern) {
        scopeStr = `files matching "${rule.scope.pattern}"`;
      }
    } else if (rule.scope.kind === 'glob' && rule.scope.pattern) {
      scopeStr = `files matching "${rule.scope.pattern}"`;
    } else if (rule.scope.kind === 'language') {
      scopeStr = `${(rule.scope.languages || []).join('/')} files`;
    }
  }

  return `${act} ${targetStr} in ${scopeStr}.`;
}

// ── Rule construction helpers (used by UI) ───────────────────────────────

let _ruleIdCounter = 0;
export function makeRuleId() {
  _ruleIdCounter += 1;
  return `rule-${Date.now()}-${_ruleIdCounter.toString(36)}`;
}

export function createRule({ action, targetName, scopeName, globPattern }) {
  return {
    id: makeRuleId(),
    action: action || RuleAction.AUTO_APPLY,
    target: { kind: 'target', name: targetName || 'any_issue' },
    scope: scopeName === 'glob'
      ? { kind: 'glob', pattern: globPattern || '*' }
      : { kind: 'scope', name: scopeName || 'any_file' },
    disabled: false,
  };
}
