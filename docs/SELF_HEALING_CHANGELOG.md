# Targeted Auto-Fix System — Changelog

> Previously called "self-healing." Renamed because the system
> auto-suggests and auto-applies **narrow, regex-detected fixes**, not
> arbitrary program repair. See `SELF_HEALING_ARCHITECTURE.md` for the
> full technical reference including limitations.

---

## v1.0.0

### What this system actually does

Auto-detects and (where classified as safe) auto-applies fixes for a
narrow class of **syntactic and stylistic issues** — trailing whitespace,
unused imports, missing semicolons/colons, mismatched brackets, and
similar. Detection is **regex-based** (no AST, no LSP). Confidence
values are **hand-tuned heuristics**, not calibrated probabilities.

### Core Architecture

- **Engine** (`engine.py`): `SelfHealingEngine` — orchestrates rules →
  classifier → conflict resolver → dedup → apply.
- **Classifier** (`classifier.py`): 4-tier safety gate (category
  allow/block → context analysis → global overrides → engine caps).
- **Rule Registry** (`rule_registry.py`): `@healing_rule` decorator.
  All rules registered as universal (`languages={"*"}`), but most
  only fire for 2–4 languages internally.
- **Cache** (`cache.py`): LRU (256 max), TTL 5 min, thread-safe,
  SHA-256 content-hash keyed.
- **Batch Engine** (`batch_engine.py`): async multi-file analysis.
- **Conflict Resolver**: detects overlapping edit ranges, keeps
  higher-severity fix, drops the other with reason `conflict_overlap`.
- **Per-rule timeout**: rules exceeding 10ms are skipped.
- **Metrics** (`metrics_export.py`): Prometheus exposition format.
- **Config** (`config_schema.py`): 3 presets (conservative / balanced /
  aggressive) with validation.
- **Language Families** (`lang_families.py`): centralised language
  identifier sets to reduce rule coupling.

### Rule System

38 modules, 100+ individual rules. All regex-based.

**Honest assessment**: most rules only cover Python and JavaScript.
For Go, Rust, C++, Java, etc., many rules return `[]` (no-op).
"Universal" means the framework is language-agnostic, not that every
rule works in every language.

### Safety Model

| Tier | What it does |
|------|-------------|
| 1: Category allow/block | `ALWAYS_SAFE` (4 categories) auto-apply. `NEVER_AUTO` (7 categories) block. `CONDITIONALLY_SAFE` (9 categories) go to Tier 2. |
| 2: Context analysis | Per-category checks (e.g., "is this missing colon on a `def` line?"). |
| 3: Global overrides | Confidence floor (0.90), line-span limit (≤ 3), string/comment guard. |
| 4: Engine caps | Max 5 fixes/pass, 1s cooldown, dedup. |

### API: 12 endpoints

`/heal/analyze`, `/heal/apply`, `/heal/batch`, `/heal/container`,
`/heal/config` (GET/POST), `/heal/presets`, `/heal/preset`,
`/heal/stats`, `/heal/rules`, `/heal/cache/stats`, `/heal/metrics`.

### Gateway: 14 WebSocket forwarding functions

All `heal/*` actions forwarded from `:7070` → `:8000`.

### Frontend

- **Client**: 11 typed methods in `analyzerGatewayClient.js`.
- **Hooks**: `useSelfHealing`, `useHealingUndo`, `useBatchHealing`,
  `useHealingStats`, `useHealingKeyboard`.
- **Redux**: `healingSlice` with 30+ reducers, memoized selectors.
- **UI**: `HealingToast`, `HealingIndicator`, `HealingSettingsPanel`,
  `HealingPendingPanel`, `HealingHistoryPanel`, `HealingStatsDashboard`,
  `HealingPresetSelector`, `healingDecorations`.

### Testing

- **66 test functions** across 6 files.
- Engine, cache, batch, registry, integration: reasonable coverage (~70%).
- **Individual rule coverage: ~10–15%** (most rules lack dedicated tests).
- **Gateway: 0% tested. Frontend: 0% tested.**
- **Conflict resolution: 8 new tests** covering no-conflict, overlap
  with severity tiebreak, confidence tiebreak, 3-way chain, edge cases.
- Overall effective coverage: **~20–25%**. This is underpowered.

### Known Limitations

1. **No AST parsing** — regex can't understand scope, nesting, or control flow.
2. **Confidence is not calibrated** — no precision/recall data, no revert tracking.
3. **Partial overlap was unhandled** until this version (now resolved).
4. **No per-rule timeout** was enforced until this version (now 10ms cap).
5. **Language dispatch is duplicated** across rule files (now mitigated
   by `lang_families.py` but not yet adopted by all 38 modules).
6. **No throughput benchmarks** — "real-time" claim unvalidated.

---

## v2.0.0 — AI Agent Layer (Agentic Detection)

> Commits 102–128. Adds LLM-powered detection that catches real semantic
> bugs that regex can never see.

### What changed

The system now has **two detection modes**:

| Mode | Speed | Catches | When to use |
|------|-------|---------|-------------|
| **Regex** (v1) | < 5ms | Syntax/style issues | Real-time on every keystroke |
| **AI** (v2) | 2–10s | Logic errors, null safety, missing awaits, off-by-one, resource leaks | On-demand (Ctrl+Shift+I) or on save |
| **Hybrid** | 2–10s | Both | Best coverage, moderate latency |

### New backend modules (Python)

| Module | Purpose | Lines |
|--------|---------|-------|
| `ai_prompts.py` | Structured prompt templates for Gemini | ~170 |
| `ai_parser.py` | Parse noisy LLM output → HealingFix | ~360 |
| `ai_context.py` | Gather imports, related files, project hints | ~410 |
| `ai_agent.py` | Core agentic loop (detect → calibrate → validate) | ~460 |
| `ai_memory.py` | Learn from user feedback, auto-suppress | ~285 |
| `ai_streaming.py` | SSE streaming for long-running analysis | ~190 |

### New API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/heal/ai/analyze` | AI single-file detection |
| POST | `/heal/ai/batch` | AI multi-file detection |
| POST | `/heal/ai/hybrid` | Merged regex + AI |
| GET | `/heal/ai/stats` | Agent statistics |
| POST | `/heal/ai/stream` | SSE-streamed analysis |
| POST | `/heal/ai/feedback` | Submit user feedback |
| GET | `/heal/ai/memory` | View learned patterns |
| DELETE | `/heal/ai/memory` | Clear learned patterns |

### Gateway additions

3 new WebSocket forwarding functions:
`forwardAIFeedback`, `forwardAIMemory`, `forwardAIMemoryClear`
(Added to the 4 existing: `forwardAIAnalyze`, `forwardAIBatch`,
`forwardAIHybrid`, `forwardAIStats`).

### Frontend additions

- **Client methods**: `aiFeedback()`, `aiMemory()`, `aiMemoryClear()`
- **Hooks**: `useAIHealing` (analysis + apply + dismiss + feedback),
  `useAIHealingKeyboard` (Ctrl+Shift+I/Y/N/M)
- **Redux**: `ai` sub-state in `healingSlice`, 8 AI-specific selectors
- **Components**: `AIFixCard`, `AIHealingPanel`, `AIStatsPanel`

### Testing

- **36 new test functions** in `test_ai_agent.py`:
  - JSON extraction (7), JSON quirk fixing (3), detection parsing (8),
    validation parsing (4), batch parsing (2), import extraction (5),
    language detection (5), test-pair finder (3), memory (10),
    calibration (3).
- Total test count: **102** (66 v1 + 36 v2).

### Honest assessment

**What's better**:
- Detects real bugs that regex fundamentally can't see.
- Learns from user feedback — gets more accurate over time.
- Integrates cleanly with existing safety classifier and UI.

**What's still limited**:
- LLM latency (2–10s) means AI mode can't run on every keystroke.
- Requires network access and Gemini API key.
- Can hallucinate fixes for correct code (mitigated by validation pass
  and confidence discounting, but not eliminated).
- No rate limiting or retry logic on LLM calls.
- Frontend components are not yet wired into the main editor layout
  (components exist but integration is per-project).
- Gateway streaming endpoint (`/heal/ai/stream`) is defined but not
  yet forwarded through WebSocket (HTTP SSE only).

---

## v2.1.0 — Production Infrastructure (commits 128–186)

> Hardening, observability, Monaco deep integration, cross-file analysis,
> caching, and comprehensive testing.

### New backend modules

| Module | Purpose |
|--------|---------|
| `ai_rate_limiter.py` | Token-bucket rate limiter (10 req/60s, 15s timeout) |
| `ai_retry.py` | Exponential backoff (2 retries, 1s base, 8s max, jitter) |
| `ai_deps.py` | Cross-file dependency graph (JS/TS, Python, Rust imports) |
| `ai_fix_utils.py` | Fix dedup, merge, grouping, sorting, filtering |
| `ai_telemetry.py` | Timing buckets, error counters, snapshot API |
| `ai_prompt_cache.py` | LRU cache (64 entries, 120s TTL) to skip repeat LLM calls |

### New API endpoints

| Method | Path | Description |
|--------|------|-------------|
| POST | `/heal/ai/project` | Cross-file analysis via dependency graph |
| POST | `/heal/ai/preview` | Dry-run with simulated diff (no edits applied) |
| GET | `/heal/ai/health` | Pipeline health check (LLM, memory, limiter, deps) |
| GET | `/heal/ai/config` | Current agent configuration |
| PUT | `/heal/ai/config` | Update config at runtime |
| POST | `/heal/ai/cache/clear` | Flush prompt cache |

### Gateway additions

6 new WebSocket routes: `project`, `stream` (SSE-to-WS bridge), `config`,
`config/update`, `health`, `cache/clear`, `preview`.

Total AI gateway routes: **15**.

### Frontend additions

**Services:**
- `aiFixHistory.js` — session-scoped audit log (max 200 entries, sessionStorage)

**Monaco integration:**
- `AIInlineWidget.js` — clickable inline hints per fix line
- `aiDiagnostics.js` — squiggly underlines via Monaco markers
- `aiCodeActions.js` — Ctrl+. quick-fix lightbulb provider
- `aiHoverProvider.js` — rich hover tooltip with severity table + diff

**UI components:**
- `AIDiffPreview.jsx` — Monaco diff editor (side-by-side or inline)
- `AIConfidenceGate.jsx` — confidence-gated wrapper with visual tiers
- `AIActivityTimeline.jsx` — compact timeline of fix actions
- `AIFixCard` now has rich Monaco diff toggle
- `AIHealingPanel` wraps fixes with `AIConfidenceGate`
- `AIStatsPanel` includes `AIActivityTimeline`

**Hooks:**
- `useAIAutoAnalysis` — debounced auto-analysis on content change
- `useAISelectionAnalysis` — analyze selected range only
- `useAIHealing` — now manages hover provider lifecycle

**Client methods:**
- `aiStream()`, `aiProject()`, `aiConfig()`, `aiConfigUpdate()`,
  `aiHealth()`, `aiCacheClear()`, `aiPreview()`

### Testing

| Test file | Tests | Focus |
|-----------|-------|-------|
| `test_ai_deps.py` | 13 | Import parsing, graph operations, singleton |
| `test_ai_fix_utils.py` | 18 | Dedup, merge, group, sort, filter |
| `test_ai_telemetry.py` | 11 | Timing, counters, errors, snapshot |
| `test_ai_prompt_cache.py` | 11 | LRU, TTL, eviction, stats |
| `test_ai_streaming.py` | 5 | SSE events, progress, error handling |
| `test_integration_healing.py` | 28 | End-to-end pipeline |

Total test count: **~220** (66 v1 + 36 v2 + ~118 v2.1).

### What's better vs v2.0

| v2.0 gap | v2.1 fix |
|----------|----------|
| No rate limiting | Token-bucket 10 req/60s |
| No retry logic | Exponential backoff + jitter |
| No observability | Telemetry module + stats exposure |
| Duplicate LLM calls waste tokens | Prompt cache (LRU, 120s TTL) |
| No cross-file awareness | Dependency graph + project endpoint |
| SSE not bridged to WebSocket | Gateway SSE-to-WS bridge |
| No audit trail | Fix history service + timeline UI |
| No Monaco hover info | Rich hover provider |
| Fixes not confidence-gated | AIConfidenceGate wrapper |
| No diff preview | AIDiffPreview + AIFixCard rich diff |
| Gateway streaming missing | Now forwarded via SSE bridge |
| Config not runtime-adjustable | GET/PUT /heal/ai/config |
