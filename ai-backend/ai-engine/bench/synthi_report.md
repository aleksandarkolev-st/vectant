# Synthi Integration Report — RAG + Shadow

Generated: 2026-04-28 07:11:31 UTC
Workspace:  `C:\Users\dev\AppData\Local\Temp\synthi_report_ws_yvslw1t9`
Platform:   Windows 11 / Python 3.13.13

## API Key Status

| Key | Status | Notes |
|-----|--------|-------|
| GEMINI_API_KEY | ✅ set | Required for RAG embeddings + LLM + Shadow generation |
| ANTHROPIC_API_KEY | ⚪ not set | Optional — Shadow cross-universe (Anthropic provider) |
| OPENAI_API_KEY | ⚪ not set | Optional — Shadow cross-universe (OpenAI provider) |

> **Shadow minimum:** 1 key (GEMINI_API_KEY).  
> **Shadow maximum:** 3 keys (adds Anthropic + OpenAI cross-validation universes).  
> **RAG:** 1 key (GEMINI_API_KEY) for all LLM steps.

## Test Summary

**13 passed / 3 failed / 0 skipped** (total 16)

| Test | Status | Time (ms) | Detail |
|------|--------|----------:|--------|
| `rag:init` | ✅ PASS | 1261 |  |
| `rag:ingest_file` | ✅ PASS | 5111 |  |
| `rag:ingest_directory` | ✅ PASS | 134236 |  |
| `rag:stats` | ✅ PASS | 244477 |  |
| `rag:dedup` | ❌ FAIL | 26515 | Duplicate ingest created 27 docs, expected 1 |
| `rag:remove_file` | ❌ FAIL | 11638 | Traceback (most recent call last):
  File "C:\Users\dev\Downloads\synthi-test\sy |
| `rag:clear` | ✅ PASS | 359596 |  |
| `rag:fusion_rrf` | ✅ PASS | 73101 |  |
| `rag:fusion_weighted` | ✅ PASS | 267405 |  |
| `rag:retrieve_context` | ✅ PASS | 456094 |  |
| `rag:query_full` | ✅ PASS | 404458 |  |
| `shadow:config` | ✅ PASS | 128 |  |
| `shadow:cost_table` | ✅ PASS | 0 |  |
| `shadow:project_signals` | ✅ PASS | 12 |  |
| `shadow:events_import` | ❌ FAIL | 0 | JobState.__init__() missing 1 required positional argument: 'user_id' |
| `shadow:cost_ledger` | ✅ PASS | 5 |  |

## RAG Subsystem

### Pipeline Architecture

```
Step 1  Dual-Ingestion  (offline, no LLM)  → DocumentStore + ToC + SummaryIndex
Step 2  Macro-Retrieval (≤500ms)            → RRF fusion of vector + BM25 ranks
Step 3  Micro-Navigation (agentic, LLM)     → TreeNavigator selects sections
Step 4  Heavy Synthesis  (LLM, 1–3s)        → AnswerSynthesizer + CitationTracker
```

retrieve_context() runs Steps 2+3 only — used by the chat pipeline for RAG context.
query() runs all four steps and returns a self-contained cited answer.

### Configuration

| Parameter | Value |
|-----------|-------|
| Fusion method | `rrf` |
| RRF damping k | `60` |
| Routing model | `gemini-3.1-flash-lite-preview` |
| Synthesis model | `gemini-3.1-flash-lite-preview` |
| Embedding model | `gemini-embedding-001` |
| Embedding dim | `3072` |
| Store directory | `.synthi/rag` |

### Post-Ingestion Stats

| Metric | Count |
|--------|-------|
| Documents | 26 |
| Summaries | 26 |
| Sections | 35 |
| ToC trees | 26 |
| Keyword docs | 26 |
| Unique terms | 319 |

### Ingestion Result

| Metric | Value |
|--------|-------|
| Processed | 11 |
| Skipped | 1 |
| Failed | 0 |
| Purged (stale) | 1 |
| Total sections | 20 |
| Time (ms) | 134230 |

### retrieve_context() — Steps 2+3 (no synthesis LLM)

Query: _"How does authentication work?"_

| Metric | Value |
|--------|-------|
| Documents searched | 2 |
| Documents selected | 2 |
| Sections used | 6 |
| Tokens assembled | 448 |
| Sufficiency | `SUFFICIENT` |
| Macro time (ms) | 667.6 |
| Micro time (ms) | 10698.7 |
| Total time (ms) | 11366.4 |

### query() — Full Pipeline (Steps 2+3+4, with synthesis LLM)

Query: _"What is the RAG pipeline and how does micro-navigation work?"_

| Metric | Value |
|--------|-------|
| Confidence | 0.860 |
| Citations | 1 |
| Documents searched | 4 |
| Documents selected | 4 |
| Macro time (ms) | 617 |
| Micro time (ms) | 25392 |
| Synthesis time (ms) | 11161 |
| Total time (ms) | 37171 |

**Answer snippet:**

> The RAG pipeline consists of the following four stages:

1.  **Ingestion**: Involves document loading, extraction of the Table of Contents (ToC), section splitting, and embedding [1].
2.  **Macro-retrieval**: Utilizes vector search based on cosine similarity combined with a BM25 keyword filter, whic


### Fusion Method Comparison

Same query (`authentication session token`) run with each fusion method.

| Method | Documents selected | Sufficiency |
|--------|--------------------|-------------|
| `rrf` | 1 | `INSUFFICIENT` |
| `weighted` | 5 | `SUFFICIENT` |

RRF (Reciprocal Rank Fusion) is the default. It fuses vector + BM25 + recency
ranks rather than raw scores, making it robust to scale differences between
the embedding cosine similarity and BM25 term frequencies.

## Shadow Subsystem

### Architecture

```
POST /shadow/run          → multiverse.run_job → N universes in parallel
  Universe                → generator → critic → critic_critic → (revise?)
  convergence check       → early exit if all universes agree
  arbiter                 → adjudicate winner across universe evidence
POST /shadow/{id}/apply   → apply winning patch, cancel siblings, refund cost
GET  /shadow/{id}/stream  → SSE job progress events
POST /shadow/{id}/why     → re-adjudicate with user follow-up question
GET  /shadow/cost/state   → daily spend vs cap
POST /shadow/cost/cap     → set daily cap
```

### Tier Configuration

| Tier | Universes | Wall-clock cap (s) | Cost ceiling ($) |
|------|-----------|--------------------|-----------------|
| `quick` | 1 | 8 | 0.0010 |
| `standard` | 3 | 25 | 0.0120 |
| `deep` | 3 | 45 | 0.0400 |

### Rate Cards ($ per call, Apr 2026 estimates)

| Provider | gen | critic | arbiter | critic_critic | revise |
|----------|-----|--------|---------|---------------|--------|
| anthropic | 0.0180 | 0.0120 | 0.0200 | 0.0008 | 0.0120 |
| openai | 0.0150 | 0.0100 | 0.0180 | 0.0006 | 0.0100 |
| gemini | 0.0035 | 0.0025 | 0.0040 | 0.0002 | 0.0025 |

### Cost Estimates by Tier × Provider

| Tier | Provider | Universes | Timeout (s) | Ceiling ($) | Estimated ($) |
|------|----------|-----------|-------------|-------------|---------------|
| `quick` | gemini | 1 | 8 | 0.0010 | 0.0010 |
| `quick` | anthropic | 1 | 8 | 0.0010 | 0.0010 |
| `quick` | openai | 1 | 8 | 0.0010 | 0.0010 |
| `standard` | gemini | 3 | 25 | 0.0120 | 0.0120 |
| `standard` | anthropic | 3 | 25 | 0.0120 | 0.0120 |
| `standard` | openai | 3 | 25 | 0.0120 | 0.0120 |
| `deep` | gemini | 3 | 45 | 0.0400 | 0.0400 |
| `deep` | anthropic | 3 | 45 | 0.0400 | 0.0400 |
| `deep` | openai | 3 | 45 | 0.0400 | 0.0400 |

> Gemini is the default provider. The estimated cost is the minimum of
> the rate-card sum and the tier ceiling (master plan §10).

### Project Signals (detected in temp workspace)

| Signal | Value |
|--------|-------|
| Project type | `web-app` |
| Languages | `python` |
| Test framework | `None` |
| Has CI | False |
| Has lockfile | False |
| Package manager | `npm` |
| Style hints | `uses-async, type-annotated` |

Project signals calibrate the Critic-Critic: e.g. a `web-app` with no CI
is treated differently from a `service` with lockfile + CI.

### Cost Ledger State (fresh workspace)

| Field | Value |
|-------|-------|
| daily_cap_usd | `5.0` |
| spent_today_usd | `0.0` |
| remaining_usd | `5.0` |
| today_jobs | `[]` |
| history | `[]` |

## How to Test RAG Only

### Unit / offline tests (no GEMINI_API_KEY needed)

```bash
cd ai-backend/ai-engine
python -m pytest code_intel/rag/tests/ -v
```

Covers 26 test files: document_store, toc_store, summary_index, section_store,
keyword_filter, document_ranker, query_analyzer, toc_extractor, section_splitter,
summary_searcher, context_builder, citation_tracker, confidence_scorer,
answer_synthesizer, tree_navigator, relevance_scorer, types, config, pipeline.

### Single pipeline test (no GEMINI_API_KEY for Steps 2+3, optional for Step 4)

```bash
python -m pytest code_intel/rag/tests/test_pipeline.py -v
```

### Integration report (this script)

```bash
python -m bench.synthi_report
```

With GEMINI_API_KEY set, the full 4-step query (Steps 2+3+4) also runs.

### Fusion method test

```bash
python -m pytest code_intel/rag/tests/test_document_ranker.py -v
python -m pytest code_intel/rag/tests/test_summary_searcher.py -v
```

## How to Test Shadow Only

### Cost estimation (offline, no API key)

```python
from shadow.multiverse import estimate_cost_for_request
print(estimate_cost_for_request('quick'))    # Gemini, 1 universe
print(estimate_cost_for_request('standard')) # Gemini, 3 universes
print(estimate_cost_for_request('deep'))     # Gemini, 3 universes + deeper timeout
```

### Bench harness (requires GEMINI_API_KEY and a running workspace)

```bash
cd ai-backend/ai-engine
python -m bench.harness --corpus bench/corpus --out bench/report.md
```

### Shadow via HTTP (requires ai-engine running)

```bash
# Start ai-engine
uvicorn main:app --port 8000

# Quick verify-only (no LLM generation, just structural check)
curl -X POST http://localhost:8000/shadow/verify-only \
  -H "Content-Type: application/json" \
  -d '{"workspace_path":"/tmp/ws","patches":[{"path":"src/buggy.py","new_content":"def divide(a,b):\n    if b==0: raise ZeroDivisionError()\n    return a/b"}],"tier":"quick"}'
```

## API Key Requirements Summary

### Shadow

| Key | Required | Role |
|-----|----------|------|
| `GEMINI_API_KEY` | **YES** (minimum) | Generator + Critic + Arbiter (default provider) |
| `ANTHROPIC_API_KEY` | no | Cross-universe generator/critic (Anthropic provider) |
| `OPENAI_API_KEY` | no | Cross-universe generator/critic (OpenAI provider) |

**Minimum: 1 key.** With only GEMINI_API_KEY, all three tiers work;
all universes use Gemini for generation, criticism, and arbitration.

With all 3 keys, Shadow can run cross-provider universes — e.g. Gemini generates,
Anthropic criticises, OpenAI arbitrates — giving diversity of opinion on the patch.

### RAG

| Key | Required | Role |
|-----|----------|------|
| `GEMINI_API_KEY` | **YES** | Embeddings (`gemini-embedding-001`) + routing LLM + synthesis LLM |

Without GEMINI_API_KEY: ingestion still works (zero-vector fallback for embeddings),
vector search returns no results, keyword/BM25 search still functions,
micro-navigation and synthesis are disabled.

### Relevant env vars

```bash
# Required
GEMINI_API_KEY=your-key-here

# Optional — provider overrides for RAG
RAG_DEBUG=true
RAG_ROUTING_MODEL=gemini-3.1-flash-lite-preview
RAG_SYNTHESIS_MODEL=gemini-3.1-flash-lite-preview

# Optional — provider overrides for Shadow
SYNTHI_GEMINI_MODEL=gemini-3.1-flash-lite-preview
SYNTHI_ANTHROPIC_MODEL=claude-3-haiku-20240307
OPENAI_MODEL=gpt-4o-mini
ANTHROPIC_API_KEY=your-anthropic-key
OPENAI_API_KEY=your-openai-key
```

## Failure Details

### `rag:dedup`

```
Traceback (most recent call last):
  File "C:\Users\dev\Downloads\synthi-test\synthi-ide\ai-backend\ai-engine\bench\synthi_report.py", line 85, in run_test
    data = fn(*args, **kwargs)
  File "C:\Users\dev\Downloads\synthi-test\synthi-ide\ai-backend\ai-engine\bench\synthi_report.py", line 331, in test_rag_dedup
    assert stats["documents"] == 1, (
           ^^^^^^^^^^^^^^^^^^^^^^^
AssertionError: Duplicate ingest created 27 docs, expected 1

```

### `rag:remove_file`

```
Traceback (most recent call last):
  File "C:\Users\dev\Downloads\synthi-test\synthi-ide\ai-backend\ai-engine\bench\synthi_report.py", line 85, in run_test
    data = fn(*args, **kwargs)
  File "C:\Users\dev\Downloads\synthi-test\synthi-ide\ai-backend\ai-engine\bench\synthi_report.py", line 422, in test_rag_remove_file
    assert result["status"] == "removed"
           ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
AssertionError

```

### `shadow:events_import`

```
Traceback (most recent call last):
  File "C:\Users\dev\Downloads\synthi-test\synthi-ide\ai-backend\ai-engine\bench\synthi_report.py", line 85, in run_test
    data = fn(*args, **kwargs)
  File "C:\Users\dev\Downloads\synthi-test\synthi-ide\ai-backend\ai-engine\bench\synthi_report.py", line 480, in test_shadow_events_import
        "universe_timeout_sec": UNIVERSE_TIMEOUT_SEC,
          ^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^^
    ...<3 lines>...
    
    
TypeError: JobState.__init__() missing 1 required positional argument: 'user_id'

```
