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

---

## v3.0.0 — Agentic Self-Healing

### Overview

Transforms the existing AI-assisted code repair pipeline into a **true
agentic self-healing system** — a closed-loop that can **Detect →
Diagnose → Plan → Safely Act → Verify outcome → Learn policy** without
human intervention for Tier 0/1 fixes.

### Architecture Evolution

| v2.1 (Before) | v3.0 (After) |
|--------------|--------------|
| Regex + AI detect → fix → apply | Detect → Diagnose → Plan → Act → Verify → Learn |
| Single-file only | Multi-file coordination w/ topological ordering |
| No rollback | Transactional rollback with SHA-256 snapshots |
| No secret scanning | 18-pattern redaction engine (hard blocker before LLM) |
| Heuristic confidence | Bayesian calibrated confidence from outcome tracking |
| No diagnosis | Root-cause analysis with cause graph (18 cause types) |
| No planning | Multi-strategy planner with budget constraints |
| No sandbox | Ephemeral isolated sandbox with file/exec limits |
| No runtime healing | Stack trace parser (Python/Node/Go) + dedup + cooldown |
| No observability triggers | 6 anomaly detectors (error rate, build time, HMR, flakiness, crash loop, log) |
| No risk policy | 4-tier risk classification + approval modes + rate limiting |
| No canary deploys | Staged canary rollout with soak monitoring |
| No episode tracking | Full state machine with audit trail |

### New Modules (13 files, ~8,600 LOC)

#### Phase 1 — Safety & State

| Module | File | LOC | Purpose |
|--------|------|-----|---------|
| Repair Episode | `repair_episode.py` | 697 | State machine backbone: DETECTED → DIAGNOSING → PLANNING → EXECUTING → VERIFYING → SUCCEEDED/ROLLED_BACK/ESCALATED |
| Redaction | `redaction.py` | 581 | Secret/PII scanning (18 patterns: AWS/GCP/Azure keys, JWTs, DB strings, tokens). Hard blocker before any LLM call. SHA-256 audit trail. |
| Verification | `verification.py` | 902 | Post-fix pipeline: syntax → compile → lint → typecheck → test → smoke. Language commands for Python/JS/TS/Go/Rust/Java. Semantic guardrails (dangerous APIs, forbidden files, patch minimality). |
| Rollback | `rollback.py` | 591 | Transactional rollback: snapshot files before patching, atomic commit/rollback. SHA-256 integrity checks. Active-by-file tracking. |
| Precision Telemetry | `precision_telemetry.py` | 542 | Fix outcome tracking: accepted/reverted/ignored per rule. Bayesian posterior for calibrated confidence. Degrading-rule detection. JSON persistence. |

#### Phase 2 — Intelligence

| Module | File | LOC | Purpose |
|--------|------|-----|---------|
| Diagnosis | `diagnosis.py` | 705 | Root-cause analysis with cause graph. 18 cause types (syntax, import, type, null, permission, etc). Fast regex path (~10ms) + optional LLM-assisted deep diagnosis. |
| Planner | `planner.py` | 1083 | Multi-step repair planner. 7 strategy types per cause. Step budget (max 15 steps, 5 LLM calls, 3 patches, 120s). Strategy failover A→B→C. Tool executor registry. |
| Sandbox | `sandbox.py` | 733 | Ephemeral isolated workspace. File/execution/network limits. Write allowlist/denylist. Snapshot → patch → run → collect → promote/cleanup. Max 3 concurrent, auto-cleanup stale. |
| Multi-File | `multi_file.py` | 561 | Cross-file repair coordination. Topological ordering (Kahn's algorithm). 4 strategies: sequential, batch, topological, independent. All-or-nothing rollback. Change impact analysis (direct/transitive dependents). |

#### Phase 3 — Operational Safety

| Module | File | LOC | Purpose |
|--------|------|-----|---------|
| Runtime Healing | `runtime_healing.py` | 596 | Runtime exception healing. Stack trace parsers (V8/Node, Python traceback, Firefox, Go). Error deduplication + cooldown. 6 default suppressions (HMR, React dev, source map, favicon, WebSocket, experimental). |
| Observability | `observability.py` | 605 | Signal-based healing triggers. Sliding window stats. 6 detectors: error rate, build time regression, HMR cascade, test flakiness, crash loop, log anomaly (FATAL/OOM/segfault/deadlock). |
| Policy | `policy.py` | 540 | Risk tiers 0–3 + approval modes (auto/notify/confirm/block). 10 default risk rules. Rate limiting (20 repairs/hr). Feature flags. Max file/line constraints per tier. |
| Canary | `canary.py` | 539 | Staged rollout: CREATED → CANARY → SOAKING → PROMOTING → PROMOTED. Soak monitoring (15s default, 3s check interval). Health checks. Automatic rollback on new errors. |

### API Endpoints (25+ new routes)

All under `/heal/agentic/*`:

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/heal/agentic/diagnose` | POST | Root-cause diagnosis |
| `/heal/agentic/episode/create` | POST | Create repair episode |
| `/heal/agentic/episode/{id}` | GET | Get episode by ID |
| `/heal/agentic/episodes` | GET | List recent episodes |
| `/heal/agentic/policy/evaluate` | POST | Evaluate repair against policy |
| `/heal/agentic/policy/status` | GET | Policy engine status |
| `/heal/agentic/verify` | POST | Run verification pipeline |
| `/heal/agentic/guardrails` | POST | Check semantic guardrails |
| `/heal/agentic/telemetry/calibration` | GET | Calibration table |
| `/heal/agentic/telemetry/degrading` | GET | Degrading rules |
| `/heal/agentic/runtime/ingest` | POST | Ingest runtime error |
| `/heal/agentic/runtime/stats` | GET | Runtime healing stats |
| `/heal/agentic/observability/error` | POST | Record error signal |
| `/heal/agentic/observability/build` | POST | Record build duration |
| `/heal/agentic/observability/hmr-failure` | POST | Record HMR failure |
| `/heal/agentic/observability/stats` | GET | Observability stats |
| `/heal/agentic/observability/triggers` | GET | Recent triggers |
| `/heal/agentic/canary/create` | POST | Create canary rollout |
| `/heal/agentic/canary` | GET | List canary rollouts |
| `/heal/agentic/canary/stats` | GET | Canary stats |
| `/heal/agentic/status` | GET | Combined subsystem overview |

### WebSocket Gateway Actions (21 new)

All wired through `ai-backend/gateway/server.js` with `agenticPost`/`agenticGet`
generic helpers and camelCase/snake_case normalization.

### Testing

| Test file | Tests | Focus |
|-----------|-------|-------|
| `test_agentic_healing.py` | 60+ | All 13 modules + export verification |

Total test count: **~280+** (66 v1 + 36 v2 + ~118 v2.1 + 60+ v3.0).

### What's better vs v2.1

| v2.1 gap | v3.0 fix |
|----------|----------|
| No episode lifecycle | Full state machine with 9 states + audit trail |
| No secret scanning before LLM | 18-pattern redaction engine (hard blocker) |
| No post-fix verification | 6-stage pipeline: syntax → compile → lint → typecheck → test → smoke |
| No rollback capability | Transactional rollback with integrity checks |
| Uncalibrated confidence | Bayesian posterior from outcome tracking |
| No root-cause diagnosis | Cause graph with 18 cause types + LLM-assisted deep mode |
| No repair planning | Multi-strategy planner with budget constraints |
| No sandboxing | Ephemeral isolated workspace with limits |
| Single-file only | Multi-file coordination with topological ordering |
| No runtime exception healing | Stack trace parsers + dedup + suppression |
| No anomaly-based triggers | 6 signal detectors for proactive healing |
| No risk policy enforcement | 4-tier risk + approval modes + rate limits |
| No staged rollout | Canary → soak → promote pipeline |
