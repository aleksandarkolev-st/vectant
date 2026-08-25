---
title: "Area — GPU HMR Pipeline (File-Level Analysis)"
tags: [vectant-ade, area, gpu-hmr, hmr, rocm, hipcc, gfx1201, dual-slot, proof-ledger, fission]
source-repo: C:/Users/polek/Desktop/hermes-abuse/vectant-ade
analyzed: 2026-08-26
status: file-level reference — every file in scope covered
companion: "[[gpu-hmr]] (system-level analysis)"
---

# Area — GPU HMR Pipeline (File-Level)

This note is the **file-level** companion to [[gpu-hmr]]. Where that note explains the
system, this one walks every file the GPU HMR pipeline touches, grouped by pipeline
stage, with `path:Lnnn` references and the exact data shapes that cross each boundary.

Scope (four surfaces, one pipeline):

1. **Python engine** — `ai-backend/ai-engine/gpu_hmr/` (9 files), plus
   `verifier_gpu.py`, `split_verifier.py`, and `agents/gpu_*.py`.
2. **MCP layer** — `mcp/synthi-mcp/src/hmr.ts`, `gpu_proof.ts`, `gpu_proof_ledger.ts`,
   and the tool that consumes them (`src/tools/wait_hmr.ts`).
3. **Rust worker** — `backend/synthi-webrtc-compiler/worker/src/hmr/` (129 files,
   enumerated below), plus the adjacent compile stage
   `worker/src/compiler/stages/compile_device.rs` where hipcc is actually spawned.
4. **Proof harnesses** — `mcp/synthi-mcp/scripts/**` driven by the `proof:*` npm
   scripts, plus repo-root `scripts/start-gpu-stack.*`.

> Hard invariants that shaped this code (see AGENTS.md): **no hardcoding** (names,
> suffixes and closed enums may never become acceptance authority), **proof is not
> logs** (visual work needs decoded before/after/diff bytes bound to identity;
> compute work needs raw readback bytes + schema + checksums), and **fail-closed**
> (missing evidence is a precise gap, never a silent fallback). Every design quirk
> below traces back to one of these.

---

## 0. Pipeline at a glance

```
 Monaco edit / MCP agent
        │  CompileRequest (JSON over WebRTC data channel)
        ▼
 [Rust worker compiler/handler.rs]
        │  detect GPU markers ──► POST /refactor/split/gpu (ai-engine)
        │                              │  KernelSplitterAgent + verifier_gpu.py
        │                              ▼
        │                      split sidecar .synthi_split_meta.json
        │                      { compile_manifest{gpu:GpuBuildBlock}, roles, baselines }
        ▼
 compile stages: host g++/clang++ (core/gui/shared/host_runner)
                 + compile_device.rs ► nvcc --cubin | hipcc --offload-device-only/--genco
        │                          │
        │   device-only edit?      ▼ hsaco/cubin sidecar artifact
        ├─► gpu_device_fast_path.rs (deterministic body patch, no AI)
        │         or gpu_mod_delta AI path → fission candidates
        ▼
 gpu_prod_contracts.rs  normalize sidecar → reload_plan.v1 → ranked options → arbiter
        │                (warm_rebuild | device_only | ai_delta | cold_restart |
        │                 full_resplit | unsupported) + reason codes
        ▼
 GpuModuleAdapter.reload():  drain streams → load standby → resolve kernels →
        │                    install launch dispatcher → EPOCH PUBLISH → probe →
        ▼                    UNLOAD RETIRED → EPOCH RETIRE
 GpuModuleManager (dual-slot: primary + standby + partials)
        │
        ▼
 proof telemetry → gpu_proof.rs / gpu_proof.ts → wait_hmr tool → proof ledger v1
                  → adversarial self-checks → validation-matrix ledger
```

Stage-by-stage data shapes are pinned down in [[#5-Cross-stage-data-shapes]].

---

## 1. Python engine — `ai-backend/ai-engine`

### 1.1 Package `ai-backend/ai-engine/gpu_hmr/` — the acceptance broker

A small FastAPI-mountable package that implements the *server-side* candidate
lifecycle: project → projection → candidate → verify → promote. Everything is
hash-addressed and idempotent; nothing trusts the caller's claims.

**`gpu_hmr/__init__.py`** (83L) — exports the public contract models
(`SelectedTargetIdentity`, `CandidateSpecManifest`, …) so both the API layer and the
broker import from one place.

**`gpu_hmr/api.py`** (195L) — thin HTTP surface over the broker:
`POST /readiness`, `/projection`, `/candidate` (prepare), `/candidate/{id}/verify`,
`/promote`, `/cancel`, `/diagnose`, plus job introspection (`get_job`,
`get_job_trace`, `cancel_job`) and `GET /accepted/current`
(`api.py:L109-L193`). Request bodies are pydantic `_StrictModel`s
(`api.py:L25-L91`): `ReadinessRequest`, `ProjectionRequest`,
`PrepareCandidateRequest`, `VerifyCandidateRequest`, `PromoteCandidateRequest`,
`IdempotentRequest`. Every response passes through `_response()`/
`_handle()` (`api.py:L93-L106`) which converts `BrokerError` payloads into typed
error cards rather than stack traces.

**`gpu_hmr/broker.py`** (941L) — the heart. `GpuHmrBroker` (`broker.py:L253`) keeps
in-memory registries of `ProjectionRecord` (`:L146`), `CandidateRecord` (`:L179`),
`JobRecord` (`:L222`) and `IdempotencyRecord` (`:L247`). Lifecycle:

- `create_projection` → `_create_projection_unlocked` (`:L444`) canonicalizes target
  metadata into a `ProjectionRecord` whose `projection_hash` is computed by
  `canonical.canonical_hash` — identical inputs collapse to the same row.
- `prepare_candidate` → `_prepare_candidate_unlocked` (`:L493`) builds a
  `CandidateSpecManifest` from role packages, validates generated role paths
  (`_validate_generated_role_paths`, `:L893` — traversal/symlink/absolute-path
  rejection feeding the `generated.*_rejected` reason codes), and stamps
  per-kind verified states via `_candidate_verified_state_for_kinds` (`:L77`).
- `verify_candidate` (`:L366`) → `_run_verifier` (`:L822`) dispatches to registered
  verifier callables per kind, merges returned `VerifierReport.reasonCodes`, and
  refuses unknown codes through the registry (see `reason_codes.py`).
- `promote_candidate` (`:L373`) → `_promote_candidate_unlocked` (`:L713`) checks
  blocking severity (`_has_blocking_reason`, `:L925`), bumps the accepted pointer,
  and writes an `AcceptedPromotionRecord`; `get_accepted_current` (`:L414`) exposes it.
- Idempotency is enforced with `_idempotent` (`:L418`) keyed on
  `(kind, resource_id, idempotency_key)` — replays return the original result with
  `gpu_hmr.idempotency_key_conflict` on key reuse with different payloads.
- Traces: every mutation appends `TraceEvent`s (`:L127`) retrievable via
  `get_candidate_trace` / `get_job_trace` — this is what makes broker decisions
  auditable without being "proof" themselves.

**`gpu_hmr/contracts.py`** (287L) — pydantic v1/v2-compatible strict models for all
identity records: `SelectedTargetIdentity` (`:L79`), `SourceSplitIdentity` (`:L106`),
`CompileCandidateIdentity` (`:L121`), `RuntimeVerificationIdentity` (`:L133`),
`AiGenerationIdentity` (`:L144`), `PromotionIdentity` (`:L163`); packaging models
`SourceRef`, `RoleScopePackage`, `RoleGenerationPackage`, `GeneratedRoleRef`,
`SourceToGeneratedMapping` (`:L175-L223`); and the envelope trio
`CandidateSpecManifest` (`:L225`, with `candidate_id()` derived from its own hash),
`VerifierReport` (`:L247`), `CandidateVerificationRecord` (`:L261`),
`AcceptedPromotionRecord`/`AcceptedPointer` (`:L270-L280`). `_StrictModel.contract_hash()`
(`:L75`) gives every record a stable SHA-256 over canonical JSON — the glue that lets
Rust-side reports reference Python-side evidence by hash.

**`gpu_hmr/canonical.py`** (242L) — `CanonicalHashPolicy` (`:L26`) defines the
canonicalization rules (sorted keys, path normalization via
`normalize_workspace_path` `:L119`, environment filtering `_canonical_environment`
`:L221`, float formatting) used by `canonicalize` (`:L140`), `canonical_json_bytes`
(`:L184`) and `canonical_hash` (`:L201`). `hash_many` (`:L235`) folds ordered byte
chunks. This is the single authority for "same input ⇒ same hash" across languages.

**`gpu_hmr/metadata.py`** (452L) — `resolve_target_metadata` (`:L30`) turns a pile of
source files + optional CMake `compile_commands.json` into the target-scoped metadata
block: parses compile commands (`_parse_compile_commands` `:L210`), selects the entry
for the focus file (`_selected_compile_entry` `:L224`), splits include/path flags into
relative-vs-external buckets (`_parse_compile_arguments` `:L253`), detects RDC mode
(`_rdc_mode` `:L409`) and device-link requirements (`_device_link_mode` `:L424`), and
attaches evidence refs (`_evidence_refs` `:L431`).

**`gpu_hmr/projection.py`** (145L) — `build_target_scoped_projection` (`:L20`)
projects the workspace onto the selected target: computes source sets
(`_source_sets` `:L97`), drops unrelated files, and emits the sorted unique lists the
broker hashes. Deterministic: same inputs, same projection, same hash.

**`gpu_hmr/reason_codes.py`** (101L) — loader/validator for the versioned registry:
`REASON_CODE_REGISTRY_SCHEMA_VERSION = "gpu-hmr-reason-code-registry-v1"`; pydantic
models `ReasonCodeEntry` (fields `code/phase/severity/blocking/message/requiredRemediation/safeFallbackMode/owner`,
extra="forbid") and `ReasonCodeRegistry` with duplicate detection
(`by_code()` raises on dupes). `assert_registered_reason_codes` (`:L96`) is the gate
every producer must pass — emitting an unregistered code is an error, not a warning.

**`gpu_hmr/reason_codes.json`** (1385L) — the registry itself: **138 codes across 19
phases**. Phase inventory (count): `abi_verification` 2, `api_contract` 3,
`arbiter` 6, `candidate_lookup` 1, `candidate_verification` 10,
`compile_verification` 1, `dependency_verification` 1, `fission_verification` **60**,
`generation` 5, `job_lookup` 2, `metadata_enrichment` 5, `path_scope_verification` 5,
`preflight_readiness` 7, `projection` 2, `promotion` 5, `reload_planning` 6,
`runtime_verification` 3, `schema_verification` 4, `scope_verification` 1,
`target_resolution` 9. Each entry carries `severity` ∈ {blocking, advisory, info},
`blocking` bool, human `message`, `requiredRemediation`, `safeFallbackMode`
(e.g. `"continue"`), `owner`. Examples: `fission.abi_membrane_evidence_missing`
(blocking), `stale_launch_pointer_detected` (blocking, promotion),
`target.explicit_project_config` (info). The fission phase dominates because
island candidates carry dozens of independently-checkable evidence obligations.

### 1.2 Root verifiers

**`ai-backend/ai-engine/verifier_gpu.py`** (3554L) — the deterministic acceptance
gate for generated GPU splits; nothing the model proposes is trusted until these pure
functions pass. Structure:

- Result types: `Violation` (`:L67`), `HealVerificationResult` (`:L83`),
  `SplitVerificationResult` (`:L577`).
- `verify_heal_output` (`:L435`) checks healer proposals: shim-name detection
  (`_is_shim_name` `:L388`) rejects invented symbols.
- `verify_split_output` (`:L1834`, ~1300 lines) is the main gate. It re-derives, from
  the **user's original sources only**: kernel signatures
  (`_collect_kernel_signatures` `:L3415`), launch sites and argument identities
  (`_source_launch_args_by_kernel` `:L3170`, `_launch_args_match_source_option`
  `:L3378`), state-variable types crossing core/gui
  (`_core_returned_state_types` `:L1039`, `_gui_render_state_cast_types` `:L1057`),
  record layouts with pointer members (`_record_type_has_pointer_members` `:L930`),
  launch-bound arithmetic evaluated statically
  (`_eval_static_int_expr` `:L1143`, `_launch_block_thread_count` `:L1319`) so
  out-of-bounds block sizes fail before hardware, missing buffer initialization
  (`_missing_init_launch_buffers` `:L1525`), GUI routing in the host runner
  (`_host_runner_routes_gui_module` `:L1570`), and include reachability
  (`_device_role_included_source_files` `:L1702`). It also verifies the synthi launch
  boundary calls carry provenance args (`_iter_synthi_launch_calls` `:L669`,
  `_has_explicit_source_launch_provenance` `:L743`) — the anti-fake-launch check.
- Host-site update checks (`_host_site_was_updated` `:L3476`,
  `_host_site_was_removed` `:L3501`) prove the original `<<<…>>>`/hipLaunchKernelGTL
  sites were really rewritten.

**`ai-backend/ai-engine/split_verifier.py`** (970L) — the structural complement:
`SplitStructuralVerifier` (`:L250`) runs per-module syntax checks
(`_verify_syntax` `:L401`), shared-header consistency (`_verify_shared_header` `:L474`),
export/hook presence (`_verify_exports` `:L530`, `_verify_hooks` `:L560`), state
ownership separation (`_verify_state_ownership` `:L598`), memory-pattern safety
(`_verify_memory_patterns` `:L626`), call-graph integrity (`_verify_call_graph`
`:L678`) and hallucination limits (`HallucinationLimits.check` `:L869` — caps invented
APIs/types per module; `_check_hallucinations` `:L734`). Public entry
`verify_ai_split` (`:L933`). Violation taxonomy in `SplitViolationType` (`:L42`).

### 1.3 Split request endpoint + agents

**`main.py`** hosts the three GPU endpoints the worker calls:
`POST /refactor/split/gpu` (`main.py:L2335`) — routes through `GPU_SPLIT_PROMPT`,
requires GPU markers (`_detect_gpu_project` else HTTP 422), runs up to
`max_split_attempts = 3` splitter attempts (`:L2377`), each followed by deterministic
repair (`repair_split_artifacts`) and the verifier; provider failures produce
`split_provider_failure_verification` cards, verifier rejections accumulate
`rejection_notes_history` into retry prompts. Model selection order:
`req.model || SYNTHI_GPU_SPLIT_MODEL || SYNTHI_GEMINI_MODEL || "gemini-3.5-flash"`
(`:L2367-L2372`). Also `POST /refactor/diff_patch/gpu` (`:L2662`) and
`POST /refactor/heal/gpu` (`:L2767`).

Agent files under `ai-backend/ai-engine/agents/`:

- **`kernel_splitter.py`** (1767L, context) — prompt assembly + response decoding
  for the split call: fenced/bare JSON fallbacks (the `<JSON>` wrapper quirk),
  structural escape decoding (`_decode_structural_source_escapes` `:L650`), repair
  loop until stable (`_apply_split_repairs_until_stable` `:L109`), retry playbook
  generation from verifier rejection notes (`_retry_remediation_playbook` `:L425`).
- **`launch_graph_extractor.py`** (395L, context) — masks comments then extracts
  `LaunchSite` records (`:L24`) from raw `<<<…>>>` launches, synthi runtime
  boundaries (`_extract_boundary_launches` `:L108`) and runtime-object launches
  (`_extract_runtime_object_launches` `:L182`).
- **`agents/gpu_detect.py`** (326L) — `detect_file`/`detect_project`
  (`:L194`/`:L213`) produce `GpuDetectionEvidence` (`:L142`) +
  `GpuDetectionResult` (`:L170`) from marker regexes after noise stripping
  (`_strip_noise` `:L127`); vendor hints (`_resolve_vendor_hint` `:L296`) are
  metadata only, never routing authority.
- **`agents/gpu_source_context.py`** (1082L) — builds the source-context report fed
  to the splitter: CMake File-API parsing (`_cmake_file_api_report` `:L560`),
  template-evidence ranking (`_template_evidence_report` `:L418`), selected compile
  command identity (`_selected_compile_command` `:L737`), graphics-backend report
  (`_graphics_backend_report` `:L227`), and the final
  `build_source_context_report` (`:L798`) + prompt formatter (`:L976`).
  Feeds `preflight_readiness` / `target_resolution` reason-code phases.
- **`agents/gpu_device_mapping.py`** (509L) — `build_device_mapping_report`
  (`:L38`) maps user device code → generated device role: kernel region extraction
  (`extract_kernel_regions` `:L206`), namespace tracking
  (`_namespace_path_at` `:L278`), device-reachable header closure
  (`_collect_device_reachable_headers` `:L426`), per-region sha256 identity.
- **`agents/gpu_device_markers.py`** (31L) — single predicate
  `has_gpu_device_marker` (`:L30`) + the annotation macro pattern constant; kept
  separate so both detector and worker share one definition.
- **`agents/gpu_mod_delta.py`** (1110L) — the AI delta path for device edits:
  `classify_mod_delta` (`:L342`), diff-patch prompt/retry builders
  (`:L393`/`:L492`), strict `validate_gpu_edit_list` (`:L596`), and the fission
  proposal validators (`validate_fission_candidate` `:L641`, attachment proposals
  `:L696`, output-oracle proposals `:L831`, source spans `:L947`,
  rejections `:L1005`, registered-code enforcement `_validate_registered_reason_codes`
  `:L1054`).
- **`agents/gpu_split_repair.py`** (3354L) — the deterministic repair toolbox applied
  between model output and verification: `repair_split_artifacts` (`:L185`) drives
  ~50 narrow fixes — include bridging (`_source_device_include_bridge` `:L1465`),
  SDK type redeclaration removal (`_repair_gpu_sdk_type_redeclarations` `:L780`),
  GUI render-effect repairs (`_repair_gui_render_effect` `:L988`), launch-site
  synthesis (`_repair_missing_source_launch_sites` `:L1884`), init-kernel insertion
  (`_insert_synthi_init_kernel` `:L2450`), launch-ABI mismatch repair
  (`_repair_launch_abi_mismatches` `:L2781`), bounds clamping
  (`_bounded_block_expression` `:L2921`), aggregate arg flattening
  (`_repair_aggregate_launch_args` `:L2994`). Header docstring states the contract:
  *"narrow, source-derived repairs on generated roles only… intentionally avoid
  fixture- or symbol-specific rules."*
- **`agents/gpu_healer.py`** (127L) — prompt/response pair for the heal endpoint
  (`build_gpu_heal_prompt` `:L56`, `parse_gpu_heal_response` `:L84`); output is
  re-verified by `verify_heal_output`, never trusted.
- **`agents/gpu_error_triage.py`** (125L) — classifies device-compile failures into
  `GpuTriageResult` (`:L31`): soft vs hard compile reasons
  (`_soft_compile_reason` `:L93`) and restart requirement (`_requires_restart`
  `:L123`).
- **`agents/gpu_launch_indirection.py`** (162L) — `build_launch_indirection_report`
  (`:L36`) proves every launch goes through the indirection boundary; produces the
  `launch_indirection_ok` / block-reason inputs consumed by
  `gpu_prod_contracts.rs:L1336-L1348`.
- **`agents/build_manifest.py`** (1670L, adjacent) — the split sidecar writer:
  `BuildManifest`/`GpuBuildBlock` pydantic models (`:L147`/`:L83`),
  `validate_manifest_v1` (`:L231`, V1 rejects multi-step `build_steps`), the
  include→link rule checker, `internalize_gpu_generated_artifacts` (`:L580`),
  `normalize_gpu_split_manifest` (`:L674`) and CMake File-API flag extraction
  (`_extract_cmake_file_api_device_flags` `:L1201`). Emits
  `.synthi_split_meta.json` whose `compile_manifest` block is exactly what the Rust
  `CompileManifest` struct deserializes.

---

## 2. MCP layer — `mcp/synthi-mcp/src`

The MCP server never decides HMR outcomes; it *observes* the worker's terminal
messages and proof telemetry so an agent can block until a reload is genuinely
proven. Three source files + one tool.

**`hmr.ts`** (539L) — wire classification. `parseWireMessages` (`hmr.ts:L141`)
handles both raw NDJSON and the worker's `structured-json-chunk` reassembly
(`StructuredJsonChunk` `:L62`, buffer limit 32 chunks / TTL 120s `:L81-L82`), plus
brace-balanced embedded-JSON extraction (`embeddedJsonObjectCandidates` `:L104`) for
log lines that carry JSON payloads. `classifyHmrMessage` (`:L170`) maps any message
to an `HmrClassification { status, source, detail }` where:

- `HmrTerminalStatus` (`:L34`): `applied | rejected | compile-error |
  full-reload-required | discarded | timeout`.
- `HmrTerminalSource` (`:L42`): `candidate_notification | hmr_status |
  rollback_notification | compile_diagnostics | gpu_proof | timeout` — i.e. the six
  worker notification types (see [[#3-Rust-worker]] `candidate_notification.rs`,
  `rollback_notification.rs`, orchestrator status, diagnostics, gpu_proof) plus the
  client-side timeout synthesis.
- Helpers `terminalModule`/`terminalPreviewId` (`:L231`/`:L240`) pull identity out of
  the detail card for module-scoped waits.

**`gpu_proof.ts`** (913L) — the proof ladder, TypeScript mirror of
`worker/src/hmr/gpu_proof.rs`:

- `GPU_HMR_PROOF_SCHEMA_VERSION = "synthi.gpu.hmr.proof.v1"` (`:L11`).
- `GPU_HMR_PROOF_STATES` (`:L13`), ranked 1→9 exactly as the Rust `rank()`:
  compile-proven(1) → symbol-bound(2) → abi-proven(3) → epoch-swap-proven(4) →
  dispatch-observed(5) → dispatch-safe-proven(6) → output-oracle-proven(7) →
  host-preservation-proven(8) → full-runtime-proven(9).
- `GPU_HMR_DEGRADED_STATES` (`:L27`) — the honest-failure vocabulary:
  fake-launch-path, unknown-arg-provenance, abi-unverified, dispatch-unobserved,
  output-unobserved, host-replaced, epoch-retirement-pending, epoch-swap-unverified,
  ram-io-unavailable, visual-only, visual-evidence-missing,
  original-host-path-unattached, fission-unverified.
- `GpuHmrProofTelemetry` (`:L43`) mirrors the Rust serde shape field-for-field
  (`schemaVersion/proofId/proofArtifactPath/resultState/degradedState/degradedReason/
  label/source/observedAt/raw`).
- The core gate is rank comparison with degradation caps:
  `gpuHmrProofStateRank` (`:L755`), `gpuHmrDegradedStateRankCap` (`:L759`),
  `validateGpuHmrProofState` (`:L794`) returning `GpuHmrProofValidation`
  (`:L56`) whose `effectiveResultRank = min(resultRank, degradedCap)` must be ≥
  `requiredRank`. A degraded state can therefore *never* satisfy a requirement above
  its cap even if the claimed result state is high — that's the anti-"logs as proof"
  rule in one function. `classifyGpuHmrProofMessage` (`:L765`) recognizes proof
  telemetry inside arbitrary wire messages;
  `gpuHmrProofMatches` (`:L732`) binds a proof to a requested
  `(module, previewId, requiredState)` triple via `GpuHmrProofMatchOpts` (`:L77`);
  it additionally chains `queryGpuHmrLedgerInvariants` results
  (`proofLedgerValidation`, `runtimeProofArtifactValidation` fields `:L66-L67`) so a
  self-inconsistent ledger fails the match.

**`gpu_proof_ledger.ts`** (1553L) — invariant checker for the embedded acceptance
ledger (`synthi.gpu.hmr.proof_ledger.v1`, `:L3`). Closed vocabularies at
`:L5-L51`: project kinds `{gpu_project, mixed_project}`, metric clock
`{monotonic_ns}` only, metric scopes `{cold, warm, hot_delta_1, hot_delta_2}`,
cache states `{clean, compiler_cache_warm, pipeline_cache_warm}`, backends
`{hip, hiprt, opencl, vulkan, webgpu, bevy_wgsl, cuda, sycl}`,
model availability bases, and required provider/model per role
(`google_gemini`; split=`gemini-3.5-flash`, gpu_delta=`gemini-3.1-flash-lite`
`:L18-L22`). Required-field matrices:

- `REQUIRED_TIMING_FIELDS` (`:L52`) — 15 monotonic timings from
  `static_discovery_time` to `total_validator_wall_time` (incl.
  `trigger_to_visible_time`, `dispatch_to_output_proof_time`).
- `COMPUTE_ORACLE_ARTIFACT_FIELDS` (`:L69`) — raw_readback_bin, readback_schema_json,
  checksum_before/after, deterministic_slice (+bounds/hash), oracle_code_hash,
  rendered_card_png, producer, timestamp_after_dispatch, epoch.
- `VISUAL_ORACLE_ARTIFACT_FIELDS` (`:L81`) — before/after/diff image hashes,
  blank-frame & same-frame rejection records, new-epoch watermark-or-trace,
  camera_state_hash, swapchain_size, capture_backend, frame_number,
  perceptual_diff, changed_pixel_ratio, visible_pixel_count.
- `REQUIRED_MODEL_FIELDS` (`:L101`) — full model provenance (provider, requested vs
  actual vs fallback model, availability basis/source/time, request mode,
  hard_infra_failure flag).

`queryGpuHmrLedgerInvariants(input)` (`:L1478`) walks ~90 distinct failure codes
(naming pattern `<subject>_<field>_missing|_mismatch`) — e.g.
`dispatch_epoch_mismatch`, `loader_process_identity_missing`,
`visual_before_image_hash_missing`, `retirement_event_missing`,
`firewall_process_identity_after_mismatch`,
`supplied_ledger_query_schema_mismatch` — each binding artifacts to
`(epoch, dispatch_id, process_identity, artifact_hash)` tuples.
`embeddedGpuHmrProofLedger(raw)` (`:L1544`) extracts the ledger sub-object from a
proof message. Return shape: `GpuHmrLedgerValidation { schemaVersion, proofId,
gpuHmrSuccess, failedInvariants[] }` (`:L127`).

**`src/tools/wait_hmr.ts`** (513L, consumer) — the `synthi_wait_hmr` tool.
Args (`wait_hmr.ts:L11-L24`): `timeoutMs` (default 20 min `:L28`), `module`,
`since_ts`, `preview_id`, `requiredGpuProofState`, `requireGpuFullRuntimeProof`
(shorthand pinning `gpu-hmr-full-runtime-proven`, `:L82-L84`). Poll loop polls frame
gate every 50 ms (`:L29`), classifies messages through `classifyHmrMessage`, accepts
a GPU proof as terminal success only when `validateGpuHmrProofState` is satisfied
(`terminalEventFromGpuProof` `:L46` marks detail
`terminal_equivalent: "gpu_hmr_full_runtime_proof"`), and honors
`SYNTHI_MCP_HMR_POST_APPLY_OBSERVE_MS` post-apply observation window (`:L27`,
`:L32-L39`) so "applied" claims must survive observation without crash/rollback.

---

## 3. Rust worker — `backend/synthi-webrtc-compiler/worker/src/hmr/` (129 files)

Grouped by pipeline stage. Line refs are `worker/src/hmr/<file>.rs:Lnnn`.

### 3.0 Module root

**`mod.rs`** (151L) — declares all modules; several are `#[cfg(feature =
"gpu-hmr")]` gated (`gpu_*`, `binary_patch/*`, `device_snapshot`, …). Feature off ⇒
the whole GPU surface compiles out and `compile_device_phase0` returns `Ok(None)`.

### 3.1 Detect / classify stage (what changed, which loop)

| File | Role |
|---|---|
| `changed_files.rs` (194L) | Bridges watcher events into a `ChangeSet` of `FileChange{path, ChangeType}`; ChangeType ∈ created/modified/renamed/deleted. |
| `dirty_classifier.rs` (224L) | `classify_file` maps a dirty file to Core / Gui / Shared / HostRunner / Device / BuildScript / Unknown — the input to rebuild scope. |
| `shared_header_detect.rs` (135L) | Finds headers included by both core & gui; changes there force wider scope. |
| `dependency_graph.rs` (238L) | `ModuleNode` graph; propagates a change transitively to dependents (`analyze_dependents`). |
| `rebuild_scope.rs` (276L) | `calculate_rebuild_scope` → `RebuildScope` enum (SingleModule / ModuleWithDeps / SharedHeader / FullProject) — minimal rebuild unit. |
| `edit_classifier.rs` (359L) | Per-hunk classification: `EditTarget` × `EditKind` (value-only change, expression, addition, deletion, structural) feeding Tier-0 eligibility. |
| `ts_value_classifier.rs` (240L) | Tree-sitter AST classifier replacing regex value-only heuristics (Phase 11b); emits `LiteralChange`s. |
| `compile_enrichment.rs` (124L) | Enriches a CompileRequest with loop classification + adapted-project metadata before entering the pipeline. |
| `loop_classifier.rs` (252L) | Chooses Loop A (deterministic) vs Loop B (AI-assisted) → `LoopClassification{CompileLoop, LoopReason}`. |
| `loop_b_triggers.rs` (166L) | Explicit predicates that force Loop B (new symbols, structural edit, explicit user AI request…). |
| `adapted_project.rs` (351L) | Detects an existing AI adaptation: core/gui/shared/host_runner paths + BYOR sentinel `// SYNTHI_USER_RUNNER` (`user_owned_runner`, `:L36-L42`) + stale `split_hash` detection (`is_split_fresh`). Lets Loop A skip AI on later compiles. |
| `ai_bypass.rs` (177L) | SplitCache keyed semantically; `check_ai_bypass` returns cached split or proceeds — the hot-path cache behind Loop A. |
| `ai_gate.rs` (168L) | `AiGateDecision` allow/deny stats for when AI endpoints may be called at all. |
| `ai_cache.rs` (245L) | Generic AI response cache (`AiCacheConfig` TTL/capacity). |
| `ai_circuit_breaker.rs` (244L) | CircuitState closed/open/half-open breaker on AI backend health. |
| `ai_cost_tracker.rs` (208L) | Token/cost budgets per session/module (`CostCheckResult`). |
| `ai_fallback_chain.rs` (212L) | Ordered fallback levels when AI is unavailable; `FallbackTracker.advance()`. |
| `ai_request_contract.rs` (220L) | Canonical `AiRequest/AiResponse/SourceSnippet` shapes incl. `AiRequestReason` + `AiPriority`. |
| `ai_response_validator.rs` (245L) | `validate_response` → `ResponseVerdict` before the planner consumes AI output. |
| `ai_timeout_guardian.rs` (208L) | Priority-scaled timeouts (`TimeoutDecision`, TimeoutSource). |
| `ai_extraction_tests.rs` (162L) | Tests for extracting structured data out of AI text. |

### 3.2 Split-request handling & manifests

| File | Role |
|---|---|
| `compile_manifest.rs` (1168L) | **Sidecar schema (Rust mirror of ai-engine build_manifest.py)**. `CompileManifest` (`:L334`): compiler(g++/clang++), std(default c++26), common/core/gui/shared/runner link+common flags, files, `module_files{shared,core,gui,host_runner,device}`, system_packages, `hot_reload_mode`, `confidence`, forward-compat `build_steps` (rejected in V1 upstream), optional `gpu: GpuBuildBlock` (`:L273`: vendor cuda/rocm, device_compiler nvcc/clang-cuda/**hipcc**, arch[], device_flags[], runtime_libs[], snapshot_mode, fatbin_strategy=sidecar_module, device_roles[GpuDeviceRole], device_link{requires_rdc,…}, generated_split_granularity). Key helpers: `select_compiler` (`:L515`, ULTRAPLAN §5.3), `requires_process_restart` (`:L552`), `tier0_safe` (`:L566`) demanding `-O0 -fno-merge-constants` (string pooling would make literal patches hit the wrong call site), `with_tier0_flags` (`:L583`), `generic_fallback` (`:L394`) for legacy sidecars without a manifest — intentionally does not infer GPU flags. `HotReloadMode` (`:L78`): Swap ≈50 ms dlclose/dlopen vs ProcessRestart ≈300–800 ms for hidden-global-state libraries (FMOD/Wwise/Qt/JUCE) vs Auto (downgrade after a crash within 2 s, implemented by dynlib_crash_isolation). |
| `build_manifest.rs` (293L) | **Per-build artifact manifest consumed by the planner against the previous build**: preview_id, language, adapter_family, capability_tier 0–3, `slot: BuildSlot{core,gui,widget,full,custom}` (`:L67`), artifact_path/hash, toolchain_fingerprint, `abi_version`, `state_schema_hash`, snapshot_modes[], capabilities[], `preview_preservation_mode` KeepAlive/Quiesce/Restart (`:L41`), dirty_unit_source (file_watcher/user/ai/dep-graph `:L53`), exported_symbols, dependencies, healthcheck_strategy symbol-check/first-tick/startup-sequence/none (`:L27`), rollout_flags, build_time_ms, extension fields (translation_units, dirty_units, header_fingerprint, candidate_generation, provenance_id…). Builder-style constructors `with_abi_version` etc. (`:L202-L246`). |
| `diagnostics.rs` (163L) | Unified compile-diagnostic schema (severity/location/code/message) shared by frontend overlay + healing + ai-backend. |

### 3.3 hipcc invocation (adjacent file)

**`../compiler/stages/compile_device.rs`** (3423L, feature-gated) is where the device
artifact actually gets built:

- Entry `compile_device_phase0` (`:L144`) → `compile_device_inner` (`:L195`):
  include pruning against workspace (`prune_redundant_generated_device_includes`
  `:L446`, reachability probe `include_file_reaches_target` `:L649`), removal of
  source-owned duplicate forward decls (`:L716`).
- Command assembly `populate_device_command` (`:L2526`):
  - nvcc: single-shot `--cubin -arch=<arch>` + user flags + forced
    `--ptxas-options=-v` (`:L2533-L2546`) so ptxas info feeds error triage.
  - clang-cuda: `--cuda-device-only --cuda-gpu-arch=<arch>`.
  - **hipcc** (`:L2560-L2575`): *single-arch* ⇒ `--offload-device-only
    --no-gpu-bundle-output` (raw code object straight into `hipModuleLoad`);
    *multi-arch* ⇒ `--genco` bundled code object; always
    `--offload-arch=gfx1201`-style per arch. Header comment (`:L17-L21`): PTX-like
    intermediates are cacheable, the final code object is the load-time artifact.
- Bundled-output normalization `normalize_rocm_artifact_if_bundled` (`:L2263`):
  detects the clang offload bundle magic, lists targets via `clang-offload-bundler
  --list`, picks the `hip*` line through `parse_hip_offload_target` (`:L2502`) —
  e.g. `hipv4-amdgcn-amd-amdhsa--gfx1201` — and unbundles to `<stem>.raw.hsaco`.
- Deterministic caching: cache key hashes normalized command tokens
  (`normalized_device_compile_command_tokens` `:L1285`), target-triple fingerprint
  (`:L1454`), compiler identity (`device_compiler_identity` `:L1729`), dependency
  depfile closure (`compiler_depfile_dependency_cache_hash` `:L1526`,
  `parse_make_depfile_paths` `:L1694`); restore/store at `:L1974`/`:L2069`.
- Post-compile: exported-symbol inspection via llvm-readobj
  (`inspect_device_artifact_exported_symbols` `:L2361`).

### 3.4 GPU module manager — dual-slot swap logic (deep dive)

**`gpu_module_manager.rs`** (1216L) owns the loaded-module lifecycle. It is the
lowest-level mutable state in the whole GPU path, and its discipline is what makes
"hot swap without leaking VRAM or launching into unloaded code" possible.

- **Slots.** `ModuleSlot` (`:L51`) holds the raw driver handle as `u64`
  (`Send + Sync` by construction; conversion happens only at the unload boundary)
  plus blob byte size; `PartialModuleSlot` (`:L57`) pairs a slot with the symbol
  subset it replaces. Two real slots exist: `primary` (what launches dereference)
  and `standby` (loading or just-loaded next image), plus a `partials: Vec` for
  fission-era partial merges.
- **Kernel table.** `KernelTable` (`:L72`) maps logical kernel names → function
  handles, populated once per load by `resolve_kernels` (`:L365`) calling
  `cuModuleGetFunction`/`hipModuleGetFunction` for every expected name.
  `KernelResolution` (`:L107`) carries `logical_name` + `driver_name` because HIP
  mangles entry names while launch sites use source names — resolution specs are
  parsed from `exported_symbols` entries of the form `"logical=driver"`
  (`kernel_resolution_specs`, gpu_module_adapter.rs:L362) and the table keeps the
  *logical* key so dispatch and telemetry stay stable across vendors
  (test `resolve_kernel_symbols_uses_driver_name_and_keeps_logical_key` `:L892`).
- **Load paths.** `load_standby` (`:L271`) wraps `cuModuleLoadData` /
  `hipModuleLoadData` for RAM blobs; refuses when standby occupied
  (`StandbyOccupied`) or blob empty (`EmptyBlob`), surfacing driver errors as
  `DriverError{op, code}` recorded on `last_error` (`:L227-L233`).
  `load_standby_from_file` (`:L317`) wraps `cuModuleLoad`/`hipModuleLoad` for
  filesystem artifacts — deliberately preferred for ROCm genco output because
  "`hipModuleLoadData` on that same hsaco can hang on ROCDXG-backed WSL systems"
  (`:L312-L316`). This is the first gfx1201-specific workaround: RX 9070 XT on WSL
  (ROCDXg driver stack) hangs on data-load of bundled hsaco, so the pipeline
  normalizes to a file and path-loads it.
- **Swap.** `swap()` (`:L436`) promotes standby → primary atomically in struct terms
  (`take` standby, `replace` primary) and returns the retired primary; the caller
  must NOT unload immediately — retirement happens only after the stream-drain fence
  proves no in-flight launch still references the old image. `swap_count` (`:L230`)
  feeds telemetry as `gpu_swap_count`. `swap()` without standby is `NoStandby`.
- **Partial merge (fission).** `merge_standby_partial` (`:L455`) implements
  island-level replacement: instead of promoting a whole module, it overlays only
  `replaced_symbols` from the standby partial onto the live table; every replaced
  symbol must already exist (`UnknownKernel` otherwise, rolled back), superseded
  partials whose symbol set is fully covered are retired (`:L502-L518`), others stay
  resident. `drain_partial_modules` (`:L527`) returns everything for teardown.
  This is what lets a single-kernel body edit avoid reloading the full module graph.
- **Retire.** `unload_retired` (`:L538`) wraps `cuModuleUnload`/`hipModuleUnload`,
  returning the raw driver code so the adapter can decide escalation; non-zero also
  lands on `last_error`.
- **Launch.** `launch_kernel` (`:L563`) rejects unknown kernels *before* touching the
  driver (deterministic error cards instead of CUDA_ERROR_INVALID_HANDLE),
  expands 1-D runtime sizes into clamped x/y/z triples (`clamp_launch_dim` `:L151`,
  test `launch_config_clamps_1d_runtime_sizes` `:L1105`).
- Test coverage is exhaustive (stubbed driver state machine `:L637-L1213`):
  atomicity on driver failure mid-resolve (`:L931`), standby occupancy rules,
  NUL-in-name rejection, Send+Sync assertion (`:L1209`).

**`slot_manager.rs`** (553L) is the host-side sibling used by the dynlib family:
`LibSlot::{A,B}` ping-pong (`:L16`), `SlotKind::{Host,Device,...}` (`:L40`) with kind
inheritance/mismatch rejection on `prepare_standby_with_kind` (`:L197`,
test `prepare_standby_rejects_kind_mismatch` `:L493`), generation counter bumped by
`swap` (`:L257`). Same two-slot concept, library granularity.

### 3.5 Adapter layer — vendor abstraction & the reload sequence

- **`adapter_trait.rs`** (327L) — `Adapter` trait + `ReloadCapsuleMetadata` /
  `ReloadFirewallEvidence` with signed-token encode/decode
  (`encode_reload_capsule_metadata_token` `:L327-area`) proving the swap inputs were
  produced by the firewall, not forged by the caller.
- **`adapter_matrix.rs`** (365L) — language → `AdapterFamily` (DynLib / Managed /
  ProcessSwap / …) → `CapabilityTier` 0–3 matrix (`AdapterDescriptor`).
- **`adapter_registry.rs`** (248L) — factory `create_adapter_for_language`.
- **`adapter_lifecycle_fsm.rs`** (209L) — validated FSM (Unloaded→Loaded→Ready→…)
  shared by all families; invalid transitions are typed errors.
- **`lifecycle_machine.rs`** (184L) / **`preview_lifecycle.rs`** (176L) — preview-level
  lifecycle states + events mirrored to the frontend.
- **`gpu_module_adapter.rs`** (5004L) — the GPU `Adapter` impl; the Phase-3 runtime
  boundary. Vendor surface: `GpuVendor::{Cuda,Rocm}` with per-vendor adapter name,
  proof backend/artifact-kind/compiler labels, driver library (`libcuda.so.1` vs
  `amdhip64.so`), dlsym symbol names for module load/unload/get-function/launch/
  synchronize (`:L105-L210`) — "single source of truth so Phase 2 doesn't hardcode
  libcuda.so at the call site". `ArtifactLoaderTransport::{FilesystemPath→module_load_path,
  RamBytes→module_load_data}` (`:L319-L337`) selects the manager load call and is
  reported honestly in telemetry (ram transport requires hash equality between RAM
  artifact and disk bytes, checked at `reload()` `:L2819-L2847`).
  `GpuModuleAdapter::reload()` (`:L2752-L3476`) is the pipeline in miniature:
  1. cold-route when driver unavailable (`:L2760`) or no artifact (`:L2780`);
  2. RAM-vs-file hash equality check (`:L2819`);
  3. plan classification `classify_plan(req)` (`:L2569`) from changed paths +
     ABI memory (`remember_device_abi` `:L2590`): HostOnly short-circuit delegating
     to host adapters (`:L2896`), AbiBreaking reject with
     `signature-changed` (`:L2913`);
  4. kernel resolution specs from manifest `exported_symbols` (`:L2978`) and
     expected logical set (`:L2990`);
  5. **stream drain** `drain_affected_streams(...)` with budget
     (`drain_timeout_ms`) — partial plans drain only streams that touched the
     changed symbols (test `partial_reload_drains_only_streams_that_used_touched_symbols`
     `:L4753`);
  6. standby load via selected transport (`:L3047-L3055`), retired collection
     including drained partials (`:L3085`);
  7. **launch dispatcher install before retirement**
     (`install_launch_dispatcher_with_metadata` `:L3101` — new function handles go
     live while old module still resident; ordering test `:L4525`);
  8. **epoch publish** log line `[gpu-runtime-boundary] dispatcher_epoch event=published
     …` with publish_timestamp_ms, generations, artifact id, drain scope/stream ids,
     retirement fence ids, delayed-unload decision (`:L3166-L3200`) +
     `epoch_generation_graph_line` JSON for the graph view (`:L3202`);
  9. runtime output-oracle probe (`run_runtime_output_oracle_probe` `:L3237`) —
     failure faults the adapter *without swapping* (test `:L4947`);
  10. `unload_retired` then **epoch retire** line (`:L3283-L3300`);
     capsule metadata records publish timestamp/dispatch ids (`:L3330-L3400`).
  Failure modes keep the old primary untouched (load failure → `module-load-failed`
  reason `:L3458`); managed-buffer snapshot stats ride along in every result card
  (`managed_snapshot_stats` `:L2481`, test `phase3_reload_uses_managed_buffer_snapshot_telemetry`
  `:L4916`).

**`gpu_reload_orchestrator.rs`** (518L) — pure planning over the same enums:
`GpuReloadPlan::{HostOnly, DeviceOnly, Mixed, AbiBreaking}` (`:L22`),
`GpuReloadStep` 13-step vocabulary (`:L42`: host_swap, device_save, drain, save,
unload, load, restore, verify, device_restore, cold_reload, device_on_load, rollback,
cold_restart). `plan_gpu_reload` (`:L235`) composes step sequences per plan —
DeviceOnly ⇒ drain/save/unload/load/restore/verify; Mixed ⇒ device_save → host_swap
→ device swap → device_restore; AbiBreaking ⇒ cold_reload + device_on_load —
forces drain-timeout ⇒ immediate ColdRestart (`:L248-L264`), and appends Rollback
when matched kernel hashes < expected (`:L290-L297`).
`plan_runtime_fault_recovery` (`:L177`) turns a runtime fault event into
heal_and_resume / heal_and_cold_restart / bail_out based on retry budget and
context-invalidated severity.

### 3.6 Driver loading, gfx1201 specifics

- **`gpu_driver_loader.rs`** (534L) — dlopen/dlsym of vendor runtime into
  `GpuDriverSymbolTable` (`:L115`: init/device-get/ctx get+set/module
  load-data/load/unload/get-function/launch/ctx+stream sync/mem alloc/free/dtoD/
  htoD/dtoH). `required_symbol_names(vendor)` (`:L137`) resolves in fixed order —
  CUDA `cuMemAlloc_v2`-style versioned names vs ROCm `hipMalloc` unversioned,
  `hipDeviceSynchronize` vs `cuCtxSynchronize` — fail-fast "stopped at symbol N".
  `GpuDriverHandle::shared()` (`:L281`) hands one Arc to adapter + manager + arena so
  nobody re-dlopens. `probe()` folds failures into `DriverProbe` for logging.
- **gfx1201 (RX 9070 XT / RDNA4) touchpoints:**
  1. arch flows purely as manifest data: `GpuBuildBlock.arch=["gfx1201"]` →
     `--offload-arch=gfx1201` (compile_device.rs `:L2568`) — never a hardcoded
     branch.
  2. Single-arch hipcc uses raw code-object output + `hipModuleLoad` path
     (manager `load_standby_from_file`) specifically because ROCDXg/WSL hangs on
     data-loading bundled hsaco (`gpu_module_manager.rs:L312-L316`).
  3. Multi-arch/bundled outputs are unbundled to `.raw.hsaco` picking the
     `hipv4-amdgcn-amd-amdhsa--gfx1201` target line
     (`normalize_rocm_artifact_if_bundled`, `parse_hip_offload_target`).
  4. Tier-A checkpoint probe on ROCm looks for the **`criu-amdgpu`** binary rather
     than CUDA checkpoint symbols (`device_checkpoint_probe.rs:L112-L139`).
  5. Live validation runs against the Docker ROCm 7.2.1 image with
     `rocminfo | grep gfx1201` as readiness gate (see scripts §4).

### 3.7 Device-state migration (hold-alive runner state)

The "keep the runner alive while device state survives" machinery:

- **`device_checkpoint_probe.rs`** (179L) — Tier selection. Tier A =
  driver checkpoint: CUDA probes `cuCheckpointProcess{Lock,Checkpoint,Restore,Unlock}`
  in libcuda.so.1 (`:L141-L148`); ROCm probes `criu-amdgpu --version` (`:L113`).
  Never fails: always yields a tier + human reason for logs (`CheckpointProbe.log_marker`
  `:L27`). Requested Userspace skips probing entirely.
- **`device_snapshot.rs`** (491L) — Tier-B types: `DeviceStateSnapshot`
  envelope (tier, device_ordinal — mismatching ordinal on restore is a hard fail,
  driver_version, compute_capability, stream sync state) holding
  `BufferRecord`/registry, constant-slot and stream records. Phase-1 serde shapes;
  payload capture lives in Phase 2.
- **`gpu_shadow_arena.rs`** (714L) — in-VRAM shadow copies so a swap doesn't need a
  multi-GB DtoH round trip: `register(orig_dptr,size)` does one `cuMemAlloc` and parks
  the pointer (`:L175`); `sync_to_shadow` = DtoD orig←shadow capture marked fresh
  (`:L230`); `sync_from_shadow` restores, refusing never-synced entries (`:L263`);
  `release` frees (`:L291`). Errors are precise (`ZeroSize/UnknownKey/SizeMismatch/
  DriverError` with short labels `:L63-L88`). Works together with:
- **`gpu_dirty_bit.rs`** (387L) — `DirtyBitTracker` per-buffer dirty bits +
  byte accounting (`dirty_ratio`, `dirty_bytes` `:L55/L185`) so only dirty buffers
  get shadow-synced within the latency budget (ULTRAPLAN §6.1).
- **`gpu_stream_drain.rs`** (516L) — quiescence before swap:
  `drain_context`/`drain_stream` wrap `cuCtxSynchronize`/`cuStreamSynchronize`;
  budget enforcement is post-hoc (Synced/TimedOut/DriverError outcomes with elapsed
  and budget carried `:L52-L104`), synthetic clock injection for tests (`DrainClock`
  `:L109`). The adapter escalates TimedOut to a forced cold restart.
- **`state_manager.rs`** (742L) + **`state_type_id.rs`** (970L) — robust host-side
  state typing: `StateTypeId` extraction replaces naive DWARF type-name matching
  ("don't do DWARF find-struct-by-name") using equivalence classes + note payloads;
  `MigrationSchema`/`SchemaVersion` registry feeds the migrator.
- **`state_diff.rs`** (1007L) — field-level diff/merge between saved and fresh
  template states (`diff_and_merge` `:L`, `generate_migration_report`),
  `SchemaCompatibility` verdicts.
- **`state_migration.rs`** (334L) — `MigrationRegistry` of typed steps
  (`MigrationStep`, `FieldChange`); BFS path finding forward (`find_path` `:L112`)
  and rollback (`find_rollback_path` `:L159`), applied stepwise (`apply_path` `:L204`).
- **`binary_state.rs`** (2309L) — production binary state schema: hand-rolled
  MessagePack writer/reader (`MsgPackSerializer`/`MsgPackState` with schema_version +
  schema_hash stamped into the blob), `SchemaMigrator` adding defaults for new
  fields / resetting renamed ones, `SchemaMigrationResult` reporting exactly which
  fields migrated vs reset. This is how warm reloads survive struct additions
  without restart (user-mandated universal memory-structure hot reload).
- Supporting: `state_checkpoint.rs` (policy-driven periodic checkpoints),
  `state_snapshot.rs` (snapshot ring buffer + compat compare), `state_serializer.rs`
  (format negotiation), `state_size_limiter.rs` (per-module/global budgets),
  `state_restore_orchestrator.rs` (choose snapshot → validate → migrate or discard),
  `state_restore_validator.rs`.

### 3.8 Binary patching tiers (avoiding recompile/relink entirely)

- **`tier0_literal_patch.rs`** (621L) — string-literal swaps extracted from the
  edit classification (`extract_string_swaps` `:L99`, same-length only), patched
  directly into the .so (`patch_so_file` `:L189`, ambiguous multi-match ⇒ fail);
  `try_tier0_bypass` (`:L323`) scans `candidate_so_paths` (`:L287`).
- **`tier0_unified.rs`** (366L) — Tier0 v2: `try_tier0_v2` (`:L64`) combines string,
  int and float literals with `PatchRecord` audit trail; C integer parsing incl.
  hex/suffixes (`parse_c_integer` `:L320`).
- **`binary_patch/imm_patcher.rs`** (239L) — patches integer immediates at known
  instruction encodings (mov DWORD PTR [rbp-N], imm32) at `-O0`.
- **`binary_patch/float_patcher.rs`** (243L) — IEEE754 bytes in .rodata reached via
  RIP-relative movss/movsd operands.
- **`binary_patch/dwarf_line_map.rs`** (217L) — parses `.debug_line` to map
  (file,line) → virtual addresses (needs `-g -gdwarf-4 -O0`, which
  `compile_manifest.tier0_safe` enforces).
- **`binary_patch/proc_mem_patcher.rs`** (195L) — writes patched pages into the live
  runner via `/proc/<pid>/mem` (maps → base → file-offset-to-vaddr via program
  headers), skipping dlclose+dlopen (~20 ms) entirely for Tier-0 value edits.
- **`diff_patcher.rs`** (522L) — token-similarity line patching of split sources
  (`patch_split_files` `:L36`) for AI diff application; value-change extraction
  (`apply_value_changes` `:L367`).
- **`speculative_diff_patch.rs`** (535L) — fires diff-patch speculatively while the
  user pauses typing (`hash_source` dedupes).
- **`edit_applier.rs`** (428L) — applies structured edit lists (from the MCP diff
  endpoint) to module content, optionally with device-side effects
  (`apply_edit_list_with_device`).

### 3.9 Fission (multi-island candidates) & prod contracts

- **`gpu_fission.rs`** (4390L) — verifier for island candidates:
  constants pin the evidence contract (`FISSION_ISLAND_SCHEMA_VERSION =
  synthi.gpu.fission_island.v1`, verifier `.v1` `:L5-L8`); required string fields
  (islandId, sourceEditId, artifactKind, dependencyClosureHash, abiMembraneId,
  compileRecipeHash, compileCommandHash `:L10-L18`) must be SHA-256 digests where
  declared (`:L20`); required arrays (sourcePaths, sourceSpans, targetSymbols,
  exportedSymbolsExpected, verifierEvidenceIds `:L26`); accepted output-oracle kinds
  (`:L49-L61`: sentinel_buffer_value, kernel_checksum, render_target_hash,
  accumulation_buffer_hash, selected_pixels, per_pass_checksum, dispatch_counter, …)
  with render-flavored subset flagged; original-host attachment actions/boundary APIs
  (`synthi_gpu_launch_source_location`, … `:L70-L97`) and evidence scopes.
  `verify_fission_candidates` (`:L208`) collects candidates, verifies each
  (`verify_fission_candidate` `:L282` pushes the registered `fission.*` reason codes),
  then selects the **narrowest viable** island (`selectionPolicy:
  "narrowest_viable_generic_v1"`, `select_narrowest_candidate_index`) and marks
  `selected:true` on it; aggregate report carries
  candidateCount/acceptedCount/rejectedCount/selectedIslandId/reasonCodes.
- **`gpu_prod_contracts.rs`** (4986L) — the normalization + arbiter brain:
  schema-versioned envelopes (`split_sidecar.v1`, `reload_plan.v1`, `run_report.v1`,
  `toolchain_capability.v1`, `selected_compile_command.v1`, `fission_readiness.v1`
  `:L5-L10`). `normalize_split_sidecar` (`:L12`) fills missing sidecar sections from
  the compile manifest: selected compile command, effectiveFlagsHash,
  toolchainCapabilities profile + hash, targetIdentity, sourceBaselineHashes,
  generated/device roles, build metadata, launch-indirection and runtime-safety
  reports, fault policy (`gpu_fault_policy` `:L1084` — TDR markers, taint,
  fragmentation ratios escalate status), memory refresh policy (`:L1137`).
  `decide_arbiter` (`:L1449`): ranks reload options (`ranked_reload_options`
  `:L1538` — warm_rebuild / device_only / ai_delta / cold_restart / full_resplit /
  unsupported, each with safety pass|fail, estimatedMs vs budget, requiresConsent),
  picks the requested plan among them, then decides
  `auto_run | ask_developer | fallback | skip` (`:L1518-L1526`) — consent gates for
  RDC-over-budget (`rdc_link_over_budget`), state loss
  (`state_loss_requires_consent`), multi-role AI delta
  (`multi_role_ai_delta_requires_consent`), user consent (`arbiter_user_consent_required`).
  `run_report` (`:L2207`) assembles the run_report.v1 card incl.
  `failure_card_template` matching (`:L1984`) and reason-code propagation
  (`run_failure_reason_codes` `:L1928`); `fission_readiness_report` (`:L2587`)
  emits per-obligation checks with `status: ready|not_ready`.
- **`gpu_device_fast_path.rs`** (3906L) — deterministic device-edit fast path that
  skips AI entirely: `try_direct_device_body_patch(sidecar, user_path,
  new_user_source, generated_device_source)` (`:L70`) validates the edited path is a
  device source, capability + compile metadata present, source baseline matches its
  recorded sha256 (`mapping.source_baseline_stale` otherwise `:L104-L111`), parses
  old/new with an AST-status report (lexical fallback only for kernel regions
  `:L121-L140`), diffs kernel bodies (`changed_kernel_body_symbols` `:L1441` —
  signature sets must be identical, else empty ⇒ not eligible), rebuilds a partial
  device source containing only affected kernels plus an include bridge
  (`build_device_partial_source` `:L1871`,
  `build_device_include_bridge_partial_source` `:L1927`), and returns a
  `DeviceFastPathResult` carrying reload_plan + verifier_report + reason_codes even
  when rejecting (`rejected_strings_with_evidence` `:L31`) — rejection is itself
  first-class, auditable output.
- **`gpu_dirty_bit.rs`** covered above; **`gpu_proof.rs`** below.

### 3.10 Proof emission (Rust side)

**`gpu_proof.rs`** (1036L) — `GpuHmrProofState` 9-rung ladder + `rank()`
(`:L13-L53`), `GpuHmrDegradedState` 11 values (`:L56-L86`) mirroring TS exactly,
`GpuHmrProofTelemetry` serde shape (`:L88-L104`) logged as single-line
`to_log_line()` (`:L132`) so wire classification stays trivial. The heavier half is
`GpuHmrAcceptanceLedger` (`:L266`): builds the ledger record with evidence refs
(`GpuHmrProofEvidenceRef` `:L148`), stage results (`GpuHmrProofStageResult` `:L169`),
writes a `GpuHmrProofArtifact` to disk (`:L192`, input/write structs `:L222-L243`),
and validates the acceptance contract (`validate_contract` `:L587`) with sha256
helpers (`sha256_hex_bytes/str`, `stable_json_hash` `:L682-L697`). Refusals route
through the same ledger — `refusal_proven` is a first-class outcome, never silent.

**`telemetry.rs`** (269L) — `LatencyHistogram`, `CompileSpan`, `ReloadSpan`,
`HmrTelemetry` counters feeding the timing fields the ledger demands.

### 3.11 Candidate queue / promotion protocol (language-agnostic core)

- **`candidate.rs`** (264L) — `Candidate` record: CandidateId, CandidateState
  (Queued→Loading→HealthChecking→Promoted/RolledBack/Failed/Superseded), summary.
- **`candidate_queue.rs`** (246L) — FIFO, one active at a time; incoming builds for
  the same slot supersede queued ones.
- **`candidate_supersession.rs`** (160L) — `should_supersede(verdict)` policy.
- **`candidate_bridge.rs`** (220L) — drives activate→load→health-check→promote/
  rollback ticks (`bridge_tick`).
- **`candidate_history.rs`** (213L) — bounded persistent lifecycle log with queries.
- **`candidate_watchdog.rs`** (153L) — timeouts per state → WatchdogAction.
- **`candidate_notification.rs`** (148L) — serializable lifecycle notifications
  (one of the MCP terminal sources).
- **`health_check.rs`** (157L) — per-candidate validation contract (symbol check /
  first tick / startup sequence).
- **`promotion_policy.rs`** (304L) — `evaluate_promotion` gating on config +
  verification evidence.
- **`swap_rollback.rs`** (162L) / **`rollback_notification.rs`** (140L) — rollback
  planning + notification payloads.
- **`reload_protocol.rs`** (716L) — deterministic reload state machine
  (`ReloadId`, `ReloadState`, `ReloadError`) addressing "single deterministic reload
  path".

### 3.12 Planner & integration glue

- **`planner.rs`** (371L) — pure `plan_reload(BuildManifest prev?, current,
  capabilities)` deciding warm/cold/managed/process-swap/reject.
- **`planner_decision.rs`** (189L) — decision schema (`ReloadDecision`,
  StateStrategy, FallbackStrategy, `PlannerReasonBundle`) — every decision carries
  reasons.
- **`planner_glue.rs`** (161L) / **`scope_planner_bridge.rs`** (178L) — execute the
  planner inside lifecycle transitions; convert RebuildScope → planner input.
- **`planner_integration_tests.rs`** (143L).
- **`integration.rs`** (1189L) — wires subsystems into the pipeline the handler
  calls; defines the notification structs (`AdapterStatusNotification`,
  `AiStatusNotification`, `StateRestoreNotification`, `AdapterHealthNotification`,
  `PipelineNotifications` `:L-L`) dispatched over WebRTC data channel.
- **`orchestrator.rs`** (1643L) — `HmrOrchestrator` facade: register modules/schemas/
  migrations, `hot_reload` (`:L462`), checkpoint capture (`:L763`),
  `save_module_state`/`load_module_state` (`:L834`/`:L935`),
  schema compatibility checks (`:L1193`), crash reporting + snapshot revert
  (`:L1233`/`:L1263`), Fast Refresh boundary checks (`:L1377-L1436`).
- **`fast_refresh.rs`** (936L) — React-Fresh-style boundary violations
  (`BoundaryViolation`) preventing unsafe hot swaps when edits cross module
  boundaries.
- **`rollout_flags.rs`** (280L) — per-family kill switches.
- **`symbol_validation.rs`** (164L) / **`undef_symbols.rs`** (223L) — required-export
  validation and undefined-symbol parsing from linker output.
- **`dynlib_preload_validator.rs`** (233L) — pre-load sanity (ELF sanity, missing
  libs) with severity-ranked issues.
- **`incremental_cache.rs`** (1559L) + **`cache_writer.rs`** (239L) +
  **`runtime_artifact_cache.rs`** (171L) — content-hash object cache with strict
  toolchain fingerprinting (any difference invalidates; `ToolchainInfo::
  is_compatible_with`), hit/miss telemetry, link cache, smart header hashing
  (`compute_smart_headers_hash`); writer persists successful builds; runtime cache
  dir avoids noexec mounts unless overridden.
- **`deterministic_compile.rs`** (309L) — Loop A pure-function contract:
  `DeterministicCompileInput/Output`, scope determination
  (`DeterministicRebuildScope`), input validation before any spawn.

### 3.13 Language families beyond GPU (same pipeline, other adapters)

- DynLib family: `dynlib_adapter.rs` (346L, Adapter impl for C/C++/Rust/Zig),
  `dynlib_abi_contract.rs` (244L, canonical required/optional export contract
  `canonical_abi_contract` `:L72` + header compatibility), `dynlib_build_hooks.rs`
  (194L, pre/post-build hook injection), `dynlib_crash_isolation.rs` (213L, the Auto
  HotReloadMode downgrade guard), `dynlib_language_profiles.rs` (202L, mangling +
  call-conv profiles), `dynlib_metrics.rs` (197L), `dynlib_reload.rs` (225L, phase
  orchestration), `dynlib_rollback.rs` (190L, per-phase failure rollback decisions),
  `dynlib_state_bridge.rs` (228L, state format capabilities), `dynlib_swap.rs`
  (184L, swap command/ack wire protocol + phases), `dynlib_symbol_resolver.rs`
  (205L, typed symbol resolution against the contract).
- Managed runtimes (JVM/.NET): `managed_runtime_adapter.rs` (266L),
  `managed_agent_protocol.rs` (177L, frames between host and injected agent),
  `managed_classloader_strategy.rs` (180L, JVMTI hot-swap vs classloader toss),
  `managed_dotnet_reload.rs` (183L, AssemblyLoadContext strategies),
  `managed_health_probe.rs` (197L), `managed_runtime_hooks.rs` (181L).
- Process-swap family (Go/Swift): `process_swap_adapter.rs` (532L; overlap window =
  how many old processes to **keep alive** during handoff `:L39`),
  `process_swap_drain.rs` (242L, graceful in-flight drain before retire),
  `process_swap_handoff.rs` (300L, IPC envelope write/read),
  `process_swap_socket_handoff.rs` (170L, listening-socket passing methods),
  `process_swap_state_transfer.rs` (171L, state transport selection).
- **`reload_manager.rs`** (3669L) — cross-family classifier + snapshots:
  `ReloadClass` with per-class latency budget / semantic-test / drain / task-shutdown
  / snapshot requirements (`:L36-L121`), override hierarchy global > boundary > path >
  auto (`:L217-L305`), `SnapshotManager` O(1)-validity ring with serialized-bytes
  snapshots (`create_snapshot_with_bytes` `:L588` preferred for cross-version
  migration), `AsyncTaskRegistry` strict-mode task violation enforcement (`:L688-L760`).
- **`hot_swap_coordinator.rs`** (246L) — phase tracker with per-phase timing and
  warm-budget overrun check (`exceeds_warm_budget` `:L155`).
- Per-wave integration tests, one file per delivery wave (145–197L each):
  `wave05_integration_tests.rs`, `wave06_integration_tests.rs`,
  `wave07_integration_tests.rs`, `wave08_integration_tests.rs` — dynlib family
  end-to-end; `wave09_integration_tests.rs`, `wave10_integration_tests.rs` —
  managed runtimes; `wave11_integration_tests.rs` — process swap;
  `wave12_integration_tests.rs` — adapter lifecycle FSM + final summary.

### 3.14 Remaining worker/src/hmr files (complete enumeration)

Covered above but listed for completeness of the 129: `mod.rs`, `abi_detect.rs`,
`adapted_project.rs`, `adapter_lifecycle_fsm.rs`, `adapter_matrix.rs`,
`adapter_registry.rs`, `adapter_trait.rs`, `ai_bypass.rs`, `ai_cache.rs`,
`ai_circuit_breaker.rs`, `ai_cost_tracker.rs`, `ai_extraction_tests.rs`,
`ai_fallback_chain.rs`, `ai_gate.rs`, `ai_request_contract.rs`,
`ai_response_validator.rs`, `ai_timeout_guardian.rs`, `binary_patch/mod.rs`, `binary_patch/dwarf_line_map.rs`, `binary_patch/float_patcher.rs`, `binary_patch/imm_patcher.rs`, `binary_patch/proc_mem_patcher.rs`, `binary_state.rs`,
`build_manifest.rs`, `cache_writer.rs`, `candidate*.rs` (7),
`changed_files.rs`, `compile_enrichment.rs`, `compile_manifest.rs`,
`dependency_graph.rs`, `deterministic_compile.rs`, `device_checkpoint_probe.rs`,
`device_snapshot.rs`, `diagnostics.rs`, `diff_patcher.rs`, `dirty_classifier.rs`,
`dynlib_*.rs` (11), `edit_applier.rs`, `edit_classifier.rs`, `fast_refresh.rs`,
`gpu_device_fast_path.rs`, `gpu_dirty_bit.rs`, `gpu_driver_loader.rs`,
`gpu_fission.rs`, `gpu_module_adapter.rs`, `gpu_module_manager.rs`,
`gpu_prod_contracts.rs`, `gpu_proof.rs`, `gpu_reload_orchestrator.rs`,
`gpu_shadow_arena.rs`, `gpu_stream_drain.rs`, `health_check.rs`,
`hmr_eligibility.rs`, `hot_swap_coordinator.rs`, `incremental_cache.rs`,
`integration.rs`, `lifecycle_machine.rs`, `loop_b_triggers.rs`, `loop_classifier.rs`,
`managed_*.rs` (6), `orchestrator.rs`, `planner*.rs` (4), `preview_lifecycle.rs`,
`process_swap_*.rs` (5), `promotion_policy.rs`, `rebuild_scope.rs`,
`reload_manager.rs`, `reload_protocol.rs`, `rollback_notification.rs`,
`rollout_flags.rs`, `runtime_artifact_cache.rs`, `scope_planner_bridge.rs`,
`shared_header_detect.rs`, `slot_manager.rs`, `speculative_diff_patch.rs`,
`state_*.rs` (9), `swap_rollback.rs`, `symbol_validation.rs`, `telemetry.rs`,
`tier0_literal_patch.rs`, `tier0_unified.rs`, `ts_value_classifier.rs`,
`undef_symbols.rs`, `wave05..12_integration_tests.rs` (8).

Not yet individually described:

| File | One-liner |
|---|---|
| `abi_detect.rs` (185L) | `detect_abi_changes(prev?, current)` over BuildManifests (`:L39-L95`): abi_version string diff, state_schema_hash diff, exported-symbol set diff; symbol-only changes count as ABI breaks even when the version string is unchanged; returns `AbiChangeResult{abi_changed, schema_changed, source, added_symbols, removed_symbols}`. |
| `hmr_eligibility.rs` (292L) | Replaces the old hardcoded `existing_runner_can_hmr=false`: `check_hmr_eligibility(EligibilityInput)` decides per-request whether the running preview can accept an HMR at all. |
| `health_check.rs` (157L) | Candidate health-check contract config (strategy + budget). |

---

## 4. Proof harnesses — scripts & npm `proof:*`

Two script roots matter: repo-root `scripts/` (stack bring-up) and
`mcp/synthi-mcp/scripts/` (the actual proof harnesses, ~132 files). The
`mcp/synthi-mcp/package.json` exposes **83 `proof:*` scripts**; the GPU-HMR-relevant
subset:

**Live hardware validation**

- `proof:real-rocm` → `scripts/gpu-hmr-real-rocm-repo-validation.mjs` (8620L) — the
  flagship driver: clones a *real public ROCm project*, separates two claims ("upstream
  target builds+runs in this worker" vs "Synthi can consume the real repo files and
  apply GPU split/HMR"), drives compile → split → HMR → dispatch → oracle through MCP
  against the live gfx1201 container, and emits per-stage proof artifacts
  (ABI/epoch-swap/host-preservation/original-host-path/output proofs via
  `lib/gpu-hmr-proof-artifacts.mjs` and `lib/gpu-hmr-runtime-evidence.mjs`) plus a
  final validation summary (`lib/gpu-hmr-validation-proof-summary.mjs`). Profile JSONs
  in `scripts/profiles/real-rocm-*.json` (histogram / matmul / prefix-sum / saxpy /
  shared-memory) parameterize the workload — profiles are data, never authority.
  Runbook env: `SYNTHI_REAL_ROCM_PROFILE_PATH`, `WORKER_CONTAINER`,
  `SIGNALING_URL=ws://127.0.0.1:9000`, `MCP_TRANSPORT=local`,
  `SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1`; must run under `bash -lc`.
  `proof:real-rocm:warm` reuses the worker repo & build for speed.
- `proof:runtime-profile[:hiprt|:hiprt:camera-rays]` →
  `gpu-hmr-runtime-profile-proof.mjs` (337L) — profile-driven adapter runner;
  adapters map profile ids to runner scripts (currently `hiprt-light-math-warm-proof.mjs`),
  modes include `same-process`. `proof:hiprt:*` variants drive the HIPRT light-math
  warm proof directly with `SYNTHI_HIPRT_WARM_MODE/PROFILE_PATH`.

**Ledger / contract self-checks (no GPU needed — CI-runnable)**

- `proof:adversarial-ledger:self-check` →
  `gpu-hmr-adversarial-proof-ledger-self-check.mjs` (1485L) — adversarial battery:
  forged/cloned/serialized ledger inputs must fail `queryGpuHmrLedgerInvariants`;
  missing any of the 15 timing fields, visual/compute oracle artifacts, or model
  provenance flips `gpuHmrSuccess` false. This was the preflight gate for the live
  validation driver.
- `proof:acceptance-contract:self-check` → `gpu-hmr-acceptance-contract-self-check.mjs`
  (766L) over `lib/gpu-hmr-acceptance-contract.mjs` (2172L): the route classifier
  vocabulary (`ROUTES = {gpu_hmr, cpu_hmr_or_host_reload, full_rebuild_required,
  reject}`, artifact kinds hsaco/spirv/wgsl/cuda_cubin/…, retirement proofs
  stream_event_proven / queue_idle_proven / frame_boundary_proven / …).
- `proof:strict-gates:self-check` → `gpu-hmr-proof-strict-gates-self-check.mjs`
  (592L + lib 310L).
- `proof:visual-evidence:self-check`, `proof:generated-split-granularity:self-check`,
  `proof:validation-matrix[:self-check]`, `proof:timing-metrics[:self-check]` — smoke
  tests under `scripts/tests/` over their libs (`gpu-hmr-visual-evidence.mjs` blank/
  stale-frame rejection logic; `gpu-hmr-validation-matrix-ledger.mjs` aggregates all
  past validation runs into one ledger report with `latestPerTarget` selection).

**Backend preflights (per-stack capability discovery)**

- `proof:{oidn,opencl,vulkan,webgpu}:preflight[:self-check]` → small drivers
  proving each backend's toolchain/runtime presence generically before any HMR claim;
  `proof:webgpu:runtime-visual[:self-check]` extends to WGSL runtime visual evidence.

**External projects**

- `proof:external-project[:dry-run|:bevy]` → `gpu-hmr-external-project-profile.mjs`
  (1842L): validates the pipeline against arbitrary external repos (e.g. Bevy WGSL
  shader material profile), reusing the same visual-evidence + adversarial preflight +
  timing-metrics libs; `--dry-run` proves planning without execution.

**Phase deep-test shells** (`gpu-hmr-phase0-deep.sh` 367L, `phase1-py-deep.sh` 433L,
`phase1-rs-deep.sh`, `phase2-rs-deep.sh`, `phase3-rs-deep.sh`) — container-oriented
end-to-end checks per plan phase (P0.x nvcc/sm_120 visibility, Python manifest
round-trips, Rust manager unit suites…).

Other large harnesses present but not npm-exposed as `proof:*`:
`gpu-hmr-test.mjs` (4966L), `gpu-hmr-scale-validation.mjs` (4065L),
`gpu-hmr-agent-split-workspace-test.mjs` (2475L),
`gpu-hmr-dynamic-workspace-test.mjs` (930L), Dojo `proof:dojo*` family (separate
product line, shares only the naming convention).

**Repo-root `scripts/`**: `start-gpu-stack.sh|.ps1` (230/212L) — compose up of the
GPU worker image (`vectant-ade-worker-gpu:local`, ROCm 7.2.1, gpu-hmr feature) with
`--pull/--build/--image` flags; readiness gate is `rocminfo | grep gfx1201` inside
`vectant-ade-worker-1`. The remaining root scripts (codesite/live-* proof shells,
deploy, etc.) belong to other areas and are out of scope here.

---

## 5. Cross-stage data shapes

### 5.1 Compile request → routing

`worker/src/infra/messages.rs:L52-L121` — `CompileRequest`:
`language/filename/source/session_id/files[FileEntry{name,content}]/file_refs[FileRef{
name,sha256?,bytes?}]/is_gui/width/height/supports_h265/use_ai_split/bypass_ai_split_
cache(aliases force_ai_split, force_fresh_ai_split, require_fresh_ai_split)/user_
requested_ai/user_requested_deterministic/force_gpu_ai_delta/prefer_gpu_pipeline
(default true)/gpu_mode/gpu_arch(e.g. "gfx1201")/compile_manifest(alias "manifest";
same JSON shape as sidecar's compile_manifest block)/target/project_root/slug`.

Routing consequences: GPU detection + `prefer_gpu_pipeline && gpu_mode != disabled`
⇒ split/gpu call; `force_gpu_ai_delta=true` bypasses the deterministic device fast
path for verifier exercises; `bypass_ai_split_cache` forces a fresh model call so
model-provenance claims are provable; an inline `compile_manifest` lets
deterministic callers skip AI entirely.

### 5.2 Split sidecar (`.synthi_split_meta.json`)

Written by ai-engine (`agents/build_manifest.py`), read by the worker. Top level:
roles (shared/core/gui/host_runner/device file names + contents),
`source_baseline_hashes` per user file, provenance (model/request ids),
verification summary, and **`compile_manifest`** = the `CompileManifest` struct of
[[#3.2-Split-request-handling-manifests]]. `gpu_prod_contracts.normalize_split_sidecar`
then derives/normalizes: `schemaVersion=synthi.gpu.split_sidecar.v1`,
`selectedCompileCommand`, `effectiveFlagsHash`, `toolchainCapabilities`+
`toolchainCapabilityProfileHash`, `targetIdentity`, `sourceBaselineHashes`,
generated/device roles with mapping reports, launch-indirection report,
fault policy, memory refresh policy. Every derived field carries its own hash so the
arbiter can detect staleness (`toolchain_capability_stale`,
`template_evidence_stale`, `candidate.stale_source_generation` …).

### 5.3 Reload plan / arbiter decision

`synthi.gpu.reload_plan.v1` card: `{ plan: warm_rebuild|device_only|ai_delta|
cold_restart|full_resplit|unsupported, reasonCodes[], estimates }` feeding
`decide_arbiter` which outputs `{ arbiterDecision: auto_run|ask_developer|fallback|
skip, selectedPlan, reasonCodes[], rankedOptions[], consentRequired, consentReason }`.
Reason codes are registry-checked strings from [[#1-Python-engine]] — the Rust side
never invents codes; unknown ones fail loudly.

### 5.4 Epoch publish/retire log lines

Single-line `[gpu-runtime-boundary] dispatcher_epoch event=published|retired
runtime_session=… publish_timestamp_ms=… previous_generation=… active_generation=…
old_artifact_id=… new_artifact_id=… drain_scope=… streams=[…] synced=…
retirement_strategy=… delayed_unload=…` plus a parallel
`epoch_generation_graph_line` JSON object. These lines are what the TS classifier
and the harnesses parse into epoch-swap proof obligations — deliberately
machine-parseable, single-writer, monotonic generation counters.

### 5.5 Proof telemetry → wait_hmr → ledger

Worker `GpuHmrProofTelemetry` (serde camelCase) ⇄ TS `GpuHmrProofTelemetry` —
`resultState` ranked 1–9, `degradedState` caps the effective rank; `wait_hmr`
requires ≥ N or full-runtime; the embedded acceptance ledger
(`synthi.gpu.hmr.proof_ledger.v1`) binds every artifact tuple to
`(epoch, dispatch_id, process_identity, sha256)` and is checked by
`queryGpuHmrLedgerInvariants` before a match succeeds. Failure/refusal paths emit
their own ledger records (`refusal_proven`) so refusals are durable evidence too.

### 5.6 Reason codes end-to-end

Registry (`reason_codes.json`, 138 codes) ← producers: broker verify/promote paths,
fission verifier (`fission.*`, 60 codes), fast path rejections
(`edit.not_device_source`, `mapping.source_baseline_stale`,
`parser.device_ast_parse_failed`), readiness/target phases, runtime verification
(`gpu_driver_tdr`, `gpu_device_tainted`), promotion guards
(`stale_launch_pointer_detected`, `candidate.verification_record_mismatch`).
Consumers: arbiter consent decisions, failure-card templates, MCP terminal cards,
validation-matrix ledger grouping. Severity/blocking flags decide promote vs reject;
`safeFallbackMode` names the sanctioned fallback per code.

---

## 6. Invariants worth remembering (cross-cutting)

1. **Identity binding everywhere**: artifact hash ↔ epoch ↔ dispatch id ↔ process
   identity appears at every stage boundary (ledger invariants, capsule metadata,
   epoch lines). Anything that can't be bound is degraded, not accepted.
2. **Dual discipline**: host swap (slot A/B libraries) and device swap (module
   primary/standby/partials) are separate mechanisms coordinated by Mixed-plan
   step ordering (device_save → host_swap → device_load → device_restore).
3. **Retirement is deferred**, publication is immediate: new handles go live first,
   the old module unloads only after drain fences prove quiescence
   (`dispatcher_epoch event=published` then `event=retired`).
4. **Deterministic-first**: fast path + repair loops + Tier-0 binary patches exist
   specifically to avoid AI/model calls; AI is Loop B with gates, budgets, circuit
   breakers, and full provenance capture.
5. **gfx1201 quirks are data-driven workarounds** (path-load vs data-load on ROCDXg,
   unbundling to raw hsaco, criu-amdgpu probing) encoded as generic behaviors keyed
   off manifests/probes — no architecture-name branching exists in authority paths.

## Related notes
- [[gpu-hmr]] — system-level narrative and live-run history.
- [[area-rust-webrtc]] — worker shell around `src/hmr/`.
- [[area-ai-engine]] — ai-engine service hosting the split endpoints.
- [[area-mcp-synthi]] — MCP server hosting the proof tools.
