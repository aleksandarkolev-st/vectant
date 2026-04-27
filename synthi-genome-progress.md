# Synthi Genome — Implementation progress

Tracker for the Wave-by-Wave delivery of `synthi-genome-master-plan.md`.
Branch: `claude/synthi-genome-implementation-lsJE9`.

> Convention: ✅ shipped · 🟡 in progress / partial · ⚪ not started.
>
> "Shipped" means the code is in this branch and importable/testable.
> Production readiness is gated on the Wave 1 evaluation harness (§15).

---

## Wave 0 — already-written, uncommitted

Held per master plan decision #6 ("Hold. Ship as part of the Wave 1 PR.").
Not part of this branch's scope yet.

| Item | Status |
|---|---|
| Inline-completion overhaul + tokenized ghost text | ⚪ outside this branch |
| Multi-provider chat (Anthropic/OpenAI/Gemini) with logos & per-provider keys | ⚪ outside this branch |
| RAG: HyDE + chat-history rewrite | ⚪ outside this branch |

---

## Wave 1 — single universe + Critic + verify panel

Files created on this branch:

```
ai-backend/ai-engine/shadow/
  __init__.py
  api.py                       FastAPI router + request/response schemas
  events.py                    SSE event factories + JobState registry
  generator.py                 Generator + style profiles
  critic.py                    Adversarial Critic + reproducer schema
  universe.py                  (Generator + Critic + Runner) executor
  multiverse.py                Orchestrator (N=1 in Wave 1)
  worktree.py                  Pre-warmed git worktree pool + dep-install lock
  snapshot.py                  Snapshot + 3-way merge + AI-rebase fallback
  scoring.py                   Composite scoring (master plan §10)
  regression_log.py            File-backed accepted-patch log
  runner/
    __init__.py
    base.py                    Runner protocol + budgets + run_cmd helper
    python.py                  ruff + mypy + pytest
    node.py                    eslint + tsc + vitest/jest
    syntax.py                  tree-sitter parse-only fallback

ai-backend/ai-engine/bench/
  __init__.py
  corpus/.gitkeep              Wave-1 target: 50 fixtures
  harness.py                   Runs the pipeline against the corpus
  metrics.py                   Critic prec/recall, latency, score summary
  report.py                    Markdown report + CI gates

synthi/src/app/api/shadow/
  run/route.js                 POST /api/shadow/run
  verify-only/route.js         POST /api/shadow/verify-only
  [jobId]/stream/route.js      GET  /api/shadow/[jobId]/stream  (SSE proxy)
  [jobId]/apply/route.js       POST /api/shadow/[jobId]/apply
  [jobId]/cancel/route.js      POST /api/shadow/[jobId]/cancel

synthi/src/components/chat/
  MultiverseCard.jsx           Per-job verify panel
  StalenessBadge.jsx           Soft staleness UI (master plan §8.5)
  hooks/useShadowVerify.js     SSE-backed React hook
```

Files modified:

```
ai-backend/ai-engine/main.py
  + mounts shadow_router via app.include_router

synthi/src/app/api/chat/route.js
  + fireShadowRun() helper
  + emits {shadowJob, tier, estimatedCostUsd} on first fileBlocks event
  + propagates userId through streamGeminiWithTools

synthi/src/components/chat/hooks/useAISuggestions.js
  + handles parsed.shadowJob events → appends a 'shadow' role message

synthi/src/components/chat/AIChatWindow.jsx
  + renders <MultiverseCard /> for role === 'shadow' messages

backend/collab-server/server.js
  + new git action 'apply-shadow-patch' (Wave 1: direct writeFile + Yjs flush;
    Wave 1.5 replaces with text-diff-as-Yjs-ops submission)

backend/collab-server/permissionMiddleware.js
  + grants 'apply-shadow-patch' the canFileOps permission
```

### Wave 1 status by item (master plan §19 row "Wave 1")

| Item | Status | Notes |
|---|---|---|
| Single universe orchestrator | ✅ | `multiverse.run_job`, N=1 via `TIER_UNIVERSE_COUNT`. |
| Critic with executable reproducers | ✅ | Reproducer-required schema, run-the-reproducer for `edge`/`logic`. |
| Worktree pool with dep-install lock | ✅ | `worktree.WorktreePool`, lazy slot allocation, per-pool `dep_lock`. |
| Snapshot + 3-way merge | ✅ | `snapshot.create` + `git merge-file` ladder. |
| AI-rebase fallback | ✅ | Wired to Gemini provider, syntax quick-validate enforced (`snapshot._quick_validate`). |
| Yjs-aware apply | ✅ | `applyTextDiffOps` in `ySweetBridge.js` runs a line-level LCS diff and submits each hunk as a `Y.Text.delete + .insert` pair inside a single `doc.transact()`; falls back to `resetDocContent` only if Y-Sweet rejects. |
| Non-blocking verify panel | ✅ | `<MultiverseCard />` + SSE hook. |
| Pre-warming | ✅ | Pool builds slots lazily on first `acquire()`. |
| Apply-and-cancel | ✅ | `/cancel` endpoint + hook `cancel()`. `/cancel` now actually cancels every in-flight `asyncio.Task` registered on `JobState.tasks`, not just the SSE drainer. |
| Apply cancels remaining universes mid-flight | ✅ | Master plan §16 mitigation #4 + §2 UX rule. `/apply` calls `_cancel_tasks(job, keep=universeId)` before running the merge ladder; response surfaces `siblings_cancelled[]`. |
| Per-universe wall-clock cap | ✅ | Master plan §16 mitigation #5. `_run_single` wraps `Universe.run` in `asyncio.wait_for` with `UNIVERSE_TIMEOUT_SEC = {quick: 8, standard: 25, deep: 45}`. Timeout emits an error event and returns `None` so the cohort continues with partial results. |
| Apply ladder wired into `/shadow/apply` | ✅ | `shadow_apply` handler invokes `snapshot.apply_one()` per file (direct → 3-way → AI-rebase → conflict ladder), writes results to disk, and returns `merge_strategy` (worst across files) plus `per_file[]` and `files_failed[]`. |
| Staleness UI | ✅ | `<StalenessBadge />` + `staleness_detected` event. |
| Verify-only mode | ✅ | `POST /shadow/verify-only` + `multiverse.run_verify_only`. |
| Evaluation harness (50 corpus cases) | 🟡 | Harness + metrics + report shipped; corpus seeded with **6 / 50** fixtures (`py-off-by-one`, `py-type-error`, `py-dep-change`, `py-multi-file-rename`, `js-null-guard`, `js-refactor-async`). Coverage: logic-bug, type-error, refactor, multi-file, dep-change. Harness now `git init`s each fixture workspace on first run. |
| Python runner | ✅ | ruff + mypy + pytest + runtime probe (per-file `exec_module` in subprocess, captures import-time errors that no other stage catches). |
| Node runner | ✅ | eslint + tsc + vitest/jest + runtime probe (`node --check` + relative `require()` smoke for the first changed module). The full `next dev` for 5s + route-hitting probe is still Wave 3. |
| Tree-sitter fallback | ✅ | Optional dep — degrades cleanly when missing. |
| Generator revision pass | ✅ | One-pass LLM revise in `Generator.revise`, re-runs runner+critic on the revised patches. |
| Style post-hoc filter | ✅ | Hard reject on `minimalist` (>1.5× baseline LOC) and `surgical` (>1.0× and >5-line delta) in `Universe._check_style_filter`. |
| Reproducer execution depth | ✅ | `kind: edge\|logic` with `type: test` runs pytest/vitest; `type: input` synthesises a Python harness from `target` + `input`. |

### Multi-provider plumbing (Wave 2 prerequisite)

| Item | Status | Notes |
|---|---|---|
| AnthropicProvider | ✅ | `llm/providers/anthropic_provider.py`, async, key from request or `ANTHROPIC_API_KEY`. SDK is an optional dep — factory falls back to Gemini if absent. |
| OpenAIProvider | ✅ | `llm/providers/openai_provider.py`, async, key from request or `OPENAI_API_KEY`. Same optional-SDK fallback. |
| Provider factory dispatch | ✅ | `get_provider(name)` accepts `gemini\|anthropic\|openai`; unknown / missing-SDK falls back to Gemini with a warning. |
| `models.user_keys` plumbing | ✅ | `/shadow/run` request → `JobState.models` → `multiverse._make_specs` → `UniverseSpec.{provider,api_key}_{gen,critic}` → `Generator(provider,api_key)` + `Critic(provider,api_key)`. |
| Cross-paired Generator/Critic per universe | ✅ | When `models.providers` is supplied, each universe pairs gen-provider[i] with crit-provider[i+1]. Wave 1 N=1 still defaults to gemini/gemini. |
| Generator.revise honours per-universe provider/key | ✅ | Calls `provider.ask_llm(..., model=self.model, api_key=self.api_key)`. |
| AI-rebase honours per-universe provider/key | ✅ | New `ai_rebase_with(provider_name, api_key, ...)`; old `gemini_ai_rebase` is now a compat shim. |

### Wave 1 gaps remaining (carry to Wave 2)

1. **Bench corpus growth.** 6 / 50 fixtures shipped (logic-bug, type-error,
   refactor, multi-file, dep-change). The remaining 44 fixtures from §15.1
   should cover performance, security, multi-language refactors, and CVE
   patches drawn from public sources.
2. **Universe count tier table.** `TIER_UNIVERSE_COUNT` is `{quick:1,
   standard:1, deep:1}` in this branch. Wave 2 lifts standard/deep to N=3
   to actually exercise the cross-paired specs above.
3. **Critic LLM attacks.** The Wave 1 Critic only emits attacks derived
   from runner diagnostics. Wave 2 layers an LLM critic that emits novel
   attacks with executable reproducers (we already have
   `parse_llm_attacks` + the run-the-reproducer harness).
4. **Cost gate using cross-paired models.** `TIER_COST_USD` still uses
   single-model estimates. Wave 2 needs per-provider rate cards so
   `estimated_cost_usd` reflects the real (gen, critic) tuple per universe.

---

## Wave 2 — 3-universe parallel + Arbiter + Critic-Critic

Files created on this branch:

```
ai-backend/ai-engine/shadow/
  project_signals.py           Cheap project type / lang / test-framework / CI detection
  critic_critic.py             Pedantry filter (deterministic baseline + optional LLM)
  convergence.py               Normalized-content similarity + consensus detection
  arbiter.py                   Compressed evidence bundle + strict-schema verdict + validator

synthi/src/components/chat/
  ArbiterCard.jsx              Verdict + consensus + low-confidence variants
```

Files modified:

```
ai-backend/ai-engine/shadow/multiverse.py
  + TIER_UNIVERSE_COUNT lifted to {quick:1, standard:3, deep:3}
  + per-provider rate card (_PROVIDER_RATE_USD) feeding estimate_cost(specs, tier)
  + estimate_cost_for_request(tier, models) consumed by /shadow/run response
  + signals = detect_signals(repo) shared across universes
  + N>1 path: _run_with_convergence() fans out via asyncio.create_task,
    drains via as_completed, cancels pending when ≥2 universes converge
  + post-cohort: detect_convergence → emit convergence_detected + skip Arbiter,
    else build_evidence_bundle → adjudicate → emit arbiter_verdict
ai-backend/ai-engine/shadow/universe.py
  + accepts `signals: ProjectSignals`; runs filter_pedantic between
    reproducer execution and revise pass (and again post-revise)
ai-backend/ai-engine/shadow/api.py
  + /shadow/run uses estimate_cost_for_request(tier, models) for response
synthi/src/components/chat/hooks/useShadowVerify.js
  + tracks convergence + cohort; surfaces both alongside arbiter verdict
synthi/src/components/chat/MultiverseCard.jsx
  + renders <ArbiterCard /> when verdict or convergence present
```

### Wave 2 status by item (master plan §19 row "Wave 2")

| Item | Status | Notes |
|---|---|---|
| 3-universe parallel orchestrator | ✅ | `TIER_UNIVERSE_COUNT={quick:1,standard:3,deep:3}`; `_run_with_convergence` fans out with as-completed cancellation. |
| Arbiter with compressed evidence | ✅ | `arbiter.build_evidence_bundle` (~1KB typical) + `adjudicate(bundle, universes, …)`. |
| Strict-schema verdict + validator | ✅ | `_validate` enforces single winner, evidence-grounded rationale, and warning-on-failing-tests. One re-prompt on validation failure, then deterministic fallback. |
| Provider rotation for Arbiter | ✅ | `select_arbiter_provider(universes, forbid_in_run=True)` — least-used provider in the run; falls back to least-used overall when all are used. |
| Critic-Critic pedantry filter | ✅ | Deterministic ruleset + optional LLM pass via `filter_pedantic_with_llm`. Demoted attacks become severity=low and never trigger revise. |
| Project-signals detection | ✅ | `project_signals.detect()` walks workspace (capped at 4k files); shared across universes. |
| Convergence detection | ✅ | `detect_convergence()` uses normalized-content min-similarity ≥ 0.92; cancels pending universes and skips Arbiter. |
| `convergence_detected` + `arbiter_verdict` events | ✅ | Already wired in `events.py`; emitted from multiverse on consensus / verdict. |
| Per-provider rate cards | ✅ | `_PROVIDER_RATE_USD` for {anthropic, openai, gemini} × {gen, critic, arbiter, critic_critic, revise}; `estimate_cost(specs, tier)` floors against tier ceiling. |
| `<ArbiterCard />` frontend | ✅ | Decided / uncertain / consensus variants. Surfaced inside `<MultiverseCard />` once a verdict or convergence event arrives. |
| Cross-paired Generator/Critic across N=3 | ✅ | `_make_specs` already cross-pairs; with the lifted tier table this is now actually exercised. |

### Wave 2 gaps remaining (carry to Wave 3)

1. **Bench corpus growth.** Still 6 / 50 fixtures. The §15.3 CI gates (Critic
   precision ≥ 0.70, recall ≥ 0.60, **Arbiter top-1 agreement ≥ 0.80**, apply
   success ≥ 0.95, p95 latency ≤ 14.4s) need ≥30-40 fixtures to be statistically
   meaningful. The Arbiter agreement metric is computed by `metrics.py` against
   `golden_patch.diff`/`golden_tests/` which most fixtures don't yet have.
2. **Two-stage Arbiter on oversize bundles** (master plan §11.1, slated Wave 3).
   The bundle compresses to ~1KB in the typical case (validated above); at 8K+
   tokens we'd add a Summarizer pass.
3. **Scoring weight re-tune from harness.** Master plan §10 / §15 — the harness
   should grid-search the §10 weights against a sufficient corpus before Wave 2
   GA. Tied to (1).
4. **`[Why?]` button** (master plan §22) — opens a follow-up chat asking the
   Arbiter to defend or revise its verdict. Frontend wire-up only; the Arbiter
   already has the bundle to re-prompt on.

## Wave 3 — runtime probes + crossover + Go/Rust/HTML

⚪ Not started.

## Wave 4 — continuous shadow + few-shot preference + cost dashboard

⚪ Not started.

## Wave 5 — closure-aware fragment crossover (research, flagged)

⚪ Not started.

---

## Running the harness

```bash
cd ai-backend/ai-engine
python -m bench.harness --corpus bench/corpus --out bench/report.md
```

The report renders pass/fail against the §15.3 CI gates:
- Critic precision ≥ 0.70
- Critic recall ≥ 0.60
- Apply success rate ≥ 0.95
- Per-tier latency p95 ≤ 14.4s (standard tier 12s + 20%)

With an empty corpus the report annotates "Wave 1 status: corpus is empty".

## Environment knobs

| Variable | Default | Purpose |
|---|---|---|
| `SHADOW_VERIFY_ENABLED` | `true` | Master kill switch on the chat → /shadow/run kick-off. |
| `SHADOW_VERIFY_DEFAULT` | `standard` | Tier used when chat fires shadow run. |
| `CODE_INTEL_URL` / `AI_ENGINE_URL` | `http://localhost:8000` | Target for the Next.js /api/shadow/* proxies. |
