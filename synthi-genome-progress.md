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
| Yjs-aware apply | ✅ | `applyTextDiffOps` in `ySweetBridge.js` does common-prefix/suffix CRDT hunks; falls back to direct write only if Y-Sweet rejects. |
| Non-blocking verify panel | ✅ | `<MultiverseCard />` + SSE hook. |
| Pre-warming | ✅ | Pool builds slots lazily on first `acquire()`. |
| Apply-and-cancel | ✅ | `/cancel` endpoint + hook `cancel()`. |
| Staleness UI | ✅ | `<StalenessBadge />` + `staleness_detected` event. |
| Verify-only mode | ✅ | `POST /shadow/verify-only` + `multiverse.run_verify_only`. |
| Evaluation harness (50 corpus cases) | 🟡 | Harness + metrics + report shipped; corpus seeded with **2 / 50** fixtures (`py-off-by-one`, `js-null-guard`). Harness now `git init`s each fixture workspace on first run. |
| Python runner | ✅ | ruff + mypy + pytest. |
| Node runner | ✅ | eslint + tsc + vitest/jest. |
| Tree-sitter fallback | ✅ | Optional dep — degrades cleanly when missing. |
| Generator revision pass | ✅ | One-pass LLM revise in `Generator.revise`, re-runs runner+critic on the revised patches. |
| Style post-hoc filter | ✅ | Hard reject on `minimalist` (>1.5× baseline LOC) and `surgical` (>1.0× and >5-line delta) in `Universe._check_style_filter`. |
| Reproducer execution depth | ✅ | `kind: edge\|logic` with `type: test` runs pytest/vitest; `type: input` synthesises a Python harness from `target` + `input`. |

### Wave 1 gaps remaining (carry to Wave 2)

1. **Multi-provider models.** The ai-engine currently only ships Gemini
   (`llm/providers/factory.py:5`). Plan §5 references Anthropic/OpenAI/Gemini
   in `models.providers` + `user_keys`. Wiring user-supplied keys into the
   Generator/Critic call path is required for Wave 2's cross-validation.
2. **Bench corpus growth.** 2 / 50 fixtures shipped. Wave 1 §15.1 calls for
   a full 50, drawn from real bug fixes (ours, public CVE patches, OSS
   commits) covering Python, TS/JS, multi-file, dep-change, refactor,
   performance, type-error, logic bug.
3. **CRDT diff granularity.** `applyTextDiffOps` collapses any change into a
   single common-prefix/suffix hunk. That's correct but coarse — concurrent
   edits in the changed *region* still get clobbered. A line-level diff
   (Myers, fast-diff, or `diff-match-patch`) lands in Wave 2 alongside the
   convergence detector that benefits from per-hunk fingerprinting.

---

## Wave 2 — 3-universe parallel + Arbiter + Critic-Critic

⚪ Not started. Module skeletons referenced from `multiverse.py` (`TIER_UNIVERSE_COUNT`, `_make_specs`) make this a configuration flip plus three new files: `critic_critic.py`, `arbiter.py`, `convergence.py`, `project_signals.py`, plus `<ArbiterCard />` on the frontend.

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
