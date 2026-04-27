# Synthi Genome — Master Plan

A deep verification system for the AI chat. Beats Cursor's Shadow Workspace by running real toolchains in real worktrees, having an opposing AI generate executable attacks against each patch, and (from Wave 2) running multiple universes with cross-model adversaries that an Arbiter then ranks with a grounded rationale.

## 1. Executive summary

When the chat assistant emits code changes, a sidecar verification system runs in parallel with the chat reply. The user sees verified options, not LLM guesses, and can apply with confidence.

- **Wave 0** (already written, uncommitted): inline-completion overhaul + tokenized ghost text + multi-provider chat (Anthropic, OpenAI, Gemini) with logos and per-provider keys + RAG: HyDE + chat-history rewrite.
- **Wave 1**: single universe + adversarial Critic with executable reproducers + non-blocking verify panel + state-sync infrastructure + Verify-only mode + offline evaluation harness.
- **Wave 2**: 3-universe parallel + multi-model cross-validation + Minimalist Universe + Critic-Critic filter + Arbiter with compressed evidence schema + convergence detection + domain calibration.
- **Wave 3**: change-level crossover + 2-stage Arbiter for oversize bundles + runtime probes + Go/Rust/HTML runners.
- **Wave 4**: continuous shadow (regression-trigger only) + few-shot preference learning + cost dashboard.
- **Wave 5** (research, behind feature flags): closure-aware fragment crossover + surgical style.

## 2. Vision & user experience

### One-paragraph vision

When the chat assistant emits code changes, a sidecar verification system runs in parallel: multiple universes each independently propose a patch using a different (Generator, Critic) model pair, apply it to a real git worktree, run the actual language toolchain (lint, types, tests, runtime), and survive an adversarial Critic that must produce executable attacks. An Arbiter LLM — distinct from every Generator and Critic in the run — then ranks the survivors with a grounded rationale, optionally synthesizing the best of multiple universes into a recommendation. The user sees real evidence, not LLM claims.

### What the user sees

```
┌─ Arbiter (Gemini) ──────────────────────────────────┐
│  ⚖  Recommends Universe A  ·  85% confidence        │
│  Why: directly fixes the root cause + adds the      │
│       regression test all three earlier attempts    │
│       forgot to write.                              │
│  Trade-offs: A safest · C simplest · B fastest      │
│  ⚠ Avoid C: removes a check protecting another path │
│  [ Apply A ]  [ Compare ]  [ Override ]  [ Why? ]   │
└─────────────────────────────────────────────────────┘
┌─ Verify Panel ──────────────────────────────────────┐
│ Universe A · Claude→GPT critic    ✓ verified        │
│   0 lint · 0 type · 8/8 tests · 4 attacks survived  │
│   [Apply]  [Diff]                                   │
│                                                     │
│ Universe B · GPT→Gemini critic    ⚠ 1 type error    │
│   ts(2345): argument of type… [Re-run]              │
│                                                     │
│ Universe C (minimalist) · −42 LOC ✓ verified        │
│   0 lint · 0 type · 8/8 tests                       │
│   [Apply]  [Diff]                                   │
└─────────────────────────────────────────────────────┘
🛡 verifying src/auth.ts ─ keep editing if you like
```

### UX rules (non-negotiable)

- The chat reply is never blocked by verify; verify is a sidecar.
- Universes appear as they finish, not in a batch.
- Clicking Apply on one universe cancels the others mid-flight.
- A `[Why?]` button on the Arbiter card opens a follow-up conversation about its verdict.
- The user can override the Arbiter; the override becomes preference signal.
- A global toggle: `Verify: off / quick / standard / deep`.
- A standalone Verify button on user-written code runs lint+type+tests with no LLM in the loop.
- While verify runs, a soft staleness badge shows which files are being verified — user keeps full control.

## 3. Architecture

```
┌─ synthi (Next.js frontend) ─────────────────────────────────────┐
│  AIChatWindow.jsx                                               │
│   ├─ existing chat NDJSON                                       │
│   ├─ <ArbiterCard jobId={...} />     ← Wave 2+                  │
│   ├─ <MultiverseCard jobId={...} />  ← Wave 1                   │
│   └─ <StalenessBadge jobId={...} />  ← Wave 1                   │
│        all driven by useShadowVerify(jobId) → SSE               │
│                                                                 │
│  /api/chat/route.js                                             │
│   ├─ existing flow                                              │
│   └─ on first FILE: block → POST {ai-engine}/shadow/run         │
│      → emit { shadowJob: jobId } in NDJSON                      │
│                                                                 │
│  /api/shadow/[jobId]/stream  ── SSE proxy → ai-engine           │
│  /api/shadow/[jobId]/apply   ── apply via collab-server         │
│  /api/shadow/[jobId]/cancel  ── kill remaining universes        │
│  /api/shadow/verify-only     ── Verify-only mode (Wave 1)       │
└─────────────────────────────────────────────────────────────────┘
┌─ ai-engine (FastAPI) ───────────────────────────────────────────┐
│  shadow/                                                        │
│   ├─ api.py             POST /run, GET /stream/{id},            │
│   │                     POST /apply/{id}/{universe}, /cancel    │
│   │                     POST /verify-only                       │
│   ├─ multiverse.py      Orchestrator. Spawns universes,         │
│   │                     gathers, invokes Arbiter, streams       │
│   ├─ universe.py        One Generator + one Critic + Runner     │
│   ├─ generator.py       LLM patch generator with style profile  │
│   ├─ critic.py          Adversarial attacks with executable     │
│   │                     reproducers                             │
│   ├─ critic_critic.py   Pedantry filter (Wave 2+)               │
│   ├─ arbiter.py         Cross-universe judge (Wave 2+)          │
│   ├─ worktree.py        Pre-warmed git worktree pool +          │
│   │                     dep-install serialization               │
│   ├─ snapshot.py        Source state snapshot + 3-way merge     │
│   │                     + AI-rebase fallback                    │
│   ├─ runner/                                                    │
│   │   ├─ base.py        Runner protocol + wall-clock budgets    │
│   │   ├─ python.py      ruff + mypy + pytest                    │
│   │   ├─ node.py        eslint + tsc + vitest/jest + dev-srv    │
│   │   ├─ go.py          (Wave 3)                                │
│   │   ├─ rust.py        (Wave 3)                                │
│   │   ├─ html.py        (Wave 3)                                │
│   │   └─ syntax.py      tree-sitter parse-only fallback         │
│   ├─ scoring.py         Composite score                         │
│   ├─ events.py          NDJSON event types streamed via SSE     │
│   ├─ regression_log.py  Snapshots accepted patches' tests       │
│   ├─ convergence.py     Detect when universes converge → ↓N     │
│   ├─ crossover.py       Change-level crossover (Wave 3)         │
│   └─ project_signals.py Domain calibration (Wave 2+)            │
│                                                                 │
│  shadow_continuous/                            (Wave 4)         │
│   ├─ watcher.py         Listens to collab-server file events    │
│   ├─ regression_runner.py  Pass→fail trigger only (no idle ping)│
│   └─ preference.py      Few-shot preference store               │
│                                                                 │
│  bench/                                        (Wave 1 — eval)  │
│   ├─ corpus/            Patch fixtures with known-correct fixes │
│   ├─ harness.py         Runs full pipeline against corpus       │
│   ├─ metrics.py         Critic precision/recall, Arbiter accy,  │
│   │                     universe N+1 marginal value, latency    │
│   └─ report.py          Markdown report + CI threshold gates    │
└─────────────────────────────────────────────────────────────────┘
```

## 4. End-to-end data flow

```
1.  User: "fix the auth bug where expired tokens still pass"
2.  Frontend → POST /api/chat (existing)
3.  Chat route streams Claude's reply with FILE: blocks
4.  On first FILE: block → fire POST /shadow/run with:
      { workspace_path, conversation_id, patches, intent, tier,
        models: { providers, user_keys }, user_id }
    ai-engine returns { jobId, tier, estimated_cost_usd }
5.  Chat route appends { "shadowJob": jobId } to NDJSON
6.  Frontend opens SSE: /api/shadow/{jobId}/stream
7.  Multiverse orchestrator:
      a. snapshot.create()  →  shadow_base = { file hashes, yjs clock }
      b. Acquire N worktrees from pool
      c. For each (model_pair, style):
         - Generator(provider_A, style) → patch
         - apply patch to worktree
         - Runner.run(worktree) → diagnostics, tests, runtime
         - Critic(provider_B).attack(patch, diagnostics)
            → mandatory executable reproducers
         - Run reproducers in worktree (real tests)
         - Critic-Critic filters non-executable pedantry  (Wave 2+)
         - if blocking attack survived → Generator.revise (1 pass)
         - re-Run if revised
         - emit SSE: { type: "universe_done", id, score, ... }
      d. (Wave 2+) Convergence check: if all done universes are
         essentially identical → cancel pending, mark "consensus"
      e. (Wave 2+) Arbiter receives compressed evidence bundle
         → emit SSE: { type: "arbiter_verdict", winner, rationale }
8.  User clicks Apply on a universe (or Arbiter's pick)
9.  Frontend → POST /api/shadow/{jobId}/apply { universeId }
10. snapshot.apply():
      → for each file: hash-compare, 3-way merge, or AI-rebase
      → submit final diff as Yjs ops via collab-server
11. regression_log snapshots the universe's tests
12. preference.add_example(prompt, accepted_patch)
```

## 5. Data contracts

### POST /shadow/run

```json
{
  "workspace_path": "az3a08t9/113239851",
  "conversation_id": "cs_abc123",
  "intent": "fix" | "implement" | "refactor" | "explain",
  "patches": [
    { "path": "src/auth.ts",
      "blocks": [{ "search": "...", "replace": "..." }] }
  ],
  "tier": "quick" | "standard" | "deep",
  "models": {
    "providers": ["anthropic", "openai", "google"],
    "user_keys": { "anthropic": "...", "openai": "..." }
  }
}

→ { "jobId": "shd_...", "tier": "standard", "estimated_cost_usd": 0.012 }
```

### SSE events on /shadow/{jobId}/stream

```json
{ "type": "job_started", "tier": "standard", "universes_planned": 3 }
{ "type": "snapshot_taken", "files": ["src/auth.ts"] }
{ "type": "universe_started", "id": "A",
  "model_gen": "claude-sonnet-4-6", "model_critic": "gpt-4o",
  "style": "safe" }
{ "type": "universe_progress", "id": "A",
  "stage": "applying" | "linting" | "type-checking" | "testing"
         | "running" | "critiquing" | "revising" }
{ "type": "universe_done", "id": "A", ... compressed evidence ... }
{ "type": "convergence_detected", "downgrading_to": 1 }      // Wave 2+
{ "type": "staleness_detected", "files": ["src/auth.ts"] }
{ "type": "arbiter_verdict", ... }                           // Wave 2+
{ "type": "all_done", "winner": "A" }
{ "type": "error", "stage": "...", "msg": "..." }
```

### POST /shadow/{jobId}/apply

```json
{ "universeId": "A" }

→ { "applied": true, "files": [...], "merge_strategy": "direct" | "3way" | "ai-rebase" }
```

### POST /shadow/verify-only (Wave 1)

```json
{
  "workspace_path": "...",
  "patches": [...],          // user's own edits
  "tier": "quick" | "standard"
}

→ same SSE stream, but no Generator/Critic — just Runner.
```

## 6. The four LLM roles

### 6.1 Generator

Produces a patch in a given style. Style is a prompt prefix; some styles get post-hoc filters that reject non-conforming output (frontier models often ignore prefix hints).

| Style | Prompt bias | Post-hoc filter | LOC penalty |
|---|---|---|---|
| safe | Conservative fix. Add defensive checks. Preserve API surface. | none | none |
| idiomatic | Match the codebase's existing patterns. Prefer clarity over cleverness. | none | none |
| minimalist | Smallest possible patch. Prefer modify over add. Look for opportunities to remove. No defensive programming unless required. | reject patches that grow > 1.5× baseline LOC | 1.5× threshold, score penalty |
| surgical (Wave 5, flagged) | Absolute minimum keystrokes. One-character fixes preferred. | reject patches > 5 lines unless required | 1.0× threshold |

**Inputs**: user request, code-intel context, regression-log tests, style hint, few-shot preference examples (last N accepted patches from this user).

### 6.2 Critic

Reads the patch + diagnostics. Outputs attacks with mandatory executable reproducers.

```json
{
  "kind": "edge|race|type|import|logic|perf|security",
  "msg": "...",
  "severity": "blocking|high|medium|low",
  "reproducer": {
    "type": "test|input|trace",
    "code": "...",        // an actual test snippet OR
    "input": {}           //   an actual input value
  }
}
```

**Hard guards:**

- **Reproducer-required schema** — attacks without reproducers are dropped before Critic-Critic.
- **Run-the-reproducer for kind: edge|logic** — reproducer is executed in the worktree. Test passes → attack pedantic. Test fails → attack proven real.
- **Severity gates revision** — only `blocking` triggers a revise; max 1 revision pass.
- **At most 5 attacks per universe** — forces prioritization.
- **Survival rewards** — score formula favors patches with no real flaws found, not patches that addressed every concern.

### 6.3 Critic-Critic (Wave 2+)

Cheap fast model (Haiku/Flash). Reviews each non-executable attack against detected project signals.

```
Project type: {web-app|library|hobby script|...}
Test framework: {detected}
Has CI: {true|false}
Style guide: {inferred from existing code}
Is this attack actionable for THIS project, or pedantic?
Pedantic = generic best-practice that doesn't apply, theoretical concern with
no reproducer, enterprise concern in a hobby project, style nit.
Attack: {...}
Output: {"verdict": "actionable" | "pedantic", "reason": "..."}
```

Pedantic attacks demoted to `severity: low`, never trigger revision, surfaced only as informational notes.

### 6.4 Arbiter (Wave 2+)

Distinct from every Generator and Critic in the run. Selected by rotation: whichever provider was least used among Generators/Critics in this run. Sees a compressed evidence bundle (see §11).

**Strict-schema output:**

```json
{
  "winner": "A",
  "confidence": 0.85,
  "rationale": "Universe A directly fixes the root cause … survived strongest attack. Universe B passes existing tests but doesn't add coverage; bug could regress. Universe C deletes the validation path that's reused by the API key check.",
  "ranking": ["A", "B", "C-minimalist"],
  "tradeoffs": [
    { "axis": "safety",      "winner": "A" },
    { "axis": "simplicity",  "winner": "C-minimalist" },
    { "axis": "performance", "winner": "B" }
  ],
  "warnings": [ "C-minimalist removes a check protecting an unrelated code path." ],
  "synthesis": {
    "recommended": false,
    "explanation": null,
    "instruction": null
  }
}
```

**Hard guards:**

- **No sycophancy** — schema requires single winner. Tie-break on lower LOC delta.
- **Evidence-grounded rationale** — must reference at least one concrete data point. Validator rejects+re-prompts once.
- **Cannot override hard facts** — picking a universe with failing tests requires an explicit acknowledging warning, otherwise validator rejects.
- **Honest confidence** — below 0.6, UI shows "Arbiter is uncertain — review all" instead of a recommendation.
- **Synthesis-only crossover** — when `synthesis.recommended: true`, the Arbiter explicitly describes which fragments to combine. This drives a safer crossover than blind genetic stitching.

## 7. Worktree pool & dependency handling

Pre-warmed pool at `repos/{slug}/{user}/.shadow/wt_{0..3}` per workspace. Sibling to the existing repo data so file paths and permissions stay consistent.

### 7.1 Acquire / release

```python
@contextmanager
def acquire(workspace_path):
    wt = pool.checkout(workspace_path)
    git("stash", "--include-untracked", cwd=wt)
    git("reset", "--hard", "HEAD", cwd=wt)
    git("clean", "-fdx", "-e", ".shadow-cache", cwd=wt)
    try:
        yield wt
    finally:
        git("reset", "--hard", "HEAD", cwd=wt)
        git("clean", "-fdx", "-e", ".shadow-cache", cwd=wt)
        pool.return_(wt)
```

Cold start (first request per workspace): ~1.5s for 4 worktrees. Warm acquire: <100ms.

### 7.2 Shared dependency stores (read-only fast path)

`node_modules`, `venv/`, `target/` symlinked from `repos/{slug}/{user}/.shadow/_shared/` into each worktree. Read-only access is parallel-safe.

### 7.3 The dep-install race condition (the real fix)

**Problem**: a patch that adds a dep triggers `npm install`, which mutates the shared store. Parallel universes that both add deps will race.

**Fix — three-tier strategy:**

1. **Detect dep changes at apply time**: diff of `package.json`, `requirements.txt`, `Cargo.toml`, `go.mod`, etc.
2. **No dep change** → use shared store via symlink. (Common case, fast path.)
3. **Dep change** → break the symlink for that universe, copy `node_modules` into the worktree (or skip by running `npm ci --prefer-offline --no-audit` against the worktree's local store), and acquire a per-workspace install lock so two universes never install concurrently.
4. **Lock contention** → second universe waits up to 8s; if still locked, falls back to "skip dep install, mark `deps_unverified: true`" and the universe's runtime tier is downgraded to lint-only.

Per-universe install fallback is slow (5-30s) but rare in practice — most patches don't change deps. The lock+fallback model prevents both correctness bugs (race) and tail-latency disasters (every universe installing in parallel).

## 8. State sync & apply

The killer real-world failure mode: user keeps editing while shadow runs (12-30s); applying the winning patch corrupts their edits or merge-conflicts.

### 8.1 Snapshot at job start

```python
job.shadow_base = {
    "files": { path: sha256(content) for path in patches },
    "yjs_clock": collab_server.get_clock(workspace, paths)
}
```

### 8.2 Three-way merge ladder

At apply time, for each file in the patch:

```
┌─────────────────────────────────────────────────────────┐
│ Case 1: hash unchanged since snapshot                   │
│         → apply directly. Clean.                        │
├─────────────────────────────────────────────────────────┤
│ Case 2: file changed, but user touched DIFFERENT hunks  │
│         → 3-way merge via `git merge-file`              │
│           (base=snapshot, ours=current, theirs=patched) │
│         → if no conflicts, apply.                       │
├─────────────────────────────────────────────────────────┤
│ Case 3: user touched SAME hunks                         │
│         → AI-rebase fallback (8.3)                      │
└─────────────────────────────────────────────────────────┘
```

### 8.3 AI-rebase fallback

When `git merge-file` reports conflict markers, send (base, ours, theirs) to a fast model. Output is run through one quick lint+type pass in the worktree. Pass → apply. Fail or REFUSE → surface to user with "Apply anyway" / "Re-verify on current code" options.

### 8.4 Yjs-aware apply

Never replace file content. Compute textual diff between `shadow_base` and `shadow_patched`, submit hunks as Yjs edit ops via collab-server. CRDT handles concurrent edits — if user typed at line 5 while patch added lines 50-58, both end up in the document with no conflict.

This requires touching `backend/collab-server/` to expose a submit-text-diff-as-ops endpoint. Added to Wave 1 file list.

### 8.5 Staleness UI

Soft badge during the run:

```
🛡 verifying src/auth.ts ─ keep editing if you like
```

Turns amber when user edits a verifying file. Universe gets `stale_at_apply: true`; apply path goes through 3-way merge / AI-rebase. If `quick` tier and staleness detected, orchestrator aborts (cheap to restart on the new state).

## 9. Toolchain matrix

| Language | Lint | Types | Tests | Runtime | Wave |
|---|---|---|---|---|---|
| Python | `ruff check` | `mypy --hide-error-context` | `pytest -x --timeout=10` (changed-modules only) | venv subprocess, capture stderr | 1 |
| TS / JS | `eslint --no-error-on-unmatched-pattern` | `tsc --noEmit --incremental` | `vitest run --changed` or `jest -o` | `next dev` for 5s, hit changed routes | 1 |
| Anything else | tree-sitter parse | — | — | — | 1 |
| Go | — | `go vet` | `go test -timeout 10s ./...` | — | 3 |
| Rust | `cargo clippy --no-deps` | `cargo check` | `cargo test --no-run` | — | 3 |
| HTML/CSS | htmlhint / stylelint | — | — | headless Chromium snapshot diff | 3 |

Wall-clock budgets per stage: 5s lint, 8s types, 10s tests, 6s runtime. Over-budget → "didn't finish" mark, doesn't fail the universe.

## 10. Scoring

```
score = (
    0.30 * critic_survival_rate           # attacks survived / total real attacks
  + 0.25 * (1 - normalized_diagnostics)   # 0 errors → 1.0
  + 0.20 * test_pass_rate
  + 0.10 * runtime_clean
  + 0.10 * style_match                    # similarity to user's accepted-patch examples
  + 0.05 * loc_delta_quality              # mild reward for smaller patches; penalty for minimalist universes that exceed threshold
)
```

These weights are starting values. The Wave 1 evaluation harness re-tunes them empirically before Wave 2 ships. **No production weight stays a guess.**

## 11. Compressed evidence schema (Arbiter input, Wave 2+)

Fixes "lost in the middle" by making the bundle dense before the LLM ever sees it.

```json
{
  "request": "fix expired-token bug",
  "intent": "fix",
  "project_signals": { "type": "web-app", "test_framework": "vitest" },
  "universes": [
    {
      "id": "A",
      "style": "safe",
      "model_pair": ["claude-sonnet-4-6", "gpt-4o"],
      "diff": "@@ -42,3 +42,8 @@ function verify(...)",
      "diagnostics": {
        "lint":    "clean",
        "types":   "clean",
        "tests":   "8/8 passed (2 new)",
        "runtime": "clean"
      },
      "attacks": {
        "tested":   4,
        "survived": 4,
        "failed":   []
      },
      "loc": "+12 −4",
      "score": 0.92
    },
    {
      "id": "B",
      "diagnostics": {
        "types": [
          { "code": "ts(2345)", "msg": "argument of type X not assignable",
            "at": "src/auth.ts:42" }
        ],
        "tests": "8/8 passed"
      },
      "attacks": {
        "tested": 3, "survived": 2,
        "failed": [
          { "msg": "exp claim missing", "severity": "high",
            "reproducer_test": "expect(verify({})).toThrow()" }
        ]
      },
      "loc": "+8 −2",
      "score": 0.71
    }
  ]
}
```

**Encoder rules:**

- Diffs only, never full files. Patch context = 3 lines on each side.
- Successful results compressed to one-word summaries.
- Failure detail only for failures.
- Attacks: only the failed ones (real flaws); survived attacks contribute a count.
- Per-universe summary at start AND end (sandwich pattern).

A typical 30 KB raw bundle compresses to ~2.5 KB.

### 11.1 Two-stage Arbiter (Wave 3)

When the bundle exceeds 8 K tokens, a Summarizer (Haiku/Flash) reduces each universe to a structured 200-token brief; the Judge (smarter model) sees only the briefs. Adds ~1.5 s but eliminates lost-in-the-middle on `deep` tier.

## 12. Convergence detection (Wave 2+)

When all completed universes produce essentially identical patches (common for simple fixes), running 3-of-3 burns 3× compute for zero value.

```python
def detect_convergence(done_universes):
    if len(done_universes) < 2:
        return None
    diffs = [u.normalized_diff for u in done_universes]
    if all(unified_similarity(d, diffs[0]) > 0.92 for d in diffs[1:]):
        return ConvergenceResult(consensus_universe=done_universes[0])
    return None
```

When convergence is detected after the second universe finishes:

- Cancel remaining pending universes
- Skip Arbiter (no judgment needed)
- Emit `convergence_detected` event
- UI shows a single card: "Consensus — both attempts produced the same fix"

Saves 30-50% of compute on simple-fix workloads.

## 13. Few-shot preference learning (Wave 4 — replaces EMA vector approach)

Per `(user, repo)`, keep a rolling list of the last N (default 8) accepted patches as structured examples:

```json
{
  "request_summary": "validate JWT exp claim",
  "accepted_diff": "...",
  "style": "safe",
  "model_pair": ["claude-sonnet-4-6", "gpt-4o"],
  "loc": "+12 -4",
  "ts": "2026-04-22T14:30:00Z"
}
```

At Generator time, the most-similar 2-3 examples (by request embedding) are included as in-context few-shot. **No EMA, no preference vector, no "summarize vector to natural language" hallucination layer.**

**Why this beats the EMA approach**: the EMA was over-engineered for what's fundamentally a few-shot problem. Direct examples preserve concrete style signal (bracket placement, error-handling, comment density) without lossy compression. Storage cost is trivial (8 examples × ~2 KB = 16 KB per user-repo).

## 14. Continuous shadow (Wave 4 — pass→fail trigger only)

Subscribes to collab-server file-change events. The 10-minute idle ping is cut — signal-to-noise was poor and the existing pass→fail trigger is much stronger.

```
File save event → debounce 800ms
  → identify affected modules via existing dependency graph
  → run regression-log tests for those modules in a worktree
  → if pass→fail: surface chat-panel suggestion
       "you broke `auth.test.ts:42`, want me to look?"
```

Cheapest models only when surfacing a fix offer. Hard cap $0.50/day per workspace. Opt-out per workspace.

## 15. Evaluation harness (Wave 1 deliverable, not a "nice-to-have")

Without this, every scoring weight, every threshold, every "is the Arbiter helping?" answer is a guess. **Built in Wave 1, runs nightly in CI from Wave 2 on.**

### 15.1 Corpus

`bench/corpus/` holds patch fixtures, each:

```
bench/corpus/<id>/
  workspace/         # snapshot of a real codebase state
  request.txt        # the user's prompt
  golden_patch.diff  # the known-correct fix
  golden_tests/      # tests that pass on golden, fail on workspace
  metadata.json      # difficulty, language, intent, has_dep_change, ...
```

**Targets**: 50 cases by end of Wave 1, drawn from real bug fixes (ours, public CVE patches, popular OSS fix commits). Cover: Python, TS/JS, multi-file, dep-change, refactor, performance, type-error, logic bug.

### 15.2 Metrics

Each nightly run produces:

| Metric | What it answers |
|---|---|
| Critic precision | Of attacks Critic flagged, what fraction were real (reproducer failed)? |
| Critic recall | Of known-real bugs in corpus, what fraction did Critic catch? |
| Critic-Critic precision/recall | Same, for the pedantry filter |
| Universe N+1 marginal value | Does adding a 4th universe meaningfully improve top-1 accuracy? |
| Arbiter top-1 agreement | Does Arbiter's winner match the golden patch (or closest universe)? |
| Arbiter calibration | Among picks at confidence X%, what fraction were correct? |
| Apply success rate | Of accepted patches, what fraction merge cleanly with concurrent edits? |
| Per-tier latency p50/p95 | Are we hitting the 4s/12s/30s targets? |
| Per-tier cost p50/p95 | Are we hitting the $0.001/$0.012/$0.04 targets? |
| Convergence rate | What % of runs trigger convergence detection? |

### 15.3 CI gates

`bench/report.py` produces a markdown report. Wave 2+ PRs cannot regress these by more than threshold:

- Critic precision ≥ 0.7
- Critic recall ≥ 0.6
- Arbiter top-1 agreement ≥ 0.8
- Apply success rate ≥ 0.95
- Per-tier latency p95 within +20% of contract

A regression on any of these blocks the PR.

### 15.4 What this changes upstream

- Scoring weights in §10 are re-tuned by a small grid search against the corpus before Wave 2 GA.
- Universe count for `standard` tier is empirically validated — if N=3 and N=4 give the same accuracy, we ship N=3.
- Critic-Critic is gated on demonstrating it improves precision without crashing recall.
- Convergence threshold (0.92 above) is calibrated against the corpus.

## 16. Latency contract

Six mitigations stacked:

1. Chat reply unblocks immediately.
2. **Pre-warm during streaming**: shadow starts on the first FILE: block.
3. **Universes appear as they finish**, not batched.
4. **Apply-and-cancel** kills remaining universes mid-flight.
5. **Per-universe wall-clock cap** (25 s); partial results surface.
6. **Tier auto-selected** by intent classifier; user override via `/quick` or `/deep`.

| Tier | Use case | p95 latency | Universes | Cost |
|---|---|---|---|---|
| quick | one-line fixes | 4 s | 1, lint+type only | ~$0.001 |
| standard | typical edits | 12 s | 3, lint+type+tests | ~$0.012 |
| deep | complex refactors | 30 s | 3 + crossover, runtime | ~$0.04 |

## 17. Cost & budget controls

- Tier auto-selected; user can override.
- Every job emits `estimated_cost_usd` up-front; user can cancel.
- Hard daily cap per workspace (default $5), surfaced in the existing usage panel.
- Apply-and-cancel saves 30-60 % of compute on average.
- Cheap-model tiers (Haiku/Flash) for Critic-Critic + continuous shadow.
- Convergence detection saves 30-50 % on simple fixes.

## 18. Anti-pattern guards summary

| Role | Guard | Wave |
|---|---|---|
| Critic | Reproducer-required schema | 1 |
| Critic | Run-the-reproducer for edge/logic | 1 |
| Critic | Severity gates revision; max 1 revision | 1 |
| Critic | Survival rewards (not "fix every concern") | 1 |
| Critic | At most 5 attacks per universe | 1 |
| Critic-Critic | Domain-calibrated pedantry filter | 2 |
| Arbiter | Strict schema (no sycophancy) | 2 |
| Arbiter | Evidence-grounded rationale validator | 2 |
| Arbiter | Cannot override hard facts | 2 |
| Arbiter | Honest confidence (UI bypass below 0.6) | 2 |
| Arbiter | Cross-validation by rotation | 2 |
| Arbiter | Compressed evidence schema | 2 |
| Arbiter | Two-stage (summarize → judge) on oversize | 3 |
| Generator | Style profile + post-hoc filter for minimalist/surgical | 2 |
| Generator | Few-shot preference examples (Wave 4) | 4 |
| Crossover | Change-level only by default | 3 |
| Crossover | Hard compile-gate on every child | 3 |
| Crossover | Closure-aware fragment swap behind feature flag | 5 |

## 19. Phasing

| Wave | Branch | Scope |
|---|---|---|
| 0 (done, uncommitted) | `claude/improve-ai-features-tIX4u` | Inline completions overhaul + tokenized ghost text + multi-provider chat (Anthropic/OpenAI/Gemini) with logos & per-provider keys + RAG: HyDE + chat-history rewrite |
| 1 | follow-up | Single universe + Critic with executable reproducers + worktree pool with dep-install lock + snapshot/3-way-merge/AI-rebase + Yjs-aware apply (touches collab-server) + non-blocking verify panel + pre-warming + apply-and-cancel + staleness UI + Verify-only mode + evaluation harness with 50 corpus cases + Python/Node/tree-sitter runners |
| 2 | follow-up | 3-universe parallel + multi-model cross-validation + Minimalist Universe with post-hoc filter + Critic-Critic + domain calibration + Arbiter (basic) with compressed evidence schema + convergence detection + scoring weights re-tuned from harness |
| 3 | follow-up | Runtime probes (dev-server / pytest) + change-level crossover (1 generation, compile-gated) + Arbiter synthesis mode + two-stage Arbiter for oversize + Go/Rust/HTML runners |
| 4 | follow-up | Continuous shadow (pass→fail trigger only) + few-shot preference learning + regression-log auto-replay + cost dashboard + Arbiter learns from overrides |
| 5 (research, flagged) | feature flag | Closure-aware fragment-level crossover + surgical style |

Each wave is a self-contained PR with end-to-end value.

## 20. File map

### Wave 1 — create

```
ai-backend/ai-engine/shadow/
  __init__.py
  api.py
  multiverse.py            # single-universe orchestrator (extends in W2)
  universe.py
  generator.py
  critic.py
  worktree.py              # pool + dep-install lock
  snapshot.py              # snapshot + 3-way merge + AI-rebase
  scoring.py
  events.py
  regression_log.py
  runner/{base,python,node,syntax}.py
ai-backend/ai-engine/bench/
  corpus/                  # 50 fixtures by end of W1
  harness.py
  metrics.py
  report.py
synthi/src/app/api/shadow/[jobId]/
  stream/route.js
  apply/route.js
  cancel/route.js
synthi/src/app/api/shadow/verify-only/route.js
synthi/src/components/chat/
  MultiverseCard.jsx
  StalenessBadge.jsx
  hooks/useShadowVerify.js
```

### Wave 1 — modify

```
ai-backend/ai-engine/main.py          # mount shadow router
synthi/src/app/api/chat/route.js      # fire /shadow/run on first FILE:
synthi/src/components/chat/AIChatWindow.jsx  # render MultiverseCard
backend/collab-server/                # text-diff-as-Yjs-ops endpoint
```

### Wave 2 — create

```
ai-backend/ai-engine/shadow/critic_critic.py
ai-backend/ai-engine/shadow/arbiter.py
ai-backend/ai-engine/shadow/project_signals.py
ai-backend/ai-engine/shadow/convergence.py
synthi/src/components/chat/ArbiterCard.jsx
```

### Wave 2 — modify

```
multiverse.py                         # parallel-N orchestrator
generator.py                          # add `minimalist` style + post-hoc filter
events.py                             # arbiter_verdict, convergence_detected
scoring.py                            # weights re-tuned from harness
```

### Wave 3 — create

```
ai-backend/ai-engine/shadow/crossover.py
ai-backend/ai-engine/shadow/runner/{go,rust,html}.py
```

### Wave 4 — create

```
ai-backend/ai-engine/shadow_continuous/
  __init__.py
  watcher.py
  regression_runner.py
  preference.py
```

## 21. Risks & mitigations

| Risk | Mitigation | Wave |
|---|---|---|
| Worktree disk usage explodes | Pool capped per-workspace; LRU eviction; symlinked deps | 1 |
| Subprocess toolchains fail to install on host | Docker fallback with pinned image for `deep` tier | 3 |
| Dep install race across parallel universes | Per-workspace install lock + per-worktree fallback for dep-changing patches | 1 |
| LLM cross-pairing too expensive | Tier system; convergence detection; apply-and-cancel | 1-2 |
| Critic produces noise (vague attacks) | Reproducer-required schema; run-the-reproducer; Critic-Critic | 1-2 |
| Critic loops into over-engineering | Severity gating; max 1 revision pass | 1 |
| Arbiter sycophancy ("they all look fine") | Strict schema requires single winner | 2 |
| Arbiter overrides hard facts | Validator rejects picks of test-failing universes without warnings | 2 |
| Arbiter context window blows up | Compressed evidence schema; two-stage on oversize | 2-3 |
| User edits during verify → conflict | Snapshot + 3-way merge + AI-rebase + Yjs-aware apply + staleness UI | 1 |
| Genetic crossover produces broken stitches | Change-level by default; compile-gate; Arbiter-driven synthesis | 3 |
| Continuous shadow becomes annoying | Pass→fail trigger only (no idle ping); opt-out; daily cap | 4 |
| Style hint ignored by frontier model | Post-hoc filter rejects non-conforming Minimalist diffs | 2 |
| Preference vector hallucination | Replace EMA with few-shot examples | 4 |
| Scoring weights are guesses | Evaluation harness re-tunes empirically before Wave 2 GA | 1 |

## 22. Bonus features unlocked

- **Verify-only mode** (Wave 1): user highlights their own code, clicks Verify, gets lint/type/tests run on their patch with no LLM in the loop.
- **`[Why?]` button on Arbiter card** (Wave 2): opens a follow-up chat asking the Arbiter to defend or revise its verdict.
- **Patch composition** (Wave 3): cherry-pick file edits from one universe + tests from another. Re-validated before applying.
- **Manual override learning** (Wave 4): every override becomes preference signal.
- **Convergence consensus card** (Wave 2): when universes agree, the UI shows a single "consensus" card instead of three identical ones.

## 23. Decisions locked in

| # | Decision | Choice |
|---|---|---|
| 1 | Wave 1 scope | Single universe + Critic. Multiverse machinery designed but not enabled until Wave 2 (one universe renders through MultiverseCard). |
| 2 | Wave 1 toolchain | Python + Node + tree-sitter fallback only. Go/Rust/HTML in Wave 3. |
| 3 | Worktree home | `repos/{slug}/{user}/.shadow/wt_*` (sibling to existing repos). |
| 4 | Arbiter model assignment | Rotate — provider least used among Generators/Critics in this run. |
| 5 | Verify-only mode in Wave 1 | Yes. |
| 6 | Wave 0 commit | Hold. Ship as part of the Wave 1 PR. |

## 24. Glossary

- **Universe** — one (Generator, Critic, Runner) triple producing one patch and its evidence.
- **Generator** — LLM that proposes a patch in a given style.
- **Critic** — adversarial LLM that produces executable attacks on a patch.
- **Critic-Critic** — cheap fast filter that rejects pedantic attacks before they trigger revision.
- **Arbiter** — cross-universe judge LLM, distinct from every Generator/Critic in the run.
- **Reproducer** — a runnable test or concrete input attached to every Critic attack; without it, attack is dropped.
- **Snapshot** — file-hash + Yjs-clock state captured at job start; baseline for safe apply.
- **3-way merge** — git's textual merge between snapshot, current, and patched versions.
- **AI-rebase** — LLM-driven conflict resolver when 3-way merge produces conflict markers.
- **Compressed evidence bundle** — diff-only, failure-only, count-only summary fed to the Arbiter.
- **Convergence** — state where all completed universes agree; triggers single-universe consolidation.
- **Style profile** — Generator prompt prefix + optional post-hoc filter (safe / idiomatic / minimalist / surgical).
- **Few-shot preference** — last N accepted patches per (user, repo), included as in-context examples.
- **Verify-only mode** — runs lint/type/tests on user-written code with no LLM.
- **Wave** — a self-contained PR delivering end-to-end value.
