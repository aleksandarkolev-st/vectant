# Synthi Integration Report — RAG + Shadow

Generated: 2026-04-28 10:26:28 UTC
Workspace: `C:\Users\dev\AppData\Local\Temp\synthi_report_ws_cxoqdf2o`
Platform:  Windows 11 / Python 3.13.13

## API Key Status

| Key | Status | Notes |
|-----|--------|-------|
| GEMINI_API_KEY | **set** | Required — RAG embeddings + LLM + Shadow generation/critic/arbiter |
| ANTHROPIC_API_KEY | not set | Optional — Shadow cross-universe (Anthropic provider) |
| OPENAI_API_KEY | not set | Optional — Shadow cross-universe (OpenAI provider) |

### How many keys does Shadow need?

**Minimum: 1** (`GEMINI_API_KEY`). All three tiers (quick/standard/deep) work with
Gemini alone; generation, criticism, and arbitration all run on Gemini.

**Maximum: 3.** Adding `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` enables
cross-provider universes — e.g. Gemini generates, Anthropic criticises,
OpenAI arbitrates — giving diversity of opinion on the patch. Per the rate
card, Anthropic and OpenAI are ~4–5x more expensive per call than Gemini.

## Test Summary

**22 passed / 0 failed / 0 skipped** (total 22)

| Test | Status | Time (ms) | Detail |
|------|--------|----------:|--------|
| `rag:init` | PASS | 65762 |  |
| `rag:ingest_stats` | PASS | 0 |  |
| `rag:stats` | PASS | 0 |  |
| `rag:dedup` | PASS | 7966 |  |
| `rag:remove_file` | PASS | 19142 |  |
| `rag:fusion_rrf` | PASS | 9769 |  |
| `rag:fusion_weighted` | PASS | 13526 |  |
| `rag:retrieve_context` | PASS | 11611 |  |
| `rag:query_full` | PASS | 34606 |  |
| `rag:query_cache` | PASS | 17933 |  |
| `rag:cache_invalidation` | PASS | 50813 |  |
| `rag:incremental` | PASS | 12 |  |
| `rag:section_reranker` | PASS | 23414 |  |
| `rag:async_ingest` | PASS | 105 |  |
| `rag:query_stream` | PASS | 5121 |  |
| `rag:query_trace` | PASS | 19553 |  |
| `rag:clear` | PASS | 36797 |  |
| `shadow:config` | PASS | 61 |  |
| `shadow:cost_table` | PASS | 0 |  |
| `shadow:project_signals` | PASS | 10 |  |
| `shadow:events_import` | PASS | 0 |  |
| `shadow:cost_ledger` | PASS | 5 |  |

## RAG Subsystem

### Pipeline Architecture

```
Step 1  Dual-Ingestion  (offline, no LLM synthesis)  -> DocumentStore + ToC + SummaryIndex
          DocumentLoader -> ToCExtractor -> SectionSplitter -> SummaryGenerator
          Embedder (GEMINI_API_KEY) -> SummaryIndex (numpy vector store)

Step 2  Macro-Retrieval (fast, <500ms)               -> top 3-5 docs
          QueryAnalyzer (multi-query fan-out)
          SummarySearcher (cosine similarity on embeddings)
          KeywordFilter (BM25)
          DocumentRanker (RRF fusion of vector + keyword + recency ranks)

Step 3  Micro-Navigation (agentic LLM, ~200ms)       -> precise sections
          TreeNavigator (routing LLM traverses ToC tree)
          SectionExtractor
          RelevanceScorer

Step 4  Heavy Synthesis (LLM, 1-3s)                  -> cited answer
          ContextBuilder -> AnswerSynthesizer -> CitationTracker -> ConfidenceScorer
```

**retrieve_context()** runs Steps 2+3 only — used by the chat pipeline.
**query()** runs all four steps and returns a self-contained cited answer.

### Configuration

| Parameter | Value |
|-----------|-------|
| Fusion method | `rrf` |
| RRF damping k | `60` |
| Routing model (Step 3) | `gemini-3-flash-preview` |
| Synthesis model (Step 4) | `gemini-3-flash-preview` |
| Embedding model | `gemini-embedding-001` |
| Embedding dimension | `3072` |
| Store directory | `.synthi/rag` |

### Ingestion Result (Step 1)

| Metric | Value |
|--------|-------|
| Processed | 5 |
| Skipped | 0 |
| Failed | 0 |
| Purged (stale) | 0 |
| Total sections | 16 |
| Time (ms) | 63024 |

### Store State After Ingestion

| Metric | Count |
|--------|-------|
| Documents | 5 |
| Summaries indexed | 5 |
| Sections | 16 |
| ToC trees | 5 |
| Keyword docs | 5 |
| Unique BM25 terms | 133 |

### retrieve_context() — Steps 2+3

Query: _"How does authentication work?"_

| Metric | Value |
|--------|-------|
| Documents searched | 5 |
| Documents selected | 1 |
| Sections assembled | 5 |
| Tokens in context | 394 |
| Sufficiency | `SUFFICIENT` |
| Macro time (ms) | 11591.8 |
| Micro time (ms) | 18.9 |
| Total time (ms) | 11610.7 |

### Fusion Method Comparison

Same query (`authentication session token login`) run with each fusion method.

| Method | Docs selected | Sections | Tokens | Macro (ms) | Micro (ms) | Sufficiency |
|--------|---------------|----------|--------|------------|------------|-------------|
| `rrf` | 1 | 5 | 394 | 9698 | 36 | `SUFFICIENT` |
| `weighted` | 1 | 5 | 394 | 13437 | 76 | `SUFFICIENT` |

**RRF (Reciprocal Rank Fusion)** is the default (Cormack 2009).
It fuses vector + BM25 + recency by rank position rather than raw scores,
making it robust to scale differences between cosine similarity and BM25.
Weighted fusion uses a 0.6/0.3/0.1 vector/keyword/recency sum.

### query() — Full Pipeline (Steps 2+3+4, with synthesis LLM)

Query: _"What is the RAG pipeline and how does micro-navigation work?"_

| Metric | Value |
|--------|-------|
| Confidence | 0.751 |
| Citations | 2 |
| Documents searched | 5 |
| Documents selected | 1 |
| Macro time (ms) | 28737 |
| Micro time (ms) | 2388 |
| Synthesis time (ms) | 3478 |
| Total time (ms) | 34606 |

**Answer snippet:**

> The Retrieval-Augmented Generation (RAG) pipeline is a subsystem within the Synthi IDE's AI Engine (Python/FastAPI) designed to answer codebase questions [1], [2]. 

The pipeline consists of four primary stages:
1.  **Ingestion**: Includes document loading, Table of Contents (ToC) extraction, section splitting, and embedding [1].
2.  **Macro-retrieval**: Utilizes vector search (cosine similarity)


### Query Result Cache (Pipeline-level)

Identical query within TTL skips macro+micro+synthesis entirely.

| Metric | Value |
|--------|-------|
| Cold call (ms) | 17931.8 |
| Warm call (ms) | 0.9 |
| Speed-up | 20425.8× |
| Hits | 1 |
| Misses | 1 |

### Cache Invalidation on Ingest

Cache size after first query: 1 → after `ingest_file()`: 0 (expect 0).

### Clear + Re-ingest

Docs before clear: 5 — after clear: 0 — after re-ingest: 5

## Shadow Subsystem

### Architecture

```
POST /shadow/run          -> multiverse.run_job -> N universes in parallel
  Each Universe:          -> generator -> critic -> critic_critic -> (revise?)
  convergence check       -> early exit if all universes agree
  arbiter                 -> adjudicate winner across universe evidence bundles

POST /shadow/{id}/apply   -> apply winning patch, cancel siblings, refund cost
GET  /shadow/{id}/stream  -> SSE job progress events (real-time)
POST /shadow/{id}/why     -> re-adjudicate with user follow-up question
POST /shadow/verify-only  -> verify existing patches without generation
GET  /shadow/cost/state   -> daily spend vs cap dashboard
POST /shadow/cost/cap     -> set daily spend cap
```

shadow_continuous (Wave 4) adds:
```
POST /shadow_continuous/notify            -> file-save hook (from collab-server)
GET  /shadow_continuous/{path}/state      -> continuous shadow state
POST /shadow_continuous/opt_out           -> opt-out workspace
```

### Tier Configuration

| Tier | Universes | Wall-clock cap (s) | Cost ceiling ($) |
|------|-----------|--------------------|-----------------|
| `quick` | 1 | 8 | $0.0010 |
| `standard` | 3 | 25 | $0.0120 |
| `deep` | 3 | 45 | $0.0400 |

### Rate Cards ($ per call, Apr 2026 estimates)

| Provider | gen | critic | arbiter | critic_critic | revise |
|----------|-----|--------|---------|---------------|--------|
| anthropic | $0.0180 | $0.0120 | $0.0200 | $0.0008 | $0.0120 |
| openai | $0.0150 | $0.0100 | $0.0180 | $0.0006 | $0.0100 |
| gemini | $0.0035 | $0.0025 | $0.0040 | $0.0002 | $0.0025 |

### Cost Estimates by Tier x Provider

| Tier | Provider | Universes | Timeout (s) | Ceiling ($) | Estimated ($) |
|------|----------|-----------|-------------|-------------|---------------|
| `quick` | gemini | 1 | 8 | $0.0010 | $0.0010 |
| `quick` | anthropic | 1 | 8 | $0.0010 | $0.0010 |
| `quick` | openai | 1 | 8 | $0.0010 | $0.0010 |
| `standard` | gemini | 3 | 25 | $0.0120 | $0.0120 |
| `standard` | anthropic | 3 | 25 | $0.0120 | $0.0120 |
| `standard` | openai | 3 | 25 | $0.0120 | $0.0120 |
| `deep` | gemini | 3 | 45 | $0.0400 | $0.0400 |
| `deep` | anthropic | 3 | 45 | $0.0400 | $0.0400 |
| `deep` | openai | 3 | 45 | $0.0400 | $0.0400 |

> The estimated cost is `min(rate-card sum, tier ceiling)` (master plan §10).
> The ceiling always wins so the user-visible number never exceeds the
> contracted budget envelope. Cost is debited up-front and refunded on
> apply-and-cancel or early convergence.

### Project Signals (temp workspace)

Project signals are detected once per job at the worktree-acquire step.
They calibrate the Critic-Critic: e.g. `web-app` with no CI gets a
different actionability threshold than `service` with lockfile + CI.

| Signal | Value |
|--------|-------|
| Project type | `web-app` |
| Languages | `python` |
| Test framework | `none` |
| Has CI | `False` |
| Has lockfile | `False` |
| Package manager | `npm` |
| Style hints | `uses-async, type-annotated` |

### Cost Ledger State (fresh workspace)

| Field | Value |
|-------|-------|
| `daily_cap_usd` | `5.0` |
| `spent_today_usd` | `0.0` |
| `remaining_usd` | `5.0` |
| `today_jobs` | `[]` |
| `history` | `[]` |

## How to Test RAG Only

### Unit/offline tests (no GEMINI_API_KEY required)

```bash
cd ai-backend/ai-engine
python -m pytest code_intel/rag/tests/ -v
```

26 test files covering every module: document_store, toc_store, summary_index,
section_store, keyword_filter, document_ranker, query_analyzer, toc_extractor,
section_splitter, summary_searcher, context_builder, citation_tracker,
confidence_scorer, answer_synthesizer, tree_navigator, relevance_scorer,
types, config, pipeline, content_hasher, page_resolver, and more.

### Run a specific sub-test

```bash
python -m pytest code_intel/rag/tests/test_pipeline.py -v
python -m pytest code_intel/rag/tests/test_document_ranker.py -v  # fusion tests
python -m pytest code_intel/rag/tests/test_summary_searcher.py -v # vector tests
```

### This integration report

```bash
cd ai-backend/ai-engine
python -m bench.synthi_report                   # auto temp workspace
python -m bench.synthi_report --no-cleanup      # keep workspace for inspection
python -m bench.synthi_report --workspace /tmp/myws  # reuse an existing workspace
```

With GEMINI_API_KEY set: ingestion uses real embeddings, Steps 3+4 use LLM.
Without GEMINI_API_KEY: ingestion uses zero-vector fallback, Steps 2+3 fall
back to BM25-only ranking + top-N sections (no routing LLM). Step 4 is skipped.

## How to Test Shadow Only

### Offline (no API key, no server)

```bash
cd ai-backend/ai-engine
python -m bench.synthi_report  # shadow:config, shadow:cost_table, etc.

# Cost estimation:
python -c "from shadow.multiverse import estimate_cost_for_request; print(estimate_cost_for_request('quick'), estimate_cost_for_request('standard'), estimate_cost_for_request('deep'))"
```

### Bench harness (GEMINI_API_KEY + git workspace required)

```bash
cd ai-backend/ai-engine
python -m bench.harness --corpus bench/corpus --out bench/report.md
# Grid search over scoring weights:
python -m bench.tune_weights
```

### Shadow via HTTP (ai-engine must be running)

```bash
# Start ai-engine
uvicorn main:app --port 8000

# Check cost state
curl "http://localhost:8000/shadow/cost/state?workspace_path=/tmp/ws"

# Verify-only (no generation, just structural verification)
curl -X POST http://localhost:8000/shadow/verify-only \
  -H "Content-Type: application/json" \
  -d '{"workspace_path":"/tmp/ws","patches":[{"path":"src/buggy.py","new_content":"def divide(a,b):\n    if b==0: raise ZeroDivisionError()\n    return a/b"}],"tier":"quick"}'

# Full run (streams SSE events)
curl -X POST http://localhost:8000/shadow/run \
  -H "Content-Type: application/json" \
  -d '{"workspace_path":"/tmp/ws","intent":"fix","user_request":"fix the divide function","patches":[{"path":"src/buggy.py","new_content":"def divide(a,b):\n    if b==0: raise ZeroDivisionError()\n    return a/b"}],"tier":"quick"}'
```
