---
name: synthi-ai-backend
description: 'Use when working on the Synthi AI backend (ai-backend/): the Python ai-engine (FastAPI, Gemini), the Node.js gateway (WebSocket proxy), analyzer flows, healing flows, refactor/split, code intelligence (RAG), job queue, prompt caching, and the frontend AI contract.'
argument-hint: 'Describe the AI backend task, endpoint, or failure you want to work on.'
user-invocable: true
disable-model-invocation: false
---

# Synthi AI Backend

Skill for the two services under `ai-backend/`. Use this when the task touches AI analysis, refactoring, healing, code intelligence, the gateway WebSocket, Gemini integration, or the frontend's AI contract.

## When to Use

- Anything under `ai-backend/ai-engine/` or `ai-backend/gateway/`
- Adding or editing an AI-backed action (analyze, heal, refactor, agentic)
- Debugging chat/heal/analyze failures visible in the frontend
- Changing prompt construction, system prompts, or prompt caching
- Model / provider changes
- Frontend ↔ gateway ↔ engine transport bugs
- Anything labelled "AI gateway", "analyzer gateway", or "code intel"

## The Two Services At A Glance

| Service | Language | Framework | Port | Entry |
|---------|----------|-----------|------|-------|
| `ai-backend/ai-engine/` | Python 3.10 | FastAPI + Uvicorn (2 workers) | 8000 | `main.py` (`uvicorn.run("main:app", ...)`) |
| `ai-backend/gateway/` | Node.js 20+ | native `http` + `ws` + `undici` | 7070 | `server.js` (cluster mode, WS path `/ws`) |

Rule of thumb:

- **Gateway** owns the socket: connection management, per-client rate limiting (20 msg/s, 5 in-flight), supersession (`AbortController` on key collision), request/response plumbing. No LLM logic.
- **Engine** owns every LLM call: prompts, provider, tokenization, tool/context assembly, streaming, job queue, provenance.

Frontend talks **only to the gateway** (`ws://.../ws`). Gateway calls engine over plain HTTP 1.1 via `undici` to `BACKEND_URL` (default `http://127.0.0.1:8000`). No gRPC, no WS between them.

## Transport Contract

Frontend sends:

```
{ action: "analyze/proactive", requestId: "...", data: {...} }
```

Gateway action → engine route mapping is 1:1. Action `analyze/proactive` → `POST /analyze/proactive`. Full route list lives in `ai-engine/main.py` (40+ endpoints).

Gateway responses:

- `{ type: "result", requestId, data }` — one-shot
- `{ type: "streaming", requestId, chunk }` — SSE/NDJSON from engine, piped per chunk
- `{ type: "error", requestId, message }` — either engine non-200 or transport failure

Supersession: if a new action arrives with the same supersession key (e.g. `unified:${slug}:${filePath}`) while an older one is in flight, the gateway aborts the older request. Expect this when debugging "my request vanished".

## Ai-Engine Map (ai-backend/ai-engine/)

- `main.py` — FastAPI app. All 40+ endpoints live here. Very large file; search by route prefix.
- `llm/`
  - `providers/factory.py` — **Hardcoded `return GeminiProvider()`.** See "Gotchas".
  - `providers/gemini.py` — Gemini client. Model from `SYNTHI_GEMINI_MODEL` (default `gemini-3.1-flash-lite-preview`).
  - `providers/chatgpt.py` — unreachable (see Gotcha #2). Factory never returns it even when `provider_name='chatgpt'` is passed.
  - `providers/base.py` — `AiProvider` ABC.
  - `prompts.py` — base system instructions + fullfile/patch/explain prompt builders.
  - `structural_prompts.py` — heal prompt (compilation-error repair).
- `streaming.py` — `StreamingManager`, `GeminiStreamer`, `CancellationToken`.
- `code_intel/`
  - `engine.py` + `api.py` — retrieval / context assembly orchestration.
  - `retrieval/` — ranker, reranker, context assembler, budget enforcement.
  - `rag/` — macro keyword index + micro chunk summaries.
  - `ingestion/` — file walker, indexer, symbol extractor.
  - `tools/tools.py` — `ExplorationTools` (`list_files`, `search_symbols`, `find_callers`...). **Pre-LLM context gathering, not Gemini function-calling.**
- `analyzer/`
  - `AllLanguageAnalyzers.py` — tree-sitter static analysis.
  - `proactive/orchestrator.py` — tier router (static → semantic → AI).
  - `proactive/semantic_analyzer.py`, `workspace_analyzer.py`, `ai_predictor.py`.
  - `proactive/healing/` — error classification, repair strategies, policy, canary (partially scaffolded).
  - `proactive/cache.py` — LRU (2000 entries, 1h TTL).
- `build_manifest.py` — pydantic model + parser for the 4-file split manifest.
- `split_verifier.py` — post-split correctness.
- `diff_patch_helpers.py` — unified diff generation + application.
- `job_queue.py` — `PriorityJobQueue`, `JobWorker`.
- `provenance.py` — change-type enums, verification status tracker.
- `metrics.py` — latency/token/cost histograms.
- `intelligence/` — compiler introspection + file watchers.
- `test/` + `tests/` + `test_*.py` — multiple test setups; check which one the CI/dev flow uses before adding tests.

## Gateway Map (ai-backend/gateway/)

- `server.js` — everything. Single 2800+ LOC file. Cluster bootstrap, WS acceptor, one `async function forward*()` per action, rate-limit state, supersession map, health endpoints.
- `package.json` — `ws`, `undici`, `dotenv`, `cross-env` (dev). Node ≥18.
- `Dockerfile` — Alpine Node 20 single-stage.

If you're adding a new gateway action, the pattern is: define a `forwardX()` that POSTs to the matching engine route, handle streaming via `response.body` piped to the socket, and wire it into the action dispatch switch.

## Route Families (ai-engine)

Grouped by prefix in `main.py`:

- `/analyze/*` — `static`, `ai`, `proactive`, `proactive/quick`, `container`, `unified`, `workspace`, `workspace/incremental`
- `/refactor/*` — `split`, `split/verified`, `diff_patch`, `heal`
- `/heal/*` — `analyze`, `apply`, `container`, `batch`, `config`, `stats`, `rules`, `ai/*`, `agentic/*`
- `/queue/*` — `submit`, `status/{job_id}`, `cancel/{job_id}`, `stats`
- `/provenance/*` — `{record_id}`, `file/{path}`, `stats`
- `/health`

Live vs scaffolded:

- **Live**: static/semantic/AI analyze, refactor/split, diff_patch, heal (basic), code-intel RAG, workspace analysis, job queue, streaming, provenance.
- **Scaffolded (handlers present, logic partial)**: `/heal/agentic/*` episode store, policy evaluation, canary testing. Treat as a WIP subsystem, not a broken endpoint.
- **Absent**: no chat-mode endpoint, no autocomplete endpoint on the engine. Autocomplete comes from frontend `/api/completion` which may call the engine or another path.

## Prompt Caching (Synthi's scheme, not LLM-native)

Synthi does NOT use Anthropic's `cache_control` or Gemini caching. It caches prompt chunks via XML tag extraction:

- `<synthi_arch_cache> ... </synthi_arch_cache>` — outer markdown block describing split structure, routing rules, forbidden patterns.
- `<synthi_build_manifest> ... </synthi_build_manifest>` — 4-file JSON object, nested inside the arch cache.

`main.py` extracts these with regex (`extract_architecture`, `parse_manifest`), stores them, and re-injects them into later `/refactor/diff_patch` and `/refactor/heal` prompts. If extraction misses, the system falls back silently to the raw response and downstream healing quality degrades — grep for those tag strings when debugging "heal used to work, now it's dumb".

There is no Claude prompt caching here. If you port to Claude / Anthropic SDK, use the `claude-api` skill.

## Env Vars

**ai-engine**:

- `GEMINI_API_KEY` — **required**. Missing → every LLM call raises `ValueError`, FastAPI returns 500.
- `SYNTHI_GEMINI_MODEL` — default `gemini-3.1-flash-lite-preview`.
- `OPENAI_API_KEY`, `OPENAI_MODEL` — ignored (dead provider path).

**gateway**:

- `GATEWAY_PORT` — default 7070.
- `GATEWAY_WS_PATH` — default `/ws`.
- `GATEWAY_CLUSTER` — default `"true"` (fork per CPU).
- `GATEWAY_WORKERS` — default `os.cpus().length`.
- `BACKEND_URL` — default `http://127.0.0.1:8000`. In compose: `http://ai-engine:8000`.
- `NODE_ENV` — affects log verbosity.

## Critical Gotchas

1. **Gemini-only factory.** `llm/providers/factory.py` is literally `return GeminiProvider()`. If you "switch the provider" by passing a name argument, nothing happens. To add a provider, edit the factory.

2. **`chatgpt.py` is unreachable.** `main.py` has multiple `get_provider(provider_name='chatgpt', ...)` calls — they all silently return `GeminiProvider()` because the factory ignores the argument. So "we're using ChatGPT here" is wrong even where it looks intentional. To actually use OpenAI, you'd have to change the factory first.

3. **No native LLM caching.** The `<synthi_arch_cache>` / `<synthi_build_manifest>` tag scheme is the entire caching story. Silent regex misses are the usual cause of "heal lost its architecture awareness".

4. **Supersession silently drops work.** If the frontend retries aggressively, older in-flight requests get `AbortController`-cancelled by the gateway. Expected, not a bug — but will confuse naive debugging.

5. **No auth on the gateway.** Per-socket rate limiting only. If the gateway is ever exposed publicly, that's a security bug, not a feature request.

6. **Error cascade.** Missing `GEMINI_API_KEY` surfaces as a generic 500 at the engine, generic error frame at the gateway, generic red toast in the UI. Always check engine logs first for LLM-side failures.

7. **Gateway forwarder → engine route is 1:1.** If you see a gateway `forwardFoo()` without a matching `@app.post("/foo")` in `main.py`, the action is broken.

8. **Tiktoken on Gemini is approximate.** `cl100k_base` (GPT) is used as a proxy for Gemini token counting. Budget decisions can over/under-estimate by 5–10%.

9. **Proactive cache is 1h / 2000 entries.** Cache miss → full AI re-analysis. Don't assume "same file → cheap".

10. **Two test dirs exist** (`test/`, `tests/`, plus `test_*.py` at root). Pick the one the rest of the file already uses; do not scatter new tests.

## Typical Failure Modes

- "AI always errors immediately" → gateway can't reach engine (`BACKEND_URL` wrong, or engine crashing on `GEMINI_API_KEY`).
- "Chat streams nothing" → engine returning non-streaming response, or gateway not piping `response.body`.
- "Heal forgot project rules" → arch-cache tag extraction failed upstream. Grep engine logs for `synthi_arch_cache`.
- "Requests vanish under rapid edits" → supersession. Intentional. Slow the client, or widen the supersession key.
- "New action doesn't work" → missing `forward*()` in gateway OR missing route in engine. Check both.
- "Job queue status is stale" → poll not firing, or the job worker never started (check engine startup logs for `JobWorker` init).

## What Good Output Looks Like

For AI-backend tasks, the answer should typically name:

- which service owns the fix (gateway transport vs engine logic)
- the specific route or `forward*()` function
- whether the LLM call path is static / semantic / AI / heal / refactor
- whether the prompt cache (arch/manifest tags) is involved
- which env var gates the behavior

Do not propose:

- Anthropic / Claude changes without first migrating the provider (see `claude-api` skill)
- "let's add a second WS between gateway and engine" — it's HTTP by design
- new actions that bypass the gateway — the frontend contract is WS-only
