# GPU HMR Universal Acceptance Implementation Status

Status date: 2026-06-25

This document records the current implementation status against `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`.

## Executive Status

Accepted local proof is scoped ROCm/HIP-profile proof on the AMD Radeon RX 9070 XT (`gfx1201`). CUDA was not validated on this machine.

Current accepted proof spans multiple scoped profiles, but it is not universal production acceptance and is not broad library-agnostic GPU HMR:

- generated/profiled ROCm/HIP device-artifact full-runtime proof-ledger acceptance for scoped proof profiles,
- MCP preview visual HMR for generated ray-light and Flow workloads with cold split, hot delta 1, hot delta 2 with a different edit, and negative edit refusal,
- deterministic generated-split fission verification for ray-light `trace_light_rays`,
- HIPRT same-process CameraRays and MegaKernel direct-light-gain ray-traced visual proof artifacts are preserved only as source-adapted visual-profile evidence; because they disclose profile source adaptations, they are not accepted as no-shim full-runtime GPU HMR rows,
- external project rows now require typed external contract facets before they can count; the current ThreeJS WebGL shader-lava rerun is accepted only as a typed external visual-profile row, not as full-runtime GPU HMR,
- WebGPU Chrome/AMD runtime visual HMR proof for both an explicit-empty-layout WGSL shader/pipeline profile and an explicit-profiled pipeline profile with a real uniform bind group plus float32 vertex buffer runtime trace, each with cold/hot1/hot2-different-edit/negative run-mode coverage,
- WebGPU Chrome/AMD compute/readback full-runtime proof for an explicit profiled storage/uniform float32 WGSL compute pipeline, with raw mapped GPU bytes, schema/hash verification, data-derived PNG cards, hot delta 1, hot delta 2 with a different shader edit, negative ABI refusal, and accepted strict `runtimeProofArtifact` rows; this is scoped compute/readback acceptance, not broad WebGPU app or engine-cache acceptance,
- retained ROCm/HIP module-load/readback proof artifacts for declared HIP module profiles, compiling real `.hip` sources to HSACO, loading the changed code object through `hipModuleLoadData`, resolving with `hipModuleGetFunction`, dispatching with `hipModuleLaunchKernel`, reading raw GPU bytes back, and rendering data-derived proof cards for hot delta 1 and hot delta 2 with a different edit. After the strict runtime-proof-artifact gate, these HIP module rows are not counted as current full-runtime GPU HMR until they carry an accepted `runtimeProofArtifact`; this remains non-acceptance for arbitrary HIP applications, frameworks, or libraries without app-hook, epoch, dispatch, host-identity, and output-oracle evidence.

Current fail-closed evidence also includes:

- large real ROCm ML infrastructure validation against upstream MIOpen, which attempts the upstream CMake/build/driver path under the native observer and emits rejected runtime diagnostic artifacts only, not an accepted strict runtime proof artifact; the current selected refusal reached upstream CMake and progressed into the MIOpenDriver build on a rebuilt ROCm worker with generic `nlohmann_json`, `gfortran`, Boost, zstd, and native-observer image proof, then failed on upstream's declared missing `half/half.hpp` build dependency, while still reporting no full-runtime Synthi proof ledger success, same-process app-hook contract evidence, artifact transport, epoch publication, dispatch trace, host identity, output/visual oracle proof, or runner-observed content-addressed hot-delta-2/negative-edit source-delta phases,
- real ROCm matrix multiplication validation against upstream `ROCm/rocm-examples`, which derives and syncs a source-backed buffer checksum oracle, observes the native HIP launch boundary, and is retained as a current real ROCm row alongside MIOpen in the generated validation matrix, but is refused because Synthi artifact transport, epoch publication, dispatch trace, host identity, and runtime output-oracle observation are missing,
- large real ROCm ML infrastructure validation against upstream `ROCm/composable_kernel`, which clones a 7,234-file serious HIP/C++ template project, derives a generic HIP source-bridge candidate for the GEMM example, and is retained as a current fail-closed matrix row, but is refused because the upstream target did not build, no Synthi artifact transport/epoch/dispatch/host identity/output-oracle proof was observed, and the output-oracle/app-hook obligations are explicitly missing,
- large real ROCm ML infrastructure validation against upstream `ROCm/hipBLASLt`, which clones and transfers a serious fused GEMM/GELU/AUX/bias library/sample tree into the ROCm worker, derives a generic HIP source-bridge candidate, and is retained as a current fail-closed matrix row, but is refused because the retained upstream lifecycle artifact failed on missing `CMAKE_Fortran_COMPILER`/`gfortran` and no Synthi artifact transport, epoch, dispatch, host identity, app-hook, or output-oracle proof is observed,
- negative/rejection evidence for HIPRT blank-frame direct-light-zero, OIDN HIP, Bevy, OpenCL, and Vulkan where proof is missing, blank, or the runtime dependency is incompatible.

Current strict matrix behavior deliberately downgrades older HIPRT warm visual artifacts that lack an embedded proof ledger and data-derived oracle-region proof. HIPRT matrix ingestion now recomputes the oracle region from the persisted before/after PNG pixels; JSON claims about a nonblank region are not accepted by themselves. Source-adapted HIPRT CameraRays and MegaKernel direct-light-gain reruns are classified as `visual_profile_accepted`, not full-runtime GPU HMR, because their runtime probe instrumentation discloses profile source adaptations. The MegaKernel direct-light-zero profile is a proven blank-oracle-region refusal, not a success. OIDN live preflight ran against the real HIPRT checkout and remains rejected for HIP output proof because the installed OIDN HIP device library depends on `libamdhip64.so.5`, which is absent on this ROCm 7 worker. No symlink, ABI shim, fake ICD, or synthesized runtime was added.

The 2026-06-24/2026-06-25 continuation added these generic anti-overclaim gates:

- validation matrix row IDs are recomputed at query time and stale/mutated rows are removed from accepted coverage summaries,
- accepted rows must bind their matrix backend to the recomputed proof-ledger record backend,
- preflight backend evidence requires schema-correct typed backend/backend-family fields with field-level evidence refs, not raw strings plus generic refs; WebGPU preflight now emits the same typed backend contract shape as OpenCL/Vulkan/OIDN and remains preflight-only until shader-module epoch, pipeline recreation, and output-oracle proof exist,
- external project rows require a typed `synthi.gpu_hmr.external_project_contract.v2` facet with field-level evidence, manifest hash, runtime evidence refs, and explicit no-broad-claim flags.
- real ROCm acceptance now requires explicit observed runtime-capability preflight, typed output-oracle resolution, and explicit sidecar consistency/not-applicable facets; device-sidecar contracts are recomputed after runtime proof collection and can satisfy the sidecar gate only when artifact transport, epoch publication, dispatch trace, host identity, output oracle, and full-runtime proof are all observed,
- HIPRT and large real ROCm proof runners now detect GPU arch and ROCm prefix from the worker or explicit env, instead of defaulting to a local `gfx*` arch or `/opt/rocm` path,
- OIDN no-shim/no-symlink proof now comes from worker path inspection, ELF file-type checks, resolved paths, and sha256 hashes,
- visual profile coverage now requires typed profile evidence with exact row-bound proof IDs or evidence refs; target names, path substrings, and free-form Flow/ray-light evidence strings cannot satisfy the coverage gate,
- visual artifact evidence now resolves paths only inside allowed repo/log roots, records byte-level PNG hashes, verifies declared hashes, recomputes before/after pixel deltas from readable images, and rejects path escapes, forged hashes, blank after frames, blank diffs, and unrecomputed visual pairs,
- external visual-profile proof now recomputes deterministic visual controls from the declared mode or linked proof artifact. A serialized `deterministicVisualModeEvaluation.accepted=true` flag cannot satisfy the fixed-seed, frozen-camera, frame-boundary, swapchain-count, temporal, TAA, or denoiser gates by itself.
- validation matrix ledgers now include a proof-hashed `attemptHistory` section when `includeUnproven=true`, so the newest collected attempt for an attempt key remains machine-auditable even when canonical row selection keeps an older, more complete refusal as the selected row.
- Flow/ray-light visual profile coverage is no longer a hardcoded matrix table; coverage rows are derived only from accepted rows with typed `validationProfileEvidence` that is bound to the row proof IDs or evidence refs,
- runtime profile proof CLIs now fail closed unless a profile is explicitly selected by CLI/env or a packaged default is explicitly allowed for diagnostics,
- proof runner CLIs now fail closed by default when the runtime output proof is rejected; source-adapted HIPRT visual profiles and rejected OIDN preflights require explicit diagnostic allow flags and still cannot set `gpuHmrSuccess=true`.
- accepted full-runtime rows now expose `fullRuntimeEvidenceAuthority`; rows must carry a strict accepted runtime proof artifact. Backend-native recomputed ledger traces with loader, dispatch, output boundary, accepted oracle, and row-bound evidence refs are retained as supporting evidence only and cannot authorize GPU HMR success by themselves.
- WebGPU visual proof companion artifacts now carry row-bound `runModeCoverageSupport` derived from the recomputed proof ledger/runtime proof artifact. The support builder is generic over proof IDs, contract hashes, and artifact hashes; it is not tied to a WebGPU target name or one timestamp.
- legacy external rejection reports can now recover typed external contract fields only from a matching packaged profile manifest. Recovered profile selections are marked `explicit=false` and `recovered=true`; conflicting legacy report fields reject recovery instead of combining report data with a packaged manifest hash. The recovered Bevy row remains a refusal, not GPU HMR acceptance.
- source-derived real ROCm output-oracle instrumentation is now recorded as source adaptation and is a no-shim blocker; it can support diagnostic compute evidence, but it cannot satisfy no-shim GPU HMR acceptance.
- real ROCm HIPRT runtime probing is opt-in through explicit env/profile config; the runner no longer enables HIPRT probing or selects a special run command from repo or target names.
- real ROCm profile proof obligations are recomputed by the validation matrix from raw profile and target-progression evidence. Serialized obligation facets can add stricter gaps, but cannot erase raw-profile obligations for large ROCm ML or final-acceptance rows.
- real ROCm source-delta execution evidence is recomputed from runner-observed source write/compile phases, content-addressed before/after/edit hashes, and expected-refusal metadata. Declared fixture candidates cannot satisfy hot-delta-2 or negative-edit obligations by themselves.
- real ROCm same-process runtime-oracle acceptance now requires a generic app-hook/runtime contract plus observed artifact transport, epoch publication, dispatch using the published epoch, stable process identity, dispatch/output-oracle target continuity, post-dispatch observation, artifact/epoch hash continuity, and explicit CPU/full-rebuild/restart firewall proof. Smoke coverage includes one generic large-ROCm ML positive contract fixture and generic negative fixtures for missing/unresolved hooks, missing facet, wrong schema, missing artifact transport, missing epoch, missing dispatch, dispatch/epoch mismatch, missing output oracle, missing output target, mismatched output target, process mismatch/restart, oracle-before-dispatch, artifact mismatch, CPU-HMR/full-rebuild firewall violations, full-runtime-proof gaps, and missing strict runtime proof artifacts; none of these gates are keyed to a repository or library name.
- real ROCm target-progression ledger entries now rederive mandatory proof gates from the report fields before writing the retained ledger artifact. A serialized or stale `pass` row cannot override missing final-acceptance full-runtime, output-oracle, prior-phase, or visual/compute proof.
- real ROCm worker repository transfer failures now emit a generic structured `synthi.real_rocm.worker_repo_transfer_failure.v1` facet and the validation matrix treats accepted transfer facets as fail-closed refusal evidence. The smoke fixture is project-agnostic and verifies `gpuHmrSuccess=false`, `acceptedForGpuHmr=false`, `proofChain=real_rocm_strict_runtime_refusal`, and attempt-completeness score 70.

The latest generated machine-readable validation matrix ledger reports 48 rows after strict WebGPU compute/readback runtime-proof authority, the refreshed large ROCm MIOpen refusal, the large ROCm source-delta execution gate, the generic same-process real-ROCm runtime-oracle/app-hook gate, structural negative-edit refusal gating, proof-hashed latest-attempt history, external visual deterministic-mode recomputation, and non-final ROCm target-progression evidence retention as non-success rows were selected: 16 accepted full-runtime GPU HMR rows, 0 broad library-agnostic full-runtime GPU HMR rows, 16 scoped full-runtime GPU HMR rows, 1 deterministic generated-split fission verifier row, 5 visual-profile rows, 22 structurally proven refusal rows, 3 cold split rows, 1 WebGPU typed runtime preflight-only row, and 0 unproven rows in the default included set. The matrix hash is:

```text
gpu-validation-matrix-ledger:sha256:eda23f85a6a301dfb69f87f303ffc672517c466b76a9cce25517603c63b998fd
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T232850Z.json
latest rerun context: validation matrix rerun after strict runtime-proof-artifact authority was made mandatory for every accepted GPU HMR row, source-derived real ROCm oracle instrumentation was marked as no-shim source adaptation, HIPRT real-ROCm probing became explicit env/profile config, real-ROCm proof obligations became matrix-recomputed from raw profile/target-progression evidence, target-progression ledger entries rederived mandatory proof gates, required visual proof began requiring before/after pixel recomputation instead of a lone decoded screenshot, external visual proof artifacts began recomputing deterministic visual-mode gates from declared controls, WebGPU compute/readback proofs began emitting accepted strict runtime proof artifacts backed by raw mapped GPU bytes, the latest selected MIOpen `half/half.hpp` build-phase failure was retained as a structured refusal row, worker-repo transfer failures became structured refusal facets, real-ROCm same-process runtime-oracle gates began requiring a generic app-hook contract plus artifact transport, epoch publication, dispatch, process identity, dispatch/output-oracle target continuity, post-dispatch timing, artifact/epoch hash continuity, and CPU/full-rebuild/restart firewall evidence, negative-edit refusal rows began requiring structural typed evidence and explicit firewall/run-mode proof, default matrices began proof-hashing disabled/latest-attempt history metadata while history audits expose newest attempts, CUDA coverage became not-applicable for this ROCm/AMD-only matrix, large ROCm ML retained rows now require runner-observed content-addressed hot-delta-2/negative-edit source-delta execution instead of fixture declarations alone, and non-final target-progression rows can be retained only as non-success evidence.
summary: 48 rows, 16 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 16 scoped full-runtime GPU HMR, 16 all full-runtime rows, 22 refusals under the stricter structural gate, 3 cold splits, 1 deterministic fission, 5 visual profiles, 1 preflight-only row, 0 included unproven rows
broad readiness: accepted=false, authority=matrix_computed_not_row_declared, broadRuntimeRows=0, scopedRuntimeRows=16, distinctBackendCount=2, open gaps=matrix_level_broad_generalization_proof_not_present,broad_runtime_rows_not_computed_from_matrix,broad_acceptance_requires_more_backend_families,broad_acceptance_requires_more_acceptance_scopes
scope breakdown: generated_rocm_hip_preview_visual: 6, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
self-check: npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check -> passed
history audit: npm --prefix mcp/synthi-mcp run proof:validation-matrix:history -> passed, gpu-validation-matrix-ledger:sha256:0d278a8d64ad61f6f4adf734614dadad651c082bfbd2465f9226c56498654217, 663 rows with 615 historical unproven rows included
history audit json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260625T232756Z.json
history scope breakdown: generated_rocm_hip_preview_visual: 6, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
timing summary: npm --prefix mcp/synthi-mcp run proof:timing-metrics -> passed, count=21, json=mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260624T093916Z.json; timing metrics are telemetry only, evidenceAuthority=timing_telemetry_only, proofVerdict=not_evaluated_by_timing_summary
```

Negative-edit refusal rows now require structural typed evidence, a content-addressed edit hash, accepted negative/different-edit run-mode evidence, explicit CPU/full-rebuild/restart firewall proof, and a typed blocker such as an executable static check, source occurrence proof, reject classification with blocking gaps, or a negative-edit proof object. Reasons-only and false-only rows are non-success/unproven and are omitted from the default included matrix.

CUDA coverage is `not_applicable` in this local matrix because the observed hardware evidence is ROCm/AMD (`hip`, `hiprt`, `oidn_hip`) and no CUDA rows exist. This is not CUDA proof and does not remove the need for a CUDA-machine validation run.

The global per-target run-mode coverage row is now accepted for four enrolled targets: generated Flow, generated ray-light, WebGPU explicit-empty WGSL, and WebGPU explicit-profiled WGSL. Each carries row-bound cold split, hot delta 1, hot delta 2 with a different edit, and negative-edit refusal evidence. SAXPY is not a current accepted full-runtime row in the latest default matrix; historical SAXPY rows remain unproven/not-full-runtime in the history audit.

Scoped WebGPU compute/readback artifacts for `webgpu-wgsl-runtime-compute-storage` and `webgpu-wgsl-runtime-compute-storage-hot2` now count as full-runtime GPU HMR rows because each proof carries an accepted strict `runtimeProofArtifact` plus recomputed ledger, native WebGPU compute API trace, raw mapped readback bytes, schema/hash verification, and expected float32 output verification. They remain scoped to the explicit storage/uniform float32 readback profile; they are not a blanket WebGPU compute, engine-cache, or arbitrary shader-app claim.

Scoped HIP module runtime/readback artifacts remain retained evidence for `hip-module-runtime-readback` hot delta 1 and hot delta 2, but the current global matrix no longer counts them as full-runtime GPU HMR rows because accepted GPU HMR now requires an accepted `runtimeProofArtifact`. These artifacts are still useful declared-module evidence with explicit ABI, launch shape, stream, buffers, expected readback output, real HSACO, same-process native HIP module load, epoch publish, epoch-2 dispatch, raw D2H readback after dispatch, exact expected-output verification, data-derived proof cards, executable ABI-negative refusal, and unsupported-scope rejection. They are not a broad HIP app/library claim and not a blanket HIP application claim. The runner implementation was subsequently hardened so the C++ probe packs launch arguments from declared `abi.params`, typed buffers, typed scalars, and extracted before/after kernel signatures instead of the old fixed float32 `{output,input,scale,bias,n}` shape. A new `explicit-hip-module-declared-readback` uint32/reordered-ABI profile is covered by `proof:hip-module:runtime:self-check`; live proof rerun on this host is currently blocked because `hipcc` is not on PATH, so this hardening is not counted as a new accepted runtime row yet.

The backend-specific `hiprt_run_modes` and `hiprt_visual_path` coverage rows are now `missing` for no-shim/full-runtime acceptance. HIPRT CameraRays and MegaKernel direct-light-gain still provide useful ray-traced visual proof artifacts, but the matrix classifies them as `visual_profile_accepted` because the runtime probe instrumentation discloses source-adapted profile hooks. They are evidence, not accepted GPU HMR rows, and they do not prove broad HIPRT acceptance.

Historical focused Flow/ray-light matrix:

```text
proof id: gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-focused-flow-ray-light-20260622T181300Z.json
rows: 9
outcomes: 4 full_runtime_gpu_hmr, 2 cold_split_proven, 2 refusal_proven, 1 deterministic_fission_proven
open gates: none
coverage accepted: scoped ROCm/HIP full-runtime profile rows, Flow visual GPU path, ray-light visual GPU path, per-target run modes, and ray-light `trace_light_rays` per-kernel/smallest-safe fission. Flow remains device-translation-unit HMR only for fission because its selected device role owns two kernels.
```

Latest live preview URLs checked HTTP 200 on 2026-06-25:

```text
Ray-light: http://localhost:3000/workspace/gpu-agent-ray-light-20260625T104554-rocm-fission-evidence -> HTTP 200
Flow:      http://localhost:3000/workspace/gpu-agent-flow-20260625T103454-rocm-profile-bind -> HTTP 200
Preview frontend: http://127.0.0.1:3000 -> HTTP 200
Worker/MCP/AI containers: vectant-ade-worker-1, vectant-ade-mcp-1, and vectant-ade-ai-engine-1 were up during the current proof refresh.
Workspace POST proof after `fix(preview): honor workspace auth bypass in API route`: `preview-auth-bypass-check-20260624T113807` created through `POST /api/workspace` with `NEXT_PUBLIC_SYNTHI_WORKSPACE_AUTH_BYPASS=1`, then `/workspace/preview-auth-bypass-check-20260624T113807` returned HTTP 200.
Container rebuild proof: `docker compose up -d --build --force-recreate frontend` with the auth-bypass env completed a Next.js production build on 2026-06-24.
```

Current live Flow/ray rerun status on 2026-06-25:

```text
Flow rerun slug: gpu-agent-flow-20260625T103454-rocm-profile-bind
Ray-light rerun slug: gpu-agent-ray-light-20260625T104554-rocm-fission-evidence
Both reruns created preview workspaces, attached MCP, persisted 16 generated split files, executed cold split, hot delta 1, hot delta 2 with a different edit, and negative edit refusal, and emitted row-bound run-mode artifacts.
Flow remains device-translation-unit HMR for fission because the selected generated device role owns two kernels.
Ray-light proves per-kernel/smallest-safe fission for `trace_light_rays` through a deterministic verifier with 9 typed verifier evidence refs.
```

Latest ray-light visual proof:

```text
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-ray-light-20260625T104554-rocm-fission-evidence
hot delta 1 run-mode proof: agent-split-run-mode-proof:sha256:43a20d68f57ca39b7958c49af13e6da65fd3e6ded7db652ca336b7ee4bab4dd7
hot delta 1 ledger: gpu-ledger-proof:sha256:49782fb760dc55c2b4dd7dfada27cc9ce0ba32e7a2e22ac1320d4f0c9fafc7fc
hot delta 1 runtime proof: gpu-runtime-proof:sha256:39a38d8d170b3986c4892886ca73ccd86041b1936c8318ae8c21803c676bbb17
hot delta 2 run-mode proof: agent-split-run-mode-proof:sha256:a6e084bb0821ca942fb0e9a4b810fa28bf17093d8340600c9f0e2b02de890784
hot delta 2 ledger: gpu-ledger-proof:sha256:6e7ea71df94ffcf52d0c94c6c6d1ed99736be366a667a42f7075b169aada512d
hot delta 2 runtime proof: gpu-runtime-proof:sha256:3e6b2cec1bec9aa9916945df86be874d78e7d99943a33775a5329030acabe845
visuals: before-after-diff.png, hot-delta-2-diff.png
hot delta 1 timings: device_compile_wall_time=21703700ns, runtime_probe_time=3029395400ns, total_validator_wall_time=3051317200ns
hot delta 2 timings: device_compile_wall_time=24864000ns, runtime_probe_time=2433919900ns, total_validator_wall_time=2458875700ns
visual metrics: hot1 changed_pixel_ratio=0.058883333333333336, perceptual_diff=9.913276388889209, control_changed=0; hot2 changed_pixel_ratio=0.0498, mean_abs=7.63, control_changed=0
fission: accepted per_kernel_hmr for trace_light_rays with selected verifier evidence `evidence:fission-verifier-report:generated-split:sha256:9fa36bdb432f9743664f07d86203de5b5f3b44501491f05b43c27b8a79ba9f9e` and 9 typed deterministic verifier refs
visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-25; the diffs were visibly nonblank and showed changed ray-light geometry.
```

Latest Flow visual proof:

```text
artifact dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-flow-20260625T103454-rocm-profile-bind
hot delta 1 run-mode proof: agent-split-run-mode-proof:sha256:0e194a090dfe31fbf9440d458a21986824ee07091a4f60ab9b25893f4f3b8897
hot delta 1 ledger: gpu-ledger-proof:sha256:eec1b98b76252cb06bae7539f29ed4610afc6ed512ebf90b1f2c0ce4112fe80c
hot delta 1 runtime proof: gpu-runtime-proof:sha256:7710f0df814f55ef2a5e48d82a3ce18fbd73c14a2bc69aeb56122e67fbd0f79c
hot delta 2 run-mode proof: agent-split-run-mode-proof:sha256:42cf6c7c9b66f3991752f4a3042741054703783fd43650da80db51c5c7d9be9c
hot delta 2 ledger: gpu-ledger-proof:sha256:803b1af2b49f981730d3c348c5cab6669ce4d87649a8b0a2d9c0d323ca9919c9
hot delta 2 runtime proof: gpu-runtime-proof:sha256:f280297fff5a556677fff8ee8658a45b2db68712bf6dada11b487d427a480b13
visuals: before-after-diff.png, hot-delta-2-diff.png
hot delta 1 timings: device_compile_wall_time=31912000ns, runtime_probe_time=2879415700ns, total_validator_wall_time=2911725700ns
hot delta 2 timings: device_compile_wall_time=14818100ns, runtime_probe_time=2260728700ns, total_validator_wall_time=2275612200ns
visual metrics: hot1 changed_pixel_ratio=0.025283333333333335, perceptual_diff=3.3798236111114823, control_changed=0; hot2 changed_pixel_ratio=0.0252, mean_abs=3.41, control_changed=0
fission: device_translation_unit_hmr only; per-kernel/smallest-safe fission remains refused
visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-25; the diffs were visibly nonblank and showed changed Flow particle-ring patterns.
```

Latest WebGPU explicit-empty run-mode visual proof:

```text
hot delta 1 proof id: webgpu-runtime-visual-proof:sha256:87272df5a648f3e8100b9fee3e5de06238bf517b4998bbec9b01845b790a4aab
hot delta 1 runtime proof artifact: gpu-runtime-proof:sha256:a59e894be860669380b0723a67177e3ff5b94a8824c51f0d68908a7792298a9b
hot delta 1 ledger: gpu-ledger-proof:sha256:8eb15f7a22156c14df0d947ed0c4ac4a1b14b52b45d3c2884e216a975b57e28b
hot delta 1 run-mode proof: runtime-run-mode-proof:sha256:176195d21868cc476531698aca6aa004a2eaa6f0177b5de03bf03f7669565196
hot delta 1 cold runtime proof: runtime-run-mode-proof:sha256:682324fcd59276545d18f56e3ae6785ea99e3070de0ab98fb52cd09d562c759a
hot delta 1 negative refusal: agent-split-negative-edit-refusal:sha256:db53d10719363bc9dacfb0518a2170745ba537ad3e6b7c79eb332a8854f72cfc
hot delta 1 total validator wall time: 1247829300ns
hot delta 1 trigger_to_visible_time: 70794700ns
hot delta 1 changed_pixel_ratio: 0.29389322916666666
hot delta 2 proof id: webgpu-runtime-visual-proof:sha256:893dba543fddb66ac2369a10ce89f8bc07518aa0ddb949cccb891b859c7ec3f0
hot delta 2 runtime proof artifact: gpu-runtime-proof:sha256:983e347e834c914d32c7b1478fe00d7515238274fe32a6a902f2c38e1b55f625
hot delta 2 ledger: gpu-ledger-proof:sha256:441ee9299dc073bfb86700af70342e42b06dce5fe970ff198a20667422c3ee90
hot delta 2 run-mode proof: runtime-run-mode-proof:sha256:b0e6dafa96d31ed5b196c6dfa37d76968e0f7b23fa800bcd2b1f9282f34c7fd1
hot delta 2 cold runtime proof: runtime-run-mode-proof:sha256:a60b981a40599d14d2bad985c94d3b433472232f2ab14b400d414049e251c758
hot delta 2 negative refusal: agent-split-negative-edit-refusal:sha256:7c69db3629fc77cd0a2de79b375b646834d66f5407177ee8a0ca10a00d6e0272
hot delta 2 total validator wall time: 613256000ns
hot delta 2 trigger_to_visible_time: 57775800ns
hot delta 2 changed_pixel_ratio: 0.32245225694444446
negative edit refusal reasons: bind_group_layouts_not_supported_by_runner, webgpu_pipeline_layout_or_binding_abi_changed, gpu_hmr_rejected_before_load
visuals inspected locally with the image tool: hot1 diff `webgpu-runtime-visual-20260625070636-webgpu-wgsl-runtime-triangle-diff.png` and hot2 diff `webgpu-runtime-visual-20260625070706-webgpu-wgsl-runtime-triangle-hot2-diff.png`
visual result: hot1 after yellow inverted triangle with nonblank diff; hot2 after green rotated triangle with nonblank diff
```

Latest WebGPU explicit-profiled bind-group/vertex-buffer visual proof:

```text
profile: webgpu-wgsl-runtime-profiled-layout
pipeline scope: explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list
resource state hash: sha256:febd60767177cf5ba103734735eba5e2f083a4b5131c5fab915567e9a843b2f3
runtime binding trace: bind_group_count=1, bind_group_binding=0, uniform_bytes=32, vertex_buffer_count=1, vertex_bytes=48
native WebGPU API gates: createBuffer, createBindGroupLayout, createBindGroup, createShaderModule, createRenderPipeline all accepted
hot delta 1 proof id: webgpu-runtime-visual-proof:sha256:4a437069aff6eb30cf898de6633c16e428f0d72688a8f67eb0152117d993c333
hot delta 1 runtime proof artifact: gpu-runtime-proof:sha256:327c5814b847eebb41aef8af3d202ba31835f95354515c455da82613ccfb8ca3
hot delta 1 ledger: gpu-ledger-proof:sha256:5b86d4fc2c7b403b3cb561e3f1b778da835462b2d50763e16539bcadeb95c1ee
hot delta 1 run-mode proof: runtime-run-mode-proof:sha256:614b7689891e2ebbdc87188ac9ff5e7515bfdd3e3bd38e5e9947d4eb119063e0
hot delta 1 cold runtime proof: runtime-run-mode-proof:sha256:140755d546ba7a5cc0dcf0a5a76ce9402b69f022dd1d46bf6ddfc9d391b21043
hot delta 1 negative refusal: agent-split-negative-edit-refusal:sha256:43c0eef8fed58418d27f44736a706064926dc4991d9ce5518e3a2da63136eac2
hot delta 1 total validator wall time: 1145767400ns
hot delta 1 trigger_to_visible_time: 70909600ns
hot delta 1 changed_pixel_ratio: 0.23291666666666666
hot delta 2 proof id: webgpu-runtime-visual-proof:sha256:de18b154e927f7f6afe0a6a5f8766539b87032dcdc2347a9821db5f2e95b28de
hot delta 2 runtime proof artifact: gpu-runtime-proof:sha256:7c1e65e0bf337b2c26ad8021f1c2da57c67fb66f9522dcda5b75ec40d284e982
hot delta 2 ledger: gpu-ledger-proof:sha256:62fd846d75844bab4c4b943613fd71b7412c3887b8f695678ce6f674e97725e1
hot delta 2 run-mode proof: runtime-run-mode-proof:sha256:e60a28a51e069e0856cf52972b8c693889a1ba19ae9da52d22c7a0c79e935f78
hot delta 2 cold runtime proof: runtime-run-mode-proof:sha256:15a3a586271ad18613deafebbfbb9b672185b44719f3d70820ba4f78cd992d06
hot delta 2 negative refusal: agent-split-negative-edit-refusal:sha256:77245a6d0819b9f5bf9394b23c49ce0969a5bcb8b566c2e5c5e1b88b7db909d8
hot delta 2 total validator wall time: 636983100ns
hot delta 2 trigger_to_visible_time: 58872800ns
hot delta 2 changed_pixel_ratio: 0.24441840277777777
negative edit refusal reasons: storage uniform binding or vertex attribute format changes reject before GPU HMR acceptance
visuals inspected locally with the image tool: profiled hot1 diff `webgpu-runtime-visual-20260625070636-webgpu-wgsl-runtime-profiled-layout-diff.png` and profiled hot2 diff `webgpu-runtime-visual-20260625070654-webgpu-wgsl-runtime-profiled-layout-hot2-diff.png`
visual result: hot1 and hot2 rendered nonblank profile-driven triangles with visible diffs derived from the post-epoch frame
```

Current 2026-06-25 large ROCm ML refresh:

```text
worker image prerequisites committed generically: ninja-build, Python dev/setuptools/venv, SQLite dev, BZip2 dev, msgpack C/C++ dev, nlohmann JSON, gfortran, Boost filesystem/program-options/system development packages, zstd development headers, and the real native launch observer library in `Dockerfile.gpu`
rebuilt image proof: `vectant-ade-worker-gpu:local` image sha256:4c189723e6168384d7e500600bcb13ea8e16de908e1d9e7b5a30fcbbadfab817; the running `vectant-ade-worker-1` container verified `nlohmann-json3-dev`, `gfortran`, `libboost-filesystem-dev`, `libboost-program-options-dev`, `libboost-system-dev`, `libzstd-dev`, `/usr/local/lib/synthi-gpu-native-launch-observer.so`, ROCm `gfx1201`, and `hipcc`
MIOpen selected matrix row: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625192949.json
MIOpen matrix row id: gpu-validation-matrix-row:sha256:38085cebb1819143b4aaf3815aebfc2adc2ef62d0351876ba7d75327563160ec
MIOpen proof ids: gpu-ledger-proof:sha256:1742703d338c5e1bccb84f712ddd163375593f7a10c3d2375296568cb890c261, gpu-runtime-proof:sha256:17a668d790c295372bbbe9d7a61d519e43b79b4ec1a2959001a8b36a1ed0dcd8, real-rocm-validation:sha256:eb62a311e53375838f0644582e99ee41172e96a26f61f637ec9622eea41770ab
MIOpen target-progression ledger: target-progression-ledger:sha256:75a7605d58d669f11f6e6b16bb273abfae5d21cb1cdba4410166342ca0255c9e, mcp/synthi-mcp/.gpu-hmr-test-logs/target-progression-ledgers/gpu-real-rocm-MIOpen-20260625192949-final-acceptance-75a7605d58d669f11f6e6b16bb273abfae5d21cb1cdba4410166342ca0255c9e.json
MIOpen upstream blocker after the rebuilt nlohmann/gfortran/Boost/zstd/native-observer worker image: CMake configure succeeded, the upstream `MIOpenDriver` build progressed into CXX compilation, then failed on missing dependency `half/half.hpp`; run was not started
hipBLASLt selected matrix row: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260625100335.json
hipBLASLt matrix row id: gpu-validation-matrix-row:sha256:b67cf29942abc76598bcd0593adc4991d58958c0f084417a29536497b9f3c5a5
hipBLASLt proof ids: gpu-ledger-proof:sha256:a37b91f0d0d8e8dcfbc78629af6716a4845f2b9c9e1d61a00091932d3cd64096, gpu-runtime-proof:sha256:b3326cc9d15bed42679e3ba3042468932411f5d02c8e4631a137ca2069b55295, real-rocm-validation:sha256:81546b217129189662eddc540016294ef00d04e46d54fb3da372c3a616ac74ee
hipBLASLt upstream blocker in retained lifecycle artifact: `CMAKE_Fortran_COMPILER` value `gfortran` was not found; the generic CMake compiler-missing classifier now covers this diagnostic for future reruns
hipBLASLt fresh rerun attempt after `f749b4438 fix(gpu-hmr): classify real rocm transfer failures`: Docker did not answer `docker ps` within 180s, so no new hipBLASLt runtime evidence was produced. The retained selected row remains the upstream lifecycle refusal above; the Docker-blocked attempt is not counted as GPU HMR success.
large ROCm matrix behavior: all real ROCm ML rows remain refusal_proven, not GPU HMR success; they still lack Synthi artifact transport, same-process epoch publication, dispatch trace, host identity, app-hook contract proof, output-oracle observation, and runner-observed content-addressed hot-delta-2/negative-edit source-delta execution phases

Fresh large-ML rerun sequence:

- `gpu-real-rocm-MIOpen-20260625161446.json`: Docker daemon was available but the worker container was restarting; the generic runtime-evidence collector stayed total and emitted rejected runtime proof `gpu-runtime-proof:sha256:da5f31d58fb579894d5029ea59ea649bc15cd2fea638bffec14971011b329eb3`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625161658.json`: stable worker reached upstream CMake on ROCm `gfx1201` and refused on `missing_dependencies=nlohmann_json`; rejected runtime proof `gpu-runtime-proof:sha256:0a56bcdc5d0775b1a1d5b605097506eaf8dabf62145c380a0fbed87eb05ce085`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625162645.json`: after rebuilding/recreating the worker image and verifying the generic nlohmann/gfortran/native-observer packages, MIOpen reached upstream CMake and refused on `missing_dependencies=boost_filesystem`; rejected runtime proof `gpu-runtime-proof:sha256:4f0d1c08b0c86da2e039887ab7d788a3009b7f1957c16c784021261cf9adc743`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625190432.json`: after adding Boost prerequisites, MIOpen progressed further and refused on `missing_dependencies=zstd`; rejected runtime proof `gpu-runtime-proof:sha256:354eeb421de7800b1ac8fc4a5737bcafb92f9e85ffb07356d60ac1d239bbdcb8`, `gpuHmrSuccess=false`.
- `gpu-real-rocm-MIOpen-20260625192949.json`: after adding and verifying zstd prerequisites, MIOpen configured successfully, reached the upstream `MIOpenDriver` build, and refused on `missing_dependencies=half/half.hpp`; rejected runtime proof `gpu-runtime-proof:sha256:17a668d790c295372bbbe9d7a61d519e43b79b4ec1a2959001a8b36a1ed0dcd8`, `gpuHmrSuccess=false`.
- Boost filesystem/program-options/system and zstd development packages are committed as real image prerequisites, not installed into the running container and not used as one-off shims. They were verified in the rebuilt worker image, and the current blocker moved to upstream's external `half/half.hpp` dependency. This remains prerequisite progress only, not GPU HMR acceptance.

Post-refresh large ROCm ML gate hardening: `large_rocm_ml_infrastructure` final-acceptance profiles must now declare `proofObligations.requiresRunModes=true` and `proofObligations.requiresNegativeEdit=true` and configured hot-delta-2/negative-edit source-delta fixture candidates in addition to full-runtime, output-oracle, and app-hook obligations. This is keyed by profile schema fields and `targetClass`, not repo names. Fixture declarations are configuration-only (`profile_configuration_only_not_runtime_proof`) until a rerun records the extra phases, and even declared phases cannot satisfy the gate unless the runner records source/write/compile-attempt evidence plus content-addressed before/after/edit hashes. Current retained MIOpen, Composable Kernel, and hipBLASLt rows have not executed those phases, so the matrix adds missing hot-delta-2/negative-edit fixture gaps plus `source_delta_execution_missing` and still refuses. This improves fail-closed auditability only; it does not convert retained large ROCm ML rows into accepted GPU HMR.

Latest bounded Docker preflight refusals: `npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen`, `proof:real-rocm:large-ml-composable-kernel`, and `proof:real-rocm:large-ml-hipblaslt` on 2026-06-25 wrote `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625211218.json`, `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260625212751.json`, and `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260625213127.json`, then refused before container resolution with `docker_daemon_unavailable_or_timeout`, `available=false`, `timeout_ms=8000`, `gpu_hmr_success=false`, and `full_runtime_proven=false`. A newer MIOpen rerun, `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625231738.json`, also failed closed at the bounded Docker preflight and retained target-progression ledger `target-progression-ledger:sha256:146d2c6cc05d67f322aea0b1c898224660dd6603cba2d88b0825923dd52b0405`. The retained target-progression artifacts for those runs record `entryStatus=fail`, `failureCount=5`, and failed gates for missing prior small-oracle, prior partial-reload, prior original-host-path, full runtime, and compute oracle artifacts. These artifacts prove infrastructure failure is explicit and non-success; they are not large ROCm ML GPU HMR acceptance, and the matrix can still prefer older upstream-lifecycle refusal rows when they have stronger attempt-completeness evidence.
partial-run guard: matrix selection now scores real ROCm attempt completeness before freshness, so a newer strict-runtime refusal without upstream lifecycle evidence cannot replace a retained upstream-lifecycle refusal for the same target
```

Historical MIOpen large ROCm ML infrastructure validation (superseded by the current refresh above):

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-miopen-activation-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen
repo: https://github.com/ROCm/MIOpen.git @ 06977176afd94476c18d5290f21cb40745bb73a9
result slug: gpu-real-rocm-MIOpen-20260625082545
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625082545.json
latest alias at run time: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/miopen-large-ml-20260625T-retained-ledger.stdout.log
target: MIOpenDriver activ -n 1 -c 1 -H 8 -W 8 -F 1 -V 1 -t 1
entry file: src/kernels/MIOpenNeuron.cl
delta file: src/kernels/activation_functions.h
repo files: 7869 git files
worker status: `vectant-ade-worker-1` was running and reported ROCm/gfx1201 capability during this proof refresh
runtime device preflight: observed but not accepted for original-host-path proof; HIP array allocation matrix failed and `hipMallocArray` returned invalid argument
runtime capability preflight matrix facet: rejected, so the row remains refused
upstream configure/build/run: CMake configure failed, build was blocked by configure failure, and run was not started
upstream lifecycle refusal facet: accepted_as_refusal_evidence=true, reasons=cmake_configure_failed,missing_build_dependency,upstream_build_blocked_by_configure,upstream_run_not_started_after_configure_failure,upstream_lifecycle_command_failed, missing_dependencies=SQLite3,SQLite3_INCLUDE_DIR,SQLite3_LIBRARY
native runtime evidence: native launch observer was requested, but no readiness, launch, function-resolution, argument-provenance, runtime-session, artifact-transport, epoch, dispatch, output-oracle, host-identity, or original-host-path lines were captured before configure failure
split projection: no fresh AI split/delta calls in this rerun
delta projection: none accepted; configure failure occurred before compile/delta proof material was collected
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
device sidecar contract facet: no sidecar contract accepted; static candidate metadata is evidence-only and cannot satisfy runtime proof
hot path timings: total_validator_wall_time=24020.0527ms, metric_clock=monotonic_ns, evidenceAuthority=timing_telemetry_only
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:d1f6d1a507eb4fade9bc3467028d678d22088a6808014c910487ff4c1aa332ef, proof_artifacts=[]
refusal reason: upstream configure/build/run did not produce usable metadata and the Synthi runtime proof chain is missing; strict runtime artifact gate failed with runtime_full_proof_not_proven, runtime_proof_artifact_gpu_hmr_success_false, runtime_proof_artifact_stage_failed, runtime_proof_artifact_limitations_present, proof ledger rejection, and acceptance contract rejection
oracle resolution: requested_profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, worker oracle profile cleared, syncSkippedReason=runtime_profile_absent
target progression: final-acceptance, required=true, target=MIOpenDriver, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, raw compute oracle artifacts
worker evidence: no synthi_gpu_launch dispatch lines, no artifact_transport lines, no dispatcher_epoch lines, no output_oracle lines, no host_identity lines, and no original_host_path attachment lines
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
real ROCm app-hook contract facet: declared=false, can_satisfy_runtime_proof=false, stages missing artifact_transport, epoch_publication, dispatch_trace, host_identity, and output_oracle
real ROCm runtime eligibility facet: status=refused_missing_runtime_proof, backend_candidates=hip, gaps=artifact_transport_not_observed,same_process_epoch_missing,dispatch_epoch_missing,output_oracle_profile_absent,host_identity_not_observed
visual result: no MIOpen frame captured; matrix marks visual.required=false for this compute-only target and still refuses because strict runtime ledger and raw output-oracle proof are missing
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
refusal proof ids: gpu-ledger-proof:sha256:00a7d7fad085eaeceb8b4c3f2f21770bd1dafe293f51da8a2bf47fcf91c4ccab, gpu-runtime-proof:sha256:d1f6d1a507eb4fade9bc3467028d678d22088a6808014c910487ff4c1aa332ef, real-rocm-validation:sha256:bc99a66ae4b08cebba28b990f79d906cb1474d127176345b1dfcc41e23b1b447
historical matrix row id: gpu-validation-matrix-row:sha256:ac0e20c7d37454df2f272747c99e76ab058a7557e25a6dd9da53f242646f7468 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T082827Z.json; retained per-run result artifacts keep this MIOpen row queryable as historical refusal evidence
historical matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, app-hook contract/runtime observations missing, target-progression gates failed, runtime capability preflight missing, runtime chain missing, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
plan coverage: large_real_rocm_repo=refused
```

Current retained real ROCm matrix multiplication compute-oracle validation:

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-matrix-multiplication.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:matrix-multiplication
repo: https://github.com/ROCm/rocm-examples.git @ c121d6d2e6a21ce1d0a140e97b890ada635f7574
result slug: gpu-real-rocm-rocm-examples-20260625082616
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-rocm-examples-20260625082616.json
latest alias path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/rocm-matrix-multiplication-20260625T-retained-ledger.stdout.log
target: hip_matrix_multiplication
entry file: HIP-Basic/matrix_multiplication/main.hip
upstream build/run: configure_ms=2109, build_ms=2356, run_ms=273, run_exit_code=0
output oracle resolution: requested_profile=hip.matrix-multiplication.readback-c.v1, source_derived_candidates=1, selected_source=source_derived_profile, runtime_profile_present=true, runtime_profile_synced=true
output oracle contract: oracle=oracle:real-rocm:matrix-readback-c:b8f18aad760bfaf7, kind=buffer_checksum, output=HIP-Basic/matrix_multiplication/main.hip:C, baseline=sha256:aaedc7073c76880db6c8be81a91229d0073f1069e70791a7d028f575910c352c, expected=sha256:e7352404a601e877e39b4ae06181ce1597e93ccbbb2c9d654eb9df479bb9a858
candidate artifact entry point: matrix_multiplication_kernel
native runtime evidence: hipLaunchKernel observed through native launch observer; function_resolution_count=0
target progression: phase=small-oracle, required=true, final_acceptance_target=MIOpenDriver, gates=phase pass, non-final target pass, output oracle fail because runtime_dispatch_not_observed
compile bridge facet: status=compile_bridge_missing, phase_count=2, compile_response_status=compile_bridge_not_declared_by_compile_response, top_level_keys=ok/session_id/language/filename/dispatched_at/note, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
hot path timings: device_compile_wall_time=30012ms, runtime_probe_time=273ms, total_validator_wall_time=111530.1157ms
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:f31a677434e0897949d25c02dbfe5475c83915b6ae07162b70a28e90145a4d85
proof ledger: gpu-ledger-proof:sha256:e71d4db8c67adea313caf47d212e164e60d34b684f27e81383530a9c08351eb5, gpu_hmr_success=false
refusal reason: native HIP launch evidence is evidence-only and cannot satisfy GPU HMR; no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, host_identity, or runtime output_oracle observation was collected
native ROCm refusal facet: status=refusal_evidence, can_satisfy_dispatch_proof=false, gaps=native_launch_boundary_observed,native_boundary_not_synthi_dispatch_proof,synthi_dispatch_not_observed,artifact_transport_not_observed,epoch_not_observed,output_oracle_not_observed,host_identity_not_observed,adapter_impossible_requires_app_hook
real ROCm app-hook contract facet: status=required_app_hook_contract_missing, declared=false, required=true, can_satisfy_runtime_proof=false, gaps=app_hook_contract_not_declared,app_hook_artifact_transport_evidence_missing,app_hook_artifact_transport_runtime_not_observed,app_hook_epoch_publication_evidence_missing,app_hook_epoch_publication_runtime_not_observed,app_hook_dispatch_trace_evidence_missing,app_hook_dispatch_trace_runtime_not_observed,app_hook_host_identity_evidence_missing,app_hook_host_identity_runtime_not_observed,app_hook_output_oracle_evidence_missing,app_hook_output_oracle_runtime_not_observed
current matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
current matrix proof ids: gpu-ledger-proof:sha256:e71d4db8c67adea313caf47d212e164e60d34b684f27e81383530a9c08351eb5, gpu-runtime-proof:sha256:f31a677434e0897949d25c02dbfe5475c83915b6ae07162b70a28e90145a4d85, real-rocm-validation:sha256:d4ada3b673566388fa013c8f93f87f3775bf6141ab12abb058be859457a9ace8
current matrix row id: gpu-validation-matrix-row:sha256:d034f2b27a49f3cbe8f5ff9394d95f85e461fc1562bf54d8ebabadfcd4bce21b in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T232850Z.json
current matrix open gaps: strict_runtime_proof_artifact_required, proof_ledger_success_required, output_or_visual_oracle_proof_required, real_rocm_runtime_chain_required, real_rocm_app_hook_contract_required, target_progression_gates_failed, native_boundary_not_synthi_dispatch_proof, artifact_transport_not_observed, same_process_epoch_missing, dispatch_epoch_missing, output_oracle_missing, host_identity_not_observed
visual artifacts: first-compile screenshot sha256:d0786b715111c7313ec3525e8ec0f476231a5443d178b924c0b26e819e81a704 and post-HMR screenshot sha256:e37a7d495b24f1f775b910a3d7fb25dd3ae5ed238c7cc019a5e5683fbae5eff2 were opened with the local image tool on 2026-06-25; both render a nonblank preview scene, but both have frame_capture_after_epoch_dispatch=false and are not accepted as GPU HMR output-oracle proof
visual result: compute-only target; no frame-gated visual proof is counted, and the run still refuses because the runtime ledger lacks post-epoch output-oracle observation
```

Current retained real ROCm Composable Kernel large-ML refusal:

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-composable-kernel-gemm-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-composable-kernel
repo: https://github.com/ROCm/composable_kernel.git @ 713f1fbf46ae73755c06a0b115f01795cea9a4f9
result slug: gpu-real-rocm-composable-kernel-20260625084307
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260625084307.json
latest alias path at run time: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/composable-kernel-large-ml-20260625T-retained-ledger.stdout.log
target: example_gemm_xdl_fp32_v3
entry file: example/01_gemm/gemm_xdl_fp32_v3.cpp
repo scale: 7,234 files
upstream build/run: configure completed but the requested target was not generated; build failed with "No rule to make target 'example_gemm_xdl_fp32_v3'", run was skipped, run_exit_code=not-run
output oracle resolution: requested_profile=none, mode=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, runtime_profile_synced=false
candidate artifact identity: artifact_kind=hip_source_bridge, entry_points=DeviceGemm_Xdl_CShuffleV3/GridwiseGemm, compile_target=gfx1201, compiler=/opt/rocm-7.2.1/llvm/bin/amdclang++
native runtime evidence: native launch observer was enabled, but no observer readiness, native launch, function-resolution, Synthi dispatch, artifact-transport, epoch, output-oracle, or host-identity lines were captured before the upstream lifecycle failed
target progression: phase=final-acceptance, required=true, final_acceptance_target=example_gemm_xdl_fp32_v3, gates failed for missing prior small-oracle, partial-reload, original-host-path, full runtime, and raw compute oracle artifacts
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
runtime capability preflight: observed RX 9070 XT/gfx1201, but HIP array allocation matrix and texture fallback probes were unavailable, so original-host-path proof remains blocked
timings: total_validator_wall_time=60690.6106ms, duration_monotonic_ns=60690610600, metric_clock=monotonic_ns, metric_scope=hot_delta_1, cache_state=clean
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:a6cd224bc24c0d0e1d1bddc29ac24651dc7070f492a5fd2b2053d5b7df117501
proof ledger: gpu-ledger-proof:sha256:a02c447db3fffe03210ed805f5188d1ed0e21df446a16e515f559a48743473ec, gpu_hmr_success=false
refusal reason: serious ROCm ML source/build metadata is evidence-only; no Synthi artifact transport, epoch publication, dispatch trace, host identity, output-oracle observation, accepted app-hook contract, accepted sidecar/runtime consistency, or accepted runtime proof chain was collected
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
real ROCm app-hook contract facet: status=not_required at the facet level because no native launch was observed, while profile proof obligations still require an app-hook contract before final acceptance; no stage evidence exists for artifact transport, epoch publication, dispatch trace, host identity, or output oracle
current matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
current matrix proof ids: gpu-ledger-proof:sha256:a02c447db3fffe03210ed805f5188d1ed0e21df446a16e515f559a48743473ec, gpu-runtime-proof:sha256:a6cd224bc24c0d0e1d1bddc29ac24651dc7070f492a5fd2b2053d5b7df117501, real-rocm-validation:sha256:155c3ad621cc346b9d90807877f28063aecfbbf6d57739dfdd9a447d7220a5bb
current matrix row id: gpu-validation-matrix-row:sha256:4fdb4df84e4c133fa8e38763f8d2b7a2fa3918b17df9d814563fa94de13bdaa4 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T232850Z.json
current matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, runtime chain missing, app-hook contract required by profile proof obligations, target-progression gates failed, runtime capability preflight failed, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
visual artifacts: none; compute-only target with no frame-gated visual proof, and no raw readback/card output-oracle artifacts were produced after a Synthi epoch dispatch
```

Historical real ROCm hipBLASLt fused GEMM/GELU/AUX/bias large-ML refusal (superseded by the current refresh above):

```text
profile: mcp/synthi-mcp/scripts/profiles/real-rocm-hipblaslt-gelu-aux-bias-large-ml.json
command: npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-hipblaslt
repo: https://github.com/ROCm/hipBLASLt.git @ 3a609b06926c8227e753b62087555e1f435bf2d4
result slug: gpu-real-rocm-hipBLASLt-20260625090303
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260625090303.json
latest alias path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/hipblaslt-large-ml-rerun-20260625T-retained-ledger.stdout.log
target: sample_hipblaslt_gemm_gelu_aux_bias
entry file: clients/samples/08_gemm_gelu_aux_bias/sample_hipblaslt_gemm_gelu_aux_bias.cpp
repo scale: 2,860 tracked files; worker checkout copy measured 7.3G under /tmp/synthi-real-rocm/hipBLASLt during the run
upstream build/run: CMake configure failed before build/run because Python development/module components were missing; build was blocked by configure failure and run_exit_code=not-run
missing dependencies: Python, Python_EXECUTABLE, Python_INCLUDE_DIRS, Interpreter, Development.Module
output oracle resolution: requested_profile=none, mode=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, runtime_profile_synced=false
candidate artifact identity: artifact_kind=hip_source_bridge, source=clients/samples/08_gemm_gelu_aux_bias/sample_hipblaslt_gemm_gelu_aux_bias.cpp, entry_points=hipblasLtMatmul/hipblasLtMatmulAlgoGetHeuristic/hipblasLtMatmulDescSetAttribute/rocblaslt_matmul, compile_target=gfx1201, compiler=/opt/rocm-7.2.1/llvm/bin/amdclang
native runtime evidence: native launch observer was enabled, but no observer readiness, native launch, function-resolution, Synthi dispatch, artifact-transport, epoch, output-oracle, or host-identity lines were captured before configure failure
target progression: phase=final-acceptance, required=true, final_acceptance_target=sample_hipblaslt_gemm_gelu_aux_bias, gates failed for missing prior small-oracle, partial-reload, original-host-path, full runtime, and raw compute oracle artifacts
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
runtime capability preflight: observed RX 9070 XT/gfx1201, but HIP array allocation matrix and texture fallback probes were unavailable, so original-host-path proof remains blocked
timings: total_validator_wall_time=244406.8801ms, duration_monotonic_ns=244406880100, metric_clock=monotonic_ns, metric_scope=hot_delta_1, cache_state=clean
strict result: refused, gpu_hmr_success=false, runtime_proof_artifact=gpu-runtime-proof:sha256:d7f374724fe99e4b95518c5be6fea8793cb713c3ab3842b0bf14a061ed2627c6
proof ledger: gpu-ledger-proof:sha256:0df91a6edd201f0bf02ace0b4d46dc2b5d56f521f0566abe0b51162a42a3e611, gpu_hmr_success=false
refusal reason: serious ROCm ML library/sample metadata is evidence-only; no Synthi artifact transport, epoch publication, dispatch trace, host identity, output-oracle observation, accepted app-hook contract, accepted sidecar/runtime consistency, or accepted runtime proof chain was collected
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
profile proof obligations: refusal_only=true, requires_full_runtime_proof=true, requires_output_oracle=true, requires_app_hook_contract=true, app_hook_contract_declared=false
historical matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
historical matrix proof ids: gpu-ledger-proof:sha256:0df91a6edd201f0bf02ace0b4d46dc2b5d56f521f0566abe0b51162a42a3e611, gpu-runtime-proof:sha256:d7f374724fe99e4b95518c5be6fea8793cb713c3ab3842b0bf14a061ed2627c6, real-rocm-validation:sha256:1ac7a9444ec44f2f7220e7ef3da18e85d89143ce76a23f9ba640a2bb237645f5
historical matrix row id: gpu-validation-matrix-row:sha256:05c51af0d3e67a4fccfa61bb5419b58baa7c5ec92a568645ef450c419675e07e in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T090839Z.json
historical matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, runtime chain missing, app-hook contract required by profile proof obligations, target-progression gates failed, runtime capability preflight failed, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
visual artifacts: none; compute-only target with no frame-gated visual proof, and no raw readback/card output-oracle artifacts were produced after a Synthi epoch dispatch
```

This is not yet production-grade acceptance for every arbitrary GPU project. The current accepted full-runtime scope is scoped generated/profiled ROCm/HIP preview device-artifact rows plus the explicitly proven scoped WebGPU visual and compute/readback profiles. HIP module/readback rows are retained evidence only until they carry accepted strict runtime proof artifacts. HIPRT CameraRays and MegaKernel direct-light-gain are preserved as source-adapted visual-profile evidence only, not accepted no-shim full-runtime GPU HMR.

Still open or refused: MIOpen full-runtime GPU HMR, real ROCm matrix multiplication full-runtime GPU HMR, real ROCm Composable Kernel full-runtime GPU HMR, real ROCm hipBLASLt full-runtime GPU HMR, HIPRT MegaKernel direct-light-zero, OIDN HIP output proof, Vulkan, OpenCL full-runtime acceptance, Bevy, WebGPU compute/resource forms beyond the proven explicit storage/uniform float32 readback profile, WebGPU engine-owned pipeline caches, and WebGPU resource layouts beyond the proven visual/compute subsets. CUDA is not applicable to this local AMD ROCm matrix and still needs a separate CUDA-machine run.

## Hard Rules Preserved

- No hardcoded proof success paths were added.
- No shims were added.
- MIOpen was added as a profile-driven large real ROCm project validation target. The runner reads repo, target, build, launch, and oracle settings from the profile/env path; there is no MIOpen-specific success branch.
- Composable Kernel was added as a second profile-driven large real ROCm ML validation target. The runner reads repo, target, build, launch, native symbol, oracle, and progression settings from the generic real ROCm profile path; there is no CK-specific success branch.
- hipBLASLt was added as a third profile-driven large real ROCm ML validation target. The runner reads repo, target, build, launch, native symbol, oracle, and progression settings from the generic real ROCm profile path; there is no hipBLASLt-specific success branch.
- Large real ROCm project validation rows are matrix-ingested through generic `real_rocm_profile` evidence and still fail closed unless a strict runtime proof artifact, recomputed proof ledger, and artifact-backed output oracle are present. Top-level `output_proof.accepted=true` flags are ignored for acceptance; visual-ledger outputs require readable visual artifact files.
- Large real ROCm compute-oracle rows now re-read `raw_readback_bin`, `readback_schema_json`, and `rendered_card_png` from disk and derive hash, byte-length, deterministic-slice, schema, and PNG-card proof from those files. Embedded `raw_readback_hash_verified` or `deterministic_slice_hash_verified` booleans are not authority, and compute-ledger rows cannot pass by attaching unrelated top-level visual files.
- Real ROCm runtime output-oracle profiles now sync by configured worker container instead of MCP transport. Local MCP validation can still deliver a profile into the real worker when a profile is declared; the selected retained MIOpen upstream-lifecycle profile declares `profile=none`, so the worker oracle file was cleared and the run correctly remained refused.
- Real ROCm checkout reuse now verifies that an existing local path is a git worktree root with a valid HEAD and the expected origin remote before it is used. Invalid checkouts under the validator-owned `tmp/real-rocm/*` tree are quarantined for evidence-preserving reruns; custom paths are not modified and fail loudly.
- The worker Dockerfiles now include generic large-project build prerequisites (`ninja-build`, Python development headers/tools, SQLite development files, BZip2 development files, msgpack C/C++ development files, nlohmann JSON, gfortran, and Boost filesystem/program-options/system development files). `Dockerfile.gpu` also now builds the real `/usr/local/lib/synthi-gpu-native-launch-observer.so` from `cpp_src/synthi_gpu_native_launch_observer.c`, matching the non-GPU worker image. This is not an HMR proof. The nlohmann JSON, gfortran, and native-observer GPU image was rebuilt and verified in image `sha256:5ad576f3b4bbe004ae815316298022c5a9e92a17e44f109e5c4db9ae1170a711`; Boost image verification and rerun proof remain pending because Docker Desktop/BuildKit is timing out after an overlay/dpkg I/O failure.
- Real ROCm runtime evidence is now collected from the configured worker container even when the MCP transport is local. The selected retained MIOpen upstream-lifecycle run therefore records observed native launch-boundary evidence and the absence of Synthi dispatch, artifact transport, epoch swap, output oracle, and host-preservation proof instead of treating missing docker transport as missing evidence.
- Native ROCm/HIP launch-boundary evidence is now a first-class refusal facet in the runtime proof artifact and derived acceptance contract. It is explicitly marked `can_satisfy_dispatch_proof=false`; observed native function resolution cannot satisfy GPU HMR without Synthi artifact transport, epoch publication, dispatch, output oracle, and host-preservation proof.
- Large real ROCm app-hook contracts are now generic, profile-declared evidence inputs, not project branches. Matrix ingestion fails closed when native ROCm launch-boundary evidence requires an app hook but no contract/runtime observation proves artifact transport, epoch publication, dispatch trace, host identity, and output oracle stages. Profile `evidenceRefs` must resolve against collected runtime/proof evidence before they count as contract evidence.
- Large ROCm runtime eligibility is now a separate evidence-only facet. It can identify a HIP candidate, source dialects, candidate artifact identity, compiler, and missing proof gates for a serious project such as MIOpen, but it is explicitly `candidate_metadata_only_not_gpu_hmr_success` and cannot authorize backend, dispatch, epoch, or oracle proof.
- Real ROCm runtime capability preflight is now a separate evidence-only matrix facet. The collector reads generic `runtime_capability_preflight` / `runtimeCapabilityPreflight` data from top-level results, evidence containers, validation summaries, runtime proof artifacts, and original-host proof records; failed device/allocation preflight blocks accepted real ROCm rows but cannot satisfy GPU HMR success.
- Large real ROCm profiles can now declare generic runtime output-oracle profiles and target-progression defaults. The selected retained MIOpen upstream-lifecycle profile declares `outputOracle.profile=none` and required `targetProgression.phase=final-acceptance`, so the result explicitly reports no installed oracle and fails the missing prior-phase/full-runtime/raw-compute-oracle gates instead of implying hidden proof.
- Large real ROCm ML final-acceptance profiles now require configured hot-delta-2 and negative-edit source-delta fixture candidates in addition to `requiresRunModes=true` and `requiresNegativeEdit=true`, and the matrix now requires runner-observed source/write/compile-attempt evidence with content-addressed before/after/edit hashes before those phases can count. Retained MIOpen, Composable Kernel, and hipBLASLt result artifacts predate executed hot2/negative phases, so the latest matrix recomputation adds missing fixture gaps plus `source_delta_execution_missing` and keeps those rows refused.
- Real ROCm matrix ingestion now hard-blocks explicit disabled output-oracle resolutions. A forged final-acceptance row with `requestedProfile=none`, `mode=none`, no selected source, no contract, no synced runtime profile, valid ledger-looking materials, and raw compute oracle files remains `unproven` with `real_rocm_output_oracle_resolution_not_accepted`.
- The selected retained MIOpen upstream-lifecycle rerun records the generic compile-bridge facet as `compile_bridge_missing`: the no-device run collected no compile phase proof material and no `load_device`, device-sidecar, artifact reference, or runtime-proof material.
- The real ROCm matrix multiplication profile declares `outputOracle.profile=hip.matrix-multiplication.readback-c.v1`; the runner derives the buffer checksum oracle from source constants and the edited `b_value`, syncs that profile to the worker, and still refuses because the runtime never emitted Synthi epoch/dispatch/output-oracle evidence.
- The real ROCm Composable Kernel profile declares `outputOracle.profile=none` and `proofObligations.acceptanceMode=refusal_only`; the matrix records a candidate HIP source-bridge artifact from profile/build metadata but refuses it because no upstream target binary, Synthi runtime chain, app-hook contract, epoch dispatch, host identity, or output oracle exists.
- The real ROCm hipBLASLt profile declares `outputOracle.profile=none` and `proofObligations.acceptanceMode=refusal_only`; the matrix records a candidate HIP source-bridge artifact from profile/build metadata but refuses it because the selected upstream lifecycle artifact failed on missing `CMAKE_Fortran_COMPILER`/`gfortran` and no Synthi runtime chain, app-hook contract, epoch dispatch, host identity, or output oracle exists.
- Real ROCm output-oracle profiles must now declare native launch symbols. The runtime eligibility contract filters native observer placeholders such as `unknown`, so the matrix candidate artifact records `matrix_multiplication_kernel` rather than accepting an unknown entry point.
- The real ROCm matrix multiplication profile is now a required `small-oracle` progression phase for the larger `MIOpenDriver` final-acceptance target. It still refuses because the small-oracle gate requires an epoch-bound runtime output proof, not a source-derived oracle contract or native HIP launch observation alone.
- Real ROCm compile phases now retain an evidence-only compile bridge facet. The latest tightened matrix run records two successful `synthi_compile` responses with only `ok/session_id/language/filename/dispatched_at/note` top-level fields and no `load_device`, device-sidecar, artifact-reference, runtime-proof material, or matching bridge signal strings, so the matrix row carries `real_rocm_compile_bridge:compile_response_device_sidecar_bridge_not_declared` as the next bridge gap.
- Real ROCm compile bridge candidates are explicitly non-authoritative until the runtime proof chain accepts. The validator and matrix smoke test keep compile-only bridge candidates blocked with `compile_response_bridge_candidate_not_runtime_proof`, and only convert them to linked evidence after accepted runtime proof artifacts are already present.
- Real ROCm device-sidecar contracts are now recomputed after runtime proof collection. A sidecar contract can satisfy the sidecar gate only when build/profile evidence is complete and runtime artifact transport, epoch publication, dispatch trace, output oracle, host identity, and full-runtime proof are all observed. The selected retained MIOpen upstream-lifecycle rerun still derives only a candidate rooted at `src/kernels/MIOpenNeuron.cl`, so it remains refused.
- Real ROCm final-acceptance profiles now get an explicit profile proof-obligation facet. A final-acceptance profile with no output-oracle profile is blocked unless it is explicitly refusal-only, and target progression marked `required=true` implies full-runtime proof is required.
- Real ROCm validation matrix rows now derive CPU HMR, full rebuild, and process restart firewall fields from recomputed ledger/runtime firewall evidence. Accepted rows must expose all three as explicit `false`; missing evidence or forged `true` values remain refusal/open-gap material. Smoke fixtures also prove old-artifact dispatch (`dispatch_artifact_hash_mismatch`) surfaces through ledger reasons instead of being accepted.
- Large real ROCm final-acceptance progression now verifies prior `small-oracle` ledger entries from artifact-backed compute or visual oracle evidence. Compute prior rows must carry re-readable raw readback/schema/card artifacts; visual prior rows must carry re-readable image artifacts with matching content hashes.
- Large real ROCm target-progression gate failures are now hard blockers in matrix acceptance; failed prior `partial-reload` or `original-host-path` gates cannot be hidden behind otherwise successful runtime/oracle rows.
- Real ROCm target-progression ledger artifacts now merge reported gate rows with freshly derived gate rows. If a fatal/preflight path skips normal gate construction, or if a row claims `pass` while proof fields are false, the retained ledger entry is written as `fail`.
- Large real ROCm app-hook requirements now fail closed when explicitly declared through profile proof obligations, profile declarations, native-boundary app-hook gaps, or the app-hook facet itself. Missing or unproven required app-hook facets cannot be accepted by default-open ingestion.
- Real ROCm profile proof obligations now surface explicit app-hook requirements and emit `proof_obligation_app_hook_contract_missing` when a required app-hook contract is not declared.
- The validation matrix now preserves each real ROCm row's `outputOracleResolution`, `targetProgression`, `targetProgressionGates`, `nativeRocmLaunchBoundary`, `realRocmRuntimeEligibility`, and `realRocmRuntimeCapabilityPreflight` metadata, so large-project refusal gaps are machine-auditable without relying on raw logs.
- Visual matrix acceptance now decodes PNG artifacts with `sharp`; PNG headers or existing files are not enough. Run-mode visual proofs cannot opt out with `visualRequired=false`, and Flow/ray-light coverage requires accepted visual evidence.
- Docker proof runners now require explicit runtime configuration instead of baked-in endpoint/container/entry defaults.
- Visual evidence must be readable image artifacts; invalid image placeholders are rejected.
- `wait_hmr` now returns embedded proof ledger and runtime proof artifact materials for full-runtime GPU proof waits; matrix acceptance recomputes ledger invariants from those materials instead of trusting supplied summaries.
- HIPRT matrix rows require the same embedded proof-ledger/runtime-artifact chain as other full-runtime GPU HMR rows plus matrix-recomputed nonblank oracle-region proof from the persisted PNG pixels; source-adapted profile hooks still demote the row to visual-profile evidence, older HIPRT artifacts without the chain are not accepted, and blank render-region outputs are structured refusals.
- Preflight refusal rows require explicit no-shim, no-symlink, and no-synthesized-runtime evidence.
- After `37f110451`, visual HMR success cannot be derived from screenshots or pixel diffs alone. If visual proof is required, the derived proof ledger record must contain `visual_oracle_artifacts`; screenshots remain evidence inputs.
- Compute proof cards are supplemental unless the accepted target is compute-only and backed by deterministic output-oracle proof.
- After `5e1ad07b6`, a placeholder `requiredOracleId` no longer satisfies fission output proof. Fission candidates require a verified inline proposal or resolved output-oracle contract.
- One generated `.hip` file is not proof by itself. The ray-light generated split now proves per-kernel/smallest-safe fission only because the deterministic verifier saw one selected device role, one kernel, full runtime proof, and a frame-gated visual oracle. Flow still refuses per-kernel/smallest-safe fission because the selected device role owns two kernels.

## Latest Hardening Checkpoint

Additional commits since the previous status pass:

```text
f819ed03d fix(gpu-hmr): require large rocm delta fixtures
7262aaa7d docs(gpu-hmr): clarify retained rocm evidence scope
d874b3d29 docs(gpu-hmr): record refreshed large rocm refusal
e699e9ec6 build(worker): isolate boost rocm image layer
4b8fc32ef fix(worker): add boost components for large rocm builds
23f3be60a fix(gpu-hmr): keep real rocm runtime refusal collection total
65b7bb824 fix(gpu-hmr): prefer complete rocm validation evidence
e01422bed fix(gpu-hmr): classify missing cmake compilers
df0530b1f fix(gpu-hmr): package native observer in gpu worker
0c5fbb7d0 fix(worker): add fortran rocm build prerequisite
3ef9bc93c fix(worker): add nlohmann json rocm build prerequisite
14c7ef824 fix(gpu-hmr): parse cmake config package dependencies
bbede61fd fix(worker): add msgpack rocm build prerequisites
649090052 fix(worker): add bzip2 rocm build prerequisite
c6ea90ac2 fix(worker): add gpu image rocm build prerequisites
76f0409c6 docs(gpu-hmr): note rocm worker prerequisites
d78b2275b fix(worker): add generic rocm build prerequisites
52cd7ae91 fix(gpu-hmr): quarantine invalid real rocm checkouts
6e3f7e759 test(gpu-hmr): add hipblaslt large rocm profile
9b5712ee8 docs(gpu-hmr): record composable kernel refusal proof
2bd609e29 test(gpu-hmr): add composable kernel real rocm profile
e4a526acb fix(gpu-hmr): enable long-path real rocm checkouts
9d0ae2fb9 docs(gpu-hmr): record retained rocm matrix evidence
99097a274 fix(gpu-hmr): retain real rocm validation reports
0f60de944 docs(gpu-hmr): record rocm matrix refusal rerun
9f6d25a8c fix(gpu-hmr): derive webgpu companion firewall proof
88fbe7204 docs(gpu-hmr): record current rocm proof ledger
37731524f fix(gpu-hmr): narrow rocm dependency parsing
084504ab5 fix(gpu-hmr): refine real rocm failure facets
fa23f9f88 fix(gpu-hmr): classify real rocm lifecycle failures
9cd1ab966 fix(gpu-hmr): emit generated fission evidence
94bdbcd26 fix(gpu-hmr): bind generated visual profile proofs
0a1fde26d fix(gpu-hmr): normalize generated split support
98c4dff5c fix(gpu-hmr): discover real rocm worker locally
c15aa5f59 docs(gpu-hmr): record webgpu run-mode proof links
43f91dc78 fix(gpu-hmr): link webgpu run-mode support
346ab5366 fix(gpu-hmr): normalize run-mode artifact hashes
13e3dc497 docs(gpu-hmr): refresh matrix proof status
0e261cfdf fix(gpu-hmr): require explicit runtime profiles
757503e1f fix(gpu-hmr): derive visual profile coverage
05dbbfcf5 fix(gpu-hmr): recompute visual proof artifacts
98f949bbf chore(gpu-hmr): add validation matrix history proof script
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
WebGPU runtime visual proof now accepts executed explicit-empty WGSL and explicit-profiled uniform-buffer/float32-vertex-buffer pipeline scopes, and derives success from shared ledger invariants, visual thresholds, process-continuity evidence, native WebGPU API evidence, and resource binding traces.
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
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:profiled
npm --prefix mcp/synthi-mcp run proof:webgpu:runtime-visual:profiled-hot2
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check
npm --prefix mcp/synthi-mcp run proof:timing-metrics
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
  result: passed
npm --prefix mcp/synthi-mcp run proof:validation-matrix:history
  result: passed
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:megakernel-light-gain
  historical result before fail-closed runner hardening: passed on ROCm/RX 9070 XT worker with visual image-tool inspection; current source-adapted reruns must set `SYNTHI_HIPRT_WARM_ALLOW_REJECTED=1` and remain diagnostic visual-profile evidence, not no-shim GPU HMR success
```

## Validation Matrix Ledger

Superseded June 25 matrix artifact retained for history:

```text
schema: synthi.gpu.hmr.validation_matrix_ledger.v1
proof id: gpu-validation-matrix-ledger:sha256:267836eb676af5caf730a7e8ad94cacd68a8dc6cc390f2760eff6f2d7b8207b6
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T070719Z.json
markdown: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T070719Z.md
```

Current superseding matrix artifact:

```text
schema: synthi.gpu.hmr.validation_matrix_ledger.v1
proof id: gpu-validation-matrix-ledger:sha256:eda23f85a6a301dfb69f87f303ffc672517c466b76a9cce25517603c63b998fd
json: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T232850Z.json
```

Matrix result:

```text
row count: 48
accepted full-runtime GPU HMR rows: 16
broad library-agnostic full-runtime GPU HMR rows: 0
computed broad readiness: accepted=false, authority=matrix_computed_not_row_declared, open gaps=matrix_level_broad_generalization_proof_not_present,broad_runtime_rows_not_computed_from_matrix,broad_acceptance_requires_more_backend_families,broad_acceptance_requires_more_acceptance_scopes
scoped full-runtime GPU HMR rows: 16
  flow
  ray-light
  webgpu-wgsl-runtime-compute-storage
  webgpu-wgsl-runtime-compute-storage-hot2
  webgpu-wgsl-runtime-triangle
  webgpu-wgsl-runtime-profiled-layout
strict cold split rows: 3
deterministic fission rows: 1
  trace_light_rays
visual-profile rows: 5
  hiprt-camera-rays-horizontal-mirror
  hiprt-megakernel-direct-light-gain
  threejs-webgl-shader-lava
structurally proven refusal rows: 22
  bevy-wgsl-shader-material typed bevy_wgsl manifest-backed refusal
  real-rocm-composable-kernel-gemm-large-ml
  real-rocm-hipblaslt-gelu-aux-bias-large-ml
  real-rocm-miopen-activation-large-ml
  real-rocm-matrix-multiplication
  hiprt-camera-rays-horizontal-mirror ABI-changing negative edit refusal
  hiprt-megakernel-direct-light-gain ABI-changing negative edit refusal
  hiprt-megakernel-direct-light-zero
  oidn-hiprt-rocm-preflight-20260622-real-checkout
  oidn-preflight-20260624090147
  oidn-preflight-20260624093615
  oidn-preflight-20260624093728
  oidn-preflight-20260624095704
  opencl-rocm-preflight-20260609-after-output-gate
  opencl-rocm-preflight-20260609
  vulkan-rocm-preflight-20260609
  webgpu-wgsl-runtime-profiled-layout negative edit refusal
  webgpu-wgsl-runtime-triangle negative edit refusal
preflight-only rows: 1
  webgpu-preflight-20260625-typed-backend-evidence
not-applicable rows:
  cuda_runtime hardware_scope=rocm_amd_local_run observed_backends=hip,hiprt,oidn_hip
omitted stale/unproven historical attempts by default: 615
```

Derived plan coverage:

```text
accepted:
  rocm_hip_full_runtime
  hip_module_scoped_runtime_readback
  flow_visual_gpu_path
  ray_light_visual_gpu_path
  webgpu_scoped_runtime_visual
  webgpu_empty_layout_runtime_visual
  webgpu_profiled_layout_runtime_visual
  webgpu_compute_runtime_readback
  per_kernel_smallest_safe_fission
  per_target_run_modes
visual_profile_only:
  source_adapted_hiprt_camera_rays_and_megakernel_visual_profiles
  threejs_webgl_external_engine_visual_profile
refused:
  large_real_rocm_repo
  large_real_rocm_repo:real-rocm-composable-kernel-gemm-large-ml
  large_real_rocm_repo:real-rocm-hipblaslt-gelu-aux-bias-large-ml
  large_real_rocm_repo:real-rocm-matrix-multiplication
  large_real_rocm_repo:real-rocm-miopen-activation-large-ml
  hiprt-megakernel-direct-light-zero blank oracle-region output
  oidn_hip_output
  bevy_file_loaded_wgsl
  opencl_dispatch_readback
  vulkan_pipeline_frame
preflight_only:
  webgpu_runtime_preflight
not_applicable:
  cuda_runtime
missing:
  hiprt_visual_path
  hiprt_run_modes
current coverage note: current global coverage includes fresh row-bound Flow/ray-light visual-profile evidence from the 2026-06-25 reruns, typed ThreeJS external visual-profile evidence from the 2026-06-25 rerun, and typed WebGPU runtime-capability preflight evidence with an image-inspected diagnostic frame. The older focused Flow/ray-light matrix remains historical scoped evidence, while the current global matrix is the aggregate authority.
legacy external note: the Bevy legacy timeout report is rewrapped as a typed external rejection only by matching the report profile id to the packaged profile manifest. The recovered profile selection is marked recovered, not explicit, and conflict checks reject mismatched report fields.
```

Important interpretation:

```text
ThreeJS WebGL shader-lava is current accepted matrix authority only as typed external visual-profile evidence. It is not full-runtime GPU HMR because the row still lacks the same-process loader, epoch publication, dispatch trace, host identity, and full runtime proof ledger required by the plan.
WebGPU preflight is typed runtime capability evidence only; the separate webgpu-wgsl-runtime-triangle row is the scoped full-runtime WebGPU proof. The preflight row is `preflight_only` with open gap `shader_pipeline_or_output_oracle_not_proven`; it does not set GPU HMR success.
OpenCL, Vulkan, and Bevy rows are evidence-backed refusals, not GPU HMR acceptance. The current Bevy typed row is `gpu-validation-matrix-row:sha256:1aa750bf7d71bcf2d3feff82bff564cb5e083f1ff3040af5d6bc9f00f37e8ebd` with proof `external-rejection-proof:543387dc31d8a1a92e79c58a0dcc137a3eede776be7f0ac5f03881e5f3feaeec`.
The large real ROCm/MIOpen row is an evidence-backed refusal. It is matrix-ingested as a generic real ROCm validation row and remains rejected because no accepted strict runtime proof artifact exists, proof-ledger success is false, same-process app-hook contract proof is not present, output/visual oracle proof is not present, runner-observed content-addressed hot-delta-2/negative-edit source-delta execution is missing, and the selected worker-backed run configured successfully but failed during the upstream `MIOpenDriver` build on missing `half/half.hpp` before any run/dispatch/output proof. The latest matrix row carries `outputOracleResolution` with profile `none`, no selected source, no contract, and no runtime profile; `targetProgression` at phase `final-acceptance`; plus app-hook, profile proof-obligation, runtime-capability, runtime-chain, CPU/GPU firewall, source-delta execution, and runtime-eligibility gaps showing that diagnostic observer setup is not Synthi artifact transport, epoch publication, dispatch, host identity, oracle proof, or explicit no-CPU/no-full-rebuild/no-restart proof.
The large real ROCm/Composable Kernel row is also an evidence-backed refusal. It is matrix-ingested through the same generic real ROCm profile path, retains the serious-repo checkout and candidate HIP source-bridge metadata, and remains rejected because the upstream target binary was not generated, no accepted strict runtime proof artifact exists, proof ledger success is false, output-oracle profile is disabled, app-hook proof obligations are missing, runner-observed content-addressed hot-delta-2/negative-edit source-delta execution is missing, runtime capability preflight failed, and no artifact transport, epoch publication, dispatch, host identity, or output oracle was observed.
The large real ROCm/hipBLASLt row is an evidence-backed refusal for a third serious ML infrastructure path. It is matrix-ingested through the same generic real ROCm profile path, retains the fused GEMM/GELU/AUX/bias sample candidate metadata, and remains rejected because the selected upstream lifecycle artifact failed on missing `CMAKE_Fortran_COMPILER`/`gfortran`, no accepted strict runtime proof artifact exists, proof ledger success is false, output-oracle profile is disabled, app-hook proof obligations are missing, runner-observed content-addressed hot-delta-2/negative-edit source-delta execution is missing, runtime capability preflight failed, and no artifact transport, epoch publication, dispatch, host identity, or output oracle was observed.
Real ROCm validation acceptance requires artifact-backed oracle evidence. A recomputed ledger can satisfy compute-output proof, but visual ledger outputs must also have readable visual files; top-level oracle success booleans are not authority.
OIDN HIP is an evidence-backed refusal from the real 2026-06-22 checkout preflight; CPU OIDN diagnostics passed, HIP device creation/readback failed, and no shim/symlink/synthesized runtime was applied.
HIPRT CameraRays and MegaKernel direct-light-gain are source-adapted visual profiles, not accepted no-shim full-runtime GPU HMR rows. The matrix recomputes their oracle-region visual evidence from persisted before/after PNG pixels and keeps them as `visual_profile_accepted`, while `hiprt_visual_path` and `hiprt_run_modes` remain missing for no-shim acceptance. HIPRT MegaKernel direct-light-zero remains a proven blank oracle-region refusal.
The per-kernel/smallest-safe fission row is a deterministic fission verifier proof, not a full-runtime GPU HMR row. Runtime acceptance remains ledger-gated.
The global `per_target_run_modes` plan row is accepted for 4 enrolled run-mode targets because generated Flow, generated ray-light, scoped WebGPU explicit-empty WGSL, and scoped WebGPU explicit-profiled WGSL carry the full cold/hot1/hot2-different-edit/negative-edit sequence. SAXPY is not a current accepted full-runtime row in the latest default matrix. HIPRT run-mode artifacts remain useful visual-profile evidence only because they disclose source-adapted profile hooks.
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

Fresh verification after `f819ed03d`:

node --check mcp/synthi-mcp/scripts/gpu-hmr-agent-split-workspace-test.mjs
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs
node mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs
node --check mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
  latest result: passed, matrix gpu-validation-matrix-ledger:sha256:eda23f85a6a301dfb69f87f303ffc672517c466b76a9cce25517603c63b998fd
npm --prefix mcp/synthi-mcp run proof:validation-matrix:history
  latest history audit: passed, matrix gpu-validation-matrix-ledger:sha256:0d278a8d64ad61f6f4adf734614dadad651c082bfbd2465f9226c56498654217
  smoke coverage: compute-only real ROCm oracle acceptance, forged missing raw/schema/card file refusal, forged large ROCm ML final-acceptance refusal when hot-delta-2/negative-edit fixtures are absent, and generic worker-repo transfer refusal scoring
node mcp/synthi-mcp/scripts/gpu-hmr-real-rocm-repo-validation.mjs --self-check
  latest result: passed; includes generic real ROCm profile loading, runtime-dispatch evidence, CMake missing package/config/compiler parsing, git-remote normalization, and safe invalid-checkout quarantine/refusal self-checks
docker buildx build --check -f backend/synthi-webrtc-compiler/worker/Dockerfile backend/synthi-webrtc-compiler/worker
  selected retained upstream-lifecycle result: passed after the zstd/Boost ROCm worker rebuild; MIOpen then fails at upstream `half/half.hpp` build dependency with strict `gpuHmrSuccess=false`; latest large-ML attempts for MIOpen, Composable Kernel, and hipBLASLt now fail earlier at Docker daemon preflight and remain non-success evidence

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

## Historical ROCm/HIP Runtime Ledger

Historical retained strict runtime artifact. This SAXPY-era artifact is not a current accepted full-runtime row in the latest validation matrix; it is retained as older compute/readback evidence:

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

Supplemental compute-output proof card:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/gpu-real-rocm-repo-20260609005300-oracle-real-rocm-saxpy-readback-y-d6555ff7b9f8f753-compute-output-oracle.png
```

The compute-output card was inspected with the local image viewer. It is readable and shows `Runtime Compute Output Oracle`, target `HIP-Basic/saxpy/main.hip:y`, generation 3, `PASSED`, with matching expected and actual GPU readback hashes. This is not frame-gated runtime visual proof and is not counted as current full-runtime GPU HMR by the latest matrix.

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

## HIPRT Same-Process Visual Evidence

HIPRT proof is separate from the MCP browser preview path. The current HIPRT CameraRays and MegaKernel direct-light-gain artifacts are useful same-process ray-traced visual profiles, but they are source-adapted profile runs and are not accepted as no-shim full-runtime GPU HMR. The matrix now classifies them as `visual_profile_accepted` while leaving `hiprt_visual_path` and `hiprt_run_modes` missing for no-shim acceptance. This is deliberately not broad HIPRT application acceptance.

Some older persisted HIPRT proof JSON files still contain raw `gpuHmrSuccess=true` or strict-gate-pass fields from before source-adapted demotion. Those fields are not current authority. The validation matrix recomputes the claim boundary from the disclosed `runtimeProbeInstrumentation.sourceAdaptations` and sets `acceptedForGpuHmr=false` for those rows.

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

CameraRays source-adapted run-mode visual evidence:

```text
matrix coverage rows: hiprt_run_modes=missing, hiprt_visual_path=missing
current matrix proof id: gpu-validation-matrix-ledger:sha256:eda23f85a6a301dfb69f87f303ffc672517c466b76a9cce25517603c63b998fd
matrix classification: visual_profile_accepted, acceptedForGpuHmr=false, sourceAdaptedProfile=true

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
visualProfileAccepted: true
fullRuntimeGpuHmrAccepted: false
matrix outcome: visual_profile_accepted
acceptedForGpuHmr: false
sourceAdaptedProfile: true
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

Latest MegaKernel direct-light-gain rerun on 2026-06-24:

```text
proof id: hiprt-warm-runtime-proof:sha256:10abd06afa34694c16b744d62d052e76c3f5838bbf2d4bc1e7ef20d7b6ce95ad
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-proof.json
before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-same-process-baseline-framebuffer.png
after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-same-process-changed-framebuffer.png
diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hiprt-light-math-warm-proof/hiprt-warm-light-math-20260624075246-diff-amplified.png
metric scope: hot_delta_1
device arch: gfx1201
changed_pixel_ratio: 0.3540494791666667
mean_abs_delta_8bit: 7.759528356481481
adapter build: 79861ms
same-process live recompile: 54ms
trigger wait: 665ms
edit to first visual: 9894ms
screenshot capture: 17448ms
total validator wall: 326921.0508ms
visual inspection: baseline, changed, and amplified diff PNGs opened with the local image tool on 2026-06-24; the ray-traced scene is nonblank and the amplified diff shows localized direct-lighting change.
matrix authority: visual_profile_accepted only, not no-shim full-runtime HIPRT GPU HMR, because the runtime profile discloses source-adapted hooks.
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

Visual inspection confirmed CameraRays before/after/diff images are readable and nonblank, with a mirrored/recomposed Cornell-style framebuffer. Visual inspection also confirmed the MegaKernel direct-light-gain rerun has nonblank baseline/changed frames and a visible amplified diff. MegaKernel direct-light-zero remains refused because the changed image has a mostly black render region despite a high-signal diff image.

## OIDN Status

OIDN was tested in the real HIPRT checkout through structured preflight artifacts, most recently on 2026-06-24. The result remains a refusal for HIP output proof. Earlier real-checkout runs showed CPU OIDN diagnostics pass but the installed HIP OIDN device library links against `libamdhip64.so.5`, which is unavailable in the ROCm 7 worker environment. The latest fail-closed diagnostic rerun also refused because the declared worker checkout/tool path was unavailable. No compatibility shim, symlink, fake library, or synthesized runtime was added.

```text
latest proof id: oidn-preflight-proof:sha256:25577fa64be579acb4bb512f3b1f2cb3652e48885b90f84e0d54e7aca3198ff4
latest result state: oidn-hip-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624095704-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624095704-summary.txt
repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
previous proof id: oidn-preflight-proof:sha256:31440c66d50faa297208cdc81ff1d0c3c7803521480b58715224e6385b78a782
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624093728-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624093728-summary.txt
previous proof id: oidn-preflight-proof:sha256:ff9c8e5874689e0bba475ae9f7a9f2f6f70fcbe6b1bdc33fb77e54d799636492
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624093615-proof.json
previous proof id: oidn-preflight-proof:sha256:c4d8a338351bd2f7c39e5c731147f5b4647ac30f144da1fc9aaf60377391405f
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624090147-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624090147-summary.txt
previous proof id: oidn-preflight-proof:sha256:5fc3136f57579a91c4be2475af7d1776d23e5c19696d7f76a1794413db5ec21a
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-summary.txt
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

Latest path-integrity evidence:

```text
oidnTest resolved path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer/build/_deps/oidnbinaries-src/bin/oidnTest
oidnTest file type: ELF 64-bit LSB pie executable
oidnTest sha256: sha256:e1172cc0e6edf5af00493c922ea8a2a79159b928af6308e4a09df364bbca42cb
HIP device library resolved path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer/build/_deps/oidnbinaries-src/lib/libOpenImageDenoise_device_hip.so.2.3.0
HIP device library file type: ELF 64-bit LSB shared object
HIP device library sha256: sha256:ec91d9544044b1f95074363c72e3706e065c835b2a5906d578a0afaf9c70d56f
symlinked paths: none
wrapper/shim paths: none
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
latest proof id: webgpu-preflight-proof:sha256:cf0b7bb1c6c1981398a055bcc2d19e81c9e3d7cf3ce519301ec7f721ae79f637
latest result state: webgpu-runtime-preflight-accepted
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260625-typed-backend-evidence-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260625-typed-backend-evidence-summary.txt
latest diagnostic screenshot: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-preflight/webgpu-preflight-20260625-typed-backend-evidence-diagnostic.png
latest matrix row id: gpu-validation-matrix-row:sha256:c422b72c6ba953318cb754aae1cb00252b3c013303a34d28248530c9d77b5d48
```

The live browser accepted WebGPU runtime preflight:

```text
browser: C:\Program Files\Google\Chrome\Application\chrome.exe
browser launch args: --enable-unsafe-webgpu --ignore-gpu-blocklist --enable-features=Vulkan,WebGPU,UseSkiaRenderer --disable-gpu-sandbox
adapter: {"vendor":"amd","architecture":"rdna-4","device":"","description":""}
preferred canvas format: bgra8unorm
unsupported reasons: none
```

The diagnostic screenshot was visually inspected and is nonblank: it shows a rendered WebGPU triangle plus the runtime JSON (`navigator.gpu`, adapter, device, and render-submit true). This is typed backend/runtime-capability evidence only; the matrix row is `preflight_only`, not GPU HMR success.

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

Historical June 9 base explicit-empty WebGPU runtime visual proof. Current accepted WebGPU visual rows are the 2026-06-23 explicit-empty hot1/hot2 and explicit-profiled hot1/hot2 scoped rows recorded in the latest matrix above.

```text
historical runtime proof id: webgpu-runtime-visual-proof:sha256:e45b1d839607d694a744226228c0341dd6959eb336058bf733152a77f972e81d
historical runtime result state: webgpu-hmr-full-runtime-proven
historical runtime ledger id: gpu-ledger-proof:sha256:56994c1b29cef52e7b86ba4d3936031a3486123bb62da99ab1e554d779011a2e
historical runtime proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-proof.json
historical runtime summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-summary.txt
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

The shared timing summary includes the scoped WebGPU rows:

```text
timing summary json: mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260624T093916Z.json
sources: webgpu_runtime_visual, webgpu_runtime_compute
profiles: webgpu-wgsl-runtime-triangle, webgpu-wgsl-runtime-profiled-layout, webgpu-wgsl-runtime-compute-storage, webgpu-wgsl-runtime-compute-storage-hot2
reportedStatus: pass
proofVerdict: not_evaluated_by_timing_summary
timing authority: timing metrics are telemetry only; validation-matrix proof ledgers are the acceptance authority.
profiled hot1 total wall: 931.5372ms
profiled hot1 trigger to visible: 122.5624ms
profiled hot2 total wall: 923.1318ms
profiled hot2 trigger to visible: 123.5537ms
compute hot1 total wall: 703.6928ms
compute hot1 dispatch to output proof: 698.9754ms
compute hot2 total wall: 684.1210ms
compute hot2 dispatch to output proof: 681.8655ms
```

Latest WebGPU compute/readback proof:

```text
profile scope: explicit-compute-profiled-layout-storage-uniform-float32-readback
hot1 proof id: webgpu-runtime-compute-proof:5550fdf2044e56986e75183dc81ef679d78f966ef22b4c1bc1c8f278d2e12236
hot1 ledger: gpu-ledger-proof:sha256:fd67f29a4b1096d5ccd2b07e7a9eac7d2f2ccf8ff273dd5023305925a44a411e
hot1 runtime proof artifact: webgpu-compute-runtime-proof:3852ebc9e362e9bd3b0f46eb4200ce1b64a7fb015c0c9cb2148aeab77114f56f
hot1 run-mode proof: runtime-run-mode-proof:a8ca6cfad9c96af677432cad38224999a2dbd1e498a71de01152f3a19ec127a9
hot1 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131945-webgpu-wgsl-runtime-compute-storage/webgpu-runtime-compute-20260625131945-webgpu-wgsl-runtime-compute-storage-proof.json
hot1 raw readback and expected hash: sha256:5b2915f7ad17941e9b1b457a6a276c362edaabb974da6af1daef06f267d77657
hot1 expected output verified: true, max_abs_delta=0
hot1 timing: total_validator_wall_time=703811600ns, dispatch_to_output_proof_time=701237300ns
hot1 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131945-webgpu-wgsl-runtime-compute-storage/webgpu-wgsl-runtime-compute-storage-compute-card.png
hot2 proof id: webgpu-runtime-compute-proof:f1a068328b522bd1bba6997d442a78e0a9e86acf1716f6e0ad76363c5c636af1
hot2 ledger: gpu-ledger-proof:sha256:ef7ce371282952c00c4f8a0a2b47039417a9aae95e44eac9034b5f8d1bc1ca8d
hot2 runtime proof artifact: webgpu-compute-runtime-proof:03c025aa0cb9293cb97f41cac61515b16a3a48835fc9ea8bf415356c34be8832
hot2 run-mode proof: runtime-run-mode-proof:5b0942f6c0be03ac75cc0cc1c3feab40cc9875cbcd563db47d34b3d253049101
hot2 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131953-webgpu-wgsl-runtime-compute-storage-hot2/webgpu-runtime-compute-20260625131953-webgpu-wgsl-runtime-compute-storage-hot2-proof.json
hot2 raw readback and expected hash: sha256:25e6442aa7b6a1c025719aaec529c2c815c3c0590618ade8607ab2e99f9ba5b5
hot2 expected output verified: true, max_abs_delta=0
hot2 timing: total_validator_wall_time=694453900ns, dispatch_to_output_proof_time=689318200ns
hot2 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131953-webgpu-wgsl-runtime-compute-storage-hot2/webgpu-wgsl-runtime-compute-storage-hot2-compute-card.png
compute-card image inspection: both WebGPU compute cards were opened with the local image tool on 2026-06-25; each card shows mapped before/after values, the raw/slice hash, and `expected output verified: true`. These cards are human-readable compute/readback evidence, not runtime frame visual proof; matrix acceptance comes from the raw readback files, recomputed ledger, native WebGPU compute API trace, and accepted strict runtime proof artifact.
matrix rows: hot1 gpu-validation-matrix-row:sha256:7cb25f5a2c8a2ea6f92d03930a083ca574def2eab057ff75381b06e4d5b7c94e, hot2 gpu-validation-matrix-row:sha256:9edb1130299142b5cbda0fb8422e01b3e19dfda321041cf79609b494ee661690
negative refusals: incompatible WebGPU compute ABI edits still reject before GPU HMR acceptance for both compute profiles.
```

Latest HIP module runtime/readback proof:

```text
profile scope: explicit-hip-module-float32-readback
runtime transport: worker container vectant-ade-worker-1, hipcc=/opt/rocm/bin/hipcc, arch=gfx1201
native API chain: hipModuleLoadData -> hipModuleGetFunction -> hipModuleLaunchKernel -> D2H readback
claim boundary: scoped_native_hip_module_runtime_trace, standalone_hip_module_probe, arbitraryTargetRuntimeAccepted=false, arbitraryLibraryAccepted=false, broadHipApplicationAcceptance=false
hot1 proof id: hip-module-runtime-proof:2028aac1716140d66e18ef8c7ea0bfd93a75d55b80c708afa04d39606217490d
hot1 ledger: gpu-ledger-proof:sha256:be4018f1fb8f4606da28ecff6bb75ea7cf65c436ac2d2ab473636d49030a9b58
hot1 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260623224644-hip-module-runtime-readback/hip-module-runtime-20260623224644-hip-module-runtime-readback-proof.json
hot1 raw readback hash: sha256:56d8a8e6c6599b9aa0d1f0ecfdf3804592e9a717ddf680c755f096c5d92ed721
hot1 expected output verified: true, max_delta=0
hot1 timing: total_validator_wall_time=6050877300ns, dispatch_to_output_proof_time=27899631ns
hot1 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260623224644-hip-module-runtime-readback/hip-module-runtime-readback-compute-card.png
hot2 proof id: hip-module-runtime-proof:3f7fcfb92f21b25f36514fe4246e97eb3161260829b4b290e71164178289be07
hot2 ledger: gpu-ledger-proof:sha256:64d2d6d06ca9e0c114102e4f63491826796cfb346baaa7fd4edc008c318d997b
hot2 proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260623224659-hip-module-runtime-readback/hip-module-runtime-20260623224659-hip-module-runtime-readback-proof.json
hot2 raw readback hash: sha256:f2eb735a90c4a5ee34cc05d6f1422d550c5610662a51762e2b4dd4f884442446
hot2 expected output verified: true, max_delta=0
hot2 timing: total_validator_wall_time=4879394000ns, dispatch_to_output_proof_time=33391718ns
hot2 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/hip-module-runtime-proof/hip-module-runtime-20260623224659-hip-module-runtime-readback/hip-module-runtime-readback-compute-card.png
compute-card image inspection: both HIP module compute cards were opened with the local image tool on 2026-06-24; each card is rendered from raw HIP readback bytes after the epoch-2 dispatch and shows `expected output verified: true`. These cards are human-readable compute/readback evidence, not runtime frame visual proof; the timing summary reports `screenshotCount=0`, `reportedVisualAccepted=false`, and `reportedComputeCardAccepted=true` for HIP module rows.
historical matrix rows: hot1 gpu-validation-matrix-row:sha256:ce03d3cdc085614c40ba8990762853a38c322a4e02283e59e607a964d3ac88b1, hot2 gpu-validation-matrix-row:sha256:f9e3130f23ddc8f0f78dde20f311c1e7defa0eccdb5172064e56a2d4b9226cdd
historical matrix coverage: hip_module_scoped_runtime_readback was accepted only because the same scoped target had hot_delta_1, hot_delta_2 with a distinct edit hash, executable ABI-negative refusal, native runtime event timestamps, epoch-2 artifact hash continuity, and compute-card-only proof separation. The current default matrix retains these as evidence only until accepted strict runtime proof artifacts are regenerated live.
negative refusal: the paired ABI-layout negative edit rejects before GPU HMR acceptance; accepted signature hash sha256:e6916d59b50b110cd3613fcc53c0eb193175d2943796f56e885ebc1dc6212093 differs from negative signature hash sha256:05bd5ef8a4acf24fc29c4c229af54b31521b4fedc37858c9f7136d0e4f7a17a5.
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

Unsupported WebGPU profiles outside the implemented explicit-empty visual scope, explicit-profiled uniform-buffer/float32-vertex-buffer visual scope, and explicit profiled storage/uniform float32 compute-readback scope, including other bind group resource kinds, unsupported vertex formats, fixed color target formats outside the preferred canvas format, non-opaque alpha mode, undeclared expected compute output, or engine-owned pipeline caches, are rejected by the runner instead of being overclaimed.

## External Project Profiles

ThreeJS WebGL shader lava now has current typed external-contract visual-profile evidence in the validation matrix. This is external runtime screenshot proof only: the matrix row is `visual_profile_accepted`, `acceptedForGpuHmr=false`, and still reports `full_runtime_gpu_hmr_ledger_not_present`.

```text
profile: threejs-webgl-shader-lava
matrix row id: gpu-validation-matrix-row:sha256:d6da40318c7faa9763cd61e7f7752273a14ea19942d91d0c295cf30b39760708
latest report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1782385221065-report.json
latest visual proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1782385220865-visual-proof.json
latest proof id: external-visual-proof:9c7199b7184421f878378da9436e6fe305c1b2c44ae86c43d80ba565fa56b7f3
latest status: pass
latest chrome GPU: enabled
latest total: 6821.7908ms
latest edit to screenshot: 2522ms
latest visual diff: 55ms
latest report changed pixel ratio: 28.3611%
latest matrix-recomputed changed pixel ratio: 29.0430%
latest mean abs delta 8-bit: 12.9131 report, 9.6848 matrix-recomputed visible pixels
artifact hashes: before sha256:d2c9aef134ada77f17c6f5023e1e0c5c83b661d2b311120836b74fa076a2e48c; after sha256:43c04a0a9362d0e455f045784d18acf68f8bc729156a2297228d1d17c5b50a1a; diff sha256:b31ae67b95fed30904b51472f2b0a6b2821139592e6f8292e9120f669481baa6
```

Visual artifacts:

```text
latest before: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1782385216661.png
latest after: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1782385219428.png
latest diff: mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1782385220742.png
```

Bevy/WGSL profile built with real Rust GNU/w64devkit toolchain but remains rejected, not accepted.

Fresh rejection artifact:

```text
profile: bevy-wgsl-shader-material
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
rejection proof id: external-rejection-proof:543387dc31d8a1a92e79c58a0dcc137a3eede776be7f0ac5f03881e5f3feaeec
rejection proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1782388085464-rejection-proof.json
profile selection: recovered from report profile id and packaged profile manifest, explicit=false, recovered=true
profile manifest hash: sha256:e19f63445753b5c85a9ef59a1f4386f160cdd5866b4722e961f3db44e03cf33e
matrix row: gpu-validation-matrix-row:sha256:1aa750bf7d71bcf2d3feff82bff564cb5e083f1ff3040af5d6bc9f00f37e8ebd
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
c333fb739 fix(gpu-hmr): recover typed external rejection contracts
6fc133653 docs(gpu-hmr): note gpu worker observer packaging
df0530b1f fix(gpu-hmr): package native observer in gpu worker
22b819fc2 docs(gpu-hmr): record typed webgpu preflight proof
fd6e1fe0a fix(gpu-hmr): emit typed webgpu preflight evidence
155376381 docs(gpu-hmr): record real rocm sidecar proof bridge
8b90f5e8c fix(gpu-hmr): bind real rocm sidecars to runtime proof
97f098769 docs(gpu-hmr): correct current saxpy proof scope
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
node --check mcp/synthi-mcp/scripts/gpu-hmr-external-project-profile.mjs
npm --prefix mcp/synthi-mcp run proof:validation-matrix:self-check
npm --prefix mcp/synthi-mcp run proof:validation-matrix
npm --prefix mcp/synthi-mcp run proof:validation-matrix:history
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
$env:SLUG='hiprt-camera-rays-strict-region-20260622'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-24 matrix status: source-adapted visual_profile_accepted only; no-shim full-runtime HIPRT acceptance remains missing

$env:SLUG='hiprt-camera-rays-runmodes-20260623-hot1'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-24 matrix status: source-adapted cold/hot visual evidence only

$env:SLUG='hiprt-camera-rays-runmodes-20260623-hot2-neg'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; $env:SYNTHI_HIPRT_WARM_METRIC_SCOPE='hot_delta_2'; $env:SYNTHI_HIPRT_WARM_DIFFERENT_EDIT='1'; $env:SYNTHI_HIPRT_WARM_EDIT_KIND='different_gpu_edit'; $env:SYNTHI_HIPRT_WARM_DELTA_AFTER='hiprtRay ray = render_data.current_camera.get_camera_ray(x_ray_point_direction, render_data.render_settings.render_resolution.y - y_ray_point_direction, render_data.render_settings.render_resolution);'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:camera-rays
  current 2026-06-24 matrix status: source-adapted hot-delta-2 visual evidence plus ABI-changing negative-edit refusal artifact; no-shim full-runtime HIPRT acceptance remains missing

$env:SLUG='hiprt-megakernel-blank-refusal-20260622'; $env:SYNTHI_HIPRT_WARM_ALLOW_REJECTED='1'; npm --prefix mcp/synthi-mcp run proof:hiprt:same-process
  current 2026-06-22 status: refused as blank oracle-region output

$env:SYNTHI_OIDN_WORKER_CONTAINER='vectant-ade-worker-1'; $env:SYNTHI_OIDN_REPO_PATH='/tmp/synthi-real-rocm/HIPRT-Path-Tracer'; $env:SYNTHI_OIDN_ALLOW_REJECTED='1'; $env:SLUG='oidn-hiprt-rocm-preflight-20260622-real-checkout'; npm --prefix mcp/synthi-mcp run proof:oidn:preflight
  current accepted status: diagnostic rejection only. Without `SYNTHI_OIDN_ALLOW_REJECTED=1`, rejected HIP output proof exits nonzero. The 2026-06-22 artifact rejected OIDN HIP due libamdhip64.so.5 dependency mismatch with no shim or symlink fallback accepted; the latest diagnostic rerun refused earlier because the worker no longer had the HIPRT checkout at the declared path.
```

Expected rejection command:

```text
SYNTHI_GPU_HMR_EXTERNAL_MCP_TRANSPORT=docker SYNTHI_GPU_HMR_EXTERNAL_SIGNALING_URL=ws://signaling-server:9000 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER=vectant-ade-mcp-1 SYNTHI_GPU_HMR_EXTERNAL_MCP_CONTAINER_ENTRY=/workspace/mcp/synthi-mcp/dist/index.js SYNTHI_GPU_HMR_EXTERNAL_MCP_REQUEST_TIMEOUT_MS=1200000 SYNTHI_GPU_HMR_EXTERNAL_MCP_ATTACH_TIMEOUT_MS=1200000 npm --prefix mcp/synthi-mcp run proof:external-project:bevy
```

## Remaining Work

| Plan Area | Current State | Remaining Work |
| --- | --- | --- |
| ROCm/HIP generated/profiled runtime | Accepted scoped full-runtime proof exists for generated/profiled device-artifact rows. | Keep rerun stability high; latest failed reruns must remain rejected. Do not present these rows as broad library-agnostic HIP acceptance. |
| ROCm/HIP module runtime | Retained HIP module-load/readback artifacts exist for hot delta 1 and hot delta 2 with a different edit, using real HSACO, native HIP module APIs, raw readback, data-derived proof cards, and ledger invariants. They are no longer counted as current full-runtime GPU HMR rows until they carry an accepted strict runtime proof artifact. | Regenerate live HIP module proof with strict `runtimeProofArtifact` once `hipcc` is available; broaden only through additional declared profiles and ABI/output-oracle evidence. Do not infer arbitrary library or framework HMR from module-boundary proof. |
| Ray-light/Flow visual MCP | Current June 25 global matrix carries row-bound visual/profile evidence for `gpu-agent-ray-light-20260625T104554-rocm-fission-evidence` and `gpu-agent-flow-20260625T103454-rocm-profile-bind`; the June 22 `embedded-ledger-10` slugs remain historical focused evidence for cold split, hot delta 1, hot delta 2 with different edit, and negative edit refusal. | Keep top-level result files as latest-run convenience outputs only and treat the global matrix as aggregate authority. |
| HIPRT | CameraRays and MegaKernel direct-light-gain are source-adapted ray-traced visual profiles classified as `visual_profile_accepted`, not no-shim full-runtime GPU HMR. MegaKernel direct-light-zero is refused as blank oracle-region output. | Prove a HIPRT path without source-adapted profile hooks before accepting `hiprt_visual_path` or `hiprt_run_modes` as GPU HMR. |
| OIDN | CPU diagnostics pass; HIP backend rejected due `libamdhip64.so.5` dependency mismatch. | Use a matching OIDN HIP build for ROCm 7 or keep OIDN out of accepted HIP proof. No shims. |
| OpenCL | Worker has `libOpenCL.so.1`, but no vendor ICD and no `clinfo`; structured preflight rejected OpenCL runtime proof. | Install/provide a real OpenCL vendor ICD and then add dispatch/event/readback ledger proof. No synthesized ICDs or shims. |
| Vulkan | Worker has `libvulkan.so.1`, but no ICD files and no `vulkaninfo`; structured preflight rejected Vulkan runtime proof. | Provide a real Vulkan ICD/tooling, then add pipeline-layout, command-buffer, frame-boundary, and visual oracle ledger proof. No synthesized ICDs or shims. |
| WebGPU | Scoped Chrome/AMD WGSL runtime visual proof accepted for explicit-empty triangle-list and explicit-profiled uniform-bind-group/float32-vertex-buffer triangle-list profiles. Scoped compute/readback proof is also accepted for the explicit storage/uniform float32 readback profile after adding strict runtime proof artifacts. | Broaden only with executed evidence for additional bind group kinds, vertex formats, compute data types, pipeline-cache ownership, command/frame traces, engine integration, and output oracles. Browser flags must remain evidence-only. |
| External projects | ThreeJS WebGL shader-lava now has typed external contract v2 visual-profile evidence with accepted PNG before/after/diff proof, but it is not full-runtime GPU HMR. Bevy remains rejected by its visual/full-runtime proof gates. | Add backend-specific same-process loader, epoch, dispatch, host-identity, and oracle proof before accepting external projects as full-runtime HMR. |
| CUDA | Not applicable to this AMD ROCm matrix; not validated here. | Validate only on CUDA hardware. |
| Narrow fission | Deterministic generated-split fission verifier accepted `trace_light_rays` and refused Flow's multi-kernel device role. | Broaden only with verifier evidence for additional backends/projects; do not infer per-kernel fission from one-file output. |
| Browser proof | Preview URLs are live; MCP screenshots exist. | In-app Browser backend was unavailable in this session. |

## Accepted Statement

```text
On the local AMD ROCm machine, Synthi can split generated ROCm/HIP GPU workloads, compile the device artifact with hipcc, hot-reload a device-only edit in a running preview/runtime, and prove scoped generated/profiled ROCm/HIP device artifacts with strict runtime-ledger acceptance.

It provides pixel-backed visual evidence for Flow, ray-light, source-adapted HIPRT CameraRays/MegaKernel visual profiles, scoped WebGPU WGSL explicit-empty and explicit-profiled visual binding profiles, and the typed ThreeJS WebGL shader-lava external visual profile. HIPRT and ThreeJS visual-profile evidence is not currently counted as no-shim full-runtime GPU HMR.

It also proves scoped WebGPU compute/readback for the explicit storage/uniform float32 profile with raw mapped GPU bytes, schema/hash verification, data-derived compute cards, and accepted strict runtime proof artifacts. HIP module compute/readback artifacts remain retained evidence until live HIP reruns can carry accepted strict runtime proof artifacts. Blank HIPRT render-region output and ABI-changing HIPRT/WebGPU/HIP-module edits are refused instead of accepted.
```

Do not claim:

```text
CUDA runtime proof was validated here.
Every arbitrary GPU project is production accepted.
Generic HIP module-load proof means arbitrary HIP libraries, frameworks, or apps are accepted without app-hook/epoch/dispatch/oracle evidence.
Any current full-runtime row proves broad library-agnostic arbitrary GPU project acceptance.
The generated ray-light MCP fixture is HIPRT/OIDN.
HIPRT has no-shim strict-matrix full-runtime acceptance; current HIPRT proof is source-adapted visual-profile evidence only.
OIDN HIP produced or validated the accepted output.
OpenCL dispatch/readback output proof was validated on this worker.
Vulkan pipeline/command-buffer/frame output proof was validated on this worker.
General WebGPU bind-group kinds, vertex formats, engine-cache, compute beyond the explicit storage/uniform float32 readback profile, or arbitrary app shader HMR was validated on this worker.
A one-file generated .hip split proves per-kernel or smallest-island fission without deterministic verifier evidence.
Flow's one-file generated .hip split proves per-kernel or smallest-island fission.
Bevy has full-runtime proof-ledger acceptance.
```
