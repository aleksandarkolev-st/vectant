# GPU HMR Investor Demo Status

Updated: 2026-06-30

## Demo Position

Safe investor-demo claim:

```text
On the local AMD ROCm machine, Synthi can hot-reload scoped/profiled GPU device-artifact edits, keep the runtime alive, and prove changed output with strict runtime-ledger evidence. Visual profiles use pixel-backed before/after/diff frame artifacts; compute/readback profiles use raw mapped GPU bytes plus data-derived compute cards, and those cards are not runtime frame visual proof.
```

Dev-loop demo note:

```text
The MCP wait path can now distinguish interactive HMR from proof closure. A non-strict `synthi_wait_hmr` call may report `applied` with `proof_pending=true` and `gpu_hmr_dev_loop.evidence_authority=hmr_fast_path_only_not_gpu_hmr_acceptance`. This is useful for showing responsive editing, but it is not an investor-grade proof claim; strict demo proof still requires the accepted runtime ledger and proof artifacts.

Strict `synthi_wait_hmr` calls can now fail closed faster after HMR applies when the observed proof slice is structurally unable to satisfy the requested proof state. The response remains `gpu_hmr_proof_insufficient` and carries refusal-only `gpu_proof_wait` / `proof_wait_timeout_intelligence` fields; it is not a success path and does not weaken ledger acceptance.

The artifact path is also moving toward the same split: CAS locators can now be consumed portably by content hash under a consumer-local allowed CAS root, so worker/MCP/frontend layers do not need to pass producer-local absolute paths through the hot path. The matrix now validates visual CAS locators by readable bytes and SHA-256 before using them as visual evidence, including CAS-only before/after/diff PNG decoding. This is transport/oracle-byte validation only, not proof acceptance.

The visual proof runner now schedules multiple candidate post-HMR frame comparisons through bounded concurrent worker-thread visual proof tasks instead of serially awaiting each candidate. This improves the validation hot path for visual demos, while the recorded scheduling facet remains support-only and cannot authorize GPU HMR without strict ledger closure.

The validation matrix now consumes async visual-worker metrics for before/after visual-pair recompute instead of repeating the full pair RGBA diff inside the matrix process. Worker timeout/failure, zero-delta, blank-frame, dimension-mismatch, and blank-diff cases still refuse; this is proof throughput work, not a broader acceptance claim.

Cold/single-frame visual evidence and diff-frame visibility recomputation are now worker-backed as well. The matrix records `recomputeEngine=matrix_async_visual_worker_rgba` for recomputed single-frame evidence and smoke tests assert off-main-thread worker identity. This keeps the remaining cold visual proof pixel path out of the matrix process while preserving the same fail-closed acceptance gates.

Visual proof scheduling now has an explicit proof-pending phase. The agent-split visual runner can stage before/after frames into CAS, record a content-addressed `synthi.gpu_hmr.async_visual_proof_job.v1` manifest with `eventType=proof_pending`, and then complete that job through the existing async visual worker. Pending jobs are useful for responsive dev-loop reporting, but they are not accepted proof; strict demos still require `proof_ready` worker metrics plus runtime-ledger closure.

The async visual/CAS support gate is now stricter: matrix recompute prefers validated CAS locators as the worker's before/after replay inputs and requires `workerCasInputAccepted=true` before `asyncVisualCasBundle` can accept. Direct paths or serialized image bytes can still be used for diagnostic fallback, but they fail optimized shared-CAS support with `async_visual_worker_cas_input_missing` and do not count as transport-optimized proof support.

The async visual worker proof is also now bound to the native image backend and incremental visual evidence. The worker executable identity includes a native dependency manifest for the `sharp`/libvips decode/diff backend, and ROI/tile proof carries typed binding hashes tied to encoded frame hashes, raw frame hashes, dimensions, tile-list hashes, ROI hashes, and optional deterministic visual-mode hash. This improves trust in asynchronous/incremental visual validation, but it remains support evidence only; strict runtime-ledger closure is still the acceptance authority.

Large real ROCm source-tree transport now records generic source-tree CAS/integrity evidence for serious projects. The latest retained MIOpen rerun used the shared `/var/lib/synthi/artifact-cas` mount and recorded `transferOperation=cas_shared_volume`, `hotPathOptimized=true`, and no source-transport gaps. The runner can derive the compose-default shared CAS root without per-target hardcoding, while explicit env overrides remain available for other deployments. This improves source-tree transport, but it still cannot satisfy runtime, dispatch, epoch, host-identity, app-hook, or output-oracle proof.

The newest retained MIOpen rerun, `gpu-real-rocm-MIOpen-20260629163046`, is still a refusal. It proves the shared-CAS source transport path, recovered upstream metadata, source-delta compile projections for hot delta 1, hot delta 2, and negative edit, external-header prerequisite materialization, generic runtime-adapter execution, adapter-result transport, and 4 native runtime boundary lines. GPU HMR remains refused because app-hook runtime observation, epoch publication, dispatch trace, host identity, output oracle, firewall evidence, and strict runtime proof closure are still missing. No frame-gated MIOpen visual proof is claimed for that compute/upstream-lifecycle profile.

The validation matrix now carries that external-header prerequisite evidence as a first-class real ROCm facet rather than report-only context. Accepted dependency evidence can coexist with a later accepted runtime row, but it cannot authorize one: forged aggregate or child records that claim GPU HMR, runtime, or dispatch authority are rejected, and accepted-row safety rejects a bad prerequisite facet on an otherwise accepted row.

Generic runtime-adapter execution is now available for real ROCm profiles as an arbitrary-project evidence path. A profile/env `runtimeAdapter` command runs inside the worker, can emit runtime-boundary and app-hook material, and is recorded as `synthi.real_rocm.runtime_adapter_execution.v1`. This is the right direction for large application/framework integration, but it remains non-authoritative support evidence: it cannot pass a demo proof without observed artifact transport, epoch publication, dispatch trace, host identity, output oracle, firewall proof, and strict runtime proof closure.

Runtime-adapter execution output is now normalized into the same runtime evidence stream as worker logs. The execution facet preserves captured `[gpu-runtime-boundary]` lines explicitly, and runtime collection merges them before the existing classifiers run. This makes the arbitrary-project adapter path less brittle without accepting an adapter declaration or log line as proof.

Runtime-adapter output-oracle lines can now point at shared/file-backed compute proof artifacts instead of forcing raw bytes through logs. A generic adapter can declare raw readback bytes, readback schema JSON, a rendered proof-card PNG, hashes, checksums, and deterministic slice identity, either as direct paths under approved artifact roots or as `synthi.cas.artifact_locator.v1` manifest paths. The runner validates CAS locators with readable-byte SHA-256 checks, realpath-checks direct paths against allowed roots, maps accepted paths into the existing compute-oracle artifact shape, and the shared verifier rereads the files before any proof gate can pass. Forged declared readback hashes and path escapes are covered by self-check refusals. This supports the CAS/shared-volume direction for arbitrary projects, but it is still not a demo pass without epoch, dispatch, host identity, firewall, and strict ledger closure.

The validation matrix now applies the same CAS discipline to compute-oracle artifact integrity. Raw readback, schema, and rendered proof-card artifacts can carry role-bound CAS locators, the matrix verifies readable bytes and hashes before recomputing file integrity, and a forged role-specific locator refuses instead of falling back to a convenient direct path. Strict proof-ledger recomputation can also evaluate CAS-only compute ledgers through a resolved artifact overlay without mutating the canonical proof record or proof ID. This closes another transport bottleneck in the proof path while preserving the demo boundary: CAS-backed/CAS-only compute artifacts are transport and file-integrity support evidence, not full-runtime HMR proof by themselves.

Runtime-adapter scheduling is generic as well: `runtimeAdapter.runWhen` can target upstream-run, configure-success, build-attempt, or lifecycle-attempt phases without project-name branches. Supplied or adapter-imported app-hook contracts remove only stale declaration gaps; the runtime still has to prove every stage before any full-runtime row can pass.

The packaged MIOpen, Composable Kernel, and hipBLASLt large-ML profiles now opt into the same built-in `runtime_boundary_log_harvest_v1` adapter template. That template runs inside the worker, harvests real runtime-boundary lines only if the upstream lifecycle naturally emits them, writes those exact lines into the refusal-only adapter result manifest, and keeps the same lines available for direct execution evidence. Package smoke coverage rejects profile-local inline adapter shell commands, unsafe result paths, unknown templates, unsafe profile IDs, and any success-authority flags in those profile declarations. This makes the large-project adapter path easier to rerun and audit without hardcoding a repo branch or relying only on retained logs, but it is still support evidence only and cannot pass the investor demo without strict ledger closure.

Runtime-adapter execution and adapter-result transport now retain adapter template identity and a content-addressed adapter command hash through matrix ingestion. Imported adapter results are also bound to the exact strict runtime proof artifact and recomputed proof ledger used by the row; a replayed result with mismatched proof IDs is refused even if every other strict large-ROCm gate is satisfied. That gives a reviewer a concrete way to audit which generic adapter produced a boundary line or copied result file and whether it belongs to the row being accepted. It remains non-authoritative metadata: template identity, command hash, and copied result transport do not prove artifact transport, epoch publication, dispatch, host identity, output oracle, firewall, or strict runtime proof closure.

Native ROCm observer evidence now has a clearer diagnostic shape for serious projects. Function-resolution, launch-attempt, launch-observed, runtime-session, and observer-ready lines can surface `dispatch_trace` and `host_identity` stage candidates in the large-ROCm report, but those rows explicitly keep `runtimeObserved=false`, keep their required proof kinds missing, and remain `candidate_native_boundary_evidence_only_not_runtime_proof`. This helps explain what was seen in a MIOpen/CK/hipBLASLt attempt without turning native observer facts into artifact transport, epoch publication, output oracle, or accepted GPU HMR proof.

Complete runtime-adapter stage events can now derive the generic app-hook contract for large real ROCm rows when no explicit app-hook contract was supplied. The matrix recomputes this from the five stage-event records, facet hash, boundary-line hashes, and evidence refs, and refuses a serialized derived contract if the matching stage events are absent or forged. This removes a manual declaration gap for arbitrary-project adapters, but it is still not demo success without strict runtime proof, ledger, runtime chain, output oracle, same-process identity, firewall, and sidecar closure.

Imported adapter-result manifests no longer have to be paired with a direct execution facet when the bridge is already strict-proof accepted or boundary-import accepted, the five stage events are complete, target-process provenance is accepted, and any declared result transport is accepted. This helps external/profile-driven arbitrary-project adapters report boundary evidence through a manifest path, while a failed execution facet, forged bridge, bad transport, missing provenance, or incomplete stage evidence still blocks demo acceptance.

The matrix runtime-chain overlay now uses the same boundary-only manifest path. A support-only adapter-result facet with `acceptedAsBoundaryEvidence=true` can contribute overlay fields even when the facet is not strict-result accepted, and smoke coverage proves this still works after every adapter-execution facet is removed from the fixture. The adapter result itself remains `acceptedForGpuHmr=false`.

Realistic HIPRT evidence is now stricter in the matrix. HIPRT warm visual and run-mode rows must carry a complete, field-evidenced `hiprt_contract` for kernel entry, scene/BVH handles, framebuffer, material or geometry buffers, camera-state hash, same-process reload hook, and visual oracle before they can remain visual-profile evidence. This makes the CameraRays and MegaKernel direct-light-gain demos easier to audit, but it does not turn them into no-shim full-runtime HMR: source-adapted profile hooks still force `acceptedForGpuHmr=false`.

The matrix smoke suite now includes generic adapter-boundary bridge fixtures for serious ROCm projects. Accepted adapter boundary lines are preserved from both imported adapter-result manifests and direct runtime-adapter execution logs as a runtime-chain overlay, so they can complete missing observed boundary fields while still refusing ledger/adapter conflicts. The real ROCm runner now exports a worker-side adapter result path for configured commands and copies that result back to the repo-bound host path before bridge import. The validation matrix independently audits that `synthi.real_rocm.runtime_adapter_result_transport.v1` facet as transport-only evidence, requires a copied file hash/byte-length/evidence refs, and rejects forged transport records that claim GPU HMR success or runtime/dispatch authority. The complete fixture feeds all five app-hook stages through project-neutral boundary evidence and accepts only when the strict ledger, same-process oracle, app-hook, sidecar, output-oracle, firewall, runtime-chain, and runtime-proof gates already close. The paired negative keeps the strict ledger successful but lies about direct runtime-adapter execution's output oracle `after_dispatch_id` and forges transport authority, and the matrix refuses it with `real_rocm_runtime_chain_adapter_output_dispatch_mismatch` plus transport-authority gaps. That is the correct next bridge for arbitrary projects: it can expose real runtime material without converting declarations, command success, copied result files, or result transport into GPU HMR success.

The fresh MIOpen runtime-adapter-check attempt, `gpu-real-rocm-MIOpen-20260629-runtime-adapter-check`, reinforces the boundary. The sandboxed retained report failed closed before Docker/container evidence with `runtimeAdapterDeclared=false`, `runtimeAdapterExecution=null`, and `gpuHmrSuccess=false`. The approved unsandboxed rerun reached real MIOpen configure/build and progressed deep into native compilation, but the host validator timed out before proof collection could close; the detached build was stopped and no strict runtime ledger, output oracle, or visual/readback proof was produced. This is serious-project progress, not a passed HMR demo and not a claim that MIOpen executed a runtime adapter.

Source-first/no-precompiled proof now requires exact seed-manifest purity evidence and generic local include-closure preservation. Every submitted initial file must be scanned for Synthi ABI markers, the projected purity manifest must equal the initial compile manifest, and stale source-first rows without that evidence are refused by the matrix. The fresh realistic source-first rerun `source-first-cold-cas-realistic-20260629` started from `src/main.cpp` plus `src/scene_config.h`, preserved header-defined constants through generic quoted-include closure, selected worker-detected ROCm arch `gfx1201`, produced accepted strict visual HMR hot-delta rows, and still keeps the claim scoped to the generated/profiled visual path.

Real ROCm diagnostic screenshots are now explicitly separated from runtime visual proof. A readable/nonblank screenshot may still be retained as diagnostic evidence, but if it is not frame-gated after an epoch dispatch it is marked supplemental and excluded from runtime visual-proof counts, proof summaries, target-progression accepted visual counts, and matrix small-oracle visual fallback.
```

Best demo surfaces:

1. ROCm/HIP realistic raytrace preview: deterministic generated visual workload with a faceted diamond scene, smaller stones, wall/awning geometry, glossy car geometry, slab lighting, hot delta 1, hot delta 2 with a different edit, negative edit refusal, image-tool-inspected before/after/diff PNGs, and strict runtime-ledger artifacts.
2. ROCm/HIP MCP ray-light preview: strongest compact Synthi app preview proof and deterministic per-kernel fission evidence for `trace_light_rays`.
3. ROCm/HIP MCP Flow preview: second generated visual workload, proving this is not a one-case path.
4. Deterministic generated-split fission verifier for realistic raytrace and ray-light kernels: proof-only rows, not replacements for runtime-ledger acceptance.
5. Historical ThreeJS WebGL external profile: concrete external runtime screenshot proof retained as historical visual-profile evidence, not current default-matrix authority and not full ledger acceptance.
6. WebGPU Chrome/AMD scoped WGSL runtime visual proof: shader-module/pipeline/frame proof for explicit-empty and explicit-profiled uniform-bind-group/float32-vertex-buffer profiles with cold/hot1/hot2-different-edit/negative run-mode coverage.
7. WebGPU Chrome/AMD scoped WGSL compute/readback proof: native compute pipeline, mapped raw GPU bytes, profile-declared expected-output verification, data-derived PNG proof cards, hot1/hot2-different-edit coverage, and negative ABI refusals.
8. ROCm/HIP module runtime proof: real `.hip` to HSACO, native `hipModuleLoadData`/`hipModuleGetFunction`/`hipModuleLaunchKernel`, raw D2H readback, data-derived PNG compute proof cards, hot1/hot2-different-edit coverage, and ABI refusal.
9. Generated/profiled ROCm/HIP compute ledger: scoped full-runtime proof artifact and output-oracle readback, not broad arbitrary HIP library acceptance.
10. Vulkan host-local scoped pipeline/readback visual proof: real Vulkan instance/device/queue, shader modules, pipeline layouts, compute pipelines, command buffers, queue submit/fence wait, epoch-1 output before epoch-2 load/publish/dispatch/output, and nonblank before/after/diff PNG readback artifacts. Useful as scoped Vulkan backend proof, not arbitrary Vulkan engine/cache acceptance.
11. HIPRT same-process CameraRays: source-adapted ray-traced visual-profile proof with embedded ledger/runtime artifact and nonblank oracle-region evidence; useful visual evidence, not no-shim full-runtime GPU HMR acceptance.
12. HIPRT same-process MegaKernel direct-light-gain: second source-adapted ray-traced visual-profile proof on a different HIPRT kernel path, with image-tool-inspected before/after/diff artifacts; useful visual evidence, not no-shim full-runtime GPU HMR acceptance.
13. HIPRT MegaKernel direct-light-zero: useful adversarial visual refusal proving blank render-region output is not accepted.
14. MIOpen large ROCm ML infrastructure profile: useful serious-project refusal proving the harness can attempt upstream MIOpen and still refuse when configure/build, app-hook, epoch, dispatch, host-identity, and output-oracle proof are missing.
15. ROCm examples matrix multiplication profile: useful real ROCm compute refusal proving source-derived output-oracle generation and worker sync do not count as GPU HMR without Synthi epoch, dispatch, host identity, and post-dispatch output observation.
16. Composable Kernel large ROCm ML infrastructure profile: useful serious-project refusal proving the harness can clone and classify a large HIP/C++ template ML repo and still refuse without target binary, app-hook, epoch, dispatch, host identity, and output-oracle proof.
17. hipBLASLt fused GEMM/GELU/AUX/bias large ROCm ML infrastructure profile: useful serious-project refusal proving the harness can clone, transfer, and classify a real ROCm ML library/sample path and still refuse without build dependencies, app-hook, epoch, dispatch, host identity, and output-oracle proof.

Do not claim:

```text
CUDA was proven on this AMD GPU.
Every arbitrary GPU project is production accepted.
HIP module-load proof means arbitrary HIP libraries/frameworks/apps pass without app-hook, epoch, dispatch, host-identity, and output-oracle proof.
MIOpen large ML full-runtime HMR passed.
ROCm examples matrix multiplication full-runtime HMR passed.
Composable Kernel large ML full-runtime HMR passed.
hipBLASLt large ML full-runtime HMR passed.
Bevy or broad/general WebGPU has full-runtime proof-ledger acceptance.
HIPRT is accepted as no-shim full-runtime GPU HMR; current HIPRT artifacts are source-adapted visual-profile evidence only.
OIDN HIP produced or validated the accepted visual output.
OpenCL dispatch/readback output proof was validated on this worker.
Vulkan pipeline/command-buffer/frame output proof was validated on this worker.
Scoped host-local Vulkan proof means arbitrary Vulkan projects or engines pass without their own app/runtime proof.
General WebGPU bind-group kinds, vertex formats, engine-cache, compute beyond the explicit storage/uniform float32 readback profile, or arbitrary app shader HMR was validated on this worker.
One generated `.hip` file proves per-kernel or smallest-safe fission without deterministic verifier evidence.
Flow's generated `.hip` file proves per-kernel or smallest-safe fission.
Any proof succeeded because of a shim or hardcoded scenario path.
```

Current June 30 proof snapshot:

```text
latest global matrix after the scoped Vulkan host-runtime proof, scoped OpenCL host-runtime proof, runtime-boundary event-manifest materializer, and large-ROCm MIOpen bounded refusal rerun: gpu-validation-matrix-ledger:sha256:e9ee4aaa7c6386b325780c2ddc0261df7e42337c3e9c1ac6b3b9b0c6ac634bd2
latest global matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T133648Z.json
latest global matrix summary: 63 rows, 17 accepted full-runtime GPU HMR, 17 broad library-agnostic full-runtime GPU HMR rows by matrix-computed proof, 0 scoped full-runtime GPU HMR rows after broad matrix classification, 17 all full-runtime rows, 33 refusals, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row, 0 included unproven rows
latest global matrix scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, opencl_declared_compute_readback: 2, vulkan_declared_pipeline_visual: 1, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
current accepted strict backend families: HIP, OpenCL, Vulkan, WebGPU
current OpenCL full-runtime rows: hot_delta_1=gpu-validation-matrix-row:sha256:4943d7b099075a431f37236b184ad7dfbac131d385dae48eb6ed99731f1b5773, hot_delta_2=gpu-validation-matrix-row:sha256:d5e45d4eb8952ca30a1fbc882ea02b491581783f66f3fbd566de71f07959ca84
current Vulkan full-runtime row: gpu-validation-matrix-row:sha256:c0e9f8d1509334ae80200ee736df5050e585e12bb11ae7a8fd951248893342e8, proof=vulkan-runtime-proof:sha256:de768ddd560863deac94f7740adf55af5a3fb59e730c9e0109fd383135bc8e84, runtime_artifact=vulkan-runtime-proof-artifact:62fbf87f8551fdce10a33595c8c5a76d42683ac3522676a942c7f1a5c4a94134, ledger=gpu-ledger-proof:sha256:599ef0607b62dab245d7b29b9dae68ed6a30733520bb8aaaff7a54371ae03fb1
latest broad readiness: accepted=true, authority=matrix_computed_not_row_declared, broad proof=gpu-hmr-broad-library-agnostic-proof:sha256:ceecc271c663a3d21619119e1c80eb171f317dabe4deebc6d837c40ef65a7ea3
claim boundary: matrix-level broad readiness is accepted across strict rows and adversarial refusals, but arbitrary target/project acceptance still requires per-project loader, epoch, dispatch, host-identity, output-oracle, firewall, and strict proof-ledger closure
latest MIOpen bounded rerun: gpu-real-rocm-MIOpen-20260630132711, strict runtime proof gpu-runtime-proof:sha256:fc7ae97d93b58e06f034a97b7d8f44037d1da8ed16f22bed499a3e249b25e02a, retained as refusal-only serious-project evidence with no artifact transport, epoch, dispatch, host identity, output oracle, firewall, event-manifest boundary lines, or strict runtime closure
large ROCm lifecycle classifier hardening: wrapper-owned lifecycle status lines are the only recovered status authority, post-configure failures now have explicit refusal reasons, project-log status spoofing is refused, and the follow-up timed MIOpen attempt produced no retained proof artifact or success claim
large ROCm matrix recompute hardening: retained lifecycle timing/log-tail bytes are now recomputed by the validation matrix so stale serialized configure/build/run failure reasons cannot survive aggregate ingestion; this remains refusal-only diagnostics, not runtime proof
global matrix: gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787
previous pre-OpenCL/Vulkan baseline matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
previous pre-OpenCL/Vulkan baseline matrix summary: 56 rows, 14 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 14 scoped full-runtime GPU HMR, 14 all full-runtime rows, 29 refusals, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row, 0 included unproven rows
previous pre-OpenCL/Vulkan baseline scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
MIOpen row after the source-first closure and large-ROCm runtime-adapter refresh: historical-gpu-validation-matrix-row-sha256-16305e7aef533eb74ffd73e8fdda199da25aef72e27be2fbb6710b632d32b235, outcome=refusal_proven, source-tree CAS/source-delta/external-header/runtime-adapter evidence only, acceptedForGpuHmr=false
historical source-first/adapter hardening matrix before OpenCL and Vulkan host proofs: gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787, path=mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json, summary=56 rows, 14 accepted full-runtime GPU HMR, 0 broad rows
Broad-readiness scaffold current note: the matrix carries a recomputed `synthi.gpu_hmr.broad_library_agnostic_matrix_proof.v1` proof object. It now accepts only because the current matrix includes strict full-runtime HIP, OpenCL, Vulkan, and WebGPU rows plus visual/compute oracle coverage and adversarial refusals; row-declared broad claims still cannot authorize broad acceptance.
latest OIDN declared-checkout split: OIDN HIP runtime preflight coverage is still missing, OIDN HIP output proof is refused, and the newest live row is historical-gpu-validation-matrix-row-sha256-88edda748c10b7da1a009ccc5b2a0516a4109e95116fafaf06ff913bd2ae0496 for `oidn-hiprt-rocm-preflight-20260626-after-apphook-refresh`
history audit matrix: gpu-validation-matrix-ledger:sha256:aa905942109909b5181c6236cb348a68710ebc667ac8f8dde7d572385c7e349c
history audit path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix-unproven-audit/gpu-hmr-validation-matrix-20260629T113226Z.json
history audit summary: 678 rows, including 622 historical unproven rows; query accepted because unproven rows stay non-success and carry missing-proof/refusal gaps; 14 accepted full-runtime GPU HMR, 0 broad library-agnostic full-runtime GPU HMR, 14 scoped full-runtime GPU HMR, 14 all full-runtime rows, 29 refusals, 7 cold splits, 2 deterministic fission, 3 visual profiles, 1 preflight-only row
history audit scope breakdown: generated_rocm_hip_preview_visual: 2, hip_module_declared_compute_readback: 2, webgpu_declared_compute_readback: 2, webgpu_declared_pipeline_visual: 8
negative/refusal gate note: negative-edit refusal rows now require structural typed evidence, a content-addressed edit hash, accepted run-mode evidence, explicit CPU/full-rebuild/restart firewall proof, and a typed blocker. Reasons-only or false-only rows are treated as unproven/non-success and are not counted in the default included set.
hardware scope note: `cuda_runtime` is `not_applicable` in this local matrix because the observed hardware evidence is ROCm/AMD (`hip`, `hiprt`, `oidn_hip`) and there are no CUDA rows. This is not CUDA proof.
timing summary: mcp/synthi-mcp/.gpu-hmr-test-logs/timing-metrics/gpu-hmr-timing-metrics-20260624T093916Z.json, count=21; timing metrics are telemetry only, evidenceAuthority=timing_telemetry_only, proofVerdict=not_evaluated_by_timing_summary
Bevy typed external refusal: external-rejection-proof:543387dc31d8a1a92e79c58a0dcc137a3eede776be7f0ac5f03881e5f3feaeec, row=historical-gpu-validation-matrix-row-sha256-b1132a777685310f5feef00547a6c714ac8ed1901cc7412e3a0bd3b7f09f2fce, profile selection recovered from packaged manifest with explicit=false/recovered=true; still not full-runtime GPU HMR
Large ROCm per-target coverage entries: large_real_rocm_repo:real-rocm-composable-kernel-gemm-large-ml=refused, large_real_rocm_repo:real-rocm-hipblaslt-gelu-aux-bias-large-ml=refused, large_real_rocm_repo:real-rocm-matrix-multiplication=refused, large_real_rocm_repo:real-rocm-miopen-activation-large-ml=refused
per_target_run_modes status=accepted
per_target_run_modes open gap: none
global per-target run modes: accepted for the enrolled scoped targets in the current global matrix. The source-first realistic HIP target now has cold split, hot delta 1, hot delta 2 with a different edit, and negative-edit refusal evidence, including a CAS-backed readable cold visual frame. This is scoped run-mode coverage, not broad arbitrary GPU project acceptance. SAXPY is not a current accepted full-runtime row in the latest default matrix; historical SAXPY rows remain unproven/not-full-runtime in the history audit.
HIP module scoped run modes: accepted for `hip-module-runtime-readback` as scoped module-load/readback evidence, with hot_delta_1, hot_delta_2 different edit, executable ABI-negative refusal, epoch-2 artifact hash continuity, raw D2H readback, compute-card-only proof separation, and accepted strict runtime proof artifacts. The probe implementation packs launch arguments from declared ABI params, typed buffers, typed scalar values, and extracted before/after source signatures, and self-checks a second uint32/reordered declared profile. This is not a broad HIP app/library claim, not a blanket HIP application claim, and not framework-wide HIP HMR.
Broad library-agnostic full-runtime rows: 17 by matrix-computed proof across strict HIP, OpenCL, Vulkan, and WebGPU rows plus adversarial refusals. This broad-readiness proof is not a production acceptance shortcut for arbitrary projects; each target still needs its own loader, epoch, dispatch, host-identity, output-oracle, firewall, and strict proof-ledger closure. HIPRT source-adapted visual profiles are not counted as no-shim full-runtime GPU HMR.
Full-runtime evidence authority: accepted rows must carry a strict runtime proof artifact. Backend-native recomputed ledger traces remain supporting evidence only and cannot authorize GPU HMR success by themselves.
No-shim audit fixes: source-derived real ROCm output-oracle instrumentation is marked as source adaptation, HIPRT real-ROCm probing is explicit env/profile config instead of target-name routing, real-ROCm profile obligations are recomputed by the matrix from raw profile/target-progression evidence, and retained target-progression ledger entries rederive mandatory proof gates before they can report pass.
Real ROCm profile selection gate: unqualified real ROCm runner invocations now fail closed unless `SYNTHI_REAL_ROCM_PROFILE_PATH` or `SYNTHI_REAL_ROCM_PROFILE_JSON` is supplied. The packaged SAXPY default is only allowed for explicit diagnostic/default-profile runs via `SYNTHI_REAL_ROCM_ALLOW_DEFAULT_PROFILE=1` or `--self-check`, and `proof:real-rocm:warm` now passes its profile path explicitly.
Real ROCm final-acceptance oracle gate: `outputOracle.profile=auto` is no longer allowed to source-instrument final-acceptance rows. Final-acceptance rows must use explicit runtime-oracle profile evidence or remain refused; refusal-only profiles may still record disabled/diagnostic oracle state without becoming acceptance.
Real ROCm backend inference gate: HIPRT backend candidates now require explicit backend/API evidence such as a typed `hiprt` backend setting or HIPRT API coverage. Name-shaped strings such as `HIPRTOrochiCtx` no longer infer HIPRT by themselves.
Same-process runtime-oracle gate: real ROCm rows that claim runtime proof must now prove either a complete native runtime bridge for rows where app hooks are not required, or a generic app-hook/runtime contract plus artifact transport, epoch publication, dispatch using the published epoch, stable process identity, dispatch/output-oracle target continuity, post-dispatch output observation, artifact/epoch hash continuity, explicit CPU/full-rebuild/restart firewall evidence, and closure to the row's recomputed proof ledger, runtime chain, strict runtime proof artifact, output-oracle facet, and same-row evidence refs. A native bridge alone is insufficient when the profile/native-boundary gate requires an app hook. Forged `accepted=true` facets are rejected for wrong schema, missing stage booleans, mismatched output target, firewall violations, missing strict runtime proof artifact, missing closure refs, mutated runtime-chain/output target evidence, and serialized blocking gaps.
Runtime-adapter boundary import hardening: boundary-only adapter result manifests can now feed generic runtime boundary lines only when matrix-recomputed coverage contains all five stages: `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle`. The matrix does not trust serialized `acceptedAsBoundaryEvidence=true` or empty boundary gaps; a partial boundary bridge remains unproven, and the bridge still cannot authorize GPU HMR without a separately accepted strict runtime proof artifact, recomputed ledger, runtime chain, output oracle, firewall, and same-process proof.
Runtime-adapter lifecycle finalizer: declared `runWhen=after_lifecycle_attempt` adapters now execute from the finalizer before runtime evidence collection when the normal lifecycle path exits early and no execution facet exists. This preserves fail-closed adapter/result/event-manifest evidence for large ROCm attempts, but the execution facet and copied manifests remain support-only and cannot authorize GPU HMR without strict runtime-ledger closure.
Runtime-boundary event-manifest materializer: observed `[gpu-runtime-boundary]` lines in the upstream run log can now be written to the declared event-manifest path as a support-only `synthi.gpu_hmr.runtime_boundary_event_manifest.v1` artifact. The materializer records exact lines, hashes, and missing-stage gaps; it does not fabricate a manifest when no boundary lines exist. Fresh bounded MIOpen run `gpu-real-rocm-MIOpen-20260630132711` correctly stayed refused with zero materialized lines and no event-manifest transport.
Real ROCm app-hook stage gate: app-hook contract facets must prove the generic `artifact_transport`, `epoch_publication`, `dispatch_trace`, `host_identity`, and `output_oracle` stages with resolved evidence refs plus runtime observations. A serialized `canSatisfyRuntimeProof=true` field cannot authorize acceptance by itself.
Generic real ROCm app-hook/oracle input: `SYNTHI_REAL_ROCM_OUTPUT_ORACLE_RUNTIME_PROFILE_JSON`, `SYNTHI_REAL_ROCM_APP_HOOK_CONTRACT_JSON`, and `SYNTHI_REAL_ROCM_DEVICE_SIDECAR_CONTRACT_JSON` are now validated JSON-object contract inputs and recorded in command metadata/source fields. They let arbitrary large projects declare runtime oracle and app-hook contracts without project-name branches, but they do not authorize GPU HMR success unless collected runtime evidence proves every required stage.
Large ROCm ML target-class gate: final-acceptance rows with `targetClass=large_rocm_ml_infrastructure` now require an app-hook contract from generic target-class/profile evidence even when an individual profile omits an explicit flag. This remains a refusal gate until runtime app-hook evidence is collected.
Agent-split visual profile runner: `SYNTHI_GPU_AGENT_PROFILE_PATH` now accepts a typed `synthi.gpu_hmr.agent_split_visual_profile.v1` profile with source path/inline/fixture, entry path, resolution, profile identity/hash, source content hash, deterministic-mode hash, visual-proof threshold hash, optional visual-scene manifest hash, and declared hot-delta edits that must match exactly one source occurrence when `requireDeclaredEdits=true`. Source hash, deterministic-mode hash, visual-proof hash, and supplied scene-manifest hash must bind to row evidence refs, declared hash mismatches are rejected, and profile visual thresholds can only tighten the baseline visual-diff gate. The source-first path is now exposed through `proof:agent-split:source-first`, `proof:agent-split:source-first:self-check`, `proof:agent-split:source-first:seed-only`, and `proof:agent-split:source-first:realistic-raytrace`; the live runner refuses generated artifacts outside the generated namespace before it emits accepted provenance-only evidence. This supports realistic raytrace-style demos through profile evidence rather than target-name or scenario hardcoding.
Source-first visual coverage now additionally requires support-only `asyncVisualCasBundle` evidence: off-main-thread `proof_ready` async visual metrics, a worker executable hash, bound native image dependency identity, typed tile/ROI incremental evidence binding, CAS/shared-volume before/after/diff locators validated by the matrix, workerCasInputAccepted=true for the worker's before/after replay inputs, and CAS hashes matching the recomputed image hashes. This support facet is explicitly `acceptedForGpuHmr=false` and cannot authorize GPU HMR without the strict runtime ledger. Direct local paths, serialized bytes, or unvalidated locators remain diagnostic fallback only and fail optimized async/CAS support with `async_visual_worker_cas_input_missing`.
Source-first multi-file profile note: the packaged realistic raytrace profile now declares `src/main.cpp` plus `src/scene_config.h` with explicit sha256 hashes and passes the source-first profile self-check. The latest live two-file realistic rerun `source-first-cold-cas-realistic-20260629` seeded that source tree, attached MCP, preserved local quoted-include constants through the deterministic splitter, produced CAS-backed cold visual evidence plus strict hot-delta visual proof, and is included in the current matrix authority `gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787`. Earlier provider-failure reruns remain historical infrastructure blocker evidence only.
Source-first seed-only user-path check: `npm --prefix mcp/synthi-mcp run proof:agent-split:source-first:seed-only` seeded `http://localhost:3000/workspace/gpu-agent-split-1782741683475` from source without a precompiled project. This is a user entry-point check only; it is not GPU HMR acceptance and still requires AI split, runtime load, epoch publication, visual proof, output oracle, and strict ledger closure.
Real ROCm proof scheduling: upstream lifecycle blockers that prove runtime stages are absent can now skip async runtime waits and emit `proof_scheduling_skipped_async_runtime_wait` with `skip_async_runtime_waits=true`. This is a validator-wall-time optimization only: the facet remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`, and the matrix rejects skip claims without both fast-fail scheduling and `proof_scheduling_upstream_lifecycle_runtime_absent`.
Real ROCm app-hook materialization: large real ROCm rows now expose a plan-only `real_rocm_app_hook_materialization` facet showing whether source-delta execution, device-sidecar candidates, compile-bridge evidence, output-oracle materialization, and the five app-hook stages are authoring-ready. This is useful for showing the next integration step for MIOpen/CK/hipBLASLt-style projects, but it remains `acceptedForGpuHmr=false`, `gpuHmrSuccess=false`, and `canSatisfyRuntimeProof=false`; forged materialization success/runtime-authority flags are rejected by the matrix.
Real ROCm missing-dependency probe: large real ROCm retained reports now preserve a generic `synthi.real_rocm.missing_dependency_probe.v1` facet when upstream lifecycle evidence reports missing build prerequisites such as headers, tools, or packages. The probe is read-only worker/include-root evidence, never an install, symlink, vendored-header, or success shortcut. Its presence blocks GPU HMR success at runtime-artifact, proof-summary, real-ROCm verdict, and matrix layers; forged probes that claim runtime/GPU HMR authority are rejected.
External visual determinism gate: external visual-profile rows now recompute fixed-seed, frozen-camera, frame-boundary, swapchain-count, temporal, TAA, and denoiser controls from declared deterministic modes or linked proof artifacts. A serialized `accepted=true` evaluation cannot authorize visual evidence.
Latest-attempt audit: the unproven/history matrix now proof-hashes `attemptHistory`, pairing each newest attempt by computed attempt key with the canonical selected row so fresh infrastructure failures remain visible without weakening acceptance/refusal selection.
Worker-transfer refusal gate: real ROCm worker repository transfer failures now emit a structured `synthi.real_rocm.worker_repo_transfer_failure.v1` facet and the validation matrix scores it as fail-closed refusal evidence, not GPU HMR success; smoke coverage for this path is generic and does not name a project.
HIPRT run modes: missing for no-shim full-runtime acceptance; CameraRays and MegaKernel direct-light-gain remain source-adapted visual_profile_accepted evidence only.
historical focused Flow/ray-light matrix: gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
historical focused matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-focused-flow-ray-light-20260622T181300Z.json
focused matrix historical coverage: scoped ROCm/HIP full-runtime profile rows accepted, Flow visual path accepted, ray-light visual path accepted, per-target run modes accepted, and ray-light `trace_light_rays` per-kernel/smallest-safe fission accepted in the 2026-06-22 focused matrix. The current global matrix now also carries fresh 2026-06-25 row-bound Flow/ray-light visual-profile evidence. Flow remains device-translation-unit HMR only for fission because its selected device role owns two kernels.
```

Current live previews:

```text
Realistic raytrace: http://localhost:3000/workspace/source-first-cold-cas-realistic-20260629 -> created by the source-first proof runner from declared profile source files on 2026-06-29 and visually inspected through persisted PNG artifacts
Ray-light:          http://localhost:3000/workspace/gpu-agent-ray-light-20260626-live-container-rerun -> HTTP 200 on 2026-06-26 and visually inspected through persisted PNG artifacts
Flow:               http://localhost:3000/workspace/gpu-agent-flow-20260626-live-container-rerun -> HTTP 200 on 2026-06-26 and visually inspected through persisted PNG artifacts
Preview frontend:   http://127.0.0.1:3000 -> HTTP 200 on 2026-06-26
```

Current visual proof artifacts:

```text
Realistic raytrace dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/source-first-cold-cas-realistic-20260629
Realistic raytrace source-first proof: agent-split-source-first-ingestion:sha256:dbef11d86091ba64402333b6598f208c619f231474ced92da53fed8d15e1920f
Realistic raytrace source authority: profile_source_files, source_hash=sha256:057c83a0a2af53eea19ba3f189836978c804a0048dfd2436bb2cc41bc882662e, profile-declared two-file source tree, worker arch=gfx1201 from worker container evidence
Realistic raytrace cold run-mode proof: agent-split-run-mode-proof:sha256:cf31e188636fa5fa957d296eda0fe329e51936d341c4a2a1928e39bbe4f33e6a
Realistic raytrace cold matrix row id: historical-gpu-validation-matrix-row-sha256-87f740bc751d0fc8be062127e0a22cd02d733ddea36c02c86b2e105c1bde9615 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
Realistic raytrace hot1 run-mode proof: agent-split-run-mode-proof:sha256:29df6b1b91f01284ab71108c4f1edea8c797e0ddf8a2c9677c0a18f82fd9d3e2
Realistic raytrace hot1 ledger: gpu-ledger-proof:sha256:b528a70627bc3152fc82a053a122c8c10118b0f330bffb72f4c8bbb42a4f765b
Realistic raytrace hot1 runtime proof: gpu-runtime-proof:sha256:d545c64da1874fe605ed9462ff9b130d83b2ee272c4ae23c447fcfc3cc55c1b5
Realistic raytrace hot2 run-mode proof: agent-split-run-mode-proof:sha256:fd1c143a4cc3efe5244ee689cc27641970855f3c40d1003fa076ff8be50df606
Realistic raytrace hot2 ledger: gpu-ledger-proof:sha256:1c1b3e34b5e35372011426d966ddab89310c57b43ce9cd6261b9e6447adece8d
Realistic raytrace hot2 runtime proof: gpu-runtime-proof:sha256:d87d8195217ea17b5c069a5a7ee8b4f1ddd233f0c5c641ff095b24887de870f9
Realistic raytrace hot1 matrix row id: historical-gpu-validation-matrix-row-sha256-df44f7e0790a508aac703b3746cb2f80be2ff907a753d16a2bf7d7083adcbdff in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
Realistic raytrace hot2 matrix row id: historical-gpu-validation-matrix-row-sha256-be05fd92aaee4bc25fcdb00a3e061fd5e86c8f185078529c93493545f5f7d595 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
Realistic raytrace negative refusal row: historical-gpu-validation-matrix-row-sha256-84347a9a017de043fc6a0abec4fffd786a0e7aa84aeca62525b2210c769ac26e
Realistic raytrace current matrix runtime proofs: gpu-runtime-proof:sha256:d545c64da1874fe605ed9462ff9b130d83b2ee272c4ae23c447fcfc3cc55c1b5, gpu-runtime-proof:sha256:d87d8195217ea17b5c069a5a7ee8b4f1ddd233f0c5c641ff095b24887de870f9, acceptanceScope=generated_rocm_hip_preview_visual, claimScope=scoped_profile, broadLibraryAgnosticAccepted=false
Realistic raytrace visual files: cold-split-frame.png, before-after-diff.png, hot-delta-2-diff.png
Realistic raytrace visual deltas: hot1 changed=82.64%, mean_abs=17.89; hot2 changed=99.87%, mean_abs=37.38
Realistic raytrace timings: cold total_validator_wall_time=10968567800ns, hot1 total_validator_wall_time=4814920300ns, hot2 total_validator_wall_time=4405518100ns
Realistic raytrace deterministic fission: historical-gpu-validation-matrix-row-sha256-ab0cb77eb89e7aa8061f3a10a7a3401f4288b0615d39b276cb9ba40ef45c767e, selected verifier evidence `evidence:fission-verifier-report:generated-split:sha256:b45816a466bb70e0cb5b61dbd17bb257d71359891c563e0261a76c86e289bd27`
Realistic raytrace visual inspection: cold-split-frame.png, before-after-diff.png, and hot-delta-2-diff.png opened with the local image tool on 2026-06-29; the refreshed deterministic scene contains fixed 2x2 subpixel rays, bounded secondary reflection/refraction probes, ACES-style tone mapping, a faceted diamond, small stones, wall/awning geometry, cafe bulbs, planter boxes, cafe furniture, lamp/bollard geometry, glossy car geometry, and a reflective slab. The cold frame and both diff images are visibly nonblank. This is a deterministic generated visual profile, not broad arbitrary HIP app acceptance.

Ray-light latest dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-ray-light-20260626-live-container-rerun
Ray-light latest hot1 ledger: gpu-ledger-proof:sha256:5240c422d8c5e6e7fb14ab901b9d3ec3225433b4f6d8a0e2365b5f17a9d0fd90
Ray-light latest hot1 runtime proof: gpu-runtime-proof:sha256:6798ea24ace35aaff7995a4d1ca68cee1cb154935e66470104e170d88c4a817e
Ray-light latest hot2 ledger: gpu-ledger-proof:sha256:bb28828754c0c4774cb05084060c697b1110ddf9d068637da3ef8c6f2a3690ed
Ray-light latest hot2 runtime proof: gpu-runtime-proof:sha256:599424afc4867bd60e3254436ff71883f6e28cefb2568a47b61ce3430f4c94d3
Ray-light latest visuals: before-after-diff.png, hot-delta-2-diff.png
Ray-light latest visual deltas: hot1 changed=5.89%, mean_abs=9.91; hot2 changed=4.98%, mean_abs=7.72
Ray-light latest visual inspection: before-after and hot-delta-2 diff PNGs opened with the local image tool on 2026-06-26; both are visibly nonblank.

Flow latest dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-flow-20260626-live-container-rerun
Flow latest hot1 ledger: gpu-ledger-proof:sha256:40fdc37783eca73a1b0aac9264f1a4a0172912ef78f76d03d414841359cf09c1
Flow latest hot1 runtime proof: gpu-runtime-proof:sha256:9a3cb588a1defb397003537eb253dee9de1a554da1361dd8c45127289822afe3
Flow latest hot2 ledger: gpu-ledger-proof:sha256:d0162226d4cca2c39dc4899ddb93a07fbd5176d5705530bf15053b5b93ac1687
Flow latest hot2 runtime proof: gpu-runtime-proof:sha256:b7690159342473b57f1530be31b7bbbb2b29d1f55469e36cc566fc5f0339a081
Flow latest visuals: before-after-diff.png, hot-delta-2-diff.png
Flow latest visual deltas: hot1 changed=2.55%, mean_abs=3.38; hot2 changed=2.52%, mean_abs=3.41
Flow latest visual inspection: before-after and hot-delta-2 diff PNGs opened with the local image tool on 2026-06-26; both are visibly nonblank.

Ray-light dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-ray-light-20260625T104554-rocm-fission-evidence
Ray-light hot1 run-mode proof: agent-split-run-mode-proof:sha256:43a20d68f57ca39b7958c49af13e6da65fd3e6ded7db652ca336b7ee4bab4dd7
Ray-light hot1 ledger: gpu-ledger-proof:sha256:49782fb760dc55c2b4dd7dfada27cc9ce0ba32e7a2e22ac1320d4f0c9fafc7fc
Ray-light hot1 runtime proof: gpu-runtime-proof:sha256:39a38d8d170b3986c4892886ca73ccd86041b1936c8318ae8c21803c676bbb17
Ray-light hot2 run-mode proof: agent-split-run-mode-proof:sha256:a6e084bb0821ca942fb0e9a4b810fa28bf17093d8340600c9f0e2b02de890784
Ray-light hot2 ledger: gpu-ledger-proof:sha256:6e7ea71df94ffcf52d0c94c6c6d1ed99736be366a667a42f7075b169aada512d
Ray-light hot2 runtime proof: gpu-runtime-proof:sha256:3e6b2cec1bec9aa9916945df86be874d78e7d99943a33775a5329030acabe845
Ray-light visuals: before-after-diff.png, hot-delta-2-diff.png
Ray-light timings: hot1 total_validator_wall_time=3051317200ns, hot2 total_validator_wall_time=2458875700ns
Ray-light visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-25; before-after-diff.png was re-opened on 2026-06-26 and was visibly nonblank with changed ray-light geometry.

Flow dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/gpu-agent-flow-20260625T103454-rocm-profile-bind
Flow hot1 run-mode proof: agent-split-run-mode-proof:sha256:0e194a090dfe31fbf9440d458a21986824ee07091a4f60ab9b25893f4f3b8897
Flow hot1 ledger: gpu-ledger-proof:sha256:eec1b98b76252cb06bae7539f29ed4610afc6ed512ebf90b1f2c0ce4112fe80c
Flow hot1 runtime proof: gpu-runtime-proof:sha256:7710f0df814f55ef2a5e48d82a3ce18fbd73c14a2bc69aeb56122e67fbd0f79c
Flow hot2 run-mode proof: agent-split-run-mode-proof:sha256:42cf6c7c9b66f3991752f4a3042741054703783fd43650da80db51c5c7d9be9c
Flow hot2 ledger: gpu-ledger-proof:sha256:803b1af2b49f981730d3c348c5cab6669ce4d87649a8b0a2d9c0d323ca9919c9
Flow hot2 runtime proof: gpu-runtime-proof:sha256:f280297fff5a556677fff8ee8658a45b2db68712bf6dada11b487d427a480b13
Flow visuals: before-after-diff.png, hot-delta-2-diff.png
Flow timings: hot1 total_validator_wall_time=2911725700ns, hot2 total_validator_wall_time=2275612200ns
Flow visual inspection: before-after-diff.png and hot-delta-2-diff.png opened with the local image tool on 2026-06-25; before-after-diff.png was re-opened on 2026-06-26 and was visibly nonblank with a Flow particle-ring pattern.

WebGPU hot1 proof id: webgpu-runtime-visual-proof:sha256:87272df5a648f3e8100b9fee3e5de06238bf517b4998bbec9b01845b790a4aab
WebGPU hot1 runtime proof: gpu-runtime-proof:sha256:a59e894be860669380b0723a67177e3ff5b94a8824c51f0d68908a7792298a9b
WebGPU hot1 ledger: gpu-ledger-proof:sha256:8eb15f7a22156c14df0d947ed0c4ac4a1b14b52b45d3c2884e216a975b57e28b
WebGPU hot1 run-mode proof: runtime-run-mode-proof:sha256:176195d21868cc476531698aca6aa004a2eaa6f0177b5de03bf03f7669565196
WebGPU hot1 cold proof: runtime-run-mode-proof:sha256:682324fcd59276545d18f56e3ae6785ea99e3070de0ab98fb52cd09d562c759a
WebGPU hot1 negative refusal: agent-split-negative-edit-refusal:sha256:db53d10719363bc9dacfb0518a2170745ba537ad3e6b7c79eb332a8854f72cfc
WebGPU hot1 timing: total_validator_wall_time=1247829300ns, trigger_to_visible_time=70794700ns, changed_pixel_ratio=0.29389322916666666
WebGPU hot2 proof id: webgpu-runtime-visual-proof:sha256:893dba543fddb66ac2369a10ce89f8bc07518aa0ddb949cccb891b859c7ec3f0
WebGPU hot2 runtime proof: gpu-runtime-proof:sha256:983e347e834c914d32c7b1478fe00d7515238274fe32a6a902f2c38e1b55f625
WebGPU hot2 ledger: gpu-ledger-proof:sha256:441ee9299dc073bfb86700af70342e42b06dce5fe970ff198a20667422c3ee90
WebGPU hot2 run-mode proof: runtime-run-mode-proof:sha256:b0e6dafa96d31ed5b196c6dfa37d76968e0f7b23fa800bcd2b1f9282f34c7fd1
WebGPU hot2 cold proof: runtime-run-mode-proof:sha256:a60b981a40599d14d2bad985c94d3b433472232f2ab14b400d414049e251c758
WebGPU hot2 negative refusal: agent-split-negative-edit-refusal:sha256:7c69db3629fc77cd0a2de79b375b646834d66f5407177ee8a0ca10a00d6e0272
WebGPU hot2 timing: total_validator_wall_time=613256000ns, trigger_to_visible_time=57775800ns, changed_pixel_ratio=0.32245225694444446
WebGPU negative refusal reasons: bind_group_layouts_not_supported_by_runner, webgpu_pipeline_layout_or_binding_abi_changed, gpu_hmr_rejected_before_load
WebGPU visual inspection: hot1 diff `webgpu-runtime-visual-20260625070636-webgpu-wgsl-runtime-triangle-diff.png` and hot2 diff `webgpu-runtime-visual-20260625070706-webgpu-wgsl-runtime-triangle-hot2-diff.png` opened with the local image tool; both were visibly nonblank

WebGPU profiled scope: explicit-profiled-layout-uniform-bindings-float32-vertex-buffers-triangle-list
WebGPU profiled resource trace: bind_group_count=1, uniform binding 0 bytes=32, vertex_buffer_count=1, vertex bytes=48, resource_state_hash=sha256:febd60767177cf5ba103734735eba5e2f083a4b5131c5fab915567e9a843b2f3
WebGPU profiled hot1 proof id: webgpu-runtime-visual-proof:sha256:4a437069aff6eb30cf898de6633c16e428f0d72688a8f67eb0152117d993c333
WebGPU profiled hot1 runtime proof: gpu-runtime-proof:sha256:327c5814b847eebb41aef8af3d202ba31835f95354515c455da82613ccfb8ca3
WebGPU profiled hot1 ledger: gpu-ledger-proof:sha256:5b86d4fc2c7b403b3cb561e3f1b778da835462b2d50763e16539bcadeb95c1ee
WebGPU profiled hot1 run-mode proof: runtime-run-mode-proof:sha256:614b7689891e2ebbdc87188ac9ff5e7515bfdd3e3bd38e5e9947d4eb119063e0
WebGPU profiled hot1 cold proof: runtime-run-mode-proof:sha256:140755d546ba7a5cc0dcf0a5a76ce9402b69f022dd1d46bf6ddfc9d391b21043
WebGPU profiled hot1 negative refusal: agent-split-negative-edit-refusal:sha256:43c0eef8fed58418d27f44736a706064926dc4991d9ce5518e3a2da63136eac2
WebGPU profiled hot1 timing: total_validator_wall_time=1145767400ns, trigger_to_visible_time=70909600ns, changed_pixel_ratio=0.23291666666666666
WebGPU profiled hot2 proof id: webgpu-runtime-visual-proof:sha256:de18b154e927f7f6afe0a6a5f8766539b87032dcdc2347a9821db5f2e95b28de
WebGPU profiled hot2 runtime proof: gpu-runtime-proof:sha256:7c1e65e0bf337b2c26ad8021f1c2da57c67fb66f9522dcda5b75ec40d284e982
WebGPU profiled hot2 ledger: gpu-ledger-proof:sha256:62fd846d75844bab4c4b943613fd71b7412c3887b8f695678ce6f674e97725e1
WebGPU profiled hot2 run-mode proof: runtime-run-mode-proof:sha256:e60a28a51e069e0856cf52972b8c693889a1ba19ae9da52d22c7a0c79e935f78
WebGPU profiled hot2 cold proof: runtime-run-mode-proof:sha256:15a3a586271ad18613deafebbfbb9b672185b44719f3d70820ba4f78cd992d06
WebGPU profiled hot2 negative refusal: agent-split-negative-edit-refusal:sha256:77245a6d0819b9f5bf9394b23c49ce0969a5bcb8b566c2e5c5e1b88b7db909d8
WebGPU profiled hot2 timing: total_validator_wall_time=636983100ns, trigger_to_visible_time=58872800ns, changed_pixel_ratio=0.24441840277777777
WebGPU profiled visual inspection: hot1 diff `webgpu-runtime-visual-20260625070636-webgpu-wgsl-runtime-profiled-layout-diff.png` and hot2 diff `webgpu-runtime-visual-20260625070654-webgpu-wgsl-runtime-profiled-layout-hot2-diff.png` opened with the local image tool; both were visibly nonblank and the diffs were post-epoch image changes

WebGPU compute scope: explicit-compute-profiled-layout-storage-uniform-float32-readback
WebGPU compute hot1 proof id: webgpu-runtime-compute-proof:5550fdf2044e56986e75183dc81ef679d78f966ef22b4c1bc1c8f278d2e12236
WebGPU compute hot1 ledger: gpu-ledger-proof:sha256:fd67f29a4b1096d5ccd2b07e7a9eac7d2f2ccf8ff273dd5023305925a44a411e
WebGPU compute hot1 runtime proof artifact: webgpu-compute-runtime-proof:3852ebc9e362e9bd3b0f46eb4200ce1b64a7fb015c0c9cb2148aeab77114f56f
WebGPU compute hot1 run-mode proof: runtime-run-mode-proof:a8ca6cfad9c96af677432cad38224999a2dbd1e498a71de01152f3a19ec127a9
WebGPU compute hot1 raw/expected hash: sha256:5b2915f7ad17941e9b1b457a6a276c362edaabb974da6af1daef06f267d77657
WebGPU compute hot1 expected output verified: true, max_abs_delta=0
WebGPU compute hot1 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131945-webgpu-wgsl-runtime-compute-storage/webgpu-wgsl-runtime-compute-storage-compute-card.png
WebGPU compute hot1 timing: total_validator_wall_time=703811600ns, dispatch_to_output_proof_time=701237300ns
WebGPU compute hot2 proof id: webgpu-runtime-compute-proof:f1a068328b522bd1bba6997d442a78e0a9e86acf1716f6e0ad76363c5c636af1
WebGPU compute hot2 ledger: gpu-ledger-proof:sha256:ef7ce371282952c00c4f8a0a2b47039417a9aae95e44eac9034b5f8d1bc1ca8d
WebGPU compute hot2 runtime proof artifact: webgpu-compute-runtime-proof:03c025aa0cb9293cb97f41cac61515b16a3a48835fc9ea8bf415356c34be8832
WebGPU compute hot2 run-mode proof: runtime-run-mode-proof:5b0942f6c0be03ac75cc0cc1c3feab40cc9875cbcd563db47d34b3d253049101
WebGPU compute hot2 raw/expected hash: sha256:25e6442aa7b6a1c025719aaec529c2c815c3c0590618ade8607ab2e99f9ba5b5
WebGPU compute hot2 expected output verified: true, max_abs_delta=0
WebGPU compute hot2 card: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-compute-proof/webgpu-runtime-compute-20260625131953-webgpu-wgsl-runtime-compute-storage-hot2/webgpu-wgsl-runtime-compute-storage-hot2-compute-card.png
WebGPU compute hot2 timing: total_validator_wall_time=694453900ns, dispatch_to_output_proof_time=689318200ns
WebGPU compute-card image inspection: hot1 and hot2 compute cards opened with the local image tool on 2026-06-25; both display mapped GPU readback values and `expected output verified: true`. They are compute/readback evidence, not runtime frame visual proof; matrix acceptance comes from raw readback files, recomputed ledger, native WebGPU compute API trace, and accepted strict runtime proof artifacts.

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
HIPRT visual inspection: hot1 and hot2 diff PNGs opened with the local image tool; CameraRays baseline and changed framebuffers were re-opened on 2026-06-26 and both rendered nonblank ray-traced geometry with a visible before/after change.

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

Current 2026-06-29 large ROCm ML refresh:

```text
worker image prerequisites committed generically: ninja-build, Python dev/setuptools/venv, SQLite dev, BZip2 dev, msgpack C/C++ dev, nlohmann JSON, gfortran, Boost filesystem/program-options/system development packages, zstd development headers, and the real native launch observer library in `Dockerfile.gpu`
latest rebuilt worker image proof: `vectant-ade-worker-gpu:local` image sha256:4c189723e6168384d7e500600bcb13ea8e16de908e1d9e7b5a30fcbbadfab817; the running `vectant-ade-worker-1` container verified `nlohmann-json3-dev`, `gfortran`, `libboost-filesystem-dev`, `libboost-program-options-dev`, `libboost-system-dev`, `libzstd-dev`, `/usr/local/lib/synthi-gpu-native-launch-observer.so`, ROCm `gfx1201`, and `hipcc`
latest retained standalone MIOpen rerun: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260629163046.json
latest MIOpen result: gpuHmrSuccess=false, acceptedForGpuHmr=false, fullRuntimeProven=false
latest MIOpen runtime proof: gpu-runtime-proof:sha256:549856b2d75a76af2dff51ea9fa1fa97664473eff4c1d1466b18dffb96fbf850
latest MIOpen ledger: gpu-ledger-proof:sha256:4803174dc4471e01f8ddb7248ef505c66b491a8218b325d6ae578a77738274c1
latest MIOpen validation proof: real-rocm-validation:sha256:c56f90d360784f3a0f1f3e7a95836ab937b242776c0b95ae8bfc20a7915a0701
MIOpen selected matrix row remains refusal-proven in the latest generated matrix; source-tree CAS, recovered metadata, source-delta compile projections, external-header prerequisite evidence, generic runtime-adapter execution, and adapter-result transport do not weaken the selected refusal.
MIOpen matrix row: historical-gpu-validation-matrix-row-sha256-16305e7aef533eb74ffd73e8fdda199da25aef72e27be2fbb6710b632d32b235 in gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787
MIOpen external header prerequisite: current `ROCm/half` prerequisite evidence remains dependency evidence only; the latest row still requires runtime-stage proof before acceptance.
MIOpen source-tree transport: source_tree_transport_evidence_accepted with shared CAS validation, `transferOperation=cas_shared_volume`, `hotPathOptimized=true`, blockingGaps=[]; this remains transport evidence only.
MIOpen diagnostics: supplemental screenshots were captured and visually inspected as nonblank, but they are not frame-gated MIOpen output proof. The runner still requires post-epoch dispatch/output-target proof before any large-ROCm screenshot can become runtime visual proof.
MIOpen blocker: metadata recovery, source-delta compile projections, external-header materialization, runtime-adapter execution, adapter-result transport, and 4 native runtime boundary lines completed, but no authoritative app-hook runtime observation, Synthi artifact transport into the target process, epoch publication, dispatch trace using the published epoch, stable host identity, or post-dispatch output/visual oracle proof was observed.
MIOpen app-hook materialization: app_hook_materialization_incomplete
MIOpen timeout intelligence: `skip_async_runtime_waits=true` bounded the proof wait after upstream lifecycle, output-oracle, and app-hook evidence proved runtime stages absent for this attempt; this is refusal-only scheduling evidence, not GPU HMR proof
Composable Kernel selected row: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260629080933.json
Composable Kernel selected matrix row id: historical-gpu-validation-matrix-row-sha256-378ebb4fb4a2db179a838fc1372c17f0f652a4874cb918963f9d7a3dbe1091b6
Composable Kernel proof ids: gpu-ledger-proof:sha256:4100cafaffd17fd9894814164e1c519d2e151d68aabf217ced22634668b0025c, gpu-runtime-proof:sha256:6a3912707064ea366d7c95c91849edd3aba851d0b7002ff3127b3c60c387f259, real-rocm-validation:sha256:26e6710fedbf5ccd491749366efb01ff415d0035511fb4902b77029fb45577b9
Composable Kernel metadata recovery: attempted=true, accepted=false; the configured target/metadata path did not produce accepted runtime proof material, so no GPU HMR acceptance was possible.
hipBLASLt latest row: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260629081428.json
hipBLASLt latest matrix row id: historical-gpu-validation-matrix-row-sha256-717f37a36c9dd6463096e60c0a5aa67bb64d4668a77dc94c263db0026677a591
hipBLASLt latest proof ids: gpu-ledger-proof:sha256:ecd9c8059af3249735326cbb160143259d2f299c43b169e7e17a8042fbf92d06, gpu-runtime-proof:sha256:9efe1c1abeed65028f44958aaa637bde151ee5076a21608f40bdb6d4eeac3b5b, real-rocm-validation:sha256:9260a19cd06c69297d525d4e728a69d84a820662b89fb490a0c8a88cc864b414
hipBLASLt latest target-progression ledger: not accepted as latest target-progression proof because upstream configure failed before build metadata and source-delta execution could be recovered in `gpu-real-rocm-hipBLASLt-20260629081428`
hipBLASLt latest compile bridge: status=compile_bridge_missing, phase_count=1, device_sidecar_candidate.status=device_sidecar_contract_candidate_incomplete, known_rocm_backend=false, backend=unknown
hipBLASLt latest blocker: upstream CMake configure failed before build/run because Python development/module components were missing (`Python`, `Python_EXECUTABLE`, `Python_INCLUDE_DIRS`, `Interpreter`, `Development.Module`); no compile_commands/build metadata, source-delta phase, Synthi artifact transport, epoch, dispatch, host identity, app-hook, or post-dispatch output-oracle proof was observed
hipBLASLt prior richer attempt retained for context: gpu-real-rocm-hipBLASLt-20260626142827 recovered CMake File API metadata and executed hot_delta_1/hot_delta_2/negative_edit source-delta phases, then still refused because there was no same-process runtime bridge proof
hipBLASLt latest attempted rerun now selected by the matrix as latest-attempt refusal evidence: gpu-real-rocm-hipBLASLt-20260629081428 reached the upstream CMake configure path and failed closed before runtime proof material; it produced rejected runtime proof gpu-runtime-proof:sha256:9efe1c1abeed65028f44958aaa637bde151ee5076a21608f40bdb6d4eeac3b5b. The app-hook facet reports `required_app_hook_contract_missing`, `profileRequiresAppHookContract=true`, and gap `app_hook_contract_required_by_profile_obligation`; `gpu_hmr_success=false`.
investor-safe conclusion: large ROCm ML validation is serious-project refusal evidence only. It proves fail-closed classification and evidence discipline, not MIOpen, Composable Kernel, or hipBLASLt full-runtime GPU HMR acceptance.

Fresh MIOpen large-ML rerun sequence: `gpu-real-rocm-MIOpen-20260629163046.json` is the current retained standalone source-tree/CAS, source-delta, external-header, and runtime-adapter attempt. It staged the source tree through `cas_shared_volume`, recovered upstream metadata, executed hot_delta_1, hot_delta_2, and negative-edit source-delta compile projections, ran the generic packaged runtime-adapter template, copied its adapter-result manifest, and retained 4 native runtime boundary lines. It still failed closed with runtime proof `gpu-runtime-proof:sha256:549856b2d75a76af2dff51ea9fa1fa97664473eff4c1d1466b18dffb96fbf850` because adapter records are evidence only and no Synthi artifact transport, epoch publication, dispatch trace, host identity, app-hook runtime observation, firewall, or post-dispatch output-oracle evidence was observed. Earlier refusal attempts include `gpu-real-rocm-MIOpen-20260629075614.json`, `gpu-real-rocm-MIOpen-20260628230159.json`, `gpu-real-rocm-MIOpen-20260628193652.json`, `gpu-real-rocm-MIOpen-20260628160523.json`, `gpu-real-rocm-MIOpen-20260628111824.json`, and `gpu-real-rocm-MIOpen-20260628100013.json`, plus the retained prerequisite and lifecycle refusals from 2026-06-25 through 2026-06-28. All listed runs have `gpuHmrSuccess=false`.

Post-refresh gate hardening: every `large_rocm_ml_infrastructure` final-acceptance profile now has to declare run-mode and negative-edit obligations (`requiresRunModes=true`, `requiresNegativeEdit=true`) and configured hot-delta-2/negative-edit source-delta fixtures. The fixture facet is configuration-only (`profile_configuration_only_not_runtime_proof`) until a rerun records the extra phases, and declared phases still cannot satisfy the gate unless the runner records source/write/compile-attempt evidence plus content-addressed before/after/edit hashes. The latest MIOpen row records source-delta compile attempts, but they remain evidence-only because no load-device, device-sidecar, artifact-reference, runtime-proof material, app-hook, epoch, dispatch, host-identity, output-oracle, or row-bound accepted runtime evidence was collected. Composable Kernel and hipBLASLt remain refused before accepted full-runtime proof. This is a schema/target-class gate, not a repo-name shortcut.

Latest bounded Docker preflight refusals: `npm --prefix mcp/synthi-mcp run proof:real-rocm:large-ml-miopen`, `proof:real-rocm:large-ml-composable-kernel`, and `proof:real-rocm:large-ml-hipblaslt` all fail closed at a bounded Docker daemon preflight instead of hanging when the daemon is unavailable. Retained artifacts `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625211218.json`, `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260625212751.json`, and `mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260625213127.json` record `docker_daemon_unavailable_or_timeout`, `available=false`, `timeout_ms=8000`, `gpu_hmr_success=false`, and `full_runtime_proven=false`; retained target-progression artifacts for those runs record `entryStatus=fail`, `failureCount=5`, and failed final-acceptance gates for missing prior small-oracle, prior partial-reload, prior original-host-path, full runtime, and compute oracle artifacts. Newer reruns also failed closed at the same bounded Docker preflight: `gpu-real-rocm-MIOpen-20260625233659.json` with target-progression ledger `target-progression-ledger:sha256:66936de594438d62e6993ac973d4392eaec8f9524716aae4ba4d8d24bb8165b9`, `gpu-real-rocm-composable-kernel-20260625233712.json` with ledger `target-progression-ledger:sha256:a5b38697e9bd94b820a5b2a0f6966118bd8d00c106a05b96e6b6ec8a999b051b`, and `gpu-real-rocm-hipBLASLt-20260625233724.json` with ledger `target-progression-ledger:sha256:29f6204227fcf0553479638ed37caab7ad93dd9df9bfaf3788405ca5bff48e21`. These are infrastructure refusal evidence only, not large ROCm ML GPU HMR acceptance; the matrix can still prefer older upstream-lifecycle refusal rows when they contain stronger attempt-completeness evidence.
```

Historical MIOpen large ROCm ML caveat:

```text
profile: real-rocm-miopen-activation-large-ml
result slug: gpu-real-rocm-MIOpen-20260625082545
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-MIOpen-20260625082545.json
latest alias at run time: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/miopen-large-ml-20260625T-retained-ledger.stdout.log
repo: ROCm/MIOpen @ 06977176afd94476c18d5290f21cb40745bb73a9
target: MIOpenDriver activ -n 1 -c 1 -H 8 -W 8 -F 1 -V 1 -t 1
worker status: `vectant-ade-worker-1` was running and reported ROCm/gfx1201 capability during this proof refresh
runtime device preflight: observed but not accepted for original-host-path proof; HIP array allocation matrix failed and `hipMallocArray` returned invalid argument
runtime capability preflight matrix facet: rejected, so the row remains refused
upstream configure/build/run: CMake configure failed, build was blocked by configure failure, and run was not started
upstream lifecycle refusal facet: accepted_as_refusal_evidence=true, reasons=cmake_configure_failed,missing_build_dependency,upstream_build_blocked_by_configure,upstream_run_not_started_after_configure_failure,upstream_lifecycle_command_failed, missing_dependencies=SQLite3,SQLite3_INCLUDE_DIR,SQLite3_LIBRARY
native evidence: observe-only native launch observer was requested, but no readiness, launch, function-resolution, argument-provenance, runtime-session, artifact-transport, epoch, dispatch, output-oracle, host-identity, or original-host-path lines were captured before configure failure; observe-only interposition is diagnostic and cannot satisfy acceptance by itself
split projection: no fresh AI split/delta calls in this rerun
delta projection: none accepted; configure failure occurred before compile/delta proof material was collected
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
device sidecar contract facet: no sidecar contract accepted; static candidate metadata is evidence-only and cannot satisfy runtime proof
timings: total_validator_wall=24020.0527ms, metric_clock=monotonic_ns, evidenceAuthority=timing_telemetry_only
accepted GPU HMR: false
strict refusal: runtime proof artifact exists but is rejected; upstream configure/build/run did not produce usable metadata, the Synthi runtime proof chain is missing, full runtime proof remains unproven, proof ledger rejects, and acceptance contract rejects
oracle resolution: profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, worker profile cleared with syncSkippedReason=runtime_profile_absent
worker proof boundary: no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, output_oracle, host_identity, or original_host_path attachment evidence
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
real ROCm app-hook contract facet: declared=false, can_satisfy_runtime_proof=false, stages missing artifact_transport, epoch_publication, dispatch_trace, host_identity, and output_oracle
real ROCm runtime eligibility facet: status=refused_missing_runtime_proof, backend_candidates=hip, gaps=artifact_transport_not_observed,same_process_epoch_missing,dispatch_epoch_missing,output_oracle_profile_absent,host_identity_not_observed
target progression: final-acceptance, required=true, target=MIOpenDriver, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, raw compute oracle artifacts
visual proof: no MIOpen frame captured; matrix marks visual.required=false for this compute-only target and still refuses because strict runtime ledger and raw output-oracle proof are missing
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
refusal proof ids: gpu-ledger-proof:sha256:00a7d7fad085eaeceb8b4c3f2f21770bd1dafe293f51da8a2bf47fcf91c4ccab, gpu-runtime-proof:sha256:d1f6d1a507eb4fade9bc3467028d678d22088a6808014c910487ff4c1aa332ef, real-rocm-validation:sha256:bc99a66ae4b08cebba28b990f79d906cb1474d127176345b1dfcc41e23b1b447
historical matrix row hash: sha256:ac0e20c7d37454df2f272747c99e76ab058a7557e25a6dd9da53f242646f7468 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T082827Z.json; retained per-run result artifacts keep this MIOpen row queryable as historical refusal evidence
historical matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, app-hook contract/runtime observations missing, target-progression gates failed, runtime capability preflight missing, runtime chain missing, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
plan coverage: large_real_rocm_repo=refused
```

Current retained ROCm matrix multiplication compute-oracle caveat:

```text
profile: real-rocm-matrix-multiplication
result slug: gpu-real-rocm-rocm-examples-20260626180604
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-rocm-examples-20260626180604.json
latest alias path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/rocm-matrix-multiplication-20260625T-retained-ledger.stdout.log
repo: ROCm/rocm-examples @ c121d6d2e6a21ce1d0a140e97b890ada635f7574
target: hip_matrix_multiplication
upstream build/run: configure=2109ms, build=2356ms, run=273ms, run_exit_code=0
output oracle: profile=hip.matrix-multiplication.readback-c.v1, selected_source=source_derived_profile, oracle=oracle:real-rocm:matrix-readback-c:b8f18aad760bfaf7, baseline=sha256:aaedc7073c76880db6c8be81a91229d0073f1069e70791a7d028f575910c352c, expected=sha256:e7352404a601e877e39b4ae06181ce1597e93ccbbb2c9d654eb9df479bb9a858, worker_profile_synced=true
candidate artifact entry point: matrix_multiplication_kernel
native evidence: hipLaunchKernel observed through the native launch observer
target progression: phase=small-oracle, required=true, final_acceptance_target=MIOpenDriver, output_oracle gate failed because runtime_dispatch_not_observed
compile bridge facet: status=compile_bridge_missing, phase_count=2, compile_response_status=compile_bridge_not_declared_by_compile_response, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false, gap=compile_response_device_sidecar_bridge_not_declared
timings: device_compile_wall_time=30012ms, runtime_probe_time=273ms, total_validator_wall_time=111530.1157ms
accepted GPU HMR: false
strict refusal: runtime proof artifact exists but is rejected; native HIP launch evidence is evidence-only and cannot satisfy GPU HMR
runtime proof artifact: gpu-runtime-proof:sha256:eb3142d64c24139e889ac88d133f9c1d32b5bb89c32b495a757c8ab92208353e
proof ledger: gpu-ledger-proof:sha256:082b9c2047b67d8c5ab02e576739ead14c145ab3c9433fb7d0af4c1df8fa7df2, gpu_hmr_success=false
worker proof boundary: no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, host_identity, or runtime output_oracle observation
native ROCm refusal facet: status=refusal_evidence, can_satisfy_dispatch_proof=false, gaps=native_launch_boundary_observed,native_boundary_not_synthi_dispatch_proof,synthi_dispatch_not_observed,artifact_transport_not_observed,epoch_not_observed,output_oracle_not_observed,host_identity_not_observed,adapter_impossible_requires_app_hook
real ROCm app-hook contract facet: status=required_app_hook_contract_missing, declared=false, required=true, can_satisfy_runtime_proof=false
current matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
current matrix proof ids: gpu-ledger-proof:sha256:dcdae848ef9e472b97bb5821fb4bf6217c416344eee7af8272a3fa9ccdf07094, gpu-runtime-proof:sha256:cfe0cee1c16ca66d1689c0188e987a608401e38dea80ca265b3482f6a7b477f6, real-rocm-validation:sha256:5be5c7e7314890567298b97e98a9c7ac3ec5915f31125c125aafaeebf6a4dbf7
current matrix row id: historical-gpu-validation-matrix-row-sha256-ab0cb77eb89e7aa8061f3a10a7a3401f4288b0615d39b276cb9ba40ef45c767e in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
current matrix open gaps: strict_runtime_proof_artifact_required, proof_ledger_success_required, output_or_visual_oracle_proof_required, real_rocm_runtime_chain_required, real_rocm_app_hook_contract_required, target_progression_gates_failed, native_boundary_not_synthi_dispatch_proof, artifact_transport_not_observed, same_process_epoch_missing, dispatch_epoch_missing, output_oracle_missing, host_identity_not_observed
visual artifacts: first-compile screenshot sha256:fabb6d488f6cf82695a5ac6e7d9d47bbb5d4290e38675dd66dbae4ad18c459e0 and post-HMR screenshot sha256:109c3c9352ebcd082ead86e35714867ca6e054c1db2ff75b5e99661c8efdcdbd were opened with the local image tool on 2026-06-27; both render the same nonblank raytraced preview scene, but both have frame_capture_after_epoch_dispatch=false and are not accepted as GPU HMR output-oracle proof
visual proof: compute-only target; no frame-gated visual proof is counted, and strict ledger still refuses because post-epoch output-oracle observation is missing
```

Current retained Composable Kernel large ROCm ML caveat:

```text
profile: real-rocm-composable-kernel-gemm-large-ml
result slug: gpu-real-rocm-composable-kernel-20260629080933
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-composable-kernel-20260629080933.json
repo: ROCm/composable_kernel @ 713f1fbf46ae73755c06a0b115f01795cea9a4f9
target: example_gemm_xdl_fp32_v3
repo scale: 7,234 files
upstream build/run: configure completed, but the requested target was not generated; build failed with "No rule to make target 'example_gemm_xdl_fp32_v3'", run was skipped, run_exit_code=not-run
metadata recovery: attempted=true, accepted=false; worker CMake File API recovery could not copy build/compile_commands.json after upstream lifecycle failure
source-delta execution: missing; because metadata recovery was rejected, no content-addressed hot_delta_1/hot_delta_2/negative_edit source-delta phase was accepted
output oracle: profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, runtime_profile_synced=false
candidate artifact identity: artifact_kind=hip_source_bridge, source=example/01_gemm/gemm_xdl_fp32_v3.cpp, entry_points=DeviceGemm_Xdl_CShuffleV3/GridwiseGemm, compile_target=gfx1201
native evidence: observer was enabled, but no native launch, function-resolution, Synthi dispatch, artifact-transport, epoch, output-oracle, or host-identity lines were captured before upstream lifecycle failure
target progression: phase=final-acceptance, required=true, final_acceptance_target=example_gemm_xdl_fp32_v3, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, raw compute oracle artifacts
target progression ledger: target-progression-ledger:sha256:59ced8cb24a51da0d10cb0bfd35751b5b4f53e8cce7ae41909210779da2b918b
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false
timings: total_validator_wall_time=62268.3436ms, duration_monotonic_ns=62268343600, metric_clock=monotonic_ns, metric_scope=hot_delta_1, cache_state=clean
accepted GPU HMR: false
runtime proof artifact: gpu-runtime-proof:sha256:e4b7490798b73ac22cb238481fb7140c17e69fc52fa4f0515ac880f5e42b8917
proof ledger: gpu-ledger-proof:sha256:47b87d7f99629443df636ab4feffda4d96e896b6693adc6908e6a7d966df437f, gpu_hmr_success=false
top-level verdict: gpu_hmr_success=false, full_runtime_proven=false, failed_gates=full_runtime_ladder_not_proven,strict_runtime_proof_artifact_gpu_hmr_success_false,strict_runtime_proof_artifact_not_accepted,strict_proof_gates_failed,target_progression_gates_failed
worker proof boundary: no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, output_oracle, host_identity, or original_host_path attachment evidence
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
profile proof obligations: refusal_only=true, requires_full_runtime_proof=true, requires_output_oracle=true, requires_app_hook_contract=true, app_hook_contract_declared=false
current matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
current matrix proof ids: gpu-ledger-proof:sha256:47b87d7f99629443df636ab4feffda4d96e896b6693adc6908e6a7d966df437f, gpu-runtime-proof:sha256:e4b7490798b73ac22cb238481fb7140c17e69fc52fa4f0515ac880f5e42b8917, real-rocm-validation:sha256:0ef6a766db88c27608969c3148dbb044397e9edd01b345abbddadcf4054bddb5
current matrix row id: historical-gpu-validation-matrix-row-sha256-378ebb4fb4a2db179a838fc1372c17f0f652a4874cb918963f9d7a3dbe1091b6 in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260630T061201Z.json
current matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, runtime chain missing, app-hook contract required by profile proof obligations, target-progression gates failed, runtime capability preflight failed, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
visual proof: none; compute-only target, no frame-gated visual proof, and no raw readback/card artifacts were produced after a Synthi epoch dispatch
```

Historical hipBLASLt large ROCm ML caveat superseded by the current selected row above:

```text
profile: real-rocm-hipblaslt-gelu-aux-bias-large-ml
result slug: gpu-real-rocm-hipBLASLt-20260625090303
retained result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results/gpu-real-rocm-hipBLASLt-20260625090303.json
latest alias path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
manual log: mcp/synthi-mcp/.gpu-hmr-test-logs/manual-runs/hipblaslt-large-ml-rerun-20260625T-retained-ledger.stdout.log
repo: ROCm/hipBLASLt @ 3a609b06926c8227e753b62087555e1f435bf2d4
target: sample_hipblaslt_gemm_gelu_aux_bias
repo scale: 2,860 tracked files; worker checkout copy measured 7.3G under /tmp/synthi-real-rocm/hipBLASLt during the run
upstream build/run: CMake configure failed before build/run because Python development/module components were missing; build was blocked by configure failure, run was skipped, run_exit_code=not-run
missing dependencies: Python, Python_EXECUTABLE, Python_INCLUDE_DIRS, Interpreter, Development.Module
output oracle: profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, runtime_profile_synced=false
candidate artifact identity: artifact_kind=hip_source_bridge, source=clients/samples/08_gemm_gelu_aux_bias/sample_hipblaslt_gemm_gelu_aux_bias.cpp, entry_points=hipblasLtMatmul/hipblasLtMatmulAlgoGetHeuristic/hipblasLtMatmulDescSetAttribute/rocblaslt_matmul, compile_target=gfx1201
native evidence: observer was enabled, but no native launch, function-resolution, Synthi dispatch, artifact-transport, epoch, output-oracle, or host-identity lines were captured before configure failure
target progression: phase=final-acceptance, required=true, final_acceptance_target=sample_hipblaslt_gemm_gelu_aux_bias, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, raw compute oracle artifacts
compile bridge facet: status=compile_bridge_missing, phase_count=0, load_device=false, device_sidecar=false, artifact_reference=false, runtime_proof_material=false
runtime capability preflight: observed RX 9070 XT/gfx1201, but HIP array allocation matrix and texture fallback probes were unavailable, so original-host-path proof remains blocked
timings: total_validator_wall_time=244406.8801ms, duration_monotonic_ns=244406880100, metric_clock=monotonic_ns, metric_scope=hot_delta_1, cache_state=clean
accepted GPU HMR: false
runtime proof artifact: gpu-runtime-proof:sha256:d7f374724fe99e4b95518c5be6fea8793cb713c3ab3842b0bf14a061ed2627c6
proof ledger: gpu-ledger-proof:sha256:0df91a6edd201f0bf02ace0b4d46dc2b5d56f521f0566abe0b51162a42a3e611, gpu_hmr_success=false
worker proof boundary: no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, output_oracle, host_identity, or original_host_path attachment evidence
native ROCm refusal facet: status=not_observed, can_satisfy_dispatch_proof=false, native_launch_observed=false, output_oracle_profile_absent=true
profile proof obligations: refusal_only=true, requires_full_runtime_proof=true, requires_output_oracle=true, requires_app_hook_contract=true, app_hook_contract_declared=false
historical matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
historical matrix proof ids: gpu-ledger-proof:sha256:0df91a6edd201f0bf02ace0b4d46dc2b5d56f521f0566abe0b51162a42a3e611, gpu-runtime-proof:sha256:d7f374724fe99e4b95518c5be6fea8793cb713c3ab3842b0bf14a061ed2627c6, real-rocm-validation:sha256:1ac7a9444ec44f2f7220e7ef3da18e85d89143ce76a23f9ba640a2bb237645f5
historical matrix row hash: sha256:05c51af0d3e67a4fccfa61bb5419b58baa7c5ec92a568645ef450c419675e07e in mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260625T090839Z.json
historical matrix open gaps: strict runtime proof artifact rejected, proof ledger success false, output or visual oracle proof missing, output oracle disabled/missing, runtime chain missing, app-hook contract required by profile proof obligations, target-progression gates failed, runtime capability preflight failed, artifact transport not observed, same-process epoch missing, dispatch epoch missing, host identity not observed
visual proof: none; compute-only target, no frame-gated visual proof, and no raw readback/card artifacts were produced after a Synthi epoch dispatch
```

## Current Hardening Status

Latest implementation commits:

```text
794e8148b fix(gpu-hmr): bind visual scene manifests
2d7c44937 fix(gpu-hmr): bind visual profile source hashes
83060b23d fix(gpu-hmr): emit required rocm app-hook templates
d4c6b1175 feat(gpu-hmr): add profile driven visual proof runner
1ab82200d fix(gpu-hmr): refresh rocm obligation facets before result write
fb8772753 fix(gpu-hmr): require explicit hiprt backend evidence
b9b4f5be7 fix(gpu-hmr): block auto oracles for rocm final acceptance
b3e7d6d1b fix(gpu-hmr): require explicit real rocm profile
e4f82cf48 fix(gpu-hmr): recompute large ml app hook obligation
d45425c0b fix(gpu-hmr): require app hooks for large rocm final targets
72f8269a2 fix(gpu-hmr): validate app-hook stage evidence
76cc2e542 fix(gpu-hmr): allow proven native rocm bridge gate
9364f76f2 docs(gpu-hmr): refresh realistic raytrace proof ledger
46248bb8d feat(gpu-hmr): enrich deterministic raytrace visual proof
9cb1a7faf feat(gpu-hmr): add generic native rocm runtime bridge gate
f819ed03d fix(gpu-hmr): require large rocm delta fixtures
7262aaa7d docs(gpu-hmr): clarify retained rocm evidence scope
d874b3d29 docs(gpu-hmr): record refreshed large rocm refusal
e699e9ec6 build(worker): isolate boost rocm image layer
4b8fc32ef fix(worker): add boost components for large rocm builds
23f3be60a fix(gpu-hmr): keep real rocm runtime refusal collection total
65b7bb824 fix(gpu-hmr): prefer complete rocm validation evidence
e01422bed fix(gpu-hmr): classify missing cmake compilers
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
Real ROCm runtime output-oracle profiles now sync by configured worker container instead of MCP transport; the selected retained MIOpen upstream-lifecycle profile declares no runtime oracle profile, so the worker oracle file was cleared and the run correctly stayed refused.
Native ROCm/HIP launch-boundary evidence is now machine-readable refusal context, not dispatch authority. It enters the derived acceptance contract as blocking gaps while `can_satisfy_dispatch_proof=false`.
Large real ROCm profiles can now supply generic runtime output-oracle profiles and target-progression defaults. The selected retained MIOpen upstream-lifecycle result records oracle resolution explicitly: profile `none`, no selected oracle source, no contract, and no runtime profile.
The selected retained MIOpen upstream-lifecycle rerun also records the generic compile-bridge facet as `compile_bridge_missing`: the no-device run collected no compile phase proof material and no `load_device`, device-sidecar, artifact reference, or runtime-proof material.
The ROCm examples matrix multiplication result records oracle resolution explicitly: profile `hip.matrix-multiplication.readback-c.v1`, source-derived selected oracle, runtime profile synced to the worker, and strict refusal because runtime Synthi epoch/dispatch/output proof is absent.
The Composable Kernel result records oracle resolution explicitly: profile `none`, no selected oracle source, no contract, no runtime profile, candidate HIP source-bridge metadata only, and strict refusal because no target binary, Synthi epoch/dispatch/output proof, app-hook contract, or host-preservation evidence is present.
The current selected hipBLASLt result records oracle resolution explicitly: profile `none`, no selected oracle source, no contract, no runtime profile, and an incomplete device-sidecar candidate with `backend=unknown`/`known_rocm_backend=false`; strict refusal occurs before build metadata or source-delta execution because CMake cannot find Python development/module components, and no Synthi epoch/dispatch/output proof, app-hook contract, host-preservation evidence, or accepted runtime proof chain is present. The older Tensile-generation/source-delta attempt is retained only as historical context.
Real ROCm checkout reuse now validates git worktree root, HEAD, and origin remote before reuse. Invalid default `tmp/real-rocm/*` checkouts are quarantined for reruns, while custom paths fail loudly instead of being modified.
The worker Dockerfiles now include generic large ROCm project build prerequisites (`ninja-build`, Python development headers/tools, SQLite development files, BZip2/msgpack/nlohmann JSON, and gfortran). `Dockerfile.gpu` also builds the real native launch observer library from `cpp_src/synthi_gpu_native_launch_observer.c`. Do not claim this changes retained MIOpen/CK/hipBLASLt results until the GPU worker image is rebuilt and those profiles rerun.
Real ROCm output-oracle profiles now require declared native launch symbols, and runtime eligibility filters native placeholder symbols such as `unknown`; the matrix multiplication candidate artifact records `matrix_multiplication_kernel`.
The MIOpen large-ML profile now requires `targetProgression.phase=final-acceptance`; the selected retained upstream-lifecycle run fails the missing prior small-oracle, partial-reload, original-host-path, full-runtime, and raw-compute-oracle-artifact gates instead of leaving the target undeclared.
The ROCm examples matrix multiplication profile is now a required `small-oracle` progression phase for the larger `MIOpenDriver` final-acceptance ladder. It still fails closed because the small-oracle gate requires real runtime output proof after Synthi dispatch, not only a derived checksum contract.
Real ROCm compile phases now preserve an evidence-only compile bridge facet. The latest tightened matrix run records no compile-declared `load_device`, device-sidecar, artifact-reference, runtime-proof material, or matching bridge signal strings, so the matrix row exposes `real_rocm_compile_bridge:compile_response_device_sidecar_bridge_not_declared`.
Compile bridge candidates are also non-authoritative. A compile response that names `load_device`, device sidecars, artifacts, and proof material stays blocked until accepted runtime proof artifacts already prove artifact transport, epoch publication, dispatch, host identity, and output oracle.
Real ROCm device-sidecar contracts are recomputed after runtime proof collection. They can satisfy the sidecar gate only when build/profile evidence is complete and runtime artifact transport, epoch publication, dispatch trace, host identity, output oracle, and full-runtime proof are all observed. The selected retained MIOpen upstream-lifecycle rerun still has only a candidate, so it remains refused.
Real ROCm final-acceptance profile proof obligations are now matrix-gated. A final-acceptance target without an output-oracle profile is refused unless explicitly marked refusal-only, and `targetProgression.required=true` implies full-runtime proof.
Real ROCm CPU/GPU firewall evidence is now matrix-gated from recomputed ledger/runtime evidence. Accepted rows must explicitly prove `cpuHmrUsed=false`, `fullRebuildUsed=false`, and `processRestarted=false`; missing firewall evidence, forged CPU fallback, hidden full rebuild, process restart, and old-artifact dispatch are refusal material.
Real ROCm final-acceptance target progression now revalidates prior small-oracle rows from raw compute oracle artifacts or readable visual artifacts with matching content hashes; proof ids and status labels are not enough.
Real ROCm target-progression gate failures are now hard matrix blockers; failed prior partial-reload/original-host-path gates cannot be hidden behind otherwise successful runtime/oracle rows.
Real ROCm target-progression ledger artifacts now merge reported rows with freshly derived gate rows. Fatal/preflight paths and forged `pass` rows are retained as `fail` when proof fields are missing.
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
npm --prefix mcp/synthi-mcp run proof:hiprt:same-process:megakernel-light-gain -> historical source-adapted diagnostic passed before fail-closed runner hardening; current source-adapted reruns require SYNTHI_HIPRT_WARM_ALLOW_REJECTED=1 and do not set gpuHmrSuccess=true
node --check mcp/synthi-mcp/scripts/hiprt-light-math-warm-proof.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
latest validation matrix -> gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787
latest history audit matrix -> gpu-validation-matrix-ledger:sha256:84a53b01ac48ac2f6d17cc953122e5f8f4515789cc513f0578da7e283468609b
historical focused Flow/ray-light matrix -> gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
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

Historical focused proof is `ray-light-gpu-hmr-proof-20260622-embedded-ledger-10`; the current June 26 live preview/proof slug is `gpu-agent-ray-light-20260626-live-container-rerun`, and the aggregate authority is the current global matrix `gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787`. The older June 9 timing-matrix block below is retained as historical context.

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

Historical focused proof is `flow-gpu-hmr-proof-20260622-embedded-ledger-10`; the current June 26 live preview/proof slug is `gpu-agent-flow-20260626-live-container-rerun`, and the aggregate authority is the current global matrix `gpu-validation-matrix-ledger:sha256:9021cc8be6f4e5f65643be933368394843db710d6e010bc30834ad34b4383787`. The older June 9 timing-matrix block below is retained as historical context.

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
latest diagnostic proof id: oidn-preflight-proof:sha256:48ccd07dae1bb1e686418c0850879ccd310e4219de4c262305da27208f1c53f4
result state: oidn-hip-rejected
latest proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260626-after-apphook-refresh-proof.json
latest summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260626-after-apphook-refresh-summary.txt
latest matrix row: historical-gpu-validation-matrix-row-sha256-88edda748c10b7da1a009ccc5b2a0516a4109e95116fafaf06ff913bd2ae0496
latest unsupported reasons: oidnTest_not_found
acceptedForOidnHipRuntimePreflight: false
acceptedForOidnHipOutputProof: false
gpuHmrSuccess: false
previous diagnostic proof id: oidn-preflight-proof:sha256:818110f978534f7b1574bc005bec74ca793a0813125b47aa5a3d7c21c5ce0356
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260626-runtime-split-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260626-runtime-split-summary.txt
previous diagnostic proof id: oidn-preflight-proof:sha256:25577fa64be579acb4bb512f3b1f2cb3652e48885b90f84e0d54e7aca3198ff4
previous proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624095704-proof.json
previous summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-preflight-20260624095704-summary.txt
previous real-checkout proof id: oidn-preflight-proof:sha256:5fc3136f57579a91c4be2475af7d1776d23e5c19696d7f76a1794413db5ec21a
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/oidn-preflight/oidn-hiprt-rocm-preflight-20260622-real-checkout-summary.txt
repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
```

Latest live worker OIDN HIP probe was tested and rejected before runtime tests:

```text
oidnTool: missing
hipDeviceLibrary: missing
worker checkout probe: sh: 1: cd: can't cd to /tmp/synthi-real-rocm/HIPRT-Path-Tracer
noShimApplied: true
noSymlinkApplied: true
noSynthesizedRuntime: true
```

Previous real-checkout OIDN HIP runtime tests were also rejected:

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

No OIDN HIP proof is accepted. The latest diagnostic rerun was allowed only to capture rejected proof artifacts after the runner became fail-closed by default, and no symlink or ABI shim was added.

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

Scoped host-local Vulkan runtime proof:

```text
proof id: vulkan-runtime-proof:sha256:de768ddd560863deac94f7740adf55af5a3fb59e730c9e0109fd383135bc8e84
runtime artifact: vulkan-runtime-proof-artifact:62fbf87f8551fdce10a33595c8c5a76d42683ac3522676a942c7f1a5c4a94134
ledger: gpu-ledger-proof:sha256:599ef0607b62dab245d7b29b9dae68ed6a30733520bb8aaaff7a54371ae03fb1
matrix row: gpu-validation-matrix-row:sha256:c0e9f8d1509334ae80200ee736df5050e585e12bb11ae7a8fd951248893342e8
visual artifacts: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-runtime-proof/vulkan-runtime-frame-20260630124806/vulkan-before-frame.png, vulkan-after-frame.png, vulkan-diff-frame.png
```

The accepted host proof is scoped to the generated Vulkan pipeline/readback validation target. It proves a real same-process Vulkan epoch reload sequence on the host and byte-backed visual readback output. It does not prove arbitrary Vulkan engine caches, pre-recorded application command buffers, descriptor layouts, render graphs, or worker-container Vulkan.

Structured Vulkan worker-container preflight proof:

```text
proof id: vulkan-preflight-proof:sha256:d904016a24c785659424bae3cc5381ae2a84b816fee87c1f13dd335709d7a528
result state: vulkan-runtime-rejected
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/vulkan-preflight/vulkan-rocm-preflight-20260609-summary.txt
```

Worker-container Vulkan was tested and rejected:

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

No Vulkan proof is accepted on the worker container, and no ICD, symlink, or compatibility shim was synthesized.

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

## Historical ROCm/HIP Compute Ledger

Historical retained compute/readback proof. This SAXPY-era artifact is not a current accepted full-runtime row in the latest validation matrix; it is retained as older compute evidence:

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

Local image inspection confirmed the compute-output proof card is readable and shows matching expected/readback hashes. This is not frame-gated runtime visual proof and is not counted as current full-runtime GPU HMR by the latest matrix.

Rejected later reruns:

```text
gpu-real-rocm-repo-20260609010632: rejected because worker runtime session was lost.
gpu-real-rocm-repo-20260609011410: rejected because no HMR proof was produced before first-phase timeout.
```

These are not proof. They demonstrate the harness refuses invalid runtime evidence.

## External Profile Proofs

ThreeJS WebGL shader lava passed in a historical typed external runtime screenshot proof. This is visual-profile evidence only; the historical matrix row was not accepted as full-runtime GPU HMR because full same-process loader/epoch/dispatch/host-identity proof was missing, and the latest default matrix no longer carries this row as current evidence.

```text
profile: threejs-webgl-shader-lava
historical matrix row hash: sha256:b827e528785b8626f487dcfa6a9b9ea3db116b290cbbeda37f8fd024b2797d0f
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1782385221065-report.json
visual proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/threejs-webgl-shader-lava-1782385220865-visual-proof.json
proof id: external-visual-proof:9c7199b7184421f878378da9436e6fe305c1b2c44ae86c43d80ba565fa56b7f3
total wall: 6821.7908ms
edit to screenshot: 2522ms
visual diff: 55ms
report changed pixels: 28.3611%
matrix-recomputed changed pixels: 29.0430%
mean abs delta 8-bit: 12.9131 report, 9.6848 matrix-recomputed visible pixels
Chrome GPU: enabled
```

Artifacts:

```text
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-before-1782385216661.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-after-1782385219428.png
mcp/synthi-mcp/.gpu-hmr-test-artifacts/external-projects/threejs-webgl-shader-lava-external-diff-1782385220742.png
```

Visual inspection confirmed a torus-to-sphere material/geometry change and a nonblank diff.

Bevy/WGSL was tested with real Rust GNU and w64devkit and remains rejected, not accepted.

Fresh rejection artifact:

```text
report: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1780972280020-report.json
rejection proof id: external-rejection-proof:543387dc31d8a1a92e79c58a0dcc137a3eede776be7f0ac5f03881e5f3feaeec
rejection proof: mcp/synthi-mcp/.gpu-hmr-test-logs/external-projects/bevy-wgsl-shader-material-1782388085464-rejection-proof.json
profile selection: recovered from report profile id and packaged profile manifest, explicit=false, recovered=true
matrix row: historical-gpu-validation-matrix-row-sha256-b1132a777685310f5feef00547a6c714ac8ed1901cc7412e3a0bd3b7f09f2fce
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
512b46c66 feat(gpu-hmr): accept generic rocm runtime oracle contracts
f819ed03d fix(gpu-hmr): require large rocm delta fixtures
7262aaa7d docs(gpu-hmr): clarify retained rocm evidence scope
d874b3d29 docs(gpu-hmr): record refreshed large rocm refusal
e699e9ec6 build(worker): isolate boost rocm image layer
4b8fc32ef fix(worker): add boost components for large rocm builds
23f3be60a fix(gpu-hmr): keep real rocm runtime refusal collection total
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
- Focused Flow/ray-light per-target run-mode coverage is complete in the older focused 2026-06-22 matrix, and the current global matrix now also carries fresh 2026-06-25 row-bound support evidence for generated Flow, generated ray-light, WebGPU explicit-empty WGSL, and WebGPU explicit-profiled WGSL. HIPRT CameraRays/MegaKernel rows are source-adapted visual-profile evidence only, so `hiprt_run_modes` and `hiprt_visual_path` remain missing for no-shim full-runtime acceptance.
- MIOpen large ROCm ML infrastructure is attempted under the proof harness and native observer with `vectant-ade-worker-1` running. The latest retained external-header run configured successfully, materialized the real `ROCm/half` prerequisite, and entered the upstream compile before the bounded window expired, but captured no frame-gated MIOpen visual artifacts. Older diagnostic preview screenshots remain supplemental only. The row still remains refused: `gpuHmrSuccess=false`, no accepted full ledger chain, no accepted runtime proof chain, no generic app-hook contract/runtime observations, no epoch/dispatch proof, no target-progression ledger success, and no post-dispatch output/visual oracle proof.
- Composable Kernel large ROCm ML infrastructure is attempted under the same profile-driven real ROCm harness, but the latest retained run remains refused after configure generated build files without the requested example target, no upstream binary ran, metadata recovery failed because `compile_commands.json` was unavailable, and no app-hook, epoch, dispatch, host-identity, output-oracle proof, or runner-observed content-addressed source-delta execution phases were produced.
- hipBLASLt large ROCm ML infrastructure is attempted under the same profile-driven real ROCm harness. The latest retained run preserves the upstream compile summary and an incomplete unknown-backend device-sidecar candidate, but it remains refused before build metadata/source-delta execution because CMake cannot find Python development/module components and no app-hook, epoch, dispatch, host-identity, or post-dispatch output-oracle proof was produced. This retained row is not counted as current full-runtime GPU HMR evidence; the older Tensile/source-delta run remains historical context only.
- CUDA is not applicable to this local AMD ROCm proof matrix; validate CUDA only on CUDA hardware.
- OIDN HIP needs a ROCm-compatible OIDN HIP build; no ABI shortcut should be used.
- OpenCL worker-container and arbitrary-project acceptance still need a real vendor ICD plus dispatch/event/readback ledger proof for each target; no synthesized ICD or shim should be used.
- Vulkan worker-container and arbitrary-project acceptance still need a real ICD plus pipeline-layout, command-buffer, frame-boundary, and visual oracle ledger proof for each target; no synthesized ICD or shim should be used. The current host-local Vulkan row is scoped proof, not arbitrary engine acceptance.
- WebGPU beyond the accepted explicit-empty WGSL profile and explicit-profiled uniform-buffer plus float32-vertex-buffer profile needs executed proof for additional bind group kinds, vertex formats, compute pipelines, engine caches, pipeline layouts, frame traces, and output-oracle ledger proof; browser flags must remain evidence-only.
- Per-kernel/smallest-safe fission is proven only for the ray-light generated `trace_light_rays` island; additional projects/backends need their own deterministic verifier evidence.
- In-app browser visual proof was unavailable because the browser connector bootstrap failed with sandbox metadata; persisted WebGPU, ray-light, and Flow before/after/diff PNGs were inspected with the local visual tool instead, and the matrix now decodes PNGs before accepting them.
