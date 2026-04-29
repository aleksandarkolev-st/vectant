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
      c. (Wave 2+) Spec Synthesizer: produce {do, dont, verify} from
         request + RAG context (skip if extraction fails — fall through)
      d. For each (model_pair, style):
         - Generator(provider_A, style, spec) → patch
         - apply patch to worktree
         - Runner.run(worktree) → diagnostics, tests
         - GUI stage (frontend patches only, Wave 1):
           · `synthi_compile` → wait for HMR via `synthi_wait_hmr`
             (event-driven; wall-clock fallback at 8s)
           · `synthi_describe` / `synthi_get_event_log` /
             `synthi_get_labels` → capture rendered_state
           · serialize across universes through the dev-server pool
             (default 1 server per workspace; §7.4)
         - Critic(provider_B).attack(patch, diagnostics, rendered_state, spec.verify)
            → mandatory executable reproducers (incl. render, state_break)
         - Run reproducers — tests in worktree; render+state_break against
           the live runtime via MCP tool surface
         - Critic-Critic filters non-executable pedantry (Wave 2+)
         - if blocking attack survived → Generator.revise (1 pass)
         - re-Run if revised
         - emit SSE: { type: "universe_done", id, score, ... }
      e. (Wave 2+) Convergence check: if all done universes are
         essentially identical → cancel pending, mark "consensus"
      f. (Wave 2+) Arbiter receives compressed evidence bundle
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
  },
  "rag_context": {                              // null when chat didn't use RAG
    "section_ids": ["sec_a1b2c3...", "sec_d4e5f6..."],
    "retrieved_at": "2026-04-28T10:23:00Z",
    "rag_confidence": 0.78,
    "rag_used": true
  }
}

→ { "jobId": "shd_...", "tier": "standard", "estimated_cost_usd": 0.012 }
```

**`rag_context` field semantics** (full contract: RAG plan Appendix A):

- **IDs only, never section contents.** Generators fetch via the existing RAG API. Reasons: payload bloat (sections are 5–50 KB each × 3 universes); ingest is async, so passing contents creates snapshot/index divergence.
- **`rag_used: false` / `rag_context: null`** — chat didn't ground in RAG (imperative requests like "rename function X to Y"). Multiverse runs as today, no RAG section in Arbiter card.
- **`rag_used: true`, `rag_confidence ≥ 0.6`** — run as today, no flag.
- **`rag_used: true`, `rag_confidence < 0.6`** — run, but Arbiter card shows "RAG retrieval was uncertain — review citations" banner (§6.4 hard guard).
- **RAG abstained upstream** — chat surfaces RAG's clarifying question; **Genome is not invoked at all**. Soft gate, not hard.

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
{ "type": "stale_context_detected", "section_ids": ["sec_d4e5f6..."],
  "reason": "deleted" | "migrated" }                         // RAG re-ingest during run
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

Reads the patch + diagnostics + (for frontend code) rendered state. Outputs attacks with mandatory executable reproducers.

```json
{
  "kind": "edge|race|type|import|logic|perf|security|render|state_break",
  "msg": "...",
  "severity": "blocking|high|medium|low",
  "reproducer": {
    "type": "test|input|trace|render|state",
    "code": "...",        // test snippet OR
    "input": {},          //   input value OR
    "render": {           //   render scenario (kind=render)
      "navigate": "/foo",
      "describe": ["#login-button", ".error-banner"],
      "assert": "..."
    },
    "state": {            //   state-break scenario (kind=state_break)
      "pre_state": "user logged in, modal open, form half-filled",
      "post_assert": "session still valid AND form data preserved"
    }
  }
}
```

**Attack kinds** (Wave 1):

- `edge|race|type|import|logic|perf|security` — classical attacks against patch + diagnostics.
- `render` — attacks that only manifest in rendered UI: layout breakage, hydration mismatch, console errors during paint, accessibility-tree changes, missing/unclickable elements. Reproducer drives the Synthi MCP tool surface (`synthi_compile`, `synthi_wait_hmr`, `synthi_describe`, `synthi_get_event_log`, `synthi_get_labels`) to navigate, observe, and assert.
- `state_break` — attacks against state continuity: patch breaks auth session, drops websocket reconnect, loses unsaved form data, corrupts state machine across user actions. Classical verification structurally can't see these because it always starts fresh; state-preserving HMR (Wave 1 for JS/TS) makes them observable. Reproducer describes pre-state, applies patch, asserts post-state.

**Hard guards:**

- **Reproducer-required schema** — attacks without reproducers are dropped before Critic-Critic.
- **Run-the-reproducer** — `edge|logic` execute in the worktree (today); `render` and `state_break` execute against the live runtime via MCP. Test/observation passes → attack pedantic. Fails → attack proven real.
- **Severity gates revision** — only `blocking` triggers a revise; max 1 revision pass.
- **At most 5 attacks per universe** — forces prioritization.
- **Survival rewards** — score formula favors patches with no real flaws found, not patches that addressed every concern.
- **Render and state_break few-shot** — Critic prompt includes worked examples for both new kinds. Wave 1 deliverable: bootstrap a render-attack and state_break-attack corpus from real bugs in the Synthi codebase. Without this, the Critic LLM doesn't know what these attacks look like and emits weak placeholders.

### 6.3 Critic-Critic (Wave 2+)

Cheap fast model (Haiku/Flash). Reviews each non-executable attack against detected project signals.

**Project signal detection** prefers explicit declaration over heuristics:

1. **AGENTS.md in repo root** — read first. Codex-convention project descriptor; treats explicit declarations (project type, test framework, style guide, build/run commands) as authoritative.
2. **Heuristic fallback** — `project_signals.py` infers from package.json, pyproject.toml, presence of CI config files, etc. Used only when AGENTS.md is absent or fields are missing.

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

For `render` attacks, the pedantry filter learns the visual-pedantry distinction: "looks slightly different from baseline" or "color drift below noise threshold" → pedantic; "element missing / unclickable / overflows / hydration mismatch / console error during paint" → real. For `state_break`, "user data preserved across patch" is the assertion floor — anything that silently drops session/form/websocket state is real, not pedantic, regardless of test-pass status.

Pedantic attacks demoted to `severity: low`, never trigger revision, surfaced only as informational notes.

**Sycophancy guard** (eval-driven, see §15.4): a Critic-Critic that agrees with the Critic on > 90% of attacks is rubber-stamping, not filtering. The eval harness measures Critic-Critic ↔ Critic disagreement rate; agreement > 90% → Critic-Critic adds no value (or worse, masks Critic errors) and is removed, not shipped. Stacking verifiers without information restriction is a known sycophancy pattern; the existing compressed-evidence schema (§11) is the information-restriction defense for the Arbiter, and the agreement-rate gate is the equivalent for Critic-Critic.

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
- **Low-conf RAG warning banner** — when `rag_context.rag_confidence < 0.6` (§5), Arbiter card shows "RAG retrieval was uncertain — review citations" banner *in addition to* whichever verdict-cascade row applies (§16.5). Independent of Arbiter's own `confidence`. The two confidences are different: Arbiter's is "how sure am I about this winner"; RAG's is "how sure am I about the source material the chat grounded in." Both can be low simultaneously and the user should see both.
- **Stale-context warning banner** — when any `stale_context_detected` event fired during the run, Arbiter card shows "context shifted during verification — citations may be out of date." Stacks with above.

### 6.5 Spec Synthesizer (Wave 2+)

A small LLM step that runs *before* the Generators and produces a structured spec from the user's request + RAG context:

```json
{
  "do":     ["validate exp claim is in the future", "preserve API surface of verify()"],
  "dont":   ["change verify() signature", "introduce new dependencies"],
  "verify": [
    { "kind": "test",   "code": "expect(verify(expiredToken)).toThrow()" },
    { "kind": "render", "code": "navigate /login; assert no console errors during submit" },
    { "kind": "state",  "code": "session preserved across hot-reload of auth.ts" }
  ]
}
```

**Why a spec layer:**

- Generators get explicit non-goals (`dont`), which the prompt-prefix style hints can't carry reliably.
- Critic derives reproducers directly from `verify` clauses instead of inferring attacks from patch + diagnostics. Stronger attacks, less hallucinated pedantry.
- Arbiter scores against `verify` as objective criteria — not the LLM's free-form opinion of which patch is "better."

**Hard guards:**

- **Extraction failure → fall back to today's behavior.** If the Spec Synthesizer's output fails schema validation or the `verify` list is empty, run the existing flow (Generators infer from request; Critic infers from patch + diagnostics). Don't block the pipeline on a fragile extra LLM call.
- **Schema-validated output.** Strict JSON schema; one re-prompt on failure; then fallback.
- **Eval-gated rollout.** Wave 2 GA blocked until harness shows the spec layer lifts Critic recall **AND** doesn't regress top-1 accuracy on the corpus vs no-spec baseline.

Behind a `genome.spec_synth` feature flag (default off in Wave 2 dev, default on at Wave 2 GA after eval clears).

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

### 7.4 Dev-server pool (Wave 1)

Frontend GUI verification needs a running dev server with HMR. Three architecture options, ordered cheapest to most expensive:

1. **One dev server per workspace, universes serialize through GUI stage.** Default. Universes parallelize through lint/types/tests; serialize through the GUI+state stage (one server, one HMR event-loop at a time).
2. **Multiple dev servers per workspace (pool of 2-3).** Universes parallelize through GUI stage. Costs ~3× memory per workspace (each dev server holds the full app in memory). Eval-gated optimization if option (1) shows GUI tail latency dominating.
3. **Per-universe dev server (pool of N matching worktrees).** Maximum parallelism, maximum memory cost. Reserved for the case where GUI stage is the structural bottleneck and per-workspace memory budget allows.

**Wave 1 ships option (1).** Per-workspace memory cost is bounded; the Synthi MCP tool surface (`synthi_compile`, `synthi_wait_hmr`, `synthi_describe`, etc.) operates against the workspace's existing dev server, not a separate one. Universes acquire the GUI lock in submission order; eval harness measures the serialization tax.

**State preservation across universes** — when option (1) is in effect, universes must reset the dev server's state between attempts so the second universe doesn't observe the first universe's effects. Reset = `synthi_restore` to the snapshot taken at job start (§8). This is *not* a fresh restart; it's a checkpoint-restore that preserves HMR warmup and shared module cache while reverting state mutations. Faster than restart, sound for verification.

**Compiled-language HMR (Rust/Go) is not in Wave 1.** It's an architectural extension — see §16 NOT-in-scope.

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

| Language | Lint | Types | Tests | Runtime | GUI (frontend) | Wave |
|---|---|---|---|---|---|---|
| Python | `ruff check` | `mypy --hide-error-context` | `pytest -x --timeout=10` (changed-modules only) | venv subprocess, capture stderr | n/a | 1 |
| TS / JS | `eslint --no-error-on-unmatched-pattern` | `tsc --noEmit --incremental` | `vitest run --changed` or `jest -o` | dev-server already running | **HMR-aware**: `synthi_compile` → `synthi_wait_hmr` → `synthi_describe` / `synthi_get_event_log` / `synthi_get_labels` | 1 |
| Anything else | tree-sitter parse | — | — | — | n/a | 1 |
| Go | — | `go vet` | `go test -timeout 10s ./...` | — | n/a | 3 |
| Rust | `cargo clippy --no-deps` | `cargo check` | `cargo test --no-run` | — | n/a (HMR deferred) | 3 |
| HTML/CSS | htmlhint / stylelint | — | — | — | inherits TS/JS GUI row | 3 |

**Static-stage budgets** (lint/types/tests): 5s lint, 8s types, 10s tests. Over-budget → "didn't finish" mark, doesn't fail the universe.

**GUI-stage completion** is event-driven via `synthi_wait_hmr`, not wall-clock. This *replaces* the old "next dev for 5s, hit changed routes" approach — that was theater (a 5s window has no relationship to whether HMR actually completed). Event-driven completion is faster on simple changes (HMR fires in 100-500ms typically) and avoids premature "didn't finish" on legitimately slow ones. Wall-clock fallback at 8s for cases where the HMR signal is missing (e.g., patch broke the dev server before HMR fired).

**Static-toolchain becomes a fast pre-filter for frontend.** Lint+types+tests run in parallel; GUI stage is gated on those passing. A patch that fails `tsc` doesn't get GUI-verified — that would be wasting the dev server lock on a known-broken change.

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
      "rendered_state": {
        "dom_diff":             "clean",
        "console_errors":       0,
        "a11y_tree_delta":      "clean",
        "layout_warnings":      [],
        "state_continuity":     "preserved (auth, form, websocket)"
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
- **`rendered_state` is text-only.** DOM-diff, console-error count, accessibility-tree delta, layout warnings, state-continuity verdict. No screenshots in the main bundle — image tokens are expensive relative to their information density. If vision is needed, restrict to the two-stage Arbiter's Summarizer step (§11.1) where Summarizer-tier vision tokens are cheap relative to Judge-tier reasoning tokens.

A typical 30 KB raw bundle compresses to ~2.5 KB; +rendered_state adds ~500 bytes per universe when the patch is frontend.

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
  workspace/              # snapshot of a real codebase state
  request.txt             # the user's prompt
  golden_patch.diff       # the known-correct fix
  golden_tests/           # tests that pass on golden, fail on workspace
  golden_rendered_state/  # (UI sub-corpus) DOM-tree + a11y tree + console-log
                          # snapshots after applying golden_patch and observing
                          # via MCP. One viewport, one pinned browser version.
  metadata.json           # difficulty, language, intent, has_dep_change,
                          # is_frontend, browser, viewport, ...
```

**Targets**: 50 cases by end of Wave 1, drawn from real bug fixes (ours, public CVE patches, popular OSS fix commits). Cover: Python, TS/JS, multi-file, dep-change, refactor, performance, type-error, logic bug.

**UI sub-corpus** (Wave 1, ≥ 10 of the 50 cases): frontend bug fixtures with `golden_rendered_state` capturing the post-fix DOM-tree, accessibility tree, console-error count, and (where relevant) state-continuity assertions (auth/form/websocket preserved across the patch).

- **Pin one browser + one viewport** per fixture in v1. The Synthi default. Cross-browser/viewport robustness is a §16 entry with explicit trigger; without pinning, the rendered-state ground truth decays into infrastructure cleanup.
- **State-break sub-fixtures** (≥ 3 of the UI 10): patches that pass tests but break state continuity (drop session, lose form data, disconnect websocket). These are the highest-leverage eval points because they exercise the verification category that classical CI structurally can't catch.
- Render attacks emitted by the Critic on this sub-corpus must execute against the live runtime via the MCP tool surface; eval harness measures Critic-precision/recall on `render` and `state_break` separately from the classical kinds.

### 15.2 Metrics

Each nightly run produces:

| Metric | What it answers |
|---|---|
| Critic precision | Of attacks Critic flagged, what fraction were real (reproducer failed)? |
| Critic recall | Of known-real bugs in corpus, what fraction did Critic catch? |
| Critic precision/recall by kind | Same, broken out by `edge|race|type|...|render|state_break`. Render and state_break are tracked separately because they're the new categories — recall is bootstrapping. |
| Critic-Critic precision/recall | Same, for the pedantry filter |
| **Critic-Critic ↔ Critic agreement rate** | Sycophancy guard. > 90% agreement = Critic-Critic is rubber-stamping; below threshold blocks Wave 2 GA (§15.4). |
| Universe N+1 marginal value | Does adding a 4th universe meaningfully improve top-1 accuracy? |
| Arbiter top-1 agreement | Does Arbiter's winner match the golden patch (or closest universe)? |
| Arbiter calibration | Among picks at confidence X%, what fraction were correct? |
| Apply success rate | Of accepted patches, what fraction merge cleanly with concurrent edits? |
| Per-tier latency p50/p95 | Are we hitting the 4s/12s/30s targets? |
| **GUI-stage latency p50/p95** | HMR-completion-event time + observation. Subset of standard/deep tier latency for frontend patches. |
| Per-tier cost p50/p95 | Are we hitting the $0.001/$0.012/$0.04 targets? Measured-on-corpus, not estimated. |
| Convergence rate | What % of runs trigger convergence detection? |
| **Spec Synthesizer extraction success** (Wave 2+) | What fraction of requests yield schema-valid `{do, dont, verify}`? Failures fall through to today's flow. |
| **Spec-driven Critic-recall lift** (Wave 2+) | Critic recall with spec.verify vs without. Spec layer ships only if positive. |

### 15.3 CI gates

`bench/report.py` produces a markdown report. Wave 2+ PRs cannot regress these by more than threshold:

- Critic precision ≥ 0.7
- Critic recall ≥ 0.6
- Arbiter top-1 agreement ≥ 0.8
- Apply success rate ≥ 0.95
- Per-tier latency p95 within +20% of contract
- **Per-tier cost p95 within +50% of contract** (cost numbers are inherently more volatile than latency due to model price changes; +50% is the headroom before contract revision is forced).
- **Critic-Critic ↔ Critic disagreement rate ≥ 15%** (§15.4 below; Wave 2 GA only).
- **Render-attack precision ≥ 0.6, state_break-attack precision ≥ 0.6** (Wave 1 floor; recall is bootstrapping, not gated initially).

A regression on any of these blocks the PR.

### 15.4 What this changes upstream

- Scoring weights in §10 are re-tuned by a small grid search against the corpus before Wave 2 GA.
- Universe count for `standard` tier is empirically validated — if N=3 and N=4 give the same accuracy, we ship N=3.
- Critic-Critic is gated on (a) improving precision without crashing recall **AND** (b) Critic-Critic ↔ Critic disagreement rate ≥ 15% on the corpus. Below 15% disagreement, Critic-Critic is sycophantic — it agrees with the Critic on > 85% of attacks and adds no independent signal. **Sycophantic Critic-Critic is removed, not shipped.** Stacking verifiers without information restriction is a known failure mode; the agreement-rate gate is the structural defense.
- Convergence threshold (0.92 above) is calibrated against the corpus.
- **Spec Synthesizer (§6.5) ships only if** harness shows Critic-recall lift ≥ 5pp **AND** no top-1-accuracy regression on the corpus, vs no-spec baseline. Below either bar → Spec Synthesizer stays behind the flag, runs in shadow mode for measurement, doesn't drive Generators.
- **Crossover (Wave 3) ships only if** harness shows positive top-1-accuracy lift **AND** no Critic-recall regression. The Critic-recall constraint specifically catches the failure mode "synthesis lifts top-1 by smuggling in subtly-broken patches that pass tests but break in the real world." See §18 anti-pattern guards.
- **Cost numbers in §16 are harness-driven**, not estimated. The table footnotes the measurement date; PRs that change cost-shape (new LLM call, model swap) re-measure.

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
| quick | one-line fixes | 4 s | 1, lint+type only (no GUI) | ~$0.001 |
| standard | typical edits | 12 s | 3, lint+type+tests + GUI on frontend | ~$0.012 |
| deep | complex refactors | 30 s | 3 + crossover, runtime + GUI | ~$0.04 |

**Cost numbers are harness-measured on the bench corpus** (last updated: 2026-04-28). They are *not* a-priori estimates — agentic verification cost is consistently underestimated, so the contract is "what the harness shows on a representative corpus." Real-corpus values may differ; harness re-measures on every Wave 2+ PR (§15.4). Per-tier cost p95 is gated within +50% of the latest published number — exceeding that forces contract revision and a user-comms note, not silent drift.

**Autonomy semantics** (made explicit; quick/standard/deep are *cost/latency* tiers, but they imply autonomy levels):

- **Verify-only mode** = *observe-only*. No LLM generation, just lint/type/tests/render against user-written code. Lowest autonomy; user is in the loop continuously.
- **`quick` tier** = *recommend-with-optimistic-apply*. LLM generates, verifies, auto-applies on timeout (per RAG plan Appendix A.5). Suitable for one-line fixes the user is actively waiting on.
- **`standard` and `deep` tiers** = *recommend-with-approval*. LLM generates, verifies, surfaces verdict; never auto-applies on timeout — holds and queues. Suitable for multi-file edits and refactors where the cost of an unverified apply is high.
- **Execute-with-logging** (Wave 4+ product unlock, §22) = unattended run on a UI ticket queue, render each result via MCP, surface only ambiguous ones. Made feasible by GUI observation + state-preserving HMR; not committed in v1.

**GUI-stage latency note**: HMR-aware completion (event-driven via `synthi_wait_hmr`, not wall-clock) typically *reduces* p95 on simple frontend changes — most HMR cycles complete in 100-500ms vs the old 5s wall-clock budget. Standard-tier p95 is achievable on frontend patches *because* GUI verification is event-driven, not despite it.

### 16.5 Verdict cascade with RAG context

The full unified verdict matrix lives in **RAG plan Appendix A.5** (single source of truth — D14 of the RAG plan). The genome side enforces it via the Arbiter card UI and the timeout policy below.

**Tier-split timeout handling.** When a Genome run hits its wall-clock cap before universes finish, what the user sees depends on tier:

| Tier | Genome timeout behavior |
|---|---|
| `quick` (4 s) | **Apply with caveat banner.** "Verification didn't finish — runs available shortly." User is actively waiting; blocking is worse than optimistic apply on small changes. |
| `standard` (12 s) | **Hold; queue for completion.** Don't auto-apply. Card shows "verifying… we'll notify when done." |
| `deep` (30 s) | **Hold; queue for completion.** Card shows "verifying… (deep tier — large changes take longer)." Refactor stakes are too high for optimistic apply on a 30-second job. |

`quick` is the only tier where Genome timeout → optimistic apply. The asymmetry is deliberate: small changes the user is waiting on tolerate optimistic apply with an explicit retry path; large refactors don't, because the cost of an unverified apply is much higher than the cost of waiting.

**Other verdict-cascade rows** (RAG-confident-Genome-rejected, RAG-low-conf-Genome-accepted, etc.) are rendered by the existing Arbiter card + verify panel; the §6.4 hard guards (low-conf RAG banner, stale-context banner) handle the warning layer. See RAG plan Appendix A.5 for the full row-by-row matrix.

## 17. Cost & budget controls

- Tier auto-selected; user can override.
- Every job emits `estimated_cost_usd` up-front; user can cancel.
- Hard daily cap per workspace (default $5), surfaced in the existing usage panel.
- Apply-and-cancel saves 30-60 % of compute on average.
- Cheap-model tiers (Haiku/Flash) for Critic-Critic + continuous shadow.
- Convergence detection saves 30-50 % on simple fixes.
- **Dev-server memory cost** (Wave 1, frontend GUI verification): one running dev server per workspace (§7.4 default). HMR observation itself is *free* LLM-wise — no tokens consumed for `synthi_wait_hmr` / `synthi_describe` / `synthi_get_event_log`. The cost is RAM (one full app runtime per workspace). Per-universe dev servers (§7.4 option 2/3) multiply that cost; eval-gated and not v1.

### 17.5 MCP integration

Two distinct integrations, different surfaces, different waves:

**Inbound MCP** (Wave 1, this plan *consumes* the Synthi MCP server):

Genome's runtime stage calls the existing Synthi MCP tool surface to drive HMR, observe rendered state, and execute `render` / `state_break` reproducers:

- `synthi_compile` — trigger compile.
- `synthi_wait_hmr` — wait for HMR completion event (replaces wall-clock budget).
- `synthi_describe` — text description of rendered DOM.
- `synthi_get_event_log` — console errors, warnings, network events.
- `synthi_get_labels` — accessibility tree.
- `synthi_get_crash_info` / `synthi_health` — runtime health checks.
- `synthi_screenshot` — only when the two-stage Arbiter Summarizer needs visual context.
- `synthi_snapshot` / `synthi_restore` — state checkpoint/restore between universes (§7.4 state preservation).
- `synthi_click` / `synthi_type` / `synthi_fill_form` — execute render-attack reproducers that need user-action sequences.

The runner stage interface (`runner/gui.py`) wraps these with the universal contract: input = patch + workspace, output = `rendered_state` block (§11) + executed-reproducer results.

**Outbound MCP** (Wave 4, this plan *exposes* verification as MCP tools to external agents):

External AI coding agents (Claude Code, Codex, ChatGPT desktop) call Synthi's verifier as MCP tools. Surfaces the existing Wave 1-3 investment to a much broader workflow:

- `synthi_verify(patches, tier)` → wraps `POST /shadow/run`. Returns `jobId` + estimated cost; subsequent calls poll status.
- `synthi_verify_only(patches, tier)` → wraps `POST /shadow/verify-only`. No LLM generation, just runner + rendered_state.
- `synthi_verify_status(jobId)` → polls. Returns universe progress + final verdict when complete.
- `synthi_verify_apply(jobId, universeId)` → wraps `POST /shadow/{jobId}/apply`.

Auth: workspace-scoped MCP token, same model as the existing Synthi MCP server. The MCP server itself is the Wave 4 deliverable; the underlying API endpoints (`/shadow/run` etc.) already exist from Wave 1.

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
| Crossover | **Critic re-attack** — full adversarial pass on every child, not just compile | 3 |
| Crossover | **Arbiter-blessing-required** — only runs when prior verdict had `synthesis.recommended: true` AND named the fragments | 3 |
| Crossover | **Margin-required scoring** — child must beat best parent score by ≥ 0.05; within-margin wins go to the parent | 3 |
| Crossover | **Per-workspace kill switch** — auto-disable if rejection rate > 40% over a 50-job window | 3 |
| Crossover | Eval-gated GA — must show top-1 lift AND no Critic-recall regression vs no-crossover baseline (§15.4) | 3 |
| Crossover | Closure-aware fragment swap behind feature flag | 5 |

## 19. Phasing

| Wave | Branch | Scope |
|---|---|---|
| 0 (done, uncommitted) | `claude/improve-ai-features-tIX4u` | Inline completions overhaul + tokenized ghost text + multi-provider chat (Anthropic/OpenAI/Gemini) with logos & per-provider keys + RAG: HyDE + chat-history rewrite |
| 1 | follow-up | Single universe + Critic with executable reproducers (incl. `render` and `state_break` kinds) + worktree pool with dep-install lock + dev-server pool (1 per workspace, §7.4) + snapshot/3-way-merge/AI-rebase + Yjs-aware apply (touches collab-server) + non-blocking verify panel + pre-warming + apply-and-cancel + staleness UI + Verify-only mode + evaluation harness with 50 corpus cases (incl. UI sub-corpus, ≥ 10 fixtures) + Python/Node/tree-sitter runners + **GUI runner** (`runner/gui.py`, frontend HMR-aware via `synthi_wait_hmr` MCP integration, state-preserving via `synthi_snapshot/restore` between universes) + **inbound MCP integration** (Genome consumes the Synthi MCP tool surface) |
| 2 | follow-up | 3-universe parallel + multi-model cross-validation + Minimalist Universe with post-hoc filter + Critic-Critic + domain calibration (incl. AGENTS.md project-signal source) + **Spec Synthesizer** (§6.5, behind flag) + Arbiter (basic) with compressed evidence schema (incl. `rendered_state`) + convergence detection + scoring weights re-tuned from harness + Critic-Critic agreement-rate gate (§15.4) |
| 3 | follow-up | Runtime probes (dev-server / pytest) + change-level crossover (1 generation, compile-gated, full guard set per §18) + Arbiter synthesis mode + two-stage Arbiter for oversize + Go/Rust/HTML *static* runners + (triggered, not committed) compiled-language HMR for Rust/Go if upstream toolchain support matures + (triggered, not committed) durable cross-run state-replay subsystem with explicit privacy redaction + determinism design |
| 4 | follow-up | Continuous shadow (pass→fail trigger only) + few-shot preference learning + regression-log auto-replay + cost dashboard + Arbiter learns from overrides + **outbound MCP integration** (`synthi_verify*` tools exposed for external agents, §17.5) + **execute-with-logging mode** (unattended UI-ticket-queue mode, gated on GUI observation maturity from Wave 1-3 eval data) |
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
  critic.py                # incl. render + state_break attack few-shot
  worktree.py              # pool + dep-install lock
  dev_server_pool.py       # 1-per-workspace; serialize universes through GUI
  snapshot.py              # snapshot + 3-way merge + AI-rebase
  scoring.py
  events.py
  regression_log.py
  mcp_client.py            # inbound MCP: synthi_compile/wait_hmr/describe/etc.
  runner/{base,python,node,syntax,gui}.py
                           # gui.py = HMR-aware frontend runner via MCP
ai-backend/ai-engine/bench/
  corpus/                  # 50 fixtures by end of W1, ≥ 10 in UI sub-corpus
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
ai-backend/ai-engine/shadow/project_signals.py     # AGENTS.md first, heuristic fallback
ai-backend/ai-engine/shadow/spec_synthesizer.py    # §6.5, behind genome.spec_synth flag
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
ai-backend/ai-engine/shadow/mcp_server_extensions/   # outbound MCP, §17.5
  synthi_verify_tools.py                              # synthi_verify*, etc.
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
| Critic can't write `render` / `state_break` attacks (LLM doesn't know what they look like) | Wave 1 deliverable: bootstrap render + state_break few-shot from real Synthi bugs; eval harness measures recall on these kinds separately | 1 |
| Arbiter sycophancy ("they all look fine") | Strict schema requires single winner | 2 |
| Critic-Critic sycophancy (rubber-stamping the Critic) | Disagreement-rate gate ≥ 15% on the corpus; below that, Critic-Critic is removed not shipped (§15.4) | 2 |
| Arbiter overrides hard facts | Validator rejects picks of test-failing universes without warnings | 2 |
| Arbiter context window blows up | Compressed evidence schema; two-stage on oversize | 2-3 |
| User edits during verify → conflict | Snapshot + 3-way merge + AI-rebase + Yjs-aware apply + staleness UI | 1 |
| Genetic crossover produces broken stitches | Change-level by default; compile-gate; Critic re-attack on every child; Arbiter-blessing-required; margin-required scoring; per-workspace kill switch; eval-gated GA (§18, §15.4) | 3 |
| Continuous shadow becomes annoying | Pass→fail trigger only (no idle ping); opt-out; daily cap | 4 |
| Style hint ignored by frontier model | Post-hoc filter rejects non-conforming Minimalist diffs | 2 |
| Preference vector hallucination | Replace EMA with few-shot examples | 4 |
| Scoring weights are guesses | Evaluation harness re-tunes empirically before Wave 2 GA | 1 |
| HMR signal flakiness (Wave 1 GUI runner depends on `synthi_wait_hmr`) | Wall-clock fallback at 8s; `stale_context_detected`-style event for the Arbiter card when HMR misses | 1 |
| Per-workspace dev server contention (universes serialize through GUI stage) | 1-server default; eval-measure GUI tail latency; expand to 2-3 servers per workspace if eval shows it dominates | 1-2 |
| Spec Synthesizer hallucinates `verify` clauses, leading Critic astray | Schema validation + one re-prompt + fallback to today's flow on failure; eval-gated GA (§15.4) | 2 |
| Cost numbers drift from contract as model prices change | Cost numbers are harness-measured per PR (§15.4); +50% gate forces contract revision rather than silent drift | 2+ |
| Captured app state in state-break verification contains user data (privacy) | Wave 1 state preservation is checkpoint/restore *within* the run, not durable storage; full episodic state replay (Wave 3 trigger) needs an explicit redaction layer before shipping | 1, 3 |
| State replay non-deterministic across timestamps / randomness / network | Out of scope for Wave 1 (state-break attacks rely on within-run continuity, not cross-run replay); Wave 3 trigger requires explicit determinism design | 3 |

## 22. Bonus features unlocked

- **Verify-only mode** (Wave 1): user highlights their own code, clicks Verify, gets lint/type/tests/render run on their patch with no LLM in the loop.
- **`[Why?]` button on Arbiter card** (Wave 2): opens a follow-up chat asking the Arbiter to defend or revise its verdict.
- **Patch composition** (Wave 3): cherry-pick file edits from one universe + tests from another. Re-validated before applying.
- **Manual override learning** (Wave 4): every override becomes preference signal.
- **Convergence consensus card** (Wave 2): when universes agree, the UI shows a single "consensus" card instead of three identical ones.
- **Execute-with-logging** (Wave 4+): unattended agent runs on a UI ticket queue, renders each result via the GUI runner, surfaces only renders that diverge from spec. Made feasible by GUI observation + state-preserving HMR (Wave 1 substrate); product unlock that pure console-grade verification structurally couldn't support. Gated on Wave 1-3 eval data showing render-attack precision/recall hits the Wave 1 floors and Spec Synthesizer (§6.5) ships successfully.
- **External-agent verification surface** (Wave 4): `synthi_verify*` MCP tools (§17.5 outbound). External AI coding agents call Synthi's verifier as a tool. Surfaces the Wave 1-3 verification investment to the broader AI-coding ecosystem, not just the Synthi chat.

## 23. Decisions locked in

| # | Decision | Choice |
|---|---|---|
| 1 | Wave 1 scope | Single universe + Critic. Multiverse machinery designed but not enabled until Wave 2 (one universe renders through MultiverseCard). |
| 2 | Wave 1 toolchain | Python + Node + tree-sitter fallback only. Go/Rust/HTML in Wave 3. |
| 3 | Worktree home | `repos/{slug}/{user}/.shadow/wt_*` (sibling to existing repos). |
| 4 | Arbiter model assignment | Rotate — provider least used among Generators/Critics in this run. |
| 5 | Verify-only mode in Wave 1 | Yes. |
| 6 | Wave 0 commit | Hold. Ship as part of the Wave 1 PR. |
| 7 | RAG integration contract | `rag_context` block in `/shadow/run` (§5); soft sufficiency gate, not hard; IDs only, never section contents; verdict cascade per §16.5. Authoritative full contract: RAG plan Appendix A. Changes here require both files land together (mirrors RAG plan D14). |
| 8 | Genome timeout policy by tier | `quick` → optimistic apply with caveat banner. `standard` and `deep` → hold and queue, no auto-apply. Asymmetry is deliberate — refactor stakes don't tolerate optimistic apply on a 12s/30s job. |
| 9 | Critic schema attack kinds | Add `render` and `state_break` to the Wave 1 attack-kind set (§6.2). Reproducers execute against the live runtime via the Synthi MCP tool surface. Critic prompt ships with bootstrapped few-shot examples for both new kinds; without that bootstrapping, Critic produces weak placeholders. |
| 10 | GUI verification in Wave 1 (frontend) | Frontend GUI runner (`runner/gui.py`) ships in Wave 1, not Wave 3. HMR-aware completion via `synthi_wait_hmr`; `synthi_describe` / `synthi_get_event_log` / `synthi_get_labels` for observation. Wave 3 keeps Go/Rust/HTML *static* runners only. |
| 11 | Dev-server pool default | One dev server per workspace; universes serialize through the GUI+state stage (§7.4 option 1). Per-universe dev servers (§7.4 options 2-3) are eval-gated optimizations, not v1 commitments. Memory cost is bounded by design. |
| 12 | UI eval sub-corpus pinning | Pin one browser + one viewport per UI fixture in v1. Cross-browser/viewport robustness goes to §16 with explicit trigger. Without pinning, rendered-state ground truth decays into infrastructure cleanup. |
| 13 | Critic-Critic agreement-rate gate | Wave 2 GA blocked unless Critic-Critic ↔ Critic disagreement rate ≥ 15% on the corpus. Below that floor, Critic-Critic is sycophantic and is removed, not shipped (§15.4). |
| 14 | Spec Synthesizer in Wave 2 (behind flag) | `genome.spec_synth` flag, default off in Wave 2 dev, default on at Wave 2 GA after eval clears (Critic-recall lift ≥ 5pp + no top-1 regression). Schema-validated output; one re-prompt; fallback to today's flow on failure. |
| 15 | Cost-table contract | Cost numbers in §16 are harness-measured, not estimated. Per-tier cost p95 gated within +50% of latest published number; exceeding the gate forces contract revision and a user-comms note (§15.3). |
| 16 | Outbound MCP integration in Wave 4 | `synthi_verify*` tools wrapping `/shadow/run` and `/shadow/verify-only` (§17.5). External AI coding agents (Claude Code, Codex, ChatGPT desktop) become first-class consumers of Synthi's verification surface. |
| 17 | Compiled-language HMR + full state replay deferred | Rust/Go HMR-aware runners and durable cross-run state replay are Wave 3 with explicit triggers (privacy/redaction layer for captured state; determinism handling for timestamps/randomness/network). Wave 1 state preservation is *within-run* checkpoint/restore via `synthi_snapshot`/`synthi_restore`, sufficient for `state_break` attacks but not for cross-run episodic replay. |

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
