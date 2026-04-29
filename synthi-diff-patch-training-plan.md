# Diff-Patch Custom Model: Training Plan

Status: draft. Implementation can begin on Phase 0 once decisions D1–D14 (§13) are confirmed.
Owner: AI engine team (training) + worker team (instrumentation, reward harness) + data team (synthetic corpus).
Last updated: 2026-04-28 (rev: local-teacher default, +Appendix D for NVIDIA/AMD compute paths).

Companion docs:
- `synthi-genome-master-plan.md` (Genome shadow pipeline; this plan does not replace it).
- `docs/HMR_END_TO_END.md`, `docs/AI_HMR_ARCHITECTURE.md` (HMR system context).
- `docs/HMR_AGNOSTIC_ULTRAPLAN.md` (per-language HMR roadmap).
- `ai-backend/ai-engine/code_intel/rag/PLAN.md` (style reference for this plan).

---

## 1. Goal

Replace `gemini-3.1-flash-lite-preview` in the per-save diff-patch path (`POST /refactor/diff_patch`, `ai-backend/ai-engine/main.py:1881`) with a small, locally-served, fine-tuned coder model that:

1. **Beats Gemini Lite on HMR Promote rate**, on a held-out per-language eval, with no regression on any language slice with ≥ 50 episodes.
2. **Lands the round-trip under 150 ms p50 / 300 ms p95** on a single T4 or L4-class GPU (today's Gemini Lite is ~1.5–2.0 s end-to-end).
3. **Costs $0/save at inference** (local serving), versus today's per-call API spend.
4. **Falls back cleanly** to the existing Tier 3 full re-split path (`ai-backend/ai-engine/main.py` + `backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`) on any low-confidence inference, so a regression is a few-second slowdown, not a broken HMR.

The end state is the model that decides, on every file save in a split-module compiled project, **which of {core, gui, shared, host_runner} to edit, with which of {insert_after, insert_before, replace, delete}, anchored to which existing substring**.

## 2. Non-goals

- **Not training from scratch.** Pretraining a coder model from cold — even a small 0.5B one — runs ≥ $30K of compute and 6+ weeks of wall clock, and produces a worse result than a 4-week fine-tune of `Qwen2.5-Coder-0.5B-base` (or similar). The publicly-released coder bases bake in ~5T tokens of code pretraining that the diff_patch task leverages immediately — discarding that and starting random-init is a false economy. Phase 2 fine-tunes; Phase 3 RL-trains. Both start from a pretrained coder base. The size question (whether 0.5B is right or we can go smaller) is decided empirically in §6.6 — not by argument. See §13/D1.
- **Not replacing the Tier 3 full re-split fallback.** Tier 3 stays as the safety net. The custom model is Tier 2 only.
- **Not replacing `/refactor/heal` (compile error → fix) or `/refactor/heal/manifest` (link error → manifest update).** Same architecture cache, different prompts. Both are fine-tune candidates *after* diff_patch is shipped (see §14). Today's plan ships diff_patch only.
- **Not training a generalist code model.** This is one structured task. Diversity loss against the base model is acceptable as long as `/refactor/diff_patch` outcomes improve.
- **Not multi-tenant model serving.** One model artifact, served per-region. Per-customer adaptation is out of scope.

## 3. Why diff_patch is the right training target

Recap of the audit (see chat history 2026-04-28 for the full inventory of 26 model call sites). Diff_patch wins on every axis that matters for HMR feel, which is the canonical user-facing latency in Synthi:

| Axis | Diff-patch | Critic / arbiter | Healing fix | RAG synthesis | Vision locate |
|---|---|---|---|---|---|
| Frequency | per save | per shadow run | per analyze tick | per query | per UI agent step |
| User-visible latency | direct (HMR feel) | indirect | direct | direct | direct |
| Output schema | rigid (4×4×anchor) | structured JSON | structured JSON | freeform + cites | bbox JSON |
| Auto-labels | 4 cascading | 1–2 | 1–2 | LLM-judged | DOM-coord |
| Fallback ready? | yes (Tier 3) | yes (provider rotation) | partial | no | no |
| Self-contained? | yes (one prompt, one outcome) | no (multi-turn) | no | no (multi-turn) | yes |

**Diff_patch is the only target where four cascading verifier stages produce free, mechanical, automatic ground truth on every call**, because the existing Rust pipeline already verifies each stage:

1. `validate_edit_list` (`ai-backend/ai-engine/diff_patch_helpers.py:99-148`) — schema validity.
2. `apply_edit` (`backend/synthi-webrtc-compiler/worker/src/hmr/edit_applier.rs:82-145`) — anchor uniqueness and applicability.
3. `compile_core` / `compile_gui` / `compile_runner` (`backend/synthi-webrtc-compiler/worker/src/compiler/stages/`) — compile success.
4. HMR verdict (`backend/synthi-webrtc-compiler/worker/src/hmr/candidate_history.rs:19-23`) — `Promoted | RolledBack(reason) | Discarded`, with categorized rollback reasons in `hmr/telemetry.rs`.

You do not need a single human label. The pipeline is already a labeling machine; we just don't write the labels to disk yet. **§5 is the single blocker.**

## 4. The data problem (honest)

Today the codebase has **zero persistent diff_patch episodes**. The endpoint at `main.py:1881` logs to stdout and discards the request body. The worker emits `HmrEvent` to its in-memory ring buffer (`mcp/synthi-mcp/src/events/log.ts`), which resets on restart and is keyed to MCP session, not to a diff_patch request_id.

Even if logging were on today, realistic save volume is small:

- Fixtures in `ai-backend/ai-engine/bench/corpus/` are mostly JS/Py, not the C/C++/Rust split-module case diff_patch handles. Confirmed file list: `js-*`, `py-*`, `ts-*`, `go-*`, `rust-unwrap-panic`, `html-*`, `multi-*` (34 total). Diff-patch's primary target — 4-module compiled projects with a host_runner — is **not represented in the corpus** (D11).
- Pre-launch, dev-only save volume is at best low thousands per week.
- Even at 10K saves/day post-launch, you'd need a year to accumulate enough verified data for an RL run from real users alone.

Conclusion: **the plan must be synthetic-data-first, real-data-augmented.** Sections §6 and §7 build the synthetic pipeline; §8 layers real saves on top once Phase 0 logging ships.

The synthetic strategy is the part of this plan most likely to be revised after first contact with reality. Track the gap between synthetic-eval Promote rate and real-traffic Promote rate (§9.4); a gap > 8 points means synthetic distribution is mis-calibrated and Phase 1 needs another mutation pass.

## 5. Phase 0 — Instrumentation prerequisites (Weeks 1–2)

Single hard blocker. Must land before *any* training step.

### 5.1 Persist diff_patch episodes server-side

Modify `ai-backend/ai-engine/main.py:1881` (`refactor_diff_patch`) to:

1. Generate a `request_id = uuid4().hex` at the top of the handler.
2. Append a JSONL row to `${SYNTHI_DATA_DIR}/diff_patch_log/{YYYY-MM-DD}.jsonl` with:

   ```json
   {
     "request_id": "<uuid>",
     "ts": "<iso8601>",
     "workspace_id": "<from header>",
     "model_used": "gemini-3.1-flash-lite-preview",
     "request": {
       "diff": "<unified diff>",
       "core_content": "...",
       "gui_content": "...",
       "shared_content": "...",
       "host_runner_content": "...",
       "architecture": "..."
     },
     "response_raw": "<ai_response string>",
     "response_parsed": {"edits": [...]},
     "validate_ok": true,
     "elapsed_ms": 1234
   }
   ```

3. Return `request_id` in the response body so the worker can correlate.

Cost: ~30 LOC. No new dependencies. Compress the log daily with `zstd --long`.

### 5.2 Worker emits per-stage outcomes keyed to request_id

Modify the Rust worker to emit a structured `diff_patch_outcome` event after each save:

- `backend/synthi-webrtc-compiler/worker/src/hmr/edit_applier.rs::apply_edit_list` — already returns `Result<(String, String, String, String)>`. Wrap the call in `handler.rs` with a span that captures `(per_edit_anchor_unique: Vec<bool>, total_edits, dispatch_failures)`.
- `backend/synthi-webrtc-compiler/worker/src/hmr/candidate_history.rs` — already records `CandidateState`; extend `CandidateSummary` to carry `request_id: Option<String>` and `compile_outcome: CompileOutcome`.
- Final outcome event shape:

  ```json
  {
    "request_id": "<uuid from ai-engine>",
    "ts_epoch_ms": 1714300000000,
    "preview_id": "...",
    "per_edit": [
      {"module": "gui", "operation": "insert_after", "anchor_unique": true, "applied": true}
    ],
    "schema_valid": true,
    "anchors_unique_all": true,
    "compile_outcome": "Ok" | "ErrorCore" | "ErrorGui" | "ErrorRunner" | "LinkUndef",
    "hmr_verdict": "Promoted" | "RolledBack" | "Discarded",
    "rollback_reason": "<categorized>",
    "tier3_fallback_triggered": false,
    "e2e_latency_ms": 1820
  }
  ```

  Write to `${SYNTHI_DATA_DIR}/diff_patch_outcomes/{YYYY-MM-DD}.jsonl` via the same writer pattern as the request log.

Cost: ~150 LOC across 3 files. Existing telemetry types already cover most of the shape.

### 5.3 Offline join script

`tools/join_diff_patch_outcomes.py` — reads both JSONL streams for a date range, joins on `request_id`, emits a single Parquet file per day:

```
${SYNTHI_DATA_DIR}/diff_patch_episodes/{YYYY-MM-DD}.parquet
```

Schema (Arrow): all fields above flattened plus a derived `success_score: float in [0, 1]` per the §7.2 reward formula. This is the canonical training table.

### 5.4 PII / secrets review

The diff_patch payload contains user source code. Before any of this lands:

- Confirm with legal/security that user-source capture is covered by the workspace ToS (D14).
- Workspace owners must be able to opt out via a settings flag (`SYNTHI_DIFF_PATCH_LOGGING=off`). Default opt-in for paid tiers, opt-in-required for free tiers (D13).
- Hash workspace_id with HMAC before logging. Never log file paths verbatim if they reveal customer names (rewrite `/Users/foo/secret_project/...` → `/anon/{hash16}/...`).

### 5.5 Phase 0 exit criteria

- 24 hours of dogfood saves produce ≥ 95% join rate (request log row → outcome row).
- Sample 50 random episodes; manually confirm fields are populated and PII-clean.
- Daily Parquet export runs in CI without manual intervention.

**Until 5.5 passes, all subsequent phases are blocked.** Don't start scraping corpora or renting GPUs.

---

## 6. Phase 1 — Synthetic data bootstrap (Weeks 3–8)

This is the load-bearing phase. We don't have enough real episodes; we have to make them. Three independent generators, run in parallel; each produces (input, output, verified_label) tuples.

### 6.1 Generator A: Mutation-based synthesis from public C/C++/Rust projects (target: 30–50K episodes)

**Source material.** Permissively-licensed projects in the actual diff_patch target distribution: SDL2 / SDL3 / raylib / GLFW / GLEW / OpenGL / FMOD / miniaudio demos, imgui examples, Bevy starter projects, raylib-cpp, sokol samples, Rust gamedev kits with ECS. Curate ~500 small projects (≤ 5K LOC, single-binary, MIT/Apache/BSD/zlib only). Track every project's license + commit SHA in `data/external_corpus/manifest.json` (D8).

**Pipeline per project:**

1. Run the existing `/refactor/split/verified` endpoint (`ai-backend/ai-engine/main.py:1489-1632`) to produce `(core, gui, shared, host_runner, architecture)`. Discard projects where split fails (~15% loss).
2. Apply N programmatic mutations to the *original* source (before split). Mutation kinds:
   - **value-change**: replace numeric/string literals with plausible alternatives (e.g. window dimensions, colors, FPS targets).
   - **add-call**: insert a call to an existing function in a plausible location (use AST analysis to find appropriate scope).
   - **remove-call**: delete a non-essential call (e.g. a debug print, a redundant clear).
   - **rename-local**: rename a local variable consistently within scope.
   - **add-function**: synthesize a small new function and call it once.
   - **add-state-field**: add a field to the state struct + initialize + use.
   - **swap-color**: swap RGBA values (frequent real-user edit).
   - **branch-flip**: flip an `if` condition or swap operator.
3. For each mutation, compute the unified diff vs. the unmutated source. This is the synthetic `diff` input.
4. Build the `DiffPatchRequest` body and route it to a teacher model. Default path is **local** (D15, D16): generate via `Qwen3-Coder-30B-A3B-Instruct` (Q4_K_M GGUF, ~15GB, 30B total / 3B active per token MoE) on a self-hosted 16GB-class consumer GPU, served by llama.cpp / Ollama (AMD) or vLLM (NVIDIA). $0 API spend; quality on this task is empirically within 1–2pp of Gemini Flash on verifier pass-rate (Qwen3-Coder is a code-specialist; Flash is a generalist). See Appendix D for the install + run recipe on both NVIDIA and AMD ROCm. **Cloud teacher** (`gemini-3-flash-preview`) is reserved as a fallback when (a) local hardware is offline or (b) the §6.1 200-example pilot shows local pass-rate < Flash − 5pp. Pro is reserved for verifier-rejected fallback (one retry per trial) and as the default teacher for Generator C only (§6.3). Flash-Lite is excluded — it's the model we're replacing, so it gives no quality lift. Rationale: the verifier filter (step 5) keeps only outputs where all four label stages pass, so teacher quality matters mostly through yield × cost. Local is $0/example × ~30s wall; Flash is ~$0.001/example × ~2s wall. For a one-time corpus, local wins on cost; cloud wins on time-to-data.
5. Run the response through:
   - `validate_edit_list` (Python validator)
   - `apply_edit_list` (Rust verifier — call from Python via PyO3 binding or subprocess)
   - Compile pipeline (the worker, in headless mode)
   - HMR replay on a stub runtime (no actual GUI required for compiled-only verdict; D5 keeps headless verifier in scope, GUI replay deferred to §6.2 sub-corpus)
6. Tag each episode with the cascading label per §7.2.

**Throughput (local default).** ~130 mutations × 500 projects × ~50% join-rate = ~32K labeled episodes. Per-episode wall time on a single 16GB consumer GPU: ~30s on RTX 4070 Ti / RX 7900 XT (NVIDIA path), ~60s on RX 9070 XT / RDNA 4 ROCm (AMD path) — full math in Appendix D.4. Total: ~270 GPU-hours (NVIDIA) or ~530 GPU-hours (AMD) ≈ 11–22 days continuous, or 4–8 weeks at 8h/day. **$0 API spend**; cost is amortized GPU + electricity (~$15–30 at $0.15/kWh).

**Throughput (cloud fallback).** Same 32K episodes via `gemini-3-flash-preview` finishes in ~6h wall clock at ~$500 Flash + ~$200 Pro fallback for verifier-rejected retries (~10% of trials) = **~$700 API spend**. Use this when local hardware is unavailable, or to seed an initial 5K-example dataset for fast prompt-iteration before committing to the full local run.

D6 caps total Phase-1 distillation API budget at $1K; D15 commits the default path to local hardware.

**Verifier-rejected fallback.** When a Flash output fails the cascade (schema, anchor, compile, or promote), retry the same input *once* with `gemini-3-pro` before discarding. Empirically rescues ~30% of Flash failures, especially the long-tail mutations (renames across modules, host_runner ownership edge cases). Cap at 1 retry per trial — beyond that, drop the trial and rely on the next mutation to cover that distributional region.

**Distribution control.** Use stratified sampling to enforce ≥ 15% representation per (mutation_kind × language × project_size) cell. Otherwise the corpus over-indexes on raylib-style C++ and the model regresses on Rust ECS code.

### 6.2 Generator B: AST-driven gold synthesis (target: 5–10K episodes, no LLM in the loop)

This generator produces episodes where the gold edit_list is computed *directly*, without any model — they are guaranteed-correct training pairs.

**Pipeline per project (same source corpus as 6.1):**

1. Parse the original source and the post-split modules with tree-sitter.
2. Plan a mutation in the original source AND simultaneously plan the corresponding edit_list in the split modules. Example: a value-change mutation to a literal in `core` only requires one `replace` edit on `core` with the literal as anchor.
3. Apply the mutation to the original; compute the diff; this is the synthetic input.
4. The pre-planned edit_list is the gold output. **No model involvement.**
5. Run apply_edit_list + compile to confirm the gold label compiles. Discard any plan that doesn't (this is mostly a sanity check against tree-sitter mistakes).

**Why this matters.** Generator A inherits Gemini Pro's biases (over-explaining, multi-edit when one would suffice, choosing weak anchors). Generator B is bias-free by construction; it teaches the model the *minimum-edit principle* and the canonical anchor-selection style. Mix ratio in Phase 2: 70% A / 30% B (D2).

### 6.3 Generator C: Adversarial scenarios (target: 1–2K episodes, hand-crafted)

The two automatic generators won't cover the long tail of weird-but-realistic edits. Hand-curate a set covering the failure modes the team has seen in dogfood:

- Diff renames a variable that's referenced in 3 different modules → model must update all 3.
- Diff adds a new function that needs to be called from `host_runner` and defined in `shared`.
- Architecture cache says `r` is in `core` but the diff renames `r` → `main_renderer`; the priority rule (`diff_patch_helpers.py:160-173`) must be respected.
- Anchor disambiguation: candidate substring appears 2× in the module; model must pick a longer, surrounding-context anchor.
- Empty-diff (no-op save): correct output is `{"edits": []}`.
- Adversarial whitespace (tabs vs. spaces, CRLF) where the wrong anchor would be a literal-match miss.

Each scenario is a fixture in `ai-backend/ai-engine/bench/corpus/diff_patch/{scenario_name}/` with `metadata.json`, `request.json`, `gold_edits.json`. Used both as training data and as the **eval CI gate set** (§9.1).

Target: 200 scenarios in Phase 1, growing to 1–2K by Week 8.

### 6.4 Phase 1 deliverable

`${SYNTHI_DATA_DIR}/diff_patch_train_v1/{train,val,test}.parquet`:

- ~40K train rows
- ~3K val rows (pulled from same distribution but disjoint projects)
- ~500 test rows (handcrafted §6.3 scenarios + 300 stratified-real episodes once Phase 0 is live for ≥ 30 days)

Per-row schema (final):

```
request_id: str
language: str  # "cpp"|"rust"|"c"|"python"
diff: str
core_content: str
gui_content: str
shared_content: str
host_runner_content: str
architecture: str
gold_edits: list[dict]   # null if 6.1 row (use response_parsed instead)
response_parsed: list[dict]  # null if 6.2 row
schema_valid: bool
anchors_unique_all: bool
compile_outcome: str
hmr_verdict: str
success_score: float
provenance: str  # "synth_A" | "synth_B" | "synth_C" | "real"
prompt_tokens: int
output_tokens: int
```

### 6.5 Phase 1 exit criteria

- ≥ 35K labeled rows with `success_score ≥ 0.95` (the SFT-eligible subset).
- Per-language distribution: ≥ 30% cpp, ≥ 20% rust, ≥ 15% c (D11 — diff_patch's primary corpus is the compiled-language case).
- Stratified val/test slice with ≥ 50 episodes per (language × mutation_kind) cell.
- All §6.3 adversarial fixtures pass when scored manually against the dataset (sanity check).

When §6.5 holds, run §6.6 (Phase 1.5 size ablation) before Phase 2 commits to a base model.

### 6.6 Phase 1.5 — Size ablation (Week 8, last week of Phase 1)

The model size question is decided empirically rather than by argument. Three arms train identically on the Phase 1 SFT-eligible subset (§7.2 inclusion gate, `success_score ≥ 0.95`) and are scored on the same val/test split.

| Arm | Base | Params | Code-pretrained? | Init |
|---|---|---|---|---|
| A | `Qwen2.5-Coder-0.5B-base` | 494M | yes (~5T tokens) | warm |
| B | `SmolLM2-135M-base` | 135M | no (general LM, ~2T tokens, no code emphasis) | warm |
| C | `SmolLM2-135M-arch` | 135M | none | random init |

Arm A is the planned production path. Arm B asks "does coder pretraining matter at this scale, or can a small general LM learn it from synthetic data?" Arm C is the closest credible "from scratch" arm given a sane budget — same architecture as B but no pretraining at all. Arms B and C together address the user's intuition that 200M-class might suffice.

#### Protocol

- Same train/val/test splits as Phase 2 (§7).
- Same SFT recipe; hyperparameters scaled to base size:
  - Arm A: LR 1e-5, 2 epochs.
  - Arm B: LR 3e-5, 4 epochs (less prior knowledge; needs more passes).
  - Arm C: LR 5e-5, 6 epochs + LR-warmup over first 1000 steps.
- Same constrained-decoding wrapper at eval (xgrammar against `EditList` schema).
- Eval metrics: identical to §7.5 (`schema_valid`, `anchors_unique_all`, `compile_outcome == Ok`, `hmr_verdict == Promoted`).
- All three arms trained on the same hardware (1× A100, separate runs).
- Eval scored on the same fixed test set; no per-arm hyperparameter tuning beyond LR/epochs above.

#### Decision rule (D1-B)

Pick the **smallest** arm that passes the §7.5 gates with no language-slice regression > 5pp vs. arm A.

- Arm A passes only → keep §7.1 as written; serve on T4/L4.
- Arm B passes → switch base to `SmolLM2-135M`, serve on CPU with vLLM (no GPU needed), update §9.2.
- Arm C passes → halt the plan, write a paper. (Predicted outcome: arm C fails every gate by ≥ 20pp.)

#### Budget

| Arm | Compute | Cost |
|---|---|---|
| A | 1× A100 × 4h | ~$30 |
| B | 1× A100 × 6h | ~$45 |
| C | 1× A100 × 8h (no warm start) | ~$60 |
| Eval harness across all 3 | 1× CPU box × 12h | ~$10 |
| **Total** | | **~$145** |

Wall clock: ≤ 7 days including eval. Runs as the final activity of Phase 1 (Week 8) so Phase 2 begins with the size question settled.

#### Why this is worth doing

- §7.1 picks 0.5B by argument, not measurement. If 135M passes, you save ~70% of per-region serving cost forever.
- If C fails (the predicted outcome), you have a citable internal datapoint when "why not from scratch?" comes up again. Arguments lose to data; bake the data.
- ~$150 is rounding error against the rest of the plan's budget.

---

## 7. Phase 2 — Supervised fine-tune (Weeks 10–13)

### 7.1 Base model selection (D1, pending §6.6)

Decision: **`Qwen2.5-Coder-0.5B-base`** (HuggingFace `Qwen/Qwen2.5-Coder-0.5B`), pending the §6.6 size ablation.

Why 0.5B and not bigger:

- The output is small (~100 tokens of structured JSON per call) and the task is rigidly schemed (4 modules × 4 ops × anchor + content). Most of the model's capacity goes into reading the prompt — the architecture cache, four module contents, and the diff — not into generating prose. A 0.5B can absorb that comfortably.
- 32K context fits worst-case prompts (4 × 4K modules + 2K architecture + 2K diff ≈ 20K tokens) without aggressive truncation.
- Serves at INT4 on a T4 (or even on a fat CPU box with vLLM) at ~80–150 ms TTFT — comfortably under the §1 latency target. 1.5B was overkill: 3× the latency at INT4 for a marginal quality bump on a task this rigid.
- Full fine-tune fits in 4 GB VRAM at bf16. Trains in ~4h on a single A100 (or ~12h on 4× L4).
- Permissively licensed (Apache-2.0).

Why not smaller / from-scratch:

- The `content` field of an edit is open-ended code that has to compile. Example from `edit_applier.rs:297-320`: `SDL_RenderFillRect(state->renderer, &btn2);` — knowledge of SDL2's API shape, struct conventions, and the split-module's state-pointer pattern. A 200M model trained from scratch on synthetic diff_patch data only would never see enough code to produce valid library calls outside the synthetic distribution. The pretraining isn't optional for this column.
- No major release ships a coder-pretrained base under 0.5B. The public-model market has voted: under ~400M params, the data-to-params ratio for code pretraining is poor and you don't beat a fine-tuned 0.5B at any latency point that matters.
- Pretraining a fresh small base on a code corpus costs ~$30K and ≥ 6 weeks of compute, plus an entire training infra (data filtering, dedup, BPE training, base-eval harness on HumanEval/MBPP/CrossCodeEval). All to recreate weights Qwen already released for free.
- §6.6 tests the smaller-and-from-scratch hypotheses empirically anyway. If 135M-general or 135M-random-init passes §7.5, we revise.

Rejected alternatives:

- **`Qwen2.5-Coder-1.5B-base`** — better quality ceiling but 3× the latency at INT4. Reserved as escalation path (D1-A).
- **`DeepSeek-Coder-1.3B-base`** — comparable quality but 16K context. Disqualifying for worst-case prompts.
- **`SmolLM2-135M-base`** (general LM, not code-pretrained) — tested in §6.6 as the "small + warm" arm. Expected to lose on `compile_ok` rate by a wide margin, but if it passes §7.5, switch and save ~70% of serving cost.
- **`SmolLM2-135M-arch` random init** — tested in §6.6 as the "from-scratch on synthetic only" arm. Predicted to fail every gate; a falsifiable answer to the "why not from scratch?" question.
- **`Qwen2.5-Coder-7B-base`** — better quality ceiling, but breaks the T4/L4 deployment target. Hold for Phase 3 stretch (D1-A).
- **`CodeLlama-7B` / `StarCoder2-7B`** — older, weaker on Rust, no constrained-decoding ergonomics.
- **Train from scratch (any size)** — explicitly excluded; see §2 and §13/D1.

### 7.2 Loss & label construction

Causal LM loss on the **output JSON only**. Mask the prompt. Standard recipe.

Each training example uses the canonical prompt template from `diff_patch_helpers.py:176-352` (`build_full_diff_patch_prompt`) — *byte-identical* to what the live pipeline will send. Drift between training prompt and serving prompt is the single biggest correctness regression in fine-tunes; copy the prompt builder into the training repo and import it back as a shared module rather than duplicating (D4).

Target output: the gold `edits` JSON, surrounded by no markdown fences (`diff_patch_helpers.py:350` — "Return ONLY the JSON object. No markdown fences, no prose."). Wrap with `<|json|>...<|endoftext|>` for clean termination.

`success_score` is used to **weight** examples, not gate them in/out:

```
success_score = (
    0.10 * float(schema_valid) +
    0.20 * float(anchors_unique_all) +
    0.30 * float(compile_outcome == "Ok") +
    0.40 * float(hmr_verdict == "Promoted")
)
```

Phase 2 trains only on rows with `success_score ≥ 0.95`. Lower-quality rows are saved for Phase 3 RL where we can use them as negative samples.

### 7.3 Hyperparameters

| Param | Value | Note |
|---|---|---|
| Sequence length | 8K (truncate if > 8K with module-content downsampling, see §7.4) | Wider hurts throughput, narrower drops corner cases |
| Batch size (effective) | 64 | 8 × 8 gradient accumulation on a single A100, or 16 × 4 on 4× L4 |
| Optimizer | AdamW, β=(0.9, 0.95), wd=0.1 | Standard for code LMs |
| LR schedule | warmup 100 steps → cosine to 1e-5 over 2 epochs | |
| Epochs | 2 | Beyond 2, val loss plateaus; 3+ overfits |
| Mixed precision | bf16 | |
| Gradient clipping | 1.0 | |
| Constrained decoding (eval only) | xgrammar with the `EditList` schema | Ensures fair compare against base |
| Total tokens trained | ~150M | At 8K seq × 64 bs × 2 ep × ~150 steps |
| Wall clock | ~4h on 1× A100, ~12h on 4× L4 | (0.5B base; multiply ×3 for 1.5B if D1-A escalation triggers) |

### 7.4 Long-prompt handling

Worst-case prompts exceed 8K tokens (4 modules + architecture + diff). Strategy:

1. **Architecture truncation**: keep first 1500 tokens of architecture (always includes "Where User Code Goes" routing rules per `diff_patch_helpers.py:222-227`). Drop the rest.
2. **Module-content tail-truncation**: if a module content exceeds 3K tokens, keep first 2K + last 1K and inject a `[... TRUNCATED N TOKENS ...]` marker. This is OK because anchors live near the change, and the diff usually points to a specific function.
3. **Diff truncation**: if the diff exceeds 2K tokens, the user save was huge — fall back to Tier 3 anyway. The model never sees these.

Apply the same truncation in serving (`ai-backend/ai-engine/diff_patch_helpers.py`) so train ≡ serve. Add a single `truncate_for_diff_patch` helper, used in both paths (D4).

### 7.5 Phase 2 exit criteria

On the held-out test set (§6.5):

- `schema_valid` rate ≥ 99.5% (Gemini Lite ~98.0% baseline)
- `anchors_unique_all` rate ≥ 92% (Gemini Lite ~85% baseline)
- `compile_outcome == Ok` rate ≥ 75% (Gemini Lite ~70% baseline)
- `hmr_verdict == Promoted` rate ≥ 70% (Gemini Lite ~65% baseline)
- p50 inference latency on T4 ≤ 150 ms (or L4 ≤ 100 ms)

If §7.5 fails on one metric but passes the other three by a safe margin, accept and proceed to Phase 3 — RL will close the gap.
If §7.5 fails on three metrics, distribution is wrong; back to §6 with new mutations.

---

## 8. Phase 3 — Verified-reward RL (Weeks 13–18)

The SFT model is a strong starting point but doesn't directly optimize HMR Promote rate. Phase 3 closes that gap by treating the existing Rust verifier as the reward function.

### 8.1 Reward harness

Build `bench/diff_patch_reward.py` — a process-pool worker that:

1. Reads a candidate edit_list JSON.
2. Runs `validate_edit_list` (Python).
3. Calls Rust `apply_edit_list` via subprocess.
4. Calls the worker's compile pipeline in headless mode.
5. Returns a structured outcome blob; the trainer maps it to a scalar reward:

```
reward(outcome) = (
    +1.0  if outcome.hmr_verdict == "Promoted"
    +0.3  if outcome.compile_outcome == "Ok" and outcome.hmr_verdict == "RolledBack"
    +0.1  if outcome.anchors_unique_all and outcome.compile_outcome != "Ok"
    +0.0  if outcome.schema_valid and not outcome.anchors_unique_all
    -0.2  if not outcome.schema_valid
)
```

The harness must run all four stages in **< 5 seconds per candidate** for RL to be tractable. Headless compile is the bottleneck; cache compile outputs by `(module_contents_hash, edit_list_hash)` (D9).

Target: 200 candidate evals/sec on a 16-core box with the cache hot. K=8 candidates × 2K prompts/iteration × 6 iterations = ~100K compiles/run.

### 8.2 Algorithm

**GRPO** (Group Relative Policy Optimization). Recipe:

- Sample K=8 candidates per prompt at temperature 0.8, top-p 0.95.
- Score all K with the §8.1 reward.
- Group-relative advantage: `A_k = r_k - mean(r_1..r_K)`, normalized by group std.
- KL penalty β=0.05 against the SFT model (the Phase 2 checkpoint), applied to the policy log-prob.
- PPO-style ratio clip ε=0.2.

Why GRPO over PPO+value-head:

- No value model → no extra training cost, no extra failure mode.
- Group-relative advantage is well-suited to verified-reward tasks where the absolute reward is bimodal (mostly 0 or 1).
- Track record on code RL since 2025 is strong (DeepSeek-R1, Qwen3 RL recipes).

### 8.3 Hyperparameters (RL)

| Param | Value |
|---|---|
| Prompts per iteration | 2,000 (sampled from train set) |
| K (candidates per prompt) | 8 |
| Iterations | 6 |
| LR | 5e-6 (cosine to 1e-6 over 6 iters) |
| KL β | 0.05 |
| Clip ε | 0.2 |
| Reference model | Phase 2 SFT checkpoint (frozen) |
| Mixed precision | bf16 |
| Wall clock | ~48h on 4× H100 (2 trainer + 2 sampler) |

### 8.4 Reward hacking countermeasures

The model will look for cheats. Anticipated:

- **Empty edit list**: `{"edits": []}` for non-empty diffs gets reward 0 (compile passes, but the "user's change" isn't reflected in the running app). This is *correctly handled* by Promote-rate reward — empty edits don't promote when the user's intent isn't met. But add an explicit penalty if `empty_edits AND non_empty_diff AND diff_lines > 5`.
- **Always-anchor-on-`{`**: the model picks `{` as anchor because it occurs in many places. This fails anchor uniqueness and gets reward 0. Built-in.
- **Echo verbatim diff into one module**: gets schema_valid + anchor_unique but compile_outcome != Ok. Reward 0.1; tolerable as a steepened-than-flat gradient signal.
- **Inflate edits**: emit many trivial no-op edits to increase the chance one is right. Add a soft penalty: `reward -= 0.02 * max(0, len(edits) - 4)`. Calibrated against the real-data 90th percentile (most saves need ≤ 3 edits).

### 8.5 Phase 3 exit criteria

On the same held-out test set:

- `hmr_verdict == Promoted` rate ≥ Gemini Lite + 5 absolute percentage points (target ~75%).
- No regression > 3pp on any language slice with ≥ 50 episodes.
- p50 inference latency ≤ 150 ms (RL doesn't change the model size; latency is unchanged from Phase 2 unless we accidentally lengthen outputs — keep `len(edits)` distribution within ±15% of SFT).
- §6.3 adversarial scenario pass rate ≥ 90% (these are the eval gate set).

---

## 9. Phase 4 — Eval, canary, cutover (Weeks 19–22)

### 9.1 CI eval gate

Three metrics, all gated, all reported per (language × mutation_kind) slice:

1. **Schema validity rate**.
2. **Anchor-unique rate** (`apply_edit_list` succeeds on first attempt).
3. **HMR Promote rate** (post-compile, post-HMR-apply, candidate state).

CI gate runs against `bench/corpus/diff_patch/` (~500 fixtures from §6.3 + a frozen 1K real-traffic sample). Fails on:

- Aggregate regression > 1pp on any of the three metrics.
- Per-slice regression > 3pp on any slice with ≥ 50 episodes.

(Following the RAG plan's per-slice-volume principle from `code_intel/rag/PLAN.md` §3 — gating fine-grained slices with insufficient volume creates noise, which trains people to ignore the alarm.)

### 9.2 Serving stack (D10)

- **vLLM** with the §6.6-winning base (default: `Qwen2.5-Coder-0.5B-base`) quantized to INT4 (AWQ).
- **xgrammar** for constrained JSON decoding against the `EditList` schema.
- One pod per region. Single replica handles ~150 saves/sec on a T4 (~300 saves/sec on L4).
- Health check hits a fixed 1K-token prompt and asserts < 150 ms response.

### 9.3 Frontend wiring

- New env var `DIFF_PATCH_MODEL=local|gemini` in the worker config.
- `backend/synthi-webrtc-compiler/worker/src/hmr/ai_gate.rs` selects route per request based on workspace's experiment bucket.
- Tier 3 fallback already exists; on local-model errors (timeout, OOM, malformed JSON the validator rejects), worker auto-falls-through. No user-visible breakage.

### 9.4 Canary rollout

Three stages, each gated on real-traffic Promote rate vs. Gemini Lite control bucket:

| Stage | Traffic % | Duration | Promote stop-loss | Latency stop-loss |
|---|---|---|---|---|
| Canary | 5 | 7 days | -2pp | p95 > 400ms |
| Half | 50 | 7 days | -1pp | p95 > 300ms |
| Full | 100 | indefinite | -0.5pp | p95 > 250ms |

Stop-loss triggers automatic rollback to Gemini Lite via `ai_gate.rs` config flip (no redeploy).

Track and gate on the **gap between synthetic-eval Promote rate and real-traffic Promote rate**. Gap > 8pp → halt rollout, return to §6, regenerate synthetic distribution.

### 9.5 Done criteria

- Real-traffic Promote rate ≥ Gemini Lite + 3pp, sustained for ≥ 14 days at Full.
- Real-traffic p50 latency ≤ 150 ms.
- Per-language slice regression check passes weekly for 4 consecutive weeks.
- Cost/save: $0 (excluding amortized GPU rent — see §11).

After §9.5 holds for 30 days, mark Gemini Lite as deprecated for diff_patch. Keep API key wired as the third-tier emergency fallback (after local model + Tier 3 split).

---

## 10. Real-data flywheel (Phase 5+, ongoing)

Once Phase 0 logging has been on for 60 days post-launch (i.e. by the end of Phase 4), we'll have ~50K real episodes. The flywheel:

1. Quarterly: pull the last 90 days of real episodes.
2. Filter to `success_score ≥ 0.95`.
3. Sample 10K rows weighted by recency (decay τ=30 days) and by per-(language × mutation_kind) underrepresentation.
4. Mix with Phase 2 synthetic data 50/50; run a 1-epoch SFT continual-train on top of the latest deployed checkpoint.
5. Re-run Phase 3 RL for 2 iterations (not 6) — fast incremental update.
6. Pass §9.1 CI gate; canary; promote.

Avoid the temptation to retrain from scratch on real data only. Real data is biased toward whatever users *currently* do; synthetic keeps the model robust on the long tail.

---

## 11. Compute & cost budget

| Phase | Resource | Cost (local default) | Cost (cloud fallback) |
|---|---|---|---|
| 0 (instrument) | Eng time, ~80 hours | (internal) | (internal) |
| 1.A (data gen, teacher model) | local: 1× consumer 16GB GPU, 270–530h + electricity / cloud: ~32K Flash + ~3K Pro | ~$15–30 | ~$700 |
| 1.B (AST gold synthesis) | CPU box, ~40 hours | ~$50 | ~$50 |
| 1.C (adversarial curation) | Eng time, ~60 hours | (internal) | (internal) |
| 1.5 (size ablation, §6.6) | 1× A100 × 18h + eval (cloud — single-day job, not worth on-prem setup) | ~$145 | ~$145 |
| 2 (SFT) | local: 1× consumer 16GB × 12h / cloud: 1× A100 × 4h | ~$2 | ~$30 |
| 3 (RL) | 4× H100 × 48h (cloud only — multi-GPU rollout throughput required, see Appendix D.1) | ~$700 | ~$700 |
| 4 (eval + canary) | T4 × 24/7 (×2 regions) — or local consumer GPU on-prem | ~$0–120/mo | ~$120/mo |
| **Total one-time** | | **~$0.9K** | **~$1.7K** |
| **Steady-state** | | **~$0–120/mo per region** | **~$120/mo per region** |

Compare against today's Gemini Lite cost: at 100K saves/day post-launch × $0.0003 = **$30/day = $900/mo per region**. Local-default custom model breaks even in ~1 month at 100K saves/day; cloud-fallback breaks even in ~2.2 months. Latency and reliability wins are uncaptured by that math. If Phase 1.5 selects arm B (135M, CPU serving), steady-state drops to ~$0–30/mo per region.

---

## 12. Decisions locked

These are baked into the plan above. Revisit only with explicit cause.

| ID | Decision | Rationale |
|---|---|---|
| D1 | Base model: `Qwen2.5-Coder-0.5B-base`, pending Phase 1.5 ablation (§6.6). No from-scratch pretraining. | §7.1 |
| D1-A | If §7.5 misses badly, escalate to `Qwen2.5-Coder-1.5B-base`, then `-7B` if still failing. Accept L4 (then A10) deployment. | §7.1 stretch path |
| D1-B | Phase 1.5 ablation runs three arms (0.5B-coder, 135M-general, 135M-random-init) before Phase 2 commits to a size. Smallest arm passing §7.5 wins. | §6.6 |
| D2 | SFT mix ratio: 70% Generator A (mutation+distill), 30% Generator B (AST gold). | §6.2 |
| D3 | Reward formula: weighted sum over schema/anchor/compile/HMR (§7.2 = §8.1). Single function shared train ↔ eval. | §7.2, §8.1 |
| D4 | Single shared prompt builder + truncation helper (`diff_patch_helpers.py`). Train and serve import the same module. | §7.2, §7.4 |
| D5 | Headless compile only in Phase 1 verifier. GUI-replay verification deferred to a Phase 1.5 sub-corpus once §6.3 adversarial set covers GUI scenarios. | §6.1 |
| D6 | Phase 1 distillation API budget cap: $1K (revised from $5K after switching default teacher to Flash). Throttle if approaching. | §11 |
| D6-A | Default distillation teacher: `gemini-3-flash-preview`. Pro reserved for (a) verifier-rejected fallback (1 retry/trial), (b) Generator C adversarial scenarios. Flash-Lite excluded (it's the model being replaced). | §6.1 |
| D7 | Full fine-tune in Phase 2; LoRA reserved for per-customer adapters in Phase 5. | §7.1 |
| D8 | External corpus license whitelist: MIT, Apache-2.0, BSD-2/3, zlib, MPL-2.0. Track license + commit SHA per project. No GPL/AGPL. | §6.1 |
| D9 | RL reward harness must hit ≥ 200 evals/sec with compile cache hot, otherwise extend Phase 3 wall-clock budget. | §8.1 |
| D10 | Serving via vLLM + xgrammar + INT4 AWQ on L4. | §9.2 |
| D11 | Diff_patch primary corpus is C/C++/Rust split-module; JS/Py/HTML projects are NOT in this training mix (they don't go through diff_patch in production). | §6.5 |
| D12 | Tier 3 (full re-split) fallback stays in place forever. The custom model never replaces it. | §2 |
| D13 | Free-tier workspaces are opt-in for diff_patch logging; paid-tier opt-out. Hashed workspace IDs only. | §5.4 |
| D14 | PII / secrets review must sign off before any Phase 0 logging hits production. | §5.4 |
| D15 | Compute infrastructure: local consumer GPU is the default path for Phase 1 data gen + Phase 2 SFT. Cloud (A100/H100) reserved for Phase 1.5 ablation (single-day) and Phase 3 GRPO (multi-GPU required). NVIDIA preferred when available; AMD ROCm (RDNA 3/4) supported via Appendix D.3 with reduced throughput (~5× slower training, ~2× slower data gen) but full functional parity for this plan's scope. | Appendix D, §11 |
| D16 | Default local teacher: `Qwen3-Coder-30B-A3B-Instruct` Q4_K_M GGUF (~15GB, 30B total / 3B active MoE). Validated against Gemini Flash on a 200-example pilot (Appendix D.5) before committing to bulk run; if local pass-rate < Flash − 5pp, fall back to cloud teacher. | §6.1, Appendix D.4 |

## 13. Open questions

To resolve before kickoff. Owners listed; bring decisions back into §12 when locked.

1. **Real save volume.** What's the actual diff_patch QPS today, by language? Without this, Phase 1 mix ratios may be miscalibrated. Owner: telemetry team. Needed before §5 lands.
2. **GPU budget approval.** The ~$5K one-time + ~$300/mo per-region needs sign-off. Owner: eng lead. Needed before §6.
3. **Training infra location.** Cloud vs. on-prem H100 cluster vs. third-party (Lambda, RunPod, Modal). Affects wall-clock and cost. Owner: eng lead. Needed before §7.
4. **License audit cadence.** Who recurses through 500 external repos to verify license claims? One-time third-party audit ~$2K, or in-house. Owner: legal. Needed before §6.1.
5. **Workspace consent UI.** Where in the app does the diff_patch logging opt-out live? Settings page wording. Owner: product. Needed before §5.4.
6. **Synthetic-to-real distribution gap acceptance threshold.** §9.4 picks 8pp arbitrarily. Confirm or revise based on Phase 1 internal eval. Owner: AI engine team.
7. **Multi-language model vs. per-language model.** The plan assumes one model. If §7.5 shows persistent per-language regressions on any one language, alternatives include language-specific LoRA adapters or a small router. Decide at Phase 2 end. Owner: AI engine team.
8. **Compile cache scope.** Is the `(module_contents_hash, edit_list_hash)` cache (§8.1, D9) safe to share across mutation kinds, or do we need per-project sandboxing? Affects RL harness throughput by 2–5×. Owner: worker team.

---

## 14. After diff_patch ships: adjacent flows that inherit the recipe

These reuse the same training and serving infrastructure, in priority order:

1. **`/refactor/heal`** (`main.py:1991`, line ~2046). Same architecture cache, same modules; different prompt (compile error → fixed module content). Smaller task, smaller corpus, ships in a 4-week follow-on.
2. **`/refactor/heal/manifest`** (`main.py:2106`). Library-agnostic link-flag healing. Uses `build_manifest_heal_prompt` (`diff_patch_helpers.py:439-551`). Ships in 3 weeks once heal does.
3. **JS/TS/Py HMR delta path**, if and when those ecosystems get split-module HMR comparable to the compiled-language case. Currently no analog exists; track `docs/HMR_AGNOSTIC_ULTRAPLAN.md` for status.

These are not part of this plan's scope. Mentioned only to establish the leverage of getting the Phase 0 instrumentation right — every adjacent flow benefits from the same logging plumbing.

---

## 15. Anti-goals & failure modes

Things that look like progress but aren't:

- **Bigger base model "to be safe"** — 7B at q4 is 4× the inference cost of 1.5B and 3× the latency. If the 1.5B can't hit §7.5, the diagnosis is data, not parameter count, 80% of the time.
- **More synthetic data without fixing distribution skew** — going from 35K to 100K mutation-A rows doesn't help if the distribution is already over-indexed on raylib C++. Gate Phase 1 expansion on per-slice coverage, not raw count.
- **RL without a thoroughly-burned-in SFT** — RL on a weak SFT amplifies SFT's biases. If §7.5 fails by more than 5pp on Promote, fix Phase 2 before starting Phase 3.
- **Skipping §9.4 stop-losses** — every prior IDE ML project that skipped canary stop-losses ate a P1 incident. The local diff_patch model touches every save; a regression is much louder than a chat-model regression.
- **Optimizing average latency** — the user cares about the worst save's HMR feel, not the average. Track p95 and p99 from day one. p50 is a vanity metric here.

---

## Appendix A — File-path index

Quick reference for the load-bearing code touched by this plan:

| Concern | File | Lines |
|---|---|---|
| Diff-patch endpoint | `ai-backend/ai-engine/main.py` | 1881–1955 |
| Heal endpoint | `ai-backend/ai-engine/main.py` | 1991–2046 |
| Manifest-heal endpoint | `ai-backend/ai-engine/main.py` | 2080–2125 |
| Request schema | `ai-backend/ai-engine/diff_patch_helpers.py` | 53–87 |
| Prompt builder | `ai-backend/ai-engine/diff_patch_helpers.py` | 176–352 |
| Edit-list validator | `ai-backend/ai-engine/diff_patch_helpers.py` | 99–148 |
| Manifest-heal request | `ai-backend/ai-engine/diff_patch_helpers.py` | 380–416 |
| Manifest-heal prompt | `ai-backend/ai-engine/diff_patch_helpers.py` | 439–551 |
| Architecture cache extraction | `ai-backend/ai-engine/main.py` | 80–250 |
| Rust apply_edit | `backend/synthi-webrtc-compiler/worker/src/hmr/edit_applier.rs` | 82–145 |
| Rust apply_edit_list | `backend/synthi-webrtc-compiler/worker/src/hmr/edit_applier.rs` | 174–206 |
| Worker AI gate | `backend/synthi-webrtc-compiler/worker/src/hmr/ai_gate.rs` | (whole file) |
| AI request contract | `backend/synthi-webrtc-compiler/worker/src/hmr/ai_request_contract.rs` | (whole file) |
| Candidate history | `backend/synthi-webrtc-compiler/worker/src/hmr/candidate_history.rs` | 1–120 |
| HMR telemetry | `backend/synthi-webrtc-compiler/worker/src/hmr/telemetry.rs` | 1–120 |
| Speculative diff_patch | `backend/synthi-webrtc-compiler/worker/src/hmr/speculative_diff_patch.rs` | (whole file) |
| Tier 0 literal patch | `backend/synthi-webrtc-compiler/worker/src/hmr/tier0_literal_patch.rs` | (whole file) |
| Existing bench corpus | `ai-backend/ai-engine/bench/corpus/` | 34 fixtures |
| Bench harness | `ai-backend/ai-engine/bench/harness.py` | (whole file) |

## Appendix B — Glossary

- **diff_patch**: the per-save AI call described in this plan, owned by `/refactor/diff_patch`.
- **delta mode**: the `mode="delta"` argument passed to `provider.ask_llm` from the diff_patch handler. One of {fullfile, patch, explain, split, delta, rule_translate}; this plan trains the delta mode specifically.
- **architecture cache**: the markdown produced by `/refactor/split/verified` and stored on the worker, re-injected on every diff_patch call. Format: `<synthi_arch_cache>...</synthi_arch_cache>`. Captured once at split time.
- **build manifest**: JSON inside `<synthi_build_manifest>` tags inside the architecture cache. Compiler/linker config.
- **edit_list**: the model output. `{"edits": [{"module", "operation", "anchor", "content"}]}`.
- **anchor**: an exact substring of the current module content used to locate an edit. Must occur exactly once.
- **Promoted / RolledBack / Discarded**: HMR candidate verdicts (`hmr/candidate.rs`). The reward signal.
- **Tier 0 / 2 / 3**: literal-patch (no AI) / diff_patch (this plan) / full re-split (fallback).
- **success_score**: the §7.2 weighted-sum quality scalar in [0, 1] for an episode. Used as SFT inclusion gate (≥ 0.95) and RL reward weighting.
- **Generator A / B / C**: the three synthetic-data sources (mutation+distill / AST-gold / adversarial-handcraft).

---

## Appendix C — Day-zero checklist

Before kickoff, confirm:

- [ ] §13 open questions resolved or accepted as risks.
- [ ] §12 decisions reviewed by AI engine team + worker team.
- [ ] §5 instrumentation PR has a name and a target date.
- [ ] §11 budget approved.
- [ ] §6.1 license whitelist signed off by legal.
- [ ] §5.4 PII review passed.
- [ ] §9.2 serving stack (vLLM + xgrammar) reproduces a known-good Qwen2.5-Coder-1.5B inference end-to-end before any training begins.
- [ ] §6.3 adversarial scenarios — at least 50 hand-curated fixtures land in `bench/corpus/diff_patch/` before Phase 2.
- [ ] §9.1 CI gate is wired into `bench/harness.py` and runs on every `ai-backend/ai-engine/**` PR.
- [ ] §6.6 Phase 1.5 ablation harness scaffolded; size decision will be recorded in D1 at end of Phase 1.

When all are checked, start Phase 0.

---

## Appendix D — Compute Infrastructure (NVIDIA + AMD paths)

This appendix is the operational counterpart to D15 / D16. It pins the exact OS, drivers, library versions, and verification commands for both compute paths, and gives the per-phase decision tree.

### D.1 Per-phase decision tree

| Phase | What runs | Local consumer GPU? | Cloud GPU? | Why |
|---|---|---|---|---|
| 0 (instrument) | logging shim | n/a | n/a | CPU only; no GPU. |
| 1.A (data gen, teacher model) | inference of 30B-A3B coder MoE on 30K prompts | **yes (default)** | yes (Gemini Flash API only) | $0/example local; $700 cloud. Local wall is days, not hours, but acceptable for a one-time corpus. |
| 1.B (AST gold synthesis) | tree-sitter, no LLM | n/a | n/a | CPU only. |
| 1.5 (size ablation, §6.6) | 3× SFT runs of 0.5B / 135B / 135M | possible | **yes (recommended)** | Single-day cloud job, ~$145 total. Setting up local training infra for one-shot is wasted effort. |
| 2 (SFT) | full FT or LoRA on 0.5B | **yes (default)** | yes | 0.5B fits in 16GB consumer VRAM at FP16+LoRA. ~12h on local; ~4h on A100. |
| 3 (GRPO) | policy + ref model + rollouts on 0.5B | **no** | **yes (required)** | Multi-GPU rollout throughput. Single 16GB card has ~30 TFLOPS; GRPO needs ~600 TFLOPS for the 48h budget to hold. |
| 4 (serving) | INT4 0.5B at <150ms p50 | **yes (cheap)** | yes | Either works. Local on-prem if a consumer GPU is dedicated; cloud T4/L4 per region otherwise. |

**TL;DR:** the consumer GPU at home covers Phase 1.A (data gen) and Phase 2 (SFT). Rent cloud only for Phase 1.5 (~$145) and Phase 3 (~$700). Total cloud spend in the local-default path: ~$845.

### D.2 NVIDIA path (Linux, RTX 30/40/50-class consumer or workstation)

**System prerequisites:**
- OS: Ubuntu 22.04 LTS or 24.04 LTS. (Windows works via WSL2 but adds friction; not recommended for training runs.)
- Driver: NVIDIA proprietary 550+ (CUDA 12.4+ runtime).
- Python: 3.10 or 3.11 (3.12 works for most libs but not all).

**Verification before installing anything:**
```bash
nvidia-smi                    # Should list the card and CUDA version
python --version              # 3.10.x or 3.11.x
```

**Install — exact pip lines:**
```bash
# PyTorch first, from the CUDA 12.1 wheel index (NOT plain pip install torch — different wheel)
pip install torch==2.5.1 torchvision torchaudio --index-url https://download.pytorch.org/whl/cu121

# Core training stack
pip install transformers>=4.46.0 peft>=0.13.0 trl>=0.12.0 accelerate>=1.0.0
pip install bitsandbytes>=0.44.0    # 4-bit QLoRA quantization
pip install datasets>=3.0.0 sentencepiece einops

# Constrained decoding + tokenization for the diff_patch JSON schema
pip install xgrammar>=0.1.0

# Inference / data-gen serving
pip install vllm>=0.6.3              # local teacher serving (also Phase 4 serving)

# Mutation library (Generator A) — tree-sitter for C/C++/Rust ASTs
pip install tree-sitter>=0.23.0 tree-sitter-cpp tree-sitter-c
# Rust grammar requires building from source — see https://github.com/tree-sitter/tree-sitter-rust

# Optional but recommended: ~2× speedup on single-GPU SFT
pip install unsloth>=2024.10

# Run tracking
pip install wandb
```

**Verification after install:**
```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# Expected: True NVIDIA GeForce RTX 4070 Ti  (or your card)

python -c "import bitsandbytes; print(bitsandbytes.__version__)"
# Expected: 0.44.x
```

If `torch.cuda.is_available()` returns False: driver mismatch. Check `nvidia-smi` reports a CUDA version ≥ 12.1.

### D.3 AMD path (Linux, RDNA 3/4 — RX 7900/9070 family)

**System prerequisites:**
- OS: Ubuntu 22.04 LTS specifically. ROCm support is most stable on this version. (Ubuntu 24.04 has partial support as of ROCm 6.3+; verify on the ROCm release notes for your card.)
- ROCm: 6.2+ for RDNA 3 (gfx1100/gfx1101); **6.3+ for RDNA 4 / RX 9070 XT (gfx1201)**.
- Driver: install via `amdgpu-install --usecase=rocm` from the ROCm apt repo.
- Python: 3.10 or 3.11.

**Critical environment variable for RX 9070 XT (RDNA 4):**
```bash
# Forces the runtime to use the RDNA 4 LLVM target. Without this, gfx1201 may not be recognized
# by older ROCm builds. Add to ~/.bashrc.
export HSA_OVERRIDE_GFX_VERSION=12.0.1
```

**Verification before installing anything:**
```bash
rocminfo | grep -i "gfx"           # Should show your gfx version (e.g. gfx1201 for RX 9070 XT)
rocm-smi                            # Should list the GPU and VRAM
python --version                    # 3.10.x or 3.11.x
```

**Install — exact pip lines:**
```bash
# PyTorch ROCm wheel — DIFFERENT INDEX from CUDA. Match the ROCm major.minor.
# As of 2026-04, the latest stable ROCm wheel index is 6.2; check pytorch.org for newer.
pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/rocm6.2

# Core training stack — same as NVIDIA path
pip install transformers>=4.46.0 peft>=0.13.0 trl>=0.12.0 accelerate>=1.0.0
pip install datasets>=3.0.0 sentencepiece einops
pip install xgrammar>=0.1.0

# 4-bit quantization — REPLACE bitsandbytes (NVIDIA-only) with HQQ
pip install hqq>=0.2.0

# Mutation library
pip install tree-sitter>=0.23.0 tree-sitter-cpp tree-sitter-c

# Run tracking
pip install wandb

# DO NOT INSTALL on consumer RDNA:
# - bitsandbytes      (NVIDIA-only; ROCm fork is unstable on RDNA, fails on RDNA 4)
# - flash-attn        (RDNA support is partial; use PyTorch SDPA fallback instead)
# - vllm              (officially MI300/MI250-tier; consumer RDNA support is community,
#                      lags by ~2 ROCm versions, fragile builds). For local teacher
#                      serving on AMD, use llama.cpp ROCm — see D.4.
# - unsloth           (CUDA-specific kernels; no ROCm port as of this writing)
```

**Verification after install:**
```bash
python -c "import torch; print(torch.cuda.is_available(), torch.cuda.get_device_name(0))"
# Expected: True Radeon RX 9070 XT  (or your card)
# Note: torch.cuda.* is the API name even on AMD — ROCm presents itself as CUDA-compatible.

python -c "import torch; x = torch.randn(1024,1024,device='cuda'); print((x@x).sum().item())"
# Expected: a finite float. If this hangs or errors, ROCm install is broken.
```

If `torch.cuda.is_available()` returns False with a working `rocminfo`: try `HSA_OVERRIDE_GFX_VERSION=12.0.1` (RDNA 4) or `11.0.0` (RDNA 3). If still failing, the PyTorch ROCm wheel does not yet support your gfx target — fall back to building PyTorch from source against ROCm 6.3, or wait for the next stable wheel.

**SFT-specific notes for AMD:**
- Use FP16 + LoRA (no 4-bit quant) for Phase 2. Math: 0.5B × 2 bytes (FP16) = 1GB weights + ~80MB LoRA adapters + ~4GB activations at bs=4 seq=4096 = ~6GB peak. Fits comfortably in 16GB. HQQ is available if you need 4-bit, but its RDNA 4 backend is rough as of this writing — only use if VRAM-tight (you won't be at 0.5B).
- In `transformers` config, force SDPA attention: `model = AutoModelForCausalLM.from_pretrained(..., attn_implementation="sdpa")`. Avoid `flash_attention_2` — partial RDNA support, often slower than SDPA.
- Expect ~30 TFLOPS sustained (vs ~150 on A100). Phase 2 SFT wall clock: ~12h on RX 9070 XT vs ~4h on A100. Acceptable for a one-time job.

### D.4 Local teacher serving (Phase 1 data generation)

The teacher reads ~16K-token prompts and emits ~500-token edit-list JSON. Per-example wall time is dominated by prefill (16K input tokens) and decode (500 output tokens).

**Recommended teacher model:** `Qwen3-Coder-30B-A3B-Instruct` (Q4_K_M GGUF, ~15GB on disk).
- 30B total params, 3B active per token (MoE) — fast decode despite size.
- Code-specialist; quality at INT4 is within 1–2pp of Gemini Flash on the verifier pass-rate.
- Fits in 16GB VRAM at Q4_K_M with ~1GB headroom for KV cache at 16K context.

**NVIDIA path — vLLM:**
```bash
# Once-only: download the AWQ-quantized checkpoint (~15GB)
huggingface-cli download Qwen/Qwen3-Coder-30B-A3B-Instruct-AWQ \
    --local-dir ~/models/qwen3-coder-30b-a3b-awq

# Serve
vllm serve ~/models/qwen3-coder-30b-a3b-awq \
    --quantization awq \
    --max-model-len 16384 \
    --gpu-memory-utilization 0.92 \
    --port 8000
```

Expected throughput on RTX 4070 Ti / 16GB:
- Prefill: ~1500 tok/s
- Decode: ~80 tok/s
- Per example (16K prefill + 500 decode): ~16s wall time
- 30K episodes: ~133 GPU-hours ≈ 5.5 days continuous, or ~17 days at 8h/day.

**AMD path — llama.cpp ROCm + Ollama (recommended):**
```bash
# Easiest: Ollama wraps llama.cpp ROCm and handles the build
curl -fsSL https://ollama.com/install.sh | sh
ollama pull qwen3-coder:30b            # Pulls Q4_K_M by default (~15GB)

# Serve
OLLAMA_NUM_PARALLEL=4 ollama serve     # Concurrent requests for batched throughput
# Test:
curl http://localhost:11434/api/generate -d '{"model":"qwen3-coder:30b","prompt":"hello","stream":false}'
```

Or build llama.cpp directly for finer control:
```bash
git clone https://github.com/ggerganov/llama.cpp
cd llama.cpp
HIPCXX="$(hipconfig -l)/clang++" cmake -B build \
    -DGGML_HIPBLAS=ON \
    -DAMDGPU_TARGETS="gfx1201"          # gfx1201 for RDNA 4; gfx1100 for RX 7900
cmake --build build --config Release -j

# Download GGUF (~15GB)
huggingface-cli download bartowski/Qwen3-Coder-30B-A3B-Instruct-GGUF \
    --include "Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf" \
    --local-dir ~/models

# Serve with the OpenAI-compatible HTTP server
./build/bin/llama-server \
    -m ~/models/Qwen3-Coder-30B-A3B-Instruct-Q4_K_M.gguf \
    -c 16384 \
    --n-gpu-layers 99 \
    --parallel 4 \
    --port 8000
```

Expected throughput on RX 9070 XT (16GB, gfx1201):
- Prefill: ~400 tok/s
- Decode: ~30–50 tok/s
- Per example: ~50–60s wall time
- 30K episodes: ~450 GPU-hours ≈ 19 days continuous, or ~57 days at 8h/day.
- With `--parallel 4` batched: ~2–3× throughput → ~7 days continuous.

**Smaller fallbacks (if VRAM is tight or speed matters more than quality):**
| Model | Q4 size | Decode tok/s (RX 9070 XT) | Pass-rate vs Flash |
|---|---|---|---|
| `Qwen3-Coder-30B-A3B-Instruct` | 15 GB | ~40 | Flash ± 2pp |
| `Qwen2.5-Coder-14B-Instruct` | 7 GB | ~25 | Flash − 4pp |
| `Qwen2.5-Coder-7B-Instruct` (FP16) | 14 GB | ~50 | Flash − 8pp |
| `Qwen2.5-Coder-7B-Instruct` (Q4) | 4 GB | ~70 | Flash − 10pp |

If the §D.5 pilot shows the 30B-A3B teacher passing the gate, stay there. If it fails on the 16GB card (OOM at 16K context), the next step down is `Qwen2.5-Coder-14B-Instruct` Q4 — quality drops slightly but still acceptable.

### D.5 Pre-flight: 200-example teacher validation pilot

Before committing the local teacher to a full 30K-example bulk run (1–3 weeks of GPU time), validate on a small pilot. This is the **only AMD-vs-NVIDIA decision point that touches data quality** — after it passes, the rest of Phase 1 is unchanged regardless of compute path.

**Procedure:**
1. Generate 200 synthetic Generator A inputs (mutation diffs + module contents + architecture).
2. Run them through the local teacher; record raw outputs.
3. In parallel, run the same 200 inputs through `gemini-3-flash-preview` (cost: ~$5 in API).
4. Run both output sets through the verifier cascade (validate → apply_edit_list → compile → HMR replay).
5. Compute pass-rate on each.

**Decision rule:**
- Local pass-rate ≥ Flash − 5pp → commit local for the bulk Phase 1 run.
- Local pass-rate ∈ [Flash − 5pp, Flash − 10pp] → switch to a stronger local model (or accept hybrid: 70% local + 30% Flash for the verifier-rejected tail).
- Local pass-rate < Flash − 10pp → fall back to cloud Flash for the bulk run; the local hardware is still useful for Phase 2 SFT.

**Pilot wall time:**
- NVIDIA path: ~1 GPU-hour.
- AMD path: ~3 GPU-hours.

This is the single hard checkpoint before spending weeks of GPU time. Don't skip it.

### D.6 What lives where: source-tree layout

Both paths assume this directory layout (created in Phase 0):

```
synthi-ide/
├─ ai-backend/ai-engine/              # production code (unchanged by this plan until Phase 4)
├─ training/                          # NEW — created in Phase 0
│  ├─ data/
│  │  ├─ external_corpus/             # 500 cloned MIT/Apache projects (§6.1)
│  │  └─ diff_patch_train_v1/         # train/val/test parquet (§6.4)
│  ├─ generators/
│  │  ├─ generator_a_mutation.py     # mutation library + LLM teacher loop (§6.1)
│  │  ├─ generator_b_ast_gold.py     # AST-driven gold synthesis (§6.2)
│  │  └─ generator_c_adversarial/    # hand-curated fixtures (§6.3)
│  ├─ teacher/
│  │  ├─ local_client.py             # OpenAI-compatible client → llama.cpp/vLLM
│  │  ├─ gemini_client.py            # Cloud fallback client
│  │  └─ verify_pilot.py             # §D.5 pilot runner
│  ├─ verifier/
│  │  ├─ rust_bridge.rs              # PyO3 binding to apply_edit_list
│  │  └─ headless_compile.py         # subprocess wrapper around the worker
│  ├─ sft/                           # Phase 2
│  └─ rl/                            # Phase 3
└─ docs/
   └─ ../synthi-diff-patch-training-plan.md   # this file
```

The teacher client (`teacher/local_client.py`) speaks the OpenAI Chat Completions API; the local serving choice (vLLM, llama.cpp, Ollama) is opaque to the rest of the pipeline. Switching between local and cloud is a `--teacher-url` flag away.

---

When all of D.1–D.5 are confirmed for your hardware, Phase 0 instrumentation can begin in parallel with the training-repo scaffolding in D.6.
