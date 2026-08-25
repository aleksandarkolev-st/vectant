---
tags: [vectant-ade, gpu-hmr, hmr, rocm, hip, gfx1201, proof-ledger, fission]
source-repo: C:\Users\polek\Desktop\hermes-abuse\vectant-ade
analyzed: 2026-08-25
status: flagship feature — live and proven on AMD RX 9070 XT
---

# GPU HMR — System Analysis

GPU HMR is vectant-ade's (Synthi's) flagship capability: **hot module replacement for GPU device code**. An edit to a CUDA/HIP kernel is recompiled into a new device sidecar (`cubin`/`hsaco`), loaded into the *same running process*, swapped in without restarting the app or losing host state or registered GPU buffers, and then **proven correct with a structured, immutable evidence ledger** — never with logs, screenshots, or AI assertions alone.

The system is deliberately "hostile to fake success": every reload climbs a formal proof ladder, and anything less than the top rung is reported as an explicit degraded state.

---

## 1. What Triggers A Reload

Two entry paths feed the same worker pipeline:

1. **Human edit**: Monaco editor save in the browser → `compile-request` over a WebRTC data channel (`synthi/src/services/compilerClient.js`) → Rust worker (`backend/synthi-webrtc-compiler/worker/src/compiler/handler.rs`).
2. **Agent edit**: an agent drives MCP tools — `synthi_compile`, `synthi_wait_hmr`, `synthi_screenshot` — against the same public surface (`mcp/synthi-mcp/src/*`). The MCP path matters by design: *"A passing compiler log alone is not enough"*; validation must exercise exactly what an agent/user exercises.

Compile-request fields that matter for GPU routing:

```json
{ "language": "cpp", "use_ai_split": true, "prefer_gpu_pipeline": true,
  "gpu_mode": "auto | cuda | rocm | disabled", "compile_manifest": null }
```

For an already-adapted workspace, the frontend discovers `.synthi/build_manifest.json` and sends every manifest-declared file (dynamic filenames are supported; the manifest's `module_files` mapping is source of truth — default names like `device.hip` are only fallbacks).

Routing rules:
- Worker detects CUDA/HIP markers + `prefer_gpu_pipeline=true` + `gpu_mode != disabled` → calls AI engine `POST /refactor/split/gpu`.
- If the GPU split endpoint fails for a GPU-preferred compile, the worker **fails hard instead of silently falling back** to the CPU splitter (a CPU-split workspace cannot HMR its device sidecar).
- Device-only edits after the first split skip AI entirely: worker classifies the edit as a split-file edit (`[HMR] FallbackDeterministic -> split file edit (device.hip)`), compiles just the device role, and hands it to the GPU reload planner.

## 2. The Deterministic Split

First compile of ordinary monolithic user source (no Synthi ABI required from the user) produces five semantic roles plus a build manifest:

| Role | Default filename | Contains |
|---|---|---|
| `shared` | `shared.h` | shared types/state |
| `core` | `core.cpp` | host loop + GPU lifecycle exports |
| `gui` | `gui.cpp` | rendering |
| `runner` | `host_runner.cpp` | standalone host runner (compiled for feedback; not used to run) |
| `device` | `device.hip` / `device.cu` | kernels |

Generated manifest (source of truth for all later compiles):

```json
{
  "files": ["shared.h", "core.cpp", "gui.cpp", "host_runner.cpp", "device.hip"],
  "module_files": { "shared": "shared.h", "core": "core.cpp", "gui": "gui.cpp",
                    "runner": "host_runner.cpp", "device": "device.hip" },
  "gpu": { "vendor": "rocm", "device_source": "device.hip", "arch": "gfx1201" }
}
```

The generated host ABI lives in generated code, never in user code:

```cpp
// core.cpp (generated)
extern "C" const DeviceDescriptor* device_descriptor();
extern "C" int device_on_load(void* state_ptr, const SynthiGpuRuntime* gpu);
extern "C" size_t device_save_size(void* state_ptr);
extern "C" int device_save_write(void* state_ptr, void* dst, size_t cap);
extern "C" unsigned long long device_kernel_sig_hash();
```

A mechanical verifier (`ai-backend/ai-engine/verifier_gpu.py`) gates every AI attempt before it reaches the worker — checking missing lifecycle exports, exports placed in the wrong file, heap-allocated `AppState` (`heap_allocated_app_state`), invented renderer recovery (`gui_uses_global_window_id_lookup`), wrong vendor extension, bad launch argument shapes. Rejected attempts get verifier feedback and retry live: `attempt 1 rejected … attempt 2 rejected … attempt 3 accepted`. The prompt contract requires preserving the user's original render backend, every kernel branch/guard/reset path/constant, and forbids SDL2 invention and hand-redeclared runtime headers. The model itself is pluggable via env (`SYNTHI_SPLIT_PROVIDER/MODEL`; ledger currently pins `gemini-3.5-flash` for splits, `gemini-3.1-flash-lite` for deltas), but **AI never certifies anything** — deterministic verifiers decide.

## 3. Sidecar Compute Runner

The compiled GPU artifact ("sidecar") is `hsaco` for ROCm/HIP or `cubin` for CUDA, built per target:

- ROCm/HIP: `hipcc -targ=gfx1201` inside the worker image (`worker/Dockerfile.gpu`, ROCm 7.x); markers `[compile-device] hipcc`, `Device sidecar reload vendor=rocm ... result=Success`.
- CUDA: `nvcc` (compiles on this stack, but runtime execution was never claimed on the AMD host).
- AMD WSL device exposure: `/dev/dxg` + ROCdxg/libdxcore via `docker-compose.gpu-amd.yml`; NVIDIA uses `gpus:all`.

Rust side (`backend/synthi-webrtc-compiler/worker/src/hmr/`):

- `gpu_module_manager.rs` — dual-slot manager modeled on the dynlib primary/standby slots. `load_standby(blob)` goes through `cuModuleLoadData` via a driver symbol table (`gpu_driver_loader.rs`), `resolve_kernels` runs `cuModuleGetFunction` into a kernel table keyed by mangled symbol, `swap()` promotes standby→primary and returns the retired handle for post-drain unload. Defensive: any non-zero driver result parks the error and refuses to swap until cleared.
- `gpu_module_adapter.rs` — the reload transaction: read artifact, drain context on non-first loads, load standby, resolve function handles, swap/merge kernel table, unload retired, install new launch dispatcher.
- `gpu_device_fast_path.rs` + `gpu_fission.rs` — deterministic edit classification, partial-artifact selection ("fission islands"), symbol ownership validation, verifier reports/rejection reasons.
- `gpu_prod_contracts.rs`, `gpu_proof.rs`, `gpu_stream_drain.rs`, `gpu_dirty_bit.rs`, `gpu_reload_orchestrator.rs`, `gpu_shadow_arena.rs` — proof contracts, proof states, stream draining/ordering, dirty tracking, orchestration, shadow execution arena.

The stable launch boundary (`runtime/gpu_runtime_boundary.rs`) exposes `synthi_gpu_launch` with generation counters, records launch attempts, routes through an installed dispatcher, captures stream tokens/dimensions, and rejects stale launch pointers — this is what makes "the changed kernel actually ran in this session" observable rather than assumed.

## 4. Hold-Alive Runner

What distinguishes GPU HMR from "rebuild and restart" is that the runner **stays alive**:

- Device-only edit → planner compares old/new ABI fingerprints (`device_kernel_sig_hash`, descriptor, layout hashes). Compatible → `[gpu-reload] plan=device_only`; the runner hot-loads the new hsaco/cubin while **AppState and registered GPU buffers survive untouched**. Validation asserts `runner stayed alive: true`.
- ABI-breaking signature change → `[gpu-reload] plan=abi_breaking` → colder reload path (explicitly reported as degraded, never disguised).
- Host-only edits in a GPU project route through ordinary CPU HMR and must report `gpu_hmr_success=false` / `gpu_runtime_unchanged=true` — a hard firewall between CPU-HMR success and any GPU claim.

The classic native-HMR machinery underneath (documented in `docs/AI_HMR_SYSTEM_REFERENCE.md`) explains why process survival is safe at all: DWARF-derived layout hashes gate memcpy state preservation (no hash ⇒ memcpy forbidden), MsgPack snapshot/migration strategies (memcpy ~1ms / deserialize ~10ms / migrate ~50ms / cold ~500ms), length-prefixed binary IPC, hard timeouts everywhere (snapshot 5s, reload 10s, quiescence 30s → SIGKILL + restart with state restore), watchdogs and rollback-by-default. Measured targets there: hot reload ≈50ms, migration ≈200ms, crash recovery ≈2s.

Target architecture (partially implemented): replace synchronize-everything-then-swap with **epoch-grafted artifact capsules** — publish dispatch entries atomically to generation N+1 while generation N stays live for in-flight streams, retire old code only after per-stream epoch fences pass. This separates three facts (publication / old-generation lifetime / retirement) so proofs are stronger than "we synchronized everything." Related degraded states exist now: `epoch-retirement-pending`, `epoch-swap-unverified`, `ram-io-unavailable` (RAM artifact transport vs filesystem-fallback is loader-capability-driven).

## 5. In-Process Hot Swap On RX 9070 XT (gfx1201)

Accepted local platform: **AMD Radeon RX 9070 XT, ROCm/HIP, arch `gfx1201`**. CUDA is out of scope on this machine (never claimed).

Three tiers of in-process proof, all real:

1. **MCP preview visual HMR** (Synthi-generated workloads): ray-light and Flow fixtures. Agent-driven flow: monolithic source → AI split → hipcc sidecar → device-only edit of `.synthi/generated/gpu/device.hip` → `plan=device_only` hot load → before/after screenshots + diff. Observed visual deltas e.g. ray-light `changed=5.89% mean_abs=9.92 control_changed=0.00% selected_delta_ms≈1100`; Flow particle ring → gridded wave `changed=2.59%`. Runner alive throughout.
2. **HIPRT same-process ray tracing** (real HIPRT-Path-Tracer checkout, Cornell-box scene): the *original renderer process* observes the edited source, recompiles the kernel in-process, and relaunches it. CameraRays profile: live in-process recompile **41–46ms**, edit-to-first-visual ≈1.9–2.7s, changed pixels 91.4%. MegaKernel direct-light: recompile **75–82ms** (99ms in the earlier accepted run), edit-to-first-visual ≈2.4s, changed pixels 41.8%, amplified diff artifacts stored. Proof IDs pinned as content hashes, e.g. `hiprt-warm-runtime-proof:sha256:aa108131…`.
3. **Strict full-runtime ledger acceptance** (strongest): real `ROCm/rocm-examples` HIP-Basic/saxpy reached `gpu-hmr-full-runtime-proven` with a source-derived output oracle — expected and actual GPU readback checksums matching (`oracle:real-rocm:saxpy-readback-y:e92cf383c60e2a0d`), all layers passed (ABI, fission, RAM transport, epoch graph, dispatch safety, host preservation, original-host-path attachment, output oracle). Timings recorded: total validator wall 235.3s of which AI contract synthesis 73.9s, device compile wall 30.4s, runtime probe 237ms, trigger-to-visible 30s.

Honest scope boundaries (enforced, not aspirational): no zero-copy HIP↔graphics interop, no `/dev/fb*`/DRI display, no CUDA runtime proof, and structured preflight refusals where dependencies genuinely don't exist (OIDN-HIP missing `libamdhip64.so.5`; OpenCL/Vulkan loaders present but no vendor ICDs — `opencl-runtime-rejected`, `vulkan-runtime-rejected`, no shims or synthesized ICDs ever added). Scoped WebGPU WGSL runtime-visual proof exists on Chrome/RDNA4 for an explicit-empty-layout pipeline; broader WebGPU/Bevy remain refused with evidence-backed rejection artifacts.

## 6. Proof Ledger

The ledger is the system's epistemology. Sources: plan §10 of `GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`, implementation in `mcp/synthi-mcp/src/gpu_proof_ledger.ts` (schema `synthi.gpu.hmr.proof_ledger.v1`) and `src/gpu_proof.ts`.

**Proof ladder** (higher implies all lower passed):

```
gpu-hmr-compile-proven          # artifact built for vendor/arch, command+dep hashes recorded
 → gpu-hmr-symbol-bound         # exports match expectation; unknown symbols rejected
 → gpu-hmr-abi-proven           # params/layouts/constant memory/bindings verified w/ named extractors
 → gpu-hmr-epoch-swap-proven    # generation-published capsule; lineage + retirement fences recorded
 → gpu-hmr-dispatch-observed    # THIS session launched the new kernel (session-scoped)
 → gpu-hmr-dispatch-safe-proven # + ABI/provenance/stream-ordering/replacement-scope proofs
 → gpu-hmr-output-oracle-proven # deterministic oracle observed output AFTER epoch-N dispatch
 → gpu-hmr-host-preservation-proven  # host/core/gui/renderer identities unchanged
 → gpu-hmr-full-runtime-proven  # only this may be called "full runtime correctness"
```

**Degraded/failure states** each carry a rank cap that blocks higher claims — `fake-launch-path` (capped at symbol-bound), `unknown-arg-provenance`, `abi-unverified`, `dispatch-unobserved`, `output-unobserved`, `host-replaced`, `epoch-retirement-pending`, `ram-io-unavailable`, `visual-only`, plus implementation additions `visual-evidence-missing`, `original-host-path-unattached`, `fission-unverified` (cap 0). A screenshot can never satisfy an oracle; `visual-only` explicitly caps below output-oracle rank.

**Ledger invariants** (queried by `queryGpuHmrLedgerInvariants()`; violation ⇒ `gpu_hmr_success=false`):

```
loader_event.artifact_hash        == artifact_after_hash
epoch_publish_event.artifact_hash == artifact_after_hash
dispatch_event.epoch              == epoch_publish_event.epoch
output_event.after_dispatch_id    == dispatch_event.id
cpu_hmr_used == false ∧ full_rebuild_used == false ∧ process_restarted == false
```

Every record also embeds mandatory **model provenance** (provider status, alias resolution, shutdown detection, availability basis, actual vs requested model, fallback usage, hard-infra-failure flag) and a normalized **timing schema** (monotonic_ns; scope cold/warm/hot_delta_1/hot_delta_2; cache state clean/compiler_cache_warm/pipeline_cache_warm; 15 required timing fields from static discovery through total validator wall time). GPU event time is never allowed to masquerade as total HMR time. Immutable proof IDs are content-hash-shaped (`gpu-proof:<64hex>`, `gpu-runtime-proof:sha256:…`, `gpu-ledger-proof:sha256:…`) and validated by pattern in `gpu_proof.ts`.

Supporting machinery: canonical JSON hashing policies (`gpu_hmr/canonical.py`), typed identity contracts (`SelectedTargetIdentity`, `SourceSplitIdentity`, `CompileCandidateIdentity`, `RuntimeVerificationIdentity`, `PromotionIdentity`, `VerifierReport`… in `gpu_hmr/contracts.py`), a registry-backed reason-code system (`reason_codes.py` + `reason_codes.json`, unknown codes raise), and the FastAPI candidate broker (`gpu_hmr/broker.py` — projections → candidates → verify → promote with idempotency keys, trace events, and readiness blockers such as `projection.identity_mismatch` / `candidate.stale_codeintel_generation`). The adversarial self-check suite mints forged successes (WebGPU flag without ledger/images, placeholder oracle ids, invented modes) and verifies they stay unproven.

## 7. Deterministic Fission & Partial Reload

Body-only edits avoid both restarts and AI: a local deterministic verifier proves the diff touches only executable statements inside known function/kernel bodies (path identity + symbol identity + span containment; signatures/layout/directives/include-root unchanged), then the strict selector picks the narrowest viable partial artifact ("fission island"). Explicit reject classes cover the "looks body-only but isn't" traps: macro/template changes, `__constant__`/device globals, type aliases, anonymous namespaces, overload-set changes, include edits, etc. Full-device fallback must be labeled `gpu-hmr-degraded-full-device`; results self-label as `gpu-hmr-partial` / `gpu-hmr-degraded-full-device` / `gpu-hmr-rejected` with telemetry (`fallbackUsed`, selection/rejection reasons, dependency/command hashes).

Real-world scale evidence: HIPRT-Path-Tracer `Megakernel.h` body-only edit → deterministic fast path accepted, artifact kind `source_include_bridge`, symbol `MegaKernel`, exported = touched, `fallbackUsed=false`.

Granularity honesty is enforced: one generated `.hip` file does **not** prove per-kernel fission. Ray-light earns `per_kernel_hmr` claims because its device role contains exactly one kernel (`trace_light_rays`) and eight evidence categories bind (source_mapping, include_closure, symbol_ownership, dependency_closure, abi_membrane, compile_recipe, loader_capability, output_oracle) with a content-addressed topology binding. Flow is refused (`symbol_ownership`: role contains `particle_init` + `particle_flow`) and may only claim `device_translation_unit_hmr`. Narrower-than-topology candidates reject with `fission.claim_narrower_than_generated_topology`.

## 8. Validation Breadth

Machine-readable matrix ledger (`synthi.gpu.hmr.validation_matrix_ledger.v1`, latest hash `71b37307a049…`): **15 current rows** — 6 full-runtime GPU HMR rows (flow, ray-light, saxpy_kernel+saxpy_init_kernel, hiprt-camera-rays-horizontal-mirror, hiprt-megakernel-direct-light-zero, webgpu-wgsl-runtime-triangle), 1 deterministic fission row (trace_light_rays), 1 external visual-profile row (threejs-webgl-shader-lava), **6 structured refusal rows** (bevy-wgsl-shader-material, two OIDN preflights, two OpenCL preflights, Vulkan preflight), 1 WebGPU preflight-only row — plus **574 omitted stale/unproven historical attempts** retained by default. That archive of 500+ historical scenario attempts is the honest basis for "500+ scenarios"; the curated accepted set remains deliberately small and every negative case is first-class evidence.

Test suites backing it: 66 Rust `gpu_fission` tests, 36 `gpu_prod_contracts` tests (in-container cargo), 279 vitest cases (`gpu_hmr_runtime_proof.test.ts`), and ~15 `proof:*` self-check npm targets (strict-gates, adversarial-ledger, acceptance-contract, runtime-profile, webgpu/vulkan/opencl/oidn preflights, timing-metrics, validation-matrix, visual-evidence, generated-split-granularity). Adversarial-first doctrine: *"the first validation milestone is not 'SAXPY passed'; it is 'the system refuses fake GPU HMR'"* — Phase 1 negative targets (kernel arg added/reordered, blank frame, same-frame recapture, camera-jitter fake diffs, stale-buffer readback, silent process restart, full rebuild disguised as partial, async presentation capturing pre-epoch frames) run before positive expansion.

## 9. Wall-Time Recording: Agent Edits Vs Human Edits

There is no separate "human clock" vs "agent clock" subsystem; both ride the identical pipeline and the difference shows up as **which harness supplies the trigger and which metric scope/timings get attached to the proof record**:

- Every proof record carries the unified timing schema (§6): monotonic_ns, metric_scope ∈ {cold, warm, hot_delta_1, hot_delta_2}, cache_state, and 15 fields including `device_compile_wall_time`, `trigger_to_visible_time`, `dispatch_to_output_proof_time`, `total_validator_wall_time`.
- **Agent-edit timings** come from the MCP runners: `gpu-hmr-agent-split-workspace-test.mjs` "emits measured monotonic timing summaries for generated device edits," aggregated by `gpu-hmr-timing-metrics-summary.mjs` into `synthi.gpu.hmr.timing_metrics.v1`. Recorded examples (hot_delta_1, compiler_cache_warm):
  - ray-light: device_compile_wall_time **17.0ms**, runtime_probe 11.28s, total validator wall 11.30s, selected_delta_ms ≈1098–3734;
  - Flow: device compile wall **24.5ms**, runtime probe 3.13s, total wall 3.15s, selected_delta_ms ≈2098–2755;
  - WebGPU scoped triangle: total wall 951.6ms, trigger-to-visible **67.8ms**;
  - ThreeJS external lava: edit-to-screenshot 2.8–4.4s, total 9.3–14.0s;
  - HIPRT CameraRays same-process: live recompile **41ms**, edit-to-first-visual 1894ms; MegaKernel 75–82ms recompile, 2370–2389ms to first visual.
- **Human-edit timings** flow through the same worker when editing in the IDE preview (keystroke → WebRTC compile request → same planner/adapters/status events), and the classic AI-HMR reference documents the underlying latency budget (hot ≈50ms same-layout, ≈200ms with migration, cold ≈1s, crash recovery ≈2s). The remaining gap: cold split, hot_delta_2-with-different-edit, and negative-edit run modes are still open across accepted targets (`per_target_run_modes` row intentionally missing) — the docs do not yet claim a complete human-vs-agent wall-time comparison table, and this analysis does not invent one.

## 10. Investor Demo Surface

`docs/GPU_HMR_INVESTOR_DEMO_STATUS.md` + committed demo assets in `docs/gpu-hmr-investor-demo/ray-bounce-20260608/` (before/after PNGs, amplified diff, frame metadata with session id `investor-ray-bounce-gpu-hmr-20260608`, 800×600 frames, seq/broker metadata). Safe claim wording:

> "On the local AMD ROCm machine, Synthi can hot-reload a GPU device-artifact edit, keep the runtime alive, and prove the changed output with strict runtime-ledger evidence plus pixel-backed before/after/diff visual artifacts."

Best surfaces ranked: ① ray-light MCP preview, ② Flow preview, ③ HIPRT same-process CameraRays/MegaKernel, ④ ThreeJS WebGL external profile (explicitly not full ledger acceptance), ⑤ scoped WebGPU WGSL runtime proof, ⑥ strict ROCm/HIP compute ledger (readback-oracle card showing generation 3, PASSED, matching expected/actual hashes), ⑦ deterministic fission verifier row.

## 11. Hard Invariants (Non-Negotiable)

1. **No hardcoding** — project/renderer/symbol/model/fixture names may appear only as corpus metadata and diagnostics; they never select eligibility, routing, obligations, or success. Unknown mechanisms route to generic discovery + synthesis + verification, never rejection-by-label.
2. **Proof is not logs** — the structured proof artifact/ledger is the sole authority; logs, screenshots, terminal labels, and AI text are evidence inputs referenced by ID.
3. **Fail-closed** — missing evidence yields precise degraded states; no silent fallback (CPU splitter, full-device, filesystem-vs-RAM, retirement strategy), hidden restart, shim, synthesized ICD, or symlink shortcut. Two later real-ROCm reruns that lost their runtime session / blew the budget are recorded as *rejected*, not quietly dropped.
4. **AI proposes, verifiers dispose** — authority order: runtime traces > compiler/code-object metadata > build metadata > AST analysis > naming conventions > AI hints (never authoritative; unverified AI fields live in `ai_hints`).
5. **CPU/GPU firewall** — GPU HMR success is impossible when CPU HMR handled the edit.
6. **One logical change = one commit**, targeted staging, hardcoding scan on every diff.

## 12. Honest Remaining Work

Per the implementation-status doc: rerun stability for real-ROCm (recent failures correctly rejected); HIPRT integration into the full MCP ledger path (currently same-process adapter mode; normal sidecar acknowledgement timed out once in `real_repo_user_source_delta_hmr`); OIDN needs a ROCm-7-matching HIP build; OpenCL/Vulkan need real vendor ICDs before any dispatch/pipeline/frame proof; WebGPU needs bind-group/vertex-buffer/engine-cache evidence beyond the empty-layout triangle; Bevy needs backend-specific full-runtime proof; CUDA needs actual CUDA hardware; epoch-capsule retirement supersedes the stall-heavy drain-before-swap; multi-TU device sidecars and arbitrary host-role counts unsupported; per-target run-mode coverage (cold/hot-delta-2/negative) incomplete.

## 13. Key File Map

| Layer | Paths |
|---|---|
| Plans & status | `docs/GPU_HMR_UNIVERSAL_ACCEPTANCE_PROOF_PLAN.md`, `GPU_HMR_FULL_RUNTIME_CORRECTNESS_PLAN.md`, `GPU_HMR_DETERMINISTIC_PARTIAL_RELOAD_PLAN.md`, `GPU_HMR_IN_DEPTH_FLOW.md`, `GPU_HMR_UNIVERSAL_ACCEPTANCE_IMPLEMENTATION_STATUS.md`, `GPU_HMR_INVESTOR_DEMO_STATUS.md`, `GPU_HMR_PROD_NEXT.md`, `GPU_HMR_ULTRAPLAN.md`, `HMR_END_TO_END.md`, `AI_HMR_SYSTEM_REFERENCE.md`, `GPU_HMR_FULLY_WORKS.txt` |
| Worker (Rust) | `backend/synthi-webrtc-compiler/worker/src/hmr/{gpu_module_manager,gpu_module_adapter,gpu_device_fast_path,gpu_fission,gpu_prod_contracts,gpu_proof,gpu_driver_loader,gpu_stream_drain,gpu_dirty_bit,gpu_reload_orchestrator,gpu_shadow_arena}.rs`, `compiler/handler.rs`, `compiler/stages/{ai_utils,compile_device}.rs`, `runtime/gpu_runtime_boundary.rs`, `Dockerfile.gpu` |
| AI engine (Python) | `ai-backend/ai-engine/gpu_hmr/{api,broker,canonical,contracts,metadata,projection,reason_codes}.py`, `verifier_gpu.py`, `llm/prompts.py`, `agents/kernel_splitter.py`, `agents/gpu_mod_delta.py`, `build_manifest.py` |
| MCP / proof (TS) | `mcp/synthi-mcp/src/{hmr,gpu_proof,gpu_proof_ledger}.ts`, `scripts/gpu-hmr-{agent-split-workspace-test,real-rocm-repo-validation,runtime-profile-proof,webgpu-runtime-visual-proof,timing-metrics-summary,validation-matrix-ledger,…}.mjs`, `package.json` `proof:*` targets |
| Frontend | `synthi/src/services/compilerClient.js`, `synthi/src/hooks/useHMR.js`, `synthi/src/app/workspace/[slug]/page.jsx` |
| Evidence | `mcp/synthi-mcp/.gpu-hmr-test-{artifacts,logs}/` (proof JSONs, before/after/diff PNGs, timing summaries, validation matrix), `docs/gpu-hmr-investor-demo/ray-bounce-20260608/` |

---

### One-paragraph summary

An edit (human save or agent `synthi_compile`) reaches a per-session Rust worker; if GPU markers + preference say "GPU," the first compile routes through an AI split (`/refactor/split/gpu`) whose output a mechanical verifier rejects/retries until it emits the shared/core/gui/host_runner/device roles plus a build manifest; thereafter, a device-file edit skips AI, compiles only a new hsaco/cubin sidecar (hipcc for gfx1201 on the RX 9070 XT), and the GPU reload planner compares ABI fingerprints to choose `device_only` hot-load (keeping AppState, buffers, and the runner process alive) versus an explicit `abi_breaking` colder path. Nothing counts as success until a content-addressed proof record shows the ladder — compile → symbol-bound → ABI → epoch-swap → dispatch-observed → dispatch-safe → output-oracle → host-preservation — with ledger invariants intact (same process, no CPU fallback, no rebuild, output observed after the published epoch), which is how the system can honestly demonstrate sub-second-scale in-process kernel swaps on a live path tracer while refusing, with evidence, the backends it cannot yet prove.
