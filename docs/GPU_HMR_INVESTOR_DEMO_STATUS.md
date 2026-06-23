# GPU HMR Investor Demo Status

Updated: 2026-06-23

## Demo Position

Safe investor-demo claim:

```text
On the local AMD ROCm machine, Synthi can hot-reload a GPU device-artifact edit, keep the runtime alive, and prove the changed output with strict runtime-ledger evidence plus pixel-backed before/after/diff visual artifacts.
```

Best demo surfaces:

1. ROCm/HIP MCP ray-light preview: strongest Synthi app preview proof.
2. ROCm/HIP MCP Flow preview: second generated visual workload, proving this is not a one-case path.
3. Deterministic generated-split fission verifier for ray-light `trace_light_rays`: proof-only row, not a replacement for runtime-ledger acceptance.
4. ThreeJS WebGL external profile: concrete external runtime screenshot proof, not full ledger acceptance.
5. WebGPU Chrome/AMD scoped WGSL runtime visual proof: shader-module/pipeline/frame proof for an explicit-empty-layout profile with cold/hot1/hot2-different-edit/negative run-mode coverage.
6. Strict ROCm/HIP compute ledger: strongest full-runtime proof artifact and output-oracle readback.
7. HIPRT same-process CameraRays: scoped ray-traced visual full-runtime proof with embedded ledger/runtime artifact, nonblank oracle-region proof, and cold/hot1/hot2/negative run-mode coverage.
8. HIPRT MegaKernel direct-light-zero: useful adversarial visual refusal proving blank render-region output is not accepted.
9. MIOpen large ROCm ML infrastructure profile: useful serious-project refusal proving the harness can build/run upstream MIOpen, trace a launched activation kernel, and still refuse when Synthi full-runtime proof is missing.

Do not claim:

```text
CUDA was proven on this AMD GPU.
Every arbitrary GPU project is production accepted.
MIOpen large ML full-runtime HMR passed.
Bevy or broad/general WebGPU has full-runtime proof-ledger acceptance.
Broad HIPRT is accepted beyond the scoped CameraRays profile.
OIDN HIP produced or validated the accepted visual output.
OpenCL dispatch/readback output proof was validated on this worker.
Vulkan pipeline/command-buffer/frame output proof was validated on this worker.
General WebGPU bind-group, vertex-buffer, engine-cache, or arbitrary app shader HMR was validated on this worker.
One generated `.hip` file proves per-kernel or smallest-safe fission without deterministic verifier evidence.
Flow's generated `.hip` file proves per-kernel or smallest-safe fission.
Any proof succeeded because of a shim or hardcoded scenario path.
```

Current June 23 proof snapshot:

```text
global matrix: gpu-validation-matrix-ledger:sha256:718dbafdfc562518091ba2e4e86d453704c97ede7ac0e84760b8d22f16bf4c14
global matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-20260623T102810Z.json
global matrix summary: 38 rows, 15 full-runtime GPU HMR, 14 refusals, 6 cold splits, 1 deterministic fission, 1 visual profile, 1 preflight-only, 0 included unproven rows
global per-target run modes: accepted for 3 enrolled run-mode targets: generated Flow, generated ray-light, and scoped WebGPU WGSL; SAXPY remains a full-runtime evidence row outside that run-mode-suite target set
HIPRT run modes: accepted for hiprt-camera-rays-horizontal-mirror with cold runtime visual evidence, hot-delta-1, hot-delta-2 different edit, and ABI-changing negative-edit refusal evidence
focused Flow/ray-light matrix: gpu-validation-matrix-ledger:sha256:0ad6ab6154848a2e87672df6f32d389f9d0250638bedf1a81c9d14bc1a52a534
focused matrix path: mcp/synthi-mcp/.gpu-hmr-test-logs/validation-matrix/gpu-hmr-validation-matrix-focused-flow-ray-light-20260622T181300Z.json
focused matrix coverage: ROCm/HIP full runtime accepted, Flow visual path accepted, ray-light visual path accepted, per-target run modes accepted, per-kernel/smallest-safe fission accepted
```

Current live previews:

```text
Ray-light: http://localhost:3000/workspace/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
Flow:      http://localhost:3000/workspace/flow-gpu-hmr-proof-20260622-embedded-ledger-10 -> HTTP 200
Preview frontend: http://127.0.0.1:3000 -> HTTP 200 on 2026-06-23
```

Current visual proof artifacts:

```text
Ray-light dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/ray-light-gpu-hmr-proof-20260622-embedded-ledger-10
Ray-light hot1 ledger: gpu-ledger-proof:sha256:fc798cb97c10df6099ee16d994f8829470596d6408288393da0f751d160a74f2
Ray-light hot2 ledger: gpu-ledger-proof:sha256:a5fc66a3ef1f03824af64d2151ffa970fe57794421f3866bd0127cffdc5b50f2
Ray-light visuals: before-after-diff.png, hot-delta-2-diff.png
Ray-light timings: hot1 total_validator_wall_time=2864084200ns, hot2 total_validator_wall_time=2930783900ns

Flow dir: mcp/synthi-mcp/.gpu-hmr-test-logs/agent-split-artifacts/flow-gpu-hmr-proof-20260622-embedded-ledger-10
Flow hot1 ledger: gpu-ledger-proof:sha256:82171321eac0bc7b8a4bd5177e51766931a4361600f8b14a668290cdf0ad9e98
Flow hot2 ledger: gpu-ledger-proof:sha256:c92876a2dc20d43f3811f4db236844838b8fd47b3668462c4049dbfbc211503c
Flow visuals: before-after-diff.png, hot-delta-2-diff.png
Flow timings: hot1 total_validator_wall_time=2961567300ns, hot2 total_validator_wall_time=2878428200ns

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
```

Current HIPRT/OIDN caveat:

```text
HIPRT CameraRays reruns on 2026-06-23 with SYNTHI_HIPRT_PROBE_GPU_ARCH=gfx1201 are strict-matrix accepted for that scoped ray-traced profile after the matrix recomputes oracle evidence from persisted PNG pixels. The matrix now reports `hiprt_run_modes=accepted` for that CameraRays target: cold runtime visual evidence, hot delta 1, hot delta 2 with a different source edit, and ABI-changing negative-edit refusal are present. This is still not broad HIPRT acceptance beyond the scoped CameraRays profile.
HIPRT MegaKernel direct-light-zero rerun on 2026-06-22 is refused because the post-epoch oracle region is blank.
OIDN live preflight ran against /tmp/synthi-real-rocm/HIPRT-Path-Tracer and is rejected for HIP output proof because libOpenImageDenoise_device_hip.so.2.3.0 depends on missing libamdhip64.so.5.
No compatibility shim, symlink, fake ICD, or project-specific branch was added.
```

Current MIOpen large ROCm ML caveat:

```text
profile: real-rocm-miopen-activation-large-ml
result slug: gpu-real-rocm-MIOpen-20260623094640
result path: mcp/synthi-mcp/.gpu-hmr-test-logs/real-rocm-results.json
repo: ROCm/MIOpen @ 06977176afd94476c18d5290f21cb40745bb73a9
target: MIOpenDriver activ -n 1 -c 1 -H 8 -W 8 -F 1 -V 1 -t 1
native evidence: hipModuleGetFunction resolved MIOpenActiveFwdLite through native_runtime_intercept
driver evidence: Forward Activation Verifies on CPU and GPU
split projection: src/kernels/MIOpenNeuron.cl, 1532 files, 50331605 bytes
delta projection: src/kernels/MIOpenNeuron.cl -> src/kernels/activation_functions.h, 1535 files, 50331470 bytes
timings: configure=9166ms, upstream_build=1778011ms, upstream_run=336ms, initial_compile=30325ms, hot_delta_compile=30314ms, hot_wait=30004ms, total_validator_wall=1996640.2846ms
accepted GPU HMR: false
strict refusal: runtime proof artifact exists but is rejected; full runtime proof remains unproven, proof ledger rejects, and acceptance contract rejects
oracle resolution: profile=none, source_derived_candidates=0, selected_source=null, contract_present=false, runtime_profile_present=false, worker profile cleared with syncSkippedReason=runtime_profile_absent
worker proof boundary: runtime session native-launch-observer:18165; MIOpenActiveFwdLite function resolution observed; no synthi_gpu_launch dispatch, artifact_transport, dispatcher_epoch, output_oracle, or host_identity evidence
native ROCm refusal facet: status=refusal_evidence, can_satisfy_dispatch_proof=false, gaps=native_launch_boundary_observed,native_boundary_not_synthi_dispatch_proof,synthi_dispatch_not_observed,artifact_transport_not_observed,epoch_not_observed,output_oracle_profile_absent,host_identity_not_observed,adapter_impossible_requires_app_hook,native_function_resolution_without_synthi_epoch_dispatch
real ROCm app-hook contract facet: status=required_app_hook_contract_missing, declared=false, required=true, can_satisfy_runtime_proof=false, gaps=app_hook_contract_not_declared,app_hook_artifact_transport_evidence_missing,app_hook_artifact_transport_runtime_not_observed,app_hook_epoch_publication_evidence_missing,app_hook_epoch_publication_runtime_not_observed,app_hook_dispatch_trace_evidence_missing,app_hook_dispatch_trace_runtime_not_observed,app_hook_host_identity_evidence_missing,app_hook_host_identity_runtime_not_observed,app_hook_output_oracle_evidence_missing,app_hook_output_oracle_runtime_not_observed
real ROCm runtime eligibility facet: status=refused_missing_runtime_proof, backend_candidates=hip, source_dialects=opencl_c,c_cpp, artifact_kind=hip_source_bridge, entry_points=MIOpenActiveFwdLite/MIOpenActivationForward/miopenActivationForward, compiler=/opt/rocm/llvm/bin/amdclang, gaps=native_boundary_not_synthi_dispatch_proof,artifact_transport_not_observed,same_process_epoch_missing,dispatch_epoch_missing,output_oracle_profile_absent,host_identity_not_observed,app_hook_contract_not_declared,app_hook_artifact_transport_evidence_missing,app_hook_artifact_transport_runtime_not_observed,app_hook_epoch_publication_evidence_missing,app_hook_epoch_publication_runtime_not_observed,app_hook_dispatch_trace_evidence_missing,app_hook_dispatch_trace_runtime_not_observed,app_hook_host_identity_evidence_missing,app_hook_host_identity_runtime_not_observed,app_hook_output_oracle_evidence_missing,app_hook_output_oracle_runtime_not_observed
target progression: final-acceptance, required=true, target=MIOpenDriver, failed gates=prior small-oracle, prior partial-reload, prior original-host-path, full runtime, visual evidence
target progression ledger: target-progression-ledger:sha256:1fc805c81e15e31831acf9467a6c0b05aa39faa7adcab895bb5d6ab8a374d881, entry_status=fail
visual proof: no MIOpen frame captured; not counted
matrix row: real_rocm_repo_validation, backend=hip, outcome=refusal_proven, proof_chain=real_rocm_strict_runtime_refusal
matrix proof ids: gpu-ledger-proof:sha256:604f3c1cc6dc0e1a05fdf9a4e97dd8080994309987453a44e44d9668526e156e, gpu-runtime-proof:sha256:140b07132f474986736519c50a3333a25f099200fd4e520489adae7ac9aa94fe, real-rocm-validation:sha256:d28fab457e24e11057c3269f29e3f2ae00714c20689a3f8118037a32f9e218e8
matrix row id: gpu-validation-matrix-row:sha256:ae4508f1dc88bbf5dfa4e4868ccb453a6c72a101c739792e5190961911227ef0
matrix open gaps: strict_runtime_proof_artifact_required, proof_ledger_success_required, output_or_visual_oracle_proof_required, real_rocm_app_hook_contract_required, target_progression_gates_failed, native_rocm_launch_boundary:adapter_impossible_requires_app_hook, real_rocm_runtime_eligibility:app_hook_contract_not_declared, real_rocm_app_hook_contract:app_hook_artifact_transport_evidence_missing, real_rocm_app_hook_contract:app_hook_dispatch_trace_runtime_not_observed
plan coverage: large_real_rocm_repo=refused
```

## Current Hardening Status

Latest implementation commits:

```text
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
The MIOpen large-ML profile now requires `targetProgression.phase=final-acceptance`; the latest run fails the missing prior small-oracle, partial-reload, original-host-path, full-runtime, and visual-evidence gates instead of leaving the target undeclared.
Real ROCm validation matrix rows now carry native ROCm launch-boundary and runtime-eligibility facets as queryable refusal gaps, while preserving `can_satisfy_dispatch_proof=false` for native function resolution.
Real ROCm matrix rows now preserve `outputOracleResolution`, `targetProgression`, and `targetProgressionGates`, so the serious-project refusal reason is queryable from the matrix artifact instead of inferred from logs.
Visual matrix evidence now requires decoded PNG images, not header-only files or screenshot existence. Run-mode visual proofs cannot opt out with `visualRequired=false`, and Flow/ray-light coverage only counts accepted visual rows.
Ray-light and Flow now have hot-delta-1 monotonic timing evidence from live MCP timing-matrix runs.
HIPRT CameraRays now emits structured cold/hot run-mode artifacts from the same proof runner instead of relying on the single warm proof artifact alone.
HIPRT CameraRays now emits an ABI-changing negative-edit refusal artifact derived from the real upstream kernel signature, with `gpuHmrSuccess=false` and `abi_layout_changed`.
Vulkan preflight now rejects missing ICD/tool evidence and cannot count as pipeline or frame-output proof.
WebGPU preflight records Chrome launch flags, AMD RDNA4 adapter evidence, and a nonblank diagnostic screenshot, but still cannot count as shader/pipeline/frame HMR proof.
WebGPU runtime visual proof now accepts only the executed explicit-empty-layout WGSL pipeline scope and requires shared ledger success, visual-threshold success, process-continuity evidence, and native WebGPU API evidence.
The timing summary now includes WebGPU runtime visual proofs in the same normalized timing schema as ROCm/HIP, HIPRT, and external profiles.
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
npm --prefix mcp/synthi-mcp run proof:timing-metrics:self-check -> passed
npm --prefix mcp/synthi-mcp run proof:external-project:self-check -> passed
node --check mcp/synthi-mcp/scripts/hiprt-light-math-warm-proof.mjs -> passed
node --check mcp/synthi-mcp/scripts/lib/gpu-hmr-validation-matrix-ledger.mjs -> passed
node --check mcp/synthi-mcp/scripts/tests/gpu-hmr-validation-matrix-ledger-smoke.mjs -> passed
latest validation matrix -> gpu-validation-matrix-ledger:sha256:718dbafdfc562518091ba2e4e86d453704c97ede7ac0e84760b8d22f16bf4c14
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

HIPRT is separate from the MCP browser preview path. The current investor-safe HIPRT claim is scoped: CameraRays same-process ray-traced visual HMR is strict-matrix accepted with embedded proof-ledger/runtime-artifact materials and nonblank oracle-region proof. MegaKernel direct-light-zero is not accepted; it is a proven blank render-region refusal.

```text
worker repo path: /tmp/synthi-real-rocm/HIPRT-Path-Tracer
repo commit: d114ed0d4c1d4ff9ea4e2511841819ed9aa59e6e
scene: data/GLTFs/cornell_pbr.gltf
hdr: data/Skyspheres/evening_road_01_puresky_2k.hdr
```

CameraRays:

```text
profile: hiprt-camera-rays-horizontal-mirror
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

Structured WebGPU runtime visual HMR proof:

```text
proof id: webgpu-runtime-visual-proof:sha256:e45b1d839607d694a744226228c0341dd6959eb336058bf733152a77f972e81d
result state: webgpu-hmr-full-runtime-proven
ledger proof id: gpu-ledger-proof:sha256:56994c1b29cef52e7b86ba4d3936031a3486123bb62da99ab1e554d779011a2e
proof json: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-proof.json
summary: mcp/synthi-mcp/.gpu-hmr-test-artifacts/webgpu-runtime-visual-proof/webgpu-runtime-visual-20260609-webgpu-wgsl-runtime-triangle-summary.txt
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

Do not generalize this to arbitrary WebGPU projects. The runner rejects profiles with non-empty bind-group layouts, vertex buffers, fixed color formats outside the preferred canvas format, or non-opaque alpha mode unless a future proof runner executes and traces those fields.

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
- Focused Flow/ray-light per-target run-mode coverage is complete: cold split, hot delta 1, hot delta 2 with a different edit, and negative-edit refusal all pass. The global matrix now reports `per_target_run_modes=accepted` for enrolled generated run-mode targets plus scoped WebGPU. Scoped HIPRT CameraRays now reports `hiprt_run_modes=accepted` with cold, hot delta 1, hot delta 2 with a different edit, full-runtime visual proof rows, and an ABI-changing negative-edit refusal. Scoped WebGPU now emits accepted cold/hot1/hot2 runtime run-mode artifacts with embedded strict runtime proof artifacts and binding-layout negative-edit refusals.
- MIOpen large ROCm ML infrastructure now builds and runs under the proof harness, but full-runtime Synthi GPU HMR remains refused until the full ledger chain, same-process runtime proof artifact, generic app-hook contract/runtime observations, epoch/dispatch proof, target-progression ledger, and output or visual oracle proof are produced. The latest profile has no output oracle and now requires final-acceptance target progression; the result fails those gates explicitly.
- CUDA needs a CUDA machine.
- OIDN HIP needs a ROCm-compatible OIDN HIP build; no ABI shortcut should be used.
- OpenCL needs a real vendor ICD plus dispatch/event/readback ledger proof; no synthesized ICD or shim should be used.
- Vulkan needs a real ICD plus pipeline-layout, command-buffer, frame-boundary, and visual oracle ledger proof; no synthesized ICD or shim should be used.
- WebGPU beyond the accepted explicit-empty-layout WGSL profile needs executed bind-group, vertex-buffer, engine-cache, pipeline-layout, frame trace, and output-oracle ledger proof; browser flags must remain evidence-only.
- Per-kernel/smallest-safe fission is proven only for the ray-light generated `trace_light_rays` island; additional projects/backends need their own deterministic verifier evidence.
- In-app browser visual proof was unavailable because the browser connector bootstrap failed with sandbox metadata; persisted WebGPU, ray-light, and Flow before/after/diff PNGs were inspected with the local visual tool instead, and the matrix now decodes PNGs before accepting them.
