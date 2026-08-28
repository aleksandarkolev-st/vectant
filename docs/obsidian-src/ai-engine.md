---
title: ai-engine — Service Analysis
source: ai-backend/ai-engine
repo: vectant-ade
analyzed: 2026-08-25
tags: [vectant-ade, ai-engine, fastapi, llm, gpu-hmr, architecture]
---

# ai-engine (`ai-backend/ai-engine`)

> Python FastAPI service at the heart of Synthi/Vectant. It is the **AI orchestration tier**: every LLM call the product makes (analysis, refactoring/splitting, healing, GPU hot-reload generation, code-intelligence routing, shadow verification) goes through this service. Header comment: *"PROTOTYPING AI ENGINE WITH PYTHON, LATER SWITCH TO RUST"*.
>
> ~146k lines of Python across ~250 files. Stateless with respect to user data by design (safe to scale horizontally); all mutable state lives in-process caches/ledgers or is delegated to the Rust worker and collab-server.

---

## 1. Role in the Monorepo

```
vectant-ade/
├── backend/collab-server/   # Node: workspaces, Y.js CRDT, file persistence (source of truth on disk)
├── backend/worker (Rust)    # compile dispatch, HMR runtime, calls INTO ai-engine over HTTP
├── ai-backend/
│   ├── gateway/             # edge gateway
│   ├── agent-runner/
│   └── ai-engine/           # ← this service (port 8000, uvicorn)
├── mcp/synthi-mcp/          # agent-facing MCP tool server (drives compile/HMR/screenshots)
└── docs/                    # AI_HMR_SYSTEM_REFERENCE.md, GPU_HMR_IN_DEPTH_FLOW.md, ...
```

The Rust worker is the primary client: it POSTs source to `/refactor/split`, `/refactor/split/gpu`, `/refactor/diff_patch*`, `/refactor/heal*`, receives generated files + a build manifest + verification reports, then compiles/runs/hot-reloads. ai-engine never compiles or runs user code itself.

**Key docs consulted:** `docs/AI_HMR_SYSTEM_REFERENCE.md` (host HMR runtime: supervisor/worker process isolation, ABI fingerprinting, MsgPack state migration), `docs/GPU_HMR_IN_DEPTH_FLOW.md` (end-to-end GPU path incl. honest "what's proven" ledger), `docs/AI_SYSTEM_ARCHITECTURE.md` (CodeIntel storage-tier blueprint).

---

## 2. Runtime & Deployment

| Piece | Detail |
|---|---|
| Entry | `run_server.py` → `os.execvp("uvicorn", …)` on `main:app`; env knobs `SYNTHI_AI_ENGINE_APP/HOST/PORT/TIMEOUT_KEEP_ALIVE`, workers from `SYNTHI_AI_ENGINE_WORKERS` else `WEB_CONCURRENCY`. |
| Deps | `requirements.txt`: fastapi 0.115.6, uvicorn 0.34.0, google-generativeai 0.8.4, python-dotenv, requests, numpy, tiktoken 0.8.0. (anthropic/openai SDKs are optional, imported lazily.) |
| Dockerfile | Two-stage python:3.10-slim build (wheels prebuilt, compiler removed). Installs docker.io/docker-cli/git into the image (worker-style operations). Runs as uid/gid **1001** to match collab-server ownership of `/data/repos` — otherwise CodeIntel 500s writing `.code_intel` indexes. `CMD ["python", "run_server.py"]`, exposes 8000. |
| Config | `.env` loaded from module dir (`load_dotenv(…, override=False)`). Provider/model selection via env: `OPENAI_API_KEY/BASE_URL`, `SYNTHI_SPLIT_PROVIDER/MODEL`, `SYNTHI_GPU_SPLIT_MODEL`, `SYNTHI_GPU_ARCH_HINT`, `SYNTHI_DIFF_PATCH_PROVIDER`, etc. |

### Middleware stack (in `main.py`)
1. **`log_requests`** — one-line per request `[AI-ENGINE] METHOD path -> status (t)`.
2. **`require_internal_auth`** — shared-secret gate: `x-synthi-internal-token` header or Bearer token compared with `hmac.compare_digest` against `AI_BACKEND_AUTH_TOKEN`/`AI_ENGINE_AUTH_TOKEN`. Missing token → **503**; wrong → 401. Can be disabled via `AI_ENGINE_AUTH_DISABLED=true` but **only when `ENV != production`**. `/health` and CORS preflight are public.
3. **CORS** — origins from `AI_ENGINE_ALLOWED_ORIGINS` (default localhost:3000, beta.vectant.dev).

### Input hygiene (before any model call)
`enforce_ai_request_limits()` strips control chars, rejects jailbreak-marker phrases ("ignore previous instructions", "dan mode", …) with HTTP 400, and enforces `AI_ENGINE_MAX_AI_REQUEST_CHARS` (default 32 768) across code+prompt+files with 413. Workspace paths are validated POSIX-relative with traversal protection (`resolve_under_workspace`). Container-first analysis fetches file content itself from collab-server `/file-content/{slug}/{path}` so the model always sees exactly what's on disk.

---

## 3. Endpoint Surface (~166 routes)

`main.py` alone declares **105 routes**; four mounted routers add the rest:

| Router | Prefix | Routes | Purpose |
|---|---|---|---|
| `main.py` | `/` | 105 | analysis, refactor/split/heal, GPU variants, queue, provenance, programs |
| `code_intel/api.py` | `/code-intel` | 15 | indexing, context assembly, tools, edit planning |
| `gpu_hmr/api.py` | `/gpu-hmr` | 15 | split-broker contract API (identity/projection/candidate lifecycle) |
| `shadow/api.py` | `/shadow` | 8 | multiverse shadow verification runs |
| `shadow/telemetry_api.py` | `/counterfactual` | 20 | counterfactual telemetry, niche maps, mutation trials |
| `shadow_continuous/api.py` | `/shadow_continuous` | 3 | save-event triggered regression watch |

### Route families

- **Analysis** — `/classify/intent`, `/analyze/static`, `/analyze/proactive(/quick)`, `/analyze/container`, `/analyze/unified`, `/analyze/workspace(/incremental)`, `/analyze/ai`, `/analyze/ai/verified`.
- **Refactor/split (host)** — `/refactor/split`, `/refactor/split_file`, `/refactor/split/verified` (universal 4-file split + `<synthi_build_manifest>` extraction/validation), `/refactor/diff_patch`, `/refactor/heal`, `/refactor/heal/manifest` (link-error manifest heal).
- **GPU pipeline** — `/refactor/split/gpu` (Kernel Splitter Agent), `/refactor/diff_patch/gpu` (device-role edits + reload_plan), `/refactor/heal/gpu` (compile/perf/runtime tiers), plus the whole `/gpu-hmr/*` broker API.
- **Host self-healing** — ~60 routes under `/heal/*`: rule engine (`/heal/batch`, presets, metrics, config), AI healing (`/heal/ai/analyze|runtime|batch|hybrid|stream|preview|project|feedback`, policy suppress lists, memory), and **agentic healing** (`/heal/agentic/distill/*` — Failure Distiller capsules incl. vivarium export/promote/validate-patch/request-apply/apply-approved; episodes, guardrails, canary, calibration/degrading telemetry, observability ingest).
- **Infrastructure** — `/queue/submit|status|cancel|stats`, `/provenance/{record}`, `/health`, `/` (feature banner).
- **Programs marketplace** — `/programs/risk-review` (advisory residual-risk LLM score, fail-closed), `/programs/generate-manifest`.

---

## 4. LLM Layer (`llm/`)

### Providers (`llm/providers/`)
- `factory.get_provider(name=None, use_custom=False)` → `'gemini' | 'anthropic' | 'openai' | chatgpt`; unknown name or missing optional SDK logs a warning and **falls back to GeminiProvider** (never crashes the path).
- `base.AiProvider` ABC: `_get_client()`, `async ask_llm(code, lang, prompt, mode=…, request_mode=…)`; helpers `provider_model_provenance()` attach `last_call_metadata` (`actual_model`, `fallback_used`) that endpoints surface as `model_provenance`/`model_role` in responses.
- `gemini.py` (639 LOC): tiktoken cl100k counting, **global `asyncio.Semaphore(1)`** so concurrent Gemini calls can't race quota into DeadlineExceeded; model-list driven fallback selection (`_select_fallback_model_name` ranks by family-token overlap, stable-over-preview, version tuple); availability metadata sourced from Google deprecations page.
- `chatgpt.py` uses AsyncOpenAI (legacy direct key path); `openai_provider.py`/`anthropic_provider.py` exist for Wave-2 cross-validation of the shadow system.

### Prompts (`llm/prompts.py`, 4 878 LOC — largest file in the tree)
- `build_prompt / fullfile / patch / split_mode_prompt` builders with intent sniffing (`_CHANGE_KEYWORDS` vs `_EXPLAIN_KEYWORDS`); multi-file context blocks trimmed head+tail to 50 k chars.
- `UNIVERSAL_SPLIT_PROMPT` — library-agnostic C++ 4-file split (shared/core/gui/host_runner) emitting `<JSON>{files}</JSON><synthi_arch_cache>…<synthi_build_manifest>{…}</synthi_build_manifest></synthi_arch_cache>`; embeds HotApi v2 lifecycle ABI, ZERO-HALLUCINATION / MALLOC-PROHIBITION / MEMSET-PROHIBITION rules and an include→link rule.
- `GPU_SPLIT_PROMPT` — adds the fifth **device role** (single device TU → sidecar `cubin`/`hsaco`), fixed extern-"C" lifecycle symbols (`core_on_load(prev_state, renderer)`, `gui_on_load(...)`, `core_on_update`, `gui_on_render`), explicit "every fragment is a structural template; example identifiers are not project facts" anti-hardcoding clause; inherits all host rules.
- `GPU_DIFF_PATCH_PROMPT`, `GPU_HEAL_{COMPILE,PERF,RUNTIME}_PROMPT` (triage-selected tier prompts).
- `structural_prompts.py` documents deleted SDL-hardcoded prompt generations as history — the codebase deliberately migrated to architecture-cache-driven routing instead of library-name routing.

---

## 5. GPU HMR Pipeline (the flagship flow)

End-to-end (per `docs/GPU_HMR_IN_DEPTH_FLOW.md`): ordinary CUDA/HIP source → browser/MCP compile request → worker detects GPU markers → `POST /refactor/split/gpu` → ai-engine generates split + manifest → deterministic verifiers reject bad splits → worker compiles host modules + device sidecar → later device-only edits recompile just the device role → runner hot-swaps cubin/hsaco with host state intact.

### 5.1 `/refactor/split/gpu` orchestration (main.py)
1. `gpu_detect` (regex, no LLM) must report GPU markers, else **422**.
2. Up to **3 attempts** through `kernel_splitter.split_kernel_project` with rejection notes fed back via `build_split_retry_prompt` (+ remediation playbook + verifier acceptance-gate contract text). Distinct exception classes → distinct HTTP semantics: unsupported project shape → 422 with reason codes; provider failure → 503/504; unparseable response → retry then 422.
3. Every attempt recorded in an **agentic_report** (`schemaVersion: synthi.gpu.split_repair.v1` style records: attempt#, model, repair_prompt flag, repair_report, violations).
4. On acceptance: manifest normalized (`normalize_gpu_split_manifest` with link hints from source files, vendor/arch hints), parsed + `validate_manifest_v1`, generated artifacts **internalized** (paths rewritten under `.synthi/gpu_hmr/candidates/<id>/`), then two deterministic reports attached:
   - `device_mapping_report` — source→generated mapping for the device role,
   - `launch_indirection_report` — proof every host launch goes through `synthi_gpu_launch(...)` with launch metadata + source provenance.
5. Response includes `result` (raw JSON string — worker parses it as string), `architecture`, `manifest`, `kernel_hashes`, `launch_graph`, `source_context_report`, `gpu_detection`, model provenance, `verification`, `elapsed_seconds`.

### 5.2 Deterministic agents (`agents/`)
| Module | Role |
|---|---|
| `gpu_detect.py` | Phase-0 regex detector + vendor hint; no LLM, no tree-sitter. |
| `gpu_source_context.py` (1 082 LOC) | Target-scoped source selection: drop reasons for vendor/generated/build-metadata files, kernel-declaration reachability, compile_commands.json parsing, graphics-backend report. |
| `kernel_splitter.py` (1 767 LOC) | Single LLM call → `KernelSplitResult(files, manifest, arch_md, kernel_hashes, launch_graph, verification, repair_report)`; retry-prompt builder; structural escape decoding for embedded sources. |
| `gpu_split_repair.py` (3 354 LOC) | Narrow **source-derived** repairs on generated roles only (SDK type redeclaration removal, host_runner GUI routing fix, OpenGL include ensure, state-type replacement…) — explicitly no fixture/symbol-specific rules; `canonicalize_source_backed_device_roles` re-derives device semantics from real project sources. |
| `verifier_gpu.py` consumers | see §6. |
| `abi_stamper.py` | 64-bit ABI stamps over normalized kernel param lists (keyed BLAKE2b standing in for SipHash-2-4). |
| `launch_graph_extractor.py` | Backstop extractor for both raw `<<<>>>` launches and `synthi_gpu_launch(...)` calls. |
| `gpu_launch_indirection.py` | Machine-readable report of the launch-indirection contract for the worker sidecar. |
| `gpu_error_triage.py` | Mechanical triage of diagnostics into healer tiers (compile_hard / compile_soft / runtime) + `requires_restart` classification off known fatal error kinds. |
| `gpu_healer.py`, `gpu_mod_delta.py` | Heal prompt/parse wrapper; GPU edit classifier + diff-patch helpers (reload_plan ∈ {device_only, core_gui, full_restart…}). |

### 5.3 Contract broker (`gpu_hmr/`) — the "split-broker"
An in-process **resource ledger** over identities, deliberately *not* a second index/RAG:

- `canonical.py` — canonical JSON hashing policy (`GPU_HMR_IDENTITY_POLICY`): field-level normalization only where declared (path keys, source-text keys, unordered arrays, env allowlist). Hashes mean the same thing across producers.
- `contracts.py` — strict pydantic models: `SelectedTargetIdentity`, `SourceSplitIdentity`, `CompileCandidateIdentity`, `RuntimeVerificationIdentity`, `AiGenerationIdentity`, `PromotionIdentity`, `RoleScopePackage`, `RoleGenerationPackage`, `SourceToGeneratedMapping`, `CandidateSpecManifest`, `VerifierReport`, `CandidateVerificationRecord`, `AcceptedPromotionRecord`, `AcceptedPointer`.
- `reason_codes.json` — **138 registered reason codes** (target resolution, metadata probes, candidate staleness, verifier.proof_unavailable, …). `assert_registered_reason_codes` makes unknown codes a hard error anywhere they're emitted — closed-vocabulary discipline for machine-readable rejections.
- `broker.py` (941 LOC) — thread-safe (RLock) store with idempotency keys, trace events per job, schema-versioned resources. Lifecycle: `readiness → create_projection → prepare_candidate → verify_candidate → promote_candidate | cancel | diagnose`, jobs queryable via `/jobs/{id}/trace`, current accepted artifact via `/accepted/current`.
- **Fail-closed by construction:** `_run_verifier` returns `status="fail", blocking=True, reasonCodes=["verifier.proof_unavailable"]` for any `PROOF_REQUIRED_KINDS = {dependency, abi, compile, runtime}` because the broker has no local proof producers yet — those must be supplied by external verifiers (the live ROCm worker). Only cheap local checks run in-process (schema: role paths present + internalized under the candidate prefix; scope/mapping hashes present). Promotion requires monotonic verified-state ranking (`schema < compile < runtime_verified_candidate`).
- `metadata.py` / `projection.py` — adapters consuming the existing source-context report + build metadata to produce compact target projections (never copying source trees).

---

## 6. Verification Stack (three verifiers, layered)

1. **`verifier.py` (894 LOC)** — generic AI-output verifier: symbol tables, missing-symbol/new-global/public-interface checks, bounded auto-repair (prod caps: depth 1, ≤50 changed lines, ≤15 % diff, 5 s timeout; dev mode raises caps but stays bounded). Statuses pass/warn/fail/repaired feed provenance.
2. **`split_verifier.py` (970 LOC)** — hard structural gate for splits: syntax, exports/imports, call-graph completeness, state ownership, cross-module access patterns, ABI signature conformance. Docstring thesis: *"Prompts are not a safety mechanism."*
3. **`verifier_gpu.py` (3 554 LOC)** — enforces the **no-shim contract** mechanically (Ultraplan §11.4):
   - `no_file_creation` — edits may only touch manifest-listed modules;
   - `no_wrapper_kernel` — new `__global__` names that look like `_safe/_v2/_fallback/safe_` extensions are rejected;
   - signature preservation on Tier 2/3 heals unless the host launch site is patched in the same diff;
   - `no_extra_device_tu` — single device translation unit;
   - split-path checks: every launch rewritten to `synthi_gpu_launch(...)` with declared kernels and non-empty `gpu.arch`;
   - plus a deep static-analysis arsenal (comment-masked parsing, dim3/thread-count evaluation, pointer-param tracking, namespace/shared-symbol usage checks, record-type field analysis) used to validate state-cast consistency between core/gui/device roles.
   
   Rejections are structured `Violation(rule, message)` lists that get appended to `previous_heal_attempts` for the next LLM attempt — never silent drops.

Supporting: `build_manifest.py` (1 670 LOC, 49 functions) — pydantic manifest schema v1, include→link coverage enforcement against the user's actual `#include`s, GPU-artifact internalization, manifest normalization for GPU splits.

---

## 7. Infrastructure Modules (root)

| Module | What it does |
|---|---|
| `job_queue.py` | Multi-lane priority queue: `JobPriority` CRITICAL→BULK, lanes STATIC/AI_ANALYZE/AI_REFACTOR/AI_GENERATE with default budgets (e.g. refactor: 60 s / 8 192 tokens / 2 retries). **Aging loop** promotes starving jobs after 60 s (max +2 levels), alerts past 300 s. Pluggable `SharedCache` (in-memory impl shipped). Stats: percentiles, RPS, aging stats. |
| `streaming.py` | `StreamingManager` + OpenAI/Gemini streamers with cancellation, partial-failure (`PARTIAL` status), chunk timestamps, TTFT capture. |
| `provenance.py` | Every AI change gets a record: ChangeType, PromptInfo (system-prompt hash), model info, output hash, verifier verdict, accept/reject decision. Endpoints expose per-record/per-file/stats queries. Verifier statuses map onto provenance statuses (`pass→passed`, `warn→warned`, …). |
| `metrics.py` (795 LOC) | Latency (TTFT/full/queue delay), throughput, retrieval quality (Recall@k, MRR), reliability, latency-vs-concurrency buckets (500-sample ring buffers). |
| `diff_patch_helpers.py` | Phase-5 four-module edit contract (`core|gui|shared|host_runner`) + anchor/content validators; hosts the ULTRAPLAN Phase-6 manifest-heal schema (undefined-reference → AI-updated link flags → single retry). Extracted from main.py for testability. |
| `program_review.py` / `program_manifest_gen.py` | Community-app submission advisory risk score (fail-closed to max risk) and vectant.programs.json drafting. |
| `vectant_repro.py` | Operator CLI for Failure-Distiller capsules (`python vectant_repro.py repro run .vectant/capsules/x`). |
| `MULTI_FILE_GUIDE.txt` | Spec for the `files[]` multi-file context payload. |

---

## 8. Code Intelligence (`code_intel/`) — biggest subsystem

Seven-subsystem engine (`engine.py`): ingestion/normalization → dual index (vector + structural) → hierarchical summaries → query-time context assembly → tool-driven exploration → eviction/stability → editing workflow. Mounted at `/code-intel` (index, index/file(+delete/rename), context, context/fast, edit-impact, tools/definitions|execute, summary/repo|file, metrics, edit, save/load).

- `rag/pipeline.py` (1 927 LOC) + `retrieval/pipeline.py` (1 366) — chunked RAG with micro/tree navigation, TOC extraction, fusion + graph expansion + grounding verification + budget enforcement, reranking.
- `indexer/` — dual indexer, vector index (embedder), lexical index, structural index (946 LOC).
- `routing/` — intent classifier (also drives `/classify/intent`), change impact, "project DNA".
- `editing/` — plan/session/validator/conflict detection/symbol diff; `tools/` — find-callers-class exploration tools exposed to models.
- Workspace slug resolution (`resolve_workspace_path`) maps frontend slugs → `{project_root}/backend/collab-server/repos/{slug}`; `CODE_INTEL_REQUIRE_SLUG` can forbid absolute paths.
- Indexes persist into `<workspace>/.code_intel` (hence the uid-1001 Dockerfile fix). Generation id (`cm/.code_intel_current_gen.txt`) feeds GPU-HMR staleness codes (`candidate.stale_codeintel_generation`).

Related: `intelligence/` — Layer A/B/C diagnostic aggregation: LSP + real compiler dry-run providers (`compiler_parsers.py` regex parsers per compiler, `compiler_provider.py`), server-side file watcher, unified `aggregator.py` hub.

---

## 9. Analysis & Healing (`analyzer/`)

- `analyzer/AllLanguageAnalyzers.py` (776 LOC) + `baseAnalyzer.py` + `comment_masker.py` — per-language static analyzers behind `/analyze/static`.
- `analyzer/proactive/` — tiered proactive analysis: `workspace_analyzer` (multi-file coordinator w/ incremental updates, dependency tracking), `semantic_analyzer` (1 353), `ai_predictor` (1 360 — issue prediction before compile), orchestrator + cache (2 000 entries / 1 h TTL shared with main.py).
- `analyzer/proactive/healing/` — the rule-based + AI healing engine: classifier, planner, diagnosis, sandbox (733), rollback, verification (904), observability, redaction, multi-file, batch engine, canary, policy + AI-specific plumbing (prompts, prompt cache, rate limiter, retries, streaming, telemetry, memory).
- **Failure Distiller** (`failure_distiller.py`, 1 823 LOC): evidence-backed testcase reduction into auditable "capsules" — disposable git worktrees, explicit predicate oracle, only removes declared file/env units; adapters normalize pytest/Vitest observations; execution + vivarium promotion paths back the `/heal/agentic/distill/*` endpoint family (including `request-apply`/`apply-approved` human-in-the-loop application).

---

## 10. Shadow Verification — "Synthi Genome" (`shadow/`, `shadow_continuous/`)

A parallel-universe verification lab for AI-generated patches:

- `/shadow/run` fans out N universes (LLM runners incl. hermes/codex/claude-code runners) over git worktrees (`worktree.py`, pool + dep-install lock), streams progress via SSE (`/{job_id}/stream`), supports verify-only mode, apply-and-cancel, `why` explanations.
- `multiverse.py` orchestrates convergence detection, crossover/closure-crossover children, then **arbiters** decide: `arbiter.py` (evidence bundles, model selection), `proof_arbiter.py`, `regret_arbiter.py`, `selection_arbiter.py`, `critic.py`/`critic_critic.py` (executable reproducers).
- Economics: `cost_ledger.py` daily caps with up-front debits and refunds; `/cost/state`, `/cost/cap`.
- Memory: counterfactual store, regret memory (markdown), preference learning, regression log, policy deltas (with contradict/veto endpoints), niche maps + forecast directions, mutation trials (post-selection mutation), codesite control plane/finalizer for agent-workspace experiments.
- Telemetry API at `/counterfactual` (20 routes) persists runs/branches/detectors/selection/mutation-trials; `DELETE /telemetry` wipes it.
- `bench/` — harness + corpus + `synthi_report.py` (1 325 LOC) scoring the shadow pipeline against a corpus (`python -m bench.harness --corpus bench/corpus --out bench/report.md`), plus weight tuning (`tune_weights.py`).
- **Continuous shadow** (Wave 4): `POST /shadow_continuous/notify` on file-save → 800 ms debounce/workspace → identify changed modules → replay regression-log tests in a pooled worktree → suggest only genuine pass→fail transitions. Hard $0.50/day/workspace spend cap, per-workspace opt-out, cheapest models for offers.

---

## 11. Tests

Two trees: root-level phase scripts (`test_phase2_unit/live.py`, `test_universal_split_dryrun.py`, `test_include_link_validator.py`, `test_gemini_direct.py`, …) and `tests/` (56 files, e.g. `test_verifier_gpu.py` 2 561 LOC, `test_gpu_split_repair.py` 2 339, `test_kernel_splitter.py`, `test_gpu_source_context.py`, `test_gpu_detect/device_mapping/mod_delta/build_manifest`, shadow/counterfactual suites, `corpus/`). Plus `code_intel/tests` and `analyzer/proactive/healing/test/` locally scoped suites. `test/` holds older suites (`test_failure_distiller.py`, `test_agentic_healing.py`).

---

## 12. Cross-Cutting Design Themes

1. **Determinism around the LLM.** Every model call is wrapped by deterministic pre/post machinery: detection before prompting, mechanical verification after, bounded auto-repair, structured rejections with stable rule ids. "Prompts are not a safety mechanism" is load-bearing doctrine.
2. **Fail-closed identity contracts.** gpu_hmr canonical hashing + 138-code reason registry + idempotency keys make every lifecycle decision reproducible and auditable; missing proof is a first-class outcome (`verifier.proof_unavailable`), never an assumed pass.
3. **No hardcoding drift.** Deleted SDL-era prompt generations are documented; anti-hardcoding clauses are written directly into GPU prompts ("example identifiers are not project facts"); repairs must be source-derived.
4. **Provenance everywhere.** Prompt hashes, model fallback provenance, verifier verdicts, accept/reject decisions are recorded and queryable per change.
5. **Honest capability ledger.** Docs and reports distinguish proven claims (GPU compute HMR, HIP pixel gen, SDL copyback display on RX 9070 XT) from unproven ones (zero-copy interop, direct framebuffer).

## 13. Observed Risks & Quirks

- **`main.py` is a 4 853-line god-module** holding 105 routes; router extraction exists for the newer subsystems but not for analyze/refactor/heal families. Diff-conflict surface is large (relevant given multi-agent workflows on this repo).
- **Auth bypass flag**: `AI_ENGINE_AUTH_DISABLED=true` disables auth whenever `ENV` ≠ production — safe-ish, but a forgotten `ENV` in a staging deploy silently opens the service.
- **Global Gemini semaphore(1)** serializes all Gemini traffic service-wide — deliberate quota protection, but a throughput ceiling and a potential head-of-line blocker under concurrency.
- **Silent provider fallback**: unknown provider names and missing SDKs fall back to Gemini with only a log line — a caller asking for openai could unknowingly get Gemini (mitigated somewhat by `model_provenance` fields in responses).
- **Broker shell verifiers**: dependency/abi/compile/runtime verification in `gpu_hmr/broker.py` always fails closed pending external proof producers — correct posture, but means the contract API is only as useful as the wired-up worker-side verifiers.
- **Junk artifacts**: empty stray dirs `0naokfjy/`, `vu4f06rp/`, `mcp-counter-1776526851287/` (looks like leaked temp dirs) sit in the package root; `cm/` contains only a code-intel generation stamp.
- **In-memory everything**: queue stats, provenance, broker ledger, cost ledgers reset on restart — fine for the stateless scaling story, but operators should know `/provenance` history is ephemeral per instance.

## 14. Related Notes

- [[AI-HMR System Reference]] — host-side supervisor/worker HMR runtime this service feeds.
- [[GPU HMR In-Depth Flow]] — end-to-end GPU path + live-validation evidence.
- [[AI System Architecture]] — CodeIntel storage-tier blueprint implemented by `code_intel/`.
