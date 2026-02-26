# Self-Healing System — Changelog

All notable changes to the self-healing subsystem are documented here.

---

## v1.0.0 — Initial Release

### 🏗️ Core Architecture (commits 1–32)

- **Types & Models** — `HealingFix`, `HealingResult`, `HealingConfig`, `HealingEvent`, `HealingStats`, `HealingCategory` enum (~20 categories), `HealingSeverity`, `HealingAction` (INSERT / REPLACE / DELETE).
- **Classifier** — Safety gate with three tiers: `ALWAYS_SAFE`, `CONDITIONALLY_SAFE`, `NEVER_AUTO`. Prevents unsafe auto-apply.
- **Rule Registry** — Central singleton with `@healing_rule` decorator. All rules are universal (`languages={"*"}`).
- **Engine** — `SelfHealingEngine` with `analyze()`, `apply_fix()`, `apply_safe_fixes()`. Conservative defaults: min confidence 0.9, max 5 fixes per pass.
- **API Endpoints** — 11 REST endpoints on FastAPI (analyze, apply, container, config, stats, rules, batch, cache stats, presets, preset apply, metrics).
- **Gateway** — 11 WebSocket forwarding functions in the Node.js gateway.
- **Frontend Client** — 11 typed client methods in `analyzerGatewayClient.js`.
- **Redux** — Full healing slice with 30+ reducers, memoized selectors, store registration, persistence.
- **Hooks** — `useSelfHealing`, `useHealingUndo`, `useBatchHealing`, `useHealingStats`, `useHealingKeyboard`, plus gateway integration.
- **UI Components** — `HealingToast`, `HealingIndicator`, `HealingSettingsPanel`, `HealingPendingPanel`, `HealingHistoryPanel`, `HealingStatsDashboard`, `HealingPresetSelector`, `healingDecorations`.

### 🔧 Universal Rules (commits 33–74)

All rules work across every language. Internal language dispatch handles per-language quirks.

| Module | Rule IDs | What it catches |
|--------|----------|-----------------|
| `universal_rules` | UNI_HEAL_001–005 | Trailing whitespace, EOF newlines, unclosed strings, mismatched quotes, trailing commas |
| `terminators` | UNI_TERM_001 | Missing colons / semicolons |
| `imports` | UNI_IMP_001–002 | Unused / duplicate imports |
| `brackets` | UNI_BRK_001 | Unmatched brackets / parens / braces |
| `comparisons` | UNI_CMP_001–003 | Identity checks, strict equality, boolean comparisons |
| `whitespace` | UNI_WS_001–004 | Tab/space mixing, blank lines, indentation |
| `comments` | UNI_CMT_001–003 | Comment spacing, TODOs, commented-out code |
| `naming` | UNI_NAM_001–002 | Variable / constant naming conventions |
| `strings` | UNI_STR_001–004 | Quote consistency, f-strings, concatenation, templates |
| `dead_code` | UNI_DEAD_001–003 | Unreachable code, empty functions, duplicates |
| `type_hints` | UNI_TYPE_001–003 | Missing types, `Any` usage, type-ignore |
| `error_handling` | UNI_ERR_001–004 | Empty catch, bare except, broad exceptions |
| `operators` | UNI_OP_001–003 | Assignment in conditionals, operator misuse |
| `line_length` | UNI_FMT_001–003 | Long lines, spacing issues |
| `returns` | UNI_RET_001–003 | Unnecessary else after return, consistency |
| `variables` | UNI_VAR_001–003 | Unused vars, shadowing, const suggestions |
| `loops` | UNI_LOOP_001–003 | `range(len)`, unused loop vars, infinite loops |
| `conditionals` | UNI_COND_001–003 | Redundant booleans, ternary simplification |
| `logging_debug` | UNI_LOG_001–003 | Debug statements, secrets in logs, debug flags |
| `complexity` | UNI_CMPLX_001–003 | Deep nesting, too many params, long functions |
| `syntax_consistency` | UNI_SYN_001–003 | Semicolons, trailing commas, mixed syntax |
| `documentation` | UNI_DOC_001–003 | Missing docstrings, incomplete docs |
| `async_patterns` | UNI_ASYNC_001–003 | Missing await, async misuse, forEach with async |
| `security` | UNI_SEC_001–004 | SQL injection, eval, weak random, XSS |
| `classes` | UNI_CLS_001–003 | Missing self/this, super() calls, god classes |
| `function_patterns` | UNI_FN_001–003 | Mutable defaults, branch count, nesting depth |
| `exception_patterns` | UNI_EXC_001–003 | Broad catch, swallowed exceptions, chaining |
| `resource_management` | UNI_RES_001–003 | Unclosed resources, missing finally, event listeners |
| `deprecation` | UNI_DEP_001–003 | Deprecated APIs (Python/JS/HTML) |
| `performance` | UNI_PERF_001–003 | String concat in loops, regex compilation, list() |
| `testing` | UNI_TEST_001–003 | Bare asserts, no assertions, debug in tests |
| `encoding` | UNI_ENC_001–003 | BOM, line endings, homoglyphs |
| `module_structure` | UNI_MOD_001–003 | Star imports, `__all__`, barrel files |
| `magic_numbers` | UNI_MAGIC_001–003 | Magic numbers, hardcoded URLs, hardcoded paths |
| `api_patterns` | UNI_API_001–003 | HTTP error handling, response shape, headers |
| `react_patterns` | UNI_REACT_001–003 | Missing key prop, useEffect deps, state mutation |
| `accessibility` | UNI_A11Y_001–003 | Missing alt text, empty href, aria-label |
| `concurrency` | UNI_CONC_001–003 | Global mutable state, goroutine leaks, Promise.all |

**Total: 38 modules, 100+ individual rules.**

### ⚡ Engine Improvements (commits 75–80)

- **Batch Engine** — `BatchHealingEngine` for concurrent multi-file analysis with priority sorting and progress callbacks.
- **Cache** — `HealingCache` with LRU eviction (256 max), TTL (5 min), thread-safe, content-hash keyed.
- **Integration** — Cache wired into main engine, batch + cache stats endpoints, gateway forwarding, frontend client.

### 🧪 Tests (commits 81–90)

- `test_rule_registry.py` — Registry singleton, universal rules, ID convention, no duplicates, enable/disable.
- `test_universal_rules.py` — Individual rule tests across languages.
- `test_engine.py` — Analyze, fix application (INSERT/REPLACE/DELETE), config, caching, events, classifier.
- `test_cache.py` — LRU eviction, TTL, invalidation, hit rate.
- `test_batch_engine.py` — Empty/single/multi batch, oversized skip, priority, cancel.
- `test_integration_healing.py` — Full end-to-end pipeline tests.

### 📖 Documentation (commits 91–93)

- `docs/SELF_HEALING_ARCHITECTURE.md` — Full architecture diagram, rule catalog, safety model, caching strategy, keyboard shortcuts, API reference.
- `docs/WRITING_HEALING_RULES.md` — Developer guide for writing new universal rules.
- `config_schema.py` — Configuration presets (conservative / balanced / aggressive) with validation.

### 🎯 Polish (commits 94–100)

- **Metrics Exporter** — `HealingMetrics` with Prometheus exposition format, per-language/category breakdowns, percentile latency.
- **Preset & Metrics API** — `GET /heal/presets`, `POST /heal/preset`, `GET /heal/metrics` endpoints.
- **Gateway Forwarding** — Three new WebSocket forwarders for presets and metrics.
- **Client Methods** — `healPresets()`, `healApplyPreset()`, `healMetrics()` in frontend client.
- **Preset Selector UI** — `HealingPresetSelector` component with compact and full modes.
- **This Changelog** — Complete feature summary.

---

## Configuration Presets

| Preset | Min Confidence | Max Fixes/Pass | Auto-Apply | Cooldown |
|--------|---------------|----------------|------------|----------|
| Conservative | 0.95 | 3 | Whitespace only | 5 000 ms |
| Balanced | 0.80 | 5 | Common issues | 2 000 ms |
| Aggressive | 0.60 | 10 | Everything safe | 500 ms |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Shift+H` | Toggle self-healing |
| `Ctrl+Shift+A` | Apply all safe fixes |
| `Ctrl+Shift+Z` | Undo last fix |
| `Ctrl+Shift+B` | Run batch analysis |

---

*100 commits across the full stack: Python backend, Node.js gateway, React/Next.js frontend.*
