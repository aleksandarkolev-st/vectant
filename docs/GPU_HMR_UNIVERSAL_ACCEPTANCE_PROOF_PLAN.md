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

Subagent E should explicitly try to create fake successes:

- Compile log counted as proof.
- Old artifact dispatched.
- CPU fallback used.
- Visual diff from camera jitter.
- Readback from stale buffer.
- Process restarted.
- Full rebuild hidden in timing.

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

Only after the adversarial refusal harness passes should the matrix broaden success claims across HIP, HIPRT, OpenCL, WebGPU, Bevy, Flow, Vulkan, and larger engine-style projects.

### Step 10: Timing normalization

Unify all validation scripts under the monotonic metric schema.

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
