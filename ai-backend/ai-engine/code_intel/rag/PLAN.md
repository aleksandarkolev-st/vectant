# RAG: Agentic + Verified Plan

Status: decisions locked (§13, D1–D15). Implementation can begin on Phase 0.
Owner: AI engine team. Genome integration contract (Appendix A) co-owned with the genome team.
Last updated: 2026-04-28 (D9–D15 added; Appendix A added; §6.6 contamination check; episodic-memory entry in §16; slice-geometry honesty in §3 / §6.1 / §7.1).

---

## 1. Goal

Move RAG from "feels okay on hand-tested queries" to **measurably correct on a labeled eval set, with verified citations, abstention when grounding is weak, and per-query latency budgets that fit an IDE**.

Accuracy first, but explicitly bounded by per-query cost.

## 2. Non-goals

- Replacing the current pipeline. The current pipeline is the fallback when the agent path is bypassed, fails its turn cap, or routes "easy."
- Going multi-tenant. Pod-per-workspace stays (memory: `project_rag_isolation`).
- Generic agentic RAG. Bounded ReAct with a fixed tool surface, not autonomous exploration.
- Replacing shadow's verification. Shadow stays the toolchain-grade verifier for code-modifying queries; RAG verification handles non-code queries.

## 3. Why the eval set gates everything

Without 150+ labeled queries with three CI-gated metrics, every change below is vibes. An agent loop in particular is exactly the kind of change where vibes lie to you: it'll feel smarter on a dozen test queries while regressing on the long tail.

**Three metrics, all gated in CI, all reported per-slice:**
1. **Section-level recall@k** - did we retrieve the right sections? Mechanical, deterministic. k=5, 10, 20.
2. **Citation precision** - do cited sections actually support the claim? LLM judge with fixed rubric, temperature 0, seeded.
3. **Answer correctness** - LLM-judged against `gold_answer`, fixed rubric, seeded.

If recall goes up but citation precision drops, the change made things worse. Aggregate metrics hide long-tail regressions, so the CI gate also fails on per-slice regressions — but only on slices with enough volume to support a meaningful gate. **v1 gates on `query_type` only, and only on types with ≥ 15 queries** (§6.1 details). `language` and corpus-size cells are reported in dashboards but not gated until Phase 1.5 real-signal accumulates them past n=15. Pretending 150 queries supports 96-cell three-axis gating is how you train people to ignore the alarm (D15).

## 4. Why section IDs are a Phase 0 prerequisite

The original draft put section ID design in Phase 3. That was wrong. Section IDs are load-bearing across **every cache and every eval label**:

- Section embeddings (Phase 2) keyed on section ID.
- Entailment cache (Phase 4) keyed `(section_id, claim_hash, judge_model)`.
- Agent's per-turn `fetch_section` cache keyed on section ID.
- Eval gold labels reference `expected_section_ids` - refactor a fixture, the labels rot.
- Reranker cache and trace artifacts both reference section IDs.

If structural IDs break on refactor - and refactor is exactly when they break - every cache invalidates simultaneously. Cold-start regresses. Eval metrics move in ways that can't be cleanly attributed to the change being measured.

**Therefore the ID derivation, fingerprint, and migration step must be designed and tested before Phase 2 commits to embedding millions of sections against those IDs.**

### 4.1 Section ID design (v1)

```
section_id          = sha1(file_path + "::" + toc_path).hex()[:16]
content_fingerprint = simhash(normalize(section_text), 64-bit)
schema_version      = 1   # bump when derivation changes; full rebuild
```

`toc_path` is the slash-joined heading chain from the existing contextual-header logic, e.g. `auth/oauth/token-refresh`.

The ID is **structural primary key**. The fingerprint is the **reconciliation hint**. Together they handle the four refactor cases:

| Case            | Old ID exists? | Fingerprint match? | Action                                                  |
|-----------------|----------------|--------------------|---------------------------------------------------------|
| Edit-in-place   | yes            | yes                | Update embedding if content differs; keep caches.       |
| Heavy edit      | yes            | no                 | Force re-embed; entailment cache stays but is suspect.  |
| Move/rename     | no (new ID)    | yes (old deleted)  | Migrate caches old → new, log migration.                |
| Merge / split   | no             | partial            | Copy embedding to all new IDs, expect divergence later. |
| New section     | no             | no                 | Fresh ID, fresh embedding, no cache transfer.           |

### 4.2 Reconciliation algorithm

On re-ingest:
1. Build new `(section_id, content_fingerprint)` set from new ToC.
2. Identify deletions (old IDs not present in new set) and creations (new IDs not present in old set).
3. For each new ID, scan deleted IDs for `hamming(new.fp, deleted.fp) ≤ 4` (over 64 bits).
4. If exactly one match → migrate caches: copy entailment entries, embeddings, reranker cache to new ID; emit a `MigrationEvent` to the trace.
5. If multiple matches → ambiguous, log as `reconciliation_skipped`, fresh embed.
6. Otherwise → fresh.

Hamming threshold of 4 ≈ "same section, light edits." Threshold is tuned on a Phase 0 deliverable: `test_section_id_reconciliation.py` exercises rename/edit/merge/split fixtures, measures correct-reconcile vs false-reconcile.

### 4.3 Migration audit log

Every migration writes one line:
```jsonl
{"old_id": "...", "new_id": "...", "reason": "fingerprint_match",
 "hamming": 2, "old_path": "...", "new_path": "...", "ts": ...}
```

Eval traces include the audit log for that ingest. When a query metric regresses after a re-ingest, we can attribute it to a migration that crossed a content boundary.

### 4.4 Why simhash and not shingle/minhash

simhash is one 64-bit XOR + popcount per comparison. Storage is 8 bytes per section. Shingle/minhash is more robust but adds storage and computation. v1 uses simhash; if reconciliation accuracy on the test fixture is < 90%, we revisit.

### 4.5 Embedding model versioning

Section IDs are versioned (`schema_version`). The embedding model is not — and that's the silent failure mode. An embedding model upgrade puts old vectors and new query embeddings in different semantic spaces; recall collapses without an obvious failure signal because nothing throws.

Add `embedding_model_version: str` to the schema metadata, e.g. `"<provider/model@YYYY-MM>"`. On startup, the pipeline reads the stored version and compares to the configured one:

- Match → load existing index.
- Mismatch → force re-embed all sections with the new model. Log an `EmbeddingModelChange` event to the trace. Cold-start regresses to first-ingest cost; this is correct.

The check is one equality comparison plus one startup log line. Cost: trivial. Cost of not having it: user-invisible recall regression on next deploy.

## 5. What we're not reinventing

The shadow and bench stacks already provide most of the eval substrate:

- **`bench/synthi_report.py`** runs RAG (4 steps + fusion + synthesis) and shadow (cost ledger, signals, events) in one direct-Python report. Commit `fd842ca2`.
- **`bench/harness.py`** has the corpus-fixture runner. Fixture format: `request.txt` + `seed_patches.json` + `metadata.json` + `workspace/`. 34 cross-language fixtures.
- **`bench/metrics.py`** has the metric scaffolding and stubbed Critic precision/recall - explicitly designed to grow into real ground-truth measurement.
- **`bench/tune_weights.py`** does grid-search on `results.json`. Reusable pattern for the reranker blend sweep.
- **`shadow/preference.py`** stores accepted patches keyed on `request_summary` - a pre-built stream of real-signal positives.
- **`shadow_continuous/regression_runner.py`** captures pass→fail regressions on save, LLM-free, $0.50/day cap. A pre-built stream of real-signal negatives.
- **`shadow/cost_ledger.py`** with daily cap, refunds, and a dashboard endpoint.
- **`code_intel/rag/observability/`** tracer captures every tool/retrieval/model call.

We extend these. We don't fork them.

---

## 6. Phase 0 - Foundations (gates everything)

Build all of these before any pipeline change. Ship nothing in Phase 2+ until Phase 0 lands.

### 6.1 Eval harness

- Extend `bench/synthi_report.py` with a RAG-eval mode: takes a query set + pipeline config, produces per-query results with full traces.
- Three scorers as separate modules so they evolve independently:
  - `bench/eval/scorers/recall_at_k.py` - deterministic set-comparison.
  - `bench/eval/scorers/citation_precision.py` - LLM judge, fixed rubric, fixed seed, pinned model.
  - `bench/eval/scorers/answer_correctness.py` - LLM judge against `gold_answer`, fixed rubric, fixed seed.
- Judge call cache keyed `(rubric_version, query_id, system_output_hash, judge_model)`. Rubric changes are explicit version bumps.
- Trace artifacts written to `bench/eval/runs/<run_id>/`.
- CI gate scope (v1): aggregate threshold **plus** per-slice thresholds **only on `query_type`**. `language` and corpus-size buckets are reported in trace dashboards for visibility but **not gated** until cell volume crosses n=15 (D15). Real-signal accumulation (Phase 1.5) is the path to multi-axis gating.
- **Per-`query_type` gate threshold**: types with < 15 queries are reported but not gated. With the eval distribution in §7.1, that's ~all types except `ambiguous` (~5) — the synthesis pass rebalances to ≥ 15 per type before gate activation.
- **Regression detection is 2σ-based**, not absolute-threshold. A drop must exceed `2 × sqrt(p(1-p)/n)` for the slice's sample size to fire the gate. At n=15 with p=0.7 that's ~24pp; at n=40 it's ~14pp. Noisy slices get noisier gates — correct, because the alternative is fixed thresholds firing on sample variance.
- **Cross-slice asymmetry on `answer_correctness`**: code-modifying answers are judged by Genome's Arbiter (executable evidence — see Appendix A); explain/lookup answers are judged pairwise by the LLM judge. Different methodologies; aggregate "answer correctness" across both slices is apples-to-oranges. **Report per-slice only; the CI gate compares each slice against its own baseline.** No cross-slice aggregate.

### 6.2 Labeling schema (typed)

```python
@dataclass
class EvalQuery:
    query_id: str
    query: str
    query_type: Literal["lookup", "multi_hop", "ambiguous", "unanswerable",
                        "fix", "implement", "refactor", "explain"]
    expected_doc_ids: list[str]
    expected_section_ids: list[str]
    gold_answer: Optional[str]              # None for unanswerable
    gold_citations: list[str]               # section_ids
    is_unanswerable: bool
    language: Optional[str]                 # "python", "ts", "go", ...
    corpus_id: str                          # which corpus this targets
    source: Literal["synthetic", "shadow_corpus", "preference_store",
                    "regression_log"]
```

`query_type` reuses shadow's `intent` values where applicable so the tier classifier can read it directly.

### 6.3 Section ID + fingerprint + migration

- `code_intel/rag/section_id.py` implements derivation, simhash fingerprint, and reconciliation.
- `code_intel/rag/tests/test_section_id_reconciliation.py` exercises rename/edit/merge/split scenarios with at least 90% correct-reconcile and < 5% false-reconcile.
- Migration audit log piped into the observability tracer.
- `schema_version = 1` constant. Future ID-derivation changes bump it and trigger full re-embed; document the runbook.
- `embedding_model_version` field persisted alongside `schema_version` (see §4.5). Mismatch on startup forces full re-embed and emits `EmbeddingModelChange` to the trace.

### 6.4 LLM judge harness

- Pin judge model in scorer config. v1: `gemini-3-flash-preview` for the CI loop (cost), with ~20% sampled re-scoring on a stronger judge for calibration.
- Rubric files as versioned text in `bench/eval/rubrics/citation_v1.md` etc.
- Determinism: temperature 0, fixed seed, pinned model version, locked rubric. Any change → version bump → full re-score.

### 6.5 Phase 0 exit criteria

- [ ] Eval runner produces traces for a 10-query smoke set.
- [ ] All three scorers produce stable scores across two runs (no judge flakiness).
- [ ] Section ID reconciliation test passes the 90/5 thresholds.
- [ ] `embedding_model_version` persisted in schema and verified on startup; mismatch path tested.
- [ ] Contamination check passes on synthetic queries (§6.6).
- [ ] CI gate config exists and passes on baseline.

### 6.6 Synthetic query contamination check

A synthetic query whose answer the judge model already knows from training data is a degenerate eval point — it tests the model's recall of training data, not the system's retrieval. If 30%+ of synthetic queries are contaminated, recall@k metrics are biased upward by an unknown amount and the gate is meaningless.

**Check:** for each synthetic query, run the judge model with **no retrieval and no corpus** (zero-context). Compare the zero-context output against `gold_answer`:

- Token overlap (lowercased, stemmed) ≥ 50% → flag as contaminated, drop from eval set.
- Token overlap 30-50% → flag for human review (added to spot-check list).
- Token overlap < 30% → keep.

Cost: one judge call per synthetic query during eval-set construction (~$0.001 × 100 queries = $0.10 one-time). Re-run on every synthetic-corpus regeneration. Report contamination rate in the eval-set metadata; track over time.

This complements the spot-check (label-correctness) — contamination is a *different* failure mode (label is correct, query is degenerate) and the spot-check doesn't catch it.

---

## 7. Phase 1 - Eval data

In parallel with Phase 0. Total v1 eval set ≈ 150 queries.

### 7.1 Sources

- **~34 code-modifying queries from the existing shadow corpus.** Free, deterministic ground truth: `expected_section_ids` derived from the file paths/regions touched by `seed_patches`. `query_type` from `metadata.json` `intent` field. These are the highest-quality eval points we have.
- **~100 RAG-only queries** (explain/lookup over the seed corpus). Synthetic generation: prompt an LLM with the seed corpus and ask it to produce queries + gold sections + gold answers in one pass.
- **Human spot-check 50** of the synthetic. Spot-check the **labels**, not just whether queries look reasonable - LLM-labeled gold drifts subtly.
- **~20 unanswerable queries** (~15%). Plausible questions with no good answer in the corpus. Correct behavior = abstention. **Non-negotiable**, ships in v1. Without this slice, every metric rewards confident answering and the system trains toward hallucination.
- **~10 adversarial negatives** (~7%). Queries that *look like* they should match a section but don't — e.g., asking about a config flag with a name similar to a real one, or a function whose signature matches but lives in a different module. These sharpen the abstention contract beyond the unanswerable slice (which is "no plausible match"). Adversarial negatives are "plausible-but-wrong-match" — the harder failure mode where confident retrieval cites the wrong thing. Free if generated alongside the synthetic pipeline; the prompt that produces synthetic queries also produces a `near_miss` for each.

**Per-`query_type` floor: ≥ 15 queries each** (D15). The synthesis pass rebalances to ensure no `query_type` falls below the gate-activation threshold. Without this, types like `ambiguous` (≈ 5 by default) and `refactor` (≈ 10) report metrics at sample-variance noise levels, and the per-slice CI gate fires on noise rather than real regressions. Types under 15 are reported but not gated until volume accumulates via Phase 1.5 real-signal capture.

### 7.2 Held-out split

- 30% of synthetic queries → held-out validation set, sampled less often than the CI gate to avoid metric overfitting.
- Real-signal queries (Phase 1.5) accumulate into the held-out set.

### 7.3 Phase 1 exit criteria

- [ ] ≥ 150 labeled queries, ≥ 15% unanswerable, ≥ 7% adversarial negatives.
- [ ] Spot-check report shows ≥ 90% label correctness on the sampled 50.
- [ ] CI baseline run completes with all three scorers and a slice breakdown.

---

## 8. Phase 1.5 - Real-signal capture (in parallel)

Two streams of real signal already exist; we're not capturing them as eval data yet.

- **`shadow/preference.py`** = positive examples. Each accepted patch has `request_summary` + `accepted_diff` + `arbiter_winner`. Map `request_summary` → query, `accepted_diff` paths → expected files. `query_type` from shadow `intent`.
- **`shadow_continuous/regression_runner.py`** = negative examples. A previously-passing test now failing means the context that fed the original change had a gap. When RAG is wired into the chat path producing the patch, regression findings become "this RAG retrieval was insufficient" data points.

Build `bench/eval/realsignal_ingest.py` that pulls from both, deduplicates by `(workspace, query_normalized)`, and lands them in the held-out validation set. Doesn't need to be perfect on day one - just plumbed.

Privacy: workspace-scoped, opt-in. Redact code content if we ship beyond ourselves.

---

## 9. Phase 2 - Macro recall fixes (eval-gated, sequential)

Each step is its own commit, its own eval run, its own go/no-go.

### 9.1 Section-level embeddings

Macro retrieval becomes RRF-fuse of `(summary hits, section hits)` → dedupe to docs → top-K docs. Expected biggest single recall@k jump.

**Cost watch**: doubles macro index size, adds embedding cost during ingest. Cold-start (already 60s+ for 5 docs in bench, minutes for real corpora) gets worse. Mitigation: eager in v1; lazy fallback (top-K-accessed first, background fill) **only if** cold-start p95 exceeds 90s on a real-corpus measurement (D4).

### 9.2 Reranker blend sweep + min_similarity retune

Currently 0.6 blend / 0.3 floor are guesses. Grid-search on the eval set using `bench/tune_weights.py` pattern. Pick the point that maximizes citation precision without dropping recall@k below baseline.

### 9.3 Header A/B

Commit `4426ed69` added contextual headers. Measure with/without on the eval set. If lift is below the noise threshold, revert - the implementation has drift. Anthropic's writeup showed ~35% retrieval-failure reduction; we should see something in that ballpark.

### 9.4 AST-aware chunking for code files

`section_splitter.py` is ToC-based. Correct for prose docs, wrong for code files — for `fix`/`implement` queries the relevant unit is a function or class, not a heading-bounded section. The fix/implement slice is most of IDE traffic, which makes this the highest-leverage chunking change.

The `code_intel/ingestion/parsers/` modules already declare regex-based parsers as placeholders — their own comment says "for production, use tree-sitter or libclang." Replace those with tree-sitter implementations (Python, TS/JS, Go, Rust to start) and call into them from `section_splitter.py` when the document loader detects a code file by extension.

Section ID derivation (§4.1) accommodates this naturally: `toc_path` becomes the AST path (e.g. `module/ClassName/method_name`) instead of the heading chain. simhash fingerprint and reconciliation work unchanged. The reconciliation test fixture (§6.3) gains code-file rename/refactor cases.

Expected lift: 10-20% recall@k on the fix/implement slice. Measure before/after on the eval set; ship if recall improves without dropping citation precision below baseline.

### 9.5 Decision point

If Phase 2 clears the targets on the held-out set, **stop here**. Don't build the agent. The simplest pipeline that meets the bar wins. This is a real possible outcome and the plan reserves explicit room for it.

---

## 10. Phase 3 - Tool layer (only if Phase 2 doesn't clear the bar)

Design pass before any controller code. Tool contracts written and reviewed separately.

### 10.1 Tool surface

```
search_macro(query)                       → [{doc_id, summary, score, breadcrumb}]
search_sections(query, doc_ids?)          → [{section_id, snippet, breadcrumb, score}]
fetch_section(section_id)                 → {content, metadata, neighbors_preview}
fetch_neighbors(section_id, depth=1)      → [section]
fetch_file_outline(doc_id)                → ToC tree
verify_with_shadow(patches, tier="quick") → {verdict, findings, cost_usd}
give_up(reason)                           → terminal
answer(text, citations: [{claim, section_ids}]) → terminal
```

### 10.2 Contract requirements

- **Stable section IDs across re-ingest.** See §4. This is the load-bearing constraint.
- **Structured errors**: `{kind: "no_results" | "timeout" | "out_of_workspace" | "rate_limit", retriable: bool, message}`. Different error kinds → different agent recovery paths. Empty lists for everything → loops.
- **Per-turn fetch cache** so the controller isn't penalized for re-asking.
- **Snippets, never blobs**, until `fetch_section` is called. Context bloat is the silent killer.
- **`give_up`** prevents hallucination-as-completion when the corpus genuinely lacks the answer.
- **`verify_with_shadow`** is gated by the cost ledger and respects the daily cap.

---

## 11. Phase 4 - Bounded agent + verification (only if Phase 3 ships)

### 11.1 Routing tier

Reuse shadow's existing `intent` field. No new classifier.

| `intent`                  | Path        |
|---------------------------|-------------|
| `explain`                 | Easy. Fixed pipeline, no agent. |
| `fix` / `implement` / `refactor` | Hard candidate. Agent path with shadow verification. |

Within hard-candidate, an additional gate: if `search_macro` returns a high-confidence single-doc hit (top-1 above threshold AND margin over top-2 above threshold) AND the query is short/lookup-shaped → fall back to fixed pipeline.

Estimate (guess, will be measured): 60–80% of IDE queries hit the easy path.

### 11.2 Agent loop

- Controller: `gemini-3-flash-preview` (exact pinned version, not alias). Escalate only if eval shows controller errors are a leading failure mode.
- N=3 default turns, N=5 ceiling.
- **Self-critique pass shipped in v1**, behind a `rag.self_critique` feature flag (default on). After the controller emits `answer(text, citations)`, a critique step runs:
  1. Reads the proposed answer + citations + retrieved sections.
  2. Outputs a structured claim list with a verdict per claim: `supported` | `unsupported` | `partial`.
  3. If any claim is `unsupported` or two+ are `partial` → one repair turn (counts toward the N=5 ceiling).
  4. After repair, emit final answer with the structured claim list attached for downstream entailment scoring.

  Cost: one Flash call (~$0.001, ~300ms). Hard-path Gemini-call count goes 5 → 6 (worst case 7 with repair); see §11.5.

  The flag exists for eval ablation: we measure self-critique's contribution per slice. Genome's existing Critic universe is the architectural analogue — treating RAG agent emission as un-critiqued is inconsistent with the rest of the verification surface (D9). The pass also produces the structured claim list naturally, so it composes with claim-level entailment in §11.3 instead of duplicating work.

  **Not on the easy path.** Easy-path queries don't have the multi-claim structure self-critique helps with; running it there is overhead without benefit.

- Hitting the ceiling without `answer` or `give_up` → fall back to fixed pipeline + flag the query for offline review.

### 11.3 Verification - split by query type

This is the simplification shadow buys us.

- **`explain` and RAG-only queries** → claim-level entailment, batched + cached.
  - One model call per query checks all claims against all cited sections.
  - Cache key `(section_content_hash, claim_hash, judge_model)`. Content-hash invalidation handles section edits cleanly.
  - Repeats across users in an IDE more than expected (same codebase, similar questions).
- **`fix` / `implement` / `refactor` queries** → agent calls `verify_with_shadow(proposed_patch, tier="quick")` before answering.
  - Shadow runs the toolchain. Pass = strong signal. Fail = revise.
  - Costs ~$0.01–0.05 per quick run, gated by the existing cost cap.
  - **Strictly stronger** than entailment for code: actually applies the patch and runs tests.

### 11.4 Confidence and abstention

Confidence = fraction of claims supported (entailment path) or shadow verdict (code path). Below 0.7 (entailment) or shadow-fail with no recovery (code), the answer becomes:

> "I found X. I can't verify Y."

Explicit abstention contract. **Not** a confidently-toned hedge - users round those to confident.

### 11.5 Latency & cost budget

| Path                          | p50      | p95     | Hard cap |
|-------------------------------|----------|---------|----------|
| Easy (warm)                   | < 800ms  | < 2s    | n/a (no self-critique) |
| Easy (cold, embed model load) | < 2s     | < 4s    | n/a      |
| Hard (entailment-only)        | < 3s     | < 8.5s  | 6 Gemini calls (3 controller + 1 batched entailment + 1 critique + 1 synthesis); +1 if critique fires repair → 7 |
| Hard (with shadow quick)      | < 5s     | < 12.5s | Above + 1 shadow-quick run |

Easy path is split because IDE-open-then-ask is a real pattern. Collapsing cold and warm into one budget hides whether the embed model is loaded — and "embed model unloaded" is the difference between p50 of 200ms and p50 of 1.5s. Hitting any hard cap → fall through to fixed pipeline.

---

## 12. Cross-cutting concerns

### 12.1 Cost ledger merge

Shadow has `$0.50/day` (master plan §17). RAG agent path adds Gemini calls. They share a budget surface or the user sees two confusing numbers.

**Locked (D5):** extend `shadow/cost_ledger.py` with a `category` field (`shadow` | `rag_agent` | `rag_judge`). Single source of truth, internal categorization for analytics. Two ledgers with a summing dashboard is the answer that sounds modular and creates a bug six months in when one ledger updates and the other doesn't.

### 12.2 Cold-start collision

RAG ingest (60s+, worse with section embeddings) and shadow worktree dep-install (`pip install` / `npm install`, can be minutes) both warm on workspace open. They write to different paths (`.synthi/rag/` vs `.shadow/`) so no FS contention, but they compete for CPU/network. Verify they parallelize cleanly; consider a coordinated warmup that schedules them concurrently with bandwidth limits.

### 12.3 Continuous shadow as eval signal

The watcher caps `$0.50/day` already. Eval runs that mass-replay queries should not trigger continuous shadow. Add a `bench_mode: bool` flag in the request that skips the producer.

### 12.4 Shadow daily-cap interaction

If the RAG agent calls `verify_with_shadow` and the daily cap is hit, the agent:
- Falls back to entailment-only.
- **Surfaces a "verification unavailable" flag in the response itself**, not just logs. Refusing to answer punishes the user for a budget they didn't set; answering silently hides the degradation. The middle path is right only if the user sees it. (D7.)
- Logs the cap-miss for cost-budget tuning.

### 12.5 Privacy and real-signal capture

Real-signal queries from `preference.py` and `regression_runner` may contain proprietary code and natural-language requests. Workspace-scoped. Opt-in if we ship beyond ourselves. Redaction pass before any cross-workspace aggregation.

---

## 13. Decisions

All eight items locked 2026-04-28.

### D1. Latency budgets

Hard paths confirmed as in §11.5. Easy path split into:
- **Warm**: p50 < 800ms, p95 < 2s. Embed model loaded, query cache warm.
- **Cold**: p50 < 2s, p95 < 4s. IDE-just-opened, embed model still loading.

The cold/warm split exists because IDE-open-then-ask is a real pattern; collapsing them hides whether the embed model is preloaded.

### D2. Judge model

`gemini-3-flash-preview` for the CI loop, sampled stronger judge for calibration at 20%. Two non-negotiable refinements:
- **Pin the exact version string**, not the alias. flash-preview rolls; an unannounced model swap silently invalidates the eval baseline.
- **Calibration sample needs Cohen's κ ≥ 0.7** between flash and the stronger judge. Below threshold the cheap judge has drifted and the eval is unsound — block the CI gate until either κ recovers or rubrics are re-calibrated.

### D3. Eval seed corpus

Extend `bench/corpus`, don't fork. Two slices in one tree:
- **Code-modifying slice**: 34 existing fixtures, ground truth from `seed_patches` paths.
- **Explain/lookup slice**: 3–5 new docs added to the same corpus tree, deliberately chosen for ToC depth and cross-section references — exactly the multi-hop/explain failure modes Phase 2 is supposed to fix. `bench/corpus` as-is is optimized for code-modifying queries with seed_patches; it under-represents the explain/lookup failure modes.

The labeling schema's `query_type` distinguishes which queries hit which slice.

### D4. Section embeddings cold-start

**Eager in v1.** Lazy fallback (top-K-accessed first, background fill) only if cold-start p95 exceeds 90s on a real-corpus measurement. Lazy adds a second code path with "is this section embedded yet?" checks that we'd have to delete if measurement shows eager is fine. A few extra cold-start seconds is not the difference between acceptable and not.

### D5. Cost ledger

Single source of truth: extend `shadow/cost_ledger.py` with a `category` field (`shadow` | `rag_agent` | `rag_judge`). User-facing dashboard shows one budget; analytics slice by category.

### D6. Real-signal pipeline timing

Phase 1.5 plumbing only in Week 1. Schema mapping, dedup, ingest function. Don't block Phase 2 on real-signal volume — queries trickle in over weeks. By Phase 2 there will be some held-out validation; by Phase 4, enough to weight in the gate.

### D7. Shadow-quick cap-miss

Fall back to entailment-only with a flag that **surfaces in the response**, not just logs. Refusing to answer punishes the user for a budget they didn't set; answering silently hides the degradation. The middle path is right only if the user sees it.

### D8. Reconciliation thresholds

No fixed Hamming threshold pre-commit. Phase 0 deliverable: build the test fixture (rename / edit / merge / split), sweep thresholds 2/3/4/5/6 over 64-bit simhash, pick the point on the precision-recall curve that gives ≥ 90% correct-reconcile and < 5% false-reconcile. **If multiple thresholds satisfy both, prefer the lower** (more conservative — fewer cross-content migrations). Document the chosen threshold and sweep results in the test file itself.

### D9. Self-critique pass in v1

Ship in v1 behind `rag.self_critique` feature flag (default on), hard path only. Reverses the earlier "leave out, eval decides" position. Reasons: (1) entailment is a per-claim grounding check, self-critique is an answer-shape check — different layers, both useful; (2) the eval-trigger plan had a debugging-attribution flaw (low citation precision could be retrieval, prompts, chunking, or critique — months of disambiguation); (3) Genome's Critic universe is the architectural analogue, treating RAG agent emission as un-critiqued is inconsistent. Flag exists for ablation, not for opt-out — we want per-slice contribution data.

### D10. AST-aware chunking for code files

Phase 2 deliverable. Replace ToC-based chunking with tree-sitter function/class boundaries for code files (Python, TS/JS, Go, Rust). Section ID derivation accommodates by treating AST path as `toc_path`. Eval-gated like every other Phase 2 step.

### D11. Embedding model versioning

Phase 0 deliverable. `embedding_model_version` persisted next to `schema_version`; mismatch on startup forces full re-embed. Without it, an embedding upgrade is a silent recall regression.

### D12. Adversarial negatives in eval set

~7% of corpus. "Plausible-but-wrong-match" queries that exercise the abstention contract beyond the unanswerable slice. Generated alongside the synthetic pipeline — the same prompt produces `query` + `gold_answer` + `near_miss`.

### D13. Per-slice-only `answer_correctness` reporting

Code-modifying queries are judged by Genome's Arbiter (executable evidence); explain/lookup queries are judged pairwise by the LLM judge. Different methodologies, no apples-to-apples cross-slice aggregate. CI gate compares each slice against its own baseline. No single "answer correctness" headline number across both slices.

### D14. Genome integration contract

Cross-system contract documented in Appendix A of this plan and §5 / §16.5 of `synthi-genome-master-plan.md`. Both files own different surfaces of the same contract; changes must land on both sides together.

### D15. v1 single-axis gating + 2σ regression detection

The eval set (150 queries) doesn't support three-axis (`query_type` × `language` × corpus-size) per-slice gating without firing on noise. v1 narrows the CI gate to:

- **Per-`query_type` only** — and only on types with ≥ 15 queries. Synthesis rebalances to ensure that floor.
- **2σ-based regression detection** — a drop must exceed `2 × sqrt(p(1-p)/n)` to fire. Avoids fixed-threshold false alarms on small slices.
- **`language` and corpus-size buckets reported in trace dashboards but not gated** until Phase 1.5 real-signal accumulates them past n=15 — automatic activation, not a separate decision.

The honest framing: the alarm covers what 150 queries can support, not what the original rubric implied. Rubric promised 96 cells; v1 actually gates ≤ 8 (one per `query_type`, conditional on volume).

## 14. Sequencing & timeline

**Week 1 (Phase 0 + 1 in parallel)**
- Eval harness extension to `bench/synthi_report.py`.
- Three scorers as separate modules. Pin exact judge model version string. Cohen's κ harness for the 20% strong-judge calibration sample.
- Section ID + simhash + migration. Reconciliation test fixture with threshold sweep (D8) — chosen threshold lands in the test file.
- Extend `bench/corpus` with 3–5 explain/lookup docs (deep ToC, cross-references) per D3.
- Synthesize ~100 RAG queries against the extended corpus. Spot-check labels on 50.
- Derive 34 code-modifying queries from the shadow-corpus `seed_patches`.
- Add ~20 unanswerable queries (≥ 15% of total).
- Phase 1.5 plumbing only: ingest function + dedup + schema mapping for `preference.py` / `regression_runner`. Volume accumulates over weeks (D6).

**Week 2 (Phase 2 starts)**
- Section embeddings + RRF fusion. Eval. Go/no-go.
- Reranker blend sweep + `min_similarity` retune. Eval. Go/no-go.
- Header A/B. Eval. Go/no-go.
- AST-aware chunking for code files (D10). Eval. Go/no-go.
- Decision point: if metrics clear targets, stop here.

**Week 3+ (conditional Phase 3 + 4)**
- Tool layer design pass and review.
- Bounded agent loop, batched entailment, shadow-quick verification integration.
- Self-critique pass (D9) wired into the agent loop, behind `rag.self_critique` flag.
- Cost ledger extension with `category` field (D5).
- Latency budget enforcement per the cold/warm/hard split (D1).
- Genome integration contract (Appendix A) wired through `/shadow/run` payload + verdict-cascade UI.
- Eval-driven decisions on heavy controller per the §16 triggers.

## 15. Risks & mitigations

| Risk                                    | Mitigation |
|-----------------------------------------|------------|
| Section ID reconciliation has false-positives that migrate caches across content boundaries | Conservative simhash threshold, reconciliation_skipped on multi-match, audit log surfaced in eval traces, eval queries that specifically exercise migration |
| Synthetic eval over-represents doc-shaped queries | Weight real-signal queries higher in held-out gate as they accumulate; first 4–6 weeks tolerate the bias |
| Judge model drifts across version upgrades | Pin model version in scorer config; treat upgrades as rubric-version bumps with full re-score |
| Cold-start regresses below acceptable UX with section embeddings | Eager v1, measure on real corpora; lazy fallback only if p95 > 90s (D4); per-pod PV ensures cost is paid once, not on every restart |
| Agent loop adds variance and regresses long-tail without aggregate signal | Per-slice CI gate; flagged-query review queue when agent hits the turn ceiling |
| Shadow daily cap interaction surprises users | Single ledger with category field (D5); cap-miss surfaces "verification unavailable" flag in the response itself, not just logs (D7) |
| Judge model rolls under us and silently invalidates the eval baseline | Pin exact version string (D2); Cohen's κ ≥ 0.7 gate against sampled stronger judge — below threshold blocks the CI gate until rubrics re-calibrate |
| `verify_with_shadow` slows code queries past the budget | Tier-quick is bounded; latency budget includes it; if exceeded consistently, route fewer queries through it |

## 16. What's explicitly NOT in scope

Each item lists either a concrete revisit trigger or "architecturally precluded" if there isn't one.

- **Multi-tenant RAG.** Architecturally precluded by pod-per-workspace (memory: `project_rag_isolation`). Revisiting requires a separate architecture decision on the pod model — not a §16 footnote.
- **Cross-workspace embedding sharing.** Architecturally precluded for the same reason — no shared substrate without reintroducing the multi-tenancy questions the pod model exists to avoid.
- **Replacing shadow's verification surface.** Out of scope. If raised, the right framing is a verification facade on top of both, not replacement; spin a separate doc.
- **Free-form agentic exploration.** Trigger to revisit: after Phase 4 ships, if eval shows bounded-ReAct misses > 5% of queries free-form would catch on the `query_type=multi_hop` slice. Pulling it in would also require hard cost caps per query (already feasible via the ledger) plus trace-summarization for human review at scale.
- **Regex citation extraction.** Trigger: only if eval shows the model reliably produces good inline citations but fails to populate the structured field. Surprising, but measurable.
- **Heavy controller model.** Trigger: after Phase 4, if controller decisions are a top-3 failure category on the `query_type=multi_hop` slice — swap behind a flag, eval, decide.
- **ColBERT / late-interaction retrieval.** Architecturally compatible but operationally heavy. Trigger: after Phase 2 + Phase 4 eval, if the dominant failure mode on the `query_type=lookup` slice is "right document, wrong section because dense embeddings averaged out the discriminating token." Below that bar, hybrid (BM25 + dense + RRF) is sufficient.
- **Late chunking (Jina-style).** One config flag once we know the failure mode. Trigger: cross-section context loss is a leading explain/multi-hop failure category in eval and section-summary fusion (Phase 2.1) didn't recover it.
- **Listwise / RankGPT-style reranking.** Section reranker already supports a cross-encoder backend (`section_rerank_backend = "cross_encoder"`). Trigger: only if cross-encoder reranking saturates and pairwise scores are a top-3 failure category, which is unlikely for IDE-scale corpora.
- **Episodic agent memory across queries.** Per-turn fetch cache exists (intra-query). No cross-query memory yet. Trigger: after Phase 4, if eval shows the same user repeatedly hits similar queries with regressing satisfaction, OR if `shadow/preference.py`-style accepted-answer signal would re-rank retrieval better than current confidence-based ranking. Adding episodic memory in v1 introduces staleness/eviction/leakage axes (memories from old code state biasing new retrieval) that should be designed against eval data, not pre-emptively.

---

## Appendix A — Genome integration contract

This is the contract surface between RAG and Synthi Genome (shadow). Implementation lives in both `code_intel/rag/` and `shadow/`; the contract is here, with mirrored references in `synthi-genome-master-plan.md` §5 and §16.5. **Changes here require both sides land together** (D14).

The integration is orthogonal to per-phase work — it only matters once the agent path (Phase 4) ships. It's an appendix, not a phase, because it's a cross-system contract surface, not a build-plan step.

### A.1 RAG context in `/shadow/run`

When the chat assistant fires `POST /shadow/run` on the first FILE: block, the payload includes a `rag_context` block describing what RAG retrieved for the answer:

```json
"rag_context": {
  "section_ids": ["sec_a1b2c3...", "sec_d4e5f6..."],
  "retrieved_at": "2026-04-28T10:23:00Z",
  "rag_confidence": 0.78,
  "rag_used": true
}
```

- **`section_ids`**: stable IDs from §4.1 — *not section contents*. Genome's Generators fetch via the existing RAG API if they need text. Reasons:
  - Section contents are 5–50 KB; ×3 universes = 50–150 KB extra per shadow run, in every shadow request.
  - Ingest is async. If we passed contents and the user re-ingested between chat submission and Generator firing, the snapshot would diverge from the live index. Passing IDs lets Generators see the *current* state, with explicit stale-handling at fetch time (A.3).
- **`retrieved_at`**: when the chat retrieved. Compared against current section state at fetch time.
- **`rag_confidence`**: from §11.4. Drives the soft sufficiency gate (A.2).
- **`rag_used`**: `false` for imperative requests where the chat didn't ground in RAG ("rename function X to Y"). Lets Genome distinguish "RAG was queried and uncertain" from "RAG wasn't relevant." Without this flag, every payload ambiguates between the two.

When the chat path didn't invoke RAG at all (e.g., direct user instruction with no retrieval), `rag_context` is `null`.

### A.2 Soft sufficiency gate

RAG confidence does **not** hard-block Genome. The gate is:

| `rag_used` | `rag_confidence` | RAG abstained? | Genome behavior |
|---|---|---|---|
| `false` / `null` | n/a | n/a | Run as today; no RAG section in Arbiter card. |
| `true` | ≥ 0.6 | no | Run as today; no flag. |
| `true` | < 0.6 | no | Run; Arbiter card shows "RAG retrieval was uncertain — review citations." |
| `true` | n/a | yes | **Don't spawn universes.** Surface RAG's clarifying question (§11.4) to the user. |

The hard gate is RAG's existing abstain logic. The soft gate is the confidence flag in the Arbiter card. Hard-blocking on `confidence < 0.6` would punish imperative requests where RAG isn't grounding the answer.

### A.3 Stale-snapshot handling

Ingest is async. If RAG re-ingests between chat submission and a Generator firing, section IDs may have migrated or been deleted (§4.2). Generators fetching by ID get one of:

- **200, same fingerprint** → use as-is.
- **200, migrated** → use the new ID; record `stale_resolved` in trace.
- **410 Gone** → section deleted; Generator continues without that source. Multiverse emits `stale_context_detected` event; Arbiter card surfaces "context shifted during verification — citations may be out of date."

Genome does not retry retrieval. The chat's RAG context is the frozen baseline; if it moves, the user is told.

### A.4 Prose-vs-diff entailment

After Genome's Arbiter picks a winner, RAG's self-critique pass (§11.2) runs once more with `(prose, diff)` as input — answering "does the chat reply's prose accurately describe the winning diff?"

Triggered only when:
- Genome accepted ≥ 1 universe (no point verifying prose about a rejected diff).
- Prose has substantive causal claims (>50 words referencing the diff, OR contains "because" / "to avoid" / "fixes the case where" markers).

If the critique fails, the prose is regenerated against the actual diff before final emission. One Flash call (~$0.001, ~300 ms) on the slice that triggers it. Closes the "patch correct, explanation wrong" failure mode that neither system covers alone — users read explanations more than diffs.

### A.5 Unified verdict cascade

Genome wins on code (executable evidence). RAG wins on prose (entailment). When they disagree on a code claim, Genome wins (tests beat entailment). Verdict matrix:

| RAG state | Genome state | User sees |
|---|---|---|
| confident, used | accepted | Apply card with citations + verification evidence. |
| confident, used | all rejected | "Verification failed" + best-universe details + counterexample. |
| confident, used | timeout (`quick` tier, ~4 s) | Apply with caveat banner: "verification didn't finish — runs available shortly." User is actively waiting; blocking is worse than optimistic apply on small changes. |
| confident, used | timeout (`standard` tier, ~12 s) | **Hold; queue for completion.** Don't auto-apply. Card shows "verifying… we'll notify when done." |
| confident, used | timeout (`deep` tier, ~30 s) | **Hold; queue for completion.** Refactor stakes are too high for optimistic apply on a 30-second job. Card shows "verifying… (deep tier — large changes take longer)." |
| low-conf, used | accepted | Apply card with "RAG retrieval was uncertain — review citations" banner. |
| low-conf, used | all rejected | "Couldn't verify against retrieval *or* runtime — please clarify." |
| not used (`rag_used: false`) | accepted | Apply card, no RAG section. |
| not used | all rejected | "Verification failed" + best-universe details. |
| RAG abstained | (Genome not run, per A.2) | Clarifying question, no patch offered. |
| any | `stale_context_detected` | Add banner: "context shifted during verification — citations may be out of date." Stacks with above rows. |

The `quick` row is the only case where Genome timeout → optimistic apply. Caveat-banner severity scales with tier. The reasoning is asymmetric: small changes the user is actively waiting on tolerate optimistic apply with an explicit retry path; large refactors don't, because the cost of an unverified apply is much higher than the cost of waiting.

### A.6 Owner & change control

- RAG side of contract: this Appendix.
- Genome side of contract: `synthi-genome-master-plan.md` §5 (payload + SSE events) and §16.5 (verdict cascade UI).
- Contract changes require both sides land together (D14). A change to the payload schema in either file without the corresponding edit in the other is a contract bug.
