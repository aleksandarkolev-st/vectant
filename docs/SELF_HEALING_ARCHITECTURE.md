# Targeted Auto-Fix System — Technical Reference

> **Naming note.** This document avoids the term "self-healing."
> The system **auto-suggests and, where safe, auto-applies targeted fixes**
> for a narrow class of syntactic and stylistic issues. It does not
> repair arbitrary program defects. The marketing label "self-healing"
> overstates what regex-based heuristic rules can guarantee.

---

## 1. What "small code issues" means — concrete scope

The system targets issues that meet **all** of these criteria:

1. Affect **≤ 3 lines** of source code.
2. **Never change program logic** — only syntax, formatting, or provably-dead code.
3. Can be detected by **pattern matching** (regex + simple counting), not full semantic analysis.
4. Have a **deterministic, unambiguous fix** (one correct resolution, not a choice).

### Five concrete examples

| # | Before | After | Rule ID | What happens |
|---|--------|-------|---------|--------------|
| 1 | `def foo(x)∙∙∙\n` (trailing spaces) | `def foo(x)\n` | UNI_HEAL_001 | Regex `\s+$` detects trailing whitespace. `HealingAction.DELETE` removes the matched range. Confidence: **1.0** (deterministic). |
| 2 | `import os` (never used in file) | *(line deleted)* | UNI_IMP_001 | Extracts all `import`/`from…import` symbols via regex. Scans rest of file for each symbol as a whole word (`\bos\b`). If zero occurrences → suggest deletion. Confidence: **0.92** (regex word-boundary match can false-positive on substrings in comments). |
| 3 | `if x == None:` | `if x is None:` | UNI_CMP_001 | Regex `==\s*None` / `!=\s*None`. Replaces with `is None` / `is not None`. Only fires in Python. Confidence: **0.95** (PEP 8 mandates `is`; false-positive if inside a string — guarded by `_is_in_string_or_comment`). |
| 4 | `def foo(x)` (missing colon, Python) | `def foo(x):` | UNI_TERM_001 | Checks if line matches `^\s*(def\|class\|if\|for\|while)…` but doesn't end with `:`. Inserts `:` at EOL. Confidence: **0.90** (could misfire on multi-line signatures). |
| 5 | `console.log(arr[0)` (mismatched bracket) | `console.log(arr[0])` | UNI_BRK_001 | Stack-based bracket matcher that skips strings/comments. When stack has unmatched `[` at EOF, inserts `]` at the last open position. Confidence: **0.85** (correct bracket vs. missing bracket elsewhere is ambiguous). |

### What the system explicitly does NOT do

- Rename variables or fix typos in identifiers (too ambiguous).
- Add missing function arguments or change function signatures.
- Restructure code, move blocks, or refactor.
- Fix runtime errors, type mismatches, or business logic bugs.
- Anything requiring knowledge of the full project dependency graph.

---

## 2. Detection mechanism — regex, not AST

**Every rule uses regex and line-by-line string scanning.** There is no AST
parser, no language server protocol integration, and no tree-sitter grammar
in the current implementation.

### How "universal" rules actually work

Each rule function receives `(code: str, language: str, file_path: str)`.
Inside the function, language dispatch looks like:

```python
_PY = {"python", "py"}
_JS = {"javascript", "js", "jsx", "typescript", "ts", "tsx"}

@healing_rule(rule_id="UNI_IMP_001", languages={"*"}, ...)
def detect_unused_imports(code, language, file_path):
    lang = language.lower()
    if lang in _PY:
        imports = _extract_python_imports(code)   # regex-based
    elif lang in _JS:
        imports = _extract_js_imports(code)        # regex-based
    else:
        return []   # unsupported language → no fixes
    ...
```

**Honest limitations of this approach:**

| Strength | Weakness |
|----------|----------|
| Fast (< 5ms per rule, no parser startup) | Cannot understand scope, nesting, or control flow |
| No external dependencies | String/comment detection is heuristic (character-walk, not tokenizer) |
| Easy to add new patterns | Multi-line constructs (template literals, heredocs) can fool regexes |
| Language-agnostic framework | "Universal" is aspirational — most rules only fire for 2–4 languages and return `[]` for the rest |

**Where this breaks:**

- Python triple-quoted strings containing code-like text → false positives.
- JavaScript template literals with `${...}` expressions → bracket matcher
  may miscount.
- Languages with unusual comment syntax (Haskell `{- -}`, Lua `--[[ ]]`) →
  not handled, rules return empty.

### Why not AST?

AST parsing (tree-sitter, Babel, etc.) would be more correct but adds:
- Parser binaries per language (deployment complexity).
- 10–100× latency increase for the parse step.
- Memory overhead for syntax trees.

The current system is a **linter-lite with auto-apply**, not a compiler-grade
analyzer. This is an intentional trade-off for speed and simplicity.

---

## 3. Safety classifier — what each tier actually blocks

The `HealingClassifier` runs every proposed fix through a gate with **four
layers**. All four must pass for a fix to be auto-applied.

### Tier 1: Category-level allow/block list

| Tier | Categories | Rationale |
|------|-----------|-----------|
| **ALWAYS_SAFE** | `trailing_whitespace`, `missing_newline_eof`, `trailing_comma`, `duplicate_import` | Cannot change runtime behavior in any language. Trailing whitespace is invisible; duplicate imports are redundant by definition. |
| **CONDITIONALLY_SAFE** | `missing_colon`, `missing_semicolon`, `missing_bracket`, `missing_paren`, `unused_import`, `missing_import`, `unclosed_string`, `mismatched_quotes`, `comparison_to_none` | Could be safe, but depends on context. Example: removing `import logging` that *looks* unused but triggers module-level side effects. Proceeds to Tier 2. |
| **NEVER_AUTO** | `undeclared_variable`, `typo_in_identifier`, `missing_return_type`, `obvious_type_mismatch`, `equality_vs_assignment`, `import_order`, `inconsistent_indentation` | Either changes semantics (indentation in Python) or involves guessing user intent (which variable did they mean?). Always shown as manual-only suggestions. |

### Tier 2: Context analysis (CONDITIONALLY_SAFE only)

For each conditionally-safe category, a specific check runs:

- **Missing colon**: safe only if line matches `^\s*(def|class|if|elif|for|while|try|except|finally|with|async)\s` in Python.
- **Missing semicolon**: safe only in C-style languages, not inside `for(;;)` headers, not after `{` or `}`.
- **Missing bracket**: safe only if fix is `INSERT` of a single closing character `)`, `]`, or `}`.
- **Unused import**: safe only if fix is `DELETE` and the import is not a wildcard (`*`) and the module is not in the known side-effect set (`logging`, `warnings`, `django`, `flask`, etc.).
- **Missing import**: safe only if fix is `INSERT` and confidence ≥ 0.95.
- **Unclosed/mismatched string**: safe only if start and end are on the same line.

### Tier 3: Global overrides (always checked, even after Tier 1/2 pass)

1. **Confidence floor**: `fix.confidence < min_confidence` → blocked. Default: **0.90**.
2. **Line span limit**: `abs(end_line - line) + 1 > 3` → blocked. A fix touching 4+ lines is too risky.
3. **String/comment guard**: if fix location falls inside a string literal or comment (detected by character-walk heuristic) → blocked.

### Tier 4: Engine-level caps

- **Max fixes per pass**: 5 (default). Excess sorted to `skipped_issues`.
- **Cooldown**: 1000ms between passes on the same file.
- **Dedup**: fixes at the same `(line, col, end_line, end_col, action)` are collapsed; first-in wins.

---

## 4. What "confidence" actually means

**The confidence value is a hand-tuned heuristic, not a calibrated probability.**

Each rule author assigns a static confidence value when constructing a `HealingFix`:

```python
HealingFix(confidence=0.92, ...)   # ← author's subjective estimate
```

| Value | Meaning in practice |
|-------|-------------------|
| **1.0** | Deterministic, zero chance of false positive. Example: trailing whitespace (`\s+$` at EOL). |
| **0.90–0.99** | High confidence but edge cases exist. Example: unused import detection (could miss re-exports, side-effect modules). |
| **0.80–0.89** | Moderate confidence. Example: bracket mismatch repair (ambiguous where the missing bracket belongs). |
| **< 0.80** | Low confidence, should not auto-apply. |

**This is not calibrated.** A confidence of 0.92 does not mean "92% of fixes
with this score are correct." It means "the rule author thought this was pretty
reliable." There is no holdout test set, no precision/recall measurement, and
no ongoing calibration pipeline.

**Planned improvements:**
1. Log all auto-applied fixes and track revert rate → compute empirical precision per rule.
2. Use revert rate to re-calibrate confidence values quarterly.
3. Until calibrated, the frontend should display "high / medium / low confidence" labels, not numbers.

---

## 5. Conflict handling — overlapping edits

### Current behavior

1. **Deduplication** (`_deduplicate_fixes`): exact-match `(line, col, end_line, end_col, action)` → first wins.
2. **Severity sort**: `CRITICAL > MODERATE > LOW` before application.
3. **Reverse-order application**: safe fixes applied bottom-to-top to preserve line numbers.

### Known gap: partial overlaps are NOT detected

If Rule A replaces lines 5–7 and Rule B replaces lines 6–8, **both may be
applied**, producing corrupted output. The dedup key only catches exact-match
ranges, not overlapping ranges.

**Mitigation in practice**: `max_fixes_per_pass=5` and `max_affected_lines=3`
keep blast radius small. Different rule categories target different code
regions, so conflicts are rare. But this is defense-by-luck, not design.

### Conflict resolution (added in engine)

The engine now includes an `_resolve_conflicts` step that:
1. Sorts proposed fixes by `(line, column)`.
2. Walks the sorted list and checks if `fix[i].end_line >= fix[i+1].line`.
3. On overlap, keeps the fix with higher severity (or higher confidence as tiebreaker) and drops the other.
4. Dropped fixes are recorded in `skipped_issues` with reason `"conflict_overlap"`.

---

## 6. Performance characteristics and SLOs

### Estimated values (code-inspection, not benchmarked under load)

| Metric | Estimate | Basis |
|--------|----------|-------|
| p50 analysis latency | ~12ms / file | 38 rules × ~0.3ms each (single regex pass) |
| p95 analysis latency | < 50ms / file | Large files (5k+ lines) with many matches |
| Max throughput | ~20 files/sec | Single-threaded Python; GIL-bound |
| Cache hit rate (warm) | > 80% | SHA-256 content hash; any edit = miss |
| Memory base | ~50MB | Python process + compiled regexes + registry |
| Memory per cached result | ~0.2KB | Fix metadata only, no source code stored |

### Target SLOs (to be validated)

| SLO | Target | Enforcement |
|-----|--------|-------------|
| Analysis p95 | ≤ 100ms | Per-rule timeout (10ms); skip on timeout |
| Fix application p99 | ≤ 5ms | String splice only |
| Cache hit rate (warm) | ≥ 70% | Monitor via `/heal/cache/stats` |
| False-positive rate | ≤ 5% / rule | Requires revert-rate tracking (not yet implemented) |
| Memory per 1k cached files | ≤ 500KB | LRU cap: 256 entries |

### Known gaps

- **No per-rule timeout.** Catastrophic regex backtracking can block indefinitely.
- **Batch engine is async but single-threaded.** No `ProcessPoolExecutor`.
- **No latency percentile tracking in production yet.** `metrics_export.py` exists but is not wired to a collector.

---

## 7. Test coverage — honest assessment

| Test file | Tests | What's covered |
|-----------|-------|---------------|
| `test_rule_registry.py` | 7 | Singleton, registration, enable/disable, universal flag, ID uniqueness |
| `test_universal_rules.py` | 15 | ~10 rules tested across Python/JS, language isolation |
| `test_engine.py` | 12 | Analyze, fix application (INSERT/REPLACE/DELETE), config, cache, events, classifier |
| `test_cache.py` | 10 | LRU eviction, TTL, invalidation, hit/miss, stats, thread safety |
| `test_batch_engine.py` | 9 | Empty/single/multi batch, oversize skip, priority, cancel, progress |
| `test_integration_healing.py` | 13 | E2E pipeline: Python/JS/Go, empty files, binary, 20k lines, presets |
| **Total** | **66** | |

### Coverage gaps

| Area | Coverage | Notes |
|------|----------|-------|
| Engine + infrastructure | ~70% (estimated) | Core paths well-tested |
| Individual rule logic | ~10–15% | ~10 of 100+ rules have dedicated tests |
| Gateway WebSocket | 0% | All 11 forwarding functions untested |
| Frontend hooks/components | 0% | No Jest/RTL setup |
| Conflict/overlap | 0% | No test for overlapping edits |
| Per-language rule coverage | Low | Most rules tested only with Python/JS |

**Overall effective coverage: ~20–25%.** This is underpowered.

---

## 8. Architecture diagram

```
User types in Monaco Editor
         │
         ▼ (debounce 800ms)
useSelfHealing hook → content hash check (skip if unchanged)
         │
         ▼ WebSocket
analyzerGatewayClient.healAnalyze({ code, language, filePath })
         │
         ▼
Gateway (Node.js :7070) → HTTP POST to AI Engine
         │
         ▼
SelfHealingEngine.analyze()
  ├── cache lookup (SHA-256 hash) → hit? return cached result
  ├── cooldown check → on cooldown? return empty result
  ├── for each of 38 rule modules:
  │     rule.detect(code, language, filePath) → List[HealingFix]
  │     (regex matching, no AST)
  ├── HealingClassifier.classify_fixes()
  │     Tier 1: category allow/block
  │     Tier 2: context analysis
  │     Tier 3: confidence floor + line span + string/comment guard
  ├── _resolve_conflicts() → drop overlapping lower-priority fixes
  ├── _deduplicate_fixes() → exact-match dedup
  ├── sort by severity, cap at max_fixes_per_pass
  └── cache result, return HealingResult
         │
         ▼ WebSocket response
Frontend receives HealingResult
  ├── safe fixes (is_safe=true, confidence ≥ threshold)
  │     → auto-applied bottom-to-top
  │     → toast notification, green Monaco decoration
  └── unsafe fixes
       → shown in HealingPendingPanel for manual review
       → yellow Monaco decoration
```

---

## 9. API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/heal/analyze` | Analyze single file |
| POST | `/heal/apply` | Apply specific fix IDs |
| POST | `/heal/batch` | Analyze multiple files |
| POST | `/heal/container` | Analyze from container FS |
| GET | `/heal/config` | Get engine config |
| POST | `/heal/config` | Update engine config |
| GET | `/heal/presets` | List preset configs |
| POST | `/heal/preset` | Apply named preset |
| GET | `/heal/stats` | Runtime statistics |
| GET | `/heal/rules` | List registered rules |
| GET | `/heal/cache/stats` | Cache performance |
| GET | `/heal/metrics` | Prometheus metrics |
