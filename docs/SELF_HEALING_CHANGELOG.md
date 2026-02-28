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
