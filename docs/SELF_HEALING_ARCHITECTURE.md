# AI-Assisted Deterministic Code Repair Engine — Technical Reference

> **Positioning.** This system is an **AI-assisted deterministic code repair
> engine with safety gating**. It auto-suggests and, where safe, auto-applies
> targeted fixes for a narrow class of syntactic, stylistic, and semantic
> issues. It does not repair arbitrary program defects at runtime.
>
> Comparable to: Cursor auto-fix, Copilot "fix this", automated code review
> assistants. Not comparable to: runtime self-healing, chaos engineering,
> or autonomic computing.
>
> The system has two detection modes:
> 1. **Regex layer** — fast (< 50ms), deterministic, limited to syntax/style.
> 2. **AI layer** — deliberate (3–8s), LLM-powered, catches semantic bugs.
>
> These are fundamentally different UX interactions and **must not be mixed**.
> Regex = instant feedback. AI = deliberate inspection.

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

### ⚠ Two fundamentally different performance profiles

**Regex and AI have different latency by orders of magnitude.
Their UX semantics must not be mixed.**

- **Regex** = instant feedback, runs on every keystroke/save, results appear inline
  before the user's eyes leave the editor.
- **AI** = deliberate inspection, user-triggered or on-save, results appear after
  a visible loading state. The user expects to wait.

Mixing these into a single "analyzing…" spinner that sometimes takes 12ms and
sometimes 8s will feel broken. The frontend must treat them as separate modes
with separate UX affordances.

### Regex layer — estimated values

| Metric | Estimate | Basis |
|--------|----------|-------|
| p50 analysis latency | ~12ms / file | 38 rules × ~0.3ms each (single regex pass) |
| p95 analysis latency | < 50ms / file | Large files (5k+ lines) with many matches |
| Max throughput | ~20 files/sec | Single-threaded Python; GIL-bound |
| Cache hit rate (warm) | > 80% | SHA-256 content hash; any edit = miss |
| Memory base | ~50MB | Python process + compiled regexes + registry |
| Memory per cached result | ~0.2KB | Fix metadata only, no source code stored |

### AI layer — realistic expectations

| Metric | Realistic range | Basis |
|--------|----------------|-------|
| p50 analysis latency | 3–5s | Gemini Flash Lite round-trip + JSON parse |
| p95 analysis latency | 5–8s | Network variance + large context windows |
| p99 with validation pass | 8–15s | 2× LLM calls + semaphore queuing |
| Timeout ceiling | 30s | `asyncio.wait_for` hard cap |
| SSE first-fix latency | 2–4s | Streaming reduces perceived wait |
| Prompt cache hit | < 2s | SHA-256 cache bypass skips LLM entirely |
| Batch (5 files) | 10–20s | Single LLM call but larger prompt |

**AI p95 will not be < 2s.** It will be 3–8s depending on model load,
context size, and whether validation is enabled. This is inherent to
LLM round-trips and cannot be optimized away without model changes.

### Regex SLOs (plausible, achievable)

| SLO | Target | Enforcement |
|-----|--------|-------------|
| Analysis p95 | ≤ 100ms | Per-rule timeout (10ms); skip on timeout |
| Fix application p99 | ≤ 5ms | String splice only |
| Cache hit rate (warm) | ≥ 70% | Monitor via `/heal/cache/stats` |
| False-positive rate | ≤ 5% / rule | Requires revert-rate tracking (not yet implemented) |
| Memory per 1k cached files | ≤ 500KB | LRU cap: 256 entries |

### AI SLOs (aspirational, not yet validated)

| SLO | Target | Status |
|-----|--------|--------|
| Analysis p50 | ≤ 5s | Plausible with cache + Flash Lite |
| Analysis p95 | ≤ 10s | Requires monitoring to validate |
| SSE first-event | ≤ 3s | Depends on LLM streaming support |
| Validation p95 | ≤ 8s | Bounded by semaphore concurrency (3) |
| False-positive rate | ≤ 10% | Requires empirical measurement |

### Known gaps

- **No per-rule timeout for regex.** Catastrophic backtracking can block indefinitely.
- **Batch engine is async but single-threaded.** No `ProcessPoolExecutor`.
- **No latency percentile tracking in production yet.** `metrics_export.py` exists but is not wired to a collector.
- **No formal SLA monitoring.** Telemetry exists but isn't hooked to alerting.
- **AI latency is model-dependent.** Switching from Flash Lite to a larger model will change all numbers.

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
| `test_ai_policy.py` | 14 | Per-user suppression: suppress/unsuppress, escalation, TTL, persistence |
| `aiSuppressedRules.test.js` | 25+ | Fingerprinting, filterFixes contract, immutability, ordering, isEscalated, count getter |
| **Total** | **~105** | |

### Coverage gaps

| Area | Coverage | Notes |
|------|----------|-------|
| Engine + infrastructure | ~70% (estimated) | Core paths well-tested |
| Individual rule logic | ~10–15% | ~10 of 100+ rules have dedicated tests |
| Gateway WebSocket | 0% | All 11+ forwarding functions untested |
| Frontend hooks/components | 0% | No Jest/RTL setup |
| Conflict/overlap | 0% | No test for overlapping edits |
| Per-language rule coverage | Low | Most rules tested only with Python/JS |
| AI parser robustness | 0% | No fuzz testing of malformed LLM output |
| Streaming interruption | 0% | No test for partial SSE delivery |
| Adversarial prompts | 0% | No test for prompt injection / garbage input |
| Rollback scenarios | 0% | No test for undo/revert after failed apply |
| Suppression offline resilience | Partial | Pending ops queue tested locally, not E2E |

**Overall effective coverage: ~20–25%.** This is underpowered.

### Pre-production test requirements

Before this system can be considered production-grade, the following fuzz/stress
tests must exist:

| Category | What to fuzz | Expected behavior |
|----------|-------------|-------------------|
| **Malformed JSON responses** | LLM returns truncated JSON, extra commas, wrong types, missing fields, nested markdown fences, empty string, null | Parser returns `[]` (no fixes), never crashes |
| **Partial streaming interruptions** | SSE connection drops mid-event, server sends partial JSON chunk, timeout after 2 of 5 fixes | Client receives whatever fixes arrived, shows error for remainder, no UI hang |
| **Conflicting overlapping fixes** | Rule A replaces lines 5–7, Rule B replaces lines 6–8, Rule C inserts at line 7 | Conflict resolver keeps highest-severity, drops others to `skipped_issues` |
| **Adversarial prompt injection** | Code contains strings like `"ignore previous instructions"`, embedded JSON that mimics fix format | Parser validates against source lines, rejects fabricated fixes |
| **Rollback after partial apply** | 3 of 5 fixes applied, 4th fails (line no longer exists) | First 3 remain applied, 4th and 5th skipped, undo stack contains all 3 |
| **Concurrent analysis** | Two analyses on same file finish simultaneously | Dedup prevents double-apply, later result wins or is discarded |
| **Cache poisoning** | Cached result for old code served after edit | Content-hash key prevents this, but test must verify |
| **Backend scoping** | Two users suppress same rule in different workspaces | Policies are isolated, no cross-contamination |

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
| POST | `/heal/ai/analyze` | AI single-file detection |
| POST | `/heal/ai/batch` | AI multi-file detection |
| POST | `/heal/ai/hybrid` | Merged regex + AI detection |
| GET  | `/heal/ai/stats` | AI agent statistics |
| POST | `/heal/ai/stream` | SSE-streamed AI analysis |
| POST | `/heal/ai/feedback` | Submit user feedback |
| GET  | `/heal/ai/memory` | View learned patterns |
| DELETE | `/heal/ai/memory` | Clear learned patterns |

---

## 10. AI Agent Layer (Agentic Detection)

### 10.1 Why LLM detection?

Regex rules are fast and deterministic, but fundamentally limited:
- They cannot understand scope, control flow, or type semantics.
- They miss real bugs: logic errors, null-safety violations, missing awaits,
  off-by-one errors, resource leaks, API misuse.
- Their confidence is pattern-based, not meaning-based.

The AI agent layer sends code to a Gemini LLM with structured prompts and
parses the response into the same `HealingFix` objects that the regex system
produces. This means the safety classifier, conflict resolver, and UI all
work unchanged.

### 10.2 Architecture

```
User code
  │
  ├── ai_context.py   ← Collect imports, related files, project hints
  │     └── AnalysisContext (imports, related_files, project_hints, focus)
  │
  ├── ai_prompts.py   ← Build structured LLM prompts
  │     ├── DETECT_ERRORS_PROMPT (single file)
  │     ├── DETECT_ERRORS_WITH_CONTEXT_PROMPT (multi-file)
  │     ├── VALIDATE_FIX_PROMPT (second opinion)
  │     └── BATCH_DETECT_PROMPT (multiple files)
  │
  ├── ai_agent.py     ← Core agentic loop
  │     ├── detect()       → detect → parse → calibrate → validate → propose
  │     ├── detect_batch() → multi-file in one LLM call
  │     ├── _validate_fixes()  → second LLM pass (bounded concurrency)
  │     └── _calibrate_confidence() → discount + memory + severity
  │
  ├── ai_parser.py    ← Parse noisy LLM output into HealingFix
  │     ├── _extract_json_from_text()
  │     ├── _fix_json_quirks()
  │     ├── parse_detection_response()
  │     ├── parse_validation_response()
  │     └── parse_batch_response()
  │
  ├── ai_memory.py    ← Learn from user feedback
  │     ├── record_feedback() → update per-rule acceptance stats
  │     ├── get_confidence_adjustment() → 0.5–1.5x multiplier
  │     └── is_suppressed() → auto-suppress after 3 rejections
  │
  └── ai_streaming.py ← SSE events for long-running analysis
        └── stream_ai_analysis() → AsyncIterator[SSE events]
```

### 10.3 Detection pipeline (single file)

1. **Context collection** (`ai_context.py`):
   - Extract imports via regex per language
   - Find related files (same directory, test pair)
   - Detect project framework (package.json, Cargo.toml, etc.)
   - Apply token budget: 8K per related file, 40K total

2. **Prompt construction** (`ai_prompts.py`):
   - System prompt: senior code reviewer persona
   - User prompt: numbered source lines + context + output schema
   - Required output: JSON array with line, original, replacement, description,
     category, severity, confidence

3. **LLM call** (`ai_agent.py → _call_llm()`):
   - Uses existing `ask_llm()` infrastructure (Gemini 2.5 Flash Lite)
   - 30-second timeout via `asyncio.wait_for`
   - No retries (fail-fast design)

4. **Response parsing** (`ai_parser.py`):
   - Handle markdown fences, preamble text, trailing commas
   - Validate line numbers against source (fuzzy ±3 lines)
   - Skip no-op fixes (original == replacement)
   - Map categories/severities, assign `rule_id = AI_{CATEGORY}`

5. **Confidence calibration** (`ai_agent.py → _calibrate_confidence()`):
   - Base discount: 0.85× (LLM over-confidence correction)
   - Memory adjustment: 0.5×–1.5× based on acceptance rate
   - Severity boost: 1.1× for critical issues
   - Suppressed pattern filter: skip entirely if auto-suppressed

6. **Validation** (optional, `_validate_fixes()`):
   - Second LLM call per fix: "is this fix correct?"
   - Bounded concurrency: semaphore = 3
   - Blended confidence: `original × 0.6 + validation × 0.4`
   - Fixes rejected by validation are dropped

7. **Safety classification** (existing `HealingClassifier`):
   - All AI fixes enter as `is_safe = False`
   - Classifier decides based on category, confidence, context
   - Auto-accept threshold: confidence ≥ 0.92

### 10.4 Error categories detected by AI

| Category | Example |
|----------|---------|
| `logic_error` | `if x > 0 and x > 0` (duplicate condition) |
| `null_safety` | `user.name.length` without null check |
| `type_mismatch` | Passing string where number expected |
| `missing_await` | `const data = fetchData()` (missing await) |
| `resource_leak` | File handle opened but never closed |
| `api_misuse` | Wrong argument order in API call |
| `off_by_one` | `for i in range(len(arr) + 1)` |
| `error_handling` | Empty catch block swallowing errors |
| `variable_misuse` | Using wrong variable (`width` vs `height`) |
| `security` | SQL injection, path traversal |
| `concurrency` | Race condition, missing lock |

### 10.5 Memory / feedback loop

The agent learns from user feedback:

- **Accepted** → increment accept count for that rule_id
- **Rejected** → increment reject count
- **Modified** → user edited the suggestion (counts as partial accept)
- **Auto-suppression**: 3 rejections with 0 accepts → pattern suppressed
- **Un-suppression**: acceptance_rate climbs back above 0.3 → un-suppressed
- **Persistence**: JSON file, max 1000 history entries

### 10.6 Hybrid mode

When `mode = "hybrid"`, both regex rules and AI run on the same file.
Results are merged with AI taking priority at overlapping line ranges.
This gives:
- **Speed**: regex catches obvious issues instantly
- **Depth**: AI catches semantic bugs that regex can't see
- **Conflict resolution**: same as regex-only (sort by position, keep higher severity)

### 10.7 Frontend integration

| Layer | AI additions |
|-------|-------------|
| **Client** (`analyzerGatewayClient.js`) | `aiAnalyze()`, `aiBatch()`, `aiHybrid()`, `aiStats()`, `aiFeedback()`, `aiMemory()`, `aiMemoryClear()` |
| **Hooks** (`useAnalyzerGateway.js`) | Same 7 methods, with input validation |
| **AI Hook** (`useAIHealing.js`) | `analyze()`, `applyFix()`, `applyAllSafe()`, `dismissFix()`, `sendFeedback()`, `fetchMemory()`, auto-analyze on save |
| **Keyboard** (`useAIHealingKeyboard.js`) | Ctrl+Shift+I (analyze), Y (apply safe), N (dismiss), M (toggle mode) |
| **Redux** (`healingSlice.js`) | `ai` sub-state: enabled, mode, isAnalyzing, pendingFixes, stats, error |
| **Selectors** (`healingSelectors.js`) | `selectAIState`, `selectAIMode`, `selectAIEnabled`, `selectAIFixes`, `selectAISummary` |
| **Components** | `AIFixCard`, `AIHealingPanel`, `AIStatsPanel` |

### 10.8 Honest limitations of the AI agent

| Strength | Weakness |
|----------|----------|
| Catches real semantic bugs | 2–10× slower than regex (LLM round-trip) |
| Language-agnostic (LLM handles any language) | Requires API key and network access |
| Learns from feedback | Can hallucinate fixes for correct code |
| Context-aware (imports, related files) | Token budget limits context window |
| Validation pass reduces false positives | Costs 2× LLM calls when enabled |
| Works alongside regex in hybrid mode | No offline fallback (regex-only if LLM unavailable) |

---

## 11. Infrastructure modules (commits 148–185)

### 11.1 Dependency graph (`ai_deps.py`)

Parses `import`/`require`/`use` statements for JS/TS, Python, and Rust.
Builds an in-memory directed graph of file→file dependencies.

- `DependencyGraph.add_file(path, code)` — parse imports, track edges
- `DependencyGraph.dependents_of(path)` — who imports this file?
- `DependencyGraph.transitive_dependents(path, max_depth=3)` — transitive closure
- Singleton per workspace root via `get_dependency_graph(root)`

Used by `/heal/ai/project` endpoint to analyze a changed file and all its importers.

### 11.2 Fix utilities (`ai_fix_utils.py`)

Stateless helper functions for manipulating lists of `HealingFix` objects:

- `deduplicate_fixes(fixes)` — keep higher-confidence when same line + category
- `merge_fix_lists(*lists)` — combine + deduplicate across sources
- `group_by_file()`, `group_by_severity()` — dict grouping
- `sort_by_severity()`, `sort_by_line()` — ordering
- `safe_fixes()`, `unsafe_fixes()` — partition by `is_safe`
- `fixes_summary(fixes)` — human-readable one-liner

Wired into `engine.analyze_hybrid()` for automatic dedup after merging regex + AI.

### 11.3 Telemetry (`ai_telemetry.py`)

Lightweight observability for the AI pipeline:

- `TimingBucket` — min/max/avg/count for named operations
- `ErrorCounter` — error counts by type
- `AITelemetry.timer(name)` — context manager for timing blocks
- `AITelemetry.snapshot()` — JSON-serializable summary
- Exposed in `/heal/ai/stats` response under `telemetry` key

### 11.4 Prompt cache (`ai_prompt_cache.py`)

LRU cache (max 64 entries, TTL 120s) keyed on `SHA-256(code + lang + focus_range)`.
Skips the LLM call entirely when the same code is analyzed twice in quick succession.

- Cache hits tracked in telemetry as `cache_hits` counter
- Stats exposed in `/heal/ai/stats` under `prompt_cache` key
- Clearable via `POST /heal/ai/cache/clear`

### 11.5 Fix history (`aiFixHistory.js`, client-side)

Session-scoped audit log of all fix actions:

- `record({ fix, action, filePath })` — append entry (applied/dismissed/modified)
- `entries()`, `forFile()`, `forAction()` — query
- `stats()` — applied/dismissed/modified counts
- Max 200 entries, sessionStorage persistence
- Rendered by `AIActivityTimeline` component

### 11.6 Streaming (`ai_streaming.py`)

SSE-based progressive delivery of analysis results:

- Phase 1: context collection (10–20%)
- Phase 2: LLM detection (30–70%)
- Phase 3: emit individual `partial_fix` events
- Phase 4: `complete` event with full results
- Error events at any phase without crashing the stream

### 11.7 Preview endpoint (`POST /heal/ai/preview`)

Dry-run mode: analyzes code and simulates applying all safe fixes
without modifying anything. Returns `previewCode` (the result) alongside
the fix list. Used by `AIDiffPreview` component.

### 11.8 Rate limiter & retry (`ai_rate_limiter.py`, `ai_retry.py`)

- **Token bucket**: 10 requests / 60 seconds, 15s wait timeout
- **Exponential backoff**: 2 retries, 1s base, 8s max, ±50% jitter
- Both wired into `_call_llm()` in the agent

---

## 12. Monaco editor integration (commits 135–170)

| Module | Purpose |
|--------|---------|
| `AIInlineWidget.js` | Clickable lightbulb hints at each fix line |
| `aiDiagnostics.js` | Squiggly underlines via Monaco markers API |
| `aiCodeActions.js` | Ctrl+. quick-fix lightbulb provider |
| `aiHoverProvider.js` | Rich hover tooltip with severity, confidence, diff |
| `AIConfidenceGate.jsx` | Visual gating: green AUTO badge ≥0.92, hidden <0.35 |
| `AIDiffPreview.jsx` | Monaco diff editor (side-by-side or inline) |
| `AIActivityTimeline.jsx` | Compact timeline of apply/dismiss actions |

All managed by `useAIHealing` hook lifecycle — register on analysis, dispose on cleanup/reset.

---

## 13. API endpoint inventory

### Regex-based
| Method | Path | Description |
|--------|------|-------------|
| POST | `/heal/analyze` | Analyze code with regex rules |
| POST | `/heal/apply` | Apply specific or all safe regex fixes |
| POST | `/heal/batch` | Batch multi-file regex analysis |
| GET | `/heal/cache/stats` | Regex cache statistics |
| GET | `/heal/presets` | List config presets |
| POST | `/heal/preset` | Apply a config preset |
| GET | `/heal/metrics` | Prometheus-compatible metrics |

### AI-powered
| Method | Path | Description |
|--------|------|-------------|
| POST | `/heal/ai/analyze` | Single-file AI analysis |
| POST | `/heal/ai/batch` | Multi-file AI analysis (single LLM call) |
| POST | `/heal/ai/hybrid` | Regex + AI merged results |
| POST | `/heal/ai/stream` | SSE streaming analysis |
| POST | `/heal/ai/preview` | Dry-run with simulated diff |
| POST | `/heal/ai/project` | Cross-file analysis via dependency graph |
| GET | `/heal/ai/stats` | Agent stats + telemetry + cache |
| GET | `/heal/ai/health` | Pipeline health check |
| POST | `/heal/ai/feedback` | User feedback on a fix |
| GET | `/heal/ai/memory` | View learned patterns |
| POST | `/heal/ai/memory/clear` | Reset learned patterns |
| GET | `/heal/ai/config` | Current agent config |
| PUT | `/heal/ai/config` | Update agent config at runtime |
| POST | `/heal/ai/cache/clear` | Flush prompt cache |

---

## 14. Strategic position

### What this system actually is

An **AI-assisted deterministic code repair engine with safety gating**.

It combines:
1. **Linter-lite auto-fixer** — regex-based, instant, narrow scope.
2. **LLM-powered semantic reviewer** — deliberate, broad scope, catches real bugs.
3. **Safety firewall** — between suggestion and mutation. Four-tier classification,
   escalation enforcement, suppression policy, undo stack.

### What it is not

- Not runtime self-healing (does not patch running processes).
- Not chaos engineering (does not inject faults to test resilience).
- Not autonomic computing (no feedback-driven self-tuning without human input).

### Comparable systems

| System | Similarity |
|--------|-----------|
| Cursor auto-fix | LLM-powered fix suggestions with auto-apply |
| Copilot "fix this" | AI-generated fixes for flagged issues |
| Code review bots (CodeRabbit, etc.) | Automated review with actionable suggestions |
| ESLint --fix | Deterministic auto-apply for pattern-matched issues |

This system is closest to **ESLint --fix + Cursor auto-fix** in a unified pipeline
with a shared safety gate.

---

## 15. Engineering maturity assessment

### What makes this serious (not a toy)

The system has production-grade infrastructure that is uncommon in prototypes:

| Capability | Module | Why it matters |
|-----------|--------|---------------|
| Rate limiting | `ai_rate_limiter.py` | Prevents API cost runaway |
| Retry with jitter | `ai_retry.py` | Handles transient failures without thundering herd |
| Memory / suppression | `ai_memory.py`, `ai_policy.py` | Learns from user feedback, respects user preferences |
| Conflict resolution | `_resolve_conflicts()` | Prevents corrupted output from overlapping edits |
| SSE streaming | `ai_streaming.py` | Progressive delivery reduces perceived latency |
| Telemetry | `ai_telemetry.py` | Timing, error counts, pipeline observability |
| Prompt cache | `ai_prompt_cache.py` | Avoids redundant LLM calls, reduces cost |
| Dependency graph | `ai_deps.py` | Cross-file analysis via import resolution |
| Hybrid merging | `ai_fix_utils.py` | Combines regex + AI results with dedup |
| Pending ops queue | `aiSuppressedRules.js` | Offline resilience for suppression policy |
| Scoped backend policy | `ai_policy.py` | Per-user, per-workspace, per-env isolation |
| Escalation enforcement | `useAIHealing.js` | Defense-in-depth: both backend and frontend gates |

This is structured engineering, not hobby-level scaffolding.

### Architecture quality

The pipeline has clean separation of concerns across 9 stages:

```
Detection → Parsing → Calibration → Validation → Classification
     → Conflict resolution → Application → Telemetry → Memory
```

Each stage is independently testable, replaceable, and configurable.
AI detection was added without modifying the regex engine, classifier,
or UI layer. This modularity is the system's strongest property.

---

## 16. Production readiness — honest gap analysis

### Current state: strong architecture, unproven reliability

| Dimension | Status | Assessment |
|-----------|--------|------------|
| Architecture | ✅ Strong | Clean separation, modularity, extensibility |
| Safety philosophy | ✅ Disciplined | Four-tier classifier, escalation, suppression |
| Regex layer | ✅ Limited but honest | Does what it claims, doesn't overclaim |
| AI layer | ✅ Well-structured | Proper pipeline: context → prompt → parse → calibrate → validate |
| Confidence calibration | ⚠️ Weak | Hand-tuned heuristics, no empirical validation |
| Testing depth | ⚠️ Insufficient | ~20–25% effective coverage |
| Production hardening | ⚠️ Incomplete | No adversarial testing, no SLA monitoring |

### What is still missing for production-grade reliability

| Gap | Impact | Effort |
|-----|--------|--------|
| **Empirical precision metrics** | Cannot verify false-positive rate claims | Medium — log all applied fixes, track reverts per rule |
| **Revert-based confidence calibration** | Confidence values are subjective guesses | Medium — compute empirical precision per rule quarterly |
| **Security / redaction layer** | Code is sent to external LLM without sanitization | High — secrets scanning, PII redaction before prompt |
| **AST-backed critical rule layer** | Regex cannot verify scope, shadowing, or type info | High — tree-sitter integration for high-value rules |
| **Formal SLA monitoring** | No alerting on latency regression or error spikes | Low — wire telemetry to Prometheus/Grafana |
| **Adversarial testing** | Unknown behavior under malicious/degenerate input | Medium — fuzz suite for parser, prompt, streaming |
| **Project-scale evaluation benchmark** | No end-to-end quality measurement across real codebases | High — curated test corpus with known bugs and fixes |

### Graduation criteria

The system should not be labeled "production-grade" until:

1. ☐ Empirical false-positive rate is measured and < 5% for regex, < 10% for AI.
2. ☐ Confidence values are calibrated against revert data (at least one cycle).
3. ☐ Fuzz tests pass for malformed JSON, partial streams, overlapping conflicts.
4. ☐ Security review: code sent to LLM is screened for secrets/PII.
5. ☐ SLA monitoring is active with alerts for p95 regression.
6. ☐ Test coverage reaches ≥ 50% effective (currently ~20–25%).
7. ☐ At least one real-codebase evaluation (100+ files, known bug set) is completed.

Until these are met: **strong foundation, not yet production-grade reliability.**
