# Inline Completions: Foundation + Next-Edit Prediction Plan

## 0. Status

**Foundation (shipped, commit `aee2cc1` on `claude/fix-inline-completions-KDpDc`):**

- Hybrid retrieval wired into `_fast_retrieve` via inline embed with hard `embed_timeout_ms` (default 120 ms) using `asyncio.wait_for` over `asyncio.to_thread(embedder.embed_query)`. Cache hit path unchanged; timeout/exception falls open to BM25 + symbol only.
- RRF (k=60) + MMR (λ=0.7, head=32) replaces the old weighted-sum merge in `retriever._merge_results`. MMR uses cosine over chunk embeddings when both sides have them, Jaccard fallback over `{symbol_name + first 200 chars of body}`.
- Context budget bumped: `MAX_REFS_CHARS` 1.4 KB → 5 KB, `max_chunks` 5 → 8, `max_chars_per_chunk` 320 → 480.
- Recent edits captured as diff hunks with `@@ {path} L{a}-{b} @@` headers, `+` prefix for inserts, for ±3 lines of surrounding context. Per-entry budget 480 chars; oversize lines head-truncated with `…` (never dropped, header always preserved).
- Prompt rule rewritten: distinguishes "related symbols (do not copy literally)" from "recent-edit hunks (signal user intent, may suggest matching patterns)".

**Pending:** Next-Edit Prediction (Tab Tab Tab) — design locked, ready to build.

---

## 1. Wire Format (locked)

Aider-style search-replace blocks. Self-validating, in-distribution for trained code models, eliminates the line-number reliability problem rather than working around it.

```
{relative_path}
<<<<<<< SEARCH
{1–5 lines of existing code; must be unique in the file}
=======
{replacement text}
>>>>>>> REPLACE

{relative_path}
<<<<<<< SEARCH ALL
{token, line, or region to apply at every occurrence}
=======
{replacement}
>>>>>>> REPLACE
```

**Rationale for locking `SEARCH ALL` into the protocol on day one even though Phase 1 won't execute it:** shape-inferring intent ("if I see two adjacent identical SEARCH blocks, treat as fan-out") would contaminate telemetry forever. The keyword distinction is cheap to introduce now and impossible to retrofit later.

Stream parser splits on `>>>>>>> REPLACE` boundaries; partial blocks held until boundary lands; one model call covers a whole refactor chain.

---

## 2. Validator (locked, with refinements)

Run client-side immediately on each parsed block before any UI shows.

```
matches := exact substring count of SEARCH text in the named file
           (including whitespace, no trim, no whitespace-collapse, no normalization)

SEARCH:     N=0 → reject(no_match)
            N=1 → accept
            N>1 → reject(ambiguous)

SEARCH ALL: N=0 → reject(no_match)
            N≥1 → reject(phase2_required)   # Phase 1: log only
                  in Phase 2 → accept with confirmation UI
```

**Critical:** do NOT normalize whitespace in the matcher. Trim-and-compare or whitespace-collapsing matchers are tempting because they "fix" model laziness around indentation, but they break the uniqueness guarantee — two visually-distinct lines can collapse to the same normalized form, and now N=1 acceptance applies a diff to the wrong place. If the model emits indentation-wrong SEARCH blocks at high rates, that's a prompt failure that should surface in telemetry as `no_match`, which is the correct gradient for prompt iteration. Don't paper over it in the matcher.

No anchor-walk recovery, no fuzzy match, no LCS fallback. Reject and move on. The model gets another chance on the next keystroke trigger.

---

## 3. State Machine

```
idle ──user types──▶ pending ──first valid block──▶ armed
                        │                              │
                        │                              ├─Tab──▶ armed-current (cursor jumped, ghost shown)
                        │                              │            │
                        │                              │            ├─Tab──▶ apply edit ──▶ armed (next block) | idle
                        │                              │            └─any other key──▶ idle (cancel)
                        │                              └─any other key──▶ idle (cancel)
                        └─stream ends with no valid block──▶ idle
```

**Cancellation rule:** any non-Tab keystroke (or selection change, or model-content change from another source) drops the queue and returns to `idle`. Cheap; users learn the rhythm; avoids stale predictions piling up.

---

## 4. Recent-Edit Ring Buffer for NEP

Separate from the primary completion's 4-entry / 60s buffer. NEP needs a richer trajectory because refactor detection is the headliner signal.

- Size-bounded FIFO, ~8 KB total. Eviction happens when a new entry would push the buffer over budget — pop oldest until it fits.
- Bounded by **bytes, not by entry count**: 12 large diffs ≠ 12 one-liners; we want the model to see the trajectory, not 12 token-bombs.
- Each entry is a diff hunk in the same format as the primary buffer (`@@ path L{a}-{b} @@` + `+` / lines).
- Rendered as the prompt headliner under a `<recent_edits>` block, above retrieved context. Refactor intent is far more informative than symbol references for predicting the next edit.

---

## 5. Phase 1 — Stream + Validate + UI (~3 days)

**Goal:** end-to-end NEP behind a feature flag, executing only single SEARCH blocks. Get the loop working; defer fan-out and impact propagation.

### Backend / API

- New `/api/next-edit` Next.js route. Same upstream as `/api/completion` (Gemini Flash via the SDK), different prompt template.
- Streaming response (`ReadableStream`); server passes through model bytes.
- Prompt template:
  - `<recent_edits>` headliner (8 KB ring buffer)
  - Compact context block (smaller than the completion path's 5 KB — NEP cares about trajectory more than reference)
  - Explicit format spec including both `SEARCH` and `SEARCH ALL` keywords with examples.
  - Reminder: SEARCH text must be unique in the file; emit 1–5 lines.

### Client

- Stream parser splitting on `>>>>>>> REPLACE`; emits validated blocks as they land.
- Hard validator (Section 2). Logs every rejection with reason code (`no_match`, `ambiguous`, `phase2_required`, `parse_error`).
- Jump-hint widget: gutter dot at the predicted edit's line + small ghost overlay when first Tab is pressed.
- Tab handler upgrade: cascade through queue; cancel on any other key.
- NEP recent-edit ring buffer (8 KB FIFO). Subscribed to the same `onDidChangeModelContent` event the primary buffer uses; renders identical diff hunks.
- Feature flag: `NEXT_EDIT_PREDICTION` (default off).
- Phase 1 parses both `SEARCH` and `SEARCH ALL`; executes only `SEARCH`; logs `SEARCH ALL` with `phase2_required` reason code.

**Out of scope for Phase 1:** edit-impact graph, edit-kind classifier, fan-out execution, replay harness, kill switch.

---

## 6. Phase 2 — Cross-File Impact + SEARCH ALL (~2 days)

**Goal:** predictions can chase a refactor across files, and `SEARCH ALL` actually runs.

- New `/code-intel/edit-impact` endpoint. Input: an applied edit (file + SEARCH text + REPLACE text). Output: ranked list of likely follow-up edit sites — graph BFS depth 2 over symbol-dependency edges (caller → callee, importer → imported, sibling members).
- Edit-kind classifier client-side, run on the applied edit (not the prediction): `rename | signature_change | import_change | type_change | local_logic`. Lightweight regex + AST diff over the SEARCH→REPLACE pair. Drives different impact-graph queries.
- `SEARCH ALL` execution: when validator returns N occurrences, show a confirmation UI ("apply to N sites? preview each") rather than auto-applying. First miss bails the whole batch and logs.
- The NEP request now includes the impact-endpoint candidates as part of the prompt context, so the model can pre-stage cross-file blocks.

---

## 7. Phase 3 — Telemetry, Kill Switch, Replay Harness, GA (~1.5 days)

### Telemetry (per session, aggregated to dashboard)

- `predictions_emitted` — model produced a parseable block.
- `predictions_validated` — passed Section 2 validator.
- `predictions_accepted` — user pressed Tab and applied.
- Derived: `accept_rate = accepted / validated`, `validation_rejection_rate = (emitted - validated) / emitted`.
- Per-rejection-reason breakdown.

### Kill Switch

- **Trigger:** `accept_rate < 25%` OR `validation_rejection_rate > 40%`, computed over a rolling 7-day window with N≥200 emissions.
- **Action:** feature flag flips off automatically; alert posted; manual re-enable required.
- **Rationale for the OR:** accept-rate alone misses the hallucination failure mode (model emits beautiful-looking blocks that never match the file). Rejection-rate catches that; accept-rate catches "validates fine but suggests wrong edits".

### Offline Replay Harness

- Record tuple per session: `(recent_edits_buffer, applied_edit, predictions_emitted, predictions_validated, predictions_accepted, ground_truth_next_edit)` where `ground_truth_next_edit` is the user's actual next manually-typed edit within K seconds / K keystrokes after `applied_edit`.
- Score function per prediction:

  ```
  score = α · region_iou(predicted_search_region, ground_truth_search_region)
        + β · text_similarity(predicted_replace, ground_truth_replace)
  ```

  Defaults: α=0.5, β=0.5; tuneable.

- **AST-window IoU, not character-span IoU.** Char-span IoU on the raw file scores "predicted edit at line 40, actual edit at line 42" as zero overlap even when both are semantically the same change applied to adjacent occurrences of the same construct — exactly the case a human would call "basically right".
  - **Definition:** IoU is computed over the smallest enclosing AST node of each edit (function, statement, expression — whichever the edit fits inside). Union and intersection are over node identity, not character ranges.
  - **Fallback** when AST parse fails or differs: ±N-line window (default N=3) around each edit; IoU over those line ranges.
  - This puts prompt-iteration gradient on edit-correctness rather than line-precision, which is the right thing to optimize.
- `text_similarity` is normalized edit distance over the REPLACE text, tokenized to be insensitive to whitespace/quotes-style noise.
- Harness reads a JSONL log of recorded tuples, replays them through a candidate prompt template offline, produces aggregate scores. Run before any prompt change ships.

### GA

- Enable for internal users at flag-default-on once `accept_rate ≥ 35%` and `rejection_rate ≤ 25%` for 7 days.
- Gradual external rollout via existing flag plumbing.

---

## 8. Risks + Mitigations

| Risk | Mitigation |
|---|---|
| Model emits junk that "looks valid" but applies wrong edits | Hard validator rejects ambiguous; `accept_rate` kill switch catches the residue. |
| Latency stacks (NEP request blocks completion request) | NEP runs on its own request lifecycle, debounced, separate stream; never blocks the inline-completion path. |
| Recent-edit buffer leaks across files / projects | Buffer keyed by workspace ID + reset on workspace switch. Same lifecycle as primary buffer. |
| `SEARCH ALL` ships before Phase 2 and fires accidentally | Phase 1 validator hard-rejects with `phase2_required`. Wire format reserves the keyword; execution path absent. |
| Prompt iteration churns on chasing line-precision | AST-window IoU in replay harness; reviewers required to look at scored examples, not just aggregate score, before merging prompt changes. |
| Whitespace-mismatch SEARCH blocks tank `accept_rate` | Surfaced as `no_match` in telemetry → fix the prompt, not the matcher. |
| User finds Tab cascade jarring | Cancel-on-any-key keeps it cheap to escape; first rollout is opt-in via flag; collect qualitative feedback before flipping default. |

---

## 9. Open Questions (deferred, not blocking Phase 1)

1. Should the NEP recent-edit buffer share the workspace-switch reset hook with the primary buffer or have its own? (Probably share.)
2. What's the right K for "ground truth next edit" window in the replay harness — keystrokes vs seconds, and what value? Likely tune empirically once we have logs.
3. Edit-kind classifier: pure regex/AST-diff vs a small classifier model? Phase 2 starts heuristic; revisit if accuracy is poor.
4. Confirmation UI for `SEARCH ALL`: inline diff-per-site vs single batch preview? Decide when Phase 2 lands.

---

## 10. Technical Grade

**Overall: A− (strong senior-engineer plan with a handful of underspecified spots that will surface in code review)**

### What's working

- **Locking `SEARCH ALL` into the protocol on day one** to avoid telemetry contamination from shape-inferring fan-out is a sophisticated call. Most plans ship the simple thing and pay the migration tax later.
- **Refusing to normalize whitespace in the matcher**, with the justification that prompt failures should surface as a learning gradient rather than be papered over, is exactly the right epistemics. Most teams reach for fuzzy matching here and regret it.
- **AST-window IoU over char-span IoU** for replay scoring. Correct framing — you're optimizing prompt iteration toward edit-correctness, not line-precision, and the cheap metric pulls the team in the wrong direction.
- **OR-condition kill switch** (`accept_rate` AND `rejection_rate`) catches two distinct failure modes (hallucination vs plausible-but-wrong). Either alone would miss half the regressions.
- **Bytes, not entry count**, for the recent-edit ring buffer. Right call; entry-count bounds let token bombs starve the trajectory signal.
- **Aider-style wire format** is battle-tested and avoids the line-number reliability rabbit hole.

### What's underspecified or weak

- **NEP trigger debounce strategy is missing.** The risks table mentions "debounced" but never says when NEP actually fires — every keystroke? After idle? After applied edit only? This is both a UX decision and a cost decision (every fire = an LLM call). Specify before Phase 1.
- **Cost ceiling / rate limit per session is absent.** NEP fires on edit activity; a heavy refactor session could blow API budget. Add a per-session token or QPS cap with graceful degradation.
- **`predictions_emitted` definition is ambiguous on streaming output.** Counted at first parseable boundary, or at end-of-stream? This is the denominator of `validation_rejection_rate`, so it matters for the kill switch.
- **N≥200 emissions over 7 days for the kill switch** may not be reachable during internal-only Phase 1. Need a separate gating rule for early phases (e.g., manual review after first 50 emissions).
- **In-flight stream cancellation** isn't covered by the state machine. What happens if the user types while NEP is still streaming? "Any non-Tab key cancels" handles `armed`/`armed-current` but the `pending` state needs an explicit abort-the-fetch step.
- **Concurrent-edit conflict** (LSP refactor, format-on-save, linter fix landing between validate and apply) needs a re-validation step right before apply, not just at parse time. File could change in the milliseconds between validation and Tab.
- **Prompt guidance for the model on choosing unique anchors** is missing. The validator enforces uniqueness but the prompt only says "1–5 lines, must be unique in the file" — model has no strategy. Expect frequent `no_match` on small or repetitive files until the prompt teaches anchor-selection heuristics (e.g., "prefer lines containing identifiers; avoid pure-punctuation lines").
- **Edit-impact graph edges are hand-waved.** "Sibling members" is vague; importer→imported is file-granular, not symbol-granular. This needs a real spec before Phase 2 codes against it.
- **Replay harness ground truth assumes the user's actual next edit is correct.** It's a decent proxy, not truth — users often type, undo, retype. Worth flagging and considering a "stable for K seconds after typed" filter on the label.
- **No A/B infrastructure beyond the feature flag.** How are competing prompt versions compared in production, not just offline? Replay harness covers offline; production comparison is unspecified.

### Why not A

The plan reasons well about tradeoffs (the meta-skill), but the gaps above are the kind that turn into Phase 1 hotfixes. The trigger-cadence and rate-limit gaps especially: those are not Phase 2 deferrals, those are launch-blockers that read as forgotten rather than deferred.

### Why not B

The decisions that *are* made are unusually well-justified, and the plan refuses several tempting-but-wrong options (fuzzy matching, char-span IoU, accept-rate-only kill switch) that less-disciplined plans take. That's worth more than completeness.

---

## 11. Answers to Open Questions

### Q1: Share workspace-switch reset hook between buffers, or separate?

**Share.** The trigger condition (workspace switch) and the action (drop buffered edit context) are identical — splitting them creates two places to forget to update when the workspace lifecycle changes. Subscribe both buffers to a single workspace-lifecycle event emitter. The doc's parenthetical instinct is right; bake it in.

The only reason to split would be if NEP wanted to carry edit history across workspace switches (e.g., for cross-repo refactors). That's not on the roadmap and would create a cross-workspace data-leak surface anyway. Share.

### Q2: K for "ground truth next edit" — keystrokes or seconds, what value?

**Both, with conjunction logic and a region exclusion.**

```
ground_truth = first edit such that:
    edit.timestamp_offset_from_applied < min(K_keystrokes, K_seconds)
    AND edit.region NOT overlapping applied_edit.search_region
```

- `K_keystrokes` primary cap (handles fast typists who'd flood a time window).
- `K_seconds` fallback (handles thinking pauses where keystroke counters under-fire).
- **Region exclusion is the important part:** without it, a user fixing up a wrong predicted edit gets labeled as "ground truth," which contaminates the score and tells the prompt that bad predictions were good.
- **Starting values:** `K_keystrokes = 50`, `K_seconds = 30`. Start tighter rather than looser — wide windows let unrelated edits leak into the label, and removing noise after the fact is harder than letting it in.
- Tune empirically once a few hundred labeled tuples have accumulated.

### Q3: Edit-kind classifier — heuristic or small model?

**Heuristic, but build the eval set first.** Don't decide the implementation question until the labeling question is answered.

Concrete sequence:
1. Sample 200 real applied edits from logs (after Phase 1 has run for ~a week).
2. Hand-label them with the five kinds.
3. Measure inter-annotator agreement on a subset. If two reviewers agree <80%, **the taxonomy is wrong** — fix the categories before any classifier is built. ML cannot rescue a poorly-defined problem.
4. Run the regex+AST-diff heuristic against the labeled set.
   - Heuristic ≥85% accuracy → ship it. The marginal accuracy from a small model isn't worth the latency, serving complexity, and version-drift risk for a Phase 2 feature.
   - 70–85% → look at the confusion matrix. Usually one or two cells hold most of the errors and a targeted heuristic patch closes the gap.
   - <70% → stop; the categories are the problem, not the classifier.

Default to never reaching for a model here. Edit-kind is a five-way classification on a structured input (a diff). Heuristics on structured inputs almost always beat small models on this kind of task; small models start winning at unstructured-text scale.

### Q4: SEARCH ALL confirmation UI — inline diff-per-site or batch preview?

**Inline diff-per-site, with an "apply all" affordance for the happy path.**

The failure mode of `SEARCH ALL` is "applies the right change in 9 sites and the wrong change in the 10th" — typically because some site had context the user wouldn't want changed (a string literal that happens to match a function name; a comment containing the renamed identifier; a test fixture asserting on the old name).

A single batch preview optimizes for the happy path of "yes apply all," which is precisely the path that doesn't need a confirmation UI in the first place. The whole point of confirmation is **catching the bad site**, and that requires per-site visibility.

Cost: more clicks. Mitigations:
- Keyboard shortcut (e.g., Tab-accept, Shift-Tab-skip-this-site, Esc-cancel-batch) reduces a 10-site batch to ~10 keystrokes.
- "Apply all remaining" affordance after the user has approved 2–3 sites that look identical — they've now demonstrated they understand the pattern.
- Bail-on-first-skip is wrong; users will want to skip one site and continue. Track skipped sites separately.

Final decision can wait until Phase 2 prototyping — both designs should be sketched in actual UI before committing — but the principle (per-site visibility wins over batch convenience because confirmation exists for the bad case) should not.
