# GPU HMR Universal Acceptance Implementation Status

Status date: 2026-06-23

This document records the current implementation status against `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`.

## Executive Status

Accepted local proof is ROCm/HIP on the AMD Radeon RX 9070 XT (`gfx1201`). CUDA was not validated on this machine.

Current accepted proof is broader than one fixture, but it is not universal production acceptance:

- strict ROCm/HIP full-runtime proof-ledger acceptance for generated HIP device artifacts,
- MCP preview visual HMR for generated ray-light and Flow workloads with cold split, hot delta 1, hot delta 2 with a different edit, and negative edit refusal,
- deterministic generated-split fission verification for ray-light `trace_light_rays`,
- HIPRT same-process CameraRays ray-traced visual proof with embedded proof ledger, strict runtime proof artifact, shader-cache artifact binding, data-derived nonblank oracle-region proof, and full cold/hot1/hot2-different-edit/negative run-mode coverage,
- HIPRT same-process MegaKernel direct-light-gain ray-traced visual proof on the real HIPRT checkout, proving a second HIPRT kernel path without runner branching or relaxed visual thresholds,
- ThreeJS external runtime visual proof as an external screenshot profile,
- WebGPU Chrome/AMD RDNA4 runtime visual HMR proof for an explicit-empty-layout WGSL shader/pipeline profile with cold/hot1/hot2-different-edit/negative run-mode coverage.

Current fail-closed evidence also includes:

- large real ROCm ML infrastructure validation against upstream MIOpen, which builds upstream MIOpen, attempts the upstream driver under the native observer, and has a strict runtime proof artifact, but that artifact is rejected; the latest refusal includes no ROCm-capable device visible to the worker plus missing full-runtime Synthi proof ledger success, same-process app-hook contract evidence, and output/visual oracle proof,
- real ROCm matrix multiplication validation against upstream `ROCm/rocm-examples`, which derives and syncs a source-backed buffer checksum oracle, observes the native HIP launch boundary, and is the current real ROCm row in the generated validation matrix, but is refused because Synthi artifact transport, epoch publication, dispatch trace, host identity, and runtime output-oracle observation are missing,
- negative/rejection evidence for HIPRT blank-frame direct-light-zero, OIDN HIP, Bevy, OpenCL, and Vulkan where proof is missing, blank, or the runtime dependency is incompatible.

Current strict matrix behavior deliberately downgrades older HIPRT warm visual artifacts that lack an embedded proof ledger and data-derived oracle-region proof. HIPRT matrix ingestion now recomputes the oracle region from the persisted before/after PNG pixels; JSON claims about a nonblank region are not accepted by themselves. A fresh 2026-06-22 HIPRT CameraRays rerun is accepted as strict full-runtime HIPRT GPU HMR. The MegaKernel direct-light-zero profile is now a proven blank-oracle-region refusal, not a success. OIDN live preflight ran against the real HIPRT checkout and remains rejected for HIP output proof because the installed OIDN HIP device library depends on `libamdhip64.so.5`, which is absent on this ROCm 7 worker. No symlink, ABI shim, fake ICD, or synthesized runtime was added.

The latest generated machine-readable validation matrix ledger reports 42 rows: 17 full-runtime GPU HMR rows, 1 deterministic generated-split fission verifier row, 1 external visual-profile row, 15 structured refusal rows, 1 preflight-only row, 7 cold split rows, and 0 unproven rows in the default included set. The matrix hash is:

```text
gpu-validation-matrix-ledger:sha256:dbacec4f6aa3619eda9cc0380e045b674cadfa3e6558018a471aa280c1568e49
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260623T170606Z.json
markdown: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260623T170606Z.md
latest rerun context: validation matrix rerun over existing proof artifacts after real ROCm profile proof-obligation gates, CPU/GPU firewall evidence gates, explicit target-progression failure gates, required app-hook fail-closed gates, generic runtime capability preflight surfacing, and the latest MIOpen no-device strict refusal rerun
summary: 42 rows, 17 full-runtime GPU HMR, 15 refusals, 7 cold splits, 1 deterministic fission, 1 visual profile, 1 preflight-only, 0 included unproven rows
self-check: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed
```

The global per-target run-mode coverage row is `accepted` for the 3 enrolled run-mode targets: generated Flow, generated ray-light, and scoped WebGPU WGSL. SAXPY remains a valid full-runtime evidence row outside that run-mode-suite obligation. Scoped WebGPU now has structured cold runtime evidence, hot delta 1, hot delta 2 with a different shader edit, and binding-layout negative-edit refusal rows.

The backend-specific `hiprt_run_modes` coverage row is now `accepted` for `hiprt-camera-rays-horizontal-mirror`: it has structured cold runtime visual evidence, hot delta 1, hot delta 2 with a different source edit, and an ABI-changing negative-edit refusal. HIPRT also has an accepted MegaKernel direct-light-gain same-process visual proof as a second scoped kernel path. This still does not mean broad HIPRT acceptance; it means those scoped profiles satisfy their recorded proof gates without overclaiming other HIPRT kernels or applications.

Current focused Flow/ray-light matrix:

```text
proof id: gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-focused-flow-ray-light-20260622T181300Z.json
rows: 9
outcomes: 4 full_runtime_gpu_hmr, 2 cold_split_proven, 2 refusal_proven, 1 deterministic_fission_proven
open gates: none
coverage accepted: ROCm/HIP full runtime, Flow visual GPU path, ray-light visual GPU path, per-target run modes, per-kernel/smallest-safe fission
```

Latest live preview URLs checked HTTP 200:

```text
Ray-light: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10
Flow:      http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10
Preview stack: frontend 127.0.0.1:3000 -> HTTP 200 on 2026-06-23; Postgres bound to 127.0.0.1:15432 because 5432 was unavailable.
```

Latest ray-light visual proof:

```text
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10
hot delta 1 ledger: gpu-ledger-proof:sha256:fc798cb97c10df6099ee16d994f8829470596d6408288393da0f751d160a74f2
hot delta 2 ledger: gpu-ledger-proof:sha256:a5fc66a3ef1f03824af64d2151ffa970fe57794421f3866bd0127cffdc5b50f2
visuals: before-after-diff.png, hot-delta-2-diff.png
hot delta 1 total validator wall time: 2864084200ns
hot delta 2 total validator wall time: 2930783900ns
visual metrics: hot1 changed_pixel_ratio=0.058902083333333334, hot2 changed_pixel_ratio=0.049745833333333336
fission: accepted per_kernel_hmr for trace_light_rays
visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-23; both were visibly nonblank and showed different ray-light geometry.
```

Latest Flow visual proof:

```text
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260622-embedded-ledger-10
hot delta 1 ledger: gpu-ledger-proof:sha256:82171321eac0bc7b8a4bd5177e51766931a4361600f8b14a668290cdf0ad9e98
hot delta 2 ledger: gpu-ledger-proof:sha256:c92876a2dc20d43f3811f4db236844838b8fd47b3668462c4049dbfbc211503c
visuals: before-after-diff.png, hot-delta-2-diff.png
hot delta 1 total validator wall time: 2961567300ns
hot delta 2 total validator wall time: 2878428200ns
visual metrics: hot1 changed_pixel_ratio=0.025272916666666666, hot2 changed_pixel_ratio=0.025222916666666668
fission: device_translation_unit_hmr only; per-kernel/smallest-safe fission remains refused
visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-23; both were visibly nonblank and showed different Flow particle-ring patterns.
```

Latest WebGPU run-mode visual proof:

```text
hot delta 1 proof id: webgpu-runtime-visual-proof:sha256:23db4d987cd865c25a728ec8dfabde136e2beabc40e1efc3392e4a35f9cebcf5
hot delta 1 runtime proof artifact: gpu-runtime-proof:sha256:dddf2ab49fb6186c6f9fe2a9ac8af62715b5ccf0ee42e6e7df472e1caeb5fe75
hot delta 1 ledger: gpu-ledger-proof:sha256:15207b3d1aa84dbc99987d215febea180ee2af3e685a099c683bb0026d034088
hot delta 1 run-mode proof: runtime-run-mode-proof:sha256:5844ac8c28275ac4ea0c20d7d02a0b2b3ae4c215d03a17da5b89587815d707cf
hot delta 1 cold runtime proof: runtime-run-mode-proof:sha256:24f695eb8fcd196bf2a03be1e00804b2284809700e8475c427e60c9f974d6fae
hot delta 1 negative refusal: agent-split-negative-edit-refusal:sha256:cbc271bf659eb4dab952718ee934dbd2da5928c087ce9b2ec48b391d3e9cb6f4
hot delta 1 total validator wall time: 659548400ns
hot delta 1 trigger_to_visible_time: 49171800ns
hot delta 1 changed_pixel_ratio: 0.29389322916666666
hot delta 2 proof id: webgpu-runtime-visual-proof:sha256:2405506bb17e93b3cd5e446a36dcb283bfd932b26c72620fb6287eebcb15ee2e
hot delta 2 runtime proof artifact: gpu-runtime-proof:sha256:c13b0ee0fb8d7f7f8dc93e30a3de298c3d8d26e211e3f1051bba3911ee03b80f
hot delta 2 ledger: gpu-ledger-proof:sha256:24dcb8fed9f53514ecacf0ede46fdc27db0f4f936100602c186b1c592781253d
hot delta 2 run-mode proof: runtime-run-mode-proof:sha256:9f437e19d7120fd3dbcb39e48059f8dbc30f790ed68e3e33b8658573afb86455
hot delta 2 cold runtime proof: runtime-run-mode-proof:sha256:f4262a8772e9955440beea19813e2c593dee6200f6ff4c5127c9ee9ebad53c43
hot delta 2 negative refusal: agent-split-negative-edit-refusal:sha256:5ed8608701aeea8e7507fec667b5f9a559b0c6a4cb4148e54a0abe1979b6b1cc
hot delta 2 total validator wall time: 667988100ns
hot delta 2 trigger_to_visible_time: 49841900ns
hot delta 2 changed_pixel_ratio: 0.32245225694444446
negative edit refusal reasons: bind_group_layouts_not_supported_by_runner, webgpu_pipeline_layout_or_binding_abi_changed, gpu_hmr_rejected_before_load
visuals inspected locally with the image tool: hot1 after/diff and hot2 after/diff PNGs from `webgpu-runtime-runmodes-hot1-20260623-neg-*` and `webgpu-runtime-runmodes-hot2-20260623-neg-*`
visual result: hot1 after yellow inverted triangle with nonblank diff; hot2 after green rotated triangle with nonblank diff
```

Latest large ROCm ML infrastructure validation:

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-miopen-activation-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen
repo: https://github.com/ROCm/MIOpen.git @ 06977176afd94476c18d5290f21cb40745bb73a9
result slug: gpu-real-rocm-MIOpen-20260623161951
result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
target: MIOpenDriver activ -n 1 -c 1 -H 8 -W 8 -F 1 -V 1 -t 1
entry file: src/kernels/MIOpenNeuron.cl
delta file: src/kernels/activation_functions.h
repo files: 7869 git files, 8344 seeded text/proof-context files, 38 skipped text/binary limits
runtime device preflight: hipMallocArray result=100, device_count=0, error=no ROCm-capable device is detected
runtime capability preflight matrix facet: status=gpu-runtime-array-allocation-unavailable, accepted=false, can_satisfy_runtime_proof=false, gaps=gpu-runtime-array-allocation-unavailable,runtime_device_unavailable,runtime_device_count_zero,runtime_device_count_probe_failed,runtime_array_allocation_probe_failed,runtime_array_allocation_unavailable,runtime_any_array_allocation_unavailable,runtime_array_allocation_matrix_failed,runtime_texture_fallback_unavailable,runtime_texture_resource_matrix_failed,runtime_capability_preflight_failed
upstream build/run: configure_ms=9374, build_ms=1656476, run_ms=289, run_exit_code=134, clean_build=true; MIOpenDriver aborted after hipMalloc reported no ROCm-capable device
native runtime evidence: native launch observer ready for HIP/ORO launch and function-resolution APIs; native launch observed count=0
split projection: first_real_repo_ai_split_compile selected=1532 files, 50331605 bytes, omitted=5705
delta projection: none accepted; MCP exited before compile/delta proof material was collected
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
device sidecar contract facet: status=derived_device_sidecar_candidate_not_runtime_proof, backend=opencl, source=src/kernels/MIOpenNeuron.cl, delta trace=src/kernels/MIOpenNeuron.cl -> src/kernels/activation_functions.h, artifact_kind=opencl_program, entry_points=MIOpenActivationForward/miopenActivationForward, compiler=/opt/rocm/llvm/bin/amdclang, compiler_args_hash=sha256:0abda9a90b542119745c0940d9307bef33ee4223d0fbd4c8d2af832842605e35, gaps=device_sidecar_artifact_transport_runtime_not_observed,device_sidecar_epoch_publication_runtime_not_observed,device_sidecar_dispatch_trace_runtime_not_observed,device_sidecar_output_oracle_runtime_not_observed,device_sidecar_host_identity_runtime_not_observed
hot path timings: upstream_build_ms=1656476, upstream_run_ms=289, total_validator_wall_ms=1746447.6975
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:a71699fa04a18b79432cd042d803f0eaf4bc4d3e168d556149649271a3ceac00, proof_artifacts=[]
refusal reason: runtime device proof is unavailable and full runtime proof remains unproven; strict runtime artifact gate failed with runtime_full_proof_not_proven, runtime_proof_artifact_gpu_hmr_success_false, runtime_proof_artifact_stage_failed, runtime_proof_artifact_limitations_present, proof ledger rejection, and acceptance contract rejection
oracle resolution: requested_profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, worker oracle profile cleared, syncSkippedReason=runtime_profile_absent
target progression: final-acceptance, required=true, target=MIOpenDriver, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, raw compute oracle artifacts
target progression ledger: target-progression-ledger:sha256:cd47f0bb1b2498e74ee41b6d435c7e0cf8b7e29b2c08a0fa7a6eed7c2703feba, entry_status=fail
worker evidence: runtime session native-launch-observer:99112; observer ready but no native launch/function resolution entries were observed; no synthi_gpu_launch dispatch lines, no artifact_transport lines, no dispatcher_epoch lines, no output_oracle lines, and no host_identity lines
native ROCm refusal facet: status=refusal_evidence, can_satisfy_dispatch_proof=false, gaps=native_launch_boundary_observed,native_boundary_not_synthi_dispatch_proof,synthi_dispatch_not_observed,artifact_transport_not_observed,epoch_not_observed,output_oracle_profile_absent,host_identity_not_observed,adapter_impossible_requires_app_hook
real ROCm app-hook contract facet: status=required_app_hook_contract_missing, declared=false, required=true, can_satisfy_runtime_proof=false, gaps=app_hook_contract_not_declared,app_hook_artifact_transport_evidence_missing,app_hook_artifact_transport_runtime_not_observed,app_hook_epoch_publication_evidence_missing,app_hook_epoch_publication_runtime_not_observed,app_hook_dispatch_trace_evidence_missing,app_hook_dispatch_trace_runtime_not_observed,app_hook_host_identity_evidence_missing,app_hook_host_identity_runtime_not_observed,app_hook_output_oracle_evidence_missing,app_hook_output_oracle_runtime_not_observed
real ROCm runtime eligibility facet: status=refused_missing_runtime_proof, backend_candidates=hip, source_dialects=opencl_c,c_cpp, artifact_kind=hip_source_bridge, entry_points=MIOpenActivationForward/miopenActivationForward, compiler=/opt/rocm/llvm/bin/amdclang, compiler_args_hash=sha256:c63b86c1510b85391aca5b7f7ad0ff7614498322c42d353512ffa785f67213b7, gaps=native_boundary_not_synthi_dispatch_proof,artifact_transport_not_observed,same_process_epoch_missing,dispatch_epoch_missing,output_oracle_profile_absent,host_identity_not_observed,app_hook_contract_not_declared,app_hook_artifact_transport_evidence_missing,app_hook_artifact_transport_runtime_not_observed,app_hook_epoch_publication_evidence_missing,app_hook_epoch_publication_runtime_not_observed,app_hook_dispatch_trace_evidence_missing,app_hook_dispatch_trace_runtime_not_observed,app_hook_host_identity_evidence_missing,app_hook_host_identity_runtime_not_observed,app_hook_output_oracle_evidence_missing,app_hook_output_oracle_runtime_not_observed
visual result: no MIOpen frame captured; matrix marks visual.required=false for this compute-only target and still refuses because strict runtime ledger and raw output-oracle proof are missing
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
matrix proof ids: gpu-ledger-proof:sha256:5f6099950f14c844983365cea135257c6a89b5e0e2a28ec10e82a2885f413e96, gpu-runtime-proof:sha256:a71699fa04a18b79432cd042d803f0eaf4bc4d3e168d556149649271a3ceac00, real-rocm-validation:sha256:c255ecf164802927be17e46f584b732136a0a5a0978c89e0cf62e3300d30810d
matrix row id: gpu-validation-matrix-row:sha256:6a8f22c017a9666d944d778d361d0d83f48042defc908af547bff650c14e71b1
matrix open gaps: strict_runtime_proof_artifact_required, proof_ledger_success_required, output_or_visual_oracle_proof_required, real_rocm_app_hook_contract_required, real_rocm_runtime_capability_preflight_failed, real_rocm_sidecar_runtime_consistency_required, real_rocm_profile_proof_obligations_required, target_progression_gates_failed, native_rocm_launch_boundary:adapter_impossible_requires_app_hook, real_rocm_runtime_capability_preflight:runtime_device_unavailable, real_rocm_runtime_capability_preflight:runtime_array_allocation_unavailable, real_rocm_runtime_capability_preflight:runtime_capability_preflight_failed, real_rocm_runtime_eligibility:app_hook_contract_not_declared, real_rocm_profile_proof_obligations:proof_obligation_output_oracle_profile_missing, real_rocm_app_hook_contract:app_hook_artifact_transport_evidence_missing, real_rocm_app_hook_contract:app_hook_dispatch_trace_runtime_not_observed, real_rocm_device_sidecar_contract:device_sidecar_dispatch_trace_runtime_not_observed
plan coverage: large_real_rocm_repo=refused
```

Latest real ROCm matrix multiplication compute-oracle validation:

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-matrix-multiplication.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:matrix-multiplication
repo: https://github.com/ROCm/rocm-examples.git @ c121d6d2e6a21ce1d0a140e97b890ada635f7574
result slug: gpu-real-rocm-matrix-bridge-facet-tight-20260623
result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
target: hip_matrix_multiplication
entry file: HIP-Basic/matrix_multiplication/main.hip
upstream build/run: configure_ms=1509, build_ms=1840, run_ms=230, run_exit_code=0
output oracle resolution: requested_profile=hip.matrix-multiplication.readback-c.v1, source_derived_candidates=1, selected_source=source_derived_profile, runtime_profile_present=true, runtime_profile_synced=true
output oracle contract: oracle=oracle:real-rocm:matrix-readback-c:b8f18aad760bfaf7, kind=buffer_checksum, output=HIP-Basic/matrix_multiplication/main.hip:C, baseline=sha256:aaedc7073c76880db6c8be81a91229d0073f1069e70791a7d028f575910c352c, expected=sha256:e7352404a601e877e39b4ae06181ce1597e93ccbbb2c9d654eb9df479bb9a858
candidate artifact entry point: matrix_multiplication_kernel
native runtime evidence: hipLaunchKernel observed through native launch observer; function_resolution_count=0
target progression: phase=small-oracle, required=true, final_acceptance_target=MIOpenDriver, gates=phase pass, non-final target pass, output oracle fail because runtime_dispatch_not_observed
compile bridge facet: status=compile_bridge_missing, phase_count=2, compile_response_status=compile_bridge_not_declared_by_compile_response, top_level_keys=ok/session_id/language/filename/dispatched_at/note, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
hot path timings: initial_compile_ms=30007, hot_delta_compile_ms=30005, hot_wait_ms=30002, total_validator_wall_ms=169071.7042
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:0e09ae2abdc7bbae534ecca51d96f38d7276e6e243a47026d861e7d13fd2265e
refusal reason: native HIP launch evidence is evidence-only and cannot satisfy GPU HMR; no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, host_identity, or runtime output_oracle observation was collected
native ROCm refusal facet: status=refusal_evidence, can_satisfy_dispatch_proof=false, gaps=native_launch_boundary_observed,native_boundary_not_synthi_dispatch_proof,synthi_dispatch_not_observed,artifact_transport_not_observed,epoch_not_observed,output_oracle_not_observed,host_identity_not_observed,adapter_impossible_requires_app_hook
real ROCm app-hook contract facet: status=required_app_hook_contract_missing, declared=false, required=true, can_satisfy_runtime_proof=false, gaps=app_hook_contract_not_declared,app_hook_artifact_transport_evidence_missing,app_hook_artifact_transport_runtime_not_observed,app_hook_epoch_publication_evidence_missing,app_hook_epoch_publication_runtime_not_observed,app_hook_dispatch_trace_evidence_missing,app_hook_dispatch_trace_runtime_not_observed,app_hook_host_identity_evidence_missing,app_hook_host_identity_runtime_not_observed,app_hook_output_oracle_evidence_missing,app_hook_output_oracle_runtime_not_observed
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
matrix proof ids: gpu-ledger-proof:sha256:15de5dc81722d2de9a503693a4708046731875e6ae396759a109b094356c8413, gpu-runtime-proof:sha256:0e09ae2abdc7bbae534ecca51d96f38d7276e6e243a47026d861e7d13fd2265e, real-rocm-validation:sha256:bdabe89a91de0f03bfd1c732a1c96c8618ba1570d67378c724b12f08e4c0d5ac
matrix row id: gpu-validation-matrix-row:sha256:61dd0d2471d7e70e698f0f55eaea75654c5931adda8b957efea75bf79cb0c040
historical matrix ledger for this matrix-multiplication run: gpu-validation-matrix-ledger:sha256:361ddb15ef7c1c953447756453578b4c10ab1888d62915156f72fd3618af8339
visual result: compute-only target; no frame captured or counted, and the row still refuses because the runtime ledger lacks post-epoch output-oracle observation
```

This is not yet production-grade acceptance for every arbitrary GPU project. The current accepted scope is ROCm/HIP plus the explicitly proven visual/runtime paths above, including the scoped HIPRT CameraRays and scoped WebGPU paths.

Still open or refused: CUDA, MIOpen full-runtime GPU HMR, real ROCm matrix multiplication full-runtime GPU HMR, HIPRT MegaKernel direct-light-zero, OIDN HIP output proof, Vulkan, OpenCL full-runtime acceptance, Bevy, and broader WebGPU profiles with bind groups, vertex buffers, or engine-owned pipeline caches.

## Hard Rules Preserved

- No hardcoded proof success paths were added.
- No shims were added.
- MIOpen was added as a profile-driven large real ROCm project validation target. The runner reads repo, target, build, launch, and oracle settings from the profile/env path; there is no MIOpen-specific success branch.
- Large real ROCm project validation rows are matrix-ingested through generic `real_rocm_profile` evidence and still fail closed unless a strict runtime proof artifact, recomputed proof ledger, and artifact-backed output oracle are present. Top-level `output_proof.accepted=true` flags are ignored for acceptance; visual-ledger outputs require readable visual artifact files.
- Large real ROCm compute-oracle rows now re-read `raw_readback_bin`, `readback_schema_json`, and `rendered_card_png` from disk and derive hash, byte-length, deterministic-slice, schema, and PNG-card proof from those files. Embedded `raw_readback_hash_verified` or `deterministic_slice_hash_verified` booleans are not authority, and compute-ledger rows cannot pass by attaching unrelated top-level visual files.
- Real ROCm runtime output-oracle profiles now sync by configured worker container instead of MCP transport. Local MCP validation can still deliver a profile into the real worker when a profile is declared; the latest MIOpen profile declares `profile=none`, so the worker oracle file was cleared and the run correctly remained refused.
- Real ROCm runtime evidence is now collected from the configured worker container even when the MCP transport is local. The latest MIOpen run therefore records observed native launch-boundary evidence and the absence of Synthi dispatch, artifact transport, epoch swap, output oracle, and host-preservation proof instead of treating missing docker transport as missing evidence.
- Native ROCm/HIP launch-boundary evidence is now a first-class refusal facet in the runtime proof artifact and derived acceptance contract. It is explicitly marked `can_satisfy_dispatch_proof=false`; observed native function resolution cannot satisfy GPU HMR without Synthi artifact transport, epoch publication, dispatch, output oracle, and host-preservation proof.
- Large real ROCm app-hook contracts are now generic, profile-declared evidence inputs, not project branches. Matrix ingestion fails closed when native ROCm launch-boundary evidence requires an app hook but no contract/runtime observation proves artifact transport, epoch publication, dispatch trace, host identity, and output oracle stages. Profile `evidenceRefs` must resolve against collected runtime/proof evidence before they count as contract evidence.
- Large ROCm runtime eligibility is now a separate evidence-only facet. It can identify a HIP candidate, source dialects, candidate artifact identity, compiler, and missing proof gates for a serious project such as MIOpen, but it is explicitly `candidate_metadata_only_not_gpu_hmr_success` and cannot authorize backend, dispatch, epoch, or oracle proof.
- Real ROCm runtime capability preflight is now a separate evidence-only matrix facet. The collector reads generic `runtime_capability_preflight` / `runtimeCapabilityPreflight` data from top-level results, evidence containers, validation summaries, runtime proof artifacts, and original-host proof records; failed device/allocation preflight blocks accepted real ROCm rows but cannot satisfy GPU HMR success.
- Large real ROCm profiles can now declare generic runtime output-oracle profiles and target-progression defaults. The latest MIOpen profile declares `outputOracle.profile=none` and required `targetProgression.phase=final-acceptance`, so the result explicitly reports no installed oracle and fails the missing prior-phase/full-runtime/raw-compute-oracle gates instead of implying hidden proof.
- The latest MIOpen rerun records the generic compile-bridge facet as `compile_bridge_missing`: the no-device run collected no compile phase proof material and no `load_device`, device-sidecar, artifact reference, or runtime-proof material.
- The real ROCm matrix multiplication profile declares `outputOracle.profile=hip.matrix-multiplication.readback-c.v1`; the runner derives the buffer checksum oracle from source constants and the edited `b_value`, syncs that profile to the worker, and still refuses because the runtime never emitted Synthi epoch/dispatch/output-oracle evidence.
- Real ROCm output-oracle profiles must now declare native launch symbols. The runtime eligibility contract filters native observer placeholders such as `unknown`, so the matrix candidate artifact records `matrix_multiplication_kernel` rather than accepting an unknown entry point.
- The real ROCm matrix multiplication profile is now a required `small-oracle` progression phase for the larger `MIOpenDriver` final-acceptance target. It still refuses because the small-oracle gate requires an epoch-bound runtime output proof, not a source-derived oracle contract or native HIP launch observation alone.
- Real ROCm compile phases now retain an evidence-only compile bridge facet. The latest tightened matrix run records two successful `synthi_compile` responses with only `ok/session_id/language/filename/dispatched_at/note` top-level fields and no `load_device`, device-sidecar, artifact-reference, runtime-proof material, or matching bridge signal strings, so the matrix row carries `real_rocm_compile_bridge:compile_response_device_sidecar_bridge_not_declared` as the next bridge gap.
- Real ROCm compile bridge candidates are now explicitly non-authoritative even when a future compile response mentions `load_device`, device sidecars, artifacts, and proof material. The validator and matrix smoke test keep such rows blocked with `compile_response_bridge_candidate_not_runtime_proof` until runtime `artifact_transport`, `dispatcher_epoch`, dispatch, host identity, and output-oracle proof are observed.
- Real ROCm device-sidecar contracts are now a separate evidence-only facet derived from profile fields plus CMake/build metadata and static include reachability. The latest MIOpen rerun derives an OpenCL-program candidate rooted at `src/kernels/MIOpenNeuron.cl`, but the facet is explicitly `build_metadata_candidate_only_not_gpu_hmr_success` and cannot satisfy runtime proof without artifact transport, epoch publication, dispatch trace, output oracle, and host identity observations.
- Real ROCm final-acceptance profiles now get an explicit profile proof-obligation facet. A final-acceptance profile with no output-oracle profile is blocked unless it is explicitly refusal-only, and target progression marked `required=true` implies full-runtime proof is required.
- Real ROCm validation matrix rows now derive CPU HMR, full rebuild, and process restart firewall fields from recomputed ledger/runtime firewall evidence. Accepted rows must expose all three as explicit `false`; missing evidence or forged `true` values remain refusal/open-gap material. Smoke fixtures also prove old-artifact dispatch (`dispatch_artifact_hash_mismatch`) surfaces through ledger reasons instead of being accepted.
- Large real ROCm final-acceptance progression now verifies prior `small-oracle` ledger entries from artifact-backed compute or visual oracle evidence. Compute prior rows must carry re-readable raw readback/schema/card artifacts; visual prior rows must carry re-readable image artifacts with matching content hashes.
- Large real ROCm target-progression gate failures are now hard blockers in matrix acceptance; failed prior `partial-reload` or `original-host-path` gates cannot be hidden behind otherwise successful runtime/oracle rows.
- Large real ROCm app-hook requirements now fail closed when explicitly declared through profile proof obligations, profile declarations, native-boundary app-hook gaps, or the app-hook facet itself. Missing or unproven required app-hook facets cannot be accepted by default-open ingestion.
- Real ROCm profile proof obligations now surface explicit app-hook requirements and emit `proof_obligation_app_hook_contract_missing` when a required app-hook contract is not declared.
- The validation matrix now preserves each real ROCm row's `outputOracleResolution`, `targetProgression`, `targetProgressionGates`, `nativeRocmLaunchBoundary`, `realRocmRuntimeEligibility`, and `realRocmRuntimeCapabilityPreflight` metadata, so large-project refusal gaps are machine-auditable without relying on raw logs.
- Visual matrix acceptance now decodes PNG artifacts with `sharp`; PNG headers or existing files are not enough. Run-mode visual proofs cannot opt out with `visualRequired=false`, and Flow/ray-light coverage requires accepted visual evidence.
- Docker proof runners now require explicit runtime configuration instead of baked-in endpoint/container/entry defaults.
- Visual evidence must be readable image artifacts; invalid image placeholders are rejected.
- `wait_hmr` now returns embedded proof ledger and runtime proof artifact materials for full-runtime GPU proof waits; matrix acceptance recomputes ledger invariants from those materials instead of trusting supplied summaries.
- HIPRT matrix rows require the same embedded proof-ledger/runtime-artifact chain as other full-runtime GPU HMR rows plus matrix-recomputed nonblank oracle-region proof from the persisted PNG pixels; older HIPRT artifacts without that chain are not accepted, and blank render-region outputs are structured refusals.
- Preflight refusal rows require explicit no-shim, no-symlink, and no-synthesized-runtime evidence.
- After `37f110451`, visual HMR success cannot be derived from screenshots or pixel diffs alone. If visual proof is required, the derived proof ledger record must contain `visual_oracle_artifacts`; screenshots remain evidence inputs.
- Compute proof cards are supplemental unless the accepted target is compute-only and backed by deterministic output-oracle proof.
- After `5e1ad07b6`, a placeholder `requiredOracleId` no longer satisfies fission output proof. Fission candidates require a verified inline proposal or resolved output-oracle contract.
- One generated `.hip` file is not proof by itself. The ray-light generated split now proves per-kernel/smallest-safe fission only because the deterministic verifier saw one selected device role, one kernel, full runtime proof, and a frame-gated visual oracle. Flow still refuses per-kernel/smallest-safe fission because the selected device role owns two kernels.

## Latest Hardening Checkpoint

Additional commits since the previous status pass:

```text
3e524e72e test(gpu-hmr): surface ROCm runtime preflight failures
56ab9db70 test(gpu-hmr): require explicit firewall safety fields
0a80f4db0 test(gpu-hmr): require phase-specific target progression proof
d93af9b6c test(gpu-hmr): gate real ROCm target progression failures
b7068a698 test(gpu-hmr): fail closed on required ROCm app hooks
95ddc87b6 test(gpu-hmr): surface ROCm app hook proof obligations
1004e5d39 test(gpu-hmr): expose ROCm sidecar contracts as non-authoritative
3ec61f494 fix(gpu-hmr): require ROCm oracle launch identity
2ce7bf864 feat(gpu-hmr): add ROCm matrix compute oracle
013e3f84c docs(gpu-hmr): record HIPRT light-gain proof
0cc266cc8 test(gpu-hmr): add HIPRT light-gain runtime profile
6a56a06cd fix(gpu-hmr): verify prior ROCm oracle evidence
17e61a8a6 fix(gpu-hmr): allow raw ROCm oracle progression
0a46e00cc fix(gpu-hmr): surface ROCm app hook proof limitations
c58afb2b5 docs(gpu-hmr): record real ROCm app hook gate proof
0ed24caf9 fix(gpu-hmr): gate real ROCm app hook contracts
7c35afef9 fix(gpu-hmr): emit WebGPU negative edit refusals
872e75007 fix(gpu-hmr): emit WebGPU runtime run-mode artifacts
811a67e5b fix(gpu-hmr): surface native ROCm refusal gaps
4e94059a2 fix(gpu-hmr): require MIOpen final progression proof
07872b21c docs(gpu-hmr): record HIPRT run-mode proof acceptance
5f076adca fix(gpu-hmr): emit HIPRT negative edit refusals
bdcd846f5 fix(gpu-hmr): emit HIPRT runtime run-mode artifacts
7636b171c docs(gpu-hmr): record HIPRT run-mode coverage gap
c6ab525a0 fix(gpu-hmr): track HIPRT run-mode coverage gaps
6afcd0d64 fix(gpu-hmr): generalize ROCm backend hints
a0c42543f fix(gpu-hmr): add ROCm runtime eligibility refusals
47c63a49e fix(gpu-hmr): expose native ROCm refusal boundary
452f2fc62 fix(gpu-hmr): collect real ROCm worker evidence by container
127aa1545 fix(gpu-hmr): sync real ROCm oracle profiles by worker
40d2436f5 fix(gpu-hmr): verify real ROCm compute oracle files
918ecf566 fix(gpu-hmr): decode visual evidence before acceptance
caeb106a1 fix(gpu-hmr): expose real ROCm oracle resolution in matrix
446c89ad4 fix(gpu-hmr): report real ROCm oracle resolution
1e69a82eb fix(gpu-hmr): scope run-mode coverage obligations
28ac530f0 fix(gpu-hmr): report partial run-mode coverage
3ce8c73be fix(gpu-hmr): require artifact-backed real ROCm oracle
84d9fde83 fix(gpu-hmr): ingest real ROCm validation rows
562864cac docs(gpu-hmr): record MIOpen large ML validation
31a081d6c feat(gpu-hmr): add MIOpen large ROCm ML profile
480fc456b fix(gpu-hmr): trace real ROCm build dependencies
c0a4f373c fix(gpu-hmr): recompute HIPRT oracle-region pixels
ae6bbce3b fix(gpu-hmr): require HIPRT oracle-region proof
ffe70a830 fix(gpu-hmr): ignore stale cold-only coverage targets
76b89062f test(gpu-hmr): refresh wait proof fixture
bddd1e7eb fix(gpu-hmr): require strict ledger materials in matrix
f3a25f5df fix(gpu-hmr): embed visual ledger proof in split runs
fd136a820 fix(gpu-hmr): expose wait runtime proof materials
03175dad5 fix(gpu-hmr): wait through intermediate proof states
9103998cb fix(gpu-hmr): refresh generated split sidecar between hot deltas
b0058cbdc fix(gpu-hmr): carry fission verifier metadata into runtime proof
511936571 fix(gpu-hmr): attach runtime output oracle proposal
21224766f feat(gpu-hmr): harden matrix evidence modes
78070f28e feat(gpu-hmr): prove generated split fission
1a5bfbafd feat(gpu-hmr): add validation matrix plan coverage
acdb1f84c feat(gpu-hmr): add validation matrix ledger
7dcbbb84c feat(gpu-hmr): normalize webgpu runtime timings
66c42458d feat(gpu-hmr): add webgpu runtime visual proof
b34a7e1a1 feat(gpu-hmr): add webgpu preflight proof
f2a02a83e feat(gpu-hmr): add vulkan preflight rejection proof
732d2bcfa fix(gpu-hmr): bind narrow fission to generated topology
35232abcd fix(gpu-hmr): reject generated split per-kernel overclaims
f47a45c25 feat(gpu-hmr): add opencl preflight rejection proof
97ee6b7cc fix(gpu-hmr): enforce visual runner proof waits
e13508d27 fix(gpu-hmr): use real visual fixtures in rocm self-check
f8559c672 docs(gpu-hmr): record visual ledger hardening status
37f110451 fix(gpu-hmr): bind visual proof to ledger oracle
5e1ad07b6 fix(gpu-hmr): require resolved fission output oracle
394f6ff32 fix(gpu-hmr): bind fission contract to verifier proof
e90fc49b3 fix(gpu-hmr): derive runtime profile self-check fixture
22f003d3b fix(gpu-hmr): require complete fission contract proof
```

Most recent runner hardening:

```text
Full-runtime wait_hmr responses now expose embedded proof ledger and runtime proof artifact materials.
The agent-split visual runner embeds MCP visual oracle artifacts into recomputed proof-ledger records for hot deltas.
Hot-delta-2 visual proof now captures a fresh pre-edit baseline instead of comparing against the previous hot-delta transition.
Validation matrix rows require embedded recomputable ledgers and strict runtime proof artifacts for run-mode GPU HMR acceptance.
HIPRT warm visual rows without embedded ledgers are downgraded instead of accepted.
Preflight refusals require explicit no-shim, no-symlink, and no-synthesized-runtime evidence.
MCP compile dispatch is no longer treated as proof when a required wait/proof gate fails.
Generated device edits now require synthi_wait_hmr to apply with the required GPU proof state.
The agent-split visual runner fails immediately when the initial GPU compile produces no device compile marker.
The runner fails immediately when GPU split endpoint evidence is missing after initial compile.
```

Earlier hardening in the same pass:

```text
7dcbbb84c feat(gpu-hmr): normalize webgpu runtime timings
66c42458d feat(gpu-hmr): add webgpu runtime visual proof
b34a7e1a1 feat(gpu-hmr): add webgpu preflight proof
f2a02a83e feat(gpu-hmr): add vulkan preflight rejection proof
732d2bcfa fix(gpu-hmr): bind narrow fission to generated topology
35232abcd fix(gpu-hmr): reject generated split per-kernel overclaims
f47a45c25 feat(gpu-hmr): add opencl preflight rejection proof
37f110451 fix(gpu-hmr): bind visual proof to ledger oracle
5e1ad07b6 fix(gpu-hmr): require resolved fission output oracle
394f6ff32 fix(gpu-hmr): bind fission contract to verifier proof
e90fc49b3 fix(gpu-hmr): derive runtime profile self-check fixture
22f003d3b fix(gpu-hmr): require complete fission contract proof
```

What changed:

```text
fission_report now carries deterministic verifier identity, selection decision hash, and output_oracle_contract.
fission acceptance rejects bare placeholder oracle ids.
runtime visual proof artifacts are blocked when the derived proof ledger record lacks visual_oracle_artifacts.
strict runtime artifact gates reject invented source-consistency modes and require deterministic visual-mode evaluation for visual ledgers.
OpenCL preflight now refuses missing runtime evidence and cannot count as dispatch/readback output proof.
Vulkan preflight now refuses missing ICD/tool evidence and cannot count as pipeline, command-buffer, or frame-output proof.
WebGPU preflight now records browser, launch flags, adapter, features, limits, and a diagnostic screenshot while still refusing shader/pipeline/frame HMR proof.
WebGPU runtime visual proof now accepts only an executed explicit-empty-layout WGSL pipeline scope and derives success from shared ledger invariants, visual thresholds, process-continuity evidence, and native WebGPU API evidence.
The timing metrics summary collector now normalizes WebGPU runtime visual proofs into the shared `synthi.gpu.hmr.timing_metrics.v1` schema.
The validation matrix ledger collector now scans proof artifacts and separates full-runtime GPU HMR, external visual-profile proof, preflight-only evidence, structured refusal, and unproven historical attempts.
The matrix self-check includes a forged WebGPU success flag with no ledger/images and verifies it remains unproven.
The validation matrix now derives plan-coverage rows for accepted, visual-profile-only, preflight-only, refused, and missing plan requirements.
Generated split topology now rejects per-kernel HMR unless a deterministic fission verifier proves it, even when a TU contains only one kernel.
Narrow generated fission candidates now require generated-topology evidence plus a binding from generated role path to the content-addressed selected partial artifact.
Generated split deterministic fission now emits all eight required fission evidence categories and is collected as a separate proof class that cannot count as GPU HMR success by itself.
Ray-light generated split fission is accepted for `trace_light_rays`; Flow generated split fission is rejected at `symbol_ownership` because the latest selected device role contains `particle_flow` and `synthi_generated_seed_buffers`.
The validation matrix now records run-mode evidence for accepted rows and derives a separate `per_target_run_modes` coverage row instead of hiding cold/hot-delta gaps.
The matrix now reports per-target run-mode coverage as accepted, partial, or missing and requires negative-edit refusal per accepted target instead of satisfying that gate globally.
Run-mode coverage obligations are now explicit row metadata: structured run-mode proof rows infer `validationTargetScope=run_mode_target`, while other accepted full-runtime evidence rows remain `evidence_row` unless an artifact declares a run-mode obligation.
Standalone external rejection proof artifacts, including Bevy refusals, are first-class matrix rows.
WebGPU full-runtime acceptance now requires an embedded recomputable proof ledger; a supplied query without the underlying ledger is rejected as unproven.
The MCP visual split runner now emits measured monotonic timing summaries for generated device edits.
```

Fresh verification after these commits:

```text
docker run ... cargo test --release --features gpu-hmr gpu_fission --lib
  result: 66 passed after topology gate hardening

docker run ... cargo test --release --features gpu-hmr gpu_prod_contracts --lib
  result: 36 passed

npx vitest run tests/unit/gpu_hmr_runtime_proof.test.ts
  result: 279 passed

npm --prefix mcp/synthi-mcp run build
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check
npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check
npm --prefix mcp/synthi-mcp run proof:webgpu:preflight:self-check
$env:SLUG='webgpu-preflight-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:preflight
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:self-check
$env:SLUG='webgpu-runtime-visual-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check
node mcp/synthi-mcp/scripts/gpu-hmr-timing-metrics-summary.mjs --format json
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
  result: passed
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:megakernel-light-gain
  result: passed on ROCm/RX 9070 XT worker with visual image-tool inspection
```

## Validation Matrix Ledger

Latest generated matrix artifact:

```text
schema: synthi.gpu.hmr.validation_matrix_ledger.v1
proof id: gpu-validation-matrix-ledger:sha256:dbacec4f6aa3619eda9cc0380e045b674cadfa3e6558018a471aa280c1568e49
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260623T170606Z.json
markdown: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260623T170606Z.md
```

Matrix result:

```text
row count: 42
full-runtime GPU HMR rows: 17
  flow
  ray-light
  saxpy_kernel+saxpy_init_kernel
  hiprt-camera-rays-horizontal-mirror
  hiprt-megakernel-direct-light-gain
  webgpu-wgsl-runtime-triangle
strict cold split rows: 7
deterministic fission rows: 1
  trace_light_rays
external visual-profile rows: 1
  threejs-webgl-shader-lava
structured refusal rows: 15
  bevy-wgsl-shader-material
  flow generated negative edit refusals
  ray-light generated negative edit refusals
  real-rocm-miopen-activation-large-ml
  hiprt-camera-rays-horizontal-mirror ABI-changing negative edit refusal
  hiprt-megakernel-direct-light-gain ABI-changing negative edit refusal
  hiprt-megakernel-direct-light-zero
  oidn-hiprt-rocm-preflight-20260622-real-checkout
  opencl-rocm-preflight-20260609-after-output-gate
  opencl-rocm-preflight-20260609
  vulkan-rocm-preflight-20260609
preflight-only rows: 1
  webgpu-preflight-20260609
omitted stale/unproven historical attempts by default: 589
```

Derived plan coverage:

```text
accepted:
  rocm_hip_full_runtime
  flow_visual_gpu_path
  ray_light_visual_gpu_path
  hiprt_visual_path
  hiprt_run_modes
  webgpu_scoped_runtime_visual
  per_kernel_smallest_safe_fission
  per_target_run_modes
preflight_only:
  webgpu_runtime_preflight
visual_profile_only:
  external_engine_visual_profile
refused:
  large_real_rocm_repo
  hiprt-megakernel-direct-light-zero blank oracle-region output
  oidn_hip_output
  bevy_file_loaded_wgsl
  opencl_dispatch_readback
  vulkan_pipeline_frame
missing:
  cuda_runtime
```

Important interpretation:

```text
ThreeJS is accepted as an external visual-profile proof, not as a full-runtime GPU HMR proof-ledger row.
WebGPU preflight is runtime capability evidence only; the separate webgpu-wgsl-runtime-triangle row is the scoped full-runtime WebGPU proof.
OpenCL, Vulkan, and Bevy rows are evidence-backed refusals, not GPU HMR acceptance.
The large real ROCm/MIOpen row is an evidence-backed refusal. It is matrix-ingested as a generic real ROCm validation row and remains rejected because the strict runtime proof artifact exists but is not accepted, proof-ledger success is false, same-process app-hook contract proof is not present, output/visual oracle proof is not present, the latest worker run had no ROCm-capable device, and required final-acceptance progression gates fail. The latest matrix row carries `outputOracleResolution` with profile `none`, zero source-derived candidates, no selected source, no contract, and no runtime profile; `targetProgression` showing phase `final-acceptance` and required=true; plus native ROCm launch-boundary, app-hook, profile proof-obligation, CPU/GPU firewall, and runtime-eligibility gaps showing that observer readiness or native boundary evidence is not Synthi artifact transport, epoch publication, dispatch, host identity, oracle proof, or explicit no-CPU/no-full-rebuild/no-restart proof.
Real ROCm validation acceptance requires artifact-backed oracle evidence. A recomputed ledger can satisfy compute-output proof, but visual ledger outputs must also have readable visual files; top-level oracle success booleans are not authority.
OIDN HIP is an evidence-backed refusal from the real 2026-06-22 checkout preflight; CPU OIDN diagnostics passed, HIP device creation/readback failed, and no shim/symlink/synthesized runtime was applied.
HIPRT CameraRays is accepted only for the strict same-process ray-traced CameraRays profile, with the matrix recomputing oracle-region nonblank proof from persisted before/after PNG pixels. HIPRT MegaKernel direct-light-gain is now accepted as a second scoped HIPRT same-process visual proof on the `MegaKernel` dispatch path; its ABI-changing negative edit is refused. HIPRT MegaKernel direct-light-zero remains a proven blank oracle-region refusal. The `hiprt_run_modes` plan row is accepted because structured artifacts prove the CameraRays cold/hot1/hot2-different-edit/negative sequence, and the broader `hiprt_visual_path` row now has CameraRays plus MegaKernel light-gain visual ledger evidence.
The per-kernel/smallest-safe fission row is a deterministic fission verifier proof, not a full-runtime GPU HMR row. Runtime acceptance remains ledger-gated.
The global `per_target_run_modes` plan row is accepted for 3 enrolled run-mode targets because generated Flow, generated ray-light, and scoped WebGPU carry the full cold/hot1/hot2-different-edit/negative-edit sequence. SAXPY remains accepted full-runtime evidence outside that run-mode-suite obligation. Scoped HIPRT CameraRays has its own backend-specific `hiprt_run_modes=accepted` row; stale cold-only artifacts no longer create phantom full-runtime target gaps, and negative-edit refusal is evaluated per enrolled target.
```

Formatting note: `git diff --check` passed for the Rust fission patch. `cargo fmt --check` could not be run in the available builder-test image because rustfmt is not installed, and `cargo` is not installed on the Windows host.

Fresh verification after `78070f28e`:

```text
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check
  result: passed

ray-light live MCP visual proof plus fission verifier
  workspace: ray-light-gpu-hmr-proof-20260609-fission-verifier
  runtime proof id: gpu-runtime-proof:sha256:48b7684581b5ea856e0c3878a36e039521ecba1b5f7f3b3ab270cf197d98b22e
  ledger id: gpu-ledger-proof:sha256:c08098e6daa1b66f9f9c32c3fa55f77136a283e94515e25da374d08d8f2f52ae
  visual delta: changed=5.89% mean_abs=9.91 selected_delta_ms=1057
  deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays

Flow live MCP visual proof plus fission verifier
  workspace: flow-gpu-hmr-proof-20260609-fission-verifier
  runtime proof id: gpu-runtime-proof:sha256:cdba884f9c42cb437e394af3499e9da2a8d3321a320221960f9e3f59254b56cd
  ledger id: gpu-ledger-proof:sha256:905d12006882cda3af0e441fb0a4b7f949f4bc4897563d635493a2bd9cce4d64
  visual delta: changed=2.59% mean_abs=3.58 selected_delta_ms=2659
  deterministic fission: accepted=false failure=symbol_ownership reason=selected role contains two kernels

Fresh verification after `21224766f`:

node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
  latest result: passed, matrix gpu-validation-matrix-ledger:sha256:dbacec4f6aa3619eda9cc0380e045b674cadfa3e6558018a471aa280c1568e49
  smoke coverage: compute-only real ROCm oracle acceptance plus forged missing raw/schema/card file refusal

ray-light live MCP visual proof with hot-delta timing
  workspace: ray-light-gpu-hmr-proof-20260609-timing-matrix
  runtime proof id: gpu-runtime-proof:sha256:fed37d01a7b988bfd5bc25c1adeb03d2c2a6cc8082aaa8324f64aaf6a894437b
  ledger id: gpu-ledger-proof:sha256:983d2c96e1a6bd58dc3094d31a8d24b245a4a24d88754a87208abea562ea61dc
  visual delta: changed=5.89% mean_abs=9.92 control_changed=0.00% control_mean_abs=0.03 selected_seq=8673 selected_delta_ms=1098
  timing: metric_scope=hot_delta_1 cache_state=compiler_cache_warm device_compile_wall_time=17027600ns runtime_probe_time=11284379700ns total_validator_wall_time=11301664400ns
  deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays

Flow live MCP visual proof with hot-delta timing
  workspace: flow-gpu-hmr-proof-20260609-timing-matrix
  runtime proof id: gpu-runtime-proof:sha256:d853e7a6c560d96b1cf4011dd24d67d69b81d026946070f12a745dde3fcecbdb
  ledger id: gpu-ledger-proof:sha256:f5ec4c6b608520221cfe7bf2ecd6344f3d37d37d3a262eafa4a1458c2dd8e54b
  visual delta: changed=2.59% mean_abs=3.58 control_changed=0.00% control_mean_abs=0.01 selected_seq=9230 selected_delta_ms=2755
  timing: metric_scope=hot_delta_1 cache_state=compiler_cache_warm device_compile_wall_time=24515900ns runtime_probe_time=3126806700ns total_validator_wall_time=3151554600ns
  deterministic fission: accepted=false failure=symbol_ownership reason=selected role contains two kernels
```

## Accepted ROCm/HIP Runtime Ledger

Latest accepted strict runtime artifact:

```text
workspace: gpu-real-rocm-repo-20260609005300
gpu vendor: rocm
gpu arch: gfx1201
runtime proof id: gpu-runtime-proof:sha256:0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2
ledger proof id: gpu-ledger-proof:sha256:1cfa9927c27d63b9eadf4c96021f7d9270051519d822bfb55eb7b7f08b64b9eb
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-repo-20260609005300-real-rocm-runtime-proof-0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2.json
result state: gpu-hmr-full-runtime-proven
full runtime proven: true
runtime proof limitations: []
output oracle: gpu-hmr-output-oracle-proven
```

Supplemental visual proof card:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260609005300-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

The visual card was inspected with the local image viewer. It is readable and shows `Runtime Compute Output Oracle`, target `HIP-Basic/saxpy/main.hip:y`, generation 3, `PASSED`, with matching expected and actual GPU readback hashes.

Normalized timings from the accepted run:

```text
total validator wall: 235348.1968ms
AI contract synthesis: 73919.6076ms
model availability check: 1209.3515ms
device compile wall: 30372ms
runtime probe: 237ms
dispatch trace: 3ms
oracle analysis: 3ms
dispatch to output proof: 3ms
trigger to visible/output proof: 30001ms
```

After commit `92543192f`, the accepted runtime artifact was re-summarized through the patched summary builder:

```text
summary gpu_hmr_success: true
summary full_runtime_proven: true
summary limitations: []
summary ledger success: true
summary acceptance contract accepted: true
summary acceptance contract consistency accepted: true
```

Two later real-ROCm reruns were rejected, correctly:

- `gpu-real-rocm-repo-20260609010632`: worker runtime session was lost during hot delta.
- `gpu-real-rocm-repo-20260609011410`: first compile consumed the first-phase budget and no HMR proof was produced.

Those rejected attempts are not accepted proof.

## MCP Ray-Light Visual HMR

Historical accepted MCP proof from the June 9 timing-matrix hardening. The current accepted proof is the June 22 `embedded-ledger-10` block recorded in the executive status above:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-timing-matrix
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-timing-matrix
HTTP preview check: 200
fixture: ray-light
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:983d2c96e1a6bd58dc3094d31a8d24b245a4a24d88754a87208abea562ea61dc
runtime proof id: gpu-runtime-proof:sha256:fed37d01a7b988bfd5bc25c1adeb03d2c2a6cc8082aaa8324f64aaf6a894437b
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
runner stayed alive: true
metric scope: hot_delta_1
cache state: compiler_cache_warm
device compile wall time: 17027600ns
runtime probe time: 11284379700ns
total validator wall time: 11301664400ns
deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays
```

Latest visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/agent-split-results.txt
```

Latest visual proof:

```text
changed=5.89%
mean_abs=9.92
control_changed=0.00%
control_mean_abs=0.03
selected_seq=8673
selected_delta_ms=1098
```

Local visual inspection with the image viewer confirmed a nonblank ray/light diff with the ray bundle and light path visibly changed.

Accepted fresh MCP proof:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-rerun2
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260609-rerun2
fixture: ray-light
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:a4730f03c1b5da395ede415501e62b3152c2ea7d85394231739e2cd75a17d3c1
runtime proof id: gpu-runtime-proof:sha256:2f3ece89da76d997b47cebe0d65322234b59d49fbe61064fd10db9c84e17ce34
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
```

Visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

Visual proof:

```text
changed=5.87%
mean_abs=10.01
control_changed=0.00%
control_mean_abs=0.32
selected_seq=993
selected_delta_ms=3734
```

Visual inspection confirmed a ray/light scene before HMR and a clearly changed light/ray bundle after HMR. The diff is nonblank and high-signal.

## MCP Flow Visual HMR

Historical accepted MCP proof from the June 9 timing-matrix hardening. The current accepted proof is the June 22 `embedded-ledger-10` block recorded in the executive status above:

```text
workspace slug: flow-gpu-hmr-proof-20260609-timing-matrix
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-timing-matrix
HTTP preview check: 200
fixture: flow
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:f5ec4c6b608520221cfe7bf2ecd6344f3d37d37d3a262eafa4a1458c2dd8e54b
runtime proof id: gpu-runtime-proof:sha256:d853e7a6c560d96b1cf4011dd24d67d69b81d026946070f12a745dde3fcecbdb
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
runner stayed alive: true
metric scope: hot_delta_1
cache state: compiler_cache_warm
device compile wall time: 24515900ns
runtime probe time: 3126806700ns
total validator wall time: 3151554600ns
deterministic fission: accepted=false failure=symbol_ownership because selected device role contains particle_init and particle_flow
```

Latest visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/agent-split-results.txt
```

Latest visual proof:

```text
changed=2.59%
mean_abs=3.58
control_changed=0.00%
control_mean_abs=0.01
selected_seq=9230
selected_delta_ms=2755
```

Local visual inspection with the image viewer confirmed a nonblank particle-field diff with the expected field displacement.

Accepted fresh MCP proof:

```text
workspace slug: flow-gpu-hmr-proof-20260609-rerun2
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260609-rerun2
fixture: flow
gpu vendor: rocm
gpu arch: gfx1201
generated device compile: hipcc
device edit: .synthi/generated/gpu/device.hip
strict wait gate: requireGpuFullRuntimeProof=true
ledger id: gpu-ledger-proof:sha256:1de678f799fc420e489fbb4dcb5385d7f1621f47f2d78230cff3c60ed203800f
runtime proof id: gpu-runtime-proof:sha256:16d8756992bc28d03d8ed8dd1f5786b605b6c86cabc2ff2f6bc88681600ba6e9
result state: gpu-hmr-full-runtime-proven
hmr observed: [gpu-reload] plan=device_only
```

Visual artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/before-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/after-hmr-metadata.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-rerun2/generated-split-granularity.json
```

Visual proof:

```text
changed=2.59%
mean_abs=3.58
control_changed=0.00%
control_mean_abs=0.00
selected_seq=8038
selected_delta_ms=2098
```

Visual inspection confirmed a sparse particle ring before HMR and a gridded wave/field after HMR. The diff is nonblank and localized to the changed particle field.

## Generated Split Granularity And Fission

The accepted generated split runtime claim remains device translation unit HMR unless the deterministic fission verifier proves a smaller island. The fission verifier is a separate proof class and cannot count as full-runtime GPU HMR by itself.

Flow:

```text
accepted claim: device_translation_unit_hmr
device translation units: 1
device roles: 1
kernels: particle_init, particle_flow
rejected claims: smallest_safe_fission_island, per_kernel_hmr
reason: single generated translation unit contains multiple kernels
runtime proof id: gpu-runtime-proof:sha256:d853e7a6c560d96b1cf4011dd24d67d69b81d026946070f12a745dde3fcecbdb
ledger id: gpu-ledger-proof:sha256:f5ec4c6b608520221cfe7bf2ecd6344f3d37d37d3a262eafa4a1458c2dd8e54b
visual artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
granularity artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
deterministic fission artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
deterministic fission result: accepted=false missing=symbol_ownership
```

Ray-light:

```text
accepted runtime claim: device_translation_unit_hmr
accepted fission claim: per_kernel_hmr
device translation units: 1
device roles: 1
kernels: trace_light_rays
runtime proof id: gpu-runtime-proof:sha256:fed37d01a7b988bfd5bc25c1adeb03d2c2a6cc8082aaa8324f64aaf6a894437b
ledger id: gpu-ledger-proof:sha256:983d2c96e1a6bd58dc3094d31a8d24b245a4a24d88754a87208abea562ea61dc
visual artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
granularity artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
deterministic fission artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
deterministic fission result: accepted=true verifier=evidence:fission-verifier-report:generated-split:sha256:179ed4c796fc3b69157a49ec545e05aaec6310f3c0e08c1c40ccd2596ac35c43
required categories: source_mapping, include_closure, symbol_ownership, dependency_closure, abi_membrane, compile_recipe, loader_capability, output_oracle
```

This answers the one-`.hip` concern: one generated `.hip` file is insufficient by itself. Ray-light can claim per-kernel/smallest-safe fission because the selected generated device role contains exactly one kernel and the deterministic verifier is bound to full runtime proof plus frame-gated visual output. Flow cannot claim it because the selected generated device role contains two kernels.

After `732d2bcfa`, a fission candidate that is narrower than the generated device translation unit cannot pass from metadata alone. It must carry deterministic generated-topology evidence and a structured binding that ties:

```text
generated role path -> separately materialized partial artifact -> artifact:sha256 selected artifact identity
```

Missing topology evidence or a missing topology binding rejects with `fission.claim_narrower_than_generated_topology`.

## HIPRT Same-Process Visual HMR

HIPRT proof is separate from the MCP browser preview path. The current accepted HIPRT scope is the same-process CameraRays ray-traced visual profile. It is accepted because the current run emits an embedded proof ledger, strict runtime proof artifact, real shader-cache artifact identity, post-recompile dispatch evidence, deterministic visual mode evidence, and a data-derived nonblank oracle-region check.

The MegaKernel direct-light-zero profile is intentionally not accepted as full-runtime GPU HMR after the oracle-region hardening. It produces a mostly black post-epoch render region, so the matrix records it as a proven blank-frame refusal instead of treating the pixel diff as success.

```text
worker repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

Fresh CameraRays proof:

```text
profile: hiprt-camera-rays-horizontal-mirror
mode: same-process
proof id: hiprt-warm-runtime-proof:sha256:1d15cb417f082b7ed3602abaecf05d8983c6ac647d0076a510fe75e477c38aea
strict runtime proof id: gpu-runtime-proof:sha256:7ef274e6d60f3a17f66b02437ff9846073744ba3408f013430bdc0ed75283f25
proof ledger id: gpu-ledger-proof:sha256:c7345ddcd4b9ddf1ef1e56d0fadf8dffb56d2a688074c8337c3bdbca265a6037
strict gate: pass
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-diff-amplified.png
changed pixels: 91.4019%
mean abs delta 8-bit: 53.1273
oracle-region nonblank: true
oracle-region changed visible ratio: 0.9574956597222222
adapter build: 20624ms
same-process live recompile: 87ms
trigger wait: 2537ms
edit to first visual: 8008ms
total validator wall: 32815.8128ms
```

CameraRays run-mode suite proof:

```text
matrix coverage row: hiprt_run_modes=accepted
matrix proof id: gpu-validation-matrix-ledger:sha256:2f16aacc0d8f17388fca5c70d6bea43467f1f0bb8b4e37e68e62e2a1dd127ad2

hot delta 1 proof id: hiprt-warm-runtime-proof:sha256:d0a8b4ca701d855e96ce0c6b812c668a4307901d13b232948e5c629fe7b0384b
hot delta 1 runtime proof: gpu-runtime-proof:sha256:41cfc3ac84b5d95ee667711bcbb52e76a6fc4c2be96905d95f3fac4e7ce4b355
hot delta 1 ledger: gpu-ledger-proof:sha256:7e6853bc6da3257e4b3002512b15098bdbe3380d287df8245f2b308976157523
hot delta 1 run-mode proof: runtime-run-mode-proof:sha256:70e3c22c877041ad50d93d81e9fda0832a1485e3b00f1fe038dda65f69be20c1
hot delta 1 visual diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-runmodes-20260623-hot1-diff-amplified.png
hot delta 1 metrics: changed_pixel_ratio=0.9140190972222222, mean_abs_delta_8bit=53.12725983796296, live_recompile=45ms, trigger_to_visible=8618ms, total_validator_wall=310330.826ms

hot delta 2 proof id: hiprt-warm-runtime-proof:sha256:5c2fadcac8b6b32a7c60b227cb88d167cb91488157d47bc3389ac555886d5542
hot delta 2 runtime proof: gpu-runtime-proof:sha256:444a57c35075550e3d229fe9b248bab36bef8c21b765f9d5981f0c9f64e5dfd0
hot delta 2 ledger: gpu-ledger-proof:sha256:847ca2295ee40cf6782f51f2d3411221437bde26f7bfbe5ffdbc3bb5a953d94f
hot delta 2 run-mode proof: runtime-run-mode-proof:sha256:995d4a60fb71c15cc6b0f73cc61575936f4c8736078d35e665396c52d42db661
hot delta 2 visual diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-runmodes-20260623-hot2-neg-diff-amplified.png
hot delta 2 metrics: changed_pixel_ratio=0.9486458333333333, mean_abs_delta_8bit=51.80200376157408, live_recompile=45ms, trigger_to_visible=2463ms, total_validator_wall=13840.4776ms

cold runtime visual run-mode proof: runtime-run-mode-proof:sha256:e889f9f87531a4f446bf6f4418d417edb1d5f92afc975594fbb0e358c5cec0fa
negative ABI edit refusal proof: agent-split-negative-edit-refusal:sha256:f44d46b50f0c36124535d1d348bc49b49b75073b56d0992a1d57ec1e273e7a01
negative refusal reasons: kernel_signature_changed, abi_layout_changed, hiprt_runtime_adapter_contract_rejects_layout_changed_abi
visual inspection: hot delta 1 and hot delta 2 diff PNGs were opened with the local image tool and were visibly nonblank, high-change ray-traced frame diffs.
```

MegaKernel direct-light-gain proof:

```text
profile: hiprt-megakernel-direct-light-gain
mode: same-process
accepted: true
matrix outcome: full_runtime_gpu_hmr
proof id: hiprt-warm-runtime-proof:sha256:bfc7237c96db6688d94410167ff705fb41c0a955c6dee01ccd43011f3537c102
strict runtime proof id: gpu-runtime-proof:sha256:2256732f63143775e7c15db599828ef1b6a32dbb82fef0cba0aaf0fcd946ddef
proof ledger id: gpu-ledger-proof:sha256:8ede8c7a1bcea38429eb855947e73150fa8d7b508ee6301a81d7cd521b94721b
acceptance contract hash: sha256:39a6c7d0d85bbd67385c5f9aca6e8c6e939212188d73ef5e9a01d272387369fa
strict gate: pass
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-diff-amplified.png
changed pixels: 35.40494791666667%
mean abs delta 8-bit: 7.759528356481481
max channel delta 8-bit: 110
oracle-region nonblank: true
oracle-region changed visible ratio: 0.9197007248071077
adapter build: 71334ms
same-process live recompile: 32718ms
trigger wait: 748ms
edit to first visual: 37546ms
screenshot capture: 40501ms
total validator wall: 348533.3747ms
run-mode proof: runtime-run-mode-proof:sha256:b3024731a9269acf258397ad569f81fc9ab30826494ebf95105e3f1e6c2c10f8
negative ABI edit refusal: agent-split-negative-edit-refusal:sha256:7ad67b17ba2154822ae576208675c1f837485d4e1574a310c463f8875476b46b
negative refusal reasons: kernel_signature_changed, abi_layout_changed, hiprt_runtime_adapter_contract_rejects_layout_changed_abi
visual inspection: before, after, and amplified diff PNGs were opened with the local image tool; the scene remains the same Cornell-style ray-traced setup while direct lighting increases, and the diff is visibly nonblank.
```

MegaKernel direct-light-zero refusal:

```text
profile: hiprt-megakernel-direct-light-zero
mode: same-process
accepted: false
matrix outcome: refusal_proven
proof id: hiprt-warm-runtime-proof:sha256:ca0effaf57433ead4ef062c54a168537178f84f555425fbc87127f5caa516f9e
strict runtime proof id: gpu-runtime-proof:sha256:2be665516b31ddf724e6d793013f4a141db419e8259cccefdea4d10594dbafbe
proof ledger id: gpu-ledger-proof:sha256:32b1b8f456fa3b31984ac997ddc404e88cfa8e0c03117429e787677a983d937f
strict gate: fail
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-diff-amplified.png
changed pixels: 41.8229%
mean abs delta 8-bit: 32.9462
oracle-region nonblank: false
oracle-region changed visible ratio: 0.007079728781856441
oracle-region changed mean luma: 1.3146592377834951
adapter build: 18942ms
same-process live recompile: 209ms
trigger wait: 2342ms
edit to first visual: 7623ms
total validator wall: 30637.1206ms
```

Visual inspection confirmed CameraRays before/after/diff images are readable and nonblank, with a mirrored/recomposed Cornell-style framebuffer. Visual inspection also confirmed the MegaKernel changed image has a mostly black render region; that is why it is refused despite a high-signal diff image.

## OIDN Status

OIDN was tested in the real HIPRT checkout through a structured preflight artifact on 2026-06-22. The result remains a refusal for HIP output proof: CPU OIDN diagnostics pass, but the installed HIP OIDN device library is linked against `libamdhip64.so.5`, which is unavailable in the ROCm 7 worker environment. No compatibility shim, symlink, fake library, or synthesized runtime was added.

```text
latest proof id: oidn-preflight-proof:sha256:5fc3136f57579a91c4be2475af7d1776d23e5c19696d7f76a1794413db5ec21a
latest result state: oidn-hip-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-summary.txt
repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
proof id: oidn-preflight-proof:sha256:f5cf7bab766cfd7b13e1c0657818c20306e81cc9dda4267486771fc492e84f85
result state: oidn-hip-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260609-summary.txt
```

HIP device tests rejected:

```text
oidnTest 'device creation' --device hip --success --durations yes --rng-seed 12345
result: FAILED, REQUIRE(bool(device)) false

oidnTest 'buffer read/write' --device hip --success --durations yes --rng-seed 12345
result: FAILED, REQUIRE(bool(device)) false
```

Dependency check:

```text
libOpenImageDenoise_device_hip.so.2.3.0 -> libamdhip64.so.5 => not found
unsupported reasons: missing_dependency:libamdhip64.so.5, oidn_hip_buffer_read_write_failed, oidn_hip_device_creation_failed
noShimApplied: true
noSymlinkApplied: true
noSynthesizedRuntime: true
```

CPU OIDN diagnostics passed:

```text
device creation: all tests passed, 8 assertions
buffer read/write: all tests passed, 27 assertions
```

No symlink, ABI shim, or library compatibility shortcut was added. Do not claim OIDN HIP output proof on this ROCm 7 worker.

## OpenCL Status

OpenCL was tested through a structured worker-container preflight artifact:

```text
latest proof id: opencl-preflight-proof:sha256:64e92684b59489f2dc88c1ac6e570fd54605bc9bb345cb6653cc15e22714c4ea
latest result state: opencl-runtime-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260609-after-output-gate-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260609-after-output-gate-summary.txt
```

The live worker has an OpenCL loader but no usable vendor ICD/tooling evidence:

```text
libraries: libOpenCL.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libOpenCL.so.1
vendor ICDs: none
platform count: unknown
device counts: none
unsupported reasons: opencl_vendor_icd_missing, clinfo_missing
```

The preflight artifact explicitly does not accept OpenCL output proof or GPU HMR success. Even on a machine where OpenCL preflight accepts, dispatch trace and output-oracle readback proof are still required before OpenCL GPU HMR can pass.

```text
acceptedForOpenClRuntimePreflight: false
acceptedForOpenClOutputProof: false
gpuHmrSuccess: false
dispatchTraceRequired: true
outputOracleRequired: true
noShimApplied: true
noVendorIcdSynthesized: true
noSymlinkApplied: true
```

No vendor ICD was synthesized, no symlink was added, and no compatibility shim was used. Do not claim OpenCL HMR output proof on this worker.

## Vulkan Status

Vulkan was tested through a structured worker-container preflight artifact:

```text
latest proof id: vulkan-preflight-proof:sha256:d904016a24c785659424bae3cc5381ae2a84b816fee87c1f13dd335709d7a528
latest result state: vulkan-runtime-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-summary.txt
```

The live worker has a Vulkan loader but no usable ICD/tooling evidence:

```text
libraries: libvulkan.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvulkan.so.1
ICD files: none
ICD libraries: none
API version: unknown
physical device count: 0
device names: none
unsupported reasons: vulkan_icd_missing, vulkaninfo_missing
```

The preflight artifact explicitly does not accept Vulkan pipeline proof or GPU HMR success. Even on a machine where Vulkan preflight accepts, pipeline-layout proof, command-buffer trace proof, and frame-output oracle proof are still required before Vulkan GPU HMR can pass.

```text
acceptedForVulkanRuntimePreflight: false
acceptedForVulkanPipelineProof: false
gpuHmrSuccess: false
pipelineLayoutProofRequired: true
commandBufferTraceRequired: true
frameOutputOracleRequired: true
noShimApplied: true
noIcdSynthesized: true
noSymlinkApplied: true
```

No ICD was synthesized, no symlink was added, and no compatibility shim was used. Do not claim Vulkan HMR output proof on this worker.

## WebGPU Status

WebGPU was tested through a structured Chrome/Playwright runtime preflight artifact:

```text
latest proof id: webgpu-preflight-proof:sha256:c6cc4216d34477cf4968797b420d4ac4f331b84834939acc5c1a956f2c31bd2d
latest result state: webgpu-runtime-preflight-accepted
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-summary.txt
latest diagnostic screenshot: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-diagnostic.png
```

The live browser accepted WebGPU runtime preflight:

```text
browser: C:\Program Files\Google\Chrome\Application\chrome.exe
browser launch args: --enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan,WebGPU,UseSkiaRenderer --disable-gpu-sandbox
adapter: {"vendor":"amd","architecture":"rdna-4","device":"","description":""}
preferred canvas format: bgra8unorm
unsupported reasons: none
```

The diagnostic screenshot was visually inspected and is nonblank: it shows a rendered WebGPU triangle plus the runtime JSON (`navigator.gpu`, adapter, device, and render-submit true). This is runtime capability evidence only.

The preflight artifact explicitly does not accept WebGPU shader/pipeline proof or GPU HMR success. Even when WebGPU runtime preflight accepts, WGSL hashes, shader-module epoch, bind-group/pipeline-layout proof, pipeline recreate proof, and frame-output oracle proof are still required before WebGPU GPU HMR can pass.

```text
acceptedForWebGpuRuntimePreflight: true
acceptedForWebGpuPipelineProof: false
gpuHmrSuccess: false
shaderModuleEpochRequired: true
bindGroupLayoutProofRequired: true
pipelineLayoutProofRequired: true
pipelineRecreateProofRequired: true
frameOutputOracleRequired: true
noShimApplied: true
noBrowserFlagClaimedAsHmr: true
```

No WebGPU shim was added. Browser enablement flags are recorded for transparency and are not counted as HMR proof.

WebGPU runtime visual HMR was then proven for a scoped WGSL shader/pipeline profile:

```text
latest runtime proof id: webgpu-runtime-visual-proof:sha256:e45b1d839607d694a744226228c0341dd6959eb336058bf733152a77f972e81d
latest runtime result state: webgpu-hmr-full-runtime-proven
latest runtime ledger id: gpu-ledger-proof:sha256:56994c1b29cef52e7b86ba4d3936031a3486123bb62da99ab1e554d779011a2e
latest runtime proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-proof.json
latest runtime summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-summary.txt
```

Runtime visual artifacts were inspected:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-before.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-after.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-diff.png
changed pixel ratio: 29.3893%
mean abs delta 8-bit: 37.6426
visible pixel count: 67713
total validator wall time: 951597400ns
trigger to visible time: 67788100ns
```

The shared timing summary includes the scoped WebGPU row:

```text
timing summary json: mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260609T051533Z.json
source: webgpu_runtime_visual
profile: webgpu-wgsl-runtime-triangle
status: pass
total wall: 951.5974ms
edit/trigger to first visual: 67.7881ms
visual diff: 35.6061ms
```

The accepted WebGPU proof is deliberately narrow:

```text
profile: webgpu-wgsl-runtime-triangle
pipeline scope: explicit-empty-layout-no-bindings-no-vertex-buffers-triangle-list
wgsl hash before: sha256:46927f5ed8423e965306fb45cf698deab767e2582d9b745db3c064c092285582
wgsl hash after: sha256:63fac832718d56179ba8a043e55afe6b93f6af9608269c13aa174fb3e66a2e66
epoch: webgpu-epoch-2
dispatch id: webgpu-dispatch-2
pipeline id: webgpu-pipeline-2-4fb3e66a2e66
ledger failed invariants: none
visual thresholds accepted: true
process continuity accepted: true
native WebGPU API accepted: true
no shim applied: true
no browser flag claimed as HMR: true
```

Unsupported WebGPU profiles with non-empty bind-group layouts, vertex buffers, fixed color target formats outside the preferred canvas format, or non-opaque alpha mode are rejected by the runner instead of being overclaimed.

## External Project Profiles

ThreeJS WebGL shader lava profile passed as an external runtime screenshot proof:

```text
profile: threejs-webgl-shader-lava
latest report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1780977150053-report.json
latest proof id: external-visual-proof:8a42ec53c94aa29844c2992782c2ca4156b9cd2c9c285b92d9b64901e4fde6cf
latest status: pass
latest chrome GPU: enabled
latest total: 9330.6259ms
latest edit to screenshot: 2836ms
latest visual diff: 95ms
latest changed pixel ratio: 28.3806%
latest mean abs delta 8-bit: 12.9288
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1780961959963-report.json
proof id: external-visual-proof:44d6ee855658665be4472d688f58cc2212487282b087e9a3ae420baf3574a593
status: pass
chrome GPU: enabled
total: 14045.5857ms
build: 3663ms
runtime ready: 537ms
edit to runtime signal: 1215ms
edit to screenshot: 4355ms
visual diff: 196ms
changed pixel ratio: 28.3778%
mean abs delta 8-bit: 12.9297
```

Visual artifacts:

```text
latest before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1780977142363.png
latest after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1780977147880.png
latest diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1780977149507.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1780961950497.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1780961956056.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1780961959195.png
```

Bevy/WGSL profile built with real Rust GNU/w64devkit toolchain but remains rejected, not accepted.

Fresh rejection artifact:

```text
profile: bevy-wgsl-shader-material
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
rejection proof id: external-rejection-proof:9d3ac84744bb6ff8b8260a8df1827c8a0ffc26847d13de7fa10447015e3f215e
rejection proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972543516-rejection-proof.json
status: fail
reasons: mcp_request_timeout, mcp_no_decoded_frames, visual_frame_missing, visual_oracle_not_accepted
visual evidence accepted: false
total validator wall: 1203518.9259ms
```

Earlier strict proof-state rejection:

```text
profile: bevy-wgsl-shader-material
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780961693506-report.json
status: fail
reason: gpu_hmr_proof_insufficient
required state: gpu-hmr-full-runtime-proven
observed result state: missing
```

This is a correct refusal, not an accepted arbitrary-project proof.

## Runtime And Preview State

Current local service check:

```text
vectant-ade-worker-1 Up
vectant-ade-mcp-1 Up, 127.0.0.1:9464->9464
vectant-ade-frontend-1 Up, 127.0.0.1:3000->3000
```

Preview HTTP checks:

```text
http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
```

The Codex in-app Browser connector failed to initialize in this session with a sandbox metadata error, so browser screenshots are not counted as proof. Visual proof in this checkpoint uses persisted MCP screenshots and the local image viewer.

## Recent Commits

Proof/fix commits are separate:

```text
37f110451 fix(gpu-hmr): bind visual proof to ledger oracle
5e1ad07b6 fix(gpu-hmr): require resolved fission output oracle
394f6ff32 fix(gpu-hmr): bind fission contract to verifier proof
e90fc49b3 fix(gpu-hmr): derive runtime profile self-check fixture
22f003d3b fix(gpu-hmr): require complete fission contract proof
f0db3c67e fix(gpu-hmr): classify external timeout rejections
b542e7390 docs(gpu-hmr): record Bevy rejection proof artifact
706c20799 fix(gpu-hmr): ledger external profile rejections
8b358451e docs(gpu-hmr): record structured OIDN preflight proof
fcff70032 feat(gpu-hmr): add structured OIDN HIP preflight proof
08f16a794 fix(gpu-hmr): archive agent split results per slug
f42e4d32e docs(gpu-hmr): update ROCm proof ledger demo status
92543192f fix(gpu-hmr): preserve derived contracts in proof summaries
302bbc238 fix(gpu-hmr): require explicit real rocm docker config
a12e654d8 fix(gpu-hmr): require explicit agent split docker config
529fce4e2 fix(gpu-hmr): keep external chrome gpu enabled
01a2759a1 fix(gpu-hmr): require explicit docker preview config
71e9e3dd4 fix(gpu-hmr): reject invalid visual evidence artifacts
ff20d2d77 docs(gpu-hmr): record current proof status
072986aaa fix(gpu-hmr): keep compute proof cards supplemental
d600c7df3 fix(gpu-hmr): derive hip launch contract from runtime evidence
f8c82024c fix(gpu-hmr): normalize real rocm proof ledger inputs
220d95755 fix(gpu-hmr): validate full runtime artifact summaries
39832df72 fix(gpu-hmr): preserve degraded dispatch identity
```

## Verification Commands

Passed after the latest code fix or latest verification rerun:

```text
npx vitest run mcp/synthi-mcp/tests/unit/gpu_hmr_runtime_proof.test.ts
npm --prefix mcp/synthi-mcp run build
npm --prefix mcp/synthi-mcp run proof:external-project:self-check
npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check
npx vitest run tests/unit/gpu_hmr_runtime_proof.test.ts
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
docker run --rm -v "${PWD}\backend\synthi-webrtc-compiler\worker:/workspace" -w /workspace vectant-ade-worker-builder-test:latest cargo test --release --features gpu-hmr gpu_fission --lib
docker run --rm -v "${PWD}\backend\synthi-webrtc-compiler\worker:/workspace" -w /workspace vectant-ade-worker-builder-test:latest cargo test --release --features gpu-hmr gpu_prod_contracts --lib
$env:SYNTHI_GPU_HMR_EXTERNAL_PROJECT_DEFAULT_PROFILE_ID='threejs-webgl-shader-lava'; npm --prefix mcp/synthi-mcp run proof:external-project
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
SYNTHI_GPU_AGENT_MODE=seed-only SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_AGENT_FIXTURE=flow SLUG=agent-split-archive-smoke-20260609-pass SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node scripts/gpu-hmr-agent-split-workspace-test.mjs
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=ray-light SLUG=ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=flow SLUG=flow-gpu-hmr-proof-20260622-embedded-ledger-10 SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
npm --prefix mcp/synthi-mcp run proof:oidn:preflight:self-check
npm --prefix mcp/synthi-mcp run proof:opencl:preflight:self-check
SYNTHI_OPENCL_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=opencl-rocm-preflight-20260609-after-output-gate npm --prefix mcp/synthi-mcp run proof:opencl:preflight
npm --prefix mcp/synthi-mcp run proof:vulkan:preflight:self-check
SYNTHI_VULKAN_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=vulkan-rocm-preflight-20260609 npm --prefix mcp/synthi-mcp run proof:vulkan:preflight
node mcp/synthi-mcp/scripts/gpu-hmr-external-project-profile.mjs --rejection-proof-from-report mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
```

Latest HIPRT/OIDN live proof commands:

```text
$env:SYNTHI_HIPRT_PROBE_GPU_ARCH='gfx1201'; $env:SLUG='hiprt-camera-rays-strict-region-20260622'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-22 status: accepted strict HIPRT CameraRays full-runtime proof-ledger row

$env:SYNTHI_HIPRT_PROBE_GPU_ARCH='gfx1201'; $env:SLUG='hiprt-camera-rays-runmodes-20260623-hot1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-23 status: accepted HIPRT CameraRays cold + hot-delta-1 run-mode artifacts

$env:SYNTHI_HIPRT_PROBE_GPU_ARCH='gfx1201'; $env:SLUG='hiprt-camera-rays-runmodes-20260623-hot2-neg'; $env:SYNTHI_HIPRT_WARM_METRIC_SCOPE='hot_delta_2'; $env:SYNTHI_HIPRT_WARM_DIFFERENT_EDIT='1'; $env:SYNTHI_HIPRT_WARM_EDIT_KIND='different_gpu_edit'; $env:SYNTHI_HIPRT_WARM_DELTA_AFTER='hiprtRay ray = render_data.current_camera.get_camera_ray(x_ray_point_direction, render_data.render_settings.render_resolution.y - y_ray_point_direction, render_data.render_settings.render_resolution);'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-23 status: accepted HIPRT CameraRays hot-delta-2 different edit plus ABI-changing negative-edit refusal artifact

$env:SYNTHI_HIPRT_PROBE_GPU_ARCH='gfx1201'; $env:SLUG='hiprt-megakernel-blank-refusal-20260622'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process
  current 2026-06-22 status: refused as blank oracle-region output

$env:SYNTHI_OIDN_WORKER_CONTAINER='vectant-ade-worker-1'; $env:SYNTHI_OIDN_REPO_PATH='/tmp/synthi-real-rocm/HIPRT-Path-Tracer'; $env:SLUG='oidn-hiprt-rocm-preflight-20260622-real-checkout'; npm --prefix mcp/synthi-mcp run proof:oidn:preflight
  current 2026-06-22 status: oidn-hip-rejected due libamdhip64.so.5 dependency mismatch; no shim or symlink fallback accepted
```

Expected rejection command:

```text
SYNTHI_GPU_HMR_EXTERNAL_MCP_TRANSPORT=docker SYNTHI_GPU_HMR_EXTERNAL_SIGNALING_URL=ws://signaling-server:9000 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER=vectant-ade-mcp-1 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js SYNTHI_GPU_HMR_EXTERNAL_MCP_REQUEST_TIMEOUT_MS=1200000 SYNTHI_GPU_HMR_EXTERNAL_MCP_ATTACH_TIMEOUT_MS=1200000 npm --prefix mcp/synthi-mcp run proof:external-project:bevy
```

## Remaining Work

| Plan Area | Current State | Remaining Work |
| --- | --- | --- |
| ROCm/HIP generated runtime | Accepted full-runtime proof exists. | Keep rerun stability high; latest failed reruns must remain rejected. |
| Ray-light/Flow visual MCP | Accepted and visually inspected for June 22 `embedded-ledger-10` slugs; focused matrix proves cold split, hot delta 1, hot delta 2 with different edit, and negative edit refusal. | Keep top-level result files as latest-run convenience outputs only. |
| HIPRT | CameraRays same-process ray-traced visual proof is accepted with embedded ledger/runtime artifact, nonblank oracle-region proof, cold runtime visual evidence, hot delta 1, hot delta 2 with a different edit, and ABI-changing negative-edit refusal. MegaKernel direct-light-zero is refused as blank oracle-region output. | Add additional nonblank HIPRT profiles before claiming broad HIPRT acceptance beyond CameraRays. |
| OIDN | CPU diagnostics pass; HIP backend rejected due `libamdhip64.so.5` dependency mismatch. | Use a matching OIDN HIP build for ROCm 7 or keep OIDN out of accepted HIP proof. No shims. |
| OpenCL | Worker has `libOpenCL.so.1`, but no vendor ICD and no `clinfo`; structured preflight rejected OpenCL runtime proof. | Install/provide a real OpenCL vendor ICD and then add dispatch/event/readback ledger proof. No synthesized ICDs or shims. |
| Vulkan | Worker has `libvulkan.so.1`, but no ICD files and no `vulkaninfo`; structured preflight rejected Vulkan runtime proof. | Provide a real Vulkan ICD/tooling, then add pipeline-layout, command-buffer, frame-boundary, and visual oracle ledger proof. No synthesized ICDs or shims. |
| WebGPU | Scoped Chrome/AMD RDNA4 WGSL runtime visual proof accepted for an explicit-empty-layout, no-bindings, no-vertex-buffers triangle-list pipeline. | Broaden only with executed evidence for bind groups, vertex buffers, pipeline-cache ownership, command/frame traces, and output oracles. Browser flags must remain evidence-only. |
| External projects | ThreeJS visual profile accepted; Bevy remains rejected. Latest run timed out with no decoded frames or visual oracle; an earlier strict gate rejected missing full-runtime proof. | Implement backend-specific full-runtime proof for Bevy before accepting it. |
| CUDA | Not tested on this AMD machine. | Validate only on CUDA hardware. |
| Narrow fission | Deterministic generated-split fission verifier accepted `trace_light_rays` and refused Flow's multi-kernel device role. | Broaden only with verifier evidence for additional backends/projects; do not infer per-kernel fission from one-file output. |
| Browser proof | Preview URLs are live; MCP screenshots exist. | In-app Browser backend was unavailable in this session. |

## Accepted Statement

```text
On the local AMD ROCm machine, Synthi can split generated ROCm/HIP GPU workloads, compile the device artifact with hipcc, hot-reload a device-only edit in a running preview/runtime, prove generated ROCm/HIP device artifacts with strict runtime-ledger acceptance, and provide pixel-backed visual evidence for Flow, ray-light, scoped HIPRT CameraRays with cold/hot1/hot2/negative run-mode coverage, scoped WebGPU WGSL, and external ThreeJS. Blank HIPRT render-region output and ABI-changing HIPRT edits are refused instead of accepted.
```

Do not claim:

```text
CUDA runtime proof was validated here.
Every arbitrary GPU project is production accepted.
The generated ray-light MCP fixture is HIPRT/OIDN.
Broad HIPRT has strict-matrix full-runtime acceptance beyond the scoped CameraRays profile and its structured run-mode sequence.
OIDN HIP produced or validated the accepted output.
OpenCL dispatch/readback output proof was validated on this worker.
Vulkan pipeline/command-buffer/frame output proof was validated on this worker.
General WebGPU bind-group, vertex-buffer, engine-cache, or arbitrary app shader HMR was validated on this worker.
A one-file generated .hip split proves per-kernel or smallest-island fission without deterministic verifier evidence.
Flow's one-file generated .hip split proves per-kernel or smallest-island fission.
Bevy has full-runtime proof-ledger acceptance.
```
