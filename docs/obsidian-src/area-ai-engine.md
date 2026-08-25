---
title: Area — ai-backend/ai-engine
type: area
status: complete
repo: vectant-ade
tags: [area, ai-engine, backend, fastapi]
---

# Area: `ai-backend/ai-engine`

Exhaustive endpoint + module analysis of the AI engine service — the FastAPI "brain" of Vectant/Synthi. It hosts every AI-driven subsystem: universal & GPU HMR splitting, diff-patching, healing (regex + AI + agentic), code intelligence/RAG, shadow verification ("Synthi Genome"), counterfactual telemetry, GPU HMR split-broker contracts, job queueing, verification gates, provenance tracking, and metrics.

> **Prototype notice** (`ai-backend/ai-engine/main.py:L1`): *"PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST"* — the Rust worker mirrors several of these modules (manifest validation, verifiers).

## At a glance

| Stat | Value |
|---|---|
| HTTP endpoints | **175** (102 in `main.py` + 73 via mounted routers) |
| Routers | 5 mounted: `code_intel`, `gpu_hmr`, `shadow`, `counterfactual`, `shadow_continuous` |
| Python source files | 487 (excl. caches/fixtures) |
| Largest modules | `verifier_gpu.py` (3554 ln), `llm/prompts.py` (4878 ln), `main.py` (4853 ln), `agents/gpu_split_repair.py` (3354 ln) |
| Primary LLM | Gemini via `GEMINI_API_KEY`; Anthropic/OpenAI optional for shadow multi-provider |

---

## Service entry points

### `run_server.py` (54 ln)

Thin uvicorn exec wrapper (`ai-backend/ai-engine/run_server.py:L36`): builds argv and `os.execvp("uvicorn", …)`.

| Concern | Detail |
|---|---|
| App target | `SYNTHI_AI_ENGINE_APP` (default `main:app`) |
| Host / port | `SYNTHI_AI_ENGINE_HOST` (default `0.0.0.0`) / `SYNTHI_AI_ENGINE_PORT` (default `8000`) |
| Workers | `SYNTHI_AI_ENGINE_WORKERS`, falling back to `WEB_CONCURRENCY` (container convention), default 1 |
| Keep-alive | `SYNTHI_AI_ENGINE_TIMEOUT_KEEP_ALIVE` (default 120 s) |

Tested by `tests/test_run_server.py`.

### `main.py` (4853 ln) — application assembly

- `AI_ENGINE_ROOT = Path(__file__).resolve().parent`; loads `.env` via `load_dotenv(override=False)` (`main.py:L29`).
- `app = FastAPI()` at `main.py:L290`; CORS middleware at `main.py:L301` with origins parsed by `_parse_allowed_origins()` (`SYNTHI_AI_ENGINE_ALLOWED_ORIGINS`/`AI_BACKEND_ALLOWED_ORIGINS`, default `*`).
- **Auth**: ASGI middleware `require_internal_auth` (`main.py:L327`) — bearer-token gate controlled by `AI_ENGINE_AUTH_TOKEN` / `AI_BACKEND_AUTH_TOKEN`; can be disabled with `AI_ENGINE_AUTH_DISABLED`. `_extract_bearer_token()` at `main.py:L317`.
- **Request logging**: `log_requests` middleware (`main.py:L348`).
- Router mounting (each wrapped in try/ImportError so missing optional deps only warn):
  - `code_intel.api.router` → prefix `/code-intel` (`main.py:L3100`)
  - `gpu_hmr.api.router` → prefix `/gpu-hmr` (`main.py:L3111`)
  - `shadow.shadow_router` → `/shadow` + `shadow.telemetry_api.router` → `/counterfactual` (`main.py:L3122-3124`)
  - `shadow_continuous.api.router` → `/shadow_continuous` (`main.py:L3135`)
- Self-healing system imported directly (`analyzer.proactive.healing.engine.get_healing_engine`, `main.py:L3144`).
- Key helpers: `fetch_file_from_container()` (`main.py:L545`) pulls authoritative file content from the collab server (`COLLAB_SERVER_URL`) which flushes Y.js state to disk; `enforce_ai_request_limits()` (`main.py:L452`) caps prompt size (`AI_ENGINE_MAX_AI_REQUEST_CHARS`); `validate_workspace_relative_path()` blocks traversal (`SPLIT_WORKSPACE_ROOT`).
- Provider selection env: `SYNTHI_GEMINI_MODEL`, `SYNTHI_GEMINI_DELTA_MODEL`, `SYNTHI_GPU_SPLIT_MODEL`, `SYNTHI_GPU_DELTA_MODEL`, `SYNTHI_OPENAI_MODEL`, `SYNTHI_DIFF_PATCH_PROVIDER`.

---

## Directory map

```
ai-backend/ai-engine/
├── run_server.py            # uvicorn launcher
├── main.py                  # FastAPI app: 102 endpoints + router mounts
├── build_manifest.py        # BuildManifest schema, V1 validator, include→link gate
├── verifier.py              # language-agnostic AI-output verifier (hard gate)
├── verifier_gpu.py          # GPU no-shim verifier (§11.4 checks, split verification)
├── split_verifier.py        # structural split verifier (boundaries/hooks/state)
├── streaming.py             # real SSE token streaming + fallbacks
├── job_queue.py             # priority multi-lane job queue + workers
├── provenance.py            # AI-change provenance records
├── program_manifest_gen.py  # vectant.programs.json drafting
├── program_review.py        # community-app risk review (advisory)
├── diff_patch_helpers.py    # edit-list prompts/validation, manifest-heal prompts
├── metrics.py               # EngineMetricsCollector (TTFT, RPS, percentiles…)
├── llm/                     # prompts.py (giant), providers/, structural_prompts.py
├── agents/                  # GPU HMR agent pipeline (detect→split→verify→repair→heal)
├── analyzer/                # static analyzers + proactive/ + proactive/healing/
│   └── proactive/healing/   # SelfHealingEngine + rules/ + agentic repair stack
├── bench/                   # offline eval harness + corpus + failure_distiller/
├── cm/                      # scratch dir (gitignored generation markers)
├── code_intel/              # indexing/retrieval/editing/summaries/RAG subsystem
│   ├── core/ indexer/ ingestion/ parsers/
│   ├── editing/ eviction/ retrieval/ routing/ summaries/ tools/
│   ├── evaluation/ lsp/ tests/
│   └── rag/                 # 4-step doc RAG pipeline (own API under /code-intel)
├── intelligence/            # Layer A/B/C diagnostic aggregation hub
├── gpu_hmr/                 # split-broker contracts, canonical hashing, reason codes
├── shadow/                  # Synthi Genome: multiverse, arbiter, runners, telemetry
│   └── runner/              # per-language toolchain runners
├── shadow_continuous/       # pass→fail regression watcher ($0.50/day cap)
└── tests/ + test*/          # pytest suites (unit + live-phase tests)
```

---

## Endpoint inventory

175 routes total. `main.py` registers 102 directly on the root app; the five mounted routers add 73 more under their prefixes. All routes below are grouped by subsystem; "→ handler" names the implementing module.

### Root app (`main.py`, prefix: none)

#### Intent & analysis

| Method | Path | Handler (line) | Request → Response | Notes |
|---|---|---|---|---|
| POST | `/classify/intent` | `classify_intent` L603 | `IntentRequest` → intent label | LLM intent classification (`explain/navigate/debug/refactor/…`) drives response format; → `llm/providers` |
| POST | `/analyze/static` | `analyze_code` L629 | `AnalyzeRequest` | static pattern analysis; → `analyzer.AllLanguageAnalyzers` |
| POST | `/analyze/proactive` | `analyze_proactive` L645 | `ProactiveAnalysisRequest` | multi-tier static+semantic+AI; → `analyzer/proactive/orchestrator.py` |
| POST | `/analyze/proactive/quick` | `analyze_proactive_quick` L723 | `ProactiveAnalysisRequest` | static+semantic only, <200 ms typing path |
| GET | `/analyze/proactive/cache/stats` | `get_cache_stats` L746 | — | cache stats |
| POST | `/analyze/proactive/cache/clear` | `clear_cache` L753 | — | clear cache |
| POST | `/analyze/container` | `analyze_from_container` L761 | `ContainerAnalysisRequest` | container-first: fetches file via collab server |
| POST | `/analyze/unified` | `analyze_unified` L914 | `UnifiedAnalysisRequest` → `UnifiedAnalysisResponse` | **recommended** unified pipeline; aggregator of Layers A/B/C → `intelligence/` |
| GET | `/analyze/unified/status` | `get_unified_status` L1213 | — | Intelligence Aggregator status |
| POST | `/analyze/workspace` | `analyze_workspace` L1285 | `WorkspaceAnalysisRequestModel` | workspace-level, incremental, cross-file; hunk model from `analyzer/proactive/hunk_applier.py` |
| POST | `/analyze/workspace/incremental` | `analyze_workspace_incremental` L1399 | same | changed-files + dependents only |
| GET | `/analyze/workspace/{workspace_id}/stats` | `get_workspace_stats` L1415 | — | per-workspace analysis state |
| POST | `/analyze/workspace/{workspace_id}/clear` | `clear_workspace` L1422 | — | clear cached state |

#### AI split / refactor / heal (core HMR surface)

| Method | Path | Handler (line) | Request → Response | Subsystem |
|---|---|---|---|---|
| POST | `/analyze/ai` | `analyze_code_ai` L1430 | `AnalyzeAiRequest` | generic AI analysis; provider via `llm/providers/factory.py`; prompts from `llm/prompts.py` |
| POST | `/refactor/split` | `refactor_split` L1464 | `AnalyzeAiRequest` | universal split (host C++); writes `.synthi_split_meta.json`; `UNIVERSAL_SPLIT_PROMPT`; manifest validated by `build_manifest.py` |
| POST | `/refactor/split_file` | `split_file` L1509 | form/query params | legacy single-file split helper |
| POST | `/analyze/ai/verified` | `analyze_code_ai_verified` L1598 | `VerifiedAiRequest` | provenance-tracked + verified output; → `verifier.py` + `provenance.py` |
| POST | `/refactor/split/verified` | `refactor_split_verified` L1708 | `VerifiedAiRequest` | split with verification gates; `VerificationStatus` mapping at `main.py:L82` |
| POST | `/refactor/split/gpu` | `refactor_split_gpu` L2336 | `VerifiedAiRequest` | GPU Kernel Splitter Agent; `GPU_SPLIT_PROMPT`, requires manifest `gpu` block; → `agents/kernel_splitter.py` |
| POST | `/refactor/diff_patch` | `refactor_diff_patch` L2256 | `DiffPatchRequest` | edit-list diff patching of split modules; → `diff_patch_helpers.py` |
| POST | `/refactor/diff_patch/gpu` | `refactor_diff_patch_gpu` L2663 | `GpuDiffPatchRequest` | adds `reload_plan` + `device` module; → `agents/gpu_mod_delta.py` |
| POST | `/refactor/heal/gpu` | `refactor_heal_gpu` L2768 | `GpuHealRequest` | GPU compile/perf/runtime healer tiers; → `agents/gpu_healer.py`, verified by `verifier_gpu.verify_heal_output` |
| POST | `/refactor/heal` | `refactor_heal` L2895 | `HealRequest` | compile-error healing for split modules; prompt via `llm/structural_prompts.format_heal_prompt` |
| POST | `/refactor/heal/manifest` | `refactor_heal_manifest` L3013 | `HealManifestRequest` → `{updated_manifest, unchanged}` | link-flag healing after undefined references; → `diff_patch_helpers.build_manifest_heal_prompt` |

#### Self-healing (regex mode) `/heal/*`

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/heal/analyze` | `heal_analyze` L3175 | detect micro-fixes without applying |
| POST | `/heal/apply` | `heal_apply` L3209 | apply all-safe or specific fix IDs |
| POST | `/heal/container` | `heal_container` L3255 | container-first variant |
| GET | `/heal/config` | `get_heal_config` L3293 | current config |
| POST | `/heal/config` | `update_heal_config` L3300 | update config |
| GET | `/heal/stats` | `get_heal_stats` L3323 | system statistics |
| GET | `/heal/rules` | `list_heal_rules` L3330 | registered rules (registry in `healing/rule_registry.py`) |
| POST | `/heal/batch` | `batch_heal` L3351 | batch analyse multiple files → `healing/batch_engine.py` |
| GET | `/heal/cache/stats` | `heal_cache_stats` L3403 | healing cache stats |
| GET | `/heal/presets` | `list_heal_presets` L3411 | config presets (`healing/config_schema.py`) |
| POST | `/heal/preset` | `apply_heal_preset` L3424 | apply named preset |
| GET | `/heal/metrics` | `heal_metrics` L3446 | Prometheus-format export (`healing/metrics_export.py`) |

#### Self-healing (AI/agentic mode) `/heal/ai/*` + `/heal/agentic/*`

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/heal/ai/analyze` | `heal_ai_analyze` L3542 | LLM bug detection → `healing/ai_agent.py` |
| POST | `/heal/rule/translate` | `heal_rule_translate` L3602 | plain-English → rule JSON |
| POST | `/heal/ai/runtime` | `heal_ai_runtime_error` L3709 | HMR runtime-error fixing (`AIRuntimeErrorRequest`) |
| POST | `/heal/ai/batch` | `heal_ai_batch` L3790 | multi-file single-LLM-call analysis |
| POST | `/heal/ai/hybrid` | `heal_ai_hybrid` L3837 | regex rules + AI merged, AI priority |
| GET | `/heal/ai/stats` | `heal_ai_stats` L3872 | LLM calls/latency/acceptance |
| GET | `/heal/ai/health` | `heal_ai_health` L3899 | pipeline health check |
| POST | `/heal/ai/stream` | `heal_ai_stream` L3966 | SSE stream of progress/partial fixes → `healing/ai_streaming.py` |
| GET/PUT | `/heal/ai/config` | L4027 / L4043 | get/update dynamic agent config (`AIConfigUpdate`) |
| POST | `/heal/ai/cache/clear` | L4084 | clear prompt cache |
| POST | `/heal/ai/preview` | `heal_ai_preview` L4094 | preview fixes with simulated diff, no apply |
| POST | `/heal/ai/project` | `heal_ai_project` L4138 | analyze file + dependents → `healing/ai_deps.py` |
| POST | `/heal/ai/feedback` | `heal_ai_feedback` L4190 | record accept/reject → `healing/ai_memory.py` |
| GET | `/heal/ai/memory` | L4230 | memory summary |
| DELETE | `/heal/ai/memory` | L4239 | reset learned patterns |
| POST | `/heal/ai/policy/suppress` | L4251 | suppression policy upsert → `healing/ai_policy.py` |
| POST | `/heal/ai/policy/unsuppress` | L4285 | remove suppression |
| GET | `/heal/ai/policy` | L4306 | list policies |
| DELETE | `/heal/ai/policy` | L4318 | clear policies |

**Agentic repair stack** (`/heal/agentic/*`, backed by `healing/` modules):

| Method | Path | Handler (line) | Backing module |
|---|---|---|---|
| POST | `/heal/agentic/distill` | `distill_failure` L4364 | `failure_distiller.FailureDistiller.distill` |
| POST | `/heal/agentic/distill/observations` | L4374 | adapter evidence capture (`failure_distiller_adapters.py`) |
| GET | `/heal/agentic/distill/observations` | L4384 | list unexpired observations |
| POST | `/heal/agentic/distill/run` | L4394 | replay capsule, same-failure predicate |
| POST | `/heal/agentic/distill/explain` | L4406 | capsule unit evidence |
| POST | `/heal/agentic/distill/materialize` | L4418 | materialize capsule without touching source |
| POST | `/heal/agentic/distill/delete` | L4430 | delete + audit |
| POST | `/heal/agentic/distill/purge-expired` | L4442 | retention policy sweep |
| POST | `/heal/agentic/distill/vivarium-export` | L4456 | sanitized scenario manifest |
| POST | `/heal/agentic/distill/vivarium-promote` | L4468 | promote to versioned artifact |
| POST | `/heal/agentic/distill/validate-patch` | L4480 | patch validation in source world |
| POST | `/heal/agentic/distill/request-apply` | L4492 | approval-bound apply request |
| POST | `/heal/agentic/distill/apply-approved` | L4504 | apply reviewed patch |
| GET | `/heal/agentic/distill/metrics` | L4516 | reduction/cost metrics |
| POST | `/heal/agentic/diagnose` | L4523 | root-cause from error text → `diagnosis.py` |
| POST | `/heal/agentic/episode/create` | L4545 | repair episode state machine → `repair_episode.py` |
| GET | `/heal/agentic/episode/{episode_id}` | L4560 | episode by ID |
| GET | `/heal/agentic/episodes` | L4571 | recent episodes |
| POST | `/heal/agentic/policy/evaluate` | L4581 | evaluate action vs policy → `policy.py` |
| GET | `/heal/agentic/policy/status` | L4597 | policy engine status |
| POST | `/heal/agentic/verify` | L4606 | verification pipeline → `verification.py` |
| POST | `/heal/agentic/guardrails` | L4621 | semantic guardrails on a patch |
| GET | `/heal/agentic/telemetry/calibration` | L4637 | per-rule calibration table |
| GET | `/heal/agentic/telemetry/degrading` | L4645 | degrading-quality rules |
| POST | `/heal/agentic/runtime/ingest` | L4655 | runtime error ingest → `runtime_healing.py` |
| GET | `/heal/agentic/runtime/stats` | L4684 | runtime healing stats |
| POST | `/heal/agentic/observability/error` | L4693 | observability triggers → `observability.py` |
| POST | `/heal/agentic/observability/build` | L4702 | build duration sample |
| POST | `/heal/agentic/observability/hmr-failure` | L4712 | HMR failure sample |
| GET | `/heal/agentic/observability/stats` | L4722 | hub stats |
| GET | `/heal/agentic/observability/triggers` | L4729 | recent triggers |
| POST | `/heal/agentic/canary/create` | L4738 | canary rollout → `canary.py` |
| GET | `/heal/agentic/canary` | L4752 | list rollouts |
| GET | `/heal/agentic/canary/stats` | L4759 | rollout stats |
| GET | `/heal/agentic/status` | L4768 | combined status of all agentic subsystems |

#### Queue, provenance, programs, misc

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/queue/submit` | `submit_job` L1938 | priority queue submit → `job_queue.PriorityJobQueue` |
| GET | `/queue/status/{job_id}` | L1974 | job status |
| POST | `/queue/cancel/{job_id}` | L1994 | cancel job |
| GET | `/queue/stats` | L2003 | queue stats incl. aging/starvation |
| GET | `/provenance/{record_id}` | L2011 | provenance record → `provenance.py` |
| GET | `/provenance/file/{file_path:path}` | L2023 | records per file |
| GET | `/provenance/stats` | L2031 | tracker statistics |
| POST | `/programs/risk-review` | `programs_risk_review` L4815 | advisory risk score post-hard-gates → `program_review.py` |
| POST | `/programs/generate-manifest` | L4835 | draft `vectant.programs.json` → `program_manifest_gen.py` (fail-closed) |
| GET | `/` | `root` L4791 | index |
| GET | `/health` | `health_check` L4842 | service discovery health |

### Router: `/code-intel` (`code_intel/api.py`, 15 routes)

Auth via `CODE_INTEL_API_KEY` header check; workspace jail enforced by `core/security.py`; `SYNTHI_REPOS_PATH` + `CODE_INTEL_REQUIRE_SLUG` control slug resolution.

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/code-intel/index` | `index_workspace` L412 | parse+index whole workspace (vector+structural) |
| POST | `/code-intel/index/file` | `index_file` L448 | incremental single-file index |
| POST | `/code-intel/index/file/delete` | `delete_file` L483 | purge deleted file from indexes/stores |
| POST | `/code-intel/index/file/rename` | `rename_file` L514 | atomic rename across indexes |
| POST | `/code-intel/context` | `get_context` L535 | full RAG/retrieval context assembly within token budget |
| POST | `/code-intel/context/fast` | `get_context_fast` L689 | fast path: BM25+symbol search for inline completion |
| POST | `/code-intel/edit-impact` | `edit_impact` L1016 | NEP Phase 2 follow-up-edit-site prediction (BFS depth 2) |
| POST | `/code-intel/tools/definitions` | L1133 | tool schemas in OpenAI/Anthropic format |
| POST | `/code-intel/tools/execute` | L1151 | run exploration tool (find_usages, get_definition, …) |
| POST | `/code-intel/summary/repo` | L1176 | repository summary |
| POST | `/code-intel/summary/file` | L1202 | file summary |
| POST | `/code-intel/metrics` | L1231 | retrieval latency/budget/quality metrics |
| POST | `/code-intel/edit` | L1345 | execute validated edit plan with rollback → `editing/` |
| POST | `/code-intel/save` | L1404 | persist engine state |
| POST | `/code-intel/load` | L1417 | restore engine state |

RAG sub-routes are registered onto this same router by `rag/api.register_rag_routes()`:

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/code-intel/rag/query` | `rag_query` L51 | execute RAG query with citations |
| POST | `/code-intel/rag/query/stream` | L82 | SSE streaming answer (`macro/micro/answer` events) |
| POST | `/code-intel/rag/ingest` | L146 | ingest directory or single file |
| POST | `/code-intel/rag/ingest/async` | L178 | background ingest → job_id |
| GET | `/code-intel/rag/ingest/job/{job_id}` | L205 | async job status |
| GET | `/code-intel/rag/ingest/jobs` | L217 | list ingest jobs |
| GET | `/code-intel/rag/stats` | L226 | pipeline statistics |
| POST | `/code-intel/rag/clear` | L235 | clear all RAG data |
| GET | `/code-intel/rag/documents` | L245 | list ingested documents |
| GET | `/code-intel/rag/health` | L269 | subsystem health |
| GET | `/code-intel/rag/diagnostics` | L286 | deep diagnostics (latency/rate-limit/cache state) |
| POST | `/code-intel/rag/cache/invalidate` | L345 | drop query result cache |

### Router: `/gpu-hmr` (`gpu_hmr/api.py`, 15 routes)

Thin HTTP shell over the process-global broker `gpu_hmr.broker.get_gpu_hmr_broker()`. All mutating ops are idempotent (IdempotencyRecord keyed replay).

| Method | Path | Handler (line) | Broker op |
|---|---|---|---|
| POST | `/gpu-hmr/readiness` | `readiness` L109 | `broker.readiness` — contract/version readiness report |
| POST | `/gpu-hmr/projections` | `create_projection` L121 | create target-scoped projection record |
| GET | `/gpu-hmr/projections/{projection_hash}` | L127 | fetch projection |
| POST | `/gpu-hmr/prepare-candidate` | `prepare_candidate` L133 | prepare compile candidate (job creation) |
| GET | `/gpu-hmr/candidates` | L139 | list candidates (optional target filter) |
| GET | `/gpu-hmr/candidates/{candidate_id}` | L145 | candidate record |
| GET | `/gpu-hmr/candidates/{candidate_id}/trace` | L151 | trace events |
| POST | `/gpu-hmr/candidates/{candidate_id}/verify` | L157 | run verifier kinds (schema/scope/dependency/mapping/abi/…) |
| POST | `/gpu-hmr/candidates/{candidate_id}/promote` | L163 | promote verified candidate to accepted pointer |
| POST | `/gpu-hmr/candidates/{candidate_id}/cancel` | L169 | cancel |
| POST | `/gpu-hmr/candidates/{candidate_id}/diagnose` | L175 | diagnose blocked candidate |
| GET | `/gpu-hmr/jobs/{job_id}` | L181 | job record |
| GET | `/gpu-hmr/jobs/{job_id}/trace` | L187 | job trace |
| POST | `/gpu-hmr/jobs/{job_id}/cancel` | L193 | cancel job |
| GET | `/gpu-hmr/accepted/current` | `accepted_current` L199 | current accepted pointer |

### Router: `/shadow` (`shadow/api.py`, 8 routes)

Synthi Genome shadow verification. Jobs run in BackgroundTasks; SSE streaming; apply gated by snapshot 3-way merge.

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/shadow/run` | `shadow_run` L82 | start N-universe shadow run (tier quick/standard/deep); returns job_id + cost estimate |
| GET | `/shadow/cost/state` | `cost_state` L124 | cost dashboard snapshot → `cost_ledger.py` |
| POST | `/shadow/cost/cap` | `cost_cap` L136 | set daily cap |
| POST | `/shadow/verify-only` | `shadow_verify_only` L143 | verify user's own patch without generation |
| GET | `/shadow/{job_id}/stream` | `shadow_stream` L161 | SSE event stream → `events.py` |
| POST | `/shadow/{job_id}/apply` | `shadow_apply` L202 | apply winning patch (snapshot merge + AI rebase fallback) |
| POST | `/shadow/{job_id}/why` | `shadow_why` L429 | [Why?] arbiter re-adjudication with a user question |
| POST | `/shadow/{job_id}/cancel` | `shadow_cancel` L471 | cancel pending universes, credit saved cost |

### Router: `/counterfactual` (`shadow/telemetry_api.py`, 20 routes)

Counterfactual branch telemetry & control plane over the workspace-scoped JSON repository (`telemetry_repository.py`). Runner execution is server-constructed (Codex/Claude Code) and quarantined.

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/counterfactual/runs` | `create_run` L183 | open counterfactual run |
| POST | `/counterfactual/runs/{run_id}/branches` | `submit_branch` L196 | submit branch trace |
| POST | `/counterfactual/branches/{branch_id}/detectors` | `submit_detector` L206 | attach detector result |
| POST | `/counterfactual/runs/{run_id}/selection` | `record_selection` L219 | record selection outcome (+ChoiceScene capture) |
| POST | `/counterfactual/runs/{run_id}/policy-deltas` | `generate_policy_deltas` L247 | derive policy deltas from regret lessons |
| GET | `/counterfactual/niche-map` | `get_niche_map` L279 | execution niche map per task class |
| POST | `/counterfactual/forecast/directions` | `forecast_directions` L285 | direction forecast from deltas |
| GET | `/counterfactual/controls` | `get_controls` L292 | control-plane settings |
| PUT | `/counterfactual/controls` | `update_controls` L298 | update settings |
| DELETE | `/counterfactual/policy-deltas/{delta_id}` | L308 | delete delta |
| POST | `/counterfactual/policy-deltas/{delta_id}/contradict` | L316 | contradict delta with evidence |
| DELETE | `/counterfactual/telemetry` | `delete_workspace_telemetry` L324 | purge workspace telemetry |
| GET | `/counterfactual/policy-deltas` | L331 | list active deltas |
| GET | `/counterfactual/inspection` | L337 | bounded inspection dump |
| POST | `/counterfactual/runs/{run_id}/mutation-trials` | L343 | create quarantined mutation trial |
| POST | `/counterfactual/mutation-trials/{trial_id}/results` | L356 | record trial result |
| POST | `/counterfactual/mutation-trials/{trial_id}/execute` | L377 | execute trial through isolated adapter path |
| POST | `/counterfactual/runs/{run_id}/post-selection-mutation` | L404 | summarize post-apply edits (non-retentive) |
| POST | `/counterfactual/runs/{run_id}/execute` | `execute_external_runner` L437 | run Codex/Claude runner in existing chamber; command built server-side |
| POST | `/counterfactual/runs/{run_id}/codesite-finalize` | L569 | trusted CodeSite worktree landing gate |

### Router: `/shadow_continuous` (`shadow_continuous/api.py`, 3 routes)

| Method | Path | Handler (line) | Notes |
|---|---|---|---|
| POST | `/shadow_continuous/notify` | `notify` L47 | collab-server bridge posts debounced file events → regression replay |
| GET | `/shadow_continuous/{workspace_path:path}/state` | `state` L63 | watcher state snapshot |
| POST | `/shadow_continuous/opt_out` | `opt_out` L75 | per-workspace opt-out |

### Endpoint totals

| Surface | Routes | Breakdown |
|---|---|---|
| `main.py` | 102 | POST 65 · GET 34 · PUT 1 · DELETE 2 |
| `/code-intel` (incl. rag) | 15 + 12 = 27 | POST 21 · GET 6 |
| `/gpu-hmr` | 15 | POST 8 · GET 7 |
| `/shadow` | 8 | POST 6 · GET 2 |
| `/counterfactual` | 20 | POST 13 · GET 4 · PUT 1 · DELETE 2 |
| `/shadow_continuous` | 3 | POST 2 · GET 1 |
| **Total** | **175** | |

---

## Module analyses

### `build_manifest.py` (1670 ln) — manifest schema + V1 gate

**Purpose.** Pydantic schema + validator for the build manifest that the Rust worker consumes (forwarded via `.synthi_split_meta.json`). Defines everything needed to compile the split modules (core/gui/shared/host_runner) plus optional `gpu` block.

- **Classes**: `GpuBuildBlock` L83 (device.cu/device.hip recipe, fatbin strategy), `ConfidenceBlock` L110 (`runner_synthesis == "low"` is the hard rejection guardrail), `ModuleFilesBlock` L129 (role→path mapping), `BuildManifest` L147, `ManifestRejection` L188.
- **Key functions**: `validate_manifest_v1` L231 (execution gate — raises `ManifestRejection` for unsupported pre-compile steps / low runner synthesis), `parse_manifest` L304, `manifest_to_dict` L327, `internalize_gpu_generated_artifacts` L580 (moves generated GPU role files under `.synthi/generated/gpu`), `normalize_gpu_split_manifest` L674 (fills mechanical defaults), `validate_include_link_coverage` L1619 (**include→link rule**: every non-stdlib `#include` must have a matching link flag in `runner_link_flags` AND `gui_link_flags`, else 422 with three-option error card), plus CMake File-API metadata extraction helpers (`_extract_cmake_file_api_device_flags` L1201, `_extract_build_metadata_link_flags` L1066).
- **Callers**: `main.py` (split endpoints), tests `test/test_hmr_lightning.py`, `test_include_link_validator.py`, `tests/test_gpu_build_manifest.py`.
- **Constants**: vendor literals `cuda|rocm`, compilers `g++|clang++`, device compilers `nvcc|clang-cuda|hipcc`; `REJECTION_MULTI_STEP`, `REJECTION_RUNNER_SYNTHESIS_LOW`, `REJECTION_INCLUDE_LINK_MISMATCH_TEMPLATE`.

### `verifier.py` (894 ln) — language-agnostic AI-output verifier

**Purpose.** Deterministic HARD GATE over AI output: no missing symbols, no new globals, stable public interfaces; rejects or auto-repairs invalid outputs before they reach compilation.

- `VerificationStatus`/`ViolationType` enums L56/L64; `Violation` L78; `VerificationFatalError` L88.
- `SymbolTable` L142 — per-language symbol extraction (`_parse_js_ts/_parse_python/_parse_rust/_parse_cpp`).
- `AIOutputVerifier` L256 — `verify()`, `verify_split_result()`, `_attempt_repair_with_caps()` bounded repair loop.
- Tuning constants: prod `MAX_REPAIR_DEPTH=1`, `MAX_REPAIR_DIFF_LINES=50`, `MAX_REPAIR_DIFF_RATIO=0.15`, timeout 5 s; dev mode 3/200/0.4/15 s.
- Factories: `get_verifier` L794 (API: structured results), `get_dev_verifier` L806, `get_prod_verifier` L827 (raises fatal on failure), `create_verifier_for_context` L848 (multi-file/refactor/quick-fix presets). Dev detection via `SYNTHI_DEV_MODE`/`NODE_ENV`/`DEBUG`.
- Callers: `main.py` (verified endpoints), `test/test_verifier.py`.

### `verifier_gpu.py` (3554 ln) — GPU no-shim verifier

**Purpose.** Enforces the GPU-HMR "no-shim" contract (ultraplan §11.4): host healers may only emit anchor edits to existing files; generated device code may not fake kernels or bypass launch indirection.

- `verify_heal_output` L435 — mechanical checks per heal tier (`compile_hard|compile_soft|runtime`); signature preservation only on soft/runtime tiers.
- `verify_split_output` L1834 — Kernel Splitter verification: non-empty `manifest_arch`, every kernel preserved, launch graph intact, ABI stamps match, no placeholder render bodies.
- Notable checks encoded in helper forest (~150 functions): shim-name heuristic `_is_shim_name` L388 (suffix disguise detection); forbidden runtime accessor regex `_FORBIDDEN_GPU_RUNTIME_ACCESSOR_RE` (`synthi_get_gpu_context…`); GUI backend presence vs. render-surface creation cross-checks; pointer-param initialization requirements; launch-bound/thread-count static evaluation (`_eval_static_int_expr` L1185); source-launch argument provenance matching; include-resolution allow-lists for generated system includes.
- Callers: `agents/kernel_splitter.py`, `agents/gpu_split_repair.py`, `agents/gpu_healer.py`; tests `tests/test_verifier_gpu.py` (2561 ln).

### `split_verifier.py` (970 ln) — structural split verifier

**Purpose.** Structural post-split checks: module boundaries, ownership of state, call graphs, hooks. *"Prompts are not a safety mechanism."*

- `SplitStructuralVerifier` L250: syntax, shared header, exports, required hooks (`core_on_load/core_on_update…`), state ownership (`CORE_ONLY_STATE_FIELDS`), memory patterns, call graph.
- `HallucinationLimits` L817 — hard syntactic/semantic limits beyond prompts; `check_hallucination_limits` L956.
- Known-symbol catalogs: `KNOWN_SDL_FUNCTIONS`, `KNOWN_STDLIB_FUNCTIONS` (+ extensible via `SYNTHI_EXTRA_SDL_FUNCTIONS`).
- Entry: `verify_ai_split(split_result, original_code, strict)` L933 raises `SplitVerificationError` when strict.

### `streaming.py` (584 ln) — token streaming

Real SSE streaming from providers with cancellation and progress. `StreamingProvider` ABC L140 with `OpenAIStreamer` L175, `GeminiStreamer` L262, `BatchFallbackStreamer` L351 (fake streaming wrapping batch calls); `StreamingManager` L401 (provider registry, fallback, active-stream tracking, metrics into `metrics.py`); `CancellationToken` L107; `StreamingProgress` L60 exposes TTFT & tokens/sec. Singleton via `get_streaming_manager` L566. Env: `OPENAI_API_KEY`, `GEMINI_API_KEY`/`GOOGLE_API_KEY`. Caller: `main.py`.

### `job_queue.py` (724 ln) — priority job queue

Multi-lane priority queue for horizontal scaling (stateless API + shared cache).

- `JobPriority` L39 (lower = higher priority), `JobType` lanes L48, `JobBudget` L57, `Job` L83 (aging/promotion logic).
- `PriorityJobQueue` L170 — separate lanes, aging loop promotes starving jobs (`AGE_THRESHOLD_SECONDS=60`, max 2 promotions/30 s cycle, starvation alert at 300 s), stats incl. RPS percentiles.
- `JobWorker` L561 — stateless worker loop; `SharedCache` L671 interface (Redis/Memcached-ready) with `InMemoryCache` L687 default.
- Singleton `get_queue` L719. Caller: `main.py` `/queue/*`; imports `metrics.py`.

### `provenance.py` (441 ln) — AI change provenance

Every AI change gets a record: prompt hash, model info, verifier outcome, accept/reject status. Types `ChangeType` L22, `PromptInfo` L43, `ModelInfo` L54, `VerifierInfo` L65, `ProvenanceRecord` L76 (`to_dict/to_json/summary`). `ProvenanceTracker` L184 stores records with SHA-256 hashing, lookup by file/session/recency + statistics + export. Singletons `get_provenance_tracker` L412, convenience `track_ai_call` L421. Served by `/provenance/*` in `main.py`.

### `program_manifest_gen.py` (68 ln)

Drafts `vectant.programs.json` from workspace key files using Gemini. Import-light (lazy provider) so unit tests inject a fake provider. `_build_prompt` L35 → fixed `_PROMPT`; `_extract_json` L41 strips fences; `generate_manifest` L56 is **fail-closed**: any provider/parse failure returns `{"error": …}` and the Next.js caller re-validates before offering/saving. Tested by `test/test_program_manifest_gen.py`.

### `program_review.py` (97 ln)

Phase-2 **advisory** risk review for community-app submissions that already passed Phase-1 hard gates + CVE scan. `assess_program_risk` L85 scores submission; fail-closed to `_FAIL_CLOSED = {risk_score: 1.0, flags: ['ai_unavailable'], …}` routing to manual review. Prompt at module level asks for security-review JSON of the sandboxed program manifest. Tested by `test/test_program_review.py`.

### `diff_patch_helpers.py` (610 ln) — edit-list prompt/validation

Extracted from main.py so unit tests don't drag FastAPI/provider imports.

- `DiffPatchRequest` L53 — tier-2 HMR request (worker diffs new source vs baseline, AI translates diff into edits).
- `validate_edit_list` L99 — shape validation → HTTP 400 on mismatch; cleans fields so the Rust worker's serde sees exactly the expected schema. Ops `{insert_after, insert_before, replace, delete}` × modules `{core, gui, shared, host_runner}`.
- `build_full_diff_patch_prompt` L176 — embeds cached ARCHITECTURE section with a PRIORITY RULE warning it may be stale.
- Manifest-heal path: `HealManifestRequest` L386, `HealManifestResponse` L431, library-agnostic `build_manifest_heal_prompt` L445 (no library names anywhere; `<name>` placeholders only), `parse_heal_manifest_response` L573.
- Callers: `main.py`, `test_phase5_diff_patch_prompt.py`, `test_phase6_manifest_heal.py`.

### `metrics.py` (795 ln) — engine-wide metrics

Thread-safe collectors consumed by streaming, queue, providers, retrieval:

- Latency/percentiles: `PercentileSamples` L54 (500-sample cap), `MetricTimer` L713, `StreamingTimer` L737 (TTFT-aware).
- `RequestTracker` L117 (RPS + peak), `ConcurrencyTracker` L162 (latency-vs-concurrency buckets `[1..128]`), `StreamingMetrics` L219, `InferenceMetrics` L268, `QueueMetrics` L309, `EnhancedRetrievalMetrics` L352 (P99 + quality), `ReliabilityMetrics` L443 (cold start).
- Facade `EngineMetricsCollector` L497 (`mark_warm`, `get_all_metrics`, `get_summary`); singletons `get_metrics_collector` L695 / `reset_metrics_collector` L703.
- Importers: `code_intel/engine.py`, `code_intel/retrieval/pipeline.py`, `job_queue.py`, `llm/providers/chatgpt.py`, `llm/providers/gemini.py`, `streaming.py`, `bench/harness.py`.

### `llm/` — prompts & providers

#### `llm/prompts.py` (4878 ln) — the prompt library

All major prompt templates + builders:

- **Split prompts**: `SPLIT_GUI_PROMPT` ("Splitter+Adapter" bot), `UNIVERSAL_SPLIT_PROMPT` (C++ HMR splitter+adapter emitting `<JSON>`/`<synthi_arch_cache>`/`<synthi_build_manifest>` blocks), `GPU_SPLIT_PROMPT` (CUDA/HIP variant with device role), `FIX_COMPILE_ERROR_PROMPT`, `STATE_MIGRATION_PROMPT`, `VECTANT_MANIFEST_REFERENCE`.
- GPU heal tiers: `GPU_HEAL_SHARED_HEADER` + `GPU_HEAL_COMPILE_PROMPT` / `GPU_HEAL_PERF_PROMPT` / runtime variants; `GPU_DIFF_PATCH_PROMPT` (edit-list output).
- Builders: `build_split_mode_prompt` L2737 (transport wrapper; split prompts own their strict response format), `build_prompt` L2758 (general analysis), `build_fullfile_prompt` L2806, `build_patch_prompt` L2844.
- Intent helpers: `_detect_query_intent` L2692 (`change|explain|unknown` via `_CHANGE_KEYWORDS`/`_EXPLAIN_KEYWORDS`), `_needs_code_changes` L2732.
- Context trimming: `_trim_file_block` L52 preserves head/tail + cursor neighborhood; `FILE_CONTEXT_MAX_CHARS=50000`.

#### `llm/providers/`

| Module | Class | Env | Notes |
|---|---|---|---|
| `base.py` | `AiProvider` ABC L67 (`_get_client`, `ask_llm`) | — | also `provider_model_provenance()` L26 for model provenance telemetry |
| `factory.py` | `get_provider(provider_name, use_custom)` L25 | — | dispatch `gemini|anthropic|openai`; None → Gemini default; missing SDK → graceful fallback |
| `gemini.py` | `GeminiProvider(AiProvider)` L354 | `GEMINI_API_KEY`, `SYNTHI_GEMINI_MODEL`, `SYNTHI_GEMINI_FALLBACK_MODEL`, `SYNTHI_GEMINI_LIVE_MODEL_CHECK`, `SYNTHI_GEMINI_PRIVATE_MODEL_ALIASES` | default model `gemini-3.1-flash-lite`; deprecated-model fallback selection with documented availability source; live model listing with 300 s TTL; tiktoken token counting; metrics hooks |
| `openai_provider.py` | `OpenAIProvider` L20 | `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `SYNTHI_OPENAI_MODEL` | optional SDK; ImportError at construction if absent |
| `anthropic_provider.py` | `AnthropicProvider` L20 | `ANTHROPIC_API_KEY`, `SYNTHI_ANTHROPIC_MODEL` | Wave-2 cross-validation provider |
| `chatgpt.py` | `ChatGPTProvider` L20 | `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_OUTPUT_TOKENS` | legacy direct path |

#### `llm/structural_prompts.py` (131 ln)

`format_heal_prompt(module, code, errors, shared, architecture, language)` L91 builds the fast HMR compile-error repair prompt. Embeds cached ARCHITECTURE block when available (degrades gracefully to generic rules otherwise). History note: the old delta-addition prompt was deliberately removed.

### `gpu_hmr/` — split-broker contracts

Contract layer over CodeIntel/RAG/build-metadata/verifier producers. Stores compact identities and lifecycle records only — it never scans sources itself.

| Module | Purpose | Key API |
|---|---|---|
| `__init__.py` (83 ln) | package doc: identity/hashing/projection helpers | — |
| `canonical.py` (242 ln) | canonical JSON hashing so hashes mean the same thing across producers | `normalize_text` L113, `normalize_workspace_path` L119 (rejects absolute/traversal paths), `canonical_json_bytes` L184, `canonical_hash` L201, `hash_many` L235; `CanonicalHashPolicy` L26 with field-level unordered-array keys; secret-key regex guard |
| `contracts.py` (287 ln) | narrow pydantic identity models, all versioned (`gpu-hmr-*-v1`) | `SelectedTargetIdentity` L79, `SourceSplitIdentity` L106, `CompileCandidateIdentity` L121, `RuntimeVerificationIdentity` L133, `AiGenerationIdentity` L144, `PromotionIdentity` L163, `CandidateSpecManifest` L225 (`.candidate_id`), `VerifierReport` L247, `AcceptedPromotionRecord` L270, `AcceptedPointer` L280; `_StrictModel.contract_hash()` |
| `metadata.py` (452 ln) | compile-aware target metadata adapter (consumes source-context report + build metadata; creates no new index) | `resolve_target_metadata` L30 → selected target identity hash, build metadata hash, toolchain identity; parses `compile_commands.json` incl. RDC/device-link mode detection |
| `projection.py` (145 ln) | packages target identity + generation + hashes into a broker projection request | `build_target_scoped_projection` L20 |
| `reason_codes.py` (101 ln) + `reason_codes.json` (1385 entries) | versioned reason-code registry | `load_reason_code_registry` L73, `assert_registered_reason_codes` L97 raises on unknown codes |
| `broker.py` (941 ln) | in-process resource ledger implementing the whole candidate lifecycle | see below |

**Broker lifecycle** (`GpuHmrBroker` L253): `readiness` → `create_projection` → `prepare_candidate` (creates job) → `verify_candidate` (kinds mapped by `VERIFICATION_KIND_TO_VERIFIER`: schema→schema, scope→role_scope, dependency, mapping, abi, …; proof-required kinds `{dependency, abi, compile, runtime}` block promotion) → `promote_candidate` (accepted pointer) / `cancel_candidate` / `diagnose_candidate`. Every mutation is idempotency-replayed (`_idempotent`, IdempotencyRecord); trace events recorded per operation with schema versions (`BROKER_TRACE_EVENT_SCHEMA_VERSION`, …). Singleton `get_gpu_hmr_broker` L936.

### `agents/` — GPU HMR agent pipeline

Package doc (`agents/__init__.py:L8`): each module is a discrete agent with strict I/O schema per GPU_HMR_ULTRAPLAN §5.6. Non-LLM agents (`gpu_detect`, classifier half of `gpu_mod_delta`, `abi_stamper`, `gpu_error_triage`) run in-process; LLM agents are invoked through the provider factory.

| Agent | Lines | Kind | Purpose |
|---|---|---|---|
| `gpu_detect.py` | 326 | deterministic | Phase-0 project scan: regex evidence for CUDA/HIP markers, vendor hint resolution (include directives win over API-hit dominance). `detect_file` L194 scores files after comment/string masking; `detect_project` L213 aggregates; `GpuDetectionResult` carries per-file evidence for splitter prompt context |
| `abi_stamper.py` | 212 | deterministic | SipHash-style keyed ABI stamps (`_HASH_KEY=b'synthi-gpu-hmr-v1'`) per kernel signature; `stamp_device_source` L46, `constant_layout_hash` L77, `write_split_meta` L93 (builds `.synthi_split_meta.json` GPU subsection); comment masking preserves offsets for parsing |
| `kernel_splitter.py` | 1767 | **LLM** | single-call 5-file GPU split. `run_kernel_splitter` L1597 = one `provider.ask_llm`; parses `<JSON>/<synthi_arch_cache>/<synthi_build_manifest>/<synthi_kernel_hashes>/<synthi_launch_graph>` blocks; tolerant file-map normalization (`_normalise_file_map` L702 unwraps nested JSON slips); deterministic repair loop `_apply_split_repairs_until_stable` L109 (max 4 passes) then `verify_split_output`; retry prompt builder `build_split_retry_prompt` L543 embeds rejection notes + remediation playbook. Exceptions map to HTTP 422: `KernelSplitterError` L212, `KernelSplitterUnsupportedProjectError` L218, `KernelSplitProviderError` L235. Env: `SYNTHI_GPU_ARCH`, `SYNTHI_GPU_ARCH_HINT`, `SYNTHI_GPU_VENDOR`, `SYNTHI_GPU_VENDOR_HINT` |
| `gpu_split_repair.py` | 3354 | deterministic | narrow source-preserving repairs before re-verification: `repair_split_artifacts` L185 (fixed-point loop), `canonicalize_source_backed_device_roles` L510 (replace AI-authored device wrappers with include bridges), launch-site reconstruction (`_repair_missing_source_launch_sites` L1884 emits `synthi_gpu_launch(...)` calls from source evidence), init-kernel buffer synthesis L2391, launch ABI/boundary/aggregate fixes, GUI render/core state ABI repair, host-runner routing repair |
| `gpu_mod_delta.py` | 1110 | mixed | worker reload-plan classification `classify_mod_delta` L342 (`host_only|device_only|mixed|abi_breaking`); GPU diff-patch prompt/validation/retry loop (`validate_gpu_edit_list` L596 allows `device` module; anchor/content failure feedback L414/L465); fission-candidate schema validation L641+ (attachment instrumentation proposals must call boundary APIs like `synthi_gpu_launch_original_host_path`) |
| `gpu_source_context.py` | 1082 | deterministic | selects which project files enter the split prompt (70 KB budget, 3 KB/file): CMake File-API parsing, template-evidence reports, graphics-backend detection, kernel-region reachability; `format_source_context_prompt` L976 |
| `gpu_device_mapping.py` | 509 | deterministic | same-kernel-name source↔generated span mappings with signature match requirement; explicit "missing mapping" so the worker can reject; `extract_kernel_regions` L206 |
| `gpu_launch_indirection.py` | 162 | deterministic | audit that generated host roles call only public `synthi_gpu_launch*` wrappers; flags bypass attempts (`launch_raw/launch_table/launch_generation`) and raw `<<< >>>` launches; stale-pointer check schema |
| `gpu_healer.py` | 127 | **LLM wrapper** | maps triage tier → `GPU_HEAL_*` prompt (`PROMPTS` dict L56), parses edit-list responses, strips JSON fences |
| `gpu_error_triage.py` | 125 | deterministic | maps diagnostics to healer tier; fatal context errors (`cudaerrorillegaladdress…`) force restart-classified handling |
| `gpu_device_markers.py` | 31 | deterministic | shared regex for project-defined device annotation macros (`DEVICE_ANNOTATION_MACRO_RE`) used by split/repair/context/verifier alike |
| `launch_graph_extractor.py` | 395 | deterministic | extracts kernel launch graph (site → kernel, args) from sources for preservation contracts |

### `analyzer/` — static + proactive analysis

#### Core

| Module | Purpose | Key API |
|---|---|---|
| `__init__.py` (55 ln) | language registry/dispatcher | `resolve_language` L33, `supported_languages` L39, `get_analyzer` L44 |
| `baseAnalyzer.py` (22 ln) | analyzer ABC | `BaseAnalyzer.analyze/identifier/all_names` |
| `AllLanguageAnalyzers.py` (777 ln) | per-language static analyzers: Python (AST visitor L685: unused imports, bare except, missing docstrings…), TypeScript (strict equality, `any`, console.log…), C++ (missing semicolons, uninitialized vars, iostream include, raw new, goto, C-style casts), C, Java (`==` on strings, raw `new`), Go (http.Get without error check, panic, global var) | regex + AST hybrid; terminators-rule bridge `_terminator_diags` L23 converts HealingFixes into diagnostics with attached CodeFix |
| `comment_masker.py` (188 ln) | mask comments preserving offsets/newlines for heuristic pipelines | `mask_comments(text, lang)` L47 |
| `utils.py` (86 ln) | shared diagnostic/CodeFix payloads | `Diagnostic.as_dict`, `make_diag` |

#### `analyzer/proactive/`

| Module | Purpose |
|---|---|
| `types.py` (560 ln) | LSP-convention enums (`Severity`, `AnalysisTier`, `DiagnosticCategory`), `Diagnostic`, `FileContext`, `TierResult`, `AnalysisResult` |
| `orchestrator.py` (331 ln) | `ProactiveAnalyzer` L44 coordinates tiers with caching + progressive streaming (`analyze_stream`) + quick path; progress events |
| `semantic_analyzer.py` (1353 ln) | deep AST analysis: Python scope/undefined/unused/unreachable/None-deref/bare-except; TS promise issues, unnecessary null-coalescing, type assertions, unused async; C++ include resolution, memory issues, smart-pointer opportunities, const-correctness. Dispatcher `SemanticAnalyzer` L1272 supports cross-file related sources |
| `ai_predictor.py` (1360 ln) | `AIErrorPredictor` L291 — LLM tier finding logic/security/concurrency bugs the cheap tiers miss; single-file + multi-file prompts, snippet re-grounding, dedup filtering |
| `cache.py` (192 ln) | content-hash-keyed LRU `AnalysisCache` L35 |
| `dependency_tracker.py` (447 ln) | import graph across py/js/css patterns; impact analysis ("what to re-analyze"), batching order; singleton `get_dependency_tracker` L445 |
| `hunk_applier.py` (81 ln) | half-open `[start,end)` line-range hunks for incremental workspace analysis; round-trip-safe splitting |
| `workspace_analyzer.py` (1006 ln) | workspace-level incremental analysis engine behind `/analyze/workspace*` |

#### `analyzer/proactive/healing/` — self-healing stack (~40 modules)

**Engine & policy**

- `engine.py` (635 ln): `SelfHealingEngine` L46 — regex mode (<50 ms rules) and AI mode; analyze / analyze_with_ai / analyze_hybrid; apply_fix with cooldowns, conflict resolution, dedup; event bus (`on_event`). Singletons L624/L632.
- `types.py`: `HealingCategory/Severity/Action`, `HealingFix` (the universal fix object), `HealingResult`, `HealingConfig`, `HealingEvent`, `HealingStats`.
- `classifier.py` (381 ln): 4-tier safety gate — micro-fixes only (`MAX_MICRO_FIX_LINES=3`), never inside strings/comments, per-fix-type safety predicates (`_is_safe_colon_fix` etc.), side-effect-aware import checks.
- `policy.py` (540 ln): organizational policy engine — `RiskClassifier` maps file patterns→risk tiers, `PolicyConstraints` hard limits, `PolicyEngine.evaluate` gates every repair action (rate limits, blocked steps).
- `config_schema.py` (97 ln): presets + validation for healing config.
- `rule_registry.py` (164 ln): decorator-based registry; all rules are "universal" (language dispatched internally). The 40+ rule files in `rules/` (brackets, imports, syntax_consistency, error_handling, security, …) each register one `@healing_rule`.

**Agentic repair loop** (diagnose → plan → execute → verify → canary)

- `diagnosis.py` (705 ln): multi-language error parsing (`ErrorParser` L168: python tracebacks, JS, go, rust, generic file:line), `DiagnosisAgent` L325 builds a `CauseGraph` (cause candidates w/ confidence, dependency tracing, recent-edit correlation, optional LLM deep diagnosis).
- `planner.py` (1083 ln): `RepairPlanner` generates ranked strategies (Plan A/B/C) per cause type (`_syntax_fix_strategy`, `_add_import_strategy`, `_merge_conflict_strategy`, `_llm_strategy`, …); `StepBudget` limits steps/time/tokens; `ToolExecutor` L839 registry; `PlanExecutor` L881 runs strategies until success with failover.
- `verification.py` (904 ln): staged post-fix proof — syntax (in-process), compile/lint/typecheck/test subprocess stages, smoke checks; `SemanticGuardrails.check_patch_safety` L767 pre-apply (minimal diff, forbidden files, dangerous APIs).
- `sandbox.py` (733 ln): ephemeral sandboxes — snapshot → patch → run commands → collect results → promote/cleanup; resource limits, stale cleanup, concurrency caps via `SandboxManager` L620.
- `rollback.py` (591 ln): transactional repair — `RepairTransaction` snapshots file states, applies atomically, rolls back with recorded `RollbackReason` taxonomy for learning.
- `repair_episode.py` (697 ln): explicit state machine DETECTED→DIAGNOSING→PLANNING→EXECUTING→VERIFYING→SUCCEEDED/ROLLED_BACK/ESCALATED with budgets (attempts/time/tokens/LLM calls), full audit trail, `EpisodeStore` L588.
- `multi_file.py` (561 ln): topologically ordered multi-file repairs with snapshots, cross-file verification, all-or-nothing rollback; `ChangeImpactAnalyzer` assesses blast radius.
- `canary.py` (539 ln): staged rollout — canary scope, soak period health checks, promote or auto-rollback (`CanaryRolloutEngine` L168).
- `runtime_healing.py` (596 ln): runtime exception ingestion (dev server/HMR/browser/node/test runners) — stack-trace parsers for V8/browser/python/go panics, fingerprint dedup with cooldowns, suppression rules, heal/suppress/escalate/defer decisions.
- `observability.py` (605 ln): metric-signal triggers — error-rate spikes, build-time regressions, HMR failure cascades, test flakiness, crash loops, log anomalies → `ObservabilityHub` dispatches to healing.
- `precision_telemetry.py` (542 ln): per-rule precision/revert-rate/confidence calibration; flags degrading rules; persisted via `get_precision_telemetry(persist_path)`.

**Failure Distiller** (evidence-backed bug reduction)

- `failure_distiller.py` (1823 ln): reduces a failing command into a logical capsule using disposable git worktrees + explicit predicate matching. Statuses `{distilled, stable_partial, not_reproducible, unstable_baseline, predicate_ambiguous, budget_*, …}`. Workspace refs are opaque `<slug>/<user-id>` anchored to `SYNTHI_REPOS_PATH`; secrets redacted from capsule evidence; oracle evidence read only from explicit `VECTANT_ORACLE:{...}` runner lines; evaluation cache per workspace; Vivarium export/promotion; approval-bound patch application with retention windows (`VECTANT_FAILURE_OBSERVATION_RETENTION_SECONDS`, `VECTANT_FAILURE_PATCH_APPROVAL_SECONDS`). Budget presets fast/standard/deep.
- `failure_distiller_adapters.py` (172 ln): typed adapter contracts (test/browser/native/hmr/gpu) normalizing observations — reducer never guesses semantics.
- `failure_distiller_execution.py` (175 ln): fail-closed execution backends — production requires OCI container (network-disabled, capability-free, image allowlist `VECTANT_FAILURE_DISTILLER_ALLOWED_IMAGES`, volume `VECTANT_FAILURE_DISTILLER_WORKSPACE_VOLUME`); local executor is fixtures-only.

**AI agent support**

- `ai_agent.py` (663 ln): `AIHealingAgent` agentic loop — context collection → detection → second-opinion validation → confidence calibration → policy gate.
- `ai_prompts.py` (464 ln): detect/validate/batch/runtime-error/focused prompt builders.
- `ai_parser.py` (357 ln): noisy-LLM-output JSON extraction; validates fixes against source (line range, original-text proximity, changed replacement).
- `ai_context.py` (408 ln): imports, same-dir related files, test-pair discovery, project hints (package.json/Cargo.toml…).
- `ai_deps.py` (197 ln): lightweight cross-file dependency graph (relative imports only).
- `ai_memory.py` (284 ln): feedback learning — accept/reject history adjusts confidence, suppresses consistently rejected patterns; optional JSON persistence.
- `ai_policy.py` (286 ln): user/team-scoped suppression store with TTL (`POLICY_PERSIST_DIR`); separate from model-quality feedback.
- `ai_prompt_cache.py` (131 ln), `cache.py` (148 ln): short-TTL result caches keyed by content hash.
- `ai_rate_limiter.py` (167 ln): async token bucket for LLM calls; `ai_retry.py` (126 ln): exponential backoff with jitter, retryable statuses {429,500,502,503,504}.
- `ai_streaming.py` (160 ln): SSE generator (progress/partial_fix/complete/error events).
- `ai_telemetry.py` (164 ln): in-memory timing/error counters.
- `batch_engine.py` (177 ln): priority-ordered concurrent batch analysis with cancel + progress callbacks.
- `lang_families.py` (111 ln): central language-family definitions (no duplicated set literals).
- `metrics_export.py` (148 ln): Prometheus text export of healing stats.

### `intelligence/` — Layer A/B/C aggregation hub

Unified pipeline aggregating three diagnostic layers into one frontend payload:

- `providers.py` (493 ln): `DiagnosticProvider` ABC L191 (`source/priority/analyze/get_code_actions`), `StaticAnalysisProvider` L259 (Layer A), `UnifiedDiagnostic` with `dedup_key`, deterministic vs generative `CodeAction`s.
- `compiler_parsers.py` (558 ln): stderr→diagnostics parsers for GCC/Clang, tsc, python tracebacks, mypy (+ more in tail).
- `compiler_provider.py` (228 ln): Layer B — actual compiler dry-runs with parsed stderr; global instance per workspace root.
- `aggregator.py` (403 ln): `IntelligenceAggregator` L63 — parallel provider execution, cross-layer dedup, AI>compiler>LSP merge priority, subscriber notification, caching; `get_aggregator` L376 / `create_aggregator_with_ai` L393.
- `file_watcher.py` (271 ln): server-side change detection fed by Y.js observers/fs watchers; debounced events + dependency registration; drives re-analysis.

### `code_intel/` — code intelligence subsystem (largest tree)

Multi-file codebase understanding: semantic chunking, dual indexing, hierarchical summaries, retrieval pipeline, editing workflow, context eviction, exploration tools, plus an independent document RAG pipeline.

#### `core/`

| Module | Contents |
|---|---|
| `types.py` (1178 ln) | foundational types: `SymbolType`, `EdgeType`, `ChunkMetadata`, `SemanticChunk` (self-describing unit; stable IDs; lazy code body), `SymbolNode/SymbolEdge` (confidence-ranked edges: LSP 1.0 > AST 0.9 > heuristic), `FileSummary/ModuleSummary`, hash-verification protocols |
| `config.py` (419 ln) | per-subsystem dataclass configs (`Parser/Indexer/Retrieval/Summary/Routing/Lsp/Context/Editing`) + `CodeIntelConfig`; env toggles: `CODE_INTEL_DEBUG`, `CODE_INTEL_DYNAMIC_BUDGETS`, `CODE_INTEL_LLM_RERANK`, `CODE_INTEL_MULTI_PASS`, `CODE_INTEL_RAG` |
| `security.py` (352 ln) | path jail (never leave workspace root), secrets redaction before returning chunks, per-workspace isolation; `SecurityBoundary` L169 |

#### `ingestion/` + `parsers/`

Walk → detect language → parse (real ASTs) → chunk. `file_walker.py` (gitignore-style ignores, hashing, changed-only walks), `language_detector.py` (extension>shebang>content confidence ladder), `normalizer.py` (whitespace/comment normalization for embedding stability), `parser_base.py` (`ParsedSymbol`, `ParseResult.to_chunks`), `chunk_extractor.py` (stable chunk IDs, module groups, test detection), `edge_extractor.py` (priority-ordered edge extraction w/ computed confidences), `import_resolver.py`. Parsers: `python_parser.py` (469 ln), `typescript_parser.py` (514 ln), `cpp_parser.py`, `go_parser.py`, `rust_parser.py`, `java_parser.py`.

#### `indexer/`

| Module | Purpose |
|---|---|
| `dual_indexer.py` (736 ln) | coordinates vector+structural indexes with file-level locks & atomic generation pointers; incremental reindex; orphan-generation cleanup; persistence |
| `embedder.py` (589 ln) | Gemini `text-embedding-004` embedder — structured embed text (symbol identity + docstring + key lines) beats raw code; batch/dedup/query caching; `LocalEmbedder` exists but policy is Gemini-only |
| `vector_index.py` (735 ln) | binary `.npz` vector store; auto-switch to HNSW at `HNSW_THRESHOLD=1000` vectors; batch API |
| `lexical_index.py` (489 ln) | BM25 over symbols/paths/docstrings/signatures; `HybridSearcher` fuses lexical+vector |
| `structural_index.py` (946 ln) | symbol graph: file→symbols, imports, callers/callees/implementors, centrality, affected-files queries, expansion limits |

#### `retrieval/`

Six-stage deterministic pipeline (the LLM never chooses its own context):

1. `query_processor.py` — intent, symbol/file-pattern/error extraction from NL query.
2. `retriever.py` — hybrid vector+BM25+symbol search with MMR dedup.
3. `graph_expander.py` — follow symbol-graph edges under hard per-module limits.
4. `ranker.py` — additive weighted factors (generic-name downranking, test penalty, namespace bonus).
5. `budget_enforcer.py` — hard token budgets with model tokenizer estimates.
6. `context_assembler.py` — hierarchical assembly (repo overview→summaries→code) with redaction.

Plus: `pipeline.py` (1366 ln orchestrator incl. fast path `/context/fast`, spec alignment, recency scores, staleness filtering, definition pull-in), `controller.py` (deterministic sufficiency/refusal decisions — "THE LLM NEVER DECIDES WHAT CONTEXT IT RECEIVES"), `reranker.py` (rule-based false-positive reduction + optional Gemini reranker), `query_rewriter.py` (conversational rewrite + HyDE variants via LLM when keyed), `fusion.py` (RRF + MMR utilities), `spec_index.py` (docs/tests-derived spec layer), `grounding_verifier.py`.

#### `editing/`

AI never edits directly: plan → conflict-check → validate → execute with backup → verify. `edit_planner.py` (structured plans, ordering), `conflict_detector.py` (external-change snapshots, overlap detection), `edit_validator.py` (line ranges, content match similarity, language syntax), `edit_executor.py` (atomic writes, rollback, index updates), `edit_session.py` (state-machine orchestration + concurrent-session manager), `symbol_diff.py` (**symbol-level**, not line-level diffs; breaking-change detection; `IndexUpdater` re-indexes only touched symbols).

#### `eviction/`

Context window management across turns: `context_tracker.py` (per-turn state, reference tracking, importance scoring), `eviction_policy.py` (LRU / importance / FIFO / hybrid strategies), `context_pinner.py` (explicit pins with reasons+TTL), `context_diff.py` (communicate what changed between turns; stabilizer minimizes churn), `drift_detector.py` (index-vs-disk drift via hashes/mtimes/signatures with auto-resolver).

#### `summaries/`, `routing/`, `tools/`, `lsp/`, `evaluation/`

- **Summaries**: deterministic file summarizers (5–8 lines each: responsibility/API/deps/side-effects), repo summarizer (architecture/entry points/subsystems/conventions, framework pattern table), facts store (subject-predicate-object triples grounded to chunk IDs), `summary_store.py` persistence + incremental manager.
- **Routing**: `QueryRouter` combines intent classification (heuristic keywords + optional Gemini), Project DNA (structure-derived routing signal), change-impact co-change neighborhoods from git history.
- **Tools**: OpenAI/Anthropic-schema tool definitions (`tool_registry.py`), safe executor (`tool_executor.py`), core explorations (`tools/tools.py`: list_files/open_file/open_symbol/search_symbol/get_callers/get_callees/get_related), and `separation.py` enforcing read-vs-edit tool categories with rate limits and refusal paths.
- **LSP**: `lsp_importer.py` ingests externally-produced LSP reference JSON into the structural index (highest-confidence edges).
- **Evaluation**: `evaluation/bench.py` recall/precision/MRR harness; `run_bench.py` CLI; `tests/test_fingerprint.py` whitespace/comment/rename fingerprint checks.

#### `code_intel/rag/` — 4-step document RAG

Independent subsystem (own config/types/exceptions/tests; PLAN.md documents design):

1. **Dual ingestion** (`ingestion/`): loader (md/txt/rst/html/code) → `toc_extractor.py` (heading trees, python/ts/c-family structures) → `section_splitter.py` (sections from ToC boundaries) → `summary_generator.py` (heuristic or LLM doc summaries); `content_hasher.py` dedup stable across CRLF/BOM/trailing-ws.
2. **Macro-retrieval** (`macro/`): query analysis (keywords/intent/entities/expansion) + BM25 keyword filter over summaries + vector `summary_searcher` fused by `document_ranker` (weighted or RRF, recency boost).
3. **Micro-navigation** (`micro/`): `tree_navigator.py` single-shot LLM picks relevant leaves of full ToC trees; section extraction via line ranges; heuristic+LLM relevance scoring; bigram/IDF reranker; page resolver maps logical→physical locations.
4. **Synthesis** (`synthesis/`): heavy-model cited answers (`answer_synthesizer.py`, streaming supported), citation tracker mapping markers→source excerpts, confidence scorer (coverage/density/grounding breakdown), token-budgeted context builder.

Stores (`store/`): document/section/ToC stores + numpy summary index — all atomic-write JSON/npz. `pipeline.py` (1927 ln) orchestrates everything incl. async ingest jobs, query cache, tracing (`observability/tracing.py` span tree). Exceptions hierarchy rooted at `RAGError`. Served under `/code-intel/rag/*` (12 routes above). Env: `RAG_DEBUG`, `RAG_ROUTING_MODEL`, `RAG_SYNTHESIS_MODEL`, `GEMINI_API_KEY`.

### `shadow/` — Synthi Genome shadow verification

**Concept**: for a user edit request, fan out N parallel "universes" (Generator+Critic+Runner in isolated git worktrees), score, arbitrate, and let the user apply the winner — never touching the live workspace until explicit apply.

#### Core pipeline

| Module | Purpose |
|---|---|
| `multiverse.py` (637 ln) | orchestrator §3–§4: tier→universe counts `{quick:1, standard:3, deep:3}`, timeouts {8/25/45 s}, convergence watch (cancel pending on 2+ agreement), arbiter invocation, counterfactual evidence capture, cost estimation vs tier ceilings ($0.001/$0.012/$0.04); provider chain cross-pairs gen/critic so critics differ from generators; `run_verify_only` skips generation |
| `universe.py` (425 ln) | one universe = Generator patch → style filter → worktree write → dep install attempt → Critic attacks → executable reproducers run → evidence bundle + LOC deltas |
| `generator.py` (229 ln) | LLM patch generator; styles `safe/idiomatic/minimalist(+research surgical)`; revise loop; language-by-extension |
| `critic.py` (287 ln) | adversarial Critic: deterministic baseline attacks + optional LLM attacks; reproducer-required schema; kinds {edge,race,type,import,logic,perf,security}; severity gating |
| `critic_critic.py` (199 ln) | pedantry filter on non-executable attacks (deterministic + bounded LLM pass ≤5 calls) |
| `arbiter.py` (646 ln) | compressed evidence bundle → distinct-provider Judge; schema-validated verdict w/ rationale-must-reference-evidence check; two-stage summarization above 8k tokens; fallback to top-score winner on any failure; `re_adjudicate` powers [Why?] |
| `proof_arbiter.py` / `selection_arbiter.py` | hard correctness gate before ranking; rank only proof-surviving branches |
| `regret_arbiter.py` (132 ln) | deterministic post-selection lessons → regret memory |
| `scoring.py` (75 ln) | composite weights: critic_survival .30, diagnostics .25, tests .20, runtime .10, style .10, loc .00 |
| `convergence.py` (121 ln) | ≥2 universes agreeing ≥0.92 similarity → skip Arbiter, emit consensus |

#### Isolation & safety

- `worktree.py` (148 ln): pre-warmed `git worktree` pool at `{repo}/.shadow/wt_{N}`; dependency-manifest detection triggers serialized installs.
- `snapshot.py` (226 ln): job-start SHA-256 snapshot; apply-time fast-path vs `git merge-file` 3-way merge vs AI rebase fallback (provider-consistent).
- `live_workspace_lock.py`: process-safe exclusive live-agent lock.
- `workspace_write_policy.py` (89 ln): protected roots (.git/.vectant/.synthi/.claude/.codex/.agents) and .env files hashed before agent runs and asserted unchanged after; targeted group-write provisioning only for non-protected entries.
- `agent_execution.py` (146 ln): hardened Docker launcher for live-workspace agents — unprivileged, resource-limited (`SYNTHI_AGENT_CPUS/MEMORY/PIDS_LIMIT`), credentials/workspace volumes separated, fail-closed construction.
- `codesite_agent_workspace.py` / `codesite_control_plane.py` / `codesite_finalizer.py`: CodeSite-managed runs — detached auditable worktrees pinned to base commit, fail-closed authority verification of scoped tokens, trusted landing gate rejecting source drift, exact reverse-patch rollback.

#### External runner adapters (counterfactual branch telemetry)

- `runner_base.py` (342 ln): adapter contract — workspace snapshot → prepare → run in isolated chamber → collect artifacts/diff/detector inputs → normalized BranchTrace; secret redaction in durable logs.
- `claude_code_runner.py` / `codex_runner.py` / `hermes_runner.py`: pluggable adapters normalizing externally produced artifacts; control plane never executes the CLIs itself.
- `runner/` per-language toolchain runners (§9): `base.py` budgets {lint 5 s, types 8 s, tests 10 s, runtime 6 s} + `detect_runner` priority; `python.py` ruff+mypy+pytest; `node.py` eslint+tsc+vitest/jest+Next dev-server probe (route mapping, 5 s boot budget); `go.py` vet/test/build; `rust.py` clippy/check/test --no-run; `html.py` htmlhint/stylelint; `syntax.py` tree-sitter parse-only fallback.

#### Counterfactual telemetry & learning

- `counterfactual_types.py` (367 ln): runner-agnostic contracts — `BranchTrace`, `DetectorResult`, `ChoiceScene`, `PolicyDelta`, `MutationTrial` (quarantined exception, never auto-applied), `BranchFossil`, phenotype/cost/latency/risk traces, ambiguity flags.
- `telemetry_repository.py` (400 ln): workspace-scoped atomic JSON document (`.vectant/counterfactual-telemetry.json`), retention-bounded (1000 runs, 200-item collections).
- `branch_trace.py` / `detector_results.py` / `choice_scene.py` / `branch_fossil.py` / `post_selection_mutation.py` / `policy_delta.py` / `execution_niche_map.py`: normalize universes into traces; detector hard-gate status; counterfactual strength; bounded fossils (no source/prompts/raw logs); non-retentive post-apply mutation summaries; delta store; niche-map aggregation.
- `preference.py` (361 ln): few-shot preference learning — rolling last-8 accepted patches per (user,repo); Jaccard-ranked few-shot injection; style affinity feeds scoring; override signals aggregate preferred/avoided providers.
- `regret_memory_markdown.py` (205 ln): compact lessons as bounded markdown (`.vectant/regret-memory.md`) with machine-readable deltas in HTML comments.
- `regression_log.py` / `cost_ledger.py` / `events.py` / `project_signals.py` / `crossover.py` / `closure_crossover.py` (Wave 5 research-only, flag-gated): accepted-patch test snapshots for regression replay; daily spend ledger with cancel credits; SSE event registry; Critic-Critic calibration signals; change-level crossover children (max 2, compile-gated); closure-aware fragment crossover.

### `shadow_continuous/` — continuous shadow (Wave 4)

Pass→fail regression watching on file saves, hard-capped at $0.50/day/workspace.

| Module | Purpose |
|---|---|
| `api.py` (78 ln) | `/shadow_continuous` routes: notify hook (collab-server bridge), state snapshot, opt-out |
| `watcher.py` (139 ln) | 800 ms per-workspace debounce collapsing bursts into one replay; findings handler registered by chat surface; no-op on opt-out or cap exhausted |
| `regression_runner.py` (125 ln) | replays regression-log entries touching changed paths in a pooled worktree; reports pass→fail transitions as `RegressionFinding`s |
| `preference_store.py` (105 ln) | workspace settings + daily spend bucket (`DAILY_SPEND_CAP_USD=0.5`, lazy day pruning); `SHADOW_STATE_DIR` override |

### `bench/` — offline evaluation harness

Master-plan §15 deliverable: tune scoring weights and validate Critic/Arbiter calibration before each promotion wave.

- `harness.py` (184 ln): runs the full shadow pipeline over `bench/corpus/` fixtures; ensures each fixture workspace is a git repo for the worktree pool; emits results JSON + report.
- `corpus/`: ~30 language/bug fixtures (py/js/ts/go/rust/html) each with `request.txt`, workspace, `seed_patches.json`, metadata; plus `failure_distiller/corpus/v1/*.json` capsule scenarios (pytest, vitest, HMR, GPU, browser).
- `metrics.py` (63 ln): summary stats (percentiles, precision/recall scaffolding). `report.py` (53 ln): markdown render with CI gates (`critic_precision ≥0.7`, `critic_recall ≥0.6`, `apply_success_rate ≥0.95`, `latency_p95 ≤14.4 s`).
- `tune_weights.py` (249 ln): grid search around base §10 weights, re-normalized; writes back the best tuple into `shadow/scoring.py` WEIGHTS literal.
- `synthi_report.py` (1325 ln): large analysis-report generator (latest bench artifacts → `synthi_report.md`).
- `bench/failure_distiller/run.py`: distiller corpus runner.

### Environment variable index (by subsystem)

**Service**: `SYNTHI_AI_ENGINE_APP/HOST/PORT/WORKERS/TIMEOUT_KEEP_ALIVE`, `WEB_CONCURRENCY`, `SYNTHI_AI_ENGINE_ALLOWED_ORIGINS`/`AI_ENGINE_ALLOWED_ORIGINS`, `AI_ENGINE_AUTH_TOKEN`/`AI_BACKEND_AUTH_TOKEN`, `AI_ENGINE_AUTH_DISABLED`, `AI_ENGINE_MAX_AI_REQUEST_CHARS`, `COLLAB_SERVER_URL`, `SPLIT_WORKSPACE_ROOT`, `ENV`.

**Providers/models**: `GEMINI_API_KEY`, `GOOGLE_API_KEY`, `SYNTHI_GEMINI_MODEL`, `SYNTHI_GEMINI_DELTA_MODEL`, `SYNTHI_GEMINI_FALLBACK_MODEL`, `SYNTHI_GEMINI_LIVE_MODEL_CHECK`, `SYNTHI_GEMINI_PRIVATE_MODEL_ALIASES`, `OPENAI_API_KEY`, `OPENAI_BASE_URL`, `OPENAI_MODEL`, `OPENAI_TEMPERATURE`, `OPENAI_MAX_OUTPUT_TOKENS`, `SYNTHI_OPENAI_MODEL`, `ANTHROPIC_API_KEY`, `SYNTHI_ANTHROPIC_MODEL`.

**GPU split/heal**: `SYNTHI_GPU_ARCH`, `SYNTHI_GPU_ARCH_HINT`, `SYNTHI_GPU_VENDOR`, `SYNTHI_GPU_VENDOR_HINT`, `SYNTHI_GPU_SPLIT_MODEL`, `SYNTHI_GPU_DELTA_MODEL`, `SYNTHI_DIFF_PATCH_PROVIDER`.

**Code intel / RAG**: `CODE_INTEL_API_KEY`, `CODE_INTEL_DEBUG`, `CODE_INTEL_REQUIRE_SLUG`, `CODE_INTEL_DYNAMIC_BUDGETS`, `CODE_INTEL_LLM_RERANK`, `CODE_INTEL_MULTI_PASS`, `CODE_INTEL_RAG`, `SYNTHI_REPOS_PATH`, `RAG_DEBUG`, `RAG_ROUTING_MODEL`, `RAG_SYNTHESIS_MODEL`.

**Healing/agentic**: `POLICY_PERSIST_DIR`, `SYNTHI_EXTRA_SDL_FUNCTIONS`, `VECTANT_FAILURE_OBSERVATION_RETENTION_SECONDS`, `VECTANT_FAILURE_PATCH_APPROVAL_SECONDS`, `VECTANT_FAILURE_DISTILLER_ALLOWED_IMAGES`, `VECTANT_FAILURE_DISTILLER_WORKSPACE_VOLUME`.

**Shadow / agents / continuous**: `SHADOW_STATE_DIR`, `SHADOW_SURGICAL_ENABLED`, `SHADOW_CLOSURE_CROSSOVER_ENABLED`, `SYNTHI_AGENT_RUNNER_IMAGE`, `SYNTHI_AGENT_RUNNER_NETWORK`, `SYNTHI_AGENT_CPUS`, `SYNTHI_AGENT_MEMORY`, `SYNTHI_AGENT_PIDS_LIMIT`, `SYNTHI_AGENT_WORKSPACE_VOLUME(_ROOT)`, `SYNTHI_AGENT_CREDENTIALS_VOLUME`, `SYNTHI_RUNTIME_SHARED_GID`, `SYNTHI_CODESITE_CONTROL_PLANE_URL`, `SYNTHI_CODESITE_AGENT_OVERLAY_ROOT`.

**Misc/dev**: `SYNTHI_DEV_MODE`, `NODE_ENV`, `DEBUG`, `SYNTHI_REPOS_PATH`, `LANG`/`LC_ALL` (distiller subprocess env).

### Test layout

- `tests/` — engine-level pytest suites mirroring subsystems: broker API/contracts/metadata/projection/reason codes (`test_gpu_hmr_*.py`), agents (`test_kernel_splitter.py` 1156 ln, `test_gpu_split_repair.py` 2339 ln, `test_gpu_mod_delta.py`, `test_gpu_source_context.py`), verifier (`test_verifier_gpu.py` 2561 ln), manifest (`test_gpu_build_manifest.py`), shadow telemetry (`test_telemetry_api.py`), runners contract, CodeSite, hunk applier/incremental HTTP e2e, OpenAPI schema smoke.
- `test/` — healing-stack suites: failure distiller (801-line suite + adapters/api/isolation/benchmark), AI agent deps/prompts/policy/streaming/telemetry, batch engine, rules registry/universal rules, HMR lightning, program manifest/review.
- Root-level phase tests: `test_phase2_unit/live.py`, `test_phase4_live.py`, `test_phase5_diff_patch_prompt.py`, `test_phase6_manifest_heal.py`, `test_universal_split_dryrun.py`, `test_include_link_validator.py`, `test_gemini_direct.py`.
- `code_intel/rag/tests/` — dedicated RAG suite (~30 files); `code_intel/retrieval/tests/test_fusion.py`; `analyzer/proactive/healing/test/`.
- Fixture corpora: `bench/corpus/`, `bench/failure_distiller/corpus/`, `tests/corpus/*.cpp` (10 C++ apps with `expected.json`).

---

## Cross-cutting observations

1. **Defense in depth is deterministic.** Every LLM output passes mechanical verification before use: `verifier.py` (symbols/globals), `verifier_gpu.py` (no-shim/signatures/launch graph), `split_verifier.py` (structure), `build_manifest.validate_manifest_v1` + include→link gate, then broker verifier kinds. Prompts are explicitly "not a safety mechanism".
2. **The worker boundary is HTTP+JSON.** The Rust worker mirrors request/response shapes exactly — e.g. edit-list fields are scrubbed so serde deserializes cleanly, and reason codes are a versioned shared registry (`reason_codes.json`).
3. **Fail-closed posture everywhere**: program review defaults to max risk; manifest gen returns errors; distiller execution requires allowlisted OCI images; CodeSite landing rejects drift; auth middleware blocks untokenized internal calls when configured.
4. **Everything is measured**: `metrics.py` central collector + healing Prometheus export + retrieval quality metrics + precision telemetry with degrading-rule detection.
5. **Cost governance**: shadow tier ceilings, $5/day shadow ledger default cap ($0.50/day continuous), cancel credits, cheapest-model routing for offers.

## Open questions / notes

- `split_verifier.py` has **zero importers** in-tree — its checks appear superseded by `verifier_gpu.verify_split_output`; confirm before removal.
- Scratch dirs (`0naokfjy/`, `mcp-counter-*/`, `vu4f06rp/`) contain runtime `.code_intel`/`.synthi` artifacts committed inside ai-engine — candidates for gitignore.
- Two provider stacks coexist: `chatgpt.py` (legacy direct) and `providers/openai_provider.py` (Wave-2 factory path).

