# GPU HMR Investor Demo Status

Updated: 2026-06-24

## Demo Position

Safe investor-demo claim:

```text
On the local AMD ROCm machine, Synthi can hot-reload a GPU device-artifact edit, keep the runtime alive, and prove changed output with strict runtime-ledger evidence. Visual profiles use pixel-backed before/after/diff frame artifacts; compute/readback profiles use raw mapped GPU bytes plus data-derived compute cards, and those cards are not runtime frame visual proof.
```

Best demo surfaces:

1. ROCm/HIP MCP ray-light preview: strongest Synthi app preview proof.
2. ROCm/HIP MCP Flow preview: second generated visual workload, proving this is not a one-case path.
3. Deterministic generated-split fission verifier for ray-light `trace_light_rays`: proof-only row, not a replacement for runtime-ledger acceptance.
4. ThreeJS WebGL external profile: concrete external runtime screenshot proof, not full ledger acceptance.
5. WebGPU Chrome/AMD scoped WGSL runtime visual proof: shader-module/pipeline/frame proof for explicit-empty and explicit-profiled uniform-bind-group/float32-vertex-buffer profiles with cold/hot1/hot2-different-edit/negative run-mode coverage.
6. WebGPU Chrome/AMD scoped WGSL compute/readback proof: native compute pipeline, mapped raw GPU bytes, profile-declared expected-output verification, data-derived PNG proof cards, hot1/hot2-different-edit coverage, and negative ABI refusals.
7. ROCm/HIP module runtime proof: real `.hip` to HSACO, native `hipModuleLoadData`/`hipModuleGetFunction`/`hipModuleLaunchKernel`, raw D2H readback, data-derived PNG compute proof cards, hot1/hot2-different-edit coverage, and ABI refusal.
8. Generated/profiled ROCm/HIP compute ledger: scoped full-runtime proof artifact and output-oracle readback, not broad arbitrary HIP library acceptance.
9. HIPRT same-process CameraRays: source-adapted ray-traced visual-profile proof with embedded ledger/runtime artifact and nonblank oracle-region evidence; useful visual evidence, not no-shim full-runtime GPU HMR acceptance.
10. HIPRT same-process MegaKernel direct-light-gain: second source-adapted ray-traced visual-profile proof on a different HIPRT kernel path, with image-tool-inspected before/after/diff artifacts; useful visual evidence, not no-shim full-runtime GPU HMR acceptance.
11. HIPRT MegaKernel direct-light-zero: useful adversarial visual refusal proving blank render-region output is not accepted.
12. MIOpen large ROCm ML infrastructure profile: useful serious-project refusal proving the harness can attempt upstream MIOpen and still refuse when configure/build, app-hook, epoch, dispatch, host-identity, and output-oracle proof are missing.
13. ROCm examples matrix multiplication profile: useful real ROCm compute refusal proving source-derived output-oracle generation and worker sync do not count as GPU HMR without Synthi epoch, dispatch, host identity, and post-dispatch output observation.

Do not claim:

```text
CUDA was proven on this AMD GPU.
Every arbitrary GPU project is production accepted.
HIP module-load proof means arbitrary HIP libraries/frameworks/apps pass without app-hook, epoch, dispatch, host-identity, and output-oracle proof.
MIOpen large ML full-runtime HMR passed.
ROCm examples matrix multiplication full-runtime HMR passed.
Bevy or broad/general WebGPU has full-runtime proof-ledger acceptance.
HIPRT is accepted as no-shim full-runtime GPU HMR; current HIPRT artifacts are source-adapted visual-profile evidence only.
OIDN HIP produced or validated the accepted visual output.
OpenCL dispatch/readback output proof was validated on this worker.
Vulkan pipeline/command-buffer/frame output proof was validated on this worker.
General WebGPU bind-group kinds, vertex formats, engine-cache, compute beyond the explicit storage/uniform float32 readback profile, or arbitrary app shader HMR was validated on this worker.
One generated `.hip` file proves per-kernel or smallest-safe fission without deterministic verifier evidence.
Flow's generated `.hip` file proves per-kernel or smallest-safe fission.
Any proof succeeded because of a shim or hardcoded scenario path.
```

Current June 24 proof snapshot:

```text
global matrix: gpu-validation-matrix-ledger:sha256:b1ce51442e17147dc7678e35a546bd85877216ca01282f6d4f7c23491d5768b9
global matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260624T020551Z.json
global matrix summary: 55 rows, 19 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 19 scoped full-runtime GPU HMR, 19 all full-runtime rows, 21 refusals, 8 cold splits, 1 deterministic fission, 5 visual profiles, 1 preflight-only, 0 included unproven rows
global matrix scope breakdown: generated_rocm_hip_preview_visual: 6, hip_module_declared_compute_readback: 2, rocm_hip_declared_runtime_profile: 1, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
latest global matrix after evidence-backed declared-scope gates, explicit full-runtime scope classification, broad/library-agnostic scope proof-facet rejection, generic source-adapted proof demotion, query-time source-adaptation/no-shim safety rejection for imported or prebuilt rows, query-time summary recomputation, matrix-computed broad-readiness reporting, status-doc live aggregation checks, latest-attempt selection by canonical target/scope, scoped HIP module hardened gates, WebGPU profiled-layout proof, WebGPU compute expected-output proof, real ROCm proof-obligation, firewall, target-progression, app-hook gating, disabled output-oracle resolution gating, runtime capability preflight surfacing, and the latest 2026-06-24 MIOpen SQLite3/missing-runtime-proof refusal rerun: gpu-validation-matrix-ledger:sha256:b1ce51442e17147dc7678e35a546bd85877216ca01282f6d4f7c23491d5768b9
latest global matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260624T020551Z.json
latest global matrix summary: 55 rows, 19 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 19 scoped full-runtime GPU HMR, 19 all full-runtime rows, 21 refusals, 8 cold splits, 1 deterministic fission, 5 visual profiles, 1 preflight-only, 0 included unproven rows
latest broad readiness: accepted=false, authority=matrix_computed_not_row_declared, broadRuntimeRows=0, scopedRuntimeRows=19, distinctBackendCount=2, open gaps=matrix_level_broad_generalization_proof_not_present,broad_runtime_rows_not_computed_from_matrix,broad_acceptance_requires_more_backend_families
latest global matrix scope breakdown: generated_rocm_hip_preview_visual: 6, hip_module_declared_compute_readback: 2, rocm_hip_declared_runtime_profile: 1, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
history audit matrix: gpu-validation-matrix-ledger:sha256:4ce368b9c6be3ea9b60f513e27b04b945fcdcfba2efb88b25fd3384975829d73
history audit path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260624T020551Z.json
history audit summary: 652 rows, including 597 historical unproven rows; query accepted because unproven rows stay non-success and carry missing-proof/refusal gaps
history audit scope breakdown: generated_rocm_hip_preview_visual: 6, hip_module_declared_compute_readback: 2, rocm_hip_declared_runtime_profile: 1, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
timing summary: mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260623T234336Z.json, count=21; timing metrics are telemetry only, evidenceAuthority=timing_telemetry_only, proofVerdict=not_evaluated_by_timing_summary
global per-target run modes: accepted for 4 enrolled run-mode targets: generated Flow, generated ray-light, scoped WebGPU explicit-empty WGSL, and scoped WebGPU explicit-profiled WGSL; SAXPY remains a full-runtime evidence row outside that run-mode-suite target set
HIP module scoped run modes: accepted for hip-module-runtime-readback only as scoped module-load/readback evidence, with hot_delta_1, hot_delta_2 different edit, executable ABI-negative refusal, epoch-2 artifact hash continuity, and compute-card-only proof separation; it is not a broad HIP app/library claim.
Broad library-agnostic full-runtime rows: 0. Every accepted full-runtime row is currently scoped by generated/profiled preview contract, declared HIP module/readback contract, declared WebGPU pipeline/readback profile, or declared ROCm/HIP runtime ledger evidence. HIPRT source-adapted visual profiles are not counted as full-runtime GPU HMR.
HIPRT run modes: missing for no-shim full-runtime acceptance; CameraRays and MegaKernel direct-light-gain remain source-adapted visual_profile_accepted evidence only.
focused Flow/ray-light matrix: gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
focused matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-focused-flow-ray-light-20260622T181300Z.json
focused matrix coverage: scoped ROCm/HIP full-runtime profile rows accepted, Flow visual path accepted, ray-light visual path accepted, per-target run modes accepted, and ray-light `trace_light_rays` per-kernel/smallest-safe fission accepted. Flow remains device-translation-unit HMR only for fission because its selected device role owns two kernels.
```

Current live previews:

```text
Ray-light: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
Flow:      http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
Preview frontend: http://127.0.0.1:3000 -> HTTP 200 on 2026-06-24
```

Current visual proof artifacts:

```text
Ray-light dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10
Ray-light hot1 ledger: gpu-ledger-proof:sha256:fc798cb97c10df6099ee16d994f8829470596d6408288393da0f751d160a74f2
Ray-light hot2 ledger: gpu-ledger-proof:sha256:a5fc66a3ef1f03824af64d2151ffa970fe57794421f3866bd0127cffdc5b50f2
Ray-light visuals: before-after-diff.png, hot-delta-2-diff.png
Ray-light timings: hot1 total_validator_wall_time=2864084200ns, hot2 total_validator_wall_time=2930783900ns
Ray-light visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-23; both were visibly nonblank and showed different ray-light geometry.

Flow dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260622-embedded-ledger-10
Flow hot1 ledger: gpu-ledger-proof:sha256:82171321eac0bc7b8a4bd5177e51766931a4361600f8b14a668290cdf0ad9e98
Flow hot2 ledger: gpu-ledger-proof:sha256:c92876a2dc20d43f3811f4db236844838b8fd47b3668462c4049dbfbc211503c
Flow visuals: before-after-diff.png, hot-delta-2-diff.png
Flow timings: hot1 total_validator_wall_time=2961567300ns, hot2 total_validator_wall_time=2878428200ns
Flow visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-23; both were visibly nonblank and showed different Flow particle-ring patterns.

WebGPU hot1 proof id: webgpu-runtime-visual-proof:sha256:23db4d987cd865c25a728ec8dfabde136e2beabc40e1efc3392e4a35f9cebcf5
WebGPU hot1 runtime proof: gpu-runtime-proof:sha256:dddf2ab49fb6186c6f9fe2a9ac8af62715b5ccf0ee42e6e7df472e1caeb5fe75
WebGPU hot1 ledger: gpu-ledger-proof:sha256:15207b3d1aa84dbc99987d215febea180ee2af3e685a099c683bb0026d034088
WebGPU hot1 run-mode proof: runtime-run-mode-proof:sha256:5844ac8c28275ac4ea0c20d7d02a0b2b3ae4c215d03a17da5b89587815d707cf
WebGPU hot1 cold proof: runtime-run-mode-proof:sha256:24f695eb8fcd196bf2a03be1e00804b2284809700e8475c427e60c9f974d6fae
WebGPU hot1 negative refusal: agent-split-negative-edit-refusal:sha256:cbc271bf659eb4dab952718ee934dbd2da5928c087ce9b2ec48b391d3e9cb6f4
WebGPU hot1 timing: total_validator_wall_time=659548400ns, trigger_to_visible_time=49171800ns, changed_pixel_ratio=0.29389322916666666
WebGPU hot2 proof id: webgpu-runtime-visual-proof:sha256:2405506bb17e93b3cd5e446a36dcb283bfd932b26c72620fb6287eebcb15ee2e
WebGPU hot2 runtime proof: gpu-runtime-proof:sha256:c13b0ee0fb8d7f7f8dc93e30a3de298c3d8d26e211e3f1051bba3911ee03b80f
WebGPU hot2 ledger: gpu-ledger-proof:sha256:24dcb8fed9f53514ecacf0ede46fdc27db0f4f936100602c186b1c592781253d
WebGPU hot2 run-mode proof: runtime-run-mode-proof:sha256:9f437e19d7120fd3dbcb39e48059f8dbc30f790ed68e3e33b8658573afb86455
WebGPU hot2 cold proof: runtime-run-mode-proof:sha256:f4262a8772e9955440beea19813e2c593dee6200f6ff4c5127c9ee9ebad53c43
WebGPU hot2 negative refusal: agent-split-negative-edit-refusal:sha256:5ed8608701aeea8e7507fec667b5f9a559b0c6a4cb4148e54a0abe1979b6b1cc
WebGPU hot2 timing: total_validator_wall_time=667988100ns, trigger_to_visible_time=49841900ns, changed_pixel_ratio=0.32245225694444446
WebGPU negative refusal reasons: bind_group_layouts_not_supported_by_runner, webgpu_pipeline_layout_or_binding_abi_changed, gpu_hmr_rejected_before_load
WebGPU visual inspection: hot1 after yellow inverted triangle with nonblank diff; hot2 after green rotated triangle with nonblank diff, opened with the local image tool

WebGPU profiled scope: explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list
WebGPU profiled resource trace: bind_group_count=1, uniform binding 0 bytes=32, vertex_buffer_count=1, vertex bytes=48, resource_state_hash=sha256:febd60767177cf5ba103734735eba5e2f083a4b5131c5fab915567e9a843b2f3
WebGPU profiled hot1 proof id: webgpu-runtime-visual-proof:sha256:8d94cd439ac99621306ae61e5a18b7dbf5f56b91d6f2987145fed66dafbe67da
WebGPU profiled hot1 runtime proof: gpu-runtime-proof:sha256:470fb0ec6bfa136668d7aff0f15172a6af81bd21ca05f8ed16d7e55ade88185c
WebGPU profiled hot1 ledger: gpu-ledger-proof:sha256:cdcc04ec9a057c64f0efed4025c66edbba461220c6023bd00160e2a4b0b9b5d9
WebGPU profiled hot1 run-mode proof: runtime-run-mode-proof:sha256:06af47d8287b451e133be6e506361d4cf80dd0b257f89aab3867b0efab2b0fa0
WebGPU profiled hot1 cold proof: runtime-run-mode-proof:sha256:0a2ec2786ef5170781996b2ab2db685eaf3137746cd0c13af52d7bc4e0e85934
WebGPU profiled hot1 negative refusal: agent-split-negative-edit-refusal:sha256:ef5c2543eb5bfdbef5046484fdda9c32b2c78a33c6273e011093dce6bf54d7ca
WebGPU profiled hot1 timing: total_validator_wall_time=931537200ns, trigger_to_visible_time=122562400ns, changed_pixel_ratio=0.23291666666666666
WebGPU profiled hot2 proof id: webgpu-runtime-visual-proof:sha256:ebbf8c0f8811befb7b65a6bf9a522afb16f0a51dffeea1800caace1c53d59f80
WebGPU profiled hot2 runtime proof: gpu-runtime-proof:sha256:d4e424a459c2f5887484a9b583ac9aca06a3f8791a1cde02706c169c53f5b76a
WebGPU profiled hot2 ledger: gpu-ledger-proof:sha256:cbc9fdc9f8fe40feb89254bc4102756c6e310dbec84ac6f45f19771196ded890
WebGPU profiled hot2 run-mode proof: runtime-run-mode-proof:sha256:8e66ce0e816b0cc9367baf98db27505fe92794d137bcad1f6fca5331a431e2b0
WebGPU profiled hot2 cold proof: runtime-run-mode-proof:sha256:a0072433e1aaee79da0c15b3760a8bccb9f05d215e6f09ebd71d3e0f1ce9b4b2
WebGPU profiled hot2 negative refusal: agent-split-negative-edit-refusal:sha256:db00663cbc41045c1fb17475d6ee2f5eaa254baf65ae0539b0ccada63f1c2e23
WebGPU profiled hot2 timing: total_validator_wall_time=923131800ns, trigger_to_visible_time=123553700ns, changed_pixel_ratio=0.24441840277777777
WebGPU profiled visual inspection: hot1 and hot2 after/diff PNGs opened with the local image tool; both were visibly nonblank and the diffs were post-epoch image changes

WebGPU compute scope: explicit-compute-profiled-layout-storage-uniform-float32-readback
WebGPU compute hot1 proof id: webgpu-runtime-compute-proof:a4b48ea7208308a6dcf88098902101a489f861b59c53c11e39741b4753eee0d9
WebGPU compute hot1 ledger: gpu-ledger-proof:sha256:a568b06e613d67045b755700f254054596449f064bcfae7a2a3e555f2a60656a
WebGPU compute hot1 run-mode proof: runtime-run-mode-proof:ae6bf71527f69adb317abe88e3e499e242bc38e4867d3679217a29f42f86d200
WebGPU compute hot1 raw/expected hash: sha256:5b2915f7ad17941e9b1b457a6a276c362edaabb974da6af1daef06f267d77657
WebGPU compute hot1 expected output verified: true, max_abs_delta=0
WebGPU compute hot1 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260623215748-webgpu-wgsl-runtime-compute-storage/webgpu-wgsl-runtime-compute-storage-compute-card.png
WebGPU compute hot1 timing: total_validator_wall_time=703692800ns, dispatch_to_output_proof_time=698975400ns
WebGPU compute hot2 proof id: webgpu-runtime-compute-proof:657f5953dd49f22db02d7faee7614221a104090fe1829db73d017291baec895d
WebGPU compute hot2 ledger: gpu-ledger-proof:sha256:c58667d2a420faeb939f12ee8dc7f922e085b2b16f0b8bdf613d010d6209873b
WebGPU compute hot2 run-mode proof: runtime-run-mode-proof:8d872d2ac487207580b1b977ab3736701ed01d372009619f318b7985183ac7bd
WebGPU compute hot2 raw/expected hash: sha256:25e6442aa7b6a1c025719aaec529c2c815c3c0590618ade8607ab2e99f9ba5b5
WebGPU compute hot2 expected output verified: true, max_abs_delta=0
WebGPU compute hot2 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260623215754-webgpu-wgsl-runtime-compute-storage-hot2/webgpu-wgsl-runtime-compute-storage-hot2-compute-card.png
WebGPU compute hot2 timing: total_validator_wall_time=684121000ns, dispatch_to_output_proof_time=681865500ns
WebGPU compute-card image inspection: hot1 and hot2 compute cards opened with the local image tool; both display mapped GPU readback values and `expected output verified: true`. They are compute/readback evidence, not runtime frame visual proof; current timing rows report `screenshotCount=0`, `reportedVisualAccepted=false`, and `reportedComputeCardAccepted=true`.

HIPRT hot1 proof id: hiprt-warm-runtime-proof:sha256:d0a8b4ca701d855e96ce0c6b812c668a4307901d13b232948e5c629fe7b0384b
HIPRT hot1 runtime proof: gpu-runtime-proof:sha256:41cfc3ac84b5d95ee667711bcbb52e76a6fc4c2be96905d95f3fac4e7ce4b355
HIPRT hot1 ledger: gpu-ledger-proof:sha256:7e6853bc6da3257e4b3002512b15098bdbe3380d287df8245f2b308976157523
HIPRT hot1 visual: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-runmodes-20260623-hot1-diff-amplified.png
HIPRT hot1 timing: total_validator_wall=310330.826ms, live_recompile=45ms, trigger_to_visible=8618ms, changed_pixel_ratio=0.9140190972222222
HIPRT hot2 proof id: hiprt-warm-runtime-proof:sha256:5c2fadcac8b6b32a7c60b227cb88d167cb91488157d47bc3389ac555886d5542
HIPRT hot2 runtime proof: gpu-runtime-proof:sha256:444a57c35075550e3d229fe9b248bab36bef8c21b765f9d5981f0c9f64e5dfd0
HIPRT hot2 ledger: gpu-ledger-proof:sha256:847ca2295ee40cf6782f51f2d3411221437bde26f7bfbe5ffdbc3bb5a953d94f
HIPRT hot2 visual: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-runmodes-20260623-hot2-neg-diff-amplified.png
HIPRT hot2 timing: total_validator_wall=13840.4776ms, live_recompile=45ms, trigger_to_visible=2463ms, changed_pixel_ratio=0.9486458333333333
HIPRT cold run-mode proof: runtime-run-mode-proof:sha256:e889f9f87531a4f446bf6f4418d417edb1d5f92afc975594fbb0e358c5cec0fa
HIPRT negative edit refusal: agent-split-negative-edit-refusal:sha256:f44d46b50f0c36124535d1d348bc49b49b75073b56d0992a1d57ec1e273e7a01
HIPRT visual inspection: hot1 and hot2 diff PNGs opened with the local image tool; both were visibly nonblank ray-traced frame diffs.

HIPRT MegaKernel light-gain proof id: hiprt-warm-runtime-proof:sha256:bfc7237c96db6688d94410167ff705fb41c0a955c6dee01ccd43011f3537c102
HIPRT MegaKernel light-gain runtime proof: gpu-runtime-proof:sha256:2256732f63143775e7c15db599828ef1b6a32dbb82fef0cba0aaf0fcd946ddef
HIPRT MegaKernel light-gain ledger: gpu-ledger-proof:sha256:8ede8c7a1bcea38429eb855947e73150fa8d7b508ee6301a81d7cd521b94721b
HIPRT MegaKernel light-gain run-mode proof: runtime-run-mode-proof:sha256:b3024731a9269acf258397ad569f81fc9ab30826494ebf95105e3f1e6c2c10f8
HIPRT MegaKernel light-gain negative refusal: agent-split-negative-edit-refusal:sha256:7ad67b17ba2154822ae576208675c1f837485d4e1574a310c463f8875476b46b
HIPRT MegaKernel light-gain visual: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-light-gain-20260623-diff-amplified.png
HIPRT MegaKernel light-gain timing: total_validator_wall=348533.3747ms, live_recompile=32718ms, trigger_to_visible=37546ms, changed_pixel_ratio=0.3540494791666667, mean_abs_delta_8bit=7.759528356481481
HIPRT MegaKernel visual inspection: before, after, and amplified diff PNGs opened with the local image tool; the same Cornell-style scene remains visible and the post-epoch direct-light gain is nonblank.
```

Current HIPRT/OIDN caveat:

```text
HIPRT CameraRays reruns on 2026-06-23 with SYNTHI_HIPRT_PROBE_GPU_ARCH=gfx1201 remain useful visual evidence after the matrix recomputes oracle evidence from persisted PNG pixels. The matrix now reports `hiprt_run_modes=missing` and classifies CameraRays/MegaKernel direct-light-gain rows as `visual_profile_accepted`, because their runtime probe instrumentation discloses source-adapted profile hooks. This is not no-shim full-runtime HIPRT acceptance and not broad HIPRT application acceptance.
HIPRT MegaKernel direct-light-zero rerun on 2026-06-22 is refused because the post-epoch oracle region is blank.
OIDN live preflight ran against /tmp/synthi-real-rocm/HIPRT-Path-Tracer and is rejected for HIP output proof because libOpenImageDenoise_device_hip.so.2.3.0 depends on missing libamdhip64.so.5.
No compatibility shim, symlink, fake ICD, or project-specific branch was added.
```

Current MIOpen large ROCm ML caveat:

```text
profile: real-rocm-miopen-activation-large-ml
result slug: gpu-real-rocm-MIOpen-20260624004129
result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
repo: ROCm/MIOpen @ 06977176afd94476c18d5290f21cb40745bb73a9
target: MIOpenDriver activ -n 1 -c 1 -H 8 -W 8 -F 1 -V 1 -t 1
runtime device preflight: device_count=1, device="AMD Radeon RX 9070 XT", arch=gfx1201, hipMallocArray result=1, error=invalid argument, allocationAvailable=false
runtime capability preflight matrix facet: status=gpu-runtime-array-allocation-unavailable, accepted=false, can_satisfy_runtime_proof=false, gaps=runtime_array_allocation_unavailable,runtime_any_array_allocation_unavailable,runtime_array_allocation_matrix_failed,runtime_texture_fallback_unavailable,runtime_texture_resource_matrix_failed
upstream configure/build/run: configure failed before build because SQLite3_INCLUDE_DIR and SQLite3_LIBRARY are missing in the worker; build.log and run.log were not produced
configure log: CMake could not find SQLite3
native evidence: native launch observer was requested, but no readiness, launch, function-resolution, argument-provenance, or runtime-session lines were captured
split projection: no fresh AI split/delta calls in this rerun
delta projection: none accepted; configure failed before compile/delta proof material was collected
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
device sidecar contract facet: no sidecar contract accepted; static candidate metadata is evidence-only and cannot satisfy runtime proof
timings: total_validator_wall=16598.7458ms
accepted GPU HMR: false
strict refusal: runtime proof artifact exists but is rejected; configure/build evidence and runtime proof chain are missing, full runtime proof remains unproven, proof ledger rejects, and acceptance contract rejects
oracle resolution: profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, worker profile cleared with syncSkippedReason=runtime_profile_absent
worker proof boundary: no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, output_oracle, host_identity, or original_host_path attachment evidence
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
real ROCm app-hook contract facet: declared=false, can_satisfy_runtime_proof=false, stages missing artifact_transport, epoch_publication, dispatch_trace, host_identity, and output_oracle
real ROCm runtime eligibility facet: status=refused_missing_runtime_proof, backend_candidates=hip, source_dialects=opencl_c,c_cpp, artifact_kind=hip_source_bridge, entry_points=MIOpenActivationForward/miopenActivationForward, compiler=/opt/rocm/llvm/bin/amdclang, gaps=artifact_transport_not_observed,same_process_epoch_missing,dispatch_epoch_missing,output_oracle_profile_absent,host_identity_not_observed
target progression: final-acceptance, required=true, target=MIOpenDriver, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, raw compute oracle artifacts
target progression ledger: target-progression-ledger:sha256:02a374c77757e3c0d220bae4d8905707deb52cba76060573eaaeee61744ff608, entry_status=fail
visual proof: no MIOpen frame captured; matrix marks visual.required=false for this compute-only target and still refuses because strict runtime ledger and raw output-oracle proof are missing
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
refusal proof ids: gpu-ledger-proof:sha256:20cf0403be1c941188adeedf3a08c573a75007e24fa484a391706d5e692ea9b5, gpu-runtime-proof:sha256:9c49bea898437713b4d3bdf49d098a89c3e1daea91b301c986de0ce6ec2dd792, real-rocm-validation:sha256:e2d276f7d5cf461a66723cc7a433a30b3330635a51b60e8c1a55688792b06203, target-progression-ledger:sha256:02a374c77757e3c0d220bae4d8905707deb52cba76060573eaaeee61744ff608
matrix row id: gpu-validation-matrix-row:sha256:15ef5d6925b15c0fa10c46a1dab62051416441e845ff381135868b503e0e1dc1 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260624T020551Z.json
matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, app-hook contract/runtime observations missing, target-progression gates failed, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
plan coverage: large_real_rocm_repo=refused
```

Current ROCm matrix multiplication compute-oracle caveat:

```text
profile: real-rocm-matrix-multiplication
result slug: gpu-real-rocm-matrix-bridge-facet-tight-20260623
result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
repo: ROCm/rocm-examples @ c121d6d2e6a21ce1d0a140e97b890ada635f7574
target: hip_matrix_multiplication
upstream build/run: configure=1509ms, build=1840ms, run=230ms, run_exit_code=0
output oracle: profile=hip.matrix-multiplication.readback-c.v1, selected_source=source_derived_profile, oracle=oracle:real-rocm:matrix-readback-c:b8f18aad760bfaf7, baseline=sha256:aaedc7073c76880db6c8be81a91229d0073f1069e70791a7d028f575910c352c, expected=sha256:e7352404a601e877e39b4ae06181ce1597e93ccbbb2c9d654eb9df479bb9a858, worker_profile_synced=true
candidate artifact entry point: matrix_multiplication_kernel
native evidence: hipLaunchKernel observed through the native launch observer
target progression: phase=small-oracle, required=true, final_acceptance_target=MIOpenDriver, output_oracle gate failed because runtime_dispatch_not_observed
compile bridge facet: status=compile_bridge_missing, phase_count=2, compile_response_status=compile_bridge_not_declared_by_compile_response, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
timings: initial_compile=30007ms, hot_delta_compile=30005ms, hot_wait=30002ms, total_validator_wall=169071.7042ms
accepted GPU HMR: false
strict refusal: runtime proof artifact exists but is rejected; native HIP launch evidence is evidence-only and cannot satisfy GPU HMR
runtime proof artifact: gpu-runtime-proof:sha256:0e09ae2abdc7bbae534ecca51d96f38d7276e6e243a47026d861e7d13fd2265e
worker proof boundary: no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, host_identity, or runtime output_oracle observation
native ROCm refusal facet: status=refusal_evidence, can_satisfy_dispatch_proof=false, gaps=native_launch_boundary_observed,native_boundary_not_synthi_dispatch_proof,synthi_dispatch_not_observed,artifact_transport_not_observed,epoch_not_observed,output_oracle_not_observed,host_identity_not_observed,adapter_impossible_requires_app_hook
real ROCm app-hook contract facet: status=required_app_hook_contract_missing, declared=false, required=true, can_satisfy_runtime_proof=false
visual proof: compute-only target; no frame captured or counted, and strict ledger still refuses because post-epoch output-oracle observation is missing
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
matrix proof ids: gpu-ledger-proof:sha256:15de5dc81722d2de9a503693a4708046731875e6ae396759a109b094356c8413, gpu-runtime-proof:sha256:0e09ae2abdc7bbae534ecca51d96f38d7276e6e243a47026d861e7d13fd2265e, real-rocm-validation:sha256:bdabe89a91de0f03bfd1c732a1c96c8618ba1570d67378c724b12f08e4c0d5ac
matrix row id: gpu-validation-matrix-row:sha256:61dd0d2471d7e70e698f0f55eaea75654c5931adda8b957efea75bf79cb0c040
historical matrix ledger for this matrix-multiplication run: gpu-validation-matrix-ledger:sha256:361ddb15ef7c1c953447756453578b4c10ab1888d62915156f72fd3618af8339
```

## Current Hardening Status

Latest implementation commits:

```text
98f949bbf chore(gpu-hmr): add validation matrix history proof script
3e524e72e test(gpu-hmr): surface ROCm runtime preflight failures
56ab9db70 test(gpu-hmr): require explicit firewall safety fields
0a80f4db0 test(gpu-hmr): require phase-specific target progression proof
d93af9b6c test(gpu-hmr): gate real ROCm target progression failures
b7068a698 test(gpu-hmr): fail closed on required ROCm app hooks
95ddc87b6 test(gpu-hmr): surface ROCm app hook proof obligations
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
1004e5d39 test(gpu-hmr): expose ROCm sidecar contracts as non-authoritative
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

Demo-relevant rule changes:

```text
Screenshots and pixel diffs are visual evidence, not authority.
Visual HMR acceptance now requires visual_oracle_artifacts in the derived proof ledger record.
Fission acceptance requires a verified output-oracle proposal or resolved output-oracle contract.
Generated device edits in the visual runner now require the MCP wait gate to apply with full GPU runtime proof before acceptance.
The visual runner now fails immediately when no initial generated device compile marker or GPU split endpoint evidence is observed.
The generated ray-light and Flow demos remain device-translation-unit runtime-HMR claims.
Generated split topology now rejects per-kernel HMR unless deterministic fission-verifier evidence proves it.
Narrow generated fission candidates now require topology binding to a content-addressed partial artifact before the verifier can pass them.
The deterministic fission verifier accepts ray-light `trace_light_rays` and refuses Flow because the selected generated device role contains two kernels.
The validation matrix now carries run-mode evidence, refuses WebGPU supplied-query-only proofs without an embedded ledger, and treats standalone external rejection proof artifacts as first-class refusal rows.
Per-target run-mode coverage is now reported as accepted, partial, or missing with negative-edit refusal evaluated per accepted target, not globally.
Run-mode-suite obligation is now row metadata: structured run-mode proof rows infer `validationTargetScope=run_mode_target`; other full-runtime evidence rows remain `evidence_row` unless an artifact declares a run-mode obligation.
HIPRT visual matrix acceptance now requires embedded proof-ledger/runtime-artifact materials plus a matrix-recomputed nonblank oracle-region check from persisted before/after PNG pixels; direct-light-zero is refused as blank render-region output.
Large real ROCm repository rows are matrix-ingested generically from `real_rocm_profile` artifacts and fail closed unless strict runtime proof, recomputed ledger proof, and artifact-backed output or visual oracle proof are present; top-level oracle success booleans are not authority.
Large real ROCm compute oracle rows now re-read raw readback, schema, and rendered-card PNG files from disk; embedded file-integrity booleans are not authority, and compute-ledger rows cannot borrow unrelated top-level visual files to pass.
Real ROCm runtime output-oracle profiles now sync by configured worker container instead of MCP transport; the latest MIOpen profile declares no runtime oracle profile, so the worker oracle file was cleared and the run correctly stayed refused.
Native ROCm/HIP launch-boundary evidence is now machine-readable refusal context, not dispatch authority. It enters the derived acceptance contract as blocking gaps while `can_satisfy_dispatch_proof=false`.
Large real ROCm profiles can now supply generic runtime output-oracle profiles and target-progression defaults. The latest MIOpen result records oracle resolution explicitly: profile `none`, no selected oracle source, no contract, and no runtime profile.
The latest MIOpen rerun also records the generic compile-bridge facet as `compile_bridge_missing`: the no-device run collected no compile phase proof material and no `load_device`, device-sidecar, artifact reference, or runtime-proof material.
The ROCm examples matrix multiplication result records oracle resolution explicitly: profile `hip.matrix-multiplication.readback-c.v1`, source-derived selected oracle, runtime profile synced to the worker, and strict refusal because runtime Synthi epoch/dispatch/output proof is absent.
Real ROCm output-oracle profiles now require declared native launch symbols, and runtime eligibility filters native placeholder symbols such as `unknown`; the matrix multiplication candidate artifact records `matrix_multiplication_kernel`.
The MIOpen large-ML profile now requires `targetProgression.phase=final-acceptance`; the latest run fails the missing prior small-oracle, partial-reload, original-host-path, full-runtime, and raw-compute-oracle-artifact gates instead of leaving the target undeclared.
The ROCm examples matrix multiplication profile is now a required `small-oracle` progression phase for the larger `MIOpenDriver` final-acceptance ladder. It still fails closed because the small-oracle gate requires real runtime output proof after Synthi dispatch, not only a derived checksum contract.
Real ROCm compile phases now preserve an evidence-only compile bridge facet. The latest tightened matrix run records no compile-declared `load_device`, device-sidecar, artifact-reference, runtime-proof material, or matching bridge signal strings, so the matrix row exposes `real_rocm_compile_bridge:compile_response_device_sidecar_bridge_not_declared`.
Compile bridge candidates are also non-authoritative. Even if a future compile response names `load_device`, device sidecars, artifacts, and proof material, the matrix keeps it as `compile_response_bridge_candidate_not_runtime_proof` until runtime artifact transport, epoch publication, dispatch, host identity, and output-oracle proof are actually observed.
Real ROCm device-sidecar contracts are now a separate non-authoritative facet. The latest MIOpen rerun derives an OpenCL-program candidate from CMake/build metadata and include reachability, then keeps it blocked until runtime artifact transport, epoch publication, dispatch trace, host identity, and output-oracle proof are observed.
Real ROCm final-acceptance profile proof obligations are now matrix-gated. A final-acceptance target without an output-oracle profile is refused unless explicitly marked refusal-only, and `targetProgression.required=true` implies full-runtime proof.
Real ROCm CPU/GPU firewall evidence is now matrix-gated from recomputed ledger/runtime evidence. Accepted rows must explicitly prove `cpuHmrUsed=false`, `fullRebuildUsed=false`, and `processRestarted=false`; missing firewall evidence, forged CPU fallback, hidden full rebuild, process restart, and old-artifact dispatch are refusal material.
Real ROCm final-acceptance target progression now revalidates prior small-oracle rows from raw compute oracle artifacts or readable visual artifacts with matching content hashes; proof ids and status labels are not enough.
Real ROCm target-progression gate failures are now hard matrix blockers; failed prior partial-reload/original-host-path gates cannot be hidden behind otherwise successful runtime/oracle rows.
Real ROCm app-hook requirements now fail closed when explicitly declared through profile proof obligations, profile declarations, native-boundary app-hook gaps, or the app-hook facet itself. Missing or unproven required app-hook facets cannot be accepted by default-open ingestion.
Real ROCm validation matrix rows now carry native ROCm launch-boundary and runtime-eligibility facets as queryable refusal gaps, while preserving `can_satisfy_dispatch_proof=false` for native function resolution.
Real ROCm runtime capability preflight now surfaces as a generic evidence-only facet from top-level, summary, runtime-artifact, evidence, or original-host proof containers; failed device/allocation preflight blocks accepted real ROCm rows but cannot satisfy GPU HMR success.
Real ROCm matrix rows now preserve `outputOracleResolution`, `targetProgression`, and `targetProgressionGates`, so the serious-project refusal reason is queryable from the matrix artifact instead of inferred from logs.
Visual matrix evidence now requires decoded PNG images, not header-only files or screenshot existence. Run-mode visual proofs cannot opt out with `visualRequired=false`, and Flow/ray-light coverage only counts accepted visual rows.
Ray-light and Flow now have hot-delta-1 monotonic timing evidence from live MCP timing-matrix runs.
HIPRT CameraRays now emits structured cold/hot run-mode artifacts from the same proof runner instead of relying on the single warm proof artifact alone.
HIPRT CameraRays now emits an ABI-changing negative-edit refusal artifact derived from the real upstream kernel signature, with `gpuHmrSuccess=false` and `abi_layout_changed`.
Vulkan preflight now rejects missing ICD/tool evidence and cannot count as pipeline or frame-output proof.
WebGPU preflight records Chrome launch flags, AMD RDNA4 adapter evidence, and a nonblank diagnostic screenshot, but still cannot count as shader/pipeline/frame HMR proof.
WebGPU runtime visual proof now accepts the executed explicit-empty WGSL pipeline scope and the executed explicit-profiled uniform-buffer plus float32-vertex-buffer scope. Both require shared ledger success, visual-threshold success, process-continuity evidence, native WebGPU API evidence, and runtime binding/resource traces where resources are present.
The timing summary now includes WebGPU runtime visual and compute/readback proofs in the same normalized timing schema as ROCm/HIP, HIPRT, and external profiles.
```

Post-hardening verification:

```text
npx vitest run tests/unit/gpu_hmr_runtime_proof.test.ts -> 279 passed
npm --prefix mcp/synthi-mcp run build -> passed
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:adversarial-ledger:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:acceptance-contract:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:runtime-profile:self-check -> passed
cargo gpu_fission tests in worker builder image -> 64 passed
cargo gpu_prod_contracts tests in worker builder image -> 36 passed
node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs -> passed
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs -> passed
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check -> passed
npm --prefix mcp/synthi-mcp run proof:visual-evidence:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:generated-split-granularity:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix -> passed
npm --prefix mcp/synthi-mcp run proof:opencl:preflight:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:oidn:preflight:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:vulkan:preflight:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:preflight:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:profiled -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:profiled-hot2 -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-compute -> passed
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-compute:hot2 -> passed
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:timing-metrics -> passed
npm --prefix mcp/synthi-mcp run proof:external-project:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:megakernel-light-gain -> passed
node --check mcp/synthi-mcp/scripts/hiprt-light-math-warm-proof.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
latest validation matrix -> gpu-validation-matrix-ledger:sha256:b1ce51442e17147dc7678e35a546bd85877216ca01282f6d4f7c23491d5768b9
latest history audit matrix -> gpu-validation-matrix-ledger:sha256:4ce368b9c6be3ea9b60f513e27b04b945fcdcfba2efb88b25fd3384975829d73
focused Flow/ray-light matrix -> gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
npm --prefix mcp/synthi-mcp run proof:strict-gates:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check -> passed
npm --prefix mcp/synthi-mcp run build -> passed
```

## Live Preview Targets

The local stack is running:

```text
frontend: 127.0.0.1:3000
MCP: 127.0.0.1:9464
worker: up
```

HTTP preview checks passed:

```text
Ray-light: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
Flow:      http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
Ray-light embedded-ledger proof: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 -> cold/hot1/hot2/negative run modes proven in focused matrix
Flow embedded-ledger proof:      http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10 -> cold/hot1/hot2/negative run modes proven; per-kernel fission refused
```

Headless Chrome page-level captures showed only the dark app shell and are not counted as proof. Visual proof for this checkpoint comes from MCP screenshot artifacts tied to frame gates and local image inspection of the persisted PNGs.

## Ray-Light Preview Proof

Current accepted proof is `ray-light-gpu-hmr-proof-20260622-embedded-ledger-10`; the older June 9 timing-matrix block below is retained as historical context.

```text
workspace slug: ray-light-gpu-hmr-proof-20260622-embedded-ledger-10
workspace url: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10
hot delta 1 ledger id: gpu-ledger-proof:sha256:fc798cb97c10df6099ee16d994f8829470596d6408288393da0f751d160a74f2
hot delta 2 ledger id: gpu-ledger-proof:sha256:a5fc66a3ef1f03824af64d2151ffa970fe57794421f3866bd0127cffdc5b50f2
hot delta 1 visual diff: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10/before-after-diff.png
hot delta 2 visual diff: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10/hot-delta-2-diff.png
hot delta 1 total validator wall time: 2864084200ns
hot delta 2 total validator wall time: 2930783900ns
deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays
```

Historical June 9 timing-matrix proof:

```text
workspace slug: ray-light-gpu-hmr-proof-20260609-timing-matrix
runtime proof id: gpu-runtime-proof:sha256:fed37d01a7b988bfd5bc25c1adeb03d2c2a6cc8082aaa8324f64aaf6a894437b
ledger id: gpu-ledger-proof:sha256:983d2c96e1a6bd58dc3094d31a8d24b245a4a24d88754a87208abea562ea61dc
result state: gpu-hmr-full-runtime-proven
HMR plan: device_only
metric scope: hot_delta_1
cache state: compiler_cache_warm
device compile wall time: 17027600ns
runtime probe time: 11284379700ns
total validator wall time: 11301664400ns
deterministic fission: accepted=true claim=per_kernel_hmr kernel=trace_light_rays
```

Artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260609-timing-matrix/agent-split-results.txt
```

Visual/timing numbers:

```text
changed pixels: 5.89%
mean abs delta: 9.92
control changed: 0.00%
control mean abs: 0.03
selected frame seq: 8673
selected delta: 1098ms
```

Visual inspection: before renders a ray/light scene with ground grid and ray bundle; after moves the light/ray path; the diff is nonblank and high-signal.

## Flow Preview Proof

Current accepted proof is `flow-gpu-hmr-proof-20260622-embedded-ledger-10`; the older June 9 timing-matrix block below is retained as historical context.

```text
workspace slug: flow-gpu-hmr-proof-20260622-embedded-ledger-10
workspace url: http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10
hot delta 1 ledger id: gpu-ledger-proof:sha256:82171321eac0bc7b8a4bd5177e51766931a4361600f8b14a668290cdf0ad9e98
hot delta 2 ledger id: gpu-ledger-proof:sha256:c92876a2dc20d43f3811f4db236844838b8fd47b3668462c4049dbfbc211503c
hot delta 1 visual diff: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260622-embedded-ledger-10/before-after-diff.png
hot delta 2 visual diff: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260622-embedded-ledger-10/hot-delta-2-diff.png
hot delta 1 total validator wall time: 2961567300ns
hot delta 2 total validator wall time: 2878428200ns
deterministic fission: accepted=false failure=symbol_ownership; device_translation_unit_hmr only
```

Historical June 9 timing-matrix proof:

```text
workspace slug: flow-gpu-hmr-proof-20260609-timing-matrix
runtime proof id: gpu-runtime-proof:sha256:d853e7a6c560d96b1cf4011dd24d67d69b81d026946070f12a745dde3fcecbdb
ledger id: gpu-ledger-proof:sha256:f5ec4c6b608520221cfe7bf2ecd6344f3d37d37d3a262eafa4a1458c2dd8e54b
result state: gpu-hmr-full-runtime-proven
HMR plan: device_only
metric scope: hot_delta_1
cache state: compiler_cache_warm
device compile wall time: 24515900ns
runtime probe time: 3126806700ns
total validator wall time: 3151554600ns
deterministic fission: accepted=false failure=symbol_ownership because selected device role contains particle_init and particle_flow
```

Artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/after-hmr-first.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/before-after-diff.png
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-granularity.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/generated-split-deterministic-fission.json
mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260609-timing-matrix/agent-split-results.txt
```

Visual/timing numbers:

```text
changed pixels: 2.59%
mean abs delta: 3.58
control changed: 0.00%
control mean abs: 0.01
selected frame seq: 9230
selected delta: 2755ms
```

Visual inspection: before renders a sparse particle ring; after renders a gridded wave/field; the diff is nonblank.

## Generated Split Claim

The generated preview demos prove device-translation-unit runtime HMR. The deterministic fission verifier is separate.

```text
Flow: device_translation_unit_hmr, one device TU, two kernels, rejects per_kernel_hmr and smallest_safe_fission_island.
Ray-light runtime: device_translation_unit_hmr, one device TU, one kernel.
Ray-light fission: per_kernel_hmr accepted by deterministic verifier for trace_light_rays.
```

Demo phrasing:

```text
The current generated HIP path hot-reloads the generated device translation unit. Per-kernel/smallest-safe is claimed only when the deterministic verifier has full category coverage and runtime/visual proof binding.
```

Verifier guard:

```text
Narrower generated fission requires generated-topology evidence, loader/runtime proof binding, ABI evidence, compile recipe evidence, and output-oracle evidence.
Missing coverage keeps the row unproven; Flow rejects at symbol_ownership.
```

## HIPRT Ray-Traced Proof

HIPRT is separate from the MCP browser preview path. The current investor-safe HIPRT claim is deliberately narrow: CameraRays and MegaKernel direct-light-gain are source-adapted ray-traced visual-profile evidence with nonblank oracle-region proof, not no-shim full-runtime GPU HMR acceptance. MegaKernel direct-light-zero is not accepted; it is a proven blank render-region refusal.

```text
worker repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

CameraRays:

```text
profile: hiprt-camera-rays-horizontal-mirror
matrix outcome: visual_profile_accepted
acceptedForGpuHmr: false
sourceAdaptedProfile: true
proof id: hiprt-warm-runtime-proof:sha256:1d15cb417f082b7ed3602abaecf05d8983c6ac647d0076a510fe75e477c38aea
strict runtime proof id: gpu-runtime-proof:sha256:7ef274e6d60f3a17f66b02437ff9846073744ba3408f013430bdc0ed75283f25
proof ledger id: gpu-ledger-proof:sha256:c7345ddcd4b9ddf1ef1e56d0fadf8dffb56d2a688074c8337c3bdbca265a6037
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-camera-rays-strict-region-20260622-diff-amplified.png
changed pixels: 91.4019%
mean abs delta 8-bit: 53.1273
oracle-region nonblank: true
live recompile: 87ms
edit to first visual: 8008ms
total wall: 32815.8128ms
```

Note: older persisted HIPRT JSON may still contain raw success-looking fields from before source-adapted demotion. The current validation matrix is the authority and recomputes `acceptedForGpuHmr=false` from the disclosed source adaptations.

MegaKernel direct-light-zero refusal:

```text
profile: hiprt-megakernel-direct-light-zero
accepted: false
matrix outcome: refusal_proven
proof id: hiprt-warm-runtime-proof:sha256:ca0effaf57433ead4ef062c54a168537178f84f555425fbc87127f5caa516f9e
strict runtime proof id: gpu-runtime-proof:sha256:2be665516b31ddf724e6d793013f4a141db419e8259cccefdea4d10594dbafbe
proof ledger id: gpu-ledger-proof:sha256:32b1b8f456fa3b31984ac997ddc404e88cfa8e0c03117429e787677a983d937f
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-megakernel-blank-refusal-20260622-diff-amplified.png
changed pixels: 41.8229%
mean abs delta 8-bit: 32.9462
oracle-region nonblank: false
oracle-region changed visible ratio: 0.007079728781856441
live recompile: 209ms
edit to first visual: 7623ms
total wall: 30637.1206ms
```

Visual inspection: CameraRays before/after/diff are readable and nonblank, showing a mirrored/recomposed Cornell-style framebuffer. MegaKernel's changed render region is mostly black, and the stricter oracle refuses it even though the diff image is high-signal.

## OIDN Result

Structured OIDN preflight proof:

```text
proof id: oidn-preflight-proof:sha256:5fc3136f57579a91c4be2475af7d1776d23e5c19696d7f76a1794413db5ec21a
result state: oidn-hip-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-summary.txt
repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
```

OIDN HIP was tested and rejected:

```text
oidnTest 'device creation' --device hip --success --durations yes --rng-seed 12345
result: FAILED, bool(device) false

oidnTest 'buffer read/write' --device hip --success --durations yes --rng-seed 12345
result: FAILED, bool(device) false

ldd libOpenImageDenoise_device_hip.so.2.3.0:
libamdhip64.so.5 => not found
unsupported reasons: missing_dependency:libamdhip64.so.5, oidn_hip_buffer_read_write_failed, oidn_hip_device_creation_failed
noShimApplied: true
noSymlinkApplied: true
noSynthesizedRuntime: true
```

OIDN CPU diagnostics passed:

```text
device creation: 8 assertions passed
buffer read/write: 27 assertions passed
```

No OIDN HIP proof is accepted, and no symlink or ABI shim was added.

## OpenCL Result

Structured OpenCL preflight proof:

```text
proof id: opencl-preflight-proof:sha256:64e92684b59489f2dc88c1ac6e570fd54605bc9bb345cb6653cc15e22714c4ea
result state: opencl-runtime-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260609-after-output-gate-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/opencl-preflight/opencl-rocm-preflight-20260609-after-output-gate-summary.txt
```

OpenCL was tested and rejected:

```text
OpenCL loader: libOpenCL.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libOpenCL.so.1
vendor ICDs: none
platform count: unknown
device counts: none
unsupported reasons: opencl_vendor_icd_missing, clinfo_missing
```

The preflight does not count as OpenCL HMR output proof:

```text
acceptedForOpenClOutputProof: false
gpuHmrSuccess: false
dispatchTraceRequired: true
outputOracleRequired: true
noShimApplied: true
noVendorIcdSynthesized: true
noSymlinkApplied: true
```

No OpenCL proof is accepted on this worker, and no vendor ICD, symlink, or compatibility shim was synthesized.

## Vulkan Result

Structured Vulkan preflight proof:

```text
proof id: vulkan-preflight-proof:sha256:d904016a24c785659424bae3cc5381ae2a84b816fee87c1f13dd335709d7a528
result state: vulkan-runtime-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-summary.txt
```

Vulkan was tested and rejected:

```text
Vulkan loader: libvulkan.so.1 (libc6,x86-64) => /lib/x86_64-linux-gnu/libvulkan.so.1
ICD files: none
ICD libraries: none
API version: unknown
physical device count: 0
device names: none
unsupported reasons: vulkan_icd_missing, vulkaninfo_missing
```

The preflight does not count as Vulkan HMR proof:

```text
acceptedForVulkanPipelineProof: false
gpuHmrSuccess: false
pipelineLayoutProofRequired: true
commandBufferTraceRequired: true
frameOutputOracleRequired: true
noShimApplied: true
noIcdSynthesized: true
noSymlinkApplied: true
```

No Vulkan proof is accepted on this worker, and no ICD, symlink, or compatibility shim was synthesized.

## WebGPU Result

Structured WebGPU runtime preflight proof:

```text
proof id: webgpu-preflight-proof:sha256:c6cc4216d34477cf4968797b420d4ac4f331b84834939acc5c1a956f2c31bd2d
result state: webgpu-runtime-preflight-accepted
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-summary.txt
diagnostic screenshot: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260609-diagnostic.png
```

WebGPU runtime preflight was tested and accepted:

```text
browser: C:\Program Files\Google\Chrome\Application\chrome.exe
browser launch args: --enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan,WebGPU,UseSkiaRenderer --disable-gpu-sandbox
adapter: {"vendor":"amd","architecture":"rdna-4","device":"","description":""}
preferred canvas format: bgra8unorm
unsupported reasons: none
```

Visual inspection confirmed the diagnostic screenshot is nonblank and contains a rendered WebGPU triangle plus runtime JSON proving secure context, `navigator.gpu`, adapter, device creation, and render submit.

The preflight does not count as WebGPU HMR proof:

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

No WebGPU shim was added. Browser flags are disclosed as runtime enablement evidence only, not as proof of shader-module, pipeline, epoch, or frame-output HMR.

Historical June 9 base explicit-empty WebGPU runtime visual proof. Current accepted WebGPU visual rows are the 2026-06-23 explicit-empty hot1/hot2 and explicit-profiled hot1/hot2 scoped rows recorded in the latest matrix above.

```text
historical proof id: webgpu-runtime-visual-proof:sha256:e45b1d839607d694a744226228c0341dd6959eb336058bf733152a77f972e81d
historical result state: webgpu-hmr-full-runtime-proven
historical ledger proof id: gpu-ledger-proof:sha256:56994c1b29cef52e7b86ba4d3936031a3486123bb62da99ab1e554d779011a2e
historical proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-proof.json
historical summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-summary.txt
```

Visual artifacts inspected:

```text
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-before.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-after.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-diff.png
changed pixel ratio: 29.3893%
mean abs delta 8-bit: 37.6426
visible pixel count: 67713
```

Accepted scope:

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
total validator wall time: 951597400ns
trigger to visible time: 67788100ns
```

Normalized timing report:

```text
timing summary json: mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260609T051533Z.json
source: webgpu_runtime_visual
profile: webgpu-wgsl-runtime-triangle
status: pass
total wall: 951.5974ms
edit/trigger to first visual: 67.7881ms
visual diff: 35.6061ms
```

Do not generalize this to arbitrary WebGPU projects. The runner accepts only the implemented explicit-empty scope and the explicit-profiled uniform-buffer plus float32-vertex-buffer scope. Other bind group resource kinds, unsupported vertex formats, fixed color formats outside the preferred canvas format, non-opaque alpha mode, engine-owned caches, and untraced pipeline state still reject unless a future proof runner executes and traces those fields.

## Strict ROCm/HIP Compute Ledger

Accepted full-runtime compute/readback proof:

```text
workspace: gpu-real-rocm-repo-20260609005300
runtime proof id: gpu-runtime-proof:sha256:0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2
ledger proof id: gpu-ledger-proof:sha256:1cfa9927c27d63b9eadf4c96021f7d9270051519d822bfb55eb7b7f08b64b9eb
artifact: mcp/synthi-mcp/.gpu-hmr-test-logs/runtime-proof-artifacts/gpu-real-rocm-repo-20260609005300-real-rocm-runtime-proof-0eebb142e6f213a0794a4649b10ab172971a7f4552cc124ab37c5f95c7a1ebd2.json
result state: gpu-hmr-full-runtime-proven
full runtime proven: true
limitations: []
```

Supplemental proof card:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260609005300-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

Visual inspection confirmed the proof card is readable and shows matching expected/readback hashes. The patched summary builder also accepts this artifact with `gpu_hmr_success=true`, no limitations, accepted ledger, and accepted contract consistency.

Rejected later reruns:

```text
gpu-real-rocm-repo-20260609010632: rejected because worker runtime session was lost.
gpu-real-rocm-repo-20260609011410: rejected because no HMR proof was produced before first-phase timeout.
```

These are not proof. They demonstrate the harness refuses invalid runtime evidence.

## External Profile Proofs

ThreeJS WebGL shader lava passed as an external runtime screenshot proof:

```text
profile: threejs-webgl-shader-lava
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1780977150053-report.json
proof id: external-visual-proof:8a42ec53c94aa29844c2992782c2ca4156b9cd2c9c285b92d9b64901e4fde6cf
total wall: 9330.6259ms
edit to screenshot: 2836ms
visual diff: 95ms
changed pixels: 28.3806%
mean abs delta 8-bit: 12.9288
Chrome GPU: enabled
```

Artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1780977142363.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1780977147880.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1780977149507.png
```

Visual inspection confirmed a torus-to-sphere material/geometry change and a nonblank diff.

Bevy/WGSL was tested with real Rust GNU and w64devkit and remains rejected, not accepted.

Fresh rejection artifact:

```text
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
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780961693506-report.json
status: fail
reason: gpu_hmr_proof_insufficient
required state: gpu-hmr-full-runtime-proven
observed state: missing
```

This is a correct refusal, not a demo success.

## Verification Checklist

Passed:

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
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process
npm --prefix mcp/synthi-mcp run proof:runtime-profile:hiprt:camera-rays
npm --prefix mcp/synthi-mcp run proof:runtime-profile:hiprt
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
$env:SYNTHI_GPU_HMR_EXTERNAL_PROJECT_DEFAULT_PROFILE_ID='threejs-webgl-shader-lava'; npm --prefix mcp/synthi-mcp run proof:external-project
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=ray-light SLUG=ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
MCP_TRANSPORT=docker MCP_CONTAINER=vectant-ade-mcp-1 MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js MCP_SIGNALING_URL=ws://signaling-server:9000 WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_GPU_AGENT_CAPTURE_ARTIFACTS=1 SYNTHI_GPU_VENDOR=rocm SYNTHI_GPU_ARCH=gfx1201 SYNTHI_GPU_AGENT_FIXTURE=flow SLUG=flow-gpu-hmr-proof-20260622-embedded-ledger-10 SYNTHI_SYNC_TO_GCS=0 SYNTHI_VALIDATION_AUTHLESS_WORKSPACE=1 node mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
npm --prefix mcp/synthi-mcp run proof:oidn:preflight:self-check
SYNTHI_OIDN_WORKER_CONTAINER=vectant-ade-worker-1 SYNTHI_OIDN_REPO_PATH=/tmp/synthi-real-rocm/HIPRT-Path-Tracer SLUG=oidn-hiprt-rocm-preflight-20260609-rerun-after-visual-ledger npm --prefix mcp/synthi-mcp run proof:oidn:preflight
npm --prefix mcp/synthi-mcp run proof:opencl:preflight:self-check
SYNTHI_OPENCL_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=opencl-rocm-preflight-20260609-after-output-gate npm --prefix mcp/synthi-mcp run proof:opencl:preflight
npm --prefix mcp/synthi-mcp run proof:vulkan:preflight:self-check
SYNTHI_VULKAN_WORKER_CONTAINER=vectant-ade-worker-1 SLUG=vulkan-rocm-preflight-20260609 npm --prefix mcp/synthi-mcp run proof:vulkan:preflight
npm --prefix mcp/synthi-mcp run proof:webgpu:preflight:self-check
$env:SLUG='webgpu-preflight-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:preflight
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:self-check
$env:SLUG='webgpu-runtime-visual-20260609'; npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual
node mcp/synthi-mcp/scripts/gpu-hmr-external-project-profile.mjs --rejection-proof-from-report mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
```

Expected rejection:

```text
SYNTHI_GPU_HMR_EXTERNAL_MCP_TRANSPORT=docker SYNTHI_GPU_HMR_EXTERNAL_SIGNALING_URL=ws://signaling-server:9000 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER=vectant-ade-mcp-1 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js SYNTHI_GPU_HMR_EXTERNAL_MCP_REQUEST_TIMEOUT_MS=1200000 SYNTHI_GPU_HMR_EXTERNAL_MCP_ATTACH_TIMEOUT_MS=1200000 npm --prefix mcp/synthi-mcp run proof:external-project:bevy
```

## Commit Checkpoint

Relevant current commits:

```text
21224766f feat(gpu-hmr): harden matrix evidence modes
78070f28e feat(gpu-hmr): prove generated split fission
f2a02a83e feat(gpu-hmr): add vulkan preflight rejection proof
732d2bcfa fix(gpu-hmr): bind narrow fission to generated topology
35232abcd fix(gpu-hmr): reject generated split per-kernel overclaims
f47a45c25 feat(gpu-hmr): add opencl preflight rejection proof
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
```

These are generic hardening changes. They are not fixture-specific, and they do not add shims.

## Honest Remaining Work

- Full-runtime Bevy acceptance is not implemented.
- Focused Flow/ray-light per-target run-mode coverage is complete: cold split, hot delta 1, hot delta 2 with a different edit, and negative-edit refusal all pass. The global matrix now reports `per_target_run_modes=accepted` for enrolled generated run-mode targets plus scoped WebGPU. HIPRT CameraRays/MegaKernel rows are source-adapted visual-profile evidence only, so `hiprt_run_modes` and `hiprt_visual_path` remain missing for no-shim full-runtime acceptance. Scoped WebGPU now emits accepted cold/hot1/hot2 runtime run-mode artifacts with embedded strict runtime proof artifacts and binding-layout negative-edit refusals.
- MIOpen large ROCm ML infrastructure is attempted under the proof harness and native observer, but the latest worker run stops at missing SQLite3 CMake dependencies before build/run proof material exists. It still remains refused until an accepted full ledger chain, accepted runtime proof chain, generic app-hook contract/runtime observations, epoch/dispatch proof, target-progression ledger success, and output or visual oracle proof are produced. The latest profile has no output oracle and now requires final-acceptance target progression; the result fails those gates explicitly.
- CUDA needs a CUDA machine.
- OIDN HIP needs a ROCm-compatible OIDN HIP build; no ABI shortcut should be used.
- OpenCL needs a real vendor ICD plus dispatch/event/readback ledger proof; no synthesized ICD or shim should be used.
- Vulkan needs a real ICD plus pipeline-layout, command-buffer, frame-boundary, and visual oracle ledger proof; no synthesized ICD or shim should be used.
- WebGPU beyond the accepted explicit-empty WGSL profile and explicit-profiled uniform-buffer plus float32-vertex-buffer profile needs executed proof for additional bind group kinds, vertex formats, compute pipelines, engine caches, pipeline layouts, frame traces, and output-oracle ledger proof; browser flags must remain evidence-only.
- Per-kernel/smallest-safe fission is proven only for the ray-light generated `trace_light_rays` island; additional projects/backends need their own deterministic verifier evidence.
- In-app browser visual proof was unavailable because the browser connector bootstrap failed with sandbox metadata; persisted WebGPU, ray-light, and Flow before/after/diff PNGs were inspected with the local visual tool instead, and the matrix now decodes PNGs before accepting them.
