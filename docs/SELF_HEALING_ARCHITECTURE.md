# Self-Healing System Architecture

## Overview

The Synthi IDE self-healing system automatically detects and corrects small code
issues in real-time. It targets obvious, safe, non-logic-altering fixes such as
trailing whitespace, missing imports, bracket mismatches, and deprecated API usage.

## Design Principles

1. **Conservative** — Only auto-applies fixes with ≥90% confidence that are
   classified as safe (no logic changes).
2. **Universal** — Every rule works across all languages. Language dispatch is
   handled internally within each rule.
3. **Fast** — Rules run in <50ms per file. Results are LRU-cached to avoid
   redundant analysis.
4. **Transparent** — Every fix is logged, shown to the user, and can be undone.
5. **Non-intrusive** — Never changes program logic; focuses on style, formatting,
   and obvious bugs.

## Architecture Layers

```
┌───────────────────────────────────────────────┐
│  Frontend (React/Next.js)                      │
│  ┌──────────────┐  ┌────────────────────────┐ │
│  │ useSelfHealing│  │ HealingToast/Indicator │ │
│  │ useHealingUndo│  │ HealingSettingsPanel   │ │
│  │ useBatchHeal  │  │ HealingStatsDashboard  │ │
│  │ useHealKeyboard│ │ HealingPendingPanel    │ │
│  └──────┬───────┘  └────────────────────────┘ │
│         │  Redux healingSlice + selectors       │
│         ▼                                       │
│  analyzerGatewayClient (WebSocket)              │
└──────────┬────────────────────────────────────┘
           │
┌──────────▼────────────────────────────────────┐
│  Gateway (Node.js WebSocket, port 7070)        │
│  Forwards heal/* actions to AI Engine          │
└──────────┬────────────────────────────────────┘
           │
┌──────────▼────────────────────────────────────┐
│  AI Engine (Python FastAPI, port 8000)         │
│  ┌─────────────────────────────────────────┐  │
│  │ SelfHealingEngine                       │  │
│  │  ├── HealingRuleRegistry (38 modules)   │  │
│  │  ├── HealingClassifier (safety gate)    │  │
│  │  ├── HealingCache (LRU, TTL)            │  │
│  │  └── BatchHealingEngine (multi-file)    │  │
│  └─────────────────────────────────────────┘  │
│  API: /heal/analyze, /heal/apply, /heal/batch  │
│       /heal/config, /heal/stats, /heal/rules   │
│       /heal/cache/stats, /heal/container       │
└────────────────────────────────────────────────┘
```

## Rule System

All rules are **universal** — each rule file handles all languages internally
through language dispatch. Rules are registered via the `@healing_rule` decorator.

### Rule Categories

| Category | Module | Rule IDs | Description |
|----------|--------|----------|-------------|
| Core formatting | universal_rules | UNI_HEAL_001-005 | Trailing whitespace, EOF newline, quotes |
| Terminators | terminators | UNI_TERM_001 | Missing colons/semicolons |
| Imports | imports | UNI_IMP_001-002 | Unused/duplicate imports |
| Brackets | brackets | UNI_BRK_001 | Unmatched brackets |
| Comparisons | comparisons | UNI_CMP_001-003 | Identity, strict equality, boolean |
| Whitespace | whitespace | UNI_WS_001-004 | Tabs/spaces, blank lines, indent |
| Comments | comments | UNI_CMT_001-003 | Comment spacing, TODO format |
| Naming | naming | UNI_NAM_001-002 | Variable/constant naming |
| Strings | strings | UNI_STR_001-004 | Quote style, f-strings, templates |
| Dead code | dead_code | UNI_DEAD_001-003 | Unreachable code, empty functions |
| Type hints | type_hints | UNI_TYPE_001-003 | Missing types, any usage |
| Error handling | error_handling | UNI_ERR_001-004 | Empty catch, bare except |
| Operators | operators | UNI_OP_001-003 | Assignment in conditional |
| Line length | line_length | UNI_FMT_001-003 | Long lines, spacing |
| Returns | returns | UNI_RET_001-003 | Unnecessary else, consistency |
| Variables | variables | UNI_VAR_001-003 | Unused, shadowing, const |
| Loops | loops | UNI_LOOP_001-003 | range(len), unused loop var |
| Conditionals | conditionals | UNI_COND_001-003 | Redundant boolean, ternary |
| Logging | logging_debug | UNI_LOG_001-003 | Debug statements, secrets |
| Complexity | complexity | UNI_CMPLX_001-003 | Nesting, params, length |
| Syntax | syntax_consistency | UNI_SYN_001-003 | Semicolons, commas |
| Documentation | documentation | UNI_DOC_001-003 | Missing docstrings |
| Async | async_patterns | UNI_ASYNC_001-003 | Missing await, async forEach |
| Security | security | UNI_SEC_001-004 | SQL injection, eval, XSS |
| Classes | classes | UNI_CLS_001-003 | Missing self, super, god class |
| Functions | function_patterns | UNI_FN_001-003 | Mutable defaults, nesting |
| Exceptions | exception_patterns | UNI_EXC_001-003 | Broad catch, swallowing |
| Resources | resource_management | UNI_RES_001-003 | Unclosed files, listeners |
| Deprecation | deprecation | UNI_DEP_001-003 | Legacy API usage |
| Performance | performance | UNI_PERF_001-003 | Concat in loop, regex |
| Testing | testing | UNI_TEST_001-003 | Bare assert, no assertions |
| Encoding | encoding | UNI_ENC_001-003 | BOM, line endings, homoglyphs |
| Modules | module_structure | UNI_MOD_001-003 | Star imports, __all__ |
| Magic numbers | magic_numbers | UNI_MAGIC_001-003 | Hardcoded values, URLs |
| API | api_patterns | UNI_API_001-003 | HTTP errors, response shape |
| React | react_patterns | UNI_REACT_001-003 | Keys, deps, state mutation |
| A11y | accessibility | UNI_A11Y_001-003 | Alt text, aria labels |
| Concurrency | concurrency | UNI_CONC_001-003 | Global state, Promise.all |

**Total: 38 modules, 100+ rules**

## Safety Classification

Each fix goes through the `HealingClassifier`:

- **ALWAYS_SAFE**: Trailing whitespace, BOM removal, comment formatting
- **CONDITIONALLY_SAFE**: Import cleanup (if not in string/comment context)
- **NEVER_AUTO**: Logic-changing fixes (always require user approval)

Minimum confidence threshold: **0.90** (configurable).

## Caching

The `HealingCache` prevents re-analysing unchanged files:

- **Key**: `content_hash:language`
- **TTL**: 5 minutes (configurable)
- **Max size**: 256 entries (LRU eviction)
- **Thread-safe**: Uses `threading.RLock`

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| Ctrl+Shift+H | Toggle healing on/off |
| Ctrl+Shift+A | Accept all pending safe fixes |
| Ctrl+Shift+Z | Undo last healing fix |
| Ctrl+Shift+B | Run batch healing on workspace |

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | /heal/analyze | Analyze single file |
| POST | /heal/apply | Apply specific fixes |
| POST | /heal/batch | Batch analyze multiple files |
| POST | /heal/container | Analyze from container FS |
| GET | /heal/config | Get healing configuration |
| POST | /heal/config | Update healing configuration |
| GET | /heal/stats | Get engine statistics |
| GET | /heal/rules | List all registered rules |
| GET | /heal/cache/stats | Get cache performance metrics |
