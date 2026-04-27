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
| AI-rebase fallback | 🟡 | Wired to Gemini provider; lint-pass sanity check pending. |
| Yjs-aware apply | 🟡 | collab-server endpoint `apply-shadow-patch` lands as direct-write today; text-diff-as-Yjs-ops submission deferred to Wave 1.5. |
| Non-blocking verify panel | ✅ | `<MultiverseCard />` + SSE hook. |
| Pre-warming | ✅ | Pool builds slots lazily on first `acquire()`. |
| Apply-and-cancel | ✅ | `/cancel` endpoint + hook `cancel()`. |
| Staleness UI | ✅ | `<StalenessBadge />` + `staleness_detected` event. |
| Verify-only mode | ✅ | `POST /shadow/verify-only` + `multiverse.run_verify_only`. |
| Evaluation harness (50 corpus cases) | 🟡 | Harness + metrics + report shipped; corpus is empty (0/50). |
| Python runner | ✅ | ruff + mypy + pytest. |
| Node runner | ✅ | eslint + tsc + vitest/jest. |
| Tree-sitter fallback | ✅ | Optional dep — degrades cleanly when missing. |

### Wave 1 gaps (TODO before Wave 2)

1. **Multi-provider models.** The ai-engine currently only ships Gemini
   (`llm/providers/factory.py:5`). Plan §5 references Anthropic/OpenAI/Gemini
   in `models.providers` + `user_keys`. Wiring user-supplied keys into the
   Generator/Critic call path is required before Wave 2's cross-validation.
2. **Generator revision.** `Generator.revise()` is intentionally a no-op in
   Wave 1 (`[revision-skipped:wave1]`). Implementing the one-pass revise
   needs the multi-provider work above so we don't block on it.
3. **AI-rebase quick-validate.** Master plan §8.3 says the AI-rebase output
   should be run through one quick lint+type pass before being accepted.
   Wired but not yet enforced.
4. **Yjs-aware apply (master plan §8.4).** Today `apply-shadow-patch` writes
   the patched file directly. Wave 1.5 replaces this with a text-diff-as-ops
   submission so concurrent edits merge via the CRDT.
5. **Bench corpus.** The harness runs end-to-end but `bench/corpus/` is empty.
   §15.1 target is 50 fixtures.
6. **Reproducer execution depth.** Wave 1 runs `kind: edge|logic` reproducers.
   `kind: input` reproducers are recorded but not executed (deferred to W2).
7. **Style post-hoc filter.** `minimalist` is wired through the Generator
   request but the LOC-overrun rejection only affects the score, not the
   universe outcome. Master plan §6.1 calls for a hard reject.

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
