# GPU HMR Universal Acceptance And Proof Ledger Plan

Draft date: 2026-06-07

## 1. Purpose

This plan hardens GPU HMR from "validated on several friendly profiles" into a system that can safely accept broad real-world GPU projects without hardcoded project branches or false success.

The target is not universal success for every repository. CPU-only projects and host-only edits in GPU projects must continue through CPU/core HMR. The target is:

```text
arbitrary user project
  -> classify project and edit kind
  -> derive a typed GPU HMR contract when GPU HMR is plausible
  -> verify the contract with static and runtime probes
  -> accept only evidence-backed fields
  -> rebuild the smallest safe GPU fission island
  -> load the changed artifact into the same running process
  -> publish it through an epoch-graft path
  -> prove dispatch used the new epoch
  -> prove output came from the new epoch
  -> reject loudly when any required proof is missing
```

The system must be hostile to fake GPU HMR success. Logs, compile output, AI assertions, and screenshot existence are not authoritative proof. They are evidence inputs to a structured proof ledger.

### 1.1 Operational Diagnosis

The validation framework is strong as a proof system, but it is not yet good enough as an everyday development loop. It is currently optimized to be hostile to fake success, which is correct, but the proof path is too coupled to the interaction path.

The fast path must be:

```text
edit -> compile -> load -> epoch publish -> visible change
```

The proof-finalization path must be asynchronous:

```text
artifact hashing -> image decode -> pixel diff -> ledger recompute -> matrix ingestion -> docs/proof packaging
```

The UI should be able to report `HMR applied, proof pending` after epoch publication and lightweight oracle scheduling, while strict mode can still block until the full proof ledger closes. This is the same evidence model with different blocking behavior; it is not a weaker acceptance mode.

The timing evidence already shows the gap. Some edit-visible paths complete in tens to low hundreds of milliseconds, while total validator wall time can be seconds or minutes. When a real ROCm runner waits the full proof window for runtime stages that are structurally absent, the delay is orchestration and proof scheduling, not GPU execution.

Highest-leverage operational fixes:

1. Offload visual validation to worker threads or processes, preferably a Rust visual proof worker or Rust-backed N-API path for PNG decode, hashing, ROI diff, perceptual diff, and proof-card rendering.
2. Make visual proof incremental through deterministic oracle regions, tile hashes, changed ROIs, and full-frame escalation only when the incremental proof is missing or ambiguous.
3. Move heavy artifacts through shared content-addressable storage instead of synchronous `docker cp`, base64 WebSocket payloads, or stdout JSON blobs.
4. Separate interactive HMR from investor-grade proof packaging: dev mode can surface applied/pending state, while strict acceptance still waits for the ledger.
5. Add timeout intelligence so structurally impossible or absent runtime stages fail fast with precise gaps instead of burning a long proof window.

This performance work must not weaken proof gates. It makes the proof ledger asynchronous, content-addressed, incremental, and transport-aware while preserving fail-closed acceptance.

Current implementation note:

```text
2026-06-28: `synthi_wait_hmr` now exposes a generic proof-pending dev-loop contract for non-strict applied HMR responses. The response can carry `proof_pending=true` and `gpu_hmr_dev_loop.evidence_authority=hmr_fast_path_only_not_gpu_hmr_acceptance`, with `accepted_for_gpu_hmr=false` and `gpu_hmr_success=false`. Strict callers still request `requiredGpuProofState` or `requireGpuFullRuntimeProof` and still fail closed with `gpu_hmr_proof_insufficient` when the proof ladder is missing or insufficient.

2026-06-28: strict `synthi_wait_hmr` now has generic post-apply timeout intelligence. After HMR reaches `applied`, an observed matching proof slice that is structurally incapable of satisfying the requested strict proof state can return immediately with `gpu_hmr_proof_insufficient`, `gpu_proof_wait.status=failed_fast`, and `proof_wait_timeout_intelligence.evidence_authority=strict_proof_wait_timeout_intelligence_not_gpu_hmr_acceptance`. Missing proof or lower-rank partial proof still waits for a later valid strict proof. This reduces dead wait windows without turning refusal evidence into GPU HMR acceptance.

2026-06-28: the real ROCm proof scheduler can now skip async runtime waits only when generic upstream lifecycle evidence already proves runtime stages are absent and the row is already fast-failed as refusal-only proof-scheduling evidence. The emitted `real_rocm_proof_scheduling` and `timeout_intelligence_failure` facets set `skip_async_runtime_waits=true`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; the validation matrix rejects forged skip flags unless they are tied to fast-fail scheduling plus `proof_scheduling_upstream_lifecycle_runtime_absent`. This is an orchestration optimization, not a success path.

2026-06-28: the large real ROCm path now emits a generic plan-only `real_rocm_app_hook_materialization` facet. It is derived from profile proof obligations, runner-observed source-delta execution, device-sidecar candidates, compile-bridge evidence, output-oracle materialization, and per-stage app-hook plans for `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. The facet is recorded in retained reports, runtime proof artifacts, proof summaries, matrix rows, and per-target coverage, but it explicitly remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`. The matrix rejects forged materialization facets that claim runtime, dispatch, or GPU HMR authority.

2026-06-28: CAS artifact locators now support portable content-addressed consumption across container mount namespaces. A producer can omit its absolute `storage.localPath`; a consumer can resolve `sha256/<prefix>/<digest>` under its own allowed CAS root and still verify byte length plus SHA-256 before transport evidence accepts. Optional shared mount metadata records generic roles such as worker/MCP/frontend without becoming proof authority. CAS/shared-addressing evidence remains `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`.

2026-06-28: large real ROCm source-tree transport now emits a generic `synthi.real_rocm.source_tree_transport.v1` facet with Git tree/listing identity, source-tree manifest hash, optional CAS artifact locator validation, and explicit hot-path transport gaps. The facet is source transport integrity evidence only. It cannot satisfy runtime proof, dispatch proof, epoch publication, host identity, app-hook, or output-oracle acceptance; the matrix rejects forged source-tree transport facets that claim GPU HMR, runtime, or dispatch authority.

2026-06-28: frontend, MCP, and worker compose services now share a generic bind-mounted artifact CAS root at `/var/lib/synthi/artifact-cas`, and the large real ROCm runner can stage source trees through declared shared-mount metadata instead of falling back to `docker cp`. When no explicit mount JSON is supplied, the runner derives the compose-default local root `mcp/synthi-mcp/.gpu-hmr-shared-cas` plus worker/MCP/frontend roots under `/var/lib/synthi/artifact-cas`; explicit env remains the override for other deployments. The current MIOpen run `gpu-real-rocm-MIOpen-20260628193652` recorded `transfer_operation=cas_shared_volume`, `hotPathOptimized=true`, four shared roles, a worker-inspected matching Git commit, and no transport blocking gaps. This remains transport integrity evidence only: `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`.

2026-06-28 previous transport checkpoint: the large real ROCm source-tree transport facet now resolves its CAS artifact root from the same generic shared-source-tree producer mount used to stage the repo. This prevents a split-brain result where the repo is staged through `cas_shared_volume` but the transport facet falls back to `serialized_fallback` because no separate CAS-root env var was set. The MIOpen rerun `gpu-real-rocm-MIOpen-20260628-cas-transport-rerun` recorded `transferOperation=cas_shared_volume`, `transportKind=cas_shared_volume`, `hotPathOptimized=true`, `acceptedAsTransportEvidence=true`, `sharedMountCount=4`, `sharedStorageAccepted=true`, `sourceTreeCasRootSource=resolved_source_tree_mount_producer_root`, `blockingGaps=[]`, and `failedGates=[]`. It still correctly refused GPU HMR because runtime artifact transport, epoch publication, dispatch trace, host identity, app-hook/runtime-oracle proof, and post-dispatch output/visual oracle proof were absent.

2026-06-28 latest large-ROCm rerun: subagent audit confirmed that the next generic MIOpen blocker is the real upstream `half/half.hpp` prerequisite, not a Synthi proof gate. The fresh run `gpu-real-rocm-MIOpen-20260628193652` again used `cas_shared_volume` source-tree transport with `hotPathOptimized=true`, `acceptedAsTransportEvidence=true`, `sharedMountCount=4`, and no transport blocking gaps, then failed closed on `missing_build_dependency=half/half.hpp`, the generic missing-dependency probe gap `missing_dependency:half_half.hpp`, and missing runtime artifact transport, epoch publication, dispatch trace, host identity, app-hook contract, and output-oracle proof. The current matrix row is `gpu-validation-matrix-row:sha256:1412f486d31f4f6bcf7f9f9850a37ac0859f5be1605f9e03809a5d24a5f82f0b` with runtime proof `gpu-runtime-proof:sha256:f5e78adb4ca5011aa8c003736976329fb22026d5ea6684f5e903f5d2980a508c`, ledger `gpu-ledger-proof:sha256:d46f7e2837b3ca0f6bfbcb5e3bee20836dbea96851204635180c9f76c1fe1f0c`, validation proof `real-rocm-validation:sha256:369c0c2aec2cbdd1f093cc79d9c7ddef854b515c0508cc1f5b967b748e422d34`, and target-progression ledger `target-progression-ledger:sha256:7b52dfda8ef860ed877bcc2a049fd42c3885724f45496fb3cbfd755ee9bbe226`. No visual proof is claimed for this compute/upstream-lifecycle profile because no frame-gated visual oracle exists and screenshot attempts captured no frame.

2026-06-28 missing-dependency probe hardening: large real ROCm retained reports now carry a generic read-only `synthi.real_rocm.missing_dependency_probe.v1` facet when upstream lifecycle evidence reports missing headers/tools/packages. The worker probe only inspects declared/recovered include roots and generic system include roots; it does not install packages, add symlinks, vendor headers, or branch on project names for success. The facet is recorded in runtime proof artifacts, proof summaries, top-level real ROCm verdicts, and matrix rows as refusal evidence only. Any present missing-dependency probe blocks `gpuHmrSuccess` at the runtime-artifact, summary, real-ROCm verdict, and validation-matrix layers, and forged probes that claim GPU HMR/runtime authority are rejected.

2026-06-28: the source-first agent-split proof runner MCP client sends newline-delimited JSON for the installed Node MCP SDK and can parse either newline-delimited or Content-Length-framed MCP responses. A direct docker MCP initialize probe passed on the newline path. This is generic stdio transport compatibility only; it cannot satisfy artifact transport, epoch, dispatch, oracle, or ledger acceptance gates.

2026-06-28: the source-first agent-split proof runner now exposes first-class npm scripts (`proof:agent-split:source-first`, `proof:agent-split:source-first:self-check`, `proof:agent-split:source-first:seed-only`, and `proof:agent-split:source-first:realistic-raytrace`). The runner-level source-first provenance gate now requires generated artifacts to live in the generated artifact namespace before it can emit accepted provenance-only evidence, and the self-check covers both a valid multi-file source tree and a forged ordinary source path such as `src/generated-device.hip`. This remains provenance-only evidence; strict GPU HMR acceptance still requires the runtime ledger and output oracle.

2026-06-28: the realistic raytrace source-first profile now declares a multi-file source tree (`src/main.cpp` plus `src/scene_config.h`) with explicit sha256 hashes. This is a generic source-tree manifest exercise, not a profile-name shortcut. The profile self-check passed again, source-first seed-only created workspace `gpu-agent-split-1782675324866` from source without a precompiled project, and the current two-file realistic rerun created workspace `gpu-agent-split-1782675331957` before failing at the provider-preflight gate because the configured model provider returned `ai_provider_account_suspended`. That failure is infrastructure evidence only and does not supersede the previous accepted source-first visual proof.

2026-06-28 follow-up: provider availability is now preflighted immediately before provider-backed source-first AI split calls, after deterministic/source-owned split paths. Provider/account/auth/rate/timeout failures are emitted as typed diagnostic-only reason codes such as `ai_provider_account_suspended`, redacted before JSON/TXT artifact writes, and cannot satisfy AI split, runtime epoch, visual proof, or GPU HMR ledger gates. The latest two-file realistic source-first rerun `gpu-agent-split-1782675331957` failed closed in the provider-preflight path with `source-first-provider-diagnostic:sha256:dec0f1aa6adfa3903bac78832b4ce974095b4b6bdce72f69df61e8bad54e002a`, `reasonCodes=["ai_provider_account_suspended"]`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`. It produced no visual HMR artifact because the AI split did not complete.

2026-06-28 latest source-first user-path check: subagent audit confirmed there is no provider-free realistic AI split/HMR success path that would remain honest while the provider account is suspended. `proof:agent-split:source-first:seed-only` passed again and created `gpu-agent-split-1782675324866` from source without a precompiled project; this proves workspace seeding only. `proof:agent-split:source-first:realistic-raytrace` then seeded the two-file realistic raytrace source tree into `gpu-agent-split-1782675331957`, attached MCP, and failed closed before AI split verification with the same typed diagnostic `source-first-provider-diagnostic:sha256:dec0f1aa6adfa3903bac78832b4ce974095b4b6bdce72f69df61e8bad54e002a`, `reasonCodes=["ai_provider_account_suspended"]`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, `canSatisfyRuntimeProof=false`, and no visual HMR artifact. This keeps the source-first path honest: provider/account failure is refusal evidence only, not a fallback split or runtime proof.

2026-06-28 visual CAS validation follow-up: the validation matrix no longer accepts visual CAS locators by shape alone. Visual artifact evidence validates each `synthi.cas.artifact_locator.v1` manifest with readable-byte SHA-256 checks under allowed repo/log/CAS roots, can decode before/after/diff PNGs from CAS-only `sha256/<prefix>/<digest>` paths when local artifact paths are absent, and refuses forged relative paths or hash mismatches with `visual_artifact_cas_locator_validation_failed` / `visual_artifact_cas_locator_hash_mismatch`. The `asyncVisualCasBundle` support facet now derives its accepted transport hashes from matrix-validated CAS locators. This is generic transport/oracle-byte validation only; CAS locators, worker metrics, tile evidence, and support facets remain `acceptedForGpuHmr=false` and `gpuHmrSuccess=false` without strict runtime-ledger closure.

2026-06-28 external visual-profile follow-up: external runtime and MCP preview profile producers now emit report-level content-addressed `before_image_hash`, `after_image_hash`, and `diff_image_hash` fields alongside the visual artifact paths. The matrix still recomputes PNG bytes through the async visual proof worker and refuses path-only or forged-hash reports. The current ThreeJS WebGL shader-lava rerun is therefore `external_engine_visual_profile` coverage only: `visual_profile_accepted`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, row `gpu-validation-matrix-row:sha256:b151fc42dc398097e5ae678220664e136fd56e94f582a87d58ed63585e700af6`, proof `external-visual-proof:065da55a0849250968926125e2756025c38e17985bea6606f9bc7639778818f6`, and matrix `gpu-validation-matrix-ledger:sha256:d1f938f28a9ad22d8939934684d133fcec53340be09aac0c34c1d549f840af38`. This is not a target-name shortcut and not full-runtime GPU HMR; strict acceptance still requires the same loader, epoch, dispatch, host-identity, output-oracle, and runtime proof ledger gates.

2026-06-28 latest matrix after CAS-validated visual locator ingestion, source-first, and MIOpen missing-dependency rerun: `gpu-validation-matrix-ledger:sha256:d1f938f28a9ad22d8939934684d133fcec53340be09aac0c34c1d549f840af38`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260628T195143Z.json`, 56 rows, 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime GPU HMR rows, 14 all full-runtime rows, 29 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, 1 preflight-only row, and 0 included unproven rows. Scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8. `per_target_run_modes status=accepted`. Broad readiness remains `accepted=false`.

2026-06-28 latest history audit: `gpu-validation-matrix-ledger:sha256:166ac140823c6b092ac97627fcff65d238a1d7911d82ba2948f0795dbefd1bbd`, JSON `mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260628T195522Z.json`, 678 rows, 622 historical unproven rows, 14 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 14 scoped full-runtime GPU HMR rows, 14 all full-runtime rows, 29 refusals, 7 cold splits, 2 deterministic fission rows, 3 visual-profile rows, and 1 preflight-only row. History scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8.

2026-06-28 latest timing telemetry: `mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260624T093916Z.json`, count=21. The timing metrics are telemetry only, `evidenceAuthority=timing_telemetry_only`, and `proofVerdict=not_evaluated_by_timing_summary`.
```

## 2. Immediate Corrections To The Previous Plan

### 2.1 Delta model requirement

The previous plan treated `gemini-3.1-flash-lite-preview` as non-negotiable for GPU delta edits. That is no longer a valid public requirement.

Provider status check:

- Source: Google AI Gemini API deprecations page, `https://ai.google.dev/gemini-api/docs/deprecations`.
- Checked by Codex on 2026-06-07.
- `gemini-3.1-flash-lite-preview` is listed as shut down on 2026-05-25 with replacement `gemini-3.1-flash-lite`.
- `gemini-3.5-flash` is listed with no shutdown date announced.

Correct model policy:

```text
default split model: gemini-3.5-flash
default GPU delta model: gemini-3.1-flash-lite
preview delta model: forbidden unless provider availability check proves it is live in this environment
```

Every AI call and every timing report must record more than requested/actual/fallback. Required fields:

```yaml
model_provenance:
  provider: google_gemini
  requested_model:
  provider_model_status:
    value: available | deprecated | shutdown | unknown | private_alias
  provider_model_alias_resolved_to:
  provider_shutdown_or_deprecation_detected: true | false
  model_availability_checked_at:
  actual_model:
  fallback_model:
  fallback_used: true | false
  request_mode:
    value: split | gpu_delta | heal | contract_hint | oracle_hint
  hard_infra_failure: true | false
```

Acceptance rule:

```text
If the configured delta model is shutdown and no private alias is proven, GPU HMR validation must fail as an infrastructure failure. It must not silently fall back and still claim the requested model path was tested.
```

### 2.2 AI is not an authority

AI may propose a contract. AI may propose a fission island. AI may propose an oracle. AI may propose adapter code.

AI must not authorize any GPU HMR contract field.

Correct authority order:

1. Runtime traces.
2. Compiler and code-object metadata.
3. Build-system metadata.
4. AST or structured source analysis.
5. Naming conventions.
6. AI inference as a hint only.

Only verified fields may enter acceptance. Unverified AI fields stay in `ai_hints` and cannot satisfy proof gates.

### 2.3 CPU HMR versus GPU HMR firewall

GPU HMR success must be impossible if CPU/core HMR handled the edit.

Proof invariant:

```yaml
gpu_hmr_success: true
requires:
  cpu_hmr_used: false
  process_restarted: false
  full_rebuild_used: false
  changed_gpu_artifact_hash_loaded: true
  loaded_artifact_hash_published_as_epoch: true
  dispatch_used_published_epoch: true
  output_oracle_observed_after_epoch_dispatch: true
```

Host-only edit inside a GPU project must be represented as:

```yaml
project_kind: gpu_project
edit_kind: host_only
route: cpu_hmr_or_host_reload
gpu_hmr_success: false
gpu_runtime_unchanged: true
```

This distinction is mandatory in UI, logs, proof artifacts, and metrics.

## 3. Acceptance Contract Schema

The acceptance contract must describe both the project and why GPU HMR is safe. It is not enough to say "there is a GPU artifact."

Required top-level fields:

```yaml
contract_version: synthi.gpu_hmr.contract.v1
contract_id:
contract_hash:
project_id:
edit_id:
backend:
  value: hip | hiprt | opencl | vulkan | webgpu | bevy_wgsl | cuda | sycl | unknown
confidence:
evidence_refs: []
ai_hints: []
unsupported_reasons: []
failure_mode:
  value: reject | gpu_hmr_unsupported | full_rebuild_required
classification:
  project_kind:
    value: cpu_project | gpu_project | mixed_project | unknown
  edit_kind:
    value: gpu_artifact_edit | host_only | mixed_host_gpu | build_system | config | unknown
  route:
    value: gpu_hmr | cpu_hmr_or_host_reload | full_rebuild_required | reject
  confidence:
  blocking_gaps: []
```

Required artifact fields:

```yaml
artifact_identity:
  source_paths: []
  artifact_kind:
    value: hsaco | hip_source_bridge | spirv | wgsl | glsl | opencl_program | cuda_cubin | cuda_ptx | sycl_bundle | unknown
  entry_points: []
  compile_target:
  compiler:
  compiler_args_hash:
artifact_hash_before:
artifact_hash_after:
unaffected_artifacts_hash_unchanged: true | false
```

Required ABI fields:

```yaml
abi_compatibility_class:
  value: compatible | additive | layout_changed | unknown
  evidence_refs: []
  notes:
abi_metadata:
  args:
    - name:
      type:
      size:
      offset:
      value_kind:
      access:
      address_space:
      source: code_object | compiler_metadata | ast | runtime_trace | ai_hint
  descriptor_or_binding_layout:
  workgroup_or_launch_shape:
  stream_or_queue_requirements:
```

Important ABI warning:

HIP and AMDGPU code objects can expose argument metadata such as name, type, size, offset, value kind, and access fields. Those fields are useful evidence, but they do not prove semantic compatibility by themselves. Alias behavior, wrapper allocators, hidden layout dependencies, and framework handles can still make a syntactically compatible change unsafe.

ABI gate:

```text
compatible or additive ABI can proceed only when runtime dispatch and output oracle proof also pass.
layout_changed or unknown ABI must reject GPU HMR unless a backend-specific adapter and runtime probe explicitly prove safety.
```

Required reload fields:

```yaml
reload_mechanism:
  value: built_in | generated_adapter | api_interpose | engine_asset_reload | unsupported
adapter_outcome:
  value: adapter_generated | adapter_not_needed_builtin_reload | adapter_impossible_requires_app_hook
reload_evidence_refs: []
dispatch_trace_required: true
oracle_trace_required: true
```

Required state-preservation fields:

```yaml
state_preservation_checks:
  process_id:
  device_uuid:
  context_or_device_handle:
  queue_or_stream_handle:
  persistent_gpu_allocations:
  engine_scene_handles:
  camera_state_hash:
  swapchain_or_framebuffer_identity:
```

Required epoch fields:

```yaml
epoch_policy:
  publish_mechanism:
  dispatch_binding:
  retirement_mechanism:
epoch_retirement_proof:
  value: stream_event_proven | queue_idle_proven | frame_boundary_proven | no_retirement_required | unproven
  evidence_refs: []
```

## 4. Backend-Specific Contract Requirements

### 4.1 HIP and ROCm

HIP direct launch discovery is plausible because the APIs expose concrete launch boundaries:

- `hipLaunchKernelGGL`
- `hipModuleLoad`
- `hipModuleGetFunction`
- `hipModuleLaunchKernel`

Required HIP evidence:

```yaml
hip_contract:
  kernel_name:
  launch_api:
  grid_dim:
  block_dim:
  shared_mem_bytes:
  stream:
  kernel_params:
  code_object_metadata:
  output_buffers:
  readback_oracle:
```

Buffer direction inference order:

1. Runtime trace of allocations, copies, maps, dispatches, and readbacks.
2. Compiler and code-object metadata.
3. AST evidence.
4. Naming conventions.
5. AI inference, never authoritative.

Static analysis alone must not claim reliable read/write direction in C++ with aliasing, templates, wrapper allocators, custom memory pools, or opaque framework handles.

### 4.2 HIPRT

HIPRT is intentionally low-level. Applications own scene representation, BVH lifecycle, material buffers, camera state, and framebuffer ownership. The system must not pretend those are generically inferable.

Required HIPRT evidence:

```yaml
hiprt_contract:
  kernel_entry:
  scene_or_bvh_handles:
  framebuffer_handle:
  material_or_geometry_buffers:
  camera_state_hash:
  same_process_reload_hook:
  visual_oracle:
```

If scene/BVH/framebuffer handles cannot be observed or declared through an app hook, acceptance must fail with `adapter_impossible_requires_app_hook`.

### 4.3 Vulkan

Vulkan cannot be modeled as "replace shader module" only. Pipeline use depends on:

- SPIR-V module.
- Entry points.
- Descriptor set layouts.
- Pipeline layout.
- Linked shader stages.
- Vertex input state.
- Render pass or dynamic rendering state.
- Pipeline cache behavior.
- Command buffer recording.

Required Vulkan evidence:

```yaml
vulkan_contract:
  shader_module_hash_before:
  shader_module_hash_after:
  entry_point:
  descriptor_set_layout_hash:
  pipeline_layout_hash:
  pipeline_state_hash:
  command_buffer_re_record_required: true | false | unknown
  command_buffer_re_record_proven: true | false
  frame_used_new_pipeline_trace:
```

Epoch publication of a new pipeline handle is not sufficient when pre-recorded command buffers may reference the old pipeline. Dispatch proof must show the frame used a command buffer or dynamic state path bound to the new epoch.

### 4.4 WebGPU and Bevy WGSL

WebGPU reload is not just "replace WGSL." `createShaderModule()` creates a module from WGSL, but `createRenderPipeline()` binds stages, entry points, layouts, vertex buffers, targets, and render state.

Required WebGPU evidence:

```yaml
webgpu_contract:
  wgsl_hash_before:
  wgsl_hash_after:
  shader_module_epoch:
  entry_points:
  bind_group_layout_hash:
  pipeline_layout_hash:
  vertex_buffer_layout_hash:
  color_target_state_hash:
  pipeline_recreate_required: true | false | unknown
  pipeline_recreate_proven: true | false
  frame_used_new_pipeline_trace:
```

Bevy-specific rule:

```text
Bevy file-loaded WGSL shader assets can be candidates for engine asset reload.
Shaders embedded as static Rust strings, include_bytes, or non-watched embedded assets are not automatically reloadable.
```

Unsupported embedded shader paths must report `adapter_impossible_requires_app_hook`; they must not silently fall back to CPU HMR or full rebuild and still claim GPU HMR.

### 4.5 OpenCL

OpenCL is a useful validator because enqueue success only proves the kernel command was queued. It does not prove useful output.

Required OpenCL evidence:

```yaml
opencl_contract:
  program_hash_before:
  program_hash_after:
  kernel_name:
  command_queue:
  work_dim:
  global_work_size:
  local_work_size:
  event_trace:
  output_buffer_readback:
```

The oracle must observe output after an event associated with the new kernel epoch.

## 5. Classifier Plan

Classifier output must include confidence and hard blockers:

```yaml
classification: gpu_artifact_edit
confidence: 0.82
blocking_gaps:
  - no_runtime_loader
  - no_output_oracle
```

Classifier stages:

1. File and edit scan.
2. Build metadata scan.
3. GPU API and shader API scan.
4. Static source extraction.
5. Runtime probe availability check.
6. AI hint generation if static evidence is incomplete.
7. Contract field verification.

Hard rules:

- A host-only edit in a GPU project is not GPU HMR.
- A compile-only GPU artifact without same-process load proof is not GPU HMR.
- A loaded artifact without epoch dispatch proof is not GPU HMR.
- A dispatch without output proof is not GPU HMR.
- Any CPU fallback must set `gpu_hmr_success=false`.

## 6. Grand Fission Engine Plan

The fission engine must operate on the verified contract, not project names.

Responsibilities:

1. Select the smallest safe GPU rebuild unit.
2. Track dependency closure from build metadata and compiler inputs.
3. Verify ABI compatibility class.
4. Preserve unaffected artifacts.
5. Emit positive and negative proof.
6. Reject when the safe fission island is ambiguous.

Required fission report:

```yaml
fission_report:
  selected_island:
  selected_reason:
  changed_sources:
  included_dependencies:
  excluded_host_sources:
  artifact_hash_before:
  artifact_hash_after:
  abi_compatibility_class:
  full_device_fallback: false
  host_relinked: false
  process_restarted: false
  full_rebuild_used: false
  unaffected_artifacts_hash_unchanged: true
  selected_verifier_evidence_id:
  deterministic_verifier_evidence_refs: []
  selection_decision_hash:
  output_oracle_contract:
  evidence_refs: []
```

Friendly success cases are not enough. The fission engine must also pass hostile tests:

- Kernel argument added.
- Kernel argument reordered.
- Kernel renamed through C++ template mangling.
- Shader bind group layout changed.
- Vulkan pipeline layout changed.
- Pre-recorded command buffer uses old pipeline.
- Output buffer not copied back.
- Visual frame is blank.
- CPU fallback path exists.
- Process silently restarted.
- Full rebuild disguised as partial.

## 7. Epoch-Graft Runtime Plan

Epoch grafting must be API-specific. An atomic pointer swap is not enough.

Common proof sequence:

```text
artifact_after_hash compiled
artifact_after_hash loaded in same process
epoch N published
dispatch trace uses epoch N
output oracle observes data after epoch N dispatch
old epoch retired after backend-specific safety proof
```

HIP retirement:

- `hipModuleUnload` releases module resources and destroys associated code objects.
- Retirement must be protected by stream/event proof or an equivalent synchronization proof.
- The proof must identify the stream and event or state why no retirement is required.

Vulkan retirement:

- Old pipelines may be referenced by pre-recorded command buffers.
- Retirement must prove command buffers using old pipeline handles are no longer in flight or were re-recorded.
- Publishing a new pipeline object is not enough.

WebGPU and Bevy retirement:

- Proof must show the frame used the new shader module or pipeline.
- Asset-system file-change observation is not enough.
- The frame trace must link render output to the new epoch.

## 8. Adapter Synthesis Plan

"Generate or wrap one" is overclaimed unless the launch boundary is interposable.

Common impossible cases:

- Static linked host launch path with no reload hook.
- Engine-internal pipeline cache.
- Opaque render graph.
- Pre-recorded command buffers.
- JIT-managed kernels.
- Framework-generated shaders.
- Shader embedded as Rust `include_str!`, `include_bytes!`, C++ string literal, or generated resource.

Adapter synthesis outcomes:

```yaml
adapter_outcome:
  value: adapter_generated | adapter_not_needed_builtin_reload | adapter_impossible_requires_app_hook
reason:
required_app_hooks: []
evidence_refs: []
```

No silent fallback is allowed. If the adapter cannot be generated and no built-in reload exists, route to `gpu_hmr_unsupported` or `full_rebuild_required`.

## 9. Output Oracle Plan

### 9.1 Compute oracle

The compute proof card is for humans. Machine proof must be raw-data-backed.

Required artifacts:

```yaml
compute_oracle_artifacts:
  raw_readback_bin:
  readback_schema_json:
  checksum_before:
  checksum_after:
  deterministic_slice:
  oracle_code_hash:
  rendered_card_png:
  producer:
  timestamp_after_dispatch:
  epoch:
```

The rendered card must be derived from the raw readback data, not generated independently.

### 9.2 Visual oracle

Required visual proof fields:

```yaml
visual_oracle_artifacts:
  before_image:
  after_image:
  diff_image:
  blank_frame_rejection:
  same_frame_rejection:
  new_epoch_watermark_or_trace:
  camera_state_hash:
  swapchain_size:
  capture_backend:
  frame_number:
  timestamp_after_dispatch:
  perceptual_diff:
  changed_pixel_ratio:
  visible_pixel_count:
```

Pixel diffs are weak by themselves, especially for path tracing, temporal accumulation, TAA, denoisers, camera jitter, swapchain timing, and async presentation. Visual proof must therefore run in a deterministic validation mode whenever the backend can expose one.

Required deterministic validation controls:

```yaml
deterministic_visual_mode:
  fixed_seed:
  frozen_camera:
  temporal_accumulation_disabled:
  taa_disabled:
  denoiser_disabled:
  fixed_resolution:
  fixed_swapchain_image_count:
  frame_capture_after_epoch_dispatch:
  presentation_fence_or_frame_boundary:
  warmup_frames:
  convergence_window:
    frame_start:
    frame_end:
    metric:
      value: per_frame_delta | window_mean_delta | stable_histogram_delta | oracle_region_delta
```

For path tracing and temporally accumulated renderers, a single-frame diff is not enough unless the validation mode disables temporal behavior and fixes the random seed. If temporal behavior cannot be disabled, the proof must use a multi-frame convergence window and show that the post-epoch frames converge toward the expected changed output while the camera, seed policy, and scene state remain fixed.

Expected visual direction is useful but not always available. Acceptable proof modes:

```text
declared_expected_direction
or nonzero perceptual diff plus epoch-tagged dispatch trace
or test-specific visual oracle
```

Screenshot existence alone is not proof. Pixel diff alone is not enough when camera jitter, temporal accumulation, denoising, stale buffers, async presentation, or old frame capture can explain the difference.

## 10. Proof Ledger

The system needs an immutable proof ledger. GPU HMR success must be a query over ledger records, not a boolean returned by a script.

Required ledger record:

```yaml
proof_id:
project_id:
edit_id:
classification:
contract_hash:
artifact_before_hash:
artifact_after_hash:
loader_event:
epoch_publish_event:
dispatch_event:
output_event:
retirement_event:
process_identity:
device_identity:
cpu_hmr_used:
full_rebuild_used:
process_restarted:
oracle_artifacts:
timings:
model_provenance:
evidence_refs:
```

Ledger invariants:

```text
loader_event.artifact_hash == artifact_after_hash
epoch_publish_event.artifact_hash == artifact_after_hash
dispatch_event.epoch == epoch_publish_event.epoch
output_event.after_dispatch_id == dispatch_event.id
cpu_hmr_used == false
full_rebuild_used == false
process_restarted == false
```

If any invariant fails, `gpu_hmr_success=false`.

## 11. Metrics Schema

Use one timing schema across Flow, HIPRT, ROCm, Bevy, OpenCL, Vulkan, and future projects.

Required clock discipline:

```yaml
metric_clock: monotonic_ns
metric_scope:
  value: cold | warm | hot_delta_1 | hot_delta_2
cache_state:
  value: clean | compiler_cache_warm | pipeline_cache_warm
```

Separate wall-clock time from GPU event time. HIP event timing can omit system-scope release and cache flush work, so GPU events must not be reported as total HMR time.

Required timing fields:

```yaml
timings:
  static_discovery_time:
  ai_contract_synthesis_time:
  model_availability_check_time:
  artifact_hash_time:
  adapter_generation_time:
  device_compile_wall_time:
  artifact_load_time:
  epoch_publish_time:
  dispatch_trace_time:
  runtime_probe_time:
  oracle_analysis_time:
  trigger_to_visible_time:
  screenshot_capture_time:
  dispatch_to_output_proof_time:
  total_validator_wall_time:
```

Model provenance fields from section 2.1 must be included in the same ledger entry as the timings.

### 11.1 Validator Fast-Path Performance Plan

The validation framework must distinguish the user-facing HMR fast path from the proof-finalization path:

```text
edit -> compile -> artifact load -> epoch publish -> visible/output-ready signal
```

must not wait on full-frame image decoding, full-matrix proof collection, cross-container binary copies, or archival artifact rendering unless those steps are required before a specific acceptance decision can be emitted. The proof system must still fail closed: a fast visible signal is not GPU HMR acceptance until the strict ledger, dispatch, and output oracle gates pass.

Required performance architecture:

```yaml
validator_fast_path:
  visual_analysis_executor:
    value: rust_worker | napi_rust_worker | node_worker_thread | unavailable
    proof_ready_event_required: true
    executor_identity:
    executable_hash:
    schema_version:
    evidence_refs: []
  incremental_visual_proof:
    roi_or_tile_manifest_required: true
    deterministic_oracle_region_hash_before:
    deterministic_oracle_region_hash_after:
    tile_hash_grid:
      tile_size:
      changed_tile_count:
      total_tile_count:
      changed_tile_hashes: []
    full_frame_diff_required_when:
      - oracle_region_hash_changed_but_bounds_unknown
      - roi_or_tile_manifest_missing
      - deterministic_visual_mode_unproven
      - visual_threshold_result_ambiguous
  artifact_transport:
    value: cas_shared_volume | cas_tmpfs | direct_worker_path | serialized_fallback
    content_address:
    manifest_hash:
    shared_volume_identity:
    producer_container:
    consumer_container:
    byte_length:
    no_docker_cp_required_for_fast_path: true | false
    no_base64_frame_transport_required_for_fast_path: true | false
```

Visual analysis should move out of the main validator event loop. The preferred implementation is a Rust proof worker, either as a standalone binary reached through a durable manifest/proof-ready event, or as a Rust-backed N-API module when embedding is clearly safer. A Node `worker_threads` implementation is acceptable only as an interim executor or compatibility fallback, and it must record that executor identity in proof metadata. Worker execution is a performance mechanism, not an authority shortcut.

Incremental visual proof must be project-agnostic. A profile may declare an ROI only as a typed oracle region with hashes, dimensions, capture backend, deterministic visual controls, and evidence refs. If the ROI or tile manifest is absent, stale, out of bounds, mismatched to the frame hash, or disconnected from the post-epoch capture, the validator must fall back to the stricter full-frame visual proof or reject. It must not infer success from project names, target names, fixture names, or hand-picked pixel regions.

Artifact transport should use content-addressable storage wherever possible. Worker, MCP, and frontend containers should share a bind mount or tmpfs CAS root for heavy proof artifacts such as frames, raw readback bytes, code objects, and rendered proof cards. The fast path should pass only a compact manifest with content addresses, hashes, byte lengths, producer identity, and allowed reader identities. `docker cp`, base64 screenshots over WebSocket, stdout JSON blobs containing binary data, and repeated re-materialization are allowed only as explicit fallback paths and must be recorded as transport limitations in timing/proof metadata.

Acceptance rules:

```text
CAS presence is not proof by itself.
ROI hash change is not proof by itself.
Worker proof-ready event is not proof by itself.
Serialized fallback transport must not be hidden from total validator wall time.
Any missing or mismatched content address, byte length, frame hash, ROI manifest, worker executable hash, or proof-ready event fails closed.
```

Implementation checkpoint, 2026-06-27:

- A reusable async visual proof bundle now writes before/after/diff image artifacts through generic CAS manifests, runs visual decode/diff work in the existing visual proof worker, records tile/ROI-capable async metrics, and emits visual transport evidence as non-authoritative support metadata.
- The WebGPU runtime visual proof runner uses that bundle for real browser-captured frame proof instead of doing the full image diff in the runner path. The strict ledger still accepts only the existing visual oracle artifacts, epoch/dispatch proof, deterministic visual controls, process continuity, and runtime proof artifact gates.
- The async visual proof worker now records a content-addressed worker executable hash and executor identity. The parent runner rejects accepted-looking worker results when the worker proof-ready event is missing, the worker is not proven off the main thread, or the worker executable hash is missing or mismatched.
- The worker executable hash is now a local module-graph hash over the worker entry, parent wrapper, and artifact-CAS helper rather than a single-file hash. Matrix summaries retain the non-volatile executor identity, executable manifest hash, schema, and module count while stripping volatile thread IDs.
- ROI early exit is guarded by tile evidence. An unchanged ROI can skip full-frame diff only when tile hashes show no changed tiles; if changed tiles appear outside or ambiguously around the ROI, or if tile hashing is disabled, the worker falls back to full-frame visual proof instead of treating the ROI hash as sufficient.
- Direct worker paths and diff output paths require explicit allowed roots, and readable CAS local paths are resolved through realpath checks before bytes are consumed. CAS manifests that claim GPU HMR success through camelCase or snake_case fields are rejected as transport-only evidence.
- The agent-split visual proof runner now schedules candidate post-HMR frame comparisons through bounded concurrent worker-thread visual proof tasks instead of awaiting every candidate serially. The generic `SYNTHI_GPU_HMR_VISUAL_WORKER_PARALLELISM` / profile `visualProof.workerParallelism` knob is recorded as `synthi.gpu_hmr.visual_delta_worker_scheduling.v1` support evidence with `acceptedForGpuHmr=false` and `gpuHmrSuccess=false`; strict visual proof still requires the selected before/after/diff artifacts and runtime ledger closure.
- The validation matrix now recomputes before/after visual-pair metrics from async visual-worker output (`matrix_async_visual_worker_rgba`) instead of duplicating the full pair RGBA diff in the matrix process. Worker timeout/failure, dimension mismatch, zero delta, blank after frames, or blank diff images still fail closed; this is generic matrix infrastructure and not a target-specific success path.
- Source-first agent-split proof results now redact key/token/authorization-shaped provider diagnostics before writing console output, latest-result JSON/TXT, or archived result artifacts. Provider failure remains fail-closed and cannot satisfy AI split, runtime epoch, visual proof, or GPU HMR ledger gates.
- Real ROCm proof scheduling now consumes generic upstream lifecycle refusal evidence. Configure/build failures, missing build dependencies, and not-started runs can reduce strict wait windows only as refusal-only `real_rocm_proof_scheduling` evidence; plain upstream run failure does not prove runtime-stage absence, and no timeout-intelligence facet can authorize GPU HMR success. When upstream lifecycle evidence proves runtime stages cannot appear, the runner may skip async runtime waits and emit an explicit `proof_scheduling_skipped_async_runtime_wait` result; the matrix accepts that only as refusal evidence.
- Frontend, MCP, and worker compose services now expose a shared artifact CAS root at `/var/lib/synthi/artifact-cas`, including the NVIDIA override path. The real ROCm runner can derive generic source-tree shared-mount plans from environment-declared roles or from the compose-default shared root, stage a repository under `source-trees/<repo>/<commit>`, inspect the matching Git commit inside the worker, and record `cas_shared_volume` transport evidence. This is a transport optimization and audit facet only; runtime proof gates still require artifact transport into the target process, epoch publication, dispatch trace, host identity, and output-oracle closure.
- CAS transport evidence, ROI/tile hashes, and worker proof-ready events remain `acceptedForGpuHmr=false` support evidence by themselves. They can reduce hot-path blocking and improve auditability, but cannot authorize GPU HMR success without the strict proof ledger.

## 12. Validation Matrix

The matrix must include positive, negative, and ambiguous cases.

Negative and adversarial cases must run before broad success cases. The first validation milestone is not "SAXPY passed"; it is "the system refuses fake GPU HMR."

Phase 1 negative targets:

- Host-only edit in GPU project.
- Mixed host+GPU edit.
- ABI-changing kernel edit.
- Kernel argument added.
- Kernel argument reordered.
- Shader layout-changing edit.
- Vulkan pipeline layout changed.
- Unsupported embedded shader.
- No readback path.
- Process restart.
- Full rebuild.
- CPU fallback.
- Compile success but no dispatch.
- Dispatch success but no output change.
- Visual frame is blank.
- Same frame recaptured after edit.
- Camera jitter creates fake visual diff.
- Temporal accumulation creates nondeterministic diff.
- Old artifact dispatched.
- Readback from stale buffer.
- Async presentation captures pre-epoch frame.

Phase 2 positive targets:

- HIP direct launch.
- HIP module launch.
- OpenCL source rebuild.
- WebGPU WGSL compute.
- WebGPU or wgpu render shader.
- Bevy file-loaded WGSL.
- HIPRT visual path.
- Flow visual GPU path.
- At least one larger engine-style repo.

Per-target required run modes:

```text
adversarial refusal cases first
cold split
hot delta 1
hot delta 2 with a different edit
negative edit
visual or compute oracle proof
ledger invariant query
consistent timing report
```

Passing only friendly targets such as SAXPY, matrix multiply, histogram, prefix sum, HIPRT, Flow, and Bevy is not enough to prove generality.

## 13. Subagent Workstreams

Subagents can be used, but the main thread owns final architecture and code decisions.

Suggested workstreams:

- Subagent A: CPU HMR versus GPU HMR routing audit.
- Subagent B: real project research and backend boundary discovery.
- Subagent C: fission and epoch proof schema review.
- Subagent D: validation matrix runner and artifact collector.
- Subagent E: adversarial validator that attempts false GPU HMR passes.
- Subagent F: validator fast-path performance audit for Rust visual workers, ROI/tile proof, and CAS/shared-volume artifact transport.

Subagent E should explicitly try to create fake successes:

- Compile log counted as proof.
- Old artifact dispatched.
- CPU fallback used.
- Visual diff from camera jitter.
- Readback from stale buffer.
- Process restarted.
- Full rebuild hidden in timing.

Subagent F should explicitly review performance without weakening proof gates:

- Main-thread image decode, full-frame diff, and PNG encode hotspots.
- Base64, `docker cp`, stdout JSON, and repeated file materialization bottlenecks.
- Generic CAS manifest schemas that do not encode project, fixture, backend, or library names.
- ROI/tile visual proof failure cases where stale bounds, camera jitter, blank frames, or pre-epoch captures could fake success.
- Evidence needed to prove that the proof worker itself did not become an untracked oracle.

## 14. Implementation Order

### Step 1: Adversarial refusal harness

Build the negative validator before celebrating additional positive profiles. The harness must prove that fake GPU HMR is rejected when CPU HMR is used, the process restarts, a full rebuild is hidden, an old artifact dispatches, no output is produced after the new epoch, visual frames are blank or stale, or temporal/camera jitter explains the diff.

### Step 2: Deterministic visual oracle modes

Add fixed seed, frozen camera, temporal accumulation disablement, TAA/denoiser disablement where available, presentation-fence capture, and multi-frame convergence windows for path tracing and temporal renderers.

### Step 3: Model availability gate

Replace dead preview delta-model defaults with `gemini-3.1-flash-lite`, add provider model status fields, and fail loudly when a configured model is shutdown.

### Step 4: Contract schema and classifier output

Introduce the full acceptance contract schema, classification confidence, hard blockers, unsupported reasons, and CPU/GPU routing firewall.

### Step 5: Proof ledger

Emit immutable proof records and derive `gpu_hmr_success` from ledger invariants.

### Step 6: ABI compatibility class

Add ABI metadata extraction and classify edits as `compatible`, `additive`, `layout_changed`, or `unknown`.

### Step 7: Runtime dispatch and oracle gates

Require dispatch trace and oracle trace for GPU HMR acceptance. Move screenshot/readback artifacts into the ledger.

### Step 8: Backend-specific compatibility

Implement HIP/HIPRT first, then OpenCL, then WebGPU/Bevy, then Vulkan. Vulkan requires the strongest pipeline-layout and command-buffer proof.

### Step 9: Positive validation matrix expansion

Only after the adversarial refusal harness passes should the matrix broaden scoped positive candidates across HIP, HIPRT, OpenCL, WebGPU, Bevy, Flow, Vulkan, and larger engine-style projects.

### Step 10: Timing normalization

Unify all validation scripts under the monotonic metric schema.

### Step 11: Validator fast-path performance

Move heavy visual validation and binary artifact transport off the main validator path without changing acceptance semantics.

Implementation order:

1. Introduce executor metadata and proof-ready event schemas for visual analysis.
2. Add a background visual proof worker path, preferably Rust or Rust-backed N-API, with a Node worker fallback only when recorded explicitly.
3. Add typed ROI/tile manifests and deterministic oracle-region hashes.
4. Add CAS/shared-volume manifests for frames, raw readbacks, code objects, and proof cards.
5. Keep serialized base64 and `docker cp` paths as measured fallbacks, not the preferred fast path.
6. Require validation matrix self-checks for forged ROI hashes, stale tiles, missing CAS bytes, mismatched byte lengths, wrong worker executable hashes, and proof-ready events without ledger output.

### Step 12: Source-first uncompiled project validation

After the scoped profile/runtime rows and fast-path proof worker gates are stable, test the user-facing path from source/project input instead of precompiled device artifacts.

Required behavior:

1. Ingest an uncompiled project or workspace source tree without assuming a pre-existing generated `.hip`, WGSL, HSACO, shader module, or code object.
2. Let the AI split/proposal path derive GPU candidates, but keep every AI field as a hint until verified by compiler, build metadata, runtime trace, and output oracle evidence.
3. Compile the proposed smallest safe GPU artifact through the normal backend toolchain.
4. Publish a real runtime epoch and prove post-epoch output with visual or compute oracle artifacts.
5. Preserve generic failure modes when the source tree lacks enough GPU evidence, build metadata, backend runtime, app hook, or output oracle proof.
6. Record visual proof when the source-first path produces a visual target; logs alone cannot satisfy this milestone.

This step must remain project-agnostic. Fixture-backed tests may be used as smoke coverage only when they exercise the same source-first ingestion, split, compile, runtime, and oracle machinery that an arbitrary user project would use. A fixture name, profile ID, or target string must never satisfy acceptance gates.

Current source-first gate requirements:

1. Agent-split run-mode rows must carry `synthi.gpu.hmr.agent_split_source_first_ingestion.v1` provenance before they can count as generated/profiled visual runtime evidence.
2. That provenance is explicitly non-authoritative: `proofAuthority=source_first_ingestion_provenance_only_not_runtime_proof`, `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`.
3. The matrix recomputes the source-first proof id from the seed source hash, entry path, target id, initial source manifest hash, generated artifact hashes, sidecar hash, and compile manifest hash.
4. The initial compile manifest must contain the seeded source path and a content hash matching the source profile; an empty manifest, stale proof id, or pre-existing Synthi generated artifact/metadata path fails closed.
5. Multi-file source-first profiles may declare a typed `source.files` source-tree manifest. Every declared source-tree file must carry an explicit sha256 content hash, must be seeded into the initial compile payload, and the matrix recomputes `sourceTreeManifestHash` from the actual initial compile manifest. A profile-declared tree that omits headers, build files, or any other declared source input from the initial compile must fail closed with `source_first_source_tree_manifest_mismatch`.
6. Generated artifact paths must resolve to the generated artifact namespace, and the initial manifest must not contain a file whose content hash overlaps the later generated artifact, sidecar, or compile-manifest hash. Ordinary-looking paths such as build caches cannot bypass this content-addressed boundary.
7. Worker log text about AI split activity is corroborating evidence only. The accepted source-first boundary requires structured split/sidecar evidence, generated artifact hashes, and later runtime ledger closure.
8. The gate must not depend on a fixed split file count, target name, fixture id, source-tree shape, or project-specific success branch.
9. Runner-level source-first provenance must fail before matrix ingestion when generated artifacts are not in the generated artifact namespace. Matrix recomputation remains the aggregate authority and repeats the same namespace, manifest, hash-overlap, proof-id, and target-binding checks.
10. Source-first visual coverage also requires support-only async visual/CAS evidence: `proof_ready` off-main-thread visual metrics, a content-addressed worker executable hash, tile evidence, manifest-only CAS locators for before/after/diff visual artifacts, and CAS hashes matching the matrix-recomputed image hashes. This facet is `proofAuthority=async_visual_metrics_and_transport_only`, `acceptedForGpuHmr=false`, and `gpuHmrSuccess=false`; it can support dev-loop viability evidence but cannot authorize GPU HMR acceptance without strict runtime-ledger closure.

## 15. Stronger Definition Of Done

GPU HMR is accepted only when:

1. A typed backend contract is derived from static and runtime evidence.
2. AI-proposed fields are verified before acceptance.
3. The changed GPU artifact is rebuilt as the smallest safe fission island.
4. The ABI compatibility class is known and accepted for the backend.
5. The new artifact hash is loaded into the same running process.
6. The runtime publishes a new epoch without process restart.
7. A dispatch trace proves epoch N was used.
8. Old epochs retire only after backend-specific stream, queue, or frame safety proof.
9. A compute or deterministic visual oracle observes output produced after epoch N dispatch.
10. CPU HMR, full rebuild, and process restart are explicitly false.
11. All timings follow the same monotonic schema.
12. Unknown projects fail with specific missing contract fields.

## 16. Highest-Priority Fixes

1. Build the adversarial refusal harness before broad positive validation.
2. Add deterministic visual oracle modes and multi-frame convergence windows.
3. Replace the dead delta model requirement.
4. Add provider model availability and deprecation fields to provenance.
5. Add ABI compatibility class to the contract.
6. Add the proof ledger.
7. Make adapter synthesis fail loudly when launch boundaries are not interposable.
8. Treat visual and readback proof as mandatory ledger artifacts, not validator logs.
